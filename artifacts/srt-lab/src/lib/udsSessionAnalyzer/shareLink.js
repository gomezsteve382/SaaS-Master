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

export const __testing = { bytesToBase64Url, base64UrlToBytes, FRAGMENT_KEY };
