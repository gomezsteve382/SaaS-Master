#!/usr/bin/env node
// Decrypt an AlfaOBD encrypted SQLite catalog (.db) using the recovered
// 1024-byte XOR key in attached_assets/alfaobd-db-xor-key.bin.
//
// Usage: node scripts/decrypt-alfaobd-db.mjs <encrypted.db> <output.db>
//
// Once decrypted, the output may have ~5-10% byte corruption in
// integer-keyed table pages. Try `sqlite3 <output.db> .recover` for the
// best chance at extracting the fgaipcroutines table. Text data
// (Diag_names, Faults code strings) decrypts cleanly.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const keyPath = resolve(repoRoot, "attached_assets/alfaobd-db-xor-key.bin");

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("Usage: node scripts/decrypt-alfaobd-db.mjs <encrypted.db> <output.db>");
  process.exit(1);
}
const [inPath, outPath] = args;

const key = readFileSync(keyPath);
if (key.length !== 1024) {
  console.error(`Expected 1024-byte XOR key, got ${key.length}`);
  process.exit(1);
}

const ciphertext = readFileSync(inPath);
const plaintext = Buffer.alloc(ciphertext.length);
for (let i = 0; i < ciphertext.length; i++) {
  plaintext[i] = ciphertext[i] ^ key[i % 1024];
}
writeFileSync(outPath, plaintext);

console.log(
  `Decrypted ${ciphertext.length.toLocaleString()} bytes -> ${outPath}`,
);
console.log("");
console.log("Verify SQLite header (first 16 bytes should read 'SQLite format 3\\0'):");
console.log(`  ${plaintext.subarray(0, 16).toString("latin1").replace(/\0/g, "\\0")}`);
console.log("");
console.log("Next steps:");
console.log("  1. sqlite3 <output.db> .schema     # inspect schema");
console.log("  2. sqlite3 <output.db> .recover    # corruption-tolerant dump");
console.log("  3. .dump fgaipcroutines            # routine ID table (if recoverable)");
