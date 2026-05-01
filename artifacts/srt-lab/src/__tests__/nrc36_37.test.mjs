// NRC 0x36 (lockout) and 0x37 (retry-after delay) handling for
// tryUnlockWithChain (Task #501).
// Run: node --test artifacts/srt-lab/src/__tests__/nrc36_37.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tryUnlockWithChain } from "../lib/algos.js";

// A scriptable fake `uds` callback. Each invocation returns the next
// canned response. We assert algorithmic behavior by counting calls and
// inspecting the log stream (instead of standing up a real CAN bus).
function makeUds(script) {
  let i = 0;
  const calls = [];
  const fn = async (tx, rx, bytes) => {
    calls.push({ tx, rx, bytes: Array.from(bytes) });
    const next = script[i++] || { ok: true, d: new Uint8Array([0x7F, 0x27, 0x10]) };
    return { ok: next.ok !== false, d: new Uint8Array(next.d) };
  };
  fn.calls = calls;
  return fn;
}

test("NRC 0x36 on key reject stops the chain immediately (no fallback)", async () => {
  // Script:
  //   1) seed request → 0x67 01 with non-zero seed
  //   2) key send     → 0x7F 27 36 (lockout)
  // Then nothing else should be issued: tryUnlockWithChain must return false
  // without trying the next algorithm in the chain.
  const seed = [0x67, 0x01, 0x12, 0x34, 0x56, 0x78];
  const lockout = [0x7F, 0x27, 0x36];
  const uds = makeUds([
    { d: seed },
    { d: lockout },
    // anything beyond this should not be touched
    { d: seed },
    { d: [0x67, 0x01, 0x00, 0x00, 0x00, 0x01] },
  ]);
  const log = [];
  const res = await tryUnlockWithChain(
    uds,
    0x614,
    0x624,
    ["cda6", "xtea_sgw"],
    (msg, kind) => log.push({ msg, kind }),
    "BCM",
    0x01,
    { sleep: () => Promise.resolve() },
  );
  assert.equal(res, false, "lockout must short-circuit");
  // Exactly two UDS frames: the seed request and the rejected key.
  assert.equal(uds.calls.length, 2);
  assert.equal(uds.calls[0].bytes[0], 0x27);
  assert.equal(uds.calls[0].bytes[1], 0x01);
  assert.equal(uds.calls[1].bytes[0], 0x27);
  assert.equal(uds.calls[1].bytes[1], 0x02);
  // Log must mention the lockout NRC explicitly.
  assert.ok(log.some((l) => /0x36|exceededNumberOfAttempts/.test(l.msg || "")));
});

test("NRC 0x37 on key reject sleeps then retries the SAME algorithm once", async () => {
  // Script:
  //   1) seed request → 0x67 01 …
  //   2) key send     → 0x7F 27 37 03  (delay byte = 3 seconds)
  //   3) seed request → 0x67 01 …
  //   4) key send     → 0x67 02       (success)
  const seed = [0x67, 0x01, 0xDE, 0xAD, 0xBE, 0xEF];
  const retryAfter = [0x7F, 0x27, 0x37, 0x03];
  const success = [0x67, 0x02];
  let slept = 0;
  const uds = makeUds([{ d: seed }, { d: retryAfter }, { d: seed }, { d: success }]);
  const res = await tryUnlockWithChain(
    uds,
    0x614,
    0x624,
    ["cda6"],
    () => {},
    "BCM",
    0x01,
    { sleep: (ms) => { slept = ms; return Promise.resolve(); } },
  );
  // Should resolve to the algorithm id we tried.
  assert.equal(res, "cda6");
  // The fake sleep should have been called with 3 seconds (3000 ms).
  assert.equal(slept, 3000);
  // Exactly four UDS frames — the retry stayed on the SAME algo.
  assert.equal(uds.calls.length, 4);
});

test("NRC 0x37 with no delay byte still retries once using the default delay", async () => {
  const seed = [0x67, 0x01, 0xDE, 0xAD, 0xBE, 0xEF];
  const retryAfter = [0x7F, 0x27, 0x37];
  const success = [0x67, 0x02];
  let slept = -1;
  const uds = makeUds([{ d: seed }, { d: retryAfter }, { d: seed }, { d: success }]);
  const res = await tryUnlockWithChain(
    uds,
    0x614,
    0x624,
    ["cda6"],
    () => {},
    "BCM",
    0x01,
    { sleep: (ms) => { slept = ms; return Promise.resolve(); }, defaultRetryMs: 750 },
  );
  assert.equal(res, "cda6");
  assert.equal(slept, 750);
});

test("NRC 0x37 retried once still failing then 0x35 walks to next algo", async () => {
  // First algo: seed → key → 0x37 → wait → seed → key → 0x35 (invalid key).
  // Second algo (xtea_sgw): seed → key → 0x67 (success).
  const seed = [0x67, 0x01, 0xCA, 0xFE, 0xBA, 0xBE];
  const retryAfter = [0x7F, 0x27, 0x37, 0x01];
  const invalidKey = [0x7F, 0x27, 0x35];
  const success = [0x67, 0x02];
  const uds = makeUds([
    { d: seed },
    { d: retryAfter },
    { d: seed },
    { d: invalidKey },
    { d: seed },
    { d: success },
  ]);
  const res = await tryUnlockWithChain(
    uds,
    0x74F,
    0x75F,
    ["cda6", "xtea_sgw"],
    () => {},
    "GW",
    0x01,
    { sleep: () => Promise.resolve() },
  );
  assert.equal(res, "xtea_sgw");
  assert.equal(uds.calls.length, 6);
});

test("NRC 0x36 on the SEED request also stops the chain", async () => {
  const lockoutSeed = [0x7F, 0x27, 0x36];
  const uds = makeUds([{ d: lockoutSeed }, { d: lockoutSeed }]);
  const res = await tryUnlockWithChain(
    uds,
    0x614,
    0x624,
    ["cda6", "xtea_sgw"],
    () => {},
    "BCM",
    0x01,
    { sleep: () => Promise.resolve() },
  );
  assert.equal(res, false);
  // Only the first 27 01 should have been issued.
  assert.equal(uds.calls.length, 1);
});
