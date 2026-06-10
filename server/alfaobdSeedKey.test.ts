/**
 * alfaobdSeedKey.test.ts
 *
 * Vitest unit tests for the AlfaOBD seed-key algorithm library.
 * Tests cover all five algorithm variants extracted from AlfaOBD.exe:
 *   - ht()       — bit-shuffle
 *   - f()        — XTEA-64 little-endian
 *   - ao()       — XTEA-64 big-endian (UCONNECT/RADIO_FGA)
 *   - w6()       — parameterized linear cipher
 *   - gpec2aW6() — GPEC2A ECM (confirmed test vector)
 *
 * GPEC2A test vector (from re-agent workbench finding):
 *   seed=0xC1FFCBC1, r=0x234521F9, s=0x19390673 → key=0x162C124F
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import path from 'path';

const libPath = path.resolve(process.cwd(), 'client/src/srtlab/lib/alfaobdSeedKey.js');

let lib: typeof import('../client/src/srtlab/lib/alfaobdSeedKey.js');
async function loadLib() {
  if (!lib) {
    lib = await import(pathToFileURL(libPath).href);
  }
  return lib;
}

// ─── gpec2aW6 ─────────────────────────────────────────────────────────────────
describe('gpec2aW6', () => {
  it('confirmed test vector: seed=0xC1FFCBC1 → key=0x162C124F', async () => {
    const { gpec2aW6 } = await loadLib();
    const seed = [0xC1, 0xFF, 0xCB, 0xC1];
    const key = gpec2aW6(seed);
    const keyU32 = (key[0] << 24) | (key[1] << 16) | (key[2] << 8) | key[3];
    expect(keyU32 >>> 0).toBe(0x162C124F);
  });

  it('returns 4-byte array', async () => {
    const { gpec2aW6 } = await loadLib();
    const key = gpec2aW6([0x12, 0x34, 0x56, 0x78]);
    expect(key).toHaveLength(4);
    key.forEach(b => expect(b).toBeGreaterThanOrEqual(0));
    key.forEach(b => expect(b).toBeLessThanOrEqual(255));
  });

  it('zero seed produces non-zero key (s offset)', async () => {
    const { gpec2aW6 } = await loadLib();
    const key = gpec2aW6([0, 0, 0, 0]);
    const keyU32 = (key[0] << 24) | (key[1] << 16) | (key[2] << 8) | key[3];
    // key = swap_words(s & 0xFFFFFFFF) = swap_words(0x19390673)
    const s = 0x19390673;
    const expected = (((s >>> 16) | ((s & 0xFFFF) << 16)) >>> 0);
    expect(keyU32 >>> 0).toBe(expected);
  });

  it('different seeds produce different keys (avalanche)', async () => {
    const { gpec2aW6 } = await loadLib();
    const k1 = gpec2aW6([0x00, 0x00, 0x00, 0x01]);
    const k2 = gpec2aW6([0x00, 0x00, 0x00, 0x02]);
    expect(k1).not.toEqual(k2);
  });
});

// ─── w6 ───────────────────────────────────────────────────────────────────────
describe('w6', () => {
  it('returns 4-byte array for known wrapper tt', async () => {
    const { w6, AOBD_W6_TABLE } = await loadLib();
    const [r, s] = AOBD_W6_TABLE['tt'];
    const key = w6([0xC1, 0xFF, 0xCB, 0xC1], r, s);
    expect(key).toHaveLength(4);
  });

  it('wrapper tt matches GPEC2A family 27 level 5', async () => {
    const { w6, AOBD_W6_TABLE } = await loadLib();
    const [r, s] = AOBD_W6_TABLE['tt'];
    // r=0x234521F9, s=0x19390673 — same as gpec2aW6 default params
    expect(r).toBe(0x234521F9);
    expect(s).toBe(0x19390673);
  });

  it('different wrappers produce different keys for same seed', async () => {
    const { w6, AOBD_W6_TABLE } = await loadLib();
    const seed = [0xAB, 0xCD, 0xEF, 0x01];
    const [r1, s1] = AOBD_W6_TABLE['a0'];
    const [r2, s2] = AOBD_W6_TABLE['a1'];
    const k1 = w6(seed, r1, s1);
    const k2 = w6(seed, r2, s2);
    expect(k1).not.toEqual(k2);
  });

  it('AOBD_W6_TABLE has at least 100 entries', async () => {
    const { AOBD_W6_TABLE } = await loadLib();
    expect(Object.keys(AOBD_W6_TABLE).length).toBeGreaterThanOrEqual(100);
  });
});

// ─── ht ───────────────────────────────────────────────────────────────────────
describe('ht (bit-shuffle)', () => {
  it('returns 4-byte array', async () => {
    const { ht } = await loadLib();
    const key = ht([0x12, 0x34, 0x56, 0x78]);
    expect(key).toHaveLength(4);
  });

  it('is deterministic', async () => {
    const { ht } = await loadLib();
    const seed = [0xDE, 0xAD, 0xBE, 0xEF];
    expect(ht(seed)).toEqual(ht(seed));
  });

  it('zero seed produces non-zero key (XOR constant)', async () => {
    const { ht } = await loadLib();
    const key = ht([0, 0, 0, 0]);
    const keyU32 = (key[0] << 24) | (key[1] << 16) | (key[2] << 8) | key[3];
    // v2=0, v3=0^0x41AA42BB=0x41AA42BB, v4=0&0x22BA9A31=0, result=0^0x41AA42BB
    expect(keyU32 >>> 0).toBe(0x41AA42BB);
  });
});

// ─── f (XTEA LE) ──────────────────────────────────────────────────────────────
describe('f (XTEA-64 little-endian)', () => {
  it('returns 4-byte array', async () => {
    const { f } = await loadLib();
    const key = f([0x12, 0x34, 0x56, 0x78]);
    expect(key).toHaveLength(4);
  });

  it('is deterministic', async () => {
    const { f } = await loadLib();
    const seed = [0xCA, 0xFE, 0xBA, 0xBE];
    expect(f(seed)).toEqual(f(seed));
  });

  it('different seeds produce different keys', async () => {
    const { f } = await loadLib();
    const k1 = f([0x00, 0x00, 0x00, 0x01]);
    const k2 = f([0x00, 0x00, 0x00, 0x02]);
    expect(k1).not.toEqual(k2);
  });
});

// ─── ao (XTEA BE) ─────────────────────────────────────────────────────────────
describe('ao (XTEA-64 big-endian, UCONNECT)', () => {
  it('returns 4-byte array', async () => {
    const { ao } = await loadLib();
    const key = ao([0x12, 0x34, 0x56, 0x78]);
    expect(key).toHaveLength(4);
  });

  it('f and ao differ for same seed (endian difference)', async () => {
    const { f, ao } = await loadLib();
    const seed = [0x12, 0x34, 0x56, 0x78];
    expect(f(seed)).not.toEqual(ao(seed));
  });

  it('is deterministic', async () => {
    const { ao } = await loadLib();
    const seed = [0xAB, 0xCD, 0xEF, 0x01];
    expect(ao(seed)).toEqual(ao(seed));
  });
});

// ─── computeSeedKey dispatcher ────────────────────────────────────────────────
describe('computeSeedKey', () => {
  it('dispatches gpec2a algorithm', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0xC1, 0xFF, 0xCB, 0xC1], { algorithm: 'gpec2a' });
    expect(result.keyBytes).toHaveLength(4);
    const keyU32 = (result.keyBytes[0] << 24) | (result.keyBytes[1] << 16) |
                   (result.keyBytes[2] << 8) | result.keyBytes[3];
    expect(keyU32 >>> 0).toBe(0x162C124F);
    expect(result.algorithm).toBe('gpec2a_w6');
  });

  it('dispatches w6 with wrapper name', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0xAB, 0xCD, 0xEF, 0x01], { algorithm: 'w6', wrapper: 'a0' });
    expect(result.keyBytes).toHaveLength(4);
    expect(result.algorithm).toContain('w6');
  });

  it('dispatches ht algorithm', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0x12, 0x34, 0x56, 0x78], { algorithm: 'ht' });
    expect(result.keyBytes).toHaveLength(4);
    expect(result.algorithm).toBe('ht');
  });

  it('dispatches ao algorithm', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0x12, 0x34, 0x56, 0x78], { algorithm: 'ao' });
    expect(result.keyBytes).toHaveLength(4);
    expect(result.algorithm).toBe('ao');
  });

  it('auto-dispatch via familyId+securityLevel (family 27 level 5 → tt)', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0xC1, 0xFF, 0xCB, 0xC1], {
      algorithm: 'auto',
      familyId: 27,
      securityLevel: 5,
    });
    expect(result.algorithm).toContain('tt');
  });

  it('returns keyHex as uppercase space-separated bytes', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0xC1, 0xFF, 0xCB, 0xC1], { algorithm: 'gpec2a' });
    expect(result.keyHex).toMatch(/^[0-9A-F]{2}( [0-9A-F]{2}){3}$/);
  });

  it('returns sendCommand as UDS 27 XX frame', async () => {
    const { computeSeedKey } = await loadLib();
    const result = computeSeedKey([0xC1, 0xFF, 0xCB, 0xC1], {
      algorithm: 'gpec2a',
      securityLevel: 5,
    });
    expect(result.sendCommand).toMatch(/^27 06 /);
  });

  it('throws for unknown algorithm', async () => {
    const { computeSeedKey } = await loadLib();
    expect(() => computeSeedKey([0x01, 0x02, 0x03, 0x04], { algorithm: 'unknown_algo' }))
      .toThrow();
  });

  it('throws for w6 without wrapper or r/s', async () => {
    const { computeSeedKey } = await loadLib();
    expect(() => computeSeedKey([0x01, 0x02, 0x03, 0x04], { algorithm: 'w6' }))
      .toThrow();
  });
});

// ─── parseSeedResponse ────────────────────────────────────────────────────────
describe('parseSeedResponse', () => {
  it('parses "67 05 C1 FF CB C1" → [0xC1, 0xFF, 0xCB, 0xC1]', async () => {
    const { parseSeedResponse } = await loadLib();
    const seed = parseSeedResponse('67 05 C1 FF CB C1');
    expect(seed).toEqual([0xC1, 0xFF, 0xCB, 0xC1]);
  });

  it('throws for too-short response', async () => {
    const { parseSeedResponse } = await loadLib();
    expect(() => parseSeedResponse('67 05 C1 FF')).toThrow();
  });
});

// ─── DISPATCH table ───────────────────────────────────────────────────────────
describe('DISPATCH', () => {
  it('family 27 level 5 maps to tt', async () => {
    const { DISPATCH } = await loadLib();
    expect(DISPATCH[27 * 100 + 5]).toBe('tt');
  });

  it('family 27 level 7 maps to tp', async () => {
    const { DISPATCH } = await loadLib();
    expect(DISPATCH[27 * 100 + 7]).toBe('tp');
  });

  it('family 39 level 1 maps to au', async () => {
    const { DISPATCH } = await loadLib();
    expect(DISPATCH[39 * 100 + 1]).toBe('au');
  });
});

// ─── SPECIAL_ECUS ─────────────────────────────────────────────────────────────
describe('SPECIAL_ECUS', () => {
  it('0x149 is UCONNECT with ao algorithm', async () => {
    const { SPECIAL_ECUS } = await loadLib();
    expect(SPECIAL_ECUS[0x149]).toBeDefined();
    expect(SPECIAL_ECUS[0x149].algo).toBe('ao');
  });

  it('0x14E is RADIO_FGA with ao algorithm', async () => {
    const { SPECIAL_ECUS } = await loadLib();
    expect(SPECIAL_ECUS[0x14E]).toBeDefined();
    expect(SPECIAL_ECUS[0x14E].algo).toBe('ao');
  });
});
