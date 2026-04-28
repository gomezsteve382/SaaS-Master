import { describe, it, expect } from 'vitest';

import { parseModule, buildBcmContentWarn } from '../parseModule.js';
import { writeBcmSec16Gen2 } from '../securityBytes.js';
import { scanBufferForDonorLeak } from '../donorLeakScan.js';
import { crc16 } from '../crc.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #463 — alternate BCM VIN base zone (FCA SINCRO Charger BCM variant).
//
// The canonical BCM VIN-record bases live at 0x5320..0x5380 (32 B stride,
// VIN payload at base+8). The SINCRO output for some Charger BCMs (likely
// a smaller-flash MPC5605B-class variant or an early-year LX firmware
// revision) keeps the same per-record layout but places the four
// populated VIN slots at 0x1328 / 0x1348 / 0x1368 / 0x1388 instead of
// 0x5328..0x5388 — the canonical zone is all 0xFF in that variant.
//
// Without alt-zone support the parser falls back to "no VINs found",
// `looksLikeRealBcm` rejects the file as not-a-BCM, the donor-leak
// scrubber masks only the (empty) canonical slots, and the BCM panel
// surfaces a misleading "maybe-not-bcm" warn for a perfectly valid BCM
// dump.
//
// This file pins the user-visible behaviour the task is fixing:
//
//   1. The parser recognises the file as a BCM and surfaces the four
//      alt-zone VINs (0x1328 / 0x1348 / 0x1368 / 0x1388) with
//      `info.vinZone === 'alt-0x1328'` — proving the canonical-zone-
//      first preference still flows the correct routing tag downstream.
//   2. `buildBcmContentWarn` returns null on this capture (alt-zone
//      VINs count as BCM-defining content).
//   3. The SEC16 split records @ 0x81A0/C0/E0 still parse correctly —
//      the alt VIN zone does NOT shift the SEC16 layout.
//   4. `writeBcmSec16Gen2(before, rfhSec16)` round-trips byte-for-byte
//      to the captured `after.bin` (covered by the existing
//      securityBytes.realDump.golden.test.js, but re-asserted here so
//      a regression in this fixture's round-trip points at the
//      alt-zone path specifically).
//   5. The committed `after.bin` passes the helper's whole-buffer
//      donor-leak scan with the documented slot windows now masking
//      both the canonical AND alternate base zones.
//
// Skip-don't-fail policy mirrors the other realDumps tests: if the
// manifest entry for this fixture is missing the suite skips cleanly.
// ─────────────────────────────────────────────────────────────────────────────

const ANON_VIN  = '2C3CDXHG5EH600000';
const DONOR_VIN = '2C3CDXHG5EH219538';

const fixtures = loadRealDumpFixtures();

// Locate the alt-zone fixture entry in extraBcms[] by its declared anonVin
// (don't pin to an array index — adding a new extraBcms[] entry shouldn't
// silently re-route this test to a different fixture).
const altEntry = fixtures && Array.isArray(fixtures.extraBcms)
  ? fixtures.extraBcms.find(e => e && e.anonVin === ANON_VIN)
  : null;

(altEntry ? describe : describe.skip)(
  'Task #463 — BCM alternate 0x1328 VIN base zone (Charger SINCRO variant)',
  () => {
    if (!altEntry) {
      it.skip('alt-zone fixture not present in manifest (extraBcms entry with anonVin ' + ANON_VIN + ')', () => {});
      return;
    }

    describe('after.bin (captured synced state)', () => {
      const buf = altEntry.after;
      const info = parseModule(buf, 'charger-bcm-0x1328/bcm.after.bin');

      it('parses as a BCM (size + alt-zone VIN tiebreaker)', () => {
        expect(info.type).toBe('BCM');
        expect(info.size).toBe(65536);
      });

      it('populates info.vins from the alternate 0x1328 zone (canonical zone is blank)', () => {
        expect(info.vinZone).toBe('alt-0x1328');
        expect(info.vins).toHaveLength(4);
        const offsets = info.vins.map(v => v.offset).sort((a, b) => a - b);
        expect(offsets).toEqual([0x1328, 0x1348, 0x1368, 0x1388]);
      });

      it('every alt-zone VIN equals the manifest anonVin and has a valid trailing CRC', () => {
        for (const v of info.vins) {
          expect(v.vin).toBe(ANON_VIN);
          expect(v.crcOk).toBe(true);
          expect(v.headerBytes).toBe(8);
          // slotBase = vinOff - 8 (record header is the 8 bytes before VIN).
          expect(v.slotBase).toBe(v.offset - 8);
        }
      });

      it('canonical 0x5320..0x5380 zone is intentionally empty in this variant', () => {
        // Sanity-check the precondition the alt-zone fallback exists for:
        // the canonical zone must actually be blank (all 0xFF) here, otherwise
        // the parser would have picked it instead of the alt zone.
        for (const base of [0x5320, 0x5340, 0x5360, 0x5380]) {
          for (const off of [base, base + 8]) {
            for (let i = 0; i < 17; i++) {
              expect(buf[off + i]).toBe(0xFF);
            }
          }
        }
      });

      it('does NOT surface the maybe-not-bcm content warn (alt-zone VINs count)', () => {
        expect(buildBcmContentWarn(buf)).toBeNull();
      });

      it('SEC16 resolves from the split records (alt VIN zone does not shift SEC16 layout)', () => {
        expect(info.bcmSec16).toBeTruthy();
        expect(info.bcmSec16.bytes).toBeInstanceOf(Uint8Array);
        expect(info.bcmSec16.bytes.length).toBe(16);
        expect(info.bcmSec16.blank).toBe(false);
        // SEC16 source must be a record-table source (split / mirror), not
        // the legacy flat slice — the alt-zone variant still uses Gen2's
        // canonical SEC16 storage.
        expect(['split', 'mirror']).toContain(info.bcmSec16.source);
      });

      it('helper donor-leak scanner reports no leaks on the after.bin', () => {
        const leak = scanBufferForDonorLeak({
          buffer: buf,
          donorVin: DONOR_VIN,
          moduleType: 'bcm',
        });
        expect(leak).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Synthetic precedence test: this is the regression that the architect's
    // post-build review flagged as an unlocked behaviour. The real dump above
    // proves the alt-zone fallback fires when canonical is empty, but it does
    // NOT prove canonical wins when both zones happen to be populated. A
    // future maintainer "extending" the alt scan path could trivially flip
    // the precedence without breaking the real-dump test (which has an
    // empty canonical zone). This test pins it.
    // ─────────────────────────────────────────────────────────────────────
    describe('canonical-zone precedence (synthetic — both zones populated)', () => {
      it('parser picks canonical zone and tags vinZone=canonical even when alt zone is also valid', () => {
        const buf = new Uint8Array(65536).fill(0xFF);
        // Plant headers + VINs at one canonical base (0x5328) and one alt
        // base (0x1328). Use distinct VIN suffixes so we can prove which one
        // the parser surfaced. Both records have valid CRC16 trailers so
        // the parser cannot prefer canonical "by accident" via crcOk.
        const VIN_CANON = '2C3CDXCT1HH600000';
        const VIN_ALT   = '2C3CDXCT1HH600001';
        const plantSlot = (slotBase, vin) => {
          const vinOff = slotBase + 8;
          // Trivial header bytes that satisfy looksLikeRealBcm's "non-blank
          // header" check (any non-FF, non-zero byte at slotBase works).
          buf[slotBase + 0] = 0x00;
          buf[slotBase + 1] = 0x00;
          buf[slotBase + 2] = 0x00;
          buf[slotBase + 3] = 0x18;
          buf[slotBase + 4] = 0x00;
          buf[slotBase + 5] = 0x46;
          buf[slotBase + 6] = 0xEB;
          buf[slotBase + 7] = 0x00;
          for (let i = 0; i < 17; i++) buf[vinOff + i] = vin.charCodeAt(i);
          // BE16 CRC16 over the 17 VIN bytes at vinOff+17/+18 (matches the
          // canonical/alt per-record layout — same routine).
          const c = crc16(buf.slice(vinOff, vinOff + 17));
          buf[vinOff + 17] = (c >> 8) & 0xFF;
          buf[vinOff + 18] = c & 0xFF;
        };
        plantSlot(0x5320, VIN_CANON);
        plantSlot(0x1320, VIN_ALT);

        const info = parseModule(buf, 'synthetic-bcm-both-zones.bin');
        expect(info.type).toBe('BCM');
        expect(info.vinZone).toBe('canonical');
        expect(info.vins).toHaveLength(1);
        expect(info.vins[0].offset).toBe(0x5328);
        expect(info.vins[0].vin).toBe(VIN_CANON);
        expect(info.vins[0].crcOk).toBe(true);
      });
    });

    describe('writeBcmSec16Gen2 round-trip (before → after, alt zone)', () => {
      it('produces the captured after.bin from the captured before.bin byte-for-byte', () => {
        const r = writeBcmSec16Gen2(altEntry.before, altEntry.rfhSec16);
        // Pin the writer's own counters first so a future regression that
        // skips the mirror patch (e.g. inactive-bank logic flips on this
        // dump's seq numbers 0x30CD vs 0x30CE) fails with a focused message
        // before we get to the byte-for-byte diff noise.
        expect(r.splitPatched, 'expected all 3 split records @ 0x81A0/C0/E0 to be patched').toBe(3);
        expect(r.mirrorPatched, 'expected both inactive-bank mirrors @ 0x00C0 / 0x00E8 to be patched').toBe(2);
        expect(r.inactiveBase, 'inactive bank should be 0x0000 (bank1Seq=0x30CE > bank0Seq=0x30CD)').toBe(0x0000);

        // Byte-for-byte equality check. Use a focused diff message instead
        // of toEqual on the whole buffer so a single-byte regression doesn't
        // dump 64 KiB of hex into the test report.
        expect(r.bytes.length).toBe(altEntry.after.length);
        const diffs = [];
        for (let i = 0; i < altEntry.after.length && diffs.length < 8; i++) {
          if (r.bytes[i] !== altEntry.after[i]) {
            diffs.push(
              `0x${i.toString(16).padStart(4, '0')}: got 0x${r.bytes[i].toString(16).padStart(2, '0')}, ` +
                `want 0x${altEntry.after[i].toString(16).padStart(2, '0')}`,
            );
          }
        }
        if (diffs.length > 0) {
          let total = 0;
          for (let i = 0; i < altEntry.after.length; i++) {
            if (r.bytes[i] !== altEntry.after[i]) total++;
          }
          throw new Error(
            `alt-zone BCM round-trip: ${total} byte(s) differ. First mismatches:\n  ` +
              diffs.join('\n  '),
          );
        }
      });
    });
  },
);
