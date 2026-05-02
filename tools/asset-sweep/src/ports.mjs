/**
 * Hand-ported seed-key algorithms for the asset sweep.
 *
 * Each entry is the source-of-truth JavaScript translation of a Python
 * algorithm discovered in `attached_assets/`. The sweep tool serializes
 * these into `artifacts/srt-lab/src/lib/extendedAlgorithms.generated.js`
 * and verifies every port against its pinned vectors before emitting.
 *
 * As ports are promoted into the live unlock chain (added to
 * `artifacts/srt-lab/src/lib/algos.js` / `canflashAlgos.js` /
 * `alfaobdAlgorithms.generated.js`), they are removed from the `PORTS`
 * array below — the next sweep then detects them in the live source via
 * `loadKnownAlgorithmTags()`, marks the corresponding finding as
 * `coverageStatus: "already-implemented"`, and the auto-generated
 * `EXTENDED_ALGORITHMS` catalog shrinks accordingly.
 *
 * The full set of vectors that backed each port lives in this file's git
 * history — restoring an entry here is a strict superset of "git revert"
 * for the corresponding promotion commit on the live algos.js side.
 *
 * Vector source for promoted entries: every `_VECTORS` table in
 * `srtlab_canflash_algos.py` (8 vectors per algorithm, hand-verified
 * byte-identical against Unicorn emulation of the original Chrysler
 * J2534 DLLs). For algorithms whose Python source ships without vectors
 * (`bcm_standard`, `bcm_fca` from `srt_lab.py`), vectors were derived
 * from the closed-form expression in the Python docstring and pinned in
 * `artifacts/srt-lab/src/__tests__/algos.assetSweepPromotions.test.mjs`
 * so any future drift on the live side trips a CI failure.
 *
 * `coverageStatus` per entry — consumed by the normalized findings file.
 * The status set is exactly the three values the unlock-coverage contract
 * specifies:
 *   - "already-implemented" — canonical tag is present in the in-app
 *                             catalogs (algos.js / canflashAlgos.js /
 *                             alfaobdAlgorithms.generated.js), or this
 *                             discovery is a utility helper whose Python
 *                             counterpart already lives in the codebase.
 *   - "partial-match"       — canonical tag is not a direct hit but its
 *                             stem (after stripping common suffixes) does
 *                             match a known tag — flagged for human review.
 *   - "new"                 — neither covered nor a stem-match. Hand-ported
 *                             entries below carry `ported: true` so the
 *                             reviewer can see at a glance which "new"
 *                             findings already have an executable JS port
 *                             in this same sweep output.
 */

// ── Algorithm bodies ──────────────────────────────────────────────────
//
// These are intentionally written in plain ES2018 so the sweep tool can
// `Function.prototype.toString` them and emit verbatim into the generated
// file (no Babel / minifier in the pipeline). Helpers used inside an
// algorithm body are inlined so each `fn.toString()` is self-contained.
//
// All ports use unsigned 32-bit semantics — `>>> 0` after every operation
// that could overflow 32 bits. For multiplications that would exceed 53
// bits (the JS Number precision boundary), we rely on `Math.imul` which
// performs a 32-bit signed multiply and returns the low 32 bits; combined
// with `>>> 0` this gives the unsigned u32 product matching Python's
// `(a * b) & 0xFFFFFFFF`.

// (Currently empty — every previously-shipped port has been promoted
// into the live unlock chain. New ports added here will once again
// surface in `extendedAlgorithms.generated.js` until promoted.)

// ── Registry ──────────────────────────────────────────────────────────
//
// Each PORT entry carries the metadata the sweep needs to render a row
// in the generated catalog plus a `vectors` list to verify the
// implementation. `coverageStatus` annotations mirror the values
// produced in `findings.generated.json` so downstream tools can join
// the two artifacts on `tag`.

export const PORTS = [];

// Tags discovered in attached_assets/ that are NOT seed→key cipher
// implementations and therefore intentionally not ported. They appear
// in the normalized findings file with their `coverageStatus` so the
// reviewer can see why they were skipped.
export const NON_CIPHER_FINDINGS = [
  {
    tag: "check_trivial_transforms",
    pythonName: "check_trivial_transforms",
    params: "seed, key",
    coverageStatus: "already-implemented",
    rationale:
      "Diagnostic helper — checks if a captured (seed, key) pair matches a"
      + " trivial transform (identity, byte-reverse, NOT, ROL/ROR…). Not a"
      + " unlock cipher; lives in srtlab_seedkey_capture.py for offline"
      + " forensics. The corresponding helper already lives in the in-repo"
      + " python toolchain — no JS port needed.",
  },
  {
    tag: "w6_by_name",
    pythonName: "w6_by_name",
    params: "seed, name",
    coverageStatus: "already-implemented",
    rationale:
      "Dispatcher wrapper — looks up (r, s) from AOBD_W6_TABLE and forwards"
      + " to `w6(seed, r, s)`. The cipher itself (`w6`) is already in"
      + " algos.js as `alfaW6` / `alfaW6By`, surfaced in SeedTab via the"
      + " AlfaOBD lookup row and `alfa_w6_*` ALGOS entries.",
  },
];

/**
 * Run every port through its pinned vectors. Returns a verification
 * report `{tag, total, failed: [{seed, expected, got}]}` per algorithm.
 * The sweep tool refuses to emit if any vector fails. Returns an empty
 * report when no ports are pending promotion.
 */
export function verifyAllPorts() {
  const report = [];
  for (const p of PORTS) {
    const failed = [];
    for (const v of p.vectors) {
      const got = p.fn(v.seed) >>> 0;
      if (got !== (v.key >>> 0)) {
        failed.push({seed: v.seed, expected: v.key, got});
      }
    }
    report.push({tag: p.tag, total: p.vectors.length, failed});
  }
  return report;
}
