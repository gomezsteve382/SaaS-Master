/* CanUniverseTab — read-only browser for the aggregated CAN bus / OSS
 * automotive catalog (Task #618). Sources are merged, deduped by URL,
 * and rendered with a category sidebar, search box, source + tag filter
 * chips, and a per-entry star button. Stars persist in localStorage
 * under `srtlab.canUniverse.shortlist.v1`; the Shortlist toggle filters
 * to starred entries only and an "Export shortlist (JSON)" button
 * downloads `{ generatedAt, source, entries[] }` for follow-up planning.
 *
 * NO write semantics. This is purely a discovery / triage surface.
 * Integration of any individual tool is a separate, per-entry follow-up. */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { C } from "../lib/constants.js";
import { Card, Tag, Btn } from "../lib/ui.jsx";
import {
  CATALOG_ENTRIES,
  CATALOG_CATEGORIES,
  CATALOG_SOURCES,
  CATALOG_GENERATED_AT,
} from "../lib/awesomeCanbus.generated.js";

const STAR_KEY = "srtlab.canUniverse.shortlist.v1";

/* Curated map: which awesome-canbus category plugs into which existing
 * SRT Lab tab. Pure copy — no behaviour. */
const INTEGRATION_HINTS = [
  { kind: "USB-CAN / J2534 adapters", target: "J2534 Bridge · External Tools" },
  { kind: "OBD-II software & ELM327 stacks", target: "Live OBD tab" },
  { kind: "UDS libraries & ISO-TP stacks", target: "@workspace/uds + UDS Programmer" },
  { kind: "DBC / KCD parsers + log tools", target: "SWARM · Bench" },
  { kind: "Reverse-engineering frameworks", target: "Bench · Module Inspector" },
  { kind: "GUI analyzers (SavvyCAN, Cabana…)", target: "Reference for SWARM UI work" },
  { kind: "J1939 stacks", target: "Future heavy-duty truck workflow" },
];

/* ── localStorage helpers ────────────────────────────────────────────── */
function loadStars() {
  try {
    const raw = localStorage.getItem(STAR_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveStars(set) {
  try { localStorage.setItem(STAR_KEY, JSON.stringify([...set])); } catch { /* ignore quota */ }
}

function downloadBlob(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── derived state ───────────────────────────────────────────────────── */
const ALL_TAGS = (() => {
  const t = new Set();
  for (const e of CATALOG_ENTRIES) for (const x of (e.tags || [])) t.add(x);
  return [...t].sort();
})();

const ALL_LICENSES = (() => {
  const t = new Set();
  for (const e of CATALOG_ENTRIES) if (e.license) t.add(e.license);
  return [...t].sort();
})();

const SOURCE_BY_ID = Object.fromEntries(CATALOG_SOURCES.map(s => [s.id, s]));

/* ── tab ─────────────────────────────────────────────────────────────── */
export default function CanUniverseTab() {
  const [stars, setStars] = useState(loadStars);
  const [search, setSearch] = useState("");
  // `activeCategory` is either "all", a category name, or "<cat>::<sub>".
  const [activeCategory, setActiveCategory] = useState("all");
  // Categories collapsed by default; clicking a category header toggles
  // open/closed AND selects it. Click a subcategory to drill in.
  const [openCats, setOpenCats] = useState(() => new Set());
  const [activeSources, setActiveSources] = useState(() => new Set(CATALOG_SOURCES.map(s => s.id)));
  // Task #622: small iDoka-vs-ajouatom facet. "all" = no extra filter;
  // "idoka" / "ajouatom" = entries listed by that fork ONLY; "both" =
  // entries listed in both feeds. Layered on top of the per-source chips
  // above so it acts purely as a filter.
  const [forkFacet, setForkFacet] = useState("all");
  const [activeTags, setActiveTags] = useState(() => new Set());
  const [activeLicenses, setActiveLicenses] = useState(() => new Set());
  const [shortlistOnly, setShortlistOnly] = useState(false);

  useEffect(() => { saveStars(stars); }, [stars]);

  const toggleStar = useCallback((id) => {
    setStars(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const toggleSource = useCallback((id) => {
    setActiveSources(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const toggleTag = useCallback((t) => {
    setActiveTags(prev => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t); else n.add(t);
      return n;
    });
  }, []);

  const toggleLicense = useCallback((l) => {
    setActiveLicenses(prev => {
      const n = new Set(prev);
      if (n.has(l)) n.delete(l); else n.add(l);
      return n;
    });
  }, []);

  const toggleCatOpen = useCallback((cat) => {
    setOpenCats(prev => {
      const n = new Set(prev);
      if (n.has(cat)) n.delete(cat); else n.add(cat);
      return n;
    });
  }, []);

  // Selecting a category from the tree both selects it AND opens it.
  const selectCategory = useCallback((key, openCat) => {
    setActiveCategory(key);
    if (openCat) setOpenCats(prev => new Set(prev).add(openCat));
  }, []);

  // activeCategory is "all" | "<cat>" | "<cat>::<sub>". Split it out
  // once so the per-entry filter loop stays cheap.
  const [selCat, selSub] = useMemo(() => {
    if (activeCategory === "all") return [null, null];
    const idx = activeCategory.indexOf("::");
    if (idx === -1) return [activeCategory, null];
    return [activeCategory.slice(0, idx), activeCategory.slice(idx + 2)];
  }, [activeCategory]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return CATALOG_ENTRIES.filter(e => {
      if (shortlistOnly && !stars.has(e.id)) return false;
      if (selCat && e.category !== selCat) return false;
      if (selSub) {
        const sub = e.subcategory || "(uncategorized)";
        if (sub !== selSub) return false;
      }
      const srcs = e.sources || [e.source];
      if (!srcs.some(s => activeSources.has(s))) return false;
      if (forkFacet !== "all") {
        const hasIdoka    = srcs.includes("awesome-canbus");
        const hasAjouatom = srcs.includes("ajouatom");
        if (forkFacet === "idoka"    && !(hasIdoka && !hasAjouatom)) return false;
        if (forkFacet === "ajouatom" && !(hasAjouatom && !hasIdoka)) return false;
        if (forkFacet === "both"     && !(hasIdoka &&  hasAjouatom)) return false;
      }
      if (activeLicenses.size > 0 && !activeLicenses.has(e.license)) return false;
      if (activeTags.size > 0) {
        const tg = new Set(e.tags || []);
        for (const want of activeTags) if (!tg.has(want)) return false;
      }
      if (q) {
        const hay = `${e.name} ${e.description} ${e.category} ${e.subcategory || ""} ${(e.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [search, selCat, selSub, activeSources, forkFacet, activeLicenses, activeTags, shortlistOnly, stars]);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const e of filtered) {
      const key = e.category;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(e);
    }
    return m;
  }, [filtered]);

  const exportShortlist = useCallback(() => {
    const entries = CATALOG_ENTRIES.filter(e => stars.has(e.id));
    const payload = {
      generatedAt: new Date().toISOString(),
      catalogGeneratedAt: CATALOG_GENERATED_AT,
      sources: CATALOG_SOURCES,
      count: entries.length,
      entries,
    };
    downloadBlob(`srt-lab-can-shortlist-${Date.now()}.json`, JSON.stringify(payload, null, 2));
  }, [stars]);

  return (
    <div>
      {/* Header banner */}
      <Card style={{ marginBottom: 16, background: "#E3F2FD", borderColor: "#1976D2" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24 }}>🌐</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: "#0D3C6E", letterSpacing: 0.5 }}>
              CAN UNIVERSE — READ-ONLY DISCOVERY CATALOG
            </div>
            <div style={{ fontSize: 12, color: "#0D3C6E", marginTop: 4, lineHeight: 1.6 }}>
              Aggregated index of {CATALOG_ENTRIES.length} CAN bus / automotive OSS projects pulled from{" "}
              {CATALOG_SOURCES.length} curated upstream lists. Star entries to build a Shortlist for
              follow-up integration tasks. Nothing here is downloaded, executed, or wired up
              automatically — every per-entry integration is a separate decision.
            </div>
          </div>
        </div>
      </Card>

      {/* Integration hints */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 12, color: C.tm, letterSpacing: 1.2, marginBottom: 10 }}>
          HOW THESE PLUG INTO SRT LAB
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
          {INTEGRATION_HINTS.map((h, i) => (
            <div key={i} style={{ fontSize: 11, color: C.ts, lineHeight: 1.5 }}>
              <span style={{ color: C.tx, fontWeight: 700 }}>{h.kind}</span>
              {" → "}
              <span style={{ color: C.a3, fontFamily: "monospace", fontSize: 10 }}>{h.target}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Search + actions row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`🔍 Search ${CATALOG_ENTRIES.length} entries (name, description, tags)…`}
          style={{
            flex: "1 1 280px", minWidth: 200, padding: "10px 14px",
            borderRadius: 10, border: `1.5px solid ${C.bd}`, fontSize: 12, fontFamily: "'Nunito'",
          }}
        />
        <Btn
          onClick={() => setShortlistOnly(s => !s)}
          color={shortlistOnly ? C.sr : C.tm}
          outline={!shortlistOnly}
        >
          {shortlistOnly ? `★ Shortlist (${stars.size})` : `☆ Shortlist (${stars.size})`}
        </Btn>
        <Btn onClick={exportShortlist} color={C.a3} outline disabled={stars.size === 0}>
          ⬇ Export shortlist (JSON)
        </Btn>
      </div>

      {/* iDoka vs ajouatom facet (Task #622) — orthogonal to the
          per-source toggles below; lets the user isolate fork-only
          entries to see what ajouatom actually adds on top of upstream. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, fontFamily: "JetBrains Mono", marginRight: 6 }}>SOURCE:</span>
        {[
          { v: "all",      l: "All" },
          { v: "idoka",    l: "iDoka only" },
          { v: "ajouatom", l: "ajouatom only" },
          { v: "both",     l: "Both" },
        ].map(opt => {
          const active = forkFacet === opt.v;
          return (
            <button key={opt.v} onClick={() => setForkFacet(opt.v)}
              style={{
                fontSize: 10, fontFamily: "JetBrains Mono", padding: "4px 10px",
                borderRadius: 8, cursor: "pointer",
                border: `1.5px solid ${active ? C.sr : C.bd}`,
                background: active ? C.sr + "18" : "transparent",
                color: active ? C.sr : C.tm, fontWeight: 800,
              }}>
              {opt.l}
            </button>
          );
        })}
      </div>

      {/* Source filter chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, fontFamily: "JetBrains Mono", marginRight: 6 }}>FEEDS:</span>
        {CATALOG_SOURCES.map(s => {
          const active = activeSources.has(s.id);
          return (
            <button key={s.id} onClick={() => toggleSource(s.id)}
              title={`${s.label} — ${s.entryCount} entries (${s.license})`}
              style={{
                fontSize: 10, fontFamily: "JetBrains Mono", padding: "4px 10px",
                borderRadius: 8, cursor: "pointer",
                border: `1.5px solid ${active ? C.a3 : C.bd}`,
                background: active ? C.a3 + "18" : "transparent",
                color: active ? C.a3 : C.tm, fontWeight: 800,
              }}>
              {s.id} ({s.entryCount})
            </button>
          );
        })}
      </div>

      {/* License filter chips */}
      {ALL_LICENSES.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, fontFamily: "JetBrains Mono", marginRight: 6 }}>LICENSES:</span>
          {ALL_LICENSES.map(l => {
            const active = activeLicenses.has(l);
            return (
              <button key={l} onClick={() => toggleLicense(l)}
                style={{
                  fontSize: 10, fontFamily: "JetBrains Mono", padding: "3px 8px",
                  borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${active ? C.wn : C.bd}`,
                  background: active ? C.wn + "18" : "transparent",
                  color: active ? C.wn : C.tm, fontWeight: 700,
                }}>
                {l}
              </button>
            );
          })}
          {activeLicenses.size > 0 && (
            <Btn onClick={() => setActiveLicenses(new Set())} color={C.tm} outline>✕ Clear</Btn>
          )}
        </div>
      )}

      {/* Tag filter chips */}
      {ALL_TAGS.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, fontFamily: "JetBrains Mono", marginRight: 6 }}>TAGS:</span>
          {ALL_TAGS.map(t => {
            const active = activeTags.has(t);
            return (
              <button key={t} onClick={() => toggleTag(t)}
                style={{
                  fontSize: 10, fontFamily: "JetBrains Mono", padding: "3px 8px",
                  borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${active ? C.gn : C.bd}`,
                  background: active ? C.gn + "18" : "transparent",
                  color: active ? C.gn : C.tm, fontWeight: 700,
                }}>
                {t}
              </button>
            );
          })}
          {activeTags.size > 0 && (
            <Btn onClick={() => setActiveTags(new Set())} color={C.tm} outline>✕ Clear tags</Btn>
          )}
        </div>
      )}

      {/* Results layout */}
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, alignItems: "start" }}>
        {/* Category tree sidebar — collapsible category → subcategory
            with per-node counts. Click a category header to open AND
            select it; click a subcategory to drill in further. */}
        <div>
          <Card style={{ padding: 10, position: "sticky", top: 8, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
            <div style={{ fontWeight: 900, fontSize: 11, color: C.tm, padding: "4px 8px 8px", letterSpacing: 1 }}>
              CATEGORIES
            </div>
            <CategoryButton
              active={activeCategory === "all"}
              onClick={() => setActiveCategory("all")}
              label="All"
              count={filtered.length}
              total={CATALOG_ENTRIES.length}
            />
            {CATALOG_CATEGORIES.map(c => {
              const visible = filtered.filter(e => e.category === c.name).length;
              const isOpen = openCats.has(c.name);
              const catSelected = activeCategory === c.name;
              const hasRealSubs = c.subcategories.length > 1
                || (c.subcategories.length === 1 && c.subcategories[0].name !== "(uncategorized)");
              return (
                <div key={c.name}>
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    {hasRealSubs ? (
                      <button onClick={() => toggleCatOpen(c.name)}
                        title={isOpen ? "Collapse" : "Expand"}
                        style={{
                          background: "transparent", border: "none", cursor: "pointer",
                          color: C.tm, fontSize: 10, padding: "2px 4px", lineHeight: 1,
                          width: 18, flexShrink: 0,
                        }}>
                        {isOpen ? "▾" : "▸"}
                      </button>
                    ) : <span style={{ width: 18, flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <CategoryButton
                        active={catSelected}
                        onClick={() => selectCategory(c.name, hasRealSubs ? c.name : null)}
                        label={c.name}
                        count={visible}
                        total={c.count}
                      />
                    </div>
                  </div>
                  {hasRealSubs && isOpen && (
                    <div style={{ marginLeft: 22, borderLeft: `1px dashed ${C.bd}`, paddingLeft: 6 }}>
                      {c.subcategories.map(sub => {
                        const key = `${c.name}::${sub.name}`;
                        const subVisible = filtered.filter(e =>
                          e.category === c.name && (e.subcategory || "(uncategorized)") === sub.name
                        ).length;
                        return (
                          <CategoryButton key={sub.name}
                            small
                            active={activeCategory === key}
                            onClick={() => selectCategory(key, c.name)}
                            label={sub.name}
                            count={subVisible}
                            total={sub.count}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </div>

        {/* Entries grouped by category */}
        <div data-testid="canuniverse-results">
          {grouped.size === 0 && (
            <Card style={{ textAlign: "center", padding: 32, color: C.tm, fontSize: 13 }}>
              No entries match the current filter.
            </Card>
          )}
          {[...grouped.entries()].map(([cat, entries]) => (
            <Card key={cat} style={{ marginBottom: 10, padding: 0, overflow: "hidden" }}>
              <div style={{
                padding: "10px 16px", background: C.bg, borderBottom: `1px solid ${C.bd}`,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <span style={{ fontWeight: 900, fontSize: 13, flex: 1, color: C.tx }}>{cat}</span>
                <Tag color={C.tm}>{entries.length} entries</Tag>
              </div>
              <div style={{ padding: "4px 0" }}>
                {entries.map(e => (
                  <EntryRow key={e.id} entry={e} starred={stars.has(e.id)} onToggleStar={toggleStar} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Footer — license + source attribution */}
      <Card style={{ marginTop: 16, background: C.c2 }}>
        <div style={{ fontWeight: 900, fontSize: 11, color: C.tm, marginBottom: 8, letterSpacing: 1.2 }}>
          SOURCES & ATTRIBUTION
        </div>
        <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.7 }}>
          {CATALOG_SOURCES.map(s => (
            <div key={s.id}>
              <span style={{ fontWeight: 700, color: C.tx }}>{s.label}</span>{" "}
              <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: C.tm }}>({s.license})</span>
              {s.url && (
                <> — <a href={s.url} target="_blank" rel="noreferrer" style={{ color: C.a3 }}>{s.url}</a></>
              )}
              {s.commit && (
                <> · commit <code style={{ fontFamily: "monospace", fontSize: 10 }}>{s.commit.slice(0, 8)}</code></>
              )}
            </div>
          ))}
          <div style={{ marginTop: 8, color: C.tm }}>
            Catalog generated {new Date(CATALOG_GENERATED_AT).toLocaleString()} · refresh via{" "}
            <code style={{ fontFamily: "monospace", fontSize: 10 }}>pnpm -F @workspace/scripts run fetch:can-catalogs</code>.
          </div>
        </div>
      </Card>
    </div>
  );
}

function CategoryButton({ active, onClick, label, count, total, small }) {
  return (
    <button onClick={onClick} style={{
      width: "100%", textAlign: "left",
      padding: small ? "3px 8px" : "6px 10px", marginBottom: 2,
      background: active ? C.sr + "14" : "transparent",
      border: "none", borderLeft: `3px solid ${active ? C.sr : "transparent"}`,
      cursor: "pointer", borderRadius: 6, fontFamily: "'Nunito'",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      <span style={{
        flex: 1, fontSize: small ? 10 : 11, fontWeight: active ? 800 : (small ? 500 : 600),
        color: active ? C.sr : (small ? C.ts : C.tx),
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{label}</span>
      <span style={{
        fontSize: 9, fontFamily: "JetBrains Mono", color: count === 0 ? C.tm : C.ts,
      }}>
        {count}{total != null && total !== count ? `/${total}` : ""}
      </span>
    </button>
  );
}

function EntryRow({ entry, starred, onToggleStar }) {
  const srcs = entry.sources || [entry.source];
  const sourceLabels = srcs.map(s => SOURCE_BY_ID[s]?.id || s);
  // Task #622: when an entry is listed in EXACTLY ONE feed (i.e. no
  // other curated list also carries it), show a tiny coloured badge so
  // the single-source provenance is obvious at a glance. We deliberately
  // require true single-source membership (not just iDoka-XOR-ajouatom)
  // so the badge can't mislead when the entry also appears in
  // automotive-collection or another feed.
  const onlySource = srcs.length === 1 ? srcs[0] : null;
  const forkBadge =
    onlySource === "awesome-canbus" ? { l: "iDoka", c: "#1976D2" } :
    onlySource === "ajouatom"       ? { l: "ajouatom", c: "#7B1FA2" } :
    null;
  return (
    <div style={{
      padding: "10px 16px", borderTop: `1px solid ${C.bd}33`,
      display: "flex", gap: 12, alignItems: "flex-start",
    }}>
      <button onClick={() => onToggleStar(entry.id)}
        title={starred ? "Remove from shortlist" : "Add to shortlist"}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          fontSize: 18, lineHeight: 1, color: starred ? "#FFB300" : C.tm,
          padding: 2, flexShrink: 0,
        }}>
        {starred ? "★" : "☆"}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <a href={entry.url} target="_blank" rel="noreferrer"
            style={{ fontWeight: 800, fontSize: 13, color: C.a3, textDecoration: "none" }}>
            {entry.name}
          </a>
          {entry.license && (
            <span title="License of the curated list this entry came from"
              style={{
              fontSize: 9, fontFamily: "JetBrains Mono", padding: "1px 6px",
              borderRadius: 4, background: C.wn + "14", color: C.wn, fontWeight: 700,
            }}>{entry.license}</span>
          )}
          {(entry.tags || []).map(t => (
            <span key={t} style={{
              fontSize: 9, fontFamily: "JetBrains Mono", padding: "1px 6px",
              borderRadius: 4, background: C.gn + "14", color: C.gn,
            }}>{t}</span>
          ))}
          {sourceLabels.map(s => (
            <span key={s} style={{
              fontSize: 9, fontFamily: "JetBrains Mono", padding: "1px 6px",
              borderRadius: 4, background: C.tm + "14", color: C.tm,
            }}>{s}</span>
          ))}
          {forkBadge && (
            <span title={`Listed only in the ${forkBadge.l} feed`} style={{
              fontSize: 9, fontFamily: "JetBrains Mono", padding: "1px 6px",
              borderRadius: 4, background: forkBadge.c + "1F", color: forkBadge.c,
              fontWeight: 700,
            }}>{forkBadge.l}-only</span>
          )}
        </div>
        {(entry.category || entry.subcategory) && (
          <div style={{ fontSize: 10, fontFamily: "JetBrains Mono", color: C.tm, marginTop: 2 }}>
            {entry.category}{entry.subcategory ? ` › ${entry.subcategory}` : ""}
          </div>
        )}
        {entry.description && (
          <div style={{ fontSize: 12, color: C.ts, marginTop: 4, lineHeight: 1.5 }}>
            {entry.description}
          </div>
        )}
        {entry.notes && (
          <div title="Alternate description from a secondary source"
            style={{ fontSize: 11, color: C.tm, marginTop: 3, lineHeight: 1.5, fontStyle: "italic" }}>
            {entry.notes}
          </div>
        )}
      </div>
    </div>
  );
}
