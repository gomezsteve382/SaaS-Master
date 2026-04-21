import { useState, useCallback, useRef, useEffect } from "react";
import { ASSET_IDS } from "./lib/downloadAssets.js";
import { useDownloadCount } from "./lib/useDownloadCount.jsx";
import { buildOnePagerPDF } from "./lib/buildOnePagerPDF.js";
import { J2534_REF } from "./lib/tabReferences.js";
import {
  getStatus,
  open as bridgeOpen,
  connect as bridgeConnect,
  setFilter,
  sendMsg,
  readMsg,
  getAutelState,
  DEFAULT_BRIDGE_URL,
} from "./lib/bridgeClient.js";
import { REGISTRY } from "./lib/moduleRegistry.js";
import { useMasterVin } from "./lib/masterVinContext.jsx";
import { saveScanPlaceholders } from "./lib/audit.js";

/**
 * J2534 Module Scanner
 * Talks to the local j2534_bridge.py HTTP daemon (default http://localhost:8765)
 * via the shared bridgeClient. Same daemon the AUTEL SGW tab uses.
 *
 * Setup (on the laptop with the J2534 cable plugged in):
 *   1. Download j2534_bridge.py (button below)
 *   2. python j2534_bridge.py --dll <path-to-vendor-J2534-DLL>
 *   3. Click "Connect Bridge" here.
 */

const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;
const LAST_SCAN_KEY = "srtlab_j2534_lastscan";
// Legacy single-baseline key. Kept only for one-shot migration into the new
// multi-baseline store. New code reads/writes BASELINES_KEY + ACTIVE_BASELINE_KEY.
const BASELINE_SCAN_KEY = "srtlab_j2534_baseline";
const BASELINES_KEY = "srtlab_j2534_baselines";
const ACTIVE_BASELINE_KEY = "srtlab_j2534_baseline_active";

function loadScanFromKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.modules)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function loadLastScan() { return loadScanFromKey(LAST_SCAN_KEY); }
function saveLastScan(modules) {
  try {
    const payload = { ts: Date.now(), modules };
    localStorage.setItem(LAST_SCAN_KEY, JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}
function clearLastScan() {
  try { localStorage.removeItem(LAST_SCAN_KEY); } catch { /* ignore */ }
}

function newBaselineId() {
  return "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Pick the most common non-empty VIN across the scanned modules. Used as the
// default label when the user saves a new baseline.
function dominantVIN(modules) {
  if (!Array.isArray(modules)) return null;
  const counts = new Map();
  for (const m of modules) {
    const v = m && m.vin;
    if (typeof v === "string" && v.length >= 10) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

function loadBaselines() {
  let list = [];
  try {
    const raw = localStorage.getItem(BASELINES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed.filter(
          (b) => b && typeof b.id === "string" && Array.isArray(b.modules)
        );
      }
    }
  } catch { /* ignore */ }

  // One-shot migration of the legacy single-baseline key.
  try {
    const legacyRaw = localStorage.getItem(BASELINE_SCAN_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && Array.isArray(legacy.modules)) {
        const alreadyMigrated = list.some(
          (b) => b.ts === legacy.ts && b.modules.length === legacy.modules.length
        );
        if (!alreadyMigrated) {
          const vin = dominantVIN(legacy.modules);
          list.unshift({
            id: newBaselineId(),
            label: vin || "Baseline (migrated)",
            ts: legacy.ts || Date.now(),
            modules: legacy.modules,
          });
          try { localStorage.setItem(BASELINES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
        }
      }
      // Drop the legacy key so we don't migrate it again.
      try { localStorage.removeItem(BASELINE_SCAN_KEY); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return list;
}

function persistBaselines(list) {
  try { localStorage.setItem(BASELINES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// Wrapper format used by the export/import flow. Wrapping the baseline(s) in a
// tagged envelope lets us tell a baseline JSON apart from an unrelated file
// the tech might paste in by mistake, and gives us room to evolve the format.
const BASELINE_EXPORT_TYPE = "srtlab.j2534.baseline";
const BASELINE_EXPORT_VERSION = 1;

function buildBaselineExport(baselines) {
  return {
    type: BASELINE_EXPORT_TYPE,
    version: BASELINE_EXPORT_VERSION,
    exportedAt: Date.now(),
    baselines: baselines.map((b) => ({
      label: b.label,
      ts: b.ts,
      modules: b.modules,
    })),
  };
}

// Sanitize a label into something that's safe to use as a filename across
// Windows / macOS / Linux. Falls back to a generic name if nothing usable.
function baselineFilename(label, ts) {
  const safe = String(label || "baseline")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "baseline";
  const stamp = new Date(ts || Date.now())
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return `srtlab-baseline-${safe}-${stamp}.json`;
}

// Parse a pasted/dropped baseline export. Accepts either the wrapped envelope
// produced by buildBaselineExport, a bare baseline object, or an array of
// baselines. Returns an array of normalized {label, ts, modules} entries
// (without ids — the caller assigns fresh ones to avoid collisions).
function parseBaselineImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  let candidates = [];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && Array.isArray(parsed.baselines)) {
    if (parsed.type && parsed.type !== BASELINE_EXPORT_TYPE) {
      throw new Error(`Unrecognized export type "${parsed.type}".`);
    }
    candidates = parsed.baselines;
  } else if (parsed && Array.isArray(parsed.modules)) {
    candidates = [parsed];
  } else {
    throw new Error("JSON does not look like a baseline export.");
  }
  const out = [];
  for (const c of candidates) {
    if (!c || !Array.isArray(c.modules)) continue;
    out.push({
      label: typeof c.label === "string" && c.label.trim() ? c.label.trim() : "Imported baseline",
      ts: typeof c.ts === "number" ? c.ts : Date.now(),
      modules: c.modules,
    });
  }
  if (!out.length) throw new Error("No baselines with modules found in JSON.");
  return out;
}
function loadActiveBaselineId() {
  try { return localStorage.getItem(ACTIVE_BASELINE_KEY); } catch { return null; }
}
function persistActiveBaselineId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_BASELINE_KEY, id);
    else localStorage.removeItem(ACTIVE_BASELINE_KEY);
  } catch { /* ignore */ }
}

/**
 * Build a diff between a baseline scan and the current scan.
 * Modules are matched by `code` (falling back to name).
 *   - added:    in current, not in baseline
 *   - removed:  in baseline, not in current
 *   - changed:  in both, but VIN differs (null vs string also counts)
 *   - same:     in both, identical VIN
 */
function diffScans(baselineModules, currentModules) {
  const keyOf = (m) => (m.code || m.name || `0x${(m.tx || 0).toString(16)}`);
  const baseMap = new Map();
  for (const m of baselineModules || []) baseMap.set(keyOf(m), m);
  const curMap = new Map();
  for (const m of currentModules || []) curMap.set(keyOf(m), m);
  const added = [];
  const removed = [];
  const changed = [];
  const same = [];
  for (const [k, cur] of curMap) {
    const base = baseMap.get(k);
    if (!base) {
      added.push(cur);
    } else if ((base.vin || null) !== (cur.vin || null)) {
      changed.push({ baseline: base, current: cur });
    } else {
      same.push(cur);
    }
  }
  for (const [k, base] of baseMap) {
    if (!curMap.has(k)) removed.push(base);
  }
  return { added, removed, changed, same };
}
function fmtScanStamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-US", { hour12: false });
  } catch { return ""; }
}

function bytesToHex(arr) {
  return Array.from(arr)
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join("");
}
function hexToBytes(hex) {
  if (!hex) return [];
  const clean = String(hex).replace(/\s+/g, "");
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const b = parseInt(clean.substr(i, 2), 16);
    if (!isNaN(b)) out.push(b);
  }
  return out;
}

export default function J2534Scanner() {
  const [bridgeUrl, setBridgeUrl] = useState(() => getAutelState().url || DEFAULT_BRIDGE_URL);
  const [status, setStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);
  const [found, setFound] = useState(() => {
    const last = loadLastScan();
    return last ? last.modules : [];
  });
  const [lastScanTs, setLastScanTs] = useState(() => {
    const last = loadLastScan();
    return last ? last.ts : null;
  });
  const [scanIsRestored, setScanIsRestored] = useState(() => loadLastScan() !== null);
  const { vin: masterVin } = useMasterVin();
  const [baselines, setBaselines] = useState(() => loadBaselines());
  const [activeBaselineId, setActiveBaselineId] = useState(() => {
    const saved = loadActiveBaselineId();
    const list = loadBaselines();
    if (saved && list.some((b) => b.id === saved)) return saved;
    // Stale or missing pointer — pick the newest baseline if any, and write
    // that selection back to localStorage so the on-disk state matches what
    // the UI is showing.
    const fallback = list.length ? list[0].id : null;
    persistActiveBaselineId(fallback);
    return fallback;
  });
  const baseline = baselines.find((b) => b.id === activeBaselineId) || null;
  const [showDiff, setShowDiff] = useState(false);
  const [copyState, setCopyState] = useState("idle");
  const [sendState, setSendState] = useState("idle");
  const [scanning, setScanning] = useState(false);
  const [vendor, setVendor] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const logRef = useRef(null);
  // Track the (tx,rx) we last filtered on so we don't re-issue setFilter
  // for back-to-back UDS calls to the same module.
  const lastFilterRef = useRef({ tx: -1, rx: -1 });

  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try { await buildOnePagerPDF(J2534_REF); }
    catch (e) { console.error(e); alert('PDF build failed: ' + e.message); }
    finally { setPdfBusy(false); }
  };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Pick up URL changes the user makes on the AUTEL SGW tab while this
  // tab is mounted. Cheap poll — the SGW tab persists to localStorage.
  useEffect(() => {
    const t = setInterval(() => {
      const u = getAutelState().url || DEFAULT_BRIDGE_URL;
      setBridgeUrl((cur) => (cur === u ? cur : u));
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const log = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((p) => [...p.slice(-400), { ts, msg, type }]);
  }, []);

  const connectBridge = useCallback(async () => {
    log(`Probing local J2534 bridge at ${bridgeUrl} ...`);
    const st = await getStatus(bridgeUrl);
    if (!st || !st.ok) {
      log("Bridge connection failed: " + (st?.error || "no response"), "error");
      log("Start the daemon on this laptop, e.g.:", "error");
      log('  python j2534_bridge.py --dll "<path to vendor J2534 DLL>"', "error");
      return;
    }
    setVendor(st.vendor || null);
    log(`Bridge OK — vendor=${st.vendor || "?"} platform=${st.platform || "?"} bridge=${st.bridgeVersion || "?"}`, "success");
    if (st.dllPath) log(`  DLL: ${st.dllPath}`, "info");
    if (!st.dllLoaded || !st.dllPath) {
      log("Bridge has no DLL loaded — restart it with --dll <vendor J2534 DLL> or open will fail.", "warn");
    }
    if (st.deviceOpen && st.channelConnected) {
      setStatus("can_connected");
      log("Bridge already has device open + ISO15765 channel up — ready to scan.", "success");
    } else if (st.deviceOpen) {
      setStatus("device_open");
      log("Bridge already has device open — click Open J2534 Device to bring up the CAN channel.", "info");
    } else {
      setStatus("bridge_connected");
    }
  }, [bridgeUrl, log]);

  const openDevice = useCallback(async () => {
    try {
      log("Opening J2534 device (PassThruOpen) ...");
      const o = await bridgeOpen(bridgeUrl);
      if (!o.ok) {
        log("Device open failed: " + (o.error || "unknown"), "error");
        return;
      }
      log(`Device opened — id=${o.deviceId ?? "?"}${o.versions?.firmware ? " fw " + o.versions.firmware : ""}`, "success");
      setStatus("device_open");

      log("Connecting CAN channel (ISO15765 / 500 kbps) ...");
      const c = await bridgeConnect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, bridgeUrl);
      if (!c.ok) {
        log("CAN connect failed: " + (c.error || "unknown"), "error");
        return;
      }
      log("CAN bus up — ISO15765 500 kbps", "success");
      setStatus("can_connected");
      lastFilterRef.current = { tx: -1, rx: -1 };
    } catch (e) {
      log("Error: " + e.message, "error");
    }
  }, [bridgeUrl, log]);

  // Single UDS request/response over the HTTP bridge. Mirrors the
  // setfilter+sendmsg+readmsg loop used by lib/bridgeEngine.js.
  const udsExchange = useCallback(
    async (tx, rx, data, timeoutMs = 1500) => {
      if (lastFilterRef.current.tx !== tx || lastFilterRef.current.rx !== rx) {
        const f = await setFilter({ txId: tx, rxId: rx }, bridgeUrl);
        if (!f.ok) return { ok: false, error: "setFilter: " + (f.error || "failed") };
        lastFilterRef.current = { tx, rx };
      }
      const sm = await sendMsg(
        { txId: tx, data: bytesToHex(data), flags: ISO15765_FRAME_PAD, timeoutMs: 1000 },
        bridgeUrl
      );
      if (!sm.ok) return { ok: false, error: "sendMsg: " + (sm.error || "failed") };
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const slice = Math.min(1500, Math.max(150, remaining));
        const r = await readMsg({ timeoutMs: slice }, bridgeUrl);
        if (!r) return { ok: false, error: "readMsg: no response from bridge" };
        // Some daemon variants surface "no message in buffer" as ok:false with
        // an ERR_BUFFER_EMPTY / STATUS_NOERROR / "empty" marker — treat those
        // as "keep polling", not a hard failure. The shipped daemon returns
        // ok:true with msg:null for the same case, which falls through below.
        if (!r.ok) {
          const err = String(r.error || "").toLowerCase();
          if (err.includes("buffer_empty") || err.includes("buffer empty") ||
              err.includes("no msgs") || err.includes("no message") ||
              err.includes("status_noerror") || err === "empty") {
            continue;
          }
          return { ok: false, error: "readMsg: " + (r.error || "failed") };
        }
        const m = r.msg;
        if (!m || !m.data) continue;
        if (typeof m.canId === "number" && rx && m.canId !== rx) continue;
        const bytes = hexToBytes(m.data);
        if (!bytes.length) continue;
        // 7F xx 78 = response pending — keep waiting
        if (bytes.length >= 3 && bytes[0] === 0x7f && bytes[2] === 0x78) continue;
        return { ok: true, canId: m.canId, data: bytes };
      }
      return { ok: false, error: "timeout after " + timeoutMs + "ms" };
    },
    [bridgeUrl]
  );

  const sendUDS = useCallback(
    async (tx, rx, data, label) => {
      log(
        `TX [${label}] → 0x${tx.toString(16).toUpperCase()}: ${data
          .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
          .join(" ")}`,
        "tx"
      );
      const resp = await udsExchange(tx, rx, data, 3000);
      if (resp.ok) {
        log(
          `RX [${label}] ← 0x${(resp.canId || rx).toString(16).toUpperCase()}: ${resp.data
            .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
            .join(" ")}`,
          "rx"
        );
        return resp;
      }
      log(`[${label}] ${resp.error || "no response"}`, "warn");
      return null;
    },
    [udsExchange, log]
  );

  const readVIN = useCallback(
    async (tx, rx, name) => {
      const resp = await sendUDS(tx, rx, [0x22, 0xf1, 0x90], name);
      if (resp && resp.data) {
        const vinBytes = resp.data.filter((b) => b >= 0x20 && b <= 0x7e);
        const vin = String.fromCharCode(...vinBytes).slice(-17);
        if (vin.length >= 10) {
          log(`${name} VIN: ${vin}`, "success");
          return vin;
        }
      }
      return null;
    },
    [sendUDS, log]
  );

  // Client-side iteration over the shared module registry. For each row we
  // send a single 22 F1 90 (Read Data By Identifier — VIN) and accept any
  // reply as proof the module is on the bus: a positive 62 F1 90 yields the
  // VIN, an NRC (7F 22 xx) still confirms presence. The SGW row is excluded
  // because it does not own a F190 DID.
  const scanAll = useCallback(async () => {
    if (status !== "can_connected") {
      log("Not on CAN — open the device and connect first.", "error");
      return;
    }
    setScanning(true);
    setFound([]);
    setScanIsRestored(false);
    const collected = [];
    log("═══ Starting J2534 full module scan ═══", "header");
    log("Scanning known FCA module addresses via raw CAN ...");

    const targets = REGISTRY.filter((r) => r.kind !== "unsupported");
    let hits = 0;
    try {
    for (const row of targets) {
      log(
        `→ probe ${row.code} TX:0x${row.tx.toString(16).toUpperCase().padStart(3, "0")} RX:0x${row.rx
          .toString(16)
          .toUpperCase()
          .padStart(3, "0")}`,
        "scan"
      );
      // Single-step probe: send 22 F1 90 and accept ANY reply as proof
      // the module is on the bus. A positive 62 F1 90 ... yields the VIN;
      // a NRC (7F 22 xx) still proves the module is present.
      const v = await udsExchange(row.tx, row.rx, [0x22, 0xf1, 0x90], 1200);
      if (!v.ok) continue;
      hits++;
      let vin = null;
      const bytes = v.data || [];
      if (bytes.length >= 4 && bytes[0] === 0x62 && bytes[1] === 0xf1 && bytes[2] === 0x90) {
        const ascii = bytes.slice(3).filter((b) => b >= 0x20 && b <= 0x7e);
        const s = String.fromCharCode(...ascii).slice(-17);
        if (s.length >= 10) vin = s;
      }
      const hit = { code: row.code, name: row.name, tx: row.tx, rx: row.rx, vin };
      collected.push(hit);
      setFound((p) => [...p, hit]);
      log(
        `✓ ${row.name} (${row.code}) TX:0x${row.tx.toString(16).toUpperCase().padStart(3, "0")} RX:0x${row.rx
          .toString(16)
          .toUpperCase()
          .padStart(3, "0")}${vin ? " VIN:" + vin : ""}`,
        "success"
      );
    }
    log(
      `═══ Scan complete: ${hits} module${hits === 1 ? "" : "s"} found out of ${targets.length} probed ═══`,
      "header"
    );
    } catch (e) {
      log("Scan aborted: " + (e?.message || String(e)), "error");
    } finally {
      setScanning(false);
      const saved = saveLastScan(collected);
      if (saved) {
        setLastScanTs(saved.ts);
        log(`Scan saved to localStorage (${LAST_SCAN_KEY}).`, "info");
      }
    }
  }, [status, udsExchange, log]);

  const onSetBaseline = useCallback(() => {
    if (scanning) {
      log("Wait for the scan to finish before setting a baseline.", "warn");
      return;
    }
    if (!found.length) {
      log("No current scan to set as baseline.", "warn");
      return;
    }
    // Prefer the app's Master VIN (top-right input) for the label, since
    // that's the VIN the tech is actively working with for this job. Fall
    // back to the most common VIN observed in the scan, then to a generic
    // numbered label if neither is available.
    const masterVinTrim = (masterVin || "").trim();
    const fallback = `Baseline ${baselines.length + 1}`;
    const suggested =
      (masterVinTrim.length === 17 && masterVinTrim) ||
      dominantVIN(found) ||
      fallback;
    let label = "";
    try {
      label = window.prompt(
        "Label this baseline (VIN, RO #, customer name, etc.):",
        suggested
      );
    } catch {
      label = suggested;
    }
    if (label === null) {
      log("Set baseline cancelled.", "info");
      return;
    }
    label = String(label).trim() || suggested;
    const entry = {
      id: newBaselineId(),
      label,
      ts: lastScanTs || Date.now(),
      modules: found,
    };
    const next = [entry, ...baselines];
    setBaselines(next);
    persistBaselines(next);
    setActiveBaselineId(entry.id);
    persistActiveBaselineId(entry.id);
    log(
      `Baseline saved: "${label}" — ${entry.modules.length} module${entry.modules.length === 1 ? "" : "s"} (${next.length} total).`,
      "success"
    );
  }, [found, lastScanTs, baselines, scanning, masterVin, log]);

  const onSelectBaseline = useCallback((id) => {
    setActiveBaselineId(id || null);
    persistActiveBaselineId(id || null);
    if (!id) setShowDiff(false);
  }, []);

  const onDeleteBaseline = useCallback((id) => {
    const target = baselines.find((b) => b.id === id);
    if (!target) return;
    let confirmed = true;
    try {
      confirmed = window.confirm(
        `Delete baseline "${target.label}"? This cannot be undone.`
      );
    } catch { /* assume yes in non-browser */ }
    if (!confirmed) return;
    const next = baselines.filter((b) => b.id !== id);
    setBaselines(next);
    persistBaselines(next);
    if (activeBaselineId === id) {
      const newActive = next.length ? next[0].id : null;
      setActiveBaselineId(newActive);
      persistActiveBaselineId(newActive);
      if (!newActive) setShowDiff(false);
    }
    log(`Deleted baseline "${target.label}".`, "info");
  }, [baselines, activeBaselineId, log]);

  const onClearBaseline = useCallback(() => {
    if (activeBaselineId) onDeleteBaseline(activeBaselineId);
  }, [activeBaselineId, onDeleteBaseline]);

  const onRenameBaseline = useCallback((id) => {
    const target = baselines.find((b) => b.id === id);
    if (!target) return;
    let answer = null;
    try {
      answer = window.prompt(
        "Rename baseline (VIN, RO #, customer name, etc.):",
        target.label
      );
    } catch {
      answer = null;
    }
    if (answer === null) {
      log("Rename baseline cancelled.", "info");
      return;
    }
    const trimmed = String(answer).trim();
    // Empty/whitespace falls back to the previous label — no-op rename.
    if (!trimmed || trimmed === target.label) {
      if (!trimmed) log(`Rename ignored — kept "${target.label}".`, "info");
      return;
    }
    const next = baselines.map((b) =>
      b.id === id ? { ...b, label: trimmed } : b
    );
    setBaselines(next);
    persistBaselines(next);
    log(`Renamed baseline "${target.label}" → "${trimmed}".`, "success");
  }, [baselines, log]);

  const onExportBaseline = useCallback((id) => {
    const target = baselines.find((b) => b.id === id);
    if (!target) {
      log("No baseline selected to export.", "warn");
      return;
    }
    const payload = buildBaselineExport([target]);
    const json = JSON.stringify(payload, null, 2);
    let downloaded = false;
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = baselineFilename(target.label, target.ts);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      downloaded = true;
    } catch (e) {
      log(`Download failed: ${e?.message || e}. Falling back to clipboard.`, "warn");
    }
    if (downloaded) {
      // Best-effort copy to clipboard too, so the tech can paste into chat/email.
      try {
        if (navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(json).catch(() => {});
        }
      } catch { /* ignore */ }
      log(
        `Exported baseline "${target.label}" (${target.modules.length} module${target.modules.length === 1 ? "" : "s"}). Also copied JSON to clipboard.`,
        "success"
      );
    } else {
      try {
        if (navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(json);
          log(`Copied baseline "${target.label}" JSON to clipboard.`, "success");
        } else {
          window.prompt("Copy this baseline JSON:", json);
        }
      } catch {
        window.prompt("Copy this baseline JSON:", json);
      }
    }
  }, [baselines, log]);

  const onImportBaselinesFromText = useCallback((text) => {
    let imported;
    try {
      imported = parseBaselineImport(text);
    } catch (e) {
      log(`Import failed: ${e?.message || e}`, "error");
      return 0;
    }
    // Assign fresh ids so imports never collide with existing entries, even
    // if the same baseline gets imported twice.
    const fresh = imported.map((b) => ({
      id: newBaselineId(),
      label: b.label,
      ts: b.ts,
      modules: b.modules,
    }));
    const next = [...fresh, ...baselines];
    setBaselines(next);
    persistBaselines(next);
    // Make the first imported baseline the active one so the tech can
    // immediately diff against it.
    setActiveBaselineId(fresh[0].id);
    persistActiveBaselineId(fresh[0].id);
    log(
      `Imported ${fresh.length} baseline${fresh.length === 1 ? "" : "s"}: ${fresh.map((b) => `"${b.label}"`).join(", ")}.`,
      "success"
    );
    return fresh.length;
  }, [baselines, log]);

  const fileInputRef = useRef(null);
  const onPickImportFile = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);
  const onImportFileChange = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    // Always reset so picking the same file twice still fires onChange.
    if (e.target) e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onImportBaselinesFromText(text);
    };
    reader.onerror = () => {
      log(`Could not read file "${file.name}".`, "error");
    };
    reader.readAsText(file);
  }, [onImportBaselinesFromText, log]);

  const onPasteImport = useCallback(() => {
    let text = "";
    try {
      text = window.prompt("Paste baseline JSON to import:", "") || "";
    } catch {
      text = "";
    }
    if (!text.trim()) {
      log("Import cancelled.", "info");
      return;
    }
    onImportBaselinesFromText(text);
  }, [onImportBaselinesFromText, log]);

  const onClearLastScan = useCallback(() => {
    clearLastScan();
    setFound([]);
    setLastScanTs(null);
    setScanIsRestored(false);
    setShowDiff(false);
    log("Cleared saved scan.", "info");
  }, [log]);

  const onCopyJSON = useCallback(async () => {
    const payload = JSON.stringify(
      { ts: lastScanTs || Date.now(), modules: found },
      null,
      2
    );
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement("textarea");
        ta.value = payload;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch (e) {
      log("Copy failed: " + (e?.message || String(e)), "error");
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1500);
    }
  }, [found, lastScanTs, log]);

  const onSendToBackups = useCallback(async () => {
    if (!found.length || sendState === "sending") return;
    setSendState("sending");
    try {
      const r = await saveScanPlaceholders(found, { scanTs: lastScanTs || Date.now() });
      if (r.created === 0 && (r.duplicates?.length || 0) > 0) {
        log(`Send to BACKUPS: ${r.duplicates.length} placeholder(s) from this scan already in the backup library — opening BACKUPS tab.`, "info");
      } else {
        log(
          `Send to BACKUPS: created ${r.created} placeholder backup(s)` +
          (r.skipped ? " (" + r.skipped + " skipped)" : "") +
          (r.serverFailures ? " — " + r.serverFailures + " did not save to server (kept locally)" : "") +
          ".",
          r.serverFailures ? "warn" : "success",
        );
      }
      // Prefer a freshly created key; fall back to a duplicate from a prior
      // send so re-clicking still navigates and pre-selects something.
      const firstKey = r.keys[0] || r.duplicates?.[0] || null;
      if (firstKey) {
        try { localStorage.setItem("srtlab_pending_backup_select", firstKey); } catch { /* ignore */ }
      }
      try {
        window.dispatchEvent(new CustomEvent("srtlab:navigate", { detail: { tab: "backups", key: firstKey } }));
        window.dispatchEvent(new Event("srtlab:backupSelect"));
      } catch { /* ignore */ }
      setSendState("sent");
      setTimeout(() => setSendState("idle"), 1800);
    } catch (e) {
      log("Send to BACKUPS failed: " + (e?.message || String(e)), "error");
      setSendState("error");
      setTimeout(() => setSendState("idle"), 1800);
    }
  }, [found, lastScanTs, log, sendState]);

  const S = {
    bg: "#0A0A0F",
    card: "#12121A",
    border: "#1E1E2E",
    text: "#E0E0E0",
    dim: "#666",
    red: "#D32F2F",
    green: "#2E7D32",
    blue: "#1565C0",
    font: "'JetBrains Mono', 'Fira Code', monospace",
  };

  const logColors = {
    info: "#B0BEC5",
    success: "#66BB6A",
    error: "#EF5350",
    warn: "#FFB74D",
    tx: "#42A5F5",
    rx: "#66BB6A",
    scan: "#CE93D8",
    header: "#FFD600",
  };

  const Btn = ({ onClick, disabled, color, children }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 20px",
        background: disabled ? "#333" : color || S.red,
        color: "#fff",
        border: "none",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: S.font,
        fontWeight: 700,
        fontSize: 13,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ background: S.bg, minHeight: "100%", padding: 20, fontFamily: S.font, color: S.text }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span style={{ fontSize: 24, fontWeight: 900, color: S.red }}>⚡ J2534</span>
          <span style={{ fontSize: 13, color: S.dim }}>RAW CAN MODULE SCANNER</span>
          <div
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              background: status === "can_connected" ? S.green : "#333",
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            {status === "disconnected" && "○ NO BRIDGE"}
            {status === "bridge_connected" && "● BRIDGE OK"}
            {status === "device_open" && "● DEVICE OPEN"}
            {status === "can_connected" && "● CAN LIVE"}
          </div>
          <button onClick={onPdf} disabled={pdfBusy} style={{marginLeft:8,padding:'6px 12px',background:pdfBusy?'#333':'#fff',color:pdfBusy?'#666':S.red,border:'2px solid '+S.red,borderRadius:6,cursor:pdfBusy?'wait':'pointer',fontFamily:S.font,fontWeight:700,fontSize:11,letterSpacing:.5}}>
            {pdfBusy?'⏳ Building...':'🖨 Print Reference'}
          </button>
        </div>

        {/* Download bridge script */}
        <div style={{ background: "#0D1A0D", border: "1px solid #2E7D32", borderRadius: 8, padding: 14, marginBottom: 14, fontSize: 12 }}>
          <div style={{ color: "#66BB6A", fontWeight: 700, marginBottom: 6 }}>STEP 0 — DOWNLOAD BRIDGE SCRIPT</div>
          <div style={{ color: S.dim, lineHeight: 1.8 }}>
            The J2534 bridge runs locally on your laptop and exposes the adapter to the browser via a local HTTP server (default <span style={{color:'#fff'}}>http://localhost:8765</span>). Same daemon the AUTEL SGW tab uses.
          </div>
          <div style={{ marginTop: 8 }}>
            <BridgeDownloadLink S={S} />
            <span style={{ color: S.dim, marginLeft: 12 }}>
              then: <span style={{color:'#fff'}}>python j2534_bridge.py --dll &lt;path-to-vendor-J2534-DLL&gt;</span>
            </span>
          </div>
        </div>

        {/* Setup instructions */}
        {status === "disconnected" && (
          <div style={{ background: "#1A1A2E", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16, fontSize: 12 }}>
            <div style={{ color: S.red, fontWeight: 700, marginBottom: 8 }}>SETUP</div>
            <div style={{ color: S.dim, lineHeight: 1.8 }}>
              1. Download j2534_bridge.py above (Python 3.8+, no pip packages required)<br />
              2. Open a terminal on your laptop<br />
              3. Run: <span style={{ color: "#fff" }}>python j2534_bridge.py --dll "&lt;path to vendor J2534 DLL&gt;"</span><br />
              &nbsp;&nbsp;&nbsp;&nbsp;e.g. Autel: <span style={{ color: "#fff" }}>--dll "C:\Program Files (x86)\Autel\MaxiPC\MaxiFlashJ2534.dll"</span><br />
              4. Plug your J2534 adapter (Autel MaxiFlash, etc.) into the vehicle and the laptop USB<br />
              5. Bridge URL (from AUTEL SGW tab): <span style={{ color: "#fff" }}>{bridgeUrl}</span><br />
              6. Click "Connect Bridge" below
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {status === "disconnected" && <Btn onClick={connectBridge} color={S.blue}>🔌 Connect Bridge</Btn>}
          {status === "bridge_connected" && <Btn onClick={openDevice} color={S.blue}>📡 Open J2534 Device</Btn>}
          {status === "device_open" && <Btn onClick={openDevice} color={S.blue}>📡 Connect CAN Channel</Btn>}
          {status === "can_connected" && (
            <>
              <Btn onClick={scanAll} disabled={scanning} color={S.red}>
                {scanning ? "⏳ Scanning..." : "🚀 SCAN ALL MODULES"}
              </Btn>
              <Btn onClick={() => readVIN(0x7e0, 0x7e8, "ECM")} color="#333">
                Read ECM VIN
              </Btn>
              <Btn onClick={() => readVIN(0x750, 0x758, "BCM")} color="#333">
                Read BCM VIN
              </Btn>
              <Btn onClick={() => readVIN(0x742, 0x762, "BCM_ALT")} color="#333">
                Read BCM 0x742
              </Btn>
            </>
          )}
        </div>

        {/* Import-only bar — shown on a fresh laptop that hasn't scanned yet,
            so a tech can pull in a baseline JSON shared from another machine
            before they connect the cable. */}
        {!(found.length > 0 || lastScanTs) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 11, color: S.dim }}>
            <span>📌 baselines:</span>
            <span style={{ color: "#fff" }}>
              {baselines.length} saved
            </span>
            <button
              onClick={onPickImportFile}
              style={{
                padding: "4px 10px",
                background: "#1E1E2E",
                color: "#42A5F5",
                border: "1px solid " + S.border,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: S.font,
                fontSize: 11,
                fontWeight: 700,
              }}
              title="Import a baseline JSON file shared by another laptop"
            >
              📥 IMPORT FILE
            </button>
            <button
              onClick={onPasteImport}
              style={{
                padding: "4px 10px",
                background: "#1E1E2E",
                color: "#42A5F5",
                border: "1px solid " + S.border,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: S.font,
                fontSize: 11,
                fontWeight: 700,
              }}
              title="Paste baseline JSON (e.g. copied from chat or email)"
            >
              📋 PASTE
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={onImportFileChange}
              style={{ display: "none" }}
            />
          </div>
        )}

        {/* Found modules */}
        {(found.length > 0 || lastScanTs) && (
          <div style={{ background: "#1A2E1A", border: "1px solid " + S.green, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#66BB6A" }}>
                MODULES FOUND: {found.length}
              </div>
              {lastScanTs && (
                <div style={{ fontSize: 11, color: S.dim }}>
                  scanned at <span style={{ color: "#fff" }}>{fmtScanStamp(lastScanTs)}</span>
                  {scanIsRestored && !scanning && " (loaded from last session)"}
                </div>
              )}
              {baselines.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#42A5F5" }}>
                  <span>📌 baseline:</span>
                  <select
                    value={activeBaselineId || ""}
                    onChange={(e) => onSelectBaseline(e.target.value || null)}
                    style={{
                      background: "#1E1E2E",
                      color: "#fff",
                      border: "1px solid " + S.border,
                      borderRadius: 4,
                      padding: "2px 6px",
                      fontFamily: S.font,
                      fontSize: 11,
                      maxWidth: 260,
                    }}
                    title="Switch which baseline the diff compares against"
                  >
                    <option value="">— none —</option>
                    {baselines.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} · {b.modules.length} mod · {fmtScanStamp(b.ts)}
                      </option>
                    ))}
                  </select>
                  {baseline && (
                    <>
                      <button
                        onClick={() => onRenameBaseline(baseline.id)}
                        style={{
                          padding: "2px 6px",
                          background: "transparent",
                          color: "#42A5F5",
                          border: "1px solid " + S.border,
                          borderRadius: 4,
                          cursor: "pointer",
                          fontFamily: S.font,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                        title={`Rename baseline "${baseline.label}"`}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => onExportBaseline(baseline.id)}
                        style={{
                          padding: "2px 6px",
                          background: "transparent",
                          color: "#42A5F5",
                          border: "1px solid " + S.border,
                          borderRadius: 4,
                          cursor: "pointer",
                          fontFamily: S.font,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                        title={`Export baseline "${baseline.label}" as JSON (download + clipboard)`}
                      >
                        ⬇ EXPORT
                      </button>
                      <button
                        onClick={() => onDeleteBaseline(baseline.id)}
                        style={{
                          padding: "2px 6px",
                          background: "transparent",
                          color: "#EF5350",
                          border: "1px solid " + S.border,
                          borderRadius: 4,
                          cursor: "pointer",
                          fontFamily: S.font,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                        title={`Delete baseline "${baseline.label}"`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  onClick={onSetBaseline}
                  disabled={!found.length || scanning}
                  style={{
                    padding: "4px 10px",
                    background: "#1E1E2E",
                    color: found.length && !scanning ? "#42A5F5" : S.dim,
                    border: "1px solid " + S.border,
                    borderRadius: 4,
                    cursor: found.length && !scanning ? "pointer" : "not-allowed",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                  title="Save current scan as a new labeled baseline (you can keep multiple jobs side by side)"
                >
                  📌 SAVE BASELINE
                </button>
                <button
                  onClick={onPickImportFile}
                  style={{
                    padding: "4px 10px",
                    background: "#1E1E2E",
                    color: "#42A5F5",
                    border: "1px solid " + S.border,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                  title="Import a baseline JSON file shared by another laptop"
                >
                  📥 IMPORT FILE
                </button>
                <button
                  onClick={onPasteImport}
                  style={{
                    padding: "4px 10px",
                    background: "#1E1E2E",
                    color: "#42A5F5",
                    border: "1px solid " + S.border,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                  title="Paste baseline JSON (e.g. copied from chat or email)"
                >
                  📋 PASTE
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={onImportFileChange}
                  style={{ display: "none" }}
                />
                {baseline && (
                  <button
                    onClick={() => setShowDiff((v) => !v)}
                    style={{
                      padding: "4px 10px",
                      background: showDiff ? S.blue : "#1E1E2E",
                      color: "#fff",
                      border: "1px solid " + S.border,
                      borderRadius: 4,
                      cursor: "pointer",
                      fontFamily: S.font,
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                    title="Compare current scan against the saved baseline"
                  >
                    {showDiff ? "▼ HIDE DIFF" : "🔀 COMPARE TO BASELINE"}
                  </button>
                )}
                <button
                  onClick={onCopyJSON}
                  style={{
                    padding: "4px 10px",
                    background: copyState === "copied" ? S.green : "#1E1E2E",
                    color: "#fff",
                    border: "1px solid " + S.border,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                  title="Copy scan as JSON for the BACKUPS tab or a bug report"
                >
                  {copyState === "copied" ? "✓ COPIED" : copyState === "error" ? "✗ ERROR" : "📋 COPY AS JSON"}
                </button>
                <button
                  onClick={onSendToBackups}
                  data-testid="send-scan-to-backups"
                  disabled={sendState === "sending"}
                  style={{
                    padding: "4px 10px",
                    background: sendState === "sent" ? S.green : sendState === "error" ? S.red : "#1E1E2E",
                    color: "#fff",
                    border: "1px solid " + (sendState === "sent" ? S.green : S.border),
                    borderRadius: 4,
                    cursor: sendState === "sending" ? "wait" : "pointer",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                    opacity: sendState === "sending" ? 0.6 : 1,
                  }}
                  title="Create per-module placeholder backups from this scan and open the BACKUPS tab"
                >
                  {sendState === "sent"
                    ? "✓ SENT"
                    : sendState === "error"
                      ? "✗ ERROR"
                      : sendState === "sending"
                        ? "⏳ SENDING..."
                        : "📂 SEND TO BACKUPS"}
                </button>
                <button
                  onClick={onClearLastScan}
                  style={{
                    padding: "4px 10px",
                    background: "#1E1E2E",
                    color: "#FFB74D",
                    border: "1px solid " + S.border,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: S.font,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                  title="Clear saved scan from localStorage"
                >
                  🗑 CLEAR
                </button>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {found.map((m, i) => (
                <div key={i} style={{ background: "#0D1F0D", border: "1px solid #388E3C", borderRadius: 4, padding: "6px 10px", fontSize: 11 }}>
                  <span style={{ color: "#FFD600", fontWeight: 700 }}>{m.code || m.name}</span>
                  <span style={{ color: S.dim, marginLeft: 8 }}>
                    TX:0x{m.tx.toString(16).toUpperCase().padStart(3, "0")}
                  </span>
                  <span style={{ color: S.dim, marginLeft: 4 }}>
                    RX:0x{m.rx.toString(16).toUpperCase().padStart(3, "0")}
                  </span>
                  {m.vin && <span style={{ color: "#fff", marginLeft: 8 }}>{m.vin}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Diff vs baseline */}
        {showDiff && baseline && (
          <DiffPanel
            S={S}
            baseline={baseline}
            current={{ ts: lastScanTs, modules: found }}
            onClearBaseline={onClearBaseline}
          />
        )}

        {/* Log */}
        <div
          ref={logRef}
          style={{
            background: S.card,
            border: "1px solid " + S.border,
            borderRadius: 8,
            padding: 8,
            height: 450,
            overflowY: "auto",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          {logs.map((l, i) => (
            <div key={i} style={{ borderBottom: "1px solid #111", display: "flex", gap: 8 }}>
              <span style={{ color: S.dim, minWidth: 55, flexShrink: 0 }}>{l.ts}</span>
              <span style={{ color: logColors[l.type] || S.text }}>{l.msg}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div style={{ color: S.dim, padding: 20, textAlign: "center" }}>
              Download j2534_bridge.py, run it with --dll, then click Connect Bridge
            </div>
          )}
        </div>

        {vendor && (
          <div style={{ marginTop: 8, fontSize: 10, color: S.dim }}>
            J2534 vendor: {vendor}
          </div>
        )}
      </div>
    </div>
  );
}

function buildDiffReportText(baseline, current, diff) {
  const fmtTx = (m) => `0x${(m.tx || 0).toString(16).toUpperCase().padStart(3, "0")}`;
  const lines = [];
  lines.push("SRT LAB \u2014 BASELINE vs CURRENT DIFF REPORT");
  lines.push("=".repeat(56));
  lines.push(`Baseline scan : ${fmtScanStamp(baseline.ts) || "(unknown)"}  (${baseline.modules.length} modules)`);
  lines.push(`Current scan  : ${fmtScanStamp(current.ts) || "(unsaved)"}  (${current.modules.length} modules)`);
  lines.push("");
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("No differences \u2014 current scan matches baseline exactly.");
  }
  if (diff.added.length) {
    lines.push(`+ ADDED MODULES (${diff.added.length})`);
    diff.added.forEach((m) => {
      lines.push(`  + ${m.code || m.name}  TX:${fmtTx(m)}${m.vin ? "  VIN: " + m.vin : ""}`);
    });
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push(`- REMOVED MODULES (${diff.removed.length})`);
    diff.removed.forEach((m) => {
      lines.push(`  - ${m.code || m.name}  TX:${fmtTx(m)}${m.vin ? "  VIN: " + m.vin : ""}`);
    });
    lines.push("");
  }
  if (diff.changed.length) {
    lines.push(`+/- CHANGED VINs (${diff.changed.length})`);
    diff.changed.forEach((c) => {
      lines.push(`  ${c.current.code || c.current.name}  TX:${fmtTx(c.current)}`);
      lines.push(`    - ${c.baseline.vin || "(no VIN)"}`);
      lines.push(`    + ${c.current.vin || "(no VIN)"}`);
    });
    lines.push("");
  }
  if (diff.same.length) {
    lines.push(`${diff.same.length} module${diff.same.length === 1 ? "" : "s"} unchanged.`);
  }
  return lines.join("\n");
}

async function exportDiffReportPDF(baseline, current, diff) {
  const fmtTx = (m) => `0x${(m.tx || 0).toString(16).toUpperCase().padStart(3, "0")}`;
  const sections = [];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    sections.push({
      label: "RESULT",
      type: "bullets",
      data: ["No differences \u2014 current scan matches baseline exactly."],
    });
  }
  if (diff.added.length) {
    sections.push({
      label: `+ ADDED MODULES (${diff.added.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "VIN"],
        rows: diff.added.map((m) => [m.code || m.name || "", fmtTx(m), m.vin || ""]),
        colors: ["#2E7D32", "__mono__", "#1A1A1A"],
      },
    });
  }
  if (diff.removed.length) {
    sections.push({
      label: `- REMOVED MODULES (${diff.removed.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "VIN"],
        rows: diff.removed.map((m) => [m.code || m.name || "", fmtTx(m), m.vin || ""]),
        colors: ["#C62828", "__mono__", "#1A1A1A"],
      },
    });
  }
  if (diff.changed.length) {
    sections.push({
      label: `+/- CHANGED VINs (${diff.changed.length})`,
      type: "rows",
      data: {
        headers: ["MODULE", "TX", "BASELINE VIN", "CURRENT VIN"],
        rows: diff.changed.map((c) => [
          c.current.code || c.current.name || "",
          fmtTx(c.current),
          c.baseline.vin || "(none)",
          c.current.vin || "(none)",
        ]),
        colors: ["#1A1A1A", "__mono__", "#C62828", "#2E7D32"],
      },
    });
  }
  if (diff.same.length) {
    sections.push({
      label: "UNCHANGED",
      type: "bullets",
      data: [`${diff.same.length} module${diff.same.length === 1 ? "" : "s"} unchanged.`],
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await buildOnePagerPDF({
    filename: `SRT_Lab_Diff_Report_${stamp}.pdf`,
    title: "BASELINE vs CURRENT DIFF",
    subtitle: "Scan comparison report",
    version: new Date().toLocaleDateString(),
    intro: [
      `Baseline scan: ${fmtScanStamp(baseline.ts) || "(unknown)"}  \u00B7  ${baseline.modules.length} modules`,
      `Current scan : ${fmtScanStamp(current.ts) || "(unsaved)"}  \u00B7  ${current.modules.length} modules`,
    ],
    sections,
    footer: "SRT Lab \u00B7 Diff Report \u00B7 For authorized service use only",
  });
}

function DiffPanel({ S, baseline, current, onClearBaseline }) {
  const diff = diffScans(baseline.modules, current.modules);
  const fmtTx = (m) => `0x${(m.tx || 0).toString(16).toUpperCase().padStart(3, "0")}`;
  const noChanges = !diff.added.length && !diff.removed.length && !diff.changed.length;
  const [copyState, setCopyState] = useState("idle");
  const [pdfState, setPdfState] = useState("idle");
  const [emailState, setEmailState] = useState("idle");
  const handleCopyText = async () => {
    try {
      const txt = buildDiffReportText(baseline, current, diff);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
      } else {
        const ta = document.createElement("textarea");
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("ok");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("err");
      setTimeout(() => setCopyState("idle"), 1500);
    }
  };
  const handleEmailReport = async () => {
    setEmailState("working");
    try {
      const txt = buildDiffReportText(baseline, current, diff);
      const stamp = fmtScanStamp(current.ts) || new Date().toLocaleString();
      const subject = `SRT Lab Diff Report \u2014 ${baseline.label || "baseline"} \u2192 ${stamp}`;
      const summary = [];
      if (diff.added.length) summary.push(`${diff.added.length} added`);
      if (diff.removed.length) summary.push(`${diff.removed.length} removed`);
      if (diff.changed.length) summary.push(`${diff.changed.length} VIN change${diff.changed.length === 1 ? "" : "s"}`);
      const summaryLine = summary.length ? summary.join(", ") : "no differences";
      const body = [
        `Diff summary: ${summaryLine}.`,
        `The full PDF report has been downloaded to this machine \u2014 please attach "SRT_Lab_Diff_Report_*.pdf" to this message before sending.`,
        "",
        "------ PLAIN-TEXT DIFF ------",
        txt,
      ].join("\n");
      try { await exportDiffReportPDF(baseline, current, diff); } catch {}
      const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      if (mailto.length > 1900) {
        const shortBody = [
          `Diff summary: ${summaryLine}.`,
          `Full PDF report has been downloaded \u2014 please attach "SRT_Lab_Diff_Report_*.pdf" before sending.`,
          "(Plain-text diff omitted because it exceeded the email-link size limit. See the attached PDF for full details.)",
        ].join("\n");
        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(shortBody)}`;
      } else {
        window.location.href = mailto;
      }
      setEmailState("ok");
      setTimeout(() => setEmailState("idle"), 1500);
    } catch {
      setEmailState("err");
      setTimeout(() => setEmailState("idle"), 1500);
    }
  };
  const handleSavePDF = async () => {
    setPdfState("working");
    try {
      await exportDiffReportPDF(baseline, current, diff);
      setPdfState("ok");
      setTimeout(() => setPdfState("idle"), 1500);
    } catch {
      setPdfState("err");
      setTimeout(() => setPdfState("idle"), 1500);
    }
  };
  const sectionTitle = (color, label, count) => (
    <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 6, marginTop: 10, letterSpacing: 0.5 }}>
      {label} ({count})
    </div>
  );
  const row = (bgColor, borderColor, content, key) => (
    <div
      key={key}
      style={{
        background: bgColor,
        border: "1px solid " + borderColor,
        borderRadius: 4,
        padding: "6px 10px",
        fontSize: 11,
        marginBottom: 4,
      }}
    >
      {content}
    </div>
  );
  return (
    <div style={{ background: "#0F1626", border: "1px solid #2A3F66", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#42A5F5" }}>
          🔀 BASELINE vs CURRENT
        </div>
        <div style={{ fontSize: 11, color: S.dim }}>
          baseline: <span style={{ color: "#fff" }}>{baseline.label || "(unlabeled)"}</span> · <span style={{ color: "#fff" }}>{fmtScanStamp(baseline.ts)}</span> ({baseline.modules.length} mod) →
          current: <span style={{ color: "#fff" }}>{fmtScanStamp(current.ts) || "(unsaved)"}</span> ({current.modules.length} mod)
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={handleSavePDF}
            disabled={pdfState === "working"}
            style={{
              padding: "4px 10px",
              background: pdfState === "ok" ? "#1B5E20" : "#0D2A4A",
              color: "#90CAF9",
              border: "1px solid " + S.border,
              borderRadius: 4,
              cursor: pdfState === "working" ? "wait" : "pointer",
              fontFamily: S.font,
              fontSize: 11,
              fontWeight: 700,
            }}
            title="Save this diff as a printable PDF report"
          >
            {pdfState === "working" ? "… BUILDING" : pdfState === "ok" ? "✓ SAVED" : pdfState === "err" ? "✗ ERROR" : "📄 SAVE DIFF REPORT"}
          </button>
          <button
            onClick={handleEmailReport}
            disabled={emailState === "working"}
            style={{
              padding: "4px 10px",
              background: emailState === "ok" ? "#1B5E20" : "#0D2A4A",
              color: "#90CAF9",
              border: "1px solid " + S.border,
              borderRadius: 4,
              cursor: emailState === "working" ? "wait" : "pointer",
              fontFamily: S.font,
              fontSize: 11,
              fontWeight: 700,
            }}
            title="Open a prefilled email draft with the diff summary; PDF is downloaded so you can attach it"
          >
            {emailState === "working" ? "… PREPARING" : emailState === "ok" ? "✓ DRAFTED" : emailState === "err" ? "✗ ERROR" : "✉ EMAIL REPORT"}
          </button>
          <button
            onClick={handleCopyText}
            style={{
              padding: "4px 10px",
              background: copyState === "ok" ? "#1B5E20" : "#1E1E2E",
              color: "#A5D6A7",
              border: "1px solid " + S.border,
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: S.font,
              fontSize: 11,
              fontWeight: 700,
            }}
            title="Copy the diff report as plain text"
          >
            {copyState === "ok" ? "✓ COPIED" : copyState === "err" ? "✗ ERROR" : "📋 COPY AS TEXT"}
          </button>
          <button
            onClick={onClearBaseline}
            style={{
              padding: "4px 10px",
              background: "#1E1E2E",
              color: "#FFB74D",
              border: "1px solid " + S.border,
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: S.font,
              fontSize: 11,
              fontWeight: 700,
            }}
            title="Delete the active baseline"
          >
            🗑 DELETE BASELINE
          </button>
        </div>
      </div>
      {noChanges && (
        <div style={{ fontSize: 11, color: "#66BB6A", padding: "8px 0" }}>
          ✓ No differences — current scan matches baseline exactly.
        </div>
      )}
      {diff.added.length > 0 && (
        <>
          {sectionTitle("#66BB6A", "+ ADDED MODULES", diff.added.length)}
          {diff.added.map((m, i) =>
            row("#0D1F0D", "#388E3C", (
              <>
                <span style={{ color: "#FFD600", fontWeight: 700 }}>{m.code || m.name}</span>
                <span style={{ color: S.dim, marginLeft: 8 }}>TX:{fmtTx(m)}</span>
                {m.vin && <span style={{ color: "#66BB6A", marginLeft: 8 }}>VIN: {m.vin}</span>}
                <span style={{ color: "#66BB6A", marginLeft: 8, fontWeight: 700 }}>+ NEW</span>
              </>
            ), `a${i}`)
          )}
        </>
      )}
      {diff.removed.length > 0 && (
        <>
          {sectionTitle("#EF5350", "− REMOVED MODULES", diff.removed.length)}
          {diff.removed.map((m, i) =>
            row("#1F0D0D", "#C62828", (
              <>
                <span style={{ color: "#FFD600", fontWeight: 700, textDecoration: "line-through" }}>{m.code || m.name}</span>
                <span style={{ color: S.dim, marginLeft: 8 }}>TX:{fmtTx(m)}</span>
                {m.vin && <span style={{ color: "#EF5350", marginLeft: 8, textDecoration: "line-through" }}>VIN: {m.vin}</span>}
                <span style={{ color: "#EF5350", marginLeft: 8, fontWeight: 700 }}>− GONE</span>
              </>
            ), `r${i}`)
          )}
        </>
      )}
      {diff.changed.length > 0 && (
        <>
          {sectionTitle("#FFB74D", "± CHANGED VINs", diff.changed.length)}
          {diff.changed.map((c, i) =>
            row("#1F1A0D", "#F57C00", (
              <div>
                <div>
                  <span style={{ color: "#FFD600", fontWeight: 700 }}>{c.current.code || c.current.name}</span>
                  <span style={{ color: S.dim, marginLeft: 8 }}>TX:{fmtTx(c.current)}</span>
                </div>
                <div style={{ marginTop: 4, fontFamily: S.font }}>
                  <span style={{ color: "#EF5350" }}>− {c.baseline.vin || "(no VIN)"}</span>
                </div>
                <div style={{ fontFamily: S.font }}>
                  <span style={{ color: "#66BB6A" }}>+ {c.current.vin || "(no VIN)"}</span>
                </div>
              </div>
            ), `c${i}`)
          )}
        </>
      )}
      {diff.same.length > 0 && (
        <div style={{ fontSize: 11, color: S.dim, marginTop: 10 }}>
          {diff.same.length} module{diff.same.length === 1 ? "" : "s"} unchanged
        </div>
      )}
    </div>
  );
}

function BridgeDownloadLink({ S }) {
  const [count, track] = useDownloadCount(ASSET_IDS.j2534Bridge);
  return (
    <>
      <a
        href="j2534_bridge.py"
        download="j2534_bridge.py"
        onClick={() => track()}
        style={{
          display: "inline-block",
          padding: "8px 16px",
          background: "#2E7D32",
          color: "#fff",
          borderRadius: 6,
          textDecoration: "none",
          fontWeight: 700,
          fontSize: 12,
          fontFamily: S.font,
        }}
      >
        ⬇ Download j2534_bridge.py
      </a>
      {count > 0 && (
        <span style={{ color: S.dim, marginLeft: 12, fontSize: 11 }}>
          ⬇ {count.toLocaleString()} download{count === 1 ? "" : "s"} globally
        </span>
      )}
    </>
  );
}
