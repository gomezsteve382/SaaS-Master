// SecurityAccessSource interface tests (Task #501).
// Run: node --test artifacts/srt-lab/src/__tests__/securityAccessSource.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalAlgoOverJ2534,
  FakeSecurityAccessSource,
  NRC,
} from "../lib/securityAccessSource.js";

function makeUds(script) {
  let i = 0;
  return async () => {
    const next = script[i++] || { ok: true, d: [0x7F, 0x27, 0x10] };
    return { ok: next.ok !== false, d: new Uint8Array(next.d) };
  };
}

test("LocalAlgoOverJ2534 throws if no uds callback is supplied", () => {
  assert.throws(() => LocalAlgoOverJ2534({}), /uds/);
});

test("LocalAlgoOverJ2534.unlock returns ok with the algorithm name on success", async () => {
  const seed = [0x67, 0x01, 0xDE, 0xAD, 0xBE, 0xEF];
  const success = [0x67, 0x02];
  const src = LocalAlgoOverJ2534({ uds: makeUds([{ d: seed }, { d: success }]) });
  const res = await src.unlock({ tx: 0x614, rx: 0x624, code: "BCM" }, 0x01);
  assert.equal(res.ok, true);
  assert.ok(typeof res.algo === "string" && res.algo.length > 0);
  assert.ok(Array.isArray(res.log));
});

test("LocalAlgoOverJ2534.unlock surfaces NRC 0x36 lockout in result", async () => {
  const seed = [0x67, 0x01, 0x12, 0x34, 0x56, 0x78];
  const lockout = [0x7F, 0x27, 0x36];
  const src = LocalAlgoOverJ2534({ uds: makeUds([{ d: seed }, { d: lockout }]) });
  const res = await src.unlock({ tx: 0x614, rx: 0x624, code: "BCM" }, 0x01);
  assert.equal(res.ok, false);
  assert.equal(res.nrc, NRC.EXCEEDED_NUMBER_OF_ATTEMPTS);
  assert.match(res.reason, /locked out/i);
});

test("LocalAlgoOverJ2534.unlock rejects target without tx/rx", async () => {
  const src = LocalAlgoOverJ2534({ uds: async () => ({ ok: true, d: new Uint8Array([0x67, 0x02]) }) });
  const res = await src.unlock({ code: "BCM" }, 0x01);
  assert.equal(res.ok, false);
  assert.match(res.reason, /tx\/rx/i);
});

test("FakeSecurityAccessSource returns the canned response for the matching key", async () => {
  const fake = FakeSecurityAccessSource({
    "1556:1": { ok: true, algo: "cda6" },
    default: { ok: false, reason: "no canned" },
  });
  const ok = await fake.unlock({ tx: 0x614, rx: 0x624, code: "BCM" }, 0x01);
  assert.equal(ok.ok, true);
  assert.equal(ok.algo, "cda6");
  const fb = await fake.unlock({ tx: 0x999, rx: 0x9A0, code: "X" }, 0x01);
  assert.equal(fb.ok, false);
});

test("FakeSecurityAccessSource accepts a function as the canned response", async () => {
  const fake = FakeSecurityAccessSource({
    "1556": (target, level) => ({ ok: true, algo: "fn", echo: { tx: target.tx, level } }),
  });
  const res = await fake.unlock({ tx: 0x614, rx: 0x624 }, 0x01);
  assert.equal(res.ok, true);
  assert.equal(res.algo, "fn");
  assert.equal(res.echo.tx, 0x614);
  assert.equal(res.echo.level, 0x01);
});
