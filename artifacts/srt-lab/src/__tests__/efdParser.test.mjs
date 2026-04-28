// Pure-lib tests for the EFD/.webm container parser (Task #488).
// Run: node --test artifacts/srt-lab/src/__tests__/efdParser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseEFD, isEbmlBuffer, shannonEntropy, EBML_MAGIC } from "../lib/efdParser.js";

// Build a minimal EBML container: EBML magic header element followed by
// a DS plaintext-metadata element and a UP encrypted-payload element.
// Section IDs are encoded as variable-length integers per EBML spec.
function vintEncode(value) {
  // For our tiny lengths we always emit the 1-byte form (0x80 | size).
  if (value < 0x80) return [0x80 | value];
  if (value < 0x4000) return [0x40 | (value >> 8), value & 0xFF];
  if (value < 0x200000) return [0x20 | (value >> 16), (value >> 8) & 0xFF, value & 0xFF];
  throw new Error("vintEncode size too big for tiny test");
}

function buildEfd({ withDs = true, withUp = true, payloadSize = 256 } = {}) {
  const parts = [];
  // Top-level EBML element: id 0x1A 0x45 0xDF 0xA3, size = 0 (vint 0x80).
  parts.push([0x1A, 0x45, 0xDF, 0xA3, 0x80]);

  if (withDs) {
    // DS section id: 0x20 0x44 0x53 (decoded id "204453" matches parser).
    const meta = "Engine=6.2L Hellcat\nProgram=PowerCal-2024\nModelYear=2023\nBody=Charger\n";
    const metaBytes = new TextEncoder().encode(meta);
    parts.push([0x20, 0x44, 0x53, ...vintEncode(metaBytes.length), ...metaBytes]);
  }

  if (withUp) {
    // UP section id: 0x20 0x55 0x50.
    const payload = new Uint8Array(payloadSize);
    for (let i = 0; i < payloadSize; i++) payload[i] = i & 0xFF;
    parts.push([0x20, 0x55, 0x50, ...vintEncode(payloadSize), ...payload]);
  }

  const flat = parts.flat();
  return new Uint8Array(flat);
}

test("isEbmlBuffer accepts buffers with the EBML magic prefix", () => {
  const ok = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0xFF]);
  const bad = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xFF]);
  const tiny = new Uint8Array([0x1A, 0x45]);
  assert.equal(isEbmlBuffer(ok), true);
  assert.equal(isEbmlBuffer(bad), false);
  assert.equal(isEbmlBuffer(tiny), false);
  assert.equal(EBML_MAGIC[0], 0x1A);
});

test("parseEFD rejects too-small buffers", () => {
  const r = parseEFD(new Uint8Array(2), "x");
  assert.equal(r.valid, false);
  assert.match(r.error, /Too small/);
});

test("parseEFD rejects non-EBML buffers", () => {
  const r = parseEFD(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]), "x.bin");
  assert.equal(r.valid, false);
  assert.match(r.error, /EBML/);
});

test("parseEFD parses DS metadata and UP payload from a minimal EBML container", () => {
  const buf = buildEfd();
  const r = parseEFD(buf, "test.webm");
  assert.equal(r.valid, true);
  assert.ok(r.sections.length >= 2, `got ${r.sections.length} sections`);
  assert.equal(r.metadata.Engine, "6.2L Hellcat");
  assert.equal(r.metadata.Program, "PowerCal-2024");
  assert.equal(r.metadata.ModelYear, "2023");
  assert.equal(r.efdType, "mopar_powercal");
  assert.ok(r.payload, "expected payload section");
  assert.equal(r.payload.size, 256);
  assert.ok(r.payload.entropy >= 7.0 && r.payload.entropy <= 8.0,
    `payload entropy ${r.payload.entropy} should be near uniform`);
});

test("parseEFD without DS still returns a valid container with no metadata", () => {
  const buf = buildEfd({ withDs: false });
  const r = parseEFD(buf, "no-ds.webm");
  assert.equal(r.valid, true);
  assert.deepEqual(r.metadata, {});
  assert.notEqual(r.efdType, "mopar_powercal");
});

test("shannonEntropy reports near zero for constant data and near 8 for random data", () => {
  const flat = new Uint8Array(1024);
  assert.ok(shannonEntropy(flat) < 0.01);
  const random = new Uint8Array(1024);
  for (let i = 0; i < random.length; i++) random[i] = i & 0xFF;
  assert.ok(shannonEntropy(random) > 7.5);
});
