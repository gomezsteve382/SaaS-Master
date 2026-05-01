/* ============================================================================
 * Task #530 — pin the canonical `parseModule` against the three real-dump
 * fixtures (pcm.after.bin / rfhub.after.bin / bcm.after.bin).
 *
 * History: this file replaces the old
 * `tabs/__tests__/FcaModuleInspector.fixtures.test.js` suite, which pinned
 * the legacy inspector-private `parseInspectorModule` helper. Task #518
 * already wired the live Module Inspector UI to the workspace-wide
 * `parseModule`, and Task #530 retires the legacy helper outright so every
 * tab agrees on the same module shape. The realDumps × parser coverage
 * those fixtures provided is preserved here, asserted against `parseModule`
 * directly so a future regression in the canonical parser fails this suite.
 *
 * Verified concerns (one parser of record now):
 *   - GPEC2A 4 KB PCM dump: type=GPEC2A, VIN @ 0x0000, SKIM byte @ 0x0011.
 *   - RFHUB  4 KB EEPROM:   type=RFHUB, four reverse-VIN slots populated at
 *                           0x0EA5/0x0EB9/0x0ECD/0x0EE1 with the canonical
 *                           anonymized VIN once unreversed.
 *   - BCM    64 KB DFLASH:  type=BCM, FEE1000 header @ offset 4, full VIN
 *                           record @ slot base 0x5320 (vinOff=0x5328).
 *
 * Skip-don't-fail: if the realDumps manifest is missing the suite skips
 * cleanly so the build never breaks before fixtures are committed.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { parseModule } from '../parseModule.js';
import { SKIM_VALUES } from '../constants.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

const fixtures = loadRealDumpFixtures();

(fixtures ? describe : describe.skip)(
  'Task #530 — parseModule against real-dump fixtures',
  () => {
    if (!fixtures) {
      it.skip('realDumps manifest not present', () => {});
      return;
    }

    describe('GPEC2A 4 KB PCM dump (pcm.after.bin)', () => {
      const pcm = fixtures.pcm;
      (pcm ? it : it.skip)('parseModule classifies as GPEC2A and exposes the canonical VIN @ 0x0000', () => {
        expect(pcm.after.length).toBe(4096);
        const info = parseModule(pcm.after, 'pcm.after.bin');
        expect(info.type).toBe('GPEC2A');
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBeGreaterThan(0);
        expect(info.vins[0].offset).toBe(0x0000);
        expect(info.vins[0].vin).toBe('2C3CDXCT1HH600000');
      });
      (pcm ? it : it.skip)('parseModule reads the SKIM enable byte at 0x0011 (DISABLED on this capture)', () => {
        const info = parseModule(pcm.after, 'pcm.after.bin');
        // pcm.after has SKIM=0x00 (DISABLED) per the manifest's anonymized capture.
        expect(info.skimByte).toBe(0x00);
        expect(info.skimStatus).toBe(SKIM_VALUES[0x00]);
      });
    });

    describe('RFHUB 4 KB EEPROM dump (rfhub.after.bin)', () => {
      const rfhub = fixtures.rfhub;
      (rfhub ? it : it.skip)('parseModule classifies as RFHUB Gen2 and surfaces all four reverse-VIN slots', () => {
        expect(rfhub.after.length).toBe(4096);
        const info = parseModule(rfhub.after, 'rfhub.after.bin');
        expect(info.type).toBe('RFHUB');
        expect(info.rfhGen).toBe('Gen2 (24C32)');
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBe(4);
        const offsets = info.vins.map((v) => v.offset).sort((a, b) => a - b);
        expect(offsets).toEqual([0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1]);
        // Gen2 stores the VIN bytes reversed; parseModule unreverses them
        // so every slot surfaces the canonical anonymized VIN.
        for (const v of info.vins) {
          expect(v.vin).toBe('2C3CDXCT1HH600000');
          expect(v.mirrored).toBe(true);
        }
        // RFHUB has no SKIM byte/status — only GPEC2A populates that.
        expect(info.skimByte).toBeUndefined();
        expect(info.skimStatus).toBeUndefined();
      });
    });

    describe('BCM 64 KB DFLASH dump (bcm.after.bin)', () => {
      const bcm = fixtures.bcm;
      (bcm ? it : it.skip)('parseModule classifies as BCM and pulls the full VIN record at slot 0x5320 (vinOff=0x5328)', () => {
        expect(bcm.after.length).toBe(65536);
        // Confirm the FEE record header signature is actually present at the
        // documented offset (sanity check on the captured fixture itself).
        const hdr = String.fromCharCode.apply(null, bcm.after.slice(4, 11));
        expect(hdr).toBe('FEE1000');
        const info = parseModule(bcm.after, 'bcm.after.bin');
        expect(info.type).toBe('BCM');
        expect(info.vinZone).toBe('canonical');
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBeGreaterThan(0);
        expect(info.vins[0].offset).toBe(0x5328);
        expect(info.vins[0].slotBase).toBe(0x5320);
        expect(info.vins[0].headerBytes).toBe(8);
        expect(info.vins[0].crcOk).toBe(true);
        expect(info.vins[0].vin).toBe('2C3CDXL90MH582899');
      });
    });
  },
);
