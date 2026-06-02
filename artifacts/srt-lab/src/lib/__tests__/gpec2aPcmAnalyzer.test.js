/* ============================================================================
 * gpec2aPcmAnalyzer.test.js — unit tests for the offline GPEC2A PCM analyzer
 * + immo-fix derivation (Task #1035).
 *
 * Fixtures (attached_assets/):
 *   - 19gpec2a_eeprom_1780353765789.bin  — 4 KB GPEC2A, VIN 2C3CDXL92KH674464,
 *     SEC6 blank (FF), marker FF FF FF FF (NOT synced).
 *   - BCM_HERMANADO_CHARGER_BCM_SYNCED_2C3CDXL92KH674464_17803513401_1780361110923.bin
 *     — synced BCM donor for the same VIN.
 *   - CHARGER_PCM_SYNCED_4KB_2C3CDXL92KH674464_1780351340114_immoFix_1780360703302.bin
 *     — the ground-truth synced PCM (expected immo-fix output).
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseModule } from '../parseModule.js';
import {
  analyzeGpec2aPcm,
  derivePcmSec6FromDonor,
  applyGpec2aChanges,
  applyGpec2aImmoFix,
  isCanonicalGpec2a,
  GPEC2A_VIN_RE,
} from '../gpec2aPcmAnalyzer.js';

const ASSETS = resolve(__dirname, '../../../../..', 'attached_assets');
const load = (n) => new Uint8Array(readFileSync(join(ASSETS, n)));

const PCM_FILE = '19gpec2a_eeprom_1780353765789.bin';
const BCM_DONOR = 'BCM_HERMANADO_CHARGER_BCM_SYNCED_2C3CDXL92KH674464_17803513401_1780361110923.bin';
const SYNCED_PCM = 'CHARGER_PCM_SYNCED_4KB_2C3CDXL92KH674464_1780351340114_immoFix_1780360703302.bin';

const EXPECTED_VIN = '2C3CDXL92KH674464';
const EXPECTED_SEC6 = [0xf6, 0xf4, 0x25, 0x6b, 0x04, 0xc6];

const pcm = load(PCM_FILE);

describe('analyzeGpec2aPcm — read-out', () => {
  const a = analyzeGpec2aPcm(pcm);

  it('detects GPEC2A family on a canonical 4 KB image', () => {
    expect(a.ok).toBe(true);
    expect(a.canonical).toBe(true);
    expect(a.family.code).toBe('GPEC2A');
    expect(a.eeprom.sizeBytes).toBe(4096);
  });

  it('reads three valid VIN slots with a consensus VIN', () => {
    expect(a.state.validVinCount).toBe(3);
    const winOk = a.vinRows.filter((r) => r.state === 'WIN_OK');
    expect(winOk).toHaveLength(3);
    for (const r of winOk) expect(r.vin).toBe(EXPECTED_VIN);
    const ce0 = a.vinRows.find((r) => r.offset === 0x0ce0);
    expect(ce0.state).toBe('EMPTY_FF');
  });

  it('reports SEC6 blank and IMMO not synced', () => {
    expect(a.sec6.state).toBe('EMPTY_FF');
    expect(a.sec6.populated).toBe(false);
    expect(a.immo.currentHex).toBe('FF FF FF FF');
    expect(a.immo.expectedHex).toBe('FF FF FF AA');
    expect(a.immo.synced).toBe(false);
    expect(a.state.immoSync).toBe(false);
  });

  it('surfaces internal signature fields', () => {
    expect(a.ids.family081F).toBe('00EP');
    expect(a.ids.variant0825).toBe('L16EQ)W');
    expect(a.ids.continental0FA1).toBe('AAA9160120000');
  });
});

describe('derivePcmSec6FromDonor', () => {
  it('derives PCM SEC6 = reverse(BCM SEC16)[0:6] from a synced BCM', () => {
    const bcm = parseModule(load(BCM_DONOR), BCM_DONOR);
    const d = derivePcmSec6FromDonor(bcm);
    expect(d).toBeTruthy();
    expect(d.source).toBe('BCM');
    expect(Array.from(d.sec6)).toEqual(EXPECTED_SEC6);
  });

  it('returns null for a non-donor / empty module', () => {
    expect(derivePcmSec6FromDonor(null)).toBeNull();
    expect(derivePcmSec6FromDonor({ type: 'BCM', data: new Uint8Array(0) })).toBeNull();
    expect(derivePcmSec6FromDonor({ type: 'GPEC2A', data: pcm })).toBeNull();
  });
});

describe('applyGpec2aImmoFix', () => {
  it('stamps marker FF FF FF AA + SEC6 matching the ground-truth synced PCM', () => {
    const res = applyGpec2aImmoFix(pcm, new Uint8Array(EXPECTED_SEC6));
    expect(res.ok).toBe(true);
    expect(res.bytes.length).toBe(4096);
    expect(Array.from(res.bytes.slice(0x3c4, 0x3c8))).toEqual([0xff, 0xff, 0xff, 0xaa]);
    expect(Array.from(res.bytes.slice(0x3c8, 0x3ce))).toEqual(EXPECTED_SEC6);

    const synced = load(SYNCED_PCM);
    expect(Array.from(res.bytes.slice(0x3c4, 0x3ce))).toEqual(
      Array.from(synced.slice(0x3c4, 0x3ce))
    );
  });

  it('refuses a blank (virgin) SEC6 secret', () => {
    const ff = applyGpec2aImmoFix(pcm, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(ff.ok).toBe(false);
    const zero = applyGpec2aImmoFix(pcm, new Uint8Array(6));
    expect(zero.ok).toBe(false);
  });

  it('refuses a missing secret and a non-canonical image', () => {
    expect(applyGpec2aImmoFix(pcm, null).ok).toBe(false);
    expect(applyGpec2aImmoFix(new Uint8Array(1234), new Uint8Array(EXPECTED_SEC6)).ok).toBe(false);
  });
});

describe('applyGpec2aChanges', () => {
  it('writes a new VIN to the three primary slots (not 0x0CE0 by default)', () => {
    const newVin = '2C3CDXL92KH000001';
    const res = applyGpec2aChanges(pcm, { newVin });
    expect(res.ok).toBe(true);
    for (const o of [0x0000, 0x01f0, 0x0224]) {
      const got = Array.from(res.bytes.slice(o, o + 17))
        .map((b) => String.fromCharCode(b))
        .join('');
      expect(got).toBe(newVin);
    }
    expect(Array.from(res.bytes.slice(0x0ce0, 0x0ce0 + 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('also writes 0x0CE0 when alsoWriteCe0 is set', () => {
    const res = applyGpec2aChanges(pcm, { newVin: EXPECTED_VIN, alsoWriteCe0: true });
    const got = Array.from(res.bytes.slice(0x0ce0, 0x0ce0 + 17))
      .map((b) => String.fromCharCode(b))
      .join('');
    expect(got).toBe(EXPECTED_VIN);
  });

  it('applies SEC6 + IMMO marker together', () => {
    const res = applyGpec2aChanges(pcm, { newSec6: new Uint8Array(EXPECTED_SEC6), fixImmo: true });
    expect(res.ok).toBe(true);
    expect(Array.from(res.bytes.slice(0x3c4, 0x3c8))).toEqual([0xff, 0xff, 0xff, 0xaa]);
    expect(Array.from(res.bytes.slice(0x3c8, 0x3ce))).toEqual(EXPECTED_SEC6);
  });

  it('rejects an invalid VIN and a no-op call', () => {
    expect(applyGpec2aChanges(pcm, { newVin: 'TOOSHORT' }).ok).toBe(false);
    expect(applyGpec2aChanges(pcm, {}).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('isCanonicalGpec2a accepts 4 KB / 8 KB only', () => {
    expect(isCanonicalGpec2a(new Uint8Array(4096))).toBe(true);
    expect(isCanonicalGpec2a(new Uint8Array(8192))).toBe(true);
    expect(isCanonicalGpec2a(new Uint8Array(2048))).toBe(false);
    expect(isCanonicalGpec2a(null)).toBe(false);
  });

  it('GPEC2A_VIN_RE rejects I/O/Q and wrong length', () => {
    expect(GPEC2A_VIN_RE.test(EXPECTED_VIN)).toBe(true);
    expect(GPEC2A_VIN_RE.test('2C3CDXL92KH67446I')).toBe(false);
    expect(GPEC2A_VIN_RE.test('SHORT')).toBe(false);
  });
});
