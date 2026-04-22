import { useState, useCallback, useMemo, useRef } from "react";

const MODULE_TYPES = {
  GPEC2A: { name: "GPEC2A PCM", chip: "95320 SPI", size: 4096, color: "#ff6b35" },
  RFHUB: { name: "RFHUB EEE", chip: "Internal EEPROM", size: 4096, color: "#00d4aa" },
  BCM: { name: "BCM DFLASH", chip: "FEE Emulation", size: 65536, color: "#5b8cff" },
  UNKNOWN: { name: "Unknown Module", chip: "\u2014", size: 0, color: "#7a8194" },
};

const SKIM_VALUES = { 0x80: "ENABLED", 0x00: "DISABLED", 0x02: "DISABLED (alt)" };

function detectModuleType(data) {
  if (!data) return "UNKNOWN";
  if (data.length === 65536) {
    const hdr = String.fromCharCode.apply(null, data.slice(4, 11));
    if (hdr === "FEE1000") return "BCM";
    // Some BCMs might not start at offset 4; scan first 256 bytes
    for (let i = 0; i < 256; i++) {
      if (data[i] === 0x46 && String.fromCharCode.apply(null, data.slice(i, i + 7)) === "FEE1000") return "BCM";
    }
    return "BCM"; // 64KB is almost certainly BCM
  }
  if (data.length === 4096) {
    // GPEC: VIN starts at byte 0 (first 17 bytes are alphanumeric ASCII)
    let vinAtZero = true;
    for (let i = 0; i < 17; i++) {
      const b = data[i];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a))) { vinAtZero = false; break; }
    }
    if (vinAtZero) {
      // Additional GPEC confirmation: SKIM byte at 0x0011 or VIN repeat at 0x01F0/0x0224
      const skimVal = data[0x0011];
      if (skimVal === 0x80 || skimVal === 0x00 || skimVal === 0x02) return "GPEC2A";
      // Check for VIN copy at 0x01F0
      if (extractVIN(data, 0x01f0)) return "GPEC2A";
      return "GPEC2A"; // VIN at byte 0 is strong GPEC indicator
    }
    // Not GPEC — it's an RFHUB/EEE (starts with FF padding or other non-VIN data)
    return "RFHUB";
  }
  // Other sizes: try to detect by content
  if (data.length > 0 && data.length <= 8192) return "RFHUB"; // Small EEPROMs likely EEE/RFHUB
  return "UNKNOWN";
}

// Scan entire binary for valid VIN patterns (17-char alphanumeric, no I/O/Q)
function scanForVINs(data) {
  const found = [];
  const seen = new Set();
  for (let i = 0; i <= data.length - 17; i++) {
    let valid = true;
    for (let j = 0; j < 17; j++) {
      const b = data[i + j];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a))) { valid = false; break; }
      // VIN excludes I, O, Q
      if (b === 0x49 || b === 0x4f || b === 0x51) { valid = false; break; }
    }
    if (!valid) continue;
    // Check boundaries: byte before/after should NOT be alphanumeric (avoid substring matches)
    if (i > 0 && data[i-1] >= 0x30 && data[i-1] <= 0x5a) continue;
    if (i + 17 < data.length && data[i+17] >= 0x30 && data[i+17] <= 0x5a) continue;
    const vin = String.fromCharCode.apply(null, data.slice(i, i + 17));
    // Basic VIN validation: position 9 is check digit (0-9 or X), starts with region code
    const key = i + ":" + vin;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ offset: i, vin: vin });
    }
  }
  return found;
}

function extractVIN(data, offset, len) {
  if (!len) len = 17;
  if (offset + len > data.length) return null;
  const bytes = data.slice(offset, offset + len);
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] < 0x30 || bytes[i] > 0x5a) return null; }
  return String.fromCharCode.apply(null, bytes);
}

function extractHex(data, offset, len) {
  const r = [];
  for (let i = 0; i < len; i++) r.push(data[offset + i].toString(16).padStart(2, "0").toUpperCase());
  return r.join(" ");
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function u32(data, o) { return (data[o] << 24) | (data[o+1] << 16) | (data[o+2] << 8) | data[o+3]; }

function countAA50(d, s, n) { let c=0; for(let i=0;i<n;i++) if(d[s+i*2]===0xaa&&d[s+i*2+1]===0x50) c++; return c; }
function countPat(d, a, b, c2, d2) { let c=0; for(let i=0;i<d.length-3;i++) if(d[i]===a&&d[i+1]===b&&d[i+2]===c2&&d[i+3]===d2) c++; return c; }

function parseModule(data, filename) {
  const type = detectModuleType(data);
  const mt = MODULE_TYPES[type];
  const info = { type, filename, data, size: data.length, name: mt.name, chip: mt.chip, color: mt.color };

  if (type === "GPEC2A") {
    info.vins = [
      { offset: 0x0000, vin: extractVIN(data, 0x0000) },
      { offset: 0x01f0, vin: extractVIN(data, 0x01f0) },
      { offset: 0x0224, vin: extractVIN(data, 0x0224) },
    ].filter(v => v.vin);
    info.skimByte = data[0x0011];
    info.skimStatus = SKIM_VALUES[data[0x0011]] || "UNKNOWN (0x" + data[0x0011].toString(16).toUpperCase() + ")";
    info.secretKey = { offset: 0x0203, bytes: data.slice(0x0203, 0x020b), hex: extractHex(data, 0x0203, 8) };
    info.secretKeyMirror = { offset: 0x0361, bytes: data.slice(0x0361, 0x0369), hex: extractHex(data, 0x0361, 8) };
    info.extendedKey = { offset: 0x0361, hex: extractHex(data, 0x0361, 26) };
    info.transponderKeys = [];
    for (let i = 0; i < 4; i++) { const o = 0x0888 + i * 4; info.transponderKeys.push({ offset: o, hex: extractHex(data, o, 4) }); }
    info.zzzzTamper = { offset: 0x0c8c, hex: extractHex(data, 0x0c8c, 8), intact: data[0x0c8c] === 0x5a };
    info.partNumberStr = extractVIN(data, 0x0fa1, 13) || extractHex(data, 0x0fa1, 13);
    info.keyConsistent = arrEq(data.slice(0x0203, 0x020b), data.slice(0x0361, 0x0369));
    info.runtimeCounters = {
      counterA: { offset: 0x0e61, value: u32(data, 0x0e61), hex: extractHex(data, 0x0e61, 4) },
      counterB: { offset: 0x0e69, value: u32(data, 0x0e69), hex: extractHex(data, 0x0e69, 4) },
      distance: { offset: 0x0e6d, value: u32(data, 0x0e6d), hex: extractHex(data, 0x0e6d, 4) },
      keyCycles: { offset: 0x0e75, value: u32(data, 0x0e75), hex: extractHex(data, 0x0e75, 4) },
    };
  } else if (type === "RFHUB") {
    // Try known RFHUB VIN offsets first, then fall back to full scan
    var knownOffsets = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
    var knownVins = knownOffsets.map(o => ({ offset: o, vin: extractVIN(data, o) })).filter(v => v.vin);
    if (knownVins.length > 0) {
      info.vins = knownVins;
    } else {
      // Full scan for VINs anywhere in the file
      info.vins = scanForVINs(data);
    }
    // Try known secret key offset, fall back to scanning for high-entropy blocks
    if (data.length >= 0x051e) {
      info.vehicleSecret = { offset: 0x050e, bytes: data.slice(0x050e, 0x051e), hex: extractHex(data, 0x050e, 16), endian: "big" };
    }
    info.fobikSlots = countAA50(data, 0x0880, 10);
    info.securityMarkers = countPat(data, 0xcc, 0x66, 0xaa, 0x55);
    info.zzzzBlocks = countPat(data, 0x5a, 0x5a, 0x5a, 0x5a);
    // Try to extract part numbers from known locations
    info.partNumbers = {};
    var hw = extractVIN(data, 0x0808, 10);
    var sw = extractVIN(data, 0x0812, 10);
    var cal = extractVIN(data, 0x082c, 14);
    if (hw) info.partNumbers.hw = hw;
    else if (data.length >= 0x0812) info.partNumbers.hw = extractHex(data, 0x0808, 10);
    if (sw) info.partNumbers.sw = sw;
    else if (data.length >= 0x081c) info.partNumbers.sw = extractHex(data, 0x0812, 10);
    if (cal) info.partNumbers.cal = cal;
    else if (data.length >= 0x083a) info.partNumbers.cal = extractHex(data, 0x082c, 14);
  } else if (type === "BCM") {
    info.vins = [0x5328, 0x5348, 0x5368, 0x5388].map(o => ({ offset: o, vin: extractVIN(data, o) })).filter(v => v.vin);
    info.vehicleSecret = { offset: 0x40c9, bytes: data.slice(0x40c9, 0x40d9), hex: extractHex(data, 0x40c9, 16), endian: "little" };
    info.securityLock = { offset: 0x8028, value: data[0x8028], locked: data[0x8028] === 0x5a };
    info.fobikCount = data[0x5862];
    info.immoKeys = [0x81a4, 0x81c4, 0x81e4].map(o => ({ offset: o, hex: extractHex(data, o, 16) }));
    info.fobikParts = extractVIN(data, 0x5818, 10) || extractHex(data, 0x5818, 10);
  }
  return info;
}

function crossValidate(modules) {
  const issues = [], warnings = [], passed = [];
  const allVins = new Set();
  modules.forEach(m => { if (m.vins) m.vins.forEach(v => allVins.add(v.vin)); });
  if (allVins.size === 0) warnings.push("No VINs found.");
  else if (allVins.size === 1) passed.push("VIN consistent: " + Array.from(allVins)[0]);
  else issues.push("VIN MISMATCH: " + Array.from(allVins).join(", "));

  const rfhub = modules.find(m => m.type === "RFHUB");
  const bcm = modules.find(m => m.type === "BCM");
  const gpec = modules.find(m => m.type === "GPEC2A");

  if (rfhub && rfhub.vehicleSecret && bcm && bcm.vehicleSecret) {
    const rev = Array.from(bcm.vehicleSecret.bytes).reverse();
    if (arrEq(new Uint8Array(Array.from(rfhub.vehicleSecret.bytes)), new Uint8Array(rev)))
      passed.push("RFHUB <-> BCM vehicle secret: MATCH (byte-reversed)");
    else issues.push("RFHUB <-> BCM vehicle secret: MISMATCH!");
  }
  if (gpec && gpec.secretKey && bcm) warnings.push("GPEC<->BCM key comparison requires manual check (8B vs 16B)");
  if (gpec) {
    if (gpec.skimByte === 0x80) passed.push("GPEC2A SKIM: ENABLED (0x80)");
    else if (gpec.skimByte === 0x00) warnings.push("GPEC2A SKIM: DISABLED (0x00) -- bypassed");
    if (!gpec.keyConsistent) issues.push("GPEC2A secret key INCONSISTENT (0x0203 vs 0x0361)!");
    else passed.push("GPEC2A secret key consistent (0x0203 = 0x0361)");
    if (gpec.zzzzTamper && !gpec.zzzzTamper.intact) warnings.push("GPEC2A ZZZZ tamper: CLEARED");
    else if (gpec.zzzzTamper && gpec.zzzzTamper.intact) passed.push("GPEC2A ZZZZ tamper: INTACT");
  }
  if (bcm && bcm.securityLock) { if (bcm.securityLock.locked) passed.push("BCM lock: 0x5A LOCKED"); else warnings.push("BCM lock: UNLOCKED"); }
  if (rfhub) { passed.push("RFHUB FOBIK: " + rfhub.fobikSlots + " slots"); passed.push("RFHUB CC66AA55: " + rfhub.securityMarkers); }
  if (bcm) { passed.push("BCM FOBIK: " + bcm.fobikCount + " keys"); if (rfhub && rfhub.fobikSlots !== bcm.fobikCount) warnings.push("Key count mismatch: RFHUB=" + rfhub.fobikSlots + " BCM=" + bcm.fobikCount); }
  return { issues, warnings, passed };
}

function computeDiff(a, b) {
  const changes = [], len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) { if ((a[i] || 0) !== (b[i] || 0)) changes.push(i); }
  const groups = [];
  if (changes.length) {
    let s = changes[0], p = changes[0];
    for (let i = 1; i < changes.length; i++) { if (changes[i] > p + 1) { groups.push([s, p]); s = changes[i]; } p = changes[i]; }
    groups.push([s, p]);
  }
  return { totalChanged: changes.length, groups, changedSet: new Set(changes) };
}

function writeVIN(data, type, vin, existingVins) {
  if (vin.length !== 17) return null;
  const out = new Uint8Array(data);
  const vb = new TextEncoder().encode(vin);
  var offs;
  if (type === "GPEC2A") offs = [0x0000, 0x01f0, 0x0224];
  else if (type === "BCM") offs = [0x5328, 0x5348, 0x5368, 0x5388];
  else if (type === "RFHUB" && existingVins && existingVins.length > 0) offs = existingVins.map(v => v.offset);
  else if (type === "RFHUB") offs = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
  else offs = [];
  offs.forEach(o => { for (let i = 0; i < 17; i++) out[o + i] = vb[i]; });
  if (type === "RFHUB") offs.forEach(o => { let s=0; for(let i=0;i<17;i++) s=(s+out[o+i])&0xff; out[o+17]=s; });
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

const C = { bg:"#06080c", surface:"#0e1117", surface2:"#161b24", border:"#1e2530", text:"#cdd4e0", dim:"#5a6478", red:"#ff3b3b", green:"#00d4aa", blue:"#4d8aff", warn:"#f5a623", key:"#ff6b9d", crypto:"#b07cff", orange:"#ff6b35" };
const fO = n => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const selSt = { background: C.surface2, color: C.text, border: "1px solid " + C.border, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontFamily: "inherit" };
const inpSt = { background: C.bg, color: C.text, border: "1px solid " + C.border, borderRadius: 6, padding: "8px 12px", fontSize: 13, fontFamily: "inherit", letterSpacing: 1 };

function STag({ bg, children }) { return <span style={{ display:"inline-block", padding:"1px 7px", borderRadius:3, fontSize:10, fontWeight:700, background:bg+"22", color:bg, textTransform:"uppercase", letterSpacing:0.5 }}>{children}</span>; }
function STh({ children }) { return <th style={{ textAlign:"left", color:C.dim, fontWeight:600, padding:"6px 10px", borderBottom:"1px solid "+C.border, fontSize:10, textTransform:"uppercase", letterSpacing:0.5 }}>{children}</th>; }
function STd({ c, bold, children }) { return <td style={{ padding:"5px 10px", color:c, fontWeight:bold?700:400, fontSize:12 }}>{children}</td>; }
function SLine({ type, msg }) { const col={error:C.red,warn:C.warn,pass:C.green}; const ico={error:"\u2717",warn:"\u26A0",pass:"\u2713"}; return <div style={{ fontSize:12, color:col[type], padding:"4px 0", display:"flex", gap:8 }}><span style={{ fontWeight:700, minWidth:14 }}>{ico[type]}</span><span>{msg}</span></div>; }
function STitle({ children, color }) { return <div style={{ fontFamily:"'Chakra Petch',sans-serif", fontSize:16, fontWeight:700, color:color||"#fff", margin:"24px 0 12px", display:"flex", alignItems:"center", gap:8 }}><span style={{ color:C.red }}>{"\u25B6"}</span>{children}</div>; }
function TCard({ title, desc, color, children }) { return <div style={{ background:C.surface, border:"1px solid "+C.border, borderRadius:8, padding:16, borderTop:"2px solid "+color }}><div style={{ fontSize:14, fontWeight:700, color:"#fff", marginBottom:4 }}>{title}</div><div style={{ fontSize:11, color:C.dim, marginBottom:12 }}>{desc}</div>{children}</div>; }
function TBtn({ children, onClick, disabled, warn }) { return <button onClick={onClick} disabled={disabled} style={{ background:disabled?C.surface2:warn?"linear-gradient(135deg,"+C.warn+",#d48800)":"linear-gradient(135deg,"+C.blue+",#3a6fd8)", color:disabled?C.dim:"#fff", border:"none", padding:"8px 16px", borderRadius:6, cursor:disabled?"not-allowed":"pointer", fontWeight:700, fontSize:12, fontFamily:"inherit", width:"100%", opacity:disabled?0.5:1 }}>{children}</button>; }

const TABS = ["overview", "security", "diff", "tools"];

export default function App() {
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
  const diff = useMemo(() => { if (modules.length < 2) return null; const a = modules[dp[0]]?.data, b = modules[dp[1]]?.data; return a && b ? computeDiff(a, b) : null; }, [modules, dp]);

  const doTool = action => {
    const m = modules[tt]; if (!m) return; let res = null;
    if (action === "virginize" && m.type === "GPEC2A") res = { data: virginize(m.data), desc: "GPEC2A virginized: SKIM->0x00, keys cleared, ZZZZ zeroed." };
    else if (action === "writeVin" && nv.length === 17) { const d = writeVIN(m.data, m.type, nv, m.vins); if (d) res = { data: d, desc: "VIN updated to " + nv + " at " + (m.vins ? m.vins.length : 0) + " locations" }; }
    else if (action === "skimToggle" && m.type === "GPEC2A") { const d = new Uint8Array(m.data); d[0x0011] = m.skimByte === 0x80 ? 0x00 : 0x80; res = { data: d, desc: "SKIM: 0x" + m.skimByte.toString(16).toUpperCase() + " -> 0x" + d[0x0011].toString(16).toUpperCase() }; }
    else if (action === "extractKey") { let k = m.secretKey ? m.secretKey.hex : m.vehicleSecret ? m.vehicleSecret.hex : ""; res = { keyHex: k, desc: "Extracted from " + m.type }; }
    setTr(res);
  };
  const dl = () => { if (!tr?.data) return; const b = new Blob([tr.data], { type: "application/octet-stream" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "modified_" + (modules[tt]?.filename || "module.bin"); a.click(); URL.revokeObjectURL(u); };

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono','Fira Code',monospace", fontSize: 13, minHeight: "100vh" }}>
      <div style={{ background: "linear-gradient(135deg," + C.surface + ",#0a0e16)", borderBottom: "1px solid " + C.border, padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg," + C.red + "," + C.orange + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900, color: "#fff" }}>S</div>
          <div>
            <div style={{ fontFamily: "'Chakra Petch',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: -0.5 }}>FCA Module Security Analyzer</div>
            <div style={{ fontSize: 11, color: C.dim }}>THE SRT LAB &middot; GPEC2A / RFHUB / BCM &middot; Security Byte Engine</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, marginTop: 16 }}>
          {TABS.map(t => <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? C.surface2 : "transparent", color: tab === t ? "#fff" : C.dim, border: "1px solid " + (tab === t ? C.border : "transparent"), borderBottom: tab === t ? "2px solid " + C.red : "2px solid transparent", padding: "8px 18px", borderRadius: "6px 6px 0 0", cursor: "pointer", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "inherit" }}>{t}</button>)}
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1300, margin: "0 auto" }}>
        <div style={{ border: "2px dashed " + (modules.length ? C.border : C.dim), borderRadius: 10, padding: 20, textAlign: "center", marginBottom: 20, cursor: "pointer", background: C.surface }} onClick={() => fr.current?.click()}>
          <input ref={fr} type="file" multiple accept=".bin" style={{ display: "none" }} onChange={onFiles} />
          <div style={{ fontSize: 14, color: C.dim, marginBottom: 4 }}>{modules.length === 0 ? "Drop .bin files here or click to load" : modules.length + " module(s) loaded"}</div>
          <div style={{ fontSize: 11, color: C.dim }}>GPEC2A EEPROM (4KB) &middot; RFHUB EEE (4KB) &middot; BCM DFLASH (64KB)</div>
        </div>

        {modules.length > 0 && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          {modules.map((m, i) => <div key={i} style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: "12px 16px", borderLeft: "3px solid " + m.color, flex: "1 1 280px", position: "relative", minWidth: 260 }}>
            <button onClick={() => rmMod(i)} style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 14 }}>&times;</button>
            <div style={{ fontSize: 14, fontWeight: 700, color: m.color, marginBottom: 4 }}>{m.name}</div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>{m.filename} &middot; {m.size.toLocaleString()}B</div>
            {m.vins?.[0] && <div style={{ fontSize: 12, color: C.green }}>VIN: {m.vins[0].vin}</div>}
            {m.skimStatus && <div style={{ fontSize: 11, color: m.skimByte === 0x80 ? C.green : C.red }}>SKIM: {m.skimStatus}</div>}
            {m.vehicleSecret && <div style={{ fontSize: 11, color: C.crypto }}>Secret: {m.vehicleSecret.hex.slice(0, 23)}...</div>}
            {m.securityLock && <div style={{ fontSize: 11, color: m.securityLock.locked ? C.green : C.warn }}>{m.securityLock.locked ? "LOCKED" : "UNLOCKED"}</div>}
          </div>)}
          <button onClick={clr} style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 12, color: C.dim, cursor: "pointer", fontSize: 11, flex: "0 0 80px", display: "flex", alignItems: "center", justifyContent: "center" }}>Clear All</button>
        </div>}

        {tab === "overview" && val && <div>
          <STitle>Cross-Module Validation</STitle>
          <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16 }}>
            {val.issues.map((m, i) => <SLine key={"i"+i} type="error" msg={m} />)}
            {val.warnings.map((m, i) => <SLine key={"w"+i} type="warn" msg={m} />)}
            {val.passed.map((m, i) => <SLine key={"p"+i} type="pass" msg={m} />)}
          </div>
          {modules.map((m, i) => <div key={i} style={{ marginTop: 20 }}>
            <STitle color={m.color}>{m.name} &mdash; {m.filename}</STitle>
            <div style={{ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: 16, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr><STh>Offset</STh><STh>Category</STh><STh>Value</STh><STh>Detail</STh></tr></thead>
                <tbody>
                  {m.vins?.map((v, j) => <tr key={"v"+j}><STd c={C.blue}>{fO(v.offset)}</STd><STd><STag bg={C.green}>VIN {j+1}</STag></STd><STd c={C.green} bold>{v.vin}</STd><STd c={C.dim}>17B ASCII</STd></tr>)}
                  {m.skimStatus && <tr><STd c={C.blue}>0x0011</STd><STd><STag bg={C.red}>SKIM</STag></STd><STd c={m.skimByte===0x80?C.green:C.red} bold>0x{m.skimByte.toString(16).toUpperCase()} &mdash; {m.skimStatus}</STd><STd c={C.dim}>Immobilizer byte</STd></tr>}
                  {m.secretKey && <tr><STd c={C.blue}>{fO(m.secretKey.offset)}</STd><STd><STag bg={C.crypto}>SECRET</STag></STd><STd c={C.crypto} bold>{m.secretKey.hex}</STd><STd c={C.dim}>8B sync key {m.keyConsistent ? "\u2713" : "\u2717"}</STd></tr>}
                  {m.vehicleSecret && <tr><STd c={C.blue}>{fO(m.vehicleSecret.offset)}</STd><STd><STag bg={C.crypto}>SECRET</STag></STd><STd c={C.crypto} bold>{m.vehicleSecret.hex}</STd><STd c={C.dim}>{m.vehicleSecret.endian}-endian 16B</STd></tr>}
                  {m.transponderKeys?.map((tk, j) => <tr key={"t"+j}><STd c={C.blue}>{fO(tk.offset)}</STd><STd><STag bg={C.key}>FOBIK {j+1}</STag></STd><STd c={C.key}>{tk.hex}</STd><STd c={C.dim}>Transponder</STd></tr>)}
                  {m.immoKeys?.map((ik, j) => <tr key={"k"+j}><STd c={C.blue}>{fO(ik.offset)}</STd><STd><STag bg={C.key}>IMMO {j+1}</STag></STd><STd c={C.key}>{ik.hex}</STd><STd c={C.dim}>IMMO entry</STd></tr>)}
                  {m.zzzzTamper && <tr><STd c={C.blue}>{fO(m.zzzzTamper.offset)}</STd><STd><STag bg={C.warn}>TAMPER</STag></STd><STd c={m.zzzzTamper.intact?C.green:C.warn}>{m.zzzzTamper.hex} &mdash; {m.zzzzTamper.intact?"INTACT":"CLEARED"}</STd><STd c={C.dim}>ZZZZ</STd></tr>}
                  {m.securityLock && <tr><STd c={C.blue}>0x8028</STd><STd><STag bg={C.red}>LOCK</STag></STd><STd c={m.securityLock.locked?C.green:C.warn} bold>0x{m.securityLock.value.toString(16).toUpperCase()}</STd><STd c={C.dim}>{m.securityLock.locked?"LOCKED":"UNLOCKED"}</STd></tr>}
                  {m.fobikSlots !== undefined && <tr><STd c={C.blue}>0x0880</STd><STd><STag bg={C.key}>FOBIK</STag></STd><STd c={C.key} bold>{m.fobikSlots} slots</STd><STd c={C.dim}>AA50</STd></tr>}
                  {m.fobikCount !== undefined && <tr><STd c={C.blue}>0x5862</STd><STd><STag bg={C.key}>FOBIK</STag></STd><STd c={C.key} bold>{m.fobikCount} keys</STd><STd c={C.dim}>BCM count</STd></tr>}
                  {m.partNumbers && Object.entries(m.partNumbers).map(([k, v]) => <tr key={k}><STd c={C.blue}>&mdash;</STd><STd><STag bg={C.blue}>PN-{k.toUpperCase()}</STag></STd><STd>{v}</STd><STd c={C.dim}>Part#</STd></tr>)}
                  {m.partNumberStr && <tr><STd c={C.blue}>0x0FA1</STd><STd><STag bg={C.blue}>SRI</STag></STd><STd>{m.partNumberStr}</STd><STd c={C.dim}>SW Release</STd></tr>}
                  {m.runtimeCounters && Object.entries(m.runtimeCounters).map(([k, v]) => <tr key={k}><STd c={C.blue}>{fO(v.offset)}</STd><STd><STag bg={C.dim}>CTR</STag></STd><STd>{v.hex} ({v.value.toLocaleString()})</STd><STd c={C.dim}>{k}</STd></tr>)}
                </tbody>
              </table>
            </div>
          </div>)}
        </div>}

        {tab === "security" && modules.length > 0 && <div>
          <STitle>Security Architecture</STitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
            {modules.map((m, i) => <div key={i} style={{ background: C.surface2, border: "1px solid " + C.border, borderRadius: 8, padding: 16, borderLeft: "3px solid " + m.color }}>
              <div style={{ fontWeight: 700, color: m.color, marginBottom: 8, fontSize: 14 }}>{m.name}</div>
              {m.vins?.[0] && <div style={{ fontSize: 12, marginBottom: 4 }}>VIN: <span style={{ color: C.green }}>{m.vins[0].vin}</span></div>}
              {m.skimStatus && <div style={{ fontSize: 12, marginBottom: 4 }}>SKIM: <span style={{ color: m.skimByte===0x80?C.green:C.red }}>{m.skimStatus}</span></div>}
              {m.secretKey && <div style={{ fontSize: 11, marginBottom: 4 }}>Secret: <span style={{ color: C.crypto }}>{m.secretKey.hex}</span> {m.keyConsistent ? "\u2713" : "\u2717"}</div>}
              {m.vehicleSecret && <div style={{ fontSize: 11, marginBottom: 4 }}>Secret ({m.vehicleSecret.endian}): <span style={{ color: C.crypto }}>{m.vehicleSecret.hex}</span></div>}
              {m.fobikSlots !== undefined && <div style={{ fontSize: 11 }}>FOBIK: <span style={{ color: C.key }}>{m.fobikSlots} slots</span> &middot; CC66AA55: {m.securityMarkers} &middot; ZZZZ: {m.zzzzBlocks}</div>}
              {m.fobikCount !== undefined && <div style={{ fontSize: 11 }}>FOBIK: <span style={{ color: C.key }}>{m.fobikCount} keys</span></div>}
              {m.securityLock && <div style={{ fontSize: 11 }}>Lock: <span style={{ color: m.securityLock.locked?C.green:C.warn }}>{m.securityLock.locked?"0x5A LOCKED":"UNLOCKED"}</span></div>}
              {m.zzzzTamper && <div style={{ fontSize: 11 }}>Tamper: <span style={{ color: m.zzzzTamper.intact?C.green:C.warn }}>{m.zzzzTamper.intact?"INTACT":"CLEARED"}</span></div>}
            </div>)}
          </div>
        </div>}

        {tab === "diff" && <div>
          <STitle>Hex Diff</STitle>
          {modules.length < 2 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>Load 2+ modules to compare.</div> : <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
              <select value={dp[0]} onChange={e => setDp([+e.target.value, dp[1]])} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename}</option>)}</select>
              <span style={{ color: C.dim }}>&harr;</span>
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
                    for (let j = 0; j < 16 && o+j < Math.max(a.length, b.length); j++) {
                      const idx = o+j, va = a[idx]||0, vb = b[idx]||0, ch = diff.changedSet.has(idx);
                      ha.push({ v: va.toString(16).padStart(2,"0").toUpperCase(), c: ch });
                      hb.push({ v: vb.toString(16).padStart(2,"0").toUpperCase(), c: ch });
                    }
                    lines.push({ o, ha, hb });
                  }
                  return <div key={gi} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: C.dim }}>{fO(s)}&ndash;{fO(e)} ({e-s+1}B)</div>
                    {lines.map((l, li) => <div key={li} style={{ display: "flex", gap: 16, fontSize: 11, lineHeight: 1.6 }}>
                      <span style={{ color: C.blue, minWidth: 40 }}>{l.o.toString(16).toUpperCase().padStart(4,"0")}</span>
                      <span style={{ minWidth: 200 }}>{l.ha.map((h, hi) => <span key={hi} style={{ color: h.c ? C.red : C.dim, marginRight: 4 }}>{h.v}</span>)}</span>
                      <span style={{ color: C.dim }}>&rarr;</span>
                      <span>{l.hb.map((h, hi) => <span key={hi} style={{ color: h.c ? C.green : C.dim, marginRight: 4 }}>{h.v}</span>)}</span>
                    </div>)}
                  </div>;
                })}
                {diff.groups.length > 50 && <div style={{ color: C.dim, fontSize: 11 }}>+{diff.groups.length - 50} more</div>}
              </div>
            </div>}
          </div>}
        </div>}

        {tab === "tools" && <div>
          <STitle>Module Programming Tools</STitle>
          {modules.length === 0 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>Load a module first.</div> : <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: C.dim }}>Target:</label>
              <select value={tt} onChange={e => setTt(+e.target.value)} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename} ({m.name})</option>)}</select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <TCard title="VIN Writer" desc="Update VIN at all locations." color={C.green}>
                <input value={nv} onChange={e => setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,"").slice(0,17))} placeholder="Enter 17-char VIN" maxLength={17} style={{...inpSt, marginBottom:8, width:"100%"}} />
                <div style={{ fontSize: 10, color: nv.length===17?C.green:C.dim, marginBottom: 8 }}>{nv.length}/17</div>
                <TBtn onClick={() => doTool("writeVin")} disabled={nv.length!==17}>Write VIN</TBtn>
              </TCard>
              <TCard title="SKIM Manager" desc="Toggle SKIM byte at 0x0011 (GPEC2A)." color={C.red}>
                {modules[tt]?.type==="GPEC2A" ? <div>
                  <div style={{ fontSize:12, marginBottom:8 }}>Current: <span style={{ color:modules[tt].skimByte===0x80?C.green:C.red, fontWeight:700 }}>0x{modules[tt].skimByte.toString(16).toUpperCase()}</span></div>
                  <TBtn onClick={() => doTool("skimToggle")}>{modules[tt].skimByte===0x80?"Disable SKIM":"Enable SKIM"}</TBtn>
                </div> : <div style={{ fontSize:11, color:C.dim }}>Select GPEC2A.</div>}
              </TCard>
              <TCard title="Virginize PCM" desc="Clear keys, SKIM, ZZZZ, transponder." color={C.warn}>
                {modules[tt]?.type==="GPEC2A" ? <TBtn onClick={() => doTool("virginize")} warn>Virginize</TBtn> : <div style={{ fontSize:11, color:C.dim }}>Select GPEC2A.</div>}
              </TCard>
              <TCard title="Extract Secret Key" desc="Extract immobilizer sync key." color={C.crypto}>
                <TBtn onClick={() => doTool("extractKey")}>Extract</TBtn>
              </TCard>
            </div>
            {tr && <div style={{ background: C.surface, border: "1px solid " + C.green, borderRadius: 8, padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 8 }}>Result</div>
              <div style={{ fontSize: 12, marginBottom: 8 }}>{tr.desc}</div>
              {tr.keyHex && <div style={{ background: C.bg, padding: 12, borderRadius: 6, fontSize: 14, fontWeight: 700, color: C.crypto, letterSpacing: 1, marginBottom: 8 }}>{tr.keyHex}</div>}
              {tr.data && <button onClick={dl} style={{ background: "linear-gradient(135deg," + C.green + ",#00a88a)", color: "#000", border: "none", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Download Modified .bin</button>}
            </div>}
          </div>}
        </div>}

        {modules.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.15 }}>{"\uD83D\uDD10"}</div>
          <div style={{ fontSize: 16, color: C.dim, marginBottom: 8 }}>Drop FCA module binary files to begin</div>
          <div style={{ fontSize: 12, color: C.dim }}>Auto-detects GPEC2A, RFHUB, BCM</div>
        </div>}
      </div>
    </div>
  );
}
