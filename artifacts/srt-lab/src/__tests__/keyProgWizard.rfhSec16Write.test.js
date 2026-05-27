/* Task #902 — RFHUB SEC16 write path in runKeyProgPatch.
 *
 * Previously the wizard never wrote the RFHUB SEC16 — it only validated
 * that the RFHUB's SEC16 matched the BCM-derived secret, failing the check
 * if they differed. The user could still download the ZIP (when other checks
 * passed), flash the unchanged RFHUB, and get a silent ECU rejection.
 *
 * These tests cover the three new paths:
 *   (a) Mismatched RFHUB SEC16 → wizard auto-patches it (round-trip verified).
 *   (b) Mismatched RFHUB but Gen2 header missing → blocking error, ok=false.
 *   (c) Already-matched RFHUB → unchanged pass-through (byte-identical SHA).
 *   (d) XC2268-class RFHUB → explicit "unsupported" blocking error, ok=false.
 *   (e) VERIFY.txt RFHUB_SEC16 line present in all cases.
 *
 * Task #903 — Real bench fixture golden test.
 *   Adds a golden test that drives the full wizard with a real mismatched donor
 *   RFHUB (20CHRGR6.2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640_1776226954878.bin,
 *   SEC16 = AB8015D77ED943C1AB45EC16896969DA) paired with the Cluster B BCM
 *   (secret = 816531F7CDE32E33C25A415C8440C72A). Pinned to fixture SHA-256.
 *   Auto-skips when the attached_assets files are absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runKeyProgPatch } from '../lib/keyProgWizard.js';
import { parseModule } from '../lib/parseModule.js';
import {
  makeBcm,
  makeRfhubGen2,
  makeGpec2a,
} from '../lib/__fixtures__/buildFixtures.js';
import { makeXc2268Fixture } from '../lib/xc2268Rfhub.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Two distinct 16-byte secrets. BCM stores in LE, RFHUB stores in BE (= reverse of BCM LE).
const BCM_SECRET_LE = new Uint8Array([
  0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44,
  0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xFF, 0xEE,
]);
const BCM_SECRET_BE = new Uint8Array(Array.from(BCM_SECRET_LE).reverse());

// A completely different secret for the "wrong" RFHUB.
const WRONG_RFH_SECRET = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
]);

const BCM_SECRET_BE_HEX = Array.from(BCM_SECRET_BE)
  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

const PCM_SEC6 = BCM_SECRET_BE.slice(0, 6);

const SOURCE_VIN = '2C3CDXKT3FH796320';
const TARGET_VIN = '1C4BJWFG3JL901234';

function makeBcmWithSecret() {
  return makeBcm({ vin: SOURCE_VIN, partialTail: SOURCE_VIN.slice(9),
    vehicleSecret: BCM_SECRET_LE, immoRecsCount: 0 });
}

function makePcm() {
  return makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6 });
}

// Gen2 RFHUB with the CORRECT secret (matching BCM).
function makeMatchedRfh() {
  return makeRfhubGen2({ vin: TARGET_VIN, vehicleSecret: BCM_SECRET_BE });
}

// Gen2 RFHUB with a WRONG secret (mismatched with BCM).
function makeMismatchedRfh() {
  return makeRfhubGen2({ vin: TARGET_VIN, vehicleSecret: WRONG_RFH_SECRET });
}

// Gen2 RFHUB with a WRONG secret AND the AA 55 31 01 header cleared.
function makeMismatchedNoHeader() {
  const buf = makeMismatchedRfh();
  // Wipe the Gen2 header so writeRfhSec16FromBcm throws.
  buf[0x0500] = 0x00; buf[0x0501] = 0x00;
  buf[0x0502] = 0x00; buf[0x0503] = 0x00;
  return buf;
}

// ────────────────────────────────────────────────────────────────────────────

describe('runKeyProgPatch — RFHUB SEC16 write path (Task #902)', () => {

  // ── (a) Mismatched RFHUB gets its SEC16 corrected ─────────────────────────
  it('(a) mismatched RFHUB SEC16 → auto-patched to match BCM secret', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH.bin', data: makeMismatchedRfh() };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    if (!r.ok) console.error('Failures:', r.checks.filter((c) => !c.pass));
    expect(r.ok).toBe(true);

    // The RFH output must NOT be byte-identical to the source — SEC16 was written.
    const rfhFile = r.files.find((f) => f.role === 'RFH');
    expect(rfhFile).toBeDefined();
    expect(sha(rfhFile.data)).not.toBe(sha(rfh.data));

    // Round-trip: reparse the patched RFH and confirm SEC16 now matches BCM secret.
    const rfhAfter = parseModule(rfhFile.data, 'RFH_patched.bin');
    expect(rfhAfter.type).toBe('RFHUB');
    const slot1Hex = rfhAfter.sec16s?.[0]?.hex?.toUpperCase();
    expect(slot1Hex).toBe(BCM_SECRET_BE_HEX);
    expect(rfhAfter.sec16s?.[0]?.csOk).toBe(true);
    expect(rfhAfter.sec16s?.[1]?.csOk).toBe(true);

    // The informational check must be present and pass (mismatch is NOT a fail).
    const sec16Check = r.checks.find((c) => c.label === 'RFH SEC16 slot1 vs BCM secret (BE)');
    expect(sec16Check).toBeDefined();
    expect(sec16Check.pass).toBe(true);
    expect(sec16Check.detail).toMatch(/mismatch.*will auto-patch/i);

    // The "RFH SEC16 written" check must also pass.
    const writeCheck = r.checks.find((c) => /RFH SEC16 written/i.test(c.label));
    expect(writeCheck).toBeDefined();
    expect(writeCheck.pass).toBe(true);
  });

  // ── (b) Missing Gen2 header → blocking error ──────────────────────────────
  it('(b) mismatched RFHUB without Gen2 header → blocking write error (ok=false)', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH.bin', data: makeMismatchedNoHeader() };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(false);

    // Must mention that the write failed.
    const failCheck = r.checks.find((c) => !c.pass && /RFH SEC16 write failed/i.test(c.label));
    expect(failCheck).toBeDefined();
    // Must mention the Gen2 header problem and give actionable guidance.
    expect(failCheck.detail).toMatch(/AA 55 31 01/);
    expect(failCheck.detail).toMatch(/ModuleSync/i);

    // No files should be produced — zip download must be blocked.
    expect(r.files).toHaveLength(0);
  });

  // ── (c) Already-matched RFHUB is passed through unchanged ─────────────────
  it('(c) already-matched RFHUB SEC16 → byte-identical pass-through', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH.bin', data: makeMatchedRfh() };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    if (!r.ok) console.error('Failures:', r.checks.filter((c) => !c.pass));
    expect(r.ok).toBe(true);

    // RFH must be byte-identical to the source (no write occurred).
    const rfhFile = r.files.find((f) => f.role === 'RFH');
    expect(rfhFile).toBeDefined();
    expect(sha(rfhFile.data)).toBe(sha(rfh.data));

    // Informational check must say "already matched".
    const sec16Check = r.checks.find((c) => c.label === 'RFH SEC16 slot1 vs BCM secret (BE)');
    expect(sec16Check).toBeDefined();
    expect(sec16Check.pass).toBe(true);
    expect(sec16Check.detail).toMatch(/already matched/i);

    // No "RFH SEC16 written" check should be present (nothing was written).
    expect(r.checks.find((c) => /RFH SEC16 written/i.test(c.label))).toBeUndefined();
  });

  // ── (d) XC2268-class RFHUB → explicit unsupported error ──────────────────
  it('(d) XC2268 RFHUB → explicit "unsupported module variant" blocking error', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH_XC2268.bin', data: makeXc2268Fixture({ vin: TARGET_VIN }) };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(false);

    const failCheck = r.checks.find((c) => !c.pass);
    expect(failCheck).toBeDefined();
    // Must mention XC2268 explicitly and suggest ModuleSync as the fix path.
    expect(failCheck.detail).toMatch(/XC2268/i);
    expect(failCheck.detail).toMatch(/ModuleSync/i);

    // No files — ZIP must be blocked.
    expect(r.files).toHaveLength(0);
  });

  // ── (e) VERIFY.txt RFHUB_SEC16 line ──────────────────────────────────────
  it('(e-matched) VERIFY.txt contains RFHUB_SEC16: ALREADY_MATCHED when in sync', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH.bin', data: makeMatchedRfh() };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(true);
    expect(r.verifyText).toMatch(/RFHUB_SEC16:\s*ALREADY_MATCHED/);
  });

  it('(e-patched) VERIFY.txt contains RFHUB_SEC16: PATCHED with before/after hex when written', () => {
    const bcm = { name: 'BCM.bin', data: makeBcmWithSecret() };
    const rfh = { name: 'RFH.bin', data: makeMismatchedRfh() };
    const pcm = { name: 'PCM.bin', data: makePcm() };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(true);
    expect(r.verifyText).toMatch(/RFHUB_SEC16:\s*PATCHED/i);
    // Before/after hex lines must both be present.
    expect(r.verifyText).toMatch(/before:/i);
    expect(r.verifyText).toMatch(/after:/i);
    // The "after" value must be the expected BCM secret in BE (= RFH SEC16 endianness).
    expect(r.verifyText).toContain(BCM_SECRET_BE_HEX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #903 — Real bench fixture golden test.
//
// Uses a real donor RFHUB from the attached_assets whose SEC16 does NOT match
// the Cluster B BCM secret. The file originates from a different physical key
// cluster (OG 20 Charger 6.2 original pairing) but has the Cluster B target
// VIN already stamped on it, making it a realistic "mismatched donor" scenario:
//
//   Donor RFHUB:  20CHRGR6.2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640_1776226954878.bin
//     sha256:     205d638b0f87479f9f3ed9caa0da8ec8a32ba0114bcf615f09091c7ec24d7ab1
//     SEC16 BE:   AB8015D77ED943C1AB45EC16896969DA  (wrong cluster)
//   Cluster B BCM:  22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin
//     shared secret (BE):  816531F7CDE32E33C25A415C8440C72A
//
// Expected byte changes after auto-patch:
//   0x050E–0x051D  SEC16 slot1 (16 bytes)
//   0x051E         slot1 checksum (CRC-8/0x65, was 0x5D → now 0x6A)
//   0x0522–0x0531  SEC16 slot2 (16 bytes)
//   0x0532         slot2 checksum (was 0x5D → now 0x6A)
//   0x051F, 0x0533 trailer bytes (0x00 → unchanged)
//
// Auto-skips when attached_assets files are absent (matches the convention in
// keyProgWizard.clusterB.test.js and vinPatch.golden.test.js).
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTACHED = path.resolve(__dirname, '..', '..', '..', '..', 'attached_assets');

const GOLDEN_DONOR_RFH = '20CHRGR6.2RFHUBFILE_EEE_OG_CRC2C3CDXCT1HH652640_1776226954878.bin';
const GOLDEN_BCM       = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const GOLDEN_PCM       = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';
const GOLDEN_VIN       = '2C3CDXCT1HH652640';

// SHA-256 of the raw donor RFHUB (pinned; protects against silent file swap).
const DONOR_RFH_SHA = '205d638b0f87479f9f3ed9caa0da8ec8a32ba0114bcf615f09091c7ec24d7ab1';

// The Cluster B shared secret (BE endian) that the BCM carries.
const CLUSTER_B_SECRET_BE = '816531F7CDE32E33C25A415C8440C72A';

// The donor RFHUB's original (wrong) SEC16 before the wizard patches it.
const DONOR_SEC16_BEFORE = 'AB8015D77ED943C1AB45EC16896969DA';

function loadOrNull(name) {
  const p = path.join(ATTACHED, name);
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

const goldenDonorRfh = loadOrNull(GOLDEN_DONOR_RFH);
const goldenBcm      = loadOrNull(GOLDEN_BCM);
const goldenPcm      = loadOrNull(GOLDEN_PCM);
const haveGolden     = !!(goldenDonorRfh && goldenBcm && goldenPcm);

const dg = haveGolden ? describe : describe.skip;

dg('RFHUB SEC16 write — real bench fixture (Task #903)', () => {
  const bcmFile = { name: GOLDEN_BCM,       data: goldenBcm };
  const rfhFile = { name: GOLDEN_DONOR_RFH, data: goldenDonorRfh };
  const pcmFile = { name: GOLDEN_PCM,       data: goldenPcm };

  it('donor RFHUB SHA-256 matches the pinned golden value', () => {
    expect(sha(goldenDonorRfh)).toBe(DONOR_RFH_SHA);
  });

  it('donor RFHUB SEC16 does NOT match the Cluster B BCM secret before the patch', () => {
    // Slot1 SEC16 lives at 0x050E..0x051D (16 bytes, big-endian on the RFHUB).
    const slot1Hex = Array.from(goldenDonorRfh.slice(0x050E, 0x050E + 16))
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    expect(slot1Hex).toBe(DONOR_SEC16_BEFORE);
    expect(slot1Hex).not.toBe(CLUSTER_B_SECRET_BE);
  });

  it('wizard succeeds (r.ok === true) and the shared secret equals the Cluster B secret', () => {
    const r = runKeyProgPatch({ bcm: bcmFile, rfh: rfhFile, pcm: pcmFile, vin: GOLDEN_VIN });
    if (!r.ok) console.error('Failures:', r.checks.filter((c) => !c.pass));
    expect(r.ok).toBe(true);
    expect(r.sharedSecret).toBe(CLUSTER_B_SECRET_BE);
  });

  it('rfhFile.data differs from source at exactly the two SEC16 slots + their checksums', () => {
    const r = runKeyProgPatch({ bcm: bcmFile, rfh: rfhFile, pcm: pcmFile, vin: GOLDEN_VIN });
    expect(r.ok).toBe(true);

    const rfhOut = r.files.find((f) => f.role === 'RFH').data;

    // Collect every offset where output differs from source.
    const diffs = [];
    for (let i = 0; i < rfhOut.length; i++) {
      if (rfhOut[i] !== goldenDonorRfh[i]) diffs.push(i);
    }

    // Expected: 16 SEC16 bytes + 1 checksum byte per slot = 17 bytes × 2 slots.
    // Slot1: 0x050E–0x051D (SEC16) + 0x051E (chk).
    // Slot2: 0x0522–0x0531 (SEC16) + 0x0532 (chk).
    // The trailer byte at 0x051F / 0x0533 stays 0x00 (unchanged).
    const expectedDiffs = new Set([
      ...Array.from({ length: 16 }, (_, i) => 0x050E + i), // slot1 SEC16
      0x051E,                                               // slot1 chk
      ...Array.from({ length: 16 }, (_, i) => 0x0522 + i), // slot2 SEC16
      0x0532,                                               // slot2 chk
    ]);
    expect(new Set(diffs)).toEqual(expectedDiffs);
  });

  it('parseModule(rfhFile.data).sec16s[0].hex equals the Cluster B shared secret', () => {
    const r = runKeyProgPatch({ bcm: bcmFile, rfh: rfhFile, pcm: pcmFile, vin: GOLDEN_VIN });
    expect(r.ok).toBe(true);

    const rfhOut = r.files.find((f) => f.role === 'RFH').data;
    const rfhAfter = parseModule(rfhOut, 'RFH_golden_out.bin');

    expect(rfhAfter.type).toBe('RFHUB');
    // Slot 1 must carry the Cluster B secret, checksums must pass.
    expect(rfhAfter.sec16s?.[0]?.hex?.toUpperCase()).toBe(CLUSTER_B_SECRET_BE);
    expect(rfhAfter.sec16s?.[0]?.csOk).toBe(true);
    // Slot 2 must match identically.
    expect(rfhAfter.sec16s?.[1]?.hex?.toUpperCase()).toBe(CLUSTER_B_SECRET_BE);
    expect(rfhAfter.sec16s?.[1]?.csOk).toBe(true);
  });

  it('VERIFY.txt contains the correct RFHUB_SEC16 PATCHED line with before/after hex', () => {
    const r = runKeyProgPatch({ bcm: bcmFile, rfh: rfhFile, pcm: pcmFile, vin: GOLDEN_VIN });
    expect(r.ok).toBe(true);

    // Must be flagged as PATCHED (not pass-through).
    expect(r.verifyText).toMatch(/RFHUB_SEC16:\s*PATCHED/i);

    // Before line must contain the original donor SEC16.
    expect(r.verifyText).toMatch(new RegExp('before:\\s*' + DONOR_SEC16_BEFORE, 'i'));

    // After line must contain the Cluster B secret.
    expect(r.verifyText).toMatch(new RegExp('after:\\s*' + CLUSTER_B_SECRET_BE, 'i'));
  });
});
