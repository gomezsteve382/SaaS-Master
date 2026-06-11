import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ASSET_IDS, trackDownload } from "../lib/downloadAssets.js";
import { DownloadCounter } from "../lib/useDownloadCount.jsx";
import { useMasterVin } from "../lib/masterVinContext.jsx";
import MismatchWizard from "../components/MismatchWizard.jsx";
import PcmRepairWizard from "../components/PcmRepairWizard.jsx";
import PairingRepairPanel from "../components/PairingRepairPanel.jsx";
import ProgrammerSizeHelp from "../components/ProgrammerSizeHelp.jsx";
import { writeBcmSec16Gen2, writePcmSec6, writeRfhSec16FromBcm, writeRfhSec16Gen1, writeRfhSec16Gen2Slots, writeBcmFlatSec16, writeXc2268Sec16 } from "../lib/securityBytes.js";
import { writerGrounding, GROUNDING } from "../lib/algoProvenance.js";
import { isXc2268Rfhub } from "../lib/xc2268Rfhub.js";
import { rekeyVirginBcmFromRfhub } from "../lib/mpc5606bBcm.js";
import { bcmTooSmall, moduleTooSmall, pcmChipFromSize, pcmChipFromKey, resolveBcmSec16, classifyPcmSec6, parseModule, corruptFillError, detectCorruptFill, PCM_VIN_OFFSETS_GPEC2A } from "../lib/parseModule.js";
import { engParseBcm, engResolveBcmSec16 } from "../lib/engBcmParse.js";
import { crossValidate } from "../lib/crossValidate.js";
import { checkExportSafety, formatBlockingMessage } from "../lib/exportSafetyGate.js";
import { MODULE_CONNECTION_GUIDES, PROGRAMMERS } from "../lib/programmerData.js";
import { scoreCandidate, pickBest, fmtPick, CANONICAL_PATTERNS } from "../lib/bestPick.js";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";
import { getDidDescription, getDidOperations } from "../lib/dids.js";
import { logSec16Sync } from "../lib/sec16SyncLog.js";
import { classifyPlatform } from "../lib/sec16Platforms.js";
import { classifyFlatRepairFilename } from "../lib/flatRepairLabel.js";

/* Inline badge for BCM_FLAT40C9_REPAIRED_{CANONICAL,LEGACYFLAT}_*.bin files.
 * Returns null for any filename that doesn't match — caller can render it
 * unconditionally next to a filename string. */
function FlatRepairBadge({ filename, size = 9 }) {
  const k = classifyFlatRepairFilename(filename);
  if (!k) return null;
  return (
    <span
      title={k.fullLabel}
      data-testid={`flat-repair-badge-${k.kind}`}
      style={{
        fontSize: size, fontWeight: 800, letterSpacing: 0.6,
        padding: '1px 6px', borderRadius: 4,
        background: k.background, color: k.color,
        border: `1px solid ${k.color}40`,
        fontFamily: "'Nunito'", textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {k.shortLabel}
    </span>
  );
}

/* ============================================================================
 * SRT Lab — Module Sync v2 (SINCRO-verified engine)
 *
 * BCM:   MPC5606B DFLASH — VIN slots (00 46 XX 00 marker), SEC16 split records
 *         at 0x81A0/C0/E0 (7+9 byte format), mirror records (0xEB/0xCA),
 *         active/inactive bank detection via FEE sequence numbers.
 *
 * RFHUB: Yazaki FCM EEPROM — 4 byte-reversed VIN slots at 0x0EA5/B9/CD/E1
 *         Gen1 SEC16 at 0x0226/023A (18 bytes), Gen2 at 0x050E/0522 (16 bytes)
 *         Gen2 detected by AA 55 31 01 header at 0x0500.
 *
 * PCM:   Continental GPEC2A (4 KB or 8 KB EEPROM, FF FF FF AA marker @ 0x3C4 + SEC6 @ 0x3C8)
 *         VIN at 0x0000/01F0/0224/0CE0, SEC6 after the marker.
 *
 * SINCRO-verified: engWriteBcmSec16Gen2 produces byte-identical output to
 *   ArmandoQS/SINCRO on 22 Charger Redeye reference dumps.
 * ============================================================================ */

const C = {
  bg: '#F4F1EC', cd: '#FFF', c2: '#FAF9F7', sr: '#D32F2F', sl: '#FF5252',
  bk: '#1A1A1A', a1: '#FF6D00', a2: '#00BFA5', a3: '#2979FF', a4: '#AA00FF',
  tx: '#1A1A1A', ts: '#5A5A5A', tm: '#9E9E9E', bd: '#E8E4DE',
  gn: '#00C853', wn: '#FFB300', er: '#FF1744',
};

const VIN_RE   = /^[12345][A-HJ-NPR-Z0-9]{16}$/;

/* Per-action map of which modules a given Module Sync action actually
 * reads or writes. Used by computeMixedSyncParticipants() so the
 * mixed-override warning only fires when the modules the action
 * touches really mix registry-checked and override files.
 * 95640/EEP is intentionally excluded: the Dumps tab does not expose
 * a P/N override flag for it. */
export const MODSYNC_ACTION_PARTICIPANTS = {
  'rfh-to-bcm':            ['BCM', 'RFHUB'],
  'bcm-to-rfh':            ['BCM', 'RFHUB'],
  'target-both':           ['BCM', 'RFHUB'],
  'bcm-sec16-to-rfh':      ['BCM', 'RFHUB'],
  'bcm-vin-sec16-to-rfh':  ['BCM', 'RFHUB'],  // combined: VIN + SEC16 for virgin RFHUB
  'bcm-flat-from-resolved':['BCM'],
  'bcm-flat-from-resolved-both':['BCM'],
  'sec16-only':            ['BCM', 'RFHUB', 'PCM'],
  'sync-all':              ['BCM', 'RFHUB', 'PCM'],
  'full-sync':             ['BCM', 'RFHUB', 'PCM'],
  'rekey-95640-from-rfh':  ['RFHUB'],
};

/* Returns the names of currently-loaded participating modules split into
 * `overrideNames` (P/N override active) and `checkedNames` (registry-
 * checked / no override). Caller decides whether to prompt based on
 * whether both lists are non-empty. */
export function computeMixedSyncParticipants(action, slots) {
  const order = MODSYNC_ACTION_PARTICIPANTS[action] || ['BCM', 'RFHUB', 'PCM'];
  const participants = order.filter(name => slots[name]?.loaded);
  return {
    participants,
    overrideNames: participants.filter(n => slots[n].override),
    checkedNames:  participants.filter(n => !slots[n].override),
  };
}
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const VIN_LEN  = 17;

/* ----------------------------------------------------------------------------
 * Task #475 — programmer file-size guard helpers.
 *
 * The CGDI / Xprog / Orange5 flashers reject a PCM EXT EEPROM image with
 * "File different size" the instant the byte count doesn't match the
 * physical chip on the bench (95320 = 4 KB / 95640 = 8 KB). These helpers
 * give every load-and-generate path one shared way to:
 *   - badge each loaded module with its byte size + canonical-size class
 *   - resolve a `targetPcmChip` ('4kb' / '8kb') for the bundler output
 *   - pad / slice the PCM output to match the target chip and append the
 *     `_4KB` / `_8KB` suffix to the download filename so the tech sees
 *     the real byte length both in the toast and on disk.
 * Out of scope: changing sync math, programmer comms, re-validating
 * already-saved files. These helpers are pure.
 * ------------------------------------------------------------------------- */

/* moduleSizeBadge — returns { label, color, dataKey } for a module's
 * file size. PCM uses the canonical 95320 / 95640 chip catalog from
 * parseModule.js; the other modules use the same canonical sizes the
 * Sincro engine accepts. Non-canonical PCM sizes fall back to
 * "{N} B · UNKNOWN CHIP" in amber — same wording the per-vehicle
 * Dumps tab uses (Task #485) so the Module Sync, RFH↔PCM, and Dumps
 * surfaces all read identically. Other modules fall back to
 * "{N} KB · OTHER" in amber.
 */
export function moduleSizeBadge(kind, sizeBytes) {
  if (sizeBytes == null) return null;
  const kb = (sizeBytes / 1024).toFixed(sizeBytes % 1024 === 0 ? 0 : 1);
  if (kind === 'pcm') {
    const chip = pcmChipFromSize(sizeBytes);
    if (chip) return { label: chip.label, color: C.a4, dataKey: chip.chipKey, canonical: true };
    return {
      label: `${sizeBytes.toLocaleString()} B · UNKNOWN CHIP`,
      color: C.wn,
      dataKey: 'unknown',
      canonical: false,
    };
  }
  if (kind === 'bcm') {
    if (sizeBytes === 65536)  return { label: '64 KB',  color: C.a3, dataKey: '64kb',  canonical: true };
    if (sizeBytes === 131072) return { label: '128 KB', color: C.a3, dataKey: '128kb', canonical: true };
    return { label: `${kb} KB · OTHER`, color: C.wn, dataKey: 'other', canonical: false };
  }
  if (kind === 'rfh') {
    if (sizeBytes === 2048) return { label: '2 KB · Gen1', color: C.a4, dataKey: '2kb', canonical: true };
    if (sizeBytes === 4096) return { label: '4 KB · Gen2', color: C.a4, dataKey: '4kb', canonical: true };
    if (sizeBytes === 8192) return { label: '8 KB · Trackhawk', color: C.wn, dataKey: '8kb', canonical: true };
    return { label: `${kb} KB · OTHER`, color: C.wn, dataKey: 'other', canonical: false };
  }
  if (kind === 'eep') {
    if (sizeBytes === 8192)  return { label: '8 KB',  color: C.a4, dataKey: '8kb',  canonical: true };
    if (sizeBytes === 16384) return { label: '16 KB', color: C.a4, dataKey: '16kb', canonical: true };
    return { label: `${kb} KB · OTHER`, color: C.wn, dataKey: 'other', canonical: false };
  }
  return { label: `${kb} KB`, color: C.tm, dataKey: 'unknown', canonical: false };
}

/* resizePcmForTargetChip — pad-with-FF or slice the PCM output buffer
 * so the on-disk byte count matches the user's bench chip. Mirrors
 * the bundler's --pcm-chip behaviour:
 *   - target '4kb' + 8 KB input → slice to first 4 KB
 *   - target '8kb' + 4 KB input → 0xFF-pad to 8 KB
 *   - target '4kb' + non-canonical input → truncate (≥4 KB) or 0xFF-pad
 *     (<4 KB) to exactly 4 KB. Same for '8kb' + non-canonical input.
 *     This lets the per-vehicle Dumps tab always emit a chip-shaped
 *     file even when the source dump came in at an odd size — bench
 *     programmers (Multi-PROG / CGDI / Xhorse) only accept exact
 *     4 KB or 8 KB files. The PCM VIN + SEC6 patches all live in the
 *     lower 4 KB of the buffer so truncating to 4 KB keeps the
 *     meaningful patches intact, and the upper half of a 95640 is
 *     unused on these GPEC2A PCMs so 0xFF-padding is safe.
 * Returns { bytes, suffix } where `suffix` is `_4KB` / `_8KB` for use
 * in the download filename. Unknown chip key with canonical input
 * still gets a size-suffixed filename; truly opaque calls pass through.
 */
export function resizePcmForTargetChip(bytes, chipKey) {
  if (!bytes) return { bytes, suffix: '' };
  const fitTo = (target) => {
    if (bytes.length === target) return bytes;
    const out = new Uint8Array(target);
    if (bytes.length >= target) {
      out.set(bytes.subarray(0, target), 0);
    } else {
      out.set(bytes, 0);
      out.fill(0xFF, bytes.length);
    }
    return out;
  };
  if (chipKey === '4kb') {
    if (bytes.length === 4096) return { bytes, suffix: '_4KB' };
    if (bytes.length === 8192) return { bytes: bytes.slice(0, 4096), suffix: '_4KB' };
    return { bytes: fitTo(4096), suffix: '_4KB' };
  }
  if (chipKey === '8kb') {
    if (bytes.length === 8192) return { bytes, suffix: '_8KB' };
    if (bytes.length === 4096) {
      const out = new Uint8Array(8192);
      out.set(bytes, 0);
      out.fill(0xFF, 4096);
      return { bytes: out, suffix: '_8KB' };
    }
    return { bytes: fitTo(8192), suffix: '_8KB' };
  }
  /* Fallback — unknown chip key: keep bytes as-is but still emit a
   * size suffix when the byte count happens to match a canonical chip,
   * so the filename always describes the bytes. */
  if (bytes.length === 4096) return { bytes, suffix: '_4KB' };
  if (bytes.length === 8192) return { bytes, suffix: '_8KB' };
  return { bytes, suffix: '' };
}

/* ----------------------------------------------------------------------------
 * chainBcmFlatRepairIfStale (Task #385)
 *
 * After any sync that updates the live BCM SEC16 split / mirror records, the
 * legacy flat slice at 0x40C9..0x40D8 is stale by definition — pre-Redeye
 * tools (CGDI, Autel, etc.) that still read the flat field would see the
 * old secret. This helper inspects the post-write BCM buffer and, when the
 * resolver picked a live record-table source (split / mirror1 / mirror2)
 * AND the flat slice does not already contain reverse(resolved SEC16),
 * repairs the flat slice in-place and returns the patched bytes.
 *
 * Task #794 — accepts { mode: 'canonical' | 'legacy-flat' } and forwards it
 * to writeBcmFlatSec16. On overlap dumps (mirror1 sitting at 0x40C0) the
 * underlying writer will skip in canonical mode to protect the mirror1
 * payload; that skip is now surfaced as repaired:false / reason:
 * 'overlap-canonical-skip' so callers stop logging a false success and
 * stop labeling the download as "repaired" when no bytes changed.
 *
 * Returns:
 *   { repaired:false, reason:'unresolved-or-blank' | 'flat-only'
 *     | 'already-in-sync' | 'overlap-canonical-skip' | 'buffer-too-small',
 *     resolver, bytes:<input>, mode?, mirror1Overlap?, oldFlatHex? }
 *   { repaired:true,  reason:'stale', resolver, bytes:<patched>,
 *     source, leHex, sec16Hex, oldFlatHex, mode, mirror1Overlap,
 *     mirror1ClobberedAt? }
 *
 * Pure function — caller decides whether to log, download, or chain a row.
 * ---------------------------------------------------------------------------- */
export function chainBcmFlatRepairIfStale(bcmBytes, { mode = 'canonical' } = {}) {
  if (!bcmBytes || bcmBytes.length < 0x40D9) {
    return { repaired: false, reason: 'buffer-too-small', resolver: null, bytes: bcmBytes, mode };
  }
  const r = resolveBcmSec16(bcmBytes);
  if (!r || !r.bytes || r.blank) {
    return { repaired: false, reason: 'unresolved-or-blank', resolver: r, bytes: bcmBytes, mode };
  }
  if (r.source === 'flat') {
    return { repaired: false, reason: 'flat-only', resolver: r, bytes: bcmBytes, mode };
  }
  const cur = bcmBytes.slice(0x40C9, 0x40D9);
  const expectedLe = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expectedLe[i] = r.bytes[15 - i];
  let same = true;
  for (let i = 0; i < 16; i++) if (cur[i] !== expectedLe[i]) { same = false; break; }
  const oldFlatHex = Array.from(cur).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (same) {
    return { repaired: false, reason: 'already-in-sync', resolver: r, bytes: bcmBytes, oldFlatHex, mode };
  }
  const wr = writeBcmFlatSec16(bcmBytes, r.bytes, { mode });
  if (wr.skipped) {
    /* Canonical mode + mirror1 overlap: writer refuses to clobber mirror1.
     * Caller should surface the legacy-flat compatibility mode as the
     * explicit override; do not pretend the file was repaired. */
    return {
      repaired: false,
      reason: 'overlap-canonical-skip',
      resolver: r,
      bytes: bcmBytes,
      oldFlatHex,
      mode,
      mirror1Overlap: !!wr.mirror1Overlap,
    };
  }
  /* Task #678 — fire-and-forget audit log for offline flat-40C9 repair. */
  void logSec16Sync({
    actionId: 'flat-40c9-repair',
    target: 'BCM',
    verified: 'offline',
    notes: `resolver source: ${r.source} · mode: ${mode}${wr.mirror1Overlap ? ' · mirror1 overlap' : ''}`,
    detail: {
      oldFlatHex, newFlatHex: wr.leHex.toUpperCase(),
      sec16Hex: wr.sec16Hex.toUpperCase(),
      mode, mirror1Overlap: !!wr.mirror1Overlap,
    },
  });
  return {
    repaired: true, reason: 'stale', resolver: r,
    bytes: wr.bytes, source: r.source,
    leHex: wr.leHex.toUpperCase(), sec16Hex: wr.sec16Hex.toUpperCase(),
    oldFlatHex,
    mode,
    mirror1Overlap: !!wr.mirror1Overlap,
    mirror1ClobberedAt: wr.mirror1ClobberedAt ?? null,
  };
}

/* ==========================================================================
 * v2 ENGINE — SINCRO-verified algorithms
 * ========================================================================== */

function engCrc16(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) {
    c ^= b << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c & 0xFFFF;
}

export { engParseBcm, engResolveBcmSec16 };

export function engParseRfh(bytes, filename) {
  /* Reject files smaller than a real Yazaki FCM EEPROM (Gen1 24C16, 2 KB).
   * Without this short-circuit the inspector parses partial fragments and
   * surfaces misleading "no VIN" / "SEC16 ✗" verdicts — Task #372 (mirror
   * of the BCM guard added in Task #370). */
  const small = moduleTooSmall(bytes, 'RFHUB', filename);
  if (small) {
    return {
      ok: false, kind: 'RFHUB', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      sec16: null, format: 'unknown',
      partNumbers: [], internalSerial: null, keyCount: 0,
    };
  }
  const r = {
    ok: false, kind: 'RFHUB', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    sec16: null, format: 'unknown',
    partNumbers: [], internalSerial: null, keyCount: 0,
  };

  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > bytes.length) continue;
    const raw = bytes.slice(off, off + 17);
    const rev = new Uint8Array(17);
    for (let i = 0; i < 17; i++) rev[i] = raw[16 - i];
    let vin = '', valid = true;
    for (let i = 0; i < 17; i++) {
      const b = rev[i];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    const storedChk = bytes[off + 17];
    let sum = 0; for (const b of raw) sum = (sum + b) & 0xFF;
    const computedChk = (0xF9 - sum) & 0xFF;
    r.vinSlots.push({ offset: off, vin, storedChk, computedChk, chkOk: storedChk === computedChk });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
  }

  /* SEC16 format detection.
   *
   * Generation is decided by SIZE first — a 24C32 (4 KB) or double-dump (8 KB)
   * is always Gen2; a 24C16 (2 KB) is Gen1 — matching the canonical
   * detectGen() in lib/rfhubKeySlots.js. The 0xAA5531 01 banner at 0x0500 is
   * only a *secondary* hint: real Gen2 EEE Charger dumps store a valid SEC16 at
   * 0x050E while carrying a NON-canonical banner (e.g. FF FF 00 00), so gating
   * Gen2 on the banner alone mislabels them Gen1 and reads garbage from the
   * Gen1 offset 0x0226 — a false SEC16 MISMATCH. Ground truth: RFH EEE slot1
   * @0x050E (see .agents/memory/charger62-bench-set.md). */
  const gen2Hdr = bytes[0x0500] === 0xAA && bytes[0x0501] === 0x55 && bytes[0x0502] === 0x31 && bytes[0x0503] === 0x01;
  const gen2BySize = bytes.length === 4096 || bytes.length === 8192;
  const aeq = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  if ((gen2Hdr || gen2BySize) && bytes.length >= 0x0532) {
    const s1 = bytes.slice(0x050E, 0x051E);   /* 16 bytes */
    const s2 = bytes.slice(0x0522, 0x0532);
    const g2Pop = !s1.every(b => b === 0xFF) && !s1.every(b => b === 0x00);
    r.format = 'gen2';
    r.sec16  = { slot1: s1, slot2: s2, match: aeq(s1, s2), virgin: s1.every(b => b === 0xFF), offsets: [0x050E, 0x0522] };
    if (!g2Pop && bytes.length >= 0x024C) {
      /* Gen2 header but Gen2 slots are empty — fall back to reading Gen1 area */
      const g1 = bytes.slice(0x0226, 0x0236);
      if (!g1.every(b => b === 0xFF) && !g1.every(b => b === 0x00)) {
        r.format = 'gen2-hybrid';
      }
    }
  } else if (bytes.length >= 0x024C) {
    const s1 = bytes.slice(0x0226, 0x0236);   /* 16 bytes (skip 2-byte trailer) */
    const s2 = bytes.slice(0x023A, 0x024A);
    r.format = 'gen1';
    r.sec16  = { slot1: s1, slot2: s2, match: aeq(s1, s2), virgin: s1.every(b => b === 0xFF), offsets: [0x0226, 0x023A] };
  }

  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
  const partsSet = new Set();
  (text.match(/(?:AA\d{8}|BA\d{8})/g) || []).forEach(p => partsSet.add(p));
  r.partNumbers = Array.from(partsSet);
  const ser = text.match(/\d{4}[A-Z]\d{3,4}[A-Z]{2}\d{2}[A-Z]/);
  if (ser) r.internalSerial = ser[0];

  const KEY_START = 0x08C0, KEY_END = 0x0A60, KEY_STRIDE = 48;
  for (let off = KEY_START; off < KEY_END && off + 16 < bytes.length; off += KEY_STRIDE) {
    const head = bytes.slice(off, off + 8);
    if (!Array.from(head).every(b => b === 0x50 || b === 0x5A || b === 0xFF)) r.keyCount++;
  }

  /* Virgin chip detection — factory-fresh RFHUB has all four VIN slots
   * filled with 0x30 ('0') bytes (Yazaki default placeholder) and blank
   * SEC16 slots. These chips are valid write targets for BCM→RFHUB SEC16
   * programming and must be accepted as loaded sources. */
  if (r.vin === null && r.vinSlots.length === 0) {
    const reachableOffsets = RFH_VIN_OFFSETS.filter(o => o + 17 <= bytes.length);
    const virginVinCount = reachableOffsets.filter(off => {
      const raw = bytes.slice(off, off + 17);
      return Array.from(raw).every(b => b === 0x30);
    }).length;
    if (reachableOffsets.length > 0 && virginVinCount === reachableOffsets.length) {
      r.virginChip = true;
    }
  }
  r.ok = r.vin !== null || r.virginChip === true;
  return r;
}

export function engParsePcm(bytes, filename) {
  /* Reject files smaller than a real GPEC2A image (4 KB). Partial PCM dumps
   * would otherwise yield empty VIN slot lists and a fake "IMMO ✗" verdict
   * — Task #372. */
  const small = moduleTooSmall(bytes, 'PCM', filename);
  if (small) {
    return {
      ok: false, kind: 'PCM', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      currentVin: null, originalVin: null,
      sec6: null, immoOk: false, immoDamaged: false,
      variant: 'GPEC2A',
      continentalPn: null, osPn: null, bodyPn: null,
      continentalPnCandidates: [], osPnCandidates: [], bodyPnCandidates: [],
    };
  }
  const r = {
    ok: false, kind: 'PCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    currentVin: null, originalVin: null,
    sec6: null, immoOk: false, immoDamaged: false,
    variant: 'GPEC2A',
    continentalPn: null, osPn: null, bodyPn: null,
    /* Task #464 — surface every candidate the regex finds (additive: the
     * chosen value above is still the first match, byte-output unchanged)
     * so the SINCRO-style PICK breakdown can rank a real candidate set
     * instead of scoring a degenerate single-element list. */
    continentalPnCandidates: [], osPnCandidates: [], bodyPnCandidates: [],
  };

  for (const off of PCM_VIN_OFFSETS_GPEC2A) {
    if (off + 17 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < 17; k++) {
      const b = bytes[off + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (valid && VIN_RE.test(vin)) r.vinSlots.push({ offset: off, vin });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
    r.currentVin  = r.vinSlots[0].vin;
    if (r.vinSlots.length > 1) r.originalVin = r.vinSlots[r.vinSlots.length - 1].vin;
  }

  /* IMMO byte @0x0011..0x0014 — primary positive pairing signal on
   * 4 KB GPEC2A. Present on every variant including MY2019 builds
   * where SEC6 @0x3C8 is left blank. The bootloader keys off this
   * 32-bit slot:
   *   80 00 00 00 = ENABLED  (paired and active)
   *   00 00 00 00 = DISABLED (intentionally bypassed / PATS-off)
   *   FF FF FF FF = VIRGIN   (uninitialized / damaged)
   * anything else = OTHER    (unknown layout — stay neutral). */
  if (bytes.length > 0x14) {
    const ib = bytes.slice(0x0011, 0x0015);
    let state = 'OTHER';
    if (ib[0] === 0x80 && ib[1] === 0x00 && ib[2] === 0x00 && ib[3] === 0x00) state = 'ENABLED';
    else if (ib[0] === 0x00 && ib[1] === 0x00 && ib[2] === 0x00 && ib[3] === 0x00) state = 'DISABLED';
    else if (ib[0] === 0xFF && ib[1] === 0xFF && ib[2] === 0xFF && ib[3] === 0xFF) state = 'VIRGIN';
    r.immoByte = { offset: 0x0011, bytes: ib, state };
  }

  /* SEC6 detection (hardened in Task #396).
   *   1. Canonical 0x3C8 read on 4 KB / 8 KB images — this is the same
   *      offset parseModule.js uses, so a virgin GPEC2A (e.g. the
   *      incident's FF FF 00 FF FF FF) is read from the right slot
   *      instead of being fabricated from FF padding elsewhere.
   *   2. FF FF FF AA marker scan (legacy GPEC2A path).
   *   3. FF FF FF FF marker scan, gated on the populated classifier
   *      so 4 KB virgin padding noise can no longer slip through. */
  if (bytes.length >= 0x3CE) {
    // For any GPEC2A-sized image trust the canonical slot — matches
    // parseModule.js so the wizard and the AI assistant never disagree
    // about whether SEC6 is populated.
    // Task #404 — also read the FF FF FF AA marker at 0x3C4 so a
    // populated 6-byte secret with a missing marker (the user-reported
    // regression) is correctly flagged as IMMO_DAMAGED.
    const slot = bytes.slice(0x3C8, 0x3CE);
    const markerBytes = bytes.slice(0x3C4, 0x3C8);
    const markerOk = markerBytes[0] === 0xFF && markerBytes[1] === 0xFF
                  && markerBytes[2] === 0xFF && markerBytes[3] === 0xAA;
    r.sec6 = {
      offset: 0x3C8, bytes: slot, marker: 'canonical 0x3C8',
      markerOffset: 0x3C4, markerBytes, markerOk,
    };
  } else {
    // Sub-canonical fragment — fall back to marker scans, gated on
    // the populated classifier so virgin padding noise can no longer
    // slip through (Task #396).
    for (let i = 0; i < bytes.length - 10; i++) {
      if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xAA) {
        const candidate = bytes.slice(i+4, i+10);
        if (classifyPcmSec6(candidate).populated) {
          r.sec6 = { offset: i+4, bytes: candidate, marker: 'FF FF FF AA' };
          break;
        }
      }
    }
    if (!r.sec6) {
      for (let i = 0; i < bytes.length - 20; i++) {
        if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xFF) {
          const n6 = bytes.slice(i+4, i+10);
          if (classifyPcmSec6(n6).populated) {
            r.sec6 = { offset: i+4, bytes: n6, marker: 'FF FF FF FF' };
            break;
          }
        }
      }
    }
  }
  if (r.sec6) {
    r.sec6Class = classifyPcmSec6(r.sec6.bytes);
    // Task #404 — populated 6 bytes alone is not enough; the canonical
    // FF FF FF AA marker at 0x3C4 must also be present for the PCM
    // bootloader (and CGDI/Autel/AlfaOBD/SINCRO) to honor the slot.
    const markerOk = r.sec6.markerOk !== false;
    const populated = r.sec6Class.populated;
    /* Two independent pairing signals on a 4 KB GPEC2A:
     *
     *   A. IMMO byte @0x0011..0x0014 (primary, present on every variant
     *      including the MY2019 builds where SEC6 isn't populated):
     *        80 00 00 00 = IMMO ENABLED  (positive pairing signal)
     *        00 00 00 00 = IMMO DISABLED (intentionally bypassed)
     *        FF FF FF FF = IMMO VIRGIN/DAMAGED
     *
     *   B. SEC6 secret @0x3C8 + FF FF FF AA marker @0x3C4 (legacy
     *      Continental scheme, only populated on some builds): if the
     *      6 bytes look populated, the marker MUST also be present —
     *      that's the Task #404 damage case.
     *
     * We trust whichever signal speaks. ENABLED IMMO byte is enough
     * to call the dump paired even when SEC6 is all-FF (the running-
     * car case the user reported). The only red DAMAGED verdict is
     * the explicit Task #404 case (populated SEC6 with stripped
     * marker) — every other "missing" pattern stays neutral. */
    r.immoDamaged = populated && !markerOk;
    if (populated && markerOk) {
      r.immoOk = true;
      r.immoLabel = r.sec6Class.label;
    } else if (r.immoDamaged) {
      r.immoOk = false;
      r.immoLabel = 'SEC6 marker missing (FF FF FF AA expected at 0x3C4)';
    } else if (r.immoByte && r.immoByte.state === 'ENABLED') {
      r.immoOk = true;
      r.immoLabel = `IMMO ENABLED @0x0011 (80 00 00 00) \u2014 SEC6 not used on this variant`;
    } else if (r.immoByte && r.immoByte.state === 'DISABLED') {
      r.immoOk = true;
      r.immoLabel = `IMMO DISABLED @0x0011 (00 00 00 00) \u2014 PATS-bypass, no pairing required`;
    } else {
      r.immoOk = true;
      r.immoLabel = `${r.sec6Class.label} \u2014 no SEC6 fingerprint at canonical offset`;
    }
    r.immoUnpaired = false;
  } else {
    r.sec6Class = classifyPcmSec6(null);
    r.immoUnpaired = false;
    if (r.immoByte && r.immoByte.state === 'ENABLED') {
      r.immoOk = true;
      r.immoDamaged = false;
      r.immoLabel = `IMMO ENABLED @0x0011 (80 00 00 00) \u2014 SEC6 region absent`;
    } else if (r.immoByte && r.immoByte.state === 'DISABLED') {
      r.immoOk = true;
      r.immoDamaged = false;
      r.immoLabel = `IMMO DISABLED @0x0011 (00 00 00 00) \u2014 PATS-bypass, no pairing required`;
    } else {
      r.immoOk = false;
      r.immoDamaged = true;
      r.immoLabel = 'DAMAGED / MISSING';
    }
  }

  if (bytes.length > 0x0FB0) {
    const pnB = bytes.slice(0x0FA1, 0x0FAE);
    const pn  = new TextDecoder('latin1').decode(pnB);
    if (/^A2C\d/.test(pn)) r.continentalPn = pn.trim();
  }
  const text = new TextDecoder('latin1').decode(bytes);
  /* Gather every regex hit so the SINCRO-style PICK breakdown can rank
   * the full candidate set (Task #464). The chosen value remains the
   * first hit so the writer's input is unchanged. */
  const osHits   = [...new Set([...text.matchAll(/\b0[0-9]{7}[A-Z]{2}\b/g)].map(m => m[0]))];
  const bpHits   = [...new Set([...text.matchAll(/\b68[0-9]{6}[A-Z]{2}\b/g)].map(m => m[0]))];
  const contHits = [...new Set([...text.matchAll(/\bA2C\d{6,12}\b/g)].map(m => m[0]))];
  r.osPnCandidates   = osHits;
  r.bodyPnCandidates = bpHits;
  /* Prefer the canonical fixed-offset Continental hit when present. */
  r.continentalPnCandidates = r.continentalPn
    ? [r.continentalPn, ...contHits.filter(h => h !== r.continentalPn)]
    : contHits;
  if (osHits.length > 0) r.osPn = osHits[0];
  if (bpHits.length > 0) r.bodyPn = bpHits[0];

  r.ok = r.vin !== null || r.sec6 !== null;
  return r;
}

/* ---------- skip-reason helpers ---------- */

/* Task #433 — single source of truth for "why was PCM SEC6 NOT written?"
 * used by every action that conditionally calls writePcmSec6 (full sync,
 * SEC16-only). Returns null when the SEC6 step is safe to run, or a
 * short human-readable reason string otherwise. Reasons are deliberately
 * the same wording across call sites so users see a consistent line in
 * the sync log: `PCM SEC6 skipped: <reason>`. */
export function pcmSec6SkipReason({ rfh, pcm }) {
  if (!rfh?.bytes)            return 'no RFH file loaded';
  if (!rfh.parsed)            return 'RFH file could not be parsed';
  if (rfh.parsed.format === 'gen1') return 'RFH is Gen1 (need Gen2)';
  const slot1 = rfh.parsed.sec16?.slot1;
  if (!slot1 || slot1.length < 6)   return 'RFH SEC16 not readable';
  /* Virgin RFHUB chips (factory 0x30-fill, blank SEC16) are valid write
   * targets for BCM→RFHUB SEC16 programming — do NOT block them here.
   * pcmSec6SkipReason is only for reading SEC16 FROM the RFHUB to derive
   * PCM SEC6; writing TO a virgin RFHUB is handled by bcmToRfhSec16Ok. */
  if (rfh.parsed.sec16?.virgin && !rfh.parsed.virginChip) return 'RFH SEC16 not readable (virgin)';
  if (!pcm?.bytes)            return 'no PCM file loaded';
  if (!pcm.parsed)            return 'PCM file could not be parsed';
  const sz = pcm.bytes.length;
  if (sz !== 4096 && sz !== 8192)
    return `non-canonical PCM size (${sz} B, need 4096 or 8192)`;
  return null;
}

/* ---------- write helpers (SINCRO-verified) ---------- */

export function engWriteBcmVin(bytes, newVin) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const vb  = new TextEncoder().encode(newVin);
  const tb  = vb.slice(9, 17);
  const fullCrc = engCrc16(vb);
  const tailCrc = engCrc16(tb);
  let fullPatched = 0, shortPatched = 0;

  for (let i = 0; i < out.length - 21; i++) {
    if (out[i] !== 0x00 || out[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(out[i+2])) continue;
    if (out[i+3] !== 0x00) continue;
    const vs = i + 4; if (vs + 19 > out.length) continue;
    let curr = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = out[vs + k]; if (b < 0x20 || b > 0x7E) { valid = false; break; } curr += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(curr)) continue;
    for (let k = 0; k < 17; k++) out[vs + k] = vb[k];
    out[vs + 17] = (fullCrc >> 8) & 0xFF;
    out[vs + 18] = fullCrc & 0xFF;
    fullPatched++;
  }
  /* Short / tail slots (8-byte VIN tail + 2-byte CRC) */
  for (let i = 0; i < out.length - 14; i++) {
    if (out[i] !== 0x00 || out[i+1] !== 0x46) continue;
    if (out[i+3] !== 0x00) continue;
    const vs = i + 4; if (vs + 10 > out.length) continue;
    let isTail = true, tail = '';
    for (let k = 0; k < 8; k++) {
      const b = out[vs + k];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { isTail = false; break; }
      tail += String.fromCharCode(b);
    }
    if (!isTail) continue;
    let looksFull = vs + 17 <= out.length;
    if (looksFull) {
      for (let k = 8; k < 17; k++) {
        const b = out[vs + k];
        if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { looksFull = false; break; }
      }
    }
    if (looksFull) continue; /* skip — it's a full slot */
    for (let k = 0; k < 8; k++) out[vs + k] = tb[k];
    out[vs + 8] = (tailCrc >> 8) & 0xFF;
    out[vs + 9] = tailCrc & 0xFF;
    shortPatched++;
  }
  return { bytes: out, fullPatched, shortPatched, crc: fullCrc };
}

export function engWriteRfhVin(bytes, newVin, virginize) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const fwd = new TextEncoder().encode(newVin);
  const rev = new Uint8Array(17); for (let i = 0; i < 17; i++) rev[i] = fwd[16 - i];
  let sum = 0; for (const b of rev) sum = (sum + b) & 0xFF;
  const chk = (0xF9 - sum) & 0xFF;
  let patched = 0;
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = rev[k];
    out[off + 17] = chk;
    patched++;
  }
  let sec16Wiped = 0;
  if (virginize) {
    const gen2Hdr = out[0x0500] === 0xAA && out[0x0501] === 0x55;
    const slots = gen2Hdr ? [0x050E, 0x0522] : [0x0226, 0x023A];
    for (const so of slots) {
      if (so + 18 > out.length) continue;
      for (let k = 0; k < 18; k++) out[so + k] = 0xFF;
      sec16Wiped++;
    }
  }
  return { bytes: out, patched, sec16Wiped, chk };
}

/* engWriteBcmSec16Gen2 / engWritePcmSec6 / engWriteRfhSec16FromBcm
 * extracted to lib/securityBytes.js — single source of truth, golden-vector
 * regression test in lib/__tests__/securityBytes.golden.test.js. */
const engWriteBcmSec16Gen2 = writeBcmSec16Gen2;
const engWritePcmSec6      = writePcmSec6;

function engWritePcmVin(bytes, newVin) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const vb  = new TextEncoder().encode(newVin);
  let patched = 0;
  for (const off of PCM_VIN_OFFSETS_GPEC2A) {
    if (off + 17 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = vb[k];
    patched++;
  }
  return { bytes: out, patched };
}

// engWriteRfhSec16FromBcm — routes to the correct writer based on RFHUB format
const engWriteRfhSec16FromBcm = (bytes, bcmSec16, format) => {
  if (format === 'gen1') return writeRfhSec16Gen1(bytes, bcmSec16);
  if (format === 'gen2-hybrid') return writeRfhSec16Gen2Slots(bytes, bcmSec16);
  return writeRfhSec16FromBcm(bytes, bcmSec16);
};

/* ==========================================================================
 * VEHICLE CATALOG — part-number awareness
 * ========================================================================== */

/* For 68525720/68525721 the gen is determined by VIN model-year char (see bcmVehicleMatch). */
const BCM_PN_VEHICLES = {
  '68525720':      { name: 'Charger / Challenger / Durango (2011-2014 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68525720_gen2': { name: '2021+ Redeye / Scat Pack · Charger (gen2-split)',      gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68525721':      { name: 'Charger / Challenger / Durango (2011-2014 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68525721_gen2': { name: '2021+ Redeye / Scat Pack · Charger (gen2-split)',      gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68277389': { name: 'Charger / Challenger / Durango (2015-2017 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68396561': { name: 'Charger / Challenger / Durango (2018-2020 LD/LC/WD)', gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68396563': { name: 'Charger / Challenger / Durango (2018-2020 LD/LC/WD)', gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68354769': { name: 'Grand Cherokee Trackhawk (2018-2021 WK2)',             gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68463847': { name: 'Ram 1500 TRX (2021-2024 DT)',                          gen: 'gen2', sec: 'Gen2 SEC16 split' },
};

/* Model-year chars that indicate a 2018+ vehicle (per SAE J681 VIN standard).
 * Used to disambiguate part numbers shared between gen1 and gen2-split Redeye modules. */
const REDEYE_AMBIGUOUS_PNS = ['68525720', '68525721'];
const GEN2_YEAR_CHARS_SYNC = new Set(['J','K','L','M','N','P','R','S','T']);

/* Vehicle family definitions — used for the mismatch warning selector */
const VEHICLE_FAMILIES = [
  { id: 'charger',    label: 'Dodge Charger (LX/LD · 2011–2023)',         expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'challenger', label: 'Dodge Challenger (LC · 2011–2023)',          expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'durango',    label: 'Dodge Durango (WD · 2011–2023)',             expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'trackhawk',  label: 'Grand Cherokee Trackhawk (WK2 · 2018–2021)', expectedPns: ['68354769'] },
  { id: 'trx',        label: 'Ram 1500 TRX (DT · 2021–2024)',              expectedPns: ['68463847'] },
];

function bcmVehicleMatch(parsedBcm) {
  if (!parsedBcm || !parsedBcm.partNumbers) return null;
  /* Extract model-year char from the parsed VIN (10th character, index 9). */
  const vinYearChar = parsedBcm.vin ? parsedBcm.vin[9] : null;
  for (const pn of parsedBcm.partNumbers) {
    const trimmed = pn.replace(/[^0-9]/g, '');
    if (REDEYE_AMBIGUOUS_PNS.includes(trimmed)) {
      const isGen2 = vinYearChar && GEN2_YEAR_CHARS_SYNC.has(vinYearChar.toUpperCase());
      const key = isGen2 ? trimmed + '_gen2' : trimmed;
      if (BCM_PN_VEHICLES[key]) return { pn: trimmed, ...BCM_PN_VEHICLES[key] };
    }
    if (BCM_PN_VEHICLES[trimmed]) return { pn: trimmed, ...BCM_PN_VEHICLES[trimmed] };
  }
  return null;
}

function bcmFamilyMismatch(parsedBcm, familyId) {
  if (!familyId || !parsedBcm?.partNumbers?.length) return null;
  const family = VEHICLE_FAMILIES.find(f => f.id === familyId);
  if (!family) return null;
  const detected = parsedBcm.partNumbers.map(p => p.replace(/[^0-9]/g, ''));
  const match = family.expectedPns.some(ep => detected.includes(ep));
  if (match) return { match: true, family, detected };
  return { match: false, family, detected, expected: family.expectedPns };
}

/* ==========================================================================
 * UTILITIES
 * ========================================================================== */

function hex2(n)  { return n.toString(16).toUpperCase().padStart(2,  '0'); }
function hex4(n)  { return n.toString(16).toUpperCase().padStart(4,  '0'); }
function bytesToHex(b) { return Array.from(b).map(hex2).join(''); }

/* fmtOff (Task #464) — combined hex + decimal offset render. Mirrors the
 * FCA SINCRO reference tool's compact "0x1328 (4904)" notation so a tech
 * reading the screen alongside a hex editor doesn't have to convert in
 * their head. Centralised here so every place ModuleSync renders an
 * offset stays identical, and reused by the offset-formatter unit test. */
export function fmtOff(o) {
  if (o == null || (typeof o === 'number' && !Number.isFinite(o))) return '—';
  const n = Number(o);
  if (Number.isNaN(n)) return '—';
  const hex = n.toString(16).toUpperCase().padStart(4, '0');
  return `0x${hex} (${n})`;
}
function timestamp() {
  const d = new Date(), p = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function downloadBin(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  trackDownload(ASSET_IDS.modSyncPatched);
}

/* ==========================================================================
 * UI COMPONENTS
 * ========================================================================== */

/* ConnectionGuides (Task #464) — compact per-module link row for the bench
 * tools / programmers a tech is most likely to be holding. Surfaces the
 * MODULE_CONNECTION_GUIDES table from programmerData.js so a Charger /
 * Challenger LX workflow shows: BCM (MPC560xB) → MULTIPROG · UPA, PCM
 * (GPEC2A) → GODIAG, RFH (9S12X) → MULTIPROG · UPA · OBDSTAR. The row
 * collapses to a vertical stack on narrow widths and is purely advisory —
 * it never blocks any sync action. */
function ConnectionGuides() {
  return (
    <div data-testid="modsync-connection-guides" style={{
      display: 'flex', flexWrap: 'wrap', gap: 14,
      padding: '10px 14px', marginBottom: 12,
      background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10,
      fontSize: 11,
    }}>
      <div style={{ fontWeight: 800, color: C.ts, letterSpacing: 0.6, textTransform: 'uppercase', alignSelf: 'center', whiteSpace: 'nowrap' }}>
        🛠 Connection Guides
      </div>
      {MODULE_CONNECTION_GUIDES.map(group => (
        <div key={group.module}
             data-testid={`modsync-guides-${group.module.toLowerCase()}`}
             style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, color: C.tx }}>{group.label}</span>
          <span style={{ color: C.tm }}>→</span>
          {group.guides.map((g, idx) => {
            const prog = PROGRAMMERS[g.programmer];
            const label = prog?.label || g.programmer;
            return (
              <React.Fragment key={g.programmer}>
                {idx > 0 && <span style={{ color: C.tm, fontSize: 10 }}>·</span>}
                <a href={g.url} target="_blank" rel="noopener noreferrer"
                   data-testid={`modsync-guide-link-${group.module.toLowerCase()}-${g.programmer.toLowerCase()}`}
                   title={`${group.label} — ${label} (${prog?.vendor || ''}) connection guide`}
                   style={{
                     color: C.a3, textDecoration: 'none', fontWeight: 700,
                     padding: '2px 6px', borderRadius: 4,
                     border: `1px solid ${C.a3}30`, background: C.cd,
                   }}>
                  {label}
                </a>
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* FilePicker — flat <input type="file"> picker used for BCM and RFHUB in the
 * Step-1 card. Displays filename + byte count after selection. Resets the
 * input value after read so the same file can be re-loaded after a reset. */
function FilePicker({ label, subtitle, file, onFile, accept = ".bin,.BIN,.eprom", testid }) {
  const handleChange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    onFile(f, new Uint8Array(buf));
    e.target.value = '';
  };
  return (
    <div style={{ flex: 1, minWidth: 200 }}>
      <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 4, color: C.tx }}>{label}</div>
      <input
        type="file"
        accept={accept}
        data-testid={testid}
        onChange={handleChange}
        style={{ display: 'block', width: '100%', cursor: 'pointer', fontSize: 12, padding: '4px 0', fontFamily: "'Nunito'" }}
      />
      <div style={{ fontSize: 11, color: C.ts, marginTop: 3 }}>{subtitle}</div>
      {file && (
        <div style={{
          fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.gn, marginTop: 6,
          fontWeight: 700, wordBreak: 'break-all',
        }}>
          ✓ {file.name} · {file.size.toLocaleString()} B
        </div>
      )}
    </div>
  );
}

function DropZone({ label, icon, hint, file, onFile, accent, badge, badgeTestid, repaired }) {
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const loaded  = file != null;
  const handle  = async (f) => {
    const buf = await f.arrayBuffer();
    onFile(f, new Uint8Array(buf));
  };
  const border  = loaded ? C.gn : over ? (accent || C.sr) : C.bd;
  return (
    <div
      onClick={() => fileRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); }}
      style={{
        background: loaded ? 'rgba(0,200,83,0.03)' : over ? 'rgba(211,47,47,0.03)' : C.cd,
        border: `2px ${loaded ? 'solid' : 'dashed'} ${border}`,
        borderRadius: 14, padding: '22px 14px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.2s',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 5 }}>{icon}</div>
      <div style={{ fontFamily: "'Nunito'", fontWeight: 800, fontSize: 13, letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.tm, marginTop: 4 }}>{hint}</div>
      {loaded && (
        <>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, marginTop: 6, color: C.gn, fontWeight: 600, wordBreak: 'break-all' }}>
            {file.name}
          </div>
          {/* Task #475 — surface the exact byte count + chip-variant badge
              so the tech can spot a wrong-sized PCM (or partial BCM/RFH/EEP
              dump) before they hit Generate and the programmer rejects it
              with "File different size." */}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts, fontWeight: 600 }}>
              {file.size.toLocaleString()} B · {(file.size / 1024).toFixed(file.size % 1024 === 0 ? 0 : 1)} KB
            </span>
            {badge && (
              <span data-testid={badgeTestid}
                    data-size-key={badge.dataKey}
                    data-size-canonical={badge.canonical ? '1' : '0'}
                    style={{
                      fontSize: 9, padding: '2px 7px', borderRadius: 4, letterSpacing: 0.6,
                      background: badge.color, color: '#fff', fontWeight: 800,
                    }}>{badge.label}</span>
            )}
          </div>
          {/* Task #1056 — "✓ Repaired" badge after Pairing Repair patches this slot */}
          {repaired && (
            <div style={{ marginTop: 6 }}>
              <span
                data-testid={`modsync-repaired-badge-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                style={{
                  display: 'inline-block', fontSize: 9, fontWeight: 800,
                  padding: '2px 8px', borderRadius: 10, letterSpacing: 0.6,
                  background: C.gn + '22', color: C.gn,
                  border: `1px solid ${C.gn}55`,
                }}>
                ✓ Repaired
              </span>
            </div>
          )}
        </>
      )}
      <input ref={fileRef} type="file" accept=".bin,.BIN,.eprom" style={{ display: 'none' }}
             onChange={e => { if (e.target.files[0]) handle(e.target.files[0]); }} />
    </div>
  );
}

function Kv({ k, v, mono = false, hint, color }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '3px 10px', fontSize: 12, marginBottom: 5, alignItems: 'start' }}>
      <div style={{ color: C.ts, fontWeight: 600 }}>{k}</div>
      <div style={{
        fontFamily: mono ? "'JetBrains Mono'" : "'Nunito'", fontWeight: 600,
        color: color || (v ? C.tx : C.tm), fontStyle: v ? 'normal' : 'italic',
        fontSize: mono ? 11 : 12, wordBreak: 'break-all',
      }}>
        {v || 'none'}{hint && <span style={{ color: C.tm, fontSize: 10, marginLeft: 6 }}>{hint}</span>}
      </div>
    </div>
  );
}

function Badge({ text, color = C.gn }) {
  return (
    <span style={{
      fontSize: 9, padding: '2px 7px', borderRadius: 4, letterSpacing: 0.6,
      background: color, color: '#fff', fontWeight: 700, marginLeft: 4,
    }}>{text}</span>
  );
}

function PnOverrideBadge() {
  return (
    <span data-testid="modsync-pn-override-pill" style={{
      fontSize: 9, padding: '2px 7px', borderRadius: 999, letterSpacing: 0.6,
      background: C.wn + '22', border: '1px solid ' + C.wn + '66', color: C.wn,
      fontWeight: 800, marginLeft: 4,
    }}>P/N OVERRIDE</span>
  );
}

/* OffsetList (Task #464) — small dimmed mono row that lists each slot's
 * canonical hex+decimal offset under a Kv summary line. Centralises the
 * styling so BCM / RFH / PCM cards stay visually consistent. */
function OffsetList({ offsets, testid }) {
  if (!offsets || offsets.length === 0) return null;
  return (
    <div data-testid={testid} style={{
      fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'",
      marginTop: -2, marginBottom: 6, paddingLeft: 130, lineHeight: 1.5,
      wordBreak: 'break-all',
    }}>
      {offsets.map(o => fmtOff(o)).join(' · ')}
    </div>
  );
}

/* PickBreakdown (Task #464) — dimmed one-liner under each module panel
 * showing the SINCRO-style "PICK score X — useful Y, ratio Z, len N, pr R"
 * scoring breakdown for a single field (PN / Serial / OS). The kind label
 * lets a tech see at a glance which field the score belongs to without
 * pushing the breakdown into a popup. */
function PickBreakdown({ kind, value, breakdown, testid }) {
  if (!value || !breakdown) return null;
  return (
    <div data-testid={testid} style={{
      fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'",
      marginTop: 2, lineHeight: 1.5, paddingLeft: 130,
    }}>
      <span style={{ color: C.ts, fontWeight: 700, marginRight: 6 }}>{kind}</span>
      <span style={{ color: C.tx }}>{value}</span>
      <span style={{ marginLeft: 6, color: C.tm }}>— {fmtPick(breakdown)}</span>
    </div>
  );
}

/* buildCandidateList (Task #464) — turns the raw multi-candidate array
 * the parser already gathered into the shape pickBest() expects, tagging
 * each entry with its precedenceRank (1.0 for the canonical-offset hit
 * sitting at index 0, 0.5 for fallback regex hits further down the list)
 * and a matchesCanonical flag so the SINCRO-style +100 bonus fires for
 * the right entries. The chosen winner the picker returns is what gets
 * rendered in the PickBreakdown line, replacing the previous behaviour
 * of "trust the parser's first hit, then score it after the fact". */
function buildCandidateList(values, canonicalRegex) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values.map((v, idx) => ({
    value: v,
    precedenceRank: idx === 0 ? 1.0 : 0.5,
    matchesCanonical: canonicalRegex ? canonicalRegex.test(String(v)) : false,
  }));
}

function BcmCard({ parsed, pnOverride, fullyVirgin, filename, fileSize }) {
  if (!parsed) return null;
  if (parsed.tooSmall) {
    return (
      <div data-testid="bcm-too-small-card" style={{ background: 'rgba(255,23,68,0.05)', borderRadius: 12, padding: 16, border: `2px solid ${C.er}`, gridColumn: '1 / -1' }}>
        <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: C.er, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          ⛔ This isn&apos;t a full BCM dump
          <Badge text="REJECTED" color={C.er} />
        </div>
        <Kv k="File size"   v={`${parsed.size.toLocaleString()} bytes`} mono color={C.er} />
        <Kv k="Required min" v={`${parsed.minSize.toLocaleString()} bytes (64 KB MPC5605B/06B DFLASH)`} mono />
        <Kv k="Detected ext" v={parsed.fileExt || '(none)'} mono />
        <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(255,23,68,0.08)', border: `1px solid ${C.er}55`, borderRadius: 8, fontSize: 12, color: C.tx, lineHeight: 1.5, fontWeight: 600 }}>
          Re-read the BCM in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.
        </div>
      </div>
    );
  }

  /* Derive RFH view (byte-reversed BCM SEC16) for the SEC16 (BCM) section. */
  const sec16HexUp = parsed.sec16Hex ? parsed.sec16Hex.toUpperCase() : null;
  const bcmRfhViewHex = sec16HexUp
    ? (sec16HexUp.match(/.{2}/g) || []).reverse().join('')
    : null;

  return (
    <div data-testid="modsync-bcm-card" style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${C.bd}` }}>

      {/* Header row: filename + chip badge + size badge */}
      {(() => {
        const _bcmSz = fileSize ?? parsed.size ?? null;
        const _bcmBadge = moduleSizeBadge('bcm', _bcmSz);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontWeight: 900, fontSize: 11, color: C.tx, fontFamily: "'JetBrains Mono'", wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
              {filename || 'BCM'}
            </span>
            <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: C.a3, color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>
              MPC5606B_05B
            </span>
            {_bcmBadge ? (
              <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: C.ts, color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {_bcmBadge.label}
              </span>
            ) : (
              <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: C.ts, color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {_bcmSz != null ? `${_bcmSz.toLocaleString()} bytes` : ''}
              </span>
            )}
            {pnOverride && <PnOverrideBadge />}
          </div>
        );
      })()}

      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this BCM bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}

      {/* VIN (BCM) section */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
          VIN (BCM)
        </div>
        <div style={{ fontSize: 10, color: C.tm, marginBottom: 2 }}>Stored VIN:</div>
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700, color: parsed.vin ? C.tx : C.tm, marginBottom: 3 }}>
          {parsed.vin || '— none —'}
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 5 }}>
          Copies: {parsed.vinSlots?.length ?? 0}
        </div>
        {parsed.vinSlots?.map((slot, idx) => {
          const ok = slot.crcOk;
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
              <span style={{ color: C.ts, minWidth: 46, flexShrink: 0 }}>VIN {idx + 1}</span>
              <span style={{
                fontSize: 9, padding: '1px 6px', borderRadius: 4,
                background: ok ? C.gn : C.er, color: '#fff', fontWeight: 800, letterSpacing: 0.5,
              }}>{ok ? 'CS OK' : 'CS FAIL'}</span>
            </div>
          );
        })}
      </div>

      {/* SEC16 (BCM) section */}
      <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
          SEC16 (BCM)
        </div>
        <div style={{ fontSize: 11, marginBottom: 3, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: C.ts, fontWeight: 600, flexShrink: 0 }}>SEC16 BCM:</span>
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: sec16HexUp ? C.tx : C.tm, fontWeight: 600, wordBreak: 'break-all' }}>
            {sec16HexUp || '— none —'}
          </span>
        </div>
        <div style={{ fontSize: 11, marginBottom: 3, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: C.ts, fontWeight: 600, flexShrink: 0 }}>SEC16 RFH (view):</span>
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: bcmRfhViewHex ? C.a4 : C.tm, fontWeight: 600, wordBreak: 'break-all' }}>
            {bcmRfhViewHex ? `= ${bcmRfhViewHex}` : '—'}
          </span>
        </div>
        <div style={{ fontSize: 10, color: C.tm, fontStyle: 'italic' }}>
          RFH view = byte-reverse of BCM SEC16
        </div>
      </div>

      {/* SEC16 MAIN section */}
      <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 4 }}>
          SEC16 MAIN
        </div>
        <div style={{ fontSize: 11, color: C.tx, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Total: {parsed.sec16Records?.length ?? 0}</span>
          {parsed.sec16Records && parsed.sec16Records.length > 0 && (
            <span style={{
              fontSize: 9, padding: '1px 6px', borderRadius: 4,
              background: parsed.sec16Consistent ? C.gn : C.wn, color: '#fff', fontWeight: 800,
            }}>
              {parsed.sec16Consistent ? 'Consistent' : 'MISMATCH'}
            </span>
          )}
        </div>
        <OffsetList offsets={parsed.sec16Records?.map(x => x.offset)} testid="bcm-sec16-split-offsets" />
      </div>

      {/* SEC16 MIRRORS (WITH CRC) section */}
      {parsed.sec16Mirrors && parsed.sec16Mirrors.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
            SEC16 MIRRORS (WITH CRC)
          </div>
          {parsed.sec16Mirrors.map((mirror, idx) => {
            const ok = mirror.crcOk;
            const populated = mirror.populated;
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: C.ts, minWidth: 52, flexShrink: 0 }}>Mirror {idx + 1}</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: ok ? C.gn : (populated ? C.er : C.tm),
                  color: '#fff', fontWeight: 800, letterSpacing: 0.5,
                }}>{ok ? 'CS OK' : (populated ? 'CS FAIL' : 'BLANK')}</span>
              </div>
            );
          })}
          <OffsetList offsets={parsed.sec16Mirrors.map(m => m.offset)} testid="bcm-sec16-mirror-offsets" />
        </div>
      )}

      {fullyVirgin && (
        <div data-testid="bcm-virgin-sec16-badge"
             style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(255,109,0,0.10)', border: `1.5px solid ${C.a1}55`, borderRadius: 8, fontSize: 11, color: C.a1, fontWeight: 800, letterSpacing: 0.4 }}>
          🧹 VIRGIN / NEWVIN — SEC16 wiped &middot; all split records + mirrors + flat 0x40C9 are blank
        </div>
      )}
    </div>
  );
}

function TooSmallCard({ parsed, moduleLabel, testid }) {
  /* Shared rendering for RFHUB / PCM / 95640 undersized dumps — mirrors the
   * BcmCard branch added for Task #370 so techs see the same wording, the
   * same fields (size · required min · detected ext), and the same recovery
   * guidance regardless of which slot the bad file landed in. */
  return (
    <div data-testid={testid} style={{ background: 'rgba(255,23,68,0.05)', borderRadius: 12, padding: 16, border: `2px solid ${C.er}`, gridColumn: '1 / -1' }}>
      <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: C.er, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        ⛔ This isn&apos;t a full {moduleLabel} dump
        <Badge text="REJECTED" color={C.er} />
      </div>
      <Kv k="File size"   v={`${parsed.size.toLocaleString()} bytes`} mono color={C.er} />
      <Kv k="Required min" v={`${parsed.minSize.toLocaleString()} bytes${parsed.minLabel ? ` (${parsed.minLabel})` : ''}`} mono />
      <Kv k="Detected ext" v={parsed.fileExt || '(none)'} mono />
      <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(255,23,68,0.08)', border: `1px solid ${C.er}55`, borderRadius: 8, fontSize: 12, color: C.tx, lineHeight: 1.5, fontWeight: 600 }}>
        Re-read the {moduleLabel} in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.
      </div>
    </div>
  );
}

function RfhCard({ parsed, pnOverride, filename, fileSize }) {
  if (!parsed) return null;
  if (parsed.tooSmall) return <TooSmallCard parsed={parsed} moduleLabel="RFHUB" testid="rfh-too-small-card" />;

  const isVirgin = parsed.sec16?.virgin;
  const isMatch  = parsed.sec16?.match;

  /* DERIVED (DEMO) — RFH → BCM: reverse of RFH SEC16 slot 1. */
  const derivedBcmHex = parsed.sec16?.slot1
    ? bytesToHex(Array.from(parsed.sec16.slot1).reverse()).toUpperCase()
    : null;

  return (
    <div data-testid="modsync-rfh-card" style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${C.bd}` }}>

      {/* Header row: filename + chip badge + size badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 900, fontSize: 11, color: C.tx, fontFamily: "'JetBrains Mono'", wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
          {filename || 'RFHUB'}
        </span>
        <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: C.a4, color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>
          MC9S12X
        </span>
        <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: C.ts, color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {(fileSize ?? parsed.size ?? 0).toLocaleString()} bytes
        </span>
        {pnOverride && <PnOverrideBadge />}
      </div>

      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this RFHUB bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}

      {/* VIRGIN CHIP banner — factory-fresh chip with 0x30-fill VIN slots and blank SEC16 */}
      {parsed.virginChip && (
        <div data-testid="rfh-virgin-chip-banner" style={{ marginBottom: 10, padding: '8px 12px', background: C.wn + '18', border: `1.5px solid ${C.wn}88`, borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 4, letterSpacing: 0.4 }}>🏭 VIRGIN CHIP — FACTORY FRESH</div>
          <div style={{ fontWeight: 600, color: C.ts }}>All VIN slots contain factory 0x30 placeholder. SEC16 is blank.</div>
          <div style={{ marginTop: 4, fontWeight: 700, color: C.a1 }}>→ Load BCM and use <strong>BCM SEC16 → RFHUB</strong> to program this chip.</div>
          {parsed.partNumbers?.length > 0 && (
            <div style={{ marginTop: 4, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'", fontSize: 10 }}>P/N: {parsed.partNumbers.join(' · ')}</div>
          )}
        </div>
      )}

      {/* VIN (RFH GEN2 — 4 SLOTS + CHK AFTER) section */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
          VIN (RFH GEN2 — 4 SLOTS + CHK AFTER)
        </div>
        {parsed.vinSlots?.length > 0 ? parsed.vinSlots.map((slot, idx) => {
          const ok = slot.chkOk;
          return (
            <div key={idx} style={{ marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ color: C.ts, minWidth: 46, flexShrink: 0 }}>Slot {idx + 1}</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: ok ? C.gn : C.er, color: '#fff', fontWeight: 800, letterSpacing: 0.5,
                }}>{ok ? 'CS OK' : 'CRC FAIL'}</span>
              </div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tx, paddingLeft: 52, marginTop: 2, wordBreak: 'break-all' }}>
                {slot.vin || '—'}
              </div>
            </div>
          );
        }) : (
          <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>No VIN slots found</div>
        )}
      </div>

      {/* SEC16 (RFH GEN2 — 2 SLOTS + CHK AFTER) section */}
      {parsed.sec16 && (
        <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
            SEC16 (RFH GEN2 — 2 SLOTS + CHK AFTER)
          </div>
          {/* Slots match badge */}
          <div data-testid="rfh-sec16-slots-match" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 8 }}>
            <span style={{ color: C.ts, fontWeight: 600 }}>Slots match:</span>
            <span style={{
              fontSize: 9, padding: '1px 6px', borderRadius: 4,
              background: isVirgin ? C.wn : (isMatch ? C.gn : C.er),
              color: '#fff', fontWeight: 800, letterSpacing: 0.5,
            }}>{isVirgin ? 'n/a (virgin)' : (isMatch ? 'OK' : 'No/review')}</span>
          </div>
          {/* Slot 1 */}
          {parsed.sec16.slot1 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 2 }}>
                <span style={{ color: C.ts, minWidth: 46, flexShrink: 0 }}>Slot 1</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: isVirgin ? C.wn : C.gn, color: '#fff', fontWeight: 800, letterSpacing: 0.5,
                }}>{isVirgin ? 'VIRGIN' : 'CS OK'}</span>
              </div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: C.tx, paddingLeft: 52, wordBreak: 'break-all' }}>
                {bytesToHex(parsed.sec16.slot1).toUpperCase()}
              </div>
            </div>
          )}
          {/* Slot 2 */}
          {parsed.sec16.slot2 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 2 }}>
                <span style={{ color: C.ts, minWidth: 46, flexShrink: 0 }}>Slot 2</span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: isVirgin ? C.wn : (isMatch ? C.gn : C.er),
                  color: '#fff', fontWeight: 800, letterSpacing: 0.5,
                }}>{isVirgin ? 'VIRGIN' : (isMatch ? 'CS OK' : 'Checksum ERROR')}</span>
              </div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: C.tx, paddingLeft: 52, wordBreak: 'break-all' }}>
                {bytesToHex(parsed.sec16.slot2).toUpperCase()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* DERIVED (DEMO) — RFH → BCM section */}
      <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
          DERIVED (DEMO) — RFH → BCM
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 4 }}>
          Rule: reverse bytes of the entire block.
        </div>
        <div style={{ fontSize: 11, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: C.ts, fontWeight: 600, flexShrink: 0 }}>SEC16 BCM (hex):</span>
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: derivedBcmHex ? C.a3 : C.tm, fontWeight: 600, wordBreak: 'break-all' }}>
            {derivedBcmHex || '—'}
          </span>
        </div>
      </div>

      {/* OS / PN / SERIAL (BEST PICK) section */}
      <div style={{ borderTop: `1px solid ${C.bd}`, paddingTop: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.ts, marginBottom: 5 }}>
          OS / PN / SERIAL (BEST PICK)
        </div>
        {parsed.partNumbers?.length > 0 && (() => {
          const { winner } = pickBest(buildCandidateList(parsed.partNumbers, CANONICAL_PATTERNS.rfhPn));
          return winner ? (
            <div style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 11 }}>
                <span style={{ color: C.ts, fontWeight: 600, marginRight: 6 }}>PN:</span>
                <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tx }}>{winner.value}</span>
              </div>
              <PickBreakdown kind="PN" value={winner.value} breakdown={winner} testid="rfh-pn-pick" />
            </div>
          ) : null;
        })()}
        {parsed.internalSerial && (() => {
          const { winner } = pickBest(buildCandidateList([parsed.internalSerial], CANONICAL_PATTERNS.serial));
          return winner ? (
            <div style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 11 }}>
                <span style={{ color: C.ts, fontWeight: 600, marginRight: 6 }}>Serial:</span>
                <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tx }}>{winner.value}</span>
              </div>
              <PickBreakdown kind="Serial" value={winner.value} breakdown={winner} testid="rfh-serial-pick" />
            </div>
          ) : null;
        })()}
        {!parsed.partNumbers?.length && !parsed.internalSerial && (
          <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>No PN / Serial found</div>
        )}
      </div>
    </div>
  );
}

export function PcmCard({ parsed, bytes, pnOverride, onRepair, repairAvailable, repairReasons }) {
  if (!parsed) return null;
  if (parsed.tooSmall) return <TooSmallCard parsed={parsed} moduleLabel="PCM" testid="pcm-too-small-card" />;
  let status = 'READY', statusColor = C.gn;
  if (!parsed.ok)              { status = 'UNKNOWN';  statusColor = C.wn; }
  else if (parsed.immoDamaged) { status = 'DAMAGED';  statusColor = C.er; }
  else if (!parsed.immoOk)     { status = 'IMMO ✗';   statusColor = C.er; }
  else                         { status = 'READY';    statusColor = C.gn; }

  return (
    <div style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${statusColor}40` }}>
      {(() => {
        // Task #379: surface a structured mismatch-guard card when the loaded
        // PCM is a doubled 8 KB capture whose half-2 is all 0xFF. The CGDI
        // flasher rejects the wrong-sized image with "File different size,"
        // so we tell the user up-front that SYNC will emit a 4 KB output for
        // a 95320 bench (auto-slice happens in executeSync('sync-all')).
        if (parsed.size === 8192) {
          // engParsePcm doesn't carry the raw buffer in its result, so accept
          // the bytes via prop (mirrors how downstream SYNC reads pcm.bytes).
          const half2 = bytes && bytes.slice ? bytes.slice(4096) : null;
          const halfPad = half2 && half2.every ? half2.every((b) => b === 0xFF) : false;
          if (halfPad) {
            return (
              <div data-testid="pcm-doubled-mismatch-card" style={{ marginBottom: 10, padding: '10px 12px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700, lineHeight: 1.5 }}>
                ⚠ Doubled 8 KB capture detected (half-2 is 0xFF padding). On SYNC, only the first 4 KB will be written so it fits a 95320 bench chip and CGDI doesn&apos;t reject with &quot;File different size.&quot;
              </div>
            );
          }
        }
        if (!pcmChipFromSize(parsed.size)) {
          return (
            <div data-testid="pcm-chip-mismatch-card" style={{ marginBottom: 10, padding: '10px 12px', background: C.er + '14', border: '1px solid ' + C.er + '55', borderRadius: 8, fontSize: 11, color: C.er, fontWeight: 700, lineHeight: 1.5 }}>
              ⛔ This PCM is {parsed.size} bytes — neither 4 KB (95320) nor 8 KB (95640). The CGDI flasher will refuse it. Re-read the PCM in full or load the matching virgin before SYNC.
            </div>
          );
        }
        return null;
      })()}
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        ⚙️ PCM · Continental
        <Badge text={status} color={statusColor} />
        <Badge text={parsed.variant} color={C.a1} />
        {(() => {
          const chip = pcmChipFromSize(parsed.size);
          if (chip) return <span data-testid="pcm-chip-badge" data-chip={chip.chip} data-chip-key={chip.chipKey}><Badge text={chip.label} color={C.a4} /></span>;
          return <span data-testid="pcm-chip-badge" data-chip="UNKNOWN"><Badge text={`${parsed.size} B · UNKNOWN CHIP`} color={C.wn} /></span>;
        })()}
        {pnOverride && <PnOverrideBadge />}
      </div>
      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this PCM bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}
      {repairAvailable && (
        <div
          data-testid="pcm-repair-cta"
          style={{
            marginBottom: 10, padding: '10px 12px', borderRadius: 10,
            background: C.er + '12', border: '1.5px solid ' + C.er + '88',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.er, letterSpacing: 1, marginBottom: 3 }}>
              ⚠ PCM DAMAGED — REPAIRABLE
            </div>
            <div style={{ fontSize: 11, color: C.tx, lineHeight: 1.5 }}>
              BCM and RFHUB agree on the VIN and pairing secret. The damaged offsets in this PCM
              dump can be rewritten from that trusted source.
              {repairReasons && repairReasons.length > 0 && (
                <span style={{ color: C.ts }}> · {repairReasons.join(' · ')}</span>
              )}
            </div>
          </div>
          <button
            onClick={onRepair}
            data-testid="pcm-repair-open-btn"
            style={{
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: C.er, color: '#1A1A1A',
              fontWeight: 800, fontSize: 12, letterSpacing: 0.5,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
            🩹 Repair PCM
          </button>
        </div>
      )}
      <Kv k="Current VIN"  v={parsed.currentVin || parsed.vin} mono />
      {parsed.originalVin && parsed.originalVin !== parsed.currentVin &&
        <Kv k="Original VIN" v={parsed.originalVin} mono color={C.wn} hint="← donor VIN" />}
      <Kv k="VIN slots"    v={`${parsed.vinSlots.length} found`} />
      <OffsetList offsets={parsed.vinSlots.map(s => s.offset)} testid="pcm-vin-slot-offsets" />
      <Kv k="File size"    v={`${parsed.size} bytes (${(parsed.size/1024).toFixed(1)} KB)`} mono />
      <Kv k="Immo (SEC6)"  v={parsed.immoLabel || (parsed.immoDamaged ? 'DAMAGED / MISSING' : parsed.immoOk ? '✓ Populated' : 'Virgin (all FF)')}
          color={parsed.immoDamaged ? C.er : (parsed.sec6Class && parsed.sec6Class.label === 'MISSING') ? C.er : parsed.immoOk ? C.gn : C.wn} />
      {parsed.immoByte && (
        <Kv
          k={`IMMO byte @${fmtOff(parsed.immoByte.offset)}`}
          v={bytesToHex(parsed.immoByte.bytes).toUpperCase() + ' \u2014 ' + parsed.immoByte.state}
          mono
          color={parsed.immoByte.state === 'ENABLED' ? C.gn
            : parsed.immoByte.state === 'DISABLED' ? C.wn
            : parsed.immoByte.state === 'VIRGIN' ? C.er
            : C.ts}
        />
      )}
      {parsed.sec6 && (
        <>
          <Kv k="SEC6 marker" v={parsed.sec6.marker} mono />
          {parsed.sec6.markerBytes && (
            <Kv
              k={`Marker @${fmtOff(parsed.sec6.markerOffset ?? 0x3C4)}`}
              v={(parsed.sec6.markerOk ? '✓ ' : '✗ ') + bytesToHex(parsed.sec6.markerBytes).toUpperCase() + (parsed.sec6.markerOk ? ' (canonical FF FF FF AA)' : ' (expected FF FF FF AA)')}
              mono
              color={parsed.sec6.markerOk ? C.gn : C.er}
            />
          )}
          <Kv k={`SEC6 bytes @${fmtOff(parsed.sec6.offset ?? 0x3C8)}`}
              v={bytesToHex(parsed.sec6.bytes).toUpperCase()} mono />
          {/* Task #464 — explain in plain language how the SEC6 secret bytes
              are derived from the BCM SEC16 so a tech who's never read the
              SINCRO source still understands what BCM→PCM SEC6 sync does:
              it byte-reverses the BCM SEC16 record and writes the first 6
              bytes into the PCM at this offset. */}
          <div data-testid="pcm-sec6-derived-rule" style={{
            marginTop: 4, paddingLeft: 130, fontSize: 10, color: C.tm,
            fontFamily: "'JetBrains Mono'", lineHeight: 1.5,
          }}>
            Derived rule: first 6 bytes of byte-reversed BCM SEC16
          </div>
          {parsed.sec6.markerBytes && !parsed.sec6.markerOk && parsed.sec6Class && parsed.sec6Class.populated && (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: C.er + '14', border: '1px solid ' + C.er + '55', fontSize: 11, color: C.tx, lineHeight: 1.45 }}>
              <span style={{ color: C.er, fontWeight: 800 }}>⚠ Secret bytes present but marker missing</span> — apply BCM→PCM SEC6 sync to restamp the canonical FF FF FF AA marker @ {fmtOff(0x3C4)}.
            </div>
          )}
        </>
      )}
      {parsed.continentalPn && (
        <>
          <Kv k="Continental PN" v={parsed.continentalPn} mono />
          {(() => {
            const list = parsed.continentalPnCandidates && parsed.continentalPnCandidates.length > 0
              ? parsed.continentalPnCandidates : [parsed.continentalPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmContPn));
            return <PickBreakdown kind="Cont" value={winner?.value} breakdown={winner} testid="pcm-cont-pick" />;
          })()}
        </>
      )}
      {parsed.osPn && (
        <>
          <Kv k="OS PN"   v={parsed.osPn}   mono />
          {(() => {
            const list = parsed.osPnCandidates && parsed.osPnCandidates.length > 0
              ? parsed.osPnCandidates : [parsed.osPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmOsPn));
            return <PickBreakdown kind="OS" value={winner?.value} breakdown={winner} testid="pcm-os-pick" />;
          })()}
        </>
      )}
      {parsed.bodyPn && (
        <>
          <Kv k="Body PN" v={parsed.bodyPn} mono />
          {(() => {
            const list = parsed.bodyPnCandidates && parsed.bodyPnCandidates.length > 0
              ? parsed.bodyPnCandidates : [parsed.bodyPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmBodyPn));
            return <PickBreakdown kind="PN" value={winner?.value} breakdown={winner} testid="pcm-pn-pick" />;
          })()}
        </>
      )}
    </div>
  );
}

/* VillainOpsReference (Task #589) — quick-reference panel listing every
 * VILLAIN-documented DID that the bench/sync log might emit, alongside its
 * human label and protocol-scope chip (e.g. "CHRYSLER ECU CAN 11-BIT").
 * Sourced from `getDidOperations()` which indexes
 * `unlock_catalog_extended.json → villain_operations.groups[*].operations[*]`.
 *
 * Falls back to `getDidDescription()` when an op record is missing the
 * scope so a tech still sees a label rather than a raw hex code.
 *
 * Pure-display: no side-effects, no engine calls. */
const VILLAIN_REFERENCE_DIDS = [
  0x7B90, 0x7B88, 0x6E2025, 0x6E2027,
  0x6E9EB0, 0x6EF190, 0xF79EB045,
];
function VillainOpsReference({ Card, H2 }) {
  const rows = VILLAIN_REFERENCE_DIDS.map(did => {
    const ops = getDidOperations(did);
    const protocols = Array.from(new Set(ops.map(o => o.protocol).filter(Boolean)));
    const groups = Array.from(new Set(ops.map(o => o.group).filter(Boolean)));
    const label = (ops[0] && ops[0].label) || getDidDescription(did) || 'Unlabeled';
    const notes = ops.find(o => o.notes)?.notes || '';
    const wide = did > 0xFFFF;
    return { did, label, protocols, groups, notes, wide };
  });
  return (
    <Card>
      <H2 badge={`${rows.length} DIDs`}>VILLAIN Operations Reference</H2>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 10, lineHeight: 1.5 }}>
        Decoded from <code style={{ fontFamily: "'JetBrains Mono'" }}>villain_operations</code> +
        <code style={{ fontFamily: "'JetBrains Mono'" }}> uds.did_maps</code>.
        Hover a row for the protocol scope and any value notes.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 8,
      }}>
        {rows.map(r => (
          <div
            key={r.did}
            data-testid={`villain-op-${r.did.toString(16)}`}
            title={[
              r.groups.length ? 'Group: ' + r.groups.join(', ') : '',
              r.protocols.length ? 'Protocol: ' + r.protocols.join(' · ') : '',
              r.notes ? 'Notes: ' + r.notes : '',
              r.wide ? 'Wide DID — cannot fit a 2-byte 0x22 read' : '',
            ].filter(Boolean).join('\n')}
            style={{
              padding: '10px 12px', borderRadius: 8, background: C.c2,
              border: `1px solid ${C.bd}`, display: 'flex',
              flexDirection: 'column', gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 800,
                color: C.tx,
              }}>0x{r.did.toString(16).toUpperCase()}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.tx }}>{r.label}</span>
              {r.wide && (
                <span style={{
                  marginLeft: 'auto', fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                  padding: '1px 6px', borderRadius: 4,
                  background: C.wn + '22', color: C.wn,
                }}>WIDE</span>
              )}
            </div>
            {r.protocols.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {r.protocols.map(p => (
                  <span key={p} style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                    padding: '2px 6px', borderRadius: 4,
                    background: C.a3 + '22', color: C.a3,
                    fontFamily: "'JetBrains Mono'",
                  }}>{p}</span>
                ))}
              </div>
            )}
            {r.notes && (
              <div style={{ fontSize: 10, color: C.ts, fontStyle: 'italic' }}>{r.notes}</div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function VinDiffTable({ rows }) {
  if (!rows || rows.length === 0) return null;
  const changed  = rows.filter(r => r.oldVin !== r.newVin);
  const allPass  = rows.every(r => r.newPass);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9E9E9E', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>VIN Slot Diff</span>
        <span style={{
          marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, fontSize: 10,
          fontWeight: 700, letterSpacing: 0.5,
          background: allPass ? 'rgba(0,200,83,0.15)' : 'rgba(255,23,68,0.15)',
          color: allPass ? '#4ADE80' : '#F87171',
        }}>
          {allPass ? '✓ ALL SLOTS PASS' : '✗ CHECK FAILED'}
        </span>
      </div>
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1.5px solid #2A2F36' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono'", fontSize: 10.5, color: '#E0E0E0', background: '#0F1419' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2F36', background: '#161C24' }}>
              {['Module', 'Slot', 'Offset', 'Old VIN', 'New VIN', 'Old Chk', 'New Chk', 'Status'].map(h => (
                <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#6B7280' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const vinChanged = r.oldVin !== r.newVin;
              const modColor = r.module === 'BCM' ? '#60A5FA' : r.module === 'PCM' ? '#FB923C' : '#C084FC';
              return (
                <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid #1E252D' : 'none', background: vinChanged ? 'rgba(255,109,0,0.06)' : 'transparent' }}>
                  <td style={{ padding: '7px 10px', color: modColor, fontWeight: 700, fontSize: 10 }}>{r.module}</td>
                  <td style={{ padding: '7px 10px', color: '#6B7280' }}>#{r.slot}</td>
                  <td style={{ padding: '7px 10px', color: '#9CA3AF' }}>{r.offset}</td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#F87171' : '#6B7280', letterSpacing: 1.5 }}>{r.oldVin || '—'}</td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#4ADE80' : '#6B7280', fontWeight: vinChanged ? 700 : 400, letterSpacing: 1.5 }}>{r.newVin}</td>
                  <td style={{ padding: '7px 10px', color: r.oldPass === true ? '#4ADE80' : r.oldPass === false ? '#F87171' : '#6B7280' }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>{r.oldCheck}
                    {r.oldPass === false && <span style={{ color: '#F87171', marginLeft: 4, fontSize: 9 }}>✗</span>}
                    {r.oldPass === true  && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#4ADE80', fontWeight: 700 }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>{r.newCheck}
                    {r.newPass && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    {vinChanged
                      ? <span style={{ background: 'rgba(74,222,128,0.15)', color: '#4ADE80', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>PATCHED</span>
                      : <span style={{ background: 'rgba(107,114,128,0.15)', color: '#6B7280', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>NO CHANGE</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {changed.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#6B7280', fontFamily: "'JetBrains Mono'" }}>
          {changed.length} slot{changed.length !== 1 ? 's' : ''} patched
          {rows.length - changed.length > 0 ? ` · ${rows.length - changed.length} already matched` : ''}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ title, desc, enabled, onClick, color }) {
  const [h, setH] = useState(false);
  const ac = color || C.sr;
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        padding: '14px 16px', borderRadius: 12, border: `2px solid ${h && enabled ? ac : C.bd}`,
        background: h && enabled ? `${ac}08` : C.cd,
        cursor: enabled ? 'pointer' : 'not-allowed', textAlign: 'left',
        transition: 'all 0.15s', fontFamily: "'Nunito'", color: C.tx,
        opacity: enabled ? 1 : 0.35, transform: h && enabled ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: 0.8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {title}<span style={{ marginLeft: 'auto', fontSize: 14, opacity: 0.5 }}>›</span>
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginTop: 4, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

/* Task #794 — compact mode selector for the BCM flat 0x40C9 repair card.
 * Surfaces the canonical / legacy-flat trade-off inline next to the
 * action button so the tech sees which compatibility view they are
 * about to download. Highlights amber when an overlap is detected so
 * the choice is unmissable on the dumps the trade-off actually applies
 * to (older BCM layouts where mirror1 sits at 0x40C0). */
function FlatRepairModeSelector({ mode, setMode, overlapDetected }) {
  const opts = [
    { key: 'canonical', label: 'Canonical', hint: 'Preserve mirror1 record. Modern tools + SRT Lab agree.' },
    { key: 'legacy-flat', label: 'Legacy-flat compatibility', hint: 'Force LE write on overlap dumps so CGDI / AlfaOBD / SINCRO verify.' },
  ];
  const cur = opts.find(o => o.key === mode) || opts[0];
  return (
    <div data-testid="flat-repair-mode-selector"
         data-mode={mode}
         data-overlap={overlapDetected ? '1' : '0'}
         style={{
           marginBottom: 10, padding: '10px 12px', borderRadius: 10,
           background: overlapDetected ? C.wn + '14' : C.c2,
           border: `1.5px solid ${overlapDetected ? C.wn : C.bd}`,
         }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Compatibility mode
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {opts.map(opt => {
            const active = mode === opt.key;
            return (
              <button key={opt.key}
                data-testid={`flat-repair-mode-${opt.key}`}
                data-active={active ? '1' : '0'}
                onClick={() => setMode(opt.key)}
                title={opt.hint}
                style={{
                  padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${active ? C.a3 : C.bd}`,
                  background: active ? C.a3 : C.cd,
                  color: active ? '#fff' : C.tx,
                  fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
                  letterSpacing: 0.4,
                }}>{opt.label}</button>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: overlapDetected ? C.wn : C.ts, fontWeight: 600, lineHeight: 1.5 }}>
        {overlapDetected
          ? `⚠ Overlap detected — mirror1 at 0x40C0 collides with the flat 0x40C9 slice. ${cur.hint}`
          : cur.hint}
      </div>
    </div>
  );
}

/* ==========================================================================
 * MAIN COMPONENT
 * ========================================================================== */

/* 95640 BCM-backup EEPROM parser.
 *  · VIN slots at 0x275 / 0x288 with crc8 at off-1 (we don't recompute CRC8 here)
 *  · 16-byte secret key at 0x40-0x4F
 *  · BCM-SEC16 token at 0x838 (16 bytes), big-endian CRC16 at 0x848-0x849
 * The 95640 stores the SEC16 byte-reversed compared to the RFHUB SEC16, which
 * is why "Re-key 95640 from RFHUB" reverses the RFH SEC16 before writing.
 */
export function engParseEep95640(bytes, filename) {
  /* Reject files smaller than a canonical 95640 backup chip (8 KB). A
   * truncated dump would silently miss the SEC16 region (0x838) and the
   * VIN slots, so the inspector should refuse it up front — Task #372. */
  const small = moduleTooSmall(bytes, '95640', filename);
  if (small) {
    return {
      ok: false, kind: '95640', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      secretKey: null, secretKeyHex: null, secretKeyBlank: true,
      bcmSec16: null, bcmSec16Hex: null, bcmSec16Blank: true,
      bcmSec16StoredCrc: null, bcmSec16CalcCrc: null, bcmSec16CrcOk: false,
      bcmSec16ReversedHex: null,
    };
  }
  const r = {
    ok: false, kind: '95640', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    secretKey: null, secretKeyHex: null, secretKeyBlank: true,
    bcmSec16: null, bcmSec16Hex: null, bcmSec16Blank: true,
    bcmSec16StoredCrc: null, bcmSec16CalcCrc: null, bcmSec16CrcOk: false,
    bcmSec16ReversedHex: null,
  };
  for (const off of [0x275, 0x288]) {
    if (off + 17 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < 17; k++) {
      const b = bytes[off + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    r.vinSlots.push({ offset: off, vin });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
  }
  if (bytes.length >= 0x50) {
    const k = bytes.slice(0x40, 0x50);
    r.secretKey = k;
    r.secretKeyHex = bytesToHex(k).toUpperCase();
    r.secretKeyBlank = k.every(b => b === 0xFF) || k.every(b => b === 0x00);
  }
  if (bytes.length >= 0x84A) {
    const s16 = bytes.slice(0x838, 0x848);
    r.bcmSec16 = s16;
    r.bcmSec16Hex = bytesToHex(s16).toUpperCase();
    r.bcmSec16Blank = s16.every(b => b === 0xFF) || s16.every(b => b === 0x00);
    r.bcmSec16StoredCrc = (bytes[0x848] << 8) | bytes[0x849];
    r.bcmSec16CalcCrc   = engCrc16(s16);
    r.bcmSec16CrcOk = !r.bcmSec16Blank && r.bcmSec16StoredCrc === r.bcmSec16CalcCrc;
    const rev = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rev[i] = s16[15 - i];
    r.bcmSec16ReversedHex = bytesToHex(rev).toUpperCase();
  }
  r.ok = r.vin !== null || (r.bcmSec16 && !r.bcmSec16Blank);
  return r;
}

/* Write the byte-reversed RFHUB SEC16 (slot 1, 16 bytes) into a 95640 dump
 * at 0x838, with big-endian CRC16 of the reversed bytes at 0x848-0x849.
 * Mirrors the algorithm used by SecurityTab's `rfhBcmSync` tool. */
function engWriteEep95640FromRfh(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length < 16)
    throw new Error('RFHUB SEC16 slot must be 16 bytes');
  if (bytes.length < 0x84A)
    throw new Error(`95640 file too small (need ≥0x84A bytes, got ${bytes.length})`);
  const out = new Uint8Array(bytes);
  const rev = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rev[i] = rfhSec16[15 - i];
  for (let i = 0; i < 16; i++) out[0x838 + i] = rev[i];
  const cs = engCrc16(rev);
  out[0x848] = (cs >> 8) & 0xFF;
  out[0x849] = cs & 0xFF;
  return { bytes: out, sec16Hex: bytesToHex(rev).toUpperCase(), crc16: cs };
}

/* Look up a P/N-override flag on a Dumps-tab file that matches the just-loaded
 * file by name + size. Lets the override badge propagate from Dumps → Module
 * Sync without a deeper state refactor. Returns false when no match. */
function lookupPnOverride(files, file, bytes) {
  if (!Array.isArray(files) || !file) return false;
  const match = files.find(f =>
    f && f.pnOverride && f.name === file.name &&
    (f.size === bytes.length || f.size === file.size)
  );
  return !!match;
}

/* Task #801 — pre-download confirm for the BCM flat 0x40C9 repair on
 * overlap dumps. The compatibility-mode selector is a power-user choice;
 * picking the wrong side produces a file the destination tool will
 * reject (IMMO_DAMAGED on legacy CGDI/AlfaOBD/SINCRO if canonical is
 * picked, mirror1 CRC fail in SRT Lab if legacy-flat is picked). This
 * modal mirrors the OverrideConfirmModal / target-chip confirm UX:
 * spells out the trade-off, lists which tools accept the resulting
 * file, and offers a "don't ask again this session" opt-out.
 */
function FlatRepairConfirmModal({ mode, onConfirm, onCancel }) {
  const [dontAsk, setDontAsk] = useState(false);
  const overlayRef = useRef(null);
  const handleOverlay = (e) => { if (e.target === overlayRef.current) onCancel?.(); };
  const isLegacy = mode === 'legacy-flat';
  const summary = isLegacy
    ? {
        title: 'LEGACY-FLAT COMPATIBILITY',
        oneLine: 'The legacy 0x40C9 slice will be written and the mirror1 record at 0x40C0 will be clobbered.',
        accepted: ['CGDI', 'AlfaOBD', 'SINCRO', 'Autel (pre-Redeye flat readers)', 'SRT Lab (resolves via split records)'],
        rejected: ['Bench tools that verify the mirror1 CRC will report mirror1 as inconsistent in this file (split records remain the master).'],
      }
    : {
        title: 'CANONICAL',
        oneLine: 'Mirror1 will be preserved on this overlap dump, so the legacy flat slice stays stale.',
        accepted: ['SRT Lab', 'Modern bench tools that read split records / mirrors'],
        rejected: ['CGDI, AlfaOBD, SINCRO and other legacy readers will still see the OLD secret in the flat slice and will likely report IMMO_DAMAGED.'],
      };
  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      data-testid="flat-repair-confirm"
      data-mode={mode}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
      <div style={{
        background: C.cd, border: `1.5px solid ${C.wn}`, borderRadius: 14,
        width: '100%', maxWidth: 560, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(135deg, ${C.wn}22 0%, ${C.wn}11 100%)`,
          borderBottom: `1px solid ${C.bd}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 22 }}>⚠️</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, letterSpacing: 0.5 }}>
              OVERLAP DUMP — CONFIRM COMPATIBILITY MODE
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
              Mirror1 at 0x40C0 collides with the flat 0x40C9 slice — picking the wrong side produces a file the destination tool will reject.
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 18px', fontSize: 13, color: C.tx, lineHeight: 1.5 }}>
          <div style={{ marginBottom: 10 }}>
            Selected mode: <strong style={{ color: C.sr }}>{summary.title}</strong>
          </div>
          <div style={{
            background: C.wn + '14', border: `1px solid ${C.wn}55`, borderRadius: 8,
            padding: '8px 10px', fontSize: 12, color: C.tx, marginBottom: 10,
          }}>
            {summary.oneLine}
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.gn, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>
            Tools that will accept this file
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx, fontSize: 12 }}>
            {summary.accepted.map(t => <li key={t} style={{ marginBottom: 2 }}>{t}</li>)}
          </ul>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.er, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>
            Trade-off
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx, fontSize: 12 }}>
            {summary.rejected.map(t => <li key={t} style={{ marginBottom: 2 }}>{t}</li>)}
          </ul>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 10 }}>
            To switch sides, cancel and toggle the &ldquo;Compatibility mode&rdquo; selector on the repair card.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.ts, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={e => setDontAsk(e.target.checked)}
              data-testid="flat-repair-dont-ask"
              style={{ accentColor: C.a3, cursor: 'pointer' }}
            />
            Don&rsquo;t ask again for the rest of this session
          </label>
        </div>
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${C.bd}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10, background: C.c2,
        }}>
          <button
            onClick={onCancel}
            data-testid="flat-repair-cancel"
            style={{
              padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.bd}`,
              background: C.cd, color: C.tx, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm?.(dontAsk)}
            data-testid="flat-repair-confirm-btn"
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: C.wn, color: '#1A1A1A', fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}>
            Acknowledge &amp; Download
          </button>
        </div>
      </div>
    </div>
  );
}

function OverrideConfirmModal({ modules, onConfirm, onCancel }) {
  const [dontAsk, setDontAsk] = useState(false);
  const overlayRef = useRef(null);
  const handleOverlay = (e) => { if (e.target === overlayRef.current) onCancel?.(); };
  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      data-testid="pn-override-confirm"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
      <div style={{
        background: C.cd, border: `1.5px solid ${C.wn}`, borderRadius: 14,
        width: '100%', maxWidth: 520, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(135deg, ${C.wn}22 0%, ${C.wn}11 100%)`,
          borderBottom: `1px solid ${C.bd}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 22 }}>⚠️</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, letterSpacing: 0.5 }}>
              REGISTRY CHECK BYPASSED
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
              Confirm before syncing files that skipped P/N validation
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 18px', fontSize: 13, color: C.tx, lineHeight: 1.5 }}>
          <div style={{ marginBottom: 10 }}>
            The following loaded module{modules.length > 1 ? 's are' : ' is'} flagged
            <strong> P/N OVERRIDE</strong> — the part-number registry check was bypassed
            on the Dumps tab when {modules.length > 1 ? 'they were' : 'it was'} loaded:
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx }}>
            {modules.map(m => (
              <li key={m} style={{ marginBottom: 4 }}>
                <strong style={{ color: C.sr }}>{m}</strong>
                <span style={{ color: C.ts, fontSize: 12 }}> — registry compatibility unverified</span>
              </li>
            ))}
          </ul>
          <div style={{
            background: C.wn + '14', border: `1px solid ${C.wn}55`, borderRadius: 8,
            padding: '8px 10px', fontSize: 12, color: C.tx, marginBottom: 10,
          }}>
            Mixing registry-checked and override files can produce a mismatched sync.
            Acknowledge that this is intentional before continuing.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.ts, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={e => setDontAsk(e.target.checked)}
              data-testid="pn-override-dont-ask"
              style={{ accentColor: C.a3, cursor: 'pointer' }}
            />
            Don&rsquo;t ask again for the rest of this session
          </label>
        </div>
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${C.bd}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10, background: C.c2,
        }}>
          <button
            onClick={onCancel}
            data-testid="pn-override-cancel"
            style={{
              padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.bd}`,
              background: C.cd, color: C.tx, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm?.(dontAsk)}
            data-testid="pn-override-confirm-btn"
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: C.wn, color: '#1A1A1A', fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}>
            Acknowledge & Sync
          </button>
        </div>
      </div>
    </div>
  );
}

/* Task #1025 — pre-download confirm for any sync that ships a VIRGINIZED
 * RFHUB. Virginize deliberately wipes the RFHUB SEC16, so the exported
 * BCM and RFHUB do NOT share an immobilizer secret: flashing the pair
 * as-is leaves a car that won't crank until the RFHUB is re-keyed on the
 * bench (RoutineControl 0x0401 pairing on the RFHUB tab). Task #1022
 * already renamed the file to RFH_VIRGIN_ and logged a loud line, but a
 * tech can still miss it and waste a bench trip. This modal makes the
 * trade-off impossible to skip past, mirroring the FlatRepair / Override
 * confirm UX with a "don't ask again this session" opt-out. */
function VirginizeConfirmModal({ onConfirm, onCancel }) {
  const [dontAsk, setDontAsk] = useState(false);
  const overlayRef = useRef(null);
  const handleOverlay = (e) => { if (e.target === overlayRef.current) onCancel?.(); };
  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      data-testid="virginize-confirm"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
      <div style={{
        background: C.cd, border: `1.5px solid ${C.sr}`, borderRadius: 14,
        width: '100%', maxWidth: 560, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(135deg, ${C.sr}22 0%, ${C.sr}11 100%)`,
          borderBottom: `1px solid ${C.bd}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 22 }}>🆕</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, letterSpacing: 0.5 }}>
              VIRGINIZE — RFHUB WON&rsquo;T PAIR WITHOUT RE-KEYING
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
              The exported BCM and RFHUB will NOT share an immobilizer secret.
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 18px', fontSize: 13, color: C.tx, lineHeight: 1.5 }}>
          <div style={{
            background: C.sr + '14', border: `1px solid ${C.sr}55`, borderRadius: 8,
            padding: '8px 10px', fontSize: 12, color: C.tx, marginBottom: 10,
          }}>
            Virginize wipes the RFHUB SEC16, so the downloaded <strong>RFH_VIRGIN_</strong> file
            carries no security key. The BCM keeps its own secret — the two files are
            <strong> not a matched immobilizer pair</strong>.
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.er, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>
            If you flash this RFHUB as-is
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx, fontSize: 12 }}>
            <li style={{ marginBottom: 2 }}>The car will not crank / keys will not be recognised until the RFHUB is re-keyed.</li>
            <li style={{ marginBottom: 2 }}>This is intended for salvage rebuilds, not factory-paired swaps.</li>
          </ul>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.gn, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>
            To make it pair
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx, fontSize: 12 }}>
            <li style={{ marginBottom: 2 }}>Re-key the RFHUB on the bench via the RoutineControl 0x0401 pairing flow on the <strong>RFHUB tab</strong>.</li>
          </ul>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 10 }}>
            To export a matched pair instead, cancel and uncheck &ldquo;Virginize RFH SEC16&rdquo;.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.ts, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={e => setDontAsk(e.target.checked)}
              data-testid="virginize-dont-ask"
              style={{ accentColor: C.a3, cursor: 'pointer' }}
            />
            Don&rsquo;t ask again for the rest of this session
          </label>
        </div>
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${C.bd}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10, background: C.c2,
        }}>
          <button
            onClick={onCancel}
            data-testid="virginize-cancel"
            style={{
              padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.bd}`,
              background: C.cd, color: C.tx, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm?.(dontAsk)}
            data-testid="virginize-confirm-btn"
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: C.sr, color: '#FFFFFF', fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}>
            Acknowledge &amp; Download
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ModuleSync({ vehicleId, files: dumpsFiles } = {}) {
  const { vin: masterVin, vinValid: masterVinValid, clearDumps } = useMasterVin();

  const [bcm, setBcm] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [rfh, setRfh] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [pcm, setPcm] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [eep, setEep] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [vehicleFamily, setVehicleFamily] = useState('');

  const [targetVin, setTargetVin] = useState('');
  const [virginize, setVirginize] = useState(false);
  /* Task #475 — explicit target-chip selection for the PCM bundler output.
   * `null` = "auto / match the donor chip"; '4kb' / '8kb' = user picked
   * a different bench chip than the donor and acknowledges that the
   * generated file will be padded or sliced to match. */
  const [targetPcmChip, setTargetPcmChip] = useState(null);
  /* Task #794 — compatibility mode for the BCM flat-0x40C9 repair button.
   * 'canonical' (default): preserves mirror1 record when it overlaps the
   * flat slice (older BCM layouts where mirror1 sits at 0x40C0). Modern
   * tools + SRT Lab read the canonical BE secret; legacy tools that read
   * the flat slice as LE will see reversed garbage on these dumps.
   * 'legacy-flat': forces the LE write even on overlap, clobbering the
   * mirror1 SEC16 payload so CGDI / AlfaOBD / SINCRO can verify the
   * file. SRT Lab still recovers the secret from split records. */
  const [flatRepairMode, setFlatRepairMode] = useState('canonical');
  const [logLines,  setLogLines]  = useState([]);
  const [diffRows,  setDiffRows]  = useState([]);
  const [originals, setOriginals] = useState({ bcm: null, rfh: null, pcm: null, eep: null });
  const [wizardOpen, setWizardOpen] = useState(false);
  /* Task #574 — PCM repair wizard modal open state. Strictly gated by
   * the `pcmRepairable` derived flag below; on a working/drivable PCM
   * (VINs match BCM, SEC6 populated + marker OK, IMMO byte 0x80) the
   * CTA never appears so the wizard cannot be opened. */
  const [pcmRepairOpen, setPcmRepairOpen] = useState(false);
  /* Task #1052 — Full 3-Module Pairing Repair panel. */
  const [pairingRepairOpen, setPairingRepairOpen] = useState(false);
  /* Task #1056 — track which DropZone slots were patched by PairingRepairPanel
   * so we can show the "✓ Repaired" badge. Cleared when a new file is dropped. */
  const [repairedSlots, setRepairedSlots] = useState({ bcm: false, rfh: false, pcm: false });
  /* Confirm dialog shown before a sync proceeds when one or more loaded
   * modules carry pnOverride (registry compatibility check was bypassed). */
  const [overrideConfirm, setOverrideConfirm] = useState(null); /* { action, overrideVin, modules } */
  const skipOverrideConfirmRef = useRef(false); /* per-session "don't ask again" */
  /* Task #801 — pre-download confirm for the BCM flat 0x40C9 repair on
   * overlap dumps. Holds { action, overrideVin, mode } until the tech
   * acknowledges (or cancels) the compatibility trade-off. */
  const [flatRepairConfirm, setFlatRepairConfirm] = useState(null);
  const skipFlatRepairConfirmRef = useRef(false);
  /* One-shot bypass set by the flat-repair confirm's onConfirm so the
   * re-entry through doSync() doesn't re-open the modal but still runs
   * every other preflight (notably the P/N override prompt). Cleared
   * the moment doSync() consumes it. */
  const flatRepairJustConfirmedRef = useRef(false);
  /* Task #1025 — pre-download confirm for any sync that ships a virginized
   * RFHUB. Holds { action, overrideVin } until the tech acknowledges (or
   * cancels) that the exported BCM/RFHUB pair shares no immobilizer secret
   * and the RFHUB must be re-keyed on the bench. Mirrors the flat-repair
   * confirm: per-session "don't ask again" + one-shot re-entry bypass so
   * the remaining preflight gates still run. */
  const [virginizeConfirm, setVirginizeConfirm] = useState(null);
  const skipVirginizeConfirmRef = useRef(false);
  const virginizeJustConfirmedRef = useRef(false);
  const logRef = useRef(null);

  const log = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines(p => [...p, { ts, msg, level }]);
  }, []);

  /* handleReset (Task #464) — port of TwinTab's "Clean / Reset" so the
   * Module Sync workspace gets the same fast clean-slate gesture. Clears:
   *   - all four loaded module slots (BCM / RFH / PCM / 95640)
   *   - the diff-rows table and the originals snapshots used for "Undo"
   *   - the pre-filled target VIN field
   *   - the on-screen log
   * It also calls clearDumps() on the master-VIN context so the "Dumps"
   * tab and the global Master VIN ribbon don't keep stale references to
   * the files that just got removed from this tab. The vehicle family
   * stays selected because that's a registry pick rather than per-file
   * state, and a tech who's about to load a second car of the same
   * family shouldn't have to re-pick it. Pure UI state — no engine,
   * parser, or writer code is touched. */
  const handleReset = useCallback(() => {
    setBcm({ file: null, bytes: null, parsed: null, pnOverride: false });
    setRfh({ file: null, bytes: null, parsed: null, pnOverride: false });
    setPcm({ file: null, bytes: null, parsed: null, pnOverride: false });
    setEep({ file: null, bytes: null, parsed: null, pnOverride: false });
    setDiffRows([]);
    setOriginals({ bcm: null, rfh: null, pcm: null, eep: null });
    setTargetVin('');
    setTargetPcmChip(null);
    setLogLines([]);
    if (typeof clearDumps === 'function') clearDumps();
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines([{ ts, msg: 'Workspace cleared — all modules, diff rows, originals, and target VIN reset.', level: 'info' }]);
  }, [clearDumps]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logLines]);
  useEffect(() => {
    log('SRT Lab Module Sync v2 (SINCRO-verified engine) ready.', 'info');
    log('Supports: BCM Gen1/Gen2 (SEC16 split records + mirrors) · RFHUB Gen1/Gen2 · PCM GPEC2A (4 KB / 8 KB)', 'muted');
  }, [log]);

  /* Task #475 — pick a sensible default target chip for the PCM bundler
   * output whenever the loaded PCM changes. The default mirrors the
   * source-chip detection so a tech who doesn't touch the selector
   * still gets the right byte count for their bench, with one carve-out
   * for the long-known "doubled 8 KB capture with 0xFF half-2" pattern
   * (95320 chip read as 8 KB by some readers): we default that to 4 KB
   * to preserve the pre-#475 auto-slice behaviour and avoid producing
   * a file CGDI will reject. */
  useEffect(() => {
    if (!pcm.bytes || pcm.parsed?.tooSmall) {
      setTargetPcmChip(null);
      return;
    }
    const chip = pcmChipFromSize(pcm.parsed?.size);
    if (!chip) {
      /* Non-canonical donor — leave target unset; the action card will
       * block Generate and surface the chip-mismatch help line. */
      setTargetPcmChip(null);
      return;
    }
    if (chip.chipKey === '8kb' && pcm.bytes.length === 8192) {
      const half2 = pcm.bytes.slice(4096);
      const halfPad = half2.every((b) => b === 0xFF);
      setTargetPcmChip(halfPad ? '4kb' : '8kb');
      return;
    }
    setTargetPcmChip(chip.chipKey);
  }, [pcm.bytes, pcm.parsed?.size, pcm.parsed?.tooSmall]);

  const handleBcm = useCallback((file, bytes) => {
    const cfErr = corruptFillError(parseModule(bytes, file.name));
    if (cfErr) { log(cfErr, 'err'); return; }
    const parsed = engParseBcm(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setBcm({ file, bytes, parsed, pnOverride });
    setRepairedSlots(prev => ({ ...prev, bcm: false }));
    setDiffRows([]); setOriginals(prev => ({ ...prev, bcm: null }));
    log(`Loaded BCM: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ BCM file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the BCM in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ BCM was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.ok) {
      log(`  BCM VIN: ${parsed.vin} · ${parsed.vinSlots.length} slot(s)`, 'ok');
      if (parsed.sec16Records.length > 0)
        log(`  SEC16 split records: ${parsed.sec16Records.length} found · consistent: ${parsed.sec16Consistent}`, 'ok');
      if (parsed.banks)
        log(`  Active bank: ${parsed.banks.activeBank} (seq 0x${hex4(parsed.banks.activeBank === 0 ? parsed.banks.bank0Seq : parsed.banks.bank1Seq)})`, 'muted');
    } else {
      log('  BCM: no VIN parsed — file format not recognized', 'err');
    }
    const match = bcmVehicleMatch(parsed);
    if (match) {
      log(`  Vehicle: ${match.name} (${match.sec})`, 'muted');
      /* Auto-select vehicle family if the BCM PN is in the catalog */
      for (const fam of VEHICLE_FAMILIES) {
        if (fam.expectedPns.includes(match.pn)) { setVehicleFamily(fam.id); break; }
      }
    }
  }, [log, dumpsFiles]);

  const handleRfh = useCallback((file, bytes) => {
    const cfErr = corruptFillError(parseModule(bytes, file.name));
    if (cfErr) { log(cfErr, 'err'); return; }
    const parsed = engParseRfh(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setRfh({ file, bytes, parsed, pnOverride });
    setRepairedSlots(prev => ({ ...prev, rfh: false }));
    setDiffRows([]); setOriginals(prev => ({ ...prev, rfh: null }));
    log(`Loaded RFHUB: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ RFHUB file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the RFHUB in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ RFHUB was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.virginChip) {
      log(`  RFHUB: VIRGIN CHIP — factory 0x30-fill, blank SEC16 · format: ${parsed.format}`, 'warn');
      if (parsed.partNumbers?.length) log(`  Part numbers: ${parsed.partNumbers.join(', ')}`, 'muted');
      log('  → Load BCM and use “BCM SEC16 → RFHUB” to program this virgin chip.', 'info');
    } else if (parsed.ok) {
      log(`  RFHUB VIN: ${parsed.vin} · format: ${parsed.format}`, 'ok');
      if (parsed.sec16) log(`  SEC16: ${parsed.sec16.virgin ? 'VIRGIN' : parsed.sec16.match ? 'matched' : 'MISMATCH'} · ${[...parsed.sec16.slot1].map(hex2).join('').toUpperCase()}`, 'muted');
    } else {
      log('  RFHUB: no VIN parsed — file format not recognized', 'err');
    }
  }, [log, dumpsFiles]);

  const handlePcm = useCallback((file, bytes) => {
    const cfErr = corruptFillError(parseModule(bytes, file.name));
    if (cfErr) { log(cfErr, 'err'); return; }
    const parsed = engParsePcm(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setPcm({ file, bytes, parsed, pnOverride });
    setRepairedSlots(prev => ({ ...prev, pcm: false }));
    setDiffRows([]); setOriginals(prev => ({ ...prev, pcm: null }));
    log(`Loaded PCM: ${file.name} (${bytes.length} bytes) · ${parsed.variant}`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ PCM file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the PCM in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ PCM was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.vin)  log(`  PCM VIN: ${parsed.currentVin}${parsed.originalVin && parsed.originalVin !== parsed.currentVin ? ` (orig: ${parsed.originalVin})` : ''}`, parsed.ok ? 'ok' : 'warn');
    if (parsed.sec6) log(`  SEC6: ${parsed.sec6.bytes.map(hex2).join('').toUpperCase()} (marker ${parsed.sec6.marker})`, 'muted');
    if (parsed.immoDamaged) log('  ⚠ PCM: no SEC6 marker found — may be damaged or wrong file', 'warn');
  }, [log, dumpsFiles]);

  const handleEep = useCallback((file, bytes) => {
    const cfErr = corruptFillError(parseModule(bytes, file.name));
    if (cfErr) { log(cfErr, 'err'); return; }
    const parsed = engParseEep95640(bytes, file.name);
    setEep({ file, bytes, parsed });
    setDiffRows([]); setOriginals(prev => ({ ...prev, eep: null }));
    log(`Loaded 95640: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ 95640 file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the 95640 in full or load the correct file.`, 'err');
      return;
    }
    if (parsed.vin) log(`  95640 VIN: ${parsed.vin} · ${parsed.vinSlots.length} slot(s)`, 'ok');
    if (parsed.bcmSec16) {
      if (parsed.bcmSec16Blank) log(`  95640 BCM-SEC16 @0x838: BLANK (virgin)`, 'warn');
      else log(`  95640 BCM-SEC16 @0x838: ${parsed.bcmSec16Hex} · CRC16 ${parsed.bcmSec16CrcOk ? '✓' : '✗ (stored=0x' + hex4(parsed.bcmSec16StoredCrc) + ' calc=0x' + hex4(parsed.bcmSec16CalcCrc) + ')'}`, parsed.bcmSec16CrcOk ? 'ok' : 'warn');
    } else if (bytes.length < 0x84A) {
      log(`  95640: file too small for SEC16 region (need ≥0x84A bytes)`, 'warn');
    }
    if (!parsed.ok && !parsed.vin && (!parsed.bcmSec16 || parsed.bcmSec16Blank)) {
      log('  95640: no VIN and no SEC16 — file may be virgin or unrecognized', 'warn');
    }
  }, [log, dumpsFiles]);

  /* Task #1056 — fired by PairingRepairPanel after a successful apply+validate
   * round. Updates each module slot with patched bytes and marks it repaired
   * so the "✓ Repaired" badge appears on the DropZone card. */
  const handlePatchComplete = useCallback(({ bcm: bcmBuf, rfhub: rfhBuf, pcm: pcmBuf }) => {
    const newRepaired = { bcm: false, rfh: false, pcm: false };
    if (bcmBuf) {
      const parsed = engParseBcm(bcmBuf, bcm.file?.name || 'BCM_PAIRED.bin');
      const syntheticFile = { name: bcm.file?.name || 'BCM_PAIRED.bin', size: bcmBuf.length };
      setBcm(prev => ({ ...prev, file: syntheticFile, bytes: bcmBuf, parsed }));
      newRepaired.bcm = true;
    }
    if (rfhBuf) {
      const parsed = engParseRfh(rfhBuf, rfh.file?.name || 'RFHUB_PAIRED.bin');
      const syntheticFile = { name: rfh.file?.name || 'RFHUB_PAIRED.bin', size: rfhBuf.length };
      setRfh(prev => ({ ...prev, file: syntheticFile, bytes: rfhBuf, parsed }));
      newRepaired.rfh = true;
    }
    if (pcmBuf) {
      const parsed = engParsePcm(pcmBuf, pcm.file?.name || 'PCM_PAIRED.bin');
      const syntheticFile = { name: pcm.file?.name || 'PCM_PAIRED.bin', size: pcmBuf.length };
      setPcm(prev => ({ ...prev, file: syntheticFile, bytes: pcmBuf, parsed }));
      newRepaired.pcm = true;
    }
    setRepairedSlots(newRepaired);
    const names = [newRepaired.bcm && 'BCM', newRepaired.rfh && 'RFHUB', newRepaired.pcm && 'PCM'].filter(Boolean);
    log(`🔧 Pairing Repair applied — module slots updated from PairingRepairPanel: ${names.join(', ')}`, 'ok');
  }, [bcm.file, rfh.file, pcm.file, log]);

  const tv      = targetVin.replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, VIN_LEN);
  const tvOk    = tv.length === VIN_LEN && VIN_RE.test(tv);
  const loaded  = (bcm.bytes ? 1 : 0) + (rfh.bytes ? 1 : 0) + (pcm.bytes ? 1 : 0) + (eep.bytes ? 1 : 0);
  const bothReady = !!(bcm.bytes && rfh.bytes && bcm.parsed?.ok && rfh.parsed?.ok);
  /* Resolver lookup for the legacy-flat 0x40C9 repair button (Task #382).
   * Only enable the repair when the resolver picked a live record-table
   * source (split / mirror1 / mirror2) AND the SEC16 isn't blank — copying
   * the flat slice onto itself, or copying garbage from a virgin BCM, would
   * not help legacy CGDI/Autel readers and could mask a real problem. */
  const flatRepairResolver = bcm.bytes && bcm.parsed?.ok ? resolveBcmSec16(bcm.bytes) : null;
  const flatRepairOk = !!(flatRepairResolver
    && flatRepairResolver.bytes
    && !flatRepairResolver.blank
    && flatRepairResolver.source
    && flatRepairResolver.source !== 'flat');
  /* Task #800 — overlap = mirror1 record at 0x40C0 collides with the
   * flat 0x40C9 slice, which is the only condition under which the
   * canonical and legacy-flat outputs differ. The "Download both copies"
   * action only makes sense on overlap dumps; otherwise the two outputs
   * are byte-identical. */
  const flatRepairOverlap = flatRepairResolver?.candidates?.mirror1?.offset === 0x40C0;
  const vinMatch  = bothReady && bcm.parsed.vin === rfh.parsed.vin;

  /* SEC16 sync eligibility.
   * Task #815: sec16Absent (from engParseBcm) means the BCM carries no real
   * key material — split records + mirrors are both empty. bcmHasSec16 is
   * false in that state, which already disables the sec16-only and
   * bcm-sec16-to-rfh actions. The explicit `!sec16Absent` guard is belt-and-
   * suspenders so new action variants can never accidentally bypass the gate. */
  const bcmSec16Absent   = !!(bcm.parsed?.sec16Absent);
  const bcmHasSec16      = !bcmSec16Absent && !!(bcm.parsed?.sec16Records?.length > 0 || bcm.parsed?.mirrorsPopulated > 0);
  const rfhHasSec16      = !!(rfh.parsed?.sec16 && !rfh.parsed.sec16.virgin);
  const sec16SyncOk      = bcmHasSec16 && rfhHasSec16;
  const bcmToRfhSec16Ok  = bcmHasSec16 && (rfh.parsed?.format?.startsWith('gen2') || !!(rfh.bytes && isXc2268Rfhub(rfh.bytes)));
  /* Combined VIN + SEC16 write for virgin RFHUB chips.
   * Requires: BCM with VIN + SEC16, RFHUB that is a virgin chip (virginChip)
   * OR a Gen2 RFHUB that needs both VIN and SEC16 overwritten from BCM. */
  const bcmVinSec16ToRfhOk = bcm.parsed?.ok && bcm.parsed?.vin && bcmToRfhSec16Ok;
  /* Virgin BCM gate — true when BCM parsed OK AND no FEE records exist
   * (split records + inactive-bank mirrors all blank). The legacy flat slice
   * at 0x40C9 may carry stale provisioning data on virgin-provisioned BCMs
   * even with no FEE records, so we intentionally ignore it here; the re-key
   * action overwrites the flat slice with the correct SEC16 value. */
  const bcmFullyVirgin   = !!(
    bcm.parsed?.ok
    && bcm.parsed.sec16Records?.length === 0
    && !(bcm.parsed.mirrorsPopulated > 0)
  );

  /* Task #475 — derived PCM chip state shared by the action card UI and
   * the doSync() / executeSync() guards. `pcmSourceChip` is the chip
   * descriptor inferred from the loaded donor's byte length (null when
   * the file is non-canonical). `pcmHasNonCanonicalSize` blocks Generate
   * for any sync action that would emit a PCM file. `targetChipDescriptor`
   * resolves the user-picked / auto-default target chip, and
   * `targetChipMismatch` triggers the confirm prompt + amber selector
   * border so the tech sees that donor and target sizes diverge. */
  const pcmSourceChip = pcm.parsed && !pcm.parsed.tooSmall ? pcmChipFromSize(pcm.parsed.size) : null;
  const pcmHasNonCanonicalSize = !!(pcm.parsed && !pcm.parsed.tooSmall && !pcmSourceChip);
  /* Task #1036 — refuse-on-doubt: SYNC ALL must NOT blindly pair a virgin /
   * blank engine module. This mirrors runKeyProgPatch's "PCM SEC6 is prefix
   * of shared secret" guard: a canonical-size GPEC2A whose SEC6 secret slot
   * @0x3C8 is blank (all-FF / all-00 / mostly-FF — classifyPcmSec6 reports
   * !populated) carries no existing immobilizer pairing to verify against, so
   * stamping reverse(BCM)[0:6] onto it would silently fabricate a pairing on a
   * module that may be the wrong file or a bad dump. Derived once here so the
   * SYNC ALL preview gating and the executeSync('sync-all') writer share a
   * single predicate — preview MUST mirror writer gating (drift is the bug
   * class). Non-canonical sizes are handled by pcmHasNonCanonicalSize first,
   * so this only fires on a genuine 4 KB / 8 KB GPEC2A with a blank SEC6. */
  const pcmSec6Blank = !!(
    pcm.bytes && pcm.parsed
    && (pcm.bytes.length === 4096 || pcm.bytes.length === 8192)
    && !(pcm.parsed.sec6Class && pcm.parsed.sec6Class.populated)
  );
  const effectiveTargetChipKey = targetPcmChip || pcmSourceChip?.chipKey || null;
  const targetChipDescriptor = effectiveTargetChipKey ? pcmChipFromKey(effectiveTargetChipKey) : null;
  const targetChipMismatch = !!(pcmSourceChip && targetPcmChip && targetPcmChip !== pcmSourceChip.chipKey);

  /* Task #574 — PCM repair eligibility. STRICT guards so a working,
   * drivable PCM (VINs match BCM, SEC6 marker present + secret bytes
   * populated, IMMO byte at 0x0011 not all-FF) NEVER surfaces the
   * Repair CTA. Required preconditions:
   *   - BCM and RFHUB are both parsed and agree on VIN (vinMatch)
   *   - RFHUB carries a non-virgin SEC16 (rfhHasSec16) — the trusted
   *     source of the 6-byte pairing secret
   *   - PCM is loaded with canonical GPEC2A size (4096 or 8192 B)
   *   - BCM VIN is valid
   *   - At least one genuine damage signal is present:
   *       a) parsed.immoDamaged (SEC6 marker missing OR class !populated)
   *       b) any PCM VIN slot doesn't match the trusted BCM VIN
   *          (or no VIN slots decoded at all on a canonical-sized dump)
   *       c) IMMO byte at 0x0011..0x0014 is all-FF (IMMO_DAMAGED state) */
  const pcmCanonicalSize = !!(pcm.bytes && (pcm.bytes.length === 4096 || pcm.bytes.length === 8192));
  const pcmVinSlotMismatch = !!(pcm.parsed && bcm.parsed?.vin && (
    (Array.isArray(pcm.parsed.vinSlots) && pcm.parsed.vinSlots.length === 0)
    || (Array.isArray(pcm.parsed.vinSlots) && pcm.parsed.vinSlots.some(s => s.vin !== bcm.parsed.vin))
  ));
  /* IMMO byte at 0x0011 is repairable when it is NOT the canonical
   * ENABLED pattern (0x80 00 00 00). Spec calls out "IMMO byte not
   * enabled" — that includes both DISABLED (0x00 00 00 00) and the
   * IMMO_DAMAGED virgin state (FF FF FF FF). A drivable file with the
   * exact ENABLED pattern is intentionally NOT a damage signal. */
  const pcmImmoNotEnabled = !!(pcm.bytes && pcm.bytes.length > 0x14 && (
    pcm.bytes[0x0011] !== 0x80 || pcm.bytes[0x0012] !== 0x00
    || pcm.bytes[0x0013] !== 0x00 || pcm.bytes[0x0014] !== 0x00
  ));
  const pcmImmoLabel = pcmImmoNotEnabled
    ? (pcm.bytes && pcm.bytes[0x0011] === 0xFF
        ? 'IMMO byte all-FF @0x0011'
        : pcm.bytes && pcm.bytes[0x0011] === 0x00
          ? 'IMMO byte DISABLED @0x0011'
          : 'IMMO byte not enabled @0x0011')
    : null;
  const pcmDamageSignals = [];
  if (pcm.parsed?.immoDamaged) pcmDamageSignals.push('SEC6 marker/secret damaged');
  if (pcmVinSlotMismatch)      pcmDamageSignals.push('VIN slots ≠ BCM VIN');
  if (pcmImmoLabel)            pcmDamageSignals.push(pcmImmoLabel);

  /* Resolve the trusted 6-byte pairing secret from RFHUB SEC16. The
   * secret is only "resolved" when the source is canonical:
   *   - both SEC16 slots present, non-virgin, and slot1 ≡ slot2
   *   - first 6 bytes are not blank (all-FF or all-00)
   * If RFHUB SEC16 slots disagree we refuse to produce a repair —
   * better to keep the user in MismatchWizard land than write a
   * possibly-wrong secret into the PCM. */
  const _rfhSec16 = rfh.parsed?.sec16;
  const rfhSec16Resolved = !!(
    _rfhSec16 && !_rfhSec16.virgin && _rfhSec16.match
    && _rfhSec16.slot1 && _rfhSec16.slot1.length >= 6
  );
  const _candidateSec6 = rfhSec16Resolved
    ? new Uint8Array(_rfhSec16.slot1.slice(0, 6))
    : null;
  const _sec6Blank = _candidateSec6
    ? (_candidateSec6.every(b => b === 0xFF) || _candidateSec6.every(b => b === 0x00))
    : true;
  const pcmRepairSecretOk = rfhSec16Resolved && !_sec6Blank;
  const pcmRepairSecret6 = pcmRepairSecretOk ? _candidateSec6 : null;

  const pcmRepairable = !!(
    bothReady && vinMatch && rfhHasSec16
    && pcmRepairSecretOk
    && pcm.bytes && pcm.parsed && !pcm.parsed.tooSmall
    && pcmCanonicalSize
    && bcm.parsed?.vin && VIN_RE.test(bcm.parsed.vin)
    && pcmDamageSignals.length > 0
  );

  /* 95640 re-key eligibility — needs RFHUB SEC16 master + 95640 dump ≥0x84A bytes */
  const eep95640Loaded   = !!eep.bytes;
  const rekey95640Ok     = eep95640Loaded && rfhHasSec16 && eep.bytes.length >= 0x84A;

  /* Task #396 — single source of truth: re-parse loaded bytes through
   * parseModule() and run the canonical crossValidate() rules. The
   * returned issues/warnings are merged (deduped) into the wizard's
   * arrays below. Pre-#396 the wizard's rules were entirely hand-rolled
   * which let the BCM↔PCM SEC6 pairing rule drift out of the wizard
   * even though crossValidate already had it. Memoised on the byte
   * references so re-parsing only happens when a file is loaded or
   * replaced. */
  const cvResult = useMemo(() => {
    const mods = [];
    if (bcm.bytes) { try { mods.push(parseModule(bcm.bytes, bcm.name || 'bcm.bin')); } catch { /* ignore parse errors */ } }
    if (rfh.bytes) { try { mods.push(parseModule(rfh.bytes, rfh.name || 'rfh.bin')); } catch { /* ignore */ } }
    if (pcm.bytes) { try { mods.push(parseModule(pcm.bytes, pcm.name || 'pcm.bin')); } catch { /* ignore */ } }
    if (eep.bytes) { try { mods.push(parseModule(eep.bytes, eep.name || '95640.bin')); } catch { /* ignore */ } }
    if (mods.length === 0) return { issues: [], warnings: [], passed: [] };
    try { return crossValidate(mods); } catch { return { issues: [], warnings: [], passed: [] }; }
  }, [bcm.bytes, rfh.bytes, pcm.bytes, eep.bytes, bcm.name, rfh.name, pcm.name, eep.name]);

  /* Wizard issue/warning arrays — start from crossValidate output so the
   * wizard and AI assistant all share one rule set. Hand-rolled rules
   * below add wizard-specific context that crossValidate does not
   * cover, with dedupe to avoid double-counting. */
  const wizardIssues = [...(cvResult.issues || [])];
  const wizardWarnings = [...(cvResult.warnings || [])];
  const _seenIssues = new Set(wizardIssues);
  const _seenWarnings = new Set(wizardWarnings);
  const _pushIssue = (msg) => { if (!_seenIssues.has(msg)) { _seenIssues.add(msg); wizardIssues.push(msg); } };
  const _pushWarning = (msg) => { if (!_seenWarnings.has(msg)) { _seenWarnings.add(msg); wizardWarnings.push(msg); } };
  /* VIN mismatch, RFHUB↔BCM vehicle secret mismatch, and RFHUB SEC16
   * blank/slot-mismatch warnings now flow exclusively from
   * crossValidate() via cvResult above (Task #396 — single source of
   * truth). Keeping the rules inline here would double-emit. */

  /* 95640 BCM-backup chip — flag mismatch/blank vs RFHUB SEC16 (reversed) */
  if (eep.bytes && rfhHasSec16 && rfh.parsed.sec16.slot1) {
    if (eep.bytes.length < 0x84A) {
      wizardWarnings.push(`95640 file too small (need ≥0x84A bytes for BCM-SEC16 region)`);
    } else if (!eep.parsed?.bcmSec16 || eep.parsed.bcmSec16Blank) {
      wizardIssues.push(`95640 BCM-SEC16 BLANK — backup chip needs re-keying from RFHUB`);
    } else {
      const rfhRevHex = bytesToHex(Array.from(rfh.parsed.sec16.slot1).reverse()).toUpperCase();
      if (eep.parsed.bcmSec16Hex !== rfhRevHex)
        wizardIssues.push(`95640 BCM-SEC16 MISMATCH: 95640 token ≠ reverse(RFHUB SEC16)`);
    }
  }

  /* The BCM SEC16 → SEC6 ↔ PCM SEC6 rule that closed the Task #396
   * incident now lives in crossValidate.js (the canonical validator)
   * and flows into wizardIssues via cvResult above — keeping a single
   * source of truth instead of mirroring the rule inline here. */

  /* PN-family mismatch — informational warning for wizard */
  const pnFamResult = vehicleFamily && bcm.parsed?.ok ? bcmFamilyMismatch(bcm.parsed, vehicleFamily) : null;
  if (pnFamResult && !pnFamResult.match) {
    wizardWarnings.push(
      `BCM PN MISMATCH: vehicle=${pnFamResult.family.label}, expected=${pnFamResult.expected?.join('/') || '—'}, detected=${pnFamResult.detected.join(', ') || 'none'}`
    );
  }

  const wizardModules = [bcm.bytes && 'BCM', rfh.bytes && 'RFHUB', pcm.bytes && 'PCM', eep.bytes && '95640'].filter(Boolean);

  /* Hex snippets with offset annotations for structured Claude context */
  const wizardHexSnippets = [];
  if (rfh.parsed?.sec16?.slot1) {
    const off = rfh.parsed.format?.startsWith('gen2') ? '0x050E' : '0x00AE';
    wizardHexSnippets.push(`RFHUB SEC16 @${off}: ${bytesToHex(rfh.parsed.sec16.slot1).toUpperCase()}`);
  }
  if (bcmSec16Absent) {
    /* Task #815 — BCM is in ALERT_NO_SECURITY / VIN-only state. Surface the
     * verdict explicitly so Claude can give correct guidance ("load the RFHUB
     * as master") instead of receiving phantom bytes and describing a mismatch
     * that doesn't exist. */
    wizardHexSnippets.push('BCM SEC16: ABSENT (ALERT_NO_SECURITY — no SEC16 in split records or mirrors; VIN-only edition; use RFHUB as the authoritative key source)');
  } else if (bcm.parsed?.sec16Hex) {
    const recOff = bcm.parsed.sec16Records?.[0]?.offset != null
      ? `0x${hex4(bcm.parsed.sec16Records[0].offset)}` : '0x4090';
    wizardHexSnippets.push(`BCM SEC16 @${recOff}: ${bcm.parsed.sec16Hex.toUpperCase()}`);
  }
  if (bcm.parsed?.vin)
    wizardHexSnippets.push(`BCM VIN @0x0000: ${bcm.parsed.vin}`);
  if (rfh.parsed?.vin)
    wizardHexSnippets.push(`RFHUB VIN @0x5320: ${rfh.parsed.vin}`);

  /* Step actions available in wizard matching doSync() actions */
  const wizardStepActions = [
    { id: 'full-sync',        label: '⚡ Full 3-Module Sync',    enabled: bothReady, description: 'VIN + SEC16 + SEC6 across all modules' },
    { id: 'sec16-only',       label: '🔐 SEC16 Sync Only',       enabled: sec16SyncOk, description: 'RFHUB SEC16 → BCM + PCM SEC6' },
    { id: 'bcm-sec16-to-rfh', label: '🔄 BCM SEC16 → RFHUB',    enabled: bcmToRfhSec16Ok, description: 'Use BCM as master, write to RFHUB Gen2 slots' },
    { id: 'bcm-vin-sec16-to-rfh', label: '🏭 BCM VIN + SEC16 → RFHUB', enabled: bcmVinSec16ToRfhOk, description: 'Write BCM VIN + SEC16 into virgin/replacement RFHUB in one pass' },
    { id: 'rfh-to-bcm',       label: '← RFHUB VIN → BCM',       enabled: bothReady, description: 'Stamp BCM with RFHUB VIN' },
    { id: 'bcm-to-rfh',       label: '→ BCM VIN → RFHUB',       enabled: bothReady, description: 'Stamp RFHUB with BCM VIN' },
    { id: 'rekey-95640-from-rfh', label: '📟 Re-key 95640 from RFHUB', enabled: rekey95640Ok, description: 'Write reverse(RFHUB SEC16) → 95640 @ 0x838 + CRC16 @ 0x848' },
    { id: 'rekey-virgin-bcm', label: '🔓 Re-key virgin BCM ← RFHUB', enabled: bcmFullyVirgin && rfhHasSec16, description: 'Write reverse(RFHUB SEC16) into all BCM SEC16 locations + normalise FOBIK count' },
  ];

  const doSync = (action, overrideVin) => {
    /* Task #940 — corrupt-capture guard. Even though the load handlers
     * reject OBDSTAR6-class tool-error fills up-front, re-check every
     * loaded buffer at the moment of sync so a flagged file can never
     * reach the SEC16 / VIN / SEC6 writers regardless of how it entered a
     * slot. Only the modules the chosen action actually touches are
     * checked, so a corrupt-but-unused module can't block an unrelated
     * sync. */
    const participants = MODSYNC_ACTION_PARTICIPANTS[action] || ['BCM', 'RFHUB', 'PCM'];
    const corruptSlots = [];
    const checkSlot = (name, bytes) => {
      if (!bytes) return;
      const cf = detectCorruptFill(bytes);
      if (cf) corruptSlots.push({ name, cf });
    };
    if (participants.includes('BCM'))   checkSlot('BCM', bcm.bytes);
    if (participants.includes('RFHUB')) checkSlot('RFHUB', rfh.bytes);
    if (participants.includes('PCM'))   checkSlot('PCM', pcm.bytes);
    if (participants.includes('EEP') || participants.includes('95640')) checkSlot('95640', eep.bytes);
    if (corruptSlots.length > 0) {
      for (const { name, cf } of corruptSlots) {
        log(`✗ ${action} blocked: ${name} buffer is a corrupt capture (${cf.reason}) — ${cf.detail} Re-read the module with verified hardware before syncing.`, 'err');
      }
      return;
    }
    /* Task #1025 — when VIRGINIZE is checked on any sync that ships the
     * RFHUB, the exported BCM/RFHUB pair shares no immobilizer secret and
     * the RFHUB must be re-keyed on the bench. Surface an explicit confirm
     * the first time the tech downloads a virginized set this session
     * (honours the per-session "don't ask again" + one-shot re-entry
     * bypass so the remaining preflight gates still run). */
    const virginizesRfh = virginize
      && ['rfh-to-bcm', 'bcm-to-rfh', 'target-both', 'sync-all', 'full-sync'].includes(action);
    if (virginizesRfh) {
      if (virginizeJustConfirmedRef.current) {
        virginizeJustConfirmedRef.current = false;
      } else if (!skipVirginizeConfirmRef.current) {
        setVirginizeConfirm({ action, overrideVin });
        return;
      }
    }
    /* Task #801 — on overlap dumps (mirror1 at 0x40C0 colliding with the
     * flat 0x40C9 slice), the compatibility-mode choice has real
     * consequences for which bench tool will accept the downloaded file.
     * Surface a pre-download confirm summarizing the trade-off the first
     * time the tech clicks the repair button this session. Skipped when
     * "don't ask again" was checked, or when no overlap is present. */
    if (action === 'bcm-flat-from-resolved') {
      if (flatRepairJustConfirmedRef.current) {
        /* Consume the one-shot bypass set by the confirm modal so the
         * remaining preflight gates (P/N override etc.) still run. */
        flatRepairJustConfirmedRef.current = false;
      } else if (!skipFlatRepairConfirmRef.current) {
        const overlap = flatRepairResolver?.candidates?.mirror1?.offset === 0x40C0;
        if (overlap) {
          setFlatRepairConfirm({ action, overrideVin, mode: flatRepairMode });
          return;
        }
      }
    }
    /* Task #475 — block any sync that emits a PCM file when the loaded
     * PCM is non-canonical, so a tech can't get past the disabled
     * button via a wizard step / programmatic call and end up with a
     * file the bench programmer rejects. Stays in lock-step with the
     * inline help line under the action grid. */
    const writesPcm = action === 'sync-all' || action === 'full-sync' || action === 'sec16-only';
    if (writesPcm && pcm.bytes && pcmHasNonCanonicalSize) {
      log(`✗ ${action} blocked: loaded PCM is ${pcm.parsed?.size} B — neither 4 KB (95320) nor 8 KB (95640). Re-read the EXT EEPROM at the matching size before generating.`, 'err');
      return;
    }
    /* Task #475 — when the picked target chip differs from the donor
     * chip, ask the tech to confirm the resize so they explicitly own
     * the byte-count change. Skipped when no PCM is loaded or for
     * actions that don't emit a PCM file. */
    if (writesPcm && pcm.bytes && targetChipMismatch && targetChipDescriptor && pcmSourceChip) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            'PCM target-chip change\n\n'
            + `Donor:  ${pcmSourceChip.label} (${pcm.bytes.length.toLocaleString()} B)\n`
            + `Target: ${targetChipDescriptor.label}\n\n`
            + (targetPcmChip === '4kb'
                ? 'The generated PCM file will be sliced to the first 4 KB so it matches a 95320 bench chip.\n\n'
                : 'The generated PCM file will be 0xFF-padded to 8 KB so it matches a 95640 bench chip.\n\n')
            + 'Continue and produce a file sized for the target chip?'
          )
        : true;
      if (!ok) {
        log(`Sync cancelled — target chip change to ${targetChipDescriptor.sizeLabel} declined.`, 'warn');
        return;
      }
      log(`Acknowledged PCM target-chip change: ${pcmSourceChip.sizeLabel} donor → ${targetChipDescriptor.sizeLabel} target.`, 'warn');
    }
    /* Gate: if any loaded module bypassed the registry check, ask the tech to
     * acknowledge before the sync proceeds. Per-session opt-out is honoured. */
    const overridden = [
      bcm.pnOverride && 'BCM',
      rfh.pnOverride && 'RFHUB',
      pcm.pnOverride && 'PCM',
    ].filter(Boolean);
    if (overridden.length > 0 && !skipOverrideConfirmRef.current) {
      setOverrideConfirm({ action, overrideVin, modules: overridden });
      return;
    }
    return executeSync(action, overrideVin);
  };

  const executeSync = (action, overrideVin) => {
    const ts  = timestamp();
    /* Optional master-VIN override coming from the wizard's scenario card.
     * When present, it replaces the auto-picked VIN for actions that stamp
     * a VIN: rfh-to-bcm, bcm-to-rfh, sync-all (and target-both). */
    const ov = (typeof overrideVin === 'string' && VIN_RE.test(overrideVin)) ? overrideVin : null;
    /* Surface any P/N overrides on the loaded modules so the result log makes
     * it obvious which files bypassed the registry compatibility check. */
    const overridden = [
      bcm.pnOverride && 'BCM',
      rfh.pnOverride && 'RFHUB',
      pcm.pnOverride && 'PCM',
    ].filter(Boolean);
    /* If the sync mixes registry-checked and override files, prompt the
     * operator before continuing. Only modules that the *current action*
     * actually reads or writes are counted — a loaded-but-unused module
     * shouldn't trigger a false-positive warning. */
    const { overrideNames, checkedNames } = computeMixedSyncParticipants(action, {
      BCM:   { loaded: !!bcm.bytes, override: !!bcm.pnOverride },
      RFHUB: { loaded: !!rfh.bytes, override: !!rfh.pnOverride },
      PCM:   { loaded: !!pcm.bytes, override: !!pcm.pnOverride },
    });
    if (overrideNames.length > 0 && checkedNames.length > 0) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            'Mixed sync warning\n\n'
            + 'P/N OVERRIDE (registry bypass): ' + overrideNames.join(', ') + '\n'
            + 'Registry-checked: ' + checkedNames.join(', ') + '\n\n'
            + 'Mixing override and registry-verified files can produce inconsistent results. Continue anyway?'
          )
        : true;
      if (!ok) {
        log(`=== SYNC CANCELLED (${action}): mixed override/registry uploads ===`, 'warn');
        return;
      }
    }
    log(`=== SYNC: ${action}${virginize ? ' +VIRGINIZE' : ''}${ov ? ` (custom VIN ${ov})` : ''} ===`, 'info');
    if (overridden.length > 0) {
      log(`⚠ P/N OVERRIDE in effect for: ${overridden.join(', ')} — registry check was bypassed on the Dumps tab`, 'warn');
    }
    const rows = [];

    const addBcmRows = (parsedBcm, newVin, newCrc) => {
      parsedBcm.vinSlots.forEach((s, idx) => {
        rows.push({
          /* Task #464 — diff-table offsets render as "0x1328 (4904)" so
           * a tech reading the on-screen status next to a hex editor
           * doesn't have to convert from hex in their head. */
          module: 'BCM', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: 'CRC-16',
          oldCheck: s.storedCrc != null ? `0x${hex4(s.storedCrc)}` : '—',
          newCheck: `0x${hex4(newCrc)}`,
          oldPass: s.crcOk, newPass: true,
        });
      });
    };
    const addRfhRows = (parsedRfh, newVin, newChk) => {
      parsedRfh.vinSlots.forEach((s, idx) => {
        rows.push({
          module: 'RFHUB', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: 'Chk',
          oldCheck: s.storedChk != null ? `0x${hex2(s.storedChk)}` : '—',
          newCheck: `0x${hex2(newChk)}`,
          oldPass: s.chkOk, newPass: true,
        });
      });
    };
    const addPcmRows = (parsedPcm, newVin) => {
      parsedPcm.vinSlots.forEach((s, idx) => {
        rows.push({
          module: 'PCM', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: '',
          oldCheck: '—', newCheck: '—',
          oldPass: null, newPass: true,
        });
      });
    };

    try {
      if (action === 'rfh-to-bcm') {
        const newVin = ov || rfh.parsed.vin;
        const newCrc = engCrc16(new TextEncoder().encode(newVin));
        addBcmRows(bcm.parsed, newVin, newCrc);
        const snap = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snap, filename: bcm.file?.name || 'BCM' } }));
        const r  = engWriteBcmVin(bcm.bytes, newVin);
        log(`BCM: patched ${r.fullPatched} full slot(s)${r.shortPatched > 0 ? ` + ${r.shortPatched} tail slot(s)` : ''}`, 'ok');
        /* Task #1023 — VIN-only single-module stamp. Gate PER-FILE (crossModule
         * false, VIN-scoped) so the outgoing VIN-slot CRCs are verified before
         * the _SYNCED label ships, without refusing on the modules' SEC16 state
         * (untouched here). */
        {
          const pendingBcm = [{ role: 'BCM', bytes: r.bytes, name: `BCM_SYNCED_${newVin}_${ts}.bin` }];
          if (virginize) {
            const snapR = new Uint8Array(rfh.bytes);
            setOriginals(prev => ({ ...prev, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
            const rr = engWriteRfhVin(rfh.bytes, newVin, true);
            addRfhRows(rfh.parsed, newVin, rr.chk);
            pendingBcm.push({ role: 'RFH', bytes: rr.bytes, name: `RFH_VIRGIN_${newVin}_${ts}.bin` });
            log(`RFH: re-wrote VIN + wiped ${rr.sec16Wiped} SEC16 slot(s)`, 'warn');
          }
          const verdict = checkExportSafety({ outgoing: pendingBcm, crossModule: false, selfChecks: ['vin', 'partials'] });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — no files were written. A VIN-slot checksum failed verification.', 'err');
            return;
          }
          for (const f of pendingBcm) {
            downloadBin(f.bytes, f.name);
            log(`Downloaded: ${f.name}`, 'ok');
          }
          log(`✓ Pre-download safety gate PASSED — ${pendingBcm.length} file(s) verified before write.`, 'ok');
        }

      } else if (action === 'bcm-to-rfh') {
        const newVin = ov || bcm.parsed.vin;
        const snap   = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snap, filename: rfh.file?.name || 'RFH' } }));
        const r  = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, r.chk);
        log(`RFHUB: patched ${r.patched} slot(s)${virginize ? ` + wiped ${r.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        /* Task #1023 — VIN-only single-module stamp; gate PER-FILE (crossModule
         * false, VIN-scoped) before the _SYNCED label ships. */
        {
          const rfhName = `RFH_SYNCED${virginize ? '_VIRGIN' : ''}_${newVin}_${ts}.bin`;
          const verdict = checkExportSafety({ outgoing: [{ role: 'RFH', bytes: r.bytes, name: rfhName }], crossModule: false, selfChecks: ['vin', 'partials'] });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — no files were written. A VIN-slot checksum failed verification.', 'err');
            return;
          }
          downloadBin(r.bytes, rfhName);
          log(`Downloaded: ${rfhName}`, 'ok');
          log('✓ Pre-download safety gate PASSED — 1 file verified before write.', 'ok');
        }

      } else if (action === 'target-both') {
        const newVin = ov || tv;
        const newCrc = engCrc16(new TextEncoder().encode(newVin));
        const snapB  = new Uint8Array(bcm.bytes);
        const snapR  = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' }, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
        const br = engWriteBcmVin(bcm.bytes, newVin);
        addBcmRows(bcm.parsed, newVin, newCrc);
        log(`BCM: patched ${br.fullPatched} full + ${br.shortPatched} tail slot(s)`, 'ok');
        const rr = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, rr.chk);
        log(`RFHUB: patched ${rr.patched} slot(s)${virginize ? ` + wiped ${rr.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        /* Task #1023 — target-both is a VIN-ONLY sync: it rewrites the VIN in
         * BCM + RFH and never touches SEC16. Gate it PER-FILE (crossModule
         * false) so the outgoing VIN-slot CRCs are verified before the _SYNCED
         * label is applied, WITHOUT refusing on a SEC16 secret mismatch — the
         * two modules' secrets may legitimately still differ here (that is what
         * the SEC16-sync / Sync-all paths are for, and a paired RFH may be
         * virgin). Cross-module secret gating lives on the secret-writing
         * paths, not on a VIN rewrite. */
        {
          const tbPending = [
            { role: 'BCM', bytes: br.bytes, name: `BCM_SYNCED_${newVin}_${ts}.bin` },
            { role: 'RFH', bytes: rr.bytes, name: `RFH_SYNCED${virginize ? '_VIRGIN' : ''}_${newVin}_${ts}.bin` },
          ];
          const verdict = checkExportSafety({ outgoing: tbPending, crossModule: false, selfChecks: ['vin', 'partials'] });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — no files were written. A VIN-slot checksum failed verification.', 'err');
            return;
          }
          for (const f of tbPending) {
            downloadBin(f.bytes, f.name);
            log(`Downloaded: ${f.name}`, 'ok');
          }
          log(`✓ Pre-download safety gate PASSED — ${tbPending.length} file(s) verified before write.`, 'ok');
        }

      } else if (action === 'sync-all') {
        /* Full 3-module sync: VIN → BCM + RFH + PCM, SEC16 BCM ← RFH, SEC6 PCM ← RFH */
        const newVin = ov || (tvOk ? tv : (rfh.parsed?.vin || bcm.parsed?.vin));
        if (!newVin) { log('✗ No target VIN available', 'err'); return; }
        /* Task #1036 — refuse-on-doubt before ANY write: SYNC ALL will not
         * pair a virgin / blank engine module. Same guard runKeyProgPatch
         * enforces ("PCM SEC6 is prefix of shared secret"), now wired into the
         * SYNC ALL writer so it can't fabricate a pairing on a GPEC2A whose
         * SEC6 secret slot is blank. Halts before writePcmSec6 — nothing is
         * written or downloaded. pcmSec6Blank is the same predicate that
         * disables the button, so the preview gating mirrors this exactly. */
        if (pcm.bytes && pcmSec6Blank) {
          log('✗ SYNC ALL refused: the loaded engine module (GPEC2A) has a BLANK SEC6 immobilizer slot (virgin / unpopulated).', 'err');
          log('  Refuse-on-doubt: stamping reverse(BCM)[0:6] onto a blank engine module would fabricate a pairing with nothing to verify against — the same guard the full key-programming wizard (runKeyProgPatch) enforces.', 'err');
          log('  Load a PCM that already carries a populated SEC6, or use the dedicated key-programming wizard if you intend to pair a fresh GPEC2A. No files were written.', 'muted');
          return;
        }
        const newCrc = engCrc16(new TextEncoder().encode(newVin));
        /* Task #1023 — accumulate every outgoing file here instead of writing
         * inline; the pre-download safety gate runs over the whole set and
         * either flushes all of them or refuses the entire sync. */
        const pending = [];

        const snapB = new Uint8Array(bcm.bytes);
        const snapR = new Uint8Array(rfh.bytes);
        const snapP = pcm.bytes ? new Uint8Array(pcm.bytes) : null;
        setOriginals({
          bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' },
          rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' },
          pcm: snapP ? { bytes: snapP, filename: pcm.file?.name || 'PCM' } : null,
        });

        /* BCM VIN */
        const br = engWriteBcmVin(bcm.bytes, newVin);
        addBcmRows(bcm.parsed, newVin, newCrc);
        log(`BCM VIN: ${br.fullPatched} full + ${br.shortPatched} tail slot(s) patched`, 'ok');
        let bcmFinal = br.bytes;

        /* BCM SEC16 (Gen2 only) */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (sec16SyncOk && rfhSec16 && rfhSec16.length === 16) {
          const sr = engWriteBcmSec16Gen2(bcmFinal, rfhSec16);
          bcmFinal = sr.bytes;
          log(`BCM SEC16: ${sr.splitPatched} split record(s) + ${sr.mirrorPatched} mirror(s) written (SINCRO-verified)`, 'ok');
          log(`  BCM SEC16 (reversed): ${sr.bcmSec16Hex.toUpperCase()}`, 'muted');
        } else if (bcmHasSec16) {
          log('BCM SEC16: skipped (RFH not Gen2 or SEC16 virgin)', 'muted');
        }
        /* Task #385: auto-chain the legacy flat 0x40C9 repair when the live
         * SEC16 records were just rewritten — otherwise pre-Redeye CGDI/Autel
         * tools would still see the old secret in the flat slice. */
        let bcmModeTag = '';
        if (sec16SyncOk && rfhSec16 && rfhSec16.length === 16) {
          const fr = chainBcmFlatRepairIfStale(bcmFinal, { mode: flatRepairMode });
          if (fr.repaired) {
            bcmFinal = fr.bytes;
            bcmModeTag = flatRepairMode === 'legacy-flat' ? '_LEGACYFLAT' : '_CANONICAL';
            log(`✓ Auto-chained: flat 0x40C9 repaired from resolved SEC16 (source: ${fr.source}, mode: ${flatRepairMode}) — legacy CGDI/Autel readers will now see the live secret`, 'ok');
            log(`  Old flat (LE): ${fr.oldFlatHex} → New flat (LE): ${fr.leHex}`, 'muted');
            if (fr.mirror1Overlap) {
              log(`  ⚠ Mirror1 overlap detected — legacy-flat mode clobbered mirror1 payload at 0x${(fr.mirror1ClobberedAt || 0x40C0).toString(16).toUpperCase()}; split records remain canonical so SRT Lab still resolves the live secret`, 'warn');
            }
            rows.push({
              module: 'BCM', slot: '·', offset: '0x40C9',
              oldVin: fr.oldFlatHex, newVin: fr.leHex,
              checkLabel: 'src',
              oldCheck: 'flat (legacy)', newCheck: `auto · ${fr.source} · ${flatRepairMode}`,
              oldPass: null, newPass: true,
            });
          } else if (fr.reason === 'overlap-canonical-skip') {
            /* Task #794 — mirror1 sits at 0x40C0 on this dump. Canonical
             * mode refuses to clobber it, so the synced BCM still carries
             * the stale flat slice — the exact incompatibility the task
             * is meant to fix. Surface the explicit override path. */
            bcmModeTag = '_CANONICAL';
            log(`⚠ Flat 0x40C9 NOT repaired: mirror1 overlaps the flat slice on this dump and canonical mode is preserving it. Legacy tools (CGDI / AlfaOBD / SINCRO) reading the flat slice will still see the OLD secret in this BCM_SYNCED file.`, 'warn');
            log(`  To produce a legacy-tool-compatible copy, switch the "Compatibility mode" selector to "Legacy-flat compatibility" and run BCM-only Flat 0x40C9 Repair, then download that file alongside this one.`, 'muted');
          } else if (fr.reason === 'already-in-sync') {
            log('  Flat 0x40C9 auto-repair: already in sync with resolved SEC16 — no change needed', 'muted');
          } else if (fr.reason === 'flat-only') {
            log('  Flat 0x40C9 auto-repair skipped: only the legacy flat slice is populated (no live split/mirror records to copy from)', 'muted');
          } else if (fr.reason === 'unresolved-or-blank') {
            log('  Flat 0x40C9 auto-repair skipped: post-write SEC16 is blank or unresolvable', 'muted');
          }
        }
        const bcmSyncName = `BCM_SYNCED${bcmModeTag}_${newVin}_${ts}.bin`;
        pending.push({ role: 'BCM', bytes: bcmFinal, name: bcmSyncName });

        /* RFH VIN */
        const rr = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, rr.chk);
        log(`RFHUB VIN: ${rr.patched} slot(s) patched${virginize ? ` + ${rr.sec16Wiped} SEC16 slot(s) wiped` : ''}`, virginize ? 'warn' : 'ok');
        pending.push({ role: 'RFH', bytes: rr.bytes, name: `RFH_SYNCED${virginize ? '_VIRGIN' : ''}_${newVin}_${ts}.bin` });

        /* PCM VIN + SEC6 */
        if (pcm.bytes && pcm.parsed) {
          let pcmFinal = engWritePcmVin(pcm.bytes, newVin).bytes;
          const pr = { patched: pcm.parsed.vinSlots.length };
          addPcmRows(pcm.parsed, newVin);
          log(`PCM VIN: ${pr.patched} slot(s) patched`, 'ok');
          let pcmSec6Ok = true;
          /* Task #433 — single shared preflight covering all reasons the
           * SEC6 write can be gated out (no RFH, Gen1 RFH, virgin SEC16,
           * non-canonical PCM size). Mirrors the BCM SEC16 skip line above. */
          const sec6Skip = pcmSec6SkipReason({ rfh, pcm: { bytes: pcmFinal, parsed: pcm.parsed } });
          if (!sec6Skip) {
            const sr = engWritePcmSec6(pcmFinal, rfhSec16);
            if (sr.ok) {
              pcmFinal = sr.bytes;
              log(`PCM SEC6: ${sr.patched} location(s) written · ${sr.sec6Hex.toUpperCase()} (marker ${sr.markerUsed})`, 'ok');
            } else {
              /* Task #399 — preflight passed but writer still couldn't find
               * a writable site (corrupt canonical region). Refuse the
               * download instead of silently shipping the unchanged file. */
              pcmSec6Ok = false;
              log(`✗ PCM SEC6 SYNC FAILED — no writable site found (size=${pcmFinal.length} B, SEC6=${sr.sec6Hex.toUpperCase()}). PCM file NOT downloaded. Re-dump the PCM at the canonical 4 KB / 8 KB size and retry.`, 'err');
            }
          } else {
            log(`PCM SEC6 skipped: ${sec6Skip}`, 'muted');
          }
          // Task #475: pad / slice the SYNC output to match the user-
          // picked target chip so the on-disk byte count matches the
          // bench. Default target tracks the donor chip (set by the
          // useEffect on PCM load), but the tech can override via the
          // target-chip selector — the doSync wrapper has already shown
          // a confirm dialog before we reach this point. Filename gets a
          // _4KB / _8KB suffix from the same helper so the on-disk name
          // always describes the actual byte length.
          {
            const beforeLen = pcmFinal.length;
            const resized = resizePcmForTargetChip(pcmFinal, effectiveTargetChipKey);
            pcmFinal = resized.bytes;
            if (beforeLen !== pcmFinal.length) {
              const op = pcmFinal.length < beforeLen ? 'sliced' : '0xFF-padded';
              log(`PCM ${op} ${beforeLen.toLocaleString()} B → ${pcmFinal.length.toLocaleString()} B (matches ${targetChipDescriptor?.label || effectiveTargetChipKey} bench chip)`, 'warn');
            }
          }
          const pcmChipSuffix = (() => {
            if (pcmFinal.length === 4096) return '_4KB';
            if (pcmFinal.length === 8192) return '_8KB';
            return '';
          })();
          if (pcmSec6Ok) {
            const pcmName = `PCM_SYNCED${pcmChipSuffix}_${newVin}_${ts}.bin`;
            pending.push({ role: 'PCM', bytes: pcmFinal, name: pcmName });
          } else {
            log('PCM file withheld: SEC6 could not be written; flashing this file would leave the car with an unpaired PCM.', 'err');
          }
        }

        /* Task #1023 — pre-download safety gate. Reparse every accumulated file
         * and run checksum + crossValidate before anything touches disk. A
         * virginize run deliberately blanks the RFH secret, so it is gated
         * per-file (checksum self-check) rather than cross-secret; a normal
         * sync is gated across all modules so a BCM/RFH/PCM whose VINs or
         * SEC16/SEC6 secrets disagree is REFUSED instead of shipped _SYNCED. */
        if (pending.length) {
          const verdict = checkExportSafety({ outgoing: pending, crossModule: !virginize });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — no files were written. The modules are not safe to flash as a set.', 'err');
            return;
          }
          for (const f of pending) {
            downloadBin(f.bytes, f.name);
            log(`Downloaded: ${f.name}`, 'ok');
          }
          log(`✓ Pre-download safety gate PASSED — ${pending.length} file(s) verified consistent before write.`, 'ok');
        }

      } else if (action === 'sec16-only') {
        /* SEC16 sync only — BCM SEC16 ← RFH, PCM SEC6 ← RFH */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) {
          /* Task #433 — also surface the per-writer skip lines so the user
           * sees both gates failing, not just a single generic error. */
          log('✗ No RFH SEC16 available', 'err');
          log(`PCM SEC6 skipped: ${pcmSec6SkipReason({ rfh, pcm }) || 'RFH SEC16 not readable'}`, 'muted');
          return;
        }
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const sr = engWriteBcmSec16Gen2(bcm.bytes, rfhSec16);
        log(`BCM SEC16 sync: ${sr.splitPatched} split record(s) + ${sr.mirrorPatched} mirror(s) written`, 'ok');
        log(`  Inactive bank: 0x${hex4(sr.inactiveBase)} · BCM SEC16: ${sr.bcmSec16Hex.toUpperCase()}`, 'muted');
        /* Task #385: auto-chain the legacy flat 0x40C9 repair so pre-Redeye
         * tools that still read the flat field stop seeing the old secret. */
        let bcmSec16Out = sr.bytes;
        let sec16ModeTag = '';
        const fr = chainBcmFlatRepairIfStale(bcmSec16Out, { mode: flatRepairMode });
        if (fr.repaired) {
          bcmSec16Out = fr.bytes;
          sec16ModeTag = flatRepairMode === 'legacy-flat' ? '_LEGACYFLAT' : '_CANONICAL';
          log(`✓ Auto-chained: flat 0x40C9 repaired from resolved SEC16 (source: ${fr.source}, mode: ${flatRepairMode}) — legacy CGDI/Autel readers will now see the live secret`, 'ok');
          log(`  Old flat (LE): ${fr.oldFlatHex} → New flat (LE): ${fr.leHex}`, 'muted');
          if (fr.mirror1Overlap) {
            log(`  ⚠ Mirror1 overlap detected — legacy-flat mode clobbered mirror1 payload at 0x${(fr.mirror1ClobberedAt || 0x40C0).toString(16).toUpperCase()}; split records remain canonical so SRT Lab still resolves the live secret`, 'warn');
          }
          rows.push({
            module: 'BCM', slot: '·', offset: '0x40C9',
            oldVin: fr.oldFlatHex, newVin: fr.leHex,
            checkLabel: 'src',
            oldCheck: 'flat (legacy)', newCheck: `auto · ${fr.source} · ${flatRepairMode}`,
            oldPass: null, newPass: true,
          });
        } else if (fr.reason === 'overlap-canonical-skip') {
          /* Task #794 — same incompatibility surface as the sync-all path. */
          sec16ModeTag = '_CANONICAL';
          log(`⚠ Flat 0x40C9 NOT repaired: mirror1 overlaps the flat slice on this dump and canonical mode is preserving it. Legacy tools (CGDI / AlfaOBD / SINCRO) reading the flat slice will still see the OLD secret in this BCM_SEC16_SYNCED file.`, 'warn');
          log(`  Switch the "Compatibility mode" selector to "Legacy-flat compatibility" and re-run to produce a copy legacy tools will accept.`, 'muted');
        } else if (fr.reason === 'already-in-sync') {
          log('  Flat 0x40C9 auto-repair: already in sync with resolved SEC16 — no change needed', 'muted');
        } else if (fr.reason === 'flat-only') {
          log('  Flat 0x40C9 auto-repair skipped: only the legacy flat slice is populated (no live split/mirror records to copy from)', 'muted');
        } else if (fr.reason === 'unresolved-or-blank') {
          log('  Flat 0x40C9 auto-repair skipped: post-write SEC16 is blank or unresolvable', 'muted');
        }
        const sec16OutName = `BCM_SEC16_SYNCED${sec16ModeTag}_${ts}.bin`;
        /* Task #1023 — accumulate outgoing files; gate before writing. */
        const pending = [{ role: 'BCM', bytes: bcmSec16Out, name: sec16OutName }];
        /* Task #433 — single shared preflight, same reason set as full sync. */
        const sec6Skip = pcmSec6SkipReason({ rfh, pcm });
        if (!sec6Skip) {
          const snapP = new Uint8Array(pcm.bytes);
          setOriginals(prev => ({ ...prev, pcm: { bytes: snapP, filename: pcm.file?.name || 'PCM' } }));
          const pr = engWritePcmSec6(pcm.bytes, rfhSec16);
          if (pr.ok) {
            log(`PCM SEC6: ${pr.patched} location(s) written · marker ${pr.markerUsed}`, 'ok');
            /* Task #475 — pad / slice the SEC6-only PCM output to the
             * target chip and stamp the byte-accurate _4KB / _8KB suffix
             * onto the filename so CGDI accepts it on a 95320 / 95640
             * bench. Toast also includes the byte count to match. */
            let pcmOut = pr.bytes;
            const beforeLen = pcmOut.length;
            const resized = resizePcmForTargetChip(pcmOut, effectiveTargetChipKey);
            pcmOut = resized.bytes;
            if (beforeLen !== pcmOut.length) {
              const op = pcmOut.length < beforeLen ? 'sliced' : '0xFF-padded';
              log(`PCM ${op} ${beforeLen.toLocaleString()} B → ${pcmOut.length.toLocaleString()} B (matches ${targetChipDescriptor?.label || effectiveTargetChipKey} bench chip)`, 'warn');
            }
            const pcmChipSuffix = pcmOut.length === 4096 ? '_4KB' : pcmOut.length === 8192 ? '_8KB' : '';
            const pcmName = `PCM_SEC6_SYNCED${pcmChipSuffix}_${ts}.bin`;
            pending.push({ role: 'PCM', bytes: pcmOut, name: pcmName });
          } else {
            /* Task #399 — preflight passed but writer still refused; refuse
             * to ship an unmodified PCM as "synced". */
            log(`✗ PCM SEC6 SYNC FAILED — no writable site found (size=${pcm.bytes.length} B). PCM file NOT downloaded. Re-dump the PCM at the canonical 4 KB / 8 KB size and retry.`, 'err');
          }
        } else {
          log(`PCM SEC6 skipped: ${sec6Skip}`, 'muted');
        }

        /* Task #1023 — gate the SEC16/SEC6 sync outputs against the source RFH
         * (passed as context) so a BCM/PCM whose secret does not match the RFH
         * it was synced from is refused instead of shipped _SYNCED. */
        {
          const verdict = checkExportSafety({
            outgoing: pending,
            context: [{ role: 'RFH', bytes: rfh.bytes, name: rfh.file?.name || 'RFH' }],
          });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('SEC16 sync aborted — no files were written. The BCM/PCM secret does not match the RFH.', 'err');
            return;
          }
          for (const f of pending) {
            downloadBin(f.bytes, f.name);
            log(`Downloaded: ${f.name}`, 'ok');
          }
          log(`✓ Pre-download safety gate PASSED — ${pending.length} file(s) verified against the RFH secret before write.`, 'ok');
        }

      } else if (action === 'rekey-virgin-bcm') {
        /* Re-key a fully-virgin BCM from the RFHUB SEC16 master.
         * Writes reverse(RFHUB SEC16 slot 1) into split records, inactive-bank
         * mirrors, and the legacy flat 0x40C9 slice; normalises fobikCount
         * to the RFHUB's populated-slot count so the key-count warning clears. */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) {
          log('✗ RFHUB SEC16 not available — load a Gen2 RFHUB with populated SEC16 slots', 'err');
          return;
        }
        if (!bcmFullyVirgin) {
          log('✗ BCM is not fully virgin — use "🔐 SEC16 Sync Only" for BCMs that already carry a secret', 'err');
          return;
        }
        const newFobikCount = typeof rfh.parsed?.fobikSlots === 'number' ? rfh.parsed.fobikSlots : null;
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const rk = rekeyVirginBcmFromRfhub(bcm.bytes, rfhSec16, newFobikCount);
        log(`BCM Re-key: ${rk.splitPatched} split record(s) + ${rk.mirrorPatched} mirror(s) written`, 'ok');
        const rfhSec16Hex = Array.from(rfhSec16).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
        log(`  RFHUB SEC16 (slot 1): ${rfhSec16Hex}`, 'muted');
        log(`  BCM SEC16 (reversed): ${rk.bcmSec16Hex.toUpperCase()}`, 'muted');
        if (newFobikCount != null) {
          const oldFobik = bcm.parsed?.fobikCount;
          log(`  FOBIK count: ${oldFobik ?? '?'} → ${newFobikCount} (normalised to RFHUB populated slots)`, 'ok');
        }
        const outVin = bcm.parsed?.vin || rfh.parsed?.vin || 'UNKNOWN';
        const outName = `BCM_REKEYED_${outVin}_${ts}.bin`;
        /* Task #1023 — re-keying a virgin BCM creates the split/mirror SEC16
         * records from scratch off the RFHUB master. Run the freshly-written
         * BCM back through the shared gate cross-module against the RFH so a
         * re-key whose SEC16 does not actually mirror the RFHUB is refused
         * instead of shipped _REKEYED (brick-risk twin of the sync incident). */
        {
          const verdict = checkExportSafety({
            outgoing: [{ role: 'BCM', bytes: rk.bytes, name: outName }],
            context: [{ role: 'RFH', bytes: rfh.bytes, name: rfh.file?.name || 'RFH' }],
          });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Re-key aborted — no file was written. The re-keyed BCM SEC16 does not match the RFHUB master.', 'err');
            return;
          }
          downloadBin(rk.bytes, outName);
          log(`Downloaded: ${outName}`, 'ok');
          log('✓ Pre-download safety gate PASSED — re-keyed BCM verified against the RFHUB master before write.', 'ok');
        }

      } else if (action === 'rekey-95640-from-rfh') {
        /* Re-key 95640 BCM-backup chip from RFHUB master.
           Reverses RFH SEC16 slot1 → 95640 @ 0x838 + CRC16 @ 0x848. */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) { log('✗ No RFHUB SEC16 available — load a Gen2 RFHUB with populated SEC16', 'err'); return null; }
        if (!eep.bytes) { log('✗ 95640 dump not loaded', 'err'); return null; }
        const snapE = new Uint8Array(eep.bytes);
        setOriginals(prev => ({ ...prev, eep: { bytes: snapE, filename: eep.file?.name || '95640' } }));
        const wr = engWriteEep95640FromRfh(eep.bytes, rfhSec16);
        log(`95640 BCM-SEC16 @0x838 ← reverse(RFHUB SEC16): ${wr.sec16Hex}`, 'ok');
        log(`  CRC16 @0x848: 0x${hex4(wr.crc16)} (big-endian)`, 'muted');
        rows.push({
          module: '95640', slot: 1, offset: '0x0838',
          oldVin: eep.parsed?.bcmSec16Blank ? '— BLANK —' : (eep.parsed?.bcmSec16Hex || '—'),
          newVin: wr.sec16Hex,
          checkLabel: 'CRC-16',
          oldCheck: eep.parsed?.bcmSec16StoredCrc != null ? `0x${hex4(eep.parsed.bcmSec16StoredCrc)}` : '—',
          newCheck: `0x${hex4(wr.crc16)}`,
          oldPass: eep.parsed?.bcmSec16CrcOk ?? null,
          newPass: true,
        });
        /* Task #1023 — verify the freshly-written 95640 before download.
         * crossValidate does not model the 95640↔RFH relationship, so the
         * shared gate runs scoped to the (untouched) VIN slots while the
         * meaningful SEC16 self-check is done explicitly: reparse the written
         * bytes and confirm the stored CRC16 verifies AND the SEC16 equals
         * reverse(RFHUB master). Either failure refuses the download. */
        {
          const outName95 = `EEP95640_REKEYED_${ts}.bin`;
          const reparsed95 = engParseEep95640(wr.bytes, outName95);
          const writtenSec16 = (wr.sec16Hex || '').toUpperCase();
          const sec16Ok95 = !!reparsed95.bcmSec16CrcOk && reparsed95.bcmSec16Hex === writtenSec16;
          const verdict = checkExportSafety({
            outgoing: [{ role: '95640', bytes: wr.bytes, name: outName95 }],
            context: [{ role: 'RFH', bytes: rfh.bytes, name: rfh.file?.name || 'RFH' }],
            crossModule: false,
            selfChecks: ['vin'],
          });
          if (!verdict.ok || !sec16Ok95) {
            if (!verdict.ok) for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            if (!sec16Ok95) log(`✗ 95640 SEC16 self-check failed — written CRC16 ${reparsed95.bcmSec16CrcOk ? 'OK' : 'BAD'}, SEC16 ${reparsed95.bcmSec16Hex === writtenSec16 ? 'matches' : 'does NOT match'} reverse(RFHUB master).`, 'err');
            log('Re-key aborted — no file was written. The re-keyed 95640 did not pass the safety gate.', 'err');
            return null;
          }
          downloadBin(wr.bytes, outName95);
          log(`Downloaded: ${outName95}`, 'ok');
          log('✓ Pre-download safety gate PASSED — 95640 SEC16 + CRC16 verified against the RFHUB master before write.', 'ok');
        }

      } else if (action === 'bcm-flat-from-resolved') {
        /* Repair the legacy flat 0x40C9 slice from the resolved (split/mirror)
         * SEC16 so third-party tools (CGDI, Autel, etc.) that still read the
         * pre-Redeye flat field stop seeing residual garbage. Live FEE
         * records (split @0x81A0/C0/E0 + inactive-bank mirrors) are left
         * untouched. Gated on resolver.source !== 'flat' && !blank — the
         * button itself is hidden otherwise, but we re-check defensively. */
        const rs = resolveBcmSec16(bcm.bytes);
        if (!rs || !rs.bytes || rs.blank) {
          log('✗ BCM SEC16 is blank — nothing to copy into the legacy slice', 'err');
          return null;
        }
        if (rs.source === 'flat') {
          log('✗ Resolver picked the flat slice itself — split/mirror records are absent or virgin, refusing to copy garbage onto itself', 'err');
          return null;
        }
        const oldFlat = Array.from(bcm.bytes.slice(0x40C9, 0x40D9))
          .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const wr = writeBcmFlatSec16(bcm.bytes, rs.bytes, { mode: flatRepairMode });
        const modeLabel = wr.mode === 'legacy-flat' ? 'LEGACY-FLAT' : 'CANONICAL';
        void logSec16Sync({
          vin: bcm.vin || null,
          platform: bcm.vin ? classifyPlatform({ vin: bcm.vin }).platform : null,
          actionId: 'flat-40c9-repair',
          target: 'BCM',
          verified: 'offline',
          notes: `resolver source: ${rs.source} @0x${hex4(rs.offset)} · mode: ${wr.mode}`,
          detail: { oldFlatHex: oldFlat, newFlatHex: wr.leHex.toUpperCase(), sec16Hex: wr.sec16Hex.toUpperCase(), mode: wr.mode, mirror1Overlap: !!wr.mirror1Overlap },
        });
        if (wr.skipped) {
          log(`BCM flat 0x40C9 repair SKIPPED — ${wr.skipReason}. Mirror1 record at 0x40C0 preserved (canonical mode).`, 'warn');
          log(`  Legacy CGDI / AlfaOBD / SINCRO tools will still see the canonical bytes reversed and may report IMMO_DAMAGED.`, 'warn');
          log(`  Switch to "Legacy-flat compatibility" mode on the BCM repair card and re-run to force the LE write (mirror1 record will become inconsistent in the downloaded file, but the split records — the master source — stay valid).`, 'muted');
          rows.push({
            module: 'BCM', slot: 1, offset: '0x40C9',
            oldVin: oldFlat, newVin: oldFlat,
            checkLabel: 'mode',
            oldCheck: 'overlap', newCheck: `${modeLabel} · skipped`,
            oldPass: null, newPass: null,
          });
          return rows;
        }
        log(`BCM flat 0x40C9 repaired (${modeLabel}) from resolver source '${rs.source}' @0x${hex4(rs.offset)}`, 'ok');
        log(`  Resolved SEC16 (BE): ${wr.sec16Hex.toUpperCase()}`, 'muted');
        log(`  Written @0x40C9 (LE): ${wr.leHex.toUpperCase()}`, 'muted');
        if (wr.mirror1Overlap && wr.mode === 'legacy-flat') {
          log(`  ⚠ Mirror1 record at 0x40C0 was clobbered by the LE write (overlap mode). Split records (0x81A0/C0/E0) and mirror2 (slot 0xCA) remain canonical — SRT Lab will still parse the correct SEC16 from the split records.`, 'warn');
        }
        const suffix = wr.mode === 'legacy-flat' ? '_LEGACYFLAT' : '_CANONICAL';
        rows.push({
          module: 'BCM', slot: 1, offset: '0x40C9',
          oldVin: oldFlat, newVin: wr.leHex.toUpperCase(),
          checkLabel: 'mode',
          oldCheck: 'flat (legacy)', newCheck: `${rs.source} · ${modeLabel}`,
          oldPass: null, newPass: true,
        });
        /* Task #1023 — gate the _CANONICAL / _LEGACYFLAT copy before download.
         * Canonical leaves the split + mirror records intact so the full SEC16
         * self-check must pass. Legacy-flat deliberately clobbers mirror1 on
         * overlap dumps (the master split records stay valid), so its SEC16
         * mirror is intentionally inconsistent — scope that copy to VIN slots
         * only to avoid a false refusal while still catching VIN corruption. */
        {
          const flatVerdict = checkExportSafety({
            outgoing: [{ role: 'BCM', bytes: wr.bytes, name: `BCM_FLAT40C9_REPAIRED${suffix}_${ts}.bin` }],
            crossModule: false,
            selfChecks: wr.mode === 'legacy-flat' ? ['vin', 'partials'] : ['vin', 'partials', 'sec16'],
          });
          if (!flatVerdict.ok) {
            for (const line of formatBlockingMessage(flatVerdict).split('\n')) log(line, 'err');
            log('Flat 0x40C9 repair aborted — no file was written. The repaired BCM failed the safety gate.', 'err');
            return rows;
          }
        }
        downloadBin(wr.bytes, `BCM_FLAT40C9_REPAIRED${suffix}_${ts}.bin`);
        log(`Downloaded: BCM_FLAT40C9_REPAIRED${suffix}_${ts}.bin`, 'ok');
        if (wr.mode === 'legacy-flat') {
          log('Legacy CGDI / Autel / AlfaOBD / SINCRO can now verify this dump. Keep your canonical copy in the vault — only hand this _LEGACYFLAT copy to legacy bench tools.', 'ok');
        } else {
          log('Legacy CGDI/Autel-style readers will now see the same SEC16 as the live split records.', 'ok');
        }

      } else if (action === 'bcm-flat-from-resolved-both') {
        /* Task #800 — one-click double emission. On overlap dumps the
         * canonical and legacy-flat modes produce different bytes (canonical
         * skips the LE write to preserve mirror1; legacy-flat forces it).
         * The bench tech needs both copies: the canonical for modern tools
         * + SRT Lab, and the LEGACYFLAT for CGDI / Autel / AlfaOBD /
         * SINCRO. This branch runs both writers in a single click and
         * downloads two files, labeling each in the session log.
         *
         * The UI gates the button on overlap-detected (otherwise both
         * outputs are byte-identical and the second file adds no value).
         * If this branch is invoked programmatically without overlap we
         * still emit both files for symmetry and flag in the session log
         * that the two downloads are byte-identical so the tech knows
         * they can keep just one. */
        const rs = resolveBcmSec16(bcm.bytes);
        if (!rs || !rs.bytes || rs.blank) {
          log('✗ BCM SEC16 is blank — nothing to copy into the legacy slice', 'err');
          return null;
        }
        if (rs.source === 'flat') {
          log('✗ Resolver picked the flat slice itself — split/mirror records are absent or virgin, refusing to copy garbage onto itself', 'err');
          return null;
        }
        const oldFlat = Array.from(bcm.bytes.slice(0x40C9, 0x40D9))
          .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));

        const wrCanon = writeBcmFlatSec16(bcm.bytes, rs.bytes, { mode: 'canonical' });
        const wrLegacy = writeBcmFlatSec16(bcm.bytes, rs.bytes, { mode: 'legacy-flat' });
        const overlap = !!(wrCanon.mirror1Overlap || wrLegacy.mirror1Overlap);

        log(`BCM flat 0x40C9 double-emit from resolver source '${rs.source}' @0x${hex4(rs.offset)}${overlap ? ' (overlap detected — two distinct files)' : ' (no overlap — both files identical)'}`, 'ok');
        log(`  Resolved SEC16 (BE): ${wrCanon.sec16Hex.toUpperCase()}`, 'muted');

        /* Copy #1 — CANONICAL: for modern tools + SRT Lab. */
        void logSec16Sync({
          vin: bcm.vin || null,
          platform: bcm.vin ? classifyPlatform({ vin: bcm.vin }).platform : null,
          actionId: 'flat-40c9-repair-both',
          target: 'BCM',
          verified: 'offline',
          notes: `double-emit · canonical copy · resolver: ${rs.source} @0x${hex4(rs.offset)} · overlap: ${overlap ? 'yes' : 'no'}`,
          detail: { oldFlatHex: oldFlat, newFlatHex: wrCanon.leHex.toUpperCase(), sec16Hex: wrCanon.sec16Hex.toUpperCase(), mode: 'canonical', mirror1Overlap: !!wrCanon.mirror1Overlap, skipped: !!wrCanon.skipped },
        });
        if (wrCanon.skipped) {
          log(`  • CANONICAL copy: flat 0x40C9 write skipped to preserve mirror1 at 0x40C0 (overlap dump). For modern tools + SRT Lab — these read the mirror as BE.`, 'muted');
        } else {
          log(`  • CANONICAL copy: flat 0x40C9 (LE) = ${wrCanon.leHex.toUpperCase()}. For modern tools + SRT Lab.`, 'muted');
        }
        /* Task #1023 — gate the CANONICAL copy (full SEC16 self-check; the
         * split + mirror records stay intact in this mode). Refuse BOTH
         * downloads if the canonical copy fails — it is the one vaulted as the
         * source of truth, so a bad canonical aborts the whole double-emit. */
        {
          const canonVerdict = checkExportSafety({
            outgoing: [{ role: 'BCM', bytes: wrCanon.bytes, name: `BCM_FLAT40C9_REPAIRED_CANONICAL_${ts}.bin` }],
            crossModule: false,
            selfChecks: ['vin', 'partials', 'sec16'],
          });
          if (!canonVerdict.ok) {
            for (const line of formatBlockingMessage(canonVerdict).split('\n')) log(line, 'err');
            log('Double-emit aborted — no files were written. The CANONICAL copy failed the safety gate.', 'err');
            return rows;
          }
        }
        downloadBin(wrCanon.bytes, `BCM_FLAT40C9_REPAIRED_CANONICAL_${ts}.bin`);
        log(`Downloaded: BCM_FLAT40C9_REPAIRED_CANONICAL_${ts}.bin`, 'ok');

        /* Copy #2 — LEGACYFLAT: for CGDI / Autel / AlfaOBD / SINCRO. */
        void logSec16Sync({
          vin: bcm.vin || null,
          platform: bcm.vin ? classifyPlatform({ vin: bcm.vin }).platform : null,
          actionId: 'flat-40c9-repair-both',
          target: 'BCM',
          verified: 'offline',
          notes: `double-emit · legacy-flat copy · resolver: ${rs.source} @0x${hex4(rs.offset)} · overlap: ${overlap ? 'yes' : 'no'}`,
          detail: { oldFlatHex: oldFlat, newFlatHex: wrLegacy.leHex.toUpperCase(), sec16Hex: wrLegacy.sec16Hex.toUpperCase(), mode: 'legacy-flat', mirror1Overlap: !!wrLegacy.mirror1Overlap, mirror1ClobberedAt: wrLegacy.mirror1ClobberedAt ?? null },
        });
        log(`  • LEGACYFLAT copy: flat 0x40C9 (LE) = ${wrLegacy.leHex.toUpperCase()}. For legacy CGDI / Autel / AlfaOBD / SINCRO that read the flat slice as LE.`, 'muted');
        if (wrLegacy.mirror1Overlap) {
          log(`    ⚠ Mirror1 record at 0x40C0 was clobbered by the LE write in this copy. Split records (0x81A0/C0/E0) and mirror2 (slot 0xCA) remain canonical — only hand this copy to legacy bench tools.`, 'warn');
        }
        /* Task #1023 — gate the LEGACYFLAT copy scoped to VIN slots only:
         * legacy-flat intentionally clobbers mirror1 on overlap dumps (master
         * split records stay valid), so a full SEC16 self-check would falsely
         * refuse a legitimate copy. VIN-slot integrity must still hold. */
        {
          const legacyVerdict = checkExportSafety({
            outgoing: [{ role: 'BCM', bytes: wrLegacy.bytes, name: `BCM_FLAT40C9_REPAIRED_LEGACYFLAT_${ts}.bin` }],
            crossModule: false,
            selfChecks: ['vin', 'partials'],
          });
          if (!legacyVerdict.ok) {
            for (const line of formatBlockingMessage(legacyVerdict).split('\n')) log(line, 'err');
            log('Double-emit halted — the CANONICAL copy was written, but the LEGACYFLAT copy failed the safety gate and was NOT written.', 'err');
            return rows;
          }
        }
        downloadBin(wrLegacy.bytes, `BCM_FLAT40C9_REPAIRED_LEGACYFLAT_${ts}.bin`);
        log(`Downloaded: BCM_FLAT40C9_REPAIRED_LEGACYFLAT_${ts}.bin`, 'ok');

        rows.push({
          module: 'BCM', slot: 1, offset: '0x40C9',
          oldVin: oldFlat,
          newVin: `${wrCanon.skipped ? oldFlat : wrCanon.leHex.toUpperCase()} | ${wrLegacy.leHex.toUpperCase()}`,
          checkLabel: 'mode',
          oldCheck: 'flat (legacy)',
          newCheck: `both · canonical${wrCanon.skipped ? ' (skipped)' : ''} + legacy-flat`,
          oldPass: null, newPass: true,
        });

        if (!overlap) {
          log('No overlap was detected on this dump — the two downloaded files are byte-identical. Keep one; the second is for parity with overlap dumps.', 'muted');
        } else {
          log('Vault the CANONICAL copy. Hand the LEGACYFLAT copy only to legacy bench tools.', 'ok');
        }

      } else if (action === 'bcm-sec16-to-rfh') {
        /* BCM SEC16 → RFHUB slots — use when RFHUB is from a different vehicle.
           BCM is master: reverse(BCM SEC16) is written to RFHUB slots.
           Gen2 Yazaki: slots 0x050E + 0x0522 (crc8_65 checksum).
           XC2268 (2019+ Ram 64 KB): slots 0x1100 + 0x1120 (CRC-16/CCITT + image CRC32). */
        /* Delegated to the engine's resolver (parseModule.resolveBcmSec16),
         * proven byte-equivalent to the old engParseBcm split/mirror/legacy
         * resolution across all BCM families (verify-bcm-resolve: ALL AGREE,
         * incl. the 2014 0x00C8/0x00F0 legacy mirror). One resolver, no drift. */
        const _bcmRes = resolveBcmSec16(bcm.bytes);
        const bcmSec16 = (_bcmRes && _bcmRes.bytes && !_bcmRes.blank) ? _bcmRes.bytes : null;
        if (!bcmSec16) { log('✗ No BCM SEC16 found in split records or mirrors', 'err'); return; }
        const snapR = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
        const rfhIsXc2268 = isXc2268Rfhub(rfh.bytes);
        const rfhFmt = rfh.parsed?.format || 'gen2';
        /* Ultimate-machine gate: the XC2268 SEC16 writer is UNVERIFIED (its
         * offset map incl. the image checksum was reconstructed from a
         * screenshot — see algoProvenance.js). Stamping an unverified secret
         * into a real 2019+ Ram RFHUB can brick it, so require an explicit,
         * informed acknowledgement before this write — same standard as the
         * marryModule engine. (Gen2 Yazaki path is bench-verified, no gate.) */
        if (rfhIsXc2268) {
          const g = writerGrounding('writeXc2268Sec16');
          if (g.level !== GROUNDING.BENCH && !(typeof window !== 'undefined' && window.confirm(
            'XC2268 RFHUB SEC16 writer is UNVERIFIED — ' + g.caveat + '.\n\n'
            + 'Writing an unverified secret to a real module can BRICK it. '
            + 'Proceed only if you have confirmed this layout on THIS module.\n\nWrite XC2268 SEC16?'))) {
            log('✗ XC2268 SEC16 write cancelled — unverified writer not acknowledged', 'err');
            return;
          }
        }
        const sr = rfhIsXc2268
          ? writeXc2268Sec16(rfh.bytes, bcmSec16)
          : engWriteRfhSec16FromBcm(rfh.bytes, bcmSec16, rfhFmt);
        log(`RFHUB SEC16 sync (BCM → RFH${rfhIsXc2268 ? ' XC2268' : rfhFmt === 'gen1' ? ' Gen1' : rfhFmt === 'gen2-hybrid' ? ' Gen2-Hybrid' : ' Gen2'}): ${sr.patched} slot(s) written`, 'ok');
        log(`  RFHUB new SEC16: ${sr.rfhSec16Hex.toUpperCase()}${rfhIsXc2268 ? '' : ` · slot chk: 0x${sr.chk.toString(16).padStart(2,'0').toUpperCase()}`}`, 'muted');
        {
          const wg = writerGrounding(rfhIsXc2268 ? 'writeXc2268Sec16' : 'writeRfhSec16FromBcm');
          log(`  writer confidence: ${wg.level}${wg.caveat ? ' — ' + wg.caveat : ''}`, wg.level === GROUNDING.BENCH ? 'muted' : 'err');
        }
        const rfhFinal = sr.bytes;
        const ts2 = timestamp();
        /* Task #1023 — symmetric twin of the original brick scenario: a secret
         * write that ships an RFH labeled _SYNCED which is supposed to share the
         * BCM's secret. Gate the outgoing RFH cross-module against the BCM
         * (master) context so an RFH whose freshly-written SEC16 still does not
         * match the BCM is refused instead of shipped _SYNCED. */
        {
          const verdict = checkExportSafety({
            outgoing: [{ role: 'RFH', bytes: rfhFinal, name: `RFHUB_BCM_SEC16_SYNCED_${ts2}.bin` }],
            context: [{ role: 'BCM', bytes: bcm.bytes }],
          });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — no file was written. The RFHUB SEC16 does not match the BCM master.', 'err');
            return;
          }
          downloadBin(rfhFinal, `RFHUB_BCM_SEC16_SYNCED_${ts2}.bin`);
          log(`Downloaded: RFHUB_BCM_SEC16_SYNCED_${ts2}.bin`, 'ok');
          log(`✓ Pre-download safety gate PASSED — RFHUB SEC16 verified to match the BCM master before write.`, 'ok');
          log('Flash corrected RFHUB + power-cycle 30 s — BCM, RFHUB and PCM will now share the same secret.', 'ok');
        }
      } else if (action === 'bcm-vin-sec16-to-rfh') {
        /* Combined BCM VIN + SEC16 → RFHUB — for virgin or replacement RFHUB chips.
         * Step 1: Write BCM VIN (byte-reversed) into all 4 RFHUB Gen2 VIN slots.
         * Step 2: Write reverse(BCM SEC16) into RFHUB Gen2 SEC16 slots (0x050E + 0x0522).
         * Produces a single fully-programmed RFHUB file ready to flash. */
        const newVin = ov || bcm.parsed.vin;
        if (!VIN_RE.test(newVin)) { log('✗ BCM VIN is invalid — cannot patch RFHUB', 'err'); return; }
        const bcmSec16 = bcm.parsed?.sec16Records?.[0]?.sec16
                      ?? bcm.parsed?.sec16Mirrors?.find(m => m.populated && m.crcOk)?.sec16;
        if (!bcmSec16) { log('✗ No BCM SEC16 found in split records or mirrors', 'err'); return; }
        const snapR = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
        /* Step 1 — VIN */
        const vr = engWriteRfhVin(rfh.bytes, newVin, false);
        log(`RFHUB: VIN patched at ${vr.patched} slot(s) — ${newVin}`, 'ok');
        addRfhRows(rfh.parsed, newVin, vr.chk);
        /* Step 2 — SEC16 (write into VIN-patched buffer) */
        const rfhIsXc2268 = isXc2268Rfhub(vr.bytes);
        const rfhFmt2 = rfh.parsed?.format || 'gen2';
        const sr = rfhIsXc2268
          ? writeXc2268Sec16(vr.bytes, bcmSec16)
          : engWriteRfhSec16FromBcm(vr.bytes, bcmSec16, rfhFmt2);
        log(`RFHUB: SEC16 synced (BCM → RFH${rfhIsXc2268 ? ' XC2268' : rfhFmt2 === 'gen1' ? ' Gen1' : rfhFmt2 === 'gen2-hybrid' ? ' Gen2-Hybrid' : ' Gen2'}) — ${sr.rfhSec16Hex.toUpperCase()}`, 'ok');
        const rfhFinal = sr.bytes;
        const ts2 = timestamp();
        const outName = `RFHUB_BCM_VIN_SEC16_${newVin}_${ts2}.bin`;
        /* Safety gate: verify outgoing RFHUB SEC16 matches BCM master */
        {
          const verdict = checkExportSafety({
            outgoing: [{ role: 'RFH', bytes: rfhFinal, name: outName }],
            context: [{ role: 'BCM', bytes: bcm.bytes }],
          });
          if (!verdict.ok) {
            for (const line of formatBlockingMessage(verdict).split('\n')) log(line, 'err');
            log('Sync aborted — RFHUB SEC16 does not match BCM master after write.', 'err');
            return;
          }
          downloadBin(rfhFinal, outName);
          log(`Downloaded: ${outName}`, 'ok');
          log('✓ Pre-download safety gate PASSED — VIN + SEC16 verified before write.', 'ok');
          log('Flash RFHUB + power-cycle 30 s to complete pairing.', 'ok');
        }
      }

      log('✓ Sync complete. Flash .bin file(s) to modules and power-cycle 30 s for handshake.', 'ok');
      setDiffRows(rows);
      log('ℹ Use the Restore buttons below to recover pre-patch bytes if needed.', 'muted');
      return rows;
    } catch (e) {
      log(`✗ Error: ${e.message}`, 'err');
      return null;
    }
  };

  const doRestore = (kind) => {
    const snap = originals[kind]; if (!snap) return;
    const prefix = kind === 'bcm' ? 'BCM' : kind === 'rfh' ? 'RFH' : kind === 'pcm' ? 'PCM' : 'EEP95640';
    const name   = `${prefix}_ORIGINAL_${timestamp()}.bin`;
    downloadBin(snap.bytes, name);
    log(`⟲ Restored original ${prefix}: downloaded ${name}`, 'ok');
  };

  const Card = ({ children, style = {} }) => (
    <div style={{ background: C.cd, border: `1.5px solid ${C.bd}`, borderRadius: 16, padding: 22, boxShadow: '0 2px 16px rgba(0,0,0,0.04)', marginBottom: 18, ...style }}>{children}</div>
  );
  const H2 = ({ children, badge }) => (
    <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14, color: C.tx, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.sr }} />
      {children}
      {badge != null && (
        <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 600, color: C.tm, padding: '2px 8px', background: C.c2, borderRadius: 6 }}>{badge}</span>
      )}
    </div>
  );

  const rfhForVirginize = rfh.parsed?.format === 'gen2'
    ? 'RFHUB Gen2: wipes 0x050E + 0x0522'
    : 'RFHUB Gen1: wipes 0x0226 + 0x023A';

  return (
    <div style={{ fontFamily: "'Nunito', system-ui, sans-serif", color: C.tx }}>

      {/* Connection Guides — bench-tool quick links per module (Task #464). */}
      <ConnectionGuides />

      {/* ── Always-visible wizard launcher + Clean / Reset ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
        <button
          data-testid="modsync-reset-btn"
          onClick={handleReset}
          title="Clear all loaded modules, the diff table, the originals snapshots, the target VIN field, and the on-screen log. The vehicle family stays selected."
          style={{
            background: C.cd, border: `1px solid ${C.bd}`, borderRadius: 8,
            padding: '8px 14px', color: C.tx, fontWeight: 800, fontSize: 12,
            cursor: 'pointer', letterSpacing: 0.4, fontFamily: "'Nunito'",
          }}>
          🧹 Clean / Reset
        </button>
        <button
          data-testid="open-pairing-repair-btn"
          onClick={() => setPairingRepairOpen(true)}
          title="Full 3-Module Pairing Repair — repair all BCM + RFHUB + ECM SEC16/SEC6 combinations, including all-blank / generate-fresh paths"
          style={{
            background: 'linear-gradient(135deg,#AA00FF 0%,#2979FF 100%)',
            border: 'none', borderRadius: 8, padding: '8px 16px',
            color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
            letterSpacing: 0.5, fontFamily: "'Nunito'",
            boxShadow: '0 2px 8px rgba(41,121,255,0.25)',
          }}>
          🔧 Full Pairing Repair
        </button>
        <button
          data-testid="open-wizard-btn-toolbar"
          onClick={() => setWizardOpen(true)}
          title="Open the guided Mismatch Wizard + AI assistant (works even with no files loaded)"
          style={{
            background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
            border: 'none', borderRadius: 8, padding: '8px 16px',
            color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
            letterSpacing: 0.5, fontFamily: "'Nunito'",
            boxShadow: '0 2px 8px rgba(211,47,47,0.25)',
          }}>
          🔧 Open Wizard
        </button>
      </div>

      {/* ── Step 1: Load BCM + RFH ── */}
      <Card>
        <H2>1) Load files and filter (INSPECT)</H2>
        <div style={{ fontSize: 12, color: C.ts, marginBottom: 14, lineHeight: 1.5 }}>
          Upload BCM and RFH. The system detects VIN/SEC16 and validates checksums.
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <FilePicker
              label="BCM file (.bin)"
              subtitle="Dump BCM (full flash)."
              file={bcm.file}
              onFile={handleBcm}
              accept=".bin,.BIN"
              testid="modsync-bcm-file-input"
            />
            {bcm.bytes && (() => {
              const _sz = bcm.bytes.length;
              const _b = moduleSizeBadge('bcm', _sz);
              return _b ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: 'rgb(90, 90, 90)', whiteSpace: 'nowrap' }}>
                    {_sz.toLocaleString()} B
                  </span>
                  <span
                    data-testid="modsync-bcm-size-badge"
                    data-size-key={_b.dataKey}
                    data-size-canonical={_b.canonical ? '1' : '0'}
                    style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: '#4a6c8c', color: '#fff', fontWeight: 800, letterSpacing: 0.6, whiteSpace: 'nowrap' }}
                  >{_b.label}</span>
                </div>
              ) : null;
            })()}
          </div>
          <FilePicker
            label="RFH File (MC9S12X Gen2) (.bin/.eprom)"
            subtitle="Dump RFH (Gen2: VIN 4 slots + SEC16 2 slots). 2 KB = Gen1 · 4 KB = Gen2 · 8 KB = WK2 Trackhawk double-dump (accepted). Virgin chips (factory 0x30 fill) also accepted."
            file={rfh.file}
            onFile={handleRfh}
            accept=".bin,.BIN,.eprom"
            testid="modsync-rfh-file-input"
          />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            data-testid="modsync-inspect-btn"
            onClick={() => {
              const el = document.getElementById('modsync-inspection-result');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            disabled={!bcm.file && !rfh.file}
            style={{
              background: (bcm.file || rfh.file) ? C.a3 : C.bd,
              border: 'none', borderRadius: 8, padding: '9px 18px',
              color: '#fff', fontWeight: 900, fontSize: 12,
              cursor: (bcm.file || rfh.file) ? 'pointer' : 'not-allowed',
              letterSpacing: 0.5, fontFamily: "'Nunito'",
            }}>
            🔍 Inspect BCM / RFH
          </button>
          <button
            data-testid="modsync-step1-reset-btn"
            onClick={handleReset}
            style={{
              background: C.cd, border: `1px solid ${C.bd}`, borderRadius: 8,
              padding: '8px 14px', color: C.tx, fontWeight: 800, fontSize: 12,
              cursor: 'pointer', letterSpacing: 0.4, fontFamily: "'Nunito'",
            }}>
            🧹 Clean / Reset
          </button>
        </div>
        <div data-testid="modsync-refresh-hint" style={{
          padding: '7px 12px', borderRadius: 8,
          background: C.wn + '14', border: `1px solid ${C.wn}55`,
          color: '#7a4a00', fontSize: 11, fontWeight: 600, lineHeight: 1.5,
        }}>
          💡 If you refresh the page or open it in another tab, the state will be lost. Run Inspect again.
        </div>
      </Card>

      {/* ── Optional Modules (PCM / 95640) ── */}
      <Card>
        <H2 badge={`${[pcm.file, eep.file].filter(Boolean).length} / 2`}>Load &amp; Inspect — Optional</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <DropZone label="PCM (optional)" icon="⚙️" hint="GPEC2A (4 KB or 8 KB) · drag .bin"
                    file={pcm.file} onFile={handlePcm} accent={C.a1}
                    badge={pcm.bytes ? moduleSizeBadge('pcm', pcm.bytes.length) : null}
                    badgeTestid="modsync-pcm-size-badge"
                    repaired={repairedSlots.pcm} />
          <DropZone label="95640 (optional)" icon="📟" hint="BCM-backup EEPROM · 8 / 16 KB · drag .bin"
                    file={eep.file} onFile={handleEep} accent={C.a4}
                    badge={eep.bytes ? moduleSizeBadge('eep', eep.bytes.length) : null}
                    badgeTestid="modsync-eep-size-badge" />
        </div>
        <ProgrammerSizeHelp
          testId="modsync-programmer-size-help"
          variant="accent"
          style={{ marginTop: 14, padding: '10px 12px' }}
          tail={<>Pick the correct target chip in Sync Actions before generating so the saved file matches your bench.</>}
        />
      </Card>

      {/* ── Inspection Result ── */}
      {loaded > 0 && (
        <Card>
          <div id="modsync-inspection-result">
            {/* Header: "Inspection Result:" + inline status badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.sr }} />
                Inspection Result:
              </div>
              <span style={{
                fontSize: 10, padding: '3px 10px', borderRadius: 6, fontWeight: 800, letterSpacing: 0.6,
                background: bothReady ? C.gn : C.bd,
                color: bothReady ? '#fff' : C.ts,
              }}>
                {bothReady ? '✓ Ready to apply' : 'Load BCM + RFH'}
              </span>
            </div>

            {/* Warnings sub-card */}
            {[...wizardWarnings, ...wizardIssues].length > 0 && (
              <div style={{
                marginBottom: 14, padding: '10px 14px', borderRadius: 10,
                background: C.wn + '10', border: `1px solid ${C.wn}44`,
              }}>
                <div style={{ fontWeight: 800, fontSize: 11, color: '#7a4a00', marginBottom: 6, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Warnings
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>
                  {[...wizardWarnings, ...wizardIssues].map((w, i) => (
                    <li key={i} style={{ fontSize: 11, color: '#7a4a00', lineHeight: 1.5, marginBottom: 2 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Vehicle family selector */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ts, marginBottom: 6 }}>
                Vehicle Family — select to verify BCM part number
              </div>
              <select
                data-testid="vehicle-family-select"
                value={vehicleFamily}
                onChange={e => setVehicleFamily(e.target.value)}
                style={{
                  padding: '10px 14px', borderRadius: 10, border: `2px solid ${vehicleFamily ? C.a3 : C.bd}`,
                  background: C.c2, color: C.tx, fontFamily: "'Nunito'", fontSize: 13, fontWeight: 700,
                  cursor: 'pointer', outline: 'none', width: '100%', maxWidth: 480,
                }}
              >
                <option value="">— select vehicle family to verify BCM PN —</option>
                {VEHICLE_FAMILIES.map(f => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>

            {/* BCM part-number mismatch warning */}
            {(() => {
              if (!bcm.parsed?.ok) return null;
              const r = bcmFamilyMismatch(bcm.parsed, vehicleFamily);
              if (!r) return null;
              if (r.match) return (
                <div data-testid="bcm-family-match" style={{
                  padding: '12px 16px', borderRadius: 10, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10,
                  background: 'rgba(0,200,83,0.08)', color: '#0a7a3b', border: '1.5px solid rgba(0,200,83,0.3)', fontWeight: 700, fontSize: 13,
                }}>
                  ✓ BCM part number matches <strong>{r.family.label}</strong>
                </div>
              );
              return (
                <div data-testid="bcm-family-mismatch" style={{
                  padding: '12px 16px', borderRadius: 10, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6,
                  background: 'rgba(255,179,0,0.09)', border: '2px solid rgba(255,179,0,0.4)',
                }}>
                  <div style={{ fontWeight: 900, fontSize: 13, color: '#7a4a00' }}>⚠ BCM PART NUMBER MISMATCH</div>
                  <div style={{ fontSize: 12, color: '#7a4a00', lineHeight: 1.5 }}>
                    Selected vehicle: <strong>{r.family.label}</strong><br />
                    Expected BCM PN: <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{r.expected?.join(', ') || '—'}</span><br />
                    Detected BCM PN: <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{r.detected.join(', ') || '— none recognized'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#9a6000', fontStyle: 'italic' }}>
                    Flash a mismatched BCM into this vehicle at your own risk — key-fob and immobilizer pairing may fail.
                  </div>
                </div>
              );
            })()}

            {/* BCM-too-small banner */}
            {bcm.parsed?.tooSmall && (
              <div data-testid="bcm-too-small-banner" style={{
                padding: '14px 18px', borderRadius: 12, marginBottom: 14,
                fontWeight: 800, fontSize: 13, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                background: 'rgba(255,23,68,0.08)', color: '#a00025', border: `1.5px solid ${C.er}55`,
              }}>
                <span style={{ flex: 1 }}>
                  ✗ NOT READY — BCM file is too small ({bcm.parsed.size.toLocaleString()} B, need ≥ {bcm.parsed.minSize.toLocaleString()} B). Load a full BCM dump to enable VIN / SEC16 / SEC6 comparison.
                </span>
              </div>
            )}

            {/* VIN match banner */}
            {bothReady && (
              <div style={{
                padding: '14px 18px', borderRadius: 12, marginBottom: 14,
                fontWeight: 800, fontSize: 13, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                background: vinMatch ? 'rgba(0,200,83,0.1)' : 'rgba(255,23,68,0.08)',
                color: vinMatch ? '#0a7a3b' : '#a00025',
                border: `1.5px solid ${vinMatch ? 'rgba(0,200,83,0.3)' : 'rgba(255,23,68,0.25)'}`,
              }}>
                <span style={{ flex: 1 }}>
                  {vinMatch ? '✓ VIN MATCH' : '✗ VIN MISMATCH'} —{' '}
                  {vinMatch
                    ? <>BCM and RFHUB both carry <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · modules already paired</>
                    : <>BCM: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · RFHUB: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{rfh.parsed.vin}</strong> · sync required</>}
                </span>
                {(wizardIssues.length > 0 || wizardWarnings.length > 0) && (
                  <button data-testid="open-wizard-btn" onClick={() => setWizardOpen(true)}
                    style={{
                      background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                      border: 'none', borderRadius: 8, padding: '6px 14px',
                      color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
                      letterSpacing: 0.5, fontFamily: "'Nunito'", flexShrink: 0, whiteSpace: 'nowrap',
                    }}>
                    🔧 Fix with Wizard →
                  </button>
                )}
              </div>
            )}

            {/* PCM repair banner */}
            {pcmRepairable && (
              <div data-testid="pcm-repair-banner-cta" style={{
                padding: '10px 16px', borderRadius: 10, marginBottom: 14,
                background: 'rgba(255,23,68,0.08)', border: '1.5px solid rgba(255,23,68,0.35)',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 12, color: '#a00025', flex: 1, fontWeight: 700 }}>
                  ⚠ PCM dump is damaged but repairable — BCM and RFHUB agree on the VIN and pairing
                  secret, so SRT Lab can rewrite the bad offsets and produce a fixed file.
                  {pcmDamageSignals.length > 0 && (
                    <span style={{ fontWeight: 500, color: C.ts }}> · {pcmDamageSignals.join(' · ')}</span>
                  )}
                </span>
                <button data-testid="pcm-repair-banner-btn" onClick={() => setPcmRepairOpen(true)}
                  style={{
                    background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                    border: 'none', borderRadius: 8, padding: '6px 14px',
                    color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
                    letterSpacing: 0.5, fontFamily: "'Nunito'", whiteSpace: 'nowrap',
                  }}>
                  🩹 Repair PCM →
                </button>
              </div>
            )}

            {/* Standalone wizard trigger when SEC16/SEC6 issues are present with VIN match */}
            {bothReady && vinMatch && (() => {
              const SEC_TOKEN_RE = /MISMATCH|BLANK.*SEC16|SEC16.*BLANK|SEC6.*MISMATCH|SEC6.*paired|RFHUB.*SEC16.*MISMATCH|BCM.*SEC16.*MISMATCH/i;
              const hasSecTokenIssue =
                wizardIssues.some(m => SEC_TOKEN_RE.test(m)) ||
                wizardWarnings.some(m => SEC_TOKEN_RE.test(m));
              if (!hasSecTokenIssue) return null;
              return (
                <div style={{
                  padding: '10px 16px', borderRadius: 10, marginBottom: 14,
                  background: 'rgba(255,179,0,0.08)', border: '1.5px solid rgba(255,179,0,0.3)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 12, color: '#7a4a00', flex: 1 }}>
                    ⚠ Security token issues detected — use the wizard for guided resolution.
                  </span>
                  <button data-testid="open-wizard-btn-sec16" onClick={() => setWizardOpen(true)}
                    style={{
                      background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                      border: 'none', borderRadius: 8, padding: '6px 14px',
                      color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
                      letterSpacing: 0.5, fontFamily: "'Nunito'",
                    }}>
                    🔧 Fix with Wizard →
                  </button>
                </div>
              );
            })()}

            {/* Two-column BCM + RFH inspection cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginBottom: bothReady ? 14 : 0 }}>
              <BcmCard parsed={bcm.parsed} pnOverride={bcm.pnOverride} fullyVirgin={bcmFullyVirgin}
                       filename={bcm.file?.name} fileSize={bcm.bytes?.length} />
              <RfhCard parsed={rfh.parsed} pnOverride={rfh.pnOverride}
                       filename={rfh.file?.name} fileSize={rfh.bytes?.length} />
            </div>

            {/* Actions section — shown when both BCM and RFH are loaded and parsed */}
            {bothReady && (
              <div style={{
                padding: '16px 18px', borderRadius: 12, marginBottom: pcm.parsed ? 14 : 0,
                border: `1.5px solid ${C.gn}44`, background: 'rgba(0,200,83,0.03)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: C.tx }}>
                    Actions
                  </div>
                  <span style={{
                    fontSize: 9, padding: '2px 8px', borderRadius: 4,
                    background: C.gn, color: '#fff', fontWeight: 800, letterSpacing: 0.5,
                  }}>APPLY enabled</span>
                </div>
                <div style={{ fontSize: 11, color: C.ts, marginBottom: 12 }}>
                  It applies in both directions using the data already uploaded (without re-uploading files).
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button data-testid="modsync-action-rfh-to-bcm" onClick={() => doSync('rfh-to-bcm')}
                    style={{
                      background: 'transparent', border: `1.5px solid ${C.gn}`,
                      borderRadius: 8, padding: '9px 16px', color: C.gn,
                      fontWeight: 800, fontSize: 12, cursor: 'pointer',
                      letterSpacing: 0.4, fontFamily: "'Nunito'", textAlign: 'left',
                    }}>
                    ← Import RFH data → to BCM (download twinned BCM)
                  </button>
                  <button data-testid="modsync-action-bcm-to-rfh" onClick={() => doSync('bcm-to-rfh')}
                    style={{
                      background: 'transparent', border: `1.5px solid ${C.gn}`,
                      borderRadius: 8, padding: '9px 16px', color: C.gn,
                      fontWeight: 800, fontSize: 12, cursor: 'pointer',
                      letterSpacing: 0.4, fontFamily: "'Nunito'", textAlign: 'left',
                    }}>
                    → Import data from BCM → to RFH (download twinned RFH)
                  </button>
                  <button onClick={handleReset}
                    style={{
                      background: 'transparent', border: `1px solid ${C.bd}`,
                      borderRadius: 8, padding: '8px 14px', color: C.ts,
                      fontWeight: 700, fontSize: 11, cursor: 'pointer',
                      letterSpacing: 0.3, fontFamily: "'Nunito'", textAlign: 'left',
                    }}>
                    🔄 Re-filter / reload files
                  </button>
                </div>
              </div>
            )}

            {/* PCM card (only if pcm.parsed) */}
            {pcm.parsed && (
              <PcmCard
                parsed={pcm.parsed}
                bytes={pcm.bytes}
                pnOverride={pcm.pnOverride}
                repairAvailable={pcmRepairable}
                repairReasons={pcmDamageSignals}
                onRepair={() => setPcmRepairOpen(true)}
              />
            )}
          </div>
        </Card>
      )}

      {/* ── Standalone Tools ── */}
      <Card>
        <H2>Standalone Tools</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🌐 Sync Tool (HTML)</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              Self-contained offline tool — drop BCM and RFHUB bins directly in a browser tab, no server needed.
            </div>
            <a href="/SRTLAB_SYNC_TOOL.html" download="SRTLAB_SYNC_TOOL.html"
               onClick={() => trackDownload(ASSET_IDS.modSyncTool)}
               style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800, background: C.a3, color: '#fff', textDecoration: 'none', letterSpacing: 0.5 }}>
              ⬇ Download SRTLAB_SYNC_TOOL.html
            </a>
            <div style={{ marginTop: 8 }}><DownloadCounter assetId={ASSET_IDS.modSyncTool} /></div>
          </div>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🐍 Python Validator</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              CLI validator — verify VIN slots, CRC-16/CCITT checksums, and SEC16 state of any BCM or RFHUB dump.
            </div>
            <a href="/srtlab_validate.py" download="srtlab_validate.py"
               onClick={() => trackDownload(ASSET_IDS.modSyncValidate)}
               style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800, background: C.a2, color: '#fff', textDecoration: 'none', letterSpacing: 0.5 }}>
              ⬇ Download srtlab_validate.py
            </a>
            <div style={{ marginTop: 8 }}><DownloadCounter assetId={ASSET_IDS.modSyncValidate} /></div>
          </div>
        </div>
      </Card>

      {/* ── 95640 Standalone Tools ── shown when 95640 + RFHUB are loaded but BCM is not,
           so the "Re-key 95640 from RFHUB" 1-click flow is reachable without a BCM dump. */}
      {eep95640Loaded && !bothReady && (
        <Card>
          <H2 badge="1-click">95640 Backup Chip</H2>
          <div style={{ fontSize: 12, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
            The 95640 mirrors the BCM key data. Load the RFHUB master to enable a 1-click
            <strong> Re-key 95640 from RFHUB</strong> — writes reverse(RFH SEC16) into 95640 @ 0x838 with CRC16 @ 0x848.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            <ActionBtn title="📟 Re-key 95640 from RFHUB" enabled={rekey95640Ok}
              color={C.a4}
              desc={rekey95640Ok
                ? 'Reverse the RFHUB SEC16 (16 bytes) and write into 95640 @ 0x838. Big-endian CRC16 stamped @ 0x848. Downloads a new 95640 .bin.'
                : !rfhHasSec16 ? 'Load a Gen2 RFHUB with populated SEC16 to enable.'
                : eep.bytes && eep.bytes.length < 0x84A ? `95640 file too small (${eep.bytes.length} bytes — need ≥0x84A).`
                : 'Load a 95640 dump to enable.'}
              onClick={() => doSync('rekey-95640-from-rfh')} />
          </div>
        </Card>
      )}

      {/* ── Sync Actions disabled — BCM is too small (Task #370) ──
           When the BCM dump is undersized, bothReady is false so the live
           Sync Actions card below is hidden. Surface a parallel disabled-state
           card with the exact wording the task calls for so the operator sees
           why APPLY / Import data from BCM → PCM are unreachable. */}
      {bcm.parsed?.tooSmall && (rfh.bytes || pcm.bytes) && (
        <Card>
          <H2>Sync Actions</H2>
          <div data-testid="bcm-too-small-actions-notice"
               title="BCM file is too small — load a full ≥ 64 KB BCM dump."
               style={{
                 padding: '14px 18px', borderRadius: 10,
                 background: 'rgba(255,23,68,0.07)',
                 border: `2px solid ${C.er}`,
               }}>
            <div style={{ fontWeight: 900, fontSize: 12, color: C.er, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 }}>
              ⛔ APPLY / Import data from BCM → PCM unavailable
            </div>
            <div style={{ fontSize: 12, color: C.tx, fontWeight: 700, lineHeight: 1.6 }}>
              BCM file is too small — load a full ≥ 64 KB BCM dump.
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: C.ts, lineHeight: 1.6 }}>
              Detected size: {bcm.parsed.size.toLocaleString()} B · required min: {bcm.parsed.minSize.toLocaleString()} B (MPC5605B/06B DFLASH).
            </div>
          </div>
        </Card>
      )}

      {/* ── BCM-only: legacy 0x40C9 repair (Task #382) ──
          Available whenever a BCM is loaded with a populated split/mirror
          SEC16 — does not require RFH/PCM, since this only rewrites the
          legacy flat slice from data already inside the BCM. */}
      {bcm.bytes && bcm.parsed?.ok && !bothReady && flatRepairOk && (
        <Card>
          <H2>BCM legacy compatibility</H2>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, color: C.a3, marginBottom: 8, textTransform: 'uppercase' }}>
            🩹 Flat 0x40C9 repair (BCM-only)
          </div>
          <FlatRepairModeSelector
            mode={flatRepairMode}
            setMode={setFlatRepairMode}
            overlapDetected={flatRepairResolver?.candidates?.mirror1?.offset === 0x40C0}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <ActionBtn title="🩹 Repair flat 0x40C9 from split records"
              enabled={flatRepairOk}
              color={C.a3}
              desc={`Copy resolved SEC16 (source: ${flatRepairResolver.source} @0x${hex4(flatRepairResolver.offset)}) into legacy flat slice 0x40C9 (${flatRepairMode === 'legacy-flat' ? 'forces LE write even on overlap dumps' : 'preserves mirror1 on overlap dumps'}). For CGDI / Autel / AlfaOBD / SINCRO that still read the pre-Redeye flat field.`}
              onClick={() => doSync('bcm-flat-from-resolved')} />
            <ActionBtn title="⬇⬇ Download both copies (modern + legacy)"
              enabled={flatRepairOk && flatRepairOverlap}
              color={C.a3}
              desc={flatRepairOverlap
                ? 'One-click double emission: writes CANONICAL (for modern tools + SRT Lab) and LEGACYFLAT (for CGDI / Autel / AlfaOBD / SINCRO) copies in the same run. Use on overlap dumps so one click covers every downstream bench tool.'
                : 'Only enabled when an overlap dump is detected (mirror1 record at 0x40C0). Without overlap, canonical and legacy-flat outputs are byte-identical.'}
              onClick={() => doSync('bcm-flat-from-resolved-both')} />
          </div>
        </Card>
      )}

      {/* ── Sync Actions ── */}
      {bothReady && (
        <Card>
          <H2>Sync Actions</H2>

          {/* Target VIN input */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Target VIN — for write-both / sync-all modes
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                value={targetVin}
                onChange={e => setTargetVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
                placeholder="Enter 17-character VIN"
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 10,
                  border: `2px solid ${tvOk ? C.gn : C.bd}`,
                  background: C.c2, color: C.tx,
                  fontFamily: "'JetBrains Mono'", fontSize: 15, fontWeight: 700, letterSpacing: 2.5,
                  textAlign: 'center', outline: 'none', textTransform: 'uppercase',
                }}
              />
              {masterVinValid && (
                <button data-testid="prefill-master-vin"
                  onClick={() => { setTargetVin(masterVin); log(`Pre-filled target VIN from session Master VIN: ${masterVin}`, 'info'); }}
                  title={`Pre-fill from session Master VIN: ${masterVin}`}
                  style={{ padding: '10px 14px', borderRadius: 10, border: `2px solid ${C.a3}`, background: C.a3, color: '#fff', cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11, letterSpacing: 0.4, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  ↙ Use Master VIN
                </button>
              )}
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: tvOk ? C.gn : C.tm, fontWeight: 700, minWidth: 42, textAlign: 'right' }}>
                {tv.length} / 17
              </div>
            </div>
            {masterVinValid && (
              <div style={{ fontSize: 11, color: C.a3, marginTop: 6, fontWeight: 700, fontFamily: "'JetBrains Mono'", letterSpacing: 0.5 }}>
                Session Master VIN: <span style={{ color: C.tx }}>{masterVin}</span>
              </div>
            )}
            {/* Task #488 — surface the Charger LD trim/HP under the master
                VIN so every tab that pulls the master VIN gets the same
                visual cue. Renders nothing for non-Charger VINs. */}
            <VinChargerSubtitle vin={masterVin} dataTestId="modulesync-vin-decode" />
          </div>

          {/* VIN sync buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 10 }}>
            <ActionBtn title="➡ RFH VIN → BCM"   enabled={rfh.parsed.ok}
              desc={`Copy RFHUB VIN (${rfh.parsed.vin}) into BCM at all full + tail slots. Downloads new BCM bin.`}
              onClick={() => doSync('rfh-to-bcm')} />
            <ActionBtn title="⬅ BCM VIN → RFH"   enabled={bcm.parsed.ok}
              desc={`Copy BCM VIN (${bcm.parsed.vin}) into RFHUB byte-reversed at all 4 slots. Downloads new RFH bin.`}
              onClick={() => doSync('bcm-to-rfh')} />
            <ActionBtn title="🎯 TARGET VIN → BCM + RFH"  enabled={tvOk}
              desc={tvOk ? `Write ${tv} into BCM and RFHUB. Downloads both bins.` : 'Enter a valid 17-char VIN above.'}
              onClick={() => doSync('target-both')} />
          </div>

          {/* Gen2 SEC16 sync buttons */}
          {(bcmHasSec16 || sec16SyncOk || bcmFullyVirgin) && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, color: C.a4, marginBottom: 8, textTransform: 'uppercase' }}>
                🔐 SEC16 / IMMO Sync (SINCRO-verified · Gen2)
              </div>
              {/* Task #475 — target-chip selector for the PCM bundler output.
                  Default tracks the loaded donor's chip; the tech can pick
                  the other one when the donor and bench chip differ (e.g.
                  8 KB donor → 4 KB target). The doSync wrapper prompts
                  for confirmation before generating a mismatched output so
                  the explicit acknowledgement lives in one place. */}
              {pcm.bytes && pcmSourceChip && (
                <div data-testid="modsync-target-chip-selector"
                     style={{
                       marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                       background: targetChipMismatch ? C.wn + '14' : C.c2,
                       border: `1.5px solid ${targetChipMismatch ? C.wn : C.bd}`,
                     }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                      Target PCM chip
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {[
                        { key: '4kb', label: '4 KB · 95320' },
                        { key: '8kb', label: '8 KB · 95640' },
                      ].map(opt => {
                        const active = (targetPcmChip || pcmSourceChip.chipKey) === opt.key;
                        return (
                          <button key={opt.key}
                            data-testid={`modsync-target-chip-${opt.key}`}
                            data-active={active ? '1' : '0'}
                            onClick={() => setTargetPcmChip(opt.key)}
                            style={{
                              padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                              border: `2px solid ${active ? C.a4 : C.bd}`,
                              background: active ? C.a4 : C.cd,
                              color: active ? '#fff' : C.tx,
                              fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
                              letterSpacing: 0.4,
                            }}>{opt.label}</button>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: C.tm, fontFamily: "'JetBrains Mono'", fontWeight: 600 }}>
                      donor: {pcmSourceChip.label} ({pcm.bytes.length.toLocaleString()} B)
                    </div>
                  </div>
                  {targetChipMismatch && (
                    <div data-testid="modsync-target-chip-mismatch-note"
                         style={{ marginTop: 6, fontSize: 11, color: C.wn, fontWeight: 700, lineHeight: 1.5 }}>
                      ⚠ Donor is {pcmSourceChip.sizeLabel} but target is {targetChipDescriptor?.sizeLabel || '—'}. Generated PCM file will be{' '}
                      {targetPcmChip === '4kb' ? 'sliced to 4 KB' : '0xFF-padded to 8 KB'} so it matches your bench chip. You&apos;ll be asked to confirm before the file downloads.
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                {(() => {
                  /* When the BCM is fully virgin AND the RFHUB has a valid SEC16,
                   * swap in the "Re-key virgin BCM" button in place of the
                   * SEC16 Sync Only button, so the tech sees one clear action
                   * instead of a disabled button with no explanation. */
                  if (bcmFullyVirgin && rfhHasSec16) {
                    return (
                      <ActionBtn title="🔓 Re-key virgin BCM ← RFHUB"
                        enabled={true}
                        color={C.a1}
                        desc={`Write reverse(RFHUB SEC16) into BCM split records, mirrors, and flat 0x40C9. Normalise FOBIK count to ${rfh.parsed?.fobikSlots ?? '?'} (RFHUB populated slots). Downloads BCM_REKEYED_<VIN>_<ts>.bin.`}
                        onClick={() => doSync('rekey-virgin-bcm')} />
                    );
                  }
                  /* Task #475 — hard-block SEC16-only when the loaded PCM
                   * is non-canonical, mirroring SYNC ALL. The PCM SEC6
                   * write is part of this action, so producing a wrong-
                   * sized PCM here would also be rejected by CGDI. */
                  const pcmBlocked = pcm.bytes && pcmHasNonCanonicalSize;
                  const enabled = sec16SyncOk && !pcmBlocked;
                  return (
                    <ActionBtn title="🔐 SEC16 RFH → BCM (+ PCM SEC6)"  enabled={enabled}
                      color={pcmBlocked ? C.er : C.a4}
                      desc={pcmBlocked
                        ? `⛔ Loaded PCM is ${pcm.parsed?.size} B — neither 4 KB (95320) nor 8 KB (95640). The PCM SEC6 step would emit a wrong-sized file. Re-read the EXT EEPROM (not INT FLASH) or load the matching virgin before generating.`
                        : sec16SyncOk
                        ? `Copy RFH SEC16 (reversed) into BCM split records + mirrors. Write first 6 bytes as PCM SEC6${pcm.bytes ? ` (output sized to ${targetChipDescriptor?.sizeLabel || pcmSourceChip?.sizeLabel || 'donor'})` : ' (load PCM to also patch PCM)'}.`
                        : bcmHasSec16 ? 'RFHUB SEC16 is virgin or not detected' : 'BCM has no Gen2 SEC16 records'}
                      onClick={() => doSync('sec16-only')} />
                  );
                })()}
                <div>
                  {flatRepairOk && (
                    <FlatRepairModeSelector
                      mode={flatRepairMode}
                      setMode={setFlatRepairMode}
                      overlapDetected={flatRepairResolver?.candidates?.mirror1?.offset === 0x40C0}
                    />
                  )}
                  <ActionBtn title="🩹 Repair flat 0x40C9 from split records"
                    enabled={flatRepairOk}
                    color={C.a3}
                    desc={flatRepairOk
                      ? `Copy resolved SEC16 (source: ${flatRepairResolver.source} @0x${hex4(flatRepairResolver.offset)}) into legacy flat slice 0x40C9 (${flatRepairMode === 'legacy-flat' ? 'forces LE write even on overlap dumps' : 'preserves mirror1 on overlap dumps'}). For CGDI / Autel / AlfaOBD / SINCRO that still read the pre-Redeye flat field.`
                      : flatRepairResolver?.source === 'flat'
                        ? 'Resolver fell back to the flat slice itself — no live split/mirror records to copy from'
                        : flatRepairResolver?.blank
                          ? 'BCM SEC16 is blank (virgin) — nothing to repair'
                          : 'Requires a BCM with a populated SEC16 in split records or inactive-bank mirrors'}
                    onClick={() => doSync('bcm-flat-from-resolved')} />
                  <ActionBtn title="⬇⬇ Download both copies (modern + legacy)"
                    enabled={flatRepairOk && flatRepairOverlap}
                    color={C.a3}
                    desc={flatRepairOverlap
                      ? 'One-click double emission: writes CANONICAL (for modern tools + SRT Lab) and LEGACYFLAT (for CGDI / Autel / AlfaOBD / SINCRO) copies in the same run. Use on overlap dumps so one click covers every downstream bench tool.'
                      : 'Only enabled when an overlap dump is detected (mirror1 record at 0x40C0). Without overlap, canonical and legacy-flat outputs are byte-identical.'}
                    onClick={() => doSync('bcm-flat-from-resolved-both')} />
                </div>
                <ActionBtn title="🔄 BCM SEC16 → RFHUB"  enabled={bcmToRfhSec16Ok}
                  color={C.a2}
                  desc={bcmToRfhSec16Ok
                    ? 'BCM is master: writes reverse(BCM SEC16) into RFHUB Gen2 slots (0x050E + 0x0522). Use when RFHUB is from a different vehicle.'
                    : 'Requires BCM with Gen2 split records + Gen2 RFHUB (AA 55 31 01 header at 0x0500)'}
                  onClick={() => doSync('bcm-sec16-to-rfh')} />
                <ActionBtn title="🏭 BCM VIN + SEC16 → RFHUB"  enabled={bcmVinSec16ToRfhOk}
                  color={rfh.parsed?.virginChip ? C.wn : C.a2}
                  desc={bcmVinSec16ToRfhOk
                    ? `Write BCM VIN (${bcm.parsed?.vin}) + reverse(BCM SEC16) into RFHUB in one pass. Use for virgin or replacement chips. Downloads RFHUB_BCM_VIN_SEC16_*.bin.`
                    : 'Requires BCM with VIN + Gen2 split records + Gen2 RFHUB loaded.'}
                  onClick={() => doSync('bcm-vin-sec16-to-rfh')} />
                {(() => {
                  // Task #475 — hard-block SYNC ALL when the loaded PCM is a
                  // non-canonical size (neither 4 KB nor 8 KB). The CGDI
                  // flasher will refuse the output, so producing it would
                  // give the user a junk file and a wasted bench cycle.
                  const pcmSizeBlocked = pcmHasNonCanonicalSize;
                  // Task #1036 — refuse-on-doubt: block SYNC ALL when the
                  // loaded PCM is a virgin / blank engine module (canonical
                  // size but SEC6 secret slot unpopulated). Same predicate the
                  // writer halts on, so this preview mirrors writer gating.
                  const pcmVirginBlocked = !!(pcm.bytes && pcmSec6Blank);
                  const baseEnabled = tvOk || !!(rfh.parsed.vin);
                  const enabled = baseEnabled && !pcmSizeBlocked && !pcmVirginBlocked;
                  const desc = pcmSizeBlocked
                    ? `⛔ Loaded PCM is ${pcm.parsed.size} B — neither 4 KB (95320) nor 8 KB (95640). CGDI will reject. Re-read the EXT EEPROM (not INT FLASH) or load the matching virgin before SYNC.`
                    : pcmVirginBlocked
                      ? `⛔ Loaded engine module (GPEC2A) has a BLANK SEC6 immobilizer slot (virgin / unpopulated). SYNC ALL refuses to pair a blank engine module — load a PCM with a populated SEC6, or use the key-programming wizard to pair a fresh GPEC2A.`
                      : tvOk
                        ? `Write ${tv} + SEC16 to all loaded modules in one pass. SINCRO-verified output${pcm.bytes && targetChipDescriptor ? ` · PCM sized to ${targetChipDescriptor.sizeLabel}` : ''}.`
                        : `Write ${rfh.parsed.vin || bcm.parsed.vin} + SEC16 to all modules (no target VIN set)${pcm.bytes && targetChipDescriptor ? ` · PCM sized to ${targetChipDescriptor.sizeLabel}` : ''}.`;
                  return (
                    <ActionBtn title="⚡ SYNC ALL — BCM + RFH + PCM"
                      enabled={enabled}
                      color={(pcmSizeBlocked || pcmVirginBlocked) ? C.er : C.a1}
                      desc={desc}
                      onClick={() => doSync('sync-all')} />
                  );
                })()}
              </div>
              {pcmHasNonCanonicalSize && (
                <div data-testid="modsync-pcm-size-blocked-help"
                     style={{ marginTop: 8, padding: '8px 12px', background: C.er + '14', borderRadius: 8, fontSize: 11, color: C.er, fontWeight: 700, lineHeight: 1.5 }}>
                  ⛔ Generate is blocked: the loaded PCM is {pcm.parsed?.size} bytes — not the 4 KB (95320) or 8 KB (95640) the CGDI / Xprog / Orange5 flasher accepts.
                  Re-read the EXT EEPROM (not the INT FLASH) on your bench at the matching size, then drop the new file in to unlock SYNC.
                </div>
              )}
              {pcm.bytes && pcmSec6Blank && !pcmHasNonCanonicalSize && (
                <div data-testid="modsync-pcm-virgin-blocked-help"
                     style={{ marginTop: 8, padding: '8px 12px', background: C.er + '14', borderRadius: 8, fontSize: 11, color: C.er, fontWeight: 700, lineHeight: 1.5 }}>
                  ⛔ SYNC ALL is blocked: the loaded engine module (GPEC2A) has a BLANK SEC6 immobilizer slot — it is a virgin / unpopulated dump.
                  Pairing it would stamp this car's secret onto a module with nothing to verify against (the same refusal the full key-programming wizard enforces).
                  Load a PCM that already carries a populated SEC6, or use the dedicated key-programming wizard if you intend to pair a fresh GPEC2A.
                </div>
              )}
              {!sec16SyncOk && (
                <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(255,179,0,0.06)', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 600, lineHeight: 1.5 }}>
                  {bcmToRfhSec16Ok
                    ? '⚠ RFHUB SEC16 does not match BCM. Use "BCM SEC16 → RFHUB" (above) to re-sync the RFHUB to this BCM\'s secret, then key-program.'
                    : '⚠ SEC16 sync requires: BCM with Gen2 split records (0x81A0/C0/E0) AND RFHUB with populated SEC16 (not virgin).'}
                  {!bcmToRfhSec16Ok && !bcmHasSec16 && ' BCM: no SEC16 records detected.'}
                  {!bcmToRfhSec16Ok && bcmHasSec16 && !rfhHasSec16 && ' RFHUB: SEC16 is virgin or undetected.'}
                </div>
              )}
            </div>
          )}

          {/* Restore originals */}
          {(originals.bcm || originals.rfh || originals.pcm || originals.eep) && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              {originals.bcm && (
                <button onClick={() => doRestore('bcm')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a3}40`, background: `rgba(41,121,255,0.06)`, color: C.a3, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore BCM original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.bcm.filename}</span>
                  <FlatRepairBadge filename={originals.bcm.filename} />
                </button>
              )}
              {originals.rfh && (
                <button onClick={() => doRestore('rfh')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a2}40`, background: `rgba(0,191,165,0.06)`, color: C.a2, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore RFH original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.rfh.filename}</span>
                </button>
              )}
              {originals.pcm && (
                <button onClick={() => doRestore('pcm')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a1}40`, background: `rgba(255,109,0,0.06)`, color: C.a1, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore PCM original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.pcm.filename}</span>
                </button>
              )}
              {originals.eep && (
                <button onClick={() => doRestore('eep')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a4}40`, background: `rgba(170,0,255,0.06)`, color: C.a4, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore 95640 original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.eep.filename}</span>
                </button>
              )}
            </div>
          )}

          {/* Virginize checkbox */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.c2, borderRadius: 10, marginTop: 10, border: `1.5px solid ${C.bd}` }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 1 }}>
              <input type="checkbox" checked={virginize} onChange={e => setVirginize(e.target.checked)}
                     style={{ width: 16, height: 16, accentColor: C.sr, cursor: 'pointer' }} />
              <span>🆕 VIRGINIZE RFH SEC16 ({rfhForVirginize})</span>
            </label>
            <div style={{ fontSize: 10, color: C.wn, fontWeight: 700, letterSpacing: 0.3 }}>⚠ forces re-pair on power-up</div>
          </div>
          <div style={{ fontSize: 11, color: C.ts, fontStyle: 'italic', padding: '8px 12px', background: C.c2, borderRadius: 8, borderLeft: `3px solid ${C.a3}`, marginTop: 8, lineHeight: 1.5 }}>
            <strong>Virginize</strong> wipes RFHUB's SEC16 so modules negotiate a fresh security key on first power-up. Use for salvage rebuilds; skip for factory-paired swaps.
            {rfh.parsed?.format === 'gen2' && <span style={{ color: C.a4 }}> Gen2 detected — will wipe 0x050E and 0x0522.</span>}
          </div>

          {/* Log */}
          <div ref={logRef} style={{ background: '#0F1419', color: '#E0E0E0', padding: '14px 16px', borderRadius: 10, fontFamily: "'JetBrains Mono'", fontSize: 11, lineHeight: 1.6, marginTop: 12, maxHeight: 280, overflowY: 'auto', border: '1.5px solid #2A2F36' }}>
            {logLines.map((l, i) => {
              const colors = { ok: '#4ADE80', warn: '#FACC15', err: '#F87171', info: '#60A5FA', muted: '#6B7280' };
              return (
                <div key={i} style={{ marginBottom: 2 }}>
                  <span style={{ color: '#6B7280', marginRight: 8 }}>{l.ts}</span>
                  <span style={{ color: colors[l.level] || '#E0E0E0' }}>{l.msg}</span>
                </div>
              );
            })}
          </div>
          <VinDiffTable rows={diffRows} />
        </Card>
      )}

      {/* ── VILLAIN Operations Reference (Task #589) ──
           Surfaces the catalog's villain_operations DID labels and protocol
           scope chips so a tech reading the bench/sync log can decode raw
           hex DIDs without leaving the tab. Sourced from getDidOperations()
           which indexes unlock_catalog_extended.json → villain_operations. */}
      <VillainOpsReference Card={Card} H2={H2} />

      {/* ── P/N Override confirm dialog ── */}
      {overrideConfirm && (
        <OverrideConfirmModal
          modules={overrideConfirm.modules}
          onCancel={() => {
            log(`Sync cancelled — P/N override acknowledgement declined (${overrideConfirm.modules.join(', ')})`, 'warn');
            setOverrideConfirm(null);
          }}
          onConfirm={(dontAskAgain) => {
            const { action, overrideVin, modules } = overrideConfirm;
            if (dontAskAgain) {
              skipOverrideConfirmRef.current = true;
              log('P/N override prompt suppressed for the rest of this session.', 'muted');
            }
            log(`Acknowledged P/N override on ${modules.join(', ')} — proceeding with ${action}.`, 'warn');
            setOverrideConfirm(null);
            executeSync(action, overrideVin);
          }}
        />
      )}

      {/* ── Flat 0x40C9 repair confirm (Task #801) ── */}
      {flatRepairConfirm && (
        <FlatRepairConfirmModal
          mode={flatRepairConfirm.mode}
          onCancel={() => {
            log(`Flat 0x40C9 repair cancelled — compatibility-mode confirmation declined (${flatRepairConfirm.mode}).`, 'warn');
            setFlatRepairConfirm(null);
          }}
          onConfirm={(dontAskAgain) => {
            const { action, overrideVin, mode } = flatRepairConfirm;
            if (dontAskAgain) {
              skipFlatRepairConfirmRef.current = true;
              log('Flat 0x40C9 repair confirm suppressed for the rest of this session.', 'muted');
            }
            log(`Acknowledged flat 0x40C9 repair in ${mode} mode — proceeding.`, 'warn');
            setFlatRepairConfirm(null);
            /* Route back through doSync so the remaining preflight gates
             * (notably the P/N override confirm) still run on the combined
             * overlap + override edge case. The one-shot bypass keeps the
             * modal from re-opening on the re-entry. */
            flatRepairJustConfirmedRef.current = true;
            doSync(action, overrideVin);
          }}
        />
      )}

      {/* ── Virginize confirm dialog (Task #1025) ── */}
      {virginizeConfirm && (
        <VirginizeConfirmModal
          onCancel={() => {
            log('Sync cancelled — virginize acknowledgement declined. No files were written.', 'warn');
            setVirginizeConfirm(null);
          }}
          onConfirm={(dontAskAgain) => {
            const { action, overrideVin } = virginizeConfirm;
            if (dontAskAgain) {
              skipVirginizeConfirmRef.current = true;
              log('Virginize confirm suppressed for the rest of this session.', 'muted');
            }
            log('⚠ Acknowledged: exported RFHUB is VIRGIN — it shares no immobilizer secret with the BCM and must be re-keyed on the bench (RoutineControl 0x0401 on the RFHUB tab) before the car will pair.', 'warn');
            setVirginizeConfirm(null);
            /* Route back through doSync so the remaining preflight gates
             * (flat-repair, PCM resize, P/N override) still run. The
             * one-shot bypass keeps this modal from re-opening. */
            virginizeJustConfirmedRef.current = true;
            doSync(action, overrideVin);
          }}
        />
      )}

      {/* ── Full 3-Module Pairing Repair modal (Task #1052) ── */}
      {pairingRepairOpen && (
        <PairingRepairPanel
          bcmBytes={bcm.bytes || undefined}
          bcmFilename={bcm.file?.name}
          rfhubBytes={rfh.bytes || undefined}
          rfhubFilename={rfh.file?.name}
          pcmBytes={pcm.bytes || undefined}
          pcmFilename={pcm.file?.name}
          onClose={() => setPairingRepairOpen(false)}
          onPatchComplete={handlePatchComplete}
        />
      )}

      {/* ── PCM Repair Wizard modal (Task #574) ── */}
      {pcmRepairOpen && pcmRepairable && (
        <PcmRepairWizard
          pcmBytes={pcm.bytes}
          pcmFilename={pcm.file?.name || 'pcm.bin'}
          targetVin={bcm.parsed.vin}
          secret6={pcmRepairSecret6}
          bcmVin={bcm.parsed.vin}
          rfhVin={rfh.parsed.vin}
          rfhSec16Hex={Array.from(rfh.parsed.sec16.slot1)
            .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
          damageReasons={pcmDamageSignals}
          onClose={() => setPcmRepairOpen(false)}
          onLog={(msg, level) => log(msg, level)}
        />
      )}

      {/* ── Mismatch Resolution Wizard modal ── */}
      {wizardOpen && (
        <MismatchWizard
          issues={wizardIssues}
          warnings={wizardWarnings}
          modules={wizardModules}
          hexSnippets={wizardHexSnippets}
          /* Task #694 — feed loaded raw bytes into the AI assistant so it
           * can call read_hex / extract_strings / parse_module against
           * the actual file content. Only modules with bytes loaded are
           * included; the wizard converts to base64 before sending. */
          moduleBytes={(() => {
            const out = {};
            if (bcm?.bytes) out.BCM = bcm.bytes;
            if (rfh?.bytes) out.RFH = rfh.bytes;
            if (pcm?.bytes) out.PCM = pcm.bytes;
            return out;
          })()}
          bcmSec16Status={bcm.parsed?.bcmSec16 || null}
          onClose={() => setWizardOpen(false)}
          onAction={(actionId, _stepId, opts) => {
            return doSync(
              actionId === 'full-sync' ? 'sync-all' : actionId,
              opts?.vinOverride,
            );
          }}
          stepActions={wizardStepActions}
          sessionKey={`modsync:${vehicleId || 'global'}`}
        />
      )}
    </div>
  );
}
