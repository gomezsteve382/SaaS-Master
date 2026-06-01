/**
 * checksumScanner.test.mjs
 *
 * Unit tests for src/lib/checksumScanner.js using real module dump fixtures.
 *
 * Tests verify:
 *   1. scanChecksums — finds valid sum8 at 0xfffa in BCM fixture
 *   2. scanChecksums — surfaces BROKEN entry at structural position after edit
 *   3. fixChecksum   — repair round-trip: corrupted → broken surfaced → repaired → valid
 *   4. eepmapAnalyze — finds known VIN candidates in BCM and GPEC2A fixtures
 *
 * Run: node --test artifacts/srt-lab/src/__tests__/checksumScanner.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { scanChecksums, fixChecksum, eepmapAnalyze, crc32 } from "../lib/checksumScanner.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fix = (name) => new Uint8Array(readFileSync(join(__dir, "fixtures", name)));

const BCM_18TH = fix("SAMPLE_BCM_DFLASH_18TH_OG.bin");        // 64 KB BCM D-Flash
const GPEC2A   = fix("SAMPLE_GPEC2A_EXT_EEPROM_18TH_OG.bin"); // 8 KB GPEC2A EEPROM

// ---------------------------------------------------------------------------
// 1. scanChecksums — algorithm detection on unedited fixture
// ---------------------------------------------------------------------------

test("scanChecksums: finds sum8 at 0xfffa in BCM fixture", () => {
  const results = scanChecksums(BCM_18TH);
  assert.ok(results.length > 0, "should find at least one checksum");

  const hit = results.find((r) => r.algorithm === "sum8" && r.offset === "0xfffa");
  assert.ok(hit, "must find sum8 at 0xfffa");
  assert.equal(hit.status, "valid");
  assert.equal(hit.stored, "ff");
  assert.equal(hit.computed, "ff");
  assert.match(hit.covers, /^0x0/);
});

test("scanChecksums: valid entries match stored/computed; broken entries show mismatched values", () => {
  const results = scanChecksums(BCM_18TH);
  for (const r of results) {
    assert.ok(r.status === "valid" || r.status === "broken",
      `entry at ${r.offset} (${r.algorithm}) must have status valid or broken`);
    if (r.status === "valid") {
      assert.equal(r.stored, r.computed,
        `valid entry at ${r.offset} must have stored === computed`);
      assert.notEqual(r.stored, "0".repeat(r.stored.length),
        `valid entry at ${r.offset} stored must not be all-zeros`);
    } else {
      assert.notEqual(r.stored, r.computed,
        `broken entry at ${r.offset} must have stored !== computed`);
      const computedBytes = Buffer.from(r.computed, "hex");
      assert.ok([...computedBytes].some(b => b !== 0),
        `broken entry at ${r.offset} computed must be non-trivial`);
    }
  }
});

test("scanChecksums: returns empty array for all-zero file (no meaningful checksums)", () => {
  const zeros = new Uint8Array(256);
  const results = scanChecksums(zeros);
  assert.deepEqual(results, []);
});

test("crc32: BCM whole-file CRC32 matches python binascii.crc32 ground truth (0x48a7da78)", () => {
  const v = crc32(BCM_18TH, BCM_18TH.length);
  assert.equal("0x" + v.toString(16), "0x48a7da78");
});

// ---------------------------------------------------------------------------
// 2. scanChecksums — broken entry surfaced after deliberate corruption
//
// This is the core use-case: user edits a VIN in a dump, breaking a checksum.
// The structural-probe logic must surface the now-broken field so the user
// can see it in the UI and click Repair.
// ---------------------------------------------------------------------------

test("scanChecksums: corrupted checksum at 0xfffa appears as status=broken (structural probe)", () => {
  const corrupted = new Uint8Array(BCM_18TH);
  corrupted[0xfffa] = 0x00; // deliberately invalidate the sum8 checksum

  const results = scanChecksums(corrupted);
  const brokenHit = results.find((r) => r.offset === "0xfffa" && r.algorithm === "sum8");

  assert.ok(brokenHit,
    "structural probe must surface the broken sum8 at 0xfffa so the Repair button is reachable");
  assert.equal(brokenHit.status, "broken",
    "status must be 'broken' so the UI shows ✗ BROKEN and the Repair button");
  assert.equal(brokenHit.computed, "ff",
    "computed must show the correct value that Repair will write");
  assert.equal(brokenHit.stored, "00",
    "stored must show the currently-wrong value in the file");
});

// ---------------------------------------------------------------------------
// 3. fixChecksum — full repair round-trip
// ---------------------------------------------------------------------------

test("fixChecksum: repairing corrupted sum8 at 0xfffa produces a clean rescan", () => {
  const corrupted = new Uint8Array(BCM_18TH);
  corrupted[0xfffa] = 0x00;

  // Repair
  const repaired = fixChecksum(corrupted, "0xfffa", "sum8");
  assert.equal(repaired[0xfffa], 0xFF, "repaired byte must be 0xFF (sum of prefix mod 256)");
  assert.equal(repaired.length, BCM_18TH.length, "patched file must be same length");

  // After repair: rescan must find the entry as valid (broken entry gone)
  const after = scanChecksums(repaired);
  const repairedHit = after.find((r) => r.offset === "0xfffa" && r.algorithm === "sum8");
  assert.ok(repairedHit, "repaired file must re-scan as valid at 0xfffa");
  assert.equal(repairedHit.status, "valid");
});

test("fixChecksum: numeric offset and hex-string offset produce identical results", () => {
  const r1 = fixChecksum(BCM_18TH, 0xfffa, "sum8");
  const r2 = fixChecksum(BCM_18TH, "0xfffa", "sum8");
  assert.deepEqual(r1, r2);
});

test("fixChecksum: throws on unknown algorithm", () => {
  assert.throws(
    () => fixChecksum(BCM_18TH, "0x100", "md5_proprietary"),
    /unknown algorithm/i,
  );
});

test("fixChecksum: patched file length matches original", () => {
  const patched = fixChecksum(BCM_18TH, "0xfffa", "sum8");
  assert.equal(patched.length, BCM_18TH.length);
});

// ---------------------------------------------------------------------------
// 4. eepmapAnalyze — VIN and structure discovery
// ---------------------------------------------------------------------------

test("eepmapAnalyze: finds VIN 1C4RJFN9XJC309165 at 0x1320 in BCM 18th-gen fixture", () => {
  const { vinCandidates } = eepmapAnalyze(BCM_18TH);
  assert.ok(vinCandidates.length > 0, "must find at least one VIN candidate");
  const vin = vinCandidates.find((v) => v.vin === "1C4RJFN9XJC309165");
  assert.ok(vin, "must find VIN 1C4RJFN9XJC309165");
  assert.equal(vin.offset, "0x1320");
});

test("eepmapAnalyze: finds VIN 1C4RJFDJ7DC513874 in GPEC2A EEPROM fixture", () => {
  const { vinCandidates } = eepmapAnalyze(GPEC2A);
  const vin = vinCandidates.find((v) => v.vin === "1C4RJFDJ7DC513874");
  assert.ok(vin, "GPEC2A fixture must contain VIN 1C4RJFDJ7DC513874");
});

test("eepmapAnalyze: finds mirrored 16-byte blocks (SEC16 redundancy) in BCM fixture", () => {
  const { mirroredBlocks } = eepmapAnalyze(BCM_18TH);
  assert.ok(mirroredBlocks.length > 0, "BCM must have mirrored blocks");
  for (const m of mirroredBlocks) {
    assert.match(m.first_offset, /^0x/);
    assert.match(m.mirror_offset, /^0x/);
    assert.equal(m.hex.length, 32, "16 bytes → 32 hex chars");
  }
});

test("eepmapAnalyze: returns empty vinCandidates for an all-zero file", () => {
  const { vinCandidates } = eepmapAnalyze(new Uint8Array(256));
  assert.deepEqual(vinCandidates, []);
});
