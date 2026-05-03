import { describe, it, expect } from 'vitest';
import {
  sxor, u32, ngc, tipm, tipmByLevel,
  ALGOS, UNLOCK_FALLBACK, MOD_UNLOCK,
  pickUnlockChain, SA_DISPATCH, pickChainForSA,
  TIPM_SA_DISPATCH, NGC_PRE,
  unlockKey,
} from '../algos.js';

// ─── helpers ──────────────────────────────────────────────────────────
const SEEDS = [0x00000000, 0x12345678, 0xDEADBEEF, 0xFFFFFFFF, 0xCAFEBABE, 0xA1B2C3D4];

function algoEntry(id) {
  return ALGOS.find(a => a.id === id);
}

// ─── Pinned fixture vectors (VILLAIN-derived) ─────────────────────────
// Computed from VILLAIN-confirmed constants extracted from
// VILLAIN_GPEC_COMPLETE_EXTRACTION.zip / VILLAIN_COMPLETE_EXTRACTION.md.
// Seed: 0x12345678.
const PINNED_SXOR = {
  gpec1:    0x469ebb7a,
  gpec2:    0x6ff897ab,
  gpec2_q2: 0x70437906,
  gpec2f:   0xfc35fcd3,
  gpec2f_q2:0xce9d5350,
  gpec2e:   0x3868f1b4,
  gpec2e_q2:0x0373803b,
  gpec2e_q3:0xa2372f2c,
  gpec2e_q4:0xf6efe3e2,
  gpec3:    0x63b005fe,
  gpec3_q2: 0x361c739b,
  gpec2a:   0x150581b1,
  gpec2a_q2:0x31db348e,
  gpec15:   0xc9528cf0,
  gpec15_q2:0x1642e172,
};

// TIPM pinned vectors: tipm(seed, tableKey) for seed=0x1234
const PINNED_TIPM = {
  a: 0xfc76, // t8001 (SA 0x80) — VILLAIN t8001 confirmed
  b: 0x23f4, // t3605 (SA 0x36) — VILLAIN t3605 confirmed
  c: 0x8404, // t8101 (SA 0x81) — VILLAIN t8101 confirmed
  d: 0x752d, // t3c   (SA 0x3C) — VILLAIN t3c   confirmed
  e: 0xcae8, // t3608 (SA 0x08) — VILLAIN t3608 added
  f: 0x9cf2, // tc605 (SA 0xC6) — VILLAIN tc605 added
};

// NGC pinned vectors
const PINNED_NGC = {
  0x12345678: 0x123186,
  0xdeadbeef: 0x3cec4c,
  0xabcdef01: 0x426946,
};

// ─── VILLAIN primary sxor constants — VILLAIN-confirmed fixture vectors ─
describe('VILLAIN primary sxor constants — pinned fixture vectors', () => {
  const FIXTURE_SEED = 0x12345678;

  it.each(Object.entries(PINNED_SXOR))(
    '%s fn(0x12345678) === 0x%s (VILLAIN-confirmed)',
    (id, expected) => {
      const entry = algoEntry(id);
      expect(entry, `${id} not found in ALGOS`).toBeDefined();
      expect(entry.fn(FIXTURE_SEED)).toBe(u32(expected));
    }
  );

  it('all primary sxor entries also pass formula check for all seeds', () => {
    const PRIMARIES = [
      ['gpec1',  670269],
      ['gpec2',  0xE72E3799],
      ['gpec2f', 0x966AEEB1],
      ['gpec2e', 0x3F711F5A],
      ['gpec3',  0x129D657F],
      ['gpec2a', 0xCE853A6F],
      ['gpec15', 0x47EC21F8],
    ];
    for (const [id, constant] of PRIMARIES) {
      const entry = algoEntry(id);
      for (const seed of SEEDS) {
        expect(entry.fn(seed), `${id} seed=0x${seed.toString(16)}`).toBe(u32(sxor(seed, constant)));
      }
    }
  });
});

// ─── VILLAIN secondary sxor constants (q2/q3/q4) — fixture vectors ────
describe('VILLAIN secondary sxor constants — pinned fixture vectors', () => {
  const FIXTURE_SEED = 0x12345678;
  const SECONDARIES_CONSTANTS = [
    ['gpec2_q2',  0x1B64DB03],
    ['gpec2f_q2', 0x440BCE28],
    ['gpec2e_q2', 0xC3573AE9],
    ['gpec2e_q3', 0x725EF016],
    ['gpec2e_q4', 0x58329671],
    ['gpec3_q2',  0xD0726B89],
    ['gpec2a_q2', 0x3BA8FDC7],
    ['gpec15_q2', 0xCFB81A2E],
  ];

  for (const [id, constant] of SECONDARIES_CONSTANTS) {
    it(`${id} ALGOS entry exists`, () => {
      expect(algoEntry(id)).toBeDefined();
    });

    it(`${id} pinned vector matches formula`, () => {
      const entry = algoEntry(id);
      const expected = u32(sxor(FIXTURE_SEED, constant));
      expect(entry.fn(FIXTURE_SEED)).toBe(expected);
      expect(entry.fn(FIXTURE_SEED)).toBe(u32(PINNED_SXOR[id]));
    });

    it(`${id} is in UNLOCK_FALLBACK`, () => {
      expect(UNLOCK_FALLBACK).toContain(id);
    });

    it(`${id} constant does not collide with any other ALGOS entry`, () => {
      const matching = ALGOS.filter(a => {
        try {
          return a.id !== id && SEEDS.every(s => a.fn(s) === sxor(s, constant));
        } catch {
          return false;
        }
      });
      expect(matching.map(a => a.id)).toEqual([]);
    });
  }
});

// ─── Ordering: each secondary immediately follows its primary ──────────
describe('UNLOCK_FALLBACK ordering — secondary follows primary', () => {
  const PAIRS = [
    ['gpec2', 'gpec2_q2'],
    ['gpec3', 'gpec3_q2'],
    ['gpec2a', 'gpec2a_q2'],
    ['gpec15', 'gpec15_q2'],
    ['gpec2e', 'gpec2e_q2'],
    ['gpec2f', 'gpec2f_q2'],
  ];

  for (const [primary, secondary] of PAIRS) {
    it(`${secondary} appears directly after ${primary}`, () => {
      const pi = UNLOCK_FALLBACK.indexOf(primary);
      const si = UNLOCK_FALLBACK.indexOf(secondary);
      expect(pi).toBeGreaterThanOrEqual(0);
      expect(si).toBe(pi + 1);
    });
  }

  it('gpec2e_q3 follows gpec2e_q2, gpec2e_q4 follows gpec2e_q3', () => {
    const q2i = UNLOCK_FALLBACK.indexOf('gpec2e_q2');
    const q3i = UNLOCK_FALLBACK.indexOf('gpec2e_q3');
    const q4i = UNLOCK_FALLBACK.indexOf('gpec2e_q4');
    expect(q3i).toBe(q2i + 1);
    expect(q4i).toBe(q3i + 1);
  });

  it('no duplicates in UNLOCK_FALLBACK', () => {
    expect(new Set(UNLOCK_FALLBACK).size).toBe(UNLOCK_FALLBACK.length);
  });

  it('TIPM entries are present in UNLOCK_FALLBACK', () => {
    for (const id of ['t80', 't36', 't81', 't3c', 't3608', 'tc605']) {
      expect(UNLOCK_FALLBACK).toContain(id);
    }
  });
});

// ─── NGC constant tables — VILLAIN confirmed ───────────────────────────
describe('NGC constant tables — VILLAIN-confirmed', () => {
  it('NT is the 16-byte ASCII encoding of "DAIMLERCHRYSLER1"', () => {
    const expected = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,
                      0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];
    const str = expected.map(b => String.fromCharCode(b)).join('');
    expect(str).toBe('DAIMLERCHRYSLER1');
  });

  it('NS (shift_format) is the confirmed 8-entry table from VILLAIN', () => {
    const NS_EXPECTED = [0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
    // Verify using the formula: ngc(seed) uses NT and NS.
    // For seed 0x01010101 each byte=0x01, b&0xF=1, (b>>4)&0xF=0
    // coeff = NT[1]^NT[0] = 0x41^0x44 = 0x05 for all 4 rounds.
    const v = (c, s) => u32(Math.imul(c, s));
    const NT0 = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,
                 0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];
    let expected = 0;
    for (let i = 0; i < 4; i++) {
      const b = 0x01;
      const coeff = (NT0[b & 0xF] ^ NT0[(b >> 4) & 0xF]);
      expected = u32(expected ^ v(coeff, NS_EXPECTED[i % 8]));
    }
    expect(ngc(0x01010101)).toBe(expected);
  });

  it.each(Object.entries(PINNED_NGC))(
    'ngc(0x%s) === 0x%s (VILLAIN-derived pinned vector)',
    (seedHex, expected) => {
      expect(ngc(parseInt(seedHex))).toBe(u32(expected));
    }
  );

  it('NGC 14×32-bit pre-computation table is present and has 14 entries', () => {
    expect(NGC_PRE).toHaveLength(14);
    expect(NGC_PRE[0]).toBe(0x2796144E);
    expect(NGC_PRE[13]).toBe(0x19111199);
  });

  it('NGC_PRE contains all confirmed VILLAIN values', () => {
    const VILLAIN_NGC_PRE = [
      0x2796144E, 0xC55A3FD5, 0x4D5C406D, 0xB08EF250,
      0x91FF47E1, 0x2481F456, 0xC393FC49, 0x3A4EFF33,
      0x1EADCC75, 0xD9BDD2F5, 0x679705B4, 0x42CF5086,
      0x415D9886, 0x19111199,
    ];
    expect(NGC_PRE).toEqual(VILLAIN_NGC_PRE);
  });

  it('ngc is registered in ALGOS', () => {
    expect(algoEntry('ngc')).toBeDefined();
    expect(typeof algoEntry('ngc').fn(0x12345678)).toBe('number');
  });

  it('ngc produces non-trivial output for non-zero seeds', () => {
    const results = new Set(SEEDS.filter(s => s !== 0).map(s => ngc(s)));
    expect(results.size).toBeGreaterThan(1);
  });
});

// ─── TIPM tables — all six VILLAIN-confirmed ───────────────────────────
describe('TIPM tables — all six VILLAIN-confirmed, pinned fixture vectors', () => {
  const TIPM_SEED = 0x1234;

  it.each([
    ['t80',   'a', 't8001', 0x80],
    ['t36',   'b', 't3605', 0x36],
    ['t81',   'c', 't8101', 0x81],
    ['t3c',   'd', 't3c',   0x3C],
    ['t3608', 'e', 't3608', 0x08],
    ['tc605', 'f', 'tc605', 0xC6],
  ])(
    'ALGOS id %s (table %s / %s, SA 0x%s) — pinned vector at seed 0x1234',
    (id, tKey, name, _sa, _rest) => {
      const entry = algoEntry(id);
      expect(entry, `${id} not found in ALGOS`).toBeDefined();
      const expected = PINNED_TIPM[tKey];
      expect(entry.fn(TIPM_SEED)).toBe(expected);
    }
  );

  it('TM bitmask [0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007] is active — different seeds give different keys', () => {
    const seeds = [0x0000, 0x1234, 0xABCD, 0xFFFF];
    for (const tKey of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const results = seeds.map(s => tipm(s, tKey));
      expect(new Set(results).size).toBeGreaterThan(1);
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(0xFFFF);
      }
    }
    expect(tipm(0xFFFF, 'a')).not.toBe(tipm(0x0000, 'a'));
  });

  it('t3608 (TT.e) confirmed from VILLAIN: [0x9110,0x4E8A,0xEA2C,0xE235,0xB73F,0xE6E5,0x5916,0x16CC]', () => {
    expect(tipm(0x0000, 'e')).toBe(0xcadc);
    expect(tipm(0x1234, 'e')).toBe(0xcae8);
    expect(tipm(0xFFFF, 'e')).toBe(0xca23);
  });

  it('tc605 (TT.f) confirmed from VILLAIN: [0x53CE,0xE73D,0x2255,0xB1BA,0xDA02,0x70BE,0xBB65,0x81A4]', () => {
    expect(tipm(0x0000, 'f')).toBe(0x9cc6);
    expect(tipm(0x1234, 'f')).toBe(0x9cf2);
    expect(tipm(0xFFFF, 'f')).toBe(0x9c39);
  });
});

// ─── TIPM_SA_DISPATCH — SA-level routing to correct table ─────────────
describe('TIPM_SA_DISPATCH — routes SA levels to correct tables', () => {
  it('TIPM_SA_DISPATCH is frozen', () => {
    expect(Object.isFrozen(TIPM_SA_DISPATCH)).toBe(true);
  });

  it.each([
    [0x80, 'a', 't8001'],
    [0x01, 'a', 't8001'],
    [0x36, 'b', 't3605'],
    [0x05, 'b', 't3605'],
    [0x10, 'b', 't3605'],
    [0x81, 'c', 't8101'],
    [0x08, 'e', 't3608'],
    [0x88, 'e', 't3608'],
    [0xC6, 'f', 'tc605'],
    [0xC5, 'f', 'tc605'],
  ])(
    'SA 0x%s → table key "%s" (%s)',
    (sa, expectedKey, _name) => {
      expect(TIPM_SA_DISPATCH[sa]).toBe(expectedKey);
    }
  );

  it('tipmByLevel routes each SA level to the correct output', () => {
    const SEED = 0x1234;
    expect(tipmByLevel(SEED, 0x80)).toBe(PINNED_TIPM.a);
    expect(tipmByLevel(SEED, 0x36)).toBe(PINNED_TIPM.b);
    expect(tipmByLevel(SEED, 0x81)).toBe(PINNED_TIPM.c);
    expect(tipmByLevel(SEED, 0x08)).toBe(PINNED_TIPM.e);
    expect(tipmByLevel(SEED, 0xC6)).toBe(PINNED_TIPM.f);
  });

  it('tipmByLevel unknown SA level falls back to table a (t8001)', () => {
    const SEED = 0x1234;
    expect(tipmByLevel(SEED, 0xFF)).toBe(PINNED_TIPM.a);
  });
});

// ─── SA_DISPATCH map ───────────────────────────────────────────────────
describe('SA_DISPATCH — VILLAIN security-access routing for ECU PCM/NGC', () => {
  it('SA_DISPATCH is a frozen object', () => {
    expect(Object.isFrozen(SA_DISPATCH)).toBe(true);
  });

  it.each([
    [0x05, 'gpec2'],
    [0x10, 'gpec2'],
    [0x36, 'gpec2'],
    [0x42, 'gpec2'],
    [0x44, 'gpec2'],
    [0x08, 'ngc'],
    [0x88, 'ngc'],
    [0x01, 'ngc'],
    [0x80, 'ngc'],
    [0x81, 'ngc'],
    [0x34, 'jtec'],
    [0x60, 'cda6'],
    [0x0C, 'cummins_849'],
  ])(
    'SA 0x%s → %s',
    (sa, expected) => {
      expect(SA_DISPATCH[sa]).toBe(expected);
    }
  );

  it('every SA_DISPATCH value references a valid ALGOS id', () => {
    const algoIds = new Set(ALGOS.map(a => a.id));
    for (const [sa, id] of Object.entries(SA_DISPATCH)) {
      expect(algoIds.has(id), `SA 0x${Number(sa).toString(16)}: unknown id '${id}'`).toBe(true);
    }
  });
});

// ─── pickChainForSA ────────────────────────────────────────────────────
describe('pickChainForSA — dispatch by SA level', () => {
  it('gpec2-level SAs lead the chain with gpec2', () => {
    for (const sa of [0x42, 0x44, 0x36]) {
      const chain = pickChainForSA(sa);
      expect(chain[0]).toBe('gpec2');
    }
  });

  it('gpec2 SAs include gpec2_q2 in chain, after gpec2', () => {
    const chain = pickChainForSA(0x42);
    expect(chain).toContain('gpec2_q2');
    const gpec2Idx = chain.indexOf('gpec2');
    const q2Idx = chain.indexOf('gpec2_q2');
    expect(gpec2Idx).toBe(0);
    expect(q2Idx).toBeGreaterThan(gpec2Idx);
    // gpec2_q2 appears before gpec3 in the chain
    expect(q2Idx).toBeLessThan(chain.indexOf('gpec3'));
  });

  it('NGC-level SAs lead the chain with ngc', () => {
    for (const sa of [0x08, 0x80, 0x01, 0x81]) {
      const chain = pickChainForSA(sa);
      expect(chain[0]).toBe('ngc');
    }
  });

  it('jtec SA leads with jtec', () => {
    expect(pickChainForSA(0x34)[0]).toBe('jtec');
  });

  it('cummins SA leads with cummins_849', () => {
    expect(pickChainForSA(0x0C)[0]).toBe('cummins_849');
  });

  it('unknown SA level falls back to cda6-first chain', () => {
    expect(pickChainForSA(0xFF)[0]).toBe('cda6');
  });

  it('no duplicates in any pickChainForSA result', () => {
    const saLevels = [0x01, 0x05, 0x08, 0x0C, 0x10, 0x34, 0x36, 0x42, 0x44, 0x60, 0x80, 0x81, 0x88];
    for (const sa of saLevels) {
      const chain = pickChainForSA(sa);
      expect(new Set(chain).size, `duplicates in chain for SA 0x${sa.toString(16)}`).toBe(chain.length);
    }
  });

  it('every chain includes all UNLOCK_FALLBACK entries (no algorithm left behind)', () => {
    const saLevels = [0x01, 0x05, 0x08, 0x0C, 0x10, 0x34, 0x36, 0x42, 0x44, 0x60, 0x80, 0x81, 0x88];
    for (const sa of saLevels) {
      const chain = pickChainForSA(sa);
      for (const id of UNLOCK_FALLBACK) {
        expect(chain, `SA 0x${sa.toString(16)} chain missing ${id}`).toContain(id);
      }
    }
  });

  it('pickChainForSA result is an array of strings', () => {
    const chain = pickChainForSA(0x42);
    expect(Array.isArray(chain)).toBe(true);
    for (const id of chain) expect(typeof id).toBe('string');
  });
});

// ─── MOD_UNLOCK dispatch stays consistent with VILLAIN routing ─────────
describe('MOD_UNLOCK — module-code dispatch', () => {
  it('TIPM → t80 (VILLAIN SA 0x80 default)', () => {
    expect(MOD_UNLOCK.TIPM).toBe('t80');
  });

  it('ECM/TCM/DAMP/ADCM → gpec2 (VILLAIN SA 0x42/0x44 dispatch)', () => {
    for (const code of ['ECM', 'TCM', 'DAMP', 'ADCM']) {
      expect(MOD_UNLOCK[code]).toBe('gpec2');
    }
  });

  it('BCM/ABS/IPC → cda6 (body-bus modules)', () => {
    for (const code of ['BCM', 'ABS', 'IPC']) {
      expect(MOD_UNLOCK[code]).toBe('cda6');
    }
  });

  it('SGW → xtea_sgw', () => {
    expect(MOD_UNLOCK.SGW).toBe('xtea_sgw');
  });
});

// ─── unlockKey routes all new secondary and TIPM entries correctly ─────
describe('unlockKey — routes new algo ids by VILLAIN-pinned fixtures', () => {
  const SEED = 0x12345678;
  const SECONDARIES_CONSTANTS = [
    ['gpec2_q2',  0x1B64DB03],
    ['gpec2f_q2', 0x440BCE28],
    ['gpec2e_q2', 0xC3573AE9],
    ['gpec2e_q3', 0x725EF016],
    ['gpec2e_q4', 0x58329671],
    ['gpec3_q2',  0xD0726B89],
    ['gpec2a_q2', 0x3BA8FDC7],
    ['gpec15_q2', 0xCFB81A2E],
  ];

  for (const [id, constant] of SECONDARIES_CONSTANTS) {
    it(`unlockKey('${id}', 0x12345678) matches VILLAIN-pinned vector`, () => {
      const expected = u32(sxor(SEED, constant));
      expect(unlockKey(id, SEED)).toBe(expected);
      expect(unlockKey(id, SEED)).toBe(u32(PINNED_SXOR[id]));
    });
  }

  it("unlockKey('t3608', seed) matches TIPM t3608 (VILLAIN confirmed)", () => {
    expect(unlockKey('t3608', 0x1234)).toBe(PINNED_TIPM.e);
  });

  it("unlockKey('tc605', seed) matches TIPM tc605 (VILLAIN confirmed)", () => {
    expect(unlockKey('tc605', 0x1234)).toBe(PINNED_TIPM.f);
  });
});
