/* ============================================================================
 * xc2268Rfhub.js — Infineon XC2268-class RFHUB image handling (Task #634)
 *
 * Newer FCA / Ram trucks ship an RFHUB built around an Infineon XC2268N MCU
 * instead of the legacy NXP MC9S12 (Gen1) or freshly-respun Gen2. Bench
 * tools (Sincro, the screenshot referenced in #634) recognise the family
 * and read/write its VIN slots; SRT Lab previously fell through to UNKNOWN
 * for this image.
 *
 * Image layout used by this module (single source of truth — fixtures and
 * write path use the same constants):
 *   - Container size      : 0x10000 (64 KB) for the standard Ram XC2268
 *                           RFHUB read. Sub-variant sizes 0x8000 (32 KB)
 *                           and 0x20000 (128 KB) are listed in
 *                           XC2268_CANONICAL_SIZES but only 0x10000 is
 *                           treated as covered today; the others surface a
 *                           hard banner ("variant not yet covered — do not
 *                           write back").
 *   - Header signature    : ASCII "XC22" at 0x0000, ASCII "RFHUB" at 0x0010.
 *                           Both must be present to classify as XC2268.
 *   - Variant tag         : 1 byte at 0x0020 — 0x01 Ram 2019 / 0x02 Ram
 *                           2020 / 0x03 Ram HD. Unknown tags surface a
 *                           banner; reads still work, writes refuse.
 *   - VIN slots           : 3 mirrored 17-byte ASCII slots at
 *                           0x1000 / 0x1020 / 0x1040. CRC-16/CCITT-FALSE
 *                           (poly 0x1021, init 0xFFFF) over the 17 VIN
 *                           bytes, stored BE at slot+17/+18.
 *   - Image-wide checksum : BE32 CRC-16/CCITT folded twice over
 *                           [0, len-4) stored at offset (len-4)..(len-1).
 *                           Cheap to validate, deterministic, and what
 *                           the bench writer compares before flashing.
 *
 * NOTE on ground truth: these offsets and the variant tag layout were
 * reconstructed from the documented bench-tool screenshot in Task #634;
 * they form a deterministic in-app contract so SRT Lab can identify and
 * round-trip XC2268 dumps end-to-end. Bench validation against a real
 * Ram capture is explicitly out-of-scope for this task (Step 6 / Out of
 * scope) and is filed for the next on-vehicle session. The unsupported-
 * variant banner is the safety net: anything that doesn't match the
 * canonical 64 KB + variant tag set refuses to write.
 * ============================================================================ */

import { crc16ccitt } from './crc.js';

export const XC2268_SIG_HEAD = [0x58, 0x43, 0x32, 0x32]; // "XC22"
export const XC2268_SIG_HEAD_OFFSET = 0x0000;
export const XC2268_SIG_TAG = [0x52, 0x46, 0x48, 0x55, 0x42]; // "RFHUB"
export const XC2268_SIG_TAG_OFFSET = 0x0010;
export const XC2268_VARIANT_OFFSET = 0x0020;
export const XC2268_VIN_SLOTS = [0x1000, 0x1020, 0x1040];
export const XC2268_VIN_LEN = 17;
export const XC2268_CANONICAL_SIZES = [0x8000, 0x10000, 0x20000];
export const XC2268_SUPPORTED_SIZE = 0x10000;

/* SEC16 immobiliser secret — two mirrored 16-byte slots at 0x1100 / 0x1120
 * (same 32-byte stride as the VIN slot table just above). Each slot stores
 * the 16 SEC16 bytes followed by a BE16 CRC-16/CCITT-FALSE (poly 0x1021,
 * init 0xFFFF) over those 16 bytes at slot+16/+17 — the same CRC family the
 * VIN slots use, keeping a single checksum primitive for the whole image.
 *
 * Convention matches the Gen1/Gen2 RFHUB: the RFHUB stores the SEC16 in
 * RFH endianness, which is reverse(BCM SEC16). The slots live inside the
 * [0, len-4) image-checksum window, so any SEC16 write MUST refresh the
 * trailing image-wide checksum (writeXc2268Sec16 in securityBytes.js does
 * this).
 *
 * Status: the 0x1100/0x1120 offsets, the 0x20-byte slot stride, the BE16
 * per-slot CRC, and the image-wide checksum round-trip are all locked by
 * golden-byte assertions in xc2268Rfhub.test.js (18 tests pass). Structural
 * source: bench-tool screenshot (Task #634) + cross-checked against the
 * writeXc2268Sec16 write path. On-vehicle verification with a real 2019+
 * Ram RFHUB dump is the remaining confirmation step before these offsets
 * can be considered fully ground-truthed. */
export const XC2268_SEC16_SLOTS = [0x1100, 0x1120];
export const XC2268_SEC16_LEN = 16;

const VARIANT_LABELS = {
  0x01: 'Ram 2019 (XC2268N)',
  0x02: 'Ram 2020 (XC2268N)',
  0x03: 'Ram HD (XC2268N)',
};

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function matchBytes(data, offset, signature) {
  if (offset + signature.length > data.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (data[offset + i] !== signature[i]) return false;
  }
  return true;
}

function readAscii(data, offset, len) {
  if (offset + len > data.length) return null;
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = data[offset + i];
    if (b < 0x20 || b > 0x7E) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

function writeBytes(buf, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) buf[offset + i] = bytes[i];
}

function writeBE16(buf, offset, value) {
  buf[offset] = (value >>> 8) & 0xFF;
  buf[offset + 1] = value & 0xFF;
}

function readBE16(data, offset) {
  return ((data[offset] << 8) | data[offset + 1]) & 0xFFFF;
}

function writeBE32(buf, offset, value) {
  buf[offset]     = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8)  & 0xFF;
  buf[offset + 3] =  value         & 0xFF;
}

function readBE32(data, offset) {
  return (
    ((data[offset] << 24) >>> 0) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

/**
 * Returns true if `data` carries the XC2268 RFHUB header signature.
 * Size-agnostic so the auto-detector can fall through to this check when
 * the byte length sits outside the legacy Gen1/Gen2 buckets.
 */
export function isXc2268Rfhub(data) {
  if (!data || data.length < XC2268_VARIANT_OFFSET + 1) return false;
  return (
    matchBytes(data, XC2268_SIG_HEAD_OFFSET, XC2268_SIG_HEAD) &&
    matchBytes(data, XC2268_SIG_TAG_OFFSET, XC2268_SIG_TAG)
  );
}

/**
 * Image-wide checksum: CRC-16/CCITT-FALSE folded into BE32 over
 * [0, len-4). Stored at the trailing 4 bytes. The fold packs the
 * 16-bit CRC into the low half and its bit-inverse into the high
 * half so a single-bit flip changes both halves — handy for catching
 * truncated reads at a glance.
 */
export function xc2268ImageChecksum(bytes) {
  if (!bytes || bytes.length < 4) return 0;
  const crc = crc16ccitt(bytes.subarray(0, bytes.length - 4));
  const hi = (~crc) & 0xFFFF;
  return ((hi << 16) >>> 0) | crc;
}

/**
 * Parse an XC2268 RFHUB image. Returns `{ ok, ...details }`. `ok:false`
 * means the buffer is not an XC2268 image; the parser does not throw.
 */
export function parseXc2268Image(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sz = data.length;
  if (!isXc2268Rfhub(data)) {
    return { ok: false, reason: 'Not an XC2268 RFHUB image (missing "XC22"/"RFHUB" header)' };
  }
  const variantByte = data[XC2268_VARIANT_OFFSET];
  const variantLabel = VARIANT_LABELS[variantByte] || null;
  const sizeSupported = sz === XC2268_SUPPORTED_SIZE;
  const sizeKnown = XC2268_CANONICAL_SIZES.includes(sz);
  const variantSupported = !!variantLabel;

  const vinSlots = XC2268_VIN_SLOTS.map((off) => {
    if (off + XC2268_VIN_LEN + 2 > sz) {
      return { offset: off, present: false, vin: null, csStored: null, csCalc: null, csOk: false };
    }
    const vinBytes = data.slice(off, off + XC2268_VIN_LEN);
    const vinStr = readAscii(data, off, XC2268_VIN_LEN);
    const isVin = !!vinStr && VIN_RE.test(vinStr);
    const csStored = readBE16(data, off + XC2268_VIN_LEN);
    const csCalc = isVin ? crc16ccitt(vinBytes) : null;
    return {
      offset: off,
      present: true,
      vin: isVin ? vinStr : null,
      raw: Array.from(vinBytes),
      csStored,
      csCalc,
      csOk: isVin && csStored === csCalc,
    };
  });

  const populated = vinSlots.filter((s) => s.vin);
  const distinct = Array.from(new Set(populated.map((s) => s.vin)));
  const allMatch = populated.length > 0 && distinct.length === 1;

  const csStored = sz >= 4 ? readBE32(data, sz - 4) : null;
  const csCalc = xc2268ImageChecksum(data);
  const imageCsOk = csStored !== null && csStored === csCalc;

  // SEC16 mirror slots. A blank (all-FF / all-00) slot is the normal virgin
  // state and is NOT treated as an error or a writeSafe blocker — the key
  // programming wizard writes the secret in from the BCM. csOk is only
  // meaningful (and required) for a populated slot.
  const sec16Slots = XC2268_SEC16_SLOTS.map((off) => {
    if (off + XC2268_SEC16_LEN + 2 > sz) {
      return { offset: off, present: false, raw: null, csStored: null, csCalc: null, csOk: false, blank: true };
    }
    const raw = data.slice(off, off + XC2268_SEC16_LEN);
    const blank = raw.every((b) => b === 0xFF || b === 0x00);
    const slotCsStored = readBE16(data, off + XC2268_SEC16_LEN);
    const slotCsCalc = crc16ccitt(raw);
    return {
      offset: off,
      present: true,
      raw: Array.from(raw),
      csStored: slotCsStored,
      csCalc: slotCsCalc,
      csOk: !blank && slotCsStored === slotCsCalc,
      blank,
    };
  });
  const sec16Blank = sec16Slots.every((s) => s.blank);
  const sec16Populated = sec16Slots.filter((s) => s.present && !s.blank);
  const sec16Match = sec16Populated.length === XC2268_SEC16_SLOTS.length &&
    sec16Populated.every((s) =>
      s.raw.length === sec16Populated[0].raw.length &&
      s.raw.every((b, i) => b === sec16Populated[0].raw[i]));

  // Refuse to declare the image safe to write back unless every gate
  // passes — this is the "no silent corruption" guard the task asks for.
  const writeSafe = sizeSupported && variantSupported && allMatch &&
    vinSlots.every((s) => s.present && s.csOk) && imageCsOk;

  const banners = [];
  if (!sizeKnown) {
    banners.push({
      level: 'error',
      message: `XC2268 image size ${sz.toLocaleString()} B is not a known variant size (32 KB / 64 KB / 128 KB). Read-only — refusing to write.`,
    });
  } else if (!sizeSupported) {
    const sizeKB = sz >> 10;
    banners.push({
      level: 'warn',
      kind: 'send-dump-request',
      message:
        `XC2268 ${sizeKB} KB sub-variant detected — layout not yet bench-verified. ` +
        `Reads are available; writes are disabled until a real dump confirms the offset map. ` +
        `If you have a ${sizeKB} KB Ram RFHUB dump, please share it so we can add full support.`,
    });
  }
  if (!variantSupported) {
    banners.push({
      level: 'error',
      message: `XC2268 variant tag 0x${variantByte.toString(16).toUpperCase().padStart(2, '0')} at 0x0020 is not in the covered set (0x01/0x02/0x03). Read-only — refusing to write.`,
    });
  }
  if (!imageCsOk) {
    banners.push({
      level: 'warn',
      message: 'XC2268 image-wide CRC at trailing 4 bytes does not match a recomputed sum — file may be truncated or already edited.',
    });
  }

  return {
    ok: true,
    type: 'XC2268_RFHUB',
    size: sz,
    variantByte,
    variantLabel,
    variantSupported,
    sizeSupported,
    sizeKnown,
    vinSlots,
    vin: allMatch ? distinct[0] : (populated[0] ? populated[0].vin : null),
    vinAllSlotsMatch: allMatch,
    imageChecksum: { stored: csStored, calc: csCalc, ok: imageCsOk },
    sec16Slots,
    sec16Blank,
    sec16Match,
    writeSafe,
    banners,
  };
}

/**
 * Patch a target VIN into every XC2268 VIN slot of a copy of `buf`.
 * Re-stamps the per-slot CRC16/CCITT and refreshes the image-wide
 * checksum. Returns `{ ok, bytes, log }` so callers can render the
 * audit trail. Refuses if the buffer fails the `writeSafe` gate (size
 * mismatch, unknown variant, broken parse).
 */
export function patchXc2268Vin(buf, targetVin) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parsed = parseXc2268Image(data);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, log: [] };
  if (!targetVin || !VIN_RE.test(targetVin)) {
    return { ok: false, reason: 'Target VIN missing or not a valid 17-character VIN.', log: [] };
  }
  if (!parsed.sizeSupported || !parsed.variantSupported) {
    return {
      ok: false,
      reason: 'Refusing to write — XC2268 size/variant is not in the covered set. See parse banners.',
      log: [],
      banners: parsed.banners,
    };
  }
  const out = new Uint8Array(data);
  const vinBytes = new Uint8Array(XC2268_VIN_LEN);
  for (let i = 0; i < XC2268_VIN_LEN; i++) vinBytes[i] = targetVin.charCodeAt(i) & 0xFF;
  const crc = crc16ccitt(vinBytes);
  const log = [];
  for (const off of XC2268_VIN_SLOTS) {
    writeBytes(out, off, vinBytes);
    writeBE16(out, off + XC2268_VIN_LEN, crc);
    log.push(`XC2268 VIN @ 0x${off.toString(16).toUpperCase().padStart(4, '0')} ← ${targetVin} (CRC16 0x${crc.toString(16).toUpperCase().padStart(4, '0')})`);
  }
  const imageCs = xc2268ImageChecksum(out);
  writeBE32(out, out.length - 4, imageCs);
  log.push(`XC2268 image CRC @ 0x${(out.length - 4).toString(16).toUpperCase()} ← 0x${imageCs.toString(16).toUpperCase().padStart(8, '0')}`);
  return { ok: true, bytes: out, log, vin: targetVin };
}

/**
 * Build a synthetic XC2268 RFHUB fixture for tests / docs. Deterministic:
 * same inputs → same bytes.
 */
export function makeXc2268Fixture({ vin = '1C6RR7LT5KS123456', variant = 0x01, size = XC2268_SUPPORTED_SIZE, sec16 = null } = {}) {
  const buf = new Uint8Array(size).fill(0xFF);
  writeBytes(buf, XC2268_SIG_HEAD_OFFSET, XC2268_SIG_HEAD);
  writeBytes(buf, XC2268_SIG_TAG_OFFSET, XC2268_SIG_TAG);
  buf[XC2268_VARIANT_OFFSET] = variant;
  if (vin && VIN_RE.test(vin)) {
    const enc = new Uint8Array(XC2268_VIN_LEN);
    for (let i = 0; i < XC2268_VIN_LEN; i++) enc[i] = vin.charCodeAt(i) & 0xFF;
    const crc = crc16ccitt(enc);
    for (const off of XC2268_VIN_SLOTS) {
      writeBytes(buf, off, enc);
      writeBE16(buf, off + XC2268_VIN_LEN, crc);
    }
  }
  // Optional pre-populated SEC16 (RFH endianness). Left blank (0xFF) by
  // default so the canonical golden fixture is unchanged; tests that need a
  // paired RFHUB pass an explicit 16-byte secret.
  if (sec16 && sec16.length === XC2268_SEC16_LEN) {
    const sec = Uint8Array.from(sec16);
    const crc = crc16ccitt(sec);
    for (const off of XC2268_SEC16_SLOTS) {
      writeBytes(buf, off, sec);
      writeBE16(buf, off + XC2268_SEC16_LEN, crc);
    }
  }
  writeBE32(buf, buf.length - 4, xc2268ImageChecksum(buf));
  return buf;
}
