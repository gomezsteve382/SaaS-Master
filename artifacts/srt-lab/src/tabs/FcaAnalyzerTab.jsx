import React, {useState, useCallback, useMemo, useContext} from "react";
import {Card,Tag,Btn,SLine} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {parseModule,syncImmoBackup} from "../lib/parseModule.js";
import {decodeBcmConfig,decodeTipmCgwConfig,groupByRequest} from "../lib/cgwConfig.js";
import {crossValidate} from "../lib/crossValidate.js";
import {checkVin,parseVinYear,vinHasSGW} from "../lib/vin.js";
import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import {MasterVinContext} from "../lib/masterVinContext.jsx";

const downloadBin=(data,name)=>{
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([data],{type:'application/octet-stream'}));
  a.download=name;a.click();URL.revokeObjectURL(a.href);
};

/* Cross-module audit badge — labels any config block the analyzer
 * spots in the loaded BCM/TIPM dump using the AlfaOBD BodyPN /
 * TIPM_CGW catalog (Task #144). Read-only; same caveat as the BCM
 * tab — flash dumps don't line up 1:1 with UDS bit offsets, so the
 * panel marks values as best-effort. */
function ConfigBlockBadge({mod}){
  const decoded=mod.type==='TIPM'?decodeTipmCgwConfig(mod.data.slice(0,128)):decodeBcmConfig(mod.data.slice(0x4090,0x4090+128));
  const grouped=groupByRequest(decoded);
  /* Only show requests where at least one row decoded to a known label
     (i.e. raw landed inside the option list) — keeps the badge tight. */
  const hits=Array.from(grouped.entries()).filter(([,rows])=>rows.some(r=>r.raw!==null&&!r.label.startsWith('(unknown')));
  if(hits.length===0)return null;
  return <Card style={{marginBottom:14,padding:14,background:'#F0F8FF'}}>
    <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:8,letterSpacing:1.5}}>🎛️ {mod.type} CONFIG BLOCKS ({mod.type==='BCM'?'BodyPN':'TIPM_CGW'})</div>
    <div style={{fontSize:10,color:C.tm,marginBottom:8,fontStyle:'italic'}}>Best-effort decode of dump bytes against AlfaOBD catalog — see BCM tab for details.</div>
    {hits.slice(0,5).map(([req,rows])=>{
      const known=rows.filter(r=>r.raw!==null&&!r.label.startsWith('(unknown')).slice(0,4);
      return <div key={req} style={{padding:'6px 0',borderBottom:'1px dotted '+C.bd}}>
        <span style={{fontFamily:"'JetBrains Mono'",fontWeight:800,color:C.a3,marginRight:10}}>0x{req}</span>
        {known.map((r,i)=><span key={i} style={{marginRight:14,fontSize:11}}>
          <span style={{color:C.ts}}>{r.setting}:</span> <b style={{color:C.gn}}>{r.label}</b>
        </span>)}
      </div>;
    })}
  </Card>;
}

/* FCA Analyzer — cross-module audit
   Drop one or more dump files (BCM / RFHUB / GPEC2A / 95640) and the tab
   parses each via parseModule, runs crossValidate, and surfaces every
   byte-level field the parser exposes. Read-only beyond the IMMO-sync action. */
export default function FcaAnalyzerTab(){
  const {vin:masterVin,setVin,loadedDumps,addDump,replaceDump,removeDump,clearDumps}=useContext(MasterVinContext);
  const mods=useMemo(()=>loadedDumps.map(d=>d.mod),[loadedDumps]);
  const [sel,setSel]=useState(0);
  const [msg,setMsg]=useState('');

  const loadFiles=useCallback(fl=>{
    Promise.all(Array.from(fl).map(f=>new Promise(r=>{
      const rd=new FileReader();
      rd.onload=ev=>r(parseModule(new Uint8Array(ev.target.result),f.name));
      rd.readAsArrayBuffer(f);
    }))).then(parsed=>{
      parsed.forEach(p=>addDump(p));
      setSel(0);
      const firstVin=parsed.find(p=>p.vins?.[0]?.vin)?.vins?.[0]?.vin;
      if(firstVin&&!masterVin)setVin(firstVin);
    });
  },[masterVin,setVin,addDump]);

  const cv=useMemo(()=>mods.length?crossValidate(mods):null,[mods]);
  const cur=mods[sel];

  const allVins=useMemo(()=>{
    const out=new Map();
    mods.forEach(m=>m.vins?.forEach(v=>{
      if(!v.vin)return;
      const arr=out.get(v.vin)||[];
      arr.push({mod:m.type,off:v.offset});
      out.set(v.vin,arr);
    }));
    return out;
  },[mods]);

  const onSyncImmo=useCallback(()=>{
    if(!cur||cur.type!=='BCM')return;
    if(cur.immoBlank){setMsg('IMMO primary is blank — nothing to sync.');return;}
    if(!window.confirm('Copy IMMO primary @0x40C0 → backup @0x2000? A patched .bin will be downloaded; the original file is not modified.'))return;
    const synced=syncImmoBackup(cur.data);
    if(!synced){setMsg('BCM file too small for IMMO sync.');return;}
    downloadBin(synced,'IMMO_SYNCED_'+cur.filename);
    const reparsed=parseModule(synced,cur.filename);
    const oldHash=loadedDumps[sel]?.hash;
    if(oldHash)replaceDump(oldHash,reparsed);
    setMsg('IMMO backup synced: '+cur.immoRecs+' keys copied → 0x2000. Snapshot downloaded.');
  },[cur,sel,loadedDumps,replaceDump]);

  const masterCheck=useMemo(()=>masterVin.length===17?checkVin(masterVin):null,[masterVin]);
  const masterYear=useMemo(()=>parseVinYear(masterVin),[masterVin]);
  const masterSgw=useMemo(()=>vinHasSGW(masterVin),[masterVin]);

  return <div>
    <Card style={{background:'linear-gradient(135deg,#1B2530 0%,#2D4055 50%,#3F6080 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>🧪</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>FCA ANALYZER</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>CROSS-MODULE AUDIT · BCM ↔ RFHUB ↔ GPEC2A ↔ 95640</div>
        </div>
        <div style={{fontSize:11,padding:'6px 12px',background:'rgba(255,255,255,0.12)',borderRadius:8,border:'1px solid rgba(255,255,255,0.2)'}}>{mods.length} module{mods.length===1?'':'s'} loaded</div>
      </div>
    </Card>

    <Card glow style={{marginBottom:14}}>
      <div onClick={()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='.bin,.BIN';i.onchange=e=>loadFiles(e.target.files);i.click();}}
           onDrop={e=>{e.preventDefault();loadFiles(e.dataTransfer.files);}}
           onDragOver={e=>e.preventDefault()}
           style={{textAlign:'center',padding:'30px 18px',cursor:'pointer',border:'2.5px dashed '+C.sr+'40',borderRadius:14,background:C.c2}}>
        <div style={{fontSize:38,marginBottom:6}}>📂</div>
        <div style={{fontSize:14,fontWeight:900,color:C.sr}}>Drop or browse one or more module dumps</div>
        <div style={{fontSize:11,color:C.ts,marginTop:4}}>Auto-detects BCM (64/128 KB) · RFHUB (4 KB) · GPEC2A (4 KB) · 95640 (8/16 KB)</div>
      </div>
      {mods.length>0&&<div style={{marginTop:12,display:'flex',gap:8,flexWrap:'wrap'}}>
        {loadedDumps.map((d,i)=><button key={d.hash} onClick={()=>setSel(i)} style={{padding:'8px 12px',borderRadius:10,border:'1.5px solid '+(sel===i?C.sr:C.bd),background:sel===i?C.sr+'10':C.cd,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
          <Tag color={d.mod.color}>{d.mod.name}</Tag>
          <span style={{fontSize:10,fontFamily:"'JetBrains Mono'",color:C.ts}}>{d.filename}</span>
          <span onClick={e=>{e.stopPropagation();removeDump(d.hash);setSel(0);}} style={{color:C.tm,fontSize:13,marginLeft:4}}>✕</span>
        </button>)}
        <Btn onClick={()=>{clearDumps();setMsg('');}} color={C.tm} outline>Clear all</Btn>
      </div>}
    </Card>

    {masterVin.length===17&&<Card style={{marginBottom:14,padding:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:8,letterSpacing:1.5}}>🛣️ MASTER VIN HELPERS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,fontSize:12}}>
        <div style={{padding:10,background:C.c2,borderRadius:8,border:'1px solid '+C.bd}}>
          <div style={{fontSize:10,color:C.tm,fontWeight:700}}>VIN check digit</div>
          <div style={{marginTop:4}}><Tag color={masterCheck?.ok?C.gn:C.er}>{masterCheck?.ok?'VALID':'INVALID'}</Tag>{masterCheck?.cd&&<span style={{marginLeft:6,fontFamily:"'JetBrains Mono'"}}>need {masterCheck.cd}</span>}</div>
          {masterCheck?.mfr&&<div style={{fontSize:10,color:C.ts,marginTop:4}}>{masterCheck.mfr}</div>}
        </div>
        <div style={{padding:10,background:C.c2,borderRadius:8,border:'1px solid '+C.bd}}>
          <div style={{fontSize:10,color:C.tm,fontWeight:700}}>Model year</div>
          <div style={{marginTop:4,fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,color:C.a3}}>{masterYear||'?'}</div>
          <div style={{fontSize:10,color:C.ts}}>code <b>{masterVin[9]}</b></div>
        </div>
        <div style={{padding:10,background:C.c2,borderRadius:8,border:'1px solid '+C.bd}}>
          <div style={{fontSize:10,color:C.tm,fontWeight:700}}>SGW expected?</div>
          <div style={{marginTop:4}}><Tag color={masterSgw?C.wn:C.gn}>{masterSgw?'YES — bypass needed':'NO'}</Tag></div>
          <div style={{fontSize:10,color:C.ts,marginTop:4}}>FCA gateway started MY2018</div>
        </div>
      </div>
    </Card>}

    {cv&&<Card style={{marginBottom:14,padding:16}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:10,letterSpacing:1.5}}>📋 CROSS-MODULE AUDIT</div>
      {cv.issues.map((m,i)=><SLine key={'i'+i} type="error" msg={m}/>)}
      {cv.warnings.map((m,i)=><SLine key={'w'+i} type="warn" msg={m}/>)}
      {cv.passed.map((m,i)=><SLine key={'p'+i} type="pass" msg={m}/>)}
      {cv.issues.length===0&&cv.warnings.length===0&&cv.passed.length===0&&<div style={{fontSize:11,color:C.tm}}>No cross-module checks for this combination yet.</div>}
    </Card>}

    {allVins.size>0&&<Card style={{marginBottom:14,padding:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.sr,marginBottom:8,letterSpacing:1.5}}>🪪 VIN OCCURRENCES ACROSS DUMPS</div>
      {Array.from(allVins.entries()).map(([vin,locs])=><div key={vin} style={{padding:'6px 0',borderBottom:'1px dashed '+C.bd}}>
        <div style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.a1}}>{vin}</div>
        <div style={{fontSize:10,color:C.ts,marginTop:2}}>{locs.map((l,i)=><span key={i} style={{marginRight:10}}>{l.mod}@0x{l.off.toString(16).toUpperCase().padStart(4,'0')}</span>)}</div>
      </div>)}
    </Card>}

    {cur&&<Card style={{marginBottom:14,padding:14}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
        <div style={{fontWeight:800,fontSize:13}}>{cur.name}</div>
        <Tag color={cur.color}>{cur.type}</Tag>
        <span style={{fontSize:10,color:C.tm}}>{cur.filename} · {(cur.size/1024).toFixed(1)} KB</span>
      </div>
      <ModuleFieldsPanel mod={cur} onSyncImmo={onSyncImmo}/>
    </Card>}

    {cur&&(cur.type==='BCM'||cur.type==='TIPM')&&<ConfigBlockBadge mod={cur}/>}

    {msg&&<div style={{padding:'10px 14px',borderRadius:10,background:C.gn+'14',border:'1px solid '+C.gn+'33',fontSize:12,fontWeight:700,color:C.gn,marginTop:12}}>✓ {msg}</div>}
    {mods.length===0&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Load one or more module dumps to begin the audit.</div>}
  </div>;
}
