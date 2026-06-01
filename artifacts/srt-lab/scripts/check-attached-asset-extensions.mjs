#!/usr/bin/env node
/**
 * check-attached-asset-extensions.mjs
 *
 * Catch future misnamed dumps before they go unused (Task #504).
 *
 * Reads the first few bytes of every file in `attached_assets/`, compares
 * the detected content type against the file's claimed extension, and
 * flags mismatches. Each flag includes a short hint describing what the
 * file actually looks like — e.g. "raw 64 KB binary, looks like BCM
 * DFLASH" — so a developer or agent reviewing project state can rescue
 * the file the same way Task #497 did, instead of letting it sit unused
 * for months.
 *
 * Detection only — no auto-rename. Identifying BCM vs PCM by header /
 * VIN offsets is the parser's job (`src/lib/parseModule.js`); this
 * script just raises the flag.
 *
 * Usage:
 *   node scripts/check-attached-asset-extensions.mjs            # write
 *   node scripts/check-attached-asset-extensions.mjs --check    # CI: nonzero exit if anything mismatches
 *   node scripts/check-attached-asset-extensions.mjs --quiet    # write generated file silently (no stdout summary)
 *
 * Outputs (always overwritten):
 *   src/lib/attachedAssetMismatches.generated.json
 *
 * The Sample Library tab imports the generated JSON and renders a banner
 * at the top whenever the array is non-empty, so the warning is visible
 * to humans without having to grep.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(ROOT, "..", "..");
const ASSETS_DIR = resolve(REPO_ROOT, "attached_assets");
const OUT_PATH = resolve(ROOT, "src/lib/attachedAssetMismatches.generated.json");

const args = new Set(process.argv.slice(2));
const CHECK_MODE = args.has("--check");
const QUIET = args.has("--quiet");

/* --------------------------------------------------------------------- *
 * Magic-byte signatures.
 *
 * Each entry: { type, test(bytes) -> boolean, label }
 * `type` is the canonical content kind we're looking for; we compare
 * the file's detected type against the set of types its extension is
 * allowed to match.
 * --------------------------------------------------------------------- */
function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}
const SIG = {
  zip:  (b) => startsWith(b, [0x50,0x4b,0x03,0x04]) || startsWith(b, [0x50,0x4b,0x05,0x06]) || startsWith(b, [0x50,0x4b,0x07,0x08]),
  pdf:  (b) => startsWith(b, [0x25,0x50,0x44,0x46,0x2d]),                       // "%PDF-"
  png:  (b) => startsWith(b, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  jpg:  (b) => startsWith(b, [0xff,0xd8,0xff]),
  gif:  (b) => startsWith(b, [0x47,0x49,0x46,0x38]),                            // "GIF8"
  webp: (b) => startsWith(b, [0x52,0x49,0x46,0x46]) && b.length >= 12 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50,
  swf:  (b) => (b[0]===0x46||b[0]===0x43||b[0]===0x5a) && b[1]===0x57 && b[2]===0x53, // FWS/CWS/ZWS
  sqlite: (b) => startsWith(b, [0x53,0x51,0x4c,0x69,0x74,0x65,0x20,0x66,0x6f,0x72,0x6d,0x61,0x74,0x20,0x33,0x00]),
  exe:  (b) => startsWith(b, [0x4d,0x5a]),                                      // "MZ"
  /* Office / docx files are themselves ZIPs; matched via `zip`. */
};

/* What each extension is allowed to be. The first entry is the
 * canonical type for that extension; mismatches against any of the
 * listed allowed types are flagged. */
const EXTENSION_RULES = {
  ".zip":  { allowed: ["zip"],     human: "ZIP archive" },
  ".docx": { allowed: ["zip"],     human: "DOCX (zipped)" },
  ".xlsx": { allowed: ["zip"],     human: "XLSX (zipped)" },
  ".pptx": { allowed: ["zip"],     human: "PPTX (zipped)" },
  ".jar":  { allowed: ["zip"],     human: "JAR (zipped)" },
  ".pdf":  { allowed: ["pdf"],     human: "PDF document" },
  ".png":  { allowed: ["png"],     human: "PNG image" },
  ".jpg":  { allowed: ["jpg"],     human: "JPEG image" },
  ".jpeg": { allowed: ["jpg"],     human: "JPEG image" },
  ".gif":  { allowed: ["gif"],     human: "GIF image" },
  ".webp": { allowed: ["webp"],    human: "WebP image" },
  ".swf":  { allowed: ["swf"],     human: "SWF (Flash) binary" },
  ".db":   { allowed: ["sqlite", "binary"], human: "SQLite/binary database" },
  ".sqlite": { allowed: ["sqlite"], human: "SQLite database" },
  ".exe":  { allowed: ["exe"],     human: "Windows executable" },
  /* Text-ish extensions: any predominantly-printable content is fine. */
  ".json": { allowed: ["json"],    human: "JSON document" },
  ".md":   { allowed: ["text"],    human: "Markdown text" },
  ".txt":  { allowed: ["text"],    human: "plain text" },
  ".js":   { allowed: ["text"],    human: "JavaScript source" },
  ".jsx":  { allowed: ["text"],    human: "React JSX source" },
  ".mjs":  { allowed: ["text"],    human: "JavaScript module source" },
  ".cjs":  { allowed: ["text"],    human: "CommonJS source" },
  ".ts":   { allowed: ["text"],    human: "TypeScript source" },
  ".tsx":  { allowed: ["text"],    human: "TypeScript JSX source" },
  ".py":   { allowed: ["text"],    human: "Python source" },
  ".sh":   { allowed: ["text"],    human: "shell script" },
  ".html": { allowed: ["text"],    human: "HTML document" },
  ".htm":  { allowed: ["text"],    human: "HTML document" },
  ".xml":  { allowed: ["text"],    human: "XML document" },
  ".svg":  { allowed: ["text"],    human: "SVG (XML) image" },
  ".yml":  { allowed: ["text"],    human: "YAML document" },
  ".yaml": { allowed: ["text"],    human: "YAML document" },
  ".csv":  { allowed: ["text"],    human: "CSV text" },
  ".tsv":  { allowed: ["text"],    human: "TSV text" },
  ".hex":  { allowed: ["text"],    human: "Intel HEX text" },
  ".log":  { allowed: ["text"],    human: "log text" },
  /* `.bin` is the catch-all dump extension. Anything binary is fine;
   * the only thing we'd flag is an obvious non-binary file masquerading
   * as a dump (e.g. a dumper that wrote an HTML error page to a `.bin`).
   */
  ".bin":  { allowed: ["binary", "zip", "sqlite", "exe", "swf", "png", "jpg", "gif", "webp", "pdf"], human: "raw binary dump" },
};

/* --------------------------------------------------------------------- *
 * Content classification.
 * --------------------------------------------------------------------- */
function isMostlyPrintable(bytes) {
  if (bytes.length === 0) return false;
  /* Reject UTF-16 / UTF-32 BOM-ed text — we don't expect any of those
   * in `attached_assets/` and treating them as text would let JSON-as-binary
   * sneak through. */
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false;
  const sample = bytes.subarray(0, Math.min(4096, bytes.length));
  let asciiPrintable = 0;
  let highByte = 0;
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) asciiPrintable++;
    else if (b >= 0x80) highByte++; // possible UTF-8 multi-byte char OR padding (0xFF)
    else if (b === 0x00) return false; // NUL byte → almost certainly binary
  }
  /* Two conditions must both hold for "text":
   *   1. No NUL bytes (already short-circuited above) AND no other
   *      C0 control bytes — already enforced by the loop's `else if`
   *      ladder, which only counts ASCII-printable, high-byte, or
   *      NUL/ctrl categories.
   *   2. A meaningful ASCII-printable presence. UTF-8 source files
   *      are dominated by ASCII whitespace, punctuation and Latin
   *      letters even when they contain emoji or em-dashes
   *      (~80% ASCII typical). A 30% floor accepts heavily-UTF-8
   *      text while still rejecting 0xFF-only padding streams (0%
   *      ASCII), which used to slip through as "text" and produced
   *      misleading hints for virgin flash dumps. */
  return (asciiPrintable / sample.length) >= 0.30 && asciiPrintable > 0;
}
function isJsonLike(bytes) {
  if (!isMostlyPrintable(bytes)) return false;
  /* Skip BOM if present. */
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  if (i >= bytes.length) return false;
  const first = bytes[i];
  if (first === 0x7b /* { */) return true;
  if (first === 0x5b /* [ */) {
    /* Skip whitespace after '['. */
    let j = i + 1;
    while (j < bytes.length && (bytes[j] === 0x20 || bytes[j] === 0x09 || bytes[j] === 0x0a || bytes[j] === 0x0d)) j++;
    if (j >= bytes.length) return false;
    const after = bytes[j];
    /* If the first value token is a bare digit, peek one char ahead.
     * A '/' or ':' immediately following indicates a date/time literal
     * (e.g. "[5/25/2026…" or "[12:30…"), not a JSON number array.
     * Valid JSON number arrays have digits followed only by digits, '.',
     * 'e', 'E', '+', '-', ',', ']', or whitespace at this position. */
    if (after >= 0x30 && after <= 0x39 /* digit */) {
      const next1 = j + 1 < bytes.length ? bytes[j + 1] : 0;
      if (next1 === 0x2f /* '/' */ || next1 === 0x3a /* ':' */) return false;
    }
    return true;
  }
  return false;
}
function detectType(bytes) {
  if (SIG.zip(bytes))    return "zip";
  if (SIG.pdf(bytes))    return "pdf";
  if (SIG.png(bytes))    return "png";
  if (SIG.jpg(bytes))    return "jpg";
  if (SIG.gif(bytes))    return "gif";
  if (SIG.webp(bytes))   return "webp";
  if (SIG.swf(bytes))    return "swf";
  if (SIG.sqlite(bytes)) return "sqlite";
  if (SIG.exe(bytes))    return "exe";
  if (isJsonLike(bytes))         return "json";
  if (isMostlyPrintable(bytes))  return "text";
  return "binary";
}

/* --------------------------------------------------------------------- *
 * Module-shape hints for raw binaries.
 *
 * Mirrors the size heuristics used by `parseModule.js` /
 * `detectModuleType` — we don't import that module here because it
 * pulls in the full SRT Lab parser graph, but the size-based hints
 * match the canonical sizes table (CANONICAL_SIZES_BY_TYPE). The intent
 * is to give a developer enough of a clue to identify the module
 * (Task #497 had to do this by hand).
 * --------------------------------------------------------------------- */
function moduleHintForBinary(bytes) {
  const size = bytes.length;
  /* BCM DFLASH header: Redeye / 2020+ BCMs carry a `FEE1` magic at
   * byte offset 4 (the 0xFEE10000 record-table marker). Task #497
   * used this exact marker to identify the rescued BCMs. */
  const hasFEE1 = bytes.length >= 6 && bytes[4] === 0xfe && bytes[5] === 0xe1;
  if (size === 65536) {
    return hasFEE1
      ? "raw 64 KB binary with FEE1 header @ 0x04 — looks like BCM DFLASH"
      : "raw 64 KB binary — likely BCM DFLASH (or padded GPEC2A / 95640 capture)";
  }
  if (size === 131072) return "raw 128 KB binary — likely BCM DFLASH (oversized capture)";
  if (size === 8192)   return "raw 8 KB binary — could be 95640 EXT EEPROM or GPEC2A 8 KB PCM";
  if (size === 4096)   return "raw 4 KB binary — could be RFHUB EEE or GPEC2A 4 KB PCM";
  if (size === 2048)   return "raw 2 KB binary — could be RFHUB Gen1 (24C16) EEE";
  if (size === 4194304) return "raw 4 MB binary — looks like GPEC2A internal flash";
  if (size === 0)       return "zero-byte file (rescued stub or aborted upload)";
  return `raw ${size.toLocaleString()} byte binary (no canonical module size matched)`;
}

/* --------------------------------------------------------------------- *
 * Per-file scan.
 * --------------------------------------------------------------------- */
function scanFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const rule = EXTENSION_RULES[ext];
  if (!rule) return null; // unknown extension → don't second-guess
  const st = statSync(filePath);
  if (!st.isFile()) return null;
  /* Zero-byte files are intentional rescue stubs (see Task #497) — they
   * already point at a NOTE.md in the same directory. Skipping them here
   * keeps the warning list signal-only. */
  if (st.size === 0) return null;
  /* Read enough to cover every signature we know about, plus a generous
   * window for the printable-ratio sample. 8 KB is plenty. */
  const fd = readFileSync(filePath);
  const head = fd.subarray(0, Math.min(8192, fd.length));
  const detected = detectType(head);
  if (rule.allowed.includes(detected)) return null;
  /* Mismatch! Build the human-readable hint. */
  let hint;
  if (detected === "binary") {
    hint = moduleHintForBinary(fd);
  } else if (detected === "text") {
    hint = "looks like text (e.g. error page or log written instead of the expected payload)";
  } else if (detected === "json") {
    hint = "looks like JSON";
  } else {
    /* Detected a different known binary format. */
    const namedHuman = {
      zip: "ZIP archive", pdf: "PDF", png: "PNG image", jpg: "JPEG image",
      gif: "GIF image", webp: "WebP image", swf: "SWF (Flash)",
      sqlite: "SQLite database", exe: "Windows executable",
    }[detected] || detected;
    hint = `looks like a ${namedHuman}`;
  }
  return {
    file: basename(filePath),
    size: st.size,
    claimedExt: ext,
    claimedKind: rule.human,
    detectedType: detected,
    hint,
  };
}

/* --------------------------------------------------------------------- *
 * Main.
 * --------------------------------------------------------------------- */
function ensureDir(p) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function main() {
  if (!existsSync(ASSETS_DIR)) {
    /* No attached_assets dir — write empty result so downstream importers
     * don't break, and exit clean. */
    ensureDir(OUT_PATH);
    writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), assetsDir: ASSETS_DIR, mismatches: [] }, null, 2) + "\n");
    if (!QUIET) console.log("check-attached-asset-extensions: attached_assets/ not found, wrote empty report");
    return;
  }
  const entries = readdirSync(ASSETS_DIR).sort();
  const mismatches = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const m = scanFile(resolve(ASSETS_DIR, name));
      if (m) mismatches.push(m);
    } catch (ex) {
      /* A read failure shouldn't kill the dev server. Log and continue. */
      if (!QUIET) console.warn(`check-attached-asset-extensions: skipped ${name}: ${ex.message || ex}`);
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    assetsDir: ASSETS_DIR,
    scanned: entries.length,
    mismatches,
  };
  ensureDir(OUT_PATH);
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (!QUIET) {
    if (mismatches.length === 0) {
      console.log(`check-attached-asset-extensions: scanned ${entries.length} files in attached_assets/, no extension mismatches`);
    } else {
      console.log(`\n  ⚠ check-attached-asset-extensions: ${mismatches.length} misnamed file(s) in attached_assets/ — content does not match extension:`);
      for (const m of mismatches) {
        console.log(`     • ${m.file} (${m.size.toLocaleString()} B, claimed ${m.claimedKind}) — ${m.hint}`);
      }
      console.log(`     → Rescue/rename them the way Task #497 did before they go unused.`);
      console.log(`     → Full report: artifacts/srt-lab/src/lib/attachedAssetMismatches.generated.json\n`);
    }
  }
  if (CHECK_MODE && mismatches.length > 0) process.exit(1);
}
main();
