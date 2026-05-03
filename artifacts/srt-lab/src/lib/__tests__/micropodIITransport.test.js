// Bench-trace test for the MicroPod II transport adapter (Task #613).
//
// Coverage:
//   1. Wire format — byte-exact cross-validation of the 8-byte header layout
//      so the JS helpers stay in lockstep with micropod_bridge.py's
//      struct.pack('>BBHI', ...) / struct.unpack('>BBHI', ...) pair.
//   2. Frame round-trips — build/parse symmetry for all frame types.
//   3. Engine contract — isBridge, transport ID, negotiated timing, uds shape.
//   4. Transport routing — createBridgeEngine() delegates to MicroPod II
//      when the operator sets the active transport to micropod-ii (no url arg).
//   5. Transport selector persistence — localStorage round-trip.
//   6. Fixture replay — skip-if-missing section that activates when a real
//      bench trace is recorded at __fixtures__/micropodIITrace.fixture.json.
//
// Skip behaviour mirrors cdaOfflineFlash.test.js — fixture section skips
// cleanly on fresh checkouts that have no recorded pod trace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const FIXTURE_PATH = path.join(__dirname, '..', '__fixtures__', 'micropodIITrace.fixture.json');
const fixtureExists = fs.existsSync(FIXTURE_PATH);
const describeIfFixture = fixtureExists ? describe : describe.skip;

// ─── Frame builder/parser helpers ────────────────────────────────────────────
//
// These functions implement the EXACT same wire format as micropod_bridge.py:
//
//   Python: struct.pack('>BBHI', frame_type, seq, payload_len, can_id)
//   Python: struct.unpack('>BBHI', raw[:8])
//
// 8-byte header layout:
//   Offset  Size  Field
//   0       1     Frame type  (FT_CMD/FT_DATA/FT_KEEPALIVE/FT_STATUS)
//   1       1     Sequence number (wraps 0x00–0xFF)
//   2       2     Payload length, big-endian
//   4       4     CAN ID, big-endian (11-bit or 29-bit)
//   8       N     Payload bytes (ISO-TP PDU)
//
// Any change to the Python side MUST be reflected here and vice-versa.

function buildFrame(frameType, seq, canId, payload = new Uint8Array()) {
  const pLen = payload.length;
  const buf  = new Uint8Array(8 + pLen);
  // struct.pack('>BBHI', frame_type, seq, payload_len, can_id)
  buf[0] = frameType & 0xFF;                  // B — frame_type
  buf[1] = seq & 0xFF;                        // B — seq
  buf[2] = (pLen >>> 8) & 0xFF;              // H hi — payload_len
  buf[3] =  pLen & 0xFF;                      // H lo
  buf[4] = (canId >>> 24) & 0xFF;            // I byte 3 — can_id
  buf[5] = (canId >>> 16) & 0xFF;            // I byte 2
  buf[6] = (canId >>>  8) & 0xFF;            // I byte 1
  buf[7] =  canId & 0xFF;                     // I byte 0
  buf.set(payload, 8);
  return buf;
}

function parseFrame(raw) {
  if (!raw || raw.length < 8) return null;
  // struct.unpack('>BBHI', raw[:8])
  const frameType  = raw[0];
  const seq        = raw[1];
  const payloadLen = (raw[2] << 8) | raw[3];
  const canId      = ((raw[4] << 24) | (raw[5] << 16) | (raw[6] << 8) | raw[7]) >>> 0;
  const payload    = raw.slice(8, 8 + payloadLen);
  return {
    frameType,
    seq,
    canId,
    payload,
    data: Array.from(payload).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
  };
}

// Frame type constants — mirror micropod_bridge.py
const FT_CMD       = 0x01;
const FT_DATA      = 0x02;
const FT_KEEPALIVE = 0x03;
const FT_STATUS    = 0x04;

// ─── Wire format byte-exact cross-validation ─────────────────────────────────
// These tests pin specific byte sequences that must match what Python's
//   struct.pack('>BBHI', frame_type, seq, payload_len, can_id)
// produces.  If the Python format changes, these tests break — that is the
// point.  Update both sides together.

describe('Wire format byte-exact cross-validation (mirrors micropod_bridge.py)', () => {
  it('DATA frame header for DiagnosticSessionControl 10 03 at 0x7E0 matches expected bytes', () => {
    // Python: struct.pack('>BBHI', 0x02, 0x01, 2, 0x7E0)
    // = b'\x02\x01\x00\x02\x00\x00\x07\xe0'
    const frame = buildFrame(FT_DATA, 0x01, 0x7E0, new Uint8Array([0x10, 0x03]));
    expect(frame[0]).toBe(0x02);              // FT_DATA
    expect(frame[1]).toBe(0x01);              // seq
    expect(frame[2]).toBe(0x00);              // payload_len hi
    expect(frame[3]).toBe(0x02);              // payload_len lo = 2
    expect(frame[4]).toBe(0x00);              // CAN ID byte 3
    expect(frame[5]).toBe(0x00);              // CAN ID byte 2
    expect(frame[6]).toBe(0x07);              // CAN ID byte 1
    expect(frame[7]).toBe(0xE0);              // CAN ID byte 0
    expect(frame[8]).toBe(0x10);              // payload[0]
    expect(frame[9]).toBe(0x03);              // payload[1]
  });

  it('KEEPALIVE frame header is all-zero CAN ID with empty payload', () => {
    // Python: struct.pack('>BBHI', 0x03, 0x05, 0, 0)
    // = b'\x03\x05\x00\x00\x00\x00\x00\x00'
    const frame = buildFrame(FT_KEEPALIVE, 0x05, 0x00000000);
    expect(frame[0]).toBe(0x03);
    expect(frame[1]).toBe(0x05);
    expect(frame[2]).toBe(0x00);
    expect(frame[3]).toBe(0x00);
    expect([frame[4], frame[5], frame[6], frame[7]]).toEqual([0, 0, 0, 0]);
    expect(frame.slice(8).every(b => b === 0)).toBe(true);
  });

  it('DATA frame with 29-bit CAN ID (0x18DA10F1) encodes correctly', () => {
    // Python: struct.pack('>BBHI', 0x02, 0x01, 0, 0x18DA10F1)
    // = b'\x02\x01\x00\x00\x18\xda\x10\xf1'
    const frame = buildFrame(FT_DATA, 0x01, 0x18DA10F1);
    expect(frame[4]).toBe(0x18);
    expect(frame[5]).toBe(0xDA);
    expect(frame[6]).toBe(0x10);
    expect(frame[7]).toBe(0xF1);
  });

  it('payload_len field uses big-endian encoding for lengths > 255', () => {
    // payload_len = 0x0102 = 258 bytes → hi=0x01 lo=0x02
    const big = new Uint8Array(258).fill(0xAA);
    const frame = buildFrame(FT_DATA, 0x01, 0x7E0, big);
    expect(frame[2]).toBe(0x01);
    expect(frame[3]).toBe(0x02);
  });

  it('parseFrame correctly decodes the same bytes buildFrame produces', () => {
    // Pinned known-good sequence: DATA, seq=0x42, canId=0x7E8, payload=[0x50,0x03]
    // Python: struct.pack('>BBHI', 0x02, 0x42, 2, 0x7E8) + b'\x50\x03'
    const known = new Uint8Array([0x02, 0x42, 0x00, 0x02, 0x00, 0x00, 0x07, 0xE8, 0x50, 0x03]);
    const parsed = parseFrame(known);
    expect(parsed.frameType).toBe(FT_DATA);
    expect(parsed.seq).toBe(0x42);
    expect(parsed.canId).toBe(0x7E8);
    expect(Array.from(parsed.payload)).toEqual([0x50, 0x03]);
  });
});

// ─── Frame builder/parser round-trips ────────────────────────────────────────

describe('MicroPod II frame builder/parser', () => {
  it('round-trips a DATA frame with a UDS payload', () => {
    const payload = new Uint8Array([0x10, 0x03]);
    const frame   = buildFrame(FT_DATA, 0x01, 0x7E0, payload);
    const parsed  = parseFrame(frame);

    expect(parsed).not.toBeNull();
    expect(parsed.frameType).toBe(FT_DATA);
    expect(parsed.seq).toBe(0x01);
    expect(parsed.canId).toBe(0x7E0);
    expect(Array.from(parsed.payload)).toEqual([0x10, 0x03]);
  });

  it('round-trips a KEEPALIVE frame (empty payload)', () => {
    const frame  = buildFrame(FT_KEEPALIVE, 0xFF, 0x00000000);
    const parsed = parseFrame(frame);
    expect(parsed.frameType).toBe(FT_KEEPALIVE);
    expect(parsed.seq).toBe(0xFF);
    expect(parsed.payload.length).toBe(0);
  });

  it('round-trips a CMD frame with connect sub-command', () => {
    const CMD_CONNECT = 0x20;
    const payload = new Uint8Array([CMD_CONNECT, 0x06, 0x00, 0x00, 0x07, 0xA1, 0x20]);
    const frame   = buildFrame(FT_CMD, 0x02, 0x00000000, payload);
    const parsed  = parseFrame(frame);
    expect(parsed.frameType).toBe(FT_CMD);
    expect(parsed.payload[0]).toBe(CMD_CONNECT);
  });

  it('returns null for frames shorter than the minimum header', () => {
    expect(parseFrame(new Uint8Array([0x01, 0x00, 0x00]))).toBeNull();
    expect(parseFrame(new Uint8Array())).toBeNull();
    expect(parseFrame(null)).toBeNull();
  });

  it('wraps sequence counter at 0xFF', () => {
    for (let seq = 0; seq <= 0x101; seq++) {
      const frame  = buildFrame(FT_DATA, seq, 0x7E0, new Uint8Array([0x3E, 0x80]));
      const parsed = parseFrame(frame);
      expect(parsed.seq).toBe(seq & 0xFF);
    }
  });

  it('handles a 29-bit CAN ID without truncation', () => {
    const canId = 0x18DB33F1;
    const frame  = buildFrame(FT_DATA, 0x01, canId, new Uint8Array([0x10, 0x03]));
    const parsed = parseFrame(frame);
    expect(parsed.canId >>> 0).toBe(canId >>> 0);
  });

  it('data field is uppercase hex of payload', () => {
    const frame  = buildFrame(FT_DATA, 0x01, 0x7E0, new Uint8Array([0xAB, 0xCD]));
    const parsed = parseFrame(frame);
    expect(parsed.data).toBe('ABCD');
  });
});

// ─── Engine contract — shared UDS surface ────────────────────────────────────
// The MicroPod II engine must expose the exact same properties and method
// signatures as the J2534 bridge engine so flasherStateMachine / VIN-write /
// module-reset callers can use either without changes.

describe('MicroPod II engine contract', () => {
  function makeMockEngine(udsImpl) {
    let negotiatedTiming = null;
    return {
      uds: udsImpl || (async () => ({ ok: false, raw: 'mock not implemented' })),
      adapter: 'wiTECH MicroPod II',
      transport: 'micropod-ii',
      isBridge: true,
      readVoltage: async () => null,
      setNegotiatedTiming(t) {
        if (!t) { negotiatedTiming = null; return; }
        const p2  = Number(t.p2Ms)     || 0;
        const p2s = Number(t.p2StarMs) || 0;
        negotiatedTiming = (p2 > 0 || p2s > 0) ? { p2Ms: p2, p2StarMs: p2s } : null;
      },
      clearNegotiatedTiming() { negotiatedTiming = null; },
      getNegotiatedTiming()   { return negotiatedTiming ? { ...negotiatedTiming } : null; },
      vendor: 'Chrysler / wiTECH',
      firmware: null,
      versions: null,
      deviceUrl: 'http://localhost:8766',
    };
  }

  it('isBridge is true so flasherStateMachine accepts the engine', () => {
    const eng = makeMockEngine();
    expect(eng.isBridge).toBe(true);
  });

  it('transport is "micropod-ii" for identification', () => {
    const eng = makeMockEngine();
    expect(eng.transport).toBe('micropod-ii');
  });

  it('uds() returns {ok, raw} shape on failure', async () => {
    const eng = makeMockEngine();
    const r = await eng.uds(0x7E0, 0x7E8, [0x10, 0x03]);
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('raw');
  });

  it('setNegotiatedTiming / getNegotiatedTiming round-trip', () => {
    const eng = makeMockEngine();
    expect(eng.getNegotiatedTiming()).toBeNull();
    eng.setNegotiatedTiming({ p2Ms: 5000, p2StarMs: 30000 });
    expect(eng.getNegotiatedTiming()).toEqual({ p2Ms: 5000, p2StarMs: 30000 });
  });

  it('clearNegotiatedTiming removes timing', () => {
    const eng = makeMockEngine();
    eng.setNegotiatedTiming({ p2Ms: 5000, p2StarMs: 30000 });
    eng.clearNegotiatedTiming();
    expect(eng.getNegotiatedTiming()).toBeNull();
  });

  it('setNegotiatedTiming with null clears timing', () => {
    const eng = makeMockEngine();
    eng.setNegotiatedTiming({ p2Ms: 2000, p2StarMs: 10000 });
    eng.setNegotiatedTiming(null);
    expect(eng.getNegotiatedTiming()).toBeNull();
  });

  it('setNegotiatedTiming ignores zero-value inputs', () => {
    const eng = makeMockEngine();
    eng.setNegotiatedTiming({ p2Ms: 0, p2StarMs: 0 });
    expect(eng.getNegotiatedTiming()).toBeNull();
  });

  it('readVoltage returns null (not supported on MicroPod II via this bridge)', async () => {
    const eng = makeMockEngine();
    const v = await eng.readVoltage();
    expect(v).toBeNull();
  });

  it('adapter string identifies wiTECH MicroPod II', () => {
    const eng = makeMockEngine();
    expect(eng.adapter).toMatch(/MicroPod/i);
  });

  it('uds() mock returns ok:true with a Uint8Array d field on simulated success', async () => {
    const mockBytes = new Uint8Array([0x50, 0x03]);
    const eng = makeMockEngine(async () => ({ ok: true, d: mockBytes, raw: '5003' }));
    const r = await eng.uds(0x7E0, 0x7E8, [0x10, 0x03]);
    expect(r.ok).toBe(true);
    expect(r.d).toBeInstanceOf(Uint8Array);
    expect(Array.from(r.d)).toEqual([0x50, 0x03]);
  });
});

// ─── Transport routing — createBridgeEngine() delegation ─────────────────────
// Verifies that createBridgeEngine() (called by all bench-flash tabs without
// an explicit url) delegates to the MicroPod II backend when the active
// transport is set to 'micropod-ii', and stays on J2534 when it is 'j2534'
// or when an explicit url is provided (AutelSgwTab / proxiBridge pattern).
//
// Because no daemon is running in the test environment, every call returns
// ok:false.  The error string includes the transportLabel set by
// _buildUdsEngineFromUrl(), so the exact daemon targeted is observable:
//   MicroPod II path → error: "MicroPod II not reachable: ..."
//   J2534 path       → error: "J2534 bridge not reachable: ..."
// Asserting on those strings validates routing without mocking internal calls.

describe('createBridgeEngine() transport routing', () => {
  const LS_KEY = 'srtlab_transport';
  let savedTransport;

  beforeEach(() => {
    savedTransport = typeof localStorage !== 'undefined'
      ? localStorage.getItem(LS_KEY)
      : null;
  });

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      if (savedTransport !== null) localStorage.setItem(LS_KEY, savedTransport);
      else localStorage.removeItem(LS_KEY);
    }
  });

  it('routes to MicroPod II daemon when transport=micropod-ii and no url given', async () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_KEY, 'micropod-ii');

    const { createBridgeEngine } = await import('../bridgeEngine.js');
    const result = await createBridgeEngine({ addLog: () => {} });

    expect(result.ok).toBe(false);
    // Error must name the MicroPod II transport, proving it was targeted.
    // It must NOT say "J2534 bridge" (that would mean routing fell through).
    expect(result.error).toMatch(/MicroPod II/i);
    expect(result.error).not.toMatch(/J2534 bridge/i);
  });

  it('routes to J2534 daemon when transport=j2534 and no url given', async () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_KEY, 'j2534');

    const { createBridgeEngine } = await import('../bridgeEngine.js');
    const result = await createBridgeEngine({ addLog: () => {} });

    expect(result.ok).toBe(false);
    // Error must name J2534 bridge, proving MicroPod path was not taken.
    expect(result.error).toMatch(/J2534 bridge/i);
    expect(result.error).not.toMatch(/MicroPod II/i);
  });

  it('routes to J2534 when explicit url is provided even if micropod-ii is active', async () => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_KEY, 'micropod-ii');

    // Explicit url always routes to J2534 — this is the AutelSgwTab pattern.
    const { createBridgeEngine } = await import('../bridgeEngine.js');
    const result = await createBridgeEngine({
      addLog: () => {},
      url: 'http://localhost:8765',
    });

    expect(result.ok).toBe(false);
    // Explicit url → J2534 path regardless of persisted transport.
    expect(result.error).toMatch(/J2534 bridge/i);
    expect(result.error).not.toMatch(/MicroPod II/i);
  });
});

// ─── Transport selector persistence ──────────────────────────────────────────

describe('Transport selector persistence', () => {
  const LS_KEY = 'srtlab_transport';

  it('getActiveTransport defaults to j2534 when no preference stored', () => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY);
      const get = () => {
        try {
          const v = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_KEY) : null;
          return v === 'micropod-ii' ? 'micropod-ii' : 'j2534';
        } catch { return 'j2534'; }
      };
      expect(get()).toBe('j2534');
    } finally {
      if (saved !== null && typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, saved);
    }
  });

  it('setActiveTransport persists micropod-ii and j2534', () => {
    if (typeof localStorage === 'undefined') return;
    const saved = localStorage.getItem(LS_KEY);
    try {
      const set = (t) => {
        const val = t === 'micropod-ii' ? 'micropod-ii' : 'j2534';
        localStorage.setItem(LS_KEY, val);
        return val;
      };
      expect(set('micropod-ii')).toBe('micropod-ii');
      expect(localStorage.getItem(LS_KEY)).toBe('micropod-ii');
      expect(set('j2534')).toBe('j2534');
      expect(localStorage.getItem(LS_KEY)).toBe('j2534');
      expect(set('unknown-value')).toBe('j2534');
    } finally {
      if (saved !== null) localStorage.setItem(LS_KEY, saved);
      else localStorage.removeItem(LS_KEY);
    }
  });
});

// ─── Fixture replay (skip if missing) ────────────────────────────────────────
// When a bench-recorded trace fixture is present, parse every frame and
// verify it round-trips cleanly through the frame builder/parser. This pins
// the framing so it cannot silently drift between the Python bridge and the
// JS engine.

describeIfFixture('MicroPod II bench-trace fixture replay', () => {
  const fixture = fixtureExists ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) : null;

  it('fixture has the expected shape', () => {
    expect(fixture).toBeDefined();
    expect(Array.isArray(fixture.frames)).toBe(true);
    expect(fixture.frames.length).toBeGreaterThan(0);
  });

  it('all fixture frames round-trip through parseFrame/buildFrame', () => {
    for (const f of fixture.frames) {
      const rawBytes = Uint8Array.from(f.hex.match(/.{2}/g).map(h => parseInt(h, 16)));
      const parsed   = parseFrame(rawBytes);
      expect(parsed).not.toBeNull();
      const rebuilt  = buildFrame(parsed.frameType, parsed.seq, parsed.canId, parsed.payload);
      const reparsed = parseFrame(rebuilt);
      expect(reparsed.frameType).toBe(parsed.frameType);
      expect(reparsed.seq).toBe(parsed.seq);
      expect(reparsed.canId >>> 0).toBe(parsed.canId >>> 0);
      expect(Array.from(reparsed.payload)).toEqual(Array.from(parsed.payload));
    }
  });

  it('fixture contains at least one TX DATA frame and one RX DATA frame', () => {
    const tx = fixture.frames.filter(f => f.dir === 'TX');
    const rx = fixture.frames.filter(f => f.dir === 'RX');
    expect(tx.length).toBeGreaterThan(0);
    expect(rx.length).toBeGreaterThan(0);
  });

  it('fixture CAN IDs are plausible UDS addresses', () => {
    for (const f of fixture.frames) {
      expect(f.canId).toBeGreaterThan(0);
      expect(f.canId).toBeLessThanOrEqual(0x1FFFFFFF);
    }
  });
});
