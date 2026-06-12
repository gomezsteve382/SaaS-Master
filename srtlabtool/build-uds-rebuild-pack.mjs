#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      out.root = argv[i + 1];
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
    "  node build-uds-rebuild-pack.mjs [--root <cda_extracted>]",
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
    if (Buffer.compare(prev, next) === 0) return "skipped";
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, next);
  return "written";
}

function tagBucket(row) {
  const text = `${row.className} ${row.traitName}`.toLowerCase();
  if (text.includes("securitygateway")) return "security_gateway";
  if (text.includes("uds")) return "uds";
  if (text.includes("secretkey") || text.includes("accesskey") || text.includes("securitykey"))
    return "crypto_key";
  if (text.includes("unlock")) return "unlock";
  if (text.includes("challenge")) return "challenge";
  if (text.includes("seed")) return "seed";
  return "other";
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const srcPath = path.join(
    root,
    "clone_workspace",
    "focus",
    "uds_security_methods_with_bytecode.json"
  );
  const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  const methods = src.methods || [];

  const classMap = new Map();
  const bucketCounts = new Map();

  for (const m of methods) {
    const bucket = tagBucket(m);
    bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
    const codeLength = m.signature?.codeLength || 0;
    const scoreAdd = 10 + codeLength;
    if (!classMap.has(m.className)) {
      classMap.set(m.className, {
        className: m.className,
        buckets: new Map(),
        methodCount: 0,
        totalCodeLength: 0,
        priorityScore: 0,
        methods: [],
      });
    }
    const entry = classMap.get(m.className);
    entry.methodCount += 1;
    entry.totalCodeLength += codeLength;
    entry.priorityScore += scoreAdd;
    entry.buckets.set(bucket, (entry.buckets.get(bucket) || 0) + 1);
    entry.methods.push({
      traitName: m.traitName,
      traitKind: m.traitKind,
      methodIndex: m.methodIndex,
      bucket,
      signature: m.signature,
      bytecode: m.bytecode
        ? {
            codeSha256: m.bytecode.codeSha256,
            codeLength: m.signature?.codeLength || 0,
            bytecodeLineCount: (m.bytecode.bytecodeLines || []).length,
          }
        : null,
    });
  }

  const classes = [...classMap.values()]
    .map((c) => ({
      className: c.className,
      methodCount: c.methodCount,
      totalCodeLength: c.totalCodeLength,
      priorityScore: c.priorityScore,
      buckets: [...c.buckets.entries()]
        .map(([bucket, count]) => ({ bucket, count }))
        .sort((a, b) => b.count - a.count),
      methods: c.methods.sort(
        (a, b) => (b.signature?.codeLength || 0) - (a.signature?.codeLength || 0)
      ),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore);

  const backlog = {
    generatedBy: "build-uds-rebuild-pack.mjs",
    source: srcPath,
    summary: {
      methodCount: methods.length,
      classCount: classes.length,
      bucketCounts: [...bucketCounts.entries()]
        .map(([bucket, count]) => ({ bucket, count }))
        .sort((a, b) => b.count - a.count),
    },
    topClasses: classes.slice(0, 50),
    classes,
  };

  const reportsDir = path.join(root, "reports");
  const outJson = path.join(reportsDir, "uds_rebuild_backlog.json");
  const outMd = path.join(reportsDir, "uds_rebuild_backlog.md");

  const md = [];
  md.push("# UDS + Security Rebuild Backlog");
  md.push("");
  md.push(`- Methods in focus set: ${backlog.summary.methodCount}`);
  md.push(`- Classes in focus set: ${backlog.summary.classCount}`);
  md.push("");
  md.push("## Buckets");
  for (const b of backlog.summary.bucketCounts) {
    md.push(`- ${b.bucket}: ${b.count}`);
  }
  md.push("");
  md.push("## Top Classes");
  for (const c of backlog.topClasses.slice(0, 25)) {
    const primaryBucket = c.buckets[0]?.bucket || "other";
    md.push(
      `- ${c.className} (${primaryBucket}) -> methods=${c.methodCount}, codeLen=${c.totalCodeLength}, score=${c.priorityScore}`
    );
  }
  md.push("");

  const writes = {
    json: stableWrite(outJson, `${JSON.stringify(backlog, null, 2)}\n`),
    markdown: stableWrite(outMd, `${md.join("\n")}\n`),
  };

  console.log(
    JSON.stringify(
      {
        outputs: {
          json: path.relative(root, outJson).replace(/\\/g, "/"),
          markdown: path.relative(root, outMd).replace(/\\/g, "/"),
        },
        writes,
        summary: backlog.summary,
        topClasses: backlog.topClasses.slice(0, 10).map((c) => ({
          className: c.className,
          methodCount: c.methodCount,
          totalCodeLength: c.totalCodeLength,
          priorityScore: c.priorityScore,
        })),
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[build-uds-rebuild-pack] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
