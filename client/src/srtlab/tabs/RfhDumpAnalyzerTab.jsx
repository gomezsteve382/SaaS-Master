/**
 * RfhDumpAnalyzerTab.jsx
 * RF Hub Dump Analyzer — CB Master Premium v6 Stellantis 2025
 *
 * Features:
 *   - Paste hex dump or upload .bin file (4KB RFH EEPROM)
 *   - Auto-detect firmware variant: classic 2014-2018 vs 2019+ (FW 68363202xx)
 *   - Extract all 10 fields with correct LE→BE inversion where required
 *   - Transponder write sheet (Tango/KeyMaker format)
 *   - Mirror verification (S/N mirror, Crypto mirror)
 *   - EDC17 Sync Inversion tool (BCM 6B → PCM EDC17 inverted)
 *   - Sync Family reference panel
 *
 * Source: CB-MasterPremium-Stellantis2026-CB-2026-0094 (all 53 pages)
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { C, TC } from '../lib/constants.js';
import { Card, Tag, Btn, SLine } from '../lib/ui.jsx';
import {
  analyzeRfhDump,
  edc17SyncInvert,
  CB_SYNC_FAMILIES,
  RFH_DUMP_FIELD_MAP,
  TRANSPONDER_TYPE_MATRIX,
  CB_CHECKSUM_ALGOS,
  formatHex,
  parseHexString,
} from '../lib/udsEngine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtHex = (arr) => arr ? arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') : '—';
const fmtHexNoSpace = (arr) => arr ? arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('') : '—';

function parseHexInput(raw) {
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, '').replace(/0x/gi, '');
  if (!/^[0-9A-Fa-f]*$/.test(clean) || clean.length % 2 !== 0) return null;
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  return bytes;
}

// ─── Field Row ────────────────────────────────────────────────────────────────
function FieldRow({ label, raw, value, inverted, text, note, highlight }) {
  const [copied, setCopied] = useState(false);
  const displayValue = text ?? fmtHex(value);
  const copy = () => {
    navigator.clipboard.writeText(fmtHexNoSpace(value) || text || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 10,
      background: highlight ? C.a1 + '10' : C.c2,
      border: `1px solid ${highlight ? C.a1 + '40' : C.bd}`,
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</span>
            {inverted && <Tag color={C.a2}>LE→BE</Tag>}
            {text && <Tag color={C.a3}>ASCII</Tag>}
          </div>
          {raw && raw !== value && (
            <div style={{ fontSize: 10, color: C.tm, fontFamily: 'monospace', marginBottom: 2 }}>
              RAW: {fmtHex(raw)}
            </div>
          )}
          <div style={{ fontSize: 13, fontWeight: 700, color: C.bk, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {displayValue}
          </div>
          {note && <div style={{ fontSize: 10, color: C.ts, marginTop: 4 }}>{note}</div>}
        </div>
        <button
          onClick={copy}
          style={{
            padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: copied ? C.gn + '20' : C.bd, color: copied ? C.gn : C.ts,
            fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', transition: 'all 0.2s',
          }}
        >
          {copied ? '✓ COPIED' : 'COPY'}
        </button>
      </div>
    </div>
  );
}

// ─── Transponder Write Sheet ──────────────────────────────────────────────────
function TransponderSheet({ sheet }) {
  const [copied, setCopied] = useState(false);
  const lines = [
    `S/N:         ${fmtHex(sheet.sn)}`,
    `Crypto HIGH: ${fmtHex(sheet.cryptoHigh)}`,
    `Crypto LOW:  ${fmtHex(sheet.cryptoLow)}`,
    `Config:      ${fmtHex(sheet.config)}`,
    `PIN:         ${sheet.pin ?? '—'}`,
    `VIN:         ${sheet.vin ?? '—'}`,
  ].join('\n');

  return (
    <Card style={{ background: '#0D1117', border: `1.5px solid ${C.gn}40` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.gn, letterSpacing: 1 }}>
          🔑 TRANSPONDER WRITE SHEET
        </span>
        <button
          onClick={() => { navigator.clipboard.writeText(lines); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: copied ? C.gn + '30' : '#1E2A1E', color: copied ? C.gn : C.tm, fontSize: 10, fontWeight: 700 }}
        >
          {copied ? '✓ COPIED' : 'COPY ALL'}
        </button>
      </div>
      <pre style={{ fontSize: 12, color: '#E6EDF3', fontFamily: 'monospace', margin: 0, lineHeight: 1.8 }}>
        {lines}
      </pre>
      <div style={{ marginTop: 10, fontSize: 10, color: C.tm, borderTop: `1px solid #30363D`, paddingTop: 8 }}>
        {sheet.note}
      </div>
    </Card>
  );
}

// ─── EDC17 Sync Inversion Tool ────────────────────────────────────────────────
function Edc17InversionPanel() {
  const [bcmInput, setBcmInput] = useState('');
  const result = useMemo(() => {
    const bytes = parseHexInput(bcmInput);
    if (!bytes || bytes.length !== 6) return null;
    return edc17SyncInvert(bytes);
  }, [bcmInput]);

  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.a1, marginBottom: 12 }}>
        ↔ EDC17 SYNC INVERSION (6-4-2-5-3-1 RULE)
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 10 }}>
        Paste BCM 6-byte sync → get PCM EDC17 inverted bytes. Used for Fiat Toro Diésel 2.0 (Bosch EDC17C69).
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>BCM 6-byte sync (hex, space-separated)</div>
          <input
            value={bcmInput}
            onChange={e => setBcmInput(e.target.value)}
            placeholder="B4 47 3F 14 B2 1E"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.bd}`,
              background: C.c2, color: C.bk, fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ fontSize: 20, color: C.tm, alignSelf: 'flex-end', paddingBottom: 8 }}>→</div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>PCM EDC17 inverted bytes</div>
          <div style={{
            padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${result ? C.gn + '60' : C.bd}`,
            background: result ? C.gn + '08' : C.c2, fontFamily: 'monospace', fontSize: 13,
            color: result ? C.gn : C.tm, fontWeight: result ? 700 : 400, minHeight: 38,
          }}>
            {result ? fmtHex(result) : 'Enter 6 bytes above'}
          </div>
        </div>
      </div>
      {result && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.ts, background: C.c2, borderRadius: 8, padding: '8px 12px' }}>
          <strong>Rule:</strong> byte[5] byte[3] byte[1] byte[4] byte[2] byte[0] (1-indexed: 6-4-2-5-3-1)
          <br />
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {bcmInput.trim().split(/\s+/).map((b, i) => `[${i + 1}]${b}`).join(' ')} → {fmtHex(result)}
          </span>
        </div>
      )}
    </Card>
  );
}

// ─── Sync Family Reference ────────────────────────────────────────────────────
function SyncFamilyPanel() {
  const [expanded, setExpanded] = useState(null);
  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.a3, marginBottom: 12 }}>
        📚 SYNC FAMILY REFERENCE (CB MASTER PREMIUM v6)
      </div>
      {CB_SYNC_FAMILIES.map(fam => (
        <div key={fam.id} style={{ marginBottom: 12 }}>
          <div
            onClick={() => setExpanded(expanded === fam.id ? null : fam.id)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', borderRadius: 8, background: C.c2, cursor: 'pointer',
              border: `1px solid ${C.bd}`,
            }}
          >
            <div>
              <Tag color={C.a1}>{fam.label}</Tag>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.bk, marginLeft: 8 }}>{fam.name}</span>
              <span style={{ fontSize: 10, color: C.ts, marginLeft: 8 }}>{fam.models.length} model{fam.models.length !== 1 ? 's' : ''}</span>
            </div>
            <span style={{ fontSize: 12, color: C.tm }}>{expanded === fam.id ? '▲' : '▼'}</span>
          </div>
          {expanded === fam.id && (
            <div style={{ padding: '10px 0 0 0' }}>
              <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
                BCM: <strong>{fam.bcm}</strong> · Access: <strong>{fam.bcmAccess}</strong>
              </div>
              {fam.models.map(m => (
                <div key={m.id} style={{
                  padding: '10px 14px', borderRadius: 8, background: C.c2,
                  border: `1px solid ${C.bd}`, marginBottom: 6,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: C.bk }}>{m.name}</span>
                    <Tag color={C.a2}>{m.years}</Tag>
                    {m.readOnly && <Tag color={C.er}>READ ONLY</Tag>}
                    {m.transponder?.includes('AES') && <Tag color={C.wn}>HITAG AES</Tag>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 11 }}>
                    {m.bcmSyncOffset !== undefined && (
                      <div><span style={{ color: C.ts }}>BCM sync offset:</span> <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>0x{m.bcmSyncOffset.toString(16).toUpperCase()}</span></div>
                    )}
                    {m.bcmSyncMirror && (
                      <div><span style={{ color: C.ts }}>BCM mirror:</span> <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>0x{m.bcmSyncMirror.toString(16).toUpperCase()}</span></div>
                    )}
                    {m.rfhSyncOffset !== undefined && (
                      <div><span style={{ color: C.ts }}>RFH sync offset:</span> <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>0x{m.rfhSyncOffset.toString(16).toUpperCase()}</span></div>
                    )}
                    {m.pcmSyncOffset !== undefined && (
                      <div><span style={{ color: C.ts }}>PCM sync offset:</span> <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>0x{m.pcmSyncOffset.toString(16).toUpperCase()}</span></div>
                    )}
                    {m.checksumAlgo && (
                      <div><span style={{ color: C.ts }}>Checksum:</span> <span style={{ fontWeight: 700, color: C.a2 }}>{m.checksumAlgo}</span></div>
                    )}
                    {m.transponder && (
                      <div><span style={{ color: C.ts }}>Transponder:</span> <span style={{ fontWeight: 700, color: m.transponder.includes('AES') ? C.wn : C.a3 }}>{m.transponder}</span></div>
                    )}
                  </div>
                  {m.notes && (
                    <div style={{ marginTop: 6, fontSize: 10, color: C.ts, borderTop: `1px solid ${C.bd}`, paddingTop: 6 }}>
                      {m.notes}
                    </div>
                  )}
                  {m.exampleSync && (
                    <div style={{ marginTop: 4, fontSize: 10, color: C.a2, fontFamily: 'monospace' }}>
                      Example sync: {m.exampleSync}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

// ─── Transponder Matrix ───────────────────────────────────────────────────────
function TransponderMatrixPanel() {
  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.a4, marginBottom: 12 }}>
        🔐 TRANSPONDER TYPE MATRIX
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.bd}` }}>
              {['Model', 'Type', 'Crypto', 'Tool', 'Notes'].map(h => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: C.ts, fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TRANSPONDER_TYPE_MATRIX.map((row, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? C.c2 : C.cd }}>
                <td style={{ padding: '6px 10px', fontWeight: 600, color: C.bk }}>{row.model}</td>
                <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: row.type.includes('AES') ? C.wn : C.a3, fontWeight: 700 }}>{row.type}</td>
                <td style={{ padding: '6px 10px', fontFamily: 'monospace', color: C.ts }}>{row.crypto}</td>
                <td style={{ padding: '6px 10px', color: C.ts }}>{row.tool}</td>
                <td style={{ padding: '6px 10px', color: C.tm, fontSize: 10 }}>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────
const SUBTABS = [
  { id: 'analyzer', label: 'DUMP ANALYZER' },
  { id: 'edc17', label: 'EDC17 INVERSION' },
  { id: 'families', label: 'SYNC FAMILIES' },
  { id: 'transponders', label: 'TRANSPONDER MATRIX' },
];

export default function RfhDumpAnalyzerTab() {
  const [subtab, setSubtab] = useState('analyzer');
  const [hexInput, setHexInput] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const analyze = useCallback((bytes) => {
    if (!bytes || bytes.length < 512) {
      setError(`Dump too short: ${bytes?.length ?? 0} bytes (need ≥ 512)`);
      setResult(null);
      return;
    }
    const res = analyzeRfhDump(bytes);
    if (res.error) {
      setError(res.error);
      setResult(null);
    } else {
      setResult(res);
      setError('');
    }
  }, []);

  const handlePaste = useCallback(() => {
    const bytes = parseHexInput(hexInput);
    if (!bytes) {
      setError('Invalid hex input. Paste the raw hex dump (spaces optional).');
      setResult(null);
      return;
    }
    analyze(bytes);
  }, [hexInput, analyze]);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const ab = e.target.result;
      const bytes = Array.from(new Uint8Array(ab));
      setHexInput(bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));
      analyze(bytes);
    };
    reader.readAsArrayBuffer(file);
  }, [analyze]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div style={{ padding: 20, maxWidth: 960, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: C.bk, letterSpacing: 0.5 }}>
          RF HUB DUMP ANALYZER
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
          CB Master Premium v6 · Stellantis 2025 · 10-field extractor · Classic 2014-2018 &amp; 2019+ FW auto-detect
        </div>
      </div>

      {/* Subtab bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {SUBTABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubtab(t.id)}
            style={{
              padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: subtab === t.id ? C.a1 : C.c2,
              color: subtab === t.id ? '#fff' : C.ts,
              fontSize: 11, fontWeight: 800, letterSpacing: 0.5, transition: 'all 0.2s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* DUMP ANALYZER */}
      {subtab === 'analyzer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Input card */}
          <Card>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.a1, marginBottom: 12 }}>
              INPUT — PASTE HEX DUMP OR UPLOAD .BIN
            </div>

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? C.a1 : C.bd}`,
                borderRadius: 10, padding: '16px 20px', textAlign: 'center',
                cursor: 'pointer', marginBottom: 12, transition: 'all 0.2s',
                background: dragOver ? C.a1 + '08' : C.c2,
              }}
            >
              <div style={{ fontSize: 12, color: C.ts }}>
                Drop .bin file here or <span style={{ color: C.a1, fontWeight: 700 }}>click to browse</span>
              </div>
              <div style={{ fontSize: 10, color: C.tm, marginTop: 4 }}>
                Accepts 4KB RFH EEPROM dump (.bin) — auto-fills hex below
              </div>
              <input ref={fileRef} type="file" accept=".bin,.hex,.eep" style={{ display: 'none' }}
                onChange={e => handleFile(e.target.files[0])} />
            </div>

            <textarea
              value={hexInput}
              onChange={e => setHexInput(e.target.value)}
              placeholder="Paste hex dump here (e.g. 5A 5A 5A 5A 00 00 ... or continuous hex string)"
              rows={5}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8,
                border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk,
                fontFamily: 'monospace', fontSize: 12, resize: 'vertical', boxSizing: 'border-box',
              }}
            />
            {error && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: C.er + '10', color: C.er, fontSize: 12 }}>
                ✗ {error}
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
              <Btn onClick={handlePaste} color={C.a1}>ANALYZE DUMP</Btn>
              <Btn onClick={() => { setHexInput(''); setResult(null); setError(''); }} outline color={C.ts}>CLEAR</Btn>
            </div>
          </Card>

          {/* Results */}
          {result && (
            <>
              {/* Variant banner */}
              <Card style={{ background: result.isValidRfh ? C.gn + '08' : C.er + '08', border: `1.5px solid ${result.isValidRfh ? C.gn + '40' : C.er + '40'}` }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <span style={{ fontSize: 16, fontWeight: 900, color: result.isValidRfh ? C.gn : C.er }}>
                      {result.isValidRfh ? '✓ VALID RFH DUMP' : '⚠ INVALID SIGNATURE'}
                    </span>
                    <Tag color={result.variant === '2019+' ? C.a4 : C.a2}>
                      {result.variant === '2019+' ? 'FW 2019+ (68363202xx)' : 'Classic 2014-2018'}
                    </Tag>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
                    <span style={{ color: result.derived.snMirrorMatch ? C.gn : C.er }}>
                      {result.derived.snMirrorMatch ? '✓' : '✗'} S/N mirror
                    </span>
                    <span style={{ color: result.derived.cryptoMirrorMatch ? C.gn : C.er }}>
                      {result.derived.cryptoMirrorMatch ? '✓' : '✗'} Crypto mirror
                    </span>
                    {result.derived.vinText && (
                      <span style={{ color: C.a3, fontFamily: 'monospace', fontWeight: 700 }}>
                        VIN: {result.derived.vinText}
                      </span>
                    )}
                  </div>
                </div>
              </Card>

              {/* Fields grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, letterSpacing: 0.5 }}>PRIMARY FIELDS</div>
                  {result.fields.sn && (
                    <FieldRow label="S/N (Serial Number)" {...result.fields.sn}
                      note={result.map.sn.note} highlight />
                  )}
                  {result.fields.cryptoHigh && (
                    <FieldRow label="Crypto HIGH" {...result.fields.cryptoHigh}
                      note={result.map.cryptoHigh.note} highlight />
                  )}
                  {result.fields.cryptoLow && (
                    <FieldRow label="Crypto LOW" {...result.fields.cryptoLow}
                      note={result.map.cryptoLow.note} highlight />
                  )}
                  {result.fields.config && (
                    <FieldRow label="Config / TMCF" {...result.fields.config}
                      note={result.map.config.note} highlight />
                  )}
                  {result.fields.pin && (
                    <FieldRow
                      label={`PIN (customer: ${result.derived.pinDecimal ?? '—'})`}
                      {...result.fields.pin}
                      note={result.map.pin.note}
                      highlight
                    />
                  )}
                  {result.fields.vin && (
                    <FieldRow label="VIN" {...result.fields.vin} note={result.map.vin.note} />
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, letterSpacing: 0.5 }}>MIRROR / VERIFICATION FIELDS</div>
                  {result.fields.snMirror && (
                    <FieldRow label="S/N Mirror" {...result.fields.snMirror}
                      note={result.map.snMirror.note} />
                  )}
                  {result.fields.cryptoMirror && (
                    <FieldRow label="Crypto Mirror" {...result.fields.cryptoMirror}
                      note={result.map.cryptoMirror?.note} />
                  )}
                  {result.fields.configMirror && (
                    <FieldRow label="Config Mirror" {...result.fields.configMirror}
                      note={result.map.configMirror?.note} />
                  )}
                  {result.fields.sig && (
                    <FieldRow label="Signature (validity)" {...result.fields.sig}
                      note={result.map.signature.note} />
                  )}
                </div>
              </div>

              {/* Transponder write sheet */}
              <TransponderSheet sheet={result.transponderSheet} />
            </>
          )}
        </div>
      )}

      {/* EDC17 INVERSION */}
      {subtab === 'edc17' && <Edc17InversionPanel />}

      {/* SYNC FAMILIES */}
      {subtab === 'families' && <SyncFamilyPanel />}

      {/* TRANSPONDER MATRIX */}
      {subtab === 'transponders' && <TransponderMatrixPanel />}
    </div>
  );
}
