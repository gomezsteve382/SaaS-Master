import React, { useMemo } from 'react';
import { C } from '../lib/constants.js';
import { extractRfhPflashIdentity } from '../lib/rfhPflashIdentity.js';
import { fmtPick } from '../lib/bestPick.js';

/**
 * Shared OS / PN / SERIAL best-pick card (Task #774).
 *
 * Pass either:
 *   - `identity` — a pre-computed result from extractRfhPflashIdentity, OR
 *   - `bytes`    — raw Uint8Array; the extractor is run here.
 *
 * Empty fields render a "no candidate found" line rather than being hidden,
 * so techs can see at a glance which of the three buckets came up dry.
 */
export default function IdentityCard({ identity, bytes, title = 'OS / PN / SERIAL BEST-PICK', style }) {
  const id = useMemo(() => {
    if (identity) return identity;
    if (bytes && bytes.length) return extractRfhPflashIdentity(bytes);
    return null;
  }, [identity, bytes]);

  if (!id) return null;

  const rows = [
    { label: 'OS PN',  field: id.os,
      hint: 'Operating-system part number (letters + digits)' },
    { label: 'Part #', field: id.pn,
      hint: 'Hardware part number (digits + 2–3 letter suffix)' },
    { label: 'Serial', field: id.serial,
      hint: 'Supplier serial — mixed alphanumeric' },
  ];

  return (
    <div style={style}>
      {title && (
        <div style={{ fontWeight: 800, fontSize: 11, color: C.ts, marginBottom: 10, letterSpacing: 2 }}>
          🔎 {title}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{
            background: C.c2, borderRadius: 10, padding: '10px 14px',
            border: '1px solid ' + (r.field?.matchesCanonical ? C.gn + '60' : C.bd),
          }}>
            <div style={{ fontSize: 9, fontWeight: 900, color: C.ts, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
              {r.label}
            </div>
            {r.field ? (
              <>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.tx, fontWeight: 700, wordBreak: 'break-all' }}>
                  {r.field.value}
                </span>
                <div style={{ fontSize: 9, color: C.tm, marginTop: 4 }}>
                  {fmtPick(r.field)}
                  {r.field.matchesCanonical ? <span style={{ color: C.gn, marginLeft: 6, fontWeight: 800 }}>canonical</span> : null}
                </div>
                <div style={{ fontSize: 9, color: C.tm, marginTop: 2 }}>
                  @ 0x{r.field.offset.toString(16).toUpperCase().padStart(6, '0')}
                </div>
              </>
            ) : (
              <span style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>— no candidate found —</span>
            )}
            <div style={{ fontSize: 9, color: C.tm, marginTop: 4, fontStyle: 'italic' }}>{r.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
