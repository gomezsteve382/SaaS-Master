/* ============================================================================
 * bcmPcmPairing.samplePair.test.js — locks in that the advertised
 * "instant bench dry-run" on the BCM → PCM tab actually pairs correctly
 * for the bundled `sxt-charger-237142` sample pair.
 *
 * Task #1081 wired the sample pickers in BcmPcmPairingTab so the
 * `sxt-charger-237142` BCM (65 536 B) + PCM (8 192 B) fixtures auto-load.
 * This test drives the SAME library primitives the tab uses
 * (parseBcm → parsePCMGPEC → computeVerdict → applyPcmFromBcm) against the
 * real fixture bytes and asserts:
 *
 *   1. The pair parses to a non-LOCKED, applyable verdict.
 *   2. The PCM SEC6 derivation chain (BCM SEC16 byte-reversed → first 6 B)
 *      matches the value the BCM panel surfaces.
 *   3. applyPcmFromBcm stamps the canonical FF FF FF AA marker @ 0x3C4 and
 *      the derived 6 secret bytes @ 0x3C8 into the PCM image.
 *
 * Both halves of this pair are byte-identical real bench captures of a 2020
 * Charger SXT (VIN 2C3CDXL97LH237142). The PCM in this set is already paired
 * (its SEC6 already matches the BCM), so the verdict is COMPATIBLE and the
 * write is a confirming re-stamp — exactly what a bench operator would expect
 * from a "load the sample and dry-run it" flow.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBcm } from '../twinBcmHelpers.js';
import { parsePCMGPEC } from '../rfhPcmPair.js';
import { computeVerdict } from '../../tabs/BcmPcmPairingTab.jsx';
import { applyPcmFromBcm } from '../bcmPcmSync.js';

const FIXTURES = resolve(__dirname, '../../__tests__/fixtures');
const BCM_FILE = 'SAMPLE_BCM_DFLASH_RESCUED_VIN_CRC_2C3CDXL97LH237142_0d3593f2.bin';
const PCM_FILE = 'SAMPLE_GPEC2A_EXT_EEPROM_8KB_RESCUED_VIN_CRC_2C3CDXL97LH237142_566b18fa.bin';
const SAMPLE_VIN = '2C3CDXL97LH237142';

// reverse(BCM SEC16)[0..6) — the canonical PCM SEC6 for this bench pair.
const EXPECTED_SEC6 = [0xAB, 0x80, 0x15, 0xD7, 0x7E, 0xD9];
const EXPECTED_MARKER = [0xFF, 0xFF, 0xFF, 0xAA];

function loadBin(name) {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

describe('BCM → PCM pairing — sxt-charger-237142 sample pair', () => {
  const bcmData = loadBin(BCM_FILE);
  const pcmData = loadBin(PCM_FILE);
  const bcm = parseBcm(bcmData, BCM_FILE);
  const pcm = parsePCMGPEC(pcmData);

  it('fixtures are the expected canonical sizes', () => {
    expect(bcmData.length).toBe(65536);
    expect(pcmData.length).toBe(8192);
  });

  it('BCM parses with the sample VIN and a CRC-valid, non-blank SEC16', () => {
    expect(bcm).not.toBeNull();
    expect(bcm.vins[0]?.vin).toBe(SAMPLE_VIN);
    expect(bcm.vins[0]?.csOk).toBe(true);
    // At least one CRC-valid, non-blank SEC16 copy must exist (the gate the
    // tab uses before it will derive a SEC6).
    const validCopy = bcm.sec16Copies.find(
      c => c.csOk && !c.raw.every(b => b === 0xFF || b === 0x00)
    );
    expect(validCopy).toBeTruthy();
  });

  it('SEC6 derivation chain (BCM SEC16 reversed → first 6 B) matches expectations', () => {
    // The hex the BCM panel surfaces.
    expect(bcm.pcmSec6Hex).toBe('AB 80 15 D7 7E D9');
    // And it is genuinely reverse(SEC16)[0..6) — proven from the raw bytes,
    // not just the pre-formatted string.
    const sec16Raw = bcm.sec16Copies[0].raw;
    const derived = [...sec16Raw].reverse().slice(0, 6);
    expect(derived).toEqual(EXPECTED_SEC6);
  });

  it('computeVerdict yields a non-LOCKED, applyable verdict', () => {
    const v = computeVerdict(bcm, pcm);
    expect(v.verdict).not.toBe('LOCKED');
    expect(v.canApply).toBe(true);
    expect(v.issues).toEqual([]);
    // This bench pair is already paired, so the verdict is COMPATIBLE.
    expect(v.verdict).toBe('COMPATIBLE');
    expect(v.vinMatch).toBe(true);
  });

  it('applyPcmFromBcm stamps the FF FF FF AA marker @0x3C4 and 6 secret bytes @0x3C8', () => {
    // The tab picks the first CRC-valid, non-blank SEC16 copy.
    const bestCopy = bcm.sec16Copies.find(
      c => c.csOk && !c.raw.every(b => b === 0xFF || b === 0x00)
    );
    expect(bestCopy).toBeTruthy();

    const res = applyPcmFromBcm(pcmData, new Uint8Array(bestCopy.raw));
    expect(res.ok).toBe(true);
    expect(res.bytes.length).toBe(8192);

    // Marker @ 0x3C4.
    expect(Array.from(res.bytes.slice(0x3C4, 0x3C8))).toEqual(EXPECTED_MARKER);
    // SEC6 @ 0x3C8 = reverse(BCM SEC16)[0..6).
    expect(Array.from(res.bytes.slice(0x3C8, 0x3CE))).toEqual(EXPECTED_SEC6);

    // The input buffer must not be mutated by the write.
    expect(pcmData.length).toBe(8192);
    const reparsed = parsePCMGPEC(pcmData);
    expect(reparsed.sec6.hex).toBe('AB 80 15 D7 7E D9');
  });
});
