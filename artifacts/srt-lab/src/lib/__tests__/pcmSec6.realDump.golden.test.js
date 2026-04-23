import { describe, it, expect } from 'vitest';

import { writePcmSec6 } from '../securityBytes.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #423 — closes follow-up for #406 (PCM SEC6 round-trip on a real
// GPEC2A capture).
//
// Pin the production `writePcmSec6` writer against anonymized real-bench
// PCM (Continental GPEC2A) captures: feeding the captured RFH SEC16 into
// the "before" buffer must reproduce the captured "after" buffer byte-for-
// byte (canonical FF-FF-FF-AA marker @ 0x3C4 + 6-byte SEC6 @ 0x3C8).
//
// Task #433 — extends the original 4 KB-only coverage by iterating over
// every PCM pair the manifest carries (primary `pcm` slot + every entry
// in `extraPcms`). The 8 KB capture wired through extraPcms[0] confirms
// the writer's doc-comment assertion that "the 8 KB image is just a
// larger GPEC2A" — same marker offset, same SEC6 offset, no GPEC5
// variant. If a future capture disagrees, the suite surfaces the
// divergence with a focused first-mismatch diff.
//
// If the manifest's `pcm` slot or the dumps are missing the suite is
// skipped so the build stays green — see __fixtures__/realDumps/README.md.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const allPcmPairs = [];
if (fixtures) {
  if (fixtures.pcm) allPcmPairs.push({ label: 'primary 4 KB GPEC2A', pair: fixtures.pcm });
  if (Array.isArray(fixtures.extraPcms)) {
    fixtures.extraPcms.forEach((p, i) => {
      const sz = p.after.length;
      const sizeLabel = sz === 8192 ? '8 KB GPEC2A' : sz === 4096 ? '4 KB GPEC2A' : `${sz} B GPEC2A`;
      allPcmPairs.push({ label: `extraPcms[${i}] · ${sizeLabel}`, pair: p });
    });
  }
}

(allPcmPairs.length > 0 ? describe : describe.skip)(
  'pcmSec6 — real-dump SEC6 write round-trip',
  () => {
    if (allPcmPairs.length === 0) {
      it.skip('no PCM before/after pair in manifest', () => {});
      return;
    }

    for (const { label, pair } of allPcmPairs) {
      describe(label, () => {
        it(`writePcmSec6(before, rfhSec16) === captured after (size=${pair.after.length})`, () => {
          const r = writePcmSec6(pair.before, pair.rfhSec16);
          expect(r.ok, 'writer refused canonical PCM').toBe(true);
          expect(r.patched, 'writer should have stamped marker + SEC6').toBe(1);
          expect(r.markerStamped).toBe(true);
          expect(r.bytes.length).toBe(pair.after.length);

          // Byte-for-byte equality of the full image. First ~10 mismatches are
          // surfaced for focused debugging if the writer drifts.
          let diffs = 0;
          const samples = [];
          for (let i = 0; i < pair.after.length; i++) {
            if (r.bytes[i] !== pair.after[i]) {
              diffs++;
              if (samples.length < 10) {
                samples.push(
                  `0x${i.toString(16).padStart(4, '0')}: ` +
                  `got 0x${r.bytes[i].toString(16).padStart(2, '0')}, ` +
                  `expected 0x${pair.after[i].toString(16).padStart(2, '0')}`,
                );
              }
            }
          }
          if (diffs > 0) {
            throw new Error(
              `PCM SEC6 round-trip (${label}): ${diffs} byte(s) differ. First mismatches:\n  ` +
              samples.join('\n  '),
            );
          }

          // Spot-check the canonical marker + SEC6 region landed exactly where
          // the writer documents (0x3C4 marker + 0x3C8 secret) — guards against
          // a future fixture rebuild that quietly relocates the slot.
          const marker = Array.from(r.bytes.slice(0x3C4, 0x3C8));
          expect(marker).toEqual([0xFF, 0xFF, 0xFF, 0xAA]);
          const sec6 = Array.from(r.bytes.slice(0x3C8, 0x3CE));
          expect(sec6).toEqual(Array.from(pair.rfhSec16.slice(0, 6)));
        });
      });
    }

    it('every captured pair shares the canonical FF FF FF AA marker @ 0x3C4 (no GPEC5 variant)', () => {
      for (const { label, pair } of allPcmPairs) {
        const captured = Array.from(pair.after.slice(0x3C4, 0x3C8));
        expect(captured, `${label}: marker bytes should be FF FF FF AA at 0x3C4`).toEqual(
          [0xFF, 0xFF, 0xFF, 0xAA],
        );
      }
    });
  },
);
