import React, {useState, useCallback, useRef, useContext} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {u32} from "../lib/algos.js";
import {initAdapter, parseVinFromResponse} from "../lib/initAdapter.js";
import {backupModule} from "../lib/backups.js";
import {logSession} from "../lib/paperTrail.js";
import {decodeNRC} from "../lib/nrc.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import ReadFirstModal from "../components/ReadFirstModal.jsx";
import ModuleHistoryPanel from "../components/ModuleHistoryPanel.jsx";

// VIN-specific RFHUB CRC algorithms (poly+init pairs derived from real dumps).
// Used as a hint shown to the user; the actual write goes through UDS so the
// RFHUB firmware computes the CRC on flash itself.
const RFHUB_KNOWN_ALGOS={
  '2C3CDXKT3FH796320':{poly:0x589B,init:0xFFFF},
  '2B3CJ4DV6AH300549':{poly:0x8C5B,init:0xFFFF},
  '2B3CJ5DT2BH590794':{poly:0x535D,init:0x0000},
  '2C3CDZFK3HH506737':{poly:0x71DE,init:0x4625},
  '2C3CDZC99HH514330':{poly:0x1189,init:0x0C99},
  '2C3CDXGJ1MH539855':{poly:0x5F08,init:0x0C99},
};

const RFHUB_CANDIDATES=[
  {tx:0x75F,rx:0x767,name:'Primary LX/LD (Scat Pack)'},
  {tx:0x742,rx:0x762,name:'Alternate'},
  {tx:0x762,rx:0x76A,name:'FGA variant'},
  {tx:0x740,rx:0x748,name:'Legacy'},
];

export default function RfhubTab(){
  const {vin:masterVin,setModuleStatus}=useContext(MasterVinContext);
  const [conn,setConn]=useState(false);
  const [unlocked,setUnlocked]=useState(false);
  const [busy,setBusy]=useState('');
  const [log,setLog]=useState([]);
  const [curVin,setCurVin]=useState(null);
  const [pin,setPin]=useState('');
  const [keysProgrammed,setKeysProgrammed]=useState(null);
  const [pinAttempts,setPinAttempts]=useState(0);
  const [pinExtractInfo,setPinExtractInfo]=useState('');
  const [showConfirmModal,setShowConfirmModal]=useState(false);
  const [rfhubAddr,setRfhubAddr]=useState(RFHUB_CANDIDATES[0]);
  const eng=useRef(null);
  const addLog=useCallback((m,t='info')=>{const ts=new Date().toLocaleTimeString();setLog(p=>[...p.slice(-300),{t:ts,m,type:t}]);},[]);
  const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
  const sbecKey=s=>u32((s*4+0x9018));

  const connect=useCallback(async()=>{
    const e=await initAdapter(addLog,hx);
    if(e){eng.current=e;setConn(true);addLog('Connected — ready for RFHUB ops','info');}
  },[addLog]);

  const findRfhub=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Finding RFHUB...');
    for(const c of RFHUB_CANDIDATES){
      addLog('Probing '+c.name+' TX:0x'+hx(c.tx,3)+'...','info');
      const r=await eng.current.uds(c.tx,c.rx,[0x22,0xF1,0x90]);
      if(r.ok){setRfhubAddr(c);addLog('✓ RFHUB found at '+c.name,'rx');setBusy('');return c;}
    }
    addLog('RFHUB not found','error');setBusy('');return null;
  },[addLog]);

  const readVin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VIN...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,0xF1,0x90]);
    const v=r.ok?parseVinFromResponse(r.d):null;
    setCurVin(v);addLog('RFHUB VIN: '+(v||'(no response)'),v?'rx':'warn');
    setBusy('');
  },[rfhubAddr,addLog]);

  const unlockRfhub=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking RFHUB...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    const s=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x27,0x01]);
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    const k=sbecKey(sv);
    addLog('SBEC Key: 0x'+hx(k,8)+' [(seed*4)+0x9018]','info');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x67){setUnlocked(true);addLog('✓ RFHUB UNLOCKED','rx');}
    else addLog('Unlock failed','error');
    setBusy('');
  },[rfhubAddr,addLog]);

  const extractPin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Extracting PIN from RFHUB...');
    addLog('═══ PIN EXTRACTION ═══','info');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x10,0x03]);
    const pinDids=[0xF18C,0xF18D,0xF1A0];
    for(const did of pinDids){
      addLog('Reading DID 0x'+hx(did,4)+'...','info');
      const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,(did>>8)&0xFF,did&0xFF]);
      if(!r.ok||!r.d||r.d[0]!==0x62){
        if(r.ok&&r.d&&r.d[0]===0x7F)addLog('  DID 0x'+hx(did,4)+' NRC: '+decodeNRC(r.d[2]||0),'warn');
        continue;
      }
      const raw=Array.from(r.d).slice(3,5);
      if(raw.length<2){addLog('  DID 0x'+hx(did,4)+' too short','warn');continue;}
      const rawHex=raw.map(b=>hx(b)).join(' ');
      addLog('  Raw bytes: '+rawHex,'info');
      const d1=(raw[0]>>4)&0x0F,d2=raw[0]&0x0F,d3=(raw[1]>>4)&0x0F,d4=raw[1]&0x0F;
      if(d1<=9&&d2<=9&&d3<=9&&d4<=9){
        const extracted=`${d1}${d2}${d3}${d4}`;
        setPin(extracted);
        setPinExtractInfo('PIN '+extracted+' extracted via BCD from DID 0x'+hx(did,4));
        addLog('✓ PIN extracted (BCD): '+extracted+' from DID 0x'+hx(did,4),'rx');
        setBusy('');return;
      }
      const bin=(raw[0]<<8)|raw[1];
      if(bin>=1000&&bin<=9999){
        const extracted=bin.toString().padStart(4,'0');
        setPin(extracted);
        setPinExtractInfo('PIN '+extracted+' extracted via binary from DID 0x'+hx(did,4));
        addLog('✓ PIN extracted (binary): '+extracted+' from DID 0x'+hx(did,4),'rx');
        setBusy('');return;
      }
      addLog('  DID 0x'+hx(did,4)+' data not a valid PIN format','warn');
    }
    addLog('✗ PIN extraction failed — PIN not found at any known DID','error');
    addLog('Module may need unlock first, or PIN stored at nonstandard DID','warn');
    setBusy('');
  },[rfhubAddr,addLog]);

  const writeVin=useCallback(()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    if(masterVin.length!==17){addLog('Master VIN must be 17 chars','error');return;}
    if(!unlocked){addLog('Unlock RFHUB first','error');return;}
    setShowConfirmModal(true);
  },[masterVin,unlocked,addLog]);

  const executeWriteVin=useCallback(async(confirmData)=>{
    setShowConfirmModal(false);
    const oldVinSnapshot=curVin;
    setBusy('Writing VIN to RFHUB...');
    setModuleStatus(p=>({...p,RFHUB:'writing'}));
    addLog('═══ RFHUB VIN WRITE ═══','info');
    if(confirmData.technician)addLog('Technician: '+confirmData.technician,'info');
    if(confirmData.titleRef)addLog('Title reference: '+confirmData.titleRef,'info');
    addLog('Creating safety backup before write...','info');
    const backup=await backupModule(eng.current.uds,rfhubAddr.tx,rfhubAddr.rx,'RFHUB',addLog,hx);
    const backupKey=backup?.key||null;
    const knownAlgo=RFHUB_KNOWN_ALGOS[masterVin];
    if(knownAlgo)addLog('Known CRC algorithm: poly=0x'+hx(knownAlgo.poly,4)+' init=0x'+hx(knownAlgo.init,4),'info');
    else addLog('VIN not in known algorithm DB — RFHUB firmware will compute CRC','warn');
    const vb=Array.from(masterVin).map(c=>c.charCodeAt(0));
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x2E,0xF1,0x90,...vb]);
    let ok=false;
    if(r.ok&&r.d&&r.d[0]===0x6E){ok=true;addLog('✓ VIN written','rx');}
    else if(r.ok&&r.d&&r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'error');
    else addLog('Write failed','error');
    const vr=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x22,0xF1,0x90]);
    const v=vr.ok?parseVinFromResponse(vr.d):null;
    setCurVin(v);
    const match=v===masterVin;
    addLog(match?'✓ VERIFIED: VIN matches':'✗ VERIFY FAIL: '+(v||'no response'),match?'rx':'warn');
    setModuleStatus(p=>({...p,RFHUB:(ok&&match)?'ok':'fail'}));
    logSession({
      module:'RFHUB',
      operation:'VIN Write',
      oldVin:oldVinSnapshot,
      newVin:masterVin,
      moduleAddr:{tx:rfhubAddr.tx,rx:rfhubAddr.rx},
      adapter:eng.current?.adapter||'ELM327/STN',
      success:ok&&match,
      technician:confirmData.technician,
      titleRef:confirmData.titleRef,
      titleNotes:confirmData.titleNotes,
      preWriteConfirmed:confirmData.preWriteConfirmed,
      backupKey,
    });
    addLog('📄 Session logged to paper trail','info');
    setBusy('');
  },[masterVin,rfhubAddr,addLog,setModuleStatus,curVin]);

  const programNewKey=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock RFHUB first','error');return;}
    if(pin.length!==4){addLog('Enter 4-digit PIN','error');return;}
    setBusy('Programming new key fob...');
    addLog('═══ KEY FOB PROGRAMMING (EXPERIMENTAL) ═══','info');
    addLog('⚠ PIN format not in source docs — trying 4 common FCA encodings','warn');
    addLog('PIN: '+pin,'info');
    const d=pin.split('').map(c=>parseInt(c,10));
    const pinFormats=[
      {name:'4 digit bytes',bytes:d},
      {name:'2 BCD bytes',bytes:[(d[0]<<4)|d[1],(d[2]<<4)|d[3]]},
      {name:'4 ASCII bytes',bytes:pin.split('').map(c=>c.charCodeAt(0))},
      {name:'no PIN',bytes:[]},
    ];
    let accepted=null;
    for(const fmt of pinFormats){
      const cmdBytes=[0x31,0x01,0x04,0x01,...fmt.bytes];
      addLog('Trying '+fmt.name+': '+cmdBytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '),'info');
      const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,cmdBytes);
      if(r.ok&&r.d&&r.d[0]===0x71){accepted=fmt;break;}
      if(r.ok&&r.d&&r.d[0]===0x7F){
        const nrc=r.d[2]||0;
        addLog('  NRC: '+decodeNRC(nrc),'warn');
        if(nrc===0x22){addLog('Conditions not correct — check ignition state / session','error');break;}
      }
      await new Promise(r=>setTimeout(r,300));
    }
    if(accepted){
      addLog('✓ Routine accepted using '+accepted.name,'rx');
      addLog('>>> HOLD UNLOCK BUTTON ON NEW FOB within 10 seconds <<<','info');
      addLog('Waiting 12 seconds...','info');
      await new Promise(r=>setTimeout(r,12000));
      addLog('Checking routine results (31 03 04 01)...','info');
      const status=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x03,0x04,0x01]);
      if(status.ok&&status.d&&status.d[0]===0x71){
        addLog('✓ Routine results: '+Array.from(status.d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '),'rx');
        setPinAttempts(0);
      }else addLog('Status inconclusive — click Locate Keys to verify count increased','warn');
    }else{
      const newAttempts=pinAttempts+1;
      setPinAttempts(newAttempts);
      addLog('✗ All PIN formats rejected — attempt '+newAttempts+'/3 used','error');
      if(newAttempts>=3){
        addLog('🛑 MAXIMUM ATTEMPTS REACHED — RFHUB may now require dealer unlock','error');
        addLog('Do NOT try again. Dealer scan tool required to reset attempt counter.','error');
      }else{
        addLog('⚠ '+(3-newAttempts)+' attempt(s) remaining before permanent lockout','warn');
      }
    }
    setBusy('');
  },[rfhubAddr,unlocked,pin,addLog,pinAttempts]);

  const locateKeys=useCallback(async()=>{
    if(!eng.current||!unlocked){addLog('Unlock RFHUB first','error');return;}
    setBusy('Locating programmed keys...');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x01,0x04,0x03]);
    if(r.ok&&r.d&&r.d[0]===0x71){
      const slots=r.d.length>5?Array.from(r.d).slice(5):[];
      const count=slots.filter(b=>b!==0).length;
      setKeysProgrammed(count);
      addLog('✓ Keys programmed: '+count,'rx');
      addLog('Slot data: '+slots.map(b=>hx(b)).join(' '),'info');
    }else addLog('Locate failed','error');
    setBusy('');
  },[rfhubAddr,unlocked,addLog]);

  const eraseAllKeys=useCallback(async()=>{
    if(!eng.current||!unlocked)return;
    if(!window.confirm('Erase ALL programmed keys from RFHUB? You will need to re-program at least one key to start the vehicle.'))return;
    setBusy('Erasing all keys...');
    addLog('Routine 0x0404 Erase All Keys...','info');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,[0x31,0x01,0x04,0x04]);
    if(r.ok&&r.d&&r.d[0]===0x71){addLog('✓ All keys erased','rx');setKeysProgrammed(0);}
    else addLog('Erase failed','error');
    setBusy('');
  },[rfhubAddr,unlocked,addLog]);

  const vinValid=masterVin.length===17;
  return <div>
    {showConfirmModal&&<ReadFirstModal
      module="RFHUB"
      currentState={[
        {label:'Current VIN (DID 0xF190)',value:curVin},
        {label:'Module Address',value:'TX 0x'+hx(rfhubAddr.tx,3)+' / RX 0x'+hx(rfhubAddr.rx,3)},
        {label:'Security',value:unlocked?'Unlocked (SBEC)':'Not unlocked'},
      ]}
      newVin={masterVin}
      onConfirm={executeWriteVin}
      onCancel={()=>{setShowConfirmModal(false);addLog('Write cancelled at confirmation step','warn');}}
    />}

    <Card style={{background:'linear-gradient(135deg,#0A3D3D 0%,#006B6B 40%,#00BFA5 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔑</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>RFHUB PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>RF HUB · VIN · KEY FOBS</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED':'● CONNECTED'}
        </div>
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>⚡ CONTROLS</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {!conn&&<Btn onClick={connect} color={C.a2}>🔌 Test Connection</Btn>}
        {conn&&<Btn onClick={findRfhub} disabled={!!busy} color={C.a3}>🎯 Find RFHUB</Btn>}
        {conn&&<Btn onClick={readVin} disabled={!!busy} color={C.a2}>📖 Read VIN</Btn>}
        {conn&&<Btn onClick={unlockRfhub} disabled={!!busy} color={C.a4}>🔓 Unlock (SBEC)</Btn>}
        {conn&&<Btn onClick={writeVin} disabled={!!busy||!unlocked||!vinValid} color={C.a2}>💾 Write Master VIN</Btn>}
      </div>
      <div style={{marginTop:10,fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>
        Target: {rfhubAddr.name} · TX 0x{hx(rfhubAddr.tx,3)} · RX 0x{hx(rfhubAddr.rx,3)}
      </div>
    </Card>

    <ModuleHistoryPanel moduleType="RFHUB"/>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      <div style={{padding:12,background:curVin===masterVin?'#E8F5E9':curVin?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(curVin===masterVin?C.gn:curVin?C.wn:C.bd)}}>
        <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>Current VIN on RFHUB (DID 0xF190)</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4}}>{curVin||'(not read)'}</div>
        {curVin===masterVin&&<div style={{fontSize:10,color:C.gn,marginTop:4}}>✓ matches Master VIN</div>}
      </div>
    </Card>

    <Card style={{marginBottom:14,background:'linear-gradient(135deg,#FFF8F0 0%,#FFE0B2 100%)',border:'2px solid '+C.a1}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:13,color:C.a1,letterSpacing:1}}>🔑 KEY FOB PROGRAMMING</div>
        <div style={{fontSize:9,fontWeight:800,padding:'3px 8px',background:C.wn+'22',color:C.wn,borderRadius:4,letterSpacing:1,border:'1px solid '+C.wn+'55'}}>⚠ EXPERIMENTAL</div>
      </div>
      <div style={{padding:10,background:'#FFFDE7',border:'1px solid '+C.wn+'55',borderRadius:6,fontSize:11,color:C.ts,marginBottom:12,lineHeight:1.5}}>
        <b>Heads up:</b> The exact PIN encoding for routine 0x0401 is not documented in our source files.
        This tool auto-tries 4 common FCA formats. If one works, we log which one so we can hard-code it later.
        Use bench-only first — don't risk locking out a customer's RFHUB.
      </div>
      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <div style={{fontSize:11,color:C.ts,fontWeight:700}}>4-DIGIT PIN (auto-extract or enter manually)</div>
          <div style={{fontSize:10,color:pinAttempts>=2?C.er:pinAttempts===1?C.wn:C.ts,fontFamily:"'JetBrains Mono'",fontWeight:700}}>
            Attempts: {pinAttempts}/3 {pinAttempts>=2&&'⚠'}
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,'').slice(0,4))} maxLength={4} placeholder="----" style={{width:120,padding:'10px 14px',border:'2px solid '+(pin.length===4?C.gn:C.bd),borderRadius:8,fontSize:18,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:8,textAlign:'center'}}/>
          <Btn onClick={extractPin} disabled={!!busy||!conn} color={C.a3} outline>🔍 Extract PIN from RFHUB</Btn>
        </div>
        {pinExtractInfo&&<div style={{marginTop:8,padding:8,background:'#E8F5E9',borderRadius:6,fontSize:11,fontFamily:"'JetBrains Mono'",color:C.gn}}>
          ✓ {pinExtractInfo}
        </div>}
      </div>
      {pinAttempts>=2&&<div style={{padding:10,background:'#FFEBEE',border:'2px solid '+C.er,borderRadius:6,fontSize:11,color:C.er,marginBottom:12,fontWeight:700}}>
        ⚠ CRITICAL: {3-pinAttempts} attempt{3-pinAttempts===1?'':'s'} remaining. 3 wrong PINs = PERMANENT RFHUB LOCKOUT requiring dealer unlock.
      </div>}
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <Btn onClick={programNewKey} disabled={!!busy||!unlocked||pin.length!==4||pinAttempts>=3} color={C.a1}>➕ Program New Key (0x0401)</Btn>
        <Btn onClick={locateKeys} disabled={!!busy||!unlocked} color={C.a3} outline>📍 Locate Keys (0x0403)</Btn>
        <Btn onClick={eraseAllKeys} disabled={!!busy||!unlocked} color={C.er} outline>🗑️ Erase All (0x0404)</Btn>
      </div>
      {keysProgrammed!==null&&<div style={{marginTop:10,padding:8,background:'#fff',borderRadius:6,fontSize:12,fontWeight:700}}>
        Programmed keys: <span style={{color:C.a1}}>{keysProgrammed}</span> / 8
      </div>}
      <div style={{marginTop:10,fontSize:10,color:C.ts,fontStyle:'italic'}}>
        After clicking "Program New Key", hold the UNLOCK button on the new fob within 10 seconds.
      </div>
    </Card>

    {vinValid&&<Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔢 RFHUB CRC ALGORITHM</div>
      {RFHUB_KNOWN_ALGOS[masterVin]?<div style={{fontFamily:"'JetBrains Mono'",fontSize:12}}>
        <div>✓ Known algorithm: poly=0x{hx(RFHUB_KNOWN_ALGOS[masterVin].poly,4)} init=0x{hx(RFHUB_KNOWN_ALGOS[masterVin].init,4)}</div>
      </div>:<div style={{fontSize:12,color:C.wn}}>
        ⚠ Unknown VIN — firmware will compute CRC on-the-fly during UDS write. No brute-force needed.
      </div>}
    </Card>}

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{fontWeight:800,fontSize:12,color:'#00BFA5',marginBottom:10,letterSpacing:2}}>📋 LOG</div>
      <div style={{maxHeight:320,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready</div>}
        {log.map((l,i)=><div key={i} style={{color:l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA'}}>
          <span style={{color:'#555'}}>{l.t}</span> {l.m}
        </div>)}
      </div>
    </Card>
  </div>;
}

export {RFHUB_KNOWN_ALGOS};
