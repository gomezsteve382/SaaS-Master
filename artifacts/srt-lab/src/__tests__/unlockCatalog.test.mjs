// Catalog smoke test for Task #499.
// Validates the canonical unlock_catalog.json against its Zod schema and
// asserts the structural invariants the SRT Lab UI depends on:
//   - every reversed entry has a non-empty python_function
//   - every dll_only entry has a non-empty reason
//   - every CAN id (when present) is in the 11-bit range (0..0x7FF)
//   - reversed_count + dll_only_count == entry_count
//   - module names are unique
//   - file basenames match module + ".dll"
// Run: node --test artifacts/srt-lab/src/__tests__/unlockCatalog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseCatalog} from "../lib/unlockCatalogSchema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_PATH = resolve(__dirname, "..", "..", "public", "unlock_catalog.json");
const REPO_PATH = resolve(__dirname, "..", "..", "..", "..", "tools", "python-bridge", "tools", "unlock_catalog.json");

function loadCatalog(p) {
  return parseCatalog(JSON.parse(readFileSync(p, "utf8")));
}

test("public/unlock_catalog.json is in sync with the canonical generator output", () => {
  // Task #634 — the copy step merges hand-curated extension entries
  // (task634_entries) into public/unlock_catalog.json without touching the
  // python-bridge source (per project preference: no edits to
  // tools/python-bridge/). The drift check therefore compares the canonical
  // fields and ignores the additive `task634_*` keys.
  const pub = JSON.parse(readFileSync(PUBLIC_PATH, "utf8"));
  const repo = JSON.parse(readFileSync(REPO_PATH, "utf8"));
  const stripExt = (o) => {
    const c = { ...o };
    delete c.task634_entries;
    delete c.task634_provenance;
    return c;
  };
  assert.deepStrictEqual(
    stripExt(pub),
    stripExt(repo),
    "public/unlock_catalog.json drifted from tools/python-bridge/tools/unlock_catalog.json — run `node artifacts/srt-lab/scripts/copy-unlock-catalog.mjs`",
  );
});

test("catalog parses against the schema and matches generator counts", () => {
  const cat = loadCatalog(PUBLIC_PATH);
  assert.equal(cat.schema_version, 1);
  assert.ok(cat.entry_count >= 81, `expected >= 81 DLLs catalogued, got ${cat.entry_count}`);
  assert.equal(cat.entries.length, cat.entry_count);
  assert.equal(
    cat.reversed_count + cat.dll_only_count,
    cat.entry_count,
    "reversed_count + dll_only_count must equal entry_count",
  );
});

test("every entry has the required status-conditional fields", () => {
  const cat = loadCatalog(PUBLIC_PATH);
  for (const e of cat.entries) {
    if (e.status === "reversed") {
      assert.ok(
        typeof e.python_function === "string" && e.python_function.length > 0,
        `reversed entry ${e.module} missing python_function`,
      );
      assert.match(
        e.python_function,
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        `python_function for ${e.module} must be a valid identifier`,
      );
    } else {
      assert.equal(e.status, "dll_only", `unexpected status: ${e.status}`);
      assert.ok(
        typeof e.reason === "string" && e.reason.trim().length > 0,
        `dll_only entry ${e.module} must explain why it isn't ported`,
      );
    }
  }
});

test("CAN ids are valid 11-bit identifiers", () => {
  const cat = loadCatalog(PUBLIC_PATH);
  for (const e of cat.entries) {
    for (const [field, val] of [["tx_can_id", e.tx_can_id], ["rx_can_id", e.rx_can_id]]) {
      if (val === null || val === undefined) continue;
      assert.ok(
        Number.isInteger(val) && val >= 0 && val <= 0x7FF,
        `${e.module}.${field} = ${val} is outside the 11-bit CAN range (0x000..0x7FF)`,
      );
    }
  }
});

test("module names are unique and file basenames line up", () => {
  const cat = loadCatalog(PUBLIC_PATH);
  const seen = new Set();
  for (const e of cat.entries) {
    assert.ok(!seen.has(e.module), `duplicate module: ${e.module}`);
    seen.add(e.module);
    assert.equal(
      e.file.toLowerCase(),
      `${e.module.toLowerCase()}.dll`,
      `file ${e.file} must equal ${e.module}.dll`,
    );
  }
});

test("every reversed entry carries an algorithm-family tag", () => {
  // Surfaced in the SRT Lab UI so mechanics can see which crypto family each
  // native port implements (handy when filing bug reports). The tag itself
  // comes from COVERAGE in canflash_seedkey.py + the small _EXTRA_ALGORITHMS
  // fallback in srtlab_unlock_catalog_gen.py.
  const cat = loadCatalog(PUBLIC_PATH);
  const missing = [];
  for (const e of cat.entries) {
    if (e.status !== "reversed") continue;
    if (typeof e.algorithm !== "string" || e.algorithm.trim() === "") {
      missing.push(e.module);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `${missing.length} reversed entries lack an algorithm tag: ${missing.join(", ")}`,
  );
});

test("ecu_info is present and decoded for every catalogued DLL", () => {
  const cat = loadCatalog(PUBLIC_PATH);
  let decoded = 0;
  for (const e of cat.entries) {
    assert.ok(e.ecu_info, `${e.module} has no ecu_info`);
    if (!e.ecu_info.decode_failed) decoded++;
  }
  assert.equal(
    decoded,
    cat.entries.length,
    `expected every entry to decode ecu_info; ${cat.entries.length - decoded} failed`,
  );
});
