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
    "  node extract-abc-symbols.mjs [--root <cda_extracted-path>]",
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
  fs.writeFileSync(file, next);
  return "written";
}

function extractAsciiUtf8Strings(buf, minLen = 4) {
  const out = [];
  let current = [];
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    const printableAscii =
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2e || // .
      b === 0x5f || // _
      b === 0x24 || // $
      b === 0x2f || // /
      b === 0x3a || // :
      b === 0x2d; // -
    if (printableAscii) {
      current.push(b);
    } else {
      if (current.length >= minLen) {
        out.push(Buffer.from(current).toString("utf8"));
      }
      current = [];
    }
  }
  if (current.length >= minLen) {
    out.push(Buffer.from(current).toString("utf8"));
  }
  return out;
}

function isLikelyQualifiedName(s) {
  return /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){1,}$/.test(s);
}

function isLikelyPackagePath(s) {
  return /^[A-Za-z_][A-Za-z0-9_$/.-]{3,}$/.test(s);
}

function countByPrefix(values, segments = 3) {
  const m = new Map();
  for (const v of values) {
    const p = v.split(".");
    const key = p.length >= segments ? p.slice(0, segments).join(".") : v;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return [...m.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count);
}

function renderMarkdown(index) {
  const lines = [];
  lines.push("# ABC Symbol Index");
  lines.push("");
  lines.push(`- Root: \`${index.root}\``);
  lines.push(`- ABC files scanned: ${index.stats.abcFilesScanned}`);
  lines.push(`- Total extracted strings: ${index.stats.totalStrings}`);
  lines.push(`- Likely qualified class/package names: ${index.stats.qualifiedNameCount}`);
  lines.push(`- Distinct qualified names: ${index.stats.distinctQualifiedNameCount}`);
  lines.push("");
  lines.push("## Top Namespaces");
  for (const row of index.stats.topNamespacePrefixes) {
    lines.push(`- ${row.prefix}: ${row.count}`);
  }
  lines.push("");
  lines.push("## Top Qualified Names");
  for (const row of index.stats.topQualifiedNames) {
    lines.push(`- ${row.name}: ${row.count}`);
  }
  lines.push("");
  lines.push("## Source Files");
  for (const src of index.sources) {
    lines.push(
      `- ${src.file}: ${src.byteLength} bytes, ${src.totalStrings} strings, ${src.qualifiedNameCount} qualified names`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const abcDir = path.join(root, "assets", "doabc");
  const reportsDir = path.join(root, "reports");
  ensureDir(reportsDir);

  if (!fs.existsSync(abcDir)) {
    throw new Error(`ABC directory not found: ${abcDir}`);
  }

  const abcFiles = fs
    .readdirSync(abcDir)
    .filter((f) => f.toLowerCase().endsWith(".abc"))
    .sort();

  const allQualified = [];
  const allStrings = [];
  const sources = [];

  for (const file of abcFiles) {
    const abs = path.join(abcDir, file);
    const buf = fs.readFileSync(abs);
    const strings = extractAsciiUtf8Strings(buf, 4);
    const qualified = strings.filter(isLikelyQualifiedName);
    const packageLike = strings.filter((s) => !isLikelyQualifiedName(s) && isLikelyPackagePath(s));
    allStrings.push(...strings);
    allQualified.push(...qualified);
    sources.push({
      file: `assets/doabc/${file}`,
      byteLength: buf.length,
      totalStrings: strings.length,
      qualifiedNameCount: qualified.length,
      packageLikeCount: packageLike.length,
      sampleQualifiedNames: [...new Set(qualified)].sort().slice(0, 50),
      samplePackageLike: [...new Set(packageLike)].sort().slice(0, 50),
    });
  }

  const qualifiedCountMap = new Map();
  for (const q of allQualified) {
    qualifiedCountMap.set(q, (qualifiedCountMap.get(q) || 0) + 1);
  }
  const topQualifiedNames = [...qualifiedCountMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);

  const distinctQualified = [...new Set(allQualified)].sort();
  const topNamespacePrefixes = countByPrefix(distinctQualified, 3).slice(0, 50);

  const index = {
    root,
    stats: {
      abcFilesScanned: abcFiles.length,
      totalStrings: allStrings.length,
      qualifiedNameCount: allQualified.length,
      distinctQualifiedNameCount: distinctQualified.length,
      topNamespacePrefixes,
      topQualifiedNames,
    },
    sources,
    distinctQualifiedNames: distinctQualified,
  };

  const jsonStatus = stableWrite(
    path.join(reportsDir, "abc_symbol_index.json"),
    `${JSON.stringify(index, null, 2)}\n`
  );
  const mdStatus = stableWrite(path.join(reportsDir, "abc_symbol_index.md"), renderMarkdown(index));

  console.log(
    JSON.stringify(
      {
        root,
        outputs: {
          json: "reports/abc_symbol_index.json",
          markdown: "reports/abc_symbol_index.md",
        },
        writeStatus: {
          json: jsonStatus,
          markdown: mdStatus,
        },
        stats: index.stats,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[extract-abc-symbols] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
