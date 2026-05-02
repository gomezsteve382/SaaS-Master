// Drift gate for the asset-sweep tool (Task #562).
//
// `pnpm sweep:assets:check` walks attached_assets/ and recomputes every
// generated artifact (extendedAlgorithms.generated.js, extendedCrc.generated.js,
// public/unlock_catalog_extended.json, plus the inventory/findings/REPORT
// files under tools/asset-sweep/). It exits non-zero if anything would change.
//
// This mirrors the `unlockCatalog.test.mjs` "in sync with the canonical
// generator output" pattern: a contributor who lands new files in
// attached_assets/ without re-running the sweep gets a failing test instead
// of a silently desynced extended catalog.
//
// Run: node --test artifacts/srt-lab/src/__tests__/assetSweepSync.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const SWEEP = resolve(REPO_ROOT, "tools/asset-sweep/src/sweep.mjs");

test(
  "asset-sweep generated outputs are in sync with attached_assets/",
  { timeout: 120_000 },
  () => {
    const result = spawnSync("node", [SWEEP, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const tail = (result.stdout + result.stderr).split("\n").slice(-40).join("\n");
      assert.fail(
        "asset-sweep --check reported drift. Re-run `pnpm sweep:assets` and " +
          "commit the regenerated tools/asset-sweep/{inventory,findings,REPORT} " +
          "and artifacts/srt-lab/{src/lib/extended*.generated.js,public/unlock_catalog_extended.json}.\n" +
          `--- sweep tail ---\n${tail}`,
      );
    }
  },
);
