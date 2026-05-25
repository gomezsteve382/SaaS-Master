/* ============================================================================
 * FcaModuleInspector — rescued from attached_assets/tsetup-x64.6.7.5_1776900458954.exe
 *
 * The original drop was misnamed with a `.exe` suffix and silently stranded;
 * the file is actually a 33 KB React JSX component (UTF-8) implementing an
 * FCA module-binary inspector. It auto-detects GPEC2A / RFHUB / BCM dumps,
 * surfaces VINs / SKIM byte / cross-module validation results, and produces
 * a downloadable patched `.bin` for VIN/SKIM/virginize/key-extract.
 *
 * Task #496 rehomed the file under a clear name and wired it into the SRT
 * Lab tab registry. Task #502 re-skinned the UI to use the workspace-wide
 * design tokens (`C` from `../lib/constants.js`, `Card`/`Btn`/`Tag`/`SLine`
 * from `../lib/ui.jsx`).
 *
 * Task #517 replaced the inspector's local `writeVIN()` with
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
 *
 * Task #518 retired the inspector-local `useState([])` dump store in favor
 * of the workspace-wide MasterVinContext, and switched file loads to the
 * canonical `parseModule` (so the dump shape matches what every other tab
 * expects — size warnings, content warnings, RFHUB CRC verdicts, BCM
 * SEC16 resolution, etc).
 *
 * Task #519 added a `moduleTooSmall` size guard at file-drop time (the
 * same one Gpec2aTab / BcmTab use). Undersized fragments are pushed to a
 * local `rejects` list and rendered as a structured banner card instead
 * of being silently parsed as a real EEPROM (which previously surfaced
 * fake VIN/key output for partial captures).
 *
 * Task #530 finishes the parser migration: the legacy inspector-private
 * parser (`parseInspectorModule` plus its `MODULE_TYPES` / `SKIM_VALUES`
 * / `detectModuleType` / `scanForVINs` / `extractVIN` helpers) has been
 * deleted outright. There is now exactly one parser of record
 * (`../lib/parseModule.js`); the realDumps × parser coverage that used
 * to live next to the inspector now asserts against `parseModule`
 * directly in `src/lib/__tests__/parseModule.realDumps.test.js`.
 *
 * What remains in this file are the inspector's UI-side helpers that no
 * other tab consumes: `crossValidate` (cross-module verdict assembler),
 * `computeDiff` (hex-diff grouping), `inspectorWriteVin` (the
 * patchFile-backed VIN writer) and `virginize` (the GPEC2A wipe
 * transform). They run on the canonical `parseModule` output, so the
 * inspector tabs and every other tab agree on the same module shape
 * end-to-end.
 *
 * Task #526 — oversized captures (e.g. an 8 KB or 16 KB padded read for
 * a module whose canonical size is 4 KB / 64 KB, or the GPEC2A 8 KB
 * 95640 sibling fed into the wrong slot) are parsed by parseModule from
 * offset 0 and get a `sizeWarn` attached to the resulting module record
 * (see `buildSizeWarn` in parseModule.js). Every loaded module tile that
 * has a populated `sizeWarn` now renders the shared `SizeWarnBanner`
 * (the same component the GPEC2A / BCM tabs use) so techs see "padded
 * capture: only the first N bytes are the real image" and "re-dump with
 * the right read length" guidance instead of the file landing in the
 * workspace with a misleading "✓ parsed" appearance. */
import { useState, useCallback, useMemo, useRef, useContext } from "react";
import { C } from "../lib/constants.js";
import { Card, Btn, Tag, SLine } from "../lib/ui.jsx";
import { parseModule, moduleTooSmall, detectModuleType, MODULE_MIN_SIZES, MODULE_MIN_LABELS } from "../lib/parseModule.js";
import { MasterVinContext } from "../lib/masterVinContext.jsx";
import { analyzeFile, patchFile } from "../lib/fileUtils.js";
import { SizeWarnBanner, ContentWarnBanner } from "../components/ModuleFieldsPanel.jsx";
import { buildModuleReportData } from "../lib/reportData.js";
import { buildModulePDF } from "../lib/buildAnalysisPDF.js";
import { scanForKeys } from "../lib/keyScanner.js";
import { scanEepromLayout, ROLE_COLORS } from "../lib/eepromLayoutScan.js";

// Module types the inspector cares about. Other types loaded into the
// workspace (e.g. '95640' EEPROM backups, EFD payloads, C-Flash blobs)
// are intentionally excluded — the inspector's UI panels assume one of
// these three families.
// Task #634: XC2268_RFHUB (2019+ internal-flash RFHUB) and ZF_8HP_TCU (845RE
// / 8HP70 / 8HP90 transmission images) are first-class inspector families
// alongside the original three. Their parseModule branches surface VIN
// slots + CRC status the inspector panels already know how to render.
const INSPECTOR_TYPES = ["GPEC2A", "RFHUB", "BCM", "XC2268_RFHUB", "ZF_8HP_TCU"];

// Smallest canonical image any inspector-supported family expects (RFHUB
// Gen1 24C16 at 2 KB). Files smaller than this can't possibly be a real
// GPEC2A / RFHUB / BCM dump — they're slices, fragments, or accidental
// drops. Surfaced through the `inspector-too-small-card` rejection so the
// user sees WHY the file didn't load instead of the inspector silently
// swallowing the drop. The accompanying label tells the tech what the
// minimum-size dump (an RFHUB Gen1 EEPROM) actually is, so they can
// recognize the mismatch at a glance.
const INSPECTOR_MIN_SIZE = Math.min(
  ...INSPECTOR_TYPES.map((t) => MODULE_MIN_SIZES[t])
);
const INSPECTOR_MIN_LABEL =
  MODULE_MIN_LABELS[
    INSPECTOR_TYPES.reduce((acc, t) =>
      MODULE_MIN_SIZES[t] < MODULE_MIN_SIZES[acc] ? t : acc
    )
  ] || "smallest supported module";

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

// Byte-array equality used by `crossValidate` (RFHUB <-> BCM secret
// match check + GPEC2A secret-key consistency check). The legacy
// inspector parser used to reuse this for its own internal checks; now
// only the cross-module validator needs it.
function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  { id: "layout",   label: "Layout Map", icon: "🗺️" },
  { id: "diff",     label: "Hex Diff", icon: "🔀" },
  { id: "tools",    label: "Tools",    icon: "🛠️" },
];

const ROLE_LABELS = {
  vin:            'VIN',
  seed_key:       'SECRET',
  skim_pair:      'SKIM',
  pin:            'PIN',
  calibration_id: 'CAL-ID',
  dtc:            'DTC',
  immo:           'IMMO',
  boot:           'BOOT',
  flash_flag:     'FLAG',
  unknown:        '?',
};

function roleColor(role) {
  return ROLE_COLORS[role] || '#9E9E9E';
}

function LayoutHexViewer({ data, regions, maxRows = 64 }) {
  const [collapsed, setCollapsed] = useState(true);
  if (!data || data.length === 0) return null;

  const roleMap = new Map();
  for (const r of regions) {
    for (let i = r.offset; i < r.offset + r.length && i < data.length; i++) {
      if (!roleMap.has(i)) roleMap.set(i, r.role);
    }
  }

  const totalRows = Math.ceil(data.length / 16);
  const showRows = collapsed ? Math.min(maxRows, totalRows) : totalRows;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, textTransform: "uppercase" }}>
          Hex View ({data.length.toLocaleString()} bytes · {totalRows} rows)
        </div>
        {totalRows > maxRows && (
          <button onClick={() => setCollapsed(v => !v)} style={{
            background: C.c2, border: "1px solid " + C.bd, borderRadius: 6,
            padding: "2px 8px", fontSize: 10, color: C.ts, cursor: "pointer",
            fontFamily: "'Nunito'", fontWeight: 700,
          }}>{collapsed ? `Show all ${totalRows} rows` : "Collapse"}</button>
        )}
      </div>
      <div style={{ background: "#111", borderRadius: 8, padding: "10px 12px", overflowX: "auto", maxHeight: collapsed ? 340 : 600, overflowY: "auto", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, lineHeight: 1.7 }}>
        {Array.from({ length: showRows }, (_, row) => {
          const base = row * 16;
          const bytes = [];
          for (let j = 0; j < 16; j++) {
            const idx = base + j;
            if (idx >= data.length) break;
            bytes.push({ idx, val: data[idx], role: roleMap.get(idx) || null });
          }
          return (
            <div key={row} style={{ display: "flex", gap: 12 }}>
              <span style={{ color: "#4A90D9", minWidth: 44, flexShrink: 0 }}>
                {base.toString(16).toUpperCase().padStart(4, '0')}
              </span>
              <span style={{ minWidth: 340, flexShrink: 0 }}>
                {bytes.map(({ idx, val, role }) => (
                  <span key={idx} style={{
                    color: role ? roleColor(role) : '#666',
                    fontWeight: role ? 700 : 400,
                    marginRight: (idx % 4 === 3) ? 6 : 3,
                  }}>
                    {val.toString(16).toUpperCase().padStart(2, '0')}
                  </span>
                ))}
              </span>
              <span style={{ color: "#555" }}>
                {bytes.map(({ idx, val, role }) => (
                  <span key={idx} style={{ color: role ? roleColor(role) : '#444', fontWeight: role ? 600 : 400 }}>
                    {val >= 0x20 && val < 0x7F ? String.fromCharCode(val) : '.'}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
        {collapsed && totalRows > maxRows && (
          <div style={{ color: "#555", fontSize: 10, paddingTop: 6 }}>
            … {(totalRows - maxRows) * 16} more bytes hidden — click &quot;Show all&quot; to expand
          </div>
        )}
      </div>
    </div>
  );
}

function LayoutRegionList({ regions }) {
  const [openRoles, setOpenRoles] = useState(() => new Set(['vin', 'seed_key', 'immo', 'flash_flag']));

  const byRole = useMemo(() => {
    const map = new Map();
    for (const r of regions) {
      if (!map.has(r.role)) map.set(r.role, []);
      map.get(r.role).push(r);
    }
    return map;
  }, [regions]);

  if (regions.length === 0) {
    return <div style={{ fontSize: 12, color: C.tm, padding: 14 }}>No regions identified for this module.</div>;
  }

  const toggleRole = role => {
    setOpenRoles(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  };

  return (
    <div>
      {Array.from(byRole.entries()).map(([role, rlist]) => {
        const color = roleColor(role);
        const open = openRoles.has(role);
        return (
          <div key={role} style={{ marginBottom: 6 }}>
            <button onClick={() => toggleRole(role)} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              background: C.c2, border: "1px solid " + C.bd, borderLeft: "3px solid " + color,
              borderRadius: 8, padding: "6px 12px", cursor: "pointer", textAlign: "left",
            }}>
              <span style={{ fontSize: 9, fontWeight: 800, color, letterSpacing: 1, textTransform: "uppercase", minWidth: 52, background: color + "22", padding: "2px 6px", borderRadius: 4 }}>
                {ROLE_LABELS[role] || role}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.ts, flex: 1 }}>
                {rlist.length} region{rlist.length !== 1 ? 's' : ''}
              </span>
              <span style={{ fontSize: 10, color: C.tm }}>{open ? '▲' : '▼'}</span>
            </button>
            {open && (
              <div style={{ background: C.cd, border: "1px solid " + C.bd, borderTop: "none", borderRadius: "0 0 8px 8px", padding: "0 4px 4px" }}>
                {rlist.map((r, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 10px",
                    borderBottom: i < rlist.length - 1 ? "1px solid " + C.bd : "none",
                  }}>
                    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.a3, minWidth: 80, flexShrink: 0 }}>
                      {`0x${r.offset.toString(16).toUpperCase().padStart(4, '0')}`}
                    </span>
                    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tm, minWidth: 52, flexShrink: 0 }}>
                      {r.length.toLocaleString()}B
                    </span>
                    <span style={{ fontSize: 11, color: C.ts, flex: 1, lineHeight: 1.4 }}>{r.label}</span>
                    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: color, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.preview}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { inspectorWriteVin };

// ── Secrets & Crypto panel ─────────────────────────────────────────────────

const SCAN_GROUP_COLORS = {
  pem: "#D32F2F",
  ssh: "#1976D2",
  jwt: "#E65100",
  apikey: "#C62828",
  entropy: "#6A0DAD",
  "crypto-const": "#2E7D32",
};
const SCAN_GROUP_LABELS = {
  pem: "PEM",
  ssh: "SSH",
  jwt: "JWT",
  apikey: "API KEY",
  entropy: "ENTROPY",
  "crypto-const": "CRYPTO",
};
const SCAN_SEV_COLORS = {
  high: "#D32F2F",
  medium: "#E65100",
  low: "#777",
};

function SecretsCryptoPanel({ findings, modIdx, isOpen, onToggle, onJumpToHex }) {
  const [copied, setCopied] = useState(null);

  function copyOffset(id, offsetHex) {
    navigator.clipboard?.writeText(offsetHex).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(c => c === id ? null : c), 1500);
  }

  const count = findings.length;
  const highCount = findings.filter(f => f.severity === "high").length;

  return (
    <div style={{ marginTop: 10 }} data-testid="secrets-crypto-panel">
      {/* Collapsible header */}
      <button
        onClick={onToggle}
        style={{
          width: "100%", textAlign: "left", cursor: "pointer",
          background: C.c2, border: "1.5px solid " + C.bd,
          borderRadius: isOpen ? "10px 10px 0 0" : 10,
          padding: "10px 14px", display: "flex", alignItems: "center",
          gap: 10, fontFamily: "'Nunito',sans-serif",
        }}
      >
        <span style={{ fontSize: 14 }}>🔑</span>
        <span style={{ fontWeight: 900, fontSize: 12, color: C.tx, letterSpacing: 0.5, textTransform: "uppercase" }}>
          Secrets &amp; Crypto
        </span>
        {count > 0 && (
          <span style={{
            background: highCount > 0 ? SCAN_SEV_COLORS.high : SCAN_SEV_COLORS.medium,
            color: "#fff", borderRadius: 6, padding: "1px 8px",
            fontSize: 11, fontWeight: 800,
          }}>
            {count} finding{count !== 1 ? "s" : ""}{highCount > 0 ? " · " + highCount + " HIGH" : ""}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: C.tm, fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div style={{
          border: "1.5px solid " + C.bd, borderTop: "none",
          borderRadius: "0 0 10px 10px",
          background: C.cd, padding: 12,
        }}>
          {count === 0 ? (
            <div style={{ fontSize: 12, color: C.tm, textAlign: "center", padding: "12px 0", fontStyle: "italic" }}>
              No embedded keys or known crypto constants detected.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Group</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Label</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Offset</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Size</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Sev</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Preview</th>
                    <th style={{ textAlign: "left", color: C.tm, fontWeight: 800, padding: "6px 8px", borderBottom: "1px solid " + C.bd, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map(f => {
                    const offsetHex = "0x" + f.offset.toString(16).toUpperCase().padStart(6, "0");
                    const groupColor = SCAN_GROUP_COLORS[f.group] || C.tm;
                    const sevColor = SCAN_SEV_COLORS[f.severity] || C.tm;
                    return (
                      <tr key={f.id} style={{ borderBottom: "1px solid " + C.bd }}>
                        <td style={{ padding: "5px 8px" }}>
                          <span style={{
                            background: groupColor + "22", color: groupColor,
                            borderRadius: 4, padding: "1px 6px",
                            fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                            fontFamily: "'Nunito',sans-serif",
                          }}>
                            {SCAN_GROUP_LABELS[f.group] || f.group}
                          </span>
                        </td>
                        <td style={{ padding: "5px 8px", color: C.tx, fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.label}
                        </td>
                        <td style={{ padding: "5px 8px", fontFamily: "'JetBrains Mono',monospace", color: C.a3, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {offsetHex}
                        </td>
                        <td style={{ padding: "5px 8px", color: C.tm, fontFamily: "'JetBrains Mono',monospace" }}>
                          {f.size}
                        </td>
                        <td style={{ padding: "5px 8px" }}>
                          <span style={{ color: sevColor, fontWeight: 800, fontSize: 10, textTransform: "uppercase" }}>
                            {f.severity}
                          </span>
                        </td>
                        <td style={{ padding: "5px 8px", fontFamily: "'JetBrains Mono',monospace", color: C.ts, fontSize: 10, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.preview}
                        </td>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                          <button
                            onClick={() => copyOffset(f.id, offsetHex)}
                            title="Copy offset to clipboard"
                            style={{
                              background: "none", border: "1px solid " + C.bd,
                              borderRadius: 5, cursor: "pointer", color: copied === f.id ? C.gn : C.ts,
                              fontSize: 10, padding: "2px 7px", fontFamily: "'Nunito',sans-serif",
                              fontWeight: 700, marginRight: 4,
                            }}
                          >
                            {copied === f.id ? "✓ Copied" : "Copy offset"}
                          </button>
                          <button
                            onClick={() => onJumpToHex(modIdx, f.offset)}
                            title={"Go to 0x" + f.offset.toString(16).toUpperCase().padStart(6, "0") + " in Hex Diff view"}
                            style={{
                              background: "none", border: "1px solid " + C.bd,
                              borderRadius: 5, cursor: "pointer", color: C.a3,
                              fontSize: 10, padding: "2px 7px", fontFamily: "'Nunito',sans-serif",
                              fontWeight: 700,
                            }}
                          >
                            Jump to hex
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FcaModuleInspector() {
  const { loadedDumps, addDump, removeDump } = useContext(MasterVinContext);
  const [tab, setTab] = useState("overview");
  const [dp, setDp] = useState([0, 1]);
  const [nv, setNv] = useState("");
  const [tt, setTt] = useState(0);
  const [tr, setTr] = useState(null);
  const [loadMsg, setLoadMsg] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfToast, setPdfToast] = useState("");
  // Task #543 — undersized fragment rejections. parseModule classifies a
  // sub-2 KB drop as UNKNOWN (no canonical family fits), so the per-type
  // `moduleTooSmall` guard in `onFiles` returns null and the file used to
  // fall through to the generic `loadMsg` skip line. That hid WHY nothing
  // appeared in the inspector — particularly bad for 1 KB fragments,
  // since the pre-#519 detector silently labeled those as RFHUB and
  // surfaced fake VIN / FOBIK output. Tracking these in their own list
  // lets us render a structured `inspector-too-small-card` per drop with
  // the file name, actual byte count, and required minimum, matching the
  // warm/orange visual language of the size-warn / content-warn lists.
  const [tooSmallRejects, setTooSmallRejects] = useState([]);
  // "Secrets & Crypto" panel — track which module indices have the panel open.
  // Collapsed by default so large-binary scans don't block the first render;
  // results are memoized per module data so toggling open is instant once
  // the first scan has run.
  const [scanOpen, setScanOpen] = useState(() => new Set());
  // Hex-viewer focus from "Jump to hex" in the Secrets & Crypto panel.
  // hexFocusOffset: byte offset to navigate to; hexFocusMod: module index
  // that owns the finding. Cleared when the user switches away from the
  // Hex Diff tab or loads/removes modules.
  const [hexFocusOffset, setHexFocusOffset] = useState(null);
  const [hexFocusMod, setHexFocusMod] = useState(0);
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

  // Run keyScanner over each module's data bytes. Results are stable as long
  // as the underlying Uint8Array reference doesn't change — memoized on the
  // module array so a tab switch or unrelated state update can't re-trigger
  // the scan. For BCM (64 KB) this takes ~2–5 ms; for GPEC2A (4 KB) < 1 ms.
  const scanResults = useMemo(
    () =>
      modules.map((m) => {
        if (!m || !m.data) return [];
        try {
          return scanForKeys(m.data);
        } catch {
          return [];
        }
      }),
    [modules]
  );

  const onFiles = useCallback(
    (e) => {
      const files = Array.from(e.target.files);
      e.target.value = "";
      if (files.length === 0) return;
      const skipped = [];
      const tooSmall = [];
      let pending = files.length;
      files.forEach((f) => {
        const r = new FileReader();
        r.onload = (ev) => {
          const bytes = new Uint8Array(ev.target.result);
          // Task #543 — refuse anything below the smallest inspector-supported
          // module size before parseModule even gets to classify it. A sub-2 KB
          // buffer can't be a real GPEC2A / RFHUB / BCM dump, and parseModule
          // would type it as UNKNOWN (so the per-type `moduleTooSmall` guard
          // below would no-op). Surface the rejection in its own structured
          // card instead of letting the file vanish into the generic skip line.
          if (bytes.length < INSPECTOR_MIN_SIZE) {
            tooSmall.push({
              filename: f.name,
              size: bytes.length,
              min: INSPECTOR_MIN_SIZE,
              label: INSPECTOR_MIN_LABEL,
            });
            pending -= 1;
            if (pending === 0) {
              setLoadMsg(
                skipped.length
                  ? "Skipped " + skipped.length + " file(s): only valid GPEC2A / RFHUB / BCM dumps load into the inspector — " + skipped.join(", ")
                  : ""
              );
              if (tooSmall.length) {
                setTooSmallRejects((prev) => [...prev, ...tooSmall]);
              }
            }
            return;
          }
          const m = parseModule(bytes, f.name);
          const small = m?.type ? moduleTooSmall(bytes, m.type, f.name) : null;

          if (!m || !m.type || !INSPECTOR_TYPES.includes(m.type)) {
            skipped.push(f.name + " (" + (m?.type || "UNKNOWN") + ")");
          } else if (small) {
            skipped.push(f.name + " (TOO SMALL: " + small.expected + ")");
          } else {
            addDump(m, "Inspector");
          }
          pending -= 1;
          if (pending === 0) {
            setLoadMsg(
              skipped.length
                ? "Skipped " + skipped.length + " file(s): only valid GPEC2A / RFHUB / BCM dumps load into the inspector — " + skipped.join(", ")
                : ""
            );
            if (tooSmall.length) {
              setTooSmallRejects((prev) => [...prev, ...tooSmall]);
            }
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
    setTooSmallRejects([]);
  }, [entries, removeDump]);
  // Per-card dismissal for the too-small rejection list, so a tech who
  // has read the warning can clear it without dropping the rest of the
  // workspace state.
  const dismissTooSmall = useCallback((idx) => {
    setTooSmallRejects((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleExportPDF = useCallback(async (idx) => {
    const mod = modules[idx];
    const entry = entries[idx];
    if (!mod) return;
    setPdfBusy(true);
    setPdfToast("");
    try {
      const reportData = buildModuleReportData(mod, entry);
      await buildModulePDF(reportData);
      setPdfToast(`PDF downloaded: ${reportData.filename}`);
    } catch (e) {
      setPdfToast("PDF export failed: " + (e.message || String(e)));
    } finally {
      setPdfBusy(false);
    }
  }, [modules, entries]);

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

    {/* Task #543 — undersized fragment rejection cards. Files smaller than
        the smallest inspector-supported family (RFHUB Gen1 24C16 at 2 KB)
        can't be a real dump — historically they fell through to the
        generic skip line and the inspector silently swallowed them. Each
        rejected fragment renders its own card with the file name, the
        actual byte count, and the required minimum so techs immediately
        see WHY the drop didn't load. The card uses the same warm/orange
        palette (C.wn) as the size-warn / content-warn banners so it
        visually clusters with the other inspector warnings. */}
    {tooSmallRejects.length > 0 && <div data-testid="inspector-too-small-list" style={{ marginBottom: 18 }}>
      {tooSmallRejects.map((rej, i) => (
        <Card key={"ts-" + i} data-testid="inspector-too-small-card" style={{
          marginBottom: 12, padding: 14,
          border: "1px solid " + C.wn + "66",
          background: C.wn + "14",
          position: "relative",
        }}>
          <button onClick={() => dismissTooSmall(i)} aria-label="Dismiss too-small rejection" style={{
            position: "absolute", top: 8, right: 10, background: "none", border: "none",
            color: C.tm, cursor: "pointer", fontSize: 16, lineHeight: 1, fontWeight: 700,
          }}>×</button>
          <div style={{ fontWeight: 800, fontSize: 12, color: C.wn, marginBottom: 6, letterSpacing: 0.5 }}>
            ⚠ TOO SMALL — <span style={{ fontFamily: "'JetBrains Mono'" }}>{rej.filename}</span> isn&apos;t a full module dump
          </div>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, lineHeight: 1.7 }}>
            <div>File size: <strong style={{ color: C.wn }}>{rej.size.toLocaleString()} bytes</strong></div>
            <div>Required min: <strong>{rej.min.toLocaleString()} bytes ({rej.label})</strong></div>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: C.tx, lineHeight: 1.5 }}>
            Re-read the module in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong capture. The Module Inspector only accepts full GPEC2A / RFHUB / BCM dumps.
          </div>
        </Card>
      ))}
    </div>}

    {/* Task #526 — oversized / non-canonical capture warnings. parseModule
        attaches a `sizeWarn` to every module whose buffer length doesn't
        match a canonical size for its family (e.g. an 8 KB / 16 KB padded
        BCM read, an 8 KB padded RFHUB, a 16 KB padded GPEC2A). The
        SizeWarnBanner is the same component the GPEC2A / BCM tabs use,
        but those tabs only see one or two files at a time — the inspector
        can hold many, so each banner is prefixed with the originating
        filename / module type so the user can tell which capture is the
        oversized one. The module is still parsed and shown below; the
        banner just makes the non-standard size impossible to miss. */}
    {modules.some(m => m && m.sizeWarn) && <div data-testid="inspector-size-warn-list" style={{ marginBottom: 18 }}>
      {modules.map((m, i) => m && m.sizeWarn ? <div key={"sw"+i} data-testid="inspector-size-warn">
        <div style={{ fontSize: 11, fontWeight: 800, color: C.tm, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4, fontFamily: "'JetBrains Mono'" }}>
          {inspectorName(m)} · <span style={{ color: C.ts }}>{m.filename}</span>
        </div>
        <SizeWarnBanner warn={m.sizeWarn} />
      </div> : null)}
    </div>}

    {/* Loaded module chips */}
    {modules.length > 0 && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
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
        {/* Provenance chip — Task #531. Tells the user where this dump
            was first dropped, so files auto-shared from other tabs
            (Dumps, Samples, GPEC2A / RFHUB / BCM) don't look mysterious. */}
        {entries[i]?.source && <div data-testid={`inspector-source-chip-${i}`} style={{
          display: "inline-block", marginBottom: 8,
          fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 6,
          background: C.c2, color: C.ts, border: "1px solid " + C.bd,
          letterSpacing: 0.5, textTransform: "uppercase",
        }}>Loaded from {entries[i].source}</div>}
        {m.vins?.[0] && <div style={{ fontSize: 11, color: C.a1, fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>VIN: {m.vins[0].vin}</div>}
        {m.skimStatus && <div style={{ fontSize: 11, color: m.skimByte === 0x80 ? C.gn : C.er, fontWeight: 700, marginTop: 2 }}>SKIM: {m.skimStatus}</div>}
        {m.vehicleSecret && <div style={{ fontSize: 10, color: C.a4, fontFamily: "'JetBrains Mono'", marginTop: 2 }}>Secret: {m.vehicleSecret.hex.slice(0, 23)}…</div>}
        {m.securityLock && <div style={{ fontSize: 11, color: m.securityLock.locked ? C.gn : C.wn, fontWeight: 700, marginTop: 2 }}>{m.securityLock.locked ? "LOCKED" : "UNLOCKED"}</div>}
        <div style={{ marginTop: 10 }}>
          <Btn
            color={C.sr}
            outline
            onClick={() => handleExportPDF(i)}
            disabled={pdfBusy}
            data-testid={`inspector-export-pdf-${i}`}
            style={{ fontSize: 10, padding: "6px 12px" }}
          >
            {pdfBusy ? "⏳ Generating…" : "⬇ Export PDF Report"}
          </Btn>
        </div>
      </div>)}
      <button onClick={clr} style={{
        background: C.cd, border: "1.5px dashed " + C.bd, borderRadius: 12,
        padding: 12, color: C.ts, cursor: "pointer", fontSize: 11, fontWeight: 800,
        flex: "0 0 100px", display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Nunito'", letterSpacing: 0.5,
      }}>Clear All</button>
    </div>}

    {/* PDF export feedback toast */}
    {pdfToast && <div style={{
      marginBottom: 14,
      padding: "7px 14px",
      background: pdfToast.startsWith("PDF export failed") ? C.er + "12" : C.gn + "12",
      border: `1px solid ${pdfToast.startsWith("PDF export failed") ? C.er : C.gn}33`,
      borderRadius: 8,
      color: pdfToast.startsWith("PDF export failed") ? C.er : C.gn,
      fontSize: 12,
      fontWeight: 700,
    }}>{pdfToast}</div>}

    {/* Task #527 / Task #538 — content-warn banner for size-only auto-detects.
        parseModule() classifies any 64 KB / 128 KB capture as BCM purely
        on size. If the file has no BCM-defining content (no VINs at the
        canonical 0x5320..0x5380 slots, no immo records at 0x40C0 / 0x2000,
        no partial VINs at 0x4098 / 0x40B0) it populates `mod.contentWarn`
        — i.e. the file is almost certainly a padded GPEC2A / 95640 capture
        that collided with the BCM size, not a real BCM dump. The Module
        Inspector has no slot context (it accepts any `.bin`) so it can't
        use `wrongModuleForSlot`, but it shares the same failure mode:
        without this banner the BCM panel would silently render garbage
        VIN / IMMO / lock fields off random padding bytes. Surfacing the
        same `ContentWarnBanner` the BCM tab uses tells the tech "this
        64 KB file has no BCM VINs / immo records — it may not actually
        be a BCM dump" before they trust any of the per-module output.

        Task #538 — each banner is prefixed with the module-type / filename
        header used by the size-warn list above, so when multiple modules
        are loaded in the inspector the user can tell which capture
        triggered the warning at a glance (the size-warn list and the
        content-warn list both use the same `inspectorName(m) · filename`
        header for visual symmetry). */}
    {modules.some(m => m && m.contentWarn) && <div data-testid="inspector-content-warn-list" style={{ marginBottom: 18 }}>
      {modules.map((m, i) => m && m.contentWarn ? (
        <div key={"cw-" + i} data-testid="inspector-content-warn">
          <div style={{ fontSize: 11, fontWeight: 800, color: C.tm, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4, fontFamily: "'JetBrains Mono'" }}>
            {inspectorName(m)} · <span style={{ color: C.ts }}>{m.filename}</span>
          </div>
          <ContentWarnBanner warn={m.contentWarn} />
        </div>
      ) : null)}
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

        {/* Secrets & Crypto panel — collapsible, collapsed by default */}
        <SecretsCryptoPanel
          findings={scanResults[i] || []}
          modIdx={i}
          isOpen={scanOpen.has(i)}
          onToggle={() => setScanOpen(prev => {
            const next = new Set(prev);
            if (next.has(i)) next.delete(i); else next.add(i);
            return next;
          })}
          onJumpToHex={(modIdx, offset) => {
            setHexFocusMod(modIdx);
            setHexFocusOffset(offset);
            setTab("diff");
          }}
        />
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

    {/* LAYOUT MAP TAB */}
    {tab === "layout" && <div>
      <STitle>Layout Map</STitle>
      {modules.length === 0
        ? <Card style={{ textAlign: "center", padding: 22, color: C.tm, fontSize: 12 }}>Load a module to see its region map.</Card>
        : modules.map((m, i) => {
            const layout = scanEepromLayout(m.data, m.filename);
            return (
              <div key={i} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 900, color: m.color, marginBottom: 4 }}>
                  {inspectorName(m)}
                  <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 500, color: C.ts, marginLeft: 10 }}>{m.filename} · {m.size.toLocaleString()}B</span>
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 5, background: layout.confidence === 'high' ? C.gn + '22' : layout.confidence === 'medium' ? C.wn + '22' : C.tm + '22', color: layout.confidence === 'high' ? C.gn : layout.confidence === 'medium' ? C.wn : C.tm }}>
                    {layout.confidence.toUpperCase()} confidence
                  </span>
                </div>
                {/* Role legend */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {Array.from(new Set(layout.regions.map(r => r.role))).map(role => (
                    <span key={role} style={{
                      fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 5,
                      background: roleColor(role) + "22", color: roleColor(role),
                      border: "1px solid " + roleColor(role) + "44", letterSpacing: 0.5,
                    }}>{ROLE_LABELS[role] || role}</span>
                  ))}
                </div>
                <Card style={{ padding: 10 }}>
                  <LayoutRegionList regions={layout.regions} />
                  <LayoutHexViewer data={m.data} regions={layout.regions} />
                </Card>
              </div>
            );
          })
      }
    </div>}

    {/* DIFF TAB */}
    {tab === "diff" && <div>
      <STitle>Hex Diff</STitle>

      {/* Hex-at-offset panel — rendered whenever the user clicked "Jump to hex"
          from the Secrets & Crypto panel. Works with any number of loaded
          modules (including just one). Shows 8 rows × 16 bytes centred on the
          target offset with the finding's bytes highlighted. */}
      {hexFocusOffset !== null && modules[hexFocusMod] && (() => {
        const m = modules[hexFocusMod];
        const data = m.data;
        if (!data) return null;
        const rowSize = 16;
        const contextRows = 4; // rows before + after the target row
        const targetRow = (hexFocusOffset >> 4) << 4; // round down to row boundary
        const startOff = Math.max(0, targetRow - contextRows * rowSize);
        const endOff = Math.min(data.length, targetRow + (contextRows + 1) * rowSize);
        const rows = [];
        for (let o = startOff; o < endOff; o += rowSize) {
          const cells = [];
          for (let j = 0; j < rowSize && o + j < data.length; j++) {
            const idx = o + j;
            const inFinding = idx >= hexFocusOffset;
            cells.push({ v: data[idx].toString(16).padStart(2, "0").toUpperCase(), inFinding });
          }
          rows.push({ o, cells, isTarget: o === targetRow });
        }
        return (
          <Card style={{ padding: 14, marginBottom: 14, borderLeft: "3px solid " + C.a3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 900, color: C.a3, textTransform: "uppercase", letterSpacing: 1 }}>
                Navigate to offset
              </span>
              <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 12, fontWeight: 700, color: C.tx }}>
                {"0x" + hexFocusOffset.toString(16).toUpperCase().padStart(6, "0")}
              </span>
              <span style={{ fontSize: 11, color: C.tm }}>
                in <strong style={{ color: m.color }}>{inspectorName(m)}</strong> · {m.filename}
              </span>
              <button
                onClick={() => setHexFocusOffset(null)}
                style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: C.tm, fontSize: 14, fontWeight: 700 }}
              >×</button>
            </div>
            <div style={{ background: C.c2, border: "1px solid " + C.bd, borderRadius: 8, padding: 10, fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>
              {rows.map((row) => (
                <div key={row.o} style={{ display: "flex", gap: 12, lineHeight: 1.7, background: row.isTarget ? C.cd : "transparent", borderRadius: 4 }}>
                  <span style={{ color: row.isTarget ? C.a3 : C.tm, minWidth: 48, fontWeight: row.isTarget ? 800 : 400 }}>
                    {row.o.toString(16).toUpperCase().padStart(6, "0")}
                  </span>
                  <span>
                    {row.cells.map((cell, ci) => (
                      <span
                        key={ci}
                        style={{
                          marginRight: ci % 8 === 7 ? 10 : 4,
                          color: cell.inFinding && row.isTarget ? C.a3 : C.ts,
                          fontWeight: cell.inFinding && row.isTarget ? 800 : 400,
                          background: cell.inFinding && row.isTarget ? C.a3 + "22" : "transparent",
                          borderRadius: 2, padding: "0 1px",
                        }}
                      >
                        {cell.v}
                      </span>
                    ))}
                  </span>
                  <span style={{ color: C.tm, fontSize: 10 }}>
                    {row.cells.map(c => {
                      const code = parseInt(c.v, 16);
                      return code >= 0x20 && code < 0x7F ? String.fromCharCode(code) : ".";
                    }).join("")}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

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
