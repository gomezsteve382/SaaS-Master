#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/inline-cipher-wrappers-constants.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/inlineCipherWrappers.generated.js");
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/inline-cipher-wrappers-constants.json
//
// Inline cipher wrappers extracted from AlfaOBD.exe's abf() dispatcher.
// These are cipher methods named like 'f2', 'jn', 'il' etc. that are CALLED
// by abf for specific ECU codes but are NOT in the W6/W7 catalog. Each is
// a small (66-600 byte) inline cipher with its own constants.
//
// For each, this file records:
//   - The method index + RVA in AlfaOBD.exe for further decompilation
//   - The arithmetic operations observed in IL (add/mul/xor/and/or/shl/shr)
//   - The non-trivial numeric constants used (filtered: excluded 0, 1, 8,
//     16, 24, 32, 255, 0xFFFF, 0xFFFFFFFF which are common bit masks)
//
// NOTABLE FINDINGS:
//   - 'jn' uses 0x41C64E6D (glibc rand() multiplier) - it's an LCG cipher
//   - 'j3', 'j4', 'j6', 'j7' all share constants 0x25010000 and 0x537E -
//     same cipher family with different level routing
//   - 'jp' uses 64-bit constant 0x1102041108000001 - bitfield permutation
//   - 'il', 'im', 'in', 'w2' use 16-bit XOR masks (0xCA59, 0x781C, 0x7000,
//     0xA59B respectively)
//
// To implement each in JS: decompile the IL at the recorded RVA to
// pseudo-C# via dnSpy/ILSpy, then transcribe the algorithm. The constants
// here serve as a quick check that the decompilation matches reality.

export const INLINE_CIPHER_WRAPPERS_META = {
  totalAnalyzed: ${Object.keys(src).length},
  trulyInlineCiphers: ${Object.values(src).filter((v) => v.is_inline_cipher).length},
  note: "Each entry has the method_idx + RVA where the cipher IL lives, plus the constants and arithmetic ops observed. Use as a starting point for full decompilation.",
};

/** Per-wrapper cipher metadata: method index, RVA, IL size, constants, ops. */
export const INLINE_CIPHER_WRAPPERS = ${j(src)};

/** Notable findings — wrappers with identifiable cipher structures. */
export const NOTABLE_INLINE_CIPHERS = {
  jn_LCG: {
    method_idx: ${src.jn?.method_idx || "null"},
    rva: ${j(src.jn?.rva)},
    cipher_type: "Linear Congruential Generator (LCG)",
    multiplier: "0x41C64E6D (glibc rand() multiplier)",
    increment: "0x3039 (12345 = glibc rand() increment)",
    state_bias: "0x33F6D311",
    js_template: "key = (((seed * 0x41C64E6D) + 0x3039) ^ 0x33F6D311) & 0xFFFFFFFF",
  },
  j3_family: {
    members: ["j3", "j4", "j6", "j7"],
    shared_constants: ["0x25010000", "0x537E"],
    cipher_type: "Bit-shuffle with XOR mask",
  },
  il_xor16: { constant: "0xCA59", method_idx: ${src.il?.method_idx || "null"} },
  im_xor16: { constant: "0x781C", method_idx: ${src.im?.method_idx || "null"} },
  in_xor16: { constant: "0x7000", method_idx: ${src["in"]?.method_idx || "null"} },
  w2_xor16: { constant: "0xA59B", method_idx: ${src.w2?.method_idx || "null"} },
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
