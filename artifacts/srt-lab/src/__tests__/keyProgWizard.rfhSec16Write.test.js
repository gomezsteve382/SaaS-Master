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
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
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
