// Module backup services.
// Backups are persisted to the project database via the API server
// (/api/backups). localStorage is used only as an offline cache so the UI
// can render synchronously and continue working when the server is
// unreachable.
//
// The session "paper trail" layer that used to live here was removed
// at the user's request — there is no longer any per-write audit log.
// Module backups (read-before-write snapshots) remain because they are
// functional data needed by the Restore flow.

import { sha256Hex, backupDidsToBytes } from "./checksum.js";

const BACKUP_INDEX_KEY = "srtlab_backup_index";
const BACKUP_KEY_PREFIX = "srtlab_backup_";
const BACKUP_MIGRATED_KEY = "srtlab_backup_migrated_v1";
const MAX_BACKUPS = 50;

/* Soft quota for backup storage. Browsers typically cap localStorage at ~5 MB
 * per origin; we warn at 70% and auto-prune at 90% so the index never silently
 * gets dropped on the next setItem. */
export const BACKUP_QUOTA_BYTES = 4 * 1024 * 1024;
export const BACKUP_WARN_PERCENT = 70;
const BACKUP_PRUNE_PERCENT = 90;
const API_BASE = "/api/backups";

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

/* Critical DIDs per module — what we back up before writing anything. */
export const CRITICAL_DIDS = {
  BCM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF191, name: "Hardware Version" },
    { did: 0xF18C, name: "Serial Number" },
    { did: 0xF1A0, name: "BCM Config", critical: true },
    { did: 0xF1A1, name: "BCM Feature Bytes", critical: true },
    { did: 0xF1D0, name: "Key Fob Data" },
    { did: 0xF1D1, name: "SKIM Data", critical: true },
    { did: 0x7B90, name: "Current VIN", critical: true },
    { did: 0x7B88, name: "Original VIN", critical: true },
  ],
  RFHUB: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF18C, name: "PIN / Serial", critical: true },
    { did: 0xF1E0, name: "Tire Sensors" },
    { did: 0xF1E1, name: "Secret Key", critical: true },
  ],
  ECM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF191, name: "Hardware Version" },
    { did: 0xF18C, name: "Serial Number" },
    { did: 0xF194, name: "Software Fingerprint" },
    { did: 0xF195, name: "Calibration ID" },
    { did: 0xF40D, name: "Odometer", critical: true },
    { did: 0xF1C1, name: "Engine Hours" },
    { did: 0xF1C0, name: "Calibration Data", critical: true },
  ],
  ADCM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF1A1, name: "Suspension Mode" },
    { did: 0xDE10, name: "Vehicle Config" },
    { did: 0xDE11, name: "Variant Code" },
    { did: 0x7B90, name: "Current VIN", critical: true },
    { did: 0x7B88, name: "Original VIN", critical: true },
  ],
};

function notify() {
  try {
    window.dispatchEvent(new Event("srtlab:audit"));
  } catch {}
}

export function dispatchToast(message, type = "info", durationMs = 6000) {
  try {
    window.dispatchEvent(new CustomEvent("srtlab:toast", {
      detail: { message, type, durationMs, ts: Date.now() },
    }));
  } catch {}
}

export function subscribeToast(handler) {
  const listener = (e) => handler(e.detail);
  window.addEventListener("srtlab:toast", listener);
  return () => window.removeEventListener("srtlab:toast", listener);
}

function readLocalIndex() {
  try { return JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]"); }
  catch { return []; }
}

function writeLocalIndex(idx) {
  try { localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(idx.slice(0, MAX_BACKUPS))); }
  catch {}
}

function localPayload(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch { return null; }
}

function setLocalPayload(key, payload) {
  try { localStorage.setItem(key, JSON.stringify(payload)); return true; }
  catch { return false; }
}

function removeLocalPayload(key) {
  try { localStorage.removeItem(key); } catch {}
}

/* ─── BACKUP QUOTA ─── */

/* Approximate byte cost of a localStorage entry. JS strings are UTF-16, so each
 * character is 2 bytes; key length counts too. This is an estimate, but it's
 * stable enough to drive the warning banner. */
function entryBytes(key, value) {
  const s = typeof value === "string" ? value : JSON.stringify(value || "");
  return ((key?.length || 0) + s.length) * 2;
}

export function getBackupStorageUsage() {
  let used = 0;
  let count = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k === BACKUP_INDEX_KEY || k.startsWith(BACKUP_KEY_PREFIX)) {
        const v = localStorage.getItem(k) || "";
        used += entryBytes(k, v);
        if (k.startsWith(BACKUP_KEY_PREFIX) && k !== BACKUP_INDEX_KEY) count++;
      }
    }
  } catch {}
  const max = BACKUP_QUOTA_BYTES;
  const percent = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { used, max, percent, count };
}

/* Walk the backup index from oldest to newest. A backup is "non-critical" if a
 * newer backup exists for the same (module, vin) pair — meaning the older one
 * is a redundant historical snapshot we can safely drop. We stop pruning as
 * soon as usage falls under `targetBytes`. */
export function pruneNonCriticalBackups({ targetBytes = BACKUP_QUOTA_BYTES * 0.6 } = {}) {
  let prunedCount = 0;
  let freedBytes = 0;
  try {
    const idx = readLocalIndex();
    if (idx.length === 0) return { prunedCount, freedBytes };
    /* idx is newest-first; iterate oldest-first so older duplicates die first. */
    const ordered = [...idx].reverse();
    const seen = new Map();
    /* Walk newest-first to mark which (module,vin) pairs already have a newer
     * snapshot kept; their older twins become eligible for pruning. */
    for (const entry of idx) {
      const k = entry.module + "|" + entry.vin;
      if (!seen.has(k)) seen.set(k, entry.key);
    }
    const toDelete = new Set();
    for (const entry of ordered) {
      const k = entry.module + "|" + entry.vin;
      if (seen.get(k) !== entry.key) toDelete.add(entry.key);
    }
    for (const entry of ordered) {
      if (getBackupStorageUsage().used <= targetBytes) break;
      if (!toDelete.has(entry.key)) continue;
      const raw = localStorage.getItem(entry.key) || "";
      freedBytes += entryBytes(entry.key, raw);
      localStorage.removeItem(entry.key);
      prunedCount++;
    }
    if (prunedCount > 0) {
      const remaining = idx.filter(b => !toDelete.has(b.key) || localStorage.getItem(b.key) !== null);
      writeLocalIndex(remaining);
      notify();
    }
  } catch {}
  return { prunedCount, freedBytes };
}

/* ─── BACKUPS ─── */

export async function backupModule(engUds, tx, rx, moduleType, addLog = () => {}, snapshotKind = "pre-write", preWriteKey = null) {
  const dids = CRITICAL_DIDS[moduleType];
  if (!dids) {
    addLog("No backup profile for " + moduleType, "warn");
    return null;
  }
  addLog("═══ CREATING MODULE BACKUP: " + moduleType + " ═══", "info");
  addLog("Reading " + dids.length + " critical DIDs before any writes...", "info");
  await engUds(tx, rx, [0x10, 0x03]);
  const backup = {
    module: moduleType,
    tx, rx,
    timestamp: new Date().toISOString(),
    dids: {},
  };
  let successCount = 0;
  for (const d of dids) {
    const r = await engUds(tx, rx, [0x22, (d.did >> 8) & 0xFF, d.did & 0xFF]);
    if (r && r.ok && r.d && r.d[0] === 0x62) {
      const raw = Array.from(r.d).slice(3);
      const hex = raw.map(b => hx(b)).join("");
      const ascii = raw.filter(b => b >= 0x20 && b <= 0x7E).map(b => String.fromCharCode(b)).join("");
      backup.dids[d.did] = {
        name: d.name, critical: !!d.critical, hex,
        ascii: ascii.length >= 3 ? ascii : "", bytes: raw,
      };
      addLog("  0x" + hx(d.did, 4) + " (" + d.name + "): " + hex, "rx");
      successCount++;
    } else {
      backup.dids[d.did] = { name: d.name, critical: !!d.critical, hex: "", bytes: [], missing: true };
      addLog("  0x" + hx(d.did, 4) + " (" + d.name + "): not readable", "warn");
    }
  }
  addLog("Backup complete: " + successCount + "/" + dids.length + " DIDs captured", "info");
  const checksum = await sha256Hex(backupDidsToBytes(backup.dids)).catch(() => null);
  backup.checksum = checksum;
  backup.snapshotKind = snapshotKind;
  if (preWriteKey) backup.preWriteKey = preWriteKey;
  const vin = backup.dids[0xF190]?.ascii?.slice(-17) || "unknown";
  const key = BACKUP_KEY_PREFIX + moduleType + "_" + vin + "_" + Date.now();
  const meta = { key, id: key, module: moduleType, vin, timestamp: backup.timestamp, didCount: successCount, tx, rx, checksum, snapshotKind, preWriteKey: preWriteKey || null };

  /* Pre-flight: if we're already past the prune threshold, drop redundant
   * historical snapshots before the write so we don't trip the browser quota. */
  const preUsage = getBackupStorageUsage();
  if (preUsage.percent >= BACKUP_PRUNE_PERCENT) {
    const r = pruneNonCriticalBackups();
    if (r.prunedCount > 0) {
      addLog(
        "Backup storage was " + preUsage.percent + "% full — auto-pruned " +
        r.prunedCount + " redundant snapshot(s) (" + formatBytes(r.freedBytes) + " freed)",
        "warn",
      );
    }
  }

  // Try the database first; fall back to localStorage cache.
  let savedRemote = false;
  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: key, module: moduleType, vin, didCount: successCount,
        tx, rx, timestamp: backup.timestamp, payload: backup,
        checksum, snapshotKind, preWriteKey: preWriteKey || null,
      }),
    });
    savedRemote = res.ok;
    if (!res.ok) {
      addLog("Backup server returned " + res.status + " — keeping local copy only", "warn");
    } else {
      addLog("✓ Backup saved to database: " + key, "info");
    }
  } catch (e) {
    addLog("Backup server unreachable (" + e.message + ") — keeping local copy only", "warn");
  }

  const trySaveLocal = () => {
    setLocalPayload(key, backup);
    const idx = readLocalIndex();
    idx.unshift(meta);
    if (idx.length > MAX_BACKUPS) {
      idx.slice(MAX_BACKUPS).forEach(b => removeLocalPayload(b.key));
    }
    writeLocalIndex(idx);
    backup.key = key;
  };

  try {
    trySaveLocal();
    if (!savedRemote) addLog("✓ Backup saved (local cache only): " + key, "info");

    /* Post-save: if we just crossed the warn threshold, surface a toast so the
     * user knows to visit the Backups tab and free space. */
    const postUsage = getBackupStorageUsage();
    if (postUsage.percent >= BACKUP_WARN_PERCENT) {
      dispatchToast(
        "Backup storage is " + postUsage.percent + "% full (" +
        formatBytes(postUsage.used) + " of " + formatBytes(postUsage.max) +
        "). Visit the Backups tab to free space.",
        "warn",
      );
    }
    notify();
  } catch (e) {
    /* Quota hit. Aggressively prune redundant snapshots and retry once. If we
     * still fail, surface a visible toast — silent loss of audit history is
     * worse than spamming a banner. */
    addLog("Backup save failed (" + e.message + ") — pruning and retrying...", "warn");
    const r = pruneNonCriticalBackups({ targetBytes: BACKUP_QUOTA_BYTES * 0.4 });
    try {
      trySaveLocal();
      addLog(
        "✓ Backup saved after pruning " + r.prunedCount +
        " redundant snapshot(s): " + key,
        "info",
      );
      dispatchToast(
        "Backup storage was full — auto-pruned " + r.prunedCount +
        " older snapshot(s) to make room.",
        "warn",
      );
      notify();
    } catch (e2) {
      addLog("Failed to save backup: " + e2.message, "error");
      if (!savedRemote) {
        dispatchToast(
          "Could not save " + moduleType + " backup: " + e2.message +
          ". Open the Backups tab and clear old entries before writing again.",
          "error",
          10000,
        );
      }
    }
  }

  return backup;
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export { fmtBytes as formatBytes };

export async function restoreModule(engUds, tx, rx, backup, addLog = () => {}, fullRestore = false) {
  if (!backup || !backup.dids) {
    addLog("Invalid backup data", "error");
    return false;
  }
  addLog("═══ RESTORING MODULE: " + backup.module + " ═══", "info");
  addLog("Backup timestamp: " + backup.timestamp, "info");
  let restoredCount = 0, failedCount = 0;
  for (const [didStr, data] of Object.entries(backup.dids)) {
    const did = parseInt(didStr, 10);
    if (!data.bytes || data.bytes.length === 0) continue;
    if (!fullRestore && !data.critical) continue;
    addLog("Restoring 0x" + hx(did, 4) + " (" + data.name + ")...", "info");
    const r = await engUds(tx, rx, [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...data.bytes]);
    if (r && r.ok && r.d && r.d[0] === 0x6E) {
      addLog("  ✓ Restored", "rx");
      restoredCount++;
    } else {
      addLog("  Failed: 0x" + hx(did, 4), "error");
      failedCount++;
    }
    await new Promise(res => setTimeout(res, 200));
  }
  addLog("Restore: " + restoredCount + " success, " + failedCount + " failed", "info");
  return failedCount === 0;
}

/* Synchronous list — returns the local cache so React can render
   without awaiting. Pair with refreshBackupsFromServer() to keep it fresh. */
export function getBackupList(moduleType) {
  const idx = readLocalIndex();
  return moduleType ? idx.filter(b => b.module === moduleType) : idx;
}

/* Synchronous payload from local cache. */
export function getBackup(key) {
  return localPayload(key);
}

/* Async payload — checks local cache first, then fetches from the server. */
export async function getBackupAsync(key) {
  const local = localPayload(key);
  if (local) return local;
  try {
    const res = await fetch(API_BASE + "/" + encodeURIComponent(key));
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.payload) {
      setLocalPayload(key, j.payload);
      return j.payload;
    }
  } catch {}
  return null;
}

export function deleteBackup(key) {
  // Optimistic local removal; server delete fires in the background.
  removeLocalPayload(key);
  writeLocalIndex(readLocalIndex().filter(b => b.key !== key));
  notify();
  fetch(API_BASE + "/" + encodeURIComponent(key), { method: "DELETE" })
    .catch(() => { /* best-effort */ });
}

/* Build a single archive containing every backup currently in localStorage,
 * along with the index. Used by the Backups tab "Export all" button so users
 * can archive history before pruning or move it between machines. */
export function exportAllBackups() {
  const idx = getBackupList();
  const backups = {};
  for (const entry of idx) {
    const data = getBackup(entry.key);
    if (data) backups[entry.key] = data;
  }
  return {
    type: "srtlab_backup_archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    count: Object.keys(backups).length,
    index: idx,
    backups,
  };
}

/* Merge an archive produced by exportAllBackups back into localStorage.
 * Duplicates (matching localStorage key) are skipped so re-importing the same
 * archive twice is a no-op. Returns counts for the caller to surface. */
export function importBackups(archive) {
  const result = { imported: 0, skipped: 0, invalid: 0 };
  if (!archive || archive.type !== "srtlab_backup_archive" || !archive.backups) {
    throw new Error("Not a valid SRT Lab backup archive");
  }
  let idx;
  try {
    idx = JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]");
  } catch { idx = []; }
  const existingKeys = new Set(idx.map(b => b.key));
  const archiveIndex = Array.isArray(archive.index) ? archive.index : [];
  const indexByKey = new Map(archiveIndex.map(e => [e.key, e]));

  for (const [key, data] of Object.entries(archive.backups)) {
    if (!key.startsWith(BACKUP_KEY_PREFIX)) { result.invalid++; continue; }
    if (!data || !data.module || !data.dids) { result.invalid++; continue; }
    if (existingKeys.has(key)) { result.skipped++; continue; }
    try {
      localStorage.setItem(key, JSON.stringify(data));
      const meta = indexByKey.get(key) || {
        key,
        module: data.module,
        vin: data.dids?.[0xF190]?.ascii?.slice(-17) || "unknown",
        timestamp: data.timestamp || new Date().toISOString(),
        didCount: Object.keys(data.dids).length,
      };
      idx.unshift(meta);
      existingKeys.add(key);
      result.imported++;
    } catch (e) {
      result.invalid++;
    }
  }
  /* Newest-first, then trim to MAX_BACKUPS like the rest of the system. */
  idx.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  if (idx.length > MAX_BACKUPS) {
    idx.slice(MAX_BACKUPS).forEach(b => {
      try { localStorage.removeItem(b.key); } catch {}
    });
  }
  localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(idx.slice(0, MAX_BACKUPS)));
  notify();
  return result;
}

export function clearBackups() {
  const idx = readLocalIndex();
  idx.forEach(b => removeLocalPayload(b.key));
  try { localStorage.removeItem(BACKUP_INDEX_KEY); } catch {}
  notify();
  fetch(API_BASE, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

/* Pulls the canonical list from the server, migrates any local-only entries
   on first run, and refreshes the local cache index so getBackupList() is
   up-to-date. Safe to call repeatedly; returns the merged list. */
export async function refreshBackupsFromServer() {
  let serverList = null;
  try {
    const res = await fetch(API_BASE);
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.backups)) serverList = j.backups;
    }
  } catch { /* offline; keep local cache */ }

  if (!serverList) return readLocalIndex();

  // First-run migration: push local-only entries to the database.
  const serverIds = new Set(serverList.map(b => b.id || b.key));
  const localIdx = readLocalIndex();
  let migrated = false;
  if (!localStorage.getItem(BACKUP_MIGRATED_KEY)) {
    for (const meta of localIdx) {
      if (serverIds.has(meta.key)) continue;
      const payload = localPayload(meta.key);
      if (!payload) continue;
      try {
        const res = await fetch(API_BASE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: meta.key,
            module: meta.module,
            vin: meta.vin,
            didCount: meta.didCount,
            tx: meta.tx ?? payload.tx ?? null,
            rx: meta.rx ?? payload.rx ?? null,
            timestamp: meta.timestamp || payload.timestamp,
            payload,
          }),
        });
        if (res.ok) { serverIds.add(meta.key); migrated = true; }
      } catch { /* offline mid-migration; try next refresh */ }
    }
    try { localStorage.setItem(BACKUP_MIGRATED_KEY, new Date().toISOString()); } catch {}
  }

  // Re-pull if we migrated anything so the merged list reflects DB ordering.
  if (migrated) {
    try {
      const res = await fetch(API_BASE);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.backups)) serverList = j.backups;
      }
    } catch {}
  }

  const normalized = serverList.map(b => ({
    key: b.id || b.key,
    id: b.id || b.key,
    module: b.module,
    vin: b.vin,
    timestamp: b.timestamp,
    didCount: b.didCount,
    tx: b.tx,
    rx: b.rx,
    checksum: b.checksum ?? null,
    snapshotKind: b.snapshotKind ?? null,
    preWriteKey: b.preWriteKey ?? null,
  }));
  writeLocalIndex(normalized);
  notify();
  return normalized;
}

/* Create per-module placeholder backups from a J2534 scan. Each scanned
 * module becomes a stub backup entry so the BACKUPS tab can browse them
 * without the user copy-pasting JSON. If a VIN was decoded for the module
 * during the scan, it's stored as DID 0xF190 so the existing list/detail
 * UI lights up the VIN field. Returns { created, keys }. Keys are stable
 * for a given (module, scanTs, tx) so re-clicking "Send to BACKUPS" on the
 * same scan is a no-op. */
export async function saveScanPlaceholders(scanModules, { source = "j2534-scan", scanTs = Date.now() } = {}) {
  if (!Array.isArray(scanModules) || scanModules.length === 0) {
    return { created: 0, keys: [], skipped: 0, duplicates: [] };
  }
  const idx = readLocalIndex();
  const existingKeys = new Set(idx.map(b => b.key));
  const stamp = new Date(scanTs).toISOString();
  const createdKeys = [];
  const duplicateKeys = [];
  const createdMetas = [];
  let skipped = 0;
  for (const m of scanModules) {
    if (!m || !m.code) { skipped++; continue; }
    const moduleType = m.code;
    const vin = (m.vin && String(m.vin).slice(-17)) || "unknown";
    const dids = {};
    if (m.vin) {
      const ascii = String(m.vin);
      const bytes = Array.from(ascii).map(c => c.charCodeAt(0) & 0xFF);
      dids[0xF190] = {
        name: "VIN",
        critical: true,
        hex: bytes.map(b => hx(b)).join(""),
        ascii,
        bytes,
      };
    }
    const payload = {
      module: moduleType,
      tx: m.tx,
      rx: m.rx,
      timestamp: stamp,
      placeholder: true,
      source,
      dids,
    };
    const key = BACKUP_KEY_PREFIX + moduleType + "_" + vin + "_scan" +
      scanTs + "_" + ((m.tx ?? 0).toString(16));
    if (existingKeys.has(key)) { duplicateKeys.push(key); skipped++; continue; }
    if (!setLocalPayload(key, payload)) { skipped++; continue; }
    const meta = {
      key, id: key, module: moduleType, vin,
      timestamp: stamp,
      didCount: Object.keys(dids).length,
      tx: m.tx, rx: m.rx,
      placeholder: true,
      source,
    };
    idx.unshift(meta);
    existingKeys.add(key);
    createdKeys.push(key);
    createdMetas.push({ meta, payload });
  }
  if (createdKeys.length === 0) {
    return { created: 0, keys: [], skipped, duplicates: duplicateKeys };
  }
  if (idx.length > MAX_BACKUPS) {
    idx.slice(MAX_BACKUPS).forEach(b => removeLocalPayload(b.key));
  }
  writeLocalIndex(idx);
  notify();

  /* Persist to the database too. Without this, BackupsTab's
   * refreshBackupsFromServer() on mount/focus would overwrite the local
   * index with the server list and our placeholders would silently
   * disappear. Failures are non-fatal — the local cache still carries the
   * entry, and a future refresh will simply not find it on the server. */
  let serverFailures = 0;
  await Promise.all(createdMetas.map(async ({ meta, payload }) => {
    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: meta.key,
          module: meta.module,
          vin: meta.vin,
          didCount: meta.didCount,
          tx: meta.tx ?? null,
          rx: meta.rx ?? null,
          timestamp: meta.timestamp,
          payload,
        }),
      });
      if (!res.ok) serverFailures++;
    } catch {
      serverFailures++;
    }
  }));

  return {
    created: createdKeys.length,
    keys: createdKeys,
    skipped,
    duplicates: duplicateKeys,
    serverFailures,
  };
}

/* React hook helper: triggers a re-render when audit storage changes. */
export function subscribeAudit(handler) {
  const listener = () => handler();
  window.addEventListener("srtlab:audit", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("srtlab:audit", listener);
    window.removeEventListener("storage", listener);
  };
}
