import { describe, it, expect } from 'vitest';

import { writeRfhSec16FromBcm } from '../securityBytes.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #423 — closes follow-ups for #408 / #412 (Gen2 RFHUB SEC16/VIN-write
// path real-dump round-trip).
//
// Pin the production `writeRfhSec16FromBcm` writer against an anonymized
// real-bench Gen2 RFHUB (24C32, 4 KB) capture: feeding the captured BCM-form
// SEC16 into the "before" buffer must reproduce the captured "after" buffer
// byte-for-byte (including the two SEC16 slot mirrors @ 0x050E / 0x0522 with
// their crc8_65-poly checksum bytes).
//
// If the manifest's `rfhub` slot or the dumps are missing the suite is
// skipped so the build stays green — see __fixtures__/realDumps/README.md.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const rfhub = fixtures && fixtures.rfhub ? fixtures.rfhub : null;

(rfhub ? describe : describe.skip)(
  'rfhubGen2 — real-dump SEC16 write round-trip',
  () => {
    if (!rfhub) {
      it.skip('no RFHUB before/after pair in manifest', () => {});
      return;
    }

    it('writeRfhSec16FromBcm(before, reverse(rfhSec16)) === captured after', () => {
      // The writer expects the BCM-form SEC16 (it reverses internally to
      // recover the RFH form that lands on disk). The fixture exposes the
      // RFH-form SEC16, so reverse it here.
      const bcmSec16 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bcmSec16[i] = rfhub.rfhSec16[15 - i];

      const r = writeRfhSec16FromBcm(rfhub.before, bcmSec16);
      expect(r.bytes.length).toBe(rfhub.after.length);

      // Sanity: writer must have actually patched the two Gen2 slots — a
      // no-op pass would silently succeed if before === after, but then
      // the fixture is useless. Both slots @ 0x050E / 0x0522 should write.
      expect(r.patched, 'writer reported zero patches').toBe(2);

      // Byte-for-byte equality across the entire 4 KB image. On mismatch,
      // dump the first ~10 differing offsets so the failure points at the
      // exact slot/CS byte that drifted instead of dumping the whole file.
      let diffs = 0;
      const samples = [];
      for (let i = 0; i < rfhub.after.length; i++) {
        if (r.bytes[i] !== rfhub.after[i]) {
          diffs++;
          if (samples.length < 10) {
            samples.push(
              `0x${i.toString(16).padStart(4, '0')}: ` +
              `got 0x${r.bytes[i].toString(16).padStart(2, '0')}, ` +
              `expected 0x${rfhub.after[i].toString(16).padStart(2, '0')}`,
            );
          }
        }
      }
      if (diffs > 0) {
        throw new Error(
          `RFHUB Gen2 round-trip: ${diffs} byte(s) differ. First mismatches:\n  ` +
          samples.join('\n  '),
        );
      }
    });
  },
);
