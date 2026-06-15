import { describe, it, expect } from 'vitest';
import { planAkl, AKL_STEP } from '../aklPlanner.js';

const ids = (p) => p.steps.map(s => s.id);

describe('aklPlanner', () => {
  it('blocks when there is no live bridge (cannot program a key)', () => {
    const p = planAkl({ hasBridge: false });
    expect(p.ok).toBe(false);
    expect(p.blocks.join(' ')).toMatch(/live bridge/i);
  });

  it('live branch reads PIN live, no erase', () => {
    const p = planAkl({ hasBridge: true });
    expect(p.branch).toBe('live');
    expect(p.ok).toBe(true);
    expect(ids(p)).toContain(AKL_STEP.PIN_LIVE);
    expect(ids(p)).not.toContain(AKL_STEP.ERASE);
  });

  it('dump branch extracts PIN offline when a 16+ byte SEC16 is present', () => {
    const p = planAkl({ hasBridge: true, hasDump: true, dumpSec16: new Array(16).fill(0) });
    expect(p.branch).toBe('dump');
    expect(ids(p)).toContain(AKL_STEP.PIN_OFFLINE);
  });

  it('slots-full requires an explicit erase confirm', () => {
    const blocked = planAkl({ hasBridge: true, slots: { occupiedCount: 8, total: 8 } });
    expect(blocked.ok).toBe(false);
    expect(ids(blocked)).toContain(AKL_STEP.ERASE);
    const ok = planAkl({ hasBridge: true, slots: { occupiedCount: 8, total: 8 }, eraseConfirmed: true });
    expect(ok.ok).toBe(true);
  });

  it('always exits key-learn as the final step', () => {
    const p = planAkl({ hasBridge: true });
    expect(p.steps[p.steps.length - 1].id).toBe(AKL_STEP.EXIT);
  });
});
