#!/usr/bin/env node
/* Build srt-lab-monorepo.tar.gz + srt-lab-monorepo-bundle.txt at repo root.
 * See .local/tasks/task-147.md for the spec.
 *
 * File set: `git ls-files` (so we naturally honor .gitignore and skip
 * node_modules/.cache/dist/.local/etc.) MINUS large generated databases
 * (*.db, *.sqlite*) which the spec calls out explicitly. Anything not
 * tracked by git is intentionally excluded — that's what .gitignore is
 * for and the user has already curated it. */
import { readFileSync, writeFileSync, statSync, rmSync, mkdtempSync, createWriteStream, existsSync } from "node:fs";
import { dirname, resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_FULL = resolve(ROOT, "srt-lab-monorepo.tar.gz");
const ARCHIVE_CODE = resolve(ROOT, "srt-lab-monorepo-code.tar.gz");
const BUNDLE  = resolve(ROOT, "srt-lab-monorepo-bundle.txt");

/* CLI: --mode=code|full|both (default: both).
 *   code  → srt-lab-monorepo-code.tar.gz, source only (excludes attached_assets/)
 *   full  → srt-lab-monorepo.tar.gz, everything including attached_assets/
 *   both  → write both archives in one run.
 * The text bundle is always written (binaries are placeholdered already). */
const VALID_MODES = new Set(["code", "full", "both"]);
let mode = "both";
for (const arg of process.argv.slice(2)) {
  const m = /^--mode(?:=(.+))?$/.exec(arg);
  if (!m) {
    console.error(`unknown arg: ${arg}`);
    console.error(`usage: build-codebase-bundle.mjs [--mode=code|full|both]`);
    process.exit(2);
  }
  const val = m[1];
  if (!val || !VALID_MODES.has(val)) {
    console.error(`--mode requires one of: ${[...VALID_MODES].join(", ")}`);
    process.exit(2);
  }
  mode = val;
}
const writeFull = mode === "full" || mode === "both";
const writeCode = mode === "code" || mode === "both";
console.log(`mode: ${mode}`);

/* Always-exclude file patterns (never go in archive or bundle). */
const EXCLUDE_FILE_RE = [
  /\.db$/i, /\.sqlite$/i, /\.sqlite3$/i,    // large generated DBs
  /^\.env(\..+)?$/i,                          // never ship secrets
  /^\.DS_Store$/, /^Thumbs\.db$/i,
  /^srt-lab-monorepo(-code)?(\.tar\.gz|-bundle\.txt)$/, // our own outputs
  /^srt-lab-all-code\.txt$/,                    // legacy bundle, replaced
];

const BINARY_EXT = new Set([
  ".png",".jpg",".jpeg",".gif",".webp",".ico",".bmp",".tiff",".avif",
  ".woff",".woff2",".ttf",".otf",".eot",
  ".mp3",".mp4",".mov",".webm",".wav",".ogg",".m4a",".m4v",
  ".pdf",".zip",".gz",".tgz",".tar",".7z",".rar",".bz2",".xz",
  ".db",".sqlite",".sqlite3",".bin",".dat",".dump",".rom",".hex",
  ".so",".dylib",".dll",".node",".wasm",".class",".jar",
  ".pptx",".docx",".xlsx",".odt",".odp",".ods",
  ".swf",".mdb",".accdb",
]);
/* No size cap on text files — the bundle must contain every source file
 * in full so it's a complete drop-in replacement for the working tree.
 * Binaries are still placeholdered. */

function isExcludedPath(rel) {
  const base = rel.split("/").pop();
  return EXCLUDE_FILE_RE.some((re) => re.test(base));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function classify(rel, buf) {
  const ext = extname(rel).toLowerCase();
  if (BINARY_EXT.has(ext)) return "binary";
  if (looksBinary(buf)) return "binary";
  return "text";
}

console.log("inventorying via git ls-files…");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const files = tracked
  .filter((rel) => !isExcludedPath(rel))
  .filter((rel) => existsSync(join(ROOT, rel)))
  .sort();

/* Code-only file list: source tree minus the heavy reference-asset dir. */
const isAsset = (rel) => rel === "attached_assets" || rel.startsWith("attached_assets/");
const codeFiles = files.filter((rel) => !isAsset(rel));
const assetFiles = files.filter(isAsset);

console.log(`inventory: ${tracked.length} tracked → ${files.length} after filters (code=${codeFiles.length}, assets=${assetFiles.length})`);

let totalBytes = 0;
for (const rel of files) totalBytes += statSync(join(ROOT, rel)).size;
const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`source bytes: ${totalMB} MB`);
if (totalBytes > 500 * 1024 * 1024) {
  console.error(`refusing: ${totalMB} MB exceeds 500 MB ceiling.`);
  process.exit(1);
}

/* ---------------- Text bundle ---------------- */
console.log(`writing ${BUNDLE} …`);
const out = createWriteStream(BUNDLE);
out.write(`# SRT Lab Monorepo — Source Bundle\n`);
out.write(`# Generated: ${new Date().toISOString()}\n`);
out.write(`# Files: ${files.length}\n`);
out.write(`# Source-tree size: ${totalMB} MB\n`);
out.write(`# Companion archives: srt-lab-monorepo-code.tar.gz (source only)\n`);
out.write(`#                    srt-lab-monorepo.tar.gz      (with attached_assets)\n`);
out.write(`#\n`);
out.write(`# Source set: git ls-files (honors .gitignore — node_modules,\n`);
out.write(`#   .cache, dist, build, .local, etc. are not tracked) minus\n`);
out.write(`#   large generated DBs (*.db, *.sqlite*), .env*, OS junk, and\n`);
out.write(`#   the bundle output files themselves.\n`);
out.write(`# Binary files appear as <<binary file, NNN bytes, sha256:…>>\n`);
out.write(`#   placeholder lines so the file index is complete.\n`);
out.write(`# All text files are inlined in full — no size cap.\n`);
out.write(`#\n\n`);

let textCount = 0, binaryCount = 0, textBytes = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  const buf = readFileSync(abs);
  const kind = classify(rel, buf);
  out.write(`===== ${rel} =====\n`);
  if (kind === "text") {
    out.write(buf);
    if (buf.length === 0 || buf[buf.length - 1] !== 0x0a) out.write("\n");
    textCount++;
    textBytes += buf.length;
  } else {
    const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    out.write(`<<binary file, ${buf.length} bytes, sha256:${sha}…>>\n`);
    binaryCount++;
  }
  out.write("\n");
}
await new Promise((res) => out.end(res));
const bundleSize = statSync(BUNDLE).size;
console.log(`bundle: text=${textCount} (${(textBytes/1024).toFixed(0)} KB inlined) binary=${binaryCount} → ${(bundleSize/1024/1024).toFixed(2)} MB`);

/* ---------------- tar.gz archive(s) ---------------- */
function writeArchive(archivePath, fileList, label) {
  console.log(`writing ${archivePath} …  (${label}, ${fileList.length} files)`);
  rmSync(archivePath, { force: true });
  /* Feed the file list to tar via -T to avoid relying on tar globs. */
  const listFile = join(tmpdir(), `srt-lab-files-${label}-${process.pid}.txt`);
  writeFileSync(listFile, fileList.join("\n") + "\n", "utf8");
  try {
    execFileSync(
      "tar",
      ["-czf", archivePath, "--owner=0", "--group=0", "--no-recursion", "-C", ROOT, "-T", listFile],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } finally {
    rmSync(listFile, { force: true });
  }
  const size = statSync(archivePath).size;
  console.log(`archive: ${(size / (1024 * 1024)).toFixed(2)} MB`);

  /* Verify it extracts cleanly with the same file count. */
  console.log(`verifying ${label} …`);
  const tmp = mkdtempSync(join(tmpdir(), `srt-lab-verify-${label}-`));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", tmp], { stdio: ["ignore", "ignore", "inherit"] });
    let extracted = 0;
    (function count(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) count(p);
        else if (e.isFile()) extracted++;
      }
    })(tmp);
    console.log(`verify: ${extracted} files extracted (expected ${fileList.length})`);
    if (extracted !== fileList.length) {
      console.error(`refusing: extracted file count (${extracted}) ≠ list (${fileList.length}).`);
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return size;
}

const written = [];
if (writeFull) {
  const size = writeArchive(ARCHIVE_FULL, files, "full");
  written.push([ARCHIVE_FULL, size]);
} else {
  /* Clean up stale full archive when only producing the code archive, so
   * downloaders don't pick up an out-of-date copy. */
  if (existsSync(ARCHIVE_FULL)) rmSync(ARCHIVE_FULL, { force: true });
}
if (writeCode) {
  const size = writeArchive(ARCHIVE_CODE, codeFiles, "code");
  written.push([ARCHIVE_CODE, size]);
} else {
  if (existsSync(ARCHIVE_CODE)) rmSync(ARCHIVE_CODE, { force: true });
}

console.log("done.");
for (const [path, size] of written) {
  console.log(`  ${path}  (${(size / (1024 * 1024)).toFixed(2)} MB)`);
}
console.log(`  ${BUNDLE}   (${(bundleSize  / (1024 * 1024)).toFixed(2)} MB)`);
