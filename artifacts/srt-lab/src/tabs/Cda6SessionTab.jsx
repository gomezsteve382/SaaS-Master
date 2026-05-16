import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Card, Tag, SLine, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {cda6} from '../lib/algos.js';
import {CDA_FLASH_CATALOG, getOfflineFlashSequence} from '../lib/cdaCatalog.js';
import {flashEcuOffline, FLASH_PHASES} from '../lib/flasherStateMachine.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {useCanRecorder} from '../lib/canRecorder.js';

// CDA6 UDS programming-session walkthrough (Task #488 + Task #599). The
// step list is now driven by the per-module catalog mined out of the
// cracked CDA SWF (tools/cda-extractor) instead of being hand-coded, so
// the operator can pick a target module (ECM / BCM / RFHUB / SGW / …)
// and see the exact UDS phase ladder the offline-flash mode will walk.
// Task #608 adds a "Run offline flash" affordance that executes
// flashEcuOffline() directly from this tab with a file-picker for the
// calibration payload, so the operator never has to switch to ECM Flasher.

// Map catalog phase ids → display rows.
const PHASE_PRETTY = {
  session_extended:   {name: 'Diagnostic Session Control',  desc: 'Extended diagnostic session'},
  etiquette_dtc_off:  {name: 'ControlDTCSetting (suppress)',desc: 'Stop DTC logging during flash'},
  etiquette_comm_off: {name: 'CommunicationControl (off)',  desc: 'Silence non-flash bus chatter'},
  session_program:    {name: 'Diagnostic Session Control',  desc: 'Programming session'},
  timing_p2:          {name: 'AccessTimingParameter',       desc: 'Negotiate extended P2 / P2*'},
  seed:               {name: 'SecurityAccess Seed Request', desc: 'Request seed (per module algo)'},
  key:                {name: 'SecurityAccess Send Key',     desc: 'Send computed key', highlight: true},
  erase:              {name: 'RoutineControl (Erase)',      desc: 'Routine 0xFF00 erase block'},
  request_download:   {name: 'Request Download',            desc: 'Setup block transfer'},
  transfer:           {name: 'Transfer Data',               desc: 'Stream payload blocks'},
  transfer_exit:      {name: 'Request Transfer Exit',       desc: 'End block transfer'},
  checksum:           {name: 'RoutineControl (Checksum)',   desc: 'Routine 0xFF01 verify image'},
  reset:              {name: 'ECU Reset',                   desc: 'Hard reset to apply'},
  etiquette_comm_on:  {name: 'CommunicationControl (on)',   desc: 'Restore bus comms'},
  etiquette_dtc_on:   {name: 'ControlDTCSetting (restore)', desc: 'Re-enable DTC logging'},
};

// Map catalog phase id → the FLASH_PHASES value that represents it being
// "active". Used to light up phase rows green/red during a live flash run.
const CATALOG_PHASE_TO_SM = {
  session_extended:   FLASH_PHASES.SESSION_EXT,
  etiquette_dtc_off:  FLASH_PHASES.SESSION_EXT,
  etiquette_comm_off: FLASH_PHASES.SESSION_EXT,
  session_program:    FLASH_PHASES.SESSION,
  timing_p2:          FLASH_PHASES.TIMING,
  seed:               FLASH_PHASES.SEED,
  key:                FLASH_PHASES.KEY,
  erase:              FLASH_PHASES.ERASE,
  request_download:   FLASH_PHASES.REQUEST_DOWNLOAD,
  transfer:           FLASH_PHASES.TRANSFER,
  transfer_exit:      FLASH_PHASES.TRANSFER_EXIT,
  checksum:           FLASH_PHASES.CHECKSUM,
  reset:              FLASH_PHASES.RESET,
  etiquette_comm_on:  FLASH_PHASES.DONE,
  etiquette_dtc_on:   FLASH_PHASES.DONE,
};

// Ordered list of state-machine phases so we can determine whether a
// catalog phase is "before", "at", or "after" the current flash phase.
const SM_PHASE_ORDER = [
  FLASH_PHASES.CONNECT,
  FLASH_PHASES.SESSION_EXT,
  FLASH_PHASES.SESSION,
  FLASH_PHASES.TIMING,
  FLASH_PHASES.SEED,
  FLASH_PHASES.KEY,
  FLASH_PHASES.ERASE,
  FLASH_PHASES.REQUEST_DOWNLOAD,
  FLASH_PHASES.TRANSFER,
  FLASH_PHASES.TRANSFER_EXIT,
  FLASH_PHASES.CHECKSUM,
  FLASH_PHASES.RESET,
  FLASH_PHASES.DONE,
];

function smPhaseIndex(p){ return SM_PHASE_ORDER.indexOf(p); }

function catalogStepsFor(code){
  const seq = getOfflineFlashSequence(code) || [];
  return seq.map((s, i) => {
    const pp = PHASE_PRETTY[s.phase] || {name: s.swfClass || s.phase, desc: ''};
    return {
      step: i + 1,
      phase: s.phase,
      smPhase: CATALOG_PHASE_TO_SM[s.phase] || null,
      name: pp.name,
      desc: pp.desc || s.swfClass || '',
      service: '0x' + (s.sid || 0).toString(16).toUpperCase().padStart(2, '0'),
      subfn: s.sub != null ? '0x' + s.sub.toString(16).toUpperCase().padStart(2, '0') : '—',
      tx: s.tx,
      expected: s.expects,
      highlight: !!pp.highlight,
      swfClass: s.swfClass,
    };
  });
}

const TOOLS = [
  {name: 'Autel Elite J2534 + bridge', desc: 'Bench-only path. Connect via the local bridge daemon (this app). CDA6, GPEC2A, BCM, RFHUB all driven from here.', cost: '$$ (already owned)'},
  {name: 'wiTECH 2.0 + MicroPod',      desc: 'OEM Mopar tool. TechAuthority sub required. Best for Mopar `.webm` cals on a real vehicle.', cost: '$$$'},
  {name: 'AlfaOBD + CarDAQ-Plus',      desc: 'Independent shop favorite. CDA6 built in, handles GPEC2A flashing.', cost: '$$'},
  {name: 'AlfaOBD + MongoosePro JLR',  desc: 'Cheaper J2534 option. Verify Hellcat/Redeye support before trusting it.', cost: '$'},
];

function Section({title, color, children}){
  const c = color || C.a3;
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
    <div style={{position: 'relative', height: 10, borderRadius: 6, background: C.c2, border: `1px solid ${C.bd}`, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, width: (v * 100).toFixed(2) + '%', background: color || C.gn, transition: 'width 0.15s'}}/>
    </div>
  );
}

function LogLine({entry}){
  const colorMap = {tx: C.a3, rx: C.gn, info: C.tx, warn: C.wn, error: C.er};
  const c = colorMap[entry.level] || C.tx;
  return <div style={{fontFamily: 'JetBrains Mono', fontSize: 10, color: c, padding: '2px 0', lineHeight: 1.4}}>{entry.msg}</div>;
}

// Determine the row tint for a step given the current flash state.
// Returns 'active' | 'done' | 'failed' | 'idle'
//
// FAILED and ABORTED are terminal states not in SM_PHASE_ORDER, so we use
// `lastActivePhase` (the last non-terminal phase seen via onProgress) to
// resolve which step failed and which prior steps completed successfully.
function stepStatus(step, flashPhase, lastActivePhase){
  if (!flashPhase) return 'idle';
  const smPhase = step.smPhase;
  if (!smPhase) return 'idle';

  const isDone   = flashPhase === FLASH_PHASES.DONE;
  const isFailed = flashPhase === FLASH_PHASES.FAILED || flashPhase === FLASH_PHASES.ABORTED;
  const stepIdx  = smPhaseIndex(smPhase);

  if (isDone) return 'done';

  if (isFailed){
    // Use lastActivePhase to determine where the machine stopped.
    const failedIdx = smPhaseIndex(lastActivePhase || FLASH_PHASES.CONNECT);
    if (stepIdx < failedIdx) return 'done';
    if (stepIdx === failedIdx) return 'failed';
    return 'idle';
  }

  const currentIdx = smPhaseIndex(flashPhase);
  if (stepIdx < currentIdx) return 'done';
  if (stepIdx === currentIdx) return 'active';
  return 'idle';
}

const STATUS_STYLE = {
  active: {bg: '#2979FF12', border: C.a3 + '60', dot: C.a3,  dotLabel: '▶'},
  done:   {bg: '#00C85312', border: C.gn + '60',  dot: C.gn,  dotLabel: '✓'},
  failed: {bg: '#FF174412', border: C.er + '60',  dot: C.er,  dotLabel: '✗'},
  idle:   {bg: null,        border: null,           dot: null,  dotLabel: null},
};

export default function Cda6SessionTab(){
  const [seedHex, setSeedHex] = useState('');
  const moduleCodes = useMemo(() => Object.keys(CDA_FLASH_CATALOG?.modules || {}).sort(), []);
  const [moduleCode, setModuleCode] = useState(moduleCodes.includes('ECM') ? 'ECM' : (moduleCodes[0] || 'ECM'));
  const STEPS = useMemo(() => catalogStepsFor(moduleCode), [moduleCode]);
  const modMeta = CDA_FLASH_CATALOG?.modules?.[moduleCode];

  // Bridge / flash state
  const [conn, setConn] = useState(false);
  const [bridgeInfo, setBridgeInfo] = useState({vendor: null, firmware: null});
  const [running, setRunning] = useState(false);
  const [flashPhase, setFlashPhase] = useState(null);
  const [flashResult, setFlashResult] = useState(null);
  const [flashError, setFlashError] = useState(null);
  const [flashLog, setFlashLog] = useState([]);
  const [pct, setPct] = useState(0);
  const [payloadFile, setPayloadFile] = useState(null);

  // Track the last *operational* (non-terminal) phase so that after a
  // failure or abort we can still show which steps completed (green) and
  // which step was active when the machine stopped (red).
  const [lastActivePhase, setLastActivePhase] = useState(null);

  const engineRef = useRef(null);
  const abortRef  = useRef(null);
  const logBoxRef = useRef(null);
  const fileInputRef = useRef(null);

  const recorder = useCanRecorder({iface: 'cda6'});
  const recorderRef = useRef(recorder);
  useEffect(() => { recorderRef.current = recorder; }, [recorder]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [flashLog.length]);

  const addLog = useCallback((entry) => setFlashLog(prev => [...prev.slice(-400), entry]), []);

  const connect = useCallback(async () => {
    setFlashError(null);
    addLog({t: Date.now(), level: 'info', msg: 'Opening bench bridge…'});
    try {
      const res = await createBridgeEngine({
        addLog: (m, t) => addLog({t: Date.now(), level: t || 'info', msg: m}),
      });
      if (!res || res.ok !== true || !res.engine){
        const why = (res && res.error) || 'Bridge unreachable — start j2534_bridge.py on localhost:8765';
        setFlashError(why);
        addLog({t: Date.now(), level: 'error', msg: why});
        return;
      }
      const eng = res.engine;
      if (eng.isBridge !== true){
        const why = 'Engine is not the bench bridge — flasher refuses to run';
        setFlashError(why);
        addLog({t: Date.now(), level: 'error', msg: why});
        return;
      }
      // Wrap eng.uds so every request/response can be tapped into the
      // optional candump recorder when the user has it armed.
      const origUds = eng.uds && eng.uds.bind(eng);
      if (origUds) {
        eng.uds = async (tx, rx, data) => {
          recorderRef.current?.addFrame({id: tx, ext: tx > 0x7FF, data});
          const r = await origUds(tx, rx, data);
          if (r && r.ok && r.d) recorderRef.current?.addFrame({id: rx, ext: rx > 0x7FF, data: r.d});
          return r;
        };
      }
      engineRef.current = eng;
      setBridgeInfo({vendor: eng.vendor || 'unknown', firmware: eng.firmware || null});
      setConn(true);
      addLog({t: Date.now(), level: 'info', msg: `Connected · vendor=${eng.vendor || 'unknown'}${eng.firmware ? ' fw=' + eng.firmware : ''}`});
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setFlashError(msg);
      addLog({t: Date.now(), level: 'error', msg});
    }
  }, [addLog]);

  const disconnect = useCallback(() => {
    engineRef.current = null;
    setConn(false);
    setBridgeInfo({vendor: null, firmware: null});
    addLog({t: Date.now(), level: 'info', msg: 'Disconnected'});
  }, [addLog]);

  const handleFileChange = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPayloadFile({name: f.name, size: f.size, data: new Uint8Array(ev.target.result)});
      setFlashResult(null);
      setFlashError(null);
    };
    reader.readAsArrayBuffer(f);
    // reset so same file can be re-picked
    e.target.value = '';
  }, []);

  const runFlash = useCallback(async () => {
    if (!payloadFile) { setFlashError('Pick a .bin / .efd payload first'); return; }
    if (!engineRef.current) { setFlashError('Connect to the bench bridge first'); return; }
    setFlashError(null);
    setFlashResult(null);
    setFlashLog([]);
    setPct(0);
    setFlashPhase(FLASH_PHASES.CONNECT);
    setLastActivePhase(FLASH_PHASES.CONNECT);
    setRunning(true);

    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ac;

    try {
      const ctrl = flashEcuOffline({
        moduleCode,
        engine: engineRef.current,
        payload: payloadFile.data,
        keepAlive: true,
        onLog: (entry) => addLog(entry),
        onProgress: (p) => {
          if (p.phase) {
            setFlashPhase(p.phase);
            // Only record operational phases — never overwrite with a terminal
            // state so stepStatus() can determine which step failed after abort.
            if (p.phase !== FLASH_PHASES.DONE &&
                p.phase !== FLASH_PHASES.FAILED &&
                p.phase !== FLASH_PHASES.ABORTED){
              setLastActivePhase(p.phase);
            }
          }
          if (typeof p.pct === 'number') setPct(p.pct);
        },
        signal: ac ? ac.signal : undefined,
      });
      const r = await ctrl.start();
      setFlashResult(r);
      setFlashPhase(r.ok ? FLASH_PHASES.DONE : (r.aborted ? FLASH_PHASES.ABORTED : FLASH_PHASES.FAILED));
      if (!r.ok) setFlashError(r.error || 'Flash failed');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setFlashError(msg);
      setFlashPhase(FLASH_PHASES.FAILED);
      addLog({t: Date.now(), level: 'error', msg});
    } finally {
      setRunning(false);
    }
  }, [moduleCode, payloadFile, addLog]);

  const stopFlash = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    addLog({t: Date.now(), level: 'warn', msg: 'Stop requested — will attempt clean 0x37 exit'});
  }, [addLog]);

  const calc = useMemo(() => {
    const raw = seedHex.replace(/\s/g, '');
    const v = parseInt(raw, 16);
    if (!raw || isNaN(v)) return null;
    return {
      seed: (v >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      key: (cda6(v) >>> 0).toString(16).toUpperCase().padStart(8, '0'),
    };
  }, [seedHex]);

  const flashDone    = flashPhase === FLASH_PHASES.DONE;
  const flashFailed  = flashPhase === FLASH_PHASES.FAILED || flashPhase === FLASH_PHASES.ABORTED;
  const overallColor = flashDone ? C.gn : flashFailed ? C.er : C.a3;

  return (
    <div style={{maxWidth: 980}}>
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap'}}>
          <Tag color={C.a3}>UDS SECURITY ACCESS</Tag>
          <span style={{fontSize: 14, fontWeight: 800, color: C.tx, fontFamily: "'Righteous'"}}>CDA6 SESSION HELPER</span>
        </div>
        <div style={{fontSize: 12, color: C.ts, lineHeight: 1.6}}>
          Walk-through for the standard FCA ECM programming session. Use this to verify J2534 trace logs from
          wiTECH/AlfaOBD, or run the offline flash directly from this tab using the affordance below.
        </div>
      </Card>

      <Section title="OFFLINE-FLASH MODULE" color={C.gn}>
        <Card>
          <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{fontSize: 10, color: C.tm, letterSpacing: 1.4}}>MODULE</span>
            <select
              data-testid="cda-catalog-module"
              value={moduleCode}
              onChange={e => { setModuleCode(e.target.value); setFlashResult(null); setFlashPhase(null); setLastActivePhase(null); setFlashError(null); }}
              disabled={running}
              style={{padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.bd}`, background: C.c2, color: C.tx, fontFamily: 'JetBrains Mono', fontSize: 12}}
            >
              {moduleCodes.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {modMeta && (
              <>
                <Tag color={C.a1}>tx {modMeta.tx}</Tag>
                <Tag color={C.a3}>rx {modMeta.rx}</Tag>
                <Tag color={C.sr}>algo {modMeta.unlockAlgo}</Tag>
              </>
            )}
            <span style={{flex: 1}}/>
            <span style={{fontSize: 9, color: C.ts, fontFamily: 'JetBrains Mono'}}>catalog · CDA SWF sha256 {(CDA_FLASH_CATALOG?._meta?.sha256 || '').slice(0, 12)}…</span>
          </div>
        </Card>
      </Section>

      {/* ─── LIVE CAN RECORDER (Task #617) ───────────────────────────────── */}
      <Section title="LIVE CAN RECORDER" color={C.a4}>
        <Card>
          <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
            <Tag color={recorder.recording ? C.sr : C.tm}>{recorder.recording ? '● REC' : '○ IDLE'}</Tag>
            <span style={{fontSize:11,color:C.ts}}>captures every UDS request/response on this CDA6 session into a candump-format buffer</span>
            <span style={{flex:1}}/>
            <span style={{fontSize:10,fontFamily:'JetBrains Mono',color:C.tm}}>{recorder.count} frames{recorder.overflowed ? ' (ring overflow)' : ''}</span>
          </div>
          <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
            <Btn data-testid="cda6-rec-start" onClick={recorder.start} disabled={recorder.recording} color={C.sr}>● START</Btn>
            <Btn data-testid="cda6-rec-stop" onClick={recorder.stop} disabled={!recorder.recording} outline>■ STOP</Btn>
            <Btn data-testid="cda6-rec-clear" onClick={recorder.clear} outline>CLEAR</Btn>
            <Btn data-testid="cda6-rec-download" onClick={() => recorder.download()} disabled={!recorder.count}>📥 DOWNLOAD .log</Btn>
            <Btn data-testid="cda6-rec-open-analyser" onClick={() => recorder.openInAnalyser()} disabled={!recorder.count} color={C.a4}>📜 OPEN IN LOG ANALYSER</Btn>
          </div>
        </Card>
      </Section>

      {/* ─── ONE-CLICK OFFLINE FLASH (Task #608) ─────────────────────────── */}
      <Section title="RUN OFFLINE FLASH" color={C.sr}>
        <Card>
          {/* Bridge connect row */}
          <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap'}}>
            <Tag color={conn ? C.gn : C.tm}>{conn ? '● CONNECTED' : '○ OFFLINE'}</Tag>
            <span style={{fontSize: 11, color: C.ts}}>Autel Elite J2534 bench bridge</span>
            {conn && bridgeInfo.vendor && <Tag color={C.a3}>{bridgeInfo.vendor}</Tag>}
            {conn && bridgeInfo.firmware && <Tag color={C.a4}>fw {bridgeInfo.firmware}</Tag>}
            <span style={{flex: 1}}/>
            {!conn && <Btn onClick={connect} disabled={running} color={C.a3}>CONNECT</Btn>}
            {conn  && <Btn outline onClick={disconnect} disabled={running} color={C.tm}>DISCONNECT</Btn>}
          </div>

          {/* Payload picker */}
          <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap'}}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".bin,.efd"
              style={{display: 'none'}}
              onChange={handleFileChange}
            />
            <Btn
              color={C.a4}
              outline
              disabled={running}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              {payloadFile ? '⊕ CHANGE PAYLOAD' : '⊕ PICK .BIN / .EFD'}
            </Btn>
            {payloadFile ? (
              <div style={{display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
                <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: C.tx, fontWeight: 700}}>{payloadFile.name}</span>
                <Tag color={C.a3}>{(payloadFile.size / 1024).toFixed(0)} KB</Tag>
              </div>
            ) : (
              <span style={{fontSize: 11, color: C.tm, fontStyle: 'italic'}}>No payload selected</span>
            )}
          </div>

          {/* Run / stop button */}
          <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10}}>
            {!running && (
              <Btn
                data-testid="cda-run-offline-flash"
                color={C.sr}
                disabled={!conn || !payloadFile}
                onClick={runFlash}
              >
                ▶ RUN OFFLINE FLASH
              </Btn>
            )}
            {running && (
              <Btn color={C.wn} onClick={stopFlash}>■ STOP</Btn>
            )}
            {running && (
              <span style={{fontSize: 11, color: C.a3, fontFamily: 'JetBrains Mono', fontWeight: 700}}>
                {flashPhase || '…'}
              </span>
            )}
            {flashDone && !running && (
              <Tag color={C.gn}>FLASH COMPLETE</Tag>
            )}
            {flashFailed && !running && (
              <Tag color={C.er}>{flashPhase === FLASH_PHASES.ABORTED ? 'ABORTED' : 'FAILED'}</Tag>
            )}
          </div>

          {/* Progress bar — only shown while running or after completion */}
          {(running || flashResult) && (
            <div style={{marginBottom: 10}}>
              <ProgressBar pct={pct} color={flashDone ? C.gn : flashFailed ? C.er : C.a3}/>
            </div>
          )}

          {/* Inline error / NRC */}
          {flashError && <SLine type="error" msg={flashError}/>}
          {flashResult && flashResult.nrc != null && (
            <SLine type="error" msg={`NRC 0x${flashResult.nrc.toString(16).toUpperCase().padStart(2,'0')} at phase ${flashResult.phase}`}/>
          )}
          {flashDone && flashResult && (
            <SLine type="pass" msg={`Done · ${flashResult.bytesSent} B · ${flashResult.chunksSent} chunks · ${flashResult.elapsedMs} ms · ${(flashResult.throughputKBs || 0).toFixed(2)} KB/s`}/>
          )}

          {/* Compact log console */}
          {flashLog.length > 0 && (
            <div
              ref={logBoxRef}
              style={{
                marginTop: 10,
                maxHeight: 140,
                overflowY: 'auto',
                background: '#111',
                borderRadius: 8,
                padding: '8px 10px',
                border: `1px solid ${C.bd}`,
              }}
            >
              {flashLog.map((e, i) => <LogLine key={i} entry={e}/>)}
            </div>
          )}
        </Card>
      </Section>

      {/* ─── SESSION SEQUENCE with live phase lighting ────────────────────── */}
      <Section title="SESSION SEQUENCE" color={C.a3}>
        <Card>
          {STEPS.map(s => {
            const status = stepStatus(s, flashPhase, lastActivePhase);
            const ss = STATUS_STYLE[status];
            const isActive = status === 'active';
            return (
              <div key={s.step} style={{
                padding: '10px 12px', marginBottom: 6, borderRadius: 10,
                background: ss.bg || (s.highlight ? '#FF174410' : C.c2),
                border: `1px solid ${ss.border || (s.highlight ? C.er + '40' : C.bd)}`,
                display: 'grid', gridTemplateColumns: '36px 16px 1fr 130px 180px', alignItems: 'center', gap: 10,
                transition: 'background 0.25s, border-color 0.25s',
              }}>
                {/* Step number */}
                <div style={{fontSize: 18, fontWeight: 900, color: ss.dot || (s.highlight ? C.er : C.a3), textAlign: 'center', fontFamily: 'JetBrains Mono'}}>{s.step}</div>
                {/* Status dot */}
                <div style={{textAlign: 'center', fontSize: 12, color: ss.dot || C.tm, fontWeight: 900, opacity: ss.dotLabel ? 1 : 0.3}}>
                  {ss.dotLabel || '·'}
                  {isActive && <span style={{display: 'inline-block', animation: 'pulse 1s ease-in-out infinite'}}/>}
                </div>
                {/* Name / desc */}
                <div>
                  <div style={{fontSize: 12, fontWeight: 800, color: ss.dot || C.tx}}>{s.name}</div>
                  <div style={{fontSize: 10, color: C.ts, marginTop: 2}}>{s.desc}</div>
                </div>
                {/* Service / sub */}
                <div>
                  <div style={{fontSize: 8, color: C.tm, letterSpacing: 1.2}}>SVC / SUB</div>
                  <div style={{fontSize: 11, fontFamily: 'JetBrains Mono', color: C.a1, fontWeight: 700}}>{s.service} / {s.subfn}</div>
                </div>
                {/* TX → RX */}
                <div>
                  <div style={{fontSize: 8, color: C.tm, letterSpacing: 1.2}}>TX → RX</div>
                  <div style={{fontSize: 10, fontFamily: 'JetBrains Mono', color: C.gn}}>{s.tx}</div>
                  <div style={{fontSize: 10, fontFamily: 'JetBrains Mono', color: C.a3}}>{s.expected}</div>
                </div>
              </div>
            );
          })}
        </Card>
      </Section>

      <Section title="STEP 3 · CDA6 KEY CALCULATOR" color={C.sr}>
        <Card>
          <div style={{fontSize: 11, color: C.ts, marginBottom: 8}}>Paste seed bytes from the ECM `67 01 [SEED]` response:</div>
          <input
            data-testid="cda6-seed-input"
            value={seedHex}
            onChange={e => setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g, ''))}
            placeholder="A1 B2 C3 D4"
            style={{width: '100%', padding: 12, borderRadius: 10, border: `2px solid ${C.bd}`, background: C.c2, color: C.tx, fontSize: 18, fontWeight: 700, letterSpacing: 4, textAlign: 'center', outline: 'none', fontFamily: 'JetBrains Mono'}}
          />
          {calc && (
            <div style={{marginTop: 12, padding: 12, borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}`}}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 30px 1fr', alignItems: 'center'}}>
                <div>
                  <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>SEED (FROM ECM)</div>
                  <div style={{fontSize: 22, fontWeight: 800, color: C.a3, fontFamily: 'JetBrains Mono'}}>{calc.seed}</div>
                </div>
                <div style={{textAlign: 'center', color: C.tm, fontSize: 18}}>→</div>
                <div>
                  <div style={{fontSize: 9, color: C.ts, letterSpacing: 1.2}}>KEY (CDA6)</div>
                  <div data-testid="cda6-key-output" style={{fontSize: 22, fontWeight: 800, color: C.sr, fontFamily: 'JetBrains Mono'}}>{calc.key}</div>
                </div>
              </div>
              <div style={{marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#00C85312', fontSize: 11, color: C.gn, fontFamily: 'JetBrains Mono'}}>
                Send: 27 02 {calc.key.match(/.{2}/g).join(' ')}
              </div>
            </div>
          )}
          {!calc && <SLine type="warn" msg="Awaiting seed bytes"/>}
        </Card>
      </Section>

      <Section title="COMPATIBLE TOOLS" color={C.gn}>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10}}>
          {TOOLS.map((t, i) => (
            <Card key={i}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8}}>
                <div style={{fontSize: 13, fontWeight: 800, color: C.tx}}>{t.name}</div>
                <Tag color={C.gn}>{t.cost}</Tag>
              </div>
              <div style={{fontSize: 11, color: C.ts, marginTop: 6, lineHeight: 1.5}}>{t.desc}</div>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
