import React, {useState, useCallback, useRef, useContext} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {u32} from "../lib/algos.js";
import {initAdapter, parseVinFromResponse} from "../lib/initAdapter.js";
import {backupModule} from "../lib/audit.js";
import {decodeNRC} from "../lib/nrc.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import ReadFirstModal from "../lib/readFirstModal.jsx";
import {isSgwAuthenticated} from "../lib/sgwAuth.js";
import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import {parseModule,moduleTooSmall} from "../lib/parseModule.js";
import {vinHasSGW} from "../lib/vin.js";
import {createBridgeEngine} from "../lib/bridgeEngine.js";
import {getRow} from "../lib/moduleRegistry.js";
import {programVin} from "../lib/vinProgrammer.js";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";
import {build} from "@workspace/uds";
import {LocalAlgoOverJ2534} from "../lib/securityAccessSource.js";
import {runDealerLockoutBypass,dealerLockoutBypassSteps} from "../lib/dealerLockoutBypass.js";

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

export default function RfhubTab({vehicle}){
  const {vin:masterVin,setModuleStatus,getDumpsByType,addDump,removeDump}=useContext(MasterVinContext);
  const [conn,setConn]=useState(false);
  const [unlocked,setUnlocked]=useState(false);
  const [lockoutNrc,setLockoutNrc]=useState(null);
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
      const r=await eng.current.uds(c.tx,c.rx,build.readDataByIdentifier({dids:[0xF190]}));
      if(r.ok){setRfhubAddr(c);addLog('✓ RFHUB found at '+c.name,'rx');setBusy('');return c;}
    }
    addLog('RFHUB not found','error');setBusy('');return null;
  },[addLog]);

  const readVin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Reading VIN...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.diagnosticSessionControl({session:0x03}));
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.readDataByIdentifier({dids:[0xF190]}));
    const v=r.ok?parseVinFromResponse(r.d):null;
    setCurVin(v);addLog('RFHUB VIN: '+(v||'(no response)'),v?'rx':'warn');
    setBusy('');
  },[rfhubAddr,addLog]);

  const unlockRfhub=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Unlocking RFHUB...');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.diagnosticSessionControl({session:0x03}));
    const s=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.securityAccess({subFunction:0x01}));
    if(!s.ok||!s.d||s.d.length<4){addLog('Seed request failed','error');setBusy('');return;}
    const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
    addLog('Seed: 0x'+hx(sv,8),'info');
    const k=sbecKey(sv);
    addLog('SBEC Key: 0x'+hx(k,8)+' [(seed*4)+0x9018]','info');
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.securityAccess({subFunction:0x02,data:[(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]}));
    if(r.ok&&r.d&&r.d[0]===0x67){setUnlocked(true);setLockoutNrc(null);addLog('✓ RFHUB UNLOCKED','rx');}
    else if(r.d&&r.d[0]===0x7F&&(r.d[2]===0x36||r.d[2]===0x37)){
      // Task #634 — surface lockout evidence so the Dealer Lockout Bypass CTA
      // can enable itself only after the documented trigger NRCs are seen.
      setLockoutNrc(r.d[2]);
      addLog('⚠ RFHUB locked out — NRC 0x'+r.d[2].toString(16).toUpperCase()+' ('+(r.d[2]===0x36?'exceededNumberOfAttempts':'requiredTimeDelayNotExpired')+')','warn');
    }
    else addLog('Unlock failed','error');
    setBusy('');
  },[rfhubAddr,addLog]);

  const extractPin=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    setBusy('Extracting PIN from RFHUB...');
    addLog('═══ PIN EXTRACTION ═══','info');
    await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.diagnosticSessionControl({session:0x03}));
    const pinDids=[0xF18C,0xF18D,0xF1A0];
    for(const did of pinDids){
      addLog('Reading DID 0x'+hx(did,4)+'...','info');
      const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.readDataByIdentifier({dids:[did]}));
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
    // SGW-routed VINs require the Autel J2534 bridge channel; programVin
    // re-runs the SBEC seed/key on whichever channel we hand it.
    const sgwReq=vinHasSGW(masterVin);
    let activeEng=eng.current;
    if(sgwReq){
      // See BcmTab.executeWriteVin for rationale — bridge reachability
      // is necessary but not sufficient; the SGW must be unlocked first.
      if(!isSgwAuthenticated(masterVin)){
        addLog('🛑 SGW REQUIRED but not authenticated for this VIN','error');
        addLog('Open the AUTEL SGW tab and click AUTHENTICATE SGW first.','error');
        setModuleStatus(p=>({...p,RFHUB:'fail'}));setBusy('');return;
      }
      const br=await createBridgeEngine({addLog});
      if(!br.ok){
        addLog('🛑 SGW REQUIRED but bridge offline: '+br.error,'error');
        addLog('Open the AUTEL SGW tab, start j2534_bridge.py, verify the Autel cable, then retry.','error');
        setModuleStatus(p=>({...p,RFHUB:'fail'}));setBusy('');return;
      }
      activeEng=br.engine;
    }
    // Surface the known-CRC hint before the registry-driven write — purely
    // informational; RFHUB firmware computes the actual flash CRC.
    const knownAlgo=RFHUB_KNOWN_ALGOS[masterVin];
    if(knownAlgo)addLog('Known CRC algorithm: poly=0x'+hx(knownAlgo.poly,4)+' init=0x'+hx(knownAlgo.init,4),'info');
    else addLog('VIN not in known algorithm DB — RFHUB firmware will compute CRC','warn');

    // Use the RFHUB registry row (sbec unlock + 0xF190/0x6E2027 mirror DIDs)
    // but pin tx/rx to the address resolved by findRfhub for non-canonical
    // benches.
    const row={...getRow('RFHUB'),tx:rfhubAddr.tx,rx:rfhubAddr.rx};
    const r=await programVin({
      eng:activeEng, row, vin:masterVin,
      addLog:(m,t)=>addLog(m,t),
      makeBackup: async ({uds,snapshotKind,preWriteKey})=>backupModule(uds,rfhubAddr.tx,rfhubAddr.rx,'RFHUB',addLog,snapshotKind,preWriteKey),
    });
    const f190=r.didResults.find(d=>d.did===0xF190);
    setCurVin(f190?.readback||null);
    setModuleStatus(p=>({...p,RFHUB:r.ok?'ok':'fail'}));
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
      const cmdBytes=Array.from(build.routineControl({type:'startRoutine',routineIdentifier:0x0401,routineOptionRecord:fmt.bytes}));
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
      const status=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.routineControl({type:'requestRoutineResults',routineIdentifier:0x0401}));
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
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.routineControl({type:'startRoutine',routineIdentifier:0x0403}));
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
    const r=await eng.current.uds(rfhubAddr.tx,rfhubAddr.rx,build.routineControl({type:'startRoutine',routineIdentifier:0x0404}));
    if(r.ok&&r.d&&r.d[0]===0x71){addLog('✓ All keys erased','rx');setKeysProgrammed(0);}
    else addLog('Erase failed','error');
    setBusy('');
  },[rfhubAddr,unlocked,addLog]);

  const rfhubDumps=getDumpsByType('RFHUB');
  const [inspectHash,setInspectHash]=useState(null);
  const [inspectMsg,setInspectMsg]=useState('');
  const [inspectTooSmall,setInspectTooSmall]=useState(null);
  const inspectEntry=rfhubDumps.find(d=>d.hash===inspectHash)||rfhubDumps[0]||null;
  const inspectMod=inspectEntry?.mod||null;
  const onInspectFile=useCallback(file=>{
    const r=new FileReader();
    r.onload=ev=>{
      const bytes=new Uint8Array(ev.target.result);
      // Refuse undersized files up-front so techs see a structured "this
      // isn't a full RFHUB dump" card rather than a partial parse with a
      // bogus VIN / SEC16 verdict (Task #372, mirroring the BCM guard from
      // Task #370). The fields panel hides whenever inspectTooSmall is set.
      const small=moduleTooSmall(bytes,'RFHUB',file.name);
      if(small){
        setInspectHash(null);
        setInspectTooSmall(small);
        setInspectMsg('');
        return;
      }
      setInspectTooSmall(null);
      const m=parseModule(bytes,file.name);
      if(m.type!=='RFHUB'){setInspectMsg('Selected file is '+m.type+', not RFHUB — load a 4 KB RFHUB EEE dump.');return;}
      const entry=addDump(m,'RFHUB tab');
      if(entry)setInspectHash(entry.hash);
      setInspectMsg('');
    };
    r.readAsArrayBuffer(file);
  },[addDump]);
  const closeInspect=useCallback(()=>{
    if(inspectEntry)removeDump(inspectEntry.hash);
    setInspectHash(null);setInspectMsg('');setInspectTooSmall(null);
  },[inspectEntry,removeDump]);

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
          {vehicle&&<div style={{marginTop:8,padding:'6px 10px',background:'rgba(0,0,0,0.3)',borderRadius:8,display:'inline-block'}}>
            <div style={{fontSize:11,fontWeight:800,letterSpacing:1.5,color:'rgba(255,255,255,0.9)'}}>{vehicle.full} — {vehicle.body}</div>
            <div style={{marginTop:4,display:'flex',gap:6,flexWrap:'wrap'}}>
              {vehicle.generations.map(g=>{
                const needsSync=g.sec16==='gen2-split';
                const noFlash=g.sec16==='trackhawk-no-flash';
                return <span key={g.id} style={{fontSize:9,padding:'2px 7px',background:noFlash?'rgba(255,82,82,0.3)':needsSync?'rgba(255,179,0,0.3)':'rgba(0,200,83,0.2)',borderRadius:4,border:'1px solid '+(noFlash?'rgba(255,82,82,0.5)':needsSync?'rgba(255,179,0,0.5)':'rgba(0,200,83,0.3)'),fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:0.5}}>
                  {g.label} · {noFlash?'⚠ NO FLASH SEC16 (OBD only)':needsSync?'Gen2 · SEC16 sync required':'Gen1 · 18-byte SEC16'}
                </span>;
              })}
            </div>
          </div>}
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:conn?(unlocked?'#00C85333':'#FFB30033'):'#FF174433',borderRadius:8,border:'1px solid '+(conn?(unlocked?'#00C853':'#FFB300'):'#FF1744')}}>
          {!conn?'○ DISCONNECTED':unlocked?'● UNLOCKED':'● CONNECTED'}
        </div>
      </div>
    </Card>

    {vehicle&&vehicle.generations.length>0&&<Card style={{marginBottom:14,background:'#FFF8E1',border:'2px solid #FFB300'}}>
      <div style={{fontWeight:800,fontSize:11,color:'#E65100',marginBottom:8,letterSpacing:1.5}}>📡 GENERATION OFFSET MAP — {vehicle.name}</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:8}}>
        {vehicle.generations.map(g=>{
          const isGen2=g.sec16==='gen2-split';
          const noFlash=g.sec16==='trackhawk-no-flash';
          return <div key={g.id} style={{padding:'8px 10px',background:'#fff',borderRadius:8,border:'2px solid '+(noFlash?'#FF5252':isGen2?'#FFB300':'#00C853')}}>
            <div style={{fontWeight:800,fontSize:11,color:noFlash?'#C62828':isGen2?'#E65100':'#1B5E20',marginBottom:4}}>{g.label}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.7,color:'#555'}}>
              <div>BCM VIN offset: <b style={{color:'#222'}}>0x{g.vinOff.toString(16).toUpperCase()}</b></div>
              {isGen2&&<>
                <div>SEC16 split records: <b style={{color:'#E65100'}}>0x81A0 · 0x81C0 · 0x81E0</b></div>
                <div>RFHUB→BCM sync: <b style={{color:'#E65100'}}>required</b></div>
              </>}
              {noFlash&&<div style={{color:'#C62828',fontWeight:700}}>RFHUB SEC16 not in flash — use OBD live read only</div>}
              {!isGen2&&!noFlash&&<div>SEC16 format: <b style={{color:'#1B5E20'}}>18-byte inline (no RFHUB sync needed)</b></div>}
              <div>Processor: <b style={{color:'#222'}}>{g.family}</b></div>
            </div>
          </div>;
        })}
      </div>
    </Card>}

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

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔑 VIN STATUS</div>
      {/* Task #488 — Charger LD trim/HP subtitle for the master VIN. */}
      {vinValid&&<VinChargerSubtitle vin={masterVin} dataTestId="rfhub-vin-decode" style={{marginBottom:10,marginTop:0}}/>}
      <div style={{padding:12,background:curVin===masterVin?'#E8F5E9':curVin?'#FFF8F0':'#F8F6F2',borderRadius:8,border:'1px solid '+(curVin===masterVin?C.gn:curVin?C.wn:C.bd)}}>
        <div style={{fontSize:10,color:C.ts,letterSpacing:1,fontWeight:700}}>Current VIN on RFHUB (DID 0xF190)</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,marginTop:4}}>{curVin||'(not read)'}</div>
        {curVin===masterVin&&<div style={{fontSize:10,color:C.gn,marginTop:4}}>✓ matches Master VIN</div>}
      </div>
    </Card>

    <DealerLockoutBypassCard
      conn={conn}
      addr={rfhubAddr}
      eng={eng}
      addLog={addLog}
      busy={busy}
      setBusy={setBusy}
      lockoutNrc={lockoutNrc}
      onCleared={()=>setLockoutNrc(null)}
      moduleHint={inspectMod}
    />

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

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:10,letterSpacing:2}}>🔍 RFHUB DUMP INSPECTOR</div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <label style={{padding:'10px 16px',borderRadius:10,border:'2px dashed '+C.a2+'40',background:C.c2,cursor:'pointer',fontSize:12,fontWeight:800,color:C.a2}}>
          📂 Load RFHUB .bin to inspect byte-level fields
          <input type="file" accept=".bin,.BIN" hidden onChange={e=>e.target.files[0]&&onInspectFile(e.target.files[0])}/>
        </label>
        {rfhubDumps.length>1&&<select value={inspectEntry?.hash||''} onChange={e=>setInspectHash(e.target.value)}
          style={{padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11}}>
          {rfhubDumps.map(d=><option key={d.hash} value={d.hash}>{d.filename}</option>)}
        </select>}
        {inspectMod&&<>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts}}>{inspectMod.filename} · {(inspectMod.size/1024).toFixed(1)} KB</span>
          {/* Provenance chip — Task #531. The shared workspace store
              now feeds this inspector from any tab that loaded an
              RFHUB dump; tell the user where it came from. */}
          {inspectEntry?.source&&<span data-testid="rfhub-source-chip" style={{fontSize:9,fontWeight:800,padding:'2px 8px',borderRadius:6,background:C.c2,color:C.ts,border:'1px solid '+C.bd,letterSpacing:0.5,textTransform:'uppercase'}}>Loaded from {inspectEntry.source}</span>}
          <button onClick={closeInspect} style={{border:'none',background:'transparent',color:C.tm,cursor:'pointer',fontSize:14}} title="Remove from workspace">✕</button>
        </>}
      </div>
      {!inspectMod&&rfhubDumps.length===0&&<div style={{marginTop:8,fontSize:11,color:C.tm,fontStyle:'italic'}}>Tip: dumps loaded in the Dumps tab show up here automatically.</div>}
      {inspectMod&&rfhubDumps.length>0&&<div style={{marginTop:6,fontSize:10,color:C.gn,fontWeight:700}}>✓ Auto-loaded from shared workspace ({rfhubDumps.length} RFHUB dump{rfhubDumps.length===1?'':'s'} available)</div>}
      {inspectMsg&&<div style={{marginTop:8,fontSize:11,color:C.wn,fontWeight:700}}>{inspectMsg}</div>}
      {inspectTooSmall&&<div data-testid="rfh-too-small-card" style={{marginTop:12,padding:'14px 16px',borderRadius:10,background:'rgba(255,23,68,0.07)',border:'2px solid '+C.er}}>
        <div style={{fontWeight:900,fontSize:13,color:C.er,letterSpacing:1.2,textTransform:'uppercase',marginBottom:8}}>⛔ This isn&apos;t a full RFHUB dump</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts,lineHeight:1.7}}>
          <div>File size: <strong style={{color:C.er}}>{inspectTooSmall.size.toLocaleString()} bytes</strong></div>
          <div>Required min: <strong>{inspectTooSmall.min.toLocaleString()} bytes ({inspectTooSmall.label})</strong></div>
          <div>Detected ext: <strong>{inspectTooSmall.ext||'(none)'}</strong></div>
        </div>
        <div style={{marginTop:8,fontSize:12,color:C.ts,fontWeight:600,lineHeight:1.5}}>Re-read the RFHUB in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.</div>
      </div>}
      {inspectMod&&!inspectTooSmall&&<div style={{marginTop:12}}><ModuleFieldsPanel mod={inspectMod}/></div>}
    </Card>

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

export {RFHUB_KNOWN_ALGOS, DealerLockoutBypassCard};

/* ────────────────────────────────────────────────────────────────────────────
 * DealerLockoutBypassCard — 2019+ internal-flash RFHUB lockout recovery.
 * Drives the 5-step machine in dealerLockoutBypass.js using the active
 * bridge engine + LocalAlgoOverJ2534 source. Surfaces each step's request /
 * response / NRC inline so the user can see exactly where the chain stops.
 * The CTA is gated on `conn` — the runner itself returns a clean error
 * with NRC visibility against legacy Gen1/Gen2 modules that don't expose
 * alt-level SA, so we don't try to pre-detect internal-flash here.
 * ────────────────────────────────────────────────────────────────────────── */
function DealerLockoutBypassCard({ conn, addr, eng, addLog, busy, setBusy, lockoutNrc, onCleared, moduleHint }) {
  const [report, setReport] = useState(null);
  const [overrideGate, setOverrideGate] = useState(false);
  const steps = dealerLockoutBypassSteps();
  // Trigger policy from Task #634: only enable Run once the standard
  // unlock has actually surfaced NRC 0x36 or 0x37 AND we have evidence
  // the connected RFHUB is the internal-flash family (loaded XC2268
  // dump in the inspector). Bench operators can force-enable with the
  // override checkbox — UI still records they bypassed the gate.
  const hasLockoutEvidence = lockoutNrc === 0x36 || lockoutNrc === 0x37;
  const internalFlashHint = moduleHint && moduleHint.type === 'XC2268_RFHUB';
  const gateOk = hasLockoutEvidence && (internalFlashHint || overrideGate);
  const canRun = conn && !busy && (gateOk || overrideGate);

  const onRun = useCallback(async () => {
    if (!eng.current) { addLog('Connect first', 'error'); return; }
    setBusy('Running dealer lockout bypass…');
    setReport(null);
    try {
      const uds = (tx, rx, bytes) => eng.current.uds(tx, rx, bytes);
      const sa = LocalAlgoOverJ2534({ uds, addLog });
      const r = await runDealerLockoutBypass({
        tx: addr.tx, rx: addr.rx, uds, securityAccess: sa,
        delay: (ms) => new Promise((res) => setTimeout(res, ms)),
        addLog,
      });
      setReport(r);
      if (r.cleared && typeof onCleared === 'function') onCleared();
      addLog(r.cleared ? '✓ Lockout cleared' : '✗ Bypass did not clear lockout', r.cleared ? 'rx' : 'warn');
    } catch (e) {
      addLog('Bypass error: ' + (e && e.message || e), 'error');
    } finally {
      setBusy('');
    }
  }, [eng, addr, addLog, setBusy, onCleared]);

  return <Card style={{marginBottom:14,background:'#FFF3E0',border:'2px solid '+C.a1}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
      <div style={{fontWeight:800,fontSize:13,color:C.a1,letterSpacing:1}}>🛡️ DEALER LOCKOUT BYPASS (2019+ internal-flash RFHUB)</div>
      <div style={{fontSize:9,fontWeight:800,padding:'3px 8px',background:C.wn+'22',color:C.wn,borderRadius:4,letterSpacing:1,border:'1px solid '+C.wn+'55'}}>⚠ BENCH-PENDING</div>
    </div>
    <div style={{padding:10,background:'#FFFDE7',border:'1px solid '+C.wn+'55',borderRadius:6,fontSize:11,color:C.ts,marginBottom:10,lineHeight:1.5}}>
      Use only when the standard unlock returns <b>NRC 0x36</b> (attempts exceeded) or <b>NRC 0x37</b> (time delay).
      Runs: extended session → alt-level security access (0x{0x0B.toString(16).toUpperCase()}) → RoutineControl 0xFF00 → ECU reset → re-probe.
      No-op (returns a visible NRC) on legacy Gen1/Gen2 RFHUBs.
    </div>
    <div data-testid="bypass-gate" style={{padding:10,background:'#F8F6F2',border:'1px solid '+C.bd,borderRadius:6,fontSize:11,marginBottom:10,lineHeight:1.6}}>
      <div style={{fontWeight:800,color:C.ts,marginBottom:4}}>Trigger policy</div>
      <div>{hasLockoutEvidence ? <span style={{color:C.gn}}>✓ Lockout NRC 0x{lockoutNrc.toString(16).toUpperCase()} observed</span> : <span style={{color:C.tm}}>○ Awaiting NRC 0x36 / 0x37 from standard unlock</span>}</div>
      <div>{internalFlashHint ? <span style={{color:C.gn}}>✓ Inspector shows XC2268 internal-flash RFHUB</span> : <span style={{color:C.tm}}>○ Load an XC2268 RFHUB dump (or use override below)</span>}</div>
      <label style={{display:'block',marginTop:6,color:C.tm}}>
        <input type="checkbox" checked={overrideGate} onChange={(e)=>setOverrideGate(e.target.checked)} style={{marginRight:6}}/>
        Bench override — run anyway (logs the bypass).
      </label>
    </div>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <Btn onClick={onRun} disabled={!canRun} color={C.a1}>▶ Run Bypass</Btn>
      <span style={{fontSize:10,color:C.tm,fontFamily:"'JetBrains Mono'"}}>Target: TX 0x{addr.tx.toString(16).toUpperCase()} · RX 0x{addr.rx.toString(16).toUpperCase()}</span>
    </div>
    <ol style={{marginTop:10,paddingLeft:18,fontSize:11,color:C.ts,lineHeight:1.6}}>
      {steps.map((s, i) => {
        const r = report && report.steps[i];
        const color = !r ? C.tm : (r.ok ? C.gn : C.er);
        return <li key={s.id} style={{color}}>
          <b>{s.title}</b>
          {r && r.request && <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>→ {r.request}</div>}
          {r && r.response && <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>← {r.response}</div>}
          {r && r.reason && <div style={{fontSize:10,color:C.er}}>{r.reason}</div>}
          {r && r.note && <div style={{fontSize:10,color:C.gn}}>{r.note}</div>}
        </li>;
      })}
    </ol>
    {report && <div style={{marginTop:8,padding:8,background:report.cleared?'#E8F5E9':'#FFEBEE',borderRadius:6,fontWeight:800,fontSize:12,color:report.cleared?C.gn:C.er}}>
      {report.cleared ? '✓ Lockout cleared — standard 0x27 0x01 chain can run again' : '✗ Lockout NOT cleared — see step details above'}
    </div>}
  </Card>;
}
