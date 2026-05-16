/* RelatedCanUniversePanel — collapsible inline panel that surfaces 3-5
 * entries from the read-only CAN Universe catalog filtered to the host
 * tab's category. Single source of truth stays
 * `src/lib/awesomeCanbus.generated.js`; this panel is pure view + a
 * "see all" hook into the CAN UNIVERSE tab (Task #621).
 */
import React, { useMemo, useState, useCallback, useEffect } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";
import { CATALOG_ENTRIES } from "../lib/awesomeCanbus.generated.js";

function matchEntry(e, filters) {
  for (const f of filters) {
    if (f.category && e.category !== f.category) continue;
    if (f.subcategory) {
      const sub = e.subcategory || "";
      if (f.subcategoryPrefix ? !sub.startsWith(f.subcategory) : sub !== f.subcategory) continue;
    }
    return true;
  }
  return false;
}

function loadCollapsed(panelId) {
  try {
    const raw = localStorage.getItem(`srtlab.relatedCan.${panelId}.collapsed`);
    return raw === "1";
  } catch { return false; }
}

function saveCollapsed(panelId, v) {
  try { localStorage.setItem(`srtlab.relatedCan.${panelId}.collapsed`, v ? "1" : "0"); }
  catch { /* ignore */ }
}

export default function RelatedCanUniversePanel({
  panelId,
  title = "RELATED OPEN-SOURCE TOOLS",
  filters,
  limit = 5,
  onOpenTab,
}) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(panelId));
  useEffect(() => { saveCollapsed(panelId, collapsed); }, [panelId, collapsed]);

  const { entries, total } = useMemo(() => {
    const all = CATALOG_ENTRIES.filter(e => matchEntry(e, filters));
    /* Stable preference: prefer entries with a description, then by name. */
    const sorted = [...all].sort((a, b) => {
      const da = a.description ? 0 : 1;
      const db = b.description ? 0 : 1;
      if (da !== db) return da - db;
      return (a.name || "").localeCompare(b.name || "");
    });
    return { entries: sorted.slice(0, limit), total: all.length };
  }, [filters, limit]);

  const handleSeeAll = useCallback(() => {
    if (typeof onOpenTab === "function") {
      onOpenTab("canuniverse");
      return;
    }
    /* Fallback for tabs that don't thread an onOpenTab prop: dispatch a
     * window-level event the App listens for. Keeps the "see all" button
     * working everywhere without each host having to wire navigation. */
    try {
      window.dispatchEvent(new CustomEvent("srtlab:openTab", { detail: "canuniverse" }));
    } catch { /* SSR / non-browser env — no-op */ }
  }, [onOpenTab]);

  if (total === 0) return null;

  return (
    <Card style={{ marginTop: 14, marginBottom: 14, background: "#F0F7FF", borderColor: "#90CAF9", padding: 0 }}>
      <button
        onClick={() => setCollapsed(c => !c)}
        data-testid={`related-can-toggle-${panelId}`}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "10px 16px", background: "transparent", border: "none",
          cursor: "pointer", textAlign: "left",
        }}>
        <span style={{ fontSize: 16 }}>🌐</span>
        <span style={{ fontWeight: 900, fontSize: 11, color: "#0D3C6E", letterSpacing: 1.2, flex: 1 }}>
          {title}
          <span style={{ color: C.tm, fontWeight: 700, marginLeft: 8 }}>
            ({Math.min(limit, total)} of {total})
          </span>
        </span>
        <span style={{ fontSize: 11, color: C.tm }}>{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div style={{ padding: "0 16px 12px" }}>
          <div data-testid={`related-can-list-${panelId}`}>
            {entries.map(e => (
              <div key={e.id} style={{
                padding: "8px 0", borderTop: `1px solid ${C.bd}33`,
                display: "flex", gap: 10, alignItems: "flex-start",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <a href={e.url} target="_blank" rel="noreferrer"
                      style={{ fontWeight: 800, fontSize: 12, color: C.a3, textDecoration: "none" }}>
                      {e.name}
                    </a>
                    {e.license && (
                      <span style={{
                        fontSize: 9, fontFamily: "JetBrains Mono", padding: "1px 6px",
                        borderRadius: 4, background: C.wn + "14", color: C.wn, fontWeight: 700,
                      }}>{e.license}</span>
                    )}
                    {e.subcategory && (
                      <span style={{ fontSize: 9, fontFamily: "JetBrains Mono", color: C.tm }}>
                        {e.subcategory}
                      </span>
                    )}
                  </div>
                  {e.description && (
                    <div style={{ fontSize: 11, color: C.ts, marginTop: 2, lineHeight: 1.45 }}>
                      {e.description}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={handleSeeAll} color={C.a3} outline>
              See all {total} in CAN Universe →
            </Btn>
            <span style={{ fontSize: 10, color: C.tm }}>
              Read-only catalog · nothing is downloaded or executed.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
