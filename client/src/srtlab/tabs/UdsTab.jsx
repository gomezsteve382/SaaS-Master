import React, { useState, useCallback, useRef } from 'react';
import {Card, Btn} from "../lib/ui.jsx";
import { RelayStatusBar, getSharedRelay } from '../relay/RelayStatusBar.jsx';
import { NRC_NAMES } from '../relay/relayClient.js';
import {C} from "../lib/constants.js";
import {initAdapter} from "../lib/initAdapter.js";
import {decodeNRC} from "../lib/nrc.js"; // kept for legacy call sites
import {
  getAllModules, getModuleDids, decodeNrc, buildSessionSequence,
  formatHex, buildReadDid, buildWriteDid, buildDsc, buildSeedRequest,
  COMMON_DIDS,
} from "../lib/udsEngine.js";
import {runDtcRead} from "../lib/dtc.js";
import DtcDetailPanel from "../lib/DtcDetailPanel.jsx";
import {getDidDescription} from "../lib/dids.js";
import {
  buildReadMemoryByAddress, parseReadMemoryResponse,
  buildWriteMemoryByAddress, parseWriteMemoryResponse,
  buildRoutineResult, parseRoutineResponse,
} from "../lib/uds.js";
import { build } from "@workspace/uds";
import RelatedCanUniversePanel from "../components/RelatedCanUniversePanel.jsx";
import {
  getDispatchFor,
  getRoutineIds,
  TIER1_DISPATCH_NOTE,
  TIER1_DISPATCH_SOURCE,
} from "../lib/tier1Dispatch.js";
import { ECU_PICKER_ROWS, ECU_CATALOG_CDA6, ECU_CATALOG_CDA6_META, findEcuPickerRow } from "../lib/ecuToCanIndex.js";

const UDS_CAN_FILTERS = [
  { category: "Protocols", subcategory: "UDS" },
  { category: "Protocols", subcategory: "ISO-TP" },
];

// MODULE_PRESETS: built live from udsEngine MODULE_REGISTRY (RE-verified CAN IDs).
// Static entries are kept as fallback for modules not yet in udsEngine.
const _UDS_MODS = getAllModules();
const MODULE_PRESETS = (() => {
  const out = {};
  // udsEngine RE-verified entries take precedence
  for (const m of _UDS_MODS) out[m.code] = { tx: m.tx, rx: m.rx, algo: m.algo, sgwRequired: m.sgwRequired };
  // Legacy entries not yet in udsEngine (kept for completeness)
  const legacy = {
    AMP:  { tx:0x7A0, rx:0x7A8 },
    BSM:  { tx:0x770, rx:0x778 },
    TPMS: { tx:0x752, rx:0x75A },
  };
  for (const [k,v] of Object.entries(legacy)) if (!out[k]) out[k] = v;
  return out;
})();

export default function UdsTab(){
  // ─── Relay state ──────────────────────────────────────────────────────────────
  const [relayCtx, setRelayCtx] = useState(null); // { relay, channelId } when live
  const [relayExecLog, setRelayExecLog] = useState([]);
  const [relayRunning, setRelayRunning] = useState(false);

  const addRelayLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setRelayExecLog(p => [...p.slice(-200), { ts, msg, type }]);
  }, []);

  const executeSequenceViaRelay = useCallback(async () => {
    if (!relayCtx) return;
    const { relay, channelId } = relayCtx;
    const tx = parseInt(String(txAddr).replace(/^0x/i, ''), 16);
    const steps = seqPreviewSteps;
    if (!steps.length) { addRelayLog('No steps to execute — select a module and operation first', 'warn'); return; }
    setRelayRunning(true);
    setRelayExecLog([]);
    addRelayLog(`Executing ${steps.length} steps on CH${channelId} TX:0x${tx.toString(16).toUpperCase()}`, 'info');
    try {
      const results = await relay.executeSequence(
        channelId,
        steps.map(s => ({
          label: s.label || s.desc || ('Step ' + (steps.indexOf(s) + 1)),
          canId: tx,
          bytes: s.bytes || [],
          timeoutMs: 200,
          noResp: s.noResp || false,
        })),
        {
          onStep: (step, result) => {
            if (result.ok) {
              const rxHex = result.responses.length
                ? result.responses.map(r => r.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')).join(' | ')
                : '(no response)';
              addRelayLog(`✓ ${step.label} → ${rxHex} [${result.durationMs}ms]`, 'rx');
            } else {
              const detail = result.nrcName ? `NRC ${result.nrcName} (0x${result.nrc.toString(16).toUpperCase()})` : (result.error || 'failed');
              addRelayLog(`✗ ${step.label} → ${detail}`, 'error');
            }
          },
          abortOnNrc: true,
        }
      );
      addRelayLog(`Sequence complete — ${results.length} steps OK`, 'info');
    } catch (e) {
      addRelayLog(`Sequence aborted: ${e.message}`, 'error');
    } finally {
      setRelayRunning(false);
    }
  }, [relayCtx, txAddr, seqPreviewSteps, addRelayLog]);

  const sendRawViaRelay = useCallback(async () => {
    if (!relayCtx) return;
    const { relay, channelId } = relayCtx;
    const tx = parseInt(String(txAddr).replace(/^0x/i, ''), 16);
    const bytes = hexToBytes(rawCmd);
    if (!bytes.length) { addRelayLog('Enter hex bytes', 'warn'); return; }
    setRelayRunning(true);
    addRelayLog(`TX [0x${tx.toString(16).toUpperCase()}] ${bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`, 'tx');
    try {
      const result = await relay.sendFrame({ channelId, canId: tx, bytes, timeoutMs: 200 });
      if (result.responses.length === 0) {
        addRelayLog('No response (timeout)', 'warn');
      } else {
        for (const r of result.responses) {
          const hex = r.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
          if (r.bytes[0] === 0x7F) {
            const nrcCode = r.bytes[2];
            const nrcName = NRC_NAMES[nrcCode] || `0x${nrcCode.toString(16).toUpperCase()}`;
            addRelayLog(`NRC ${nrcName}: ${hex}`, 'warn');
          } else {
            addRelayLog(`RX [0x${r.canId.toString(16).toUpperCase()}] ${hex}`, 'rx');
          }
        }
      }
    } catch (e) {
      addRelayLog(`Send failed: ${e.message}`, 'error');
    } finally {
      setRelayRunning(false);
    }
  }, [relayCtx, txAddr, rawCmd, addRelayLog]);

  const[conn,setConn]=useState(false);
  const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);
  const[txAddr,setTxAddr]=useState('0x750');
  const[rxAddr,setRxAddr]=useState('0x758');
  const[rawCmd,setRawCmd]=useState('');
  const[didHex,setDidHex]=useState('F190');
  const[writeDid,setWriteDid]=useState('F190');
  const[writeData,setWriteData]=useState('');
  const[session,setSession]=useState('03');
  const[routineCtrl,setRoutineCtrl]=useState('01');
  const[routineId,setRoutineId]=useState('0312');
  const[routineData,setRoutineData]=useState('');
  const[memAddr,setMemAddr]=useState('0x100');
  const[memLen,setMemLen]=useState('8');
  const[memData,setMemData]=useState('');
  const[selectedModule,setSelectedModule]=useState('BCM');
  const[dtcDetail,setDtcDetail]=useState(null);
  const[didCatalog,setDidCatalog]=useState(()=>getModuleDids('BCM'));
  const[didCatalogFilter,setDidCatalogFilter]=useState('');
  const[seqPreviewModule,setSeqPreviewModule]=useState('BCM');
  const[seqPreviewOp,setSeqPreviewOp]=useState('extended');
  const[seqPreviewOpen,setSeqPreviewOpen]=useState(false);
  const[nrcDecodeInput,setNrcDecodeInput]=useState('');
  const[nrcDecodeResult,setNrcDecodeResult]=useState(null);
  const eng=useRef(null);
  const allModsList = React.useMemo(()=>getAllModules(),[]);
  const filteredDidCatalog = React.useMemo(()=>{
    const q=didCatalogFilter.trim().toLowerCase();
    if(!q) return didCatalog;
    return didCatalog.filter(d=>
      d.name.toLowerCase().includes(q)||
      ('0x'+d.did.toString(16).toLowerCase()).includes(q)
    );
  },[didCatalog,didCatalogFilter]);
  const seqPreviewSteps = React.useMemo(()=>{
    try{return buildSessionSequence(seqPreviewModule,seqPreviewOp);}catch{return [];}
  },[seqPreviewModule,seqPreviewOp]);

  const addLog=useCallback((m,t='info',extra=null)=>{
    const ts=new Date().toLocaleTimeString();
    setLog(p=>[...p.slice(-400),{t:ts,m,type:t,...(extra||{})}]);
  },[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const hexToBytes=s=>{
    const clean=s.replace(/[^0-9a-fA-F]/g,'');
    const out=[];
    for(let i=0;i<clean.length;i+=2)out.push(parseInt(clean.substring(i,i+2),16));
    return out;
  };
  const parseAddr=s=>parseInt(String(s).replace(/^0x/i,''),16);

  // Paper-trail recording was removed at the user's request. The helper
  // is kept as a no-op so the existing call sites keep their no-throw
  // contract without needing surgery; the args are intentionally ignored.
  const recordPaper=useCallback((_operation,_extra)=>{},[]);

  const loadPreset=m=>{
    const p=MODULE_PRESETS[m];if(!p)return;
    setTxAddr('0x'+hx(p.tx,3));setRxAddr('0x'+hx(p.rx,3));setSelectedModule(m);
    addLog('Loaded preset: '+m+' TX:0x'+hx(p.tx,3)+' RX:0x'+hx(p.rx,3)+(p.sgwRequired?' [SGW required]':''),'info');
    // Surface the DID catalog for this module
    setDidCatalog(getModuleDids(m));
  };

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected','info');}
  },[addLog]);

  const sendRaw=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const bytes=hexToBytes(rawCmd);
    if(!bytes.length){addLog('Enter hex bytes','error');return;}
    setBusy('Sending...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    addLog('Raw: '+bytes.map(b=>hx(b)).join(' ')+' → TX 0x'+hx(tx,3),'info');
    const r=await eng.current.uds(tx,rx,bytes);
    let success=false;
    if(r.ok&&r.d){
      if(r.d[0]===0x7F){addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');}
      else{addLog('✓ OK','rx');success=true;}
    }else addLog('No response or error: '+(r.raw||'(timeout)'),'error');
    recordPaper('Raw UDS Send',{success,request:bytes.map(b=>hx(b)).join(' '),response:r.d?Array.from(r.d).map(b=>hx(b)).join(' '):''});
    setBusy('');
  },[txAddr,rxAddr,rawCmd,addLog,recordPaper]);

  const readDid=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const did=parseInt(didHex,16);
    const didDesc=getDidDescription(did);
    const didLabel='0x'+hx(did,4)+(didDesc?' ('+didDesc+')':'');
    setBusy('Reading DID '+didLabel+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.readDataByIdentifier({dids:[did]}));
    let success=false,asciiOut='';
    if(r.ok&&r.d){
      if(r.d[0]===0x62){
        const data=Array.from(r.d).slice(3);
        const ascii=data.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
        const hexOut=data.map(b=>hx(b)).join(' ');
        addLog('DID '+didLabel+' HEX: '+hexOut,'rx');
        if(ascii.length>=3){addLog('DID '+didLabel+' ASCII: '+ascii,'rx');asciiOut=ascii;}
        success=true;
      }else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    recordPaper('Read DID',{success,dids:[{did:'0x'+hx(did,4),value:asciiOut}]});
    setBusy('');
  },[didHex,txAddr,rxAddr,addLog,recordPaper]);

  const writeDidAction=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const did=parseInt(writeDid,16);
    const data=hexToBytes(writeData);
    if(!data.length){addLog('Enter data bytes','error');return;}
    const didDesc=getDidDescription(did);
    const didLabel='0x'+hx(did,4)+(didDesc?' ('+didDesc+')':'');
    setBusy('Writing DID '+didLabel+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.writeDataByIdentifier({did,data}));
    let success=false;
    if(r.ok&&r.d){
      if(r.d[0]===0x6E){addLog('✓ Written '+didLabel,'rx');success=true;}
      else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    recordPaper('Write DID',{success,dids:[{did:'0x'+hx(did,4),value:data.map(b=>hx(b)).join(' ')}]});
    setBusy('');
  },[writeDid,writeData,txAddr,rxAddr,addLog,recordPaper]);

  const startSession=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const s=parseInt(session,16);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.diagnosticSessionControl({session:s}));
    const success=!!(r.ok&&r.d&&r.d[0]===0x50);
    if(success)addLog('✓ Session 0x'+hx(s)+' active','rx');
    else addLog('Session failed','error');
    recordPaper('Diag Session',{success,request:'10 '+hx(s)});
  },[session,txAddr,rxAddr,addLog,recordPaper]);

  const testerPresent=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.testerPresent());
    const success=!!(r.ok&&r.d&&r.d[0]===0x7E);
    if(success)addLog('✓ Module alive','rx');
    else addLog('No TesterPresent response','warn');
    recordPaper('Tester Present',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const readMemory=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const addr=parseAddr(memAddr);
    const len=parseInt(String(memLen).replace(/^0x/i,''),/0x/i.test(memLen)?16:10);
    if(!Number.isFinite(addr)||!Number.isFinite(len)||len<=0){addLog('Memory: bad address or length','error');return;}
    setBusy('ReadMemory 0x'+hx(addr,8)+'/'+len+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const cmd=buildReadMemoryByAddress(addr>>>0,len>>>0);
    addLog('ReadMemoryByAddress: '+cmd.map(b=>hx(b)).join(' '),'info');
    const r=await eng.current.uds(tx,rx,cmd);
    let success=false;
    if(r.ok&&r.d){
      const parsed=parseReadMemoryResponse(r.d);
      if(parsed.ok){
        const hexOut=parsed.data.map(b=>hx(b)).join(' ');
        const ascii=parsed.data.map(b=>(b>=0x20&&b<=0x7E)?String.fromCharCode(b):'.').join('');
        addLog('Memory @0x'+hx(addr,8)+' HEX: '+hexOut,'rx');
        addLog('Memory @0x'+hx(addr,8)+' ASCII: '+ascii,'rx');
        success=true;
      }else if(parsed.nrc!=null) addLog('NRC: '+decodeNRC(parsed.nrc),'warn');
      else addLog('Unexpected reply: '+Array.from(r.d).map(b=>hx(b)).join(' '),'error');
    }else addLog('No response','error');
    recordPaper('Read Memory',{success,request:cmd.map(b=>hx(b)).join(' ')});
    setBusy('');
  },[memAddr,memLen,txAddr,rxAddr,addLog,recordPaper]);

  const writeMemory=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const addr=parseAddr(memAddr);
    const data=hexToBytes(memData);
    if(!Number.isFinite(addr)){addLog('Memory: bad address','error');return;}
    if(!data.length){addLog('Memory: enter data bytes (hex)','error');return;}
    /* WriteMemoryByAddress is a destructive write — gate it behind an
       explicit confirm() so a mis-typed address (or a stray paste into
       the data box) can't silently overwrite an EEPROM byte. */
    const ok=window.confirm(
      'WriteMemoryByAddress 0x3D — DESTRUCTIVE\n\n'+
      'Address: 0x'+hx(addr,8)+'\n'+
      'Length: '+data.length+' byte(s)\n'+
      'Data: '+data.map(b=>hx(b)).join(' ')+'\n\n'+
      'Continue?'
    );
    if(!ok){addLog('WriteMemory cancelled by user','warn');return;}
    setBusy('WriteMemory 0x'+hx(addr,8)+'/'+data.length+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const cmd=buildWriteMemoryByAddress(addr>>>0,data);
    addLog('WriteMemoryByAddress: '+cmd.map(b=>hx(b)).join(' '),'info');
    const r=await eng.current.uds(tx,rx,cmd);
    let success=false;
    if(r.ok&&r.d){
      const parsed=parseWriteMemoryResponse(r.d);
      if(parsed.ok){addLog('✓ Wrote '+data.length+' byte(s) @0x'+hx(addr,8),'rx');success=true;}
      else if(parsed.nrc!=null) addLog('NRC: '+decodeNRC(parsed.nrc),'warn');
      else addLog('Unexpected reply: '+Array.from(r.d).map(b=>hx(b)).join(' '),'error');
    }else addLog('No response','error');
    recordPaper('Write Memory',{success,request:cmd.map(b=>hx(b)).join(' ')});
    setBusy('');
  },[memAddr,memData,txAddr,rxAddr,addLog,recordPaper]);

  const routineGetResult=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const rid=parseInt(routineId,16);
    if(!Number.isFinite(rid)){addLog('Routine: bad routine id','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    setBusy('Routine 0x'+hx(rid,4)+' result...');
    const cmd=buildRoutineResult(rid);
    addLog('Routine Get Result: '+cmd.map(b=>hx(b)).join(' '),'info');
    const r=await eng.current.uds(tx,rx,cmd);
    let success=false;
    if(r.ok&&r.d){
      const parsed=parseRoutineResponse(r.d);
      if(parsed.ok){
        const status=parsed.statusRecord.length?parsed.statusRecord.map(b=>hx(b)).join(' '):'(empty)';
        addLog('✓ Routine 0x'+hx(parsed.rid,4)+' result: '+status,'rx');
        success=true;
      }else if(parsed.nrc!=null) addLog('NRC: '+decodeNRC(parsed.nrc),'warn');
      else addLog('Unexpected reply: '+Array.from(r.d).map(b=>hx(b)).join(' '),'error');
    }else addLog('No response','error');
    recordPaper('Routine Get Result',{success,request:cmd.map(b=>hx(b)).join(' ')});
    setBusy('');
  },[routineId,txAddr,rxAddr,addLog,recordPaper]);

  const routine=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const ctrl=parseInt(routineCtrl,16);
    const rid=parseInt(routineId,16);
    const data=hexToBytes(routineData);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    setBusy('Routine...');
    const cmd=Array.from(build.routineControl({type:ctrl,routineIdentifier:rid,routineOptionRecord:data}));
    addLog('Routine: '+cmd.map(b=>hx(b)).join(' '),'info');
    const r=await eng.current.uds(tx,rx,cmd);
    let success=false;
    if(r.ok&&r.d){
      if(r.d[0]===0x71){addLog('✓ Routine OK: '+Array.from(r.d).map(b=>hx(b)).join(' '),'rx');success=true;}
      else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    recordPaper('Routine Control',{success,request:cmd.map(b=>hx(b)).join(' ')});
    setBusy('');
  },[routineCtrl,routineId,routineData,txAddr,rxAddr,addLog,recordPaper]);

  const readDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    /* runDtcRead lives in ../lib/dtc.js so the same flow is unit-
       tested with a mocked engine (see DtcDetailPanel.test.jsx).
       AdcmTab and JailbreakTab share the underlying helpers. */
    const {ok,codes}=await runDtcRead({engine:eng.current,addLog,txAddr:tx,rxAddr:rx});
    /* Audit record contract is preserved: structured log row keeps
       just the hex codes, full details live on the in-memory log
       row only. Historical paper-trail diffs stay stable. */
    recordPaper('Read DTCs',{success:ok,dtcs:codes});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const clearDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.clearDiagnosticInformation());
    const success=!!(r.ok&&r.d&&r.d[0]===0x54);
    if(success)addLog('✓ DTCs cleared','rx');
    else addLog('Clear failed','error');
    recordPaper('Clear DTCs',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const reset=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,build.ecuReset({resetType:'hardReset'}));
    const success=!!(r.ok&&r.d&&r.d[0]===0x51);
    if(success)addLog('✓ ECU reset','rx');
    else addLog('Reset failed','warn');
    recordPaper('ECU Reset',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  return <div data-testid="uds-tab">
    {/* ─── J2534 Relay Status Bar ─────────────────────────────────────────────── */}
    <RelayStatusBar onRelayReady={ctx => setRelayCtx(ctx)} />
    <Card style={{background:'linear-gradient(135deg,#EDE7F6 0%,#D1C4E9 40%,#B39DDB 100%)',color:'#1A1A1A',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔬</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2,color:'#4A148C'}}>UDS PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.9,letterSpacing:3,fontWeight:700,color:'#6A1B9A'}}>UNIVERSAL · RAW COMMANDS · ANY MODULE</div>
        </div>
        <div data-testid="uds-conn-status" style={{fontSize:11,padding:'6px 12px',background:conn?'#00C85322':'#FF174422',borderRadius:8,border:'1px solid '+(conn?'#00C853':'#FF1744'),color:conn?'#1B5E20':'#B71C1C',fontWeight:700}}>
          {conn?'● CONNECTED':'○ DISCONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>📡 MODULE PRESETS</div>
      <div data-testid="uds-presets" style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
        {Object.keys(MODULE_PRESETS).map(m=>(
          <button key={m} data-testid={'uds-preset-'+m} onClick={()=>loadPreset(m)} style={{padding:'6px 10px',fontSize:10,fontWeight:800,borderRadius:6,border:'1.5px solid '+(selectedModule===m?C.a4:C.bd),background:selectedModule===m?C.a4+'15':'#fff',color:selectedModule===m?C.a4:C.ts,cursor:'pointer'}}>{m}</button>
        ))}
      </div>
      <EcuPicker
        onPick={(row)=>{
          setTxAddr('0x'+hx(row.requestId,3));
          setRxAddr('0x'+hx(row.responseId,3));
          addLog(
            'Auto-filled CAN IDs from AlfaOBD intel: '+row.label+
            ' TX:0x'+hx(row.requestId,3)+' RX:0x'+hx(row.responseId,3)+
            (row.isLegacyMultiBus?' (legacy multi-bus entry)':''),
            'info'
          );
        }}
      />
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:10,alignItems:'end'}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>TX ADDRESS</div>
          <input data-testid="uds-tx" value={txAddr} onChange={e=>setTxAddr(e.target.value)} style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>RX ADDRESS</div>
          <input data-testid="uds-rx" value={rxAddr} onChange={e=>setRxAddr(e.target.value)} style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        {!conn&&<Btn onClick={connect} color={C.a4}>🔌 Connect</Btn>}
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>⚡ RAW UDS COMMAND</div>
      <div style={{display:'flex',gap:10,alignItems:'end'}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>HEX BYTES (e.g. 22 F1 90 or 22F190)</div>
          <input data-testid="uds-raw-input" value={rawCmd} onChange={e=>setRawCmd(e.target.value)} placeholder="22 F1 90" style={{width:'100%',padding:10,fontFamily:"'JetBrains Mono'",fontSize:14,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <Btn onClick={sendRaw} disabled={!!busy||!conn} color={C.a4}>▶ Send</Btn>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>🎛️ QUICK OPERATIONS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>READ DID (0x22)</div>
          <div style={{display:'flex',gap:6}}>
            <input value={didHex} onChange={e=>setDidHex(e.target.value)} placeholder="F190" style={{flex:1,padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
            <Btn onClick={readDid} disabled={!!busy||!conn} color={C.a2}>Read</Btn>
          </div>
          {(() => { const d=getDidDescription(didHex); return d ? (
            <div data-testid="uds-read-did-label" style={{marginTop:4,fontSize:10,color:C.tm,fontStyle:'italic'}}>{d}</div>
          ) : null; })()}
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>WRITE DID (0x2E)</div>
          <div style={{display:'flex',gap:6,marginBottom:6}}>
            <input value={writeDid} onChange={e=>setWriteDid(e.target.value)} placeholder="F190" style={{flex:1,padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
            <Btn onClick={writeDidAction} disabled={!!busy||!conn} color={C.sr}>Write</Btn>
          </div>
          <input value={writeData} onChange={e=>setWriteData(e.target.value)} placeholder="data bytes (hex)" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
          {(() => { const d=getDidDescription(writeDid); return d ? (
            <div data-testid="uds-write-did-label" style={{marginTop:4,fontSize:10,color:C.tm,fontStyle:'italic'}}>{d}</div>
          ) : null; })()}
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>DIAG SESSION (0x10)</div>
          <div style={{display:'flex',gap:6}}>
            <select value={session} onChange={e=>setSession(e.target.value)} style={{flex:1,padding:8,fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}>
              <option value="01">01 - Default</option>
              <option value="02">02 - Programming</option>
              <option value="03">03 - Extended</option>
              <option value="04">04 - Safety</option>
            </select>
            <Btn onClick={startSession} disabled={!!busy||!conn} color={C.a3}>Enter</Btn>
          </div>
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>SESSION CONTROL</div>
          <div style={{display:'flex',gap:6}}>
            <Btn onClick={testerPresent} disabled={!!busy||!conn} color={C.gn} outline>🟢 Tester Present</Btn>
            <Btn onClick={reset} disabled={!!busy||!conn} color={C.er} outline>⚡ Reset (11 01)</Btn>
          </div>
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>🔧 ROUTINE CONTROL (0x31)</div>
      <div style={{display:'grid',gridTemplateColumns:'auto 1fr 1fr auto',gap:8,alignItems:'end'}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>CONTROL</div>
          <select value={routineCtrl} onChange={e=>setRoutineCtrl(e.target.value)} style={{padding:8,fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}>
            <option value="01">01 Start</option>
            <option value="02">02 Stop</option>
            <option value="03">03 Results</option>
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>ROUTINE ID</div>
          <input value={routineId} onChange={e=>setRoutineId(e.target.value)} placeholder="0312" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>DATA (optional)</div>
          <input value={routineData} onChange={e=>setRoutineData(e.target.value)} placeholder="hex" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <Btn onClick={routine} disabled={!!busy||!conn} color={C.a4}>Execute</Btn>
        <Btn data-testid="uds-routine-result" onClick={routineGetResult} disabled={!!busy||!conn} color={C.a3} outline>📊 Get Result</Btn>
      </div>
    </Card>

    <Tier1ApplicabilityCard routineId={routineId}/>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>🧠 MEMORY BY ADDRESS (0x23 / 0x3D)</div>
      <div style={{fontSize:10,color:C.tm,marginBottom:8,fontStyle:'italic'}}>
        AEMT EEPROM offsets reachable directly: 0x100, 0x108, 0x220, 0x230, 0x240, 0x510, 0x518. ALFID fixed at 0x44 (4-byte addr + 4-byte length). Writes ask before sending.
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>ADDRESS (hex)</div>
          <input data-testid="uds-mem-addr" value={memAddr} onChange={e=>setMemAddr(e.target.value)} placeholder="0x100" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>LENGTH (decimal or 0x…)</div>
          <input data-testid="uds-mem-len" value={memLen} onChange={e=>setMemLen(e.target.value)} placeholder="8" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'end'}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>WRITE DATA (hex bytes — only used by Write)</div>
          <input data-testid="uds-mem-data" value={memData} onChange={e=>setMemData(e.target.value)} placeholder="DE AD BE EF" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
        </div>
        <Btn data-testid="uds-mem-read" onClick={readMemory} disabled={!!busy||!conn} color={C.a2}>📖 Read</Btn>
        <Btn data-testid="uds-mem-write" onClick={writeMemory} disabled={!!busy||!conn} color={C.sr}>✍️ Write…</Btn>
      </div>
    </Card>

    <RelatedCanUniversePanel panelId="uds" filters={UDS_CAN_FILTERS} />

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>⚠️ DIAGNOSTICS</div>
      <div style={{display:'flex',gap:8}}>
        <Btn onClick={readDtcs} disabled={!!busy||!conn} color={C.a3} outline>📋 Read DTCs (19 02 08)</Btn>
        <Btn onClick={clearDtcs} disabled={!!busy||!conn} color={C.wn} outline>🗑️ Clear DTCs (14 FF FF FF)</Btn>
      </div>
    </Card>

    {/* ────────────────────────────────────────────────────────────────────────────────
         DID CATALOG (udsEngine RE-verified DIDs for selected module)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginBottom:14}} data-testid="uds-did-catalog">
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:8,letterSpacing:2}}>📖 DID CATALOG — {selectedModule}</div>
      <div style={{fontSize:10,color:C.ts,marginBottom:8}}>
        {didCatalog.length} DIDs for <b>{selectedModule}</b> (COMMON + module-specific). Click any row to pre-fill the Read DID field.
      </div>
      <input
        value={didCatalogFilter}
        onChange={e=>setDidCatalogFilter(e.target.value)}
        placeholder="Filter DIDs by name or hex…"
        style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid '+C.bd,background:'#fff',fontSize:11,marginBottom:8,boxSizing:'border-box'}}
      />
      <div style={{maxHeight:240,overflow:'auto',border:'1px solid '+C.bd,borderRadius:8,background:C.c2}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:10}}>
          <thead style={{position:'sticky',top:0,background:C.c2,borderBottom:'1px solid '+C.bd}}>
            <tr>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>DID</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>NAME</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>R/W</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>SEC</th>
            </tr>
          </thead>
          <tbody>
            {filteredDidCatalog.map(d=>(
              <tr key={d.did}
                onClick={()=>{
                  setDidHex(d.did.toString(16).toUpperCase().padStart(4,'0'));
                  if(d.rw==='RW'||d.rw==='W') setWriteDid(d.did.toString(16).toUpperCase().padStart(4,'0'));
                }}
                style={{borderTop:'1px solid '+C.bd+'60',cursor:'pointer'}}
                onMouseEnter={e=>e.currentTarget.style.background='#0000000A'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <td style={{padding:'4px 10px',color:C.a3,fontWeight:800}}>0x{d.did.toString(16).toUpperCase().padStart(4,'0')}</td>
                <td style={{padding:'4px 10px',color:C.tx,fontFamily:"'Nunito'",fontSize:10}}>{d.name}</td>
                <td style={{padding:'4px 10px',color:d.rw==='RW'?C.a4:d.rw==='W'?C.sr:C.tm,fontWeight:700}}>{d.rw||'R'}</td>
                <td style={{padding:'4px 10px',color:d.secLevel!=null?C.wn:C.tm}}>{d.secLevel!=null?'0x'+d.secLevel.toString(16).toUpperCase():'open'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>

    {/* ────────────────────────────────────────────────────────────────────────────────
         RELAY LIVE EXECUTION (when relay is connected)
    ──────────────────────────────────────────────────────────────────────────────── */}
    {relayCtx && (
      <Card style={{marginBottom:14,border:'2px solid #22c55e',background:'#F0FDF4'}} data-testid="uds-relay-exec">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
          <div style={{fontWeight:800,fontSize:11,color:'#15803d',letterSpacing:2}}>⚡ LIVE EXECUTION — CH{relayCtx.channelId}</div>
          <div style={{display:'flex',gap:8}}>
            <button
              onClick={sendRawViaRelay}
              disabled={relayRunning || !rawCmd.trim()}
              style={{
                background: relayRunning ? '#dcfce7' : '#bbf7d0',
                border: '1px solid #22c55e', color: '#15803d',
                borderRadius: 4, padding: '4px 14px', cursor: relayRunning ? 'not-allowed' : 'pointer',
                fontSize: 11, fontFamily: "'JetBrains Mono'", opacity: relayRunning ? 0.5 : 1,
              }}
            >
              ▶ Send Raw
            </button>
            <button
              onClick={executeSequenceViaRelay}
              disabled={relayRunning || seqPreviewSteps.length === 0}
              style={{
                background: relayRunning ? '#dcfce7' : '#86efac',
                border: '1px solid #16a34a', color: '#166534',
                borderRadius: 4, padding: '4px 14px', cursor: relayRunning ? 'not-allowed' : 'pointer',
                fontSize: 11, fontFamily: "'JetBrains Mono'", fontWeight: 700,
                opacity: relayRunning ? 0.5 : 1,
              }}
            >
              {relayRunning ? '⏳ Running…' : `▶▶ Execute Sequence (${seqPreviewSteps.length} steps)`}
            </button>
            <button
              onClick={() => setRelayExecLog([])}
              style={{
                background: 'transparent', border: '1px solid '+C.bd,
                color: C.ts, borderRadius: 4, padding: '4px 10px',
                cursor: 'pointer', fontSize: 10,
              }}
            >
              Clear
            </button>
          </div>
        </div>
        <div style={{
          maxHeight: 280, overflowY: 'auto', background: '#fff',
          border: '1px solid '+C.bd, borderRadius: 6, padding: '8px 12px',
          fontFamily: "'JetBrains Mono'", fontSize: 11, lineHeight: 1.7,
        }}>
          {relayExecLog.length === 0 && (
            <div style={{color:C.tm,textAlign:'center',padding:16}}>
              Ready — press Execute Sequence or Send Raw to fire live frames
            </div>
          )}
          {relayExecLog.map((l, i) => {
            const color = l.type === 'error' ? '#D32F2F' : l.type === 'rx' ? '#2E7D32' : l.type === 'tx' ? '#1565C0' : l.type === 'warn' ? '#E65100' : '#5A5A5A';
            return (
              <div key={i} style={{color}}>
                <span style={{color:'#888'}}>{l.ts}</span> {l.msg}
              </div>
            );
          })}
        </div>
      </Card>
    )}

    {/* ────────────────────────────────────────────────────────────────────────────────
         SESSION SEQUENCE PREVIEW (udsEngine buildSessionSequence)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginBottom:14}} data-testid="uds-session-seq">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a4,letterSpacing:2}}>🔄 SESSION SEQUENCE PREVIEW</div>
        <button onClick={()=>setSeqPreviewOpen(o=>!o)} style={{fontSize:10,color:C.ts,background:'transparent',border:'1px solid '+C.bd,padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>
          {seqPreviewOpen?'▲ Collapse':'▼ Expand'}
        </button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>MODULE</div>
          <select value={seqPreviewModule} onChange={e=>setSeqPreviewModule(e.target.value)}
            style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid '+C.bd,background:'#fff',fontSize:11}}>
            {allModsList.map(m=><option key={m.code} value={m.code}>{m.code} — {m.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>OPERATION</div>
          <select value={seqPreviewOp} onChange={e=>setSeqPreviewOp(e.target.value)}
            style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid '+C.bd,background:'#fff',fontSize:11}}>
            <option value="extended">Extended Diagnostic</option>
            <option value="programming">Programming</option>
            <option value="vin">VIN Write</option>
            <option value="bodycode">Body Code Swap (IPC)</option>
          </select>
        </div>
      </div>
      {seqPreviewOpen&&<div style={{border:'1px solid '+C.bd,borderRadius:8,background:'#F4F1EC',padding:12}}>
        {seqPreviewSteps.length===0&&<div style={{color:C.tm,fontSize:11,textAlign:'center',padding:12}}>No steps for this combination.</div>}
        {seqPreviewSteps.map((step,i)=>(
          <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'5px 0',borderTop:i>0?'1px solid '+C.bd:'none'}}>
            <span style={{color:C.tm,fontSize:10,minWidth:20,textAlign:'right',paddingTop:1}}>{i+1}</span>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:'#1565C0',letterSpacing:1}}>
                {step.bytes?step.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '):step.label}
              </div>
              {step.desc&&<div style={{fontSize:10,color:C.ts,marginTop:2}}>{step.desc}</div>}
            </div>
          </div>
        ))}
      </div>}
      {!seqPreviewOpen&&<div style={{fontSize:10,color:C.ts,fontStyle:'italic'}}>{seqPreviewSteps.length} steps — expand to view</div>}
    </Card>

    {/* ────────────────────────────────────────────────────────────────────────────────
         NRC DECODER (udsEngine)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginBottom:14}} data-testid="uds-nrc-decoder">
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:8,letterSpacing:2}}>🔴 NRC DECODER</div>
      <div style={{display:'flex',gap:8,alignItems:'flex-end',marginBottom:8}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>NRC BYTE (hex, e.g. 35)</div>
          <input
            value={nrcDecodeInput}
            onChange={e=>setNrcDecodeInput(e.target.value.toUpperCase().replace(/[^A-F0-9Xx]/g,''))}
            onKeyDown={e=>{if(e.key==='Enter'){const c=parseInt(nrcDecodeInput.replace(/^0x/i,''),16);if(!isNaN(c))setNrcDecodeResult(decodeNrc(c&0xFF));}}}
            placeholder="35"
            style={{width:'100%',padding:'8px 10px',borderRadius:6,border:'1px solid '+C.bd,background:'#fff',fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:4,textAlign:'center'}}
          />
        </div>
        <Btn onClick={()=>{const c=parseInt(nrcDecodeInput.replace(/^0x/i,''),16);if(!isNaN(c))setNrcDecodeResult(decodeNrc(c&0xFF));}} disabled={!nrcDecodeInput.trim()}>Decode</Btn>
      </div>
      {nrcDecodeResult&&<div style={{padding:12,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
        <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:4}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.sr}}>0x{nrcDecodeInput.replace(/^0x/i,'').padStart(2,'0').toUpperCase()}</span>
          <span style={{fontSize:12,fontWeight:800}}>{nrcDecodeResult.name}</span>
        </div>
        <div style={{fontSize:11,color:C.ts}}>{nrcDecodeResult.desc}</div>
      </div>}
    </Card>

    <Card style={{background:'#F4F1EC',color:'#1A1A1A'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:C.a4,letterSpacing:2}}>📋 LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:C.ts,background:'transparent',border:'1px solid '+C.bd,padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div data-testid="uds-log" style={{maxHeight:380,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:C.tm,textAlign:'center',padding:20}}>Ready — send a command to begin</div>}
        {log.map((l,i)=>{
          const color=l.type==='error'?'#D32F2F':l.type==='rx'?'#2E7D32':l.type==='tx'?'#1565C0':l.type==='warn'?'#E65100':'#5A5A5A';
          if(l.dtc){
            const isOpen=dtcDetail&&dtcDetail._row===i;
            return <div key={i}>
              <div data-testid={'uds-log-dtc-'+l.dtc.code} onClick={()=>setDtcDetail(isOpen?null:{...l.dtc,_row:i})}
                style={{color,cursor:'pointer',userSelect:'none'}} title="Click for details">
                <span style={{color:'#888'}}>{l.t}</span> {l.m} <span style={{color:C.tm}}>{isOpen?'▾':'▸'}</span>
              </div>
              {isOpen&&<DtcDetailPanel detail={l.dtc}/>}
            </div>;
          }
          return <div key={i} style={{color}}>
            <span style={{color:'#888'}}>{l.t}</span> {l.m}
          </div>;
        })}
      </div>
    </Card>
  </div>;
}

function EcuPicker({onPick}){
  const [q,setQ]=useState('');
  const [open,setOpen]=useState(false);
  const [showCda6,setShowCda6]=useState(false);
  const [cda6MatchToast,setCda6MatchToast]=useState(null); // {msg, ok}
  const rows=ECU_PICKER_ROWS;
  const filtered=q.trim()
    ?rows.filter(r=>{
       const lq=q.toLowerCase();
       return r.label.toLowerCase().includes(lq)
         ||('0x'+r.requestId.toString(16)).toLowerCase().includes(lq)
         ||('0x'+r.responseId.toString(16)).toLowerCase().includes(lq);
     })
    :rows;
  const visible=filtered.slice(0,120);
  // CDA6 catalog search (name/acronym only — no CAN IDs)
  const cda6Filtered=q.trim()
    ?ECU_CATALOG_CDA6.filter(e=>{
       const lq=q.toLowerCase();
       return e.name.toLowerCase().includes(lq)||(e.acronym||'').toLowerCase().includes(lq)||(e.protocol||'').toLowerCase().includes(lq);
     })
    :ECU_CATALOG_CDA6;
  const cda6Visible=cda6Filtered.slice(0,80);

  // When a CDA6 entry is clicked, try to find a matching AlfaOBD row by acronym or name.
  // Try: exact acronym → name prefix → base acronym (strip _VB/_PN/_FGA etc.)
  const handleCda6Pick = React.useCallback((entry) => {
    const acronym = entry.acronym || '';
    const name = entry.name || '';
    // 1. Exact acronym match
    let match = findEcuPickerRow(acronym);
    // 2. Exact name match
    if (!match) match = findEcuPickerRow(name);
    // 3. Base acronym (strip suffix like _VB, _PN, _FGA, _CUSW, _MSRT, _CMN, _MZD, _KLINE)
    if (!match) {
      const base = acronym.replace(/[_-](VB|PN|FGA|CUSW|MSRT|CMN|MZD|KLINE|PN2|SUP\d*)$/i, '');
      if (base !== acronym) match = findEcuPickerRow(base);
    }
    // 4. First word of name
    if (!match) {
      const firstWord = name.split(/[\s/\-_]/)[0];
      if (firstWord && firstWord.length >= 2) match = findEcuPickerRow(firstWord);
    }
    if (match) {
      onPick(match);
      setQ(match.label);
      const msg = `✓ Matched "${acronym}" → ${match.label} · TX 0x${match.requestId.toString(16).toUpperCase().padStart(3,'0')} RX 0x${match.responseId.toString(16).toUpperCase().padStart(3,'0')}`;
      setCda6MatchToast({msg, ok: true});
      setTimeout(()=>setCda6MatchToast(null), 4000);
    } else {
      const msg = `⚠ No CAN ID match for "${acronym}" (${name}) in AlfaOBD table — set TX/RX manually`;
      setCda6MatchToast({msg, ok: false});
      setTimeout(()=>setCda6MatchToast(null), 5000);
    }
  }, [onPick]);

  return <div style={{marginBottom:10,position:'relative'}}>
    <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:6,flexWrap:'wrap'}}>
      <div style={{fontSize:10,color:C.ts,fontWeight:700,letterSpacing:1}}>ECU PICKER (auto-fill TX/RX)</div>
      <span data-testid="uds-ecu-picker-provenance" title="Mapping derived from AlfaOBD.exe IL — verify on bench before trusting unfamiliar entries."
        style={{fontSize:9,fontWeight:800,letterSpacing:1,padding:'2px 7px',borderRadius:99,background:'#FFF8E1',color:'#5D4037',border:'1px solid #FFD54F'}}>
        from AlfaOBD intel (unverified)
      </span>
      <button onClick={()=>setShowCda6(v=>!v)}
        style={{fontSize:9,fontWeight:800,letterSpacing:1,padding:'2px 7px',borderRadius:99,background:showCda6?'#E8F5E9':'#F3E5F5',color:showCda6?'#1B5E20':'#4A148C',border:'1px solid '+(showCda6?'#A5D6A7':'#CE93D8'),cursor:'pointer'}}>
        {showCda6?'HIDE':'SHOW'} CDA6 CATALOG ({ECU_CATALOG_CDA6_META.ecuCount})
      </button>
    </div>
    <input
      data-testid="uds-ecu-picker-input"
      value={q}
      onChange={e=>{setQ(e.target.value);setOpen(true);}}
      onFocus={()=>setOpen(true)}
      onBlur={()=>setTimeout(()=>setOpen(false),150)}
      placeholder={`Search ${rows.length} AlfaOBD ECUs${showCda6?' + '+ECU_CATALOG_CDA6_META.ecuCount+' CDA6 modules':''}…`}
      style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:12,border:'1px solid '+C.bd,borderRadius:6,background:'#fff'}}
    />
    {open&&visible.length>0&&<div data-testid="uds-ecu-picker-list" style={{position:'absolute',zIndex:10,top:'100%',left:0,right:0,marginTop:2,background:'#fff',border:'1px solid '+C.bd,borderRadius:6,maxHeight:300,overflowY:'auto',boxShadow:'0 4px 16px rgba(0,0,0,0.10)'}}>
      {visible.map((r,i)=>(
        <div key={i}
          data-testid={'uds-ecu-picker-row-'+i}
          onMouseDown={(e)=>{e.preventDefault();onPick(r);setQ(r.label);setOpen(false);}}
          style={{padding:'6px 10px',cursor:'pointer',borderBottom:'1px solid #F0F0F0',display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}}
          onMouseEnter={e=>e.currentTarget.style.background='#F5F0FF'}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
          <span style={{fontSize:11,fontFamily:r.isNumericInternalId?"'JetBrains Mono'":"'Nunito'",color:r.isNumericInternalId?C.ts:C.tx,fontWeight:r.isNumericInternalId?400:700}}>
            {r.label}
          </span>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:'#6A1B9A',whiteSpace:'nowrap'}}>
            TX 0x{r.requestId.toString(16).toUpperCase().padStart(3,'0')} · RX 0x{r.responseId.toString(16).toUpperCase().padStart(3,'0')}
          </span>
        </div>
      ))}
      {filtered.length>visible.length&&<div style={{padding:'6px 10px',fontSize:10,color:C.tm,fontStyle:'italic'}}>
        {filtered.length-visible.length} more — refine the search to narrow down.
      </div>}
    </div>}
    {showCda6&&<div style={{marginTop:8,border:'1px solid #CE93D8',borderRadius:6,background:'#FAF5FF'}}>
      <div style={{padding:'6px 10px',fontSize:10,fontWeight:700,color:'#4A148C',letterSpacing:1,borderBottom:'1px solid #E1BEE7',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:4}}>
        <span>CDA6 MODULE CATALOG — {ECU_CATALOG_CDA6_META.ecuCount} modules · {ECU_CATALOG_CDA6_META.protocolCount} protocols</span>
        <span style={{fontWeight:400,color:'#7B1FA2',fontSize:9}}>👇 Click any row to auto-match TX/RX from AlfaOBD table</span>
      </div>
      {cda6MatchToast&&<div data-testid="uds-cda6-match-toast" style={{
        padding:'7px 12px',fontSize:11,fontFamily:"'JetBrains Mono'",fontWeight:600,
        background:cda6MatchToast.ok?'#E8F5E9':'#FFF8E1',
        color:cda6MatchToast.ok?'#1B5E20':'#E65100',
        borderBottom:'1px solid '+(cda6MatchToast.ok?'#A5D6A7':'#FFD54F'),
        transition:'opacity 0.3s',
      }}>{cda6MatchToast.msg}</div>}
      <div style={{maxHeight:220,overflowY:'auto'}}>
        {cda6Visible.map((e,i)=>(
          <div key={i}
            data-testid={'uds-cda6-row-'+i}
            onClick={()=>handleCda6Pick(e)}
            style={{padding:'5px 10px',borderBottom:'1px solid #F3E5F5',display:'flex',gap:8,alignItems:'center',fontSize:10,cursor:'pointer',userSelect:'none'}}
            onMouseEnter={ev=>ev.currentTarget.style.background='#EDE7F6'}
            onMouseLeave={ev=>ev.currentTarget.style.background='transparent'}>
            <span style={{fontWeight:700,color:'#4A148C',minWidth:80,fontFamily:"'JetBrains Mono'"}}>{e.acronym||e.name}</span>
            <span style={{color:'#555',flex:1}}>{e.name}</span>
            {e.protocol&&<span style={{background:'#EDE7F6',color:'#512DA8',padding:'1px 5px',borderRadius:3,fontSize:9,fontWeight:700}}>{e.protocol}</span>}
            {e.transport&&<span style={{background:'#E3F2FD',color:'#0D47A1',padding:'1px 5px',borderRadius:3,fontSize:9}}>{e.transport}</span>}
            {e.use29bit&&<span style={{background:'#FFF3E0',color:'#E65100',padding:'1px 5px',borderRadius:3,fontSize:9}}>29-bit</span>}
            <span style={{fontSize:9,color:'#CE93D8',marginLeft:'auto',flexShrink:0}}>click to match →</span>
          </div>
        ))}
        {cda6Filtered.length>cda6Visible.length&&<div style={{padding:'4px 10px',fontSize:10,color:C.tm,fontStyle:'italic'}}>
          {cda6Filtered.length-cda6Visible.length} more — type to filter.
        </div>}
      </div>
    </div>}
  </div>;
}

function Tier1ApplicabilityCard({routineId}){
  const ridInt = parseInt(routineId,16);
  const d = Number.isFinite(ridInt) ? getDispatchFor(ridInt) : null;
  const knownIds = getRoutineIds();
  return <Card style={{marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:6,letterSpacing:2}}>
      🔎 ROUTINE APPLICABILITY (read-only)
    </div>
    <div style={{fontSize:10,color:C.tm,marginBottom:8,fontStyle:'italic'}}>
      Tier-1 lookup for the routine ID above (decimal). Source: {TIER1_DISPATCH_SOURCE}.
      <br/>{TIER1_DISPATCH_NOTE}
    </div>
    {!d && <div style={{fontSize:11,color:C.ts}}>Enter a valid hex routine ID above to look up applicability.</div>}
    {d && !d.known && <div style={{fontSize:11,color:C.ts}}>
      Routine {ridInt} (0x{ridInt.toString(16).toUpperCase()}) is not in the Tier-1 table.
      Known IDs: {knownIds.join(", ")}.
    </div>}
    {d && d.known && d.computed && <div style={{fontSize:11,color:C.wn}}>
      Routine {ridInt}: dispatch is computed at runtime in AlfaOBD — no inline metadata available.
      Bench verification required before assuming any (ECU, session, security) combination.
    </div>}
    {d && d.known && !d.computed && <div>
      <div style={{fontSize:11,marginBottom:8,color:C.tm}}>
        Routine {ridInt} (0x{ridInt.toString(16).toUpperCase()}): {d.records.length} dispatch record(s)
      </div>
      {d.records.map((r,i)=>(
        <div key={i} style={{border:'1px solid '+C.bd,borderRadius:6,padding:10,marginBottom:8}}>
          <div style={{fontWeight:700,fontSize:12,marginBottom:6}}>
            {r.ecuDisplay}
            {r.ecuCode && <span style={{color:C.ts,fontWeight:400,marginLeft:8}}>code {r.ecuCode}</span>}
            {r.subParam!=null && <span style={{color:C.ts,fontWeight:400,marginLeft:8}}>sub-param {r.subParam}</span>}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'2px 12px',fontSize:10,fontFamily:"'JetBrains Mono'"}}>
            {Object.entries(r.fields).map(([k,v])=>(
              <React.Fragment key={k}>
                <span style={{color:C.ts}}>idx {k}</span>
                <span>{v}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>}
  </Card>;
}
