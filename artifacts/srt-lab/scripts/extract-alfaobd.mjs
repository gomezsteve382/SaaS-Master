#!/usr/bin/env node
/**
 * extract-alfaobd.mjs
 *
 * Extracts a small, English-only slice of the AlfaOBD reverse-engineered
 * SQLite database into src/lib/alfaobdData.generated.js for the React
 * bundle. The source `.db` is the XOR-decrypted dump from AlfaOBD.exe.
 *
 * IMPORTANT — DATA CORRUPTION:
 * The source `.db` is partially corrupted. The README that shipped with
 * the XOR key warned of ~5–10% byte errors; in practice the entire
 * sqlite_master B-tree is unreadable, so even listing tables fails.
 * We work around this by running `sqlite3 .recover` (the recovery
 * tool dumps every record it can find into a flat `lost_and_found`
 * table) and then bucketing rows by their original column count.
 *
 * Tables we CAN extract cleanly:
 *   - Diag_names      → DIAG_NAMES        (param-id → English label)
 *   - CGW config 50f  → CGW_CONFIG (slice) (byte/bit feature matrix)
 *   - CGW config 90f  → CGW_CONFIG (slice)
 *   - CGW config 31f  → CGW_CONFIG (slice)
 *
 * Tables we CANNOT extract (text columns are mojibake from XOR errors;
 * 0 rows survive a basic ASCII filter):
 *   - Faults            (DTC plain-English descriptions)
 *   - STATES            (state-id → label)
 *   - Units             (unit-id → string)
 *   - Diag_descriptions (long-form parameter descriptions)
 *
 * To unblock the DTC-overlay feature (Task #143), provide a fresh
 * non-corrupted .db dump or a corrected XOR key and re-run this script.
 *
 * Usage:
 *   node scripts/extract-alfaobd.mjs            # write generated module
 *   node scripts/extract-alfaobd.mjs --check    # CI: verify in sync
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const ASSETS = resolve(REPO_ROOT, "attached_assets");
const CACHE_DIR = resolve(ASSETS, ".cache");
const RECOVERED_DB = resolve(CACHE_DIR, "alfao_bd.recovered.db");
const OUT_PATH = resolve(ROOT, "src/lib/alfaobdData.generated.js");

// We accept any `alfao_bd*.decrypted*.db` so timestamp suffixes don't break
// regen on a different machine.
function findSourceDb() {
  if (!existsSync(ASSETS)) return null;
  const entries = require("node:fs").readdirSync(ASSETS);
  const match = entries
    .filter(
      (n) =>
        n.startsWith("alfao_bd") &&
        n.includes("decrypted") &&
        n.endsWith(".db"),
    )
    .sort();
  return match.length ? resolve(ASSETS, match[match.length - 1]) : null;
}

function fail(msg) {
  console.error(`extract-alfaobd: ${msg}`);
  process.exit(1);
}

function ensureRecovered(srcDb) {
  // Use cached recovery if it's newer than the source.
  if (existsSync(RECOVERED_DB)) {
    const srcMtime = statSync(srcDb).mtimeMs;
    const recMtime = statSync(RECOVERED_DB).mtimeMs;
    if (recMtime >= srcMtime) {
      return RECOVERED_DB;
    }
  }
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`extract-alfaobd: running sqlite3 .recover (one-time, ~30s)…`);
  // sqlite3 CLI is provided by the `sqlite` Nix package.
  let sql;
  try {
    sql = execFileSync("sqlite3", [srcDb, ".recover"], {
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    fail(`sqlite3 .recover failed: ${e.message}`);
  }
  // Always replay into a guaranteed-fresh DB so a stale or partially-written
  // cache from a prior aborted run can never silently survive.
  rmSync(RECOVERED_DB, { force: true });
  rmSync(`${RECOVERED_DB}-journal`, { force: true });
  rmSync(`${RECOVERED_DB}-wal`, { force: true });
  rmSync(`${RECOVERED_DB}-shm`, { force: true });
  try {
    execFileSync("sqlite3", [RECOVERED_DB], { input: sql });
  } catch (e) {
    fail(`replaying recovery SQL into ${RECOVERED_DB} failed: ${e.message}`);
  }
  return RECOVERED_DB;
}

const ASCII_RE = /^[ -~]+$/;
function isCleanAscii(s, minLen = 2, maxLen = 200) {
  return (
    typeof s === "string" && s.length >= minLen && s.length <= maxLen && ASCII_RE.test(s)
  );
}

// Heuristic config-row parser: c0 = 4-char hex byte address, c1 = bit (int),
// c2 = length (int), then a name column followed by 0..N "N: label" options.
function extractConfigRows(db, nfield, nameCol) {
  // The recovered DB stores lost_and_found with untyped columns, so the
  // same logical column has different SQLite affinities (text/integer/blob)
  // across rows. Use CAST AS TEXT and value-content checks instead of
  // typeof() so we do not silently drop valid rows.
  const stmt = db.prepare(
    `SELECT * FROM lost_and_found WHERE nfield=? AND CAST(c0 AS TEXT) GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]' AND CAST(c0 AS TEXT) NOT GLOB '*[^0-9A-Fa-f]*'`,
  );
  const rows = stmt.all(nfield);
  const out = [];
  for (const r of rows) {
    const byteRaw = String(r.c0);
    const bit = Number(r.c1);
    const length = Number(r.c2);
    if (!Number.isInteger(bit) || bit < 0 || bit > 255) continue;
    if (!Number.isInteger(length) || length < 1 || length > 64) continue;
    const name = typeof r[nameCol] === "string" ? r[nameCol] : null;
    if (!isCleanAscii(name, 3, 120)) continue;
    // Collect option strings: any cN that looks like "K: label" with clean ASCII.
    const options = [];
    for (let i = 0; i < nfield; i++) {
      const v = r[`c${i}`];
      if (typeof v !== "string") continue;
      if (!/^\d+:\s/.test(v)) continue;
      if (!isCleanAscii(v, 3, 80)) continue;
      options.push(v);
    }
    out.push({
      byte: byteRaw.toUpperCase().padStart(4, "0"),
      bit,
      length,
      name: name.trim(),
      options,
    });
  }
  return out;
}

function dedupeConfig(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.byte}|${r.bit}|${r.length}|${r.name}`;
    const prev = seen.get(key);
    if (!prev || r.options.length > prev.options.length) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.byte !== b.byte) return a.byte < b.byte ? -1 : 1;
    if (a.bit !== b.bit) return a.bit - b.bit;
    if (a.length !== b.length) return a.length - b.length;
    return a.name.localeCompare(b.name);
  });
}

function extractDiagNames(db) {
  // nfield=14: c0=int id, c1=EN, c2..c12=other languages, c13=extra.
  // Use CAST to tolerate column-affinity drift across recovered rows.
  const stmt = db.prepare(
    `SELECT c0 AS id, c1 AS en FROM lost_and_found WHERE nfield=14 AND CAST(c0 AS TEXT) GLOB '[0-9]*' AND CAST(c0 AS TEXT) NOT GLOB '*[^0-9]*'`,
  );
  const rows = stmt.all();
  const out = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isInteger(id) || id < 0) continue;
    if (typeof r.en !== "string" || !isCleanAscii(r.en, 2, 200)) continue;
    r.id = id;
    // Some rows are duplicated (different page recoveries of the same row).
    // Prefer the longer (more complete) string.
    const prev = out.get(r.id);
    if (!prev || r.en.length > prev.length) {
      out.set(r.id, r.en.trim());
    }
  }
  return Object.fromEntries(
    Array.from(out.entries()).sort((a, b) => a[0] - b[0]),
  );
}

function buildOutput({ diagNames, cgwConfig }) {
  const header = [
    "// AUTO-GENERATED by scripts/extract-alfaobd.mjs",
    "// Source of truth: attached_assets/alfao_bd*.decrypted*.db (recovered).",
    "// Do not edit by hand. Run `pnpm --filter @workspace/srt-lab codegen:alfaobd`",
    "// to regenerate.",
    "//",
    "// NOTE: The source .db is partially corrupted (XOR-decryption byte errors).",
    "// Faults / STATES / Units / Diag_descriptions are intentionally empty here",
    "// because their text columns did not survive the recovery. Provide a clean",
    "// .db (or a corrected XOR key) to populate them. See script header for details.",
    "",
  ].join("\n");

  const diagOut =
    "export const DIAG_NAMES = " +
    JSON.stringify(diagNames, null, 2) +
    ";\n";

  const cgwOut =
    "export const CGW_CONFIG = [\n" +
    cgwConfig
      .map(
        (r) =>
          `  { byte: ${JSON.stringify(r.byte)}, bit: ${r.bit}, length: ${r.length}, name: ${JSON.stringify(r.name)}, options: ${JSON.stringify(r.options)} },`,
      )
      .join("\n") +
    "\n];\n";

  const stubs = [
    "// Tables not recoverable from the current corrupted source dump.",
    "// Downstream features (e.g. DTC plain-English overlay) are blocked",
    "// until a clean .db is provided.",
    "export const FAULTS_BY_HEX = {};",
    "export const STATES = {};",
    "export const UNITS = {};",
    "",
    "export const ALFAOBD_META = {",
    `  diagNamesCount: ${Object.keys(diagNames).length},`,
    `  cgwConfigCount: ${cgwConfig.length},`,
    "  faultsRecovered: false,",
    "  statesRecovered: false,",
    "  unitsRecovered: false,",
    "};",
    "",
  ].join("\n");

  return [header, diagOut, "", cgwOut, "", stubs].join("\n");
}

function main() {
  const check = process.argv.includes("--check");

  // If the source .db isn't present (fresh CI checkout without
  // attached_assets), don't fail the whole build — just leave the
  // committed generated file alone, like generate-quickref-data does
  // when the python source is missing.
  const srcDb = findSourceDb();
  if (!srcDb) {
    if (check) {
      console.log(
        "extract-alfaobd: source .db not present, skipping --check (committed generated file is the source of truth on this machine).",
      );
      return;
    }
    console.warn(
      "extract-alfaobd: no alfao_bd*.decrypted*.db in attached_assets/, leaving generated file unchanged.",
    );
    return;
  }

  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    const msg =
      "better-sqlite3 not loadable in artifacts/srt-lab. " +
      "Run: pnpm --filter @workspace/srt-lab install";
    if (existsSync(OUT_PATH)) {
      console.warn(
        `extract-alfaobd: ${msg}. Committed ${OUT_PATH} exists, leaving it unchanged.`,
      );
      return;
    }
    fail(msg);
  }
  const recoveredPath = ensureRecovered(srcDb);
  const db = new Database(recoveredPath, { readonly: true });
  db.pragma("query_only = ON");

  const diagNames = extractDiagNames(db);

  const cgwRaw = [
    ...extractConfigRows(db, 50, "c3"), // BCM-style: name in c3
    ...extractConfigRows(db, 90, "c4"), // PN-config style: name in c4
    ...extractConfigRows(db, 31, "c3"), // Reconfig outputs: name in c3
  ];
  const cgwConfig = dedupeConfig(cgwRaw);

  db.close();

  const next = buildOutput({ diagNames, cgwConfig });

  if (check) {
    const cur = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
    if (cur !== next) {
      console.error(
        "extract-alfaobd: src/lib/alfaobdData.generated.js is out of sync with the recovered .db.",
      );
      console.error("Run: pnpm --filter @workspace/srt-lab codegen:alfaobd");
      process.exit(1);
    }
    console.log("alfaobd data in sync");
    return;
  }

  writeFileSync(OUT_PATH, next);
  // Bundle-size guardrail per task spec: warn (don't fail) if the
  // gzipped generated module exceeds 500 KB, so regen on a future
  // expanded data drop notices the bloat.
  const GZ_LIMIT = 500 * 1024;
  const gzipSize = gzipSync(next).length;
  const sizeKB = (gzipSize / 1024).toFixed(1);
  console.log(
    `extract-alfaobd: wrote ${OUT_PATH} (diag_names=${Object.keys(diagNames).length}, cgw_config=${cgwConfig.length}, gzipped=${sizeKB} KB)`,
  );
  if (gzipSize > GZ_LIMIT) {
    console.warn(
      `extract-alfaobd: WARNING — generated module is ${sizeKB} KB gzipped, over the 500 KB ceiling. Tighten filters or split the module.`,
    );
  }
}

main();
