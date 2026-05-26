/* AlfaObdIntelTab — read-only AlfaOBD intelligence cross-reference.
 *
 * Six sections, all strictly read-only with provenance banners:
 *   1. UDS Frame Dictionary   (851 unique frames extracted from AlfaOBD.exe IL)
 *   2. Routine Catalog        (1,696 routines from Method[1163] .ctor)
 *   3. Frame→Routine map      (499 dispatch matches)
 *   4. ECU→CAN pairings       (70 entries)
 *   5. Security Intel         (CodeCard flow, credential storage, protocol names)
 *   6. DB Schema              (19 tables + dispatch gap analysis)
 *
 * All data is static. No button sends any frame to a vehicle.
 * The 5-byte CodeCard hex tokens in Section 5 carry inline caveats. */

import React, { useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";

import {
  UDS_DISPATCH_META,
  UDS_DISPATCH_FRAMES,
  UDS_ROUTINE_CONTROL_BY_RID,
  UDS_SECURITY_ACCESS_REQUESTS,
  UDS_RDBI_BY_DID,
  UDS_WDBI_BY_DID,
  UDS_DSC_FRAMES,
  UDS_ECU_RESET_FRAMES,
  UDS_OTHER_FRAMES,
} from "../lib/udsDispatchFromExe.generated.js";

import {
  ROUTINE_CATALOG_META,
  ROUTINE_CATALOG_FROM_EXE,
} from "../lib/routineCatalogFromExe.generated.js";

import {
  DISPATCH_TO_ROUTINE_META,
  UDS_FRAME_TO_ROUTINES,
} from "../lib/dispatchToRoutine.generated.js";

import {
  ECU_TO_CAN_META,
  ECU_TO_CAN_FROM_EXE,
} from "../lib/ecuToCanFromExe.generated.js";

import {
  ALFAOBD_CREDENTIAL_STORAGE,
  SEND_CODE_CARD_LOGIN_METHOD,
  KWP2000_DOOR_MODULES,
  ALFAOBD_CAN_PROTOCOL_NAMES,
  LEGACY_PROTOCOLS_SUPPORTED,
  OBD_ADAPTER_DETECTION,
} from "../lib/securityIntelFromExe.generated.js";

import {
  parseHexBytes,
  evaluateAllCandidateTokens,
  findLastSeedKeyPair,
} from "../lib/codecardHarness/index.js";
import { parseTrace } from "../lib/udsSessionAnalyzer/parser.js";

import {
  ALFAOBD_DB_TABLES,
  ALFAOBD_DB_DISPATCH_GAP,
  ALFAOBD_DB_META,
} from "../lib/alfaobdDbSchema.generated.js";

import { DISPATCH_GAP_REPORT } from "../lib/dispatchGapReport.generated.js";

/* ── palette ──────────────────────────────────────────────────────────── */
const MONO = "'JetBrains Mono', monospace";
const SANS = "'Nunito', sans-serif";

/* ── shared layout helpers ────────────────────────────────────────────── */
function SectionHead({ icon, title, count, subtitle }) {
  return (
    <div style={{ margin: "24px 0 10px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: SANS, fontWeight: 900, fontSize: 12,
        color: C.tm, letterSpacing: 1.8, textTransform: "uppercase",
      }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        {title}
        {count !== undefined && (
          <span style={{
            fontFamily: MONO, fontSize: 10,
            background: "#E8E4DE", borderRadius: 99,
            padding: "1px 8px", color: C.ts,
          }}>{count.toLocaleString()}</span>
        )}
      </div>
      {subtitle && (
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.ts, marginTop: 3 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function ProvenanceBanner({ text }) {
  return (
    <div style={{
      background: "#FFF8E1", border: "1px solid #FFD54F",
      borderRadius: 6, padding: "6px 12px", marginBottom: 10,
      fontFamily: SANS, fontSize: 11, color: "#5D4037",
      display: "flex", alignItems: "flex-start", gap: 6,
    }}>
      <span style={{ fontSize: 13, flexShrink: 0 }}>&#9432;</span>
      <span>{text}</span>
    </div>
  );
}

function WarnBanner({ text }) {
  return (
    <div style={{
      background: "#FFF3E0", border: "1px solid #FFAB40",
      borderRadius: 6, padding: "6px 12px", marginBottom: 10,
      fontFamily: SANS, fontSize: 11, color: "#BF360C",
      display: "flex", alignItems: "flex-start", gap: 6,
    }}>
      <span style={{ fontSize: 13, flexShrink: 0 }}>&#9888;</span>
      <span>{text}</span>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder || "Search…"}
      style={{
        width: "100%", boxSizing: "border-box",
        padding: "7px 10px", borderRadius: 6,
        border: "1px solid #CCC", fontFamily: MONO,
        fontSize: 12, background: "#FAFAF8",
        outline: "none", marginBottom: 10,
      }}
    />
  );
}

function Mono({ children, dim }) {
  return (
    <code style={{
      fontFamily: MONO, fontSize: 11,
      background: dim ? "transparent" : "#F0F0F0",
      padding: dim ? 0 : "1px 5px",
      borderRadius: dim ? 0 : 4,
      color: dim ? C.ts : C.bk,
    }}>{children}</code>
  );
}

function PaginationBar({ page, total, perPage, onPage }) {
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) return null;
  return (
    <div style={{
      display: "flex", gap: 6, alignItems: "center",
      fontFamily: SANS, fontSize: 11, color: C.ts,
      marginTop: 8, flexWrap: "wrap",
    }}>
      <button
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        style={pageBtnStyle(page === 0)}
      >&#8592; Prev</button>
      <span>Page {page + 1} / {pages} ({total.toLocaleString()} rows)</span>
      <button
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
        style={pageBtnStyle(page >= pages - 1)}
      >Next &#8594;</button>
    </div>
  );
}

function pageBtnStyle(disabled) {
  return {
    padding: "3px 10px", borderRadius: 5,
    border: "1px solid #CCC",
    background: disabled ? "#F5F5F5" : "#FFF",
    color: disabled ? "#AAA" : C.bk,
    cursor: disabled ? "default" : "pointer",
    fontFamily: SANS, fontSize: 11,
  };
}

const ROW_STYLE = {
  borderBottom: "1px solid #EEE",
  padding: "6px 2px",
  display: "grid",
  alignItems: "start",
  gap: "0 10px",
};

const TH_STYLE = {
  fontFamily: SANS, fontWeight: 800, fontSize: 10,
  color: C.ts, letterSpacing: 1, textTransform: "uppercase",
  borderBottom: "2px solid #DDD", paddingBottom: 4, marginBottom: 2,
  display: "grid", alignItems: "center", gap: "0 10px",
};

/* ── Section 1: UDS Frame Dictionary ─────────────────────────────────── */
const SID_COLORS = {
  DSC: "#1565C0", SecurityAccess: "#6A1B9A", RoutineControl: "#2E7D32",
  ReadDBI: "#E65100", WriteDBI: "#BF360C", ReadDTC: "#37474F",
  ClearDTC: "#37474F", RequestDownload: "#4E342E", TransferData: "#4E342E",
  ExitTransfer: "#4E342E", TesterPresent: "#78909C", KWP_ReadFault: "#78909C",
  KWP_ReadDTCByStatus: "#78909C",
};
function sidColor(name) {
  for (const [k, v] of Object.entries(SID_COLORS)) {
    if (name && name.includes(k)) return v;
  }
  return C.ts;
}

const PER_PAGE_FRAMES = 25;
const PER_PAGE_ROUTINES = 25;

function UdsFrameSection() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!q.trim()) return UDS_DISPATCH_FRAMES;
    const lq = q.toLowerCase();
    return UDS_DISPATCH_FRAMES.filter(f =>
      f.hex.toLowerCase().includes(lq) ||
      (f.sid_name || "").toLowerCase().includes(lq) ||
      (f.methods || []).some(m => m.toLowerCase().includes(lq))
    );
  }, [q]);

  const pageData = useMemo(
    () => filtered.slice(page * PER_PAGE_FRAMES, (page + 1) * PER_PAGE_FRAMES),
    [filtered, page]
  );

  const handleSearch = v => { setQ(v); setPage(0); };

  const grid = "120px 110px 52px 1fr";

  return (
    <>
      <ProvenanceBanner
        text={`Source: AlfaOBD.exe v2.5.7.0 IL — ${UDS_DISPATCH_META.method_count_scanned} methods scanned. Frames deduplicated by hex content. Read-only reference — no ECU transmission.`}
      />
      <SearchBox value={q} onChange={handleSearch} placeholder="Search hex, SID name, method name…" />
      <div style={{ ...TH_STYLE, gridTemplateColumns: grid }}>
        <span>Hex bytes</span>
        <span>Service</span>
        <span>Hits</span>
        <span>IL methods</span>
      </div>
      {pageData.map((f, i) => (
        <div key={i} style={{ ...ROW_STYLE, gridTemplateColumns: grid, fontSize: 11 }}>
          <Mono>{f.hex}</Mono>
          <span style={{
            fontFamily: SANS, fontSize: 10, fontWeight: 700,
            color: sidColor(f.sid_name), letterSpacing: 0.5,
          }}>{f.sid_name || "—"}</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.ts }}>
            {f.occurrences}
          </span>
          <span style={{
            fontFamily: SANS, fontSize: 10, color: C.ts,
            lineHeight: 1.5,
          }}>
            {(f.methods || []).join(" · ")}
          </span>
        </div>
      ))}
      <PaginationBar page={page} total={filtered.length} perPage={PER_PAGE_FRAMES} onPage={setPage} />
    </>
  );
}

/* SID breakdown mini-chart */
function SidBreakdown() {
  const sidData = UDS_DISPATCH_META.frames_by_sid || {};
  const entries = Object.entries(sidData).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(e => e[1]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 12 }}>
      {entries.map(([name, count]) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 110, fontFamily: SANS, fontSize: 10, fontWeight: 700,
            color: sidColor(name), textAlign: "right", flexShrink: 0,
          }}>{name}</div>
          <div style={{
            height: 12, borderRadius: 2,
            background: sidColor(name) + "33",
            border: `1px solid ${sidColor(name)}55`,
            width: Math.max(4, (count / max) * 180),
            flexShrink: 0,
          }} />
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.ts }}>{count}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Section 2: Routine Catalog ───────────────────────────────────────── */
function RoutineCatalogSection() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const allRoutines = useMemo(() =>
    Object.entries(ROUTINE_CATALOG_FROM_EXE).map(([rid, fields]) => ({
      rid,
      ecuCode: fields["0"] || "",
      ecuName: fields["1"] || "",
      platform: fields["15"] || "",
    })),
  []);

  const filtered = useMemo(() => {
    if (!q.trim()) return allRoutines;
    const lq = q.toLowerCase();
    return allRoutines.filter(r =>
      r.rid.includes(lq) ||
      r.ecuCode.toLowerCase().includes(lq) ||
      r.ecuName.toLowerCase().includes(lq) ||
      r.platform.toLowerCase().includes(lq)
    );
  }, [q, allRoutines]);

  const pageData = useMemo(
    () => filtered.slice(page * PER_PAGE_ROUTINES, (page + 1) * PER_PAGE_ROUTINES),
    [filtered, page]
  );

  const handleSearch = v => { setQ(v); setPage(0); };
  const grid = "60px 90px 1fr 1fr";

  return (
    <>
      <ProvenanceBanner
        text={`Source: AlfaOBD.exe Method[1163] .ctor IL (salt=14). ${ROUTINE_CATALOG_META.totalRoutines.toLocaleString()} routines decoded. Routine identifiers (UDS RIDs) and security levels are NOT in this extract — they live in an unmatched DB table.`}
      />
      <SearchBox value={q} onChange={handleSearch} placeholder="Search routine ID, ECU code, ECU name, platform…" />
      <div style={{ ...TH_STYLE, gridTemplateColumns: grid }}>
        <span>RID</span>
        <span>ECU code</span>
        <span>ECU name</span>
        <span>Vehicle platform</span>
      </div>
      {pageData.map((r, i) => (
        <div key={i} style={{ ...ROW_STYLE, gridTemplateColumns: grid, fontSize: 11 }}>
          <Mono>{r.rid}</Mono>
          <span style={{ fontFamily: MONO, fontSize: 10, color: "#1565C0" }}>{r.ecuCode || "—"}</span>
          <span style={{ fontFamily: SANS, fontSize: 11 }}>{r.ecuName || "—"}</span>
          <span style={{ fontFamily: SANS, fontSize: 10, color: C.ts }}>{r.platform || "—"}</span>
        </div>
      ))}
      <PaginationBar page={page} total={filtered.length} perPage={PER_PAGE_ROUTINES} onPage={setPage} />
    </>
  );
}

/* ── Section 3: Frame→Routine map ─────────────────────────────────────── */
function FrameRoutineSection() {
  const [q, setQ] = useState("");
  const entries = useMemo(() => Object.entries(UDS_FRAME_TO_ROUTINES), []);

  const filtered = useMemo(() => {
    if (!q.trim()) return entries;
    const lq = q.toLowerCase();
    return entries.filter(([hex, rids]) =>
      hex.toLowerCase().includes(lq) ||
      rids.some(r => String(r).includes(lq))
    );
  }, [q, entries]);

  const grid = "160px 1fr";

  return (
    <>
      <ProvenanceBanner
        text={`Source: cross-join of UDS frame IL with routine catalog. ${DISPATCH_TO_ROUTINE_META.matched_dispatch_count} dispatch matches; ${DISPATCH_TO_ROUTINE_META.unambiguous_matches} unambiguous. Only unambiguous matches shown per frame.`}
      />
      <SearchBox value={q} onChange={v => setQ(v)} placeholder="Search UDS hex or routine ID…" />
      <div style={{ ...TH_STYLE, gridTemplateColumns: grid }}>
        <span>UDS frame (hex)</span>
        <span>Resolved routine IDs</span>
      </div>
      {filtered.map(([hex, rids]) => (
        <div key={hex} style={{ ...ROW_STYLE, gridTemplateColumns: grid, fontSize: 11 }}>
          <Mono>{hex}</Mono>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {rids.map(rid => (
              <span key={rid} style={{
                fontFamily: MONO, fontSize: 10,
                background: "#E3F2FD", borderRadius: 4,
                padding: "1px 6px", color: "#1565C0",
              }}>{rid}</span>
            ))}
          </div>
        </div>
      ))}
      {filtered.length === 0 && (
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.ts, padding: "8px 0" }}>
          No matches.
        </div>
      )}
    </>
  );
}

/* ── Section 4: ECU→CAN pairings ──────────────────────────────────────── */
function EcuCanSection() {
  const [q, setQ] = useState("");
  const entries = useMemo(() =>
    Object.entries(ECU_TO_CAN_FROM_EXE).map(([name, ids]) => ({
      name,
      hexIds: ids.map(n => "0x" + n.toString(16).toUpperCase().padStart(3, "0")),
    })),
  []);

  const filtered = useMemo(() => {
    if (!q.trim()) return entries;
    const lq = q.toLowerCase();
    return entries.filter(e =>
      e.name.toLowerCase().includes(lq) ||
      e.hexIds.some(h => h.toLowerCase().includes(lq))
    );
  }, [q, entries]);

  const grid = "1fr 200px";

  return (
    <>
      <ProvenanceBanner
        text={`Source: AlfaOBD.exe IL — ${ECU_TO_CAN_META.methods_scanned} methods scanned; ${ECU_TO_CAN_META.unique_pairings} unique ECU/platform → CAN-ID pairings recovered. Numeric-only keys are AlfaOBD internal ECU-type IDs, not human-readable names.`}
      />
      <SearchBox value={q} onChange={v => setQ(v)} placeholder="Search ECU name or CAN ID…" />
      <div style={{ ...TH_STYLE, gridTemplateColumns: grid }}>
        <span>ECU / platform name</span>
        <span>CAN IDs (hex)</span>
      </div>
      {filtered.map(({ name, hexIds }) => (
        <div key={name} style={{ ...ROW_STYLE, gridTemplateColumns: grid, fontSize: 11 }}>
          <span style={{
            fontFamily: /^\d/.test(name) ? MONO : SANS,
            fontSize: /^\d/.test(name) ? 10 : 11,
            color: /^\d/.test(name) ? C.ts : C.bk,
          }}>{name}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {hexIds.map(h => (
              <span key={h} style={{
                fontFamily: MONO, fontSize: 10,
                background: "#F3E5F5", borderRadius: 4,
                padding: "1px 6px", color: "#6A1B9A",
              }}>{h}</span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ── CodeCard bench-pair harness panel (Task #828) ────────────────────── */
function CodecardHarnessPanel() {
  const [open, setOpen] = useState(false);
  const [seedHex, setSeedHex] = useState("");
  const [keyHex, setKeyHex] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);
  const [imported, setImported] = useState(null); // 'ok' | 'none' | 'fail' | null

  const importFromSession = () => {
    setError("");
    setImported(null);
    try {
      const text = window.localStorage.getItem("srtlab.udsAnalyzer.lastTrace.v1");
      if (!text || !text.trim()) {
        setImported("none");
        return;
      }
      const parsed = parseTrace(text);
      const pair = findLastSeedKeyPair(parsed.lines);
      if (!pair) {
        setImported("none");
        return;
      }
      const toHex = (u8) => Array.from(u8, (b) =>
        b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
      setSeedHex(toHex(pair.seed));
      setKeyHex(toHex(pair.key));
      setImported("ok");
    } catch {
      setImported("fail");
    }
  };

  const run = () => {
    setError("");
    setResults(null);
    let seedBytes, keyBytes;
    try {
      seedBytes = parseHexBytes(seedHex);
      keyBytes = parseHexBytes(keyHex);
    } catch (e) {
      setError(`Could not parse hex: ${e.message}`);
      return;
    }
    if (!seedBytes.length || !keyBytes.length) {
      setError("Both seed and key are required.");
      return;
    }
    const out = evaluateAllCandidateTokens([{ seed: seedBytes, key: keyBytes }]);
    setResults(out);
  };

  return (
    <div style={intelCard}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none", border: "none", cursor: "pointer",
          fontFamily: SANS, fontSize: 12, fontWeight: 700,
          color: "#1565C0", display: "flex", alignItems: "center", gap: 6, padding: 0,
        }}
      >
        <span>{open ? "▼" : "▶"}</span>
        Test CodeCard candidates against a bench pair
        <span style={{
          fontFamily: MONO, fontSize: 10, background: "#E3F2FD",
          borderRadius: 99, padding: "1px 8px", color: "#1565C0",
        }}>HARNESS</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <WarnBanner text="A single positive bench pair is suggestive, not cryptographic verification. Two or three pairs from independent seeds are needed before any token can be promoted out of the UNVERIFIED bucket. The harness never sends frames — it only evaluates recorded bytes." />

          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={importFromSession}
              style={{
                padding: "5px 10px", borderRadius: 5,
                border: "1px solid #1565C0", background: "#FFF",
                color: "#1565C0", cursor: "pointer",
                fontFamily: SANS, fontSize: 11, fontWeight: 700,
              }}
            >Import from current session</button>
            {imported === "ok" && (
              <span style={{ fontFamily: SANS, fontSize: 11, color: "#2E7D32" }}>
                Filled from the last 27 03 / 27 04 pair in the UDS Analyzer trace.
              </span>
            )}
            {imported === "none" && (
              <span style={{ fontFamily: SANS, fontSize: 11, color: "#BF360C" }}>
                No 27 03 / 27 04 pair found in the last UDS Analyzer trace. Paste seed and key manually below.
              </span>
            )}
            {imported === "fail" && (
              <span style={{ fontFamily: SANS, fontSize: 11, color: "#BF360C" }}>
                Could not read the last UDS Analyzer trace from local storage.
              </span>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 6, marginBottom: 8, alignItems: "center" }}>
            <label style={{ fontFamily: SANS, fontSize: 11, color: C.ts }}>Seed (hex)</label>
            <input
              type="text" value={seedHex} onChange={(e) => setSeedHex(e.target.value)}
              placeholder="e.g. AA BB CC DD"
              style={{
                padding: "5px 8px", borderRadius: 5, border: "1px solid #CCC",
                fontFamily: MONO, fontSize: 11, background: "#FAFAF8", outline: "none",
              }}
            />
            <label style={{ fontFamily: SANS, fontSize: 11, color: C.ts }}>Key (hex)</label>
            <input
              type="text" value={keyHex} onChange={(e) => setKeyHex(e.target.value)}
              placeholder="e.g. 11 22 33 44 55"
              style={{
                padding: "5px 8px", borderRadius: 5, border: "1px solid #CCC",
                fontFamily: MONO, fontSize: 11, background: "#FAFAF8", outline: "none",
              }}
            />
          </div>

          <button
            onClick={run}
            style={{
              padding: "6px 14px", borderRadius: 5,
              border: "1px solid #B71C1C", background: "#FFEBEE",
              color: "#B71C1C", cursor: "pointer",
              fontFamily: SANS, fontSize: 11, fontWeight: 800,
              letterSpacing: 0.5, textTransform: "uppercase",
            }}
          >Run harness</button>

          {error && (
            <div style={{
              marginTop: 8, fontFamily: SANS, fontSize: 11, color: "#B71C1C",
            }}>{error}</div>
          )}

          {results && (
            <div style={{ marginTop: 12 }}>
              {results.map(({ token, result }) => (
                <CodecardVerdictCard key={token.hex} token={token} result={result} />
              ))}
              <div style={{
                marginTop: 6, fontFamily: SANS, fontSize: 10, color: C.ts,
                fontStyle: "italic",
              }}>
                Verdicts are not promoted to "verified" automatically. Update
                <code style={{ margin: "0 4px" }}>securityIntelFromExe.generated.js</code>
                or <code>algos.js</code> only after independent confirmation across multiple bench pairs.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function verdictColor(v) {
  if (v === "confirmed-constant-key" || v === "confirmed-derivation-input") return "#2E7D32";
  if (v === "rejected") return "#B71C1C";
  return "#BF360C"; // inconclusive
}
function verdictLabel(v) {
  if (v === "confirmed-constant-key")      return "CONFIRMED — constant key";
  if (v === "confirmed-derivation-input")  return "CONFIRMED — derivation input";
  if (v === "rejected")                    return "REJECTED";
  return "INCONCLUSIVE — need more pairs";
}

function CodecardVerdictCard({ token, result }) {
  const color = verdictColor(result.overall);
  return (
    <div style={{
      ...intelCard, marginBottom: 8, background: "#FFF",
      borderColor: color + "55",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Mono>{token.hex}</Mono>
        <span style={{
          fontFamily: SANS, fontSize: 10, fontWeight: 800,
          padding: "2px 8px", borderRadius: 99,
          background: color + "1A", color, letterSpacing: 0.5,
        }}>{verdictLabel(result.overall)}</span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 10, color: C.ts, marginTop: 4 }}>
        {result.reason}
      </div>
      {result.perPair.map((p, i) => (
        <div key={i} style={{
          marginTop: 6, padding: "6px 8px",
          background: "#FAFAF8", borderRadius: 5,
          fontFamily: MONO, fontSize: 10, color: C.bk,
        }}>
          <div>seed: {p.seed}</div>
          <div>key:  {p.key}</div>
          {p.degenerate && (
            <div style={{ color: "#BF360C", marginTop: 2 }}>
              ⚠ degenerate input (all-zero / all-FF / seed == key) — any transform matches trivially
            </div>
          )}
          <div style={{ marginTop: 4, color: C.ts }}>
            {p.hypotheses.map((h) => (
              <div key={h.name}>
                {h.matched ? "✓" : "✗"} {h.name}: {h.detail}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Section 5: Security Intel ────────────────────────────────────────── */
function SecurityIntelSection() {
  const [showCodecard, setShowCodecard] = useState(false);

  return (
    <>
      <WarnBanner
        text="The 5-byte hex CodeCard tokens below are NOT confirmed cryptographic keys — they may be expected-response patterns, sample CodeCards baked in for testing, or key-derivation inputs. Do not use as active crypto material without independent bench verification."
      />
      <ProvenanceBanner
        text={`Source: ${SEND_CODE_CARD_LOGIN_METHOD.method} (salt=${SEND_CODE_CARD_LOGIN_METHOD.salt}) decrypted IL strings + registry analysis from Method[2526].`}
      />

      {/* Credential storage */}
      <div style={intelCard}>
        <div style={intelCardTitle}>Credential Storage Location</div>
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.ts, marginBottom: 6 }}>
          {ALFAOBD_CREDENTIAL_STORAGE.source}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Mono>{ALFAOBD_CREDENTIAL_STORAGE.registry_root}</Mono>
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {ALFAOBD_CREDENTIAL_STORAGE.value_names.map(v => (
            <span key={v} style={{
              fontFamily: MONO, fontSize: 10,
              background: "#FFF8E1", borderRadius: 4,
              padding: "1px 6px", color: "#5D4037",
            }}>{v}</span>
          ))}
        </div>
      </div>

      {/* SendCodeCardLogin flow */}
      <div style={intelCard}>
        <div style={intelCardTitle}>SendCodeCardLogin UDS Flow</div>
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.ts, marginBottom: 6 }}>
          CAN buses: {SEND_CODE_CARD_LOGIN_METHOD.associated_can_buses.join(", ")}
        </div>
        {SEND_CODE_CARD_LOGIN_METHOD.uds_flow.map((step, i) => (
          <div key={i} style={{
            fontFamily: MONO, fontSize: 11,
            padding: "3px 0", borderBottom: i < SEND_CODE_CARD_LOGIN_METHOD.uds_flow.length - 1 ? "1px solid #EEE" : "none",
          }}>
            <span style={{ color: C.ts, marginRight: 8 }}>{i + 1}.</span>
            {step}
          </div>
        ))}
      </div>

      {/* Bench-pair harness — Task #828 */}
      <CodecardHarnessPanel />

      {/* Candidate CodeCard keys — collapsed by default */}
      <div style={intelCard}>
        <button
          onClick={() => setShowCodecard(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontFamily: SANS, fontSize: 12, fontWeight: 700,
            color: "#BF360C", display: "flex", alignItems: "center", gap: 6, padding: 0,
          }}
        >
          <span>{showCodecard ? "▼" : "▶"}</span>
          Candidate CodeCard Tokens
          <span style={{
            fontFamily: MONO, fontSize: 10, background: "#FFEBEE",
            borderRadius: 99, padding: "1px 8px", color: "#B71C1C",
          }}>UNVERIFIED</span>
        </button>
        {showCodecard && (
          <div style={{ marginTop: 10 }}>
            <WarnBanner text="These hex strings appear near SA frames in the IL but are NOT confirmed to be valid CodeCard keys. Verify against a real ECU bench before treating as cryptographic material." />
            {SEND_CODE_CARD_LOGIN_METHOD.candidate_codecard_keys_5byte.map((k, i) => (
              <div key={i} style={{ ...intelCard, marginBottom: 6, background: "#FFF8F8" }}>
                <Mono>{k.hex}</Mono>
                <span style={{ fontFamily: SANS, fontSize: 10, color: C.ts, marginLeft: 8 }}>
                  paired with frame <Mono dim>{k.appears_with_frame}</Mono>
                </span>
                <div style={{ fontFamily: SANS, fontSize: 10, color: "#BF360C", marginTop: 4 }}>
                  {k.interpretation_caveat}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KWP / CAN / Adapters */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          {
            title: "Legacy KWP2000 ECUs",
            items: KWP2000_DOOR_MODULES.ecus,
            note: KWP2000_DOOR_MODULES.protocol,
            color: "#37474F",
          },
          {
            title: "CAN Bus Protocols",
            items: ALFAOBD_CAN_PROTOCOL_NAMES,
            note: "Recognized protocol strings in IL",
            color: "#1565C0",
          },
          {
            title: "OBD Adapter Chipsets",
            items: OBD_ADAPTER_DETECTION,
            note: "Auto-detected by AlfaOBD",
            color: "#2E7D32",
          },
        ].map(({ title, items, note, color }) => (
          <div key={title} style={intelCard}>
            <div style={{ ...intelCardTitle, color }}>{title}</div>
            <div style={{ fontFamily: SANS, fontSize: 10, color: C.ts, marginBottom: 5 }}>{note}</div>
            {items.map(item => (
              <div key={item} style={{
                fontFamily: MONO, fontSize: 10,
                padding: "2px 0", color: C.bk,
              }}>{item}</div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

const intelCard = {
  background: "#FAFAF8", border: "1px solid #E8E4DE",
  borderRadius: 8, padding: "10px 12px", marginBottom: 10,
};
const intelCardTitle = {
  fontFamily: SANS, fontWeight: 800, fontSize: 11,
  color: C.bk, letterSpacing: 0.5, marginBottom: 6,
};

/* ── Dispatch Coverage sub-panel (lives in Section 6 — DB Schema) ─────── */
function DispatchCoveragePanel() {
  const [q, setQ] = useState("");
  const [openEcu, setOpenEcu] = useState(null);
  const { aggregate, perEcu, meta } = DISPATCH_GAP_REPORT;

  const filtered = useMemo(() => {
    if (!q.trim()) return perEcu;
    const lq = q.toLowerCase();
    return perEcu.filter(
      (e) =>
        e.ecu.toLowerCase().includes(lq) ||
        e.orphans.some(
          (o) =>
            o.rid.includes(lq) ||
            (o.ecuName || "").toLowerCase().includes(lq) ||
            (o.platform || "").toLowerCase().includes(lq),
        ),
    );
  }, [q, perEcu]);

  const aggGrid = "1fr 1fr 1fr 1fr 1fr";
  const aggCell = (label, value, color) => (
    <div style={{
      background: "#FAFAF8", border: "1px solid #E8E4DE",
      borderRadius: 8, padding: "8px 10px",
    }}>
      <div style={{
        fontFamily: SANS, fontSize: 9, fontWeight: 800,
        color: C.ts, letterSpacing: 1, textTransform: "uppercase",
      }}>{label}</div>
      <div style={{
        fontFamily: MONO, fontSize: 18, fontWeight: 700,
        color: color || C.bk, marginTop: 2,
      }}>{value}</div>
    </div>
  );

  return (
    <div style={{
      border: "1px solid #E8E4DE", borderRadius: 10,
      padding: "12px 14px", marginBottom: 12, background: "#FFF",
    }}>
      <div style={{
        fontFamily: SANS, fontWeight: 900, fontSize: 12,
        color: C.tm, letterSpacing: 1.6, textTransform: "uppercase",
        marginBottom: 8,
      }}>📈 Dispatch Coverage (Task #829)</div>

      <ProvenanceBanner
        text={`Static-analysis audit over routine catalog + UDS frame catalog + ${meta.upstreamDispatchMatchedCount} resolved dispatch records. Re-run: pnpm -F @workspace/scripts run audit:dispatch-gap. ${meta.heuristicNote}`}
      />

      <div style={{
        display: "grid", gridTemplateColumns: aggGrid,
        gap: 8, marginBottom: 10,
      }}>
        {aggCell("Routines total", aggregate.routinesTotal.toLocaleString())}
        {aggCell("With frame", aggregate.routinesWithFrame.toLocaleString(), "#2E7D32")}
        {aggCell("Orphan", aggregate.routinesOrphan.toLocaleString(), "#BF360C")}
        {aggCell("Coverage", aggregate.coveragePercent + "%", "#1565C0")}
        {aggCell("Frames unattributed", aggregate.framesUnattributed.toLocaleString(), "#6A1B9A")}
      </div>

      <SearchBox value={q} onChange={setQ} placeholder="Search ECU family, routine ID, ECU name, platform…" />

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {filtered.map((row) => {
          const isOpen = openEcu === row.ecu;
          const orphanPct = row.routinesTotal
            ? Math.round((row.routinesOrphan / row.routinesTotal) * 100)
            : 0;
          return (
            <div key={row.ecu} style={{
              border: "1px solid #E8E4DE", borderRadius: 8, overflow: "hidden",
            }}>
              <button
                onClick={() => setOpenEcu(isOpen ? null : row.ecu)}
                style={{
                  width: "100%", background: isOpen ? "#F0EDE8" : "#FAFAF8",
                  border: "none", cursor: "pointer", padding: "7px 12px",
                  display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                }}
              >
                <span style={{
                  fontFamily: MONO, fontSize: 11, fontWeight: 700,
                  color: "#1565C0", minWidth: 200,
                }}>{row.ecu}</span>
                <span style={{
                  fontFamily: MONO, fontSize: 10,
                  background: "#FFEBEE", borderRadius: 99,
                  padding: "1px 7px", color: "#BF360C",
                }}>{row.routinesOrphan} orphan</span>
                <span style={{
                  fontFamily: MONO, fontSize: 10,
                  background: "#E8F5E9", borderRadius: 99,
                  padding: "1px 7px", color: "#2E7D32",
                }}>{row.routinesWithFrame} matched</span>
                <span style={{ fontFamily: SANS, fontSize: 10, color: C.ts }}>
                  {row.routinesTotal} total · {orphanPct}% gap · {row.framesAttributed} frames
                </span>
                <span style={{ marginLeft: "auto", color: C.ts, fontSize: 12 }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </button>
              {isOpen && (
                <div style={{ padding: "8px 12px 12px", background: "#FFF" }}>
                  {row.orphans.length === 0 ? (
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.ts }}>
                      No orphan routines — every routine on this ECU has at least one statically-resolved frame match.
                    </div>
                  ) : (
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 10 }}>
                      <thead>
                        <tr style={{
                          fontFamily: SANS, fontWeight: 800, color: C.ts,
                          textTransform: "uppercase", letterSpacing: 0.8,
                        }}>
                          <th style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #EEE" }}>RID</th>
                          <th style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #EEE" }}>ECU name</th>
                          <th style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #EEE" }}>Platform</th>
                          <th style={{ textAlign: "left", padding: "3px 0", borderBottom: "1px solid #EEE" }}>Heuristic candidate frame(s)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.orphans.map((o) => (
                          <tr key={o.rid} style={{ borderBottom: "1px solid #F5F5F5" }}>
                            <td style={{ padding: "4px 8px 4px 0", fontFamily: MONO, verticalAlign: "top" }}>{o.rid}</td>
                            <td style={{ padding: "4px 8px 4px 0", fontFamily: SANS, verticalAlign: "top" }}>{o.ecuName || "—"}</td>
                            <td style={{ padding: "4px 8px 4px 0", fontFamily: SANS, color: C.ts, verticalAlign: "top" }}>{o.platform || "—"}</td>
                            <td style={{ padding: "4px 0", verticalAlign: "top" }}>
                              {o.candidates.length === 0 ? (
                                <span style={{ fontFamily: SANS, fontSize: 10, color: C.ts, fontStyle: "italic" }}>
                                  no static candidate — bench capture required
                                </span>
                              ) : (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {o.candidates.map((c) => (
                                    <span key={c.frameHex} title={c.rationale} style={{
                                      fontFamily: MONO, fontSize: 10,
                                      background: "#FFF3E0", borderRadius: 4,
                                      padding: "1px 6px", color: "#BF360C",
                                      border: "1px dashed #FFAB40",
                                    }}>
                                      {c.frameHex} <span style={{ fontFamily: SANS, fontSize: 9, marginLeft: 3 }}>heuristic</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.ts, padding: "8px 0" }}>
            No ECU buckets match.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Section 6: DB Schema ──────────────────────────────────────────────── */
function DbSchemaSection() {
  const [expanded, setExpanded] = useState(null);
  const tableNames = Object.keys(ALFAOBD_DB_TABLES);

  return (
    <>
      <ProvenanceBanner
        text={`Source: AlfaOBD SQLite catalog DB — ${(ALFAOBD_DB_META.fileSize / 1024 / 1024).toFixed(1)} MB, ${ALFAOBD_DB_META.totalPages.toLocaleString()} × ${ALFAOBD_DB_META.pageSize}-byte pages, encrypted with 1024-byte XOR key (alfaobdDbXorKey.js). ${tableNames.length} tables documented.`}
      />

      <DispatchCoveragePanel />

      {/* Dispatch gap alert */}
      <div style={{
        background: "#FBE9E7", border: "1px solid #FFAB91",
        borderRadius: 8, padding: "10px 14px", marginBottom: 12,
        fontFamily: SANS, fontSize: 11,
      }}>
        <div style={{ fontWeight: 800, color: "#BF360C", marginBottom: 4 }}>
          Dispatch Table Gap
        </div>
        <div style={{ color: "#5D4037", lineHeight: 1.6 }}>
          {ALFAOBD_DB_DISPATCH_GAP.dispatchTableExtractedNote}
        </div>
        <div style={{ marginTop: 8, fontWeight: 700, color: "#BF360C" }}>Path forward:</div>
        <ul style={{ margin: "4px 0 0 16px", padding: 0, color: "#5D4037" }}>
          {ALFAOBD_DB_DISPATCH_GAP.pathForward.map((s, i) => (
            <li key={i} style={{ marginBottom: 2 }}>{s}</li>
          ))}
        </ul>
      </div>

      {/* Table list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {tableNames.map(name => {
          const tbl = ALFAOBD_DB_TABLES[name];
          const isOpen = expanded === name;
          return (
            <div key={name} style={{
              border: "1px solid #E8E4DE", borderRadius: 8,
              overflow: "hidden",
            }}>
              <button
                onClick={() => setExpanded(isOpen ? null : name)}
                style={{
                  width: "100%", background: isOpen ? "#F0EDE8" : "#FAFAF8",
                  border: "none", cursor: "pointer",
                  padding: "8px 14px",
                  display: "flex", alignItems: "center", gap: 10,
                  textAlign: "left",
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: "#1565C0", minWidth: 170 }}>
                  {name}
                </span>
                {tbl.rowCountEstimate && (
                  <span style={{
                    fontFamily: MONO, fontSize: 10,
                    background: "#E3F2FD", borderRadius: 99,
                    padding: "1px 7px", color: "#1565C0", flexShrink: 0,
                  }}>~{tbl.rowCountEstimate.toLocaleString()} rows</span>
                )}
                {tbl.extractionStatus && (
                  <span style={{
                    fontFamily: SANS, fontSize: 10, color: C.ts,
                  }}>{tbl.extractionStatus}</span>
                )}
                <span style={{ marginLeft: "auto", color: C.ts, fontSize: 12 }}>
                  {isOpen ? "▲" : "▼"}
                </span>
              </button>
              {isOpen && (
                <div style={{ padding: "8px 14px 12px", background: "#FFF" }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.ts, marginBottom: 6 }}>
                    {tbl.purpose || "—"}
                  </div>
                  {tbl.columns && (
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 10 }}>
                      <thead>
                        <tr style={{ fontFamily: SANS, fontWeight: 800, color: C.ts, textTransform: "uppercase", letterSpacing: 0.8 }}>
                          <th style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #EEE" }}>Column</th>
                          <th style={{ textAlign: "left", padding: "3px 8px 3px 0", borderBottom: "1px solid #EEE" }}>Type</th>
                          <th style={{ textAlign: "left", padding: "3px 0", borderBottom: "1px solid #EEE" }}>Role</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tbl.columns.map(col => (
                          <tr key={col.name}>
                            <td style={{ padding: "3px 8px 3px 0", fontFamily: MONO }}>{col.name}</td>
                            <td style={{ padding: "3px 8px 3px 0", fontFamily: MONO, color: "#6A1B9A" }}>{col.type}</td>
                            <td style={{ padding: "3px 0", fontFamily: SANS, color: C.ts }}>{col.role || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── Sidebar navigation ────────────────────────────────────────────────── */
const SECTIONS = [
  { id: "frames",   icon: "📡", label: "UDS Frames",       count: UDS_DISPATCH_META?.frames_unique },
  { id: "routines", icon: "📋", label: "Routine Catalog",  count: ROUTINE_CATALOG_META?.totalRoutines },
  { id: "dispatch", icon: "🔀", label: "Frame→Routine",    count: DISPATCH_TO_ROUTINE_META?.unambiguous_matches },
  { id: "ecucan",   icon: "🔌", label: "ECU→CAN",          count: ECU_TO_CAN_META?.unique_pairings },
  { id: "security", icon: "🔐", label: "Security Intel",   count: null },
  { id: "schema",   icon: "🗄️", label: "DB Schema",        count: Object.keys(ALFAOBD_DB_TABLES).length },
];

/* ── Root component ────────────────────────────────────────────────────── */
export default function AlfaObdIntelTab() {
  const [section, setSection] = useState("frames");

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* sidebar */}
      <div style={{
        width: 170, flexShrink: 0,
        borderRight: "1px solid #E8E4DE",
        overflowY: "auto",
        background: "#F8F5F0",
        paddingTop: 12,
      }}>
        <div style={{
          fontFamily: SANS, fontWeight: 900, fontSize: 9,
          color: C.ts, letterSpacing: 2, textTransform: "uppercase",
          padding: "0 14px 8px",
        }}>
          AlfaOBD Intel
        </div>
        {SECTIONS.map(s => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                display: "flex", flexDirection: "column",
                width: "100%", textAlign: "left",
                border: "none", borderRadius: 0,
                background: active ? "#EDE9E2" : "transparent",
                borderLeft: active ? `3px solid ${C.rd}` : "3px solid transparent",
                padding: "8px 14px",
                cursor: "pointer",
              }}
            >
              <div style={{
                fontFamily: SANS, fontWeight: active ? 800 : 600,
                fontSize: 11, color: active ? C.bk : C.ts,
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <span style={{ fontSize: 13 }}>{s.icon}</span>
                {s.label}
              </div>
              {s.count !== null && s.count !== undefined && (
                <div style={{
                  fontFamily: MONO, fontSize: 9,
                  color: active ? C.rd : C.ts,
                  marginTop: 1, paddingLeft: 18,
                }}>
                  {s.count.toLocaleString()}
                </div>
              )}
            </button>
          );
        })}

        <div style={{
          margin: "16px 14px 0",
          padding: "8px 0",
          borderTop: "1px solid #E0DCD4",
          fontFamily: SANS, fontSize: 9,
          color: C.ts, lineHeight: 1.5,
        }}>
          All data extracted from AlfaOBD.exe v2.5.7.0 IL.
          Strictly read-only.
        </div>
      </div>

      {/* main content */}
      <div style={{
        flex: 1, overflowY: "auto",
        padding: "18px 20px",
      }}>
        {/* master provenance warning */}
        <div style={{
          background: "#FFEBEE", border: "1px solid #EF9A9A",
          borderRadius: 8, padding: "8px 14px", marginBottom: 16,
          fontFamily: SANS, fontSize: 11, color: "#B71C1C",
          display: "flex", gap: 8,
        }}>
          <span style={{ fontSize: 14, flexShrink: 0 }}>&#9888;</span>
          <span>
            <strong>Third-party reverse-engineering data.</strong> All content is derived
            from static IL analysis of AlfaOBD.exe. Interpretation may be incomplete or
            incorrect. No data in this tab is used to send frames to a vehicle — this is a
            read-only reference catalog.
          </span>
        </div>

        {section === "frames" && (
          <>
            <SectionHead
              icon="📡"
              title="UDS Frame Dictionary"
              count={UDS_DISPATCH_META?.frames_unique}
              subtitle="All unique UDS/KWP frames emitted by AlfaOBD.exe, grouped by IL method origin"
            />
            <SidBreakdown />
            <UdsFrameSection />
          </>
        )}

        {section === "routines" && (
          <>
            <SectionHead
              icon="📋"
              title="Routine Catalog"
              count={ROUTINE_CATALOG_META?.totalRoutines}
              subtitle="AlfaOBD diagnostic procedure catalog — ECU code, friendly name, vehicle platform"
            />
            <RoutineCatalogSection />
          </>
        )}

        {section === "dispatch" && (
          <>
            <SectionHead
              icon="🔀"
              title="Frame → Routine Map"
              count={DISPATCH_TO_ROUTINE_META?.unambiguous_matches}
              subtitle={`${DISPATCH_TO_ROUTINE_META?.matched_dispatch_count} total matches; ${DISPATCH_TO_ROUTINE_META?.unambiguous_matches} unambiguous; ${DISPATCH_TO_ROUTINE_META?.tier1_hits} Tier-1 hits`}
            />
            <FrameRoutineSection />
          </>
        )}

        {section === "ecucan" && (
          <>
            <SectionHead
              icon="🔌"
              title="ECU → CAN Pairings"
              count={ECU_TO_CAN_META?.unique_pairings}
              subtitle="ECU or platform name → associated CAN-ID(s) extracted from AlfaOBD.exe dictionary-add IL sequences"
            />
            <EcuCanSection />
          </>
        )}

        {section === "security" && (
          <>
            <SectionHead
              icon="🔐"
              title="Security Intel"
              subtitle="Credential storage, CodeCard login flow, CAN protocols, OBD adapters — all from static IL analysis"
            />
            <SecurityIntelSection />
          </>
        )}

        {section === "schema" && (
          <>
            <SectionHead
              icon="🗄️"
              title="DB Schema"
              count={Object.keys(ALFAOBD_DB_TABLES).length}
              subtitle={`AlfaOBD SQLite catalog DB — ${(ALFAOBD_DB_META.fileSize / 1024 / 1024).toFixed(1)} MB encrypted with 1024-byte XOR key`}
            />
            <DbSchemaSection />
          </>
        )}
      </div>
    </div>
  );
}
