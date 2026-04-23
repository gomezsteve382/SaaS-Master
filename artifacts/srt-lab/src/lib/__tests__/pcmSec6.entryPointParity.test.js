/**
 * Task #404 — entry-point parity for PCM SEC6 writes.
 *
 * After unifying SEC6 writing through `writePcmSec6`, the three production
 * apply paths must produce byte-identical PCM bytes in the SEC6 record
 * region (0x3C4..0x3CD = 4-byte marker + 6 secret bytes) when fed the same
 * upstream secret. The three paths are:
 *
 *   1. Direct engine writer:           writePcmSec6(pcm, rfhSec16)
 *   2. RFH→PCM applier (RFHPCMTab):    applyRfhToPcm(rfh, pcm, pcmBuf)
 *   3. BCM→PCM applier (TwinTab):      writePcmSec6(pcm, reverse(bcmSec16))
 *
 * If any path drifts (inline write, different offset, missing marker, or
 * different source-byte slicing), this test fails — preventing the "synced
 * file but still IMMO_DAMAGED externally" regression class.
 */
import { describe, it, expect } from 'vitest';
import { writePcmSec6 } from '../securityBytes.js';
import { applyRfhToPcm } from '../rfhPcmPair.js';

function makeBlankPcm(size) {
  const b = new Uint8Array(size);
  // Fill VIN slot so parsers don't reject — value doesn't affect SEC6 region.
  const vin = '2C3CDXL90MH582899';
  for (let i = 0; i < 17; i++) b[i] = vin.charCodeAt(i);
  return b;
}

function makeRfhStub(sec6Source) {
  // applyRfhToPcm only reads rfh.sec6.{raw,hex,sourceSlot} and rfh.vin.value.
  // Construct a minimal stub matching that shape so we can pin entry-point
  // parity without standing up a full Gen2 RFHUB buffer.
  const raw = Array.from(sec6Source.slice(0, 6));
  const hex = raw.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  return { sec6: { raw, hex, sourceSlot: 0 }, vin: null };
}

function makePcmStub(buf) {
  // applyRfhToPcm gates on pcm.writeCheck.ok. We let the engine writer
  // (writePcmSec6) decide canonical-size acceptance; the stub just lets
  // the wrapper proceed to the writer call.
  return { writeCheck: { ok: true }, immo: null };
}

describe('Task #404 — PCM SEC6 entry-point parity', () => {
  for (const size of [4096, 8192]) {
    it(`all three apply paths produce byte-identical 0x3C4..0x3CD on ${size}-byte PCM`, () => {
      const sec6 = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]);
      const pcm = makeBlankPcm(size);

      // Path 1: direct engine writer with raw RFH SEC16-style 6 bytes.
      const r1 = writePcmSec6(pcm, sec6);
      expect(r1.ok).toBe(true);

      // Path 2: RFH→PCM applier (RFHPCMTab production path).
      const rfh = makeRfhStub(sec6);
      const pcmInfo = makePcmStub(pcm);
      const r2 = applyRfhToPcm(rfh, pcmInfo, pcm);
      expect(r2.error).toBeFalsy();

      // Path 3: BCM→PCM applier (TwinTab production path). BCM stores
      // reverse(RFHUB SEC16), so TwinTab feeds reverse(bcmSec16) into the
      // same engine writer. Construct a "BCM SEC16" that round-trips to
      // the same source 6 bytes when reversed and sliced [0..6).
      const bcmSec16 = new Uint8Array(16);
      // We want reverse(bcmSec16)[0..6) === sec6[0..6).
      // reverse(bcmSec16)[i] = bcmSec16[15 - i].  So bcmSec16[15 - i] = sec6[i].
      for (let i = 0; i < 6; i++) bcmSec16[15 - i] = sec6[i];
      const sec16Rev = new Uint8Array([...bcmSec16].reverse());
      const r3 = writePcmSec6(pcm, sec16Rev);
      expect(r3.ok).toBe(true);

      // SEC6 record region = marker(4) + secret(6) = bytes [0x3C4..0x3CE).
      const regionOf = (buf) => Array.from(buf.slice(0x3C4, 0x3CE));
      const region1 = regionOf(r1.bytes);
      const region2 = regionOf(r2.data);
      const region3 = regionOf(r3.bytes);

      // All three must be byte-identical.
      expect(region2).toEqual(region1);
      expect(region3).toEqual(region1);

      // And the canonical layout must hold: FF FF FF AA + sec6.
      expect(region1).toEqual([
        0xFF, 0xFF, 0xFF, 0xAA,
        0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC,
      ]);
    });
  }

  it('non-canonical PCM size: all three paths refuse without writing the SEC6 region', () => {
    const sec6 = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    // Padded capture (e.g. 16 KB BIN slice) — not a canonical GPEC2A.
    const pcm = makeBlankPcm(16384);
    const before = Array.from(pcm.slice(0x3C4, 0x3CE));

    const r1 = writePcmSec6(pcm, sec6);
    expect(r1.ok).toBe(false);
    expect(Array.from(r1.bytes.slice(0x3C4, 0x3CE))).toEqual(before);

    const rfh = makeRfhStub(sec6);
    const pcmInfo = makePcmStub(pcm);
    const r2 = applyRfhToPcm(rfh, pcmInfo, pcm);
    expect(r2.error).toBeTruthy();

    // TwinTab's BCM→PCM path also delegates to writePcmSec6.
    const bcmSec16 = new Uint8Array(16);
    for (let i = 0; i < 6; i++) bcmSec16[15 - i] = sec6[i];
    const sec16Rev = new Uint8Array([...bcmSec16].reverse());
    const r3 = writePcmSec6(pcm, sec16Rev);
    expect(r3.ok).toBe(false);
    expect(Array.from(r3.bytes.slice(0x3C4, 0x3CE))).toEqual(before);
  });
});
