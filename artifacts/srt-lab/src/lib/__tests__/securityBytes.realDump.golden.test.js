import { describe, it, expect } from 'vitest';

import {
  writeBcmSec16Gen2,
  writePcmSec6,
  writeRfhSec16FromBcm,
} from '../securityBytes.js';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Real-dump golden vectors for the three security-byte writers.
//
// Companion to securityBytes.golden.test.js: that file pins the writers
// against SYNTHETIC, hand-built buffers (proves internal consistency).
// THIS file pins the writers against an anonymized BEFORE/AFTER triple
// captured from a known-good real-bench Module Sync run. If the writers
// drift from what an actual SINCRO/ArmandoQS-flashed ECU would produce,
// these assertions fail.
//
// The fixture loader returns null when the dumps have not yet been
// committed — in that case every suite below is `describe.skip`'d so the
// build stays green. As soon as the binaries land in
// src/lib/__fixtures__/realDumps/ alongside a manifest.json, the suites
// switch on automatically.
//
// See ../__fixtures__/realDumps/README.md for the manifest schema and the
// anonymization checklist.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const haveAny = fixtures !== null;

/* Compare two Uint8Arrays byte-for-byte. On mismatch produce a focused
 * diff message that points at the first ~10 differing offsets so a
 * regression is debuggable without dumping 64 KiB of hex. */
function expectBytesEqual(actual, expected, label) {
  expect(actual.length, `${label}: length mismatch`).toBe(expected.length);
  const diffs = [];
  for (let i = 0; i < expected.length && diffs.length < 10; i++) {
    if (actual[i] !== expected[i]) {
      diffs.push(
        `0x${i.toString(16).padStart(4, '0')}: ` +
        `got 0x${actual[i].toString(16).padStart(2, '0')}, ` +
        `expected 0x${expected[i].toString(16).padStart(2, '0')}`,
      );
    }
  }
  // Count total diffs for the failure message (cheap second pass — only
  // walked when we already know there's at least one diff).
  if (diffs.length > 0) {
    let total = 0;
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) total++;
    }
    throw new Error(
      `${label}: ${total} byte(s) differ. First mismatches:\n  ${diffs.join('\n  ')}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level skip when the manifest itself is missing — surfaces a single,
// non-noisy skipped describe instead of one per writer.
// ─────────────────────────────────────────────────────────────────────────────

(haveAny ? describe : describe.skip)('securityBytes — real-dump golden vectors', () => {
  if (!haveAny) {
    it.skip('no real-dump fixtures committed yet (see __fixtures__/realDumps/README.md)', () => {});
    return;
  }

  // Per-module suites — each independently skipped if its before/after
  // pair is missing from the manifest. That way a partial commit (e.g.
  // BCM triple only) still validates what's there.

  const bcmDescribe = fixtures.bcm ? describe : describe.skip;
  bcmDescribe('writeBcmSec16Gen2 — real BCM dump', () => {
    if (!fixtures.bcm) {
      it.skip('no BCM before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" BCM bytes from the captured "before" BCM bytes', () => {
      const r = writeBcmSec16Gen2(fixtures.bcm.before, fixtures.rfhSec16);
      expectBytesEqual(r.bytes, fixtures.bcm.after, 'BCM');
      // Sanity: the writer must have actually patched something — a no-op
      // would also satisfy bytewise equality only if before === after, in
      // which case the fixture is useless and we want a loud failure.
      expect(
        r.splitPatched + r.mirrorPatched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });

  const rfhubDescribe = fixtures.rfhub ? describe : describe.skip;
  rfhubDescribe('writeRfhSec16FromBcm — real RFHUB dump', () => {
    if (!fixtures.rfhub) {
      it.skip('no RFHUB before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" RFHUB bytes from the captured "before" RFHUB bytes', () => {
      // BCM SEC16 = reverse(RFH SEC16). The writer expects the BCM-form
      // input (it reverses internally to recover the RFH form).
      const bcmSec16 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) bcmSec16[i] = fixtures.rfhSec16[15 - i];
      const r = writeRfhSec16FromBcm(fixtures.rfhub.before, bcmSec16);
      expectBytesEqual(r.bytes, fixtures.rfhub.after, 'RFHUB');
      expect(
        r.patched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });

  const pcmDescribe = fixtures.pcm ? describe : describe.skip;
  pcmDescribe('writePcmSec6 — real PCM dump', () => {
    if (!fixtures.pcm) {
      it.skip('no PCM before/after pair in manifest', () => {});
      return;
    }
    it('produces the captured "after" PCM bytes from the captured "before" PCM bytes', () => {
      const r = writePcmSec6(fixtures.pcm.before, fixtures.rfhSec16);
      expectBytesEqual(r.bytes, fixtures.pcm.after, 'PCM');
      expect(
        r.patched,
        'writer reported zero patches — fixture before/after look identical',
      ).toBeGreaterThan(0);
    });
  });
});
