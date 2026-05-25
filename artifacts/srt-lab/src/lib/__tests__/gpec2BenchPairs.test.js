// ============================================================================
// GPEC2 Group-4 bench-pair verification harness
//
// Task #743: Confirm the GPEC2 unlock math (sxor with q1=0xE72E3799,
// q2=0x1B64DB03) actually matches the body of _gpec_calculator on a real
// ECU. The VILLAIN extraction confirms the constants and the dispatch
// (Group-4 SA levels 0x22, 0x42, 0x44, 0x60, 0x61, 0x62, 0x66, 0x67,
// 0x6B–0x6D all route to _gpec_calculator) but the function body itself
// was NOT captured in the upload. Until ≥3 (seed → key) pairs from a
// live ECU are recorded here, every Group-4 unlock SeedTab offers is
// technically a guess.
//
// Fixture: gpec2-bench-pairs.json (sibling of this file)
//   schema: [{ seed: "AABBCCDD", key: "11223344", saLevel: 66, ecu: "...",
//              date: "YYYY-MM-DD", source: "free-form notes" }, ...]
//   seed / key are 8 hex chars (4 bytes, big-endian). saLevel is the
//   sub-function of the 0x27 request that produced the seed (decimal so
//   JSON stays readable). Only Group-4 levels listed above are valid.
//
// While the fixture is empty (current state) the suite reports a single
// skipped placeholder so CI stays green. Once any bench pair lands the
// suite fans out and asserts that sxor(seed, q1) OR sxor(seed, q2)
// reproduces the captured key. If neither matches, the suite fails loud
// and the next step is to replace sxor() with the corrected algorithm
// and update the gpec2_q1 / gpec2_q2 ALGOS entries.
//
// See:
//   docs/villain-binary-intel.md §7.3 — why this is still unverified
//   src/lib/__tests__/villainAudit.test.js — pinned-constant audit
//   src/lib/_unverified/__tests__/villain27_61.candidate.test.js — same
//     skipped-when-empty pattern this file mirrors
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

import { sxor, u32 } from '../algos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GPEC2_Q1 = 0xE72E3799;
const GPEC2_Q2 = 0x1B64DB03;

const GROUP4_LEVELS = new Set([
  0x22, 0x42, 0x44, 0x60, 0x61, 0x62, 0x66, 0x67, 0x6B, 0x6C, 0x6D,
]);

function hexToU32(s) {
  if (typeof s !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(s)) {
    throw new TypeError(`expected 8 hex chars, got ${JSON.stringify(s)}`);
  }
  return u32(parseInt(s, 16));
}

function loadBenchPairs() {
  try {
    const raw = readFileSync(join(__dirname, 'gpec2-bench-pairs.json'), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new TypeError('fixture root must be an array');
    return arr;
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

describe('GPEC2 Group-4 bench-pair verification (Task #743)', () => {
  const pairs = loadBenchPairs();

  if (pairs.length === 0) {
    it.skip(
      'no Group-4 bench pairs captured yet — add entries to gpec2-bench-pairs.json after real ECU captures',
      () => {}
    );
    return;
  }

  it('fixture has at least 3 pairs (Task #743 "done" bar)', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(3);
  });

  for (const entry of pairs) {
    const label = `seed=${entry.seed} → key=${entry.key} (SA 0x${Number(entry.saLevel ?? 0).toString(16)}, ${entry.ecu ?? 'unknown ECU'}, ${entry.date ?? 'no date'})`;

    it(`schema: ${label}`, () => {
      expect(typeof entry.seed).toBe('string');
      expect(typeof entry.key).toBe('string');
      expect(Number.isInteger(entry.saLevel)).toBe(true);
      expect(
        GROUP4_LEVELS.has(entry.saLevel),
        `SA 0x${entry.saLevel.toString(16)} is not a Group-4 level`,
      ).toBe(true);
    });

    it(`sxor(seed, q1=0xE72E3799) OR sxor(seed, q2=0x1B64DB03) === captured key: ${label}`, () => {
      const seed = hexToU32(entry.seed);
      const expected = hexToU32(entry.key);
      const k1 = u32(sxor(seed, GPEC2_Q1));
      const k2 = u32(sxor(seed, GPEC2_Q2));
      // We accept either constant because the bench operator records the
      // raw 0x27 sub-function used, not which of the two _gpec_calculator
      // branches the ECU took internally. If neither matches, sxor() is
      // the wrong shape and must be replaced — see task §"Done looks like".
      expect(
        k1 === expected || k2 === expected,
        `neither q1 (0x${k1.toString(16).padStart(8, '0')}) nor q2 (0x${k2.toString(16).padStart(8, '0')}) matches captured key 0x${expected.toString(16).padStart(8, '0')} — sxor() is the wrong shape for _gpec_calculator`,
      ).toBe(true);
    });
  }
});
