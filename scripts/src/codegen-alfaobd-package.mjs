#!/usr/bin/env node
// Batch codegen for all source-JSON-derived data modules.
// Runs each individual extractor; equivalent to `pnpm codegen:all`.
// Usage: node scripts/codegen-alfaobd-package.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");

const j = (v) => JSON.stringify(v, null, 2);
const exp = (name, val) => `export const ${name} = ${j(val)};\n`;
function emit(filename, header, exports, metaName, metaVal) {
  const body = [header, "", ...Object.entries(exports).map(([k, v]) => exp(k, v)), exp(metaName, metaVal)].join("\n");
  writeFileSync(resolve(OUT, filename), body);
  console.log(`Wrote ${filename} (${body.length.toLocaleString()} bytes)`);
}
function load(name) { return JSON.parse(readFileSync(resolve(SRC, name), "utf-8")); }

// 1. UDS protocols extracted
{
  const s = load("uds-protocols.json");
  emit(
    "udsProtocolsExtracted.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/uds-protocols.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// Generic UDS service reference + SBEC2/SBEC3 legacy (SCI-bus) seed-key
// algorithm + 7-step VIN programming sequence template. Module addresses
// here are FCA conventions — cross-check against quickRefData.generated.js
// for SRT Lab's verified addressing per platform.`,
    {
      SBEC23_SECURITY: s.security_seed_algorithm,
      UDS_SERVICES_GENERIC: s.uds_services.services,
      UDS_MODULE_ADDRESSES: s.module_addresses,
      VIN_PROGRAMMING_SEQUENCE: s.vin_programming_sequence,
    },
    "UDS_PROTOCOLS_META",
    { source: "AlfaOBD RE + community knowledge", caveat: "Module addresses may conflict with quickRefData.generated.js verified values." },
  );
}

// 2. master module database
{
  const s = load("master-module-database.json");
  const ver = s.modules.filter((m) => m.verified).length;
  emit(
    "masterModuleDatabase.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/master-module-database.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// Master FCA module DB v3.0 — 22 modules with explicit verified/unverified flags.
// 8 verified from wiTECH/CDA6; 14 are AlfaOBD+standard-CAN pattern matches that
// need bench validation. Plus dealer-services API contract for wiTECH-compatible
// client work. Use as CROSS-REFERENCE; quickRefData is source of truth.`,
    {
      MASTER_MODULE_METADATA: s.metadata ?? {},
      MASTER_MODULES: s.modules,
      MASTER_SECURITY_ALGORITHMS: s.security_algorithms ?? {},
      MASTER_UDS_SERVICES: s.uds_services ?? {},
      MASTER_DEALER_SERVICES: s.dealer_services ?? {},
    },
    "MASTER_MODULE_DB_META",
    { modulesTotal: s.modules.length, modulesVerified: ver, modulesUnverified: s.modules.length - ver, source: "AlfaOBD + wiTECH/CDA6 + community (2025-10-28)" },
  );
}

// 3. complete module database (v1)
{
  const s = load("complete-module-database.json");
  emit(
    "completeModuleDatabase.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/complete-module-database.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// "Complete" FCA module catalog — 33 modules with priority ranking,
// VIN-support flag, category grouping. Source claims wiTECH/CDA6 + community
// but sequential 0x744-0x75E addressing for some modules is NOT vehicle-
// verified. Cross-reference only; SRT Lab quickRefData is source of truth.`,
    {
      COMPLETE_MODULES: s.modules,
      COMPLETE_CATEGORIES: s.categories,
    },
    "COMPLETE_MODULE_DB_META",
    {
      totalModules: s.total_modules,
      vinSupportedModules: s.vin_supported_modules,
      securityAlgorithm: s.security_algorithm,
      source: s.source,
      caveat: "Sequential CAN addressing pattern-based, not vehicle-verified.",
    },
  );
}

// 4. complete module database v2
{
  const s = load("complete-module-database-v2.json");
  const ver = s.modules.filter((m) => m.verified).length;
  emit(
    "completeModuleDatabaseV2.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/complete-module-database-v2.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// Complete module catalog v2 — 22 modules with EXPLICIT verified flags.
// 8 verified against wiTECH; 14 are pattern matches NOT verified on a vehicle.`,
    { COMPLETE_MODULES_V2: s.modules, COMPLETE_V2_NOTES: s.notes ?? {} },
    "COMPLETE_MODULE_DB_V2_META",
    { version: s.version, source: s.source, date: s.date, totalModules: s.modules.length, verifiedCount: ver, unverifiedCount: s.modules.length - ver },
  );
}

// 5. dtc database sample
{
  const s = load("dtc-database-sample.json");
  emit(
    "dtcDatabaseSample.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/dtc-database-sample.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// SAMPLE DTC reference — 10 commonly-seen Chrysler/FCA codes. Generic FCA
// repair-doc descriptions, NOT extracted from the AlfaOBD .db Faults table.
//
// RETRACTION: the previous "real catalog 20,043 codes" claim came from a
// naive /[A-Z][0-9]{4}/ regex on a 66 MB XOR-decrypted .db with 5-10% byte
// residual — that matches random byte triples (sequential B0000..B0050 in
// extraction-report.md is the tell). User-verified search for ASCII
// P/B/C/U DTCs in the recovered .db returns ZERO. Real Faults rows live
// in lost_and_found; shape match is pending.`,
    { DTC_SAMPLE: s.dtcCodes },
    "DTC_SAMPLE_META",
    { totalSamples: s.dtcCodes.length, realCatalogSize: null, realCatalogSizeRetractedNote: "Earlier 20,043 figure was a regex artifact, not real count.", source: "Generic FCA Chrysler community repair docs (NOT extracted from AlfaOBD .db)", useFor: "UI seed/example data only" },
  );
}

// 6. vin programming guide
{
  const s = load("vin-programming-guide.json");
  emit(
    "vinProgrammingGuide.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/vin-programming-guide.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// VIN storage locations and programming procedures for FCA modules.
// Companion to vinOffsetDatabase.generated.js (per-module byte offsets).`,
    { VIN_PROGRAMMING_GUIDE: s.vin_programming_guide ?? s },
    "VIN_PROGRAMMING_GUIDE_META",
    { source: "AlfaOBD reverse engineering + Chrysler service documentation" },
  );
}

// 7. vin offset database (the prize)
{
  const s = load("vin-offset-database.json");
  emit(
    "vinOffsetDatabase.generated.js",
    `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/vin-offset-database.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// PER-MODULE VIN BYTE OFFSETS + CRC CHECKSUM ALGORITHMS.
//
// For 17 FCA modules: EEPROM byte offset for the 17-byte VIN ASCII; primary +
// backup VIN locations; CRC algorithm + polynomial + init + checksum byte
// locations; DTC codes on mismatch; security access requirements.
//
// Modules: ECM_GPEC2/2A, BCM_CHRYSLER/CONTINENTAL/MARELLI, TCM_ZF8HP/ZF9HP/
// AISIN/CHRYSLER, ABS_CHRYSLER/CONTINENTAL/TEVES/TRW, RFHUB, AIRBAG_AUTOLIV/
// ORCM, AC_CONTROLLER.
//
// This is the most actionable dispatch data we have for VIN programming.`,
    {
      VIN_OFFSET_METADATA: s.metadata,
      VIN_OFFSET_MODULES: s.modules,
      VIN_OFFSET_UDS_PROTOCOL: s.uds_protocol ?? {},
    },
    "VIN_OFFSET_DB_META",
    { moduleCount: Object.keys(s.modules).length, source: "AlfaOBD RE, 2025-12-05", caveat: s.metadata?.note ?? "", modulesCovered: Object.keys(s.modules) },
  );
}

console.log("\nDone — 7 modules regenerated.");
