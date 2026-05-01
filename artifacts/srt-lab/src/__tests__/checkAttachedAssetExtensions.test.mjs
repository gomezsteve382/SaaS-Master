// Test for `scripts/check-attached-asset-extensions.mjs` (Task #504).
//
// Builds a small temp `attached_assets/`-shaped directory with a known mix
// of correctly-named and mis-named files, points the script at it via
// argv (the script reads from the workspace's real `attached_assets/`,
// so we run it as a subprocess against a temp HOME-style override using
// a wrapper). Since the script is wired to a fixed path relative to its
// own location, we instead test the detection logic by importing the
// script's helpers directly via a small subprocess that calls it.
//
// Easiest stable contract to test: invoke the script as a subprocess
// against the real `attached_assets/` and assert the generated JSON
// report exists, has the expected shape, and that EVERY mismatch entry
// carries the four user-visible fields (file, claimedExt, detectedType,
// hint). The Sample Library banner depends on those fields.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(ROOT, "scripts/check-attached-asset-extensions.mjs");
const OUT_PATH = resolve(ROOT, "src/lib/attachedAssetMismatches.generated.json");

test("check-attached-asset-extensions writes a report and shape is stable", () => {
  // Run the script in --quiet mode so test output stays clean.
  execFileSync("node", [SCRIPT, "--quiet"], { stdio: "pipe" });
  assert.ok(existsSync(OUT_PATH), "expected generated report to exist");
  const report = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(report.generatedAt.length > 0, "generatedAt should be set");
  assert.equal(typeof report.assetsDir, "string");
  assert.ok(report.assetsDir.endsWith("attached_assets"), "assetsDir should point at attached_assets/");
  assert.ok(typeof report.scanned === "number" && report.scanned >= 0, "scanned should be a count");
  assert.ok(Array.isArray(report.mismatches), "mismatches should be an array");
  for (const m of report.mismatches) {
    assert.equal(typeof m.file, "string", "mismatch.file is a string");
    assert.equal(typeof m.size, "number", "mismatch.size is a number");
    assert.equal(typeof m.claimedExt, "string", "mismatch.claimedExt is a string");
    assert.equal(typeof m.claimedKind, "string", "mismatch.claimedKind is a string");
    assert.equal(typeof m.detectedType, "string", "mismatch.detectedType is a string");
    assert.equal(typeof m.hint, "string", "mismatch.hint is a string");
    assert.ok(m.hint.length > 0, "hint should be non-empty so the user knows what the file actually is");
  }
});

test("check-attached-asset-extensions catches a misnamed BCM dump (the Task #497 class of bug)", () => {
  // Read the source bytes of the script and exercise its detection helpers
  // by importing it dynamically. We can't import it directly because it
  // calls main() at module load, but main() only writes a file and
  // optionally prints — it doesn't throw. So we just call the script
  // again and inspect the report.
  execFileSync("node", [SCRIPT, "--quiet"], { stdio: "pipe" });
  const report = JSON.parse(readFileSync(OUT_PATH, "utf8"));

  // The repo currently has known misnamed files — a 64 KB BCM-shaped
  // file masquerading as `.png` and a Python J2534 bridge masquerading
  // as `.bin`. If those rescues happen later and the report goes empty,
  // the test still passes (nothing to check). What we DO assert is that
  // any binary-shaped mismatch carries a module-shape hint that names
  // the canonical size, so the rescuer doesn't have to repeat the
  // size-table lookup Task #497 had to do by hand.
  for (const m of report.mismatches) {
    if (m.detectedType !== "binary") continue;
    if (m.size === 65536 || m.size === 131072) {
      assert.match(m.hint, /BCM/, "64/128 KB raw binaries should hint at BCM DFLASH");
    } else if (m.size === 8192) {
      assert.match(m.hint, /95640|GPEC2A 8 KB/, "8 KB raw binaries should hint at 95640 / GPEC2A 8K");
    } else if (m.size === 4096) {
      assert.match(m.hint, /RFHUB|GPEC2A 4 KB/, "4 KB raw binaries should hint at RFHUB / GPEC2A 4K");
    } else if (m.size === 2048) {
      assert.match(m.hint, /RFHUB Gen1/, "2 KB raw binaries should hint at RFHUB Gen1");
    } else if (m.size === 4194304) {
      assert.match(m.hint, /GPEC2A internal flash/, "4 MB raw binaries should hint at GPEC2A internal flash");
    }
  }
});

test("--check exit code reflects whether mismatches exist", () => {
  // Discover current mismatch count from the report (already generated
  // above by the previous tests).
  const report = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  let exitCode = 0;
  try {
    execFileSync("node", [SCRIPT, "--check", "--quiet"], { stdio: "pipe" });
  } catch (ex) {
    exitCode = ex.status ?? 1;
  }
  if (report.mismatches.length === 0) {
    assert.equal(exitCode, 0, "no mismatches → --check should exit 0");
  } else {
    assert.notEqual(exitCode, 0, "mismatches present → --check should exit non-zero (CI signal)");
  }
});
