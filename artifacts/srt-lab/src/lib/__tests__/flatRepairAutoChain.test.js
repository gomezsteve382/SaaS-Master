/**
 * Task #385 — auto-suggest / auto-chain the legacy 0x40C9 flat repair when
 * a sync would leave it stale.
 *
 * Covers two surfaces:
 *   1. chainBcmFlatRepairIfStale (ModuleSync helper) — pure decision +
 *      patch function used by sync-all / sec16-only after a SEC16-touching
 *      write.
 *   2. crossValidate — surfaces a STALE warning on imported dumps where
 *      the live record-table SEC16 disagrees with the legacy flat slice
 *      so the issue is visible even when the user did not just sync.
 */
import { describe, it, expect } from 'vitest';
import { chainBcmFlatRepairIfStale } from '../../tabs/ModuleSync.jsx';
import { writeBcmSec16Gen2, writeBcmFlatSec16 } from '../securityBytes.js';
import { resolveBcmSec16, parseModule } from '../parseModule.js';
import { crossValidate } from '../crossValidate.js';

function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/* Build a 64 KB BCM with split + mirror records carrying `sec16`, and the
 * flat slice carrying `flatBytes` (LE form, 16 B). */
function makeFixtureBcm(sec16, flatBytes) {
  const buf = new Uint8Array(65536).fill(0xFF);
  buf[0x0002] = 0x09; buf[0x0003] = 0xFB;
  buf[0x4002] = 0x09; buf[0x4003] = 0xFA;
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
  for (let j = 0; j < 0x100; j++) buf[0x4000 + 0xC0 + j] = 0xFF;
  const m1 = 0x4000 + 0x0200;
  buf[m1] = 0x00; buf[m1 + 1] = 0x00; buf[m1 + 2] = 0x00;
  buf[m1 + 3] = 0x18; buf[m1 + 4] = 0x00; buf[m1 + 5] = 0x46;
  buf[m1 + 6] = 0xEB; buf[m1 + 7] = 0x00; buf[m1 + 8] = 0x01;
  for (let k = 0; k < 16; k++) buf[m1 + 9 + k] = sec16[k];
  const m2 = 0x4000 + 0x0240;
  buf[m2] = 0x00; buf[m2 + 1] = 0x00; buf[m2 + 2] = 0x00;
  buf[m2 + 3] = 0x28; buf[m2 + 4] = 0x00; buf[m2 + 5] = 0x46;
  buf[m2 + 6] = 0xCA; buf[m2 + 7] = 0x00; buf[m2 + 8] = 0x01;
  for (let k = 0; k < 16; k++) buf[m2 + 9 + k] = sec16[k];
  for (let j = 0; j < 16; j++) buf[0x40C9 + j] = flatBytes[j];
  return buf;
}

const SEC16_NEW = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE');
const SEC16_OLD_LE = hexToBytes('DE'.repeat(16)); /* obviously stale */

describe('chainBcmFlatRepairIfStale — ModuleSync auto-chain (Task #385)', () => {
  it('repairs flat slice when split/mirror SEC16 differs from flat (LE)', () => {
    const buf = makeFixtureBcm(SEC16_NEW, SEC16_OLD_LE);
    const r = chainBcmFlatRepairIfStale(buf);
    expect(r.repaired).toBe(true);
    expect(r.reason).toBe('stale');
    expect(r.source).toBe('split');
    /* New flat slice is reverse(SEC16_NEW) */
    const expectedLe = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expectedLe[i] = SEC16_NEW[15 - i];
    expect(hex(r.bytes.slice(0x40C9, 0x40D9))).toBe(hex(expectedLe));
    expect(r.leHex).toBe(hex(expectedLe));
    expect(r.oldFlatHex).toBe('DE'.repeat(16));
    /* Live records untouched */
    for (const off of [0x81A0, 0x81C0, 0x81E0]) {
      expect(hex(r.bytes.slice(off, off + 32))).toBe(hex(buf.slice(off, off + 32)));
    }
  });

  it('returns repaired:false (already-in-sync) when flat already matches reverse(resolved)', () => {
    const okFlat = new Uint8Array(16);
    for (let i = 0; i < 16; i++) okFlat[i] = SEC16_NEW[15 - i];
    const buf = makeFixtureBcm(SEC16_NEW, okFlat);
    const r = chainBcmFlatRepairIfStale(buf);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('already-in-sync');
  });

  it('returns repaired:false (flat-only) when split/mirror records are absent', () => {
    /* Wipe split + mirrors so resolver falls back to flat */
    const buf = makeFixtureBcm(SEC16_NEW, SEC16_OLD_LE);
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      for (let j = 0; j < 0x20; j++) buf[recOff + j] = 0xFF;
    }
    /* Wipe mirror records too */
    for (let j = 0; j < 32; j++) buf[0x4200 + j] = 0xFF;
    for (let j = 0; j < 32; j++) buf[0x4240 + j] = 0xFF;
    const r = chainBcmFlatRepairIfStale(buf);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('flat-only');
  });

  it('returns repaired:false (unresolved-or-blank) when SEC16 is virgin everywhere', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const r = chainBcmFlatRepairIfStale(buf);
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('unresolved-or-blank');
  });

  it('handles tiny buffers gracefully', () => {
    const r = chainBcmFlatRepairIfStale(new Uint8Array(0x100));
    expect(r.repaired).toBe(false);
    expect(r.reason).toBe('buffer-too-small');
  });

  it('end-to-end: writeBcmSec16Gen2 + chain leaves flat reverse-matching the new SEC16', () => {
    /* Start with split records carrying an OLD secret and a flat slice
     * that matches the OLD secret (i.e. nothing stale yet). Then simulate
     * an RFH→BCM SEC16 sync by writing a NEW SEC16 via writeBcmSec16Gen2.
     * The flat is now stale; the auto-chain helper must repair it. */
    const oldSec = hexToBytes('00112233445566778899AABBCCDDEEFF');
    const oldLe  = new Uint8Array(16);
    for (let i = 0; i < 16; i++) oldLe[i] = oldSec[15 - i];
    let buf = makeFixtureBcm(oldSec, oldLe);
    /* Sanity: nothing to do before the sync. */
    const before = chainBcmFlatRepairIfStale(buf);
    expect(before.repaired).toBe(false);
    expect(before.reason).toBe('already-in-sync');
    /* Now write a new SEC16 via the same writer ModuleSync uses. */
    const newRfhSec = SEC16_NEW; /* RFH form; BCM stores reverse() */
    const wr = writeBcmSec16Gen2(buf, newRfhSec);
    buf = wr.bytes;
    /* Auto-chain should detect staleness and repair. */
    const after = chainBcmFlatRepairIfStale(buf);
    expect(after.repaired).toBe(true);
    expect(after.source).toBe('split');
    /* The repaired flat slice now equals reverse(BCM SEC16) = RFH SEC16 */
    expect(hex(after.bytes.slice(0x40C9, 0x40D9))).toBe(hex(newRfhSec));
  });
});

describe('crossValidate — flat 0x40C9 staleness warning (Task #385)', () => {
  function buildModulesFromBcmBuf(buf) {
    const bcm = parseModule(buf, 'bcm.bin');
    return [bcm];
  }

  it('emits a STALE warning when split/mirror SEC16 disagrees with flat slice', () => {
    const buf = makeFixtureBcm(SEC16_NEW, SEC16_OLD_LE);
    const { warnings } = crossValidate(buildModulesFromBcmBuf(buf));
    const stale = warnings.find(w => /flat 0x40C9 STALE/i.test(w));
    expect(stale).toBeTruthy();
    expect(stale).toMatch(/Repair flat 0x40C9/);
  });

  it('does NOT emit a STALE warning when flat already matches reverse(resolved)', () => {
    const okFlat = new Uint8Array(16);
    for (let i = 0; i < 16; i++) okFlat[i] = SEC16_NEW[15 - i];
    const buf = makeFixtureBcm(SEC16_NEW, okFlat);
    const { warnings } = crossValidate(buildModulesFromBcmBuf(buf));
    const stale = warnings.find(w => /flat 0x40C9 STALE/i.test(w));
    expect(stale).toBeFalsy();
  });

  it('does NOT emit a STALE warning when only the flat slice is populated', () => {
    /* Wipe split + mirrors; resolver source becomes 'flat' and the rule
     * is suppressed (no live record to compare against). */
    const buf = makeFixtureBcm(SEC16_NEW, SEC16_OLD_LE);
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      for (let j = 0; j < 0x20; j++) buf[recOff + j] = 0xFF;
    }
    for (let j = 0; j < 32; j++) buf[0x4200 + j] = 0xFF;
    for (let j = 0; j < 32; j++) buf[0x4240 + j] = 0xFF;
    const { warnings } = crossValidate(buildModulesFromBcmBuf(buf));
    const stale = warnings.find(w => /flat 0x40C9 STALE/i.test(w));
    expect(stale).toBeFalsy();
  });

  it('does NOT emit a STALE warning when SEC16 is fully blank (BLANK already covers it)', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const { warnings } = crossValidate(buildModulesFromBcmBuf(buf));
    const stale = warnings.find(w => /flat 0x40C9 STALE/i.test(w));
    expect(stale).toBeFalsy();
  });
});
