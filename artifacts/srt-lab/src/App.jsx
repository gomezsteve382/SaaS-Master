import React, { useState, useCallback, useEffect } from "react";
import OBDSwarmDiagnostic from "./OBDSwarmDiagnostic";
import J2534Scanner from "./J2534Scanner";
import AutelSgwTab from "./tabs/AutelSgwTab.jsx";
import { vinHasSGW, parseVinYear, vinCheckDigitValid } from "./lib/vin.js";
import { useBridgeStatus } from "./lib/bridgeClient.js";
import JailbreakTab from "./tabs/JailbreakTab";
import BcmTab from "./tabs/BcmTab.jsx";
import RfhubTab from "./tabs/RfhubTab.jsx";
import RFHPCMTab from "./tabs/RFHPCMTab.jsx";
import BackupsTab from "./tabs/BackupsTab";
import SessionsTab from "./tabs/SessionsTab.jsx";
import EcmTab from "./tabs/EcmTab.jsx";
import AdcmTab from "./tabs/AdcmTab.jsx";
import ProgramAllTab from "./tabs/ProgramAllTab.jsx";
import UdsTab from "./tabs/UdsTab.jsx";
import FcaAnalyzerTab from "./tabs/FcaAnalyzerTab.jsx";
import OBDTab from "./tabs/OBDTab.jsx";
import BenchTab from "./tabs/BenchTab.jsx";
import DumpsTab from "./tabs/DumpsTab.jsx";
import SeedTab from "./tabs/SeedTab.jsx";
import GpecTab from "./tabs/GpecTab.jsx";
import Gpec2aTab from "./tabs/Gpec2aTab.jsx";
import { MasterVinProvider, useMasterVin } from "./lib/masterVinContext.jsx";
import { analyzeFile } from "./lib/fileUtils.js";
import { C } from "./lib/constants.js";
import { Card, Tag } from "./lib/ui.jsx";
import { subscribeToast } from "./lib/audit.js";

/* Tab list — order mirrors the production reference. */
const TABS = [
  { id: "program",   i: "🚀", l: "PROGRAM ALL",    s: "BCM→RFHUB→ECM→ADCM" },
  { id: "bcm",       i: "🧠", l: "BCM",            s: "VIN · CRC · Features" },
  { id: "rfhub",     i: "🔑", l: "RFHUB",          s: "VIN · Key Fobs" },
  { id: "ecm",       i: "⚡", l: "ECM",            s: "Engine · 10 Algorithms" },
  { id: "adcm",      i: "🏎️", l: "ACTIVE DAMPING", s: "VIN · Variant Config" },
  { id: "uds",       i: "🔬", l: "UDS PROGRAMMER", s: "Universal · Raw" },
  { id: "backups",   i: "💾", l: "BACKUPS",        s: "History · Restore" },
  { id: "sessions",  i: "📜", l: "SESSIONS",       s: "Audit · Paper Trail" },
  { id: "jailbreak", i: "💀", l: "JAILBREAK",      s: "SRT · Demon · Hellcat · Redeye" },
  { id: "dumps",     i: "📂", l: "DUMPS",          s: "VIN · Hex · Virginize" },
  { id: "obd",       i: "📡", l: "LIVE OBD",       s: "UDS · Scan · Write" },
  { id: "bench",     i: "🔧", l: "BENCH",          s: "Offline · Dumps" },
  { id: "seed",      i: "🔑", l: "SEED→KEY",       s: "14 Algorithms" },
  { id: "gpec",      i: "🔓", l: "GPEC",           s: "FW Unlock" },
  { id: "gpec2a",    i: "⚙️", l: "GPEC2A",         s: "SKIM · Tamper" },
  { id: "analyzer",  i: "🧪", l: "FCA ANALYZER",   s: "GPEC · RFHUB · BCM · Cross-audit" },
  { id: "rfhpcm",    i: "🧬", l: "RFH → PCM",      s: "SEC6 Pairing" },
  { id: "swarm",     i: "🌐", l: "SWARM",          s: "CAN Bus Scan" },
  { id: "j2534",     i: "⚡", l: "J2534",          s: "Raw CAN PassThru" },
  { id: "autel",     i: "🔐", l: "AUTEL SGW",      s: "Secure Gateway · Bridge" },
];

/* Placeholder body shown for tabs delivered in later migration chunks.
   Reads MasterVinContext so the shared state is exercised app-wide today. */
function PlaceholderTab({ tab }) {
  const { vin, vinValid, moduleStatus } = useMasterVin();
  return <Card glow>
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
      <span style={{ fontSize: 32 }}>{tab.i}</span>
      <div>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>{tab.l}</div>
        <div style={{ fontSize: 11, color: C.ts, fontWeight: 700, letterSpacing: 1.5 }}>{tab.s}</div>
      </div>
      <Tag color={C.wn}>COMING IN NEXT CHUNK</Tag>
    </div>
    <div style={{ fontSize: 12, color: C.ts, lineHeight: 1.6, marginTop: 14 }}>
      This tab will be implemented in an upcoming migration step.
    </div>
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: C.c2, border: "1px solid " + C.bd, fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
      <div><span style={{ color: C.tm }}>masterVin:</span> <b style={{ color: vinValid ? C.gn : C.tm }}>{vin || "(not set)"}</b> {vinValid && <Tag color={C.gn}>VALID</Tag>}</div>
      <div style={{ marginTop: 6 }}>
        <span style={{ color: C.tm }}>moduleStatus:</span>{" "}
        {Object.entries(moduleStatus).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}>{k}=<b>{v}</b></span>)}
      </div>
    </div>
  </Card>;
}

/* Header chip — flags whether the loaded VIN needs FCA Secure-Gateway
   (2018+) and whether the local J2534 bridge daemon is reachable. */
function SgwBridgeChip({ vin, setPg }) {
  const needs = vinHasSGW(vin);
  const { connected } = useBridgeStatus(needs ? 6000 : 0);
  if (!needs) return null;
  const ok = connected;
  const col = ok ? "#00E676" : "#FFB300";
  const label = ok ? "🔐 SGW · BRIDGE LIVE" : "🔐 SGW REQ · BRIDGE OFFLINE";
  return <button data-testid="sgw-req-chip" onClick={() => setPg && setPg("autel")}
    title={ok ? "Autel J2534 bridge connected — SGW writes will route through the cable." : "Start j2534_bridge.py on this machine to authenticate SGW writes."}
    style={{ marginLeft: "auto", padding: "3px 9px", borderRadius: 6, background: col + "22", color: col, border: "1px solid " + col + "77", fontSize: 10, fontWeight: 800, letterSpacing: 1, cursor: "pointer", fontFamily: "'JetBrains Mono'" }}>
    {label}
  </button>;
}

function MasterVinBar() {
  const { vin, setVin, moduleStatus, loadedDumps, clearDumps, setPg } = useMasterVin();
  const ok = vin.length === 17;
  const statusColor = { pending: "#9E9E9E", writing: "#FFB300", ok: "#00C853", fail: "#FF1744" };
  const statusGlyph = { pending: "○", writing: "⋯", ok: "●", fail: "✗" };
  const dumpCounts = loadedDumps.reduce((a, d) => { a[d.type] = (a[d.type] || 0) + 1; return a; }, {});
  return <div style={{ maxWidth: 1100, margin: "14px auto 0", padding: "0 22px" }}>
    <div style={{ background: C.cd, borderRadius: 14, border: "1.5px solid " + C.bd, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
      <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: 2, color: C.sr }}>MASTER VIN</div>
      <input value={vin} maxLength={17} placeholder="Enter 17-character VIN to drive BCM/RFHUB writes"
        onChange={e => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ""))}
        style={{ flex: 1, minWidth: 280, padding: "9px 12px", borderRadius: 8, border: "2px solid " + (ok ? C.gn : C.bd), background: C.c2, color: C.tx, fontFamily: "'JetBrains Mono'", fontSize: 14, fontWeight: 700, letterSpacing: 2, outline: "none" }} />
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 800, color: ok ? C.gn : C.tm }}>{vin.length}/17</span>
      <div style={{ display: "flex", gap: 6 }}>
        {["BCM", "RFHUB", "ECM", "ADCM"].map(m => {
          const st = moduleStatus[m] || "pending";
          return <div key={m} title={m + ": " + st} style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: .6, background: statusColor[st] + "18", color: statusColor[st], border: "1px solid " + statusColor[st] + "55" }}>
            {statusGlyph[st]} {m}
          </div>;
        })}
      </div>
    </div>
    {loadedDumps.length > 0 && <div style={{ background: C.cd, borderRadius: 10, border: "1px dashed " + C.bd, padding: "7px 14px", marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11 }}>
      <span style={{ fontWeight: 900, letterSpacing: 1.5, color: C.a3, fontSize: 10 }}>📂 LOADED DUMPS</span>
      <span style={{ color: C.tm, fontWeight: 700 }}>{loadedDumps.length} file{loadedDumps.length === 1 ? "" : "s"} in workspace —</span>
      {Object.entries(dumpCounts).map(([type, n]) => <span key={type} title={"Open in FCA Analyzer"} onClick={() => setPg && setPg("analyzer")} style={{ padding: "2px 8px", borderRadius: 6, background: C.c2, border: "1px solid " + C.bd, fontFamily: "'JetBrains Mono'", fontWeight: 800, color: C.a2, cursor: "pointer" }}>
        {type} ×{n}
      </span>)}
      <button onClick={clearDumps} style={{ marginLeft: "auto", border: "none", background: "transparent", color: C.tm, cursor: "pointer", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>CLEAR</button>
    </div>}
  </div>;
}

export default function App() {
  const [pg, setPg] = useState("program");
  const [files, setFiles] = useState([]);
  const loadF = useCallback(fl => {
    Promise.all(Array.from(fl).map(f => new Promise(r => {
      const rd = new FileReader();
      rd.onload = e => r(analyzeFile(e.target.result, f.name));
      rd.readAsArrayBuffer(f);
    }))).then(res => setFiles(p => [...p, ...res.filter(f => f.type !== "unknown")]));
  }, []);
  return <MasterVinProvider setPg={setPg}>
    <AppShell pg={pg} setPg={setPg} files={files} setFiles={setFiles} loadF={loadF} />
  </MasterVinProvider>;
}

function AppShell({ pg, setPg, files, setFiles, loadF }) {
  const { vin, setVin, vinValid, moduleStatus } = useMasterVin();
  const tab = TABS.find(t => t.id === pg);

  /* Module History panels deep-link to the backups tab via this event. */
  useEffect(() => {
    const onNav = (e) => {
      const t = e?.detail?.tab;
      if (t === "backups" || t === "sessions") setPg(t);
    };
    window.addEventListener("srtlab:navigate", onNav);
    return () => window.removeEventListener("srtlab:navigate", onNav);
  }, [setPg]);

  return <div style={{ minHeight: "100vh", background: C.bg, color: C.tx, fontFamily: "'Nunito',sans-serif" }}>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&family=Righteous&display=swap" rel="stylesheet" />
    <div style={{ background: "linear-gradient(135deg,#1A1A1A 0%,#2D2D2D 40%,#D32F2F 100%)", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 80% 50%,rgba(255,82,82,0.3),transparent 60%)", pointerEvents: "none" }} />
      <div style={{ position: "relative", padding: "22px 28px 0", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: "linear-gradient(135deg,#FF5252,#D32F2F)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 20px rgba(211,47,47,0.4)" }}><span style={{ fontFamily: "'Righteous'", fontSize: 22, color: "#fff" }}>S</span></div>
        <div><div style={{ fontFamily: "'Righteous'", fontSize: 26, color: "#fff", letterSpacing: 2 }}>SRT LAB</div><div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", fontWeight: 700, letterSpacing: 6 }}>JAILBREAK EDITION</div></div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "rgba(0,0,0,0.3)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.15)" }}>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", fontWeight: 800, letterSpacing: 2 }}>MASTER VIN</div>
          <input
            data-testid="master-vin-input"
            value={vin}
            onChange={e => setVin(e.target.value)}
            maxLength={17}
            placeholder="17 characters"
            style={{ width: 200, padding: "6px 10px", border: "1.5px solid " + (vin.length === 0 ? "rgba(255,255,255,0.2)" : vinValid ? "#00E676" : "#FF5252"), borderRadius: 6, fontSize: 13, fontFamily: "'JetBrains Mono'", fontWeight: 700, letterSpacing: 1.5, background: "rgba(0,0,0,0.4)", color: "#fff", outline: "none" }}
          />
          <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", fontWeight: 700, color: vinValid ? "#00E676" : vin.length === 0 ? "rgba(255,255,255,0.4)" : "#FF5252" }}>{vin.length}/17</div>
        </div>
      </div>
      {vinValid && <div data-testid="module-status-strip" style={{ padding: "8px 28px", background: "rgba(0,0,0,0.25)", display: "flex", gap: 14, alignItems: "center", fontSize: 10, fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>
        <span style={{ color: "rgba(255,255,255,0.4)", letterSpacing: 2 }}>BENCH STATUS:</span>
        {["BCM", "RFHUB", "ECM", "ADCM"].map(m => {
          const st = moduleStatus[m];
          const col = { pending: "#999", writing: "#FFB300", ok: "#00E676", fail: "#FF5252" }[st] || "#999";
          const icon = { pending: "○", writing: "⏳", ok: "✓", fail: "✗" }[st] || "○";
          return <span key={m} data-testid={"status-" + m} style={{ color: col, display: "flex", alignItems: "center", gap: 4 }}>{icon} {m}</span>;
        })}
        {(() => { const y = parseVinYear(vin); if (!y) return null; return <span data-testid="vin-year-chip" title={"Model year decoded from VIN position 10 (" + vin[9] + ")"} style={{ color: "#9FB4FF", display: "flex", alignItems: "center", gap: 4 }}>YEAR:{y}</span>; })()}
        {(() => { const ok = vinCheckDigitValid(vin); const col = ok ? "#00E676" : "#FFB300"; const icon = ok ? "✓" : "⚠"; const lbl = ok ? "VIN CHKSUM" : "VIN CHKSUM BAD"; return <span data-testid="vin-checksum-chip" title={ok ? "ISO 3779 check digit (position 9) matches" : "ISO 3779 check digit mismatch — typo in VIN?"} style={{ color: col, display: "flex", alignItems: "center", gap: 4 }}>{icon} {lbl}</span>; })()}
        <SgwBridgeChip vin={vin} setPg={setPg} />
      </div>}
      <div style={{ display: "flex", padding: "12px 16px 0", overflowX: "auto", gap: 2 }}>
        {TABS.map(t => { const a = pg === t.id; return <button key={t.id} data-testid={"tab-" + t.id} onClick={() => setPg(t.id)} style={{ padding: "11px 16px 13px", border: "none", cursor: "pointer", background: a ? C.bg : "transparent", borderRadius: "11px 11px 0 0", color: a ? C.sr : "rgba(255,255,255,0.4)", fontFamily: "'Nunito'", fontWeight: a ? 900 : 700, fontSize: 11, letterSpacing: 1.2, transition: "all 0.25s", boxShadow: a ? "0 -4px 16px rgba(0,0,0,0.06)" : "none", whiteSpace: "nowrap" }}><span style={{ fontSize: 14, marginRight: 4, filter: a ? "none" : "grayscale(1) brightness(2)" }}>{t.i}</span>{t.l}{t.placeholder && <span style={{ marginLeft: 4, fontSize: 8, opacity: .7 }}>·SOON</span>}<div style={{ fontSize: 7, marginTop: 1, opacity: .4 }}>{t.s}</div></button>; })}
      </div>
    </div>
    <MasterVinBar />
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "22px 22px 60px" }}>
      {tab?.placeholder && <PlaceholderTab tab={tab} />}
      {pg === "dumps"     && <DumpsTab files={files} setFiles={setFiles} loadF={loadF} />}
      {pg === "obd"       && <OBDTab />}
      {pg === "bench"     && <BenchTab />}
      {pg === "bcm"       && <BcmTab />}
      {pg === "rfhub"     && <RfhubTab />}
      {pg === "seed"      && <SeedTab />}
      {pg === "gpec"      && <GpecTab />}
      {pg === "gpec2a"    && <Gpec2aTab />}
      {pg === "ecm"       && <EcmTab />}
      {pg === "adcm"      && <AdcmTab />}
      {pg === "analyzer"  && <FcaAnalyzerTab />}
      {pg === "rfhpcm"    && <RFHPCMTab />}
      {pg === "swarm"     && <OBDSwarmDiagnostic />}
      {pg === "j2534"     && <J2534Scanner />}
      {pg === "autel"     && <AutelSgwTab />}
      {pg === "jailbreak" && <JailbreakTab />}
      {pg === "backups"   && <BackupsTab />}
      {pg === "sessions"  && <SessionsTab />}
      {pg === "program"   && <ProgramAllTab />}
      {pg === "uds"       && <UdsTab />}
    </div>
    <GlobalToastBar />
  </div>;
}

/* Global, fixed-position banner that surfaces toasts dispatched anywhere in
 * the app (e.g. backup save failures triggered while writing a module from a
 * different tab). Critical for the audit story — a silent QuotaExceededError
 * means lost history, so the user must always see when one occurs. */
function GlobalToastBar() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    return subscribeToast(detail => {
      setToasts(p => [...p, detail]);
      setTimeout(() => {
        setToasts(p => p.filter(t => t.ts !== detail.ts));
      }, detail.durationMs || 6000);
    });
  }, []);
  if (toasts.length === 0) return null;
  return <div data-testid="global-toast-bar" style={{ position: "fixed", top: 18, right: 18, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
    {toasts.map(t => {
      const col = t.type === "error" ? "#FF5252" : t.type === "warn" ? "#FFB300" : "#00E676";
      const bg = t.type === "error" ? "#FFEBEE" : t.type === "warn" ? "#FFF8E1" : "#E8F5E9";
      const ico = t.type === "error" ? "✗" : t.type === "warn" ? "⚠" : "✓";
      return <div key={t.ts} data-testid={"toast-" + t.type} style={{ background: bg, border: "1.5px solid " + col, borderRadius: 10, padding: "12px 14px", boxShadow: "0 6px 24px rgba(0,0,0,0.18)", display: "flex", alignItems: "flex-start", gap: 10, fontFamily: "'Nunito',sans-serif" }}>
        <div style={{ fontSize: 18, color: col, fontWeight: 900, lineHeight: 1 }}>{ico}</div>
        <div style={{ flex: 1, fontSize: 12, color: "#333", lineHeight: 1.45 }}>{t.message}</div>
        <button onClick={() => setToasts(p => p.filter(x => x.ts !== t.ts))} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#888", padding: 0, lineHeight: 1 }}>×</button>
      </div>;
    })}
  </div>;
}
