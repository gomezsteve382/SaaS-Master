#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      args.root = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node build-cda-clone-workspace.mjs [--root <cda_extracted>]",
    "",
    `Default root: ${DEFAULT_ROOT}`,
  ].join("\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stableWrite(file, content) {
  const next = Buffer.from(content, "utf8");
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (Buffer.compare(prev, next) === 0) {
      return "skipped";
    }
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, next);
  return "written";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sanitizeName(name) {
  const cleaned = (name || "unnamed")
    .replace(/[:\\/*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\w.$-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  return cleaned || "unnamed";
}

function fileSha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function shortDigest(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
}

function parseJsonl(file) {
  const rows = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function copyIfChanged(src, dst) {
  const srcBuf = fs.readFileSync(src);
  if (fs.existsSync(dst)) {
    const dstBuf = fs.readFileSync(dst);
    if (Buffer.compare(srcBuf, dstBuf) === 0) return "skipped";
  }
  ensureDir(path.dirname(dst));
  fs.writeFileSync(dst, srcBuf);
  return "written";
}

function buildFrameWorkspace(root, cloneRoot, framePrefix) {
  const reportDir = path.join(root, "reports");
  const frameDir = path.join(cloneRoot, framePrefix);
  const classMapPath = path.join(reportDir, `${framePrefix}_avm2_class_method_map.json`);
  const methodIndexPath = path.join(reportDir, `${framePrefix}_avm2_method_index.json`);
  const summaryPath = path.join(reportDir, `${framePrefix}_avm2_summary.json`);
  const bytecodeLinesPath = path.join(reportDir, `${framePrefix}_avm2_method_bytecode_lines.jsonl`);
  const bytecodeOutPath = path.join(frameDir, "methods", "method_bytecode_lines.jsonl");

  const classMap = readJson(classMapPath);
  const methodIndex = readJson(methodIndexPath);
  const summary = readJson(summaryPath);
  const bytecodeRows = parseJsonl(bytecodeLinesPath);

  const byMethod = new Map();
  for (const row of bytecodeRows) {
    byMethod.set(row.methodIndex, {
      codeLength: row.codeLength,
      codeSha256: row.codeSha256,
      bytecodeLineCount: row.bytecodeLines.length,
    });
  }

  const methodsDoc = {
    frame: framePrefix,
    generatedBy: "build-cda-clone-workspace.mjs",
    abcPath: summary.abcPath,
    methodCount: methodIndex.methods.length,
    methodWithBodyCount: methodIndex.methods.filter((m) => m.hasBody).length,
    methods: methodIndex.methods.map((m) => ({
      index: m.index,
      name: m.name,
      paramCount: m.paramCount,
      paramTypes: m.paramTypes,
      returnType: m.returnType,
      hasBody: m.hasBody,
      codeLength: m.codeLength,
      maxStack: m.maxStack,
      localCount: m.localCount,
      exceptionCount: m.exceptionCount,
      refs: m.refs,
      bytecode: byMethod.get(m.index) || null,
    })),
  };

  const classIndex = [];
  const classDir = path.join(frameDir, "classes");
  ensureDir(classDir);

  for (const cls of classMap.classes) {
    const fileName = `class_${String(cls.classIndex).padStart(4, "0")}_${shortDigest(
      cls.className
    )}.json`;
    const classFile = path.join(classDir, fileName);
    const enrichMember = (member) => ({
      ...member,
      bytecode: byMethod.get(member.methodIndex) || null,
    });
    const classDoc = {
      frame: framePrefix,
      generatedBy: "build-cda-clone-workspace.mjs",
      classIndex: cls.classIndex,
      className: cls.className,
      classNameNormalized: cls.classNameNormalized,
      superName: cls.superName,
      superNameNormalized: cls.superNameNormalized,
      domainBucket: cls.domainBucket,
      flags: cls.flags,
      interfaces: cls.interfaces,
      iinitMethod: cls.iinitMethod,
      cinitMethod: cls.cinitMethod,
      iinitBytecode: byMethod.get(cls.iinitMethod) || null,
      cinitBytecode: byMethod.get(cls.cinitMethod) || null,
      instanceMembers: cls.instanceMembers.map(enrichMember),
      staticMembers: cls.staticMembers.map(enrichMember),
    };
    stableWrite(classFile, `${JSON.stringify(classDoc, null, 2)}\n`);
    classIndex.push({
      classIndex: cls.classIndex,
      className: cls.className,
      classNameNormalized: cls.classNameNormalized,
      domainBucket: cls.domainBucket,
      file: path.relative(cloneRoot, classFile).replace(/\\/g, "/"),
      instanceMemberCount: cls.instanceMembers.length,
      staticMemberCount: cls.staticMembers.length,
    });
  }

  const writes = {
    methods: stableWrite(
      path.join(frameDir, "methods", "method_index_enriched.json"),
      `${JSON.stringify(methodsDoc, null, 2)}\n`
    ),
    classIndex: stableWrite(
      path.join(frameDir, "classes", "class_index.json"),
      `${JSON.stringify(
        {
          frame: framePrefix,
          classCount: classIndex.length,
          classes: classIndex,
        },
        null,
        2
      )}\n`
    ),
    bytecodeLines: copyIfChanged(bytecodeLinesPath, bytecodeOutPath),
    summary: stableWrite(
      path.join(frameDir, "frame_summary.json"),
      `${JSON.stringify(
        {
          frame: framePrefix,
          source: {
            classMapPath,
            methodIndexPath,
            summaryPath,
            bytecodeLinesPath,
          },
          counts: summary.counts,
          topNamespaces: summary.topNamespaces,
          domainBuckets: summary.domainBuckets,
        },
        null,
        2
      )}\n`
    ),
  };

  const smoke = {
    methodsExpectedWithBody: summary.counts.methodWithBodyCount,
    methodBytecodeRows: bytecodeRows.length,
    methodRowCountMatches: summary.counts.methodWithBodyCount === bytecodeRows.length,
    classCount: classMap.classes.length,
  };

  return {
    frame: framePrefix,
    paths: {
      classMapPath,
      methodIndexPath,
      summaryPath,
      bytecodeLinesPath,
      frameDir,
    },
    counts: {
      methods: summary.counts.methodCount,
      methodsWithBody: summary.counts.methodWithBodyCount,
      classes: classMap.classes.length,
    },
    writes,
    smoke,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const cloneRoot = path.join(root, "clone_workspace");
  ensureDir(cloneRoot);

  const summary = readJson(path.join(root, "manifest", "summary.json"));
  const tags = path.join(root, "manifest", "tags.jsonl");
  const artifacts = path.join(root, "manifest", "artifacts.jsonl");
  const mapsDir = path.join(root, "maps");

  const frame1 = buildFrameWorkspace(root, cloneRoot, "frame1");
  const frame2 = buildFrameWorkspace(root, cloneRoot, "frame2");

  const sharedWrites = {
    manifestSummary: copyIfChanged(
      path.join(root, "manifest", "summary.json"),
      path.join(cloneRoot, "manifest", "summary.json")
    ),
    manifestTags: copyIfChanged(tags, path.join(cloneRoot, "manifest", "tags.jsonl")),
    manifestArtifacts: copyIfChanged(
      artifacts,
      path.join(cloneRoot, "manifest", "artifacts.jsonl")
    ),
    classBindings: copyIfChanged(
      path.join(mapsDir, "class_bindings.json"),
      path.join(cloneRoot, "maps", "class_bindings.json")
    ),
    exportedSymbols: copyIfChanged(
      path.join(mapsDir, "exported_symbols.json"),
      path.join(cloneRoot, "maps", "exported_symbols.json")
    ),
    characterIndex: copyIfChanged(
      path.join(mapsDir, "character_id_index.json"),
      path.join(cloneRoot, "maps", "character_id_index.json")
    ),
    udsSecurityInventory: copyIfChanged(
      path.join(root, "reports", "uds_security_symbol_inventory.json"),
      path.join(cloneRoot, "focus", "uds_security_symbol_inventory.json")
    ),
    udsSecurityInventoryMd: copyIfChanged(
      path.join(root, "reports", "uds_security_symbol_inventory.md"),
      path.join(cloneRoot, "focus", "uds_security_symbol_inventory.md")
    ),
    abcFrame1: copyIfChanged(
      path.join(root, "assets", "doabc", "tag_0006_frame1.abc"),
      path.join(cloneRoot, "source_blobs", "frame1.abc")
    ),
    abcFrame2: copyIfChanged(
      path.join(root, "assets", "doabc", "tag_0367_frame2.abc"),
      path.join(cloneRoot, "source_blobs", "frame2.abc")
    ),
  };

  const cloneSummary = {
    generatedBy: "build-cda-clone-workspace.mjs",
    input: {
      swfPath: summary.input.path,
      swfSha256: summary.input.sha256,
      swfSignature: summary.input.signatureOriginal,
      swfVersion: summary.input.version,
    },
    cloneWorkspace: cloneRoot,
    frames: [frame1, frame2],
    sharedWrites,
    sourceBlobHashes: {
      frame1AbcSha256: fileSha256(path.join(cloneRoot, "source_blobs", "frame1.abc")),
      frame2AbcSha256: fileSha256(path.join(cloneRoot, "source_blobs", "frame2.abc")),
    },
    overallSmoke: {
      frame1BytecodeCoverage: frame1.smoke.methodRowCountMatches,
      frame2BytecodeCoverage: frame2.smoke.methodRowCountMatches,
      swfTagCount: summary.completeness.parsedTagCount,
      parseErrorCount: summary.completeness.parseErrorCount,
    },
  };

  const cloneSummaryPath = path.join(cloneRoot, "manifest", "clone_summary.json");
  const cloneSummaryWrite = stableWrite(cloneSummaryPath, `${JSON.stringify(cloneSummary, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        root,
        cloneRoot,
        cloneSummaryPath,
        cloneSummaryWrite,
        frame1: frame1.counts,
        frame2: frame2.counts,
        smoke: cloneSummary.overallSmoke,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(
    `[build-cda-clone-workspace] ${err && err.message ? err.message : String(err)}`
  );
  process.exitCode = 1;
}
