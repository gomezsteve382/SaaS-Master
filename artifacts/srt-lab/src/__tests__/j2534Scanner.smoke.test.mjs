// End-to-end smoke test for the J2534 Scanner — software path only.
//
// This test substitutes a real Autel MaxiFlash + vehicle with an in-process
// fake J2534 bridge that speaks the same HTTP wire protocol as
// public/j2534_bridge.py. It then drives the bridgeClient.js API through the
// EXACT sequence the J2534Scanner UI runs:
//
//   getStatus → open → connect → setFilter → sendMsg(22 F1 90) → readMsg
//
// We assert that:
//   1. The Connect-Bridge probe succeeds and reports the expected vendor.
//   2. PassThruOpen + PassThruConnect bring up an ISO15765 / 500 kbps channel.
//   3. A targeted "Read ECM VIN" returns a 17-char VIN.
//   4. A targeted "Read BCM VIN" returns a 17-char VIN.
//   5. SCAN ALL MODULES walks moduleRegistry, finds every "live" address we
//      simulated, skips silent ones, and surfaces VINs for ECM + BCM.
//
// What this test deliberately DOES NOT cover (would require a real cable):
//   - ctypes loading of a vendor PassThru DLL
//   - Real CAN bus arbitration / ISO-TP segmentation by the cable
//   - Vehicle-specific NRC behaviour or response-pending (7F xx 78) timing
//   - SGW (Secure Gateway) authentication on a 2018+ FCA bus
//
// Run: node --test artifacts/srt-lab/src/__tests__/j2534Scanner.smoke.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

// bridgeClient.js touches localStorage at call time — shim it before import.
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const bridge = await import("../lib/bridgeClient.js");
const { REGISTRY } = await import("../lib/moduleRegistry.js");
const {
  FAKE_VIN, VENDOR, DLL_PATH, EXPECTED_VIN_HITS, EXPECTED_TOTAL_HITS,
  bytesToHex, hexToBytes, createFakeBridge,
} = await import("./_helpers/fakeJ2534Bridge.mjs");

// ─── Fake bridge ───────────────────────────────────────────────────────────
// Shared with J2534Scanner.ui.test.jsx so the same wire shapes drive both
// the lib-only smoke path and the browser-rendered React UI.

const fake = createFakeBridge();
const { state } = fake;
const reset = () => fake.reset();
const installFakeFetch = () => fake.install();

// ─── Scanner-flow helpers (mirror J2534Scanner.jsx) ────────────────────────
// Replicated here verbatim so the test doesn't pull in React for the hook.

const URL = "http://127.0.0.1:8765";
const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;

let lastFilter = { tx: -1, rx: -1 };

async function udsExchange(tx, rx, data, timeoutMs = 1500) {
  if (lastFilter.tx !== tx || lastFilter.rx !== rx) {
    const f = await bridge.setFilter({ txId: tx, rxId: rx }, URL);
    if (!f.ok) return { ok: false, error: "setFilter: " + (f.error || "failed") };
    lastFilter = { tx, rx };
  }
  const sm = await bridge.sendMsg(
    { txId: tx, data: bytesToHex(data), flags: ISO15765_FRAME_PAD, timeoutMs: 1000 },
    URL,
  );
  if (!sm.ok) return { ok: false, error: "sendMsg: " + (sm.error || "failed") };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await bridge.readMsg({ timeoutMs: 200 }, URL);
    if (!r) return { ok: false, error: "readMsg: no response" };
    if (!r.ok) return { ok: false, error: "readMsg: " + (r.error || "failed") };
    const m = r.msg;
    if (!m || !m.data) {
      // Empty buffer — re-poll once then bail. (Real scanner has a longer
      // tolerance here; we shorten it so the test runs fast.)
      await new Promise((res) => setTimeout(res, 5));
      continue;
    }
    if (typeof m.canId === "number" && rx && m.canId !== rx) continue;
    const bytes = hexToBytes(m.data);
    if (!bytes.length) continue;
    if (bytes.length >= 3 && bytes[0] === 0x7F && bytes[2] === 0x78) continue;
    return { ok: true, canId: m.canId, data: bytes };
  }
  return { ok: false, error: "timeout after " + timeoutMs + "ms" };
}

async function readVIN(tx, rx) {
  const r = await udsExchange(tx, rx, [0x22, 0xF1, 0x90], 800);
  if (!r.ok) return null;
  const b = r.data;
  if (b.length >= 4 && b[0] === 0x62 && b[1] === 0xF1 && b[2] === 0x90) {
    const ascii = b.slice(3).filter((x) => x >= 0x20 && x <= 0x7E);
    const s = String.fromCharCode(...ascii).slice(-17);
    return s.length === 17 ? s : null;
  }
  return null;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("scanner smoke: full hardware flow against fake bridge", async (t) => {
  reset();
  installFakeFetch();
  lastFilter = { tx: -1, rx: -1 };

  await t.test("Connect Bridge → /status reports vendor + DLL", async () => {
    const st = await bridge.getStatus(URL);
    assert.equal(st.ok, true, "bridge /status should respond ok");
    assert.equal(st.vendor, VENDOR);
    assert.equal(st.dllLoaded, true);
    assert.equal(st.dllPath, DLL_PATH);
    assert.equal(st.deviceOpen, false);
    assert.equal(st.channelConnected, false);
  });

  await t.test("Open J2534 Device → PassThruOpen succeeds", async () => {
    const o = await bridge.open(URL);
    assert.equal(o.ok, true, "open should succeed");
    assert.equal(o.deviceOpen, true);
    assert.equal(o.versions?.firmware, "V2.30 SN:FAKE");
  });

  await t.test("Connect CAN Channel → ISO15765 @ 500 kbps comes up", async () => {
    const c = await bridge.connect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, URL);
    assert.equal(c.ok, true, "connect should succeed");
    assert.equal(c.channelConnected, true);
  });

  await t.test("Read ECM VIN button → returns 17-char VIN", async () => {
    const vin = await readVIN(0x7E0, 0x7E8);
    assert.equal(vin, FAKE_VIN, "ECM should return the simulated VIN");
    assert.equal(vin.length, 17);
  });

  await t.test("Read BCM VIN button → returns 17-char VIN", async () => {
    const vin = await readVIN(0x750, 0x758);
    assert.equal(vin, FAKE_VIN, "BCM should return the simulated VIN");
    assert.equal(vin.length, 17);
  });

  await t.test("SCAN ALL MODULES → walks REGISTRY, finds expected modules", async () => {
    const targets = REGISTRY.filter((r) => r.kind !== "unsupported");
    assert.ok(targets.length > 20, "registry should expose >20 scannable rows");

    const found = [];
    for (const row of targets) {
      const v = await udsExchange(row.tx, row.rx, [0x22, 0xF1, 0x90], 400);
      if (!v.ok) continue;
      let vin = null;
      const b = v.data || [];
      if (b.length >= 4 && b[0] === 0x62 && b[1] === 0xF1 && b[2] === 0x90) {
        const ascii = b.slice(3).filter((x) => x >= 0x20 && x <= 0x7E);
        const s = String.fromCharCode(...ascii).slice(-17);
        if (s.length === 17) vin = s;
      }
      found.push({ code: row.code, tx: row.tx, vin });
    }

    assert.equal(
      found.length,
      EXPECTED_TOTAL_HITS,
      `scan should find exactly ${EXPECTED_TOTAL_HITS} live modules, got: ${found.map((f) => f.code).join(", ")}`,
    );

    const codesWithVin = found.filter((f) => f.vin).map((f) => f.code).sort();
    assert.deepEqual(
      codesWithVin,
      EXPECTED_VIN_HITS.slice().sort(),
      "every responding module except BCM_ALT (NRC 0x31) should yield a 17-char VIN",
    );

    // BCM_ALT must be present-but-VIN-less (proves NRC handling works).
    const bcmAlt = found.find((f) => f.tx === 0x742);
    assert.ok(bcmAlt, "BCM_ALT (0x742) should be detected even though it NRCs");
    assert.equal(bcmAlt.vin, null, "BCM_ALT should NOT yield a VIN (NRC 0x31)");

    // ECM + BCM must both have the right VIN — the task's hard requirement.
    const ecm = found.find((f) => f.tx === 0x7E0);
    const bcm = found.find((f) => f.tx === 0x750);
    assert.equal(ecm?.vin, FAKE_VIN, "ECM scan-row must return VIN");
    assert.equal(bcm?.vin, FAKE_VIN, "BCM scan-row must return VIN");
  });

  await t.test("Disconnect + Close → state machine resets cleanly", async () => {
    const d = await bridge.disconnect(URL);
    assert.equal(d.ok, true);
    assert.equal(d.channelConnected, false);
    const c = await bridge.close(URL);
    assert.equal(c.ok, true);
    assert.equal(c.deviceOpen, false);
  });
});

// ─── Edge-case tests: messy real-world bus quirks ──────────────────────────
// The smoke test above simulates a clean bus. Real vehicles produce messier
// behaviour the scanner has to tolerate, and the code paths for those quirks
// (response-pending loops, ERR_BUFFER_EMPTY hiccups, off-target frames,
// fragmented VIN delivery) live in J2534Scanner.jsx + bridgeClient.js but
// aren't exercised above. The helper below mirrors the real udsExchange in
// J2534Scanner.jsx more faithfully — including the "buffer_empty as continue"
// branch — so the new scenarios drive the same code shape the UI does.

async function udsExchangeReal(tx, rx, data, timeoutMs = 800) {
  if (lastFilter.tx !== tx || lastFilter.rx !== rx) {
    const f = await bridge.setFilter({ txId: tx, rxId: rx }, URL);
    if (!f.ok) return { ok: false, error: "setFilter: " + (f.error || "failed") };
    lastFilter = { tx, rx };
  }
  const sm = await bridge.sendMsg(
    { txId: tx, data: bytesToHex(data), flags: ISO15765_FRAME_PAD, timeoutMs: 1000 },
    URL,
  );
  if (!sm.ok) return { ok: false, error: "sendMsg: " + (sm.error || "failed") };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await bridge.readMsg({ timeoutMs: 50 }, URL);
    if (!r) return { ok: false, error: "readMsg: no response from bridge" };
    if (!r.ok) {
      // Mirror J2534Scanner.jsx: tolerate the daemon's various flavours of
      // "no message in buffer" and keep polling instead of bailing.
      const err = String(r.error || "").toLowerCase();
      if (err.includes("buffer_empty") || err.includes("buffer empty") ||
          err.includes("no msgs") || err.includes("no message") ||
          err.includes("status_noerror") || err === "empty") {
        continue;
      }
      return { ok: false, error: "readMsg: " + (r.error || "failed") };
    }
    const m = r.msg;
    if (!m || !m.data) continue;
    // Wrong-canId guard — drops off-target frames from a shared broadcast.
    if (typeof m.canId === "number" && rx && m.canId !== rx) continue;
    const bytes = hexToBytes(m.data);
    if (!bytes.length) continue;
    // 7F xx 78 = response pending; the scanner waits for the real reply.
    if (bytes.length >= 3 && bytes[0] === 0x7F && bytes[2] === 0x78) continue;
    return { ok: true, canId: m.canId, data: bytes };
  }
  return { ok: false, error: "timeout after " + timeoutMs + "ms" };
}

function vinFrame(canId, vin) {
  const vinBytes = Array.from(vin, (c) => c.charCodeAt(0));
  return { canId, data: bytesToHex([0x62, 0xF1, 0x90, ...vinBytes]) };
}
function pendingFrame(canId, sid = 0x22) {
  return { canId, data: bytesToHex([0x7F, sid, 0x78]) };
}

test("scanner edge cases: response-pending, wrong canId, fragmented delivery", async (t) => {
  reset();
  installFakeFetch();
  lastFilter = { tx: -1, rx: -1 };
  state.scripted = true; // tests pre-load state.rxQueue themselves

  const o = await bridge.open(URL);
  assert.equal(o.ok, true);
  const c = await bridge.connect({ protocol: PROTOCOL_ISO15765, baudrate: 500000 }, URL);
  assert.equal(c.ok, true);

  await t.test("7F xx 78 'response pending' loop — scanner waits past stalls", async () => {
    // ECM emits two 7F 22 78 "still working" frames before delivering the VIN.
    state.rxQueue = [
      pendingFrame(0x7E8),
      pendingFrame(0x7E8),
      vinFrame(0x7E8, FAKE_VIN),
    ];
    const t0 = Date.now();
    const r = await udsExchangeReal(0x7E0, 0x7E8, [0x22, 0xF1, 0x90], 1500);
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true, `expected ok response after pending stalls, got ${r.error}`);
    assert.equal(r.data[0], 0x62, "should skip the 7F frames and surface the 62 reply");
    const ascii = r.data.slice(3).filter((b) => b >= 0x20 && b <= 0x7E);
    assert.equal(String.fromCharCode(...ascii).slice(-17), FAKE_VIN);
    assert.ok(elapsed < 1500, `must not hit the 1500ms deadline (took ${elapsed}ms)`);
    assert.equal(state.rxQueue.length, 0, "all queued frames should have been consumed");
  });

  await t.test("ERR_BUFFER_EMPTY hiccup mid-scan — scanner keeps polling", async () => {
    // Daemon temporarily reports buffer-empty (ok:false) before the real
    // frame lands. Real scanner treats that as 'keep polling', not failure.
    state.bufferEmptyMode = true;
    state.emptyHiccups = 4; // four ok:false ERR_BUFFER_EMPTY returns first
    state.rxQueue = [vinFrame(0x758, FAKE_VIN)];
    try {
      const r = await udsExchangeReal(0x750, 0x758, [0x22, 0xF1, 0x90], 1000);
      assert.equal(r.ok, true, `should recover from buffer_empty, got ${r.error}`);
      assert.equal(r.data[0], 0x62);
      assert.equal(state.emptyHiccups, 0, "scanner should have polled through every hiccup");
    } finally {
      state.bufferEmptyMode = false;
      state.emptyHiccups = 0;
    }
  });

  await t.test("Hard readMsg failure (not buffer_empty) bails out fast — no 16s wait", async () => {
    // Distinguish recoverable buffer-empty hiccups from a real bridge fault.
    // A non-recoverable error must abort udsExchange immediately so the UI
    // doesn't sit on a 16s silent-timeout for every dead address.
    state.rxQueue = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (path === "/readmsg") {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ok: false, error: "PassThruReadMsgs returned ERR_DEVICE_NOT_CONNECTED" }),
        };
      }
      return origFetch(url, init);
    };
    try {
      const t0 = Date.now();
      const r = await udsExchangeReal(0x7E0, 0x7E8, [0x22, 0xF1, 0x90], 1500);
      const elapsed = Date.now() - t0;
      assert.equal(r.ok, false, "hard error must surface as failure");
      assert.match(r.error || "", /readMsg/, "should attribute the failure to readMsg");
      assert.ok(elapsed < 200, `must short-circuit, not poll to deadline (took ${elapsed}ms)`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await t.test("Two modules answering same broadcast — wrong-canId filter drops off-target frame", async () => {
    // Scanner targeted ECM (rx 0x7E8) but TCM (rx 0x7E9) also answered the
    // broadcast first with its own VIN. The off-target frame must be dropped
    // and the scanner must surface ECM's reply, not TCM's.
    const TCM_VIN  = "1C4RJFBG5KCTCMTCM"; // distinct so we can detect bleed-through
    const ECM_VIN  = FAKE_VIN;
    state.rxQueue = [
      vinFrame(0x7E9, TCM_VIN), // off-target — must be filtered out
      vinFrame(0x7E8, ECM_VIN), // on-target  — must be returned
    ];
    const r = await udsExchangeReal(0x7E0, 0x7E8, [0x22, 0xF1, 0x90], 1000);
    assert.equal(r.ok, true);
    assert.equal(r.canId, 0x7E8, "scanner must lock onto the requested rx id");
    const ascii = r.data.slice(3).filter((b) => b >= 0x20 && b <= 0x7E);
    const vin = String.fromCharCode(...ascii).slice(-17);
    assert.equal(vin, ECM_VIN, "must return ECM's VIN, never TCM's");
    assert.notEqual(vin, TCM_VIN, "off-target TCM VIN must not bleed through");
  });

  await t.test("ISO-TP VIN reply split across multiple readMsg polls — scanner stitches 17 chars", async () => {
    // On a busy bus the daemon interleaves empty polls and a stray pending
    // frame before finally delivering the assembled VIN payload. The scanner
    // must poll through them all and still extract the canonical 17-char
    // VIN from the eventual reply. (Real ISO-TP segmentation is reassembled
    // by the J2534 cable itself; what the scanner sees is the multi-poll
    // delivery cadence simulated here.)
    state.bufferEmptyMode = true;
    state.emptyHiccups = 2; // two ERR_BUFFER_EMPTY polls
    state.rxQueue = [
      pendingFrame(0x758),         // then: 7F 22 78 (response pending)
      { canId: 0x758, data: "" },  // then: an empty-data frame the scanner must skip
      vinFrame(0x758, FAKE_VIN),   // finally: the real assembled VIN reply
    ];
    const t0 = Date.now();
    try {
      const r = await udsExchangeReal(0x750, 0x758, [0x22, 0xF1, 0x90], 1500);
      const elapsed = Date.now() - t0;
      assert.equal(r.ok, true, `expected ok across split delivery, got ${r.error}`);
      // Mirror readVIN's parser — proves the scanner can still pull a 17-char
      // VIN out of a reply that arrived after several empty/pending polls.
      const b = r.data;
      assert.ok(b.length >= 4 && b[0] === 0x62 && b[1] === 0xF1 && b[2] === 0x90);
      const ascii = b.slice(3).filter((x) => x >= 0x20 && x <= 0x7E);
      const vin = String.fromCharCode(...ascii).slice(-17);
      assert.equal(vin.length, 17, "stitched VIN must be exactly 17 chars");
      assert.equal(vin, FAKE_VIN);
      assert.ok(elapsed < 1500, `must not hit deadline (took ${elapsed}ms)`);
      assert.equal(state.rxQueue.length, 0, "every interleaved frame should have been consumed");
    } finally {
      state.bufferEmptyMode = false;
      state.emptyHiccups = 0;
    }
  });

  await bridge.disconnect(URL);
  await bridge.close(URL);
});
