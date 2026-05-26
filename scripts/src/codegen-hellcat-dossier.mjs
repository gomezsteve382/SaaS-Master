#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = JSON.parse(readFileSync(
  resolve(repoRoot, "attached_assets/alfaobd-package-2026-05-25/hellcat-tuning-dossier.json"),
  "utf-8"));
const outPath = resolve(repoRoot, "artifacts/srt-lab/src/lib/hellcatTuningDossier.generated.js");
const j = (v) => JSON.stringify(v);

const out = `// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/hellcat-tuning-dossier.json
//
// SRT Hellcat / Performance tuning intel extracted from AlfaOBD.exe IL.
// All strings traceable to specific Dotfuscator-decrypted methods.

export const HELLCAT_DOSSIER_META = ${j(src.meta)};

/** All SRT / Hellcat / TrackHawk model variants found in AlfaOBD catalog. */
export const SRT_HELLCAT_VARIANTS = ${j(src.srt_hellcat_variants_in_catalog)};

/** Engine family variants by series (tigershark, pentastar, hemi, 6.2L, 6.4L, 5.7L, viper). */
export const ENGINE_FAMILY_VARIANTS = ${j(src.engine_family_variants)};

/** Speed limiter / governor intel:
 *  - UDS frame: \`31 01 DF [speed_lo] [speed_hi]\`
 *  - Preconditions: 10 03 + SA unlock
 *  - Range: 65 km/h to vehicle-specific max
 *  - Caveat: legal off-road / track use; illegal on public roads in EU. */
export const SPEED_LIMITER_INTEL = ${j(src.speed_limiter_intel)};

/** Wastegate / Supercharger / Boost intel.
 *  Hellcat-relevant: \`Wastegate Short trip manager status (only V8)\` confirms
 *  V8-specific wastegate control. 18+ boost-related DIDs identified. */
export const WASTEGATE_SUPERCHARGER_INTEL = ${j(src.wastegate_supercharger_intel)};

/** Traction control disable / ESC off intel. */
export const TRACTION_CONTROL_INTEL = ${j(src.traction_control_disable_intel)};

/** Transmission ECU variants (8HP75, ZF8HP, ZF9HP, AS66RC). */
export const TRANSMISSION_INTEL = ${j(src.transmission_intel)};

/** Hellcat audio system variants (SRT Harman, SRT Alpine, Harman ANC, Alpine ANC). */
export const HELLCAT_AUDIO_VARIANTS = ${j(src.hellcat_amp_audio_variants)};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length.toLocaleString()} bytes)`);
