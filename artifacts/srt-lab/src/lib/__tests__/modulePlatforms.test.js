import { describe, it, expect } from 'vitest';
import { getAddr, addressVariants, platformForAddr, codesForPlatform, DEFAULT_PLATFORM } from '../modulePlatforms.js';

describe('modulePlatforms', () => {
  it('returns the bench-verified LD-2019 addresses (RX = low id)', () => {
    expect(getAddr('BCM', 'ld-2019')).toEqual({ tx: 0x620, rx: 0x504 });
    expect(getAddr('RFHUB', 'ld-2019')).toEqual({ tx: 0x740, rx: 0x4C0 });
    expect(getAddr('IPC', 'ld-2019')).toEqual({ tx: 0x742, rx: 0x4C2 });
    expect(getAddr('PCM', 'ld-2019')).toEqual({ tx: 0x7E0, rx: 0x7E8 });
  });

  it('keeps the three real RFHUB platforms DISTINCT (collapsing would brick)', () => {
    const v = addressVariants('RFHUB');
    expect(v).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'ld-2019', tx: 0x740, rx: 0x4C0 }),
      expect.objectContaining({ platform: 'cusw', tx: 0x75F, rx: 0x767 }),
    ]));
  });

  it('reverse-resolves a (tx,rx) pair to platform + code', () => {
    expect(platformForAddr(0x620, 0x504)).toEqual({ platform: 'ld-2019', code: 'BCM' });
    expect(platformForAddr(0x75F, 0x767)).toEqual({ platform: 'cusw', code: 'RFHUB' });
    expect(platformForAddr(0x999, 0x111)).toBeNull();
  });

  it('defaults to the bench-verified platform', () => {
    expect(DEFAULT_PLATFORM).toBe('ld-2019');
    expect(getAddr('BCM')).toEqual({ tx: 0x620, rx: 0x504 });
  });

  it('returns null for an unknown code/platform and lists platform codes', () => {
    expect(getAddr('NOPE', 'ld-2019')).toBeNull();
    expect(getAddr('BCM', 'nope')).toBeNull();
    expect(codesForPlatform('ld-2019')).toContain('RFHUB');
  });
});
