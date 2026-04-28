import { describe, it, expect } from 'vitest';
import {
  patchFile,
  virginizeFile,
  writeModuleVIN,
  virginizeModule,
  syncImmoBackupF,
  analyzeFile,
} from '../fileUtils.js';
import { programVin } from '../vinProgrammer.js';
import { encodeDid, vinWriteDids, unlockKey } from '../algos.js';
import { IMMO_BLOCK } from '../constants.js';

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────────

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
    nextInt:  (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    nextByte: ()       => Math.floor(next() * 256),
    nextBytes:(n)      => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
    pick:     (arr)    => arr[Math.floor(next() * arr.length)],
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_TYPES = ['BCM', 'RFHUB', 'GPEC2A', '95640', 'FW', 'TCM', 'TIPM', 'UNKNOWN'];

// Canonical buffer sizes that analyzeFile recognises for each type.
const TYPE_SIZES = {
  BCM:    [65536, 131072],
  RFHUB:  [4096],
  GPEC2A: [4096],
  '95640':[8192, 16384],
  FW:     [262144],
  TCM:    [8192],
  TIPM:   [8192],
  UNKNOWN:[512],
};

// Minimum buffer size that syncImmoBackupF needs to return non-null.
// max(0x40C0 + IMMO_BLOCK, 0x2000 + IMMO_BLOCK)
const SYNC_MIN = 0x40C0 + IMMO_BLOCK; // 16576

// ── Valid VIN helpers ─────────────────────────────────────────────────────────

const VALID_VINS = [
  '1C4HJXEN5MW123456',
  '1C4RJFBG8EC123456',
  '2C3CDXHG0FH123456',
  '1C4BJWDG3HL123456',
  '1C4RJFCT5FC123456',
];

function randomVin(rng) {
  return VALID_VINS[rng.nextInt(0, VALID_VINS.length - 1)];
}

// ── Buffer factories ──────────────────────────────────────────────────────────

function makeZeroBuffer(size)  { return new Uint8Array(size).fill(0x00); }
function makeFFBuffer(size)    { return new Uint8Array(size).fill(0xff); }
function makeRandBuffer(rng, size) { return rng.nextBytes(size); }

// ── patchFile / virginizeFile object factories ────────────────────────────────

// Build a minimal, structurally-valid file object for patchFile/virginizeFile.
// `vins` and `partials` can carry adversarial offset values to exercise OOB paths.
function makeFileObject({ type = 'BCM', bufSize = 65536, vins = [], partials = [], data = null } = {}) {
  return {
    type,
    data: data ?? makeZeroBuffer(bufSize),
    vins,
    partials,
    sec: null,
  };
}

// Produce a vin-slot entry for patchFile that points at `off` in the buffer.
function makeVinSlot({ off = 0, algo = 'none', coff = -1, mirrored = false } = {}) {
  return { off, vin: '1C4HJXEN5MW123456', algo, coff, ok: true, cv: {}, mirrored };
}

// ── Output shape assertions ───────────────────────────────────────────────────

function assertPatchResult(result, label) {
  expect(result,               `${label}: patchFile must return an object`).toBeDefined();
  expect(result.data,          `${label}: result.data must exist`).toBeDefined();
  expect(result.data instanceof Uint8Array, `${label}: result.data must be a Uint8Array`).toBe(true);
  expect(Array.isArray(result.log), `${label}: result.log must be an Array`).toBe(true);
}

function assertWriteModuleVINResult(result, label) {
  if (result === null) return; // null is a documented valid return for bad inputs
  expect(result instanceof Uint8Array, `${label}: writeModuleVIN must return null or Uint8Array`).toBe(true);
}

function assertVirginizeResult(result, label) {
  expect(result,               `${label}: virginizeFile must return an object`).toBeDefined();
  expect(result.data instanceof Uint8Array, `${label}: result.data must be Uint8Array`).toBe(true);
  expect(Array.isArray(result.log), `${label}: result.log must be an Array`).toBe(true);
}

function assertProgramVinResult(result, label) {
  expect(result,                          `${label}: programVin must resolve`).toBeDefined();
  expect(typeof result.ok,                `${label}: ok must be boolean`).toBe('boolean');
  expect(Array.isArray(result.errors),    `${label}: errors must be Array`).toBe(true);
  expect(Array.isArray(result.didResults),`${label}: didResults must be Array`).toBe(true);
  if (result.reason !== null && result.reason !== undefined) {
    expect(typeof result.reason, `${label}: reason must be string`).toBe('string');
  }
}

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 1 — patchFile fixed edge cases
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('patchFile — fixed edge cases', () => {
  const newVin = '1C4HJXEN5MW123456';

  it('empty vins + partials arrays — must not throw, log is empty array', () => {
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins: [], partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'empty-vins');
  });

  it('single BCM-type vin slot at offset 0 with c16 algo', () => {
    const vins = [makeVinSlot({ off: 0, algo: 'c16', coff: 17 })];
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'bcm-c16-off0');
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('RFHUB mirrored vin slot with c8 algo', () => {
    const vins = [makeVinSlot({ off: 0xEA5, algo: 'c8', coff: 0xEA5 + 17, mirrored: true })];
    const f = makeFileObject({ type: 'RFHUB', bufSize: 4096, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'rfhub-mirrored');
  });

  it('95640-type vin slot with c8 algo', () => {
    const vins = [makeVinSlot({ off: 0x275, algo: 'c8', coff: 0x274 })];
    const f = makeFileObject({ type: '95640', bufSize: 8192, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, '95640-c8');
  });

  it('vin slot offset exceeds buffer length (OOB write — TypedArray must silently ignore)', () => {
    const vins = [makeVinSlot({ off: 99999, algo: 'none', coff: -1 })];
    const f = makeFileObject({ type: 'UNKNOWN', bufSize: 512, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'oob-offset');
  });

  it('c16 coff at the very last byte of buffer', () => {
    const sz = 64;
    const vins = [makeVinSlot({ off: 0, algo: 'c16', coff: sz - 1 })];
    const f = makeFileObject({ type: 'UNKNOWN', bufSize: sz, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'coff-tail');
  });

  it('partials array with a valid partial entry', () => {
    const partials = [{ off: 0x4098, coff: 0x40A0 }];
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins: [], partials });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'partials-only');
  });

  it('BCM type with immo sync (IMMO_BLOCK bytes available at both 0x40C0 and 0x2000)', () => {
    const buf = makeZeroBuffer(65536);
    const vins = [makeVinSlot({ off: 0x5320, algo: 'c16', coff: 0x5331 })];
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins, partials: [], data: buf });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'bcm-immo-sync');
    expect(result.log.some(l => /IMMO/i.test(l))).toBe(true);
  });

  it('BCM buffer too small for immo sync — must not throw (sync skipped silently)', () => {
    const vins = [makeVinSlot({ off: 0, algo: 'none', coff: -1 })];
    const f = makeFileObject({ type: 'BCM', bufSize: 256, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'bcm-tiny-buf');
  });

  it('zero-byte buffer with no vins', () => {
    const f = makeFileObject({ type: 'UNKNOWN', bufSize: 0, vins: [], partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'zero-buf');
  });

  it('all-0xFF BCM buffer — patch writes correct bytes', () => {
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, data: makeFFBuffer(65536), vins: [], partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'ff-buf');
  });

  it('multiple vin slots with mixed algos', () => {
    const vins = [
      makeVinSlot({ off: 0,    algo: 'c16', coff: 17 }),
      makeVinSlot({ off: 32,   algo: 'c8',  coff: 31 }),
      makeVinSlot({ off: 64,   algo: 'none',coff: -1 }),
      makeVinSlot({ off: 128,  algo: 'c16', coff: 145, mirrored: false }),
    ];
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins, partials: [] });
    let result;
    expect(() => { result = patchFile(f, newVin); }).not.toThrow();
    assertPatchResult(result, 'multi-slot-mixed');
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 2 — writeModuleVIN fixed edge cases
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('writeModuleVIN — fixed edge cases', () => {
  const vin = '1C4HJXEN5MW123456';

  it('returns null for a VIN shorter than 17 chars', () => {
    const r = writeModuleVIN(makeZeroBuffer(65536), 'BCM', 'TOOSHORT', null);
    expect(r).toBeNull();
  });

  it('returns null for a VIN longer than 17 chars', () => {
    const r = writeModuleVIN(makeZeroBuffer(65536), 'BCM', '1C4HJXEN5MW1234567', null);
    expect(r).toBeNull();
  });

  it('BCM — full-sized buffer writes VIN without throwing', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(65536), 'BCM', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'bcm-full');
    expect(r).not.toBeNull();
  });

  it('BCM — undersized buffer (too small for immo sync) — must not throw', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(256), 'BCM', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'bcm-undersized');
  });

  it('RFHUB — full-sized buffer without existingVins uses default offsets', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(4096), 'RFHUB', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'rfhub-defaults');
  });

  it('RFHUB — existingVins with mirrored flag triggers reversed write', () => {
    const existingVins = [
      { offset: 0xEA5, mirrored: true },
      { offset: 0xEB9, mirrored: true },
    ];
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(4096), 'RFHUB', vin, existingVins); }).not.toThrow();
    assertWriteModuleVINResult(r, 'rfhub-mirrored');
  });

  it('RFHUB — existingVins without mirrored flag uses non-mirrored path', () => {
    const existingVins = [{ offset: 0xEA5, mirrored: false }];
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(4096), 'RFHUB', vin, existingVins); }).not.toThrow();
    assertWriteModuleVINResult(r, 'rfhub-not-mirrored');
  });

  it('GPEC2A — standard sized buffer', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(4096), 'GPEC2A', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'gpec2a');
  });

  it('95640 — standard sized buffer', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(8192), '95640', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, '95640');
  });

  it('UNKNOWN type — returns a Uint8Array with no writes (empty offs)', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(512), 'UNKNOWN', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'unknown-type');
  });

  it('empty buffer (0 bytes) — must not throw', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeZeroBuffer(0), 'BCM', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'zero-buf');
  });

  it('BCM — all-0xFF buffer — must not throw', () => {
    let r;
    expect(() => { r = writeModuleVIN(makeFFBuffer(65536), 'BCM', vin, null); }).not.toThrow();
    assertWriteModuleVINResult(r, 'ff-buf');
  });

  it('BCM immo sync: output at 0x2000..0x2000+IMMO_BLOCK mirrors 0x40C0', () => {
    const buf = makeZeroBuffer(65536);
    const r = writeModuleVIN(buf, 'BCM', vin, null);
    expect(r).not.toBeNull();
    for (let i = 0; i < IMMO_BLOCK; i++) {
      expect(r[0x2000 + i]).toBe(r[0x40C0 + i]);
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 3 — virginizeFile fixed edge cases
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('virginizeFile — fixed edge cases', () => {
  for (const type of ALL_TYPES) {
    it(`never throws for type=${type} with a canonical-sized buffer`, () => {
      const size = (TYPE_SIZES[type] || [65536])[0];
      const f = makeFileObject({
        type,
        bufSize: size,
        vins: [makeVinSlot({ off: 0, algo: 'none' })],
        partials: [],
      });
      let result;
      expect(() => { result = virginizeFile(f); }, `type=${type} must not throw`).not.toThrow();
      assertVirginizeResult(result, `virginize-${type}`);
    });
  }

  it('BCM — empty vins and partials', () => {
    const f = makeFileObject({ type: 'BCM', bufSize: 65536, vins: [], partials: [] });
    let result;
    expect(() => { result = virginizeFile(f); }).not.toThrow();
    assertVirginizeResult(result, 'bcm-empty-vins');
  });

  it('RFHUB — zero-byte buffer must not throw', () => {
    const f = makeFileObject({ type: 'RFHUB', bufSize: 0, vins: [], partials: [] });
    let result;
    expect(() => { result = virginizeFile(f); }).not.toThrow();
    assertVirginizeResult(result, 'rfhub-zero-buf');
  });

  it('UNKNOWN type — logs something and does not throw', () => {
    const f = makeFileObject({ type: 'UNKNOWN', bufSize: 512, vins: [], partials: [] });
    let result;
    expect(() => { result = virginizeFile(f); }).not.toThrow();
    assertVirginizeResult(result, 'unknown-type');
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 4 — virginizeModule fixed edge cases
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('virginizeModule — fixed edge cases', () => {
  for (const type of ALL_TYPES) {
    it(`never throws for type=${type} with a canonical-sized buffer`, () => {
      const size = (TYPE_SIZES[type] || [65536])[0];
      let result;
      expect(
        () => { result = virginizeModule(makeZeroBuffer(size), type); },
        `type=${type} must not throw`,
      ).not.toThrow();
      expect(result instanceof Uint8Array, `type=${type}: result must be Uint8Array`).toBe(true);
    });
  }

  it('zero-byte buffer — must not throw for any type', () => {
    for (const type of ALL_TYPES) {
      expect(
        () => virginizeModule(makeZeroBuffer(0), type),
        `zero-buf type=${type}`,
      ).not.toThrow();
    }
  });

  it('1-byte buffer — must not throw for any type', () => {
    for (const type of ALL_TYPES) {
      expect(
        () => virginizeModule(makeZeroBuffer(1), type),
        `1-byte type=${type}`,
      ).not.toThrow();
    }
  });

  it('BCM — immo ranges zeroed to 0xFF in full-sized buffer', () => {
    const out = virginizeModule(makeZeroBuffer(65536), 'BCM');
    for (let i = 0; i < IMMO_BLOCK; i++) {
      expect(out[0x40C0 + i]).toBe(0xFF);
      expect(out[0x2000 + i]).toBe(0xFF);
    }
  });

  it('all-0xFF buffer for each type — must not throw', () => {
    for (const type of ALL_TYPES) {
      const size = (TYPE_SIZES[type] || [65536])[0];
      expect(
        () => virginizeModule(makeFFBuffer(size), type),
        `ff-buf type=${type}`,
      ).not.toThrow();
    }
  });

  it('unknown type string — returns Uint8Array unchanged', () => {
    const buf = makeZeroBuffer(64);
    let result;
    expect(() => { result = virginizeModule(buf, 'NOT_A_REAL_TYPE'); }).not.toThrow();
    expect(result instanceof Uint8Array).toBe(true);
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 5 — syncImmoBackupF fixed edge cases
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('syncImmoBackupF — fixed edge cases', () => {
  it('zero-byte buffer returns null (too small)', () => {
    expect(syncImmoBackupF(makeZeroBuffer(0))).toBeNull();
  });

  it('one-byte buffer returns null', () => {
    expect(syncImmoBackupF(makeZeroBuffer(1))).toBeNull();
  });

  it(`buffer just below SYNC_MIN (${SYNC_MIN - 1} bytes) returns null`, () => {
    expect(syncImmoBackupF(makeZeroBuffer(SYNC_MIN - 1))).toBeNull();
  });

  it(`buffer exactly at SYNC_MIN (${SYNC_MIN} bytes) returns a Uint8Array`, () => {
    const result = syncImmoBackupF(makeZeroBuffer(SYNC_MIN));
    expect(result instanceof Uint8Array).toBe(true);
  });

  it('full BCM-sized (65536) all-zero buffer syncs 0x40C0→0x2000', () => {
    const buf = makeZeroBuffer(65536);
    // Write a sentinel at 0x40C0
    for (let i = 0; i < IMMO_BLOCK; i++) buf[0x40C0 + i] = 0xAB;
    const result = syncImmoBackupF(buf);
    expect(result instanceof Uint8Array).toBe(true);
    for (let i = 0; i < IMMO_BLOCK; i++) {
      expect(result[0x2000 + i]).toBe(0xAB);
    }
  });

  it('all-0xFF full BCM buffer — sync mirrors correctly', () => {
    const result = syncImmoBackupF(makeFFBuffer(65536));
    expect(result instanceof Uint8Array).toBe(true);
    for (let i = 0; i < IMMO_BLOCK; i++) {
      expect(result[0x2000 + i]).toBe(result[0x40C0 + i]);
    }
  });

  it('does not mutate the original buffer', () => {
    const buf = makeZeroBuffer(65536);
    for (let i = 0; i < IMMO_BLOCK; i++) buf[0x40C0 + i] = 0x12;
    const before = buf[0x2000];
    syncImmoBackupF(buf);
    expect(buf[0x2000]).toBe(before); // original is unchanged
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 6 — programVin synchronous rejection paths
// (These exit before any async UDS traffic so they can be fuzzed synchronously.)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('programVin — synchronous rejection paths', () => {
  const validVin = '1C4HJXEN5MW123456';
  const validRow = { tx: 0x750, rx: 0x758, code: 'BCM', kind: 'vin', unlockId: 'cda6', accessLevel: 0x01, crc: 'module-computed' };
  const silentUds = async () => ({ ok: false, raw: 'NO DATA', d: null });
  const minEng = { uds: silentUds };

  it('resolves (not rejects) when no engine provided', async () => {
    const r = await programVin({ eng: null, row: validRow, vin: validVin });
    assertProgramVinResult(r, 'no-eng');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
  });

  it('resolves when engine has no uds function', async () => {
    const r = await programVin({ eng: {}, row: validRow, vin: validVin });
    assertProgramVinResult(r, 'eng-no-uds');
    expect(r.ok).toBe(false);
  });

  it('resolves for null row', async () => {
    const r = await programVin({ eng: minEng, row: null, vin: validVin });
    assertProgramVinResult(r, 'null-row');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
  });

  it('resolves when row is missing tx/rx', async () => {
    const r = await programVin({ eng: minEng, row: { code: 'BCM' }, vin: validVin });
    assertProgramVinResult(r, 'row-no-tx-rx');
    expect(r.ok).toBe(false);
  });

  it('resolves for null vin', async () => {
    const r = await programVin({ eng: minEng, row: validRow, vin: null });
    assertProgramVinResult(r, 'null-vin');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('preflight');
  });

  it('resolves for 16-char VIN (too short)', async () => {
    const r = await programVin({ eng: minEng, row: validRow, vin: '1C4HJXEN5MW12345' });
    assertProgramVinResult(r, 'short-vin');
    expect(r.ok).toBe(false);
  });

  it('resolves for 18-char VIN (too long)', async () => {
    const r = await programVin({ eng: minEng, row: validRow, vin: '1C4HJXEN5MW12345678' });
    assertProgramVinResult(r, 'long-vin');
    expect(r.ok).toBe(false);
  });

  it('resolves for empty string VIN', async () => {
    const r = await programVin({ eng: minEng, row: validRow, vin: '' });
    assertProgramVinResult(r, 'empty-vin');
    expect(r.ok).toBe(false);
  });

  it('resolves for row.kind=unsupported', async () => {
    const r = await programVin({ eng: minEng, row: { ...validRow, kind: 'unsupported' }, vin: validVin });
    assertProgramVinResult(r, 'unsupported-kind');
    expect(r.ok).toBe(false);
  });

  it('resolves for row.kind=no-vin', async () => {
    const r = await programVin({ eng: minEng, row: { ...validRow, kind: 'no-vin' }, vin: validVin });
    assertProgramVinResult(r, 'no-vin-kind');
    expect(r.ok).toBe(false);
  });

  it('resolves even when addLog throws', async () => {
    const throwingLog = () => { throw new Error('log exploded'); };
    const r = await programVin({ eng: null, row: validRow, vin: validVin, addLog: throwingLog });
    assertProgramVinResult(r, 'throwing-log');
    expect(r.ok).toBe(false);
  });

  it('crcStrategy from row is reflected in result for any row', async () => {
    for (const crc of ['module-computed', 'none', 'ccitt-tail8', 'made-up']) {
      const r = await programVin({ eng: null, row: { ...validRow, crc }, vin: validVin });
      assertProgramVinResult(r, `crc-${crc}`);
      expect(r.crcStrategy).toBe(crc);
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 7 — patchFile property-based fuzz (seed=0xdeadbeef, 800 samples)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

function generatePatchCorpus(rng, count) {
  const corpus = [];
  for (let i = 0; i < count; i++) {
    const strategy = rng.nextInt(0, 8);
    const type  = rng.pick(ALL_TYPES);
    const vinStr = rng.pick(VALID_VINS);

    if (strategy === 0) {
      // Empty vins/partials, random size
      const sz = rng.nextInt(0, 65536);
      corpus.push({ label: `empty-vins[${i}] sz=${sz}`, f: makeFileObject({ type, bufSize: sz }), vin: vinStr });

    } else if (strategy === 1) {
      // One c16 vin slot at a random offset in a canonical BCM buffer
      const sz  = rng.pick([65536, 131072]);
      const off = rng.nextInt(0, sz - 1);
      const coff = rng.nextInt(0, sz - 1);
      const vins = [makeVinSlot({ off, algo: 'c16', coff })];
      corpus.push({ label: `c16[${i}] off=${off}`, f: makeFileObject({ type: 'BCM', bufSize: sz, vins }), vin: vinStr });

    } else if (strategy === 2) {
      // One mirrored c8 vin slot at a random RFHUB offset
      const sz  = 4096;
      const off = rng.nextInt(0, sz - 1);
      const vins = [makeVinSlot({ off, algo: 'c8', coff: Math.min(off + 17, sz - 1), mirrored: true })];
      corpus.push({ label: `rfhub-mirror[${i}] off=${off}`, f: makeFileObject({ type: 'RFHUB', bufSize: sz, vins }), vin: vinStr });

    } else if (strategy === 3) {
      // OOB offsets — off well beyond buffer end
      const sz  = rng.nextInt(0, 512);
      const off = rng.nextInt(sz, sz + 100000);
      const vins = [makeVinSlot({ off, algo: 'none', coff: off + 17 })];
      corpus.push({ label: `oob[${i}] sz=${sz} off=${off}`, f: makeFileObject({ type, bufSize: sz, vins }), vin: vinStr });

    } else if (strategy === 4) {
      // Multiple random vin slots with random algos
      const sz    = rng.nextInt(64, 65536);
      const count = rng.nextInt(1, 6);
      const algos = ['none', 'c16', 'c8'];
      const vins  = Array.from({ length: count }, () =>
        makeVinSlot({ off: rng.nextInt(0, sz - 1), algo: rng.pick(algos), coff: rng.nextInt(0, sz - 1), mirrored: rng.next() > 0.7 }),
      );
      corpus.push({ label: `multi-slot[${i}] n=${count}`, f: makeFileObject({ type, bufSize: sz, vins }), vin: vinStr });

    } else if (strategy === 5) {
      // Partial entries with random offsets
      const sz  = rng.nextInt(64, 65536);
      const partials = Array.from({ length: rng.nextInt(1, 4) }, () =>
        ({ off: rng.nextInt(0, sz - 1), coff: rng.nextInt(0, sz - 1) }),
      );
      corpus.push({ label: `partials[${i}] n=${partials.length}`, f: makeFileObject({ type: 'BCM', bufSize: sz, partials }), vin: vinStr });

    } else if (strategy === 6) {
      // Tiny buffer (0–32 bytes)
      const sz   = rng.nextInt(0, 32);
      const vins = sz > 0 ? [makeVinSlot({ off: rng.nextInt(0, sz - 1), algo: 'c16', coff: 0 })] : [];
      corpus.push({ label: `tiny[${i}] sz=${sz}`, f: makeFileObject({ type, bufSize: sz, vins }), vin: vinStr });

    } else if (strategy === 7) {
      // BCM full-size buffer to exercise the IMMO sync branch
      const vins = Array.from({ length: rng.nextInt(0, 3) }, () =>
        makeVinSlot({ off: rng.nextInt(0, 65536 - 19), algo: 'c16', coff: rng.nextInt(17, 65535) }),
      );
      corpus.push({ label: `bcm-immo[${i}]`, f: makeFileObject({ type: 'BCM', bufSize: 65536, vins }), vin: vinStr });

    } else {
      // Random-bytes buffer
      const sz  = rng.nextInt(0, 65536);
      const buf = rng.nextBytes(sz);
      corpus.push({ label: `rand-buf[${i}] sz=${sz}`, f: makeFileObject({ type, bufSize: sz, data: buf }), vin: vinStr });
    }
  }
  return corpus;
}

describe('patchFile — property-based fuzz (seed=0xdeadbeef, 800 samples)', () => {
  const rng    = makeRng(0xdeadbeef);
  const corpus = generatePatchCorpus(rng, 800);

  it('never throws for any generated input', { timeout: 30000 }, () => {
    for (const { label, f, vin } of corpus) {
      expect(() => patchFile(f, vin), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns a structurally valid { data: Uint8Array, log: Array }', { timeout: 30000 }, () => {
    for (const { label, f, vin } of corpus) {
      const result = patchFile(f, vin);
      assertPatchResult(result, label);
    }
  });

  it('output buffer is always the same size as the input buffer', { timeout: 30000 }, () => {
    for (const { label, f, vin } of corpus) {
      const result = patchFile(f, vin);
      expect(result.data.length, `${label}: output size must equal input size`).toBe(f.data.length);
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 8 — writeModuleVIN property-based fuzz (seed=0xcafebabe, 800 samples)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

function generateWriteModuleVINCorpus(rng, count) {
  const corpus = [];
  const vinPool = [
    ...VALID_VINS,
    '',
    'TOOSHORT',
    '1C4HJXEN5MW1234567890', // too long
    '00000000000000000',    // all zeros (17 chars but invalid)
  ];
  for (let i = 0; i < count; i++) {
    const strategy = rng.nextInt(0, 5);
    const type     = rng.pick(ALL_TYPES);
    const vin      = rng.pick(vinPool);

    if (strategy === 0) {
      // Canonical buffer size for the type
      const sz  = rng.pick(TYPE_SIZES[type] || [65536]);
      corpus.push({ label: `canonical[${i}] type=${type} sz=${sz}`, data: makeZeroBuffer(sz), type, vin, existingVins: null });

    } else if (strategy === 1) {
      // Undersized buffer
      const sz = rng.nextInt(0, 64);
      corpus.push({ label: `tiny[${i}] type=${type} sz=${sz}`, data: makeZeroBuffer(sz), type, vin, existingVins: null });

    } else if (strategy === 2) {
      // All-0xFF canonical buffer
      const sz = rng.pick(TYPE_SIZES[type] || [65536]);
      corpus.push({ label: `ff[${i}] type=${type}`, data: makeFFBuffer(sz), type, vin, existingVins: null });

    } else if (strategy === 3) {
      // RFHUB with existingVins (mirrored)
      const existingVins = [
        { offset: rng.nextInt(0, 4095), mirrored: true },
        { offset: rng.nextInt(0, 4095), mirrored: true },
      ];
      corpus.push({ label: `rfhub-mirror[${i}]`, data: makeZeroBuffer(4096), type: 'RFHUB', vin, existingVins });

    } else if (strategy === 4) {
      // RFHUB with non-mirrored existingVins
      const existingVins = [{ offset: rng.nextInt(0, 4095), mirrored: false }];
      corpus.push({ label: `rfhub-no-mirror[${i}]`, data: makeZeroBuffer(4096), type: 'RFHUB', vin, existingVins });

    } else {
      // Random byte buffer, random size
      const sz = rng.nextInt(0, 8192);
      corpus.push({ label: `rand[${i}] type=${type} sz=${sz}`, data: rng.nextBytes(sz), type, vin, existingVins: null });
    }
  }
  return corpus;
}

describe('writeModuleVIN — property-based fuzz (seed=0xcafebabe, 800 samples)', () => {
  const rng    = makeRng(0xcafebabe);
  const corpus = generateWriteModuleVINCorpus(rng, 800);

  it('never throws for any generated input', { timeout: 30000 }, () => {
    for (const { label, data, type, vin, existingVins } of corpus) {
      expect(() => writeModuleVIN(data, type, vin, existingVins), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns null or a Uint8Array of the same length as input', { timeout: 30000 }, () => {
    for (const { label, data, type, vin, existingVins } of corpus) {
      const result = writeModuleVIN(data, type, vin, existingVins);
      assertWriteModuleVINResult(result, label);
      if (result !== null) {
        expect(result.length, `${label}: output length must match input length`).toBe(data.length);
      }
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 9 — virginizeModule property-based fuzz (seed=0xf00dcafe, 500 samples)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('virginizeModule — property-based fuzz (seed=0xf00dcafe, 500 samples)', () => {
  const rng = makeRng(0xf00dcafe);
  const corpus = Array.from({ length: 500 }, (_, i) => {
    const type = rng.next() > 0.3 ? rng.pick(ALL_TYPES) : rng.pick(['NOT_REAL', '', 'xyz', 'bcm_lower']);
    const sz   = rng.nextInt(0, 65536);
    const fill = rng.nextByte();
    const data = new Uint8Array(sz).fill(fill);
    return { label: `sample[${i}] type=${type} sz=${sz}`, data, type };
  });

  it('never throws for any generated input', { timeout: 30000 }, () => {
    for (const { label, data, type } of corpus) {
      expect(() => virginizeModule(data, type), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns a Uint8Array of the same length as the input', { timeout: 30000 }, () => {
    for (const { label, data, type } of corpus) {
      const result = virginizeModule(data, type);
      expect(result instanceof Uint8Array, `${label}: must be Uint8Array`).toBe(true);
      expect(result.length, `${label}: output length must equal input length`).toBe(data.length);
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 10 — syncImmoBackupF property-based fuzz (seed=0xbabe1234, 500 samples)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('syncImmoBackupF — property-based fuzz (seed=0xbabe1234, 500 samples)', () => {
  const rng = makeRng(0xbabe1234);
  const corpus = Array.from({ length: 500 }, (_, i) => {
    const strategy = rng.nextInt(0, 4);
    if (strategy === 0) {
      const sz = rng.nextInt(0, SYNC_MIN - 1);
      return { label: `undersized[${i}] sz=${sz}`, data: rng.nextBytes(sz), expectNull: true };
    } else if (strategy === 1) {
      const sz = rng.nextInt(SYNC_MIN, SYNC_MIN + 65536);
      return { label: `valid[${i}] sz=${sz}`, data: rng.nextBytes(sz), expectNull: false };
    } else if (strategy === 2) {
      return { label: `bcm-full[${i}]`, data: rng.nextBytes(65536), expectNull: false };
    } else if (strategy === 3) {
      return { label: `ff-buf[${i}]`, data: makeFFBuffer(65536), expectNull: false };
    } else {
      return { label: `zero-tiny[${i}]`, data: makeZeroBuffer(rng.nextInt(0, 32)), expectNull: true };
    }
  });

  it('never throws for any generated input', { timeout: 30000 }, () => {
    for (const { label, data } of corpus) {
      expect(() => syncImmoBackupF(data), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('undersized buffers always return null', { timeout: 30000 }, () => {
    for (const { label, data, expectNull } of corpus) {
      if (!expectNull) continue;
      expect(syncImmoBackupF(data), `${label}: must be null`).toBeNull();
    }
  });

  it('valid-sized buffers return a Uint8Array of the same length', { timeout: 30000 }, () => {
    for (const { label, data, expectNull } of corpus) {
      if (expectNull) continue;
      const result = syncImmoBackupF(data);
      expect(result instanceof Uint8Array, `${label}: must be Uint8Array`).toBe(true);
      expect(result.length, `${label}: length must match`).toBe(data.length);
    }
  });

  it('valid-sized buffers always mirror 0x40C0 block to 0x2000 in output', { timeout: 30000 }, () => {
    for (const { label, data, expectNull } of corpus) {
      if (expectNull) continue;
      const result = syncImmoBackupF(data);
      for (let i = 0; i < IMMO_BLOCK; i++) {
        expect(result[0x2000 + i], `${label} byte[${i}]: mirror mismatch`).toBe(result[0x40C0 + i]);
      }
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 11 — programVin rejection fuzz (seed=0x1337cafe, 400 samples)
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

describe('programVin — rejection-path fuzz (seed=0x1337cafe, 400 samples)', () => {
  const rng = makeRng(0x1337cafe);

  function randomRow(rng) {
    const kind = rng.nextInt(0, 5);
    if (kind === 0) return null;
    if (kind === 1) return undefined;
    if (kind === 2) return {};
    if (kind === 3) return { tx: rng.nextInt(0, 0x7FF), rx: rng.nextInt(0, 0x7FF), code: 'BCM', kind: 'vin', accessLevel: 0x01, crc: 'module-computed' };
    if (kind === 4) return { tx: rng.nextInt(0, 0x7FF), rx: rng.nextInt(0, 0x7FF), code: 'SGW', kind: 'unsupported', accessLevel: 0x01 };
    return { tx: rng.nextInt(0, 0x7FF), rx: rng.nextInt(0, 0x7FF), code: 'BCM', kind: 'no-vin' };
  }

  function randomVinFuzz(rng) {
    const kind = rng.nextInt(0, 6);
    if (kind === 0) return null;
    if (kind === 1) return undefined;
    if (kind === 2) return '';
    if (kind === 3) return rng.pick(VALID_VINS);
    if (kind === 4) return 'TOOSHORT';
    if (kind === 5) return '1C4HJXEN5MW123456789'; // too long
    const len = rng.nextInt(0, 25);
    return Array.from({ length: len }, () => String.fromCharCode(rng.nextInt(32, 126))).join('');
  }

  // Use a UDS that always returns a failing preflight so we never need bus scripts.
  const noOpUds = async () => ({ ok: false, raw: 'NO DATA', d: null });
  const noOpEng = { uds: noOpUds };

  const samples = Array.from({ length: 400 }, (_, i) => ({
    label: `sample[${i}]`,
    eng:   rng.next() > 0.2 ? noOpEng : (rng.next() > 0.5 ? null : undefined),
    row:   randomRow(rng),
    vin:   randomVinFuzz(rng),
  }));

  it('always resolves (never rejects) for any argument combination', { timeout: 30000 }, async () => {
    for (const { label, eng, row, vin } of samples) {
      await expect(programVin({ eng, row, vin }), `must resolve: ${label}`).resolves.toBeDefined();
    }
  });

  it('result always has the required shape fields', { timeout: 30000 }, async () => {
    for (const { label, eng, row, vin } of samples) {
      const result = await programVin({ eng, row, vin });
      assertProgramVinResult(result, label);
    }
  });
});

// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
// SECTION 12 — programVin mocked-success write/verify loop fuzz
//
// Each sample drives a fully-scripted UDS mock through preflight → session →
// unlock → write-per-DID → readback, exercising the actual 0x2E write path
// and the readback-verify loop. Outcomes are varied: some samples succeed on
// every DID, others have individual DID write failures or readback mismatches
// so every branch of the result aggregation is covered.
// ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──

// Build a DID read response: 0x62 + encodeDid(did) + vin bytes (or tail 8).
function buildReadResp(did, vinStr) {
  const dh = encodeDid(did);
  const isShort = dh.length === 3; // 24-bit DID → tail-8 only
  const payload = isShort ? vinStr.slice(-8) : vinStr;
  const a = new Uint8Array(1 + dh.length + payload.length);
  a[0] = 0x62;
  dh.forEach((b, i) => { a[1 + i] = b; });
  for (let i = 0; i < payload.length; i++) a[1 + dh.length + i] = payload.charCodeAt(i);
  return { ok: true, d: a, raw: '' };
}

// Build a scripted UDS mock. Each call pops the next entry from the queue; if
// the queue is exhausted the mock returns a generic positive response so the
// engine can finish without throwing.
function scriptedMock(script) {
  const queue = script.slice();
  return async (_tx, _rx, _data) => {
    if (queue.length === 0) return { ok: true, d: new Uint8Array([0x50, 0x03]), raw: '' };
    return queue.shift();
  };
}

// Build a complete script for a successful BCM write run.
// `writeFails[i]` — if true, the write ACK for DID i is an NRC 0x22
// `readWrong[i]`  — if true, the readback for DID i returns the wrong VIN
function buildBcmScript(vin, writeFails, readWrong) {
  const dids = vinWriteDids('BCM');
  const seedBytes = [0x11, 0x22, 0x33, 0x44];
  const seedU32   = 0x11223344;
  const kRaw = unlockKey('cda6', seedU32);
  const keyBytes = [(kRaw >>> 24) & 0xFF, (kRaw >>> 16) & 0xFF, (kRaw >>> 8) & 0xFF, kRaw & 0xFF];
  const oldVin = '1C4HJXEN5MW000000';

  const script = [
    // preflight read → returns old VIN
    buildReadResp(dids[0], oldVin),
    // extended session
    { ok: true, d: new Uint8Array([0x50, 0x03]), raw: '' },
    // seed
    { ok: true, d: new Uint8Array([0x67, 0x01, ...seedBytes]), raw: '' },
    // key ack
    { ok: true, d: new Uint8Array([0x67, 0x02, ...keyBytes]), raw: '' },
  ];

  const vb = Array.from(vin).map(c => c.charCodeAt(0));
  for (let idx = 0; idx < dids.length; idx++) {
    const did = dids[idx];
    if (writeFails[idx]) {
      script.push({ ok: true, d: new Uint8Array([0x7F, 0x2E, 0x22]), raw: '' });
    } else {
      script.push({ ok: true, d: new Uint8Array([0x6E, ...encodeDid(did)]), raw: '' });
    }
    const readbackVin = readWrong[idx] ? '1C4HJXEN5MW999999' : vin;
    script.push(buildReadResp(did, readbackVin));
  }
  // final F190 summary read
  const anyWrong = readWrong.some(Boolean);
  script.push(buildReadResp(dids[0], anyWrong ? '1C4HJXEN5MW999999' : vin));

  return script;
}

describe('programVin — mocked-success write/verify loop fuzz (seed=0xabcd1234, 80 samples)', () => {
  const rng = makeRng(0xabcd1234);

  const BCM_DID_COUNT = vinWriteDids('BCM').length;
  const bcmRow = {
    tx: 0x750, rx: 0x758, code: 'BCM', kind: 'vin',
    unlockId: 'cda6', accessLevel: 0x01, crc: 'module-computed',
  };

  const samples = Array.from({ length: 80 }, (_, i) => {
    const vin        = rng.pick(VALID_VINS);
    const writeFails = Array.from({ length: BCM_DID_COUNT }, () => rng.next() > 0.8);
    const readWrong  = Array.from({ length: BCM_DID_COUNT }, () => rng.next() > 0.85);
    const script     = buildBcmScript(vin, writeFails, readWrong);
    return { label: `bcm-write[${i}] vin=${vin}`, vin, writeFails, readWrong, script };
  });

  it('always resolves and returns a valid shape', { timeout: 30000 }, async () => {
    for (const { label, vin, script } of samples) {
      const eng = { uds: scriptedMock(script) };
      const result = await programVin({ eng, row: bcmRow, vin });
      assertProgramVinResult(result, label);
    }
  });

  it('result.ok is true only when every DID wrote and verified successfully', { timeout: 30000 }, async () => {
    for (const { label, vin, writeFails, readWrong, script } of samples) {
      const eng = { uds: scriptedMock(script) };
      const result = await programVin({ eng, row: bcmRow, vin });
      const allWroteOk   = !writeFails.some(Boolean);
      const allVerifiedOk = !readWrong.some(Boolean);
      if (allWroteOk && allVerifiedOk) {
        expect(result.ok,     `${label}: should be ok=true`).toBe(true);
        expect(result.reason, `${label}: reason should be null`).toBeNull();
      } else {
        expect(result.ok, `${label}: should be ok=false`).toBe(false);
      }
    }
  });

  it('didResults array has one entry per DID regardless of outcome', { timeout: 30000 }, async () => {
    for (const { label, vin, script } of samples) {
      const eng = { uds: scriptedMock(script) };
      const result = await programVin({ eng, row: bcmRow, vin });
      expect(result.didResults.length, `${label}: must have ${BCM_DID_COUNT} DID results`).toBe(BCM_DID_COUNT);
      for (const dr of result.didResults) {
        expect(typeof dr.wrote,    `${label}: wrote must be boolean`).toBe('boolean');
        expect(typeof dr.match,    `${label}: match must be boolean`).toBe('boolean');
        expect(typeof dr.readback, `${label}: readback must be string`).toBe('string');
      }
    }
  });

  it('beforeVin is always set to the old VIN from the preflight read', { timeout: 30000 }, async () => {
    for (const { label, vin, script } of samples) {
      const eng = { uds: scriptedMock(script) };
      const result = await programVin({ eng, row: bcmRow, vin });
      expect(result.beforeVin, `${label}: beforeVin must be the old VIN`).toBe('1C4HJXEN5MW000000');
    }
  });

  it('errors array is populated when writes or readbacks fail', { timeout: 30000 }, async () => {
    for (const { label, vin, writeFails, script } of samples) {
      const eng = { uds: scriptedMock(script) };
      const result = await programVin({ eng, row: bcmRow, vin });
      const anyWriteFailed = writeFails.some(Boolean);
      if (anyWriteFailed) {
        expect(result.errors.length, `${label}: errors must be non-empty on write fail`).toBeGreaterThan(0);
      }
    }
  });
});
