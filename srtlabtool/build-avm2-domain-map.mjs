#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

function parseArgs(argv) {
  const parsed = { root: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      parsed.root = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node build-avm2-domain-map.mjs [--root <cda_extracted-path>]",
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
  fs.writeFileSync(file, next);
  return "written";
}

function domainOf(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("buslog")) return "buslog";
  if (n.includes("proxi")) return "proxi";
  if (n.includes("diagnostic") || n.includes("diag")) return "diagnostic";
  if (n.includes("ecu")) return "ecu";
  if (n.includes("flash")) return "flash";
  if (n.includes("unlock")) return "unlock";
  if (n.includes("dtc")) return "dtc";
  if (n.includes("sync")) return "sync";
  if (n.includes("auth")) return "auth";
  if (n.includes("tracer")) return "tracer";
  return "other";
}

function renderMarkdown(doc) {
  const lines = [];
  lines.push("# AVM2 Domain Module Map");
  lines.push("");
  lines.push(`- Source classes: ${doc.meta.classCount}`);
  lines.push(`- Total domains: ${doc.meta.domainCount}`);
  lines.push("");
  lines.push("## Domain Overview");
  for (const d of doc.domains) {
    lines.push(
      `- ${d.domain}: ${d.classCount} classes, ${d.totalInstanceMembers} instance members, ${d.totalStaticMembers} static members`
    );
  }
  lines.push("");
  for (const d of doc.domains.filter((x) => x.domain !== "other")) {
    lines.push(`## ${d.domain}`);
    lines.push(
      `- Top classes by member count: ${d.topClasses
        .slice(0, 8)
        .map((c) => `${c.className} (${c.totalMembers})`)
        .join("; ")}`
    );
    lines.push(`- Suggested owner slice: ${d.suggestedOwnerSlice}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const reportsDir = path.join(root, "reports");
  ensureDir(reportsDir);

  const classMapPath = path.join(reportsDir, "avm2_class_method_map.json");
  if (!fs.existsSync(classMapPath)) {
    throw new Error(`Missing AVM2 class map: ${classMapPath}`);
  }
  const classMap = JSON.parse(fs.readFileSync(classMapPath, "utf8"));
  const classes = classMap.classes || [];

  const grouped = new Map();
  for (const cls of classes) {
    const domain = domainOf(cls.className);
    if (!grouped.has(domain)) grouped.set(domain, []);
    const instanceMembers = cls.instanceMembers || [];
    const staticMembers = cls.staticMembers || [];
    grouped.get(domain).push({
      className: cls.className,
      classNameNormalized: cls.classNameNormalized,
      superName: cls.superName,
      interfaceCount: (cls.interfaces || []).length,
      instanceMemberCount: instanceMembers.length,
      staticMemberCount: staticMembers.length,
      totalMembers: instanceMembers.length + staticMembers.length,
      hottestInstanceMembers: instanceMembers
        .map((m) => ({
          traitName: m.traitName,
          traitKind: m.traitKind,
          codeLength: m.codeLength,
        }))
        .sort((a, b) => b.codeLength - a.codeLength)
        .slice(0, 12),
      hottestStaticMembers: staticMembers
        .map((m) => ({
          traitName: m.traitName,
          traitKind: m.traitKind,
          codeLength: m.codeLength,
        }))
        .sort((a, b) => b.codeLength - a.codeLength)
        .slice(0, 8),
    });
  }

  const preferredOrder = [
    "buslog",
    "proxi",
    "ecu",
    "flash",
    "diagnostic",
    "unlock",
    "dtc",
    "sync",
    "auth",
    "tracer",
    "other",
  ];

  const domains = [...grouped.entries()]
    .map(([domain, list]) => {
      const sorted = [...list].sort((a, b) => b.totalMembers - a.totalMembers);
      const totalInstanceMembers = list.reduce((acc, x) => acc + x.instanceMemberCount, 0);
      const totalStaticMembers = list.reduce((acc, x) => acc + x.staticMemberCount, 0);
      return {
        domain,
        classCount: list.length,
        totalInstanceMembers,
        totalStaticMembers,
        topClasses: sorted.slice(0, 60),
        suggestedOwnerSlice: `${domain}-module-team`,
      };
    })
    .sort(
      (a, b) =>
        preferredOrder.indexOf(a.domain) - preferredOrder.indexOf(b.domain) ||
        b.classCount - a.classCount
    );

  const doc = {
    meta: {
      source: "reports/avm2_class_method_map.json",
      classCount: classes.length,
      domainCount: domains.length,
    },
    domains,
  };

  const jsonStatus = stableWrite(
    path.join(reportsDir, "avm2_domain_map.json"),
    `${JSON.stringify(doc, null, 2)}\n`
  );
  const mdStatus = stableWrite(
    path.join(reportsDir, "avm2_domain_map.md"),
    renderMarkdown(doc)
  );

  console.log(
    JSON.stringify(
      {
        outputs: {
          json: "reports/avm2_domain_map.json",
          markdown: "reports/avm2_domain_map.md",
        },
        writeStatus: {
          json: jsonStatus,
          markdown: mdStatus,
        },
        topDomains: domains.slice(0, 8).map((d) => ({
          domain: d.domain,
          classCount: d.classCount,
          totalInstanceMembers: d.totalInstanceMembers,
          totalStaticMembers: d.totalStaticMembers,
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
  console.error(`[build-avm2-domain-map] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
