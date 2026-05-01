/**
 * Unit tests for `src/peFingerprint.mjs`.
 *
 * The fingerprinter decides whether a binary is "actually .NET" (COR20
 * directory present, BSJB metadata parsable) and reports per-section
 * Shannon entropy — both inputs feed the AlfaOBD extractor's manifest
 * directly. A regression here would silently corrupt the manifest.
 *
 * Strategy:
 *   - Build tiny synthetic PE32 / PE32+ payloads in-memory and assert
 *     the parser's view of machine, sections, entropy bounds, and the
 *     presence/absence of the COR20 directory. These tests always run.
 *   - Additionally, when `attached_assets/AlfaOBD.exe` is present
 *     (user-supplied; never committed) fingerprint it and sanity-check
 *     the result. Mirrors the skip-cleanly pattern in schema.test.mjs
 *     so contributors without the binary still get a green run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprintPE, dotnetMetadata } from "../src/peFingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ATTACHED = join(REPO_ROOT, "attached_assets");

/* ── Synthetic PE builder ────────────────────────────────────────── */
const FILE_HDR_SIZE = 20;
const SECT_HDR_SIZE = 40;
const NUM_DATA_DIRS = 16;
const PE_SIG_OFFSET = 128; // arbitrary, 4-byte aligned, leaves room for DOS stub
const COR20_DIR_INDEX = 14;

function buildPE({
  machine = 0x014c,
  isPE32Plus = false,
  sections = [],
  cor20 = null,
  timestamp = 0x60000000,
} = {}) {
  const optHdrSize = isPE32Plus ? 240 : 224;
  const dataDirsOffset = isPE32Plus ? 112 : 96; // from start of opt hdr
  const sectTableOffset = PE_SIG_OFFSET + 4 + FILE_HDR_SIZE + optHdrSize;
  const numSect = sections.length;

  // Place each section's raw data back-to-back after the section table.
  const layout = [];
  let cursor = sectTableOffset + numSect * SECT_HDR_SIZE;
  for (const s of sections) {
    layout.push({ ...s, rawPointer: cursor });
    cursor += s.raw.length;
  }

  const buf = new Uint8Array(cursor);
  const dv = new DataView(buf.buffer);

  // DOS header: 'MZ' + e_lfanew at 0x3C.
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  dv.setUint32(0x3c, PE_SIG_OFFSET, true);

  // PE signature: 'P','E',0,0.
  buf[PE_SIG_OFFSET] = 0x50;
  buf[PE_SIG_OFFSET + 1] = 0x45;

  // File header.
  const fhOff = PE_SIG_OFFSET + 4;
  dv.setUint16(fhOff + 0, machine, true);
  dv.setUint16(fhOff + 2, numSect, true);
  dv.setUint32(fhOff + 4, timestamp, true);
  dv.setUint16(fhOff + 16, optHdrSize, true);

  // Optional header.
  const optHdrOffset = fhOff + FILE_HDR_SIZE;
  dv.setUint16(optHdrOffset, isPE32Plus ? 0x020b : 0x010b, true);
  // NumberOfRvaAndSizes lives 4 bytes before the data directories.
  dv.setUint32(optHdrOffset + dataDirsOffset - 4, NUM_DATA_DIRS, true);
  if (cor20) {
    const corOff = optHdrOffset + dataDirsOffset + COR20_DIR_INDEX * 8;
    dv.setUint32(corOff + 0, cor20.rva, true);
    dv.setUint32(corOff + 4, cor20.size, true);
  }

  // Section headers.
  for (let i = 0; i < numSect; i++) {
    const s = layout[i];
    const o = sectTableOffset + i * SECT_HDR_SIZE;
    const name = s.name.slice(0, 8);
    for (let j = 0; j < name.length; j++) buf[o + j] = name.charCodeAt(j);
    dv.setUint32(o + 8, s.virtualSize ?? s.raw.length, true);
    dv.setUint32(o + 12, s.virtualAddress, true);
    dv.setUint32(o + 16, s.raw.length, true);
    dv.setUint32(o + 20, s.rawPointer, true);
    dv.setUint32(o + 36, s.characteristics ?? 0x40000040, true);
  }

  // Section data.
  for (const s of layout) buf.set(s.raw, s.rawPointer);

  return buf;
}

/**
 * Build a section payload that contains a COR20 header at offset 0 and a
 * BSJB metadata blob at offset 80, matching what `parseCor20` expects.
 */
function buildDotNetSection({
  name = ".text",
  virtualAddress = 0x1000,
  runtimeVersion = "v4.0.30319",
  streamNames = ["#~", "#Strings", "#US", "#GUID", "#Blob"],
} = {}) {
  const verPadded = Math.ceil((runtimeVersion.length + 1) / 4) * 4;
  let streamsBlobSize = 4; // flags(2) + numStreams(2)
  for (const n of streamNames) {
    streamsBlobSize += 8 + Math.ceil((n.length + 1) / 4) * 4;
  }
  const metaSize = 16 + verPadded + streamsBlobSize;
  const metaOff = 80; // leave the first 72 bytes for the COR20 header
  const total = metaOff + metaSize;

  const data = new Uint8Array(total);
  const dv = new DataView(data.buffer);

  // COR20 header.
  dv.setUint32(0, 72, true);                       // cb
  dv.setUint16(4, 2, true);                        // major runtime ver
  dv.setUint16(6, 5, true);                        // minor runtime ver
  dv.setUint32(8, virtualAddress + metaOff, true); // metadata RVA
  dv.setUint32(12, metaSize, true);                // metadata size

  // BSJB metadata blob.
  let p = metaOff;
  dv.setUint32(p + 0, 0x424a5342, true); // 'BSJB'
  dv.setUint16(p + 4, 1, true);          // major
  dv.setUint16(p + 6, 1, true);          // minor
  dv.setUint32(p + 8, 0, true);          // reserved
  dv.setUint32(p + 12, verPadded, true); // verLen (includes pad)
  for (let i = 0; i < runtimeVersion.length; i++) {
    data[p + 16 + i] = runtimeVersion.charCodeAt(i);
  }
  p += 16 + verPadded;

  // flags + numStreams.
  dv.setUint16(p + 0, 0, true);
  dv.setUint16(p + 2, streamNames.length, true);
  p += 4;
  for (const n of streamNames) {
    // 8-byte stream header (offset+size); content unused by the parser.
    p += 8;
    for (let i = 0; i < n.length; i++) data[p + i] = n.charCodeAt(i);
    p += Math.ceil((n.length + 1) / 4) * 4;
  }

  return {
    name,
    virtualAddress,
    raw: data,
    cor20Dir: { rva: virtualAddress, size: 72 },
  };
}

/* ── Tests: synthetic payloads ───────────────────────────────────── */

test("PE32 i386 with two plain sections and no COR20", () => {
  const textRaw = new Uint8Array(64); // all zeros → entropy 0
  const dataRaw = new Uint8Array(256);
  for (let i = 0; i < 256; i++) dataRaw[i] = i; // uniform → entropy = 8

  const buf = buildPE({
    machine: 0x014c,
    sections: [
      { name: ".text", virtualAddress: 0x1000, raw: textRaw },
      { name: ".data", virtualAddress: 0x2000, raw: dataRaw },
    ],
  });

  const info = fingerprintPE(buf);
  assert.equal(info.machine, "I386");
  assert.equal(info.machine_id, 0x014c);
  assert.equal(info.pe32_plus, false);
  assert.equal(typeof info.pe_timestamp, "string");
  assert.match(info.pe_timestamp, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(info.sections.length, 2);
  assert.deepEqual(info.sections.map(s => s.name), [".text", ".data"]);
  assert.equal(info.sections[0].virtual_address, "0x00001000");
  assert.equal(info.sections[1].virtual_address, "0x00002000");
  assert.equal(info.sections[0].raw_size, 64);
  assert.equal(info.sections[1].raw_size, 256);

  // Entropy bounds: every section must be in [0, 8].
  for (const s of info.sections) {
    assert.ok(s.entropy >= 0 && s.entropy <= 8, `entropy out of range: ${s.entropy}`);
  }
  // All-zero section ⇒ exactly zero.
  assert.equal(info.sections[0].entropy, 0);
  // Uniform byte distribution ⇒ ~8.0 (log2(256)).
  assert.ok(info.sections[1].entropy >= 7.99,
    `expected uniform section entropy ≈ 8, got ${info.sections[1].entropy}`);

  // No COR20 directory → null, and dotnetMetadata reports not-dotnet.
  assert.equal(info.cor20, null);
  assert.deepEqual(dotnetMetadata(info), { is_dotnet: false });
  assert.equal(info.has_resource_dir, false);
  assert.deepEqual(info.imports, []);
  assert.deepEqual(info.exports, []);
});

test("PE32+ amd64 buffer is parsed as 64-bit", () => {
  const buf = buildPE({
    machine: 0x8664,
    isPE32Plus: true,
    sections: [
      { name: ".text", virtualAddress: 0x1000, raw: new Uint8Array(32) },
    ],
  });

  const info = fingerprintPE(buf);
  assert.equal(info.machine, "AMD64");
  assert.equal(info.machine_id, 0x8664);
  assert.equal(info.pe32_plus, true);
  assert.equal(info.sections.length, 1);
  assert.equal(info.sections[0].name, ".text");
  assert.equal(info.cor20, null);
});

test("COR20 directory + BSJB metadata is recognized as managed (.NET)", () => {
  // Names whose (length+1) rounds up to a 4-byte boundary by adding pad bytes.
  // The current parser's alignment loop relies on the null + padding pushing
  // the cursor across a 4-byte boundary, so we avoid name lengths that are
  // exact multiples of 4 (e.g. "#Strings") here.
  const streamNames = ["#~", "#US", "#GUID", "#Blob"];
  const sect = buildDotNetSection({
    runtimeVersion: "v4.0.30319",
    streamNames,
  });
  const buf = buildPE({
    machine: 0x014c,
    sections: [{ name: sect.name, virtualAddress: sect.virtualAddress, raw: sect.raw }],
    cor20: sect.cor20Dir,
  });

  const info = fingerprintPE(buf);
  assert.notEqual(info.cor20, null, "expected COR20 to be parsed");
  assert.equal(info.cor20.runtime_version, "v4.0.30319");
  assert.deepEqual(info.cor20.streams, streamNames);

  const meta = dotnetMetadata(info);
  assert.equal(meta.is_dotnet, true);
  assert.equal(meta.clr_version, "v4.0.30319");
  assert.deepEqual(meta.metadata_streams, streamNames);
});

test("error paths: tiny buffer, missing MZ, missing PE signature", () => {
  // Too small for the DOS header.
  assert.throws(() => fingerprintPE(new Uint8Array(8)), /buffer too small/i);

  // 64-byte buffer without 'MZ'.
  const noMz = new Uint8Array(64);
  assert.throws(() => fingerprintPE(noMz), /missing 'MZ'/);

  // Has 'MZ' and a sane e_lfanew, but the 4 bytes there are not 'PE\0\0'.
  const noPe = new Uint8Array(256);
  noPe[0] = 0x4d; noPe[1] = 0x5a;
  new DataView(noPe.buffer).setUint32(0x3c, 128, true);
  assert.throws(() => fingerprintPE(noPe), /missing 'PE/);
});

/* ── Test: real fixture (skip-cleanly when absent) ───────────────── */

test("real AlfaOBD.exe (when present) is recognized as managed", (t) => {
  const path = join(ATTACHED, "AlfaOBD.exe");
  if (!existsSync(path)) {
    t.skip(`no ${path} — drop the binary in attached_assets/ to exercise this case`);
    return;
  }
  const info = fingerprintPE(readFileSync(path));
  assert.ok(info.machine === "I386" || info.machine === "AMD64",
    `unexpected machine ${info.machine}`);
  assert.ok(info.sections.length > 0, "expected at least one section");
  for (const s of info.sections) {
    assert.ok(s.entropy >= 0 && s.entropy <= 8,
      `section ${s.name} entropy out of range: ${s.entropy}`);
  }
  assert.notEqual(info.cor20, null, "AlfaOBD.exe should be a managed .NET binary");
  assert.equal(dotnetMetadata(info).is_dotnet, true);
});

test("real shfolder(1).dll (when present) is fingerprinted without COR20", (t) => {
  const path = join(ATTACHED, "shfolder(1).dll");
  if (!existsSync(path)) {
    t.skip(`no ${path} — drop the DLL in attached_assets/ to exercise this case`);
    return;
  }
  const info = fingerprintPE(readFileSync(path));
  assert.ok(info.sections.length > 0);
  for (const s of info.sections) {
    assert.ok(s.entropy >= 0 && s.entropy <= 8,
      `section ${s.name} entropy out of range: ${s.entropy}`);
  }
  // shfolder(1).dll is unmanaged native code — no COR20 directory.
  assert.equal(info.cor20, null, "shfolder(1).dll should not be a managed binary");
  assert.equal(dotnetMetadata(info).is_dotnet, false);
});
