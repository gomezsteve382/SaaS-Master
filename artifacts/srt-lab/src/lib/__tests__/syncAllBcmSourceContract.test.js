import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writePcmSec6, writeRfhSec16FromBcm } from '../securityBytes.js';

/* ============================================================================
 * syncAllBcmSourceContract.test.js — SYNC ALL MODULES pairing contract.
 *
 * Regression guard for the Module Sync pairing-chain bug: runFullSync used to
 * treat the RFHUB as the source of truth — it derived the BCM SEC16 and the
 * PCM SEC6 FROM the RFH slot. When the RFH is a foreign / unpaired donor (as
 * in this OG bench triple) that overwrites the BCM's correct vehicle secret
 * with the donor's and ships a mismatched PCM.
 *
 * The fix makes the BCM canonical:
 *   RFH SEC16 = reverse(BCM SEC16)
 *   PCM SEC6  = reverse(BCM SEC16)[0:6]
 * and the BCM secret is never written. This test pins that contract against
 * the real OG Charger triple and proves the foreign RFH would have produced
 * different (wrong) bytes.
 * ========================================================================== */

const ASSETS = resolve(__dirname, '../../../../..', 'attached_assets');
const BCM_FILE = '19charger_BCMDFLASH_OG_1780353759853.bin';
const RFH_FILE = '19CHARGER_RFHUB_EEE+_OG_1780353759854.bin';
const PCM_FILE = '19gpec2a_eeprom_1780353765789.bin';

const hx = (a) => [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
const load = (f) => new Uint8Array(readFileSync(join(ASSETS, f)));
const have = [BCM_FILE, RFH_FILE, PCM_FILE].every((f) => existsSync(join(ASSETS, f)));

/* Canonical BCM SEC16 lives in the persistent split records at
 * 0x81A0 / 0x81C0 / 0x81E0 (7-byte prefix + "04 04 00 14" tag + 9-byte
 * suffix), the same extraction the app's BCM parser uses. */
function extractBcmSec16(out) {
  for (const recOff of [0x81a0, 0x81c0, 0x81e0]) {
    if (recOff + 30 > out.length) continue;
    const idx = out[recOff + 8];
    if (idx !== 0x01 && idx !== 0x02) continue;
    if (
      out[recOff + 16] !== 0x04 ||
      out[recOff + 17] !== 0x04 ||
      out[recOff + 18] !== 0x00 ||
      out[recOff + 19] !== 0x14
    )
      continue;
    const s = new Uint8Array(16);
    for (let k = 0; k < 7; k++) s[k] = out[recOff + 9 + k];
    for (let k = 0; k < 9; k++) s[7 + k] = out[recOff + 20 + k];
    return s;
  }
  return null;
}

(have ? describe : describe.skip)(
  'SYNC ALL MODULES — BCM-as-source pairing contract (OG Charger triple)',
  () => {
    const bcm = load(BCM_FILE);
    const rfh = load(RFH_FILE);
    const pcm = load(PCM_FILE);

    const bcmSec16 = extractBcmSec16(bcm);
    const rfhFormSecret = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rfhFormSecret[i] = bcmSec16[15 - i];

    it('BCM holds the canonical vehicle secret (ground truth)', () => {
      expect(bcmSec16).not.toBeNull();
      expect(hx(bcmSec16)).toBe('555aaaf03a7824b694c25bc7e31bb6f0');
    });

    it('RFH-form shared secret = reverse(BCM SEC16)', () => {
      expect(hx(rfhFormSecret)).toBe('f0b61be3c75bc294b624783af0aa5a55');
    });

    it('PCM SEC6 is written from reverse(BCM)[0:6] with the Continental marker', () => {
      const r = writePcmSec6(pcm, rfhFormSecret);
      expect(r.ok).toBe(true);
      expect(r.sec6Hex).toBe('f0b61be3c75b');
      expect(hx(r.bytes.slice(0x3c4, 0x3c8))).toBe('ffffffaa');
      expect(hx(r.bytes.slice(0x3c8, 0x3ce))).toBe('f0b61be3c75b');
    });

    it('the foreign OG RFH would have produced a DIFFERENT (wrong) PCM SEC6 — why BCM must be the source', () => {
      // Gen1 RFH SEC16 slot1 lives at 0x0226; first 16 bytes are the secret core.
      const rfhCore = rfh.slice(0x0226, 0x0236);
      expect(hx(rfhCore)).not.toBe(hx(rfhFormSecret));
      const wrong = writePcmSec6(pcm, rfhCore);
      expect(wrong.sec6Hex).not.toBe('f0b61be3c75b');
    });

    it('the OG RFH is Gen1 (no AA 55 31 01 header) so the Gen2 SEC16 writer is correctly skipped', () => {
      const isGen2 =
        rfh[0x0500] === 0xaa &&
        rfh[0x0501] === 0x55 &&
        rfh[0x0502] === 0x31 &&
        rfh[0x0503] === 0x01;
      expect(isGen2).toBe(false);
      expect(() => writeRfhSec16FromBcm(rfh, bcmSec16)).toThrow(/Gen2/);
    });
  },
);
