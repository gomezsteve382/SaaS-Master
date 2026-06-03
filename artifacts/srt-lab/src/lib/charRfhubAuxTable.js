/* ============================================================================
 * charRfhubAuxTable.js — pure (no React) read-only parser for the SECOND
 * mirrored-record table that sits directly after the 8-slot transponder key
 * table in MPC-based Charger/Challenger RFHUB 4 KB EEPROM dumps.
 *
 * This is the sibling of charRfhubKeyTable.js (which models the 6-byte key
 * records at 0xC5E). The task that produced this file expected the neighbour
 * table to be the RKE / remote-fob list. The dumps say otherwise — see the
 * "WHAT THIS IS (AND IS NOT)" box below. The parser is therefore deliberately
 * READ-ONLY and makes NO semantic claim about the records: it confirms the
 * structure (offset, count, mirror, separators, boundary) and hands back the
 * raw 10-byte payloads. There is no writer.
 *
 *   ┌─────────────────────────── LAYOUT (observed) ──────────────────────────┐
 *   │  After the key table ends (last mirror at 0xCDB) there is a single      │
 *   │  4-byte mirrored TRAILER at 0xCDC:                                       │
 *   │     [4B][4B mirror][FF FF]   (0xCDC..0xCE5, 10 bytes, no inner sep)      │
 *   │  The 4-byte value differs per dump (00 6C 26 6C / 4F C7 6F C7 / …) and  │
 *   │  is NOT part of this table; it just fixes the start boundary.            │
 *   │                                                                          │
 *   │  The aux table itself begins at 0xCE6 and is a fixed run of 17 records: │
 *   │     base 0xCE6, COUNT 17, record 10 B, stride 24 B. Each record is      │
 *   │     written TWICE (mirror) with FF FF separators:                       │
 *   │        [rec 10B] FF FF [rec 10B mirror] FF FF                            │
 *   │  The table ends at 0xE7E, where a different 6-byte mirrored section      │
 *   │  begins (00 00 00 00 FE 00 …). Record 0 example:                         │
 *   │     0xCE6:  00 00 00 00 09 10 0C FD DA 01                                │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────── WHAT THIS IS (AND IS NOT) ──────────────────────┐
 *   │  These are NOT per-car RKE remote-fob entries, despite the table's      │
 *   │  position. Evidence from the 4-vehicle bench corpus (4 distinct RFHUB   │
 *   │  masters / VINs):                                                        │
 *   │    • The record COUNT is fixed at 17 on every dump, regardless of how   │
 *   │      many transponder keys the car has (3, 5 and 6 keys all give 17).   │
 *   │      A fob list would grow/shrink with the number of paired remotes.    │
 *   │    • Several records are byte-identical across all 4 distinct vehicles  │
 *   │      (e.g. rec 4 = 55 55 59 59 22 82 A9 01 51 01, rec 7 = 00 00 00 00   │
 *   │      00 20 00 81 5C 01, rec 11 = 00 00 00 00 00 00 00 71 8C 01). A fob  │
 *   │      ID is unique per remote and would never repeat across cars.        │
 *   │    • The records that DO vary change in small fields (notably byte 8,   │
 *   │      which tracks payload changes like a checksum, and the trailing     │
 *   │      byte 9 which is usually 0x01 but is occasionally 0x02/0x07/0x08).  │
 *   │  This is most consistent with a fixed RFHUB parameter / calibration     │
 *   │  block, not a remote-fob table. No byte's meaning is bench-verified, so │
 *   │  this module assigns NONE and surfaces the raw records only.            │
 *   │                                                                          │
 *   │  Field meaning: UNVERIFIED. The only structurally-reliable facts are    │
 *   │  the record length (10), the count (17), the mirror, the FF FF          │
 *   │  separators, and the 0xCE6..0xE7E boundary. byte 8 behaves like a       │
 *   │  per-record checksum (no simple sum/xor reproduces it) and byte 9 is a  │
 *   │  small flag/type (mostly 0x01); neither is confirmed. Refuse-on-doubt:  │
 *   │  do not relabel these as fobs or invent field names without a bench     │
 *   │  capture that proves the semantics.                                      │
 *   └────────────────────────────────────────────────────────────────────────┘
 * ========================================================================== */

export const CHAR_AUX_BASE = 0x0CE6;
export const CHAR_AUX_COUNT = 17;
export const CHAR_AUX_RECLEN = 10;
// rec(10) + FF FF(2) + mirror(10) + FF FF(2)
export const CHAR_AUX_STRIDE = 24;
export const CHAR_AUX_MIRROR_OFFSET = 12;
export const CHAR_AUX_END = CHAR_AUX_BASE + CHAR_AUX_COUNT * CHAR_AUX_STRIDE; // 0xE7E
const CANONICAL_SIZE = 4096;

function recOffset(i) { return CHAR_AUX_BASE + i * CHAR_AUX_STRIDE; }

function recordsMatch(bytes, a, b) {
  for (let k = 0; k < CHAR_AUX_RECLEN; k++) if (bytes[a + k] !== bytes[b + k]) return false;
  return true;
}

// Each record is [rec 10B][FF FF][mirror 10B][FF FF]. The inner separator (after
// the first 10B record) and the trailing separator (after the mirror) are BOTH
// FF FF on every record of this table — unlike the key table, the last record
// here does NOT abut another structure, so its trailing FF FF is present too
// (the next section at 0xE7E starts with its own bytes).
function hasInnerFFSep(bytes, off) {
  return bytes[off + CHAR_AUX_RECLEN] === 0xFF && bytes[off + CHAR_AUX_RECLEN + 1] === 0xFF;
}
function hasTrailingFFSep(bytes, off) {
  const o = off + CHAR_AUX_MIRROR_OFFSET + CHAR_AUX_RECLEN;
  return bytes[o] === 0xFF && bytes[o + 1] === 0xFF;
}

/** isCharRfhubAuxTable(bytes) — strict structural gate. Won't false-positive on
 *  an unrelated 4 KB image: canonical size + all 17 records are mirrored 10-byte
 *  records, each bracketed by an inner and a trailing FF FF separator. 17 mirror
 *  matches plus 34 FF FF checks make an accidental match astronomically unlikely.
 *  Makes NO semantic claim about the bytes — structure only (see header). */
export function isCharRfhubAuxTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CANONICAL_SIZE) return false;
  if (recOffset(CHAR_AUX_COUNT - 1) + CHAR_AUX_STRIDE > bytes.length) return false;
  for (let i = 0; i < CHAR_AUX_COUNT; i++) {
    const off = recOffset(i);
    if (!hasInnerFFSep(bytes, off)) return false;
    if (!hasTrailingFFSep(bytes, off)) return false;
    if (!recordsMatch(bytes, off, off + CHAR_AUX_MIRROR_OFFSET)) return false;
  }
  return true;
}

/** parseCharAuxTable(bytes) → { ok, records, count, error }
 *  records[i] = { index, offset, mirrorOffset, raw:Uint8Array(10), hex, mirrorOk }
 *  Read-only: no field is interpreted. Refuse-on-doubt — if the structural gate
 *  fails, returns { ok:false, error, records:[], count:0 } and surfaces nothing. */
export function parseCharAuxTable(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: 'no buffer', records: [], count: 0 };
  }
  if (bytes.length !== CANONICAL_SIZE) {
    return { ok: false, error: `Not a 4 KB RFHUB image (got ${bytes.length} B)`, records: [], count: 0 };
  }
  if (!isCharRfhubAuxTable(bytes)) {
    return {
      ok: false,
      error: 'Charger aux mirrored-record table not found at 0xCE6 (mirror/separator check failed)',
      records: [],
      count: 0,
    };
  }
  const records = [];
  for (let i = 0; i < CHAR_AUX_COUNT; i++) {
    const off = recOffset(i);
    const mirrorOffset = off + CHAR_AUX_MIRROR_OFFSET;
    const raw = bytes.slice(off, off + CHAR_AUX_RECLEN);
    const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    records.push({
      index: i,
      offset: off,
      mirrorOffset,
      raw,
      hex,
      mirrorOk: recordsMatch(bytes, off, mirrorOffset),
    });
  }
  return { ok: true, records, count: records.length };
}
