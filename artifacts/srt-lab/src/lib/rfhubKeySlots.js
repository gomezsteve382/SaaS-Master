/* ============================================================================
 * rfhubKeySlots.js — pure (no React) helpers for the dual-file RFHub Key
 * Manager tab (Task #407). Models the FreshAuto RFHub Key Manager v6 flow:
 * load File A (source) and File B (target), then transfer / delete / add
 * fob slots between them and download CRC-recomputed patched bins.
 *
 * ┌─────────────────────────── LAYOUT HONESTY ──────────────────────────────┐
 * │  CONFIRMED in this codebase (read by parseModule.js, golden-tested):    │
 * │    • Gen2 (4 KB / 24C32) AA-50 occupancy markers @ 0x0880 stride 2,     │
 * │      up to 4 slots — each present slot writes the bytes AA 50.          │
 * │    • Gen1 (2 KB / 24C16) AA-50 markers @ 0x0880 stride 2 (same layout). │
 * │    • Master transponder = SEC16 raw 16 B + 2 B CS.                      │
 * │        Gen2 slot 1 @ 0x050E, slot 2 @ 0x0522 — CS = (crc8_65<<8)|0x00.  │
 * │        Gen1 slot 1 @ 0x00AE, slot 2 @ 0x00C0 — CS formula NOT verified, │
 * │          so Gen1 master writes preserve the slot 2 mirror byte-for-byte │
 * │          (no recompute). Round-trip is safe; CS just stays whatever     │
 * │          the source dump carried.                                       │
 * │                                                                         │
 * │  NOT CONFIRMED (and therefore not edited by this module):               │
 * │    • Per-slot Autel/H8/megamos transponder ID byte block. Where the     │
 * │      48-bit (or 64-bit) per-fob transponder ID actually lives inside an │
 * │      RFHUB image is not currently reverse-engineered in this codebase.  │
 * │      The PCM-side 4×4 transponder array at 0x0888 (parseModule.js:471)  │
 * │      belongs to the GPEC2A pair, not the RFHUB itself.                  │
 * │                                                                         │
 * │  Consequences:                                                          │
 * │    • transferSlot / deleteSlot / addSlot operate on the AA-50 OCCUPANCY │
 * │      MARKER ONLY. That is enough to mark a fob slot present / empty —   │
 * │      the same byte the module reads to count programmed fobs — but it   │
 * │      does NOT carry the per-fob transponder ID across files.            │
 * │    • Each pane in the UI surfaces a banner explaining this so a         │
 * │      locksmith does not assume a "transferred" slot will start a car    │
 * │      until the per-slot ID layout is mapped (follow-up task).           │
 * │    • copyMasterSec16 IS a complete, golden-tested transfer for the      │
 * │      vehicle/master secret.                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Every mutation returns { ok, bytes, ... } so the UI can mirror the
 * Task #399 refusal pattern (writer returns ok:false → UI logs RED
 * "KEYMOD REFUSED" and skips the download).
 * ============================================================================ */

import { rfhSec16Cs } from './crc.js';

export const KEY_SLOT_COUNT = 4;
export const AA50_BASE = 0x0880;
export const AA50_STRIDE = 2;

// SEC16 (master transponder secret) offsets per generation.
const SEC16_OFFSETS_GEN2 = [0x050E, 0x0522];
const SEC16_OFFSETS_GEN1 = [0x00AE, 0x00C0];

// Gen2 RFHUB header signature — verified at 0x0500 by writeRfhSec16FromBcm
// (lib/securityBytes.js). Required so a random 4 KB / 8 KB buffer that
// happens to match a canonical size cannot slip through this module's
// mutation paths and corrupt unrelated images. (Architect review #1.)
const GEN2_HEADER_SIG = [0xAA, 0x55, 0x31, 0x01];
const GEN2_HEADER_OFFSET = 0x0500;

function hasGen2Header(bytes) {
  if (!bytes || bytes.length < GEN2_HEADER_OFFSET + GEN2_HEADER_SIG.length) return false;
  for (let i = 0; i < GEN2_HEADER_SIG.length; i++) {
    if (bytes[GEN2_HEADER_OFFSET + i] !== GEN2_HEADER_SIG[i]) return false;
  }
  return true;
}

export function detectGen(bytes) {
  const sz = bytes?.length || 0;
  if (sz === 4096 || sz === 8192) return 'gen2';
  if (sz === 2048) return 'gen1';
  return 'unknown';
}

export function isRfhubBuffer(bytes) {
  return detectGen(bytes) !== 'unknown';
}

// Per-gen slot-mutation capability gate (Architect review #1):
//   Gen2 → AA-50 markers @ 0x0880 stride 2 are confirmed in this codebase
//          (parseModule.js#countAA50, fixture buildFixtures.js).
//   Gen1 → AA-50 marker offset is NOT confirmed within a 2 KB image. The
//          0x0880 base lives past the end of a 24C16 (2048 B = 0x800), so
//          slot mutation cannot succeed and is gated off entirely. The
//          master-SEC16 copy still works (0x00AE / 0x00C0 are confirmed).
export function slotsEditableFor(gen) {
  return gen === 'gen2';
}

export function sec16OffsetsFor(gen) {
  if (gen === 'gen2') return SEC16_OFFSETS_GEN2.slice();
  if (gen === 'gen1') return SEC16_OFFSETS_GEN1.slice();
  return [];
}

/* parseKeySlots(bytes) → { ok, gen, slots, sec16, error }
 *   slots: [{ idx, markerOffset, occupied, raw:Uint8Array(2),
 *             idBytes: null,  // layout not yet mapped — see header
 *             idMapped: false }]
 *   sec16: { offsets:[...], slot1:{raw,csStored,csCalc,csOk}, slot2:{...},
 *            match:bool, gen }
 */
export function parseKeySlots(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array)) {
    return { ok: false, error: 'no buffer', slots: [], gen: 'unknown', sec16: null };
  }
  const gen = detectGen(bytes);
  if (gen === 'unknown') {
    return { ok: false, error: 'Not a recognized RFHUB image (need 2048 / 4096 / 8192 B)', slots: [], gen, sec16: null };
  }
  const slots = [];
  for (let i = 0; i < KEY_SLOT_COUNT; i++) {
    const off = AA50_BASE + i * AA50_STRIDE;
    if (off + 2 > bytes.length) break;
    const raw = bytes.slice(off, off + 2);
    const occupied = raw[0] === 0xAA && raw[1] === 0x50;
    slots.push({
      idx: i,
      markerOffset: off,
      occupied,
      raw,
      idBytes: null,
      idMapped: false,
    });
  }
  const sec16Offsets = sec16OffsetsFor(gen);
  const sec16Slots = sec16Offsets.map((off, idx) => {
    if (off + 18 > bytes.length) return null;
    const raw = bytes.slice(off, off + 16);
    const csStored = (bytes[off + 16] << 8) | bytes[off + 17];
    let csCalc; let csOk;
    if (gen === 'gen2') { csCalc = rfhSec16Cs(raw); csOk = csCalc === csStored; }
    return { slot: idx + 1, offset: off, raw, csStored, csCalc, csOk };
  }).filter(Boolean);
  let match = false;
  if (sec16Slots.length === 2) {
    match = true;
    for (let k = 0; k < 16; k++) if (sec16Slots[0].raw[k] !== sec16Slots[1].raw[k]) { match = false; break; }
  }
  return {
    ok: true,
    gen,
    slots,
    sec16: { offsets: sec16Offsets, slots: sec16Slots, match, gen },
  };
}

function clone(bytes) { return new Uint8Array(bytes); }

function checkRfhub(bytes, label) {
  if (!bytes || !(bytes instanceof Uint8Array)) {
    return { ok: false, error: `${label}: missing buffer` };
  }
  const gen = detectGen(bytes);
  if (gen === 'unknown') return { ok: false, error: `${label}: not a recognized RFHUB image (size ${bytes.length})` };
  // Gen2: require the AA 55 31 01 header at 0x0500. Without it, a 4 KB or
  // 8 KB buffer of unrelated origin (e.g. another module dumped at the
  // same canonical size) could be silently mutated. (Architect review #1.)
  if (gen === 'gen2' && !hasGen2Header(bytes)) {
    return { ok: false, error: `${label}: Gen2 RFHUB header (AA 55 31 01 @ 0x0500) missing — refusing to write` };
  }
  return { ok: true, gen };
}

/* Same gate, but for slot-level mutations: also refuses Gen1 because the
 * AA-50 marker offset for the Gen1 24C16 layout is not yet confirmed. */
function checkRfhubForSlotEdit(bytes, label) {
  const c = checkRfhub(bytes, label);
  if (!c.ok) return c;
  if (!slotsEditableFor(c.gen)) {
    return { ok: false, error: `${label}: slot editing not supported for ${c.gen} (AA-50 marker offset unconfirmed for this layout)` };
  }
  return c;
}

function checkSlotIdx(idx, label) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= KEY_SLOT_COUNT) {
    return { ok: false, error: `${label}: slot index ${idx} out of range (0..${KEY_SLOT_COUNT - 1})` };
  }
  return { ok: true };
}

/* deleteSlot(bytes, idx) — clear the AA-50 occupancy marker so the module
 * sees the slot as empty. Idempotent: deleting an already-empty slot
 * returns ok:true with patched=0. */
export function deleteSlot(bytes, idx) {
  const c = checkRfhubForSlotEdit(bytes, 'deleteSlot'); if (!c.ok) return { ok: false, error: c.error };
  const s = checkSlotIdx(idx, 'deleteSlot'); if (!s.ok) return { ok: false, error: s.error };
  const out = clone(bytes);
  const off = AA50_BASE + idx * AA50_STRIDE;
  if (off + 2 > out.length) return { ok: false, error: `deleteSlot: slot offset 0x${off.toString(16)} past EOF` };
  const wasOccupied = out[off] === 0xAA && out[off + 1] === 0x50;
  out[off] = 0xFF;
  out[off + 1] = 0xFF;
  return { ok: true, bytes: out, patched: wasOccupied ? 1 : 0, slotIdx: idx, markerOffset: off };
}

/* addSlot(bytes, idx) — write AA 50 to mark a slot occupied. Refuses if
 * the slot is already occupied (caller should pick a free slot first). */
export function addSlot(bytes, idx) {
  const c = checkRfhubForSlotEdit(bytes, 'addSlot'); if (!c.ok) return { ok: false, error: c.error };
  const s = checkSlotIdx(idx, 'addSlot'); if (!s.ok) return { ok: false, error: s.error };
  const out = clone(bytes);
  const off = AA50_BASE + idx * AA50_STRIDE;
  if (off + 2 > out.length) return { ok: false, error: `addSlot: slot offset 0x${off.toString(16)} past EOF` };
  if (out[off] === 0xAA && out[off + 1] === 0x50) {
    return { ok: false, error: `addSlot: slot ${idx} already occupied at 0x${off.toString(16)}`, alreadyOccupied: true };
  }
  out[off] = 0xAA;
  out[off + 1] = 0x50;
  return { ok: true, bytes: out, patched: 1, slotIdx: idx, markerOffset: off };
}

/* transferSlot(srcBytes, dstBytes, srcIdx, dstIdx) — copy AA-50 occupancy
 * state from src[srcIdx] → dst[dstIdx]. Refuses if generations differ
 * (Gen1↔Gen2 mixing not supported until per-slot ID layout is mapped).
 * Returns the patched dst buffer; src is left untouched. */
export function transferSlot(srcBytes, dstBytes, srcIdx, dstIdx) {
  const cs = checkRfhubForSlotEdit(srcBytes, 'transferSlot src'); if (!cs.ok) return { ok: false, error: cs.error };
  const cd = checkRfhubForSlotEdit(dstBytes, 'transferSlot dst'); if (!cd.ok) return { ok: false, error: cd.error };
  if (cs.gen !== cd.gen) {
    return { ok: false, error: `transferSlot: generation mismatch (src=${cs.gen}, dst=${cd.gen})` };
  }
  const ss = checkSlotIdx(srcIdx, 'transferSlot src'); if (!ss.ok) return { ok: false, error: ss.error };
  const ds = checkSlotIdx(dstIdx, 'transferSlot dst'); if (!ds.ok) return { ok: false, error: ds.error };
  const sOff = AA50_BASE + srcIdx * AA50_STRIDE;
  const dOff = AA50_BASE + dstIdx * AA50_STRIDE;
  if (sOff + 2 > srcBytes.length) return { ok: false, error: `transferSlot: src slot past EOF` };
  if (dOff + 2 > dstBytes.length) return { ok: false, error: `transferSlot: dst slot past EOF` };
  const out = clone(dstBytes);
  out[dOff] = srcBytes[sOff];
  out[dOff + 1] = srcBytes[sOff + 1];
  return {
    ok: true,
    bytes: out,
    patched: 1,
    srcIdx, dstIdx,
    srcOffset: sOff, dstOffset: dOff,
    occupiedAfter: out[dOff] === 0xAA && out[dOff + 1] === 0x50,
    /* Layout caveat — the AA-50 marker is the only confirmed per-slot
     * artifact; per-fob transponder ID bytes are not carried. */
    idTransferred: false,
  };
}

/* copyMasterSec16(srcBytes, dstBytes) — copy the master transponder
 * secret (16 B SEC16) from src into both SEC16 slots of dst, recomputing
 * the Gen2 CS. For Gen1 we cannot recompute (CS formula unverified) so
 * we only proceed when the source carries a valid Gen1 SEC16 raw and we
 * preserve the existing CS bytes from src (round-trip safe across mirror
 * pairs — same CS for same raw). */
export function copyMasterSec16(srcBytes, dstBytes) {
  const cs = checkRfhub(srcBytes, 'copyMasterSec16 src'); if (!cs.ok) return { ok: false, error: cs.error };
  const cd = checkRfhub(dstBytes, 'copyMasterSec16 dst'); if (!cd.ok) return { ok: false, error: cd.error };
  if (cs.gen !== cd.gen) return { ok: false, error: `copyMasterSec16: generation mismatch (src=${cs.gen}, dst=${cd.gen})` };
  const offs = sec16OffsetsFor(cs.gen);
  if (offs.length === 0) return { ok: false, error: 'copyMasterSec16: no SEC16 offsets for gen' };
  // Pick the first non-blank slot on src as canonical.
  let srcRaw = null; let srcCs = null;
  for (const off of offs) {
    if (off + 18 > srcBytes.length) continue;
    const raw = srcBytes.slice(off, off + 16);
    const blank = raw.every(b => b === 0xFF || b === 0x00);
    if (!blank) {
      srcRaw = raw;
      srcCs = (srcBytes[off + 16] << 8) | srcBytes[off + 17];
      break;
    }
  }
  if (!srcRaw) return { ok: false, error: 'copyMasterSec16: src has no populated SEC16 slot' };
  const out = clone(dstBytes);
  let patched = 0;
  for (const off of offs) {
    if (off + 18 > out.length) continue;
    for (let k = 0; k < 16; k++) out[off + k] = srcRaw[k];
    if (cs.gen === 'gen2') {
      const calc = rfhSec16Cs(srcRaw);
      out[off + 16] = (calc >>> 8) & 0xFF;
      out[off + 17] = calc & 0xFF;
    } else {
      // Gen1: preserve the source CS bytes (formula unverified — see header).
      out[off + 16] = (srcCs >>> 8) & 0xFF;
      out[off + 17] = srcCs & 0xFF;
    }
    patched++;
  }
  return { ok: true, bytes: out, patched, gen: cs.gen };
}

/* firstFreeSlot(bytes) → idx | -1 */
export function firstFreeSlot(bytes) {
  const p = parseKeySlots(bytes);
  if (!p.ok) return -1;
  for (const s of p.slots) if (!s.occupied) return s.idx;
  return -1;
}
