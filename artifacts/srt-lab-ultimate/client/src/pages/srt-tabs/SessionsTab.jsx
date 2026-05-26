import React, { useState, useEffect, useCallback, useMemo, useContext } from "react";
import { C } from "@/lib/srt/constants.js";
import { Card, Btn } from "@/lib/srt/ui.jsx";
import {
  getSessions, deleteSession, clearSessions,
  generateSessionReport, sessionsToCSV, subscribeAudit,
  getBackup,
} from "@/lib/srt/audit.js";
import { MasterVinContext } from "@/contexts/MasterVinContext.jsx";

const PENDING_BACKUP_KEY = "srtlab_pending_backup_select";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

export default function SessionsTab() {
  const { setPg } = useContext(MasterVinContext);
  const [sessions, setSessions] = useState(getSessions());
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [outcome, setOutcome] = useState("all"); // all | success | fail
  const [routing, setRouting] = useState("all"); // all | sgw | legacy
  const [search, setSearch] = useState("");
  const [shopInfo, setShopInfo] = useState(() => {
    try { return JSON.parse(localStorage.getItem("srtlab_shopinfo") || "{}"); }
    catch { return {}; }
  });
  const [editingShop, setEditingShop] = useState(false);

  const refresh = useCallback(() => setSessions(getSessions()), []);

  useEffect(() => {
    const unsub = subscribeAudit(refresh);
    const id = setInterval(refresh, 4000);
    return () => { unsub(); clearInterval(id); };
  }, [refresh]);

  // Deep-link: select a session pre-chosen via URL hash or History panel event.
  useEffect(() => {
    const applyHash = () => {
      const m = (window.location.hash || "").match(/session=([^&]+)/);
      if (!m) return;
      setSelected(decodeURIComponent(m[1]));
      try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
    };
    applyHash();
    const onNav = (e) => {
      if (e?.detail?.tab !== "sessions" || !e?.detail?.id) return;
      setSelected(e.detail.id);
    };
    window.addEventListener("hashchange", applyHash);
    window.addEventListener("srtlab:navigate", onNav);
    return () => {
      window.removeEventListener("hashchange", applyHash);
      window.removeEventListener("srtlab:navigate", onNav);
    };
  }, []);

  const handleDelete = useCallback((id) => {
    if (!window.confirm("Delete this session record? This removes it from your paper trail.")) return;
    deleteSession(id);
    if (selected === id) setSelected(null);
    refresh();
  }, [selected, refresh]);

  const handleClearAll = useCallback(() => {
    if (!window.confirm("Delete ALL " + sessions.length + " session records? Cannot be undone.")) return;
    clearSessions();
    setSelected(null);
    refresh();
  }, [sessions.length, refresh]);

  const saveShopInfo = useCallback(() => {
    try { localStorage.setItem("srtlab_shopinfo", JSON.stringify(shopInfo)); } catch {}
    setEditingShop(false);
  }, [shopInfo]);

  const generateReport = useCallback((sessionsToInclude) => {
    const html = generateSessionReport(sessionsToInclude, shopInfo);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (w) { setTimeout(() => w.print(), 500); }
    else {
      const a = document.createElement("a");
      a.href = url;
      a.download = "srtlab_report_" + new Date().toISOString().slice(0, 10) + ".html";
      a.click();
    }
  }, [shopInfo]);

  const exportJson = useCallback((sessionsToInclude) => {
    const blob = new Blob(
      [JSON.stringify({ generated: new Date().toISOString(), shopInfo, sessions: sessionsToInclude }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "srtlab_sessions_" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }, [shopInfo]);

  const exportCsv = useCallback((sessionsToInclude) => {
    const csv = sessionsToCSV(sessionsToInclude);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "srtlab_sessions_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter(s => {
      if (filter !== "all" && s.module !== filter) return false;
      if (outcome === "success" && !s.success) return false;
      if (outcome === "fail" && s.success) return false;
      if (routing === "sgw" && !s.sgwRouted) return false;
      if (routing === "legacy" && s.sgwRouted) return false;
      if (q) {
        const hay = [
          s.module, s.operation, s.oldVin, s.newVin, s.titleRef,
          s.titleNotes, s.technician, s.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, filter, outcome, routing, search]);

  const moduleCounts = {};
  sessions.forEach(s => { moduleCounts[s.module] = (moduleCounts[s.module] || 0) + 1; });
  const successCount = filtered.filter(s => s.success).length;
  const failCount = filtered.length - successCount;
  const sgwTotal = sessions.filter(s => s.sgwRouted).length;
  const legacyTotal = sessions.length - sgwTotal;
  const selectedSession = selected ? sessions.find(s => s.id === selected) : null;

  return (
    <div>
      <Card style={{
        background: "linear-gradient(135deg,#1A0A3D 0%,#3A1E6F 40%,#8E24AA 100%)",
        color: "#fff", marginBottom: 18,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32 }}>📋</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 24, letterSpacing: 2 }}>SESSION PAPER TRAIL</div>
            <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 3, fontWeight: 700 }}>
              PROGRAMMING HISTORY · PRINTABLE REPORTS · RECORDS
            </div>
          </div>
          <div style={{ fontSize: 11, padding: "6px 12px", background: "rgba(255,255,255,0.15)", borderRadius: 8 }}>
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10 }}>
          Complete log of every programming operation. Each record includes VIN before/after,
          title reference, technician, timestamp, and write result. Export as printable HTML,
          shop-friendly CSV, or JSON. Keeps the last 500 sessions.
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 11, color: C.a4, letterSpacing: 2 }}>
            🏢 SHOP INFORMATION (appears on reports)
          </div>
          {!editingShop && (
            <button onClick={() => setEditingShop(true)} style={{
              fontSize: 11, padding: "6px 12px", background: C.a4 + "15", color: C.a4,
              border: "1px solid " + C.a4, borderRadius: 6, fontWeight: 700, cursor: "pointer",
            }}>✏️ Edit</button>
          )}
        </div>
        {editingShop ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <ShopField label="SHOP NAME" value={shopInfo.shopName || ""} onChange={v => setShopInfo({ ...shopInfo, shopName: v })} />
            <ShopField label="DEALER LICENSE #" value={shopInfo.license || ""} onChange={v => setShopInfo({ ...shopInfo, license: v })} mono />
            <div style={{ gridColumn: "1 / 3" }}>
              <ShopField label="ADDRESS" value={shopInfo.address || ""} onChange={v => setShopInfo({ ...shopInfo, address: v })} />
            </div>
            <div style={{ gridColumn: "1 / 3", display: "flex", gap: 8 }}>
              <Btn onClick={saveShopInfo} color={C.gn}>💾 Save</Btn>
              <Btn onClick={() => setEditingShop(false)} color={C.tm} outline>Cancel</Btn>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.6 }}>
            {shopInfo.shopName
              ? <div style={{ fontWeight: 700 }}>{shopInfo.shopName}</div>
              : <div style={{ color: C.tm, fontStyle: "italic" }}>No shop name set — click Edit to add</div>}
            {shopInfo.address && <div style={{ fontSize: 11, color: C.ts }}>{shopInfo.address}</div>}
            {shopInfo.license && <div style={{ fontSize: 11, color: C.ts, fontFamily: "'JetBrains Mono'" }}>License: {shopInfo.license}</div>}
          </div>
        )}
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
          <Stat n={successCount} label="SUCCESSFUL" bg="#E8F5E9" color={C.gn} />
          <Stat n={failCount} label="FAILED" bg="#FFEBEE" color={C.er} />
          <Stat n={filtered.length} label="SHOWN" bg="#F0F8FF" color={C.a3} />
          <Stat n={sessions.length} label="TOTAL" bg="#F8F6F2" color={C.tx} />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>MODULE:</div>
          <button onClick={() => setFilter("all")} style={pill(filter === "all", C.a4)}>All ({sessions.length})</button>
          {Object.entries(moduleCounts).map(([m, n]) => (
            <button key={m} onClick={() => setFilter(m)} style={pill(filter === m, C.a4)}>{m} ({n})</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>OUTCOME:</div>
          {[["all", "All"], ["success", "✓ Success"], ["fail", "✗ Failed"]].map(([id, label]) => (
            <button key={id} onClick={() => setOutcome(id)} style={pill(outcome === id, C.a3)}>{label}</button>
          ))}
          <div style={{ width: 1, height: 22, background: C.bd, margin: "0 4px" }} />
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>ROUTING:</div>
          <button onClick={() => setRouting("all")} style={pill(routing === "all", C.a4)}>All</button>
          <button onClick={() => setRouting("sgw")} style={pill(routing === "sgw", C.a4)}>🔒 SGW ({sgwTotal})</button>
          <button onClick={() => setRouting("legacy")} style={pill(routing === "legacy", C.a4)}>Legacy ({legacyTotal})</button>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search VIN, title #, notes…"
            style={{
              flex: 1, minWidth: 180, padding: "8px 10px", border: "1px solid " + C.bd,
              borderRadius: 6, fontSize: 12,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            {filtered.length > 0 && (
              <>
                <Btn onClick={() => generateReport(filtered)} color={C.gn}>
                  📄 Print ({filtered.length})
                </Btn>
                <Btn onClick={() => exportCsv(filtered)} color={C.a3} outline>⬇ CSV</Btn>
                <Btn onClick={() => exportJson(filtered)} color={C.a2} outline>⬇ JSON</Btn>
              </>
            )}
            <Btn onClick={refresh} color={C.a3} outline>🔄 Refresh</Btn>
            {sessions.length > 0 && <Btn onClick={handleClearAll} color={C.er} outline>🗑️ Clear All</Btn>}
          </div>
        </div>
      </Card>

      {sessions.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 40, color: C.tm }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ts }}>No sessions yet</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>
            Programming operations will appear here automatically after each write.
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 14 }}>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={listHeader}>SESSIONS ({filtered.length})</div>
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
              {filtered.map(s => {
                const isSel = selected === s.id;
                const date = new Date(s.timestamp);
                return (
                  <div key={s.id} onClick={() => setSelected(s.id)} style={{
                    padding: "12px 16px", borderBottom: "1px solid " + C.bd, cursor: "pointer",
                    background: isSel ? C.a4 + "10" : "#fff",
                    borderLeft: "3px solid " + (isSel ? C.a4 : s.success ? C.gn : C.er),
                    transition: "all 0.15s",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 800, fontSize: 13, color: isSel ? C.a4 : C.tx }}>{s.module}</div>
                      <div style={{
                        fontSize: 10, padding: "2px 6px", borderRadius: 4, fontWeight: 800,
                        background: s.success ? "#E8F5E9" : "#FFEBEE",
                        color: s.success ? C.gn : C.er,
                      }}>{s.success ? "✓ OK" : "✗ FAIL"}</div>
                    </div>
                    <div style={{ fontSize: 10, color: C.ts, marginTop: 3 }}>{s.operation || "Write"}</div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.tx, marginTop: 3 }}>
                      {s.newVin || "—"}
                    </div>
                    {(s.adapter || s.sgwRouted) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        {s.sgwRouted && (
                          <span title="Authenticated through Security Gateway via Autel J2534" style={{
                            fontSize: 9, fontWeight: 800, padding: "1px 6px", borderRadius: 4,
                            background: "#E3F2FD", color: "#1565C0", border: "1px solid #1565C055",
                            letterSpacing: 1,
                          }}>🔒 SGW</span>
                        )}
                        {s.adapter && (
                          <span style={{ fontSize: 10, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{s.adapter}</span>
                        )}
                      </div>
                    )}
                    {s.titleRef && <div style={{ fontSize: 10, color: C.a3, marginTop: 3 }}>📄 {s.titleRef}</div>}
                    <div style={{ fontSize: 10, color: C.tm, marginTop: 3 }}>{date.toLocaleString()}</div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ padding: 30, textAlign: "center", color: C.tm, fontSize: 12 }}>
                  No sessions match your filters.
                </div>
              )}
            </div>
          </Card>

          {selectedSession ? (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{
                padding: "12px 16px", background: "linear-gradient(90deg,#1A0A3D,#3A1E6F)",
                color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 2, fontWeight: 700 }}>SESSION DETAIL</div>
                  <div style={{ fontFamily: "'Righteous'", fontSize: 16, letterSpacing: 1 }}>
                    {selectedSession.module} — {selectedSession.operation || "Write"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {selectedSession.backupKey && getBackup(selectedSession.backupKey) && (
                    <button
                      onClick={() => {
                        try { localStorage.setItem(PENDING_BACKUP_KEY, selectedSession.backupKey); } catch {}
                        try { window.dispatchEvent(new Event("srtlab:backupSelect")); } catch {}
                        setPg("backups");
                      }}
                      title="Open the Backups tab and load the snapshot taken before this write."
                      style={chip("#00C85322", "#fff", "#00C85355")}
                    >💾 Restore this session's backup</button>
                  )}
                  {selectedSession.backupKey && !getBackup(selectedSession.backupKey) && (
                    <span title="The snapshot taken before this write was deleted from local storage."
                      style={{ ...chip("rgba(255,255,255,0.05)", "#FFB300AA", "#FFB30055"), cursor: "default" }}>
                      ⚠ Backup deleted
                    </span>
                  )}
                  <button onClick={() => generateReport([selectedSession])} style={chip("rgba(255,255,255,0.1)", "#fff")}>📄 Print</button>
                  <button onClick={() => handleDelete(selectedSession.id)} style={chip("#FF525222", "#fff", "#FF525255")}>🗑 Delete</button>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                <div style={{
                  padding: "10px 14px",
                  background: selectedSession.success ? "#E8F5E9" : "#FFEBEE",
                  borderRadius: 8, marginBottom: 14,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  border: "1px solid " + (selectedSession.success ? C.gn : C.er) + "55",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: selectedSession.success ? C.gn : C.er }}>
                    {selectedSession.success ? "✓ WRITE SUCCEEDED" : "✗ WRITE FAILED"}
                  </div>
                  <div style={{ fontSize: 11, color: C.ts }}>{new Date(selectedSession.timestamp).toLocaleString()}</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                  <VinBox label="OLD VIN (before write)" value={selectedSession.oldVin || "(not read)"} color={C.wn} bg="#FFF8F0" />
                  <VinBox label="NEW VIN (written)" value={selectedSession.newVin || "—"} color={C.gn} bg="#E8F5E9" />
                </div>

                {selectedSession.titleRef && (
                  <div style={{
                    padding: 12, background: "#F0F8FF", border: "1px solid #B0D4F0",
                    borderRadius: 8, marginBottom: 14,
                  }}>
                    <div style={{ fontSize: 10, color: C.a3, fontWeight: 800, letterSpacing: 2, marginBottom: 6 }}>
                      📄 TITLE REFERENCE
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.tx }}>{selectedSession.titleRef}</div>
                    {selectedSession.titleNotes && (
                      <div style={{ fontSize: 11, color: C.ts, marginTop: 6, fontStyle: "italic" }}>
                        {selectedSession.titleNotes}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 11 }}>
                  {selectedSession.technician && <Row k="Technician:" v={selectedSession.technician} />}
                  {selectedSession.moduleAddr && (
                    <Row k="Module Address:" v={
                      <span style={{ fontFamily: "'JetBrains Mono'" }}>
                        TX 0x{hx(selectedSession.moduleAddr.tx, 3)} / RX 0x{hx(selectedSession.moduleAddr.rx, 3)}
                      </span>
                    } />
                  )}
                  {selectedSession.adapter && <Row k="Adapter:" v={
                    <span>
                      {selectedSession.adapter}
                      {selectedSession.sgwRouted && (
                        <span title="Authenticated through Security Gateway via Autel J2534" style={{
                          marginLeft: 8, fontSize: 9, fontWeight: 800, padding: "1px 6px", borderRadius: 4,
                          background: "#E3F2FD", color: "#1565C0", border: "1px solid #1565C055", letterSpacing: 1,
                        }}>🔒 SGW ROUTED</span>
                      )}
                    </span>
                  } />}
                  {selectedSession.algorithm && <Row k="Security Algorithm:" v={selectedSession.algorithm} />}
                  {selectedSession.voltage !== undefined && selectedSession.voltage !== null &&
                    <Row k="Bench Voltage:" v={selectedSession.voltage.toFixed(1) + "V"} />}
                  {selectedSession.preWriteConfirmed && (
                    <Row k="Pre-Write Review:" v={"✓ Confirmed " + new Date(selectedSession.preWriteConfirmed).toLocaleTimeString()} />
                  )}
                  <Row k="Session ID:" v={
                    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tm }}>{selectedSession.id}</span>
                  } />
                  {selectedSession.backupKey && (
                    <Row k="Pre-Write Backup:" v={
                      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: getBackup(selectedSession.backupKey) ? C.gn : C.wn }}>
                        {selectedSession.backupKey}
                        {!getBackup(selectedSession.backupKey) && " (deleted)"}
                      </span>
                    } />
                  )}
                </div>

                {selectedSession.notes && (
                  <div style={{ marginTop: 14, padding: 10, background: "#FAFAFA", border: "1px solid " + C.bd, borderRadius: 6, fontSize: 12, color: C.ts }}>
                    <b>Notes:</b> {selectedSession.notes}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card style={{ textAlign: "center", padding: 40, color: C.tm }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>👈</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ts }}>Select a session to view details</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, bg, color }) {
  return (
    <div style={{ flex: 1, padding: 14, background: bg, borderRadius: 8, textAlign: "center" }}>
      <div style={{ fontSize: 24, fontWeight: 900, color }}>{n}</div>
      <div style={{ fontSize: 10, color: C.ts, fontWeight: 700, letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

function ShopField({ label, value, onChange, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700 }}>{label}</div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", padding: 8, border: "1px solid " + C.bd, borderRadius: 6,
          fontSize: 13, boxSizing: "border-box",
          fontFamily: mono ? "'JetBrains Mono'" : undefined,
        }}
      />
    </div>
  );
}

function VinBox({ label, value, color, bg }) {
  return (
    <div style={{ padding: 10, background: bg, borderRadius: 8, border: "1px solid " + color + "55" }}>
      <div style={{ fontSize: 9, color: C.ts, letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 13, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <>
      <span style={{ color: C.ts, fontWeight: 700 }}>{k}</span>
      <span>{v}</span>
    </>
  );
}

const pill = (active, color) => ({
  padding: "6px 12px", fontSize: 11, fontWeight: 800, borderRadius: 6,
  border: "1.5px solid " + (active ? color : C.bd),
  background: active ? color + "15" : "#fff",
  color: active ? color : C.ts, cursor: "pointer",
});

const listHeader = {
  padding: "12px 16px", background: "#F8F6F2", fontSize: 11, fontWeight: 800,
  color: C.ts, letterSpacing: 2, borderBottom: "1px solid " + C.bd,
};

const chip = (bg, color, border = "rgba(255,255,255,0.3)") => ({
  padding: "6px 12px", fontSize: 11, fontWeight: 800, borderRadius: 6,
  border: "1px solid " + border, background: bg, color, cursor: "pointer",
});
