import { describe, it, expect } from 'vitest';
import { analyzeDumpPartNumber, KNOWN_BCM_PN } from '../vehicles.js';

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
