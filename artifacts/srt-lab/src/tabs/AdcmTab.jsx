import React, {useState, useCallback, useMemo, useRef, useEffect} from "react";
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {initAdapter, parseVinFromResponse} from '../lib/initAdapter.js';
import {decodeNRC} from '../lib/nrc.js';
import {backupModule} from '../lib/backups.js';
import {ReadFirstModal} from '../lib/readFirstModal.jsx';
import {useMasterVin} from '../lib/masterVinContext.jsx';
import {ADCM_VARIANTS, ADCM_MODULES, u32} from '../lib/programmerData.js';
import {isSgwAuthenticated} from '../lib/sgwAuth.js';
import {vinHasSGW} from '../lib/vin.js';
import {createBridgeEngine} from '../lib/bridgeEngine.js';
import {getRow} from '../lib/moduleRegistry.js';
import {programVin} from '../lib/vinProgrammer.js';
import {parseDtcResponse, formatDtcLogLine, buildDtcDetail} from '../lib/dtc.js';

export default function AdcmTab(){
  const{vin:masterVin,updateStatus}=useMasterVin();
  const[conn,setConn]=useState(false);const[busy,setBusy]=useState('');
  const[log,setLog]=useState([]);const[mod,setMod]=useState(ADCM_MODULES[2]);
  const[curVinF190,setCurVinF190]=useState('');const[curVin7B90,setCurVin7B90]=useState('');
  const[variant,setVariant]=useState(ADCM_VARIANTS[0].id);const[unlocked,setUnlocked]=useState(false);
  const[dtcs,setDtcs]=useState([]);
  const[showConfirmModal,setShowConfirmModal]=useState(false);
  const eng=useRef(null);const[adapter,setAdapter]=useState('');
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  /* Local VIN entry — defaults to Master VIN when present */
  const[vin,setVin]=useState('');
  useEffect(()=>{if(masterVin&&masterVin.length===17)setVin(masterVin);},[masterVin]);

  /* Report status back to MasterVinContext */
  useEffect(()=>{
    if(curVinF190&&masterVin&&curVinF190===masterVin)updateStatus('ADCM','ok');
  },[curVinF190,masterVin,updateStatus]);

  /* SBEC fallback (for ADM/SDM if Routine 0x0312 fails) */
  const sbecKey=(seed)=>u32((seed*4+0x9018));

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setAdapter(e.adapter||'');setConn(true);addLog('Connected — ready for ADCM ops','info');}
  },[addLog]);

  const disconnect=useCallback(()=>{setConn(false);setUnlocked(false);eng.current=null;addLog('Disconnected','info');},[addLog]);

  const readVinDid=useCallback(async(did,label)=>{
    if(!eng.current)return null;
    const r=await eng.current.uds(mod.tx,mod.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
    if(r.ok&&r.d&&r.d.length>=3){
      const v=parseVinFromResponse(r.d);
      if(v){addLog(label+' = '+v,'rx');return v;}
    }
    addLog(label+' (DID 0x'+hx(did,4)+'): no response','warn');return null;
  },[mod,addLog]);

  const readBothVins=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VINs...');
    addLog('Entering extended session (10 03)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    addLog('─── Reading VINs from '+mod.id+' ───','info');
    const v1=await readVinDid(0xF190,'DID 0xF190 (Primary VIN)');
    const v2=await readVinDid(0x7B90,'DID 0x7B90 (Current VIN)');
    setCurVinF190(v1||'');setCurVin7B90(v2||'');
    setBusy('');
  },[mod,readVinDid,addLog]);

  const testConnection=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Testing connection...');
    addLog('═══ ADCM CONNECTION TEST ═══','info');
    addLog('1. TesterPresent (3E 00)...','info');
    const tp=await eng.current.uds(mod.tx,mod.rx,[0x3E,0x00]);
    if(tp.ok&&tp.d&&tp.d[0]===0x7E)addLog('✓ Module is alive','rx');
    else{addLog('✗ TesterPresent failed — module not responding on 0x'+hx(mod.tx,3),'error');setBusy('');return;}
    addLog('2. Read VIN 0xF190 (22 F1 90)...','info');
    const v1=await eng.current.uds(mod.tx,mod.rx,[0x22,0xF1,0x90]);
    if(v1.ok&&v1.d&&v1.d[0]===0x62){
      const vinStr=parseVinFromResponse(v1.d);
      if(vinStr){addLog('✓ VIN readable: '+vinStr,'rx');setCurVinF190(vinStr);}
    }else addLog('✗ VIN read failed — DID 0xF190 not supported or session needed','warn');
    addLog('3. Extended session (10 03)...','info');
    const ds=await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    if(ds.ok&&ds.d&&ds.d[0]===0x50)addLog('✓ Extended session OK','rx');
    else addLog('✗ Session failed','warn');
    addLog('═══ TEST COMPLETE ═══','info');
    setBusy('');
  },[mod,addLog]);

  const startRoutine=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Starting routine 0x0312...');
    addLog('─── ADCM Unlock Sequence ───','info');
    addLog('Extended session (10 03)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x10,0x03]);
    addLog('TesterPresent (3E 80)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x3E,0x80]);
    addLog('Start Routine 0x0312 (31 01 03 12)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x31,0x01,0x03,0x12]);
    if(r.ok&&r.d&&r.d[0]===0x71){
      addLog('✓ Routine 0x0312 accepted — '+mod.id+' config unlocked','rx');setUnlocked(true);
    }else{
      addLog('Routine 0x0312 rejected — trying SBEC seed-key fallback','warn');
      const s=await eng.current.uds(mod.tx,mod.rx,[0x27,0x01]);
      if(s.ok&&s.d&&s.d.length>=4){
        const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        addLog('Seed: 0x'+hx(sv,8),'info');
        const k=sbecKey(sv);addLog('SBEC Key: 0x'+hx(k,8)+' [(seed*4)+0x9018]','info');
        const kr=await eng.current.uds(mod.tx,mod.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
        if(kr.ok&&kr.d&&kr.d[0]===0x67){addLog('✓ SBEC unlock succeeded','rx');setUnlocked(true);}
        else addLog('Both routine and SBEC failed — check CAN address','error');
      }
    }
    setBusy('');
  },[mod,addLog]);

  const refreshUnlock=useCallback(async()=>{
    addLog('Refreshing session (3E 00 + 31 01 03 12)...','info');
    await eng.current.uds(mod.tx,mod.rx,[0x3E,0x00]);
    const r=await eng.current.uds(mod.tx,mod.rx,[0x31,0x01,0x03,0x12]);
    if(r.ok&&r.d&&r.d[0]===0x71){addLog('✓ Session refreshed','rx');return true;}
    addLog('Session refresh failed','warn');return false;
  },[mod,addLog]);

  const writeVinToDid=useCallback(async(did,label)=>{
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN first','error');return false;}
    const vb=Array.from(vin.toUpperCase()).map(c=>c.charCodeAt(0));
    addLog('Writing '+label+' (2E '+hx((did>>8)&0xFF)+' '+hx(did&0xFF)+' + 17 VIN bytes)...','info');
    let r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
    if(r.ok&&r.d&&r.d[0]===0x7F){
      const nrc=r.d.length>2?r.d[2]:0;
      addLog('✗ '+label+' NRC: '+decodeNRC(nrc),'error');
      if(nrc===0x33){
        addLog('Attempting auto-recovery — refreshing unlock...','warn');
        if(await refreshUnlock()){
          await new Promise(r=>setTimeout(r,300));
          addLog('Retry '+label+'...','info');
          r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);
        }
      }
    }
    if(r.ok&&r.d&&r.d[0]===0x6E){addLog('✓ '+label+' written OK','rx');return true;}
    if(r.ok&&r.d&&r.d[0]===0x7F)return false;
    addLog('✗ '+label+' write failed: '+(r.raw||'no response'),'error');return false;
  },[vin,mod,addLog,refreshUnlock]);

  const writeBothVins=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN','error');return;}
    if(!unlocked){addLog('Run Start Routine 0x0312 first to unlock','error');return;}
    setShowConfirmModal(true);
  },[vin,unlocked,addLog]);

  const executeWriteBothVins=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinF190=curVinF190,oldVin7B90=curVin7B90;
    setBusy('Writing all VIN DIDs...');
    updateStatus('ADCM','writing');
    addLog('═══ WRITING VINs TO '+mod.id+' ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    const target=vin.toUpperCase();
    // Pick the engine for this write (bridge if SGW-routed). The registry
    // row carries the Routine 0x0312 pre-unlock + SBEC fallback chain so
    // programVin reproduces both paths on whichever channel we hand it.
    const sgwReq=vinHasSGW(masterVin);
    const realEng=eng.current;
    let activeEng=realEng;
    if(sgwReq){
      // See BcmTab.executeWriteVin for rationale — bridge reachability
      // is necessary but not sufficient; the SGW must be unlocked first.
      if(!isSgwAuthenticated(masterVin)){
        addLog('🛑 SGW REQUIRED but not authenticated for this VIN','error');
        addLog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.','error');
        updateStatus('ADCM','fail');setBusy('');return;
      }
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        updateStatus('ADCM','fail');setBusy('');return;
      }
      activeEng=br.engine;
    }

    // ADCM_MODULES exposes alt CAN addresses (ADM/SDM); pin tx/rx so the
    // engine targets the user-selected variant rather than the registry's
    // canonical 0x7A8/0x7B0.
    const row={...getRow('ADCM'),tx:mod.tx,rx:mod.rx};
    const r=await programVin({
      eng:activeEng, row, vin:target,
      addLog:(m,t)=>addLog(m,t),
      makeBackup: async ({uds,snapshotKind,preWriteKey})=>backupModule(uds,mod.tx,mod.rx,'ADCM',addLog,hx,snapshotKind,preWriteKey),
    });
    const f190=r.didResults.find(d=>d.did===0xF190);
    const v7b90=r.didResults.find(d=>d.did===0x7B90);
    const v7b88=r.didResults.find(d=>d.did===0x7B88);
    setCurVinF190(f190?.readback||'');
    setCurVin7B90(v7b90?.readback||'');
    updateStatus('ADCM',r.ok?'ok':'fail');
    setBusy('');
  },[vin,mod,addLog,curVinF190,curVin7B90,updateStatus,masterVin]);

  const writeVariant=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!unlocked){addLog('Run Start Routine 0x0312 first','error');return;}
    const v=ADCM_VARIANTS.find(x=>x.id===variant);if(!v)return;
    setBusy('Writing vehicle variant...');
    addLog('─── Configuring '+mod.id+' for '+v.n+' ───','info');
    const cfgDids=[
      {did:0xF1A1,label:'Suspension Mode',val:[v.code]},
      {did:0xDE10,label:'Vehicle Config', val:[v.code]},
      {did:0xDE11,label:'Variant Code',   val:[v.code,0x00]},
    ];
    for(const c of cfgDids){
      addLog('Writing '+c.label+' (DID 0x'+hx(c.did,4)+')='+c.val.map(b=>'0x'+hx(b)).join(' ')+'...','info');
      const r=await eng.current.uds(mod.tx,mod.rx,[0x2E,(c.did>>8)&0xFF,c.did&0xFF,...c.val]);
      if(r.ok&&r.d&&r.d[0]===0x6E)addLog('✓ '+c.label+' written','rx');
      else if(r.ok&&r.d&&r.d[0]===0x7F)addLog('  '+c.label+' NRC: '+decodeNRC(r.d[2]||0),'warn');
      else addLog('  '+c.label+' not supported / no response','warn');
      await new Promise(r=>setTimeout(r,150));
    }
    addLog('Variant configuration complete for '+v.n,'info');
    setBusy('');
  },[variant,mod,unlocked,addLog]);

  const readDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading DTCs...');
    addLog('ReadDTCInformation (19 02 08)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x19,0x02,0x08]);
    if(r.ok&&r.d){
      /* Shared parser/log formatter from ../lib/dtc.js — same plain-
         English overlay as the UDS Programmer tab. Description is
         pulled from FAULTS_BY_HEX (currently empty until Task T1
         lands a clean .db) with a "(unknown)" fallback. */
      const entries=parseDtcResponse(r.d);
      const list=entries.map(e=>buildDtcDetail(e,{tx:mod.tx,rx:mod.rx}));
      for(const e of entries){addLog(formatDtcLogLine(e),'warn');}
      setDtcs(list);
      if(!list.length)addLog('✓ No DTCs stored','rx');
    }
    setBusy('');
  },[mod,addLog]);

  const clearDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Clearing DTCs...');
    addLog('ClearDiagnosticInformation (14 FF FF FF)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x14,0xFF,0xFF,0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x54){addLog('✓ DTCs cleared','rx');setDtcs([]);}
    else addLog('Clear failed: '+(r.raw||'no response'),'error');
    setBusy('');
  },[mod,addLog]);

  const ecuReset=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Resetting ECU...');
    addLog('ECUReset hard (11 01)...','info');
    const r=await eng.current.uds(mod.tx,mod.rx,[0x11,0x01]);
    if(r.ok&&r.d&&r.d[0]===0x51)addLog('✓ ECU reset accepted','rx');
    else addLog('Reset: '+(r.raw||'no response'),'warn');
    setUnlocked(false);setBusy('');
  },[mod,addLog]);

  const runFullSequence=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(!vin||vin.length!==17){addLog('Enter valid 17-char VIN','error');return;}
    setBusy('Running full sequence...');
    addLog('╔════════════════════════════════════╗','info');
    addLog('║   FULL ADCM PROGRAMMING SEQUENCE   ║','info');
    addLog('╚════════════════════════════════════╝','info');
    await startRoutine();await new Promise(r=>setTimeout(r,300));
    writeBothVins();
  },[vin,startRoutine,writeBothVins,addLog]);

  const vinValid=vin.length===17&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
  const vinIssue=useMemo(()=>{
    if(vin.length===0)return 'Enter 17-character VIN';
    if(vin.length<17)return 'Only '+vin.length+'/17 characters';
    if(vin.length>17)return 'Too long — max 17';
    const bad=['I','O','Q'];
    for(let i=0;i<vin.length;i++){
      const c=vin[i].toUpperCase();
      if(bad.includes(c))return 'Invalid char "'+c+'" at position '+(i+1)+' (I/O/Q not allowed)';
      if(!/[A-Z0-9]/.test(c))return 'Invalid char "'+vin[i]+'" at position '+(i+1);
    }
    return '✓ Valid VIN format';
  },[vin]);

  return <div>
    {showConfirmModal&&<ReadFirstModal
      module="ADCM"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVinF190},
        {label:'Current VIN (DID 0x7B90)',value:curVin7B90},
        {label:'Module',value:mod.id+' at TX 0x'+hx(mod.tx,3)+' / RX 0x'+hx(mod.rx,3)},
        {label:'Security',value:unlocked?'Unlocked (Routine 0x0312)':'Not unlocked'},
      ]}
      newVin={vin.toUpperCase()}
      onConfirm={executeWriteBothVins}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}

    <Card style={{background:'linear-gradient(135deg,#0A1A3D 0%,#1E3A6F 40%,#0066CC 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🏎️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>ACTIVE DAMPING</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>ADM · SDM · ADCM · VIN + VARIANT</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED':'● CONNECTED'}
        </div>
      </div>
      <div style={{fontSize:12,opacity:.85,marginTop:8}}>
        Dedicated Active Damping programming — writes VIN to F190 + 7B90 + 7B88 and configures vehicle variant. Routine 0x0312 unlock with SBEC fallback.
      </div>
    </Card>

    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
      <Card>
        <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>📡 MODULE</div>
        {ADCM_MODULES.map(m=>{
          const a=mod.id===m.id;
          return <div key={m.id} onClick={()=>setMod(m)} style={{padding:'10px 12px',marginBottom:6,borderRadius:8,cursor:'pointer',border:'2px solid '+(a?C.a3:C.bd),background:a?C.a3+'10':'#fff',transition:'all 0.2s'}}>
            <div style={{fontWeight:800,fontSize:13,color:a?C.a3:C.tx}}>{m.id} <span style={{fontSize:10,fontWeight:600,color:C.ts}}>TX:0x{hx(m.tx,3)} · RX:0x{hx(m.rx,3)}</span></div>
            <div style={{fontSize:11,color:C.ts,marginTop:2}}>{m.n}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:2,fontStyle:'italic'}}>{m.veh}</div>
          </div>;
        })}
      </Card>
      <Card>
        <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:2}}>🚗 VEHICLE VARIANT</div>
        <select value={variant} onChange={e=>setVariant(e.target.value)} style={{width:'100%',padding:'10px 12px',border:'1.5px solid '+C.bd,borderRadius:8,fontSize:13,fontFamily:"'Nunito'",fontWeight:700,marginBottom:10}}>
          {ADCM_VARIANTS.map(v=><option key={v.id} value={v.id}>{v.n}</option>)}
        </select>
        {(()=>{const v=ADCM_VARIANTS.find(x=>x.id===variant);return v&&<div style={{padding:10,background:'#F8F6F2',borderRadius:8,fontSize:11}}>
          <div style={{color:C.ts}}><b>Code:</b> 0x{hx(v.code)}</div>
          <div style={{color:C.ts,marginTop:3}}><b>Notes:</b> {v.notes}</div>
          <div style={{color:C.a1,marginTop:6,fontSize:10,fontStyle:'italic'}}>Writes to DID 0xF1A1, 0xDE10, 0xDE11</div>
        </div>;})()}
      </Card>
    </div>

    <Card style={{marginBottom:14}}>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        {!conn&&<Btn onClick={connect} color={C.a3}>🔌 Connect Adapter</Btn>}
        {conn&&<Btn onClick={disconnect} outline color={C.ts}>Disconnect</Btn>}
        {conn&&<Btn onClick={testConnection} disabled={!!busy} color={C.gn}>🧪 Test Connection</Btn>}
        {conn&&<Btn onClick={readBothVins} disabled={!!busy} color={C.a2}>📖 Read Both VINs</Btn>}
        {conn&&<Btn onClick={startRoutine} disabled={!!busy} color={C.a4}>🔓 Start Routine 0x0312</Btn>}
      </div>
      {adapter&&<div style={{marginTop:8,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>Adapter: {adapter} · Target: {mod.id} @ TX 0x{hx(mod.tx,3)} / RX 0x{hx(mod.rx,3)}</div>}
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:12,letterSpacing:2}}>🔑 VIN PROGRAMMING</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0xF190 (Primary)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4,color:curVinF190?C.tx:C.tm}}>{curVinF190||'(not read)'}</div>
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>DID 0x7B90 (Current)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4,color:curVin7B90?C.tx:C.tm}}>{curVin7B90||'(not read)'}</div>
        </div>
      </div>

      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <div style={{fontSize:11,color:C.ts,fontWeight:700}}>NEW VIN (17 characters) {masterVin&&masterVin===vin&&<span style={{color:C.gn}}>· from Master VIN</span>}</div>
          <div style={{fontSize:11,color:vin.length===17?C.gn:C.ts,fontFamily:"'JetBrains Mono'",fontWeight:700}}>{vin.length}/17</div>
        </div>
        <input value={vin} onChange={e=>setVin(e.target.value.toUpperCase().replace(/\s/g,'').slice(0,17))} maxLength={17} placeholder="2C3CDZFJ5NH123456" style={{width:'100%',padding:'12px 16px',border:'2px solid '+(vin.length===0?C.bd:vinValid?C.gn:C.er),borderRadius:10,fontSize:16,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:2}}/>
        <div style={{fontSize:10,color:vin.length===0?C.tm:vinValid?C.gn:C.er,marginTop:6}}>
          {vinValid?'✓ Valid VIN format':vinIssue}
        </div>
      </div>

      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <Btn onClick={writeBothVins} disabled={!!busy||!vinValid||!unlocked} color={C.sr}>💾 Write VINs (F190 + 7B90 + 7B88)</Btn>
        <Btn onClick={writeVariant} disabled={!!busy||!unlocked} color={C.a4}>🚗 Write Variant Config</Btn>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:12,letterSpacing:2}}>⚠️ DIAGNOSTIC TROUBLE CODES</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
        <Btn onClick={readDtcs} disabled={!!busy||!conn} color={C.a3} outline>📋 Read DTCs (19 02 08)</Btn>
        <Btn onClick={clearDtcs} disabled={!!busy||!conn} color={C.wn} outline>🗑️ Clear DTCs (14 FF FF FF)</Btn>
        <Btn onClick={ecuReset} disabled={!!busy||!conn} color={C.er} outline>⚡ ECU Reset (11 01)</Btn>
      </div>
      {dtcs.length>0?<div style={{padding:10,background:'#FFF8F0',border:'1px solid '+C.wn+'44',borderRadius:8}}>
        {dtcs.map((d,i)=><div key={i} style={{fontSize:12,padding:'3px 0',fontFamily:"'JetBrains Mono'"}}>⚠ {d.code} — {d.description||'(unknown)'} — status {d.statusHex} {d.statusSummary&&d.statusSummary!=='—'?'('+d.statusSummary+')':''}</div>)}
      </div>:<div style={{fontSize:11,color:C.tm,fontStyle:'italic'}}>No DTCs read yet</div>}
    </Card>

    <Card style={{marginBottom:14,background:'linear-gradient(135deg,#FFF8F0 0%,#FFE5CC 100%)',border:'2px solid '+C.a1}}>
      <div style={{fontWeight:800,fontSize:13,color:C.a1,marginBottom:8,letterSpacing:1}}>🚀 ONE-CLICK FULL SEQUENCE</div>
      <div style={{fontSize:11,color:C.ts,marginBottom:12}}>
        Runs: Routine 0x0312 → opens Read-First confirmation → Write VINs (F190/7B90/7B88) → verify
      </div>
      <Btn onClick={runFullSequence} disabled={!!busy||!vinValid||!conn} color={C.a1} full>
        {busy||'▶️ RUN FULL PROGRAMMING SEQUENCE'}
      </Btn>
    </Card>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:'#4FC3F7',letterSpacing:2}}>📋 ADCM LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:'#666',background:'transparent',border:'1px solid #333',padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div style={{maxHeight:380,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Connect adapter to begin</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}
