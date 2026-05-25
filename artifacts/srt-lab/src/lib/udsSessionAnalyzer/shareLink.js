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

const FRAGMENT_KEY = 'uds';

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
