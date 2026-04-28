// Pure-lib tests for the GPEC2A bench-flasher state machine (Task #488).
// Run: node --test artifacts/srt-lab/src/__tests__/flasherStateMachine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  flashEcm,
  FLASH_PHASES,
  parseDownloadResponse,
  buildRequestDownload,
  buildEraseRoutine,
  buildCheckRoutine,
} from "../lib/flasherStateMachine.js";
import { cda6 } from "../lib/algos.js";

function bytes(...args) { return new Uint8Array(args); }

// Build a fake bench bridge engine that records every UDS call and
// answers per the canned script the test sets up.
function makeEngine({ isBridge = true, script = [] } = {}) {
  const calls = [];
  let i = 0;
  const eng = {
    isBridge,
    calls,
    async uds(tx, rx, frame) {
      const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
      calls.push({ tx, rx, frame: arr });
      const next = script[i++];
      if (typeof next === "function") return next(arr, calls.length - 1);
      if (next) return next;
      return { ok: true, d: new Uint8Array(0) };
    },
  };
  return eng;
}

test("parseDownloadResponse decodes LFID-1 and LFID-2 maxNumberOfBlockLength", () => {
  const r1 = parseDownloadResponse(bytes(0x74, 0x10, 0x82));
  assert.deepEqual(r1, { maxNumberOfBlockLength: 0x82, payloadPerFrame: 0x80 });
  const r2 = parseDownloadResponse(bytes(0x74, 0x20, 0x04, 0x02));
  assert.deepEqual(r2, { maxNumberOfBlockLength: 0x0402, payloadPerFrame: 0x0400 });
  assert.equal(parseDownloadResponse(bytes(0x7F, 0x34, 0x33)), null);
  assert.equal(parseDownloadResponse(bytes(0x74)), null);
});

test("buildRequestDownload, buildEraseRoutine, buildCheckRoutine encode header bytes correctly", () => {
  const dl = buildRequestDownload(0x12345678, 0x100, 0x00);
  assert.deepEqual(dl, [0x34, 0x00, 0x44, 0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x01, 0x00]);
  const erase = buildEraseRoutine(0xAABBCCDD, 0x1000, 0xFF00);
  assert.deepEqual(erase.slice(0, 4), [0x31, 0x01, 0xFF, 0x00]);
  assert.deepEqual(erase.slice(4, 8), [0xAA, 0xBB, 0xCC, 0xDD]);
  const check = buildCheckRoutine(0xFF01);
  assert.deepEqual(check, [0x31, 0x01, 0xFF, 0x01]);
});

test("flashEcm refuses an engine that is not the bench bridge", async () => {
  const eng = makeEngine({ isBridge: false });
  const ctrl = flashEcm({ engine: eng, payload: new Uint8Array(16) });
  const r = await ctrl.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /bridge/i);
  assert.equal(eng.calls.length, 0, "must not transmit anything");
});

test("flashEcm refuses an empty payload", async () => {
  const eng = makeEngine();
  const r = await flashEcm({ engine: eng, payload: new Uint8Array(0) }).start();
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/i);
});

test("flashEcm walks the full UDS programming session against a scripted engine", async () => {
  const seed = 0x12345678 >>> 0;
  const expectedKey = cda6(seed) >>> 0;
  const payload = new Uint8Array(260);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;
  const sentChunks = [];

  const script = [
    // 1. session control
    { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
    // 2. seed request
    { ok: true, d: bytes(0x67, 0x01,
        (seed >>> 24) & 0xFF, (seed >>> 16) & 0xFF, (seed >>> 8) & 0xFF, seed & 0xFF) },
    // 3. send key — verify the bytes the state machine builds
    (frame) => {
      assert.equal(frame[0], 0x27);
      assert.equal(frame[1], 0x02);
      const got = ((frame[2] << 24) | (frame[3] << 16) | (frame[4] << 8) | frame[5]) >>> 0;
      assert.equal(got, expectedKey, "CDA6 key bytes must match");
      return { ok: true, d: bytes(0x67, 0x02) };
    },
    // 4. erase routine
    { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, 0x00) },
    // 5. RequestDownload — answer with maxBlock = 0x82 → payload 0x80
    { ok: true, d: bytes(0x74, 0x10, 0x82) },
  ];

  // 6. Transfer chunks: payload 260 / chunk 128 → 3 chunks (128 + 128 + 4).
  const chunkSize = 0x80;
  const expectedChunks = Math.ceil(payload.length / chunkSize);
  for (let i = 0; i < expectedChunks; i++) {
    script.push((frame) => {
      assert.equal(frame[0], 0x36);
      const seq = frame[1];
      sentChunks.push(frame.slice(2));
      return { ok: true, d: bytes(0x76, seq) };
    });
  }
  // 7. transfer exit, 8. checksum routine, 9. ECU reset
  script.push({ ok: true, d: bytes(0x77) });
  script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
  script.push({ ok: true, d: bytes(0x51, 0x01) });

  const eng = makeEngine({ script });
  const phases = [];
  const r = await flashEcm({
    engine: eng,
    payload,
    chunkSize,
    onProgress: (p) => p.phase && phases.push(p.phase),
  }).start();

  assert.equal(r.ok, true, `flash failed: ${r.error}`);
  assert.equal(r.bytesSent, payload.length);
  assert.equal(r.chunksSent, expectedChunks);
  assert.equal(r.maxNumberOfBlockLength, 0x82);
  assert.equal(r.seed, "0x12345678");
  assert.equal(r.key, "0x" + expectedKey.toString(16).toUpperCase().padStart(8, "0"));
  assert.equal(r.phase, FLASH_PHASES.DONE);
  // Every chunk we sent must reassemble exactly to the payload bytes.
  let off = 0;
  for (const c of sentChunks) {
    for (let i = 0; i < c.length; i++) assert.equal(c[i], payload[off + i]);
    off += c.length;
  }
  assert.equal(off, payload.length);
});

test("flashEcm sequence counter wraps 0xFF -> 0x00 across many chunks", async () => {
  // 257 chunks of 1 byte each forces the seq counter to wrap once.
  const payload = new Uint8Array(257);
  for (let i = 0; i < payload.length; i++) payload[i] = (i + 1) & 0xFF;
  const seenSeqs = [];
  const script = [
    { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
    { ok: true, d: bytes(0x67, 0x01, 0x00, 0x00, 0x00, 0x00) },
    (frame) => {
      // key send — accept whatever
      assert.equal(frame[0], 0x27);
      return { ok: true, d: bytes(0x67, 0x02) };
    },
    { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, 0x00) },
    // Force a 1-byte chunk: maxNumberOfBlockLength=3 → payload 1.
    { ok: true, d: bytes(0x74, 0x10, 0x03) },
  ];
  for (let i = 0; i < payload.length; i++) {
    script.push((frame) => {
      seenSeqs.push(frame[1]);
      return { ok: true, d: bytes(0x76, frame[1]) };
    });
  }
  script.push({ ok: true, d: bytes(0x77) });
  script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
  script.push({ ok: true, d: bytes(0x51, 0x01) });

  const eng = makeEngine({ script });
  const r = await flashEcm({ engine: eng, payload, chunkSize: 1 }).start();
  assert.equal(r.ok, true, `flash failed: ${r.error}`);
  assert.equal(seenSeqs.length, 257);
  assert.equal(seenSeqs[0], 1);
  assert.equal(seenSeqs[254], 255);
  assert.equal(seenSeqs[255], 0);
  assert.equal(seenSeqs[256], 1);
});

test("flashEcm honors AbortSignal and reports aborted=true", async () => {
  const ac = new AbortController();
  const payload = new Uint8Array(128);
  const script = [
    { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
    { ok: true, d: bytes(0x67, 0x01, 0x00, 0x00, 0x00, 0x00) },
    () => { ac.abort(); return { ok: true, d: bytes(0x67, 0x02) }; },
    { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, 0x00) },
  ];
  const eng = makeEngine({ script });
  const r = await flashEcm({ engine: eng, payload, signal: ac.signal }).start();
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.equal(r.phase, FLASH_PHASES.ABORTED);
});

test("flashEcm surfaces a UDS negative response (NRC) and stops", async () => {
  const script = [
    { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
    // 0x7F 0x27 0x35 = SecurityAccess NRC 0x35 (invalidKey-ish illustrative)
    { ok: true, d: bytes(0x7F, 0x27, 0x35) },
  ];
  const eng = makeEngine({ script });
  const r = await flashEcm({ engine: eng, payload: new Uint8Array(16) }).start();
  assert.equal(r.ok, false);
  assert.match(r.error, /negative|NRC/i);
  assert.equal(r.phase, FLASH_PHASES.SEED);
});
