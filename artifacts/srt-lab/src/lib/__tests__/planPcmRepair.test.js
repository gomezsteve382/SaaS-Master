/* Tests for planPcmRepair (Task #574). */
import { describe, it, expect } from 'vitest';
import { planPcmRepair } from '../rfhPcmPair.js';

const TARGET_VIN = '2C3CDXL95LH123456';
const DONOR_VIN  = '2C3CDXL95LH999999';
const SECRET6 = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);

function makePcm(size = 4096, fill = 0xFF) {
  return new Uint8Array(size).fill(fill);
}

function writeAscii(buf, off, str) {
  for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
}

const VIN_SLOTS = [0x0000, 0x01F0, 0x0224, 0x0CE0];

function makeHealthyPcm(vin = TARGET_VIN) {
  const buf = makePcm(4096, 0xFF);
  for (const off of VIN_SLOTS) writeAscii(buf, off, vin);
  // Marker
  buf[0x03C4] = 0xFF; buf[0x03C5] = 0xFF; buf[0x03C6] = 0xFF; buf[0x03C7] = 0xAA;
  // SEC6 secret matches SECRET6
  for (let i = 0; i < 6; i++) buf[0x03C8 + i] = SECRET6[i];
  // IMMO byte = 0x80 (ENABLED)
  buf[0x0011] = 0x80; buf[0x0012] = 0x00; buf[0x0013] = 0x00; buf[0x0014] = 0x00;
  return buf;
}

describe('planPcmRepair — refusals', () => {
  it('refuses non-canonical size', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(2048), targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/canonical/i);
  });

  it('refuses missing VIN', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(4096), targetVin: '', secret6: SECRET6 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/VIN/);
  });

  it('refuses invalid VIN', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(4096), targetVin: 'NOTAVIN', secret6: SECRET6 });
    expect(r.ok).toBe(false);
  });

  it('refuses wrong-length secret', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(4096), targetVin: TARGET_VIN, secret6: new Uint8Array([1, 2, 3]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/6 bytes/);
  });

  it('refuses blank (all-FF) secret', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(4096), targetVin: TARGET_VIN, secret6: new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blank/i);
  });

  it('refuses blank (all-00) secret', () => {
    const r = planPcmRepair({ pcmBytes: makePcm(4096), targetVin: TARGET_VIN, secret6: new Uint8Array(6) });
    expect(r.ok).toBe(false);
  });

  it('refuses null bytes', () => {
    const r = planPcmRepair({ pcmBytes: null, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(false);
  });
});

describe('planPcmRepair — no-op on already-healthy file', () => {
  it('produces zero edits when PCM already matches target VIN+secret', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits).toEqual([]);
    // Output is byte-identical
    expect(Array.from(r.patchedBytes)).toEqual(Array.from(buf));
  });

  it('rewrites DISABLED IMMO byte (0x00) → ENABLED 0x80 (per spec)', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    buf[0x0011] = 0x00;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].offset).toBe(0x0011);
    expect(r.patchedBytes[0x0011]).toBe(0x80);
    expect(r.patchedBytes[0x0012]).toBe(0x00);
  });
});

describe('planPcmRepair — repairs a virgin (all-FF) PCM', () => {
  it('writes VIN slots, marker, SEC6, and IMMO byte', () => {
    const buf = makePcm(4096, 0xFF);
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    // Edits cover: 4 VINs + marker + SEC6 + IMMO = 7
    expect(r.edits.length).toBe(7);

    // VIN slots
    for (const off of VIN_SLOTS) {
      const decoded = String.fromCharCode(...r.patchedBytes.slice(off, off + 17));
      expect(decoded).toBe(TARGET_VIN);
    }
    // Marker
    expect(r.patchedBytes[0x03C4]).toBe(0xFF);
    expect(r.patchedBytes[0x03C7]).toBe(0xAA);
    // SEC6 secret
    expect(Array.from(r.patchedBytes.slice(0x03C8, 0x03CE))).toEqual(Array.from(SECRET6));
    // IMMO byte
    expect(r.patchedBytes[0x0011]).toBe(0x80);
    expect(r.patchedBytes[0x0012]).toBe(0x00);
  });
});

describe('planPcmRepair — surgical edits only', () => {
  it('only patches VIN slots when SEC6+marker+IMMO are good but VIN is donor', () => {
    const buf = makeHealthyPcm(DONOR_VIN);  // healthy but wrong VIN
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(4);
    expect(r.edits.every(e => e.label.startsWith('VIN slot'))).toBe(true);

    // Bytes outside VIN slots are unchanged
    const offsetsTouched = new Set();
    for (const e of r.edits) for (let k = 0; k < e.length; k++) offsetsTouched.add(e.offset + k);
    for (let i = 0; i < buf.length; i++) {
      if (!offsetsTouched.has(i)) expect(r.patchedBytes[i]).toBe(buf[i]);
    }
  });

  it('only patches marker when secret is good but marker is missing', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    buf[0x03C4] = 0x00; buf[0x03C5] = 0x00; buf[0x03C6] = 0x00; buf[0x03C7] = 0x00;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].offset).toBe(0x03C4);
    expect(r.edits[0].after).toBe('FF FF FF AA');
  });

  it('only patches SEC6 when current secret differs from target', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    for (let i = 0; i < 6; i++) buf[0x03C8 + i] = 0xAB;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].offset).toBe(0x03C8);
  });

  it('only patches IMMO byte when it is all-FF', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    buf[0x0011] = 0xFF; buf[0x0012] = 0xFF; buf[0x0013] = 0xFF; buf[0x0014] = 0xFF;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].offset).toBe(0x0011);
    expect(r.patchedBytes[0x0011]).toBe(0x80);
  });

  it('only patches IMMO byte when it is DISABLED (0x00)', () => {
    const buf = makeHealthyPcm(TARGET_VIN);
    buf[0x0011] = 0x00; buf[0x0012] = 0x00; buf[0x0013] = 0x00; buf[0x0014] = 0x00;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.edits.length).toBe(1);
    expect(r.edits[0].offset).toBe(0x0011);
    expect(r.edits[0].label).toMatch(/DISABLED/);
    expect(r.patchedBytes[0x0011]).toBe(0x80);
  });
});

describe('planPcmRepair — supports 8 KB GPEC2A', () => {
  it('repairs a 8192-byte PCM and preserves the second half', () => {
    const buf = new Uint8Array(8192).fill(0xFF);
    // Make second half random-ish so we can verify it survives
    for (let i = 4096; i < 8192; i++) buf[i] = (i * 31) & 0xFF;
    const r = planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(r.ok).toBe(true);
    expect(r.patchedBytes.length).toBe(8192);
    // Second half unchanged
    for (let i = 4096; i < 8192; i++) expect(r.patchedBytes[i]).toBe(buf[i]);
  });
});

describe('planPcmRepair — input is not mutated', () => {
  it('returns a new buffer; input untouched', () => {
    const buf = makePcm(4096, 0xFF);
    const snap = new Uint8Array(buf);
    planPcmRepair({ pcmBytes: buf, targetVin: TARGET_VIN, secret6: SECRET6 });
    expect(Array.from(buf)).toEqual(Array.from(snap));
  });
});
