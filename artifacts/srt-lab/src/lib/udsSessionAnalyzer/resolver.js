/**
 * UDS Session Analyzer — auto-resolve decoration pass (Task #826)
 *
 * Pure, dependency-free decoration layer that runs after analyzeSession()
 * and surfaces three orthogonal pieces of context for every parsed
 * exchange:
 *
 *   1. ecuName       — friendly ECU label derived from the request CAN ID
 *                       via reverse lookup of ECU_TO_CAN_FROM_EXE
 *                       (provenance: 'alfaobd-il').
 *   2. routineLabel  — RoutineControl friendly label derived from the
 *                       request hex via UDS_FRAME_TO_ROUTINES (prefix
 *                       match, longest first) cross-referenced against
 *                       ROUTINE_CATALOG_FROM_EXE idx[1]
 *                       (provenance: 'alfaobd-il').
 *   3. didCatalogName — already populated by analyzeSession() via the
 *                       built-in @workspace/uds didEntry() (provenance:
 *                       'iso14229'); this module just confirms it flows
 *                       through exchange.did.name / exchange.dids[*].name.
 *
 * No React imports, no DOM access, no side effects.
 */

import { ECU_TO_CAN_FROM_EXE } from '../ecuToCanFromExe.generated.js';
import { UDS_FRAME_TO_ROUTINES } from '../dispatchToRoutine.generated.js';
import { ROUTINE_CATALOG_FROM_EXE } from '../routineCatalogFromExe.generated.js';

const ECU_SOURCE = 'alfaobd-il';
const ROUTINE_SOURCE = 'alfaobd-il';

// --- ECU reverse lookup -----------------------------------------------------

function isNumericName(s) {
  return /^[\d,]+$/.test(s);
}

function isPlatformName(s) {
  // Vehicle platform / model-year identifiers that aren't an ECU name per se.
  if (/^MY\s*\d/i.test(s)) return true;
  if (/PowerNet/i.test(s)) return true;
  if (/^\(/.test(s)) return true;                // "(RM) ROUTAN", "(KA) NITRO"
  if (/^RAM\s/i.test(s)) return true;
  return false;
}

function pickBestName(names) {
  const filtered = names.filter(n => !isNumericName(n) && !isPlatformName(n));
  // Prefer the first multi-word descriptive name (e.g. "Radio Frequency HUB"
  // over the family-code short form "TPM").
  const withSpace = filtered.find(n => /\s/.test(n));
  return withSpace || filtered[0] || names[0] || null;
}

const CAN_TO_ECU_NAMES = (() => {
  const map = new Map();
  for (const [name, canIds] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    if (!Array.isArray(canIds)) continue;
    for (const id of canIds) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(name);
    }
  }
  return map;
})();

/**
 * Resolve a CAN ID (decimal) to a friendly ECU name (or array when
 * multiple descriptive names survive filtering).
 *
 * @param {number} canId
 * @returns {string|string[]|null}
 */
export function resolveEcuName(canId) {
  if (canId == null) return null;
  const names = CAN_TO_ECU_NAMES.get(canId);
  if (!names || !names.length) return null;
  const filtered = names.filter(n => !isNumericName(n) && !isPlatformName(n));
  if (!filtered.length) {
    const best = pickBestName(names);
    return best || null;
  }
  if (filtered.length === 1) return filtered[0];
  // Multi-ECU CAN ID: return the full array of descriptive names so the
  // caller can disambiguate.
  return filtered.slice();
}

// --- Routine resolution -----------------------------------------------------

function normHex(s) { return String(s).toLowerCase().replace(/\s+/g, ''); }

function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

const FRAME_MAP = (() => {
  const m = new Map();
  for (const [k, rids] of Object.entries(UDS_FRAME_TO_ROUTINES)) {
    if (!Array.isArray(rids) || !rids.length) continue;
    m.set(normHex(k), rids);
  }
  // Sort keys by length descending so prefix matching picks the most
  // specific frame first.
  const sortedKeys = [...m.keys()].sort((a, b) => b.length - a.length);
  return { map: m, sortedKeys };
})();

function ridToHexLabel(rid) {
  return '0x' + rid.toString(16).toUpperCase().padStart(4, '0');
}

function routineFriendlyName(rid) {
  const entry = ROUTINE_CATALOG_FROM_EXE[String(rid)] || ROUTINE_CATALOG_FROM_EXE[rid];
  if (!entry) return null;
  // idx[1] = ECU friendly name (per generated file JSDoc).
  return entry['1'] || null;
}

/**
 * Resolve a request byte array to a routine label + the full candidate list.
 *
 * @param {number[]} reqBytes
 * @returns {{ routineLabel: string|null, routineCandidates: Array<{rid:number,label:string|null}>|null }}
 */
export function resolveRoutine(reqBytes) {
  if (!Array.isArray(reqBytes) || reqBytes.length === 0) {
    return { routineLabel: null, routineCandidates: null };
  }
  const hex = bytesToHex(reqBytes);
  for (const key of FRAME_MAP.sortedKeys) {
    // Require at least 2 bytes (4 hex chars) of match to avoid noisy
    // bare-SID hits like "22" or "31" that resolve to dozens of unrelated
    // routines.
    if (key.length < 4) continue;
    if (!hex.startsWith(key)) continue;
    const rids = FRAME_MAP.map.get(key);
    const candidates = rids.map(rid => ({ rid, label: routineFriendlyName(rid) }));
    const best = candidates.find(c => c.label) || candidates[0];
    const ridHex = ridToHexLabel(best.rid);
    const routineLabel = best.label ? `${ridHex} ${best.label}` : ridHex;
    return { routineLabel, routineCandidates: candidates };
  }
  return { routineLabel: null, routineCandidates: null };
}

// --- Public API -------------------------------------------------------------

/**
 * Decorate a single analyzed exchange with ECU + routine context.
 * Pure function; does not mutate its argument.
 *
 * Provenance:
 *   - ecuName / routineLabel come from AlfaOBD.exe IL extraction
 *     ('alfaobd-il').
 *   - DID names (already attached by analyzeSession via @workspace/uds
 *     didEntry) come from the built-in ISO 14229 catalog ('iso14229').
 *
 * @param {object} exchange
 * @returns {{
 *   ecuName: string|string[]|null,
 *   ecuSource: string|null,
 *   routineLabel: string|null,
 *   routineCandidates: Array<{rid:number,label:string|null}>|null,
 *   routineSource: string|null,
 * }}
 */
export function resolveExchange(exchange) {
  const canId = exchange?.request?.canId ?? exchange?.response?.canId ?? null;
  const ecuName = resolveEcuName(canId);

  const reqBytes = exchange?.request?.bytes;
  const { routineLabel, routineCandidates } = resolveRoutine(reqBytes || []);

  return {
    ecuName,
    ecuSource: ecuName ? ECU_SOURCE : null,
    routineLabel,
    routineCandidates,
    routineSource: routineLabel ? ROUTINE_SOURCE : null,
  };
}

/**
 * Return a new session object with every exchange decorated under
 * exchange.resolved. Pure: original session and exchanges are not mutated.
 *
 * @param {{exchanges: object[]} & object} session
 * @returns {object}
 */
export function resolveSession(session) {
  if (!session || !Array.isArray(session.exchanges)) return session;
  const exchanges = session.exchanges.map(ex => ({
    ...ex,
    resolved: resolveExchange(ex),
  }));
  return { ...session, exchanges };
}
