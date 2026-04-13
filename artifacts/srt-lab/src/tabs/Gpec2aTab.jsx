import React, {useState, useMemo} from "react";
import {C,TC} from "../lib/constants.js";
import {Card,Tag,Btn} from "../lib/ui.jsx";
import {analyzeFile} from "../lib/fileUtils.js";

const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join(" ");

function Gpec2aTab(){
  const[f,setF]=useState(null);const[f2,setF2]=useState(null);const[msg,setMsg]=useState('');
  const load=(e,slot)=>{const fi=e.target.files[0];if(!fi)return;const r=new FileReader();r.onload=ev=>{const d=new Uint8Array(ev.target.result);if(d.length!==4096){setMsg('GPEC2A must be 4096 bytes');return;}const a=analyzeFile(d.buffer,fi.name);if(a.type!=='GPEC2A'){setMsg('Not a GPEC2A file');return;}if(slot===1)setF(a);else setF2(a);setMsg('');};r.readAsArrayBuffer(fi);};
  const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();};

  function toggleSkim(){if(!f)return;const p=new Uint8Array(f.data);p[0x11]=p[0x11]===0x80?0x00:0x80;setF(analyzeFile(p.buffer,f.name));dl(p,'SKIM_'+(p[0x11]===0x80?'ENABLED':'DISABLED')+'_'+f.name);setMsg('SKIM toggled to 0x'+p[0x11].toString(16).toUpperCase());}

  const diff=useMemo(()=>{if(!f||!f2)return[];const r=[];for(let i=0;i<Math.min(f.data.length,f2.data.length);i++)if(f.data[i]!==f2.data[i])r.push({off:i,a:f.data[i],b:f2.data[i]});return r;},[f,f2]);

  return<div>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}} onClick={()=>{}}>
        <div style={{fontSize:28}}>📂</div><div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load GPEC2A File 1</div>
        {f&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f.name}</div>}
        <input type="file" hidden onChange={e=>load(e,1)} accept=".bin,.BIN"/>
      </Card></label>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}} onClick={()=>{}}>
        <div style={{fontSize:28}}>📂</div><div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load File 2 (for diff)</div>
        {f2&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f2.name}</div>}
        <input type="file" hidden onChange={e=>load(e,2)} accept=".bin,.BIN"/>
      </Card></label>
    </div>

    {f&&f.sec?.t==='gpec2a'&&<>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>⚙️ GPEC2A Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:14,borderRadius:12,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>SKIM BYTE @ 0x0011</div>
            <div style={{fontSize:28,fontWeight:900,color:f.sec.on?C.gn:C.wn,fontFamily:"'JetBrains Mono'"}}>{f.sec.on?'ENABLED':'DISABLED'}</div>
            <div style={{fontSize:10,color:C.tm}}>0x{f.sec.skim.toString(16).toUpperCase().padStart(2,'0')}</div>
            <div style={{marginTop:8}}><Btn onClick={toggleSkim} color={f.sec.on?C.wn:C.gn} outline>{f.sec.on?'Disable SKIM':'Enable SKIM'}</Btn></div>
          </div>
          <div style={{padding:14,borderRadius:12,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6}}>ZZZZ TAMPER @ 0x0C8C</div>
            <div style={{fontSize:28,fontWeight:900,color:f.sec.zz?C.gn:C.er}}>{f.sec.zz?'INTACT':'TAMPERED'}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:C.ts,marginTop:4}}>{hxb(f.data.slice(0xC8C,0xC94))}</div>
          </div>
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔑 Secret Key</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Primary @ 0x0203 (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:f.sec.key.every(b=>b===0xFF)?'#D5D0C8':C.a4}}>{hxb(f.sec.key)}</div>
          </div>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Mirror @ 0x0361 (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:f.sec.mir.every(b=>b===0xFF)?'#D5D0C8':C.a4}}>{hxb(f.sec.mir)}</div>
          </div>
        </div>
        <div style={{marginTop:6,fontSize:10}}><Tag color={f.sec.km?C.gn:C.er}>{f.sec.km?'Primary = Mirror ✓':'MISMATCH'}</Tag></div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Transponder Keys @ 0x0888</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {f.sec.tr.map((t,i)=>{const blank=t.every(b=>b===0xFF||b===0);return<div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:700,color:C.tm}}>KEY {i+1}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:4}}>{hxb(t)}</div>
            <Tag color={blank?C.tm:C.gn}>{blank?'—':'SET'}</Tag>
          </div>;})}
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📊 Runtime Counters</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {[{n:'Counter 1',o:0xE61},{n:'Counter 2',o:0xE69},{n:'Counter 3',o:0xE6D},{n:'Counter 4',o:0xE75}].map(c=>{
            const v=(f.data[c.o]<<24|f.data[c.o+1]<<16|f.data[c.o+2]<<8|f.data[c.o+3])>>>0;
            return<div key={c.o} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm}}>{c.n}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a1,marginTop:2}}>{v.toLocaleString()}</div>
              <div style={{fontSize:8,color:C.tm}}>0x{c.o.toString(16).toUpperCase()}</div>
            </div>;})}
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>VINs</div>
        {f.vins.map((v,i)=><div key={i} style={{fontFamily:"'JetBrains Mono'",fontSize:12,marginBottom:4}}>
          <span style={{color:C.tm}}>0x{v.off.toString(16).toUpperCase().padStart(4,'0')}: </span>
          <span style={{fontWeight:800,color:C.a1}}>{v.vin}</span>
        </div>)}
      </Card>
    </>}

    {f&&f2&&<Card style={{padding:16}}>
      <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔀 Hex Diff — {diff.length} byte{diff.length!==1?'s':''} different</div>
      {diff.length===0&&<div style={{fontSize:12,color:C.gn,fontWeight:700}}>✓ Files are identical</div>}
      {diff.length>0&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,borderRadius:8,padding:10,maxHeight:260,overflow:'auto',border:'1px solid '+C.bd}}>
        <div style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4,marginBottom:4}}>
          <span style={{fontWeight:700,color:C.tm}}>Offset</span><span style={{fontWeight:700,color:C.a1}}>File 1</span><span style={{fontWeight:700,color:C.a3}}>File 2</span>
        </div>
        {diff.slice(0,200).map((d,i)=><div key={i} style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4}}>
          <span style={{color:C.tm}}>0x{d.off.toString(16).toUpperCase().padStart(4,'0')}</span>
          <span style={{color:C.a1,fontWeight:700}}>0x{d.a.toString(16).toUpperCase().padStart(2,'0')}</span>
          <span style={{color:C.a3,fontWeight:700}}>0x{d.b.toString(16).toUpperCase().padStart(2,'0')}</span>
        </div>)}
        {diff.length>200&&<div style={{color:C.tm,marginTop:4}}>...and {diff.length-200} more</div>}
      </div>}
    </Card>}

    {msg&&<div style={{marginTop:10,padding:'8px 12px',borderRadius:8,background:C.gn+'10',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    {!f&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Load a GPEC2A 4KB .bin file above</div>}
  </div>;
}

export default Gpec2aTab;
