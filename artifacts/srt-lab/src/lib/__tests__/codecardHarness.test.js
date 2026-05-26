import { describe, it, expect } from 'vitest';
import {
  HYPOTHESIS,
  evaluateCandidate,
  evaluateAllCandidates,
} from '../codecardHarness.js';
import { SEND_CODE_CARD_LOGIN_METHOD } from '../securityIntelFromExe.generated.js';

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
