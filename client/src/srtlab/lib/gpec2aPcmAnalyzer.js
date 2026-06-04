/* ============================================================================
 * gpec2aPcmAnalyzer.js — offline-dump analyzer + immo-fix derivation for
 * Continental GPEC2A PCM external EEPROM captures (Task #1035).
 *
 * Modeled on the competitor "ImmoVIN – PCM GPEC Universal" read-out, but
 * scoped to GPEC2A ONLY and wired to SRT Lab's existing parsers / writers so
 * there is a single source of truth for the immobilizer secret transform.
 *
 * Everything here is PURE — callers pass a raw Uint8Array and receive a plain
 * read-out object or a patched buffer. No DOM, no fetch, no live-OBD coupling.
 *
 *   analyzeGpec2aPcm(bytes)              → structured read-out (cards/tables)
 *   derivePcmSec6FromDonor(donorMod)     → {sec6, rfhSec16, source, detail}
 *   applyGpec2aChanges(bytes, opts)      → {ok, bytes, changes} | {ok:false,error}
 *   applyGpec2aImmoFix(bytes, sec6)      → {ok, bytes, ...}      | {ok:false,error}
 *
 * IMMO secret convention (mirrors ModuleSync / securityBytes.js):
 *   PCM SEC6 = RFH SEC16[0:6] = reverse(BCM SEC16)[0:6]
 *   marker FF FF FF AA @ 0x3C4 must be present for the PCM to treat SEC6 as
 *   paired — see writePcmSec6 in securityBytes.js.
 * ========================================================================== */

import {
  classifyPcmSec6,
  PCM_VIN_OFFSETS_GPEC2A,
  extractVIN,
  extractHex,
  resolveBcmSec16,
  pcmChipFromSize,
} from './parseModule.js';
import {
  PCM_SEC6_MARKER,
  PCM_SEC6_MARKER_OFFSET,
  PCM_SEC6_OFFSET,
  writePcmSec6,
} from './securityBytes.js';
import { extractRfhPflashIdentity } from './rfhPflashIdentity.js';

/* Valid VIN body: 17 chars, A–Z / 0–9, no I, O, Q. */
export const GPEC2A_VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* Human-friendly slot names per VIN offset, matching the competitor read-out. */
const VIN_SLOT_NAMES = {
  0x0000: 'actual_0x0000',
  0x01f0: 'original_0x01F0',
  0x0224: 'copy_0x0224',
  0x0ce0: 'extra_0x0CE0',
};

const offHex = (o) => '0x' + o.toString(16).toUpperCase().padStart(4, '0');

function bytesToHexStr(arr) {
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).toUpperCase().padStart(2, '0');
    if (i < arr.length - 1) s += ' ';
  }
  return s;
}

function allFill(arr, v) {
  for (let i = 0; i < arr.length; i++) if (arr[i] !== v) return false;
  return arr.length > 0;
}

/* Printable-only run starting at `off`, dropping non-printable bytes (0xFF
 * separators etc.) so a field like 0x081C "AC␣00EP" reads "AC00EP". */
function asciiField(bytes, off, len) {
  if (!bytes || off + len > bytes.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = bytes[off + i];
    if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
  }
  return s;
}

/* A canonical GPEC2A external EEPROM is a flat 4 KB (95320) or 8 KB (95640)
 * image with room for the SEC6 marker + secret. The engine writer refuses
 * anything else, so the analyzer gates writes on the same shape. */
export function isCanonicalGpec2a(bytes) {
  return !!bytes && (bytes.length === 4096 || bytes.length === 8192) && bytes.length >= 0x3ce;
}

/* ── Analyzer ─────────────────────────────────────────────────────────────
 * Returns the full read-out used by the ECM-tab panel:
 *   { ok, family, eeprom, state, sec6, immo, notes, vinRows, ids }
 */
export function analyzeGpec2aPcm(bytes) {
  if (!bytes || bytes.length === 0) {
    return { ok: false, error: 'Empty buffer.' };
  }
  const sz = bytes.length;
  const canonical = isCanonicalGpec2a(bytes);

  /* ── VINs by offset ── */
  let consensus = null;
  const vinValues = [];
  for (const o of PCM_VIN_OFFSETS_GPEC2A) {
    const v = extractVIN(bytes, o);
    if (v && GPEC2A_VIN_RE.test(v)) vinValues.push(v);
  }
  if (vinValues.length) {
    const counts = {};
    for (const v of vinValues) counts[v] = (counts[v] || 0) + 1;
    consensus = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  const vinRows = PCM_VIN_OFFSETS_GPEC2A.map((o) => {
    const raw = o + 17 <= sz ? bytes.slice(o, o + 17) : new Uint8Array(0);
    const vin = extractVIN(bytes, o);
    const isFF = raw.length > 0 && allFill(raw, 0xff);
    const formatOk = !!(vin && GPEC2A_VIN_RE.test(vin));
    let state;
    if (formatOk) state = 'WIN_OK';
    else if (isFF) state = 'EMPTY_FF';
    else if (raw.length === 0) state = 'OUT_OF_RANGE';
    else state = 'INVALID';
    return {
      slot: VIN_SLOT_NAMES[o] || ('slot_' + offHex(o)),
      offset: o,
      offsetHex: offHex(o),
      vin: formatOk ? vin : null,
      state,
      format: formatOk ? 'OK' : 'NO',
      check: formatOk && consensus && vin === consensus ? 'OK' : 'NO',
      raw: raw.length ? bytesToHexStr(raw) : '',
    };
  });
  const validVinCount = vinRows.filter((r) => r.state === 'WIN_OK').length;

  /* ── SEC6 + IMMO marker ── */
  let sec6 = null;
  let immo = null;
  if (sz >= 0x3ce) {
    const s6 = bytes.slice(PCM_SEC6_OFFSET, PCM_SEC6_OFFSET + 6);
    const marker = bytes.slice(PCM_SEC6_MARKER_OFFSET, PCM_SEC6_MARKER_OFFSET + 4);
    const cls = classifyPcmSec6(s6);
    const markerOk =
      marker[0] === 0xff && marker[1] === 0xff && marker[2] === 0xff && marker[3] === 0xaa;
    let s6State;
    if (allFill(s6, 0xff)) s6State = 'EMPTY_FF';
    else if (allFill(s6, 0x00)) s6State = 'EMPTY_00';
    else if (cls.populated) s6State = 'POPULATED';
    else s6State = 'DAMAGED';
    sec6 = {
      offset: PCM_SEC6_OFFSET,
      bytes: s6,
      hex: bytesToHexStr(s6),
      state: s6State,
      blank: cls.blank,
      populated: cls.populated,
      classification: cls,
    };
    immo = {
      markerOffset: PCM_SEC6_MARKER_OFFSET,
      current: marker,
      currentHex: bytesToHexStr(marker),
      expected: new Uint8Array(PCM_SEC6_MARKER),
      expectedHex: bytesToHexStr(PCM_SEC6_MARKER),
      synced: markerOk && cls.populated,
      markerOk,
    };
  }

  /* ── EEPROM / chip ── */
  const chip = pcmChipFromSize(sz);
  const eeprom = {
    chip: chip ? chip.chip : null,
    chipLabel: chip ? chip.label : null,
    sizeBytes: sz,
    sizeHex: '0x' + sz.toString(16).toUpperCase(),
    sizeLabel: sz === 4096 ? '4 KB' : sz === 8192 ? '8 KB' : (sz / 1024).toFixed(1) + ' KB',
    reading: chip
      ? `${chip.chip} · ${sz === 4096 ? '4 KB' : sz === 8192 ? '8 KB' : sz + ' B'} · 0x${sz
          .toString(16)
          .toUpperCase()}`
      : `${sz} B · 0x${sz.toString(16).toUpperCase()}`,
  };

  /* ── State verdict ── */
  const stateParts = [];
  stateParts.push(validVinCount > 0 ? 'PROGRAMMED' : 'VIRGIN / NO VIN');
  if (immo) stateParts.push(immo.synced ? 'IMMO SYNC' : 'NO IMMO SYNC');
  if (sec6) {
    stateParts.push(
      sec6.state === 'EMPTY_FF'
        ? 'SEC6 FF'
        : sec6.state === 'EMPTY_00'
          ? 'SEC6 00'
          : sec6.state === 'POPULATED'
            ? 'SEC6 SET'
            : 'SEC6 DAMAGED'
    );
  }
  const state = {
    verdict: stateParts.join(' / '),
    validVinCount,
    immoSync: immo ? immo.synced : false,
  };

  /* ── Family / confidence ── */
  const sig081f = asciiField(bytes, 0x081f, 4);
  const hasSig = /^[0-9A-Z]{2,}/.test(sig081f);
  let score = 0;
  if (sz === 4096 || sz === 8192) score += 40;
  score += Math.min(validVinCount, 3) * 10;
  if (hasSig) score += 20;
  const confidence = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
  const family = {
    code: 'GPEC2A',
    label: 'Continental GPEC2A',
    confidence,
    score,
  };

  /* ── Reasons / notes ── */
  const notes = [];
  notes.push({
    tag: 'DETECTION',
    text: `Size ${eeprom.sizeHex} / ${eeprom.sizeLabel}: ${
      sz === 4096
        ? 'canonical 4 KB GPEC2A external EEPROM (95320)'
        : sz === 8192
          ? 'canonical 8 KB GPEC2A external EEPROM (95640)'
          : 'non-canonical size — confirm this is a GPEC2A image'
    }`,
  });
  if (hasSig) {
    notes.push({ tag: 'DETECTION', text: `Signature ${sig081f} detected at 0x081F` });
  }
  if (immo) {
    notes.push({
      tag: immo.synced ? 'IMMO' : 'WARNING',
      text: immo.synced
        ? 'IMMO marker present (FF FF FF AA) and SEC6 populated — paired'
        : `IMMO not synced — marker ${immo.currentHex}, expected ${immo.expectedHex}`,
    });
  }

  /* ── Internal IDs / signatures ── */
  const identity = extractRfhPflashIdentity(bytes) || {};
  const idVal = (f) => (f && f.value ? f.value : null);
  const ids = {
    ecu: idVal(identity.os),
    partNumber: idVal(identity.pn),
    serial: idVal(identity.serial),
    family081F: asciiField(bytes, 0x081f, 4) || null,
    variant0825: asciiField(bytes, 0x0825, 7) || null,
    continental0FA1:
      sz >= 0x0fae ? extractVIN(bytes, 0x0fa1, 13) || asciiField(bytes, 0x0fa1, 13) || null : null,
    dt23_081C: asciiField(bytes, 0x081c, 7) || null,
  };

  return { ok: canonical, canonical, family, eeprom, state, sec6, immo, notes, vinRows, ids };
}

/* ── Donor → PCM SEC6 derivation ─────────────────────────────────────────
 * Accepts a parseModule() result for a BCM or RFHUB dump and returns the
 * 6-byte PCM secret plus the full 16-byte rfhSec16 to feed writePcmSec6.
 * Returns null when no usable secret can be derived (wrong module, blank,
 * unresolved). */
export function derivePcmSec6FromDonor(donorMod) {
  if (!donorMod || !donorMod.data || !donorMod.data.length) return null;
  if (donorMod.type === 'BCM') {
    const r = resolveBcmSec16(donorMod.data);
    if (!r || !r.bytes || r.bytes.length < 16 || r.blank) return null;
    const rfhSec16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rfhSec16[i] = r.bytes[15 - i];
    if (allFill(rfhSec16, 0xff) || allFill(rfhSec16, 0x00)) return null;
    return {
      sec6: rfhSec16.slice(0, 6),
      rfhSec16,
      source: 'BCM',
      detail: `reverse(BCM SEC16 · ${r.source || 'resolved'})[0:6]`,
    };
  }
  if (donorMod.type === 'RFHUB') {
    const vs = donorMod.vehicleSecret;
    if (!vs || !vs.bytes || vs.bytes.length < 16) return null;
    const rfhSec16 = new Uint8Array(vs.bytes);
    if (allFill(rfhSec16, 0xff) || allFill(rfhSec16, 0x00)) return null;
    return {
      sec6: rfhSec16.slice(0, 6),
      rfhSec16,
      source: 'RFHUB',
      detail: 'RFHUB SEC16[0:6]',
    };
  }
  return null;
}

/* ── Export safety: refuse a non-synced SEC6 ─────────────────────────────────
 * Given the bytes that are about to be exported, verify the SEC6 actually
 * written at 0x3C8 matches the secret derived from a loaded BCM donor
 * (reverse(BCM SEC16)[0:6]). When a BCM donor is present and the resulting
 * SEC6 disagrees, the export is refused so a "fixed" PCM can never ship the
 * wrong (un-synced) immobilizer secret. The user can bypass this by entering a
 * SEC6 manually (an explicit override) or when no BCM donor is loaded (nothing
 * authoritative to compare against). */
export function checkSec6MatchesBcm(outBytes, donorMods = [], manualOverride = false) {
  if (!outBytes || outBytes.length < PCM_SEC6_OFFSET + 6) return { ok: true };
  const eq6 = (a, b) => {
    for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  // Collect EVERY usable BCM-derived secret across all loaded donors (a blank
  // or virgin BCM yields nothing and must not shadow a later valid one).
  const distinct = [];
  for (const d of donorMods || []) {
    if (!d || d.type !== 'BCM' || !d.data || !d.data.length) continue;
    const t = derivePcmSec6FromDonor(d);
    if (!t || !t.sec6 || t.sec6.length < 6) continue;
    const sec6 = t.sec6.slice(0, 6);
    if (!distinct.some((u) => eq6(u, sec6))) distinct.push(sec6);
  }
  if (distinct.length === 0) return { ok: true }; // nothing authoritative to compare
  const final = outBytes.slice(PCM_SEC6_OFFSET, PCM_SEC6_OFFSET + 6);
  const finalHex = bytesToHexStr(final);
  // Explicit manual override bypasses both the match and conflict gates.
  if (manualOverride) {
    return {
      ok: true,
      override: true,
      final: finalHex,
      target: distinct.length === 1 ? bytesToHexStr(distinct[0]) : undefined,
    };
  }
  // Two loaded BCMs disagree → which secret is authoritative is ambiguous.
  if (distinct.length > 1) {
    const list = distinct.map((t) => bytesToHexStr(t));
    return {
      ok: false,
      final: finalHex,
      conflict: list,
      error:
        `Refusing export — loaded BCM donors derive different secrets (${list.join(' vs ')}). ` +
        `Remove the conflicting BCM, or type the secret into the SEC6 field to override.`,
    };
  }
  const target = distinct[0];
  const targetHex = bytesToHexStr(target);
  if (eq6(target, final)) return { ok: true, target: targetHex, final: finalHex };
  return {
    ok: false,
    target: targetHex,
    final: finalHex,
    error:
      `Refusing export — resulting SEC6 ${finalHex} does not match the BCM-derived secret ${targetHex}. ` +
      `Load the matching BCM donor, or type the secret into the SEC6 field to override.`,
  };
}

/* ── Apply changes (VIN + SEC6 + optional IMMO marker) ───────────────────── */
export function applyGpec2aChanges(bytes, opts = {}) {
  const { newVin = '', alsoWriteCe0 = false, newSec6 = null, fixImmo = false } = opts;
  if (!isCanonicalGpec2a(bytes)) {
    return { ok: false, error: 'Not a canonical 4 KB / 8 KB GPEC2A image — refusing to write.' };
  }
  const out = new Uint8Array(bytes);
  const changes = [];

  const vin = (newVin || '').trim().toUpperCase();
  if (vin) {
    if (!GPEC2A_VIN_RE.test(vin)) {
      return { ok: false, error: 'VIN must be 17 characters (A–Z, 0–9, no I / O / Q).' };
    }
    const offs = [0x0000, 0x01f0, 0x0224];
    if (alsoWriteCe0) offs.push(0x0ce0);
    for (const o of offs) {
      for (let i = 0; i < 17; i++) out[o + i] = vin.charCodeAt(i);
      changes.push(`VIN → ${offHex(o)}`);
    }
  }

  if (newSec6) {
    if (newSec6.length < 6) {
      return { ok: false, error: 'SEC6 must be exactly 6 bytes.' };
    }
    for (let i = 0; i < 6; i++) out[PCM_SEC6_OFFSET + i] = newSec6[i];
    changes.push(`SEC6 → ${offHex(PCM_SEC6_OFFSET)}`);
  }

  if (fixImmo) {
    for (let i = 0; i < 4; i++) out[PCM_SEC6_MARKER_OFFSET + i] = PCM_SEC6_MARKER[i];
    changes.push(`IMMO marker FF FF FF AA → ${offHex(PCM_SEC6_MARKER_OFFSET)}`);
  }

  if (changes.length === 0) {
    return { ok: false, error: 'Nothing to apply — enter a VIN, a SEC6, or enable FIX IMMO.' };
  }
  return { ok: true, bytes: out, changes };
}

/* ── Just FIX IT (one-click immo repair) ───────────────────────────────────
 * Stamps the family marker (FF FF FF AA) and writes the 6-byte SEC6 secret in
 * one pass via the shared engine writer. Refuses on doubt: non-canonical
 * shape, missing secret, or a blank (virgin) donor secret. */
export function applyGpec2aImmoFix(bytes, sec6) {
  if (!isCanonicalGpec2a(bytes)) {
    return { ok: false, error: 'Not a canonical 4 KB / 8 KB GPEC2A image — refusing to write.' };
  }
  if (!sec6 || sec6.length < 6) {
    return {
      ok: false,
      error: 'No SEC6 secret available — load a BCM / RFHUB donor or enter 6 bytes manually.',
    };
  }
  const six = sec6.slice(0, 6);
  if (allFill(six, 0xff) || allFill(six, 0x00)) {
    return {
      ok: false,
      error: 'SEC6 secret is blank (all FF / 00) — cannot fix immo from a virgin source.',
    };
  }
  const res = writePcmSec6(bytes, sec6);
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.reason) || 'writePcmSec6 refused the write.' };
  }
  return {
    ok: true,
    bytes: res.bytes,
    sec6Hex: bytesToHexStr(six),
    markerHex: bytesToHexStr(PCM_SEC6_MARKER),
    changes: [
      `IMMO marker FF FF FF AA → ${offHex(PCM_SEC6_MARKER_OFFSET)}`,
      `SEC6 → ${offHex(PCM_SEC6_OFFSET)}`,
    ],
  };
}
