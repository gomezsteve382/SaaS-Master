/**
 * ECU ↔ CAN reverse-index helpers (union of both surfaces).
 *
 * Provenance:
 *   Backed by ECU_TO_CAN_FROM_EXE in ./ecuToCanFromExe.generated.js, which was
 *   extracted from AlfaOBD.exe IL by scanning for ldstr/ldc.i4 dictionary-add
 *   sequences. Some entries are canonical ECU names (e.g. "Radio Frequency HUB",
 *   "TIPM_CGW", "AHBM"), while others are platform-strings ("MY2011+ PowerNet"),
 *   vehicle families ("RAM 1500/2500/3500/4500/5500"), or opaque numeric keys
 *   left over from the dictionary's internal codepoints.
 *
 * Two consumer surfaces live in this file:
 *
 *   1. Direct lookup helpers (used by AlfaObdIntelTab and similar read-only
 *      browsers):
 *        - canIdsForEcu(name)   → number[]   (case-insensitive + acronym match)
 *        - ecusForCanId(canId)  → string[]   (friendly keys only)
 *        - listFriendlyEcus()   → {name,canIds[]}[]
 *        - canIdHex(canId)      → "0xNNN"
 *      "Friendly" excludes purely numeric keys, MY20xx platform strings, and
 *      the catch-all "RAM 1500/2500/3500/4500/5500" family entry, so picker
 *      dropdowns stay focused on real module names.
 *
 *   2. UDS / J2534 bridge picker rows (used by UdsTab):
 *        - buildEcuToCanIndex(map?) → row[]
 *        - ECU_PICKER_ROWS          → row[] (precomputed against generated data)
 *        - findEcuPickerRow(query, rows?)
 *      Row shape:
 *        { label, requestId, responseId, source, isLegacyMultiBus,
 *          isNumericInternalId }
 *      Rules:
 *        - Single-ID entry → response = request + 0x8 (11-bit CAN functional
 *          offset, the FCA convention).
 *        - Two IDs forming an explicit request/response pair
 *          (id[1] === id[0] + 0x8) → one row with the explicit pair,
 *          isLegacyMultiBus = false.
 *        - Any other multi-ID entry (e.g. "Radio Frequency HUB"
 *          → 0x600, 0x620) is expanded to one row per ID with a
 *          " (legacy bus N)" suffix and isLegacyMultiBus = true.
 *      Sorted with numeric-only AlfaOBD internal IDs last.
 *
 * Acronym matching (canIdsForEcu):
 *   Accepts substring matches against both the raw key and a derived acronym
 *   (initials of mixed-case words, whole token for ALL-CAPS tokens). This lets
 *   "RFHUB" find "Radio Frequency HUB" without forcing callers to know the
 *   canonical spelling.
 */

import { ECU_TO_CAN_FROM_EXE } from './ecuToCanFromExe.generated.js';

export const ECU_PICKER_SOURCE = 'alfaobd-il';
export const CAN11_RESPONSE_OFFSET = 0x8;

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

function isNumericLabel(k) {
  return /^\d+$/.test(String(k));
}

function isFriendlyKey(key) {
  if (isNumericLabel(key)) return false;
  if (key.startsWith('MY20')) return false;
  if (key.startsWith('RAM 1500/')) return false;
  return true;
}

/* ─── Surface 1: direct lookup helpers ─────────────────────────────────── */

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

/* ─── Surface 2: UDS / J2534 picker rows ───────────────────────────────── */

/* Build the picker rows from any compatible map (defaults to the generated
 * data). Exported so tests can pass synthetic fixtures. */
export function buildEcuToCanIndex(map = ECU_TO_CAN_FROM_EXE) {
  const rows = [];
  for (const [name, ids] of Object.entries(map || {})) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const numericLabel = isNumericLabel(name);

    if (ids.length === 2 && ids[1] === ids[0] + CAN11_RESPONSE_OFFSET) {
      rows.push({
        label: name,
        requestId: ids[0],
        responseId: ids[1],
        source: ECU_PICKER_SOURCE,
        isLegacyMultiBus: false,
        isNumericInternalId: numericLabel,
      });
      continue;
    }

    if (ids.length === 1) {
      rows.push({
        label: name,
        requestId: ids[0],
        responseId: ids[0] + CAN11_RESPONSE_OFFSET,
        source: ECU_PICKER_SOURCE,
        isLegacyMultiBus: false,
        isNumericInternalId: numericLabel,
      });
      continue;
    }

    ids.forEach((req, i) => {
      rows.push({
        label: `${name} (legacy bus ${i + 1})`,
        requestId: req,
        responseId: req + CAN11_RESPONSE_OFFSET,
        source: ECU_PICKER_SOURCE,
        isLegacyMultiBus: true,
        isNumericInternalId: numericLabel,
      });
    });
  }

  const seen = new Set();
  const dedup = [];
  for (const r of rows) {
    const key = `${r.label}|${r.requestId}|${r.responseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }

  dedup.sort((a, b) => {
    if (a.isNumericInternalId !== b.isNumericInternalId) {
      return a.isNumericInternalId ? 1 : -1;
    }
    return a.label.localeCompare(b.label);
  });

  return dedup;
}

/* Pre-computed picker rows for the default generated map. */
export const ECU_PICKER_ROWS = buildEcuToCanIndex();

/* Look up the first picker row matching a label (case-insensitive exact match
 * first, then substring). Returns null when nothing matches — callers should
 * keep the existing free-form CAN-ID inputs as the fallback path. */
export function findEcuPickerRow(query, rows = ECU_PICKER_ROWS) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const exact = rows.find((r) => r.label.toLowerCase() === q);
  if (exact) return exact;
  return rows.find((r) => r.label.toLowerCase().includes(q)) || null;
}

/* ─── Surface 3: CDA6 ECU catalog (398 modules) ─────────────────────────── */
/* Re-export the CDA6 catalog and helpers so consumers only need to import
 * from this one file. The catalog has module type / protocol info but NOT
 * physical CAN IDs — use the AlfaOBD picker rows or udsEngine MODULE_REGISTRY
 * for CAN addressing. */
export {
  ECU_CATALOG_CDA6,
  ECU_CATALOG_CDA6_META,
  CDA6_ARCHITECTURES,
  CDA6_PROTOCOLS,
  CDA6_BUSES,
  findCda6Ecu,
  getCda6EcuByAcronym,
} from './ecuCatalogFromCda6.generated.js';
