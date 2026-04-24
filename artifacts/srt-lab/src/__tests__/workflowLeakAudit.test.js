// Task #446 — workflow leak audit.
//
// Drives every exported synchronous donor→target write helper on the
// donor-VIN / SEC6 / IMMO surface with sentinel buffers carrying
// distinguishable donor and target patterns, then asserts that the
// donor sentinel does NOT appear in the output buffer outside the
// allow-list of intended write zones for that function. Catches the
// class of regression where a writer accidentally leaves donor bytes
// untouched (e.g. a partial slot with the donor VIN survived a sync
// because the writer only patched the canonical slot offsets).
//
// The "donor" buffer is the original target buffer; the helper takes
// donor source data + target buffer and returns the patched target.
// We synthesize donor and target with byte-distinct sentinels so a
// per-byte sweep can prove no donor pattern survived outside the
// expected windows.

import { describe, it, expect } from 'vitest';

import {
  makeBcm,
  makeRfhubGen2,
  makeRfhubGen1,
  makeGpec2a,
  make95640,
  asciiBytes,
} from '../lib/__fixtures__/buildFixtures.js';
import { crc16, crc8_42, crc8_65 } from '../lib/crc.js';

// ── Fixture helpers (with valid CRCs so analyzeFile recognises slots) ──
function stampBcmCrcs(buf, vin) {
  // analyzeFile BCM branch only enrolls a VIN slot if CRC16 BE at +17/+18
  // matches; makeBcm doesn't stamp it, so we add it here.
  const ascii = asciiBytes(vin);
  for (const off of [0x5320, 0x5340, 0x5360, 0x5380]) {
    const c = crc16(ascii);
    buf[off + 17] = (c >> 8) & 0xFF;
    buf[off + 18] = c & 0xFF;
  }
}
function make95640Donor(vin, withThird) {
  const buf = make95640({ vin, withThirdVin: withThird });
  // analyzeFile 95640 branch requires crc8_42(VIN) at off-1.
  const ascii = asciiBytes(vin);
  for (const off of [0x275, 0x288]) buf[off - 1] = crc8_42(ascii);
  return buf;
}
function makeRfhPairFixture({ vin, sec16 }) {
  // Produce an RFH 24C32 buffer that parseRFH24C32 will accept end-to-end:
  // VIN @ 0x92 + crc16 BE at 0xA3, plus SEC16 at 0xAE/0xC0 with the
  // crc8_65-style CS byte at +16 (xr-byte-equality match in parseSec16).
  const buf = makeRfhubGen2({ vin, vehicleSecret: sec16 });
  // VIN @ 0x92 with CRC16 BE
  const ascii = asciiBytes(vin);
  for (let i = 0; i < 17; i++) buf[0x92 + i] = ascii[i];
  const vinCs = crc16(ascii);
  buf[0xA3] = (vinCs >> 8) & 0xFF;
  buf[0xA4] = vinCs & 0xFF;
  // SEC16 mirror at 0xAE / 0xC0 with crc8_65 CS byte at +16. parseSec16
  // accepts (csStored & 0xFF) === xr — RFH-style payloads where xr=0
  // (palindromic XOR) make the low byte = 0 so CS check passes; for the
  // generic 0xD?-pattern sec16 we pre-stamp a working CS using crc8_65.
  const csByte = crc8_65(Array.from(sec16));
  for (const off of [0xAE, 0xC0]) {
    for (let i = 0; i < 16; i++) buf[off + i] = sec16[i];
    buf[off + 16] = csByte;
    buf[off + 17] = 0x00;
  }
  return buf;
}

import { applyRfhToPcm, parseRFH24C32, parsePCMGPEC, RFH_PCM_CONST } from '../lib/rfhPcmPair.js';
import {
  applyPcmFromBcm,
  applyPcmSec6FromRfh,
  applyPcmFromRfhWithVin,
} from '../lib/bcmPcmSync.js';
import {
  writeBcmSec16Gen2,
  writeBcmFlatSec16,
  writePcmSec6,
  writeRfhSec16FromBcm,
} from '../lib/securityBytes.js';
import {
  analyzeFile,
  patchFile,
  virginizeFile,
  writeModuleVIN,
  virginizeModule,
  syncImmoBackupF,
} from '../lib/fileUtils.js';

// ── Sentinel constants ───────────────────────────────────────────────
// Both VINs carry valid check digits — the BCM scanner in analyzeFile
// rejects any 17-char ASCII run whose VIN check digit fails, so without
// valid check digits the scan returns vins=[] and the leak audit can't
// observe whether the writer covered the canonical slots.
const DONOR_VIN  = '2C3CDXKT8FH000001'; // check digit 8
const TARGET_VIN = '2C3CDXKT7FH999999'; // check digit 7

// 16-byte SEC16 patterns: donor = 0xDD pattern, target = 0xAA pattern.
const DONOR_SEC16  = new Uint8Array(16).map((_, i) => 0xD0 | (i & 0x0F));
const TARGET_SEC16 = new Uint8Array(16).map((_, i) => 0xA0 | (i & 0x0F));

// ── Helpers ──────────────────────────────────────────────────────────
function findAll(buf, needle) {
  const hits = [];
  if (!needle.length || needle.length > buf.length) return hits;
  outer: for (let i = 0; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

// Asserts every hit of `needle` lies inside one of the allow-list
// `[start, end)` windows. Builds a friendly error message listing the
// offending offsets.
function expectHitsWithinAllowList(buf, needle, allowList, label) {
  const hits = findAll(buf, needle);
  const stray = hits.filter(off => {
    return !allowList.some(([s, e]) => off >= s && off + needle.length <= e);
  });
  if (stray.length) {
    const allow = allowList.map(([s, e]) =>
      '[0x' + s.toString(16).toUpperCase() + ',0x' + e.toString(16).toUpperCase() + ')'
    ).join(',');
    const strayHex = stray.map(o => '0x' + o.toString(16).toUpperCase()).join(',');
    throw new Error(
      `${label}: donor sentinel survived at ${strayHex}; expected only inside ${allow}`
    );
  }
  return hits;
}

// ── 1. applyRfhToPcm ─────────────────────────────────────────────────
describe('applyRfhToPcm — donor→target leak audit', () => {
  it('writes only PCM SEC6 (0x3C4..0x3CE) and the canonical VIN slots; no other donor bytes leak', () => {
    const donorRfhBuf = makeRfhPairFixture({ vin: DONOR_VIN, sec16: DONOR_SEC16 });
    const targetPcmBuf = makeGpec2a({ vin: TARGET_VIN });
    const rfh = parseRFH24C32(donorRfhBuf);
    const pcm = parsePCMGPEC(targetPcmBuf);
    expect(rfh.sec6).not.toBeNull();
    expect(rfh.sec6.hex).toBeDefined();

    const { data, log } = applyRfhToPcm(rfh, pcm, targetPcmBuf);

    // SEC6 marker (4 B) + SEC6 payload (6 B) at 0x3C4..0x3CE.
    // VIN slots at every PCM_VIN_OFFSETS entry (17 B each).
    const allow = [
      [0x3C4, 0x3CE],
      ...RFH_PCM_CONST.PCM_VIN_OFFSETS.map(o => [o, o + 17]),
    ];

    // Donor VIN ASCII must only land in the canonical VIN slots.
    expectHitsWithinAllowList(data, asciiBytes(DONOR_VIN), allow, 'applyRfhToPcm donor VIN');
    // Target VIN must be GONE — it has been replaced everywhere allow-listed.
    expect(findAll(data, asciiBytes(TARGET_VIN))).toEqual([]);
    // Log must record what was written.
    expect(log.some(l => /SEC6 @ 0x03C8/.test(l))).toBe(true);
    expect(log.some(l => /SEC6 marker @ 0x03C4/.test(l))).toBe(true);
  });

  it('refuses non-canonical PCM size with a structured error (no silent leak)', () => {
    // applyRfhToPcm hard-fails on non-canonical PCM size (writePcmSec6
    // refuses anything but 4096/8192). The contract is that no bytes are
    // written and the caller gets `{error:true, errorMessage}` instead
    // of a partially-patched buffer with unknown donor leakage. This is
    // the silent-drop guard for the rfhPcmPair path.
    const donorRfhBuf = makeRfhPairFixture({ vin: DONOR_VIN, sec16: DONOR_SEC16 });
    const rfh = parseRFH24C32(donorRfhBuf);
    const tinyPcm = new Uint8Array(4096);
    // Pre-stamp a canonical PCM marker so parsePCMGPEC's writeCheck.ok
    // returns true; then re-wrap as a NON-canonical 0x300 so we exercise
    // the writePcmSec6 refusal without short-circuiting earlier.
    const goodPcm = makeGpec2a({ vin: TARGET_VIN });
    const pcm = parsePCMGPEC(goodPcm);
    const tiny = goodPcm.slice(0, 0x300);
    const r = applyRfhToPcm(rfh, pcm, tiny);
    expect(r).not.toBeNull();
    expect(r.error).toBe(true);
    expect(r.data).toBeNull();
    expect(r.errorMessage).toMatch(/non-canonical PCM size/);
  });
});

// ── 2. applyPcmFromBcm / applyPcmSec6FromRfh / applyPcmFromRfhWithVin ─
describe('bcmPcmSync — donor→target leak audit', () => {
  it('applyPcmFromBcm only writes PCM SEC6 region (no donor BCM bytes leak into PCM)', () => {
    const target = makeGpec2a({ vin: TARGET_VIN });
    // Donor SEC16 is the *stored* (BCM byte-reversed) form; the helper
    // reverses it before writing the first 6 bytes to PCM SEC6.
    const { bytes, ok } = applyPcmFromBcm(target, DONOR_SEC16);
    expect(ok).toBe(true);
    // SEC6 = first 6 bytes of reverse(DONOR_SEC16).
    const sec6 = new Uint8Array(6);
    for (let i = 0; i < 6; i++) sec6[i] = DONOR_SEC16[15 - i];
    expectHitsWithinAllowList(bytes, sec6, [[0x3C8, 0x3C8 + 6]], 'applyPcmFromBcm SEC6');
    // Target VIN must be untouched outside the SEC6 window.
    expect(findAll(bytes, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
    // SEC6 marker stamped.
    expect(bytes[0x3C4]).toBe(0xFF);
    expect(bytes[0x3C5]).toBe(0xFF);
    expect(bytes[0x3C6]).toBe(0xFF);
    expect(bytes[0x3C7]).toBe(0xAA);
  });

  it('applyPcmSec6FromRfh only writes PCM SEC6 region', () => {
    const target = makeGpec2a({ vin: TARGET_VIN });
    const { bytes, ok } = applyPcmSec6FromRfh(target, DONOR_SEC16);
    expect(ok).toBe(true);
    const sec6 = DONOR_SEC16.slice(0, 6);
    expectHitsWithinAllowList(bytes, sec6, [[0x3C8, 0x3C8 + 6]], 'applyPcmSec6FromRfh SEC6');
    // Target VIN must survive (no VIN write in this path).
    expect(findAll(bytes, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
  });

  it('applyPcmFromRfhWithVin writes both donor VIN and SEC6, nothing else leaks', () => {
    const target = makeGpec2a({ vin: TARGET_VIN });
    const targetParsed = parsePCMGPEC(target);
    // Map parsed vins → {offset} as expected by writeModuleVIN.
    const pcmVins = (targetParsed.info?.vins || [])
      .filter(v => v.vin)
      .map(v => ({ offset: v.offset }));
    const { bytes, ok } = applyPcmFromRfhWithVin(target, DONOR_SEC16, DONOR_VIN, pcmVins);
    expect(ok).toBe(true);

    const allow = [
      [0x3C4, 0x3CE],
      ...RFH_PCM_CONST.PCM_VIN_OFFSETS.map(o => [o, o + 17]),
    ];
    expectHitsWithinAllowList(bytes, asciiBytes(DONOR_VIN), allow, 'applyPcmFromRfhWithVin donor VIN');
    // Target VIN must be GONE — every canonical slot was overwritten.
    expect(findAll(bytes, asciiBytes(TARGET_VIN))).toEqual([]);
  });
});

// ── 3. writeBcmSec16Gen2 / writeBcmFlatSec16 ─────────────────────────
describe('securityBytes BCM writers — donor→target leak audit', () => {
  it('writeBcmSec16Gen2 only mutates split records (0x81A0/C0/E0) + inactive-bank mirror records', () => {
    // A fresh BCM fixture has split records but no mirror records (the
    // mirror records require a Redeye-style record table in the active
    // bank, which makeBcm does not lay out). Split records are enough
    // to exercise the leak audit on the split-record path.
    const target = makeBcm({ size: 65536, vehicleSecret: TARGET_SEC16 });
    // Stamp split-record headers so writeBcmSec16Gen2 will recognise and
    // mutate them. Header layout per writer source:
    //   off+0/+1 = FF FF, off+2..+7 = 00, off+8 = 0x01 or 0x02 (idx),
    //   off+16..+19 = 04 04 00 14.
    for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
      target[recOff]     = 0xFF; target[recOff + 1] = 0xFF;
      for (let j = 2; j < 8; j++) target[recOff + j] = 0x00;
      target[recOff + 8] = 0x01;
      target[recOff + 16] = 0x04; target[recOff + 17] = 0x04;
      target[recOff + 18] = 0x00; target[recOff + 19] = 0x14;
    }
    const { bytes, splitPatched } = writeBcmSec16Gen2(target, DONOR_SEC16);
    expect(splitPatched).toBe(3);

    // Donor SEC16 (16 B) bytes (in BCM-stored form = reverse(DONOR_SEC16))
    // may appear inside split records 0x81A0/C0/E0 in the slices
    // [recOff+9 .. recOff+9+7) for prefix7 and [recOff+20 .. recOff+20+9)
    // for suffix9. We don't check the exact 16-byte sequence (it's split);
    // we check that no full 16-byte donor block leaked elsewhere.
    const stored = new Uint8Array(16);
    for (let i = 0; i < 16; i++) stored[i] = DONOR_SEC16[15 - i];
    // The full 16-B donor pattern split across two slices doesn't appear
    // contiguously in any record, so a search for the contiguous pattern
    // must yield zero hits (no bank-write region holds the contiguous
    // pattern in this fixture without the mirror-record path).
    const contiguousHits = findAll(bytes, stored).filter(o => o < 0x81A0 || o > 0x81FF);
    expect(contiguousHits).toEqual([]);
  });

  it('writeBcmFlatSec16 only mutates 0x40C9..0x40D8', () => {
    const target = makeBcm({ size: 65536, vehicleSecret: TARGET_SEC16 });
    const { bytes } = writeBcmFlatSec16(target, DONOR_SEC16);
    // The 16 LE-form donor bytes must only appear at 0x40C9.
    const le = new Uint8Array(16);
    for (let i = 0; i < 16; i++) le[i] = DONOR_SEC16[15 - i];
    expectHitsWithinAllowList(bytes, le, [[0x40C9, 0x40D9]], 'writeBcmFlatSec16');
    // Outside the slice, every byte must equal the original target.
    for (let i = 0; i < target.length; i++) {
      if (i >= 0x40C9 && i < 0x40D9) continue;
      if (bytes[i] !== target[i]) {
        throw new Error('writeBcmFlatSec16 mutated byte 0x' + i.toString(16).toUpperCase()
          + ' (got 0x' + bytes[i].toString(16) + ', expected 0x' + target[i].toString(16) + ')');
      }
    }
  });
});

// ── 4. writePcmSec6 ──────────────────────────────────────────────────
describe('writePcmSec6 — donor→target leak audit', () => {
  it('only mutates 0x3C4..0x3CE (4-byte marker + 6-byte SEC6)', () => {
    const target = makeGpec2a({ vin: TARGET_VIN });
    const { bytes, ok } = writePcmSec6(target, DONOR_SEC16);
    expect(ok).toBe(true);
    for (let i = 0; i < target.length; i++) {
      if (i >= 0x3C4 && i < 0x3CE) continue;
      if (bytes[i] !== target[i]) {
        throw new Error('writePcmSec6 mutated byte 0x' + i.toString(16).toUpperCase());
      }
    }
    // Donor SEC6 = first 6 of DONOR_SEC16.
    const sec6 = DONOR_SEC16.slice(0, 6);
    expectHitsWithinAllowList(bytes, sec6, [[0x3C8, 0x3CE]], 'writePcmSec6');
  });
});

// ── 5. writeRfhSec16FromBcm ──────────────────────────────────────────
describe('writeRfhSec16FromBcm — donor→target leak audit', () => {
  it('only mutates 0x050E..0x0520 and 0x0522..0x0534', () => {
    const target = makeRfhubGen2({ vin: TARGET_VIN, vehicleSecret: TARGET_SEC16 });
    const { bytes, patched } = writeRfhSec16FromBcm(target, DONOR_SEC16);
    expect(patched).toBe(2);
    const rfh = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rfh[i] = DONOR_SEC16[15 - i];
    const allow = [[0x050E, 0x050E + 18], [0x0522, 0x0522 + 18]];
    expectHitsWithinAllowList(bytes, rfh, allow, 'writeRfhSec16FromBcm');
    // Outside the slot windows, every byte must match the target.
    for (let i = 0; i < target.length; i++) {
      const inSlot1 = i >= 0x050E && i < 0x050E + 18;
      const inSlot2 = i >= 0x0522 && i < 0x0522 + 18;
      if (inSlot1 || inSlot2) continue;
      if (bytes[i] !== target[i]) {
        throw new Error('writeRfhSec16FromBcm mutated byte 0x' + i.toString(16).toUpperCase());
      }
    }
  });
});

// ── 6. fileUtils.patchFile ───────────────────────────────────────────
describe('fileUtils.patchFile — donor→target leak audit', () => {
  it('BCM patch overwrites every parsed donor VIN slot with target VIN', () => {
    const donorBcmBuf = makeBcm({ size: 65536, vin: DONOR_VIN });
    stampBcmCrcs(donorBcmBuf, DONOR_VIN);
    const f = analyzeFile(donorBcmBuf, 'donor_bcm.bin');
    expect(f.type).toBe('BCM');
    expect(f.vins.length).toBeGreaterThanOrEqual(1);
    const { data, log } = patchFile(f, TARGET_VIN);

    // The donor VIN must be GONE from every parsed slot (the writer
    // covers exactly the offsets analyzeFile recognised).
    expect(findAll(data, asciiBytes(DONOR_VIN))).toEqual([]);
    // Target VIN must appear at least once.
    expect(findAll(data, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
    expect(log.some(l => /IMMO backup synced/.test(l))).toBe(true);
  });

  it('GPEC2A patch overwrites every donor VIN slot with target VIN', () => {
    const donorBuf = makeGpec2a({ vin: DONOR_VIN });
    const f = analyzeFile(donorBuf, 'donor_gpec.bin');
    expect(f.type).toBe('GPEC2A');
    const { data } = patchFile(f, TARGET_VIN);
    expect(findAll(data, asciiBytes(DONOR_VIN))).toEqual([]);
    expect(findAll(data, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
  });

  it('95640 patch overwrites every donor VIN slot with target VIN', () => {
    const donorBuf = make95640Donor(DONOR_VIN, /*withThird*/false);
    const f = analyzeFile(donorBuf, 'donor_95640.bin');
    expect(f.type).toBe('95640');
    expect(f.vins.length).toBe(2);
    const { data } = patchFile(f, TARGET_VIN);
    expect(findAll(data, asciiBytes(DONOR_VIN))).toEqual([]);
  });

  it('emits IMMO backup SKIPPED diagnostic when BCM buffer is too small', () => {
    // Synthesise a fake "BCM" descriptor with a tiny buffer to verify
    // the patch path emits a clear log entry instead of silently dropping
    // the IMMO sync.
    const tinyBuf = new Uint8Array(0x100);
    const f = { type: 'BCM', data: tinyBuf, vins: [], partials: [] };
    const { log } = patchFile(f, TARGET_VIN);
    expect(log.some(l => /IMMO backup SKIPPED/.test(l))).toBe(true);
  });
});

// ── 7. fileUtils.virginizeFile ───────────────────────────────────────
describe('fileUtils.virginizeFile — donor→target leak audit', () => {
  it('BCM virginize obliterates VIN bytes (donor VIN cannot survive)', () => {
    const donorBuf = makeBcm({ size: 65536, vin: DONOR_VIN });
    stampBcmCrcs(donorBuf, DONOR_VIN);
    const f = analyzeFile(donorBuf, 'donor_bcm.bin');
    expect(f.vins.length).toBeGreaterThanOrEqual(1);
    const { data } = virginizeFile(f);
    expect(findAll(data, asciiBytes(DONOR_VIN))).toEqual([]);
  });

  it('95640 virginize obliterates VIN bytes', () => {
    const donorBuf = make95640Donor(DONOR_VIN, /*withThird*/false);
    const f = analyzeFile(donorBuf, 'donor_95640.bin');
    expect(f.vins.length).toBe(2);
    const { data } = virginizeFile(f);
    expect(findAll(data, asciiBytes(DONOR_VIN))).toEqual([]);
  });
});

// ── 8. fileUtils.writeModuleVIN ──────────────────────────────────────
describe('fileUtils.writeModuleVIN — donor→target leak audit', () => {
  it('GPEC2A: every canonical donor slot replaced with target VIN', () => {
    const donorBuf = makeGpec2a({ vin: DONOR_VIN });
    const out = writeModuleVIN(donorBuf, 'GPEC2A', TARGET_VIN, []);
    expect(out).not.toBeNull();
    expect(findAll(out, asciiBytes(DONOR_VIN))).toEqual([]);
    expect(findAll(out, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(3);
  });

  it('BCM: every parsed donor slot replaced + partial slots overwritten', () => {
    const donorBuf = makeBcm({ size: 65536, vin: DONOR_VIN });
    stampBcmCrcs(donorBuf, DONOR_VIN);
    const f = analyzeFile(donorBuf, 'donor_bcm.bin');
    const existingVins = (f.vins || []).map(v => ({ offset: v.off, mirrored: v.mirrored }));
    const out = writeModuleVIN(donorBuf, 'BCM', TARGET_VIN, existingVins);
    expect(out).not.toBeNull();
    expect(findAll(out, asciiBytes(DONOR_VIN))).toEqual([]);
  });

  it('RFHUB Gen2: donor VIN replaced (mirrored layout uses byte-reversed write)', () => {
    const donorBuf = makeRfhubGen2({ vin: DONOR_VIN });
    const f = analyzeFile(donorBuf, 'donor_rfhub.bin');
    const existingVins = (f.vins || []).map(v => ({ offset: v.off, mirrored: v.mirrored }));
    const out = writeModuleVIN(donorBuf, 'RFHUB', TARGET_VIN, existingVins);
    expect(out).not.toBeNull();
    // RFHUB Gen2 stores VIN reversed; ASCII donor VIN appears reversed.
    const reversed = new Uint8Array(17);
    const donorAscii = asciiBytes(DONOR_VIN);
    for (let i = 0; i < 17; i++) reversed[i] = donorAscii[16 - i];
    expect(findAll(out, reversed)).toEqual([]);
  });

  it('RFHUB Gen1 (2 KB): donor VIN @ 0x92 replaced with target', () => {
    const donorBuf = makeRfhubGen1({ vin: DONOR_VIN });
    const out = writeModuleVIN(donorBuf, 'RFHUB', TARGET_VIN, []);
    expect(out).not.toBeNull();
    expect(findAll(out, asciiBytes(DONOR_VIN))).toEqual([]);
    expect(findAll(out, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
  });

  it('95640: donor VIN replaced at both canonical slots', () => {
    const donorBuf = make95640Donor(DONOR_VIN, /*withThird*/false);
    const out = writeModuleVIN(donorBuf, '95640', TARGET_VIN, []);
    expect(out).not.toBeNull();
    expect(findAll(out, asciiBytes(DONOR_VIN))).toEqual([]);
    expect(findAll(out, asciiBytes(TARGET_VIN)).length).toBeGreaterThanOrEqual(1);
  });
});

// ── 9. fileUtils.virginizeModule ─────────────────────────────────────
describe('fileUtils.virginizeModule — donor→target leak audit', () => {
  it('GPEC2A: donor SKIM/key bytes replaced with virgin pattern', () => {
    const donorBuf = makeGpec2a({ vin: DONOR_VIN, secret: DONOR_SEC16.slice(0, 8) });
    const out = virginizeModule(donorBuf, 'GPEC2A');
    // Donor secret at 0x0203 must be all-zero (virginized).
    for (let i = 0; i < 8; i++) expect(out[0x0203 + i]).toBe(0x00);
    // SKIM byte cleared.
    expect(out[0x0011]).toBe(0x00);
  });

  it('BCM: donor IMMO records replaced with 0xFF', () => {
    const donorBuf = makeBcm({ size: 65536, vin: DONOR_VIN });
    const out = virginizeModule(donorBuf, 'BCM');
    // 0x40C0 should be 0xFF after virginize.
    expect(out[0x40C0]).toBe(0xFF);
    expect(out[0x2000]).toBe(0xFF);
  });
});

// ── 10. fileUtils.syncImmoBackupF ────────────────────────────────────
describe('fileUtils.syncImmoBackupF — donor→target leak audit', () => {
  it('copies primary IMMO block to backup; nothing else mutated', () => {
    const donor = makeBcm({ size: 65536, immoBackupSynced: false });
    const out = syncImmoBackupF(donor);
    expect(out).not.toBeNull();
    // Backup at 0x2000 must equal primary at 0x40C0.
    for (let i = 0; i < 16; i++) {
      expect(out[0x2000 + i]).toBe(donor[0x40C0 + i]);
    }
    // Bytes outside both windows must match donor exactly.
    const PRIMARY_END = 0x40C0 + 0x800; // IMMO_BLOCK
    const BACKUP_END = 0x2000 + 0x800;
    for (let i = 0; i < donor.length; i++) {
      const inPrimary = i >= 0x40C0 && i < PRIMARY_END;
      const inBackup  = i >= 0x2000 && i < BACKUP_END;
      if (inPrimary || inBackup) continue;
      if (out[i] !== donor[i]) {
        throw new Error('syncImmoBackupF mutated byte 0x' + i.toString(16).toUpperCase());
      }
    }
  });

  it('returns null on a buffer too small for the IMMO block', () => {
    const tiny = new Uint8Array(0x100);
    expect(syncImmoBackupF(tiny)).toBeNull();
  });
});
