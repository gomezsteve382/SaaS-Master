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
    "  node build-buslog-rebuild-pack.mjs [--root <cda_extracted-path>]",
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

function normalizeName(name) {
  return String(name || "")
    .replace(/::/g, ".")
    .replace(/[^\w.$]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function domainOf(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("buslog")) return "buslog";
  if (t.includes("proxi")) return "proxi";
  if (t.includes("diagnostic") || t.includes("diag")) return "diagnostic";
  if (t.includes("ecu")) return "ecu";
  if (t.includes("flash")) return "flash";
  if (t.includes("unlock")) return "unlock";
  if (t.includes("dtc")) return "dtc";
  if (t.includes("sync")) return "sync";
  if (t.includes("auth")) return "auth";
  if (t.includes("tracer")) return "tracer";
  return "other";
}

function classifyBuslogClass(name) {
  const n = String(name || "");
  const lower = n.toLowerCase();
  if (lower.includes(".application.buslog.")) return "application_commands";
  if (lower.includes("configurationstore") || lower.includes("config")) return "configuration";
  if (lower.includes("generator")) return "message_generator";
  if (
    lower.includes("window") ||
    lower.includes("dialog") ||
    lower.includes("popover") ||
    lower.includes("selector")
  ) {
    return "dialogs_selectors";
  }
  if (lower.includes(".presentation.component.diagnostic.buslog.")) return "diagnostic_ui";
  return "core";
}

function memberId(className, member, isStatic) {
  const kind = isStatic ? "static" : "instance";
  return `${className}::${kind}::${member.traitKind}::${member.traitName}`;
}

function buildBacklogMarkdown(doc) {
  const lines = [];
  lines.push("# Buslog Rebuild Backlog");
  lines.push("");
  lines.push(`- Buslog classes discovered: ${doc.summary.classCount}`);
  lines.push(`- Method/member nodes: ${doc.summary.memberNodeCount}`);
  lines.push(`- Graph edges: ${doc.summary.edgeCount}`);
  lines.push(
    `- Cross-domain dependencies: ${doc.summary.crossDomainEdgeCount} (proxi/diagnostic/ecu/flash/etc)`
  );
  lines.push("");
  lines.push("## Phase 0 - Foundation");
  lines.push("- Build shared event bus + message DTO layer used by `BusLoggerLite` and stream commands.");
  lines.push("- Define typed transport interface for bus log streaming and request/response correlation.");
  lines.push("- Wire logging, state snapshots, and replay hooks before UI reconstruction.");
  lines.push("");

  for (const phase of doc.phases) {
    lines.push(`## ${phase.name}`);
    lines.push(`- Goal: ${phase.goal}`);
    lines.push(`- Classes: ${phase.classCount}`);
    lines.push(`- Dependencies: ${phase.dependencies.join(", ") || "none"}`);
    lines.push(
      `- Top classes: ${phase.topClasses.map((c) => `${c.className} (${c.totalMembers})`).join("; ")}`
    );
    lines.push("- Acceptance criteria:");
    for (const ac of phase.acceptanceCriteria) {
      lines.push(`- ${ac}`);
    }
    lines.push("");
  }

  lines.push("## Implementation Order (Class-Level)");
  for (const item of doc.orderedClasses.slice(0, 40)) {
    lines.push(
      `- ${item.className} [${item.bucket}] members=${item.totalMembers}, inbound=${item.inboundEdges}, outbound=${item.outboundEdges}`
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- Graph is static and reconstructed from AVM2 signatures/traits/types, not runtime traces.");
  lines.push("- Use this to sequence rebuild and ownership slicing, then refine with opcode/runtime tracing.");
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
  const reportsDir = path.join(root, "reports");
  ensureDir(reportsDir);

  const classMapPath = path.join(reportsDir, "avm2_class_method_map.json");
  if (!fs.existsSync(classMapPath)) {
    throw new Error(`Missing ${classMapPath}. Run analyze-avm2-abc.mjs first.`);
  }

  const classMap = JSON.parse(fs.readFileSync(classMapPath, "utf8"));
  const allClasses = classMap.classes || [];
  const classByName = new Map();
  for (const c of allClasses) {
    classByName.set(normalizeName(c.className), c);
  }

  const buslogClasses = allClasses.filter((c) => domainOf(c.className) === "buslog");

  const nodes = [];
  const edges = [];
  const classNodeIds = new Set();

  function addNode(node) {
    nodes.push(node);
  }
  function addEdge(edge) {
    edges.push(edge);
  }

  for (const cls of buslogClasses) {
    const className = normalizeName(cls.className);
    const classNodeId = `class:${className}`;
    classNodeIds.add(classNodeId);
    addNode({
      id: classNodeId,
      type: "class",
      className: cls.className,
      bucket: classifyBuslogClass(cls.className),
      domain: "buslog",
      totalMembers: (cls.instanceMembers?.length || 0) + (cls.staticMembers?.length || 0),
    });

    const superName = normalizeName(cls.superName);
    if (superName && superName !== "*" && superName !== cls.classNameNormalized) {
      addEdge({
        from: classNodeId,
        to: `class:${superName}`,
        kind: "inherits",
      });
    }

    for (const iface of cls.interfaces || []) {
      const ifaceName = normalizeName(iface);
      if (!ifaceName || ifaceName === "*") continue;
      addEdge({
        from: classNodeId,
        to: `class:${ifaceName}`,
        kind: "implements",
      });
    }

    const instanceMembers = cls.instanceMembers || [];
    const staticMembers = cls.staticMembers || [];
    const allMembers = [
      ...instanceMembers.map((m) => ({ ...m, isStatic: false })),
      ...staticMembers.map((m) => ({ ...m, isStatic: true })),
    ];

    for (const m of allMembers) {
      const mid = `method:${memberId(className, m, m.isStatic)}`;
      addNode({
        id: mid,
        type: "method",
        className: cls.className,
        traitName: m.traitName,
        traitKind: m.traitKind,
        methodIndex: m.methodIndex,
        methodName: m.methodName,
        codeLength: m.codeLength,
        isStatic: m.isStatic,
      });

      addEdge({
        from: classNodeId,
        to: mid,
        kind: m.isStatic ? "declares_static_member" : "declares_instance_member",
      });

      const typeRefs = [...(m.paramTypes || []), m.returnType].filter(Boolean);
      for (const t of typeRefs) {
        const tn = normalizeName(t);
        if (!tn || tn === "*") continue;
        if (classByName.has(tn)) {
          addEdge({
            from: mid,
            to: `class:${tn}`,
            kind: "type_ref",
          });
        }
        const d = domainOf(tn);
        if (d !== "other" && d !== "buslog") {
          addEdge({
            from: mid,
            to: `domain:${d}`,
            kind: "cross_domain_hint",
          });
        }
      }

      const textForHints = `${m.traitName || ""} ${m.methodName || ""}`.toLowerCase();
      for (const d of [
        "proxi",
        "diagnostic",
        "ecu",
        "flash",
        "unlock",
        "dtc",
        "sync",
        "auth",
        "tracer",
      ]) {
        if (textForHints.includes(d)) {
          addEdge({
            from: mid,
            to: `domain:${d}`,
            kind: "name_hint",
          });
        }
      }
    }
  }

  for (const d of [
    "buslog",
    "proxi",
    "diagnostic",
    "ecu",
    "flash",
    "unlock",
    "dtc",
    "sync",
    "auth",
    "tracer",
    "other",
  ]) {
    addNode({
      id: `domain:${d}`,
      type: "domain",
      domain: d,
    });
  }

  // De-duplicate edges deterministically.
  const edgeKey = new Set();
  const dedupedEdges = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (edgeKey.has(key)) continue;
    edgeKey.add(key);
    dedupedEdges.push(e);
  }
  dedupedEdges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.kind.localeCompare(b.kind) ||
      a.to.localeCompare(b.to)
  );

  const inbound = new Map();
  const outbound = new Map();
  for (const e of dedupedEdges) {
    outbound.set(e.from, (outbound.get(e.from) || 0) + 1);
    inbound.set(e.to, (inbound.get(e.to) || 0) + 1);
  }

  const orderedClasses = buslogClasses
    .map((c) => {
      const className = normalizeName(c.className);
      const nodeId = `class:${className}`;
      const totalMembers = (c.instanceMembers?.length || 0) + (c.staticMembers?.length || 0);
      return {
        className: c.className,
        classNameNormalized: className,
        bucket: classifyBuslogClass(c.className),
        totalMembers,
        inboundEdges: inbound.get(nodeId) || 0,
        outboundEdges: outbound.get(nodeId) || 0,
        priorityScore:
          totalMembers * 10 + (inbound.get(nodeId) || 0) * 2 + (outbound.get(nodeId) || 0),
      };
    })
    .sort(
      (a, b) =>
        b.priorityScore - a.priorityScore ||
        b.totalMembers - a.totalMembers ||
        a.className.localeCompare(b.className)
    );

  function phaseFor(bucket) {
    if (bucket === "core" || bucket === "application_commands") return "Phase 1 - Core Stream Engine";
    if (bucket === "configuration" || bucket === "dialogs_selectors")
      return "Phase 2 - Config and Interaction Flows";
    if (bucket === "message_generator") return "Phase 3 - Message Generator and Tooling";
    return "Phase 4 - UI/Polish and Residual Classes";
  }

  const phaseMap = new Map();
  for (const item of orderedClasses) {
    const key = phaseFor(item.bucket);
    if (!phaseMap.has(key)) phaseMap.set(key, []);
    phaseMap.get(key).push(item);
  }

  const phaseDefinitions = [
    {
      name: "Phase 1 - Core Stream Engine",
      goal: "Rebuild runtime logging flow, stream lifecycle, and state model.",
      acceptanceCriteria: [
        "Bus stream can start, pause, resume, and stop deterministically.",
        "Core log model updates are replayable from recorded message batches.",
        "No UI dependency required to validate stream command behavior.",
      ],
    },
    {
      name: "Phase 2 - Config and Interaction Flows",
      goal: "Rebuild configuration selectors, import/export interactions, and store/load behavior.",
      acceptanceCriteria: [
        "Configuration selection and persistence paths are stable across sessions.",
        "Import/export/store-load interactions preserve schema and field semantics.",
        "Dialog and selector components emit typed events for command layer.",
      ],
    },
    {
      name: "Phase 3 - Message Generator and Tooling",
      goal: "Rebuild generator features and supporting helper workflows.",
      acceptanceCriteria: [
        "Message generation produces expected frame/request payload structure.",
        "Tooling hooks integrate with core stream APIs without hidden side effects.",
        "Generated content can be validated with deterministic snapshots.",
      ],
    },
    {
      name: "Phase 4 - UI/Polish and Residual Classes",
      goal: "Complete remaining UI skins/helpers and cross-domain integration edges.",
      acceptanceCriteria: [
        "Residual buslog classes are linked with no unresolved class/type references.",
        "Cross-domain entry points (diagnostic/proxi/ecu) are explicitly mapped and tested.",
        "Visual and workflow parity validated against extracted asset/state map.",
      ],
    },
  ];

  const phases = phaseDefinitions.map((p) => {
    const classesForPhase = phaseMap.get(p.name) || [];
    const classSet = new Set(classesForPhase.map((c) => `class:${c.classNameNormalized}`));
    const deps = new Set();
    for (const e of dedupedEdges) {
      if (classSet.has(e.from) && e.to.startsWith("domain:")) {
        const d = e.to.replace("domain:", "");
        if (d !== "buslog" && d !== "other") deps.add(d);
      }
    }
    return {
      ...p,
      classCount: classesForPhase.length,
      dependencies: [...deps].sort(),
      topClasses: classesForPhase.slice(0, 12),
    };
  });

  const graphDoc = {
    meta: {
      source: "reports/avm2_class_method_map.json",
      generatedBy: "build-buslog-rebuild-pack.mjs",
      classCount: buslogClasses.length,
      memberNodeCount: nodes.filter((n) => n.type === "method").length,
      edgeCount: dedupedEdges.length,
      graphType: "static_signature_call_graph_seed",
    },
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: dedupedEdges,
  };

  const backlogDoc = {
    summary: {
      classCount: buslogClasses.length,
      memberNodeCount: graphDoc.meta.memberNodeCount,
      edgeCount: dedupedEdges.length,
      crossDomainEdgeCount: dedupedEdges.filter((e) => e.to.startsWith("domain:")).length,
    },
    phases,
    orderedClasses,
  };

  const graphPath = path.join(reportsDir, "buslog_call_graph.json");
  const backlogJsonPath = path.join(reportsDir, "buslog_rebuild_backlog.json");
  const backlogMdPath = path.join(reportsDir, "buslog_rebuild_backlog.md");

  const writeStatus = {
    graph: stableWrite(graphPath, `${JSON.stringify(graphDoc, null, 2)}\n`),
    backlogJson: stableWrite(backlogJsonPath, `${JSON.stringify(backlogDoc, null, 2)}\n`),
    backlogMarkdown: stableWrite(backlogMdPath, buildBacklogMarkdown(backlogDoc)),
  };

  console.log(
    JSON.stringify(
      {
        outputs: {
          graph: "reports/buslog_call_graph.json",
          backlogJson: "reports/buslog_rebuild_backlog.json",
          backlogMarkdown: "reports/buslog_rebuild_backlog.md",
        },
        writeStatus,
        summary: backlogDoc.summary,
        topClasses: orderedClasses.slice(0, 10),
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[build-buslog-rebuild-pack] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
