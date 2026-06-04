/* ============================================================================
 * webSerialTransport.js — Web Serial wrapper for the key writer bridge.
 *
 * Caller is responsible for prompting `navigator.serial.requestPort()` in
 * a user gesture (the UI does this on the "Connect" button click). Once
 * a port is supplied, this transport opens it, reads inbound bytes into
 * a FrameReader, and resolves outstanding `send()` calls with the next
 * full frame the writer emits.
 *
 * One outstanding request at a time — the Xhorse VVDI / Tango protocols
 * are request/response, not pipelined.
 * ========================================================================== */

import { FrameReader, parseFrame, buildFrame } from './protocol.js';

const DEFAULT_BAUD = 115200;

export function isWebSerialAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.serial;
}

export class WebSerialTransport {
  /** @param {{port: SerialPort, baudRate?: number, timeoutMs?: number, label?: string}} opts */
  constructor(opts) {
    if (!opts || !opts.port) throw new Error('WebSerialTransport: port is required');
    this.port = opts.port;
    this.baudRate = opts.baudRate || DEFAULT_BAUD;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.label = opts.label || 'Web Serial';
    this.reader = null;
    this.writer = null;
    this.frameReader = new FrameReader();
    this.pending = null; // { resolve, reject, timer }
    this.open = false;
    this._readLoop = null;
  }

  async open_() {
    await this.port.open({ baudRate: this.baudRate });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.open = true;
    this._readLoop = this._read();
  }

  isOpen() { return this.open; }

  async close() {
    this.open = false;
    if (this.pending) {
      this.pending.reject(new Error('WebSerialTransport: closed mid-request'));
      this.pending = null;
    }
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.reader?.releaseLock(); } catch { /* ignore */ }
    try { await this.writer?.close(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }

  async _read() {
    try {
      while (this.open) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        const frames = this.frameReader.push(value);
        for (const f of frames) {
          // burnSlot expects raw frame bytes (it re-parses), and
          // FrameReader yields parsed {cmd,payload}. Rebuild the wire
          // bytes — framing is deterministic so this round-trips
          // byte-perfect.
          const raw = buildFrame(f.cmd, f.payload);
          if (this.pending) {
            const p = this.pending;
            this.pending = null;
            clearTimeout(p.timer);
            p.resolve(raw);
          }
          // Frames received with no outstanding request are dropped on
          // purpose — the protocol is strictly request/response.
        }
      }
    } catch (e) {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(e);
      }
    }
  }

  /** Send a fully-built request frame, await the next full response frame. */
  async send(frameBytes) {
    if (!this.open) throw new Error('WebSerialTransport: not open');
    if (this.pending) throw new Error('WebSerialTransport: a request is already in flight');
    const sanity = parseFrame(frameBytes);
    if (!sanity.ok) throw new Error(`WebSerialTransport: refusing to send malformed frame (${sanity.error || 'incomplete'})`);
    // Register `pending` BEFORE the write so a fast-responding device
    // never beats us to assignment and gets its frame silently dropped
    // by the no-pending branch in _read().
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.resolve === resolve) {
          this.pending = null;
          reject(new Error(`WebSerialTransport: timeout after ${this.timeoutMs} ms`));
        }
      }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
      this.writer.write(frameBytes).catch((e) => {
        if (this.pending && this.pending.resolve === resolve) {
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        }
      });
    });
  }
}

/** Convenience: prompt for a port (must be inside a user gesture) and
 *  return an opened transport. */
export async function connectWebSerial({ filters = [], baudRate, timeoutMs } = {}) {
  if (!isWebSerialAvailable()) throw new Error('Web Serial API not available in this browser');
  const port = await navigator.serial.requestPort({ filters });
  const t = new WebSerialTransport({ port, baudRate, timeoutMs });
  await t.open_();
  return t;
}
