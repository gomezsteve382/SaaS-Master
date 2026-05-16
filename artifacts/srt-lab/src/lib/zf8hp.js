/* ============================================================================
 * zf8hp.js — ZF 8HP TCU image handling: VIN slots + per-block CRC
 *           (Task #634)
 *
 * Bench parity with the "ZF-8HP TCU VIN + CRC" capability in the
 * referenced bench tool. The 8HP family ships on FCA RWD/AWD vehicles as
 * three nameplates with distinct image layouts:
 *
 *   - 845RE : 0x80000 (512 KB) Jeep / Charger / Challenger pre-2017
 *   - 8HP70 : 0x100000 (1 MB) Charger / Challenger / 300 6.4
 *   - 8HP90 : 0x100000 (1 MB) Charger / Challenger SRT / Hellcat / Redeye
 *
 * Image layout (single source of truth — fixtures use the same constants):
 *   - Header signature  : ASCII "ZF8HP" at 0x0000 followed by the variant
 *                         tag at 0x0008 (0x45/0x70/0x90 → 845RE/8HP70/8HP90).
 *   - VIN slots         : 2 mirrored 17-byte ASCII slots per variant
 *                         (table below). CRC-16/CCITT-FALSE over the 17
 *                         VIN bytes, stored BE at slot+17/+18.
 *   - Per-block CRC32   : The image is partitioned into 64 KB blocks. The
 *                         last 4 bytes of each block hold a BE32 CRC-32
 *                         (poly 0xEDB88320, init 0xFFFFFFFF, xorout
 *                         0xFFFFFFFF — standard zlib CRC) over the block's
 *                         preceding (BLOCK_SIZE - 4) bytes. The loader
 *                         walks every block at boot and refuses to engage
 *                         the TCU on any mismatch.
 *
 * Refusal policy: variants outside the covered table OR sizes outside the
 * canonical-for-variant table return `{ ok:false }` so the inspector can
 * surface a clear "ZF-8HP variant not yet covered" banner instead of
 * silently corrupting blocks.
 *
 * Coverage is bench-pending — the constants form a deterministic in-app
 * contract; off-platform verification on a real TCU dump is the next
 * step. The block-CRC machinery is general-purpose (the block size is the
 * variable that needs bench confirmation per variant), so retargeting is
 * a one-line change here.
 * ============================================================================ */

import { crc16ccitt } from './crc.js';

export const ZF8HP_SIG_HEAD = [0x5A, 0x46, 0x38, 0x48, 0x50]; // "ZF8HP"
export const ZF8HP_SIG_OFFSET = 0x0000;
export const ZF8HP_VARIANT_OFFSET = 0x0008;
export const ZF8HP_BLOCK_SIZE = 0x10000; // 64 KB
export const ZF8HP_BLOCK_CRC_LEN = 4;

const VARIANT_TABLE = {
  0x45: {
    key: '845RE',
    label: 'ZF 845RE (Jeep / Charger / Challenger pre-2017)',
    canonicalSize: 0x80000,
    vinSlots: [0x010000, 0x020000],
  },
  0x70: {
    key: '8HP70',
    label: 'ZF 8HP70 (Charger / Challenger / 300 6.4)',
    canonicalSize: 0x100000,
    vinSlots: [0x020000, 0x040000],
  },
  0x90: {
    key: '8HP90',
    label: 'ZF 8HP90 (SRT / Hellcat / Redeye)',
    canonicalSize: 0x100000,
    vinSlots: [0x020000, 0x040000],
  },
};

export const ZF8HP_VARIANTS = Object.freeze(
  Object.entries(VARIANT_TABLE).map(([tagHex, v]) => ({ tag: Number(tagHex), ...v })),
);

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* zlib CRC-32 (poly 0xEDB88320, refin, refout, init/xorout 0xFFFFFFFF). */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32zlib(bytes, init = 0xFFFFFFFF) {
  let c = init >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

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

function readBE16(data, offset) {
  return ((data[offset] << 8) | data[offset + 1]) & 0xFFFF;
}

function writeBE16(buf, offset, value) {
  buf[offset] = (value >>> 8) & 0xFF;
  buf[offset + 1] = value & 0xFF;
}

function readBE32(data, offset) {
  return (
    ((data[offset] << 24) >>> 0) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  ) >>> 0;
}

function writeBE32(buf, offset, value) {
  buf[offset]     = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8)  & 0xFF;
  buf[offset + 3] =  value         & 0xFF;
}

function writeBytes(buf, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) buf[offset + i] = bytes[i];
}

/** True iff `data` carries the ZF-8HP header signature. Size-agnostic. */
export function isZf8hpImage(data) {
  if (!data || data.length < ZF8HP_VARIANT_OFFSET + 1) return false;
  return matchBytes(data, ZF8HP_SIG_OFFSET, ZF8HP_SIG_HEAD);
}

export function zf8hpVariantFor(data) {
  if (!isZf8hpImage(data)) return null;
  const tag = data[ZF8HP_VARIANT_OFFSET];
  return VARIANT_TABLE[tag] ? { tag, ...VARIANT_TABLE[tag] } : { tag, key: null, label: null };
}

/**
 * Recompute every per-block CRC32 of `data`. Returns an array of
 * `{ blockIndex, offset, csOffset, stored, calc, ok }` so callers can
 * render a per-block status table.
 */
export function zf8hpBlockChecksums(data) {
  const out = [];
  const sz = data.length;
  for (let off = 0; off + ZF8HP_BLOCK_SIZE <= sz; off += ZF8HP_BLOCK_SIZE) {
    const csOff = off + ZF8HP_BLOCK_SIZE - ZF8HP_BLOCK_CRC_LEN;
    const region = data.subarray(off, csOff);
    const calc = crc32zlib(region);
    const stored = readBE32(data, csOff);
    out.push({
      blockIndex: out.length,
      offset: off,
      csOffset: csOff,
      stored,
      calc,
      ok: stored === calc,
    });
  }
  return out;
}

/** Parse a ZF-8HP image. `ok:false` when the buffer isn't a ZF-8HP. */
export function parseZf8hpImage(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!isZf8hpImage(data)) {
    return { ok: false, reason: 'Not a ZF-8HP TCU image (missing "ZF8HP" header)' };
  }
  const variant = zf8hpVariantFor(data);
  const sz = data.length;
  const variantSupported = !!(variant && variant.key);
  const sizeSupported = variantSupported && sz === variant.canonicalSize;

  const vinSlots = variantSupported
    ? variant.vinSlots.map((off) => {
        if (off + 17 + 2 > sz) {
          return { offset: off, present: false, vin: null, csStored: null, csCalc: null, csOk: false };
        }
        const vinBytes = data.slice(off, off + 17);
        const vinStr = readAscii(data, off, 17);
        const isVin = !!vinStr && VIN_RE.test(vinStr);
        const csStored = readBE16(data, off + 17);
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
      })
    : [];

  const populated = vinSlots.filter((s) => s.vin);
  const distinct = Array.from(new Set(populated.map((s) => s.vin)));
  const allMatch = populated.length > 0 && distinct.length === 1;

  const blocks = sizeSupported ? zf8hpBlockChecksums(data) : [];
  const blocksOk = blocks.length > 0 && blocks.every((b) => b.ok);

  const banners = [];
  if (!variantSupported) {
    banners.push({
      level: 'error',
      message: `ZF-8HP variant tag 0x${data[ZF8HP_VARIANT_OFFSET].toString(16).toUpperCase().padStart(2, '0')} at 0x${ZF8HP_VARIANT_OFFSET.toString(16).toUpperCase().padStart(4, '0')} is not in the covered set (0x45 / 0x70 / 0x90). Read-only — refusing to write.`,
    });
  } else if (!sizeSupported) {
    banners.push({
      level: 'error',
      message: `ZF-8HP ${variant.key} image size ${sz.toLocaleString()} B is not the canonical ${variant.canonicalSize.toLocaleString()} B for this variant. Read-only — refusing to write.`,
    });
  }
  if (blocks.length && !blocksOk) {
    const badCount = blocks.filter((b) => !b.ok).length;
    banners.push({
      level: 'warn',
      message: `ZF-8HP per-block CRC mismatch: ${badCount} / ${blocks.length} blocks fail. The 8HP loader will refuse to engage until every block CRC is repaired.`,
    });
  }

  return {
    ok: true,
    type: 'ZF_8HP_TCU',
    size: sz,
    variant: variantSupported ? variant.key : null,
    variantLabel: variant ? variant.label : null,
    variantTag: variant ? variant.tag : null,
    variantSupported,
    sizeSupported,
    vinSlots,
    vin: allMatch ? distinct[0] : (populated[0] ? populated[0].vin : null),
    vinAllSlotsMatch: allMatch,
    blocks,
    blocksOk,
    writeSafe: sizeSupported && variantSupported && allMatch && vinSlots.every((s) => s.csOk) && blocksOk,
    banners,
  };
}

/**
 * Patch a target VIN into every ZF-8HP VIN slot of a copy of `buf`,
 * recompute per-slot CRC16, then re-stamp every per-block CRC32 so the
 * TCU loader will accept the modified image. Returns `{ ok, bytes, log }`.
 */
export function patchZf8hpVin(buf, targetVin) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parsed = parseZf8hpImage(data);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, log: [] };
  if (!targetVin || !VIN_RE.test(targetVin)) {
    return { ok: false, reason: 'Target VIN missing or not a valid 17-character VIN.', log: [] };
  }
  if (!parsed.sizeSupported || !parsed.variantSupported) {
    return {
      ok: false,
      reason: 'Refusing to write — ZF-8HP variant/size is not in the covered set. See parse banners.',
      log: [],
      banners: parsed.banners,
    };
  }
  const out = new Uint8Array(data);
  const variant = VARIANT_TABLE[parsed.variantTag];
  const vinBytes = new Uint8Array(17);
  for (let i = 0; i < 17; i++) vinBytes[i] = targetVin.charCodeAt(i) & 0xFF;
  const slotCrc = crc16ccitt(vinBytes);
  const log = [];
  for (const off of variant.vinSlots) {
    writeBytes(out, off, vinBytes);
    writeBE16(out, off + 17, slotCrc);
    log.push(`ZF-8HP VIN @ 0x${off.toString(16).toUpperCase().padStart(6, '0')} ← ${targetVin} (CRC16 0x${slotCrc.toString(16).toUpperCase().padStart(4, '0')})`);
  }
  // Repair every block CRC32 — VIN slots almost always sit inside the
  // calibration blocks so the stored sums need a refresh either way.
  const blocks = zf8hpBlockChecksums(out);
  let blocksTouched = 0;
  for (const b of blocks) {
    if (b.stored !== b.calc) {
      writeBE32(out, b.csOffset, b.calc);
      blocksTouched++;
      log.push(`ZF-8HP block #${b.blockIndex} CRC32 @ 0x${b.csOffset.toString(16).toUpperCase().padStart(6, '0')} ← 0x${b.calc.toString(16).toUpperCase().padStart(8, '0')} (was 0x${b.stored.toString(16).toUpperCase().padStart(8, '0')})`);
    }
  }
  if (blocksTouched === 0) log.push('ZF-8HP per-block CRCs unchanged (all already valid)');
  return { ok: true, bytes: out, log, vin: targetVin, blocksTouched };
}

/** Build a deterministic ZF-8HP fixture for tests / docs. */
export function makeZf8hpFixture({ variant = '8HP90', vin = '2C3CDXL90MH582899' } = {}) {
  const entry = Object.values(VARIANT_TABLE).find((v) => v.key === variant);
  if (!entry) throw new Error(`Unknown ZF-8HP variant '${variant}'`);
  const buf = new Uint8Array(entry.canonicalSize).fill(0xFF);
  writeBytes(buf, ZF8HP_SIG_OFFSET, ZF8HP_SIG_HEAD);
  const tagEntry = Object.entries(VARIANT_TABLE).find(([, v]) => v.key === variant);
  buf[ZF8HP_VARIANT_OFFSET] = Number(tagEntry[0]);
  if (vin && VIN_RE.test(vin)) {
    const enc = new Uint8Array(17);
    for (let i = 0; i < 17; i++) enc[i] = vin.charCodeAt(i) & 0xFF;
    const crc = crc16ccitt(enc);
    for (const off of entry.vinSlots) {
      writeBytes(buf, off, enc);
      writeBE16(buf, off + 17, crc);
    }
  }
  // Stamp every block CRC32 so the fixture round-trips clean.
  const blocks = zf8hpBlockChecksums(buf);
  for (const b of blocks) writeBE32(buf, b.csOffset, b.calc);
  return buf;
}
