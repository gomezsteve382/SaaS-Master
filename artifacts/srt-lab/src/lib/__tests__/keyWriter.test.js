/* Tests for the transponder writer bridge (Task #862). Covers:
 *   - protocol framing (build / parse / FrameReader resync)
 *   - serializer refuse-on-doubt gates
 *   - simulator round-trip via the high-level burnSlot driver
 */
import { describe, it, expect } from 'vitest';
import {
  buildFrame, parseFrame, FrameReader, xorChecksum, CMD,
} from '../keyWriter/protocol.js';
import {
  buildBurnRequest, buildDetectRequest, buildVerifyRequest, CHIP_ORDINAL,
} from '../keyWriter/serializer.js';
import { SimulatorTransport, FAULT_HANDLERS } from '../keyWriter/simulator.js';
import { burnSlot } from '../keyWriter/index.js';
import { chipFamily, chipForRfhubGen } from '../keyWriter/chipFamilies.js';
import { WebSerialTransport } from '../keyWriter/webSerialTransport.js';

function makeSlot({ idx = 0, occupied = true, idLen = 8, fill = 0xAB } = {}) {
  const idBytes = new Uint8Array(idLen);
  for (let i = 0; i < idLen; i++) idBytes[i] = (fill + i) & 0xFF;
  return {
    idx,
    markerOffset: 0x0880 + idx * 2,
    occupied,
    raw: new Uint8Array(occupied ? [0xAA, 0x50] : [0xFF, 0xFF]),
    idOffset: 0x0888 + idx * 8,
    idBytes,
    idMapped: true,
  };
}

function makeSecret(fill = 0x42) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = (fill + i) & 0xFF;
  return s;
}

describe('keyWriter/protocol — framing', () => {
  it('xorChecksum is XOR over the byte range', () => {
    expect(xorChecksum(new Uint8Array([0x01, 0x02, 0x04]))).toBe(0x07);
    expect(xorChecksum(new Uint8Array([]))).toBe(0x00);
  });
  it('buildFrame produces 5A A5 header, big-endian len, and a valid checksum', () => {
    const f = buildFrame(CMD.PING);
    expect(f[0]).toBe(0x5A);
    expect(f[1]).toBe(0xA5);
    expect((f[2] << 8) | f[3]).toBe(1); // just CMD byte
    expect(f[4]).toBe(CMD.PING);
    expect(f[f.length - 1]).toBe(xorChecksum(f.slice(2, f.length - 1)));
  });
  it('parseFrame round-trips buildFrame for non-trivial payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const f = buildFrame(CMD.BURN_KEY, payload);
    const p = parseFrame(f);
    expect(p.ok).toBe(true);
    expect(p.frame.cmd).toBe(CMD.BURN_KEY);
    expect(Array.from(p.frame.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(p.consumed).toBe(f.length);
  });
  it('parseFrame asks for more bytes when truncated', () => {
    const f = buildFrame(CMD.BURN_KEY, new Uint8Array([1, 2, 3, 4, 5]));
    const r = parseFrame(f.slice(0, 4));
    expect(r.ok).toBe(false);
    expect(r.need).toBeGreaterThan(0);
  });
  it('parseFrame rejects a corrupted checksum', () => {
    const f = buildFrame(CMD.PING);
    f[f.length - 1] ^= 0xFF;
    const r = parseFrame(f);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum/);
  });
  it('FrameReader resyncs past garbage and yields multiple frames', () => {
    const a = buildFrame(CMD.PING);
    const b = buildFrame(CMD.ACK, new Uint8Array([0x00]));
    const garbage = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const merged = new Uint8Array(garbage.length + a.length + 3 + b.length);
    merged.set(garbage, 0);
    merged.set(a, garbage.length);
    merged.set([0x00, 0x00, 0x00], garbage.length + a.length);
    merged.set(b, garbage.length + a.length + 3);
    const r = new FrameReader();
    // Feed it in two chunks to exercise the reassembler.
    const split = Math.floor(merged.length / 2);
    const f1 = r.push(merged.slice(0, split));
    const f2 = r.push(merged.slice(split));
    const all = [...f1, ...f2];
    expect(all.length).toBe(2);
    expect(all[0].cmd).toBe(CMD.PING);
    expect(all[1].cmd).toBe(CMD.ACK);
  });
});

describe('keyWriter/serializer — refuse-on-doubt gates', () => {
  it('refuses an empty slot', () => {
    const r = buildBurnRequest({ slot: makeSlot({ occupied: false }), chipId: 'pcf7953', writer: 'vvdi-mini', secret16: makeSecret() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('slot-empty');
  });
  it('refuses an unknown chip family', () => {
    const r = buildBurnRequest({ slot: makeSlot(), chipId: 'mystery', writer: 'vvdi-mini', secret16: makeSecret() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-chip');
  });
  it('refuses a slot whose idBytes shape disagrees with chip family', () => {
    const r = buildBurnRequest({ slot: makeSlot({ idLen: 4 }), chipId: 'pcf7953', writer: 'vvdi-mini', secret16: makeSecret() });
    // pcf7953 wants 4+8 = 12; slot only provides 4.
    expect(r.ok).toBe(false);
    expect(['id-shape-mismatch', 'id-too-short']).toContain(r.reason);
  });
  it('refuses a blank (all-FF) SEC16 secret', () => {
    const blank = new Uint8Array(16).fill(0xFF);
    const r = buildBurnRequest({ slot: makeSlot(), chipId: 'pcf7953', writer: 'vvdi-mini', secret16: blank });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blank-secret');
  });
  it('refuses an unsupported writer for chip', () => {
    const r = buildBurnRequest({ slot: makeSlot({ idLen: 23 }), chipId: 'megamos-aes', writer: 'tango', secret16: makeSecret() });
    expect(r.ok).toBe(false);
    expect(['writer-unsupported', 'id-shape-mismatch']).toContain(r.reason);
  });
  it('builds a well-formed BURN_KEY payload for a pcf7953 slot', () => {
    const slot = makeSlot();
    const secret = makeSecret();
    const r = buildBurnRequest({ slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: secret });
    expect(r.ok).toBe(true);
    // Payload: chip(1) + uidLen(1) + plLen(1) + uid(4) + payload(4) + sec16(16) = 27
    expect(r.payload.length).toBe(27);
    expect(r.payload[0]).toBe(CHIP_ORDINAL['pcf7953']);
    expect(r.payload[1]).toBe(4);
    expect(r.payload[2]).toBe(4);
    // SEC16 lives at the tail.
    expect(Array.from(r.payload.slice(-16))).toEqual(Array.from(secret));
    // Frame parses cleanly.
    const p = parseFrame(r.frame);
    expect(p.ok).toBe(true);
    expect(p.frame.cmd).toBe(CMD.BURN_KEY);
  });
  it('buildVerifyRequest reuses BURN_KEY payload with VERIFY opcode', () => {
    const r = buildVerifyRequest({ slot: makeSlot(), chipId: 'pcf7953', writer: 'vvdi-mini', secret16: makeSecret() });
    expect(r.ok).toBe(true);
    const p = parseFrame(r.frame);
    expect(p.frame.cmd).toBe(CMD.VERIFY);
  });
  it('buildDetectRequest carries the chip ordinal', () => {
    const r = buildDetectRequest({ chipId: 'pcf7953' });
    expect(r.ok).toBe(true);
    const p = parseFrame(r.frame);
    expect(p.frame.cmd).toBe(CMD.DETECT_CHIP);
    expect(p.frame.payload[0]).toBe(CHIP_ORDINAL['pcf7953']);
  });
});

describe('keyWriter/chipFamilies', () => {
  it('maps RFHUB gens to the expected chip families', () => {
    expect(chipForRfhubGen('gen2')).toBe('pcf7953');
    expect(chipForRfhubGen('gen1')).toBe('pcf7945');
    expect(chipForRfhubGen('unknown')).toBeNull();
  });
  it('chipFamily pcf7953 describes a 4+8-byte HITAG2 chip', () => {
    const c = chipFamily('pcf7953');
    expect(c.uidBytes).toBe(4);
    expect(c.payloadBytes).toBe(4);
    expect(c.writers).toContain('vvdi-mini');
  });
});

describe('keyWriter — burnSlot end-to-end via simulator', () => {
  const slot = makeSlot();
  const secret = makeSecret();

  it('reports ok=true with 4 successful steps under the default handler', async () => {
    const t = new SimulatorTransport({ latencyMs: 0 });
    const res = await burnSlot({ transport: t, slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: secret });
    expect(res.ok).toBe(true);
    expect(res.steps.length).toBe(4);
    expect(res.steps.map((s) => s.label)).toEqual(['ping', 'detect', 'burn', 'verify']);
    expect(res.steps.every((s) => s.ok)).toBe(true);
  });
  it('halts at detect when the simulator reports NO_CHIP', async () => {
    const t = new SimulatorTransport({ latencyMs: 0, handler: FAULT_HANDLERS.noChip });
    const res = await burnSlot({ transport: t, slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: secret });
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('detect');
    expect(res.steps.at(-1).error).toBe('NO_CHIP');
  });
  it('halts at verify when the simulator reports VERIFY_FAIL', async () => {
    const t = new SimulatorTransport({ latencyMs: 0, handler: FAULT_HANDLERS.verifyFail });
    const res = await burnSlot({ transport: t, slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: secret });
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('verify');
    expect(res.steps.at(-1).error).toBe('VERIFY_FAIL');
  });
  it('halts at burn when the simulator reports LOCKED', async () => {
    const t = new SimulatorTransport({ latencyMs: 0, handler: FAULT_HANDLERS.locked });
    const res = await burnSlot({ transport: t, slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: secret });
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('burn');
    expect(res.steps.at(-1).error).toBe('LOCKED');
  });
  it('refuses to send when serializer rejects (blank secret)', async () => {
    const t = new SimulatorTransport({ latencyMs: 0 });
    const blank = new Uint8Array(16);
    const res = await burnSlot({ transport: t, slot, chipId: 'pcf7953', writer: 'vvdi-mini', secret16: blank });
    expect(res.ok).toBe(false);
    // ping + detect succeed against the sim; burn fails on serializer guard.
    expect(res.failedAt).toBe('burn');
    expect(res.steps.at(-1).reason).toBe('blank-secret');
  });
});

/* ---------- WebSerialTransport: contract + race + lifecycle --------------- */

function makeFakePort({ autoEchoCmd = null, autoEchoPayload = new Uint8Array(), writeDelay = 0 } = {}) {
  // Minimal SerialPort stand-in: open() returns immediately, exposes a
  // ReadableStream + WritableStream backed by an in-memory queue, and
  // optionally auto-responds to writes (so we can simulate fast/slow devices).
  let readResolve = null;
  const inbox = [];
  const sentWrites = [];

  const readable = {
    getReader() {
      return {
        async read() {
          if (inbox.length > 0) return { value: inbox.shift(), done: false };
          return new Promise((res) => { readResolve = res; });
        },
        async cancel() { if (readResolve) { readResolve({ value: undefined, done: true }); readResolve = null; } },
        releaseLock() {},
      };
    },
  };

  const enqueue = (bytes) => {
    if (readResolve) { const r = readResolve; readResolve = null; r({ value: bytes, done: false }); }
    else { inbox.push(bytes); }
  };

  const writable = {
    getWriter() {
      return {
        async write(bytes) {
          sentWrites.push(bytes);
          if (writeDelay > 0) await new Promise((r) => setTimeout(r, writeDelay));
          if (autoEchoCmd != null) {
            const resp = buildFrame(autoEchoCmd, autoEchoPayload);
            enqueue(resp);
          }
        },
        async close() {},
        releaseLock() {},
      };
    },
  };

  return {
    async open() {},
    async close() {},
    readable,
    writable,
    sentWrites,
    push: enqueue,
  };
}

describe('keyWriter/webSerialTransport — wire contract & race safety', () => {
  it('returns RAW frame bytes (parseable by parseFrame), not a parsed object', async () => {
    const port = makeFakePort({ autoEchoCmd: CMD.ACK, autoEchoPayload: new Uint8Array([0x00, 0xDE, 0xAD]) });
    const t = new WebSerialTransport({ port, timeoutMs: 1000 });
    await t.open_();
    const resp = await t.send(buildFrame(CMD.PING));
    expect(resp).toBeInstanceOf(Uint8Array);
    const parsed = parseFrame(resp);
    expect(parsed.ok).toBe(true);
    expect(parsed.frame.cmd).toBe(CMD.ACK);
    expect(Array.from(parsed.frame.payload)).toEqual([0x00, 0xDE, 0xAD]);
    await t.close();
  });

  it('does not drop a fast response that arrives during the write (pending registered first)', async () => {
    // writeDelay > 0 means the response is enqueued from inside write(),
    // but the await happens after pending is set, so a naive
    // post-write-pending implementation would race. We pre-arm the
    // response BEFORE await to make the race deterministic.
    const port = makeFakePort({ autoEchoCmd: CMD.ACK, autoEchoPayload: new Uint8Array([0x00]) });
    const t = new WebSerialTransport({ port, timeoutMs: 500 });
    await t.open_();
    // Push a response into the inbox before send() even runs.
    port.push(buildFrame(CMD.ACK, new Uint8Array([0x00, 0xAA])));
    const resp = await t.send(buildFrame(CMD.PING));
    const parsed = parseFrame(resp);
    expect(parsed.ok).toBe(true);
    expect(parsed.frame.cmd).toBe(CMD.ACK);
    await t.close();
  });

  it('times out when the device never answers', async () => {
    const port = makeFakePort({ autoEchoCmd: null });
    const t = new WebSerialTransport({ port, timeoutMs: 50 });
    await t.open_();
    await expect(t.send(buildFrame(CMD.PING))).rejects.toThrow(/timeout/i);
    await t.close();
  });

  it('rejects in-flight request when close() is called', async () => {
    const port = makeFakePort({ autoEchoCmd: null });
    const t = new WebSerialTransport({ port, timeoutMs: 5000 });
    await t.open_();
    const p = t.send(buildFrame(CMD.PING));
    await new Promise((r) => setTimeout(r, 5));
    await t.close();
    await expect(p).rejects.toThrow(/closed mid-request/);
  });

  it('refuses a malformed outbound frame before touching the port', async () => {
    const port = makeFakePort({});
    const t = new WebSerialTransport({ port });
    await t.open_();
    await expect(t.send(new Uint8Array([0x00, 0x00, 0x00]))).rejects.toThrow(/malformed/i);
    expect(port.sentWrites.length).toBe(0);
    await t.close();
  });
});
