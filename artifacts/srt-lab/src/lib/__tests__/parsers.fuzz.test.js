import { describe, it, expect } from 'vitest';

import {
  crc16, crc8_42, crc8rf, crc8_65, crc16ccitt, crc16generic,
  rfhGen2VinCs, rfhGen2DetectMagic, rfhSec16Cs,
} from '../crc.js';

import {
  parseModule, detectBySignature, extractVIN, extractHex,
  syncImmoBackup, countSkimRecs,
} from '../parseModule.js';

import { parseRFH24C32, parsePCMGPEC } from '../rfhPcmPair.js';

import {
  checkVin, parseVinYear, vinHasSGW, vinCheckDigitValid,
} from '../vin.js';

import { backupDidsToBytes } from '../checksum.js';

import { vinFromReadResponse, encodeDid } from '../algos.js';

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

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
    nextString: (n) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+[];:,./<>?\\|`~\'"';
      return Array.from({ length: n }, () => chars[Math.floor(next() * chars.length)]).join('');
    },
  };
}

// ── Buffer sizes for parseModule probing ─────────────────────────────────────

const CANONICAL_SIZES = [0, 1, 7, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536, 131072];

// ── Fixed edge-case buffers ───────────────────────────────────────────────────

const EMPTY   = new Uint8Array(0);
const ALL_00  = (n) => new Uint8Array(n).fill(0x00);
const ALL_FF  = (n) => new Uint8Array(n).fill(0xff);
const ALL_A5  = (n) => new Uint8Array(n).fill(0xa5);
const SINGLE  = (b) => new Uint8Array([b]);

// ── CRC helpers ───────────────────────────────────────────────────────────────

describe('CRC functions — never throw, always return a number', () => {
  const rng = makeRng(0x01234567);

  const crcFns = [
    ['crc16',      (d) => crc16(d)],
    ['crc8_42',    (d) => crc8_42(d)],
    ['crc8rf',     (d) => crc8rf(d)],
    ['crc8_65',    (d) => crc8_65(d)],
    ['crc16ccitt', (d) => crc16ccitt(d)],
    ['crc16generic-0x1021', (d) => crc16generic(d, 0x1021, 0xFFFF)],
    ['crc16generic-0x8005', (d) => crc16generic(d, 0x8005, 0x0000)],
    ['rfhGen2VinCs-0xDB',   (d) => rfhGen2VinCs(d, 0xDB)],
    ['rfhGen2VinCs-0x87',   (d) => rfhGen2VinCs(d, 0x87)],
    ['rfhSec16Cs',          (d) => rfhSec16Cs(d)],
  ];

  const fixedBuffers = [
    ['empty', EMPTY],
    ['single 0x00', SINGLE(0x00)],
    ['single 0xFF', SINGLE(0xff)],
    ['8 zeros', ALL_00(8)],
    ['8 FF',    ALL_FF(8)],
    ['256 zeros', ALL_00(256)],
    ['256 FF',    ALL_FF(256)],
    ['256 A5',    ALL_A5(256)],
  ];

  for (const [fname, fn] of crcFns) {
    describe(fname, () => {
      for (const [label, buf] of fixedBuffers) {
        it(`does not throw and returns a number: ${label}`, () => {
          let result;
          expect(() => { result = fn(buf); }, `${fname}(${label}) must not throw`).not.toThrow();
          expect(typeof result, `${fname}(${label}) must return a number`).toBe('number');
          expect(Number.isFinite(result), `${fname}(${label}) must be finite`).toBe(true);
        });
      }

      it('never throws on 500 random buffers', () => {
        const localRng = makeRng(0xdeadbeef);
        for (let i = 0; i < 500; i++) {
          const len = localRng.nextInt(0, 512);
          const buf = localRng.nextBytes(len);
          let result;
          expect(() => { result = fn(buf); }).not.toThrow();
          expect(typeof result).toBe('number');
          expect(Number.isFinite(result)).toBe(true);
        }
      });
    });
  }

  it('rfhGen2DetectMagic never throws and always returns a number', () => {
    for (let i = 0; i < 300; i++) {
      const raw17 = rng.nextBytes(rng.nextInt(0, 32));
      const storedCs = rng.nextInt(0, 255);
      let result;
      expect(() => { result = rfhGen2DetectMagic(raw17, storedCs); }).not.toThrow();
      expect(typeof result).toBe('number');
      expect(Number.isFinite(result)).toBe(true);
    }
  });
});

// ── detectBySignature ─────────────────────────────────────────────────────────

describe('detectBySignature — never throws, always returns a string', () => {
  const VALID_TYPES = new Set(['BCM', 'TCM', 'TIPM', 'RFHUB', 'GPEC2A', '95640', 'FW', 'UNKNOWN']);

  function assertSig(buf, label) {
    let result;
    expect(() => { result = detectBySignature(buf); }, `${label} must not throw`).not.toThrow();
    expect(typeof result, `${label} must return a string`).toBe('string');
    expect(VALID_TYPES.has(result) || result === 'UNKNOWN', `${label}: got unexpected type "${result}"`).toBe(true);
  }

  for (const sz of CANONICAL_SIZES) {
    it(`size=${sz} zeros`, () => assertSig(ALL_00(sz), `zeros[${sz}]`));
    it(`size=${sz} FF`,    () => assertSig(ALL_FF(sz), `FF[${sz}]`));
  }

  it('never throws on 500 random buffers', () => {
    const rng = makeRng(0xfeedface);
    for (let i = 0; i < 500; i++) {
      const len = rng.nextInt(0, 200000);
      const buf = rng.nextBytes(Math.min(len, 512));
      assertSig(buf, `random[${i}] notional-len=${len}`);
    }
  });
});

// ── extractVIN ────────────────────────────────────────────────────────────────

describe('extractVIN — never throws, returns string or null', () => {
  const rng = makeRng(0xabcdef01);

  function assertExtractVIN(data, offset, len, label) {
    let result;
    expect(() => { result = extractVIN(data, offset, len); }, `${label} must not throw`).not.toThrow();
    expect(result === null || typeof result === 'string', `${label}: must return string or null`).toBe(true);
  }

  it('handles empty buffer at any offset', () => {
    for (const off of [0, 1, 17, 100]) {
      assertExtractVIN(EMPTY, off, 17, `empty off=${off}`);
    }
  });

  it('handles zero-length len arg', () => {
    assertExtractVIN(ALL_FF(64), 0, 0, 'len=0');
  });

  it('handles offset past end of buffer', () => {
    assertExtractVIN(ALL_00(16), 32, 17, 'offset past end');
  });

  it('never throws on 500 random inputs', () => {
    for (let i = 0; i < 500; i++) {
      const sz   = rng.nextInt(0, 256);
      const buf  = rng.nextBytes(sz);
      const off  = rng.nextInt(0, Math.max(sz + 10, 1));
      const len  = rng.nextInt(0, 24);
      assertExtractVIN(buf, off, len, `random[${i}]`);
    }
  });
});

// ── extractHex ────────────────────────────────────────────────────────────────

describe('extractHex — never throws, always returns a string', () => {
  const rng = makeRng(0x12345678);

  it('handles empty buffer', () => {
    let r;
    expect(() => { r = extractHex(EMPTY, 0, 0); }).not.toThrow();
    expect(typeof r).toBe('string');
  });

  it('never throws on 300 random inputs', () => {
    for (let i = 0; i < 300; i++) {
      const sz  = rng.nextInt(0, 256);
      const buf = rng.nextBytes(sz);
      const off = rng.nextInt(0, Math.max(sz, 1));
      const len = rng.nextInt(0, 32);
      let r;
      expect(() => { r = extractHex(buf, off, len); }).not.toThrow();
      expect(typeof r).toBe('string');
    }
  });
});

// ── syncImmoBackup ────────────────────────────────────────────────────────────

describe('syncImmoBackup — never throws, returns Uint8Array or null', () => {
  const rng = makeRng(0xbeefcafe);

  function assertSync(buf, label) {
    let r;
    expect(() => { r = syncImmoBackup(buf); }, `${label} must not throw`).not.toThrow();
    expect(r === null || r instanceof Uint8Array, `${label}: must return Uint8Array or null`).toBe(true);
  }

  it('empty buffer', () => assertSync(EMPTY, 'empty'));
  it('single byte', () => assertSync(SINGLE(0x00), 'single'));
  it('all-FF 65536', () => assertSync(ALL_FF(65536), 'all-FF 64K'));
  it('all-00 131072', () => assertSync(ALL_00(131072), 'all-00 128K'));

  it('never throws on 200 random buffers', () => {
    for (let i = 0; i < 200; i++) {
      const sz = rng.nextInt(0, 200000);
      const buf = rng.nextBytes(Math.min(sz, 4096));
      assertSync(buf, `random[${i}]`);
    }
  });
});

// ── countSkimRecs ─────────────────────────────────────────────────────────────

describe('countSkimRecs — never throws, always returns a number', () => {
  const rng = makeRng(0xcafed00d);

  it('empty buffer at base=0', () => {
    let r;
    expect(() => { r = countSkimRecs(EMPTY, 0); }).not.toThrow();
    expect(typeof r).toBe('number');
  });

  it('never throws on 300 random inputs', () => {
    for (let i = 0; i < 300; i++) {
      const sz   = rng.nextInt(0, 131072);
      const buf  = rng.nextBytes(Math.min(sz, 4096));
      const base = rng.nextInt(0, sz + 1000);
      let r;
      expect(() => { r = countSkimRecs(buf, base); }).not.toThrow();
      expect(typeof r).toBe('number');
      expect(r >= 0).toBe(true);
    }
  });
});

// ── parseModule ───────────────────────────────────────────────────────────────

describe('parseModule — never throws, always returns a valid info object', () => {
  const KNOWN_TYPES = new Set(['BCM', 'TCM', 'TIPM', 'RFHUB', 'GPEC2A', '95640', 'FW', 'UNKNOWN']);
  const rng = makeRng(0x9a8b7c6d);

  function assertParseModule(buf, label) {
    let info;
    expect(() => { info = parseModule(buf, 'fuzz.bin'); }, `${label} must not throw`).not.toThrow();
    expect(info, `${label}: result must be defined`).toBeDefined();
    expect(typeof info.type, `${label}: type must be a string`).toBe('string');
    expect(typeof info.size, `${label}: size must be a number`).toBe('number');
    expect(info.size, `${label}: size must equal buffer length`).toBe(buf.length);
    expect(typeof info.name, `${label}: name must be a string`).toBe('string');
    if (info.vins !== undefined) {
      expect(Array.isArray(info.vins), `${label}: vins must be an array`).toBe(true);
    }
  }

  for (const sz of CANONICAL_SIZES) {
    it(`all-zeros size=${sz}`, () => assertParseModule(ALL_00(sz), `zeros[${sz}]`));
    it(`all-FF size=${sz}`, () => assertParseModule(ALL_FF(sz), `FF[${sz}]`));
    it(`all-A5 size=${sz}`, () => assertParseModule(ALL_A5(sz), `A5[${sz}]`));
  }

  it('never throws on 300 random buffers', () => {
    for (let i = 0; i < 300; i++) {
      const sz = rng.nextInt(0, 131072);
      const buf = rng.nextBytes(Math.min(sz, 4096));
      assertParseModule(buf, `random[${i}] sz=${sz}`);
    }
  });

  it('never throws on canonical-sized random buffers', () => {
    for (const sz of [2048, 4096, 8192, 16384, 65536]) {
      const buf = rng.nextBytes(sz);
      assertParseModule(buf, `canonical random[${sz}]`);
    }
  });
});

// ── parseRFH24C32 ─────────────────────────────────────────────────────────────

describe('parseRFH24C32 — never throws, always returns a valid result object', () => {
  const rng = makeRng(0x55aa55aa);

  function assertRFH(buf, label) {
    let result;
    expect(() => { result = parseRFH24C32(buf); }, `${label} must not throw`).not.toThrow();
    expect(result, `${label}: result must be defined`).toBeDefined();
    expect(typeof result.gen, `${label}: gen must be a string`).toBe('string');
    expect(['gen1', 'gen2'].includes(result.gen), `${label}: gen must be gen1 or gen2`).toBe(true);
    expect(typeof result.size, `${label}: size must be a number`).toBe('number');
    expect(Array.isArray(result.checks), `${label}: checks must be an array`).toBe(true);
    for (const c of result.checks) {
      expect(typeof c.k, `${label}: check.k must be a string`).toBe('string');
      expect(typeof c.ok, `${label}: check.ok must be a boolean`).toBe('boolean');
    }
  }

  const FIXED = [
    ['empty', EMPTY],
    ['1 byte 0x00', SINGLE(0x00)],
    ['1 byte 0xFF', SINGLE(0xff)],
    ['128 zeros', ALL_00(128)],
    ['128 FF', ALL_FF(128)],
    ['2048 zeros (Gen1 size)', ALL_00(2048)],
    ['2048 FF (Gen1 size)', ALL_FF(2048)],
    ['4096 zeros (Gen2 size)', ALL_00(4096)],
    ['4096 FF (Gen2 size)', ALL_FF(4096)],
    ['8192 zeros (double-dump)', ALL_00(8192)],
    ['8192 FF (double-dump)', ALL_FF(8192)],
  ];

  for (const [label, buf] of FIXED) {
    it(`fixed: ${label}`, () => assertRFH(buf, label));
  }

  it('never throws on 400 random buffers', () => {
    for (let i = 0; i < 400; i++) {
      const sz = rng.nextInt(0, 8192);
      const buf = rng.nextBytes(sz);
      assertRFH(buf, `random[${i}] sz=${sz}`);
    }
  });

  it('never throws on random 4096-byte (Gen2) buffers', () => {
    for (let i = 0; i < 200; i++) {
      const buf = rng.nextBytes(4096);
      assertRFH(buf, `gen2-random[${i}]`);
    }
  });
});

// ── parsePCMGPEC ──────────────────────────────────────────────────────────────

describe('parsePCMGPEC — never throws, always returns a valid result object', () => {
  const rng = makeRng(0xaa11bb22);

  const IMMO_STATES = new Set(['IMMO_DAMAGED', 'ENABLED', 'DISABLED', 'UNKNOWN']);

  function assertPCM(buf, label) {
    let result;
    expect(() => { result = parsePCMGPEC(buf); }, `${label} must not throw`).not.toThrow();
    expect(result, `${label}: result must be defined`).toBeDefined();
    expect(typeof result.size, `${label}: size must be a number`).toBe('number');
    expect(result.size, `${label}: size must equal buffer length`).toBe(buf.length);
    expect(result.immo, `${label}: immo must be defined`).toBeDefined();
    expect(IMMO_STATES.has(result.immo.state), `${label}: immo.state "${result.immo.state}" must be valid`).toBe(true);
    if (result.sec6 !== null && result.sec6 !== undefined) {
      expect(Array.isArray(result.sec6.raw), `${label}: sec6.raw must be an array`).toBe(true);
      expect(result.sec6.raw.length, `${label}: sec6.raw must be 6 bytes`).toBe(6);
      expect(typeof result.sec6.hex, `${label}: sec6.hex must be a string`).toBe('string');
    }
  }

  const FIXED = [
    ['empty', EMPTY],
    ['1 byte', SINGLE(0x42)],
    ['256 zeros', ALL_00(256)],
    ['4096 zeros (exact size)', ALL_00(4096)],
    ['4096 FF (exact size)', ALL_FF(4096)],
    ['4096 A5 (exact size)', ALL_A5(4096)],
    ['1000 bytes (undersized)', ALL_00(1000)],
    ['8192 bytes (oversized)', ALL_FF(8192)],
  ];

  for (const [label, buf] of FIXED) {
    it(`fixed: ${label}`, () => assertPCM(buf, label));
  }

  it('never throws on 400 random buffers', () => {
    for (let i = 0; i < 400; i++) {
      const sz = rng.nextInt(0, 8192);
      const buf = rng.nextBytes(sz);
      assertPCM(buf, `random[${i}] sz=${sz}`);
    }
  });

  it('never throws on random 4096-byte (exact-size) buffers', () => {
    for (let i = 0; i < 200; i++) {
      const buf = rng.nextBytes(4096);
      assertPCM(buf, `exact-random[${i}]`);
    }
  });
});

// ── VIN string parsers ────────────────────────────────────────────────────────

describe('VIN parsers (checkVin / parseVinYear / vinHasSGW / vinCheckDigitValid) — never throw', () => {
  const rng = makeRng(0x13579bdf);

  const FIXED_STRINGS = [
    '',
    'A',
    '1234567890',
    '12345678901234567',               // 17 chars, invalid VIN
    '1C3CDFBB4ED784631',               // real FCA VIN
    '2C3CDXKT3FH796320',               // real FCA VIN
    'AAAAAAAAAAAAAAAA',                // 16 chars
    'AAAAAAAAAAAAAAAAAA',              // 18 chars
    '00000000000000000',               // 17 zeros
    'IIIIIIIIIIIIIIIII',               // banned char I
    '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09',
    '\uD800\uDFFF',                    // unpaired surrogates
    '💀'.repeat(5),                     // emoji
    null,
    undefined,
    0,
    [],
    {},
    true,
  ];

  const vinFns = [
    ['checkVin',           (v) => checkVin(v)],
    ['parseVinYear',       (v) => parseVinYear(v)],
    ['vinHasSGW',          (v) => vinHasSGW(v)],
    ['vinCheckDigitValid', (v) => vinCheckDigitValid(v)],
  ];

  for (const [fname, fn] of vinFns) {
    describe(fname, () => {
      for (const s of FIXED_STRINGS) {
        it(`does not throw on: ${JSON.stringify(s)}`, () => {
          expect(() => fn(s)).not.toThrow();
        });
      }

      it('never throws on 500 random strings of varying lengths', () => {
        for (let i = 0; i < 500; i++) {
          const len = rng.nextInt(0, 30);
          const s = rng.nextString(len);
          expect(() => fn(s), `${fname} must not throw on: ${JSON.stringify(s)}`).not.toThrow();
        }
      });

      it('never throws on random byte-string-like inputs', () => {
        for (let i = 0; i < 200; i++) {
          const bytes = rng.nextBytes(rng.nextInt(0, 24));
          const s = String.fromCharCode(...bytes);
          expect(() => fn(s)).not.toThrow();
        }
      });
    });
  }
});

// ── backupDidsToBytes ─────────────────────────────────────────────────────────

describe('backupDidsToBytes — never throws, always returns Uint8Array', () => {
  const rng = makeRng(0xfaceb00c);

  function assertBackup(dids, label) {
    let result;
    expect(() => { result = backupDidsToBytes(dids); }, `${label} must not throw`).not.toThrow();
    expect(result instanceof Uint8Array, `${label}: must return a Uint8Array`).toBe(true);
  }

  const FIXED_DIDS = [
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'empty object'],
    [{ F190: { missing: true } }, 'single missing DID'],
    [{ F190: { missing: false, bytes: [] } }, 'empty bytes array'],
    [{ F190: { missing: false, bytes: [0xDE, 0xAD] } }, 'two-byte DID'],
    [{ F190: { bytes: [1, 2, 3] }, F191: { bytes: [4, 5, 6] } }, 'two DIDs'],
    [{ F190: { missing: false, bytes: 'not-an-array' } }, 'bytes is a string'],
    [{ F190: { missing: false, bytes: null } }, 'bytes is null'],
    [{ F190: { missing: false, bytes: { 0: 1, 1: 2, length: 2 } } }, 'bytes is array-like object'],
    [{ F190: undefined }, 'DID value is undefined'],
    [{ F190: null }, 'DID value is null'],
    [[], 'array (not object)'],
    ['string-dids', 'string'],
    [42, 'number'],
  ];

  for (const [dids, label] of FIXED_DIDS) {
    it(`fixed: ${label}`, () => assertBackup(dids, label));
  }

  it('never throws on 300 random-shaped dids objects', () => {
    for (let i = 0; i < 300; i++) {
      const nKeys = rng.nextInt(0, 8);
      const dids = {};
      for (let k = 0; k < nKeys; k++) {
        const key = 'DID_' + rng.nextInt(0, 0xFFFF).toString(16);
        const strategy = rng.nextInt(0, 4);
        if (strategy === 0) {
          dids[key] = { missing: true };
        } else if (strategy === 1) {
          dids[key] = { missing: false, bytes: [] };
        } else if (strategy === 2) {
          const len = rng.nextInt(0, 64);
          dids[key] = { missing: false, bytes: Array.from(rng.nextBytes(len)) };
        } else if (strategy === 3) {
          dids[key] = { missing: false, bytes: null };
        } else {
          dids[key] = null;
        }
      }
      assertBackup(dids, `random[${i}]`);
    }
  });
});

// ── vinFromReadResponse ───────────────────────────────────────────────────────

describe('vinFromReadResponse — never throws, always returns a string', () => {
  const rng = makeRng(0x77665544);

  function assertVinFromRead(d, did, label) {
    let result;
    expect(() => { result = vinFromReadResponse(d, did); }, `${label} must not throw`).not.toThrow();
    expect(typeof result, `${label}: must return a string`).toBe('string');
  }

  const DIDS_TO_TRY = [0xF190, 0x7B90, 0x7B88, 0x6E2025, 0x6E2027, 0x6EF190, 0, 0xFFFF, 1];

  const FIXED_RESPONSES = [
    [null, 'null'],
    [undefined, 'undefined'],
    [[], 'empty array'],
    [new Uint8Array(0), 'empty Uint8Array'],
    [[0x62], 'single 0x62'],
    [[0x7F, 0x22, 0x31], 'NRC response'],
    [[0x62, 0xF1, 0x90, ...new TextEncoder().encode('2C3CDXKT3FH796320')], 'valid VIN response F190'],
    [new Uint8Array(256).fill(0x62), '256-byte all-0x62'],
    [new Uint8Array(256).fill(0xFF), '256-byte all-FF'],
  ];

  for (const did of DIDS_TO_TRY.slice(0, 3)) {
    for (const [d, label] of FIXED_RESPONSES) {
      it(`DID=0x${did.toString(16)} ${label}`, () => assertVinFromRead(d, did, `DID=${did} ${label}`));
    }
  }

  it('never throws on 500 random byte-array inputs', () => {
    for (let i = 0; i < 500; i++) {
      const len = rng.nextInt(0, 64);
      const buf = rng.nextBytes(len);
      const did = DIDS_TO_TRY[rng.nextInt(0, DIDS_TO_TRY.length - 1)];
      assertVinFromRead(Array.from(buf), did, `random[${i}]`);
    }
  });

  it('never throws on inputs starting with 0x62 (positive response)', () => {
    for (let i = 0; i < 300; i++) {
      const len = rng.nextInt(1, 64);
      const buf = rng.nextBytes(len);
      buf[0] = 0x62;
      const did = DIDS_TO_TRY[rng.nextInt(0, DIDS_TO_TRY.length - 1)];
      assertVinFromRead(Array.from(buf), did, `0x62-prefix[${i}]`);
    }
  });
});

// ── encodeDid ─────────────────────────────────────────────────────────────────
// encodeDid is intentionally documented to throw on bad input.
// We only fuzz valid ranges and verify it never produces NaN/Infinity.

describe('encodeDid — returns well-formed byte arrays for valid DIDs', () => {
  const VALID_DIDS = [
    0x0000, 0x0001, 0x00FF, 0xF190, 0x7B90, 0xFFFF,
    0x010000, 0x6E2025, 0x6EF190, 0xFFFFFF,
  ];

  for (const did of VALID_DIDS) {
    it(`DID=0x${did.toString(16)} returns array of 2 or 3 bytes`, () => {
      let result;
      expect(() => { result = encodeDid(did); }).not.toThrow();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length === 2 || result.length === 3).toBe(true);
      for (const b of result) {
        expect(b >= 0 && b <= 255).toBe(true);
      }
    });
  }

  it('never throws on 500 random valid-range DIDs', () => {
    const rng = makeRng(0x12349876);
    for (let i = 0; i < 500; i++) {
      const did = rng.nextInt(0, 0xFFFFFF);
      let result;
      expect(() => { result = encodeDid(did); }).not.toThrow();
      expect(Array.isArray(result)).toBe(true);
    }
  });
});
