/* BinaryIntelTab — read-only binary intelligence cross-reference (Task #649).
 *
 * Ingests hand-curated analysis reports from binaryIntel.generated.js and
 * cross-references each finding against SRT Lab's existing @workspace/uds
 * coverage and tab implementations. Outputs a coverage map with
 * Covered / Partial / Gap tags per finding — no executables, no key calcs.
 *
 * Strictly read-only: no "run", no "send to ECU", no button that touches
 * a real vehicle. Algorithm detail blocks are collapsed by default and
 * carry a second "not wired to any code path" warning. */

import React, { useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";
import { BINARY_INTEL_REPORTS, BINARY_INTEL_GENERATED_AT } from "../lib/binaryIntel.generated.js";
import { classifyFinding } from "../lib/binaryIntelCoverage.js";

/* ── palette helpers ─────────────────────────────────────────────────── */
const STATUS_META = {
  covered: { color: "#2E7D32", bg: "#E8F5E9", label: "COVERED",  icon: "✓" },
  partial: { color: "#E65100", bg: "#FFF3E0", label: "PARTIAL",  icon: "~" },
  gap:     { color: "#B71C1C", bg: "#FFEBEE", label: "GAP",      icon: "✗" },
};

function CoverageTag({ status }) {
  const m = STATUS_META[status] || STATUS_META.gap;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "2px 8px", borderRadius: 6,
      background: m.bg, color: m.color,
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 800, fontSize: 10, letterSpacing: 0.8,
    }}>
      {m.icon} {m.label}
    </span>
  );
}

function HexBadge({ value, prefix = "0x", pad = 2 }) {
  if (value === undefined || value === null) return <span style={{ color: C.tm }}>—</span>;
  const hex = value.toString(16).toUpperCase().padStart(pad, "0");
  return (
    <code style={{
      fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
      background: "#F0F0F0", padding: "1px 5px", borderRadius: 4,
      color: C.bk,
    }}>
      {prefix}{hex}
    </code>
  );
}

/* ── Section heading ──────────────────────────────────────────────────── */
function SectionHead({ icon, title, count }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontWeight: 900, fontSize: 11, color: C.tm,
      letterSpacing: 1.5, margin: "18px 0 8px",
      textTransform: "uppercase",
    }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      {title}
      {count !== undefined && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          background: "#E8E4DE", borderRadius: 99,
          padding: "1px 7px", fontSize: 10, color: C.ts,
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

/* ── Evidence tooltip / inline text ──────────────────────────────────── */
function EvidenceText({ text }) {
  return (
    <div style={{ fontSize: 10, color: C.ts, marginTop: 2, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>
      {text}
    </div>
  );
}

/* ── CAN IDs table ───────────────────────────────────────────────────── */
function CanIdsTable({ entries, q }) {
  const rows = useMemo(() => entries.filter(e =>
    !q || `${e.module} ${e.txId?.toString(16)} ${e.rxId?.toString(16)} ${e.notes || ""}`.toLowerCase().includes(q.toLowerCase())
  ), [entries, q]);

  if (!rows.length) return null;
  return (
    <>
      <SectionHead icon="🚌" title="CAN TX/RX IDs" count={rows.length} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "#F0EDE8" }}>
              {["Module", "TX ID", "RX ID", "Coverage", "Evidence", "Notes"].map(h => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 10, color: C.ts, letterSpacing: 1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const cov = classifyFinding("canId", e);
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? "#FFF" : C.bg }}>
                  <td style={{ padding: "6px 10px", fontWeight: 700, color: C.tx }}>{e.module}</td>
                  <td style={{ padding: "6px 10px" }}><HexBadge value={e.txId} pad={3} /></td>
                  <td style={{ padding: "6px 10px" }}><HexBadge value={e.rxId} pad={3} /></td>
                  <td style={{ padding: "6px 10px" }}><CoverageTag status={cov.status} /></td>
                  <td style={{ padding: "6px 10px", maxWidth: 260 }}><EvidenceText text={cov.evidence} /></td>
                  <td style={{ padding: "6px 10px", color: C.ts }}>{e.notes || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── UDS services table ──────────────────────────────────────────────── */
function UdsServicesTable({ entries, q }) {
  const rows = useMemo(() => entries.filter(e =>
    !q || `${e.name} ${e.sid?.toString(16)} ${e.usageNote || ""}`.toLowerCase().includes(q.toLowerCase())
  ), [entries, q]);

  if (!rows.length) return null;
  return (
    <>
      <SectionHead icon="🔌" title="UDS Services" count={rows.length} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "#F0EDE8" }}>
              {["SID", "Service Name", "Coverage", "Evidence", "Reported Usage"].map(h => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 10, color: C.ts, letterSpacing: 1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const cov = classifyFinding("udsService", e);
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? "#FFF" : C.bg }}>
                  <td style={{ padding: "6px 10px" }}><HexBadge value={e.sid} pad={2} /></td>
                  <td style={{ padding: "6px 10px", fontWeight: 700, color: C.tx }}>{e.name}</td>
                  <td style={{ padding: "6px 10px" }}><CoverageTag status={cov.status} /></td>
                  <td style={{ padding: "6px 10px", maxWidth: 220 }}><EvidenceText text={cov.evidence} /></td>
                  <td style={{ padding: "6px 10px", color: C.ts }}>{e.usageNote || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── DIDs table ──────────────────────────────────────────────────────── */
const DID_CATEGORY_LABELS = {
  identification: "Identification (0xF1xx)",
  skim: "SKIM / Immobilizer (0xDExx)",
  rfhub: "RFHUB (0xABxx)",
  pcm: "PCM (0xCDxx)",
  bcm_proxi: "BCM PROXI (0xFD01 / 0xFD20)",
};

function DidsTable({ entries, q }) {
  const rows = useMemo(() => entries.filter(e =>
    !q || `${e.name} ${e.did?.toString(16)} ${e.category || ""} ${e.notes || ""}`.toLowerCase().includes(q.toLowerCase())
  ), [entries, q]);

  if (!rows.length) return null;
  return (
    <>
      <SectionHead icon="📋" title="DIDs (Data Identifiers)" count={rows.length} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "#F0EDE8" }}>
              {["DID", "Name", "Category", "Coverage", "Evidence / Notes"].map(h => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 10, color: C.ts, letterSpacing: 1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const cov = classifyFinding("did", e);
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? "#FFF" : C.bg }}>
                  <td style={{ padding: "6px 10px" }}><HexBadge value={e.did} pad={4} /></td>
                  <td style={{ padding: "6px 10px", fontWeight: 700, color: C.tx }}>{e.name}</td>
                  <td style={{ padding: "6px 10px", color: C.ts, fontSize: 10 }}>{DID_CATEGORY_LABELS[e.category] || e.category || "—"}</td>
                  <td style={{ padding: "6px 10px" }}><CoverageTag status={cov.status} /></td>
                  <td style={{ padding: "6px 10px", maxWidth: 300 }}>
                    <EvidenceText text={cov.evidence} />
                    {e.notes && <EvidenceText text={`ℹ ${e.notes}`} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── RoutineControl table ────────────────────────────────────────────── */
function RoutineControlTable({ entries, q }) {
  const rows = useMemo(() => entries.filter(e =>
    !q || `${e.name} ${e.routineId?.toString(16)} ${e.targetModule || ""} ${e.notes || ""}`.toLowerCase().includes(q.toLowerCase())
  ), [entries, q]);

  if (!rows.length) return null;
  return (
    <>
      <SectionHead icon="⚙️" title="RoutineControl IDs (0x31)" count={rows.length} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "#F0EDE8" }}>
              {["Routine ID", "Name", "Target ECU", "Coverage", "Evidence / Notes"].map(h => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontFamily: "'Nunito'", fontWeight: 800, fontSize: 10, color: C.ts, letterSpacing: 1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => {
              const cov = classifyFinding("routineControl", e);
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${C.bd}`, background: i % 2 === 0 ? "#FFF" : C.bg }}>
                  <td style={{ padding: "6px 10px" }}><HexBadge value={e.routineId} pad={4} /></td>
                  <td style={{ padding: "6px 10px", fontWeight: 700, color: C.tx }}>{e.name}</td>
                  <td style={{ padding: "6px 10px", color: C.ts }}>{e.targetModule || "—"}</td>
                  <td style={{ padding: "6px 10px" }}><CoverageTag status={cov.status} /></td>
                  <td style={{ padding: "6px 10px", maxWidth: 300 }}>
                    <EvidenceText text={cov.evidence} />
                    {e.notes && <EvidenceText text={`ℹ ${e.notes}`} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Security access table ───────────────────────────────────────────── */
function SecurityLevelsTable({ entries, q }) {
  const rows = useMemo(() => entries.filter(e => {
    const text = `0x${e.requestSeed?.toString(16)} 0x${e.sendKey?.toString(16)} ${e.notes || ""} ${e.algorithm?.name || ""}`;
    return !q || text.toLowerCase().includes(q.toLowerCase());
  }), [entries, q]);

  if (!rows.length) return null;
  return (
    <>
      <SectionHead icon="🔐" title="Security Access Levels (0x27)" count={rows.length} />
      {rows.map((e, i) => {
        const cov = classifyFinding("securityLevel", e);
        const algo = e.algorithm;
        return (
          <Card key={i} style={{ marginBottom: 10, borderLeft: `3px solid ${STATUS_META[cov.status]?.color || C.bd}` }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'", marginRight: 4 }}>Request Seed:</span>
                <HexBadge value={e.requestSeed} pad={2} />
              </div>
              <div>
                <span style={{ fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'", marginRight: 4 }}>Send Key:</span>
                <HexBadge value={e.sendKey} pad={2} />
              </div>
              <div>
                <span style={{ fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'", marginRight: 4 }}>Seed Length:</span>
                <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, background: "#F0F0F0", padding: "1px 5px", borderRadius: 4 }}>{e.seedLen} bytes</code>
              </div>
              <CoverageTag status={cov.status} />
            </div>
            <EvidenceText text={cov.evidence} />
            {e.notes && <div style={{ marginTop: 6, fontSize: 11, color: C.ts, lineHeight: 1.5 }}>{e.notes}</div>}

            {algo && (
              <details style={{ marginTop: 10 }}>
                <summary style={{
                  cursor: "pointer", fontSize: 11, fontWeight: 800, color: "#B71C1C",
                  padding: "6px 10px", background: "#FFF3F3", borderRadius: 6,
                  border: "1px solid #FFCDD2", userSelect: "none",
                }}>
                  ⚠ Algorithm detail: {algo.name} — COLLAPSED (not wired to any code path)
                </summary>
                <div style={{
                  margin: "8px 0 0", padding: 12,
                  background: "#FFF9F9", border: "1px solid #FFCDD2", borderRadius: 6,
                }}>
                  <div style={{
                    padding: "8px 12px", background: "#B71C1C", color: "#fff",
                    borderRadius: 6, fontWeight: 700, fontSize: 11, marginBottom: 10,
                  }}>
                    ⚠ UNVERIFIED — THIRD-PARTY REPORT. Algorithm details below are reproduced from
                    upstream intel for traceability. Do not rely on them for real key calculation
                    until bench-confirmed with known seed→key pairs.
                  </div>
                  <div style={{ marginBottom: 8, fontSize: 11, color: C.ts }}>
                    Status: <strong style={{ color: algo.status === "incomplete" ? C.er : C.gn }}>{algo.status}</strong>
                    {algo.missingPiece && (
                      <span style={{ marginLeft: 8, color: "#B71C1C" }}>— Missing: {algo.missingPiece}</span>
                    )}
                  </div>
                  {algo.steps && algo.steps.map(s => (
                    <div key={s.step} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: C.tx, marginBottom: 3 }}>
                        Step {s.step}: {s.label}
                      </div>
                      <pre style={{
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                        background: "#F5F5F5", padding: "6px 10px", borderRadius: 4,
                        margin: 0, overflowX: "auto", lineHeight: 1.6,
                        whiteSpace: "pre-wrap", wordBreak: "break-all",
                        color: s.label.includes("BLOCKED") ? "#B71C1C" : C.bk,
                      }}>
                        {s.pseudocode}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Card>
        );
      })}
    </>
  );
}

/* ── Coverage summary banner ─────────────────────────────────────────── */
function CoverageSummary({ report }) {
  const counts = useMemo(() => {
    const c = { covered: 0, partial: 0, gap: 0 };
    const f = report.findings;

    for (const e of (f.canIds || [])) c[classifyFinding("canId", e).status]++;
    for (const e of (f.udsServices || [])) c[classifyFinding("udsService", e).status]++;
    for (const e of (f.dids || [])) c[classifyFinding("did", e).status]++;
    for (const e of (f.routineControls || [])) c[classifyFinding("routineControl", e).status]++;
    for (const e of (f.securityLevels || [])) c[classifyFinding("securityLevel", e).status]++;

    return c;
  }, [report]);

  const total = counts.covered + counts.partial + counts.gap;

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
      {Object.entries(STATUS_META).map(([status, meta]) => (
        <div key={status} style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px", borderRadius: 8,
          background: meta.bg, border: `1.5px solid ${meta.color}40`,
          flex: "1 1 120px",
        }}>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 22, fontWeight: 900, color: meta.color }}>
            {counts[status]}
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 900, color: meta.color, letterSpacing: 1 }}>{meta.label}</div>
            <div style={{ fontSize: 9, color: C.ts }}>of {total} findings</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main tab ────────────────────────────────────────────────────────── */
export default function BinaryIntelTab() {
  const [selectedId, setSelectedId] = useState(BINARY_INTEL_REPORTS[0]?.id || null);
  const [q, setQ] = useState("");

  const report = useMemo(
    () => BINARY_INTEL_REPORTS.find(r => r.id === selectedId) || null,
    [selectedId],
  );

  const filteredFindings = useMemo(() => {
    if (!report) return null;
    const lq = q.trim().toLowerCase();
    if (!lq) return report.findings;

    /**
     * Build a normalised search haystack for a numeric value:
     *   - "0x22" (prefixed, lowercase)
     *   - "22"   (plain hex digits, no prefix)
     *   - "34"   (decimal)
     * Accepts a pad width so short IDs like 0x10 are also found via "10".
     */
    function numHay(n, pad = 2) {
      if (n === undefined || n === null || !Number.isFinite(n)) return "";
      const hex = n.toString(16).padStart(pad, "0");
      return `0x${hex} ${hex} ${n}`;
    }

    return {
      canIds: (report.findings.canIds || []).filter(e => {
        const hay = `${e.module} ${numHay(e.txId, 3)} ${numHay(e.rxId, 3)} ${e.notes || ""}`.toLowerCase();
        return hay.includes(lq);
      }),
      udsServices: (report.findings.udsServices || []).filter(e => {
        const hay = `${e.name} ${numHay(e.sid, 2)} ${e.usageNote || ""}`.toLowerCase();
        return hay.includes(lq);
      }),
      dids: (report.findings.dids || []).filter(e => {
        const hay = `${e.name} ${numHay(e.did, 4)} ${e.category || ""} ${e.notes || ""}`.toLowerCase();
        return hay.includes(lq);
      }),
      routineControls: (report.findings.routineControls || []).filter(e => {
        const hay = `${e.name} ${numHay(e.routineId, 4)} ${e.targetModule || ""} ${e.notes || ""}`.toLowerCase();
        return hay.includes(lq);
      }),
      securityLevels: (report.findings.securityLevels || []).filter(e => {
        const hay = `${numHay(e.requestSeed, 2)} ${numHay(e.sendKey, 2)} ${e.notes || ""} ${e.algorithm?.name || ""}`.toLowerCase();
        return hay.includes(lq);
      }),
      notes: report.findings.notes,
    };
  }, [report, q]);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>

      {/* ── Header banner ─────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 14, background: "#FFF8E1", borderColor: "#FFB300" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24 }}>🧪</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: "#6D4C00", letterSpacing: 0.5 }}>
              BINARY INTEL — READ-ONLY REPORT CROSS-REFERENCE
            </div>
            <div style={{ fontSize: 11, color: "#8D6200", marginTop: 4, lineHeight: 1.6 }}>
              Ingests third-party binary-analysis reports and maps each finding against
              SRT Lab&apos;s existing coverage (
              <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 10 }}>@workspace/uds</code>,
              tabs, algos). Coverage tags are computed at runtime — nothing here is
              downloaded, executed, or wired up automatically.
            </div>
          </div>
        </div>
      </Card>

      {/* ── Report selector ───────────────────────────────────────────── */}
      {BINARY_INTEL_REPORTS.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {BINARY_INTEL_REPORTS.map(r => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              style={{
                padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                border: `2px solid ${selectedId === r.id ? C.a3 : C.bd}`,
                background: selectedId === r.id ? C.a3 + "18" : "#fff",
                color: selectedId === r.id ? C.a3 : C.tx,
                fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11,
              }}
            >
              {r.file}
            </button>
          ))}
        </div>
      )}

      {report && (
        <>
          {/* ── Unverified banner ───────────────────────────────────── */}
          {!report.verified && (
            <Card style={{ marginBottom: 14, background: "#FFEBEE", borderColor: "#B71C1C", borderWidth: 2 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <div style={{ fontSize: 20 }}>⚠</div>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 12, color: "#B71C1C", letterSpacing: 0.5 }}>
                    UNVERIFIED — THIRD-PARTY REPORT
                  </div>
                  <div style={{ fontSize: 11, color: "#C62828", marginTop: 4, lineHeight: 1.6 }}>
                    All findings originate from an external analysis of <strong>{report.file}</strong>.
                    They have not been ground-truthed against a real bench dump, our own disassembly,
                    or a live vehicle. Every CAN ID, DID, algorithm step, and byte constant listed
                    here is <strong>unconfirmed intel</strong> until independently verified on-bench.
                    Use for reference and planning only.
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* ── Report metadata ─────────────────────────────────────── */}
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 900, fontSize: 11, color: C.tm, letterSpacing: 1.5, marginBottom: 8 }}>REPORT METADATA</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, fontSize: 11 }}>
              <div><span style={{ color: C.tm, fontWeight: 700 }}>File: </span><code style={{ fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{report.file}</code></div>
              <div><span style={{ color: C.tm, fontWeight: 700 }}>Size: </span>{(report.sizeBytes / 1024 / 1024).toFixed(2)} MB ({report.sizeBytes.toLocaleString()} bytes)</div>
              <div><span style={{ color: C.tm, fontWeight: 700 }}>Source: </span>{report.source}</div>
              <div>
                <span style={{ color: C.tm, fontWeight: 700 }}>Verified: </span>
                <span style={{ fontWeight: 800, color: report.verified ? C.gn : C.er }}>
                  {report.verified ? "✓ Bench-confirmed" : "✗ Unverified"}
                </span>
              </div>
              {report.referenceDoc && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <span style={{ color: C.tm, fontWeight: 700 }}>Reference doc: </span>
                  <code style={{ fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{report.referenceDoc}</code>
                </div>
              )}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: C.ts, lineHeight: 1.6 }}>{report.summary}</div>
            <CoverageSummary report={report} />
          </Card>

          {/* ── Search ──────────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="🔍 Filter by ECU name, service ID, DID, or keyword…"
              style={{
                flex: "1 1 280px", minWidth: 200, padding: "9px 14px",
                borderRadius: 10, border: `1.5px solid ${C.bd}`,
                fontSize: 12, fontFamily: "'Nunito'",
              }}
            />
            {q && (
              <button
                onClick={() => setQ("")}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.bd}`,
                  background: "transparent", cursor: "pointer", fontSize: 11, color: C.tm,
                }}
              >
                ✕ Clear
              </button>
            )}
          </div>

          {/* ── Finding tables ──────────────────────────────────────── */}
          {filteredFindings && (
            <>
              <CanIdsTable entries={filteredFindings.canIds || []} q="" />
              <UdsServicesTable entries={filteredFindings.udsServices || []} q="" />
              <DidsTable entries={filteredFindings.dids || []} q="" />
              <RoutineControlTable entries={filteredFindings.routineControls || []} q="" />
              <SecurityLevelsTable entries={filteredFindings.securityLevels || []} q="" />

              {(filteredFindings.notes || []).length > 0 && (
                <>
                  <SectionHead icon="📝" title="Analyst Notes" count={filteredFindings.notes.length} />
                  <Card style={{ marginTop: 4 }}>
                    <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 2 }}>
                      {filteredFindings.notes.map((n, i) => (
                        <li key={i} style={{ fontSize: 11, color: C.ts }}>{n}</li>
                      ))}
                    </ul>
                  </Card>
                </>
              )}
            </>
          )}

          {/* Empty state when filter narrows to zero findings */}
          {filteredFindings && q && Object.values(filteredFindings).every(v => !v || (Array.isArray(v) && v.length === 0)) && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: C.tm, fontSize: 12 }}>
              No findings match &quot;{q}&quot; — try a different keyword
            </div>
          )}
        </>
      )}

      {/* Footer */}
      <div style={{ marginTop: 24, fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'", textAlign: "right" }}>
        BINARY INTEL catalog • {BINARY_INTEL_REPORTS.length} report{BINARY_INTEL_REPORTS.length !== 1 ? "s" : ""} •
        generated {BINARY_INTEL_GENERATED_AT.slice(0, 10)}
      </div>
    </div>
  );
}
