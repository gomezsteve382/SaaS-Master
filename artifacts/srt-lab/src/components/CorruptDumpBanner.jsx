import React from "react";
import {C} from "../lib/constants.js";
import {corruptFillError} from "../lib/parseModule.js";

// Task #948 — shared "this loaded dump looks corrupt" banner.
//
// The upload-time guard rejects corrupt captures before they enter the
// workspace, but dumps loaded before that guard existed (or restored from an
// older backup) can still be sitting in the store. Every per-module inspector
// (ECM/ADCM/BCM/RFHUB) renders a parsed `mod` that already carries
// `mod.corruptFill` from parseModule, so this component just turns that flag
// into a consistent, red, blocking warning. It renders nothing when the dump
// looks clean, so callers can drop it in unconditionally.
//
//   <CorruptDumpBanner mod={inspectMod} testid="ecm-corrupt-dump-banner" />
//
export default function CorruptDumpBanner({mod, testid}){
  if(!mod?.corruptFill)return null;
  const cf=mod.corruptFill;
  return (
    <div
      data-testid={testid||"corrupt-dump-banner"}
      data-corrupt-reason={cf.reason}
      style={{marginTop:12,padding:"14px 16px",borderRadius:10,background:"rgba(211,47,47,0.09)",border:"2px solid "+C.er}}>
      <div style={{fontWeight:900,fontSize:13,color:C.er,letterSpacing:1.2,textTransform:"uppercase",marginBottom:8}}>
        ⚠ This loaded dump looks corrupt
      </div>
      <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts,lineHeight:1.7}}>
        <div>File: <strong>{mod.filename||"(unknown)"}</strong></div>
        <div>Module: <strong>{mod.type||"UNKNOWN"}</strong> · {(mod.size||0).toLocaleString()} bytes</div>
        <div>Reason: <strong>{cf.reason}</strong></div>
        {cf.detail&&<div style={{marginTop:4,fontSize:10,color:C.tm,wordBreak:"break-word"}}>{cf.detail}</div>}
      </div>
      <div style={{marginTop:8,fontSize:12,color:C.ts,fontWeight:600,lineHeight:1.5}}>
        {corruptFillError(mod)}
      </div>
    </div>
  );
}
