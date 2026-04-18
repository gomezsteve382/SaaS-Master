import React, {useState, useMemo} from "react";
import {C,TC,TL} from "../lib/constants.js";
import {Card,Tag,Btn,SLine} from "../lib/ui.jsx";
import {analyzeFile,patchFile,virginizeFile} from "../lib/fileUtils.js";
import {syncImmoBackup} from "../lib/parseModule.js";
import {TR,WT,WMI,YR,IMMO_BLOCK} from "../lib/constants.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {DownloadCounter} from "../lib/useDownloadCount.jsx";
import DesktopDriverCard from "../components/DesktopDriverCard.jsx";

const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join(" ");
function checkVin(v){if(!v||v.length!==17)return{ok:false};const u=v.toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(u))return{ok:false,err:"Invalid chars"};let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];const cd="0123456789X"[sum%11];return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||"",yr:YR[u[9]]||"",err:u[8]!==cd?"Check digit: need "+cd:""};}

function DumpsTab({files,setFiles,loadF}){
  const[sel,setSel]=useState(null);const[nv,setNv]=useState('');const[msg,setMsg]=useState('');
  const f=sel!==null?files[sel]:null;const cv=useMemo(()=>nv.length===17?checkVin(nv):null,[nv]);
  const dl=(d,n,assetId)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();if(assetId)trackDownload(assetId);};
  const doPatch=()=>{if(!f||nv.length!==17)return;const r=patchFile(f,nv);dl(r.data,'PATCHED_'+nv+'_'+f.name,ASSET_IDS.dumpsPatchedVin);const u=[...files];u[sel]=analyzeFile(r.data.buffer,f.name);setFiles(u);setMsg('Patched '+r.log.length+' locations');};
  const doVirgin=()=>{if(!f)return;const r=virginizeFile(f);dl(r.data,'VIRGIN_'+f.name,ASSET_IDS.dumpsVirgin);setMsg('Virginized: '+r.log.join(', '));};

  if(!files.length)return<div style={{display:'flex',flexDirection:'column',gap:18}}>
    <div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadF(e.target.files);i.click();}} onDrop={e=>{e.preventDefault();loadF(e.dataTransfer.files);}} onDragOver={e=>e.preventDefault()}>
      <Card style={{textAlign:'center',padding:'60px 24px',cursor:'pointer',border:'2.5px dashed #D32F2F30'}} onClick={()=>{}}>
        <div style={{fontSize:52,marginBottom:10}}>📂</div>
        <div style={{fontSize:20,fontWeight:900,color:C.sr}}>Drop EEPROM or Firmware Files</div>
        <div style={{fontSize:13,color:C.ts,marginTop:6}}>Auto-detects BCM · 95640 · RFHUB EEE · GPEC2A · TCM · TIPM</div>
        <div style={{display:'flex',gap:8,justifyContent:'center',marginTop:18,flexWrap:'wrap'}}>
          {[['BCM D-FLASH',C.a1],['95640',C.a4],['RFHUB EEE',C.a3],['GPEC2A',C.a2],['TCM EEPROM',TC.TCM],['TIPM EEPROM',TC.TIPM]].map(([l,c])=><Tag key={l} color={c}>{l}</Tag>)}
        </div>
      </Card>
    </div>
    <DesktopDriverCard/>
  </div>;

  return<div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:18,alignItems:'start'}}>
    <div>
      <Btn onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadF(e.target.files);i.click();}} full>+ Add Files</Btn>
      <div style={{marginTop:10,display:'flex',flexDirection:'column',gap:7}}>
        {files.map((fi,i)=><Card key={i} onClick={()=>{setSel(i);setMsg('');}} style={{padding:13,borderColor:sel===i?C.sr:fi.hexOnly?'#61616140':C.bd}}>
          <div style={{fontSize:12,fontWeight:800,color:sel===i?C.sr:C.tx,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fi.name}</div>
          <div style={{display:'flex',gap:4,marginTop:5,alignItems:'center',flexWrap:'wrap'}}>
            {fi.hexOnly?<Tag color={TC.UNKNOWN}>Unrecognized — hex view only</Tag>:<Tag color={TC[fi.type]||C.tm}>{TL[fi.type]||fi.type}</Tag>}
            <span style={{fontSize:10,color:C.tm}}>{(fi.size/1024).toFixed(1)}KB</span>
            {!fi.hexOnly&&<span style={{fontSize:10,color:C.tm}}>{fi.vins.length}V{fi.partials?.length>0?'+'+fi.partials.length+'p':''}</span>}
          </div>
          {fi.vins[0]&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a1,fontWeight:700,marginTop:5}}>{fi.vins[0].vin}</div>}
        </Card>)}
      </div>
      {files.length>=2&&<Card style={{marginTop:10,padding:12}}><div style={{fontSize:10,fontWeight:800,color:C.a1,marginBottom:4,letterSpacing:1}}>CROSS-MATCH</div>
        {(()=>{const vs={};files.forEach(fi=>fi.vins.forEach(v=>{vs[v.vin]=(vs[v.vin]||0)+1;}));return Object.entries(vs).map(([vin,ct])=><div key={vin} style={{fontSize:10,fontFamily:"'JetBrains Mono'"}}><span style={{color:ct===files.length?C.gn:C.wn}}>{vin}</span><span style={{color:C.tm,marginLeft:4}}>{ct}/{files.length}{ct===files.length?' ✓':''}</span></div>);})()}
      </Card>}
      <div style={{marginTop:10}}><DesktopDriverCard/></div>
    </div>
    {f&&<div>
      {f.hexOnly
        ?<Card style={{marginBottom:14,padding:16,border:'2px solid '+TC.UNKNOWN+'60',background:TC.UNKNOWN+'08'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
            <Tag color={TC.UNKNOWN}>Unrecognized module — read only</Tag>
            <span style={{fontSize:11,color:C.tm}}>{(f.size/1024).toFixed(1)} KB · {f.size} bytes</span>
          </div>
          <div style={{fontSize:12,color:C.ts,marginBottom:10}}>This file does not match any known module type. You can inspect the raw bytes below and download the file, but patching is not available.</div>
          <Btn onClick={()=>dl(f.data,f.name,ASSET_IDS.dumpsRaw)} color={C.a3} outline>💾 Download Raw</Btn>
          <div style={{marginTop:6}}><DownloadCounter assetId={ASSET_IDS.dumpsRaw}/></div>
        </Card>
        :<Card glow style={{marginBottom:14}}>
          <div style={{fontSize:16,fontWeight:900,marginBottom:14}}>⚡ PATCH VIN</div>
          <input value={nv} maxLength={17} placeholder="Enter new 17-character VIN" onChange={e=>setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,''))} style={{width:'100%',padding:'12px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:700,letterSpacing:3,textAlign:'center',outline:'none',boxSizing:'border-box'}} onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}/>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8,flexWrap:'wrap',gap:4}}>
            <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:nv.length===17?C.gn:C.tm}}>{nv.length}/17</span>
            {cv&&<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
              {cv.ok?<Tag color={C.gn}>✓ Valid</Tag>:<Tag color={C.er}>{cv.err||'Invalid'}</Tag>}
              {cv.mfr&&<Tag color={C.a3}>{cv.mfr}</Tag>}
              {cv.yr&&<Tag color={C.a2}>{cv.yr}</Tag>}
            </div>}
          </div>
          <div style={{display:'flex',gap:8,marginTop:14,flexWrap:'wrap'}}>
            <Btn onClick={doPatch} disabled={nv.length!==17} full>⚡ Patch VIN + Download</Btn>
          </div>
          <div style={{display:'flex',gap:8,marginTop:8}}>
            <Btn onClick={doVirgin} color={C.er} outline>💀 Virginize</Btn>
            <Btn onClick={()=>dl(f.data,f.name,ASSET_IDS.dumpsRaw)} color={C.a3} outline>💾 Download</Btn>
          </div>
          <div style={{display:'flex',gap:14,marginTop:8,flexWrap:'wrap'}}>
            <DownloadCounter assetId={ASSET_IDS.dumpsPatchedVin}/>
            <DownloadCounter assetId={ASSET_IDS.dumpsVirgin}/>
            <DownloadCounter assetId={ASSET_IDS.dumpsRaw}/>
          </div>
          {msg&&<div style={{marginTop:10,padding:'9px 12px',borderRadius:10,background:C.gn+'10',border:'1px solid '+C.gn+'25',fontSize:11,color:C.gn,fontWeight:700}}>✓ {msg}</div>}
        </Card>}
      {!f.hexOnly&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>VIN Locations ({f.vins.length} full{f.partials?.length>0?', '+f.partials.length+' partial':''})</div>
        {f.vins.map((v,i)=><div key={i} style={{padding:'8px 10px',borderRadius:8,marginBottom:4,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:4}}>
          <div><span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>0x{v.off.toString(16).toUpperCase()} </span><span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.a1}}>{v.vin}</span>{v.mirrored&&<Tag color={C.a3}>MIRRORED</Tag>}</div>
          <div>{v.algo==='c16'&&<Tag color={C.gn}>CRC16 ✓</Tag>}{v.algo==='c8'&&<Tag color={v.ok?C.gn:C.wn}>CRC8 {v.ok?'✓':'!'}</Tag>}{v.algo==='none'&&<Tag color={C.a2}>No CRC</Tag>}</div>
        </div>)}
        {f.partials?.map((v,i)=><div key={'p'+i} style={{padding:'6px 10px',borderRadius:8,marginBottom:4,background:'#FFF8E1',border:'1px solid #FFE082',fontSize:11}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>0x{v.off.toString(16).toUpperCase()} </span><span style={{fontFamily:"'JetBrains Mono'",fontWeight:700,color:C.a1}}>…{v.vin}</span><Tag color={C.wn}>PARTIAL</Tag>
        </div>)}
      </Card>}
      {!f.hexOnly&&f.sec&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Security</div>
        {f.sec.t==='bcm'&&<><div style={{fontSize:11,marginBottom:6}}>Immo @0x40C0: <Tag color={f.sec.b1?C.wn:C.gn}>{f.sec.b1?'BLANK':f.sec.immoRecs+' SKIM keys'}</Tag></div><div style={{fontSize:11,marginBottom:6}}>Backup @0x2000: <Tag color={f.sec.b2?C.tm:C.gn}>{f.sec.b2?'BLANK':f.sec.bakRecs+' keys'}</Tag>{!f.sec.b2&&!f.sec.b1&&<Tag color={f.sec.immoSynced?C.gn:C.wn}>{f.sec.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>}</div>{!f.sec.b1&&(f.sec.b2||!f.sec.immoSynced)&&<div style={{marginTop:6,display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}><Btn onClick={()=>{const d=syncImmoBackup(f.data);if(!d){setMsg('BCM file too small for IMMO sync');return;}dl(d,'IMMO_SYNCED_'+f.name,ASSET_IDS.dumpsImmoSync);const u=[...files];u[sel]=analyzeFile(d.buffer,f.name);setFiles(u);setMsg('IMMO backup synced: '+f.sec.immoRecs+' keys copied to 0x2000');}} color={C.a1} outline>🔄 Sync IMMO Backup</Btn><DownloadCounter assetId={ASSET_IDS.dumpsImmoSync}/></div>}</>}
        {f.sec.t==='95640'&&<><div style={{fontSize:11,marginBottom:4}}>Secret Key @0x40: <Tag color={f.sec.kb?C.wn:C.gn}>{f.sec.kb?'ERASED':'SET'}</Tag></div>{!f.sec.kb&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4,marginBottom:4}}>{hxb(f.sec.key)}</div>}<div style={{fontSize:11}}>Fob Data: <Tag color={f.sec.fb?C.tm:C.gn}>{f.sec.fb?'NONE':'HAS FOBS'}</Tag></div></>}
        {f.sec.t==='rfhub'&&<><div style={{fontSize:11,marginBottom:4}}>Secret Key @0x40: <Tag color={f.sec.kb?C.wn:C.gn}>{f.sec.kb?'ERASED':'SET'}</Tag></div>{!f.sec.kb&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4}}>{hxb(f.sec.key)}</div>}</>}
        {f.sec.t==='gpec2a'&&<><div style={{fontSize:11,marginBottom:4}}>SKIM: <Tag color={f.sec.on?C.gn:C.wn}>{f.sec.on?'ENABLED 0x80':'OFF 0x'+f.sec.skim.toString(16).toUpperCase()}</Tag></div><div style={{fontSize:11,marginBottom:4}}>Secret Key: {!f.sec.key.every(b=>b===0xFF)?<><span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a4}}>{hxb(f.sec.key)}</span><Tag color={f.sec.km?C.gn:C.er}>{f.sec.km?'Mirror ✓':'MISMATCH'}</Tag></>:<Tag color={C.wn}>BLANK</Tag>}</div><div style={{fontSize:11}}>ZZZZ Tamper: <Tag color={f.sec.zz?C.gn:C.er}>{f.sec.zz?'INTACT':'TAMPERED'}</Tag></div></>}
      </Card>}
      <Card style={{padding:14}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>Hex Viewer{f.hexOnly&&<span style={{marginLeft:8,fontSize:10,fontWeight:400,color:C.tm}}>({Math.ceil(f.size/16)} rows · {f.size} bytes)</span>}</div>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,borderRadius:10,padding:10,maxHeight:f.hexOnly?520:320,overflow:'auto',border:'1px solid '+C.bd}}>
          {Array.from({length:f.hexOnly?Math.ceil(f.size/16):Math.min(32,Math.ceil(f.size/16))},(_,row)=>{const a=row*16;const bs=f.data.slice(a,Math.min(a+16,f.size));const iv=!f.hexOnly&&f.vins.some(v=>a+16>v.off&&a<v.off+17);return<div key={row} style={{display:'flex',gap:8,padding:'1px 4px',background:iv?'#D32F2F06':'transparent',borderRadius:3}}>
            <span style={{color:C.tm,minWidth:48,fontWeight:600}}>{a.toString(16).toUpperCase().padStart(6,'0')}</span>
            <span style={{flex:1}}>{Array.from(bs).map((b,j)=>{const isV=!f.hexOnly&&f.vins.some(v=>(a+j)>=v.off&&(a+j)<v.off+17);return<span key={j} style={{color:isV?C.sr:b===0xFF?'#D5D0C8':b===0?'#C8C3BB':C.ts,fontWeight:isV?800:400}}>{b.toString(16).toUpperCase().padStart(2,'0')} </span>;})}</span>
            <span style={{color:C.tm,minWidth:90,fontSize:9}}>{Array.from(bs).map(b=>b>=32&&b<=126?String.fromCharCode(b):'·').join('')}</span>
          </div>;})}
        </div>
      </Card>
    </div>}
  </div>;
}


export default DumpsTab;
