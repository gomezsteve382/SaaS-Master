// Task #396 — crossValidate gating for the BCM SEC16 → SEC6 ↔ PCM SEC6
// rule. Pre-#396 the gate was `!gpec.pcmSec6.damaged`, so a paired BCM
// against a virgin PCM (FF FF 00 FF FF FF on the incident trio) slipped
// through with no message at all — the FCA Analyzer simply showed
// nothing for this pair. Now we surface a "PCM never paired with this
// BCM" issue (not a warning) so the user is never silently told it's
// safe to program a key on a never-paired PCM.

import { describe, it, expect } from 'vitest';
import { crossValidate } from '../crossValidate.js';
import { classifyPcmSec6 } from '../parseModule.js';

const u8 = (...bytes) => new Uint8Array(bytes);

// Real BCM SEC16 from the 2026-04-23 incident report
// (resolved split-record value on the 2C3CDXGJ9KH633754 trio).
const REAL_BCM_SEC16 = u8(
  0xC4,0x2F,0x3C,0x79,0x94,0x15,0x82,0xC3,
  0x82,0x35,0x30,0xBA,0xE7,0xC5,0xA1,0x08,
);
// reverse(BCM SEC16)[0:6] = 08 A1 C5 E7 BA 30
const PAIRED_PCM_SEC6 = u8(0x08,0xA1,0xC5,0xE7,0xBA,0x30);
// The incident reading.
const VIRGIN_PCM_SEC6 = u8(0xFF,0xFF,0x00,0xFF,0xFF,0xFF);

function makeBcmModule(sec16Bytes, vin = '2C3CDXGJ9KH633754') {
  return {
    type: 'BCM',
    vins: [{ vin, offset: 0x5320 }],
    bcmSec16: {
      bytes: sec16Bytes,
      blank: false,
      source: 'split',
      candidates: { flat: { bytes: sec16Bytes } },
    },
  };
}

function makePcmModule(sec6Bytes, vin = '2C3CDXGJ9KH633754', { markerOk = true } = {}) {
  // Task #404 — `populated` requires both the 6 secret bytes AND the
  // canonical `FF FF FF AA` marker at 0x3C4. Test fixtures default to
  // `markerOk: true` so existing populated-SEC6 cases still pass; pass
  // `{ markerOk: false }` to simulate the user-reported regression
  // (correct 6 bytes but missing marker → IMMO_DAMAGED).
  const cls = classifyPcmSec6(sec6Bytes);
  const hex = Array.from(sec6Bytes)
    .map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  const populated = cls.populated && markerOk;
  return {
    type: 'GPEC2A',
    vins: [{ vin, offset: 0x0000 }],
    pcmSec6: {
      offset: 0x3C8, raw: sec6Bytes, hex,
      markerOffset: 0x3C4, markerOk,
      markerHex: markerOk ? 'FF FF FF AA' : 'FF FF FF FF',
      blank: cls.blank, damaged: !populated, populated,
      immoState: populated ? 'SET' : 'IMMO_DAMAGED',
    },
  };
}

describe('crossValidate BCM SEC16 → SEC6 ↔ PCM SEC6 (Task #396 gate)', () => {
  it('emits a "PCM never paired" issue when BCM is paired but PCM SEC6 is virgin (mostly-FF)', () => {
    const out = crossValidate([
      makeBcmModule(REAL_BCM_SEC16),
      makePcmModule(VIRGIN_PCM_SEC6),
    ]);
    const sec6Issue = out.issues.find(s => /BCM SEC16.*PCM SEC6/i.test(s));
    expect(sec6Issue).toBeTruthy();
    expect(sec6Issue).toMatch(/PCM never paired with this BCM/i);
    // Must surface as an ISSUE, not a warning.
    expect(out.warnings.find(s => /PCM never paired/i.test(s))).toBeFalsy();
  });

  it('still passes when BCM SEC16 reverse[0:6] equals a populated PCM SEC6', () => {
    const out = crossValidate([
      makeBcmModule(REAL_BCM_SEC16),
      makePcmModule(PAIRED_PCM_SEC6),
    ]);
    const ok = out.passed.find(s => /BCM SEC16.*PCM SEC6.*MATCH/i.test(s));
    expect(ok).toBeTruthy();
    expect(out.issues.find(s => /BCM SEC16.*PCM SEC6/i.test(s))).toBeFalsy();
  });

  it('still emits MISMATCH when BCM and PCM are populated but disagree', () => {
    const out = crossValidate([
      makeBcmModule(REAL_BCM_SEC16),
      makePcmModule(u8(0x11,0x22,0x33,0x44,0x55,0x66)),
    ]);
    const mismatch = out.issues.find(s => /BCM SEC16.*PCM SEC6.*MISMATCH/i.test(s));
    expect(mismatch).toBeTruthy();
  });

  it('Task #404 — flags PCM as IMMO_DAMAGED when 6 secret bytes are correct but marker is missing', () => {
    // The user-reported regression: BCM→PCM sync wrote the 6 bytes at
    // 0x3C8 but never stamped the FF FF FF AA marker at 0x3C4, so the
    // resulting PCM still read as IMMO_DAMAGED in CGDI/Autel/AlfaOBD.
    // crossValidate must surface that the SEC6 secret matches BCM but
    // the slot is still unpaired from the PCM bootloader's POV.
    const out = crossValidate([
      makeBcmModule(REAL_BCM_SEC16),
      makePcmModule(PAIRED_PCM_SEC6, '2C3CDXGJ9KH633754', { markerOk: false }),
    ]);
    expect(out.passed.find(s => /BCM SEC16.*PCM SEC6.*MATCH/i.test(s))).toBeFalsy();
    const issue = out.issues.find(s => /BCM SEC16.*PCM SEC6/i.test(s));
    expect(issue).toBeTruthy();
    expect(issue).toMatch(/never paired|IMMO_DAMAGED|marker/i);
  });

  it('also flags the standalone PCM SEC6 line as IMMO_DAMAGED for mostly-FF (so the FCA Analyzer surfaces both signals)', () => {
    const out = crossValidate([
      makeBcmModule(REAL_BCM_SEC16),
      makePcmModule(VIRGIN_PCM_SEC6),
    ]);
    const standalone = out.issues.find(
      s => /^PCM SEC6 @ 0x3C8/i.test(s) && /IMMO_DAMAGED|virgin/i.test(s),
    );
    expect(standalone).toBeTruthy();
  });
});
