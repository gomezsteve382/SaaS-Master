import React, { useState, useEffect, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";
import {
  getBackupList, getBackup, deleteBackup, clearBackups,
  restoreModule, subscribeAudit, logSession,
} from "../lib/audit.js";
import { createObdEngine } from "../lib/obdEngine.js";
import ReadFirstModal from "../lib/ReadFirstModal.jsx";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

export default function BackupsTab() {
  const [backups, setBackups] = useState(getBackupList());
  const [selected, setSelected] = useState(null);
  const [selectedData, setSelectedData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [conn, setConn] = useState(false);
  const [restoreLog, setRestoreLog] = useState([]);
  const eng = useRef(null);

  const refresh = useCallback(() => {
    const list = getBackupList();
    setBackups(list);
    if (selected && !list.some(b => b.key === selected)) {
      setSelected(null); setSelectedData(null);
    }
  }, [selected]);

  // Auto-update + cross-tab notifications + 4s poll fallback.
  useEffect(() => {
    const unsub = subscribeAudit(refresh);
    const id = setInterval(refresh, 4000);
    return () => { unsub(); clearInterval(id); };
  }, [refresh]);

  // Deep-link: select a backup pre-chosen via URL hash or History panel event.
  useEffect(() => {
    const applyHash = () => {
      const m = (window.location.hash || "").match(/backup=([^&]+)/);
      if (!m) return;
      const key = decodeURIComponent(m[1]);
      const data = getBackup(key);
      if (data) { setSelected(key); setSelectedData(data); }
      try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
    };
    applyHash();
    const onNav = (e) => {
      if (e?.detail?.tab !== "backups" || !e?.detail?.key) return;
      const data = getBackup(e.detail.key);
      if (data) { setSelected(e.detail.key); setSelectedData(data); }
    };
    window.addEventListener("hashchange", applyHash);
    window.addEventListener("srtlab:navigate", onNav);
    return () => {
      window.removeEventListener("hashchange", applyHash);
      window.removeEventListener("srtlab:navigate", onNav);
    };
  }, []);

  // Release Web Serial port when this tab unmounts.
  useEffect(() => () => {
    if (eng.current) { try { eng.current.disconnect(); } catch {} eng.current = null; }
  }, []);

  const addRestoreLog = useCallback((m, t = "info") => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setRestoreLog(p => [...p.slice(-200), { t: ts, m, type: t }]);
  }, []);

  const loadBackup = useCallback((key) => {
    setSelected(key);
    setSelectedData(getBackup(key));
  }, []);

  const handleDelete = useCallback((key) => {
    if (!window.confirm("Delete this backup? Cannot be undone.")) return;
    deleteBackup(key);
    if (selected === key) { setSelected(null); setSelectedData(null); }
    refresh();
  }, [selected, refresh]);

  const handleClearAll = useCallback(() => {
    if (!window.confirm("Delete ALL " + backups.length + " backups? Cannot be undone.")) return;
    clearBackups();
    setSelected(null); setSelectedData(null);
    refresh();
  }, [backups.length, refresh]);

  const downloadBackup = useCallback((key) => {
    const data = getBackup(key); if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "srtlab_backup_" + data.module + "_" +
      (data.dids[0xF190]?.ascii?.slice(-17) || "unknown") + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleConnect = useCallback(async () => {
    if (conn) {
      try { await eng.current?.disconnect(); } catch {}
      eng.current = null; setConn(false); return;
    }
    setBusy("Connecting...");
    try {
      eng.current = createObdEngine(addRestoreLog);
      await eng.current.connect();
      setConn(true);
      addRestoreLog("Adapter connected.", "info");
    } catch (e) {
      addRestoreLog("Connect failed: " + e.message, "error");
    } finally { setBusy(""); }
  }, [conn, addRestoreLog]);

  const handleRestore = useCallback(() => {
    if (!selectedData) return;
    if (!conn) {
      alert("Connect to the adapter first (button at the top of this tab).");
      return;
    }
    setModalOpen(true);
  }, [selectedData, conn]);

  const onConfirmRestore = useCallback(async (meta) => {
    setModalOpen(false);
    if (!eng.current || !selectedData) return;
    setBusy("Restoring...");
    let ok = false;
    try {
      ok = await restoreModule(
        eng.current.uds,
        selectedData.tx, selectedData.rx,
        selectedData, addRestoreLog, true,
      );
    } catch (e) {
      addRestoreLog("Restore exception: " + e.message, "error");
    } finally { setBusy(""); }

    logSession({
      module: selectedData.module,
      operation: "Restore from backup",
      success: ok,
      moduleAddr: { tx: selectedData.tx, rx: selectedData.rx },
      newVin: selectedData.dids?.[0xF190]?.ascii?.slice(-17) || "",
      titleRef: meta.titleRef,
      titleNotes: meta.titleNotes,
      technician: meta.technician,
      preWriteConfirmed: meta.preWriteConfirmed,
      notes: "Restored from snapshot " + selectedData.timestamp,
    });
  }, [selectedData, addRestoreLog]);

  const filtered = filter === "all" ? backups : backups.filter(b => b.module === filter);
  const moduleCounts = {};
  backups.forEach(b => { moduleCounts[b.module] = (moduleCounts[b.module] || 0) + 1; });

  return (
    <div>
      <Card style={{
        background: "linear-gradient(135deg,#0A3D1A 0%,#1E6F3A 40%,#00BFA5 100%)",
        color: "#fff", marginBottom: 18,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32 }}>💾</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 24, letterSpacing: 2 }}>MODULE BACKUPS</div>
            <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 3, fontWeight: 700 }}>
              PRE-WRITE SNAPSHOTS · ONE-CLICK RESTORE
            </div>
          </div>
          <div style={{ fontSize: 11, padding: "6px 12px", background: "rgba(255,255,255,0.15)", borderRadius: 8 }}>
            {backups.length} backup{backups.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10 }}>
          Every write operation automatically creates a snapshot of all critical DIDs.
          If a write goes wrong, restore from here. Max 50 backups kept (auto-rotates).
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>FILTER:</div>
          <button onClick={() => setFilter("all")} style={pill(filter === "all", C.a2)}>All ({backups.length})</button>
          {Object.entries(moduleCounts).map(([m, n]) => (
            <button key={m} onClick={() => setFilter(m)} style={pill(filter === m, C.a2)}>{m} ({n})</button>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Btn onClick={handleConnect} color={conn ? C.gn : C.a3} outline>
              {busy === "Connecting..." ? "..." : (conn ? "🔌 Disconnect" : "🔌 Connect Adapter")}
            </Btn>
            <Btn onClick={refresh} color={C.a3} outline>🔄 Refresh</Btn>
            {backups.length > 0 && <Btn onClick={handleClearAll} color={C.er} outline>🗑️ Clear All</Btn>}
          </div>
        </div>
        {restoreLog.length > 0 && (
          <div style={{
            maxHeight: 110, overflow: "auto", background: "#111", color: "#9CFF9C",
            fontFamily: "'JetBrains Mono'", fontSize: 11, padding: 10, borderRadius: 6,
          }}>
            {restoreLog.map((l, i) => (
              <div key={i} style={{ color: l.type === "error" ? "#ff7676" : l.type === "warn" ? "#ffd279" : l.type === "tx" ? "#9bd1ff" : "#9CFF9C" }}>
                [{l.t}] {l.m}
              </div>
            ))}
          </div>
        )}
      </Card>

      {backups.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 40, color: C.tm }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ts }}>No backups yet</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>
            Backups are created automatically every time you write to a module.
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 14 }}>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={listHeader}>BACKUP HISTORY ({filtered.length})</div>
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
              {filtered.map(b => {
                const isSel = selected === b.key;
                const date = new Date(b.timestamp);
                return (
                  <div key={b.key} onClick={() => loadBackup(b.key)}
                    style={{
                      padding: "12px 16px", borderBottom: "1px solid " + C.bd, cursor: "pointer",
                      background: isSel ? C.a2 + "10" : "#fff",
                      borderLeft: "3px solid " + (isSel ? C.a2 : "transparent"),
                      transition: "all 0.15s",
                    }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 800, fontSize: 13, color: isSel ? C.a2 : C.tx }}>{b.module}</div>
                      <div style={{ fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'" }}>{b.didCount} DIDs</div>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.ts, marginTop: 3 }}>{b.vin}</div>
                    <div style={{ fontSize: 10, color: C.tm, marginTop: 3 }}>{date.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {selectedData ? (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{
                padding: "12px 16px", background: "linear-gradient(90deg,#0A3D1A,#1E6F3A)",
                color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 2, fontWeight: 700 }}>BACKUP DETAILS</div>
                  <div style={{ fontFamily: "'Righteous'", fontSize: 16, letterSpacing: 1 }}>{selectedData.module}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handleRestore} disabled={busy === "Restoring..."} style={chip("#fff3", "#fff")}>
                    ↩ Restore
                  </button>
                  <button onClick={() => downloadBackup(selected)} style={chip("rgba(255,255,255,0.1)", "#fff")}>⬇ Download</button>
                  <button onClick={() => handleDelete(selected)} style={chip("#FF525222", "#fff", "#FF525255")}>🗑 Delete</button>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 11, marginBottom: 16 }}>
                  <span style={{ color: C.ts }}>Created:</span>
                  <span style={{ fontFamily: "'JetBrains Mono'" }}>{new Date(selectedData.timestamp).toLocaleString()}</span>
                  <span style={{ color: C.ts }}>TX / RX:</span>
                  <span style={{ fontFamily: "'JetBrains Mono'" }}>
                    {selectedData.moduleAddr
                      ? "0x" + hx(selectedData.moduleAddr.tx, 3) + " / 0x" + hx(selectedData.moduleAddr.rx, 3)
                      : "—"}
                  </span>
                  <span style={{ color: C.ts }}>DIDs captured:</span>
                  <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{Object.keys(selectedData.dids).length}</span>
                </div>

                <div style={{
                  padding: 10, background: "#FFF8F0", border: "1px solid " + C.wn,
                  borderRadius: 6, fontSize: 11, color: C.ts, marginBottom: 14, lineHeight: 1.5,
                }}>
                  <b>⚠ Restore writes the DIDs below back to the module via UDS 0x2E.</b>{" "}
                  Connect to the adapter, then click Restore — you'll be asked to confirm via the Read-First check.
                </div>

                <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 8 }}>DID SNAPSHOT</div>
                <div style={{ maxHeight: 380, overflowY: "auto" }}>
                  {Object.entries(selectedData.dids).map(([did, data]) => (
                    <div key={did} style={{
                      padding: "8px 10px", borderBottom: "1px solid " + C.bd,
                      background: data.critical ? "#FFF8F0" : "#FAFAFA",
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: data.critical ? C.sr : C.tx }}>
                          {data.critical && "🔴 "}0x{hx(parseInt(did, 10), 4)} · {data.name}
                        </div>
                        {data.missing && <div style={{ fontSize: 9, color: C.er, fontWeight: 700 }}>NOT READABLE</div>}
                      </div>
                      {data.ascii && (
                        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a2, marginTop: 3, fontWeight: 700 }}>
                          "{data.ascii}"
                        </div>
                      )}
                      {data.hex && (
                        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tm, marginTop: 2, wordBreak: "break-all" }}>
                          {data.hex}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          ) : (
            <Card style={{ textAlign: "center", padding: 40, color: C.tm }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>👈</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ts }}>Select a backup to view details</div>
            </Card>
          )}
        </div>
      )}

      {modalOpen && selectedData && (
        <ReadFirstModal
          title={"Restore " + selectedData.module + " from backup"}
          subtitle={"Snapshot taken " + new Date(selectedData.timestamp).toLocaleString()}
          module={selectedData.module + "  (TX 0x" + hx(selectedData.tx, 3) + " / RX 0x" + hx(selectedData.rx, 3) + ")"}
          summary={
            "This will write " +
            Object.values(selectedData.dids).filter(d => d.bytes && d.bytes.length).length +
            " DIDs back to the live module via UDS 0x2E. The current module values will be overwritten."
          }
          details={
            <>
              {Object.entries(selectedData.dids).map(([did, data]) => (
                <div key={did} style={{ marginBottom: 4 }}>
                  0x{hx(parseInt(did, 10), 4)} · {data.name}
                  {data.ascii ? '  "' + data.ascii + '"' : data.hex ? "  " + data.hex : "  (empty)"}
                </div>
              ))}
            </>
          }
          destructiveLabel="RESTORE NOW"
          onConfirm={onConfirmRestore}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
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
