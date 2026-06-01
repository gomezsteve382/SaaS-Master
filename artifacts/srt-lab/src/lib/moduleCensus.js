/* Module Census (Task #501).
 *
 * A "census" is a unified, comparable view of the modules a vehicle should
 * have (per its registry / VIN profile) vs. the modules the user has actually
 * loaded into the workspace. The Workflow Runner uses this to decide what
 * Fix Plan steps to enqueue and what to surface in Sign-Off.
 *
 * Inputs are intentionally loose so any tab can produce its own census
 * fragment without rewiring all of the workspace state.
 *
 * `expected`   — list of {code, name?, tx?, rx?} the platform should carry.
 * `loaded`     — list of `loadedDumps` entries from MasterVinContext.
 * `targetVin`  — string, used to flag "wrong-VIN" rows.
 *
 * Output is `{ rows, summary }` where each row is one expected module slot
 * paired (when possible) with one loaded dump and a classification:
 *   • ok        — slot present, VIN matches
 *   • mismatch  — slot present, VIN doesn't match the target VIN
 *   • missing   — slot expected but no dump loaded
 *   • extra     — dump loaded but the platform doesn't carry that slot
 *   • unknown   — dump's type field is UNKNOWN
 */

const VIN_LIKE = /[A-HJ-NPR-Z0-9]{17}/;

function pickVin(mod) {
  if (!mod) return null;
  // parseModule outputs vin / vinValid; some legacy callers just have raw fields.
  if (typeof mod.vin === "string" && VIN_LIKE.test(mod.vin)) return mod.vin.toUpperCase();
  if (typeof mod.detectedVin === "string" && VIN_LIKE.test(mod.detectedVin)) {
    return mod.detectedVin.toUpperCase();
  }
  return null;
}

function classifyRow(slot, dump, targetVin) {
  if (!dump) return { kind: "missing", reason: `no ${slot.code} dump loaded` };
  // Task #948 — a dump whose buffer fails the corrupt-fill guard (single-byte
  // fill / repeated tool-error string) must never be treated as a usable
  // module. parseModule attaches `mod.corruptFill`; surface it as its own
  // census kind so the Workflow runner flags it instead of pairing it to a
  // slot or judging its (garbage) VIN.
  const cf = (dump.mod || dump).corruptFill;
  if (cf) {
    return {
      kind: "corrupt",
      reason: `corrupt capture (${cf.reason}) — re-read this module before using it`,
    };
  }
  if (dump.type && dump.type.toUpperCase() === "UNKNOWN") {
    return { kind: "unknown", reason: "dump type could not be detected" };
  }
  const vin = pickVin(dump.mod || dump);
  if (!targetVin || !vin) {
    return { kind: vin ? "ok" : "ok", reason: vin ? "" : "no VIN in dump (treated as new)" };
  }
  if (vin === targetVin) return { kind: "ok", reason: "" };
  return {
    kind: "mismatch",
    reason: `dump VIN ${vin} ≠ target VIN ${targetVin}`,
    actualVin: vin,
  };
}

/**
 * Build a census by left-joining expected slots to loaded dumps, then
 * appending any extras that don't map back to an expected slot.
 *
 * @param {object} input
 * @param {Array<{code:string,name?:string,tx?:number,rx?:number}>} input.expected
 * @param {Array<{type:string,mod?:object,name?:string,filename?:string}>} input.loaded
 * @param {string} [input.targetVin]
 */
export function buildCensus({ expected = [], loaded = [], targetVin = "" } = {}) {
  const tv = (targetVin || "").toUpperCase();
  const usedHashes = new Set();
  const rows = [];

  for (const slot of expected) {
    // Match the first loaded dump whose type code matches this slot.
    const match = loaded.find((d) => !usedHashes.has(d.hash) && d.type === slot.code);
    if (match) usedHashes.add(match.hash);
    const cls = classifyRow(slot, match, tv);
    rows.push({
      code: slot.code,
      name: slot.name || slot.code,
      tx: slot.tx ?? null,
      rx: slot.rx ?? null,
      dump: match || null,
      ...cls,
    });
  }

  for (const d of loaded) {
    if (usedHashes.has(d.hash)) continue;
    const cls = classifyRow({ code: d.type }, d, tv);
    rows.push({
      code: d.type || "UNKNOWN",
      name: d.name || d.filename || d.type || "UNKNOWN",
      tx: null,
      rx: null,
      dump: d,
      kind: cls.kind === "ok" ? "extra" : cls.kind,
      reason: cls.kind === "ok" ? "loaded dump not in expected platform list" : cls.reason,
      actualVin: cls.actualVin,
    });
  }

  const summary = {
    expected: expected.length,
    loaded: loaded.length,
    ok: rows.filter((r) => r.kind === "ok").length,
    mismatch: rows.filter((r) => r.kind === "mismatch").length,
    missing: rows.filter((r) => r.kind === "missing").length,
    extra: rows.filter((r) => r.kind === "extra").length,
    unknown: rows.filter((r) => r.kind === "unknown").length,
    corrupt: rows.filter((r) => r.kind === "corrupt").length,
  };
  return { rows, summary };
}
