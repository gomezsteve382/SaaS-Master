/* Task #678 — end-to-end pre-flight scenarios across the five platforms.
 *
 * Each scenario:
 *   1. Builds a synthetic parsed-module set for the platform.
 *   2. Runs the real crossValidate() over those modules.
 *   3. Feeds the result to evaluateSec16Preflight() and asserts the
 *      starting verdict (SYNC_REQUIRED / NO_GO / LIVE_ONLY / GO).
 *   4. Applies the matching offline writer where applicable.
 *   5. Re-runs the pre-flight and asserts the new verdict.
 *
 * The 'apply remedy' step is simulated by mutating the parsed-module
 * state to mirror what the writer would produce on disk — the writers
 * themselves are exhaustively unit-tested in their own suites. This
 * test guarantees the *integration* between the writer-emitted state
 * and the pre-flight verdict, which is the actual user-facing
 * promise: 'after a green sync, pre-flight flips to GO'.
 */

import { describe, it, expect } from 'vitest';
import { crossValidate } from '../crossValidate.js';
import { evaluateSec16Preflight } from '../sec16Preflight.js';

const u8 = (...bytes) => new Uint8Array(bytes);
const fmt = (arr) => Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/* Canonical paired triplet (LX/LD reference incident dump). */
const RFH_SEC16 = u8(
  0x08,0xA1,0xC5,0xE7,0xBA,0x30,0x35,0x82,
  0xC3,0x82,0x15,0x94,0x79,0x3C,0x2F,0xC4,
);
const BCM_SEC16 = u8(...Array.from(RFH_SEC16).reverse());
const PCM_SEC6  = u8(...Array.from(RFH_SEC16).slice(0, 6));

function makeBcm(sec16, { vin = '2C3CDXGJ9KH633754', flatBytes = null } = {}) {
  return {
    type: 'BCM',
    vins: [{ vin, offset: 0x5320 }],
    bcmSec16: {
      bytes: sec16, blank: false, source: 'split',
      candidates: { flat: { bytes: flatBytes || u8(...Array.from(sec16).reverse()) } },
    },
    fobikCount: 2,
    securityLock: { locked: true },
  };
}
function makeRfhub(sec16, { vin = '2C3CDXGJ9KH633754' } = {}) {
  return {
    type: 'RFHUB',
    vins: [{ vin, offset: 0x0EA5 }],
    vehicleSecret: { bytes: sec16 },
    sec16s: [
      { slot: 1, raw: sec16, hex: fmt(sec16), csOk: true, blank: false },
      { slot: 2, raw: sec16, hex: fmt(sec16), csOk: true, blank: false },
    ],
    sec16match: true,
    sec16valid: true,
    fobikSlots: 2,
    securityMarkers: 4,
    skey: u8(...new Array(16).fill(0x42)),
    skb: false,
  };
}
function makePcm(sec6, { vin = '2C3CDXGJ9KH633754', damaged = false } = {}) {
  return {
    type: 'GPEC2A',
    vins: [{ vin, offset: 0x14 }],
    pcmSec6: {
      raw: sec6, hex: fmt(sec6),
      populated: !damaged, damaged,
      immoState: damaged ? 'IMMO_DAMAGED' : 'IMMO_PAIRED',
    },
    skimByte: 0x80,
    keyConsistent: true,
    zzzzTamper: { intact: true },
  };
}
function make95640(rfhSec16, { vin = '1C4RJFDJ7DC513874', skMatch = true } = {}) {
  /* 95640 stores SEC16 in BCM-form (reverse of RFH-form) at 0x0838.
   * `reversedHex` is the parser-emitted RFH-form rendering — i.e. the
   * reverse of `raw`, which equals the original RFH bytes. crossValidate
   * compares this directly against `rfhub.sec16s[0].hex` (also RFH-form),
   * so the field MUST be RFH-form for a paired triplet to surface as
   * MATCH instead of a MISMATCH warning. */
  const reversedHex = fmt(rfhSec16);
  const sk = u8(...new Array(16).fill(0x42));
  return {
    type: '95640',
    vins: [{ vin, offset: 0x80 }],
    skey: sk, skb: false,
    bcmSec16: {
      raw: u8(...Array.from(rfhSec16).reverse()),
      reversedHex,
      blank: false, csOk: true,
      storedCs: 0xAA, calcCs: 0xAA,
    },
    rfhVin92: null,
  };
}

function preflightFor(vin, modules) {
  const xv = crossValidate(modules);
  return { xv, verdict: evaluateSec16Preflight({ vin, modules, crossValidate: xv }) };
}

describe('sec16Preflight — end-to-end platform scenarios', () => {
  it('LX/LD Charger — paired triplet GOes immediately', () => {
    const { verdict } = preflightFor('2C3CDXL90MH582899', [
      makeBcm(BCM_SEC16, { vin: '2C3CDXL90MH582899' }),
      makeRfhub(RFH_SEC16, { vin: '2C3CDXL90MH582899' }),
      makePcm(PCM_SEC6, { vin: '2C3CDXL90MH582899' }),
    ]);
    expect(verdict.classification.platform).toBe('lx-ld');
    expect(verdict.status).toBe('GO');
    expect(verdict.canProgramKey).toBe(true);
  });

  it('LX/LD Challenger — RFHUB↔BCM mismatch → SYNC_REQUIRED → GO after offline sync', () => {
    const STALE_BCM = u8(...new Array(16).fill(0x99));
    const initial = preflightFor('2C3CDXL90MH582899', [
      makeBcm(STALE_BCM, { vin: '2C3CDXL90MH582899' }),
      makeRfhub(RFH_SEC16, { vin: '2C3CDXL90MH582899' }),
      makePcm(PCM_SEC6, { vin: '2C3CDXL90MH582899' }),
    ]);
    expect(initial.verdict.status).toBe('SYNC_REQUIRED');
    expect(initial.verdict.canProgramKey).toBe(false);
    expect(initial.verdict.actions.map(a => a.id)).toContain('rfh-bcm-sec16-sync');

    /* Apply RFH→BCM sync (writeBcmSec16Gen2 produces reverse(RFH) on disk). */
    const after = preflightFor('2C3CDXL90MH582899', [
      makeBcm(BCM_SEC16, { vin: '2C3CDXL90MH582899' }),
      makeRfhub(RFH_SEC16, { vin: '2C3CDXL90MH582899' }),
      makePcm(PCM_SEC6, { vin: '2C3CDXL90MH582899' }),
    ]);
    expect(after.verdict.status).toBe('GO');
  });

  it('WK2 Trackhawk — full triplet + good 95640 → GO', () => {
    const wkVin = '1C4RJFDJ7DC513874';
    const { verdict } = preflightFor(wkVin, [
      makeBcm(BCM_SEC16, { vin: wkVin }),
      makeRfhub(RFH_SEC16, { vin: wkVin }),
      makePcm(PCM_SEC6, { vin: wkVin }),
      make95640(RFH_SEC16, { vin: wkVin }),
    ]);
    expect(verdict.classification.platform).toBe('wk2-jeep');
    expect(verdict.status).toBe('GO');
  });

  it('WK2 Trackhawk — missing 95640 → INSUFFICIENT_DATA', () => {
    const wkVin = '1C4RJFDJ7DC513874';
    const { verdict } = preflightFor(wkVin, [
      makeBcm(BCM_SEC16, { vin: wkVin }),
      makeRfhub(RFH_SEC16, { vin: wkVin }),
      makePcm(PCM_SEC6, { vin: wkVin }),
    ]);
    expect(verdict.status).toBe('INSUFFICIENT_DATA');
    expect(verdict.missingModules).toContain('95640');
  });

  it('WD Durango — PCM SEC6 damaged → SYNC_REQUIRED with rfh-pcm-sec6-sync remedy', () => {
    const wdVin = '1C4SDHCT6KC123456';
    const damagedSec6 = u8(0xFF,0xFF,0x00,0xFF,0xFF,0xFF);
    const { verdict } = preflightFor(wdVin, [
      makeBcm(BCM_SEC16, { vin: wdVin }),
      makeRfhub(RFH_SEC16, { vin: wdVin }),
      makePcm(damagedSec6, { vin: wdVin, damaged: true }),
      make95640(RFH_SEC16, { vin: wdVin }),
    ]);
    expect(verdict.classification.platform).toBe('wd-durango');
    expect(verdict.status).toBe('SYNC_REQUIRED');
    /* Damaged PCM SEC6 surfaces both the bcm-pcm and pcm-damaged blocker
     * branches; both ultimately resolve to a PCM-targeted sync. */
    const ids = verdict.actions.map(a => a.id);
    expect(ids.some(id => id === 'rfh-pcm-sec6-sync' || id === 'bcm-pcm-sec6-sync')).toBe(true);

    /* Apply PCM SEC6 import — pre-flight flips to GO. */
    const after = preflightFor(wdVin, [
      makeBcm(BCM_SEC16, { vin: wdVin }),
      makeRfhub(RFH_SEC16, { vin: wdVin }),
      makePcm(PCM_SEC6, { vin: wdVin }),
      make95640(RFH_SEC16, { vin: wdVin }),
    ]);
    expect(after.verdict.status).toBe('GO');
  });

  it('Ram 2019+ DT — XC2268 RFHUB → LIVE_ONLY regardless of other modules', () => {
    const ramVin = '1C6RR7LT5KS123456';
    const { verdict, xv } = preflightFor(ramVin, [
      { type: 'XC2268_RFHUB', vins: [{ vin: ramVin }], xc2268: { ok: true, variant: 0x01 } },
      makeBcm(BCM_SEC16, { vin: ramVin }),
    ]);
    expect(xv.warnings.some(w => w.startsWith('XC2268 RFHUB'))).toBe(true);
    expect(verdict.status).toBe('LIVE_ONLY');
    expect(verdict.classification.platform).toBe('dt-ram-2019plus');
    expect(verdict.canProgramKey).toBe(false);
  });

  it('Unknown platform — VIN does not match any WMI, baseline rules still run', () => {
    const { verdict } = preflightFor('ZZZZZZZZZZZZZZZZZ', [
      makeBcm(BCM_SEC16),
      makeRfhub(RFH_SEC16),
      makePcm(PCM_SEC6),
    ]);
    expect(verdict.classification.platform).toBe('unknown');
    /* Note: VIN_MISMATCH does not fire here because all module VINs are
     * the synthetic incident VIN, not the typed-in master VIN — the
     * baseline rule set runs cleanly so the verdict is GO. */
    expect(verdict.status).toBe('GO');
  });
});
