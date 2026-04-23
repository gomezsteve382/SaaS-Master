// Task #396 — shared PCM SEC6 classifier.
//
// Pre-#396 the parseModule.js path and the engParsePcm path each used
// `bytes.every(b===0xFF)` — a single stray non-FF byte (e.g. the real
// `FF FF 00 FF FF FF` that surfaced on the 2C3CDXGJ9KH633754 incident
// trio's 4 KB GPEC2A virgin) flipped "damaged" to false and let the
// Mismatch Wizard report "Found 0 errors" + the AI assistant tell the
// user "safe to program a key" on a never-paired PCM.
//
// classifyPcmSec6() is the single source of truth — these tests pin
// the exact verdict for the byte patterns that matter: all-FF,
// mostly-FF (the incident pattern), all-zero, real populated, and the
// 3-non-FF edge case.

import { describe, it, expect } from 'vitest';
import { classifyPcmSec6, parseModule } from '../parseModule.js';
import { makeGpec2a } from '../__fixtures__/buildFixtures.js';
import { engParsePcm } from '../../tabs/ModuleSync.jsx';

const u8 = (...bytes) => new Uint8Array(bytes);

describe('classifyPcmSec6() — single source of truth', () => {
  it('all-FF (FFFFFFFFFFFF) is virgin / damaged / not populated', () => {
    const c = classifyPcmSec6(u8(0xFF,0xFF,0xFF,0xFF,0xFF,0xFF));
    expect(c.populated).toBe(false);
    expect(c.damaged).toBe(true);
    expect(c.blank).toBe(true);
    expect(c.allFF).toBe(true);
    expect(c.label).toMatch(/all FF/i);
  });

  it('mostly-FF (FFFF00FFFFFF — the incident pattern) is virgin / damaged / not populated', () => {
    const c = classifyPcmSec6(u8(0xFF,0xFF,0x00,0xFF,0xFF,0xFF));
    expect(c.populated).toBe(false);
    expect(c.damaged).toBe(true);
    expect(c.label).toMatch(/mostly FF/i);
  });

  it('all-zero (000000000000) is virgin (not populated)', () => {
    const c = classifyPcmSec6(u8(0,0,0,0,0,0));
    expect(c.populated).toBe(false);
    expect(c.damaged).toBe(true);
    expect(c.allZero).toBe(true);
    expect(c.label).toMatch(/all 00/i);
  });

  it('real populated SEC6 (08A1C5E7BA30) is populated', () => {
    const c = classifyPcmSec6(u8(0x08,0xA1,0xC5,0xE7,0xBA,0x30));
    expect(c.populated).toBe(true);
    expect(c.damaged).toBe(false);
    expect(c.label).toMatch(/Populated/);
  });

  it('3-non-FF edge case (00FF00FF00FF) is populated', () => {
    const c = classifyPcmSec6(u8(0x00,0xFF,0x00,0xFF,0x00,0xFF));
    expect(c.populated).toBe(true);
    expect(c.damaged).toBe(false);
  });

  it('null / wrong-length input is treated as MISSING', () => {
    expect(classifyPcmSec6(null).populated).toBe(false);
    expect(classifyPcmSec6(null).label).toBe('MISSING');
    expect(classifyPcmSec6(u8(0xAA,0xBB)).populated).toBe(false);
  });
});

describe('parseModule.js info.pcmSec6 uses the shared classifier', () => {
  it('flags FFFF00FFFFFF as IMMO_DAMAGED (regression for the incident)', () => {
    const bytes = makeGpec2a({
      pcmSec6Bytes: u8(0xFF,0xFF,0x00,0xFF,0xFF,0xFF),
    });
    const info = parseModule(bytes, 'GPEC2A_VIRGIN.bin');
    expect(info.type).toBe('GPEC2A');
    expect(info.pcmSec6).toBeTruthy();
    expect(info.pcmSec6.populated).toBe(false);
    expect(info.pcmSec6.damaged).toBe(true);
    expect(info.pcmSec6.immoState).toBe('IMMO_DAMAGED');
  });

  it('still flags real populated SEC6 as SET', () => {
    const bytes = makeGpec2a({
      pcmSec6Bytes: u8(0x08,0xA1,0xC5,0xE7,0xBA,0x30),
    });
    const info = parseModule(bytes, 'GPEC2A_PAIRED.bin');
    expect(info.pcmSec6.populated).toBe(true);
    expect(info.pcmSec6.damaged).toBe(false);
    expect(info.pcmSec6.immoState).toBe('SET');
  });
});

describe('engParsePcm uses the shared classifier (no drift between the two parsers)', () => {
  it('FFFF00FFFFFF agrees with parseModule: not populated, marked damaged', () => {
    const bytes = makeGpec2a({
      pcmSec6Bytes: u8(0xFF,0xFF,0x00,0xFF,0xFF,0xFF),
    });
    const r = engParsePcm(bytes, 'GPEC2A_VIRGIN.bin');
    expect(r.sec6).toBeTruthy();
    expect(r.immoOk).toBe(false);
    expect(r.immoDamaged).toBe(true);
    expect(r.sec6Class).toBeTruthy();
    expect(r.sec6Class.populated).toBe(false);
    expect(r.immoLabel).toMatch(/mostly FF/i);
  });

  it('real populated SEC6 agrees with parseModule: populated', () => {
    const bytes = makeGpec2a({
      pcmSec6Bytes: u8(0x08,0xA1,0xC5,0xE7,0xBA,0x30),
    });
    const r = engParsePcm(bytes, 'GPEC2A_PAIRED.bin');
    expect(r.immoOk).toBe(true);
    expect(r.immoDamaged).toBe(false);
    expect(r.sec6Class.populated).toBe(true);
  });

  it('AA marker scan no longer fabricates a populated SEC6 from FF padding on a 4 KB GPEC2A virgin', () => {
    // Pre-#396 the FF FF FF FF fallback would scan a 4 KB virgin's
    // padding and "find" some 6-byte slice immediately after the first
    // FF run that wasn't all-FF — yielding a bogus "Populated" pill.
    // Now the canonical 0x3C8 read takes priority on any GPEC2A-
    // sized image, so the FF padding around 0x3C8 is correctly read as
    // virgin instead of being replaced by a populated PN-string slice
    // elsewhere in the buffer.
    const buf = new Uint8Array(4096).fill(0xFF);
    // Plant a stray 0x42 mid-buffer so the old fallback would have
    // scooped up 6 nearby bytes and called them populated.
    buf[0x800] = 0x42;
    // Plant a valid VIN at 0x0000 so engParsePcm returns ok=true.
    const vin = '2C3CDXGJ9KH633754';
    for (let i = 0; i < 17; i++) buf[i] = vin.charCodeAt(i);
    const r = engParsePcm(buf, 'GPEC2A_VIRGIN_NO_AA.bin');
    // Canonical slot is read; classifier reports virgin (all FF).
    expect(r.sec6).toBeTruthy();
    expect(r.sec6.offset).toBe(0x3C8);
    expect(r.sec6Class.allFF).toBe(true);
    expect(r.immoDamaged).toBe(true);
    expect(r.immoOk).toBe(false);
  });
});
