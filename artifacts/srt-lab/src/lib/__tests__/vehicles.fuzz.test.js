import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeDumpPartNumber, generationForPartNumber, vehiclesForPartNumber, readVinFromDump, KNOWN_BCM_PN, VEHICLES } from '../vehicles.js';

const VEHICLE_IDS = Object.keys(VEHICLES);

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────────
// Using a seeded PRNG makes every run reproducible while still covering a wide
// input space — the same 1 000 samples will be generated on every CI run.

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

// ── Structural validity assertion ─────────────────────────────────────────────

function assertStructurallyValid(result, label) {
  expect(result, `${label}: result must exist`).toBeDefined();

  expect(Array.isArray(result.partNumbers), `${label}: partNumbers must be an Array`).toBe(true);
  for (const pn of result.partNumbers) {
    expect(typeof pn, `${label}: each entry in partNumbers must be a string`).toBe('string');
  }

  if (result.primaryPn !== null) {
    expect(typeof result.primaryPn, `${label}: primaryPn must be a string or null`).toBe('string');
    expect(result.partNumbers, `${label}: primaryPn must appear in partNumbers`).toContain(result.primaryPn);
  }

  expect(Array.isArray(result.compatibleVehicles), `${label}: compatibleVehicles must be an Array`).toBe(true);
  for (const v of result.compatibleVehicles) {
    expect(typeof v, `${label}: each entry in compatibleVehicles must be a string`).toBe('string');
  }

  if (result.vinModelYearChar !== null) {
    expect(typeof result.vinModelYearChar, `${label}: vinModelYearChar must be a string or null`).toBe(
      'string',
    );
    expect(result.vinModelYearChar.length, `${label}: vinModelYearChar must be a single char`).toBe(1);
  }

  if (result.primaryPn !== null && KNOWN_BCM_PN.includes(result.primaryPn)) {
    expect(result.compatibleVehicles.length, `${label}: known P/N must have ≥1 compatible vehicle`).toBeGreaterThan(0);
  }
}

// ── Fixed edge-case buffers ───────────────────────────────────────────────────

const FIXED_CASES = [
  { label: 'empty buffer', buf: new Uint8Array(0) },
  { label: 'single 0x00 byte', buf: new Uint8Array([0x00]) },
  { label: 'single 0xFF byte', buf: new Uint8Array([0xff]) },
  { label: 'single 0x36 (digit "6") byte', buf: new Uint8Array([0x36]) },
  { label: '2 bytes 0x00', buf: new Uint8Array(2).fill(0x00) },
  { label: '7 bytes 0xFF (not enough for a P/N)', buf: new Uint8Array(7).fill(0xff) },
  { label: '512 zeros', buf: new Uint8Array(512).fill(0x00) },
  { label: '512 0xFF fill', buf: new Uint8Array(512).fill(0xff) },
  { label: '512 latin1 high-byte fill (0x80)', buf: new Uint8Array(512).fill(0x80) },
  { label: '512 latin1 high-byte fill (0xfe)', buf: new Uint8Array(512).fill(0xfe) },
  {
    label: 'P/N split by 0x00 at byte 4',
    buf: (() => {
      const b = new TextEncoder().encode('68277389');
      b[4] = 0x00;
      return b;
    })(),
  },
  {
    label: 'P/N split by 0xFF at byte 4',
    buf: (() => {
      const b = new TextEncoder().encode('68277389');
      b[4] = 0xff;
      return b;
    })(),
  },
  {
    label: 'P/N straddling a 0xFF padding boundary (at end of 256-byte block)',
    buf: (() => {
      const buf = new Uint8Array(512).fill(0xff);
      const pn = new TextEncoder().encode('68396561');
      buf.set(pn, 252);
      return buf;
    })(),
  },
  {
    label: 'valid P/N surrounded by latin1 high bytes',
    buf: (() => {
      const buf = new Uint8Array(64).fill(0xa5);
      new TextEncoder().encode('68525720').forEach((b, i) => { buf[28 + i] = b; });
      return buf;
    })(),
  },
  {
    label: 'partial 8-digit run at buffer boundary (7 digits then end)',
    buf: new TextEncoder().encode('6827738'),
  },
  {
    label: 'two P/Ns back-to-back with no separator',
    buf: new TextEncoder().encode('6827738968396561'),
  },
  {
    label: 'P/N repeated 128 times',
    buf: (() => {
      const chunk = new TextEncoder().encode('68277389');
      const buf = new Uint8Array(chunk.length * 128);
      for (let i = 0; i < 128; i++) buf.set(chunk, i * chunk.length);
      return buf;
    })(),
  },
  {
    label: 'multi-byte latin1 run followed by P/N',
    buf: (() => {
      const prefix = new Uint8Array(32).fill(0xc0);
      const pn = new TextEncoder().encode('68463847');
      const buf = new Uint8Array(prefix.length + pn.length);
      buf.set(prefix, 0);
      buf.set(pn, prefix.length);
      return buf;
    })(),
  },
  {
    label: 'P/N at very end of buffer (last 8 bytes)',
    buf: (() => {
      const buf = new Uint8Array(1024).fill(0x20);
      new TextEncoder().encode('68354769').forEach((b, i) => { buf[1016 + i] = b; });
      return buf;
    })(),
  },
  {
    label: 'alternating 0x00 and 0xFF (no valid text)',
    buf: Uint8Array.from({ length: 256 }, (_, i) => (i % 2 === 0 ? 0x00 : 0xff)),
  },
  {
    label: 'all printable ASCII except digits',
    buf: Uint8Array.from({ length: 256 }, (_, i) => 32 + (i % 63)),
  },
  {
    label: '1-byte buffer: digit "6"',
    buf: new Uint8Array([0x36]),
  },
  {
    label: 'just the prefix "68" — too short for a match',
    buf: new TextEncoder().encode('68'),
  },
];

// ── Property-based corpus generators ─────────────────────────────────────────

function generateCorpus(rng, count) {
  const corpus = [];

  for (let i = 0; i < count; i++) {
    const strategy = rng.nextInt(0, 9);

    if (strategy === 0) {
      // Fully random byte string of random length [0, 256]
      const len = rng.nextInt(0, 256);
      corpus.push({ label: `random[${i}] len=${len}`, buf: rng.nextBytes(len) });

    } else if (strategy === 1) {
      // Known P/N embedded at a random offset inside noise
      const pn = KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)];
      const size = rng.nextInt(8, 512);
      const offset = rng.nextInt(0, size - 8);
      const buf = rng.nextBytes(size);
      new TextEncoder().encode(pn).forEach((b, idx) => { buf[offset + idx] = b; });
      corpus.push({ label: `known-pn[${i}] pn=${pn} off=${offset}`, buf });

    } else if (strategy === 2) {
      // Buffer filled with a single repeated byte
      const fill = rng.nextByte();
      const len = rng.nextInt(0, 512);
      corpus.push({ label: `fill[${i}] byte=0x${fill.toString(16)} len=${len}`, buf: new Uint8Array(len).fill(fill) });

    } else if (strategy === 3) {
      // Latin1 high-byte run (0x80–0xFF) with optional P/N injected
      const len = rng.nextInt(16, 512);
      const buf = Uint8Array.from({ length: len }, () => 0x80 + rng.nextInt(0, 127));
      if (rng.next() > 0.5 && len >= 8) {
        const pn = KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)];
        const off = rng.nextInt(0, len - 8);
        new TextEncoder().encode(pn).forEach((b, idx) => { buf[off + idx] = b; });
      }
      corpus.push({ label: `latin1[${i}] len=${len}`, buf });

    } else if (strategy === 4) {
      // P/N split by a null byte at a random internal position
      const pn = KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)];
      const buf = new TextEncoder().encode(pn);
      const splitAt = rng.nextInt(1, 7);
      buf[splitAt] = 0x00;
      corpus.push({ label: `split-null[${i}] pn=${pn} at=${splitAt}`, buf });

    } else if (strategy === 5) {
      // P/N straddling a block boundary (multiple of 256)
      const blockSize = 256;
      const buf = new Uint8Array(blockSize * 2).fill(0xff);
      const off = blockSize - rng.nextInt(1, 7);
      new TextEncoder().encode('68277389').forEach((b, idx) => { buf[off + idx] = b; });
      corpus.push({ label: `boundary[${i}] off=${off}`, buf });

    } else if (strategy === 6) {
      // Very small buffers [0, 7 bytes] — all too short for a full P/N
      const len = rng.nextInt(0, 7);
      corpus.push({ label: `tiny[${i}] len=${len}`, buf: rng.nextBytes(len) });

    } else if (strategy === 7) {
      // Mix of printable ASCII and high bytes with random P/N prefix fragments
      const len = rng.nextInt(8, 256);
      const buf = Uint8Array.from({ length: len }, () => {
        const r = rng.next();
        if (r < 0.3) return rng.nextInt(0x30, 0x39); // digit
        if (r < 0.5) return rng.nextInt(0x41, 0x5a); // uppercase
        if (r < 0.7) return rng.nextInt(0x80, 0xff); // high byte
        return 0x20; // space
      });
      corpus.push({ label: `mixed[${i}] len=${len}`, buf });

    } else if (strategy === 8) {
      // Unknown 8-digit 68-prefixed number (not in KNOWN_BCM_PN)
      const unknown = `68${String(rng.nextInt(0, 99999)).padStart(6, '0')}`;
      const size = rng.nextInt(8, 64);
      const buf = new Uint8Array(size).fill(0x20);
      new TextEncoder().encode(unknown).forEach((b, idx) => { buf[idx] = b; });
      corpus.push({ label: `unknown-pn[${i}] pn=${unknown}`, buf });

    } else {
      // Large buffer (up to 128 KB) mostly 0xFF with random inserts
      const len = rng.nextInt(1024, 131072);
      const buf = new Uint8Array(len).fill(0xff);
      const inserts = rng.nextInt(0, 4);
      for (let j = 0; j < inserts; j++) {
        const pn = KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)];
        const off = rng.nextInt(0, len - 8);
        new TextEncoder().encode(pn).forEach((b, idx) => { buf[off + idx] = b; });
      }
      corpus.push({ label: `large[${i}] len=${len}`, buf });
    }
  }

  return corpus;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('analyzeDumpPartNumber — fixed edge cases', () => {
  for (const { label, buf } of FIXED_CASES) {
    it(`never throws and returns a valid object: ${label}`, () => {
      let result;
      expect(() => { result = analyzeDumpPartNumber(buf); }, `${label}: must not throw`).not.toThrow();
      assertStructurallyValid(result, label);
    });
  }
});

describe('analyzeDumpPartNumber — property-based fuzz (seed=0xdeadbeef, 1000 samples)', () => {
  const rng = makeRng(0xdeadbeef);
  const corpus = generateCorpus(rng, 1000);

  it('never throws for any generated input', () => {
    for (const { label, buf } of corpus) {
      expect(() => analyzeDumpPartNumber(buf), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns a structurally-valid object for any generated input', () => {
    for (const { label, buf } of corpus) {
      const result = analyzeDumpPartNumber(buf);
      assertStructurallyValid(result, label);
    }
  });
});

describe('analyzeDumpPartNumber — property-based fuzz (seed=0xcafebabe, 500 samples)', () => {
  const rng = makeRng(0xcafebabe);
  const corpus = generateCorpus(rng, 500);

  it('never throws for any generated input', () => {
    for (const { label, buf } of corpus) {
      expect(() => analyzeDumpPartNumber(buf), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns a structurally-valid object for any generated input', () => {
    for (const { label, buf } of corpus) {
      const result = analyzeDumpPartNumber(buf);
      assertStructurallyValid(result, label);
    }
  });
});

// ── analyzeDumpPartNumber — bad-input guard ───────────────────────────────────
// These cases pass non-BufferSource values to confirm that:
//   1. console.warn is called (the guard fires)
//   2. the function does NOT throw
//   3. the returned object is structurally valid (safe empty result)

const BAD_INPUT_CASES = [
  { label: 'null',          value: null },
  { label: 'undefined',     value: undefined },
  { label: 'plain string',  value: 'hello world' },
  { label: 'empty string',  value: '' },
  { label: 'number',        value: 42 },
  { label: 'zero',          value: 0 },
  { label: 'plain object',  value: { data: [1, 2, 3] } },
  { label: 'boolean true',  value: true },
  { label: 'boolean false', value: false },
  { label: 'array',         value: [0x68, 0x38] },
];

describe('analyzeDumpPartNumber — bad-input guard (non-BufferSource)', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  for (const { label, value } of BAD_INPUT_CASES) {
    it(`warns and returns a valid object for: ${label}`, () => {
      let result;
      expect(
        () => { result = analyzeDumpPartNumber(value); },
        `${label}: must not throw`,
      ).not.toThrow();

      expect(warnSpy, `${label}: console.warn must have been called`).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0], `${label}: warn message must mention analyzeDumpPartNumber`).toContain('analyzeDumpPartNumber');

      assertStructurallyValid(result, label);
      expect(result.partNumbers, `${label}: partNumbers must be empty`).toEqual([]);
      expect(result.primaryPn, `${label}: primaryPn must be null`).toBeNull();
      expect(result.compatibleVehicles, `${label}: compatibleVehicles must be empty`).toEqual([]);
      expect(result.vinModelYearChar, `${label}: vinModelYearChar must be null`).toBeNull();
    });
  }
});

// ── generationForPartNumber fuzz ──────────────────────────────────────────────

// Valid generation shape fields (all optional to handle undefined return, but
// when an object is returned every listed field must have the correct type).
function assertValidGenerationOrAbsent(result, label) {
  if (result === null || result === undefined) return;
  expect(typeof result, `${label}: result must be an object`).toBe('object');
  expect(typeof result.id,     `${label}: id must be string`).toBe('string');
  expect(typeof result.label,  `${label}: label must be string`).toBe('string');
  expect(typeof result.years,  `${label}: years must be string`).toBe('string');
  expect(typeof result.bcmPn,  `${label}: bcmPn must be string`).toBe('string');
  expect(typeof result.family, `${label}: family must be string`).toBe('string');
  expect(typeof result.sec16,  `${label}: sec16 must be string`).toBe('string');
  expect(typeof result.vinOff, `${label}: vinOff must be number`).toBe('number');
}

// Helpers for generating adversarial scalar inputs
function randomScalar(rng) {
  const kind = rng.nextInt(0, 8);
  if (kind === 0) return null;
  if (kind === 1) return undefined;
  if (kind === 2) return '';
  if (kind === 3) return rng.nextInt(0, 999999);
  if (kind === 4) return true;
  if (kind === 5) return [];
  if (kind === 6) return {};
  if (kind === 7) return NaN;
  // random printable string of length 0–20
  const len = rng.nextInt(0, 20);
  return Array.from({ length: len }, () => String.fromCharCode(rng.nextInt(32, 126))).join('');
}

function randomVinYearChar(rng) {
  const kind = rng.nextInt(0, 5);
  if (kind === 0) return null;
  if (kind === 1) return undefined;
  if (kind === 2) return '';
  if (kind === 3) return String.fromCharCode(rng.nextInt(65, 90));  // A-Z
  if (kind === 4) return String.fromCharCode(rng.nextInt(48, 57));  // 0-9
  // multi-char string
  const len = rng.nextInt(2, 8);
  return Array.from({ length: len }, () => String.fromCharCode(rng.nextInt(32, 126))).join('');
}

const GENERATION_FIXED_CASES = [
  // known vehicle + known P/N combinations
  ...VEHICLE_IDS.flatMap(vid =>
    KNOWN_BCM_PN.map(pn => ({ vehicleId: vid, pn, vinYearChar: null, label: `vid=${vid} pn=${pn} ync=null` }))
  ),
  // known vehicle + known P/N + various year chars
  ...VEHICLE_IDS.flatMap(vid =>
    ['J','K','L','M','N','P','R','S','T','B','C','0','9'].map(yc => ({
      vehicleId: vid, pn: '68525720', vinYearChar: yc,
      label: `vid=${vid} pn=68525720 ync=${yc}`,
    }))
  ),
  // invalid vehicleId values
  { vehicleId: '',          pn: '68277389', vinYearChar: null,  label: 'empty vehicleId' },
  { vehicleId: null,        pn: '68277389', vinYearChar: 'K',   label: 'null vehicleId' },
  { vehicleId: undefined,   pn: '68277389', vinYearChar: 'K',   label: 'undefined vehicleId' },
  { vehicleId: 0,           pn: '68277389', vinYearChar: null,  label: 'numeric vehicleId' },
  { vehicleId: {},          pn: '68277389', vinYearChar: null,  label: 'object vehicleId' },
  // empty / null P/N
  { vehicleId: 'charger',   pn: '',         vinYearChar: null,  label: 'empty pn' },
  { vehicleId: 'charger',   pn: null,       vinYearChar: null,  label: 'null pn' },
  { vehicleId: 'charger',   pn: undefined,  vinYearChar: null,  label: 'undefined pn' },
  // numeric-looking P/N string (not in KNOWN_BCM_PN)
  { vehicleId: 'charger',   pn: '00000000', vinYearChar: null,  label: 'zero pn' },
  { vehicleId: 'challenger', pn: '99999999', vinYearChar: 'M',  label: 'all-9 pn' },
  // non-string year chars
  { vehicleId: 'charger',   pn: '68525720', vinYearChar: 0,     label: 'numeric year char 0' },
  { vehicleId: 'charger',   pn: '68525720', vinYearChar: 75,    label: 'numeric year char 75 ("K")' },
  { vehicleId: 'charger',   pn: '68525720', vinYearChar: false, label: 'false year char' },
  { vehicleId: 'charger',   pn: '68525720', vinYearChar: [],    label: 'array year char' },
  { vehicleId: 'charger',   pn: '68525720', vinYearChar: 'KK',  label: 'two-char year char' },
];

describe('generationForPartNumber — fixed edge cases', () => {
  for (const { vehicleId, pn, vinYearChar, label } of GENERATION_FIXED_CASES) {
    it(`never throws and returns null/undefined or a valid generation: ${label}`, () => {
      let result;
      expect(
        () => { result = generationForPartNumber(vehicleId, pn, vinYearChar); },
        `${label}: must not throw`,
      ).not.toThrow();
      assertValidGenerationOrAbsent(result, label);
    });
  }
});

describe('generationForPartNumber — property-based fuzz (seed=0xf00dcafe, 1000 samples)', () => {
  const rng = makeRng(0xf00dcafe);
  const samples = Array.from({ length: 1000 }, (_, i) => {
    // Alternate between fully-random args and semi-realistic args
    const realistic = rng.next() > 0.4;
    const vehicleId = realistic
      ? VEHICLE_IDS[rng.nextInt(0, VEHICLE_IDS.length - 1)]
      : randomScalar(rng);
    const pn = realistic
      ? (rng.next() > 0.5 ? KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)] : randomScalar(rng))
      : randomScalar(rng);
    const vinYearChar = randomVinYearChar(rng);
    return { vehicleId, pn, vinYearChar, label: `sample[${i}]` };
  });

  it('never throws for any argument combination', () => {
    for (const { vehicleId, pn, vinYearChar, label } of samples) {
      expect(
        () => generationForPartNumber(vehicleId, pn, vinYearChar),
        `must not throw: ${label}`,
      ).not.toThrow();
    }
  });

  it('always returns null, undefined, or a valid generation shape', () => {
    for (const { vehicleId, pn, vinYearChar, label } of samples) {
      const result = generationForPartNumber(vehicleId, pn, vinYearChar);
      assertValidGenerationOrAbsent(result, label);
    }
  });
});

// ── vehiclesForPartNumber fuzz ────────────────────────────────────────────────

function assertVehiclesArray(result, label) {
  expect(Array.isArray(result), `${label}: must return an Array`).toBe(true);
  for (const v of result) {
    expect(typeof v,          `${label}: each entry must be an object`).toBe('object');
    expect(typeof v.id,       `${label}: vehicle id must be string`).toBe('string');
    expect(typeof v.name,     `${label}: vehicle name must be string`).toBe('string');
    expect(Array.isArray(v.bcmFamilies), `${label}: bcmFamilies must be Array`).toBe(true);
  }
}

const VEHICLES_FIXED_CASES = [
  { pn: '',         label: 'empty string' },
  { pn: null,       label: 'null' },
  { pn: undefined,  label: 'undefined' },
  { pn: 0,          label: 'number 0' },
  { pn: {},         label: 'plain object' },
  { pn: [],         label: 'empty array' },
  { pn: NaN,        label: 'NaN' },
  { pn: '00000000', label: 'unknown 8-digit string' },
  { pn: '68XXXXXX', label: 'non-numeric 68-prefix' },
  ...KNOWN_BCM_PN.map(pn => ({ pn, label: `known pn ${pn}` })),
];

describe('vehiclesForPartNumber — fixed edge cases', () => {
  for (const { pn, label } of VEHICLES_FIXED_CASES) {
    it(`never throws and returns a valid array: ${label}`, () => {
      let result;
      expect(
        () => { result = vehiclesForPartNumber(pn); },
        `${label}: must not throw`,
      ).not.toThrow();
      assertVehiclesArray(result, label);
    });
  }
});

describe('vehiclesForPartNumber — property-based fuzz (seed=0xbabe1234, 1000 samples)', () => {
  const rng = makeRng(0xbabe1234);
  const inputs = Array.from({ length: 1000 }, (_, i) => {
    const kind = rng.nextInt(0, 5);
    let pn;
    if (kind === 0) pn = KNOWN_BCM_PN[rng.nextInt(0, KNOWN_BCM_PN.length - 1)];
    else if (kind === 1) pn = `68${String(rng.nextInt(0, 999999)).padStart(6, '0')}`;
    else if (kind === 2) pn = randomScalar(rng);
    else if (kind === 3) {
      const len = rng.nextInt(0, 24);
      pn = Array.from({ length: len }, () => String.fromCharCode(rng.nextInt(32, 126))).join('');
    } else {
      pn = rng.nextInt(0, 99999999);
    }
    return { pn, label: `sample[${i}] pn=${JSON.stringify(pn)}` };
  });

  it('never throws for any input', () => {
    for (const { pn, label } of inputs) {
      expect(() => vehiclesForPartNumber(pn), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns a valid array', () => {
    for (const { pn, label } of inputs) {
      const result = vehiclesForPartNumber(pn);
      assertVehiclesArray(result, label);
    }
  });
});

// ── readVinFromDump fuzz ───────────────────────────────────────────────────────
// Collect every unique vinOff value defined across all vehicle generations so
// the adversarial inputs are grounded in real offsets the production code uses.

const ALL_VIN_OFFSETS = [
  ...new Set(
    Object.values(VEHICLES).flatMap(v => v.generations.map(g => g.vinOff)),
  ),
];

function assertVinResult(result, label) {
  // Return value must be null or a 17-character printable-ASCII string
  if (result === null) return;
  expect(typeof result, `${label}: non-null result must be a string`).toBe('string');
  expect(result.length, `${label}: VIN string must be exactly 17 chars`).toBe(17);
  for (let i = 0; i < result.length; i++) {
    const code = result.charCodeAt(i);
    expect(code >= 0x20 && code <= 0x7e, `${label}: VIN char[${i}] must be printable ASCII`).toBe(true);
  }
}

// ── Fixed edge cases specific to the VIN-offset reader ────────────────────────

const VIN_OFFSET_FIXED_CASES = ALL_VIN_OFFSETS.flatMap(vinOff => [
  // Buffer is completely empty
  { label: `vinOff=0x${vinOff.toString(16)} empty buffer`, bytes: new Uint8Array(0), vinOff },
  // Buffer stops exactly one byte before the offset
  { label: `vinOff=0x${vinOff.toString(16)} buffer length = vinOff-1`, bytes: new Uint8Array(vinOff > 0 ? vinOff - 1 : 0), vinOff },
  // Buffer starts at the offset but has fewer than 17 bytes (partial VIN)
  { label: `vinOff=0x${vinOff.toString(16)} buffer length = vinOff+8 (partial VIN)`, bytes: new Uint8Array(vinOff + 8), vinOff },
  // Buffer exactly covers the offset with exactly 17 bytes (minimal valid size)
  { label: `vinOff=0x${vinOff.toString(16)} buffer length = vinOff+17 (exact fit)`, bytes: new Uint8Array(vinOff + 17), vinOff },
  // VIN region is all 0x00 (erased / unprogrammed flash)
  {
    label: `vinOff=0x${vinOff.toString(16)} VIN region all 0x00`,
    bytes: (() => { const b = new Uint8Array(vinOff + 64); return b; })(),
    vinOff,
  },
  // VIN region is all 0xFF (blank EEPROM / erased sector)
  {
    label: `vinOff=0x${vinOff.toString(16)} VIN region all 0xFF`,
    bytes: (() => { const b = new Uint8Array(vinOff + 64).fill(0xff); return b; })(),
    vinOff,
  },
  // VIN region contains a realistic ASCII VIN
  {
    label: `vinOff=0x${vinOff.toString(16)} valid ASCII VIN`,
    bytes: (() => {
      const b = new Uint8Array(vinOff + 64).fill(0xff);
      new TextEncoder().encode('2C3CDXGJ8KH123456').forEach((byte, i) => { b[vinOff + i] = byte; });
      return b;
    })(),
    vinOff,
  },
  // VIN region is mostly valid but has one null byte injected mid-VIN
  {
    label: `vinOff=0x${vinOff.toString(16)} VIN with embedded 0x00 at byte 9`,
    bytes: (() => {
      const b = new Uint8Array(vinOff + 64).fill(0xff);
      new TextEncoder().encode('2C3CDXGJ8KH123456').forEach((byte, i) => { b[vinOff + i] = byte; });
      b[vinOff + 9] = 0x00;
      return b;
    })(),
    vinOff,
  },
  // VIN region is mostly valid but has one 0xFF byte injected mid-VIN
  {
    label: `vinOff=0x${vinOff.toString(16)} VIN with embedded 0xFF at byte 4`,
    bytes: (() => {
      const b = new Uint8Array(vinOff + 64).fill(0x00);
      new TextEncoder().encode('2C3CDXGJ8KH123456').forEach((byte, i) => { b[vinOff + i] = byte; });
      b[vinOff + 4] = 0xff;
      return b;
    })(),
    vinOff,
  },
  // Buffer around offset filled with latin1 high bytes (no printable VIN)
  {
    label: `vinOff=0x${vinOff.toString(16)} VIN region latin1 high bytes (0xA5)`,
    bytes: new Uint8Array(vinOff + 64).fill(0xa5),
    vinOff,
  },
]);

// Also exercise with bad vinOff types / values (bytes argument is valid)
const VALID_DUMP = (() => {
  const b = new Uint8Array(0x6000).fill(0xff);
  new TextEncoder().encode('2C3CDXGJ8KH123456').forEach((byte, i) => { b[0x1308 + i] = byte; });
  return b;
})();

const VIN_OFFSET_BAD_OFFSET_CASES = [
  { label: 'vinOff = -1',          bytes: VALID_DUMP, vinOff: -1 },
  { label: 'vinOff = 0',           bytes: VALID_DUMP, vinOff: 0 },
  { label: 'vinOff = NaN',         bytes: VALID_DUMP, vinOff: NaN },
  { label: 'vinOff = Infinity',     bytes: VALID_DUMP, vinOff: Infinity },
  { label: 'vinOff = -Infinity',    bytes: VALID_DUMP, vinOff: -Infinity },
  { label: 'vinOff = 1.5',         bytes: VALID_DUMP, vinOff: 1.5 },
  { label: 'vinOff = null',        bytes: VALID_DUMP, vinOff: null },
  { label: 'vinOff = undefined',   bytes: VALID_DUMP, vinOff: undefined },
  { label: 'vinOff = "0x1308"',    bytes: VALID_DUMP, vinOff: '0x1308' },
  { label: 'vinOff = {}',          bytes: VALID_DUMP, vinOff: {} },
  { label: 'vinOff > buffer.length', bytes: VALID_DUMP, vinOff: VALID_DUMP.length + 1 },
];

const VIN_OFFSET_BAD_BYTES_CASES = [
  { label: 'bytes = null',        bytes: null,      vinOff: 0x1308 },
  { label: 'bytes = undefined',   bytes: undefined, vinOff: 0x1308 },
  { label: 'bytes = plain Array', bytes: [0xff, 0xff], vinOff: 0 },
  { label: 'bytes = string',      bytes: 'hello',   vinOff: 0 },
  { label: 'bytes = number',      bytes: 42,         vinOff: 0 },
  { label: 'bytes = {}',          bytes: {},         vinOff: 0 },
];

describe('readVinFromDump — fixed edge cases (VIN-offset inputs)', () => {
  for (const { label, bytes, vinOff } of VIN_OFFSET_FIXED_CASES) {
    it(`never throws and returns null or a valid VIN: ${label}`, () => {
      let result;
      expect(() => { result = readVinFromDump(bytes, vinOff); }, `${label}: must not throw`).not.toThrow();
      assertVinResult(result, label);
    });
  }
});

// ── console.warn guard assertions ─────────────────────────────────────────────

const VEHICLES_NON_STRING_CASES = [
  { pn: null,      label: 'null' },
  { pn: undefined, label: 'undefined' },
  { pn: 0,         label: 'number 0' },
  { pn: {},        label: 'plain object' },
  { pn: [],        label: 'empty array' },
  { pn: NaN,       label: 'NaN' },
];

describe('vehiclesForPartNumber — console.warn fires for non-string inputs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { pn, label } of VEHICLES_NON_STRING_CASES) {
    it(`warns when pn is ${label}`, () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vehiclesForPartNumber(pn);
      expect(spy).toHaveBeenCalled();
    });
  }
});

describe('readVinFromDump — bad vinOff values', () => {
  for (const { label, bytes, vinOff } of VIN_OFFSET_BAD_OFFSET_CASES) {
    it(`never throws: ${label}`, () => {
      let result;
      expect(() => { result = readVinFromDump(bytes, vinOff); }, `${label}: must not throw`).not.toThrow();
      assertVinResult(result, label);
    });
  }
});

describe('readVinFromDump — bad bytes argument types', () => {
  for (const { label, bytes, vinOff } of VIN_OFFSET_BAD_BYTES_CASES) {
    it(`never throws and returns null: ${label}`, () => {
      let result;
      expect(() => { result = readVinFromDump(bytes, vinOff); }, `${label}: must not throw`).not.toThrow();
      expect(result, `${label}: must return null for non-Uint8Array input`).toBeNull();
    });
  }
});

// ── readVinFromDump — bad-input guard (non-Uint8Array values) ────────────────
// Pinpoint regression coverage for the `bytes instanceof Uint8Array` guard on
// line 109 of vehicles.js. Each case must return `null` without throwing, and
// must short-circuit before any decoding work happens (verified by spying on
// the global TextDecoder constructor and asserting it is never invoked).
//
// NOTE: this overlaps slightly with `readVinFromDump — bad bytes argument
// types` above, which also checks non-throw + null returns for invalid `bytes`.
// The duplication is intentional: this block adds the TextDecoder spy so a
// future refactor that removes the early `instanceof` guard (but still happens
// to return `null` further down) would still trip the spy and fail the test.

const READ_VIN_NON_UINT8ARRAY_CASES = [
  { label: 'null',         value: null },
  { label: 'undefined',    value: undefined },
  { label: 'string',       value: '2C3CDXGJ8KH123456' },
  { label: 'number',       value: 0x1308 },
  { label: 'plain object', value: { 0: 0x32, 1: 0x43, length: 17 } },
];

describe('readVinFromDump — bad-input guard (non-Uint8Array values)', () => {
  let decoderSpy;

  beforeEach(() => {
    decoderSpy = vi.spyOn(globalThis, 'TextDecoder');
  });

  afterEach(() => {
    decoderSpy.mockRestore();
  });

  for (const { label, value } of READ_VIN_NON_UINT8ARRAY_CASES) {
    it(`returns null without throwing for: ${label}`, () => {
      let result;
      expect(
        () => { result = readVinFromDump(value, 0x1308); },
        `${label}: must not throw`,
      ).not.toThrow();
      expect(result, `${label}: must return null`).toBeNull();
      expect(
        decoderSpy,
        `${label}: guard must short-circuit before constructing a TextDecoder`,
      ).not.toHaveBeenCalled();
    });
  }
});

describe('readVinFromDump — property-based fuzz (seed=0x1a2b3c4d, 1000 samples)', () => {
  const rng = makeRng(0x1a2b3c4d);

  const samples = Array.from({ length: 1000 }, (_, i) => {
    const vinOff = ALL_VIN_OFFSETS[rng.nextInt(0, ALL_VIN_OFFSETS.length - 1)];
    const strategy = rng.nextInt(0, 7);
    let bytes;

    if (strategy === 0) {
      // Buffer too short to reach vinOff
      const len = rng.nextInt(0, vinOff > 0 ? vinOff - 1 : 0);
      bytes = rng.nextBytes(len);

    } else if (strategy === 1) {
      // Buffer reaches vinOff but has fewer than 17 VIN bytes
      const extra = rng.nextInt(0, 16);
      bytes = rng.nextBytes(vinOff + extra);

    } else if (strategy === 2) {
      // VIN region entirely 0x00
      bytes = new Uint8Array(vinOff + 64);

    } else if (strategy === 3) {
      // VIN region entirely 0xFF
      bytes = new Uint8Array(vinOff + 64).fill(0xff);

    } else if (strategy === 4) {
      // Valid-looking VIN with random mutations at random positions
      const buf = new Uint8Array(vinOff + 64).fill(0x20);
      new TextEncoder().encode('2C3CDXGJ8KH123456').forEach((b, idx) => { buf[vinOff + idx] = b; });
      const mutations = rng.nextInt(0, 17);
      for (let m = 0; m < mutations; m++) {
        buf[vinOff + rng.nextInt(0, 16)] = rng.nextByte();
      }
      bytes = buf;

    } else if (strategy === 5) {
      // Random bytes of random total length (may or may not cover vinOff)
      const len = rng.nextInt(0, vinOff + 128);
      bytes = rng.nextBytes(len);

    } else if (strategy === 6) {
      // Large buffer (up to 128 KB), VIN region randomised
      const len = rng.nextInt(vinOff + 17, vinOff + 131072);
      const buf = new Uint8Array(len).fill(0xff);
      for (let j = 0; j < 17; j++) buf[vinOff + j] = rng.nextByte();
      bytes = buf;

    } else {
      // latin1 high-byte fill around VIN region
      bytes = new Uint8Array(vinOff + 64).fill(0x80 + rng.nextInt(0, 127));
    }

    return { label: `sample[${i}] strategy=${strategy} vinOff=0x${vinOff.toString(16)}`, bytes, vinOff };
  });

  it('never throws for any generated input', () => {
    for (const { label, bytes, vinOff } of samples) {
      expect(() => readVinFromDump(bytes, vinOff), `must not throw: ${label}`).not.toThrow();
    }
  });

  it('always returns null or a valid 17-char printable-ASCII VIN', () => {
    for (const { label, bytes, vinOff } of samples) {
      const result = readVinFromDump(bytes, vinOff);
      assertVinResult(result, label);
    }
  });
});

const GENERATION_NON_STRING_CASES = [
  { vehicleId: null,      pn: '68277389', vinYearChar: null, label: 'null vehicleId' },
  { vehicleId: undefined, pn: '68277389', vinYearChar: null, label: 'undefined vehicleId' },
  { vehicleId: 0,         pn: '68277389', vinYearChar: null, label: 'numeric vehicleId' },
  { vehicleId: {},        pn: '68277389', vinYearChar: null, label: 'object vehicleId' },
  { vehicleId: 'charger', pn: null,       vinYearChar: null, label: 'null pn' },
  { vehicleId: 'charger', pn: undefined,  vinYearChar: null, label: 'undefined pn' },
  { vehicleId: 'charger', pn: 0,          vinYearChar: null, label: 'numeric pn' },
];

describe('generationForPartNumber — console.warn fires for non-string inputs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { vehicleId, pn, vinYearChar, label } of GENERATION_NON_STRING_CASES) {
    it(`warns when ${label}`, () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      generationForPartNumber(vehicleId, pn, vinYearChar);
      expect(spy).toHaveBeenCalled();
    });
  }
});

describe('generationForPartNumber — console.warn fires for bad vinYearChar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BAD_VIN_YEAR_CHAR_CASES = [
    { vinYearChar: 0, label: 'numeric 0' },
    { vinYearChar: 75, label: 'numeric 75' },
    { vinYearChar: false, label: 'boolean false' },
    { vinYearChar: [], label: 'empty array' },
    { vinYearChar: 'KK', label: "multi-char string 'KK'" },
  ];

  for (const { vinYearChar, label } of BAD_VIN_YEAR_CHAR_CASES) {
    it(`warns when vinYearChar is ${label}`, () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      generationForPartNumber('charger', '68525720', vinYearChar);
      const matched = spy.mock.calls.some(args =>
        typeof args[0] === 'string' && args[0].includes('vinYearChar')
      );
      expect(matched, `expected a console.warn mentioning vinYearChar for ${label}`).toBe(true);
    });
  }
});
