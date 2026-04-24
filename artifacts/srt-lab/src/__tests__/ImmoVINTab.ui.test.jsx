// @vitest-environment jsdom
//
// Task #446 — ImmoVINTab UI smoke + pure-function donor-leak coverage.
//
//   * mounts the tab via @testing-library/react and asserts the two-section
//     header / RFH + GPEC headings render without throwing,
//   * exercises the exported parseGpec2a / applyGpec2a / extractGpecVin
//     surface that the Immo/VIN flow uses to detect and wipe donor VINs at
//     all four canonical PCM slots — including 0x0CE0, the slot that leaked
//     pre-#442.
//
// The pure-function leg pairs with workflowLeakAudit.test.js (the
// integration-level synthetic donor→target audit): together they cover the
// donor-VIN/SEC6/IMMO surface from both the React entry point and the data
// path the tab calls into.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import ImmoVINTab, {
  applyGpec2a, parseGpec2a, extractGpecVin,
} from '../tabs/ImmoVINTab.jsx';
import { PCM_VIN_OFFSETS_GPEC2A } from '../lib/parseModule.js';

const TARGET_VIN = '2C3CDXKT8FH000001';
const DONOR_VIN  = '2C3CDXKT7FH999999';

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function readVinAt(buf, off) {
  let s = '';
  for (let i = 0; i < 17; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

afterEach(() => cleanup());

describe('ImmoVINTab — smoke render', () => {
  it('mounts both RFH and GPEC sections', () => {
    render(<ImmoVINTab />);
    // The header text is unique to the tab.
    expect(screen.getByText(/ImmoVIN/i)).toBeTruthy();
    // The two sub-sections each surface their canonical title text.
    expect(screen.getAllByText(/RFH/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPEC/i).length).toBeGreaterThan(0);
  });
});

describe('ImmoVINTab — GPEC2A pure-function donor leak coverage', () => {
  it('exposes the 4-slot canonical PCM VIN map', () => {
    expect(PCM_VIN_OFFSETS_GPEC2A).toEqual([0x0000, 0x01F0, 0x0224, 0x0CE0]);
  });

  it('extractGpecVin returns null on garbage / OOB', () => {
    const buf = new Uint8Array(32);
    expect(extractGpecVin(buf, 0)).toBeNull();        // all zeroes — fails [A-HJ-NPR-Z0-9]
    expect(extractGpecVin(buf, 999)).toBeNull();      // OOB
  });

  it('parseGpec2a flags donor VIN at slot 4 as inconsistent', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const a = asciiBytes(TARGET_VIN);
    const b = asciiBytes(DONOR_VIN);
    for (let i = 0; i < 17; i++) buf[0x0000 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x01F0 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x0224 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x0CE0 + i] = b[i]; // donor leak

    const r = parseGpec2a(buf);
    expect(r.validSz).toBe(true);
    expect(r.consistent).toBe(false);
    expect(r.slots.length).toBe(4);
    expect(r.slots[3].vin).toBe(DONOR_VIN);
    expect(r.slots[0].vin).toBe(TARGET_VIN);
  });

  it('applyGpec2a wipes the donor VIN at every canonical slot', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const a = asciiBytes(TARGET_VIN);
    const b = asciiBytes(DONOR_VIN);
    for (let i = 0; i < 17; i++) buf[0x0000 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x01F0 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x0224 + i] = a[i];
    for (let i = 0; i < 17; i++) buf[0x0CE0 + i] = b[i];

    const out = applyGpec2a(buf, TARGET_VIN, null);
    for (const off of PCM_VIN_OFFSETS_GPEC2A) {
      expect(readVinAt(out, off)).toBe(TARGET_VIN);
    }
    // Source buffer unchanged (defensive copy).
    expect(readVinAt(buf, 0x0CE0)).toBe(DONOR_VIN);
  });

  it('applyGpec2a leaves VIN slots alone when newVin is empty / wrong length', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const a = asciiBytes(TARGET_VIN);
    for (let i = 0; i < 17; i++) buf[0x0224 + i] = a[i];

    const out1 = applyGpec2a(buf, '', null);
    expect(readVinAt(out1, 0x0224)).toBe(TARGET_VIN);

    const out2 = applyGpec2a(buf, 'TOOSHORT', null);
    expect(readVinAt(out2, 0x0224)).toBe(TARGET_VIN);
  });

  it('applyGpec2a rewrites the SKIM key + mirror when given 16 hex chars', () => {
    const buf = new Uint8Array(4096).fill(0xFF);
    const out = applyGpec2a(buf, null, '0102030405060708');
    const want = [0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08];
    expect(Array.from(out.slice(0x0203, 0x020B))).toEqual(want);
    expect(Array.from(out.slice(0x0361, 0x0369))).toEqual(want);
  });
});
