// Tests for the asset-sweep hand-ported seed-key algorithms.
//
// Each entry in `EXTENDED_ALGORITHMS` carries pinned (seed, key) vectors
// lifted from the canonical Python source `srtlab_canflash_algos.py` (or
// computed from the closed-form expression in the docstring for entries
// whose Python source ships without vectors). The sweep tool itself
// verifies these on every run; this test file re-runs the verification
// inside the artifact's `node --test` suite so:
//
//   1. The committed `extendedAlgorithms.generated.js` cannot drift from
//      its embedded vectors without breaking
//      `pnpm --filter @workspace/srt-lab test`.
//   2. Anyone editing `tools/asset-sweep/src/ports.mjs` who forgets to
//      re-run the sweep gets caught by CI immediately.
//
// Run: node --test artifacts/srt-lab/src/__tests__/extendedAlgorithms.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTENDED_ALGORITHMS,
  EXTENDED_FN_BY_TAG,
  EXTENDED_VERIFICATION,
} from "../lib/extendedAlgorithms.generated.js";

test("ships at least one ported algorithm", () => {
  assert.ok(EXTENDED_ALGORITHMS.length > 0,
    "expected EXTENDED_ALGORITHMS to be non-empty");
});

test("captured a successful self-test report at sweep time", () => {
  assert.ok(Array.isArray(EXTENDED_VERIFICATION),
    "EXTENDED_VERIFICATION should be an array");
  for (const r of EXTENDED_VERIFICATION) {
    assert.equal(r.failed.length, 0,
      `port ${r.tag} sweep-time vectors should all pass — got ${r.failed.length} failures`);
  }
});

for (const a of EXTENDED_ALGORITHMS) {
  test(`${a.tag} — exposes a u32→u32 fn() and a non-empty vectors[]`, () => {
    assert.equal(typeof a.fn, "function", `${a.tag}.fn`);
    assert.equal(EXTENDED_FN_BY_TAG[a.tag], a.fn,
      `${a.tag}: EXTENDED_FN_BY_TAG should map back to the same fn`);
    assert.ok(a.vectors.length > 0, `${a.tag}.vectors`);
    // The fn must produce a non-NaN u32 for an arbitrary seed.
    const sample = a.fn(0xCAFEBABE) >>> 0;
    assert.ok(Number.isFinite(sample), `${a.tag}: result is finite`);
    assert.ok(sample >= 0 && sample <= 0xFFFFFFFF,
      `${a.tag}: result fits in u32`);
  });

  test(`${a.tag} — every pinned vector matches the port`, () => {
    for (const v of a.vectors) {
      const seedHex =
        "0x" + (v.seed >>> 0).toString(16).toUpperCase().padStart(8, "0");
      const expectedHex =
        "0x" + (v.key >>> 0).toString(16).toUpperCase().padStart(8, "0");
      const got = a.fn(v.seed) >>> 0;
      const gotHex =
        "0x" + got.toString(16).toUpperCase().padStart(8, "0");
      assert.equal(got, v.key >>> 0,
        `${a.tag}.fn(${seedHex}) — expected ${expectedHex}, got ${gotHex}`);
    }
  });
}
