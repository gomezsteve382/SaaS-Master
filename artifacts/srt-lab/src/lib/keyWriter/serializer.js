/* ============================================================================
 * serializer.js — turn an RFHUB slot (from parseKeySlots) plus the BCM
 * shared secret into the byte payload for a CMD.BURN_KEY frame.
 *
 * BURN_KEY payload shape (little-endian fields):
 *
 *   +--------+----------+-------------+-----------+-----------+----------+
 *   | chip   | uidLen   | payloadLen  | UID …     | PAYLOAD …  | SEC16    |
 *   |  u8    |  u8      |  u8         | uidLen B  | payloadLen | 16 B     |
 *   +--------+----------+-------------+-----------+-----------+----------+
 *
 *   chip   = chipFamily.id mapped to a one-byte ordinal (see CHIP_ORDINAL).
 *   UID    = first uidLen bytes of slot.idBytes.
 *   PAYLOAD= remaining bytes (slot.idBytes.length - uidLen).
 *   SEC16  = canonical RFHUB SEC16 master secret (big-endian, 16 B).
 *
 * The writer uses SEC16 + UID to derive the per-chip authentication
 * material the chip needs to accept a write. We never transmit the raw
 * BCM-side reversed SEC16 here; the caller passes the already-resolved
 * RFHUB-side big-endian secret.
 *
 * Refuse-on-doubt:
 *   - Slot must be marked occupied (AA-50 present).
 *   - slot.idMapped must be true (parseKeySlots could find the ID block).
 *   - slot.idBytes length must equal chip.uidBytes + chip.payloadBytes.
 *   - secret16 must be 16 bytes and non-blank (not all 0xFF / 0x00).
 *   - chip family must list the requested writer in `writers`.
 * ========================================================================== */

import { CMD, buildFrame } from './protocol.js';
import { chipFamily } from './chipFamilies.js';

export const CHIP_ORDINAL = {
  'pcf7953':     0x01,
  'pcf7945':     0x02,
  'megamos-aes': 0x10,
};

function isBlankSecret(s) {
  let allFF = true, all00 = true;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== 0xFF) allFF = false;
    if (s[i] !== 0x00) all00 = false;
    if (!allFF && !all00) return false;
  }
  return allFF || all00;
}

/** Build a BURN_KEY request for one slot. Returns { ok, frame, ... }.
 *  On refuse-on-doubt failure returns { ok:false, error, reason }. */
export function buildBurnRequest({ slot, chipId, writer, secret16 } = {}) {
  if (!slot) return { ok: false, error: 'no slot supplied', reason: 'missing-slot' };
  if (!slot.occupied) return { ok: false, error: `slot ${slot.idx} is empty (AA-50 absent) — nothing to burn`, reason: 'slot-empty' };
  if (!slot.idMapped || !slot.idBytes) {
    return { ok: false, error: `slot ${slot.idx} ID block not mapped by parseKeySlots`, reason: 'id-unmapped' };
  }
  const chip = chipFamily(chipId);
  if (!chip) return { ok: false, error: `unknown chip family: ${chipId}`, reason: 'bad-chip' };
  if (writer && !chip.writers.includes(writer)) {
    return { ok: false, error: `chip ${chip.id} not supported by writer ${writer}`, reason: 'writer-unsupported' };
  }
  const expectedLen = chip.uidBytes + chip.payloadBytes;
  if (slot.idBytes.length < chip.uidBytes) {
    return { ok: false, error: `slot ${slot.idx} idBytes too short (${slot.idBytes.length} B) for ${chip.id} (needs ${expectedLen} B)`, reason: 'id-too-short' };
  }
  if (slot.idBytes.length !== expectedLen) {
    return { ok: false, error: `slot ${slot.idx} idBytes length ${slot.idBytes.length} ≠ chip ${chip.id} expected ${expectedLen}`, reason: 'id-shape-mismatch' };
  }
  if (!secret16 || secret16.length !== 16) {
    return { ok: false, error: 'SEC16 master secret must be 16 bytes', reason: 'bad-secret-len' };
  }
  const sec = secret16 instanceof Uint8Array ? secret16 : new Uint8Array(secret16);
  if (isBlankSecret(sec)) {
    return { ok: false, error: 'SEC16 master secret is blank (all 0xFF / 0x00) — refusing to burn against a virgin secret', reason: 'blank-secret' };
  }
  const ord = CHIP_ORDINAL[chip.id];
  if (ord == null) {
    return { ok: false, error: `chip family ${chip.id} has no protocol ordinal`, reason: 'no-ordinal' };
  }
  const uid = slot.idBytes.slice(0, chip.uidBytes);
  const pl  = slot.idBytes.slice(chip.uidBytes);
  const payload = new Uint8Array(3 + uid.length + pl.length + 16);
  payload[0] = ord;
  payload[1] = uid.length;
  payload[2] = pl.length;
  payload.set(uid, 3);
  payload.set(pl, 3 + uid.length);
  payload.set(sec, 3 + uid.length + pl.length);
  return {
    ok: true,
    frame: buildFrame(CMD.BURN_KEY, payload),
    payload,
    chip,
    uidHex: [...uid].map((b) => b.toString(16).padStart(2, '0')).join(''),
    payloadHex: [...pl].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

/** Build a CMD.DETECT_CHIP request — payload is the expected chip ordinal
 *  so the writer can refuse the wrong family without burning. */
export function buildDetectRequest({ chipId } = {}) {
  const chip = chipFamily(chipId);
  if (!chip) return { ok: false, error: `unknown chip family: ${chipId}`, reason: 'bad-chip' };
  const ord = CHIP_ORDINAL[chip.id];
  return { ok: true, frame: buildFrame(CMD.DETECT_CHIP, new Uint8Array([ord])) };
}

/** Build a CMD.PING request (no payload). */
export function buildPingRequest() {
  return { ok: true, frame: buildFrame(CMD.PING) };
}

/** Build a CMD.VERIFY request — same payload shape as BURN_KEY so the
 *  writer can read the chip back and compare against the expected bytes. */
export function buildVerifyRequest(args) {
  const r = buildBurnRequest(args);
  if (!r.ok) return r;
  // Re-build with VERIFY opcode instead of BURN_KEY.
  return {
    ...r,
    frame: buildFrame(CMD.VERIFY, r.payload),
  };
}
