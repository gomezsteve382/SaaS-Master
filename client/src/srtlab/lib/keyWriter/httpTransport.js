/* ============================================================================
 * httpTransport.js — Node/Express fallback for the key writer bridge.
 *
 * Used when Web Serial is unavailable (Firefox, locked-down corporate
 * Chromium, etc.). Talks to the api-server's /api/key-writer/transport
 * endpoint, which is in turn expected to relay to a desktop serialport
 * daemon. If no daemon is configured server-side, the status endpoint
 * answers `available:false` with a human-readable reason so the UI can
 * fall back to Simulator gracefully instead of presenting a dead button.
 *
 * Mirrors the `send(frame) → Promise<Uint8Array>` raw-byte contract
 * established by WebSerialTransport and SimulatorTransport so callers
 * never need to special-case which transport they are talking to.
 * ========================================================================== */

import { parseFrame } from './protocol.js';

const DEFAULT_BASE = '/api/key-writer';

/** Optional shared-secret token. The server requires this header when
 *  KEY_WRITER_RELAY_TOKEN is set; surfaced to the browser via Vite's
 *  VITE_KEY_WRITER_RELAY_TOKEN. Falls back to a global so bench
 *  operators can paste a token at runtime without a rebuild. */
function defaultToken() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_KEY_WRITER_RELAY_TOKEN) {
      return String(import.meta.env.VITE_KEY_WRITER_RELAY_TOKEN);
    }
  } catch { /* not vite */ }
  if (typeof globalThis !== 'undefined' && globalThis.__KEY_WRITER_RELAY_TOKEN__) {
    return String(globalThis.__KEY_WRITER_RELAY_TOKEN__);
  }
  return null;
}

function authHeaders(token) {
  return token ? { 'x-key-writer-token': token } : {};
}

function bytesToB64(bytes) {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
}
function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Probe the server-side daemon. Returns { available, reason, model?, firmware? }. */
export async function probeHttpTransport({ baseUrl = DEFAULT_BASE, fetchImpl = fetch, token = defaultToken() } = {}) {
  try {
    const r = await fetchImpl(`${baseUrl}/transport/status`, { method: 'GET', headers: authHeaders(token) });
    if (!r.ok) {
      return { available: false, reason: `HTTP ${r.status}` };
    }
    const body = await r.json();
    return {
      available: !!body.available,
      reason: body.reason || (body.available ? 'ready' : 'no daemon configured'),
      model: body.model || null,
      firmware: body.firmware || null,
    };
  } catch (e) {
    return { available: false, reason: e?.message || String(e) };
  }
}

export class HttpTransport {
  /** @param {{baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || DEFAULT_BASE;
    this.fetch = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.token = opts.token !== undefined ? opts.token : defaultToken();
    this.open = true;
  }
  isOpen() { return this.open; }
  close() { this.open = false; }

  async send(frameBytes) {
    if (!this.open) throw new Error('HttpTransport: closed');
    const sanity = parseFrame(frameBytes);
    if (!sanity.ok) throw new Error(`HttpTransport: refusing to send malformed frame (${sanity.error || 'incomplete'})`);
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      const r = await this.fetch(`${this.baseUrl}/transport/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.token) },
        body: JSON.stringify({ frame: bytesToB64(frameBytes) }),
        signal: ctrl?.signal,
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HttpTransport: HTTP ${r.status} ${text || r.statusText}`);
      }
      const body = await r.json();
      if (!body.frame) throw new Error('HttpTransport: response missing frame field');
      return b64ToBytes(body.frame);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
