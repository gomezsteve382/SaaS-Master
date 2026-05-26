/**
 * ECU ↔ CAN reverse-index helpers.
 *
 * Provenance:
 *   Backed by ECU_TO_CAN_FROM_EXE in ./ecuToCanFromExe.generated.js, which was
 *   extracted from AlfaOBD.exe IL by scanning for ldstr/ldc.i4 dictionary-add
 *   sequences. Some entries are canonical ECU names (e.g. "Radio Frequency HUB",
 *   "TIPM_CGW", "AHBM"), while others are platform-strings ("MY2011+ PowerNet"),
 *   vehicle families ("RAM 1500/2500/3500/4500/5500"), or opaque numeric keys
 *   left over from the dictionary's internal codepoints.
 *
 * Friendly-name heuristic (used by ecusForCanId / listFriendlyEcus):
 *   A key is considered a "friendly" ECU name if it is NOT
 *     - purely numeric (e.g. "13", "8187", "0235"),
 *     - a model-year platform string starting with "MY20",
 *     - the catch-all "RAM 1500/2500/3500/4500/5500" family entry.
 *   This keeps autofill picker dropdowns focused on real module names.
 *
 * Multi-bus entries (e.g. "Radio Frequency HUB" → [0x600, 0x620]) are preserved
 * as-is; consumers must handle the array.
 *
 * Acronym matching:
 *   canIdsForEcu accepts both substring matches against the raw key and
 *   substring matches against a derived acronym (initials of mixed-case words,
 *   whole token for ALL-CAPS tokens). This lets "RFHUB" find "Radio Frequency
 *   HUB" without forcing callers to know the canonical spelling.
 */

import { ECU_TO_CAN_FROM_EXE } from './ecuToCanFromExe.generated.js';

function acronymOf(key) {
  return String(key)
    .split(/\s+/)
    .map((tok) => {
      if (!tok) return '';
      if (/^[A-Z0-9_]+$/.test(tok)) return tok;
      return tok[0] || '';
    })
    .join('');
}

function isFriendlyKey(key) {
  if (/^\d+$/.test(key)) return false;
  if (key.startsWith('MY20')) return false;
  if (key.startsWith('RAM 1500/')) return false;
  return true;
}

/**
 * Find all CAN IDs associated with an ECU name fragment.
 * Case-insensitive; matches against both the raw key and a derived acronym
 * (e.g. "RFHUB" matches "Radio Frequency HUB").
 * @param {string} name
 * @returns {number[]} deduped, ascending
 */
export function canIdsForEcu(name) {
  if (!name || typeof name !== 'string') return [];
  const needle = name.toLowerCase();
  const out = new Set();
  for (const [key, ids] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    const hay = key.toLowerCase();
    const acr = acronymOf(key).toLowerCase();
    if (hay.includes(needle) || (acr && acr.includes(needle))) {
      for (const id of ids) out.add(id);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Reverse lookup: all friendly ECU names associated with a given CAN ID.
 * Filters out pure-numeric keys, MY20xx platform strings, and the RAM family.
 * @param {number} canId
 * @returns {string[]} sorted alphabetically
 */
export function ecusForCanId(canId) {
  const out = [];
  for (const [key, ids] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    if (!isFriendlyKey(key)) continue;
    if (ids.includes(canId)) out.push(key);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Picker-ready list of friendly ECU entries.
 * @returns {Array<{ name: string, canIds: number[] }>} sorted by name
 */
export function listFriendlyEcus() {
  const out = [];
  for (const [key, ids] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    if (!isFriendlyKey(key)) continue;
    out.push({ name: key, canIds: Array.from(ids).sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Format a CAN ID as a 3-digit uppercase hex string with 0x prefix.
 * @param {number} canId
 * @returns {string}
 */
export function canIdHex(canId) {
  const n = Number(canId);
  if (!Number.isFinite(n)) return '';
  return '0x' + n.toString(16).toUpperCase().padStart(3, '0');
}
