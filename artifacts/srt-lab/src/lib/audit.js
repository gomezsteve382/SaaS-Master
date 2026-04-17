// Module backup + session paper-trail services backed by localStorage.
// Ported from the reference App.jsx (`backupModule`, `restoreModule`,
// `logSession`, `getSessions`, `generateSessionReport`, etc.).

const BACKUP_INDEX_KEY = "srtlab_backup_index";
const SESSION_KEY = "srtlab_sessions";
const MAX_BACKUPS = 50;
const MAX_SESSIONS = 500;

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

/* Critical DIDs per module — what we back up before writing anything. */
export const CRITICAL_DIDS = {
  BCM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF191, name: "Hardware Version" },
    { did: 0xF18C, name: "Serial Number" },
    { did: 0xF1A0, name: "BCM Config", critical: true },
    { did: 0xF1A1, name: "BCM Feature Bytes", critical: true },
    { did: 0xF1D0, name: "Key Fob Data" },
    { did: 0xF1D1, name: "SKIM Data", critical: true },
    { did: 0x7B90, name: "Current VIN", critical: true },
    { did: 0x7B88, name: "Original VIN", critical: true },
  ],
  RFHUB: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF18C, name: "PIN / Serial", critical: true },
    { did: 0xF1E0, name: "Tire Sensors" },
    { did: 0xF1E1, name: "Secret Key", critical: true },
  ],
  ECM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF191, name: "Hardware Version" },
    { did: 0xF18C, name: "Serial Number" },
    { did: 0xF194, name: "Software Fingerprint" },
    { did: 0xF195, name: "Calibration ID" },
    { did: 0xF40D, name: "Odometer", critical: true },
    { did: 0xF1C1, name: "Engine Hours" },
    { did: 0xF1C0, name: "Calibration Data", critical: true },
  ],
  ADCM: [
    { did: 0xF190, name: "VIN", critical: true },
    { did: 0xF187, name: "Part Number" },
    { did: 0xF189, name: "Software Version" },
    { did: 0xF1A1, name: "Suspension Mode" },
    { did: 0xDE10, name: "Vehicle Config" },
    { did: 0xDE11, name: "Variant Code" },
    { did: 0x7B90, name: "Current VIN", critical: true },
    { did: 0x7B88, name: "Original VIN", critical: true },
  ],
};

function notify() {
  try {
    window.dispatchEvent(new Event("srtlab:audit"));
  } catch {}
}

/* ─── BACKUPS ─── */

export async function backupModule(engUds, tx, rx, moduleType, addLog = () => {}) {
  const dids = CRITICAL_DIDS[moduleType];
  if (!dids) {
    addLog("No backup profile for " + moduleType, "warn");
    return null;
  }
  addLog("═══ CREATING MODULE BACKUP: " + moduleType + " ═══", "info");
  addLog("Reading " + dids.length + " critical DIDs before any writes...", "info");
  await engUds(tx, rx, [0x10, 0x03]);
  const backup = {
    module: moduleType,
    tx, rx,
    timestamp: new Date().toISOString(),
    dids: {},
  };
  let successCount = 0;
  for (const d of dids) {
    const r = await engUds(tx, rx, [0x22, (d.did >> 8) & 0xFF, d.did & 0xFF]);
    if (r && r.ok && r.d && r.d[0] === 0x62) {
      const raw = Array.from(r.d).slice(3);
      const hex = raw.map(b => hx(b)).join("");
      const ascii = raw.filter(b => b >= 0x20 && b <= 0x7E).map(b => String.fromCharCode(b)).join("");
      backup.dids[d.did] = {
        name: d.name, critical: !!d.critical, hex,
        ascii: ascii.length >= 3 ? ascii : "", bytes: raw,
      };
      addLog("  0x" + hx(d.did, 4) + " (" + d.name + "): " + hex, "rx");
      successCount++;
    } else {
      backup.dids[d.did] = { name: d.name, critical: !!d.critical, hex: "", bytes: [], missing: true };
      addLog("  0x" + hx(d.did, 4) + " (" + d.name + "): not readable", "warn");
    }
  }
  addLog("Backup complete: " + successCount + "/" + dids.length + " DIDs captured", "info");
  const vin = backup.dids[0xF190]?.ascii?.slice(-17) || "unknown";
  const key = "srtlab_backup_" + moduleType + "_" + vin + "_" + Date.now();
  try {
    localStorage.setItem(key, JSON.stringify(backup));
    const idx = JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]");
    idx.unshift({ key, module: moduleType, vin, timestamp: backup.timestamp, didCount: successCount });
    if (idx.length > MAX_BACKUPS) {
      idx.slice(MAX_BACKUPS).forEach(b => localStorage.removeItem(b.key));
    }
    localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(idx.slice(0, MAX_BACKUPS)));
    addLog("✓ Backup saved: " + key, "info");
    notify();
  } catch (e) {
    addLog("Failed to save backup: " + e.message, "error");
  }
  return backup;
}

export async function restoreModule(engUds, tx, rx, backup, addLog = () => {}, fullRestore = false) {
  if (!backup || !backup.dids) {
    addLog("Invalid backup data", "error");
    return false;
  }
  addLog("═══ RESTORING MODULE: " + backup.module + " ═══", "info");
  addLog("Backup timestamp: " + backup.timestamp, "info");
  let restoredCount = 0, failedCount = 0;
  for (const [didStr, data] of Object.entries(backup.dids)) {
    const did = parseInt(didStr, 10);
    if (!data.bytes || data.bytes.length === 0) continue;
    if (!fullRestore && !data.critical) continue;
    addLog("Restoring 0x" + hx(did, 4) + " (" + data.name + ")...", "info");
    const r = await engUds(tx, rx, [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...data.bytes]);
    if (r && r.ok && r.d && r.d[0] === 0x6E) {
      addLog("  ✓ Restored", "rx");
      restoredCount++;
    } else {
      addLog("  Failed: 0x" + hx(did, 4), "error");
      failedCount++;
    }
    await new Promise(res => setTimeout(res, 200));
  }
  addLog("Restore: " + restoredCount + " success, " + failedCount + " failed", "info");
  return failedCount === 0;
}

export function getBackupList(moduleType) {
  try {
    const idx = JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]");
    return moduleType ? idx.filter(b => b.module === moduleType) : idx;
  } catch { return []; }
}

export function getBackup(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch { return null; }
}

export function deleteBackup(key) {
  try {
    localStorage.removeItem(key);
    const idx = JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]");
    localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(idx.filter(b => b.key !== key)));
    notify();
  } catch {}
}

export function clearBackups() {
  try {
    const idx = JSON.parse(localStorage.getItem(BACKUP_INDEX_KEY) || "[]");
    idx.forEach(b => localStorage.removeItem(b.key));
    localStorage.removeItem(BACKUP_INDEX_KEY);
    notify();
  } catch {}
}

/* ─── SESSIONS ─── */

export function logSession(entry) {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    const record = {
      id: "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    sessions.unshift(record);
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    notify();
    return record;
  } catch (e) {
    console.error("Session log failed:", e);
    return null;
  }
}

export function getSessions(filter) {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    if (!filter) return s;
    return s.filter(x =>
      (!filter.module || x.module === filter.module) &&
      (!filter.vin || x.newVin === filter.vin || x.oldVin === filter.vin)
    );
  } catch { return []; }
}

export function deleteSession(id) {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    localStorage.setItem(SESSION_KEY, JSON.stringify(s.filter(x => x.id !== id)));
    notify();
  } catch {}
}

export function clearSessions() {
  try {
    localStorage.removeItem(SESSION_KEY);
    notify();
  } catch {}
}

/* CSV export — flat columns chosen for shop-friendly auditing. */
export function sessionsToCSV(sessions) {
  const cols = [
    "id", "timestamp", "module", "operation", "success",
    "oldVin", "newVin", "technician", "titleRef", "titleNotes",
    "adapter", "algorithm", "voltage", "preWriteConfirmed", "notes",
  ];
  const esc = v => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const rows = sessions.map(s => cols.map(c => {
    if (c === "success") return s.success ? "true" : "false";
    return esc(s[c]);
  }).join(","));
  return cols.join(",") + "\n" + rows.join("\n");
}

export function generateSessionReport(sessions, shopInfo = {}) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SRT Lab Session Report</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:20px;color:#222;line-height:1.5}
h1{border-bottom:3px solid #D32F2F;padding-bottom:8px;margin-bottom:4px}
.shop{color:#666;font-size:13px;margin-bottom:20px}
.sess{border:1px solid #ddd;border-radius:8px;padding:16px;margin:14px 0;page-break-inside:avoid}
.sess h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between}
.sess h3 .mod{color:#D32F2F}
.sess h3 .ts{color:#666;font-size:12px;font-weight:normal}
.grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;margin:10px 0}
.grid span:nth-child(odd){color:#666;font-weight:bold}
.vin{font-family:'Courier New',monospace;font-weight:bold;color:#D32F2F}
.title-ref{background:#FFF8F0;padding:8px 12px;border-left:3px solid #FFB300;margin:8px 0;font-size:12px}
.result{display:inline-block;padding:3px 10px;border-radius:4px;font-weight:bold;font-size:11px}
.ok{background:#E8F5E9;color:#1B5E20}
.fail{background:#FFEBEE;color:#B71C1C}
.sig{margin-top:30px;padding-top:20px;border-top:1px solid #ddd;font-size:12px;color:#666}
.sig-line{margin-top:30px;border-bottom:1px solid #333;width:300px}
@media print{body{margin:0}.sess{page-break-inside:avoid}}
</style></head><body>
<h1>SRT Lab — Module Programming Report</h1>
<div class="shop">
${shopInfo.shopName ? "<b>" + shopInfo.shopName + "</b><br>" : ""}
${shopInfo.address || ""}
${shopInfo.license ? "<br>Dealer License: " + shopInfo.license : ""}
${shopInfo.tech ? "<br>Technician: " + shopInfo.tech : ""}
<br>Report Generated: ${new Date().toLocaleString()}
<br>Sessions Included: ${sessions.length}
</div>
${sessions.map(s => `
<div class="sess">
<h3><span class="mod">${s.module} — ${s.operation || "VIN Write"}</span><span class="ts">${new Date(s.timestamp).toLocaleString()}</span></h3>
<div class="grid">
<span>Result:</span><span><span class="result ${s.success ? "ok" : "fail"}">${s.success ? "✓ SUCCESS" : "✗ FAILED"}</span></span>
<span>Old VIN:</span><span class="vin">${s.oldVin || "(not read)"}</span>
<span>New VIN:</span><span class="vin">${s.newVin || "—"}</span>
${s.moduleAddr ? `<span>Module Address:</span><span>TX 0x${s.moduleAddr.tx.toString(16).toUpperCase()} / RX 0x${s.moduleAddr.rx.toString(16).toUpperCase()}</span>` : ""}
${s.adapter ? `<span>Adapter:</span><span>${s.adapter}</span>` : ""}
${s.technician ? `<span>Technician:</span><span>${s.technician}</span>` : ""}
${s.preWriteConfirmed ? `<span>Pre-Write Review:</span><span>✓ Confirmed at ${new Date(s.preWriteConfirmed).toLocaleTimeString()}</span>` : ""}
</div>
${s.titleRef ? `<div class="title-ref"><b>Title Reference:</b> ${s.titleRef}${s.titleNotes ? " — " + s.titleNotes : ""}</div>` : ""}
${s.notes ? `<div style="font-size:12px;color:#555;margin-top:8px"><b>Notes:</b> ${s.notes}</div>` : ""}
</div>
`).join("")}
<div class="sig">
<p>I certify that the above module programming operations were performed on modules legitimately in my possession, with VINs corresponding to vehicles documented in my records.</p>
<div class="sig-line"></div>Signature / Date
</div>
</body></html>`;
  return html;
}

/* React hook helper: triggers a re-render when audit storage changes. */
export function subscribeAudit(handler) {
  const listener = () => handler();
  window.addEventListener("srtlab:audit", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("srtlab:audit", listener);
    window.removeEventListener("storage", listener);
  };
}
