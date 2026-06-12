#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";
const DEFAULT_OUT_DIR =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\verification_history";

function parseArgs(argv) {
  const out = {
    root: DEFAULT_ROOT,
    outDir: DEFAULT_OUT_DIR,
    reportFile: null,
    allowFail: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      out.root = argv[i + 1];
      i += 1;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      out.outDir = argv[i + 1];
      i += 1;
    } else if (arg === "--report-file" && argv[i + 1]) {
      out.reportFile = argv[i + 1];
      i += 1;
    } else if (arg === "--allow-fail") {
      out.allowFail = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node record-cda-verify-snapshot.mjs [--root <cda_extracted>] [--out-dir <dir>] [--report-file <verify-report.json>] [--allow-fail] [--json]",
    "",
    "Behavior:",
    "- Uses provided verify report file, or runs verify-cda-repro.mjs --json",
    "- Writes snapshot JSON + index JSONL + latest.json",
    "- Returns non-zero when verify fails unless --allow-fail is set",
  ].join("\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function sha256Bytes(data) {
  const h = crypto.createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function stableWrite(file, content) {
  const next = Buffer.from(content, "utf8");
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (Buffer.compare(prev, next) === 0) return "skipped";
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, next);
  return "written";
}

function nowIsoUtc() {
  return new Date().toISOString();
}

function tsCompact(iso) {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function runVerify(root) {
  const verifyScript = path.resolve("verify-cda-repro.mjs");
  const child = spawnSync(process.execPath, [verifyScript, "--root", root, "--json"], {
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(child.stdout || "{}");
  } catch (err) {
    throw new Error(`verify-cda-repro output was not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.passed !== "boolean") {
    throw new Error("verify-cda-repro JSON missing required fields");
  }
  return parsed;
}

function buildFingerprint(root) {
  const paths = {
    manifestSummary: path.join(root, "manifest", "summary.json"),
    manifestTags: path.join(root, "manifest", "tags.jsonl"),
    manifestArtifacts: path.join(root, "manifest", "artifacts.jsonl"),
    cloneSummary: path.join(root, "clone_workspace", "manifest", "clone_summary.json"),
  };
  for (const [key, p] of Object.entries(paths)) {
    if (!fs.existsSync(p)) throw new Error(`Missing canonical file for fingerprint (${key}): ${p}`);
  }
  return {
    manifestSummarySha256: sha256File(paths.manifestSummary),
    manifestTagsSha256: sha256File(paths.manifestTags),
    manifestArtifactsSha256: sha256File(paths.manifestArtifacts),
    cloneSummarySha256: sha256File(paths.cloneSummary),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const outDir = path.resolve(args.outDir);
  ensureDir(outDir);

  const verifyResult = args.reportFile ? readJson(path.resolve(args.reportFile)) : runVerify(root);
  if (typeof verifyResult.passed !== "boolean") {
    throw new Error("verify report missing boolean `passed`");
  }

  const fingerprint = buildFingerprint(root);
  const createdAt = nowIsoUtc();
  const stamp = tsCompact(createdAt);

  const indexPath = path.join(outDir, "index.jsonl");
  const previousRows = readJsonl(indexPath);
  const previous = previousRows.length > 0 ? previousRows[previousRows.length - 1] : null;
  const previousSnapshotSha256 = previous ? previous.snapshotSha256 : null;

  const snapshot = {
    createdAt,
    root,
    verifyResult,
    fingerprint,
    previousSnapshotSha256,
  };
  const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;
  const snapshotSha256 = sha256Bytes(snapshotJson);
  snapshot.snapshotSha256 = snapshotSha256;

  const snapshotFileName = `snapshot_${stamp}_${snapshotSha256.slice(0, 12)}.json`;
  const snapshotPath = path.join(outDir, snapshotFileName);
  const snapshotWrite = stableWrite(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const indexEntry = {
    createdAt,
    snapshotFile: snapshotFileName,
    snapshotSha256,
    previousSnapshotSha256,
    passed: verifyResult.passed,
    checkCount: Number(verifyResult?.stats?.checkCount || 0),
    failCount: Number(verifyResult?.stats?.failCount || 0),
  };
  const nextIndex = [...previousRows, indexEntry].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const indexWrite = stableWrite(indexPath, nextIndex);

  const latestPath = path.join(outDir, "latest.json");
  const latestWrite = stableWrite(latestPath, `${JSON.stringify(indexEntry, null, 2)}\n`);

  const result = {
    root,
    outDir,
    verifyPassed: verifyResult.passed,
    snapshotFile: snapshotFileName,
    snapshotSha256,
    previousSnapshotSha256,
    writes: {
      snapshot: snapshotWrite,
      index: indexWrite,
      latest: latestWrite,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("CDA verification snapshot recorded.");
    console.log(`- snapshot: ${snapshotPath}`);
    console.log(`- sha256:   ${snapshotSha256}`);
    console.log(`- passed:   ${verifyResult.passed}`);
  }

  if (!verifyResult.passed && !args.allowFail) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`[record-cda-verify-snapshot] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
