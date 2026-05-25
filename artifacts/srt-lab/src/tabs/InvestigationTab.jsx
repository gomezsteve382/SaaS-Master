/**
 * Investigation Swarm Tab (Task #718).
 *
 * Sends a loaded ECU dump (or any File object) to the API, opens an SSE
 * stream, and renders five parallel specialist-agent columns updating in
 * real time. A synthesis pane appears once the COORDINATOR finishes.
 *
 * Strictly read-only — no writes to ECU or filesystem.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import { Card, Btn, Tag } from "../lib/ui.jsx";
import { C } from "../lib/constants.js";
import {
  parsePatternLookupOffsets,
  parseKgQueryBcmFeatures,
  parseKgQueryUnlocks,
} from "../lib/swarmToolResultParse.js";

/* ── constants ─────────────────────────────────────────────────────── */

const BASE = import.meta.env.BASE_URL ?? "/";
const API_BASE = `${BASE}api/anthropic`.replace(/\/+/g, "/");

const AGENT_IDS = ["CRYPTO", "PROTOCOL", "LAYOUT", "IMMOBILIZER", "CROSS_REF"];

const AGENT_META = {
  CRYPTO:      { icon: "🔑", color: "#D32F2F", label: "Crypto" },
  PROTOCOL:    { icon: "📡", color: "#1565C0", label: "Protocol" },
  LAYOUT:      { icon: "🗺️", color: "#2E7D32", label: "Layout" },
  IMMOBILIZER: { icon: "🔐", color: "#E65100", label: "Immobilizer" },
  CROSS_REF:   { icon: "🔗", color: "#6A1B9A", label: "Cross-Ref" },
};

/**
   * Task #745: when the FCA Module Inspector hands a dump over to the swarm via
   * srtlab:openInvestigation, we use the inspector's already-classified module
   * type to (a) auto-fill the scope and (b) render a one-line banner that tells
   * the agents (and the operator) which specialist parsers cover this family.
   * Keep these hints short — the full per-family detail lives in the agent
   * system prompts.
   */
  const MODULE_CONTEXT_HINTS = {
    XC2268_RFHUB: {
      label: "XC2268 RFHUB (2019+ internal-flash)",
      detail: "LAYOUT looks for the \"XC22\"/\"RFHUB\" header + variant byte at 0x0020; CRYPTO verifies the 3 VIN slots' CRC-16/CCITT and the BE32 image-wide checksum; IMMOBILIZER knows the 0x27 0x0B alt-level Dealer Lockout Bypass.",
    },
    ZF_8HP_TCU: {
      label: "ZF-8HP TCU (845RE / 8HP70 / 8HP90)",
      detail: "LAYOUT reads the \"ZF8HP\" header + variant tag at 0x0008; CRYPTO verifies both VIN-slot CRC-16/CCITT mirrors and walks every 64 KB block's BE32 zlib CRC-32 in the trailing 4 bytes.",
    },
    GPEC2A: { label: "GPEC2A PCM",              detail: "LAYOUT + IMMOBILIZER already specialise in this family." },
    RFHUB:  { label: "RFHUB (legacy Gen1/Gen2)", detail: "LAYOUT + IMMOBILIZER already specialise in this family." },
    BCM:    { label: "BCM D-FLASH",              detail: "LAYOUT + IMMOBILIZER already specialise in this family." },
  };

  const CONF_COLORS = { high: C.gn, medium: C.wn, low: "#999" };
const STATUS_BADGE = {
  pending:   { bg: "#E3F2FD", color: "#1565C0", label: "pending" },
  running:   { bg: "#FFF9C4", color: "#F57F17", label: "running…" },
  done:      { bg: "#E8F5E9", color: "#2E7D32", label: "done" },
  error:     { bg: "#FFEBEE", color: "#C62828", label: "error" },
  aborted:   { bg: "#F3E5F5", color: "#6A1B9A", label: "aborted" },
};

function confLevel(c) {
  if (c >= 0.75) return "high";
  if (c >= 0.45) return "medium";
  return "low";
}

function hex(n) {
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

/* ── sub-components ─────────────────────────────────────────────────── */

/* ── Tool-run renderer (Task #740) ──────────────────────────────────
 *
 * Each agent's tool calls are captured into `toolRuns` as we receive
 * them. When a tool result arrives, we parse the preview text into
 * structured deep-links the tech can click to land in the right tab:
 *
 *   pattern_lookup → hex offsets → Inspector → Hex Diff
 *   kg_query (BCM feature DEnn rows) → PROXI tab filtered to that DID
 *   kg_query (unlock-catalog rows)   → Unlock Coverage filtered to name
 *
 * Each deep-link stashes a one-shot handoff in sessionStorage, then
 * dispatches `srtlab:openTab` so App.jsx switches tabs and the target
 * tab's mount effect consumes the handoff.
 */

function deepLinkHexFocus({ dumpName, bytesB64, offset }) {
  try {
    sessionStorage.setItem(
      "srtlab.swarmJump.hexFocus",
      JSON.stringify({ dumpName, bytesB64, offset }),
    );
  } catch {
    // sessionStorage full / disabled — Inspector will simply no-op the focus.
  }
  window.dispatchEvent(new CustomEvent("srtlab:openTab", { detail: "inspector" }));
}

function deepLinkProxiDid(did) {
  try {
    sessionStorage.setItem("srtlab.swarmJump.proxiFilter", JSON.stringify({ did }));
  } catch { /* see hexFocus */ }
  window.dispatchEvent(new CustomEvent("srtlab:openTab", { detail: "proxi" }));
}

function deepLinkUnlockCoverage({ q, family, algorithm }) {
  try {
    sessionStorage.setItem(
      "srtlab.swarmJump.unlockFilter",
      JSON.stringify({ q, family, algorithm }),
    );
  } catch { /* see hexFocus */ }
  window.dispatchEvent(new CustomEvent("srtlab:openTab", { detail: "unlockcov" }));
}

function chipStyle(color) {
  return {
    background: color + "1A",
    color,
    border: "1px solid " + color + "55",
    borderRadius: 5,
    padding: "2px 7px",
    fontSize: 9,
    fontWeight: 800,
    fontFamily: "'JetBrains Mono',monospace",
    cursor: "pointer",
    marginRight: 4,
    marginTop: 3,
  };
}

function ToolRunCard({ run, dumpName, dumpBytesB64 }) {
  const offsets = run.toolName === "pattern_lookup"
    ? parsePatternLookupOffsets(run.preview)
    : [];
  const bcmFeatures = run.toolName === "kg_query"
    ? parseKgQueryBcmFeatures(run.preview)
    : [];
  const unlocks = run.toolName === "kg_query"
    ? parseKgQueryUnlocks(run.preview)
    : [];
  const canJumpToHex = !!(dumpName && dumpBytesB64);

  return (
    <div style={{
      background: C.c2, borderRadius: 6, padding: "6px 8px",
      marginBottom: 6, borderLeft: "3px solid " + (run.preview ? C.gn : C.tm),
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        fontFamily: "'JetBrains Mono',monospace",
      }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: C.ts }}>⚙ {run.toolName}</span>
        {run.args && (
          <span style={{ fontSize: 9, color: C.tm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
            {run.args}
          </span>
        )}
        {run.durationMs != null && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: C.tm }}>{run.durationMs}ms</span>
        )}
      </div>
      {run.preview && (
        <div style={{
          fontSize: 9, fontFamily: "'JetBrains Mono',monospace",
          color: C.tx, background: C.cd, borderRadius: 4,
          padding: "4px 6px", marginTop: 4, whiteSpace: "pre-wrap",
          maxHeight: 80, overflow: "auto",
        }}>{run.preview}</div>
      )}

      {/* pattern_lookup offset chips */}
      {offsets.length > 0 && (
        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap" }}>
          {offsets.slice(0, 12).map((off) => (
            <button
              key={off}
              onClick={() => deepLinkHexFocus({ dumpName, bytesB64: dumpBytesB64, offset: off })}
              disabled={!canJumpToHex}
              title={canJumpToHex
                ? `Jump to 0x${off.toString(16).toUpperCase().padStart(6, "0")} in the Hex Diff viewer`
                : "Re-upload the dump in the Investigation tab to enable hex jump"}
              style={{
                ...chipStyle("#1565C0"),
                opacity: canJumpToHex ? 1 : 0.4,
                cursor: canJumpToHex ? "pointer" : "not-allowed",
              }}
            >
              ↪ 0x{off.toString(16).toUpperCase().padStart(6, "0")}
            </button>
          ))}
          {offsets.length > 12 && (
            <span style={{ fontSize: 9, color: C.tm, marginLeft: 4, alignSelf: "center" }}>
              +{offsets.length - 12} more
            </span>
          )}
        </div>
      )}

      {/* kg_query BCM feature chips */}
      {bcmFeatures.length > 0 && (
        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap" }}>
          {bcmFeatures.slice(0, 8).map((f, i) => (
            <button
              key={i}
              onClick={() => deepLinkProxiDid(f.did)}
              title={`Open PROXI filtered to ${f.did} (${f.group} / ${f.field})`}
              style={chipStyle("#2E7D32")}
            >
              📋 {f.did} · {f.field}
            </button>
          ))}
          {bcmFeatures.length > 8 && (
            <span style={{ fontSize: 9, color: C.tm, marginLeft: 4, alignSelf: "center" }}>
              +{bcmFeatures.length - 8} more
            </span>
          )}
        </div>
      )}

      {/* kg_query unlock-catalog chips */}
      {unlocks.length > 0 && (
        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap" }}>
          {unlocks.slice(0, 6).map((u, i) => (
            <button
              key={i}
              onClick={() => deepLinkUnlockCoverage({ q: u.name, family: u.family, algorithm: u.algorithm })}
              title={`Open Unlock Coverage filtered to "${u.name}" (family ${u.family}, algorithm ${u.algorithm})`}
              style={chipStyle("#6A1B9A")}
            >
              🗝 {u.name} · {u.family}
            </button>
          ))}
          {unlocks.length > 6 && (
            <span style={{ fontSize: 9, color: C.tm, marginLeft: 4, alignSelf: "center" }}>
              +{unlocks.length - 6} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AgentColumn({ agentId, findings, status, toolLog, latestTool, toolRuns = [], dumpName, dumpBytesB64 }) {
  const meta = AGENT_META[agentId];
  const badgeCfg = STATUS_BADGE[status] || STATUS_BADGE.pending;
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      flex: "1 1 0", minWidth: 200, background: C.cd,
      border: "1.5px solid " + C.bd, borderTop: "3px solid " + meta.color,
      borderRadius: 10, padding: "10px 12px",
      fontFamily: "'Nunito',sans-serif",
    }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>{meta.icon}</span>
        <span style={{ fontWeight: 900, fontSize: 12, color: meta.color, letterSpacing: 0.8 }}>
          {agentId}
        </span>
        <span style={{
          marginLeft: "auto", fontSize: 9, fontWeight: 800,
          padding: "2px 7px", borderRadius: 6,
          background: badgeCfg.bg, color: badgeCfg.color,
        }}>{badgeCfg.label}</span>
      </div>

      {/* latest tool activity */}
      {latestTool && status === "running" && (
        <div style={{
          fontSize: 9, fontFamily: "'JetBrains Mono',monospace",
          color: C.ts, background: C.c2, borderRadius: 5, padding: "3px 7px",
          marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>⚙ {latestTool}</div>
      )}

      {/* findings */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 0.5 }}>
          FINDINGS ({findings.length})
        </span>
        {findings.length > 0 && (
          <button onClick={() => setCollapsed(v => !v)} style={{
            background: "none", border: "none", cursor: "pointer",
            color: C.ts, fontSize: 9, fontWeight: 700, padding: "2px 6px",
          }}>{collapsed ? "▼ show" : "▲ hide"}</button>
        )}
      </div>

      {!collapsed && findings.map((f, i) => {
        const cl = confLevel(f.confidence);
        return (
          <div key={i} style={{
            marginBottom: 6, padding: "6px 8px",
            background: C.c2, borderRadius: 6,
            borderLeft: "3px solid " + CONF_COLORS[cl],
          }}>
            <div style={{
              fontSize: 9, fontWeight: 800,
              color: CONF_COLORS[cl], marginBottom: 2,
              textTransform: "uppercase", letterSpacing: 0.5,
            }}>
              {f.findingType} · {Math.round(f.confidence * 100)}%
              {f.status === "VERIFIED" && (
                <span style={{ color: C.gn, marginLeft: 4 }}>✓</span>
              )}
            </div>
            <div style={{ fontSize: 10, color: C.tx, lineHeight: 1.4 }}>
              {f.description}
            </div>
            {f.offsets && f.offsets.length > 0 && (
              <div style={{
                fontSize: 9, fontFamily: "'JetBrains Mono',monospace",
                color: "#1565C0", marginTop: 3,
              }}>
                @ {f.offsets.slice(0, 3).map(hex).join(", ")}
                {f.offsets.length > 3 && " …"}
              </div>
            )}
          </div>
        );
      })}

      {!collapsed && findings.length === 0 && status !== "pending" && (
        <div style={{ fontSize: 10, color: C.tm, fontStyle: "italic", marginTop: 4 }}>
          {status === "running" ? "Analysing…" : "No findings."}
        </div>
      )}

      {/* Task #740 — tool runs with deep-links into Inspector / PROXI / Unlock Coverage */}
      {!collapsed && toolRuns.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, marginBottom: 4, letterSpacing: 0.5 }}>
            TOOL RUNS ({toolRuns.length})
          </div>
          {toolRuns.map((run, i) => (
            <ToolRunCard
              key={i}
              run={run}
              dumpName={dumpName}
              dumpBytesB64={dumpBytesB64}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SynthesisPane({ report }) {
  if (!report) return null;
  return (
    <Card style={{ marginTop: 16, padding: 18 }}>
      <div style={{
        fontSize: 11, fontWeight: 900, color: C.sr,
        letterSpacing: 1, marginBottom: 10,
        textTransform: "uppercase",
      }}>COORDINATOR SYNTHESIS</div>

      {/* Summary */}
      <div style={{
        fontSize: 12, color: C.tx, lineHeight: 1.6,
        marginBottom: 14, padding: "10px 14px",
        background: C.c2, borderRadius: 8,
        borderLeft: "3px solid " + C.sr,
      }}>
        {report.summary}
      </div>

      {/* Ranked findings */}
      {report.rankedFindings?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, marginBottom: 6, letterSpacing: 0.5 }}>
            RANKED FINDINGS ({report.rankedFindings.length})
          </div>
          {report.rankedFindings.map((f, i) => {
            const cl = confLevel(f.confidence);
            const sources = f.sources || [f.agent];
            return (
              <div key={i} style={{
                padding: "7px 10px", borderRadius: 7, marginBottom: 5,
                background: C.cd, border: "1px solid " + C.bd,
                borderLeft: "3px solid " + CONF_COLORS[cl],
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, background: CONF_COLORS[cl] + "20",
                    color: CONF_COLORS[cl], padding: "1px 7px", borderRadius: 5,
                  }}>
                    {f.findingType} · {Math.round(f.confidence * 100)}%
                    {f.status === "VERIFIED" && " ✓"}
                  </span>
                  <span style={{ fontSize: 9, color: C.tm }}>
                    by {sources.map(s => (AGENT_META[s]?.icon || "") + " " + s).join(", ")}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.tx, marginTop: 4, lineHeight: 1.4 }}>
                  {f.description}
                </div>
                {f.offsets?.length > 0 && (
                  <div style={{
                    fontSize: 9, fontFamily: "'JetBrains Mono',monospace",
                    color: "#1565C0", marginTop: 3,
                  }}>
                    @ {f.offsets.slice(0, 4).map(hex).join(", ")}
                    {f.offsets.length > 4 && " …"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Three-column: contradictions, gaps, next steps */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {[
          { label: "Contradictions", items: report.contradictions, color: C.er },
          { label: "Gaps", items: report.gaps, color: C.wn },
          { label: "Next Steps", items: report.recommendedNextSteps, color: C.gn },
        ].map(({ label, items, color }) => (
          <div key={label} style={{
            background: C.c2, borderRadius: 8, padding: "10px 12px",
          }}>
            <div style={{
              fontSize: 9, fontWeight: 800, color, letterSpacing: 0.5,
              textTransform: "uppercase", marginBottom: 6,
            }}>{label} ({items?.length ?? 0})</div>
            {(items || []).length === 0 && (
              <div style={{ fontSize: 10, color: C.tm, fontStyle: "italic" }}>None</div>
            )}
            {(items || []).map((s, i) => (
              <div key={i} style={{
                fontSize: 10, color: C.tx, marginBottom: 4,
                paddingLeft: 10, borderLeft: "2px solid " + color,
              }}>
                {s}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

function PastRunRow({ run, onLoad }) {
  const status = run.status;
  const badgeCfg = STATUS_BADGE[status] || STATUS_BADGE.pending;
  const date = new Date(run.startedAt).toLocaleString();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "7px 12px",
      borderBottom: "1px solid " + C.bd, flexWrap: "wrap",
    }}>
      <span style={{
        fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 5,
        background: badgeCfg.bg, color: badgeCfg.color, whiteSpace: "nowrap",
      }}>{badgeCfg.label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.tx, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {run.dumpName}
      </span>
      <span style={{ fontSize: 10, color: C.tm, whiteSpace: "nowrap" }}>{date}</span>
      <span style={{ fontSize: 10, color: C.tm, whiteSpace: "nowrap" }}>
        {(run.dumpSize / 1024).toFixed(1)} KB
      </span>
      {(status === "completed" || status === "error") && (
        <button onClick={() => onLoad(run.id)} style={{
          background: "none", border: "1px solid " + C.bd, borderRadius: 5,
          cursor: "pointer", color: C.ts, fontSize: 9, fontWeight: 700,
          padding: "2px 8px",
        }}>View</button>
      )}
    </div>
  );
}

/* ── Main tab component ─────────────────────────────────────────────── */

export default function InvestigationTab() {
  const [file, setFile]   = useState(null);
  const [refFile, setRefFile] = useState(null);
  const [scope, setScope] = useState(() => localStorage.getItem("srtlab.investigation.scope") || "");

  const [runId, setRunId]     = useState(null);
  const [runStatus, setRunStatus] = useState("idle"); // idle|starting|running|done|error

  const [agentStatus, setAgentStatus] = useState(() =>
    Object.fromEntries(AGENT_IDS.map(id => [id, "pending"])));
  const [agentFindings, setAgentFindings] = useState(() =>
    Object.fromEntries(AGENT_IDS.map(id => [id, []])));
  const [agentLatestTool, setAgentLatestTool] = useState(() =>
    Object.fromEntries(AGENT_IDS.map(id => [id, null])));
  // Task #740 — full tool-call/result transcript per agent. Each entry:
  // { toolName, args, preview, durationMs, error? }. Updated by the
  // agent_tool_call (push placeholder) + agent_tool_result (fill in
  // preview+duration on the most recent matching call) SSE events.
  const [toolRuns, setToolRuns] = useState(() =>
    Object.fromEntries(AGENT_IDS.map(id => [id, []])));
  // Base64 of the loaded primary dump bytes, captured at startRun time.
  // Used as the bytes payload of the hex-focus handoff so the Inspector
  // can load the dump on demand even if the user never visited the
  // Dumps tab. Cleared on resetState / past-run load.
  const [dumpBytesB64, setDumpBytesB64] = useState(null);
  const [dumpName, setDumpName] = useState(null);

  const [synthesis, setSynthesis] = useState(null);
  const [error, setError]         = useState(null);
  const [moduleHint, setModuleHint] = useState(null);
  const [pastRuns, setPastRuns]   = useState([]);
  const [pastLoading, setPastLoading] = useState(false);

  const eventSourceRef = useRef(null);
  const fileInputRef   = useRef(null);
  const refInputRef    = useRef(null);

  /* ── load past runs ──────────────────────────────────────────────── */

  const loadPastRuns = useCallback(async () => {
    setPastLoading(true);
    try {
      const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      const r = await fetch(`${API_BASE}/investigation/runs${qs}`);
      if (r.ok) setPastRuns(await r.json());
    } catch {
      // no-op
    } finally {
      setPastLoading(false);
    }
  }, [scope]);

  useEffect(() => { loadPastRuns(); }, [loadPastRuns]);

  /* ── load a past run ─────────────────────────────────────────────── */

  const loadPastRun = useCallback(async (id) => {
    try {
      const r = await fetch(`${API_BASE}/investigation/runs/${id}`);
      if (!r.ok) return;
      const data = await r.json();
      setRunId(id);
      setRunStatus(data.status === "completed" ? "done" : data.status || "done");
      setSynthesis(data.summary || null);
      // Rebuild findings per agent
      const byAgent = Object.fromEntries(AGENT_IDS.map(i => [i, []]));
      for (const f of data.findings || []) {
        if (byAgent[f.agent]) byAgent[f.agent].push(f.raw || f);
      }
      setAgentFindings(byAgent);
      setAgentStatus(Object.fromEntries(AGENT_IDS.map(i => [i, "done"])));
    } catch {
      setError("Failed to load run.");
    }
  }, []);

  /* ── cleanup SSE on unmount ──────────────────────────────────────── */

  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  /* ── external navigate-in event ─────────────────────────────────── */

  useEffect(() => {
    const onNav = (e) => {
      if (e.detail?.module) {
        const { bytes, name, moduleType } = e.detail.module;
        if (bytes && name) {
          const f = new File([bytes], name, { type: "application/octet-stream" });
          setFile(f);
          if (moduleType && MODULE_CONTEXT_HINTS[moduleType]) {
            setModuleHint({ type: moduleType, ...MODULE_CONTEXT_HINTS[moduleType] });
            // Inspector-driven navigation is authoritative about which family
            // this dump belongs to — override any stale scope (including one
            // restored from localStorage) so the swarm sees the right context.
            setScope(moduleType);
            try { localStorage.setItem("srtlab.investigation.scope", moduleType); } catch {}
          } else {
            setModuleHint(null);
          }
        }
      }
    };
    window.addEventListener("srtlab:openInvestigation", onNav);
    return () => window.removeEventListener("srtlab:openInvestigation", onNav);
  }, []);

  /* ── reset state ─────────────────────────────────────────────────── */

  function resetState() {
    eventSourceRef.current?.close();
    setRunId(null);
    setRunStatus("idle");
    setAgentStatus(Object.fromEntries(AGENT_IDS.map(id => [id, "pending"])));
    setAgentFindings(Object.fromEntries(AGENT_IDS.map(id => [id, []])));
    setAgentLatestTool(Object.fromEntries(AGENT_IDS.map(id => [id, null])));
    setToolRuns(Object.fromEntries(AGENT_IDS.map(id => [id, []])));
    setDumpBytesB64(null);
    setDumpName(null);
    setSynthesis(null);
    setError(null);
    setModuleHint(null);
  }

  /* ── start run ───────────────────────────────────────────────────── */

  const startRun = useCallback(async () => {
    if (!file) return;
    resetState();
    setRunStatus("starting");
    setError(null);

    try {
      // Read file to base64
      const readBase64 = (f) =>
        new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => {
            const b64 = btoa(
              String.fromCharCode(...new Uint8Array(fr.result)),
            );
            resolve(b64);
          };
          fr.onerror = reject;
          fr.readAsArrayBuffer(f);
        });

      const dumpBase64 = await readBase64(file);
      const referenceBase64 = refFile ? await readBase64(refFile) : undefined;
      setDumpBytesB64(dumpBase64);
      setDumpName(file.name);

      const scopeVal = scope.trim() || undefined;
      if (scopeVal) localStorage.setItem("srtlab.investigation.scope", scopeVal);

      const startRes = await fetch(`${API_BASE}/investigation/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dumpBase64,
          dumpName: file.name,
          referenceBase64,
          referenceName: refFile?.name,
          scope: scopeVal,
        }),
      });

      if (!startRes.ok) {
        const e = await startRes.json().catch(() => ({ error: startRes.statusText }));
        setError(e.error || "Failed to start run.");
        setRunStatus("error");
        return;
      }

      const { id } = await startRes.json();
      setRunId(id);
      setRunStatus("running");

      // Open SSE stream
      const streamUrl = `${API_BASE}/investigation/runs/${id}/stream`;
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      es.onmessage = (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { return; }

        switch (event.type) {
          case "agent_started":
            setAgentStatus(p => ({ ...p, [event.agent]: "running" }));
            break;
          case "agent_tool_call":
            setAgentLatestTool(p => ({ ...p, [event.agent]: event.toolName }));
            setToolRuns(p => ({
              ...p,
              [event.agent]: [
                ...(p[event.agent] || []),
                { toolName: event.toolName, args: event.args, preview: null, durationMs: null },
              ],
            }));
            break;
          case "agent_tool_result":
            // Fill in preview/duration on the most recent matching call
            // (no result yet) for this agent. Falls through to push a
            // fresh entry if call/result events arrived out of order.
            setToolRuns(p => {
              const list = (p[event.agent] || []).slice();
              for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].toolName === event.toolName && list[i].preview == null) {
                  list[i] = { ...list[i], preview: event.preview, durationMs: event.durationMs };
                  return { ...p, [event.agent]: list };
                }
              }
              list.push({
                toolName: event.toolName,
                args: "",
                preview: event.preview,
                durationMs: event.durationMs,
              });
              return { ...p, [event.agent]: list };
            });
            break;
          case "finding":
            setAgentFindings(p => ({
              ...p,
              [event.agent]: [...(p[event.agent] || []), event.finding],
            }));
            break;
          case "agent_done":
            setAgentStatus(p => ({ ...p, [event.agent]: "done" }));
            setAgentLatestTool(p => ({ ...p, [event.agent]: null }));
            break;
          case "agent_aborted":
            setAgentStatus(p => ({ ...p, [event.agent]: "aborted" }));
            break;
          case "agent_error":
            setAgentStatus(p => ({ ...p, [event.agent]: "error" }));
            break;
          case "synthesis":
            setSynthesis(event.report);
            break;
          case "done":
            setRunStatus("done");
            es.close();
            loadPastRuns();
            break;
          case "error":
            setError(event.error);
            setRunStatus("error");
            es.close();
            break;
          default: break;
        }
      };

      es.onerror = () => {
        if (runStatus !== "done") {
          setError("Stream connection lost.");
          setRunStatus("error");
        }
        es.close();
      };
    } catch (err) {
      setError(err.message || "Unknown error.");
      setRunStatus("error");
    }
  }, [file, refFile, scope, loadPastRuns]);

  /* ── cancel ──────────────────────────────────────────────────────── */

  const cancel = useCallback(() => {
    eventSourceRef.current?.close();
    setRunStatus("done");
  }, []);

  /* ── delete a past run ───────────────────────────────────────────── */

  const deleteRun = useCallback(async (id) => {
    await fetch(`${API_BASE}/investigation/runs/${id}`, { method: "DELETE" });
    loadPastRuns();
  }, [loadPastRuns]);

  const isRunning = runStatus === "running" || runStatus === "starting";
  const totalFindings = Object.values(agentFindings).reduce((s, a) => s + a.length, 0);

  /* ── render ──────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: "0 0 40px 0", fontFamily: "'Nunito',sans-serif" }}>
      {/* ── header ── */}
      <div style={{
        background: "linear-gradient(135deg, #1A1A1A 0%, #2C1010 100%)",
        borderRadius: "0 0 16px 16px", padding: "24px 28px", marginBottom: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 28 }}>🔬</span>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", fontFamily: "'Righteous',sans-serif", letterSpacing: 1 }}>
              INVESTIGATION SWARM
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
              Five parallel specialist agents · read-only forensic analysis
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {AGENT_IDS.map(id => (
              <div key={id} style={{
                fontSize: 8, fontWeight: 800, padding: "3px 8px",
                borderRadius: 5, letterSpacing: 0.8,
                background: AGENT_META[id].color + "33",
                color: AGENT_META[id].color, border: "1px solid " + AGENT_META[id].color + "66",
              }}>
                {AGENT_META[id].icon} {id}
              </div>
            ))}
            <div style={{
              fontSize: 8, fontWeight: 800, padding: "3px 8px", borderRadius: 5,
              background: "#FFECB3", color: "#E65100",
            }}>🧠 COORDINATOR</div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          READ-ONLY — no bytes are written to any ECU or file during analysis
        </div>
      </div>

      {/* ── run configuration ── */}
      <Card style={{ marginBottom: 14, padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 12, letterSpacing: 0.5 }}>
          CONFIGURE INVESTIGATION RUN
        </div>

        {moduleHint && (
          <div data-testid="investigation-module-hint" style={{
            marginBottom: 12, padding: "8px 12px",
            background: "#FFF3E0", border: "1px solid #FFB74D", borderLeft: "3px solid #E65100",
            borderRadius: 7, fontSize: 11, color: "#5D4037", lineHeight: 1.4,
          }}>
            <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: 0.6, color: "#E65100", marginBottom: 3 }}>
              DETECTED MODULE CONTEXT · {moduleHint.type}
            </div>
            <div style={{ fontWeight: 700 }}>{moduleHint.label}</div>
            <div style={{ marginTop: 3 }}>{moduleHint.detail}</div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
          {/* Primary dump */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, marginBottom: 4 }}>
              ECU DUMP (required)
            </div>
            <div style={{
              border: "2px dashed " + (file ? C.gn : C.bd),
              borderRadius: 8, padding: "10px 14px", cursor: "pointer",
              background: file ? "#E8F5E9" : C.c2,
              transition: "all 0.2s",
            }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) setFile(f);
              }}
            >
              <input
                ref={fileInputRef} type="file" accept=".bin,.hex,.eep"
                style={{ display: "none" }}
                onChange={e => e.target.files[0] && setFile(e.target.files[0])}
              />
              <div style={{ fontSize: 11, color: file ? C.gn : C.tm, fontWeight: 700 }}>
                {file ? `✓ ${file.name} (${(file.size / 1024).toFixed(1)} KB)` : "Drop .bin / click to browse"}
              </div>
            </div>
          </div>

          {/* Reference dump */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, marginBottom: 4 }}>
              REFERENCE DUMP (optional — enables hex diff)
            </div>
            <div style={{
              border: "2px dashed " + (refFile ? "#1565C0" : C.bd),
              borderRadius: 8, padding: "10px 14px", cursor: "pointer",
              background: refFile ? "#E3F2FD" : C.c2,
            }}
              onClick={() => refInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) setRefFile(f);
              }}
            >
              <input
                ref={refInputRef} type="file" accept=".bin,.hex,.eep"
                style={{ display: "none" }}
                onChange={e => e.target.files[0] && setRefFile(e.target.files[0])}
              />
              <div style={{ fontSize: 11, color: refFile ? "#1565C0" : C.tm, fontWeight: 700 }}>
                {refFile ? `✓ ${refFile.name} (${(refFile.size / 1024).toFixed(1)} KB)` : "Optional — drop .bin / click to browse"}
              </div>
              {refFile && (
                <button onClick={e => { e.stopPropagation(); setRefFile(null); }} style={{
                  background: "none", border: "none", cursor: "pointer", fontSize: 12,
                  color: C.tm, float: "right", marginTop: -20,
                }}>×</button>
              )}
            </div>
          </div>

          {/* Scope + Run button */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, marginBottom: 4 }}>SCOPE (optional)</div>
              <input
                value={scope}
                onChange={e => setScope(e.target.value)}
                placeholder="bench-session-1"
                style={{
                  width: "100%", border: "1.5px solid " + C.bd, borderRadius: 6,
                  padding: "7px 10px", fontSize: 11, fontFamily: "'Nunito',sans-serif",
                  background: C.c2, color: C.tx, boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn
                color={C.sr}
                disabled={!file || isRunning}
                onClick={startRun}
                style={{ flex: 1, fontSize: 11 }}
              >
                {isRunning ? "⏳ Running…" : "▶ Start Investigation"}
              </Btn>
              {isRunning && (
                <Btn color={C.tm} outline onClick={cancel} style={{ fontSize: 11 }}>
                  ✕ Cancel
                </Btn>
              )}
              {!isRunning && runId && (
                <Btn color={C.tm} outline onClick={resetState} style={{ fontSize: 11 }}>
                  ↺ Reset
                </Btn>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* ── error banner ── */}
      {error && (
        <div style={{
          background: "#FFEBEE", border: "1.5px solid #EF9A9A",
          borderRadius: 8, padding: "10px 14px", marginBottom: 14,
          fontSize: 11, color: "#C62828", fontWeight: 700,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* ── live status header ── */}
      {runId && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "8px 14px", marginBottom: 12, background: C.cd,
          border: "1.5px solid " + C.bd, borderRadius: 8, fontSize: 11,
        }}>
          <span style={{ fontWeight: 800, color: C.tx }}>Run ID:</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", color: C.ts, fontSize: 10 }}>{runId}</span>
          <span style={{ marginLeft: "auto", fontWeight: 800, color: C.tx }}>Findings: {totalFindings}</span>
          <span style={{
            fontSize: 10, fontWeight: 800, padding: "2px 10px", borderRadius: 6,
            ...(STATUS_BADGE[runStatus] || STATUS_BADGE.pending),
          }}>
            {(STATUS_BADGE[runStatus] || STATUS_BADGE.pending).label}
          </span>
        </div>
      )}

      {/* ── five agent columns ── */}
      {runId && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          {AGENT_IDS.map(id => (
            <AgentColumn
              key={id}
              agentId={id}
              findings={agentFindings[id] || []}
              status={agentStatus[id] || "pending"}
              latestTool={agentLatestTool[id]}
              toolRuns={toolRuns[id] || []}
              dumpName={dumpName}
              dumpBytesB64={dumpBytesB64}
            />
          ))}
        </div>
      )}

      {/* ── synthesis pane ── */}
      {synthesis && <SynthesisPane report={synthesis} />}

      {/* ── past runs ── */}
      <Card style={{ marginTop: 20 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 14px 10px",
          borderBottom: pastRuns.length ? "1px solid " + C.bd : "none",
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 0.5 }}>
            PAST RUNS {pastLoading ? "…" : `(${pastRuns.length})`}
          </div>
          <button onClick={loadPastRuns} style={{
            background: "none", border: "1px solid " + C.bd, borderRadius: 5,
            cursor: "pointer", fontSize: 9, fontWeight: 700, color: C.ts,
            padding: "2px 10px",
          }}>↻ Refresh</button>
        </div>
        {!pastLoading && pastRuns.length === 0 && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: C.tm, fontStyle: "italic" }}>
            No past runs yet. Start an investigation above.
          </div>
        )}
        {pastRuns.map(run => (
          <PastRunRow key={run.id} run={run} onLoad={loadPastRun} />
        ))}
      </Card>
    </div>
  );
}
