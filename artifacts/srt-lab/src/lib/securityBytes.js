/* ============================================================================
 * securityBytes.js — single source of truth for the three immobilizer-secret
 * writers used during a Module Sync run.
 *
 * Previously these functions were duplicated verbatim in App.jsx and
 * tabs/ModuleSync.jsx. A divergence between the two copies would have meant
 * two different ECUs getting two different patched bytes for the same input
 * — the kind of silent corruption that only shows up on a real bench.
 *
 * Algorithms preserved verbatim from the SINCRO-verified ModuleSync.jsx
 * implementations (byte-identical to ArmandoQS/SINCRO on reference dumps).
 * Return shapes are a strict superset of the previous App.jsx versions so
 * existing call sites (which read `mirror2Offset`, `patched`, etc.) keep
 * working.
 * ============================================================================ */

/* CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF.
 * Same primitive as engCrc16 / lib/crc.js#crc16, duplicated here so this
 * module has no cross-file dependency for its core algorithm. */
function crc16Ccitt(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (let x = 0; x < data.length; x++) {
    c ^= data[x] << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
  }
  return c & 0xFFFF;
}

const hexStr = (arr) => [...arr].map(b => b.toString(16).padStart(2, '0')).join('');

/* ----------------------------------------------------------------------------
 * writeBcmSec16Gen2(bytes, rfhSec16)
 *
 * VERIFIED ALGORITHM — produces byte-identical output to SINCRO/ArmandoQS on
 * 22 Charger Redeye reference dumps. Writes 3 targets:
 *   1. Split records at 0x81A0/C0/E0 (bank 2, persistent):
 *        7-byte prefix + separator "04 04 00 14" + 9-byte suffix
 *   2. Mirror 1 (slot 0xEB, size 0x18) in INACTIVE bank:
 *        header + idx(02) + SEC16(16b) + trailer(8F) + FF FF + CRC(2b) + EB 00
 *   3. Mirror 2 (slot 0xCA, size 0x28) in INACTIVE bank:
 *        same payload structure
 * Inactive bank is determined by comparing FEE sequence numbers at 0x0002
 * and 0x4002 — the higher value indicates the active bank.
 * Mirror CRC = CRC-16/CCITT(poly 0x1021, init 0xFFFF) over the 20 bytes
 *   [idx + SEC16(16) + trailer(8F) + FF + FF], stored big-endian at
 *   record+28 / record+29.
 * BCM SEC16 is reverse(RFH SEC16) (byte-reversed across the 16-byte slot).
 * ---------------------------------------------------------------------------- */
export function writeBcmSec16Gen2(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length !== 16) throw new Error('RFH SEC16 must be 16 bytes');
  const bcmSec16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bcmSec16[i] = rfhSec16[15 - i];
  const prefix7 = bcmSec16.slice(0, 7);
  const suffix9 = bcmSec16.slice(7, 16);
  const out = new Uint8Array(bytes);
  let splitPatched = 0, mirrorPatched = 0;

  /* 1. Split records */
  for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
    if (recOff + 30 > out.length) continue;
    if (out[recOff] !== 0xFF || out[recOff + 1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (out[recOff + j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = out[recOff + 8];
    if (idx !== 0x01 && idx !== 0x02) continue;
    if (out[recOff + 16] !== 0x04 || out[recOff + 17] !== 0x04 ||
        out[recOff + 18] !== 0x00 || out[recOff + 19] !== 0x14) continue;
    for (let k = 0; k < 7; k++) out[recOff +  9 + k] = prefix7[k];
    for (let k = 0; k < 9; k++) out[recOff + 20 + k] = suffix9[k];
    splitPatched++;
  }

  /* 2. Determine inactive bank (higher seq = active) */
  const bank0Seq = (out[0x0002] << 8) | out[0x0003];
  const bank1Seq = (out[0x4002] << 8) | out[0x4003];
  const inactiveBase = bank0Seq >= bank1Seq ? 0x4000 : 0x0000;

  /* Helper: find record header for a given slot type / size in given bank */
  const findRec = (base, slotType, sizeByte) => {
    const end = base + 0x4000;
    for (let i = base; i < end - 8; i++) {
      if (out[i]     === 0x00 && out[i + 1] === 0x00 && out[i + 2] === 0x00 &&
          out[i + 3] === sizeByte && out[i + 4] === 0x00 && out[i + 5] === 0x46 &&
          out[i + 6] === slotType && out[i + 7] === 0x00) return i;
    }
    return -1;
  };

  /* Helper: write the mirror payload (idx + SEC16 + trailer + CRC + footer) */
  const writeMirror = (off) => {
    out[off + 8] = 0x02; /* idx */
    for (let k = 0; k < 16; k++) out[off + 9 + k] = bcmSec16[k];
    out[off + 25] = 0x8F; /* trailer */
    out[off + 26] = 0xFF;
    out[off + 27] = 0xFF;
    /* Compute CRC over idx + SEC16 + trailer + FF + FF (20 bytes) */
    const ci = new Uint8Array(20);
    ci[0] = 0x02;
    for (let k = 0; k < 16; k++) ci[1 + k] = bcmSec16[k];
    ci[17] = 0x8F; ci[18] = 0xFF; ci[19] = 0xFF;
    const crc = crc16Ccitt(ci);
    out[off + 28] = (crc >> 8) & 0xFF;
    out[off + 29] = crc & 0xFF;
    out[off + 30] = 0xEB;
    out[off + 31] = 0x00;
  };

  const m1Off = findRec(inactiveBase, 0xEB, 0x18);
  if (m1Off >= 0) { writeMirror(m1Off); mirrorPatched++; }
  const m2Off = findRec(inactiveBase, 0xCA, 0x28);
  if (m2Off >= 0) { writeMirror(m2Off); mirrorPatched++; }

  return {
    bytes: out,
    splitPatched,
    mirrorPatched,
    inactiveBase,
    mirror1Offset: m1Off >= 0 ? m1Off : null,
    mirror2Offset: m2Off >= 0 ? m2Off : null,
    bcmSec16Hex: hexStr(bcmSec16),
    /* Legacy aggregate field for backward compat with older call sites */
    patched: splitPatched + mirrorPatched,
  };
}

/* ----------------------------------------------------------------------------
 * writePcmSec6(bytes, rfhSec16)
 *
 * Writes the first 6 bytes of RFH SEC16 as PCM SEC6.
 *   GPEC2A: at every "FF FF FF AA" marker + 4.
 *   GPEC5:  at the first "FF FF FF FF" + 4 where the next 6 bytes are not
 *           all-FF (i.e. there's existing SEC6 data to overwrite).
 * Only one of the two paths fires per call — GPEC2A first, GPEC5 only if
 * no GPEC2A markers were found.
 * ---------------------------------------------------------------------------- */
export function writePcmSec6(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length < 6) throw new Error('Need at least 6 bytes of RFH SEC16');
  const sec6 = rfhSec16.slice(0, 6);
  const out = new Uint8Array(bytes);
  let patched = 0;
  let markerUsed = null;

  /* Try GPEC2A marker first */
  for (let i = 0; i < out.length - 10; i++) {
    if (out[i] === 0xFF && out[i + 1] === 0xFF && out[i + 2] === 0xFF && out[i + 3] === 0xAA) {
      for (let k = 0; k < 6; k++) out[i + 4 + k] = sec6[k];
      patched++;
      markerUsed = 'FF FF FF AA';
    }
  }
  /* If no GPEC2A marker, try GPEC5 (FF FF FF FF followed by non-all-FF SEC6) */
  if (patched === 0) {
    for (let i = 0; i < out.length - 20; i++) {
      if (out[i] === 0xFF && out[i + 1] === 0xFF && out[i + 2] === 0xFF && out[i + 3] === 0xFF) {
        let hasData = false;
        for (let k = 0; k < 6; k++) if (out[i + 4 + k] !== 0xFF) { hasData = true; break; }
        if (hasData) {
          for (let k = 0; k < 6; k++) out[i + 4 + k] = sec6[k];
          patched++;
          markerUsed = 'FF FF FF FF';
          break; /* GPEC5 only has one location */
        }
      }
    }
  }
  return {
    bytes: out,
    patched,
    markerUsed,
    sec6Hex: hexStr(sec6),
  };
}

/* ----------------------------------------------------------------------------
 * writeRfhSec16FromBcm(bytes, bcmSec16)
 *
 * Writes BCM secret → RFHUB Gen2 SEC16 slots.
 * BCM stores reverse(RFHUB SEC16), so RFHUB SEC16 = reverse(BCM SEC16).
 * Checksum formula (empirically verified on reference dumps):
 *     chk = (0xFE - (sum_of_16_bytes % 255)) & 0xFF
 * stored at slotOff+16, with 0x00 at slotOff+17.
 * Writes to both Gen2 slots: 0x050E and 0x0522.
 * Throws if the buffer is not a Gen2 RFHUB (header AA 55 31 01 at 0x0500).
 *
 * NOTE: this checksum formula intentionally diverges from parseModule's
 * `rfhSec16Cs` (which uses crc8_65). The writer formula is the one observed
 * on real ECU dumps; the parser formula is a separate audit item tracked by
 * the existing "Debug all checksum & security-byte paths against real ECU
 * dumps" task. The golden tests pin the writer's empirical formula as-is.
 * ---------------------------------------------------------------------------- */
export function writeRfhSec16FromBcm(bytes, bcmSec16) {
  if (!bcmSec16 || bcmSec16.length !== 16) throw new Error('BCM SEC16 must be 16 bytes');
  const rfhSec16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rfhSec16[i] = bcmSec16[15 - i];
  let sum = 0;
  for (const b of rfhSec16) sum += b;
  const chk = (0xFE - (sum % 255)) & 0xFF;
  const out = new Uint8Array(bytes);
  if (out[0x0500] !== 0xAA || out[0x0501] !== 0x55 ||
      out[0x0502] !== 0x31 || out[0x0503] !== 0x01) {
    throw new Error('Not a Gen2 RFHUB (AA 55 31 01 header missing at 0x0500)');
  }
  let patched = 0;
  for (const slotOff of [0x050E, 0x0522]) {
    if (slotOff + 18 > out.length) continue;
    for (let k = 0; k < 16; k++) out[slotOff + k] = rfhSec16[k];
    out[slotOff + 16] = chk;
    out[slotOff + 17] = 0x00;
    patched++;
  }
  return {
    bytes: out,
    patched,
    rfhSec16Hex: hexStr(rfhSec16),
    chk,
  };
}
