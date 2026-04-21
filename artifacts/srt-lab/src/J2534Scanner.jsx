import { useState, useCallback, useRef, useEffect } from "react";
import { ASSET_IDS } from "./lib/downloadAssets.js";
import { useDownloadCount } from "./lib/useDownloadCount.jsx";
import { buildOnePagerPDF } from "./lib/buildOnePagerPDF.js";
import { J2534_REF } from "./lib/tabReferences.js";

/**
 * J2534 Module Scanner — HTTP version
 *
 * Connects to j2534_bridge.py via HTTP on http://localhost:8765
 *
 * Critical fix vs. older versions: installs a flow-control filter for EACH
 * module's tx/rx pair BEFORE probing. Without that, the Autel DLL drops
 * every incoming CAN frame before reaching the read buffer, and the scan
 * returns 0 modules even when modules are live on the bus.
 *
 * Setup:
 *   1. Run the patched j2534_bridge.py with --dll pointing at your vendor DLL
 *   2. Open this in Chrome
 *   3. Click Connect Bridge → Open Device → Scan All Modules
 */

const BRIDGE_URL = "http://localhost:8765";
const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;

// All known FCA module addresses (tx/rx decimal pairs)
const FCA_MODULES = [
  { name: "ECM",        tx: 0x7E0, rx: 0x7E8 },
  { name: "TCM",        tx: 0x7E1, rx: 0x7E9 },
  { name: "DTCM",       tx: 0x7E2, rx: 0x7EA },
  { name: "BPCM",       tx: 0x7E4, rx: 0x7EC },
  { name: "BCM",        tx: 0x750, rx: 0x758 },
  { name: "RFHUB",      tx: 0x75F, rx: 0x767 },
  { name: "ABS",        tx: 0x760, rx: 0x768 },
  { name: "IPC",        tx: 0x740, rx: 0x748 },
  { name: "ORC",        tx: 0x758, rx: 0x760 },
  { name: "ADCM",       tx: 0x7A8, rx: 0x7B0 },
  { name: "AMP",        tx: 0x7A0, rx: 0x7A8 },
  { name: "BSM",        tx: 0x770, rx: 0x778 },
  { name: "EPS",        tx: 0x761, rx: 0x769 },
  { name: "RADIO",      tx: 0x772, rx: 0x77A },
  { name: "HVAC",       tx: 0x751, rx: 0x759 },
  { name: "TPMS",       tx: 0x752, rx: 0x75A },
  { name: "SCCM",       tx: 0x74D, rx: 0x76D },
  { name: "TIPM",       tx: 0x74C, rx: 0x76C },
  { name: "SKREEM",     tx: 0x75A, rx: 0x77A },
  { name: "BSM_RDR",    tx: 0x771, rx: 0x779 },
  { name: "TPMS_SENS",  tx: 0x718, rx: 0x720 },
  { name: "OCS_SENS",   tx: 0x728, rx: 0x730 },
  { name: "ECM_W7",     tx: 0x7E5, rx: 0x7ED },
  { name: "TCM_W7",     tx: 0x7E6, rx: 0x7EE },
  { name: "BCM_W7",     tx: 0x7B2, rx: 0x7BA },
  { name: "BCM_DVIN",   tx: 0x6B0, rx: 0x6B8 },
  { name: "CCM",        tx: 0x743, rx: 0x763 },
  { name: "ADM",        tx: 0x744, rx: 0x764 },
  { name: "IPCM",       tx: 0x746, rx: 0x766 },
  { name: "DDM",        tx: 0x748, rx: 0x768 },
  { name: "PDM",        tx: 0x749, rx: 0x769 },
  { name: "EPS_ALT",    tx: 0x74A, rx: 0x76A },
  { name: "SCCM_ALT",   tx: 0x74B, rx: 0x76B },
  { name: "TPMS_ALT",   tx: 0x74E, rx: 0x76E },
  { name: "BCM_ALT",    tx: 0x742, rx: 0x762 },
  { name: "IPC_ALT",    tx: 0x745, rx: 0x765 },
  { name: "RADIO_ALT",  tx: 0x754, rx: 0x75C },
  { name: "RADIO_753",  tx: 0x753, rx: 0x773 },
  { name: "BCM_SWARM",  tx: 0x7B0, rx: 0x7B8 },
  { name: "IPC_SWARM",  tx: 0x720, rx: 0x728 },
  { name: "RFHUB_SWARM",tx: 0x762, rx: 0x76A },
  { name: "RADIO_SWARM",tx: 0x7D0, rx: 0x7D8 },
  { name: "ORC_SWARM",  tx: 0x730, rx: 0x738 },
  { name: "REAR_AXLE",  tx: 0x6C0, rx: 0x6C8 },
  { name: "ACC",        tx: 0x700, rx: 0x708 },
  { name: "BCM_PNET",   tx: 0x620, rx: 0x628 },
  { name: "SKIM_PNET",  tx: 0x741, rx: 0x749 },
  { name: "RADIO_PNET", tx: 0x7C8, rx: 0x7D0 },
  { name: "HVAC_PNET",  tx: 0x688, rx: 0x690 },
];

const bridgeCall = async (path, body) => {
  const init = body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" };
  const res = await fetch(BRIDGE_URL + path, init);
  if (!res.ok) {
    let err = `HTTP ${res.status}`;
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(err);
  }
  return await res.json();
};

const hexify = (bytes) =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");

const parseMsgData = (msgData) => {
  // msg.data is hex without 0x, may be empty
  if (!msgData || typeof msgData !== "string") return null;
  if (msgData.length < 2) return null;
  const out = [];
  for (let i = 0; i < msgData.length; i += 2) {
    out.push(parseInt(msgData.substr(i, 2), 16));
  }
  return out;
};

export default function J2534Scanner() {
  const [status, setStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);
  const [found, setFound] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [bridgeInfo, setBridgeInfo] = useState(null);
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

  // Probe the bridge and learn what it's pointing at
  const connectBridge = useCallback(async () => {
    log("Probing local J2534 bridge at " + BRIDGE_URL + " ...");
    try {
      const st = await bridgeCall("/status");
      setBridgeInfo(st);
      log(`Bridge OK — vendor=${st.vendor} platform=${st.platform} bridge=${st.bridgeVersion}`, "success");
      if (st.dllPath) log(`DLL: ${st.dllPath}`);
      if (!st.dllLoaded) {
        log("Bridge has no DLL loaded — restart it with --dll <vendor J2534 DLL>", "warn");
        setStatus("bridge_connected");
        return;
      }
      if (st.deviceOpen && st.channelConnected) {
        log("Bridge already has device open + ISO15765 channel up — ready to scan.", "success");
        setStatus("can_connected");
      } else if (st.deviceOpen) {
        log("Bridge has device open — click Open J2534 Device to bring up the CAN channel.");
        setStatus("device_open");
      } else {
        setStatus("bridge_connected");
      }
    } catch (e) {
      log("Cannot reach bridge: " + e.message, "error");
      log("Make sure j2534_bridge.py is running on port 8765.", "error");
      setStatus("disconnected");
    }
  }, [log]);

  const openDevice = useCallback(async () => {
    try {
      log("Opening J2534 device (PassThruOpen) ...");
      const opened = await bridgeCall("/open", {});
      log(`Device opened — id=${opened.deviceId || "?"}` +
          (opened.versions?.firmware ? ` fw ${opened.versions.firmware}` : ""), "success");
      setStatus("device_open");
      log("Connecting CAN channel (ISO15765 / 500 kbps) ...");
      await bridgeCall("/connect", { protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 });
      log("CAN bus up — ISO15765 500 kbps", "success");
      setStatus("can_connected");
    } catch (e) {
      log("Open/Connect failed: " + e.message, "error");
    }
  }, [log]);

  const probeOne = useCallback(async (mod) => {
    const txHex = mod.tx.toString(16).toUpperCase().padStart(3, "0");
    const rxHex = mod.rx.toString(16).toUpperCase().padStart(3, "0");
    log(`→ probe ${mod.name} TX:0x${txHex} RX:0x${rxHex}`);

    // 1) install filter (ignore ERR_NOT_UNIQUE — filter already there from a previous probe)
    try {
      await bridgeCall("/setfilter", { txId: mod.tx, rxId: mod.rx });
    } catch (e) {
      if (!/not[_ ]unique/i.test(e.message)) {
        log(`  filter failed: ${e.message}`, "warn");
        return null;
      }
    }

    // 2) drain stale frames
    try { await bridgeCall("/readmsg", { timeoutMs: 100 }); } catch {}

    // 3) send 10 03 extended session to wake the module
    try {
      await bridgeCall("/sendmsg", { txId: mod.tx, data: "1003", flags: ISO15765_FRAME_PAD, timeoutMs: 1000 });
    } catch (e) {
      log(`  10 03 failed: ${e.message}`, "warn");
    }

    // 4) give it a beat to answer, then drain session reply
    await new Promise((r) => setTimeout(r, 150));
    let sessResp = null;
    try { sessResp = await bridgeCall("/readmsg", { timeoutMs: 800 }); } catch {}

    // 5) send 22 F1 90 (Read VIN)
    try {
      await bridgeCall("/sendmsg", { txId: mod.tx, data: "22F190", flags: ISO15765_FRAME_PAD, timeoutMs: 1500 });
    } catch (e) {
      log(`  22 F1 90 failed: ${e.message}`, "warn");
      return null;
    }

    // 6) read VIN reply
    await new Promise((r) => setTimeout(r, 150));
    let resp = null;
    try { resp = await bridgeCall("/readmsg", { timeoutMs: 1500 }); } catch {}

    if (!resp || !resp.msg) {
      // No reply at all — module silent on this address
      return null;
    }
    const msg = resp.msg;
    const data = parseMsgData(msg.data);
    // A TX echo comes back with rxStatus bit 0x01 set and empty data — skip it
    if ((msg.rxStatus & 0x01) || !data || data.length === 0) {
      // Sometimes the first reply is the TX echo. Try one more read.
      try {
        const r2 = await bridgeCall("/readmsg", { timeoutMs: 1500 });
        if (r2?.msg && !(r2.msg.rxStatus & 0x01)) {
          return interpretReply(mod, r2.msg);
        }
      } catch {}
      return null;
    }
    return interpretReply(mod, msg);
  }, [log]);

  const interpretReply = (mod, msg) => {
    const data = parseMsgData(msg.data);
    if (!data) return null;
    // Positive response to 22 F1 90 = 62 F1 90 <17 ascii VIN bytes>
    if (data.length >= 3 && data[0] === 0x62 && data[1] === 0xF1 && data[2] === 0x90) {
      const vinBytes = data.slice(3, 20);
      const vin = String.fromCharCode(...vinBytes.filter((b) => b >= 0x20 && b <= 0x7E));
      return { ...mod, vin, kind: "positive", canId: msg.canId };
    }
    // Negative response: 7F 22 <NRC>
    if (data.length >= 3 && data[0] === 0x7F) {
      const nrc = data[2];
      return { ...mod, nrc, kind: "nrc", canId: msg.canId };
    }
    return { ...mod, raw: msg.data, kind: "unknown", canId: msg.canId };
  };

  const scanAll = useCallback(async () => {
    setScanning(true);
    setFound([]);
    log("═══ Starting J2534 full module scan ═══", "header");
    log("Scanning known FCA module addresses via raw CAN ...");
    const discovered = [];
    for (const mod of FCA_MODULES) {
      try {
        const hit = await probeOne(mod);
        if (hit) {
          discovered.push(hit);
          setFound([...discovered]);
          const txHex = mod.tx.toString(16).toUpperCase().padStart(3, "0");
          const rxHex = mod.rx.toString(16).toUpperCase().padStart(3, "0");
          if (hit.kind === "positive") {
            log(`✓ ${mod.name} TX:0x${txHex} RX:0x${rxHex} VIN:${hit.vin || "?"}`, "success");
          } else if (hit.kind === "nrc") {
            log(`✓ ${mod.name} TX:0x${txHex} RX:0x${rxHex} (present — NRC 0x${hit.nrc.toString(16).padStart(2,"0")})`, "success");
          } else {
            log(`✓ ${mod.name} TX:0x${txHex} RX:0x${rxHex} (present — unknown reply ${hit.raw || ""})`, "success");
          }
        }
      } catch (e) {
        log(`${mod.name} error: ${e.message}`, "error");
      }
    }
    log(`═══ Scan complete: ${discovered.length} modules found out of ${FCA_MODULES.length} probed ═══`, "header");
    try {
      localStorage.setItem("srtlab_j2534_lastscan", JSON.stringify({
        scannedAt: new Date().toISOString(),
        modules: discovered,
      }));
      log("Scan saved to localStorage (srtlab_j2534_lastscan).");
    } catch {}
    setScanning(false);
  }, [log, probeOne]);

  const readVinOne = useCallback(async (mod) => {
    log(`Reading VIN from ${mod.name} ...`);
    try {
      const hit = await probeOne(mod);
      if (hit?.vin) log(`${mod.name} VIN: ${hit.vin}`, "success");
      else if (hit?.kind === "nrc") log(`${mod.name} NRC 0x${hit.nrc.toString(16).padStart(2,"0")}`, "warn");
      else log(`${mod.name} no reply`, "warn");
    } catch (e) {
      log(`${mod.name} error: ${e.message}`, "error");
    }
  }, [log, probeOne]);

  const S = {
    bg: "#0A0A0F",
    card: "#12121A",
    border: "#1E1E2E",
    text: "#E0E0E0",
    dim: "#666",
    red: "#DC143C",
    green: "#00C853",
    blue: "#2196F3",
    font: '"Nunito", sans-serif',
    mono: '"JetBrains Mono", monospace',
  };

  const Btn = ({ children, onClick, disabled, color = S.blue }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 18px",
        background: disabled ? "#333" : color,
        color: disabled ? "#888" : "#fff",
        border: "none",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: S.font,
        fontWeight: 700,
        fontSize: 13,
        opacity: disabled ? 0.5 : 1,
        marginRight: 8,
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

        <div style={{ background: "#0D1A0D", border: "1px solid #2E7D32", borderRadius: 8, padding: 14, marginBottom: 14, fontSize: 12 }}>
          <div style={{ color: "#66BB6A", fontWeight: 700, marginBottom: 6 }}>STEP 0 — START LOCAL BRIDGE</div>
          <div style={{ color: S.dim, lineHeight: 1.8 }}>
            The patched j2534_bridge.py runs locally and exposes your MaxiFlash/Mongoose/etc. to this browser via HTTP on port 8765.
            Run it with <span style={{ color: "#fff" }}>python j2534_bridge.py --dll "&lt;path to vendor J2534 DLL&gt;"</span>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <Btn onClick={connectBridge} color={S.blue}>🔗 Connect Bridge</Btn>
          {(status === "bridge_connected" || status === "device_open") && (
            <Btn onClick={openDevice} color={S.blue}>📡 Open J2534 Device</Btn>
          )}
          {status === "can_connected" && (
            <>
              <Btn onClick={scanAll} disabled={scanning} color={S.red}>
                {scanning ? "⏳ Scanning..." : "🚀 SCAN ALL MODULES"}
              </Btn>
              <Btn onClick={() => readVinOne({ name: "ECM", tx: 0x7E0, rx: 0x7E8 })} disabled={scanning} color={S.green}>
                Read ECM VIN
              </Btn>
              <Btn onClick={() => readVinOne({ name: "BCM", tx: 0x750, rx: 0x758 })} disabled={scanning} color={S.green}>
                Read BCM VIN
              </Btn>
              <Btn onClick={() => readVinOne({ name: "BCM_742", tx: 0x742, rx: 0x762 })} disabled={scanning} color={S.green}>
                Read BCM 0x742
              </Btn>
            </>
          )}
        </div>

        {found.length > 0 && (
          <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ color: S.green, fontWeight: 700, marginBottom: 8 }}>MODULES FOUND: {found.length}</div>
            <table style={{ width: "100%", fontFamily: S.mono, fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: S.dim, textAlign: "left" }}>
                  <th style={{ padding: 6 }}>Name</th><th>TX</th><th>RX</th><th>Reply</th><th>VIN / NRC</th>
                </tr>
              </thead>
              <tbody>
                {found.map((m, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${S.border}` }}>
                    <td style={{ padding: 6 }}>{m.name}</td>
                    <td>0x{m.tx.toString(16).toUpperCase().padStart(3,"0")}</td>
                    <td>0x{m.rx.toString(16).toUpperCase().padStart(3,"0")}</td>
                    <td>{m.kind}</td>
                    <td>{m.vin ? m.vin : m.nrc != null ? `NRC 0x${m.nrc.toString(16).padStart(2,"0")}` : (m.raw || "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div
          ref={logRef}
          style={{
            background: "#000",
            border: `1px solid ${S.border}`,
            borderRadius: 8,
            padding: 12,
            fontFamily: S.mono,
            fontSize: 11,
            height: 320,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {logs.map((l, i) => (
            <div key={i} style={{
              color: l.type === "success" ? S.green :
                     l.type === "error" ? S.red :
                     l.type === "warn" ? "#FFC107" :
                     l.type === "header" ? S.blue :
                     l.type === "rx" ? "#80CBC4" :
                     l.type === "tx" ? "#B39DDB" :
                     S.text,
            }}>
              <span style={{ color: S.dim }}>{l.ts}</span> {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
