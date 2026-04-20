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
  const [found, setFound] = useState([]);
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
    }
  }, [status, udsExchange, log]);

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

        {/* Found modules */}
        {found.length > 0 && (
          <div style={{ background: "#1A2E1A", border: "1px solid " + S.green, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#66BB6A", marginBottom: 8 }}>
              MODULES FOUND: {found.length}
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
