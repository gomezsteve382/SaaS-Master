import React, {useState, useCallback, useRef} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {initAdapter} from "../lib/initAdapter.js";
import {decodeNRC} from "../lib/nrc.js";
import {logSession} from "../lib/paperTrail.js";
import {parseDtcResponse, formatDtcLogLine, buildDtcDetail} from "../lib/dtc.js";
import DtcDetailPanel from "../lib/DtcDetailPanel.jsx";

const MODULE_PRESETS={
  BCM:{tx:0x750,rx:0x758},RFHUB:{tx:0x75F,rx:0x767},
  ECM:{tx:0x7E0,rx:0x7E8},TCM:{tx:0x7E1,rx:0x7E9},
  ABS:{tx:0x760,rx:0x768},IPC:{tx:0x740,rx:0x748},
  ORC:{tx:0x758,rx:0x760},ADCM:{tx:0x7A8,rx:0x7B0},
  RADIO:{tx:0x772,rx:0x77A},HVAC:{tx:0x751,rx:0x759},
  EPS:{tx:0x761,rx:0x769},SCCM:{tx:0x74D,rx:0x76D},
  TIPM:{tx:0x74C,rx:0x76C},AMP:{tx:0x7A0,rx:0x7A8},
  BSM:{tx:0x770,rx:0x778},TPMS:{tx:0x752,rx:0x75A},
};

export default function UdsTab(){
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
  const[selectedModule,setSelectedModule]=useState('BCM');
  const[dtcDetail,setDtcDetail]=useState(null);
  const eng=useRef(null);

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

  const recordPaper=useCallback((operation,extra)=>{
    try{
      logSession({
        module:selectedModule||'UDS',
        operation,
        moduleAddr:{tx:parseAddr(txAddr),rx:parseAddr(rxAddr)},
        adapter:eng.current?.adapter||'ELM327/STN',
        ...extra,
      });
    }catch(e){/* ignore */}
  },[selectedModule,txAddr,rxAddr]);

  const loadPreset=m=>{
    const p=MODULE_PRESETS[m];if(!p)return;
    setTxAddr('0x'+hx(p.tx,3));setRxAddr('0x'+hx(p.rx,3));setSelectedModule(m);
    addLog('Loaded preset: '+m+' TX:0x'+hx(p.tx,3)+' RX:0x'+hx(p.rx,3),'info');
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
    setBusy('Reading DID 0x'+hx(did,4)+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x22,(did>>8)&0xFF,did&0xFF]);
    let success=false,asciiOut='';
    if(r.ok&&r.d){
      if(r.d[0]===0x62){
        const data=Array.from(r.d).slice(3);
        const ascii=data.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
        const hexOut=data.map(b=>hx(b)).join(' ');
        addLog('DID 0x'+hx(did,4)+' HEX: '+hexOut,'rx');
        if(ascii.length>=3){addLog('DID 0x'+hx(did,4)+' ASCII: '+ascii,'rx');asciiOut=ascii;}
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
    setBusy('Writing DID 0x'+hx(did,4)+'...');
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...data]);
    let success=false;
    if(r.ok&&r.d){
      if(r.d[0]===0x6E){addLog('✓ Written','rx');success=true;}
      else if(r.d[0]===0x7F)addLog('NRC: '+decodeNRC(r.d[2]||0),'warn');
    }else addLog('No response','error');
    recordPaper('Write DID',{success,dids:[{did:'0x'+hx(did,4),value:data.map(b=>hx(b)).join(' ')}]});
    setBusy('');
  },[writeDid,writeData,txAddr,rxAddr,addLog,recordPaper]);

  const startSession=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const s=parseInt(session,16);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x10,s]);
    const success=!!(r.ok&&r.d&&r.d[0]===0x50);
    if(success)addLog('✓ Session 0x'+hx(s)+' active','rx');
    else addLog('Session failed','error');
    recordPaper('Diag Session',{success,request:'10 '+hx(s)});
  },[session,txAddr,rxAddr,addLog,recordPaper]);

  const testerPresent=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x3E,0x00]);
    const success=!!(r.ok&&r.d&&r.d[0]===0x7E);
    if(success)addLog('✓ Module alive','rx');
    else addLog('No TesterPresent response','warn');
    recordPaper('Tester Present',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const routine=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const ctrl=parseInt(routineCtrl,16);
    const rid=parseInt(routineId,16);
    const data=hexToBytes(routineData);
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    setBusy('Routine...');
    const cmd=[0x31,ctrl,(rid>>8)&0xFF,rid&0xFF,...data];
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
    const r=await eng.current.uds(tx,rx,[0x19,0x02,0x08]);
    /* NOTE: this is the only DTC read surface in the app today.
       OBDTab.jsx does VIN scans, OBDSwarmDiagnostic.jsx does VIN
       discovery — neither calls 0x19. If a future tab adds a DTC
       read, share parseDtcResponse / formatDtcLogLine from
       ../lib/dtc.js — do not duplicate the parse loop. */
    const codes=[];
    if(r.ok&&r.d){
      const entries=parseDtcResponse(r.d);
      for(const entry of entries){
        const detail=buildDtcDetail(entry,{tx,rx});
        addLog(formatDtcLogLine(entry),'warn',{dtc:detail});
        codes.push(entry.code);
      }
      if(!codes.length)addLog('✓ No DTCs','rx');
    }
    /* Audit record contract is preserved: structured log row keeps
       just the hex codes, full details live on the in-memory log
       row only. Historical paper-trail diffs stay stable. */
    recordPaper('Read DTCs',{success:!!r.ok,dtcs:codes});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const clearDtcs=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x14,0xFF,0xFF,0xFF]);
    const success=!!(r.ok&&r.d&&r.d[0]===0x54);
    if(success)addLog('✓ DTCs cleared','rx');
    else addLog('Clear failed','error');
    recordPaper('Clear DTCs',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  const reset=useCallback(async()=>{
    if(!eng.current){addLog('Connect first','error');return;}
    const tx=parseAddr(txAddr),rx=parseAddr(rxAddr);
    const r=await eng.current.uds(tx,rx,[0x11,0x01]);
    const success=!!(r.ok&&r.d&&r.d[0]===0x51);
    if(success)addLog('✓ ECU reset','rx');
    else addLog('Reset failed','warn');
    recordPaper('ECU Reset',{success});
  },[txAddr,rxAddr,addLog,recordPaper]);

  return <div data-testid="uds-tab">
    <Card style={{background:'linear-gradient(135deg,#0A0A3D 0%,#1E1E6F 40%,#4A00E0 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🔬</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>UDS PROGRAMMER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>UNIVERSAL · RAW COMMANDS · ANY MODULE</div>
        </div>
        <div data-testid="uds-conn-status" style={{fontSize:11,padding:'6px 12px',background:conn?'#00C85333':'#FF174433',borderRadius:8,border:'1px solid '+(conn?'#00C853':'#FF1744')}}>
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
        </div>
        <div style={{padding:10,background:'#F8F6F2',borderRadius:8}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:6,fontWeight:700}}>WRITE DID (0x2E)</div>
          <div style={{display:'flex',gap:6,marginBottom:6}}>
            <input value={writeDid} onChange={e=>setWriteDid(e.target.value)} placeholder="F190" style={{flex:1,padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
            <Btn onClick={writeDidAction} disabled={!!busy||!conn} color={C.sr}>Write</Btn>
          </div>
          <input value={writeData} onChange={e=>setWriteData(e.target.value)} placeholder="data bytes (hex)" style={{width:'100%',padding:8,fontFamily:"'JetBrains Mono'",fontSize:13,border:'1px solid '+C.bd,borderRadius:6}}/>
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
      </div>
    </Card>

    <Card style={{marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>⚠️ DIAGNOSTICS</div>
      <div style={{display:'flex',gap:8}}>
        <Btn onClick={readDtcs} disabled={!!busy||!conn} color={C.a3} outline>📋 Read DTCs (19 02 08)</Btn>
        <Btn onClick={clearDtcs} disabled={!!busy||!conn} color={C.wn} outline>🗑️ Clear DTCs (14 FF FF FF)</Btn>
      </div>
    </Card>

    <Card style={{background:'#0D0D15',color:'#E0E0E0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{fontWeight:800,fontSize:12,color:'#B388FF',letterSpacing:2}}>📋 LOG</div>
        <button onClick={()=>setLog([])} style={{fontSize:10,color:'#666',background:'transparent',border:'1px solid #333',padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>CLEAR</button>
      </div>
      <div data-testid="uds-log" style={{maxHeight:380,overflowY:'auto',fontFamily:"'JetBrains Mono'",fontSize:10,lineHeight:1.6}}>
        {log.length===0&&<div style={{color:'#666',textAlign:'center',padding:20}}>Ready — send a command to begin</div>}
        {log.map((l,i)=>{
          const color=l.type==='error'?'#FF5252':l.type==='rx'?'#00E676':l.type==='tx'?'#40C4FF':l.type==='warn'?'#FFB300':'#AAA';
          if(l.dtc){
            const isOpen=dtcDetail&&dtcDetail._row===i;
            return <div key={i}>
              <div data-testid={'uds-log-dtc-'+l.dtc.code} onClick={()=>setDtcDetail(isOpen?null:{...l.dtc,_row:i})}
                style={{color,cursor:'pointer',userSelect:'none'}} title="Click for details">
                <span style={{color:'#555'}}>{l.t}</span> {l.m} <span style={{color:'#888'}}>{isOpen?'▾':'▸'}</span>
              </div>
              {isOpen&&<DtcDetailPanel detail={l.dtc}/>}
            </div>;
          }
          return <div key={i} style={{color}}>
            <span style={{color:'#555'}}>{l.t}</span> {l.m}
          </div>;
        })}
      </div>
    </Card>
  </div>;
}
