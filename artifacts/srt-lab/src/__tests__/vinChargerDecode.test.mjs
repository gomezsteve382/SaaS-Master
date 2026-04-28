// Charger SRT VIN decoder tests (Task #488).
// Run: node --test artifacts/srt-lab/src/__tests__/vinChargerDecode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decodeChargerVin, parseVinYear } from "../lib/vin.js";

// Helper: build a 17-char VIN with a given engine code (pos 7) and trim
// byte (pos 8) and model-year code (pos 10). Check digit (pos 9) is left
// as '0' since decodeChargerVin doesn't validate it.
function buildVin({ engine = "L", trim = "5", year = "K" } = {}) {
  // Positions:           1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17
  // Charger SRT prefix:  2 C 3 C D X
  // 7=engine, 8=trim, 9=check, 10=year, 11=plant, 12-17=serial
  const v = "2C3CDX" + engine + trim + "0" + year + "H123456";
  assert.equal(v.length, 17, `built VIN must be 17 chars, got "${v}"`);
  return v;
}

test("decodeChargerVin returns null for non-Charger VINs", () => {
  assert.equal(decodeChargerVin("1C4HJXEN5MW123456"), null);
  assert.equal(decodeChargerVin(""), null);
  assert.equal(decodeChargerVin(null), null);
  assert.equal(decodeChargerVin("2C3CDX"), null);
});

test("decodeChargerVin recognises the 2022 Hellcat Redeye Jailbreak (engine L, trim 9)", () => {
  // Year code 'N' = 2022 in YR table.
  const v = buildVin({ engine: "L", trim: "9", year: "N" });
  const r = decodeChargerVin(v);
  assert.ok(r);
  assert.match(r.trim, /Jailbreak/);
  assert.equal(r.engine, "L");
  assert.equal(r.year, 2022);
  assert.equal(r.family, "Charger LD");
});

test("decodeChargerVin handles 2018+ Hellcat Redeye trim 5", () => {
  // 'J' = 2018
  const v = buildVin({ engine: "L", trim: "5", year: "J" });
  const r = decodeChargerVin(v);
  assert.ok(r);
  assert.match(r.trim, /Hellcat Redeye/);
  assert.match(r.hp, /797 HP/);
});

test("decodeChargerVin handles base SRT Hellcat (trim 0) HP bump in 2021+", () => {
  const oldVin = buildVin({ engine: "L", trim: "0", year: "J" }); // 2018
  const newVin = buildVin({ engine: "L", trim: "0", year: "M" }); // 2021
  const oldR = decodeChargerVin(oldVin);
  const newR = decodeChargerVin(newVin);
  assert.ok(oldR);
  assert.ok(newR);
  assert.match(oldR.hp, /707 HP/);
  assert.match(newR.hp, /717 HP/);
});

test("decodeChargerVin recognises non-Hellcat trims by engine code", () => {
  const t392 = decodeChargerVin(buildVin({ engine: "T", trim: "0", year: "J" }));
  const rt    = decodeChargerVin(buildVin({ engine: "G", trim: "0", year: "J" }));
  const sp    = decodeChargerVin(buildVin({ engine: "H", trim: "0", year: "J" }));
  assert.match(t392.trim, /392|Scat Pack/);
  assert.match(rt.trim,   /R\/T/);
  assert.match(sp.trim,   /Scat Pack/);
  assert.equal(t392.family, "Charger LD");
});

test("decodeChargerVin returns null when engine code is unknown", () => {
  const r = decodeChargerVin(buildVin({ engine: "Z", trim: "0", year: "J" }));
  assert.equal(r, null);
});

test("decodeChargerVin agrees with parseVinYear for the year field", () => {
  const v = buildVin({ engine: "L", trim: "5", year: "K" }); // K = 2019
  const r = decodeChargerVin(v);
  assert.equal(r.year, parseVinYear(v));
  assert.equal(r.year, 2019);
});
