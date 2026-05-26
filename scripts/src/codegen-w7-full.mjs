#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");
const j = (v) => JSON.stringify(v);

const second = JSON.parse(readFileSync(resolve(ASSETS, "w7-second-layer-disassembly.json"), "utf-8"));
const consts = JSON.parse(readFileSync(resolve(ASSETS, "w7-cipher-constants.json"), "utf-8"));

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/w7-second-layer-disassembly.json
//         attached_assets/alfaobd-package-2026-05-25/w7-cipher-constants.json
//
// FULL W7 cipher dossier from AlfaOBD.exe static IL analysis.
//
// Cipher entry point:    Method[203] w7   (765 bytes IL)
// Cipher initializer:    Method[1140] .cctor (378 bytes IL)
// Dotfuscator decrypt:   Method[26] h    (110 bytes IL — fully disassembled)
//
// Cipher primitives identified:
//   - Method[1101]:h   bignum multiply
//   - Method[1103]:g   bignum divmod (with limb shifts, masks 0x3F = 6-bit)
//   - Method[1104]:b   bignum buffer allocator
//   - Method[1088]:k   bignum XOR-and-carry
//   - Method[1090]:i   bignum ADD-and-carry
//   - Method[1092]:g   bignum AND-and-carry
//   - Method[1097]:k   bignum operation wrapper
//   - Method[1098]:j   bignum trim/right-shift
//   - Method[1107]:d   string->bignum decoder
//   - Method[1301]:l   hex-string->byte-array converter
//
// Static cipher constants (extracted from Method[1140] .cctor):
//   - 7 x 4-byte BigInteger seeds: 0x4E, 0xD4, 0xAE, 0x9F, 7, 0xD8, 0x42
//   - 1 x 6-byte constant: 0x42 (likely a salt for the hash chain)
//   - 2 x 16-byte BigInteger constants: 0x11, 0x0E (likely the cipher's small
//     prime moduli)
//   - 1 x large blob (size 32+ bytes, partial extraction) — likely a sparse
//     bit table for a permutation or S-box.
//
// What's still needed for a working JS implementation:
//   - Decompile Method[1075] a (114B) — the BigInteger.ctor wrapper logic
//   - Resolve MemberRef[316] (the BigInteger.ctor signature — probably
//     System.Numerics.BigInteger or a custom implementation)
//   - Read the field-rva extraction's full bytes for the largest constant
//     (capped at 256 bytes here; the actual data spans tens of KB)
//   - Verify against a known (seed, key) pair from a real ECU bench capture

export const W7_CIPHER_DOSSIER = {
  entryPoint: { method: "Method[203] w7", rva: "0x5FD44", il_size: 765 },
  initializer: { method: "Method[1140] .cctor", il_size: 378 },
  dotfuscatorDecrypt: { method: "Method[26] h", il_size: 110, magic_constant: "0x6DDC67B5" },
};

export const W7_CIPHER_SECOND_LAYER = ${j(second)};

export const W7_CIPHER_CONSTANTS = ${j(consts)};
`;

writeFileSync(resolve(OUT, "w7CipherFull.generated.js"), out);
console.log(`Wrote w7CipherFull.generated.js (${out.length.toLocaleString()} bytes)`);
