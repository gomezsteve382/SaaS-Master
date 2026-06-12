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
    "  node build-cda-audit.mjs [--root <cda_extracted-path>]",
    "",
    `Default root: ${DEFAULT_ROOT}`,
  ].join("\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stableWrite(file, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (Buffer.compare(prev, next) === 0) {
      return "skipped";
    }
  }
  fs.writeFileSync(file, next);
  return "written";
}

function topN(list, n, key) {
  return [...list].sort((a, b) => b[key] - a[key]).slice(0, n);
}

function magicKindFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  if (ext === ".swf") return "swf";
  if (ext === ".zip") return "zip";
  if (ext === ".abc") return "abc";
  if (ext === ".zlib") return "zlib";
  if (ext === ".raw") return "raw";
  if (ext === ".bin") return "bin";
  return ext.replace(/^\./, "") || "unknown";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# CDA.swf Audit Report");
  lines.push("");
  lines.push("## Input");
  lines.push(`- SWF path: \`${report.input.path}\``);
  lines.push(`- SHA-256: \`${report.input.sha256}\``);
  lines.push(
    `- Compression: \`${report.input.signatureOriginal}\` (version ${report.input.version}), size ${report.input.compressedFileLength} bytes -> ${report.input.decompressedBodyLength} bytes`
  );
  lines.push("");
  lines.push("## Integrity");
  lines.push(
    `- Decompression check: ${report.integrity.decompressedBodyLengthMatchesHeader ? "PASS" : "FAIL"}`
  );
  lines.push(`- End-tag traversal: ${report.integrity.tagWalkReachedEndTag ? "PASS" : "FAIL"}`);
  lines.push(`- Parse errors: ${report.completeness.parseErrorCount}`);
  lines.push("");
  lines.push("## Structure");
  lines.push(`- Total tags: ${report.structure.totalTags}`);
  lines.push(`- Raw payload exports: ${report.structure.rawTagPayloadExportCount}`);
  lines.push(`- Typed tag JSON files: ${report.structure.typedTagJsonCount}`);
  lines.push(`- Total artifacts tracked: ${report.structure.totalArtifactsTracked}`);
  lines.push("");
  lines.push("Top tag codes:");
  for (const row of report.structure.topTagCodes) {
    lines.push(`- ${row.code} (${row.name}): ${row.count}`);
  }
  lines.push("");
  lines.push("## ActionScript / Binary");
  lines.push(`- DoABC tags: ${report.abc.doAbcCount}`);
  for (const row of report.abc.doAbcBlocks) {
    lines.push(
      `- Tag ${row.tagIndex}: script \`${row.scriptName}\`, lazy=${row.lazyInitialize}, ABC bytes=${row.abcDataLength}`
    );
  }
  lines.push(`- DefineBinaryData tags: ${report.binary.defineBinaryDataCount}`);
  for (const row of report.binary.defineBinaryDataBlocks) {
    lines.push(
      `- Tag ${row.tagIndex}, char ${row.characterId}: ${row.dataLength} bytes (\`${row.assetKind}\`)`
    );
  }
  lines.push("");
  lines.push("## Symbol Maps");
  lines.push(`- Class bindings: ${report.symbols.classBindingCount}`);
  lines.push(`- Exported symbols: ${report.symbols.exportedSymbolCount}`);
  lines.push(`- Character IDs with multiple class bindings: ${report.symbols.multiClassCharacterIds.length}`);
  lines.push(`- Character IDs with multiple export names: ${report.symbols.multiExportCharacterIds.length}`);
  lines.push("");
  lines.push("Top class namespaces:");
  for (const ns of report.symbols.topNamespaces) {
    lines.push(`- ${ns.namespace}: ${ns.count}`);
  }
  lines.push("");
  lines.push("Feature keyword counts (class/export names):");
  for (const kw of report.symbols.keywordHeatmap) {
    lines.push(`- ${kw.keyword}: ${kw.count}`);
  }
  if (report.symbols.multiClassCharacterIds.length > 0) {
    lines.push("");
    lines.push("Examples of multi-class character IDs:");
    for (const row of report.symbols.multiClassCharacterIds.slice(0, 10)) {
      lines.push(`- Character ${row.characterId}: ${row.classNames.join(", ")}`);
    }
  }
  if (report.symbols.multiExportCharacterIds.length > 0) {
    lines.push("");
    lines.push("Examples of multi-export character IDs:");
    for (const row of report.symbols.multiExportCharacterIds.slice(0, 10)) {
      lines.push(`- Character ${row.characterId}: ${row.exportNames.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Largest Tag Payloads");
  for (const row of report.structure.largestTagPayloads) {
    lines.push(`- Tag ${row.index}: ${row.code} (${row.name}) -> ${row.payloadLength} bytes`);
  }
  lines.push("");
  lines.push("## Largest Assets");
  for (const row of report.assets.largestAssets) {
    lines.push(`- ${row.path} -> ${row.size} bytes [${row.kind}]`);
  }
  lines.push("");
  lines.push("## Rebuild Notes");
  lines.push("- Use `maps/class_bindings.json` and `maps/exported_symbols.json` as canonical symbol manifests.");
  lines.push("- Prioritize parsing `frame2` ABC block first; it contains the bulk of ActionScript logic.");
  lines.push("- Start module reconstruction from namespaces with highest symbol density (`com.chrysler.*`, then `spark.*`, `mx.*`).");
  lines.push("- Use keyword heatmap to stage workstreams: `buslog`, `proxi`, `ecu`, `flash`, `unlock`, `dtc`.");
  lines.push("- Treat duplicate character ID mappings as intentional SWF overrides unless proven otherwise.");
  lines.push("");
  lines.push("## Suggested Workstreams");
  for (const ws of report.workstreams) {
    lines.push(`- ${ws.name}: priority ${ws.priority} (${ws.rationale})`);
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
  const manifestDir = path.join(root, "manifest");
  const mapsDir = path.join(root, "maps");
  const tagsTypedDir = path.join(root, "tags", "typed");
  const reportsDir = path.join(root, "reports");
  ensureDir(reportsDir);

  const summary = readJson(path.join(manifestDir, "summary.json"));
  const tags = readJsonl(path.join(manifestDir, "tags.jsonl"));
  const artifacts = readJsonl(path.join(manifestDir, "artifacts.jsonl"));
  const classBindings = readJson(path.join(mapsDir, "class_bindings.json")).bindings;
  const exportedSymbols = readJson(path.join(mapsDir, "exported_symbols.json")).exports;

  const tagFrequency = new Map();
  for (const row of tags) {
    const key = `${row.code}:${row.name}`;
    tagFrequency.set(key, (tagFrequency.get(key) || 0) + 1);
  }
  const topTagCodes = [...tagFrequency.entries()]
    .map(([key, count]) => {
      const [code, name] = key.split(":");
      return { code: Number(code), name, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const largestTagPayloads = topN(tags, 20, "payloadLength").map((t) => ({
    index: t.index,
    code: t.code,
    name: t.name,
    payloadLength: t.payloadLength,
  }));

  const doAbcBlocks = [];
  const defineBinaryDataBlocks = [];
  for (const file of fs.readdirSync(tagsTypedDir)) {
    if (file.includes("doabc")) {
      const doc = readJson(path.join(tagsTypedDir, file));
      doAbcBlocks.push({
        file,
        tagIndex: doc.tagIndex,
        scriptName: doc.scriptName,
        lazyInitialize: doc.lazyInitialize,
        abcDataLength: doc.abcDataLength,
        abcArtifactPath: doc.abcArtifactPath,
      });
    }
    if (file.includes("definebinarydata")) {
      const doc = readJson(path.join(tagsTypedDir, file));
      defineBinaryDataBlocks.push({
        file,
        tagIndex: doc.tagIndex,
        characterId: doc.characterId,
        dataLength: doc.dataLength,
        dataArtifactPath: doc.dataArtifactPath,
        assetKind: magicKindFromPath(doc.dataArtifactPath),
      });
    }
  }
  doAbcBlocks.sort((a, b) => a.tagIndex - b.tagIndex);
  defineBinaryDataBlocks.sort((a, b) => a.tagIndex - b.tagIndex);

  const byCharacterClass = new Map();
  for (const b of classBindings) {
    const key = String(b.characterId);
    if (!byCharacterClass.has(key)) byCharacterClass.set(key, new Set());
    byCharacterClass.get(key).add(b.className);
  }
  const multiClassCharacterIds = [...byCharacterClass.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([characterId, set]) => ({
      characterId: Number(characterId),
      classNames: [...set].sort(),
    }))
    .sort((a, b) => a.characterId - b.characterId);

  const byCharacterExport = new Map();
  for (const b of exportedSymbols) {
    const key = String(b.characterId);
    if (!byCharacterExport.has(key)) byCharacterExport.set(key, new Set());
    byCharacterExport.get(key).add(b.exportName);
  }
  const multiExportCharacterIds = [...byCharacterExport.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([characterId, set]) => ({
      characterId: Number(characterId),
      exportNames: [...set].sort(),
    }))
    .sort((a, b) => a.characterId - b.characterId);

  const namespaceCounts = new Map();
  for (const b of classBindings) {
    const parts = b.className.split(".");
    let ns = b.className;
    if (parts.length >= 3) {
      ns = `${parts[0]}.${parts[1]}.${parts[2]}`;
    } else if (parts.length >= 2) {
      ns = `${parts[0]}.${parts[1]}`;
    }
    namespaceCounts.set(ns, (namespaceCounts.get(ns) || 0) + 1);
  }
  const topNamespaces = [...namespaceCounts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const keywords = [
    "buslog",
    "proxi",
    "ecu",
    "flash",
    "unlock",
    "dtc",
    "diagnostic",
    "alignment",
    "sgw",
    "pid",
    "memory",
    "write",
    "read",
    "download",
    "upload",
  ];
  const keywordCounts = new Map(keywords.map((k) => [k, 0]));
  const symbolStrings = [
    ...classBindings.map((b) => b.className.toLowerCase()),
    ...exportedSymbols.map((e) => e.exportName.toLowerCase()),
  ];
  for (const s of symbolStrings) {
    for (const kw of keywords) {
      if (s.includes(kw)) {
        keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
      }
    }
  }
  const keywordHeatmap = [...keywordCounts.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count);

  const largestAssets = topN(artifacts, 25, "size").map((a) => ({
    path: a.path,
    size: a.size,
    kind: magicKindFromPath(a.path),
    sourceTagIndex: a.sourceTagIndex,
    sourceTagCode: a.sourceTagCode,
    sourceTagName: a.sourceTagName,
  }));

  const workstreams = [
    {
      name: "ABC Core Decompilation",
      priority: 1,
      rationale: "Largest logic surface resides in frame2 DoABC block.",
      inputs: doAbcBlocks.map((b) => b.abcArtifactPath),
      successCriteria: [
        "Extract package/class index from ABC",
        "Map function symbols for Chrysler namespaces",
      ],
    },
    {
      name: "Symbol Linking and Overrides",
      priority: 2,
      rationale: "Class and export maps drive runtime binding; duplicate character IDs need explicit handling.",
      inputs: ["maps/class_bindings.json", "maps/exported_symbols.json", "maps/character_id_index.json"],
      successCriteria: [
        "Build canonical characterId -> class/export map",
        "Document override rules for duplicated character IDs",
      ],
    },
    {
      name: "UI Asset Reconstruction",
      priority: 3,
      rationale: "High volume of DefineBitsLossless2 assets and named UI exports indicate heavy skinning surface.",
      inputs: ["assets/definebitslossless2/", "assets/definebitsjpeg2/", "tags/typed/*definebits*.json"],
      successCriteria: [
        "Create asset catalog with dimensions and usage hints",
        "Map critical UI states for buslog/proxi/ecu flows",
      ],
    },
    {
      name: "Domain Feature Surface Mapping",
      priority: 4,
      rationale: "Keyword density points to diagnostic modules (buslog, proxi, ecu, flash).",
      inputs: ["reports/audit.json", "maps/class_bindings.json", "maps/exported_symbols.json"],
      successCriteria: [
        "Produce module list grouped by feature family",
        "Prioritize implementation order for reconstruction",
      ],
    },
    {
      name: "Embedded Binary Payload Triage",
      priority: 5,
      rationale: "Nine DefineBinaryData blobs may contain shaders or auxiliary runtime payloads.",
      inputs: defineBinaryDataBlocks.map((b) => b.dataArtifactPath),
      successCriteria: [
        "Fingerprint each blob type and purpose",
        "Link binary blob character IDs to consuming classes",
      ],
    },
  ];

  const report = {
    generatedFromRoot: root,
    input: summary.input,
    integrity: summary.integrity,
    completeness: summary.completeness,
    structure: {
      totalTags: tags.length,
      rawTagPayloadExportCount: tags.length,
      typedTagJsonCount: fs
        .readdirSync(tagsTypedDir)
        .filter((f) => f.toLowerCase().endsWith(".json")).length,
      totalArtifactsTracked: artifacts.length,
      topTagCodes,
      largestTagPayloads,
    },
    abc: {
      doAbcCount: doAbcBlocks.length,
      doAbcBlocks,
    },
    binary: {
      defineBinaryDataCount: defineBinaryDataBlocks.length,
      defineBinaryDataBlocks,
    },
    symbols: {
      classBindingCount: classBindings.length,
      exportedSymbolCount: exportedSymbols.length,
      multiClassCharacterIds,
      multiExportCharacterIds,
      topNamespaces,
      keywordHeatmap,
    },
    assets: {
      largestAssets,
    },
    workstreams,
  };

  const jsonStatus = stableWrite(
    path.join(reportsDir, "audit.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  const mdStatus = stableWrite(path.join(reportsDir, "audit.md"), renderMarkdown(report));
  const seedStatus = stableWrite(
    path.join(reportsDir, "rebuild_seed.json"),
    `${JSON.stringify({ input: report.input, workstreams }, null, 2)}\n`
  );

  console.log(
    JSON.stringify(
      {
        root,
        reportJson: "reports/audit.json",
        reportMarkdown: "reports/audit.md",
        writeStatus: {
          json: jsonStatus,
        markdown: mdStatus,
        rebuildSeed: seedStatus,
      },
        quickStats: {
          tags: report.structure.totalTags,
          doAbc: report.abc.doAbcCount,
          defineBinaryData: report.binary.defineBinaryDataCount,
          classBindings: report.symbols.classBindingCount,
          exportedSymbols: report.symbols.exportedSymbolCount,
          multiClassCharacterIds: report.symbols.multiClassCharacterIds.length,
          multiExportCharacterIds: report.symbols.multiExportCharacterIds.length,
        },
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[build-cda-audit] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
