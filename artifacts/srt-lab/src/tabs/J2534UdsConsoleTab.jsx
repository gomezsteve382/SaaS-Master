import { useState, useCallback, useRef, useEffect } from "react";
import { getStatus, open as openBridge, connect as bridgeConnect, setFilter, sendMsg, readMsg, getAutelState } from "../lib/bridgeClient.js";
import { decodeNRC } from "../lib/nrc.js";
import { ALGOS, unlockKeyBytes } from "../lib/algos.js";

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
  bg:     "#0A0A0F",
  card:   "#12121A",
  border: "#1E1E2E",
  text:   "#E0E0E0",
  dim:    "#666",
  red:    "#DC143C",
  green:  "#00C853",
  blue:   "#2196F3",
  yellow: "#FFB300",
  font:   '"Nunito", sans-serif',
  mono:   '"JetBrains Mono", monospace',
};

/* ─── Status badge ────────────────────────────────────────────────────────── */
const STATUS_META = {
  disconnected:    { label: "○ NO BRIDGE",   bg: "#1A1A1A", color: S.dim },
  bridge_connected:{ label: "● BRIDGE OK",   bg: "#1A1A1A", color: "#AAA" },
  device_open:     { label: "● DEVICE OPEN", bg: "#1A1A1A", color: S.yellow },
  can_connected:   { label: "● CAN LIVE",    bg: "#003300", color: S.green },
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
        background: disabled ? "#222" : color,
        color: disabled ? "#555" : "#fff",
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
  { label: "0x01 — Default / Programming", seed: 0x01, key: 0x02 },
  { label: "0x03 — Extended level 3",      seed: 0x03, key: 0x04 },
  { label: "0x05 — Extended level 5",      seed: 0x05, key: 0x06 },
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

  /* Security Access panel state */
  const [saOpen, setSaOpen] = useState(false);
  const [saLevelIdx, setSaLevelIdx] = useState(0);
  const [saAlgoId, setSaAlgoId] = useState("cda6");

  const logRef = useRef(null);
  const periodicIdRef = useRef(null);
  const urlRef = useRef(getAutelState().url);

  /* Keep URL ref fresh whenever component re-renders */
  urlRef.current = getAutelState().url;

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

  /* ── Disconnect / reset ──────────────────────────────────────────────── */
  const disconnect = useCallback(async () => {
    const pid = periodicIdRef.current;
    if (pid != null) {
      await bridgeCallRaw(urlRef.current, "/stopperiodic", { periodicId: pid }).catch(() => {});
      periodicIdRef.current = null;
    }
    setStatus("disconnected");
    setLog([]);
    addLog("Disconnected — log cleared.", "info");
  }, [addLog]);

  /* ── Step 1: probe bridge ────────────────────────────────────────────── */
  const connectBridge = useCallback(async () => {
    addLog("Probing bridge at " + urlRef.current + " …");
    setBusy(true);
    try {
      const st = await getStatus(urlRef.current);
      if (!st || !st.ok) {
        addLog("Cannot reach bridge: " + (st?.error || "no response"), "error");
        addLog("Make sure j2534_bridge.py is running (port 8765).", "error");
        setStatus("disconnected");
        return;
      }
      addLog(`Bridge OK — vendor=${st.vendor || "?"} platform=${st.platform || "?"} bridge=${st.bridgeVersion || "?"}`, "success");
      if (st.dllPath) addLog("DLL: " + st.dllPath);
      if (!st.dllLoaded) {
        addLog("No DLL loaded — restart bridge with --dll <vendor DLL>", "warn");
        setStatus("bridge_connected");
        return;
      }
      if (st.deviceOpen && st.channelConnected) {
        addLog("Device already open and ISO15765 channel is up.", "success");
        await startKeepalive();
        setStatus("can_connected");
        return;
      }
      if (st.deviceOpen) {
        setStatus("device_open");
        return;
      }
      setStatus("bridge_connected");
    } finally {
      setBusy(false);
    }
  }, [addLog]);

  /* ── Step 2+3: open device + connect channel ────────────────────────── */
  const openDevice = useCallback(async () => {
    addLog("Opening J2534 device (PassThruOpen) …");
    setBusy(true);
    try {
      const opened = await openBridge(urlRef.current);
      if (!opened || !opened.ok) {
        addLog("Open failed: " + (opened?.error || "unknown"), "error");
        return;
      }
      addLog(`Device opened${opened.versions?.firmware ? " fw " + opened.versions.firmware : ""}`, "success");
      setStatus("device_open");

      addLog("Connecting ISO15765 channel @ 500 kbps …");
      const c = await bridgeConnect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, urlRef.current);
      if (!c || !c.ok) {
        addLog("Channel connect failed: " + (c?.error || "unknown"), "error");
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
          addLog(`NRC 0x${hx(r.d[2])}: ${decodeNRC(r.d[2])}`, "warn");
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
    send(bytes);
  }, [rawCmd, send]);

  /* ── Security Access unlock flow ────────────────────────────────────── */
  const runSecurityAccess = useCallback(async () => {
    if (status !== "can_connected") { addLog("Bridge not connected — connect first.", "error"); return; }
    const tx = parseAddr(txHex);
    const rx = parseAddr(rxHex);
    if (isNaN(tx) || isNaN(rx)) { addLog("Invalid TX/RX address.", "error"); return; }

    const level = SA_LEVELS[saLevelIdx];
    const algo  = SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0];

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

      /* Step 3: Send key — 27 XX+1 */
      const keyReq = [0x27, level.key & 0xFF, ...keyBytes];
      addLog(`TX → 0x${hx(tx, 3)}: ${bytesToHex(keyReq)}  (sendKey)`, "tx");
      const kr = await udsCall(urlRef.current, tx, rx, keyReq, 5000);
      if (!kr.ok || !kr.d) {
        addLog("Send-key failed: " + (kr.raw || "no response"), "error");
        return;
      }
      addLog(`RX ← 0x${hx(rx, 3)}: ${bytesToHex(kr.d)}`, "rx");

      if (kr.d[0] === 0x7F) {
        const nrc = kr.d.length >= 3 ? kr.d[2] : 0;
        addLog(`NRC 0x${hx(nrc)}: ${decodeNRC(nrc)} — wrong key or wrong algorithm`, "error");
      } else if (kr.d[0] === 0x67 && kr.d[1] === (level.key & 0xFF)) {
        addLog("Security access GRANTED ✓", "success");
      } else {
        addLog(`Unexpected send-key response: ${bytesToHex(kr.d)}`, "warn");
      }
    } finally {
      setBusy(false);
    }
  }, [status, txHex, rxHex, saLevelIdx, saAlgoId, addLog]);

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
  const logColor = { tx: "#4FC3F7", rx: "#69F0AE", error: "#FF5252", warn: "#FFB300", success: "#69F0AE", info: "#AAA", header: "#BB86FC" };

  return (
    <div style={{ background: S.bg, minHeight: "100%", padding: 16, fontFamily: S.font, color: S.text }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16,
            padding: "14px 18px", borderRadius: 10, border: `1px solid ${S.border}`,
            background: "linear-gradient(135deg,#0D1B2A 0%,#0A1628 60%,#0F2240 100%)" }}>
          <div style={{ fontSize: 28 }}>🔌</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2, color: "#E0E0E0" }}>UDS CONSOLE</div>
            <div style={{ fontSize: 10, opacity: 0.6, letterSpacing: 3, fontWeight: 700, marginTop: 2 }}>J2534 · RAW UDS · ANY MODULE</div>
          </div>
          <StatusBadge status={status} />
        </div>

        {/* ── Connection strip ──────────────────────────────────────────── */}
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${S.border}`,
            background: S.card, marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5 }}>BRIDGE</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: S.dim, fontFamily: S.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {urlRef.current}
          </div>
          {status === "disconnected" && (
            <Btn onClick={connectBridge} disabled={busy} color={S.blue}>Connect Bridge</Btn>
          )}
          {status === "bridge_connected" && (
            <Btn onClick={openDevice} disabled={busy} color={S.yellow}>Open Device</Btn>
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
              background: "#0A0A0F", color: S.text, fontFamily: S.mono, fontSize: 11,
              marginBottom: 8, boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 96, overflowY: "auto", marginBottom: 12 }}>
            {filteredModules.map(m => {
              const active = txHex.toLowerCase() === ("0x" + hx(m.tx, 3)).toLowerCase();
              return (
                <button key={m.name} onClick={() => pickModule(m)} style={{
                  padding: "4px 9px", fontSize: 10, fontWeight: 700, borderRadius: 5,
                  border: `1px solid ${active ? S.green : S.border}`,
                  background: active ? "#003300" : "#0A0A0F",
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
                  background: "#0A0A0F", color: "#4FC3F7", fontFamily: S.mono, fontSize: 13, fontWeight: 700, boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: S.dim, marginBottom: 4, fontWeight: 700 }}>RX ADDRESS</div>
              <input value={rxHex} onChange={e => setRxHex(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${S.border}`,
                  background: "#0A0A0F", color: "#69F0AE", fontFamily: S.mono, fontSize: 13, fontWeight: 700, boxSizing: "border-box" }} />
            </div>
          </div>
        </div>

        {/* ── UDS command card ──────────────────────────────────────────── */}
        <div style={{ padding: "12px 16px", borderRadius: 8, border: `1px solid ${isLive ? "#1E3A2E" : S.border}`,
            background: S.card, marginBottom: 12, opacity: isLive ? 1 : 0.55 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: S.dim, letterSpacing: 1.5, marginBottom: 10 }}>UDS COMMAND</div>

          {/* Raw hex + send */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <input
              value={rawCmd}
              onChange={e => setRawCmd(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && isLive && !busy) sendRaw(); }}
              placeholder="hex bytes — e.g. 22 F1 90"
              disabled={!isLive}
              style={{ flex: 1, padding: "9px 12px", borderRadius: 6, border: `1px solid ${S.border}`,
                background: "#0A0A0F", color: S.text, fontFamily: S.mono, fontSize: 13, fontWeight: 700 }}
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
                  border: `1px solid ${S.border}`, background: "#14141E",
                  color: isLive ? "#CCC" : S.dim, cursor: isLive && !busy ? "pointer" : "not-allowed",
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

        {/* ── Security Access panel ──────────────────────────────────────── */}
        {isLive && (
          <div style={{
            borderRadius: 8, border: `1px solid ${saOpen ? "#4A3000" : S.border}`,
            background: saOpen ? "#0D0900" : S.card, marginBottom: 12, overflow: "hidden",
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
                  background: "#2A1A00", color: S.yellow, border: `1px solid #5A3A00`, fontWeight: 700,
                }}>
                  {SA_LEVELS[saLevelIdx].label.split("—")[0].trim()} · {(SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0]).n}
                </span>
              )}
            </button>

            {/* Panel body */}
            {saOpen && (
              <div style={{ padding: "0 16px 16px" }}>
                {/* Level picker */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: S.dim, marginBottom: 6, fontWeight: 700, letterSpacing: 1 }}>SECURITY LEVEL</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {SA_LEVELS.map((lv, i) => (
                      <button
                        key={lv.label}
                        onClick={() => setSaLevelIdx(i)}
                        style={{
                          flex: 1, padding: "7px 10px", borderRadius: 6, border: `1px solid ${saLevelIdx === i ? S.yellow : S.border}`,
                          background: saLevelIdx === i ? "#1A1000" : "#0A0A0F",
                          color: saLevelIdx === i ? S.yellow : S.dim,
                          cursor: "pointer", fontFamily: S.mono, fontSize: 10, fontWeight: 700,
                        }}
                      >
                        <div>{lv.label.split("—")[0].trim()}</div>
                        <div style={{ fontSize: 9, marginTop: 2, color: S.dim, fontWeight: 400 }}>seed {hx(lv.seed)} → key {hx(lv.key)}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Algorithm picker */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: S.dim, marginBottom: 6, fontWeight: 700, letterSpacing: 1 }}>ALGORITHM</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflowY: "auto" }}>
                    {SA_ALGOS.map(algo => {
                      const active = saAlgoId === algo.id;
                      return (
                        <button
                          key={algo.id}
                          onClick={() => setSaAlgoId(algo.id)}
                          title={algo.h}
                          style={{
                            padding: "4px 9px", fontSize: 10, fontWeight: 700, borderRadius: 5,
                            border: `1px solid ${active ? S.yellow : S.border}`,
                            background: active ? "#1A1000" : "#0A0A0F",
                            color: active ? S.yellow : S.dim,
                            cursor: "pointer", fontFamily: S.mono, whiteSpace: "nowrap",
                          }}
                        >
                          {algo.n}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Hint for the selected algo */}
                <div style={{ fontSize: 10, color: "#555", marginBottom: 12, fontFamily: S.mono }}>
                  {(SA_ALGOS.find(a => a.id === saAlgoId) || SA_ALGOS[0]).h}
                </div>

                {/* Unlock button */}
                <button
                  onClick={runSecurityAccess}
                  disabled={busy}
                  style={{
                    width: "100%", padding: "10px 0", borderRadius: 6, border: `1px solid ${busy ? S.border : S.yellow}`,
                    background: busy ? "#222" : "#1A1000", color: busy ? "#555" : S.yellow,
                    fontFamily: S.font, fontWeight: 800, fontSize: 12, letterSpacing: 1,
                    cursor: busy ? "not-allowed" : "pointer", transition: "all 0.2s",
                  }}
                >
                  {busy ? "Running…" : "▶ Request Seed → Compute Key → Send Key"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Log panel ─────────────────────────────────────────────────── */}
        <div style={{ borderRadius: 8, border: `1px solid ${S.border}`, background: "#07070D", overflow: "hidden" }}>
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
          <div ref={logRef} style={{
            minHeight: 260, maxHeight: 420, overflowY: "auto",
            padding: "10px 14px", fontFamily: S.mono, fontSize: 11, lineHeight: 1.6,
          }}>
            {log.length === 0 ? (
              <div style={{ color: "#333" }}>// idle — connect the bridge and select a module target</div>
            ) : (
              log.map((l, i) => (
                <div key={i} style={{ color: logColor[l.type] || S.dim }}>
                  <span style={{ color: "#444", userSelect: "none" }}>[{l.ts}] </span>
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
