/* DispatchCoverageTab — full routine→frame coverage gap browser (Task #839).
 *
 * Renders DISPATCH_GAP_REPORT (1,696 routines across many ECU families)
 * with per-ECU rows (total / withFrame / orphan / framesAttributed) and a
 * click-to-expand drill-down that lists every orphan routine plus its
 * heuristic candidate frames. Candidates are NEVER confirmed-match — they
 * are starting points for the next bench-capture pass and are flagged as
 * such on every row.
 *
 * Strictly read-only: no run buttons, no ECU writes, no auto-wiring. */

import React, { useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";
import { DISPATCH_GAP_REPORT } from "../lib/dispatchGapReport.generated.js";

const MONO = "'JetBrains Mono', monospace";

function StatBox({ label, value, color = C.tx, sub }) {
  return (
    <div style={{
      flex: 1, minWidth: 120,
      background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10,
      padding: "10px 14px",
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1.2, color: C.tm, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.ts, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function CoverageBar({ withFrame, total }) {
  const pct = total > 0 ? (withFrame / total) * 100 : 0;
  const color = pct >= 50 ? C.gn : pct >= 20 ? C.wn : C.sr;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 6, background: C.bd, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width 0.3s" }} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: C.ts, minWidth: 42, textAlign: "right" }}>
        {pct.toFixed(1)}%
      </div>
    </div>
  );
}

function CandidateRow({ cand }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "4px 10px", fontSize: 11, fontFamily: MONO,
      borderTop: `1px dashed ${C.bd}`,
    }}>
      <code style={{
        background: "#FFF3E0", color: "#E65100",
        padding: "1px 6px", borderRadius: 4, fontWeight: 700,
      }}>
        {cand.frameHex}
      </code>
      <span style={{ fontSize: 10, color: C.ts, flex: 1 }}>{cand.rationale}</span>
      <span style={{ fontSize: 10, color: C.tm }}>×{cand.occurrences}</span>
    </div>
  );
}

function OrphanRow({ o }) {
  const hasCands = o.candidates && o.candidates.length > 0;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${C.bd}` }}>
      <div
        onClick={hasCands ? () => setOpen(v => !v) : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "6px 10px",
          cursor: hasCands ? "pointer" : "default",
          background: open ? "#FFF8F0" : "transparent",
        }}
      >
        <code style={{
          fontFamily: MONO, fontSize: 11, fontWeight: 800,
          background: "#F0F0F0", color: C.bk,
          padding: "2px 7px", borderRadius: 4, minWidth: 60, textAlign: "center",
        }}>
          rid {o.rid}
        </code>
        <span style={{ fontSize: 11, color: C.tx, flex: 1 }}>{o.platform || "—"}</span>
        {hasCands ? (
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: 0.8,
            padding: "2px 7px", borderRadius: 4,
            background: "#FFF3E0", color: "#E65100",
          }}>
            {o.candidates.length} HEURISTIC{o.candidates.length === 1 ? "" : "S"} {open ? "▾" : "▸"}
          </span>
        ) : (
          <span style={{ fontSize: 9, color: C.tm, fontWeight: 700, letterSpacing: 0.8 }}>
            NO CANDIDATES
          </span>
        )}
      </div>
      {open && hasCands && (
        <div style={{ background: "#FAF7F2", padding: "4px 0 6px 60px" }}>
          <div style={{
            fontSize: 9, fontWeight: 800, color: C.sr, letterSpacing: 1,
            padding: "4px 10px 2px",
          }}>
            ⚠ NEVER CONFIRMED-MATCH — bench-capture verification required
          </div>
          {o.candidates.map((c, i) => <CandidateRow key={i} cand={c} />)}
        </div>
      )}
    </div>
  );
}

function EcuRow({ ecu, q, expandAll }) {
  const [open, setOpen] = useState(false);
  const isOpen = expandAll || open;

  const filteredOrphans = useMemo(() => {
    if (!q) return ecu.orphans;
    const needle = q.toLowerCase();
    return ecu.orphans.filter(o =>
      String(o.rid).toLowerCase().includes(needle) ||
      (o.platform || "").toLowerCase().includes(needle) ||
      (o.ecuName || "").toLowerCase().includes(needle) ||
      (o.candidates || []).some(c => (c.frameHex || "").toLowerCase().includes(needle))
    );
  }, [ecu.orphans, q]);

  return (
    <div style={{ borderBottom: `1px solid ${C.bd}` }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(180px,1.6fr) 70px 70px 70px 80px minmax(140px,1.2fr) 28px",
          alignItems: "center", gap: 10,
          padding: "10px 12px",
          cursor: "pointer",
          background: isOpen ? "#FAF7F2" : "transparent",
        }}
      >
        <div style={{ fontWeight: 800, color: C.tx, fontSize: 12, fontFamily: MONO }}>
          {ecu.ecu}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.ts, textAlign: "right" }}>{ecu.routinesTotal}</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.gn, fontWeight: 700, textAlign: "right" }}>{ecu.routinesWithFrame}</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: ecu.routinesOrphan > 0 ? C.sr : C.tm, fontWeight: 700, textAlign: "right" }}>{ecu.routinesOrphan}</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.ts, textAlign: "right" }}>{ecu.framesAttributed}</div>
        <CoverageBar withFrame={ecu.routinesWithFrame} total={ecu.routinesTotal} />
        <div style={{ fontSize: 12, color: C.tm, textAlign: "center" }}>{isOpen ? "▾" : "▸"}</div>
      </div>
      {isOpen && (
        <div style={{ background: C.bg, padding: "4px 0", borderTop: `1px solid ${C.bd}` }}>
          {filteredOrphans.length === 0 && (
            <div style={{ padding: "12px 20px", fontSize: 11, color: C.tm, fontStyle: "italic" }}>
              {q ? `No orphan routines match "${q}"` : "No orphan routines for this ECU."}
            </div>
          )}
          {filteredOrphans.map((o, i) => <OrphanRow key={`${o.rid}-${i}`} o={o} />)}
        </div>
      )}
    </div>
  );
}

export default function DispatchCoverageTab() {
  const [q, setQ] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [sortBy, setSortBy] = useState("orphans"); // orphans | name | coverage | total

  const report = DISPATCH_GAP_REPORT;
  const agg = report.aggregate || {};
  const meta = report.meta || {};

  const filteredEcus = useMemo(() => {
    let rows = report.perEcu || [];
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(e =>
        e.ecu.toLowerCase().includes(needle) ||
        (e.orphans || []).some(o =>
          String(o.rid).toLowerCase().includes(needle) ||
          (o.platform || "").toLowerCase().includes(needle) ||
          (o.candidates || []).some(c => (c.frameHex || "").toLowerCase().includes(needle))
        )
      );
    }
    if (hideEmpty) rows = rows.filter(e => e.routinesOrphan > 0);

    const sorted = [...rows];
    if (sortBy === "name") sorted.sort((a, b) => a.ecu.localeCompare(b.ecu));
    else if (sortBy === "total") sorted.sort((a, b) => b.routinesTotal - a.routinesTotal);
    else if (sortBy === "coverage") sorted.sort((a, b) => {
      const pa = a.routinesTotal ? a.routinesWithFrame / a.routinesTotal : 0;
      const pb = b.routinesTotal ? b.routinesWithFrame / b.routinesTotal : 0;
      return pb - pa;
    });
    else sorted.sort((a, b) => b.routinesOrphan - a.routinesOrphan);
    return sorted;
  }, [report.perEcu, q, hideEmpty, sortBy]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <div style={{ fontFamily: "'Righteous', sans-serif", fontSize: 22, color: C.bk }}>
            DISPATCH COVERAGE
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: C.tm }}>
            ROUTINE → FRAME GAP · READ-ONLY
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.5 }}>
          Browses the full {agg.routinesTotal?.toLocaleString?.() || agg.routinesTotal} routine catalog
          extracted from AlfaOBD IL across {report.perEcu?.length || 0} ECU families and reports which
          routines have a statically-matched UDS frame. Heuristic candidate frames are
          <strong style={{ color: C.sr }}> NEVER confirmed-match</strong> — they are starting points for
          the next bench-capture pass, not an answer.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <StatBox label="Routines Total" value={agg.routinesTotal?.toLocaleString?.() || "—"} />
          <StatBox label="With Frame" value={agg.routinesWithFrame?.toLocaleString?.() || "—"} color={C.gn} />
          <StatBox label="Orphans" value={agg.routinesOrphan?.toLocaleString?.() || "—"} color={C.sr} />
          <StatBox label="Frames Attributed" value={`${agg.framesAttributed || 0} / ${agg.framesTotal || 0}`} color={C.a3} sub={`${agg.framesUnattributed || 0} unattributed`} />
          <StatBox label="Coverage" value={`${agg.coveragePercent ?? 0}%`} color={C.a1} />
        </div>
        <div style={{ fontSize: 10, color: C.tm, marginTop: 10, fontFamily: MONO }}>
          source: {meta.generatedAt || "—"} · candidateLimit={meta.candidateLimit ?? "—"}
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 12 }}>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="search rid, ECU name, platform, frame hex…"
            style={{
              flex: 1, minWidth: 240,
              padding: "8px 12px", fontSize: 12,
              border: `1.5px solid ${C.bd}`, borderRadius: 8,
              fontFamily: "'Nunito'", background: "#FFF",
            }}
          />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{
              padding: "8px 12px", fontSize: 12, border: `1.5px solid ${C.bd}`,
              borderRadius: 8, background: "#FFF", fontFamily: "'Nunito'", fontWeight: 700,
            }}
          >
            <option value="orphans">Sort: most orphans</option>
            <option value="total">Sort: most routines</option>
            <option value="coverage">Sort: best coverage</option>
            <option value="name">Sort: ECU name</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.ts, cursor: "pointer" }}>
            <input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} />
            hide fully-covered ECUs
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.ts, cursor: "pointer" }}>
            <input type="checkbox" checked={expandAll} onChange={e => setExpandAll(e.target.checked)} />
            expand all
          </label>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "minmax(180px,1.6fr) 70px 70px 70px 80px minmax(140px,1.2fr) 28px",
          gap: 10, padding: "6px 12px",
          background: "#F0EDE8", borderRadius: 6,
          fontSize: 9, fontWeight: 800, letterSpacing: 1, color: C.ts, textTransform: "uppercase",
        }}>
          <div>ECU Family</div>
          <div style={{ textAlign: "right" }}>Total</div>
          <div style={{ textAlign: "right" }}>w/ Frame</div>
          <div style={{ textAlign: "right" }}>Orphan</div>
          <div style={{ textAlign: "right" }}>Frames</div>
          <div>Coverage</div>
          <div />
        </div>
        <div style={{ marginTop: 4 }}>
          {filteredEcus.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: C.tm, fontSize: 12 }}>
              No ECU families match the current filter.
            </div>
          )}
          {filteredEcus.map(ecu => <EcuRow key={ecu.ecu} ecu={ecu} q={q} expandAll={expandAll} />)}
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#FFEBEE", border: `1px solid ${C.sr}33`, borderRadius: 6,
          fontSize: 10, color: "#B71C1C", lineHeight: 1.5,
        }}>
          <strong>⚠ Heuristic candidate frames are NEVER confirmed-match.</strong>{" "}
          {meta.heuristicNote || "Treat each candidate as a starting point for a bench-capture verification pass — not as an answer."}
        </div>
      </Card>
    </div>
  );
}
