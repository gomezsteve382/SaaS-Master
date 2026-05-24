/* ============================================================================
 * ImmoBcm56xbTab.jsx — Task #689
 *
 * Standalone Insert -> Inspect -> Apply workbench for 64 KB MPC5606B-class
 * BCM DFLASH dumps. Mirrors the user-supplied ImmoVIN spec while staying
 * additive — the existing ImmoVINTab and BcmTab are untouched.
 *
 * File in -> classify (FULL / VIN_ONLY / LOCKED) -> show per-slot table
 * + SEC16 status -> let the tech enter a new VIN (and, when FULL, a new
 * SEC16) -> re-stamp slots + CRCs -> file out. No network, no UDS, no
 * live ECU access.
 * ============================================================================ */

import React, { useState, useRef, useMemo, useCallback } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { parseMpc5606bBcm, applyMpc5606bBcm } from '../lib/mpc5606bBcm.js';
import { logSec16Sync } from '../lib/sec16SyncLog.js';
import { classifyPlatform } from '../lib/sec16Platforms.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const MODE_COLOR = {
  FULL:     C.gn,
  VIN_ONLY: C.wn,
  LOCKED:   C.er,
};

const MODE_HINT = {
  FULL:     'VIN slots verified and SEC16 secret present — safe to re-stamp both.',
  VIN_ONLY: 'VIN slots verified, SEC16 blank. New VIN can be written; SEC16 stays untouched.',
  LOCKED:   'No verifiable VIN anchor. Refusing to write — re-dump or load a different file.',
};

function fmtOff(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0') + ' (' + n + ')';
}

function ModeBadge({ mode }) {
  const col = MODE_COLOR[mode] || C.tm;
  return (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: 8,
      fontSize: 11, fontWeight: 900, letterSpacing: 1,
      background: col + '22', color: col, border: '1.5px solid ' + col + '44',
    }}>{mode}</span>
  );
}

function FileDropZone({ label, onFile, fileName }) {
  const inputRef = useRef();
  return (
    <div
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      onDragOver={e => e.preventDefault()}
      onClick={() => inputRef.current && inputRef.current.click()}
      style={{
        border: '2px dashed ' + C.sr + '30', borderRadius: 10,
        padding: '18px 16px', cursor: 'pointer', textAlign: 'center', background: C.c2,
      }}>
      <input
        ref={inputRef} type="file" accept=".bin,.BIN"
        style={{ display: 'none' }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 24, marginBottom: 4 }}>📂</div>
      {fileName
        ? <div style={{ fontSize: 12, fontWeight: 800, color: C.sr }}>{fileName}</div>
        : <div style={{ fontSize: 12, color: C.ts }}>{label}</div>}
    </div>
  );
}

function hexLine(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export default function ImmoBcm56xbTab() {
  const [file, setFile]       = useState(null);   // { name, bytes }
  const [parsed, setParsed]   = useState(null);
  const [newVin, setNewVin]   = useState('');
  const [newSec16, setNewSec16] = useState('');
  const [err, setErr]         = useState(null);
  const [applied, setApplied] = useState(null);   // { bytes, name, summary }

  const onFile = useCallback(async (f) => {
    setErr(null); setApplied(null);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const p = parseMpc5606bBcm(buf);
      setFile({ name: f.name, bytes: buf });
      setParsed(p);
      if (p.dominantVin) setNewVin(p.dominantVin);
      else               setNewVin('');
      setNewSec16('');
    } catch (e) {
      setErr('Could not read file: ' + (e && e.message ? e.message : 'unknown'));
    }
  }, []);

  const canApply = useMemo(() => {
    if (!parsed || parsed.mode === 'LOCKED') return false;
    if (!VIN_RE.test(newVin)) return false;
    if (parsed.mode === 'FULL' && newSec16.trim() !== '') {
      const clean = newSec16.replace(/\s+/g, '');
      if (!/^[0-9A-Fa-f]{32}$/.test(clean)) return false;
    }
    return true;
  }, [parsed, newVin, newSec16]);

  const doApply = useCallback(() => {
    setErr(null);
    try {
      const sec16Arg = (parsed.mode === 'FULL' && newSec16.trim() !== '') ? newSec16 : null;
      const r = applyMpc5606bBcm(file.bytes, parsed, { newVin, newSec16Hex: sec16Arg });
      const outName = file.name.replace(/\.bin$/i, '') + '_PATCHED_' + newVin + '.bin';
      setApplied({ bytes: r.bytes, name: outName, result: r });
      /* Fire-and-forget audit when SEC16 was actually programmed. The
       * helper never throws, never blocks — keeps the apply path
       * authoritative even when the API server is offline. */
      if (r.sec16 && (r.sec16.splitPatched + r.sec16.mirrorPatched) > 0) {
        const platform = classifyPlatform({ vin: newVin, modules: [{ type: 'BCM' }] });
        logSec16Sync({
          vin:       newVin,
          platform:  platform && platform.platform ? platform.platform : 'unknown',
          actionId:  'immo-bcm-56xb-sec16-write',
          target:    'BCM',
          verified:  'unverified',
          operator:  'immo-bcm-56xb-tab',
          notes:     'file-in / file-out · no live ECU readback',
          detail: {
            sourceFile:     file.name,
            splitPatched:   r.sec16.splitPatched,
            mirrorPatched:  r.sec16.mirrorPatched,
            mirror1Offset:  r.sec16.mirror1Offset,
            mirror2Offset:  r.sec16.mirror2Offset,
            bcmSec16Hex:    r.sec16.bcmSec16Hex,
            newVin,
          },
        });
      }
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    }
  }, [file, parsed, newVin, newSec16]);

  const downloadOut = useCallback(() => {
    if (!applied) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([applied.bytes], { type: 'application/octet-stream' }));
    a.download = applied.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [applied]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'linear-gradient(135deg,#D32F2F22,#D32F2F44)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
            border: '1.5px solid #D32F2F33',
          }}>🧠</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: C.tx, fontFamily: "'Righteous'" }}>
              IMMO BCM 56xB
            </div>
            <div style={{ fontSize: 11, color: C.ts }}>
              64 KB MPC5606B-class DFLASH · Insert → Inspect → Apply · file in / file out
            </div>
          </div>
        </div>
        <FileDropZone
          label="Drop a 64 KB MPC5606B BCM .bin (or click to browse)"
          onFile={onFile}
          fileName={file ? file.name : null} />
      </Card>

      {err && (
        <Card>
          <div style={{ color: C.er, fontSize: 13, fontWeight: 800 }}>⚠ {err}</div>
        </Card>
      )}

      {parsed && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 900, color: C.tx }}>Classifier</div>
            <ModeBadge mode={parsed.mode} />
            <Tag color={parsed.sizeOk ? C.gn : C.wn}>
              {parsed.size.toLocaleString()} B
            </Tag>
            {parsed.dominantVin && (
              <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 13, fontWeight: 800, color: C.tx }}>
                {parsed.dominantVin}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: C.ts, marginBottom: 10 }}>
            {MODE_HINT[parsed.mode]}
          </div>
          {parsed.reasons.length > 0 && (
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, color: C.tx }}>
              {parsed.reasons.map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{r}</li>)}
            </ul>
          )}
        </Card>
      )}

      {parsed && parsed.slots.length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 900, color: C.tx, marginBottom: 10 }}>
            VIN slot table ({parsed.slots.length} populated, {parsed.validSlots.length} verified)
          </div>
          <table style={{ width: '100%', fontSize: 11, fontFamily: "'JetBrains Mono'", borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.c2, color: C.ts, textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Offset</th>
                <th style={{ padding: '6px 8px' }}>Zone</th>
                <th style={{ padding: '6px 8px' }}>Layout</th>
                <th style={{ padding: '6px 8px' }}>VIN</th>
                <th style={{ padding: '6px 8px' }}>Stored CRC</th>
                <th style={{ padding: '6px 8px' }}>Computed</th>
                <th style={{ padding: '6px 8px' }}>OK?</th>
              </tr>
            </thead>
            <tbody>
              {parsed.slots.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid ' + C.bd }}>
                  <td style={{ padding: '6px 8px' }}>{fmtOff(s.vinOffset)}</td>
                  <td style={{ padding: '6px 8px' }}>{s.zone}</td>
                  <td style={{ padding: '6px 8px' }}>{s.layout}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 800 }}>{s.vin}</td>
                  <td style={{ padding: '6px 8px' }}>{s.storedCrc.toString(16).toUpperCase().padStart(4, '0')}</td>
                  <td style={{ padding: '6px 8px' }}>{s.computedCrc.toString(16).toUpperCase().padStart(4, '0')}</td>
                  <td style={{ padding: '6px 8px', color: s.crcOk ? C.gn : C.er, fontWeight: 900 }}>
                    {s.crcOk ? '✓' : '✗'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {parsed && parsed.sec16 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 900, color: C.tx, marginBottom: 8 }}>
            SEC16 secret · main + mirrors
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 10 }}>
            Inactive bank base:{' '}
            {parsed.sec16.inactiveBase != null
              ? fmtOff(parsed.sec16.inactiveBase)
              : 'not resolved'} ·
            Resolver winner:{' '}
            {parsed.sec16.source
              ? <b style={{ color: parsed.sec16.blank ? C.wn : C.gn }}>
                  {parsed.sec16.source}{parsed.sec16.blank ? ' (blank)' : ''}
                </b>
              : 'none'}
          </div>
          {['split', 'mirror1', 'mirror2', 'flat'].map(key => {
            const c = parsed.sec16.candidates ? parsed.sec16.candidates[key] : null;
            return (
              <div key={key} data-testid={'sec16-row-' + key}
                style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid ' + C.bd }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 900, color: C.tx, minWidth: 70 }}>
                    {key.toUpperCase()}
                  </span>
                  {!c && <Tag color={C.tm}>not present</Tag>}
                  {c && c.blank && <Tag color={C.wn}>blank (FF / 00)</Tag>}
                  {c && !c.blank && <Tag color={C.gn}>populated</Tag>}
                  {c && c.offset != null && (
                    <span style={{ fontSize: 11, color: C.ts }}>at {fmtOff(c.offset)}</span>
                  )}
                  {key === 'split' && c && c.recordCount != null && (
                    <span style={{ fontSize: 11, color: c.consistent ? C.gn : C.er }}>
                      · {c.recordCount} record(s) · {c.consistent ? 'consistent' : 'inconsistent'}
                    </span>
                  )}
                </div>
                {c && (
                  <div style={{
                    fontFamily: "'JetBrains Mono'", fontSize: 11, padding: 8,
                    background: C.c2, borderRadius: 6, color: C.tx, wordBreak: 'break-all',
                  }}>{hexLine(c.bytes)}</div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {parsed && parsed.mode !== 'LOCKED' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 900, color: C.tx, marginBottom: 10 }}>
            Apply new VIN{parsed.mode === 'FULL' ? ' (and optional new SEC16)' : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 11, color: C.ts, fontWeight: 800 }}>
              NEW VIN (17 chars, A-HJ-NPR-Z0-9)
              <input
                type="text" maxLength={17}
                value={newVin}
                onChange={e => setNewVin(e.target.value.toUpperCase())}
                style={{
                  display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
                  fontFamily: "'JetBrains Mono'", fontSize: 14, fontWeight: 800,
                  border: '1.5px solid ' + (VIN_RE.test(newVin) ? C.gn : C.bd),
                  borderRadius: 8, color: C.tx, background: C.cd,
                }} />
            </label>
            <label style={{ fontSize: 11, color: C.ts, fontWeight: 800 }}>
              NEW SEC16 (32 hex chars, BCM display order — leave blank to keep existing)
              <input
                type="text"
                data-testid="new-sec16-input"
                value={newSec16}
                disabled={parsed.mode !== 'FULL'}
                title={parsed.mode === 'FULL'
                  ? 'Optional · only written when this field is non-empty'
                  : 'SEC16 writes are only allowed on FULL dumps. This dump is ' + parsed.mode + '.'}
                onChange={e => setNewSec16(e.target.value)}
                placeholder={parsed.mode === 'FULL'
                  ? 'optional · 00 11 22 ... or 00112233...'
                  : 'disabled — dump is ' + parsed.mode}
                style={{
                  display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
                  fontFamily: "'JetBrains Mono'", fontSize: 12,
                  border: '1.5px solid ' + C.bd, borderRadius: 8,
                  color: parsed.mode === 'FULL' ? C.tx : C.tm,
                  background: parsed.mode === 'FULL' ? C.cd : C.c2,
                  cursor: parsed.mode === 'FULL' ? 'text' : 'not-allowed',
                }} />
            </label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Btn onClick={doApply} disabled={!canApply}>
                Apply &amp; build patched file
              </Btn>
              {parsed.mode === 'VIN_ONLY' && (
                <span style={{ fontSize: 11, color: C.ts }}>
                  SEC16 is intentionally not writable on VIN-only dumps.
                </span>
              )}
            </div>
          </div>
        </Card>
      )}

      {applied && (
        <Card glow>
          <div style={{ fontSize: 14, fontWeight: 900, color: C.gn, marginBottom: 8 }}>
            ✓ Patch ready
          </div>
          <ul style={{ paddingLeft: 18, margin: '0 0 10px 0', fontSize: 12, color: C.tx }}>
            <li>New VIN: <b style={{ fontFamily: "'JetBrains Mono'" }}>{applied.result.newVin}</b></li>
            <li>VIN CRC-16/CCITT: <b style={{ fontFamily: "'JetBrains Mono'" }}>
              {applied.result.vinCrc.toString(16).toUpperCase().padStart(4, '0')}
            </b></li>
            <li>Rewrote {applied.result.updatedSlots.length} VIN slot(s):
              {' '}{applied.result.updatedSlots.map(s => fmtOff(s.vinOffset)).join(', ')}
            </li>
            {applied.result.sec16 && (
              <>
                <li>SEC16 split records patched: <b>{applied.result.sec16.splitPatched}</b></li>
                <li>SEC16 inactive-bank mirrors patched: <b>{applied.result.sec16.mirrorPatched}</b></li>
              </>
            )}
          </ul>
          <Btn onClick={downloadOut}>Download {applied.name}</Btn>
        </Card>
      )}
    </div>
  );
}
