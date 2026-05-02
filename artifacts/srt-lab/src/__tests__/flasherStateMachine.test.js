// Vitest coverage for the GPEC2A bench-flasher state machine (Task #488).
import { describe, test, expect } from 'vitest';
import {
  flashEcm,
  FLASH_PHASES,
  parseDownloadResponse,
  buildRequestDownload,
  buildEraseRoutine,
  buildCheckRoutine,
} from '../lib/flasherStateMachine.js';
import { cda6 } from '../lib/algos.js';

function bytes(...args) { return new Uint8Array(args); }

// Build a fake bench bridge engine that records every UDS call and
// answers per the canned script the test sets up. 0x3E 0x80 keep-alive
// frames and Task #563 etiquette frames (0x85 ControlDTCSetting,
// 0x28 CommunicationControl) are out-of-band: they answer with an
// empty positive response, do NOT consume a script entry, and are
// recorded into a separate `etiquette` array so existing scripted
// tests keep counting only the primary UDS flow while #563 tests can
// still assert on order and content of the etiquette frames.
function makeEngine({ isBridge = true, script = [] } = {}) {
  const calls = [];
  const etiquette = [];
  let i = 0;
  const eng = {
    isBridge,
    calls,
    etiquette,
    async uds(tx, rx, frame) {
      const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
      if (arr[0] === 0x3E) {
        // Tester present — out-of-band, not consumed from the script.
        return { ok: true, d: new Uint8Array(0) };
      }
      if (arr[0] === 0x85 || arr[0] === 0x28) {
        // Pre/post-flash etiquette — out-of-band, recorded separately.
        etiquette.push({ tx, rx, frame: arr });
        return { ok: true, d: new Uint8Array(0) };
      }
      calls.push({ tx, rx, frame: arr });
      const next = script[i++];
      if (typeof next === 'function') return next(arr, calls.length - 1);
      if (next) return next;
      return { ok: true, d: new Uint8Array(0) };
    },
  };
  return eng;
}

// Prefix shared by most happy-path scripts: 0x10 03 → 0x10 02 →
// 0x27 09 (seed) → 0x27 0A (key).
function happyPrefix(seed, expectedKey, sentChunks /* optional sink */){
  return [
    // 1. extended session 0x10 03
    { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) },
    // 2. programming session 0x10 02
    { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
    // 3. seed request 0x27 09
    { ok: true, d: bytes(0x67, 0x09,
        (seed >>> 24) & 0xFF, (seed >>> 16) & 0xFF, (seed >>> 8) & 0xFF, seed & 0xFF) },
    // 4. send key 0x27 0A
    (frame) => {
      expect(frame[0]).toBe(0x27);
      expect(frame[1]).toBe(0x0A);
      const got = ((frame[2] << 24) | (frame[3] << 16) | (frame[4] << 8) | frame[5]) >>> 0;
      expect(got).toBe(expectedKey);
      return { ok: true, d: bytes(0x67, 0x0A) };
    },
    // 5. erase routine
    { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, 0x00) },
  ];
}

describe('parseDownloadResponse', () => {
  test('decodes LFID-1 and LFID-2 maxNumberOfBlockLength', () => {
    const r1 = parseDownloadResponse(bytes(0x74, 0x10, 0x82));
    expect(r1).toEqual({ maxNumberOfBlockLength: 0x82, payloadPerFrame: 0x80 });
    const r2 = parseDownloadResponse(bytes(0x74, 0x20, 0x04, 0x02));
    expect(r2).toEqual({ maxNumberOfBlockLength: 0x0402, payloadPerFrame: 0x0400 });
  });
  test('rejects a 0x7F NRC frame', () => {
    expect(parseDownloadResponse(bytes(0x7F, 0x34, 0x33))).toBeNull();
  });
  test('rejects a malformed/truncated body', () => {
    expect(parseDownloadResponse(bytes(0x74))).toBeNull();
    expect(parseDownloadResponse(bytes(0x74, 0x20, 0x04))).toBeNull(); // LFID=2, only 1 length byte
  });
  test('rejects LFID=0 in the high nibble', () => {
    expect(parseDownloadResponse(bytes(0x74, 0x00, 0x80))).toBeNull();
  });
  test('rejects an absurdly small maxNumberOfBlockLength (< 3)', () => {
    // max=1 or 2 is smaller than SID + seq overhead — would lock the
    // transfer loop into zero-length frames.
    expect(parseDownloadResponse(bytes(0x74, 0x10, 0x01))).toBeNull();
    expect(parseDownloadResponse(bytes(0x74, 0x10, 0x02))).toBeNull();
  });
});

describe('header builders', () => {
  test('buildRequestDownload encodes ALFID 0x44 with 4-byte addr + 4-byte len', () => {
    const dl = buildRequestDownload(0x12345678, 0x100, 0x00, 0x44);
    expect(dl).toEqual([0x34, 0x00, 0x44, 0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x01, 0x00]);
  });
  test('buildEraseRoutine encodes the RID + 4-byte addr + 4-byte len', () => {
    const erase = buildEraseRoutine(0xAABBCCDD, 0x1000, 0xFF00);
    expect(erase.slice(0, 4)).toEqual([0x31, 0x01, 0xFF, 0x00]);
    expect(erase.slice(4, 8)).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
  });
  test('buildCheckRoutine encodes the verify RID', () => {
    expect(buildCheckRoutine(0xFF01)).toEqual([0x31, 0x01, 0xFF, 0x01]);
  });
});

describe('flashEcm pre-flight refusal', () => {
  test('refuses a non-bridge engine', async () => {
    const eng = makeEngine({ isBridge: false });
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(16) }).start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bridge/i);
    expect(eng.calls.length).toBe(0);
  });
  test('refuses an empty payload', async () => {
    const eng = makeEngine();
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(0) }).start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/i);
  });
  test('refuses a non-function algoFn', async () => {
    const eng = makeEngine();
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(16), algoFn: 'cda6' }).start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/algoFn/i);
  });
});

describe('flashEcm full UDS programming session', () => {
  test('walks 10 03 -> 10 02 -> 27 09/0A -> 31 erase -> 34 -> 36* -> 37 -> 31 verify -> 11 01', async () => {
    const seed = 0x12345678 >>> 0;
    const expectedKey = cda6(seed) >>> 0;
    const payload = new Uint8Array(260);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;
    const sentChunks = [];
    const script = happyPrefix(seed, expectedKey);
    // RequestDownload — answer with maxBlock = 0x82 → payload 0x80.
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x82) });
    // Transfer chunks: 260 / 128 → 3 chunks (128 + 128 + 4).
    const chunkSize = 0x80;
    const expectedChunks = Math.ceil(payload.length / chunkSize);
    for (let i = 0; i < expectedChunks; i++) {
      script.push((frame) => {
        expect(frame[0]).toBe(0x36);
        sentChunks.push(frame.slice(2));
        return { ok: true, d: bytes(0x76, frame[1]) };
      });
    }
    script.push({ ok: true, d: bytes(0x77) });                       // 0x37 ack
    script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) }); // verify ack
    script.push({ ok: true, d: bytes(0x51, 0x01) });                 // 0x11 01 ack

    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize }).start();

    expect(r.ok).toBe(true);
    expect(r.bytesSent).toBe(payload.length);
    expect(r.chunksSent).toBe(expectedChunks);
    expect(r.maxNumberOfBlockLength).toBe(0x82);
    expect(r.seed).toBe('0x12345678');
    expect(r.key).toBe('0x' + expectedKey.toString(16).toUpperCase().padStart(8, '0'));
    expect(r.phase).toBe(FLASH_PHASES.DONE);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    // Reassembled chunks must equal the payload.
    let off = 0;
    for (const c of sentChunks) {
      for (let i = 0; i < c.length; i++) expect(c[i]).toBe(payload[off + i]);
      off += c.length;
    }
    expect(off).toBe(payload.length);
    // First UDS frames must be 0x10 03 then 0x10 02.
    expect(eng.calls[0].frame).toEqual([0x10, 0x03]);
    expect(eng.calls[1].frame).toEqual([0x10, 0x02]);
    // Then 0x27 0x09 (seed request).
    expect(eng.calls[2].frame).toEqual([0x27, 0x09]);
  });

  test('honors the maxNumberOfBlockLength returned by the ECM', async () => {
    const seed = 0;
    const payload = new Uint8Array(50);
    const script = happyPrefix(seed, cda6(seed) >>> 0);
    // Negotiate down to payloadPerFrame=10 (max=0x0C → 12 - 2 = 10).
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x0C) });
    const expectedChunks = Math.ceil(payload.length / 10);
    for (let i = 0; i < expectedChunks; i++) {
      script.push((frame) => {
        // Each TransferData payload must be <= 10 bytes.
        expect(frame.length - 2).toBeLessThanOrEqual(10);
        return { ok: true, d: bytes(0x76, frame[1]) };
      });
    }
    script.push({ ok: true, d: bytes(0x77) });
    script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
    script.push({ ok: true, d: bytes(0x51, 0x01) });
    const eng = makeEngine({ script });
    // Caller asked for chunkSize 0x80 — must be clamped down to 10.
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
    expect(r.chunksSent).toBe(expectedChunks);
  });

  test('routes through the caller-supplied algoFn (canflash GPEC stand-in)', async () => {
    const seed = 0xCAFEBABE >>> 0;
    // Toy algorithm just to prove the picker is honored.
    const algoFn = (s) => ((s >>> 0) ^ 0xDEADBEEF) >>> 0;
    const expectedKey = algoFn(seed);
    const payload = new Uint8Array(8);
    const script = happyPrefix(seed, expectedKey);
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x0A) });
    script.push((f) => { expect(f[0]).toBe(0x36); return { ok: true, d: bytes(0x76, f[1]) }; });
    script.push({ ok: true, d: bytes(0x77) });
    script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
    script.push({ ok: true, d: bytes(0x51, 0x01) });
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, algoFn, algoLabel: 'cf_pcm_gpec' }).start();
    expect(r.ok).toBe(true);
    expect(r.algoLabel).toBe('cf_pcm_gpec');
    expect(r.key).toBe('0x' + expectedKey.toString(16).toUpperCase().padStart(8, '0'));
  });

  test('honors classic 0x27 01/02 subfunctions when the caller overrides', async () => {
    const seed = 0x11223344;
    const expectedKey = cda6(seed) >>> 0;
    const payload = new Uint8Array(4);
    const script = [
      { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) },
      { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
      { ok: true, d: bytes(0x67, 0x01,
          (seed >>> 24) & 0xFF, (seed >>> 16) & 0xFF, (seed >>> 8) & 0xFF, seed & 0xFF) },
      (f) => { expect(f[0]).toBe(0x27); expect(f[1]).toBe(0x02); return { ok: true, d: bytes(0x67, 0x02) }; },
      { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, 0x00) },
      { ok: true, d: bytes(0x74, 0x10, 0x06) },
      (f) => { expect(f[0]).toBe(0x36); return { ok: true, d: bytes(0x76, f[1]) }; },
      { ok: true, d: bytes(0x77) },
      { ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) },
      { ok: true, d: bytes(0x51, 0x01) },
    ];
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, seedSubfn: 0x01, keySubfn: 0x02 }).start();
    expect(r.ok).toBe(true);
  });
});

describe('flashEcm sequence wrap and resume', () => {
  test('sequence counter wraps 0xFF -> 0x00 -> 0x01 across many chunks', async () => {
    const payload = new Uint8Array(257);
    for (let i = 0; i < payload.length; i++) payload[i] = (i + 1) & 0xFF;
    const seenSeqs = [];
    const script = happyPrefix(0, cda6(0) >>> 0);
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x03) }); // payloadPerFrame=1
    for (let i = 0; i < payload.length; i++) {
      script.push((frame) => { seenSeqs.push(frame[1]); return { ok: true, d: bytes(0x76, frame[1]) }; });
    }
    script.push({ ok: true, d: bytes(0x77) });
    script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
    script.push({ ok: true, d: bytes(0x51, 0x01) });
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 1 }).start();
    expect(r.ok).toBe(true);
    expect(seenSeqs.length).toBe(257);
    expect(seenSeqs[0]).toBe(1);
    expect(seenSeqs[254]).toBe(255);
    expect(seenSeqs[255]).toBe(0);
    expect(seenSeqs[256]).toBe(1);
  });

  test('resumeFromChunk skips already-sent chunks and starts at the right seq/offset', async () => {
    const payload = new Uint8Array(40);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;
    const seen = [];
    const script = happyPrefix(0, cda6(0) >>> 0);
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x0C) }); // payloadPerFrame=10
    // 40 / 10 = 4 chunks total. Skip first 2 → only 2 fired.
    for (let i = 0; i < 2; i++) {
      script.push((frame) => { seen.push({seq: frame[1], first: frame[2]}); return { ok: true, d: bytes(0x76, frame[1]) }; });
    }
    script.push({ ok: true, d: bytes(0x77) });
    script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
    script.push({ ok: true, d: bytes(0x51, 0x01) });
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 10, resumeFromChunk: 2 }).start();
    expect(r.ok).toBe(true);
    expect(r.chunksSent).toBe(4); // counter includes the skipped chunks
    expect(seen.length).toBe(2);
    expect(seen[0].seq).toBe(0x03);          // chunks 1+2 already done → seq 3 next
    expect(seen[0].first).toBe(20);          // offset 20 = chunk #3 starts here
    expect(seen[1].seq).toBe(0x04);
    expect(seen[1].first).toBe(30);
  });
});

describe('flashEcm abort and NRC handling', () => {
  test('abort mid-transfer attempts a clean 0x37 exit and sets aborted=true', async () => {
    const ac = new AbortController();
    const payload = new Uint8Array(40);
    let exitSent = false;
    const seed = 0;
    const script = happyPrefix(seed, cda6(seed) >>> 0);
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x0C) }); // payloadPerFrame=10
    // First chunk OK, then abort mid-second chunk request.
    script.push((f) => { return { ok: true, d: bytes(0x76, f[1]) }; });
    script.push((f) => {
      ac.abort();
      // The state machine sees signal.aborted before the next call.
      return { ok: true, d: bytes(0x76, f[1]) };
    });
    // Next entry: best-effort 0x37 exit fired by the catch block.
    script.push((f) => { if (f[0] === 0x37) exitSent = true; return { ok: true, d: bytes(0x77) }; });
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 10, signal: ac.signal }).start();
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    expect(r.phase).toBe(FLASH_PHASES.ABORTED);
    expect(exitSent).toBe(true);
    expect(r.nextChunk).toBeGreaterThan(0); // resume affordance carried
  });

  test('surfaces a UDS NRC and stops at the failing phase', async () => {
    const script = [
      { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) },
      { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
      // 0x7F 0x27 0x35 = SecurityAccess NRC 0x35 (invalidKey-ish).
      { ok: true, d: bytes(0x7F, 0x27, 0x35) },
    ];
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(16) }).start();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/negative|NRC/i);
    expect(r.phase).toBe(FLASH_PHASES.SEED);
    expect(r.nrc).toBe(0x35);
  });
});

describe('flashEcm RoutineControl status enforcement (Task #488 rework)', () => {
  // Build a script that walks the entire happy path EXCEPT the final
  // verify-routine status byte, which the caller controls via `verifyStatus`.
  // If verifyStatus is null we omit the status byte entirely (some ECMs do
  // not append one — should still pass).
  function scriptThroughVerify(seed, expectedKey, payload, eraseStatus, verifyStatus){
    const script = [
      { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) },
      { ok: true, d: bytes(0x50, 0x02, 0x00, 0x32, 0x01, 0xF4) },
      { ok: true, d: bytes(0x67, 0x09,
          (seed >>> 24) & 0xFF, (seed >>> 16) & 0xFF, (seed >>> 8) & 0xFF, seed & 0xFF) },
      (frame) => ({ ok: true, d: bytes(0x67, 0x0A) }),
    ];
    // Erase routine — status configurable.
    if (eraseStatus === null) script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00) });
    else script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x00, eraseStatus & 0xFF) });
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x82) });
    const chunks = Math.ceil(payload.length / 0x80);
    for (let i = 0; i < chunks; i++) script.push((f) => ({ ok: true, d: bytes(0x76, f[1]) }));
    script.push({ ok: true, d: bytes(0x77) });
    if (verifyStatus === null) script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01) });
    else script.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, verifyStatus & 0xFF) });
    script.push({ ok: true, d: bytes(0x51, 0x01) });
    return script;
  }

  test('verify status 0x00 -> success', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = scriptThroughVerify(seed, cda6(seed) >>> 0, payload, 0x00, 0x00);
    const r = await flashEcm({ engine: makeEngine({ script }), payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
    expect(r.verifyStatus).toBe(0x00);
    expect(r.eraseStatus).toBe(0x00);
  });

  test('verify status omitted (bare 71 01 FF 01 echo) -> success', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = scriptThroughVerify(seed, cda6(seed) >>> 0, payload, null, null);
    const r = await flashEcm({ engine: makeEngine({ script }), payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
  });

  test('verify status 0x01 -> hard fail at CHECKSUM phase, not DONE', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = scriptThroughVerify(seed, cda6(seed) >>> 0, payload, 0x00, 0x01);
    const r = await flashEcm({ engine: makeEngine({ script }), payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(false);
    expect(r.phase).toBe(FLASH_PHASES.CHECKSUM);
    expect(r.error).toMatch(/Verify routine failed.*non-zero status 0x01/i);
    expect(r.verifyStatus).toBe(0x01);
  });

  test('erase status 0xFF -> hard fail at ERASE phase, never reaches transfer', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = scriptThroughVerify(seed, cda6(seed) >>> 0, payload, 0xFF, 0x00);
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(false);
    expect(r.phase).toBe(FLASH_PHASES.ERASE);
    expect(r.error).toMatch(/Erase routine failed.*non-zero status 0xFF/i);
    expect(r.eraseStatus).toBe(0xFF);
    // Transfer (0x36) must NOT have been attempted.
    expect(eng.calls.some(c => Array.isArray(c.frame) && c.frame[0] === 0x36)).toBe(false);
  });

  test('verify response with wrong RID -> hard fail (RID mismatch)', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = scriptThroughVerify(seed, cda6(seed) >>> 0, payload, 0x00, 0x00);
    // Replace the verify ack (second-to-last entry) with a bogus RID.
    script[script.length - 2] = { ok: true, d: bytes(0x71, 0x01, 0xDE, 0xAD, 0x00) };
    const r = await flashEcm({ engine: makeEngine({ script }), payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(false);
    expect(r.phase).toBe(FLASH_PHASES.CHECKSUM);
    expect(r.error).toMatch(/Verify routine failed.*RID mismatch/i);
  });
});

describe('flashEcm pre/post-flash etiquette (Task #563)', () => {
  // Reuse happyPrefix + a minimal trailer to get a successful flash.
  function happyTail(payload, chunkSize = 0x80){
    const out = [];
    out.push({ ok: true, d: bytes(0x74, 0x10, 0x82) });
    const chunks = Math.ceil(payload.length / chunkSize);
    for (let i = 0; i < chunks; i++){
      out.push((f) => ({ ok: true, d: bytes(0x76, f[1]) }));
    }
    out.push({ ok: true, d: bytes(0x77) });
    out.push({ ok: true, d: bytes(0x71, 0x01, 0xFF, 0x01, 0x00) });
    out.push({ ok: true, d: bytes(0x51, 0x01) });
    return out;
  }

  test('happy path fires 0x85 + 0x28 pre and post in the right order', async () => {
    const seed = 0;
    const payload = new Uint8Array(64);
    const script = [...happyPrefix(seed, cda6(seed) >>> 0), ...happyTail(payload)];
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
    // Exactly four etiquette frames: pre-0x85, pre-0x28, post-0x28, post-0x85.
    expect(eng.etiquette).toHaveLength(4);
    // Pre-half: 0x85 0x02 on target, then 0x28 0x03 0x03 on broadcast.
    expect(eng.etiquette[0].frame).toEqual([0x85, 0x02]);
    expect(eng.etiquette[0].tx).toBe(0x7E0);
    expect(eng.etiquette[1].frame).toEqual([0x28, 0x03, 0x03]);
    expect(eng.etiquette[1].tx).toBe(0x7DF);
    // Post-half: 0x28 0x00 0x00 on broadcast, then 0x85 0x01 on target.
    expect(eng.etiquette[2].frame).toEqual([0x28, 0x00, 0x00]);
    expect(eng.etiquette[2].tx).toBe(0x7DF);
    expect(eng.etiquette[3].frame).toEqual([0x85, 0x01]);
    expect(eng.etiquette[3].tx).toBe(0x7E0);
    // Plain-language log lines must appear.
    const msgs = r.log.map(l => l.msg).join('\n');
    expect(msgs).toMatch(/DTC logging suppressed/);
    expect(msgs).toMatch(/Bus chatter silenced/);
    expect(msgs).toMatch(/DTC logging restored/);
    expect(msgs).toMatch(/Bus chatter restored/);
  });

  test('etiquette pre runs after extended session and before programming session', async () => {
    const seed = 0;
    const payload = new Uint8Array(8);
    const script = [...happyPrefix(seed, cda6(seed) >>> 0), ...happyTail(payload)];
    const eng = makeEngine({ script });
    // Wrap engine.uds to capture a global ordering across both
    // primary calls and etiquette frames.
    const order = [];
    const real = eng.uds.bind(eng);
    eng.uds = async (tx, rx, frame) => {
      const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
      if (arr[0] !== 0x3E) order.push(arr); // ignore keep-alive noise
      return real(tx, rx, frame);
    };
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
    const idxExt   = order.findIndex(a => a[0] === 0x10 && a[1] === 0x03);
    const idx85Pre = order.findIndex(a => a[0] === 0x85 && a[1] === 0x02);
    const idx28Pre = order.findIndex(a => a[0] === 0x28 && a[1] === 0x03);
    const idxProg  = order.findIndex(a => a[0] === 0x10 && a[1] === 0x02);
    const idxReset = order.findIndex(a => a[0] === 0x11 && a[1] === 0x01);
    const idx28Post= order.findIndex(a => a[0] === 0x28 && a[1] === 0x00);
    const idx85Post= order.findIndex(a => a[0] === 0x85 && a[1] === 0x01);
    expect(idxExt).toBeLessThan(idx85Pre);
    expect(idx85Pre).toBeLessThan(idx28Pre);
    expect(idx28Pre).toBeLessThan(idxProg);
    expect(idxReset).toBeLessThan(idx28Post);
    expect(idx28Post).toBeLessThan(idx85Post);
  });

  test('abort mid-transfer still restores etiquette via finally', async () => {
    const ac = new AbortController();
    const payload = new Uint8Array(40);
    const seed = 0;
    const script = [...happyPrefix(seed, cda6(seed) >>> 0)];
    script.push({ ok: true, d: bytes(0x74, 0x10, 0x0C) });
    // First chunk OK, then abort during second.
    script.push((f) => ({ ok: true, d: bytes(0x76, f[1]) }));
    script.push((f) => { ac.abort(); return { ok: true, d: bytes(0x76, f[1]) }; });
    // Best-effort 0x37 close.
    script.push((f) => ({ ok: true, d: bytes(0x77) }));
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 10, signal: ac.signal }).start();
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    // Pre etiquette ran (2 frames), and post etiquette MUST also run
    // from the finally block (2 more frames) — total 4.
    expect(eng.etiquette).toHaveLength(4);
    expect(eng.etiquette[2].frame).toEqual([0x28, 0x00, 0x00]);
    expect(eng.etiquette[3].frame).toEqual([0x85, 0x01]);
  });

  test('failure before etiquettePre completes still leaves the bus untouched', async () => {
    // Fail at the very first call (extended session NRC) so etiquettePre
    // never runs and there is nothing to restore.
    const script = [
      { ok: true, d: bytes(0x7F, 0x10, 0x22) }, // conditionsNotCorrect
    ];
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(8) }).start();
    expect(r.ok).toBe(false);
    expect(r.phase).toBe(FLASH_PHASES.SESSION_EXT);
    // No etiquette frames in either direction — nothing to restore.
    expect(eng.etiquette).toHaveLength(0);
  });

  test('NRC on pre-flash 0x85 aborts the flash before erase/transfer', async () => {
    // Engine that returns a 0x7F NRC on the very first 0x85 etiquette
    // frame. With the strict NRC handling the task requires, the flash
    // must abort here — never reaching 0x10 02 or any 0x36 transfer.
    const seed = 0;
    const payload = new Uint8Array(64);
    const calls = [];
    let etiquetteSeen = 0;
    const eng = {
      isBridge: true,
      calls,
      async uds(tx, rx, frame) {
        const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
        if (arr[0] === 0x3E) return { ok: true, d: new Uint8Array(0) };
        if (arr[0] === 0x85) {
          etiquetteSeen++;
          // 0x7F 0x85 0x22 = conditionsNotCorrect on ControlDTCSetting.
          return { ok: true, d: bytes(0x7F, 0x85, 0x22) };
        }
        calls.push({ tx, rx, frame: arr });
        // Only the extended session (first call) should be reachable.
        if (calls.length === 1) return { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) };
        throw new Error('flasher should never reach here');
      },
    };
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x22);
    expect(r.error).toMatch(/ControlDTCSetting.*negative response/i);
    expect(etiquetteSeen).toBe(1); // 0x28 was never attempted
    // Programming session, erase, RequestDownload, TransferData all skipped.
    expect(calls.some(c => c.frame[0] === 0x10 && c.frame[1] === 0x02)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x31)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x34)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x36)).toBe(false);
  });

  test('partial pre-flash failure (0x85 OK, 0x28 NRC) still triggers finally restore', async () => {
    // Engine where 0x85 0x02 succeeds but 0x28 0x03 0x03 returns NRC.
    // The finally block must still attempt BOTH restore frames so DTC
    // logging and bus comms come back up — even though `etiquetteApplied`
    // would have been false if it were guarded on "both pre frames OK".
    const calls = [];
    const etiquette = [];
    let chunkIdx = 0;
    const eng = {
      isBridge: true,
      etiquette,
      async uds(tx, rx, frame) {
        const arr = frame instanceof Uint8Array ? Array.from(frame) : [...frame];
        if (arr[0] === 0x3E) return { ok: true, d: new Uint8Array(0) };
        if (arr[0] === 0x85 || arr[0] === 0x28) {
          etiquette.push({ tx, rx, frame: arr });
          // 0x85 0x02 succeeds (positive response).
          if (arr[0] === 0x85 && arr[1] === 0x02) return { ok: true, d: bytes(0xC5, 0x02) };
          // 0x28 0x03 0x03 fails with conditionsNotCorrect.
          if (arr[0] === 0x28 && arr[1] === 0x03) return { ok: true, d: bytes(0x7F, 0x28, 0x22) };
          // Restore frames in finally — return positive responses.
          return { ok: true, d: new Uint8Array(0) };
        }
        calls.push({ tx, rx, frame: arr });
        // Only the extended session is reachable before the 0x28 NRC.
        if (arr[0] === 0x10 && arr[1] === 0x03) return { ok: true, d: bytes(0x50, 0x03, 0x00, 0x32, 0x01, 0xF4) };
        throw new Error('flasher should never reach here');
      },
    };
    const r = await flashEcm({ engine: eng, payload: new Uint8Array(64), chunkSize: 0x80 }).start();
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x22);
    expect(r.error).toMatch(/CommunicationControl.*negative response/i);
    // Pre 0x85 + pre 0x28 + finally restore 0x28 + finally restore 0x85 = 4 frames.
    expect(etiquette).toHaveLength(4);
    expect(etiquette[0].frame).toEqual([0x85, 0x02]);
    expect(etiquette[1].frame).toEqual([0x28, 0x03, 0x03]);
    expect(etiquette[2].frame).toEqual([0x28, 0x00, 0x00]);
    expect(etiquette[3].frame).toEqual([0x85, 0x01]);
    // Erase / RequestDownload / TransferData were never reached.
    expect(calls.some(c => c.frame[0] === 0x10 && c.frame[1] === 0x02)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x31)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x34)).toBe(false);
    expect(calls.some(c => c.frame[0] === 0x36)).toBe(false);
  });

  test('etiquettePost runs exactly once on the success path (no double restore)', async () => {
    const seed = 0;
    const payload = new Uint8Array(8);
    const script = [...happyPrefix(seed, cda6(seed) >>> 0), ...happyTail(payload)];
    const eng = makeEngine({ script });
    const r = await flashEcm({ engine: eng, payload, chunkSize: 0x80 }).start();
    expect(r.ok).toBe(true);
    // 4 frames total = 2 pre + 2 post (NOT 2 + 4).
    expect(eng.etiquette).toHaveLength(4);
  });
});
