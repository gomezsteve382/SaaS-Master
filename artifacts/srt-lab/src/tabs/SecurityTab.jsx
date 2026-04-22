import React, {useState, useCallback, useMemo} from "react";
import {C,TC,TL,SKIM_OFF,IMMO_BLOCK,IMMO_REC,IMMO_KC} from "../lib/constants.js";
import {Card,Tag,Btn,SLine} from "../lib/ui.jsx";
import {parseModule,arrEq,fO,countSkimRecs,syncImmoBackup} from "../lib/parseModule.js";
import {writeModuleVIN,virginizeModule} from "../lib/fileUtils.js";
import {crossValidate,computeDiff,compareGpecBcmKey} from "../lib/crossValidate.js";
import {crc16} from "../lib/crc.js";
import MismatchWizard from "../components/MismatchWizard.jsx";
import {statusBanner, loadAdvanced, saveAdvanced} from "../lib/plainEnglish.jsx";
const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');

function SecurityTab(){
  const[mods,setMods]=useState([]);const[sub,setSub]=useState('overview');const[tv,setTv]=useState('');
  const[msg,setMsg]=useState('');const[dp,setDp]=useState([0,1]);const[tt,setTt]=useState(0);
  const[tr,setTr]=useState(null);const[flashList,setFlashList]=useState([]);const[keySrc,setKeySrc]=useState(-1);
  const[advanced,setAdvancedState]=useState(()=>loadAdvanced('security'));
  const[wizardOpen,setWizardOpen]=useState(false);
  const setAdvanced=v=>{setAdvancedState(v);saveAdvanced('security',v);};

  const addF=useCallback(fl=>{
    Array.from(fl).forEach(f=>{
      const r=new FileReader();
      r.onload=ev=>{
        const d=new Uint8Array(ev.target.result);
        const m=parseModule(d,f.name);
        if(m.type!=='UNKNOWN'&&m.type!=='FW')setMods(p=>{const u=[...p,m];if(!tv&&m.vins?.[0])setTv(m.vins[0].vin);return u;});
      };r.readAsArrayBuffer(f);
    });
  },[tv]);

  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};
  const rmMod=i=>setMods(p=>p.filter((_,j)=>j!==i));

  const allVins=useMemo(()=>{const s=new Set();mods.forEach(m=>{if(m.vins)m.vins.forEach(v=>s.add(v.vin));});return[...s];},[mods]);
  const vinBad=allVins.length>1;
  const val=useMemo(()=>mods.length>0?crossValidate(mods):null,[mods]);

  const skimG=useMemo(()=>{
    const bcmMod=mods.find(m=>m.type==='BCM');if(!bcmMod)return[];
    const r=[];for(const c of SKIM_OFF){if(c.base+c.ks*c.kc>bcmMod.size)continue;
      const keys=[];let has=false;
      for(let i=0;i<c.kc;i++){const o=c.base+i*c.ks;const kb=bcmMod.data.slice(o,o+c.ks);const hex=hxb(kb);if(!kb.every(b=>b===0xFF||b===0))has=true;keys.push({slot:i+1,off:o,hex,empty:kb.every(b=>b===0xFF||b===0)});}
      if(has)r.push({v:c.v,keys,base:c.base});}
    return r;
  },[mods]);

  const diff=useMemo(()=>{if(mods.length<2)return null;const a=mods[dp[0]]?.data,b=mods[dp[1]]?.data;return a&&b?computeDiff(a,b):null;},[mods,dp]);

  const sks=useMemo(()=>mods.filter(m=>m.skey&&!m.skb).map(m=>({idx:mods.indexOf(m),type:m.type,key:m.skey,fn:m.filename})),[mods]);
  const skBad=useMemo(()=>{if(sks.length<2)return false;for(let i=1;i<sks.length;i++)for(let j=0;j<sks[0].key.length;j++)if(sks[0].key[j]!==sks[i].key[j])return true;return false;},[sks]);

  function adaptKey(srcKey,srcEndian,dstEndian,dstLen){
    let k=Array.from(srcKey);
    if(srcEndian!==dstEndian&&srcEndian&&dstEndian)k=k.reverse();
    while(k.length<dstLen)k.push(0xFF);
    return new Uint8Array(k.slice(0,dstLen));
  }
  function keyWidthWarning(srcMod,dstMod){
    if(!srcMod||!dstMod||!srcMod.skey||!dstMod.skey)return null;
    if(srcMod.skey.length<dstMod.skey.length)return srcMod.type+' has '+srcMod.skey.length+'B key → '+dstMod.type+' needs '+dstMod.skey.length+'B (padded with 0xFF)';
    return null;
  }
  function syncKey(si,ti){const s=mods[si],t=mods[ti];if(!s.skey||s.skb||t.skoff===undefined)return;const p=new Uint8Array(t.data);const adapted=adaptKey(s.skey,s.skEndian,t.skEndian,Math.min(s.skey.length,16));for(let i=0;i<adapted.length;i++)p[t.skoff+i]=adapted[i];if(t.type==='GPEC2A'&&t.skmoff!==undefined)for(let i=0;i<Math.min(adapted.length,8);i++)p[t.skmoff+i]=adapted[i];dl(p,t.filename.replace(/\./,'_KEYSYNCED.'));setMods(prev=>{const u=[...prev];u[ti]=parseModule(p,t.filename);return u;});setMsg('Key from '+s.filename+' → '+t.filename);}

  function patchModVIN(i){
    if(tv.length!==17)return;const m=mods[i];
    const patched=writeModuleVIN(m.data,m.type,tv,m.vins);
    if(patched){const fn=m.filename.replace(/\./,'_VIN_'+tv+'.');dl(patched,fn);setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});setMsg('Patched '+m.name+' → '+tv);}
  }

  function matchAll(){
    if(!mods.length)return;const doVin=tv.length===17;
    const results=[];let srcKey=null;
    if(keySrc>=0&&mods[keySrc]&&mods[keySrc].skey&&!mods[keySrc].skb){const sk=mods[keySrc];srcKey={data:sk.skey,type:sk.type,fn:sk.filename,endian:sk.skEndian};}
    else{for(const m of mods){if(m.skey&&!m.skb){srcKey={data:m.skey,type:m.type,fn:m.filename,endian:m.skEndian};break;}}}
    const rfhubForSec6=mods.find(mn=>mn.type==='RFHUB'&&mn.sec16valid&&mn.sec16s?.length);
    mods.forEach((m,i)=>{
      let patched=doVin?writeModuleVIN(m.data,m.type,tv,m.vins):null;
      if(!patched)patched=new Uint8Array(m.data);
      if(srcKey&&m.skoff!==undefined){
        const adapted=adaptKey(srcKey.data,srcKey.endian,m.skEndian,Math.min(srcKey.data.length,16));
        let needsSync=m.skb;
        if(!needsSync&&m.skey){for(let j=0;j<Math.min(adapted.length,m.skey.length);j++)if(adapted[j]!==m.skey[j]){needsSync=true;break;}}
        if(needsSync){for(let j=0;j<adapted.length;j++)patched[m.skoff+j]=adapted[j];if(m.type==='GPEC2A'&&m.skmoff!==undefined)for(let j=0;j<Math.min(adapted.length,8);j++)patched[m.skmoff+j]=adapted[j];}
      }
      if(m.type==='GPEC2A'&&rfhubForSec6){const s16=rfhubForSec6.sec16s[0].raw;for(let i=0;i<6&&i<s16.length;i++)patched[0x3C8+i]=s16[i];}
      const fn='MATCHED_'+tv+'_'+m.filename;
      const flashNote=m.type==='BCM'?'Flash this BCM D-FLASH file':m.type==='RFHUB'?'Write this RFHUB to EEE chip':m.type==='GPEC2A'?'Write this GPEC2A to 95320 SPI chip':m.type==='95640'?'Write this 95640 EEPROM':'Flash this file';
      results.push({data:patched,fn,type:m.type,name:m.name,note:flashNote,original:m.filename});
      setMods(p=>{const u=[...p];u[i]=parseModule(patched,m.filename);return u;});
    });
    const postCheck=crossValidate(results.map(r=>parseModule(r.data,r.fn)));
    const statusNote=postCheck.issues.length===0?' — all checks passed':' — '+postCheck.issues.length+' issue(s) remain';
    setFlashList(results);setMsg('All modules matched'+(doVin?' to '+tv:'')+(srcKey?' with key from '+srcKey.fn:'')+statusNote);setSub('tools');
    return {ok:postCheck.issues.length===0,patched:results.length,remainingIssues:postCheck.issues.length,issues:postCheck.issues};
  }

  function doTool(action){
    const m=mods[tt];if(!m)return;let res=null;
    if(action==='virginize'){const d=virginizeModule(m.data,m.type);res={data:d,desc:m.name+' virginized: keys/VINs/SKIM cleared.'};}
    else if(action==='writeVin'&&tv.length===17){const d=writeModuleVIN(m.data,m.type,tv,m.vins);if(d)res={data:d,desc:'VIN updated to '+tv+' at '+(m.vins?m.vins.length:0)+' locations'+(m.type==='BCM'?' + IMMO backup synced':'')};}
    else if(action==='skimToggle'&&m.type==='GPEC2A'){const d=new Uint8Array(m.data);d[0x0011]=m.skimByte===0x80?0x00:0x80;res={data:d,desc:'SKIM: 0x'+m.skimByte.toString(16).toUpperCase()+' → 0x'+d[0x0011].toString(16).toUpperCase()};}
    else if(action==='extractKey'){let k=m.secretKey?m.secretKey.hex:m.vehicleSecret?m.vehicleSecret.hex:m.skey&&!m.skb?hxb(m.skey):'';res={keyHex:k,desc:'Extracted from '+m.type};}
    else if(action==='syncImmo'&&m.type==='BCM'){const d=syncImmoBackup(m.data);if(d)res={data:d,desc:'IMMO backup synced: '+countSkimRecs(m.data,0x40C0)+' SKIM records copied 0x40C0 → 0x2000'};else res={desc:'BCM file too small for IMMO sync'};}
    else if(action==='rfhPcmSync'&&m.type==='GPEC2A'){
      const rfh=mods.find(mn=>mn.type==='RFHUB');
      if(rfh&&rfh.sec16valid&&rfh.sec16s?.length){
        const d=new Uint8Array(m.data);const s16=rfh.sec16s[0].raw;
        for(let i=0;i<6&&i<s16.length;i++)d[0x3C8+i]=s16[i];
        const hex6=Array.from(s16.slice(0,6)).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        res={data:d,desc:'PCM SEC6 @ 0x3C8 ← RFHUB SEC16[0:6]: '+hex6};
      }else res={desc:'RFHUB must be loaded with valid (non-blank, matching) SEC16 slots.'};
    }
    else if(action==='rfhBcmSync'&&m.type==='95640'){
      const rfh=mods.find(mn=>mn.type==='RFHUB');
      if(rfh&&rfh.sec16valid&&rfh.sec16s?.length){
        const d=new Uint8Array(m.data);
        if(d.length>=0x84A){
          /* Byte-reverse RFH SEC16 slot 1 → write to 95640 @ 0x838 */
          const s16=rfh.sec16s[0].raw;
          const rev=new Uint8Array(16);for(let i=0;i<16;i++)rev[i]=s16[15-i];
          for(let i=0;i<16;i++)d[0x838+i]=rev[i];
          /* CRC16 of the 16 reversed bytes → write big-endian @ 0x848 */
          const cs=crc16(rev);d[0x848]=(cs>>8)&0xFF;d[0x849]=cs&0xFF;
          const revHex=Array.from(rev).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
          res={data:d,desc:'95640 BCM-SEC16 @ 0x838 ← RFH SEC16 (byte-reversed): '+revHex+' CRC16='+cs.toString(16).toUpperCase().padStart(4,'0')};
        }else res={desc:'95640 file too small (need ≥0x84A bytes)'};
      }else res={desc:'RFHUB must be loaded with valid (non-blank, matching) SEC16 slots.'};
    }
    setTr(res);
    if(res?.data)setMods(prev=>{const u=[...prev];u[tt]=parseModule(res.data,m.filename);return u;});
  }
  const dlResult=()=>{if(!tr?.data)return;const b=new Blob([tr.data],{type:'application/octet-stream'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='modified_'+(mods[tt]?.filename||'module.bin');a.click();URL.revokeObjectURL(u);};

  function syncGpecRfh(){
    const gm=mods.find(m=>m.type==='GPEC2A');
    const rm=mods.find(m=>m.type==='RFHUB'&&m.sec16valid);
    if(!gm||!rm||tv.length!==17)return;
    /* 1. Patch GPEC2A VINs (no CRC for GPEC2A) */
    let gd=writeModuleVIN(gm.data,'GPEC2A',tv,gm.vins);
    if(!gd)gd=new Uint8Array(gm.data);
    /* 2. Write RFHUB SEC16[0:6] → GPEC2A PCM SEC6 @ 0x3C8 */
    const s16=rm.sec16s[0].raw;
    for(let i=0;i<6&&i<s16.length;i++)gd[0x3C8+i]=s16[i];
    const sec6hex=Array.from(s16.slice(0,6)).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
    /* 3. Patch RFHUB VINs (mirrored + CRC8RF per slot — writeModuleVIN handles this) */
    const rd=writeModuleVIN(rm.data,'RFHUB',tv,rm.vins)||new Uint8Array(rm.data);
    /* 4. Update both modules in state immediately */
    setMods(prev=>{
      const u=[...prev];
      const gi=u.findIndex(m=>m.type==='GPEC2A');
      const ri=u.findIndex(m=>m.type==='RFHUB'&&m.sec16valid);
      if(gi>=0)u[gi]=parseModule(gd,gm.filename);
      if(ri>=0)u[ri]=parseModule(rd,rm.filename);
      return u;
    });
    /* 5. Download both patched files */
    dl(gd,gm.filename.replace(/\./,'_SYNCED.'));
    dl(rd,rm.filename.replace(/\./,'_SYNCED.'));
    setMsg('✓ GPEC2A + RFHUB synced → '+tv+' | PCM SEC6: '+sec6hex+' | VINs patched + CRC updated');
  }

  const SUBS=[{id:'overview',l:'Overview'},{id:'security',l:'Security'},{id:'diff',l:'Diff'},{id:'tools',l:'Tools'}];
  const selSt={background:C.c2,color:C.tx,border:'1px solid '+C.bd,borderRadius:6,padding:'6px 12px',fontSize:12,fontFamily:'inherit'};

  return<div>
    <div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>addF(e.target.files);i.click();}} onDrop={e=>{e.preventDefault();addF(e.dataTransfer.files);}} onDragOver={e=>e.preventDefault()}>
      <Card style={{textAlign:'center',padding:'24px',cursor:'pointer',border:'2px dashed '+C.sr+'25',marginBottom:16}} onClick={()=>{}}>
        <span style={{fontSize:32}}>🛡️</span>
        <div style={{fontSize:16,fontWeight:900,color:C.sr,marginTop:4}}>Drop Module Files for Cross-Vehicle Matching</div>
        <div style={{fontSize:11,color:C.ts}}>BCM · 95640 · RFHUB EEE · GPEC2A — compare keys, sync VINs, match security bytes</div>
        {mods.length>0&&<Tag color={C.a3}>{mods.length} loaded</Tag>}
      </Card>
    </div>

    {/* ─── Plain-English status banner + guided fix entry point ─── */}
    {mods.length>0&&(()=>{
      const modNames=mods.map(m=>TL[m.type]||m.type).filter(Boolean);
      const banner=statusBanner({issues:val?.issues||[],warnings:val?.warnings||[],modules:modNames});
      const tone=banner.tone;
      const bg=tone==='error'?C.er+'12':tone==='warning'?C.wn+'10':tone==='ok'?C.gn+'10':C.c2;
      const fg=tone==='error'?C.er:tone==='warning'?C.wn:tone==='ok'?C.gn:C.tx;
      const bd=tone==='error'?C.er+'40':tone==='warning'?C.wn+'40':tone==='ok'?C.gn+'40':C.bd;
      const icon=tone==='error'?'❌':tone==='warning'?'⚠️':tone==='ok'?'✅':'ℹ️';
      return<div data-testid="security-status-banner" style={{display:'flex',alignItems:'center',gap:14,padding:'14px 18px',borderRadius:12,marginBottom:12,background:bg,border:'1.5px solid '+bd,flexWrap:'wrap'}}>
        <div style={{fontSize:28}}>{icon}</div>
        <div style={{flex:1,minWidth:200}}>
          <div style={{fontWeight:900,fontSize:14,color:fg,marginBottom:2}}>{banner.headline}</div>
          <div style={{fontSize:12,color:C.ts,lineHeight:1.5}}>{banner.detail}</div>
        </div>
        {(tone==='error'||tone==='warning')&&<button
          data-testid="security-open-guided-fix"
          onClick={()=>setWizardOpen(true)}
          style={{background:'linear-gradient(135deg,'+C.sr+' 0%,'+C.a1+' 100%)',border:'none',borderRadius:10,padding:'10px 20px',color:'#fff',fontWeight:900,fontSize:12,cursor:'pointer',letterSpacing:.5,fontFamily:"'Nunito'",boxShadow:'0 2px 8px rgba(211,47,47,0.25)'}}>
          🔧 Open Guided Fix →
        </button>}
        <label
          data-testid="security-advanced-toggle"
          title="Show byte-level diffs, SKIM grid, sub-tab nav, and per-module tools"
          style={{display:'flex',alignItems:'center',gap:6,fontSize:11,fontWeight:700,color:advanced?C.a3:C.tm,fontFamily:"'Nunito'",cursor:'pointer',userSelect:'none',padding:'6px 12px',borderRadius:8,border:'1px solid '+(advanced?C.a3+'60':C.bd),background:advanced?C.a3+'14':'none'}}>
          <input type="checkbox" checked={advanced} onChange={e=>setAdvanced(e.target.checked)} style={{accentColor:C.a3,cursor:'pointer'}}/>
          Advanced
        </label>
      </div>;
    })()}

    {mods.length>0&&advanced&&<>
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontSize:10,fontWeight:800,color:C.sr,letterSpacing:2,marginBottom:6}}>TARGET VIN</div>
        <input value={tv} maxLength={17} placeholder="17-char target VIN" onChange={e=>setTv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))} style={{width:'100%',padding:'10px 14px',borderRadius:10,border:'2px solid '+C.bd,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:15,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box',color:C.tx}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
        {(vinBad||skBad)&&<div style={{marginTop:8}}>
          {sks.length>1&&<div style={{marginBottom:6,display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:10,fontWeight:800,color:C.tm}}>Key Source:</span>
            <select value={keySrc} onChange={e=>setKeySrc(+e.target.value)} style={{background:C.c2,color:C.tx,border:'1px solid '+C.bd,borderRadius:6,padding:'4px 10px',fontSize:11,fontFamily:'inherit'}}>
              <option value={-1}>Auto (first with key)</option>
              {sks.map(s=><option key={s.idx} value={s.idx}>{s.fn} ({TL[s.type]||s.type})</option>)}
            </select>
          </div>}
          <Btn onClick={matchAll} disabled={vinBad&&tv.length!==17} full>⚡ Match All Modules{tv.length===17?' → '+tv:''} + Download Files to Flash</Btn>
          {vinBad&&tv.length!==17&&<div style={{fontSize:10,color:C.wn,marginTop:4}}>Enter a 17-char target VIN above to sync VINs</div>}
        </div>}
      </Card>

      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <div style={{padding:'7px 12px',borderRadius:8,fontSize:11,fontWeight:800,background:vinBad?C.er+'10':C.gn+'10',color:vinBad?C.er:C.gn}}>{vinBad?'⚠ VIN MISMATCH — '+allVins.length+' different VINs':'✓ All VINs Match'}</div>
        {sks.length>0&&<div style={{padding:'7px 12px',borderRadius:8,fontSize:11,fontWeight:800,background:skBad?C.er+'10':C.gn+'10',color:skBad?C.er:C.gn}}>{skBad?'⚠ SECRET KEY MISMATCH':'✓ Secret Keys Match'}</div>}
      </div>

      <div style={{display:'flex',gap:2,marginBottom:16}}>
        {SUBS.map(s=><button key={s.id} onClick={()=>setSub(s.id)} style={{padding:'8px 18px',border:'none',cursor:'pointer',background:sub===s.id?C.sr:C.cd,color:sub===s.id?'#fff':C.ts,borderRadius:8,fontFamily:"'Nunito'",fontWeight:800,fontSize:11,letterSpacing:.8,transition:'all 0.2s'}}>{s.l}</button>)}
      </div>
    </>}

    {/* OVERVIEW SUB-TAB */}
    {advanced&&sub==='overview'&&mods.length>0&&<div>
      {val&&<Card style={{marginBottom:16,padding:16}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>Cross-Module Validation</div>
        {val.issues.map((m,i)=><SLine key={'i'+i} type="error" msg={m}/>)}
        {val.warnings.map((m,i)=><SLine key={'w'+i} type="warn" msg={m}/>)}
        {val.passed.map((m,i)=><SLine key={'p'+i} type="pass" msg={m}/>)}
      </Card>}

      {mods.map((m,i)=><Card key={i} style={{marginBottom:14,padding:16}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <Tag color={m.color}>{m.name}</Tag>
          <span style={{fontSize:12,fontWeight:700}}>{m.filename}</span>
          <span style={{fontSize:10,color:C.tm}}>{(m.size/1024).toFixed(0)}KB</span>
          <button onClick={()=>rmMod(i)} style={{marginLeft:'auto',background:'none',border:'none',color:C.tm,cursor:'pointer',fontSize:14}}>✕</button>
        </div>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr>{['Offset','Category','Value','Detail'].map(h=><th key={h} style={{textAlign:'left',color:C.tm,fontWeight:600,padding:'6px 10px',borderBottom:'1px solid '+C.bd,fontSize:10,textTransform:'uppercase',letterSpacing:.5}}>{h}</th>)}</tr></thead>
            <tbody>
              {m.vins?.map((v,j)=><tr key={'v'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(v.offset)}</td><td><Tag color={C.gn}>VIN {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.gn,fontWeight:700,fontSize:12}}>{v.vin}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{v.mirrored?'17B Mirrored':'17B ASCII'}{v.crcOk!==undefined&&<Tag color={v.crcOk?C.gn:C.er} style={{marginLeft:6}}>CRC8 {v.crcOk?'✓':'✗'}</Tag>}</td></tr>)}
              {m.partialVins?.map((pv,j)=><tr key={'pv'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(pv.offset)}</td><td><Tag color={C.a2}>TAIL {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a2,fontWeight:700,fontSize:12}}>{pv.tail}</td><td style={{padding:'5px 10px',color:pv.crcOk?C.gn:C.er,fontSize:12}}>8B partial CRC {pv.crcOk?'✓':'✗'}</td></tr>)}
              {m.skimStatus!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0011</td><td><Tag color={C.sr}>SKIM</Tag></td><td style={{padding:'5px 10px',color:m.skimByte===0x80?C.gn:C.er,fontWeight:700,fontSize:12}}>0x{m.skimByte.toString(16).toUpperCase()} — {m.skimStatus}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Immobilizer byte</td></tr>}
              {m.secretKey&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.secretKey.offset)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:C.a4,fontWeight:700,fontSize:12}}>{m.secretKey.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>8B sync key {m.keyConsistent?'✓':'✗'}</td></tr>}
              {m.vehicleSecret&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.vehicleSecret.offset)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:C.a4,fontWeight:700,fontSize:12}}>{m.vehicleSecret.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{m.vehicleSecret.endian}-endian 16B</td></tr>}
              {m.skey&&!m.vehicleSecret&&!m.secretKey&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.skoff)}</td><td><Tag color={C.a4}>SECRET</Tag></td><td style={{padding:'5px 10px',color:m.skb?C.tm:C.a4,fontWeight:700,fontSize:12}}>{m.skb?'ERASED':hxb(m.skey)}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>16B key</td></tr>}
              {m.transponderKeys?.map((tk,j)=><tr key={'t'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(tk.offset)}</td><td><Tag color={C.a1}>FOBIK {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontSize:12}}>{tk.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Transponder</td></tr>)}
              {m.immoKeys?.map((ik,j)=><tr key={'k'+j}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(ik.offset)}</td><td><Tag color={C.a1}>IMMO {j+1}</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontSize:12}}>{ik.hex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>IMMO entry</td></tr>)}
              {m.zzzzTamper&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(m.zzzzTamper.offset)}</td><td><Tag color={C.wn}>TAMPER</Tag></td><td style={{padding:'5px 10px',color:m.zzzzTamper.intact?C.gn:C.wn,fontSize:12}}>{m.zzzzTamper.hex} — {m.zzzzTamper.intact?'INTACT':'CLEARED'}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>ZZZZ</td></tr>}
              {m.securityLock&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x8028</td><td><Tag color={C.sr}>LOCK</Tag></td><td style={{padding:'5px 10px',color:m.securityLock.locked?C.gn:C.wn,fontWeight:700,fontSize:12}}>0x{m.securityLock.value.toString(16).toUpperCase()}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{m.securityLock.locked?'LOCKED':'UNLOCKED'}</td></tr>}
              {m.rfhGen&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>—</td><td><Tag color={C.a3}>GEN</Tag></td><td style={{padding:'5px 10px',fontSize:12,fontWeight:700}}>{m.rfhGen}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>RFH generation</td></tr>}
              {m.sec16s?.map(s=><tr key={'s16-'+s.slot}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(s.offset)}</td><td><Tag color={s.blank?C.tm:s.slot===1?C.sr:C.a4}>SEC16-{s.slot}</Tag></td><td style={{padding:'5px 10px',fontFamily:"'JetBrains Mono'",fontSize:10,color:s.blank?C.tm:C.sr,fontWeight:700,wordBreak:'break-all'}}>{s.blank?'(blank)':s.hex}</td><td style={{padding:'5px 10px',fontSize:12,color:C.tm}}>{!s.blank&&<span>CS:{s.cs.toString(16).toUpperCase().padStart(4,'0')} {s.csOk!==undefined&&<Tag color={s.csOk?C.gn:C.er}>CS {s.csOk?'OK ✓':'FAIL ✗'}</Tag>}</span>}</td></tr>)}
              {m.sec16s?.length===2&&!m.sec16s[0].blank&&<><tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>—</td><td><Tag color={m.sec16match?C.gn:C.wn}>MATCH</Tag></td><td style={{padding:'5px 10px',fontSize:12,color:m.sec16match?C.gn:C.wn,fontWeight:700}}>Slots match: {m.sec16match?'YES':'NO'}</td><td/></tr><tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>—</td><td><Tag color={C.a4}>RFH→BCM</Tag></td><td style={{padding:'5px 10px',fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4,fontWeight:700,wordBreak:'break-all'}}>{m.sec16s[0].bcmHex}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Derived (reversed)</td></tr></>}
              {m.pcmSec6&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x03C8</td><td><Tag color={m.pcmSec6.damaged?C.er:C.a4}>PCM-SEC6</Tag></td><td style={{padding:'5px 10px',fontFamily:"'JetBrains Mono'",fontSize:11,color:m.pcmSec6.damaged?C.er:C.a4,fontWeight:700}}>{m.pcmSec6.hex}</td><td style={{padding:'5px 10px',color:m.pcmSec6.damaged?C.er:C.gn,fontSize:12,fontWeight:700}}>{m.pcmSec6.immoState}</td></tr>}
              {m.fobikSlots!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0880</td><td><Tag color={C.a1}>FOBIK</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontWeight:700,fontSize:12}}>{m.fobikSlots} slots</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>AA50 pattern</td></tr>}
              {m.fobikCount!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x5862</td><td><Tag color={C.a1}>FOBIK</Tag></td><td style={{padding:'5px 10px',color:C.a1,fontWeight:700,fontSize:12}}>{m.fobikCount} keys</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>BCM count</td></tr>}
              {m.partNumbers&&Object.entries(m.partNumbers).map(([k,v])=><tr key={k}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>—</td><td><Tag color={C.a3}>PN-{k.toUpperCase()}</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{v}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Part#</td></tr>)}
              {m.partNumberStr&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0FA1</td><td><Tag color={C.a3}>SRI</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{m.partNumberStr}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SW Release</td></tr>}
              {m.runtimeCounters&&Object.entries(m.runtimeCounters).map(([k,v])=><tr key={k}><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>{fO(v.offset)}</td><td><Tag color={C.tm}>CTR</Tag></td><td style={{padding:'5px 10px',fontSize:12}}>{v.hex} ({v.value.toLocaleString()})</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>{k}</td></tr>)}
              {m.immoBlank!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x40C0</td><td><Tag color={C.sr}>IMMO</Tag></td><td style={{padding:'5px 10px',color:m.immoBlank?C.wn:C.gn,fontWeight:700,fontSize:12}}>{m.immoBlank?'BLANK':m.immoRecs+' keys'}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SKIM primary</td></tr>}
              {m.bakBlank!==undefined&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x2000</td><td><Tag color={C.sr}>BACKUP</Tag></td><td style={{padding:'5px 10px',color:m.bakBlank?C.wn:C.gn,fontWeight:700,fontSize:12}}>{m.bakBlank?'BLANK':m.bakRecs+' keys'}{!m.bakBlank&&!m.immoBlank&&<Tag color={m.immoSynced?C.gn:C.wn}>{m.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>SKIM backup</td></tr>}
              {m.bcmSec16&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0838</td><td><Tag color={m.bcmSec16.blank?C.tm:m.bcmSec16.csOk?C.a4:C.wn}>BCM-SEC16</Tag></td><td style={{padding:'5px 10px',fontFamily:"'JetBrains Mono'",fontSize:10,color:m.bcmSec16.blank?C.tm:C.a4,fontWeight:700,wordBreak:'break-all'}}>{m.bcmSec16.blank?'(blank)':m.bcmSec16.hex}{!m.bcmSec16.blank&&<div style={{color:C.sr,fontSize:9,marginTop:2}}>→RFH: {m.bcmSec16.reversedHex}</div>}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>16B+CRC16 {m.bcmSec16.csOk?<Tag color={C.gn}>CRC ✓</Tag>:m.bcmSec16.blank?'':<Tag color={C.wn}>CRC ✗</Tag>}</td></tr>}
              {m.rfhVin92&&<tr><td style={{padding:'5px 10px',color:C.a3,fontSize:12}}>0x0092</td><td><Tag color={m.rfhVin92.csOk?C.gn:C.wn}>VIN@92</Tag></td><td style={{padding:'5px 10px',color:m.rfhVin92.csOk?C.gn:C.wn,fontWeight:700,fontSize:12}}>{m.rfhVin92.vin}</td><td style={{padding:'5px 10px',color:C.tm,fontSize:12}}>Secondary VIN {m.rfhVin92.csOk?<Tag color={C.gn}>CRC16 ✓</Tag>:<Tag color={C.wn}>CRC16 ✗</Tag>}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>)}

      {skimG.length>0&&<Card style={{marginTop:8,padding:16}}>
        <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>🔐 SKIM Key Grid</div>
        {skimG.map((g,gi)=><div key={gi} style={{marginBottom:12}}>
          <div style={{fontSize:12,fontWeight:800,color:C.a1,marginBottom:6}}>{g.v} — 0x{g.base.toString(16).toUpperCase()}</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
            {g.keys.map(k=><div key={k.slot} style={{padding:10,borderRadius:10,background:C.c2,border:'1px solid '+(k.empty?C.bd:C.gn+'40')}}>
              <div style={{display:'flex',justifyContent:'space-between'}}><span style={{fontSize:10,fontWeight:700,color:C.tm}}>KEY {k.slot}</span><Tag color={k.empty?C.tm:C.gn}>{k.empty?'EMPTY':'SET'}</Tag></div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:8,color:k.empty?'#D5D0C8':C.ts,marginTop:4,wordBreak:'break-all'}}>{k.hex}</div>
            </div>)}
          </div>
        </div>)}
        <Btn onClick={()=>{let t='SKIM KEYS\n';skimG.forEach(g=>{t+=g.v+' @0x'+g.base.toString(16).toUpperCase()+'\n';g.keys.forEach(k=>{t+='  Key '+k.slot+': '+(k.empty?'EMPTY':k.hex)+'\n';});});navigator.clipboard?.writeText(t);setMsg('SKIM keys copied to clipboard');}} color={C.a1} outline>📋 Copy Keys</Btn>
      </Card>}
    </div>}

    {/* SECURITY SUB-TAB */}
    {advanced&&sub==='security'&&mods.length>0&&(()=>{
      const secGpec=mods.find(m=>m.type==='GPEC2A');
      const secBcm=mods.find(m=>m.type==='BCM');
      const gpecBcmCmp=(secGpec&&secGpec.secretKey&&secBcm&&secBcm.vehicleSecret)?compareGpecBcmKey(secGpec.secretKey.bytes,secBcm.vehicleSecret.bytes):null;
      const toHex=arr=>Array.from(arr).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
      const canSync=secGpec&&mods.find(m=>m.type==='RFHUB'&&m.sec16valid)&&tv.length===17;
      return<div>
      {canSync&&<Card style={{marginBottom:12,padding:14,border:'2px solid '+C.sr+'60',background:C.sr+'08'}}>
        <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:C.sr,marginBottom:2}}>🔗 GPEC2A ↔ RFHUB Sync Ready</div>
            <div style={{fontSize:11,color:C.tm}}>Patches RFHUB SEC16[0:6] → GPEC2A PCM SEC6 · Writes VIN to both modules with correct CRC · Downloads both files</div>
          </div>
          <Btn onClick={syncGpecRfh} color={C.sr}>🔗 Sync GPEC2A + RFHUB → {tv}</Btn>
        </div>
      </Card>}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:12}}>
        {mods.map((m,i)=>{const vinOk=m.vins?.length>0&&m.vins[0].vin===tv;return<Card key={i} style={{padding:16,borderLeft:'3px solid '+m.color,borderColor:vinOk?C.gn+'50':m.vins?.length&&tv.length===17?C.er+'40':C.bd}}>
          <div style={{fontWeight:800,color:m.color,marginBottom:8,fontSize:14}}>{m.name}</div>
          <div style={{fontSize:11,color:C.tm,marginBottom:8}}>{m.filename} · {(m.size/1024).toFixed(0)}KB</div>
          {m.vins?.[0]&&<div style={{fontSize:12,marginBottom:4}}>VIN: <span style={{fontFamily:"'JetBrains Mono'",fontWeight:800,color:vinOk?C.gn:C.er}}>{m.vins[0].vin}</span>{vinOk?<Tag color={C.gn}>MATCH</Tag>:<Tag color={C.er}>MISMATCH</Tag>}</div>}
          {m.skimStatus!==undefined&&<div style={{fontSize:11,marginBottom:4}}>SKIM: <span style={{color:m.skimByte===0x80?C.gn:C.er,fontWeight:700}}>{m.skimStatus}</span></div>}
          {m.secretKey&&<div style={{fontSize:11,marginBottom:4}}>Secret: <span style={{fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{m.secretKey.hex}</span> {m.keyConsistent?'✓':'✗'}</div>}
          {m.vehicleSecret&&<div style={{fontSize:11,marginBottom:4}}>Secret ({m.vehicleSecret.endian}): <span style={{fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{m.vehicleSecret.hex}</span></div>}
          {m.skey&&!m.vehicleSecret&&!m.secretKey&&<div style={{fontSize:11,marginBottom:4}}>Secret @0x{m.skoff.toString(16).toUpperCase()}: <span style={{fontFamily:"'JetBrains Mono'",color:m.skb?C.tm:C.a4,fontSize:10}}>{m.skb?'ERASED':hxb(m.skey)}</span>
            {(m.skb||skBad)&&sks.length>0&&<div style={{marginTop:4}}>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{sks.filter(s=>s.idx!==i).map(s=>{const w=keyWidthWarning(mods[s.idx],m);return<span key={s.idx} title={w||''}><Btn onClick={()=>syncKey(s.idx,i)} color={C.a4} outline>Copy from {TL[s.type]||s.type}{w?' ⚠':''}  </Btn></span>;})}</div>
              {sks.filter(s=>s.idx!==i).some(s=>keyWidthWarning(mods[s.idx],m))&&<div style={{fontSize:9,color:C.wn,marginTop:2}}>⚠ Key width mismatch — shorter keys padded with 0xFF</div>}
            </div>}
          </div>}
          {m.sec16s?.map(s=><div key={'sc'+s.slot} style={{fontSize:11,marginBottom:2}}>SEC16-{s.slot} <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:s.blank?C.tm:C.sr}}>{s.blank?'(blank)':s.hex.slice(0,16)+'…'}</span> <Tag color={s.blank?C.tm:m.sec16valid?C.gn:C.wn}>{s.blank?'BLANK':m.sec16valid&&s.slot===1?'VALID ✓':'–'}</Tag></div>)}
          {m.pcmSec6&&<div style={{fontSize:11,marginBottom:2}}>PCM SEC6: <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:m.pcmSec6.damaged?C.er:C.a4}}>{m.pcmSec6.hex}</span> <Tag color={m.pcmSec6.damaged?C.er:C.gn}>{m.pcmSec6.immoState}</Tag></div>}
          {m.fobikSlots!==undefined&&<div style={{fontSize:11}}>FOBIK: <span style={{color:C.a1,fontWeight:700}}>{m.fobikSlots} slots</span> · CC66AA55: {m.securityMarkers} · ZZZZ: {m.zzzzBlocks}</div>}
          {m.fobikCount!==undefined&&<div style={{fontSize:11}}>FOBIK: <span style={{color:C.a1,fontWeight:700}}>{m.fobikCount} keys</span></div>}
          {m.securityLock&&<div style={{fontSize:11}}>Lock: <span style={{color:m.securityLock.locked?C.gn:C.wn,fontWeight:700}}>{m.securityLock.locked?'0x5A LOCKED':'UNLOCKED'}</span></div>}
          {m.zzzzTamper&&<div style={{fontSize:11}}>Tamper: <span style={{color:m.zzzzTamper.intact?C.gn:C.wn,fontWeight:700}}>{m.zzzzTamper.intact?'INTACT':'CLEARED'}</span></div>}
          {m.immoBlank!==undefined&&<div style={{fontSize:11,marginTop:4}}>Immo @0x40C0: <Tag color={m.immoBlank?C.wn:C.gn}>{m.immoBlank?'BLANK':m.immoRecs+' keys'}</Tag></div>}
          {m.bakBlank!==undefined&&<div style={{fontSize:11,marginTop:2}}>Backup @0x2000: <Tag color={m.bakBlank?C.tm:C.gn}>{m.bakBlank?'BLANK':m.bakRecs+' keys'}</Tag>{!m.bakBlank&&!m.immoBlank&&<Tag color={m.immoSynced?C.gn:C.wn}>{m.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>}
          {m.fobBlank!==undefined&&<div style={{fontSize:11}}>Fob Data: <Tag color={m.fobBlank?C.tm:C.gn}>{m.fobBlank?'NONE':'HAS FOBS'}</Tag></div>}
          {m.bcmSec16&&<div style={{fontSize:11,marginTop:4}}>BCM-SEC16 @0x838: <Tag color={m.bcmSec16.blank?C.tm:m.bcmSec16.csOk?C.a4:C.wn}>{m.bcmSec16.blank?'BLANK':'SET'}</Tag>{!m.bcmSec16.blank&&<><Tag color={m.bcmSec16.csOk?C.gn:C.wn}>CRC16 {m.bcmSec16.csOk?'✓':'✗'}</Tag><div style={{fontFamily:"'JetBrains Mono'",fontSize:8,color:C.a4,marginTop:2,wordBreak:'break-all'}}>{m.bcmSec16.hex}</div></>}</div>}
          {m.rfhVin92&&<div style={{fontSize:11,marginTop:4}}>VIN@0x92: <span style={{fontFamily:"'JetBrains Mono'",fontWeight:700,color:m.rfhVin92.csOk?C.gn:C.wn,fontSize:10}}>{m.rfhVin92.vin}</span> <Tag color={m.rfhVin92.csOk?C.gn:C.wn}>CRC16 {m.rfhVin92.csOk?'✓':'✗'}</Tag></div>}
          {tv.length===17&&<div style={{marginTop:8}}><Btn onClick={()=>patchModVIN(i)} full color={vinOk?C.gn:C.sr}>{vinOk?'↓ Download':'⚡ Patch → '+tv}</Btn></div>}
        </Card>;})}
      </div>
      {gpecBcmCmp&&<Card style={{marginTop:16,padding:16,borderTop:'3px solid '+(gpecBcmCmp.match?C.gn:C.er)}}>
        <div style={{fontWeight:800,fontSize:14,marginBottom:4,color:gpecBcmCmp.match?C.gn:C.er}}>GPEC↔BCM Key Comparison {gpecBcmCmp.match?'✓ MATCH':'✗ MISMATCH'}</div>
        <div style={{fontSize:10,color:C.tm,marginBottom:10}}>Rule: BCM 16B little-endian → reversed (big-endian), first 8B vs GPEC 8B key</div>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>
            <th style={{textAlign:'left',color:C.tm,fontWeight:600,padding:'4px 8px',borderBottom:'1px solid '+C.bd,fontSize:10,textTransform:'uppercase'}}>Module</th>
            <th style={{textAlign:'left',color:C.tm,fontWeight:600,padding:'4px 8px',borderBottom:'1px solid '+C.bd,fontSize:10,textTransform:'uppercase'}}>Key (8B)</th>
            <th style={{textAlign:'left',color:C.tm,fontWeight:600,padding:'4px 8px',borderBottom:'1px solid '+C.bd,fontSize:10,textTransform:'uppercase'}}>Status</th>
          </tr></thead>
          <tbody>
            <tr>
              <td style={{padding:'5px 8px',color:C.a1,fontWeight:700}}>GPEC2A @0x0203</td>
              <td style={{padding:'5px 8px',fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{toHex(gpecBcmCmp.gpecBytes)}</td>
              <td style={{padding:'5px 8px'}}><Tag color={gpecBcmCmp.match?C.gn:C.er}>{gpecBcmCmp.match?'MATCH':'MISMATCH'}</Tag></td>
            </tr>
            <tr>
              <td style={{padding:'5px 8px',color:C.a3,fontWeight:700}}>BCM @0x40C9 [rev↑][0:8]</td>
              <td style={{padding:'5px 8px',fontFamily:"'JetBrains Mono'",color:C.a4,fontSize:10}}>{toHex(gpecBcmCmp.bcmBytes)}</td>
              <td style={{padding:'5px 8px'}}><Tag color={gpecBcmCmp.match?C.gn:C.er}>{gpecBcmCmp.match?'MATCH':'MISMATCH'}</Tag></td>
            </tr>
            <tr>
              <td style={{padding:'5px 8px',color:C.tm}}>BCM full (BE)</td>
              <td colSpan={2} style={{padding:'5px 8px',fontFamily:"'JetBrains Mono'",color:C.tm,fontSize:9}}>{toHex(gpecBcmCmp.bcmFull)}</td>
            </tr>
          </tbody>
        </table>
      </Card>}
      </div>;
    })()}

    {/* DIFF SUB-TAB */}
    {advanced&&sub==='diff'&&<div>
      {mods.length<2?<Card style={{textAlign:'center',padding:30}}><div style={{color:C.tm}}>Load 2+ modules to compare.</div></Card>:<div>
        <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center'}}>
          <select value={dp[0]} onChange={e=>setDp([+e.target.value,dp[1]])} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename}</option>)}</select>
          <span style={{color:C.tm}}>↔</span>
          <select value={dp[1]} onChange={e=>setDp([dp[0],+e.target.value])} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename}</option>)}</select>
        </div>
        {diff&&<div>
          <div style={{fontSize:12,color:C.wn,marginBottom:12,fontWeight:700}}>{diff.totalChanged} bytes changed, {diff.groups.length} regions</div>
          <Card style={{padding:16,maxHeight:500,overflowY:'auto'}}>
            {diff.groups.slice(0,50).map(([s,e],gi)=>{
              const a=mods[dp[0]].data,b=mods[dp[1]].data;
              const ls=s&~0xf,le=(e|0xf)+1,lines=[];
              for(let o=ls;o<le&&o<Math.max(a.length,b.length);o+=16){
                const ha=[],hb=[];
                for(let j=0;j<16&&o+j<Math.max(a.length,b.length);j++){
                  const idx=o+j,va=a[idx]||0,vb=b[idx]||0,ch=diff.changedSet.has(idx);
                  ha.push({v:va.toString(16).padStart(2,'0').toUpperCase(),c:ch});
                  hb.push({v:vb.toString(16).padStart(2,'0').toUpperCase(),c:ch});
                }lines.push({o,ha,hb});
              }
              return<div key={gi} style={{marginBottom:12}}>
                <div style={{fontSize:10,color:C.tm,fontWeight:700}}>{fO(s)}–{fO(e)} ({e-s+1}B)</div>
                {lines.map((l,li)=><div key={li} style={{display:'flex',gap:16,fontSize:11,lineHeight:1.6,fontFamily:"'JetBrains Mono'"}}>
                  <span style={{color:C.a3,minWidth:40}}>{l.o.toString(16).toUpperCase().padStart(4,'0')}</span>
                  <span style={{minWidth:200}}>{l.ha.map((h,hi)=><span key={hi} style={{color:h.c?C.er:C.tm,marginRight:4}}>{h.v}</span>)}</span>
                  <span style={{color:C.tm}}>→</span>
                  <span>{l.hb.map((h,hi)=><span key={hi} style={{color:h.c?C.gn:C.tm,marginRight:4}}>{h.v}</span>)}</span>
                </div>)}
              </div>;
            })}
            {diff.groups.length>50&&<div style={{color:C.tm,fontSize:11}}>+{diff.groups.length-50} more regions</div>}
          </Card>
        </div>}
      </div>}
    </div>}

    {/* TOOLS SUB-TAB */}
    {advanced&&sub==='tools'&&<div>
      {mods.length===0?<Card style={{textAlign:'center',padding:30}}><div style={{color:C.tm}}>Load a module first.</div></Card>:<div>
        <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center'}}>
          <span style={{fontSize:12,color:C.tm,fontWeight:700}}>Target:</span>
          <select value={tt} onChange={e=>setTt(+e.target.value)} style={selSt}>{mods.map((m,i)=><option key={i} value={i}>{m.filename} ({m.name})</option>)}</select>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12}}>
          <Card style={{padding:16,borderTop:'3px solid '+C.gn}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>VIN Writer</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Update VIN at all locations with CRC.</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,color:tv.length===17?C.gn:C.tm,marginBottom:8}}>{tv||'Set target VIN above'} ({tv.length}/17)</div>
            <Btn onClick={()=>doTool('writeVin')} disabled={tv.length!==17} full>Write VIN</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.sr}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>SKIM Manager</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Toggle SKIM byte at 0x0011 (GPEC2A).</div>
            {mods[tt]?.type==='GPEC2A'?<div>
              <div style={{fontSize:12,marginBottom:8}}>Current: <span style={{color:mods[tt].skimByte===0x80?C.gn:C.er,fontWeight:700}}>0x{mods[tt].skimByte.toString(16).toUpperCase()}</span></div>
              <Btn onClick={()=>doTool('skimToggle')} full>{mods[tt].skimByte===0x80?'Disable SKIM':'Enable SKIM'}</Btn>
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a GPEC2A module.</div>}
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.wn}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Virginize Module</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Clear keys, SKIM, ZZZZ, VINs.</div>
            <Btn onClick={()=>doTool('virginize')} full color={C.wn}>Virginize {mods[tt]?.name||''}</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.a4}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Extract Secret Key</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Extract immobilizer sync key.</div>
            <Btn onClick={()=>doTool('extractKey')} full color={C.a4}>Extract</Btn>
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.a1}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Sync IMMO Backup</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Copy SKIM keys 0x40C0 → 0x2000 (BCM only).</div>
            {mods[tt]?.type==='BCM'?<div>
              <div style={{fontSize:11,marginBottom:6}}>Primary: <Tag color={mods[tt].immoBlank?C.wn:C.gn}>{mods[tt].immoBlank?'BLANK':mods[tt].immoRecs+' keys'}</Tag></div>
              <div style={{fontSize:11,marginBottom:8}}>Backup: <Tag color={mods[tt].bakBlank?C.tm:C.gn}>{mods[tt].bakBlank?'BLANK':mods[tt].bakRecs+' keys'}</Tag>{!mods[tt].bakBlank&&!mods[tt].immoBlank&&<Tag color={mods[tt].immoSynced?C.gn:C.wn}>{mods[tt].immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>
              <Btn onClick={()=>doTool('syncImmo')} disabled={mods[tt].immoBlank} full color={C.a1}>🔄 Sync IMMO Backup</Btn>
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a BCM module.</div>}
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.sr}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>RFH → PCM SEC6 Import</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Write RFHUB SEC16[0:6] → PCM 0x3C8 (Cherokee/Trackhawk pairing).</div>
            {mods[tt]?.type==='GPEC2A'?<div>
              {(()=>{const rfh=mods.find(mn=>mn.type==='RFHUB');if(!rfh)return<div style={{fontSize:11,color:C.wn}}>Also load an RFHUB (24C32) dump.</div>;
              const s1=rfh.sec16s?.[0];
              return<div>
                <div style={{fontSize:11,marginBottom:4}}>RFHUB: <Tag color={rfh.rfhGen?C.a3:C.tm}>{rfh.rfhGen||'?'}</Tag></div>
                <div style={{fontSize:11,marginBottom:4}}>SEC16 Slot 1 <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:s1&&!s1.blank?C.sr:C.tm}}>{s1&&!s1.blank?s1.hex.slice(0,24)+'…':'(blank)'}</span> <Tag color={rfh.sec16valid?C.gn:C.wn}>{rfh.sec16valid?'VALID ✓':'BLANK/MISMATCH'}</Tag></div>
                {mods[tt].pcmSec6&&<div style={{fontSize:11,marginBottom:8}}>PCM SEC6 now: <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:mods[tt].pcmSec6.damaged?C.er:C.a4}}>{mods[tt].pcmSec6.hex}</span> <Tag color={mods[tt].pcmSec6.damaged?C.er:C.gn}>{mods[tt].pcmSec6.immoState}</Tag></div>}
                <Btn onClick={()=>doTool('rfhPcmSync')} disabled={!rfh.sec16valid} full color={C.sr}>🔑 Import SEC6 from RFHUB</Btn>
                {!rfh.sec16valid&&<div style={{fontSize:9,color:C.wn,marginTop:4}}>RFHUB SEC16 must be non-blank and both slots matching</div>}
              </div>;})()}
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a GPEC2A (PCM) as target.</div>}
          </Card>
          <Card style={{padding:16,borderTop:'3px solid '+C.a4}}>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>RFH → BCM (95640) SEC16 Import</div>
            <div style={{fontSize:11,color:C.tm,marginBottom:10}}>Write RFHUB SEC16 byte-reversed → 95640 @ 0x838, CRC16 @ 0x848.</div>
            {mods[tt]?.type==='95640'?<div>
              {(()=>{const rfh=mods.find(mn=>mn.type==='RFHUB');if(!rfh)return<div style={{fontSize:11,color:C.wn}}>Also load an RFHUB EEE dump.</div>;
              const s1=rfh.sec16s?.[0];const bs=mods[tt].bcmSec16;
              return<div>
                <div style={{fontSize:11,marginBottom:4}}>RFHUB: <Tag color={rfh.rfhGen?C.a3:C.tm}>{rfh.rfhGen||'?'}</Tag></div>
                <div style={{fontSize:11,marginBottom:4}}>SEC16 Slot 1 <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:s1&&!s1.blank?C.sr:C.tm}}>{s1&&!s1.blank?s1.hex.slice(0,24)+'…':'(blank)'}</span> <Tag color={rfh.sec16valid?C.gn:C.wn}>{rfh.sec16valid?'VALID ✓':'BLANK/MISMATCH'}</Tag></div>
                {bs&&!bs.blank&&<div style={{fontSize:11,marginBottom:4}}>Current @ 0x838 (rev): <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:bs.csOk?C.gn:C.wn}}>{bs.reversedHex.slice(0,24)+'…'}</span> <Tag color={bs.csOk?C.gn:C.wn}>CRC16 {bs.csOk?'✓':'✗'}</Tag></div>}
                {bs&&bs.blank&&<div style={{fontSize:11,marginBottom:4,color:C.wn}}>95640 BCM-SEC16 @ 0x838: BLANK (virgin)</div>}
                <Btn onClick={()=>doTool('rfhBcmSync')} disabled={!rfh.sec16valid} full color={C.a4}>🔑 Import SEC16 → 95640</Btn>
                {!rfh.sec16valid&&<div style={{fontSize:9,color:C.wn,marginTop:4}}>RFHUB SEC16 must be non-blank and both slots matching</div>}
              </div>;})()}
            </div>:<div style={{fontSize:11,color:C.tm}}>Select a 95640 EEPROM as target.</div>}
          </Card>
        </div>

        {tr&&<Card style={{marginTop:16,padding:16,borderLeft:'3px solid '+C.gn}}>
          <div style={{fontSize:13,fontWeight:800,color:C.gn,marginBottom:8}}>Result</div>
          <div style={{fontSize:12,marginBottom:8}}>{tr.desc}</div>
          {tr.keyHex&&<div style={{background:C.c2,padding:12,borderRadius:8,fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:700,color:C.a4,letterSpacing:1,marginBottom:8}}>{tr.keyHex}</div>}
          {tr.data&&<Btn onClick={dlResult} color={C.gn}>↓ Download Modified .bin</Btn>}
        </Card>}

        {flashList.length>0&&<Card style={{marginTop:16,padding:16,borderLeft:'3px solid '+C.a1}}>
          <div style={{fontSize:14,fontWeight:800,color:C.a1,marginBottom:12}}>📋 Files to Flash</div>
          <div style={{fontSize:11,color:C.ts,marginBottom:12}}>All modules have been matched to <b>{tv}</b>. Download each file and write it to the corresponding chip:</div>
          {flashList.map((f,i)=><div key={i} style={{padding:12,borderRadius:10,marginBottom:8,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
            <div>
              <Tag color={TC[f.type]||C.tm}>{f.name}</Tag>
              <span style={{fontSize:11,fontWeight:700,marginLeft:8}}>{f.fn}</span>
              <div style={{fontSize:11,color:C.a1,fontWeight:700,marginTop:4}}>→ {f.note}</div>
            </div>
            <Btn onClick={()=>dl(f.data,f.fn)} color={C.gn} outline>↓ Download</Btn>
          </div>)}
        </Card>}
      </div>}
    </div>}

    {msg&&<div style={{marginTop:12,padding:'8px 12px',borderRadius:8,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    {!mods.length&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Drop BCM, RFHUB, 95640, GPEC2A files above to compare security</div>}

    {/* ─── Mismatch Wizard (guided fix entry point) ─── */}
    {wizardOpen&&(()=>{
      const issues=val?.issues||[];
      const warnings=val?.warnings||[];
      const moduleNames=mods.map(m=>m.type);
      const hexSnippets=[];
      mods.forEach(m=>{
        if(m.vins?.[0])hexSnippets.push(`${m.type} VIN @0x${(m.vins[0].offset||0).toString(16).toUpperCase().padStart(4,'0')}: ${m.vins[0].vin}`);
      });
      const stepActions=[
        {id:'match-all',label:'Match all modules',enabled:mods.length>=1,description:'Sync VIN, secret key and immobilizer token across all loaded modules.'},
      ];
      const handleAction=(actionId)=>{
        if(actionId==='match-all'||actionId==='full-sync'||actionId==='sec16-only'||actionId==='rfh-to-bcm'||actionId==='bcm-sec16-to-rfh'){
          const r=matchAll();
          if(!r)return [{ok:false,error:'No modules loaded — drop module dumps above first.'}];
          if(r.ok)return [{ok:true,note:`Patched ${r.patched} module${r.patched===1?'':'s'} — all checks passed.`}];
          return [{ok:false,error:`Patched ${r.patched} module${r.patched===1?'':'s'}, but ${r.remainingIssues} issue${r.remainingIssues===1?'':'s'} remain. Open Advanced view for details.`}];
        }
        return null;
      };
      return <MismatchWizard
        issues={issues}
        warnings={warnings}
        modules={moduleNames}
        hexSnippets={hexSnippets}
        stepActions={stepActions}
        onClose={()=>setWizardOpen(false)}
        onAction={handleAction}
        sessionKey="security-tab"
      />;
    })()}
  </div>;
}

/* ═══ LIVE OBD TAB ═══ */

export default SecurityTab;
