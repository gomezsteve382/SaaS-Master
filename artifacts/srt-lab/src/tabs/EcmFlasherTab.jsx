import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Card, Btn, Tag, SLine} from '../lib/ui.jsx';
import {C, TC} from '../lib/constants.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {flashEcm, FLASH_PHASES} from '../lib/flasherStateMachine.js';

// ECM bench flasher tab (Task #488). Connects to the local Autel bridge
// daemon, walks the GPEC2A UDS programming session via flashEcm(), and
// streams progress/log/phase to the operator. Refuses to run when the
// engine is not the bench bridge.

const PHASE_LABELS = {
  [FLASH_PHASES.CONNECT]: 'Connecting',
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

export default function EcmFlasherTab({selectedFile, files = [], onSelectFile}){
  const [conn, setConn] = useState(false);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState(null);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [chunkSize, setChunkSize] = useState(0x80);
  const [eraseRid, setEraseRid] = useState('FF00');
  const [checkRid, setCheckRid] = useState('FF01');
  const [addressHex, setAddressHex] = useState('00000000');

  const engineRef = useRef(null);
  const abortRef = useRef(null);
  const logBoxRef = useRef(null);

  const candidates = useMemo(
    () => files.filter(f => f && (f.type === 'CFLASH' || f.type === 'FW' || f.type === 'EFD-PAYLOAD')),
    [files],
  );

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [log.length]);

  const addLog = useCallback((entry) => setLog(prev => [...prev.slice(-500), entry]), []);

  const connect = useCallback(async () => {
    setError(null);
    addLog({t: Date.now(), level: 'info', msg: 'Opening bench bridge...'});
    try {
      const eng = await createBridgeEngine();
      if (!eng){
        setError('Bench bridge unreachable. Start `j2534_bridge.py` on localhost:8765.');
        addLog({t: Date.now(), level: 'error', msg: 'Bridge engine returned null'});
        return;
      }
      if (eng.isBridge !== true){
        setError('Engine is not the bench bridge — flasher refuses to run.');
        addLog({t: Date.now(), level: 'error', msg: 'createBridgeEngine() did not return a bridge engine'});
        return;
      }
      engineRef.current = eng;
      setConn(true);
      addLog({t: Date.now(), level: 'info', msg: 'Connected to bench bridge'});
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setError(msg);
      addLog({t: Date.now(), level: 'error', msg});
    }
  }, [addLog]);

  const disconnect = useCallback(() => {
    engineRef.current = null;
    setConn(false);
    addLog({t: Date.now(), level: 'info', msg: 'Disconnected'});
  }, [addLog]);

  const runFlash = useCallback(async () => {
    if (!selectedFile){ setError('No C-Flash file selected'); return; }
    if (!engineRef.current){ setError('Connect to the bench bridge first'); return; }
    setError(null); setResult(null); setLog([]); setPct(0); setPhase(FLASH_PHASES.CONNECT);
    setRunning(true);
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
      onLog: (entry) => addLog(entry),
      onProgress: (p) => {
        if (typeof p.pct === 'number') setPct(p.pct);
        if (p.phase) setPhase(p.phase);
      },
      signal: ac ? ac.signal : undefined,
    });
    const r = await ctrl.start();
    setResult(r);
    setRunning(false);
    if (!r.ok && !r.aborted) setError(r.error || 'Flash failed');
  }, [selectedFile, addLog, addressHex, chunkSize, eraseRid, checkRid]);

  const stopFlash = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    addLog({t: Date.now(), level: 'warn', msg: 'Stop requested'});
  }, [addLog]);

  const sizeMb = selectedFile && selectedFile.data ? (selectedFile.data.length / 1024 / 1024).toFixed(2) : null;

  return (
    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14}}>
      <div>
        <Section title="BENCH BRIDGE" color={C.sr}>
          <Card>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10}}>
              <Tag color={conn ? C.gn : C.tm}>{conn ? '● CONNECTED' : '○ OFFLINE'}</Tag>
              <span style={{fontSize: 11, color: C.ts}}>Autel Elite J2534 via local bridge</span>
            </div>
            <div style={{display: 'flex', gap: 8}}>
              {!conn && <Btn onClick={connect} disabled={running}>CONNECT</Btn>}
              {conn && <Btn outline onClick={disconnect} disabled={running}>DISCONNECT</Btn>}
            </div>
            {error && <div style={{marginTop: 8}}><SLine type="error" msg={error}/></div>}
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
                    <button key={i} data-testid={`flasher-pick-${i}`} onClick={() => onSelectFile && onSelectFile(f)} style={{
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

        <Section title="FLASH PARAMETERS" color={C.a3}>
          <Card>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>START ADDRESS (HEX)</div>
                <input data-testid="flasher-address" value={addressHex} onChange={e => setAddressHex(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 8))} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>CHUNK SIZE (BYTES)</div>
                <input data-testid="flasher-chunk" type="number" min={1} max={4096} value={chunkSize} onChange={e => setChunkSize(parseInt(e.target.value, 10) || 0x80)} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>ERASE RID (HEX)</div>
                <input value={eraseRid} onChange={e => setEraseRid(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 4))} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
              <label style={{display: 'block'}}>
                <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2, marginBottom: 4}}>CHECK RID (HEX)</div>
                <input value={checkRid} onChange={e => setCheckRid(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 4))} style={{width: '100%', padding: 8, borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 13}}/>
              </label>
            </div>
          </Card>
        </Section>

        <Section title="EXECUTE" color={C.er}>
          <Card>
            <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
              <Btn data-testid="flasher-start" onClick={runFlash} disabled={!conn || !selectedFile || running}>
                {running ? '⚡ FLASHING...' : '⚡ FLASH ECM'}
              </Btn>
              {running && <Btn outline color={C.wn} onClick={stopFlash}>STOP</Btn>}
            </div>
            <div style={{marginTop: 12}}>
              <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 4}}>
                <span style={{fontSize: 10, color: C.ts, letterSpacing: 1.2}}>{phase ? PHASE_LABELS[phase] || phase : 'IDLE'}</span>
                <span style={{fontSize: 10, color: C.tx, fontFamily: 'JetBrains Mono'}}>{(pct * 100).toFixed(1)}%</span>
              </div>
              <ProgressBar pct={pct} color={result?.ok ? C.gn : (result?.aborted ? C.wn : (error ? C.er : C.sr))}/>
            </div>
            {result && result.ok && (
              <div style={{marginTop: 10}}><SLine type="pass" msg={`Flash complete · ${result.bytesSent} bytes in ${result.chunksSent} chunks`}/></div>
            )}
            {result && !result.ok && result.aborted && (
              <div style={{marginTop: 10}}><SLine type="warn" msg="Aborted"/></div>
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
              {log.map((e, i) => <LogLine key={i} entry={e}/>)}
            </div>
            {result && (
              <div style={{marginTop: 10, padding: 10, borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}`, fontSize: 11, fontFamily: 'JetBrains Mono', color: C.tx}}>
                <div>seed={result.seed || '—'}  key={result.key || '—'}</div>
                <div>maxNumberOfBlockLength={result.maxNumberOfBlockLength != null ? result.maxNumberOfBlockLength : '—'}</div>
                <div>bytes={result.bytesSent}  chunks={result.chunksSent}</div>
              </div>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}
