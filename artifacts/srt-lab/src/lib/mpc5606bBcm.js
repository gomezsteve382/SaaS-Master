/* ============================================================================
 * mpc5606bBcm.js — Task #689
 *
 * Self-contained parser + classifier + writer for 64 KB MPC5606B-class BCM
 * DFLASH dumps, used by the standalone "Immo BCM 56xB" tab. The full BCM
 * inspector (BcmTab / ImmoVINTab) covers a much wider matrix (anonymizer
 * leak scan, Mismatch Wizard, PCM/RFH pairing, etc.) — this helper is
 * intentionally limited to the Insert → Inspect → Apply round-trip the
 * user requested:
 *
 *   1. Scan the canonical (0x5320..0x5380) and alternate (0x1320..0x1380)
 *      VIN base zones at both layouts (base+0 legacy, base+8 Redeye
 *      2020+) and report which slots actually verify (CRC-16/CCITT-FALSE
 *      over the 17 VIN bytes, BE at +17/+18).
 *   2. Resolve the BCM SEC16 secret across the four canonical sources
 *      (split records at 0x81A0/C0/E0, inactive-bank mirror1 [slot 0xEB
 *      size 0x18], inactive-bank mirror2 [slot 0xCA size 0x28], legacy
 *      flat slice at 0x40C9) with provenance + per-source status so the
 *      tab can render "main + mirrors" with per-row detection state.
 *   3. Classify the dump into one of three modes:
 *        FULL      — every populated VIN slot verifies, all verified
 *                    slots agree on the same VIN, AND SEC16 is populated
 *                    in at least one of split / mirror1 / mirror2 / flat.
 *        VIN_ONLY  — VIN slots verify and agree, but SEC16 is blank
 *                    across every candidate source.
 *        LOCKED    — no verified VIN slot, OR populated slots failed
 *                    CRC, OR verified slots disagree on the VIN. The
 *                    apply path refuses to write LOCKED dumps.
 *   4. Apply a new VIN (+ optional SEC16, FULL only) by re-stamping every
 *      verified slot in-place — never invents slots, never moves data —
 *      and re-computing the trailing CRC. The SEC16 write reuses the
 *      battle-tested `writeBcmSec16Gen2()` helper from `securityBytes.js`
 *      so split records and inactive-bank mirrors stay in lock-step with
 *      the rest of SRT Lab.
 *
 * File-in / file-out only. No network, no UDS, no live ECU access.
 * ============================================================================ */

import { crc16 } from './crc.js';
import { writeBcmSec16Gen2 } from './securityBytes.js';

export const MPC5606B_CANONICAL_BASES = [0x5320, 0x5340, 0x5360, 0x5380];
export const MPC5606B_ALT_BASES       = [0x1320, 0x1340, 0x1360, 0x1380];
export const MPC5606B_EXPECTED_SIZES  = [65536, 131072];

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function isPrintableVin(bytes) {
  if (bytes.length !== 17) return false;
  let s = '';
  for (let i = 0; i < 17; i++) {
    const b = bytes[i];
    if (b < 0x30 || b > 0x5A) return false;
    s += String.fromCharCode(b);
  }
  return VIN_RE.test(s);
}

function asciiOf(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function readSlot(data, vinOff) {
  if (vinOff + 19 > data.length) return null;
  const vinBytes = data.slice(vinOff, vinOff + 17);
  if (!isPrintableVin(vinBytes)) return null;
  const storedCrc   = (data[vinOff + 17] << 8) | data[vinOff + 18];
  const computedCrc = crc16(vinBytes);
  return {
    vinOffset:   vinOff,
    vin:         asciiOf(vinBytes),
    storedCrc,
    computedCrc,
    crcOk:       storedCrc === computedCrc,
  };
}

/* Discover every populated VIN slot across both zones and both layouts.
 * Each entry records the discovered `vinOffset` so the apply path can
 * re-stamp the new VIN at exactly the same offset that was originally
 * populated — we never invent a slot. */
export function findMpc5606bVinSlots(data) {
  const slots = [];
  const tryBase = (base, zone) => {
    for (const layout of [{ name: 'base+0', vinOff: base },
                          { name: 'base+8', vinOff: base + 8 }]) {
      const slot = readSlot(data, layout.vinOff);
      if (slot) slots.push({ ...slot, base, zone, layout: layout.name });
    }
  };
  for (const b of MPC5606B_CANONICAL_BASES) tryBase(b, 'canonical');
  for (const b of MPC5606B_ALT_BASES)       tryBase(b, 'alternate');
  return slots;
}

function isBlank16(b) {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0xFF && b[i] !== 0x00) return false;
  return true;
}

/* Resolve the BCM SEC16 secret across the four canonical sources, using
 * the same priority order as `resolveBcmSec16()` in parseModule.js
 * (split → mirror1 → mirror2 → flat). Returns per-source candidates so
 * the tab can render the SEC16 main + mirrors with detection status,
 * not just the chosen winner. */
export function resolveMpc5606bSec16(data) {
  const sz = data.length;
  const candidates = { split: null, mirror1: null, mirror2: null, flat: null };
  let inactiveBase = null;

  /* split records at 0x81A0/C0/E0 — picks the first record whose header
   * passes the same gates the parseModule resolver uses, then checks that
   * every passing record agrees on the same 16 bytes (mirror parseModule
   * 'consistent' field). */
  if (sz >= 0x8200) {
    const reads = [];
    for (const off of [0x81A0, 0x81C0, 0x81E0]) {
      if (data[off] !== 0xFF || data[off + 1] !== 0xFF) continue;
      let hdrOk = true;
      for (let j = 2; j < 8; j++) if (data[off + j] !== 0x00) { hdrOk = false; break; }
      if (!hdrOk) continue;
      const idx = data[off + 8];
      if (idx !== 0x01 && idx !== 0x02) continue;
      if (data[off + 16] !== 0x04 || data[off + 17] !== 0x04 ||
          data[off + 18] !== 0x00 || data[off + 19] !== 0x14) continue;
      const sec = new Uint8Array(16);
      for (let k = 0; k < 7; k++) sec[k]     = data[off + 9 + k];
      for (let k = 0; k < 9; k++) sec[7 + k] = data[off + 20 + k];
      reads.push({ offset: off, bytes: sec });
    }
    if (reads.length > 0) {
      const first = reads[0].bytes;
      let consistent = true;
      for (const r of reads) {
        for (let i = 0; i < 16; i++) if (r.bytes[i] !== first[i]) { consistent = false; break; }
        if (!consistent) break;
      }
      candidates.split = {
        offset: reads[0].offset, bytes: first, blank: isBlank16(first),
        recordCount: reads.length, consistent,
      };
    }
  }

  /* mirror records in inactive bank — same record-header signature used
   * by parseModule.js#resolveBcmSec16 and the writer in
   * securityBytes.js#writeBcmSec16Gen2. */
  if (sz >= 0x4004) {
    const bank0Seq = (data[0x0002] << 8) | data[0x0003];
    const bank1Seq = (data[0x4002] << 8) | data[0x4003];
    inactiveBase = bank0Seq >= bank1Seq ? 0x4000 : 0x0000;
    const findRec = (base, slotType, sizeByte) => {
      const end = Math.min(sz, base + 0x4000) - 8;
      for (let i = base; i < end; i++) {
        if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x00 &&
            data[i + 3] === sizeByte && data[i + 4] === 0x00 && data[i + 5] === 0x46 &&
            data[i + 6] === slotType && data[i + 7] === 0x00) return i;
      }
      return -1;
    };
    const m1 = findRec(inactiveBase, 0xEB, 0x18);
    if (m1 >= 0 && m1 + 25 <= sz) {
      const sec = new Uint8Array(data.slice(m1 + 9, m1 + 25));
      candidates.mirror1 = { offset: m1, bytes: sec, blank: isBlank16(sec) };
    }
    const m2 = findRec(inactiveBase, 0xCA, 0x28);
    if (m2 >= 0 && m2 + 25 <= sz) {
      const sec = new Uint8Array(data.slice(m2 + 9, m2 + 25));
      candidates.mirror2 = { offset: m2, bytes: sec, blank: isBlank16(sec) };
    }
  }

  /* legacy flat slice fallback at 0x40C9 */
  if (sz >= 0x40D9) {
    const sec = new Uint8Array(data.slice(0x40C9, 0x40D9));
    candidates.flat = { offset: 0x40C9, bytes: sec, blank: isBlank16(sec) };
  }

  /* pick winner: first non-blank in priority order. */
  let chosen = null, source = null;
  for (const key of ['split', 'mirror1', 'mirror2', 'flat']) {
    const c = candidates[key];
    if (c && !c.blank) { chosen = c; source = key; break; }
  }
  const allBlank =
    (!candidates.split    || candidates.split.blank) &&
    (!candidates.mirror1  || candidates.mirror1.blank) &&
    (!candidates.mirror2  || candidates.mirror2.blank) &&
    (!candidates.flat     || candidates.flat.blank);
  if (!chosen) {
    /* surface the first-existing candidate so the tab still has bytes
     * to print, while reporting blank. */
    for (const key of ['split', 'mirror1', 'mirror2', 'flat']) {
      if (candidates[key]) { chosen = candidates[key]; source = key; break; }
    }
  }

  return {
    bytes:        chosen ? new Uint8Array(chosen.bytes) : null,
    offset:       chosen ? chosen.offset : null,
    source:       chosen ? source : null,
    blank:        chosen ? (allBlank ? true : !!chosen.blank) : true,
    inactiveBase,
    candidates,
  };
}

/* Top-level parser + mode classifier. Always returns a result object;
 * never throws on bad input. The `mode` field is the user-facing
 * verdict — `reasons` is an ordered list of plain-language strings the
 * tab renders directly underneath the mode badge so the tech can see
 * exactly why the file was classified the way it was.
 *
 * LOCKED rules (any of these flips the mode to LOCKED, regardless of
 * how many slots otherwise look fine):
 *   - Empty buffer.
 *   - Zero verified VIN slots.
 *   - At least one slot has a printable VIN but a failing CRC
 *     (corrupted / encrypted / wrong-module mix).
 *   - Verified slots disagree on the VIN (cross-contaminated dump). */
export function parseMpc5606bBcm(data) {
  if (!data || data.length === 0) {
    return {
      ok: false, mode: 'LOCKED', size: 0, sizeOk: false,
      slots: [], validSlots: [], dominantVin: null,
      sec16: resolveMpc5606bSec16(new Uint8Array(0)),
      reasons: ['Empty buffer — nothing to inspect.'],
    };
  }
  const sizeOk     = MPC5606B_EXPECTED_SIZES.includes(data.length);
  const slots      = findMpc5606bVinSlots(data);
  const validSlots = slots.filter(s => s.crcOk);
  const sec16      = resolveMpc5606bSec16(data);
  const reasons    = [];

  if (!sizeOk) {
    reasons.push(
      `Unexpected file size (${data.length.toLocaleString()} B). Expected ` +
      MPC5606B_EXPECTED_SIZES.map(n => n.toLocaleString() + ' B').join(' or ') +
      ' for an MPC5606B-class BCM DFLASH dump.',
    );
  }

  /* Dominant VIN + inconsistency detection. */
  let dominantVin = null;
  let vinInconsistent = false;
  if (validSlots.length > 0) {
    const tally = new Map();
    for (const s of validSlots) tally.set(s.vin, (tally.get(s.vin) || 0) + 1);
    let best = null, bestCount = 0;
    for (const [vin, count] of tally) {
      if (count > bestCount) { best = vin; bestCount = count; }
    }
    dominantVin = best;
    if (tally.size > 1) {
      vinInconsistent = true;
      const list = Array.from(tally.entries())
        .map(([v, c]) => `${v} (${c}×)`).join(', ');
      reasons.push(`Verified VIN slots disagree: ${list}. Refusing to pick a winner.`);
    }
  }

  const crcFails = slots.filter(s => !s.crcOk);
  if (crcFails.length > 0) {
    reasons.push(
      `${crcFails.length} populated VIN slot(s) failed CRC — first failing offset ` +
      `0x${crcFails[0].vinOffset.toString(16).toUpperCase()}.`,
    );
  }

  /* Mode decision — any LOCKED trigger short-circuits. */
  let mode;
  if (validSlots.length === 0) {
    mode = 'LOCKED';
    if (slots.length === 0) {
      reasons.unshift('No printable VIN found in any canonical or alternate slot.');
    } else {
      reasons.unshift(
        `Found ${slots.length} printable VIN candidate(s) but none with a valid CRC — ` +
        `the dump is encrypted, corrupted, or from a module family this lab doesn't yet decode.`,
      );
    }
  } else if (vinInconsistent) {
    mode = 'LOCKED';
    reasons.unshift(
      'Verified VIN copies are inconsistent — write path refuses to re-stamp a mixed dump.',
    );
  } else if (crcFails.length > 0) {
    mode = 'LOCKED';
    reasons.unshift(
      'At least one populated VIN slot fails CRC — write path refuses to re-stamp until the dump is clean.',
    );
  } else if (sec16.bytes && !sec16.blank) {
    mode = 'FULL';
    reasons.unshift(
      `${validSlots.length} VIN slot(s) verified and SEC16 secret resolved from ${sec16.source} ` +
      `record at offset 0x${sec16.offset.toString(16).toUpperCase()}.`,
    );
  } else {
    mode = 'VIN_ONLY';
    reasons.unshift(
      `${validSlots.length} VIN slot(s) verified. ` +
      `SEC16 secret is blank across every candidate source — this is a VIN-only dump ` +
      `(RFHUB/PCM pairing not yet performed).`,
    );
  }

  return {
    ok: true, mode, size: data.length, sizeOk,
    slots, validSlots, dominantVin, sec16, reasons,
  };
}

/* Re-stamp every verified VIN slot to `newVin` (preserving each slot's
 * discovered layout / offset) and re-compute the trailing CRC. When the
 * dump was classified as FULL the caller may also pass `sec16Hex` (32
 * hex chars = 16 bytes, displayed in BCM order — the same order the
 * inspector prints) to update the SEC16 secret across split records and
 * the inactive-bank mirrors via the canonical writer.
 *
 * Refuses LOCKED dumps and refuses SEC16 writes unless mode is FULL. */
export function applyMpc5606bBcm(data, parsed, { newVin, newSec16Hex } = {}) {
  if (!parsed || !parsed.ok) {
    throw new Error('applyMpc5606bBcm: parse result is invalid.');
  }
  if (parsed.mode === 'LOCKED') {
    throw new Error('Refusing to write: dump is LOCKED — no verifiable VIN anchor.');
  }
  if (typeof newVin !== 'string' || !VIN_RE.test(newVin)) {
    throw new Error('VIN must be 17 valid characters (A-HJ-NPR-Z0-9).');
  }
  const out = new Uint8Array(data);
  const vinBytes = new Uint8Array(17);
  for (let i = 0; i < 17; i++) vinBytes[i] = newVin.charCodeAt(i);
  const vinCrc = crc16(vinBytes);
  const updatedSlots = [];
  for (const s of parsed.validSlots) {
    out.set(vinBytes, s.vinOffset);
    out[s.vinOffset + 17] = (vinCrc >> 8) & 0xFF;
    out[s.vinOffset + 18] = vinCrc & 0xFF;
    updatedSlots.push({ vinOffset: s.vinOffset, zone: s.zone, layout: s.layout });
  }

  let sec16Result = null;
  if (newSec16Hex != null && newSec16Hex !== '') {
    if (parsed.mode !== 'FULL') {
      throw new Error('Refusing to write SEC16: dump is not FULL mode.');
    }
    const clean = String(newSec16Hex).replace(/\s+/g, '');
    if (!/^[0-9A-Fa-f]{32}$/.test(clean)) {
      throw new Error('SEC16 must be exactly 32 hex characters (16 bytes).');
    }
    const bcmSec16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bcmSec16[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    /* writeBcmSec16Gen2 takes the RFHUB-side SEC16 (BCM stores the
     * byte-reversed form). The tab collects 32 hex in BCM display
     * order, so we reverse here before handing off. */
    const rfhSec16 = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rfhSec16[i] = bcmSec16[15 - i];
    const r = writeBcmSec16Gen2(out, rfhSec16);
    out.set(r.bytes);
    sec16Result = {
      splitPatched:    r.splitPatched,
      mirrorPatched:   r.mirrorPatched,
      mirror1Offset:   r.mirror1Offset,
      mirror2Offset:   r.mirror2Offset,
      bcmSec16Hex:     r.bcmSec16Hex,
    };
  }

  return { bytes: out, newVin, vinCrc, updatedSlots, sec16: sec16Result };
}
