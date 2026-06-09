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
 *   │         0x01 = PRESENT (base family). On the 2019 seed car the Key IDs  │
 *   │                end 9B/9F/9E (stored records start 0x9X), but that 0x9X  │
 *   │                prefix is NOT what flag 0x01 means — it just marks a     │
 *   │                present key. Later cars carry flag-0x01 keys whose       │
 *   │                stored UIDs start 0x62/0x64 (Key IDs ending 0x62/0x64);  │
 *   │                see the FLAG 0x01 / 0x64-UID box below.                  │
 *   │         0x03 = present, ALTERNATE family (bit1 set). See FLAG 0x03 box.  │
 *   │       Any OTHER flag stays 'unknown' (refuse-on-doubt).                 │
 *   │  Reference car: 6 keys in slots 3..8, slots 1..2 empty.                │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────── SLOT PLACEMENT ─────────────────────────────┐
 *   │  Every real 4 KB dump surveyed (4 DISTINCT vehicles in attached_assets  │
 *   │  + fixtures) packs its keys as a CONTIGUOUS BLOCK that ENDS at slot 8,  │
 *   │  with the EMPTY slots at the LOW end. Observed occupancy patterns        │
 *   │  (`.`=empty, `K`=key), 100% consistent across the corpus:               │
 *   │     ..KKKKKK  (slots 3-8, the 6.2 Charger reference car, 6 keys)        │
 *   │     ...KKKKK  (slots 4-8, a Scat Pack, 5 keys)                          │
 *   │     .....KKK  (slots 6-8, a 21 Charger and the 0x03 Redeye, 3 keys)     │
 *   │  No real car ever leaves a gap BELOW a key or an empty slot 8.          │
 *   │                                                                         │
 *   │  So addCharKey defaults to the HIGHEST empty slot (lastFreeCharSlot),   │
 *   │  not the lowest: that is the hole directly below the existing block, so  │
 *   │  the write grows the block downward and the result is byte-structurally │
 *   │  identical to a real car. The old first-free default dropped the key    │
 *   │  into slot 1 with a gap above it — a layout NEVER seen on a real dump,  │
 *   │  the most likely reason firmware would ignore an offline-added key.     │
 *   │                                                                         │
 *   │  CONFIRMED (2026-06-09): A real before/after EEPROM pair from a 2021    │
 *   │  Charger 6.2 Redeye bench key-add is now in the corpus:                 │
 *   │    BEFORE: RFHUB_21_JAILBREAK)OG_6.2_OG.bin (3 keys, slots 6-8)        │
 *   │    AFTER:  redandblackkysprogrammed.bin (5 keys, slots 4-8)             │
 *   │  The ONLY key-table changes are slots 4 and 5 written from empty        │
 *   │  (5A5A5A5A9500) to flag-0x01 records with correct index checksums.      │
 *   │  No other region changed (no companion table, no counter). The write    │
 *   │  format produced by addCharKey() is byte-identical to what the          │
 *   │  programmer wrote. See knownWorkingKeys.js redeye-programmed-21-*.      │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌──────────────────── FLAG 0x01 with 0x62/0x64-prefixed UIDs ─────────────┐
 *   │  Flag 0x01 == PRESENT; it does NOT imply the 0x9X UID prefix seen on the │
 *   │  2019 seed car. Multiple real, registered cars carry flag-0x01 keys      │
 *   │  whose stored UIDs start 0x64 (Key IDs ending 0x64):                    │
 *   │     • SCAT   (VIN 2C3CDXHG5EH219538) — slots 4..8, flag 0x01,          │
 *   │       e.g. 54D44964 / 90B0EB64 / 33741E64 / E1381664.                   │
 *   │     • CARTMAN (VIN 2C3CDZL95NH179529) — slots 6..8, flag 0x01.         │
 *   │  Both are registered in knownWorkingKeys.js as id46 (BCM SEC16 cross-   │
 *   │  checked + VIN-scoped). So a 0x62/0x64-prefixed UID under flag 0x01 is   │
 *   │  ORDINARY, not the flag-0x03 alternate family.                          │
 *   │                                                                         │
 *   │  FIFTH car — 2022 Charger Redeye 6.2 "797" (VIN 2C3CDXGJXNH176487,     │
 *   │  RFHUB master 581391E0…): 4 flag-0x01 keys in slots 5..8 with stored    │
 *   │  UIDs 64BCBB42 / 623DE128 / 64DE97BF / 64DE8317 (Key IDs 42BBBC64 /     │
 *   │  28E13D62 / BF97DE64 / 1783DE64), every index byte = deriveCharKeyIndex.│
 *   │  PARSE-VERIFIED-ONLY (NOT registered): the source bundle's "BCM" file is │
 *   │  byte-identical to this RFHUB (a mislabeled duplicate, not a real BCM),  │
 *   │  so there is no independent SEC16 cross-check, and the paired GPEC2A's   │
 *   │  PCM SEC6 ≠ reverse(master)[0:6] — the secret is attested by a single   │
 *   │  module. Chip family + per-chip SK are unconfirmed; registering would   │
 *   │  mean inventing id46/MIKRON values and break refuse-on-doubt. See       │
 *   │  charRfhubKeyTable.redeye797.test.js.                                   │
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
 *   │  recognized real keys, not 'unknown'). addCharKey defaults to writing  │
 *   │  flag 0x01 Hitag2 records, but now ALSO accepts flag:0x03 to synthesize │
 *   │  an alternate-family record — the alt-family INDEX rule is cracked (see │
 *   │  the INDEX BYTE box), so the EEPROM bytes can be emitted correctly. The │
 *   │  family flag still has to be opted into explicitly, and any flag other  │
 *   │  than 0x01/0x03 is refused (gate not widened). CAVEAT: a correct EEPROM │
 *   │  record is necessary but NOT sufficient — the transponder chip must be  │
 *   │  programmed with the right alt-family SK out-of-band (KEY WRITER tab),  │
 *   │  and registering an 0x03 key in knownWorkingKeys.js still needs its     │
 *   │  chip family + SK confirmed (inventing id46/MIKRON would be a lie).    │
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
 *   ┌────────────── INDEX BYTE — SOLVED (both families, unified) ─────────────┐
 *   │  The per-key INDEX LOW byte was long treated as an opaque firmware-     │
 *   │  assigned handle. It is in fact a mod-255 (ones'-complement-style)      │
 *   │  CHECK byte over the rest of the record — the 4 UID bytes AND the       │
 *   │  family flag:                                                           │
 *   │                                                                         │
 *   │      index = (0xFE - flag - sum(keyId bytes)) mod 255                   │
 *   │                                                                         │
 *   │  equivalently  (sum(keyId bytes) + index + flag) ≡ 0xFE (mod 255).     │
 *   │  Because the byte SUM is order-independent, the reversed stored UID     │
 *   │  gives the same result as the Autel-printed Key ID. The output range is │
 *   │  0x00..0xFE — it never collides with the 0xFF record separator.         │
 *   │                                                                         │
 *   │  The flag-0x01 base family was solved first and pinned to the constant  │
 *   │  0xFD (= 0xFE - 0x01). The flag-0x03 alternate family was the open part │
 *   │  of this task: its three real keys all fit the SAME rule once the flag  │
 *   │  byte is folded in (constant shifts to 0xFB = 0xFE - 0x03). So the flag │
 *   │  was always part of the checksum; the 0x01-only corpus just hid it.     │
 *   │                                                                         │
 *   │  Verified against EVERY real corpus pair (deriveCharKeyIndex + tests):  │
 *   │   flag 0x01 (18 keys / 3 vehicles): 0077A29B->0x48 CC62209F->0x0F …     │
 *   │   flag 0x03 (3 keys, VIN 2C3CDXCT1HH652640):                            │
 *   │     BFA40065->0x32  2369DA69->0x2B  1248C964->0x73                      │
 *   │  An exhaustive sweep (CRC8/16, DES/3DES/AES every byte position,       │
 *   │  HMAC, AES-CMAC, Hitag2 keystream, master-keyed) found no other         │
 *   │  producing function, so this checksum is the derivation, not chance.    │
 *   │  It is master-INDEPENDENT (no per-vehicle secret enters), which is why  │
 *   │  offline key-add works. addCharKey computes the index from the Key ID + │
 *   │  flag instead of the 0x95 empty-slot placeholder an earlier add reused. │
 *   │                                                                         │
 *   │  HONESTY: the 0x03 fit rests on a SINGLE vehicle's 3 keys (the only     │
 *   │  0x03 car in the corpus) — no before/after key-add pair exists. The fit │
 *   │  is exact and shares the already-multi-vehicle-verified 0x01 mechanism, │
 *   │  but a real before/after capture would still be the gold standard.      │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

export const CHAR_KEYTABLE_BASE = 0x0C5E;
export const CHAR_KEYTABLE_SLOTS = 8;
export const CHAR_KEYTABLE_STRIDE = 16;
// 16-byte vehicle master secret (mirror @0x238). diffCharKeyTables compares this
// window to tell a single offline key-add (master unchanged) apart from a full
// re-sync / cross-vehicle pairing (master changes — the whole table is rewritten).
export const CHAR_MASTER_OFFSET = 0x0226;
export const CHAR_MASTER_LEN = 16;
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
// UNIFIED record-checksum target (mod 255): the index byte is the value that
// makes  (sum(keyId bytes) + index + flag) ≡ 0xFE (mod 255)  — i.e. the index
// is a mod-255 ones'-complement-style checksum over the OTHER record bytes
// (the 4 UID bytes + the family flag). Confirmed on every real pair in the
// corpus: 18 flag-0x01 keys across 3 vehicles AND all 3 flag-0x03 (alt-family)
// keys on the one 0x03 vehicle (VIN 2C3CDXCT1HH652640). See the INDEX BYTE box.
export const CHAR_KEY_RECORD_CHECKSUM = 0xFE;
// Per-family index-check constant = (CHAR_KEY_RECORD_CHECKSUM - flag). For the
// base Hitag2 family (flag 0x01) this is 0xFD — the constant the index rule was
// originally pinned to before the flag-0x03 corpus revealed that the flag byte
// participates in the checksum. Kept for back-compat (UI labels + the flag-0x01
// invariant test); new code should prefer CHAR_KEY_RECORD_CHECKSUM + the flag.
export const CHAR_KEY_INDEX_CHECK = CHAR_KEY_RECORD_CHECKSUM - CHAR_KEY_FLAG_PRESENT; // 0xFD
// Empty-slot template: 5A 5A 5A 5A 95 00
export const CHAR_EMPTY_TEMPLATE = [0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00];
const CANONICAL_SIZE = 4096;

function clone(bytes) { return new Uint8Array(bytes); }

/* deriveCharKeyIndex(key, flag) — compute the per-key INDEX LOW byte.
 *
 *   index = (0xFE - flag - sum(keyId bytes)) mod 255      (range 0x00..0xFE)
 *
 * The index byte is a mod-255 ones'-complement-style CHECKSUM over the rest of
 * the 6-byte record: the four UID bytes PLUS the family flag, chosen so that
 *     (sum(keyId bytes) + index + flag) ≡ 0xFE (mod 255).
 * For the base Hitag2 family (flag 0x01) this collapses to the originally-pinned
 * (0xFD - sum) rule; the flag-0x03 alternate family shifts the constant to 0xFB
 * because the flag is two larger. Because the byte sum is order-independent,
 * either the Autel-printed Key ID ('0077A29B') or the byte-reversed stored UID
 * (Uint8Array/array [0x9B,0xA2,0x77,0x00]) yields the SAME index.
 *
 * Verified against EVERY real corpus pair: 18 flag-0x01 keys across 3 vehicles
 * AND all 3 flag-0x03 keys on VIN 2C3CDXCT1HH652640 (see module header + tests).
 *
 * `flag` defaults to the base Hitag2 family (0x01) so existing callers are
 * unchanged. Pass CHAR_KEY_FLAG_ALT (0x03) for an alternate-family record.
 *
 * Accepts an 8-hex-char Key ID string OR a 4-byte Uint8Array/array. Throws on a
 * malformed string; for a byte array only the first 4 bytes are summed. */
export function deriveCharKeyIndex(key, flag = CHAR_KEY_FLAG_PRESENT) {
  if (!Number.isInteger(flag) || flag < 0 || flag > 0xFF) {
    throw new Error(`deriveCharKeyIndex: flag must be a byte 0..255 (got ${flag})`);
  }
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
  return ((CHAR_KEY_RECORD_CHECKSUM - flag - sum) % 255 + 255) % 255;
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
 *  required on slots 1-6 only; slot 7's trailing byte may bleed into the slot 8
 *  area on virgin/blank RFHUBs (trailing = FF 00). The last slot (8) abuts
 *  the 4-byte trailer + aux parameter table on real dumps.
 *
 *  Virgin/blank RFHUBs have slot 8 as factory-uninitialized data (FE 00 FF 00
 *  FE 00 or similar) — the mirror won't match and the record is neither a valid
 *  key nor the standard empty template. These are treated as WRITABLE empty
 *  slots (the first key on a real car always goes to slot 8). The validator
 *  skips mirror/record checks on slot 8 when it's in this uninitialized state. */
export function isCharRfhubKeyTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CANONICAL_SIZE) return false;
  if (slotOffset(CHAR_KEYTABLE_SLOTS - 1) + CHAR_KEYTABLE_STRIDE > bytes.length) return false;
  const lastIdx = CHAR_KEYTABLE_SLOTS - 1;
  const secondLastIdx = CHAR_KEYTABLE_SLOTS - 2; // slot 7 (0-indexed 6)

  // Detect whether slot 8 is factory-uninitialized (virgin/blank RFHUB pattern)
  const lastOff = slotOffset(lastIdx);
  const lastRec = bytes.slice(lastOff, lastOff + CHAR_KEY_RECLEN);
  const lastIsEmpty = lastRec[0] === 0x5A && lastRec[1] === 0x5A && lastRec[2] === 0x5A
    && lastRec[3] === 0x5A && lastRec[4] === 0x95 && lastRec[5] === 0x00;
  const lastIsKey = keyKindForFlag(lastRec[5]) !== null;
  const lastIsUninitialized = !lastIsEmpty && !lastIsKey;

  for (let i = 0; i < CHAR_KEYTABLE_SLOTS; i++) {
    const off = slotOffset(i);
    // Skip slot 8 entirely if it's factory-uninitialized (virgin RFHUB)
    if (i === lastIdx && lastIsUninitialized) continue;
    if (!hasInnerFFSep(bytes, off)) return false;
    // Trailing FF FF: required on slots 1-6. Slot 7 is exempt when slot 8 is
    // uninitialized (its trailing byte bleeds into the uninit data on virgin
    // dumps). Slot 8 is always exempt (abuts aux parameter table).
    if (i < lastIdx) {
      if (i < secondLastIdx && !hasTrailingFFSep(bytes, off)) return false;
      if (i === secondLastIdx && !lastIsUninitialized && !hasTrailingFFSep(bytes, off)) return false;
      // When lastIsUninitialized, slot 7 trailing sep is allowed to be non-FF
    }
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
  // Detect whether slot 8 is factory-uninitialized (virgin/blank RFHUB)
  const lastOff = slotOffset(CHAR_KEYTABLE_SLOTS - 1);
  const lastRec = bytes.slice(lastOff, lastOff + CHAR_KEY_RECLEN);
  const lastIsEmpty = lastRec[0] === 0x5A && lastRec[1] === 0x5A && lastRec[2] === 0x5A
    && lastRec[3] === 0x5A && lastRec[4] === 0x95 && lastRec[5] === 0x00;
  const lastIsKey = keyKindForFlag(lastRec[5]) !== null;
  const lastIsUninitialized = !lastIsEmpty && !lastIsKey;

  const slots = [];
  let keyCount = 0;
  let unknownCount = 0;
  for (let i = 0; i < CHAR_KEYTABLE_SLOTS; i++) {
    const off = slotOffset(i);
    const mirrorOffset = off + CHAR_KEY_MIRROR_OFFSET;
    const raw = bytes.slice(off, off + CHAR_KEY_RECLEN);
    // Slot 8 factory-uninitialized: treat as WRITABLE empty (first key goes here)
    const isUninitSlot = (i === CHAR_KEYTABLE_SLOTS - 1) && lastIsUninitialized;
    const state = isUninitSlot ? 'empty' : classifySlot(bytes, off);
    const empty = state === 'empty';
    const mirrorOk = isUninitSlot ? false : recordsMatch(bytes, off, mirrorOffset);
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
  return { ok: true, slots, keyCount, unknownCount, hasUninitSlot8: lastIsUninitialized };
}

/** firstFreeCharSlot(bytes) → 0-based slot idx | -1
 *  LOWEST-indexed empty slot. Retained for callers that genuinely want the
 *  first hole (and for the corpus-pattern regression tests), but it is NO
 *  LONGER what addCharKey uses to place a new key — see lastFreeCharSlot and
 *  the SLOT PLACEMENT box in the header. */
export function firstFreeCharSlot(bytes) {
  const p = parseCharKeyTable(bytes);
  if (!p.ok) return -1;
  for (const s of p.slots) if (s.empty) return s.slot - 1;
  return -1;
}

/** lastFreeCharSlot(bytes) → 0-based slot idx | -1
 *  HIGHEST-indexed empty slot. On every real 4 KB Charger/Challenger dump the
 *  keys form a contiguous block that ENDS at slot 8 and the empty slots are the
 *  low ones, so the highest empty slot is the hole directly below the key block.
 *  Writing there grows the block downward and preserves the observed
 *  "contiguous keys ending at slot 8" invariant — this is the slot addCharKey
 *  now fills by default (see the SLOT PLACEMENT box in the header). */
export function lastFreeCharSlot(bytes) {
  const p = parseCharKeyTable(bytes);
  if (!p.ok) return -1;
  for (let i = p.slots.length - 1; i >= 0; i--) if (p.slots[i].empty) return i;
  return -1;
}

/* addCharKey(bytes, { keyId, indexLow, slotIdx, flag, allowDuplicate })
 *   Writes a new transponder key record (and its mirror) into a free slot.
 *   Returns { ok, bytes, ... } | { ok:false, error }. The original is never
 *   mutated. No checksum recompute (none covers this region — see header).
 *
 *   indexLow defaults to null → the correct per-key index is DERIVED from the
 *   Key ID AND the family flag via deriveCharKeyIndex (the mod-255 record
 *   checksum). Pass an explicit indexLow only to override (e.g. bench
 *   experiments). `indexDerived` in the result reports whether the written
 *   index came from the derivation.
 *
 *   flag defaults to CHAR_KEY_FLAG_PRESENT (0x01, base Hitag2). Pass
 *   CHAR_KEY_FLAG_ALT (0x03) to synthesize an alternate-family record (now that
 *   the alt-family index rule is cracked — see the INDEX BYTE box). Any flag
 *   value other than these two recognized families is REFUSED so the
 *   refuse-on-doubt gate is never widened to a record shape this tool has not
 *   observed on a real car. NOTE: writing an alt record places the correct
 *   EEPROM bytes, but the transponder chip itself must still be programmed with
 *   the right family SK out-of-band (KEY WRITER tab); this function does not
 *   register the key in knownWorkingKeys.js.
 *
 *   Mirrors the module-wide refuse-on-doubt pattern: bad buffer, duplicate
 *   key, full table, index collision, unrecognized flag, or a non-empty target
 *   all halt before any byte is written. */
export function addCharKey(bytes, { keyId, indexLow = null, slotIdx = null, flag = CHAR_KEY_FLAG_PRESENT, allowDuplicate = false } = {}) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: 'addCharKey: missing buffer' };
  if (!isCharRfhubKeyTable(bytes)) {
    return { ok: false, error: 'addCharKey: not a recognized Charger RFHUB key table (refusing to write)' };
  }
  // Refuse any flag that is not one of the two recognized present-key families.
  // keyKindForFlag is the single source of truth; widening it here would let
  // the writer emit a record shape never seen on a real dump.
  if (keyKindForFlag(flag) === null) {
    return { ok: false, error: `addCharKey: unrecognized family flag 0x${(flag & 0xFF).toString(16)} (only 0x01 Hitag2 / 0x03 alt are writable)`, badFlag: true };
  }
  let revUid;
  try { revUid = keyIdToRevUid(keyId); }
  catch (e) { return { ok: false, error: 'addCharKey: ' + (e.message || e) }; }

  // Default the index to the value derived from the Key ID AND the family flag
  // (the flag participates in the record checksum); an explicit indexLow (incl.
  // 0) overrides for bench experiments.
  const indexDerived = indexLow == null;
  if (indexDerived) indexLow = deriveCharKeyIndex(revUid, flag);

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

  // Resolve target slot. Default to the HIGHEST empty slot, not the lowest:
  // every real dump keeps its keys in a contiguous block ENDING at slot 8 with
  // the empty slots at the low end, so the highest empty slot is the hole
  // directly below the key block. Filling it grows the block downward and keeps
  // the layout identical to a real car (see the SLOT PLACEMENT box). An explicit
  // slotIdx still overrides for bench experiments.
  let target = slotIdx;
  if (target == null) {
    target = lastFreeCharSlot(bytes);
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
  const rec = [revUid[0], revUid[1], revUid[2], revUid[3], indexLow, flag];
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
    flag,
    keyKind: keyKindForFlag(flag),
    slotIdx: target,
    slot: target + 1,
    offset: off,
    mirrorOffset: off + CHAR_KEY_MIRROR_OFFSET,
    keyCountAfter: parsed.keyCount + 1,
  };
}

/* ============================================================================
 * diffCharKeyTables(before, after) — before/after key-table diff harness.
 *
 * Purpose: validate a REAL before/after RFHUB EEPROM capture where exactly one
 * transponder key was added on a working car. It answers the two questions the
 * bench-verification needs and refuses to guess when it can't:
 *
 *   1. Did the inserted key land in the slot addCharKey would pick — the HIGHEST
 *      free slot of the BEFORE image (lastFreeCharSlot)? (addedSlotMatchesRule)
 *   2. Did anything change OUTSIDE the 8-slot key table? Any such run is a
 *      candidate companion table that an offline key-add would also have to
 *      touch for the key to actually start the car. (companionRegions)
 *
 * It also flags a master-secret change (CHAR_MASTER_OFFSET): when the 16-byte
 * vehicle master differs, the pair is a full re-sync / cross-vehicle pairing —
 * NOT a single offline key-add — and isSingleKeyAdd is false regardless of the
 * key-set delta. (This is exactly what an exhaustive scan of the bundled dump
 * corpus found for every key-set difference; see the crack-kit findings doc.)
 *
 * Pure: never mutates its inputs. Returns a structured verdict, or
 * { ok:false, error } when either side is not a canonical Charger key table.
 * ========================================================================== */

function coalesceRuns(before, after, gap = 8) {
  const len = Math.min(before.length, after.length);
  const runs = [];
  let cur = null;
  for (let i = 0; i < len; i++) {
    if (before[i] !== after[i]) {
      if (cur && i - cur.end <= gap) cur.end = i;
      else { cur = { start: i, end: i }; runs.push(cur); }
    }
  }
  return runs.map(r => ({
    start: r.start,
    end: r.end,
    length: r.end - r.start + 1,
    startHex: `0x${r.start.toString(16).toUpperCase()}`,
    endHex: `0x${r.end.toString(16).toUpperCase()}`,
  }));
}

function overlapsKeyTable(run) {
  const tableStart = CHAR_KEYTABLE_BASE;
  const tableEnd = CHAR_KEYTABLE_BASE + CHAR_KEYTABLE_SLOTS * CHAR_KEYTABLE_STRIDE; // exclusive
  return run.start < tableEnd && run.end >= tableStart;
}

function overlapsMaster(run) {
  const mStart = CHAR_MASTER_OFFSET;
  const mEnd = CHAR_MASTER_OFFSET + CHAR_MASTER_LEN; // exclusive
  return run.start < mEnd && run.end >= mStart;
}

function keySummary(slot) {
  return {
    slot: slot.slot,
    slotIdx: slot.slot - 1,
    keyId: slot.keyId,
    indexLow: slot.indexLow,
    flag: slot.flag,
    keyKind: slot.keyKind,
    offset: slot.offset,
  };
}

export function diffCharKeyTables(before, after) {
  const pb = parseCharKeyTable(before);
  if (!pb.ok) return { ok: false, error: `before: ${pb.error}` };
  const pa = parseCharKeyTable(after);
  if (!pa.ok) return { ok: false, error: `after: ${pa.error}` };

  // Key-set delta keyed by UID (a slot move with the same UID is not an add).
  const beforeKeys = new Map(pb.slots.filter(s => s.state === 'key').map(s => [s.keyId, s]));
  const afterKeys = new Map(pa.slots.filter(s => s.state === 'key').map(s => [s.keyId, s]));
  const addedKeys = [];
  const removedKeys = [];
  for (const [id, s] of afterKeys) if (!beforeKeys.has(id)) addedKeys.push(keySummary(s));
  for (const [id, s] of beforeKeys) if (!afterKeys.has(id)) removedKeys.push(keySummary(s));

  // Master secret comparison (full re-key tell).
  let masterChanged = false;
  for (let i = 0; i < CHAR_MASTER_LEN; i++) {
    if (before[CHAR_MASTER_OFFSET + i] !== after[CHAR_MASTER_OFFSET + i]) { masterChanged = true; break; }
  }

  // Byte-level changed regions, classified relative to the key-table window and
  // the master-secret window. Anything left over is a companion-table candidate.
  const changedRegions = coalesceRuns(before, after);
  const keyTableChanged = changedRegions.some(overlapsKeyTable);
  const companionRegions = changedRegions.filter(r => !overlapsKeyTable(r) && !overlapsMaster(r));

  const isSingleKeyAdd = addedKeys.length === 1 && removedKeys.length === 0 && !masterChanged;

  // Highest-free-slot rule: only meaningful for a clean single add.
  let expectedSlotIdx = null;
  let addedSlotMatchesRule = null;
  if (isSingleKeyAdd) {
    expectedSlotIdx = lastFreeCharSlot(before);
    addedSlotMatchesRule = addedKeys[0].slotIdx === expectedSlotIdx;
  }

  return {
    ok: true,
    addedKeys,
    removedKeys,
    masterChanged,
    isSingleKeyAdd,
    expectedSlotIdx,
    addedSlotMatchesRule,
    keyTableChanged,
    changedRegions,
    companionRegions,
    beforeKeyCount: pb.keyCount,
    afterKeyCount: pa.keyCount,
  };
}
