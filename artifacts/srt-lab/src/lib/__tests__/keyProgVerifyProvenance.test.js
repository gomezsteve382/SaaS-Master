/**
 * Task #386 — VERIFY.txt should mirror the BCM SEC16 provenance badge so a
 * locksmith can audit an archived ZIP without reloading the BCM in the GUI.
 *
 * Covers:
 *   - split records (live SEC16 read from 0x81A0/0x81C0/0x81E0)
 *   - flat 0x40C9 fallback (legacy synthesized BCM with no split records)
 *   - virgin / blank dump (every candidate is 0xFF) — explainer paragraph
 */
import { describe, it, expect } from 'vitest';
import { parseModule } from '../parseModule.js';
import { buildVerifyText, formatBcmSec16Provenance } from '../keyProgWizard.js';
import { makeBcm } from '../__fixtures__/buildFixtures.js';

function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function makeBcmWithSplit(sec16) {
  const buf = makeBcm({ size: 65536 });
  buf[0x0002] = 0x09; buf[0x0003] = 0xFB; // bank0 active
  buf[0x4002] = 0x09; buf[0x4003] = 0xFA; // bank1 inactive
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
  return buf;
}

function callBuildVerifyText(bcmAfterInfo, bcmPatched) {
  return buildVerifyText({
    vin: '2C3CDXCT1HH652640',
    sharedSecret: '0000000000000000000000000000DEAD',
    bcmName: 'BCM_X.bin', rfhName: 'RFH_X.bin', pcmName: 'PCM_X.bin',
    bcmSrcSha: '(sha)', bcmOutSha: '(sha)',
    rfhSrcSha: '(sha)', rfhOutSha: '(sha)',
    pcmSrcSha: '(sha)', pcmOutSha: '(sha)',
    before: { bcmFullVins: [], bcmPartials: [] },
    after: { bcmFullVins: [], bcmPartials: [] },
    bcmAfterInfo,
    rfhAfterInfo: { vins: [], sec16s: [] },
    pcmAfterInfo: { vins: [] },
    bcmPatched,
    promoteBank: false,
    ok: true,
    failedChecks: [],
    pcmChip: { chip: '95320', sizeLabel: '4 KB' },
    pcmSliced: false,
  });
}

describe('Task #386 — formatBcmSec16Provenance helper', () => {
  it('returns null when the resolver result is missing', () => {
    expect(formatBcmSec16Provenance(null)).toBeNull();
    expect(formatBcmSec16Provenance(undefined)).toBeNull();
  });

  it('formats split source with offset and BE bytes', () => {
    const bytes = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE');
    const p = formatBcmSec16Provenance({
      source: 'split', offset: 0x81A0, blank: false, bytes,
    });
    expect(p.source).toBe('split');
    expect(p.label).toBe('split @0x81A0');
    expect(p.offsetHex).toBe('0x81A0');
    expect(p.blank).toBe(false);
    expect(p.beHex).toBe('DE4BBD2F5A1D73647EB2192D01E4F88C');
  });

  it('formats blank/virgin with the explainer paragraph available', () => {
    const p = formatBcmSec16Provenance({
      source: 'flat', offset: 0x40C9, blank: true,
      bytes: new Uint8Array(16).fill(0xFF),
    });
    expect(p.blank).toBe(true);
    expect(p.label).toBe('flat @0x40C9 (legacy)');
    expect(p.virginExplainer).toMatch(/virgin/i);
    expect(p.virginExplainer).toMatch(/0x81A0\/0x81C0\/0x81E0/);
  });

  it('labels mirror1 / mirror2 with their key bytes', () => {
    expect(formatBcmSec16Provenance({ source: 'mirror1', offset: 0x4200, bytes: new Uint8Array(16) }).label)
      .toBe('mirror1 0xEB @0x4200');
    expect(formatBcmSec16Provenance({ source: 'mirror2', offset: 0x4240, bytes: new Uint8Array(16) }).label)
      .toBe('mirror2 0xCA @0x4240');
  });
});

describe('Task #386 — VERIFY report mirrors the BCM SEC16 badge', () => {
  it('split-source BCM: report names "split @<offset>" and the BE bytes', () => {
    const sec = hexToBytes('8CF8E4012D19B27E64731D5A2FBD4BDE');
    const buf = makeBcmWithSplit(sec);
    const info = parseModule(buf, 'BCM_split.bin');
    expect(info.bcmSec16.source).toBe('split');
    const text = callBuildVerifyText(info, buf);
    expect(text).toContain('-- BCM SEC16 source');
    expect(text).toMatch(/Source:\s+split @0x81A0/);
    expect(text).toMatch(/Offset:\s+0x81A0/);
    expect(text).toMatch(/Blank:\s+no/);
    expect(text).toContain('Bytes (BE): DE4BBD2F5A1D73647EB2192D01E4F88C');
    // Virgin explainer must NOT appear for a paired BCM.
    expect(text).not.toMatch(/looks virgin/);
  });

  it('flat-fallback BCM: report names "flat @0x40C9 (legacy)"', () => {
    const buf = makeBcm({ size: 65536 });
    const info = parseModule(buf, 'BCM_flat.bin');
    expect(info.bcmSec16.source).toBe('flat');
    const text = callBuildVerifyText(info, buf);
    expect(text).toContain('-- BCM SEC16 source');
    expect(text).toMatch(/Source:\s+flat @0x40C9 \(legacy\)/);
    expect(text).toMatch(/Offset:\s+0x40C9/);
    expect(text).toMatch(/Blank:\s+no/);
    expect(text).not.toMatch(/looks virgin/);
  });

  it('virgin BCM: report carries the explainer paragraph instead of bytes', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const info = parseModule(buf, 'BCM_virgin.bin');
    expect(info.bcmSec16.blank).toBe(true);
    const text = callBuildVerifyText(info, buf);
    expect(text).toContain('-- BCM SEC16 source');
    expect(text).toMatch(/Blank:\s+yes\s+\[BLANK \/ virgin\]/);
    expect(text).toMatch(/looks virgin/);
    expect(text).toMatch(/0x81A0\/0x81C0\/0x81E0/);
    expect(text).toMatch(/download buttons stay disabled/);
    // No leaked BE-hex line for an all-FF dump (just the explainer).
    expect(text).not.toMatch(/Bytes \(BE\):/);
  });
});
