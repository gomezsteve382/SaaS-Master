/* ============================================================================
 * FcaModuleInspector — rescued from attached_assets/tsetup-x64.6.7.5_1776900458954.exe
 *
 * The original drop was misnamed with a `.exe` suffix and silently stranded;
 * the file is actually a 33 KB React JSX component (UTF-8) implementing an
 * FCA module-binary inspector. It auto-detects GPEC2A / RFHUB / BCM dumps,
 * scans for valid VINs (with proper boundary checks and I/O/Q exclusion),
 * reads the SKIM enable/disable byte at 0x0011 (GPEC2A), and produces a
 * downloadable patched `.bin` for VIN/SKIM/virginize/key-extract operations.
 *
 * Task #496 rehomed the file under a clear name, exported the helper
 * functions for unit tests, and wired the component into the SRT Lab tab
 * registry.
 *
 * Task #502 re-skins the UI to use the workspace-wide design tokens
 * (`C` from `../lib/constants.js`, `Card`/`Btn`/`Tag`/`SLine` from
 * `../lib/ui.jsx`) so it stops looking like a stranded standalone app.
 * Detection logic is preserved verbatim — `detectModuleType`,
 * `scanForVINs`, `parseInspectorModule`, `extractVIN`, `extractHex`,
 * `crossValidate`, `computeDiff`, and `virginize` are untouched (the
 * fixture tests in `__tests__/FcaModuleInspector.fixtures.test.js`
 * must still pass).
 *
 * Task #517 replaces the inspector's local `writeVIN()` with
 * `inspectorWriteVin()`, a thin shim that delegates to the
 * workspace-shared `analyzeFile()` + `patchFile()` pipeline in
 * `../lib/fileUtils.js`. The old writer only stamped VIN bytes at
 * hard-coded offsets and applied a sum-mod-256 byte for RFHUB; the
 * shared pipeline recomputes every per-slot CRC the workspace knows
 * about (Gen2 mirrored crc8rf, Gen1 crc16, BCM crc16, 95640 crc8/42),
 * handles BCM partial 8-char tails, and syncs the BCM IMMO backup
 * block — so a `modified_*.bin` from the inspector is now flashable
 * and byte-identical to what `VinProgrammerTab` produces for the same
 * input/VIN.
 * ========================================================================== */
import { useState, useCallback, useMemo, useRef, useContext } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn, Tag, SLine } from "../lib/ui.jsx";
import { parseModule } from "../lib/parseModule.js";
import { MasterVinContext } from "../lib/masterVinContext.jsx";
import { analyzeFile, patchFile } from "../lib/fileUtils.js";

/* Task #518 — the inspector is no longer a sandboxed island. Instead of
 * keeping its own local `useState([])` of parsed dumps, it now reads from
 * (and writes to) the workspace-wide MasterVinContext store the same way
 * Gpec2aTab / RfhubTab / BcmTab do. Files dropped into the inspector
 * appear in the per-module tabs immediately, and files loaded elsewhere
 * (Dumps tab, Samples Library, etc.) appear in the inspector's module
 * list without the user having to re-drop them.
 *
 * Files loaded via the inspector are now parsed by the canonical
 * workspace `parseModule` (not the inspector-private `parseInspectorModule`)
 * so the resulting dump shape matches what every other tab expects —
 * size warnings, content warnings, RFHUB CRC verdicts, BCM SEC16
 * resolution, etc. The legacy `parseInspectorModule` helper is still
 * exported (and still used by the helper-only fixtures suite) for
 * backwards compatibility, but the live UI no longer calls it. */

// Module types the inspector cares about. Other types loaded into the
// workspace (e.g. '95640' EEPROM backups, EFD payloads, C-Flash blobs)
// are intentionally excluded — the inspector's UI panels assume one of
// these three families.
const INSPECTOR_TYPES = ["GPEC2A", "RFHUB", "BCM"];

// Display-name overlay so the tile chrome keeps the inspector's
// long-form labels (the rest of the workspace uses parseModule's
// shorter labels — e.g. "BCM D-FLASH" — but the inspector predates
// that and shipped with these). This only affects rendered text;
// the underlying entry.mod.name (set by parseModule) is unchanged.
const INSPECTOR_DISPLAY_NAMES = {
  GPEC2A: "GPEC2A PCM",
  RFHUB: "RFHUB EEE",
  BCM: "BCM DFLASH",
};
const inspectorName = (m) => (m && INSPECTOR_DISPLAY_NAMES[m.type]) || (m && m.name) || "";

const MODULE_TYPES = {
  GPEC2A: { name: "GPEC2A PCM", chip: "95320 SPI", size: 4096, color: C.a1 },
  RFHUB: { name: "RFHUB EEE", chip: "Internal EEPROM", size: 4096, color: C.a2 },
  BCM: { name: "BCM DFLASH", chip: "FEE Emulation", size: 65536, color: C.a3 },
  UNKNOWN: { name: "Unknown Module", chip: "\u2014", size: 0, color: C.tm },
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

function parseInspectorModule(data, filename) {
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

/* Task #517 — VIN Writer now routes through the workspace-shared
 * patchFile() pipeline (see ../lib/fileUtils.js) instead of the
 * inspector's old local writeVIN(). The local writer only stamped VIN
 * bytes at hard-coded offsets and applied a naive sum-mod-256 byte for
 * RFHUB; it did NOT recompute the per-slot CRCs every module family
 * actually uses (Gen2 mirrored crc8rf, Gen1 crc16, BCM crc16, 95640
 * crc8/42), did NOT reverse VIN bytes for Gen2 RFHUB mirrored slots,
 * did NOT touch BCM partial 8-char tail slots at 0x4098 / 0x40B0, and
 * did NOT sync the BCM IMMO backup block. A patched .bin from the
 * inspector therefore failed module-side integrity checks at boot.
 *
 * Delegating to patchFile(analyzeFile(...)) gives the inspector the
 * exact same flashable output as VinProgrammerTab for the same
 * input/VIN, and the structured `log` array is surfaced in the result
 * card so the user can see every offset that was touched. */
function inspectorWriteVin(data, filename, vin) {
  if (typeof vin !== "string" || vin.length !== 17) return null;
  const info = analyzeFile(data, filename);
  if (!info || (info.vins.length === 0 && (!info.partials || info.partials.length === 0))) {
    return { data: null, log: [], info, slotCount: 0, partialCount: 0, unsupported: true };
  }
  const { data: out, log } = patchFile(info, vin);
  return {
    data: out,
    log,
    info,
    slotCount: info.vins.length,
    partialCount: info.partials ? info.partials.length : 0,
    unsupported: false,
  };
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

/* ── UI helpers (workspace-themed) ──────────────────────────────────────────
 * Map the rescued tool's semantic colors onto the shared SRT Lab palette so
 * the inspector visually matches Gpec2aTab / VinProgrammerTab / RfhubTab.
 *   crypto secrets → C.a4 (purple)   key/transponder → C.a4
 *   VINs           → C.a1 (orange)   offsets/hex     → C.a3 (blue)
 *   pass/warn/err  → C.gn / C.wn / C.er
 */
const fO = n => "0x" + n.toString(16).toUpperCase().padStart(4, "0");

const selSt = {
  background: C.cd,
  color: C.tx,
  border: "1.5px solid " + C.bd,
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 12,
  fontFamily: "'Nunito',sans-serif",
  fontWeight: 700,
  cursor: "pointer",
};

const inpSt = {
  background: C.cd,
  color: C.tx,
  border: "1.5px solid " + C.bd,
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
  fontFamily: "'JetBrains Mono',monospace",
  letterSpacing: 1,
  outline: "none",
};

function STh({ children }) {
  return <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "8px 10px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{children}</th>;
}
function STd({ c, bold, mono, children }) {
  return <td style={{ padding: "6px 10px", color: c || C.tx, fontWeight: bold ? 800 : 500, fontSize: 12, fontFamily: mono ? "'JetBrains Mono',monospace" : "'Nunito',sans-serif" }}>{children}</td>;
}

function STitle({ children, color }) {
  return <div style={{ fontFamily: "'Nunito',sans-serif", fontSize: 14, fontWeight: 900, color: color || C.tx, margin: "20px 0 10px", display: "flex", alignItems: "center", gap: 8, letterSpacing: 0.5 }}>
    <span style={{ color: C.sr, fontSize: 12 }}>▶</span>{children}
  </div>;
}

const TABS = [
  { id: "overview", label: "Overview", icon: "📋" },
  { id: "security", label: "Security", icon: "🔒" },
  { id: "diff",     label: "Hex Diff", icon: "🔀" },
  { id: "tools",    label: "Tools",    icon: "🛠️" },
];

export { MODULE_TYPES, SKIM_VALUES, detectModuleType, scanForVINs, extractVIN, parseInspectorModule, inspectorWriteVin };

export default function FcaModuleInspector() {
  const { loadedDumps, addDump, removeDump } = useContext(MasterVinContext);
  const [tab, setTab] = useState("overview");
  const [dp, setDp] = useState([0, 1]);
  const [nv, setNv] = useState("");
  const [tt, setTt] = useState(0);
  const [tr, setTr] = useState(null);
  const [loadMsg, setLoadMsg] = useState("");
  const fr = useRef();

  // Pull every inspector-relevant dump out of the shared workspace store
  // so files loaded in any tab (Dumps, Samples, Gpec2a/Rfhub/Bcm) appear
  // here automatically, ordered by load time. Each entry's `mod` is the
  // canonical `parseModule` output the rest of the workspace renders.
  const entries = useMemo(
    () =>
      loadedDumps
        .filter((d) => INSPECTOR_TYPES.includes(d.type))
        .slice()
        .sort((a, b) => a.addedAt - b.addedAt),
    [loadedDumps]
  );
  const modules = useMemo(() => entries.map((e) => e.mod), [entries]);

  const onFiles = useCallback(
    (e) => {
      const files = Array.from(e.target.files);
      e.target.value = "";
      if (files.length === 0) return;
      const skipped = [];
      let pending = files.length;
      files.forEach((f) => {
        const r = new FileReader();
        r.onload = (ev) => {
          const bytes = new Uint8Array(ev.target.result);
          const m = parseModule(bytes, f.name);
          if (!m || !m.type || !INSPECTOR_TYPES.includes(m.type)) {
            skipped.push(f.name + " (" + (m?.type || "UNKNOWN") + ")");
          } else {
            addDump(m);
          }
          pending -= 1;
          if (pending === 0) {
            setLoadMsg(
              skipped.length
                ? "Skipped " + skipped.length + ' file(s): only GPEC2A / RFHUB / BCM dumps load into the inspector — ' + skipped.join(", ")
                : ""
            );
          }
        };
        r.readAsArrayBuffer(f);
      });
    },
    [addDump]
  );

  // The × button on a tile and the Clear All button are explicit user
  // actions: per the Task #518 contract, they DO drop the dump from the
  // shared store (other tabs will fall through to whatever dump is next
  // in their per-type list). Tab switches and unrelated UI churn never
  // touch the store.
  const rmMod = useCallback(
    (i) => {
      const entry = entries[i];
      if (entry) removeDump(entry.hash);
    },
    [entries, removeDump]
  );
  const clr = useCallback(() => {
    entries.forEach((e) => removeDump(e.hash));
    setTr(null);
    setLoadMsg("");
  }, [entries, removeDump]);

  const val = useMemo(() => (modules.length > 0 ? crossValidate(modules) : null), [modules]);
  // Clamp the diff and tools target indices so removals (or auto-shared
  // dumps appearing/disappearing) can't leave them pointing into thin
  // air — we used to assume `modules` only grew, but it's now driven by
  // the shared store and can shrink at any time.
  const safeDp = useMemo(() => {
    if (modules.length < 2) return [0, Math.min(1, modules.length - 1)];
    const a = Math.min(Math.max(dp[0], 0), modules.length - 1);
    const b = Math.min(Math.max(dp[1], 0), modules.length - 1);
    return [a, b];
  }, [modules, dp]);
  const safeTt = useMemo(() => Math.min(Math.max(tt, 0), Math.max(modules.length - 1, 0)), [modules, tt]);
  const diff = useMemo(() => {
    if (modules.length < 2) return null;
    const a = modules[safeDp[0]]?.data, b = modules[safeDp[1]]?.data;
    return a && b ? computeDiff(a, b) : null;
  }, [modules, safeDp]);

  const doTool = action => {
    const m = modules[safeTt]; if (!m) return; let res = null;
    if (action === "virginize" && m.type === "GPEC2A") res = { data: virginize(m.data), desc: "GPEC2A virginized: SKIM→0x00, keys cleared, ZZZZ zeroed." };
    else if (action === "writeVin" && nv.length === 17) {
      // Task #517 — route through the workspace-shared patchFile pipeline
      // so every per-slot CRC is recomputed (Gen2 mirrored crc8rf, Gen1
      // crc16, BCM crc16+IMMO sync, 95640 crc8/42). The old local
      // writeVIN() only stamped VIN bytes and produced unflashable bins.
      const r = inspectorWriteVin(m.data, m.filename, nv);
      if (r && r.unsupported) {
        res = { data: null, desc: "VIN write skipped — analyzer found no patchable VIN slots in " + (r.info ? (r.info.name || r.info.type) : m.type) + ". File type may be unsupported for VIN programming." };
      } else if (r && r.data) {
        const slotsTxt = r.slotCount + " slot" + (r.slotCount === 1 ? "" : "s") + (r.partialCount > 0 ? " + " + r.partialCount + " partial" + (r.partialCount === 1 ? "" : "s") : "");
        res = { data: r.data, desc: "VIN updated to " + nv + " — " + slotsTxt + ", checksums recomputed via shared pipeline.", log: r.log };
      }
    }
    else if (action === "skimToggle" && m.type === "GPEC2A") { const d = new Uint8Array(m.data); d[0x0011] = m.skimByte === 0x80 ? 0x00 : 0x80; res = { data: d, desc: "SKIM: 0x" + m.skimByte.toString(16).toUpperCase() + " → 0x" + d[0x0011].toString(16).toUpperCase() }; }
    else if (action === "extractKey") { let k = m.secretKey ? m.secretKey.hex : m.vehicleSecret ? m.vehicleSecret.hex : ""; res = { keyHex: k, desc: "Extracted from " + m.type }; }
    setTr(res);
  };
  const dl = () => { if (!tr?.data) return; const b = new Blob([tr.data], { type: "application/octet-stream" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "modified_" + (modules[safeTt]?.filename || "module.bin"); a.click(); URL.revokeObjectURL(u); };

  return <div>
    {/* Hero — matches the gradient title cards used by GPEC2A / RFHUB / BCM tabs */}
    <Card style={{ background: "linear-gradient(135deg,#1A0A2E 0%,#2E0A4D 40%,#AA00FF 100%)", color: "#fff", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 32 }}>🔍</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 24, letterSpacing: 2 }}>MODULE INSPECTOR</div>
          <div style={{ fontSize: 10, opacity: .75, letterSpacing: 3, fontWeight: 700 }}>GPEC2A · RFHUB · BCM · CROSS-MODULE VALIDATION</div>
        </div>
      </div>
    </Card>

    {/* Sub-tab strip — borrows the workspace tab-bar styling at a slightly smaller scale */}
    <Card style={{ marginBottom: 14, padding: 6 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {TABS.map(t => {
          const a = tab === t.id;
          return <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "9px 16px", border: "none", cursor: "pointer",
            background: a ? C.sr : "transparent",
            borderRadius: 10, color: a ? "#fff" : C.ts,
            fontFamily: "'Nunito'", fontWeight: a ? 900 : 700, fontSize: 11,
            letterSpacing: 1.2, transition: "all 0.2s",
          }}><span style={{ fontSize: 13, marginRight: 6 }}>{t.icon}</span>{t.label.toUpperCase()}</button>;
        })}
      </div>
    </Card>

    {/* File drop / loader — matches the upload card style used by Gpec2aTab */}
    <label style={{ cursor: "pointer", display: "block" }}>
      <Card style={{
        textAlign: "center", padding: 22, marginBottom: 16,
        border: "2px dashed " + (modules.length ? C.bd : C.tm),
        background: modules.length ? C.cd : C.c2,
      }}>
        <div style={{ fontSize: 28 }}>📂</div>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.ts, marginTop: 6 }}>
          {modules.length === 0 ? "Drop .bin files here or click to load" : modules.length + " module(s) loaded — add more"}
        </div>
        <div style={{ fontSize: 10, color: C.tm, marginTop: 4, letterSpacing: 0.5 }}>GPEC2A EEPROM (4KB) · RFHUB EEE (4KB) · BCM DFLASH (64KB)</div>
        <div style={{ fontSize: 10, color: C.tm, marginTop: 4, fontStyle: "italic" }}>
          Files loaded in other tabs (Dumps, Samples, GPEC2A / RFHUB / BCM) appear here automatically.
        </div>
        <input ref={fr} type="file" multiple accept=".bin,.BIN" hidden onChange={onFiles} />
      </Card>
    </label>
    {loadMsg && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.wn + "15", border: "1px solid " + C.wn + "40", color: C.wn, fontSize: 11, fontWeight: 700 }}>⚠ {loadMsg}</div>}

    {/* Loaded module chips */}
    {modules.length > 0 && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
      {modules.map((m, i) => <div key={i} style={{
        background: C.cd, border: "1.5px solid " + C.bd, borderRadius: 12,
        padding: "12px 14px 12px 16px", borderLeft: "4px solid " + m.color,
        flex: "1 1 280px", position: "relative", minWidth: 260,
        boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
      }}>
        <button onClick={() => rmMod(i)} aria-label="Remove module" style={{
          position: "absolute", top: 8, right: 10, background: "none", border: "none",
          color: C.tm, cursor: "pointer", fontSize: 16, lineHeight: 1, fontWeight: 700,
        }}>×</button>
        <div style={{ fontSize: 13, fontWeight: 900, color: m.color, marginBottom: 2 }}>{inspectorName(m)}</div>
        <div style={{ fontSize: 10, color: C.tm, marginBottom: 8, fontFamily: "'JetBrains Mono'" }}>{m.filename} · {m.size.toLocaleString()}B</div>
        {m.vins?.[0] && <div style={{ fontSize: 11, color: C.a1, fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>VIN: {m.vins[0].vin}</div>}
        {m.skimStatus && <div style={{ fontSize: 11, color: m.skimByte === 0x80 ? C.gn : C.er, fontWeight: 700, marginTop: 2 }}>SKIM: {m.skimStatus}</div>}
        {m.vehicleSecret && <div style={{ fontSize: 10, color: C.a4, fontFamily: "'JetBrains Mono'", marginTop: 2 }}>Secret: {m.vehicleSecret.hex.slice(0, 23)}…</div>}
        {m.securityLock && <div style={{ fontSize: 11, color: m.securityLock.locked ? C.gn : C.wn, fontWeight: 700, marginTop: 2 }}>{m.securityLock.locked ? "LOCKED" : "UNLOCKED"}</div>}
      </div>)}
      <button onClick={clr} style={{
        background: C.cd, border: "1.5px dashed " + C.bd, borderRadius: 12,
        padding: 12, color: C.ts, cursor: "pointer", fontSize: 11, fontWeight: 800,
        flex: "0 0 100px", display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Nunito'", letterSpacing: 0.5,
      }}>Clear All</button>
    </div>}

    {/* OVERVIEW TAB */}
    {tab === "overview" && val && <div>
      <STitle>Cross-Module Validation</STitle>
      <Card style={{ padding: 14 }}>
        {val.issues.map((m, i) => <SLine key={"i"+i} type="error" msg={m} />)}
        {val.warnings.map((m, i) => <SLine key={"w"+i} type="warn" msg={m} />)}
        {val.passed.map((m, i) => <SLine key={"p"+i} type="pass" msg={m} />)}
      </Card>
      {modules.map((m, i) => <div key={i} style={{ marginTop: 14 }}>
        <STitle color={m.color}>{inspectorName(m)} — <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: C.ts }}>{m.filename}</span></STitle>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr><STh>Offset</STh><STh>Category</STh><STh>Value</STh><STh>Detail</STh></tr></thead>
              <tbody>
                {m.vins?.map((v, j) => <tr key={"v"+j}><STd c={C.a3} mono>{fO(v.offset)}</STd><STd><Tag color={C.a1}>VIN {j+1}</Tag></STd><STd c={C.a1} bold mono>{v.vin}</STd><STd c={C.tm}>17B ASCII</STd></tr>)}
                {m.skimStatus && <tr><STd c={C.a3} mono>0x0011</STd><STd><Tag color={C.sr}>SKIM</Tag></STd><STd c={m.skimByte===0x80?C.gn:C.er} bold mono>0x{m.skimByte.toString(16).toUpperCase()} — {m.skimStatus}</STd><STd c={C.tm}>Immobilizer byte</STd></tr>}
                {m.secretKey && <tr><STd c={C.a3} mono>{fO(m.secretKey.offset)}</STd><STd><Tag color={C.a4}>SECRET</Tag></STd><STd c={C.a4} bold mono>{m.secretKey.hex}</STd><STd c={C.tm}>8B sync key {m.keyConsistent ? "✓" : "✗"}</STd></tr>}
                {m.vehicleSecret && <tr><STd c={C.a3} mono>{fO(m.vehicleSecret.offset)}</STd><STd><Tag color={C.a4}>SECRET</Tag></STd><STd c={C.a4} bold mono>{m.vehicleSecret.hex}</STd><STd c={C.tm}>{m.vehicleSecret.endian}-endian 16B</STd></tr>}
                {m.transponderKeys?.map((tk, j) => <tr key={"t"+j}><STd c={C.a3} mono>{fO(tk.offset)}</STd><STd><Tag color={C.a4}>FOBIK {j+1}</Tag></STd><STd c={C.a4} mono>{tk.hex}</STd><STd c={C.tm}>Transponder</STd></tr>)}
                {m.immoKeys?.map((ik, j) => <tr key={"k"+j}><STd c={C.a3} mono>{fO(ik.offset)}</STd><STd><Tag color={C.a4}>IMMO {j+1}</Tag></STd><STd c={C.a4} mono>{ik.hex}</STd><STd c={C.tm}>IMMO entry</STd></tr>)}
                {m.zzzzTamper && <tr><STd c={C.a3} mono>{fO(m.zzzzTamper.offset)}</STd><STd><Tag color={C.wn}>TAMPER</Tag></STd><STd c={m.zzzzTamper.intact?C.gn:C.wn} mono>{m.zzzzTamper.hex} — {m.zzzzTamper.intact?"INTACT":"CLEARED"}</STd><STd c={C.tm}>ZZZZ</STd></tr>}
                {m.securityLock && <tr><STd c={C.a3} mono>0x8028</STd><STd><Tag color={C.sr}>LOCK</Tag></STd><STd c={m.securityLock.locked?C.gn:C.wn} bold mono>0x{m.securityLock.value.toString(16).toUpperCase()}</STd><STd c={C.tm}>{m.securityLock.locked?"LOCKED":"UNLOCKED"}</STd></tr>}
                {m.fobikSlots !== undefined && <tr><STd c={C.a3} mono>0x0880</STd><STd><Tag color={C.a4}>FOBIK</Tag></STd><STd c={C.a4} bold>{m.fobikSlots} slots</STd><STd c={C.tm}>AA50</STd></tr>}
                {m.fobikCount !== undefined && <tr><STd c={C.a3} mono>0x5862</STd><STd><Tag color={C.a4}>FOBIK</Tag></STd><STd c={C.a4} bold>{m.fobikCount} keys</STd><STd c={C.tm}>BCM count</STd></tr>}
                {m.partNumbers && Object.entries(m.partNumbers).map(([k, v]) => <tr key={k}><STd c={C.a3} mono>—</STd><STd><Tag color={C.a3}>PN-{k.toUpperCase()}</Tag></STd><STd mono>{v}</STd><STd c={C.tm}>Part#</STd></tr>)}
                {m.partNumberStr && <tr><STd c={C.a3} mono>0x0FA1</STd><STd><Tag color={C.a3}>SRI</Tag></STd><STd mono>{m.partNumberStr}</STd><STd c={C.tm}>SW Release</STd></tr>}
                {m.runtimeCounters && Object.entries(m.runtimeCounters).map(([k, v]) => <tr key={k}><STd c={C.a3} mono>{fO(v.offset)}</STd><STd><Tag color={C.tm}>CTR</Tag></STd><STd mono>{v.hex} ({v.value.toLocaleString()})</STd><STd c={C.tm}>{k}</STd></tr>)}
              </tbody>
            </table>
          </div>
        </Card>
      </div>)}
    </div>}

    {/* SECURITY TAB */}
    {tab === "security" && modules.length > 0 && <div>
      <STitle>Security Architecture</STitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {modules.map((m, i) => <Card key={i} style={{ padding: 16, borderLeft: "4px solid " + m.color }}>
          <div style={{ fontWeight: 900, color: m.color, marginBottom: 10, fontSize: 14 }}>{inspectorName(m)}</div>
          {m.vins?.[0] && <div style={{ fontSize: 12, marginBottom: 5 }}>VIN: <span style={{ color: C.a1, fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{m.vins[0].vin}</span></div>}
          {m.skimStatus && <div style={{ fontSize: 12, marginBottom: 5 }}>SKIM: <span style={{ color: m.skimByte === 0x80 ? C.gn : C.er, fontWeight: 700 }}>{m.skimStatus}</span></div>}
          {m.secretKey && <div style={{ fontSize: 11, marginBottom: 5 }}>Secret: <span style={{ color: C.a4, fontFamily: "'JetBrains Mono'" }}>{m.secretKey.hex}</span> {m.keyConsistent ? "✓" : "✗"}</div>}
          {m.vehicleSecret && <div style={{ fontSize: 11, marginBottom: 5 }}>Secret ({m.vehicleSecret.endian}): <span style={{ color: C.a4, fontFamily: "'JetBrains Mono'" }}>{m.vehicleSecret.hex}</span></div>}
          {m.fobikSlots !== undefined && <div style={{ fontSize: 11, marginBottom: 3 }}>FOBIK: <span style={{ color: C.a4, fontWeight: 700 }}>{m.fobikSlots} slots</span> · CC66AA55: {m.securityMarkers} · ZZZZ: {m.zzzzBlocks}</div>}
          {m.fobikCount !== undefined && <div style={{ fontSize: 11, marginBottom: 3 }}>FOBIK: <span style={{ color: C.a4, fontWeight: 700 }}>{m.fobikCount} keys</span></div>}
          {m.securityLock && <div style={{ fontSize: 11, marginBottom: 3 }}>Lock: <span style={{ color: m.securityLock.locked ? C.gn : C.wn, fontWeight: 700 }}>{m.securityLock.locked ? "0x5A LOCKED" : "UNLOCKED"}</span></div>}
          {m.zzzzTamper && <div style={{ fontSize: 11 }}>Tamper: <span style={{ color: m.zzzzTamper.intact ? C.gn : C.wn, fontWeight: 700 }}>{m.zzzzTamper.intact ? "INTACT" : "CLEARED"}</span></div>}
        </Card>)}
      </div>
    </div>}

    {/* DIFF TAB */}
    {tab === "diff" && <div>
      <STitle>Hex Diff</STitle>
      {modules.length < 2 ? <Card style={{ textAlign: "center", padding: 22, color: C.tm, fontSize: 12 }}>Load 2+ modules to compare.</Card> : <div>
        <Card style={{ padding: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <select value={safeDp[0]} onChange={e => setDp([+e.target.value, dp[1]])} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename}</option>)}</select>
            <span style={{ color: C.tm, fontSize: 16 }}>↔</span>
            <select value={safeDp[1]} onChange={e => setDp([dp[0], +e.target.value])} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename}</option>)}</select>
          </div>
        </Card>
        {diff && <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 12, color: C.wn, marginBottom: 10, fontWeight: 800 }}>{diff.totalChanged} bytes changed, {diff.groups.length} regions</div>
          <div style={{ background: C.c2, border: "1px solid " + C.bd, borderRadius: 10, padding: 12, maxHeight: 500, overflowY: "auto" }}>
            {diff.groups.slice(0, 50).map(([s, e], gi) => {
              const a = modules[safeDp[0]].data, b = modules[safeDp[1]].data;
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
                <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'" }}>{fO(s)}–{fO(e)} ({e-s+1}B)</div>
                {lines.map((l, li) => <div key={li} style={{ display: "flex", gap: 16, fontSize: 11, lineHeight: 1.6, fontFamily: "'JetBrains Mono'" }}>
                  <span style={{ color: C.a3, minWidth: 40 }}>{l.o.toString(16).toUpperCase().padStart(4,"0")}</span>
                  <span style={{ minWidth: 200 }}>{l.ha.map((h, hi) => <span key={hi} style={{ color: h.c ? C.er : C.tm, marginRight: 4, fontWeight: h.c ? 700 : 400 }}>{h.v}</span>)}</span>
                  <span style={{ color: C.tm }}>→</span>
                  <span>{l.hb.map((h, hi) => <span key={hi} style={{ color: h.c ? C.gn : C.tm, marginRight: 4, fontWeight: h.c ? 700 : 400 }}>{h.v}</span>)}</span>
                </div>)}
              </div>;
            })}
            {diff.groups.length > 50 && <div style={{ color: C.tm, fontSize: 11, marginTop: 6 }}>+{diff.groups.length - 50} more regions</div>}
          </div>
        </Card>}
      </div>}
    </div>}

    {/* TOOLS TAB */}
    {tab === "tools" && <div>
      <STitle>Module Programming Tools</STitle>
      {modules.length === 0 ? <Card style={{ textAlign: "center", padding: 22, color: C.tm, fontSize: 12 }}>Load a module first.</Card> : <div>
        <Card style={{ padding: 12, marginBottom: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: C.tm, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>Target:</label>
          <select value={safeTt} onChange={e => setTt(+e.target.value)} style={selSt}>{modules.map((m, i) => <option key={i} value={i}>{m.filename} ({inspectorName(m)})</option>)}</select>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          <Card style={{ padding: 16, borderTop: "3px solid " + C.gn }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: C.tx, marginBottom: 4 }}>VIN Writer</div>
            <div style={{ fontSize: 10, color: C.tm, marginBottom: 12 }}>Update VIN at all detected locations.</div>
            <input value={nv} onChange={e => setNv(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,"").slice(0,17))} placeholder="Enter 17-char VIN" maxLength={17} style={{ ...inpSt, marginBottom: 6, width: "100%", boxSizing: "border-box" }} />
            <div style={{ fontSize: 10, color: nv.length===17?C.gn:C.tm, marginBottom: 10, fontWeight: 700 }}>{nv.length}/17</div>
            <Btn onClick={() => doTool("writeVin")} disabled={nv.length!==17} color={C.gn} full>Write VIN</Btn>
          </Card>

          <Card style={{ padding: 16, borderTop: "3px solid " + C.sr }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: C.tx, marginBottom: 4 }}>SKIM Manager</div>
            <div style={{ fontSize: 10, color: C.tm, marginBottom: 12 }}>Toggle SKIM byte at 0x0011 (GPEC2A).</div>
            {modules[safeTt]?.type==="GPEC2A" ? <div>
              <div style={{ fontSize: 12, marginBottom: 10, fontFamily: "'JetBrains Mono'" }}>Current: <span style={{ color: modules[safeTt].skimByte===0x80?C.gn:C.er, fontWeight: 800 }}>0x{modules[safeTt].skimByte.toString(16).toUpperCase()}</span></div>
              <Btn onClick={() => doTool("skimToggle")} color={modules[safeTt].skimByte===0x80?C.wn:C.gn} full>{modules[safeTt].skimByte===0x80?"Disable SKIM":"Enable SKIM"}</Btn>
            </div> : <div style={{ fontSize: 11, color: C.tm }}>Select a GPEC2A module.</div>}
          </Card>

          <Card style={{ padding: 16, borderTop: "3px solid " + C.wn }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: C.tx, marginBottom: 4 }}>Virginize PCM</div>
            <div style={{ fontSize: 10, color: C.tm, marginBottom: 12 }}>Clear keys, SKIM, ZZZZ, transponder.</div>
            {modules[safeTt]?.type==="GPEC2A" ? <Btn onClick={() => doTool("virginize")} color={C.wn} full>Virginize</Btn> : <div style={{ fontSize: 11, color: C.tm }}>Select a GPEC2A module.</div>}
          </Card>

          <Card style={{ padding: 16, borderTop: "3px solid " + C.a4 }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: C.tx, marginBottom: 4 }}>Extract Secret Key</div>
            <div style={{ fontSize: 10, color: C.tm, marginBottom: 12 }}>Extract immobilizer sync key.</div>
            <Btn onClick={() => doTool("extractKey")} color={C.a4} full>Extract</Btn>
          </Card>
        </div>

        {tr && <Card style={{ padding: 16, marginTop: 14, border: "1.5px solid " + (tr.data ? C.gn : C.wn) }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: tr.data ? C.gn : C.wn, marginBottom: 8, letterSpacing: 0.5 }}>{tr.data ? "✓ Result" : "⚠ Result"}</div>
          <div style={{ fontSize: 12, color: C.tx, marginBottom: 10 }}>{tr.desc}</div>
          {tr.keyHex && <div style={{ background: C.c2, border: "1px solid " + C.bd, padding: 12, borderRadius: 8, fontSize: 14, fontWeight: 800, color: C.a4, letterSpacing: 1, marginBottom: 10, fontFamily: "'JetBrains Mono'", wordBreak: "break-all" }}>{tr.keyHex}</div>}
          {tr.log && tr.log.length > 0 && <div data-testid="inspector-vinwrite-log" style={{ background: "#1A1A1A", color: "#A0FFA0", padding: 10, borderRadius: 8, fontFamily: "'JetBrains Mono'", fontSize: 11, maxHeight: 200, overflowY: "auto", marginBottom: 10 }}>
            {tr.log.map((line, i) => <div key={i} style={{ padding: "1px 0" }}>{line}</div>)}
          </div>}
          {tr.data && <Btn onClick={dl} color={C.gn}>Download Modified .bin</Btn>}
        </Card>}
      </div>}
    </div>}

    {modules.length === 0 && <Card style={{ textAlign: "center", padding: "44px 20px", marginTop: 14 }}>
      <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.25 }}>🔐</div>
      <div style={{ fontSize: 14, color: C.ts, fontWeight: 800, marginBottom: 6 }}>Drop FCA module binary files to begin</div>
      <div style={{ fontSize: 11, color: C.tm }}>Auto-detects GPEC2A · RFHUB · BCM</div>
    </Card>}
  </div>;
}
