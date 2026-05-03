/* ======================================================================
 * UDS Frame Builder — BCM configuration (Task #588)
 * ======================================================================
 *
 * Builds WDBI (0x2E) and RoutineControl (0x31) frames from the mined
 * udsServiceMap.generated.json and bcmConfigTab.generated.json catalogs.
 *
 * The core operation is read-modify-write:
 *   1. Caller supplies the current DID payload bytes (from a prior RDBI).
 *   2. buildWdbiFrame() modifies the target bitfield and wraps the result
 *      in a complete WriteDataByIdentifier frame.
 *   3. getPostWriteSteps() returns the ordered list of follow-up service
 *      calls AlfaOBD performs after the write (proxiAlign, ecuReset, …).
 *
 * NO direct CAN / adapter calls here — callers use their own engine.uds().
 */

import { getBcmGroups, getBcmUdsSequence } from "./index.js";

/* ---------------------------------------------------------------------- */
/* Bit helpers (MSB-first, same convention as cgwConfig.js readBits)       */
/* ---------------------------------------------------------------------- */

/**
 * Read `bitLength` bits at `bitOffset` (MSB-first) from `bytes`.
 * Returns null if the field falls off the end of the buffer.
 */
export function readBits(bytes, bitOffset, bitLength) {
  if (!bytes || bitLength <= 0) return null;
  let v = 0;
  for (let i = 0; i < bitLength; i++) {
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) return null;
    v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
  }
  return v;
}

/**
 * Write `bitLength` bits at `bitOffset` (MSB-first) into a Uint8Array.
 * Mutates `bytes` in place. Throws if the field falls outside the buffer.
 */
export function writeBits(bytes, bitOffset, bitLength, value) {
  if (!bytes || bitLength <= 0) return;
  const mask = (1 << bitLength) - 1;
  const masked = value & mask;
  for (let i = 0; i < bitLength; i++) {
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) {
      throw new RangeError(
        `writeBits: bit ${abs} (byte ${byteIdx}) is outside buffer length ${bytes.length}`
      );
    }
    const bit = (masked >> (bitLength - 1 - i)) & 1;
    if (bit) {
      bytes[byteIdx] |= 1 << bitIdx;
    } else {
      bytes[byteIdx] &= ~(1 << bitIdx);
    }
  }
}

/* ---------------------------------------------------------------------- */
/* DID helpers                                                              */
/* ---------------------------------------------------------------------- */

/** Parse a DID string ("0xDE00", "DE00", 0xDE00) → { hi, lo }. */
function parseDid(did) {
  const n = typeof did === "number" ? did : parseInt(String(did).replace(/^0x/i, ""), 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xFFFF) {
    throw new TypeError(`Invalid DID: ${did}`);
  }
  return { hi: (n >> 8) & 0xFF, lo: n & 0xFF, n };
}

/** Minimum payload byte length for a DID based on the catalog. */
function minPayloadLength(did) {
  const groups = getBcmGroups();
  const { n } = parseDid(did);
  const didHex = "0x" + n.toString(16).toUpperCase().padStart(4, "0");
  const group = groups.find((g) => g.did.toUpperCase() === didHex.toUpperCase());
  if (!group || !group.options || group.options.length === 0) return 1;
  let maxBit = 0;
  for (const opt of group.options) {
    const end = opt.bit + opt.length;
    if (end > maxBit) maxBit = end;
  }
  return Math.ceil(maxBit / 8);
}

/* ---------------------------------------------------------------------- */
/* Frame builders                                                           */
/* ---------------------------------------------------------------------- */

/**
 * Build a complete WDBI (0x2E) frame using a read-modify-write approach.
 *
 * @param {string|number} did        - DID to write (e.g. "0xDE07" or 0xDE07)
 * @param {Uint8Array}    currentPayload - Full current DID payload from a prior RDBI.
 *                                        Must NOT include the "62 hi lo" header.
 * @param {number}        bitOffset  - Bit position of the field (MSB-first)
 * @param {number}        bitLength  - Field width in bits
 * @param {number}        newValue   - New value to write into the field
 * @returns {number[]}               - Complete UDS frame bytes (0x2E, hi, lo, …payload)
 */
export function buildWdbiFrame(did, currentPayload, bitOffset, bitLength, newValue) {
  if (!(currentPayload instanceof Uint8Array)) {
    throw new TypeError("currentPayload must be a Uint8Array (full DID payload, no 62-header)");
  }
  const { hi, lo } = parseDid(did);
  const minLen = minPayloadLength(did);
  const payloadLen = Math.max(currentPayload.length, minLen);
  const modified = new Uint8Array(payloadLen);
  modified.set(currentPayload.slice(0, Math.min(currentPayload.length, payloadLen)));
  writeBits(modified, bitOffset, bitLength, newValue);
  return [0x2E, hi, lo, ...Array.from(modified)];
}

/**
 * Convenience: build a WDBI frame from a catalog option looked up by name.
 *
 * @param {string|number} did         - DID (e.g. "0xDE07")
 * @param {string}        optionName  - Option name as it appears in bcmConfigTab
 * @param {Uint8Array}    currentPayload
 * @param {number}        newValue
 * @returns {{ frame: number[], option: object }|null}
 */
export function buildWdbiFrameByName(did, optionName, currentPayload, newValue) {
  const groups = getBcmGroups();
  const { n } = parseDid(did);
  const didHex = "0x" + n.toString(16).toUpperCase().padStart(4, "0");
  const group = groups.find((g) => g.did.toUpperCase() === didHex.toUpperCase());
  if (!group) return null;
  const option = group.options.find((o) => o.name === optionName);
  if (!option) return null;
  return {
    frame: buildWdbiFrame(did, currentPayload, option.bit, option.length, newValue),
    option,
  };
}

/**
 * Build a RoutineControl (0x31) startRoutine frame.
 *
 * @param {string} routineType - One of "proxiAlign" | "clearDtc"
 * @returns {number[]}          UDS frame bytes
 */
export function buildRoutineControlFrame(routineType) {
  const seq = getBcmUdsSequence();
  switch (routineType) {
    case "proxiAlign": {
      const r = seq.writeConfig.postWriteRoutines.proxiAlign;
      const id = parseInt(r.routineId.replace(/^0x/i, ""), 16);
      return [0x31, 0x01, (id >> 8) & 0xFF, id & 0xFF];
    }
    case "clearDtc": {
      return [0x14, 0xFF, 0xFF, 0xFF];
    }
    case "ecuReset": {
      return [0x11, 0x01];
    }
    default:
      throw new Error(`Unknown post-write routine type: ${routineType}`);
  }
}

/**
 * Return the ordered list of post-write UDS frames for a given option.
 * Callers should issue these in sequence after the WDBI succeeds.
 *
 * @param {object} option - An option entry from bcmConfigTab.generated.json
 * @returns {Array<{ label: string, frame: number[] }>}
 */
export function getPostWriteSteps(option) {
  const steps = [];
  const routines = Array.isArray(option.postWrite) ? option.postWrite : [];
  for (const r of routines) {
    steps.push({ label: r, frame: buildRoutineControlFrame(r) });
  }
  return steps;
}

/**
 * Build the full write sequence for one BCM config option:
 *   [RDBI for current payload] → [WDBI modified] → [post-write routines]
 *
 * Returns a descriptor object — the caller drives the actual UDS engine calls.
 *
 * @param {string|number} did
 * @param {string}        optionName
 * @param {Uint8Array}    currentPayload
 * @param {number}        newValue
 * @returns {{ didN: number, wdbiFrame: number[], postWrite: Array<{label,frame}>, option: object }|null}
 */
export function buildOptionWriteSequence(did, optionName, currentPayload, newValue) {
  const result = buildWdbiFrameByName(did, optionName, currentPayload, newValue);
  if (!result) return null;
  return {
    didN: parseDid(did).n,
    wdbiFrame: result.frame,
    postWrite: getPostWriteSteps(result.option),
    option: result.option,
  };
}
