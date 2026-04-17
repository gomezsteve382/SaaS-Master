#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PY_PATH = resolve(ROOT, "public/srt_lab.py");
const MANIFEST_PATH = resolve(ROOT, "public/srt_lab.manifest.json");

function parseArgs(argv) {
  const args = { bump: null, notes: null, date: null, check: false };
  const needsValue = (flag, val) => {
    if (val === undefined || val === null || String(val).startsWith("--")) {
      console.error(`update-manifest: ${flag} requires a value`);
      process.exit(1);
    }
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bump") args.bump = needsValue("--bump", argv[++i]);
    else if (a === "--notes" || a === "-m") args.notes = needsValue(a, argv[++i]);
    else if (a === "--date") args.date = needsValue("--date", argv[++i]);
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: update-manifest.mjs [options]",
          "",
          "  (no flags)        Refresh sizeBytes, sha256, and lastUpdated from srt_lab.py",
          "  --bump <version>  Set manifest version and prepend a new changelog entry",
          "  --notes <text>    Changelog notes (required with --bump)",
          "  --date <YYYY-MM-DD>  Override the date (defaults to today, UTC)",
          "  --check           Exit non-zero if manifest is out of sync (no writes)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isValidSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return { raw, data: JSON.parse(raw) };
}

function computeFileMeta() {
  const buf = readFileSync(PY_PATH);
  const sizeBytes = statSync(PY_PATH).size;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sizeBytes, sha256 };
}

function writeManifest(data) {
  const out = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(MANIFEST_PATH, out);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { data } = loadManifest();
  const { sizeBytes, sha256 } = computeFileMeta();
  const today = args.date || isoDate();

  if (args.bump) {
    if (!isValidSemver(args.bump)) {
      console.error(`update-manifest: invalid version "${args.bump}" (expected semver like 2.1.0)`);
      process.exit(1);
    }
    if (!args.notes || !args.notes.trim()) {
      console.error("update-manifest: --bump requires --notes \"<changelog text>\"");
      process.exit(1);
    }
    if (Array.isArray(data.changelog) && data.changelog.some((e) => e.version === args.bump)) {
      console.error(`update-manifest: changelog already contains version ${args.bump}`);
      process.exit(1);
    }
    data.version = args.bump;
    data.changelog = [
      { version: args.bump, date: today, notes: args.notes.trim() },
      ...(Array.isArray(data.changelog) ? data.changelog : []),
    ];
  }

  const next = {
    ...data,
    sizeBytes,
    sha256,
    lastUpdated: today,
  };

  if (args.check) {
    const drift = [];
    if (data.sizeBytes !== sizeBytes) drift.push(`sizeBytes ${data.sizeBytes} → ${sizeBytes}`);
    if (data.sha256 !== sha256) drift.push(`sha256 ${data.sha256} → ${sha256}`);
    if (drift.length) {
      console.error("update-manifest: manifest is out of sync with srt_lab.py:");
      for (const d of drift) console.error("  - " + d);
      console.error("Run: pnpm --filter @workspace/srt-lab run manifest:update");
      process.exit(2);
    }
    console.log("update-manifest: manifest in sync (sha256 " + sha256.slice(0, 12) + "…)");
    return;
  }

  writeManifest(next);
  const action = args.bump ? `bumped to ${args.bump}` : "refreshed";
  console.log(
    `update-manifest: ${action} — sizeBytes=${sizeBytes}, sha256=${sha256.slice(0, 12)}…, lastUpdated=${today}`,
  );
}

main();
