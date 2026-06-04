/* ============================================================================
 * keyProgPresets.js — localStorage-backed presets for the Key Prog wizard
 * (Task #345). Each preset captures the BCM/RFH/PCM module trio plus the
 * last-used VIN under a user-supplied name, so a busy shop can re-load a
 * common job with a single click instead of re-uploading three files and
 * re-typing the VIN.
 *
 * Storage shape (under STORAGE_KEY):
 *   { version: 1, presets: [
 *     { id, name, vin, createdAt,
 *       files: { BCM:{name,dataB64}, RFH:{name,dataB64}, PCM:{name,dataB64} } }
 *   ]}
 * ========================================================================== */

export const STORAGE_KEY = 'srtlab.keyprog.presets.v1';

function getStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* SSR / disabled */ }
  return null;
}

export function bytesToB64(bytes) {
  if (!bytes) return '';
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s, 'binary').toString('base64');
}

export function b64ToBytes(b64) {
  if (!b64) return new Uint8Array();
  const bin = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadPresets() {
  const ls = getStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.presets)) return [];
    return parsed.presets;
  } catch {
    return [];
  }
}

function writePresets(presets) {
  const ls = getStorage();
  if (!ls) return false;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({ version: 1, presets }));
    return true;
  } catch {
    return false;
  }
}

function newId() {
  return 'kp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function serializePreset({ name, vin, files, checks }) {
  if (!name || !name.trim()) throw new Error('Preset name is required');
  if (!vin || vin.length !== 17) throw new Error('VIN must be 17 characters');
  if (!files?.BCM?.data || !files?.RFH?.data || !files?.PCM?.data) {
    throw new Error('All three module files (BCM, RFH, PCM) must be loaded');
  }
  const preset = {
    id: newId(),
    name: name.trim(),
    vin,
    createdAt: new Date().toISOString(),
    files: {
      BCM: { name: files.BCM.name, dataB64: bytesToB64(files.BCM.data) },
      RFH: { name: files.RFH.name, dataB64: bytesToB64(files.RFH.data) },
      PCM: { name: files.PCM.name, dataB64: bytesToB64(files.PCM.data) },
    },
  };
  if (Array.isArray(checks)) {
    const snapshot = checks.map((c) => ({
      label: String(c.label || ''),
      pass: !!c.pass,
      detail: c.detail ? String(c.detail) : '',
    }));
    preset.checks = snapshot;
    preset.checksPassed = snapshot.filter((c) => c.pass).length;
    preset.checksTotal = snapshot.length;
    preset.checksAllGreen = snapshot.length > 0 && snapshot.every((c) => c.pass);
  }
  return preset;
}

export function hydratePreset(preset) {
  if (!preset?.files) return null;
  const out = { vin: preset.vin || '', files: { BCM: null, RFH: null, PCM: null } };
  for (const role of ['BCM', 'RFH', 'PCM']) {
    const f = preset.files[role];
    if (!f) continue;
    out.files[role] = { name: f.name, data: b64ToBytes(f.dataB64) };
  }
  return out;
}

export function savePreset({ name, vin, files, checks }) {
  const preset = serializePreset({ name, vin, files, checks });
  const presets = loadPresets();
  presets.unshift(preset);
  if (!writePresets(presets)) {
    throw new Error('Could not save preset (storage full or unavailable)');
  }
  return preset;
}

/* Save an already-serialized preset object (e.g. produced by buildAemtPreset)
 * directly into storage without re-running serializePreset. Used by the AEMT
 * importer so it can store presets with partial checks and AEMT-sourced files
 * without hitting the "checks must be green" UI guard in handleSavePreset. */
export function saveRawPreset(preset) {
  if (!preset || !preset.id || !preset.name || !preset.vin || !preset.files) {
    throw new Error('Invalid preset object passed to saveRawPreset');
  }
  const presets = loadPresets();
  if (presets.some((p) => p.id === preset.id)) return preset; // idempotent
  presets.unshift(preset);
  if (!writePresets(presets)) {
    throw new Error('Could not save preset (storage full or unavailable)');
  }
  return preset;
}

export function deletePreset(id) {
  const presets = loadPresets().filter((p) => p.id !== id);
  writePresets(presets);
  return presets;
}

export function renamePreset(id, name) {
  const presets = loadPresets().map((p) => (p.id === id ? { ...p, name: name.trim() } : p));
  writePresets(presets);
  return presets;
}
