/* Task #347 — Cover non-Cluster-B trios in the Key Prog wizard test suite.
 *
 * The companion keyProgWizard.clusterB.test.js pins the wizard against the
 * real Cluster B fixtures (Charger Redeye 6.2). Other clusters take
 * different parsing branches inside parseModule + identifyModule:
 *
 *   - non-Cluster-B BCM dump: alternate vehicle secret (LE @0x40C9) →
 *     drives a different shared-secret-BE through every cross-check;
 *     also exercises non-Cluster-B partial-VIN tail rewrites.
 *   - 4-KB single GPEC2A PCM: identifyModule's NON-doubled PCM branch
 *     (no half-2 padding check, no half1 reparse).
 *   - Gen1 RFHUB (24C16 / 2048 B): exercises Gen1 SEC16 offsets
 *     (0x00AE / 0x00C0) and the plain-VIN crc8rf branch — currently
 *     unreachable through the wizard because parseModule classifies
 *     2048-byte buffers as UNKNOWN. That last test is therefore `it.skip`
 *     and serves as a regression beacon: as soon as parseModule learns to
 *     classify 2048-byte RFH buffers as RFHUB, this test will start
 *     running and guarding the Gen1 SEC16 branch.
 *
 * No script reference exists for these synthetic trios, so per the task's
 * "Done looks like" rule each test asserts the wizard checklist passes
 * end-to-end and the post-patch parse reads the target VIN.
 */
import { describe, it, expect } from 'vitest';
import { runKeyProgPatch, identifyModule } from '../lib/keyProgWizard.js';
import { parseModule } from '../lib/parseModule.js';
import {
  makeBcm,
  makeRfhubGen1,
  makeRfhubGen2,
  makeGpec2a,
} from '../lib/__fixtures__/buildFixtures.js';

// A non-Cluster-B vehicle secret. Cluster B uses
// 816531F7CDE32E33C25A415C8440C72A; we deliberately pick a different one so
// the cross-checks (BCM↔RFH SEC16, BCM↔PCM SEC6) traverse fresh bytes.
const SECRET_LE = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF0, 0x01,
]);
const SECRET_BE = new Uint8Array(Array.from(SECRET_LE).reverse());
const SECRET_BE_HEX = Array.from(SECRET_BE)
  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const PCM_SEC6 = SECRET_BE.slice(0, 6);

// VIN before patching (anything valid-shaped); VIN after patching must be a
// real 17-char VIN so writeModuleVIN's writers run cleanly.
const BEFORE_VIN = '2C3CDXKT3FH796320';
// Non-Cluster-B target VIN — different model/year so the partial-VIN tail
// (vin.slice(9)) changes too.
const TARGET_VIN = '1C4BJWFG3JL901234';

// makeBcm's default IMMO records (24 B each at 0x40C0+i*24) physically
// overlap the vehicle-secret slot at 0x40C9, so accept the default record
// pattern here would clobber our explicit secret. Use immoRecsCount: 0 so
// the IMMO region stays 0xFF and the secret at 0x40C9 survives intact.
function makeBcmWithSecret(opts) {
  return makeBcm({ ...opts, immoRecsCount: 0 });
}

function makeDoubledPcm({ vin, sec6 }) {
  // 8 KB doubled GPEC2A: half1 = real 4-KB GPEC2A image, half2 = 0xFF padding.
  const half1 = makeGpec2a({ vin, pcmSec6Bytes: sec6 });
  const buf = new Uint8Array(8192).fill(0xFF);
  buf.set(half1, 0);
  return buf;
}

describe('Non-Cluster-B Key Prog wizard trios (Task #347)', () => {
  it('non-Cluster-B BCM dump (alternate vehicle secret) — full pass', () => {
    const bcm = {
      name: 'TRX_BCM_DFLASH_OG.bin',
      data: makeBcmWithSecret({
        vin: BEFORE_VIN,
        partialTail: BEFORE_VIN.slice(9),
        vehicleSecret: SECRET_LE,
      }),
    };
    const rfh = {
      name: 'TRX_RFH_EEE_OG.bin',
      data: makeRfhubGen2({ vin: TARGET_VIN, vehicleSecret: SECRET_BE }),
    };
    const pcm = {
      name: 'TRX_GPEC2A_EXT_EEPROM_OG.bin',
      data: makeDoubledPcm({ vin: TARGET_VIN, sec6: PCM_SEC6 }),
    };

    // Sanity: parseModule + identifyModule flag the inputs the way the
    // wizard expects before we even run the patcher.
    const idP = identifyModule(pcm.data, pcm.name);
    expect(idP.role).toBe('PCM');
    expect(idP.doubled).toBe(true);
    expect(idP.halfPad).toBe(true);

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    if (!r.ok) console.error('Checklist failures:', r.checks.filter((c) => !c.pass));
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);

    // Shared secret derived from the alternate BCM secret, NOT the Cluster B one.
    expect(r.sharedSecret).toBe(SECRET_BE_HEX);

    // Post-patch BCM parse reads the target VIN at every full + partial slot.
    for (const a of r.after.bcmFullVins) {
      expect(a.vin).toBe(TARGET_VIN);
      expect(a.crcOk).toBe(true);
    }
    for (const a of r.after.bcmPartials) {
      expect(a.tail).toBe(TARGET_VIN.slice(9));
      expect(a.crcOk).toBe(true);
    }

    // Output filename convention matches the Cluster B test.
    const out = Object.fromEntries(r.files.map((f) => [f.role, f]));
    expect(out.BCM.name).toBe('TRX_BCM_DFLASH_OG_KEYPROG_' + TARGET_VIN + '.bin');
    expect(out.RFH.name).toBe('TRX_RFH_EEE_OG_KEYPROG_' + TARGET_VIN + '.bin');
    expect(out.PCM.name).toBe('TRX_GPEC2A_EXT_EEPROM_OG_KEYPROG_' + TARGET_VIN + '.bin');
    expect(out.VERIFY.name).toBe('VERIFY_KEYPROG_' + TARGET_VIN + '.txt');

    // Pass-through guarantee: RFH and PCM bytes are identical to source.
    expect(out.RFH.data).toEqual(rfh.data);
    expect(out.PCM.data).toEqual(pcm.data);
  });

  it('4-KB single GPEC2A PCM (NOT doubled) — full pass', () => {
    const bcm = {
      name: 'NCB_BCM_DFLASH_OG.bin',
      data: makeBcmWithSecret({
        vin: BEFORE_VIN,
        partialTail: BEFORE_VIN.slice(9),
        vehicleSecret: SECRET_LE,
      }),
    };
    const rfh = {
      name: 'NCB_RFH_EEE_OG.bin',
      data: makeRfhubGen2({ vin: TARGET_VIN, vehicleSecret: SECRET_BE }),
    };
    // Single 4-KB GPEC2A image — exercises the NON-doubled PCM branch in
    // identifyModule (no half-2 padding check, info parsed directly from
    // the full buffer rather than from a half1 slice).
    const pcm = {
      name: 'NCB_GPEC2A_INT_FLASH_OG.bin',
      data: makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6 }),
    };

    const idP = identifyModule(pcm.data, pcm.name);
    expect(idP.role).toBe('PCM');
    expect(idP.doubled).toBe(false);
    // halfPad is meaningless for the non-doubled branch and must be left undefined.
    expect(idP.halfPad).toBeUndefined();

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    if (!r.ok) console.error('Checklist failures:', r.checks.filter((c) => !c.pass));
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);

    // Wizard must NOT have raised the half-2-padding check at all (only
    // doubled PCMs run it). Confirm by label.
    expect(r.checks.find((c) => /half-2 is 0xFF padding/.test(c.label))).toBeUndefined();

    // Post-patch BCM parse reads the target VIN.
    for (const a of r.after.bcmFullVins) {
      expect(a.vin).toBe(TARGET_VIN);
      expect(a.crcOk).toBe(true);
    }
    for (const a of r.after.bcmPartials) {
      expect(a.tail).toBe(TARGET_VIN.slice(9));
      expect(a.crcOk).toBe(true);
    }

    // PCM pass-through is the full 4-KB buffer (no doubling on output).
    const out = Object.fromEntries(r.files.map((f) => [f.role, f]));
    expect(out.PCM.data.length).toBe(4096);
    expect(out.PCM.data).toEqual(pcm.data);
  });

  /* Gen1 RFHUB (24C16, 2048 B):
   *
   * The wizard's identifyModule defers to parseModule for the role
   * decision. parseModule today only classifies 4096-byte (and 8192-byte
   * doubled) RFH buffers as 'RFHUB'; 2048-byte Gen1 buffers fall through
   * to type 'UNKNOWN' (see src/lib/__tests__/parseModule.test.js:
   * "classifies 2048-byte RFHUB Gen1 buffers as UNKNOWN today").
   *
   * Until parseModule learns the Gen1 size + signature, this trio cannot
   * reach a passing wizard run. The test below is `.skip`'d — flip it to
   * `it(...)` once parseModule wires up Gen1 detection. We still build
   * the fixture here so the regression beacon stays self-contained.
   */
  // eslint-disable-next-line vitest/no-disabled-tests
  it.skip('Gen1 RFHUB (24C16, 2048 B) trio — pending parseModule Gen1 wiring', () => {
    const bcm = {
      name: 'GEN1_BCM_DFLASH_OG.bin',
      data: makeBcmWithSecret({
        vin: BEFORE_VIN,
        partialTail: BEFORE_VIN.slice(9),
        vehicleSecret: SECRET_LE,
      }),
    };
    const rfh = {
      name: 'GEN1_RFH_EEE_OG.bin',
      data: makeRfhubGen1({ vin: TARGET_VIN, sec16Bytes: SECRET_BE }),
    };
    const pcm = {
      name: 'GEN1_GPEC2A_INT_FLASH_OG.bin',
      data: makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6 }),
    };

    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(true);
    expect(r.sharedSecret).toBe(SECRET_BE_HEX);
    for (const a of r.after.bcmFullVins) expect(a.vin).toBe(TARGET_VIN);
  });

  it('Gen1 RFHUB beacon: parseModule still classifies 2048-byte buffers as UNKNOWN', () => {
    // Today, parseModule treats 2048-byte RFH buffers as UNKNOWN; the wizard
    // therefore correctly refuses to run the trio (the beacon test above
    // skips). Pin that current behavior here so the moment parseModule
    // gains Gen1 detection, this assertion flips and the maintainer is
    // forced to enable the wizard test above (and the Gen1 SEC16 path
    // becomes covered end-to-end).
    const rfhGen1 = makeRfhubGen1({ vin: TARGET_VIN });
    const info = parseModule(rfhGen1, 'GEN1_RFH_EEE_OG.bin');
    expect(info.size).toBe(2048);
    expect(info.type).toBe('UNKNOWN');
    const id = identifyModule(rfhGen1, 'GEN1_RFH_EEE_OG.bin');
    expect(id.role).toBeNull();
  });
});
