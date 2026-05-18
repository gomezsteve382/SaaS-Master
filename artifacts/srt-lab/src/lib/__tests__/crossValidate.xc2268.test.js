/* Task #678 — crossValidate must surface XC2268 RFHUB as live-only
 * rather than silently producing zero SEC16 verdicts. */
import { describe, it, expect } from 'vitest';
import { crossValidate } from '../crossValidate.js';

describe('crossValidate — XC2268 live-only banner', () => {
  it('emits the XC2268 warning when a Ram XC2268 RFHUB is loaded', () => {
    const r = crossValidate([
      { type: 'XC2268_RFHUB', vins: [{ vin: '1C6RR7LT5KS123456' }] },
    ]);
    expect(r.warnings.some(w => w.startsWith('XC2268 RFHUB'))).toBe(true);
  });
  it('does NOT emit the XC2268 warning when only a legacy RFHUB is loaded', () => {
    const r = crossValidate([
      { type: 'RFHUB', vins: [{ vin: '2C3CDXL90MH582899' }] },
    ]);
    expect(r.warnings.some(w => w.startsWith('XC2268 RFHUB'))).toBe(false);
  });
});
