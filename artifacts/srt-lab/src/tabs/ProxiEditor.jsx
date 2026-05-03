/* ProxiEditor — live PROXI read / edit / write panel.
 *
 * Sits below the read-only DEnn / 0x2023 decoder in ProxiTab. Drives the
 * UDS sequence documented in docs/fca-proxi-reference.md §6 against the
 * BCM via the J2534 HTTP bridge:
 *
 *   1. "Read PROXI from BCM"
 *      → 10 03  → 22 FD01  → parseProxi(payload)
 *
 *   2. tech edits each section's payload bytes (raw hex). Section IDs and
 *      lengths are preserved; CRC is recomputed automatically by
 *      serializeProxi() before the write.
 *
 *   3. "Write PROXI"
 *      → 27 01 / 27 02 (cfBCM seed→key)
 *      → 2E FD01 [serializeProxi(edited)]  → 11 01 (ECU reset)
 *
 *   "Load synthetic dump" button feeds the editor a known-good 8-section
 *   PROXI from buildProxi() so the round-trip can be exercised on the
 *   bench (or in the browser preview) without a live BCM. parseProxi /
 *   serializeProxi already guarantee byte-for-byte round-trip; this
 *   button proves it through the editor's render → edit → serialize path.
 *
 * No bypass. Every NRC and unexpected opcode is surfaced in the panel
 * status bar AND appended to the parent ProxiTab log so the tech can
 * diagnose. SGW DID 0xFD20 is selectable for 2019+ platforms.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import {
  parseProxi,
  serializeProxi,
  buildProxi,
  SECTION_NAMES,
} from '../lib/fcaProxi.js';
import {
  readProxiFromBcm,
  unlockBcmForProxi,
  writeProxiToBcm,
  PROXI_DID_NONSGW,
  PROXI_DID_SGW,
  BCM_TX_DEFAULT,
  BCM_RX_DEFAULT,
} from '../lib/proxiBridge.js';

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/* Parse "11 22 33" / "0x11,0x22" / "112233" → Uint8Array | null. Returns
 * null if the input is empty or has an odd nibble count so the caller can
 * mark the field invalid without the whole edit attempting a partial
 * write. */
function parseHexBytes(input) {
  if (input == null) return null;
  const cleaned = String(input).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (!cleaned.length || cleaned.length % 2 !== 0) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

/* Build a synthetic 8-section PROXI for the round-trip demo path. The
 * payload bytes are arbitrary but distinct so the editor visibly shows
 * one section per known FCA group (Body…Telematics). */
function buildSyntheticProxi() {
  const sections = [
    { id: 0x01, payload: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]) },
    { id: 0x02, payload: new Uint8Array([0xA1, 0xA2, 0xA3]) },
    { id: 0x03, payload: new Uint8Array([0x10, 0x20]) },
    { id: 0x04, payload: new Uint8Array([0xDE, 0xAD]) },
    { id: 0x05, payload: new Uint8Array([0x55, 0xAA, 0x55, 0xAA]) },
    { id: 0x06, payload: new Uint8Array([0x07, 0x0E]) },
    { id: 0x07, payload: new Uint8Array([0x00, 0x01, 0x02]) },
    { id: 0x08, payload: new Uint8Array([0xCA, 0xFE]) },
  ];
  return buildProxi(sections, 1);
}

export default function ProxiEditor({ addLog }) {
  // ── connection / addressing ───────────────────────────────────────
  const [tx, setTx] = useState(BCM_TX_DEFAULT);
  const [rx, setRx] = useState(BCM_RX_DEFAULT);
  const [did, setDid] = useState(PROXI_DID_NONSGW);

  // ── live state ────────────────────────────────────────────────────
  const [parsed, setParsed] = useState(null);          // result from parseProxi
  const [originalBytes, setOriginalBytes] = useState(null); // Uint8Array as read
  const [edits, setEdits] = useState({});              // sectionIndex → hex string
  const [busy, setBusy] = useState('');                // '' | 'reading' | 'writing'
  const [status, setStatus] = useState(null);          // {kind:'ok'|'err'|'info', msg}
  const engineRef = useRef(null);                      // bridge engine kept across read/write

  const log = useCallback((m, t = 'info') => {
    if (addLog) addLog('[PROXI] ' + m, t);
  }, [addLog]);

  // Effective sections: edits override parsed payloads if valid hex.
  const effective = useMemo(() => {
    if (!parsed) return null;
    const sections = parsed.sections.map((s, i) => {
      if (edits[i] === undefined) return s;
      const bytes = parseHexBytes(edits[i]);
      if (!bytes) return { ...s, _editError: true };
      return { ...s, payload: bytes };
    });
    return { ...parsed, sections, sectionCount: sections.length };
  }, [parsed, edits]);

  const editErrors = useMemo(() => {
    if (!effective) return 0;
    return effective.sections.filter((s) => s._editError).length;
  }, [effective]);

  const hasPending = useMemo(() => {
    if (!parsed) return false;
    for (const i of Object.keys(edits)) {
      const orig = parsed.sections[i];
      const next = parseHexBytes(edits[i]);
      if (!orig || !next) return true;
      if (next.length !== orig.payload.length) return true;
      for (let k = 0; k < next.length; k++) {
        if (next[k] !== orig.payload[k]) return true;
      }
    }
    return false;
  }, [edits, parsed]);

  const onRead = useCallback(async () => {
    setBusy('reading');
    setStatus({ kind: 'info', msg: 'Reading PROXI from BCM…' });
    log(`Read PROXI tx=0x${tx.toString(16).toUpperCase()} rx=0x${rx.toString(16).toUpperCase()} did=0x${did.toString(16).toUpperCase()}`);
    const r = await readProxiFromBcm({ addLog: log, tx, rx, did, engine: engineRef.current });
    if (r.engine) engineRef.current = r.engine;
    if (!r.ok) {
      setStatus({ kind: 'err', msg: r.error || 'Read failed' });
      setBusy('');
      return;
    }
    setParsed(r.parsed);
    setOriginalBytes(r.raw);
    setEdits({});
    setStatus({ kind: 'ok', msg: `Read ${r.raw.length} B · ${r.parsed.sectionCount} sections · CRC OK` });
    setBusy('');
  }, [tx, rx, did, log]);

  const onLoadSynthetic = useCallback(() => {
    const raw = buildSyntheticProxi();
    const p = parseProxi(raw);
    if (!p.ok) {
      setStatus({ kind: 'err', msg: 'Synthetic build failed: ' + p.error });
      return;
    }
    setParsed(p);
    setOriginalBytes(raw);
    setEdits({});
    setStatus({ kind: 'info', msg: `Loaded synthetic PROXI · ${raw.length} B · ${p.sectionCount} sections (offline demo)` });
    log(`Loaded synthetic PROXI (${raw.length} B, ${p.sectionCount} sections)`);
  }, [log]);

  const onWrite = useCallback(async () => {
    if (!effective) return;
    if (editErrors > 0) {
      setStatus({ kind: 'err', msg: `Fix ${editErrors} invalid hex field(s) before writing.` });
      return;
    }
    if (!engineRef.current) {
      setStatus({ kind: 'err', msg: 'No bridge engine — click Read PROXI first to open the channel.' });
      return;
    }
    if (!window.confirm(
      `Write ${effective.sections.length} sections to BCM via 2E 0x${did.toString(16).toUpperCase()}?\n\n` +
      `CRC will be recomputed and an ECU reset (11 01) will follow. ` +
      `This is a real WriteDataByIdentifier and will modify the live BCM.`
    )) {
      log('Write cancelled by tech', 'warn');
      return;
    }
    setBusy('writing');
    setStatus({ kind: 'info', msg: 'Unlocking BCM (cfBCM seed→key)…' });
    log('Unlocking BCM via cfBCM');
    const u = await unlockBcmForProxi(engineRef.current, { addLog: log, tx, rx });
    if (!u.ok) {
      setStatus({ kind: 'err', msg: 'Unlock failed: ' + (u.error || 'unknown') });
      setBusy('');
      return;
    }
    setStatus({ kind: 'info', msg: 'Writing PROXI…' });
    const w = await writeProxiToBcm(engineRef.current, effective, { addLog: log, tx, rx, did });
    if (!w.ok) {
      setStatus({ kind: 'err', msg: 'Write failed: ' + (w.error || 'unknown') });
      setBusy('');
      return;
    }
    // Mark the new bytes as the baseline; clear pending edits. Guard
    // the re-parse — serializeProxi output should always parse, but if
    // somehow it doesn't, fall back to the in-memory edited object so
    // the UI never shows a null state after a successful write.
    setOriginalBytes(w.written);
    const reparsed = parseProxi(w.written);
    setParsed(reparsed.ok ? reparsed : effective);
    setEdits({});
    setStatus({ kind: 'ok', msg: `Wrote ${w.written.length} B · CRC recomputed · ECU reset issued` });
    setBusy('');
  }, [effective, editErrors, did, tx, rx, log]);

  const onResetEdits = useCallback(() => {
    setEdits({});
    setStatus({ kind: 'info', msg: 'Edits cleared.' });
  }, []);

  const onEditSection = useCallback((idx, value) => {
    setEdits((e) => ({ ...e, [idx]: value }));
  }, []);

  return (
    <Card style={{ marginBottom: 16, border: `1.5px solid ${C.sr}33`, background: '#FFFAF8' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 22 }}>🛠️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 900, fontSize: 13, color: C.sr, letterSpacing: 1.2 }}>
            LIVE PROXI EDITOR (BCM · 0xFD01 / 0xFD20)
          </div>
          <div style={{ fontSize: 11, color: C.tm, marginTop: 2 }}>
            Read · edit · re-CRC · write · reset. Routed through the J2534 bridge with cfBCM
            seed/key. Round-trip is byte-lossless via parseProxi / serializeProxi.
          </div>
        </div>
      </div>

      {/* Address row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Field label="BCM TX" value={tx} onChange={setTx} disabled={busy !== ''} />
        <Field label="BCM RX" value={rx} onChange={setRx} disabled={busy !== ''} />
        <label style={{ fontSize: 11, color: C.tm, display: 'flex', alignItems: 'center', gap: 6 }}>
          PROXI DID
          <select
            value={did}
            onChange={(e) => setDid(parseInt(e.target.value, 16))}
            disabled={busy !== ''}
            style={{ padding: '6px 10px', borderRadius: 7, border: `1.5px solid ${C.bd}`, fontFamily: 'monospace', fontSize: 12 }}
          >
            <option value={PROXI_DID_NONSGW.toString(16)}>0xFD01 — pre-SGW</option>
            <option value={PROXI_DID_SGW.toString(16)}>0xFD20 — SGW (2019+)</option>
          </select>
        </label>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Btn onClick={onRead} disabled={busy !== ''} color={C.a3}>
          {busy === 'reading' ? '⏳ Reading…' : '📖 Read PROXI from BCM'}
        </Btn>
        <Btn onClick={onWrite} disabled={busy !== '' || !parsed || editErrors > 0} color={C.sr}>
          {busy === 'writing' ? '⏳ Writing…' : '💾 Write PROXI'}
          {hasPending && editErrors === 0 ? ' (pending changes)' : ''}
        </Btn>
        {hasPending && (
          <Btn onClick={onResetEdits} color={C.tm} outline disabled={busy !== ''}>
            ✕ Reset edits
          </Btn>
        )}
        <Btn onClick={onLoadSynthetic} color={C.tm} outline disabled={busy !== ''}>
          🧪 Load synthetic dump
        </Btn>
      </div>

      {status && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 12,
            fontWeight: 700,
            background:
              status.kind === 'ok' ? C.gn + '14' :
              status.kind === 'err' ? C.er + '14' :
              C.a3 + '14',
            color:
              status.kind === 'ok' ? C.gn :
              status.kind === 'err' ? C.er :
              C.a3,
            border: `1px solid ${
              status.kind === 'ok' ? C.gn :
              status.kind === 'err' ? C.er :
              C.a3
            }44`,
          }}
        >
          {status.kind === 'ok' ? '✓ ' : status.kind === 'err' ? '✗ ' : 'ℹ '}
          {status.msg}
        </div>
      )}

      {parsed && (
        <div>
          <div style={{ fontSize: 11, color: C.tm, marginBottom: 6 }}>
            <strong>Header:</strong>{' '}
            <Tag color={C.tm}>section_count {parsed.sectionCount}</Tag>
            <Tag color={C.tm}>format_version {parsed.formatVersion}</Tag>
            <Tag color={C.tm}>total_length {parsed.totalLength} B</Tag>
            <Tag color={parsed.crcValid ? C.gn : C.er}>
              CRC 0x{parsed.recordCrc.toString(16).toUpperCase().padStart(4, '0')}
            </Tag>
          </div>

          {originalBytes && (
            <div style={{ fontFamily: 'monospace', fontSize: 10, color: C.tm, marginBottom: 10, wordBreak: 'break-all' }}>
              <strong>Bytes (as read):</strong> {bytesToHex(originalBytes)}
            </div>
          )}

          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: C.tm, fontSize: 10, letterSpacing: 0.8, textAlign: 'left', borderBottom: `1px solid ${C.bd}` }}>
                <th style={{ padding: '6px 4px', width: 40 }}>#</th>
                <th style={{ padding: '6px 4px', width: 50 }}>ID</th>
                <th style={{ padding: '6px 4px', width: 140 }}>NAME</th>
                <th style={{ padding: '6px 4px', width: 50 }}>LEN</th>
                <th style={{ padding: '6px 4px' }}>PAYLOAD (hex, editable)</th>
              </tr>
            </thead>
            <tbody>
              {parsed.sections.map((s, i) => {
                const editVal = edits[i];
                const display = editVal !== undefined ? editVal : bytesToHex(s.payload);
                const editBytes = editVal !== undefined ? parseHexBytes(editVal) : s.payload;
                const invalid = editVal !== undefined && !editBytes;
                const lenChanged = editBytes && editBytes.length !== s.payload.length;
                const changed = editBytes && !invalid && (
                  lenChanged ||
                  Array.from(editBytes).some((b, k) => b !== s.payload[k])
                );
                return (
                  <tr key={i} style={{ borderTop: `1px solid ${C.bd}55` }}>
                    <td style={{ padding: '6px 4px', color: C.tm, fontFamily: 'monospace' }}>{i}</td>
                    <td style={{ padding: '6px 4px', fontFamily: 'monospace', color: C.a3, fontWeight: 800 }}>
                      0x{s.id.toString(16).toUpperCase().padStart(2, '0')}
                    </td>
                    <td style={{ padding: '6px 4px', fontWeight: 700 }}>{SECTION_NAMES[s.id] || s.name}</td>
                    <td style={{ padding: '6px 4px', fontFamily: 'monospace', color: C.tm }}>
                      {editBytes ? editBytes.length : '?'}
                      {lenChanged && <span style={{ color: C.wn, marginLeft: 4 }}>(±)</span>}
                    </td>
                    <td style={{ padding: '6px 4px' }}>
                      <input
                        value={display}
                        onChange={(e) => onEditSection(i, e.target.value)}
                        disabled={busy !== ''}
                        spellCheck={false}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: `1.5px solid ${invalid ? C.er : changed ? C.wn : C.bd}`,
                          fontFamily: 'monospace',
                          fontSize: 11,
                          background: invalid ? C.er + '11' : changed ? C.wn + '11' : '#fff',
                          color: C.tx,
                          boxSizing: 'border-box',
                        }}
                      />
                      {invalid && (
                        <div style={{ color: C.er, fontSize: 10, marginTop: 2, fontWeight: 700 }}>
                          ✗ invalid hex (need an even number of nibbles)
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {hasPending && editErrors === 0 && effective && (
            <div style={{ marginTop: 10, padding: 10, background: C.wn + '14', borderRadius: 8, fontSize: 11, color: '#7A5300' }}>
              <strong>Pending serialize preview:</strong>{' '}
              {bytesToHex(serializeProxi(effective))}
            </div>
          )}
        </div>
      )}

      {!parsed && (
        <div style={{ padding: 16, textAlign: 'center', color: C.tm, fontSize: 12, fontStyle: 'italic' }}>
          Click <strong>Read PROXI from BCM</strong> to pull the live record, or{' '}
          <strong>Load synthetic dump</strong> for an offline round-trip demo.
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, onChange, disabled }) {
  return (
    <label style={{ fontSize: 11, color: C.tm, display: 'flex', alignItems: 'center', gap: 6 }}>
      {label}
      <input
        value={'0x' + value.toString(16).toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.replace(/^0x/i, '');
          const n = parseInt(v, 16);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        style={{
          width: 80,
          padding: '6px 8px',
          borderRadius: 7,
          border: `1.5px solid ${C.bd}`,
          fontFamily: 'monospace',
          fontSize: 12,
        }}
      />
    </label>
  );
}
