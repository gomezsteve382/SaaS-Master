import React, {useState, useCallback, useMemo, useEffect, useContext} from "react";
import {C} from "../lib/constants.js";
import {Card,Btn} from "../lib/ui.jsx";
import {getAuth29Detections, subscribeAuth29, clearAuth29Detections, loadAuth29Detections, getAuth29Unlocks, clearAuth29Unlocks} from "../lib/auth29State.js";
import {ALGOS, UNLOCK_FALLBACK, xtea_sgw_full, alfaW6, alfaW6By, u32, MOD_UNLOCK} from "../lib/algos.js";
import {parseSeedResponse, computeSeedKey, FCA_MODULE_ALGO} from "../lib/alfaobdSeedKey.js";
import {AOBD_W6, AOBD_W7, AOBD_DISPATCH} from "../lib/alfaobdAlgorithms.generated.js";
import {EXTENDED_ALGORITHMS} from "../lib/extendedAlgorithms.generated.js";
import {mergeDispatch, STATUS_BRANCH_KNOWN} from "../lib/alfaobdDispatchAuxiliary.js";
import {buildOnePagerPDF} from "../lib/buildOnePagerPDF.js";
import {SEED_KEY_REF} from "../lib/tabReferences.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import {parseVinYear} from "../lib/vin.js";
import {
  getAllModules, decodeNrc, NRC_TABLE,
  ALGO as UDS_ALGO, buildSessionSequence,
} from "../lib/udsEngine.js";

// Asset-sweep ports surfaced in the picker. Each extended entry maps to
// the same {id, n, h, fn} shape as ALGOS so the existing calc/render
// code dispatches them with no special-casing — the only addition is an
// `extended: true` flag the picker uses to draw a small purple chip so
// the operator can see at a glance that the algorithm came from
// tools/asset-sweep rather than the curated `algos.js` set. Frozen so
// nothing downstream can mutate the picker list out from under React.
const EXT_PICKER_ALGOS = Object.freeze(
  EXTENDED_ALGORITHMS
    .filter((a) => typeof a.fn === "function")
    .map((a) => Object.freeze({
      id: "ext_" + a.tag,
      n: a.label,
      h: "asset sweep · " + (a.signatures[0] || a.tag),
      fn: a.fn,
      extended: true,
      tag: a.tag,
      docstring: a.docstring,
    })),
);
// udsEngine.ALGO constants → algos.js ids bridge
const UDS_ALGO_TO_ALGOS_ID = {
  [UDS_ALGO.GPEC2A]:   'gpec2a',
  [UDS_ALGO.GPEC2]:    'gpec2',
  [UDS_ALGO.CDA6]:     'cda6',
  [UDS_ALGO.SBEC]:     'sbec',
  [UDS_ALGO.XTEA_SGW]: 'xtea_sgw',
  [UDS_ALGO.NGC]:      'ngc',
  [UDS_ALGO.TIPM]:     't80',
};
// Build MODULE_ALGO_HINT dynamically from udsEngine MODULE_REGISTRY (RE-verified)
// so it stays in sync instead of being a stale copy.
const MODULE_ALGO_HINT = (() => {
  const hint = {};
  for (const mod of getAllModules()) {
    hint[mod.code] = UDS_ALGO_TO_ALGOS_ID[mod.algo] || MOD_UNLOCK[mod.code] || 'cda6';
  }
  // Supplement with algos.js MOD_UNLOCK for codes not in udsEngine registry
  for (const [code, id] of Object.entries(MOD_UNLOCK)) {
    if (!hint[code]) hint[code] = id;
  }
  return hint;
})();
// Year-aware BCM algorithm hint: 2016+ uses bcm_fca, 2007-2015 uses bcm_standard.
// cda6 is the OBD/UDS SecurityAccess algorithm; bcm_fca/bcm_standard are for
// bench-level direct EEPROM reads. Both are surfaced so the operator can pick.
function bcmAlgoForYear(year){
  if(!year) return 'cda6';
  return year>=2016?'bcm_fca':'bcm_standard';
}
function SeedTab(){
  const[al,setAl]=useState('gpec2');const[sh,setSh]=useState('');const[res,setRes]=useState(null);const[all,setAll]=useState(false);const[fallback,setFallback]=useState(false);
  const[pdfBusy,setPdfBusy]=useState(false);
  const[copiedId,setCopiedId]=useState(null);
  const copyKey=(id,text)=>{
    try{navigator.clipboard.writeText(text).catch(()=>{});}catch(_){}
    setCopiedId(id);setTimeout(()=>setCopiedId(i=>i===id?null:i),1500);
  };
  // ── Auto-parse 67 XX seed response ──────────────────────────────────────────
  // Paste the full UDS 67 XX response and the tab extracts the seed, picks the
  // best algorithm from FCA_MODULE_ALGO (or the module registry), computes the
  // key, and pre-fills the manual seed field below.
  const [rawResponse, setRawResponse] = useState('');
  const [autoModCode, setAutoModCode] = useState('');
  const [autoResult, setAutoResult] = useState(null);
  const [autoError, setAutoError] = useState('');

  const autoCompute = useCallback(() => {
    setAutoError('');
    setAutoResult(null);
    const raw = rawResponse.trim();
    if (!raw) return;
    try {
      let seedBytes;
      const parts = raw.replace(/,/g,' ').trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 6 && parts[0].toUpperCase() === '67') {
        // Full 67 XX s0 s1 s2 s3 response
        seedBytes = parseSeedResponse(raw);
      } else if (parts.length === 4) {
        // Bare 4 seed bytes
        seedBytes = parts.map(h => parseInt(h, 16));
        if (seedBytes.some(isNaN)) throw new Error('Invalid hex bytes');
      } else if (parts.length === 1 && /^[0-9A-Fa-f]{8}$/.test(parts[0])) {
        // 8-char hex string
        const v = parseInt(parts[0], 16);
        seedBytes = [(v>>>24)&0xFF,(v>>>16)&0xFF,(v>>>8)&0xFF,v&0xFF];
      } else {
        throw new Error('Paste the full 67 XX response (e.g. "67 05 C1 FF CB C1") or 4 seed bytes');
      }
      // Determine algo from selected module code (FCA_MODULE_ALGO first, then udsEngine)
      const fcaInfo = autoModCode ? (FCA_MODULE_ALGO[autoModCode] || null) : null;
      let opts = {};
      if (fcaInfo) {
        opts.algorithm = fcaInfo.algo;
        if (fcaInfo.wrapper) opts.wrapper = fcaInfo.wrapper;
        if (fcaInfo.level) opts.securityLevel = fcaInfo.level;
      } else if (autoModCode) {
        // Fall back to udsEngine registry algo hint
        const algoId = MODULE_ALGO_HINT[autoModCode];
        if (algoId === 'gpec2a' || algoId === 'gpec2') opts.algorithm = 'gpec2a';
        else if (algoId === 'xtea_sgw') opts.algorithm = 'f';
        else opts.algorithm = 'w6';
        if (opts.algorithm === 'w6') opts.wrapper = 'tt'; // sensible default
      } else {
        // No module selected — try GPEC2A w6/tt as the most common SRT ECM algo
        opts.algorithm = 'w6';
        opts.wrapper = 'tt';
      }
      const result = computeSeedKey(seedBytes, opts);
      const seedHex = seedBytes.map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
      setSh(seedHex); // pre-fill manual seed field
      setAutoResult({
        seedHex,
        keyHex: result.keyHex,
        sendCommand: result.sendCommand,
        algorithm: result.algorithm,
        note: fcaInfo?.note || null,
        moduleCode: autoModCode || null,
      });
    } catch (e) {
      setAutoError(e.message);
    }
  }, [rawResponse, autoModCode]);

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

  // Picker dispatcher fallback: ALGOS first (curated, in-app catalog),
  // then EXT_PICKER_ALGOS (executable hand-ports surfaced by the asset
  // sweep). Both share the same {id, n, h, fn} shape so the lookup
  // below treats them identically.
  const PICKER_ALGOS=useMemo(()=>[...ALGOS,...EXT_PICKER_ALGOS],[]);

  // Resolve UNLOCK_FALLBACK ids to picker entries for the fallback table.
  // alfa_w6_custom is skipped (it needs interactive (r,s) input and has no
  // deterministic fn for batch computation).
  const FALLBACK_ALGOS=useMemo(()=>
    UNLOCK_FALLBACK
      .map(id=>PICKER_ALGOS.find(a=>a.id===id))
      .filter(Boolean)
      .filter(a=>a.id!=='alfa_w6_custom')
  ,[PICKER_ALGOS]);

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
    if(fallback){
      setRes({mode:'fallback',seed:v.toString(16).toUpperCase().padStart(8,'0'),
        results:FALLBACK_ALGOS.map(a=>({id:a.id,n:a.n,h:a.h,
          k:a.fn(u32(v)).toString(16).toUpperCase().padStart(8,'0'),
          k8:a.id==='xtea_sgw'?sgwFull():null})),
        wrapResult,dispResult});
    } else if(all){
      // "Run all" includes both the curated ALGOS and the executable
      // extended ports — the latter were verified against pinned
      // vectors at sweep time so they're safe to fire alongside the
      // canonical entries.
      setRes({mode:'all',seed:v.toString(16).toUpperCase().padStart(8,'0'),
        results:PICKER_ALGOS.map(a=>({id:a.id,n:a.n,h:a.h,extended:!!a.extended,
          k:a.id==='alfa_w6_custom'?(computeCustom().key||'—'):a.fn(u32(v)).toString(16).toUpperCase().padStart(8,'0'),
          k8:a.id==='xtea_sgw'?sgwFull():null})),
        wrapResult,dispResult});
    } else {
      const a=PICKER_ALGOS.find(x=>x.id===al);if(!a)return;
      const isCustom=a.id==='alfa_w6_custom';
      const customRes=isCustom?computeCustom():null;
      setRes({mode:'single',id:a.id,n:a.n,seed:v.toString(16).toUpperCase().padStart(8,'0'),
        key:isCustom?(customRes.key||'—'):a.fn(u32(v)).toString(16).toUpperCase().padStart(8,'0'),
        key8:a.id==='xtea_sgw'?sgwFull():null,
        customVia:isCustom?customRes.via:null,
        extended:!!a.extended,
        wrapResult,dispResult});
    }
  },[al,sh,all,fallback,wrapName,dispatchedName,dispatchedIsW6,famKey,lvlKey,customR,customS,PICKER_ALGOS,FALLBACK_ALGOS]);

  const totalAlgoCount=ALGOS.length;
  const extendedAlgoCount=EXT_PICKER_ALGOS.length;

  // ── NRC decoder panel state ─────────────────────────────────────────────
  const [nrcInput, setNrcInput] = useState('');
  const [nrcResult, setNrcResult] = useState(null);
  const decodeNrcInput = useCallback(() => {
    const raw = nrcInput.replace(/^0x/i,'').replace(/\s/g,'');
    const code = parseInt(raw, 16);
    if (isNaN(code)) { setNrcResult({err:'Enter a valid hex NRC byte (e.g. 35)'}); return; }
    setNrcResult(decodeNrc(code & 0xFF));
  }, [nrcInput]);
  // ── Module Registry panel state ─────────────────────────────────────────
  const [regFilter, setRegFilter] = useState('');
  const [regExpanded, setRegExpanded] = useState(false);
  const allMods = useMemo(() => getAllModules(), []);
  const filteredMods = useMemo(() => {
    const q = regFilter.trim().toLowerCase();
    if (!q) return allMods;
    return allMods.filter(m =>
      m.code.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      (m.algo||'').toLowerCase().includes(q)
    );
  }, [allMods, regFilter]);
  // ── Session sequence preview state ──────────────────────────────────────
  const [seqModule, setSeqModule] = useState('IPC');
  const [seqOp, setSeqOp] = useState('extended');
  const [seqExpanded, setSeqExpanded] = useState(false);
  const seqSteps = useMemo(() => {
    try { return buildSessionSequence(seqModule, seqOp); } catch { return []; }
  }, [seqModule, seqOp]);

  // ── Algorithm auto-selector ─────────────────────────────────────────────
  // Reads loaded dumps from MasterVinContext and VIN year to suggest the
  // most likely algorithm. Dismissed per-session via a local flag.
  const {vin:masterVin, loadedDumps, getDumpsByType} = useContext(MasterVinContext);
  const [algoSuggestionDismissed, setAlgoSuggestionDismissed] = useState(false);
  const algoSuggestion = useMemo(() => {
    if (algoSuggestionDismissed) return null;
    // Derive vehicle year from VIN position 10 (0-indexed 9)
    const vinYear = masterVin && masterVin.length === 17 ? parseVinYear(masterVin) : null;
    // Prefer the first recognised module type in the workspace
    const moduleTypes = ['BCM','RFHUB','GPEC2A','ECM','TCM','TIPM','SGW','ADCM','DAMP'];
    let detectedType = null;
    for (const t of moduleTypes) {
      if (getDumpsByType(t).length > 0) { detectedType = t; break; }
    }
    if (!detectedType) return null;
    // BCM: year-aware hint (bench algo vs OBD algo)
    let algoId = detectedType === 'BCM' ? bcmAlgoForYear(vinYear) : (MODULE_ALGO_HINT[detectedType] || null);
    if (!algoId) return null;
    const algoEntry = ALGOS.find(a => a.id === algoId);
    if (!algoEntry) return null;
    return { type: detectedType, algoId, algoName: algoEntry.n, hint: algoEntry.h, vinYear };
  }, [masterVin, loadedDumps, getDumpsByType, algoSuggestionDismissed, ALGOS]);

  // Task #567 — UDS 0x29 Authentication detection banner. Subscribes
  // to in-tab updates from the detector and to cross-tab storage events
  // so a probe fired from the flasher or unlock chain lights this up.
  const [auth29,setAuth29]=useState(()=>getAuth29Detections());
  const [auth29Ok,setAuth29Ok]=useState(()=>getAuth29Unlocks());
  useEffect(()=>{
    const refresh=()=>{ setAuth29(getAuth29Detections()); setAuth29Ok(getAuth29Unlocks()); };
    const off=subscribeAuth29(refresh);
    const onStorage=(e)=>{ if(!e||e.key==='srtlab.auth29.detections'||e.key==='srtlab.auth29.unlocks') refresh(); };
    if(typeof window!=='undefined') window.addEventListener('storage',onStorage);
    // Task #573 — pull the server-side detection set so the bench
    // remembers across browsers / machines. Refresh fires from the
    // subscriber once the merged list is written to localStorage.
    loadAuth29Detections().then(()=>refresh()).catch(()=>{});
    return ()=>{ off(); if(typeof window!=='undefined') window.removeEventListener('storage',onStorage); };
  },[]);

  return<div style={{maxWidth:880}}>
    {algoSuggestion&&<Card data-testid="algo-suggestion-banner" style={{marginBottom:12,background:'#E3F2FD',borderColor:'#1565C0'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
        <div>
          <div style={{fontSize:12,fontWeight:900,color:'#1565C0',letterSpacing:1,marginBottom:4}}>ALGORITHM SUGGESTION</div>
          <div style={{fontSize:12,color:C.tx,marginBottom:4}}>
            Loaded module: <b>{algoSuggestion.type}</b>{algoSuggestion.vinYear?<> · Vehicle year: <b>{algoSuggestion.vinYear}</b></>:null}
          </div>
          <div style={{fontSize:12,color:C.tx}}>
            Suggested algorithm: <b>{algoSuggestion.algoName}</b> <span style={{color:C.ts}}>({algoSuggestion.hint})</span>
          </div>
        </div>
        <div style={{display:'flex',gap:8,flexShrink:0}}>
          <button onClick={()=>{setAl(algoSuggestion.algoId);setAll(false);setFallback(false);setAlgoSuggestionDismissed(true);}} style={{cursor:'pointer',border:'2px solid #1565C0',padding:'6px 12px',borderRadius:8,background:'#1565C0',color:'#fff',fontWeight:800,fontSize:11,letterSpacing:.5,whiteSpace:'nowrap'}}>USE THIS ALGO</button>
          <button onClick={()=>setAlgoSuggestionDismissed(true)} style={{cursor:'pointer',border:'1.5px solid #9E9E9E',padding:'6px 10px',borderRadius:8,background:'#fff',color:'#9E9E9E',fontWeight:800,fontSize:11,letterSpacing:.5,whiteSpace:'nowrap'}}>DISMISS</button>
        </div>
      </div>
    </Card>}
    {auth29Ok.length>0&&<Card data-testid="auth29-unlocked-banner" style={{marginBottom:12,background:'#E8F5E9',borderColor:'#1B5E20'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
        <div>
          <div style={{fontSize:12,fontWeight:900,color:'#1B5E20',letterSpacing:1,marginBottom:4}}>UDS 0x29 UNLOCKED</div>
          <div style={{fontSize:12,color:C.tx,marginBottom:4}}>
            {auth29Ok.length===1?'A module':`${auth29Ok.length} modules`} on this bench unlocked via the UDS 0x29 Authentication challenge/response handshake.
          </div>
          <div style={{fontSize:10,fontFamily:"'JetBrains Mono', monospace",color:C.tm}}>
            {auth29Ok.map(d=>`tx=0x${(d.tx>>>0).toString(16).toUpperCase().padStart(3,'0')}${d.label?` (${d.label})`:''}${d.statusInfo!=null?` · statusInfo 0x${d.statusInfo.toString(16).toUpperCase().padStart(2,'0')}`:''}`).join(' · ')}
          </div>
        </div>
        <button onClick={clearAuth29Unlocks} data-testid="auth29-unlocked-banner-clear" style={{cursor:'pointer',border:'1.5px solid #1B5E20',padding:'4px 10px',borderRadius:6,background:'#fff',color:'#1B5E20',fontWeight:800,fontSize:10,letterSpacing:1,whiteSpace:'nowrap'}}>DISMISS</button>
      </div>
    </Card>}
    {auth29.length>0&&<Card data-testid="auth29-banner" style={{marginBottom:12,background:'#FFF3E0',borderColor:'#E65100'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
        <div>
          <div style={{fontSize:12,fontWeight:900,color:'#E65100',letterSpacing:1,marginBottom:4}}>UDS 0x29 DETECTED</div>
          <div style={{fontSize:12,color:C.tx,marginBottom:4}}>
            {auth29.length===1?'A module':`${auth29.length} modules`} on this bench answered the 0x29 probe — they require Authentication (0x29) instead of SecurityAccess (0x27). Seed/key unlock will not run for {auth29.length===1?'it':'them'} until 0x29 is implemented.
          </div>
          <div style={{fontSize:10,fontFamily:"'JetBrains Mono', monospace",color:C.tm}}>
            {auth29.map(d=>`tx=0x${(d.tx>>>0).toString(16).toUpperCase().padStart(3,'0')}${d.label?` (${d.label})`:''}${d.nrc!=null?` · seed NRC 0x${d.nrc.toString(16).toUpperCase().padStart(2,'0')}`:''}`).join(' · ')}
          </div>
        </div>
        <button onClick={clearAuth29Detections} data-testid="auth29-banner-clear" style={{cursor:'pointer',border:'1.5px solid #E65100',padding:'4px 10px',borderRadius:6,background:'#fff',color:'#E65100',fontWeight:800,fontSize:10,letterSpacing:1,whiteSpace:'nowrap'}}>DISMISS</button>
      </div>
    </Card>}
    <Card glow>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12,marginBottom:4}}>
        <div>
          <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>🔑 Seed → Key Calculator</div>
          <div style={{fontSize:12,color:C.ts,marginBottom:16}}>{totalAlgoCount} algorithms{extendedAlgoCount?` + ${extendedAlgoCount} from asset sweep`:''} + AlfaOBD w6 catalog (380 wrappers) + w7 staged (360 wrappers, cipher pending)</div>
        </div>
        <button onClick={onPdf} disabled={pdfBusy} style={{cursor:pdfBusy?'wait':'pointer',border:'2px solid '+C.sr,padding:'8px 14px',borderRadius:10,background:'#fff',color:C.sr,fontWeight:800,fontSize:11,letterSpacing:.5,fontFamily:"'Nunito'",whiteSpace:'nowrap'}}>
          {pdfBusy?'⏳ Building...':'🖨 Print Reference'}
        </button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))',gap:6,marginBottom:16}}>
        {PICKER_ALGOS.map(a=><div key={a.id} title={a.extended?(a.docstring||a.tag):a.h} onClick={()=>{setAl(a.id);setAll(false);setFallback(false);}} style={{
          padding:'9px 11px',borderRadius:10,cursor:'pointer',transition:'all 0.2s',position:'relative',
          background:al===a.id&&!all&&!fallback?C.sr+'12':C.c2,border:`1.5px solid ${al===a.id&&!all&&!fallback?C.sr:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:al===a.id&&!all&&!fallback?C.sr:C.tx}}>{a.n}</div>
          <div style={{fontSize:8,color:C.tm}}>{a.h}</div>
          {a.extended&&<span data-testid={`ext-chip-${a.tag}`} style={{position:'absolute',top:4,right:4,fontSize:7,fontWeight:800,letterSpacing:.5,padding:'1px 4px',borderRadius:3,background:'#9C27B014',color:'#6A1B9A'}}>EXT</span>}
        </div>)}
        <div data-testid="fallback-chain-tile" onClick={()=>{setFallback(true);setAll(false);}} style={{padding:'9px 11px',borderRadius:10,cursor:'pointer',background:fallback?'#1B5E2012':C.c2,border:`1.5px solid ${fallback?'#1B5E20':C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:fallback?'#1B5E20':C.tx}}>FALLBACK</div>
          <div style={{fontSize:8,color:C.tm}}>Try {FALLBACK_ALGOS.length} · UNLOCK_FALLBACK chain</div>
        </div>
        <div onClick={()=>{setAll(true);setFallback(false);}} style={{padding:'9px 11px',borderRadius:10,cursor:'pointer',background:all?C.a4+'12':C.c2,border:`1.5px solid ${all?C.a4:C.bd}`}}>
          <div style={{fontSize:11,fontWeight:800,color:all?C.a4:C.tx}}>ALL</div>
          <div style={{fontSize:8,color:C.tm}}>Run all {totalAlgoCount + extendedAlgoCount}</div>
        </div>
      </div>

      {/* AlfaOBD w6 (custom) extra inputs — only shown when that ALGOS entry is selected */}
      {al==='alfa_w6_custom'&&!all&&!fallback&&<div style={{padding:12,borderRadius:10,background:C.a4+'10',border:'1.5px solid '+C.a4,marginBottom:12}}>
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

      {/* ── AUTO-PARSE & COMPUTE ──────────────────────────────────────── */}
      <div data-testid="auto-parse-panel" style={{padding:14,borderRadius:12,background:'#0D0D15',border:'2px solid '+C.sr+'50',marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:1.5,marginBottom:6}}>⚡ AUTO-PARSE &amp; COMPUTE</div>
        <div style={{fontSize:10,color:C.tm,marginBottom:8}}>Paste the full UDS seed response (e.g. <code style={{color:C.a3}}>67 05 C1 FF CB C1</code>) — algorithm is auto-selected from the module.</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 180px',gap:8,marginBottom:8}}>
          <input
            data-testid="auto-parse-input"
            value={rawResponse}
            onChange={e=>setRawResponse(e.target.value.toUpperCase().replace(/[^0-9A-F\s,]/g,''))}
            placeholder="67 05 C1 FF CB C1"
            style={{padding:'10px 12px',borderRadius:9,border:'1.5px solid '+C.bd,background:'#0A0A12',color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,letterSpacing:2,outline:'none',boxSizing:'border-box',width:'100%'}}
            onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}
            onKeyDown={e=>{if(e.key==='Enter')autoCompute();}}
          />
          <select
            data-testid="auto-parse-module-select"
            value={autoModCode}
            onChange={e=>setAutoModCode(e.target.value)}
            style={{padding:'10px 10px',borderRadius:9,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11,fontFamily:"'Nunito'",boxSizing:'border-box'}}>
            <option value="">— module (optional) —</option>
            {Object.entries(FCA_MODULE_ALGO).map(([code,info])=><option key={code} value={code}>{code} — {info.note||info.algo}</option>)}
            {allMods.filter(m=>!FCA_MODULE_ALGO[m.code]).map(m=><option key={m.code} value={m.code}>{m.code} — {m.name}</option>)}
          </select>
        </div>
        <button
          data-testid="auto-parse-btn"
          onClick={autoCompute}
          disabled={!rawResponse.trim()}
          style={{width:'100%',padding:'10px',borderRadius:9,border:'none',background:rawResponse.trim()?C.sr:'#333',color:'#fff',fontWeight:900,fontSize:12,letterSpacing:1,cursor:rawResponse.trim()?'pointer':'not-allowed',transition:'background .15s'}}>
          ⚡ COMPUTE KEY
        </button>
        {autoError&&<div data-testid="auto-parse-error" style={{marginTop:8,fontSize:11,color:'#EF5350',fontWeight:700}}>{autoError}</div>}
        {autoResult&&<div data-testid="auto-parse-result" style={{marginTop:12,padding:14,borderRadius:10,background:'#0A0A12',border:'1.5px solid '+C.sr+'60'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 32px 1fr',gap:10,alignItems:'center',marginBottom:10}}>
            <div>
              <div style={{fontSize:8,color:C.tm,letterSpacing:2,marginBottom:4}}>SEED</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,color:C.a3,letterSpacing:2}}>{autoResult.seedHex}</div>
            </div>
            <div style={{textAlign:'center',fontSize:18,color:C.tm}}>→</div>
            <div>
              <div style={{fontSize:8,color:C.tm,letterSpacing:2,marginBottom:4}}>KEY</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,color:C.sr,letterSpacing:2}}>{autoResult.keyHex}</div>
            </div>
          </div>
          <div style={{padding:'8px 10px',borderRadius:8,background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:12,color:'#40C4FF',letterSpacing:1,marginBottom:8,wordBreak:'break-all'}}>
            {autoResult.sendCommand}
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <span style={{fontSize:9,color:C.tm}}>algo: <code style={{color:C.a4}}>{autoResult.algorithm}</code></span>
            {autoResult.moduleCode&&<span style={{fontSize:9,color:C.tm}}>module: <code style={{color:C.a4}}>{autoResult.moduleCode}</code></span>}
            {autoResult.note&&<span style={{fontSize:9,color:C.tm,fontStyle:'italic'}}>{autoResult.note}</span>}
            <button
              data-testid="auto-parse-copy-btn"
              onClick={()=>{try{navigator.clipboard.writeText(autoResult.sendCommand).catch(()=>{});}catch(_){}}}
              style={{marginLeft:'auto',cursor:'pointer',border:'1.5px solid '+C.sr,padding:'3px 10px',borderRadius:6,background:'transparent',color:C.sr,fontWeight:800,fontSize:9,letterSpacing:.5,fontFamily:"'Nunito'"}}>
              COPY COMMAND
            </button>
          </div>
        </div>}
      </div>
      <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:2}}>SEED (HEX)</div>
      <input value={sh} placeholder="e.g. A1B2C3D4" onChange={e=>setSh(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g,''))}
        style={{width:'100%',padding:'14px 16px',borderRadius:12,border:'2px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:20,fontWeight:700,letterSpacing:4,textAlign:'center',outline:'none',boxSizing:'border-box'}}
        onFocus={e=>e.target.style.borderColor=C.sr} onBlur={e=>e.target.style.borderColor=C.bd}
        onKeyDown={e=>{if(e.key==='Enter')calc();}}/>
      <div style={{marginTop:12}}><Btn onClick={calc} disabled={!sh.trim()} full>Calculate Key</Btn></div>

      {res&&res.mode==='single'&&<div style={{marginTop:20,padding:20,borderRadius:14,background:C.c2,border:'1.5px solid '+C.bd}}>
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

      {res&&res.mode==='fallback'&&<div data-testid="fallback-results" style={{marginTop:20}}>
        <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:800}}>UNLOCK_FALLBACK chain — Seed: <span style={{fontFamily:"'JetBrains Mono'",color:C.a3}}>{res.seed}</span></div>
          <span style={{fontSize:10,color:C.tm}}>{res.results.length} algorithms · ordered as tried on-bus</span>
        </div>
        <div style={{maxHeight:380,overflowY:'auto',border:'1.5px solid '+C.bd,borderRadius:12,background:C.c2}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:12}}>
            <thead style={{position:'sticky',top:0,background:C.c2,zIndex:1,borderBottom:'2px solid '+C.bd}}>
              <tr>
                <th style={{textAlign:'left',padding:'8px 12px',fontWeight:800,color:C.tm,fontSize:10,letterSpacing:1}}>#</th>
                <th style={{textAlign:'left',padding:'8px 12px',fontWeight:800,color:C.tm,fontSize:10,letterSpacing:1}}>ALGORITHM</th>
                <th style={{textAlign:'left',padding:'8px 12px',fontWeight:800,color:C.tm,fontSize:10,letterSpacing:1}}>KEY BYTES</th>
                <th style={{textAlign:'right',padding:'8px 12px',fontWeight:800,color:C.tm,fontSize:10,letterSpacing:1}}>COPY</th>
              </tr>
            </thead>
            <tbody>
              {res.results.map((r,i)=><tr key={r.id} data-testid={`fallback-row-${r.id}`} style={{borderTop:'1px solid '+C.bd+'60',background:i%2===0?'transparent':'#0000000A'}}>
                <td style={{padding:'8px 12px',color:C.tm,fontSize:10,fontWeight:700}}>{i+1}</td>
                <td style={{padding:'8px 12px'}}>
                  <div style={{fontWeight:800,color:C.tx,fontSize:11}}>{r.n}</div>
                  <div style={{fontSize:8,color:C.tm,marginTop:1}}>{r.h}</div>
                </td>
                <td style={{padding:'8px 12px'}}>
                  <span style={{color:C.sr,fontWeight:800,letterSpacing:1}}>{r.k}</span>
                  {r.k8&&<div style={{fontSize:9,color:C.sr,opacity:.75,marginTop:2}}>8B: {r.k8}</div>}
                </td>
                <td style={{padding:'8px 12px',textAlign:'right'}}>
                  <button data-testid={`fallback-copy-${r.id}`} onClick={()=>copyKey(r.id,r.k8||r.k)}
                    style={{cursor:'pointer',border:'1.5px solid '+(copiedId===r.id?'#1B5E20':C.bd),padding:'4px 10px',borderRadius:6,
                      background:copiedId===r.id?'#E8F5E9':'#fff',color:copiedId===r.id?'#1B5E20':C.tx,
                      fontWeight:800,fontSize:9,letterSpacing:.5,fontFamily:"'Nunito'",transition:'all .15s'}}>
                    {copiedId===r.id?'✓ COPIED':'COPY'}
                  </button>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>}

      {res&&res.mode==='all'&&<div style={{marginTop:20}}>
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

    {/* Extended catalog provenance panel — every entry below is wired
        into the picker above with a small purple "EXT" chip. This card
        documents the source so the operator can audit which python file
        each port came from and which signatures fired. The catalog
        auto-shrinks the moment one is promoted into the in-app source
        — see tools/asset-sweep/README.md. */}
    {EXTENDED_ALGORITHMS.length>0 && <Card style={{marginTop:16}}>
      <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap',marginBottom:4}}>
        <div style={{fontSize:14,fontWeight:900}}>🧪 Extended catalog (asset sweep)</div>
        <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,fontWeight:800,padding:'2px 7px',borderRadius:999,background:'#9C27B014',color:'#6A1B9A',letterSpacing:1}}>provenance: asset_sweep</span>
      </div>
      <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
        {EXTENDED_ALGORITHMS.length} algorithm{EXTENDED_ALGORITHMS.length===1?'':'s'} hand-ported from
        <code style={{margin:'0 4px',padding:'1px 4px',background:'#0001',borderRadius:3,fontSize:10}}>attached_assets/</code>,
        each verified against pinned vectors at sweep time.
        <strong> Available in the picker above</strong> — look for the small purple <span style={{fontSize:9,fontWeight:800,padding:'1px 4px',borderRadius:3,background:'#9C27B014',color:'#6A1B9A'}}>EXT</span> chip.
        Re-run with
        <code style={{margin:'0 4px',padding:'1px 4px',background:'#0001',borderRadius:3,fontSize:10}}>pnpm sweep:assets</code>.
      </div>
      <div style={{maxHeight:240,overflow:'auto',border:'1px solid '+C.bd,borderRadius:8,background:C.c2}}>
        <table data-testid="extended-algos-table" style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:10}}>
          <thead style={{position:'sticky',top:0,background:C.c2,borderBottom:'1px solid '+C.bd}}>
            <tr>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>tag</th>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>python def</th>
              <th style={{textAlign:'left',padding:'6px 10px',fontWeight:800,color:C.tm}}>doc</th>
              <th style={{textAlign:'right',padding:'6px 10px',fontWeight:800,color:C.tm}}>status</th>
            </tr>
          </thead>
          <tbody>
            {EXTENDED_ALGORITHMS.map(a=>{
              const ported=a.ported===true&&typeof a.fn==='function';
              return <tr key={a.tag} data-testid={`ext-row-${a.tag}`} style={{borderTop:'1px solid '+C.bd+'80'}}>
                <td style={{padding:'4px 10px',fontWeight:700}}>{a.tag}</td>
                <td style={{padding:'4px 10px'}}>{a.pythonName}({a.params})</td>
                <td style={{padding:'4px 10px',fontFamily:"'Nunito'",fontSize:10,color:C.tm,maxWidth:380}}>
                  {a.docstring?a.docstring.split('\n')[0].slice(0,140):<span style={{opacity:.6}}>—</span>}
                </td>
                <td style={{padding:'4px 10px',textAlign:'right',fontSize:9,color:ported?'#1B5E20':C.a4}}>
                  {ported?`✓ ported · ${a.vectors.length} vectors`:a.coverageStatus}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </Card>}

    {/* ────────────────────────────────────────────────────────────────────────────────
         NRC DECODER (udsEngine NRC_TABLE)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginTop:16}} data-testid="nrc-decoder-card">
      <div style={{fontSize:14,fontWeight:900,marginBottom:8}}>🔴 NRC Decoder</div>
      <div style={{fontSize:11,color:C.ts,marginBottom:10}}>
        Paste the negative response code byte from a 7F xx <b>NRC</b> frame to decode it.
        Source: udsEngine NRC_TABLE ({Object.keys(NRC_TABLE).length} codes).
      </div>
      <div style={{display:'flex',gap:8,alignItems:'flex-end',marginBottom:10}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>NRC BYTE (hex, e.g. 35 or 0x35)</div>
          <input
            data-testid="nrc-input"
            value={nrcInput}
            onChange={e=>setNrcInput(e.target.value.toUpperCase().replace(/[^A-F0-9Xx]/g,''))}
            onKeyDown={e=>{if(e.key==='Enter')decodeNrcInput();}}
            placeholder="35"
            style={{width:'100%',padding:'10px 12px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,color:C.tx,fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:700,letterSpacing:4,textAlign:'center',outline:'none',boxSizing:'border-box'}}
          />
        </div>
        <Btn onClick={decodeNrcInput} disabled={!nrcInput.trim()}>Decode</Btn>
      </div>
      {nrcResult&&!nrcResult.err&&<div data-testid="nrc-result" style={{padding:14,borderRadius:10,background:C.c2,border:'1.5px solid '+C.bd}}>
        <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:6}}>
          <span style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.sr}}>0x{nrcInput.replace(/^0x/i,'').padStart(2,'0').toUpperCase()}</span>
          <span style={{fontSize:12,fontWeight:800,color:C.tx}}>{nrcResult.name}</span>
        </div>
        <div style={{fontSize:12,color:C.ts}}>{nrcResult.desc}</div>
      </div>}
      {nrcResult&&nrcResult.err&&<div style={{fontSize:11,color:C.sr,marginTop:6}}>{nrcResult.err}</div>}
      {/* Full NRC table */}
      <div style={{marginTop:12}}>
        <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:2,marginBottom:6}}>FULL NRC TABLE</div>
        <div style={{maxHeight:200,overflow:'auto',border:'1px solid '+C.bd,borderRadius:8,background:C.c2}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:10}}>
            <thead style={{position:'sticky',top:0,background:C.c2,borderBottom:'1px solid '+C.bd}}>
              <tr>
                <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>CODE</th>
                <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>NAME</th>
                <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>DESCRIPTION</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(NRC_TABLE).map(([code,entry])=>(
                <tr key={code}
                  onClick={()=>{setNrcInput(parseInt(code).toString(16).toUpperCase().padStart(2,'0'));setNrcResult(entry);}}
                  style={{borderTop:'1px solid '+C.bd+'60',cursor:'pointer'}}
                  onMouseEnter={e=>e.currentTarget.style.background='#0000000A'}
                  onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <td style={{padding:'4px 10px',color:C.sr,fontWeight:800}}>0x{parseInt(code).toString(16).toUpperCase().padStart(2,'0')}</td>
                  <td style={{padding:'4px 10px',fontWeight:700}}>{entry.name}</td>
                  <td style={{padding:'4px 10px',color:C.tm,fontFamily:"'Nunito'",fontSize:10}}>{entry.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>

    {/* ────────────────────────────────────────────────────────────────────────────────
         MODULE REGISTRY (udsEngine RE-verified CAN IDs + algorithms)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginTop:16}} data-testid="module-registry-card">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontSize:14,fontWeight:900}}>📡 Module Registry</div>
        <button onClick={()=>setRegExpanded(e=>!e)} style={{fontSize:10,color:C.ts,background:'transparent',border:'1px solid '+C.bd,padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>
          {regExpanded?'▲ Collapse':'▼ Expand'}
        </button>
      </div>
      <div style={{fontSize:11,color:C.ts,marginBottom:8}}>
        {allMods.length} modules · RE-verified CAN IDs · click any row to pre-fill the algorithm picker
      </div>
      <input
        data-testid="module-registry-filter"
        value={regFilter}
        onChange={e=>setRegFilter(e.target.value)}
        placeholder="Filter by code, name, or algorithm…"
        style={{width:'100%',padding:'7px 10px',borderRadius:7,border:'1px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11,marginBottom:8,boxSizing:'border-box'}}
      />
      <div style={{maxHeight:regExpanded?600:240,overflow:'auto',border:'1px solid '+C.bd,borderRadius:8,background:C.c2,transition:'max-height .3s'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontFamily:"'JetBrains Mono'",fontSize:10}}>
          <thead style={{position:'sticky',top:0,background:C.c2,borderBottom:'1px solid '+C.bd}}>
            <tr>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>CODE</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>MODULE</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>TX</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>RX</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>ALGO</th>
              <th style={{textAlign:'left',padding:'5px 10px',fontWeight:800,color:C.tm}}>SGW</th>
            </tr>
          </thead>
          <tbody>
            {filteredMods.map(m=>{
              const algosId = UDS_ALGO_TO_ALGOS_ID[m.algo] || MOD_UNLOCK[m.code] || 'cda6';
              return <tr key={m.code}
                onClick={()=>{setAl(algosId);setAll(false);setFallback(false);}}
                style={{borderTop:'1px solid '+C.bd+'60',cursor:'pointer'}}
                onMouseEnter={e=>e.currentTarget.style.background='#0000000A'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <td style={{padding:'4px 10px',fontWeight:800,color:C.a4}}>{m.code}</td>
                <td style={{padding:'4px 10px',color:C.tx,fontFamily:"'Nunito'",fontSize:10}}>{m.name}</td>
                <td style={{padding:'4px 10px',color:C.a3}}>0x{m.tx.toString(16).toUpperCase().padStart(3,'0')}</td>
                <td style={{padding:'4px 10px',color:C.a3}}>0x{m.rx.toString(16).toUpperCase().padStart(3,'0')}</td>
                <td style={{padding:'4px 10px',color:C.sr,fontWeight:700}}>{m.algo}</td>
                <td style={{padding:'4px 10px',color:m.sgwRequired?C.wn:C.tm}}>{m.sgwRequired?'YES':'—'}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </Card>

    {/* ────────────────────────────────────────────────────────────────────────────────
         SESSION SEQUENCE PREVIEW (udsEngine buildSessionSequence)
    ──────────────────────────────────────────────────────────────────────────────── */}
    <Card style={{marginTop:16}} data-testid="session-seq-card">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontSize:14,fontWeight:900}}>🔄 Session Sequence Preview</div>
        <button onClick={()=>setSeqExpanded(e=>!e)} style={{fontSize:10,color:C.ts,background:'transparent',border:'1px solid '+C.bd,padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>
          {seqExpanded?'▲ Collapse':'▼ Expand'}
        </button>
      </div>
      <div style={{fontSize:11,color:C.ts,marginBottom:8}}>
        Preview the full UDS byte sequence for any module + operation. Source: udsEngine buildSessionSequence.
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>MODULE</div>
          <select value={seqModule} onChange={e=>setSeqModule(e.target.value)}
            style={{width:'100%',padding:'7px 10px',borderRadius:7,border:'1px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11}}>
            {allMods.map(m=><option key={m.code} value={m.code}>{m.code} — {m.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>OPERATION</div>
          <select value={seqOp} onChange={e=>setSeqOp(e.target.value)}
            style={{width:'100%',padding:'7px 10px',borderRadius:7,border:'1px solid '+C.bd,background:C.c2,color:C.tx,fontSize:11}}>
            <option value="extended">Extended Diagnostic</option>
            <option value="programming">Programming</option>
            <option value="vin">VIN Write</option>
            <option value="bodycode">Body Code Swap (IPC)</option>
          </select>
        </div>
      </div>
      {seqExpanded&&<div style={{border:'1px solid '+C.bd,borderRadius:8,background:'#0D0D15',padding:12}}>
        {seqSteps.length===0&&<div style={{color:'#666',fontSize:11,textAlign:'center',padding:12}}>No steps for this module/operation combination.</div>}
        {seqSteps.map((step,i)=>(
          <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'6px 0',borderTop:i>0?'1px solid #1A1A2A':'none'}}>
            <span style={{color:'#555',fontSize:10,minWidth:20,textAlign:'right',paddingTop:1}}>{i+1}</span>
            <div style={{flex:1}}>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:'#40C4FF',letterSpacing:1}}>
                {step.bytes ? step.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ') : step.label}
              </div>
              {step.desc&&<div style={{fontSize:10,color:'#888',marginTop:2}}>{step.desc}</div>}
            </div>
          </div>
        ))}
      </div>}
      {!seqExpanded&&<div style={{fontSize:11,color:C.ts,fontStyle:'italic'}}>Click Expand to view {seqSteps.length} step{seqSteps.length!==1?'s':''}.</div>}
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
