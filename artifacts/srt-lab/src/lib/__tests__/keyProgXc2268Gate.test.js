import { describe, it, expect } from 'vitest';
import { runRfhBcmSync } from '../keyProgWizard.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';

/* KeyProgTab (keyProgWizard) writes XC2268 RFHUB SEC16 with the UNVERIFIED
 * writeXc2268Sec16 (offset map + image checksum reconstructed from a
 * screenshot). Writing that to a real 2019+ Ram RFHUB can brick it, so — same
 * standard as the marryModule engine and ModuleSync — it must refuse without an
 * explicit allowUnverifiedTarget. The bench-verified Gen2 Yazaki path is
 * ungated. */

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);
const bcm = () => rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), ROOT).bytes;
function xc2268() {
  const b = new Uint8Array(65536);
  'XC22'.split('').forEach((c, i) => (b[i] = c.charCodeAt(0)));
  'RFHUB'.split('').forEach((c, i) => (b[0x10 + i] = c.charCodeAt(0)));
  return b;
}
function gen2() {
  const b = new Uint8Array(4096);
  b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01;
  return b;
}
const unverifiedCheck = (r) => (r.checks || []).find((c) => /UNVERIFIED/i.test(c.label) && !c.pass);

describe('runRfhBcmSync — XC2268 unverified-writer gate', () => {
  it('refuses an XC2268 RFHUB target without allowUnverifiedTarget', () => {
    const r = runRfhBcmSync({ rfh: { data: xc2268() }, bcm: { data: bcm() }, direction: 'BCM_TO_RFH' });
    expect(r.ok).toBe(false);
    expect(unverifiedCheck(r)).toBeTruthy();
  });

  it('does not fire the unverified gate once acknowledged', () => {
    const r = runRfhBcmSync({ rfh: { data: xc2268() }, bcm: { data: bcm() }, direction: 'BCM_TO_RFH', allowUnverifiedTarget: true });
    // it may pass or fail later checks, but the UNVERIFIED-gate must be gone
    expect(unverifiedCheck(r)).toBeFalsy();
  });

  it('does NOT gate a bench-verified Gen2 RFHUB', () => {
    const r = runRfhBcmSync({ rfh: { data: gen2() }, bcm: { data: bcm() }, direction: 'BCM_TO_RFH' });
    expect(unverifiedCheck(r)).toBeFalsy();
  });
});
