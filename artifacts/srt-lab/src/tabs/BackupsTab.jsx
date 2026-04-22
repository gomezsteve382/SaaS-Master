import React, { useState, useEffect, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";
import {
  getBackupList, getBackup, getBackupAsync, deleteBackup, clearBackups,
  restoreModule, subscribeAudit, refreshBackupsFromServer,
  getBackupStorageUsage, pruneNonCriticalBackups,
  subscribeToast, formatBytes, BACKUP_WARN_PERCENT,
  exportAllBackups, importBackups,
} from "../lib/audit.js";
import { sha256Hex, backupDidsToBytes } from "../lib/checksum.js";
import { createObdEngine } from "../lib/obdEngine.js";
import ReadFirstModal from "../lib/readFirstModal.jsx";
import {
  listDiffReports, getDiffReport, getDiffReportAsync,
  deleteDiffReport, clearDiffReports,
  subscribeDiffReports, exportDiffReportPDF, fmtScanStamp,
  refreshDiffReportsFromServer, fetchDiffReportStats, exportAllDiffReports,
} from "../lib/diffReports.js";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

export default function BackupsTab() {
  const [backups, setBackups] = useState(getBackupList());
  const [diffReports, setDiffReports] = useState(() => listDiffReports());
  const [diffStorageStats, setDiffStorageStats] = useState(null);
  const [diffBusy, setDiffBusy] = useState(null);
  const [exportAllBusy, setExportAllBusy] = useState(false);
  const [usage, setUsage] = useState(getBackupStorageUsage());
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedData, setSelectedData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [techFilter, setTechFilter] = useState(
    () => sessionStorage.getItem("backups_techFilter") || "all"
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [conn, setConn] = useState(false);
  const [restoreLog, setRestoreLog] = useState([]);
  const [verifyStates, setVerifyStates] = useState({});
  const [pairedData, setPairedData] = useState(null);
  const eng = useRef(null);
  const importInputRef = useRef(null);

  const handleVerify = useCallback(async (key, dids, storedChecksum) => {
    if (!storedChecksum) return;
    setVerifyStates(s => ({ ...s, [key]: "checking" }));
    try {
      const computed = await sha256Hex(backupDidsToBytes(dids));
      setVerifyStates(s => ({ ...s, [key]: computed === storedChecksum ? "pass" : "fail" }));
    } catch {
      setVerifyStates(s => ({ ...s, [key]: "fail" }));
    }
  }, []);

  const handleLoadPaired = useCallback(async (pairedKey) => {
    if (!pairedKey) return;
    setPairedData("loading");
    try {
      const paired = await getBackupAsync(pairedKey);
      setPairedData(paired || null);
    } catch { setPairedData(null); }
  }, []);

  const refresh = useCallback(() => {
    const list = getBackupList();
    setBackups(list);
    setUsage(getBackupStorageUsage());
    if (selected && !list.some(b => b.key === selected)) {
      setSelected(null); setSelectedData(null);
    }
  }, [selected]);

  /* Persist tech filter across tab unmounts and page refreshes. */
  useEffect(() => {
    if (techFilter === "all") {
      sessionStorage.removeItem("backups_techFilter");
    } else {
      sessionStorage.setItem("backups_techFilter", techFilter);
    }
  }, [techFilter]);

  /* Toast bus — surfaces save failures from any tab while Backups is open. */
  useEffect(() => {
    return subscribeToast((detail) => {
      setToast(detail);
      const id = setTimeout(() => {
        setToast((cur) => (cur && cur.ts === detail.ts ? null : cur));
      }, detail.durationMs || 6000);
      return () => clearTimeout(id);
    });
  }, []);

  const handlePrune = useCallback(() => {
    const r = pruneNonCriticalBackups();
    if (r.prunedCount === 0) {
      alert("No redundant snapshots to prune. Each backup is the latest for its module + VIN. Use 'Clear All' or delete entries individually if you need more space.");
    } else {
      alert("Pruned " + r.prunedCount + " redundant snapshot(s) — freed " + formatBytes(r.freedBytes) + ".");
    }
    refresh();
  }, [refresh]);

  const refreshFromServer = useCallback(() => {
    refreshBackupsFromServer().catch(() => {/* offline ok */});
    refreshDiffReportsFromServer()
      .then((list) => { if (Array.isArray(list)) setDiffReports(list); })
      .catch(() => {/* offline ok */});
    fetchDiffReportStats()
      .then((stats) => { if (stats) setDiffStorageStats(stats); })
      .catch(() => {/* offline ok */});
  }, []);

  // Pull from the database on mount + on every focus so backups and diff
  // reports created in another browser show up here too. Local cache +
  // audit events keep the UI snappy in between server hits.
  useEffect(() => {
    refreshFromServer();
    const onFocus = () => refreshFromServer();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFromServer]);

  // Auto-update + cross-tab notifications + 4s poll fallback.
  useEffect(() => {
    const unsub = subscribeAudit(refresh);
    const id = setInterval(refresh, 4000);
    return () => { unsub(); clearInterval(id); };
  }, [refresh]);

  // Saved diff reports — refreshed on storage events from any tab so a Save
  // Diff Report click in the J2534 Scanner shows up here without a reload.
  useEffect(() => {
    const refreshDiffs = () => setDiffReports(listDiffReports());
    refreshDiffs();
    const unsub = subscribeDiffReports(refreshDiffs);
    return () => unsub();
  }, []);

  const handleDownloadDiff = useCallback(async (id) => {
    // Try the local cache first for an instant download; fall back to a
    // server fetch when the row came from another browser and isn't cached
    // here yet. Only self-heal (drop the row) when the server CONFIRMS the
    // payload is gone — transient/offline failures must not delete the
    // canonical server record.
    setDiffBusy(id);
    let report = getDiffReport(id);
    if (!report) {
      let lookup = { status: "unknown", payload: null };
      try { lookup = await getDiffReportAsync(id); } catch { /* keep unknown */ }
      if (lookup.status === "missing") {
        deleteDiffReport(id);
        setDiffReports(listDiffReports());
        setDiffBusy(null);
        alert("This diff report is no longer available — its storage entry was removed.");
        return;
      }
      if (lookup.status !== "found") {
        setDiffBusy(null);
        alert("Could not load this diff report right now — check your connection and try again.");
        return;
      }
      report = lookup.payload;
    }
    try {
      await exportDiffReportPDF(report.baseline, report.current, report.diff);
    } catch (e) {
      alert("Could not rebuild diff report PDF: " + (e?.message || String(e)));
    } finally {
      setDiffBusy(null);
    }
  }, []);

  const handleDeleteDiff = useCallback((id) => {
    if (!window.confirm("Delete this saved diff report? This cannot be undone.")) return;
    deleteDiffReport(id);
    setDiffReports(listDiffReports());
  }, []);

  const handleClearAllDiffs = useCallback(() => {
    if (!diffReports.length) return;
    if (!window.confirm("Delete ALL " + diffReports.length + " saved diff reports? This cannot be undone.")) return;
    clearDiffReports();
    setDiffReports(listDiffReports());
  }, [diffReports.length]);

  const handleExportAllDiffs = useCallback(async () => {
    if (!diffReports.length || exportAllBusy) return;
    setExportAllBusy(true);
    try {
      const { exported, missing } = await exportAllDiffReports();
      if (missing.length) {
        alert(`Exported ${exported} report${exported === 1 ? "" : "s"}. ${missing.length} report${missing.length === 1 ? " was" : "s were"} no longer available on the server and skipped.`);
      }
    } catch (e) {
      alert("Export failed: " + (e?.message || String(e)));
    } finally {
      setExportAllBusy(false);
    }
  }, [diffReports.length, exportAllBusy]);

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

  const loadBackup = useCallback(async (key) => {
    setSelected(key);
    setSelectedData(null);
    setPairedData(null);
    const data = await getBackupAsync(key);
    setSelectedData(data);
  }, []);

  // Deep-link via window event "srtlab:backupSelect" — auto-select a key
  // dropped into localStorage by anything that wants to open a backup here.
  useEffect(() => {
    const consume = () => {
      try {
        const key = localStorage.getItem("srtlab_pending_backup_select");
        if (!key) return;
        localStorage.removeItem("srtlab_pending_backup_select");
        const data = getBackup(key);
        if (data) {
          setSelected(key);
          setSelectedData(data);
          addRestoreLog("Loaded backup from deep-link: " + key, "info");
        }
      } catch {/* ignore */}
    };
    consume();
    window.addEventListener("srtlab:backupSelect", consume);
    return () => window.removeEventListener("srtlab:backupSelect", consume);
  }, [addRestoreLog]);

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

  const handleExportAll = useCallback(() => {
    const archive = exportAllBackups();
    if (archive.count === 0) {
      alert("No backups to export.");
      return;
    }
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = "srtlab_backups_archive_" + stamp + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      const r = importBackups(archive);
      refresh();
      const parts = [r.imported + " imported", r.skipped + " skipped (duplicate)"];
      if (r.invalid > 0) parts.push(r.invalid + " invalid");
      alert("Backup import complete: " + parts.join(", ") + ".");
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  }, [refresh]);

  const downloadBackup = useCallback(async (key) => {
    const data = await getBackupAsync(key); if (!data) return;
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
      const ok = await eng.current.connect();
      if (!ok) { eng.current = null; return; }
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

  const onConfirmRestore = useCallback(async (meta = {}) => {
    setModalOpen(false);
    if (!eng.current || !selectedData) return;
    void meta;
    setBusy("Restoring...");
    try {
      await restoreModule(
        eng.current.uds,
        selectedData.tx, selectedData.rx,
        selectedData, addRestoreLog, true,
      );
    } catch (e) {
      addRestoreLog("Restore exception: " + e.message, "error");
    } finally { setBusy(""); }
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
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ fontSize: 11, padding: "6px 12px", background: "rgba(255,255,255,0.15)", borderRadius: 8 }}>
              {backups.length} backup{backups.length === 1 ? "" : "s"}
            </div>
            <div data-testid="backup-storage-usage" style={{ fontSize: 10, padding: "4px 10px", background: "rgba(0,0,0,0.25)", borderRadius: 6, fontFamily: "'JetBrains Mono'", letterSpacing: 0.5 }}>
              {formatBytes(usage.used)} / {formatBytes(usage.max)} ({usage.percent}%)
            </div>
            <div style={{ width: 160, height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                width: usage.percent + "%", height: "100%",
                background: usage.percent >= 90 ? "#FF5252"
                  : usage.percent >= BACKUP_WARN_PERCENT ? "#FFB300" : "#00E676",
                transition: "all 0.3s",
              }} />
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10 }}>
          Every write operation automatically creates a snapshot of all critical DIDs.
          If a write goes wrong, restore from here. Max 50 backups kept (auto-rotates).
        </div>
      </Card>

      {usage.percent >= BACKUP_WARN_PERCENT && (
        <Card data-testid="backup-quota-warning" style={{
          marginBottom: 14, padding: 14,
          background: usage.percent >= 90 ? "#FFEBEE" : "#FFF8E1",
          border: "1.5px solid " + (usage.percent >= 90 ? "#FF5252" : "#FFB300"),
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 24 }}>{usage.percent >= 90 ? "🚨" : "⚠️"}</div>
            <div style={{ flex: 1, fontSize: 12, color: C.ts, lineHeight: 1.5 }}>
              <b>Backup storage is {usage.percent}% full</b> ({formatBytes(usage.used)} of {formatBytes(usage.max)}).
              {usage.percent >= 90
                ? " The next backup may fail or silently drop the audit index. Free space now."
                : " Approaching the browser's localStorage cap — older snapshots will start to be auto-pruned."}
            </div>
            <Btn onClick={handlePrune} color={usage.percent >= 90 ? C.er : C.wn}>
              🧹 Prune older duplicates
            </Btn>
          </div>
        </Card>
      )}

      {toast && (
        <Card data-testid="backup-toast" style={{
          marginBottom: 14, padding: 12,
          background: toast.type === "error" ? "#FFEBEE" : toast.type === "warn" ? "#FFF8E1" : "#E8F5E9",
          border: "1.5px solid " + (toast.type === "error" ? "#FF5252" : toast.type === "warn" ? "#FFB300" : "#00E676"),
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 18 }}>
              {toast.type === "error" ? "✗" : toast.type === "warn" ? "⚠" : "✓"}
            </div>
            <div style={{ flex: 1, fontSize: 12, color: C.ts, lineHeight: 1.5 }}>{toast.message}</div>
            <button onClick={() => setToast(null)} style={{
              border: "none", background: "transparent", cursor: "pointer",
              fontSize: 16, color: C.tm, padding: "0 6px",
            }}>×</button>
          </div>
        </Card>
      )}

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2 }}>MODULE:</div>
          <button onClick={() => setFilter("all")} style={pill(filter === "all", C.a2)}>All ({backups.length})</button>
          {Object.entries(moduleCounts).map(([m, n]) => (
            <button key={m} onClick={() => setFilter(m)} style={pill(filter === m, C.a2)}>{m} ({n})</button>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Btn onClick={handleConnect} color={conn ? C.gn : C.a3} outline>
              {busy === "Connecting..." ? "..." : (conn ? "🔌 Disconnect" : "🔌 Connect Adapter")}
            </Btn>
            <Btn onClick={refreshFromServer} color={C.a3} outline>🔄 Refresh</Btn>
            {backups.length > 0 && (
              <Btn onClick={handleExportAll} color={C.a2} outline data-testid="export-all-backups">
                📦 Export All
              </Btn>
            )}
            <Btn onClick={handleImportClick} color={C.a2} outline data-testid="import-backups">
              📥 Import
            </Btn>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportFile}
              style={{ display: "none" }}
              data-testid="import-backups-input"
            />
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

      <Card style={{ marginBottom: 14, padding: 0, overflow: "hidden" }} data-testid="diff-reports-history">
        <div style={{
          ...listHeader,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <span>📊 SAVED DIFF REPORTS ({diffReports.length})</span>
          {diffReports.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={handleExportAllDiffs}
                disabled={exportAllBusy}
                data-testid="diff-reports-export-all"
                style={{
                  padding: "4px 10px", fontSize: 10, fontWeight: 800,
                  color: exportAllBusy ? C.tm : C.a2, background: "transparent",
                  border: "1px solid " + (exportAllBusy ? C.bd : C.a2), borderRadius: 4,
                  cursor: exportAllBusy ? "wait" : "pointer", letterSpacing: 1,
                }}
                title="Download all saved diff reports as a JSON archive"
              >
                {exportAllBusy ? "⏳ EXPORTING…" : "⬇ EXPORT ALL"}
              </button>
              <button
                onClick={handleClearAllDiffs}
                data-testid="diff-reports-clear-all"
                style={{
                  padding: "4px 10px", fontSize: 10, fontWeight: 800,
                  color: C.er, background: "transparent",
                  border: "1px solid " + C.bd, borderRadius: 4,
                  cursor: "pointer", letterSpacing: 1,
                }}
                title="Delete every saved diff report"
              >
                🗑 CLEAR ALL
              </button>
            </div>
          )}
        </div>
        {diffReports.length > 0 && (() => {
          const KEEP = 500;
          const WARN_AGE_MS = 150 * 24 * 60 * 60 * 1000;
          const now = Date.now();
          const sorted = [...diffReports].sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0));
          const oldest = sorted[0];
          const oldestMs = oldest?.generatedAt ?? null;
          const oldestDate = oldestMs ? new Date(oldestMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
          const expiringSoon = oldestMs !== null && (now - oldestMs) >= WARN_AGE_MS;
          const daysOld = oldestMs !== null ? Math.floor((now - oldestMs) / (24 * 60 * 60 * 1000)) : null;
          const daysLeft = daysOld !== null ? 180 - daysOld : null;
          const nearCap = diffReports.length >= Math.floor(KEEP * 0.9);
          return (
            <div
              data-testid="diff-reports-status-bar"
              style={{
                display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10,
                padding: "7px 16px", borderBottom: "1px solid " + C.bd,
                background: expiringSoon || nearCap ? "rgba(245,124,0,0.07)" : "rgba(0,0,0,0.03)",
                fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'",
              }}
            >
              <span data-testid="diff-reports-count-status" style={{ color: C.ts }}>
                {diffReports.length} / {KEEP} reports
              </span>
              {diffStorageStats && (
                <span data-testid="diff-reports-storage-size" style={{ color: C.ts }}>
                  ~{formatBytes(diffStorageStats.totalBytes)} / ~{formatBytes(diffStorageStats.capBytes)} cap
                </span>
              )}
              {oldestDate && (
                <span data-testid="diff-reports-oldest">
                  oldest: <span style={{ color: C.tx }}>{oldestDate}</span>
                </span>
              )}
              <span style={{ color: C.tm, opacity: 0.5 }}>·</span>
              <span style={{ color: C.tm }}>auto-pruned after 180 days</span>
              {expiringSoon && daysLeft !== null && (
                <span
                  data-testid="diff-reports-expiry-warning"
                  style={{
                    marginLeft: 4, padding: "2px 8px", borderRadius: 4,
                    background: daysLeft <= 7 ? "rgba(198,40,40,0.15)" : "rgba(245,124,0,0.15)",
                    color: daysLeft <= 7 ? "#ff7676" : "#F57C00",
                    fontWeight: 800, letterSpacing: 0.5,
                  }}
                  title={"Oldest report was saved " + daysOld + " days ago and will be pruned in " + daysLeft + " day(s). Export it before then if you need to keep it."}
                >
                  ⚠ oldest expires in {daysLeft}d — export to keep
                </span>
              )}
              {nearCap && (
                <span
                  data-testid="diff-reports-cap-warning"
                  style={{
                    marginLeft: 4, padding: "2px 8px", borderRadius: 4,
                    background: "rgba(245,124,0,0.15)", color: "#F57C00",
                    fontWeight: 800, letterSpacing: 0.5,
                  }}
                  title={"You have " + diffReports.length + " of " + KEEP + " reports. Older reports will be pruned when the cap is reached."}
                >
                  ⚠ near storage cap
                </span>
              )}
            </div>
          );
        })()}
        {diffReports.length === 0 ? (
          <div style={{ padding: 20, color: C.tm, fontSize: 12, lineHeight: 1.6 }}>
            No saved diff reports yet. Generate one from the J2534 Scanner —
            click <b>📌 Save Baseline</b>, scan again, then <b>🔀 Compare to Baseline</b>
            and use <b>📄 Save Diff Report</b>. Every report you save shows up
            here so you can re-download it without re-scanning.
          </div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: "auto" }} data-testid="diff-reports-list">
            {diffReports.map((r) => {
              const changeTotal = r.addedCount + r.removedCount + r.changedCount;
              return (
                <div
                  key={r.id}
                  data-testid={"diff-report-row-" + r.id}
                  style={{
                    padding: "12px 16px", borderBottom: "1px solid " + C.bd,
                    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 800, fontSize: 12, color: C.tx }}>
                      {r.baselineLabel}
                    </div>
                    <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", marginTop: 2 }}>
                      generated {fmtScanStamp(r.generatedAt)}
                    </div>
                    <div style={{ fontSize: 10, color: C.ts, marginTop: 4 }}>
                      baseline {fmtScanStamp(r.baselineTs) || "(unknown)"} · {r.baselineModuleCount} mod
                      {" → "}
                      current {fmtScanStamp(r.currentTs) || "(unsaved)"} · {r.currentModuleCount} mod
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, fontSize: 10, fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>
                    {r.addedCount > 0 && <span style={diffBadge("#2E7D32")}>+{r.addedCount}</span>}
                    {r.removedCount > 0 && <span style={diffBadge("#C62828")}>−{r.removedCount}</span>}
                    {r.changedCount > 0 && <span style={diffBadge("#F57C00")}>±{r.changedCount}</span>}
                    {changeTotal === 0 && <span style={diffBadge("#546E7A")}>no changes</span>}
                    {r.sameCount > 0 && (
                      <span style={{ ...diffBadge("#90A4AE"), opacity: 0.6 }}>
                        ={r.sameCount}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => handleDownloadDiff(r.id)}
                      disabled={diffBusy === r.id}
                      data-testid={"diff-report-download-" + r.id}
                      style={{
                        padding: "6px 12px", fontSize: 11, fontWeight: 800,
                        color: "#fff", background: diffBusy === r.id ? "#546E7A" : C.a2,
                        border: "none", borderRadius: 4,
                        cursor: diffBusy === r.id ? "wait" : "pointer", letterSpacing: 0.5,
                      }}
                      title="Rebuild and download this diff report as a PDF"
                    >
                      {diffBusy === r.id ? "… BUILDING" : "⬇ DOWNLOAD PDF"}
                    </button>
                    <button
                      onClick={() => handleDeleteDiff(r.id)}
                      data-testid={"diff-report-delete-" + r.id}
                      style={{
                        padding: "6px 10px", fontSize: 11, fontWeight: 800,
                        color: C.er, background: "transparent",
                        border: "1px solid " + C.bd, borderRadius: 4, cursor: "pointer",
                      }}
                      title="Delete this saved diff report"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              );
            })}
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
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ fontWeight: 800, fontSize: 13, color: isSel ? C.a2 : C.tx }}>{b.module}</div>
                        {b.snapshotKind && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "1px 5px", borderRadius: 3,
                            background: b.snapshotKind === "post-write" ? "#1E6F3A22" : "#3A1E6F22",
                            color: b.snapshotKind === "post-write" ? "#1E6F3A" : "#3A1E6F",
                          }}>
                            {b.snapshotKind === "post-write" ? "POST" : "PRE"}
                          </span>
                        )}
                      </div>
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
                  {selectedData.snapshotKind && (<>
                    <span style={{ color: C.ts }}>Snapshot:</span>
                    <span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "2px 7px", borderRadius: 3,
                        background: selectedData.snapshotKind === "post-write" ? "#1E6F3A22" : "#3A1E6F22",
                        color: selectedData.snapshotKind === "post-write" ? "#1E6F3A" : "#3A1E6F",
                      }}>
                        {selectedData.snapshotKind === "post-write" ? "POST-WRITE" : "PRE-WRITE"}
                      </span>
                    </span>
                  </>)}
                  {selectedData.checksum && (<>
                    <span style={{ color: C.ts }}>SHA-256:</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{selectedData.checksum.slice(0, 16)}…</span>
                      <button onClick={() => navigator.clipboard?.writeText(selectedData.checksum)} style={{
                        fontSize: 9, padding: "1px 6px", borderRadius: 3, border: "1px solid " + C.bd,
                        background: "#f5f5f5", cursor: "pointer", color: C.ts,
                      }}>Copy</button>
                      <button
                        disabled={verifyStates[selected] === "checking"}
                        onClick={() => handleVerify(selected, selectedData.dids, selectedData.checksum)}
                        style={{
                          fontSize: 9, padding: "1px 6px", borderRadius: 3, border: "1px solid",
                          cursor: "pointer", fontWeight: 700,
                          borderColor: verifyStates[selected] === "pass" ? "#1E6F3A" : verifyStates[selected] === "fail" ? "#CC0000" : C.bd,
                          background: verifyStates[selected] === "pass" ? "#e6f9ed" : verifyStates[selected] === "fail" ? "#FFE6E6" : "#f5f5f5",
                          color: verifyStates[selected] === "pass" ? "#1E6F3A" : verifyStates[selected] === "fail" ? "#CC0000" : C.ts,
                        }}
                      >
                        {verifyStates[selected] === "checking" ? "…" : verifyStates[selected] === "pass" ? "✓ PASS" : verifyStates[selected] === "fail" ? "✗ FAIL" : "Verify"}
                      </button>
                    </span>
                  </>)}
                  {(() => {
                    const isPost = selectedData.snapshotKind === "post-write";
                    const isPre = selectedData.snapshotKind === "pre-write";
                    const postMatch = isPre ? backups.find(b => b.preWriteKey === selected && b.snapshotKind === "post-write") : null;
                    const pairedKey = isPost ? selectedData.preWriteKey : postMatch?.key;
                    if (!pairedKey) return null;
                    const pairLabel = isPost ? "Compare PRE → POST" : "Compare PRE → POST";
                    return (<>
                      <span style={{ color: C.ts }}>Pair:</span>
                      <span style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => handleLoadPaired(pairedKey)} style={{
                          fontSize: 9, padding: "1px 7px", borderRadius: 3, border: "1px solid " + C.a2,
                          background: pairedData ? "#e6f9ed" : "#f5f5f5", cursor: "pointer", color: C.a2, fontWeight: 700,
                        }}>{pairedData === "loading" ? "…" : pairLabel}</button>
                        {isPost && <button onClick={() => loadBackup(selectedData.preWriteKey)} style={{
                          fontSize: 9, padding: "1px 6px", borderRadius: 3, border: "1px solid " + C.bd,
                          background: "#f5f5f5", cursor: "pointer", color: C.ts,
                        }}>← View PRE</button>}
                        {isPre && postMatch && <button onClick={() => loadBackup(postMatch.key)} style={{
                          fontSize: 9, padding: "1px 6px", borderRadius: 3, border: "1px solid " + C.bd,
                          background: "#f5f5f5", cursor: "pointer", color: C.ts,
                        }}>View POST →</button>}
                      </span>
                    </>);
                  })()}
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

                {pairedData && pairedData !== "loading" && (() => {
                  const preSnap = selectedData.snapshotKind === "pre-write" ? selectedData : pairedData;
                  const postSnap = selectedData.snapshotKind === "post-write" ? selectedData : pairedData;
                  const allDids = new Set([...Object.keys(preSnap.dids || {}), ...Object.keys(postSnap.dids || {})]);
                  const rows = [];
                  allDids.forEach(did => {
                    const before = preSnap.dids?.[did];
                    const after = postSnap.dids?.[did];
                    const changed = (before?.hex || "") !== (after?.hex || "");
                    rows.push({ did, before, after, changed });
                  });
                  const changedRows = rows.filter(r => r.changed);
                  const unchangedRows = rows.filter(r => !r.changed);
                  return (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                        <span>PRE → POST DIFF</span>
                        <span style={{ fontWeight: 400, color: C.tm }}>{changedRows.length} changed · {unchangedRows.length} unchanged</span>
                      </div>
                      {changedRows.length === 0 && (
                        <div style={{ fontSize: 11, color: C.a2, padding: "8px 10px", background: "#e6f9ed", borderRadius: 4 }}>
                          No DID values changed between snapshots.
                        </div>
                      )}
                      {changedRows.map(({ did, before, after }) => (
                        <div key={did} style={{ padding: "6px 10px", marginBottom: 4, borderRadius: 4, border: "1px solid #f0c060", background: "#FFFBF0" }}>
                          <div style={{ fontSize: 10, fontWeight: 800, color: C.tx, marginBottom: 4 }}>
                            0x{hx(parseInt(did, 10), 4)} · {before?.name || after?.name}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                            <div>
                              <div style={{ fontSize: 8, fontWeight: 700, color: "#CC0000", letterSpacing: 1, marginBottom: 2 }}>BEFORE</div>
                              {before?.ascii && <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#CC0000" }}>"{before.ascii}"</div>}
                              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#CC0000", wordBreak: "break-all" }}>{before?.hex || "(missing)"}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 8, fontWeight: 700, color: "#1E6F3A", letterSpacing: 1, marginBottom: 2 }}>AFTER</div>
                              {after?.ascii && <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#1E6F3A" }}>"{after.ascii}"</div>}
                              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#1E6F3A", wordBreak: "break-all" }}>{after?.hex || "(missing)"}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
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

const diffBadge = (color) => ({
  padding: "2px 8px",
  border: "1px solid " + color + "55",
  borderRadius: 999,
  background: color + "10",
  color: color,
  fontSize: 10,
  letterSpacing: 0.5,
});

const listHeader = {
  padding: "12px 16px", background: "#F8F6F2", fontSize: 11, fontWeight: 800,
  color: C.ts, letterSpacing: 2, borderBottom: "1px solid " + C.bd,
};

const chip = (bg, color, border = "rgba(255,255,255,0.3)") => ({
  padding: "6px 12px", fontSize: 11, fontWeight: 800, borderRadius: 6,
  border: "1px solid " + border, background: bg, color, cursor: "pointer",
});
