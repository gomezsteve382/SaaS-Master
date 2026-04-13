import React, { useState, useCallback } from "react";
import { C } from "./lib/constants.js";
import { analyzeFile } from "./lib/fileUtils.js";
import DumpsTab from "./tabs/DumpsTab.jsx";
import OBDTab from "./tabs/OBDTab.jsx";
import BenchTab from "./tabs/BenchTab.jsx";
import SeedTab from "./tabs/SeedTab.jsx";
import GpecTab from "./tabs/GpecTab.jsx";
import SecurityTab from "./tabs/SecurityTab.jsx";
import Gpec2aTab from "./tabs/Gpec2aTab.jsx";
import FcaAnalyzerTab from "./tabs/FcaAnalyzerTab.jsx";
import OBDSwarmDiagnostic from "./OBDSwarmDiagnostic";
import J2534Scanner from "./J2534Scanner";

const TABS=[{id:'dumps',i:'📂',l:'DUMPS',s:'VIN · Hex · Virginize'},{id:'obd',i:'📡',l:'LIVE OBD',s:'UDS · Scan · Write'},{id:'bench',i:'🔧',l:'BENCH',s:'Offline · Dumps'},{id:'seed',i:'🔑',l:'SEED→KEY',s:'14 Algorithms'},{id:'gpec',i:'🔓',l:'GPEC',s:'FW Unlock'},{id:'skim',i:'🛡️',l:'SECURITY',s:'Cross-Match'},{id:'gpec2a',i:'⚙️',l:'GPEC2A',s:'SKIM · Tamper'},{id:'analyzer',i:'🔬',l:'ANALYZER',s:'GPEC · RFHUB · BCM'},{id:'swarm',i:'🐝',l:'SWARM',s:'5-Agent CAN Scan'},{id:'j2534',i:'⚡',l:'J2534',s:'Raw CAN PassThru'}];

export default function App(){const[pg,setPg]=useState('dumps');const[files,setFiles]=useState([]);
  const loadF=useCallback(fl=>{Promise.all(Array.from(fl).map(f=>new Promise(r=>{const rd=new FileReader();rd.onload=e=>r(analyzeFile(e.target.result,f.name));rd.readAsArrayBuffer(f);}))).then(res=>setFiles(p=>[...p,...res]));},[]);
  return<div style={{minHeight:'100vh',background:C.bg,color:C.tx,fontFamily:"'Nunito',sans-serif"}}>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&family=Righteous&display=swap" rel="stylesheet"/>
    <div style={{background:'linear-gradient(135deg,#1A1A1A 0%,#2D2D2D 40%,#D32F2F 100%)',position:'relative',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 80% 50%,rgba(255,82,82,0.3),transparent 60%)',pointerEvents:'none'}}/>
      <div style={{position:'relative',padding:'22px 28px 0',display:'flex',alignItems:'center',gap:14}}>
        <div style={{width:46,height:46,borderRadius:13,background:'linear-gradient(135deg,#FF5252,#D32F2F)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 20px rgba(211,47,47,0.4)'}}><span style={{fontFamily:"'Righteous'",fontSize:22,color:'#fff'}}>S</span></div>
        <div><div style={{fontFamily:"'Righteous'",fontSize:26,color:'#fff',letterSpacing:2}}>SRT LAB</div><div style={{fontSize:9,color:'rgba(255,255,255,0.4)',fontWeight:700,letterSpacing:6}}>JAILBREAK EDITION</div></div>
      </div>
      <div style={{display:'flex',padding:'12px 16px 0',overflowX:'auto',gap:2}}>
        {TABS.map(t=>{const a=pg===t.id;return<button key={t.id} onClick={()=>setPg(t.id)} style={{padding:'11px 16px 13px',border:'none',cursor:'pointer',background:a?C.bg:'transparent',borderRadius:'11px 11px 0 0',color:a?C.sr:'rgba(255,255,255,0.4)',fontFamily:"'Nunito'",fontWeight:a?900:700,fontSize:11,letterSpacing:1.2,transition:'all 0.25s',boxShadow:a?'0 -4px 16px rgba(0,0,0,0.06)':'none',whiteSpace:'nowrap'}}><span style={{fontSize:14,marginRight:4,filter:a?'none':'grayscale(1) brightness(2)'}}>{t.i}</span>{t.l}<div style={{fontSize:7,marginTop:1,opacity:.4}}>{t.s}</div></button>;})}
      </div>
    </div>
    <div style={{maxWidth:1100,margin:'0 auto',padding:'22px 22px 60px'}}>
      {pg==='dumps'&&<DumpsTab files={files} setFiles={setFiles} loadF={loadF}/>}
      {pg==='obd'&&<OBDTab/>}
      {pg==='bench'&&<BenchTab/>}
      {pg==='seed'&&<SeedTab/>}
      {pg==='gpec'&&<GpecTab/>}
      {pg==='skim'&&<SecurityTab/>}
      {pg==='gpec2a'&&<Gpec2aTab/>}
      {pg==='analyzer'&&<FcaAnalyzerTab/>}
      {pg==='swarm'&&<OBDSwarmDiagnostic/>}
      {pg==='j2534'&&<J2534Scanner/>}
    </div></div>;}
