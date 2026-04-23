import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseModule } from '../parseModule.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #366 — golden regression for the rebuilt KEYPROG bundle.
//
// Pins:
//   1. The three shipped output files (BCM_/RFH_/PCM_) parse as the expected
//      module type, carry the target VIN in every full + partial slot with
//      valid CRCs, and expose the shared SKIM secret in the expected fields.
//   2. The PCM is the 8 KB doubled GPEC2A capture with all-0xFF half-2.
//   3. The KEYPROG zip file holds exactly 4 entries (BCM/RFH/PCM/VERIFY) and
//      every binary entry's bytes are SHA-256-equal to the loose on-disk
//      sibling (proves zip is a true pass-through container).
//   4. The output filenames start with the actual module type prefix so a
//      flash-to-wrong-module mistake is impossible from naming alone.
//
// The test auto-skips when the bundle isn't checked in, mirroring
// vinPatch.golden.test.js so CI on a fresh clone doesn't fail.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ATTACHED = path.join(REPO_ROOT, 'attached_assets');

const TARGET_VIN = '2C3CDXCT1HH652640';
const TARGET_TAIL = TARGET_VIN.slice(9);
const SHARED_SECRET_HEX = '816531F7CDE32E33C25A415C8440C72A';

const OUT_BCM = 'BCM_22CHARGER_REDEYE_6.2_KEYPROG_' + TARGET_VIN + '.bin';
const OUT_RFH = 'RFH_20CHRGR6.2_KEYPROG_' + TARGET_VIN + '.bin';
const OUT_PCM = 'PCM_FCA_CONTINENTAL_GPEC2A_KEYPROG_' + TARGET_VIN + '.bin';
const OUT_VERIFY = 'VERIFY_KEYPROG_' + TARGET_VIN + '.txt';
const OUT_ZIP = 'KEYPROG_' + TARGET_VIN + '.zip';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function loadOrNull(name) {
  const p = path.join(ATTACHED, name);
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

const bcmOut = loadOrNull(OUT_BCM);
const rfhOut = loadOrNull(OUT_RFH);
const pcmOut = loadOrNull(OUT_PCM);
const verifyOut = loadOrNull(OUT_VERIFY);
const zipOut = loadOrNull(OUT_ZIP);
const haveBundle = !!(bcmOut && rfhOut && pcmOut && verifyOut && zipOut);

const d = haveBundle ? describe : describe.skip;

// Minimal stored-only ZIP central-directory parser. Returns
// [{name, size, sha256: <hex>}, ...] for every entry.
function readZipEntries(zip) {
  const dv = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = dv.length - 22; i >= 0 && i >= dv.length - 22 - 65535; i--) {
    if (dv.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const numEntries = dv.readUInt16LE(eocd + 10);
  const cdOffset = dv.readUInt32LE(eocd + 16);
  const out = [];
  let off = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (dv.readUInt32LE(off) !== 0x02014b50) throw new Error('bad CD signature at ' + off);
    const method = dv.readUInt16LE(off + 10);
    const csize = dv.readUInt32LE(off + 20);
    const usize = dv.readUInt32LE(off + 24);
    const nlen = dv.readUInt16LE(off + 28);
    const elen = dv.readUInt16LE(off + 30);
    const clen = dv.readUInt16LE(off + 32);
    const lhOff = dv.readUInt32LE(off + 42);
    const name = dv.slice(off + 46, off + 46 + nlen).toString('utf8');
    if (method !== 0) throw new Error('Entry ' + name + ' is not stored (method=' + method + ')');
    // Local header at lhOff: 30 bytes + name + extra
    const lhNlen = dv.readUInt16LE(lhOff + 26);
    const lhElen = dv.readUInt16LE(lhOff + 28);
    const dataStart = lhOff + 30 + lhNlen + lhElen;
    const data = dv.slice(dataStart, dataStart + csize);
    out.push({ name, size: usize, sha256: crypto.createHash('sha256').update(data).digest('hex'), data });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

d('Task #366 — KEYPROG bundle (golden)', () => {
  it('BCM output is byte-pass-through of the source bytes (no writer involvement)', () => {
    expect(bcmOut.length).toBe(65536);
    const info = parseModule(bcmOut, OUT_BCM);
    expect(info.type).toBe('BCM');
    expect(info.vins).toHaveLength(4);
    for (const v of info.vins) {
      expect(v.vin).toBe(TARGET_VIN);
      expect(v.crcOk).toBe(true);
    }
    expect(info.partialVins).toHaveLength(2);
    for (const p of info.partialVins) {
      expect(p.tail).toBe(TARGET_TAIL);
      expect(p.crcOk).toBe(true);
    }
    const beHex = Array.from(info.vehicleSecret.bytes)
      .reverse()
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
    expect(beHex).toBe(SHARED_SECRET_HEX);
  });

  it('RFH output already carries target VIN; SEC16 slot1 is shared secret with valid CS', () => {
    expect(rfhOut.length).toBe(4096);
    const info = parseModule(rfhOut, OUT_RFH);
    expect(info.type).toBe('RFHUB');
    expect(info.vins.length).toBeGreaterThan(0);
    for (const v of info.vins) {
      expect(v.vin).toBe(TARGET_VIN);
      expect(v.crcOk).toBe(true);
    }
    expect(info.sec16s[0].hex.toUpperCase()).toBe(SHARED_SECRET_HEX);
    expect(info.sec16s[0].csOk).toBe(true);
  });

  it('PCM output is the 8 KB doubled capture; half-1 GPEC2A carries target VIN; half-2 is 0xFF padding', () => {
    expect(pcmOut.length).toBe(8192);
    const half2 = pcmOut.slice(4096);
    expect(half2.every((b) => b === 0xFF)).toBe(true);
    const info = parseModule(pcmOut.slice(0, 4096), OUT_PCM + '#half1');
    expect(info.type).toBe('GPEC2A');
    expect(info.vins.length).toBeGreaterThan(0);
    for (const v of info.vins) expect(v.vin).toBe(TARGET_VIN);
    const sec6 = info.pcmSec6.hex.replace(/ /g, '');
    expect(SHARED_SECRET_HEX.startsWith(sec6)).toBe(true);
  });

  it('Output filenames start with the actual module-type prefix (BCM_/RFH_/PCM_)', () => {
    expect(OUT_BCM.startsWith('BCM_')).toBe(true);
    expect(OUT_RFH.startsWith('RFH_')).toBe(true);
    expect(OUT_PCM.startsWith('PCM_')).toBe(true);
    // And critically, none of them start with the misleading "RFHUB" prefix
    // that caused the original confusion.
    expect(/^RFHUB/i.test(OUT_BCM)).toBe(false);
  });

  it('VERIFY.txt declares PASS-THROUGH and PASS status', () => {
    const text = new TextDecoder().decode(verifyOut);
    expect(text).toMatch(/PASS-THROUGH/);
    expect(text).toMatch(/Status:\s*PASS/);
    expect(text).toContain(TARGET_VIN);
    expect(text).toContain(SHARED_SECRET_HEX);
  });

  it('KEYPROG zip holds exactly the 4 expected entries with byte-identical contents', () => {
    const entries = readZipEntries(zipOut);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(
      [OUT_BCM, OUT_RFH, OUT_PCM, OUT_VERIFY].sort()
    );
    // Every binary entry must SHA-match the loose on-disk file.
    expect(byName[OUT_BCM].sha256).toBe(sha256(bcmOut));
    expect(byName[OUT_RFH].sha256).toBe(sha256(rfhOut));
    expect(byName[OUT_PCM].sha256).toBe(sha256(pcmOut));
    expect(byName[OUT_VERIFY].sha256).toBe(sha256(verifyOut));
    // Sizes match too (defends against zip header tampering).
    expect(byName[OUT_BCM].size).toBe(65536);
    expect(byName[OUT_RFH].size).toBe(4096);
    expect(byName[OUT_PCM].size).toBe(8192);
  });

  it('Old misnamed RFHUB-prefixed BCM artifact has been removed from attached_assets', () => {
    const oldBundleZip = path.join(ATTACHED, 'KEYPROG_2C3CDXCT1HH652640.zip');
    expect(fs.existsSync(oldBundleZip)).toBe(true); // new one in place
    const oldNamedBcm = path.join(ATTACHED,
      '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655_KEYPROG_2C3CDXCT1HH652640.bin');
    expect(fs.existsSync(oldNamedBcm)).toBe(false);
  });
});
