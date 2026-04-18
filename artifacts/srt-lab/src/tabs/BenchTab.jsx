import React, {useState, useCallback, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card,Tag,Btn,SLine} from "../lib/ui.jsx";
import {parseModule,extractHex,syncImmoBackup} from "../lib/parseModule.js";
import {writeModuleVIN,virginizeModule} from "../lib/fileUtils.js";
import {crc16,crc8_42,crc8rf} from "../lib/crc.js";
import {MODS} from "../lib/mods.js";
import {unlockKeyBytes, unlockIdForTx} from "../lib/algos.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {DownloadCounter} from "../lib/useDownloadCount.jsx";

function BenchTab(){
  const[mods,setMods]=useState([]);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');const[log,setLog]=useState([]);
  const[benchConn,setBenchConn]=useState(false);const[benchBusy,setBenchBusy]=useState('');
  const benchEng=useRef(null);
  const addLog=(m,l='info')=>setLog(p=>[...p,{m,l,t:new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}]);
  const dl=(d,n,assetId)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();if(assetId)trackDownload(assetId);};

  const loadFiles=useCallback(fl=>{
    Array.from(fl).forEach(f=>{
      const r=new FileReader();
      r.onload=ev=>{
        const d=new Uint8Array(ev.target.result);
        const m=parseModule(d,f.name);
        setMods(p=>[...p,m]);
        if(m.hexOnly)addLog('Unrecognized file (hex view only): '+f.name,'error');
        else{addLog('Loaded '+m.name+': '+f.name,'info');if(m.vins?.[0])addLog('  VIN: '+m.vins[0].vin,'rx');}
      };r.readAsArrayBuffer(f);
    });
  },[]);

  const writeAllVins=useCallback(()=>{
    if(nv.length!==17)return;
    mods.forEach((m,i)=>{
      const patched=writeModuleVIN(m.data,m.type,nv,m.vins);
      if(patched){dl(patched,'VIN_'+nv+'_'+m.filename,ASSET_IDS.benchPatchedVin);addLog(m.name+': VIN patched → '+nv,'rx');
        setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});
      }
    });
    setMsg('All modules patched with '+nv);
  },[mods,nv]);

  const doVirginRfhub=useCallback(()=>{
    const rf=mods.find(m=>m.type==='RFHUB');
    if(!rf){addLog('No RFHUB loaded','error');return;}
    const v=virginizeModule(rf.data,'RFHUB');
    dl(v,'VIRGIN_'+rf.filename,ASSET_IDS.benchVirginRfh);addLog('RFHUB virginized (bench)','rx');setMsg('RFHUB virginized');
  },[mods]);

  const doCrcPatch=useCallback(()=>{
    if(!mods.length){addLog('No modules loaded','error');return;}
    let patched=0;
    mods.forEach((m,idx)=>{
      const out=new Uint8Array(m.data);let fixes=0;
      if(m.type==='BCM'){
        for(let i=0;i<=out.length-19;i++){
          let v=true;for(let j=0;j<17;j++)if(out[i+j]<0x20||out[i+j]>0x7E){v=false;break;}
          if(!v)continue;let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(out[i+j]);
          if(!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))continue;
          const sc=(out[i+17]<<8)|out[i+18],cc=crc16(out.slice(i,i+17));
          if(sc!==cc){out[i+17]=(cc>>8)&0xFF;out[i+18]=cc&0xFF;addLog('  '+m.name+' @0x'+i.toString(16).toUpperCase()+': CRC16 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
          i+=16;
        }
        for(const po of[0x4098,0x40B0]){if(po+10>out.length)continue;
          let pk=true;for(let j=0;j<8;j++)if(out[po+j]<0x20||out[po+j]>0x7E){pk=false;break;}if(!pk)continue;
          const sc=(out[po+8]<<8)|out[po+9],cc=crc16(out.slice(po,po+8));
          if(sc!==cc){out[po+8]=(cc>>8)&0xFF;out[po+9]=cc&0xFF;addLog('  '+m.name+' @0x'+po.toString(16).toUpperCase()+': partial CRC16 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}}
      }else if(m.type==='95640'){
        for(const off of[0x275,0x288]){if(off+17>out.length)continue;
          let v=true;for(let j=0;j<17;j++)if(out[off+j]<0x20||out[off+j]>0x7E){v=false;break;}if(!v)continue;
          const sc=out[off-1],cc=crc8_42(out.slice(off,off+17));
          if(sc!==cc){out[off-1]=cc;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': CRC8 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }else if(m.type==='RFHUB'){
        for(const off of[0xEA5,0xEB9,0xECD,0xEE1]){if(off+18>out.length)continue;
          const st=out.slice(off,off+17);if(st.every(b=>b===0xFF||b===0))continue;
          const cc=crc8rf(st),sc=out[off+17];
          if(sc!==cc){out[off+17]=cc;addLog('  '+m.name+' @0x'+off.toString(16).toUpperCase()+': CRC8 '+sc.toString(16).toUpperCase()+' → '+cc.toString(16).toUpperCase(),'rx');fixes++;}
        }
      }
      if(fixes>0){dl(out,'CRC_PATCHED_'+m.filename,ASSET_IDS.benchCrcPatch);addLog(m.name+': '+fixes+' CRC(s) fixed → download','rx');patched++;
        setMods(p=>{const u=[...p];u[idx]=parseModule(out,m.filename);return u;});
      }else addLog(m.name+': all CRCs valid ✓','info');
    });
    setMsg(patched>0?patched+' module(s) CRC-patched':'All CRCs already valid');
  },[mods]);

  const benchConnect=useCallback(async()=>{
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
      addLog('Bench adapter: '+(isSTN?'STN/OBDLink':'ELM327'),'info');
      await send('ATL0');await send('ATS1');await send('ATH1');await send('ATSP6');await send('ATAT2');await send('ATST96');
      if(isSTN){await send('ATCAF1');await send('ATFCSH7E0');await send('ATFCSD300000');await send('ATFCSM1');}
      else{await send('ATCAF1');await send('ATFCSM1');}
      let curTx=0,curRx=0;
      benchEng.current={send,isSTN,uds:async(tx,rx,data)=>{
        if(tx!==curTx){await send('ATSH'+tx.toString(16).toUpperCase().padStart(3,'0'));if(isSTN)await send('ATFCSH'+tx.toString(16).toUpperCase().padStart(3,'0'));curTx=tx;}
        if(rx!==curRx){await send('ATCRA'+rx.toString(16).toUpperCase().padStart(3,'0'));curRx=rx;}
        const h=Array.from(data).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const r=await send(h,5000);
        if(!r||/NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR/.test(r))return{ok:false};
        if(r.includes('?')||r.includes('ERROR'))return{ok:false};
        const rxHex=rx.toString(16).toUpperCase().padStart(3,'0');
        const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(l=>l.length>0);
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
        if(!all.length)return{ok:false};
        return{ok:true,d:new Uint8Array(all)};
      }};
      setBenchConn(true);addLog('Bench ready — HS-CAN 500kbps','info');
    }catch(e){addLog('Bench connect failed: '+e.message,'error');}
  },[]);

  const benchWriteModule=useCallback(async(tx,rx,label)=>{
    if(!benchEng.current||nv.length!==17)return;setBenchBusy('Writing '+label+'...');
    try{
      await benchEng.current.uds(tx,rx,[0x10,0x03]);
      const sr=await benchEng.current.uds(tx,rx,[0x27,0x01]);
      if(sr.ok&&sr.d&&sr.d.length>=6&&sr.d[0]===0x67){const sb=Array.from(sr.d).slice(2);
        const nz=sb.some(b=>b!==0);
        if(nz){const aid=unlockIdForTx(tx);const kb=unlockKeyBytes(aid,sb);if(kb!==null){await benchEng.current.uds(tx,rx,[0x27,0x02,...kb]);addLog(label+' ('+aid+', '+kb.length+'B key) unlocked','rx');}}}
      const vb=[...new TextEncoder().encode(nv)];
      for(const did of[0xF190,0x7B90,0x7B88]){const r=await benchEng.current.uds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...vb]);addLog(label+' DID 0x'+did.toString(16).toUpperCase()+': '+(r.ok?'OK':'FAIL'),r.ok?'rx':'error');}
      await benchEng.current.uds(tx,rx,[0x11,0x01]);addLog(label+' VIN written + reset','rx');
    }catch(e){addLog(label+' error: '+e.message,'error');}finally{setBenchBusy('');}
  },[nv]);

  const benchReadVin=useCallback(async(tx,rx,label)=>{
    if(!benchEng.current)return;setBenchBusy('Reading '+label+'...');
    try{
      const r=await benchEng.current.uds(tx,rx,[0x22,0xF1,0x90]);
      if(r.ok&&r.d?.length>3){const vc=Array.from(r.d).filter(b=>b>=0x20&&b<=0x7E);const vin=String.fromCharCode(...vc).slice(-17);addLog(label+' VIN: '+vin,'rx');}
      else addLog(label+' read failed','error');
    }catch(e){addLog(label+' error: '+e.message,'error');}finally{setBenchBusy('');}
  },[]);

  const bcm=mods.find(m=>m.type==='BCM');
  const gpec=mods.find(m=>m.type==='GPEC2A');

  return<div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:16}}>
    <div>
      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
          <Btn onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadFiles(e.target.files);i.click();}} color={C.a3} full>📂 Load Module Files (.bin)</Btn>
        </div>
        <div style={{fontSize:10,color:C.ts,marginTop:8}}>Auto-detects BCM D-FLASH · RFHUB EEE · GPEC2A · 95640</div>
      </Card>

      {mods.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:12}}>Detected Modules ({mods.length})</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {mods.map((m,i)=><div key={i} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd,position:'relative'}}>
            <button onClick={()=>setMods(p=>p.filter((_,j)=>j!==i))} style={{position:'absolute',top:6,right:8,background:'none',border:'none',color:C.tm,cursor:'pointer',fontSize:12}}>✕</button>
            <div style={{fontSize:13,fontWeight:800,color:m.color}}>{m.name}</div>
            <div style={{fontSize:9,color:C.ts}}>{m.filename} · {(m.size/1024).toFixed(0)}KB</div>
            {m.vins?.[0]&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>{m.vins[0].vin}</div>}
          </div>)}
        </div>
      </Card>}

      {mods.length>0&&<Card glow style={{marginBottom:14}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Write VIN to All Modules</div>
        <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
          style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}}
          onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:10,alignItems:'center'}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
          <Btn onClick={writeAllVins} disabled={nv.length!==17||!mods.length}>⚡ Patch + Download All</Btn>
        </div>
        <div style={{marginTop:8}}><DownloadCounter assetId={ASSET_IDS.benchPatchedVin}/></div>
      </Card>}

      {mods.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>Quick Tools (Bench)</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <Btn onClick={()=>{if(!bcm){addLog('No BCM loaded','error');return;}addLog('BCM Proxi @0x2023: '+extractHex(bcm.data,0x2023,16),'rx');}} disabled={!bcm} color={C.a3} outline>📋 Read BCM Proxi</Btn>
          <Btn onClick={()=>{if(!gpec){addLog('No GPEC2A loaded','error');return;}addLog('SKIM State: '+(gpec.skimByte===0x80?'ENABLED':'DISABLED')+' (0x'+gpec.skimByte.toString(16).toUpperCase()+')','rx');}} disabled={!gpec} color={C.a2} outline>🛡️ Read SKIM State</Btn>
          <Btn onClick={doVirginRfhub} disabled={!mods.find(m=>m.type==='RFHUB')} color={C.er} outline>💀 Virginize RFHUB</Btn>
          <Btn onClick={()=>{if(!bcm){addLog('No BCM loaded','error');return;}if(bcm.immoBlank){addLog('BCM IMMO is blank — nothing to sync','warn');return;}const d=syncImmoBackup(bcm.data);if(!d){addLog('BCM file too small for IMMO sync','error');return;}dl(d,'IMMO_SYNCED_'+bcm.filename,ASSET_IDS.benchImmoSync);addLog('IMMO backup synced: '+bcm.immoRecs+' keys → 0x2000','rx');setMods(p=>{const u=[...p];const idx=u.findIndex(m=>m.type==='BCM');u[idx]=parseModule(d,bcm.filename);return u;});setMsg('IMMO backup synced');}} disabled={!bcm} color={C.a1} outline>🔄 Sync IMMO Backup</Btn>
          <Btn onClick={doCrcPatch} disabled={!mods.length} color={C.sr}>🔧 CRC Patch All</Btn>
        </div>
        <div style={{marginTop:8,display:'flex',gap:14,flexWrap:'wrap'}}>
          <DownloadCounter assetId={ASSET_IDS.benchVirginRfh}/>
          <DownloadCounter assetId={ASSET_IDS.benchImmoSync}/>
          <DownloadCounter assetId={ASSET_IDS.benchCrcPatch}/>
        </div>
        <div style={{marginTop:10,fontSize:10,color:C.ts}}>
          <div><b>Bench mode:</b> All operations work on loaded .bin files — no serial connection needed</div>
          <div><b>Downloads:</b> Each operation produces a modified .bin ready to write to chip</div>
        </div>
      </Card>}

      <Card glow style={{marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{fontSize:14,fontWeight:800}}>UDS Bench Tools</div>
          <Tag color={benchConn?C.gn:C.tm}>{benchConn?'CONNECTED':'OFFLINE'}</Tag>
        </div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
          <Btn onClick={benchConnect} disabled={benchConn} color={benchConn?C.gn:C.a3}>{benchConn?'✓ Bench Connected':'🔌 Connect OBDLink (Bench)'}</Btn>
        </div>
        {benchConn&&<>
          <input value={nv} maxLength={17} placeholder="Enter 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))}
            style={{width:'100%',padding:'10px 14px',borderRadius:10,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box',marginBottom:10}}
            onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:800,color:nv.length===17?C.sr:C.tm}}>{nv.length}/17</span>
            {benchBusy&&<span style={{fontSize:10,color:C.wn,fontWeight:700}}>{benchBusy}</span>}
          </div>
          <div style={{fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Write VIN</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
            <Btn onClick={()=>benchWriteModule(0x7A8,0x7B0,'ADCM')} disabled={!!benchBusy||nv.length!==17} color={C.a4}>⚡ Write ADCM</Btn>
            <Btn onClick={()=>benchWriteModule(0x740,0x748,'IPC')} disabled={!!benchBusy||nv.length!==17} color={C.a1}>⚡ Write IPC</Btn>
            <Btn onClick={()=>benchWriteModule(0x7E0,0x7E8,'ECM')} disabled={!!benchBusy||nv.length!==17} color={C.a2}>⚡ Write ECM</Btn>
            <Btn onClick={()=>benchWriteModule(0x7E1,0x7E9,'TCM')} disabled={!!benchBusy||nv.length!==17} color={C.a3}>⚡ Write TCM</Btn>
            <Btn onClick={()=>benchWriteModule(0x750,0x758,'BCM')} disabled={!!benchBusy||nv.length!==17} color={C.sr}>⚡ Write BCM</Btn>
          </div>
          <div style={{fontSize:12,fontWeight:800,color:C.tx,marginBottom:8}}>Read VIN</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <Btn onClick={()=>benchReadVin(0x7A8,0x7B0,'ADCM')} disabled={!!benchBusy} color={C.a4} outline>📖 Read ADCM</Btn>
            <Btn onClick={()=>benchReadVin(0x740,0x748,'IPC')} disabled={!!benchBusy} color={C.a1} outline>📖 Read IPC</Btn>
            <Btn onClick={()=>benchReadVin(0x7E0,0x7E8,'ECM')} disabled={!!benchBusy} color={C.a2} outline>📖 Read ECM</Btn>
            <Btn onClick={()=>benchReadVin(0x7E1,0x7E9,'TCM')} disabled={!!benchBusy} color={C.a3} outline>📖 Read TCM</Btn>
            <Btn onClick={()=>benchReadVin(0x750,0x758,'BCM')} disabled={!!benchBusy} color={C.sr} outline>📖 Read BCM</Btn>
          </div>
          <div style={{marginTop:10,fontSize:10,color:C.ts}}>
            <div><b>Flow:</b> Extended session → CDA6 security → Write DIDs (F190/7B90/7B88) → ECU Reset</div>
            <div><b>Bench:</b> Power module with 12V supply, connect OBDLink to CAN H/L pins</div>
          </div>
        </>}
        {!benchConn&&<div style={{fontSize:10,color:C.ts}}>Connect OBDLink to write VINs to individual modules on the bench via UDS over CAN</div>}
      </Card>

      {msg&&<div style={{marginTop:10,padding:'8px 12px',borderRadius:8,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    </div>

    <div style={{background:C.cd,borderRadius:14,padding:14,border:'1px solid '+C.bd,maxHeight:600,overflow:'auto',boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:8,letterSpacing:2}}>BENCH LOG</div>
      {log.map((e,i)=><div key={i} style={{fontSize:9,fontFamily:"'JetBrains Mono'",padding:'2px 0',color:e.l==='error'?C.er:e.l==='tx'?C.a3:e.l==='rx'?C.sr:C.ts}}>
        <span style={{color:C.tm,marginRight:4}}>{e.t}</span>{e.m}
      </div>)}
      {!log.length&&<div style={{fontSize:11,color:C.tm,textAlign:'center',padding:30}}>Load files to see log</div>}
    </div>
  </div>;
}

export default BenchTab;
