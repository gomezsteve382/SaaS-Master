import { describe, it, expect } from 'vitest';
import { ALGOS, unlockKey, unlockKeyBytes } from '../algos.js';

describe('GPEC2A W6 algorithm (AlfaOBD, byte-verified)', () => {
  it('matches the verified vector: seed 0xC1FFCBC1 -> key 0x162C124F', () => {
    const algo = ALGOS.find(a => a.id === 'gpec2a_w6');
    expect(algo).toBeTruthy();
    expect(algo.fn(0xC1FFCBC1) >>> 0).toBe(0x162C124F);
    expect(unlockKey('gpec2a_w6', 0xC1FFCBC1) >>> 0).toBe(0x162C124F);
  });

  it('returns the verified key as 4 bytes via unlockKeyBytes', () => {
    const kb = unlockKeyBytes('gpec2a_w6', [0xC1, 0xFF, 0xCB, 0xC1]);
    expect(kb).toEqual([0x16, 0x2C, 0x12, 0x4F]);
  });
});
