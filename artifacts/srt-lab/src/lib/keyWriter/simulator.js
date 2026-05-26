/* ============================================================================
 * simulator.js — canned-response transport for the key writer bridge.
 *
 * Implements the same `send(frame) → Promise<frame>` shape the real
 * Web Serial transport exposes, but answers from a configurable script
 * instead of touching hardware. Used for:
 *   - CI tests (no Web Serial in jsdom).
 *   - Dry-run mode in the KeyWriterTab — lets a locksmith walk a
 *     customer through the whole flow before any chip is on the coil.
 * ========================================================================== */

import { CMD, parseFrame, buildFrame } from './protocol.js';

/** Default scripted behaviour: PING/DETECT/BURN/VERIFY all succeed. */
function defaultHandler(req) {
  switch (req.cmd) {
    case CMD.PING:
      return { cmd: CMD.ACK, payload: new Uint8Array([0x00, 0x01, 0x00 /* fw 0.1.0 */, 0x00]) };
    case CMD.DETECT_CHIP:
      // Echo the chip ordinal back as "found".
      return { cmd: CMD.ACK, payload: new Uint8Array([0x00, req.payload[0] || 0x00]) };
    case CMD.BURN_KEY:
    case CMD.VERIFY:
      return { cmd: CMD.ACK, payload: new Uint8Array([0x00]) };
    case CMD.RESET:
      return { cmd: CMD.ACK, payload: new Uint8Array([0x00]) };
    default:
      return { cmd: CMD.NACK, payload: new Uint8Array([0x07 /* UNSUPPORTED */]) };
  }
}

export class SimulatorTransport {
  /** @param {{handler?: (req:{cmd:number,payload:Uint8Array}) => {cmd:number,payload:Uint8Array}, latencyMs?:number, label?:string}} opts */
  constructor(opts = {}) {
    this.handler = opts.handler || defaultHandler;
    this.latencyMs = opts.latencyMs ?? 25;
    this.label = opts.label || 'Simulator';
    this.open = true;
    this.log = [];
  }
  isOpen() { return this.open; }
  close() { this.open = false; }
  /** Send a fully-built request frame, await a full response frame. */
  async send(frameBytes) {
    if (!this.open) throw new Error('SimulatorTransport: closed');
    const parsed = parseFrame(frameBytes);
    if (!parsed.ok) throw new Error(`SimulatorTransport: bad request frame (${parsed.error || 'incomplete'})`);
    const resp = this.handler(parsed.frame);
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const out = buildFrame(resp.cmd, resp.payload || new Uint8Array(0));
    this.log.push({ req: parsed.frame, resp });
    return out;
  }
}

/** Convenience handlers for scripted faults — useful for UI tests. */
export const FAULT_HANDLERS = {
  noChip: (req) =>
    req.cmd === CMD.BURN_KEY || req.cmd === CMD.DETECT_CHIP
      ? { cmd: CMD.NACK, payload: new Uint8Array([0x01]) }
      : defaultHandler(req),
  wrongChip: (req) =>
    req.cmd === CMD.DETECT_CHIP
      ? { cmd: CMD.NACK, payload: new Uint8Array([0x02]) }
      : defaultHandler(req),
  verifyFail: (req) =>
    req.cmd === CMD.VERIFY
      ? { cmd: CMD.NACK, payload: new Uint8Array([0x04]) }
      : defaultHandler(req),
  locked: (req) =>
    req.cmd === CMD.BURN_KEY
      ? { cmd: CMD.NACK, payload: new Uint8Array([0x03]) }
      : defaultHandler(req),
};
