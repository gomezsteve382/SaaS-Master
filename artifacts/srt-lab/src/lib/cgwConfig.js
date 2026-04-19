/* ======================================================================
 * CGW / Body / TIPM / FCM config decoder (Task #144)
 * ======================================================================
 *
 * Source data: a single combined CGW_CONFIG export from the recovered
 * AlfaOBD .db. The codegen (scripts/extract-alfaobd.mjs) could NOT
 * separate the six original tables —
 *
 *   - CAN_DELPHI_500_CONFIG  (Delphi-flavored CGW, RAM 500)
 *   - CAN_DELPHI_RAM_CONFIG  (Delphi CGW, Ram trucks)
 *   - CAN_MARELLI_CONFIG     (Marelli CGW, Italian-platform vehicles)
 *   - FCM_CGW_CONFIG         (Front Control Module gateway)
 *   - TIPM_CGW_CONFIG        (TIPM gateway)
 *   - BODY_PN_CONFIG         (Body part-number-driven features)
 *
 * — because the corrupted sqlite_master B-tree could not be reconstructed
 * from the XOR-decrypted dump (see scripts/extract-alfaobd.mjs header).
 *
 * Empirically the surviving rows split cleanly by their `byte` (request
 * hex) prefix, which is how AlfaOBD itself dispatches between the six
 * tables. The REQUEST_RANGES map below pins the canonical column order
 * per the truncated CREATE statements in
 *   attached_assets/alfao_bd.analysis_*.txt :
 *     {request, bit, length, setting, _0..._N}
 *   plus an `Array` flag column that some tables carry between SETTING
 *   and the option columns. The codegen squashed these into one row
 *   shape; the decoder re-derives the per-table view by request prefix:
 *
 *     0x01xx  → BODY_PN_CONFIG   (BCM body features, 233 rows)
 *     0x02xx  → BODY_PN_CONFIG   (BCM body features extension, 6 rows)
 *     0x3Bxx  → TIPM_CGW_CONFIG  (TIPM gateway,   136 rows)
 *     0xA0xx  → CAN_MARELLI / DELPHI_RAM (Italian + Ram CGW, 31 rows)
 *     0xF0xx  → FCM_CGW_CONFIG   (Front Control Module, 27 rows)
 *
 * Row shape coming out of CGW_CONFIG:
 *   { byte:    "0123",   // request hex (opaque string — some tables
 *                        //   store a CAN request hex here, others a
 *                        //   part-number prefix. Decoder must NOT
 *                        //   assume one or the other.)
 *     bit:     35,        // global bit position in response payload,
 *                        //   MSB-first across the byte stream
 *     length:  1,         // bitfield width in bits (1..16 in practice)
 *     name:    "Air Conditioning Present",
 *     options: ["0: No", "1: Yes"] }   // index = raw value
 *
 * Decoder output rows:
 *   { setting, raw, label, request, bit, length }
 *
 * Treat unrecognized option indices as `null` raw → "(unknown value 0xNN)"
 * label rather than dropping the row, matching the task spec on
 * placeholder/garbage labels in the truncated CREATE statements.
 *
 * READ-ONLY. // TODO: encode path — inverse helper that takes a list
 * of {setting, value} edits and writes them back into the byte stream.
 * Gated on someone with a real bench module to verify against. */
import { CGW_CONFIG } from "./alfaobdData.generated.js";

/* Table → request prefix mapping. Used by the per-CGW wrappers below.
 * If T1 ever produces a properly split data drop, swap each wrapper to
 * import its own table directly and drop this map. */
export const REQUEST_RANGES = {
  BCM:        ["01", "02"],   // BODY_PN_CONFIG (+ BCM/TIPM body extension)
  TIPM:       ["3B"],         // TIPM_CGW_CONFIG
  MARELLI:    ["A0"],         // CAN_MARELLI_CONFIG / DELPHI_RAM_CONFIG
  DELPHI_RAM: ["A0"],         // shared — see comment above
  DELPHI_500: ["A0"],         // shared
  FCM:        ["F0"],         // FCM_CGW_CONFIG
};

function rowsForTable(table) {
  const prefixes = REQUEST_RANGES[table] || [];
  return CGW_CONFIG.filter((r) =>
    prefixes.some((p) => r.byte.toUpperCase().startsWith(p)),
  );
}

/* Pull `bitLength` bits out of a byte stream starting at `bitOffset`,
 * MSB-first. Returns null when the field falls off the end of the
 * buffer (so the panel can mark the row "(out of range)" instead of
 * silently returning 0 — important when the user supplies a partial
 * response capture). */
export function readBits(bytes, bitOffset, bitLength) {
  if (!bytes || bitLength <= 0) return null;
  let v = 0;
  for (let i = 0; i < bitLength; i++) {
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx < 0 || byteIdx >= bytes.length) return null;
    v = (v << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
  }
  return v;
}

/* Look up a label in the row's option list. options[] entries are
 * formatted "K: human-readable text" by the codegen. We strip the
 * "K: " prefix for display. Out-of-range values become explicit
 * "(unknown value 0xNN)" strings — never dropped, never silently
 * coerced to a stale label. */
export function labelForValue(row, raw) {
  if (raw === null || raw === undefined) return "(out of range)";
  const opt = row.options[raw];
  if (typeof opt !== "string") return `(unknown value 0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
  return opt.replace(/^\d+:\s*/, "").trim() || `(unknown value 0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
}

/* Generic core: walk a slice of the catalog against a byte stream.
 * Used by every per-CGW wrapper below and by the BCM Feature Matrix
 * panel directly when the user wants to decode all rows for a single
 * request hex. */
export function decodeConfigRows(rows, bytes) {
  const out = [];
  for (const r of rows) {
    const raw = readBits(bytes, r.bit, r.length);
    out.push({
      setting: r.name,
      request: r.byte,
      bit: r.bit,
      length: r.length,
      raw,
      label: labelForValue(r, raw),
    });
  }
  return out;
}

/* Per-table wrappers. Each filters the catalog to its table's request
 * range and runs the generic decoder. Same {setting, raw, label} row
 * shape, so the UI can mix and match without special-casing. */
export function decodeBcmConfig(bytes)         { return decodeConfigRows(rowsForTable("BCM"),        bytes); }
export function decodeTipmCgwConfig(bytes)     { return decodeConfigRows(rowsForTable("TIPM"),       bytes); }
export function decodeFcmCgwConfig(bytes)      { return decodeConfigRows(rowsForTable("FCM"),        bytes); }
export function decodeMarelliConfig(bytes)     { return decodeConfigRows(rowsForTable("MARELLI"),    bytes); }
export function decodeDelphiRamConfig(bytes)   { return decodeConfigRows(rowsForTable("DELPHI_RAM"), bytes); }
export function decodeDelphi500Config(bytes)   { return decodeConfigRows(rowsForTable("DELPHI_500"), bytes); }

/* Group a decoded result by request hex so the panel can render one
 * collapsible block per request. The map preserves first-seen order. */
export function groupByRequest(decoded) {
  const out = new Map();
  for (const row of decoded) {
    if (!out.has(row.request)) out.set(row.request, []);
    out.get(row.request).push(row);
  }
  return out;
}

/* Convenience: the full BCM-region catalog grouped by request, with
 * decoded labels when bytes are supplied and just the catalog (raw=null)
 * otherwise. The BCM tab uses this in both modes — without bytes it
 * acts as a feature-matrix reference, with bytes it's an annotated
 * decode of the captured response. */
export function bcmFeatureMatrix(bytes = null) {
  return groupByRequest(decodeBcmConfig(bytes || new Uint8Array(0)));
}
