/* ============================================================================
 * pairingRepair.js — pure triage engine for the Full 3-Module Pairing Repair
 * workflow (Task #1052).
 *
 * Exports:
 *   triageModuleSet({ bcm?, rfhub?, pcm? })
 *     → { bcm, rfhub, pcm }  — per-module triage report
 *
 * Per-module report shape:
 *   {
 *     loaded:     boolean,
 *     state:      'trusted' | 'blank' | 'damaged' | 'absent',
 *     provenance: string,           // human label: 'Split', 'Mirror1', 'Flat', etc.
 *     sec16Bytes: Uint8Array|null,  // 16 bytes (BCM SEC16 form for BCM, RFH form for RFHUB)
 *     sec16Hex:   string|null,
 *     sec6Bytes:  Uint8Array|null,  // PCM only: 6 bytes at 0x3C8
 *     sec6Hex:    string|null,
 *     markerHex:  string|null,      // PCM only: 4 bytes at 0x3C4
 *     markerOk:   boolean,          // PCM only: true when FF FF FF AA
 *     rfhFormat:  string|null,      // RFHUB only: 'gen1' | 'gen2'
 *   }
 *
 * No UI, no side-effects, no fetch. Reuses existing library functions.
 * ========================================================================== */

import { resolveBcmSec16, classifyPcmSec6 } from './parseModule.js';
import { PCM_SEC6_MARKER_OFFSET, PCM_SEC6_OFFSET } from './securityBytes.js';

const fmtHex = (arr) => {
  if (!arr || arr.length === 0) return '';
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
};

const allFill = (arr, v) => arr && arr.length > 0 && Array.from(arr).every(b => b === v);

/* ── BCM triage ─────────────────────────────────────────────────────────── */
function triageBcm(bytes) {
  if (!bytes || bytes.length === 0) {
    return {
      loaded: false,
      state: 'absent',
      provenance: 'Not loaded',
      sec16Bytes: null, sec16Hex: null,
      sec6Bytes: null, sec6Hex: null,
      markerHex: null, markerOk: false,
      rfhFormat: null,
    };
  }

  const r = resolveBcmSec16(bytes);

  let state, provenance;
  if (r.sec16Absent || (!r.bytes && r.blank)) {
    state = 'absent';
    provenance = 'Blank / virgin — no SEC16 anywhere';
  } else if (r.blank || !r.bytes) {
    state = 'blank';
    provenance = 'Blank (all FF / 00)';
  } else {
    state = 'trusted';
    const srcMap = {
      split: 'Split records (0x81A0/C0/E0)',
      mirror1: 'Mirror1 slot 0xEB',
      mirror2: 'Mirror2 slot 0xCA',
      flat: 'Flat slice 0x40C9 (legacy)',
    };
    provenance = srcMap[r.source] || ('Source: ' + (r.source || 'unknown'));
  }

  return {
    loaded: true,
    state,
    provenance,
    sec16Bytes: r.bytes ? new Uint8Array(r.bytes) : null,
    sec16Hex: r.bytes ? fmtHex(r.bytes) : null,
    sec6Bytes: null,
    sec6Hex: null,
    markerHex: null,
    markerOk: false,
    rfhFormat: null,
    resolverSource: r.source,
  };
}

/* ── RFHUB triage ───────────────────────────────────────────────────────── */
/* Canonical SEC16 slot locations (verified against parseModule.js):
 *   Gen2 (24C32, 4096 B or 8192 B): slots at 0x050E and 0x0522
 *   Gen1 (24C16, 2048 B):            slots at 0x00AE and 0x00C0
 * Checksum for both Gen1 and Gen2: (crc8_65(raw16) << 8) | 0x00 at slot+16/+17.
 * Format is determined by buffer size, same rule as parseModule.js. */
const RFH_GEN2_HEADER_OFFSET = 0x0500;
const RFH_GEN2_SLOTS = [0x050E, 0x0522];
const RFH_GEN1_SLOTS = [0x00AE, 0x00C0];

function triageRfhub(bytes) {
  if (!bytes || bytes.length === 0) {
    return {
      loaded: false,
      state: 'absent',
      provenance: 'Not loaded',
      sec16Bytes: null, sec16Hex: null,
      sec6Bytes: null, sec6Hex: null,
      markerHex: null, markerOk: false,
      rfhFormat: null,
    };
  }

  const sz = bytes.length;

  /* Format detection: same size-based rule as parseModule.js */
  const isGen2 = sz === 4096 || sz === 8192;
  const isGen1 = sz === 2048;

  let rfhFormat, slots, provName;
  if (isGen2) {
    rfhFormat = 'gen2';
    slots = RFH_GEN2_SLOTS;
    provName = `Gen2 slots 0x050E/0x0522`;
  } else if (isGen1) {
    rfhFormat = 'gen1';
    slots = RFH_GEN1_SLOTS;
    provName = `Gen1 slots 0x00AE/0x00C0`;
  } else {
    /* Unrecognised size — try Gen2 header heuristic as fallback */
    const hasGen2Hdr = sz >= 0x0532 &&
      bytes[RFH_GEN2_HEADER_OFFSET]     === 0xAA &&
      bytes[RFH_GEN2_HEADER_OFFSET + 1] === 0x55 &&
      bytes[RFH_GEN2_HEADER_OFFSET + 2] === 0x31 &&
      bytes[RFH_GEN2_HEADER_OFFSET + 3] === 0x01;
    rfhFormat = hasGen2Hdr ? 'gen2' : 'unknown';
    slots = hasGen2Hdr ? RFH_GEN2_SLOTS : [];
    provName = hasGen2Hdr ? `Gen2 slots 0x050E/0x0522 (non-canonical size ${sz} B)` : `Unknown format (${sz} B)`;
  }

  let sec16Bytes = null;
  let provenance = provName;

  if (slots.length > 0 && slots[0] + 16 <= sz) {
    const s1 = bytes.slice(slots[0], slots[0] + 16);
    const s2 = slots.length > 1 && slots[1] + 16 <= sz
      ? bytes.slice(slots[1], slots[1] + 16) : null;
    const virgin = s1.every(b => b === 0xFF) || s1.every(b => b === 0x00);

    if (!virgin) {
      sec16Bytes = new Uint8Array(s1);
      if (s2) {
        const slotsMatch = Array.from(s1).every((b, i) => b === s2[i]);
        provenance = slotsMatch
          ? `${provName} (slots match)`
          : `${provName} (slot 1 used — slots mismatch)`;
      }
    } else {
      provenance = `${provName} — BLANK (all FF/00)`;
    }
  } else if (slots.length === 0) {
    provenance = `${provName} — cannot read SEC16`;
  }

  let state;
  if (!sec16Bytes) {
    /* Distinguish: if format was identifiable but virgin → blank; if truly
     * unknown format or too small → absent (cannot assess) */
    state = (rfhFormat !== 'unknown' && sz >= (isGen1 ? 0x00C2 : 0x0532)) ? 'blank' : 'absent';
  } else {
    state = 'trusted';
  }

  return {
    loaded: true,
    state,
    provenance,
    sec16Bytes,
    sec16Hex: sec16Bytes ? fmtHex(sec16Bytes) : null,
    sec6Bytes: null,
    sec6Hex: null,
    markerHex: null,
    markerOk: false,
    rfhFormat,
  };
}

/* ── PCM (ECM / GPEC2A) triage ──────────────────────────────────────────── */
function triagePcm(bytes) {
  if (!bytes || bytes.length === 0) {
    return {
      loaded: false,
      state: 'absent',
      provenance: 'Not loaded',
      sec16Bytes: null, sec16Hex: null,
      sec6Bytes: null, sec6Hex: null,
      markerHex: null, markerOk: false,
      rfhFormat: null,
    };
  }

  if (bytes.length < 0x3CE) {
    return {
      loaded: true,
      state: 'damaged',
      provenance: `Buffer too small (${bytes.length} B) — need ≥ 0x3CE`,
      sec16Bytes: null, sec16Hex: null,
      sec6Bytes: null, sec6Hex: null,
      markerHex: null, markerOk: false,
      rfhFormat: null,
    };
  }

  const markerBytes = bytes.slice(PCM_SEC6_MARKER_OFFSET, PCM_SEC6_MARKER_OFFSET + 4);
  const sec6Raw = bytes.slice(PCM_SEC6_OFFSET, PCM_SEC6_OFFSET + 6);
  const markerOk = markerBytes[0] === 0xFF && markerBytes[1] === 0xFF &&
    markerBytes[2] === 0xFF && markerBytes[3] === 0xAA;
  const cls = classifyPcmSec6(sec6Raw);

  let state, provenance;
  if (!cls.populated) {
    state = 'damaged';
    provenance = markerOk
      ? `Marker OK but SEC6 ${cls.label} at 0x3C8`
      : `Marker ${fmtHex(markerBytes)} at 0x3C4 — SEC6 ${cls.label} at 0x3C8`;
  } else if (markerOk) {
    state = 'trusted';
    provenance = 'Marker FF FF FF AA · SEC6 populated';
  } else {
    state = 'damaged';
    provenance = `Marker ${fmtHex(markerBytes)} at 0x3C4 (expected FF FF FF AA) — SEC6 populated but unpaired`;
  }

  return {
    loaded: true,
    state,
    provenance,
    sec16Bytes: null,
    sec16Hex: null,
    sec6Bytes: cls.populated ? new Uint8Array(sec6Raw) : null,
    sec6Hex: cls.populated ? fmtHex(sec6Raw) : null,
    markerHex: fmtHex(markerBytes),
    markerOk,
    rfhFormat: null,
  };
}

/* ── Public entry point ─────────────────────────────────────────────────── */
export function triageModuleSet({ bcm, rfhub, pcm } = {}) {
  return {
    bcm: triageBcm(bcm),
    rfhub: triageRfhub(rfhub),
    pcm: triagePcm(pcm),
  };
}
