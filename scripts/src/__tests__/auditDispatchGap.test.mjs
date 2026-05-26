import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const SCRIPT = resolve(ROOT, "scripts/src/audit-dispatch-gap.mjs");
const OUT = resolve(ROOT, "artifacts/srt-lab/src/lib/dispatchGapReport.generated.js");

function runAudit() {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`audit script failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

test("audit script generates report and is idempotent", async () => {
  runAudit();
  const first = readFileSync(OUT, "utf8");
  runAudit();
  const second = readFileSync(OUT, "utf8");
  assert.equal(first, second, "running twice should produce identical output");
  assert.ok(first.startsWith("// AUTO-GENERATED. DO NOT EDIT BY HAND.\n// Run: pnpm -F @workspace/scripts run audit:dispatch-gap"));
});

test("generated report exposes required shape", async () => {
  runAudit();
  const mod = await import(OUT + `?t=${Date.now()}`);
  const { DISPATCH_GAP_META, TIER1_ROUTINE_IDS, DISPATCH_GAP_BY_ECU, TIER1_STATUS } = mod;

  assert.ok(DISPATCH_GAP_META.totalRoutines > 0, "totalRoutines > 0");
  assert.ok(
    DISPATCH_GAP_META.coveragePct >= 0 && DISPATCH_GAP_META.coveragePct <= 100,
    "coveragePct between 0 and 100",
  );
  assert.equal(DISPATCH_GAP_META.coveredCount + DISPATCH_GAP_META.gapCount, DISPATCH_GAP_META.totalRoutines);
  assert.equal(typeof DISPATCH_GAP_META.generatedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(DISPATCH_GAP_META.generatedAt)), "generatedAt is ISO parseable");

  assert.equal(TIER1_ROUTINE_IDS.length, 8);
  assert.equal(TIER1_STATUS.length, 8);

  for (const row of TIER1_STATUS) {
    assert.equal(typeof row.rid, "number");
    assert.equal(typeof row.covered, "boolean");
    assert.ok(Array.isArray(row.dispatchFrames));
  }

  const familyKeys = Object.keys(DISPATCH_GAP_BY_ECU);
  assert.ok(familyKeys.length > 0, "at least one ECU family");
  // JS object key iteration: canonical integer-indexed keys ascend first,
  // then string keys in insertion order. The script inserts string keys
  // in localeCompare order, so the non-integer tail must be locale-sorted.
  const isIntKey = (k) => /^(?:0|[1-9]\d*)$/.test(k);
  const stringTail = familyKeys.filter((k) => !isIntKey(k));
  const sortedTail = [...stringTail].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(stringTail, sortedTail, "ECU families (non-numeric) must be sorted");
  const intKeys = familyKeys.filter(isIntKey);
  const sortedInts = [...intKeys].sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(intKeys, sortedInts, "ECU families (numeric) must be ascending");

  for (const fam of familyKeys) {
    const b = DISPATCH_GAP_BY_ECU[fam];
    assert.equal(b.covered + b.gap, b.total);
    assert.ok(b.gapRoutineIds.length <= 50, "gapRoutineIds capped at 50");
  }
});
