// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  encodeShareFragment,
  decodeShareFragment,
  buildShareUrl,
  findVinsInText,
  scrubVinsFromText,
  VIN_PLACEHOLDER,
  __testing,
} from '../shareLink.js';

// Two known check-digit-valid VINs (verified against ISO 3779 weighted sum).
const VIN_A = '2C3CDXL9XKH123456'; // Charger LD-family, check digit X
const VIN_B = '1C4HJXEN6LW123459'; // Wrangler JL-family, check digit 6


const SAMPLE = [
  '(0.000123) can0 7E0#0322F190CCCCCCCC',
  '(0.000456) can0 7E8#1014 62F190 31 48 47',
  '[Req] 10 03',
  '[Resp] 50 03 00 19 01 F4',
].join('\n');

describe('udsSessionAnalyzer/shareLink', () => {
  it('round-trips trace text through encode/decode', async () => {
    const frag = await encodeShareFragment(SAMPLE);
    expect(frag.startsWith(`${__testing.FRAGMENT_KEY}=`)).toBe(true);
    const back = await decodeShareFragment(`#${frag}`);
    expect(back).toBe(SAMPLE);
  });

  it('tolerates fragment without leading #', async () => {
    const frag = await encodeShareFragment(SAMPLE);
    const back = await decodeShareFragment(frag);
    expect(back).toBe(SAMPLE);
  });

  it('returns null for missing / malformed fragments', async () => {
    expect(await decodeShareFragment('')).toBe(null);
    expect(await decodeShareFragment('#')).toBe(null);
    expect(await decodeShareFragment('#other=xyz')).toBe(null);
    expect(await decodeShareFragment('#uds=!!!not-base64!!!')).toBe(null);
  });

  it('builds a fully-qualified share URL', async () => {
    const loc = {
      origin: 'https://example.test',
      pathname: '/lab',
      search: '?tab=uds',
    };
    const url = await buildShareUrl(SAMPLE, loc);
    expect(url.startsWith('https://example.test/lab?tab=uds#uds=')).toBe(true);
  });

  it('produces a base64url-safe payload (no +, /, =)', async () => {
    const frag = await encodeShareFragment(SAMPLE.repeat(50));
    const payload = frag.split('=')[1];
    expect(payload).toBeTruthy();
    expect(/[+/=]/.test(payload)).toBe(false);
  });

  it('compresses repetitive traces below the raw size', async () => {
    const big = SAMPLE.repeat(200);
    const frag = await encodeShareFragment(big);
    const payload = frag.split('=')[1];
    expect(payload.length).toBeLessThan(big.length);
  });
});

describe('udsSessionAnalyzer/shareLink VIN scrubbing', () => {
  it('findVinsInText returns empty for VIN-free traces', () => {
    expect(findVinsInText(SAMPLE)).toEqual([]);
    expect(findVinsInText('')).toEqual([]);
    expect(findVinsInText(null)).toEqual([]);
  });

  it('findVinsInText finds a single check-digit-valid VIN', () => {
    const trace = `[Resp] 62 F1 90 ${VIN_A}`;
    expect(findVinsInText(trace)).toEqual([VIN_A]);
  });

  it('findVinsInText deduplicates and preserves first-seen order', () => {
    const trace = `${VIN_B}\nfoo ${VIN_A} bar\nagain ${VIN_B}`;
    expect(findVinsInText(trace)).toEqual([VIN_B, VIN_A]);
  });

  it('findVinsInText ignores 17-char runs whose check digit fails', () => {
    // Mutate VIN_A's check digit so the weighted sum no longer matches.
    const bad = VIN_A.slice(0, 8) + (VIN_A[8] === 'A' ? 'B' : 'A') + VIN_A.slice(9);
    expect(findVinsInText(`hello ${bad} world`)).toEqual([]);
  });

  it('findVinsInText ignores VIN-shaped runs embedded in longer alphanumeric blobs', () => {
    // A leading/trailing VIN char should suppress the match — otherwise hex
    // dumps with adjacent payload bytes would emit spurious VIN candidates.
    expect(findVinsInText(`X${VIN_A}`)).toEqual([]);
    expect(findVinsInText(`${VIN_A}9`)).toEqual([]);
  });

  it('findVinsInText is case-insensitive', () => {
    expect(findVinsInText(`vin: ${VIN_A.toLowerCase()}`)).toEqual([VIN_A]);
  });

  it('scrubVinsFromText replaces every VIN with the 17-char placeholder', () => {
    const trace = `[Req] 22 F1 90\n[Resp] 62 F1 90 ${VIN_A}\n[Resp] 62 F1 90 ${VIN_B}`;
    const out = scrubVinsFromText(trace);
    expect(out).not.toContain(VIN_A);
    expect(out).not.toContain(VIN_B);
    expect(out.match(new RegExp(VIN_PLACEHOLDER, 'g')).length).toBe(2);
    expect(VIN_PLACEHOLDER.length).toBe(17);
  });

  it('scrubVinsFromText is a no-op when no VINs are present', () => {
    expect(scrubVinsFromText(SAMPLE)).toBe(SAMPLE);
  });

  it('scrubbed text is not re-detected as a real VIN on a second pass', () => {
    // The placeholder uses VIN-illegal `I` characters so re-scanning a
    // previously-scrubbed trace does not surface the placeholder itself
    // as a fresh "real VIN detected" hit.
    const trace = `[Resp] 62 F1 90 ${VIN_A}\n[Resp] 62 F1 90 ${VIN_B}`;
    const scrubbed = scrubVinsFromText(trace);
    expect(findVinsInText(scrubbed)).toEqual([]);
  });

  it('share-link round-trip carries the scrubbed text through unchanged', async () => {
    const trace = `[Resp] 62 F1 90 ${VIN_A}`;
    const scrubbed = scrubVinsFromText(trace);
    const frag = await encodeShareFragment(scrubbed);
    const back = await decodeShareFragment(`#${frag}`);
    expect(back).toBe(scrubbed);
    expect(back).not.toContain(VIN_A);
  });
});
