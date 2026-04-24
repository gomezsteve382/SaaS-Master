/* ============================================================================
 * Task #439 — applyRfhToPcm must rewrite the 4th canonical PCM VIN slot
 * (0x0CE0) so a donor PCM (with a different vehicle's VIN at 0x0CE0) does
 * not silently retain the donor VIN after the RFH→PCM sync.
 *
 * Real workflow: a user has a paired BCM + RFHUB and a donor PCM
 * (GPEC2A) from a different car. The dedicated RFH→PCM tab derives SEC6
 * from the RFH SEC16, stamps the canonical FF FF FF AA marker + 6 secret
 * bytes at 0x3C4 / 0x3C8, rewrites the PCM VIN slots, and optionally
 * repairs the IMMO byte. Pre-#439 the VIN rewrite covered only the first
 * three slots (0x0000, 0x01F0, 0x0224) — the donor's VIN at 0x0CE0
 * survived in the patched file. This test pins the 4-slot fix.
 *
 * Coverage:
 *   - All four canonical slots equal the RFH VIN after the patch.
 *   - The PCM SEC6 marker (0x3C4..0x3C7) and SEC6 secret (0x3C8..0x3CD)
 *     match the canonical FF FF FF AA + RFH SEC16[0:6] — so the SEC6 path
 *     (Task #404 territory) is not regressed by this VIN-only change.
 *   - Bytes outside the four VIN slots and the SEC6 record are byte-equal
 *     to the input — the writer is targeted, not a wholesale rewrite.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { applyRfhToPcm, parseRFH24C32, parsePCMGPEC } from '../rfhPcmPair.js';
import { makeGpec2a, makeRfhubGen2, VIN_DEFAULT } from '../__fixtures__/buildFixtures.js';

const TARGET_VIN = VIN_DEFAULT;                 // RFH-paired vehicle.
const DONOR_VIN  = '2C3CDXKT3FH123456';         // Different car — what
                                                // the donor PCM came in
                                                // with at slot 0x0CE0.

const RFH_SECRET = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
  0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
]);
// Distinct from RFH_SECRET[0..6] so the SEC6 write is observable.
const PCM_SEC6_BEFORE = new Uint8Array([0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);

const VIN_OFFSETS_4 = [0x0000, 0x01F0, 0x0224, 0x0CE0];

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function readVinAt(buf, off) {
  let s = '';
  for (let i = 0; i < 17; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

// Build a Gen2 RFH that parseRFH24C32 will accept. The pcmSec6
// fullFileRoundTrip test follows the same pattern: the parser reads
// SEC16 at the Gen1 mirror offsets 0xAE / 0xC0, so we plant the
// secret there with the matching xor-cs trailer pair.
function buildPairedRfh() {
  const rfh = makeRfhubGen2({ vehicleSecret: RFH_SECRET, vin: TARGET_VIN });
  const rfhSec16Cs = (raw16) => {
    let c = 0xBF;
    for (let i = 0; i < 16; i++) {
      c ^= raw16[i];
      for (let j = 0; j < 8; j++) c = (c & 0x80) ? (((c << 1) ^ 0x65) & 0xFF) : ((c << 1) & 0xFF);
    }
    return c & 0xFF;
  };
  const csByte = rfhSec16Cs(RFH_SECRET);
  for (const off of [0xAE, 0xC0]) {
    for (let i = 0; i < 16; i++) rfh[off + i] = RFH_SECRET[i];
    rfh[off + 16] = csByte;
    rfh[off + 17] = 0x00;
  }
  return rfh;
}

// Build a 4 KB donor PCM. The fixture fills all 4 slots with TARGET_VIN
// (post-#439 default), so we overwrite slot 4 with DONOR_VIN to model
// the real-world donor-ECM case.
function buildDonorPcm() {
  const pcm = makeGpec2a({ vin: TARGET_VIN, pcmSec6Bytes: PCM_SEC6_BEFORE });
  const donor = asciiBytes(DONOR_VIN);
  for (let i = 0; i < 17; i++) pcm[0x0CE0 + i] = donor[i];
  return pcm;
}

describe('Task #439 — applyRfhToPcm rewrites all four canonical PCM VIN slots', () => {
  it('overwrites a donor VIN at 0x0CE0 with the RFH VIN', () => {
    const pcmBuf = buildDonorPcm();
    const rfhBuf = buildPairedRfh();

    // Sanity: the donor really did sit at 0x0CE0 before the patch.
    expect(readVinAt(pcmBuf, 0x0CE0)).toBe(DONOR_VIN);
    for (const off of [0x0000, 0x01F0, 0x0224]) {
      expect(readVinAt(pcmBuf, off)).toBe(TARGET_VIN);
    }

    const rfh = parseRFH24C32(rfhBuf);
    const pcm = parsePCMGPEC(pcmBuf);
    expect(rfh.sec6).toBeTruthy();
    expect(pcm.writeCheck.ok).toBe(true);

    const r = applyRfhToPcm(rfh, pcm, pcmBuf, { repairImmo: false });
    expect(r).not.toBeNull();
    expect(r.error).toBeFalsy();
    const out = r.data;

    // All four canonical slots now equal the paired RFH VIN.
    for (const off of VIN_OFFSETS_4) {
      expect(readVinAt(out, off), `VIN slot @ 0x${off.toString(16).toUpperCase()}`).toBe(TARGET_VIN);
    }
    // The apply log mentions every slot (4 entries, one per offset).
    const vinLogLines = r.log.filter(l => l.startsWith('PCM VIN @'));
    expect(vinLogLines).toHaveLength(4);
    expect(vinLogLines.some(l => l.includes('0x0CE0'))).toBe(true);
  });

  it('SEC6 path is not regressed — marker @ 0x3C4 and SEC6 @ 0x3C8 still byte-equal', () => {
    const pcmBuf = buildDonorPcm();
    const rfhBuf = buildPairedRfh();
    const rfh = parseRFH24C32(rfhBuf);
    const pcm = parsePCMGPEC(pcmBuf);
    const r = applyRfhToPcm(rfh, pcm, pcmBuf, { repairImmo: false });
    expect(r.error).toBeFalsy();
    const out = r.data;

    // Canonical Continental SEC6 marker.
    expect(Array.from(out.slice(0x3C4, 0x3C8))).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
    // SEC6 = first 6 bytes of the RFH SEC16.
    expect(Array.from(out.slice(0x3C8, 0x3CE))).toEqual(Array.from(RFH_SECRET.slice(0, 6)));
  });

  it('writes are targeted — bytes outside the 4 VIN slots and SEC6 record are unchanged', () => {
    const pcmBuf = buildDonorPcm();
    const rfhBuf = buildPairedRfh();
    const rfh = parseRFH24C32(rfhBuf);
    const pcm = parsePCMGPEC(pcmBuf);
    const r = applyRfhToPcm(rfh, pcm, pcmBuf, { repairImmo: false });
    const out = r.data;

    // Build a mask of offsets the writer is allowed to touch:
    //   - 17 bytes per VIN slot (0x0000, 0x01F0, 0x0224, 0x0CE0)
    //   - 4 bytes for the SEC6 marker (0x3C4..0x3C7)
    //   - 6 bytes for the SEC6 secret (0x3C8..0x3CD)
    const allowed = new Uint8Array(out.length);
    for (const off of VIN_OFFSETS_4) for (let i = 0; i < 17; i++) allowed[off + i] = 1;
    for (let i = 0; i < 4; i++) allowed[0x3C4 + i] = 1;
    for (let i = 0; i < 6; i++) allowed[0x3C8 + i] = 1;

    let drift = 0;
    for (let i = 0; i < out.length; i++) {
      if (!allowed[i] && out[i] !== pcmBuf[i]) drift++;
    }
    expect(drift, 'bytes outside VIN slots & SEC6 record changed').toBe(0);
  });
});
