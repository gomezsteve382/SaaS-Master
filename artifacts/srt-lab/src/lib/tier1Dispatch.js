import RAW from "./tier1Dispatch.generated.json";

export const TIER1_DISPATCH_SOURCE = "AlfaOBD.exe IL ldstr extraction (8efd80b)";
export const TIER1_DISPATCH_NOTE =
  "Routine applicability metadata only. Does NOT include UDS session byte or security access level — those live at the IL call sites, not in this table.";

export const TIER1_FIELD_LABELS = {
  0: "field 0 (ECU name or code)",
  1: "field 1 (ECU display name)",
  2: "field 2 (ECU numeric code or sub-id)",
  3: "field 3 (sub-parameter / target)",
  4: "field 4 (model-year filter)",
  5: "field 5 (model-year filter)",
  7: "field 7 (model-year filter)",
  8: "field 8 (model-year filter)",
  10: "field 10 (applicability flag)",
  13: "field 13 (engine / market code)",
  14: "field 14 (engine / market code)",
  15: "field 15 (platform tag)",
  16: "field 16 (reserved flag)",
};

function isNumericLike(s) {
  return typeof s === "string" && /^-?\d+$/.test(s);
}

function asInt(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  return /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
}

export function getRoutineIds() {
  return Object.keys(RAW)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export function groupRecords(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const recs = [];
  let cur = null;
  for (const e of entries) {
    if (cur === null || e.idx === 0) {
      cur = { fields: {}, fileOffStart: e.file_off };
      recs.push(cur);
    }
    cur.fields[e.idx] = e.decrypted;
    cur.fileOffEnd = e.file_off;
  }
  return recs.map((r) => {
    const f0 = r.fields[0];
    const f1 = r.fields[1];
    const f2 = r.fields[2];
    // Schema A: (name, name, code, ...)  e.g. 1126/1367/1520
    // Schema B: (code, name, sub-id, ...) e.g. 1750/1751
    const f0Numeric = isNumericLike(f0);
    const ecu = f0Numeric ? (f1 || "(unknown)") : (f0 || f1 || "(unknown)");
    const ecuDisplay = f1 || f0 || "(unknown)";
    const ecuCode = f0Numeric ? f0 : (f2 ?? null);
    return { ...r, ecu, ecuDisplay, ecuCode, subParam: r.fields[3] ?? null };
  });
}

export function getDispatchFor(routineId) {
  const key = String(asInt(routineId));
  const entries = RAW[key];
  if (!entries) return { routineId: asInt(routineId), known: false, records: [], entryCount: 0 };
  return {
    routineId: asInt(routineId),
    known: true,
    records: groupRecords(entries),
    entryCount: entries.length,
    computed: entries.length === 0,
  };
}

export function summarize(routineId) {
  const d = getDispatchFor(routineId);
  if (!d.known) return `Routine ${routineId}: not in Tier-1 dispatch table.`;
  if (d.computed) return `Routine ${routineId}: dispatch computed at runtime (no inline metadata).`;
  const ecus = d.records.map((r) => r.ecuDisplay).join(", ");
  return `Routine ${routineId}: ${d.records.length} record(s) — ${ecus}`;
}

export const TIER1_RAW = RAW;
