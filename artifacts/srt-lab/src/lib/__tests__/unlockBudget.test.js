import { describe, it, expect } from 'vitest';
import { rankCandidates, bestCandidate, budgetFromSeedNrc } from '../unlockBudget.js';
import { pickUnlockChain } from '../algos.js';

const seed = [0x11, 0x22, 0x33, 0x44];

describe('unlockBudget.rankCandidates', () => {
  it('is a SUBSET of pickUnlockChain (never invents ids; only drops non-computable)', () => {
    const ranked = rankCandidates({ seed, tx: 0x750, code: 'BCM' });
    const base = new Set(pickUnlockChain(0x750, 'BCM'));
    expect(ranked.length).toBeGreaterThan(0);
    for (const c of ranked) expect(base.has(c.id)).toBe(true);
  });

  it('floats a remembered algo for THIS tx to the top', () => {
    const ranked = rankCandidates({ seed, tx: 0x7E0, code: 'ECM', remembered: 'gpec3' });
    expect(ranked[0].id).toBe('gpec3');
    expect(ranked[0].reasons).toContain('remembered');
  });

  it('every candidate carries offline-computed key bytes', () => {
    const ranked = rankCandidates({ seed, tx: 0x7E0, code: 'ECM' });
    expect(ranked[0].keyBytes.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0].keyHex).toMatch(/^[0-9A-F ]+$/);
  });

  it('bestCandidate returns the single top shot', () => {
    const best = bestCandidate({ seed, tx: 0x7E0, code: 'ECM', remembered: 'gpec2' });
    expect(best.id).toBe('gpec2');
  });

  it('budgetFromSeedNrc treats 0x36/0x37 as already-locked (fire zero keys)', () => {
    expect(budgetFromSeedNrc(0x36)).toMatchObject({ locked: true, advise: 'dealer-lockout-bypass' });
    expect(budgetFromSeedNrc(0x37).locked).toBe(true);
    expect(budgetFromSeedNrc(0x35).locked).toBe(false);
  });
});
