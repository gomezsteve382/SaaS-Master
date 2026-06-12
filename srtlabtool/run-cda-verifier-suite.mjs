#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      out.root = argv[i + 1];
      i += 1;
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
    "  node run-cda-verifier-suite.mjs [--root <cda_extracted>] [--json]",
    "",
    "Runs:",
    "  1) Baseline pass",
    "  2) Hash tamper fail",
    "  3) Count tamper fail",
    "  4) AVM2 coverage tamper fail",
    "  5) Final pass",
  ].join("\n");
}

function runVerifier(root) {
  const script = path.resolve("verify-cda-repro.mjs");
  const child = spawnSync(process.execPath, [script, "--root", root, "--json"], {
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(child.stdout || "{}");
  } catch (_err) {
    parsed = null;
  }
  return {
    exitCode: child.status ?? 1,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    result: parsed,
  };
}

function withBackupMutate(file, mutateFn) {
  const before = fs.readFileSync(file);
  try {
    mutateFn(before);
  } finally {
    fs.writeFileSync(file, before);
  }
}

function ensure(cond, message) {
  if (!cond) throw new Error(message);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(args.root);

  const suite = {
    root,
    passed: true,
    scenarios: [],
  };

  const baseline = runVerifier(root);
  suite.scenarios.push({
    name: "baseline_pass",
    expectedExitCode: 0,
    actualExitCode: baseline.exitCode,
    passed: baseline.exitCode === 0,
  });

  const hashTarget = path.join(root, "tags", "raw", "tag_0000_069_fileattributes.bin");
  let hashExit = 1;
  withBackupMutate(hashTarget, (before) => {
    const next = Buffer.from(before);
    next[0] = next[0] ^ 0x01;
    fs.writeFileSync(hashTarget, next);
    hashExit = runVerifier(root).exitCode;
  });
  suite.scenarios.push({
    name: "hash_tamper_fail",
    expectedExitCode: 1,
    actualExitCode: hashExit,
    passed: hashExit === 1,
  });

  const countTarget = path.join(root, "manifest", "artifacts.jsonl");
  let countExit = 1;
  withBackupMutate(countTarget, (before) => {
    const lines = before.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
    const trimmed = `${lines.slice(1).join("\n")}\n`;
    fs.writeFileSync(countTarget, trimmed, "utf8");
    countExit = runVerifier(root).exitCode;
  });
  suite.scenarios.push({
    name: "count_tamper_fail",
    expectedExitCode: 1,
    actualExitCode: countExit,
    passed: countExit === 1,
  });

  const coverageTarget = path.join(root, "reports", "frame1_avm2_method_bytecode_lines.jsonl");
  let coverageExit = 1;
  withBackupMutate(coverageTarget, (before) => {
    const lines = before.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
    const trimmed = `${lines.slice(1).join("\n")}\n`;
    fs.writeFileSync(coverageTarget, trimmed, "utf8");
    coverageExit = runVerifier(root).exitCode;
  });
  suite.scenarios.push({
    name: "coverage_tamper_fail",
    expectedExitCode: 1,
    actualExitCode: coverageExit,
    passed: coverageExit === 1,
  });

  const finalPass = runVerifier(root);
  suite.scenarios.push({
    name: "final_pass",
    expectedExitCode: 0,
    actualExitCode: finalPass.exitCode,
    passed: finalPass.exitCode === 0,
  });

  suite.passed = suite.scenarios.every((s) => s.passed);
  ensure(suite.passed, "One or more suite scenarios failed");

  if (args.json) {
    console.log(JSON.stringify(suite, null, 2));
  } else {
    console.log("CDA verifier suite passed.");
    for (const s of suite.scenarios) {
      console.log(`- PASS: ${s.name} (exit=${s.actualExitCode})`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[run-cda-verifier-suite] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
