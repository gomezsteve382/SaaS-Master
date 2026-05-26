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

import { CMD, TANGO_CMD, parseFrame, buildFrame, cmdsFor } from './protocol.js';

/** Build a default scripted handler for a given opcode table.
 *  All four happy-path steps (PING/DETECT/BURN/VERIFY) succeed; everything
 *  else NACKs with UNSUPPORTED. The handler is opcode-table-aware so the
 *  same code answers either VVDI Mini or Tango requests correctly. */
function makeDefaultHandler(cmds) {
  return function defaultHandler(req) {
    switch (req.cmd) {
      case cmds.PING:
        return { cmd: cmds.ACK, payload: new Uint8Array([0x00, 0x01, 0x00 /* fw 0.1.0 */, 0x00]) };
      case cmds.DETECT_CHIP:
        // Echo the chip-family selector tail back as "found".
        return { cmd: cmds.ACK, payload: new Uint8Array([0x00, req.payload[req.payload.length - 1] || 0x00]) };
      case cmds.BURN_KEY:
      case cmds.VERIFY:
        return { cmd: cmds.ACK, payload: new Uint8Array([0x00]) };
      case cmds.RESET:
        return { cmd: cmds.ACK, payload: new Uint8Array([0x00]) };
      default:
        return { cmd: cmds.NACK, payload: new Uint8Array([0x07 /* UNSUPPORTED */]) };
    }
  };
}

/** Auto-routing default handler — dispatches each request to the opcode
 *  table that recognises its opcode. Lets a single SimulatorTransport
 *  answer both VVDI and Tango traffic in mixed-writer tests. */
function defaultHandler(req) {
  if (Object.values(TANGO_CMD).includes(req.cmd)) {
    return makeDefaultHandler(TANGO_CMD)(req);
  }
  return makeDefaultHandler(CMD)(req);
}

export class SimulatorTransport {
  /** @param {{handler?: (req:{cmd:number,payload:Uint8Array}) => {cmd:number,payload:Uint8Array}, latencyMs?:number, label?:string, writer?:'vvdi-mini'|'tango'}} opts */
  constructor(opts = {}) {
    // If a writer is specified and no custom handler given, scope responses
    // to that opcode table — useful for asserting that e.g. VVDI ignores
    // Tango opcodes (which would NACK as UNSUPPORTED).
    const scoped = opts.writer ? makeDefaultHandler(cmdsFor(opts.writer)) : defaultHandler;
    this.handler = opts.handler || scoped;
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
