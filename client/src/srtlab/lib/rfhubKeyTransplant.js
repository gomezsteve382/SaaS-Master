/**
 * rfhubKeyTransplant.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gen2 RFHUB (XC2268 / 95640) key ring-buffer transplant engine.
 *
 * CONFIRMED FORMAT (bench-verified against 21RFHUB_6.2_REDKEY_PRORGRAMMED.bin
 * and RFHUB_21_JAILBREAK)OG_6.2_OG.bin):
 *
 *   Key ring buffer base  : 0x0C80
 *   Key ring buffer size  : 0x0100 bytes (32 × 8-byte entries)
 *   Key entry size        : 8 bytes
 *   Entry layout          : [chip_id_LE(4)] [flag(1)] [count(1)] [0xFF 0xFF(2)]
 *   Empty fill pattern    : 5A 5A 95 00 FF FF (repeating, NOT 8-byte aligned)
 *   Duplicate rule        : every key is written TWICE consecutively
 *
 *   CRITICAL: The ring buffer is a BYTE-STREAM circular buffer, NOT 8-byte
 *   aligned slots. Entries are written consecutively as a stream of bytes.
 *   The firmware's write pointer is stored externally (at ~0x0AB0) and is
 *   updated by the Autel/WiTECH tool after each key write. For offline
 *   transplant we do NOT need to update the external pointer — the firmware
 *   scans the ENTIRE ring buffer for valid entries on boot.
 *
 *   KNOWN FLAGS (bench-verified):
 *     0x01 = standard Hitag2 key (most common)
 *     0x03 = alt-family key (flag 0x03 entries)
 *     0x48 = red key (Hitag AES, Fiat/Chrysler)
 *     0xE6 = black key (Hitag AES, Fiat/Chrysler)
 *   Only entries with these flags are treated as transplantable keys.
 *   Other entries (historical log data, counters, etc.) are ignored.
 *
 *   WRITE POINTER: After scanning byte-by-byte for all valid entries,
 *   the write pointer is the byte offset immediately following the last
 *   valid entry's second copy. New entries are appended there.
 *
 * No checksums are involved in the key ring buffer — only the VIN ring buffer
 * uses the XOR-magic checksum scheme.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Ring buffer constants (bench-verified) */
export const KEY_RB_BASE    = 0x0C80;
export const KEY_RB_SIZE    = 0x0100;   // 256 bytes = 32 × 8-byte entries
export const KEY_ENTRY_SZ   = 8;
export const KEY_SLOT_COUNT = KEY_RB_SIZE / KEY_ENTRY_SZ; // 32 slots

/** Minimum RFHUB bin size (32 KB for 95640) */
export const RFHUB_MIN_SIZE = 0x8000;

/**
 * Known transplantable key flags (bench-verified).
 * Entries with other flags are historical log data and must not be transplanted.
 */
const KNOWN_FLAGS = new Set([0x01, 0x03, 0x48, 0xE6]);

/**
 * Empty fill pattern (first 6 bytes of an empty area).
 * The ring buffer is filled with 5A 5A 95 00 FF FF repeating.
 */
const EMPTY_FILL_PREFIX = [0x5A, 0x5A, 0x95, 0x00];

/**
 * Scan the key ring buffer byte-by-byte and return all valid key entries.
 *
 * The ring buffer is a BYTE-STREAM — entries are NOT 8-byte aligned.
 * We scan every byte position for the pattern: [4B chip_id_LE][1B flag][1B count][FF FF].
 * Only entries with known flags are returned.
 *
 * @param {Uint8Array} buf  RFHUB binary buffer
 * @returns {{ chipId: string, flag: number, count: number, addr: number }[]}
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
    if (buf[i + 6] !== 0xFF || buf[i + 7] !== 0xFF) {
      i++;
      continue;
    }

    const flag = buf[i + 4];

    // Only accept known flags
    if (!KNOWN_FLAGS.has(flag)) {
      i++;
      continue;
    }

    // Skip empty fill pattern (5A 5A 95 00 ...)
    if (buf[i]   === EMPTY_FILL_PREFIX[0] &&
        buf[i+1] === EMPTY_FILL_PREFIX[1] &&
        buf[i+2] === EMPTY_FILL_PREFIX[2] &&
        buf[i+3] === EMPTY_FILL_PREFIX[3]) {
      i++;
      continue;
    }

    // Skip all-zero chip ID
    if (buf[i] === 0 && buf[i+1] === 0 && buf[i+2] === 0 && buf[i+3] === 0) {
      i++;
      continue;
    }

    // Valid entry: convert chip ID from LE to BE hex string
    const chipId = [buf[i+3], buf[i+2], buf[i+1], buf[i]]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

    const count = buf[i + 5];

    // Deduplicate — each entry appears twice consecutively
    if (!seen.has(chipId)) {
      seen.add(chipId);
      entries.push({ chipId, flag, count, addr: i });
    }

    i += KEY_ENTRY_SZ;
  }

  return entries;
}

/**
 * Find the write pointer: the byte offset immediately after the last valid
 * key entry in the ring buffer.
 *
 * The ring buffer is a byte-stream — we scan byte-by-byte for the last
 * valid entry and return its end offset. Returns KEY_RB_BASE if no entries
 * are found (empty ring buffer). Returns null if the ring buffer is full
 * (no room for even one more entry pair = 16 bytes).
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
    // Valid entry found
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
 * Count how many additional key PAIRS (each pair = 2 × 8 bytes = 16 bytes)
 * can fit in the ring buffer starting at the write pointer.
 *
 * @param {Uint8Array} buf
 * @param {number} writePtr  offset returned by findWritePointer
 * @returns {number}  number of key pairs that can be appended
 */
export function countFreeSlots(buf, writePtr) {
  const rbEnd = KEY_RB_BASE + KEY_RB_SIZE;
  const bytesAvailable = rbEnd - writePtr;
  // Each key requires 2 entries × 8 bytes = 16 bytes
  return Math.floor(bytesAvailable / (KEY_ENTRY_SZ * 2));
}

/**
 * Transplant keys from a donor RFHUB buffer into a target RFHUB buffer.
 *
 * @param {Uint8Array} donorBuf   Donor RFHUB binary (read-only)
 * @param {Uint8Array} targetBuf  Target RFHUB binary (will be cloned)
 * @param {object}     [opts]
 * @param {string[]}   [opts.only]              If set, only transplant these chip IDs
 * @param {boolean}    [opts.skipDuplicates=true]  Skip keys already in target
 *
 * @returns {{
 *   patched:     Uint8Array,
 *   injected:    { chipId: string, flag: number, count: number }[],
 *   skipped:     { chipId: string, reason: string }[],
 *   writePtr:    number,
 *   newWritePtr: number,
 * }}
 */
export function transplantKeys(donorBuf, targetBuf, opts = {}) {
  const { only = null, skipDuplicates = true } = opts;

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

  // Capacity check: each key needs 2 entries × 8 bytes = 16 bytes
  const pairsAvailable = countFreeSlots(targetBuf, writePtr);
  if (pairsAvailable < toInject.length) {
    throw new Error(
      `Not enough space in target ring buffer: need ${toInject.length} key pair(s), have ${pairsAvailable}`
    );
  }

  // Clone target buffer and inject
  const patched = new Uint8Array(targetBuf);
  let ptr = writePtr;

  for (const key of toInject) {
    // Build 8-byte entry: [chip_id_LE(4)][flag(1)][count(1)][0xFF 0xFF(2)]
    const entry = new Uint8Array(8);
    const chipBytes = hexToBytes(key.chipId); // big-endian → reverse to LE
    entry[0] = chipBytes[3];
    entry[1] = chipBytes[2];
    entry[2] = chipBytes[1];
    entry[3] = chipBytes[0];
    entry[4] = key.flag;
    entry[5] = key.count;
    entry[6] = 0xFF;
    entry[7] = 0xFF;

    // Write twice (ring buffer protocol)
    patched.set(entry, ptr);
    patched.set(entry, ptr + KEY_ENTRY_SZ);
    ptr += KEY_ENTRY_SZ * 2;
  }

  return {
    patched,
    injected:    toInject.map(({ chipId, flag, count }) => ({ chipId, flag, count })),
    skipped,
    writePtr,
    newWritePtr: ptr,
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
  const rb     = buf.slice(KEY_RB_BASE, KEY_RB_BASE + KEY_RB_SIZE);
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
