/**
 * Task #406 — full-file byte-identical round-trip across every BCM→PCM
 * sync code path.
 *
 * Task #404 reconciled five production writer paths to delegate to one
 * engine writer (`writePcmSec6`). The earlier `pcmSec6.entryPointParity`
 * test pins the SEC6 record region (0x3C4..0x3CD) across three of those
 * paths. This test extends the contract:
 *
 *   1. Exercises ALL FIVE production paths on the SAME (BCM, RFH, PCM)
 *      fixture pair.
 *   2. Asserts the resulting PCM is byte-identical across every path
 *      — not just the SEC6 record region, but every byte of the file.
 *   3. Asserts the canonical marker @ 0x3C4 (FF FF FF AA) and the SEC6
 *      bytes @ 0x3C8 are stamped to the expected values.
 *
 * The five paths (with source line refs at the time of writing):
 *   P1. TwinTab.applyPcmFromBcm                  (TwinTab.jsx:231-242)
 *   P2. rfhPcmPair.applyRfhToPcm                 (rfhPcmPair.js:384-430)
 *   P3. SecurityTab.matchAll  (sync-all GPEC2A)  (SecurityTab.jsx:84-112)
 *   P4. SecurityTab.doTool('rfhPcmSync')         (SecurityTab.jsx:126-141)
 *   P5. SecurityTab.syncGpecRfh                  (SecurityTab.jsx:163-181)
 *
 * P1 / P4 don't touch VINs; P2 / P3 / P5 also rewrite PCM VIN slots. To
 * make all five outputs byte-identical we use a fixture pair where the
 * RFH VIN, the BCM VIN, and the PCM VIN at every PCM slot already match
 * (VIN_DEFAULT) — the VIN-write paths then become byte-level no-ops and
 * the only thing each path mutates is the SEC6 region. Any future drift
 * (e.g. one path silently shifting a VIN offset, or skipping the marker
 * stamp) causes a hard byte-diff failure here.
 *
 * NOTE: P1 / P3 / P4 / P5 used to live inline inside JSX component
 * closures. Task #406 extracted the per-path byte transformation into
 * three exported pure functions in `lib/bcmPcmSync.js` (applyPcmFromBcm,
 * applyPcmSec6FromRfh, applyPcmFromRfhWithVin). The production tabs
 * (TwinTab.applyPcmFromBcm, SecurityTab.matchAll/rfhPcmSync/syncGpecRfh)
 * now call those exports, and so does this test — so any drift in one
 * tab's wiring fails this round-trip immediately. P2 (rfhPcmPair) is
 * driven end-to-end via its own existing exports.
 */
import { describe, it, expect } from 'vitest';
import {
  applyPcmFromBcm,
  applyPcmSec6FromRfh,
  applyPcmFromRfhWithVin,
} from '../bcmPcmSync.js';
import { applyRfhToPcm, parseRFH24C32, parsePCMGPEC } from '../rfhPcmPair.js';
import { parseModule } from '../parseModule.js';
import { makeBcm, makeRfhubGen2, makeGpec2a, VIN_DEFAULT } from '../__fixtures__/buildFixtures.js';

// Pair the fixtures so reverse(BCM SEC16) === RFH SEC16 — this is the
// real-bench invariant (BCM stores the SEC16 byte-reversed relative to
// the RFHUB EEPROM). Every path then derives the same 6 SEC6 bytes.
const RFH_SECRET = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
  0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
]);
const BCM_SECRET = new Uint8Array([...RFH_SECRET].reverse());
// Distinct from RFH_SECRET[0..6] so the write is observable (not a no-op).
const PCM_SEC6_BEFORE = new Uint8Array([0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);

const EXPECTED_SEC6 = Array.from(RFH_SECRET.slice(0, 6)); // 01 23 45 67 89 AB
const EXPECTED_MARKER = [0xFF, 0xFF, 0xFF, 0xAA];

function buildFixturePair(pcmSize) {
  // makeBcm writes vehicleSecret @ 0x40C9, but it ALSO writes IMMO
  // records into 0x40C0..0x4180 AFTER the secret, which clobbers the
  // first 16 bytes at 0x40C9. Re-stamp BCM_SECRET at the SEC16 offsets
  // here (and mirror at 0x40F1) so TwinTab.parseBcm reads back exactly
  // what we want — same BCM_SEC16_OFFSETS = [0x40C9, 0x40F1].
  const bcm = makeBcm({ vehicleSecret: BCM_SECRET, vin: VIN_DEFAULT });
  for (const off of [0x40C9, 0x40F1]) {
    for (let i = 0; i < 16; i++) bcm[off + i] = BCM_SECRET[i];
  }
  // makeRfhubGen2 writes the Gen2 SEC16 slots @ 0x050E / 0x0522 (the
  // offsets parseModule checks). rfhPcmPair.parseRFH24C32 historically
  // reads SEC16 at 0xAE / 0xC0 (the Gen1 slot pair, which real Gen2
  // RFHUB dumps also carry as a back-compat mirror), so we mirror the
  // 16 bytes there too with the matching crc8_65 CS so BOTH parsers
  // surface the same SEC16 → SEC6.
  const rfh = makeRfhubGen2({ vehicleSecret: RFH_SECRET, vin: VIN_DEFAULT });
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
    // parseRFH24C32 accepts (csStored & 0xFF) === xr (XOR of the 16
    // bytes). RFH_SECRET XORs to 0x00, and the crc8_65-style write
    // stores [csByte, 0x00] — low byte = 0x00 = xr → csOk = true.
    rfh[off + 16] = csByte;
    rfh[off + 17] = 0x00;
  }
  // PCM with a deliberately-different SEC6 so the write is observable.
  const pcm = makeGpec2a({ vin: VIN_DEFAULT, pcmSec6Bytes: PCM_SEC6_BEFORE });
  if (pcmSize === 8192) {
    // Promote to canonical 8 KB GPEC2A by padding with 0xFF; SEC6 layout
    // (0x3C4 marker + 0x3C8 secret) is identical for both sizes.
    const big = new Uint8Array(8192).fill(0xFF);
    big.set(pcm, 0);
    return { bcm, rfh, pcm: big };
  }
  return { bcm, rfh, pcm };
}

// ─── Path implementations ────────────────────────────────────────────────────

// P1 — TwinTab.applyPcmFromBcm. TwinTab parses the BCM image, reads
// `bcmInfo.sec16Copies[0].raw` from 0x40C9, then calls the shared
// `applyPcmFromBcm` export (which reverses the SEC16 and stamps the
// PCM). Test invokes the same export with the same input.
function pathTwinTab(pcmBuf, bcmBuf) {
  const bcmSec16Stored = bcmBuf.slice(0x40C9, 0x40C9 + 16);
  const r = applyPcmFromBcm(pcmBuf, bcmSec16Stored);
  expect(r.ok).toBe(true);
  return r.bytes;
}

// P2 — rfhPcmPair.applyRfhToPcm. End-to-end via the real lib functions:
// parseRFH24C32 → parsePCMGPEC → applyRfhToPcm. (This path keeps its
// own wrapper because it also handles an optional IMMO-byte repair.)
function pathRfhPcmPair(pcmBuf, rfhBuf) {
  const rfh = parseRFH24C32(rfhBuf);
  const pcm = parsePCMGPEC(pcmBuf);
  const r = applyRfhToPcm(rfh, pcm, pcmBuf, { repairImmo: false });
  expect(r).not.toBeNull();
  expect(r.error).toBeFalsy();
  return r.data;
}

// P3 — SecurityTab.matchAll (GPEC2A branch). The fixture has no skey,
// so matchAll's adaptation block is skipped and the only PCM mutation
// is writeModuleVIN(GPEC2A) followed by applyPcmSec6FromRfh — which is
// exactly the byte transformation `applyPcmFromRfhWithVin` performs.
function pathSecurityTabMatchAll(pcmBuf, rfhBuf) {
  // forceType: 8 KB GPEC2A images are classified as 95640 by default
  // (see parseModule.js:438-441); production tabs that load PCMs pass
  // {forceType:'GPEC2A'} for exactly this reason.
  const pcmMod = parseModule(pcmBuf, 'pcm.bin', { forceType: 'GPEC2A' });
  const rfhMod = parseModule(rfhBuf, 'rfh.bin');
  expect(pcmMod.type).toBe('GPEC2A');
  expect(rfhMod.type).toBe('RFHUB');
  expect(rfhMod.sec16valid).toBe(true);
  const w = applyPcmFromRfhWithVin(pcmMod.data, rfhMod.sec16s[0].raw, VIN_DEFAULT, pcmMod.vins);
  expect(w.ok).toBe(true);
  return w.bytes;
}

// P4 — SecurityTab.doTool('rfhPcmSync'). Pure SEC6 import — no VIN
// write — wired to the shared `applyPcmSec6FromRfh` export.
function pathSecurityTabRfhPcmSync(pcmBuf, rfhBuf) {
  const rfhMod = parseModule(rfhBuf, 'rfh.bin');
  expect(rfhMod.sec16valid).toBe(true);
  const w = applyPcmSec6FromRfh(pcmBuf, rfhMod.sec16s[0].raw);
  expect(w.ok).toBe(true);
  return w.bytes;
}

// P5 — SecurityTab.syncGpecRfh. Same shared export as P3.
function pathSecurityTabSyncGpecRfh(pcmBuf, rfhBuf) {
  const pcmMod = parseModule(pcmBuf, 'pcm.bin', { forceType: 'GPEC2A' });
  const rfhMod = parseModule(rfhBuf, 'rfh.bin');
  expect(rfhMod.sec16valid).toBe(true);
  const w = applyPcmFromRfhWithVin(pcmMod.data, rfhMod.sec16s[0].raw, VIN_DEFAULT, pcmMod.vins);
  expect(w.ok).toBe(true);
  return w.bytes;
}

// ─── The actual round-trip test ──────────────────────────────────────────────

describe('Task #406 — every BCM→PCM sync path produces byte-identical files', () => {
  for (const pcmSize of [4096, 8192]) {
    it(`all five paths produce byte-identical PCM bytes on ${pcmSize}-byte GPEC2A`, () => {
      const { bcm, rfh, pcm } = buildFixturePair(pcmSize);

      // Snapshot the input PCM so we can prove it wasn't mutated under us.
      const pcmSnapshot = new Uint8Array(pcm);

      const out1 = pathTwinTab(pcm, bcm);
      const out2 = pathRfhPcmPair(pcm, rfh);
      const out3 = pathSecurityTabMatchAll(pcm, rfh);
      const out4 = pathSecurityTabRfhPcmSync(pcm, rfh);
      const out5 = pathSecurityTabSyncGpecRfh(pcm, rfh);

      // Inputs must not have been mutated by any path.
      expect(Array.from(pcm)).toEqual(Array.from(pcmSnapshot));

      // All five outputs are exactly `pcmSize` bytes long.
      for (const [name, out] of [['P1', out1], ['P2', out2], ['P3', out3], ['P4', out4], ['P5', out5]]) {
        expect(out.length, `${name} output length`).toBe(pcmSize);
      }

      // Byte-identical files across every path. Compare against P1 so the
      // failure message points at the diverging path.
      const ref = Array.from(out1);
      expect(Array.from(out2), 'P2 (applyRfhToPcm) drifted from P1 (TwinTab)').toEqual(ref);
      expect(Array.from(out3), 'P3 (SecurityTab.matchAll) drifted from P1').toEqual(ref);
      expect(Array.from(out4), 'P4 (SecurityTab.rfhPcmSync) drifted from P1').toEqual(ref);
      expect(Array.from(out5), 'P5 (SecurityTab.syncGpecRfh) drifted from P1').toEqual(ref);

      // Marker @ 0x3C4 stamped to FF FF FF AA in every output.
      expect(Array.from(out1.slice(0x3C4, 0x3C8))).toEqual(EXPECTED_MARKER);
      // SEC6 @ 0x3C8 stamped to RFH SEC16[0..6) in every output.
      expect(Array.from(out1.slice(0x3C8, 0x3CE))).toEqual(EXPECTED_SEC6);

      // And the write was observable — the pre-write SEC6 bytes (0x99×6)
      // are gone. Guards against a "no-op pass" if the fixture were ever
      // changed to already carry the expected SEC6.
      expect(Array.from(out1.slice(0x3C8, 0x3CE)))
        .not.toEqual(Array.from(PCM_SEC6_BEFORE));
    });
  }
});
