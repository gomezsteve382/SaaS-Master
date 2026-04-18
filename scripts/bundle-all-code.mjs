#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'srt-lab-all-code.txt');

const INCLUDE_DIRS = ['artifacts', 'lib', 'scripts'];
const INCLUDE_ROOT_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  '.replit',
  'replit.md',
  '.gitignore',
  '.replitignore',
  '.npmrc',
];
const INCLUDE_ROOT_PATTERNS = [/^tsconfig.*\.json$/];

const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.config',
  '.local',
  '.agents',
  'attached_assets',
  'dist',
  'build',
  '.next',
  '.expo',
]);

const BINARY_EXTS = new Set([
  '.bin', '.hex', '.dflash', '.dfl',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.so', '.dll', '.dylib', '.a', '.o', '.exe',
  '.db', '.sqlite', '.sqlite3',
]);

const EXCLUDE_FILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

function isBinaryContent(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile()) {
      if (EXCLUDE_FILE_NAMES.has(e.name)) continue;
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
      out.push(full);
    }
  }
}

const files = [];
for (const d of INCLUDE_DIRS) {
  walk(join(ROOT, d), files);
}
for (const f of INCLUDE_ROOT_FILES) {
  const full = join(ROOT, f);
  try {
    if (statSync(full).isFile()) files.push(full);
  } catch {}
}
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  if (!INCLUDE_ROOT_PATTERNS.some((re) => re.test(e.name))) continue;
  const full = join(ROOT, e.name);
  if (!files.includes(full)) files.push(full);
}

files.sort((a, b) => relative(ROOT, a).localeCompare(relative(ROOT, b)));

const parts = [];
let totalBytes = 0;
let included = 0;
let skippedBinary = 0;

for (const full of files) {
  const rel = relative(ROOT, full);
  let buf;
  try {
    buf = readFileSync(full);
  } catch {
    continue;
  }
  if (isBinaryContent(buf)) {
    skippedBinary++;
    continue;
  }
  const text = buf.toString('utf8');
  parts.push(`===== ${rel} =====\n${text}\n`);
  totalBytes += buf.length;
  included++;
}

const header = `# SRT Lab — Full Source Bundle
# Generated: ${new Date().toISOString()}
# Files included: ${included}
# Total bytes (source content): ${totalBytes}
# Binary files skipped: ${skippedBinary}
# Order: alphabetical by relative path
# Each section: "===== <relative path> =====" then file contents, then a blank line.

`;

writeFileSync(OUT, header + parts.join('\n'));
console.log(`Wrote ${OUT}`);
console.log(`  ${included} files, ${totalBytes} bytes of source, ${skippedBinary} binary skipped`);
