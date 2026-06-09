/**
 * virginizeLog.js — Shared session log for virginize operations
 *
 * Persists to localStorage under 'srt-lab.virginize-log.v1'.
 * Each entry: { id, chipId, chipFamily, keyColor, result, timestamp, notes }
 */

const LOG_KEY = 'srt-lab.virginize-log.v1';
const MAX_ENTRIES = 200;

export function loadVirginizeLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveVirginizeLog(entries) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {}
}

export function addVirginizeLogEntry({ chipId, chipFamily, keyColor, result, notes = '' }) {
  const entries = loadVirginizeLog();
  const entry = {
    id: `vg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chipId: (chipId || '').toUpperCase().replace(/\s/g, '') || 'UNKNOWN',
    chipFamily: chipFamily || 'PCF7945/53',
    keyColor: keyColor || 'unknown',
    result, // 'pass' | 'fail' | 'manual'
    timestamp: Date.now(),
    notes,
  };
  entries.push(entry);
  saveVirginizeLog(entries);
  return entry;
}

export function clearVirginizeLog() {
  localStorage.removeItem(LOG_KEY);
}

export function deleteVirginizeLogEntry(id) {
  const entries = loadVirginizeLog().filter(e => e.id !== id);
  saveVirginizeLog(entries);
}
