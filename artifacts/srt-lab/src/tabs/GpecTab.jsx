import React, {useState, useCallback} from "react";
import {C} from "../lib/constants.js";
import {Card,Btn} from "../lib/ui.jsx";
import {ASSET_IDS} from "../lib/downloadAssets.js";
import {useDownloadCount, DownloadCounter} from "../lib/useDownloadCount.jsx";

function GpecTab(){
  const[fw,setFw]=useState(null);const[res,setRes]=useState(null);
  const[,trackUnlocked]=useDownloadCount(ASSET_IDS.gpecUnlockedFw);
  const load=useCallback(e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();r.onload=ev=>{const d=new Uint8Array(ev.target.result);setFw({name:f.name,data:d,size:d.length});setRes(null);};r.readAsArrayBuffer(f);
  },[]);
  const unlock=useCallback(()=>{
    if(!fw)return;const d=new Uint8Array(fw.data);
    if(d.length<=0x2FFFC){setRes({ok:false,msg:'File too small — need at least 192KB'});return;}
    const cur=d[0x2FFFC];
    if(cur===0x96){setRes({ok:false,msg:'Already unlocked (0x2FFFC = 0x96)'});return;}
    d[0x2FFFC]=0x96;setRes({ok:true,msg:'Unlock flag set: 0x2FFFC changed from 0x'+cur.toString(16).toUpperCase()+' → 0x96',data:d});
  },[fw]);
  const dl=useCallback(()=>{
    if(!res?.data)return;const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([res.data]));a.download='UNLOCKED_'+fw.name;a.click();
    trackUnlocked();
  },[res,fw,trackUnlocked]);

  return<div style={{maxWidth:640}}>
    <Card glow>
      <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>🔓 GPEC Firmware Unlock</div>
      <div style={{fontSize:12,color:C.ts,marginBottom:20}}>Sets byte at offset 0x2FFFC to 0x96 — cracked from .NET IL disassembly</div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <label style={{cursor:'pointer'}}>
          <div style={{padding:24,borderRadius:14,background:C.c2,border:'2px dashed '+C.bd,textAlign:'center',transition:'all 0.2s'}}>
            <div style={{fontSize:32}}>📂</div>
            <div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:6}}>Load Firmware</div>
            {fw&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a3,marginTop:6}}>{fw.name} ({(fw.size/1024).toFixed(0)}KB)</div>}
          </div>
          <input type="file" hidden onChange={load} accept=".bin,.BIN"/>
        </label>
        <div onClick={fw?unlock:undefined} style={{padding:24,borderRadius:14,background:fw?C.sr+'08':C.c2,border:'2px solid '+(fw?C.sr+'30':C.bd),textAlign:'center',cursor:fw?'pointer':'default',opacity:fw?1:0.4,transition:'all 0.2s'}}>
          <div style={{fontSize:32}}>🔓</div>
          <div style={{fontSize:12,fontWeight:800,color:C.sr,marginTop:6}}>Unlock</div>
        </div>
      </div>

      {fw&&<div style={{marginTop:14,padding:'10px 14px',borderRadius:10,background:C.c2,border:'1px solid '+C.bd}}>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>
          <span style={{color:C.tm}}>0x2FFFC = </span>
          <span style={{fontWeight:800,color:fw.data.length>0x2FFFC?(fw.data[0x2FFFC]===0x96?C.gn:C.a1):C.er}}>
            {fw.data.length>0x2FFFC?'0x'+fw.data[0x2FFFC].toString(16).toUpperCase():'N/A'}
          </span>
          {fw.data.length>0x2FFFC&&fw.data[0x2FFFC]===0x96&&<span style={{color:C.gn,marginLeft:8}}>✓ Already unlocked</span>}
        </div>
      </div>}

      {res&&<div style={{marginTop:14,padding:16,borderRadius:12,background:res.ok?C.gn+'10':C.wn+'10',border:'1px solid '+(res.ok?C.gn:C.wn)+'30'}}>
        <div style={{fontSize:13,fontWeight:800,color:res.ok?C.gn:C.wn}}>{res.ok?'✓ ':'⚠ '}{res.msg}</div>
        {res.ok&&<div style={{marginTop:10,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}><Btn onClick={dl} color={C.gn}>💾 Download Unlocked Firmware</Btn><DownloadCounter assetId={ASSET_IDS.gpecUnlockedFw}/></div>}
      </div>}
    </Card>
  </div>;
}


export default GpecTab;
