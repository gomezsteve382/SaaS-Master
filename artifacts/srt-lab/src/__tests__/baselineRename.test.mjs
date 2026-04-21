// Regression test for the baseline rename action added in task #188.
//
// J2534Scanner.jsx is a React component that calls window.prompt() and uses
// hooks, so we can't drive the click handler from node:test directly. Instead
// this test pins down the *contract* the handler relies on:
//
//   1. The rename writes through to the same localStorage key the picker
//      reads on mount (`srtlab_j2534_baselines`), with the same JSON shape.
//   2. Reloading the picker (loadBaselines round-trip) shows the new label.
//   3. Blank / whitespace-only input is rejected and the previous label is
//      kept — matching onRenameBaseline's "no-op" branch.
//
// To stop the test from silently drifting if the source ever changes the key
// or the rename rule, we also assert against the literal source of
// J2534Scanner.jsx itself.

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

// Read the storage key out of the component source so the test breaks loudly
// if someone renames it without updating the picker's load path.
function extractConst(name) {
  const m = SCANNER_SRC.match(
    new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!m) throw new Error(`could not find const ${name} in J2534Scanner.jsx`);
  return m[1];
}
const BASELINES_KEY = extractConst("BASELINES_KEY");

// Minimal localStorage shim so loadBaselines/persistBaselines can run in node.
function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

// Mirrors persistBaselines() in J2534Scanner.jsx.
function persistBaselines(list) {
  localStorage.setItem(BASELINES_KEY, JSON.stringify(list));
}

// Mirrors the picker's mount-time read: pull the JSON, drop malformed rows.
// This is the same shape loadBaselines() in J2534Scanner.jsx returns
// (minus the legacy-key migration, which isn't relevant here).
function loadBaselines() {
  const raw = localStorage.getItem(BASELINES_KEY);
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (b) => b && typeof b.id === "string" && Array.isArray(b.modules),
  );
}

// Pure projection of onRenameBaseline's decision tree. The component wraps
// this in window.prompt() + setState; here we drive it with the prompt's
// would-be return value so we can assert each branch.
function applyRename(list, id, promptAnswer) {
  const target = list.find((b) => b.id === id);
  if (!target) return { changed: false, list, reason: "unknown-id" };
  if (promptAnswer === null) return { changed: false, list, reason: "cancelled" };
  const trimmed = String(promptAnswer).trim();
  if (!trimmed) return { changed: false, list, reason: "blank-kept-previous" };
  if (trimmed === target.label) return { changed: false, list, reason: "same-label" };
  return {
    changed: true,
    reason: "renamed",
    list: list.map((b) => (b.id === id ? { ...b, label: trimmed } : b)),
  };
}

function seed() {
  installLocalStorage();
  const baselines = [
    { id: "b_one", label: "Pre-tune VIN", ts: 1000, modules: [{ code: "ECM" }] },
    { id: "b_two", label: "Customer car",  ts: 2000, modules: [{ code: "BCM" }] },
  ];
  persistBaselines(baselines);
  return baselines;
}

test("baseline rename: source still uses the picker's storage key + rule", () => {
  // If either of these drifts, the test below would be testing a different
  // contract than the live picker. Fail loudly here instead of silently.
  assert.equal(
    BASELINES_KEY,
    "srtlab_j2534_baselines",
    "picker storage key changed — update the test in lockstep with the picker",
  );
  assert.match(
    SCANNER_SRC,
    /onRenameBaseline\s*=\s*useCallback/,
    "onRenameBaseline handler is missing from J2534Scanner.jsx",
  );
  // The "blank input keeps previous label" rule lives in onRenameBaseline as
  // `if (!trimmed || trimmed === target.label)` — anchor the test to it.
  assert.match(
    SCANNER_SRC,
    /if\s*\(\s*!trimmed\s*\|\|\s*trimmed\s*===\s*target\.label\s*\)/,
    "rename no-op rule changed — applyRename mirror is now stale",
  );
  // The whole point of the rename action is that the new label survives a
  // page reload — i.e. it must be written through persistBaselines, not just
  // setBaselines (which is in-memory only). Anchor the test to that call so
  // accidentally removing it during a refactor breaks the test loudly.
  const renameBody = SCANNER_SRC.match(
    /onRenameBaseline\s*=\s*useCallback\([\s\S]*?\n\s*\}\s*,\s*\[[^\]]*\]\s*\)/,
  );
  assert.ok(renameBody, "could not isolate onRenameBaseline body");
  assert.match(
    renameBody[0],
    /persistBaselines\s*\(/,
    "onRenameBaseline must call persistBaselines() — otherwise renames don't survive a reload",
  );
});

test("baseline rename: new label persists across a picker reload", () => {
  const seeded = seed();

  // User picks "Pre-tune VIN" and renames it to "Shop demo VIN".
  const result = applyRename(seeded, "b_one", "  Shop demo VIN  ");
  assert.equal(result.changed, true);
  assert.equal(result.reason, "renamed");
  persistBaselines(result.list);

  // Reload the picker (fresh loadBaselines, same localStorage).
  const reloaded = loadBaselines();
  assert.equal(reloaded.length, 2, "rename must not drop or duplicate rows");

  const renamed = reloaded.find((b) => b.id === "b_one");
  assert.ok(renamed, "renamed baseline must still be in the list");
  assert.equal(renamed.label, "Shop demo VIN", "trimmed new label must persist");
  assert.equal(renamed.ts, 1000, "rename must not touch ts");
  assert.deepEqual(renamed.modules, [{ code: "ECM" }], "rename must not touch modules");

  const untouched = reloaded.find((b) => b.id === "b_two");
  assert.equal(untouched.label, "Customer car", "siblings must be untouched");
});

test("baseline rename: blank/whitespace input keeps the previous label", () => {
  const seeded = seed();

  for (const blank of ["", "   ", "\t\n  "]) {
    const result = applyRename(seeded, "b_two", blank);
    assert.equal(result.changed, false, `blank input "${JSON.stringify(blank)}" must be a no-op`);
    assert.equal(result.reason, "blank-kept-previous");
    // Caller skips persistBaselines on no-op — but even if it didn't, the
    // list reference is the original, so a reload still shows the old label.
    const reloaded = loadBaselines();
    const target = reloaded.find((b) => b.id === "b_two");
    assert.equal(target.label, "Customer car", "previous label must be preserved");
  }
});

test("baseline rename: cancelling the prompt is a no-op (null answer)", () => {
  const seeded = seed();
  const result = applyRename(seeded, "b_one", null);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "cancelled");
  const reloaded = loadBaselines();
  assert.equal(reloaded.find((b) => b.id === "b_one").label, "Pre-tune VIN");
});

test("baseline rename: re-entering the same label is a no-op", () => {
  const seeded = seed();
  const result = applyRename(seeded, "b_one", "Pre-tune VIN");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "same-label");
});
