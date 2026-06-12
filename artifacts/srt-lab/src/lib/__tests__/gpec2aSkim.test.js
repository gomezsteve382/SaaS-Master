import { describe, it, expect } from 'vitest';
import { analyzeGpec2aPcm } from '../gpec2aPcmAnalyzer.js';

/* The GPEC immo analyzer must surface the SKIM enable byte @0x0011: 0x80 =
 * immobilizer ENABLED (secret enforced), 0x00/0x02 = DISABLED (bypassed). A PCM
 * can read SEC6-set/IMMO-SYNC yet have SKIM off — the secret then isn't
 * enforced — so the analyzer flags it instead of looking fully paired. The immo
 * fix itself never writes 0x0011 (far from the SEC6 region); this is read-only. */

function gpec2a(skimByte) {
  const b = new Uint8Array(4096);
  const vin = '2C3CDXBG1KH100001';
  for (let i = 0; i < 17; i++) b[i] = vin.charCodeAt(i);   // VIN @0x0000 → canonical GPEC2A
  b[0x0011] = skimByte;
  return b;
}

describe('analyzeGpec2aPcm — SKIM (0x0011) immobilizer enable surfacing', () => {
  it('reports SKIM ENABLED (0x80) with no bypass warning', () => {
    const a = analyzeGpec2aPcm(gpec2a(0x80));
    expect(a.skim).toBeTruthy();
    expect(a.skim.enabled).toBe(true);
    expect(a.skim.state).toBe('ENABLED');
    expect(a.state.skimEnabled).toBe(true);
    expect(a.state.verdict).toContain('SKIM ON');
    expect((a.notes || []).some((n) => /SKIM.*BYPASSED/.test(n.text))).toBe(false);
  });

  it('reports SKIM DISABLED (0x00) and warns immo is bypassed', () => {
    const a = analyzeGpec2aPcm(gpec2a(0x00));
    expect(a.skim.enabled).toBe(false);
    expect(a.skim.state).toBe('DISABLED');
    expect(a.state.skimEnabled).toBe(false);
    expect(a.state.verdict).toContain('SKIM DISABLED');
    const warn = (a.notes || []).find((n) => /SKIM.*BYPASSED/.test(n.text));
    expect(warn).toBeTruthy();
    expect(warn.tag).toBe('WARNING');
  });

  it('treats the alternate disabled value 0x02 as DISABLED', () => {
    const a = analyzeGpec2aPcm(gpec2a(0x02));
    expect(a.skim.enabled).toBe(false);
    expect(a.skim.state).toBe('DISABLED');
  });
});
