// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  encodeShareFragment,
  decodeShareFragment,
  buildShareUrl,
  findVinsInText,
  scrubVinsFromText,
  findSensitiveInText,
  hasSensitiveFindings,
  scrubSensitiveFromText,
  SENSITIVE_CATEGORY_LABELS,
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

describe('udsSessionAnalyzer/shareLink sensitive scan (Task #756)', () => {
  it('exposes a stable category label map for the confirm dialog', () => {
    expect(SENSITIVE_CATEGORY_LABELS).toMatchObject({
      vins: expect.any(String),
      seeds: expect.any(String),
      keys: expect.any(String),
      ecuSerials: expect.any(String),
      calibrationIds: expect.any(String),
      pins: expect.any(String),
    });
  });

  it('returns empty buckets for an empty / VIN-free / UDS-free trace', () => {
    const f = findSensitiveInText('');
    expect(f.vins).toEqual([]);
    expect(f.seeds).toEqual([]);
    expect(f.keys).toEqual([]);
    expect(f.ecuSerials).toEqual([]);
    expect(f.calibrationIds).toEqual([]);
    expect(f.pins).toEqual([]);
    expect(hasSensitiveFindings(f)).toBe(false);
  });

  it('detects SecurityAccess seed in a positive 0x67 response (odd SF)', () => {
    const trace = '[Resp] 67 01 11 22 33 44';
    const f = findSensitiveInText(trace);
    expect(f.seeds).toHaveLength(1);
    expect(f.seeds[0].subFunction).toBe(0x01);
    expect(f.seeds[0].bytesHex).toBe('11 22 33 44');
    expect(hasSensitiveFindings(f)).toBe(true);
  });

  it('detects SecurityAccess key in a 0x27 request (even non-zero SF)', () => {
    const trace = '[Req] 27 02 AA BB CC DD';
    const f = findSensitiveInText(trace);
    expect(f.keys).toHaveLength(1);
    expect(f.keys[0].subFunction).toBe(0x02);
    expect(f.keys[0].bytesHex).toBe('AA BB CC DD');
  });

  it('does not flag SecurityAccess seed requests (0x27 odd SF, no key bytes)', () => {
    const f = findSensitiveInText('[Req] 27 01');
    expect(f.seeds).toEqual([]);
    expect(f.keys).toEqual([]);
  });

  it('detects ECU hardware serial (62 F1 8C ...)', () => {
    const trace = '[Resp] 62 F1 8C 31 32 33 34 35 36';
    const f = findSensitiveInText(trace);
    expect(f.ecuSerials).toHaveLength(1);
    expect(f.ecuSerials[0].bytesHex).toBe('31 32 33 34 35 36');
  });

  it('detects calibration ID (62 F1 95 ...)', () => {
    const trace = '[Resp] 62 F1 95 41 42 43 44';
    const f = findSensitiveInText(trace);
    expect(f.calibrationIds).toHaveLength(1);
    expect(f.calibrationIds[0].bytesHex).toBe('41 42 43 44');
  });

  it('detects 4–6 digit ASCII PIN runs inside known DID responses', () => {
    // F1 8C carries ASCII '1234' which is a PIN-shaped run; it is also
    // surfaced as an ECU serial (the byte sequence is the same).
    const trace = '[Resp] 62 F1 8C 31 32 33 34';
    const f = findSensitiveInText(trace);
    expect(f.pins).toHaveLength(1);
    expect(f.pins[0].digits).toBe('1234');
    expect(f.pins[0].didLabel).toBe('0xF18C');
  });

  it('ignores digit runs of length 7+ and length <4 (boundary)', () => {
    // 3-digit run (too short), 7-digit run (too long) — both rejected.
    const trace = '[Resp] 62 F1 8C 31 32 33 41 31 32 33 34 35 36 37';
    const f = findSensitiveInText(trace);
    expect(f.pins).toEqual([]);
  });

  it('detects sensitive payloads in candump-shape ISO-TP single frames', () => {
    // Packed hex after `#`: PCI 05 (SF len 5) + 67 01 AA BB CC.
    // After PCI strip the payload is `67 01 AA BB CC`.
    const trace = '(0.001) can0 7E8#0567 01 AA BB CC';
    // The candump regex requires packed hex with no whitespace after `#`,
    // so build it as one contiguous run.
    const packed = '(0.001) can0 7E8#0567 01 AA BB CC'.replace(/#.*/, '#' + '0567 01 AA BB CC'.replace(/\s+/g, ''));
    const f = findSensitiveInText(packed);
    expect(f.seeds).toHaveLength(1);
    expect(f.seeds[0].subFunction).toBe(0x01);
    expect(f.seeds[0].bytesHex).toBe('AA BB CC');
    // Reference `trace` so lint stays happy and intent is visible.
    expect(trace).toContain('67 01 AA BB CC');
  });

  it('scrubSensitiveFromText replaces seed bytes with ?? of the same width', () => {
    const trace = '[Resp] 67 01 11 22 33 44';
    const out = scrubSensitiveFromText(trace);
    expect(out).toBe('[Resp] 67 01 ?? ?? ?? ??');
    expect(findSensitiveInText(out).seeds).toEqual([]);
  });

  it('scrubSensitiveFromText replaces key bytes', () => {
    const trace = '[Req] 27 02 AA BB CC DD';
    const out = scrubSensitiveFromText(trace);
    expect(out).toBe('[Req] 27 02 ?? ?? ?? ??');
    expect(findSensitiveInText(out).keys).toEqual([]);
  });

  it('scrubSensitiveFromText replaces F1 8C / F1 95 data bytes', () => {
    const trace = [
      '[Resp] 62 F1 8C 31 32 33 34 35 36',
      '[Resp] 62 F1 95 41 42 43 44',
    ].join('\n');
    const out = scrubSensitiveFromText(trace);
    expect(out).toContain('62 F1 8C ?? ?? ?? ?? ?? ??');
    expect(out).toContain('62 F1 95 ?? ?? ?? ??');
    const reFind = findSensitiveInText(out);
    expect(reFind.ecuSerials).toEqual([]);
    expect(reFind.calibrationIds).toEqual([]);
    expect(reFind.pins).toEqual([]);
  });

  it('scrubSensitiveFromText composes with VIN scrubbing', () => {
    const trace = `${VIN_A}\n[Resp] 67 01 AA BB CC`;
    const out = scrubSensitiveFromText(trace);
    expect(out).not.toContain(VIN_A);
    expect(out).toContain(VIN_PLACEHOLDER);
    expect(out).toContain('67 01 ?? ?? ??');
  });

  it('scrubSensitiveFromText preserves candump packed-hex formatting', () => {
    // candump packs all bytes after `#` with no separators; the rewrite
    // must preserve that packing rather than insert spaces.
    const trace = '(0.001) can0 7E8#0567 01 AA BB CC'.replace(/#.*/, '#0567 01 AA BB CC'.replace(/\s+/g, ''));
    const out = scrubSensitiveFromText(trace);
    expect(out).toContain('6701??????');
  });

  it('scrubbed output is share-link round-trip safe', async () => {
    const trace = '[Resp] 67 01 11 22 33 44';
    const scrubbed = scrubSensitiveFromText(trace);
    const frag = await encodeShareFragment(scrubbed);
    const back = await decodeShareFragment(`#${frag}`);
    expect(back).toBe(scrubbed);
  });

  it('handles a mixed-category trace and reports every category', () => {
    const trace = [
      `[Req] 22 F1 90`,
      `[Resp] 62 F1 90 ${VIN_A}`,
      `[Req] 27 01`,
      `[Resp] 67 01 DE AD BE EF`,
      `[Req] 27 02 12 34 56 78`,
      `[Resp] 62 F1 8C 53 4E 30 31 32 33`,
      `[Resp] 62 F1 95 43 41 4C 49 42`,
    ].join('\n');
    const f = findSensitiveInText(trace);
    expect(f.vins).toEqual([VIN_A]);
    expect(f.seeds).toHaveLength(1);
    expect(f.keys).toHaveLength(1);
    expect(f.ecuSerials).toHaveLength(1);
    expect(f.calibrationIds).toHaveLength(1);
    // F1 8C data has '0123' as a 4-digit run; F1 95 data is all letters.
    expect(f.pins).toHaveLength(1);
    expect(f.pins[0].digits).toBe('0123');
    expect(hasSensitiveFindings(f)).toBe(true);
  });
});
