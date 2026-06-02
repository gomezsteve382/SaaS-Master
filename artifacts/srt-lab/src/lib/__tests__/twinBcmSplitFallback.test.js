// Unit tests for parseBcm's 0x81xx split-record SEC16 fallback (Task #1082).
//
// When both flat mirror copies (0x40C9 / 0x40F1) are blank but the three
// 0x81xx split records carry a consistent non-blank SEC16 — a real edge case
// on virginized-then-re-paired BCMs — parseBcm must surface the split record
// as the effective SEC16 source so the BCM → PCM pairing tab can still derive
// SEC6 and unblock APPLY.

import { describe, it, expect } from 'vitest';
import { parseBcm, BCM_SEC16_SPLIT_COPIES, BCM_SEC16_OFFSETS } from '../twinBcmHelpers.js';

const SEC16 = [
  0x10, 0x0F, 0x0E, 0x0D, 0x0C, 0x0B, 0x0A, 0x09,
  0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
];
const hxb = arr => arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Blank 65 536-byte BCM (all-FF). Mirrors and splits all blank by default. */
function makeBlankBcm() {
  return new Uint8Array(65536).fill(0xFF);
}

/** Write a SEC16 into a 0x81xx split copy (inverse of the parseBcm reader). */
function writeSplitCopy(buf, copyOff, sec16) {
  for (let i = 0; i <= 6; i++)  buf[copyOff + i] = sec16[i];
  for (let i = 7; i <= 15; i++) buf[copyOff + 4 + i] = sec16[i];
}

/** Write a SEC16 into a flat mirror slot (16 raw bytes at the offset). */
function writeMirror(buf, off, sec16) {
  for (let i = 0; i < 16; i++) buf[off + i] = sec16[i];
}

describe('parseBcm — 0x81xx split-record SEC16 fallback', () => {
  it('returns sec16SplitCopies for all three 0x81xx offsets', () => {
    const bcm = parseBcm(makeBlankBcm(), 'blank.bin');
    expect(bcm.sec16SplitCopies).toHaveLength(3);
    expect(bcm.sec16SplitCopies.map(s => s.offset)).toEqual(BCM_SEC16_SPLIT_COPIES);
    expect(bcm.sec16SplitCopies.every(s => s.blank)).toBe(true);
  });

  it('blank mirrors + blank splits → no fallback, derives from Mirror 1', () => {
    const bcm = parseBcm(makeBlankBcm(), 'virgin.bin');
    expect(bcm.sec16FromSplit).toBe(false);
    expect(bcm.sec16Source).toBe('Mirror 1');
    expect(bcm.sec16SourceOffset).toBe(BCM_SEC16_OFFSETS[0]);
  });

  it('blank mirrors + populated split records → uses split fallback', () => {
    const buf = makeBlankBcm();
    for (const off of BCM_SEC16_SPLIT_COPIES) writeSplitCopy(buf, off, SEC16);
    const bcm = parseBcm(buf, 'rekeyed.bin');

    expect(bcm.sec16FromSplit).toBe(true);
    expect(bcm.sec16Source).toBe('Split 1');
    expect(bcm.sec16SourceOffset).toBe(BCM_SEC16_SPLIT_COPIES[0]);
    expect(bcm.sec16Hex).toBe(hxb(SEC16));
    // PCM SEC6 = first 6 bytes of the byte-reversed SEC16.
    expect(bcm.pcmSec6Hex).toBe(hxb([...SEC16].reverse().slice(0, 6)));
    expect(bcm.sec16SplitCopies[0].blank).toBe(false);
  });

  it('a single populated split record is enough to trigger fallback', () => {
    const buf = makeBlankBcm();
    writeSplitCopy(buf, BCM_SEC16_SPLIT_COPIES[1], SEC16);
    const bcm = parseBcm(buf, 'one-split.bin');

    expect(bcm.sec16FromSplit).toBe(true);
    expect(bcm.sec16Source).toBe('Split 2');
    expect(bcm.sec16Hex).toBe(hxb(SEC16));
  });

  it('divergent split records are refused (no fallback)', () => {
    const buf = makeBlankBcm();
    writeSplitCopy(buf, BCM_SEC16_SPLIT_COPIES[0], SEC16);
    writeSplitCopy(buf, BCM_SEC16_SPLIT_COPIES[1], [...SEC16].reverse());
    const bcm = parseBcm(buf, 'divergent.bin');

    expect(bcm.sec16FromSplit).toBe(false);
    expect(bcm.sec16Source).toBe('Mirror 1');
  });

  it('a non-blank mirror wins over split records (no fallback)', () => {
    const buf = makeBlankBcm();
    writeMirror(buf, BCM_SEC16_OFFSETS[0], SEC16);
    writeMirror(buf, BCM_SEC16_OFFSETS[1], SEC16);
    // Populate splits with a DIFFERENT value to prove mirrors take priority.
    for (const off of BCM_SEC16_SPLIT_COPIES) writeSplitCopy(buf, off, [...SEC16].reverse());
    const bcm = parseBcm(buf, 'mirror-present.bin');

    expect(bcm.sec16FromSplit).toBe(false);
    expect(bcm.sec16Source).toBe('Mirror 1');
    expect(bcm.sec16Hex).toBe(hxb(SEC16));
  });
});
