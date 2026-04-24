import { describe, it, expect } from 'vitest';

import { scanBufferForDonorLeak } from '../../../scripts/anonymize-real-dump.mjs';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #440 — run the anonymizer's own whole-buffer leak scan against every
// committed `after.bin` in the real-dump manifest.
//
// Why a separate test (vs. extending realDumps.anonymization.test.js)?
// That sister suite re-implements its own slot-aware scanners, donor-VIN
// matchers, and tail masking. The helper script
// (`scripts/anonymize-real-dump.mjs`) ALSO carries an internal post-scrub
// leak scanner — and the two can drift. Task #436's failure mode was
// exactly that: a maintainer who bypasses the helper script and hand-
// scrubs a fresh fixture can slip a donor leak past review if the leak
// happens to fall outside whichever per-module slot table the sister
// suite's scanner remembers.
//
// This file closes the drift gap by importing the helper script's own
// `scanBufferForDonorLeak` and running it against every committed
// `after.bin` whose manifest entry declares a `donorVin`. Any change to
// the helper's scanner is automatically reflected in CI here, so the
// helper and the test cannot disagree about what counts as a leak.
//
// Asserted invariant per fixture (with declared `donorVin`):
//   - The committed `after.bin` does NOT contain `donorVin` forward,
//     does NOT contain `donorVin` byte-reversed, and does NOT contain
//     the donor's last-6 character serial (forward or byte-reversed)
//     OUTSIDE the documented full-VIN / partial-VIN slot windows for
//     that module type.
//
// `before.bin` is intentionally NOT scanned here: a `before.bin` may
// legitimately retain the anon VIN at slot windows that have been
// blanked to 0xFF for the writer to fill in, but is otherwise a clone
// of the same buffer — there is no reason to expect a `before.bin` to
// hold the donor VIN if the `after.bin` doesn't, and the masking
// logic is pinned to the after-state slot population. The companion
// `realDumps.anonymization.test.js` already does the broader before+
// after sweep with its own scanner; this file's job is the narrow
// "use the helper's own scanner so they cannot drift" check.
//
// Skip-don't-fail policy mirrors the other realDumps tests: if the
// manifest is missing or no fixture entry declares a `donorVin`, the
// suite skips with a loud reason rather than failing.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();

const targets = [];
if (fixtures !== null) {
  if (fixtures.bcm)     targets.push({ label: 'bcm',     moduleType: 'bcm',     entry: fixtures.bcm });
  if (fixtures.rfhub)   targets.push({ label: 'rfhub',   moduleType: 'rfhub',   entry: fixtures.rfhub });
  if (fixtures.rfhubg1) targets.push({ label: 'rfhubg1', moduleType: 'rfhubg1', entry: fixtures.rfhubg1 });
  if (fixtures.pcm)     targets.push({ label: 'pcm',     moduleType: 'pcm',     entry: fixtures.pcm });
  if (Array.isArray(fixtures.extraBcms)) {
    fixtures.extraBcms.forEach((entry, i) => {
      targets.push({ label: `extraBcms[${i}]`, moduleType: 'bcm', entry });
    });
  }
  if (Array.isArray(fixtures.extraPcms)) {
    fixtures.extraPcms.forEach((entry, i) => {
      targets.push({ label: `extraPcms[${i}]`, moduleType: 'pcm', entry });
    });
  }
}

// Only fixtures with a declared `donorVin` are eligible — the helper's
// scanner needs a known donor to look for. Fixtures without one (the
// primary `bcm` pair, currently) are skipped here; the broader
// realDumps.anonymization.test.js still enforces the hardcoded baseline
// against them.
const scannableTargets = targets.filter(
  t => typeof t.entry.donorVin === 'string' && t.entry.donorVin.length === 17,
);

(scannableTargets.length > 0 ? describe : describe.skip)(
  'realDumps — helper script leak scan (CI guard against silent donor leaks)',
  () => {
    if (scannableTargets.length === 0) {
      it.skip('no fixtures declare `donorVin` yet — nothing to scan with the helper', () => {});
      return;
    }

    for (const { label, moduleType, entry } of scannableTargets) {
      describe(`${label} (${moduleType}) — donor=${entry.donorVin}`, () => {
        it(`${label}.after.bin passes the helper's whole-buffer donor-leak scan`, () => {
          const leak = scanBufferForDonorLeak({
            buffer: entry.after,
            donorVin: entry.donorVin,
            moduleType,
          });
          expect(
            leak,
            leak === null
              ? ''
              : `${label}.after.bin (${entry.afterPath}): helper scanner reported a donor leak — ` +
                `kind=${leak.kind}, offset=0x${leak.offset.toString(16).toUpperCase().padStart(4, '0')}. ` +
                `${leak.message} ` +
                `This means the committed fixture leaks the donor vehicle's identifier in a way ` +
                `the helper script (anonymize-real-dump.mjs) would refuse to write. Either re-run ` +
                `the helper on the original capture (preferred — see README.md) or hand-scrub the ` +
                `flagged offset.`,
          ).toBe(null);
        });
      });
    }
  },
);
