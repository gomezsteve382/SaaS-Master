/* ============================================================================
 * twinBcmHelpers.js — pure-logic BCM helpers for the Twin tab (TwinTab.jsx).
 *
 * Extracted into a separate module (Task #47) so these functions can be
 * imported by the test suite without pulling in TwinTab.jsx's React/image
 * imports (@assets/charger_*), which are not resolvable in the vitest Node
 * environment. TwinTab.jsx re-exports these symbols so existing in-tab call
 * sites are unchanged.
 *
 * Public API:
 *   parseBcm(data, filename)
 *     → { type, filename, size, vins, partialVins, sec16Copies,
 *           secMatch, secAllCsOk, sec16Hex, sec16RfhHex, pcmSec6Hex }
 *       or null when data.length !== 65536.
 *
 *   applyBcmFromRfh(bcmData, rfhInfo)
 *     → Uint8Array — a new 65536-byte buffer with VIN and SEC16 fields
 *       written from rfhInfo. Does not mutate bcmData.
 *
 *   BCM_VIN_PRIMARY  — the four canonical full-VIN slot offsets.
 *   BCM_SEC16_OFFSETS / BCM_SEC16_SPLIT_COPIES — SEC16 layout.
 * ============================================================================ */

import { crc16 } from './crc.js';
import {
  findBcmPartialVinSlots,
  BCM_PARTIAL_VIN_OFFSETS,
  BCM_PARTIAL_VIN_LEN,
} from './donorLeakScan.js';

const hxb = arr => Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

export const BCM_VIN_PRIMARY = [0x5328, 0x5348, 0x5368, 0x5388];
// Task #47 — secondary full-VIN slots at 0x0698/0x06B8/0x06D8/0x06F8/0x0718/0x0738
// were audited against real FCA SINCRO binary output and confirmed to NOT EXIST.
// No real BCM dump carries VIN records at those addresses — they were fabricated
// offsets that caused applyBcmFromRfh to silently corrupt those BCM regions.
// Removed entirely; the partial-VIN list below covers every real BCM tail slot.
//
// BCM_PARTIAL_VIN_OFFSETS ([0x4098, 0x40B0]) imported from donorLeakScan.js is
// the always-known seed; parseBcm/applyBcmFromRfh auto-detect additional slots
// (0x0098/0x00B0 confirmed present in real alt-zone Charger BCM captures per
// Task #463 / #491 manifest and ImmoVINTab.bcmVinWrite golden pair).
export const BCM_SEC16_OFFSETS     = [0x40C9, 0x40F1];
// BCM 0x81xx split copies (bytes 0-6 at copy+0..6, gap copy+7..10 untouched, bytes 7-15 at copy+11..19)
export const BCM_SEC16_SPLIT_COPIES = [0x81A9, 0x81C9, 0x81E9];

/* ─── Collect auto-detected partial-VIN offsets ───────────────────────────── */
function collectPartialOffs(data) {
  const seen = new Set();
  for (const po of BCM_PARTIAL_VIN_OFFSETS) {
    if (po + BCM_PARTIAL_VIN_LEN + 2 <= data.length) seen.add(po);
  }
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  for (const d of findBcmPartialVinSlots(buf)) seen.add(d.offset);
  return [...seen].sort((a, b) => a - b);
}

/* ─── parseBcm ───────────────────────────────────────────────────────────── */
export function parseBcm(data, filename) {
  if (data.length !== 65536) return null;

  const vins = BCM_VIN_PRIMARY.map((off, i) => {
    const raw = data.slice(off, off + 17);
    const vin = Array.from(raw).map(b => String.fromCharCode(b)).join("");
    const csStored = (data[off + 17] << 8) | data[off + 18];
    const csCalc   = crc16(raw);
    return { slot: i + 1, offset: off, vin, csStored, csCalc, csOk: csStored === csCalc };
  });

  // Partial VINs: 8-byte tail (last 8 chars of VIN) + 2-byte CRC16.
  // Task #47 — auto-detect all partial-VIN slots in the buffer (the always-known
  // seed offsets in BCM_PARTIAL_VIN_OFFSETS [0x4098, 0x40B0] PLUS any additional
  // slots the scanner finds — real alt-zone Charger BCMs also carry them at
  // 0x0098 / 0x00B0, confirmed by the Task #491 manifest and golden test pair).
  const partialVins = collectPartialOffs(data).map((off, i) => {
    const raw = data.slice(off, off + BCM_PARTIAL_VIN_LEN);
    let tail = "", ok = true;
    for (let j = 0; j < BCM_PARTIAL_VIN_LEN; j++) {
      const b = raw[j];
      if (b < 0x20 || b > 0x7E) { ok = false; break; }
      tail += String.fromCharCode(b);
    }
    const csStored = (data[off + BCM_PARTIAL_VIN_LEN] << 8) | data[off + BCM_PARTIAL_VIN_LEN + 1];
    const csCalc   = crc16(raw);
    return { slot: i + 1, offset: off, tail: ok ? tail : "(invalid)", raw: Array.from(raw), csStored, csCalc, csOk: ok && csStored === csCalc };
  });

  const sec16Copies = BCM_SEC16_OFFSETS.map((off, i) => {
    const raw = data.slice(off, off + 16);
    const hex = hxb(raw);
    const csStored = (data[off + 19] << 8) | data[off + 20];
    const crcInput = Array.from(data.slice(off - 1, off + 19));
    const csCalc   = crc16(crcInput);
    const csOk     = csStored === csCalc;
    return { label: `Mirror ${i + 1}`, offset: off, raw: Array.from(raw), hex, csStored, csCalc, csOk };
  });

  const secMatch    = sec16Copies.length > 1 && sec16Copies[0].hex === sec16Copies[1].hex;
  const secAllCsOk  = sec16Copies.every(m => m.csOk);
  const sec16Raw    = sec16Copies[0].raw;
  const sec16Hex    = hxb(sec16Raw);
  const sec16RfhRaw = [...sec16Raw].reverse();
  const sec16RfhHex = hxb(sec16RfhRaw);
  const pcmSec6Hex  = hxb(sec16RfhRaw.slice(0, 6));

  return {
    type: "MPC5606B_05B", filename, size: data.length,
    vins, partialVins, sec16Copies, secMatch, secAllCsOk,
    sec16Hex, sec16RfhHex, pcmSec6Hex,
  };
}

/* ─── applyBcmFromRfh ────────────────────────────────────────────────────── */
export function applyBcmFromRfh(bcmData, rfhInfo) {
  const out = new Uint8Array(bcmData);
  const vin = rfhInfo.vins[0].vin;
  const enc = Array.from(vin).map(c => c.charCodeAt(0));

  const cs   = crc16(enc);
  const csHi = (cs >> 8) & 0xFF;
  const csLo = cs & 0xFF;

  // Write to primary slots
  for (const off of BCM_VIN_PRIMARY) {
    for (let i = 0; i < 17; i++) out[off + i] = enc[i];
    out[off + 17] = csHi;
    out[off + 18] = csLo;
  }
  // Task #47 — secondary full-VIN slots (0x0698..0x0738) removed: those
  // addresses do not exist in any real BCM dump (confirmed against FCA SINCRO
  // binary output). Writing there was silently corrupting those BCM regions.
  //
  // Write to partial VIN slots (8-byte tail + CRC16).
  // Auto-detect all populated partial slots in the existing buffer so we cover
  // 0x4098/0x40B0 (always-known seed from BCM_PARTIAL_VIN_OFFSETS) PLUS any
  // additional slots present at runtime (e.g. 0x0098/0x00B0 in alt-zone BCMs).
  const tail8  = enc.slice(9);
  const tailCs = crc16(tail8);
  for (const off of collectPartialOffs(out)) {
    for (let i = 0; i < BCM_PARTIAL_VIN_LEN; i++) out[off + i] = tail8[i];
    out[off + BCM_PARTIAL_VIN_LEN]     = (tailCs >> 8) & 0xFF;
    out[off + BCM_PARTIAL_VIN_LEN + 1] =  tailCs       & 0xFF;
  }

  // SEC16: reverse RFH_SEC16 → BCM_SEC16
  const rfhSec16  = rfhInfo.sec16Slots[0].raw;
  const bcmSec16  = [...rfhSec16].reverse();
  for (const off of BCM_SEC16_OFFSETS) {
    for (let i = 0; i < 16; i++) out[off + i] = bcmSec16[i];
    const crcInput  = Array.from(out.slice(off - 1, off + 19));
    const bcmSec16Crc = crc16(crcInput);
    out[off + 19] = (bcmSec16Crc >> 8) & 0xFF;
    out[off + 20] =  bcmSec16Crc       & 0xFF;
  }

  // Write 3 additional 0x81xx split copies
  for (const copyOff of BCM_SEC16_SPLIT_COPIES) {
    for (let i = 0; i <= 6; i++) out[copyOff + i] = bcmSec16[i];
    for (let i = 7; i <= 15; i++) out[copyOff + 4 + i] = bcmSec16[i];
  }

  return out;
}
