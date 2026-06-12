import { describe, it, expect } from 'vitest';
import { scanChecksums, fixChecksum } from '../checksumScanner.js';

/* The scanner is heuristic: on any file with enough probes it will throw off a
 * few COINCIDENTAL sum8 "valid" hits (1/256 per probe) that aren't real ECU
 * checksums and relocate when unrelated bytes change. These must be tagged
 * confidence:"low" so the UI / export flow never prompts a user to "repair" a
 * coincidence (which would diverge a file from the real tool's output — e.g. a
 * GPEC2A immo sync, which provably needs NO checksum). Width-2/4 matches
 * (crc16/crc32/sum16/sum32) are statistically real → "high". */

describe('scanChecksums — confidence tagging filters coincidental hits', () => {
  it('every entry carries a confidence + coincidental field', () => {
    const buf = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) buf[i] = (i * 11 + 5) & 0xff;
    for (const e of scanChecksums(buf)) {
      expect(['high', 'medium', 'low']).toContain(e.confidence);
      expect(typeof e.coincidental).toBe('boolean');
      expect(e.coincidental).toBe(e.confidence === 'low');
    }
  });

  it('a REAL crc16 checksum is detected as confidence:"high"', () => {
    let buf = new Uint8Array(512);
    for (let i = 0; i < 510; i++) buf[i] = (i * 7 + 3) & 0xff;
    buf = fixChecksum(buf, 0x1FE, 'crc16', 0); // genuine crc16 over [0,0x1FE)
    const hit = scanChecksums(buf).find((e) => e.algorithm === 'crc16' && e.status === 'valid');
    expect(hit).toBeTruthy();
    expect(hit.confidence).toBe('high');
    expect(hit.coincidental).toBe(false);
  });

  it('a coincidental sum8 match at a non-structural offset is "low"/coincidental', () => {
    const n = 4096;                       // step = max(2, floor(4096/400)) = 10 → probes at 4,14,24,…
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 13 + 7) & 0xff;
    const P = 504;                        // a probed, non-structural offset (4 + 10*50)
    let s = 0; for (let i = 0; i < P; i++) s = (s + buf[i]) & 0xff;
    buf[P] = s;                           // sum8([0,P)) === buf[P] → coincidental valid sum8
    const hit = scanChecksums(buf).find((e) => e.algorithm === 'sum8' && e.offset === '0x' + P.toString(16));
    expect(hit, 'expected the planted sum8 coincidence to be surfaced').toBeTruthy();
    expect(hit.confidence).toBe('low');
    expect(hit.coincidental).toBe(true);
  });

  it('invariant: every width≥2 valid hit is high, no width-1 valid hit is high', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) buf[i] = (i * 29 + 1) & 0xff;
    for (const e of scanChecksums(buf)) {
      if (e.width >= 2 && e.status === 'valid') expect(e.confidence).toBe('high');
      if (e.width === 1 && e.status === 'valid') expect(e.confidence).not.toBe('high');
    }
  });
});
