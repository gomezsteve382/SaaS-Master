/**
 * UDS Analyzer — share-link encode/decode.
 *
 * Encodes the current trace text as gzip + base64url and stuffs it into
 * the URL fragment under `#uds=...`. Opening that link rehydrates the
 * textarea and re-runs analyze.
 *
 * Uses the native CompressionStream / DecompressionStream API (gzip),
 * which is available in every browser SRT Lab already targets. Both
 * helpers are async because the streaming compression API is async.
 */

import { vinCheckDigitValid } from '../vin.js';
import { parseTrace } from './parser.js';
import { didEntry } from '@workspace/uds';

const FRAGMENT_KEY = 'uds';

// Placeholder substituted for real VINs in shared traces. Same 17-char width
// so column-aligned trace formats survive the rewrite. We deliberately use
// `I` characters (illegal in real VINs alongside `O`/`Q`) so a second pass
// of `findVinsInText` over a previously-scrubbed trace will skip the
// placeholder instead of treating it as a "real VIN detected" hit.
export const VIN_PLACEHOLDER = 'IIIIIIIIIIIIIIIII';

// VIN-shaped run: 17 chars from the legal VIN alphabet (no I, O, Q). We bound
// the match with non-VIN-char lookarounds so adjacent text doesn't extend the
// run (e.g. `3148475A4B433232333435360000` should yield exactly one VIN, not a
// shifted one). The check digit is verified per-match before scrubbing so we
// don't rewrite arbitrary 17-char hex blobs that happen to use the alphabet.
const VIN_RUN_RX = /(?<![A-HJ-NPR-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-HJ-NPR-Z0-9])/g;

/**
 * Find every distinct VIN-shaped substring in `text` whose check digit
 * validates. Returns an array of unique uppercase VINs in first-seen order.
 */
export function findVinsInText(text) {
  if (typeof text !== 'string' || text.length < 17) return [];
  const seen = new Set();
  const out = [];
  const matches = text.toUpperCase().match(VIN_RUN_RX);
  if (!matches) return out;
  for (const m of matches) {
    if (seen.has(m)) continue;
    if (!vinCheckDigitValid(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Replace every check-digit-valid VIN in `text` with `VIN_PLACEHOLDER`.
 * Case-insensitive on the VIN alphabet; surrounding text and whitespace
 * are preserved verbatim.
 */
export function scrubVinsFromText(text) {
  if (typeof text !== 'string' || text.length < 17) return text;
  const vins = findVinsInText(text);
  if (vins.length === 0) return text;
  let out = text;
  for (const vin of vins) {
    // Build a case-insensitive matcher for this exact VIN, with the same
    // non-VIN-char boundary lookarounds used during detection.
    const rx = new RegExp(`(?<![A-HJ-NPR-Z0-9])${vin}(?![A-HJ-NPR-Z0-9])`, 'gi');
    out = out.replace(rx, VIN_PLACEHOLDER);
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function gzip(bytes) {
  const cs = new CompressionStream('gzip');
  const stream = bytesToStream(bytes).pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = bytesToStream(bytes).pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Encode a trace string to a `#uds=...` fragment payload (no leading `#`).
 */
export async function encodeShareFragment(text) {
  if (!text) return '';
  const bytes = new TextEncoder().encode(text);
  const gz = await gzip(bytes);
  return `${FRAGMENT_KEY}=${bytesToBase64Url(gz)}`;
}

/**
 * Build a fully-qualified share URL for the current location.
 */
export async function buildShareUrl(text, location = window.location) {
  const frag = await encodeShareFragment(text);
  const base = `${location.origin}${location.pathname}${location.search}`;
  return frag ? `${base}#${frag}` : base;
}

/**
 * Decode a `#uds=...` fragment (with or without leading `#`) back to text.
 * Returns `null` if the fragment is absent / malformed.
 */
export async function decodeShareFragment(fragment) {
  if (!fragment) return null;
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const payload = params.get(FRAGMENT_KEY);
  if (!payload) return null;
  try {
    const gz = base64UrlToBytes(payload);
    const bytes = await gunzip(gz);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ── Sensitive-field scan / scrub (Task #756) ─────────────────────────
//
// Pre-share scan beyond VINs. Reuses parseTrace() (which already extracts
// service + DID per line) instead of re-regexing the raw text, so we
// inherit ISO-TP PCI stripping and shape detection. Categories covered:
//
//   - SecurityAccess seed responses   (0x67 SF<odd>  <seed>)
//   - SecurityAccess key requests     (0x27 SF<even> <key>)
//   - ECU hardware serial responses   (0x62 F1 8C    <serial>)
//   - Calibration ID responses        (0x62 F1 95    <calId>)
//   - 4–6 digit PIN-shaped runs inside known-catalog DID responses
//
// VINs remain a separate category — they are scrubbed at the text level
// (ASCII VIN strings) via the long-standing scrubVinsFromText() path.
// The sensitive-byte scrubber operates on the hex byte sequences inside
// each raw trace line, so it composes with VIN scrubbing without
// re-detecting already-anonymised data.

export const SENSITIVE_CATEGORY_LABELS = {
  vins:           'Real VIN(s)',
  seeds:          'SecurityAccess seed payload(s)',
  keys:           'SecurityAccess key payload(s)',
  ecuSerials:     'ECU hardware serial(s) (DID F1 8C)',
  calibrationIds: 'Calibration ID(s) (DID F1 95)',
  pins:           'PIN-shaped digit run(s) in DID response(s)',
};

function hexByte(b) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

function hexBytes(bytes) {
  return Array.from(bytes).map(hexByte).join(' ');
}

/**
 * Walk a 0x62 ReadDataByIdentifier response payload (bytes AFTER the
 * 0x62 SID echo) and yield one row per recognised DID. Uses the
 * @workspace/uds catalog: a known DID with a fixed `length` advances by
 * that many bytes; a known DID with variable length consumes the
 * remainder and ends the walk. An unknown DID stops the walk (we'd be
 * guessing where the next DID starts otherwise).
 */
function walkRdbiPayload(payload62) {
  const rows = [];
  let i = 0;
  while (i + 2 <= payload62.length) {
    const did = (payload62[i] << 8) | payload62[i + 1];
    const entry = didEntry(did);
    if (!entry) break;
    const len = entry.length;
    let dataLen;
    if (typeof len === 'number') {
      dataLen = len;
    } else {
      dataLen = payload62.length - (i + 2);
    }
    if (dataLen < 0 || i + 2 + dataLen > payload62.length) break;
    rows.push({
      did,
      dataBytes: payload62.slice(i + 2, i + 2 + dataLen),
    });
    i += 2 + dataLen;
    if (typeof len !== 'number') break;
  }
  return rows;
}

/**
 * Find runs of ASCII decimal digits of length 4–6 inside `dataBytes`,
 * bounded so longer digit blobs (date stamps, serial-number tails) do
 * not match. Returns the matched byte slices.
 */
function findAsciiDigitRuns(dataBytes) {
  const out = [];
  let i = 0;
  while (i < dataBytes.length) {
    if (dataBytes[i] >= 0x30 && dataBytes[i] <= 0x39) {
      let j = i;
      while (j < dataBytes.length && dataBytes[j] >= 0x30 && dataBytes[j] <= 0x39) j++;
      const runLen = j - i;
      if (runLen >= 4 && runLen <= 6) {
        out.push(dataBytes.slice(i, j));
      }
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Scan `text` for non-VIN identifiers that would leak through a share
 * link: SecurityAccess seed/key payloads, F1 8C ECU serials, F1 95
 * calibration IDs, and 4–6 digit PIN runs inside known DID responses.
 *
 * Returns one bucket per category, each a list of `{ bytes, rawLine, ... }`
 * descriptors. Empty buckets are present so the UI can render a stable
 * shape without `findings.seeds ?? []` guards everywhere.
 *
 * VINs are surfaced in their own bucket (delegated to findVinsInText)
 * so the confirm dialog can show every category in one grouped list.
 */
export function findSensitiveInText(text) {
  const out = {
    vins:           findVinsInText(text),
    seeds:          [],
    keys:           [],
    ecuSerials:     [],
    calibrationIds: [],
    pins:           [],
  };
  if (typeof text !== 'string' || !text.trim()) return out;

  let parsed;
  try {
    parsed = parseTrace(text);
  } catch {
    return out;
  }

  for (const line of parsed.lines) {
    const b = line.bytes;
    if (!b || !b.length) continue;

    // SecurityAccess seed: positive 0x67 response with odd sub-function.
    if (b[0] === 0x67 && b.length >= 3 && (b[1] & 0x01) === 1) {
      const seed = b.slice(2);
      if (seed.length > 0) {
        out.seeds.push({
          subFunction: b[1],
          bytes: seed,
          bytesHex: hexBytes(seed),
          rawLine: line.raw,
        });
      }
    }

    // SecurityAccess key: 0x27 request with even (non-zero) sub-function.
    if (
      line.dir === 'req' &&
      b[0] === 0x27 &&
      b.length >= 3 &&
      b[1] !== 0 &&
      (b[1] & 0x01) === 0
    ) {
      const key = b.slice(2);
      if (key.length > 0) {
        out.keys.push({
          subFunction: b[1],
          bytes: key,
          bytesHex: hexBytes(key),
          rawLine: line.raw,
        });
      }
    }

    // 0x62 ReadDataByIdentifier positive response — split into DID rows.
    if (b[0] === 0x62 && b.length >= 4) {
      const rows = walkRdbiPayload(b.slice(1));
      for (const row of rows) {
        if (row.dataBytes.length === 0) continue;
        if (row.did === 0xF18C) {
          out.ecuSerials.push({
            bytes: row.dataBytes,
            bytesHex: hexBytes(row.dataBytes),
            rawLine: line.raw,
          });
        } else if (row.did === 0xF195) {
          out.calibrationIds.push({
            bytes: row.dataBytes,
            bytesHex: hexBytes(row.dataBytes),
            rawLine: line.raw,
          });
        }
        // PIN scan applies to every known DID's data payload.
        const runs = findAsciiDigitRuns(row.dataBytes);
        for (const run of runs) {
          out.pins.push({
            did: row.did,
            didLabel: `0x${hexByte((row.did >> 8) & 0xFF)}${hexByte(row.did & 0xFF)}`,
            digits: String.fromCharCode(...run),
            bytes: run,
            bytesHex: hexBytes(run),
            rawLine: line.raw,
          });
        }
      }
    }
  }

  return out;
}

/**
 * True iff any sensitive category (including VINs) has at least one hit.
 */
export function hasSensitiveFindings(findings) {
  if (!findings) return false;
  return (
    (findings.vins?.length ?? 0) > 0 ||
    (findings.seeds?.length ?? 0) > 0 ||
    (findings.keys?.length ?? 0) > 0 ||
    (findings.ecuSerials?.length ?? 0) > 0 ||
    (findings.calibrationIds?.length ?? 0) > 0 ||
    (findings.pins?.length ?? 0) > 0
  );
}

/**
 * Replace a hex-byte sequence inside one raw trace line with `??` per
 * byte, preserving the original inter-byte whitespace (handles both
 * packed candump hex and space-separated TX/RX hex). Only the first
 * occurrence is rewritten — callers loop per-finding so each instance
 * gets its own replacement even when the same bytes recur in one line.
 */
function scrubBytesInLine(rawLine, bytes) {
  if (!rawLine || !bytes || !bytes.length) return rawLine;
  const pattern = bytes
    .map(b => {
      const h = hexByte(b);
      return `[${h[0].toLowerCase()}${h[0]}][${h[1].toLowerCase()}${h[1]}]`;
    })
    .join('\\s*');
  const rx = new RegExp(pattern);
  const m = rawLine.match(rx);
  if (!m) return rawLine;
  const matched = m[0];
  let replacement = '';
  let i = 0;
  while (i < matched.length) {
    if (/\s/.test(matched[i])) {
      replacement += matched[i];
      i++;
    } else {
      replacement += '??';
      i += 2;
    }
  }
  return rawLine.slice(0, m.index) + replacement + rawLine.slice(m.index + matched.length);
}

/**
 * Scrub every sensitive-byte run found by findSensitiveInText() from
 * `text`. VINs are scrubbed first via the existing text-level
 * substitution; remaining categories are scrubbed line-by-line in the
 * raw trace by rewriting their hex bytes to `??` of the same width.
 *
 * The output passes findSensitiveInText() with empty buckets across all
 * non-VIN categories — the placeholder `??` bytes never satisfy the
 * 0x67/0x27/0x62 detectors and never form ASCII digit runs.
 */
export function scrubSensitiveFromText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = scrubVinsFromText(text);

  let findings;
  try {
    findings = findSensitiveInText(out);
  } catch {
    return out;
  }

  // Group all non-VIN findings by their original raw-line text so we can
  // rewrite each unique trace line once per finding, then splice it back
  // into the full text. Multiple findings on the same line are applied
  // in order so each gets its own `??` replacement.
  const perLine = new Map(); // rawLine -> [bytes, bytes, ...]
  const push = (rawLine, bytes) => {
    if (!rawLine || !bytes?.length) return;
    if (!perLine.has(rawLine)) perLine.set(rawLine, []);
    perLine.get(rawLine).push(bytes);
  };
  for (const f of findings.seeds)          push(f.rawLine, f.bytes);
  for (const f of findings.keys)           push(f.rawLine, f.bytes);
  for (const f of findings.ecuSerials)     push(f.rawLine, f.bytes);
  for (const f of findings.calibrationIds) push(f.rawLine, f.bytes);
  for (const f of findings.pins)           push(f.rawLine, f.bytes);

  for (const [rawLine, bytesList] of perLine) {
    let rewritten = rawLine;
    for (const bytes of bytesList) {
      rewritten = scrubBytesInLine(rewritten, bytes);
    }
    if (rewritten !== rawLine) {
      // Replace the first occurrence of this raw line in the text.
      const idx = out.indexOf(rawLine);
      if (idx >= 0) {
        out = out.slice(0, idx) + rewritten + out.slice(idx + rawLine.length);
      }
    }
  }

  return out;
}

export const __testing = { bytesToBase64Url, base64UrlToBytes, FRAGMENT_KEY, scrubBytesInLine, walkRdbiPayload, findAsciiDigitRuns };
