/**
 * Task #464 — fmtOff offset formatter for the Module Sync workspace.
 *
 * The reference FCA SINCRO tool prints byte offsets in both their hex
 * (canonical) and decimal forms — `0x1328 (4904)` — so a tech reading
 * the on-screen status next to a hex editor doesn't have to convert in
 * their head. fmtOff centralises that formatting so every place we
 * render an offset on Module Sync stays identical.
 */
import { describe, it, expect } from 'vitest';
import { fmtOff } from '../tabs/ModuleSync.jsx';

describe('fmtOff — combined hex + decimal offset render', () => {
  it.each([
    [0x0000,       '0x0000 (0)'],
    [0x1328,       '0x1328 (4904)'],
    [0x40C9,       '0x40C9 (16585)'],
    [0x050E,       '0x050E (1294)'],
    [0x0522,       '0x0522 (1314)'],
    [0xFFFF,       '0xFFFF (65535)'],
    [0x10000,      '0x10000 (65536)'],
    [0x12345678,   '0x12345678 (305419896)'],
  ])('formats %d -> %s', (value, expected) => {
    expect(fmtOff(value)).toBe(expected);
  });

  it('falls back to em-dash for null / undefined / NaN', () => {
    expect(fmtOff(null)).toBe('—');
    expect(fmtOff(undefined)).toBe('—');
    expect(fmtOff(Number.NaN)).toBe('—');
  });

  it('renders 0 (zero) as a real value, not the em-dash', () => {
    /* Regression guard: a falsy-but-valid offset of 0 must not be mistaken
     * for an unknown offset. The reference tool happily prints 0x0000 (0)
     * for the GPEC2A first VIN slot, so we do too. */
    expect(fmtOff(0)).toBe('0x0000 (0)');
  });
});
