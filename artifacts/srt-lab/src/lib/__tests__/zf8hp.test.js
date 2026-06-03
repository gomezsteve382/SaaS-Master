/* zf8hp.test.js — GROUNDED ZF 8HP TCU tests.
 *
 * Replaces the earlier synthetic "ZF8HP"-header suite (which no real dump ever
 * matched). Two layers:
 *   1. Synthetic-fixture unit tests over makeZf8hpFixture() — deterministic,
 *      always run.
 *   2. Golden tests over the real attached_assets bench dumps — skip-if-absent
 *      so CI without the corpus still passes.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  vinCheckDigitOk,
  isObdstar8hpEeprom,
  isTricore8hpFlash,
  isZf8hpImage,
  parseZf8hpImage,
  parseObdstar8hpEeprom,
  patchZf8hpVin,
  makeZf8hpFixture,
  extractObdstar8hpVins,
  OBDSTAR_8HP_EEPROM_SIZE,
  TRICORE_8HP_FLASH_SIZE,
} from '../zf8hp.js';
import { patchFile } from '../fileUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, '../../../../..', 'attached_assets');

const VIN_A = '1C4RJFN98MC842152';
const VIN_B = '1C4RJFDJ4EC359481';
const NEW_VIN = '2C3CDXL90MH582899';

describe('zf8hp — VIN check digit', () => {
  it('accepts real FCA VINs', () => {
    expect(vinCheckDigitOk(VIN_A)).toBe(true);
    expect(vinCheckDigitOk(VIN_B)).toBe(true);
    expect(vinCheckDigitOk(NEW_VIN)).toBe(true);
  });
  it('rejects malformed and check-digit-failing strings', () => {
    expect(vinCheckDigitOk('NOPE')).toBe(false);
    expect(vinCheckDigitOk('1C4RJFN98MC842153')).toBe(false); // wrong check digit
    expect(vinCheckDigitOk('IOQ45678901234567')).toBe(false); // illegal chars
  });
});

describe('zf8hp — synthetic OBDSTAR fixture', () => {
  const buf = makeZf8hpFixture();

  it('is a 128 KB OBDSTAR EEPROM and detects as such', () => {
    expect(buf.length).toBe(OBDSTAR_8HP_EEPROM_SIZE);
    expect(isObdstar8hpEeprom(buf)).toBe(true);
    expect(isTricore8hpFlash(buf)).toBe(false);
    expect(isZf8hpImage(buf)).toBe(true);
  });

  it('parses identity (two VINs, ZF unit, variant, part, calibration, date)', () => {
    const r = parseZf8hpImage(buf);
    expect(r.ok).toBe(true);
    expect(r.format).toBe('OBDSTAR_EEPROM');
    expect(r.distinctVins).toEqual([VIN_A, VIN_B]);
    expect(r.zfUnit).toBe('1034420271');
    expect(r.variant).toBe('8HP95');
    expect(r.moparPart).toBe('05035827AC');
    expect(r.calibrationIds).toContain('0260TP1122V02');
    expect(r.buildDate).toBe('Oct  1 2019');
    expect(r.writeSafe).toBe(true);
  });

  it('mirrors each VIN three times', () => {
    const hits = extractObdstar8hpVins(buf);
    expect(hits.filter((h) => h.vin === VIN_A)).toHaveLength(3);
    expect(hits.filter((h) => h.vin === VIN_B)).toHaveLength(3);
  });

  it('warns when more than one VIN is present', () => {
    const r = parseZf8hpImage(buf);
    expect(r.banners.some((b) => b.level === 'warn' && /VINs/.test(b.message))).toBe(true);
  });
});

describe('zf8hp — VIN writer', () => {
  it('refuses a dual-VIN dump without a source VIN', () => {
    const r = patchZf8hpVin(makeZf8hpFixture(), NEW_VIN);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Specify which to replace/);
  });

  it('patches all mirrors of the named source VIN', () => {
    const r = patchZf8hpVin(makeZf8hpFixture(), { targetVin: NEW_VIN, sourceVin: VIN_A });
    expect(r.ok).toBe(true);
    expect(r.mirrorsPatched).toBe(3);
    const re = parseZf8hpImage(r.bytes);
    expect(re.distinctVins).toContain(NEW_VIN);
    expect(re.distinctVins).toContain(VIN_B);
    expect(re.distinctVins).not.toContain(VIN_A);
  });

  it('refuses an invalid target VIN', () => {
    expect(patchZf8hpVin(makeZf8hpFixture(), { targetVin: 'NOPE', sourceVin: VIN_A }).ok).toBe(false);
    expect(patchZf8hpVin(makeZf8hpFixture(), { targetVin: '1C4RJFN98MC842153', sourceVin: VIN_A }).ok).toBe(false);
  });

  it('refuses a source VIN not present in the dump', () => {
    const r = patchZf8hpVin(makeZf8hpFixture(), { targetVin: NEW_VIN, sourceVin: NEW_VIN });
    expect(r.ok).toBe(false);
  });

  it('single-VIN dump patches from a bare target string', () => {
    const single = makeZf8hpFixture({ vinB: VIN_A }); // both mirrors carry VIN_A
    const r = patchZf8hpVin(single, NEW_VIN);
    expect(r.ok).toBe(true);
    expect(parseZf8hpImage(r.bytes).distinctVins).toEqual([NEW_VIN]);
  });

  it('allVins mode overwrites every slot of every distinct VIN (generic pipeline)', () => {
    const r = patchZf8hpVin(makeZf8hpFixture(), { targetVin: NEW_VIN, allVins: true });
    expect(r.ok).toBe(true);
    expect(r.mirrorsPatched).toBe(6); // 3 mirrors x 2 distinct VINs
    expect(r.log.some((l) => /2 distinct VINs/.test(l))).toBe(true);
    expect(parseZf8hpImage(r.bytes).distinctVins).toEqual([NEW_VIN]);
  });

  it('allVins refuses when the dump already carries only the target VIN', () => {
    const seeded = patchZf8hpVin(makeZf8hpFixture(), { targetVin: NEW_VIN, allVins: true }).bytes;
    const r = patchZf8hpVin(seeded, { targetVin: NEW_VIN, allVins: true });
    expect(r.ok).toBe(false);
  });
});

describe('zf8hp — generic patchFile pipeline integration', () => {
  it('routes a dual-VIN ZF dump through allVins and rewrites every slot', () => {
    const f = { type: 'ZF_8HP_TCU', data: makeZf8hpFixture() };
    const { data, log } = patchFile(f, NEW_VIN);
    expect(log.some((l) => /write refused/.test(l))).toBe(false);
    expect(parseZf8hpImage(data).distinctVins).toEqual([NEW_VIN]);
  });

  it('surfaces a refusal (not a throw) for an invalid target VIN', () => {
    const f = { type: 'ZF_8HP_TCU', data: makeZf8hpFixture() };
    const { data, log } = patchFile(f, 'NOTAVIN');
    expect(log.some((l) => /ZF-8HP write refused/.test(l))).toBe(true);
    // Refusal returns the buffer unchanged — original VINs intact.
    expect(parseZf8hpImage(data).distinctVins).toEqual([VIN_A, VIN_B]);
  });
});

describe('zf8hp — golden real dumps (skip if absent)', () => {
  const have = existsSync(ASSETS);
  const readIf = (name) => {
    const p = resolve(ASSETS, name);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  };

  it.runIf(have)('OBDSTAR EEPROM read extracts the bench VIN + 8HP95 identity', () => {
    const d = readIf('DODGE_JEEP_Lamborghini_ZF_8HP95_INT_EEPROM_1034420271_1780517643211.bin')
      || readIf('8HP_Read_INT_eeprom_1107023851_1780517643212.bin');
    if (!d) return;
    const r = parseZf8hpImage(d);
    expect(r.ok).toBe(true);
    expect(r.format).toBe('OBDSTAR_EEPROM');
    expect(r.distinctVins).toContain('1C4RJFN98MC842152');
    expect(r.zfUnit).toBe('1034420271');
    expect(r.variant).toBe('8HP95');
  });

  it.runIf(have)('TriCore flash read surfaces the software version, no VIN', () => {
    const d = readIf('8HP_Read_INT_flash_0320221129.0_1780517643207.HexTemp');
    if (!d) return;
    expect(d.length).toBe(TRICORE_8HP_FLASH_SIZE);
    expect(isTricore8hpFlash(d)).toBe(true);
    const r = parseZf8hpImage(d);
    expect(r.format).toBe('TRICORE_FLASH');
    expect(r.softwareVersion).toBe('TPROT_TC_G2_V05.01.00');
    expect(r.vin).toBeNull();
    expect(r.writeSafe).toBe(false);
  });

  it.runIf(have)('round-trips a real OBDSTAR dump through the writer', () => {
    const d = readIf('DODGE_JEEP_Lamborghini_ZF_8HP95_INT_EEPROM_1034420271_1780517643211.bin')
      || readIf('8HP_Read_INT_eeprom_1107023851_1780517643212.bin');
    if (!d) return;
    const parsed = parseObdstar8hpEeprom(d);
    const source = parsed.distinctVins[0];
    const r = patchZf8hpVin(d, { targetVin: NEW_VIN, sourceVin: source });
    expect(r.ok).toBe(true);
    expect(r.bytes.length).toBe(d.length);
    expect(parseZf8hpImage(r.bytes).distinctVins).toContain(NEW_VIN);
  });
});
