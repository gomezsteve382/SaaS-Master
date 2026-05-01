/* ============================================================================
 * Task #496 — FcaModuleInspector: pin the rescued auto-detection / VIN scan /
 * SKIM-byte read against the three real-dump fixtures already in the repo.
 *
 * Verifies the rehomed inspector matches the original misnamed `.exe`
 * (UTF-8 React JSX) drop byte-for-byte against:
 *   - GPEC2A 4 KB PCM dump (VIN at byte 0, SKIM at 0x0011)
 *   - RFHUB  4 KB EEPROM dump (VIN at known RFHUB offsets, no SKIM)
 *   - BCM    64 KB DFLASH dump (FEE1000 header @ offset 4, VIN at 0x5328)
 *
 * Skip-don't-fail: if the realDumps manifest is missing the suite skips
 * cleanly so the build never breaks before fixtures are committed.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import {
  MODULE_TYPES,
  SKIM_VALUES,
  detectModuleType,
  scanForVINs,
  parseInspectorModule,
} from '../FcaModuleInspector.jsx';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const fixtures = loadRealDumpFixtures();

(fixtures ? describe : describe.skip)(
  'Task #496 — FcaModuleInspector against real-dump fixtures',
  () => {
    if (!fixtures) {
      it.skip('realDumps manifest not present', () => {});
      return;
    }

    describe('GPEC2A 4 KB PCM dump (pcm.after.bin)', () => {
      const pcm = fixtures.pcm;
      (pcm ? it : it.skip)('detects module type as GPEC2A', () => {
        expect(pcm.after.length).toBe(4096);
        expect(detectModuleType(pcm.after)).toBe('GPEC2A');
      });
      (pcm ? it : it.skip)('parseInspectorModule extracts VIN at byte 0', () => {
        const info = parseInspectorModule(pcm.after, 'pcm.after.bin');
        expect(info.type).toBe('GPEC2A');
        expect(info.name).toBe(MODULE_TYPES.GPEC2A.name);
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBeGreaterThan(0);
        expect(info.vins[0].offset).toBe(0x0000);
        expect(info.vins[0].vin).toBe('2C3CDXCT1HH600000');
      });
      (pcm ? it : it.skip)('reads the SKIM enable byte at 0x0011', () => {
        const info = parseInspectorModule(pcm.after, 'pcm.after.bin');
        // pcm.after has SKIM=0x00 (DISABLED) per the manifest's anonymized capture
        expect(info.skimByte).toBe(0x00);
        expect(info.skimStatus).toBe(SKIM_VALUES[0x00]);
      });
    });

    describe('RFHUB 4 KB EEPROM dump (rfhub.after.bin)', () => {
      const rfhub = fixtures.rfhub;
      (rfhub ? it : it.skip)('detects module type as RFHUB', () => {
        expect(rfhub.after.length).toBe(4096);
        expect(detectModuleType(rfhub.after)).toBe('RFHUB');
      });
      (rfhub ? it : it.skip)('parseInspectorModule extracts VINs at known RFHUB offsets', () => {
        const info = parseInspectorModule(rfhub.after, 'rfhub.after.bin');
        expect(info.type).toBe('RFHUB');
        expect(info.name).toBe(MODULE_TYPES.RFHUB.name);
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBe(4);
        // RFHUB stores the VIN bytes in reversed order at the known offsets
        // [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1]; the inspector reads them
        // verbatim (no reversal), matching the original drop's behavior.
        expect(info.vins[0].offset).toBe(0x0ea5);
        expect(info.vins[0].vin).toBe('000006HH1TCXDC3C2');
        // RFHUB has no SKIM byte/status — only GPEC2A populates that.
        expect(info.skimByte).toBeUndefined();
        expect(info.skimStatus).toBeUndefined();
      });
    });

    describe('BCM 64 KB DFLASH dump (bcm.after.bin)', () => {
      const bcm = fixtures.bcm;
      (bcm ? it : it.skip)('detects module type as BCM via FEE1000 header @ offset 4', () => {
        expect(bcm.after.length).toBe(65536);
        expect(detectModuleType(bcm.after)).toBe('BCM');
        // Confirm the header signature the detector keys on is actually present.
        const hdr = String.fromCharCode.apply(null, bcm.after.slice(4, 11));
        expect(hdr).toBe('FEE1000');
      });
      (bcm ? it : it.skip)('parseInspectorModule extracts the BCM VIN at 0x5328', () => {
        const info = parseInspectorModule(bcm.after, 'bcm.after.bin');
        expect(info.type).toBe('BCM');
        expect(info.name).toBe(MODULE_TYPES.BCM.name);
        expect(Array.isArray(info.vins)).toBe(true);
        expect(info.vins.length).toBeGreaterThan(0);
        expect(info.vins[0].offset).toBe(0x5328);
        expect(info.vins[0].vin).toBe('2C3CDXL90MH582899');
      });
    });

    describe('scanForVINs honors I/O/Q exclusion + boundary checks', () => {
      it('finds the GPEC2A primary VIN among scan results', () => {
        const pcm = fixtures.pcm;
        if (!pcm) return;
        const found = scanForVINs(pcm.after);
        expect(found.some(v => v.offset === 0x0000 && v.vin === '2C3CDXCT1HH600000')).toBe(true);
      });
      it('rejects a synthesized 17-char run that contains a forbidden I/O/Q char', () => {
        // Build a buffer with a single 17-byte alphanumeric run that includes
        // an `I`. The original boundary-aware scanner must reject it.
        const buf = new Uint8Array(64);
        buf.fill(0x00);
        const bad = '1234567890ABCIDEF'.split('');
        for (let i = 0; i < 17; i++) buf[10 + i] = bad[i].charCodeAt(0);
        const found = scanForVINs(buf);
        expect(found.find(v => v.offset === 10)).toBeUndefined();
      });
    });
  }
);
