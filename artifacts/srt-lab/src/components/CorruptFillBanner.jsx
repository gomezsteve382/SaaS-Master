import {C} from '../lib/constants.js';

// Shared corrupt-capture badge. Surfaces an OBDSTAR6 corrupt-fill detection
// (detectCorruptFill result) with a uniform design across every tab. The
// Dumps vault, Module Sync, and the per-module tabs all render this so the
// copy and styling stay consistent — wording changes happen here once.
export default function CorruptFillBanner({filename, moduleType, size, result, onRemove, fileIndex}){
  return (
    <div data-testid="dumps-corrupt-fill-badge"
         data-corrupt-reason={result?.reason}
         data-file-index={fileIndex}
         style={{marginTop:12,padding:'14px 16px',borderRadius:10,background:'rgba(211,47,47,0.09)',border:'2px solid '+C.er}}>
      <div style={{fontWeight:900,fontSize:13,color:C.er,letterSpacing:1.2,textTransform:'uppercase',marginBottom:8}}>
        ⚠ Corrupt capture — OBDSTAR6 fill detected
      </div>
      <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts,lineHeight:1.7}}>
        <div>File: <strong>{filename||'(unknown)'}</strong></div>
        <div>Module: <strong>{moduleType||'UNKNOWN'}</strong> · {(size||0).toLocaleString()} bytes</div>
        <div>Reason: <strong>{result?.reason}</strong></div>
        <div style={{marginTop:4,fontSize:10,color:C.tm,wordBreak:'break-word'}}>{result?.detail}</div>
      </div>
      <div style={{marginTop:8,fontSize:12,color:C.ts,fontWeight:600,lineHeight:1.5}}>
        This file cannot be used for VIN or key operations. Remove it and re-read the module using verified hardware.
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          style={{marginTop:10,padding:'5px 14px',fontSize:10,background:'none',border:'1px solid '+C.er,borderRadius:8,cursor:'pointer',color:C.er,fontWeight:800,letterSpacing:1}}>
          REMOVE
        </button>
      )}
    </div>
  );
}
