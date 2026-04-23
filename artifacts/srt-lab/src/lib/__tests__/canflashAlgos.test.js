import { describe, it, expect, test } from 'vitest';

import {
  cfRotR16,
  cfBCM, cfTIPM, cfTrwABS, cfBoschABS, cfITM,
  cfYazakiFCM, cfNGCEngine, cfNGCTrans, cfVenomPCM, cfHuntsvilleRadio,
  cfWCM, cfAlpineRAK, cfGPEC,
  cfCall16, cfCall32, cfCall32x2,
  CANFLASH_MAP, MODULE_SPECS,
} from '../canflashAlgos.js';

// ─────────────────────────────────────────────────────────────────────────────
// Golden seed→key vectors for the 13 byte-verified CANFLASH algorithms.
//
// Each algorithm in canflashAlgos.js produces byte-identical output to the
// factory Chrysler DLL it was reverse-engineered from. The header comments
// above each fn() in the source (e.g. "huntsville_bcm.dll  SELF-TEST: 10/10
// ✓") are the test contract — those DLLs each shipped a verify() self-test
// or were validated by Unicorn CPU emulation.
//
// The vectors below were generated once from the freshly-extracted module
// (golden-test pattern, mirrors crc.golden.test.js) and pinned here. Any
// later edit to the algorithm tables, rotate counts, or XOR constants will
// trip a loud, specific failure here instead of silently producing the
// wrong key on a real ECU.
// ─────────────────────────────────────────────────────────────────────────────

describe('cfRotR16', () => {
  test.each([
    [0x0001, 0,  0x0001],
    [0x0001, 1,  0x8000],
    [0x0001, 3,  0x2000],
    [0x0001, 15, 0x0002],
    [0x0001, 16, 0x0001],
    [0x8000, 0,  0x8000],
    [0x8000, 1,  0x4000],
    [0x8000, 3,  0x1000],
    [0x8000, 15, 0x0001],
    [0x8000, 16, 0x8000],
    [0x1234, 0,  0x1234],
    [0x1234, 1,  0x091A],
    [0x1234, 3,  0x8246],
    [0x1234, 15, 0x2468],
    [0x1234, 16, 0x1234],
    [0xFFFF, 0,  0xFFFF],
    [0xFFFF, 1,  0xFFFF],
    [0xFFFF, 7,  0xFFFF],
    [0xFFFF, 16, 0xFFFF],
  ])('cfRotR16(0x%s, %i) === 0x%s', (x, n, expected) => {
    expect(cfRotR16(x, n)).toBe(expected);
  });
});

// 16-bit algorithm vectors — 12 seeds spanning edges and arbitrary midpoints.
const SEEDS_16 = [0x0000, 0x0001, 0xFFFF, 0x1234, 0xABCD, 0xDEAD, 0xBEEF, 0xCAFE, 0x5A5A, 0xA5A5, 0x8000, 0x7FFF];

const VECTORS_16 = {
  cfBCM: [
    [0x0000, 0xF85F], [0x0001, 0x2811], [0xFFFF, 0x84D4], [0x1234, 0x526C],
    [0xABCD, 0x5CCF], [0xDEAD, 0x356A], [0xBEEF, 0x9910], [0xCAFE, 0xA86F],
    [0x5A5A, 0xE836], [0xA5A5, 0xB99B], [0x8000, 0xBB3A], [0x7FFF, 0xFCC2],
  ],
  cfTIPM: [
    [0x0000, 0xA4D4], [0x0001, 0xA4D5], [0xFFFF, 0x7AB6], [0x1234, 0x6597],
    [0xABCD, 0xABEA], [0xDEAD, 0xB1AB], [0xBEEF, 0xFD37], [0xCAFE, 0x6369],
    [0x5A5A, 0xF760], [0xA5A5, 0x655B], [0x8000, 0xACF9], [0x7FFF, 0x6E93],
  ],
  cfTrwABS: [
    [0x0000, 0x5619], [0x0001, 0x9035], [0xFFFF, 0xB0BB], [0x1234, 0xC2B2],
    [0xABCD, 0xA496], [0xDEAD, 0xE62A], [0xBEEF, 0xE235], [0xCAFE, 0x8FB5],
    [0x5A5A, 0x3B53], [0xA5A5, 0x7F2C], [0x8000, 0xEB06], [0x7FFF, 0xAF79],
  ],
  cfBoschABS: [
    [0x0000, 0x0000], [0x0001, 0x9E19], [0xFFFF, 0x9B3A], [0x1234, 0x449C],
    [0xABCD, 0x44DE], [0xDEAD, 0x6A7B], [0xBEEF, 0x7AE5], [0xCAFE, 0xC1D8],
    [0x5A5A, 0x4594], [0xA5A5, 0xDEAE], [0x8000, 0x4D04], [0x7FFF, 0xD63E],
  ],
  cfITM: [
    [0x0000, 0x67FD], [0x0001, 0xE5CF], [0xFFFF, 0xCF93], [0x1234, 0x9A1E],
    [0xABCD, 0xB67B], [0xDEAD, 0xEEC1], [0xBEEF, 0x8E83], [0xCAFE, 0xBE11],
    [0x5A5A, 0x8C90], [0xA5A5, 0x58CA], [0x8000, 0xD044], [0x7FFF, 0x3814],
  ],
  cfYazakiFCM: [
    [0x0000, 0x2C6E], [0x0001, 0xA987], [0xFFFF, 0xE5A6], [0x1234, 0xACC8],
    [0xABCD, 0x3C31], [0xDEAD, 0xAFEE], [0xBEEF, 0x503A], [0xCAFE, 0x5D02],
    [0x5A5A, 0x737D], [0xA5A5, 0x1977], [0x8000, 0x71E2], [0x7FFF, 0x46C5],
  ],
  cfNGCEngine: [
    [0x0000, 0xD931], [0x0001, 0xA78A], [0xFFFF, 0xF9B4], [0x1234, 0x819A],
    [0xABCD, 0x36F5], [0xDEAD, 0x9279], [0xBEEF, 0x2AFE], [0xCAFE, 0x815A],
    [0x5A5A, 0x11FE], [0xA5A5, 0x2665], [0x8000, 0x4076], [0x7FFF, 0xCFA5],
  ],
  cfNGCTrans: [
    [0x0000, 0x833B], [0x0001, 0xB985], [0xFFFF, 0x8ED5], [0x1234, 0xEFB4],
    [0xABCD, 0x1249], [0xDEAD, 0x8BCA], [0xBEEF, 0xCFC5], [0xCAFE, 0x737A],
    [0x5A5A, 0xAEFB], [0xA5A5, 0x2FBF], [0x8000, 0x2E57], [0x7FFF, 0x9C8D],
  ],
  cfVenomPCM: [
    [0x0000, 0xDF67], [0x0001, 0x0705], [0xFFFF, 0x9EE1], [0x1234, 0xF2DC],
    [0xABCD, 0x2B67], [0xDEAD, 0x4280], [0xBEEF, 0xFA37], [0xCAFE, 0x0396],
    [0x5A5A, 0x149C], [0xA5A5, 0xB438], [0x8000, 0x29BC], [0x7FFF, 0xE3D2],
  ],
  cfHuntsvilleRadio: [
    [0x0000, 0xBB06], [0x0001, 0xFCE5], [0xFFFF, 0xD6DF], [0x1234, 0x8A58],
    [0xABCD, 0x25BA], [0xDEAD, 0xBBDD], [0xBEEF, 0x16E3], [0xCAFE, 0xD207],
    [0x5A5A, 0x64D8], [0xA5A5, 0xDD7C], [0x8000, 0xC30B], [0x7FFF, 0x1F9E],
  ],
  cfWCM: [
    [0x0000, 0x1400], [0x0001, 0xA436], [0xFFFF, 0x18BB], [0x1234, 0x6DE0],
    [0xABCD, 0x5414], [0xDEAD, 0x1C01], [0xBEEF, 0xC429], [0xCAFE, 0xEC7E],
    [0x5A5A, 0x7C32], [0xA5A5, 0xF371], [0x8000, 0x1400], [0x7FFF, 0x98BB],
  ],
};

const FNS_16 = { cfBCM, cfTIPM, cfTrwABS, cfBoschABS, cfITM, cfYazakiFCM, cfNGCEngine, cfNGCTrans, cfVenomPCM, cfHuntsvilleRadio, cfWCM };

for (const [name, fn] of Object.entries(FNS_16)) {
  describe(`${name} (16-bit seed/key)`, () => {
    const vectors = VECTORS_16[name];
    test.each(vectors)('seed=0x%s → key=0x%s', (seed, expected) => {
      expect(fn(seed)).toBe(expected);
    });
    it('covers every pinned seed in SEEDS_16', () => {
      expect(vectors.map(v => v[0])).toEqual(SEEDS_16);
    });
    it('returns a value within 16-bit range', () => {
      for (const s of SEEDS_16) {
        const k = fn(s);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(0xFFFF);
      }
    });
  });
}

describe('cfGPEC (32-bit TEA Feistel, key="DAIMLERCHRYSLER3")', () => {
  test.each([
    [0x00000000, 0xF5B9DE24],
    [0xFFFFFFFF, 0xD89B1FE3],
    [0x12345678, 0x01C42892],
    [0xDEADBEEF, 0x0C49D041],
    [0xCAFEBABE, 0x205540D9],
    [0xA1B2C3D4, 0x87F3449E],
    [0x01020304, 0x925A7C1D],
    [0xF0E1D2C3, 0x873D46FD],
    [0x55555555, 0x08072DC8],
    [0xAAAAAAAA, 0x80F987DB],
  ])('cfGPEC(0x%s) === 0x%s', (seed, expected) => {
    expect(cfGPEC(seed) >>> 0).toBe(expected);
  });
});

describe('cfAlpineRAK (2-arg 32-bit LCG XOR)', () => {
  test.each([
    [0x00000000, 0x00000000, 0x00004E2B],
    [0x00000001, 0x00000002, 0xC24AFD9E],
    [0x12345678, 0x9ABCDEF0, 0xC089E313],
    [0xDEADBEEF, 0xCAFEBABE, 0xA44E94C8],
    [0xFFFFFFFF, 0x00000000, 0xBE399FDE],
    [0x11111111, 0x22222222, 0x0CA6F8EE],
  ])('cfAlpineRAK(0x%s, 0x%s) === 0x%s', (lo, hi, expected) => {
    expect(cfAlpineRAK(lo, hi) >>> 0).toBe(expected);
  });
});

describe('cfCall16 / cfCall32 / cfCall32x2 byte-array helpers', () => {
  it('cfCall16 packs a 2-byte BE seed and unpacks a 2-byte BE key', () => {
    // cfBCM(0x1234) === 0x526C
    expect(cfCall16(cfBCM, [0x12, 0x34])).toEqual([0x52, 0x6C]);
  });
  it('cfCall16 masks input bytes to 8 bits', () => {
    expect(cfCall16(cfBCM, [0x112, 0x234])).toEqual(cfCall16(cfBCM, [0x12, 0x34]));
  });
  it('cfCall32 packs a 4-byte BE seed and unpacks a 4-byte BE key', () => {
    // cfGPEC(0x12345678) === 0x01C42892
    expect(cfCall32(cfGPEC, [0x12, 0x34, 0x56, 0x78])).toEqual([0x01, 0xC4, 0x28, 0x92]);
  });
  it('cfCall32x2 packs two 4-byte BE seeds and unpacks a 4-byte BE key', () => {
    // cfAlpineRAK(0x12345678, 0x9ABCDEF0) === 0xC089E313
    expect(cfCall32x2(cfAlpineRAK, [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]))
      .toEqual([0xC0, 0x89, 0xE3, 0x13]);
  });
});

describe('CANFLASH_MAP', () => {
  it('contains all 13 verified module families', () => {
    expect(Object.keys(CANFLASH_MAP).sort()).toEqual([
      'ABS_BOSCH', 'ABS_TRW', 'BCM', 'BCM_LX', 'ITM', 'PCM_GPEC', 'PCM_NGC',
      'PCM_VENOM', 'RADIO', 'RAK', 'TCM', 'TIPM_7', 'WCM',
    ]);
  });
  it('each entry exposes tx/rx/algo/name', () => {
    for (const [k, v] of Object.entries(CANFLASH_MAP)) {
      expect(typeof v.tx, k).toBe('number');
      expect(typeof v.rx, k).toBe('number');
      expect(typeof v.algo, k).toBe('function');
      expect(typeof v.name, k).toBe('string');
    }
  });
  it('wires the algo references correctly (BCM → cfBCM, GPEC → cfGPEC, RAK → cfAlpineRAK)', () => {
    expect(CANFLASH_MAP.BCM.algo).toBe(cfBCM);
    expect(CANFLASH_MAP.PCM_GPEC.algo).toBe(cfGPEC);
    expect(CANFLASH_MAP.RAK.algo).toBe(cfAlpineRAK);
    expect(CANFLASH_MAP.PCM_GPEC.bits).toBe(32);
    expect(CANFLASH_MAP.RAK.bits).toBe(64);
  });
});

describe('MODULE_SPECS', () => {
  it('covers all 13 VIN-programmable module entries', () => {
    expect(Object.keys(MODULE_SPECS).sort()).toEqual([
      'ABS_BOSCH', 'ABS_TRW', 'BCM_LX', 'BCM_STANDARD', 'ITM', 'PCM_GPEC',
      'PCM_NGC', 'PCM_VENOM', 'RADIO', 'RAK', 'TCM', 'TIPM_7', 'WCM',
    ]);
  });
  it('every entry carries securityLevel/sessionType/canTx/canRx/unlockAlgo', () => {
    for (const [k, v] of Object.entries(MODULE_SPECS)) {
      expect(typeof v.securityLevel, k).toBe('number');
      expect(typeof v.sessionType, k).toBe('number');
      expect(typeof v.canTx, k).toBe('number');
      expect(typeof v.canRx, k).toBe('number');
      expect(typeof v.unlockAlgo, k).toBe('string');
      expect(typeof v.description, k).toBe('string');
    }
  });
  it('WCM advertises its 4 EEPROM VIN slot offsets', () => {
    expect(MODULE_SPECS.WCM.eepromVinOffsets).toEqual([0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1]);
  });
  it('RAK is flagged as a 2-arg unlock', () => {
    expect(MODULE_SPECS.RAK.unlockArgs).toBe(2);
  });
});
