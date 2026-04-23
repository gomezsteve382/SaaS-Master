import React, {useState, useCallback, useRef, useContext, useEffect} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {cda6, u32} from "../lib/algos.js";
import {initAdapter, parseVinFromResponse} from "../lib/initAdapter.js";
import {backupModule, getBackupList} from "../lib/backups.js";
import {decodeNRC} from "../lib/nrc.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import ReadFirstModal from "../lib/readFirstModal.jsx";
import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import {parseModule, syncImmoBackup, bcmTooSmall} from "../lib/parseModule.js";
import {bcmFeatureMatrix} from "../lib/cgwConfig.js";
import {vinHasSGW} from "../lib/vin.js";
import {isSgwAuthenticated} from "../lib/sgwAuth.js";
import {createBridgeEngine} from "../lib/bridgeEngine.js";
import {getRow} from "../lib/moduleRegistry.js";
import {programVin} from "../lib/vinProgrammer.js";
import {analyzeDumpPartNumber, generationForPartNumber} from "../lib/vehicles.js";
import SamplePicker from "../lib/SamplePicker.jsx";

const BCM_ALGOS={
  'CDA6':s=>cda6(s),
  'BCM Standard':s=>(s*0x9D+0x1234)&0xFFFFFFFF,
  'BCM FCA':s=>((s^0xABCDEF12)*0x4D+0x5678)&0xFFFFFFFF,
};

const BCM_CANDIDATES=[
  {tx:0x750,rx:0x758,name:'CDA6 primary (2017 Scat Pack)'},
  {tx:0x742,rx:0x762,name:'Legacy/DarkVIN'},
  {tx:0x7E0,rx:0x7E8,name:'Pre-2016'},
  {tx:0x6B0,rx:0x6B8,name:'DarkVIN alt'},
];

/* Feature Matrix panel — decodes the loaded BCM dump bytes against the
 * BodyPN / Delphi config catalog (Task #144).
 *
 * NB: BCM .bin dumps are flash images (64KB / 128KB EEPROM), not CAN
 * response payloads, so the bit-offset map in CGW_CONFIG won't line up
 * 1:1 with file bytes. We still surface the catalog as a labeled
 * feature reference here, and decode the first 64 bytes of the dump
 * as a best-effort preview — clearly marked as such — so the user
 * can spot known features without having to capture a UDS response.
 * The same decoder is used live in UDS reads on the (future) Live OBD
 * surface; bytes there will line up correctly. */
function FeatureMatrixPanel({mod, bytes}){
  const [open,setOpen]=useState(false);
  const matrix=React.useMemo(()=>bcmFeatureMatrix(bytes||(mod?mod.data.slice(0x4090,0x4090+128):null)),[mod,bytes]);
  const requests=Array.from(matrix.keys());
  return <Card style={{marginBottom:14,background:'#FFF8F0'}}>
    <div onClick={()=>setOpen(!open)} style={{cursor:'pointer',display:'flex',alignItems:'center',gap:10}}>
      <div style={{fontSize:18}}>🎛️</div>
      <div style={{flex:1}}>
        <div style={{fontWeight:800,fontSize:12,color:C.sr,letterSpacing:1.5}}>BODY FEATURE MATRIX (DECODED)</div>
        <div style={{fontSize:10,color:C.tm,marginTop:2,fontStyle:'italic'}}>{requests.length} requests · best-effort decode of dump bytes against AlfaOBD BodyPN catalog</div>
      </div>
      <div style={{fontSize:14,color:C.tm}}>{open?'▾':'▸'}</div>
    </div>
    {open&&<div style={{marginTop:12,maxHeight:400,overflowY:'auto'}}>
      <div style={{fontSize:10,color:C.wn,padding:'6px 10px',background:'#fff',borderRadius:6,marginBottom:8,border:'1px dashed '+C.wn+'66'}}>
        ⚠ Catalog rows are indexed by UDS-response bit offset, not flash file offset. Values shown for a flash dump are best-effort and may read as "(out of range)" or unexpected. Capture a real CAN response on the Live OBD surface for accurate decoding.
      </div>
      {requests.slice(0,8).map(req=><div key={req} style={{marginBottom:10,padding:'8px 10px',background:'#fff',borderRadius:6,border:'1px solid '+C.bd}}>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:800,color:C.a3,marginBottom:6}}>Request 0x{req}</div>
        {matrix.get(req).slice(0,12).map((row,i)=><div key={i} style={{display:'flex',gap:10,fontSize:11,padding:'2px 0',borderBottom:'1px dotted '+C.bd}}>
          <span style={{flex:1,color:C.tx}}>{row.setting}</span>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>bit{row.bit}/+{row.length}</span>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:row.raw===null?C.wn:C.gn,minWidth:120,textAlign:'right',fontWeight:700}}>{row.label}</span>
        </div>)}
        {matrix.get(req).length>12&&<div style={{fontSize:9,color:C.tm,fontStyle:'italic',marginTop:4}}>… +{matrix.get(req).length-12} more rows</div>}
      </div>)}
      {requests.length>8&&<div style={{fontSize:10,color:C.tm,fontStyle:'italic',textAlign:'center',padding:6}}>… +{requests.length-8} more requests in catalog</div>}
    </div>}
  </Card>;
}

/* Standalone catalog browser — visible even without a loaded dump so
 * users can browse the BodyPN feature reference. */
function FeatureMatrixCatalog(){
  const [open,setOpen]=useState(false);
  const matrix=React.useMemo(()=>bcmFeatureMatrix(null),[]);
  const requests=Array.from(matrix.keys());
  const total=Array.from(matrix.values()).reduce((s,a)=>s+a.length,0);
  return <Card style={{marginBottom:14}}>
    <div onClick={()=>setOpen(!open)} style={{cursor:'pointer',display:'flex',alignItems:'center',gap:10}}>
      <div style={{fontSize:18}}>📚</div>
      <div style={{flex:1}}>
        <div style={{fontWeight:800,fontSize:11,color:C.sr,letterSpacing:1.5}}>BCM FEATURE CATALOG (REFERENCE)</div>
        <div style={{fontSize:10,color:C.tm,marginTop:2}}>{total} BodyPN/Delphi features across {requests.length} request hexes — sourced from AlfaOBD database recovery</div>
      </div>
      <div style={{fontSize:14,color:C.tm}}>{open?'▾':'▸'}</div>
    </div>
    {open&&<div style={{marginTop:10,maxHeight:300,overflowY:'auto',fontSize:11}}>
      {requests.map(req=><div key={req} style={{padding:'4px 0',borderBottom:'1px dotted '+C.bd}}>
        <span style={{fontFamily:"'JetBrains Mono'",fontWeight:800,color:C.a3,marginRight:10}}>0x{req}</span>
        <span style={{color:C.ts,fontSize:10}}>{matrix.get(req).length} feature{matrix.get(req).length===1?'':'s'}</span>
        <span style={{marginLeft:10,fontSize:10,color:C.tm}}>{matrix.get(req).slice(0,3).map(r=>r.setting).join(' · ')}{matrix.get(req).length>3?' …':''}</span>
      </div>)}
    </div>}
  </Card>;
}

export default function BcmTab({vehicle}){
  const {vin:masterVin,setModuleStatus,getDumpsByType,addDump,replaceDump,removeDump}=useContext(MasterVinContext);
  const [conn,setConn]=useState(false);
  const [unlocked,setUnlocked]=useState(false);
  const [busy,setBusy]=useState('');
  const [log,setLog]=useState([]);
  const [curVin,setCurVin]=useState({});
  const [algo,setAlgo]=useState('');
  const [bcmAddr,setBcmAddr]=useState(BCM_CANDIDATES[0]);
  const [backupCount,setBackupCount]=useState(()=>getBackupList('BCM').length);
  const [showConfirmModal,setShowConfirmModal]=useState(false);
  const [genTooltipVisible,setGenTooltipVisible]=useState(false);
  const eng=useRef(null);
  const genBadgeRef=useRef(null);
  useEffect(()=>{
    if(!genTooltipVisible)return;
    const handler=(e)=>{
      if(genBadgeRef.current&&!genBadgeRef.current.contains(e.target)){
        setGenTooltipVisible(false);
      }
    };
    document.addEventListener('mousedown',handler,true);
    document.addEventListener('touchstart',handler,true);
    return()=>{
      document.removeEventListener('mousedown',handler,true);
      document.removeEventListener('touchstart',handler,true);
    };
  },[genTooltipVisible]);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for BCM ops','info');}
  },[addLog]);

  const findBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Finding BCM...');
    for(const c of BCM_CANDIDATES){
      addLog('Probing '+c.name+' TX:0x'+hx(c.tx,3)+'...','info');
      const r=await eng.current.uds(c.tx,c.rx,[0x22,0xF1,0x90]);
      if(r.ok){setBcmAddr(c);addLog('✓ BCM found at '+c.name,'rx');setBusy('');return c;}
    }
    addLog('BCM not found on any address','error');setBusy('');return null;
  },[addLog]);

  const readVins=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VINs...');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x10,0x03]);
    const vins={};
    for(const did of [0xF190,0x7B90,0x7B88]){
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      const v=r.ok?parseVinFromResponse(r.d):null;
      vins[did]=v;
      addLog('DID 0x'+hx(did,4)+': '+(v||'(no response)'),v?'rx':'warn');
    }
    setCurVin(vins);setBusy('');
  },[bcmAddr,addLog]);

  const backupBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Backing up BCM...');
    const backup=await backupModule(eng.current.uds,bcmAddr.tx,bcmAddr.rx,'BCM',addLog,hx);
    if(backup){setBackupCount(getBackupList('BCM').length);addLog('✓ BCM backup saved — can restore if write fails','info');}
    setBusy('');
  },[bcmAddr,addLog]);

  const unlockBcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking BCM...');
    addLog('Entering extended session (10 03)...','info');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x10,0x03]);
    addLog('Requesting seed (27 01)...','info');
    const s=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    const algosToTry=Object.entries(BCM_ALGOS).map(([n,fn])=>({n,fn}));
    for(const a of algosToTry){
      const k=a.fn(sv);
      addLog('Trying '+a.n+' key 0x'+hx(k,8)+'...','info');
      const r=await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
      if(r.ok&&r.d&&r.d[0]===0x67){addLog('✓ UNLOCKED with '+a.n,'rx');setUnlocked(true);setAlgo(a.n);setBusy('');return;}
    }
    addLog('All algorithms failed','error');setBusy('');
  },[bcmAddr,addLog]);

  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock BCM first','error');return;}
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin[0xF190]||null;
    setBusy('Writing VIN...');
    setModuleStatus(p=>({...p,BCM:'writing'}));
    addLog('═══ BCM VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    // Pick the engine: bridge channel when SGW is mandated by the VIN year,
    // otherwise the live ELM/STN adapter. programVin() then drives unlock +
    // write + verify on whichever channel we hand it — no replay needed.
    const sgwReq=vinHasSGW(masterVin);
    let activeEng=eng.current;
    if(sgwReq){
      // Hard-fail BEFORE we open the bridge channel: a reachable bridge
      // does NOT mean SGW seed/key has succeeded for this VIN. Without
      // an authenticated SGW, every WriteByID below would be silently
      // dropped by the gateway.
      if(!isSgwAuthenticated(masterVin)){
        addLog('🛑 SGW REQUIRED but not authenticated for this VIN','error');
        addLog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.','error');
        setModuleStatus(p=>({...p,BCM:'fail'}));setBusy('');return;
      }
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        setModuleStatus(p=>({...p,BCM:'fail'}));setBusy('');return;
      }
      activeEng=br.engine;
    }
    // BCM-specific bench safety: refuse to write under 12.4V (voltage drop
    // mid-write can brick the module). Tab-side because the registry
    // engine has no opinion on hardware health.
    let volts=null;
    try{volts=await activeEng.readVoltage();}catch{}
    if(volts!==null){
      addLog('Bench voltage: '+volts.toFixed(1)+'V','info');
      if(volts<12.4){
        addLog('⚠ WARNING: Voltage below 12.4V — writes may fail or corrupt module','warn');
        if(!window.confirm('Voltage is '+volts.toFixed(1)+'V (below 12.4V safe threshold). Continue anyway?')){
          addLog('Write aborted by user due to low voltage','error');
          setBusy('');setModuleStatus(p=>({...p,BCM:'pending'}));return;
        }
      }
    }else addLog('Could not read voltage — proceeding without check','warn');
    // Use the BCM registry row but pin tx/rx to the address the user
    // selected via the candidate dropdown (may differ from the canonical
    // 0x750/0x758 for legacy/DarkVIN benches).
    const row={...getRow('BCM'),tx:bcmAddr.tx,rx:bcmAddr.rx};
    const r=await programVin({
      eng:activeEng, row, vin:masterVin,
      addLog:(m,t)=>addLog(m,t),
      makeBackup: async ({uds,snapshotKind,preWriteKey})=>{
        const b=await backupModule(uds,bcmAddr.tx,bcmAddr.rx,'BCM',addLog,hx,snapshotKind,preWriteKey);
        if(b)setBackupCount(getBackupList('BCM').length);
        return b;
      },
    });
    const verifiedVins={};
    for(const dr of r.didResults) verifiedVins[dr.did]=dr.readback;
    setCurVin(verifiedVins);
    setModuleStatus(p=>({...p,BCM:r.ok?'ok':'fail'}));
    addLog(r.ok?'═══ BCM VIN WRITE COMPLETE ═══':'═══ BCM VIN WRITE HAD FAILURES ═══',r.ok?'info':'error');
    setBusy('');
  },[masterVin,bcmAddr,addLog,setModuleStatus,curVin,algo]);

  const ecuReset=useCallback(async()=>{
    if(!eng.current)return;
    addLog('Sending ECU reset (11 01)...','info');
    await eng.current.uds(bcmAddr.tx,bcmAddr.rx,[0x11,0x01]);
    addLog('Reset sent — wait ~3 sec for BCM to come back','info');
    setUnlocked(false);
  },[bcmAddr,addLog]);

  const bcmDumps=getDumpsByType('BCM');
  const [inspectHash,setInspectHash]=useState(null);
  const [inspectMsg,setInspectMsg]=useState('');
  const [inspectTooSmall,setInspectTooSmall]=useState(null);
  const [detectedGen,setDetectedGen]=useState(null);
  const [detectedPn,setDetectedPn]=useState(null);
  const [inspectPnCheck,setInspectPnCheck]=useState(null);
  const inspectEntry=bcmDumps.find(d=>d.hash===inspectHash)||bcmDumps[0]||null;
  const inspectMod=inspectEntry?.mod||null;

  // Run part-number detection whenever the active dump changes — covers both
  // manual file loads (via onInspectFile) and dumps auto-shared from the FCA
  // Analyzer tab that bypass onInspectFile entirely.
  // When the dump disappears (external removeDump call), also clear the
  // generation highlight so the vehicle banner resets correctly.
  useEffect(()=>{
    if(!inspectMod||!vehicle||!vehicle.bcmFamilies){
      setInspectPnCheck(null);
      if(!inspectMod){setDetectedGen(null);setDetectedPn(null);}
      return;
    }
    const a=analyzeDumpPartNumber(inspectMod.data);
    const compatible=a.compatibleVehicles.includes(vehicle.id);
    const gen=a.primaryPn?generationForPartNumber(vehicle.id,a.primaryPn,a.vinModelYearChar):null;
    setInspectPnCheck({compatible,partNumber:a.primaryPn||a.partNumbers[0]||null,allPns:a.partNumbers,genLabel:gen?gen.label:null});
  },[inspectMod,vehicle]);

  const onInspectFile=useCallback(file=>{
    const r=new FileReader();
    r.onload=ev=>{
      const bytes=new Uint8Array(ev.target.result);
      // Reject undersized files up-front so users see a structured "isn't a
      // full BCM dump" card instead of a partial parse / generic UNKNOWN
      // message (Task #370).
      const small=bcmTooSmall(bytes,file.name);
      if(small){
        // Stop selecting whichever BCM dump is currently inspected so the
        // tile renders ONLY the structured "isn't a full BCM dump" card.
        // We deliberately do NOT removeDump() — other tabs may still be
        // working with that file; the panels themselves gate on
        // !inspectTooSmall (deterministic suppression, Task #370).
        setInspectHash(null);
        setInspectTooSmall(small);
        setInspectMsg('');
        setDetectedGen(null);setDetectedPn(null);setInspectPnCheck(null);
        return;
      }
      setInspectTooSmall(null);
      const m=parseModule(bytes,file.name);
      if(m.type!=='BCM'){setInspectMsg('Selected file is '+m.type+', not BCM — load a 64 KB or 128 KB BCM dump.');setDetectedGen(null);setDetectedPn(null);setInspectPnCheck(null);return;}
      const entry=addDump(m);
      if(entry)setInspectHash(entry.hash);
      setInspectMsg('');
      // Auto-detect matching generation and highlight in the vehicle banner
      const{primaryPn,vinModelYearChar}=analyzeDumpPartNumber(bytes);
      const gen=vehicle&&primaryPn?generationForPartNumber(vehicle.id,primaryPn,vinModelYearChar):null;
      setDetectedPn(primaryPn);
      setDetectedGen(gen||null);
      // inspectPnCheck is updated reactively via useEffect on inspectMod
    };
    r.readAsArrayBuffer(file);
  },[addDump,vehicle]);
  const onSyncImmoFile=useCallback(()=>{
    if(!inspectEntry||!inspectMod)return;
    if(inspectMod.immoBlank){setInspectMsg('IMMO primary is blank — nothing to sync.');return;}
    if(!window.confirm('Copy IMMO primary @0x40C0 → backup @0x2000? A patched .bin will be downloaded; the original file is not modified.'))return;
    const synced=syncImmoBackup(inspectMod.data);
    if(!synced){setInspectMsg('BCM file too small for IMMO sync.');return;}
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([synced]));a.download='IMMO_SYNCED_'+inspectMod.filename;a.click();URL.revokeObjectURL(a.href);
    const reparsed=parseModule(synced,inspectMod.filename);
    const updated=replaceDump(inspectEntry.hash,reparsed);
    if(updated)setInspectHash(updated.hash);
    setInspectMsg('IMMO backup synced: '+inspectMod.immoRecs+' keys → 0x2000. Snapshot downloaded.');
  },[inspectEntry,inspectMod,replaceDump]);
  const closeInspect=useCallback(()=>{
    if(inspectEntry)removeDump(inspectEntry.hash);
    setInspectHash(null);setInspectMsg('');setInspectTooSmall(null);setDetectedGen(null);setDetectedPn(null);setInspectPnCheck(null);
  },[inspectEntry,removeDump]);

  const vinValid=masterVin.length===17;
  return <div>
    {showConfirmModal&&<ReadFirstModal
      module="BCM"
      currentState={[
        {label:'Primary VIN (DID 0xF190)',value:curVin[0xF190]},
        {label:'Current VIN (DID 0x7B90)',value:curVin[0x7B90]},
        {label:'Original VIN (DID 0x7B88)',value:curVin[0x7B88]},
        {label:'Module Address',value:'TX 0x'+hx(bcmAddr.tx,3)+' / RX 0x'+hx(bcmAddr.rx,3)},
        {label:'Unlock Algorithm',value:algo||'(not unlocked)'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}

    <Card style={{background:'linear-gradient(135deg,#3D0A0A 0%,#8B0000 40%,#D32F2F 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🧠</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>BCM PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>BODY CONTROL MODULE · VIN + CRC + FEATURES</div>
          {vehicle&&<div style={{marginTop:8,padding:'6px 10px',background:'rgba(0,0,0,0.3)',borderRadius:8,display:'inline-block'}}>
            <div style={{fontSize:11,fontWeight:800,letterSpacing:1.5,color:'rgba(255,255,255,0.9)'}}>{vehicle.full} — {vehicle.body}</div>
            <div style={{fontSize:10,color:'rgba(255,255,255,0.6)',marginTop:3,fontFamily:"'JetBrains Mono'"}}>{vehicle.generations.length} gen{vehicle.generations.length===1?'':'s'} · expected P/Ns: {vehicle.bcmFamilies.slice(0,4).join(', ')}{vehicle.bcmFamilies.length>4?' +'+( vehicle.bcmFamilies.length-4)+' more':''}</div>
            <div style={{marginTop:4,display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
              {vehicle.generations.map(g=>{
                const isMatch=detectedGen&&detectedGen.id===g.id;
                return <span key={g.id} style={{
                  fontSize:9,padding:'2px 7px',
                  background:isMatch?'rgba(255,255,255,0.25)':(g.sec16==='gen2-split'?'rgba(255,179,0,0.3)':'rgba(0,200,83,0.2)'),
                  borderRadius:4,
                  border:'2px solid '+(isMatch?'#FFFFFF':(g.sec16==='gen2-split'?'rgba(255,179,0,0.5)':'rgba(0,200,83,0.3)')),
                  fontFamily:"'JetBrains Mono'",fontWeight:isMatch?900:700,letterSpacing:0.5,
                  boxShadow:isMatch?'0 0 8px rgba(255,255,255,0.5)':'none',
                  color:isMatch?'#FFFFFF':'inherit',
                  position:'relative',
                }}>
                  {isMatch&&<span style={{marginRight:4}}>✓</span>}
                  {g.label} · {g.bcmPn} · {g.sec16==='gen2-split'?'Gen2 split SEC16':g.sec16==='trackhawk-no-flash'?'No flash SEC16':'Gen1 SEC16'} · VIN@0x{g.vinOff.toString(16).toUpperCase()}
                </span>;
              })}
              {detectedPn&&<span
                ref={genBadgeRef}
                style={{position:'relative',display:'inline-block',marginLeft:4}}
                onPointerEnter={(e)=>{ if(e.pointerType==='mouse') setGenTooltipVisible(true); }}
                onPointerLeave={(e)=>{ if(e.pointerType==='mouse') setGenTooltipVisible(false); }}
                onClick={()=>detectedGen&&setGenTooltipVisible(v=>!v)}>
                <span style={{
                  fontSize:9,padding:'2px 8px',
                  background:detectedGen?'rgba(255,255,255,0.18)':'rgba(255,179,0,0.25)',
                  borderRadius:4,
                  border:'1px dashed '+(detectedGen?'rgba(255,255,255,0.6)':'rgba(255,179,0,0.8)'),
                  fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:0.5,
                  color:detectedGen?'rgba(255,255,255,0.95)':'#FFD54F',
                  cursor:detectedGen?'pointer':'default',
                }}>
                  {detectedGen?'':'⚠ '}{detectedGen?'Detected:':'Unknown P/N:'} {detectedPn}
                </span>
                {detectedGen&&genTooltipVisible&&<span style={{
                  position:'absolute',top:'calc(100% + 6px)',left:0,zIndex:999,
                  background:'#1A1A2E',border:'1px solid rgba(255,255,255,0.22)',
                  borderRadius:6,padding:'7px 11px',whiteSpace:'nowrap',
                  fontSize:10,fontFamily:"'JetBrains Mono'",color:'#E0E0E0',
                  boxShadow:'0 4px 14px rgba(0,0,0,0.55)',lineHeight:1.8,
                }}>
                  <div><span style={{color:'#888'}}>Generation: </span>{detectedGen.label}</div>
                  <div><span style={{color:'#888'}}>SEC16: </span>{detectedGen.sec16==='gen2-split'?'Gen2 split SEC16':detectedGen.sec16==='trackhawk-no-flash'?'No flash SEC16':'Gen1 SEC16'}</div>
                  <div><span style={{color:'#888'}}>VIN offset: </span>0x{detectedGen.vinOff.toString(16).toUpperCase()}</div>
                </span>}
              </span>}
            </div>
          </div>}
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED ('+algo+')':'● CONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.sr}>🔌 Test Connection</Btn>}
        {conn&&<Btn onClick={findBcm} disabled={!!busy} color={C.a3}>🎯 Find BCM</Btn>}
        {conn&&<Btn onClick={readVins} disabled={!!busy} color={C.a2}>📖 Read VINs</Btn>}
        {conn&&<Btn onClick={backupBcm} disabled={!!busy} color={C.gn}>💾 Backup Module</Btn>}
        {conn&&<Btn onClick={unlockBcm} disabled={!!busy} color={C.a4}>🔓 Unlock (CDA6)</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.sr}>💾 Write Master VIN</Btn>}
        {conn&&<Btn onClick={ecuReset} disabled={!!busy} color={C.er} outline>⚡ ECU Reset</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        Target: {bcmAddr.name} · TX 0x{hx(bcmAddr.tx,3)} · RX 0x{hx(bcmAddr.rx,3)}
      </div>
      {backupCount>0&&<div style={{marginTop:8,fontSize:10,color:C.gn}}>
        ✓ {backupCount} backup{backupCount===1?'':'s'} saved for this module
      </div>}
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      {!vinValid&&<div style={{padding:10,background:'#FFF8F0',border:'1px solid '+C.wn,borderRadius:8,fontSize:12,color:C.wn,marginBottom:10}}>
        ⚠ Enter a valid 17-char Master VIN at the top of the page
      </div>}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
        {[{did:0xF190,l:'Primary VIN'},{did:0x7B90,l:'Current VIN'},{did:0x7B88,l:'Original VIN'}].map(x=>{
          const v=curVin[x.did];const match=v&&v===masterVin;
          return <div key={x.did} style={{padding:10,background:match?'#E8F5E9':v?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(match?C.gn:v?C.wn:C.bd)}}>
            <div style={{fontSize:9,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0x{hx(x.did,4)} · {x.l}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,marginTop:4,color:match?C.gn:v?C.wn:C.tm}}>{v||'(not read)'}</div>
            {match&&<div style={{fontSize:9,color:C.gn,marginTop:2}}>✓ matches Master VIN</div>}
          </div>;
        })}
      </div>
    </Card>

    {vinValid&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🔢 SHORT VIN CHECKSUM (CRC16-CCITT)</div>
      <div style={{fontFamily:"'JetBrains Mono'",fontSize:12,display:'grid',gridTemplateColumns:'auto 1fr',gap:'8px 16px'}}>
        <span style={{color:C.ts}}>Short VIN (last 8):</span><span style={{fontWeight:700}}>{masterVin.slice(-8)}</span>
        <span style={{color:C.ts}}>CRC16-CCITT:</span><span style={{fontWeight:700,color:C.a3}}>0x{hx(crc16ccitt(Array.from(masterVin.slice(-8)).map(c=>c.charCodeAt(0))),4)}</span>
        <span style={{color:C.ts}}>Flash locations:</span><span style={{fontSize:10,color:C.tm}}>0x4098 (primary) · 0x40B0 (backup)</span>
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.ts,fontStyle:'italic'}}>
        BCM firmware auto-updates these internal flash locations when DID 0xF190 is written via UDS.
      </div>
    </Card>}

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🔍 BCM DUMP INSPECTOR</div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <label style={{padding:'10px 16px',borderRadius:10,border:'2px dashed '+C.sr+'40',background:C.c2,cursor:'pointer',fontSize:12,fontWeight:800,color:C.sr}}>
          📂 Load BCM .bin to inspect byte-level fields
          <input type="file" accept=".bin,.BIN" hidden onChange={e=>e.target.files[0]&&onInspectFile(e.target.files[0])}/>
        </label>
        {bcmDumps.length>1&&<select value={inspectEntry?.hash||''} onChange={e=>{
          const hash=e.target.value;
          setInspectHash(hash);
          const entry=bcmDumps.find(d=>d.hash===hash);
          const bytes=entry?.mod?.data;
          if(bytes&&bytes.length){
            const{primaryPn,vinModelYearChar}=analyzeDumpPartNumber(bytes);
            const gen=vehicle&&primaryPn?generationForPartNumber(vehicle.id,primaryPn,vinModelYearChar):null;
            setDetectedPn(primaryPn);
            setDetectedGen(gen||null);
          }else{
            setDetectedPn(null);
            setDetectedGen(null);
          }
        }}
          style={{padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11}}>
          {bcmDumps.map(d=><option key={d.hash} value={d.hash}>{d.filename}</option>)}
        </select>}
        {inspectMod&&<>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts}}>{inspectMod.filename} · {(inspectMod.size/1024).toFixed(0)} KB</span>
          <button onClick={closeInspect} style={{border:'none',background:'transparent',color:C.tm,cursor:'pointer',fontSize:14}} title="Remove from workspace">✕</button>
        </>}
      </div>
      <SamplePicker kinds={['BCM']} acceptSizes={[65536,131072]} onFile={onInspectFile} compact label="📦 Sample BCM dump"/>
      {!inspectMod&&bcmDumps.length===0&&<div style={{marginTop:8,fontSize:11,color:C.tm,fontStyle:'italic'}}>Tip: dumps loaded in the FCA Analyzer tab show up here automatically.</div>}
      {inspectMod&&bcmDumps.length>0&&<div style={{marginTop:6,fontSize:10,color:C.gn,fontWeight:700}}>✓ Auto-loaded from shared workspace ({bcmDumps.length} BCM dump{bcmDumps.length===1?'':'s'} available)</div>}
      {inspectPnCheck&&vehicle&&(
        inspectPnCheck.compatible
          ? <div style={{marginTop:10,padding:'10px 14px',borderRadius:10,background:C.gn+'14',border:'1px solid '+C.gn+'55'}}>
              <div style={{fontSize:11,fontWeight:900,color:C.gn,letterSpacing:1,marginBottom:2}}>✓ DUMP MATCHES SELECTED VEHICLE</div>
              <div style={{fontSize:11,color:C.tx}}>
                P/N <code style={{fontFamily:"'JetBrains Mono'"}}>{inspectPnCheck.partNumber}</code> is compatible with <b>{vehicle.name||vehicle.full}</b>
                {inspectPnCheck.genLabel?<span> · <span style={{fontWeight:700,color:C.gn}}>{inspectPnCheck.genLabel}</span></span>:null}
              </div>
            </div>
          : <div style={{marginTop:10,padding:'10px 14px',borderRadius:10,background:C.er+'12',border:'1px solid '+C.er+'44'}}>
              <div style={{fontSize:11,fontWeight:900,color:C.er,letterSpacing:1,marginBottom:4}}>⛔ DUMP DOES NOT MATCH SELECTED VEHICLE</div>
              <div style={{fontSize:11,color:C.tx}}>
                {inspectPnCheck.partNumber
                  ? <>P/N <code style={{fontFamily:"'JetBrains Mono'"}}>{inspectPnCheck.partNumber}</code> is not in the BCM family list for <b>{vehicle.name||vehicle.full}</b>. Valid P/Ns: {vehicle.bcmFamilies.slice(0,4).join(', ')}{vehicle.bcmFamilies.length>4?' +'+( vehicle.bcmFamilies.length-4)+' more':''}.</>
                  : <>No known BCM part number detected. Valid P/Ns for <b>{vehicle.name||vehicle.full}</b>: {vehicle.bcmFamilies.slice(0,4).join(', ')}{vehicle.bcmFamilies.length>4?' +'+( vehicle.bcmFamilies.length-4)+' more':''}.</>
                }
              </div>
            </div>
      )}
      {inspectTooSmall&&<div data-testid="bcm-too-small-card" style={{marginTop:12,padding:'14px 16px',borderRadius:10,background:'rgba(255,23,68,0.07)',border:'2px solid '+C.er}}>
        <div style={{fontWeight:900,fontSize:13,color:C.er,letterSpacing:1.2,textTransform:'uppercase',marginBottom:8}}>⛔ This isn&apos;t a full BCM dump</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tx,lineHeight:1.7}}>
          <div>File size: <strong style={{color:C.er}}>{inspectTooSmall.size.toLocaleString()} bytes</strong></div>
          <div>Required min: <strong>{inspectTooSmall.min.toLocaleString()} bytes (64 KB MPC5605B/06B DFLASH)</strong></div>
          <div>Detected ext: <strong>{inspectTooSmall.ext||'(none)'}</strong></div>
        </div>
        <div style={{marginTop:8,fontSize:12,color:C.tx,fontWeight:600,lineHeight:1.5}}>Re-read the BCM in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.</div>
      </div>}
      {inspectMsg&&<div style={{marginTop:8,fontSize:11,color:C.gn,fontWeight:700}}>{inspectMsg}</div>}
      {inspectMod&&!inspectTooSmall&&<div style={{marginTop:12}}><ModuleFieldsPanel mod={inspectMod} onSyncImmo={onSyncImmoFile}/></div>}
    </Card>

    {inspectMod&&!inspectTooSmall&&<FeatureMatrixPanel mod={inspectMod}/>}

    <FeatureMatrixCatalog/>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#FF5252',marginBottom:10,letterSpacing:2}}>📋 LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}
