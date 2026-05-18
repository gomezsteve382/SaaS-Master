import React, {useState, useCallback, useRef} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {initAdapter} from "../lib/initAdapter.js";
import {decodeNRC} from "../lib/nrc.js";
import {build, decodeDid, didEntry} from "@workspace/uds";

// SKIM (Sentry Key Immobilizer) — Task #666
// Live UDS reads of immobilizer status / key count / key learning status
// against the canonical SKIM CAN ID (0x6B0 request / 0x6D0 response).
// Strictly read-only — no write or routine paths.
const SKIM_TX = 0x6B0;
const SKIM_RX = 0x6D0;

// DIDs catalogued by Task #657 and wired into lib/uds/src/dids.ts with
// SKIM-specific decoders (decodeSkimState / uint / decodeKeyLearningStatus).
const SKIM_DIDS = [
  {did: 0xDE01, label: 'Immobilizer Status'},
  {did: 0xDE02, label: 'Key Count'},
  {did: 0xDE03, label: 'Key Learning Status'},
];

// Optional RFHUB Remote Start indicator — same VILLAIN report,
// different module (RFHUB request 0x75F / response 0x767).
const RFHUB_TX = 0x75F;
const RFHUB_RX = 0x767;
const RFHUB_REMOTE_START_DID = 0xAB01;

const hx = (n, w=2) => n.toString(16).toUpperCase().padStart(w, '0');

function StatusRow({did, label, result}){
  const entry = didEntry(did);
  const fallback = entry?.name || ('DID 0x'+hx(did, 4));
  let valueNode = <span style={{color:C.tm,fontStyle:'italic'}}>not read yet</span>;
  let chip = null;
  if (result){
    if (result.error){
      valueNode = <span style={{color:C.er,fontFamily:"'JetBrains Mono'"}}>{result.error}</span>;
      chip = <span style={{padding:'2px 8px',borderRadius:6,fontSize:10,fontWeight:800,background:C.er+'18',color:C.er}}>ERROR</span>;
    } else if (result.nrc != null){
      valueNode = <span style={{color:C.er,fontFamily:"'JetBrains Mono'"}}>NRC 0x{hx(result.nrc)} — {decodeNRC(result.nrc)}</span>;
      chip = <span style={{padding:'2px 8px',borderRadius:6,fontSize:10,fontWeight:800,background:C.er+'18',color:C.er}}>NRC</span>;
    } else {
      valueNode = <span style={{color:C.tx,fontFamily:"'JetBrains Mono'",fontWeight:700}}>{result.decoded}</span>;
      chip = <span style={{padding:'2px 8px',borderRadius:6,fontSize:10,fontWeight:800,background:C.gn+'18',color:C.gn}}>OK</span>;
    }
  }
  return (
    <div style={{padding:'10px 12px',borderRadius:10,background:C.c2,border:'1px solid '+C.bd,marginBottom:8}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
        <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tm,fontWeight:700}}>0x{hx(did,4)}</span>
        <span style={{flex:1,fontSize:12,fontWeight:800}}>{label}</span>
        {chip}
      </div>
      <div style={{fontSize:12}}>{valueNode}</div>
      {result?.raw && (
        <div style={{marginTop:4,fontFamily:"'JetBrains Mono'",fontSize:9,color:C.ts,wordBreak:'break-all'}}>
          raw: {result.raw}
        </div>
      )}
      <div style={{marginTop:4,fontSize:9,color:C.tm}}>{fallback}</div>
    </div>
  );
}

export default function SkimTab(){
  const [conn, setConn] = useState(false);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  const [skimResults, setSkimResults] = useState({});
  const [rfhubResult, setRfhubResult] = useState(null);
  const eng = useRef(null);

  const addLog = useCallback((m, t='info') => {
    const ts = new Date().toLocaleTimeString();
    setLog(p => [...p.slice(-200), {t:ts, m, type:t}]);
  }, []);

  const connect = useCallback(async () => {
    const e = await initAdapter(addLog, hx);
    if (e){ eng.current = e; setConn(true); addLog('Connected — ready for SKIM reads', 'info'); }
  }, [addLog]);

  // Single 0x22 read; returns {ok,nrc?,d?,raw} normalised for the row UI.
  const readDid = useCallback(async (tx, rx, did) => {
    const r = await eng.current.uds(tx, rx, build.readDataByIdentifier({dids:[did]}));
    if (!r.ok) return {error: r.raw || 'no response'};
    const d = r.d;
    if (d && d[0] === 0x7F && d.length >= 3) return {nrc: d[2], raw: Array.from(d).map(b=>hx(b)).join(' ')};
    if (d && d[0] === 0x62){
      // 0x62 <DIDhi> <DIDlo> <payload...>
      const payload = d.length > 3 ? d.slice(3) : new Uint8Array();
      const decoded = decodeDid(did, payload);
      return {decoded, raw: Array.from(d).map(b=>hx(b)).join(' ')};
    }
    return {error: 'unexpected response', raw: d ? Array.from(d).map(b=>hx(b)).join(' ') : (r.raw||'')};
  }, []);

  const readSkim = useCallback(async () => {
    if (!eng.current){ addLog('Connect first', 'error'); return; }
    setBusy('Reading SKIM status...');
    addLog('═══ SKIM READ (TX 0x'+hx(SKIM_TX,3)+' / RX 0x'+hx(SKIM_RX,3)+') ═══', 'info');
    // Extended session — 0xDExx live reads are typically session-gated.
    await eng.current.uds(SKIM_TX, SKIM_RX, build.diagnosticSessionControl({session:0x03}));
    const next = {};
    for (const {did, label} of SKIM_DIDS){
      addLog('Reading 0x'+hx(did,4)+' ('+label+')...', 'info');
      // eslint-disable-next-line no-await-in-loop
      const res = await readDid(SKIM_TX, SKIM_RX, did);
      next[did] = res;
      if (res.decoded) addLog('  ✓ '+label+': '+res.decoded, 'rx');
      else if (res.nrc != null) addLog('  ✗ NRC 0x'+hx(res.nrc)+' — '+decodeNRC(res.nrc), 'warn');
      else addLog('  ✗ '+(res.error||'no data'), 'error');
    }
    setSkimResults(next);
    setBusy('');
  }, [addLog, readDid]);

  const readRfhubRemoteStart = useCallback(async () => {
    if (!eng.current){ addLog('Connect first', 'error'); return; }
    setBusy('Reading RFHUB Remote Start...');
    addLog('═══ RFHUB 0xAB01 (TX 0x'+hx(RFHUB_TX,3)+' / RX 0x'+hx(RFHUB_RX,3)+') ═══', 'info');
    await eng.current.uds(RFHUB_TX, RFHUB_RX, build.diagnosticSessionControl({session:0x03}));
    const res = await readDid(RFHUB_TX, RFHUB_RX, RFHUB_REMOTE_START_DID);
    setRfhubResult(res);
    if (res.decoded) addLog('  ✓ Remote Start: '+res.decoded, 'rx');
    else if (res.nrc != null) addLog('  ✗ NRC 0x'+hx(res.nrc)+' — '+decodeNRC(res.nrc), 'warn');
    else addLog('  ✗ '+(res.error||'no data'), 'error');
    setBusy('');
  }, [addLog, readDid]);

  return (
    <div>
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
          <span style={{fontSize:22}}>🛡️</span>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:900,color:C.sr,letterSpacing:1}}>SKIM LIVE STATUS</div>
            <div style={{fontSize:10,color:C.tm}}>Read-only · UDS 0x22 on SKIM 0x{hx(SKIM_TX,3)}/0x{hx(SKIM_RX,3)}</div>
          </div>
          <span style={{padding:'4px 10px',borderRadius:8,fontSize:10,fontWeight:800,background:conn?C.gn+'18':C.tm+'18',color:conn?C.gn:C.tm}}>
            {conn ? 'CONNECTED' : 'OFFLINE'}
          </span>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {!conn && <Btn onClick={connect} disabled={!!busy}>🔌 Connect Adapter</Btn>}
          {conn && <Btn onClick={readSkim} disabled={!!busy} color={C.sr}>📥 Read SKIM Status</Btn>}
          {conn && <Btn onClick={readRfhubRemoteStart} disabled={!!busy} outline>📡 Read RFHUB Remote Start</Btn>}
        </div>
        {busy && <div style={{marginTop:8,fontSize:11,color:C.a1,fontWeight:700}}>⏳ {busy}</div>}
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontSize:12,fontWeight:800,color:C.sr,letterSpacing:1,marginBottom:8}}>SKIM DIDs (0xDE01–0xDE03)</div>
        {SKIM_DIDS.map(({did,label}) => (
          <StatusRow key={did} did={did} label={label} result={skimResults[did]} />
        ))}
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontSize:12,fontWeight:800,color:C.sr,letterSpacing:1,marginBottom:8}}>RFHUB Remote Start (0xAB01)</div>
        <StatusRow did={RFHUB_REMOTE_START_DID} label="Remote Start Enable/Disable" result={rfhubResult} />
      </Card>

      <Card style={{padding:14}}>
        <div style={{fontSize:11,fontWeight:800,color:C.tm,letterSpacing:1,marginBottom:6}}>LOG</div>
        <div style={{maxHeight:260,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,padding:8,borderRadius:8,border:'1px solid '+C.bd}}>
          {log.length === 0 && <div style={{color:C.tm,fontStyle:'italic'}}>(no activity yet)</div>}
          {log.map((l,i) => (
            <div key={i} style={{color: l.type==='error'?C.er : l.type==='warn'?'#E69500' : l.type==='rx'?C.gn : l.type==='tx'?C.a1 : C.tx}}>
              [{l.t}] {l.m}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
