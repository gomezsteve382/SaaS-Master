/* ============================================================================
 * smartBoxAnalyzer.js — PURE, read-only analyzer for Dodge Journey "SmartBox"
 * immobilizer EEPROM dumps (Freescale MC9S12XEG384, external 24C32 4 KB EEE).
 *
 * Scope: extract VIN + immo-relevant identifier fields from a 4096-byte
 * SmartBox EEE image. NO write path — every label below is BENCH-UNCONFIRMED
 * (reverse-engineered from a corpus of staged Journey SmartBox dumps), so this
 * module never mutates bytes and the UI never offers an "apply" form.
 *
 * IMPORTANT — family overlap with RFHUB Gen2:
 *   The SmartBox EEE shares the same 24C32 part-number ASCII block
 *   ("AA40712804AA61614486@") AND the same 4 reversed-VIN slots
 *   (0x0EA5 / 0x0EB9 / 0x0ECD / 0x0EE1) as Stellantis RFHUB Gen2 EEE dumps.
 *   They are the same EEPROM family and are NOT reliably distinguishable by
 *   content alone. For that reason `isSmartBoxImage()` is a *family* heuristic
 *   ("looks like a 24C32 SmartBox/RFHUB-Gen2 EEE"), and it is deliberately
 *   NOT wired into parseModule's auto-detect — doing so would mis-route real
 *   RFHUB dumps. This analyzer is reached only through its own dedicated upload.
 *
 * Difference from RFHUB Gen2: the SmartBox stores a 2-byte VIN checksum
 * trailer at +17/+18 of each VIN record (RFHUB Gen2 uses a single-byte
 * xor^magic at +17). The trailer's exact algorithm is unconfirmed, so it is
 * surfaced raw with a mirror-consistency flag only — never recomputed.
 *
 * Record layout (stride 0x14 = 20 bytes), 4 mirrored copies:
 *   [-1]  0xFE record marker
 *   [0..16]  17 VIN chars stored BYTE-REVERSED
 *   [17..18] 2-byte VIN checksum trailer (algorithm unconfirmed)
 * ========================================================================== */

export const SMARTBOX_SIZE = 4096;
export const SMARTBOX_CHIP = "MC9S12XEG384 + 24C32 EEE";
export const SMARTBOX_VIN_BASE = 0x0ea5;
export const SMARTBOX_VIN_STRIDE = 0x14;
export const SMARTBOX_VIN_COUNT = 4;
export const SMARTBOX_VIN_OFFSETS = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
export const SMARTBOX_REC_MARKER = 0xfe;
export const SMARTBOX_VIN_LEN = 17;
export const SMARTBOX_TRAILER_LEN = 2;
export const SMARTBOX_PART_OFFSET = 0x808;

// 17-char VIN alphabet (ISO 3779: no I, O, Q).
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const hex = (b) =>
  Array.from(b)
    .map((x) => x.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");

const offHex = (o) => "0x" + o.toString(16).toUpperCase().padStart(4, "0");

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return null;
}

/* Read 17 bytes at `off`, byte-reverse them, and return the VIN string if
 * every byte is a printable ASCII character; otherwise return null. The
 * `valid` flag separately reports whether the reversed string is a
 * well-formed 17-char VIN (alphabet + length). */
function readReversedVin(bytes, off) {
  if (off + SMARTBOX_VIN_LEN > bytes.length) {
    return { raw: null, vin: null, valid: false };
  }
  const slice = bytes.slice(off, off + SMARTBOX_VIN_LEN);
  const reversed = Array.from(slice).reverse();
  // All-blank (0xFF / 0x00) slots are virgin, not VINs.
  const allBlank = reversed.every((b) => b === 0xff || b === 0x00);
  let printable = true;
  for (const b of reversed) {
    if (b < 0x20 || b > 0x7e) {
      printable = false;
      break;
    }
  }
  const vin = printable && !allBlank ? String.fromCharCode(...reversed) : null;
  return {
    raw: hex(slice),
    vin,
    valid: !!vin && VIN_RE.test(vin),
  };
}

/* Classify a 2-byte trailer. 'BLANK' = unwritten (all-FF / all-00);
 * 'SET' = populated. The underlying checksum algorithm is unconfirmed, so we
 * never assert "valid" vs "stale" — only blank vs set. */
function classifyTrailer(b0, b1) {
  if ((b0 === 0xff && b1 === 0xff) || (b0 === 0x00 && b1 === 0x00)) return "BLANK";
  return "SET";
}

/* Pull printable ASCII runs (length >= minLen) out of a byte window, tagged
 * with their absolute offset. Used to surface part-number / serial strings
 * without hard-coding offsets that vary across module revisions. */
export function extractAsciiStrings(bytes, { minLen = 5, from = 0, to = null } = {}) {
  const end = to == null ? bytes.length : Math.min(to, bytes.length);
  const out = [];
  let cur = "";
  let start = -1;
  for (let i = from; i < end; i++) {
    const c = bytes[i];
    if (c >= 0x20 && c <= 0x7e) {
      if (cur === "") start = i;
      cur += String.fromCharCode(c);
    } else {
      if (cur.length >= minLen) out.push({ offset: start, offsetHex: offHex(start), text: cur });
      cur = "";
    }
  }
  if (cur.length >= minLen) out.push({ offset: start, offsetHex: offHex(start), text: cur });
  return out;
}

/* Heuristic FAMILY check: does this look like a 24C32 SmartBox / RFHUB-Gen2
 * EEE image? True when the buffer is 4 KB AND at least one of the canonical
 * reversed-VIN slots holds a well-formed 17-char VIN.
 *
 * The 0xFE record marker is informational only — it is NOT required, because
 * the corpus shows it is inconsistent (some genuine dumps store 0x00 at
 * VIN-1). A VIN-less (virgin / freshly-erased) SmartBox cannot be told apart
 * from any other blank 24C32, so this returns false for those — honest, not a
 * miss. NOTE: returns true for programmed RFHUB Gen2 dumps too (shared
 * layout); deliberately NOT wired into parseModule auto-detect. */
export function isSmartBoxImage(input) {
  const bytes = toU8(input);
  if (!bytes || bytes.length !== SMARTBOX_SIZE) return false;
  for (const off of SMARTBOX_VIN_OFFSETS) {
    const { valid } = readReversedVin(bytes, off);
    if (valid) return true;
  }
  return false;
}

/* Main entry point. Returns a structured, read-only report. Never throws on a
 * malformed buffer — sets ok:false with an `error` string instead. */
export function analyzeSmartBox(input) {
  const bytes = toU8(input);
  if (!bytes) {
    return { ok: false, error: "Not a byte buffer.", vinRecords: [] };
  }

  const sizeOk = bytes.length === SMARTBOX_SIZE;

  const vinRecords = SMARTBOX_VIN_OFFSETS.map((off, index) => {
    const markerOffset = off - 1;
    const marker = markerOffset >= 0 ? bytes[markerOffset] : null;
    const { raw, vin, valid } = readReversedVin(bytes, off);
    const tOff = off + SMARTBOX_VIN_LEN;
    const t0 = tOff < bytes.length ? bytes[tOff] : null;
    const t1 = tOff + 1 < bytes.length ? bytes[tOff + 1] : null;
    const trailerHex =
      t0 == null
        ? null
        : hex(bytes.slice(tOff, Math.min(tOff + SMARTBOX_TRAILER_LEN, bytes.length)));
    return {
      index,
      offset: off,
      offsetHex: offHex(off),
      markerOffset,
      marker,
      markerOk: marker === SMARTBOX_REC_MARKER,
      raw,
      vin,
      valid,
      trailerOffset: tOff,
      trailerOffsetHex: offHex(tOff),
      trailerHex,
      trailerState: t0 == null ? "MISSING" : classifyTrailer(t0, t1),
    };
  });

  // VIN consensus across the 4 mirrors.
  const validVins = vinRecords.filter((r) => r.valid).map((r) => r.vin);
  const distinctVins = Array.from(new Set(validVins));
  const consensusVin = distinctVins.length === 1 ? distinctVins[0] : null;
  const vinConsistent = distinctVins.length <= 1;

  // Trailer mirror-consistency (only over SET trailers).
  const setTrailers = vinRecords
    .filter((r) => r.trailerState === "SET")
    .map((r) => r.trailerHex);
  const distinctTrailers = Array.from(new Set(setTrailers));
  const trailerMirrorsConsistent = distinctTrailers.length <= 1;

  // Identifier strings (part numbers / serials) live in the 0x7B0..0x100F
  // region in the corpus; widen a bit for safety and filter out filler runs
  // ("PPPPP", "UUUU" padding artefacts).
  const FILLER_RE = /^(.)\1+$/; // single repeated char
  const identifiers = extractAsciiStrings(bytes, { minLen: 5, from: 0x780, to: 0x1000 })
    .filter((s) => !FILLER_RE.test(s.text))
    // Drop the VIN slots themselves (already surfaced as vinRecords).
    .filter((s) => !SMARTBOX_VIN_OFFSETS.includes(s.offset));

  // Verdict.
  let state;
  if (!sizeOk) state = "UNKNOWN SIZE";
  else if (validVins.length === 0) state = "VIRGIN / NO VIN";
  else if (!vinConsistent) state = "VIN MISMATCH";
  else state = "PROGRAMMED";

  // Confidence that this is a genuine SmartBox/RFHUB-Gen2 EEE image.
  let confidence = 0;
  if (sizeOk) confidence += 40;
  confidence += Math.min(vinRecords.filter((r) => r.markerOk).length, 4) * 5; // up to 20
  confidence += Math.min(validVins.length, 4) * 8; // up to 32
  if (consensusVin) confidence += 8;
  confidence = Math.min(confidence, 100);

  return {
    ok: true,
    sizeOk,
    sizeBytes: bytes.length,
    sizeLabel: sizeOk ? "4 KB (24C32)" : `${bytes.length} B (non-canonical)`,
    chip: SMARTBOX_CHIP,
    vinRecords,
    consensusVin,
    vinConsistent,
    validVinCount: validVins.length,
    distinctVins,
    vinChecksum: {
      note: "2-byte trailer @ VIN+17; algorithm bench-unconfirmed, surfaced raw.",
      trailerMirrorsConsistent,
      distinctTrailers,
    },
    identifiers,
    partNumberOffsetHex: offHex(SMARTBOX_PART_OFFSET),
    state,
    confidence,
    isSmartBoxLike: isSmartBoxImage(bytes),
  };
}
