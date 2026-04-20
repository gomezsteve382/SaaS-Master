import React, {useState, useCallback, useMemo} from "react";
import {C} from "../lib/constants.js";
import {Card,Btn} from "../lib/ui.jsx";
import {ALGOS, xtea_sgw_full, alfaW6, alfaW6By, u32} from "../lib/algos.js";
import {AOBD_W6, AOBD_W7, AOBD_DISPATCH} from "../lib/alfaobdAlgorithms.generated.js";
import {mergeDispatch, STATUS_BRANCH_KNOWN} from "../lib/alfaobdDispatchAuxiliary.js";
import {buildOnePagerPDF} from "../lib/buildOnePagerPDF.js";
import {SEED_KEY_REF} from "../lib/tabReferences.js";

function SeedTab(){
  const[al,setAl]=useState('gpec2');const[sh,setSh]=useState('');const[res,setRes]=useState(null);const[all,setAll]=useState(false);
  const[pdfBusy,setPdfBusy]=useState(false);
  // AlfaOBD lookup affordances — these don't pollute the main picker
  // (380 wrappers would be unusable). Selecting a family/level or
  // entering a wrapper name computes alongside the chosen ALGOS entry.
  const[wrapName,setWrapName]=useState('');
  const[famKey,setFamKey]=useState('');
  const[lvlKey,setLvlKey]=useState('');
  // Manual (r, s) input for the AlfaOBD w6 (custom) ALGOS entry. These
  // accept either bare hex digits ("234521F9") or 0x-prefixed.
  const[customR,setCustomR]=useState('');
  const[customS,setCustomS]=useState('');
  // Merged dispatch view: catalog-resolved entries take precedence over
  // the auxiliary "branch known but algorithm not yet traced" rows so
  // a future RE finding in the catalog JSON automatically wins. Family
  // keys are sorted with resolved (computable) families first.
  const fullDispatch=useMemo(()=>mergeDispatch(AOBD_DISPATCH),[]);
  const familyKeys=useMemo(()=>{
    const all=Object.keys(fullDispatch);
    const isResolved=(k)=>Object.keys(fullDispatch[k]).some(lk=>lk!=='_status');
    return all.sort((a,b)=>{
      const ra=isResolved(a),rb=isResolved(b);
      if(ra!==rb) return ra?-1:1;
      return a.localeCompare(b);
    });
  },[fullDispatch]);
  // Humanize a dispatcher level key. Catalog uses `aj_1`, `aj_3`, `aj_5`,
  // `aj_7` (eEcusecaccess level); strip the prefix and present as
  // "Level N" so the operator doesn't have to know the AlfaOBD field
  // naming convention. Unknown keys (e.g. `_status`) are filtered out
  // upstream — they should never reach the dropdown.
  const humanLevel=(lk)=>{
    const m=/^aj_(\d+)$/.exec(lk);
    return m?`Level ${m[1]}`:lk;
  };
  // Humanize a family/ecu key. `family_27` → "Family 27"; `ecu_UCONNECT_0x149`
  // → "ECU UCONNECT (0x149)"; bare `ecu_TBM2_PN` → "ECU TBM2_PN".
  const humanFamily=(fk)=>{
    if(/^family_\d+$/.test(fk)) return 'Family '+fk.slice('family_'.length);
    if(fk.startsWith('ecu_')){
      const rest=fk.slice('ecu_'.length);
      const m=/^(.+)_0x([0-9A-Fa-f]+)$/.exec(rest);
      if(m) return `ECU ${m[1]} (0x${m[2].toUpperCase()})`;
      return `ECU ${rest}`;
    }
    return fk;
  };
  const lvlKeys=useMemo(()=>{
    if(!famKey||!fullDispatch[famKey]) return [];
    return Object.keys(fullDispatch[famKey]).filter(k=>k!=='_status').sort();
  },[famKey,fullDispatch]);
  const isFamilyAdvisory=famKey && fullDispatch[famKey]?._status===STATUS_BRANCH_KNOWN;
  const dispatchedName=famKey&&lvlKey?(fullDispatch[famKey]?.[lvlKey]||''):'';
  const dispatchedIsW6=dispatchedName && (dispatchedName in AOBD_W6);
  const dispatchedIsW7=dispatchedName && (dispatchedName in AOBD_W7);
  const dispatchedIsAo=/^ao\b/.test(dispatchedName);

  const onPdf=async()=>{if(pdfBusy)return;setPdfBusy(true);try{await buildOnePagerPDF(SEED_KEY_REF);}catch(e){console.error(e);alert('PDF build failed: '+e.message);}finally{setPdfBusy(false);}};

  const computeWrapper=(name,seedBytes)=>{
    const out=alfaW6By(seedBytes,name);
    if(!out) return null;
    return Array.from(out).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  };
  const computeManualW6=(r,s,seedBytes)=>{
    const out=alfaW6(seedBytes,r,s);
    return Array.from(out).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  };
  const parseHexU32=(t)=>{
    const raw=(t||'').replace(/\s/g,'').replace(/^0x/i,'');
    if(!/^[0-9a-fA-F]{1,8}$/.test(raw)) return null;
    return parseInt(raw,16)>>>0;
  };
  const seedToBytes=(v)=>[(v>>>24)&0xFF,(v>>>16)&0xFF,(v>>>8)&0xFF,v&0xFF];

  const calc=useCallback(()=>{
    const raw=sh.replace(/\s/g,'');const v=parseInt(raw,16);if(isNaN(v)||!raw)return;
    const sb=seedToBytes(u32(v));
    const sgwFull=()=>{const [c0,c1]=xtea_sgw_full(u32(v));return c0.toString(16).toUpperCase().padStart(8,'0')+c1.toString(16).toUpperCase().padStart(8,'0');};
    const wrapResult=wrapName.trim()?{name:wrapName.trim(),key:computeWrapper(wrapName.trim(),sb)}:null;
    const dispResult=dispatchedIsW6?{name:dispatchedName,level:humanLevel(lvlKey),family:humanFamily(famKey),key:computeWrapper(dispatchedName,sb)}:null;
    // alfa_w6_custom: prefer manual (r,s) when both fields parse cleanly,
    // else fall back to wrapper-name lookup. Surfaces a clear error when
    // neither is usable.
    const computeCustom=()=>{
      const r=parseHexU32(customR), s=parseHexU32(customS);
      if(r!==null && s!==null) return {via:'manual (r, s)',key:computeManualW6(r,s,sb)};
      if(wrapName.trim()){
        const k=computeWrapper(wrapName.trim(),sb);
        if(k) return {via:'wrapper '+wrapName.trim(),key:k};
      }
      return {via:'',key:'enter (r, s) above OR a wrapper name in the AlfaOBD lookup'};
    };
    if(all){
      setRes({multi:true,seed:v.toString(16).toUpperCase().padStart(8,'0'),
        results:ALGOS.map(a=>({id:a.id,n:a.n,h:a.h,
          k:a.id==='alfa_w6_custom'?(computeCustom().key||'—'):a.fn(v).toString(16).toUpperCase().padStart(8,'0'),
          k8:a.id==='xtea_sgw'?sgwFull():null})),
        wrapResult,dispResult});
    } else {
      const a=ALGOS.find(x=>x.id===al);if(!a)return;
      const isCustom=a.id==='alfa_w6_custom';
      const customRes=isCustom?computeCustom():null;
      setRes({multi:false,id:a.id,n:a.n,seed:v.toString(16).toUpperCase().padStart(8,'0'),
        key:isCustom?(customRes.key||'—'):a.fn(v).toString(16).toUpperCase().padStart(8,'0'),
        key8:a.id==='xtea_sgw'?sgwFull():null,
        customVia:isCustom?customRes.via:null,
        wrapResult,dispResult});
    }
  },[al,sh,all,wrapName,dispatchedName,dispatchedIsW6,famKey,lvlKey,customR,customS]);

  const totalAlgoCount=ALGOS.length;

  return<div style={{maxWidth:880}}>
    <Card glow>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12,marginBottom:4}}>
        <div>
          <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>🔑 Seed → Key Calculator</div>
          <div style={{fontSize:12,color:C.ts,marginBottom:16}}>{totalAlgoCount} algorithms + AlfaOBD w6 catalog (380 wrappers) + w7 staged (360 wrappers, cipher pending)</div>
        </div>
        <button onClick={onPdf} disabled={pdfBusy} style={{cursor:pdfBusy?'wait':'pointer',border:'2px solid '+C.sr,padding:'8px 14px',borderRadius:10,background:'#fff',color:C.sr,fontWeight:800,fontSize:11,letterSpacing:.5,fontFamily:"'Nunito'",whiteSpace:'nowrap'}}>
          {pdfBusy?'⏳ Building...':'🖨 Print Reference'}
        </button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:6,marginBottom:16}}>
        {ALGOS.map(a=><div key={a.id} onClick={()=>{setAl(a.id);setAll(false);}} style={{
          padding:'9px 11px',borderRadius:10,cursor:'pointer',transition:'all 0.2s',
          background:al===a.id&&!all?C.sr+'12':C.c2,border:`1.5px solid ${al===a.id&&!all?C.sr:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:al===a.id&&!all?C.sr:C.tx}}>{a.n}</div>
          <div style={{fontSize:8,color:C.tm}}>{a.h}</div>
        </div>)}
        <div onClick={()=>setAll(true)} style={{padding:'9px 11px',borderRadius:10,cursor:'pointer',background:all?C.a4+'12':C.c2,border:`1.5px solid ${all?C.a4:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:all?C.a4:C.tx}}>ALL</div>
          <div style={{fontSize:8,color:C.tm}}>Run all {totalAlgoCount}</div>
        </div>
      </div>

      {/* AlfaOBD w6 (custom) extra inputs — only shown when that ALGOS entry is selected */}
      {al==='alfa_w6_custom'&&!all&&<div style={{padding:12,borderRadius:10,background:C.a4+'10',border:'1.5px solid '+C.a4,marginBottom:12}}>
        <div style={{fontSize:10,fontWeight:800,color:C.a4,letterSpacing:2,marginBottom:8}}>ALFAOBD W6 — MANUAL (r, s)</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div>
            <div style={{fontSize:9,color:C.tm,marginBottom:4}}>r (hex u32)</div>
            <input value={customR} onChange={e=>setCustomR(e.target.value.toUpperCase().replace(/[^0-9A-FX\s]/g,''))}
              placeholder="234521F9 or 0x234521F9"
              style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:12,fontFamily:"'JetBrains Mono'",boxSizing:'border-box'}}/>
          </div>
          <div>
            <div style={{fontSize:9,color:C.tm,marginBottom:4}}>s (hex u32)</div>
            <input value={customS} onChange={e=>setCustomS(e.target.value.toUpperCase().replace(/[^0-9A-FX\s]/g,''))}
              placeholder="19390673 or 0x19390673"
              style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:12,fontFamily:"'JetBrains Mono'",boxSizing:'border-box'}}/>
          </div>
        </div>
        <div style={{marginTop:8,fontSize:10,color:C.tm}}>
          Leave both blank to compute from the wrapper-name field below instead.
        </div>
      </div>}

      {/* AlfaOBD lookup row — family+level dispatch + manual w6 wrapper */}
      <div style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd,marginBottom:16}}>
        <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:2,marginBottom:8}}>ALFAOBD LOOKUP (in addition to picker above)</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 100px 1fr',gap:8,alignItems:'end'}}>
          <div>
            <div style={{fontSize:9,color:C.tm,marginBottom:4}}>FAMILY / ECU</div>
            <select value={famKey} onChange={e=>{setFamKey(e.target.value);setLvlKey('');}}
              style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11,fontFamily:"'JetBrains Mono'"}}>
              <option value="">— select family / ECU —</option>
              {familyKeys.map(k=>{
                const advisory=fullDispatch[k]?._status===STATUS_BRANCH_KNOWN;
                return <option key={k} value={k}>{humanFamily(k)}{advisory?' — branch known, algorithm not traced':''}</option>;
              })}
            </select>
          </div>
          <div>
            <div style={{fontSize:9,color:C.tm,marginBottom:4}}>LEVEL</div>
            <select value={lvlKey} onChange={e=>setLvlKey(e.target.value)}
              disabled={!famKey || isFamilyAdvisory}
              style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11,fontFamily:"'JetBrains Mono'"}}>
              <option value="">{isFamilyAdvisory?'— no levels traced —':'— level —'}</option>
              {lvlKeys.map(k=><option key={k} value={k}>{humanLevel(k)}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:9,color:C.tm,marginBottom:4}}>OR WRAPPER NAME (e.g. tt, ez, c0)</div>
            <input value={wrapName} onChange={e=>setWrapName(e.target.value.toLowerCase().replace(/[^a-z0-9]/g,''))}
              placeholder="manual w6 wrapper"
              style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11,fontFamily:"'JetBrains Mono'",boxSizing:'border-box'}}/>
          </div>
        </div>
        {dispatchedName&&<div style={{marginTop:8,fontSize:11,color:C.tm}}>
          Dispatched → <code style={{color:C.tx,fontWeight:800}}>{dispatchedName}</code>
          {' '}{dispatchedIsW6&&<span style={{color:C.a3,fontWeight:700}}>(w6 — computable)</span>}
          {dispatchedIsW7&&<span style={{color:C.a4,fontWeight:700}}>(w7 — algorithm pending translation)</span>}
          {dispatchedIsAo&&<span style={{color:C.sr,fontWeight:700}}>(use the AlfaOBD ao entry above)</span>}
        </div>}
        {wrapName&&!(wrapName in AOBD_W6)&&<div style={{marginTop:6,fontSize:11,color:C.a4}}>
          Wrapper <code>{wrapName}</code> not in catalog (expecting one of {Object.keys(AOBD_W6).length} w6 names).
        </div>}
      </div>

      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:2}}>SEED (HEX)</div>
      <input value={sh} placeholder="e.g. A1B2C3D4" onChange={e=>setSh(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g,''))}
        style={{width:'100%',padding:'14px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:20,fontWeight:700,letterSpacing:4,textAlign:'center',outline:'none',boxSizing:'border-box'}}
        onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}
        onKeyDown={e=>{if(e.key==='Enter')calc();}}/>
      <div style={{marginTop:12}}><Btn onClick={calc} disabled={!sh.trim()} full>Calculate Key</Btn></div>

      {res&&!res.multi&&<div style={{marginTop:20,padding:20,borderRadius:14,background:C.c2,border:'1.5px solid '+C.bd}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 40px 1fr',gap:12,alignItems:'center'}}>
          <div><div style={{fontSize:9,color:C.tm,letterSpacing:2,marginBottom:6}}>SEED</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:26,fontWeight:800,color:C.a3}}>{res.seed}</div></div>
          <div style={{textAlign:'center',fontSize:20,color:C.tm}}>→</div>
          <div><div style={{fontSize:9,color:C.tm,letterSpacing:2,marginBottom:6}}>KEY (4-BYTE)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:26,fontWeight:800,color:C.sr}}>{res.key}</div></div>
        </div>
        {res.key8&&<div style={{marginTop:14,paddingTop:14,borderTop:'1px dashed '+C.bd}}>
          <div style={{fontSize:9,color:C.tm,letterSpacing:2,marginBottom:6}}>KEY (8-BYTE, full XTEA block)</div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,color:C.sr,wordBreak:'break-all'}}>{res.key8}</div>
          <div style={{marginTop:6,fontSize:10,color:C.tm}}>Send when SGW issues an 8-byte seed in 67 01.</div>
        </div>}
        {res.customVia&&<div style={{marginTop:8,fontSize:10,color:C.tm}}>via: <code style={{color:C.a4}}>{res.customVia}</code></div>}
        <div style={{marginTop:8,fontSize:11,color:C.tm}}>{res.n}</div>
      </div>}

      {res&&res.multi&&<div style={{marginTop:20}}>
        <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Seed: <span style={{fontFamily:"'JetBrains Mono'",color:C.a3}}>{res.seed}</span></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          {res.results.map((r,i)=><div key={i} style={{padding:'10px 12px',borderRadius:10,background:C.c2,border:'1px solid '+C.bd,display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
            <div><div style={{fontSize:11,fontWeight:800,color:C.tx}}>{r.n}</div><div style={{fontSize:8,color:C.tm}}>{r.h}</div></div>
            <div style={{textAlign:'right'}}>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:C.sr}}>{r.k}</div>
              {r.k8&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:C.sr,opacity:.75,marginTop:2}}>8B: {r.k8}</div>}
            </div>
          </div>)}
        </div>
      </div>}

      {/* AlfaOBD per-call results: dispatched + manual wrapper */}
      {res&&(res.dispResult||res.wrapResult)&&<div style={{marginTop:14,padding:12,borderRadius:10,background:C.c2,border:'1px dashed '+C.bd}}>
        <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:2,marginBottom:8}}>ALFAOBD LOOKUP RESULTS</div>
        {res.dispResult&&<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0'}}>
          <div style={{fontSize:11}}>
            <div style={{fontWeight:800}}>{res.dispResult.family} / {res.dispResult.level}</div>
            <div style={{fontSize:9,color:C.tm}}>w6 wrapper <code>{res.dispResult.name}</code></div>
          </div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:C.sr}}>{res.dispResult.key||'—'}</div>
        </div>}
        {res.wrapResult&&<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderTop:res.dispResult?'1px dotted '+C.bd:'none'}}>
          <div style={{fontSize:11}}>
            <div style={{fontWeight:800}}>Manual: <code>{res.wrapResult.name}</code></div>
            <div style={{fontSize:9,color:C.tm}}>w6 / custom (r,s)</div>
          </div>
          <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:800,color:C.sr}}>{res.wrapResult.key||'wrapper not in catalog'}</div>
        </div>}
      </div>}
    </Card>

    {/* w7 read-only catalog panel — staged data, no cipher yet */}
    <Card style={{marginTop:16}}>
      <div style={{fontSize:14,fontWeight:900,marginBottom:4}}>📋 AlfaOBD w7 catalog</div>
      <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
        {Object.keys(AOBD_W7).length} per-ECU parameter triples (n, o, p) staged from
        the AlfaOBD .NET drop. <strong>Algorithm pending translation</strong> — cipher
        core (`ad::w7` + 7 big-integer helpers) not yet ported. Once it lands,
        these rows light up automatically.
      </div>
      <div style={{maxHeight:240,overflow:'auto',border:'1px solid '+C.bd,borderRadius:8,background:C.c2}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:10}}>
          <thead style={{position:'sticky',top:0,background:C.c2,borderBottom:'1px solid '+C.bd}}>
            <tr>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>name</th>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>n</th>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>o</th>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>p</th>
              <th style={{textAlign:'right',padding:'6px 10px',fontWeight:800,color:C.tm}}>status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(AOBD_W7).map(([name,trip])=><tr key={name} style={{borderTop:'1px solid '+C.bd+'80'}}>
              <td style={{padding:'4px 10px',fontWeight:700}}>{name}</td>
              <td style={{padding:'4px 10px'}}>0x{(trip[0]>>>0).toString(16).padStart(8,'0').toUpperCase()}</td>
              <td style={{padding:'4px 10px'}}>0x{(trip[1]>>>0).toString(16).padStart(8,'0').toUpperCase()}</td>
              <td style={{padding:'4px 10px'}}>0x{(trip[2]>>>0).toString(16).padStart(8,'0').toUpperCase()}</td>
              <td style={{padding:'4px 10px',textAlign:'right',color:C.a4,fontSize:9}}>algorithm pending</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </Card>
  </div>;
}


export default SeedTab;
