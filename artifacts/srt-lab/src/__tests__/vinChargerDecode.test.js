// Vitest coverage for the Charger SRT VIN decoder (Task #488).
import { describe, test, expect } from 'vitest';
import { decodeChargerVin, parseVinYear } from '../lib/vin.js';

function buildVin({ engine = 'L', trim = '5', year = 'K' } = {}) {
  const v = '2C3CDX' + engine + trim + '0' + year + 'H123456';
  expect(v.length).toBe(17);
  return v;
}

describe('decodeChargerVin', () => {
  test('returns null for non-Charger VINs', () => {
    expect(decodeChargerVin('1C4HJXEN5MW123456')).toBeNull();
    expect(decodeChargerVin('')).toBeNull();
    expect(decodeChargerVin(null)).toBeNull();
    expect(decodeChargerVin('2C3CDX')).toBeNull();
  });

  test('recognises the 2022 Hellcat Redeye Jailbreak (engine L, trim 9)', () => {
    const r = decodeChargerVin(buildVin({ engine: 'L', trim: '9', year: 'N' }));
    expect(r).toBeTruthy();
    expect(r.trim).toMatch(/Jailbreak/);
    expect(r.engine).toBe('L');
    expect(r.year).toBe(2022);
    expect(r.family).toBe('Charger LD');
  });

  test('handles 2018+ Hellcat Redeye trim 5', () => {
    const r = decodeChargerVin(buildVin({ engine: 'L', trim: '5', year: 'J' }));
    expect(r).toBeTruthy();
    expect(r.trim).toMatch(/Hellcat Redeye/);
    expect(r.hp).toMatch(/797 HP/);
  });

  test('handles base SRT Hellcat (trim 0) HP bump in 2021+', () => {
    const oldR = decodeChargerVin(buildVin({ engine: 'L', trim: '0', year: 'J' }));
    const newR = decodeChargerVin(buildVin({ engine: 'L', trim: '0', year: 'M' }));
    expect(oldR.hp).toMatch(/707 HP/);
    expect(newR.hp).toMatch(/717 HP/);
  });

  test('recognises non-Hellcat trims by engine code', () => {
    const t392 = decodeChargerVin(buildVin({ engine: 'T', trim: '0', year: 'J' }));
    const rt    = decodeChargerVin(buildVin({ engine: 'G', trim: '0', year: 'J' }));
    const sp    = decodeChargerVin(buildVin({ engine: 'H', trim: '0', year: 'J' }));
    expect(t392.trim).toMatch(/392|Scat Pack/);
    expect(rt.trim).toMatch(/R\/T/);
    expect(sp.trim).toMatch(/Scat Pack/);
    expect(t392.family).toBe('Charger LD');
  });

  test('returns null when engine code is unknown', () => {
    expect(decodeChargerVin(buildVin({ engine: 'Z', trim: '0', year: 'J' }))).toBeNull();
  });

  test('agrees with parseVinYear for the year field', () => {
    const v = buildVin({ engine: 'L', trim: '5', year: 'K' });
    const r = decodeChargerVin(v);
    expect(r.year).toBe(parseVinYear(v));
    expect(r.year).toBe(2019);
  });
});
