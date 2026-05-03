/* proxiDecoder — read-only BCM proxi / feature decode.
 *
 * Two data sources are stitched together so the Proxi tab can speak in
 * one vocabulary:
 *
 *   1. The classic 0x2023 BCM proxi blob (16 bytes). Decoded via the
 *      existing `cgwConfig.js` (BODY_PN_CONFIG rows whose `byte` prefix
 *      is "01"/"02"). Source: AlfaOBD recovered db, already shipped in
 *      `alfaobdData.generated.js`.
 *
 *   2. The DEnn family of BCM feature DIDs (DE00..DE0C). Each DID is its
 *      own UDS read; `bit` is the position within that DID's response
 *      payload (MSB-first). Source: `bcmFeatureCatalog.generated.js`,
 *      extracted from the BCMConfiguration.tsx the user supplied.
 *
 * Categorization mirrors the 15 buckets the TSX defines so the UI can
 * render a familiar sidebar. Both sources flow through the same
 * { request, groupName, name, bit, length, raw, label, category, source }
 * row shape so the panel never special-cases.
 *
 * READ-ONLY by design — the encoder + write engine ship in a follow-up
 * once the labels have been ground-truthed against a real bench dump.
 */
import { decodeBcmConfig, readBits } from "./cgwConfig.js";
import { DE_FEATURE_CATALOG, DE_GROUPS } from "./bcmFeatureCatalog.generated.js";
import { parseProxi } from "./fcaProxi.js";
import {
  PROXI_VARIANTS,
  PROXI_SECTION_NAMES,
  decodeProxiSection,
  getProxiFields,
} from "./proxiFieldCatalog.generated.js";

export { PROXI_VARIANTS, PROXI_SECTION_NAMES };

export const CATEGORY_DEFS = [
  { id: "lighting",    label: "Lighting" },
  { id: "locks",       label: "Locks & Security" },
  { id: "remote",      label: "Remote & Key Fob" },
  { id: "comfort",     label: "Comfort" },
  { id: "horn",        label: "Horn & Sounds" },
  { id: "wipers",      label: "Wipers" },
  { id: "windows",     label: "Windows & Sunroof" },
  { id: "mirrors",     label: "Mirrors" },
  { id: "engine",      label: "Engine & Start" },
  { id: "display",     label: "Display & Cluster" },
  { id: "performance", label: "Performance & SRT" },
  { id: "vehicle",     label: "Vehicle Config" },
  { id: "security",    label: "Security & Alarm" },
  { id: "tpms",        label: "TPMS" },
  { id: "other",       label: "Other / Raw" },
];

/* Bucket a row name + group into one of the 15 categories. Mirrors
 * BCMConfiguration.tsx `categorizeParam` so the UI matches what the
 * source file expected. Order matters: more specific tests first. */
export function categorizeField(name, groupName = "") {
  const n = ((name || "") + " " + (groupName || "")).toLowerCase();
  if (/light|drl|lamp|beam|led|illum/.test(n)) return "lighting";
  if (/\b(lock|unlock|entry|door)\b/.test(n))  return "locks";
  if (/remote|fob|rke|\bkey\b/.test(n))        return "remote";
  if (/seat|memory|pedal|easy|comfort|heated|ventilat|cooled/.test(n)) return "comfort";
  if (/horn|chime|sound|beep|volume/.test(n))  return "horn";
  if (/wiper|rain|wash/.test(n))               return "wipers";
  if (/window|sunroof|moonroof/.test(n))       return "windows";
  if (/mirror|fold/.test(n))                   return "mirrors";
  if (/engine|start|idle|stop-start|\bess\b|\brun\b/.test(n)) return "engine";
  // tpms before display — "Tire Pressure Display Units" should land in tpms
  if (/tpms|\btire\b|pressure/.test(n))        return "tpms";
  if (/display|cluster|gauge|unit|metric|language|speed.?meter/.test(n)) return "display";
  if (/srt|performance|launch|track|drag|line lock|exhaust|suspension|throttle|paddle|rev match|torque|trans brake|shift light|cylinder|supercharg|intercooler|race|dyno|timer|g-force|widebody|custom mode|brake temp/.test(n))
    return "performance";
  if (/vehicle|trim|variant|config|option|install|liftgate/.test(n)) return "vehicle";
  if (/alarm|intrusion|sentry|security|valet|tilt|motion|glass break/.test(n)) return "security";
  return "other";
}

/* Decode the classic 0x2023 16-byte proxi blob using the existing
 * BODY_PN_CONFIG decoder. Returns rows in the same shape as DEnn so
 * the panel can mix them. */
export function decodeProxi2023(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const decoded = decodeBcmConfig(buf);
  return decoded.map((r) => ({
    source: "0x2023",
    request: "2023",
    groupName: "BCM Proxi (0x2023)",
    name: r.setting,
    bit: r.bit,
    length: r.length,
    raw: r.raw,
    label: r.label,
    category: categorizeField(r.setting, "BCM Proxi"),
  }));
}

/* Decode one DEnn DID response. `request` is the DID hex (e.g. "DE00",
 * "de07" — case-insensitive). `bytes` is the response payload, with
 * the leading `0x62 DID-hi DID-lo` already stripped by the caller. */
export function decodeDeDid(request, bytes) {
  const req = String(request || "").toUpperCase();
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const rows = DE_FEATURE_CATALOG.filter((r) => r.request.toUpperCase() === req);
  return rows.map((r) => {
    const raw = readBits(buf, r.bit, r.length);
    return {
      source: r.request,
      request: r.request,
      groupName: r.groupName,
      name: r.name,
      bit: r.bit,
      length: r.length,
      raw,
      label: labelForDeRow(r, raw),
      category: categorizeField(r.name, r.groupName),
    };
  });
}

/* Decode an entire native FCA PROXI binary (DID 0xFD01 / 0xFD20).
 * Walks every parsed section, runs `decodeProxiSection` against the
 * catalog for the requested variant, and returns rows in the same
 * shape as `decodeDeDid` so the panel can mix them with DEnn rows.
 *
 *   bytes   — raw PROXI binary (Uint8Array or ArrayBuffer)
 *   variant — module variant id, e.g. "GPEC2A". Wildcard "*" rows
 *             always apply.
 *
 * Returns { ok, rows, sections, error? } where:
 *   ok       — parseProxi succeeded
 *   rows     — flat array of decoded rows (empty when ok=false)
 *   sections — [{id, name, payload, decodedCount}] for the section
 *              header strip in the UI
 *   error    — set when ok=false (CRC mismatch, short buffer, etc.) */
export function decodeFcaProxiRecord(bytes, variant = "GPEC2A") {
  const parsed = parseProxi(bytes);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, rows: [], sections: [] };
  }
  const rows = [];
  const sections = [];
  for (const s of parsed.sections) {
    const decoded = decodeProxiSection(s.id, variant, s.payload);
    sections.push({
      id: s.id,
      name: s.name,
      payload: s.payload,
      decodedCount: decoded.length,
    });
    const sectionHex = s.id.toString(16).toUpperCase().padStart(2, "0");
    for (const d of decoded) {
      rows.push({
        source: "FD01",
        request: `S${sectionHex}`,                  // groups by section in the panel
        groupName: `${s.name} (PROXI section 0x${sectionHex})`,
        name: d.name,
        bit: d.byte * 8 + d.bit,                    // bit offset within payload
        length: d.length,
        raw: d.raw,
        label: d.label,
        category: categorizeField(d.name, s.name),
      });
    }
  }
  return { ok: true, rows, sections, parsed };
}

/* Catalog-only browse rows for the native PROXI sections — used by
 * the panel before any FD01 dump has been pasted, so the field map
 * is still visible as a reference (raw=null, label="—"). */
export function proxiSectionCatalogRows(variant = "GPEC2A") {
  const rows = [];
  for (const sectionId of Object.keys(PROXI_SECTION_NAMES).map(Number)) {
    const fields = getProxiFields(sectionId, variant);
    if (fields.length === 0) continue;
    const sectionHex = sectionId.toString(16).toUpperCase().padStart(2, "0");
    const sectionName = PROXI_SECTION_NAMES[sectionId];
    for (const f of fields) {
      rows.push({
        source: "FD01",
        request: `S${sectionHex}`,
        groupName: `${sectionName} (PROXI section 0x${sectionHex})`,
        name: f.name,
        bit: f.byte * 8 + f.bit,
        length: f.length,
        raw: null,
        label: "—",
        category: categorizeField(f.name, sectionName),
      });
    }
  }
  return rows;
}

/* The full DE catalog as decode rows, with no bytes supplied — used by
 * the panel as a feature-matrix reference when nothing has been read
 * yet (raw=null, label="—"). */
export function deCatalogRows() {
  return DE_FEATURE_CATALOG.map((r) => ({
    source: r.request,
    request: r.request,
    groupName: r.groupName,
    name: r.name,
    bit: r.bit,
    length: r.length,
    raw: null,
    label: "—",
    category: categorizeField(r.name, r.groupName),
  }));
}

function labelForDeRow(row, raw) {
  if (raw === null || raw === undefined) return "(out of range)";
  if (!row.options || row.options.length === 0) {
    return `${raw} (0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
  }
  const hit = row.options.find((o) => o.value === raw);
  if (hit) return `${raw}: ${hit.label}`;
  return `(unknown value 0x${raw.toString(16).toUpperCase().padStart(2, "0")})`;
}

/* Convenience: every known DE DID in catalog order. The Proxi tab uses
 * this to drive its "read all DEnn" loop and to render group headers
 * even before any read has happened. */
export const DE_DIDS = DE_GROUPS.map((g) => ({
  did: g.request,                        // e.g. "DE00"
  didNumber: parseInt(g.request, 16),    // e.g. 0xDE00 = 56832
  groupName: g.groupName,
  count: g.count,
}));

/* Group decoded rows by category for the sidebar count badges. */
export function countByCategory(rows) {
  const out = {};
  for (const c of CATEGORY_DEFS) out[c.id] = 0;
  for (const r of rows) out[r.category] = (out[r.category] || 0) + 1;
  return out;
}

/* Group decoded rows by `request` (DID hex) preserving first-seen order. */
export function groupByRequest(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.request)) out.set(r.request, []);
    out.get(r.request).push(r);
  }
  return out;
}
