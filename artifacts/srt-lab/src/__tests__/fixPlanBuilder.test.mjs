// Unit tests for the Workflow Runner Census + Fix Plan + Sign-Off (Task #501).
// Run: node --test artifacts/srt-lab/src/__tests__/fixPlanBuilder.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildCensus } from "../lib/moduleCensus.js";
import { buildFixPlan, buildSignOff } from "../lib/fixPlanBuilder.js";

const VIN_OLD = "1C4HJWFG3FL700001";
const VIN_NEW = "1C4HJWFG3FL700099";

const expected = [
  { code: "BCM", name: "Body Control Module", tx: 0x614, rx: 0x624 },
  { code: "RFHUB", name: "RF Hub", tx: 0x654, rx: 0x65C },
  { code: "ECM", name: "Engine Control Module", tx: 0x7E0, rx: 0x7E8 },
];

function fakeDump(type, vin, hash) {
  return { hash, type, mod: { vin } };
}

test("census flags missing slots, mismatch slots, and OK slots", () => {
  const loaded = [
    fakeDump("BCM", VIN_OLD, "h_bcm"),
    fakeDump("ECM", VIN_NEW, "h_ecm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const byCode = Object.fromEntries(census.rows.map((r) => [r.code, r]));
  assert.equal(byCode.BCM.kind, "mismatch");
  assert.equal(byCode.RFHUB.kind, "missing");
  assert.equal(byCode.ECM.kind, "ok");
  assert.equal(census.summary.mismatch, 1);
  assert.equal(census.summary.missing, 1);
  assert.equal(census.summary.ok, 1);
});

test("census flags extras and unknowns separately", () => {
  const loaded = [
    fakeDump("BCM", VIN_NEW, "h_bcm"),
    fakeDump("RFHUB", VIN_NEW, "h_rfh"),
    fakeDump("ECM", VIN_NEW, "h_ecm"),
    fakeDump("TIPM", VIN_NEW, "h_tipm"),
    fakeDump("UNKNOWN", null, "h_unk"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const byCode = Object.fromEntries(census.rows.map((r) => [r.code, r]));
  assert.equal(byCode.TIPM.kind, "extra");
  assert.equal(byCode.UNKNOWN.kind, "unknown");
});

test("census flags corrupt loaded modules (Task #948)", () => {
  const loaded = [
    fakeDump("BCM", VIN_NEW, "h_bcm"),
    { hash: "h_rfh", type: "RFHUB", mod: { vin: VIN_NEW, corruptFill: { reason: "single-byte fill" } } },
    fakeDump("ECM", VIN_NEW, "h_ecm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const byCode = Object.fromEntries(census.rows.map((r) => [r.code, r]));
  assert.equal(byCode.RFHUB.kind, "corrupt");
  assert.ok(/single-byte fill/.test(byCode.RFHUB.reason));
  assert.equal(census.summary.corrupt, 1);
  // A corrupt module must not be miscounted as ok/mismatch.
  assert.equal(byCode.BCM.kind, "ok");
  assert.equal(byCode.ECM.kind, "ok");
});

test("corrupt loaded module reported as extra is still flagged corrupt", () => {
  const loaded = [
    { hash: "h_tipm", type: "TIPM", mod: { vin: VIN_NEW, corruptFill: { reason: "repeated ASCII string" } } },
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const byCode = Object.fromEntries(census.rows.map((r) => [r.code, r]));
  assert.equal(byCode.TIPM.kind, "corrupt");
});

test("Fix Plan blocks and skips steps for a corrupt module (Task #948)", () => {
  const loaded = [
    fakeDump("BCM", VIN_OLD, "h_bcm"),
    { hash: "h_rfh", type: "RFHUB", mod: { vin: VIN_OLD, corruptFill: { reason: "single-byte fill" } } },
    fakeDump("ECM", VIN_OLD, "h_ecm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW, options: { includeVerify: true } });
  assert.ok(plan.blockers.some((b) => /Corrupt dump: RFHUB/.test(b)));
  // The corrupt RFHUB must not produce a VIN write or a verify step.
  assert.ok(!plan.steps.some((s) => s.module === "RFHUB" && s.action === "vinWrite"));
  assert.ok(!plan.steps.some((s) => s.module === "RFHUB" && s.action === "verify"));
});

test("Fix Plan orders VIN writes BCM → RFHUB → ECM", () => {
  const loaded = [
    fakeDump("ECM", VIN_OLD, "h_ecm"),
    fakeDump("RFHUB", VIN_OLD, "h_rfh"),
    fakeDump("BCM", VIN_OLD, "h_bcm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW });
  const writes = plan.steps.filter((s) => s.action === "vinWrite").map((s) => s.module);
  assert.deepEqual(writes, ["BCM", "RFHUB", "ECM"]);
  // Pairing comes after VIN writes; verify steps come after pairing.
  const ord = plan.steps.map((s) => s.action);
  const lastVinWrite = ord.lastIndexOf("vinWrite");
  const firstPair = ord.indexOf("pairing");
  const firstVerify = ord.indexOf("verify");
  if (firstPair !== -1) assert.ok(firstPair > lastVinWrite, "pairing must follow vinWrite");
  if (firstVerify !== -1) assert.ok(firstVerify > lastVinWrite, "verify must follow vinWrite");
});

test("Fix Plan blockers surface missing and unknown rows", () => {
  const loaded = [fakeDump("UNKNOWN", null, "h_unk")];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW });
  assert.ok(plan.blockers.some((b) => /Missing dump: BCM/.test(b)));
  assert.ok(plan.blockers.some((b) => /Missing dump: RFHUB/.test(b)));
  assert.ok(plan.blockers.some((b) => /Missing dump: ECM/.test(b)));
  assert.ok(plan.blockers.some((b) => /Unknown dump/.test(b)));
});

test("Fix Plan sec16Patch step is created when BCM is present", () => {
  const loaded = [
    fakeDump("BCM", VIN_OLD, "h_bcm"),
    fakeDump("RFHUB", VIN_NEW, "h_rfh"),
    fakeDump("ECM", VIN_NEW, "h_ecm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW });
  assert.ok(plan.steps.some((s) => s.action === "sec16Patch" && s.module === "BCM"));
});

test("Fix Plan steps each have a stable id and required fields", () => {
  const loaded = [fakeDump("BCM", VIN_OLD, "h_bcm")];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW });
  for (const s of plan.steps) {
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.module, "string");
    assert.equal(typeof s.action, "string");
    assert.equal(typeof s.label, "string");
    assert.ok(Array.isArray(s.expectedTraffic));
  }
});

test("Sign-Off summary aggregates per-step results and ready flag", () => {
  const loaded = [
    fakeDump("BCM", VIN_OLD, "h_bcm"),
    fakeDump("RFHUB", VIN_OLD, "h_rfh"),
    fakeDump("ECM", VIN_OLD, "h_ecm"),
  ];
  const census = buildCensus({ expected, loaded, targetVin: VIN_NEW });
  const plan = buildFixPlan({ census, targetVin: VIN_NEW });
  const results = Object.fromEntries(
    plan.steps.map((s) => [s.id, { status: "ok", note: "", finishedAt: "2026-05-01T00:00:00Z" }]),
  );
  const summary = buildSignOff({ census, plan, results, targetVin: VIN_NEW });
  assert.equal(summary.totals.total, plan.steps.length);
  assert.equal(summary.totals.completed, plan.steps.length);
  assert.equal(summary.totals.failed, 0);
  assert.equal(summary.ready, true);

  // Now flip one step to fail and confirm ready becomes false.
  const firstStep = plan.steps[0];
  results[firstStep.id] = { status: "fail", note: "NRC 0x36" };
  const summary2 = buildSignOff({ census, plan, results, targetVin: VIN_NEW });
  assert.equal(summary2.totals.failed, 1);
  assert.equal(summary2.ready, false);
});
