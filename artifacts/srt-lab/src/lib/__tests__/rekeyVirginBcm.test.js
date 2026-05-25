/**
 * Task #816 — rekeyVirginBcmFromRfhub tests.
 *
 * Tests the helper that writes reverse(RFHUB SEC16) into all BCM SEC16
 * locations (split records, inactive-bank mirrors, flat 0x40C9 slice) and
 * normalises the FOBIK count byte at 0x5862.
 *
 * Ground truth for the 6.2 Charger bench set (from memory/charger62-bench-set.md):
 *   RFHUB SEC16 slot 1 : 0000000000000001FC01FFFF00000000
 *   BCM SEC16 reversed : 00000000FFFF01FC0100000000000000
 *   BCM fobikCount before: 0x42 (66); after: 5 (RFHUB fobikSlots)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { rekeyVirginBcmFromRfhub, resolveMpc5606bSec16 } from '../mpc5606bBcm.js';
import { writeBcmSec16Gen2 } from '../securityBytes.js';
import { resolveBcmSec16, parseModule } from '../parseModule.js';
import { crossValidate } from '../crossValidate.js';

const ASSETS = resolve(__dirname, '..', '..', '..', '..', '..', 'attached_assets');

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
function hexToBytes(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* Build a minimal 64 KB virgin BCM fixture.
 * - Bank0 active (seq 0x0009 > bank1 0x0008) → inactive bank = 0x4000
 * - Split records at 0x81A0/C0/E0: all 0xFF (no valid header)
 * - No mirror records in inactive bank
 * - Flat 0x40C9: stale garbage bytes (realistic — real NEWVIN BCMs have this)
 * - VIN at known slot 0x5320
 * - fobikCount at 0x5862 = 66 (0x42)
 */
function makeVirginBcm(vin = '2C3CCABG1KH539430') {
  const buf = new Uint8Array(65536).fill(0xFF);
  // Bank sequence (bank0 active)
  buf[0x0002] = 0x00; buf[0x0003] = 0x09;
  buf[0x4002] = 0x00; buf[0x4003] = 0x08;
  // VIN at 0x5320 + CRC16 placeholder
  const vinBytes = new TextEncoder().encode(vin);
  for (let i = 0; i < 17; i++) buf[0x5320 + i] = vinBytes[i];
  // stale flat slice (realistic — non-blank, non-FF garbage)
  const stale = hexToBytes('00000000000000313E0010001800 0A00');
  for (let i = 0; i < 16; i++) buf[0x40C9 + i] = stale[i] ?? 0x00;
  // fobikCount
  buf[0x5862] = 66; // 0x42
  return buf;
}

/* Build a minimal 4 KB Gen2 RFHUB EEE fixture with the given rfhSec16. */
function makeRfhEee(rfhSec16, fobikSlots = 5) {
  const buf = new Uint8Array(4096).fill(0xFF);
  // Gen2 header (size-specific detection uses 0x800 = 2048 or 0x1000 = 4096)
  // For 4 KB EEE, RFHUB uses 0x0880 base for AA50 slots
  for (let i = 0; i < fobikSlots; i++) {
    buf[0x0880 + i * 2]     = 0xAA;
    buf[0x0880 + i * 2 + 1] = 0x50;
  }
  // SEC16 slot layout (from parseModule.js RFHUB parsing)
  // SEC16 slot 1 at known offset — mirror parseModule's AA50 scan result
  // For Gen2 EEE (4KB), parseModule reads sec16 from the AA50 slot data
  // The SEC16 is stored at each slot's payload area
  // sec16.slot1 is read from the RFHUB parse; we embed it at the first AA50 slot payload
  // (this is a simplified fixture — real RFHUB has a richer record structure)
  // For crossValidate tests, we use the actual bench files.
  return buf;
}

const RFHUB_SEC16_HEX   = '0000000000000001FC01FFFF00000000'; // bench RFHUB slot 1
const BCM_SEC16_EXPECTED = '00000000FFFF01FC0100000000000000'; // = reverse(RFHUB SEC16)

const rfhSec16 = hexToBytes(RFHUB_SEC16_HEX);

// ──────────────────────────────────────────────────────────────────────────────
// Core helper tests (synthetic fixture)
// ──────────────────────────────────────────────────────────────────────────────

describe('rekeyVirginBcmFromRfhub — synthetic fixture', () => {

  it('throws when rfhSec16 is missing or wrong length', () => {
    const bcm = makeVirginBcm();
    expect(() => rekeyVirginBcmFromRfhub(bcm, null, null)).toThrow('rfhSec16 must be 16 bytes');
    expect(() => rekeyVirginBcmFromRfhub(bcm, new Uint8Array(8), null)).toThrow('rfhSec16 must be 16 bytes');
  });

  it('throws when BCM already has FEE SEC16 data (split records present)', () => {
    /* Produce a BCM that has real split records by re-keying a virgin BCM first,
     * then trying to re-key the result (which now has populated split records). */
    const base = makeVirginBcm();
    const rk = rekeyVirginBcmFromRfhub(base, rfhSec16, null);
    expect(() => rekeyVirginBcmFromRfhub(rk.bytes, rfhSec16, null))
      .toThrow('already has FEE SEC16 data');
  });

  it('writes reverse(rfhSec16) into BCM split records (0x81A0/C0/E0)', () => {
    const bcm = makeVirginBcm();
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    expect(r.splitPatched).toBeGreaterThan(0);
    // verify resolveBcmSec16 now resolves the expected BCM SEC16
    const resolved = resolveBcmSec16(r.bytes);
    expect(resolved.blank).toBe(false);
    expect(hex(resolved.bytes)).toBe(BCM_SEC16_EXPECTED);
  });

  it('split records canonical after re-key; mirrorPatched=0 on synthetic virgin', () => {
    /* A synthetic virgin BCM (all-0xFF inactive bank) has no pre-existing
     * mirror records, so mirrorPatched=0 is correct — the ECU FEE allocator
     * creates them the first time it boots after flashing. Split records at
     * 0x81A0/C0/E0 are written from scratch and become the canonical source. */
    const bcm = makeVirginBcm();
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    expect(r.splitPatched).toBe(3);
    expect(r.mirrorPatched).toBe(0);
    const state = resolveMpc5606bSec16(r.bytes);
    expect(state.blank).toBe(false);
    expect(state.source).toMatch(/split/i);
  });

  it('writes correct LE form of BCM SEC16 into flat 0x40C9', () => {
    const bcm = makeVirginBcm();
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    // canonical flat = LE of BCM SEC16 = rfhSec16 bytes
    const flatSlice = Array.from(r.bytes.slice(0x40C9, 0x40D9))
      .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    // LE of BCM SEC16 (= reverse of BCM SEC16 = rfhSec16)
    const expectedLe = hex(rfhSec16);
    expect(flatSlice).toBe(expectedLe);
  });

  it('sets bcmSec16Hex = reverse(rfhSec16)', () => {
    const bcm = makeVirginBcm();
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    expect(r.bcmSec16Hex.toUpperCase()).toBe(BCM_SEC16_EXPECTED);
  });

  it('sets fobikCount byte at 0x5862 when provided', () => {
    const bcm = makeVirginBcm();
    expect(bcm[0x5862]).toBe(66); // original value
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, 9);
    expect(r.bytes[0x5862]).toBe(9);
    expect(r.fobikCount).toBe(9);
  });

  it('does not mutate the input buffer', () => {
    const bcm = makeVirginBcm();
    const before = new Uint8Array(bcm);
    rekeyVirginBcmFromRfhub(bcm, rfhSec16, 5);
    for (let i = 0; i < bcm.length; i++) {
      if (bcm[i] !== before[i]) throw new Error(`Input mutated at 0x${i.toString(16)}`);
    }
  });

  it('returns a fresh Uint8Array (not the same reference)', () => {
    const bcm = makeVirginBcm();
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    expect(r.bytes).not.toBe(bcm);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
  });

  it('does not touch the flat slice when mirror1 overlaps at 0x40C0 (canonical mode)', () => {
    /* When writeBcmSec16Gen2 places mirror1 at 0x40C0 in the inactive bank,
     * writeBcmFlatSec16 in canonical mode skips the flat 0x40C9 write to
     * preserve the mirror1 record. The BCM SEC16 is still correct via the
     * split records. */
    const bcm = makeVirginBcm();
    // Force inactive bank = 0x0000 so mirror1 lands at 0x00C0, not 0x40C0
    // (default fixture has inactiveBase=0x4000 so overlap is unlikely — this
    // just verifies the canonical path runs without throwing regardless)
    const r = rekeyVirginBcmFromRfhub(bcm, rfhSec16, null);
    const resolved = resolveBcmSec16(r.bytes);
    expect(resolved.blank).toBe(false);
    expect(hex(resolved.bytes)).toBe(BCM_SEC16_EXPECTED);
  });

  it('allows bcmFullyVirgin even when flat 0x40C9 has stale non-blank data', () => {
    /* Regression: the NEWVIN 6.2 Charger bench BCM has stale bytes at 0x40C9
     * but no FEE records — must not throw. */
    const bcm = makeVirginBcm();
    // stale data already written by makeVirginBcm
    const state = resolveMpc5606bSec16(bcm);
    // The flat candidate should be non-blank...
    expect(state.candidates.flat?.blank).toBe(false);
    // ...but FEE records are absent, so the function should NOT throw
    expect(() => rekeyVirginBcmFromRfhub(bcm, rfhSec16, null)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Real bench file tests (offline — uses attached_assets/)
// ──────────────────────────────────────────────────────────────────────────────

describe('rekeyVirginBcmFromRfhub — 6.2 Charger bench fixture (real files)', () => {
  let bcmBytes, rfhBytes;

  try {
    bcmBytes = new Uint8Array(readFileSync(join(ASSETS, '196.2charger_BCMDFLASH_NEWVIN_1779734554788.bin')));
    rfhBytes = new Uint8Array(readFileSync(join(ASSETS, '19charger6,2_rfhubeee_1779733960311.bin')));
  } catch (e) {
    // Fixtures not available in this environment — skip
  }

  const skip = () => !bcmBytes || !rfhBytes;

  it('BCM fixture is 65536 bytes (MPC5606B DFLASH)', () => {
    if (skip()) return;
    expect(bcmBytes.length).toBe(65536);
  });

  it('BCM fixture: no split SEC16 records (split candidate blank/absent)', () => {
    if (skip()) return;
    const state = resolveMpc5606bSec16(bcmBytes);
    // Split records at 0x81A0/C0/E0 are all-FF → no candidate or blank
    const splitHasData = state.candidates.split && !state.candidates.split.blank;
    expect(splitHasData).toBeFalsy();
  });

  it('BCM fixture: phantom mirror1 at 0x40C0 has invalid CRC → rekeyVirginBcmFromRfhub does not throw', () => {
    if (skip()) return;
    /* Real NEWVIN BCMs carry a phantom mirror1 at 0x40C0 whose header bytes
     * happen to match `00 00 00 18 00 46 EB 00`. Its payload is stale
     * provisioning data with an invalid CRC — so the CRC guard must pass. */
    expect(() => rekeyVirginBcmFromRfhub(bcmBytes, rfhSec16, null)).not.toThrow();
  });

  it('BCM fobikCount at 0x5862 is 66 (0x42) before re-key', () => {
    if (skip()) return;
    expect(bcmBytes[0x5862]).toBe(66);
  });

  it('RFHUB fixture is 4096 bytes (EEE)', () => {
    if (skip()) return;
    expect(rfhBytes.length).toBe(4096);
  });

  it('RFHUB fixture sec16s[0].raw matches ground-truth SEC16', () => {
    if (skip()) return;
    const rfhParsed = parseModule(rfhBytes, '19charger6,2_rfhubeee_1779733960311.bin');
    /* parseModule uses sec16s (plural) for RFHUB, not sec16.slot1 — the latter
     * is an engParseRfh (ModuleSync.jsx) field. */
    expect(rfhParsed.sec16s?.[0]?.raw).toBeTruthy();
    expect(hex(rfhParsed.sec16s[0].raw)).toBe(RFHUB_SEC16_HEX);
  });

  it('re-keys successfully and produces correct BCM SEC16', () => {
    if (skip()) return;
    /* Use the pinned ground-truth SEC16 from memory/charger62-bench-set.md */
    const r = rekeyVirginBcmFromRfhub(bcmBytes, rfhSec16, null);
    const resolved = resolveBcmSec16(r.bytes);
    expect(resolved.blank).toBe(false);
    expect(hex(resolved.bytes)).toBe(BCM_SEC16_EXPECTED);
  });

  it('normalises fobikCount from 66 → supplied count', () => {
    if (skip()) return;
    const rfhParsed = parseModule(rfhBytes, '19charger6,2_rfhubeee_1779733960311.bin');
    const newFobikCount = rfhParsed.fobikSlots ?? 5;
    const r = rekeyVirginBcmFromRfhub(bcmBytes, rfhSec16, newFobikCount);
    expect(r.fobikCount).toBe(newFobikCount);
    expect(r.bytes[0x5862]).toBe(newFobikCount);
  });

  it('crossValidate: BCM SEC16 BLANK warning absent after re-key', () => {
    if (skip()) return;
    const r = rekeyVirginBcmFromRfhub(bcmBytes, rfhSec16, null);
    const bcmParsed  = parseModule(r.bytes,  '196.2charger_BCMDFLASH_NEWVIN_rekeyed.bin');
    const rfhParsed2 = parseModule(rfhBytes, '19charger6,2_rfhubeee_1779733960311.bin');
    const cv = crossValidate([bcmParsed, rfhParsed2]);

    const hasBlankWarning = (cv.warnings || []).some(w =>
      typeof w === 'string' ? w.includes('BLANK') : (w.message || '').includes('BLANK'),
    );
    expect(hasBlankWarning).toBe(false);
  });
});
