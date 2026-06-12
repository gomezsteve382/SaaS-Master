#!/usr/bin/env node
// Extract the payload (and metadata) from a GM PowerCal .efd file.
// The .efd is an EBML container (DocType "efd") with these elements:
//   " FS" (0x204653) FileSignature  - RSA signature bytes
//   " DS" (0x204453) Description    - "Engine = ...", "Program = ...", etc.
//   "CO"  (0x434F)   Comment        - free-form note
//   " UP" (0x205550) UpdatePayload  - the raw flash .bin
//
// EBML VINT decoding: the first byte's leading-zero count tells you the
// width; the value is the remaining bits of byte 1 plus the following bytes.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function readVint(buf, off, keepMarker = false) {
  const first = buf[off];
  if (first === 0) throw new Error(`bad VINT at ${off}`);
  let width = 1;
  let mask = 0x80;
  while ((first & mask) === 0) { width++; mask >>= 1; }
  let value = keepMarker ? first : (first & (mask - 1));
  for (let i = 1; i < width; i++) value = value * 256 + buf[off + i];
  return { value, width };
}

const inPath = process.argv[2];
if (!inPath) { console.error("usage: node efd-extract.mjs <file.efd>"); process.exit(1); }

const buf = readFileSync(inPath);
const stem = basename(inPath).replace(/\.efd$/i, "");
const outDir = dirname(inPath);

let off = 0;
const root = readVint(buf, off, true);          // EBML header ID (4-byte)
off += root.width;
const hdrLen = readVint(buf, off);
off += hdrLen.width;
off += hdrLen.value;                              // skip EBML header body

const names = {
  0x204653: "FileSignature",
  0x204453: "Description",
  0x434F:   "Comment",
  0x205550: "UpdatePayload",
};

while (off < buf.length) {
  const id = readVint(buf, off, true);  off += id.width;
  const sz = readVint(buf, off);        off += sz.width;
  const data = buf.subarray(off, off + sz.value);
  const name = names[id.value] ?? `0x${id.value.toString(16)}`;
  console.log(`${name.padEnd(15)} id=0x${id.value.toString(16)}  size=${sz.value}`);

  if (name === "UpdatePayload") {
    const out = join(outDir, `${stem}.bin`);
    writeFileSync(out, data);
    console.log(`  -> wrote ${out}`);
  } else if (name === "Description" || name === "Comment") {
    const out = join(outDir, `${stem}.${name}.txt`);
    writeFileSync(out, data);
    console.log(`  -> wrote ${out}`);
  } else if (name === "FileSignature") {
    const out = join(outDir, `${stem}.signature.bin`);
    writeFileSync(out, data);
    console.log(`  -> wrote ${out} (${data.length} bytes raw RSA signature)`);
  }
  off += sz.value;
}
