/**
 * Canonical asset IDs for the global download counter.
 * Every downloadable artifact in the app gets a stable kebab-case id here so
 * the counts displayed in the UI (and stored on the API server at
 * /api/downloads/<id>) stay consistent across builds.
 *
 * Add new ids to this map when you wire up a new download. The keys are
 * referenced by both the UI (for display) and the tracking helper.
 */
export const ASSET_IDS = {
  desktopDriver:    "desktop-driver",       // srt_lab.py (Desktop Driver card)
  quickRefPdf:      "quick-ref-pdf",        // Quick Reference PDF
  j2534Bridge:      "j2534-bridge",         // j2534_bridge.py (J2534 Scanner)
  gpecUnlockedFw:   "gpec-unlocked-fw",     // GPEC firmware unlock tab
  dumpsPatchedVin:  "dumps-patched-vin",    // Dumps tab — Patch VIN + Download
  dumpsVirgin:      "dumps-virgin",         // Dumps tab — Virginize
  dumpsRaw:         "dumps-raw",            // Dumps tab — Raw / Download original
  dumpsImmoSync:    "dumps-immo-sync",      // Dumps tab — IMMO sync
  benchPatchedVin:  "bench-patched-vin",    // BenchTab — Patch + Download All
  benchVirginRfh:   "bench-virgin-rfhub",   // BenchTab — Virginize RFHUB
  benchImmoSync:    "bench-immo-sync",      // BenchTab — Sync IMMO Backup
  benchCrcPatch:    "bench-crc-patch",      // BenchTab — CRC Patch All
  securityMatched:  "security-matched",     // SecurityTab — Match All Modules
  securityModified: "security-modified",    // SecurityTab — modified module download
  securityKeySync:  "security-key-sync",    // SecurityTab — Sync key between modules
  immoRfhPatched:   "immo-rfh-patched",     // ImmoVINTab — RFHUB VIN apply
  immoGpecPatched:  "immo-gpec-patched",    // ImmoVINTab — GPEC2A VIN/key apply
  gpec2aSkim:       "gpec2a-skim-toggled",  // Gpec2aTab — SKIM toggle download
  twinPaired:       "twin-paired",          // TwinTab — paired BCM/RFH/PCM files
  modSyncPatched:   "modsync-patched-bin", // ModuleSync — synced BCM or RFH bin download
  modSyncTool:      "modsync-sync-tool",   // ModuleSync — SRTLAB_SYNC_TOOL.html download
  modSyncValidate:  "modsync-validate-py", // ModuleSync — srtlab_validate.py download
};

/**
 * Validates an asset id matches the server-side regex so typos surface early.
 */
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const COUNTER_BASE = "/api/downloads";

const listeners = new Map(); // assetId -> Set<fn>
const cache = new Map();     // assetId -> number

function notify(assetId, count) {
  cache.set(assetId, count);
  const set = listeners.get(assetId);
  if (set) set.forEach((fn) => { try { fn(count); } catch (e) { /* ignore */ } });
}

export async function fetchDownloadCount(assetId) {
  if (!ID_RE.test(assetId)) throw new Error("invalid assetId: " + assetId);
  try {
    const r = await fetch(COUNTER_BASE + "/" + assetId, { cache: "no-store" });
    if (!r.ok) return cache.get(assetId) ?? 0;
    const j = await r.json();
    const n = typeof j.count === "number" ? j.count : 0;
    notify(assetId, n);
    return n;
  } catch {
    return cache.get(assetId) ?? 0;
  }
}

export async function trackDownload(assetId) {
  if (!ID_RE.test(assetId)) throw new Error("invalid assetId: " + assetId);
  try {
    const r = await fetch(COUNTER_BASE + "/" + assetId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!r.ok) return cache.get(assetId) ?? 0;
    const j = await r.json();
    const n = typeof j.count === "number" ? j.count : 0;
    notify(assetId, n);
    return n;
  } catch {
    // optimistic local bump so UI still reflects the click
    const n = (cache.get(assetId) ?? 0) + 1;
    notify(assetId, n);
    return n;
  }
}

export function subscribeDownloadCount(assetId, fn) {
  let set = listeners.get(assetId);
  if (!set) { set = new Set(); listeners.set(assetId, set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

export function getCachedCount(assetId) {
  return cache.get(assetId) ?? 0;
}
