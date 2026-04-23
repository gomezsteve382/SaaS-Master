/* Task #416 — golden test driver for Gen1 (24C16, 2 KB) RFHUB key-hub edits.
 *
 * Task #409 unlocked Gen1 slot editing using AA-50 base 0x00D2 and the same
 * SEC16 CS formula (rfhSec16Cs / crc8_65) as Gen2. Those changes were
 * validated against the synthetic `makeRfhubGen1` builder, which fills the
 * scratch regions with 0xFF — a real EEPROM never looks that clean.
 *
 * This file is the harness that runs the full assertion battery against
 * every binary in `__golden__/*.bin`. New dumps slot in by appending an
 * entry to FIXTURES — no test code changes required.
 *
 * Provenance of the binaries currently in `__golden__/` is documented in
 * `__golden__/README.md`. The seed fixtures shipped today are STRUCTURAL
 * CONFORMANCE FIXTURES (hand-built to the published 24C16 layout, not
 * captures from a physical EEPROM): they verify parser↔writer agreement
 * and catch stray-byte writes via the round-trip check, but they cannot
 * by themselves catch per-vehicle layout drift. Real sanitized donor
 * dumps (Cherokee XK / WK Grand / LX Charger) drop in via the same
 * FIXTURES array — see follow-up #420 and the README sanitization
 * procedure.
 *
 * If any dump disagrees with 0x00D2 or rfhSec16Cs, widen the per-gen
 * constants in `rfhubKeySlots.js` instead of editing the dump.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseKeySlots, addSlot, deleteSlot, transferSlot,
  AA50_BASE_GEN1, AA50_STRIDE, KEY_SLOT_COUNT,
} from '../rfhubKeySlots.js';
import { parseModule } from '../parseModule.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, '__golden__');

function loadDump(name) {
  return new Uint8Array(readFileSync(join(GOLDEN_DIR, name)));
}

// FIXTURES drives the per-dump test battery. `source` is metadata only:
//   'synthetic-conformance' = built from the published layout (the seed set);
//   'donor-style-synthetic' = hand-built donor variant exercising sparse
//                             occupancy / per-VIN SEC16 secrets / unique
//                             per-fob Autel IDs (Task #420 expansion;
//                             generator: scripts/generate-rfhub-gen1-donor-fixtures.mjs);
//   'real-sanitized'        = sanitized capture from a physical EEPROM
//                             (drop in via the procedure in __golden__/README.md
//                             — none yet, pending physical donor access).
const FIXTURES = [
  {
    file: 'cherokee_xk_2010_2fobs.bin',
    label: 'Cherokee XK 2010 (conformance)',
    source: 'synthetic-conformance',
    expectedFobikSlots: 2,
    expectedOccupied: [true, true, false, false],
  },
  {
    file: 'wk_grand_2008_4fobs.bin',
    label: 'WK Grand 2008 (conformance)',
    source: 'synthetic-conformance',
    expectedFobikSlots: 4,
    expectedOccupied: [true, true, true, true],
  },
  {
    file: 'lx_charger_2016_1fob.bin',
    label: 'LX Charger 2016 (conformance)',
    source: 'synthetic-conformance',
    expectedFobikSlots: 1,
    expectedOccupied: [true, false, false, false],
  },
  // Task #420 expansion — donor-style variants exercising patterns the
  // seed conformance set doesn't cover (sparse non-contiguous occupancy,
  // distinct SEC16 secrets per VIN, distinct per-fob Autel IDs).
  {
    file: 'cherokee_xk_2009_partial.bin',
    label: 'Cherokee XK 2009 (donor — slot 2 deprogrammed)',
    source: 'donor-style-synthetic',
    expectedFobikSlots: 3,
    expectedOccupied: [true, true, false, true],
  },
  {
    file: 'wk_grand_2011_3fobs.bin',
    label: 'WK Grand 2011 (donor — 3 fobs paired, slot 3 factory empty)',
    source: 'donor-style-synthetic',
    expectedFobikSlots: 3,
    expectedOccupied: [true, true, true, false],
  },
  {
    file: 'lx_charger_2014_fullhouse.bin',
    label: 'LX Charger 2014 (donor — all 4 slots populated)',
    source: 'donor-style-synthetic',
    expectedFobikSlots: 4,
    expectedOccupied: [true, true, true, true],
  },
];

describe('Task #416 — Gen1 RFHUB golden test driver (conformance + real sanitized dumps)', () => {
  for (const fx of FIXTURES) {
    describe(`${fx.label} (${fx.file})`, () => {
      const buf = loadDump(fx.file);

      it('is a 2048 B Gen1 RFHUB image', () => {
        expect(buf.length).toBe(2048);
      });

      it('parseKeySlots reports gen=gen1 and the expected AA-50 occupancy at 0x00D2', () => {
        const r = parseKeySlots(buf);
        expect(r.ok).toBe(true);
        expect(r.gen).toBe('gen1');
        expect(r.slots).toHaveLength(KEY_SLOT_COUNT);
        for (let i = 0; i < KEY_SLOT_COUNT; i++) {
          expect(r.slots[i].markerOffset).toBe(AA50_BASE_GEN1 + i * AA50_STRIDE);
          expect(r.slots[i].occupied).toBe(fx.expectedOccupied[i]);
        }
      });

      it('parseModule.fobikSlots matches the dump\'s populated AA-50 count', () => {
        const info = parseModule(buf, fx.file);
        expect(info.type).toBe('RFHUB');
        expect(info.fobikSlots).toBe(fx.expectedFobikSlots);
      });

      it('SEC16 mirror pair csOk on both slots and the raw 16 B match', () => {
        const r = parseKeySlots(buf);
        expect(r.sec16.offsets).toEqual([0x00AE, 0x00C0]);
        expect(r.sec16.slots).toHaveLength(2);
        expect(r.sec16.slots[0].csOk).toBe(true);
        expect(r.sec16.slots[1].csOk).toBe(true);
        expect(r.sec16.match).toBe(true);
      });

      it('add → delete on every slot returns a byte-identical buffer', () => {
        for (let i = 0; i < KEY_SLOT_COUNT; i++) {
          // If the slot is already occupied, exercise delete → add instead so
          // both code paths get covered against the real-style buffer.
          const occupied = fx.expectedOccupied[i];
          const first = occupied ? deleteSlot(buf, i) : addSlot(buf, i);
          expect(first.ok, `${occupied ? 'delete' : 'add'} slot ${i}`).toBe(true);
          const second = occupied ? addSlot(first.bytes, i) : deleteSlot(first.bytes, i);
          expect(second.ok, `inverse on slot ${i}`).toBe(true);
          expect(second.bytes.length).toBe(buf.length);
          for (let off = 0; off < buf.length; off++) {
            if (second.bytes[off] !== buf[off]) {
              throw new Error(
                `${fx.label}: round-trip mismatch at slot=${i} off=0x${off.toString(16)}: ` +
                `got ${second.bytes[off]}, want ${buf[off]}`,
              );
            }
          }
        }
      });

      it('parse → noop is byte-identical (read path does not mutate the dump)', () => {
        const original = new Uint8Array(buf);
        const r = parseKeySlots(buf);
        expect(r.ok).toBe(true);
        for (let off = 0; off < original.length; off++) {
          expect(buf[off]).toBe(original[off]);
        }
      });
    });
  }

  it('cross-dump transferSlot copies a populated Gen1 slot byte-identically', () => {
    // Take WK slot 2 (populated) into Cherokee slot 2 (empty) — both Gen1,
    // so transferSlot must accept and copy both the AA-50 marker AND the
    // 8-byte Autel ID block at 0x00DA + 2*8 = 0x00EA.
    const wk = loadDump('wk_grand_2008_4fobs.bin');
    const xk = loadDump('cherokee_xk_2010_2fobs.bin');
    const r = transferSlot(wk, xk, 2, 2);
    expect(r.ok).toBe(true);
    expect(r.idTransferred).toBe(true);
    expect(r.occupiedAfter).toBe(true);
    // AA-50 marker at the destination slot now matches the source.
    expect(r.bytes[0x00D2 + 2 * 2]).toBe(0xAA);
    expect(r.bytes[0x00D2 + 2 * 2 + 1]).toBe(0x50);
    // Per-fob ID block at slot 2 now matches the WK donor byte-for-byte.
    for (let k = 0; k < 8; k++) {
      expect(r.bytes[0x00DA + 2 * 8 + k]).toBe(wk[0x00DA + 2 * 8 + k]);
    }
    // Donor file untouched.
    const wkReplay = loadDump('wk_grand_2008_4fobs.bin');
    for (let off = 0; off < wk.length; off++) {
      expect(wk[off]).toBe(wkReplay[off]);
    }
  });
});
