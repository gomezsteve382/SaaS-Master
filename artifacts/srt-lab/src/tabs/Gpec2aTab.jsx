import React, {useState, useMemo, useCallback, useContext} from "react";
import {C} from "../lib/constants.js";
import {Card,Tag,Btn} from "../lib/ui.jsx";
import {parseModule} from "../lib/parseModule.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";

const dl=(d,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([d]));a.download=n;a.click();URL.revokeObjectURL(a.href);};
const hxb=d=>Array.from(d).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
const offHex=o=>'0x'+o.toString(16).toUpperCase().padStart(4,'0');
const isBlank=arr=>!arr||arr.every(b=>b===0xFF||b===0x00);

function Gpec2aTab(){
  const {getDumpsByType,addDump,replaceDump}=useContext(MasterVinContext);
  const gpecDumps=getDumpsByType('GPEC2A');
  const [hash1,setHash1]=useState(null);
  const [hash2,setHash2]=useState(null);
  const [msg,setMsg]=useState('');
  const entry1=gpecDumps.find(d=>d.hash===hash1)||gpecDumps[0]||null;
  const entry2=gpecDumps.find(d=>d.hash===hash2&&d.hash!==entry1?.hash)||gpecDumps.find(d=>d.hash!==entry1?.hash)||null;
  const f=entry1?.mod||null;
  const f2=entry2?.mod||null;

  const load=useCallback((e,slot)=>{
    const fi=e.target.files[0];if(!fi)return;
    const r=new FileReader();
    r.onload=ev=>{
      const d=new Uint8Array(ev.target.result);
      if(d.length!==4096){setMsg('GPEC2A must be 4096 bytes');return;}
      const m=parseModule(d,fi.name);
      if(m.type!=='GPEC2A'){setMsg('Not a GPEC2A file');return;}
      const entry=addDump(m);
      if(entry){if(slot===1)setHash1(entry.hash);else setHash2(entry.hash);}
      setMsg('');
    };
    r.readAsArrayBuffer(fi);
  },[addDump]);

  const toggleSkim=useCallback(()=>{
    if(!f||!entry1)return;
    const p=new Uint8Array(f.data);
    p[0x11]=p[0x11]===0x80?0x00:0x80;
    const next=parseModule(p,f.filename);
    const updated=replaceDump(entry1.hash,next);
    if(updated)setHash1(updated.hash);
    dl(p,'SKIM_'+(p[0x11]===0x80?'ENABLED':'DISABLED')+'_'+f.filename);
    setMsg('SKIM toggled to 0x'+p[0x11].toString(16).toUpperCase()+' — patched .bin downloaded');
  },[f,entry1,replaceDump]);

  const diff=useMemo(()=>{
    if(!f||!f2)return[];
    const r=[];
    for(let i=0;i<Math.min(f.data.length,f2.data.length);i++)
      if(f.data[i]!==f2.data[i])r.push({off:i,a:f.data[i],b:f2.data[i]});
    return r;
  },[f,f2]);

  const skimOn=f?.skimByte===0x80;
  const counters=f?.runtimeCounters;
  const counterTiles=counters?[
    {n:'COUNTER A',c:counters.counterA},
    {n:'COUNTER B',c:counters.counterB},
    {n:'DISTANCE', c:counters.distance},
    {n:'KEY CYCLES',c:counters.keyCycles},
  ]:[];

  return <div>
    <Card style={{background:'linear-gradient(135deg,#003D33 0%,#00897B 50%,#00BFA5 100%)',color:'#fff',marginBottom:18}}>
      <div style={{display:'flex',alignItems:'center',gap:14}}>
        <div style={{fontSize:32}}>⚙️</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Righteous'",fontSize:24,letterSpacing:2}}>GPEC2A INSPECTOR</div>
          <div style={{fontSize:10,opacity:.7,letterSpacing:3,fontWeight:700}}>SKIM · TAMPER · TRANSPONDER KEYS · RUNTIME COUNTERS</div>
        </div>
      </div>
    </Card>

    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}}>
        <div style={{fontSize:28}}>📂</div>
        <div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load GPEC2A File 1</div>
        {f&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f.filename}</div>}
        <input type="file" hidden onChange={e=>load(e,1)} accept=".bin,.BIN"/>
      </Card></label>
      <label style={{cursor:'pointer'}}><Card style={{textAlign:'center',padding:18}}>
        <div style={{fontSize:28}}>📂</div>
        <div style={{fontSize:12,fontWeight:800,color:C.ts,marginTop:4}}>Load File 2 (for diff)</div>
        {f2&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a2,marginTop:4}}>{f2.filename}</div>}
        <input type="file" hidden onChange={e=>load(e,2)} accept=".bin,.BIN"/>
      </Card></label>
    </div>

    {f&&<>
      {/* Hero status: SKIM + ZZZZ tamper */}
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>⚙️ GPEC2A Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(skimOn?C.gn+'40':C.wn+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>SKIM @ 0x0011</div>
            <div style={{fontSize:28,fontWeight:900,color:skimOn?C.gn:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{skimOn?'ENABLED':'DISABLED'}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:2}}>0x{(f.skimByte||0).toString(16).toUpperCase().padStart(2,'0')} — {f.skimStatus}</div>
            <div style={{marginTop:10}}><Btn onClick={toggleSkim} color={skimOn?C.wn:C.gn} outline>{skimOn?'Disable SKIM':'Enable SKIM'}</Btn></div>
          </div>
          {f.zzzzTamper&&<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(f.zzzzTamper.intact?C.gn+'40':C.er+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>ZZZZ TAMPER @ {offHex(f.zzzzTamper.offset)}</div>
            <div style={{fontSize:28,fontWeight:900,color:f.zzzzTamper.intact?C.gn:C.er,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{f.zzzzTamper.intact?'INTACT':'TAMPERED'}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts,marginTop:6,wordBreak:'break-all'}}>{f.zzzzTamper.hex}</div>
          </div>}
        </div>
      </Card>

      {/* Runtime counters — 4 large-number tiles */}
      {counters&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📊 Runtime Counters</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {counterTiles.map(t=><div key={t.n} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>{t.n}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:24,fontWeight:900,color:C.a1,marginTop:4,lineHeight:1.1}}>{(t.c.value>>>0).toLocaleString()}</div>
            <div style={{fontSize:9,color:C.tm,marginTop:2}}>{offHex(t.c.offset)}</div>
          </div>)}
        </div>
      </Card>}

      {/* Transponder keys — 4-up grid */}
      {f.transponderKeys?.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Transponder Keys @ 0x0888</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {f.transponderKeys.map((t,i)=>{
            const bytes=f.data.slice(t.offset,t.offset+4);
            const blank=isBlank(bytes);
            return <div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
              <div style={{fontSize:10,fontWeight:800,color:C.tm}}>KEY {i+1}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:4,wordBreak:'break-all'}}>{t.hex}</div>
              <div style={{fontSize:9,color:C.tm,marginTop:2}}>{offHex(t.offset)}</div>
              <Tag color={blank?C.tm:C.gn}>{blank?'—':'SET'}</Tag>
            </div>;
          })}
        </div>
      </Card>}

      {/* Secret key + mirror */}
      {f.secretKey&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔑 Secret Key</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Primary @ {offHex(f.secretKey.offset)} (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:isBlank(f.secretKey.bytes)?'#D5D0C8':C.a4,wordBreak:'break-all'}}>{f.secretKey.hex}</div>
          </div>
          {f.secretKeyMirror&&<div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Mirror @ {offHex(f.secretKeyMirror.offset)} (8B)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:isBlank(f.secretKeyMirror.bytes)?'#D5D0C8':C.a4,wordBreak:'break-all'}}>{f.secretKeyMirror.hex}</div>
          </div>}
        </div>
        <div style={{marginTop:8}}><Tag color={f.keyConsistent?C.gn:C.er}>{f.keyConsistent?'Primary = Mirror ✓':'MISMATCH'}</Tag></div>
      </Card>}

      {/* Part number + PCM Sec6 */}
      {(f.partNumberStr||f.pcmSec6)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔖 Identifiers</div>
        {f.partNumberStr&&<div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,marginBottom:8}}>
          <div style={{fontSize:10,color:C.tm,marginBottom:4}}>Part Number @ 0x0FA1 (13B)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a3,letterSpacing:2}}>{f.partNumberStr}</div>
        </div>}
        {f.pcmSec6&&<div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
            <span style={{fontSize:10,color:C.tm}}>PCM Sec6 @ {offHex(f.pcmSec6.offset)} (6B)</span>
            <Tag color={f.pcmSec6.damaged?C.er:f.pcmSec6.blank?C.wn:C.gn}>{f.pcmSec6.immoState}</Tag>
          </div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:f.pcmSec6.damaged?'#D5D0C8':C.a4,wordBreak:'break-all'}}>{f.pcmSec6.hex}</div>
        </div>}
      </Card>}

      {/* VINs */}
      {f.vins?.length>0&&<Card style={{marginBottom:14,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>VINs</div>
        {f.vins.map((v,i)=><div key={i} style={{fontFamily:"'JetBrains Mono'",fontSize:12,marginBottom:4}}>
          <span style={{color:C.tm}}>{offHex(v.offset)}: </span>
          <span style={{fontWeight:800,color:C.a1}}>{v.vin}</span>
        </div>)}
      </Card>}
    </>}

    {f&&f2&&<Card style={{padding:16,marginTop:10}}>
      <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔀 Hex Diff — {diff.length} byte{diff.length!==1?'s':''} different</div>
      {diff.length===0&&<div style={{fontSize:12,color:C.gn,fontWeight:700}}>✓ Files are identical</div>}
      {diff.length>0&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,background:C.c2,borderRadius:8,padding:10,maxHeight:260,overflow:'auto',border:'1px solid '+C.bd}}>
        <div style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4,marginBottom:4}}>
          <span style={{fontWeight:700,color:C.tm}}>Offset</span>
          <span style={{fontWeight:700,color:C.a1}}>File 1</span>
          <span style={{fontWeight:700,color:C.a3}}>File 2</span>
        </div>
        {diff.slice(0,200).map((d,i)=><div key={i} style={{display:'grid',gridTemplateColumns:'70px 1fr 1fr',gap:4}}>
          <span style={{color:C.tm}}>{offHex(d.off)}</span>
          <span style={{color:C.a1,fontWeight:700}}>0x{d.a.toString(16).toUpperCase().padStart(2,'0')}</span>
          <span style={{color:C.a3,fontWeight:700}}>0x{d.b.toString(16).toUpperCase().padStart(2,'0')}</span>
        </div>)}
        {diff.length>200&&<div style={{color:C.tm,marginTop:4}}>...and {diff.length-200} more</div>}
      </div>}
    </Card>}

    {msg&&<div style={{marginTop:10,padding:'8px 12px',borderRadius:8,background:C.gn+'10',fontSize:11,fontWeight:700,color:C.gn}}>✓ {msg}</div>}
    {!f&&<div style={{textAlign:'center',padding:30,color:C.tm,fontSize:12}}>Load a GPEC2A 4 KB .bin file above</div>}
  </div>;
}

export default Gpec2aTab;
