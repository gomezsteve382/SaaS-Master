#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

function parseArgs(argv) {
  const out = {
    root: DEFAULT_ROOT,
    json: false,
    outFile: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      out.root = argv[i + 1];
      i += 1;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--out" && argv[i + 1]) {
      out.outFile = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node verify-cda-repro.mjs [--root <cda_extracted>] [--json] [--out <report.json>]",
    "",
    `Default root: ${DEFAULT_ROOT}`,
  ].join("\n");
}

function stableWrite(file, content) {
  const next = Buffer.from(content, "utf8");
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (Buffer.compare(prev, next) === 0) return "skipped";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return "written";
}

function existsOrFail(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`${label} missing: ${file}`);
  }
}

function readJson(file, label) {
  existsOrFail(file, label);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${file} (${err.message})`);
  }
}

function readJsonl(file, label) {
  existsOrFail(file, label);
  const rows = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${label} invalid JSONL row (${err.message}) in ${file}`);
    }
  }
  return rows;
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function countNonEmptyLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  let c = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) c += 1;
  }
  return c;
}

function fail(checks, failures, name, details) {
  checks.push({ name, ok: false, details });
  failures.push({ name, details });
  throw new Error(`${name}: ${details}`);
}

function pass(checks, name, details) {
  checks.push({ name, ok: true, details });
}

function verify(root) {
  const checks = [];
  const failures = [];
  const startMs = Date.now();

  const summaryPath = path.join(root, "manifest", "summary.json");
  const tagsPath = path.join(root, "manifest", "tags.jsonl");
  const artifactsPath = path.join(root, "manifest", "artifacts.jsonl");

  const frame1SummaryPath = path.join(root, "reports", "frame1_avm2_summary.json");
  const frame2SummaryPath = path.join(root, "reports", "frame2_avm2_summary.json");
  const frame1BytecodePath = path.join(root, "reports", "frame1_avm2_method_bytecode_lines.jsonl");
  const frame2BytecodePath = path.join(root, "reports", "frame2_avm2_method_bytecode_lines.jsonl");

  const cloneSummaryPath = path.join(root, "clone_workspace", "manifest", "clone_summary.json");
  const focusUdsPath = path.join(
    root,
    "clone_workspace",
    "focus",
    "uds_security_methods_with_bytecode.json"
  );
  const focusBacklogPath = path.join(
    root,
    "clone_workspace",
    "focus",
    "uds_rebuild_backlog.json"
  );

  try {
    const summary = readJson(summaryPath, "manifest summary");
    const tagRows = readJsonl(tagsPath, "tags manifest");
    const artifactRows = readJsonl(artifactsPath, "artifacts manifest");
    pass(checks, "manifest.presence_shape", "summary/tags/artifacts manifests parsed");

    const integrity = summary.integrity || {};
    const completeness = summary.completeness || {};
    const reproducibility = summary.reproducibility || {};

    if (integrity.decompressedBodyLengthMatchesHeader !== true) {
      fail(
        checks,
        failures,
        "summary.integrity.decompressed_length",
        "decompressedBodyLengthMatchesHeader !== true"
      );
    }
    if (integrity.tagWalkReachedEndTag !== true) {
      fail(checks, failures, "summary.integrity.end_tag", "tagWalkReachedEndTag !== true");
    }
    if (Number(completeness.parseErrorCount) !== 0) {
      fail(
        checks,
        failures,
        "summary.integrity.parse_error_count",
        `parseErrorCount=${completeness.parseErrorCount}`
      );
    }
    pass(checks, "summary.integrity_flags", "integrity flags and parseErrorCount are valid");

    const parsedTagCount = Number(completeness.parsedTagCount);
    const rawTagPayloadExportCount = Number(completeness.rawTagPayloadExportCount);
    const totalArtifacts = Number(reproducibility.totalArtifacts);

    if (parsedTagCount !== rawTagPayloadExportCount) {
      fail(
        checks,
        failures,
        "counts.summary_tag_raw_match",
        `parsedTagCount=${parsedTagCount}, rawTagPayloadExportCount=${rawTagPayloadExportCount}`
      );
    }
    const tagLines = countNonEmptyLines(tagsPath);
    if (tagLines !== parsedTagCount) {
      fail(
        checks,
        failures,
        "counts.tags_jsonl_line_count",
        `lineCount=${tagLines}, parsedTagCount=${parsedTagCount}`
      );
    }
    const artifactLines = countNonEmptyLines(artifactsPath);
    if (artifactLines !== totalArtifacts) {
      fail(
        checks,
        failures,
        "counts.artifacts_jsonl_line_count",
        `lineCount=${artifactLines}, totalArtifacts=${totalArtifacts}`
      );
    }
    pass(checks, "counts.consistency", "summary counts align with JSONL line counts");

    const doAbcTags = tagRows.filter((r) => Number(r.code) === 82).map((r) => Number(r.index));
    const binaryTags = tagRows.filter((r) => Number(r.code) === 87).map((r) => Number(r.index));
    const artifactTagSet = new Set(
      artifactRows
        .map((r) => r.sourceTagIndex)
        .filter((v) => v !== null && v !== undefined)
        .map((v) => Number(v))
    );
    const missingDoAbc = doAbcTags.filter((idx) => !artifactTagSet.has(idx));
    const missingBinary = binaryTags.filter((idx) => !artifactTagSet.has(idx));
    if (missingDoAbc.length > 0) {
      fail(
        checks,
        failures,
        "coverage.doabc_artifacts",
        `missing artifacts for DoABC tag indexes: ${missingDoAbc.join(",")}`
      );
    }
    if (missingBinary.length > 0) {
      fail(
        checks,
        failures,
        "coverage.definebinarydata_artifacts",
        `missing artifacts for DefineBinaryData tag indexes: ${missingBinary.join(",")}`
      );
    }
    pass(checks, "coverage.required_tags", "DoABC and DefineBinaryData tags have artifact rows");

    for (const row of artifactRows) {
      const rel = row.path;
      const expected = String(row.sha256 || "").toLowerCase();
      const abs = path.join(root, rel);
      existsOrFail(abs, `artifact file (${rel})`);
      const actual = sha256File(abs).toLowerCase();
      if (actual !== expected) {
        fail(
          checks,
          failures,
          "artifact.hash_integrity",
          `hash mismatch for ${rel}: expected ${expected}, got ${actual}`
        );
      }
    }
    pass(
      checks,
      "artifact.hash_integrity",
      `validated ${artifactRows.length} artifact hashes against artifacts.jsonl`
    );

    const frame1Summary = readJson(frame1SummaryPath, "frame1 summary");
    const frame2Summary = readJson(frame2SummaryPath, "frame2 summary");
    const frame1Rows = readJsonl(frame1BytecodePath, "frame1 bytecode lines");
    const frame2Rows = readJsonl(frame2BytecodePath, "frame2 bytecode lines");
    const frame1Expected = Number(frame1Summary?.counts?.methodWithBodyCount);
    const frame2Expected = Number(frame2Summary?.counts?.methodWithBodyCount);
    if (frame1Rows.length !== frame1Expected) {
      fail(
        checks,
        failures,
        "avm2.bytecode_coverage_frame1",
        `rowCount=${frame1Rows.length}, expected=${frame1Expected}`
      );
    }
    if (frame2Rows.length !== frame2Expected) {
      fail(
        checks,
        failures,
        "avm2.bytecode_coverage_frame2",
        `rowCount=${frame2Rows.length}, expected=${frame2Expected}`
      );
    }
    pass(checks, "avm2.bytecode_coverage", "frame1/frame2 method-body coverage matches");

    const cloneSummary = readJson(cloneSummaryPath, "clone summary");
    for (const frame of cloneSummary.frames || []) {
      // The clone summary records `paths.frameDir` as an absolute
      // authoring-machine path (Windows, e.g. C:\Users\...). Resolve the
      // frame dir relative to `root` so the verifier is portable across
      // machines / CI; only fall back to the recorded absolute path when the
      // relative one doesn't exist. (The frame name — "frame1"/"frame2" — is
      // the directory under clone_workspace; basename of the recorded path is
      // the cross-platform fallback for the segment.)
      const recordedFrameDir = frame?.paths?.frameDir;
      const frameSeg = frame.frame ||
        (recordedFrameDir && path.basename(recordedFrameDir.replace(/\\/g, "/")));
      const relFrameDir = frameSeg
        ? path.join(root, "clone_workspace", frameSeg)
        : null;
      const frameDir = (relFrameDir && fs.existsSync(relFrameDir))
        ? relFrameDir
        : recordedFrameDir;
      if (!frameDir) {
        fail(checks, failures, "clone.frame_paths", "frameDir missing in clone summary");
      }
      const classIndexPath = path.join(frameDir, "classes", "class_index.json");
      const classIndex = readJson(classIndexPath, `clone class index (${frame.frame})`);
      const expectedClassCount = Number(frame?.counts?.classes);
      const indexClassCount = Number(classIndex?.classCount);
      const listedClassCount = Array.isArray(classIndex?.classes) ? classIndex.classes.length : -1;
      if (indexClassCount !== expectedClassCount || listedClassCount !== expectedClassCount) {
        fail(
          checks,
          failures,
          `clone.class_count_${frame.frame}`,
          `expected=${expectedClassCount}, classIndex.classCount=${indexClassCount}, classIndex.classes.length=${listedClassCount}`
        );
      }
      const classFiles = fs
        .readdirSync(path.join(frameDir, "classes"), { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json") && d.name !== "class_index.json").length;
      if (classFiles !== expectedClassCount) {
        fail(
          checks,
          failures,
          `clone.class_file_count_${frame.frame}`,
          `classFileCount=${classFiles}, expected=${expectedClassCount}`
        );
      }
    }
    existsOrFail(focusUdsPath, "clone strict focus uds_security_methods_with_bytecode");
    existsOrFail(focusBacklogPath, "clone strict focus uds_rebuild_backlog");
    pass(checks, "clone.workspace_consistency", "clone workspace frame/focus checks passed");
  } catch (err) {
    return {
      passed: false,
      root,
      checks,
      failures: failures.length > 0 ? failures : [{ name: "fatal", details: err.message }],
      error: err.message,
      stats: {
        checkCount: checks.length,
        passCount: checks.filter((c) => c.ok).length,
        failCount: checks.filter((c) => !c.ok).length,
        durationMs: Date.now() - startMs,
      },
    };
  }

  return {
    passed: true,
    root,
    checks,
    failures: [],
    stats: {
      checkCount: checks.length,
      passCount: checks.filter((c) => c.ok).length,
      failCount: 0,
      durationMs: Date.now() - startMs,
    },
  };
}

function printHuman(result) {
  if (result.passed) {
    console.log("CDA reproducibility verification passed.");
    for (const c of result.checks) {
      console.log(`- PASS: ${c.name} (${c.details})`);
    }
    return;
  }
  console.error("CDA reproducibility verification failed.");
  for (const c of result.checks) {
    const prefix = c.ok ? "PASS" : "FAIL";
    console.error(`- ${prefix}: ${c.name} (${c.details})`);
  }
  if (result.error) {
    console.error(`Error: ${result.error}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(args.root);
  const result = verify(root);
  if (args.outFile) {
    const outPath = path.resolve(args.outFile);
    const writeStatus = stableWrite(outPath, `${JSON.stringify(result, null, 2)}\n`);
    result.report = {
      outPath,
      writeStatus,
    };
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`[verify-cda-repro] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
