/* ============================================================================
 * Task #517 — FcaModuleInspector: VIN Writer must route through the workspace-
 * shared `patchFile()` pipeline so its output is flashable and byte-identical
 * to what `VinProgrammerTab` produces for the same input/VIN.
 *
 * Pre-#517 the inspector's local `writeVIN()` only stamped VIN bytes at hard-
 * coded offsets and applied a naive sum-mod-256 byte for RFHUB. It did NOT
 *   - reverse VIN bytes for Gen2 RFHUB mirrored slots,
 *   - compute crc8rf for RFHUB Gen2,
 *   - compute crc16 for BCM full slots or 0x4098/0x40B0 partial tails,
 *   - sync the BCM IMMO backup block at 0x2000 from the primary at 0x40C0,
 *   - or compute crc8/42 for 95640 modules.
 * A `modified_*.bin` from the inspector therefore failed module-side
 * integrity checks at boot.
 *
 * This suite uses the three real-dump fixtures already in the repo to
 * exercise the new `inspectorWriteVin()` shim and asserts that:
 *   1. Its bytes match `patchFile(analyzeFile(...), vin).data` exactly
 *      (i.e. the same output VinProgrammerTab would produce).
 *   2. Re-analyzing the patched output via `analyzeFile()` shows every
 *      VIN slot reporting CS OK (sc === cc) — i.e. the file would pass
 *      the workspace's own checksum verifier.
 *   3. The new VIN actually appears at every detected slot (reversed for
 *      Gen2 RFHUB mirrored slots).
 *   4. For BCM, the IMMO backup block at 0x2000 mirrors the primary at
 *      0x40C0 byte-for-byte.
 *
 * Skip-don't-fail: if the realDumps manifest is missing the suite skips
 * cleanly so the build never breaks before fixtures are committed.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { inspectorWriteVin } from '../FcaModuleInspector.jsx';
import { analyzeFile, patchFile } from '../../lib/fileUtils.js';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const fixtures = loadRealDumpFixtures();

// A valid 17-char VIN with correct check digit so analyzeFile's BCM scan
// (which requires cv.ok) treats it as a programmable target.
const TEST_VIN = '2C3CDXCT1HH652640';

function bytesEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

(fixtures ? describe : describe.skip)(
  'Task #517 — inspectorWriteVin routes through the shared patchFile pipeline',
  () => {
    if (!fixtures) {
      it.skip('realDumps manifest not present', () => {});
      return;
    }

    const cases = [
      { key: 'pcm',   filename: 'pcm.after.bin',   label: 'GPEC2A PCM',  type: 'GPEC2A' },
      { key: 'rfhub', filename: 'rfhub.after.bin', label: 'RFHUB Gen2',  type: 'RFHUB'  },
      { key: 'bcm',   filename: 'bcm.after.bin',   label: 'BCM DFLASH',  type: 'BCM'    },
    ];

    for (const c of cases) {
      const fx = fixtures[c.key];
      const runner = fx ? describe : describe.skip;
      runner(`${c.label} (${c.filename})`, () => {
        it('inspector output matches VinProgrammerTab output byte-for-byte', () => {
          const vinprogInfo = analyzeFile(fx.after, c.filename);
          const vinprog = patchFile(vinprogInfo, TEST_VIN);
          const inspector = inspectorWriteVin(fx.after, c.filename, TEST_VIN);
          expect(inspector).not.toBeNull();
          expect(inspector.unsupported).toBe(false);
          expect(inspector.data).toBeTruthy();
          expect(inspector.data.length).toBe(vinprog.data.length);
          expect(bytesEqual(inspector.data, vinprog.data)).toBe(true);
        });

        it('analyzer detects expected module type', () => {
          const info = analyzeFile(fx.after, c.filename);
          expect(info.type).toBe(c.type);
        });

        it('round-trip analyzeFile on the patched output reports CS OK at every slot', () => {
          const inspector = inspectorWriteVin(fx.after, c.filename, TEST_VIN);
          const reanalyzed = analyzeFile(inspector.data, c.filename);
          expect(reanalyzed.type).toBe(c.type);
          expect(reanalyzed.vins.length).toBeGreaterThan(0);
          for (const slot of reanalyzed.vins) {
            if (slot.algo === 'none') continue; // GPEC2A slots have no checksum
            expect(slot.ok, `slot 0x${slot.off.toString(16)} CS mismatch (stored ${slot.sc} vs calc ${slot.cc})`).toBe(true);
          }
          for (const p of (reanalyzed.partials || [])) {
            const ok = p.sc === p.cc;
            expect(ok, `partial 0x${p.off.toString(16)} CS mismatch`).toBe(true);
          }
        });

        it('the new VIN appears at every detected full slot (reversed for Gen2 RFHUB mirrored)', () => {
          const inspector = inspectorWriteVin(fx.after, c.filename, TEST_VIN);
          const reanalyzed = analyzeFile(inspector.data, c.filename);
          const expectedReversed = TEST_VIN.split('').reverse().join('');
          for (const slot of reanalyzed.vins) {
            const expected = slot.mirrored ? expectedReversed : TEST_VIN;
            // analyzeFile returns the human-readable VIN — for mirrored slots
            // it reverses the stored bytes before stringifying, so the parsed
            // `slot.vin` is always TEST_VIN regardless of storage order.
            expect(slot.vin).toBe(TEST_VIN);
            // Sanity: confirm the raw stored bytes match expected orientation.
            const stored = inspector.data.slice(slot.off, slot.off + 17);
            const storedStr = String.fromCharCode.apply(null, Array.from(stored));
            expect(storedStr).toBe(expected);
          }
        });
      });
    }

    describe('BCM IMMO backup sync', () => {
      const fx = fixtures.bcm;
      (fx ? it : it.skip)('IMMO block at 0x2000 mirrors the primary at 0x40C0', () => {
        const inspector = inspectorWriteVin(fx.after, 'bcm.after.bin', TEST_VIN);
        const IMMO_BLOCK = 24 * 8;
        const a = inspector.data.slice(0x40C0, 0x40C0 + IMMO_BLOCK);
        const b = inspector.data.slice(0x2000, 0x2000 + IMMO_BLOCK);
        expect(bytesEqual(a, b)).toBe(true);
      });
    });

    describe('refusal: unsupported file types', () => {
      it('returns unsupported=true with a null data buffer when the file has no patchable VIN slots', () => {
        // 256 zero bytes — analyzeFile classifies this as UNKNOWN and finds
        // zero VIN slots, so the writer must refuse rather than emit a
        // bogus patched buffer.
        const empty = new Uint8Array(256);
        const r = inspectorWriteVin(empty, 'empty.bin', TEST_VIN);
        expect(r).not.toBeNull();
        expect(r.unsupported).toBe(true);
        expect(r.data).toBeNull();
      });

      it('returns null for invalid VIN length', () => {
        const fx = fixtures.pcm;
        if (!fx) return;
        expect(inspectorWriteVin(fx.after, 'pcm.after.bin', 'TOOSHORT')).toBeNull();
      });
    });
  }
);
