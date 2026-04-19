// Smoke test for the AlfaOBD data extraction codegen.
// Run: node --test artifacts/srt-lab/src/__tests__/alfaobdData.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  DIAG_NAMES,
  CGW_CONFIG,
  FAULTS_BY_HEX,
  STATES,
  UNITS,
  ALFAOBD_META,
} from "../lib/alfaobdData.generated.js";

test("DIAG_NAMES has a meaningful number of recovered entries", () => {
  const count = Object.keys(DIAG_NAMES).length;
  assert.ok(
    count >= 3000,
    `expected >= 3000 diag names, got ${count}. Re-run codegen:alfaobd if the source .db moved.`,
  );
  assert.equal(count, ALFAOBD_META.diagNamesCount);
});

test("DIAG_NAMES values are strings and printable ASCII", () => {
  for (const [id, name] of Object.entries(DIAG_NAMES)) {
    assert.match(id, /^\d+$/, `diag id ${id} must be numeric`);
    assert.equal(typeof name, "string", `diag ${id} must be a string`);
    assert.match(
      name,
      /^[ -~]+$/,
      `diag ${id} contains non-ASCII: ${JSON.stringify(name).slice(0, 80)}`,
    );
  }
});

test("DIAG_NAMES contains a hand-picked known entry (ABS warning lamp)", () => {
  const found = Object.values(DIAG_NAMES).some((v) =>
    v.toLowerCase().includes("abs warning lamp"),
  );
  assert.ok(
    found,
    "expected a diag-name entry containing 'ABS warning lamp' (a known clean row from the recovery)",
  );
});

test("CGW_CONFIG has a meaningful number of recovered entries", () => {
  assert.ok(
    CGW_CONFIG.length >= 200,
    `expected >= 200 CGW config rows, got ${CGW_CONFIG.length}`,
  );
  assert.equal(CGW_CONFIG.length, ALFAOBD_META.cgwConfigCount);
});

test("CGW_CONFIG entries have the expected shape", () => {
  for (const r of CGW_CONFIG) {
    assert.match(r.byte, /^[0-9A-F]{4}$/, `byte ${r.byte} must be 4-hex`);
    assert.ok(Number.isInteger(r.bit) && r.bit >= 0, `bit invalid: ${r.bit}`);
    assert.ok(
      Number.isInteger(r.length) && r.length >= 1,
      `length invalid: ${r.length}`,
    );
    assert.equal(typeof r.name, "string");
    assert.ok(r.name.length >= 3, `name too short: ${r.name}`);
    assert.ok(Array.isArray(r.options));
  }
});

test("CGW_CONFIG contains a hand-picked known entry (CGW Central Gateway)", () => {
  const found = CGW_CONFIG.some((r) =>
    r.name.includes("CGW Central Gateway"),
  );
  assert.ok(
    found,
    "expected a CGW_CONFIG entry mentioning 'CGW Central Gateway' (a known clean row from the recovery)",
  );
});

test("CGW_CONFIG pins a stable (byte,bit,length,name) tuple", () => {
  // Pin a row whose bit/byte coordinates are independently verifiable
  // from the source dump. If the recovery heuristics drift this row off,
  // downstream Task #144 (CGW decoder) silently produces wrong byte
  // offsets — the row count alone would not catch that.
  const cgwGateway = CGW_CONFIG.find((r) =>
    r.name === "Cabin Network: CGW Central Gateway",
  );
  assert.ok(cgwGateway, "missing pinned row 'Cabin Network: CGW Central Gateway'");
  assert.equal(cgwGateway.byte, "3B04");
  assert.equal(cgwGateway.bit, 49);
  assert.equal(cgwGateway.length, 1);
  assert.deepEqual(cgwGateway.options, ["0: Not Set", "1: Set"]);
});

test("DIAG_NAMES pins a stable id→name mapping", () => {
  // Pin id 17 → "ABS warning lamp". This came out cleanly across multiple
  // recovery runs and is the canary for whether nfield=14 bucket parsing
  // is still aligned to the source schema.
  assert.equal(DIAG_NAMES[17], "ABS warning lamp");
});

test("Unrecoverable tables are exported as empty stubs with honest meta flags", () => {
  // The DTC plain-English overlay (Task #143) and related features are
  // intentionally blocked until a clean .db is available; these stubs
  // document that explicitly so consumers fail loudly instead of silently.
  assert.deepEqual(FAULTS_BY_HEX, {});
  assert.deepEqual(STATES, {});
  assert.deepEqual(UNITS, {});
  assert.equal(ALFAOBD_META.faultsRecovered, false);
  assert.equal(ALFAOBD_META.statesRecovered, false);
  assert.equal(ALFAOBD_META.unitsRecovered, false);
});
