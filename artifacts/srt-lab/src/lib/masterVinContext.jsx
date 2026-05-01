import React, {createContext, useContext, useState, useCallback, useMemo} from 'react';

/* MasterVinContext — single source of truth for the in-progress job VIN,
   the per-module write status (BCM / RFHUB / ECM / ADCM), AND the set of
   parsed module dumps loaded into the workspace. Tabs read with
   `useContext(MasterVinContext)` or `useMasterVin()`.
   Values:
     vin             — current Master VIN string (uppercase, ≤17 chars)
     setVin          — setter (auto-uppercases / strips whitespace upstream)
     vinValid        — true when length===17 and chars are A-HJ-NPR-Z0-9
     moduleStatus    — { BCM, RFHUB, ECM, ADCM } each 'pending'|'writing'|'ok'|'fail'
     setModuleStatus — full setter (e.g. patch)
     updateStatus    — convenience: updateStatus('BCM','ok')
     setPg           — navigate to a different tab id from a tab
     resetStatus     — reset all four modules back to 'pending'
     loadedDumps     — array of {hash,type,name,filename,size,mod,addedAt,source}
                       parsed dumps the user has loaded; survives tab switches.
                       Keyed (de-duped) by file content hash. `source` is a
                       short, human-readable provenance label (e.g. "Dumps tab",
                       "Samples", "Inspector", "BCM tab") so each tab can render
                       a "loaded from …" chip and users can tell at a glance
                       why a dump they didn't drop themselves is showing up
                       (Task #531). Older callers that pass no source still
                       work; entries without one render no chip.
     addDump         — addDump(parsedMod, source?) → returns the canonical entry
                       (existing if duplicate, leaving its original source
                       intact). parsedMod must come from parseModule().
     replaceDump     — replaceDump(hash, parsedMod) swap an existing entry
                       (e.g. after IMMO sync) preserving its slot AND its
                       original source label.
     removeDump      — removeDump(hash) drop a single dump.
     clearDumps      — drop every loaded dump.
     getDumpsByType  — getDumpsByType('BCM') → array filtered by module type.
*/

const VIN_RX=/^[A-HJ-NPR-Z0-9]{17}$/i;

/* Cheap stable 32-bit FNV-1a hash over the raw bytes — used purely as an
   identity key so the same .bin loaded twice de-dupes. Not cryptographic. */
function hashBytes(bytes){
  let h=0x811C9DC5;
  for(let i=0;i<bytes.length;i++){
    h^=bytes[i];
    h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0;
  }
  return ('00000000'+h.toString(16).toUpperCase()).slice(-8);
}

export const MasterVinContext=createContext({
  vin:'',setVin:()=>{},vinValid:false,
  moduleStatus:{BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'},
  setModuleStatus:()=>{},updateStatus:()=>{},resetStatus:()=>{},
  setPg:()=>{},
  loadedDumps:[],
  addDump:()=>null,
  replaceDump:()=>null,
  removeDump:()=>{},
  clearDumps:()=>{},
  getDumpsByType:()=>[],
  // Task #501 — Vehicle Job hydration. Optional, backward-compatible.
  jobId:null,
  setJobId:()=>{},
  hydrateFromJob:()=>{},
});

export function useMasterVin(){return useContext(MasterVinContext);}

export function MasterVinProvider({setPg,children}){
  const[vin,setVinRaw]=useState('');
  const[moduleStatus,setModuleStatus]=useState({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});
  const[loadedDumps,setLoadedDumps]=useState([]);
  const[jobId,setJobIdRaw]=useState(null);

  const setVin=useCallback(v=>{
    if(typeof v!=='string')return;
    setVinRaw(v.toUpperCase().replace(/\s/g,'').slice(0,17));
  },[]);

  const updateStatus=useCallback((mod,st)=>{
    setModuleStatus(p=>({...p,[mod]:st}));
  },[]);

  const resetStatus=useCallback(()=>{
    setModuleStatus({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});
  },[]);

  const addDump=useCallback((parsed,source)=>{
    if(!parsed||!parsed.data)return null;
    const hash=hashBytes(parsed.data);
    let canonical=null;
    setLoadedDumps(p=>{
      const existing=p.find(d=>d.hash===hash);
      // Re-loading the same bytes from a different tab keeps the original
      // provenance: whichever tab actually first put the file into the
      // workspace is the one the chip should advertise. Otherwise a tech
      // who drops a file in the Dumps tab and then opens the Inspector
      // (which auto-shares it) would see the chip flip to "Inspector".
      if(existing){canonical=existing;return p;}
      canonical={
        hash,
        type:parsed.type,
        name:parsed.name,
        filename:parsed.filename,
        size:parsed.size,
        mod:parsed,
        addedAt:Date.now(),
        source:typeof source==='string'&&source?source:null,
      };
      return [...p,canonical];
    });
    return canonical;
  },[]);

  const replaceDump=useCallback((hash,parsed)=>{
    if(!hash||!parsed||!parsed.data)return null;
    const newHash=hashBytes(parsed.data);
    let canonical=null;
    setLoadedDumps(p=>{
      const target=p.find(d=>d.hash===hash);
      if(!target)return p;
      /* If the replacement bytes collide with a *different* existing entry,
         merge: keep the older slot (so UI selection is stable) and drop the
         old hash to preserve global uniqueness. */
      const collision=newHash!==hash&&p.some(d=>d.hash===newHash);
      const replacement={
        hash:newHash,
        type:parsed.type,
        name:parsed.name,
        filename:parsed.filename,
        size:parsed.size,
        mod:parsed,
        addedAt:target.addedAt,
        source:target.source||null,
      };
      canonical=replacement;
      if(collision){
        return p.flatMap(d=>{
          if(d.hash===hash)return [];
          // Collision: keep the older slot's metadata (addedAt + source)
          // so the chip the user sees doesn't flip just because the new
          // bytes happened to match an existing entry.
          if(d.hash===newHash){canonical={...replacement,addedAt:d.addedAt,source:d.source||target.source||null};return [canonical];}
          return [d];
        });
      }
      return p.map(d=>d.hash===hash?replacement:d);
    });
    return canonical;
  },[]);

  const removeDump=useCallback(hash=>{
    setLoadedDumps(p=>p.filter(d=>d.hash!==hash));
  },[]);

  const clearDumps=useCallback(()=>setLoadedDumps([]),[]);

  const getDumpsByType=useCallback(type=>loadedDumps.filter(d=>d.type===type),[loadedDumps]);

  const vinValid=vin.length===17&&VIN_RX.test(vin);

  const setJobId=useCallback(id=>{
    setJobIdRaw(id||null);
  },[]);

  /* hydrateFromJob — Task #501. Used by the Workflow Runner when the user
     opens a saved job: pulls the persisted VIN into context (so every tab
     sees the same target VIN) and clears the per-module status so the run
     starts from a fresh "pending" state. We deliberately do NOT touch
     loadedDumps; those are bytes-on-disk that the user re-loads each
     session. */
  const hydrateFromJob=useCallback(job=>{
    if(!job||typeof job!=='object')return;
    if(typeof job.vin==='string'&&job.vin.length===17){
      setVinRaw(job.vin.toUpperCase());
    }
    if(typeof job.id==='string'){
      setJobIdRaw(job.id);
    }
    setModuleStatus({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});
  },[]);

  const value=useMemo(()=>({
    vin,setVin,vinValid,
    moduleStatus,setModuleStatus,updateStatus,resetStatus,
    setPg:setPg||(()=>{}),
    loadedDumps,addDump,replaceDump,removeDump,clearDumps,getDumpsByType,
    jobId,setJobId,hydrateFromJob,
  }),[vin,setVin,vinValid,moduleStatus,updateStatus,resetStatus,setPg,
      loadedDumps,addDump,replaceDump,removeDump,clearDumps,getDumpsByType,
      jobId,setJobId,hydrateFromJob]);

  return <MasterVinContext.Provider value={value}>{children}</MasterVinContext.Provider>;
}
