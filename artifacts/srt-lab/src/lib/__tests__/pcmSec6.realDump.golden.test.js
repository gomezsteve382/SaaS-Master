import { describe, it, expect } from 'vitest';

import { writePcmSec6 } from '../securityBytes.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #423 — closes follow-up for #406 (PCM SEC6 round-trip on a real
// GPEC2A capture).
//
// Pin the production `writePcmSec6` writer against an anonymized real-bench
// PCM (Continental GPEC2A, 4 KB) capture: feeding the captured RFH SEC16
// into the "before" buffer must reproduce the captured "after" buffer
// byte-for-byte (canonical FF-FF-FF-AA marker @ 0x3C4 + 6-byte SEC6 @ 0x3C8).
//
// If the manifest's `pcm` slot or the dumps are missing the suite is
// skipped so the build stays green — see __fixtures__/realDumps/README.md.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const pcm = fixtures && fixtures.pcm ? fixtures.pcm : null;

(pcm ? describe : describe.skip)(
  'pcmSec6 — real-dump SEC6 write round-trip',
  () => {
    if (!pcm) {
      it.skip('no PCM before/after pair in manifest', () => {});
      return;
    }

    it('writePcmSec6(before, rfhSec16) === captured after (canonical GPEC2A)', () => {
      const r = writePcmSec6(pcm.before, pcm.rfhSec16);
      expect(r.ok, 'writer refused canonical PCM').toBe(true);
      expect(r.patched, 'writer should have stamped marker + SEC6').toBe(1);
      expect(r.markerStamped).toBe(true);
      expect(r.bytes.length).toBe(pcm.after.length);

      // Byte-for-byte equality of the full image. First ~10 mismatches are
      // surfaced for focused debugging if the writer drifts.
      let diffs = 0;
      const samples = [];
      for (let i = 0; i < pcm.after.length; i++) {
        if (r.bytes[i] !== pcm.after[i]) {
          diffs++;
          if (samples.length < 10) {
            samples.push(
              `0x${i.toString(16).padStart(4, '0')}: ` +
              `got 0x${r.bytes[i].toString(16).padStart(2, '0')}, ` +
              `expected 0x${pcm.after[i].toString(16).padStart(2, '0')}`,
            );
          }
        }
      }
      if (diffs > 0) {
        throw new Error(
          `PCM SEC6 round-trip: ${diffs} byte(s) differ. First mismatches:\n  ` +
          samples.join('\n  '),
        );
      }

      // Spot-check the canonical marker + SEC6 region landed exactly where
      // the writer documents (0x3C4 marker + 0x3C8 secret) — guards against
      // a future fixture rebuild that quietly relocates the slot.
      const marker = Array.from(r.bytes.slice(0x3C4, 0x3C8));
      expect(marker).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
      const sec6 = Array.from(r.bytes.slice(0x3C8, 0x3CE));
      expect(sec6).toEqual(Array.from(pcm.rfhSec16.slice(0, 6)));
    });
  },
);
