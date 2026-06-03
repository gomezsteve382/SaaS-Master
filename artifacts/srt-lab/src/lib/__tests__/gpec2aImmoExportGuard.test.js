/* ============================================================================
 * gpec2aImmoExportGuard.test.js — checkSec6MatchesBcm export safety guard.
 *
 * Regression: the offline GPEC2A immo fix / apply must NEVER download a "fixed"
 * PCM whose SEC6 disagrees with the secret derived from the loaded BCM donor
 * (reverse(BCM SEC16)[0:6]) unless the user typed a SEC6 manually (explicit
 * override). This is the byte-for-byte gate that prevents shipping a PCM paired
 * to the wrong BCM secret.
 *
 * Ground truth (attached_assets/, VIN 2C3CDXL92KH674464):
 *   - the OG (raw-read) charger BCM dumps derive SEC6 = F0 B6 1B E3 C7 5B
 *     (this also matches the competitor FCA SINCRO capture);
 *   - the HERMANADO ("twinned"/synced) BCM outputs derive F6 F4 25 6B 04 C6.
 * The two derive DIFFERENT secrets, so a PCM carrying one must be REFUSED when
 * the other BCM is the loaded donor — which physical BCM is in the car decides
 * which PCM is correct, and the guard enforces that match either way.
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyGpec2aImmoFix,
  checkSec6MatchesBcm,
} from '../gpec2aPcmAnalyzer.js';

const ASSETS = resolve(__dirname, '../../../../..', 'attached_assets');
const load = (n) => new Uint8Array(readFileSync(join(ASSETS, n)));

const PCM_FILE = '19gpec2a_eeprom_1780353765789.bin';
const BCM_HERMANADO = 'BCM_HERMANADO_CHARGER_BCM_SYNCED_2C3CDXL92KH674464_17803513401_1780361110923.bin';
const BCM_OG = '19charger_BCMDFLASH_OG_1780353759853.bin';

const SEC6_BCM = [0xf6, 0xf4, 0x25, 0x6b, 0x04, 0xc6]; // HERMANADO (twinned) BCM-derived
const SEC6_OTHER = [0xf0, 0xb6, 0x1b, 0xe3, 0xc7, 0x5b]; // OG (raw-read) car BCM-derived

const pcm = load(PCM_FILE);
const hermanadoBytes = load(BCM_HERMANADO);
const ogBytes = load(BCM_OG);
const donorMods = [{ type: 'BCM', data: hermanadoBytes }];

const out = (sec6) => applyGpec2aImmoFix(pcm, new Uint8Array(sec6)).bytes;

describe('checkSec6MatchesBcm — export safety guard', () => {
  it('allows export when SEC6 matches the BCM-derived secret', () => {
    const r = checkSec6MatchesBcm(out(SEC6_BCM), donorMods, false);
    expect(r.ok).toBe(true);
    expect(r.target).toBe('F6 F4 25 6B 04 C6');
    expect(r.final).toBe('F6 F4 25 6B 04 C6');
  });

  it('REFUSES export when SEC6 differs from the BCM-derived secret', () => {
    const r = checkSec6MatchesBcm(out(SEC6_OTHER), donorMods, false);
    expect(r.ok).toBe(false);
    expect(r.target).toBe('F6 F4 25 6B 04 C6');
    expect(r.final).toBe('F0 B6 1B E3 C7 5B');
    expect(r.error).toMatch(/does not match the BCM-derived secret/);
  });

  it('allows a mismatch when a manual SEC6 override was supplied', () => {
    const r = checkSec6MatchesBcm(out(SEC6_OTHER), donorMods, true);
    expect(r.ok).toBe(true);
    expect(r.override).toBe(true);
  });

  it('allows export when no BCM donor is loaded (nothing authoritative)', () => {
    expect(checkSec6MatchesBcm(out(SEC6_OTHER), [], false).ok).toBe(true);
    expect(
      checkSec6MatchesBcm(out(SEC6_OTHER), [{ type: 'RFHUB', data: new Uint8Array(4096) }], false).ok
    ).toBe(true);
  });

  it('allows export when the BCM donor has no usable (blank) secret', () => {
    const blankBcm = [{ type: 'BCM', data: new Uint8Array(65536) }];
    expect(checkSec6MatchesBcm(out(SEC6_OTHER), blankBcm, false).ok).toBe(true);
  });

  it('REFUSES when a usable BCM is not first in the donor list (no shadowing)', () => {
    // A blank BCM ahead of the real one must NOT short-circuit to ok:true.
    const donors = [
      { type: 'BCM', data: new Uint8Array(65536) },
      { type: 'BCM', data: hermanadoBytes },
    ];
    const r = checkSec6MatchesBcm(out(SEC6_OTHER), donors, false);
    expect(r.ok).toBe(false);
    expect(r.target).toBe('F6 F4 25 6B 04 C6');
    expect(r.final).toBe('F0 B6 1B E3 C7 5B');
  });

  it('REFUSES when two loaded BCMs derive conflicting secrets', () => {
    const donors = [
      { type: 'BCM', data: ogBytes }, // -> F0 B6 1B E3 C7 5B
      { type: 'BCM', data: hermanadoBytes }, // -> F6 F4 25 6B 04 C6
    ];
    const r = checkSec6MatchesBcm(out(SEC6_OTHER), donors, false);
    expect(r.ok).toBe(false);
    expect(r.conflict).toEqual(
      expect.arrayContaining(['F0 B6 1B E3 C7 5B', 'F6 F4 25 6B 04 C6'])
    );
    expect(r.error).toMatch(/different secrets/);
  });

  it('lets a manual override bypass a multi-BCM conflict', () => {
    const donors = [
      { type: 'BCM', data: ogBytes },
      { type: 'BCM', data: hermanadoBytes },
    ];
    expect(checkSec6MatchesBcm(out(SEC6_OTHER), donors, true).ok).toBe(true);
  });

  it('does NOT treat duplicate identical BCM donors as a conflict', () => {
    const donors = [
      { type: 'BCM', data: hermanadoBytes },
      { type: 'BCM', data: hermanadoBytes },
    ];
    expect(checkSec6MatchesBcm(out(SEC6_BCM), donors, false).ok).toBe(true);
    expect(checkSec6MatchesBcm(out(SEC6_OTHER), donors, false).ok).toBe(false);
  });
});
