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
    "  node build-as3-stubs.mjs [--root <cda_extracted>]",
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

function sanitizeSegment(segment) {
  return (segment || "unnamed")
    .replace(/[^\w$]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "") || "unnamed";
}

function splitClassName(className) {
  const normalized = (className || "").replace(/::/g, ".").replace(/:/g, ".");
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length === 0) return { packageName: "", className: "UnknownClass" };
  const classShortName = sanitizeSegment(parts[parts.length - 1]);
  const packageName = parts.slice(0, -1).map(sanitizeSegment).join(".");
  return { packageName, className: classShortName };
}

function fmtType(typeName) {
  if (!typeName) return "*";
  const t = String(typeName).trim();
  return t || "*";
}

function renderMethodStub(member) {
  const fnName = sanitizeSegment(
    member.traitName.includes(".") ? member.traitName.split(".").slice(-1)[0] : member.traitName
  );
  const params = (member.paramTypes || []).map((t, i) => `p${i}:${fmtType(t)}`).join(", ");
  const returnType = fmtType(member.returnType || "*");
  const kind = member.traitKind || "method";
  const codeSha = member.bytecode?.codeSha256 || "n/a";
  const codeLen =
    member.bytecode?.codeLength ??
    member.codeLength ??
    member.signature?.codeLength ??
    0;

  if (kind === "getter") {
    return [
      `    // methodIndex=${member.methodIndex} codeLen=${codeLen} codeSha256=${codeSha}`,
      `    public function get ${fnName}():${returnType} {`,
      "      return null;",
      "    }",
    ].join("\n");
  }
  if (kind === "setter") {
    return [
      `    // methodIndex=${member.methodIndex} codeLen=${codeLen} codeSha256=${codeSha}`,
      `    public function set ${fnName}(value:${returnType}):void {`,
      "    }",
    ].join("\n");
  }
  return [
    `    // methodIndex=${member.methodIndex} codeLen=${codeLen} codeSha256=${codeSha}`,
    `    public function ${fnName}(${params}):${returnType} {`,
    "      return null;",
    "    }",
  ].join("\n");
}

function renderClassStub(cls) {
  const split = splitClassName(cls.className);
  const superType = fmtType(cls.superName || "Object");
  const isInterface = Boolean(cls.flags?.interface);
  const header = isInterface
    ? `public interface ${split.className}`
    : `public class ${split.className} extends ${superType}`;

  const ifaceList = Array.isArray(cls.interfaces) ? cls.interfaces.filter(Boolean) : [];
  const ifaceSuffix =
    ifaceList.length > 0
      ? `${isInterface ? " extends " : " implements "}${ifaceList.map(fmtType).join(", ")}`
      : "";

  const body = [];
  body.push(`    // classIndex=${cls.classIndex} domainBucket=${cls.domainBucket}`);
  body.push(
    `    // iinitMethod=${cls.iinitMethod} cinitMethod=${cls.cinitMethod} ` +
      `iinitSha=${cls.iinitBytecode?.codeSha256 || "n/a"} cinitSha=${
        cls.cinitBytecode?.codeSha256 || "n/a"
      }`
  );
  if (!isInterface) {
    body.push(`    public function ${split.className}() {}`);
  }
  const members = [...(cls.instanceMembers || []), ...(cls.staticMembers || [])];
  for (const m of members) {
    body.push("");
    body.push(renderMethodStub(m));
  }

  const packageOpen = split.packageName ? `package ${split.packageName}` : "package";
  return `${packageOpen}\n{\n  ${header}${ifaceSuffix}\n  {\n${body.join("\n")}\n  }\n}\n`;
}

function buildFrameStubs(root, frame) {
  const frameClassDir = path.join(root, "clone_workspace", frame, "classes");
  const indexPath = path.join(frameClassDir, "class_index.json");
  const classIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const outBase = path.join(root, "clone_workspace", "reconstruction_stubs", frame);
  ensureDir(outBase);

  let written = 0;
  let skipped = 0;
  const usedOutPaths = new Set();
  for (const entry of classIndex.classes || []) {
    const srcPath = path.join(root, "clone_workspace", entry.file);
    const cls = JSON.parse(fs.readFileSync(srcPath, "utf8"));
    const split = splitClassName(cls.className);
    const packageDir = split.packageName
      ? path.join(outBase, ...split.packageName.split("."))
      : path.join(outBase, "_root");
    let outPath = path.join(packageDir, `${split.className}.as`);
    const dedupeSuffix = `__ci${String(cls.classIndex).padStart(4, "0")}`;
    if (usedOutPaths.has(outPath)) {
      outPath = path.join(packageDir, `${split.className}${dedupeSuffix}.as`);
    }
    usedOutPaths.add(outPath);
    const status = stableWrite(outPath, renderClassStub(cls));
    if (status === "written") written += 1;
    else skipped += 1;
  }

  const summary = {
    frame,
    classCount: (classIndex.classes || []).length,
    written,
    skipped,
    outBase,
  };
  const summaryPath = path.join(outBase, "_stub_summary.json");
  stableWrite(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(args.root);
  const frame1 = buildFrameStubs(root, "frame1");
  const frame2 = buildFrameStubs(root, "frame2");
  const summary = {
    generatedBy: "build-as3-stubs.mjs",
    root,
    frames: [frame1, frame2],
  };
  const summaryPath = path.join(
    root,
    "clone_workspace",
    "reconstruction_stubs",
    "stub_generation_summary.json"
  );
  stableWrite(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ summaryPath, frame1, frame2 }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(`[build-as3-stubs] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
