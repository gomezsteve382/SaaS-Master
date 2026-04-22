/**
 * Smoke tests for the BCM / RFHUB parsers exercised by ModuleSync.
 *
 * Verifies the two sample fixture bins deliver correct VIN, passing
 * CRC-16/CCITT checksums, and a virginized RFHUB SEC16 region.
 *
 * Run: node --test artifacts/srt-lab/src/__tests__/moduleSync.smoke.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const fix = name => new Uint8Array(readFileSync(join(__dir, "fixtures", name)));

const EXPECTED_VIN = "2C3CDXL90MH582899";

/* ─── CRC-16/CCITT (same implementation as ModuleSync.jsx) ─────────────────── */
function crc16Ccitt(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) {
    c ^= b << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
  }
  return c & 0xFFFF;
}

/* ─── BCM parser (mirrors parseBcm from ModuleSync.jsx) ─────────────────────── */
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const VIN_RE = /^[12345][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9]{14}$/;
const VIN_LEN = 17;

function parseBcm(bytes) {
  const slots = [];
  for (let i = 0; i < bytes.length - 21; i++) {
    if (bytes[i] !== 0x00 || bytes[i + 1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(bytes[i + 2])) continue;
    if (bytes[i + 3] !== 0x00) continue;
    const vinStart = i + 4;
    if (vinStart + VIN_LEN > bytes.length) continue;
    let candidate = "", valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = bytes[vinStart + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      candidate += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(candidate)) continue;
    let storedCrc = null, computedCrc = null, crcOk = null;
    if (vinStart + 19 <= bytes.length) {
      storedCrc = (bytes[vinStart + 17] << 8) | bytes[vinStart + 18];
      computedCrc = crc16Ccitt(bytes.slice(vinStart, vinStart + VIN_LEN));
      crcOk = storedCrc === computedCrc;
    }
    slots.push({ offset: vinStart, vin: candidate, storedCrc, computedCrc, crcOk });
  }
  return { ok: slots.length > 0, slots, vin: slots[0]?.vin ?? null };
}

/* ─── RFHUB parser (mirrors parseRfh from ModuleSync.jsx) ──────────────────── */
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const RFH_SEC16_OFFSETS = [0x0226, 0x023A];
const RFH_SEC16_LEN = 18;

function parseRfh(bytes) {
  const slots = [];
  for (const off of RFH_VIN_OFFSETS) {
    if (off + VIN_LEN > bytes.length) continue;
    const slice = bytes.slice(off, off + VIN_LEN);
    const reversed = new Uint8Array(VIN_LEN);
    for (let i = 0; i < VIN_LEN; i++) reversed[i] = slice[VIN_LEN - 1 - i];
    let candidate = "", valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = reversed[k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      candidate += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(candidate)) continue;
    let storedChk = null, computedChk = null, chkOk = null;
    if (off + 18 <= bytes.length) {
      storedChk = bytes[off + 17];
      let sumByte = 0;
      for (const b of slice) sumByte = (sumByte + b) & 0xFF;
      computedChk = (0xF9 - sumByte) & 0xFF;
      chkOk = storedChk === computedChk;
    }
    slots.push({ offset: off, vin: candidate, storedChk, computedChk, chkOk });
  }

  const sec16 = [];
  for (const off of RFH_SEC16_OFFSETS) {
    if (off + RFH_SEC16_LEN <= bytes.length) {
      sec16.push(Array.from(bytes.slice(off, off + RFH_SEC16_LEN)));
    }
  }

  return {
    ok: slots.length > 0,
    slots,
    vin: slots[0]?.vin ?? null,
    sec16,
  };
}

/* ─── Tests ─────────────────────────────────────────────────────────────────── */
test("BCM fixture: VIN is 2C3CDXL90MH582899", () => {
  const bytes = fix("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin");
  const result = parseBcm(bytes);
  assert.ok(result.ok, "parseBcm should find at least one VIN slot");
  assert.equal(result.vin, EXPECTED_VIN, "BCM VIN should match expected");
});

test("BCM fixture: all VIN slots consistent", () => {
  const bytes = fix("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin");
  const { slots } = parseBcm(bytes);
  assert.ok(slots.length >= 1, "should have at least 1 VIN slot");
  const vins = new Set(slots.map(s => s.vin));
  assert.equal(vins.size, 1, "all BCM VIN slots should match");
});

test("BCM fixture: CRC-16/CCITT passes on all VIN slots", () => {
  const bytes = fix("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin");
  const { slots } = parseBcm(bytes);
  for (const slot of slots) {
    assert.equal(
      slot.crcOk, true,
      `BCM slot @0x${slot.offset.toString(16).toUpperCase()} CRC fail: stored=0x${slot.storedCrc?.toString(16)} calc=0x${slot.computedCrc?.toString(16)}`
    );
  }
});

test("RFHUB fixture: VIN is 2C3CDXL90MH582899", () => {
  const bytes = fix("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin");
  const result = parseRfh(bytes);
  assert.ok(result.ok, "parseRfh should find at least one VIN slot");
  assert.equal(result.vin, EXPECTED_VIN, "RFHUB VIN should match expected");
});

test("RFHUB fixture: byte-reversal checksum passes on all VIN slots", () => {
  const bytes = fix("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin");
  const { slots } = parseRfh(bytes);
  for (const slot of slots) {
    assert.equal(
      slot.chkOk, true,
      `RFHUB slot @0x${slot.offset.toString(16).toUpperCase()} checksum fail: stored=0x${slot.storedChk?.toString(16)} calc=0x${slot.computedChk?.toString(16)}`
    );
  }
});

test("RFHUB fixture: SEC16 slots are all 0xFF (virginized)", () => {
  const bytes = fix("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin");
  const { sec16 } = parseRfh(bytes);
  assert.ok(sec16.length >= 1, "should have at least one SEC16 slot");
  for (let si = 0; si < sec16.length; si++) {
    const allFF = sec16[si].every(b => b === 0xFF);
    assert.ok(allFF, `SEC16 slot ${si + 1} (0x${RFH_SEC16_OFFSETS[si].toString(16).toUpperCase()}) is not fully 0xFF — virginize may not have been applied`);
  }
});
