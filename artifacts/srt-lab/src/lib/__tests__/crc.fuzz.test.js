import { describe, it, expect } from 'vitest';

import {
  crc16,
  crc8_42,
  crc8rf,
  rfhGen2VinCs,
} from '../crc.js';

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
// Same seed pattern as parsers.fuzz.test.js / writers.fuzz.test.js.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    nextInt: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    nextByte: () => Math.floor(next() * 256),
    nextBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
  };
}

// ── Buffer factories ─────────────────────────────────────────────────────────

const EMPTY = new Uint8Array(0);
const ONE_BYTE_00 = new Uint8Array([0x00]);
const ONE_BYTE_FF = new Uint8Array([0xFF]);
const ONE_BYTE_5A = new Uint8Array([0x5A]);

const VIN_17_ZERO = new Uint8Array(17).fill(0x00);
const VIN_17_FF = new Uint8Array(17).fill(0xFF);
// "1C4HJXEN5MW123456" — a representative VIN as ASCII bytes.
const VIN_17_ASCII = new TextEncoder().encode('1C4HJXEN5MW123456');

const BUF_32K_ZERO = new Uint8Array(32 * 1024).fill(0x00);
const BUF_32K_FF = new Uint8Array(32 * 1024).fill(0xFF);

// ── Per-helper definitions ───────────────────────────────────────────────────
// Each entry describes a CRC helper with its valid output range so we can
// assert the result is always a finite, non-NaN number inside the range.

const CRC_HELPERS = [
  {
    name: 'crc16',
    fn: (d) => crc16(d),
    min: 0,
    max: 0xFFFF,
  },
  {
    name: 'crc8_42',
    fn: (d) => crc8_42(d),
    min: 0,
    max: 0xFF,
  },
  {
    name: 'crc8rf',
    fn: (d) => crc8rf(d),
    min: 0,
    max: 0xFF,
  },
  {
    name: 'rfhGen2VinCs (default magic 0xDB)',
    fn: (d) => rfhGen2VinCs(d),
    min: 0,
    max: 0xFF,
  },
  {
    name: 'rfhGen2VinCs (magic 0x87)',
    fn: (d) => rfhGen2VinCs(d, 0x87),
    min: 0,
    max: 0xFF,
  },
];

const FIXED_BUFFERS = [
  ['empty', EMPTY],
  ['1-byte 0x00', ONE_BYTE_00],
  ['1-byte 0xFF', ONE_BYTE_FF],
  ['1-byte 0x5A', ONE_BYTE_5A],
  ['17-byte all-zero (VIN-sized)', VIN_17_ZERO],
  ['17-byte all-0xFF (VIN-sized)', VIN_17_FF],
  ['17-byte ASCII VIN', VIN_17_ASCII],
  ['32KB all-zero', BUF_32K_ZERO],
  ['32KB all-0xFF', BUF_32K_FF],
];

// ── Output-shape assertion ───────────────────────────────────────────────────

function assertCrcResult(result, label, min, max) {
  expect(typeof result, `${label}: must return a number`).toBe('number');
  expect(Number.isNaN(result), `${label}: must not be NaN`).toBe(false);
  expect(Number.isFinite(result), `${label}: must be finite`).toBe(true);
  expect(Number.isInteger(result), `${label}: must be an integer`).toBe(true);
  expect(result >= min, `${label}: must be >= ${min} (got ${result})`).toBe(true);
  expect(result <= max, `${label}: must be <= 0x${max.toString(16)} (got ${result})`).toBe(true);
}

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 1 — Fixed edge-case buffers
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('CRC helpers — fixed edge-case buffers', () => {
  for (const { name, fn, min, max } of CRC_HELPERS) {
    describe(name, () => {
      for (const [label, buf] of FIXED_BUFFERS) {
        it(`does not throw and returns a valid number: ${label}`, () => {
          let result;
          expect(() => { result = fn(buf); }, `${name}(${label}) must not throw`).not.toThrow();
          assertCrcResult(result, `${name}(${label})`, min, max);
        });
      }
    });
  }
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 2 — Property tests on randomized buffers
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('CRC helpers — randomized property tests', () => {
  for (const { name, fn, min, max } of CRC_HELPERS) {
    it(`${name}: 500 random buffers (length 0..512) are always valid`, () => {
      const rng = makeRng(0xC0FFEE01);
      for (let i = 0; i < 500; i++) {
        const len = rng.nextInt(0, 512);
        const buf = rng.nextBytes(len);
        let result;
        expect(() => { result = fn(buf); }, `${name} random[${i}] len=${len} must not throw`).not.toThrow();
        assertCrcResult(result, `${name} random[${i}] len=${len}`, min, max);
      }
    });

    it(`${name}: 50 random VIN-sized (17-byte) buffers are always valid`, () => {
      const rng = makeRng(0xC0FFEE02);
      for (let i = 0; i < 50; i++) {
        const buf = rng.nextBytes(17);
        let result;
        expect(() => { result = fn(buf); }, `${name} vin-rand[${i}] must not throw`).not.toThrow();
        assertCrcResult(result, `${name} vin-rand[${i}]`, min, max);
      }
    });

    it(`${name}: handful of large random buffers (1KB..32KB) are always valid`, () => {
      const rng = makeRng(0xC0FFEE03);
      const sizes = [1024, 4096, 8192, 16384, 32768];
      for (const sz of sizes) {
        const buf = rng.nextBytes(sz);
        let result;
        expect(() => { result = fn(buf); }, `${name} big[${sz}] must not throw`).not.toThrow();
        assertCrcResult(result, `${name} big[${sz}]`, min, max);
      }
    });
  }
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 3 — Non-Uint8Array input shapes
// The helpers iterate via for/length, so they should also accept plain Arrays
// and other indexable byte-like inputs without throwing or producing NaN.
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('CRC helpers — non-Uint8Array indexable inputs', () => {
  const rng = makeRng(0xC0FFEE04);
  const baseBytes = Array.from({ length: 17 }, () => rng.nextByte());

  const variants = [
    ['plain Array', baseBytes.slice()],
    ['Uint8ClampedArray', new Uint8ClampedArray(baseBytes)],
    ['Buffer-from-Array (Uint8Array.from)', Uint8Array.from(baseBytes)],
  ];

  for (const { name, fn, min, max } of CRC_HELPERS) {
    for (const [label, buf] of variants) {
      it(`${name} accepts ${label} without throwing`, () => {
        let result;
        expect(() => { result = fn(buf); }, `${name}(${label}) must not throw`).not.toThrow();
        assertCrcResult(result, `${name}(${label})`, min, max);
      });
    }
  }
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 4 — Determinism: same input → same output
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('CRC helpers — determinism', () => {
  for (const { name, fn } of CRC_HELPERS) {
    it(`${name}: same buffer produces same output across repeated calls`, () => {
      const rng = makeRng(0xC0FFEE05);
      for (let i = 0; i < 25; i++) {
        const buf = rng.nextBytes(rng.nextInt(0, 64));
        const a = fn(buf);
        const b = fn(buf);
        const c = fn(Uint8Array.from(buf));
        expect(a, `${name} call#1 vs #2`).toBe(b);
        expect(a, `${name} Uint8Array.from copy`).toBe(c);
      }
    });
  }
});
