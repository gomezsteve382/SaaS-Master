import React, {useState, useCallback, useRef} from "react";
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import IdentityCard from '../components/IdentityCard.jsx';
import Gpec2aImmoPanel from '../components/Gpec2aImmoPanel.jsx';
import CorruptDumpBanner from '../components/CorruptDumpBanner.jsx';
import DumpDropZone, {DumpDropArea} from '../components/DumpDropZone.jsx';
import {parseModule,moduleTooSmall,corruptFillError} from '../lib/parseModule.js';
import {initAdapter, parseVinFromResponse} from '../lib/initAdapter.js';
import {decodeNRC} from '../lib/nrc.js';
import {backupModule} from '../lib/audit.js';
import {ReadFirstModal} from '../lib/readFirstModal.jsx';
import {useMasterVin} from '../lib/masterVinContext.jsx';
import {ECM_ALGOS, u32} from '../lib/programmerData.js';
import {isSgwAuthenticated} from '../lib/sgwAuth.js';
import {vinHasSGW} from '../lib/vin.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {getRow} from '../lib/moduleRegistry.js';
import {programVin} from '../lib/vinProgrammer.js';
import {build} from '@workspace/uds';

// Prioritized ECM/PCM CAN address candidates probed on Connect. The
// standard FCA PCM (0x7E0/0x7E8) is first so there is zero behaviour change
// for ordinary vehicles; the remainder cover auxiliary engine controllers,
// platforms with a non-standard PCM CAN ID, and some Hellcat variants.
// RX defaults to TX+8 per the ISO-TP normal-addressing convention.
const ECM_PROBE_CANDIDATES=[
  {tx:0x7E0,rx:0x7E8,name:'Standard PCM (FCA default)'},
  {tx:0x740,rx:0x748,name:'Auxiliary engine controller'},
  {tx:0x7A0,rx:0x7A8,name:'Alternate PCM CAN ID'},
  {tx:0x6F0,rx:0x6F8,name:'Hellcat variant'},
];

/**
 * discoverEcm — probe the candidate address list with a TesterPresent
 * (3E 00) and return the first pair that answers with a positive response
 * (0x7E). Returns null if no candidate responds.
 *
 * `engine` is the initAdapter UDS engine; `addLog`/`hx` are optional and
 * only used for progress logging when supplied.
 */
export async function discoverEcm(engine,addLog,hx){
  if(!engine)return null;
  const fmt=hx||((n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0'));
  for(const c of ECM_PROBE_CANDIDATES){
    addLog&&addLog('Probing '+c.name+' TX:0x'+fmt(c.tx,3)+' (3E 00)...','info');
    const r=await engine.uds(c.tx,c.rx,build.testerPresent({subFunction:0x00}));
    if(r&&r.ok&&r.d&&r.d[0]===0x7E)return c;
  }
  return null;
}

export {ECM_PROBE_CANDIDATES};

export default function EcmTab({vehicle}){
  const{vin:masterVin,updateStatus,getDumpsByType,addDump,removeDump}=useMasterVin();
  // Task #774 — surface OS/PN/Serial best-pick for any GPEC2A (ECM) dump
  // present in the shared workspace.
  const ecmDumps=(getDumpsByType?.('GPEC2A')||[]);
  // Task #1035 — donor SEC16 sources for the offline GPEC2A immo-fix panel.
  const donorMods=[
    ...(getDumpsByType?.('BCM')||[]),
    ...(getDumpsByType?.('RFHUB')||[]),
  ].map(d=>d.mod).filter(Boolean);
  // Task #783 — inline file picker (mirrors RfhubTab pattern). Lets techs
  // load a donor ECM .bin from this tab without bouncing through Dumps.
  const[inspectHash,setInspectHash]=useState(null);
  const[inspectMsg,setInspectMsg]=useState('');
  const[inspectErr,setInspectErr]=useState('');
  const[inspectTooSmall,setInspectTooSmall]=useState(null);
  const inspectEntry=ecmDumps.find(d=>d.hash===inspectHash)||ecmDumps[0]||null;
  const ecmInspectMod=inspectEntry?.mod||null;
  const onInspectFile=useCallback(file=>{
    const r=new FileReader();
    r.onload=ev=>{
      const bytes=new Uint8Array(ev.target.result);
      const small=moduleTooSmall(bytes,'GPEC2A',file.name);
      if(small){setInspectHash(null);setInspectTooSmall(small);setInspectMsg('');return;}
      setInspectTooSmall(null);
      const m=parseModule(bytes,file.name);
      const cfErr=corruptFillError(m);
      if(cfErr){setInspectErr(cfErr);setInspectMsg('');return;}
      setInspectErr('');
      if(m.type!=='GPEC2A'){setInspectMsg('Selected file is '+m.type+', not GPEC2A — load a 4 KB Continental GPEC2A ECM dump.');return;}
      const entry=addDump(m,'ECM tab');
      if(entry)setInspectHash(entry.hash);
      setInspectMsg('');
    };
    r.readAsArrayBuffer(file);
  },[addDump]);
  const closeInspect=useCallback(()=>{
    if(inspectEntry)removeDump(inspectEntry.hash);
    setInspectHash(null);setInspectMsg('');setInspectErr('');setInspectTooSmall(null);
  },[inspectEntry,removeDump]);
  const[conn,setConn]=useState(false);const[unlocked,setUnlocked]=useState(false);
  const[busy,setBusy]=useState('');const[log,setLog]=useState([]);
  const[curVin,setCurVin]=useState(null);const[ecmInfo,setEcmInfo]=useState({});
  const[algo,setAlgo]=useState('');const[showConfirmModal,setShowConfirmModal]=useState(false);
  const[ecmAddr,setEcmAddr]=useState(ECM_PROBE_CANDIDATES[0]);
  const[discovering,setDiscovering]=useState(false);
  const[manualAddr,setManualAddr]=useState('');
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(!e)return;
    eng.current=e;setConn(true);
    setDiscovering(true);
    addLog('═══ ECM ADDRESS DISCOVERY ═══','info');
    const found=await discoverEcm(e,addLog,hx);
    setDiscovering(false);
    if(found){
      setEcmAddr(found);
      addLog('✓ ECM found at '+found.name+' — TX 0x'+hx(found.tx,3)+' / RX 0x'+hx(found.rx,3),'rx');
    }else{
      const tried=ECM_PROBE_CANDIDATES.map(c=>'0x'+hx(c.tx,3)).join(', ');
      setEcmAddr(ECM_PROBE_CANDIDATES[0]);
      addLog('✗ ECM did not respond on any candidate address. Tried: '+tried,'error');
      addLog('Falling back to default 0x7E0 — use Manual Address Override below if you know the ECM CAN ID.','warn');
    }
    addLog('Connected — ready for ECM ops','info');
  },[addLog]);

  const rediscover=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setDiscovering(true);
    addLog('═══ ECM ADDRESS DISCOVERY ═══','info');
    const found=await discoverEcm(eng.current,addLog,hx);
    setDiscovering(false);
    if(found){
      setEcmAddr(found);
      addLog('✓ ECM found at '+found.name+' — TX 0x'+hx(found.tx,3)+' / RX 0x'+hx(found.rx,3),'rx');
    }else{
      const tried=ECM_PROBE_CANDIDATES.map(c=>'0x'+hx(c.tx,3)).join(', ');
      addLog('✗ ECM did not respond on any candidate address. Tried: '+tried,'error');
    }
  },[addLog]);

  const applyManualAddr=useCallback(()=>{
    const raw=manualAddr.trim();
    if(!raw){addLog('Enter a hex CAN ID (e.g. 7E0 or 7E0/7E8)','error');return;}
    const parts=raw.split(/[\/,\s]+/).filter(Boolean);
    const tx=parseInt(parts[0].replace(/^0x/i,''),16);
    if(isNaN(tx)||tx<0||tx>0x7FF){addLog('Invalid TX address — enter an 11-bit hex CAN ID like 7E0','error');return;}
    let rx;
    if(parts[1]!==undefined){
      rx=parseInt(parts[1].replace(/^0x/i,''),16);
      if(isNaN(rx)||rx<0||rx>0x7FF){addLog('Invalid RX address — enter an 11-bit hex CAN ID like 7E8','error');return;}
    }else{
      rx=(tx+8)&0x7FF;
    }
    setEcmAddr({tx,rx,name:'Manual override'});
    addLog('Manual ECM address set — TX 0x'+hx(tx,3)+' / RX 0x'+hx(rx,3),'info');
  },[manualAddr,addLog]);

  const disconnect=useCallback(()=>{setConn(false);setUnlocked(false);eng.current=null;addLog('Disconnected','info');},[addLog]);

  const testConnection=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Testing connection...');
    addLog('═══ ECM CONNECTION TEST ═══','info');
    addLog('TesterPresent (3E 00)...','info');
    const tp=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.testerPresent({subFunction:0x00}));
    if(tp.ok&&tp.d&&tp.d[0]===0x7E)addLog('✓ ECM is alive','rx');
    else addLog('✗ ECM not responding on 0x'+hx(ecmAddr.tx,3),'error');
    addLog('Read VIN 0xF190 (22 F1 90)...','info');
    const v1=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.readDataByIdentifier({dids:[0xF190]}));
    if(v1.ok&&v1.d&&v1.d[0]===0x62){
      const v=parseVinFromResponse(v1.d);if(v){setCurVin(v);addLog('✓ VIN readable: '+v,'rx');}
    }else addLog('VIN read failed — try Read ECM Info','warn');
    addLog('═══ TEST COMPLETE ═══','info');
    setBusy('');
  },[addLog,ecmAddr]);

  const readInfo=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading ECM info...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.diagnosticSessionControl({session:0x03}));
    const info={};
    const reads=[
      {did:0xF190,label:'VIN'},{did:0xF187,label:'Part Number'},
      {did:0xF189,label:'Software Version'},{did:0xF18C,label:'Serial Number'},
      {did:0xF191,label:'Hardware Number'},{did:0xF194,label:'Software Fingerprint'},
      {did:0xF195,label:'Cal ID'},
    ];
    for(const r of reads){
      const res=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.readDataByIdentifier({dids:[r.did]}));
      if(res.ok&&res.d&&res.d[0]===0x62){
        const data=Array.from(res.d).slice(3);
        const ascii=data.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('').trim();
        const hex=data.map(b=>hx(b)).join(' ');
        info[r.did]={label:r.label,ascii,hex};
        addLog(r.label+' (0x'+hx(r.did,4)+'): '+(ascii||hex),'rx');
        if(r.did===0xF190)setCurVin(ascii.slice(-17));
      }else addLog(r.label+' (0x'+hx(r.did,4)+'): no response','warn');
    }
    setEcmInfo(info);setBusy('');
  },[addLog,ecmAddr]);

  const readVin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VIN...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.diagnosticSessionControl({session:0x03}));
    const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.readDataByIdentifier({dids:[0xF190]}));
    if(r.ok){const v=parseVinFromResponse(r.d);if(v){setCurVin(v);addLog('VIN: '+v,'rx');}else addLog('VIN parse failed','warn');}
    else addLog('VIN read failed','error');
    setBusy('');
  },[addLog,ecmAddr]);

  const unlockEcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking ECM (auto-trying all algos)...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.diagnosticSessionControl({session:0x03}));
    let s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.securityAccess({subFunction:0x01}));
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    let sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    let idx=0;
    for(const a of ECM_ALGOS){
      idx++;
      const k=a.fn(sv);
      addLog('['+idx+'/'+ECM_ALGOS.length+'] Try '+a.n+' key=0x'+hx(k,8)+'...','info');
      const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.securityAccess({subFunction:0x02,data:[(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]}));
      if(r.ok&&r.d&&r.d[0]===0x67){
        addLog('✓ UNLOCKED with '+a.n+' (algo '+idx+'/'+ECM_ALGOS.length+')','rx');
        setUnlocked(true);setAlgo(a.n);setBusy('');return;
      }
      if(r.ok&&r.d&&r.d[0]===0x7F)addLog('   '+a.n+' rejected: '+decodeNRC(r.d[2]||0),'warn');
      else addLog('   '+a.n+' no response','warn');
      await new Promise(r=>setTimeout(r,300));
      s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,build.securityAccess({subFunction:0x01}));
      if(s.ok&&s.d&&s.d.length>=4){sb=Array.from(s.d).slice(-4);sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);}
      else{addLog('Re-seed failed — module may be timed-out','warn');break;}
    }
    addLog('All '+ECM_ALGOS.length+' algorithms failed — ECM may need different platform algo','error');
    setBusy('');
  },[addLog,ecmAddr]);

  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock ECM first','error');return;}
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin;
    setBusy('Writing ECM VIN...');
    updateStatus('ECM','writing');
    addLog('═══ ECM VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Verifier: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    // Bridge engine when SGW-routed; programVin replays the registry's
    // 10-algo GPEC platform sweep on the chosen channel.
    const sgwReq=vinHasSGW(masterVin);
    let activeEng=eng.current;
    if(sgwReq){
      // See BcmTab.executeWriteVin for rationale — bridge reachability
      // is necessary but not sufficient; the SGW must be unlocked first.
      if(!isSgwAuthenticated(masterVin)){
        addLog('🛑 SGW REQUIRED but not authenticated for this VIN','error');
        addLog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.','error');
        updateStatus('ECM','fail');setBusy('');return;
      }
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        updateStatus('ECM','fail');setBusy('');return;
      }
      activeEng=br.engine;
    }
    // Pin the registry row's tx/rx to the discovered/manual ECM address so
    // VIN write, preflight, unlock, and verify all target the resolved
    // module — not the hardcoded 0x7E0/0x7E8 registry default.
    const row={...getRow('ECM'),tx:ecmAddr.tx,rx:ecmAddr.rx};
    addLog('Targeting ECM at TX 0x'+hx(ecmAddr.tx,3)+' / RX 0x'+hx(ecmAddr.rx,3)+' ('+ecmAddr.name+')','info');
    const r=await programVin({
      eng:activeEng, row, vin:masterVin,
      addLog:(m,t)=>addLog(m,t),
      makeBackup: async ({uds,snapshotKind,preWriteKey})=>backupModule(uds,ecmAddr.tx,ecmAddr.rx,'ECM',addLog,snapshotKind,preWriteKey),
    });
    const f190=r.didResults.find(d=>d.did===0xF190);
    setCurVin(f190?.readback||null);
    updateStatus('ECM',r.ok?'ok':'fail');
    setBusy('');
  },[masterVin,addLog,updateStatus,curVin,algo,ecmAddr]);

  const vinValid=masterVin.length===17;

  return <div>
    {showConfirmModal&&<ReadFirstModal
      module="ECM"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVin},
        {label:'Part Number',value:ecmInfo[0xF187]?.ascii},
        {label:'Software Version',value:ecmInfo[0xF189]?.ascii},
        {label:'Calibration ID',value:ecmInfo[0xF195]?.ascii},
        {label:'Module Address',value:'TX 0x'+hx(ecmAddr.tx,3)+' / RX 0x'+hx(ecmAddr.rx,3)},
        {label:'Unlock Algorithm',value:algo||'(not unlocked)'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}
    <Card style={{background:'linear-gradient(135deg,#3D2D0A 0%,#8B6B00 40%,#FFB300 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>⚡</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>ECM PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>ENGINE CONTROL MODULE · VIN · 10 ALGORITHMS</div>
          {vehicle&&<div style={{marginTop:8,padding:'6px 10px',background:'rgba(0,0,0,0.3)',borderRadius:8,display:'inline-block'}}>
            <div style={{fontSize:11,fontWeight:800,letterSpacing:1.5,color:'rgba(255,255,255,0.9)'}}>{vehicle.full} — {vehicle.body}</div>
            <div style={{fontSize:10,color:'rgba(255,255,255,0.6)',marginTop:3,fontFamily:"'JetBrains Mono'"}}>{vehicle.generations.length} generation{vehicle.generations.length===1?'':'s'} · ECM address auto-discovered on connect (default 0x7E0/0x7E8)</div>
          </div>}
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
            {!conn?'○ DISCONNECTED':discovering?'◌ DISCOVERING…':unlocked?'● UNLOCKED ('+algo+')':'● CONNECTED'}
          </div>
          {conn&&<div style={{marginTop:6,fontSize:9,color:'rgba(255,255,255,0.85)',fontFamily:"'JetBrains Mono'",letterSpacing:0.5}}>
            {discovering?'probing candidates…':ecmAddr.name+' · TX 0x'+hx(ecmAddr.tx,3)+' / RX 0x'+hx(ecmAddr.rx,3)}
          </div>}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.wn}>🔌 Connect Adapter</Btn>}
        {conn&&<Btn onClick={disconnect} outline color={C.ts}>Disconnect</Btn>}
        {conn&&<Btn onClick={testConnection} disabled={!!busy} color={C.gn}>🧪 Test Connection</Btn>}
        {conn&&<Btn onClick={readInfo} disabled={!!busy} color={C.a2}>📖 Read ECM Info</Btn>}
        {conn&&<Btn onClick={readVin} disabled={!!busy} color={C.a3} outline>📖 Read VIN</Btn>}
        {conn&&<Btn onClick={unlockEcm} disabled={!!busy} color={C.a4}>🔓 Unlock (Auto-Try All 10)</Btn>}
        {conn&&<Btn onClick={rediscover} disabled={!!busy||discovering} color={C.a3} outline>🎯 Re-discover Address</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.sr}>💾 Write Master VIN</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        ECM at TX 0x{hx(ecmAddr.tx,3)} · RX 0x{hx(ecmAddr.rx,3)} · {ecmAddr.name} · {ECM_ALGOS.length} algorithms ready
      </div>
      <div style={{marginTop:12,paddingTop:12,borderTop:'1px dashed '+C.bd}}>
        <div style={{fontSize:10,fontWeight:800,color:C.ts,letterSpacing:1,marginBottom:6}}>MANUAL ADDRESS OVERRIDE</div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <input
            value={manualAddr}
            onChange={e=>setManualAddr(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter')applyManualAddr();}}
            placeholder="e.g. 7E0 or 7E0/7E8"
            style={{padding:'7px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11,width:160}}
          />
          <Btn onClick={applyManualAddr} color={C.a4} outline>Set Address</Btn>
          <span style={{fontSize:10,color:C.tm,fontStyle:'italic'}}>For non-standard ECM CAN IDs not covered by auto-discovery. RX defaults to TX+8 unless specified.</span>
        </div>
        <div style={{marginTop:8,fontSize:9,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
          Probe order: {ECM_PROBE_CANDIDATES.map(c=>'0x'+hx(c.tx,3)).join(' → ')}
        </div>
      </div>
    </Card>

    {Object.keys(ecmInfo).length>0&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>🔍 ECM DATA</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:6}}>
        {Object.entries(ecmInfo).map(([did,info])=>(
          <div key={did} style={{padding:8,background:'#F8F6F2',borderRadius:6,fontSize:11}}>
            <div style={{color:C.ts,fontWeight:700}}>{info.label} (DID 0x{hx(parseInt(did),4)})</div>
            <div style={{fontFamily:"'JetBrains Mono'",marginTop:2,color:C.tx,fontWeight:700}}>{info.ascii||info.hex}</div>
          </div>
        ))}
      </div>
    </Card>}

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      <div style={{padding:12,background:curVin===masterVin?'#E8F5E9':curVin?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(curVin===masterVin?C.gn:curVin?C.wn:C.bd)}}>
        <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>Current VIN on ECM (DID 0xF190)</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4}}>{curVin||'(not read)'}</div>
        {curVin&&masterVin&&curVin===masterVin&&<div style={{fontSize:10,color:C.gn,marginTop:4}}>✓ matches Master VIN</div>}
        {curVin&&masterVin&&curVin!==masterVin&&<div style={{fontSize:10,color:C.wn,marginTop:4}}>⚠ differs from Master VIN ({masterVin})</div>}
      </div>
    </Card>

    <DumpDropArea onFile={onInspectFile} accent={C.wn} hint="⬇ Drop ECM .bin anywhere on this card" style={{marginBottom:14}}>
    <Card>
      <div style={{fontWeight:800,fontSize:11,color:C.wn,marginBottom:10,letterSpacing:2}}>🔍 ECM DUMP INSPECTOR</div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <DumpDropZone onFile={onInspectFile} accent={C.wn} label="📂 Load ECM .bin (or drop here)"/>
        {ecmDumps.length>1&&<select value={inspectEntry?.hash||''} onChange={e=>setInspectHash(e.target.value)}
          style={{padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11}}>
          {ecmDumps.map(d=><option key={d.hash} value={d.hash}>{d.filename}</option>)}
        </select>}
        {ecmInspectMod&&<>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts}}>{ecmInspectMod.filename} · {(ecmInspectMod.size/1024).toFixed(1)} KB</span>
          {inspectEntry?.source&&<span style={{fontSize:9,fontWeight:800,padding:'2px 8px',borderRadius:6,background:C.c2,color:C.ts,border:'1px solid '+C.bd,letterSpacing:0.5,textTransform:'uppercase'}}>Loaded from {inspectEntry.source}</span>}
          <button onClick={closeInspect} style={{border:'none',background:'transparent',color:C.tm,cursor:'pointer',fontSize:14}} title="Remove from workspace">✕</button>
        </>}
      </div>
      {!ecmInspectMod&&ecmDumps.length===0&&!inspectTooSmall&&!inspectMsg&&<div style={{marginTop:8,fontSize:11,color:C.tm,fontStyle:'italic'}}>Tip: dumps loaded in the Dumps tab show up here automatically.</div>}
      {ecmInspectMod&&ecmDumps.length>0&&<div style={{marginTop:6,fontSize:10,color:C.gn,fontWeight:700}}>✓ Auto-loaded from shared workspace ({ecmDumps.length} GPEC2A dump{ecmDumps.length===1?'':'s'} available)</div>}
      {inspectErr&&<div style={{marginTop:8,padding:'8px 12px',borderRadius:8,background:C.er+'12',border:'1px solid '+C.er+'40',fontSize:11,fontWeight:700,color:C.er}}>{inspectErr}</div>}
      {inspectMsg&&<div style={{marginTop:8,fontSize:11,color:C.wn,fontWeight:700}}>{inspectMsg}</div>}
      {inspectTooSmall&&<div style={{marginTop:12,padding:'14px 16px',borderRadius:10,background:'rgba(255,23,68,0.07)',border:'2px solid '+C.er}}>
        <div style={{fontWeight:900,fontSize:13,color:C.er,letterSpacing:1.2,textTransform:'uppercase',marginBottom:8}}>⛔ This isn't a full ECM dump</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts,lineHeight:1.7}}>
          <div>File size: <strong style={{color:C.er}}>{inspectTooSmall.size.toLocaleString()} bytes</strong></div>
          <div>Required min: <strong>{inspectTooSmall.min.toLocaleString()} bytes</strong> — {inspectTooSmall.label}</div>
        </div>
      </div>}
      <CorruptDumpBanner mod={ecmInspectMod} testid="ecm-corrupt-dump-banner"/>
      {ecmInspectMod&&ecmInspectMod.data&&!ecmInspectMod.corruptFill&&<div style={{marginTop:12}}>
        <IdentityCard bytes={ecmInspectMod.data}/>
      </div>}
      {ecmInspectMod&&ecmInspectMod.data&&!ecmInspectMod.corruptFill&&ecmInspectMod.type==='GPEC2A'&&
        <Gpec2aImmoPanel mod={ecmInspectMod} donorMods={donorMods}/>}
    </Card>
    </DumpDropArea>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:'#FFB300',letterSpacing:2}}>📋 ECM LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:'#666',background:'transparent',border:'1px solid #333',padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div style={{maxHeight:340,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Connect adapter to begin</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}
