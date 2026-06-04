/* AnalysisDiffView.jsx — Side-by-side analysis diff view (Task #692).
 *
 * Renders the result of `compareAnalyses()` as:
 *   0. A metadata panel — named analysis fields (module type, VIN, security
 *      bytes, SKIM, calibration ID, software version, hardware number),
 *      extracted from well-known DIDs and surfaced with the same vocabulary
 *      as `parseModule()`.
 *   1. A field table (per-DID comparison) with color-coded status
 *   2. A region byte-diff grid for differing DIDs
 *   3. A "Copy programmer block" action (UDS DID write operations)
 *
 * Color coding:
 *   red   — A only (field present in A, missing in B)
 *   green — B only (field present in B, missing in A)
 *   amber — both present but different values
 *   gray  — same in both
 */

import React, { useState, useCallback } from "react";
import { C } from "../lib/constants.js";
import { buildProgrammerBlock } from "../lib/analysisDiff.js";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

const STATUS_COLOR = {
  a_only:    { bg: "#FFEBEE", border: "#FFCDD2", label: "#C62828", tag: "A ONLY",    tagBg: "#FFCDD2" },
  b_only:    { bg: "#E8F5E9", border: "#C8E6C9", label: "#2E7D32", tag: "B ONLY",    tagBg: "#C8E6C9" },
  different: { bg: "#FFFDE7", border: "#FFF176", label: "#F57F17", tag: "CHANGED",   tagBg: "#FFF176" },
  same:      { bg: "#FAFAFA", border: C.bd,       label: C.ts,      tag: "SAME",      tagBg: "#F0F0F0" },
};

function StatusBadge({ status }) {
  const s = STATUS_COLOR[status] || STATUS_COLOR.same;
  return (
    <span style={{
      fontSize: 8, fontWeight: 800, letterSpacing: 1, padding: "1px 6px",
      borderRadius: 3, background: s.tagBg, color: s.label, whiteSpace: "nowrap",
    }}>
      {s.tag}
    </span>
  );
}

/* Named-field row in the metadata panel. */
function MetaRow({ label, a, b, match }) {
  const aVal = a?.hex ?? a?.ascii ?? (typeof a === "string" ? a : null);
  const bVal = b?.hex ?? b?.ascii ?? (typeof b === "string" ? b : null);
  const status = !aVal && !bVal ? "empty"
    : match ? "same"
    : !aVal ? "b_only"
    : !bVal ? "a_only"
    : "different";

  if (status === "empty") return null;

  const rowColor = status === "same"    ? { border: C.bd, bg: "#F8F8F8" }
                 : status === "different" ? { border: "#FFF176", bg: "#FFFDE7" }
                 : status === "a_only"   ? { border: "#FFCDD2", bg: "#FFEBEE" }
                 :                         { border: "#C8E6C9", bg: "#E8F5E9" };

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "130px 1fr 1fr",
      gap: 6, alignItems: "start",
      padding: "5px 8px", borderRadius: 4,
      background: rowColor.bg, border: "1px solid " + rowColor.border,
      marginBottom: 4,
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, paddingTop: 1 }}>
        {label.toUpperCase()}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono'", fontSize: 9,
        color: status === "same" ? C.tm : "#C62828",
        wordBreak: "break-all",
      }}>
        {aVal || <span style={{ opacity: 0.35, fontStyle: "italic" }}>—</span>}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono'", fontSize: 9,
        color: status === "same" ? C.tm : "#2E7D32",
        wordBreak: "break-all",
      }}>
        {bVal || <span style={{ opacity: 0.35, fontStyle: "italic" }}>—</span>}
      </div>
    </div>
  );
}

/* Byte-grid row for a differing DID. Highlights the exact byte indices where
 * A and B diverge (red/green background on differing byte cells).
 * Byte indices are relative to each DID payload (0-based within the DID value). */
function ByteDiffGrid({ region, labelA, labelB }) {
  const { aBytes, bBytes, diffIndices, contiguousRanges, label } = region;
  const diffSet = new Set(diffIndices);
  const len = Math.max(aBytes?.length || 0, bBytes?.length || 0);
  if (len === 0) return null;

  const renderBytes = (bytes, side) => {
    const arr = bytes || new Uint8Array(0);
    const cells = [];
    for (let i = 0; i < len; i++) {
      const isDiff = diffSet.has(i);
      const val = i < arr.length ? arr[i] : null;
      cells.push(
        <span
          key={i}
          title={"Payload offset " + i + " (0x" + i.toString(16).toUpperCase() + ")"}
          style={{
            display: "inline-block",
            fontFamily: "'JetBrains Mono'",
            fontSize: 9,
            padding: "1px 3px",
            margin: "1px",
            borderRadius: 2,
            background: val === null
              ? "transparent"
              : isDiff
                ? (side === "a" ? "#FFCDD2" : "#C8E6C9")
                : "#F5F5F5",
            color: val === null
              ? C.tm
              : isDiff
                ? (side === "a" ? "#C62828" : "#2E7D32")
                : C.ts,
            fontWeight: isDiff ? 700 : 400,
            border: isDiff ? "1px solid " + (side === "a" ? "#EF9A9A" : "#A5D6A7") : "1px solid transparent",
          }}
        >
          {val !== null ? hx(val) : "--"}
        </span>
      );
    }
    return cells;
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1.5,
        marginBottom: 5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <span>DID {region.didHex} · {label}</span>
        <span style={{
          fontSize: 9, padding: "1px 7px", borderRadius: 3,
          background: "#FFF9C4", color: "#795548", border: "1px solid #F9A825",
        }}>
          {diffIndices.length} byte{diffIndices.length !== 1 ? "s" : ""} differ
        </span>
        {contiguousRanges && contiguousRanges.length > 0 && (
          <span style={{ fontSize: 9, color: C.tm }}>
            {contiguousRanges.length} contiguous range{contiguousRanges.length !== 1 ? "s" : ""}:&nbsp;
            {contiguousRanges.map((r, i) => (
              <span key={i} style={{ fontFamily: "'JetBrains Mono'", marginRight: 4 }}>
                [0x{r.start.toString(16).toUpperCase()}–0x{r.end.toString(16).toUpperCase()}]
              </span>
            ))}
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#C62828", letterSpacing: 1.5, marginBottom: 3 }}>
            {labelA}
          </div>
          <div style={{ lineHeight: 1.6, wordBreak: "break-all" }}>
            {renderBytes(aBytes, "a")}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#2E7D32", letterSpacing: 1.5, marginBottom: 3 }}>
            {labelB}
          </div>
          <div style={{ lineHeight: 1.6, wordBreak: "break-all" }}>
            {renderBytes(bBytes, "b")}
          </div>
        </div>
      </div>
    </div>
  );
}

const META_FIELDS = [
  { key: "moduleType", label: "Module Type",       isModule: true },
  { key: "vin",        label: "VIN" },
  { key: "securityBytes",   label: "Security Bytes" },
  { key: "skimBytes",       label: "SKIM / Immobilizer" },
  { key: "calibrationId",   label: "Calibration ID" },
  { key: "softwareVersion", label: "Software Version" },
  { key: "hardwareNumber",  label: "Hardware Number" },
];

function AnalysisMetadataPanel({ metadata, labelA, labelB }) {
  if (!metadata) return null;
  const hasAnyValue = META_FIELDS.some(({ key, isModule }) => {
    const f = metadata[key];
    if (!f) return false;
    if (isModule) return f.a || f.b;
    return (f.a?.hex ?? f.a?.ascii) || (f.b?.hex ?? f.b?.ascii);
  });
  if (!hasAnyValue) return null;

  return (
    <div style={{
      padding: "10px 18px 8px", borderBottom: "1px solid " + C.bd,
      background: "#F8F6F2",
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 7 }}>
        ANALYSIS METADATA
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "130px 1fr 1fr",
        gap: 0, marginBottom: 3,
      }}>
        <div style={{ fontSize: 8, color: C.tm, fontWeight: 700, letterSpacing: 1, padding: "0 8px 3px" }} />
        <div style={{ fontSize: 8, color: "#C62828", fontWeight: 800, letterSpacing: 1.5, padding: "0 0 3px" }}>
          A · {labelA}
        </div>
        <div style={{ fontSize: 8, color: "#2E7D32", fontWeight: 800, letterSpacing: 1.5, padding: "0 0 3px" }}>
          B · {labelB}
        </div>
      </div>
      {META_FIELDS.map(({ key, label, isModule }) => {
        const f = metadata[key];
        if (!f) return null;
        if (isModule) {
          return (
            <MetaRow
              key={key}
              label={label}
              a={f.a}
              b={f.b}
              match={f.match}
            />
          );
        }
        return (
          <MetaRow
            key={key}
            label={label}
            a={f.a}
            b={f.b}
            match={f.match}
          />
        );
      })}
    </div>
  );
}

/* ── Raw file-offset byte region grid ──────────────────────────────────────
 * Renders a single contiguous diff span from compareRawBytes() output.
 * Offsets are absolute file positions (not DID-relative payload indices).
 */
function RawByteRegionRow({ region, labelA, labelB }) {
  const { offset, offsetHex, length, aHex, bHex, diffIndices } = region;
  const diffSet = new Set(diffIndices || []);
  /* compareRawBytes emits space-separated hex tokens ("AA BB CC…").
   * Split on whitespace — NOT /.{2}/g which misinterprets the spaces. */
  const aBytes = (aHex || "").trim().split(/\s+/).filter(Boolean);
  const bBytes = (bHex || "").trim().split(/\s+/).filter(Boolean);
  const len = Math.max(aBytes.length, bBytes.length);
  if (len === 0) return null;

  const renderRow = (bytes, side) => bytes.map((byte, i) => {
    const isDiff = diffSet.has(i);
    return (
      <span
        key={i}
        title={"File offset 0x" + (offset + i).toString(16).toUpperCase()}
        style={{
          display: "inline-block",
          fontFamily: "'JetBrains Mono'",
          fontSize: 9,
          padding: "1px 3px",
          margin: "1px",
          borderRadius: 2,
          background: isDiff ? (side === "a" ? "#FFCDD2" : "#C8E6C9") : "#F5F5F5",
          color: isDiff ? (side === "a" ? "#C62828" : "#2E7D32") : C.ts,
          fontWeight: isDiff ? 700 : 400,
          border: isDiff ? "1px solid " + (side === "a" ? "#EF9A9A" : "#A5D6A7") : "1px solid transparent",
        }}
      >
        {byte}
      </span>
    );
  });

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1.5,
        marginBottom: 5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{ fontFamily: "'JetBrains Mono'" }}>{offsetHex}</span>
        <span style={{
          fontSize: 9, padding: "1px 7px", borderRadius: 3,
          background: "#FFF9C4", color: "#795548", border: "1px solid #F9A825",
        }}>
          {length} byte{length !== 1 ? "s" : ""} differ
        </span>
        <span style={{ fontSize: 9, color: C.tm }}>file offset span</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#C62828", letterSpacing: 1.5, marginBottom: 3 }}>{labelA}</div>
          <div style={{ lineHeight: 1.6, wordBreak: "break-all" }}>{renderRow(aBytes, "a")}</div>
        </div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#2E7D32", letterSpacing: 1.5, marginBottom: 3 }}>{labelB}</div>
          <div style={{ lineHeight: 1.6, wordBreak: "break-all" }}>{renderRow(bBytes, "b")}</div>
        </div>
      </div>
    </div>
  );
}

/* ── ParsedField row ──────────────────────────────────────────────────────── */
function ParsedFieldRow({ row }) {
  const s = STATUS_COLOR[row.status] || STATUS_COLOR.same;
  return (
    <div style={{
      marginBottom: 6, padding: "8px 12px", borderRadius: 6,
      background: s.bg, border: "1.5px solid " + s.border,
      display: "grid", gridTemplateColumns: "160px 1fr 1fr",
      gap: 8, alignItems: "start",
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, paddingTop: 1 }}>
        {row.label.toUpperCase()}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#C62828", wordBreak: "break-all" }}>
        {row.aVal ?? <span style={{ opacity: 0.35, fontStyle: "italic" }}>—</span>}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#2E7D32", wordBreak: "break-all" }}>
        {row.bVal ?? <span style={{ opacity: 0.35, fontStyle: "italic" }}>—</span>}
      </div>
    </div>
  );
}

export default function AnalysisDiffView({ diffResult, backupA, backupB, onClose }) {
  const [showSame, setShowSame] = useState(false);
  const [showSameParsed, setShowSameParsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeSection, setActiveSection] = useState("fields");

  const { fields = [], regions = [], rawByteRegions, parsedFields, summary = {}, metadata } = diffResult || {};

  const labelA = backupA
    ? (backupA.module || "A") + (backupA.vin ? " · " + backupA.vin : "")
    : "A";
  const labelB = backupB
    ? (backupB.module || "B") + (backupB.vin ? " · " + backupB.vin : "")
    : "B";

  const diffFields = fields.filter((f) => f.status !== "same");
  const sameFields = fields.filter((f) => f.status === "same");

  const handleCopyBlock = useCallback(async () => {
    if (!diffResult) return;
    const block = buildProgrammerBlock(diffResult);
    const text = JSON.stringify(block, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  }, [diffResult]);

  if (!diffResult) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: C.tm }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>⏳</div>
        <div>Computing diff…</div>
      </div>
    );
  }

  const totalDiff = summary.different + summary.aOnly + summary.bOnly;
  /* A diff is "non-identical" when any of the three diff axes has changes:
   *   1. DID-level field differences (totalDiff)
   *   2. Raw file-offset byte regions (rawByteRegions non-empty)
   *   3. parseModule parsed-field differences (parsedDiff) */
  const hasDiff = totalDiff > 0
    || (rawByteRegions && rawByteRegions.length > 0)
    || (summary.parsedDiff && summary.parsedDiff > 0);

  const hasRawSection    = Array.isArray(rawByteRegions);
  const hasParsedSection = Array.isArray(parsedFields) && parsedFields.length > 0;
  const parsedDiffRows   = parsedFields ? parsedFields.filter((f) => f.status !== "same") : [];
  const parsedSameRows   = parsedFields ? parsedFields.filter((f) => f.status === "same") : [];

  return (
    <div data-testid="analysis-diff-view">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={{
        padding: "14px 18px",
        background: "linear-gradient(135deg,#1A237E 0%,#283593 40%,#3949AB 100%)",
        color: "#fff", borderRadius: "8px 8px 0 0",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      }}>
        <div>
          <div style={{ fontFamily: "'Righteous'", fontSize: 20, letterSpacing: 1.5 }}>
            ANALYSIS DIFF
          </div>
          <div style={{ fontSize: 10, opacity: 0.75, letterSpacing: 2, fontWeight: 700, marginTop: 2 }}>
            SIDE-BY-SIDE COMPARISON · READ-ONLY
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasDiff && (
            <button
              onClick={handleCopyBlock}
              data-testid="copy-programmer-block"
              title="Copies UDS DID write operations (type: uds_did_write) and raw_patch rows for all differing fields and byte regions"
              style={{
                padding: "6px 14px", fontSize: 11, fontWeight: 800,
                background: copied ? "#00C853" : "rgba(255,255,255,0.15)",
                color: "#fff", border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 6, cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              {copied ? "✓ COPIED" : "📋 COPY PROGRAMMER BLOCK"}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              data-testid="analysis-diff-close"
              style={{
                padding: "6px 12px", fontSize: 13, fontWeight: 800,
                background: "rgba(255,255,255,0.1)", color: "#fff",
                border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, cursor: "pointer",
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Snapshot labels ─────────────────────────────────────────── */}
      <div style={{
        padding: "10px 18px", background: "rgba(26,35,126,0.05)",
        borderBottom: "1px solid " + C.bd,
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
      }}>
        <div style={{
          padding: "8px 12px", borderRadius: 6,
          background: "#FFEBEE", border: "1px solid #FFCDD2",
        }}>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#C62828", letterSpacing: 1.5, marginBottom: 2 }}>
            SNAPSHOT A
          </div>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: "#B71C1C" }}>
            {labelA}
          </div>
          {backupA?.timestamp && (
            <div style={{ fontSize: 9, color: "#C62828", opacity: 0.75, marginTop: 2 }}>
              {new Date(backupA.timestamp).toLocaleString()}
            </div>
          )}
        </div>
        <div style={{
          padding: "8px 12px", borderRadius: 6,
          background: "#E8F5E9", border: "1px solid #C8E6C9",
        }}>
          <div style={{ fontSize: 8, fontWeight: 800, color: "#2E7D32", letterSpacing: 1.5, marginBottom: 2 }}>
            SNAPSHOT B
          </div>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: "#1B5E20" }}>
            {labelB}
          </div>
          {backupB?.timestamp && (
            <div style={{ fontSize: 9, color: "#2E7D32", opacity: 0.75, marginTop: 2 }}>
              {new Date(backupB.timestamp).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* ── Named analysis metadata (parseModule vocabulary) ─────────── */}
      <AnalysisMetadataPanel metadata={metadata} labelA={labelA} labelB={labelB} />

      {/* ── Summary badges + tab switcher ───────────────────────────── */}
      <div style={{
        padding: "8px 18px", background: "#F8F6F2",
        borderBottom: "1px solid " + C.bd,
        display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", gap: 8, fontSize: 11, fontWeight: 700 }}>
          {summary.different > 0 && (
            <span style={{ color: "#F57F17", padding: "2px 8px", background: "#FFFDE7", borderRadius: 999, border: "1px solid #FFF176" }}>
              ±{summary.different} changed
            </span>
          )}
          {summary.aOnly > 0 && (
            <span style={{ color: "#C62828", padding: "2px 8px", background: "#FFEBEE", borderRadius: 999, border: "1px solid #FFCDD2" }}>
              -{summary.aOnly} A only
            </span>
          )}
          {summary.bOnly > 0 && (
            <span style={{ color: "#2E7D32", padding: "2px 8px", background: "#E8F5E9", borderRadius: 999, border: "1px solid #C8E6C9" }}>
              +{summary.bOnly} B only
            </span>
          )}
          {summary.same > 0 && (
            <span style={{ color: C.tm, padding: "2px 8px", background: "#F0F0F0", borderRadius: 999, border: "1px solid " + C.bd }}>
              ={summary.same} same
            </span>
          )}
          {!hasDiff && (
            <span style={{ color: "#2E7D32", padding: "2px 8px", background: "#E8F5E9", borderRadius: 999 }}>
              ✓ Identical
            </span>
          )}
          {hasRawSection && rawByteRegions.length > 0 && (
            <span style={{ color: "#5E35B1", padding: "2px 8px", background: "#EDE7F6", borderRadius: 999, border: "1px solid #CE93D8" }}>
              ~{summary.totalRawDiffBytes || rawByteRegions.length} raw byte{(summary.totalRawDiffBytes || rawByteRegions.length) !== 1 ? "s" : ""} differ
            </span>
          )}
          {hasParsedSection && parsedDiffRows.length > 0 && (
            <span style={{ color: "#00695C", padding: "2px 8px", background: "#E0F2F1", borderRadius: 999, border: "1px solid #80CBC4" }}>
              {parsedDiffRows.length} parsed field{parsedDiffRows.length !== 1 ? "s" : ""} differ
            </span>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {[
            { id: "fields",  label: "FIELD TABLE" },
            ...(hasParsedSection ? [{ id: "parsed", label: "PARSED FIELDS" }] : []),
            { id: "regions", label: "DID BYTE REGIONS" },
            ...(hasRawSection    ? [{ id: "raw",    label: "RAW BINARY" }]   : []),
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveSection(id)}
              style={{
                padding: "4px 12px", fontSize: 10, fontWeight: 800,
                background: activeSection === id ? C.a3 : "transparent",
                color: activeSection === id ? "#fff" : C.ts,
                border: "1px solid " + (activeSection === id ? C.a3 : C.bd),
                borderRadius: 4, cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Field table ─────────────────────────────────────────────── */}
      {activeSection === "fields" && (
        <div style={{ padding: "14px 18px" }}>
          {totalDiff === 0 ? (
            <div data-testid="diff-no-changes" style={{
              padding: "18px 20px", background: "#E8F5E9",
              border: "1px solid #A5D6A7", borderRadius: 8,
              fontSize: 13, color: "#2E7D32", textAlign: "center", fontWeight: 700,
            }}>
              ✓ No differences — both snapshots are identical across all {summary.total} captured DIDs.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 10 }}>
                DIFFERING FIELDS ({diffFields.length})
              </div>
              <div data-testid="diff-field-table" style={{ marginBottom: 14 }}>
                {diffFields.map((field) => {
                  const s = STATUS_COLOR[field.status] || STATUS_COLOR.same;
                  return (
                    <div
                      key={field.did}
                      data-testid={"diff-field-" + field.did}
                      style={{
                        marginBottom: 8, padding: "10px 12px", borderRadius: 6,
                        background: s.bg, border: "1.5px solid " + s.border,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                        <span style={{
                          fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 800, color: s.label,
                        }}>
                          DID 0x{hx(field.did, 4)}
                        </span>
                        <span style={{ fontSize: 11, color: C.ts, flex: 1 }}>{field.label}</span>
                        {field.category && (
                          <span style={{
                            fontSize: 8, color: C.tm, padding: "1px 5px",
                            background: "#F0F0F0", borderRadius: 3, fontWeight: 600,
                          }}>
                            {field.category}
                          </span>
                        )}
                        <StatusBadge status={field.status} />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <div style={{
                          padding: "6px 8px", borderRadius: 4,
                          background: "#FFEBEE", border: "1px solid #FFCDD2",
                        }}>
                          <div style={{ fontSize: 8, fontWeight: 800, color: "#C62828", letterSpacing: 1.5, marginBottom: 3 }}>A</div>
                          {field.aAscii && (
                            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#B71C1C", fontWeight: 700, marginBottom: 2 }}>
                              "{field.aAscii}"
                            </div>
                          )}
                          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#C62828", wordBreak: "break-all", opacity: 0.85 }}>
                            {field.aHex || <span style={{ fontStyle: "italic", opacity: 0.5 }}>(missing)</span>}
                          </div>
                        </div>
                        <div style={{
                          padding: "6px 8px", borderRadius: 4,
                          background: "#E8F5E9", border: "1px solid #C8E6C9",
                        }}>
                          <div style={{ fontSize: 8, fontWeight: 800, color: "#2E7D32", letterSpacing: 1.5, marginBottom: 3 }}>B</div>
                          {field.bAscii && (
                            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#1B5E20", fontWeight: 700, marginBottom: 2 }}>
                              "{field.bAscii}"
                            </div>
                          )}
                          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#2E7D32", wordBreak: "break-all", opacity: 0.85 }}>
                            {field.bHex || <span style={{ fontStyle: "italic", opacity: 0.5 }}>(missing)</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {sameFields.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary
                onClick={(e) => { e.preventDefault(); setShowSame((v) => !v); }}
                style={{
                  fontSize: 10, color: C.tm, cursor: "pointer",
                  padding: "5px 8px", borderRadius: 4,
                  background: "#F5F5F5", border: "1px solid " + C.bd,
                  userSelect: "none", listStyle: "none",
                  display: "flex", alignItems: "center", gap: 5,
                }}
              >
                <span>{showSame ? "▼" : "▶"}</span>
                <span>{sameFields.length} unchanged DID{sameFields.length !== 1 ? "s" : ""} (no diff)</span>
              </summary>
              {showSame && (
                <div data-testid="diff-same-fields" style={{ marginTop: 3 }}>
                  {sameFields.map((field) => (
                    <div
                      key={field.did}
                      data-testid={"diff-same-field-" + field.did}
                      style={{
                        padding: "5px 10px", borderBottom: "1px solid " + C.bd,
                        display: "flex", alignItems: "center", gap: 10,
                        opacity: 0.5,
                      }}
                    >
                      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 700, color: C.ts, whiteSpace: "nowrap" }}>
                        DID 0x{hx(field.did, 4)}
                      </span>
                      <span style={{ fontSize: 10, color: C.tm, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {field.label}
                      </span>
                      {field.aAscii && (
                        <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: C.ts }}>
                          "{field.aAscii}"
                        </span>
                      )}
                      <span style={{
                        fontSize: 8, fontWeight: 700, color: C.a2, letterSpacing: 1,
                        padding: "1px 5px", background: "#e6f9ed", borderRadius: 3,
                      }}>
                        =
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>
      )}

      {/* ── Parsed module fields (parseModule result diff) ──────────── */}
      {activeSection === "parsed" && hasParsedSection && (
        <div style={{ padding: "14px 18px" }} data-testid="diff-parsed-fields">
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 4 }}>
            PARSED MODULE FIELDS
          </div>
          <div style={{ fontSize: 11, color: C.tm, marginBottom: 14, lineHeight: 1.5 }}>
            Structural fields extracted by <code>parseModule()</code> from the raw binary image — VIN slots,
            SKIM/immobilizer state, secret keys, transponder key slots, part number, runtime counters, and
            the module type classification. Available only when the backup blob carries full binary image data.
          </div>

          {/* Column header */}
          <div style={{
            display: "grid", gridTemplateColumns: "160px 1fr 1fr",
            gap: 8, marginBottom: 6, padding: "4px 12px",
          }}>
            <div style={{ fontSize: 8, fontWeight: 800, color: C.tm, letterSpacing: 1 }}>FIELD</div>
            <div style={{ fontSize: 8, fontWeight: 800, color: "#C62828", letterSpacing: 1.5 }}>A · {labelA}</div>
            <div style={{ fontSize: 8, fontWeight: 800, color: "#2E7D32", letterSpacing: 1.5 }}>B · {labelB}</div>
          </div>

          {parsedDiffRows.length === 0 && parsedSameRows.length === 0 ? (
            <div style={{
              padding: "18px 20px", background: "#E8F5E9",
              border: "1px solid #A5D6A7", borderRadius: 8,
              fontSize: 13, color: "#2E7D32", textAlign: "center", fontWeight: 700,
            }}>
              ✓ All parsed module fields are identical.
            </div>
          ) : (
            <>
              {parsedDiffRows.length > 0 && (
                <div data-testid="diff-parsed-diff-rows" style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 6 }}>
                    DIFFERING FIELDS ({parsedDiffRows.length})
                  </div>
                  {parsedDiffRows.map((row) => (
                    <ParsedFieldRow key={row.label} row={row} />
                  ))}
                </div>
              )}

              {parsedSameRows.length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary
                    onClick={(e) => { e.preventDefault(); setShowSameParsed((v) => !v); }}
                    style={{
                      fontSize: 10, color: C.tm, cursor: "pointer",
                      padding: "5px 8px", borderRadius: 4,
                      background: "#F5F5F5", border: "1px solid " + C.bd,
                      userSelect: "none", listStyle: "none",
                      display: "flex", alignItems: "center", gap: 5,
                    }}
                  >
                    <span>{showSameParsed ? "▼" : "▶"}</span>
                    <span>{parsedSameRows.length} unchanged parsed field{parsedSameRows.length !== 1 ? "s" : ""} (no diff)</span>
                  </summary>
                  {showSameParsed && (
                    <div data-testid="diff-parsed-same-rows" style={{ marginTop: 3 }}>
                      {parsedSameRows.map((row) => (
                        <div key={row.label} style={{
                          padding: "5px 12px", borderBottom: "1px solid " + C.bd,
                          display: "grid", gridTemplateColumns: "160px 1fr",
                          gap: 8, opacity: 0.5,
                        }}>
                          <span style={{ fontSize: 9, fontWeight: 700, color: C.ts }}>{row.label}</span>
                          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: C.ts }}>{row.aVal}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </>
          )}
        </div>
      )}

      {/* ── DID payload byte regions ─────────────────────────────────── */}
      {activeSection === "regions" && (
        <div style={{ padding: "14px 18px" }} data-testid="diff-regions">
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 4 }}>
            DID PAYLOAD BYTE DIFF
          </div>
          <div style={{ fontSize: 11, color: C.tm, marginBottom: 14, lineHeight: 1.5 }}>
            Differing byte positions within each UDS DID payload are highlighted. Offsets are
            0-based within the DID response value (not raw flash offsets):
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, marginLeft: 6, padding: "2px 6px", background: "#FFCDD2", borderRadius: 3, color: "#C62828" }}>A</span>
            {" "}(red) and
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, marginLeft: 6, padding: "2px 6px", background: "#C8E6C9", borderRadius: 3, color: "#2E7D32" }}>B</span>
            {" "}(green). Contiguous differing spans are shown next to each DID header.
          </div>

          {regions.length === 0 ? (
            <div style={{
              padding: "18px 20px", background: "#E8F5E9",
              border: "1px solid #A5D6A7", borderRadius: 8,
              fontSize: 13, color: "#2E7D32", textAlign: "center", fontWeight: 700,
            }}>
              ✓ No DID payload byte-level differences.
            </div>
          ) : (
            <div data-testid="diff-region-list">
              {regions.map((region) => (
                <ByteDiffGrid
                  key={region.did}
                  region={region}
                  labelA={labelA}
                  labelB={labelB}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Raw binary file-offset diff ──────────────────────────────── */}
      {activeSection === "raw" && hasRawSection && (
        <div style={{ padding: "14px 18px" }} data-testid="diff-raw-binary">
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 4 }}>
            RAW BINARY FILE-OFFSET DIFF
          </div>
          <div style={{ fontSize: 11, color: C.tm, marginBottom: 14, lineHeight: 1.5 }}>
            True file-offset diff of the full binary module images. Each row is a contiguous span where
            A and B differ. Offsets are absolute positions within the raw image file (hex), identical to
            what a flash programmer or hex editor would report:
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, marginLeft: 6, padding: "2px 6px", background: "#FFCDD2", borderRadius: 3, color: "#C62828" }}>A</span>
            {" "}(red, old) and
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, marginLeft: 6, padding: "2px 6px", background: "#C8E6C9", borderRadius: 3, color: "#2E7D32" }}>B</span>
            {" "}(green, new).
          </div>
          {summary.totalRawDiffBytes > 0 && (
            <div style={{
              display: "inline-flex", gap: 10, padding: "6px 14px", marginBottom: 14,
              background: "#EDE7F6", border: "1px solid #CE93D8", borderRadius: 6,
              fontSize: 10, fontWeight: 700, color: "#5E35B1",
            }}>
              <span>{rawByteRegions.length} contiguous region{rawByteRegions.length !== 1 ? "s" : ""}</span>
              <span>·</span>
              <span>{summary.totalRawDiffBytes} byte{summary.totalRawDiffBytes !== 1 ? "s" : ""} total</span>
            </div>
          )}

          {rawByteRegions.length === 0 ? (
            <div style={{
              padding: "18px 20px", background: "#E8F5E9",
              border: "1px solid #A5D6A7", borderRadius: 8,
              fontSize: 13, color: "#2E7D32", textAlign: "center", fontWeight: 700,
            }}>
              ✓ Raw binary images are byte-for-byte identical.
            </div>
          ) : (
            <div data-testid="diff-raw-region-list">
              {rawByteRegions.map((region, idx) => (
                <RawByteRegionRow
                  key={region.offsetHex || idx}
                  region={region}
                  labelA={labelA}
                  labelB={labelB}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
