/* ============================================================================
 * PairingRepairPanel.jsx — Full 3-Module Security Byte Pairing Repair (Task #1052)
 *
 * Full-screen modal overlay that handles all BCM + RFHUB + ECM pairing
 * combinations, including the hardest case: all three modules broken with no
 * natural donor. Workflow:
 *   1. Triage — shows each module's SEC16/SEC6 state + provenance
 *   2. Donor Picker — BCM / RFHUB / Generate Fresh (user explicitly chooses)
 *   3. Patch Preview — before/after hex for each module
 *   4. Apply + Cross-validate — runs writers + crossValidate on result
 *   5. Download — individual .bin files + ZIP (gated behind green validation)
 *
 * Props (all optional):
 *   bcmBytes, bcmFilename   — pre-loaded BCM bytes from Module Sync
 *   rfhubBytes, rfhubFilename
 *   pcmBytes, pcmFilename
 *   onClose  () => void
 * ========================================================================== */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { triageModuleSet } from '../lib/pairingRepair.js';
import { crossValidate } from '../lib/crossValidate.js';
import { parseModule } from '../lib/parseModule.js';
import {
  generateSec16,
  deriveAllFromSec16,
  writeBcmSec16Gen2,
  writeRfhSec16FromBcm,
  writeRfhSec16Gen1,
  writeRfhSec16Gen2Slots,
  writeXc2268Sec16,
  writePcmSec6,
} from '../lib/securityBytes.js';

/* ── Design tokens (light palette matching ModuleSync) ─────────────────── */
const C = {
  bg:   '#F4F1EC',
  surf: '#FFFFFF',
  s2:   '#FAF9F7',
  s3:   '#F0EDE8',
  bd:   '#E8E4DE',
  sr:   '#D32F2F',
  bk:   '#1A1A1A',
  tx:   '#1A1A1A',
  ts:   '#5A5A5A',
  tm:   '#9E9E9E',
  a1:   '#FF6D00',
  a2:   '#00BFA5',
  a3:   '#2979FF',
  a4:   '#AA00FF',
  gn:   '#00C853',
  wn:   '#FFB300',
  er:   '#FF1744',
  mono: "'JetBrains Mono','Consolas',monospace",
  sans: "'Nunito',system-ui,sans-serif",
};

/* ── Helpers ────────────────────────────────────────────────────────────── */
function fmtHex(arr) {
  if (!arr || arr.length === 0) return '';
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function fmtHexCompact(arr) {
  if (!arr || arr.length === 0) return '';
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function downloadBlob(data, filename, mime = 'application/octet-stream') {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function stateColor(state) {
  if (state === 'trusted') return C.gn;
  if (state === 'blank' || state === 'absent') return C.wn;
  if (state === 'damaged') return C.er;
  return C.tm;
}

function stateLabel(state) {
  if (state === 'trusted') return '✓ Trusted';
  if (state === 'blank') return '— Blank';
  if (state === 'absent') return '— Absent';
  if (state === 'damaged') return '✗ Damaged';
  return state;
}

/* ── Simple drop zone ────────────────────────────────────────────────────── */
function DropZone({ label, hint, onFile, file, accent = C.a3 }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = useCallback((files) => {
    const f = files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target.result);
      onFile(f, bytes);
    };
    reader.readAsArrayBuffer(f);
  }, [onFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = (e) => { e.preventDefault(); setOver(true); };
  const onDragLeave = () => setOver(false);

  return (
    <div
      onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${over ? accent : C.bd}`,
        borderRadius: 10, padding: '12px 14px', cursor: 'pointer',
        background: over ? accent + '0A' : file ? C.gn + '0A' : C.s2,
        transition: 'all 0.15s', textAlign: 'center',
        minWidth: 0,
      }}>
      <input ref={inputRef} type="file" accept=".bin,.rom,.eep"
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)} />
      <div style={{ fontWeight: 800, fontSize: 12, color: file ? C.gn : accent, marginBottom: 2 }}>
        {label}
      </div>
      {file ? (
        <div style={{ fontFamily: C.mono, fontSize: 9, color: C.ts, wordBreak: 'break-all' }}>
          {file.name} ({file.size?.toLocaleString()} B)
        </div>
      ) : (
        <div style={{ fontSize: 10, color: C.tm }}>{hint}</div>
      )}
    </div>
  );
}

/* ── HexBlock: before/after byte display ─────────────────────────────────── */
function HexBlock({ label, before, after, changed = false }) {
  const b = before ? fmtHex(before).split(' ') : [];
  const a = after  ? fmtHex(after ).split(' ') : [];
  const len = Math.max(b.length, a.length);
  const diffs = Array.from({ length: len }, (_, i) => b[i] !== a[i]);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[{ title: 'Before', arr: b }, { title: 'After', arr: a }].map(({ title, arr }, si) => (
          <div key={si}>
            <div style={{ fontSize: 9, fontWeight: 700, color: si === 0 ? C.er : C.gn, marginBottom: 2 }}>
              {title}
            </div>
            <div style={{ fontFamily: C.mono, fontSize: 9, lineHeight: 1.9, wordBreak: 'break-all' }}>
              {arr.map((byte, i) => (
                <span key={i} style={{
                  color: diffs[i] ? (si === 0 ? C.er : C.gn) : C.ts,
                  background: diffs[i] ? (si === 0 ? C.er : C.gn) + '1A' : 'transparent',
                  borderRadius: 2, padding: '0 1px',
                  fontWeight: diffs[i] ? 800 : 400,
                }}>
                  {byte}{' '}
                </span>
              ))}
              {arr.length === 0 && <span style={{ color: C.tm }}>—</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── State badge chip ───────────────────────────────────────────────────── */
function StateBadge({ state }) {
  const color = stateColor(state);
  return (
    <span style={{
      display: 'inline-block', fontSize: 9, fontWeight: 800,
      padding: '2px 7px', borderRadius: 10,
      background: color + '20', color, border: `1px solid ${color}50`,
      letterSpacing: 0.5, textTransform: 'uppercase',
    }}>
      {stateLabel(state)}
    </span>
  );
}

/* ── Triage card for a single module ────────────────────────────────────── */
function TriageCard({ icon, label, report, accent = C.a3 }) {
  const color = stateColor(report.state);
  return (
    <div style={{
      background: C.surf, border: `1.5px solid ${color}55`,
      borderRadius: 12, padding: '14px 16px', flex: '1 1 220px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontWeight: 900, fontSize: 13, color: C.tx }}>{label}</span>
        <span style={{ marginLeft: 'auto' }}>
          <StateBadge state={report.state} />
        </span>
      </div>
      <div style={{ fontSize: 10, color: C.ts, marginBottom: 6 }}>{report.provenance}</div>
      {report.sec16Bytes && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.tm, marginBottom: 2 }}>SEC16 ({report.sec16Bytes.length} B)</div>
          <div style={{ fontFamily: C.mono, fontSize: 9, color: C.bk, wordBreak: 'break-all', background: C.s2, borderRadius: 6, padding: '4px 6px' }}>
            {fmtHex(report.sec16Bytes)}
          </div>
        </div>
      )}
      {report.sec6Bytes && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.tm, marginBottom: 2 }}>SEC6 @ 0x3C8</div>
          <div style={{ fontFamily: C.mono, fontSize: 9, color: C.bk, wordBreak: 'break-all', background: C.s2, borderRadius: 6, padding: '4px 6px' }}>
            {report.sec6Hex}
            <span style={{ color: report.markerOk ? C.gn : C.er, marginLeft: 8, fontWeight: 800 }}>
              {report.markerOk ? '● Marker OK' : `✗ Marker: ${report.markerHex}`}
            </span>
          </div>
        </div>
      )}
      {!report.loaded && (
        <div style={{ fontSize: 10, color: C.wn, fontStyle: 'italic' }}>No file loaded</div>
      )}
    </div>
  );
}

/* ── Donor option card ──────────────────────────────────────────────────── */
function DonorCard({ id, icon, title, subtitle, bytes, disabled, selected, onSelect }) {
  return (
    <button
      disabled={disabled}
      onClick={() => !disabled && onSelect(id)}
      data-testid={`donor-card-${id}`}
      style={{
        flex: '1 1 180px', border: `2px solid ${selected ? C.sr : disabled ? C.bd : C.bd}`,
        borderRadius: 12, padding: '14px 16px', background: selected ? C.sr + '12' : C.surf,
        cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
        opacity: disabled ? 0.45 : 1, transition: 'all 0.15s',
        fontFamily: C.sans,
      }}>
      <div style={{ fontSize: 18, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontWeight: 900, fontSize: 12, color: selected ? C.sr : C.tx, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 10, color: C.ts, marginBottom: bytes ? 8 : 0 }}>{subtitle}</div>
      {bytes && (
        <div style={{ fontFamily: C.mono, fontSize: 8, color: C.ts, wordBreak: 'break-all', background: C.s2, borderRadius: 4, padding: '3px 5px' }}>
          {fmtHex(bytes.slice(0, 8))}…
        </div>
      )}
    </button>
  );
}

/* ── Cross-validate result display ──────────────────────────────────────── */
function ValidationPanel({ result }) {
  if (!result) return null;
  const allGreen = result.issues.length === 0;
  return (
    <div style={{
      border: `1.5px solid ${allGreen ? C.gn : C.er}`,
      borderRadius: 10, padding: '12px 14px', background: (allGreen ? C.gn : C.er) + '0A',
    }}>
      <div style={{ fontWeight: 900, fontSize: 12, color: allGreen ? C.gn : C.er, marginBottom: 6 }}>
        {allGreen ? '✓ All modules paired — cross-validation passed' : '✗ Cross-validation failed'}
      </div>
      {result.issues.map((iss, i) => (
        <div key={i} style={{ fontSize: 10, color: C.er, marginBottom: 2 }}>● {iss}</div>
      ))}
      {result.warnings.map((w, i) => (
        <div key={i} style={{ fontSize: 10, color: C.wn, marginBottom: 2 }}>⚠ {w}</div>
      ))}
      {result.passed.map((p, i) => (
        <div key={i} style={{ fontSize: 10, color: C.gn, marginBottom: 2 }}>✓ {p}</div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Main component
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function PairingRepairPanel({
  bcmBytes: bcmBytesProp,
  bcmFilename: bcmFilenameProp,
  rfhubBytes: rfhubBytesProp,
  rfhubFilename: rfhubFilenameProp,
  pcmBytes: pcmBytesProp,
  pcmFilename: pcmFilenameProp,
  onClose,
  onPatchComplete,
}) {
  /* ── Internal file state (overrides props when locally loaded) ── */
  const [bcmLocal,   setBcmLocal]   = useState(null);   /* { file, bytes } */
  const [rfhubLocal, setRfhubLocal] = useState(null);
  const [pcmLocal,   setPcmLocal]   = useState(null);

  const bcmBytes   = bcmLocal?.bytes   || bcmBytesProp   || null;
  const rfhubBytes = rfhubLocal?.bytes || rfhubBytesProp || null;
  const pcmBytes   = pcmLocal?.bytes   || pcmBytesProp   || null;
  const bcmFile    = bcmLocal?.file    || (bcmBytesProp   ? { name: bcmFilenameProp   || 'bcm.bin',   size: bcmBytesProp.length   } : null);
  const rfhubFile  = rfhubLocal?.file  || (rfhubBytesProp ? { name: rfhubFilenameProp || 'rfhub.bin', size: rfhubBytesProp.length } : null);
  const pcmFile    = pcmLocal?.file    || (pcmBytesProp   ? { name: pcmFilenameProp   || 'pcm.bin',   size: pcmBytesProp.length   } : null);

  /* ── Flow state ── */
  const [donorChoice, setDonorChoice] = useState(null); /* 'bcm' | 'rfhub' | 'generate' */
  const [applied, setApplied] = useState(null);         /* result of applying patches */
  const [step, setStep] = useState(1);                  /* 1=triage, 2=donor, 3=preview, 4=result */

  /* ── Triage ── */
  const triage = useMemo(() => triageModuleSet({
    bcm: bcmBytes, rfhub: rfhubBytes, pcm: pcmBytes,
  }), [bcmBytes, rfhubBytes, pcmBytes]);

  /* ── Derive the rfhubSec16 for the chosen donor ── */
  const candidateRfhubSec16 = useMemo(() => {
    if (donorChoice === 'bcm' && triage.bcm.sec16Bytes) {
      const rev = new Uint8Array(16);
      for (let i = 0; i < 16; i++) rev[i] = triage.bcm.sec16Bytes[15 - i];
      return rev;
    }
    if (donorChoice === 'rfhub' && triage.rfhub.sec16Bytes) {
      return new Uint8Array(triage.rfhub.sec16Bytes);
    }
    if (donorChoice === 'generate') {
      return null; /* generated lazily on Apply */
    }
    return null;
  }, [donorChoice, triage]);

  /* For preview we need a stable generated secret */
  const [generatedSecret, setGeneratedSecret] = useState(null);
  const previewRfhubSec16 = donorChoice === 'generate'
    ? (generatedSecret || null)
    : candidateRfhubSec16;

  /* ── Derive preview secrets ── */
  const previewSecrets = useMemo(() => {
    if (!previewRfhubSec16) return null;
    try { return deriveAllFromSec16(previewRfhubSec16); } catch { return null; }
  }, [previewRfhubSec16]);

  /* ── VIN extraction for filenames ── */
  const vin = useMemo(() => {
    if (bcmBytes) {
      try {
        const p = parseModule(bcmBytes, bcmFile?.name || 'bcm.bin');
        if (p?.vins?.[0]?.vin) return p.vins[0].vin;
        if (p?.vin) return p.vin;
      } catch {}
    }
    if (rfhubBytes) {
      try {
        const p = parseModule(rfhubBytes, rfhubFile?.name || 'rfhub.bin');
        if (p?.vins?.[0]?.vin) return p.vins[0].vin;
        if (p?.vin) return p.vin;
      } catch {}
    }
    if (pcmBytes) {
      try {
        const p = parseModule(pcmBytes, pcmFile?.name || 'pcm.bin');
        if (p?.vins?.[0]?.vin) return p.vins[0].vin;
        if (p?.vin) return p.vin;
      } catch {}
    }
    return 'UNKNOWN_VIN';
  }, [bcmBytes, rfhubBytes, pcmBytes, bcmFile, rfhubFile, pcmFile]);

  /* ── Donor picker availability ── */
  const canUseBcm   = triage.bcm.state   === 'trusted';
  const canUseRfhub = triage.rfhub.state === 'trusted';

  /* ── Apply patches ── */
  const handleApply = useCallback(() => {
    let rfhubSec16;
    if (donorChoice === 'generate') {
      rfhubSec16 = generatedSecret || generateSec16();
      setGeneratedSecret(rfhubSec16);
    } else if (previewRfhubSec16) {
      rfhubSec16 = previewRfhubSec16;
    } else {
      setApplied({ ok: false, error: 'No valid donor secret available.' });
      setStep(4);
      return;
    }

    let secrets;
    try {
      secrets = deriveAllFromSec16(rfhubSec16);
    } catch (e) {
      setApplied({ ok: false, error: e.message });
      setStep(4);
      return;
    }

    const patchedBuffers = {};
    const errors = [];

    /* BCM */
    if (bcmBytes) {
      try {
        const res = writeBcmSec16Gen2(bcmBytes, rfhubSec16);
        patchedBuffers.bcm = res.bytes;
      } catch (e) {
        errors.push('BCM: ' + e.message);
      }
    }

    /* RFHUB — Gen2, Gen1, and XC2268 (2019+ internal flash) all supported */
    if (rfhubBytes) {
      try {
        if (triage.rfhub.rfhFormat === 'gen2') {
          const res = writeRfhSec16FromBcm(rfhubBytes, secrets.bcmSec16);
          patchedBuffers.rfhub = res.bytes;
        } else if (triage.rfhub.rfhFormat === 'gen2-hybrid') {
          // gen2-hybrid: 4 KB file with empty Gen2 slots and no AA-55-31-01 banner
          const res = writeRfhSec16Gen2Slots(rfhubBytes, secrets.bcmSec16);
          patchedBuffers.rfhub = res.bytes;
        } else if (triage.rfhub.rfhFormat === 'gen1') {
          const res = writeRfhSec16Gen1(rfhubBytes, secrets.bcmSec16);
          patchedBuffers.rfhub = res.bytes;
        } else if (triage.rfhub.rfhFormat === 'xc2268') {
          const res = writeXc2268Sec16(rfhubBytes, secrets.bcmSec16);
          patchedBuffers.rfhub = res.bytes;
        } else {
          errors.push(`RFHUB: Unknown format (${triage.rfhub.rfhFormat || 'undetected'}) — cannot write SEC16 offline`);
        }
      } catch (e) {
        errors.push('RFHUB: ' + e.message);
      }
    }

    /* PCM (ECM) */
    if (pcmBytes) {
      try {
        const res = writePcmSec6(pcmBytes, rfhubSec16);
        if (!res.ok) errors.push('PCM: writePcmSec6 refused — ' + (res.reason || 'non-canonical size'));
        else patchedBuffers.pcm = res.bytes;
      } catch (e) {
        errors.push('PCM: ' + e.message);
      }
    }

    if (errors.length > 0 && Object.keys(patchedBuffers).length === 0) {
      setApplied({ ok: false, error: errors.join('; '), patchedBuffers: {}, rfhubSec16, secrets });
      setStep(4);
      return;
    }

    /* Cross-validate */
    const modulesForValidate = [];
    if (patchedBuffers.bcm) {
      try { modulesForValidate.push(parseModule(patchedBuffers.bcm, 'BCM_patched.bin')); } catch {}
    }
    if (patchedBuffers.rfhub) {
      try { modulesForValidate.push(parseModule(patchedBuffers.rfhub, 'RFHUB_patched.bin')); } catch {}
    }
    if (patchedBuffers.pcm) {
      try { modulesForValidate.push(parseModule(patchedBuffers.pcm, 'PCM_patched.bin')); } catch {}
    }

    let validation = null;
    if (modulesForValidate.length > 0) {
      try { validation = crossValidate(modulesForValidate); } catch (e) {
        validation = { issues: ['crossValidate threw: ' + e.message], warnings: [], passed: [] };
      }
    }

    const allValidate = validation && validation.issues.length === 0;

    setApplied({
      ok: allValidate,
      errors,
      patchedBuffers,
      rfhubSec16,
      secrets,
      validation,
    });

    if (allValidate && onPatchComplete) {
      onPatchComplete({
        bcm:   patchedBuffers.bcm   || null,
        rfhub: patchedBuffers.rfhub || null,
        pcm:   patchedBuffers.pcm   || null,
      });
    }

    setStep(4);
  }, [donorChoice, previewRfhubSec16, generatedSecret, bcmBytes, rfhubBytes, pcmBytes, triage, onPatchComplete]);

  /* ── Downloads ── */
  const handleDownloadBcm = () => {
    const buf = applied?.patchedBuffers?.bcm;
    if (!buf) return;
    downloadBlob(buf, `BCM_${vin}_PAIRED.bin`);
  };
  const handleDownloadRfhub = () => {
    const buf = applied?.patchedBuffers?.rfhub;
    if (!buf) return;
    downloadBlob(buf, `RFHUB_${vin}_PAIRED.bin`);
  };
  const handleDownloadPcm = () => {
    const buf = applied?.patchedBuffers?.pcm;
    if (!buf) return;
    downloadBlob(buf, `ECM_${vin}_PAIRED.bin`);
  };
  const handleDownloadZip = async () => {
    const pb = applied?.patchedBuffers;
    if (!pb) return;
    const { zipSync } = await import('fflate');
    const files = {};
    if (pb.bcm)   files[`BCM_${vin}_PAIRED.bin`]   = new Uint8Array(pb.bcm);
    if (pb.rfhub) files[`RFHUB_${vin}_PAIRED.bin`] = new Uint8Array(pb.rfhub);
    if (pb.pcm)   files[`ECM_${vin}_PAIRED.bin`]   = new Uint8Array(pb.pcm);
    const zipped = zipSync(files, { level: 0 });
    downloadBlob(zipped, `PAIRED_${vin}.zip`, 'application/zip');
  };

  /* ── Close on backdrop click ── */
  const overlayRef = useRef(null);
  const handleOverlay = (e) => { if (e.target === overlayRef.current) onClose?.(); };

  /* ── Step navigation helpers ── */
  const anyLoaded = bcmBytes || rfhubBytes || pcmBytes;

  /* ── Generate fresh secret when entering preview step with 'generate' ── */
  const handleGoToPreview = () => {
    if (donorChoice === 'generate' && !generatedSecret) {
      setGeneratedSecret(generateSec16());
    }
    setStep(3);
  };

  /* ── Styles ── */
  const Btn = ({ onClick, disabled, children, color = C.a3, variant = 'solid', testid }) => (
    <button
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '9px 18px', borderRadius: 8, fontWeight: 800, fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: C.sans,
        opacity: disabled ? 0.45 : 1, letterSpacing: 0.3,
        border: variant === 'outline' ? `1.5px solid ${color}` : 'none',
        background: variant === 'outline' ? 'transparent' : color,
        color: variant === 'outline' ? color : '#fff',
        transition: 'opacity 0.15s',
      }}>
      {children}
    </button>
  );

  const SectionTitle = ({ children }) => (
    <div style={{
      fontWeight: 900, fontSize: 11, color: C.ts, letterSpacing: 1.2,
      textTransform: 'uppercase', marginBottom: 12,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.sr, display: 'inline-block' }} />
      {children}
    </div>
  );

  /* ── Render ── */
  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      data-testid="pairing-repair-panel"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, padding: 16, fontFamily: C.sans,
      }}>
      <div style={{
        background: C.bg, borderRadius: 18, width: '100%', maxWidth: 860,
        maxHeight: '94vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 22px', borderBottom: `1px solid ${C.bd}`,
          background: `linear-gradient(135deg, ${C.sr}18 0%, ${C.a1}0A 100%)`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontSize: 22 }}>🔧</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 16, color: C.tx, letterSpacing: 0.3 }}>
              Full Pairing Repair
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
              Repair BCM · RFHUB · ECM security bytes — any combination, including all-blank
            </div>
          </div>
          {/* Step indicator */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {['Triage', 'Donor', 'Preview', 'Apply'].map((label, idx) => {
              const s = idx + 1;
              const active = step === s;
              const done = step > s;
              return (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 900,
                    background: done ? C.gn : active ? C.sr : C.bd,
                    color: (done || active) ? '#fff' : C.tm,
                  }}>
                    {done ? '✓' : s}
                  </div>
                  <span style={{ fontSize: 9, color: active ? C.sr : done ? C.gn : C.tm, fontWeight: active ? 800 : 400 }}>
                    {label}
                  </span>
                  {s < 4 && <span style={{ color: C.tm, fontSize: 10 }}>›</span>}
                </div>
              );
            })}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: C.tm, padding: 4,
          }}>✕</button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>

          {/* ─── STEP 1: Triage ─── */}
          {step === 1 && (
            <div>
              {/* File loaders */}
              <SectionTitle>Load Modules</SectionTitle>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
                <DropZone label="BCM" hint="MPC5606B DFLASH · 64/128 KB"
                  file={bcmFile}
                  onFile={(f, bytes) => setBcmLocal({ file: f, bytes })}
                  accent={C.a3} />
                <DropZone label="RFHUB / FCM" hint="Yazaki Gen1/Gen2 · 2/4 KB"
                  file={rfhubFile}
                  onFile={(f, bytes) => setRfhubLocal({ file: f, bytes })}
                  accent={C.a4} />
                <DropZone label="ECM (PCM)" hint="GPEC2A · 4/8 KB"
                  file={pcmFile}
                  onFile={(f, bytes) => setPcmLocal({ file: f, bytes })}
                  accent={C.a1} />
              </div>

              {anyLoaded ? (
                <>
                  <SectionTitle>Triage Report</SectionTitle>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                    <TriageCard icon="🧠" label="BCM"       report={triage.bcm}   accent={C.a3} />
                    <TriageCard icon="🔑" label="RFHUB/FCM" report={triage.rfhub} accent={C.a4} />
                    <TriageCard icon="⚙️" label="ECM (PCM)" report={triage.pcm}   accent={C.a1} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setStep(2)} color={C.sr} testid="triage-next-btn">
                      Next: Choose Donor →
                    </Btn>
                  </div>
                </>
              ) : (
                <div style={{
                  padding: '24px', textAlign: 'center', background: C.surf,
                  borderRadius: 12, border: `1.5px dashed ${C.bd}`,
                }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>⬆</div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: C.tx, marginBottom: 4 }}>
                    Drop your module files above to start
                  </div>
                  <div style={{ fontSize: 11, color: C.ts }}>
                    Load at least one of BCM / RFHUB / ECM. The panel handles any combination.
                    <br />Files already loaded in Module Sync are pre-populated above.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── STEP 2: Donor Picker ─── */}
          {step === 2 && (
            <div>
              <SectionTitle>Choose Source of Truth</SectionTitle>
              <div style={{ fontSize: 12, color: C.ts, marginBottom: 16, lineHeight: 1.5 }}>
                Select which module's secret to use as the anchor. The chosen secret will be written
                (correctly transformed) into all other loaded modules. This choice is not guessed automatically.
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                <DonorCard
                  id="bcm"
                  icon="🧠"
                  title="Use BCM as source"
                  subtitle={canUseBcm
                    ? `BCM SEC16 → reversed → RFHUB; [0:6] → ECM SEC6`
                    : `BCM SEC16 is ${triage.bcm.state} — cannot use`}
                  bytes={canUseBcm ? triage.bcm.sec16Bytes : null}
                  disabled={!canUseBcm}
                  selected={donorChoice === 'bcm'}
                  onSelect={setDonorChoice}
                />
                <DonorCard
                  id="rfhub"
                  icon="🔑"
                  title="Use RFHUB as source"
                  subtitle={canUseRfhub
                    ? `RFHUB SEC16 → reversed → BCM; [0:6] → ECM SEC6`
                    : `RFHUB SEC16 is ${triage.rfhub.state} — cannot use`}
                  bytes={canUseRfhub ? triage.rfhub.sec16Bytes : null}
                  disabled={!canUseRfhub}
                  selected={donorChoice === 'rfhub'}
                  onSelect={setDonorChoice}
                />
                <DonorCard
                  id="generate"
                  icon="✨"
                  title="Generate fresh secret"
                  subtitle="Cryptographically random 16-byte SEC16 — use when no module can be trusted"
                  bytes={generatedSecret}
                  disabled={false}
                  selected={donorChoice === 'generate'}
                  onSelect={(id) => {
                    setDonorChoice(id);
                    if (!generatedSecret) setGeneratedSecret(generateSec16());
                  }}
                />
              </div>

              {donorChoice === 'generate' && generatedSecret && (
                <div style={{
                  background: C.wn + '14', border: `1px solid ${C.wn}55`,
                  borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 11, color: C.bk,
                }}>
                  <strong style={{ color: C.wn }}>⚠ Fresh secret generated:</strong>{' '}
                  <span style={{ fontFamily: C.mono }}>{fmtHex(generatedSecret)}</span>
                  <button
                    onClick={() => setGeneratedSecret(generateSec16())}
                    style={{
                      marginLeft: 10, fontSize: 10, background: 'none',
                      border: `1px solid ${C.wn}`, borderRadius: 4, padding: '2px 8px',
                      cursor: 'pointer', color: C.wn, fontWeight: 700,
                    }}>
                    Re-generate
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Btn onClick={() => setStep(1)} color={C.tm} variant="outline" testid="donor-back-btn">← Back</Btn>
                <Btn onClick={handleGoToPreview} disabled={!donorChoice} color={C.sr} testid="donor-next-btn">
                  Next: Preview Patches →
                </Btn>
              </div>
            </div>
          )}

          {/* ─── STEP 3: Patch Preview ─── */}
          {step === 3 && previewSecrets && (
            <div>
              <SectionTitle>Patch Preview</SectionTitle>
              <div style={{ fontSize: 11, color: C.ts, marginBottom: 16, lineHeight: 1.5 }}>
                The changes below will be applied when you click <strong>Apply All</strong>. No bytes are written yet.
                Red = old value, green = new value.
              </div>

              {/* BCM */}
              {bcmBytes && (
                <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bd}`, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ fontWeight: 900, fontSize: 12, color: C.a3, marginBottom: 10 }}>
                    🧠 BCM — SEC16 (will write via split records + mirrors)
                  </div>
                  <HexBlock
                    label="BCM SEC16 (new value, derived from chosen donor)"
                    before={triage.bcm.sec16Bytes || null}
                    after={previewSecrets.bcmSec16}
                  />
                  <div style={{ fontSize: 9, color: C.ts, fontStyle: 'italic' }}>
                    Writes to split records @ 0x81A0/C0/E0 + mirror records in inactive bank
                  </div>
                </div>
              )}

              {/* RFHUB */}
              {rfhubBytes && (
                <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bd}`, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ fontWeight: 900, fontSize: 12, color: C.a4, marginBottom: 10 }}>
                    🔑 RFHUB — SEC16
                    {triage.rfhub.rfhFormat === 'gen1' && ' (Gen1)'}
                    {triage.rfhub.rfhFormat === 'gen2' && ' (Gen2)'}
                    {triage.rfhub.rfhFormat === 'xc2268' && ' (XC2268 — 2019+ internal flash)'}
                  </div>
                  {triage.rfhub.rfhFormat === 'gen2' ? (
                    <HexBlock
                      label="RFHUB SEC16 (Gen2 slots 0x050E / 0x0522)"
                      before={triage.rfhub.sec16Bytes || null}
                      after={previewSecrets.rfhubSec16}
                    />
                  ) : triage.rfhub.rfhFormat === 'gen1' ? (
                    <HexBlock
                      label="RFHUB SEC16 (Gen1 slots 0x00AE / 0x00C0)"
                      before={triage.rfhub.sec16Bytes || null}
                      after={previewSecrets.rfhubSec16}
                    />
                  ) : triage.rfhub.rfhFormat === 'xc2268' ? (
                    <>
                      <HexBlock
                        label="RFHUB SEC16 (XC2268 slots 0x1100 / 0x1120)"
                        before={triage.rfhub.sec16Bytes || null}
                        after={previewSecrets.rfhubSec16}
                      />
                      <div style={{ fontSize: 9, color: C.ts, fontStyle: 'italic', marginTop: 4 }}>
                        Both mirror slots written; BE16 CRC-16/CCITT-FALSE appended per slot; image-wide checksum refreshed
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 10, color: C.wn }}>
                      Unknown RFHUB format — cannot write SEC16 offline
                    </div>
                  )}
                </div>
              )}

              {/* ECM / PCM */}
              {pcmBytes && (
                <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bd}`, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ fontWeight: 900, fontSize: 12, color: C.a1, marginBottom: 10 }}>
                    ⚙️ ECM (PCM) — IMMO Repair
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <HexBlock
                      label="Marker @ 0x3C4 (target: FF FF FF AA)"
                      before={triage.pcm.markerHex ? triage.pcm.markerHex.split(' ').map(h => parseInt(h, 16)) : null}
                      after={[0xFF, 0xFF, 0xFF, 0xAA]}
                    />
                    <HexBlock
                      label="SEC6 @ 0x3C8 (first 6 B of RFHUB SEC16)"
                      before={triage.pcm.sec6Bytes || null}
                      after={previewSecrets.pcmSec6}
                    />
                  </div>
                  <div style={{ fontSize: 9, color: C.ts, fontStyle: 'italic', marginTop: 6 }}>
                    SEC6 = RFHUB SEC16[0:6]; marker FF FF FF AA enables IMMO pairing
                  </div>
                </div>
              )}

              {/* RFHUB SEC16 used */}
              <div style={{ background: C.s3, borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: C.ts, marginBottom: 3 }}>
                  RFHUB SEC16 that will be written (master secret)
                </div>
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.bk, wordBreak: 'break-all' }}>
                  {fmtHex(previewSecrets.rfhubSec16)}
                </div>
                {donorChoice === 'generate' && (
                  <div style={{ fontSize: 9, color: C.wn, marginTop: 3, fontWeight: 700 }}>
                    ⚠ Generated fresh — record and store this secret before flashing
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Btn onClick={() => setStep(2)} color={C.tm} variant="outline" testid="preview-back-btn">← Back</Btn>
                <Btn onClick={handleApply} color={C.sr} testid="apply-all-btn">
                  ⚡ Apply All & Validate
                </Btn>
              </div>
            </div>
          )}

          {step === 3 && !previewSecrets && (
            <div style={{ padding: 32, textAlign: 'center', color: C.er }}>
              No valid secret to preview. Go back and choose a donor.
              <div style={{ marginTop: 12 }}>
                <Btn onClick={() => setStep(2)} color={C.tm} variant="outline">← Back</Btn>
              </div>
            </div>
          )}

          {/* ─── STEP 4: Apply + Download ─── */}
          {step === 4 && (
            <div>
              <SectionTitle>Pair Check &amp; Download</SectionTitle>

              {applied?.error && (
                <div style={{
                  background: C.er + '14', border: `1.5px solid ${C.er}55`,
                  borderRadius: 8, padding: '10px 12px', marginBottom: 14,
                  fontSize: 11, color: C.er,
                }}>
                  <strong>✗ Error applying patches:</strong> {applied.error}
                </div>
              )}

              {applied?.errors?.length > 0 && (
                <div style={{
                  background: C.wn + '14', border: `1.5px solid ${C.wn}55`,
                  borderRadius: 8, padding: '10px 12px', marginBottom: 14,
                  fontSize: 11, color: C.bk,
                }}>
                  <strong style={{ color: C.wn }}>⚠ Partial write warnings:</strong>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {applied.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}

              {/* Cross-validate result */}
              {applied?.validation && (
                <div style={{ marginBottom: 16 }}>
                  <ValidationPanel result={applied.validation} />
                </div>
              )}

              {/* Secret summary */}
              {applied?.rfhubSec16 && (
                <div style={{ background: C.s3, borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 10 }}>
                  <div style={{ fontWeight: 700, color: C.ts, marginBottom: 3 }}>
                    Applied RFHUB SEC16 (master secret — save this):
                  </div>
                  <div style={{ fontFamily: C.mono, wordBreak: 'break-all', color: C.bk }}>
                    {fmtHex(applied.rfhubSec16)}
                  </div>
                  {applied.secrets && (
                    <div style={{ marginTop: 6, color: C.ts }}>
                      BCM SEC16 (reverse): <span style={{ fontFamily: C.mono }}>{fmtHexCompact(applied.secrets.bcmSec16)}</span>
                      &nbsp;&nbsp;|&nbsp;&nbsp;
                      PCM SEC6 [0:6]: <span style={{ fontFamily: C.mono }}>{fmtHexCompact(applied.secrets.pcmSec6)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Download buttons */}
              <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bd}`, padding: '16px 18px', marginBottom: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 12, color: C.tx, marginBottom: 12 }}>
                  Download Patched Files
                </div>
                {!applied?.ok && (
                  <div style={{ fontSize: 10, color: C.er, marginBottom: 10, fontWeight: 700 }}>
                    ⚠ Downloads are locked until cross-validation passes (green).
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Btn
                    onClick={handleDownloadBcm}
                    disabled={!applied?.ok || !applied?.patchedBuffers?.bcm}
                    color={C.a3} testid="download-bcm-btn">
                    ⬇ BCM_PAIRED.bin
                  </Btn>
                  <Btn
                    onClick={handleDownloadRfhub}
                    disabled={!applied?.ok || !applied?.patchedBuffers?.rfhub}
                    color={C.a4} testid="download-rfhub-btn">
                    ⬇ RFHUB_PAIRED.bin
                  </Btn>
                  <Btn
                    onClick={handleDownloadPcm}
                    disabled={!applied?.ok || !applied?.patchedBuffers?.pcm}
                    color={C.a1} testid="download-pcm-btn">
                    ⬇ ECM_PAIRED.bin
                  </Btn>
                  <Btn
                    onClick={handleDownloadZip}
                    disabled={!applied?.ok || !applied?.patchedBuffers || Object.keys(applied.patchedBuffers).length === 0}
                    color={C.sr} testid="download-zip-btn">
                    📦 Download All as ZIP
                  </Btn>
                </div>
                {applied?.ok && (
                  <div style={{ marginTop: 10, fontSize: 10, color: C.gn, fontWeight: 700 }}>
                    Filenames: BCM_{vin}_PAIRED.bin · RFHUB_{vin}_PAIRED.bin · ECM_{vin}_PAIRED.bin
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Btn onClick={() => setStep(3)} color={C.tm} variant="outline" testid="result-back-btn">← Back to Preview</Btn>
                <Btn onClick={() => { setStep(1); setApplied(null); setDonorChoice(null); setGeneratedSecret(null); }} color={C.ts} variant="outline" testid="start-over-btn">
                  Start Over
                </Btn>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
