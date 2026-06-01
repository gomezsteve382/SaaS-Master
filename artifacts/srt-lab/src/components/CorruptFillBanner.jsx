import React from "react";
import {C} from "../lib/constants.js";
import {detectCorruptFill} from "../lib/parseModule.js";

/* Shared corrupt-capture banner (Task #940).
 *
 * Renders the same red "Corrupt capture — tool-error fill detected" warning
 * used by the Dumps-tab vault scan (Task #931) so every consumer of a loaded
 * buffer — Module Sync, the BCM / RFHUB / GPEC2A inspectors — surfaces an
 * identical, unmissable badge when a buffer matches a known tool-error
 * pattern (single-byte fill or repeated ASCII string like "OBDSTAR6").
 *
 * Pass either a pre-computed `result` (the object returned by
 * detectCorruptFill) or a raw `bytes` buffer and the component will run the
 * detector itself. Renders nothing when the buffer is clean, so callers can
 * drop it in unconditionally.
 *
 * `label` lets the caller name the slot ("BCM", "RFHUB File 1", …). */
export function corruptFillResult(bytes, precomputed) {
  if (precomputed) return precomputed;
  if (!bytes) return null;
  return detectCorruptFill(bytes);
}

export default function CorruptFillBanner({
  result,
  bytes,
  label,
  name,
  testId,
  // HEAD props
  filename,
  moduleType,
  size,
  onRemove,
  fileIndex
}) {
  const r = corruptFillResult(bytes, result);
  if (!r) return null;

  const displayFilename = filename || name || '(unknown)';

  return (
    <div
      data-testid={testId || "corrupt-fill-banner"}
      data-corrupt-reason={r.reason}
      data-file-index={fileIndex}
      style={{
        marginTop: 12, marginBottom: 12, padding: '14px 16px', borderRadius: 10,
        background: 'rgba(211,47,47,0.09)', border: '2px solid ' + C.er,
      }}
    >
      <div style={{fontWeight: 900, fontSize: 13, color: C.er, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8}}>
        ⚠ Corrupt capture — tool-error fill detected{label ? ' · ' + label : ''}
      </div>
      <div style={{fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.ts, lineHeight: 1.7}}>
        <div>File: <strong>{displayFilename}</strong></div>
        {moduleType && <div>Module: <strong>{moduleType}</strong>{size !== undefined && ` · ${size.toLocaleString()} bytes`}</div>}
        <div>Reason: <strong>{r.reason}</strong></div>
        <div style={{marginTop: 4, fontSize: 10, color: C.tm, wordBreak: 'break-word'}}>{r.detail}</div>
      </div>
      <div style={{marginTop: 8, fontSize: 12, color: C.ts, fontWeight: 600, lineHeight: 1.5}}>
        This file cannot be used for VIN or key operations. {onRemove ? 'Remove it and re-read' : 'Re-read'} the module using verified hardware before continuing.
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          style={{marginTop:10, padding:'5px 14px', fontSize:10, background:'none', border:'1px solid '+C.er, borderRadius:8, cursor:'pointer', color:C.er, fontWeight:800, letterSpacing:1}}>
          REMOVE
        </button>
      )}
    </div>
  );
}
