// Persisted diff reports.
//
// When the user clicks "Save Diff Report" on the J2534 Scanner's DiffPanel we
// store a copy of the baseline + current scan + computed diff so the History
// view in the Backups tab can re-open or re-print past comparisons without
// requiring the user to re-scan the vehicle.
//
// Storage layout:
//   srtlab_diff_reports_index      -> JSON array of meta records (newest first)
//   srtlab_diff_report_<id>        -> JSON payload { baseline, current, diff, generatedAt }
//
// Older reports are pruned when the cap is exceeded.

import { buildOnePagerPDF } from "./buildOnePagerPDF.js";

const INDEX_KEY = "srtlab_diff_reports_index";
const PAYLOAD_PREFIX = "srtlab_diff_report_";
const MAX_REPORTS = 50;

function newReportId() {
  return "d_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function notify() {
  try { window.dispatchEvent(new Event("srtlab:diffReports")); } catch { /* ignore */ }
}

function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeIndex(idx) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx.slice(0, MAX_REPORTS))); }
  catch { /* ignore */ }
}

function readPayload(id) {
  try {
    const raw = localStorage.getItem(PAYLOAD_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writePayload(id, payload) {
  try { localStorage.setItem(PAYLOAD_PREFIX + id, JSON.stringify(payload)); return true; }
  catch { return false; }
}

function removePayload(id) {
  try { localStorage.removeItem(PAYLOAD_PREFIX + id); } catch { /* ignore */ }
}

/* Build the meta record stored in the index. Counts are denormalized so the
 * History list can render without having to load each payload. */
function buildMeta({ id, generatedAt, baseline, current, diff }) {
  return {
    id,
    generatedAt,
    baselineLabel: baseline?.label || "(unlabeled)",
    baselineTs: baseline?.ts || null,
    baselineModuleCount: Array.isArray(baseline?.modules) ? baseline.modules.length : 0,
    currentTs: current?.ts || null,
    currentModuleCount: Array.isArray(current?.modules) ? current.modules.length : 0,
    addedCount: diff?.added?.length || 0,
    removedCount: diff?.removed?.length || 0,
    changedCount: diff?.changed?.length || 0,
    sameCount: diff?.same?.length || 0,
  };
}

/* Persist a diff report. Returns the meta record (with id) on success or null
 * on quota failure. The caller already has the full data in memory, so a
 * silent failure here just means the History list won't show it — the active
 * Save PDF flow continues. */
export function saveDiffReport({ baseline, current, diff }) {
  const id = newReportId();
  const generatedAt = Date.now();
  const payload = {
    id,
    generatedAt,
    baseline: {
      label: baseline?.label || "(unlabeled)",
      ts: baseline?.ts || null,
      modules: Array.isArray(baseline?.modules) ? baseline.modules : [],
    },
    current: {
      ts: current?.ts || null,
      modules: Array.isArray(current?.modules) ? current.modules : [],
    },
    diff: {
      added: diff?.added || [],
      removed: diff?.removed || [],
      changed: diff?.changed || [],
      same: diff?.same || [],
    },
  };
  if (!writePayload(id, payload)) return null;
  const meta = buildMeta({ id, generatedAt, ...payload });
  const idx = readIndex();
  idx.unshift(meta);
  if (idx.length > MAX_REPORTS) {
    idx.slice(MAX_REPORTS).forEach((m) => removePayload(m.id));
  }
  writeIndex(idx);
  notify();
  return meta;
}

export function listDiffReports() { return readIndex(); }

export function getDiffReport(id) { return readPayload(id); }

export function deleteDiffReport(id) {
  removePayload(id);
  writeIndex(readIndex().filter((m) => m.id !== id));
  notify();
}

export function clearDiffReports() {
  const idx = readIndex();
  idx.forEach((m) => removePayload(m.id));
  try { localStorage.removeItem(INDEX_KEY); } catch { /* ignore */ }
  notify();
}

export function subscribeDiffReports(handler) {
  const listener = () => handler();
  window.addEventListener("srtlab:diffReports", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("srtlab:diffReports", listener);
    window.removeEventListener("storage", listener);
  };
}

/* Pretty timestamp shared between save flow and history view. */
export function fmtScanStamp(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString("en-US", { hour12: false }); }
  catch { return ""; }
}

/* Plain-text rendering of a diff. Used by the Copy-as-text button in the
 * scanner; exposed here so the History view could grow the same affordance. */
export function buildDiffReportText(baseline, current, diff) {
  const fmtTx = (m) => `0x${(m.tx || 0).toString(16).toUpperCase().padStart(3, "0")}`;
  const lines = [];
  lines.push("SRT LAB \u2014 BASELINE vs CURRENT DIFF REPORT");
  lines.push("=".repeat(56));
  lines.push(`Baseline scan : ${fmtScanStamp(baseline.ts) || "(unknown)"}  (${(baseline.modules || []).length} modules)`);
  lines.push(`Current scan  : ${fmtScanStamp(current.ts) || "(unsaved)"}  (${(current.modules || []).length} modules)`);
  lines.push("");
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("No differences \u2014 current scan matches baseline exactly.");
  }
  if (diff.added.length) {
    lines.push(`+ ADDED MODULES (${diff.added.length})`);
    diff.added.forEach((m) => {
      lines.push(`  + ${m.code || m.name}  TX:${fmtTx(m)}${m.vin ? "  VIN: " + m.vin : ""}`);
    });
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push(`- REMOVED MODULES (${diff.removed.length})`);
    diff.removed.forEach((m) => {
      lines.push(`  - ${m.code || m.name}  TX:${fmtTx(m)}${m.vin ? "  VIN: " + m.vin : ""}`);
    });
    lines.push("");
  }
  if (diff.changed.length) {
    lines.push(`+/- CHANGED VINs (${diff.changed.length})`);
    diff.changed.forEach((c) => {
      lines.push(`  ${c.current.code || c.current.name}  TX:${fmtTx(c.current)}`);
      lines.push(`    - ${c.baseline.vin || "(no VIN)"}`);
      lines.push(`    + ${c.current.vin || "(no VIN)"}`);
    });
    lines.push("");
  }
  if (diff.same.length) {
    lines.push(`${diff.same.length} module${diff.same.length === 1 ? "" : "s"} unchanged.`);
  }
  return lines.join("\n");
}

/* Build and download the diff PDF. Same renderer used for the live "Save Diff
 * Report" button and for "Re-download" in the History view, so re-printing a
 * past report produces an identical document. */
export async function exportDiffReportPDF(baseline, current, diff) {
  const fmtTx = (m) => `0x${(m.tx || 0).toString(16).toUpperCase().padStart(3, "0")}`;
  const sections = [];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    sections.push({
      label: "RESULT",
      type: "bullets",
      data: ["No differences \u2014 current scan matches baseline exactly."],
    });
  }
  if (diff.added.length) {
    sections.push({
      label: `+ ADDED MODULES (${diff.added.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "VIN"],
        rows: diff.added.map((m) => [m.code || m.name || "", fmtTx(m), m.vin || ""]),
        colors: ["#2E7D32", "__mono__", "#1A1A1A"],
      },
    });
  }
  if (diff.removed.length) {
    sections.push({
      label: `- REMOVED MODULES (${diff.removed.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "VIN"],
        rows: diff.removed.map((m) => [m.code || m.name || "", fmtTx(m), m.vin || ""]),
        colors: ["#C62828", "__mono__", "#1A1A1A"],
      },
    });
  }
  if (diff.changed.length) {
    sections.push({
      label: `+/- CHANGED VINs (${diff.changed.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "BASELINE VIN", "CURRENT VIN"],
        rows: diff.changed.map((c) => [
          c.current.code || c.current.name || "",
          fmtTx(c.current),
          c.baseline.vin || "(none)",
          c.current.vin || "(none)",
        ]),
        colors: ["#1A1A1A", "__mono__", "#C62828", "#2E7D32"],
      },
    });
  }
  if (diff.same.length) {
    sections.push({
      label: "UNCHANGED",
      type: "bullets",
      data: [`${diff.same.length} module${diff.same.length === 1 ? "" : "s"} unchanged.`],
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await buildOnePagerPDF({
    filename: `SRT_Lab_Diff_Report_${stamp}.pdf`,
    title: "BASELINE vs CURRENT DIFF",
    subtitle: "Scan comparison report",
    version: new Date().toLocaleDateString(),
    intro: [
      `Baseline scan: ${fmtScanStamp(baseline.ts) || "(unknown)"}  \u00B7  ${(baseline.modules || []).length} modules`,
      `Current scan : ${fmtScanStamp(current.ts) || "(unsaved)"}  \u00B7  ${(current.modules || []).length} modules`,
    ],
    sections,
    footer: "SRT Lab \u00B7 Diff Report \u00B7 For authorized service use only",
  });
}
