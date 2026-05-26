#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25");
const OUT = resolve(repoRoot, "artifacts/srt-lab/src/lib");
const j = (v) => JSON.stringify(v);

const src = JSON.parse(readFileSync(resolve(ASSETS, "prior-session-extraction-summary.json"), "utf-8"));

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/prior-session-extraction-summary.json
//
// Architectural findings from a prior in-chat session that pre-dates the
// current branch's mass-salt-sweep. Key contributions surfaced here:
//
//  1. The Stellantis Authenticated Diagnostics (SGW unlock) flow as
//     implemented in CDA.swf. 2018+ vehicles require this before any
//     Tier-1 routine.
//  2. Concrete UDS extractions confirmed from CDA.swf source strings.
//  3. Where the actual routine dispatch catalog lives (wiTECH backend +
//     AlfaOBD's encrypted .db).
//  4. CDA.swf namespace map - 1204 service/command/controller classes.
//  5. Dotfuscator algorithm summary (independent verification).

export const PRIOR_SESSION_ARCHITECTURE = ${j(src.architecture_findings || {})};

export const CDA_CONFIRMED_UDS_FRAMES = ${j(src.concrete_uds_extractions || {})};

/** Stellantis Authenticated Diagnostics flow - the SGW unlock path required
 *  on 2018+ vehicles before any Tier-1 routine can be executed. */
export const STELLANTIS_SGW_UNLOCK_FLOW = ${j(src.sgw_unlock_flow_from_cda || {})};

/** Authoritative answer to "where does the routine catalog live?". */
export const ROUTINE_CATALOG_LOCATION_NOTES = ${j(src.where_the_routine_catalog_actually_lives || {})};

export const TIER1_ROUTINE_UPDATED_NOTES = ${j(src.tier1_routines_updated || {})};

export const UDS_REFERENCE_PDF_SUMMARY = ${j(src.uds_complete_reference_summary || {})};

export const PRIOR_SESSION_DECRYPTED_STRING_CATEGORIES = ${j(src.alfaobd_decrypted_string_categories || {})};
`;

writeFileSync(resolve(OUT, "priorSessionIntel.generated.js"), out);
console.log(`Wrote priorSessionIntel.generated.js (${out.length.toLocaleString()} bytes)`);
