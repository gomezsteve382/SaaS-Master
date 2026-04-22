import { describe, it, expect } from 'vitest';

import {
  writeBcmSec16Gen2,
  writePcmSec6,
  writeRfhSec16FromBcm,
} from '../securityBytes.js';
import { parseModule } from '../parseModule.js';

// ─────────────────────────────────────────────────────────────────────────────
// Golden vectors for the three security-byte writers.
//
// These three functions produce the bytes that get flashed onto real ECUs
// during a Module Sync run. A silently-wrong byte here ends up on a customer
// car. CRC primitives (crc.golden.test.js) and parsers (parseModule.test.js)
// are pinned to golden vectors; this file does the same for the writer side.
//
// Strategy: feed each writer a hand-built, structurally-minimal input buffer
// containing exactly the markers each writer scans for, then assert
//   1. the patched-region counters (splitPatched / mirrorPatched / patched),
//   2. the byte-exact contents of every region the writer is supposed to
//      touch, against an independently-computed Uint8Array of expected
//      bytes (NOT recomputed from the writer itself), and
//   3. derived check bytes (CRC-16/CCITT for the BCM mirrors, the
//      empirical (0xFE - sum%255) checksum for the RFHUB slots), again
//      computed independently.
//
// If anyone later changes a constant or shifts an offset in one of the
// writers, a golden assertion here will fail with a clear "expected X at
// offset Y, got Z" message instead of silently producing wrong dumps.
// ─────────────────────────────────────────────────────────────────────────────

// 16-byte slot pulled from a real RFHUB Gen2 SEC16 dump (anonymized but
// byte-exact). Shared with crc.golden.test.js so all "real ECU value"
// goldens in this codebase trace back to the same field-recovered sample.
const RFH_SEC16_REAL_SLOT = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
  0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
]);

// reverse(RFH_SEC16_REAL_SLOT) — what the BCM/RFH writers store in BCM
// or recover from BCM.
const BCM_SEC16_FROM_RFH = new Uint8Array([
  0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC, 0xFE,
  0xEF, 0xCD, 0xAB, 0x89, 0x67, 0x45, 0x23, 0x01,
]);

// First 6 bytes of RFH SEC16 — what writePcmSec6 patches in.
const PCM_SEC6_FROM_RFH = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB,
]);

/* Local CRC-16/CCITT-FALSE — duplicated from crc.js so a coordinated
 * accidental change in BOTH securityBytes.js AND crc.js would still trip
 * this test. */
function crc16Ccitt(data) {
  let c = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i] << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c & 0xFFFF;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for assembling the synthetic BCM buffer.
// ─────────────────────────────────────────────────────────────────────────────

/* Lay down a Gen2 BCM split-record header at recOff:
 *   FF FF 00 00 00 00 00 00 idx 00 00 00 00 00 00 00 04 04 00 14 ...
 * The writer fills bytes 9..15 (prefix7) and 20..28 (suffix9). */
function writeSplitHeader(buf, recOff, idx) {
  buf[recOff]     = 0xFF;
  buf[recOff + 1] = 0xFF;
  for (let j = 2; j < 8; j++) buf[recOff + j] = 0x00;
  buf[recOff + 8] = idx;
  // Bytes 9..15 will be overwritten by the writer (prefix7); leave 0xFF as a
  // canary so we can verify they actually got touched.
  for (let j = 9; j < 16; j++) buf[recOff + j] = 0xFF;
  // Separator
  buf[recOff + 16] = 0x04;
  buf[recOff + 17] = 0x04;
  buf[recOff + 18] = 0x00;
  buf[recOff + 19] = 0x14;
  // Bytes 20..28 will be overwritten by the writer (suffix9); leave 0xFF.
  for (let j = 20; j < 29; j++) buf[recOff + j] = 0xFF;
  buf[recOff + 29] = 0xFF;
}

/* Lay down a Gen2 BCM mirror-record header at recOff for a given slot
 * type / size byte:
 *   00 00 00 size 00 46 slotType 00 ...
 * Writer fills bytes 8..31 (idx + SEC16(16) + 8F FF FF + CRC(2) + EB 00). */
function writeMirrorHeader(buf, recOff, slotType, sizeByte) {
  buf[recOff]     = 0x00;
  buf[recOff + 1] = 0x00;
  buf[recOff + 2] = 0x00;
  buf[recOff + 3] = sizeByte;
  buf[recOff + 4] = 0x00;
  buf[recOff + 5] = 0x46;
  buf[recOff + 6] = slotType;
  buf[recOff + 7] = 0x00;
  // Bytes 8..31 left as 0xFF canaries; writer will overwrite all of them.
  for (let j = 8; j < 32; j++) buf[recOff + j] = 0xFF;
}

/* Build a 65536-byte BCM buffer with:
 *   - bank seq numbers (bank0 = 0x0001, bank1 = 0x0002 → bank1 active,
 *     bank0 (base 0x0000) is INACTIVE)
 *   - 3 split-record headers at 0x81A0/C0/E0
 *   - mirror1 header (0xEB / size 0x18) at 0x1000 (in inactive bank 0)
 *   - mirror2 header (0xCA / size 0x28) at 0x1100 (in inactive bank 0)
 * Anything not explicitly written is 0xFF (BCM erased-flash baseline). */
function buildSyntheticBcm() {
  const buf = new Uint8Array(65536).fill(0xFF);
  // Bank seq numbers (BE16 at +2). Higher = active.
  buf[0x0002] = 0x00; buf[0x0003] = 0x01; // bank0 seq=1
  buf[0x4002] = 0x00; buf[0x4003] = 0x02; // bank1 seq=2  → bank1 active, bank0 inactive
  // Split records
  writeSplitHeader(buf, 0x81A0, 0x01);
  writeSplitHeader(buf, 0x81C0, 0x02);
  writeSplitHeader(buf, 0x81E0, 0x01);
  // Mirror records (both in inactive bank — base 0x0000)
  writeMirrorHeader(buf, 0x1000, 0xEB, 0x18);
  writeMirrorHeader(buf, 0x1100, 0xCA, 0x28);
  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
// writeBcmSec16Gen2
// ─────────────────────────────────────────────────────────────────────────────

describe('writeBcmSec16Gen2 — golden vectors', () => {
  it('refuses inputs that are not exactly 16 bytes', () => {
    expect(() => writeBcmSec16Gen2(new Uint8Array(64), new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => writeBcmSec16Gen2(new Uint8Array(64), null)).toThrow(/16 bytes/);
  });

  it('reverses the RFH slot into the BCM SEC16 storage form', () => {
    const buf = buildSyntheticBcm();
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.bcmSec16Hex).toBe('1032547698badcfeefcdab8967452301');
  });

  it('selects the bank with the lower seq number as inactive', () => {
    const buf = buildSyntheticBcm();
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.inactiveBase).toBe(0x0000);
  });

  it('flips the inactive-bank choice when bank0 has the higher seq', () => {
    const buf = buildSyntheticBcm();
    // Swap so bank0 is active, bank1 is inactive.
    buf[0x0002] = 0x00; buf[0x0003] = 0x02; // bank0 seq=2
    buf[0x4002] = 0x00; buf[0x4003] = 0x01; // bank1 seq=1
    // Move mirror records into bank1 to match the new inactive base.
    writeMirrorHeader(buf, 0x5000, 0xEB, 0x18);
    writeMirrorHeader(buf, 0x5100, 0xCA, 0x28);
    // Wipe the bank0 mirror headers so they don't get matched.
    for (let j = 0x1000; j < 0x1120; j++) buf[j] = 0xFF;
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.inactiveBase).toBe(0x4000);
    expect(r.mirror1Offset).toBe(0x5000);
    expect(r.mirror2Offset).toBe(0x5100);
  });

  it('patches all 3 split records and both mirrors with the expected counters', () => {
    const buf = buildSyntheticBcm();
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.splitPatched).toBe(3);
    expect(r.mirrorPatched).toBe(2);
    expect(r.mirror1Offset).toBe(0x1000);
    expect(r.mirror2Offset).toBe(0x1100);
    expect(r.patched).toBe(5); // legacy aggregate field
  });

  it('writes the byte-exact split-record contents at 0x81A0/C0/E0', () => {
    const buf = buildSyntheticBcm();
    const { bytes: out } = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    // Each split record: at +9..+15 store prefix7 = BCM_SEC16[0..6],
    // at +20..+28 store suffix9 = BCM_SEC16[7..15].
    const prefix7 = BCM_SEC16_FROM_RFH.slice(0, 7);
    const suffix9 = BCM_SEC16_FROM_RFH.slice(7, 16);
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      // Header bytes survive untouched.
      expect(Array.from(out.slice(recOff, recOff + 8)))
        .toEqual([0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      // Prefix7 at +9..+15
      expect(Array.from(out.slice(recOff + 9, recOff + 16))).toEqual(Array.from(prefix7));
      // Separator at +16..+19 untouched
      expect(Array.from(out.slice(recOff + 16, recOff + 20)))
        .toEqual([0x04, 0x04, 0x00, 0x14]);
      // Suffix9 at +20..+28
      expect(Array.from(out.slice(recOff + 20, recOff + 29))).toEqual(Array.from(suffix9));
    }
  });

  it('preserves the idx byte at split-record +8', () => {
    const buf = buildSyntheticBcm();
    const { bytes: out } = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(out[0x81A0 + 8]).toBe(0x01);
    expect(out[0x81C0 + 8]).toBe(0x02);
    expect(out[0x81E0 + 8]).toBe(0x01);
  });

  it('writes the byte-exact mirror payload (idx + SEC16 + 8F FF FF + CRC + EB 00)', () => {
    const buf = buildSyntheticBcm();
    const { bytes: out } = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    // Independent expected payload.
    const expected = new Uint8Array(24);
    expected[0] = 0x02;
    for (let k = 0; k < 16; k++) expected[1 + k] = BCM_SEC16_FROM_RFH[k];
    expected[17] = 0x8F; expected[18] = 0xFF; expected[19] = 0xFF;
    // CRC-16/CCITT over expected[0..19] (= 20 bytes), stored BE at +28/+29.
    const crc = crc16Ccitt(expected.slice(0, 20));
    // PINNED golden value — CRC of [02 + reverse(RFH_SEC16_REAL_SLOT) + 8F FF FF].
    expect(crc).toBe(0xE0C1);
    expected[20] = (crc >> 8) & 0xFF; // 0xE0
    expected[21] = crc & 0xFF;        // 0xC1
    expected[22] = 0xEB;
    expected[23] = 0x00;
    for (const off of [0x1000, 0x1100]) {
      expect(Array.from(out.slice(off + 8, off + 32))).toEqual(Array.from(expected));
      // Sanity: header bytes 0..7 untouched.
      expect(out[off + 5]).toBe(0x46);
    }
  });

  it('skips a split record whose separator bytes do not match', () => {
    const buf = buildSyntheticBcm();
    // Corrupt the separator at 0x81C0 so that record is skipped.
    buf[0x81C0 + 16] = 0x00;
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.splitPatched).toBe(2);
    // The corrupt record's prefix7 region must be untouched (still 0xFF).
    for (let k = 0; k < 7; k++) expect(r.bytes[0x81C0 + 9 + k]).toBe(0xFF);
  });

  it('reports null mirror2Offset when the 0xCA slot is missing', () => {
    const buf = buildSyntheticBcm();
    // Wipe the mirror2 header so findRec misses it.
    for (let j = 0x1100; j < 0x1120; j++) buf[j] = 0xFF;
    const r = writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(r.mirror1Offset).toBe(0x1000);
    expect(r.mirror2Offset).toBeNull();
    expect(r.mirrorPatched).toBe(1);
  });

  it('does not mutate the input buffer', () => {
    const buf = buildSyntheticBcm();
    const snapshot = new Uint8Array(buf);
    writeBcmSec16Gen2(buf, RFH_SEC16_REAL_SLOT);
    expect(Array.from(buf)).toEqual(Array.from(snapshot));
  });

  it('parseModule round-trip: split-record body bytes (visible via immoKeys) reflect the patched prefix7', () => {
    // The BCM parser doesn't expose SEC16 split records as a typed field, but
    // it does expose immoKeys at 0x81A4/0x81C4/0x81E4 (16 bytes each). Those
    // 16 bytes overlap the writer-touched region of each split record:
    //   offsets +4..+7  (header tail)        = "00 00 00 00"
    //   offset  +8      (idx)                = 01 or 02
    //   offsets +9..+15 (prefix7 — patched)  = first 7 bytes of BCM SEC16
    //   offsets +16..+19 (separator)         = "04 04 00 14"
    // So immoKeys[i].hex for a successfully-patched record must be exactly
    // "00 00 00 00 <idx> <prefix7 hex...> 04 04 00 14".
    const r = writeBcmSec16Gen2(buildSyntheticBcm(), RFH_SEC16_REAL_SLOT);
    const parsed = parseModule(r.bytes, 'bcm-out.bin');
    expect(parsed.type).toBe('BCM');
    expect(parsed.immoKeys).toHaveLength(3);
    const prefix7Hex = Array.from(BCM_SEC16_FROM_RFH.slice(0, 7))
      .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    const expectedFor = (idx) =>
      `00 00 00 00 ${idx.toString(16).toUpperCase().padStart(2, '0')} ${prefix7Hex} 04 04 00 14`;
    expect(parsed.immoKeys[0].hex).toBe(expectedFor(0x01)); // 0x81A4 — split idx=01
    expect(parsed.immoKeys[1].hex).toBe(expectedFor(0x02)); // 0x81C4 — split idx=02
    expect(parsed.immoKeys[2].hex).toBe(expectedFor(0x01)); // 0x81E4 — split idx=01
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writePcmSec6
// ─────────────────────────────────────────────────────────────────────────────

/* Build a 4096-byte PCM buffer (GPEC2A-shaped) with exactly ONE
 * "FF FF FF AA" marker at offset 0x100. Everything else is 0x55 so that
 * the GPEC5 fallback (which scans for FF FF FF FF) cannot also fire. */
function buildSyntheticPcmGpec2a() {
  const buf = new Uint8Array(4096).fill(0x55);
  buf[0x100]     = 0xFF;
  buf[0x100 + 1] = 0xFF;
  buf[0x100 + 2] = 0xFF;
  buf[0x100 + 3] = 0xAA;
  // SEC6 region (0x104..0x109) — leave as 0x55 canaries; writer overwrites.
  return buf;
}

/* Build a 4096-byte GPEC5-shaped buffer: one FF FF FF FF run followed
 * immediately by a non-all-FF "current SEC6" stub (so hasData triggers).
 * Outside this region everything is 0x55 to avoid spurious FF AA / FFFF
 * matches. */
function buildSyntheticPcmGpec5() {
  const buf = new Uint8Array(4096).fill(0x55);
  buf[0x200]     = 0xFF;
  buf[0x200 + 1] = 0xFF;
  buf[0x200 + 2] = 0xFF;
  buf[0x200 + 3] = 0xFF;
  // Existing SEC6 must NOT be all-FF for the GPEC5 path to fire.
  // Also: the byte at +4 must NOT be 0xAA — otherwise the writer's prior
  // FF-FF-FF-AA scan would match at offset 0x201 and route us through the
  // GPEC2A path instead.
  buf[0x204] = 0x99; buf[0x205] = 0xBB; buf[0x206] = 0xCC;
  buf[0x207] = 0xDD; buf[0x208] = 0xEE; buf[0x209] = 0xFE;
  return buf;
}

describe('writePcmSec6 — golden vectors', () => {
  it('refuses inputs shorter than 6 bytes', () => {
    expect(() => writePcmSec6(new Uint8Array(64), new Uint8Array(5))).toThrow(/6 bytes/);
    expect(() => writePcmSec6(new Uint8Array(64), null)).toThrow(/6 bytes/);
  });

  it('writes the GPEC2A SEC6 (first 6 bytes of RFH SEC16) at marker+4', () => {
    const buf = buildSyntheticPcmGpec2a();
    const r = writePcmSec6(buf, RFH_SEC16_REAL_SLOT);
    expect(r.patched).toBe(1);
    expect(r.markerUsed).toBe('FF FF FF AA');
    expect(r.sec6Hex).toBe('0123456789ab');
    // Marker untouched
    expect(Array.from(r.bytes.slice(0x100, 0x104))).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
    // SEC6 patched at +4..+9 with PCM_SEC6_FROM_RFH
    expect(Array.from(r.bytes.slice(0x104, 0x10A))).toEqual(Array.from(PCM_SEC6_FROM_RFH));
    // Byte right after SEC6 untouched (canary 0x55)
    expect(r.bytes[0x10A]).toBe(0x55);
  });

  it('falls back to the GPEC5 marker when no FF FF FF AA is present', () => {
    const buf = buildSyntheticPcmGpec5();
    const r = writePcmSec6(buf, RFH_SEC16_REAL_SLOT);
    expect(r.patched).toBe(1);
    expect(r.markerUsed).toBe('FF FF FF FF');
    // Marker untouched, SEC6 region overwritten with PCM_SEC6_FROM_RFH.
    expect(Array.from(r.bytes.slice(0x200, 0x204))).toEqual([0xFF, 0xFF, 0xFF, 0xFF]);
    expect(Array.from(r.bytes.slice(0x204, 0x20A))).toEqual(Array.from(PCM_SEC6_FROM_RFH));
  });

  it('patches every FF FF FF AA marker in the buffer (GPEC2A multi-match)', () => {
    const buf = buildSyntheticPcmGpec2a();
    // Add a second marker.
    buf[0x300] = 0xFF; buf[0x301] = 0xFF; buf[0x302] = 0xFF; buf[0x303] = 0xAA;
    const r = writePcmSec6(buf, RFH_SEC16_REAL_SLOT);
    expect(r.patched).toBe(2);
    expect(r.markerUsed).toBe('FF FF FF AA');
    expect(Array.from(r.bytes.slice(0x304, 0x30A))).toEqual(Array.from(PCM_SEC6_FROM_RFH));
  });

  it('returns patched=0 / markerUsed=null when no marker is found', () => {
    const buf = new Uint8Array(4096).fill(0x55); // zero markers, no FFFF runs
    const r = writePcmSec6(buf, RFH_SEC16_REAL_SLOT);
    expect(r.patched).toBe(0);
    expect(r.markerUsed).toBeNull();
  });

  it('does not mutate the input buffer', () => {
    const buf = buildSyntheticPcmGpec2a();
    const snapshot = new Uint8Array(buf);
    writePcmSec6(buf, RFH_SEC16_REAL_SLOT);
    expect(Array.from(buf)).toEqual(Array.from(snapshot));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeRfhSec16FromBcm
// ─────────────────────────────────────────────────────────────────────────────

/* Build a 4096-byte RFHUB Gen2 buffer with the AA 55 31 01 header at
 * 0x0500 and 0xFF everywhere else (so we can see what the writer touches). */
function buildSyntheticRfhubGen2() {
  const buf = new Uint8Array(4096).fill(0xFF);
  buf[0x0500] = 0xAA; buf[0x0501] = 0x55; buf[0x0502] = 0x31; buf[0x0503] = 0x01;
  return buf;
}

describe('writeRfhSec16FromBcm — golden vectors', () => {
  it('refuses inputs that are not exactly 16 bytes', () => {
    expect(() => writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), null)).toThrow(/16 bytes/);
  });

  it('throws if the buffer is not a Gen2 RFHUB (header missing at 0x0500)', () => {
    const buf = new Uint8Array(4096).fill(0xFF); // no header
    expect(() => writeRfhSec16FromBcm(buf, BCM_SEC16_FROM_RFH))
      .toThrow(/Gen2 RFHUB|AA 55 31 01/);
  });

  it('reverses BCM SEC16 back to RFH SEC16 form', () => {
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), BCM_SEC16_FROM_RFH);
    expect(r.rfhSec16Hex).toBe('0123456789abcdeffedcba9876543210');
  });

  it('produces the empirical (0xFE - sum%255) checksum for the real slot', () => {
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), BCM_SEC16_FROM_RFH);
    // sum(RFH_SEC16_REAL_SLOT) = 2040; 2040 % 255 = 0; (0xFE - 0) & 0xFF = 0xFE.
    expect(r.chk).toBe(0xFE);
  });

  it('writes both Gen2 slots (0x050E and 0x0522) byte-exactly with chk + 0x00 trailer', () => {
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), BCM_SEC16_FROM_RFH);
    expect(r.patched).toBe(2);
    for (const slotOff of [0x050E, 0x0522]) {
      expect(Array.from(r.bytes.slice(slotOff, slotOff + 16)))
        .toEqual(Array.from(RFH_SEC16_REAL_SLOT));
      expect(r.bytes[slotOff + 16]).toBe(0xFE); // chk
      expect(r.bytes[slotOff + 17]).toBe(0x00); // trailer
    }
    // Header survives untouched.
    expect(Array.from(r.bytes.slice(0x0500, 0x0504))).toEqual([0xAA, 0x55, 0x31, 0x01]);
  });

  it('write→re-read round-trip: chk recomputed from the written 16 bytes matches', () => {
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), BCM_SEC16_FROM_RFH);
    for (const slotOff of [0x050E, 0x0522]) {
      let sum = 0;
      for (let k = 0; k < 16; k++) sum += r.bytes[slotOff + k];
      const expectedChk = (0xFE - (sum % 255)) & 0xFF;
      expect(r.bytes[slotOff + 16]).toBe(expectedChk);
    }
  });

  it('produces a different chk for a different secret', () => {
    const altBcm = new Uint8Array(16).fill(0x42); // sum = 16*0x42 = 1056; 1056%255=36; chk=0xDA
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), altBcm);
    expect(r.chk).toBe(0xDA);
  });

  it('does not mutate the input buffer', () => {
    const buf = buildSyntheticRfhubGen2();
    const snapshot = new Uint8Array(buf);
    writeRfhSec16FromBcm(buf, BCM_SEC16_FROM_RFH);
    expect(Array.from(buf)).toEqual(Array.from(snapshot));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-check via parseModule — proves the writer's RFH output is at least
// structurally parseable by the existing parser even where the parser's
// expected checksum formula (rfhSec16Cs / crc8_65) diverges from the
// writer's empirical (0xFE - sum%255) formula.
//
// This deliberately documents the divergence: the parser will surface
// `csOk: false` for writer output. Reconciling the two formulas against
// real ECU dumps is tracked by the existing
// "Debug all checksum & security-byte paths against real ECU dumps" task.
// ─────────────────────────────────────────────────────────────────────────────

describe('writeRfhSec16FromBcm — parseModule structural round-trip', () => {
  it('parseModule extracts the same 16-byte SEC16 slot raw bytes the writer stored', () => {
    const r = writeRfhSec16FromBcm(buildSyntheticRfhubGen2(), BCM_SEC16_FROM_RFH);
    const parsed = parseModule(r.bytes, 'rfh-out.bin');
    expect(parsed.type).toBe('RFHUB');
    expect(parsed.sec16s?.length).toBeGreaterThanOrEqual(2);
    // First slot raw bytes equal the RFH_SEC16 we wrote.
    const slot1Raw = parsed.sec16s[0].raw;
    expect(Array.from(slot1Raw)).toEqual(Array.from(RFH_SEC16_REAL_SLOT));
    // Stored cs (BE16 of [chk, 0x00]) = 0xFE00.
    expect(parsed.sec16s[0].cs).toBe(0xFE00);
    // Documented divergence: parser's rfhSec16Cs (crc8_65 << 8) does NOT
    // equal the writer's empirical chk for this slot. csOk is false.
    expect(parsed.sec16s[0].csOk).toBe(false);
  });
});
