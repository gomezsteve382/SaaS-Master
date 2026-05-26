import type { Analysis, ChatMessage } from "@/lib/workbench-types";

type FindingsKey =
  | "algorithms"
  | "seedKeys"
  | "canAddresses"
  | "checksums"
  | "securityBytes"
  | "strings"
  | "yaraMatches";

interface AppliedRuleSet {
  id: string;
  name: string;
  isDefault: boolean;
  matchCount: number;
  status?: "matched" | "no_matches" | "not_executed";
}

type FindingRow = Record<string, unknown>;

function fmtOffset(o: unknown): string {
  if (typeof o !== "number") return "—";
  return `0x${o.toString(16).padStart(8, "0").toUpperCase()}`;
}

function fmtConf(c: unknown): string {
  if (typeof c !== "number") return "—";
  return `${Math.round(c * 100)}%`;
}

export interface EntropyPoint { offset: number; entropy: number }

export function getEntropySeries(analysis: Analysis): EntropyPoint[] {
  const findings = (analysis.findings ?? {}) as Record<string, unknown>;
  const series = findings.entropySeries;
  if (!Array.isArray(series)) return [];
  return series
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const r = s as Record<string, unknown>;
      const offset = typeof r.offset === "number" ? r.offset : NaN;
      const entropy = typeof r.entropy === "number" ? r.entropy : NaN;
      if (!Number.isFinite(offset) || !Number.isFinite(entropy)) return null;
      return { offset, entropy };
    })
    .filter((p): p is EntropyPoint => p !== null);
}

export function getFindingsCategories(analysis: Analysis): { label: string; count: number }[] {
  return [
    { label: "Algorithms", count: analysis.algorithmCount },
    { label: "Seed/Key", count: analysis.seedKeyCount },
    { label: "CAN", count: analysis.canAddressCount },
    { label: "Checksums", count: analysis.checksumCount },
    { label: "Security", count: analysis.securityByteCount },
    { label: "Strings", count: analysis.stringCount },
  ];
}

function fmtHexOffset(o: number): string {
  return `0x${o.toString(16).toUpperCase()}`;
}

export function buildEntropyChartSvg(series: EntropyPoint[]): string {
  const W = 720;
  const H = 220;
  const M = { top: 16, right: 16, bottom: 36, left: 44 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  if (series.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#666">No entropy data available</text></svg>`;
  }
  const maxOffset = series[series.length - 1].offset || 1;
  const yMax = 8;
  const x = (o: number) => M.left + (o / maxOffset) * innerW;
  const y = (e: number) => M.top + innerH - (Math.min(e, yMax) / yMax) * innerH;
  const pts = series.map((p) => `${x(p.offset).toFixed(1)},${y(p.entropy).toFixed(1)}`).join(" ");
  const areaPts = `${M.left},${M.top + innerH} ${pts} ${x(series[series.length - 1].offset).toFixed(1)},${M.top + innerH}`;

  const yTicks = [0, 2, 4, 6, 8];
  const yGrid = yTicks
    .map((t) => {
      const yy = y(t).toFixed(1);
      return `<line x1="${M.left}" y1="${yy}" x2="${M.left + innerW}" y2="${yy}" stroke="#e5e7eb" stroke-width="1"/><text x="${M.left - 6}" y="${(parseFloat(yy) + 3).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#555">${t}</text>`;
    })
    .join("");

  const xTickCount = 5;
  const xTicks: string[] = [];
  for (let i = 0; i <= xTickCount; i++) {
    const off = Math.round((maxOffset * i) / xTickCount);
    const xx = x(off).toFixed(1);
    xTicks.push(
      `<line x1="${xx}" y1="${M.top + innerH}" x2="${xx}" y2="${M.top + innerH + 4}" stroke="#555" stroke-width="1"/><text x="${xx}" y="${M.top + innerH + 16}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#555">${fmtHexOffset(off)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${yGrid}${xTicks.join("")}<polygon points="${areaPts}" fill="#3b82f6" fill-opacity="0.15"/><polyline points="${pts}" fill="none" stroke="#1d4ed8" stroke-width="1.5"/><text x="${M.left}" y="${M.top - 4}" font-family="sans-serif" font-size="11" fill="#111" font-weight="600">Entropy (bits/byte) vs Offset</text><text x="${M.left + innerW}" y="${H - 4}" text-anchor="end" font-family="sans-serif" font-size="9" fill="#888">${series.length} windows</text></svg>`;
}

export function buildFindingsChartSvg(items: { label: string; count: number }[]): string {
  const W = 720;
  const H = 220;
  const M = { top: 24, right: 16, bottom: 40, left: 44 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const maxCount = Math.max(1, ...items.map((i) => i.count));
  const slot = innerW / items.length;
  const barW = Math.max(8, slot * 0.6);
  const yTicks = 4;
  const yGrid: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = Math.round((maxCount * i) / yTicks);
    const yy = (M.top + innerH - (v / maxCount) * innerH).toFixed(1);
    yGrid.push(
      `<line x1="${M.left}" y1="${yy}" x2="${M.left + innerW}" y2="${yy}" stroke="#e5e7eb" stroke-width="1"/><text x="${M.left - 6}" y="${(parseFloat(yy) + 3).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#555">${v}</text>`,
    );
  }
  const bars = items
    .map((it, idx) => {
      const cx = M.left + slot * idx + slot / 2;
      const bx = cx - barW / 2;
      const bh = (it.count / maxCount) * innerH;
      const by = M.top + innerH - bh;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="#10b981" rx="2"/><text x="${cx.toFixed(1)}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#111">${it.count}</text><text x="${cx.toFixed(1)}" y="${(M.top + innerH + 16).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#555">${it.label}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${yGrid.join("")}${bars}<text x="${M.left}" y="${M.top - 8}" font-family="sans-serif" font-size="11" fill="#111" font-weight="600">Findings by Category</text></svg>`;
}

function svgToDataUrl(svg: string): string {
  const b64 = typeof window === "undefined" ? Buffer.from(svg).toString("base64") : btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;base64,${b64}`;
}

function escapeCell(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

interface TableSpec {
  label: string;
  headers: string[];
  row: (f: FindingRow) => string[];
}

const TABLES: Record<FindingsKey, TableSpec> = {
  algorithms: {
    label: "Algorithms",
    headers: ["Offset", "Algorithm", "Type", "Confidence"],
    row: (f) => [fmtOffset(f.offset), escapeCell(f.name), escapeCell(f.type), fmtConf(f.confidence)],
  },
  seedKeys: {
    label: "Seed / Key Operations",
    headers: ["Offset", "Candidate", "Kind", "Confidence"],
    row: (f) => [fmtOffset(f.offset), escapeCell(f.name), escapeCell(f.keyType), fmtConf(f.confidence)],
  },
  canAddresses: {
    label: "CAN Addresses",
    headers: ["CAN ID", "Module", "Description", "Confidence"],
    row: (f) => [escapeCell(f.address), escapeCell(f.module), escapeCell(f.description), fmtConf(f.confidence)],
  },
  checksums: {
    label: "Checksums",
    headers: ["Offset", "Marker", "Algorithm", "Confidence"],
    row: (f) => [fmtOffset(f.offset), escapeCell(f.name), escapeCell(f.algorithm), fmtConf(f.confidence)],
  },
  securityBytes: {
    label: "Security Bytes",
    headers: ["Offset", "Name", "Value", "Purpose"],
    row: (f) => [fmtOffset(f.offset), escapeCell(f.name), escapeCell(f.value), escapeCell(f.purpose)],
  },
  strings: {
    label: "Interesting Strings",
    headers: ["String"],
    row: (f) => [escapeCell(f.value)],
  },
  yaraMatches: {
    label: "YARA Matches",
    headers: ["Rule", "Severity", "Description", "Confidence"],
    row: (f) => [escapeCell(f.rule), escapeCell(f.severity), escapeCell(f.description), fmtConf(f.confidence)],
  },
};

function renderTable(spec: TableSpec, rows: FindingRow[]): string {
  if (rows.length === 0) return "";
  const head = `| ${spec.headers.join(" | ")} |`;
  const sep = `| ${spec.headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${spec.row(r).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

function normalizeStrings(items: unknown[]): FindingRow[] {
  return items.map((f) => (typeof f === "string" ? { value: f } : (f as FindingRow)));
}

export function buildMarkdownReport(analysis: Analysis, chat: ChatMessage[]): string {
  const lines: string[] = [];
  lines.push(`# Analysis Report — ${analysis.filename}`);
  lines.push("");
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  lines.push(`- **Analysis ID:** \`${analysis.id}\``);
  lines.push(`- **Binary ID:** \`${analysis.binaryId}\``);
  lines.push(`- **Filename:** ${analysis.filename}`);
  lines.push(`- **File size:** ${analysis.fileSize.toLocaleString()} bytes`);
  if (analysis.fileType) lines.push(`- **File type:** ${analysis.fileType}`);
  if (analysis.detectedModule) lines.push(`- **Detected module:** ${analysis.detectedModule}`);
  lines.push(`- **Status:** ${analysis.status}`);
  if (typeof analysis.entropy === "number") lines.push(`- **Entropy:** ${analysis.entropy.toFixed(2)}`);
  if (typeof analysis.confidence === "number") lines.push(`- **Confidence:** ${fmtConf(analysis.confidence)}`);
  lines.push(`- **Created:** ${analysis.createdAt}`);
  if (analysis.completedAt) {
    lines.push(`- **Completed:** ${analysis.completedAt}`);
  }
  lines.push("");

  lines.push("## Counts");
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Algorithms | ${analysis.algorithmCount} |`);
  lines.push(`| Seed/Key ops | ${analysis.seedKeyCount} |`);
  lines.push(`| CAN addresses | ${analysis.canAddressCount} |`);
  lines.push(`| Checksums | ${analysis.checksumCount} |`);
  lines.push(`| Security bytes | ${analysis.securityByteCount} |`);
  lines.push(`| Strings | ${analysis.stringCount} |`);
  lines.push("");

  const findingsChart = buildFindingsChartSvg(getFindingsCategories(analysis));
  lines.push("### Findings by Category");
  lines.push("");
  lines.push(`![Findings by Category](${svgToDataUrl(findingsChart)})`);
  lines.push("");

  const entropySeries = getEntropySeries(analysis);
  lines.push("### Entropy over Offset");
  lines.push("");
  if (entropySeries.length > 0) {
    const entropyChart = buildEntropyChartSvg(entropySeries);
    lines.push(`![Entropy over Offset](${svgToDataUrl(entropyChart)})`);
  } else {
    lines.push("_No entropy series available for this analysis._");
  }
  lines.push("");

  if (analysis.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(analysis.summary);
    lines.push("");
  }

  if (analysis.errorMessage) {
    lines.push("## Errors");
    lines.push("");
    lines.push("```");
    lines.push(analysis.errorMessage);
    lines.push("```");
    lines.push("");
  }

  lines.push("## Claude Deep Dive");
  lines.push("");
  const deepDiveNotes = (analysis as Analysis & { claudeNotes?: string }).claudeNotes ?? analysis.summary;
  lines.push(deepDiveNotes?.trim() ? deepDiveNotes : "_No deep dive notes available._");
  lines.push("");

  const rawFindings = (analysis.findings ?? {}) as Partial<Record<FindingsKey, unknown[]>> & {
    appliedRuleSets?: AppliedRuleSet[];
  };
  lines.push("## Findings");
  lines.push("");
  const findingOrder: FindingsKey[] = [
    "algorithms",
    "seedKeys",
    "canAddresses",
    "checksums",
    "securityBytes",
    "strings",
  ];
  let anyFindings = false;
  for (const key of findingOrder) {
    const items = rawFindings[key] ?? [];
    if (!items.length) continue;
    anyFindings = true;
    const spec = TABLES[key];
    const rows = key === "strings" ? normalizeStrings(items) : (items as FindingRow[]);
    lines.push(`### ${spec.label} (${items.length})`);
    lines.push("");
    lines.push(renderTable(spec, rows));
    lines.push("");
  }

  const yaraMatches = (rawFindings.yaraMatches ?? []) as (FindingRow & { ruleSetId?: string })[];
  const appliedRuleSets = rawFindings.appliedRuleSets ?? [];
  if (yaraMatches.length > 0 || appliedRuleSets.length > 0) {
    anyFindings = true;
    const yaraSpec = TABLES.yaraMatches;
    lines.push(`### ${yaraSpec.label} (${yaraMatches.length})`);
    lines.push("");
    if (appliedRuleSets.length > 0) {
      for (const ruleSet of appliedRuleSets) {
        const groupMatches = yaraMatches.filter((m) => m.ruleSetId === ruleSet.id);
        const builtIn = ruleSet.isDefault ? " _(built-in)_" : "";
        const notExecuted = ruleSet.status === "not_executed";
        const suffix = notExecuted
          ? "not executed"
          : `${groupMatches.length} hit${groupMatches.length === 1 ? "" : "s"}`;
        lines.push(`#### ${ruleSet.name}${builtIn} — ${suffix}`);
        lines.push("");
        if (groupMatches.length > 0) {
          lines.push(renderTable(yaraSpec, groupMatches));
        } else if (notExecuted) {
          lines.push("_This rule set was not executed for this analysis._");
        } else {
          lines.push("_No matches for this rule set._");
        }
        lines.push("");
      }
      const unattributed = yaraMatches.filter(
        (m) => !m.ruleSetId || !appliedRuleSets.some((s) => s.id === m.ruleSetId),
      );
      if (unattributed.length > 0) {
        lines.push(`#### Unattributed — ${unattributed.length} hit${unattributed.length === 1 ? "" : "s"}`);
        lines.push("");
        lines.push(renderTable(yaraSpec, unattributed));
        lines.push("");
      }
    } else if (yaraMatches.length > 0) {
      lines.push(renderTable(yaraSpec, yaraMatches));
      lines.push("");
    }
  }

  if (!anyFindings) {
    lines.push("_No findings recorded._");
    lines.push("");
  }

  lines.push("## Chat Transcript");
  lines.push("");
  if (chat.length === 0) {
    lines.push("_No chat messages._");
  } else {
    for (const msg of chat) {
      const ts = msg.createdAt;
      lines.push(`### ${msg.role === "user" ? "User" : "Assistant"} — ${ts}`);
      lines.push("");
      lines.push(msg.content);
      lines.push("");
    }
  }

  if (analysis.toolCallTrace && analysis.toolCallTrace.length > 0) {
    lines.push("## Tool Call Trace");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(analysis.toolCallTrace, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "analysis";
}

export function downloadMarkdown(analysis: Analysis, chat: ChatMessage[]): void {
  const md = buildMarkdownReport(analysis, chat);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(analysis.filename)}-report.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function markdownToHtml(md: string): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const splitRow = (row: string): string[] =>
        row
          .replace(/\s+$/, "")
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, "|"));
      const headerCells = splitRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        `<table><thead><tr>${headerCells.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${escapeHtml(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      const alt = escapeHtml(img[1]);
      const rawSrc = img[2].trim();
      if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(rawSrc)) {
        out.push(`<p class="chart"><img alt="${alt}" src="${escapeHtml(rawSrc)}" /></p>`);
      } else {
        out.push(`<p>${escapeHtml(`![${img[1]}](${rawSrc})`)}</p>`);
      }
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push(
        `<ul>${items
          .map((it) => `<li>${escapeHtml(it).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("|") && !lines[i].startsWith("```") && !/^[-*]\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    const html = escapeHtml(para.join(" "))
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/_([^_]+)_/g, "<em>$1</em>");
    out.push(`<p>${html}</p>`);
  }
  return out.join("\n");
}

export function openPrintablePdf(analysis: Analysis, chat: ChatMessage[]): void {
  const md = buildMarkdownReport(analysis, chat);
  const body = markdownToHtml(md);
  const title = `${analysis.filename} — Analysis Report`;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title.replace(/</g, "&lt;")}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.45; font-size: 11pt; }
  h1 { font-size: 22pt; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 15pt; margin-top: 24px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  h3 { font-size: 12pt; margin-top: 16px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 9pt; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #eee; }
  pre { background: #f4f4f4; padding: 10px; border: 1px solid #ddd; border-radius: 4px; overflow-x: auto; font-size: 9pt; white-space: pre-wrap; word-break: break-word; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9.5pt; }
  ul { margin: 4px 0 12px 20px; }
  p { margin: 6px 0; }
  p.chart { margin: 8px 0 16px; text-align: center; }
  p.chart img { max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 4px; background: #fff; }
</style>
</head>
<body>
${body}
<script>
  window.addEventListener("load", function () {
    setTimeout(function () { window.focus(); window.print(); }, 250);
  });
</script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Unable to open print window. Please allow popups for this site.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
