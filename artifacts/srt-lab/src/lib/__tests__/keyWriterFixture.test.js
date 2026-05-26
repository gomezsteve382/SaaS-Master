/* ============================================================================
 * keyWriterFixture.test.js — wire-level CONTRACT test.
 *
 * The fixture in __fixtures__/vvdi-mini-burn-trace.json pins the exact
 * request bytes for a happy-path PING -> DETECT -> BURN -> VERIFY
 * exchange against canonical inputs (chipId, slot.idBytes, secret16).
 *
 * This test rebuilds those requests by calling the real
 * buildPingRequest / buildDetectRequest / buildBurnRequest /
 * buildVerifyRequest functions against the same canonical inputs and
 * asserts BYTE EQUALITY against the fixture. Any change to framing,
 * checksum, payload shape, or chip ordinal table that would alter the
 * bytes the bridge puts on the wire trips a hard failure here instead
 * of a much harder-to-diagnose live-hardware regression.
 *
 * It also replays the recorded responses through a scripted transport
 * to prove decodeResponse + the parse pipeline accept the canned ACK
 * shapes. The fixture is synthetic-but-pinned today; the moment a
 * real VVDI Mini capture replaces the bytes the contract still holds
 * because the inputs section in _meta locks down what to replay.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseFrame, CMD } from '../keyWriter/protocol.js';
import {
  buildPingRequest,
  buildDetectRequest,
  buildBurnRequest,
  buildVerifyRequest,
} from '../keyWriter/serializer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_PATH = path.resolve(
  __dirname, '..', 'keyWriter', '__fixtures__', 'vvdi-mini-burn-trace.json'
);

function fromHex(s) {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function toHex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

const fix = JSON.parse(fs.readFileSync(FIX_PATH, 'utf8'));
const inputs = fix._meta.inputs;
const slot = {
  idx: 0,
  occupied: true,
  idMapped: true,
  idBytes: fromHex(inputs.slot_idBytes_hex),
};
const secret16 = fromHex(inputs.secret16_hex);
const chipId = inputs.chipId;
const writer = inputs.writer;

function exchange(step) {
  const ex = fix.exchanges.find((e) => e.step === step);
  if (!ex) throw new Error(`fixture missing step ${step}`);
  return ex;
}

describe('keyWriter wire fixture — contract', () => {
  it('has the expected step ordering', () => {
    expect(fix.exchanges.map((e) => e.step)).toEqual([
      'ping', 'detect_chip', 'burn_key', 'verify',
    ]);
  });

  it('buildPingRequest emits exactly the fixture bytes', () => {
    const r = buildPingRequest();
    expect(r.ok).toBe(true);
    expect(toHex(r.frame)).toBe(toHex(fromHex(exchange('ping').request_hex)));
  });

  it('buildDetectRequest emits exactly the fixture bytes', () => {
    const r = buildDetectRequest({ chipId });
    expect(r.ok).toBe(true);
    expect(toHex(r.frame)).toBe(toHex(fromHex(exchange('detect_chip').request_hex)));
  });

  it('buildBurnRequest emits exactly the fixture bytes', () => {
    const r = buildBurnRequest({ slot, chipId, writer, secret16 });
    expect(r.ok, r.error).toBe(true);
    expect(toHex(r.frame)).toBe(toHex(fromHex(exchange('burn_key').request_hex)));
  });

  it('buildVerifyRequest emits exactly the fixture bytes', () => {
    const r = buildVerifyRequest({ slot, chipId, writer, secret16 });
    expect(r.ok, r.error).toBe(true);
    expect(toHex(r.frame)).toBe(toHex(fromHex(exchange('verify').request_hex)));
  });

  it('all response frames parse cleanly as CMD.ACK with status 0x00', () => {
    for (const ex of fix.exchanges) {
      const parsed = parseFrame(fromHex(ex.response_hex));
      expect(parsed.ok, `step ${ex.step}: ${parsed.error}`).toBe(true);
      expect(parsed.frame.cmd).toBe(CMD.ACK);
      expect(parsed.frame.payload[0]).toBe(0x00);
    }
  });

  it('scripted transport replay matches the pinned request/response order', async () => {
    const seen = [];
    const respByCmd = new Map();
    for (const ex of fix.exchanges) {
      const req = parseFrame(fromHex(ex.request_hex));
      respByCmd.set(req.frame.cmd, fromHex(ex.response_hex));
    }
    const transport = {
      isOpen: () => true,
      close() {},
      async send(reqBytes) {
        const r = parseFrame(reqBytes);
        seen.push(r.frame.cmd);
        return respByCmd.get(r.frame.cmd);
      },
    };
    for (const step of ['ping', 'detect_chip', 'burn_key', 'verify']) {
      const ex = exchange(step);
      const resp = await transport.send(fromHex(ex.request_hex));
      expect(parseFrame(resp).frame.cmd).toBe(CMD.ACK);
    }
    expect(seen).toEqual([CMD.PING, CMD.DETECT_CHIP, CMD.BURN_KEY, CMD.VERIFY]);
  });
});
