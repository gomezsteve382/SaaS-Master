/* AlfaOBD Tables — read-only browser for the JSON the
 * `tools/alfaobd-extractor/` pipeline emits.
 *
 * Loads `${BASE_URL}alfaobd-tables/manifest.json` at runtime. When that
 * file is absent (no extraction has been run on this machine), the tab
 * shows an explicit empty state pointing the tech at the command —
 * never any silent placeholder data.
 */
import React, { useEffect, useMemo, useState } from "react";

const BASE = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
const TABLES_BASE = BASE.replace(/\/$/, "") + "/alfaobd-tables";

const STATE = { LOADING: "loading", EMPTY: "empty", READY: "ready", ERROR: "error" };

export default function AlfaObdTablesTab() {
  const [state, setState] = useState(STATE.LOADING);
  const [error, setError] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [families, setFamilies] = useState([]); // [{family, modules:[]}, ...]
  const [handlers, setHandlers] = useState([]);
  const [transports, setTransports] = useState([]);
  const [resources, setResources] = useState(null);

  const [activeFamily, setActiveFamily] = useState(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("ecutypes"); // "ecutypes" | "handlers" | "transports" | "resources"

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState(STATE.LOADING);
      setError(null);
      try {
        const mr = await fetch(`${TABLES_BASE}/manifest.json`, { cache: "no-cache" });
        // The dev server serves the SPA index.html for any path it cannot
        // resolve (HTTP 200, Content-Type: text/html). Treat both that
        // case and a real 404 as "extraction has not been run".
        const ctype = (mr.headers.get("content-type") || "").toLowerCase();
        const looksHtml = ctype.includes("text/html");
        if (mr.status === 404 || (mr.ok && looksHtml)) {
          if (!cancelled) setState(STATE.EMPTY);
          return;
        }
        if (!mr.ok) throw new Error(`manifest.json HTTP ${mr.status}`);
        let m;
        try { m = await mr.json(); }
        catch { if (!cancelled) setState(STATE.EMPTY); return; }
        if (!m || !m.schema_version) {
          throw new Error("manifest.json missing schema_version");
        }

        // Load each ECUTYPE family file listed in manifest.outputs.files
        const familyEntries = (m.outputs?.files || [])
          .filter(f => f.path.startsWith("ecutypes/") && f.path.endsWith(".json"));
        const fams = [];
        for (const f of familyEntries) {
          const r = await fetch(`${TABLES_BASE}/${f.path}`, { cache: "no-cache" });
          if (!r.ok) continue;
          const j = await r.json();
          if (j && j.family) fams.push(j);
        }
        fams.sort((a, b) => a.family.localeCompare(b.family));

        const [hr, tr, rr] = await Promise.all([
          fetch(`${TABLES_BASE}/handlers.json`,   { cache: "no-cache" }),
          fetch(`${TABLES_BASE}/transports.json`, { cache: "no-cache" }),
          fetch(`${TABLES_BASE}/resources.json`,  { cache: "no-cache" }),
        ]);
        const handlersJson    = hr.ok ? await hr.json() : { handlers: [] };
        const transportsJson  = tr.ok ? await tr.json() : { transports: [] };
        const resourcesJson   = rr.ok ? await rr.json() : null;

        if (cancelled) return;
        setManifest(m);
        setFamilies(fams);
        setHandlers(handlersJson.handlers || []);
        setTransports(transportsJson.transports || []);
        setResources(resourcesJson);
        setActiveFamily(fams[0]?.family || null);
        setState(STATE.READY);
      } catch (e) {
        if (cancelled) return;
        setError(e.message || String(e));
        setState(STATE.ERROR);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (state === STATE.LOADING) {
    return (
      <Section data-testid="alfaobd-tables-loading">
        <div style={{ color: "#888" }}>Loading AlfaOBD tables…</div>
      </Section>
    );
  }

  if (state === STATE.ERROR) {
    return (
      <Section data-testid="alfaobd-tables-error">
        <div style={{ color: "#FF6D00", fontWeight: 700 }}>
          Failed to load AlfaOBD tables: {error}
        </div>
        <p style={{ color: "#888", marginTop: 12 }}>
          Try re-running the extractor:{" "}
          <code style={CODE_STYLE}>node tools/alfaobd-extractor/extract.mjs</code>
        </p>
      </Section>
    );
  }

  if (state === STATE.EMPTY) {
    return (
      <Section data-testid="alfaobd-tables-empty">
        <h2 style={H2}>AlfaOBD Tables</h2>
        <div style={EMPTY_CARD}>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 12 }}>
            No extracted data on this machine yet.
          </div>
          <p style={{ color: "#aaa", lineHeight: 1.6, marginBottom: 16 }}>
            This view shows the <code style={CODE_STYLE}>ECUTYPE_*</code> families,
            the <code style={CODE_STYLE}>Process*Data</code> handlers, the supported
            transports, and the resource bundles that live inside an
            <em> AlfaOBD.exe </em>build. Nothing is shown until the
            extraction pipeline has been run on a real binary — we do not
            ship invented data.
          </p>
          <ol style={{ color: "#ddd", lineHeight: 1.8, marginLeft: 18 }}>
            <li>Drop the binary at{" "}
              <code style={CODE_STYLE}>attached_assets/AlfaOBD.exe</code></li>
            <li>(Optional) drop{" "}
              <code style={CODE_STYLE}>attached_assets/shfolder(1).dll</code> for fingerprinting</li>
            <li>Install the .NET decompiler once:{" "}
              <code style={CODE_STYLE}>dotnet tool install -g ilspycmd</code></li>
            <li>Run:{" "}
              <code style={CODE_STYLE}>node tools/alfaobd-extractor/extract.mjs</code></li>
            <li>Reload this tab.</li>
          </ol>
          <p style={{ color: "#777", marginTop: 16, fontSize: 12 }}>
            Full walkthrough:{" "}
            <code style={CODE_STYLE}>tools/alfaobd-extractor/README.md</code>
          </p>
        </div>
      </Section>
    );
  }

  // READY ----------
  const activeFam = families.find(f => f.family === activeFamily);

  return (
    <Section data-testid="alfaobd-tables-ready">
      <Header manifest={manifest} />
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <ViewBtn id="ecutypes"   active={view} onClick={setView}>
          ECUTYPE families ({families.length})
        </ViewBtn>
        <ViewBtn id="handlers"   active={view} onClick={setView}>
          Handlers ({handlers.length})
        </ViewBtn>
        <ViewBtn id="transports" active={view} onClick={setView}>
          Transports ({transports.length})
        </ViewBtn>
        <ViewBtn id="resources"  active={view} onClick={setView}>
          Resources ({resources?.bundles?.length || 0})
        </ViewBtn>
      </div>

      {view === "ecutypes" && (
        <EcutypesView
          families={families}
          activeFamily={activeFamily}
          setActiveFamily={setActiveFamily}
          search={search}
          setSearch={setSearch}
          activeFam={activeFam}
        />
      )}
      {view === "handlers"   && <HandlersView handlers={handlers} />}
      {view === "transports" && <TransportsView transports={transports} />}
      {view === "resources"  && <ResourcesView resources={resources} />}
    </Section>
  );
}

/* ── Subviews ─────────────────────────────────────────────────────── */
function Header({ manifest }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h2 style={H2}>AlfaOBD Tables</h2>
      <div style={{ color: "#888", fontSize: 12 }}>
        AlfaOBD <strong>{manifest.alfaobd?.file_version}</strong> — extracted{" "}
        {fmtDate(manifest.generated_at)} — sha256{" "}
        <code style={CODE_STYLE}>{shortHash(manifest.alfaobd?.sha256)}</code>
      </div>
      {manifest.shfolder?.protected_skip && (
        <div style={{ color: "#aaa", fontSize: 11, marginTop: 4 }}>
          shfolder: {manifest.shfolder.protector} — fingerprint only{" "}
          (<code style={CODE_STYLE}>protected_skip: true</code>)
        </div>
      )}
    </div>
  );
}

function EcutypesView({ families, activeFamily, setActiveFamily, search, setSearch, activeFam }) {
  const filteredModules = useMemoFilter(activeFam?.modules || [], search);
  if (!families.length) {
    return <div style={{ color: "#888" }}>No ECUTYPE_* families discovered.</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
      <aside style={{ background: "#0F0F0F", border: "1px solid #2A2A2A", borderRadius: 10, padding: 8, maxHeight: 600, overflowY: "auto" }}>
        {families.map(f => (
          <button
            key={f.family}
            data-testid={`alfaobd-family-${f.family}`}
            onClick={() => setActiveFamily(f.family)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
              background: f.family === activeFamily ? "#FF6D0033" : "transparent",
              color: f.family === activeFamily ? "#FF6D00" : "#ddd",
              border: "1px solid " + (f.family === activeFamily ? "#FF6D00" : "transparent"),
              fontFamily: "JetBrains Mono, monospace", fontSize: 11, cursor: "pointer",
            }}>
            {f.family} <span style={{ color: "#666", marginLeft: 6 }}>({f.modules.length})</span>
          </button>
        ))}
      </aside>
      <div>
        <input
          data-testid="alfaobd-module-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search modules in this family (name, id, address)…"
          style={INPUT_STYLE}
        />
        {!activeFam ? (
          <div style={{ color: "#888", marginTop: 12 }}>Select a family to inspect.</div>
        ) : (
          <ModulesTable family={activeFam} rows={filteredModules} />
        )}
      </div>
    </div>
  );
}

function ModulesTable({ family, rows }) {
  if (!rows.length) {
    return <div style={{ color: "#888", marginTop: 12 }}>No modules match your search in {family.family}.</div>;
  }
  return (
    <table style={TABLE} data-testid={`alfaobd-modules-${family.family}`}>
      <thead>
        <tr>
          <th style={TH}>ECU type id</th>
          <th style={TH}>Name</th>
          <th style={TH}>Display name</th>
          <th style={TH}>Protocols</th>
          <th style={TH}>TX → RX</th>
          <th style={TH}>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(m => (
          <tr key={`${m.ecu_type_id}-${m.name}`}>
            <td style={TD_MONO}>{m.ecu_type_id}</td>
            <td style={TD_MONO}>{m.name}</td>
            <td style={TD}>{m.display_name || ""}</td>
            <td style={TD}>{(m.protocols || []).join(", ")}</td>
            <td style={TD_MONO}>{m.tx_address && m.rx_address ? `${m.tx_address} → ${m.rx_address}` : ""}</td>
            <td style={{ ...TD_MONO, color: "#666" }}>{m.source || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HandlersView({ handlers }) {
  if (!handlers.length) {
    return <div style={{ color: "#888" }}>No Process*Data handlers discovered.</div>;
  }
  return (
    <table style={TABLE} data-testid="alfaobd-handlers-table">
      <thead>
        <tr>
          <th style={TH}>Handler</th>
          <th style={TH}>Declaring type</th>
          <th style={TH}>UDS services</th>
          <th style={TH}># calls</th>
          <th style={TH}>Source</th>
        </tr>
      </thead>
      <tbody>
        {handlers.map(h => (
          <tr key={`${h.name}-${h.source}`}>
            <td style={TD_MONO}>{h.name}</td>
            <td style={TD_MONO}>{h.declaring_type || ""}</td>
            <td style={TD_MONO}>{(h.uds_services || []).join(" ")}</td>
            <td style={TD_MONO}>{(h.calls || []).length}</td>
            <td style={{ ...TD_MONO, color: "#666" }}>{h.source || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TransportsView({ transports }) {
  if (!transports.length) {
    return <div style={{ color: "#888" }}>No transport types discovered.</div>;
  }
  return (
    <table style={TABLE} data-testid="alfaobd-transports-table">
      <thead>
        <tr>
          <th style={TH}>Kind</th>
          <th style={TH}>Version</th>
          <th style={TH}>Types</th>
        </tr>
      </thead>
      <tbody>
        {transports.map(t => (
          <tr key={t.kind}>
            <td style={TD_MONO}>{t.kind}</td>
            <td style={TD_MONO}>{t.version || ""}</td>
            <td style={TD_MONO}>{(t.types || []).join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResourcesView({ resources }) {
  if (!resources) return <div style={{ color: "#888" }}>No resources extracted.</div>;
  const bundles = resources.bundles || [];
  const media = resources.media || [];
  return (
    <div data-testid="alfaobd-resources" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <h3 style={H3}>Resource bundles ({bundles.length})</h3>
        <ul style={LIST}>
          {bundles.map(b => (
            <li key={b.name} style={LI_MONO}>
              {b.name}{b.entry_count != null && <span style={{ color: "#666" }}> · {b.entry_count} entries</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 style={H3}>Embedded media ({media.length})</h3>
        <ul style={LIST}>
          {media.map(m => (
            <li key={m.file} style={LI_MONO}>
              <code style={CODE_STYLE}>{m.file}</code>{" "}
              <span style={{ color: "#666" }}>· {m.mime} · {fmtBytes(m.size_bytes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function useMemoFilter(rows, q) {
  return useMemo(() => {
    if (!q) return rows;
    const t = q.toLowerCase();
    return rows.filter(r =>
      (r.name || "").toLowerCase().includes(t) ||
      (r.display_name || "").toLowerCase().includes(t) ||
      (r.ecu_type_id || "").toLowerCase().includes(t) ||
      (r.tx_address || "").toLowerCase().includes(t) ||
      (r.rx_address || "").toLowerCase().includes(t)
    );
  }, [rows, q]);
}

function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch { return s || ""; } }
function fmtBytes(n) {
  if (n == null) return "";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
function shortHash(h) { return h ? `${h.slice(0, 8)}…${h.slice(-4)}` : ""; }

/* ── Styles (kept inline to match the existing tabs in this app) ── */
function Section({ children, ...rest }) {
  return <div style={{ padding: 4 }} {...rest}>{children}</div>;
}
const H2 = { fontFamily: "'Righteous', sans-serif", fontSize: 22, color: "#fff", marginBottom: 6 };
const H3 = { fontFamily: "'Nunito', sans-serif", fontSize: 14, fontWeight: 800, color: "#ddd", marginBottom: 8 };
const TABLE = { width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 12, background: "#0F0F0F", border: "1px solid #2A2A2A", borderRadius: 8, overflow: "hidden" };
const TH = { textAlign: "left", padding: "10px 12px", background: "#1A1A1A", color: "#888", fontWeight: 700, fontSize: 11, letterSpacing: 1, borderBottom: "1px solid #2A2A2A" };
const TD = { padding: "8px 12px", borderTop: "1px solid #1A1A1A", color: "#ddd" };
const TD_MONO = { ...TD, fontFamily: "JetBrains Mono, monospace" };
const INPUT_STYLE = { width: "100%", padding: "10px 12px", background: "#0F0F0F", border: "1px solid #2A2A2A", borderRadius: 8, color: "#fff", fontFamily: "JetBrains Mono, monospace", fontSize: 12, marginBottom: 10 };
const CODE_STYLE = { background: "#1A1A1A", padding: "1px 6px", borderRadius: 4, fontFamily: "JetBrains Mono, monospace", color: "#FF6D00" };
const EMPTY_CARD = { background: "#0F0F0F", border: "1px solid #2A2A2A", borderRadius: 12, padding: 24, marginTop: 12 };
const LIST = { listStyle: "none", padding: 0, margin: 0, maxHeight: 400, overflowY: "auto" };
const LI_MONO = { fontFamily: "JetBrains Mono, monospace", fontSize: 11, padding: "4px 0", borderBottom: "1px solid #1A1A1A", color: "#ddd" };

function ViewBtn({ id, active, onClick, children }) {
  const a = active === id;
  return (
    <button
      data-testid={`alfaobd-view-${id}`}
      onClick={() => onClick(id)}
      style={{
        padding: "8px 14px", borderRadius: 8, cursor: "pointer",
        background: a ? "#FF6D0022" : "#0F0F0F",
        color: a ? "#FF6D00" : "#aaa",
        border: "1px solid " + (a ? "#FF6D00" : "#2A2A2A"),
        fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 11, letterSpacing: 1,
      }}>
      {children}
    </button>
  );
}
