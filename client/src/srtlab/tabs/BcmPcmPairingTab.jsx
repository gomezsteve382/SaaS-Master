/* ============================================================================
 * BcmPcmPairingTab.jsx — BCM (MPC5606B) → PCM (GPEC2A) pairing workbench
 *
 * Two-file inspect + compare + apply flow:
 *   1. Load a full BCM flash (65 KB) and a PCM EEPROM dump (4 KB / 8 KB)
 *   2. Inspect both side-by-side (VINs, SEC16 / SEC6, IMMO, OS fields)
 *   3. Confirm the SEC6 derivation chain (BCM SEC16 reversed → first 6 bytes)
 *   4. APPLY to patch PCM with correct SEC6 + VIN, then DOWNLOAD
 *
 * All logic reuses existing lib primitives:
 *   - parseBcm          (twinBcmHelpers.js)
 *   - parsePCMGPEC      (rfhPcmPair.js)
 *   - applyRfhToPcm     (rfhPcmPair.js) — via a synthetic rfh adapter
 *   - moduleSizeBadge   (ModuleSync.jsx)
 *   - ProgrammerSizeHelp (components/ProgrammerSizeHelp.jsx)
 * ============================================================================ */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { parseBcm } from '../lib/twinBcmHelpers.js';
import { parsePCMGPEC, RFH_PCM_CONST } from '../lib/rfhPcmPair.js';
import { applyPcmFromBcm } from '../lib/bcmPcmSync.js';
import { fmtOff, moduleSizeBadge } from './ModuleSync.jsx';
import ProgrammerSizeHelp from '../components/ProgrammerSizeHelp.jsx';
import SamplePicker from '../lib/SamplePicker.jsx';
import { getBenchPairs, loadFixtureAsFile } from '../lib/sampleFixtures.js';

const { PCM_VIN_OFFSETS } = RFH_PCM_CONST;

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* ─── micro helpers ───────────────────────────────────────────────────────── */
function Badge({ ok, label }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 6,
      fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
      background: ok ? C.gn + '18' : C.er + '18',
      color: ok ? C.gn : C.er,
    }}>{label || (ok ? 'OK' : 'FAIL')}</span>
  );
}

function VerdictBadge({ verdict }) {
  const MAP = {
    COMPATIBLE: { color: C.gn, label: '✓ COMPATIBLE' },
    WARNING:    { color: C.wn, label: '⚠ WARNING' },
    LOCKED:     { color: C.er, label: '✗ LOCKED' },
  };
  const { color, label } = MAP[verdict] || { color: C.tm, label: verdict };
  return (
    <span style={{
      padding: '6px 14px', borderRadius: 10, fontSize: 13, fontWeight: 900,
      letterSpacing: 1, background: color + '18', color,
      border: '1.5px solid ' + color + '55',
    }}>{label}</span>
  );
}

function MonoHex({ hex, color = C.a3 }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color, letterSpacing: 0.3 }}>
      {hex}
    </span>
  );
}

function Row({ off, label, value, mono, color }) {
  return (
    <tr style={{ borderBottom: '1px solid ' + C.bd + '60' }}>
      <td style={{ padding: '6px 10px', fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a3, width: 80 }}>
        {off || '—'}
      </td>
      <td style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: C.tm, width: 150 }}>
        {label}
      </td>
      <td style={{
        padding: '6px 10px',
        fontFamily: mono ? "'JetBrains Mono'" : 'inherit',
        fontSize: 12, fontWeight: 700,
        color: color || C.tx, wordBreak: 'break-all',
      }}>{value}</td>
    </tr>
  );
}

function FileDropZone({ label, hint, onFile, fileName, accept = '.bin,.BIN,.eprom,.EPROM' }) {
  const inputRef = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onClick={() => inputRef.current.click()}
      style={{
        border: '2px dashed ' + (drag ? C.sr : C.sr + '40'), borderRadius: 12,
        padding: '18px 20px', cursor: 'pointer', textAlign: 'center',
        background: drag ? C.sr + '08' : C.c2, transition: 'all .2s',
      }}
    >
      <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 24, marginBottom: 4 }}>📂</div>
      {fileName
        ? <div style={{ fontSize: 12, fontWeight: 800, color: C.sr }}>{fileName}</div>
        : <div style={{ fontSize: 12, color: C.ts }}>{label}</div>}
      {hint && <div style={{ fontSize: 10, color: C.tm, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/* ─── BCM inspection panel ────────────────────────────────────────────────── */
function BcmPanel({ bcm }) {
  if (!bcm) {
    return (
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: C.sr, marginBottom: 8 }}>BCM (MPC5606B)</div>
        <div style={{ fontSize: 12, color: C.tm, padding: 20, textAlign: 'center' }}>Load a BCM full-flash (65 536 B)</div>
      </Card>
    );
  }

  const effRaw = bcm.sec16SourceRaw || bcm.sec16Copies[0]?.raw || [];
  const sec16Blank = effRaw.length === 0 || effRaw.every(b => b === 0xFF || b === 0x00);
  const bcmVin = bcm.vins[0]?.vin || '—';
  const vinOk = VIN_RE.test(bcmVin);

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 900, color: C.sr }}>BCM (MPC5606B)</span>
        <Tag color={C.tm}>{(bcm.size / 1024).toFixed(0)} KB</Tag>
        <Tag color={bcm.secMatch && bcm.secAllCsOk ? C.gn : C.wn}>
          {bcm.secMatch && bcm.secAllCsOk ? 'SEC16 OK ✓' : 'SEC16 warn'}
        </Tag>
        {sec16Blank && <Tag color={C.er}>SEC16 BLANK</Tag>}
      </div>

      {/* Primary VIN slots */}
      <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 1.2, marginBottom: 6, textTransform: 'uppercase' }}>
        VIN — 4 Primary Slots
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 12 }}>
        <thead>
          <tr>
            {['Slot', 'Offset', 'VIN', 'CS stored', 'CS calc', 'OK'].map(h => (
              <th key={h} style={{
                textAlign: 'left', padding: '4px 6px',
                borderBottom: '1.5px solid ' + C.bd,
                fontSize: 9, fontWeight: 800, color: C.tm, textTransform: 'uppercase', letterSpacing: 0.5,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bcm.vins.map(v => (
            <tr key={v.slot} style={{ borderBottom: '1px solid ' + C.bd + '60' }}>
              <td style={{ padding: '5px 6px', fontWeight: 800, color: C.sr }}>S{v.slot}</td>
              <td style={{ padding: '5px 6px', fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.a3 }}>{fmtOff(v.offset)}</td>
              <td style={{ padding: '5px 6px', fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: VIN_RE.test(v.vin) ? C.a1 : C.er }}>{v.vin}</td>
              <td style={{ padding: '5px 6px', fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts }}>
                {v.csStored.toString(16).toUpperCase().padStart(4, '0')}
              </td>
              <td style={{ padding: '5px 6px', fontFamily: "'JetBrains Mono'", fontSize: 10, color: v.csOk ? C.gn : C.er }}>
                {v.csCalc.toString(16).toUpperCase().padStart(4, '0')}
              </td>
              <td style={{ padding: '5px 6px' }}><Badge ok={v.csOk} label={v.csOk ? '✓' : '✗'} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mirror copies */}
      <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 1.2, marginBottom: 6, textTransform: 'uppercase' }}>
        SEC16 — {bcm.sec16Copies.length} Mirror Copies
      </div>
      {bcm.sec16Copies.map(m => (
        <div key={m.offset} style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8, background: C.c2, border: '1px solid ' + C.bd }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: C.tm }}>{m.label}</span>
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.a3 }}>{fmtOff(m.offset)}</span>
            <Badge ok={m.csOk} label={m.csOk ? 'CS OK' : 'CS FAIL'} />
            <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono'", color: C.tm }}>
              stored={m.csStored.toString(16).toUpperCase().padStart(4, '0')} calc={m.csCalc.toString(16).toUpperCase().padStart(4, '0')}
            </span>
          </div>
          <MonoHex hex={m.hex} color={C.a4} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <Badge ok={bcm.secMatch} label={'Mirrors match: ' + (bcm.secMatch ? 'YES' : 'NO')} />
        <Badge ok={bcm.secAllCsOk} label={'All CRC OK: ' + (bcm.secAllCsOk ? 'YES' : 'NO')} />
      </div>

      {/* SEC16 derivation chain */}
      <div style={{ padding: '10px 14px', borderRadius: 10, background: C.c2, border: '1px solid ' + C.bd }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
          SEC16 Derivation Chain
        </div>
        {bcm.sec16FromSplit && (
          <div data-testid="bcmpcm-split-fallback-note" style={{
            marginBottom: 8, padding: '6px 10px', borderRadius: 8,
            background: C.wn + '12', border: '1px solid ' + C.wn + '40',
            fontSize: 10, fontWeight: 700, color: C.wn, lineHeight: 1.45,
          }}>
            ⚠ Mirror copies @ 0x40C9 / 0x40F1 are blank — using split-record fallback{' '}
            <strong>{bcm.sec16Source}</strong> @ {fmtOff(bcm.sec16SourceOffset)}.
          </div>
        )}
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>
            BCM MAIN (stored format, {bcm.sec16Source} @ {fmtOff(bcm.sec16SourceOffset || 0x40C9)})
          </div>
          <MonoHex hex={bcm.sec16Hex} color={C.a4} />
        </div>
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>RFH-format view (byte-reversed)</div>
          <MonoHex hex={bcm.sec16RfhHex} color={C.a3} />
        </div>
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 8,
          background: sec16Blank ? C.er + '10' : C.gn + '0C',
          border: '1.5px solid ' + (sec16Blank ? C.er + '40' : C.gn + '30'),
        }}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.a2, marginBottom: 4, letterSpacing: 1 }}>
            PCM SEC6 DERIVED (first 6 B of RFH-view)
          </div>
          {sec16Blank
            ? <div style={{ color: C.er, fontSize: 11, fontWeight: 700 }}>✗ SEC16 is blank — cannot derive SEC6</div>
            : <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 14, fontWeight: 900, color: C.a2 }}>
                {bcm.pcmSec6Hex}
              </div>
          }
        </div>
      </div>
    </Card>
  );
}

/* ─── PCM inspection panel ────────────────────────────────────────────────── */
function PcmPanel({ pcm, pcmSizeBadge, pcmSizeNonCanonical }) {
  if (!pcm) {
    return (
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: C.a4, marginBottom: 8 }}>PCM (GPEC2A)</div>
        <div style={{ fontSize: 12, color: C.tm, padding: 20, textAlign: 'center' }}>Load a PCM EEPROM dump (4 KB / 8 KB)</div>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 900, color: C.a4 }}>PCM (GPEC2A)</span>
        <Tag color={C.tm}>{pcm.size} B</Tag>
        <Tag color={pcm.writeCheck.ok ? C.gn : C.er}>
          {pcm.writeCheck.ok ? 'writable ✓' : 'non-canonical size'}
        </Tag>
        {pcmSizeBadge && (
          <span data-testid="bcmpcm-pcm-size-badge"
                data-size-key={pcmSizeBadge.dataKey}
                data-size-canonical={pcmSizeBadge.canonical ? '1' : '0'}
                style={{
                  fontSize: 9, padding: '3px 8px', borderRadius: 6, letterSpacing: 0.6,
                  background: pcmSizeBadge.color, color: '#fff', fontWeight: 800,
                }}>
            {pcm.size.toLocaleString()} B · {pcmSizeBadge.label}
          </span>
        )}
      </div>

      {pcm.sizeWarn && (
        <div style={{ padding: '6px 10px', borderRadius: 8, background: C.wn + '15', color: C.wn, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
          ⚠ {pcm.sizeWarn}
        </div>
      )}

      {pcmSizeNonCanonical && (
        <div data-testid="bcmpcm-programmer-size-block" style={{
          padding: '10px 12px', borderRadius: 10, marginBottom: 10,
          background: C.er + '12', border: '1.5px solid ' + C.er + '66',
          color: C.er, fontSize: 11, fontWeight: 700, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.5, marginBottom: 4 }}>
            ⛔ Programmer says &quot;File different size&quot;?
          </div>
          <span style={{ color: C.tx, fontWeight: 600 }}>
            Loaded PCM is <strong>{pcm.size.toLocaleString()} B</strong> — not a canonical
            GPEC2A chip (must be exactly 4 KB / 95320 or 8 KB / 95640).
            APPLY and DOWNLOAD are blocked until the file matches the bench chip.
          </span>
        </div>
      )}

      {/* VIN slots */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 12 }}>
        <tbody>
          <Row off={fmtOff(0x0000)} label="VIN current"
               value={pcm.vinCurrent || '(invalid)'}
               mono color={pcm.vinCurrent ? C.gn : C.er} />
          <Row off={fmtOff(0x01F0)} label="VIN original"
               value={pcm.vinOriginal || '(invalid)'}
               mono color={pcm.vinOriginal ? C.a1 : C.er} />
          <Row off={fmtOff(0x0012)} label="Part Number"
               value={pcm.partNumber || '—'} mono color={C.a3} />
          <Row off={fmtOff(0x001C)} label="Serial"
               value={pcm.serial || '—'} mono color={C.a3} />
          <Row off={fmtOff(0x0011)} label="IMMO state"
               value={
                 <><span style={{ fontFamily: "'JetBrains Mono'", marginRight: 8 }}>{pcm.immo.hex}</span>
                   <Tag color={pcm.immo.state === 'ENABLED' ? C.gn : pcm.immo.state === 'IMMO_DAMAGED' ? C.er : C.wn}>
                     {pcm.immo.label}
                   </Tag>
                 </>
               } />
        </tbody>
      </table>

      {/* SECURITY card */}
      <div style={{ padding: '10px 14px', borderRadius: 10, background: C.c2, border: '1px solid ' + C.bd }}>
        <div style={{ fontSize: 10, fontWeight: 900, color: C.ts, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          PCM Security Section
        </div>
        {pcm.sec6 ? (
          <>
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>
                Marker @ {fmtOff(0x03C4)} (expect FF FF FF AA)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MonoHex hex={pcm.sec6.markerHex} color={pcm.sec6.markerOk ? C.gn : C.er} />
                <Badge ok={pcm.sec6.markerOk} label={pcm.sec6.markerOk ? 'MARKER OK' : 'MISSING'} />
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>SEC6 @ {fmtOff(0x03C8)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MonoHex hex={pcm.sec6.hex} color={pcm.sec6.populated ? C.a2 : C.tm} />
                {pcm.sec6.damaged && <Tag color={C.er}>DAMAGED / NOT PAIRED</Tag>}
                {pcm.sec6.blank && !pcm.sec6.damaged && <Tag color={C.wn}>BLANK</Tag>}
                {pcm.sec6.populated && !pcm.sec6.damaged && <Tag color={C.gn}>PAIRED ✓</Tag>}
              </div>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: C.tm }}>SEC6 section not reachable (file too small?)</div>
        )}
      </div>
    </Card>
  );
}

/* ─── Comparison + verdict ────────────────────────────────────────────────── */
export function computeVerdict(bcm, pcm) {
  if (!bcm || !pcm) {
    return { verdict: 'LOCKED', reason: 'Load both BCM and PCM files', canApply: false, issues: [], info: [] };
  }

  const issues = [];
  const info = [];

  const bcmVin = bcm.vins[0]?.vin || null;
  const bcmVinValid = bcmVin && VIN_RE.test(bcmVin);

  // Require at least one CRC-valid, non-blank BCM SEC16 mirror — mirrors the
  // RFH tab rule (rfhPcmPair.computeCompatibility / parseRFH24C32 sourceSlot
  // logic): a copy is only trusted when present + non-blank + csOk.
  // Blank detection must match securityBytes.js allBlank (all-FF or all-00).
  const validSec16Copy = bcm.sec16Copies.find(
    c => c.csOk && !c.raw.every(b => b === 0xFF || b === 0x00)
  );
  // Split-record fallback: when both mirrors are blank but the 0x81xx split
  // records carry a consistent non-blank SEC16, parseBcm exposes it as the
  // effective source — accept it so a re-paired virgin BCM still derives SEC6.
  const splitFallbackUsable = !validSec16Copy && !!bcm.sec16FromSplit;
  const effectiveSource = validSec16Copy
    ? { label: validSec16Copy.label, offset: validSec16Copy.offset }
    : (splitFallbackUsable ? { label: bcm.sec16Source, offset: bcm.sec16SourceOffset } : null);
  const sec16Blank = !effectiveSource;

  if (bcm.size !== 65536) issues.push('BCM file must be 65 536 B (full MPC5606B flash)');
  if (sec16Blank) {
    const allCsOk = bcm.sec16Copies.every(c => c.csOk);
    issues.push(
      allCsOk
        ? 'BCM SEC16 is blank (all-FF/00) — cannot derive SEC6'
        : 'BCM SEC16 has no CRC-valid copies — refusing to derive SEC6 from corrupted data'
    );
  }
  if (!bcmVinValid) issues.push('BCM primary VIN is missing or invalid');
  if (!pcm.writeCheck.ok) issues.push(pcm.writeCheck.reason || 'PCM is not writable (non-canonical size)');

  if (splitFallbackUsable) info.push(
    'BCM mirror copies @ 0x40C9 / 0x40F1 are blank — using split-record fallback ' +
    bcm.sec16Source + ' @ ' + fmtOff(bcm.sec16SourceOffset)
  );
  if (!bcm.secMatch && !splitFallbackUsable) info.push(
    'BCM SEC16 mirrors differ — using ' + (effectiveSource?.label || 'Mirror 1') +
    ' @ ' + fmtOff(effectiveSource?.offset || bcm.sec16Copies[0]?.offset || 0x40C9)
  );
  if (!bcm.secAllCsOk && !sec16Blank && !splitFallbackUsable) info.push('BCM SEC16: one or more mirrors have CRC errors (using best valid copy)');
  if (pcm.immo.state === 'IMMO_DAMAGED') info.push('PCM IMMO byte is IMMO_DAMAGED (all-FF). Enable "Repair IMMO byte" toggle to also fix 0x0011 → ENABLED on Apply.');

  const vinMatch = bcmVinValid && pcm.vinCurrent && bcmVin === pcm.vinCurrent;
  const sec6Match = bcm.pcmSec6Hex && pcm.sec6?.hex && bcm.pcmSec6Hex === pcm.sec6.hex;

  if (vinMatch) info.push('VIN already matches between BCM and PCM');
  if (sec6Match) info.push('SEC6 already matches — Apply will rewrite to confirm');

  const canApply = issues.length === 0;

  let verdict = 'LOCKED';
  let reason = '';
  if (canApply) {
    if (sec6Match && vinMatch) {
      verdict = 'COMPATIBLE';
      reason = 'Already paired — no write necessary, but Apply will rewrite to confirm';
    } else if (vinMatch || !pcm.vinCurrent) {
      verdict = 'COMPATIBLE';
      reason = 'BCM SEC16 valid, VIN matches/blank PCM — safe to apply';
    } else {
      verdict = 'WARNING';
      reason = 'BCM and PCM VINs differ — applying will overwrite PCM VIN slots with BCM VIN';
    }
  } else {
    verdict = 'LOCKED';
    reason = issues[0] || 'Cannot derive valid SEC6 + VIN from BCM';
  }

  return { verdict, reason, canApply, issues, info, vinMatch, sec6Match };
}

/* ─── Main tab component ──────────────────────────────────────────────────── */
export default function BcmPcmPairingTab() {
  const [bcmFile, setBcmFile] = useState(null);
  const [bcmBuf, setBcmBuf] = useState(null);
  const [bcm, setBcm] = useState(null);
  const [bcmErr, setBcmErr] = useState('');

  const [pcmFile, setPcmFile] = useState(null);
  const [pcmBuf, setPcmBuf] = useState(null);
  const [pcm, setPcm] = useState(null);
  const [pcmErr, setPcmErr] = useState('');

  const [patched, setPatched] = useState(null);
  const [applyLog, setApplyLog] = useState([]);
  const [msg, setMsg] = useState('');
  const [repairImmo, setRepairImmo] = useState(false);

  // Mirror RFHPCMTab: track the pair key of whichever sample was loaded last so
  // the sibling picker can surface a one-click "Load matching pair" button.
  const [samplePair, setSamplePair] = useState(null);
  const onSamplePairLoaded = useCallback(f => setSamplePair(f?.pair || null), []);

  const handleBcm = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      try {
        const d = new Uint8Array(ev.target.result);
        if (d.length !== 65536) {
          setBcmErr('BCM must be exactly 65 536 bytes (full MPC5606B flash). Got ' + d.length + ' B.');
          setBcm(null); setBcmBuf(null); setBcmFile(null);
          return;
        }
        const parsed = parseBcm(d, f.name);
        if (!parsed) {
          setBcmErr('parseBcm returned null — verify file is a valid 65 KB BCM dump.');
          setBcm(null); setBcmBuf(null); setBcmFile(null);
          return;
        }
        setBcmFile(f); setBcmBuf(d); setBcm(parsed); setBcmErr('');
        setPatched(null); setApplyLog([]); setMsg('');
      } catch (e) {
        setBcmErr('Parse error: ' + e.message);
        setBcm(null); setBcmBuf(null);
      }
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handlePcm = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      try {
        const d = new Uint8Array(ev.target.result);
        const parsed = parsePCMGPEC(d);
        setPcmFile(f); setPcmBuf(d); setPcm(parsed); setPcmErr('');
        setPatched(null); setApplyLog([]); setMsg('');
      } catch (e) {
        setPcmErr('Parse error: ' + e.message);
        setPcm(null); setPcmBuf(null);
      }
    };
    r.readAsArrayBuffer(f);
  }, []);

  // One-click bench set: pull BOTH halves (BCM + matching canonical PCM) of a
  // known pair in a single click. Eligible pairs are computed from the catalog
  // (must have a 65 KB BCM and a 4 KB/8 KB GPEC2A EXT). Reuses handleBcm /
  // handlePcm so parsing + verdict run exactly as for a manual load.
  const benchPairs = useMemo(() => getBenchPairs(), []);
  const [benchBusy, setBenchBusy] = useState(false);
  const [benchErr, setBenchErr] = useState('');

  const loadBenchSet = useCallback(async pairKey => {
    const entry = benchPairs.find(p => p.pair === pairKey);
    if (!entry) return;
    setBenchBusy(true); setBenchErr('');
    try {
      const [bcmF, pcmF] = await Promise.all([
        loadFixtureAsFile(entry.bcm.file),
        loadFixtureAsFile(entry.pcm.file),
      ]);
      handleBcm(bcmF);
      handlePcm(pcmF);
      setSamplePair(pairKey);
    } catch (ex) {
      setBenchErr(ex.message || String(ex));
    } finally {
      setBenchBusy(false);
    }
  }, [benchPairs, handleBcm, handlePcm]);

  const pcmSizeBadge = useMemo(() => (pcmBuf ? moduleSizeBadge('pcm', pcmBuf.length) : null), [pcmBuf]);
  const pcmSizeNonCanonical = !!(pcmSizeBadge && pcmSizeBadge.canonical === false);

  const verdict = useMemo(() => computeVerdict(bcm, pcm), [bcm, pcm]);

  const doApply = useCallback(() => {
    if (!verdict.canApply || pcmSizeNonCanonical || !bcm || !pcm || !pcmBuf) return;

    // Pick the SEC16 source — same priority as computeVerdict: first CRC-valid,
    // non-blank mirror, else the split-record fallback parseBcm resolved when
    // both mirrors are blank. If we reach here at least one exists.
    const validMirror = bcm.sec16Copies.find(
      c => c.csOk && !c.raw.every(b => b === 0xFF || b === 0x00)
    );
    const srcRaw = validMirror
      ? validMirror.raw
      : (bcm.sec16FromSplit ? bcm.sec16SourceRaw : null);
    const srcLabel = validMirror ? validMirror.label : bcm.sec16Source;
    if (!srcRaw) { setMsg('✗ No usable BCM SEC16 source found — cannot apply'); return; }

    // Route through the canonical BCM → PCM entrypoint (bcmPcmSync.applyPcmFromBcm).
    // applyPcmFromBcm handles the BCM byte-reversal internally and calls
    // writePcmSec6 to stamp the FF FF FF AA marker @ 0x3C4 + 6 secret bytes @ 0x3C8.
    const sec16Stored = new Uint8Array(srcRaw);
    const writeRes = applyPcmFromBcm(pcmBuf, sec16Stored);
    if (!writeRes.ok) {
      setPatched(null); setApplyLog([]);
      setMsg('✗ SEC6 write refused — non-canonical PCM size ' + pcmBuf.length + ' B (expected 4096 or 8192). No bytes were written.');
      return;
    }

    let out = writeRes.bytes;
    const log = [];
    log.push('PCM SEC6 @ 0x03C8 ← ' + bcm.pcmSec6Hex + ' (' + srcLabel + ' byte-reversed → first 6 B)');
    log.push('PCM SEC6 marker @ 0x03C4 ← FF FF FF AA (canonical Continental tag)');

    // VIN write — same slot list as rfhPcmPair.applyRfhToPcm (PCM_VIN_OFFSETS).
    const vin = bcm.vins[0]?.vin;
    if (vin && VIN_RE.test(vin)) {
      const enc = new TextEncoder().encode(vin);
      for (const off of PCM_VIN_OFFSETS) {
        if (off + 17 > out.length) {
          log.push('PCM VIN @ 0x' + off.toString(16).toUpperCase().padStart(4, '0') +
            ' SKIPPED — slot needs 17 B, buffer is only ' + out.length + ' B');
          continue;
        }
        for (let i = 0; i < 17; i++) out[off + i] = enc[i];
        log.push('PCM VIN @ 0x' + off.toString(16).toUpperCase().padStart(4, '0') + ' ← ' + vin);
      }
    } else {
      log.push('BCM VIN missing/invalid — VIN slots NOT written');
    }

    // Optional IMMO byte repair (only when IMMO_DAMAGED = all-FF @ 0x0011).
    if (repairImmo) {
      if (out.length < 0x0015) {
        log.push('IMMO repair SKIPPED — PCM buffer too small for 0x0011..0x0014');
      } else if (pcm.immo?.state === 'IMMO_DAMAGED') {
        out = new Uint8Array(out);
        out[0x0011] = 0x80; out[0x0012] = 0x00; out[0x0013] = 0x00; out[0x0014] = 0x00;
        log.push('PCM IMMO @ 0x0011 ← 80 00 00 00 (ENABLED) [was IMMO_DAMAGED all-FF]');
      } else {
        log.push('IMMO repair SKIPPED — PCM IMMO state is ' + (pcm.immo?.label || 'UNKNOWN') + ' (only repairs IMMO_DAMAGED)');
      }
    }

    setPatched(out);
    setApplyLog(log);
    setMsg('✓ Patched in memory — click DOWNLOAD to save');
  }, [verdict, pcmSizeNonCanonical, bcm, pcm, pcmBuf, repairImmo]);

  const doDownload = useCallback(() => {
    if (!patched || pcmSizeNonCanonical) return;
    const vin = (bcm?.vins[0]?.vin) || 'NOVIN';
    const base = (pcmFile?.name || 'pcm.bin').replace(/(\.[^.]+)?$/, '');
    const fn = base + '_BCM-PCM_' + vin + '.bin';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([patched], { type: 'application/octet-stream' }));
    a.download = fn; a.click(); URL.revokeObjectURL(a.href);
    setMsg('✓ Downloaded: ' + fn);
  }, [patched, pcmSizeNonCanonical, bcm, pcmFile]);

  const bcmVin = bcm?.vins[0]?.vin || null;
  const pcmVinCur = pcm?.vinCurrent || null;

  return (
    <div>
      {/* Header */}
      <Card glow style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <span style={{ fontSize: 32 }}>🔐</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1, fontFamily: "'Righteous'" }}>
              BCM → PCM PAIRING
            </div>
            <div style={{ fontSize: 11, color: C.ts, fontWeight: 700, letterSpacing: 1 }}>
              MPC5606B full-flash · GPEC2A EEPROM · derive SEC6 from BCM SEC16 · write to PCM
            </div>
          </div>
        </div>

        {benchPairs.length > 0 && (
          <div data-testid="bcmpcm-bench-set-loader" style={{
            marginBottom: 14, padding: '10px 12px', borderRadius: 10,
            background: C.c2, border: '1px dashed ' + C.bd,
          }}>
            <div style={{ fontSize: 10, fontWeight: 900, color: C.tm, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
              ⚡ One-click bench set — load BCM + matching PCM together{benchBusy ? ' · loading…' : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {benchPairs.map(p => (
                <button
                  key={p.pair}
                  type="button"
                  data-bench-set="1"
                  data-pair-key={p.pair}
                  onClick={() => loadBenchSet(p.pair)}
                  disabled={benchBusy}
                  title={`Loads ${p.bcm.file} + ${p.pcm.file}`}
                  style={{
                    padding: '8px 12px', borderRadius: 8,
                    border: '1.5px solid ' + C.sr + '60',
                    background: C.sr + '12', color: C.sr,
                    fontSize: 11, fontWeight: 800, letterSpacing: 0.3,
                    fontFamily: "'Nunito'", cursor: benchBusy ? 'wait' : 'pointer',
                    textAlign: 'left', lineHeight: 1.3,
                  }}>
                  🔗 Load BCM + PCM bench set: {p.bcm.vin || p.pair}
                  <div style={{ fontSize: 9, fontWeight: 600, color: C.tm, marginTop: 2 }}>
                    BCM {(p.bcm.size / 1024).toFixed(0)} KB + PCM {(p.pcm.size / 1024).toFixed(0)} KB · {p.pair}
                  </div>
                </button>
              ))}
            </div>
            {benchErr && <div style={{ marginTop: 6, fontSize: 10, color: C.er, fontWeight: 700 }}>✗ {benchErr}</div>}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 900, color: C.sr, letterSpacing: 2, marginBottom: 6 }}>
              BCM FULL FLASH (.bin)
            </div>
            <FileDropZone
              label="Drop BCM full-flash (65 536 B)"
              hint={`65 KB MPC5606B · VIN @ ${fmtOff(0x5328)} · SEC16 @ ${fmtOff(0x40C9)} / ${fmtOff(0x40F1)}`}
              onFile={handleBcm}
              fileName={bcmFile?.name}
              accept=".bin,.BIN"
            />
            <SamplePicker
              kinds={['BCM']}
              acceptSizes={[65536]}
              onFile={handleBcm}
              onLoaded={onSamplePairLoaded}
              suggestedPair={samplePair}
              label="📦 Sample BCM (paired with PCM)"
            />
            {bcmErr && (
              <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 8, background: C.er + '10', color: C.er, fontSize: 11, fontWeight: 700 }}>
                ✗ {bcmErr}
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 900, color: C.a4, letterSpacing: 2, marginBottom: 6 }}>
              PCM GPEC2A (.bin / .eprom)
            </div>
            <FileDropZone
              label="Drop PCM GPEC2/GPEC2A/GPEC3 dump (4096 or 8192 B)"
              hint={`VIN @ ${fmtOff(0x0000)} / ${fmtOff(0x01F0)} · SEC6 @ ${fmtOff(0x03C8)} · IMMO @ ${fmtOff(0x0011)}`}
              onFile={handlePcm}
              fileName={pcmFile?.name}
            />
            <SamplePicker
              kinds={['GPEC_EXT']}
              acceptSizes={[4096, 8192]}
              onFile={handlePcm}
              onLoaded={onSamplePairLoaded}
              suggestedPair={samplePair}
              label="📦 Sample PCM (pairs with BCM)"
            />
            {pcmErr && (
              <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 8, background: C.er + '10', color: C.er, fontSize: 11, fontWeight: 700 }}>
                ✗ {pcmErr}
              </div>
            )}
          </div>
        </div>

        <ProgrammerSizeHelp
          testId="bcmpcm-programmer-size-help"
          variant="accent"
          style={{ marginTop: 14, padding: '10px 12px' }}
          tail={<>APPLY and DOWNLOAD stay disabled until the PCM matches a canonical GPEC2A chip size.</>}
        />
      </Card>

      {/* Inspection panels */}
      {(bcm || pcm) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <BcmPanel bcm={bcm} />
          <PcmPanel pcm={pcm} pcmSizeBadge={pcmSizeBadge} pcmSizeNonCanonical={pcmSizeNonCanonical} />
        </div>
      )}

      {/* Comparison + apply */}
      {bcm && pcm && (
        <Card style={{ marginBottom: 14, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1.5 }}>COMPARISON</span>
            <VerdictBadge verdict={verdict.verdict} />
            <span style={{ fontSize: 11, color: C.ts, fontWeight: 700 }}>{verdict.reason}</span>
          </div>

          {verdict.issues.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {verdict.issues.map((m, i) => (
                <div key={i} style={{ fontSize: 12, color: C.er, padding: '3px 0' }}>✗ {m}</div>
              ))}
            </div>
          )}
          {verdict.info.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {verdict.info.map((m, i) => (
                <div key={i} style={{ fontSize: 12, color: C.ts, padding: '3px 0' }}>ℹ {m}</div>
              ))}
            </div>
          )}

          {/* Side-by-side comparison table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
            <thead>
              <tr>
                {['Field', 'BCM (source)', 'PCM (target)', 'Match'].map(h => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '6px 10px',
                    borderBottom: '1.5px solid ' + C.bd,
                    fontSize: 10, fontWeight: 800, color: C.tm, textTransform: 'uppercase', letterSpacing: 0.5,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid ' + C.bd + '60' }}>
                <td style={{ padding: '7px 10px', fontSize: 11, fontWeight: 700, color: C.tm }}>Primary VIN</td>
                <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a1 }}>{bcmVin || '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a4 }}>{pcmVinCur || '(blank)'}</td>
                <td style={{ padding: '7px 10px' }}><Badge ok={verdict.vinMatch} label={verdict.vinMatch ? 'MATCH' : 'MISMATCH'} /></td>
              </tr>
              <tr style={{ borderBottom: '1px solid ' + C.bd + '60' }}>
                <td style={{ padding: '7px 10px', fontSize: 11, fontWeight: 700, color: C.tm }}>SEC6</td>
                <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a2 }}>{bcm.pcmSec6Hex || '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a4 }}>{pcm.sec6?.hex || '—'}</td>
                <td style={{ padding: '7px 10px' }}><Badge ok={verdict.sec6Match} label={verdict.sec6Match ? 'MATCH' : 'DIFFERS'} /></td>
              </tr>
              <tr style={{ borderBottom: '1px solid ' + C.bd + '60' }}>
                <td style={{ padding: '7px 10px', fontSize: 11, fontWeight: 700, color: C.tm }}>PCM IMMO</td>
                <td style={{ padding: '7px 10px', fontSize: 11, color: C.tm }}>—</td>
                <td style={{ padding: '7px 10px' }}>
                  <Tag color={pcm.immo.state === 'ENABLED' ? C.gn : pcm.immo.state === 'IMMO_DAMAGED' ? C.er : C.wn}>
                    {pcm.immo.state}
                  </Tag>
                </td>
                <td style={{ padding: '7px 10px' }}><Badge ok={pcm.immo.state === 'ENABLED'} label={pcm.immo.state === 'ENABLED' ? 'OK' : 'REPAIR'} /></td>
              </tr>
            </tbody>
          </table>

          {/* IMMO repair toggle */}
          <div style={{ padding: '10px 12px', borderRadius: 10, background: C.c2, border: '1px solid ' + C.bd, marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={repairImmo} onChange={e => setRepairImmo(e.target.checked)}
                     style={{ marginTop: 3, width: 16, height: 16, accentColor: C.a2, cursor: 'pointer' }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 900, color: repairImmo ? C.a2 : C.tx, letterSpacing: 0.5 }}>
                  Repair PCM IMMO byte @ {fmtOff(0x0011)} → ENABLED (80 00 00 00)
                </div>
                <div style={{ fontSize: 10, color: C.tm, fontWeight: 600, marginTop: 2, lineHeight: 1.4 }}>
                  Only writes when the PCM IMMO state is IMMO_DAMAGED (all-FF). Other states are left untouched.
                  {pcm.immo && (
                    <> Current: <span style={{ color: pcm.immo.state === 'IMMO_DAMAGED' ? C.er : pcm.immo.state === 'ENABLED' ? C.gn : C.wn, fontWeight: 800 }}>
                      {pcm.immo.label}
                    </span></>
                  )}
                </div>
              </div>
            </label>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Btn onClick={doApply} disabled={!verdict.canApply || pcmSizeNonCanonical} color={C.a2}>
              ⚡ APPLY — Patch PCM in memory
            </Btn>
            <Btn onClick={doDownload} disabled={!patched || pcmSizeNonCanonical} color={C.sr}>
              💾 DOWNLOAD patched PCM
            </Btn>
          </div>

          {/* Apply log */}
          {applyLog.length > 0 && (
            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 10, background: C.c2, border: '1px solid ' + C.bd }}>
              <div style={{ fontSize: 10, fontWeight: 900, color: C.a2, letterSpacing: 1.5, marginBottom: 6 }}>APPLY LOG</div>
              {applyLog.map((m, i) => (
                <div key={i} style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts, padding: '2px 0' }}>• {m}</div>
              ))}
            </div>
          )}

          {msg && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: msg.startsWith('✓') ? C.gn + '10' : C.er + '10',
              border: '1px solid ' + (msg.startsWith('✓') ? C.gn + '25' : C.er + '25'),
              fontSize: 11, fontWeight: 700,
              color: msg.startsWith('✓') ? C.gn : C.er,
            }}>{msg}</div>
          )}
        </Card>
      )}
    </div>
  );
}
