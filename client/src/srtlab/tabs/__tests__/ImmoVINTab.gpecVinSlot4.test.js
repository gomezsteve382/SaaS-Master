/* ============================================================================
 * Task #442 — applyGpec2a (standalone Immo/VIN tab) must rewrite the 4th
 * canonical PCM VIN slot at 0x0CE0 too.
 *
 * Pre-#442 the tab's GPEC_VIN_OFFSETS constant was [0x0000, 0x01F0, 0x0224]
 * — a user who patched a donor PCM via the Immo/VIN tab left the donor's
 * VIN at 0x0CE0 (donor-VIN privacy leak; cross-validator never warns).
 * Task #439 already closed the same gap in the dedicated RFH→PCM tab,
 * the GPEC2A reader/writer in fileUtils.js, and the GPEC2A parser in
 * parseModule.js. This test pins the standalone-tab fix.
 * ============================================================================ */
import { describe, it, expect } from 'vitest';
import { applyGpec2a, parseGpec2a } from '../ImmoVINTab.jsx';
// Task #443 centralized the GPEC2A VIN slot list into parseModule.js — the
// tab now consumes it via PCM_VIN_OFFSETS_GPEC2A. Importing from the
// canonical source here means this test pins the centralized constant
// instead of a tab-local re-export, which is the post-#443 source of truth.
import { PCM_VIN_OFFSETS_GPEC2A as GPEC_VIN_OFFSETS } from '../../lib/parseModule.js';

const TARGET_VIN = '2C3CDXKT3FH796320'; // VIN A — the value we want everywhere.
const DONOR_VIN  = '2C3CDXKT3FH123456'; // VIN B — donor PCM still carries
                                        // this at 0x0CE0 in the input file.

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

// Synthetic 4 KB GPEC2A: VIN A at slots 1..3, donor VIN B at slot 4 (0x0CE0).
function buildDonorGpec2a() {
  const buf = new Uint8Array(4096).fill(0xFF);
  const a = asciiBytes(TARGET_VIN);
  const b = asciiBytes(DONOR_VIN);
  for (let i = 0; i < 17; i++) buf[0x0000 + i] = a[i];
  for (let i = 0; i < 17; i++) buf[0x01F0 + i] = a[i];
  for (let i = 0; i < 17; i++) buf[0x0224 + i] = a[i];
  for (let i = 0; i < 17; i++) buf[0x0CE0 + i] = b[i];
  return buf;
}

describe('Task #442 — Immo/VIN tab applyGpec2a covers slot 4 (0x0CE0)', () => {
  it('exposes all four canonical slots in GPEC_VIN_OFFSETS', () => {
    expect(GPEC_VIN_OFFSETS).toEqual([0x0000, 0x01F0, 0x0224, 0x0CE0]);
  });

  it('overwrites a donor VIN at 0x0CE0 with the new VIN', () => {
    const before = buildDonorGpec2a();

    // Sanity: the donor really did sit at 0x0CE0 before the patch.
    expect(readVinAt(before, 0x0CE0)).toBe(DONOR_VIN);
    for (const off of [0x0000, 0x01F0, 0x0224]) {
      expect(readVinAt(before, off)).toBe(TARGET_VIN);
    }

    const after = applyGpec2a(before, TARGET_VIN, '');

    // All four canonical slots equal VIN A.
    for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
      expect(readVinAt(after, off), `VIN slot @ 0x${off.toString(16).toUpperCase()}`).toBe(TARGET_VIN);
    }
  });

  it('parseGpec2a flags the pre-patch donor file as inconsistent and the post-patch file as consistent', () => {
    const before = buildDonorGpec2a();
    const beforeParsed = parseGpec2a(before);
    expect(beforeParsed.slots).toHaveLength(4);
    expect(beforeParsed.consistent).toBe(false);

    const after = applyGpec2a(before, TARGET_VIN, '');
    const afterParsed = parseGpec2a(after);
    expect(afterParsed.slots).toHaveLength(4);
    expect(afterParsed.consistent).toBe(true);
    expect(afterParsed.mainVin).toBe(TARGET_VIN);
  });

  it('writes are targeted — bytes outside the 4 VIN slots are untouched', () => {
    const before = buildDonorGpec2a();
    const after = applyGpec2a(before, TARGET_VIN, '');

    const allowed = new Uint8Array(after.length);
    for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
      for (let i = 0; i < 17; i++) allowed[off + i] = 1;
    }
    let drift = 0;
    for (let i = 0; i < after.length; i++) {
      if (!allowed[i] && after[i] !== before[i]) drift++;
    }
    expect(drift, 'bytes outside the 4 VIN slots changed').toBe(0);
  });
});
