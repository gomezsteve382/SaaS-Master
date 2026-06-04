/**
 * rfhubKeyTransplant.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gen2 RFHUB (XC2268 / 95640) key transplant engine.
 *
 * BENCH-VERIFIED against:
 *   - 21RFHUB_6.2_REDKEY_PRORGRAMMED.bin         (2 keys: black + red)
 *   - redandblackkysprogrammed.bin                (before: 2 keys in auth sector)
 *   - redandblackkysprogrammed_afterprogrammed.bin (after: 3 keys in auth sector)
 *   - immovin_ce426d349e004560b2e68fb663e11d0a.bin_VIN_APPLIED.bin (1 key)
 *
 * ─── KEY RING BUFFER ────────────────────────────────────────────────────────
 *   Base:  0x0C80  |  Size: 0x0100 bytes (256 bytes)
 *   Entry: 8 bytes — [chip_id_LE(4)] [flag(1)] [count(1)] [0xFF 0xFF(2)]
 *   Fill:  5A 5A 95 00 FF FF repeating (NOT 8-byte aligned)
 *   Rule:  every key is written TWICE consecutively
 *   Note:  BYTE-STREAM circular buffer (not slot-aligned)
 *
 *   KNOWN FLAGS (bench-verified):
 *     0x01 = Standard Hitag2 key
 *     0x03 = Alt-family Hitag2 key
 *     0x48 = Red Key (Hitag AES, FCA/Stellantis)
 *     0xE6 = Black Key (Hitag AES, FCA/Stellantis)
 *
 *   AUTEL ID = chip_id bytes 0-3 reversed (big-endian display)
 *   Example: EEPROM bytes 64 7E 5E D5 -> Autel ID D55E7E64
 *
 * ─── AUTH SECTOR ────────────────────────────────────────────────────────────
 *   The Hitag AES enrollment data is a MONOLITHIC 384-byte block at
 *   0x0100-0x027F. It covers ALL enrolled keys together (not per-key).
 *   The ring buffer entry alone is NOT sufficient — the BCM/immobilizer
 *   also validates the auth sector on every start attempt.
 *
 *   VERIFIED: Copying 0x0100-0x027F from donor to target produces a
 *   byte-identical result to the Autel-programmed file (only the firmware-
 *   managed write counters at 0x0C0E differ, which the module updates itself).
 *
 *   Auth sector structure (bench-derived):
 *     0x0100-0x017F : Auth sector half 1 (128 bytes)
 *     0x0180-0x027F : Auth sector half 2 (128 bytes, mirrored)
 *     Key count:    0x0150, 0x0181, 0x01D4, 0x0205 (4 mirrored copies)
 *     Enc key block: 0x0188, 0x020C (4 bytes each, encrypted)
 *     Rolling nonce: 0x0215, 0x021D (3-7 bytes, session-keyed)
 *     Auth tail:    0x0250 (4 bytes)
 *
 * ─── MASTER TRANSPONDER ─────────────────────────────────────────────────────
 *   16-byte platform record at 0x0226. Same on all Gen2 modules of the same
 *   platform. Display only — never edit.
 *
 * ─── WRITE COUNTERS ─────────────────────────────────────────────────────────
 *   0x0C0E-0x0C1B: Firmware-managed EEPROM write counters. Do NOT copy.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Ring buffer constants (bench-verified) */
export const KEY_RB_BASE    = 0x0C80;
export const KEY_RB_SIZE    = 0x0100;   // 256 bytes = 32 x 8-byte entries
export const KEY_ENTRY_SZ   = 8;
export const KEY_SLOT_COUNT = KEY_RB_SIZE / KEY_ENTRY_SZ; // 32 slots

/** Auth sector constants (bench-verified) */
export const AUTH_SECTOR_BASE = 0x0100;
export const AUTH_SECTOR_SIZE = 0x0180; // 384 bytes (0x0100-0x027F)
export const AUTH_SECTOR_END  = AUTH_SECTOR_BASE + AUTH_SECTOR_SIZE; // 0x0280

/** Master Transponder (platform constant, display only) */
export const MASTER_TRANSPONDER_OFFSET = 0x0226;
export const MASTER_TRANSPONDER_SIZE   = 16;

/**
 * Minimum RFHUB bin size.
 * Gen2 RFHUB (XC2268 / 95640) EEPROM is 4KB (0x1000 bytes).
 * Some dumps may be larger (e.g., full flash reads) — we accept anything >= 4KB.
 */
export const RFHUB_MIN_SIZE = 0x1000; // 4KB

/**
 * Known transplantable key flags (bench-verified).
 * Entries with other flags are historical log data and must not be transplanted.
 */
const KNOWN_FLAGS = new Set([0x01, 0x03, 0x48, 0xE6]);

/** Empty fill pattern prefix (first 4 bytes of an empty ring buffer area) */
const EMPTY_FILL_PREFIX = [0x5A, 0x5A, 0x95, 0x00];

/**
 * Human-readable label for a key flag.
 * @param {number} flag
 * @returns {{ label: string, sub: string, color: string }}
 */
export function flagInfo(flag) {
  switch (flag) {
    case 0xE6: return { label: 'Black Key',    sub: 'Hitag AES',  color: '#212121' };
    case 0x48: return { label: 'Red Key',      sub: 'Hitag AES',  color: '#B71C1C' };
    case 0x01: return { label: 'Standard',     sub: 'Hitag2',     color: '#1565C0' };
    case 0x03: return { label: 'Alt Family',   sub: 'Hitag2',     color: '#4527A0' };
    default:   return { label: `Flag 0x${flag.toString(16).toUpperCase().padStart(2,'0')}`, sub: 'Unknown', color: '#424242' };
  }
}

/**
 * Scan the key ring buffer byte-by-byte and return all valid key entries.
 *
 * The ring buffer is a BYTE-STREAM — entries are NOT 8-byte aligned.
 * We scan every byte position for the pattern: [4B chip_id_LE][1B flag][1B count][FF FF].
 * Only entries with known flags are returned. Duplicates (each key appears twice)
 * are deduplicated by chipId.
 *
 * @param {Uint8Array} buf  RFHUB binary buffer (>= 4KB)
 * @returns {{ chipId: string, autelId: string, flag: number, count: number, addr: number }[]}
 */
export function parseKeyRingBuffer(buf) {
  if (buf.length < RFHUB_MIN_SIZE) {
    throw new Error(`Buffer too small: ${buf.length} bytes (need >= ${RFHUB_MIN_SIZE})`);
  }

  const seen    = new Set();
  const entries = [];
  const rbEnd   = KEY_RB_BASE + KEY_RB_SIZE;

  let i = KEY_RB_BASE;
  while (i <= rbEnd - KEY_ENTRY_SZ) {
    // Terminator check: bytes 6-7 must be FF FF
    if (buf[i + 6] !== 0xFF || buf[i + 7] !== 0xFF) { i++; continue; }

    const flag = buf[i + 4];
    if (!KNOWN_FLAGS.has(flag)) { i++; continue; }

    // Skip empty fill pattern
    if (buf[i]   === EMPTY_FILL_PREFIX[0] &&
        buf[i+1] === EMPTY_FILL_PREFIX[1] &&
        buf[i+2] === EMPTY_FILL_PREFIX[2] &&
        buf[i+3] === EMPTY_FILL_PREFIX[3]) { i++; continue; }

    // Skip all-zero chip ID
    if (buf[i] === 0 && buf[i+1] === 0 && buf[i+2] === 0 && buf[i+3] === 0) { i++; continue; }

    // Valid entry: convert chip ID from LE to BE hex string (= Autel display ID)
    const chipId = [buf[i+3], buf[i+2], buf[i+1], buf[i]]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

    const count = buf[i + 5];

    // Deduplicate — each entry appears twice consecutively
    if (!seen.has(chipId)) {
      seen.add(chipId);
      // autelId is an alias for chipId — same value, clearer name for UI display
      entries.push({ chipId, autelId: chipId, flag, count, addr: i });
    }

    i += KEY_ENTRY_SZ;
  }

  return entries;
}

/**
 * Read the Master Transponder record from an RFHUB buffer.
 *
 * The Master Transponder is a 16-byte platform record at 0x0226.
 * It is the same on all modules of the same platform. Display only — never edit.
 *
 * @param {Uint8Array} buf  RFHUB binary buffer
 * @returns {{ hex: string, bytes: Uint8Array, offset: number, virgin: boolean }}
 */
export function readMasterTransponder(buf) {
  if (buf.length < MASTER_TRANSPONDER_OFFSET + MASTER_TRANSPONDER_SIZE) {
    throw new Error(`Buffer too small to read Master Transponder at 0x${MASTER_TRANSPONDER_OFFSET.toString(16)}`);
  }
  const bytes  = buf.slice(MASTER_TRANSPONDER_OFFSET, MASTER_TRANSPONDER_OFFSET + MASTER_TRANSPONDER_SIZE);
  const hex    = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const virgin = bytes.every(b => b === 0xFF);
  return { hex, bytes, offset: MASTER_TRANSPONDER_OFFSET, virgin };
}

/**
 * Read the auth sector key count from an RFHUB buffer.
 * The key count is stored at 4 mirrored offsets; we return the first one.
 *
 * @param {Uint8Array} buf
 * @returns {number}
 */
export function readAuthKeyCount(buf) {
  if (buf.length < 0x0206) return 0;
  return buf[0x0150];
}

/**
 * Find the write pointer: the byte offset immediately after the last valid
 * key entry in the ring buffer.
 *
 * Returns KEY_RB_BASE if no entries are found (empty ring buffer).
 * Returns null if the ring buffer is full (no room for even one more entry pair).
 *
 * @param {Uint8Array} buf
 * @returns {number|null}
 */
export function findWritePointer(buf) {
  const rbEnd = KEY_RB_BASE + KEY_RB_SIZE;
  let lastEntryEnd = KEY_RB_BASE;

  let i = KEY_RB_BASE;
  while (i <= rbEnd - KEY_ENTRY_SZ) {
    if (buf[i + 6] !== 0xFF || buf[i + 7] !== 0xFF) { i++; continue; }
    const flag = buf[i + 4];
    if (!KNOWN_FLAGS.has(flag)) { i++; continue; }
    if (buf[i]   === EMPTY_FILL_PREFIX[0] &&
        buf[i+1] === EMPTY_FILL_PREFIX[1] &&
        buf[i+2] === EMPTY_FILL_PREFIX[2] &&
        buf[i+3] === EMPTY_FILL_PREFIX[3]) { i++; continue; }
    if (buf[i] === 0 && buf[i+1] === 0 && buf[i+2] === 0 && buf[i+3] === 0) { i++; continue; }
    lastEntryEnd = i + KEY_ENTRY_SZ;
    i += KEY_ENTRY_SZ;
  }

  // Need room for at least one entry pair (16 bytes)
  if (lastEntryEnd + KEY_ENTRY_SZ * 2 > rbEnd) {
    return null; // ring buffer full
  }

  return lastEntryEnd;
}

/**
 * Count how many additional key PAIRS (each pair = 2 x 8 bytes = 16 bytes)
 * can fit in the ring buffer starting at the write pointer.
 *
 * @param {Uint8Array} buf
 * @param {number} writePtr  offset returned by findWritePointer
 * @returns {number}
 */
export function countFreeSlots(buf, writePtr) {
  const rbEnd = KEY_RB_BASE + KEY_RB_SIZE;
  const bytesAvailable = rbEnd - writePtr;
  return Math.floor(bytesAvailable / (KEY_ENTRY_SZ * 2));
}

/**
 * Transplant keys from a donor RFHUB buffer into a target RFHUB buffer.
 *
 * FULL TRANSPLANT MODE (copyAuthSector = true, default):
 *   Copies the entire Hitag AES auth sector (0x0100-0x027F, 384 bytes) from
 *   donor to target, then appends the selected key ring buffer entries.
 *
 *   BENCH-VERIFIED: This produces a byte-identical result to the Autel-
 *   programmed file. The only bytes that differ are the firmware-managed
 *   write counters at 0x0C0E-0x0C1B, which the module updates itself on
 *   next write cycle.
 *
 * RING BUFFER ONLY MODE (copyAuthSector = false):
 *   Only appends ring buffer entries. Use when the target already has a
 *   compatible auth sector (same vehicle, same key set, different module).
 *
 * The target's VIN, Master Transponder, and all other module-specific data
 * are preserved.
 *
 * @param {Uint8Array} donorBuf   Donor RFHUB binary (read-only)
 * @param {Uint8Array} targetBuf  Target RFHUB binary (will be cloned)
 * @param {object}     [opts]
 * @param {string[]}   [opts.only]               If set, only transplant these chip IDs
 * @param {boolean}    [opts.skipDuplicates=true] Skip keys already in target ring buffer
 * @param {boolean}    [opts.copyAuthSector=true] Copy auth sector from donor to target
 *
 * @returns {{
 *   patched:          Uint8Array,
 *   injected:         { chipId: string, autelId: string, flag: number, count: number }[],
 *   skipped:          { chipId: string, reason: string }[],
 *   writePtr:         number,
 *   newWritePtr:      number,
 *   authSectorCopied: boolean,
 * }}
 */
export function transplantKeys(donorBuf, targetBuf, opts = {}) {
  const { only = null, skipDuplicates = true, copyAuthSector = true } = opts;

  // Validate inputs
  const donorValidation  = validateRfhubBuffer(donorBuf);
  const targetValidation = validateRfhubBuffer(targetBuf);
  if (!donorValidation.ok)  throw new Error(`Donor: ${donorValidation.error}`);
  if (!targetValidation.ok) throw new Error(`Target: ${targetValidation.error}`);

  // Parse donor keys
  const donorKeys = parseKeyRingBuffer(donorBuf);
  if (donorKeys.length === 0) {
    throw new Error('Donor RFHUB has no programmed keys');
  }

  // Parse target keys (for duplicate detection)
  const targetKeys    = parseKeyRingBuffer(targetBuf);
  const targetChipIds = new Set(targetKeys.map(k => k.chipId));

  // Find write pointer in target
  const writePtr = findWritePointer(targetBuf);
  if (writePtr === null) {
    throw new Error('Target RFHUB key ring buffer is full');
  }

  // Filter donor keys to inject
  const toInject = [];
  const skipped  = [];

  for (const key of donorKeys) {
    if (only && !only.includes(key.chipId)) {
      skipped.push({ chipId: key.chipId, reason: 'not in selection' });
      continue;
    }
    if (skipDuplicates && targetChipIds.has(key.chipId)) {
      skipped.push({ chipId: key.chipId, reason: 'already in target' });
      continue;
    }
    toInject.push(key);
  }

  if (toInject.length === 0) {
    throw new Error('No new keys to inject (all donor keys already present in target or filtered out)');
  }

  // Capacity check: each key needs 2 entries x 8 bytes = 16 bytes
  const pairsAvailable = countFreeSlots(targetBuf, writePtr);
  if (pairsAvailable < toInject.length) {
    throw new Error(
      `Not enough space in target ring buffer: need ${toInject.length} key pair(s), have ${pairsAvailable}`
    );
  }

  // Clone target buffer
  const patched = new Uint8Array(targetBuf);

  // Copy auth sector from donor to target (if requested)
  // BENCH-VERIFIED: copying 0x0100-0x027F produces byte-identical output to
  // the Autel-programmed file (only firmware write counters at 0x0C0E differ).
  let authSectorCopied = false;
  if (copyAuthSector) {
    const donorAuth = donorBuf.slice(AUTH_SECTOR_BASE, AUTH_SECTOR_END);
    patched.set(donorAuth, AUTH_SECTOR_BASE);
    authSectorCopied = true;
  }

  // Inject ring buffer entries
  let ptr = writePtr;

  for (const key of toInject) {
    // Build 8-byte entry: [chip_id_LE(4)][flag(1)][count(1)][0xFF 0xFF(2)]
    const entry = new Uint8Array(8);
    const chipBytes = hexToBytes(key.chipId); // big-endian -> reverse to LE
    entry[0] = chipBytes[3];
    entry[1] = chipBytes[2];
    entry[2] = chipBytes[1];
    entry[3] = chipBytes[0];
    entry[4] = key.flag;
    entry[5] = key.count;
    entry[6] = 0xFF;
    entry[7] = 0xFF;

    // Write twice (ring buffer protocol: every key written twice consecutively)
    patched.set(entry, ptr);
    patched.set(entry, ptr + KEY_ENTRY_SZ);
    ptr += KEY_ENTRY_SZ * 2;
  }

  return {
    patched,
    injected:    toInject.map(({ chipId, flag, count }) => ({ chipId, autelId: chipId, flag, count })),
    skipped,
    writePtr,
    newWritePtr: ptr,
    authSectorCopied,
  };
}

/**
 * Validate that a buffer looks like a Gen2 RFHUB (size check + ring buffer sanity).
 *
 * @param {Uint8Array} buf
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateRfhubBuffer(buf) {
  if (!(buf instanceof Uint8Array)) {
    return { ok: false, error: 'Not a Uint8Array' };
  }
  if (buf.length < RFHUB_MIN_SIZE) {
    return { ok: false, error: `File too small: ${buf.length} bytes (need >= ${RFHUB_MIN_SIZE})` };
  }
  // Sanity: the ring buffer area should not be all 0x00 or all 0xFF
  const rb      = buf.slice(KEY_RB_BASE, KEY_RB_BASE + KEY_RB_SIZE);
  const allZero = rb.every(b => b === 0x00);
  const allFF   = rb.every(b => b === 0xFF);
  if (allZero || allFF) {
    return { ok: false, error: 'Key ring buffer area appears erased or blank — not a valid RFHUB dump' };
  }
  // Must contain at least one byte of the expected 5A fill pattern
  const has5A = rb.some(b => b === 0x5A);
  if (!has5A) {
    return { ok: false, error: 'Key ring buffer area does not contain expected 5A fill pattern' };
  }
  return { ok: true };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
