// Unit tests for pairingRepair.js (triageModuleSet) and the two
// securityBytes.js helpers it depends on (generateSec16, deriveAllFromSec16).
//
// Coverage targets (Task #1054):
//   triageModuleSet — blank BCM, trusted BCM (split records), blank/trusted
//     RFHUB, damaged/trusted PCM, absent (not loaded), combo cases.
//   deriveAllFromSec16 — golden-vector: known RFHUB SEC16 → BCM SEC16 + PCM SEC6.
//   generateSec16 — 16 bytes, non-zero, changes each call.
//
// All helpers are pure JS — no React, no FileReader, no network.

import { describe, it, expect } from 'vitest';
import { triageModuleSet } from '../lib/pairingRepair.js';
import { generateSec16, deriveAllFromSec16 } from '../lib/securityBytes.js';

/* ── Minimal fixture builders ─────────────────────────────────────────────── */

/** BCM D-FLASH: 65536-byte blank buffer (all FF). No SEC16 anywhere. */
function makeBcmBlank() {
  return new Uint8Array(65536).fill(0xFF);
}

/**
 * BCM D-FLASH with three valid split records at 0x81A0/C0/E0.
 * Layout (per writeBcmSec16Gen2 + resolveBcmSec16):
 *   +0..+1   FF FF   (record header — indicates active slot)
 *   +2..+7   00 00 00 00 00 00
 *   +8       idx (0x01)
 *   +9..+15  sec16[0:7]
 *   +16..+19 04 04 00 14   (separator)
 *   +20..+28 sec16[7:16]
 *   +29      00
 */
function makeBcmWithSplitSec16(sec16) {
  const buf = new Uint8Array(65536).fill(0xFF);
  const OFFSETS = [0x81A0, 0x81C0, 0x81E0];
  for (const off of OFFSETS) {
    buf[off]     = 0xFF;
    buf[off + 1] = 0xFF;
    for (let j = 2; j < 8; j++) buf[off + j] = 0x00;
    buf[off + 8] = 0x01;
    for (let k = 0; k < 7; k++) buf[off + 9 + k] = sec16[k];
    buf[off + 16] = 0x04; buf[off + 17] = 0x04;
    buf[off + 18] = 0x00; buf[off + 19] = 0x14;
    for (let k = 0; k < 9; k++) buf[off + 20 + k] = sec16[7 + k];
    buf[off + 29] = 0x00;
  }
  return buf;
}

/**
 * RFHUB Gen2 (24C32 / 4096 B) with a valid SEC16 in both mirror slots.
 * Slot 1 @ 0x050E, Slot 2 @ 0x0522. Header signature AA 55 31 01 @ 0x0500.
 * SEC16 checksum is skipped — triageRfhub reads raw bytes only.
 */
function makeRfhubGen2Trusted(sec16) {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x0500] = 0xAA; buf[0x0501] = 0x55; buf[0x0502] = 0x31; buf[0x0503] = 0x01;
  for (const slotOff of [0x050E, 0x0522]) {
    for (let k = 0; k < 16; k++) buf[slotOff + k] = sec16[k];
    // Non-FF checksum bytes so the slot isn't treated as blank.
    buf[slotOff + 16] = 0x42; buf[slotOff + 17] = 0x00;
  }
  return buf;
}

/** RFHUB Gen2 with blank (all-FF) SEC16 slots — state should be 'blank'. */
function makeRfhubGen2Blank() {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x0500] = 0xAA; buf[0x0501] = 0x55; buf[0x0502] = 0x31; buf[0x0503] = 0x01;
  // SEC16 slots remain 0xFF (virgin).
  return buf;
}

/** RFHUB Gen1 (24C16 / 2048 B) with a valid SEC16 at 0x00AE / 0x00C0. */
function makeRfhubGen1Trusted(sec16) {
  const buf = new Uint8Array(2048).fill(0xFF);
  for (const slotOff of [0x00AE, 0x00C0]) {
    for (let k = 0; k < 16; k++) buf[slotOff + k] = sec16[k];
    buf[slotOff + 16] = 0x55; buf[slotOff + 17] = 0x00;
  }
  return buf;
}

/**
 * GPEC2A PCM EXT EEPROM (canonical 4096 B).
 * Marker FF FF FF AA @ 0x3C4; SEC6 @ 0x3C8.
 */
function makePcmTrusted(sec6) {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x3C4] = 0xFF; buf[0x3C5] = 0xFF; buf[0x3C6] = 0xFF; buf[0x3C7] = 0xAA;
  for (let i = 0; i < 6; i++) buf[0x3C8 + i] = sec6[i];
  return buf;
}

/** PCM with correct marker but all-FF (blank) SEC6. */
function makePcmBlankSec6() {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x3C4] = 0xFF; buf[0x3C5] = 0xFF; buf[0x3C6] = 0xFF; buf[0x3C7] = 0xAA;
  // SEC6 at 0x3C8 stays 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF.
  return buf;
}

/** PCM with wrong marker (not FF FF FF AA) but populated SEC6. */
function makePcmWrongMarker(sec6) {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x3C4] = 0x00; buf[0x3C5] = 0x00; buf[0x3C6] = 0x00; buf[0x3C7] = 0x00;
  for (let i = 0; i < 6; i++) buf[0x3C8 + i] = sec6[i];
  return buf;
}

/** PCM too small to contain the SEC6 region (< 0x3CE). */
function makePcmTooSmall() {
  return new Uint8Array(0x100).fill(0xFF);
}

/* ── Golden test vector ────────────────────────────────────────────────────── */
// Chosen so every byte is distinct and the reverse is obviously different.
const RFHUB_SEC16 = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
]);
const BCM_SEC16_EXPECTED = new Uint8Array([
  0x10, 0x0F, 0x0E, 0x0D, 0x0C, 0x0B, 0x0A, 0x09,
  0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
]);
const PCM_SEC6_EXPECTED = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);

/* ═══════════════════════════════════════════════════════════════════════════
 * generateSec16
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('generateSec16', () => {
  it('returns exactly 16 bytes', () => {
    const s = generateSec16();
    expect(s).toBeInstanceOf(Uint8Array);
    expect(s.length).toBe(16);
  });

  it('is non-zero (not all-00, not all-FF)', () => {
    const s = generateSec16();
    expect(Array.from(s).every(b => b === 0x00)).toBe(false);
    expect(Array.from(s).every(b => b === 0xFF)).toBe(false);
  });

  it('produces a different result on each call (crypto-random)', () => {
    const a = generateSec16();
    const b = generateSec16();
    // Statistical: P(equal | uniform random) = 2^{-128} ≈ 0. Use this as an
    // oracle that getRandomValues is actually being called.
    const same = Array.from(a).every((byte, i) => byte === b[i]);
    expect(same).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * deriveAllFromSec16
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('deriveAllFromSec16', () => {
  it('throws for a null input', () => {
    expect(() => deriveAllFromSec16(null)).toThrow();
  });

  it('throws when input is not exactly 16 bytes', () => {
    expect(() => deriveAllFromSec16(new Uint8Array(15))).toThrow();
    expect(() => deriveAllFromSec16(new Uint8Array(17))).toThrow();
  });

  it('golden vector: BCM SEC16 = reverse(RFHUB SEC16)', () => {
    const { bcmSec16 } = deriveAllFromSec16(RFHUB_SEC16);
    expect(Array.from(bcmSec16)).toEqual(Array.from(BCM_SEC16_EXPECTED));
  });

  it('golden vector: PCM SEC6 = first 6 bytes of RFHUB SEC16', () => {
    const { pcmSec6 } = deriveAllFromSec16(RFHUB_SEC16);
    expect(Array.from(pcmSec6)).toEqual(Array.from(PCM_SEC6_EXPECTED));
  });

  it('golden vector: rfhubSec16 output == rfhubSec16 input (round-trip)', () => {
    const { rfhubSec16 } = deriveAllFromSec16(RFHUB_SEC16);
    expect(Array.from(rfhubSec16)).toEqual(Array.from(RFHUB_SEC16));
  });

  it('round-trip: reverse(BCM SEC16) == RFHUB SEC16', () => {
    const { bcmSec16, rfhubSec16 } = deriveAllFromSec16(RFHUB_SEC16);
    const roundTripped = new Uint8Array(16);
    for (let i = 0; i < 16; i++) roundTripped[i] = bcmSec16[15 - i];
    expect(Array.from(roundTripped)).toEqual(Array.from(rfhubSec16));
  });

  it('returns new Uint8Array instances, not aliases of the input', () => {
    const input = new Uint8Array(RFHUB_SEC16);
    const { bcmSec16, rfhubSec16, pcmSec6 } = deriveAllFromSec16(input);
    expect(bcmSec16).not.toBe(input);
    expect(rfhubSec16).not.toBe(input);
    expect(pcmSec6).not.toBe(input);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * triageModuleSet — absent (null / undefined input)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('triageModuleSet — absent modules', () => {
  it('all three absent when called with no args', () => {
    const r = triageModuleSet();
    expect(r.bcm.loaded).toBe(false);
    expect(r.bcm.state).toBe('absent');
    expect(r.rfhub.loaded).toBe(false);
    expect(r.rfhub.state).toBe('absent');
    expect(r.pcm.loaded).toBe(false);
    expect(r.pcm.state).toBe('absent');
  });

  it('BCM absent when passed empty Uint8Array', () => {
    const r = triageModuleSet({ bcm: new Uint8Array(0) });
    expect(r.bcm.loaded).toBe(false);
    expect(r.bcm.state).toBe('absent');
    expect(r.bcm.sec16Bytes).toBeNull();
  });

  it('RFHUB absent when passed null', () => {
    const r = triageModuleSet({ rfhub: null });
    expect(r.rfhub.loaded).toBe(false);
    expect(r.rfhub.state).toBe('absent');
    expect(r.rfhub.sec16Bytes).toBeNull();
    expect(r.rfhub.rfhFormat).toBeNull();
  });

  it('PCM absent when passed null', () => {
    const r = triageModuleSet({ pcm: null });
    expect(r.pcm.loaded).toBe(false);
    expect(r.pcm.state).toBe('absent');
    expect(r.pcm.sec6Bytes).toBeNull();
    expect(r.pcm.markerOk).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * triageModuleSet — BCM
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('triageModuleSet — BCM triage', () => {
  it('blank BCM (all-FF, no split records) → state blank or absent', () => {
    const r = triageModuleSet({ bcm: makeBcmBlank() });
    expect(r.bcm.loaded).toBe(true);
    expect(['blank', 'absent']).toContain(r.bcm.state);
    expect(r.bcm.sec16Bytes).toBeNull();
  });

  it('BCM with split records → trusted, sec16Bytes is 16-byte array', () => {
    const bcm = makeBcmWithSplitSec16(BCM_SEC16_EXPECTED);
    const r = triageModuleSet({ bcm });
    expect(r.bcm.loaded).toBe(true);
    expect(r.bcm.state).toBe('trusted');
    expect(r.bcm.sec16Bytes).toBeInstanceOf(Uint8Array);
    expect(r.bcm.sec16Bytes.length).toBe(16);
    expect(Array.from(r.bcm.sec16Bytes)).toEqual(Array.from(BCM_SEC16_EXPECTED));
  });

  it('trusted BCM has a non-null sec16Hex string', () => {
    const r = triageModuleSet({ bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED) });
    expect(typeof r.bcm.sec16Hex).toBe('string');
    expect(r.bcm.sec16Hex.length).toBeGreaterThan(0);
  });

  it('BCM fields not applicable to BCM are null/false', () => {
    const r = triageModuleSet({ bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED) });
    expect(r.bcm.sec6Bytes).toBeNull();
    expect(r.bcm.sec6Hex).toBeNull();
    expect(r.bcm.markerHex).toBeNull();
    expect(r.bcm.markerOk).toBe(false);
    expect(r.bcm.rfhFormat).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * triageModuleSet — RFHUB
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('triageModuleSet — RFHUB triage', () => {
  it('Gen2 RFHUB with blank slots (all-FF) → state blank', () => {
    const r = triageModuleSet({ rfhub: makeRfhubGen2Blank() });
    expect(r.rfhub.loaded).toBe(true);
    expect(r.rfhub.state).toBe('blank');
    expect(r.rfhub.sec16Bytes).toBeNull();
    expect(r.rfhub.rfhFormat).toBe('gen2');
  });

  it('Gen2 RFHUB with valid SEC16 → trusted, correct rfhFormat', () => {
    const rfhub = makeRfhubGen2Trusted(RFHUB_SEC16);
    const r = triageModuleSet({ rfhub });
    expect(r.rfhub.loaded).toBe(true);
    expect(r.rfhub.state).toBe('trusted');
    expect(r.rfhub.rfhFormat).toBe('gen2');
    expect(r.rfhub.sec16Bytes).toBeInstanceOf(Uint8Array);
    expect(r.rfhub.sec16Bytes.length).toBe(16);
    expect(Array.from(r.rfhub.sec16Bytes)).toEqual(Array.from(RFHUB_SEC16));
  });

  it('Gen1 RFHUB (2048 B) with valid SEC16 → trusted, rfhFormat gen1', () => {
    const rfhub = makeRfhubGen1Trusted(RFHUB_SEC16);
    const r = triageModuleSet({ rfhub });
    expect(r.rfhub.loaded).toBe(true);
    expect(r.rfhub.state).toBe('trusted');
    expect(r.rfhub.rfhFormat).toBe('gen1');
    expect(r.rfhub.sec16Bytes).not.toBeNull();
  });

  it('RFHUB with unrecognised size and no Gen2 header → state absent or blank', () => {
    const rfhub = new Uint8Array(1024).fill(0xFF);
    const r = triageModuleSet({ rfhub });
    expect(r.rfhub.loaded).toBe(true);
    expect(['absent', 'blank']).toContain(r.rfhub.state);
  });

  it('RFHUB fields not applicable to RFHUB are null/false', () => {
    const r = triageModuleSet({ rfhub: makeRfhubGen2Trusted(RFHUB_SEC16) });
    expect(r.rfhub.sec6Bytes).toBeNull();
    expect(r.rfhub.sec6Hex).toBeNull();
    expect(r.rfhub.markerHex).toBeNull();
    expect(r.rfhub.markerOk).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * triageModuleSet — PCM (GPEC2A)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('triageModuleSet — PCM triage', () => {
  it('PCM too small → damaged (buffer cannot contain SEC6 region)', () => {
    const r = triageModuleSet({ pcm: makePcmTooSmall() });
    expect(r.pcm.loaded).toBe(true);
    expect(r.pcm.state).toBe('damaged');
    expect(r.pcm.sec6Bytes).toBeNull();
  });

  it('PCM with correct marker and populated SEC6 → trusted', () => {
    const sec6 = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    const r = triageModuleSet({ pcm: makePcmTrusted(sec6) });
    expect(r.pcm.loaded).toBe(true);
    expect(r.pcm.state).toBe('trusted');
    expect(r.pcm.markerOk).toBe(true);
    expect(r.pcm.sec6Bytes).toBeInstanceOf(Uint8Array);
    expect(r.pcm.sec6Bytes.length).toBe(6);
    expect(Array.from(r.pcm.sec6Bytes)).toEqual(Array.from(sec6));
  });

  it('PCM with wrong marker → damaged even when SEC6 is populated', () => {
    const sec6 = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const r = triageModuleSet({ pcm: makePcmWrongMarker(sec6) });
    expect(r.pcm.loaded).toBe(true);
    expect(r.pcm.state).toBe('damaged');
    expect(r.pcm.markerOk).toBe(false);
  });

  it('PCM with correct marker but blank SEC6 (all-FF) → damaged', () => {
    const r = triageModuleSet({ pcm: makePcmBlankSec6() });
    expect(r.pcm.loaded).toBe(true);
    expect(r.pcm.state).toBe('damaged');
    expect(r.pcm.markerOk).toBe(true);
    expect(r.pcm.sec6Bytes).toBeNull();
  });

  it('PCM markerHex is always a string when loaded', () => {
    const r = triageModuleSet({ pcm: makePcmTrusted(new Uint8Array([1,2,3,4,5,6])) });
    expect(typeof r.pcm.markerHex).toBe('string');
    expect(r.pcm.markerHex).toContain('FF FF FF AA');
  });

  it('PCM fields not applicable to PCM are null/false', () => {
    const r = triageModuleSet({ pcm: makePcmTrusted(new Uint8Array([1,2,3,4,5,6])) });
    expect(r.pcm.sec16Bytes).toBeNull();
    expect(r.pcm.sec16Hex).toBeNull();
    expect(r.pcm.rfhFormat).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * triageModuleSet — combination cases
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('triageModuleSet — combo cases', () => {
  it('trusted BCM + absent RFHUB + absent PCM', () => {
    const r = triageModuleSet({ bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED) });
    expect(r.bcm.state).toBe('trusted');
    expect(r.rfhub.state).toBe('absent');
    expect(r.pcm.state).toBe('absent');
  });

  it('absent BCM + trusted RFHUB + trusted PCM', () => {
    const sec6 = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const r = triageModuleSet({
      rfhub: makeRfhubGen2Trusted(RFHUB_SEC16),
      pcm: makePcmTrusted(sec6),
    });
    expect(r.bcm.state).toBe('absent');
    expect(r.rfhub.state).toBe('trusted');
    expect(r.pcm.state).toBe('trusted');
  });

  it('all three trusted', () => {
    const sec6 = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const r = triageModuleSet({
      bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED),
      rfhub: makeRfhubGen2Trusted(RFHUB_SEC16),
      pcm: makePcmTrusted(sec6),
    });
    expect(r.bcm.state).toBe('trusted');
    expect(r.rfhub.state).toBe('trusted');
    expect(r.pcm.state).toBe('trusted');
  });

  it('trusted BCM + blank RFHUB + damaged PCM', () => {
    const r = triageModuleSet({
      bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED),
      rfhub: makeRfhubGen2Blank(),
      pcm: makePcmTooSmall(),
    });
    expect(r.bcm.state).toBe('trusted');
    expect(r.rfhub.state).toBe('blank');
    expect(r.pcm.state).toBe('damaged');
  });

  it('each module report is independent (no cross-contamination)', () => {
    const r = triageModuleSet({
      bcm: makeBcmWithSplitSec16(BCM_SEC16_EXPECTED),
      rfhub: makeRfhubGen2Trusted(RFHUB_SEC16),
    });
    expect(r.bcm.rfhFormat).toBeNull();
    expect(r.rfhub.sec16Bytes).not.toBe(r.bcm.sec16Bytes);
  });
});
