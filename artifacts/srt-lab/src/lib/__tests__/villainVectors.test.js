import { describe, it, expect } from 'vitest';
import { ALGOS, unlockKey, sxor } from '../algos.js';

// Pin the engine to VILLAIN's dump-verified self-test vectors (villain_complete.py).
const key = (id, seed) => unlockKey(id, seed) >>> 0;

describe('VILLAIN dump-verified seed/key vectors', () => {
  it('gpec2a_w6 (AlfaOBD): seed 0xC1FFCBC1 -> 0x162C124F', () => {
    expect(key('gpec2a_w6', 0xC1FFCBC1)).toBe(0x162C124F);
  });

  it('gpec2: seed 0x12345678 -> 0x6FF897AB (VILLAIN selftest)', () => {
    expect(key('gpec2', 0x12345678)).toBe(0x6FF897AB);
  });

  it('sbec: (seed*4 + 0x9018)', () => {
    expect(key('sbec', 0x10)).toBe((0x10 * 4 + 0x9018) >>> 0);
  });

  it('jtec: fixed key 0', () => {
    expect(key('jtec', 0xDEADBEEF)).toBe(0);
  });

  it('eps: real algorithm present + matches sxor 0xCD6BDBF5 (NOT cda6)', () => {
    expect(ALGOS.find(a => a.id === 'eps')).toBeTruthy();
    expect(key('eps', 0x12345678)).toBe(sxor(0x12345678, 0xCD6BDBF5) >>> 0);
  });
});
