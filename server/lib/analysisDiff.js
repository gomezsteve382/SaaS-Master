/* analysisDiff.js — side-by-side analysis comparator (Task #692).
 *
 * Takes two backup/analysis blobs (each with a `dids` map, `module`, `vin`,
 * optional `rawBytes`, and optional `parseResult` from parseModule) and
 * returns a structured diff result that the AnalysisDiffView component
 * renders and the programmer-block export consumes.
 *
 * Return shape:
 *   {
 *     metadata: MetadataRecord,   // top-level named fields (module, VIN, security…)
 *     fields:   FieldRecord[],    // per-DID comparison rows
 *     regions:  RegionRecord[],   // byte-level diff per differing DID payload
 *     summary:  SummaryRecord,    // aggregate counts
 *   }
 *
 * MetadataRecord — named analysis fields extracted from well-known DIDs:
 *   { moduleType, vin, securityBytes, skimBytes, calibrationId,
 *     softwareVersion, hardwareNumber, aA, aB (raw values side A/B) }
 *
 * FieldRecord:
 *   { did, label, category, aHex, bHex, aAscii, bAscii, status }
 *   status: 'same' | 'a_only' | 'b_only' | 'different'
 *   category: one of FIELD_CATEGORIES
 *
 * RegionRecord (differing DIDs only):
 *   { did, label, didHex, aBytes, bBytes,
 *     diffIndices,      — 0-based indices within each DID payload
 *     contiguousRanges, — [{start, end, length}] contiguous diff spans
 *     aHex, bHex }
 *
 * SummaryRecord:
 *   { total, same, different, aOnly, bOnly,
 *     moduleA, moduleB, vinA, vinB, timestampA, timestampB }
 *
 * Programmer-block rows (from buildProgrammerBlock):
 *   { type, offset, current, target, label }
 *   type:   'uds_did_write' — explicit UDS 0x2E DID write operation
 *   offset: UDS DID address as '0xF190' hex string
 *   current: A-side payload hex (the value currently in the module)
 *   target:  B-side payload hex (the value to be written)
 *   label:   human-readable DID name
 *
 * The output feeds the WORKFLOW Fix Plan builder, which consumes
 * {offset,current,target,label} as program-step descriptors.
 */

const hx2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

/* ── Well-known FCA/UDS DID catalog ───────────────────────────────────
 * Maps DID number (decimal) → { label, category }.
 * Used to surface named analysis fields in the metadata section and to
 * categorize DID rows in the field table for grouping / priority ordering.
 *
 * Categories mirror the analysis sections parseModule produces so the
 * diff UI can use the same vocabulary as the Module Inspector.
 */
export const FIELD_CATEGORIES = {
  IDENTITY:     "Identity",
  VIN:          "VIN",
  SECURITY:     "Security / Pairing",
  CALIBRATION:  "Calibration / Software",
  SKIM:         "SKIM / Immobilizer",
  CONFIGURATION:"Configuration",
  DIAGNOSTIC:   "Diagnostics",
  OTHER:        "Other",
};

/* DID number → { label, category } for every DID with a known role in
 * FCA/Stellantis ECU analysis.  Decimal keys so they match the numeric
 * keys the `dids` map uses at runtime. */
export const WELL_KNOWN_DIDS = {
  // VIN block
  61840: { label: "VIN",                              category: FIELD_CATEGORIES.VIN },
  31632: { label: "VIN (mirror 0x7B90)",              category: FIELD_CATEGORIES.VIN },
  31624: { label: "VIN (mirror 0x7B88)",              category: FIELD_CATEGORIES.VIN },
  // ECU identity
  61841: { label: "ECU Hardware Part Number",         category: FIELD_CATEGORIES.IDENTITY },
  61842: { label: "System Name / Engine Type",        category: FIELD_CATEGORIES.IDENTITY },
  61843: { label: "VIN System",                       category: FIELD_CATEGORIES.IDENTITY },
  61833: { label: "Boot Software ID",                 category: FIELD_CATEGORIES.IDENTITY },
  61834: { label: "Application Software ID",         category: FIELD_CATEGORIES.IDENTITY },
  61836: { label: "Calibration / Tune ID",            category: FIELD_CATEGORIES.CALIBRATION },
  61832: { label: "Software Version Number",          category: FIELD_CATEGORIES.CALIBRATION },
  61835: { label: "Application Data ID",              category: FIELD_CATEGORIES.CALIBRATION },
  61837: { label: "Calibration Verification Number",  category: FIELD_CATEGORIES.CALIBRATION },
  61838: { label: "Spare Part Number",                category: FIELD_CATEGORIES.IDENTITY },
  61839: { label: "ECU Serial Number",                category: FIELD_CATEGORIES.IDENTITY },
  // Security / pairing
  20360: { label: "BCM SEC16 Pairing Key",            category: FIELD_CATEGORIES.SECURITY },
  20369: { label: "RFHUB SEC16 Pairing Key",          category: FIELD_CATEGORIES.SECURITY },
  20361: { label: "Security Bytes (alt)",             category: FIELD_CATEGORIES.SECURITY },
  16896: { label: "SKIM Status",                      category: FIELD_CATEGORIES.SKIM },
  16897: { label: "SKIM Key Count",                   category: FIELD_CATEGORIES.SKIM },
  16898: { label: "SKIM Transponder Data",            category: FIELD_CATEGORIES.SKIM },
  // Configuration
  8227:  { label: "BCM PROXI Config (0x2023)",        category: FIELD_CATEGORIES.CONFIGURATION },
  57480: { label: "Body Config (DE00)",               category: FIELD_CATEGORIES.CONFIGURATION },
  // Diagnostics
  61824: { label: "Supported DIDs",                   category: FIELD_CATEGORIES.DIAGNOSTIC },
  61825: { label: "Supported Memory Addresses",       category: FIELD_CATEGORIES.DIAGNOSTIC },
};

/* Named top-level analysis fields — extracted from well-known DID values. */
const ANALYSIS_FIELD_DIDS = {
  vin:             [61840, 31632, 31624],  // first populated wins
  securityBytes:   [20360, 20369, 20361],
  skimBytes:       [16896, 16897],
  calibrationId:   [61836, 61834],
  softwareVersion: [61832],
  hardwareNumber:  [61841],
};

export function hexToBytes(hexStr) {
  if (!hexStr || typeof hexStr !== "string") return null;
  const clean = hexStr.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  if (!bytes || !bytes.length) return "";
  return Array.from(bytes).map(hx2).join(" ");
}

function didLabel(didNum, didRecord) {
  if (WELL_KNOWN_DIDS[didNum]) return WELL_KNOWN_DIDS[didNum].label;
  const name = didRecord?.name;
  if (name) return name;
  return "DID 0x" + didNum.toString(16).toUpperCase().padStart(4, "0");
}

function didCategory(didNum, didRecord) {
  if (WELL_KNOWN_DIDS[didNum]) return WELL_KNOWN_DIDS[didNum].category;
  if (didRecord?.critical) return FIELD_CATEGORIES.SECURITY;
  return FIELD_CATEGORIES.OTHER;
}

/* Build contiguous differing byte ranges from a sorted array of diff indices. */
function buildContiguousRanges(diffIndices) {
  if (!diffIndices.length) return [];
  const ranges = [];
  let start = diffIndices[0], prev = diffIndices[0];
  for (let i = 1; i < diffIndices.length; i++) {
    if (diffIndices[i] === prev + 1) {
      prev = diffIndices[i];
    } else {
      ranges.push({ start, end: prev, length: prev - start + 1 });
      start = diffIndices[i];
      prev = diffIndices[i];
    }
  }
  ranges.push({ start, end: prev, length: prev - start + 1 });
  return ranges;
}

/* Compute byte-level diff between two hex strings.
 * Indices are relative to each DID payload (0-based within the DID value). */
export function computeByteDiff(aHex, bHex) {
  const aB = hexToBytes(aHex) || new Uint8Array(0);
  const bB = hexToBytes(bHex) || new Uint8Array(0);
  const len = Math.max(aB.length, bB.length);
  const aP = new Uint8Array(len);
  const bP = new Uint8Array(len);
  aP.set(aB);
  bP.set(bB);
  const diffIndices = [];
  for (let i = 0; i < len; i++) {
    if (aP[i] !== bP[i]) diffIndices.push(i);
  }
  return {
    aBytes: aP,
    bBytes: bP,
    diffIndices,
    contiguousRanges: buildContiguousRanges(diffIndices),
  };
}

/* Extract named top-level analysis fields from a DID map.
 * Returns the first non-empty value found across the candidate DIDs for each
 * named field — mirrors what parseModule surfaces as top-level properties on
 * its return value, so the diff metadata section uses the same vocabulary as
 * the Module Inspector. */
function extractNamedFields(dids) {
  if (!dids || typeof dids !== "object") {
    return { vin: null, securityBytes: null, skimBytes: null,
             calibrationId: null, softwareVersion: null, hardwareNumber: null };
  }
  const pick = (candidates) => {
    for (const did of candidates) {
      const rec = dids[did];
      if (rec && !rec.missing && (rec.hex || rec.ascii)) {
        return { hex: rec.hex || null, ascii: rec.ascii || null, did };
      }
    }
    return null;
  };
  return {
    vin:             pick(ANALYSIS_FIELD_DIDS.vin),
    securityBytes:   pick(ANALYSIS_FIELD_DIDS.securityBytes),
    skimBytes:       pick(ANALYSIS_FIELD_DIDS.skimBytes),
    calibrationId:   pick(ANALYSIS_FIELD_DIDS.calibrationId),
    softwareVersion: pick(ANALYSIS_FIELD_DIDS.softwareVersion),
    hardwareNumber:  pick(ANALYSIS_FIELD_DIDS.hardwareNumber),
  };
}

/* Build the metadata diff section from two blobs — the top-level named
 * analysis fields that parseModule would normally surface.  Each field
 * carries side-A value, side-B value, and a match flag. */
function buildMetadata(blobA, blobB) {
  const fieldsA = extractNamedFields(blobA?.dids);
  const fieldsB = extractNamedFields(blobB?.dids);

  const diff = (a, b) => {
    const aVal = a?.hex ?? a?.ascii ?? null;
    const bVal = b?.hex ?? b?.ascii ?? null;
    const match = aVal === bVal;
    return { a, b, match };
  };

  return {
    moduleType:      { a: blobA?.module || null, b: blobB?.module || null, match: blobA?.module === blobB?.module },
    vin:             diff(fieldsA.vin, fieldsB.vin),
    securityBytes:   diff(fieldsA.securityBytes, fieldsB.securityBytes),
    skimBytes:       diff(fieldsA.skimBytes, fieldsB.skimBytes),
    calibrationId:   diff(fieldsA.calibrationId, fieldsB.calibrationId),
    softwareVersion: diff(fieldsA.softwareVersion, fieldsB.softwareVersion),
    hardwareNumber:  diff(fieldsA.hardwareNumber, fieldsB.hardwareNumber),
  };
}

/* ── Raw-bytes (full binary dump) diffing ─────────────────────────────
 *
 * When a backup blob carries a `rawBytes` field (Uint8Array or
 * number[]) representing the full module binary image, `compareAnalyses`
 * computes a raw-file-offset diff in addition to the DID-level diff.
 *
 * RawByteRegion:
 *   { offset,        — absolute byte offset in the file (decimal int)
 *     offsetHex,     — "0x004B20" hex string
 *     length,        — number of bytes in this contiguous differing span
 *     aHex,          — hex string of A-side bytes at this range
 *     bHex,          — hex string of B-side bytes at this range
 *     diffIndices }  — indices (relative to region start) within the span
 *
 * Programmer-block rows for raw regions use type: 'raw_patch'.
 */

function toUint8Array(v) {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  return null;
}

/**
 * Compute a true file-offset byte diff between two full binary images.
 *
 * Returns contiguous spans of differing bytes with absolute file offsets.
 * If the images are different lengths the shorter is zero-padded.
 *
 * @param {Uint8Array|number[]} bytesA
 * @param {Uint8Array|number[]} bytesB
 * @returns {{ rawByteRegions: RawByteRegion[], totalDiffBytes: number }}
 */
export function compareRawBytes(bytesA, bytesB) {
  const a = toUint8Array(bytesA);
  const b = toUint8Array(bytesB);
  if (!a && !b) return { rawByteRegions: [], totalDiffBytes: 0 };

  const lenA = a ? a.length : 0;
  const lenB = b ? b.length : 0;
  const len  = Math.max(lenA, lenB);

  const diffPositions = [];
  for (let i = 0; i < len; i++) {
    const av = i < lenA ? a[i] : 0;
    const bv = i < lenB ? b[i] : 0;
    if (av !== bv) diffPositions.push(i);
  }

  if (!diffPositions.length) return { rawByteRegions: [], totalDiffBytes: 0 };

  /* Group adjacent diff positions into contiguous spans. */
  const spans = [];
  let spanStart = diffPositions[0], spanPrev = diffPositions[0];
  for (let i = 1; i < diffPositions.length; i++) {
    if (diffPositions[i] === spanPrev + 1) {
      spanPrev = diffPositions[i];
    } else {
      spans.push({ start: spanStart, end: spanPrev });
      spanStart = diffPositions[i];
      spanPrev  = diffPositions[i];
    }
  }
  spans.push({ start: spanStart, end: spanPrev });

  const regions = spans.map(({ start, end }) => {
    const length = end - start + 1;
    const aSlice = new Uint8Array(length);
    const bSlice = new Uint8Array(length);
    for (let j = 0; j < length; j++) {
      aSlice[j] = start + j < lenA ? a[start + j] : 0;
      bSlice[j] = start + j < lenB ? b[start + j] : 0;
    }
    const diffIndices = [];
    for (let j = 0; j < length; j++) {
      if (aSlice[j] !== bSlice[j]) diffIndices.push(j);
    }
    return {
      offset:    start,
      offsetHex: "0x" + start.toString(16).toUpperCase().padStart(6, "0"),
      length,
      aHex: Array.from(aSlice).map(hx2).join(" "),
      bHex: Array.from(bSlice).map(hx2).join(" "),
      diffIndices,
    };
  });

  return { rawByteRegions: regions, totalDiffBytes: diffPositions.length };
}

/* ── parseModule-field diffing ─────────────────────────────────────────
 *
 * When a backup blob carries a `parseResult` field (the object returned
 * by `parseModule(rawBytes, filename)`) the comparator extracts a flat
 * list of named fields and compares them side-by-side.
 *
 * This surfaces every structural field parseModule derives from the raw
 * binary image: module type classification, every VIN slot at its raw
 * offset, SKIM/immobilizer state, secret keys, transponder key slots,
 * part number, runtime counters, tamper flag, SEC16, etc.
 *
 * ParsedFieldRecord:
 *   { label, aVal, bVal, status }
 *   status: 'same' | 'a_only' | 'b_only' | 'different'
 */

/** Ordered list of extractors — each maps a parseModule `info` object to
 *  a human-readable label + scalar string value.  Extractors that return
 *  null/undefined are silently skipped so the list stays clean when a
 *  field doesn't apply to the module family. */
const PARSE_FIELD_EXTRACTORS = [
  { label: "Module Type",            get: (i) => i.type },
  { label: "Module Name",            get: (i) => i.name && i.name !== i.type ? i.name : null },
  { label: "Size",                   get: (i) => i.size != null ? i.size + " bytes" : null },
  { label: "Part Number",            get: (i) => i.partNumberStr },
  { label: "VIN (binary)",           get: (i) => i.vin || i.vins?.[0]?.vin || null },
  { label: "SEC16",                  get: (i) => i.sec16?.hex ?? (typeof i.sec16 === "string" ? i.sec16 : null) },
  { label: "SEC16 Mirror",           get: (i) => i.sec16Mirror?.hex ?? null },
  { label: "SKIM Status",            get: (i) => i.skimStatus },
  { label: "SKIM Byte",              get: (i) => i.skimByte != null ? "0x" + i.skimByte.toString(16).toUpperCase().padStart(2, "0") : null },
  { label: "Secret Key",             get: (i) => i.secretKey?.hex },
  { label: "Secret Key Mirror",      get: (i) => i.secretKeyMirror?.hex },
  { label: "Key Consistent",         get: (i) => i.keyConsistent != null ? String(i.keyConsistent) : null },
  { label: "Tamper Flag",            get: (i) => i.zzzzTamper ? i.zzzzTamper.hex : null },
  { label: "Counter A",              get: (i) => i.runtimeCounters?.counterA != null ? String(i.runtimeCounters.counterA.value) : null },
  { label: "Counter B",              get: (i) => i.runtimeCounters?.counterB != null ? String(i.runtimeCounters.counterB.value) : null },
  { label: "Distance Counter",       get: (i) => i.runtimeCounters?.distance != null ? String(i.runtimeCounters.distance.value) : null },
  { label: "Key Cycles",             get: (i) => i.runtimeCounters?.keyCycles != null ? String(i.runtimeCounters.keyCycles.value) : null },
];

/** Flatten a parseModule info object into `{label,value}` pairs. */
function normalizeParseResult(info) {
  if (!info) return [];
  const rows = [];
  for (const { label, get } of PARSE_FIELD_EXTRACTORS) {
    const v = get(info);
    if (v !== null && v !== undefined && v !== "") rows.push({ label, value: String(v) });
  }
  /* VIN slots beyond slot 0 */
  if (Array.isArray(info.vins)) {
    info.vins.forEach((slot, idx) => {
      if (idx === 0) return;
      if (slot?.vin) rows.push({ label: "VIN Slot " + idx + " (0x" + slot.offset.toString(16).toUpperCase() + ")", value: slot.vin });
    });
  }
  /* Transponder key slots */
  if (Array.isArray(info.transponderKeys)) {
    info.transponderKeys.forEach((k, idx) => {
      if (k?.hex) rows.push({ label: "Transponder Key " + idx, value: k.hex });
    });
  }
  return rows;
}

/**
 * Diff two parseModule result objects and return a list of field rows.
 *
 * @param {object|null} parseA  — parseModule result for blob A (optional)
 * @param {object|null} parseB  — parseModule result for blob B (optional)
 * @returns {Array<{label,aVal,bVal,status}>|null}
 *   null when neither blob provided a parseResult.
 */
export function diffParseResult(parseA, parseB) {
  if (!parseA && !parseB) return null;
  const aRows = normalizeParseResult(parseA);
  const bRows = normalizeParseResult(parseB);
  const aMap = new Map(aRows.map((r) => [r.label, r.value]));
  const bMap = new Map(bRows.map((r) => [r.label, r.value]));
  const allLabels = new Set([...aMap.keys(), ...bMap.keys()]);
  const rows = [];
  for (const label of allLabels) {
    const aVal = aMap.get(label) ?? null;
    const bVal = bMap.get(label) ?? null;
    let status;
    if (!aVal && bVal) status = "b_only";
    else if (aVal && !bVal) status = "a_only";
    else if (aVal === bVal) status = "same";
    else status = "different";
    rows.push({ label, aVal, bVal, status });
  }
  /* Stable order: put differing rows first, then same. */
  rows.sort((a, b) => {
    const order = { different: 0, a_only: 1, b_only: 2, same: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.label.localeCompare(b.label);
  });
  return rows;
}

/**
 * Compare two backup / analysis blobs.
 *
 * Accepts any backup object that has a `dids` map.  When both blobs
 * also carry:
 *   - `rawBytes` (Uint8Array/number[] of the full module binary image),
 *     a raw-file-offset diff is computed and surfaced as `rawByteRegions`.
 *   - `parseResult` (the object returned by `parseModule(rawBytes)`),
 *     all parsed module fields are compared and surfaced as `parsedFields`.
 *
 * @param {object} blobA  — backup A (.dids required; .rawBytes/.parseResult optional)
 * @param {object} blobB  — backup B
 * @returns {{ metadata, fields, regions, rawByteRegions, parsedFields, summary }}
 */
export function compareAnalyses(blobA, blobB) {
  const didsA = (blobA && typeof blobA.dids === "object" && blobA.dids) || {};
  const didsB = (blobB && typeof blobB.dids === "object" && blobB.dids) || {};

  const allKeys = new Set([...Object.keys(didsA), ...Object.keys(didsB)]);

  const fields = [];
  const regions = [];
  let same = 0, different = 0, aOnly = 0, bOnly = 0;

  for (const key of allKeys) {
    const didNum = parseInt(key, 10);
    const recA = didsA[key] || null;
    const recB = didsB[key] || null;
    const label = didLabel(didNum, recA || recB);
    const category = didCategory(didNum, recA || recB);

    const aHex = (!recA || recA.missing) ? null : (recA.hex || null);
    const bHex = (!recB || recB.missing) ? null : (recB.hex || null);
    const aAscii = recA?.ascii || null;
    const bAscii = recB?.ascii || null;

    let status;
    if (!recA && recB) {
      status = "b_only";
      bOnly++;
    } else if (recA && !recB) {
      status = "a_only";
      aOnly++;
    } else if ((aHex || "") === (bHex || "")) {
      status = "same";
      same++;
    } else {
      status = "different";
      different++;
    }

    fields.push({ did: didNum, label, category, aHex, bHex, aAscii, bAscii, status });

    if (status !== "same") {
      const { aBytes, bBytes, diffIndices, contiguousRanges } =
        computeByteDiff(aHex || "", bHex || "");
      regions.push({
        did: didNum,
        label,
        category,
        didHex: "0x" + didNum.toString(16).toUpperCase().padStart(4, "0"),
        aBytes,
        bBytes,
        diffIndices,
        contiguousRanges,
        aHex: aHex || "",
        bHex: bHex || "",
      });
    }
  }

  fields.sort((a, b) => a.did - b.did);
  regions.sort((a, b) => a.did - b.did);

  const metadata = buildMetadata(blobA, blobB);

  /* Raw-bytes diff (optional) — only when both blobs carry rawBytes. */
  let rawByteRegions = null;
  let totalRawDiffBytes = 0;
  if (blobA?.rawBytes && blobB?.rawBytes) {
    const raw = compareRawBytes(blobA.rawBytes, blobB.rawBytes);
    rawByteRegions    = raw.rawByteRegions;
    totalRawDiffBytes = raw.totalDiffBytes;
  }

  /* parseModule field diff (optional) — when either blob has parseResult. */
  const parsedFields = diffParseResult(blobA?.parseResult ?? null, blobB?.parseResult ?? null);
  const parsedDiff   = parsedFields ? parsedFields.filter((f) => f.status !== "same").length : 0;

  const summary = {
    total: fields.length,
    same,
    different,
    aOnly,
    bOnly,
    moduleA: blobA?.module || null,
    moduleB: blobB?.module || null,
    vinA: blobA?.vin || null,
    vinB: blobB?.vin || null,
    timestampA: blobA?.timestamp || null,
    timestampB: blobB?.timestamp || null,
    hasRawDiff: rawByteRegions !== null,
    totalRawDiffBytes,
    parsedDiff,
  };

  return { metadata, fields, regions, rawByteRegions, parsedFields, summary };
}

/**
 * Build a programmer block from a diff result.
 *
 * Emits two kinds of rows, both sharing the `{type,offset,current,target,label}`
 * contract consumed by the WORKFLOW Fix Plan builder:
 *
 *   type: 'uds_did_write'
 *     One row per differing DID field (UDS 0x2E WriteDataByIdentifier).
 *     offset:  UDS DID address  e.g. '0xF190'
 *     current: A-side DID payload hex
 *     target:  B-side DID payload hex
 *
 *   type: 'raw_patch'
 *     One row per contiguous differing region in the raw binary image
 *     (only present when the diff result has rawByteRegions).
 *     offset:  absolute file byte offset  e.g. '0x004B20'
 *     current: A-side bytes at that range
 *     target:  B-side bytes at that range
 *     label:   'Raw region at 0x004B20 (16 bytes)'
 *
 * @param {{ fields: Array, rawByteRegions: Array|null }} diffResult
 * @returns {Array<{ type: string, offset: string, current: string, target: string, label: string }>}
 */
export function buildProgrammerBlock(diffResult) {
  const rows = [];

  /* UDS DID write rows */
  const fields = diffResult?.fields;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f.status === "same") continue;
      rows.push({
        type:    "uds_did_write",
        offset:  "0x" + f.did.toString(16).toUpperCase().padStart(4, "0"),
        current: f.aHex || "(missing)",
        target:  f.bHex || "(missing)",
        label:   f.label,
      });
    }
  }

  /* Raw-patch rows (only when rawBytes were available on both blobs) */
  const rawByteRegions = diffResult?.rawByteRegions;
  if (Array.isArray(rawByteRegions)) {
    for (const r of rawByteRegions) {
      rows.push({
        type:    "raw_patch",
        offset:  r.offsetHex,
        current: r.aHex,
        target:  r.bHex,
        label:   "Raw region at " + r.offsetHex + " (" + r.length + " byte" + (r.length !== 1 ? "s" : "") + ")",
      });
    }
  }

  return rows;
}
