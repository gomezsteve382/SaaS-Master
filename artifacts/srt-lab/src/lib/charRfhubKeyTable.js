/* ============================================================================
 * charRfhubKeyTable.js — pure (no React) helpers for the offline transponder
 * key table found in MPC-based Charger/Challenger RFHUB 4 KB EEPROM dumps.
 *
 * This is a DIFFERENT layout from rfhubKeySlots.js (which models the FreshAuto
 * Gen1/Gen2 AA-50 marker tables at 0x00D2 / 0x0880). On the 2019 Charger
 * (VIN 2C3CDXL92KH674464 reference set) the working transponder keys live in
 * an 8-slot table at 0xC5E:
 *
 *   ┌─────────────────────────── LAYOUT (observed) ──────────────────────────┐
 *   │  Base 0xC5E, 8 slots, stride 16 bytes. Each slot is a 6-byte record    │
 *   │  written TWICE (mirror) with FF FF separators:                         │
 *   │     [rec 6B] FF FF [rec 6B] FF FF                                       │
 *   │  Record = [UID 4B, byte-reversed][index low 1B][flag 1B].              │
 *   │     • UID stored = byte-reverse of the Autel "Key ID"                  │
 *   │         (Key ID 0077A29B  ->  9B A2 77 00).                            │
 *   │     • flag byte 0x01 = key present.                                     │
 *   │     • EMPTY slot template = 5A 5A 5A 5A 95 00 (flag 0x00).             │
 *   │  Reference car: 6 keys in slots 3..8, slots 1..2 empty.                │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────── HONESTY / RISK ─────────────────────────────┐
 *   │  • NO checksum covers this region: editing the 4 VIN copies in an      │
 *   │    immovin VIN-applied dump changed ONLY the VIN bytes — no checksum   │
 *   │    byte moved anywhere — so a key-table edit needs no CS recompute.    │
 *   │  • The per-key INDEX LOW byte is firmware-assigned and could NOT be    │
 *   │    derived from the UID (exhaustive sum/xor/CRC8 sweep failed) and is  │
 *   │    not a pointer. Because every key on these cars shares the MIKRON    │
 *   │    default secret, the immobilizer must match on UID, not the index —  │
 *   │    so the index is treated as a stored handle. This is REASONED, not   │
 *   │    bench-verified: a wrong index can only make the car reject THAT key │
 *   │    (other keys keep working; reflash the original to recover). It      │
 *   │    cannot brick the immobilizer because SEC16 and checksums are        │
 *   │    untouched. Default index 0x95 (reuses the empty-slot low byte).     │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

export const CHAR_KEYTABLE_BASE = 0x0C5E;
export const CHAR_KEYTABLE_SLOTS = 8;
export const CHAR_KEYTABLE_STRIDE = 16;
export const CHAR_KEY_RECLEN = 6;
export const CHAR_KEY_MIRROR_OFFSET = 8;
export const CHAR_KEY_FLAG_PRESENT = 0x01;
export const CHAR_KEY_DEFAULT_INDEX = 0x95;
// Empty-slot template: 5A 5A 5A 5A 95 00
export const CHAR_EMPTY_TEMPLATE = [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00];
const CANONICAL_SIZE = 4096;

function clone(bytes) { return new Uint8Array(bytes); }

function slotOffset(i) { return CHAR_KEYTABLE_BASE + i * CHAR_KEYTABLE_STRIDE; }

function recordsMatch(bytes, a, b) {
  for (let k = 0; k < CHAR_KEY_RECLEN; k++) if (bytes[a + k] !== bytes[b + k]) return false;
  return true;
}

function hasFFSep(bytes, off) {
  return bytes[off + CHAR_KEY_RECLEN] === 0xFF && bytes[off + CHAR_KEY_RECLEN + 1] === 0xFF
    && bytes[off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN] === 0xFF
    && bytes[off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN + 1] === 0xFF;
}

/* classifySlot(bytes, off) → 'empty' | 'key' | 'unknown'
 *   'empty'   — EXACTLY the canonical empty template (5A 5A 5A 5A 95 00).
 *   'key'     — flag byte == 0x01 (a present transponder key).
 *   'unknown' — anything else. Fail-closed: an unknown record is NEVER
 *               treated as a free slot and is included in the duplicate /
 *               index-collision checks, so addCharKey refuses to overwrite
 *               or clash with a state this tool does not understand. */
function classifySlot(bytes, off) {
  const isTemplate =
    bytes[off] === CHAR_EMPTY_TEMPLATE[0] && bytes[off + 1] === CHAR_EMPTY_TEMPLATE[1] &&
    bytes[off + 2] === CHAR_EMPTY_TEMPLATE[2] && bytes[off + 3] === CHAR_EMPTY_TEMPLATE[3] &&
    bytes[off + 4] === CHAR_EMPTY_TEMPLATE[4] && bytes[off + 5] === CHAR_EMPTY_TEMPLATE[5];
  if (isTemplate) return 'empty';
  if (bytes[off + CHAR_KEY_RECLEN - 1] === CHAR_KEY_FLAG_PRESENT) return 'key';
  return 'unknown';
}

/** keyIdToRevUid('BCD2EB9B') -> Uint8Array [0x9B,0xEB,0xD2,0xBC] (stored order). */
export function keyIdToRevUid(keyId) {
  const h = String(keyId || '').replace(/[^0-9a-fA-F]/g, '');
  if (h.length !== 8) throw new Error(`Key ID must be 8 hex chars (4 bytes); got "${keyId}"`);
  const b = [];
  for (let i = 0; i < 8; i += 2) b.push(parseInt(h.slice(i, i + 2), 16));
  return new Uint8Array(b.reverse());
}

/** revUidToKeyId([0x9B,0xEB,0xD2,0xBC]) -> 'BCD2EB9B' (Autel Key ID order). */
export function revUidToKeyId(rev) {
  return Array.from(rev).slice(0, 4).reverse()
    .map(x => x.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** isCharRfhubKeyTable(bytes) — strict structural gate (won't false-positive on
 *  an unrelated 4 KB image): canonical size + every slot is a mirrored 6-byte
 *  record bracketed by FF FF separators. */
export function isCharRfhubKeyTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CANONICAL_SIZE) return false;
  if (slotOffset(CHAR_KEYTABLE_SLOTS - 1) + CHAR_KEYTABLE_STRIDE > bytes.length) return false;
  for (let i = 0; i < CHAR_KEYTABLE_SLOTS; i++) {
    const off = slotOffset(i);
    if (!hasFFSep(bytes, off)) return false;
    if (!recordsMatch(bytes, off, off + CHAR_KEY_MIRROR_OFFSET)) return false;
  }
  return true;
}

/** parseCharKeyTable(bytes) → { ok, slots, keyCount, error } */
export function parseCharKeyTable(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: 'no buffer', slots: [], keyCount: 0 };
  }
  if (bytes.length !== CANONICAL_SIZE) {
    return { ok: false, error: `Not a 4 KB RFHUB image (got ${bytes.length} B)`, slots: [], keyCount: 0 };
  }
  if (!isCharRfhubKeyTable(bytes)) {
    return { ok: false, error: 'Charger 8-slot key table not found at 0xC5E (mirror/separator check failed)', slots: [], keyCount: 0 };
  }
  const slots = [];
  let keyCount = 0;
  let unknownCount = 0;
  for (let i = 0; i < CHAR_KEYTABLE_SLOTS; i++) {
    const off = slotOffset(i);
    const mirrorOffset = off + CHAR_KEY_MIRROR_OFFSET;
    const raw = bytes.slice(off, off + CHAR_KEY_RECLEN);
    const state = classifySlot(bytes, off);
    const empty = state === 'empty';
    const mirrorOk = recordsMatch(bytes, off, mirrorOffset);
    const keyId = empty ? null : revUidToKeyId(raw);
    const indexLow = raw[4];
    const flag = raw[5];
    if (state === 'key') keyCount++;
    else if (state === 'unknown') unknownCount++;
    slots.push({ slot: i + 1, offset: off, mirrorOffset, empty, state, mirrorOk, keyId, indexLow, flag, raw });
  }
  return { ok: true, slots, keyCount, unknownCount };
}

/** firstFreeCharSlot(bytes) → 0-based slot idx | -1 */
export function firstFreeCharSlot(bytes) {
  const p = parseCharKeyTable(bytes);
  if (!p.ok) return -1;
  for (const s of p.slots) if (s.empty) return s.slot - 1;
  return -1;
}

/* addCharKey(bytes, { keyId, indexLow, slotIdx, allowDuplicate })
 *   Writes a new transponder key record (and its mirror) into a free slot.
 *   Returns { ok, bytes, ... } | { ok:false, error }. The original is never
 *   mutated. No checksum recompute (none covers this region — see header).
 *
 *   Mirrors the module-wide refuse-on-doubt pattern: bad buffer, duplicate
 *   key, full table, index collision, or a non-empty target all halt before
 *   any byte is written. */
export function addCharKey(bytes, { keyId, indexLow = CHAR_KEY_DEFAULT_INDEX, slotIdx = null, allowDuplicate = false } = {}) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: 'addCharKey: missing buffer' };
  if (!isCharRfhubKeyTable(bytes)) {
    return { ok: false, error: 'addCharKey: not a recognized Charger RFHUB key table (refusing to write)' };
  }
  let revUid;
  try { revUid = keyIdToRevUid(keyId); }
  catch (e) { return { ok: false, error: 'addCharKey: ' + (e.message || e) }; }

  if (!Number.isInteger(indexLow) || indexLow < 0 || indexLow > 0xFF) {
    return { ok: false, error: `addCharKey: index byte must be 0..255 (got ${indexLow})` };
  }

  const parsed = parseCharKeyTable(bytes);
  const newKeyId = revUidToKeyId(revUid);

  // Refuse duplicate key (already present in another slot).
  if (!allowDuplicate) {
    const dup = parsed.slots.find(s => !s.empty && s.keyId === newKeyId);
    if (dup) return { ok: false, error: `addCharKey: key ${newKeyId} already present in slot ${dup.slot}`, duplicate: true };
  }

  // Refuse index collision with an existing key (the index is a per-key handle).
  const clash = parsed.slots.find(s => !s.empty && s.indexLow === indexLow);
  if (clash) {
    return { ok: false, error: `addCharKey: index 0x${indexLow.toString(16)} already used by key ${clash.keyId} (slot ${clash.slot}) — choose a different index`, indexClash: true };
  }

  // Resolve target slot.
  let target = slotIdx;
  if (target == null) {
    target = firstFreeCharSlot(bytes);
    if (target < 0) return { ok: false, error: 'addCharKey: key table full (no empty slots)', tableFull: true };
  }
  if (!Number.isInteger(target) || target < 0 || target >= CHAR_KEYTABLE_SLOTS) {
    return { ok: false, error: `addCharKey: slot ${target} out of range (0..${CHAR_KEYTABLE_SLOTS - 1})` };
  }
  if (!parsed.slots[target].empty) {
    const occ = parsed.slots[target];
    const label = occ.state === 'unknown' ? `an unrecognized record (${occ.keyId})` : `key ${occ.keyId}`;
    return { ok: false, error: `addCharKey: slot ${target + 1} is occupied by ${label} — pick a free slot`, slotOccupied: true };
  }

  const out = clone(bytes);
  const off = slotOffset(target);
  const rec = [revUid[0], revUid[1], revUid[2], revUid[3], indexLow, CHAR_KEY_FLAG_PRESENT];
  for (let k = 0; k < CHAR_KEY_RECLEN; k++) {
    out[off + k] = rec[k];
    out[off + CHAR_KEY_MIRROR_OFFSET + k] = rec[k];
  }
  return {
    ok: true,
    bytes: out,
    keyId: newKeyId,
    indexLow,
    slotIdx: target,
    slot: target + 1,
    offset: off,
    mirrorOffset: off + CHAR_KEY_MIRROR_OFFSET,
    keyCountAfter: parsed.keyCount + 1,
  };
}
