#!/usr/bin/env node
// Regenerate artifacts/srt-lab/src/lib/alfaobdDbXorKey.js from the binary key file
// in attached_assets/. The key is base64-encoded into a string constant
// so the module has no fs dependency at runtime (browser-safe).
//
// Usage: node scripts/generate-alfaobd-db-xor-key.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const keyPath = resolve(repoRoot, "attached_assets/alfaobd-db-xor-key.bin");
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/alfaobdDbXorKey.js");

const key = readFileSync(keyPath);
if (key.length !== 1024) {
  throw new Error(`Expected 1024-byte XOR key, got ${key.length}`);
}
const b64 = key.toString("base64");
// Wrap at 76 chars/line for readability
const lines = [];
for (let i = 0; i < b64.length; i += 76) {
  lines.push(`  "${b64.slice(i, i + 76)}",`);
}

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-db-xor-key.bin (1024 bytes).
// Run \`node scripts/generate-alfaobd-db-xor-key.mjs\` to regenerate.
//
// 1024-byte repeating XOR key recovered from the AlfaOBD SQLite catalog DB
// via Kasiski autocorrelation (51x random spike at period 1024) + SQLite
// header/B-tree constraint cracking. The recovered key is ~90-95% correct:
// the first 100 bytes (SQLite header) are guaranteed correct, text data
// throughout the DB decrypts cleanly, but ~5-10% of bytes at hot-variance
// offsets may still need refinement. Numeric integer columns (like the
// fgaipcroutines routine IDs table) are still corrupted by the residual
// errors.
//
// Source: alfaobd-complete-package-with-dbs.zip (received 2026-05-25).

const KEY_BASE64 = [
${lines.join("\n")}
].join("");

/** The 1024-byte XOR key as a Uint8Array. */
export const ALFAOBD_DB_XOR_KEY = new Uint8Array(
  atob(KEY_BASE64)
    .split("")
    .map((c) => c.charCodeAt(0))
);

/** Decrypt an AlfaOBD SQLite .db file by XORing with the 1024-byte repeating key. */
export function decryptAlfaobdDb(ciphertext) {
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    out[i] = ciphertext[i] ^ ALFAOBD_DB_XOR_KEY[i % 1024];
  }
  return out;
}

export const ALFAOBD_DB_XOR_KEY_META = {
  byteLength: 1024,
  recoveryMethod: "Kasiski autocorrelation + SQLite-page structural constraints",
  accuracy: "~90-95% (first 100 bytes guaranteed; text data clean; numeric ints partially corrupted)",
  validatedAgainst: "alfaobd_encrypted_may3.db (68224000 bytes = 66625 * 1024 pages)",
  source: "attached_assets/alfaobd-db-xor-key.bin",
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
