import { useState, useCallback, useRef, useEffect } from "react";
import { getStatus, open as openBridge, connect as bridgeConnect, setFilter, sendMsg, readMsg, getAutelState, setAutelState } from "../lib/bridgeClient.js";
import { decodeNRC } from "../lib/nrc.js";
import { ALGOS, unlockKeyBytes, pickUnlockChain } from "../lib/algos.js";
import { loadDidDescriptions, getAllDids } from "../lib/dids.js";

/* ─── localStorage key for remembered algo per TX address ──────────────────── */
const saStorageKey = (txHex) => `sa_algo_${txHex.toLowerCase().replace(/\s/g, "")}`;

/* ─── FCA module address table (mirrors J2534Scanner.jsx) ─────────────────── */
const FCA_MODULES = [
  { name: "ECM",         tx: 0x7E0, rx: 0x7E8 },
  { name: "TCM",         tx: 0x7E1, rx: 0x7E9 },
  { name: "DTCM",        tx: 0x7E2, rx: 0x7EA },
  { name: "BPCM",        tx: 0x7E4, rx: 0x7EC },
  { name: "BCM",         tx: 0x750, rx: 0x758 },
  { name: "RFHUB",       tx: 0x75F, rx: 0x767 },
  { name: "ABS",         tx: 0x760, rx: 0x768 },
  { name: "IPC",         tx: 0x740, rx: 0x748 },
  { name: "ORC",         tx: 0x758, rx: 0x760 },
  { name: "ADCM",        tx: 0x7A8, rx: 0x7B0 },
  { name: "AMP",         tx: 0x7A0, rx: 0x7A8 },
  { name: "BSM",         tx: 0x770, rx: 0x778 },
  { name: "EPS",         tx: 0x761, rx: 0x769 },
  { name: "RADIO",       tx: 0x772, rx: 0x77A },
  { name: "HVAC",        tx: 0x751, rx: 0x759 },
  { name: "TPMS",        tx: 0x752, rx: 0x75A },
  { name: "SCCM",        tx: 0x74D, rx: 0x76D },
  { name: "TIPM",        tx: 0x74C, rx: 0x76C },
  { name: "SKREEM",      tx: 0x75A, rx: 0x77A },
  { name: "BSM_RDR",     tx: 0x771, rx: 0x779 },
  { name: "TPMS_SENS",   tx: 0x718, rx: 0x720 },
  { name: "OCS_SENS",    tx: 0x728, rx: 0x730 },
  { name: "ECM_W7",      tx: 0x7E5, rx: 0x7ED },
  { name: "TCM_W7",      tx: 0x7E6, rx: 0x7EE },
  { name: "BCM_W7",      tx: 0x7B2, rx: 0x7BA },
  { name: "BCM_DVIN",    tx: 0x6B0, rx: 0x6B8 },
  { name: "CCM",         tx: 0x743, rx: 0x763 },
  { name: "ADM",         tx: 0x744, rx: 0x764 },
  { name: "IPCM",        tx: 0x746, rx: 0x766 },
  { name: "DDM",         tx: 0x748, rx: 0x768 },
  { name: "PDM",         tx: 0x749, rx: 0x769 },
  { name: "EPS_ALT",     tx: 0x74A, rx: 0x76A },
  { name: "SCCM_ALT",    tx: 0x74B, rx: 0x76B },
  { name: "TPMS_ALT",    tx: 0x74E, rx: 0x76E },
  { name: "BCM_ALT",     tx: 0x742, rx: 0x762 },
  { name: "IPC_ALT",     tx: 0x745, rx: 0x765 },
  { name: "RADIO_ALT",   tx: 0x754, rx: 0x75C },
  { name: "RADIO_753",   tx: 0x753, rx: 0x773 },
  { name: "BCM_SWARM",   tx: 0x7B0, rx: 0x7B8 },
  { name: "IPC_SWARM",   tx: 0x720, rx: 0x728 },
  { name: "RFHUB_SWARM", tx: 0x762, rx: 0x76A },
  { name: "RADIO_SWARM", tx: 0x7D0, rx: 0x7D8 },
  { name: "ORC_SWARM",   tx: 0x730, rx: 0x738 },
  { name: "REAR_AXLE",   tx: 0x6C0, rx: 0x6C8 },
  { name: "ACC",         tx: 0x700, rx: 0x708 },
  { name: "BCM_PNET",    tx: 0x620, rx: 0x628 },
  { name: "SKIM_PNET",   tx: 0x741, rx: 0x749 },
  { name: "RADIO_PNET",  tx: 0x7C8, rx: 0x7D0 },
  { name: "HVAC_PNET",   tx: 0x688, rx: 0x690 },
];

const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;

/* ─── Quick-launch command definitions ───────────────────────────────────── */
const QUICK_CMDS = [
  { label: "Read VIN",      bytes: [0x22, 0xF1, 0x90] },
  { label: "Ext Session",   bytes: [0x10, 0x03] },
  { label: "Tester Present",bytes: [0x3E, 0x02] },
  { label: "ECU Reset",     bytes: [0x11, 0x01] },
  { label: "Read DTCs",     bytes: [0x19, 0x02, 0x08] },
  { label: "Clear DTCs",    bytes: [0x14, 0xFF, 0xFF, 0xFF] },
];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function hx(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, "0"); }
function hexToBytes(s) {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  return out;
}
function bytesToHex(arr) {
  return Array.from(arr).map(b => hx(b)).join(" ");
}

/* ─── Inline bridge call for startperiodic/stopperiodic (not in bridgeClient) */
async function bridgeCallRaw(url, path, body) {
  const init = body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" };
  try {
    const res = await fetch(url.replace(/\/+$/, "") + path, init);
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ─── UDS caller built on bridgeClient primitives ────────────────────────── */
async function udsCall(url, tx, rx, data, timeoutMs = 4000) {
  await setFilter({ txId: tx, rxId: rx }, url);
  const dataHex = Array.from(data).map(b => hx(b)).join("");
  const sm = await sendMsg({ txId: tx, data: dataHex, flags: ISO15765_FRAME_PAD, timeoutMs: 1000 }, url);
  if (!sm || !sm.ok) return { ok: false, raw: sm?.error || "sendMsg failed" };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = Math.min(1500, Math.max(150, deadline - Date.now()));
    const r = await readMsg({ timeoutMs: slice }, url);
    if (!r || !r.ok) return { ok: false, raw: r?.error || "readMsg failed" };
    const msg = r.msg;
    if (!msg || !msg.data) continue;
    if (typeof msg.canId === "number" && rx && msg.canId !== rx) continue;
    if (msg.rxStatus & 0x01) continue;
    const bytes = hexToBytes(msg.data);
    if (!bytes.length) continue;
    if (bytes.length >= 3 && bytes[0] === 0x7F && bytes[2] === 0x78) continue;
    return { ok: true, d: new Uint8Array(bytes), raw: msg.data };
  }
  return { ok: false, raw: `timeout after ${timeoutMs}ms` };
}

/* ─── Styles ─────────────────────────────────────────────────────────────── */
const S = {
  bg:     "#F4F1EC",
  card:   "#FFFFFF",
  border: "#E8E4DE",
  text:   "#1A1A1A",
  dim:    "#5A5A5A",
  red:    "#D32F2F",
  green:  "#2E7D32",
  blue:   "#1565C0",
  yellow: "#E65100",
  font:   '"Nunito", sans-serif',
  mono:   '"JetBrains Mono", monospace',
};

/* ─── Status badge ────────────────────────────────────────────────────────── */
const STATUS_META = {
  disconnected:    { label: "○ NO BRIDGE",   bg: "#F5F5F5", color: S.dim },
  bridge_connected:{ label: "● DAEMON OK",   bg: "#F5F5F5", color: "#555" },
  device_open:     { label: "● DEVICE OPEN", bg: "#FFF3E0", color: S.yellow },
  can_connected:   { label: "● CAN LIVE",    bg: "#E8F5E9", color: S.green },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.disconnected;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700,
      background: m.bg, color: m.color, fontFamily: S.mono,
      border: `1px solid ${status === "can_connected" ? S.green : S.border}`,
      transition: "all 0.2s",
    }}>
      {m.label}
    </div>
  );
}

function Btn({ children, onClick, disabled, color = S.blue, small }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: small ? "6px 12px" : "9px 16px",
        background: disabled ? "#E0E0E0" : color,
        color: disabled ? "#9E9E9E" : "#fff",
        border: "none", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: S.font, fontWeight: 700, fontSize: small ? 11 : 12,
        opacity: disabled ? 0.55 : 1, whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/* ─── Security Access level options ──────────────────────────────────────── */
/* seed / key are the UDS sub-function bytes sent after SID 0x27:
   0x27 0x01 → request seed (level 1), positive: 0x67 0x01 <seed>
   0x27 0x02 → send key    (level 1), positive: 0x67 0x02
   (odd = seed request, even = key send — standard ISO 14229-1)          */
const SA_LEVELS = [
  { label: "0x01 — Default / Programming",  seed: 0x01, key: 0x02 },
  { label: "0x03 — Extended level 3",       seed: 0x03, key: 0x04 },
  { label: "0x05 — Extended level 5",       seed: 0x05, key: 0x06 },
  { label: "0x08 — NGC / TIPM t3608",       seed: 0x08, key: 0x09 },
  { label: "0x0C — Cummins CM2100/CM2200",  seed: 0x0C, key: 0x0D },
  { label: "0x10 — GPEC2 alt level",        seed: 0x10, key: 0x11 },
  { label: "0x34 — JTEC (fixed key)",       seed: 0x34, key: 0x35 },
  { label: "0x36 — GPEC2 / TIPM t3605",     seed: 0x36, key: 0x37 },
  { label: "0x3C — TIPM t3c",               seed: 0x3C, key: 0x3D },
  { label: "0x42 — GPEC2 variant",          seed: 0x42, key: 0x43 },
  { label: "0x44 — GPEC2 variant",          seed: 0x44, key: 0x45 },
  { label: "0x60 — EPS (session 0x67 req)", seed: 0x60, key: 0x61 },
  { label: "0x80 — NGC / TIPM t8001",       seed: 0x80, key: 0x81 },
  { label: "0x81 — TIPM t8101",             seed: 0x81, key: 0x82 },
  { label: "0x88 — NGC high-byte variant",  seed: 0x88, key: 0x89 },
  { label: "0xC6 — TIPM tc605",             seed: 0xC6, key: 0xC7 },
];

/* ALGOS entries available in the SA picker — exclude the catch-all custom entry */
const SA_ALGOS = ALGOS.filter(a => a.id !== "alfa_w6_custom");

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function J2534UdsConsoleTab() {
  const [status, setStatus] = useState("disconnected");
  const [log, setLog] = useState([]);
  const [txHex, setTxHex] = useState("0x750");
  const [rxHex, setRxHex] = useState("0x758");
  const [rawCmd, setRawCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  /* Command history (up/down arrow recall) */
  const [cmdHistory, setCmdHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("srtlab:uds:cmdHistory") || "[]"); } catch { return []; }
  });
  const [historyIdx, setHistoryIdx] = useState(-1);

  /* Security Access panel state */
  const [saOpen, setSaOpen] = useState(false);
  const [saLevelIdx, setSaLevelIdx] = useState(0);
  const [saAlgoId, setSaAlgoId] = useState("cda6");
  const [saAutoConfirm, setSaAutoConfirm] = useState(false);
  const [saSweepLevels, setSaSweepLevels] = useState(false);
  const [saPending, setSaPending] = useState(null);
  const [saExtHint, setSaExtHint] = useState(false);
  const [saDetectedAlgo, setSaDetectedAlgo] = useState(null);
  const [saRememberedAlgo, setSaRememberedAlgo] = useState(null);
  const [saDetectedLevel, setSaDetectedLevel] = useState(null);

  /* Remembered Algorithms panel state */
  const [saMemoryOpen, setSaMemoryOpen] = useState(false);
  const [rememberedEntries, setRememberedEntries] = useState([]);

  /* DID Library panel state */
  const [didLibOpen, setDidLibOpen] = useState(false);
  const [didSearch, setDidSearch] = useState("");
  const [didList, setDidList] = useState([]);
  const [didLoaded, setDidLoaded] = useState(false);

  /* Bridge URL editing state — persisted via setAutelState (localStorage) */
  const [bridgeUrlInput, setBridgeUrlInput] = useState(() => getAutelState().url);
  /* Workflow Assistant state */
  const [wfOpen, setWfOpen] = useState(false);
  const [wfIntent, setWfIntent] = useState("");
  const [wfLoading, setWfLoading] = useState(false);
  const [wfResult, setWfResult] = useState(null);
  const [wfError, setWfError] = useState(null);
  const [selectedModule, setSelectedModule] = useState("");
  const [wfCopied, setWfCopied] = useState(false);

  const logRef = useRef(null);
  const periodicIdRef = useRef(null);
  const urlRef = useRef(getAutelState().url);

  /* Keep URL ref fresh whenever component re-renders */
  urlRef.current = getAutelState().url;

  /* ── Remembered-algo management helpers ────────────────────────────── */
  const loadRemembered = useCallback(() => {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("sa_algo_")) continue;
      const addrStr = key.slice("sa_algo_".length);
      const algoId = localStorage.getItem(key) || "";
      const algoMeta = SA_ALGOS.find(a => a.id === algoId);
      const addrNum = parseInt(addrStr.replace(/^0x/i, ""), 16);
      const modMeta = !isNaN(addrNum) ? FCA_MODULES.find(m => m.tx === addrNum) : null;
      entries.push({
        key,
        addrStr,
        algoId,
        algoName: algoMeta ? algoMeta.n : algoId,
        moduleName: modMeta ? modMeta.name : null,
      });
    }
    entries.sort((a, b) => a.addrStr.localeCompare(b.addrStr));
    setRememberedEntries(entries);
  }, []);

  const forgetEntry = useCallback((key) => {
    localStorage.removeItem(key);
    if (key === saStorageKey(txHex)) setSaRememberedAlgo(null);
    loadRemembered();
  }, [loadRemembered, txHex]);

  const clearAllRemembered = useCallback(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("sa_algo_")) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    setSaRememberedAlgo(null);
    setRememberedEntries([]);
  }, []);

  /* Load remembered entries on mount */
  useEffect(() => { loadRemembered(); }, [loadRemembered]);



  /* When TX address changes: load remembered algo from localStorage, clear live detection */
  useEffect(() => {
    setSaDetectedAlgo(null);
    setSaDetectedLevel(null);
    const saved = localStorage.getItem(saStorageKey(txHex));
    if (saved && SA_ALGOS.find(a => a.id === saved)) {
      setSaAlgoId(saved);
      setSaRememberedAlgo(saved);
    } else {
      setSaRememberedAlgo(null);
    }
  }, [txHex]);

  /* Clear live detection when RX address changes (TX handled above; saLevelIdx intentionally
     excluded — the sweep sets it programmatically and must not wipe the winner badge) */
  useEffect(() => { setSaDetectedAlgo(null); setSaDetectedLevel(null); }, [rxHex]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  /* Stop tester-present on unmount */
  useEffect(() => {
    return () => {
      const pid = periodicIdRef.current;
      if (pid != null) {
        bridgeCallRaw(urlRef.current, "/stopperiodic", { periodicId: pid }).catch(() => {});
      }
    };
  }, []);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLog(p => [...p.slice(-500), { ts, msg, type }]);
  }, []);

  /* CDA6 DB Tools → UDS Console prefill bridge */
  useEffect(() => {
    const tx = sessionStorage.getItem("srtlab:uds:prefill:tx");
    const rx = sessionStorage.getItem("srtlab:uds:prefill:rx");
    const cmd = sessionStorage.getItem("srtlab:uds:prefill:cmd");
    if (tx) { setTxHex(tx); sessionStorage.removeItem("srtlab:uds:prefill:tx"); }
    if (rx) { setRxHex(rx); sessionStorage.removeItem("srtlab:uds:prefill:rx"); }
    if (cmd) { setRawCmd(cmd); sessionStorage.removeItem("srtlab:uds:prefill:cmd"); }
    if (tx || rx || cmd) addLog("Pre-filled from CDA6 DB Tools", "header");
  }, [addLog]);

  /* Load DID library when panel is opened */
  useEffect(() => {
    if (didLibOpen && !didLoaded) {
      loadDidDescriptions().then(() => {
        setDidList(getAllDids());
        setDidLoaded(true);
      });
    }
  }, [didLibOpen, didLoaded]);

  /* ── Disconnect / reset ──────────────────────────────────────────────── */
  const disconnect = useCallback(async () => {
    const pid = periodicIdRef.current;
    if (pid != null) {
      await bridgeCallRaw(urlRef.current, "/stopperiodic", { periodicId: pid }).catch(() => {});
      periodicIdRef.current = null;
    }
    setSaPending(null);
    setStatus("disconnected");
    setLog([]);
    addLog("Disconnected — log cleared.", "info");
  }, [addLog]);

  /* ── Connect: daemon check → PassThruOpen → ISO15765 channel ───────── */
  const connectBridge = useCallback(async () => {
    addLog("Connecting to J2534 device …");
    setBusy(true);
    try {
      /* 1. Ping the bridge daemon */
      const st = await getStatus(urlRef.current);
      if (!st || !st.ok) {
        addLog("Bridge software not running — start j2534_bridge.py (port 8765).", "error");
        setStatus("disconnected");
        return;
      }
      if (!st.dllLoaded) {
        addLog("Bridge is up but no J2534 DLL loaded — restart bridge with --dll <vendor DLL>.", "error");
        setStatus("disconnected");
        return;
      }
      addLog(`Bridge daemon OK (${st.vendor || "?"}) — checking hardware …`);
      if (st.dllPath) addLog("DLL: " + st.dllPath);

      /* 2. Shortcut: daemon reports device already open */
      if (st.deviceOpen && st.channelConnected) {
        addLog("Device already open and ISO15765 channel is up.", "success");
        await startKeepalive();
        setStatus("can_connected");
        return;
      }
      if (st.deviceOpen) {
        addLog("Device already open — connecting CAN …");
        setStatus("device_open");
        /* fall through to CAN connect below */
      } else {
        /* 3. PassThruOpen — this is where missing hardware is detected */
        const opened = await openBridge(urlRef.current);
        if (!opened || !opened.ok) {
          addLog("No J2534 device detected: " + (opened?.error || "PassThruOpen failed"), "error");
          addLog("Plug in the adapter and try again.", "error");
          setStatus("disconnected");
          return;
        }
        addLog(`Device opened${opened.versions?.firmware ? " fw " + opened.versions.firmware : ""}`, "success");
        setStatus("device_open");
      }

      /* 4. ISO15765 channel */
      addLog("Opening ISO15765 channel @ 500 kbps …");
      const c = await bridgeConnect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, urlRef.current);
      if (!c || !c.ok) {
        addLog("CAN channel failed: " + (c?.error || "unknown"), "error");
        setStatus("device_open");
        return;
      }
      addLog("CAN bus up — ISO15765 500 kbps", "success");
      await startKeepalive();
      setStatus("can_connected");
    } finally {
      setBusy(false);
    }
  }, [addLog]);

  /* ── Connect CAN (retry after device_open) ───────────────────────────── */
  const openDevice = useCallback(async () => {
    addLog("Connecting ISO15765 channel @ 500 kbps …");
    setBusy(true);
    try {
      const c = await bridgeConnect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, urlRef.current);
      if (!c || !c.ok) {
        addLog("CAN channel failed: " + (c?.error || "unknown"), "error");
        return;
      }
      addLog("CAN bus up — ISO15765 500 kbps", "success");
      await startKeepalive();
      setStatus("can_connected");
    } finally {
      setBusy(false);
    }
  }, [addLog]);

  /* ── Tester-present keepalive (3E 02 on 0x7DF every 1 s) ──────────── */
  const startKeepalive = useCallback(async () => {
    if (periodicIdRef.current != null) return;
    try {
      const pr = await bridgeCallRaw(urlRef.current, "/startperiodic", {
        txId: 0x7DF, data: "3E02", intervalMs: 1000, flags: ISO15765_FRAME_PAD,
      });
      if (pr?.periodicId != null) {
        periodicIdRef.current = pr.periodicId;
        addLog(`Tester-present keepalive started (id=${pr.periodicId}, tx=0x7DF).`, "success");
      }
      try {
        await bridgeCallRaw(urlRef.current, "/startperiodic", {
          txId: 0x01C, data: "3E02", intervalMs: 1000, flags: ISO15765_FRAME_PAD,
        });
      } catch {}
    } catch (e) {
      addLog("Keepalive start failed (non-fatal): " + e.message, "warn");
    }
  }, [addLog]);

  /* ── Address helpers ────────────────────────────────────────────────── */
  const parseAddr = s => parseInt(String(s).replace(/^0x/i, ""), 16);

  /* ── Send UDS command ───────────────────────────────────────────────── */
  const send = useCallback(async (bytes) => {
    if (status !== "can_connected") { addLog("Bridge not connected — connect first.", "error"); return; }
    if (!bytes || !bytes.length) { addLog("No bytes to send.", "error"); return; }
    const tx = parseAddr(txHex);
    const rx = parseAddr(rxHex);
    if (isNaN(tx) || isNaN(rx)) { addLog("Invalid TX/RX address.", "error"); return; }
    addLog(`TX → 0x${hx(tx, 3)}: ${bytesToHex(bytes)}`, "tx");
    setBusy(true);
    try {
      const r = await udsCall(urlRef.current, tx, rx, bytes, 5000);
      if (r.ok && r.d) {
        const rxStr = bytesToHex(r.d);
        addLog(`RX ← 0x${hx(rx, 3)}: ${rxStr}`, "rx");
        if (r.d[0] === 0x7F && r.d.length >= 3) {
          const nrc = r.d[2];
          addLog(`NRC 0x${hx(nrc)}: ${decodeNRC(nrc)}`, "warn");
          if (nrc === 0x22 && bytes[0] === 0x27) {
            addLog("Hint: send 'Ext Session' (10 03) first, then retry Security Access", "hint");
          }
        }
      } else {
        addLog("No response: " + (r.raw || "timeout"), "error");
      }
    } finally {
      setBusy(false);
    }
  }, [status, txHex, rxHex, addLog]);

  const sendRaw = useCallback(() => {
    const bytes = hexToBytes(rawCmd);
    if (!bytes.length) { addLog("Enter hex bytes first.", "error"); return; }
    /* Save to command history */
    const trimmed = rawCmd.trim();
    if (trimmed) {
      setCmdHistory(prev => {
        const next = [trimmed, ...prev.filter(c => c !== trimmed)].slice(0, 20);
        localStorage.setItem("srtlab:uds:cmdHistory", JSON.stringify(next));
        return next;
      });
      setHistoryIdx(-1);
    }
    send(bytes);
  }, [rawCmd, send]);

  /* Handle up/down arrow for command history */
  const handleCmdKeyDown = useCallback((e) => {
    if (e.key === "Enter" && !busy) { sendRaw(); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdHistory(h => {
        const newIdx = Math.min(historyIdx + 1, h.length - 1);
        if (newIdx >= 0 && h[newIdx]) { setRawCmd(h[newIdx]); setHistoryIdx(newIdx); }
        return h;
      });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx <= 0) { setHistoryIdx(-1); setRawCmd(""); }
      else {
        const newIdx = historyIdx - 1;
        setCmdHistory(h => { if (h[newIdx]) setRawCmd(h[newIdx]); return h; });
        setHistoryIdx(newIdx);
      }
    }
  }, [busy, historyIdx, sendRaw]);


  /* ── Workflow Assistant — generate UDS workflow from intent ────────── */
  const handleWorkflow = useCallback(async () => {
    if (!wfIntent.trim()) return;
    setWfLoading(true);
    setWfError(null);
    setWfResult(null);
    try {
      const res = await fetch("/api/trpc/planner.workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          json: {
            intent: wfIntent.trim(),
            moduleCode: selectedModule || undefined,
            vehiclePlatform: undefined,
          },
        }),
      });
      const data = await res.json();
      /* tRPC superjson wraps result in .result.data.json; also handle error responses */
      if (data?.error) {
        const errMsg = data.error?.json?.message || data.error?.message || "Server error";
        throw new Error(errMsg);
      }
      const result = data?.result?.data?.json || data?.result?.data || null;
      if (result && result.title) {
        setWfResult(result);
        addLog("Workflow generated: " + result.title + " (" + (result.steps?.length || 0) + " steps)", "info");
      } else {
        setWfError("No valid workflow returned from AI. Try rephrasing your intent.");
      }
    } catch (e) {
      setWfError("Error: " + e.message);
    } finally {
      setWfLoading(false);
    }
  }, [wfIntent, selectedModule, addLog]);

  /* ── Security Access — Phase 1: request seed + compute key ──────────── */
  const runSecurityAccess = useCallback(async () => {
    if (status !== "can_connected") { addLog("Bridge not connected — connect first.", "error"); return; }
    const tx = parseAddr(txHex);
    const rx = parseAddr(rxHex);
    if (isNaN(tx) || isNaN(rx)) { addLog("Invalid TX/RX address.", "error"); return; }

    const level = SA_LEVELS[saLevelIdx];
    const algo  = SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0];

    setSaExtHint(false);
    addLog(`── Security Access (level 0x${hx(level.seed & 0x1F)}, algo: ${algo.n}) ──`, "header");
    setBusy(true);
    try {
      /* Step 1: Request seed — 27 XX */
      const seedReq = [0x27, level.seed & 0xFF];
      addLog(`TX → 0x${hx(tx, 3)}: ${bytesToHex(seedReq)}  (requestSeed)`, "tx");
      const sr = await udsCall(urlRef.current, tx, rx, seedReq, 5000);
      if (!sr.ok || !sr.d) {
        addLog("Seed request failed: " + (sr.raw || "no response"), "error");
        return;
      }
      addLog(`RX ← 0x${hx(rx, 3)}: ${bytesToHex(sr.d)}`, "rx");

      /* Negative response check */
      if (sr.d[0] === 0x7F) {
        const nrc = sr.d.length >= 3 ? sr.d[2] : 0;
        addLog(`NRC 0x${hx(nrc)}: ${decodeNRC(nrc)}`, "error");
        if (nrc === 0x22) {
          setSaExtHint(true);
          addLog("Hint: send 'Ext Session' (10 03) first, then retry Security Access", "hint");
        } else if (nrc === 0x24) {
          addLog("Hint: RequestSequenceError — send Extended Session (10 03) first, then re-request the seed", "hint");
        } else if (nrc === 0x36) {
          addLog("Hint: ExceededAttempts — module is locked out; perform an ECU reset and wait for the lockout timer to expire before retrying", "hint");
        } else if (nrc === 0x37) {
          addLog("Hint: RequiredTimeDelayNotExpired — module enforces a lockout delay after failed attempts; wait a few seconds and retry", "hint");
        }
        return;
      }

      /* Validate positive response: 67 XX <seed bytes…> */
      if (sr.d[0] !== 0x67 || sr.d[1] !== (level.seed & 0xFF)) {
        addLog(`Unexpected response (expected 67 ${hx(level.seed & 0xFF)}): ${bytesToHex(sr.d)}`, "error");
        return;
      }

      const seedBytes = sr.d.slice(2);
      if (!seedBytes.length) {
        addLog("Empty seed — module may already be unlocked or requires a different session.", "warn");
        return;
      }
      addLog(`Seed: ${bytesToHex(seedBytes)}`, "info");

      /* Step 2: Compute key */
      const keyBytes = unlockKeyBytes(algo.id, seedBytes);
      if (!keyBytes) {
        addLog(`Algorithm '${algo.n}' returned null for this seed. Try a different algorithm.`, "error");
        return;
      }
      addLog(`Key (${algo.n}): ${bytesToHex(keyBytes)}`, "info");

      const keyReq = [0x27, level.key & 0xFF, ...keyBytes];

      /* Auto-confirm: skip the interstitial and send immediately */
      if (saAutoConfirm) {
        addLog("Auto-confirm enabled — sending key immediately.", "warn");
        await doSendKey({ tx, rx, level, algo, seedBytes, keyBytes, keyReq });
        return;
      }

      /* Pause for operator review */
      addLog("Waiting for operator confirmation before sending key.", "info");
      setSaPending({ tx, rx, level, algo, seedBytes, keyBytes, keyReq });
    } finally {
      setBusy(false);
    }
  }, [status, txHex, rxHex, saLevelIdx, saAlgoId, saAutoConfirm, addLog]);

  /* ── Security Access — Phase 2: actually transmit 27 XX+1 ───────────── */
  const doSendKey = useCallback(async ({ tx, rx, level, algo, seedBytes, keyBytes, keyReq }) => {
    addLog(`TX → 0x${hx(tx, 3)}: ${bytesToHex(keyReq)}  (sendKey)`, "tx");
    const kr = await udsCall(urlRef.current, tx, rx, keyReq, 5000);
    if (!kr.ok || !kr.d) {
      addLog("Send-key failed: " + (kr.raw || "no response"), "error");
      return;
    }
    addLog(`RX ← 0x${hx(rx, 3)}: ${bytesToHex(kr.d)}`, "rx");
    if (kr.d[0] === 0x7F) {
      const nrc = kr.d.length >= 3 ? kr.d[2] : 0;
      addLog(`NRC 0x${hx(nrc)}: ${decodeNRC(nrc)}`, "error");
      if (nrc === 0x35) {
        addLog("Hint: InvalidKey — wrong algorithm or the seed has expired; request a fresh seed and retry", "hint");
      } else if (nrc === 0x36) {
        addLog("Hint: ExceededAttempts — module is locked out; perform an ECU reset and wait for the lockout timer to expire before retrying", "hint");
      } else if (nrc === 0x37) {
        addLog("Hint: RequiredTimeDelayNotExpired — module enforces a lockout delay after failed attempts; wait a few seconds and retry", "hint");
      }
    } else if (kr.d[0] === 0x67 && kr.d[1] === (level.key & 0xFF)) {
      addLog("Security access GRANTED ✓", "success");
      localStorage.setItem(saStorageKey(txHex), algo.id);
      setSaRememberedAlgo(algo.id);
      loadRemembered();
    } else {
      addLog(`Unexpected send-key response: ${bytesToHex(kr.d)}`, "warn");
    }
  }, [addLog, txHex, loadRemembered]);

  const confirmSendKey = useCallback(async () => {
    if (!saPending) return;
    const pending = saPending;
    setSaPending(null);
    setBusy(true);
    try {
      await doSendKey(pending);
    } finally {
      setBusy(false);
    }
  }, [saPending, doSendKey]);

  const cancelSendKey = useCallback(() => {
    if (!saPending) return;
    addLog(`Key send CANCELLED by operator.`, "warn");
    addLog(`  Seed: ${bytesToHex(saPending.seedBytes)}`, "info");
    addLog(`  Key:  ${bytesToHex(saPending.keyBytes)}`, "info");
    setSaPending(null);
  }, [saPending, addLog]);

  /* ── Ext Session → retry SA composite action ───────────────────────── */
  const runExtSessionThenRetry = useCallback(async () => {
    if (status !== "can_connected") return;
    const tx = parseAddr(txHex);
    const rx = parseAddr(rxHex);
    if (isNaN(tx) || isNaN(rx)) { addLog("Invalid TX/RX address.", "error"); return; }

    setSaExtHint(false);
    addLog("── Auto: Extended Session → Security Access ──", "header");
    setBusy(true);
    try {
      const extReq = [0x10, 0x03];
      addLog(`TX → 0x${hx(tx, 3)}: ${bytesToHex(extReq)}  (DiagnosticSessionControl extendedDiagnosticSession)`, "tx");
      const esr = await udsCall(urlRef.current, tx, rx, extReq, 3000);
      if (!esr.ok || !esr.d) {
        addLog("Ext Session failed: " + (esr.raw || "no response"), "error");
        return;
      }
      addLog(`RX ← 0x${hx(rx, 3)}: ${bytesToHex(esr.d)}`, "rx");
      if (esr.d[0] === 0x7F) {
        const nrc = esr.d.length >= 3 ? esr.d[2] : 0;
        addLog(`Ext Session NRC 0x${hx(nrc)}: ${decodeNRC(nrc)}`, "error");
        return;
      }
      addLog("Extended session active — retrying Security Access…", "success");
    } finally {
      setBusy(false);
    }
    await runSecurityAccess();
  }, [status, txHex, rxHex, addLog, runSecurityAccess]);

  /* ── Auto-detect: iterate pickUnlockChain, log each attempt ─────────── */
  /* When saSweepLevels is true an outer loop iterates all SA_LEVELS;
     NRC 0x12 (subFunctionNotSupported) or 0x31 (requestOutOfRange) on the
     seed request mean the module doesn't support that SA level — we skip it
     rather than aborting. All other abort conditions (0x36 lockout, comm
     failure, unexpected NRC) still abort the whole sweep immediately. */
  const runAutoDetect = useCallback(async () => {
    if (status !== "can_connected") { addLog("Bridge not connected — connect first.", "error"); return; }
    const tx = parseAddr(txHex);
    const rx = parseAddr(rxHex);
    if (isNaN(tx) || isNaN(rx)) { addLog("Invalid TX/RX address.", "error"); return; }

    const levelsToTry = saSweepLevels ? SA_LEVELS : [SA_LEVELS[saLevelIdx]];
    const chain = pickUnlockChain(tx);

    if (saSweepLevels) {
      addLog(`── Auto-detect Security Access — sweeping ${levelsToTry.length} levels × ${chain.length} algos ──`, "header");
    } else {
      const lvl = levelsToTry[0];
      addLog(`── Auto-detect Security Access (level 0x${hx(lvl.seed)}, ${chain.length} algos) ──`, "header");
    }
    setSaDetectedAlgo(null);
    setSaDetectedLevel(null);
    setBusy(true);

    // Track why the loop ended so the terminal message is accurate.
    // 'lockout'   — NRC 0x36: module locked, no point trying more
    // 'comm'      — transport failure (no response / bad framing)
    // 'nrc_abort' — unexpected NRC on seed or key that retrying won't fix
    // 'exhausted' — all level+algo combinations tried, none succeeded
    let exitReason = 'exhausted';

    try {
      levelLoop: for (const level of levelsToTry) {
        if (saSweepLevels) {
          addLog(`  ── level 0x${hx(level.seed)} (${level.label.split("—")[1]?.trim() || ""}) ──`, "header");
        }

        algoLoop: for (const algoId of chain) {
          const algoMeta = SA_ALGOS.find(a => a.id === algoId);
          const algoLabel = algoMeta ? algoMeta.n : algoId;

          addLog(`    trying ${algoLabel}…`, "info");

          let seedRetryLeft = 1; // allow one 0x37 retry per algo
          let keyRetryLeft  = 1;

          /* ── seed request loop (handles NRC 0x37 delay) ── */
          let seedBytes = null;
          while (true) {
            const seedReq = [0x27, level.seed & 0xFF];
            const sr = await udsCall(urlRef.current, tx, rx, seedReq, 5000);
            if (!sr.ok || !sr.d) {
              addLog(`      seed: no response — aborting`, "error");
              exitReason = 'comm';
              break levelLoop;
            }

            if (sr.d[0] === 0x7F) {
              const nrc = sr.d.length >= 3 ? sr.d[2] : 0;
              if (nrc === 0x36) {
                addLog(`      seed NRC 0x36 (exceededNumberOfAttempts) — module locked`, "error");
                exitReason = 'lockout';
                break levelLoop;
              }
              if (nrc === 0x37 && seedRetryLeft > 0) {
                const delayMs = (sr.d.length >= 4 ? sr.d[3] * 1000 : 0) || 1500;
                addLog(`      seed NRC 0x37 — waiting ${delayMs} ms`, "warn");
                seedRetryLeft--;
                await new Promise(r => setTimeout(r, delayMs));
                continue;
              }
              // NRC 0x12 (subFunctionNotSupported) or 0x31 (requestOutOfRange)
              // means this SA level is not supported by this module — skip to
              // the next level when sweeping, otherwise abort.
              if (saSweepLevels && (nrc === 0x12 || nrc === 0x31)) {
                addLog(`      seed NRC 0x${hx(nrc)}: ${decodeNRC(nrc)} — level not supported, skipping`, "warn");
                break algoLoop; // advance to next level
              }
              // Any other NRC means the session or SA level is wrong for this
              // module — a different algorithm won't help, so abort.
              addLog(`      seed NRC 0x${hx(nrc)}: ${decodeNRC(nrc)} — non-retryable, aborting`, "error");
              exitReason = 'nrc_abort';
              break levelLoop;
            }

            if (sr.d[0] !== 0x67 || sr.d[1] !== (level.seed & 0xFF)) {
              addLog(`      unexpected seed response: ${bytesToHex(sr.d)} — aborting`, "warn");
              exitReason = 'comm';
              break levelLoop;
            }

            seedBytes = Array.from(sr.d).slice(2);
            break; // got a valid seed
          }

          if (!seedBytes) break; // levelLoop break already set exitReason

          if (!seedBytes.some(b => b !== 0)) {
            addLog(`      zero seed — already unlocked at level 0x${hx(level.seed)}`, "success");
            const winnerIdx = SA_LEVELS.indexOf(level);
            if (winnerIdx >= 0) setSaLevelIdx(winnerIdx);
            setSaAlgoId(algoId);
            setSaDetectedAlgo(algoId);
            setSaDetectedLevel(level);
            localStorage.setItem(saStorageKey(txHex), algoId);
            setSaRememberedAlgo(algoId);
            loadRemembered();
            return;
          }
          addLog(`      seed: ${bytesToHex(seedBytes)}`, "info");

          /* Compute key */
          const keyBytes = unlockKeyBytes(algoId, seedBytes);
          if (!keyBytes) {
            addLog(`      ${algoLabel} returned null for this seed — skipping`, "warn");
            continue;
          }
          addLog(`      key:  ${bytesToHex(keyBytes)}`, "info");

          /* ── send key loop (handles NRC 0x37 delay) ── */
          while (true) {
            const keyReq = [0x27, level.key & 0xFF, ...keyBytes];
            const kr = await udsCall(urlRef.current, tx, rx, keyReq, 5000);
            if (!kr.ok || !kr.d) {
              addLog(`      send-key: no response — skipping`, "warn");
              break; // no response — try next algo
            }

            if (kr.d[0] === 0x67 && kr.d[1] === (level.key & 0xFF)) {
              addLog(`Auto-detect WINNER → level 0x${hx(level.seed)} · ${algoLabel} (${algoId}) ✓`, "success");
              const winnerIdx = SA_LEVELS.indexOf(level);
              if (winnerIdx >= 0) setSaLevelIdx(winnerIdx);
              setSaAlgoId(algoId);
              setSaDetectedAlgo(algoId);
              setSaDetectedLevel(level);
              localStorage.setItem(saStorageKey(txHex), algoId);
              setSaRememberedAlgo(algoId);
              loadRemembered();
              return;
            }

            if (kr.d[0] === 0x7F) {
              const nrc = kr.d.length >= 3 ? kr.d[2] : 0;
              if (nrc === 0x36) {
                addLog(`      key NRC 0x36 — module locked`, "error");
                exitReason = 'lockout';
                break levelLoop;
              }
              if (nrc === 0x37 && keyRetryLeft > 0) {
                const delayMs = (kr.d.length >= 4 ? kr.d[3] * 1000 : 0) || 1500;
                addLog(`      key NRC 0x37 — waiting ${delayMs} ms`, "warn");
                keyRetryLeft--;
                await new Promise(r => setTimeout(r, delayMs));
                continue;
              }
              if (nrc === 0x35) {
                // Expected "wrong algorithm" response — advance to next algo.
                addLog(`      NRC 0x35 (invalidKey) — next`, "warn");
              } else {
                // Unexpected NRC — trying another algorithm won't help. Abort.
                addLog(`      key NRC 0x${hx(nrc)}: ${decodeNRC(nrc)} — non-retryable, aborting`, "error");
                exitReason = 'nrc_abort';
                break levelLoop;
              }
            } else {
              addLog(`      unexpected key response: ${bytesToHex(kr.d)} — skipping`, "warn");
            }
            break; // advance chain
          }
        }
      }

      const terminalMsg = {
        lockout:   "Auto-detect stopped — module locked (NRC 0x36), power-cycle required",
        comm:      "Auto-detect stopped — communication failure",
        nrc_abort: "Auto-detect stopped — module returned non-retryable NRC (check session/SA level)",
        exhausted: saSweepLevels
          ? "Auto-detect: all levels + algorithms exhausted — no match found"
          : "Auto-detect: all algorithms exhausted — no match found",
      };
      addLog(terminalMsg[exitReason] || terminalMsg.exhausted, "error");
    } finally {
      setBusy(false);
    }
  }, [status, txHex, rxHex, saLevelIdx, saSweepLevels, addLog, loadRemembered]);

  /* ── Module preset picker ───────────────────────────────────────────── */
  const pickModule = useCallback((mod) => {
    setTxHex("0x" + hx(mod.tx, 3));
    setRxHex("0x" + hx(mod.rx, 3));
    addLog(`Target: ${mod.name} TX:0x${hx(mod.tx, 3)} RX:0x${hx(mod.rx, 3)}`, "info");
  }, [addLog]);

  const filteredModules = search.trim()
    ? FCA_MODULES.filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
    : FCA_MODULES;

  const isLive = status === "can_connected";

  /* ── Log line colour map ────────────────────────────────────────────── */
  const logColor = { tx: "#1565C0", rx: "#2E7D32", error: "#D32F2F", warn: "#E65100", success: "#2E7D32", info: "#5A5A5A", header: "#6A1B9A", hint: "#E65100" };

  return (
    <div data-testid="uds-console-tab" style={{ background: S.bg, minHeight: "100%", padding: 16, fontFamily: S.font, color: S.text }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16,
            padding: "14px 18px", borderRadius: 10, border: `1px solid ${S.border}`,
            background: "linear-gradient(135deg,#EDE7F6 0%,#D1C4E9 60%,#B39DDB 100%)" }}>
          <div style={{ fontSize: 28 }}>🔌</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2, color: "#4A148C" }}>UDS CONSOLE</div>
            <div style={{ fontSize: 10, opacity: 0.9, letterSpacing: 3, fontWeight: 700, marginTop: 2, color: "#6A1B9A" }}>J2534 · RAW UDS · ANY MODULE</div>
          </div>
          <StatusBadge status={status} />
        </div>

        {/* ── Connection strip ──────────────────────────────────────────── */}
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${S.border}`,
            background: S.card, marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5, flexShrink: 0 }}>BRIDGE</span>
          <input
            type="text"
            value={bridgeUrlInput}
            onChange={e => setBridgeUrlInput(e.target.value)}
            onBlur={e => {
              const v = e.target.value.trim() || getAutelState().url;
              setBridgeUrlInput(v);
              setAutelState({ url: v });
              urlRef.current = v;
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = e.target.value.trim() || getAutelState().url;
                setBridgeUrlInput(v);
                setAutelState({ url: v });
                urlRef.current = v;
                e.target.blur();
              }
            }}
            placeholder="http://localhost:8765"
            style={{
              flex: 1, minWidth: 0, fontSize: 11, color: S.text, fontFamily: S.mono,
              background: '#FAFAFA', border: `1px solid ${S.border}`, borderRadius: 5,
              padding: '4px 8px', outline: 'none',
            }}
            title="J2534 bridge URL — edit and press Enter or click away to save"
          />
          {(status === "disconnected" || status === "bridge_connected") && (
            <Btn onClick={connectBridge} disabled={busy} color={S.blue}>Connect</Btn>
          )}
          {status === "device_open" && (
            <Btn onClick={openDevice} disabled={busy} color={S.green}>Connect CAN</Btn>
          )}
          {isLive && (
            <Btn onClick={disconnect} disabled={busy} color={S.red} small>Disconnect</Btn>
          )}
        </div>

        {/* ── Module target ─────────────────────────────────────────────── */}
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${S.border}`, background: S.card, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 10 }}>TARGET MODULE</div>

          {/* Search + preset pills */}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter modules…"
            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: `1px solid ${S.border}`,
              background: "#FAFAFA", color: S.text, fontFamily: S.mono, fontSize: 11,
              marginBottom: 8, boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 96, overflowY: "auto", marginBottom: 12 }}>
            {filteredModules.map(m => {
              const active = txHex.toLowerCase() === ("0x" + hx(m.tx, 3)).toLowerCase();
              return (
                <button key={m.name} onClick={() => pickModule(m)} style={{
                  padding: "4px 9px", fontSize: 10, fontWeight: 700, borderRadius: 5,
                  border: `1px solid ${active ? S.green : S.border}`,
                  background: active ? "#E8F5E9" : "#FAFAFA",
                  color: active ? S.green : S.dim, cursor: "pointer", fontFamily: S.mono,
                }}>{m.name}</button>
              );
            })}
          </div>

          {/* TX / RX inputs */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: S.dim, marginBottom: 4, fontWeight: 700 }}>TX ADDRESS</div>
              <input value={txHex} onChange={e => setTxHex(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`,
                  background: "#FAFAFA", color: "#1565C0", fontFamily: S.mono, fontSize: 13, fontWeight: 700, boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: S.dim, marginBottom: 4, fontWeight: 700 }}>RX ADDRESS</div>
              <input value={rxHex} onChange={e => setRxHex(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`,
                  background: "#FAFAFA", color: "#2E7D32", fontFamily: S.mono, fontSize: 13, fontWeight: 700, boxSizing: "border-box" }} />
            </div>
          </div>
        </div>

        {/* ── UDS command card ──────────────────────────────────────────── */}
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${isLive ? "#A5D6A7" : S.border}`,
            background: S.card, marginBottom: 12, opacity: isLive ? 1 : 0.55 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 10 }}>UDS COMMAND</div>

          {/* Raw hex + send */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <input
              value={rawCmd}
              onChange={e => setRawCmd(e.target.value)}
              onKeyDown={handleCmdKeyDown}
              placeholder="hex bytes — e.g. 22 F1 90"
              disabled={!isLive}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 6, border: `1px solid ${S.border}`,
                background: "#FAFAFA", color: S.text, fontFamily: S.mono, fontSize: 13, fontWeight: 700 }}
            />
            <Btn onClick={sendRaw} disabled={!isLive || busy}>Send</Btn>
          </div>

          {/* Quick-launch buttons */}
          <div style={{ fontSize: 10, color: S.dim, marginBottom: 6, fontWeight: 700, letterSpacing: 1 }}>QUICK LAUNCH</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {QUICK_CMDS.map(qc => (
              <button
                key={qc.label}
                disabled={!isLive || busy}
                onClick={() => send(qc.bytes)}
                style={{
                  padding: "6px 12px", fontSize: 11, fontWeight: 700, borderRadius: 6,
                  border: `1px solid ${S.border}`, background: "#F5F5F5",
                  color: isLive ? "#333" : S.dim, cursor: isLive && !busy ? "pointer" : "not-allowed",
                  fontFamily: S.mono, opacity: isLive ? 1 : 0.5,
                }}
              >
                {qc.label}
                <span style={{ color: S.dim, marginLeft: 5, fontSize: 9 }}>
                  {qc.bytes.map(b => hx(b)).join(" ")}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── DID Library panel ──────────────────────────────────────────── */}
        <div style={{
          borderRadius: 8, border: `1px solid ${didLibOpen ? "#42A5F5" : S.border}`,
          background: didLibOpen ? "#E3F2FD" : S.card, marginBottom: 12, overflow: "hidden",
          transition: "border-color 0.2s",
        }}>
          <button
            onClick={() => setDidLibOpen(o => !o)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 800, color: S.text, letterSpacing: 1.5 }}>
              📚 DID LIBRARY {didLoaded ? `(${didList.length})` : ""}
            </span>
            <span style={{ fontSize: 12, color: S.dim }}>{didLibOpen ? "\u25B2" : "\u25BC"}</span>
          </button>
          {didLibOpen && (
            <div style={{ padding: "0 14px 14px" }}>
              <input
                value={didSearch}
                onChange={e => setDidSearch(e.target.value)}
                placeholder="Search by hex (F190) or name (VIN)..."
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`,
                  background: "#FAFAFA", color: S.text, fontFamily: S.mono, fontSize: 12, marginBottom: 8,
                  boxSizing: "border-box",
                }}
              />
              <div style={{ maxHeight: 260, overflowY: "auto", fontSize: 11 }}>
                {didList
                  .filter(d => {
                    if (!didSearch) return true;
                    const q = didSearch.toLowerCase();
                    const hexStr = d.did.toString(16).toUpperCase().padStart(4, "0");
                    return hexStr.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)
                      || (d.descriptions || []).some(desc => desc.toLowerCase().includes(q));
                  })
                  .slice(0, 80)
                  .map(d => {
                    const hexStr = d.did.toString(16).toUpperCase().padStart(d.did > 0xFFFF ? 6 : 4, "0");
                    const isStandard = d.did >= 0xF100 && d.did <= 0xF1FF;
                    return (
                      <div
                        key={d.did}
                        onClick={() => {
                          if (d.did <= 0xFFFF) {
                            const hi = (d.did >> 8) & 0xFF;
                            const lo = d.did & 0xFF;
                            setRawCmd(`22 ${hx(hi)} ${hx(lo)}`);
                          }
                        }}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "5px 6px",
                          borderRadius: 4, cursor: d.did <= 0xFFFF ? "pointer" : "default",
                          borderBottom: `1px solid ${S.border}`,
                          transition: "background 0.15s",
                        }}
                        onMouseEnter={e => { if (d.did <= 0xFFFF) e.currentTarget.style.background = "#E8F5E9"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{
                          fontFamily: S.mono, fontWeight: 700, color: isStandard ? "#1565C0" : "#6A1B9A",
                          minWidth: 52,
                        }}>
                          {hexStr}
                        </span>
                        <span style={{ flex: 1, color: S.text, fontWeight: 500 }}>{d.name}</span>
                        {d.did <= 0xFFFF && (
                          <span style={{ fontSize: 9, color: S.dim, fontFamily: S.mono }}>
                            22 {hx((d.did >> 8) & 0xFF)} {hx(d.did & 0xFF)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                {didList.length === 0 && didLoaded && (
                  <div style={{ color: S.dim, textAlign: "center", padding: 20 }}>No DIDs loaded</div>
                )}
                {!didLoaded && (
                  <div style={{ color: S.dim, textAlign: "center", padding: 20 }}>Loading DID catalog...</div>
                )}
              </div>
              {didSearch && didList.filter(d => {
                const q = didSearch.toLowerCase();
                const hexStr = d.did.toString(16).toUpperCase().padStart(4, "0");
                return hexStr.toLowerCase().includes(q) || d.name.toLowerCase().includes(q);
              }).length > 80 && (
                <div style={{ fontSize: 10, color: S.dim, textAlign: "center", marginTop: 6 }}>
                  Showing first 80 results — refine your search
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── UDS Workflow Assistant ──────────────────────────────────────── */}
        <div style={{
          borderRadius: 8, border: `1px solid ${wfOpen ? '#42A5F5' : S.border}`,
          background: wfOpen ? '#E3F2FD' : S.card, marginBottom: 12, overflow: 'hidden',
          transition: 'border-color 0.2s',
        }}>
          <button
            onClick={() => setWfOpen(o => !o)}
            style={{
              width: '100%', padding: '10px 16px', background: 'none', border: 'none',
              display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
              fontFamily: S.font, color: S.text, textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 16 }}>{wfOpen ? '▾' : '▸'}</span>
            <span style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1 }}>
              🧠 WORKFLOW ASSISTANT
            </span>
            <span style={{ fontSize: 10, color: S.dim, marginLeft: 'auto' }}>
              Describe what you want to do → get the full UDS sequence
            </span>
          </button>
          {wfOpen && (
            <div style={{ padding: '0 16px 16px' }}>
              <div style={{ fontSize: 11, color: S.dim, marginBottom: 8, lineHeight: 1.5 }}>
                Examples: "change VIN in the radio" · "read all DTCs from BCM" · "flash ECM calibration" · "unlock IPC programming session"
              </div>
              {/* Module selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: S.dim, letterSpacing: 1, flexShrink: 0 }}>TARGET MODULE</span>
                <select
                  value={selectedModule}
                  onChange={e => setSelectedModule(e.target.value)}
                  style={{
                    flex: 1, padding: '5px 8px', borderRadius: 5, border: `1px solid ${S.border}`,
                    background: '#FAFAFA', color: S.text, fontFamily: S.mono, fontSize: 11,
                  }}
                  title="Optionally pin the target module so the AI generates the correct CAN IDs and security sequence"
                >
                  <option value="">Auto-detect from intent</option>
                  {FCA_MODULES.map(m => (
                    <option key={m.name} value={m.name}>
                      {m.name} — TX 0x{m.tx.toString(16).toUpperCase()} / RX 0x{m.rx.toString(16).toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  type="text"
                  value={wfIntent}
                  onChange={e => setWfIntent(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && wfIntent.trim() && !wfLoading) handleWorkflow(); }}
                  placeholder="What do you want to do? e.g. change VIN in the radio"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6,
                    border: `1px solid ${S.border}`, background: '#FFF',
                    fontFamily: S.font, fontSize: 13, color: S.text,
                  }}
                />
                <button
                  onClick={handleWorkflow}
                  disabled={!wfIntent.trim() || wfLoading}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: 'none',
                    background: wfLoading ? '#90CAF9' : '#1976D2', color: '#FFF',
                    fontFamily: S.font, fontWeight: 900, fontSize: 12,
                    cursor: wfLoading ? 'wait' : 'pointer', opacity: (!wfIntent.trim() || wfLoading) ? 0.5 : 1,
                  }}
                >
                  {wfLoading ? 'Generating...' : '⚡ Generate Workflow'}
                </button>
              </div>
              {/* Quick presets */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {['Change VIN in the radio', 'Read all DTCs from ECM', 'Unlock BCM programming', 'Write odometer to IPC', 'Read ECM calibration ID', 'Clear DTCs all modules'].map(preset => (
                  <button
                    key={preset}
                    onClick={() => setWfIntent(preset)}
                    style={{
                      padding: '4px 10px', borderRadius: 12, border: `1px solid ${S.border}`,
                      background: '#FAFAFA', fontSize: 10, fontFamily: S.font,
                      color: S.dim, cursor: 'pointer',
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              {wfError && (
                <div style={{ padding: 10, borderRadius: 6, background: '#FFEBEE', border: '1px solid #EF5350', color: '#C62828', fontSize: 12, marginBottom: 10 }}>
                  {wfError}
                </div>
              )}
              {wfResult && (
                <div style={{ borderRadius: 8, border: `1px solid #90CAF9`, background: '#FFF', padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                    <div style={{ fontWeight: 900, fontSize: 14, color: '#1565C0', flex: 1 }}>
                      {wfResult.title}
                    </div>
                    <button
                      onClick={() => {
                        const lines = [
                          `# ${wfResult.title}`,
                          `Module: ${wfResult.module.code} (${wfResult.module.name}) · TX ${wfResult.module.tx} · RX ${wfResult.module.rx}`,
                          '',
                          ...(wfResult.prerequisites?.length ? ['Prerequisites:', ...wfResult.prerequisites.map(p => `  • ${p}`), ''] : []),
                          'Steps:',
                          ...(wfResult.steps?.map(s =>
                            `  ${s.step}. [${s.service}] ${s.hex}  → ${s.expectedResponse || '?'}  // ${s.description}${s.notes ? ` ⚠ ${s.notes}` : ''}`
                          ) || []),
                          ...(wfResult.warnings?.length ? ['', 'Warnings:', ...wfResult.warnings.map(w => `  ⚠ ${w}`)] : []),
                          ...(wfResult.postActions?.length ? ['', 'Post-workflow:', ...wfResult.postActions.map(a => `  • ${a}`)] : []),
                        ].join('\n');
                        navigator.clipboard.writeText(lines).then(() => {
                          setWfCopied(true);
                          setTimeout(() => setWfCopied(false), 2000);
                        });
                      }}
                      style={{
                        padding: '3px 10px', borderRadius: 5, border: '1px solid #90CAF9',
                        background: wfCopied ? '#E8F5E9' : '#E3F2FD',
                        color: wfCopied ? '#388E3C' : '#1565C0',
                        fontSize: 10, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                        transition: 'all 0.2s',
                      }}
                      title="Copy all steps as plain text"
                    >
                      {wfCopied ? '✓ Copied' : '📋 Copy All'}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: S.dim, marginBottom: 12 }}>
                    Module: {wfResult.module.code} ({wfResult.module.name}) · TX {wfResult.module.tx} · RX {wfResult.module.rx}
                  </div>
                  {/* Prerequisites */}
                  {wfResult.prerequisites?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#F57C00', marginBottom: 4 }}>PREREQUISITES</div>
                      {wfResult.prerequisites.map((p, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#E65100', paddingLeft: 10, lineHeight: 1.6 }}>• {p}</div>
                      ))}
                    </div>
                  )}
                  {/* Steps */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#1565C0', marginBottom: 8 }}>WORKFLOW STEPS</div>
                    {wfResult.steps?.map((step, i) => (
                      <div key={i} style={{
                        padding: '10px 12px', marginBottom: 6, borderRadius: 6,
                        background: '#F5F5F5', border: '1px solid #E0E0E0',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{
                            background: '#1976D2', color: '#FFF', borderRadius: '50%',
                            width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 10, fontWeight: 900, flexShrink: 0,
                          }}>{step.step}</span>
                          <span style={{ fontWeight: 700, fontSize: 12, color: '#333' }}>{step.service}</span>
                          <button
                            onClick={() => { setRawCmd(step.hex); addLog(`Loaded step ${step.step}: ${step.hex}`, 'info'); }}
                            style={{
                              marginLeft: 'auto', padding: '2px 8px', borderRadius: 4,
                              border: '1px solid #90CAF9', background: '#E3F2FD',
                              fontSize: 9, fontWeight: 700, color: '#1565C0', cursor: 'pointer',
                            }}
                            title="Load this command into the UDS command input"
                          >→ Load</button>
                        </div>
                        <div style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 13, fontWeight: 700, color: '#1565C0',
                          background: '#E8F5E9', padding: '4px 8px', borderRadius: 4, marginBottom: 4,
                        }}>
                          {step.hex}
                        </div>
                        <div style={{ fontSize: 11, color: '#555', lineHeight: 1.5 }}>{step.description}</div>
                        {step.expectedResponse && (
                          <div style={{ fontSize: 10, color: '#388E3C', marginTop: 3 }}>
                            Expected: {step.expectedResponse}
                          </div>
                        )}
                        {step.notes && step.notes !== '' && (
                          <div style={{ fontSize: 10, color: '#F57C00', marginTop: 2 }}>
                            ⚠ {step.notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Warnings */}
                  {wfResult.warnings?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#D32F2F', marginBottom: 4 }}>⚠ WARNINGS</div>
                      {wfResult.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#C62828', paddingLeft: 10, lineHeight: 1.6 }}>• {w}</div>
                      ))}
                    </div>
                  )}
                  {/* Post Actions */}
                  {wfResult.postActions?.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#388E3C', marginBottom: 4 }}>POST-WORKFLOW</div>
                      {wfResult.postActions.map((a, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#2E7D32', paddingLeft: 10, lineHeight: 1.6 }}>• {a}</div>
                      ))}
                    </div>
                  )}
                  {/* Execute All button */}
                  {isLive && wfResult.steps?.length > 0 && (
                    <div style={{ marginTop: 12, borderTop: '1px solid #E0E0E0', paddingTop: 12 }}>
                      <button
                        onClick={() => {
                          wfResult.steps.forEach((step, i) => {
                            setTimeout(() => {
                              setRawCmd(step.hex);
                              addLog(`Queued step ${step.step}: ${step.service} → ${step.hex}`, 'info');
                            }, i * 200);
                          });
                        }}
                        style={{
                          padding: '8px 16px', borderRadius: 6, border: 'none',
                          background: '#388E3C', color: '#FFF',
                          fontFamily: S.font, fontWeight: 900, fontSize: 12, cursor: 'pointer',
                        }}
                      >
                        ⚡ Load All Steps Sequentially
                      </button>
                      <span style={{ fontSize: 10, color: S.dim, marginLeft: 8 }}>
                        Each step will be loaded into the command input
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Security Access panel ──────────────────────────────────────── */}
        {isLive && (
          <div style={{
            borderRadius: 8, border: `1px solid ${saOpen ? "#FFB74D" : S.border}`,
            background: saOpen ? "#FFF8E1" : S.card, marginBottom: 12, overflow: "hidden",
            transition: "border-color 0.2s",
          }}>
            {/* Collapsible header */}
            <button
              onClick={() => setSaOpen(o => !o)}
              style={{
                width: "100%", padding: "10px 16px", background: "none", border: "none",
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                fontFamily: S.font, color: S.text, textAlign: "left",
              }}
            >
              <span style={{ fontSize: 13, lineHeight: 1 }}>{saOpen ? "▾" : "▸"}</span>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, color: S.yellow }}>SECURITY ACCESS</span>
              <span style={{ fontSize: 10, color: S.dim, marginLeft: 4 }}>27/67 seed-key unlock</span>
              {saOpen && (
                <span style={{
                  marginLeft: "auto", fontSize: 9, padding: "2px 7px", borderRadius: 4,
                  background: saSweepLevels ? "#E8F5E9" : "#FFF3E0",
                  color: saSweepLevels ? S.green : S.yellow,
                  border: `1px solid ${saSweepLevels ? "#66BB6A" : "#FF8F00"}`, fontWeight: 700,
                }}>
                  {saSweepLevels ? `SWEEP ×${SA_LEVELS.length}` : SA_LEVELS[saLevelIdx].label.split("—")[0].trim()} · {(SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0]).n}
                </span>
              )}
            </button>

            {/* Panel body */}
            {saOpen && (
              <div style={{ padding: "0 16px 16px" }}>
                {/* Level picker */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                    <div style={{ fontSize: 10, color: S.dim, fontWeight: 700, letterSpacing: 1 }}>SECURITY LEVEL</div>
                    {saDetectedLevel && (
                      <div style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#E8F5E9", color: S.green, border: `1px solid #A5D6A7`, fontWeight: 700, fontFamily: S.mono }}>
                        ✓ detected: 0x{hx(saDetectedLevel.seed)}
                      </div>
                    )}
                  </div>
                  <select
                    value={saLevelIdx}
                    onChange={e => setSaLevelIdx(Number(e.target.value))}
                    style={{
                      width: "100%", padding: "7px 10px", borderRadius: 6,
                      border: `1px solid ${S.yellow}`, background: "#FFF3E0",
                      color: S.yellow, fontFamily: S.mono, fontSize: 11, fontWeight: 700,
                      cursor: "pointer", outline: "none",
                    }}
                  >
                    {SA_LEVELS.map((lv, i) => (
                      <option key={lv.label} value={i}>
                        {lv.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 9, marginTop: 4, color: S.dim, fontFamily: S.mono }}>
                    seed 0x{hx(SA_LEVELS[saLevelIdx].seed)} → key 0x{hx(SA_LEVELS[saLevelIdx].key)}
                  </div>
                </div>

                {/* Algorithm picker */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 10, color: S.dim, fontWeight: 700, letterSpacing: 1 }}>ALGORITHM</div>
                    {saDetectedAlgo && (
                      <div style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#E8F5E9", color: S.green, border: `1px solid #A5D6A7`, fontWeight: 700, fontFamily: S.mono }}>
                        ✓ auto-detected: {(SA_ALGOS.find(a => a.id === saDetectedAlgo) || { n: saDetectedAlgo }).n}
                      </div>
                    )}
                    {saRememberedAlgo && !saDetectedAlgo && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "#E3F2FD", color: S.blue, border: "1px solid #90CAF9", fontWeight: 700, fontFamily: S.mono }}>
                          ★ remembered: {(SA_ALGOS.find(a => a.id === saRememberedAlgo) || { n: saRememberedAlgo }).n}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            localStorage.removeItem(saStorageKey(txHex));
                            setSaRememberedAlgo(null);
                            loadRemembered();
                          }}
                          style={{
                            background: "none", border: "none", color: "#666", fontSize: 9, cursor: "pointer",
                            padding: "2px 4px", textDecoration: "underline", fontFamily: S.font,
                          }}
                        >
                          Forget
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflowY: "auto" }}>
                    {SA_ALGOS.map(algo => {
                      const active = saAlgoId === algo.id;
                      const winner = saDetectedAlgo === algo.id;
                      const remembered = saRememberedAlgo === algo.id;
                      return (
                        <button
                          key={algo.id}
                          onClick={() => setSaAlgoId(algo.id)}
                          title={algo.h}
                          style={{
                            padding: "4px 9px", fontSize: 10, fontWeight: 700, borderRadius: 5,
                            border: `1px solid ${active ? S.yellow : winner ? S.green : remembered ? S.blue : S.border}`,
                            background: active ? "#FFF3E0" : winner ? "#E8F5E9" : remembered ? "#E8EAF6" : "#FAFAFA",
                            color: active ? S.yellow : winner ? S.green : remembered ? S.blue : S.dim,
                            cursor: "pointer", fontFamily: S.mono, whiteSpace: "nowrap",
                          }}
                        >
                          {algo.n}{winner && !active ? " ✓" : (remembered && !active ? " ★" : "")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Hint for the selected algo */}
                <div style={{ fontSize: 10, color: "#555", marginBottom: 12, fontFamily: S.mono }}>
                  {(SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0]).h}
                </div>

                {/* Sweep levels toggle */}
                <label style={{
                  display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                  cursor: "pointer", userSelect: "none",
                }}>
                  <div
                    onClick={() => setSaSweepLevels(v => !v)}
                    style={{
                      width: 34, height: 18, borderRadius: 9, position: "relative",
                      background: saSweepLevels ? "#E8F5E9" : "#F5F5F5",
                      border: `1px solid ${saSweepLevels ? S.green : S.border}`,
                      transition: "all 0.2s", flexShrink: 0,
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 2, left: saSweepLevels ? 16 : 2,
                      width: 12, height: 12, borderRadius: "50%",
                      background: saSweepLevels ? S.green : "#555",
                      transition: "left 0.2s",
                    }} />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: saSweepLevels ? S.green : S.dim, letterSpacing: 1 }}>
                    SWEEP LEVELS
                  </span>
                  <span style={{ fontSize: 10, color: "#444" }}>
                    {saSweepLevels
                      ? `Auto-detect iterates all ${SA_LEVELS.length} SA levels as outer loop`
                      : "Auto-detect uses selected level only"}
                  </span>
                </label>

                {/* Auto-confirm toggle */}
                <label style={{
                  display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
                  cursor: "pointer", userSelect: "none",
                }}>
                  <div
                    onClick={() => setSaAutoConfirm(v => !v)}
                    style={{
                      width: 34, height: 18, borderRadius: 9, position: "relative",
                      background: saAutoConfirm ? "#FFF3E0" : "#F5F5F5",
                      border: `1px solid ${saAutoConfirm ? S.yellow : S.border}`,
                      transition: "all 0.2s", flexShrink: 0,
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 2, left: saAutoConfirm ? 16 : 2,
                      width: 12, height: 12, borderRadius: "50%",
                      background: saAutoConfirm ? S.yellow : "#555",
                      transition: "left 0.2s",
                    }} />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: saAutoConfirm ? S.yellow : S.dim, letterSpacing: 1 }}>
                    AUTO-CONFIRM
                  </span>
                  <span style={{ fontSize: 10, color: "#444" }}>
                    {saAutoConfirm ? "Key will be sent without review" : "Confirm key before sending"}
                  </span>
                </label>

                {/* NRC 0x22 hint callout */}
                {saExtHint && (
                  <div style={{
                    marginBottom: 12, padding: "10px 14px", borderRadius: 6,
                    background: "#FFF3E0", border: "1px solid #FFB74D",
                    borderLeft: "3px solid #FF8F00",
                    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                  }}>
                    <span style={{ fontSize: 12 }}>⚡</span>
                    <span style={{ flex: 1, fontSize: 11, color: "#FF8F00", fontWeight: 700, fontFamily: S.mono }}>
                      Module replied NRC 0x22 — it needs Extended Session (10 03) before Security Access.
                    </span>
                    <button
                      onClick={runExtSessionThenRetry}
                      disabled={busy}
                      style={{
                        padding: "7px 14px", borderRadius: 6, border: `1px solid ${busy ? S.border : "#FF8F00"}`,
                        background: busy ? "#E0E0E0" : "#FFF3E0", color: busy ? "#9E9E9E" : "#E65100",
                        fontFamily: S.font, fontWeight: 800, fontSize: 11, letterSpacing: 0.5,
                        cursor: busy ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                      }}
                    >
                      Send Ext Session then Retry
                    </button>
                  </div>
                )}

                {/* Confirmation interstitial */}
                {saPending && (
                  <div style={{
                    borderRadius: 8, border: `2px solid ${S.yellow}`,
                    background: "#FFF8E1", padding: "14px 16px", marginBottom: 12,
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 800, color: S.yellow, letterSpacing: 1.5, marginBottom: 10,
                    }}>
                      ⚠ CONFIRM KEY SEND
                    </div>
                    <div style={{ fontSize: 10, color: S.dim, marginBottom: 8, lineHeight: 1.7 }}>
                      Review the computed values below. Sending a wrong key can trigger NRC 0x35 (attempt counter)
                      and repeated failures may cause NRC 0x36/0x37 (module lockout).
                    </div>
                    <div style={{
                      display: "grid", gridTemplateColumns: "80px 1fr", gap: "4px 12px",
                      fontFamily: S.mono, fontSize: 11, marginBottom: 14,
                    }}>
                      <span style={{ color: S.dim, fontWeight: 700 }}>Module</span>
                      <span style={{ color: "#333" }}>
                        TX 0x{hx(saPending.tx, 3)} → RX 0x{hx(saPending.rx, 3)}
                      </span>
                      <span style={{ color: S.dim, fontWeight: 700 }}>Level</span>
                      <span style={{ color: "#333" }}>
                        {saPending.level.label.split("—")[0].trim()} (seed 0x{hx(saPending.level.seed)}, key 0x{hx(saPending.level.key)})
                      </span>
                      <span style={{ color: S.dim, fontWeight: 700 }}>Algorithm</span>
                      <span style={{ color: "#333" }}>{saPending.algo.n}</span>
                      <span style={{ color: S.dim, fontWeight: 700 }}>Seed</span>
                      <span style={{ color: "#1565C0", fontWeight: 700 }}>{bytesToHex(saPending.seedBytes)}</span>
                      <span style={{ color: S.dim, fontWeight: 700 }}>Key</span>
                      <span style={{ color: S.green, fontWeight: 700 }}>{bytesToHex(saPending.keyBytes)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <button
                        onClick={confirmSendKey}
                        disabled={busy}
                        style={{
                          flex: 1, padding: "9px 0", borderRadius: 6,
                          border: `1px solid ${busy ? S.border : S.green}`,
                          background: busy ? "#E0E0E0" : "#E8F5E9",
                          color: busy ? "#9E9E9E" : S.green,
                          fontFamily: S.font, fontWeight: 800, fontSize: 12, letterSpacing: 1,
                          cursor: busy ? "not-allowed" : "pointer",
                        }}
                      >
                        {busy ? "Sending…" : "✓ Send Key"}
                      </button>
                      <button
                        onClick={cancelSendKey}
                        disabled={busy}
                        style={{
                          padding: "9px 18px", borderRadius: 6,
                          border: `1px solid ${S.border}`,
                          background: "none", color: S.dim,
                          fontFamily: S.font, fontWeight: 700, fontSize: 12,
                          cursor: busy ? "not-allowed" : "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Action buttons — hidden while confirmation is pending */}
                {!saPending && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={runAutoDetect}
                      disabled={busy}
                      style={{
                        flex: 1, padding: "10px 0", borderRadius: 6,
                        border: `1px solid ${busy ? S.border : S.green}`,
                        background: busy ? "#E0E0E0" : "#E8F5E9", color: busy ? "#9E9E9E" : S.green,
                        fontFamily: S.font, fontWeight: 800, fontSize: 11, letterSpacing: 1,
                        cursor: busy ? "not-allowed" : "pointer", transition: "all 0.2s",
                      }}
                    >
                      {busy ? "Running…" : "⟳ Auto-detect Algorithm"}
                    </button>
                    <button
                      onClick={runSecurityAccess}
                      disabled={busy}
                      style={{
                        flex: 2, padding: "10px 0", borderRadius: 6,
                        border: `1px solid ${busy ? S.border : S.yellow}`,
                        background: busy ? "#E0E0E0" : "#FFF3E0", color: busy ? "#9E9E9E" : S.yellow,
                        fontFamily: S.font, fontWeight: 800, fontSize: 11, letterSpacing: 1,
                        cursor: busy ? "not-allowed" : "pointer", transition: "all 0.2s",
                      }}
                    >
                      {busy ? "Running…" : "▶ Request Seed → Compute Key"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Remembered Algorithms management panel ───────────────────── */}
        <div style={{
          borderRadius: 8,
          border: `1px solid ${saMemoryOpen ? "#90CAF9" : S.border}`,
          background: saMemoryOpen ? "#E3F2FD" : S.card,
          marginBottom: 12, overflow: "hidden", transition: "border-color 0.2s",
        }}>
          <button
            onClick={() => setSaMemoryOpen(o => !o)}
            style={{
              width: "100%", padding: "10px 16px", background: "none", border: "none",
              display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
              fontFamily: S.font, color: S.text, textAlign: "left",
            }}
          >
            <span style={{ fontSize: 13, lineHeight: 1 }}>{saMemoryOpen ? "▾" : "▸"}</span>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.5, color: S.blue }}>REMEMBERED ALGORITHMS</span>
            <span style={{ fontSize: 10, color: S.dim, marginLeft: 4 }}>saved address → algo mappings</span>
            {rememberedEntries.length > 0 && (
              <span style={{
                marginLeft: "auto", fontSize: 9, padding: "2px 7px", borderRadius: 4,
                background: "#E3F2FD", color: S.blue,
                border: "1px solid #90CAF9", fontWeight: 700,
              }}>
                {rememberedEntries.length} saved
              </span>
            )}
          </button>

          {saMemoryOpen && (
            <div style={{ padding: "0 16px 16px" }}>
              {rememberedEntries.length === 0 ? (
                <div style={{ fontSize: 11, color: S.dim, fontFamily: S.mono, padding: "8px 0" }}>
                  {"// No remembered algorithms — successfully unlock a module to save one automatically."}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 9, color: "#444", fontWeight: 700, letterSpacing: 1, fontFamily: S.mono }}>
                      {rememberedEntries.length} {rememberedEntries.length === 1 ? "entry" : "entries"}
                    </span>
                    <button
                      onClick={clearAllRemembered}
                      style={{
                        padding: "5px 12px", borderRadius: 5,
                        border: `1px solid ${S.red}`,
                        background: "none", color: S.red,
                        fontFamily: S.font, fontWeight: 700, fontSize: 10,
                        cursor: "pointer", letterSpacing: 0.5,
                      }}
                    >
                      Clear All
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {rememberedEntries.map(e => (
                      <div key={e.key} style={{
                        display: "grid",
                        gridTemplateColumns: "72px 90px 1fr auto",
                        gap: "0 12px", alignItems: "center",
                        padding: "7px 10px", borderRadius: 5,
                        background: "#F5F5F5", border: `1px solid ${S.border}`,
                      }}>
                        <span style={{ fontSize: 11, color: "#555", fontFamily: S.mono, fontWeight: 700 }}>
                          {e.moduleName || "—"}
                        </span>
                        <span style={{ fontSize: 11, color: "#1565C0", fontFamily: S.mono }}>
                          {e.addrStr}
                        </span>
                        <span style={{ fontSize: 11, color: S.yellow, fontFamily: S.mono }}>
                          {e.algoName}
                        </span>
                        <button
                          onClick={() => forgetEntry(e.key)}
                          style={{
                            background: "none", border: "none",
                            color: S.dim, fontSize: 10, cursor: "pointer",
                            padding: "2px 6px", fontFamily: S.font,
                            textDecoration: "underline",
                          }}
                        >
                          Forget
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Log panel ─────────────────────────────────────────────────── */}
        <div style={{ borderRadius: 8, border: `1px solid ${S.border}`, background: "#FAFAFA", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "8px 14px", borderBottom: `1px solid ${S.border}`, background: S.card }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5 }}>
              LOG {log.length > 0 && <span style={{ color: "#555", fontWeight: 400 }}>({log.length})</span>}
            </span>
            {log.length > 0 && (
              <button onClick={() => setLog([])} style={{
                background: "none", border: "none", color: S.dim, cursor: "pointer", fontSize: 11, fontFamily: S.font,
              }}>Clear</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 12, padding: "4px 14px", borderBottom: `1px solid ${S.border}`, background: "#F5F5F5", fontSize: 9, fontFamily: S.mono, color: S.dim }}>
            <span><span style={{ color: logColor.tx }}>●</span> TX</span>
            <span><span style={{ color: logColor.rx }}>●</span> RX</span>
            <span><span style={{ color: logColor.error }}>●</span> ERR</span>
            <span><span style={{ color: logColor.warn }}>●</span> WARN</span>
            <span><span style={{ color: logColor.header }}>●</span> HDR</span>
          </div>
          <div ref={logRef} style={{
            minHeight: 260, maxHeight: 420, overflowY: "auto",
            padding: "10px 14px", fontFamily: S.mono, fontSize: 11, lineHeight: 1.6,
          }}>
            {log.length === 0 ? (
              <div style={{ color: "#333" }}>// idle — connect the bridge and select a module target</div>
            ) : (
              log.map((l, i) => (
                <div key={i} style={{
                  color: logColor[l.type] || S.dim,
                  ...(l.type === "hint" ? {
                    background: "#FFF3E0",
                    border: "1px solid #FFB74D",
                    borderLeft: "3px solid #E65100",
                    borderRadius: 4,
                    padding: "3px 8px",
                    margin: "3px 0",
                    fontWeight: 700,
                  } : {}),
                }}>
                  <span style={{ color: l.type === "hint" ? "#E65100" : "#888", userSelect: "none" }}>[{l.ts}] </span>
                  {l.type === "hint" && <span style={{ marginRight: 5 }}>⚡</span>}
                  {l.msg}
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
