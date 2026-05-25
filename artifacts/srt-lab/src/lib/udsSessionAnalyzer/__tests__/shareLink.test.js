// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  encodeShareFragment,
  decodeShareFragment,
  buildShareUrl,
  __testing,
} from '../shareLink.js';

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
