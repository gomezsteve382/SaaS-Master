/* Task #343 e2e — drives the wizard pure logic with the real Cluster B
 * fixtures.
 *
 * Originally pinned the wizard's BCM/RFH/PCM outputs to SHA-256 equality
 * against the patch-cluster-b-vin.mjs reference outputs. Task #366 deleted
 * those misleadingly-named reference outputs in favor of the new clean
 * BCM_/RFH_/PCM_-prefixed bundle, so this test now asserts the equivalent
 * invariants directly from the source bytes:
 *   - BCM output: 4 full + 2 partial VINs at the target VIN with valid CRCs;
 *     the LE secret @0x40C9 is the BE form of the shared Cluster B secret.
 *   - RFH output: SHA-256 equal to source (pass-through).
 *   - PCM output: SHA-256 equal to source (pass-through).
 *
 * Auto-skips when source fixtures are absent (matches the convention used
 * by vinPatch.golden.test.js / keyprogBundle.golden.test.js). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runKeyProgPatch, identifyModule } from '../lib/keyProgWizard.js';
import { parseModule } from '../lib/parseModule.js';
import { crc16 } from '../lib/crc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTACHED = path.resolve(__dirname, '..', '..', '..', '..', 'attached_assets');

const SRC_BCM = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';
const TARGET_VIN = '2C3CDXCT1HH652640';
const TARGET_TAIL = TARGET_VIN.slice(9);
const SHARED_SECRET_HEX = '816531F7CDE32E33C25A415C8440C72A';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function loadOrNull(n) {
  const p = path.join(ATTACHED, n);
  if (!fs.existsSync(p)) return null;
  return new Uint8Array(fs.readFileSync(p));
}

const bcmSrc = loadOrNull(SRC_BCM);
const rfhSrc = loadOrNull(SRC_RFH);
const pcmSrc = loadOrNull(SRC_PCM);
const haveFixtures = !!(bcmSrc && rfhSrc && pcmSrc);

const d = haveFixtures ? describe : describe.skip;

d('Cluster B key-prog wizard (Task #343)', () => {
  const bcm = { name: SRC_BCM, data: bcmSrc };
  const rfh = { name: SRC_RFH, data: rfhSrc };
  const pcm = { name: SRC_PCM, data: pcmSrc };

  it('identifies each module by content (not by filename)', () => {
    expect(identifyModule(bcm.data, bcm.name).role).toBe('BCM');
    expect(identifyModule(rfh.data, rfh.name).role).toBe('RFH');
    const idP = identifyModule(pcm.data, pcm.name);
    expect(idP.role).toBe('PCM');
    expect(idP.doubled).toBe(true);
    expect(idP.halfPad).toBe(true);
  });

  it('passes every checklist item with the correct VIN', () => {
    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    if (!r.ok) {
      console.error('Checklist failures:', r.checks.filter((c) => !c.pass));
    }
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.sharedSecret).toBe(SHARED_SECRET_HEX);
    for (const a of r.after.bcmFullVins) {
      expect(a.vin).toBe(TARGET_VIN);
      expect(a.crcOk).toBe(true);
    }
    for (const a of r.after.bcmPartials) {
      expect(a.tail).toBe(TARGET_TAIL);
      expect(a.crcOk).toBe(true);
    }
  });

  it('emits a BCM with all VINs+CRCs at target and RFH/PCM byte-identical to source', () => {
    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(true);
    const out = Object.fromEntries(r.files.map((f) => [f.role, f]));

    // RFH/PCM are pure pass-through, so SHA-256 must equal source.
    expect(sha(out.RFH.data)).toBe(sha(rfhSrc));
    expect(sha(out.PCM.data)).toBe(sha(pcmSrc));

    // BCM was patched: re-parse and assert the property invariants directly
    // (replaces the old "must SHA-equal a reference output file" check).
    const bcmInfo = parseModule(out.BCM.data, out.BCM.name);
    expect(bcmInfo.type).toBe('BCM');
    expect(bcmInfo.vins).toHaveLength(4);
    for (const v of bcmInfo.vins) {
      expect(v.vin).toBe(TARGET_VIN);
      const crcStored = (out.BCM.data[v.offset + 17] << 8) | out.BCM.data[v.offset + 18];
      const crcCalc = crc16(out.BCM.data.slice(v.offset, v.offset + 17));
      expect(crcStored).toBe(crcCalc);
    }
    expect(bcmInfo.partialVins).toHaveLength(2);
    for (const p of bcmInfo.partialVins) {
      expect(p.tail).toBe(TARGET_TAIL);
      expect(p.crcOk).toBe(true);
    }
    // LE secret @0x40C9, BE form = shared Cluster B secret.
    const beHex = Array.from(bcmInfo.vehicleSecret.bytes)
      .reverse()
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
    expect(beHex).toBe(SHARED_SECRET_HEX);

    // Output filenames still use the in-app `<stem>_KEYPROG_<vin>.bin`
    // convention (the rebundled BCM_/RFH_/PCM_ prefixes only apply to the
    // CLI bundler's static output, not the GUI wizard's per-upload outputs).
    expect(out.BCM.name).toBe(SRC_BCM.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));
    expect(out.RFH.name).toBe(SRC_RFH.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));
    expect(out.PCM.name).toBe(SRC_PCM.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));
    expect(out.VERIFY.name).toBe('VERIFY_KEYPROG_' + TARGET_VIN + '.txt');
  });

  it('refuses to succeed when VIN is wrong length', () => {
    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: 'TOO_SHORT' });
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => !c.pass && /17 char/.test(c.label))).toBe(true);
  });

  it('promoteBank=true changes the BCM IMMO backup region', () => {
    const off = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN, promoteBank: false });
    const on = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN, promoteBank: true });
    const offBcm = off.files.find((f) => f.role === 'BCM').data;
    const onBcm = on.files.find((f) => f.role === 'BCM').data;
    let differs = false;
    for (let i = 0; i < 192; i++) if (offBcm[0x2000 + i] !== onBcm[0x2000 + i]) { differs = true; break; }
    expect(differs).toBe(true);
    for (let i = 0; i < 192; i++) expect(offBcm[0x2000 + i]).toBe(bcm.data[0x2000 + i]);
    expect(off.ok).toBe(true);
    expect(on.ok).toBe(false);
  });
});
