#!/usr/bin/env node
/**
 * CLI entrypoint for the AlfaOBD .NET extraction pipeline.
 *
 *   node tools/alfaobd-extractor/extract.mjs [options]
 *
 * Options:
 *   --binary     <path>   AlfaOBD.exe (default: attached_assets/AlfaOBD.exe)
 *   --shfolder   <path>   shfolder(1).dll for fingerprinting (optional)
 *   --out        <dir>    output directory (default: artifacts/srt-lab/public/alfaobd-tables)
 *   --decompiler <cmd>    .NET decompiler command (default: ilspycmd)
 *   --help                print this help
 *
 * The pipeline refuses to run if AlfaOBD.exe or the decompiler is
 * absent. It does NOT scrape the historic chat transcript and does
 * NOT invent data. See tools/alfaobd-extractor/README.md for the full
 * walkthrough.
 */
import { extract, ExtractorError } from "./src/extract.mjs";

function parseArgv(argv) {
  const out = {};
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--help" || k === "-h") { out.help = true; continue; }
    if (!k.startsWith("--")) { console.error(`unknown positional arg: ${k}`); process.exit(2); }
    const v = a[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`missing value for ${k}`); process.exit(2);
    }
    out[k.slice(2)] = v;
    i++;
  }
  return out;
}

function help() {
  console.log(`AlfaOBD .NET extraction pipeline

USAGE
  node tools/alfaobd-extractor/extract.mjs [options]

OPTIONS
  --binary     <path>   AlfaOBD.exe (default: attached_assets/AlfaOBD.exe)
  --shfolder   <path>   shfolder(1).dll for fingerprinting (optional)
  --out        <dir>    output directory
                        (default: artifacts/srt-lab/public/alfaobd-tables)
  --decompiler <cmd>    .NET decompiler command (default: ilspycmd)
  --help                this message

The pipeline refuses to run if AlfaOBD.exe or the decompiler is missing.
See tools/alfaobd-extractor/README.md for the full walkthrough.
`);
}

const args = parseArgv(process.argv);
if (args.help) { help(); process.exit(0); }

try {
  const manifest = extract(args);
  console.log(`alfaobd-extractor: wrote ${manifest.outputs.files.length} files to ${args.out || "(default)"}`);
  console.log(`  ECUTYPE families: ${manifest.counts.ecutype_families}`);
  console.log(`  ECUTYPE modules:  ${manifest.counts.ecutype_modules}`);
  console.log(`  Handlers:         ${manifest.counts.handlers}`);
  console.log(`  Transports:       ${manifest.counts.transports}`);
  console.log(`  Resource bundles: ${manifest.counts.resources}`);
  console.log(`  Media files:      ${manifest.counts.media_files}`);
  console.log(`  AlfaOBD sha256:   ${manifest.alfaobd.sha256}`);
  console.log(`  shfolder.dll:     ${manifest.shfolder.protected_skip ? "fingerprint only (protected_skip)" : "(unexpected)"}`);
} catch (e) {
  if (e instanceof ExtractorError) {
    console.error(e.message.trim());
    process.exit(1);
  }
  throw e;
}
