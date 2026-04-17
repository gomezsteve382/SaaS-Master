/* FCA Module Security Analyzer — ported from
   attached_assets/fca_module_analyzer_1776013402484.jsx.

   Uses the canonical parseModule + crossValidate + computeDiff helpers
   from src/lib/ (which carry the post-port BCM offsets 0x5320/0x40/0x60/0x80
   and Gen2 RFHUB CRC handling) instead of the snapshot's older copies. */
import React, { useState, useCallback, useMemo, useRef } from "react";
import { parseModule, extractVIN } from "../lib/parseModule.js";
import { crossValidate, computeDiff } from "../lib/crossValidate.js";

const C = {
  bg: "#06080c", surface: "#0e1117", surface2: "#161b24",
  border: "#1e2530", text: "#cdd4e0", dim: "#5a6478",
  red: "#ff3b3b", green: "#00d4aa", blue: "#4d8aff", warn: "#f5a623",
  key: "#ff6b9d", crypto: "#b07cff", orange: "#ff6b35",
};

const fO = n => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const selSt = { background: C.surface2, color: C.text, border: "1px solid " + C.border, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontFamily: "inherit" };
const inpSt = { background: C.bg, color: C.text, border: "1px solid " + C.border, borderRadius: 6, padding: "8px 12px", fontSize: 13, fontFamily: "inherit", letterSpacing: 1 };

function STag({ bg, children }) { return <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 3, fontSize: 10, fontWeight: 700, background: bg + "22", color: bg, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</span>; }
function STh({ children }) { return <th style={{ textAlign: "left", color: C.dim, fontWeight: 600, padding: "6px 10px", borderBottom: "1px solid " + C.border, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</th>; }
function STd({ c, bold, children }) { return <td style={{ padding: "5px 10px", color: c, fontWeight: bold ? 700 : 400, fontSize: 12 }}>{children}</td>; }
function SLine({ type, msg }) { const col = { error: C.red, warn: C.warn, pass: C.green }; const ico = { error: "✗", warn: "⚠", pass: "✓" }; return <div style={{ fontSize: 12, color: col[type], padding: "4px 0", display: "flex", gap: 8 }}><span style={{ fontWeight: 700, minWidth: 14 }}>{ico[type]}</span><span>{msg}</span></div>; }
function STitle({ children, color }) { return <div style={{ fontFamily: "'Chakra Petch',sans-serif", fontSize: 16, fontWeight: 700, color: color || "#fff", margin: "24px 0 12px", display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: C.red }}>▶</span>{children}</div>; }
function TCard({ title, desc, color, children }) { return <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16, borderTop: "2px solid " + color }}><div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{title}</div><div style={{ fontSize: 11, color: C.dim, marginBottom: 12 }}>{desc}</div>{children}</div>; }
function TBtn({ children, onClick, disabled, warn }) { return <button onClick={onClick} disabled={disabled} style={{ background: disabled ? C.surface2 : warn ? "linear-gradient(135deg," + C.warn + ",#d48800)" : "linear-gradient(135deg," + C.blue + ",#3a6fd8)", color: disabled ? C.dim : "#fff", border: "none", padding: "8px 16px", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit", width: "100%", opacity: disabled ? 0.5 : 1 }}>{children}</button>; }

const TABS = ["overview", "security", "diff", "tools"];

/* Tool helpers: byte-level patches that produce a downloadable .bin. */
function writeVIN(data, type, vin, existingVins) {
  if (vin.length !== 17) return null;
  const out = new Uint8Array(data);
  const vb = new TextEncoder().encode(vin);
  let offs;
  if (type === "GPEC2A") offs = [0x0000, 0x01f0, 0x0224];
  else if (type === "BCM") offs = [0x5320, 0x5340, 0x5360, 0x5380];
  else if (type === "RFHUB" && existingVins && existingVins.length) offs = existingVins.map(v => v.offset);
  else if (type === "RFHUB") offs = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
  else offs = [];
  offs.forEach(o => { for (let i = 0; i < 17; i++) out[o + i] = vb[i]; });
  if (type === "RFHUB") offs.forEach(o => { let s = 0; for (let i = 0; i < 17; i++) s = (s + out[o + i]) & 0xff; out[o + 17] = s; });
  return out;
}

function virginize(data) {
  const o = new Uint8Array(data);
  o[0x0011] = 0x00;
  for (let i = 0x0203; i < 0x020b; i++) o[i] = 0x00;
  for (let i = 0x0361; i < 0x0369; i++) o[i] = 0x00;
  for (let i = 0x0888; i < 0x0899; i++) o[i] = 0xff;
  for (let i = 0x0c8c; i < 0x0c94; i++) o[i] = 0x00;
  return o;
}

export default function FcaAnalyzerTab() {
  const [modules, setModules] = useState([]);
  const [tab, setTab] = useState("overview");
  const [dp, setDp] = useState([0, 1]);
  const [nv, setNv] = useState("");
  const [tt, setTt] = useState(0);
  const [tr, setTr] = useState(null);
  const fr = useRef();

  const onFiles = useCallback(e => {
    Array.from(e.target.files).forEach(f => {
      const r = new FileReader();
      r.onload = ev => { setModules(p => p.concat([parseModule(new Uint8Array(ev.target.result), f.name)])); };
      r.readAsArrayBuffer(f);
    });
    e.target.value = "";
  }, []);

  const rmMod = i => setModules(p => p.filter((_, j) => j !== i));
  const clr = () => { setModules([]); setTr(null); };
  const val = useMemo(() => modules.length > 0 ? crossValidate(modules) : null, [modules]);
  const diff = useMemo(() => {
    if (modules.length < 2) return null;
    const a = modules[dp[0]]?.data, b = modules[dp[1]]?.data;
    return a && b ? computeDiff(a, b) : null;
  }, [modules, dp]);

  const doTool = action => {
    const m = modules[tt]; if (!m) return; let res = null;
    if (action === "virginize" && m.type === "GPEC2A") res = { data: virginize(m.data), desc: "GPEC2A virginized: SKIM→0x00, keys cleared, ZZZZ zeroed." };
    else if (action === "writeVin" && nv.length === 17) { const d = writeVIN(m.data, m.type, nv, m.vins); if (d) res = { data: d, desc: "VIN updated to " + nv + " at " + (m.vins ? m.vins.length : 0) + " locations" }; }
    else if (action === "skimToggle" && m.type === "GPEC2A") { const d = new Uint8Array(m.data); d[0x0011] = m.skimByte === 0x80 ? 0x00 : 0x80; res = { data: d, desc: "SKIM: 0x" + m.skimByte.toString(16).toUpperCase() + " → 0x" + d[0x0011].toString(16).toUpperCase() }; }
    else if (action === "extractKey") { const k = m.secretKey ? m.secretKey.hex : m.vehicleSecret ? m.vehicleSecret.hex : ""; res = { keyHex: k, desc: "Extracted from " + m.type }; }
    setTr(res);
  };

  const dl = () => {
    if (!tr?.data) return;
    const b = new Blob([tr.data], { type: "application/octet-stream" });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u; a.download = "modified_" + (modules[tt]?.filename || "module.bin");
    a.click();
    URL.revokeObjectURL(u);
  };

  return (
    <div data-testid="fca-analyzer-tab" style={{ background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono','Fira Code',monospace", fontSize: 13, borderRadius: 12, overflow: "hidden", border: "1px solid " + C.border }}>
      <div style={{ background: "linear-gradient(135deg," + C.surface + ",#0a0e16)", borderBottom: "1px solid " + C.border, padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg," + C.red + "," + C.orange + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900, color: "#fff" }}>S</div>
          <div>
            <div style={{ fontFamily: "'Chakra Petch',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: -0.5 }}>FCA Module Security Analyzer</div>
            <div style={{ fontSize: 11, color: C.dim }}>THE SRT LAB · GPEC2A / RFHUB / BCM · Security Byte Engine</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, marginTop: 16 }}>
          {TABS.map(t => <button key={t} data-testid={"analyzer-subtab-" + t} onClick={() => setTab(t)} style={{ background: tab === t ? C.surface2 : "transparent", color: tab === t ? "#fff" : C.dim, border: "1px solid " + (tab === t ? C.border : "transparent"), borderBottom: tab === t ? "2px solid " + C.red : "2px solid transparent", padding: "8px 18px", borderRadius: "6px 6px 0 0", cursor: "pointer", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "inherit" }}>{t}</button>)}
        </div>
      </div>

      <div style={{ padding: "20px 24px" }}>
        <div data-testid="analyzer-dropzone" style={{ border: "2px dashed " + (modules.length ? C.border : C.dim), borderRadius: 10, padding: 20, textAlign: "center", marginBottom: 20, cursor: "pointer", background: C.surface }} onClick={() => fr.current?.click()}>
          <input ref={fr} type="file" multiple accept=".bin,.BIN" style={{ display: "none" }} onChange={onFiles} />
          <div style={{ fontSize: 14, color: C.dim, marginBottom: 4 }}>{modules.length === 0 ? "Drop .bin files here or click to load" : modules.length + " module(s) loaded"}</div>
          <div style={{ fontSize: 11, color: C.dim }}>GPEC2A EEPROM (4 KB) · RFHUB EEE (4 KB) · BCM DFLASH (64 KB) · 95640 (8/16 KB)</div>
        </div>

        {modules.length > 0 && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          {modules.map((m, i) => <div key={i} style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: "12px 16px", borderLeft: "3px solid " + m.color, flex: "1 1 280px", position: "relative", minWidth: 260 }}>
            <button onClick={() => rmMod(i)} style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 14 }}>×</button>
            <div style={{ fontSize: 14, fontWeight: 700, color: m.color, marginBottom: 4 }}>{m.name}</div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>{m.filename} · {m.size.toLocaleString()}B</div>
            {m.vins?.[0] && <div style={{ fontSize: 12, color: C.green }}>VIN: {m.vins[0].vin}</div>}
            {m.skimStatus && <div style={{ fontSize: 11, color: m.skimByte === 0x80 ? C.green : C.red }}>SKIM: {m.skimStatus}</div>}
            {m.vehicleSecret && <div style={{ fontSize: 11, color: C.crypto }}>Secret: {m.vehicleSecret.hex.slice(0, 23)}…</div>}
            {m.securityLock && <div style={{ fontSize: 11, color: m.securityLock.locked ? C.green : C.warn }}>{m.securityLock.locked ? "LOCKED" : "UNLOCKED"}</div>}
          </div>)}
          <button onClick={clr} style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 12, color: C.dim, cursor: "pointer", fontSize: 11, flex: "0 0 80px", display: "flex", alignItems: "center", justifyContent: "center" }}>Clear All</button>
        </div>}

        {tab === "overview" && val && <div data-testid="analyzer-overview">
          <STitle>Cross-Module Validation</STitle>
          <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16 }}>
            {val.issues.map((m, i) => <SLine key={"i" + i} type="error" msg={m} />)}
            {val.warnings.map((m, i) => <SLine key={"w" + i} type="warn" msg={m} />)}
            {val.passed.map((m, i) => <SLine key={"p" + i} type="pass" msg={m} />)}
          </div>
          {modules.map((m, i) => <div key={i} style={{ marginTop: 20 }}>
            <STitle color={m.color}>{m.name} — {m.filename}</STitle>
            <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr><STh>Offset</STh><STh>Category</STh><STh>Value</STh><STh>Detail</STh></tr></thead>
                <tbody>
                  {m.vins?.map((v, j) => <tr key={"v" + j}><STd c={C.blue}>{fO(v.offset)}</STd><STd><STag bg={C.green}>VIN {j + 1}</STag></STd><STd c={C.green} bold>{v.vin}</STd><STd c={C.dim}>17B ASCII</STd></tr>)}
                  {m.skimStatus && <tr><STd c={C.blue}>0x0011</STd><STd><STag bg={C.red}>SKIM</STag></STd><STd c={m.skimByte === 0x80 ? C.green : C.red} bold>0x{m.skimByte.toString(16).toUpperCase()} — {m.skimStatus}</STd><STd c={C.dim}>Immobilizer byte</STd></tr>}
                  {m.secretKey && <tr><STd c={C.blue}>{fO(m.secretKey.offset)}</STd><STd><STag bg={C.crypto}>SECRET</STag></STd><STd c={C.crypto} bold>{m.secretKey.hex}</STd><STd c={C.dim}>8B sync key {m.keyConsistent ? "✓" : "✗"}</STd></tr>}
                  {m.vehicleSecret && <tr><STd c={C.blue}>{fO(m.vehicleSecret.offset)}</STd><STd><STag bg={C.crypto}>SECRET</STag></STd><STd c={C.crypto} bold>{m.vehicleSecret.hex}</STd><STd c={C.dim}>{m.vehicleSecret.endian}-endian 16B</STd></tr>}
                  {m.transponderKeys?.map((tk, j) => <tr key={"t" + j}><STd c={C.blue}>{fO(tk.offset)}</STd><STd><STag bg={C.key}>FOBIK {j + 1}</STag></STd><STd c={C.key}>{tk.hex}</STd><STd c={C.dim}>Transponder</STd></tr>)}
                  {m.immoKeys?.map((ik, j) => <tr key={"k" + j}><STd c={C.blue}>{fO(ik.offset)}</STd><STd><STag bg={C.key}>IMMO {j + 1}</STag></STd><STd c={C.key}>{ik.hex}</STd><STd c={C.dim}>IMMO entry</STd></tr>)}
                  {m.zzzzTamper && <tr><STd c={C.blue}>{fO(m.zzzzTamper.offset)}</STd><STd><STag bg={C.warn}>TAMPER</STag></STd><STd c={m.zzzzTamper.intact ? C.green : C.warn}>{m.zzzzTamper.hex} — {m.zzzzTamper.intact ? "INTACT" : "CLEARED"}</STd><STd c={C.dim}>ZZZZ</STd></tr>}
                  {m.securityLock && <tr><STd c={C.blue}>0x8028</STd><STd><STag bg={C.red}>LOCK</STag></STd><STd c={m.securityLock.locked ? C.green : C.warn} bold>0x{m.securityLock.value.toString(16).toUpperCase()}</STd><STd c={C.dim}>{m.securityLock.locked ? "LOCKED" : "UNLOCKED"}</STd></tr>}
                  {m.fobikSlots !== undefined && <tr><STd c={C.blue}>0x0880</STd><STd><STag bg={C.key}>FOBIK</STag></STd><STd c={C.key} bold>{m.fobikSlots} slots</STd><STd c={C.dim}>AA50</STd></tr>}
                  {m.fobikCount !== undefined && <tr><STd c={C.blue}>0x5862</STd><STd><STag bg={C.key}>FOBIK</STag></STd><STd c={C.key} bold>{m.fobikCount} keys</STd><STd c={C.dim}>BCM count</STd></tr>}
                  {m.partNumbers && Object.entries(m.partNumbers).map(([k, v]) => <tr key={k}><STd c={C.blue}>—</STd><STd><STag bg={C.blue}>PN-{k.toUpperCase()}</STag></STd><STd>{v}</STd><STd c={C.dim}>Part#</STd></tr>)}
                  {m.partNumberStr && <tr><STd c={C.blue}>0x0FA1</STd><STd><STag bg={C.blue}>SRI</STag></STd><STd>{m.partNumberStr}</STd><STd c={C.dim}>SW Release</STd></tr>}
                  {m.runtimeCounters && Object.entries(m.runtimeCounters).map(([k, v]) => <tr key={k}><STd c={C.blue}>{fO(v.offset)}</STd><STd><STag bg={C.dim}>CTR</STag></STd><STd>{v.hex} ({v.value.toLocaleString()})</STd><STd c={C.dim}>{k}</STd></tr>)}
                </tbody>
              </table>
            </div>
          </div>)}
        </div>}

        {tab === "security" && modules.length > 0 && <div data-testid="analyzer-security">
          <STitle>Security Architecture</STitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
            {modules.map((m, i) => <div key={i} style={{ background: C.surface2, border: "1px solid " + C.border, borderRadius: 8, padding: 16, borderLeft: "3px solid " + m.color }}>
              <div style={{ fontWeight: 700, color: m.color, marginBottom: 8, fontSize: 14 }}>{m.name}</div>
              {m.vins?.[0] && <div style={{ fontSize: 12, marginBottom: 4 }}>VIN: <span style={{ color: C.green }}>{m.vins[0].vin}</span></div>}
              {m.skimStatus && <div style={{ fontSize: 12, marginBottom: 4 }}>SKIM: <span style={{ color: m.skimByte === 0x80 ? C.green : C.red }}>{m.skimStatus}</span></div>}
              {m.secretKey && <div style={{ fontSize: 11, marginBottom: 4 }}>Secret: <span style={{ color: C.crypto }}>{m.secretKey.hex}</span> {m.keyConsistent ? "✓" : "✗"}</div>}
              {m.vehicleSecret && <div style={{ fontSize: 11, marginBottom: 4 }}>Secret ({m.vehicleSecret.endian}): <span style={{ color: C.crypto }}>{m.vehicleSecret.hex}</span></div>}
              {m.fobikSlots !== undefined && <div style={{ fontSize: 11 }}>FOBIK: <span style={{ color: C.key }}>{m.fobikSlots} slots</span> · CC66AA55: {m.securityMarkers} · ZZZZ: {m.zzzzBlocks}</div>}
              {m.fobikCount !== undefined && <div style={{ fontSize: 11 }}>FOBIK: <span style={{ color: C.key }}>{m.fobikCount} keys</span></div>}
              {m.securityLock && <div style={{ fontSize: 11 }}>Lock: <span style={{ color: m.securityLock.locked ? C.green : C.warn }}>{m.securityLock.locked ? "0x5A LOCKED" : "UNLOCKED"}</span></div>}
              {m.zzzzTamper && <div style={{ fontSize: 11 }}>Tamper: <span style={{ color: m.zzzzTamper.intact ? C.green : C.warn }}>{m.zzzzTamper.intact ? "INTACT" : "CLEARED"}</span></div>}
            </div>)}
          </div>
        </div>}

        {tab === "diff" && <div data-testid="analyzer-diff">
          <STitle>Hex Diff</STitle>
          {modules.length < 2 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>Load 2+ modules to compare.</div> : <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
              <select value={dp[0]} onChange={e => setDp([+e.target.value, dp[1]])} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename}</option>)}</select>
              <span style={{ color: C.dim }}>↔</span>
              <select value={dp[1]} onChange={e => setDp([dp[0], +e.target.value])} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename}</option>)}</select>
            </div>
            {diff && <div>
              <div style={{ fontSize: 12, color: C.warn, marginBottom: 12 }}>{diff.totalChanged} bytes changed, {diff.groups.length} regions</div>
              <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16, maxHeight: 500, overflowY: "auto" }}>
                {diff.groups.slice(0, 50).map(([s, e], gi) => {
                  const a = modules[dp[0]].data, b = modules[dp[1]].data;
                  const ls = s & ~0xf, le = (e | 0xf) + 1, lines = [];
                  for (let o = ls; o < le && o < Math.max(a.length, b.length); o += 16) {
                    const ha = [], hb = [];
                    for (let j = 0; j < 16 && o + j < Math.max(a.length, b.length); j++) {
                      const idx = o + j, va = a[idx] || 0, vb = b[idx] || 0, ch = diff.changedSet.has(idx);
                      ha.push({ v: va.toString(16).padStart(2, "0").toUpperCase(), c: ch });
                      hb.push({ v: vb.toString(16).padStart(2, "0").toUpperCase(), c: ch });
                    }
                    lines.push({ o, ha, hb });
                  }
                  return <div key={gi} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: C.dim }}>{fO(s)}–{fO(e)} ({e - s + 1}B)</div>
                    {lines.map((l, li) => <div key={li} style={{ display: "flex", gap: 16, fontSize: 11, lineHeight: 1.6 }}>
                      <span style={{ color: C.blue, minWidth: 40 }}>{l.o.toString(16).toUpperCase().padStart(4, "0")}</span>
                      <span style={{ minWidth: 200 }}>{l.ha.map((h, hi) => <span key={hi} style={{ color: h.c ? C.red : C.dim, marginRight: 4 }}>{h.v}</span>)}</span>
                      <span style={{ color: C.dim }}>→</span>
                      <span>{l.hb.map((h, hi) => <span key={hi} style={{ color: h.c ? C.green : C.dim, marginRight: 4 }}>{h.v}</span>)}</span>
                    </div>)}
                  </div>;
                })}
                {diff.groups.length > 50 && <div style={{ color: C.dim, fontSize: 11 }}>+{diff.groups.length - 50} more</div>}
              </div>
            </div>}
          </div>}
        </div>}

        {tab === "tools" && <div data-testid="analyzer-tools">
          <STitle>Module Programming Tools</STitle>
          {modules.length === 0 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>Load a module first.</div> : <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: C.dim }}>Target:</label>
              <select value={tt} onChange={e => setTt(+e.target.value)} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename} ({m.name})</option>)}</select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <TCard title="VIN Writer" desc="Update VIN at all locations." color={C.green}>
                <input data-testid="analyzer-vin-input" value={nv} onChange={e => setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "").slice(0, 17))} placeholder="Enter 17-char VIN" maxLength={17} style={{ ...inpSt, marginBottom: 8, width: "100%" }} />
                <div style={{ fontSize: 10, color: nv.length === 17 ? C.green : C.dim, marginBottom: 8 }}>{nv.length}/17</div>
                <TBtn onClick={() => doTool("writeVin")} disabled={nv.length !== 17}>Write VIN</TBtn>
              </TCard>
              <TCard title="SKIM Manager" desc="Toggle SKIM byte at 0x0011 (GPEC2A)." color={C.red}>
                {modules[tt]?.type === "GPEC2A" ? <div>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>Current: <span style={{ color: modules[tt].skimByte === 0x80 ? C.green : C.red, fontWeight: 700 }}>0x{modules[tt].skimByte.toString(16).toUpperCase()}</span></div>
                  <TBtn onClick={() => doTool("skimToggle")}>{modules[tt].skimByte === 0x80 ? "Disable SKIM" : "Enable SKIM"}</TBtn>
                </div> : <div style={{ fontSize: 11, color: C.dim }}>Select GPEC2A.</div>}
              </TCard>
              <TCard title="Virginize PCM" desc="Clear keys, SKIM, ZZZZ, transponder." color={C.warn}>
                {modules[tt]?.type === "GPEC2A" ? <TBtn onClick={() => doTool("virginize")} warn>Virginize</TBtn> : <div style={{ fontSize: 11, color: C.dim }}>Select GPEC2A.</div>}
              </TCard>
              <TCard title="Extract Secret Key" desc="Extract immobilizer sync key." color={C.crypto}>
                <TBtn onClick={() => doTool("extractKey")}>Extract</TBtn>
              </TCard>
            </div>
            {tr && <div style={{ background: C.surface, border: "1px solid " + C.green, borderRadius: 8, padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 8 }}>Result</div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>{tr.desc}</div>
              {tr.keyHex && <div style={{ background: C.bg, padding: 12, borderRadius: 6, fontSize: 14, fontWeight: 700, color: C.crypto, letterSpacing: 1, marginBottom: 8 }}>{tr.keyHex}</div>}
              {tr.data && <button onClick={dl} data-testid="analyzer-download-btn" style={{ background: "linear-gradient(135deg," + C.green + ",#00a88a)", color: "#000", border: "none", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Download Modified .bin</button>}
            </div>}
          </div>}
        </div>}

        {modules.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.15 }}>🔐</div>
          <div style={{ fontSize: 16, color: C.dim, marginBottom: 8 }}>Drop FCA module binary files to begin</div>
          <div style={{ fontSize: 12, color: C.dim }}>Auto-detects GPEC2A, RFHUB, BCM, 95640</div>
        </div>}
      </div>
    </div>
  );
}
