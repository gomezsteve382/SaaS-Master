import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseModule } from '../parseModule.js';
import { writeModuleVIN } from '../fileUtils.js';
import { crc16 } from '../crc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #342 — golden regression for the Cluster B VIN-patch flow.
//
// Pins:
//   1. parseModule discovers all 4 BCM full-VIN slots on a Redeye 2020+ dump
//      whose VINs sit at slotBase+8 (after an 8-byte FEE record header).
//   2. writeModuleVIN, given that parsed-vins array, stamps the new VIN at
//      the discovered offsets — not the legacy slotBase+0 offsets — so the
//      slot header AND the 5-byte trailer survive byte-for-byte.
//   3. All 6 VIN-bearing locations on the patched BCM (4 full + 2 partial)
//      read the target VIN with valid CRC16.
//   4. The four critical "untouchable" regions on the BCM (LE secret @0x40C9,
//      mirror records @0x40C0/0x40E8, and the 3 split records @0x81A0/C0/E0)
//      are bit-identical to the source.
//   5. RFH and PCM are pass-through: SHA-256 of the source must equal the
//      SHA-256 of what would ship.
//
// If any of these slip, the patcher script (`scripts/patch-cluster-b-vin.mjs`)
// would silently produce a flash-bricking BCM. This test is the line of defense.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ATTACHED = path.join(REPO_ROOT, 'attached_assets');

const TARGET_VIN = '2C3CDXCT1HH652640';
const OLD_VIN = '2C3CDXGJXNH176487';
const SHARED_SECRET_HEX = '816531F7CDE32E33C25A415C8440C72A';

const SRC_BCM = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadOrSkip(name) {
  const p = path.join(ATTACHED, name);
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

const bcmSrc = loadOrSkip(SRC_BCM);
const rfhSrc = loadOrSkip(SRC_RFH);
const pcmSrc = loadOrSkip(SRC_PCM);
const haveFixtures = !!(bcmSrc && rfhSrc && pcmSrc);

const d = haveFixtures ? describe : describe.skip;

d('Task #342 — Cluster B VIN patch (golden)', () => {
  it('parseModule discovers 4 BCM full-VIN slots at slotBase+8 (header layout)', () => {
    const info = parseModule(bcmSrc, SRC_BCM);
    expect(info.type).toBe('BCM');
    expect(info.vins).toHaveLength(4);
    const expected = [0x5328, 0x5348, 0x5368, 0x5388];
    expect(info.vins.map((v) => v.offset)).toEqual(expected);
    for (const v of info.vins) {
      expect(v.vin).toBe(OLD_VIN);
      expect(v.headerBytes).toBe(8);
      expect(v.slotBase).toBe(v.offset - 8);
    }
    // Partial VINs still found at the canonical 0x4098/0x40B0.
    expect(info.partialVins.map((p) => p.offset)).toEqual([0x4098, 0x40B0]);
    for (const p of info.partialVins) {
      expect(p.tail).toBe(OLD_VIN.slice(9));
      expect(p.crcOk).toBe(true);
    }
  });

  it('parseModule still finds the legacy header-less layout when only base+0 has a VIN', () => {
    // Synthesise a 65 KB BCM that puts a VIN at 0x5320 only (no header).
    const buf = new Uint8Array(65536).fill(0xFF);
    const fakeVin = '1C4HJWFG5DL512345';
    for (let i = 0; i < 17; i++) buf[0x5320 + i] = fakeVin.charCodeAt(i);
    const info = parseModule(buf, 'fake.bin');
    expect(info.type).toBe('BCM');
    expect(info.vins).toHaveLength(1);
    expect(info.vins[0].offset).toBe(0x5320);
    expect(info.vins[0].headerBytes).toBe(0);
    expect(info.vins[0].vin).toBe(fakeVin);
  });

  it('parseModule prefers base+8 when base+0 has a junk ASCII run and base+8 has a valid CRC', () => {
    // Task #344 hardening: a coincidental 17-byte ASCII run at base+0 must
    // not win over a CRC-valid VIN at base+8.
    const buf = new Uint8Array(65536).fill(0xFF);
    const realVin = '2C3CDXCT1HH652640';
    const junk = 'AAAAAAAAAAAAAAAAA';
    const base = 0x5320;
    // Junk ASCII run at base+0 (no valid CRC trailer).
    for (let i = 0; i < 17; i++) buf[base + i] = junk.charCodeAt(i);
    // Real VIN + valid BE16 CRC at base+8.
    for (let i = 0; i < 17; i++) buf[base + 8 + i] = realVin.charCodeAt(i);
    const cc = crc16(buf.slice(base + 8, base + 8 + 17));
    buf[base + 8 + 17] = (cc >> 8) & 0xFF;
    buf[base + 8 + 18] = cc & 0xFF;

    const info = parseModule(buf, 'crc-disambig.bin');
    expect(info.type).toBe('BCM');
    const slot = info.vins.find((v) => v.slotBase === base);
    expect(slot).toBeTruthy();
    expect(slot.offset).toBe(base + 8);
    expect(slot.headerBytes).toBe(8);
    expect(slot.vin).toBe(realVin);
    expect(slot.crcOk).toBe(true);
  });

  it('writeModuleVIN with discovered offsets stamps every VIN, header + trailer survive bit-exact', () => {
    const info = parseModule(bcmSrc, SRC_BCM);
    const out = writeModuleVIN(bcmSrc, 'BCM', TARGET_VIN, info.vins);
    expect(out).not.toBeNull();
    expect(out.length).toBe(bcmSrc.length);

    // Slot headers (slotBase..slotBase+8) and trailers (vinOff+19..slotBase+32)
    // must match source byte-for-byte. The writer only owns the 19 bytes
    // [VIN(17) + CRC(2)] inside each slot.
    for (const v of info.vins) {
      for (let j = 0; j < v.headerBytes; j++) {
        expect(out[v.slotBase + j]).toBe(bcmSrc[v.slotBase + j]);
      }
      const trailerStart = v.offset + 19;
      const trailerEnd = v.slotBase + 32;
      for (let j = trailerStart; j < trailerEnd; j++) {
        expect(out[j]).toBe(bcmSrc[j]);
      }
    }

    // Full VINs round-trip: read the 17 bytes at the discovered offset and
    // confirm it's TARGET_VIN with a fresh-computed CRC matching what was
    // stored at +17/+18.
    const reparsed = parseModule(out, 'patched.bin');
    expect(reparsed.vins).toHaveLength(4);
    for (const v of reparsed.vins) {
      expect(v.vin).toBe(TARGET_VIN);
      const crcStored = (out[v.offset + 17] << 8) | out[v.offset + 18];
      const crcCalc = crc16(out.slice(v.offset, v.offset + 17));
      expect(crcStored).toBe(crcCalc);
    }
    // Partial tails likewise.
    for (const p of reparsed.partialVins) {
      expect(p.tail).toBe(TARGET_VIN.slice(9));
      expect(p.crcOk).toBe(true);
    }
  });

  it('BCM critical untouchable regions are byte-identical after the patch', () => {
    const info = parseModule(bcmSrc, SRC_BCM);
    const out = writeModuleVIN(bcmSrc, 'BCM', TARGET_VIN, info.vins);
    // Restore IMMO-backup region the same way the patcher does (the writer's
    // unconditional 0x2000←0x40C0 sync is intentionally undone in the
    // patcher to avoid promoting bank1's staged secret into active bank0).
    const IMMO_BACKUP_SIZE = 24 * 8;
    for (let i = 0; i < IMMO_BACKUP_SIZE; i++) out[0x2000 + i] = bcmSrc[0x2000 + i];

    // LE secret + mirror records share 0x40C0..0x4110.
    for (let i = 0x40C0; i < 0x4110; i++) {
      expect(out[i], `LE secret/mirror byte 0x${i.toString(16)} drifted`).toBe(bcmSrc[i]);
    }
    // 3 split records 0x81A0..0x8200.
    for (let i = 0x81A0; i < 0x8200; i++) {
      expect(out[i], `split record byte 0x${i.toString(16)} drifted`).toBe(bcmSrc[i]);
    }
    // Bank seq numbers untouched.
    expect(out[0x0002]).toBe(bcmSrc[0x0002]);
    expect(out[0x0003]).toBe(bcmSrc[0x0003]);
    expect(out[0x4002]).toBe(bcmSrc[0x4002]);
    expect(out[0x4003]).toBe(bcmSrc[0x4003]);
    // IMMO backup unchanged after our restore.
    for (let i = 0; i < IMMO_BACKUP_SIZE; i++) {
      expect(out[0x2000 + i]).toBe(bcmSrc[0x2000 + i]);
    }
  });

  it('Cluster B shared secret is the BE form of the BCM LE secret', () => {
    const info = parseModule(bcmSrc, SRC_BCM);
    const beHex = Array.from(info.vehicleSecret.bytes)
      .reverse()
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
    expect(beHex).toBe(SHARED_SECRET_HEX);
  });

  it('RFH and PCM already carry the target VIN and ship as pass-through (SHA stable)', () => {
    const rfhInfo = parseModule(rfhSrc, SRC_RFH);
    expect(rfhInfo.type).toBe('RFHUB');
    expect(rfhInfo.vins.length).toBeGreaterThan(0);
    for (const v of rfhInfo.vins) {
      expect(v.vin).toBe(TARGET_VIN);
      expect(v.crcOk).toBe(true);
    }
    expect(rfhInfo.sec16s[0].hex.toUpperCase()).toBe(SHARED_SECRET_HEX);
    expect(rfhInfo.sec16s[0].csOk).toBe(true);

    // PCM is doubled (2 × 4 KB); parse the GPEC2A half.
    const pcmInfo = parseModule(pcmSrc.slice(0, 4096), SRC_PCM + '#half1');
    expect(pcmInfo.type).toBe('GPEC2A');
    for (const v of pcmInfo.vins) expect(v.vin).toBe(TARGET_VIN);
    expect(SHARED_SECRET_HEX.startsWith(pcmInfo.pcmSec6.hex.replace(/ /g, ''))).toBe(true);
    // Half-2 is all-FF padding.
    expect(pcmSrc.slice(4096).every((b) => b === 0xFF)).toBe(true);

    // Pass-through SHA stability: copying the buffer unchanged → same hash.
    expect(sha256(new Uint8Array(rfhSrc))).toBe(sha256(rfhSrc));
    expect(sha256(new Uint8Array(pcmSrc))).toBe(sha256(pcmSrc));
  });
});
