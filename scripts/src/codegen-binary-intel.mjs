#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/binary-intel-full.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/alfaobdBinaryIntel.generated.js");
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/binary-intel-full.json
//
// Comprehensive intelligence extracted from a mass salt-sweep of every method
// in AlfaOBD.exe. The sweep recovered the per-method Dotfuscator salt for 1,596
// methods and decrypted every ldstr they reference — ${src.all_unique_strings_count.toLocaleString()} unique strings total.
//
// This file surfaces the high-value structured intel:
//   - 24 SQL queries showing AlfaOBD's actual database access patterns
//   - 10 FGA_* table names with their column schemas
//   - 672 ECU-type identifiers (the full FCA module-variant registry)
//   - 190 crypto/security-relevant strings (SKIM, immobilizer, secret key)
//   - 682 log-message vocabulary
//   - URLs (license/update endpoints, DTC-lookup web APIs)
//   - SQLite connection string fragments
//   - Registry paths

export const ALFAOBD_BINARY_INTEL_META = {
  source: "AlfaOBD.exe v2.5.7.0 mass-salt-sweep",
  totalUniqueStrings: ${src.all_unique_strings_count},
  methodsScanned: 2622,
  methodsWithDecodedStrings: 1596,
};

/** Every SQL query (SELECT/INSERT/UPDATE/CREATE) found in the binary. */
export const ALFAOBD_SQL_QUERIES = ${j(src.sql_queries)};

/** Every database table referenced in SQL queries, with the columns observed. */
export const ALFAOBD_SQL_TABLES = ${j(src.sql_columns_per_table)};

/** FGA_* tables only (the AlfaOBD-specific routine/data tables). */
export const ALFAOBD_FGA_TABLES = ${j(src.fga_table_names)};

/** Windows registry paths AlfaOBD reads/writes. */
export const ALFAOBD_REGISTRY_PATHS = ${j(src.registry_paths)};

/** Web URLs hardcoded in the binary (vendor endpoints). */
export const ALFAOBD_VENDOR_URLS = ${j(src.urls)};

/** SQLite connection-string fragments — confirms .db is opened with Password=
 *  parameter (SQLCipher/SEE) in addition to the 1024-byte XOR layer. */
export const ALFAOBD_SQLITE_CONN_STRINGS = ${j(src.sqlite_connection_strings)};

/** 672 ECU-type identifiers — the complete FCA module variant registry covering
 *  every ABS family (ABS_CHRYSLER/CONTINENTAL/TEVES/TRW + UDS/CAN variants),
 *  every AISIN transmission (AS68RC, ASC69RC, EP, TIP), every PCM/ECM, etc. */
export const ALFAOBD_ECU_TYPE_REGISTRY = ${j(src.ecu_type_identifiers)};

/** Crypto/security-relevant strings (SKIM, immobilizer, secret-key, PIN, PROXI). */
export const ALFAOBD_CRYPTO_STRINGS = ${j(src.crypto_relevant)};

/** Log-message vocabulary — every \`: <method_name>...\` log-prefix style entry. */
export const ALFAOBD_LOG_VOCABULARY = ${j(src.log_messages)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
