import React from "react";
import { DTC_STATUS_BITS } from "./dtc.js";

/* Inline detail panel rendered under a DTC log row in UdsTab,
 * and reused by other surfaces that show structured DTCs.
 *
 * Pure presentational — takes the payload built by buildDtcDetail()
 * and a copy callback. No engine, no hooks, no async. Kept here
 * so it can be SSR-tested via react-dom/server.renderToString
 * without spinning up jsdom. */
export default function DtcDetailPanel({ detail, onCopy }) {
  if (!detail) return null;
  const statusBin = (detail.statusByte | 0).toString(2).padStart(8, "0");
  const moduleStr = detail.moduleAddr
    ? `TX 0x${detail.moduleAddr.tx.toString(16).toUpperCase().padStart(3, "0")} · RX 0x${detail.moduleAddr.rx.toString(16).toUpperCase().padStart(3, "0")}`
    : null;
  return (
    <div data-testid="uds-dtc-detail" style={{margin:'4px 0 8px 80px',padding:10,background:'#1A1A24',border:'1px solid #2D2D40',borderRadius:6,color:'#E0E0E0'}}>
      <div style={{fontSize:11,fontWeight:800,color:'#FFB300'}}>
        {detail.code}{detail.category ? ' · ' + detail.category : ''}
      </div>
      <div style={{fontSize:11,marginTop:4,color:'#FFF'}}>
        {detail.description || '(no description in fault table — Task T1 .db not yet ingested)'}
      </div>
      <div style={{fontSize:10,marginTop:8,color:'#AAA'}}>
        Status byte {detail.statusHex} ({statusBin}b):
      </div>
      <div style={{fontSize:10,marginTop:4,display:'grid',gridTemplateColumns:'repeat(2, 1fr)',gap:'2px 12px'}}>
        {DTC_STATUS_BITS.map(d => {
          const on = !!detail.statusBits[d.key];
          return (
            <div key={d.key} data-testid={'uds-dtc-bit-' + d.key} style={{color: on ? '#00E676' : '#555'}}>
              {on ? '■' : '□'} {d.label}
            </div>
          );
        })}
      </div>
      {moduleStr && (
        <div style={{fontSize:10,marginTop:8,color:'#AAA'}}>Module: {moduleStr}</div>
      )}
      <div style={{marginTop:8}}>
        <button
          data-testid="uds-dtc-copy"
          onClick={(e) => { e.stopPropagation(); if (onCopy) onCopy(detail.code); else { try { navigator.clipboard.writeText(detail.code); } catch (_) { /* noop */ } } }}
          style={{fontSize:10,fontWeight:700,padding:'4px 10px',borderRadius:4,border:'1px solid #444',background:'#0D0D15',color:'#B388FF',cursor:'pointer'}}
        >📋 Copy code</button>
      </div>
    </div>
  );
}
