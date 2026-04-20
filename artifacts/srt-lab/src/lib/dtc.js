/* DTC plain-English overlay helpers (Task #143).
 *
 * Pure helpers — no React, no engine — so they can be unit-tested
 * with the vitest "node" environment that the rest of the lib uses.
 *
 * Pipeline:
 *   raw 0x19 02 08 response bytes
 *     → parseDtcResponse() → [{ code, statusByte, dtcRaw }]
 *     → for each: dtcLookup(code) → { code, description, category } | null
 *                 decodeDtcStatus(byte) → { bits, summary }
 *     → formatDtcLogLine() → human-readable string for the log
 *
 * The fault description table (FAULTS_BY_HEX) is owned by the
 * AlfaOBD codegen (Task T1). It currently exports `{}` because the
 * source .db is dirty; the lookup falls back to "(unknown)" so
 * the UI keeps rendering. Once T1 lands a populated table, every
 * call here picks up descriptions automatically — no further work.
 *
 * Status bits follow ISO 14229-1 §11.3.5.2 (DTCStatusMask).
 */

import { FAULTS_BY_HEX as DEFAULT_FAULTS } from "./alfaobdData.generated.js";

/* ── Hex helpers ──────────────────────────────────────────────────── */
const _hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

/* Format a 3-byte UDS DTC per ISO 15031-6 + ISO 14229 FTB.
 *
 *   byte0  bit7-6 → letter (P/C/B/U)
 *   byte0  bit5-4 → first  hex digit (0-3 for OBD-II)
 *   byte0  bit3-0 → second hex digit
 *   byte1  bit7-4 → third  hex digit
 *   byte1  bit3-0 → fourth hex digit
 *   byte2  → Failure Type Byte (FTB), rendered as 2-digit suffix
 *
 * Output: "P030100" (= P0301 + FTB 00). This matches wiTECH / DRB
 * rendering and lets us key fault lookups on the 5-char stem
 * ("P0301") regardless of FTB.
 *
 * NB: the historical UdsTab loop used `hx(b0 & 0x3F, 1)` which
 * collapsed bytes >= 0x10 into 2 chars and shifted alignment. The
 * helper here is the correct nibble-split layout. */
export function formatDtcCode(b0, b1, b2) {
  const prefix = ["P", "C", "B", "U"][(b0 >> 6) & 0x3];
  const d1 = (b0 >> 4) & 0x3;
  const d2 = b0 & 0xf;
  const d3 = (b1 >> 4) & 0xf;
  const d4 = b1 & 0xf;
  return (
    prefix +
    d1.toString(16).toUpperCase() +
    d2.toString(16).toUpperCase() +
    d3.toString(16).toUpperCase() +
    d4.toString(16).toUpperCase() +
    _hex(b2)
  );
}

/* Strip the 2-char FTB suffix from a formatted code so lookups can
 * fall back to the stem when the fault table is keyed without it. */
export function dtcStem(code) {
  if (typeof code !== "string" || code.length < 6) return code;
  return code.slice(0, code.length - 2);
}

/* ── Status mask decoder (ISO 14229-1 §11.3.5.2) ───────────────── */
/* Bit definitions, low-to-high. Order is the standard's order. */
export const DTC_STATUS_BITS = [
  { mask: 0x01, key: "testFailed",                 label: "test failed" },
  { mask: 0x02, key: "testFailedThisOpCycle",      label: "test failed this op cycle" },
  { mask: 0x04, key: "pending",                    label: "pending" },
  { mask: 0x08, key: "confirmed",                  label: "confirmed" },
  { mask: 0x10, key: "testNotCompletedSinceClear", label: "test not completed since last clear" },
  { mask: 0x20, key: "testFailedSinceClear",       label: "test failed since last clear" },
  { mask: 0x40, key: "testNotCompletedThisOpCycle",label: "test not completed this op cycle" },
  { mask: 0x80, key: "warningIndicatorRequested",  label: "warning indicator requested" },
];

export function decodeDtcStatus(byte) {
  const b = (byte | 0) & 0xff;
  const bits = {};
  const labels = [];
  for (const d of DTC_STATUS_BITS) {
    const on = (b & d.mask) !== 0;
    bits[d.key] = on;
    if (on) labels.push(d.label);
  }
  /* Short summary used inline in log line. */
  const short = [];
  if (bits.confirmed) short.push("confirmed");
  if (bits.pending) short.push("pending");
  if (bits.testFailed && !bits.confirmed) short.push("current");
  if (bits.warningIndicatorRequested) short.push("MIL");
  return {
    raw: b,
    hex: "0x" + _hex(b),
    bits,
    labels,                                   /* every active bit */
    summary: short.length ? short.join(" / ") : "—",
  };
}

/* ── Lookup ────────────────────────────────────────────────────── */
/* Accepts the table as a parameter so tests can inject a mock
 * without monkey-patching the import. Defaults to FAULTS_BY_HEX
 * (currently {} until Task T1 ships a clean .db). The table may
 * be keyed by either the formatted code ("P0301"), the upper-case
 * hex ("0301"), or the raw 24-bit number — try all three. */
export function dtcLookup(code, table = DEFAULT_FAULTS) {
  if (!code || !table) return null;
  const upper = String(code).toUpperCase();
  const stem = dtcStem(upper);
  const variants = [
    upper,                                  /* full P030100 */
    stem,                                   /* stem  P0301  */
    upper.replace(/^[PCBU]/, ""),           /* hex   030100 */
    stem.replace(/^[PCBU]/, ""),            /* hex   0301   */
  ];
  for (const k of variants) {
    if (Object.prototype.hasOwnProperty.call(table, k)) {
      const v = table[k];
      if (typeof v === "string") return { code: upper, description: v, category: null };
      if (v && typeof v === "object" && typeof v.description === "string") {
        return { code: upper, description: v.description, category: v.category || null };
      }
    }
  }
  return null;
}

/* ── Response parser ──────────────────────────────────────────── */
/* `bytes` is the full UDS response payload (after PCI / addr
 * stripping by the engine). 0x19 0x02 layout:
 *   [59] [02] [statusAvailMask] [dtcHi dtcMid dtcLo statusByte]*
 * We tolerate either a 0x59 echo at byte 0 or a header that
 * starts directly at index 0 — the existing UdsTab loop starts
 * at i=3 to skip the SID/sub/availMask, so we keep that contract. */
export function parseDtcResponse(bytes) {
  if (!bytes || bytes.length < 4) return [];
  const d = bytes instanceof Uint8Array ? Array.from(bytes) : Array.from(bytes);
  const out = [];
  for (let i = 3; i + 3 < d.length; i += 4) {
    const dtcRaw = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    if (dtcRaw === 0) continue;
    out.push({
      code: formatDtcCode(d[i], d[i + 1], d[i + 2]),
      statusByte: d[i + 3] & 0xff,
      dtcRaw,
    });
  }
  return out;
}

/* ── Log-line formatter ───────────────────────────────────────── */
/* Returns the string the UI prints. Pulled out so tests can pin
 * the wording without rendering React. */
export function formatDtcLogLine(entry, table = DEFAULT_FAULTS) {
  const lookup = dtcLookup(entry.code, table);
  const status = decodeDtcStatus(entry.statusByte);
  const desc = lookup ? lookup.description : "(unknown)";
  return `DTC: ${entry.code} (${desc}) status=${status.hex} — ${status.summary}`;
}

/* Run the full Read-DTCs flow against a mocked or real engine.
 *
 * Pulled out of UdsTab so an integration test can drive the same
 * code path with a fake engine and assert the rendered log lines
 * + structured detail payloads — no React mount, no jsdom needed.
 *
 * `addLog(message, level, extra)` matches UdsTab's signature; the
 * `extra` arg carries the `{dtc: <detail>}` payload that the log
 * renderer uses to expand the inline detail panel. The function
 * returns the array of formatted hex codes for paper-trail
 * recording. */
export async function runDtcRead({ engine, addLog, txAddr, rxAddr, table = DEFAULT_FAULTS }) {
  const r = await engine.uds(txAddr, rxAddr, [0x19, 0x02, 0x08]);
  const codes = [];
  if (r && r.ok && r.d) {
    const entries = parseDtcResponse(r.d);
    for (const entry of entries) {
      const detail = buildDtcDetail(entry, { tx: txAddr, rx: rxAddr }, table);
      addLog(formatDtcLogLine(entry, table), "warn", { dtc: detail });
      codes.push(entry.code);
    }
    if (!codes.length) addLog("✓ No DTCs", "rx");
  }
  return { ok: !!(r && r.ok), codes };
}

/* Build the structured payload attached to a clickable log row.
 * Keeps the audit-record contract (just hex codes) untouched. */
export function buildDtcDetail(entry, moduleAddr, table = DEFAULT_FAULTS) {
  const lookup = dtcLookup(entry.code, table);
  const status = decodeDtcStatus(entry.statusByte);
  return {
    code: entry.code,
    description: lookup?.description || null,
    category: lookup?.category || null,
    statusByte: entry.statusByte,
    statusHex: status.hex,
    statusBits: status.bits,
    statusLabels: status.labels,
    statusSummary: status.summary,
    statusShort: status.summary,
    moduleAddr: moduleAddr || null,
  };
}
