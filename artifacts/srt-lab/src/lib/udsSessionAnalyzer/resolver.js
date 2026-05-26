// UDS Session Analyzer — frame resolver.
//
// Pure helpers that decorate a parsed UDS frame with:
//   • ecuName     — target ECU name from CAN-ID (AlfaOBD intel, unverified)
//   • serviceLabel — service + sub-function description (ISO 14229, canonical)
//   • routineLabel — for 0x31 RoutineControl, the routine name (AlfaOBD intel)
//
// Every resolved field carries a `source` provenance tag so the UI and
// downstream consumers can show users where the label came from. Sources:
//   • 'iso14229'                — canonical ISO 14229-1 service table
//   • 'alfaobd-intel-unverified' — mined from the AlfaOBD .exe decompile
//
// Unknown / missing data returns `null` for the affected field — callers
// must handle the unresolved case gracefully. No side effects, no I/O.

import { SERVICES, serviceForSid } from '@workspace/uds';
import { ECU_TO_CAN_FROM_EXE } from '../ecuToCanFromExe.generated.js';
import { ROUTINE_CATALOG_FROM_EXE } from '../routineCatalogFromExe.generated.js';
import { UDS_FRAME_TO_ROUTINES } from '../dispatchToRoutine.generated.js';

export const SOURCE_ISO14229 = 'iso14229';
export const SOURCE_ALFAOBD = 'alfaobd-intel-unverified';

// ── CAN-ID → ECU name reverse index ─────────────────────────────────────────
//
// ECU_TO_CAN_FROM_EXE has two key shapes mixed together: numeric strings
// ("10", "13", …) which are AlfaOBD-internal enum codes, and human-readable
// ECU names ("Radio Frequency HUB", "TIPM_CGW", …). Only the human-readable
// keys produce a useful label for the analyzer, so the index ignores the
// numeric-string entries.
let _canToEcuCache = null;
function canToEcuIndex() {
  if (_canToEcuCache) return _canToEcuCache;
  const out = new Map();
  for (const [key, canIds] of Object.entries(ECU_TO_CAN_FROM_EXE)) {
    if (/^\d+$/.test(key)) continue;
    if (!Array.isArray(canIds)) continue;
    for (const id of canIds) {
      const list = out.get(id) ?? [];
      if (!list.includes(key)) list.push(key);
      out.set(id, list);
    }
  }
  _canToEcuCache = out;
  return out;
}

/**
 * Resolve an ECU name for a CAN-ID. Returns null when the id is unknown
 * or undefined (e.g. bare-hex / Req-Resp traces with no CAN framing).
 */
export function resolveEcuName(canId) {
  if (canId == null) return null;
  const names = canToEcuIndex().get(canId);
  if (!names || names.length === 0) return null;
  return {
    value: names.length === 1 ? names[0] : names.join(' / '),
    candidates: [...names],
    source: SOURCE_ALFAOBD,
  };
}

// ── ISO 14229 service + sub-function ────────────────────────────────────────

/**
 * Resolve the ISO 14229 service name (and sub-function description when
 * available) for a request's first byte(s). Returns null for empty input
 * or for SIDs not in the standard service table.
 */
export function resolveService(reqBytes) {
  if (!reqBytes || reqBytes.length === 0) return null;
  const sid = reqBytes[0];
  // Negative responses (0x7F sid nrc) are not "services" — leave for callers.
  if (sid === 0x7F) return null;
  const svc = serviceForSid(sid);
  if (!svc) return null;
  let value = svc.name;
  let subFunctionName = null;
  if (reqBytes.length >= 2 && Array.isArray(svc.subFunctions) && svc.subFunctions.length > 0) {
    const sf = reqBytes[1] & 0x7F; // mask suppress-positive-response bit
    const sub = svc.subFunctions.find(s => s.value === sf);
    if (sub) {
      subFunctionName = sub.name;
      value = `${svc.name} / ${sub.name}`;
    }
  }
  return {
    value,
    serviceName: svc.name,
    subFunctionName,
    sid,
    source: SOURCE_ISO14229,
  };
}

// Keep SERVICES referenced so tree-shakers don't drop the named export when
// the resolver only uses serviceForSid (tests import SERVICES through the
// barrel for round-trip checks).
export const _SERVICES_REF = SERVICES;

// ── RoutineControl (0x31) routine name ──────────────────────────────────────

function hx(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function bytesToHex(bytes) {
  return bytes.map(hx).join(' ');
}

/**
 * Resolve the routine name for a RoutineControl (0x31) request by:
 *   1. looking up the full request hex in UDS_FRAME_TO_ROUTINES, then
 *   2. progressively dropping trailing bytes until a match is found,
 *      stopping at "31 <sub>" (4-byte minimum: sid+sub+RID hi+lo).
 *
 * The match list maps to routine_ids in ROUTINE_CATALOG_FROM_EXE; the
 * routine's friendly name lives at field "1". Returns null for non-0x31
 * frames or when no dispatch entry exists.
 */
export function resolveRoutine(reqBytes) {
  if (!reqBytes || reqBytes[0] !== 0x31 || reqBytes.length < 4) return null;
  const ridLabel = `0x${hx(reqBytes[2])}${hx(reqBytes[3])}`;

  for (let n = reqBytes.length; n >= 2; n--) {
    const key = bytesToHex(reqBytes.slice(0, n));
    const rids = UDS_FRAME_TO_ROUTINES[key];
    if (!rids || rids.length === 0) continue;

    const names = [];
    for (const rid of rids) {
      const entry = ROUTINE_CATALOG_FROM_EXE[String(rid)];
      const name = entry?.['1'];
      if (name && !names.includes(name)) names.push(name);
    }
    let value;
    if (names.length === 0) {
      value = `${ridLabel} — routine ${rids.join('/')}`;
    } else if (names.length === 1) {
      value = `${ridLabel} — ${names[0]}`;
    } else {
      const head = names.slice(0, 3).join(', ');
      const tail = names.length > 3 ? `, +${names.length - 3} more` : '';
      value = `${ridLabel} — ${names.length} candidates (${head}${tail})`;
    }
    return {
      value,
      ridLabel,
      routineIds: [...rids],
      candidates: names,
      matchedKey: key,
      source: SOURCE_ALFAOBD,
    };
  }
  return null;
}

// ── Convenience aggregate ───────────────────────────────────────────────────

/**
 * Resolve every supported field for a single parsed request line.
 * Accepts either a parser line ({ canId, bytes }) or a plain byte array.
 * Always returns an object — each field is the resolution result or null.
 */
export function resolveFrame(input) {
  const line = Array.isArray(input) ? { canId: null, bytes: input } : (input || {});
  const bytes = line.bytes || [];
  return {
    ecuName: resolveEcuName(line.canId),
    serviceLabel: resolveService(bytes),
    routineLabel: resolveRoutine(bytes),
  };
}

/**
 * Compose a single human-readable "Resolved" string suitable for the
 * analyzer's searchable column. Joins the non-null parts with " · ".
 * Returns an empty string when nothing resolved.
 */
export function formatResolved(resolved) {
  if (!resolved) return '';
  const parts = [];
  if (resolved.ecuName) parts.push(resolved.ecuName.value);
  if (resolved.serviceLabel) parts.push(resolved.serviceLabel.value);
  if (resolved.routineLabel) parts.push(resolved.routineLabel.value);
  return parts.join(' · ');
}
