import { describe, it, expect } from 'vitest';
import {
  HYPOTHESIS,
  evaluateCandidate,
  evaluateAllCandidates,
} from '../codecardHarness.js';
import {
  parseHexBytes,
  isDegeneratePair,
  evaluateBenchPair,
  evaluateToken,
  evaluateAllCandidateTokens,
  findLastSeedKeyPair,
} from '../codecardHarness/index.js';
import { SEND_CODE_CARD_LOGIN_METHOD } from '../securityIntelFromExe.generated.js';

const TOKEN_A = parseHexBytes('4083618902'); // first AlfaOBD candidate
const TOKEN_B = parseHexBytes('3E07860DAD'); // second AlfaOBD candidate

describe('codecardHarness', () => {
  it('returns INSUFFICIENT_DATA when no bench pairs are supplied', () => {
    const candidate = { hex: '4083618902', bytes: '40 83 61 89 02' };
    const result = evaluateCandidate(candidate, []);
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.confidence).toBe('none');
    expect(result.matchedPairs).toEqual([]);
    expect(result.candidateHex).toBe('40 83 61 89 02');
  });

  it('detects H1 CONSTANT_KEY when expectedKey equals candidate bytes literally', () => {
    const candidate = { hex: '4083618902', bytes: '40 83 61 89 02' };
    const benchPairs = [
      {
        seed: [0x12, 0x34, 0x56, 0x78, 0x9a],
        expectedKey: [0x40, 0x83, 0x61, 0x89, 0x02],
        subFunction: 0x04,
      },
    ];
    const result = evaluateCandidate(candidate, benchPairs);
    expect(result.verdict).toBe(HYPOTHESIS.CONSTANT_KEY);
    expect(result.matchedPairs).toHaveLength(1);
    expect(result.matchedPairs[0].hypothesis).toBe(HYPOTHESIS.CONSTANT_KEY);
    expect(result.matchedPairs[0].note).toMatch(/literal match/i);
  });

  it('detects H2 DERIVATION_INPUT via byte-wise XOR(seed, candidate)', () => {
    const seed = [0xaa, 0xbb, 0xcc, 0xdd, 0xee];
    const candidateBytes = [0x11, 0x22, 0x33, 0x44, 0x55];
    const expectedKey = seed.map((b, i) => b ^ candidateBytes[i]);
    const candidate = { hex: 'unused', bytes: candidateBytes };
    const result = evaluateCandidate(candidate, [
      { seed, expectedKey, subFunction: 0x04 },
    ]);
    expect(result.verdict).toBe(HYPOTHESIS.DERIVATION_INPUT);
    expect(result.matchedPairs[0].note).toMatch(/xor/i);
  });

  it('detects H2 DERIVATION_INPUT via concat(seed, candidate).slice(-N)', () => {
    const seed = [0x11, 0x22];
    const candidateBytes = [0xaa, 0xbb, 0xcc, 0xdd, 0xee];
    const expectedKey = [0xcc, 0xdd, 0xee];
    const candidate = { bytes: candidateBytes };
    const result = evaluateCandidate(candidate, [
      { seed, expectedKey, subFunction: 0x04 },
    ]);
    expect(result.verdict).toBe(HYPOTHESIS.DERIVATION_INPUT);
    expect(result.matchedPairs[0].note).toMatch(/concat/i);
  });

  it('detects H2 DERIVATION_INPUT via simple add mod 256', () => {
    const seed = [0xff, 0x80, 0x01, 0x02, 0x03];
    const candidateBytes = [0x02, 0x80, 0x05, 0x06, 0x07];
    const expectedKey = seed.map((b, i) => (b + candidateBytes[i]) & 0xff);
    const candidate = { bytes: candidateBytes };
    const result = evaluateCandidate(candidate, [
      { seed, expectedKey, subFunction: 0x04 },
    ]);
    expect(result.verdict).toBe(HYPOTHESIS.DERIVATION_INPUT);
    expect(result.matchedPairs[0].note).toMatch(/add-mod-256/i);
  });

  it('returns H3 REJECTED when bench pairs exist but no hypothesis matches', () => {
    const candidate = { bytes: [0x01, 0x02, 0x03, 0x04, 0x05] };
    const benchPairs = [
      {
        seed: [0xde, 0xad, 0xbe, 0xef, 0xca],
        expectedKey: [0x99, 0x88, 0x77, 0x66, 0x55],
        subFunction: 0x04,
      },
    ];
    const result = evaluateCandidate(candidate, benchPairs);
    expect(result.verdict).toBe(HYPOTHESIS.REJECTED);
    expect(result.confidence).toBe('none');
    expect(result.summary).toMatch(/REPORT ONLY/);
  });

  it('evaluateAllCandidates returns one verdict per candidate in SEND_CODE_CARD_LOGIN_METHOD', () => {
    const expectedLen = SEND_CODE_CARD_LOGIN_METHOD.candidate_codecard_keys_5byte.length;
    const results = evaluateAllCandidates([]);
    expect(results).toHaveLength(expectedLen);
    results.forEach((r) => {
      expect(r.verdict).toBe('INSUFFICIENT_DATA');
      expect(typeof r.candidateHex).toBe('string');
      expect(r.candidateHex.length).toBeGreaterThan(0);
    });
  });
});

/* Tests for the CodeCard bench-pair harness (Task #828). */

describe('parseHexBytes', () => {
  it('parses with and without spaces / 0x prefix', () => {
    expect(Array.from(parseHexBytes('4083618902'))).toEqual([0x40, 0x83, 0x61, 0x89, 0x02]);
    expect(Array.from(parseHexBytes('40 83 61 89 02'))).toEqual([0x40, 0x83, 0x61, 0x89, 0x02]);
    expect(Array.from(parseHexBytes('0x4083618902'))).toEqual([0x40, 0x83, 0x61, 0x89, 0x02]);
  });
  it('rejects odd length / non-hex', () => {
    expect(() => parseHexBytes('ABC')).toThrow();
    expect(() => parseHexBytes('ZZ')).toThrow();
  });
});

describe('isDegeneratePair', () => {
  it('flags all-zero / all-FF / equal seed/key as degenerate', () => {
    expect(isDegeneratePair(new Uint8Array(5), new Uint8Array([1, 2, 3, 4, 5]))).toBe(true);
    expect(isDegeneratePair(new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]), new Uint8Array([1, 2, 3, 4]))).toBe(true);
    const same = new Uint8Array([1, 2, 3, 4, 5]);
    expect(isDegeneratePair(same, same)).toBe(true);
  });
  it('accepts a normal random-looking pair', () => {
    expect(isDegeneratePair(
      new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A]),
      new Uint8Array([0xAB, 0xCD, 0xEF, 0x01, 0x23]),
    )).toBe(false);
  });
});

describe('evaluateBenchPair — constant-key positive', () => {
  it('returns confirmed-constant-key when the ECU echoed the token bytes', () => {
    const seed = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const r = evaluateBenchPair(TOKEN_A, seed, TOKEN_A);
    expect(r.verdict).toBe('confirmed-constant-key');
    expect(r.hypotheses[0].matched).toBe(true);
  });
});

describe('evaluateBenchPair — derivation positive', () => {
  it('detects token XOR seed (tiled) as a derivation match', () => {
    const seed = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
    // key = token XOR seed
    const key = new Uint8Array(TOKEN_A.length);
    for (let i = 0; i < TOKEN_A.length; i++) key[i] = TOKEN_A[i] ^ seed[i];
    const r = evaluateBenchPair(TOKEN_A, seed, key);
    expect(r.verdict).toBe('confirmed-derivation-input');
    expect(r.hypotheses[1].matched).toBe(true);
    expect(r.hypotheses[1].transform).toBe('token_xor_seed');
  });

  it('detects token + seed mod 256', () => {
    const seed = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const key = new Uint8Array(TOKEN_B.length);
    for (let i = 0; i < TOKEN_B.length; i++) key[i] = (TOKEN_B[i] + seed[i]) & 0xFF;
    const r = evaluateBenchPair(TOKEN_B, seed, key);
    expect(r.verdict).toBe('confirmed-derivation-input');
    expect(r.hypotheses[1].transform).toBe('token_add_seed');
  });
});

describe('evaluateBenchPair — rejection on random data', () => {
  it('returns rejected when neither hypothesis matches and inputs are non-degenerate', () => {
    const seed = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A]);
    const key  = new Uint8Array([0xAB, 0xCD, 0xEF, 0x01, 0x23]);
    const r = evaluateBenchPair(TOKEN_A, seed, key);
    expect(r.verdict).toBe('rejected');
    expect(r.hypotheses.every(h => !h.matched)).toBe(true);
  });
});

describe('evaluateBenchPair — inconclusive on degenerate inputs', () => {
  it('refuses to claim constant-key when seed and key are both all-zero', () => {
    const r = evaluateBenchPair(new Uint8Array(5), new Uint8Array(5), new Uint8Array(5));
    expect(r.degenerate).toBe(true);
    expect(r.verdict).toBe('inconclusive-need-more-pairs');
  });

  it('flags seed == key as degenerate even when the token matches', () => {
    const seed = TOKEN_A;
    const key = TOKEN_A;
    const r = evaluateBenchPair(TOKEN_A, seed, key);
    expect(r.degenerate).toBe(true);
    expect(r.verdict).toBe('inconclusive-need-more-pairs');
  });
});

describe('evaluateBenchPair — seed-derivation hypothesis (C)', () => {
  it('marks hypothesis C as matched when the token appears inside the seed', () => {
    const seed = new Uint8Array([0x11, ...TOKEN_A, 0x99]);
    const key  = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xFF]);
    const r = evaluateBenchPair(TOKEN_A, seed, key);
    expect(r.hypotheses[2].matched).toBe(true);
    // C alone is not enough to confirm; A and B must drive the verdict.
    expect(r.verdict).toBe('rejected');
  });
});

describe('evaluateToken — aggregation across multiple pairs', () => {
  it('confirms constant-key only when every pair agrees', () => {
    const pairs = [
      { seed: new Uint8Array([0x11, 0x22, 0x33, 0x44]), key: TOKEN_A },
      { seed: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]), key: TOKEN_A },
    ];
    const r = evaluateToken(TOKEN_A, pairs);
    expect(r.overall).toBe('confirmed-constant-key');
  });

  it('rejects overall when any pair fails', () => {
    const goodKey = new Uint8Array(TOKEN_A);
    const badKey  = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x77]);
    const pairs = [
      { seed: new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A]), key: goodKey },
      { seed: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]), key: badKey },
    ];
    const r = evaluateToken(TOKEN_A, pairs);
    expect(r.overall).toBe('rejected');
  });

  it('returns inconclusive when zero pairs are supplied', () => {
    expect(evaluateToken(TOKEN_A, []).overall).toBe('inconclusive-need-more-pairs');
  });
});

describe('evaluateAllCandidateTokens', () => {
  it('runs the harness over every catalogued candidate token', () => {
    const pairs = [{
      seed: new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A]),
      key:  new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]),
    }];
    const out = evaluateAllCandidateTokens(pairs);
    expect(out).toHaveLength(SEND_CODE_CARD_LOGIN_METHOD.candidate_codecard_keys_5byte.length);
    for (const row of out) {
      expect(row).toHaveProperty('token.hex');
      expect(row).toHaveProperty('result.overall');
    }
  });
});

describe('findLastSeedKeyPair', () => {
  it('returns null when no SA pair is present', () => {
    expect(findLastSeedKeyPair([])).toBeNull();
    expect(findLastSeedKeyPair([
      { dir: 'req',  bytes: [0x22, 0xF1, 0x90] },
      { dir: 'resp', bytes: [0x62, 0xF1, 0x90, 0x01, 0x02] },
    ])).toBeNull();
  });

  it('extracts the most recent 27 03 / 27 04 exchange', () => {
    const lines = [
      { dir: 'req',  bytes: [0x10, 0x03] },
      { dir: 'resp', bytes: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] },
      { dir: 'req',  bytes: [0x27, 0x03] },
      { dir: 'resp', bytes: [0x67, 0x03, 0xAA, 0xBB, 0xCC, 0xDD] }, // seed
      { dir: 'req',  bytes: [0x27, 0x04, 0x11, 0x22, 0x33, 0x44, 0x55] }, // key
      { dir: 'resp', bytes: [0x67, 0x04] },
    ];
    const pair = findLastSeedKeyPair(lines);
    expect(pair).not.toBeNull();
    expect(Array.from(pair.seed)).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
    expect(Array.from(pair.key)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55]);
  });

  it('picks the LAST pair when multiple SA exchanges exist', () => {
    const lines = [
      { dir: 'req',  bytes: [0x27, 0x03] },
      { dir: 'resp', bytes: [0x67, 0x03, 0x01, 0x02, 0x03, 0x04] },
      { dir: 'req',  bytes: [0x27, 0x04, 0xAA, 0xAA, 0xAA, 0xAA] },
      { dir: 'req',  bytes: [0x27, 0x03] },
      { dir: 'resp', bytes: [0x67, 0x03, 0x09, 0x08, 0x07, 0x06] },
      { dir: 'req',  bytes: [0x27, 0x04, 0xBB, 0xBB, 0xBB, 0xBB] },
    ];
    const pair = findLastSeedKeyPair(lines);
    expect(Array.from(pair.seed)).toEqual([0x09, 0x08, 0x07, 0x06]);
    expect(Array.from(pair.key)).toEqual([0xBB, 0xBB, 0xBB, 0xBB]);
  });
});
