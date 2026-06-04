/* ============================================================================
 * keyWriter/index.js — high-level driver: turn a slot + secret + transport
 * into a (ping → detect → burn → verify) walk that the UI can render
 * step-by-step. Each step returns { ok, frame, response, error, detail }
 * so the UI can mirror the established audit/refuse-on-doubt pattern
 * (KEYMOD REFUSED on first ok:false).
 * ========================================================================== */

import { parseFrame, CMD, TANGO_CMD } from './protocol.js';
import {
  buildPingRequest,
  buildDetectRequest,
  buildBurnRequest,
  buildVerifyRequest,
} from './serializer.js';
import { describeError } from './errors.js';

const ACK_OPCODES = new Set([CMD.ACK, TANGO_CMD.ACK]);
const NACK_OPCODES = new Set([CMD.NACK, TANGO_CMD.NACK]);

function decodeResponse(respBytes) {
  const p = parseFrame(respBytes);
  if (!p.ok) return { ok: false, error: p.error || 'incomplete frame' };
  const { cmd, payload } = p.frame;
  if (ACK_OPCODES.has(cmd)) {
    return { ok: true, cmd, payload, status: 0x00, detail: 'OK' };
  }
  if (NACK_OPCODES.has(cmd)) {
    const code = payload[0] ?? 0xFF;
    const err = describeError(code);
    return { ok: false, cmd, payload, status: code, error: err.label, detail: err.detail };
  }
  return { ok: false, cmd, payload, status: null, error: `UNEXPECTED_CMD_0x${cmd.toString(16)}`, detail: 'Writer returned a non-ACK/NACK opcode.' };
}

async function runStep(transport, label, requestBuilder, builderArgs) {
  const built = requestBuilder(builderArgs);
  if (!built.ok) {
    return { label, ok: false, error: built.error, reason: built.reason, detail: built.error };
  }
  let respBytes;
  try {
    respBytes = await transport.send(built.frame);
  } catch (e) {
    return { label, ok: false, error: 'TRANSPORT', detail: e.message ?? String(e) };
  }
  const decoded = decodeResponse(respBytes);
  return { label, request: built, response: decoded, ok: decoded.ok, error: decoded.error, detail: decoded.detail, status: decoded.status };
}

/** Run the full ping → detect → burn → verify walk. Stops at first failure. */
export async function burnSlot({ transport, slot, chipId, writer, secret16 }) {
  const steps = [];
  const args = { slot, chipId, writer, secret16 };

  const ping = await runStep(transport, 'ping',   buildPingRequest, { writer });
  steps.push(ping);
  if (!ping.ok) return { ok: false, steps, failedAt: 'ping' };

  const detect = await runStep(transport, 'detect', buildDetectRequest, args);
  steps.push(detect);
  if (!detect.ok) return { ok: false, steps, failedAt: 'detect' };

  const burn = await runStep(transport, 'burn',   buildBurnRequest, args);
  steps.push(burn);
  if (!burn.ok) return { ok: false, steps, failedAt: 'burn' };

  const verify = await runStep(transport, 'verify', buildVerifyRequest, args);
  steps.push(verify);
  if (!verify.ok) return { ok: false, steps, failedAt: 'verify' };

  return { ok: true, steps, failedAt: null };
}

export { decodeResponse };
export * from './protocol.js';
export * from './serializer.js';
export * from './chipFamilies.js';
export * from './errors.js';
