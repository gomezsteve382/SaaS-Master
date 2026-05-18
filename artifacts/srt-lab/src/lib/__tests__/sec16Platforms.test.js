import { describe, it, expect } from 'vitest';
import { classifyPlatform, PLATFORM_IDS, platformMeta } from '../sec16Platforms.js';

describe('sec16Platforms — WMI classification matrix', () => {
  const cases = [
    ['1C6RR7LT5KS123456', 'dt-ram-2019plus', true],
    ['3C6UR5GL0KG123456', 'dt-ram-2019plus', true],
    ['1D7HW48N75S123456', 'dt-ram-2019plus', true],
    ['1C4RJFDJ7DC513874', 'wk2-jeep',        false], // Trackhawk WK2
    ['1J4HR58N75C123456', 'wk2-jeep',        false],
    ['1C4SDHCT6KC123456', 'wd-durango',      false], // Durango SRT
    ['1C4PDHCT0KC123456', 'wd-durango',      false],
    ['2C3CDXL90MH582899', 'lx-ld',           false], // Charger
    ['2B3CJ4DV6AH300549', 'lx-ld',           false],
    ['2D3HA53G06H123456', 'lx-ld',           false],
    [null,                'unknown',         false],
    ['SHORTVIN',          'unknown',         false],
    ['XYZ12345678901234', 'unknown',         false],
  ];
  it.each(cases)('VIN %s → %s (liveOnly=%s)', (vin, platform, liveOnly) => {
    const r = classifyPlatform({ vin });
    expect(r.platform).toBe(platform);
    expect(r.liveOnly).toBe(liveOnly);
    expect(r.label).toBe(platformMeta(platform).label);
  });
});

describe('sec16Platforms — XC2268 RFHUB override', () => {
  it('XC2268 module forces dt-ram-2019plus regardless of VIN', () => {
    const r = classifyPlatform({
      vin: '2C3CDXL90MH582899',           // LX/LD VIN
      modules: [{ type: 'XC2268_RFHUB' }], // but Ram XC2268 RFHUB loaded
    });
    expect(r.platform).toBe('dt-ram-2019plus');
    expect(r.liveOnly).toBe(true);
    expect(r.xc2268Detected).toBe(true);
  });
  it('no override when no XC2268 module is present', () => {
    const r = classifyPlatform({
      vin: '2C3CDXL90MH582899',
      modules: [{ type: 'BCM' }, { type: 'RFHUB' }],
    });
    expect(r.platform).toBe('lx-ld');
    expect(r.xc2268Detected).toBe(false);
  });
});

describe('sec16Platforms — required rules', () => {
  it('every platform meta is reachable through PLATFORM_IDS', () => {
    expect(PLATFORM_IDS).toEqual(expect.arrayContaining([
      'lx-ld', 'wk2-jeep', 'wd-durango', 'dt-ram-2019plus', 'unknown',
    ]));
  });
  it('WK2 / WD include 95640 rules; LX/LD does not', () => {
    const wk2 = classifyPlatform({ vin: '1C4RJFDJ7DC513874' });
    const lx  = classifyPlatform({ vin: '2C3CDXL90MH582899' });
    expect(wk2.requiredRules).toContain('rfhub-95640-skey');
    expect(wk2.requiredRules).toContain('rfhub-95640-bcm-sec16');
    expect(lx.requiredRules).not.toContain('rfhub-95640-skey');
  });
  it('dt-ram-2019plus has no required offline rules', () => {
    const r = classifyPlatform({ vin: '1C6RR7LT5KS123456' });
    expect(r.requiredRules).toEqual([]);
    expect(r.liveOnly).toBe(true);
  });
});
