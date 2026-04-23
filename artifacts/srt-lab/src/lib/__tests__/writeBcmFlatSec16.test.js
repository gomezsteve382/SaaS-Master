/**
 * Task #382 — writeBcmFlatSec16 helper tests.
 *
 * The repair helper takes a resolved (canonical / big-endian) SEC16 and
 * writes its little-endian byte-reversed form into the legacy flat slice
 * at 0x40C9..0x40D8. Live split records (0x81A0/C0/E0) and inactive-bank
 * mirror records (slot 0xEB / 0xCA) MUST be left untouched — that is the
 * whole reason this helper exists instead of just calling
 * writeBcmSec16Gen2 again.
 */
import { describe, it, expect } from 'vitest';
import { writeBcmFlatSec16 } from '../securityBytes.js';
import { resolveBcmSec16 } from '../parseModule.js';

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* Synthesize a 64 KB BCM with split records + mirror1 + mirror2 populated
 * with `sec16` and the flat slice at 0x40C9 holding garbage (so we can
 * prove it gets repaired and nothing else moves). */
function makeFixtureBcm(sec16) {
  const buf = new Uint8Array(65536).fill(0xFF);
  // FEE seqs — bank0 active (higher), so inactive bank = 0x4000.
  buf[0x0002] = 0x09; buf[0x0003] = 0xFB;
  buf[0x4002] = 0x09; buf[0x4003] = 0xFA;
  // Split records
  for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
    buf[recOff] = 0xFF; buf[recOff + 1] = 0xFF;
    for (let j = 2; j < 8; j++) buf[recOff + j] = 0x00;
    buf[recOff + 8] = recOff === 0x81A0 ? 0x01 : 0x02;
    for (let k = 0; k < 7; k++) buf[recOff + 9 + k] = sec16[k];
    buf[recOff + 16] = 0x04; buf[recOff + 17] = 0x04;
    buf[recOff + 18] = 0x00; buf[recOff + 19] = 0x14;
    for (let k = 0; k < 9; k++) buf[recOff + 20 + k] = sec16[7 + k];
    buf[recOff + 29] = recOff === 0x81E0 ? 0x8F : 0x7F;
  }
  // Clear inactive bank IMMO area (avoid stray FEE-record matches at 0x40C0)
  for (let j = 0; j < 0x100; j++) buf[0x4000 + 0xC0 + j] = 0xFF;
  // Mirror1 (slot 0xEB / size 0x18) in inactive bank
  const m1 = 0x4000 + 0x0200;
  buf[m1] = 0x00; buf[m1 + 1] = 0x00; buf[m1 + 2] = 0x00;
  buf[m1 + 3] = 0x18; buf[m1 + 4] = 0x00; buf[m1 + 5] = 0x46;
  buf[m1 + 6] = 0xEB; buf[m1 + 7] = 0x00; buf[m1 + 8] = 0x01;
  for (let k = 0; k < 16; k++) buf[m1 + 9 + k] = sec16[k];
  // Mirror2 (slot 0xCA / size 0x28) in inactive bank
  const m2 = 0x4000 + 0x0240;
  buf[m2] = 0x00; buf[m2 + 1] = 0x00; buf[m2 + 2] = 0x00;
  buf[m2 + 3] = 0x28; buf[m2 + 4] = 0x00; buf[m2 + 5] = 0x46;
  buf[m2 + 6] = 0xCA; buf[m2 + 7] = 0x00; buf[m2 + 8] = 0x01;
  for (let k = 0; k < 16; k++) buf[m2 + 9 + k] = sec16[k];
  // Flat slice — garbage (0xDE) so we can detect that the writer overwrote it
  for (let j = 0; j < 16; j++) buf[0x40C9 + j] = 0xDE;
  return { buf, splitOffs: [0x81A0, 0x81C0, 0x81E0], mirror1Off: m1, mirror2Off: m2 };
}

describe('writeBcmFlatSec16 — flat 0x40C9 repair from resolved SEC16', () => {
  const SEC16 = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE'); // SINCRO Cartman

  it('writes byte-reversed (LE) form of resolved SEC16 into 0x40C9..0x40D8', () => {
    const { buf } = makeFixtureBcm(SEC16);
    const r = writeBcmFlatSec16(buf, SEC16);
    expect(r.offset).toBe(0x40C9);
    expect(r.patched).toBe(16);
    const expected = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expected[i] = SEC16[15 - i];
    expect(hex(r.bytes.slice(0x40C9, 0x40D9))).toBe(hex(expected));
    expect(r.leHex.toUpperCase()).toBe(hex(expected));
    expect(r.sec16Hex.toUpperCase()).toBe(hex(SEC16));
  });

  it('returns a fresh buffer — input bytes are not mutated', () => {
    const { buf } = makeFixtureBcm(SEC16);
    const before = new Uint8Array(buf);
    const r = writeBcmFlatSec16(buf, SEC16);
    expect(r.bytes).not.toBe(buf);
    // input slice still holds the original 0xDE garbage
    expect(hex(buf.slice(0x40C9, 0x40D9))).toBe('DE'.repeat(16));
    // Whole input buffer unchanged
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== before[i]) throw new Error(`Input mutated at 0x${i.toString(16)}`);
    }
  });

  it('leaves split records (0x81A0 / C0 / E0) and inactive-bank mirrors byte-identical', () => {
    const fx = makeFixtureBcm(SEC16);
    const r = writeBcmFlatSec16(fx.buf, SEC16);
    // Split records: 32 bytes each
    for (const off of fx.splitOffs) {
      expect(hex(r.bytes.slice(off, off + 32)))
        .toBe(hex(fx.buf.slice(off, off + 32)));
    }
    // Mirror1 record (header + payload + CRC area = 32 bytes)
    expect(hex(r.bytes.slice(fx.mirror1Off, fx.mirror1Off + 32)))
      .toBe(hex(fx.buf.slice(fx.mirror1Off, fx.mirror1Off + 32)));
    // Mirror2 record
    expect(hex(r.bytes.slice(fx.mirror2Off, fx.mirror2Off + 32)))
      .toBe(hex(fx.buf.slice(fx.mirror2Off, fx.mirror2Off + 32)));
    // FEE seq bytes too, for paranoia
    expect(r.bytes[0x0002]).toBe(0x09); expect(r.bytes[0x0003]).toBe(0xFB);
    expect(r.bytes[0x4002]).toBe(0x09); expect(r.bytes[0x4003]).toBe(0xFA);
  });

  it('changes ONLY the 16 bytes at 0x40C9..0x40D8 — every other byte is identical', () => {
    // Pick a SEC16 with no 0xDE bytes so every reversed byte differs from the
    // 0xDE garbage seeded into the flat slice — proves the writer touched all
    // 16 positions and nothing else.
    const sec = hexToBytes('00112233445566778899AABBCCEE0011');
    const { buf } = makeFixtureBcm(sec);
    const r = writeBcmFlatSec16(buf, sec);
    let diffCount = 0;
    const diffOffs = [];
    for (let i = 0; i < buf.length; i++) {
      if (r.bytes[i] !== buf[i]) { diffCount++; diffOffs.push(i); }
    }
    expect(diffCount).toBe(16);
    expect(diffOffs[0]).toBe(0x40C9);
    expect(diffOffs[diffOffs.length - 1]).toBe(0x40D8);
  });

  it('after repair, resolveBcmSec16 still picks the split source (priority chain unchanged)', () => {
    const { buf } = makeFixtureBcm(SEC16);
    const r = writeBcmFlatSec16(buf, SEC16);
    const res = resolveBcmSec16(r.bytes);
    expect(res.source).toBe('split');
    expect(res.offset).toBe(0x81A0);
    expect(hex(res.bytes)).toBe(hex(SEC16));
    // And the flat-slice candidate now matches reverse(SEC16)
    const expectedLe = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expectedLe[i] = SEC16[15 - i];
    expect(hex(res.candidates.flat.bytes)).toBe(hex(expectedLe));
    expect(res.candidates.flat.blank).toBe(false);
  });

  it('throws on non-16-byte resolved input', () => {
    const { buf } = makeFixtureBcm(SEC16);
    expect(() => writeBcmFlatSec16(buf, new Uint8Array(15))).toThrow(/16 bytes/);
    expect(() => writeBcmFlatSec16(buf, null)).toThrow(/16 bytes/);
  });

  it('throws when the buffer is too small for the flat slice', () => {
    const tiny = new Uint8Array(0x4000).fill(0xFF);
    expect(() => writeBcmFlatSec16(tiny, SEC16)).toThrow(/too small/);
  });
});
