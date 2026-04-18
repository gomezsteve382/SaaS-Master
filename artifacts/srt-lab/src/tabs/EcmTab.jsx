import React, {useState, useCallback, useRef} from "react";
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {initAdapter, parseVinFromResponse} from '../lib/initAdapter.js';
import {decodeNRC} from '../lib/nrc.js';
import {backupModule} from '../lib/backups.js';
import {logSession} from '../lib/paperTrail.js';
import {ReadFirstModal} from '../lib/readFirstModal.jsx';
import {useMasterVin} from '../lib/masterVinContext.jsx';
import {ECM_ALGOS, u32} from '../lib/programmerData.js';
import {vinHasSGW} from '../lib/vin.js';
import {createBridgeEngine, reUnlockSeedKey} from '../lib/bridgeEngine.js';

export default function EcmTab(){
  const{vin:masterVin,updateStatus}=useMasterVin();
  const[conn,setConn]=useState(false);const[unlocked,setUnlocked]=useState(false);
  const[busy,setBusy]=useState('');const[log,setLog]=useState([]);
  const[curVin,setCurVin]=useState(null);const[ecmInfo,setEcmInfo]=useState({});
  const[algo,setAlgo]=useState('');const[showConfirmModal,setShowConfirmModal]=useState(false);
  const ecmAddr={tx:0x7E0,rx:0x7E8};
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for ECM ops','info');}
  },[addLog]);

  const disconnect=useCallback(()=>{setConn(false);setUnlocked(false);eng.current=null;addLog('Disconnected','info');},[addLog]);

  const testConnection=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Testing connection...');
    addLog('═══ ECM CONNECTION TEST ═══','info');
    addLog('TesterPresent (3E 00)...','info');
    const tp=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x3E,0x00]);
    if(tp.ok&&tp.d&&tp.d[0]===0x7E)addLog('✓ ECM is alive','rx');
    else addLog('✗ ECM not responding on 0x'+hx(ecmAddr.tx,3),'error');
    addLog('Read VIN 0xF190 (22 F1 90)...','info');
    const v1=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x22,0xF1,0x90]);
    if(v1.ok&&v1.d&&v1.d[0]===0x62){
      const v=parseVinFromResponse(v1.d);if(v){setCurVin(v);addLog('✓ VIN readable: '+v,'rx');}
    }else addLog('VIN read failed — try Read ECM Info','warn');
    addLog('═══ TEST COMPLETE ═══','info');
    setBusy('');
  },[addLog]);

  const readInfo=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading ECM info...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x10,0x03]);
    const info={};
    const reads=[
      {did:0xF190,label:'VIN'},{did:0xF187,label:'Part Number'},
      {did:0xF189,label:'Software Version'},{did:0xF18C,label:'Serial Number'},
      {did:0xF191,label:'Hardware Number'},{did:0xF194,label:'Software Fingerprint'},
      {did:0xF195,label:'Cal ID'},
    ];
    for(const r of reads){
      const res=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x22,(r.did>>8)&0xFF,r.did&0xFF]);
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
  },[addLog]);

  const readVin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VIN...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x10,0x03]);
    const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x22,0xF1,0x90]);
    if(r.ok){const v=parseVinFromResponse(r.d);if(v){setCurVin(v);addLog('VIN: '+v,'rx');}else addLog('VIN parse failed','warn');}
    else addLog('VIN read failed','error');
    setBusy('');
  },[addLog]);

  const unlockEcm=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking ECM (auto-trying all algos)...');
    await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x10,0x03]);
    let s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    let sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    let idx=0;
    for(const a of ECM_ALGOS){
      idx++;
      const k=a.fn(sv);
      addLog('['+idx+'/'+ECM_ALGOS.length+'] Try '+a.n+' key=0x'+hx(k,8)+'...','info');
      const r=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
      if(r.ok&&r.d&&r.d[0]===0x67){
        addLog('✓ UNLOCKED with '+a.n+' (algo '+idx+'/'+ECM_ALGOS.length+')','rx');
        setUnlocked(true);setAlgo(a.n);setBusy('');return;
      }
      if(r.ok&&r.d&&r.d[0]===0x7F)addLog('   '+a.n+' rejected: '+decodeNRC(r.d[2]||0),'warn');
      else addLog('   '+a.n+' no response','warn');
      await new Promise(r=>setTimeout(r,300));
      s=await eng.current.uds(ecmAddr.tx,ecmAddr.rx,[0x27,0x01]);
      if(s.ok&&s.d&&s.d.length>=4){sb=Array.from(s.d).slice(-4);sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);}
      else{addLog('Re-seed failed — module may be timed-out','warn');break;}
    }
    addLog('All '+ECM_ALGOS.length+' algorithms failed — ECM may need different platform algo','error');
    setBusy('');
  },[addLog]);

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
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    const sgwReq=vinHasSGW(masterVin);
    let activeEng=eng.current;
    if(sgwReq){
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        updateStatus('ECM','fail');setBusy('');return;
      }
      activeEng=br.engine;
      const algoEntry=ECM_ALGOS.find(a=>a.n===algo);
      if(!algoEntry){
        addLog('🛑 SGW required but no successful sim-channel unlock to replay — run Unlock first','error');
        updateStatus('ECM','fail');setBusy('');return;
      }
      const ru=await reUnlockSeedKey(activeEng,ecmAddr.tx,ecmAddr.rx,algoEntry.fn,{addLog,hx});
      if(!ru.ok){
        addLog('🛑 Bridge re-unlock failed: '+ru.error,'error');
        addLog('Aborting write — ECM is still locked on the bridge channel.','error');
        updateStatus('ECM','fail');setBusy('');return;
      }
    }
    addLog('Creating safety backup before write...','info');
    await backupModule(activeEng.uds,ecmAddr.tx,ecmAddr.rx,'ECM',addLog,hx);
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    const r=await activeEng.uds(ecmAddr.tx,ecmAddr.rx,[0x2E,0xF1,0x90,...vb]);
    let ok=false;
    if(r.ok&&r.d&&r.d[0]===0x6E){ok=true;addLog('✓ VIN written','rx');}
    else if(r.ok&&r.d&&r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'error');
    else addLog('Write failed','error');
    const vr=await activeEng.uds(ecmAddr.tx,ecmAddr.rx,[0x22,0xF1,0x90]);
    const v=vr.ok?parseVinFromResponse(vr.d):null;
    setCurVin(v);
    const match=v===masterVin;
    addLog(match?'✓ VERIFIED':'✗ VERIFY FAIL: '+(v||'no response'),match?'rx':'warn');
    updateStatus('ECM',(ok&&match)?'ok':'fail');
    logSession({
      module:'ECM',operation:'VIN Write',oldVin:oldVinSnapshot,newVin:masterVin,
      moduleAddr:{tx:ecmAddr.tx,rx:ecmAddr.rx},adapter:activeEng?.adapter||eng.current.adapter||'ELM327/STN',
      sgwRouted:sgwReq,
      algorithm:algo,success:ok&&match,
      technician:confirmData.technician,titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,preWriteConfirmed:confirmData.preWriteConfirmed,
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[masterVin,addLog,updateStatus,curVin,algo]);

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
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED ('+algo+')':'● CONNECTED'}
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
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.sr}>💾 Write Master VIN</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        ECM at TX 0x{hx(ecmAddr.tx,3)} · RX 0x{hx(ecmAddr.rx,3)} · {ECM_ALGOS.length} algorithms ready
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
