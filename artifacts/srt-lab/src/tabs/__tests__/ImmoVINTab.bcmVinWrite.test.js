/* ============================================================================
 * Task #491 — ImmoVINTab BCMSection: applyBcmVin must rewrite all 4 full-VIN
 * + CRC slots AND every detected partial-VIN + CRC slot, byte-equal to the
 * captured `after.bin` half of the charger-bcm-vin-write fixture pair.
 *
 * Pre-#491 the standalone Immo/VIN tab covered only RFHUB and GPEC2A; a
 * user with a 64KB BCM dump had to drop into the synced-pair tooling
 * (RFH→PCM / Sync All Modules) to rewrite the VIN. This file pins the
 * new BCMSection's exported helpers (parseBcmDflash, applyBcmVin,
 * detectBcmVinZone) against an anonymized real-bench OG → EDIT capture
 * — the donor pair anonymized to:
 *     before: 2C3CDXL90MH600142  (anon of donor 615142)
 *     after:  2C3CDXHG5EH600538  (anon of donor 219538)
 *
 * The fixture diffs ONLY at the 4 full-VIN+CRC slots (0x1328/0x1348/
 * 0x1368/0x1388 alt zone, VIN at base+8, BE16 CRC at vinOff+17/+18) AND
 * the 4 partial-VIN+CRC slots (0x0098/0x00B0/0x4098/0x40B0, last-8 of
 * VIN + BE16 CRC at +8/+9). Total diff = 60 bytes. Re-stamping the VIN
 * via applyBcmVin must reproduce the fixture exactly — any drift means
 * the writer missed a slot, missed a CRC, or wrote the wrong zone.
 *
 * Skip-don't-fail policy mirrors the other realDumps tests: if the
 * manifest entry for this fixture is missing the suite skips cleanly.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import {
  applyBcmVin,
  parseBcmDflash,
  detectBcmVinZone,
} from '../ImmoVINTab.jsx';
import { crc16 } from '../../lib/crc.js';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const VIN_BEFORE = '2C3CDXL90MH600142';
const VIN_AFTER  = '2C3CDXHG5EH600538';

const fixtures = loadRealDumpFixtures();

const fxEntry = fixtures && Array.isArray(fixtures.extraBcms)
  ? fixtures.extraBcms.find(e => e && e.anonVin === VIN_BEFORE && e.anonVinAfter === VIN_AFTER)
  : null;

(fxEntry ? describe : describe.skip)(
  'Task #491 — ImmoVINTab BCMSection (applyBcmVin against real-bench OG → EDIT VIN-write capture)',
  () => {
    if (!fxEntry) {
      it.skip('charger-bcm-vin-write fixture not present in manifest', () => {});
      return;
    }

    const before = fxEntry.before;
    const after  = fxEntry.after;

    it('both fixture halves are 64KB BCM DFLASH images', () => {
      expect(before.length).toBe(65536);
      expect(after.length).toBe(65536);
    });

    describe('detectBcmVinZone (auto-detects canonical-vs-alt zone)', () => {
      it('routes the OG capture to the alt-0x1328 zone', () => {
        const z = detectBcmVinZone(before);
        expect(z.label).toBe('alt-0x1328');
        expect(z.vinOffsets).toEqual([0x1328, 0x1348, 0x1368, 0x1388]);
      });
    });

    describe('parseBcmDflash on the OG (before) capture', () => {
      const res = parseBcmDflash(before);
      it('flags 64KB validity and the alt-zone label', () => {
        expect(res.validSz).toBe(true);
        expect(res.zone.label).toBe('alt-0x1328');
      });
      it('surfaces 4 full-VIN slots all carrying VIN_BEFORE with passing CRCs', () => {
        expect(res.slots).toHaveLength(4);
        for (const s of res.slots) {
          expect(s.vin).toBe(VIN_BEFORE);
          expect(s.crcOk).toBe(true);
          expect(s.csCalc).toBe(crc16(new TextEncoder().encode(VIN_BEFORE)));
        }
        expect(res.consistent).toBe(true);
        expect(res.mainVin).toBe(VIN_BEFORE);
      });
      it('discovers >= 4 partial-VIN slots (canonical 0x4098/0x40B0 + extra 0x0098/0x00B0 mirror)', () => {
        expect(res.partials.length).toBeGreaterThanOrEqual(4);
        const offs = res.partials.map(p => p.offset).sort((a,b)=>a-b);
        expect(offs).toEqual(expect.arrayContaining([0x0098, 0x00B0, 0x4098, 0x40B0]));
        const tail = VIN_BEFORE.slice(9);
        const calcTail = crc16(new TextEncoder().encode(tail));
        for (const p of res.partials) {
          expect(p.tail).toBe(tail);
          expect(p.crcOk).toBe(true);
          expect(p.csCalc).toBe(calcTail);
        }
      });
      it('SEC16 split records resolve and are non-blank (capture is paired)', () => {
        expect(res.sec16).not.toBeNull();
        expect(res.sec16.bytes).toBeTruthy();
        expect(res.sec16.blank).toBe(false);
      });
    });

    describe('applyBcmVin (before, VIN_AFTER) — golden round-trip', () => {
      const patched = applyBcmVin(before, VIN_AFTER);

      it('does NOT mutate the input buffer', () => {
        const reread = parseBcmDflash(before);
        expect(reread.mainVin).toBe(VIN_BEFORE);
      });

      it('produces a buffer byte-equal to the captured after.bin', () => {
        expect(patched.length).toBe(after.length);
        let firstDiff = -1;
        for (let i = 0; i < patched.length; i++) {
          if (patched[i] !== after[i]) { firstDiff = i; break; }
        }
        if (firstDiff !== -1) {
          throw new Error(
            'applyBcmVin output diverged from captured after.bin at offset 0x' +
            firstDiff.toString(16).toUpperCase().padStart(4, '0') +
            ' (got 0x' + patched[firstDiff].toString(16).padStart(2,'0').toUpperCase() +
            ', expected 0x' + after[firstDiff].toString(16).padStart(2,'0').toUpperCase() + ')'
          );
        }
        expect(firstDiff).toBe(-1);
      });

      it('parses cleanly with VIN_AFTER at every full-VIN slot and updated CRCs', () => {
        const r = parseBcmDflash(patched);
        expect(r.consistent).toBe(true);
        expect(r.mainVin).toBe(VIN_AFTER);
        for (const s of r.slots) {
          expect(s.vin).toBe(VIN_AFTER);
          expect(s.crcOk).toBe(true);
        }
      });

      it('every detected partial-VIN slot now carries the new tail (no donor-VIN tail leak)', () => {
        const r = parseBcmDflash(patched);
        const newTail = VIN_AFTER.slice(9); // 'EH600538'
        const oldTail = VIN_BEFORE.slice(9); // 'MH600142'
        for (const p of r.partials) {
          expect(p.tail).toBe(newTail);
          expect(p.crcOk).toBe(true);
          expect(p.tail).not.toBe(oldTail);
        }
      });
    });

    describe('applyBcmVin input validation', () => {
      it('throws on a malformed VIN (length mismatch)', () => {
        expect(() => applyBcmVin(before, 'TOO_SHORT')).toThrow(/valid 17-character VIN/);
      });
      it('throws on a malformed VIN (illegal character)', () => {
        // 'I' is forbidden in VINs (visual ambiguity with '1').
        expect(() => applyBcmVin(before, '2C3CDXHG5EI600538')).toThrow(/valid 17-character VIN/);
      });
    });
  }
);
