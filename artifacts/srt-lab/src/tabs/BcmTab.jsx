import React, {useState, useCallback, useRef, useContext} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {cda6, u32} from "../lib/algos.js";
import {crc16ccitt} from "../lib/crc.js";
import {initAdapter, parseVinFromResponse} from "../lib/initAdapter.js";
import {backupModule, getBackupList} from "../lib/backups.js";
import {logSession} from "../lib/paperTrail.js";
import {decodeNRC} from "../lib/nrc.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import ReadFirstModal from "../components/ReadFirstModal.jsx";
import ModuleHistoryPanel from "../components/ModuleHistoryPanel.jsx";
import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import {parseModule, syncImmoBackup} from "../lib/parseModule.js";
import {vinHasSGW} from "../lib/vin.js";
import {createBridgeEngine} from "../lib/bridgeEngine.js";

const BCM_CANDIDATES=[
  {tx:0x750,rx:0x758,name:'CDA6 primary (2017 Scat Pack)'},
  {tx:0x742,rx:0x762,name:'Legacy/DarkVIN'},
  {tx:0x7E0,rx:0x7E8,name:'Pre-2016'},
  {tx:0x6B0,rx:0x6B8,name:'DarkVIN alt'},
];

export default function BcmTab(){
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
  const eng=useRef(null);
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
    const algosToTry=[
      {n:'CDA6',fn:s=>cda6(s)},
      {n:'BCM Standard',fn:s=>(s*0x9D+0x1234)&0xFFFFFFFF},
      {n:'BCM FCA',fn:s=>((s^0xABCDEF12)*0x4D+0x5678)&0xFFFFFFFF},
    ];
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
    const sgwReq=vinHasSGW(masterVin);
    let activeEng=eng.current;
    if(sgwReq){
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        setModuleStatus(p=>({...p,BCM:'fail'}));setBusy('');return;
      }
      activeEng=br.engine;
    }
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
    addLog('Creating safety backup before write...','info');
    const backup=await backupModule(activeEng.uds,bcmAddr.tx,bcmAddr.rx,'BCM',addLog,hx);
    if(backup)setBackupCount(getBackupList('BCM').length);
    const backupKey=backup?.key||null;
    addLog('Target: '+masterVin,'info');
    const shortVin=masterVin.slice(-8);
    const shortVinBytes=Array.from(shortVin).map(c=>c.charCodeAt(0));
    const crc=crc16ccitt(shortVinBytes);
    addLog('Short VIN: '+shortVin+' | CRC16-CCITT: 0x'+hx(crc,4),'info');
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    let allOk=true;
    for(const did of [0xF190,0x7B90,0x7B88]){
      addLog('Writing DID 0x'+hx(did,4)+'...','info');
      const r=await activeEng.uds(bcmAddr.tx,bcmAddr.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
      if(r.ok&&r.d&&r.d[0]===0x6E){addLog('✓ 0x'+hx(did,4)+' written','rx');}
      else{
        if(r.ok&&r.d&&r.d[0]===0x7F)addLog('✗ 0x'+hx(did,4)+' NRC: '+decodeNRC(r.d[2]||0),'error');
        else addLog('✗ 0x'+hx(did,4)+' failed','error');
        allOk=false;
      }
      await new Promise(r=>setTimeout(r,200));
    }
    addLog('─── Verifying ───','info');
    const verifiedVins={};
    for(const did of [0xF190,0x7B90,0x7B88]){
      const r=await activeEng.uds(bcmAddr.tx,bcmAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      const v=r.ok?parseVinFromResponse(r.d):null;
      verifiedVins[did]=v;
      const match=v===masterVin;
      addLog('0x'+hx(did,4)+': '+(match?'✓ MATCH':'✗ '+(v||'no response')),match?'rx':'warn');
      if(!match)allOk=false;
    }
    setCurVin(verifiedVins);
    setModuleStatus(p=>({...p,BCM:allOk?'ok':'fail'}));
    addLog(allOk?'═══ BCM VIN WRITE COMPLETE ═══':'═══ BCM VIN WRITE HAD FAILURES ═══',allOk?'info':'error');
    logSession({
      module:'BCM',
      operation:'VIN Write',
      oldVin:oldVinSnapshot,
      newVin:masterVin,
      moduleAddr:{tx:bcmAddr.tx,rx:bcmAddr.rx},
      adapter:activeEng?.adapter||eng.current?.adapter||'ELM327/STN',
      sgwRouted:sgwReq,
      voltage:volts,
      algorithm:algo,
      success:allOk,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
      backupKey,
      dids:Object.keys(verifiedVins).map(d=>({did:'0x'+hx(parseInt(d),4),value:verifiedVins[d]})),
    });
    addLog('📄 Session logged to paper trail','info');
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
  const inspectEntry=bcmDumps.find(d=>d.hash===inspectHash)||bcmDumps[0]||null;
  const inspectMod=inspectEntry?.mod||null;
  const onInspectFile=useCallback(file=>{
    const r=new FileReader();
    r.onload=ev=>{
      const m=parseModule(new Uint8Array(ev.target.result),file.name);
      if(m.type!=='BCM'){setInspectMsg('Selected file is '+m.type+', not BCM — load a 64 KB or 128 KB BCM dump.');return;}
      const entry=addDump(m);
      if(entry)setInspectHash(entry.hash);
      setInspectMsg('');
    };
    r.readAsArrayBuffer(file);
  },[addDump]);
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
    setInspectHash(null);setInspectMsg('');
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

    <ModuleHistoryPanel moduleType="BCM"/>

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
        {bcmDumps.length>1&&<select value={inspectEntry?.hash||''} onChange={e=>setInspectHash(e.target.value)}
          style={{padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11}}>
          {bcmDumps.map(d=><option key={d.hash} value={d.hash}>{d.filename}</option>)}
        </select>}
        {inspectMod&&<>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts}}>{inspectMod.filename} · {(inspectMod.size/1024).toFixed(0)} KB</span>
          <button onClick={closeInspect} style={{border:'none',background:'transparent',color:C.tm,cursor:'pointer',fontSize:14}} title="Remove from workspace">✕</button>
        </>}
      </div>
      {!inspectMod&&bcmDumps.length===0&&<div style={{marginTop:8,fontSize:11,color:C.tm,fontStyle:'italic'}}>Tip: dumps loaded in the FCA Analyzer tab show up here automatically.</div>}
      {inspectMod&&bcmDumps.length>0&&<div style={{marginTop:6,fontSize:10,color:C.gn,fontWeight:700}}>✓ Auto-loaded from shared workspace ({bcmDumps.length} BCM dump{bcmDumps.length===1?'':'s'} available)</div>}
      {inspectMsg&&<div style={{marginTop:8,fontSize:11,color:C.gn,fontWeight:700}}>{inspectMsg}</div>}
      {inspectMod&&<div style={{marginTop:12}}><ModuleFieldsPanel mod={inspectMod} onSyncImmo={onSyncImmoFile}/></div>}
    </Card>

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
