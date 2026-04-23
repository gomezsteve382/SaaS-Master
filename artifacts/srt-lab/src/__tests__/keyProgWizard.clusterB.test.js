/* Task #343 e2e — drives the wizard pure logic with the real Cluster B
 * fixtures and asserts the three downloaded bins match the patch script
 * outputs byte-for-byte (SHA-256). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runKeyProgPatch, identifyModule } from '../lib/keyProgWizard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTACHED = path.resolve(__dirname, '..', '..', '..', '..', 'attached_assets');

const SRC_BCM = '22CHARGER_REDEYE_6.2_797RFHUB_EEE_OGFILE_VIRGIN_1776900226655.bin';
const SRC_RFH = 'RFH_HERMANADO_20CHRGR6.2RFHUBFILE_EEE_OG_VIRGINSYCHNED_1776899205057.bin';
const SRC_PCM = 'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2_1776899205055.bin';
const TARGET_VIN = '2C3CDXCT1HH652640';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (n) => new Uint8Array(fs.readFileSync(path.join(ATTACHED, n)));

describe('Cluster B key-prog wizard (Task #343)', () => {
  const expectedBcm = read(SRC_BCM.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));
  const expectedRfh = read(SRC_RFH.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));
  const expectedPcm = read(SRC_PCM.replace(/\.bin$/i, '_KEYPROG_' + TARGET_VIN + '.bin'));

  const bcm = { name: SRC_BCM, data: read(SRC_BCM) };
  const rfh = { name: SRC_RFH, data: read(SRC_RFH) };
  const pcm = { name: SRC_PCM, data: read(SRC_PCM) };

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
    expect(r.sharedSecret).toBe('816531F7CDE32E33C25A415C8440C72A');
    // BEFORE shows the previous VIN, AFTER shows the target VIN.
    for (const a of r.after.bcmFullVins) {
      expect(a.vin).toBe(TARGET_VIN);
      expect(a.crcOk).toBe(true);
    }
    for (const a of r.after.bcmPartials) {
      expect(a.tail).toBe(TARGET_VIN.slice(9));
      expect(a.crcOk).toBe(true);
    }
  });

  it('emits the same three bins as the patch-cluster-b-vin.mjs script', () => {
    const r = runKeyProgPatch({ bcm, rfh, pcm, vin: TARGET_VIN });
    expect(r.ok).toBe(true);
    const out = Object.fromEntries(r.files.map((f) => [f.role, f]));
    expect(sha(out.BCM.data)).toBe(sha(expectedBcm));
    expect(sha(out.RFH.data)).toBe(sha(expectedRfh));
    expect(sha(out.PCM.data)).toBe(sha(expectedPcm));
    // Output filenames use the same `<stem>_KEYPROG_<vin>.bin` convention.
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
    // 0x2000..0x2000+192 is the IMMO backup region. Off → unchanged from
    // source; on → replaced with primary at 0x40C0.
    let differs = false;
    for (let i = 0; i < 192; i++) if (offBcm[0x2000 + i] !== onBcm[0x2000 + i]) { differs = true; break; }
    expect(differs).toBe(true);
    // The OFF version must match source for that region (do-not-promote guarantee).
    for (let i = 0; i < 192; i++) expect(offBcm[0x2000 + i]).toBe(bcm.data[0x2000 + i]);
    // The OFF run must still pass all checks; the ON run will fail the
    // forbidden-region guard because 0x2000 is one of the forbidden ranges.
    expect(off.ok).toBe(true);
    expect(on.ok).toBe(false);
  });
});
