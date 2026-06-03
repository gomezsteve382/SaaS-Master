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
 *   │     • flag byte is a PRESENCE/FAMILY bitfield:                          │
 *   │         0x00 = no key (only the exact 5A5A5A5A 95 00 template counts    │
 *   │                as a writable EMPTY slot).                               │
 *   │         0x01 = present, base family (FCA id46 Hitag2 — Key IDs end in   │
 *   │                9B/9F/9E, so stored records start with 0x9X).            │
 *   │         0x03 = present, ALTERNATE family (bit1 set). See FLAG 0x03 box.  │
 *   │       Any OTHER flag stays 'unknown' (refuse-on-doubt).                 │
 *   │  Reference car: 6 keys in slots 3..8, slots 1..2 empty.                │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────── FLAG 0x03 (alternate family) ───────────────┐
 *   │  Real OG dumps from VIN 2C3CDXCT1HH652640 (2020 6.2 Redeye, RFHUB      │
 *   │  master f7b1fbae…) carry THREE key records in slots 6-8 whose flag is  │
 *   │  0x03 instead of 0x01, and that car has ZERO flag-0x01 keys. A running  │
 *   │  car must have at least one working immobilizer key, and these three   │
 *   │  are the only keys present (mirror-verified, structurally identical to  │
 *   │  0x01 records) — so the 0x03 records ARE real, working keys, just of a  │
 *   │  different transponder family than the 0x01 Hitag2 keys.               │
 *   │                                                                         │
 *   │  Corpus evidence (every valid 4 KB key table in attached_assets):      │
 *   │     • Flag 0x03 appears on ONLY this one vehicle; no car mixes 0x01    │
 *   │       and 0x03 — each immobilizer is single-family.                    │
 *   │     • 0x03 stored UIDs (65 00 a4 bf / 69 da 69 23 / 64 c9 48 12) do    │
 *   │       NOT start with 0x9X, i.e. their Key IDs do not end in 9B/9F/9E,  │
 *   │       so they are NOT id46 Hitag2 keys. The flag's bit1 (0x02) marks   │
 *   │       this alternate family. Most consistent with FCA proximity /      │
 *   │       Hitag-AES (PEPS) keys on this Redeye, but the exact chip family  │
 *   │       and per-chip secret (SK) are NOT bench-verified.                 │
 *   │                                                                         │
 *   │  classifySlot returns state 'key' + keyKind 'alt' for these (they are  │
 *   │  recognized real keys, not 'unknown'), but addCharKey still WRITES only │
 *   │  flag 0x01 Hitag2 records (it byte-reverses an Autel Key ID; it has no  │
 *   │  way to synthesize an alt-family record). Registering an 0x03 key in    │
 *   │  knownWorkingKeys.js needs its chip family + SK confirmed first —       │
 *   │  inventing id46/MIKRON values would break refuse-on-doubt.             │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────── HONESTY / RISK ─────────────────────────────┐
 *   │  • NO checksum covers this region: editing the 4 VIN copies in an      │
 *   │    immovin VIN-applied dump changed ONLY the VIN bytes — no checksum   │
 *   │    byte moved anywhere — so a key-table edit needs no CS recompute.    │
 *   │  • A wrong index can only make the car reject THAT key (other keys     │
 *   │    keep working; reflash the original to recover). It cannot brick the │
 *   │    immobilizer because SEC16 and checksums are untouched.              │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────── INDEX BYTE — SOLVED ────────────────────────────┐
 *   │  The per-key INDEX LOW byte was long treated as an opaque firmware-     │
 *   │  assigned handle. It is in fact a mod-255 (ones'-complement-style)      │
 *   │  CHECK byte over the 4 Key-ID bytes:                                    │
 *   │                                                                         │
 *   │      index = (0xFD - sum(keyId bytes)) mod 255                          │
 *   │                                                                         │
 *   │  equivalently  (sum(keyId bytes) + index) ≡ 0xFD (mod 255).            │
 *   │  Because the byte SUM is order-independent, the reversed stored UID     │
 *   │  gives the same result as the Autel-printed Key ID. The output range is │
 *   │  0x00..0xFE — it never collides with the 0xFF record separator.         │
 *   │                                                                         │
 *   │  Verified against ALL SIX known Key-ID -> index pairs from the 2019     │
 *   │  Charger 6.2 RFHUB dump (see deriveCharKeyIndex + tests):              │
 *   │     0077A29B->0x48  CC62209F->0x0F  09A6629F->0x4C                      │
 *   │     91654F9E->0x19  197E6C9E->0x5B  C47D6C9E->0xB0                      │
 *   │  An exhaustive sweep (CRC8/16, DES/3DES/AES every byte position,       │
 *   │  HMAC, AES-CMAC, Hitag2 keystream) found no other producing function,  │
 *   │  so this checksum is the derivation, not a coincidence. addCharKey now  │
 *   │  computes the index from the Key ID instead of defaulting to 0x95 (the  │
 *   │  empty-slot low byte, which is what an earlier failed add reused).      │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

export const CHAR_KEYTABLE_BASE = 0x0C5E;
export const CHAR_KEYTABLE_SLOTS = 8;
export const CHAR_KEYTABLE_STRIDE = 16;
export const CHAR_KEY_RECLEN = 6;
export const CHAR_KEY_MIRROR_OFFSET = 8;
export const CHAR_KEY_FLAG_PRESENT = 0x01;
// Alternate-family present flag (bit1 set). Real keys of a non-Hitag2 transponder
// family (see the FLAG 0x03 header box). Recognized as keys; never synthesized.
export const CHAR_KEY_FLAG_ALT = 0x03;
// LEGACY placeholder = the empty-slot template low byte (5A 5A 5A 5A *95* 00).
// This is NOT a valid index for a present key — reusing it is what made an
// earlier offline add fail. addCharKey now derives the real index from the
// Key ID (deriveCharKeyIndex); this constant is kept only so the UI/tests can
// name the empty-slot sentinel and warn against it.
export const CHAR_KEY_DEFAULT_INDEX = 0x95;
// Target constant of the mod-255 index checksum: (sum(keyId) + index) ≡ 0xFD.
export const CHAR_KEY_INDEX_CHECK = 0xFD;
// Empty-slot template: 5A 5A 5A 5A 95 00
export const CHAR_EMPTY_TEMPLATE = [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00];
const CANONICAL_SIZE = 4096;

function clone(bytes) { return new Uint8Array(bytes); }

/* deriveCharKeyIndex(key) — compute the per-key INDEX LOW byte from the Key ID.
 *
 *   index = (0xFD - sum(keyId bytes)) mod 255       (range 0x00..0xFE)
 *
 * The four Key-ID bytes are summed and the index is the mod-255 complement that
 * makes (sum + index) ≡ 0xFD (mod 255). Because the sum is order-independent,
 * either the Autel-printed Key ID ('0077A29B') or the byte-reversed stored UID
 * (Uint8Array/array [0x9B,0xA2,0x77,0x00]) yields the SAME index. Verified
 * against all six known Charger 6.2 pairs (see module header + tests).
 *
 * Accepts an 8-hex-char Key ID string OR a 4-byte Uint8Array/array. Throws on a
 * malformed string; for a byte array only the first 4 bytes are summed. */
export function deriveCharKeyIndex(key) {
  let sum = 0;
  if (typeof key === 'string') {
    const h = key.replace(/[^0-9a-fA-F]/g, '');
    if (h.length !== 8) throw new Error(`deriveCharKeyIndex: Key ID must be 8 hex chars; got "${key}"`);
    for (let i = 0; i < 8; i += 2) sum += parseInt(h.slice(i, i + 2), 16);
  } else if (key instanceof Uint8Array || Array.isArray(key)) {
    if (key.length < 4) throw new Error('deriveCharKeyIndex: need 4 key bytes');
    for (let i = 0; i < 4; i++) sum += key[i] & 0xFF;
  } else {
    throw new Error('deriveCharKeyIndex: expected an 8-hex Key ID or 4-byte array');
  }
  return ((CHAR_KEY_INDEX_CHECK - sum) % 255 + 255) % 255;
}

function slotOffset(i) { return CHAR_KEYTABLE_BASE + i * CHAR_KEYTABLE_STRIDE; }

function recordsMatch(bytes, a, b) {
  for (let k = 0; k < CHAR_KEY_RECLEN; k++) if (bytes[a + k] !== bytes[b + k]) return false;
  return true;
}

// A slot is [rec 6B][FF FF][mirror 6B][FF FF]. The INNER separator (after the
// first record) is FF FF on every slot. The TRAILING separator (after the
// mirror) is FF FF for slots 1-7, but on real dumps the LAST slot abuts a
// 4-byte mirrored trailer (then the aux 10-byte parameter table at 0xCE6 — see
// charRfhubAuxTable.js; it is NOT an RKE/fob list) with no gap, so its trailing
// two bytes are NOT FF FF (reference car: 00 6C at 0xCDC-0xCDD). isCharRfhubKeyTable therefore
// enforces the trailing separator only on slots 1-7. A synthetic fixture that
// pads the last slot with FF FF is NOT faithful and will hide this boundary —
// which is exactly the defect that made the gate reject every real dump.
function hasInnerFFSep(bytes, off) {
  return bytes[off + CHAR_KEY_RECLEN] === 0xFF && bytes[off + CHAR_KEY_RECLEN + 1] === 0xFF;
}
function hasTrailingFFSep(bytes, off) {
  return bytes[off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN] === 0xFF
    && bytes[off + CHAR_KEY_MIRROR_OFFSET + CHAR_KEY_RECLEN + 1] === 0xFF;
}

/* keyKindForFlag(flag) → 'hitag2' | 'alt' | null
 *   Single source of truth for which flag bytes are RECOGNIZED present-key
 *   records and what sub-family each one is. Only the two flag values actually
 *   observed on real dumps are recognized:
 *     0x01 → 'hitag2' (FCA id46 base family).
 *     0x03 → 'alt'    (alternate transponder family — see FLAG 0x03 box).
 *   Every other flag (incl. 0x00) returns null so classifySlot keeps it
 *   'unknown'/'empty' and the refuse-on-doubt gate is never widened to flags
 *   this tool has not seen on a real car. */
function keyKindForFlag(flag) {
  if (flag === CHAR_KEY_FLAG_PRESENT) return 'hitag2';
  if (flag === CHAR_KEY_FLAG_ALT) return 'alt';
  return null;
}

/* classifySlot(bytes, off) → 'empty' | 'key' | 'unknown'
 *   'empty'   — EXACTLY the canonical empty template (5A 5A 5A 5A 95 00).
 *   'key'     — flag byte is a recognized present-key flag (0x01 Hitag2 or
 *               0x03 alternate family). Use keyKindForFlag(flag) to get the
 *               sub-family; both are real keys, so empty=false and they count
 *               toward keyCount.
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
  if (keyKindForFlag(bytes[off + CHAR_KEY_RECLEN - 1]) !== null) return 'key';
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
 *  record with an inner FF FF separator. The trailing FF FF separator is
 *  required on slots 1-7 only; the last slot abuts the 4-byte trailer + aux
 *  parameter table on real dumps (see hasInnerFFSep/hasTrailingFFSep above). */
export function isCharRfhubKeyTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CANONICAL_SIZE) return false;
  if (slotOffset(CHAR_KEYTABLE_SLOTS - 1) + CHAR_KEYTABLE_STRIDE > bytes.length) return false;
  const lastIdx = CHAR_KEYTABLE_SLOTS - 1;
  for (let i = 0; i < CHAR_KEYTABLE_SLOTS; i++) {
    const off = slotOffset(i);
    if (!hasInnerFFSep(bytes, off)) return false;
    // The final slot abuts the 4-byte trailer + aux parameter table on real dumps,
    // so only slots 1-7 carry a trailing FF FF separator. The mirror check
    // below is still enforced on every slot, including the last.
    if (i < lastIdx && !hasTrailingFFSep(bytes, off)) return false;
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
    // keyKind distinguishes the present-key sub-family ('hitag2' for flag 0x01,
    // 'alt' for flag 0x03). null for empty/unknown slots. Lets callers tell the
    // recognized alternate-family keys apart from base Hitag2 keys without
    // re-deriving it from the flag byte.
    const keyKind = state === 'key' ? keyKindForFlag(flag) : null;
    if (state === 'key') keyCount++;
    else if (state === 'unknown') unknownCount++;
    slots.push({ slot: i + 1, offset: off, mirrorOffset, empty, state, keyKind, mirrorOk, keyId, indexLow, flag, raw });
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
 *   indexLow defaults to null → the correct per-key index is DERIVED from the
 *   Key ID via deriveCharKeyIndex (the mod-255 checksum). Pass an explicit
 *   indexLow only to override (e.g. bench experiments). `indexDerived` in the
 *   result reports whether the written index came from the derivation.
 *
 *   Mirrors the module-wide refuse-on-doubt pattern: bad buffer, duplicate
 *   key, full table, index collision, or a non-empty target all halt before
 *   any byte is written. */
export function addCharKey(bytes, { keyId, indexLow = null, slotIdx = null, allowDuplicate = false } = {}) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: 'addCharKey: missing buffer' };
  if (!isCharRfhubKeyTable(bytes)) {
    return { ok: false, error: 'addCharKey: not a recognized Charger RFHUB key table (refusing to write)' };
  }
  let revUid;
  try { revUid = keyIdToRevUid(keyId); }
  catch (e) { return { ok: false, error: 'addCharKey: ' + (e.message || e) }; }

  // Default the index to the value derived from the Key ID; an explicit
  // indexLow (incl. 0) overrides for bench experiments.
  const indexDerived = indexLow == null;
  if (indexDerived) indexLow = deriveCharKeyIndex(revUid);

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
    indexDerived,
    slotIdx: target,
    slot: target + 1,
    offset: off,
    mirrorOffset: off + CHAR_KEY_MIRROR_OFFSET,
    keyCountAfter: parsed.keyCount + 1,
  };
}
