import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn } from "../lib/ui.jsx";
import AnalysisDiffView from "./AnalysisDiffView.jsx";
import { compareAnalyses } from "../lib/analysisDiff.js";
import {
  getBackupList, getBackup, getBackupAsync, deleteBackup, clearBackups,
  restoreModule, subscribeAudit, refreshBackupsFromServer,
  getBackupStorageUsage, pruneNonCriticalBackups,
  subscribeToast, formatBytes, BACKUP_WARN_PERCENT,
  exportAllBackups, importBackups, saveAemtPlaceholders,
  encryptArchive, decryptArchive, ENCRYPTED_ARCHIVE_TYPE,
  backupCorruptFill,
} from "../lib/audit.js";
import { sha256Hex, backupDidsToBytes } from "../lib/checksum.js";
import { detectCorruptFill, corruptFillError } from "../lib/parseModule.js";
import { createObdEngine } from "../lib/obdEngine.js";
import ReadFirstModal from "../lib/readFirstModal.jsx";
import LeakScanPanel from "../components/LeakScanPanel.jsx";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";
import { importAemtBundle, AemtImportError } from "../lib/aemtImporter.js";
import { saveRawPreset } from "../lib/keyProgPresets.js";
import AemtImportModal from "../components/AemtImportModal.jsx";
import {getDidDescription} from "../lib/dids.js";
import {
  listDiffReports, getDiffReport, getDiffReportAsync,
  deleteDiffReport, clearDiffReports,
  subscribeDiffReports, exportDiffReportPDF, fmtScanStamp,
  refreshDiffReportsFromServer, fetchDiffReportStats, exportAllDiffReports,
  importDiffReports,
} from "../lib/diffReports.js";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

// Task #946 — corrupt-fill guard for the Backups tab upload paths.
// Scans the raw .bin module dumps in an AEMT bundle (the only binary
// captures that get persisted as backups) and returns the first
// tool-error capture found, or null when every dump looks clean.
// Keeps a corrupt file from being silently stored as a backup and later
// re-loaded into a real module slot without the guard re-running.
function firstCorruptBin(rawFiles) {
  for (const f of rawFiles || []) {
    if (!f?.name || !f.name.toLowerCase().endsWith(".bin")) continue;
    const cf = detectCorruptFill(f.data);
    if (cf) return { name: f.name, cf };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ChecksumScanPanel — binary firmware checksum scanner + repair
// Accepts a raw .bin file upload; calls /api/tools/checksum-scan and
// /api/tools/fix-checksum + /api/tools/eeprom-map from the re-bridge.
// ---------------------------------------------------------------------------
function ChecksumScanPanel() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [fileB64, setFileB64] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [eepmBusy, setEepmBusy] = useState(false);
  const [fixBusy, setFixBusy] = useState({});
  const [scanResult, setScanResult] = useState(null);
  const [eepmResult, setEepmResult] = useState(null);
  const [msg, setMsg] = useState("");
  const fileInputRef = useRef(null);

  const loadFile = useCallback((f) => {
    if (!f) return;
    setFile(f);
    setScanResult(null);
    setEepmResult(null);
    setMsg("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = new Uint8Array(e.target.result);
      let b64 = "";
      const CHUNK = 8192;
      for (let i = 0; i < buf.length; i += CHUNK) {
        b64 += String.fromCharCode(...buf.slice(i, i + CHUNK));
      }
      setFileB64(btoa(b64));
      setMsg(`Loaded ${f.name} — ${buf.length.toLocaleString()} bytes`);
    };
    reader.readAsArrayBuffer(f);
  }, []);

  const handleScan = useCallback(async () => {
    if (!fileB64) return;
    setScanBusy(true);
    setScanResult(null);
    setMsg("Scanning…");
    try {
      const r = await fetch("/api/tools/checksum-scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileB64 }),
      });
      const j = await r.json();
      setScanResult(j);
      setMsg(j.ok ? `Found ${j.found ?? 0} checksum(s)` : ("Error: " + (j.error ?? "unknown")));
    } catch (e) {
      setMsg("Request failed: " + e.message);
    }
    setScanBusy(false);
  }, [fileB64]);

  const handleEepmap = useCallback(async () => {
    if (!fileB64) return;
    setEepmBusy(true);
    setEepmResult(null);
    setMsg("Mapping EEPROM…");
    try {
      const r = await fetch("/api/tools/eeprom-map", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileB64 }),
      });
      const j = await r.json();
      setEepmResult(j);
      setMsg(j.ok ? `Found ${j.vin_candidates?.length ?? 0} VIN candidate(s), ${j.mirrored_blocks?.length ?? 0} mirror(s)` : ("Error: " + (j.error ?? "unknown")));
    } catch (e) {
      setMsg("Request failed: " + e.message);
    }
    setEepmBusy(false);
  }, [fileB64]);

  const handleFix = useCallback(async (offset, algorithm) => {
    if (!fileB64) return;
    const key = `${offset}:${algorithm}`;
    setFixBusy(b => ({ ...b, [key]: true }));
    setMsg(`Repairing ${algorithm} at ${offset}…`);
    try {
      const r = await fetch("/api/tools/fix-checksum", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileB64, offset, algorithm }),
      });
      const j = await r.json();
      if (j.ok && j.patchedB64) {
        const bin = Uint8Array.from(atob(j.patchedB64), c => c.charCodeAt(0));
        const blob = new Blob([bin], { type: "application/octet-stream" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (file?.name ?? "patched").replace(/\.bin$/i, "") + "_repaired.bin";
        a.click();
        setMsg(`Repaired ${algorithm} at ${offset} — downloaded ${j.patchedSize?.toLocaleString()} bytes`);
      } else {
        setMsg("Repair failed: " + (j.error ?? "unknown"));
      }
    } catch (e) {
      setMsg("Request failed: " + e.message);
    }
    setFixBusy(b => { const n = { ...b }; delete n[key]; return n; });
  }, [fileB64, file]);

  const panelBorder = "1px solid " + C.bd;

  return (
    <div style={{ marginTop: 20, marginBottom: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", textAlign: "left", padding: "10px 16px",
          background: "#F4F1EC", border: panelBorder, borderRadius: open ? "8px 8px 0 0" : 8,
          cursor: "pointer", display: "flex", alignItems: "center", gap: 10, userSelect: "none",
        }}
      >
        <span style={{ fontFamily: "'Righteous'", fontSize: 13, letterSpacing: 1, color: C.a1 }}>
          BINARY CHECKSUM SCAN
        </span>
        <span style={{ fontSize: 11, color: C.ts, flex: 1 }}>
          Find + repair stored checksums in raw module dump files
        </span>
        <span style={{ fontSize: 11, color: C.ts }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          border: panelBorder, borderTop: "none", borderRadius: "0 0 8px 8px",
          background: "#FAFAF8", padding: 16,
        }}>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
            Upload a raw <b>.bin</b> module dump. The scanner tries CRC-32, CRC-16/CCITT, sum16, sum32, sum8, xor32
            at sampled positions to locate stored checksums that validate their own prefix.
            Click <b>Repair</b> on any broken checksum to download a corrected binary.
          </div>

          {/* File picker */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                fontSize: 11, fontWeight: 800, padding: "6px 14px", borderRadius: 6,
                border: "1px solid " + C.a1, background: "#fff", color: C.a1, cursor: "pointer",
              }}
            >
              Choose .bin
            </button>
            <input ref={fileInputRef} type="file" accept=".bin,.hex,.srec,.rom"
              style={{ display: "none" }} onChange={e => loadFile(e.target.files?.[0])} />
            {file && (
              <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", color: C.ts }}>
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <Btn onClick={handleScan} disabled={!fileB64 || scanBusy} color={C.a1}>
              {scanBusy ? "⏳ Scanning…" : "Scan Checksums"}
            </Btn>
            <Btn onClick={handleEepmap} disabled={!fileB64 || eepmBusy} color={C.a2} outline>
              {eepmBusy ? "⏳ Mapping…" : "EEPROM Map"}
            </Btn>
          </div>

          {/* Status message */}
          {msg && (
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, fontFamily: "'JetBrains Mono'" }}>
              {msg}
            </div>
          )}

          {/* Scan results */}
          {scanResult?.ok && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: C.ts, marginBottom: 6 }}>
                CHECKSUM SCAN RESULTS — {file?.name} — {scanResult.whole_file?.size?.toLocaleString()} bytes
              </div>
              {/* Whole-file stats */}
              <div style={{
                fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts,
                background: "#F4F1EC", borderRadius: 4, padding: "6px 10px", marginBottom: 8,
                display: "flex", gap: 16, flexWrap: "wrap",
              }}>
                {Object.entries(scanResult.whole_file ?? {}).filter(([k]) => k !== "size").map(([k, v]) => (
                  <span key={k}><b style={{ color: "#333" }}>{k}:</b> {String(v)}</span>
                ))}
              </div>
              {scanResult.checksums?.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "#F4F1EC" }}>
                      {["Offset", "Algorithm", "Stored", "Computed", "Covers", "Status", ""].map(h => (
                        <th key={h} style={{ padding: "5px 10px", textAlign: "left", fontSize: 10,
                          fontWeight: 800, letterSpacing: 1, color: C.ts, borderBottom: "1px solid " + C.bd }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scanResult.checksums.map((ck, i) => {
                      const isValid = ck.status === "valid";
                      const fixKey = `${ck.offset}:${ck.algorithm}`;
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAF8" }}>
                          <td style={{ padding: "5px 10px", fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{ck.offset}</td>
                          <td style={{ padding: "5px 10px", fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{ck.algorithm}</td>
                          <td style={{ padding: "5px 10px", fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{ck.stored}</td>
                          <td style={{ padding: "5px 10px", fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{ck.computed}</td>
                          <td style={{ padding: "5px 10px", fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts }}>{ck.covers}</td>
                          <td style={{ padding: "5px 10px" }}>
                            <span style={{
                              fontSize: 10, fontWeight: 800, padding: "1px 6px", borderRadius: 3,
                              background: isValid ? "#e6f9ed" : "#FFE6E6",
                              color: isValid ? "#1E6F3A" : "#C00",
                              border: `1px solid ${isValid ? "#1E6F3A44" : "#C0000044"}`,
                            }}>
                              {isValid ? "✓ VALID" : "✗ BROKEN"}
                            </span>
                          </td>
                          <td style={{ padding: "5px 10px" }}>
                            {!isValid && (
                              <button
                                disabled={!!fixBusy[fixKey]}
                                onClick={() => handleFix(ck.offset, ck.algorithm)}
                                style={{
                                  fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4,
                                  border: "1px solid " + C.a1, background: "#fff", color: C.a1,
                                  cursor: fixBusy[fixKey] ? "not-allowed" : "pointer",
                                }}
                              >
                                {fixBusy[fixKey] ? "…" : "Repair"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: 11, color: C.ts, padding: "10px 0" }}>
                  No self-validating checksums found at sampled offsets.
                  The stored checksum may cover a non-prefix region, or use a non-standard algorithm.
                </div>
              )}
              {scanResult.note && (
                <div style={{ fontSize: 10, color: C.ts, marginTop: 8, lineHeight: 1.5 }}>{scanResult.note}</div>
              )}
            </div>
          )}

          {/* EEPROM map results */}
          {eepmResult?.ok && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: C.ts, marginBottom: 8 }}>
                EEPROM MAP — {eepmResult.vin_candidates?.length ?? 0} VIN(s) · {eepmResult.strings?.length ?? 0} string(s) · {eepmResult.mirrored_blocks?.length ?? 0} mirror(s)
              </div>
              {eepmResult.vin_candidates?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>VIN CANDIDATES</div>
                  {eepmResult.vin_candidates.map((v, i) => (
                    <div key={i} style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", marginBottom: 2 }}>
                      <span style={{ color: C.ts, marginRight: 10 }}>{v.offset}</span>
                      <span style={{ color: C.a1, fontWeight: 700 }}>{v.vin}</span>
                    </div>
                  ))}
                </div>
              )}
              {eepmResult.mirrored_blocks?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>MIRRORED 16-BYTE BLOCKS (SEC16 redundancy candidates)</div>
                  {eepmResult.mirrored_blocks.map((m, i) => (
                    <div key={i} style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", marginBottom: 2, color: C.ts }}>
                      {m.first_offset} ↔ {m.mirror_offset} (gap {m.gap})
                      <span style={{ color: C.a2, marginLeft: 8 }}>{m.hex}</span>
                    </div>
                  ))}
                </div>
              )}
              {eepmResult.note && (
                <div style={{ fontSize: 10, color: C.ts, lineHeight: 1.5 }}>{eepmResult.note}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [restoreCorrupt, setRestoreCorrupt] = useState(null);
  const [verifyStates, setVerifyStates] = useState({});
  const [pairedData, setPairedData] = useState(null);
  const [aemtModal, setAemtModal] = useState(null);
  const [aemtBusy, setAemtBusy] = useState(false);
  const [exportDialog, setExportDialog] = useState(null);
  const [importPassphraseDialog, setImportPassphraseDialog] = useState(null);
  const [diffSelection, setDiffSelection] = useState(new Set());
  const [diffView, setDiffView] = useState(null);
  const eng = useRef(null);
  const importInputRef = useRef(null);
  const diffImportInputRef = useRef(null);
  const aemtImportInputRef = useRef(null);
  /* Pending VIN resolution for the AEMT vin-prompt flow. */
  const aemtVinResolveRef = useRef(null);

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

  const handleImportDiffsClick = useCallback(() => {
    diffImportInputRef.current?.click();
  }, []);

  const handleImportDiffsFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      const r = await importDiffReports(archive);
      setDiffReports(listDiffReports());
      const parts = [r.imported + " imported", r.skipped + " skipped (duplicate)"];
      if (r.invalid > 0) parts.push(r.invalid + " invalid");
      alert("Diff report import complete: " + parts.join(", ") + ".");
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  }, []);

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
    setRestoreCorrupt(null);
    const data = await getBackupAsync(key);
    setSelectedData(data);
    // Auto-load the paired snapshot so the diff section appears immediately.
    if (data) {
      const isPost = data.snapshotKind === "post-write";
      const isPre = data.snapshotKind === "pre-write";
      let pairedKey = null;
      if (isPost && data.preWriteKey) {
        pairedKey = data.preWriteKey;
      } else if (isPre) {
        const list = getBackupList();
        const match = list.find(b => b.preWriteKey === key && b.snapshotKind === "post-write");
        pairedKey = match?.key ?? null;
      }
      if (pairedKey) {
        setPairedData("loading");
        try {
          const paired = await getBackupAsync(pairedKey);
          setPairedData(paired || null);
        } catch { setPairedData(null); }
      }
    }
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

  const handleToggleDiffSelect = useCallback((key, e) => {
    e.stopPropagation();
    setDiffSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < 2) {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleLaunchDiff = useCallback(async () => {
    const keys = Array.from(diffSelection);
    if (keys.length !== 2) return;
    const [dataA, dataB] = await Promise.all([
      getBackupAsync(keys[0]),
      getBackupAsync(keys[1]),
    ]);
    if (!dataA || !dataB) {
      alert("Could not load one or both selected backups.");
      return;
    }
    const result = compareAnalyses(dataA, dataB);
    setDiffView({ result, backupA: dataA, backupB: dataB });
  }, [diffSelection]);

  const handleDelete = useCallback((key) => {
    if (!window.confirm("Delete this backup? Cannot be undone.")) return;
    deleteBackup(key);
    if (selected === key) { setSelected(null); setSelectedData(null); }
    setDiffSelection((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    refresh();
  }, [selected, refresh]);

  const handleClearAll = useCallback(() => {
    if (!window.confirm("Delete ALL " + backups.length + " backups? Cannot be undone.")) return;
    clearBackups();
    setSelected(null); setSelectedData(null);
    setDiffSelection(new Set());
    refresh();
  }, [backups.length, refresh]);

  const handleExportAll = useCallback(() => {
    const archive = exportAllBackups();
    if (archive.count === 0) {
      alert("No backups to export.");
      return;
    }
    setExportDialog({ archive, passphrase: "", confirm: "", busy: false, error: "" });
  }, []);

  const handleExportDialogConfirm = useCallback(async () => {
    if (!exportDialog) return;
    const { archive, passphrase, confirm } = exportDialog;
    if (passphrase && passphrase !== confirm) {
      setExportDialog(d => ({ ...d, error: "Passphrases do not match." }));
      return;
    }
    setExportDialog(d => ({ ...d, busy: true, error: "" }));
    try {
      let payload;
      let suffix = "";
      if (passphrase) {
        payload = await encryptArchive(archive, passphrase);
        suffix = "_enc";
      } else {
        payload = archive;
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = "srtlab_backups_archive_" + stamp + suffix + ".json";
      a.click();
      URL.revokeObjectURL(url);
      setExportDialog(null);
    } catch (e) {
      setExportDialog(d => ({ ...d, busy: false, error: "Encryption failed: " + e.message }));
    }
  }, [exportDialog]);

  const handleImportClick = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  /* ── AEMT import handlers ── */
  const handleAemtImportClick = useCallback(() => {
    aemtImportInputRef.current?.click();
  }, []);

  const handleAemtImportFiles = useCallback(async (e) => {
    const fileList = e.target.files;
    e.target.value = "";
    if (!fileList || fileList.length === 0) return;

    setAemtBusy(true);
    setAemtModal(null);

    const rawFiles = await Promise.all(
      Array.from(fileList).map(
        (f) => new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = (ev) => res({ name: f.name, data: new Uint8Array(ev.target.result) });
          r.onerror = () => rej(new Error("Could not read " + f.name));
          r.readAsArrayBuffer(f);
        }),
      ),
    );

    /* Task #946 — refuse a corrupt .bin dump before it is persisted as a
     * backup via saveAemtPlaceholders. */
    const corrupt = firstCorruptBin(rawFiles);
    if (corrupt) {
      setAemtBusy(false);
      setAemtModal({
        mode: "error",
        error: new AemtImportError(
          corruptFillError({ corruptFill: corrupt.cf }),
          [corrupt.name + ": " + corrupt.cf.detail],
        ),
      });
      return;
    }

    /* promptVin: resolve(null) signals cancel; throw only on unrecoverable error. */
    const promptVin = (info) => new Promise((resolve) => {
      aemtVinResolveRef.current = resolve;
      setAemtModal({ mode: "vin", warnings: info.warnings || [] });
    });

    let importResult;
    try {
      importResult = await importAemtBundle(rawFiles, { promptVin });
    } catch (err) {
      /* Swallow silent user-cancellation; surface real errors. */
      if (err?.cancelled) { setAemtBusy(false); return; }
      setAemtBusy(false);
      setAemtModal({
        mode: "error",
        error: err instanceof AemtImportError ? err : new AemtImportError(
          err.message || "Unexpected import error",
          [String(err.message || err)],
        ),
      });
      return;
    }

    const { preset, backupStubs, vin: importedVin, roles, warnings, checksAllGreen, checksPassed, checksTotal } = importResult;

    try {
      saveRawPreset(preset);
    } catch (err) {
      setAemtBusy(false);
      setAemtModal({
        mode: "error",
        error: new AemtImportError("Could not save preset: " + err.message, [err.message]),
      });
      return;
    }

    /* Use the shared audit pipeline — same as saveScanPlaceholders. */
    await saveAemtPlaceholders(backupStubs);
    refresh();
    setAemtBusy(false);
    setAemtModal({
      mode: "summary",
      result: { vin: importedVin, roles, warnings, checksPassed, checksTotal, checksAllGreen, backupStubs },
    });
  }, [refresh]);

  const handleImportFile = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    /* Auto-detect AEMT bundles — route .zip / .bin / .aemt files to the AEMT
     * importer instead of the backup-archive JSON path. */
    const isAemtFile = (f) => {
      const lower = f.name.toLowerCase();
      return lower.endsWith(".zip") || lower.endsWith(".bin") || lower.endsWith(".aemt");
    };
    const hasAemtFile = files.some(isAemtFile);

    /* If any selected file looks like an AEMT bundle, delegate to the AEMT
     * importer flow so a single Import button handles both archive types. */
    if (hasAemtFile) {
      const rawFiles = await Promise.all(
        files.map(
          (f) => new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = (ev) => res({ name: f.name, data: new Uint8Array(ev.target.result) });
            r.onerror = () => rej(new Error("Could not read " + f.name));
            r.readAsArrayBuffer(f);
          }),
        ),
      );
      /* Task #946 — refuse a corrupt .bin dump before it is persisted. */
      const corrupt = firstCorruptBin(rawFiles);
      if (corrupt) {
        setAemtModal({
          mode: "error",
          error: new AemtImportError(
            corruptFillError({ corruptFill: corrupt.cf }),
            [corrupt.name + ": " + corrupt.cf.detail],
          ),
        });
        return;
      }
      setAemtBusy(true);
      setAemtModal(null);
      const promptVin = (info) => new Promise((resolve) => {
        aemtVinResolveRef.current = resolve;
        setAemtModal({ mode: "vin", warnings: info.warnings || [] });
      });
      let importResult;
      try {
        importResult = await importAemtBundle(rawFiles, { promptVin });
      } catch (err) {
        /* Swallow silent user-cancellation; surface real errors. */
        if (err?.cancelled) { setAemtBusy(false); return; }
        setAemtBusy(false);
        setAemtModal({
          mode: "error",
          error: err instanceof AemtImportError ? err : new AemtImportError(
            err.message || "Unexpected import error",
            [String(err.message || err)],
          ),
        });
        return;
      }
      const { preset, backupStubs, vin: importedVin, roles, warnings, checksAllGreen, checksPassed, checksTotal } = importResult;
      try { saveRawPreset(preset); } catch (err) {
        setAemtBusy(false);
        setAemtModal({
          mode: "error",
          error: new AemtImportError("Could not save preset: " + err.message, [err.message]),
        });
        return;
      }
      const { created: savedCount } = await saveAemtPlaceholders(backupStubs);
      refresh();
      setAemtBusy(false);
      setAemtModal({
        mode: "summary",
        result: { vin: importedVin, roles, warnings, checksPassed, checksTotal, checksAllGreen, backupStubs: backupStubs.slice(0, savedCount) },
      });
      return;
    }

    /* Standard path — JSON backup archive. */
    const file = files[0];
    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      /* If the JSON lacks the backup-archive type marker but has AEMT-style
       * fields (vin + no type field), try the AEMT importer as a fallback. */
      if (!archive.type && (archive.vin || archive.vehicle || archive.job)) {
        const data = new Uint8Array(await file.arrayBuffer());
        const rawFiles2 = [{ name: file.name, data }];
        const promptVin2 = (info) => new Promise((resolve) => {
          aemtVinResolveRef.current = resolve;
          setAemtModal({ mode: "vin", warnings: info.warnings || [] });
        });
        setAemtBusy(true);
        setAemtModal(null);
        let importResult2;
        try {
          importResult2 = await importAemtBundle(rawFiles2, { promptVin: promptVin2 });
        } catch (err) {
          /* Swallow silent cancellations; surface real errors. */
          if (err?.cancelled) { setAemtBusy(false); return; }
          setAemtBusy(false);
          setAemtModal({
            mode: "error",
            error: err instanceof AemtImportError ? err : new AemtImportError(err.message || "Import error", [String(err.message || err)]),
          });
          return;
        }
        try { saveRawPreset(importResult2.preset); } catch {}
        await saveAemtPlaceholders(importResult2.backupStubs);
        refresh();
        setAemtBusy(false);
        setAemtModal({
          mode: "summary",
          result: { vin: importResult2.vin, roles: importResult2.roles, warnings: importResult2.warnings, checksPassed: importResult2.checksPassed, checksTotal: importResult2.checksTotal, checksAllGreen: importResult2.checksAllGreen, backupStubs: importResult2.backupStubs },
        });
        return;
      }
      /* Encrypted archive — open passphrase dialog before importing. */
      if (archive.type === ENCRYPTED_ARCHIVE_TYPE) {
        setImportPassphraseDialog({ envelope: archive, busy: false, passphrase: "", error: "" });
        return;
      }
      const r = importBackups(archive);
      refresh();
      const parts = [r.imported + " imported", r.skipped + " skipped (duplicate)"];
      if (r.invalid > 0) parts.push(r.invalid + " invalid");
      // Task #394 — when the archive carries embedded Key Prog history, call
      // it out so the tech knows their saved-archive list also moved across.
      let kpSuffix = "";
      if (r.keyProgArchives) {
        const kp = r.keyProgArchives;
        const kpParts = [kp.imported + " imported", kp.skipped + " skipped"];
        if (kp.invalid > 0) kpParts.push(kp.invalid + " invalid");
        kpSuffix = "\nKey Prog archive history: " + kpParts.join(", ") + ".";
      }
      alert("Backup import complete: " + parts.join(", ") + "." + kpSuffix);
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  }, [refresh]);

  const handleImportPassphraseConfirm = useCallback(async () => {
    if (!importPassphraseDialog) return;
    const { envelope, passphrase } = importPassphraseDialog;
    if (!passphrase) {
      setImportPassphraseDialog(d => ({ ...d, error: "Passphrase is required to decrypt this archive." }));
      return;
    }
    setImportPassphraseDialog(d => ({ ...d, busy: true, error: "" }));
    try {
      const archive = await decryptArchive(envelope, passphrase);
      setImportPassphraseDialog(null);
      const r = importBackups(archive);
      refresh();
      const parts = [r.imported + " imported", r.skipped + " skipped (duplicate)"];
      if (r.invalid > 0) parts.push(r.invalid + " invalid");
      let kpSuffix = "";
      if (r.keyProgArchives) {
        const kp = r.keyProgArchives;
        const kpParts = [kp.imported + " imported", kp.skipped + " skipped"];
        if (kp.invalid > 0) kpParts.push(kp.invalid + " invalid");
        kpSuffix = "\nKey Prog archive history: " + kpParts.join(", ") + ".";
      }
      alert("Backup import complete (encrypted archive): " + parts.join(", ") + "." + kpSuffix);
    } catch (e) {
      setImportPassphraseDialog(d => ({ ...d, busy: false, error: e.message }));
    }
  }, [importPassphraseDialog, refresh]);

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
    /* Refuse to even open the confirm modal for a corrupt capture. A backup
     * taken before the upload-time guard (or imported from an older archive)
     * can still hold a tool-error payload; restoring it would write garbage
     * onto a live ECU over OBD-II. The same check also runs in restoreModule
     * as a last line of defense. */
    const cf = backupCorruptFill(selectedData);
    if (cf) {
      setRestoreCorrupt(cf);
      addRestoreLog(
        "✖ Restore blocked — this backup looks like a tool-error capture" +
        (cf.reason ? " (" + cf.reason + ")" : "") + ". Re-read the module.",
        "error",
      );
      return;
    }
    setRestoreCorrupt(null);
    if (!conn) {
      alert("Connect to the adapter first (button at the top of this tab).");
      return;
    }
    setModalOpen(true);
  }, [selectedData, conn, addRestoreLog]);

  const onConfirmRestore = useCallback(async (meta = {}) => {
    setModalOpen(false);
    if (!eng.current || !selectedData) return;
    void meta;
    /* Defensive re-check: the modal could have been opened before a corrupt
     * payload was detected (deep-link, race). restoreModule guards too, but
     * surfacing the banner here keeps the user feedback consistent. */
    const cf = backupCorruptFill(selectedData);
    if (cf) {
      setRestoreCorrupt(cf);
      addRestoreLog(
        "✖ Restore blocked — this backup looks like a tool-error capture" +
        (cf.reason ? " (" + cf.reason + ")" : "") + ". Re-read the module.",
        "error",
      );
      return;
    }
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
              accept="application/json,.json,.zip,.bin,.aemt"
              multiple
              onChange={handleImportFile}
              style={{ display: "none" }}
              data-testid="import-backups-input"
            />
            <Btn
              onClick={handleAemtImportClick}
              color={C.a1}
              outline
              disabled={aemtBusy}
              data-testid="aemt-import-backups"
            >
              {aemtBusy ? "⏳ Importing…" : "📂 Import from AEMT"}
            </Btn>
            <input
              ref={aemtImportInputRef}
              type="file"
              accept=".zip,.bin,.json,.aemt"
              multiple
              // @ts-ignore — webkitdirectory is non-standard but widely supported
              webkitdirectory=""
              onChange={handleAemtImportFiles}
              style={{ display: "none" }}
              data-testid="aemt-import-backups-input"
            />
            {backups.length > 0 && <Btn onClick={handleClearAll} color={C.er} outline>🗑️ Clear All</Btn>}
            {diffSelection.size > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Btn
                  onClick={handleLaunchDiff}
                  disabled={diffSelection.size !== 2}
                  color={diffSelection.size === 2 ? C.a3 : C.tm}
                  data-testid="diff-selected-btn"
                >
                  🔀 Diff selected ({diffSelection.size}/2)
                </Btn>
                <button
                  onClick={() => setDiffSelection(new Set())}
                  title="Clear selection"
                  style={{
                    fontSize: 11, padding: "4px 8px", borderRadius: 4,
                    border: "1px solid " + C.bd, background: "#fff",
                    cursor: "pointer", color: C.ts,
                  }}
                >✕</button>
              </div>
            )}
          </div>
        </div>
        {restoreCorrupt && (
          <div
            data-testid="restore-corrupt-banner"
            style={{
              marginBottom: 12, padding: 14, borderRadius: 8,
              background: "#FFEBEE", border: "1.5px solid #FF5252",
              display: "flex", alignItems: "flex-start", gap: 12,
            }}
          >
            <div style={{ fontSize: 22, lineHeight: 1 }}>🚫</div>
            <div style={{ flex: 1, fontSize: 12, color: C.ts, lineHeight: 1.5 }}>
              <b style={{ color: "#C00" }}>
                Restore blocked — corrupt capture
                {restoreCorrupt.reason ? " (" + restoreCorrupt.reason + ")" : ""}.
              </b>
              <div style={{ marginTop: 4 }}>
                {restoreCorrupt.detail || "This backup looks like a tool-error response, not a real module dump."}
              </div>
              <div style={{ marginTop: 4 }}>
                Writing it back over OBD-II would push garbage onto the live module.
                Re-read the module with your programming tool and create a fresh backup.
              </div>
            </div>
          </div>
        )}
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

      <LeakScanPanel style={{ marginBottom: 14 }} />

      <Card style={{ marginBottom: 14, padding: 0, overflow: "hidden" }} data-testid="diff-reports-history">
        <div style={{
          ...listHeader,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <span>📊 SAVED DIFF REPORTS ({diffReports.length})</span>
          <div style={{ display: "flex", gap: 6 }}>
            {diffReports.length > 0 && (
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
            )}
            <button
              onClick={handleImportDiffsClick}
              data-testid="diff-reports-import"
              style={{
                padding: "4px 10px", fontSize: 10, fontWeight: 800,
                color: C.a2, background: "transparent",
                border: "1px solid " + C.a2, borderRadius: 4,
                cursor: "pointer", letterSpacing: 1,
              }}
              title="Import a previously exported diff report archive"
            >
              ⬆ IMPORT ARCHIVE
            </button>
            <input
              ref={diffImportInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportDiffsFile}
              style={{ display: "none" }}
              data-testid="diff-reports-import-input"
            />
            {diffReports.length > 0 && (
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
            )}
          </div>
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
            {diffSelection.size > 0 && (
              <div style={{
                padding: "6px 12px", fontSize: 10, background: "#EEF2FF",
                borderBottom: "1px solid " + C.bd, color: C.a3, fontWeight: 700,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span>Select 2 backups to compare — {diffSelection.size === 2 ? "ready to diff" : `${2 - diffSelection.size} more needed`}</span>
                <span style={{ marginLeft: "auto", opacity: 0.6, fontWeight: 400 }}>Click the checkbox on any row</span>
              </div>
            )}
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
              {filtered.map(b => {
                const isSel = selected === b.key;
                const isDiffSel = diffSelection.has(b.key);
                const isMaxed = diffSelection.size >= 2 && !isDiffSel;
                const date = new Date(b.timestamp);
                return (
                  <div key={b.key} onClick={() => loadBackup(b.key)}
                    style={{
                      padding: "12px 16px", borderBottom: "1px solid " + C.bd, cursor: "pointer",
                      background: isDiffSel ? C.a3 + "18" : isSel ? C.a2 + "10" : "#fff",
                      borderLeft: "3px solid " + (isDiffSel ? C.a3 : isSel ? C.a2 : "transparent"),
                      transition: "all 0.15s",
                    }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={isDiffSel}
                          disabled={isMaxed}
                          onClick={(e) => handleToggleDiffSelect(b.key, e)}
                          onChange={() => {}}
                          data-testid={"diff-checkbox-" + b.key}
                          title={isMaxed ? "Clear one selection before picking another" : isDiffSel ? "Deselect for diff" : "Select for diff"}
                          style={{ cursor: isMaxed ? "not-allowed" : "pointer", accentColor: C.a3, width: 14, height: 14, flexShrink: 0 }}
                        />
                        <div style={{ fontWeight: 800, fontSize: 13, color: isDiffSel ? C.a3 : isSel ? C.a2 : C.tx }}>{b.module}</div>
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
                    {/* Task #488 — Charger LD trim/HP under each backup VIN. */}
                    <VinChargerSubtitle vin={b.vin} dataTestId={`backup-vin-decode-${b.hash || b.id || ""}`} style={{ marginTop: 2 }} />
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
                  <button
                    onClick={handleRestore}
                    disabled={busy === "Restoring..." || selectedData?.tx == null}
                    title={selectedData?.tx == null
                      ? "No CAN address recorded — OBD restore unavailable for this snapshot."
                      : undefined}
                    style={chip("#fff3", "#fff")}
                  >
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
                  padding: 10,
                  background: selectedData.source === "aemt-import" ? "#F0F4FF" : "#FFF8F0",
                  border: "1px solid " + (selectedData.source === "aemt-import" ? "#90A4AE" : C.wn),
                  borderRadius: 6, fontSize: 11, color: selectedData.source === "aemt-import" ? "#3A4A5A" : C.ts,
                  marginBottom: 14, lineHeight: 1.5,
                }}>
                  {selectedData.source === "aemt-import" ? (
                    <><b>ℹ️ AEMT import — pre-write snapshot.</b>{" "}
                    Imported from an AEMT bundle. Connect to the adapter and click Restore to write the captured
                    DIDs back via UDS 0x2E. Also use the Key Prog tab to apply the matching VIN preset.</>
                  ) : (
                    <><b>⚠ Restore writes the DIDs below back to the module via UDS 0x2E.</b>{" "}
                    Connect to the adapter, then click Restore — you'll be asked to confirm via the Read-First check.</>
                  )}
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
                          {data.critical && "🔴 "}0x{hx(parseInt(did, 10), 4)} · {data.name || getDidDescription(parseInt(did, 10)) || "Unknown DID"}
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

                {pairedData === "loading" && (
                  <div data-testid="snapshot-diff-loading" style={{
                    marginTop: 16, padding: "10px 14px", background: "#F0F4FF",
                    border: "1px solid #90A4AE", borderRadius: 6,
                    fontSize: 11, color: C.ts, display: "flex", alignItems: "center", gap: 8,
                  }}>
                    <span style={{ opacity: 0.6 }}>⏳</span> Loading paired snapshot for comparison…
                  </div>
                )}
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
                    <div data-testid="snapshot-diff-panel" style={{ marginTop: 16 }}>
                      <div style={{
                        fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 2,
                        marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center",
                      }}>
                        <span>🔀 COMPARE CHANGES</span>
                        <span style={{ fontWeight: 400, color: C.tm }}>
                          {changedRows.length > 0
                            ? <span style={{ color: "#CC7700", fontWeight: 700 }}>{changedRows.length} changed</span>
                            : <span style={{ color: C.a2, fontWeight: 700 }}>0 changed</span>
                          }
                          {" · "}
                          <span style={{ color: C.tm }}>{unchangedRows.length} unchanged</span>
                        </span>
                      </div>

                      {changedRows.length === 0 ? (
                        <div data-testid="snapshot-diff-no-changes" style={{
                          fontSize: 11, color: C.a2, padding: "10px 12px",
                          background: "#e6f9ed", border: "1px solid #A5D6A7",
                          borderRadius: 6, marginBottom: 6,
                        }}>
                          ✓ No DID values changed between the PRE and POST snapshots.
                        </div>
                      ) : (
                        <div data-testid="snapshot-diff-changed">
                          {changedRows.map(({ did, before, after }) => (
                            <div
                              key={did}
                              data-testid={"snapshot-diff-row-changed-" + did}
                              style={{
                                padding: "8px 10px", marginBottom: 5, borderRadius: 5,
                                border: "1.5px solid #F9A825",
                                background: "linear-gradient(135deg,#FFFDE7 0%,#FFFBF0 100%)",
                              }}
                            >
                              <div style={{ fontSize: 10, fontWeight: 800, color: C.tx, marginBottom: 5 }}>
                                {(before?.critical || after?.critical) && "🔴 "}
                                0x{hx(parseInt(did, 10), 4)} · {before?.name || after?.name || getDidDescription(parseInt(did, 10)) || "Unknown DID"}
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                                <div style={{
                                  padding: "5px 8px", borderRadius: 4,
                                  background: "#FFEBEE", border: "1px solid #FFCDD2",
                                }}>
                                  <div style={{ fontSize: 8, fontWeight: 800, color: "#CC0000", letterSpacing: 1.5, marginBottom: 3 }}>BEFORE</div>
                                  {before?.ascii && (
                                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#B71C1C", fontWeight: 700, marginBottom: 1 }}>
                                      "{before.ascii}"
                                    </div>
                                  )}
                                  <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#CC0000", wordBreak: "break-all", opacity: 0.85 }}>
                                    {before?.hex || <span style={{ fontStyle: "italic", opacity: 0.6 }}>(missing)</span>}
                                  </div>
                                </div>
                                <div style={{
                                  padding: "5px 8px", borderRadius: 4,
                                  background: "#E8F5E9", border: "1px solid #C8E6C9",
                                }}>
                                  <div style={{ fontSize: 8, fontWeight: 800, color: "#1E6F3A", letterSpacing: 1.5, marginBottom: 3 }}>AFTER</div>
                                  {after?.ascii && (
                                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: "#1B5E20", fontWeight: 700, marginBottom: 1 }}>
                                      "{after.ascii}"
                                    </div>
                                  )}
                                  <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: "#1E6F3A", wordBreak: "break-all", opacity: 0.85 }}>
                                    {after?.hex || <span style={{ fontStyle: "italic", opacity: 0.6 }}>(missing)</span>}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {unchangedRows.length > 0 && (
                        <details data-testid="snapshot-diff-unchanged" style={{ marginTop: 4 }}>
                          <summary style={{
                            fontSize: 10, color: C.tm, cursor: "pointer",
                            padding: "5px 8px", borderRadius: 4,
                            background: "#F5F5F5", border: "1px solid " + C.bd,
                            userSelect: "none", listStyle: "none",
                            display: "flex", alignItems: "center", gap: 5,
                          }}>
                            <span>▶</span>
                            <span>{unchangedRows.length} unchanged DID{unchangedRows.length !== 1 ? "s" : ""} (no diff)</span>
                          </summary>
                          <div style={{ marginTop: 3 }}>
                            {unchangedRows.map(({ did, before, after }) => (
                              <div
                                key={did}
                                data-testid={"snapshot-diff-row-unchanged-" + did}
                                style={{
                                  padding: "5px 10px", borderBottom: "1px solid " + C.bd,
                                  display: "flex", alignItems: "center", gap: 10,
                                  opacity: 0.45,
                                }}
                              >
                                <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 700, color: C.ts, whiteSpace: "nowrap" }}>
                                  0x{hx(parseInt(did, 10), 4)}
                                </span>
                                <span style={{ fontSize: 10, color: C.tm, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {before?.name || after?.name || getDidDescription(parseInt(did, 10)) || "Unknown DID"}
                                </span>
                                {(before || after)?.ascii && (
                                  <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 9, color: C.ts }}>
                                    "{(before || after).ascii}"
                                  </span>
                                )}
                                <span style={{
                                  fontSize: 8, fontWeight: 700, color: C.a2, letterSpacing: 1,
                                  padding: "1px 5px", background: "#e6f9ed", borderRadius: 3,
                                }}>
                                  =
                                </span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
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

      <ChecksumScanPanel />

      {diffView && (
        <div
          data-testid="analysis-diff-modal"
          style={{
            position: "fixed", inset: 0, zIndex: 9998,
            background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            padding: "24px 16px", overflowY: "auto",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setDiffView(null); }}
        >
          <div style={{
            background: "#fff", borderRadius: 10, width: "100%", maxWidth: 900,
            boxShadow: "0 12px 60px rgba(0,0,0,0.35)", overflow: "hidden",
          }}>
            <AnalysisDiffView
              diffResult={diffView.result}
              backupA={diffView.backupA}
              backupB={diffView.backupB}
              onClose={() => setDiffView(null)}
            />
          </div>
        </div>
      )}

      <AemtImportModal
        mode={aemtModal?.mode || null}
        result={aemtModal?.result}
        error={aemtModal?.error}
        warnings={aemtModal?.warnings}
        onClose={() => { setAemtModal(null); setAemtBusy(false); }}
        onConfirmVin={(vin) => {
          const resolve = aemtVinResolveRef.current;
          aemtVinResolveRef.current = null;
          setAemtModal(null);
          if (resolve) resolve(vin);
        }}
        onCancelVin={() => {
          const resolve = aemtVinResolveRef.current;
          aemtVinResolveRef.current = null;
          setAemtModal(null);
          /* resolve(null) → importAemtBundle throws a cancelled AemtImportError
           * which the handler catches silently — no error modal shown. */
          if (resolve) resolve(null);
        }}
      />

      {exportDialog && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#fff", borderRadius: 12, padding: 28, width: 380, maxWidth: "90vw",
            boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: "#0A3D1A", marginBottom: 6, letterSpacing: 1 }}>
              📦 Export All Backups
            </div>
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 18, lineHeight: 1.6 }}>
              Optionally protect this archive with a passphrase. The file will be encrypted with AES-256-GCM — you'll need the same passphrase to import it later.
              <br /><br />
              Leave the passphrase blank to export as plain JSON (no encryption).
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
                PASSPHRASE (optional)
              </label>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Leave blank for unencrypted export"
                value={exportDialog.passphrase}
                onChange={e => setExportDialog(d => ({ ...d, passphrase: e.target.value, error: "" }))}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 10px",
                  border: "1.5px solid " + C.bd, borderRadius: 6, fontSize: 13, fontFamily: "inherit",
                }}
              />
            </div>
            {exportDialog.passphrase && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
                  CONFIRM PASSPHRASE
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat passphrase"
                  value={exportDialog.confirm}
                  onChange={e => setExportDialog(d => ({ ...d, confirm: e.target.value, error: "" }))}
                  style={{
                    width: "100%", boxSizing: "border-box", padding: "8px 10px",
                    border: "1.5px solid " + (exportDialog.error ? "#CC0000" : C.bd),
                    borderRadius: 6, fontSize: 13, fontFamily: "inherit",
                  }}
                />
              </div>
            )}
            {exportDialog.error && (
              <div style={{ fontSize: 11, color: "#CC0000", marginBottom: 10, fontWeight: 700 }}>
                ✗ {exportDialog.error}
              </div>
            )}
            {exportDialog.passphrase && (
              <div style={{
                fontSize: 11, color: "#1E6F3A", marginBottom: 14, padding: "8px 10px",
                background: "#e6f9ed", borderRadius: 6, display: "flex", alignItems: "center", gap: 6,
              }}>
                🔒 Archive will be encrypted with AES-256-GCM
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn onClick={() => setExportDialog(null)} color={C.ts} outline disabled={exportDialog.busy}>
                Cancel
              </Btn>
              <Btn onClick={handleExportDialogConfirm} color={C.a2} disabled={exportDialog.busy}>
                {exportDialog.busy ? "⏳ Encrypting…" : exportDialog.passphrase ? "🔒 Encrypt & Download" : "⬇ Download"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {importPassphraseDialog && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "#fff", borderRadius: 12, padding: 28, width: 360, maxWidth: "90vw",
            boxShadow: "0 8px 40px rgba(0,0,0,0.25)",
          }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: "#0A3D1A", marginBottom: 6, letterSpacing: 1 }}>
              🔒 Encrypted Archive
            </div>
            <div style={{ fontSize: 12, color: C.ts, marginBottom: 18, lineHeight: 1.6 }}>
              This archive is encrypted. Enter the passphrase that was used when it was exported.
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
                PASSPHRASE
              </label>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                placeholder="Enter passphrase"
                value={importPassphraseDialog.passphrase}
                onChange={e => setImportPassphraseDialog(d => ({ ...d, passphrase: e.target.value, error: "" }))}
                onKeyDown={e => { if (e.key === "Enter") handleImportPassphraseConfirm(); }}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 10px",
                  border: "1.5px solid " + (importPassphraseDialog.error ? "#CC0000" : C.bd),
                  borderRadius: 6, fontSize: 13, fontFamily: "inherit",
                }}
              />
            </div>
            {importPassphraseDialog.error && (
              <div style={{ fontSize: 11, color: "#CC0000", marginBottom: 10, fontWeight: 700 }}>
                ✗ {importPassphraseDialog.error}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn onClick={() => setImportPassphraseDialog(null)} color={C.ts} outline disabled={importPassphraseDialog.busy}>
                Cancel
              </Btn>
              <Btn onClick={handleImportPassphraseConfirm} color={C.a2} disabled={importPassphraseDialog.busy}>
                {importPassphraseDialog.busy ? "⏳ Decrypting…" : "🔓 Decrypt & Import"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {modalOpen && selectedData && (
        <ReadFirstModal
          title={"Restore " + selectedData.module + " from backup"}
          subtitle={"Snapshot taken " + new Date(selectedData.timestamp).toLocaleString()}
          module={selectedData.module + (selectedData.tx != null ? "  (TX 0x" + hx(selectedData.tx, 3) + " / RX 0x" + hx(selectedData.rx, 3) + ")" : "")}
          summary={
            "This will write " +
            Object.values(selectedData.dids).filter(d => d.bytes && d.bytes.length).length +
            " DIDs back to the live module via UDS 0x2E. The current module values will be overwritten."
          }
          details={
            <>
              {Object.entries(selectedData.dids).map(([did, data]) => (
                <div key={did} style={{ marginBottom: 4 }}>
                  0x{hx(parseInt(did, 10), 4)} · {data.name || getDidDescription(parseInt(did, 10)) || "Unknown DID"}
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
