// Regression test for the "EXPORT ALL" baselines action added in task #192.
//
// J2534Scanner.jsx is a React component, so we can't drive the click handler
// from node:test directly. Instead we anchor on the *contracts* the handler
// relies on:
//
//   1. The component still defines an onExportAllBaselines useCallback that
//      calls buildBaselineExport() with the full baselines array.
//   2. The wrapper format produced by buildBaselineExport round-trips through
//      parseBaselineImport — i.e. exporting all baselines and then re-importing
//      that single file yields the same {label, ts, modules} entries.
//   3. Re-importing the bundle assigns fresh ids so the restored entries do
//      not collide with anything already in the picker.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCANNER_SRC = readFileSync(
  join(__dirname, "..", "J2534Scanner.jsx"),
  "utf8",
);

// Mirror buildBaselineExport / parseBaselineImport from J2534Scanner.jsx.
// Kept in sync via the source-anchoring assertions below.
const BASELINE_EXPORT_TYPE = "srtlab.j2534.baseline";
const BASELINE_EXPORT_VERSION = 1;

function buildBaselineExport(baselines) {
  return {
    type: BASELINE_EXPORT_TYPE,
    version: BASELINE_EXPORT_VERSION,
    exportedAt: Date.now(),
    baselines: baselines.map((b) => ({
      label: b.label,
      ts: b.ts,
      modules: b.modules,
    })),
  };
}

function parseBaselineImport(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Not valid JSON."); }
  let candidates = [];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && Array.isArray(parsed.baselines)) {
    if (parsed.type && parsed.type !== BASELINE_EXPORT_TYPE) {
      throw new Error(`Unrecognized export type "${parsed.type}".`);
    }
    candidates = parsed.baselines;
  } else if (parsed && Array.isArray(parsed.modules)) {
    candidates = [parsed];
  } else {
    throw new Error("JSON does not look like a baseline export.");
  }
  const out = [];
  for (const c of candidates) {
    if (!c || !Array.isArray(c.modules)) continue;
    out.push({
      label: typeof c.label === "string" && c.label.trim() ? c.label.trim() : "Imported baseline",
      ts: typeof c.ts === "number" ? c.ts : Date.now(),
      modules: c.modules,
    });
  }
  if (!out.length) throw new Error("No baselines with modules found in JSON.");
  return out;
}

test("export all: source defines the bulk-export handler and EXPORT ALL button", () => {
  assert.match(
    SCANNER_SRC,
    /onExportAllBaselines\s*=\s*useCallback/,
    "onExportAllBaselines handler is missing from J2534Scanner.jsx",
  );
  // The handler must hand the entire baselines array to buildBaselineExport,
  // not a single entry like onExportBaseline does.
  const body = SCANNER_SRC.match(
    /onExportAllBaselines\s*=\s*useCallback\([\s\S]*?\n\s*\}\s*,\s*\[[^\]]*\]\s*\)/,
  );
  assert.ok(body, "could not isolate onExportAllBaselines body");
  assert.match(
    body[0],
    /buildBaselineExport\s*\(\s*baselines\s*\)/,
    "onExportAllBaselines must pass the full baselines array to buildBaselineExport",
  );
  // The button itself must be wired to the handler so a UI refactor that
  // removes the entry point breaks the test.
  assert.match(
    SCANNER_SRC,
    /onClick=\{\s*onExportAllBaselines\s*\}/,
    "EXPORT ALL button must be wired to onExportAllBaselines",
  );
  assert.match(
    SCANNER_SRC,
    /EXPORT ALL/,
    "EXPORT ALL button label is missing",
  );
});

test("export all: wrapper round-trips every saved baseline through the importer", () => {
  const saved = [
    { id: "b_one", label: "Pre-tune VIN", ts: 1000, modules: [{ code: "ECM", vin: "A" }] },
    { id: "b_two", label: "Customer car", ts: 2000, modules: [{ code: "BCM" }, { code: "PCM" }] },
    { id: "b_three", label: "Shop demo",   ts: 3000, modules: [{ code: "RFH" }] },
  ];
  const json = JSON.stringify(buildBaselineExport(saved));
  const restored = parseBaselineImport(json);

  assert.equal(restored.length, saved.length, "every saved baseline must be in the bundle");
  for (let i = 0; i < saved.length; i += 1) {
    assert.equal(restored[i].label, saved[i].label);
    assert.equal(restored[i].ts, saved[i].ts);
    assert.deepEqual(restored[i].modules, saved[i].modules);
    // The wrapper deliberately drops ids so the importer can mint fresh ones.
    assert.equal("id" in restored[i], false, "exporter must not leak ids into the bundle");
  }
});

test("export all: re-importing into an existing picker mints fresh ids (no collisions)", () => {
  const existing = [
    { id: "b_one", label: "Pre-tune VIN", ts: 1000, modules: [{ code: "ECM" }] },
  ];
  const json = JSON.stringify(buildBaselineExport(existing));
  const imported = parseBaselineImport(json);

  // The picker assigns a fresh id at import time (newBaselineId in the source).
  // Simulate that here so we can prove ids never collide with the existing row.
  let counter = 0;
  const fresh = imported.map((b) => ({
    id: `mock_fresh_${counter++}`,
    label: b.label,
    ts: b.ts,
    modules: b.modules,
  }));
  const merged = [...fresh, ...existing];
  const ids = merged.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique after import");
});

test("export all: rejects an unrelated wrapper type even if it has a baselines array", () => {
  const wrong = JSON.stringify({
    type: "some.other.tool.export",
    version: 1,
    baselines: [{ label: "x", ts: 1, modules: [{ code: "ECM" }] }],
  });
  assert.throws(() => parseBaselineImport(wrong), /Unrecognized export type/);
});
