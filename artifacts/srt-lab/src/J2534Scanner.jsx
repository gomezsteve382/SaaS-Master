import { useState, useCallback, useRef, useEffect } from "react";
import { ASSET_IDS } from "./lib/downloadAssets.js";
import { useDownloadCount } from "./lib/useDownloadCount.jsx";
import { buildOnePagerPDF } from "./lib/buildOnePagerPDF.js";
import { J2534_REF } from "./lib/tabReferences.js";

/**
 * J2534 Module Scanner
 * Connects to j2534_bridge.py via WebSocket on ws://localhost:8765
 * Bypasses ELM327 AT commands entirely — raw CAN via J2534 PassThru API
 *
 * Setup:
 *   1. pip install websockets
 *   2. python j2534_bridge.py
 *   3. Open this in Chrome
 */

export default function J2534Scanner() {
  const [ws, setWs] = useState(null);
  const [status, setStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);
  const [found, setFound] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const logRef = useRef(null);
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

  const log = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((p) => [...p.slice(-400), { ts, msg, type }]);
  }, []);

  const sendCmd = useCallback(
    (cmd) => {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket not connected"));
          return;
        }
        const handler = (e) => {
          try {
            const resp = JSON.parse(e.data);
            if (resp.type === "scanProgress") {
              log(resp.message, "scan");
              return;
            }
            ws.removeEventListener("message", handler);
            resolve(resp);
          } catch (err) {
            ws.removeEventListener("message", handler);
            reject(err);
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify(cmd));
        setTimeout(() => {
          ws.removeEventListener("message", handler);
          reject(new Error("Timeout"));
        }, 30000);
      });
    },
    [ws, log]
  );

  const connectBridge = useCallback(async () => {
    log("Connecting to J2534 bridge on ws://localhost:8765...");
    try {
      const socket = new WebSocket("ws://localhost:8765");
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("Cannot connect to bridge. Is j2534_bridge.py running?"));
        setTimeout(() => reject(new Error("Connection timeout")), 5000);
      });
      setWs(socket);
      setStatus("bridge_connected");
      log("Bridge connected!", "success");

      const listHandler = (e) => {
        try {
          const resp = JSON.parse(e.data);
          if (resp.devices) {
            setDevices(resp.devices);
            resp.devices.forEach((d) => log(`Found J2534 device: ${d.name}`, "success"));
          }
        } catch (err) {}
      };
      socket.addEventListener("message", listHandler, { once: true });
      socket.send(JSON.stringify({ command: "ListDevices" }));

      socket.onclose = () => {
        setStatus("disconnected");
        setWs(null);
        log("Bridge disconnected", "error");
      };
    } catch (e) {
      log("Bridge connection failed: " + e.message, "error");
      log("Make sure j2534_bridge.py is running: python j2534_bridge.py", "error");
    }
  }, [log]);

  const openDevice = useCallback(async () => {
    try {
      log("Opening J2534 device...");
      const resp = await sendCmd({ command: "Open" });
      if (resp.success) {
        log(`Device opened: ${resp.deviceName || "J2534"}`, "success");
        setStatus("device_open");

        log("Connecting to CAN bus (ISO15765, 500kbps)...");
        const connResp = await sendCmd({ command: "Connect", baudRate: 500000 });
        if (connResp.success) {
          log("CAN bus connected — ISO15765 500kbps", "success");
          setStatus("can_connected");
        } else {
          log("CAN connect failed", "error");
        }
      } else {
        log("Device open failed — check USB connection", "error");
      }
    } catch (e) {
      log("Error: " + e.message, "error");
    }
  }, [sendCmd, log]);

  const scanAll = useCallback(async () => {
    setScanning(true);
    setFound([]);
    log("═══ Starting J2534 full module scan ═══", "header");
    log("Scanning ALL known FCA module addresses via raw CAN...");

    try {
      const resp = await sendCmd({ command: "Scan" });
      if (resp.success) {
        setFound(resp.found || []);
        log(`═══ Scan complete: ${resp.found?.length || 0} modules found out of ${resp.total} ═══`, "header");
        (resp.found || []).forEach((m) => {
          log(
            `✓ ${m.name} TX:0x${m.tx.toString(16).toUpperCase().padStart(3, "0")} RX:0x${m.rx.toString(16).toUpperCase().padStart(3, "0")} VIN:${m.vin || "?"}`,
            "success"
          );
        });
      } else {
        log("Scan failed: " + (resp.error || "unknown"), "error");
      }
    } catch (e) {
      log("Scan error: " + e.message, "error");
    }
    setScanning(false);
  }, [sendCmd, log]);

  const sendUDS = useCallback(
    async (tx, rx, data, label) => {
      try {
        log(
          `TX [${label}] → 0x${tx.toString(16).toUpperCase()}: ${data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}`,
          "tx"
        );
        const resp = await sendCmd({ command: "UDS", txId: tx, rxId: rx, data, timeout: 3000 });
        if (resp.success) {
          log(
            `RX [${label}] ← 0x${resp.canId.toString(16).toUpperCase()}: ${resp.data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}`,
            "rx"
          );
          return resp;
        } else {
          log(`[${label}] No response`, "warn");
          return null;
        }
      } catch (e) {
        log(`[${label}] Error: ${e.message}`, "error");
        return null;
      }
    },
    [sendCmd, log]
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
            The J2534 bridge runs locally on your laptop and exposes the adapter to the browser via WebSocket.
          </div>
          <div style={{ marginTop: 8 }}>
            <BridgeDownloadLink S={S} />
            <span style={{ color: S.dim, marginLeft: 12 }}>then: pip install websockets &amp;&amp; python j2534_bridge.py</span>
          </div>
        </div>

        {/* Setup instructions */}
        {status === "disconnected" && (
          <div style={{ background: "#1A1A2E", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16, fontSize: 12 }}>
            <div style={{ color: S.red, fontWeight: 700, marginBottom: 8 }}>SETUP</div>
            <div style={{ color: S.dim, lineHeight: 1.8 }}>
              1. Download j2534_bridge.py above<br />
              2. Open a terminal on your laptop<br />
              3. Run: <span style={{ color: "#fff" }}>pip install websockets</span><br />
              4. Run: <span style={{ color: "#fff" }}>python j2534_bridge.py</span><br />
              5. Make sure OBDLink EX (or any J2534 adapter) is plugged in via USB<br />
              6. Click "Connect Bridge" below
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {status === "disconnected" && <Btn onClick={connectBridge} color={S.blue}>🔌 Connect Bridge</Btn>}
          {status === "bridge_connected" && <Btn onClick={openDevice} color={S.blue}>📡 Open J2534 Device</Btn>}
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
                  <span style={{ color: "#FFD600", fontWeight: 700 }}>{m.name}</span>
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
              Download j2534_bridge.py, run it, then click Connect Bridge
            </div>
          )}
        </div>

        {/* Devices */}
        {devices.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 10, color: S.dim }}>
            J2534 Devices: {devices.map((d) => d.name).join(", ")}
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
