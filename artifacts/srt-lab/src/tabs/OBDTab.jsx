import React, {useState, useCallback, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card,Tag,Btn,SLine} from "../lib/ui.jsx";
import {MODS} from "../lib/mods.js";
import {u32, unlockKey, unlockIdForTx} from "../lib/algos.js";
import {backupModule,CRITICAL_DIDS} from "../lib/backups.js";
import {logSession} from "../lib/paperTrail.js";

const hx=(n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0');
/* Map OBD scan code → backup profile name. Modules without a profile skip
   the snapshot but the session is still logged with backupKey:null. */
const backupTypeFor=(code)=>CRITICAL_DIDS[code]?code:null;

function OBDTab(){
  const[conn,setConn]=useState(false);const[found,setFound]=useState([]);const[nv,setNv]=useState('');
  const[busy,setBusy]=useState('');const[prog,setProg]=useState(0);const[log,setLog]=useState([]);
  const eng=useRef(null);
  const addLog=(m,l='info')=>setLog(p=>[...p,{m,l,t:new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}]);

  const connect=useCallback(async()=>{
    try{
      if(!navigator.serial){addLog('Web Serial not available — use Chrome','error');return;}
      const port=await navigator.serial.requestPort();
      await port.open({baudRate:115200});
      const w=port.writable.getWriter();
      const rd=port.readable.getReader();
      const tdec=new TextDecoder();
      let rbuf='';
      /* Background IIFE reader — drains port continuously, eliminates stale Promise.race reads */
      (async()=>{while(true){try{const{value,done}=await rd.read();if(done)break;rbuf+=tdec.decode(value);}catch(e){break;}}})();
      const send=async(cmd,to=3000)=>{
        rbuf='';await w.write(new TextEncoder().encode(cmd+'\r'));addLog('TX > '+cmd,'tx');
        const deadline=Date.now()+to;
        while(Date.now()<deadline){
          const pi=rbuf.indexOf('>');
          if(pi!==-1){const r=rbuf.substring(0,pi).replace(/\r/g,'\n').replace(/\n+/g,'\n').trim();rbuf=rbuf.substring(pi+1);addLog('RX < '+r,'rx');return r;}
          await new Promise(r=>setTimeout(r,20));
        }
        const t=rbuf.replace(/\r/g,'\n').replace(/\n+/g,'\n').replace(/>/g,'').trim();if(t)addLog('RX (timeout) < '+t,'warn');return t;
      };
      await send('ATZ',2000);await new Promise(r=>setTimeout(r,500));
      await send('ATE0');
      const ati=await send('ATI');addLog('Firmware: '+ati,'info');
      const stdi=await send('STDI');
      const isSTN=!stdi.includes('?')&&!stdi.includes('ERROR')&&stdi.length>2;
      const at1=await send('AT@1');
      const rv=await send('ATRV');
      addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' | '+at1+' | '+rv,'info');
      await send('ATL0');await send('ATS1');await send('ATH1');await send('ATSP6');await send('ATAT2');await send('ATST96');
      if(isSTN){await send('ATCAF1');await send('ATFCSH7E0');await send('ATFCSD300000');await send('ATFCSM1');addLog('STN: CAF ON, auto flow control','info');}
      else{await send('ATCAF1');await send('ATFCSM1');addLog('ELM327: CAF ON, flow control mode 1','info');}
      let curTx=0,curRx=0;
      eng.current={send,isSTN,uds:async(tx,rx,data)=>{
        if(tx!==curTx){await send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));if(isSTN)await send('ATFCSH'+tx.toString(16).toUpperCase().padStart(3,'0'));curTx=tx;}
        if(rx!==curRx){await send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));curRx=rx;}
        const h=Array.from(data).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const r=await send(h,5000);
        if(!r||/NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR|BUS INIT|STOPPED/.test(r))return{ok:false,raw:r||''};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
        const rxHex=rx.toString(16).toUpperCase().padStart(3,'0');
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(l=>l.length>0);
        if(!lines.length)return{ok:false,raw:r};
        /* ISO-TP PCI stripper: PCI high nibble 0=SF,1=FF,2=CF; UDS responses start at nibble ≥4 */
        let all=[];
        for(const line of lines){
          if(line.includes('SEARCHING')||line==='OK')continue;
          const toks=line.split(/\s+/).filter(t=>/^[0-9A-Fa-f]{2,3}$/.test(t));if(!toks.length)continue;
          let dt;if(/^[0-9A-Fa-f]{3}$/.test(toks[0])){if(toks[0].toUpperCase()!==rxHex)continue;dt=toks.slice(1);}else{dt=toks;}
          if(!dt.length)continue;const b0=parseInt(dt[0],16);const pn=(b0>>4)&0xF;
          if(pn===0){for(let i=1;i<dt.length;i++)all.push(parseInt(dt[i],16));}
          else if(pn===1){for(let i=2;i<dt.length;i++)all.push(parseInt(dt[i],16));}
          else if(pn===2){for(let i=1;i<dt.length;i++)all.push(parseInt(dt[i],16));}
          else{for(const t of dt)all.push(parseInt(t,16));}
        }
        if(!all.length)return{ok:false,raw:r};
        return{ok:true,d:new Uint8Array(all),raw:r};
      }};
      setConn(true);addLog('Ready — HS-CAN 500kbps','info');
    }catch(e){addLog('Connect failed: '+e.message,'error');}
  },[]);

  const scan=useCallback(async()=>{
    if(!eng.current)return;setBusy('Scanning...');setFound([]);
    /* CAN-C = any module whose first addr is in 0x7E0-0x7EF (powertrain range) */
    const canC=MODS.filter(m=>m.addrs[0].tx>=0x7E0&&m.addrs[0].tx<=0x7EF);
    const canIHS=MODS.filter(m=>!(m.addrs[0].tx>=0x7E0&&m.addrs[0].tx<=0x7EF));
    /* Scan CAN-C modules — try each address variant until one responds */
    addLog('── Scanning CAN-C (HS-CAN pins 6/14) ──','info');
    for(const m of canC){
      let responded=false;
      for(const addr of m.addrs){try{
        const r=await eng.current.uds(addr.tx,addr.rx,[0x3E,0x00]);
        if(r.ok){
          addLog(m.c+' alive @ 0x'+addr.tx.toString(16).toUpperCase(),'rx');
          const vr=await eng.current.uds(addr.tx,addr.rx,[0x22,0xF1,0x90]);
          if(vr.ok&&vr.d?.length>3){const vc=Array.from(vr.d).filter(b=>b>=0x20&&b<=0x7E);const vin=String.fromCharCode(...vc).slice(-17);
            if(vin.length>=10){setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin}]);addLog(m.c+': '+vin,'rx');}
            else{setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin:'(present)'}]);addLog(m.c+': VIN unreadable','warn');}}
          else{setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin:'(present)'}]);addLog(m.c+': present, VIN read failed','warn');}
          responded=true;break;
        }
      }catch(e){addLog(m.c+' error: '+e.message,'error');}}
      if(!responded){addLog(m.c+': no response','error');}
      await new Promise(r=>setTimeout(r,100));
    }
    /* Switch to CAN-IHS (pins 3/11) via STP61 — STN adapters only */
    if(eng.current.isSTN){
      addLog('── Switching to CAN-IHS (MS-CAN pins 3/11) ──','info');
      const stp61r=await eng.current.send('STP61');
      if(stp61r.includes('?')||stp61r.includes('ERROR')){addLog('STP61 not supported — IHS scan skipped','warn');}
      else{
        await eng.current.send('STPBR 125000');
        await new Promise(r=>setTimeout(r,300));
        await eng.current.send('ATCRA');
        await eng.current.send('ATH1');
        await eng.current.send('ATST50');
        let ihsAbort=false;
        for(const m of canIHS){
          if(ihsAbort)break;
          let responded=false;
          for(const addr of m.addrs){
            if(ihsAbort)break;
            try{
              const r=await eng.current.uds(addr.tx,addr.rx,[0x3E,0x00]);
              /* Fast-fail: CAN ERROR = transceiver not wired to pins 3/11 */
              if(r.raw&&/CAN ERROR/.test(r.raw)){
                addLog('CAN ERROR on IHS bus — OBDLink EX transceiver is only wired to pins 6/14. Body module scan aborted. A physical Y-cable to pins 3/11 is required.','error');
                ihsAbort=true;break;
              }
              if(r.ok){
                addLog(m.c+' alive @ 0x'+addr.tx.toString(16).toUpperCase(),'rx');
                const vr=await eng.current.uds(addr.tx,addr.rx,[0x22,0xF1,0x90]);
                if(vr.ok&&vr.d?.length>3){const vc=Array.from(vr.d).filter(b=>b>=0x20&&b<=0x7E);const vin=String.fromCharCode(...vc).slice(-17);
                  if(vin.length>=10){setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin}]);addLog(m.c+': '+vin,'rx');}
                  else{setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin:'(present)'}]);addLog(m.c+': VIN unreadable','warn');}}
                else{setFound(p=>[...p,{...m,tx:addr.tx,rx:addr.rx,vin:'(present)'}]);addLog(m.c+': present, VIN read failed','warn');}
                responded=true;break;
              }
            }catch(e){addLog(m.c+' error: '+e.message,'error');}
          }
          if(!responded&&!ihsAbort){addLog(m.c+': no response on any address','error');}
          await new Promise(r=>setTimeout(r,100));
        }
      }
      /* Switch back to HS-CAN (pins 6/14) — STP60 unsupported on r2.1 */
      await eng.current.send('STPBR 500000');
      await eng.current.send('ATSP6');
      await new Promise(r=>setTimeout(r,100));
      await eng.current.send('ATST96');
      addLog('── Back on HS-CAN (pins 6/14) ──','info');
    }else{
      addLog('Adapter is not STN — cannot switch to CAN-IHS. Only CAN-C modules scanned.','warn');
    }
    setBusy('');addLog('Scan complete','info');
  },[]);

  const writeAll=useCallback(async()=>{
    if(!eng.current||nv.length!==17)return;setBusy('Writing...');setProg(0);
    for(let i=0;i<found.length;i++){const m=found[i];
      await eng.current.uds(m.tx,m.rx,[0x10,0x03]);
      const sr=await eng.current.uds(m.tx,m.rx,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const aid=unlockIdForTx(m.tx);const k=unlockKey(aid,sv);if(k!==null){await eng.current.uds(m.tx,m.rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);addLog(m.c+' ('+aid+') unlocked','rx');}}}
      /* Auto-snapshot before any 0x2E. Falls back to no-backup for modules
         without a profile (TCM, IPC, etc.) but the session record still notes it. */
      const bt=backupTypeFor(m.c);
      let backupKey=null;
      if(bt){
        addLog('Snapshotting '+bt+' before write...','info');
        const b=await backupModule(eng.current.uds,m.tx,m.rx,bt,addLog,hx);
        backupKey=b?.key||null;
      }else addLog('No backup profile for '+m.c+' — write proceeds without snapshot','warn');
      const vb=[...new TextEncoder().encode(nv)];
      const writeResults=[];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await eng.current.uds(m.tx,m.rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);writeResults.push({did,ok:!!r.ok});addLog(m.c+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await eng.current.uds(m.tx,m.rx,[0x11,0x01]);addLog(m.c+' reset sent','info');
      const allOk=writeResults.every(w=>w.ok);
      logSession({
        module:m.c,
        operation:'OBD Bulk VIN Write',
        oldVin:m.vin&&m.vin!=='(present)'?m.vin:null,
        newVin:nv,
        moduleAddr:{tx:m.tx,rx:m.rx},
        adapter:eng.current?.isSTN?'OBDLink/STN':'ELM327',
        success:allOk,
        backupKey,
        dids:writeResults.map(w=>({did:'0x'+hx(w.did,4),ok:w.ok})),
      });
      setProg(Math.round(((i+1)/found.length)*100));
    }setBusy('');addLog('All modules written + sessions logged','info');
  },[found,nv]);

  const readProxi=useCallback(async()=>{
    if(!eng.current)return;setBusy('Reading proxi...');
    const r=await eng.current.uds(0x750,0x758,[0x22,0x20,0x23]);
    if(r.ok)addLog('BCM Proxi: '+hxb(r.d),'rx');else addLog('Proxi read failed','error');
    setBusy('');
  },[]);

  const readSkim=useCallback(async()=>{
    if(!eng.current)return;setBusy('Reading SKIM...');
    const r=await eng.current.uds(0x750,0x758,[0x22,0x6E,0x9E,0xB0]);
    if(r.ok){const v=r.d?.length>0?r.d[r.d.length-1]:null;addLog('SKIM State: '+(v===0x80?'ENABLED':'DISABLED')+' (0x'+(v?.toString(16).toUpperCase()||'??')+')','rx');}
    else addLog('SKIM read failed','error');setBusy('');
  },[]);

  const writeOneModule=useCallback(async(tx,rx,label)=>{
    if(!eng.current||nv.length!==17)return;setBusy('Writing '+label+'...');
    let backupKey=null,oldVin=null,allOk=false;
    try{
      await eng.current.uds(tx,rx,[0x10,0x03]);
      const sr=await eng.current.uds(tx,rx,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const aid=unlockIdForTx(tx);const k=unlockKey(aid,sv);if(k!==null){await eng.current.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);addLog(label+' ('+aid+') unlocked','rx');}}}
      const bt=backupTypeFor(label);
      if(bt){
        addLog('Snapshotting '+label+' before write...','info');
        const b=await backupModule(eng.current.uds,tx,rx,bt,addLog,hx);
        backupKey=b?.key||null;
        const vinDid=b?.dids?.[0xF190]; if(vinDid?.ascii)oldVin=vinDid.ascii.slice(-17);
      }else addLog('No backup profile for '+label+' — write proceeds without snapshot','warn');
      const vb=[...new TextEncoder().encode(nv)];
      const writeResults=[];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await eng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);writeResults.push({did,ok:!!r.ok});addLog(label+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await eng.current.uds(tx,rx,[0x11,0x01]);addLog(label+' VIN written + reset','rx');
      allOk=writeResults.every(w=>w.ok);
      logSession({
        module:label,operation:'OBD Single Module VIN Write',
        oldVin,newVin:nv,moduleAddr:{tx,rx},
        adapter:eng.current?.isSTN?'OBDLink/STN':'ELM327',
        success:allOk,backupKey,
        dids:writeResults.map(w=>({did:'0x'+hx(w.did,4),ok:w.ok})),
      });
    }catch(e){addLog(label+' error: '+e.message,'error');
      logSession({module:label,operation:'OBD Single Module VIN Write',oldVin,newVin:nv,moduleAddr:{tx,rx},success:false,backupKey,notes:'Exception: '+e.message});
    }finally{setBusy('');}
  },[nv,addLog]);

  const virginRfhub=useCallback(async()=>{
    if(!eng.current)return;setBusy('Virginizing RFHUB...');
    let backupKey=null,oldVin=null,ok=false;
    try{
      await eng.current.uds(0x75F,0x767,[0x10,0x03]);
      const sr=await eng.current.uds(0x75F,0x767,[0x27,0x01]);
      if(sr.ok&&sr.d){const sb=Array.from(sr.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=u32(sv);
        if(sv){const aid=unlockIdForTx(0x75F);const k=unlockKey(aid,sv);if(k!==null){await eng.current.uds(0x75F,0x767,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);}}}
      addLog('Snapshotting RFHUB before virginize...','info');
      const b=await backupModule(eng.current.uds,0x75F,0x767,'RFHUB',addLog,hx);
      backupKey=b?.key||null;
      const vinDid=b?.dids?.[0xF190]; if(vinDid?.ascii)oldVin=vinDid.ascii.slice(-17);
      const blank=new Array(17).fill(0x00);
      const results=[];
      for(const did of[0xF190,0x7B90]){const r=await eng.current.uds(0x75F,0x767,[0x2E,(did>>8)&0xFF,did&0xFF,...blank]);results.push({did,ok:!!r.ok});}
      await eng.current.uds(0x75F,0x767,[0x11,0x01]);
      ok=results.every(w=>w.ok);
      addLog('RFHUB virginized over OBD','rx');
      logSession({
        module:'RFHUB',operation:'OBD Virginize (zero VIN)',
        oldVin,newVin:'(virgin / zeros)',moduleAddr:{tx:0x75F,rx:0x767},
        adapter:eng.current?.isSTN?'OBDLink/STN':'ELM327',
        success:ok,backupKey,
        dids:results.map(w=>({did:'0x'+hx(w.did,4),ok:w.ok})),
      });
    }catch(e){addLog('Virginize error: '+e.message,'error');
      logSession({module:'RFHUB',operation:'OBD Virginize (zero VIN)',oldVin,newVin:'(virgin / zeros)',moduleAddr:{tx:0x75F,rx:0x767},success:false,backupKey,notes:'Exception: '+e.message});
    }finally{setBusy('');}
  },[addLog]);

  const canMonitor=useCallback(async()=>{
    if(!eng.current)return;setBusy('Monitoring...');
    addLog('=== CAN BUS MONITOR — listening 5 sec ===','info');
    try{
      await eng.current.send('ATCRA');/* clear CRA filter = accept all */
      await new Promise(r=>setTimeout(r,100));
      const r=await eng.current.send('ATMA',6000);
      /* break out of ATMA */
      await eng.current.send('',500);
      await new Promise(r=>setTimeout(r,300));
      if(r){
        const ids=new Set();
        r.split(/[\r\n]+/).forEach(line=>{
          const clean=line.trim();
          if(/^[0-9A-Fa-f]{3}\s/.test(clean))ids.add(clean.slice(0,3).toUpperCase());
        });
        if(ids.size>0){
          addLog('Active CAN IDs: '+[...ids].sort().join(', '),'rx');
          for(const id of ids){
            const num=parseInt(id,16);
            const mod=MODS.find(m=>m.addrs.some(a=>a.tx===num||a.rx===num));
            if(mod)addLog('  '+id+' → '+mod.c+' ('+mod.n+')','rx');
            else addLog('  '+id+' → unknown','warn');
          }
        }else{addLog('No CAN traffic detected — check wiring and power','error');addLog('Raw: '+r.slice(0,200),'warn');}
      }else{addLog('ATMA returned nothing — bus may be silent','error');}
      await eng.current.send('ATSP6');
      await eng.current.send('ATCAF1');
    }catch(e){addLog('CAN monitor error: '+e.message,'error');}
    finally{setBusy('');}
  },[]);

  return<div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:16}}>
    <div>
      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <Btn onClick={connect} disabled={conn} color={conn?C.gn:C.a3} full>{conn?'✓ Connected':'🔌 Connect ELM327 / OBDLink'}</Btn>
          {conn&&<Btn onClick={scan} disabled={!!busy} color={C.a1}>{busy||'📡 Scan Modules'}</Btn>}
          {conn&&<Btn onClick={canMonitor} disabled={!!busy} color={C.a4} outline>📻 CAN Monitor</Btn>}
        </div>
      </Card>
      {found.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Modules on Bus ({found.length})</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {found.map((m,i)=><div key={i} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:13,fontWeight:800,color:C.sr}}>{m.c}</div>
            <div style={{fontSize:9,color:C.ts}}>{m.n} · TX 0x{m.tx.toString(16).toUpperCase()}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>{m.vin}</div>
          </div>)}
        </div>
      </Card>}
      {conn&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Write VIN to All Modules</div>
        <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
          style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}}
          onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:10,alignItems:'center'}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
          <Btn onClick={writeAll} disabled={nv.length!==17||!found.length||!!busy}>{busy||'⚡ Write to '+found.length+' modules'}</Btn>
        </div>
        {prog>0&&prog<100&&<div style={{marginTop:10,height:5,borderRadius:3,background:C.bd,overflow:'hidden'}}><div style={{height:'100%',width:prog+'%',background:'linear-gradient(90deg,#D32F2F,#FF5252)',borderRadius:3,transition:'width 0.4s'}}/></div>}
      </Card>}
      {conn&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>Quick Tools</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={readProxi} disabled={!!busy} color={C.a3} outline>📋 Read BCM Proxi</Btn>
          <Btn onClick={readSkim} disabled={!!busy} color={C.a2} outline>🛡️ Read SKIM State</Btn>
          <Btn onClick={virginRfhub} disabled={!!busy} color={C.er} outline>💀 Virginize RFHUB</Btn>
        </div>
        <div style={{marginTop:12,fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Write VIN to Single Module</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={()=>writeOneModule(0x7A8,0x7B0,'ADCM')} disabled={!!busy||nv.length!==17} color={C.a4} outline>🔧 Write ADCM</Btn>
          <Btn onClick={()=>writeOneModule(0x740,0x748,'IPC')} disabled={!!busy||nv.length!==17} color={C.a1} outline>🔧 Write IPC</Btn>
          <Btn onClick={()=>writeOneModule(0x7E0,0x7E8,'ECM')} disabled={!!busy||nv.length!==17} color={C.a2} outline>🔧 Write ECM</Btn>
          <Btn onClick={()=>writeOneModule(0x7E1,0x7E9,'TCM')} disabled={!!busy||nv.length!==17} color={C.a3} outline>🔧 Write TCM</Btn>
        </div>
        <div style={{marginTop:6,fontSize:9,color:C.wn}}>{nv.length!==17?'↑ Enter VIN above to enable individual writes':''}</div>
        <div style={{marginTop:10,fontSize:10,color:C.ts}}>
          <div><b>DIDs:</b> 0xF190 VIN · 0x7B90 Current · 0x7B88 Original · 0x2023 Proxi · 0x6E9EB0 SKIM</div>
          <div><b>Security:</b> Extended session (10 03) → Seed (27 01) → CDA6 key → Send (27 02) → Write (2E) → Reset (11 01)</div>
        </div>
      </Card>}
    </div>
    <div style={{background:C.cd,borderRadius:14,padding:14,border:'1px solid '+C.bd,maxHeight:600,overflow:'auto',boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:8,letterSpacing:2}}>UDS TRAFFIC LOG</div>
      {log.map((e,i)=><div key={i} style={{fontSize:9,fontFamily:"'JetBrains Mono'",padding:'2px 0',color:e.l==='error'?C.er:e.l==='tx'?C.a3:e.l==='rx'?C.sr:C.ts}}>
        <span style={{color:C.tm,marginRight:4}}>{e.t}</span>{e.m}
      </div>)}
      {!log.length&&<div style={{fontSize:11,color:C.tm,textAlign:'center',padding:30}}>Connect to see traffic</div>}
    </div>
  </div>;
}

/* ═══ DUMPS TAB ═══ */

export default OBDTab;
