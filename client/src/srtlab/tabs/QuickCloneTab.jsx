/**
 * QuickCloneTab.jsx — Quick Clone Wizard
 * ═══════════════════════════════════════════════════════════════════════════
 * Guided 3-step flow that chains:
 *   Step 1: VIN Patch — write target VIN + fix checksums on BCM, RFHUB, PCM
 *   Step 2: Security Sync — sync BCM SEC16 → RFHUB SEC16 + PCM SEC6
 *   Step 3: Key Transplant — copy donor RFHUB auth sector + key ring → target
 *
 * Each step builds on the output of the previous step, producing a final set
 * of ready-to-flash .bin files at the end.
 * ═══════════════════════════════════════════════════════════════════════════ */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { writeRfhSec16FromBcm, writePcmSec6 } from '../lib/securityBytes.js';
import {
  parseKeyRingBuffer,
  findWritePointer,
  countFreeSlots,
  transplantKeys,
  validateRfhubBuffer,
  readMasterTransponder,
  readAuthKeyCount,
  flagInfo,
} from '../lib/rfhubKeyTransplant.js';
import { identifyModule } from '../lib/keyProgWizard.js';
import { resizePcmForTargetChip } from './ModuleSync';
import { RfhubKeyTypeBanner } from '../components/RfhubKeyTypeBanner.jsx';

/* ═══ Design tokens ═══ */
const STEP_COLORS = ['#2979FF', '#00BFA5', '#FF6D00'];

/* ═══ Helpers ═══ */
const VIN_REGEX = /^[12345][A-HJ-NPR-Z0-9]{16}$/;

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = e => resolve(new Uint8Array(e.target.result));
    fr.onerror = () => reject(new Error('File read error'));
    fr.readAsArrayBuffer(file);
  });
}

function downloadBin(buf, filename) {
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function hexStr(arr) {
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function u8FromHex(h) {
  const s = (h || '').replace(/[^0-9a-fA-F]/g, '');
  const n = s.length >> 1;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
  return a;
}

function crc16(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) { c ^= b << 8; for (let j = 0; j < 8; j++) c = c & 0x8000 ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF); }
  return c & 0xFFFF;
}

/* BCM VIN writer (mirrors engWriteBcmVin in App.jsx) */
const BCM_SLOT_TYPES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33, 0x40, 0x41, 0x42, 0x43, 0x50, 0x51, 0x52, 0x53, 0x60, 0x61, 0x62, 0x63, 0x70, 0x71, 0x72, 0x73, 0x80, 0x81, 0x82, 0x83, 0x90, 0x91, 0x92, 0x93, 0xA0, 0xA1, 0xA2, 0xA3, 0xB0, 0xB1, 0xB2, 0xB3, 0xC0, 0xC1, 0xC2, 0xC3, 0xD0, 0xD1, 0xD2, 0xD3, 0xE0, 0xE1, 0xE2, 0xE3, 0xF0, 0xF1, 0xF2, 0xF3];

function writeBcmVin(bytes, newVin) {
  const out = new Uint8Array(bytes);
  const vb = new TextEncoder().encode(newVin);
  const tb = vb.slice(9, 17);
  const fullCrc = crc16(vb);
  const tailCrc = crc16(tb);
  let fullPatched = 0, shortPatched = 0;
  for (let i = 0; i < out.length - 21; i++) {
    if (out[i] !== 0x00 || out[i + 1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(out[i + 2])) continue;
    if (out[i + 3] !== 0x00) continue;
    const vs = i + 4;
    if (vs + 19 > out.length) continue;
    let valid = true;
    for (let k = 0; k < 17; k++) { const b = out[vs + k]; if (b < 0x20 || b > 0x7E) { valid = false; break; } }
    if (!valid) continue;
    for (let k = 0; k < 17; k++) out[vs + k] = vb[k];
    out[vs + 17] = (fullCrc >> 8) & 0xFF;
    out[vs + 18] = fullCrc & 0xFF;
    fullPatched++;
  }
  // Short VIN slots (8-char tail)
  for (let i = 0; i < out.length - 14; i++) {
    if (out[i] !== 0x00 || out[i + 1] !== 0x46) continue;
    if (out[i + 3] !== 0x00) continue;
    const vs = i + 4;
    if (vs + 10 > out.length) continue;
    let isTail = true;
    for (let k = 0; k < 8; k++) { const b = out[vs + k]; if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { isTail = false; break; } }
    if (!isTail) continue;
    let looksFull = vs + 17 <= out.length;
    if (looksFull) { for (let k = 8; k < 17; k++) { const b = out[vs + k]; if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { looksFull = false; break; } } }
    if (looksFull) continue;
    for (let k = 0; k < 8; k++) out[vs + k] = tb[k];
    out[vs + 8] = (tailCrc >> 8) & 0xFF;
    out[vs + 9] = tailCrc & 0xFF;
    shortPatched++;
  }
  return { bytes: out, fullPatched, shortPatched, fullCrc, tailCrc };
}

/* RFHUB VIN writer (mirrors engWriteRfhVin in App.jsx) */
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
function writeRfhVin(bytes, newVin) {
  const out = new Uint8Array(bytes);
  const fwd = new TextEncoder().encode(newVin);
  const rev = new Uint8Array(17);
  for (let i = 0; i < 17; i++) rev[i] = fwd[16 - i];
  let sum = 0; for (const b of rev) sum = (sum + b) & 0xFF;
  const chk = (0xF9 - sum) & 0xFF;
  let patched = 0;
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = rev[k];
    out[off + 17] = chk;
    patched++;
  }
  return { bytes: out, patched };
}

/* PCM VIN writer */
const PCM_VIN_OFFSETS = [0x0000, 0x0800, 0x0011, 0x0811];
function writePcmVin(bytes, newVin) {
  const out = new Uint8Array(bytes);
  const vb = new TextEncoder().encode(newVin);
  let patched = 0;
  for (const off of PCM_VIN_OFFSETS) {
    if (off + 17 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = vb[k];
    patched++;
  }
  return { bytes: out, patched };
}

/* BCM SEC16 parser (mirrors engParseBcm sec16 extraction) */
function extractBcmSec16(bytes) {
  // Split SEC16 records (bank 2 at 0x81A0/C0/E0, 7+9 format)
  for (let i = 0; i < bytes.length - 32; i++) {
    if (bytes[i] !== 0xFF || bytes[i + 1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (bytes[i + j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = bytes[i + 8];
    if (idx !== 0x01 && idx !== 0x02) continue;
    if (bytes[i + 16] !== 0x04 || bytes[i + 17] !== 0x04 || bytes[i + 18] !== 0x00 || bytes[i + 19] !== 0x14) continue;
    const prefix = bytes.slice(i + 9, i + 16);
    const suffix = bytes.slice(i + 20, i + 29);
    const sec16 = new Uint8Array(16);
    sec16.set(prefix, 0);
    sec16.set(suffix, 7);
    // Check if real (not all FF or all 00)
    if (!sec16.every(b => b === 0xFF) && !sec16.every(b => b === 0x00)) {
      return sec16;
    }
  }
  // Contiguous mirror records
  const checkMirror = (bankBase) => {
    const bankEnd = Math.min(bankBase + 0x4000, bytes.length);
    for (let i = bankBase; i < bankEnd - 32; i++) {
      if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x00 &&
          bytes[i + 3] === 0x18 && bytes[i + 4] === 0x00 && bytes[i + 5] === 0x46 &&
          bytes[i + 6] === 0xEB && bytes[i + 7] === 0x00) {
        const sec16 = bytes.slice(i + 8, i + 24);
        if (!sec16.every(b => b === 0xFF) && !sec16.every(b => b === 0x00)) return sec16;
      }
    }
    return null;
  };
  if (bytes.length >= 0x8000) {
    const m0 = checkMirror(0x0000);
    if (m0) return m0;
    const m1 = checkMirror(0x4000);
    if (m1) return m1;
  }
  return null;
}

/* RFHUB format detector */
function detectRfhFormat(bytes) {
  const gen2Hdr = bytes[0x0500] === 0xAA && bytes[0x0501] === 0x55 && bytes[0x0502] === 0x31 && bytes[0x0503] === 0x01;
  const g2 = bytes.slice(0x050E, 0x051E);
  const g1 = bytes.slice(0x0226, 0x0238);
  const g2Pop = !g2.every(b => b === 0xFF) && !g2.every(b => b === 0x00);
  const g1Pop = !g1.every(b => b === 0xFF) && !g1.every(b => b === 0x00);
  if (gen2Hdr && g2Pop) return 'gen2';
  if (g1Pop) return 'gen1';
  if (gen2Hdr) return 'gen2';
  return 'unknown';
}

/* RFHUB type detector (XC2268 check) */
function detectRfhubType(buf, filename) {
  try {
    const id = identifyModule(buf, filename || 'unknown.bin');
    if (!id || id.role !== 'RFH') return { label: 'UNKNOWN', isXC2268: false };
    if ((id.info?.type || '') === 'XC2268_RFHUB') return { label: 'XC2268', isXC2268: true };
    return { label: 'MC9S12', isXC2268: false };
  } catch { return { label: 'UNKNOWN', isXC2268: false }; }
}

/* ═══ Step Badge ═══ */
function StepBadge({ n, state, color }) {
  const bg = state === 'done' ? C.gn : state === 'active' ? color : C.bd;
  const fg = state === 'pending' ? C.ts : '#fff';
  return (
    <span style={{
      display: 'inline-grid', placeItems: 'center', width: 28, height: 28,
      borderRadius: '50%', background: bg, color: fg,
      fontWeight: 900, fontSize: 13, flexShrink: 0,
      boxShadow: state === 'active' ? `0 0 0 3px ${color}33` : 'none',
      transition: 'all 300ms cubic-bezier(0.23,1,0.32,1)',
    }}>
      {state === 'done' ? '✓' : n}
    </span>
  );
}

/* ═══ Upload Slot ═══ */
function UploadSlot({ label, file, onLoad, required, accent }) {
  const ref = useRef();
  const handleChange = e => {
    const f = e.target.files?.[0];
    if (f) onLoad(f);
  };
  return (
    <div
      onClick={() => ref.current?.click()}
      style={{
        flex: 1, minWidth: 180, padding: '14px 12px', borderRadius: 12,
        border: `2px dashed ${file ? accent : C.bd}`,
        background: file ? accent + '08' : C.c2,
        cursor: 'pointer', textAlign: 'center', transition: 'all 200ms',
      }}
    >
      <input ref={ref} type="file" accept=".bin" style={{ display: 'none' }} onChange={handleChange} />
      <div style={{ fontSize: 10, fontWeight: 900, color: file ? accent : C.ts, letterSpacing: 2, marginBottom: 4 }}>
        {label} {required && !file && <span style={{ color: C.er }}>*</span>}
      </div>
      {file ? (
        <>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: '#00695C', wordBreak: 'break-all' }}>{file.name}</div>
          <div style={{ fontSize: 10, color: C.ts, marginTop: 2 }}>{file.size.toLocaleString()} bytes</div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: C.tm }}>Click to upload .bin</div>
      )}
    </div>
  );
}

/* ═══ MAIN COMPONENT ═══ */
export default function QuickCloneTab({ vehicle }) {
  /* ── File state ── */
  const [bcmFile, setBcmFile] = useState(null); // {name, data: Uint8Array}
  const [rfhDonor, setRfhDonor] = useState(null); // donor RFHUB for key transplant
  const [rfhTarget, setRfhTarget] = useState(null); // target RFHUB for VIN+SEC+keys
  const [pcmFile, setPcmFile] = useState(null);

  /* ── Config ── */
  const [targetVin, setTargetVin] = useState('');
  const [targetPcmChip, setTargetPcmChip] = useState('4kb');
  const [copyAuth, setCopyAuth] = useState(true);

  /* ── Step results ── */
  const [step1, setStep1] = useState(null); // {bcmBytes, rfhBytes, pcmBytes, log[]}
  const [step2, setStep2] = useState(null); // {bcmBytes, rfhBytes, pcmBytes, log[]}
  const [step3, setStep3] = useState(null); // {rfhBytes, log[], injected[], skipped[]}

  /* ── UI state ── */
  const [error, setError] = useState('');
  const [diffOpen, setDiffOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(1);

  const vinGood = VIN_REGEX.test(targetVin);
  const accent = vehicle?.accent || '#2979FF';

  /* ── File loaders ── */
  const loadBcm = useCallback(async (file) => {
    setError('');
    setStep1(null); setStep2(null); setStep3(null);
    const data = await readFile(file);
    // Validate BCM role
    const id = identifyModule(data, file.name);
    if (id && id.role && id.role !== 'BCM') {
      setError(`File "${file.name}" identified as ${id.role} (${id.info?.type || 'unknown'}), not BCM. Upload a BCM dump in the BCM slot.`);
      return;
    }
    if (data.length < 0x4000) {
      setError(`File "${file.name}" is too small for a BCM dump (${data.length} bytes). Expected at least 16 KB.`);
      return;
    }
    setBcmFile({ name: file.name, data, size: data.length });
  }, []);

  const loadRfhDonor = useCallback(async (file) => {
    setError('');
    setStep3(null);
    const data = await readFile(file);
    const rfhType = detectRfhubType(data, file.name);
    if (rfhType.isXC2268) {
      setError('Donor RFHUB is XC2268 (64KB internal flash) — not supported for key transplant. Use a MC9S12 4KB RFHUB.');
      return;
    }
    const v = validateRfhubBuffer(data);
    if (!v.ok) { setError(`Donor RFHUB: ${v.error}`); return; }
    const keys = parseKeyRingBuffer(data);
    const mt = readMasterTransponder(data);
    setRfhDonor({ name: file.name, data, size: data.length, keys, mt, rfhType });
  }, []);

  const loadRfhTarget = useCallback(async (file) => {
    setError('');
    setStep1(null); setStep2(null); setStep3(null);
    const data = await readFile(file);
    const rfhType = detectRfhubType(data, file.name);
    if (rfhType.isXC2268) {
      setError('Target RFHUB is XC2268 (64KB internal flash) — not supported. Use a MC9S12 4KB RFHUB.');
      return;
    }
    const v = validateRfhubBuffer(data);
    if (!v.ok) { setError(`Target RFHUB: ${v.error}`); return; }
    setRfhTarget({ name: file.name, data, size: data.length, rfhType });
  }, []);

  const loadPcm = useCallback(async (file) => {
    setError('');
    setStep1(null); setStep2(null); setStep3(null);
    const data = await readFile(file);
    // Validate PCM role
    const id = identifyModule(data, file.name);
    if (id && id.role && id.role !== 'PCM') {
      setError(`File "${file.name}" identified as ${id.role} (${id.info?.type || 'unknown'}), not PCM. Upload a PCM dump in the PCM slot.`);
      return;
    }
    if (data.length !== 4096 && data.length !== 8192) {
      setError(`File "${file.name}" is ${data.length} bytes. PCM dumps must be 4096 (4 KB) or 8192 (8 KB).`);
      return;
    }
    setPcmFile({ name: file.name, data, size: data.length });
  }, []);

  /* ═══ STEP 1: VIN PATCH ═══ */
  const runStep1 = useCallback(() => {
    setError(''); setStep2(null); setStep3(null);
    if (!vinGood) { setError('Enter a valid 17-character target VIN'); return; }
    if (!bcmFile) { setError('Upload a BCM dump to continue'); return; }
    try {
      const log = [];
      const vinRes = writeBcmVin(bcmFile.data, targetVin);
      log.push(`BCM VIN: ${vinRes.fullPatched} full / ${vinRes.shortPatched} short slot(s) patched · CRC 0x${vinRes.fullCrc.toString(16).toUpperCase()}`);

      let rfhBytes = null;
      if (rfhTarget) {
        const r = writeRfhVin(rfhTarget.data, targetVin);
        rfhBytes = r.bytes;
        log.push(`RFHUB VIN: ${r.patched} slot(s) patched (byte-reversed + checksum)`);
      }

      let pcmBytes = null;
      if (pcmFile) {
        const p = writePcmVin(pcmFile.data, targetVin);
        pcmBytes = p.bytes;
        log.push(`PCM VIN: ${p.patched} slot(s) patched`);
      }

      setStep1({ bcmBytes: vinRes.bytes, rfhBytes, pcmBytes, log });
      setActiveStep(2);
    } catch (e) { setError(e.message); }
  }, [vinGood, targetVin, bcmFile, rfhTarget, pcmFile]);

  /* ═══ STEP 2: SECURITY SYNC ═══ */
  const runStep2 = useCallback(() => {
    setError(''); setStep3(null);
    if (!step1) { setError('Run Step 1 first'); return; }
    try {
      const log = [];
      const bcmBytes = step1.bcmBytes;
      const bcmSec16 = extractBcmSec16(bcmBytes);
      if (!bcmSec16) {
        setError('BCM has no real SEC16 secret (virgin / older family). VIN files from Step 1 are still valid, but security cannot be synced.');
        return;
      }
      const sec16Hex = hexStr(bcmSec16);
      log.push(`BCM SEC16 (source of truth): ${sec16Hex}`);

      // Derive the RFH-form secret (byte-reversed)
      const rfhFormSecret = new Uint8Array(16);
      for (let i = 0; i < 16; i++) rfhFormSecret[i] = bcmSec16[15 - i];

      let rfhBytes = step1.rfhBytes;
      if (rfhBytes) {
        const rfhFmt = detectRfhFormat(rfhBytes);
        if (rfhFmt === 'gen2') {
          try {
            const r = writeRfhSec16FromBcm(rfhBytes, bcmSec16);
            rfhBytes = r.bytes;
            log.push(`RFHUB SEC16 ← reverse(BCM): ${r.patched}/2 slot(s) = ${r.rfhSec16Hex}`);
          } catch (e) { log.push(`RFHUB SEC16: skipped (${e.message})`); }
        } else {
          log.push(`RFHUB SEC16: skipped (format=${rfhFmt}, Gen2 writer only)`);
        }
      }

      let pcmBytes = step1.pcmBytes;
      if (pcmBytes) {
        const sec6Res = writePcmSec6(pcmBytes, rfhFormSecret);
        if (sec6Res.ok) {
          pcmBytes = sec6Res.bytes;
          log.push(`PCM SEC6 ← reverse(BCM)[0:6]: ${sec6Res.patched} location(s) patched`);
          const resized = resizePcmForTargetChip(pcmBytes, targetPcmChip);
          pcmBytes = resized.bytes;
          log.push(`PCM output: ${resized.bytes.length} B (${targetPcmChip === '8kb' ? '95640 / 8 KB' : '95320 / 4 KB'})`);
        } else {
          log.push(`PCM SEC6: no writable site (size=${pcmBytes.length} B)`);
        }
      }

      setStep2({ bcmBytes, rfhBytes, pcmBytes, log });
      setActiveStep(3);
    } catch (e) { setError(e.message); }
  }, [step1, targetPcmChip]);

  /* ═══ STEP 3: KEY TRANSPLANT ═══ */
  const runStep3 = useCallback(() => {
    setError('');
    if (!step2) { setError('Run Step 2 first'); return; }
    if (!rfhDonor) { setError('Upload a donor RFHUB to transplant keys from'); return; }
    if (!step2.rfhBytes) { setError('No target RFHUB available from Step 2 — upload one in the file slots above'); return; }
    try {
      const log = [];
      const res = transplantKeys(rfhDonor.data, step2.rfhBytes, {
        only: null,
        skipDuplicates: true,
        copyAuthSector: copyAuth,
      });
      log.push(`Keys injected: ${res.injected.length}`);
      if (res.skipped.length > 0) log.push(`Keys skipped (duplicate): ${res.skipped.length}`);
      log.push(`Auth sector copied: ${res.authSectorCopied ? 'YES' : 'NO'}`);
      if (res.injected.length > 0) {
        const autelIds = res.injected.map(k => k.autelId || hexStr(new Uint8Array(k.chipIdBytes || []))).filter(Boolean);
        if (autelIds.length > 0) log.push(`Autel IDs: ${autelIds.join(', ')}`);
      }

      // Compute real bytes changed
      let bytesChanged = 0;
      const orig = step2.rfhBytes;
      for (let i = 0; i < Math.min(orig.length, res.patched.length); i++) {
        if (orig[i] !== res.patched[i]) bytesChanged++;
      }

      // Persist to server
      const histEntry = {
        ts: Date.now(),
        donor: rfhDonor.name,
        target: rfhTarget?.name || 'from_step2',
        injected: res.injected.length,
        skipped: res.skipped.length,
        authCopied: res.authSectorCopied,
        bytesChanged,
        keys: res.injected.map(k => k.autelId),
      };
      try {
        fetch('/api/backups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `transplant_${histEntry.ts}`,
            module: 'KEY_TRANSPLANT',
            vin: targetVin || null,
            snapshotKind: 'transplant_log',
            timestamp: histEntry.ts,
            payload: JSON.stringify(histEntry),
          }),
        });
      } catch { /* best-effort */ }

      // Build diff entries for the hex diff panel (cap at 256 changed offsets)
      const diffEntries = [];
      for (let i = 0; i < Math.min(orig.length, res.patched.length) && diffEntries.length < 256; i++) {
        if (orig[i] !== res.patched[i]) diffEntries.push({ offset: i, before: orig[i], after: res.patched[i] });
      }
      setStep3({ rfhBytes: res.patched, log, injected: res.injected, skipped: res.skipped, diffEntries, bytesChanged });
    } catch (e) { setError(e.message); }
  }, [step2, rfhDonor, rfhTarget, copyAuth, targetVin]);

  /* ═══ DOWNLOAD ALL ═══ */
  const downloadAll = useCallback(() => {
    const ts = Date.now();
    const prefix = vehicle?.id?.toUpperCase() || 'MODULE';
    const vin = targetVin || 'NOVIN';
    if (step2?.bcmBytes) downloadBin(step2.bcmBytes, `${prefix}_BCM_CLONED_${vin}_${ts}.bin`);
    if (step3?.rfhBytes) downloadBin(step3.rfhBytes, `${prefix}_RFH_CLONED_${vin}_${ts}.bin`);
    else if (step2?.rfhBytes) downloadBin(step2.rfhBytes, `${prefix}_RFH_SYNCED_${vin}_${ts}.bin`);
    if (step2?.pcmBytes) downloadBin(step2.pcmBytes, `${prefix}_PCM_CLONED_${vin}_${ts}.bin`);
  }, [step2, step3, vehicle, targetVin]);

  /* ═══ STEP STATE ═══ */
  const stepState = (n) => {
    if (n === 1) return step1 ? 'done' : activeStep === 1 ? 'active' : 'pending';
    if (n === 2) return step2 ? 'done' : activeStep === 2 ? 'active' : 'pending';
    if (n === 3) return step3 ? 'done' : activeStep === 3 ? 'active' : 'pending';
    return 'pending';
  };

  const allDone = !!step3;

  /* ═══ RENDER ═══ */
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 900, margin: '0 auto', padding: 24 }}>
      {/* HEADER */}
      <Card>
        <div style={{ fontFamily: "'Righteous'", fontSize: 20, color: C.tx, marginBottom: 6 }}>
          ⚡ QUICK CLONE · 3-Step Module Wizard
        </div>
        <div style={{ fontSize: 12, color: C.ts, fontWeight: 600, lineHeight: 1.6 }}>
          Chains VIN patch → Security Sync → Key Transplant into one guided flow.
          Upload your module dumps, enter the target VIN, and follow the steps.
          Each step builds on the previous — download the final set of ready-to-flash files at the end.
        </div>
      </Card>

      {/* INSTRUCTIONS BOX */}
      <Card>
        <div style={{ fontSize: 10, fontWeight: 900, color: STEP_COLORS[0], letterSpacing: 2, marginBottom: 8 }}>INSTRUCTIONS</div>
        <div style={{ fontSize: 11, color: C.tx, lineHeight: 1.7, fontWeight: 600 }}>
          <div>1. Upload the <strong>target BCM</strong> (required) and optionally the <strong>target RFHUB</strong> and <strong>PCM</strong>.</div>
          <div>2. Upload the <strong>donor RFHUB</strong> (the vehicle whose keys you want to transfer).</div>
          <div>3. Enter the <strong>target VIN</strong> (the VIN you want stamped on all modules).</div>
          <div>4. Click each step button in order — each step validates and builds on the previous.</div>
          <div>5. Download all patched files at the end and flash back to the bench programmer.</div>
        </div>
      </Card>

      {/* FILE UPLOADS */}
      <Card>
        <div style={{ fontSize: 10, fontWeight: 900, color: C.ts, letterSpacing: 2, marginBottom: 12 }}>MODULE DUMPS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          <UploadSlot label="TARGET BCM" file={bcmFile} onLoad={loadBcm} required accent={accent} />
          <UploadSlot label="TARGET RFHUB" file={rfhTarget} onLoad={loadRfhTarget} accent={accent} />
          <UploadSlot label="TARGET PCM" file={pcmFile} onLoad={loadPcm} accent={accent} />
          <UploadSlot label="DONOR RFHUB" file={rfhDonor} onLoad={loadRfhDonor} accent={STEP_COLORS[2]} />
        </div>
        {rfhDonor && rfhDonor.keys && (
          <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: STEP_COLORS[2] + '0A', border: `1px solid ${STEP_COLORS[2]}33` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: STEP_COLORS[2], letterSpacing: 1.5 }}>DONOR KEYS: {rfhDonor.keys.length}</div>
            <div style={{ fontSize: 10, color: C.ts, marginTop: 2, fontFamily: "'JetBrains Mono'" }}>
              {rfhDonor.keys.map((k, i) => k.autelId || `Key${i + 1}`).join(' · ')}
            </div>
          </div>
        )}
        {/* Key type banners — shown as soon as donor or target RFHUB is loaded */}
        {(rfhDonor || rfhTarget) && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rfhTarget && rfhTarget.data && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 4 }}>TARGET RFHUB — REQUIRED BLANK KEY TYPE</div>
                <RfhubKeyTypeBanner bytes={rfhTarget.data} />
              </div>
            )}
            {rfhDonor && rfhDonor.data && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 4 }}>DONOR RFHUB — KEY FAMILY</div>
                <RfhubKeyTypeBanner bytes={rfhDonor.data} />
              </div>
            )}
          </div>
        )}
      </Card>

      {/* TARGET VIN */}
      <Card>
        <div style={{ fontSize: 10, fontWeight: 900, color: C.ts, letterSpacing: 2, marginBottom: 8 }}>TARGET VIN · 17 CHARACTERS</div>
        <input
          value={targetVin}
          maxLength={17}
          placeholder={`Enter target ${vehicle?.name || 'vehicle'} VIN`}
          onChange={e => { setTargetVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')); setStep1(null); setStep2(null); setStep3(null); }}
          style={{
            width: '100%', padding: '12px 16px', borderRadius: 10,
            border: `2px solid ${targetVin.length === 17 && !vinGood ? C.er : vinGood ? C.gn : C.bd}`,
            background: C.c2, fontFamily: "'JetBrains Mono'", fontSize: 16, fontWeight: 700,
            letterSpacing: 3, textAlign: 'center', outline: 'none', boxSizing: 'border-box', color: C.tx,
          }}
        />
        {targetVin.length === 17 && !vinGood && (
          <div style={{ fontSize: 10, color: C.er, marginTop: 4, fontWeight: 700 }}>Invalid VIN format</div>
        )}
      </Card>

      {/* PCM CHIP SELECTOR */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.ts, letterSpacing: 1.5 }}>TARGET PCM CHIP</div>
          {[{ key: '4kb', label: '95320 · 4 KB' }, { key: '8kb', label: '95640 · 8 KB' }].map(opt => {
            const active = targetPcmChip === opt.key;
            return (
              <button key={opt.key} onClick={() => setTargetPcmChip(opt.key)}
                style={{
                  padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${active ? accent : C.bd}`,
                  background: active ? accent : C.cd, color: active ? '#fff' : C.tx,
                  fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
                }}>{opt.label}</button>
            );
          })}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={copyAuth} onChange={e => setCopyAuth(e.target.checked)} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.tx }}>Copy Auth Sector</span>
          </label>
        </div>
      </Card>

      {/* ═══ STEP 1 ═══ */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <StepBadge n={1} state={stepState(1)} color={STEP_COLORS[0]} />
          <div>
            <div style={{ fontFamily: "'Righteous'", fontSize: 15, color: stepState(1) === 'pending' ? C.tm : C.tx }}>Write VIN + Fix Checksums</div>
            <div style={{ fontSize: 10, color: C.ts, fontWeight: 600 }}>Stamps target VIN into every slot and recomputes VIN-area CRC</div>
          </div>
        </div>
        <Btn onClick={runStep1} color={STEP_COLORS[0]} disabled={!vinGood || !bcmFile}>
          ① WRITE VIN + CHECKSUMS
        </Btn>
        {step1 && (
          <div style={{ marginTop: 12, fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, lineHeight: 1.7, background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10, padding: '10px 12px' }}>
            {step1.log.map((l, i) => <div key={i}>· {l}</div>)}
          </div>
        )}
      </Card>

      {/* ═══ STEP 2 ═══ */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <StepBadge n={2} state={stepState(2)} color={STEP_COLORS[1]} />
          <div>
            <div style={{ fontFamily: "'Righteous'", fontSize: 15, color: stepState(2) === 'pending' ? C.tm : C.tx }}>Sync Security Bytes</div>
            <div style={{ fontSize: 10, color: C.ts, fontWeight: 600 }}>BCM SEC16 → RFHUB SEC16 (reversed) + PCM SEC6</div>
          </div>
        </div>
        <Btn onClick={runStep2} color={STEP_COLORS[1]} disabled={!step1}>
          ② SYNC SECURITY BYTES
        </Btn>
        {step2 && (
          <div style={{ marginTop: 12, fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, lineHeight: 1.7, background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10, padding: '10px 12px' }}>
            {step2.log.map((l, i) => <div key={i}>· {l}</div>)}
          </div>
        )}
      </Card>

      {/* ═══ STEP 3 ═══ */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <StepBadge n={3} state={stepState(3)} color={STEP_COLORS[2]} />
          <div>
            <div style={{ fontFamily: "'Righteous'", fontSize: 15, color: stepState(3) === 'pending' ? C.tm : C.tx }}>Transplant Keys</div>
            <div style={{ fontSize: 10, color: C.ts, fontWeight: 600 }}>Copy donor auth sector + key ring buffer → target RFHUB</div>
          </div>
        </div>
        <Btn onClick={runStep3} color={STEP_COLORS[2]} disabled={!step2 || !rfhDonor || !rfhTarget}>
          ③ TRANSPLANT KEYS
        </Btn>
        {!rfhTarget && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: C.wn + '15', border: `1px solid ${C.wn}44`, fontSize: 11, color: '#7B5800', fontWeight: 700 }}>
            ⚠ Target RFHUB not uploaded — Step 3 requires a target RFHUB to receive the transplanted keys.
          </div>
        )}
        {rfhTarget && !rfhDonor && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: C.wn + '15', border: `1px solid ${C.wn}44`, fontSize: 11, color: '#7B5800', fontWeight: 700 }}>
            ⚠ Donor RFHUB not uploaded — Step 3 needs a donor RFHUB to copy keys from.
          </div>
        )}
        {step3 && (
          <div style={{ marginTop: 12, fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, lineHeight: 1.7, background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10, padding: '10px 12px' }}>
            {step3.log.map((l, i) => <div key={i}>· {l}</div>)}
          </div>
        )}
        {step3 && step3.diffEntries && step3.diffEntries.length > 0 && (
          <div style={{ marginTop: 10, borderRadius: 10, border: `1px solid ${C.bd}`, overflow: 'hidden' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: C.c2, cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setDiffOpen(o => !o)}
            >
              <span style={{ fontSize: 10, fontWeight: 900, color: C.ts, letterSpacing: 1.5, flex: 1 }}>BYTE DIFF — BEFORE / AFTER KEY TRANSPLANT</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: C.wn, padding: '2px 8px', borderRadius: 4, background: C.wn + '18', border: `1px solid ${C.wn}44` }}>
                {step3.bytesChanged} BYTES CHANGED
              </span>
              <span style={{ fontSize: 12, color: C.ts }}>{diffOpen ? '▲' : '▼'}</span>
            </div>
            {diffOpen && (
              <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.bd}`, position: 'sticky', top: 0, background: '#F4F1EC' }}>
                      <th style={{ padding: '4px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.2 }}>OFFSET</th>
                      <th style={{ padding: '4px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.er, letterSpacing: 1.2 }}>BEFORE</th>
                      <th style={{ padding: '4px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.gn, letterSpacing: 1.2 }}>AFTER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step3.diffEntries.map((d, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.bd}22` }}>
                        <td style={{ padding: '3px 10px', color: C.a3 }}>0x{d.offset.toString(16).toUpperCase().padStart(4, '0')}</td>
                        <td style={{ padding: '3px 10px', color: C.er }}>{d.before.toString(16).toUpperCase().padStart(2, '0')}</td>
                        <td style={{ padding: '3px 10px', color: C.gn }}>{d.after.toString(16).toUpperCase().padStart(2, '0')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {step3.bytesChanged > 256 && (
                  <div style={{ padding: '6px 12px', fontSize: 10, color: C.ts, borderTop: `1px solid ${C.bd}` }}>
                    … {step3.bytesChanged - 256} more changed bytes not shown (capped at 256 rows)
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ═══ DOWNLOAD ALL ═══ */}
      {(step2 || step3) && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Btn onClick={downloadAll} color={C.gn}>
              ⬇ DOWNLOAD ALL PATCHED FILES
            </Btn>
            {step2?.bcmBytes && <Btn outline color={accent} onClick={() => downloadBin(step2.bcmBytes, `${(vehicle?.id || 'MOD').toUpperCase()}_BCM_CLONED_${targetVin}_${Date.now()}.bin`)}>⬇ BCM</Btn>}
            {step3?.rfhBytes && <Btn outline color={accent} onClick={() => downloadBin(step3.rfhBytes, `${(vehicle?.id || 'MOD').toUpperCase()}_RFH_CLONED_${targetVin}_${Date.now()}.bin`)}>⬇ RFH (keys)</Btn>}
            {!step3?.rfhBytes && step2?.rfhBytes && <Btn outline color={accent} onClick={() => downloadBin(step2.rfhBytes, `${(vehicle?.id || 'MOD').toUpperCase()}_RFH_SYNCED_${targetVin}_${Date.now()}.bin`)}>⬇ RFH</Btn>}
            {step2?.pcmBytes && <Btn outline color={accent} onClick={() => downloadBin(step2.pcmBytes, `${(vehicle?.id || 'MOD').toUpperCase()}_PCM_CLONED_${targetVin}_${Date.now()}.bin`)}>⬇ PCM</Btn>}
          </div>
          {allDone && (
            <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 10, background: C.gn + '12', border: `1px solid ${C.gn}44`, fontSize: 12, color: C.gn, fontWeight: 700 }}>
              ✓ All 3 steps complete — modules are VIN-patched, security-synced, and keys transplanted. Flash back to bench.
            </div>
          )}
        </Card>
      )}

      {/* ERROR */}
      {error && (
        <div style={{ padding: '12px 16px', borderRadius: 10, background: C.er + '15', border: `1px solid ${C.er}44`, fontSize: 12, color: C.er, fontWeight: 700 }}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
