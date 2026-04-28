import React, {useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C, TC} from '../lib/constants.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {flashEcm, FLASH_PHASES} from '../lib/flasherStateMachine.js';
import {ALGOS} from '../lib/algos.js';
import {cfGPEC, cfWCM, cfAlpineRAK} from '../lib/canflashAlgos.js';
import {decodeChargerVin} from '../lib/vin.js';
import {MasterVinContext} from '../lib/masterVinContext.jsx';

// ECM bench flasher tab (Task #488). Connects to the local Autel bridge
// daemon, walks the GPEC2A UDS programming session via flashEcm(), and
// streams progress / log / phase / metrics to the operator. Refuses to
// run when the engine is not the bench bridge.

// Module presets — destination CAN tx/rx pairs for FCA modules. Mirrors
// the table in UdsTab.jsx so the operator can pick a target without
// hand-typing addresses. Default `ECM` matches the Stellantis 0x7E0/0x7E8.
const MODULE_PRESETS = [
  {id:'ECM',   tx:0x7E0, rx:0x7E8, hint:'Engine Control / GPEC2A'},
  {id:'TCM',   tx:0x7E1, rx:0x7E9, hint:'Transmission'},
  {id:'BCM',   tx:0x750, rx:0x758, hint:'Body Control'},
  {id:'RFHUB', tx:0x75F, rx:0x767, hint:'RF Hub'},
  {id:'ABS',   tx:0x760, rx:0x768, hint:'ABS'},
  {id:'IPC',   tx:0x740, rx:0x748, hint:'Cluster'},
  {id:'ORC',   tx:0x758, rx:0x760, hint:'Occupant Restraint'},
  {id:'ADCM',  tx:0x7A8, rx:0x7B0, hint:'Adaptive Damping'},
  {id:'RADIO', tx:0x772, rx:0x77A, hint:'Radio / Uconnect'},
  {id:'HVAC',  tx:0x751, rx:0x759, hint:'Climate'},
  {id:'EPS',   tx:0x761, rx:0x769, hint:'Power Steering'},
  {id:'SCCM',  tx:0x74D, rx:0x76D, hint:'Steering Column'},
  {id:'TIPM',  tx:0x74C, rx:0x76C, hint:'Power Distribution'},
  {id:'AMP',   tx:0x7A0, rx:0x7A8, hint:'Audio Amplifier'},
  {id:'BSM',   tx:0x770, rx:0x778, hint:'Blind Spot'},
  {id:'TPMS',  tx:0x752, rx:0x75A, hint:'Tire Pressure'},
];

// Combined algorithm picker. Defaults to canflash GPEC TEA (32-bit) per
// Task #488 spec for the modern Stellantis PCM bench flow. Falls back
// to the existing ALGOS registry for everything else.
const FLASHER_ALGOS = [
  {id:'cf_pcm_gpec',   n:'GPEC TEA (canflash)', h:'PCM modern Stellantis (Scat Pack/Hellcat SRT) — default', fn: cfGPEC},
  {id:'cf_wcm',        n:'WCM (canflash)',      h:'Wireless Control Module',                                  fn: cfWCM},
  {id:'cf_alpine_rak', n:'Alpine RAK (canflash)', h:'Alpine RAK / Radio',                                     fn: cfAlpineRAK},
  ...ALGOS.filter(a => typeof a.fn === 'function' && !a.custom).map(a => ({
    id: a.id, n: a.n, h: a.h, fn: a.fn,
  })),
];

const PHASE_LABELS = {
  [FLASH_PHASES.CONNECT]: 'Connecting',
  [FLASH_PHASES.SESSION_EXT]: 'Extended session',
  [FLASH_PHASES.SESSION]: 'Programming session',
  [FLASH_PHASES.SEED]: 'Requesting seed',
  [FLASH_PHASES.KEY]: 'Sending key',
  [FLASH_PHASES.ERASE]: 'Erasing flash',
  [FLASH_PHASES.REQUEST_DOWNLOAD]: 'Request download',
  [FLASH_PHASES.TRANSFER]: 'Transferring blocks',
  [FLASH_PHASES.TRANSFER_EXIT]: 'Closing transfer',
  [FLASH_PHASES.CHECKSUM]: 'Running checksum',
  [FLASH_PHASES.RESET]: 'Resetting ECU',
  [FLASH_PHASES.DONE]: 'Done',
  [FLASH_PHASES.ABORTED]: 'Aborted',
  [FLASH_PHASES.FAILED]: 'Failed',
};

function Section({title, color, children}){
  const c = color || C.sr;
  return (
    <div style={{marginBottom: 22}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10}}>
        <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 3, color: c, fontWeight: 800}}>{title}</span>
        <span style={{flex: 1, height: 1, background: `linear-gradient(to right, ${c}55, transparent)`}}/>
      </div>
      {children}
    </div>
  );
}

function ProgressBar({pct, color}){
  const v = Math.max(0, Math.min(1, pct || 0));
  return (
    <div style={{position: 'relative', height: 12, borderRadius: 6, background: C.c2, border: `1px solid ${C.bd}`, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, width: (v * 100).toFixed(2) + '%', background: color || C.sr, transition: 'width 0.15s'}}/>
    </div>
  );
}

function LogLine({entry}){
  const colorMap = {tx: C.a3, rx: C.gn, info: C.tx, warn: C.wn, error: C.er};
  const c = colorMap[entry.level] || C.tx;
  return <div style={{fontFamily: 'JetBrains Mono', fontSize: 10, color: c, padding: '2px 0'}}>{entry.msg}</div>;
}

function fmtMB(n){ return (n / 1024 / 1024).toFixed(2) + ' MB'; }
function fmtMs(ms){
  if (ms == null) return '—';
  if (ms < 1000) return ms + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  const m = Math.floor(s / 60);
  const r = (s - m*60).toFixed(0);
  return m + 'm ' + r + 's';
}

export default function EcmFlasherTab({selectedFile, files = [], onSelectFile}){
  const masterCtx = useContext(MasterVinContext);
  const masterVin = (masterCtx && masterCtx.vin) || '';

  const [conn, setConn] = useState(false);
  const [bridge, setBridge] = useState({vendor: null, firmware: null});
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState(null);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Picker state.
  const [moduleId, setModuleId] = useState('ECM');
  const [algoId, setAlgoId] = useState('cf_pcm_gpec');
  const [seedSubfn, setSeedSubfn] = useState('09');
  const [keySubfn, setKeySubfn] = useState('0A');

  // Numeric params.
  const [chunkSize, setChunkSize] = useState(0x80);
  const [eraseRid, setEraseRid] = useState('FF00');
  const [checkRid, setCheckRid] = useState('FF01');
  const [addressHex, setAddressHex] = useState('00000000');
  const [resumeFromChunk, setResumeFromChunk] = useState(0);
  const [keepAlive, setKeepAlive] = useState(true);

  // Live transfer metrics.
  const [bytesSent, setBytesSent] = useState(0);
  const [chunksSent, setChunksSent] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [throughputKBs, setThroughputKBs] = useState(0);

  const engineRef = useRef(null);
  const abortRef = useRef(null);
  const logBoxRef = useRef(null);
  const startTickRef = useRef(0);

  const candidates = useMemo(
    () => files.filter(f => f && (f.type === 'CFLASH' || f.type === 'FW' || f.type === 'EFD-PAYLOAD')),
    [files],
  );

  const selectedModule = useMemo(() => MODULE_PRESETS.find(m => m.id === moduleId) || MODULE_PRESETS[0], [moduleId]);
  const selectedAlgo = useMemo(() => FLASHER_ALGOS.find(a => a.id === algoId) || FLASHER_ALGOS[0], [algoId]);
  const charger = useMemo(() => decodeChargerVin(masterVin), [masterVin]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [log.length]);

  // Refresh live elapsed display while a flash is in progress.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const t = Date.now() - startTickRef.current;
      setElapsedMs(t);
      if (bytesSent > 0 && t > 0){
        setThroughputKBs((bytesSent / 1024) / (t / 1000));
      }
    }, 250);
    return () => clearInterval(id);
  }, [running, bytesSent]);

  const addLog = useCallback((entry) => setLog(prev => [...prev.slice(-500), entry]), []);

  const connect = useCallback(async () => {
    setError(null);
    addLog({t: Date.now(), level: 'info', msg: 'Opening bench bridge...'});
    try {
      // createBridgeEngine returns {ok, engine?, error?} — unwrap both shapes.
      const res = await createBridgeEngine({addLog: (m, t) => addLog({t: Date.now(), level: t === 'rx' ? 'info' : (t || 'info'), msg: m})});
      if (!res || res.ok !== true || !res.engine){
        const why = (res && res.error) || 'Bench bridge unreachable. Start `j2534_bridge.py` on localhost:8765.';
        setError(why);
        addLog({t: Date.now(), level: 'error', msg: why});
        return;
      }
      const eng = res.engine;
      if (eng.isBridge !== true){
        setError('Engine is not the bench bridge — flasher refuses to run.');
        addLog({t: Date.now(), level: 'error', msg: 'createBridgeEngine() did not return a bridge engine'});
        return;
      }
      engineRef.current = eng;
      setBridge({vendor: eng.vendor || 'unknown', firmware: eng.firmware || null});
      setConn(true);
      addLog({t: Date.now(), level: 'info', msg: `Connected · vendor=${eng.vendor || 'unknown'}${eng.firmware ? ' fw=' + eng.firmware : ''}`});
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setError(msg);
      addLog({t: Date.now(), level: 'error', msg});
    }
  }, [addLog]);

  const disconnect = useCallback(() => {
    engineRef.current = null;
    setConn(false);
    setBridge({vendor: null, firmware: null});
    addLog({t: Date.now(), level: 'info', msg: 'Disconnected'});
  }, [addLog]);

  const runFlash = useCallback(async (overrides = {}) => {
    if (!selectedFile){ setError('No C-Flash file selected'); return; }
    if (!engineRef.current){ setError('Connect to the bench bridge first'); return; }
    setError(null); setResult(null); setLog([]); setPct(0);
    setPhase(FLASH_PHASES.CONNECT);
    setBytesSent(0); setChunksSent(0); setElapsedMs(0); setThroughputKBs(0);
    setRunning(true);
    startTickRef.current = Date.now();

    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    abortRef.current = ac;
    const data = selectedFile.data instanceof Uint8Array ? selectedFile.data
      : (selectedFile.data && selectedFile.data.buffer ? new Uint8Array(selectedFile.data.buffer) : null);
    if (!data){
      setError('Selected file has no byte data');
      setRunning(false);
      return;
    }
    const ctrl = flashEcm({
      engine: engineRef.current,
      payload: data,
      address: parseInt(addressHex, 16) >>> 0,
      chunkSize: Math.max(1, chunkSize | 0),
      eraseRid: parseInt(eraseRid, 16) & 0xFFFF,
      checkRid: parseInt(checkRid, 16) & 0xFFFF,
      algoFn: selectedAlgo.fn,
      algoLabel: selectedAlgo.n,
      seedSubfn: parseInt(seedSubfn, 16) & 0xFF,
      keySubfn: parseInt(keySubfn, 16) & 0xFF,
      addr: {tx: selectedModule.tx, rx: selectedModule.rx},
      resumeFromChunk: overrides.resumeFromChunk != null ? overrides.resumeFromChunk : (resumeFromChunk | 0),
      keepAlive,
      onLog: (entry) => addLog(entry),
      onProgress: (p) => {
        if (typeof p.pct === 'number') setPct(p.pct);
        if (p.phase) setPhase(p.phase);
        if (typeof p.bytesSent === 'number') setBytesSent(p.bytesSent);
        if (typeof p.chunksSent === 'number') setChunksSent(p.chunksSent);
      },
      signal: ac ? ac.signal : undefined,
    });
    const r = await ctrl.start();
    setResult(r);
    setRunning(false);
    setElapsedMs(r.elapsedMs || (Date.now() - startTickRef.current));
    setThroughputKBs(r.throughputKBs || 0);
    if (!r.ok && !r.aborted) setError(r.error || 'Flash failed');
  }, [selectedFile, addLog, addressHex, chunkSize, eraseRid, checkRid, selectedAlgo, seedSubfn, keySubfn, selectedModule, resumeFromChunk, keepAlive]);

  const stopFlash = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    addLog({t: Date.now(), level: 'warn', msg: 'Stop requested · flasher will attempt clean 0x37 transfer exit'});
  }, [addLog]);

  // Resume is offered for any non-success result that left a usable
  // nextChunk affordance — both user-initiated aborts AND transfer-phase
  // NRC failures (e.g. 0x36 negative response mid-flash). The state
  // machine seeds result.nextChunk for both cases, so we just gate on
  // "not ok and there is a next chunk to resume from".
  const canResume = !!(result && !result.ok && (result.nextChunk | 0) > 0);
  const resumeFlash = useCallback(() => {
    if (!canResume) return;
    const next = result.nextChunk || 0;
    setResumeFromChunk(next);
    addLog({t: Date.now(), level: 'info', msg: `Resuming from chunk #${next}`});
    runFlash({resumeFromChunk: next});
  }, [result, runFlash, addLog]);

  const sizeMb = selectedFile && selectedFile.data ? (selectedFile.data.length / 1024 / 1024).toFixed(2) : null;
  const totalBytes = selectedFile && selectedFile.data ? selectedFile.data.length : 0;

  return (
    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14}}>
      <div>
        {/* Bench-only banner — drilled into the operator that this tab is
            not for vehicle-side flashing. */}
        <div data-testid="flasher-bench-banner" style={{
          padding: 12, borderRadius: 10, marginBottom: 14,
          background: 'linear-gradient(180deg, #FFF8F0 0%, #FFE9CC 100%)',
          border: `2px solid ${C.wn}`,
          boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
        }}>
          <div style={{fontWeight: 900, color: C.wn, fontSize: 12, letterSpacing: 1.4, marginBottom: 4}}>BENCH ONLY · NO SGW</div>
          <div style={{fontSize: 11, color: C.tx, lineHeight: 1.45}}>
            ECM must be on the bench, ignition off, battery+ground clipped. The flasher refuses to run unless the engine is the local Autel J2534 bridge. SGW routing is not used here.
          </div>
        </div>

        <Section title="BENCH BRIDGE" color={C.sr}>
          <Card>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
              <Tag color={conn ? C.gn : C.tm}>{conn ? '● CONNECTED' : '○ OFFLINE'}</Tag>
              <span style={{fontSize: 11, color: C.ts}}>Autel Elite J2534 via local bridge</span>
              {conn && bridge.vendor && <Tag color={C.a3} data-testid="flasher-bridge-vendor">vendor: {bridge.vendor}</Tag>}
              {conn && bridge.firmware && <Tag color={C.a4} data-testid="flasher-bridge-firmware">fw: {bridge.firmware}</Tag>}
            </div>
            <div style={{display: 'flex', gap: 8}}>
              {!conn && <Btn onClick={connect} disabled={running}>CONNECT</Btn>}
              {conn && <Btn outline onClick={disconnect} disabled={running}>DISCONNECT</Btn>}
            </div>
            {error && <div style={{marginTop: 8}}><SLine type="error" msg={error}/></div>}
          </Card>
        </Section>

        <Section title="VEHICLE / VIN" color={C.a4}>
          <Card>
            {masterVin && masterVin.length === 17 ? (
              <div data-testid="flasher-vin-row">
                <div style={{fontFamily: 'JetBrains Mono', fontSize: 13, fontWeight: 800, color: C.tx, letterSpacing: 1.5}}>{masterVin}</div>
                {charger ? (
                  <div data-testid="flasher-vin-decode" style={{marginTop: 4, fontSize: 11, color: C.ts}}>
                    <span style={{color: C.a3, fontWeight: 700}}>{charger.trim}</span>
                    <span style={{color: C.tm}}> · </span>
                    <span style={{color: C.tx}}>{charger.hp}</span>
                    <span style={{color: C.tm}}> · </span>
                    <span style={{color: C.ts}}>{charger.year} {charger.family}</span>
                  </div>
                ) : (
                  <div style={{marginTop: 4, fontSize: 11, color: C.tm, fontStyle: 'italic'}}>VIN does not match the Charger LD decoder · trim/HP unknown</div>
                )}
              </div>
            ) : (
              <SLine type="warn" msg="No master VIN set — open Module Sync to enter the 17-char VIN before flashing"/>
            )}
          </Card>
        </Section>

        <Section title="SELECTED PAYLOAD" color={TC.CFLASH}>
          <Card>
            {selectedFile ? (
              <div>
                <div style={{fontSize: 12, fontWeight: 800, color: C.tx, wordBreak: 'break-all'}}>{selectedFile.filename || selectedFile.name}</div>
                <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6}}>
                  <Tag color={TC[selectedFile.type] || C.a4}>{selectedFile.type || 'PAYLOAD'}</Tag>
                  <Tag color={C.a3}>{sizeMb} MB</Tag>
                  {selectedFile.security?.calId && <Tag color={C.a1}>Cal {selectedFile.security.calId}</Tag>}
                  {selectedFile.security?.tunerSigs?.length > 0 && <Tag color={C.er}>TUNED</Tag>}
                </div>
              </div>
            ) : (
              <SLine type="warn" msg="No payload selected — pick from the list or use 'Flash this' from C-Flash / EFD tabs"/>
            )}
            {candidates.length > 0 && (
              <div style={{marginTop: 10}}>
                <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>AVAILABLE</div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
                  {candidates.map((f, i) => (
                    <button key={f.filename || f.name || i} data-testid={`flasher-pick-${i}`} onClick={() => onSelectFile && onSelectFile(f)} style={{
                      textAlign: 'left', padding: '6px 8px', borderRadius: 6,
                      border: `1.5px solid ${selectedFile === f ? C.sr : C.bd}`,
                      background: selectedFile === f ? '#D32F2F12' : C.cd, color: C.tx,
                      fontFamily: "'Nunito'", fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    }}>
                      {f.filename || f.name} <span style={{color: C.ts, fontWeight: 500}}>· {((f.data?.length || f.size || 0) / 1024 / 1024).toFixed(2)} MB</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </Section>

        <Section title="TARGET MODULE" color={C.a3}>
          <Card>
            <label style={{display: 'block'}}>
              <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>MODULE</div>
              <select data-testid="flasher-module-picker" value={moduleId} onChange={e => setModuleId(e.target.value)} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}>
                {MODULE_PRESETS.map(m => (
                  <option key={m.id} value={m.id}>{m.id} · tx 0x{m.tx.toString(16).toUpperCase()} / rx 0x{m.rx.toString(16).toUpperCase()} — {m.hint}</option>
                ))}
              </select>
            </label>
            <div style={{marginTop: 8, fontSize: 10, color: C.tm, fontFamily: 'JetBrains Mono'}}>
              tx=0x{selectedModule.tx.toString(16).toUpperCase()} rx=0x{selectedModule.rx.toString(16).toUpperCase()}
            </div>
          </Card>
        </Section>

        <Section title="UNLOCK ALGORITHM" color={C.a4}>
          <Card>
            <label style={{display: 'block'}}>
              <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>ALGORITHM</div>
              <select data-testid="flasher-algo-picker" value={algoId} onChange={e => setAlgoId(e.target.value)} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}>
                {FLASHER_ALGOS.map(a => (
                  <option key={a.id} value={a.id}>{a.n} — {a.h}</option>
                ))}
              </select>
            </label>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10}}>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>SEED SUB-FUNCTION</div>
                <select data-testid="flasher-seed-subfn" value={seedSubfn} onChange={e => setSeedSubfn(e.target.value)} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}>
                  <option value="09">0x09 (programming-session, default)</option>
                  <option value="01">0x01 (classic level-1)</option>
                </select>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>KEY SUB-FUNCTION</div>
                <select data-testid="flasher-key-subfn" value={keySubfn} onChange={e => setKeySubfn(e.target.value)} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}>
                  <option value="0A">0x0A (paired with 0x09)</option>
                  <option value="02">0x02 (paired with 0x01)</option>
                </select>
              </label>
            </div>
          </Card>
        </Section>

        <Section title="FLASH PARAMETERS" color={C.a3}>
          <Card>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>START ADDRESS (HEX)</div>
                <input data-testid="flasher-address" value={addressHex} onChange={e => setAddressHex(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 8))} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>CHUNK SIZE (BYTES)</div>
                <input data-testid="flasher-chunk" type="number" min={1} max={4096} value={chunkSize} onChange={e => setChunkSize(parseInt(e.target.value, 10) || 0x80)} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>ERASE RID (HEX)</div>
                <input value={eraseRid} onChange={e => setEraseRid(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 4))} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>CHECK RID (HEX)</div>
                <input value={checkRid} onChange={e => setCheckRid(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 4))} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>RESUME FROM CHUNK #</div>
                <input data-testid="flasher-resume-chunk" type="number" min={0} value={resumeFromChunk} onChange={e => setResumeFromChunk(Math.max(0, parseInt(e.target.value, 10) || 0))} disabled={running} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'flex', alignItems: 'center', gap: 8, marginTop: 22}}>
                <input type="checkbox" checked={keepAlive} onChange={e => setKeepAlive(e.target.checked)} disabled={running}/>
                <span style={{fontSize: 11, color: C.tx}}>Send 0x3E 80 keep-alive every 2s</span>
              </label>
            </div>
          </Card>
        </Section>

        <Section title="EXECUTE" color={C.er}>
          <Card>
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
              <Btn data-testid="flasher-start" onClick={() => runFlash()} disabled={!conn || !selectedFile || running}>
                {running ? 'FLASHING...' : 'FLASH ECM'}
              </Btn>
              {running && <Btn data-testid="flasher-stop" outline color={C.wn} onClick={stopFlash}>STOP</Btn>}
              {!running && canResume && (
                <Btn data-testid="flasher-resume" color={C.a3} onClick={resumeFlash}>RESUME FROM #{result.nextChunk}</Btn>
              )}
            </div>
            <div style={{marginTop: 12}}>
              <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 4}}>
                <span style={{fontSize: 10, color: C.ts, letterSpacing: 1.2}}>{phase ? PHASE_LABELS[phase] || phase : 'IDLE'}</span>
                <span style={{fontSize: 10, color: C.tx, fontFamily: 'JetBrains Mono'}}>{(pct * 100).toFixed(1)}%</span>
              </div>
              <ProgressBar pct={pct} color={result?.ok ? C.gn : (result?.aborted ? C.wn : (error ? C.er : C.sr))}/>
            </div>

            {/* Live transfer metrics — visible whenever there is data to
                show (running, completed, or aborted). */}
            <div data-testid="flasher-metrics" style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12, fontFamily: 'JetBrains Mono', fontSize: 11}}>
              <div style={{padding: 8, background: C.c2, borderRadius: 6, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>TRANSFERRED</div>
                <div style={{color: C.tx, fontWeight: 800}}>{fmtMB(bytesSent)}{totalBytes ? ' / ' + fmtMB(totalBytes) : ''}</div>
              </div>
              <div style={{padding: 8, background: C.c2, borderRadius: 6, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>CHUNKS</div>
                <div style={{color: C.tx, fontWeight: 800}}>{chunksSent}</div>
              </div>
              <div style={{padding: 8, background: C.c2, borderRadius: 6, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>ELAPSED</div>
                <div style={{color: C.tx, fontWeight: 800}}>{fmtMs(elapsedMs)}</div>
              </div>
              <div style={{padding: 8, background: C.c2, borderRadius: 6, border: `1px solid ${C.bd}`}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>THROUGHPUT</div>
                <div style={{color: C.tx, fontWeight: 800}}>{throughputKBs.toFixed(2)} KB/s</div>
              </div>
            </div>

            {result && result.ok && (
              <div style={{marginTop: 10}}><SLine type="pass" msg={`Flash complete · ${result.bytesSent} bytes in ${result.chunksSent} chunks · ${fmtMs(result.elapsedMs)} · ${(result.throughputKBs || 0).toFixed(2)} KB/s`}/></div>
            )}
            {result && !result.ok && result.aborted && (
              <div style={{marginTop: 10}}><SLine type="warn" msg={`Aborted at ${PHASE_LABELS[result.phase] || result.phase} · resume from chunk #${result.nextChunk} available`}/></div>
            )}
            {result && !result.ok && !result.aborted && (
              <div style={{marginTop: 10}}><SLine type="error" msg={result.error || 'Failed'}/></div>
            )}
          </Card>
        </Section>
      </div>

      <div>
        <Section title="LIVE TRACE" color={C.a4}>
          <Card>
            <div ref={logBoxRef} style={{maxHeight: '70vh', overflowY: 'auto', background: C.c2, borderRadius: 8, padding: 10, border: `1px solid ${C.bd}`}}>
              {log.length === 0 && <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic'}}>Awaiting trace...</div>}
              {log.map((e, i) => <LogLine key={`${e.t}-${i}`} entry={e}/>)}
            </div>
            {result && (
              <div data-testid="flasher-result-summary" style={{marginTop: 10, padding: 10, borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`, fontSize: 11, fontFamily: 'JetBrains Mono', color: C.tx, lineHeight: 1.5}}>
                <div>algo={result.algoLabel || '—'}  module={selectedModule.id}</div>
                <div>seed={result.seed || '—'}  key={result.key || '—'}</div>
                <div>maxNumberOfBlockLength={result.maxNumberOfBlockLength != null ? result.maxNumberOfBlockLength : '—'}</div>
                <div>bytes={result.bytesSent}  chunks={result.chunksSent}  nextChunk={result.nextChunk}</div>
                <div>elapsed={fmtMs(result.elapsedMs)}  throughput={(result.throughputKBs || 0).toFixed(2)} KB/s</div>
                {result.nrc != null && <div>nrc=0x{result.nrc.toString(16).toUpperCase().padStart(2,'0')}</div>}
              </div>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}
