/**
 * Task #380 — BCM SEC16 resolver golden tests.
 *
 * Verifies the priority chain split → mirror1 → mirror2 → flat, the
 * provenance reporting that drives the VERIFY report / cross-validate
 * audits, and the down-stream effect on keyProgWizard.deriveSharedSecretBE
 * and crossValidate (RFHUB↔BCM, BCM SEC16→SEC6 ↔ PCM SEC6).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseModule,
  resolveBcmSec16,
} from '../parseModule.js';
import { crossValidate } from '../crossValidate.js';
import { deriveSharedSecretBE } from '../keyProgWizard.js';
import { makeBcm } from '../__fixtures__/buildFixtures.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../__tests__/fixtures');

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* Synthesize a BCM with a given SEC16 written into the split records
 * 0x81A0/0x81C0/0x81E0 and an inactive bank chosen by `inactiveBank`
 * (0 = bank0, 1 = bank1). Optionally writes mirror1 / mirror2 records
 * into the inactive bank at fixed offsets. */
function makeBcmWithSec16({
  sec16,
  inactiveBank = 1,        // bank1 inactive (lower seq)
  withSplit = true,
  mirror1At = null,        // offset in inactive bank or null
  mirror1Sec = null,
  mirror2At = null,
  mirror2Sec = null,
  flatGarbage = true,      // overwrite flat 0x40C9 with garbage
} = {}) {
  const buf = makeBcm({ size: 65536 });
  // FEE bank seqs: active = higher
  if (inactiveBank === 1) {
    buf[0x0002] = 0x09; buf[0x0003] = 0xFB; // bank0 active
    buf[0x4002] = 0x09; buf[0x4003] = 0xFA; // bank1 inactive
  } else {
    buf[0x0002] = 0x09; buf[0x0003] = 0xFA;
    buf[0x4002] = 0x09; buf[0x4003] = 0xFB;
  }
  // Split records
  if (withSplit) {
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      // header
      buf[recOff] = 0xFF; buf[recOff + 1] = 0xFF;
      for (let j = 2; j < 8; j++) buf[recOff + j] = 0x00;
      buf[recOff + 8] = recOff === 0x81A0 ? 0x01 : 0x02; // idx
      // prefix7 + suffix9
      for (let k = 0; k < 7; k++) buf[recOff + 9 + k] = sec16[k];
      buf[recOff + 16] = 0x04; buf[recOff + 17] = 0x04;
      buf[recOff + 18] = 0x00; buf[recOff + 19] = 0x14;
      for (let k = 0; k < 9; k++) buf[recOff + 20 + k] = sec16[7 + k];
      buf[recOff + 29] = recOff === 0x81E0 ? 0x8F : 0x7F;
    }
  } else {
    // Wipe split region
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      for (let j = 0; j < 0x20; j++) buf[recOff + j] = 0xFF;
    }
  }
  // Mirror records inside inactive bank
  const inactiveBase = inactiveBank === 1 ? 0x4000 : 0x0000;
  // Clear the IMMO record area in the inactive bank to avoid stray
  // FEE-record pattern matches at 0x40C0 (synthetic non-Redeye images
  // can otherwise look like a mirror1 record there).
  for (let j = 0; j < 0x100; j++) buf[inactiveBase + 0xC0 + j] = 0xFF;
  if (mirror1At !== null && mirror1Sec) {
    const off = inactiveBase + mirror1At;
    buf[off] = 0x00; buf[off + 1] = 0x00; buf[off + 2] = 0x00;
    buf[off + 3] = 0x18; buf[off + 4] = 0x00; buf[off + 5] = 0x46;
    buf[off + 6] = 0xEB; buf[off + 7] = 0x00;
    buf[off + 8] = 0x01;
    for (let k = 0; k < 16; k++) buf[off + 9 + k] = mirror1Sec[k];
  }
  if (mirror2At !== null && mirror2Sec) {
    const off = inactiveBase + mirror2At;
    buf[off] = 0x00; buf[off + 1] = 0x00; buf[off + 2] = 0x00;
    buf[off + 3] = 0x28; buf[off + 4] = 0x00; buf[off + 5] = 0x46;
    buf[off + 6] = 0xCA; buf[off + 7] = 0x00;
    buf[off + 8] = 0x01;
    for (let k = 0; k < 16; k++) buf[off + 9 + k] = mirror2Sec[k];
  }
  // Flat slice — write garbage so we can prove the resolver ignored it.
  if (flatGarbage) {
    for (let j = 0; j < 16; j++) buf[0x40C9 + j] = 0xDE;
  }
  return buf;
}

describe('resolveBcmSec16 — priority chain', () => {
  it('picks split records over mirrors and flat (synthetic)', () => {
    const sec = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE'); // SINCRO Cartman
    const buf = makeBcmWithSec16({
      sec16: sec,
      mirror1At: 0x0200, mirror1Sec: hexToBytes('AA'.repeat(16)),
      mirror2At: 0x0240, mirror2Sec: hexToBytes('BB'.repeat(16)),
    });
    const r = resolveBcmSec16(buf);
    expect(r.source).toBe('split');
    expect(r.offset).toBe(0x81A0);
    expect(hex(r.bytes)).toBe('8CF8E4012D19B27E64731D5A2FBD4BDE');
    expect(r.blank).toBe(false);
    expect(r.inactiveBase).toBe(0x4000);
    expect(r.candidates.split.consistent).toBe(true);
  });

  it('falls back to mirror1 when split records are blank', () => {
    const sec = hexToBytes('2AC740845C415AC2332EE3CDF7316581'); // SINCRO virgin Redeye
    const buf = makeBcmWithSec16({
      sec16: sec,
      withSplit: false,
      mirror1At: 0x0200, mirror1Sec: sec,
      mirror2At: 0x0240, mirror2Sec: hexToBytes('BB'.repeat(16)),
    });
    const r = resolveBcmSec16(buf);
    expect(r.source).toBe('mirror1');
    expect(hex(r.bytes)).toBe('2AC740845C415AC2332EE3CDF7316581');
  });

  it('falls back to mirror2 when split + mirror1 are absent', () => {
    const sec = hexToBytes('00112233445566778899AABBCCDDEEFF');
    const buf = makeBcmWithSec16({
      sec16: sec,
      withSplit: false,
      mirror2At: 0x0240, mirror2Sec: sec,
    });
    const r = resolveBcmSec16(buf);
    expect(r.source).toBe('mirror2');
    expect(hex(r.bytes)).toBe('00112233445566778899AABBCCDDEEFF');
  });

  it('falls back to legacy flat 0x40C9 only when nothing else is populated', () => {
    // Plain synthetic makeBcm has no split / mirror records, so the
    // resolver must surface the flat slice.
    const buf = makeBcm();
    const r = resolveBcmSec16(buf);
    expect(r.source).toBe('flat');
    expect(r.offset).toBe(0x40C9);
    expect(r.blank).toBe(false);
  });

  it('reports blank=true and sec16Absent=true when every candidate is all-FF (bytes=null)', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const r = resolveBcmSec16(buf);
    expect(r.blank).toBe(true);
    expect(r.sec16Absent).toBe(true);
    /* Task #815 — phantom bytes are never surfaced; null prevents callers from
     * treating the all-FF noise as an authoritative vehicle secret. */
    expect(r.bytes).toBeNull();
    expect(r.source).toBeNull();
  });
});

describe('resolveBcmSec16 — real synced fixture (2C3CDXL90MH582899)', () => {
  const fxPath = path.join(FIXTURE_DIR, 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin');
  const fxOk = fs.existsSync(fxPath);
  const d = fxOk ? describe : describe.skip;

  d('committed fixture', () => {
    const data = new Uint8Array(fs.readFileSync(fxPath));
    const r = resolveBcmSec16(data);
    it('resolver picks split @0x81A0', () => {
      expect(r.source).toBe('split');
      expect(r.offset).toBe(0x81A0);
      expect(r.blank).toBe(false);
    });
    it('split SEC16 matches the documented golden value', () => {
      expect(hex(r.bytes)).toBe('EDBDFF7CBBABC3A07D5A607637 72FA86'.replace(/\s+/g, ''));
    });
    it('inactive bank is bank1 (0x4000) — bank0 seq 0x09FB > bank1 seq 0x09FA', () => {
      expect(r.inactiveBase).toBe(0x4000);
    });
    it('parseModule surfaces resolved bytes via vehicleSecret + bcmSec16', () => {
      const m = parseModule(data, 'bcm.bin');
      expect(m.bcmSec16.source).toBe('split');
      expect(m.vehicleSecret.source).toBe('split');
      expect(m.vehicleSecret.endian).toBe('big');
      expect(m.vehicleSecret.offset).toBe(0x81A0);
      expect(hex(m.vehicleSecret.bytes)).toBe('EDBDFF7CBBABC3A07D5A60763772FA86');
    });
    it('deriveSharedSecretBE returns reverse(SEC16) — the BE shared secret', () => {
      const m = parseModule(data, 'bcm.bin');
      const ss = deriveSharedSecretBE(m);
      // reverse of EDBDFF7CBBABC3A07D5A60763772FA86
      expect(ss.toUpperCase()).toBe('86FA723776605A7DA0C3ABBB7CFFBDED');
    });
  });
});

describe('crossValidate — Task #380 BCM SEC16 rules', () => {
  it('emits sec16Absent note (not MISMATCH / BLANK warning) when every source is virgin', () => {
    const blankBcm = new Uint8Array(65536).fill(0xFF);
    // give it a BCM signature so parseModule classifies it correctly
    blankBcm[0x5320] = 'A'.charCodeAt(0); // partial — just enough to keep type=BCM via size
    const bcm = parseModule(blankBcm, 'bcm.bin');
    expect(bcm.type).toBe('BCM');
    // build a stub RFH with non-virgin secret so we exercise the sec16Absent path
    const rfh = {
      type: 'RFHUB',
      vins: [],
      vehicleSecret: { bytes: new Uint8Array(16).fill(0x11) },
      sec16s: [{ raw: new Uint8Array(16).fill(0x11), hex: '11'.repeat(16), csOk: true, blank: false }],
      sec16valid: true,
    };
    const out = crossValidate([bcm, rfh]);
    /* Task #815 — no MISMATCH and no "BLANK" warning. Instead, a neutral
     * "absent / not evaluable" note is pushed to passed so the wizard and AI
     * assistant never see phantom bytes or a false MISMATCH. */
    expect(out.issues.some(i => /RFHUB ↔ BCM/.test(i))).toBe(false);
    expect(out.warnings.some(w => /BCM SEC16 BLANK/.test(w))).toBe(false);
    const hasAbsentNote = [...out.passed].some(p => /ALERT_NO_SECURITY|absent/i.test(p));
    expect(hasAbsentNote).toBe(true);
  });

  it('emits MATCH when reverse(BCM SEC16) equals RFH SEC16 (resolved source)', () => {
    const sec = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE');
    const buf = makeBcmWithSec16({ sec16: sec });
    const bcm = parseModule(buf, 'bcm.bin');
    const rev = new Uint8Array(Array.from(sec).reverse());
    const rfh = {
      type: 'RFHUB',
      vins: [],
      vehicleSecret: { bytes: rev },
      sec16s: [{ raw: rev, hex: hex(rev), csOk: true, blank: false }],
      sec16valid: true,
    };
    const out = crossValidate([bcm, rfh]);
    expect(out.passed.some(p => /RFHUB ↔ BCM vehicle secret: MATCH/.test(p))).toBe(true);
    expect(out.issues.some(i => /MISMATCH/.test(i))).toBe(false);
  });

  it('emits BCM SEC16 → SEC6 ↔ PCM SEC6 MATCH when GPEC SEC6 = reverse(SEC16)[0:6]', () => {
    const sec = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE');
    const buf = makeBcmWithSec16({ sec16: sec });
    const bcm = parseModule(buf, 'bcm.bin');
    const rev6 = Array.from(sec).reverse().slice(0, 6);
    const gpec = {
      type: 'GPEC2A',
      vins: [],
      pcmSec6: { raw: new Uint8Array(rev6), hex: hex(rev6), damaged: false, immoState: 'SET' },
    };
    const out = crossValidate([bcm, gpec]);
    expect(out.passed.some(p => /BCM SEC16 → SEC6 ↔ PCM SEC6: MATCH/.test(p))).toBe(true);
  });

  it('emits GPEC2A vehicle key ERASED warning instead of inconsistency issue when virgin', () => {
    const gpec = {
      type: 'GPEC2A',
      vins: [],
      skb: true,
      keyConsistent: false,
      secretKey: { bytes: new Uint8Array(8).fill(0xFF) },
      skimByte: 0x80,
    };
    const out = crossValidate([gpec]);
    expect(out.warnings.some(w => /GPEC2A vehicle key: ERASED\/virgin/.test(w))).toBe(true);
    expect(out.issues.some(i => /GPEC2A secret key INCONSISTENT/.test(i))).toBe(false);
  });
});
