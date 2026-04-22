import { describe, it, expect } from 'vitest';
import { analyzeFile } from '../fileUtils.js';
import { crc16, crc8_42, crc8rf, rfhGen2VinCs } from '../crc.js';
import { TL, TC, IMMO_BLOCK } from '../constants.js';

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────────
// Same generator as writers.fuzz.test.js / vehicles.fuzz.test.js so CI runs
// are bit-for-bit reproducible.

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
    nextInt:   (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    nextByte:  ()       => Math.floor(next() * 256),
    nextBytes: (n)      => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
    pick:      (arr)    => arr[Math.floor(next() * arr.length)],
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_TYPES = ['BCM', 'RFHUB', 'GPEC2A', '95640', 'FW', 'TCM', 'TIPM', 'UNKNOWN'];

// Sizes that satisfy the TCM / TIPM signature window in _detectBySignature.
const TCM_WINDOW_SIZES  = [4096, 8192, 16384, 20480];
const TIPM_WINDOW_SIZES = [2048, 4096, 8192, 10240];

// VINs whose 9th-position check digit is mathematically valid per ISO 3779.
// Pre-computed so analyzeFile's BCM/95640 paths (which reject invalid check
// digits via _checkVin) actually accept them.
const VALID_VINS = [
  '1C4HJXEN9MW123456',
  '1C4RJFBGXEC123456',
  '2C3CDXHG3FH123456',
  '1C4BJWDG6HL123456',
  '1C4RJFCT3FC123456',
];

// ── Buffer factories ──────────────────────────────────────────────────────────

function makeZero(size) { return new Uint8Array(size).fill(0x00); }
function makeFF(size)   { return new Uint8Array(size).fill(0xFF); }
function makeRand(rng, size) { return rng.nextBytes(size); }

// Plant a TCM-style signature: byte 0x10 in [0x01..0x08] plus a 0x55 0xAA pair
// in the first 32 bytes and 0xFF/0x00 prefix.
function plantTcmSignature(buf) {
  buf[0] = 0xFF; buf[1] = 0xFF;
  buf[2] = 0xA5;
  buf[0x10] = 0x04;
  buf[5] = 0x55; buf[6] = 0xAA;
  return buf;
}

// Plant a TIPM-style signature: byte 0x04 in {0x36,0x80,0x81,0x3C} plus 0xAA
// repeats and a 0x00/0xFF prefix.
function plantTipmSignature(buf) {
  buf[0] = 0x00; buf[1] = 0x00;
  buf[0x04] = 0x80;
  for (let i = 0; i < 8; i++) buf[i + 7] = 0xAA;
  return buf;
}

// Plant a valid BCM-style VIN + CRC16 at the given offset.
function plantBcmVin(buf, off, vin) {
  const vb = new TextEncoder().encode(vin);
  for (let i = 0; i < 17; i++) buf[off + i] = vb[i];
  const c = crc16(vb);
  buf[off + 17] = (c >> 8) & 0xFF;
  buf[off + 18] = c & 0xFF;
}

// Plant a 95640 VIN at offset `off` with crc8_42 at off-1.
function plant95640Vin(buf, off, vin) {
  const vb = new TextEncoder().encode(vin);
  for (let i = 0; i < 17; i++) buf[off + i] = vb[i];
  buf[off - 1] = crc8_42(vb);
}

// Plant a mirrored RFHUB Gen1 VIN at the given offset (CRC = crc8rf of the
// stored, mirrored bytes).
function plantRfhVinGen1(buf, off, vin) {
  const vb = new TextEncoder().encode(vin);
  const mr = new Uint8Array(17);
  for (let i = 0; i < 17; i++) mr[i] = vb[16 - i];
  for (let i = 0; i < 17; i++) buf[off + i] = mr[i];
  buf[off + 17] = crc8rf(mr);
}

// Plant a mirrored RFHUB Gen2 VIN with the magic-derived XOR checksum.
function plantRfhVinGen2(buf, off, vin, magic = 0xDB) {
  const vb = new TextEncoder().encode(vin);
  const mr = new Uint8Array(17);
  for (let i = 0; i < 17; i++) mr[i] = vb[16 - i];
  for (let i = 0; i < 17; i++) buf[off + i] = mr[i];
  buf[off + 17] = rfhGen2VinCs(mr, magic);
}

// Plant an ASCII GPEC2A VIN at the given offset (no CRC).
function plantGpecVin(buf, off, vin) {
  const vb = new TextEncoder().encode(vin);
  for (let i = 0; i < 17; i++) buf[off + i] = vb[i];
}

// ── Output shape assertions ───────────────────────────────────────────────────

function assertAnalyzeShape(result, label) {
  expect(result, `${label}: analyzeFile must return an object`).toBeDefined();
  expect(typeof result.type, `${label}: type must be a string`).toBe('string');
  expect(ALL_TYPES, `${label}: type must be one of the known types`).toContain(result.type);
  expect(typeof result.name,  `${label}: name must be a string`).toBe('string');
  expect(typeof result.color, `${label}: color must be a string`).toBe('string');
  expect(typeof result.size,  `${label}: size must be a number`).toBe('number');
  expect(result.data instanceof Uint8Array, `${label}: data must be Uint8Array`).toBe(true);
  expect(result.size, `${label}: size must equal data.length`).toBe(result.data.length);
  expect(Array.isArray(result.vins),     `${label}: vins must be Array`).toBe(true);
  expect(Array.isArray(result.partials), `${label}: partials must be Array`).toBe(true);
  expect(typeof result.hexOnly, `${label}: hexOnly must be boolean`).toBe('boolean');
  expect(result.hexOnly, `${label}: hexOnly must equal (type==="UNKNOWN")`).toBe(result.type === 'UNKNOWN');

  // Cross-check label/colour with the constant tables.
  if (TL[result.type] !== undefined) expect(result.name).toBe(TL[result.type]);
  if (TC[result.type] !== undefined) expect(result.color).toBe(TC[result.type]);

  // Each vin entry must reference a real, in-bounds offset.
  for (const v of result.vins) {
    expect(typeof v.off, `${label}: vin.off must be a number`).toBe('number');
    expect(v.off, `${label}: vin.off must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(v.off + 17, `${label}: vin.off+17 must be in-bounds`).toBeLessThanOrEqual(result.size);
    expect(typeof v.vin, `${label}: vin.vin must be a string`).toBe('string');
    expect(v.vin.length, `${label}: vin.vin must be 17 chars`).toBe(17);
  }
  for (const p of result.partials) {
    expect(typeof p.off, `${label}: partial.off must be a number`).toBe('number');
    expect(p.off, `${label}: partial.off must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(p.off + 8, `${label}: partial.off+8 must be in-bounds`).toBeLessThanOrEqual(result.size);
  }
}

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 1 — canonical-size detection (one test per type branch)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — canonical size → type detection', () => {
  it('65536-byte zero buffer → BCM', () => {
    const r = analyzeFile(makeZero(65536), 'bcm.bin');
    assertAnalyzeShape(r, 'bcm-65536');
    expect(r.type).toBe('BCM');
  });

  it('131072-byte zero buffer → BCM', () => {
    const r = analyzeFile(makeZero(131072), 'bcm.bin');
    assertAnalyzeShape(r, 'bcm-131072');
    expect(r.type).toBe('BCM');
  });

  it('8192-byte zero buffer (no signature) → 95640', () => {
    const r = analyzeFile(makeZero(8192), 'eep.bin');
    assertAnalyzeShape(r, '95640-8192');
    expect(r.type).toBe('95640');
  });

  it('16384-byte zero buffer (no signature) → 95640', () => {
    const r = analyzeFile(makeZero(16384), 'eep.bin');
    assertAnalyzeShape(r, '95640-16384');
    expect(r.type).toBe('95640');
  });

  it('4096-byte zero buffer (non-ASCII first 17) → RFHUB', () => {
    const r = analyzeFile(makeZero(4096), 'rfh.bin');
    assertAnalyzeShape(r, 'rfhub-4096');
    expect(r.type).toBe('RFHUB');
  });

  it('4096-byte buffer with ASCII-uppercase first 17 → GPEC2A', () => {
    const buf = makeZero(4096);
    plantGpecVin(buf, 0, VALID_VINS[0]);
    const r = analyzeFile(buf, 'gpec.bin');
    assertAnalyzeShape(r, 'gpec-4096');
    expect(r.type).toBe('GPEC2A');
  });

  it('262144-byte zero buffer (>131072) → FW', () => {
    const r = analyzeFile(makeZero(262144), 'fw.bin');
    assertAnalyzeShape(r, 'fw-262144');
    expect(r.type).toBe('FW');
  });

  it('512-byte zero buffer → UNKNOWN (hexOnly)', () => {
    const r = analyzeFile(makeZero(512), 'unk.bin');
    assertAnalyzeShape(r, 'unknown-512');
    expect(r.type).toBe('UNKNOWN');
    expect(r.hexOnly).toBe(true);
  });

  it('zero-byte buffer → UNKNOWN (does not throw)', () => {
    let r;
    expect(() => { r = analyzeFile(makeZero(0), 'empty.bin'); }).not.toThrow();
    assertAnalyzeShape(r, 'unknown-0');
    expect(r.type).toBe('UNKNOWN');
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 2 — signature-based detection (TCM / TIPM)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — signature-based detection', () => {
  for (const sz of TCM_WINDOW_SIZES) {
    it(`${sz}-byte buffer with TCM signature → TCM (overrides 95640 fallback)`, () => {
      const buf = plantTcmSignature(makeZero(sz));
      const r = analyzeFile(buf, 'tcm.bin');
      assertAnalyzeShape(r, `tcm-${sz}`);
      expect(r.type).toBe('TCM');
    });
  }

  for (const sz of TIPM_WINDOW_SIZES) {
    it(`${sz}-byte buffer with TIPM signature → TIPM`, () => {
      const buf = plantTipmSignature(makeZero(sz));
      const r = analyzeFile(buf, 'tipm.bin');
      assertAnalyzeShape(r, `tipm-${sz}`);
      expect(r.type).toBe('TIPM');
    });
  }

  it('4096 with TCM signature wins over RFHUB default', () => {
    const buf = plantTcmSignature(makeZero(4096));
    const r = analyzeFile(buf, 'tcm-or-rfh.bin');
    assertAnalyzeShape(r, 'tcm-vs-rfh');
    expect(r.type).toBe('TCM');
  });

  it('blended TCM+TIPM signatures in 8192 buffer → TCM wins (TCM branch checked first)', () => {
    // _detectBySignature checks the TCM window first (sz>=4096), so a buffer
    // matching both signature shapes must classify as TCM, not TIPM.
    const buf = plantTipmSignature(makeZero(8192));
    plantTcmSignature(buf); // TCM planted second so it wins on byte conflicts
    const r = analyzeFile(buf, 'blended.bin');
    assertAnalyzeShape(r, 'blended');
    expect(r.type).toBe('TCM');
  });

  it('UNKNOWN-size buffer (16K + 1) with TCM signature still falls into UNKNOWN-rescue branch', () => {
    // 16385 is non-canonical but >=512 and within ±4096 of 16384; the rescue
    // branch in analyzeFile must run _detectBySignature.
    const buf = plantTcmSignature(makeZero(16385));
    const r = analyzeFile(buf, 'rescue.bin');
    assertAnalyzeShape(r, 'rescue-tcm');
    expect(r.type).toBe('TCM');
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 3 — near-canonical and adversarial sizes
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — near-canonical sizes never throw', () => {
  const CANON = [4096, 8192, 16384, 65536, 131072];
  const DELTAS = [-2, -1, 1, 2, 100, -100];

  for (const base of CANON) {
    for (const d of DELTAS) {
      const sz = base + d;
      if (sz <= 0) continue;
      it(`size=${sz} (base ${base}${d >= 0 ? '+' : ''}${d}) → no throw, valid shape`, () => {
        let r;
        expect(() => { r = analyzeFile(makeZero(sz), 'near.bin'); }).not.toThrow();
        assertAnalyzeShape(r, `near-${sz}`);
      });
    }
  }

  it('1-byte buffer → UNKNOWN, no throw', () => {
    let r;
    expect(() => { r = analyzeFile(makeZero(1), 'tiny.bin'); }).not.toThrow();
    assertAnalyzeShape(r, 'tiny');
    expect(r.type).toBe('UNKNOWN');
  });

  it('one byte under FW threshold (131073) → FW', () => {
    const r = analyzeFile(makeZero(131073), 'big.bin');
    assertAnalyzeShape(r, 'fw-edge');
    expect(r.type).toBe('FW');
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 4 — VIN extraction at all known offsets per type
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — VIN extraction at canonical offsets', () => {
  const vin = VALID_VINS[0];

  it('BCM with planted VIN+CRC16 at 0x5320 → vins includes that offset', () => {
    const buf = makeZero(65536);
    plantBcmVin(buf, 0x5320, vin);
    const r = analyzeFile(buf, 'bcm-vin.bin');
    assertAnalyzeShape(r, 'bcm-vin');
    expect(r.type).toBe('BCM');
    expect(r.vins.some(v => v.off === 0x5320 && v.vin === vin && v.ok === true)).toBe(true);
  });

  function plantBcmPartial(buf, off, vinTail) {
    const vb = new TextEncoder().encode(vinTail);
    for (let i = 0; i < 8; i++) buf[off + i] = vb[i];
    const c = crc16(vb);
    buf[off + 8] = (c >> 8) & 0xFF;
    buf[off + 9] = c & 0xFF;
  }

  it('BCM with planted partial VIN+CRC16 at 0x4098 → partials includes that offset', () => {
    const buf = makeZero(65536);
    plantBcmPartial(buf, 0x4098, vin.slice(9));
    const r = analyzeFile(buf, 'bcm-partial-4098.bin');
    assertAnalyzeShape(r, 'bcm-partial-4098');
    expect(r.partials.some(p => p.off === 0x4098)).toBe(true);
  });

  it('BCM with planted partial VIN+CRC16 at 0x40B0 → partials includes that offset', () => {
    const buf = makeZero(65536);
    plantBcmPartial(buf, 0x40B0, vin.slice(9));
    const r = analyzeFile(buf, 'bcm-partial-40b0.bin');
    assertAnalyzeShape(r, 'bcm-partial-40b0');
    expect(r.partials.some(p => p.off === 0x40B0)).toBe(true);
  });

  it('BCM with both partial VIN offsets planted → both 0x4098 and 0x40B0 captured', () => {
    const buf = makeZero(65536);
    plantBcmPartial(buf, 0x4098, vin.slice(9));
    plantBcmPartial(buf, 0x40B0, vin.slice(9));
    const r = analyzeFile(buf, 'bcm-partials-both.bin');
    assertAnalyzeShape(r, 'bcm-partials-both');
    expect(r.partials.some(p => p.off === 0x4098)).toBe(true);
    expect(r.partials.some(p => p.off === 0x40B0)).toBe(true);
  });

  it('95640 with planted VIN at 0x275 → vins captured', () => {
    const buf = makeZero(8192);
    plant95640Vin(buf, 0x275, vin);
    const r = analyzeFile(buf, 'eep-vin.bin');
    assertAnalyzeShape(r, '95640-vin');
    expect(r.type).toBe('95640');
    expect(r.vins.some(v => v.off === 0x275 && v.vin === vin)).toBe(true);
  });

  it('RFHUB Gen1 (mirrored) at 0xEA5 — buffer non-ASCII so type is RFHUB', () => {
    const buf = makeZero(4096);
    // Make first 17 bytes non-ASCII so type detection picks RFHUB, not GPEC2A.
    for (let i = 0; i < 17; i++) buf[i] = 0x10;
    plantRfhVinGen1(buf, 0xEA5, vin);
    const r = analyzeFile(buf, 'rfh-gen1.bin');
    assertAnalyzeShape(r, 'rfh-gen1');
    expect(r.type).toBe('RFHUB');
    expect(r.vins.some(v => v.off === 0xEA5 && v.mirrored === true)).toBe(true);
  });

  it('RFHUB Gen2 (mirrored, magic-derived CRC) at 0xEA5', () => {
    const buf = makeZero(4096);
    for (let i = 0; i < 17; i++) buf[i] = 0x10;
    plantRfhVinGen2(buf, 0xEA5, vin, 0xDB);
    const r = analyzeFile(buf, 'rfh-gen2.bin');
    assertAnalyzeShape(r, 'rfh-gen2');
    expect(r.type).toBe('RFHUB');
    expect(r.vins.some(v => v.off === 0xEA5)).toBe(true);
  });

  it('GPEC2A VIN at offset 0 — type=GPEC2A and vin captured', () => {
    const buf = makeZero(4096);
    plantGpecVin(buf, 0, vin);
    const r = analyzeFile(buf, 'gpec.bin');
    assertAnalyzeShape(r, 'gpec-vin');
    expect(r.type).toBe('GPEC2A');
    expect(r.vins.some(v => v.off === 0 && v.vin === vin)).toBe(true);
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 5 — `sec` security/immo block presence per type
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — sec block populated per type', () => {
  it('BCM 65536 zero buffer → sec.t === "bcm" with immoSynced flag', () => {
    const r = analyzeFile(makeZero(65536), 'bcm.bin');
    expect(r.sec).not.toBeNull();
    expect(r.sec.t).toBe('bcm');
    expect(typeof r.sec.immoSynced).toBe('boolean');
  });

  it('BCM with sentinel at 0x40C0 mirrored to 0x2000 → immoSynced=true', () => {
    const buf = makeZero(65536);
    for (let i = 0; i < IMMO_BLOCK; i++) {
      buf[0x40C0 + i] = 0xAB;
      buf[0x2000 + i] = 0xAB;
    }
    const r = analyzeFile(buf, 'bcm.bin');
    expect(r.sec.immoSynced).toBe(true);
  });

  it('95640 → sec.t === "95640" with key/fob slices', () => {
    const r = analyzeFile(makeZero(8192), 'eep.bin');
    expect(r.sec.t).toBe('95640');
    expect(r.sec.key instanceof Uint8Array).toBe(true);
    expect(r.sec.fob instanceof Uint8Array).toBe(true);
  });

  it('RFHUB → sec.t === "rfhub" with key slice', () => {
    const r = analyzeFile(makeZero(4096), 'rfh.bin');
    expect(r.sec.t).toBe('rfhub');
    expect(r.sec.key instanceof Uint8Array).toBe(true);
  });

  it('GPEC2A → sec.t === "gpec2a" with skim/key fields', () => {
    const buf = makeZero(4096);
    plantGpecVin(buf, 0, VALID_VINS[0]);
    const r = analyzeFile(buf, 'gpec.bin');
    expect(r.sec.t).toBe('gpec2a');
    expect(r.sec.key instanceof Uint8Array).toBe(true);
  });

  it('FW (262144) → sec is null', () => {
    const r = analyzeFile(makeZero(262144), 'fw.bin');
    expect(r.sec).toBeNull();
  });

  it('UNKNOWN → sec is null and hexOnly true', () => {
    const r = analyzeFile(makeZero(512), 'unk.bin');
    expect(r.sec).toBeNull();
    expect(r.hexOnly).toBe(true);
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 6 — randomized fuzz: every buffer, every size yields a valid result
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('analyzeFile — randomized fuzz (mulberry32 PRNG)', () => {
  // A pool of sizes biased towards canonical and near-canonical values so
  // misclassification edge cases are exercised more heavily than uniform
  // sampling would allow.
  const SIZE_POOL = [
    0, 1, 16, 64, 256, 511, 512, 513, 1023, 1024, 2048,
    4095, 4096, 4097, 5000, 8000,
    8191, 8192, 8193,
    10000, 12000,
    16383, 16384, 16385,
    20000, 32768,
    65535, 65536, 65537,
    100000,
    131071, 131072, 131073,
    200000, 262144,
  ];

  it('1000 random buffers across canonical and adversarial sizes → no throw, valid shape', () => {
    const rng = makeRng(0xC0FFEE);
    const failures = [];
    for (let i = 0; i < 1000; i++) {
      const sz = rng.pick(SIZE_POOL);
      // Mix of zero, FF, random, and signature-tainted buffers.
      const flavor = rng.nextInt(0, 4);
      let buf;
      if      (flavor === 0) buf = makeZero(sz);
      else if (flavor === 1) buf = makeFF(sz);
      else if (flavor === 2) buf = makeRand(rng, sz);
      else if (flavor === 3) buf = sz >= 32 ? plantTcmSignature(makeRand(rng, sz)) : makeRand(rng, sz);
      else                    buf = sz >= 32 ? plantTipmSignature(makeRand(rng, sz)) : makeRand(rng, sz);

      try {
        const r = analyzeFile(buf, `fuzz-${i}.bin`);
        assertAnalyzeShape(r, `fuzz-${i}-sz${sz}-flavor${flavor}`);
      } catch (e) {
        failures.push({ i, sz, flavor, err: e?.message || String(e) });
      }
    }
    expect(failures, `Fuzz failures: ${JSON.stringify(failures.slice(0, 5))}`).toEqual([]);
  });

  it('200 random VIN-tainted BCM buffers → all classify as BCM, vins is array', () => {
    const rng = makeRng(0xBADF00D);
    for (let i = 0; i < 200; i++) {
      const sz = rng.pick([65536, 131072]);
      const buf = makeRand(rng, sz);
      const vin = rng.pick(VALID_VINS);
      // Plant 1-3 VINs at random valid offsets.
      const n = rng.nextInt(1, 3);
      for (let k = 0; k < n; k++) {
        const off = rng.nextInt(0x1000, sz - 32);
        plantBcmVin(buf, off, vin);
      }
      let r;
      expect(() => { r = analyzeFile(buf, `bcm-${i}.bin`); }).not.toThrow();
      assertAnalyzeShape(r, `bcm-fuzz-${i}`);
      expect(r.type).toBe('BCM');
    }
  });

  it('200 random 4096-byte buffers → always RFHUB or GPEC2A or TCM/TIPM, never throws', () => {
    const rng = makeRng(0xFEEDFACE);
    for (let i = 0; i < 200; i++) {
      const buf = makeRand(rng, 4096);
      let r;
      expect(() => { r = analyzeFile(buf, `4k-${i}.bin`); }).not.toThrow();
      assertAnalyzeShape(r, `4k-fuzz-${i}`);
      expect(['RFHUB', 'GPEC2A', 'TCM', 'TIPM']).toContain(r.type);
    }
  });

  it('100 random near-canonical sizes ±4096 → no throw, hexOnly matches type', () => {
    const rng = makeRng(0xDEADBEEF);
    const bases = [4096, 8192, 16384, 65536, 131072];
    for (let i = 0; i < 100; i++) {
      const base = rng.pick(bases);
      const delta = rng.nextInt(-4096, 4096);
      const sz = Math.max(0, base + delta);
      const buf = makeRand(rng, sz);
      let r;
      expect(() => { r = analyzeFile(buf, `near-${i}.bin`); }).not.toThrow();
      assertAnalyzeShape(r, `near-fuzz-${i}`);
    }
  });
});
