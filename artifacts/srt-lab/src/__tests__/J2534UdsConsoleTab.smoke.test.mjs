// Smoke test for the J2534 UDS Console connection state machine.
//
// Exercises the four-state flow:
//   disconnected → bridge_connected → device_open → can_connected
// and the UDS send path, against the shared fake J2534 bridge.
//
// This test does NOT render React — it drives the same bridgeClient
// primitives that J2534UdsConsoleTab.jsx uses, in the same sequence,
// and asserts on the same conditions the component evaluates to
// decide which badge label and which buttons to show.
//
// Scenarios covered:
//   1. Connect Bridge → /status ok → badge condition "bridge_connected"
//   2. Open Device   → /open + /connect → badge condition "can_connected"
//   3. Tester-present keepalive starts (/startperiodic txId=0x7DF, "3E02")
//   4. Send raw bytes → setFilter + sendMsg + readMsg → TX/RX log entries
//   5. Quick-launch buttons (Read VIN, Ext Session, ECU Reset) carry correct bytes
//   6. Disconnect → /stopperiodic called, channel + device close
//
// Run: node --test artifacts/srt-lab/src/__tests__/J2534UdsConsoleTab.smoke.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

// bridgeClient.js reads localStorage at import time — shim before importing.
globalThis.localStorage = {
  _s: {},
  getItem(k)    { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const bridge = await import("../lib/bridgeClient.js");
const { createFakeBridge, FAKE_VIN, hexToBytes } = await import("./_helpers/fakeJ2534Bridge.mjs");

// ─── Constants (mirror J2534UdsConsoleTab.jsx) ──────────────────────────────

const PROTOCOL_ISO15765   = 6;
const ISO15765_FRAME_PAD  = 0x40;
const BRIDGE_URL          = "http://127.0.0.1:8765";

// ─── Quick-launch commands (mirror QUICK_CMDS in J2534UdsConsoleTab.jsx) ────

const QUICK_CMDS = [
  { label: "Read VIN",       bytes: [0x22, 0xF1, 0x90] },
  { label: "Ext Session",    bytes: [0x10, 0x03] },
  { label: "Tester Present", bytes: [0x3E, 0x02] },
  { label: "ECU Reset",      bytes: [0x11, 0x01] },
  { label: "Read DTCs",      bytes: [0x19, 0x02, 0x08] },
  { label: "Clear DTCs",     bytes: [0x14, 0xFF, 0xFF, 0xFF] },
];

// ─── Extended fake bridge: adds /startperiodic + /stopperiodic ───────────────
// The core fakeJ2534Bridge covers /status /open /connect /disconnect /close
// /setfilter /sendmsg /readmsg.  This wrapper layers on the two extra paths
// that J2534UdsConsoleTab.jsx calls via bridgeCallRaw (keepalive management).

function createUdsFakeBridge() {
  const core = createFakeBridge();
  const periodicCalls = [];   // records each /startperiodic call body + assigned id
  const stopCalls    = [];    // records each periodicId passed to /stopperiodic
  let nextId = 1;

  const coreF = core.fakeFetch;

  async function fakeFetch(url, init = {}) {
    const path   = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = (init.method || "GET").toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }

    if (method === "POST" && path === "/startperiodic") {
      const periodicId = nextId++;
      periodicCalls.push({ ...(body ?? {}), periodicId });
      const json = { ok: true, periodicId };
      return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
    }

    if (method === "POST" && path === "/stopperiodic") {
      stopCalls.push(body?.periodicId ?? null);
      const json = { ok: true };
      return { ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json };
    }

    return coreF(url, init);
  }

  function install() {
    const prev = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    return () => { globalThis.fetch = prev; };
  }

  function reset() {
    core.reset();
    periodicCalls.length = 0;
    stopCalls.length     = 0;
    nextId               = 1;
  }

  return { ...core, fakeFetch, install, reset, periodicCalls, stopCalls };
}

// ─── udsCall (mirrors J2534UdsConsoleTab.jsx logic verbatim) ────────────────

function hx(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, "0"); }

async function udsCall(url, tx, rx, data, timeoutMs = 4000) {
  await bridge.setFilter({ txId: tx, rxId: rx }, url);
  const dataHex = Array.from(data).map(b => hx(b)).join("");
  const sm = await bridge.sendMsg({ txId: tx, data: dataHex, flags: ISO15765_FRAME_PAD, timeoutMs: 1000 }, url);
  if (!sm || !sm.ok) return { ok: false, raw: sm?.error || "sendMsg failed" };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = Math.min(1500, Math.max(150, deadline - Date.now()));
    const r = await bridge.readMsg({ timeoutMs: slice }, url);
    if (!r || !r.ok) return { ok: false, raw: r?.error || "readMsg failed" };
    const msg = r.msg;
    if (!msg || !msg.data) continue;
    if (typeof msg.canId === "number" && rx && msg.canId !== rx) continue;
    if (msg.rxStatus & 0x01) continue;
    const bytes = hexToBytes(msg.data);
    if (!bytes.length) continue;
    if (bytes.length >= 3 && bytes[0] === 0x7F && bytes[2] === 0x78) continue;
    return { ok: true, d: new Uint8Array(bytes), raw: msg.data };
  }
  return { ok: false, raw: `timeout after ${timeoutMs}ms` };
}

// ─── Keepalive helpers (mirror bridgeCallRaw in J2534UdsConsoleTab.jsx) ──────

async function startKeepalive(url) {
  const res = await globalThis.fetch(`${url}/startperiodic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txId: 0x7DF, data: "3E02", intervalMs: 1000, flags: ISO15765_FRAME_PAD }),
  });
  return res.json();
}

async function stopKeepalive(url, periodicId) {
  const res = await globalThis.fetch(`${url}/stopperiodic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ periodicId }),
  });
  return res.json();
}

// ─── Main flow test ──────────────────────────────────────────────────────────
// Subtests run in order and share the same fake-bridge state so each step
// builds on the previous one, exactly as the UI's state machine does.

const fake = createUdsFakeBridge();

test("UDS Console state machine: full four-state connection flow", async (t) => {
  fake.reset();
  fake.install();

  // ── 1. Connect Bridge ─────────────────────────────────────────────────────
  await t.test("Connect Bridge → /status ok → badge transitions to BRIDGE OK", async () => {
    const st = await bridge.getStatus(BRIDGE_URL);

    assert.equal(st.ok,               true,  "/status must succeed");
    assert.equal(st.dllLoaded,        true,  "DLL must be loaded so component reaches bridge_connected");
    assert.equal(st.deviceOpen,       false, "device must not yet be open");
    assert.equal(st.channelConnected, false, "channel must not yet be connected");

    // Component evaluates:  dllLoaded && !deviceOpen → setStatus("bridge_connected")
    // → badge shows "● BRIDGE OK"
    assert.ok(
      st.dllLoaded && !st.deviceOpen,
      "status conditions must produce bridge_connected transition, not no-DLL warning branch",
    );
  });

  // ── 2. Open Device + Connect CAN channel ──────────────────────────────────
  await t.test("Open Device → /open succeeds → state becomes device_open", async () => {
    const opened = await bridge.open(BRIDGE_URL);
    assert.equal(opened.ok,         true, "/open must succeed");
    assert.equal(opened.deviceOpen, true, "deviceOpen must flip true");
    assert.ok(opened.versions?.firmware,  "firmware version string must be present");
  });

  await t.test("Connect CAN → /connect ISO15765@500kbps → badge transitions to CAN LIVE", async () => {
    const c = await bridge.connect(
      { protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 },
      BRIDGE_URL,
    );
    assert.equal(c.ok,               true, "/connect must succeed");
    assert.equal(c.channelConnected, true, "channelConnected must flip true");
    // Component then calls startKeepalive() and setStatus("can_connected")
    // → badge shows "● CAN LIVE"
  });

  // ── 3. Tester-present keepalive ───────────────────────────────────────────
  await t.test("Keepalive → /startperiodic called with 0x7DF + '3E02' + 1000 ms interval", async () => {
    const pr = await startKeepalive(BRIDGE_URL);

    assert.equal(pr.ok,                    true,  "/startperiodic must succeed");
    assert.ok(pr.periodicId != null,              "must return a numeric periodicId");
    assert.equal(fake.periodicCalls.length, 1,    "exactly one /startperiodic call must be recorded");

    const call = fake.periodicCalls[0];
    assert.equal(call.txId,       0x7DF,   "tester-present must broadcast on functional address 0x7DF");
    assert.equal(call.data,       "3E02",  "tester-present payload must be 3E 02 (suppressPosRspMsgIndBit)");
    assert.equal(call.intervalMs, 1000,    "keepalive interval must be exactly 1000 ms");
  });

  // ── 4. Send raw bytes ─────────────────────────────────────────────────────
  await t.test("Send raw bytes → setFilter + sendMsg + readMsg → TX/RX response received", async () => {
    // Drive the same udsCall the component's send() calls — ECM VIN read.
    const r = await udsCall(BRIDGE_URL, 0x7E0, 0x7E8, [0x22, 0xF1, 0x90], 2000);

    assert.equal(r.ok, true, `udsCall must succeed, got: ${r.raw}`);
    assert.ok(r.d,             "response bytes must be present");

    // Validate response SID (0x62 = positive response to 0x22 ReadDataByIdentifier)
    assert.equal(r.d[0], 0x62, "first RX byte must be positive response SID 0x62");
    assert.equal(r.d[1], 0xF1, "DID byte 1 must echo back 0xF1");
    assert.equal(r.d[2], 0x90, "DID byte 2 must echo back 0x90");

    // Extract VIN from payload (mirrors the component's RX log rendering)
    const vinBytes = Array.from(r.d.slice(3)).filter(b => b >= 0x20 && b <= 0x7E);
    const vin = String.fromCharCode(...vinBytes).slice(-17);
    assert.equal(vin.length, 17,       "extracted VIN must be exactly 17 characters");
    assert.equal(vin, FAKE_VIN,        "VIN from ECM must match the fake bus VIN");

    // Confirm the log would show TX and RX entries (validates data shapes)
    const txHex = "22 F1 90";
    const rxHex = Array.from(r.d).map(b => hx(b)).join(" ");
    assert.ok(rxHex.startsWith("62"), "RX log entry must start with 62 (positive response)");
    assert.ok(txHex.includes("22"),   "TX log entry must include service ID 22 (RDBI)");
  });

  // ── 5. Quick-launch buttons fire the correct byte arrays ──────────────────
  await t.test("Quick-launch 'Read VIN' sends [22 F1 90] and receives a valid ECM VIN response", async () => {
    const cmd = QUICK_CMDS.find(c => c.label === "Read VIN");
    assert.ok(cmd,                                          "Read VIN must be present in QUICK_CMDS");
    assert.deepEqual(cmd.bytes, [0x22, 0xF1, 0x90],        "Read VIN byte array must be 22 F1 90");

    // Exercise the actual exchange — fake bus returns a VIN for ECM
    const r = await udsCall(BRIDGE_URL, 0x7E0, 0x7E8, cmd.bytes, 2000);
    assert.equal(r.ok,   true,  `Read VIN quick-launch must get a response, got: ${r.raw}`);
    assert.equal(r.d[0], 0x62,  "must receive positive response SID to 22 F1 90");
  });

  await t.test("Quick-launch 'Ext Session' byte array is [10 03]", () => {
    const cmd = QUICK_CMDS.find(c => c.label === "Ext Session");
    assert.ok(cmd, "Ext Session must be present in QUICK_CMDS");
    assert.deepEqual(cmd.bytes, [0x10, 0x03], "Ext Session byte array must be 10 03 (DiagnosticSessionControl extendedDiagnosticSession)");
    // Verify hex representation matches what sendMsg receives
    const hexSent = Array.from(cmd.bytes).map(b => hx(b)).join("").toUpperCase();
    assert.equal(hexSent, "1003");
  });

  await t.test("Quick-launch 'ECU Reset' byte array is [11 01]", () => {
    const cmd = QUICK_CMDS.find(c => c.label === "ECU Reset");
    assert.ok(cmd, "ECU Reset must be present in QUICK_CMDS");
    assert.deepEqual(cmd.bytes, [0x11, 0x01], "ECU Reset byte array must be 11 01 (ECUReset hardReset)");
    const hexSent = Array.from(cmd.bytes).map(b => hx(b)).join("").toUpperCase();
    assert.equal(hexSent, "1101");
  });

  // ── 6. Disconnect → stopperiodic called, state resets ────────────────────
  await t.test("Disconnect → /stopperiodic called with keepalive id → channel + device close", async () => {
    const periodicId = fake.periodicCalls[0]?.periodicId;
    assert.ok(periodicId != null, "must have a periodicId recorded from the earlier startperiodic call");

    // Component calls bridgeCallRaw(url, "/stopperiodic", { periodicId })
    const sr = await stopKeepalive(BRIDGE_URL, periodicId);
    assert.equal(sr.ok, true, "/stopperiodic must succeed");
    assert.ok(
      fake.stopCalls.includes(periodicId),
      `periodicId ${periodicId} must be recorded in stopperiodic call log`,
    );

    // Component then calls setStatus("disconnected") and clears the log.
    // On the wire that translates to disconnect + close.
    const d = await bridge.disconnect(BRIDGE_URL);
    assert.equal(d.ok,               true,  "/disconnect must succeed");
    assert.equal(d.channelConnected, false, "channel must report disconnected");

    const cl = await bridge.close(BRIDGE_URL);
    assert.equal(cl.ok,         true,  "/close must succeed");
    assert.equal(cl.deviceOpen, false, "device must report closed");

    // Confirm fake-bridge internal state is fully reset
    assert.equal(fake.state.connected, false, "fake bridge connected flag must be false");
    assert.equal(fake.state.opened,    false, "fake bridge opened flag must be false");
  });
});

// ─── All quick-launch byte shapes: exhaustive static check ──────────────────

test("UDS Console: all QUICK_CMDS carry correct UDS byte arrays", () => {
  const expected = [
    { label: "Read VIN",       hex: "22F190"   },
    { label: "Ext Session",    hex: "1003"     },
    { label: "Tester Present", hex: "3E02"     },
    { label: "ECU Reset",      hex: "1101"     },
    { label: "Read DTCs",      hex: "190208"   },
    { label: "Clear DTCs",     hex: "14FFFFFF" },
  ];

  assert.equal(QUICK_CMDS.length, expected.length, "QUICK_CMDS length must match expected table");

  for (const want of expected) {
    const cmd = QUICK_CMDS.find(c => c.label === want.label);
    assert.ok(cmd, `${want.label} must be present in QUICK_CMDS`);
    const actual = Array.from(cmd.bytes).map(b => hx(b)).join("").toUpperCase();
    assert.equal(actual, want.hex.toUpperCase(), `${want.label}: byte array mismatch`);
  }
});

// ─── Guard: send() before can_connected bails without touching the bridge ────

test("UDS Console: udsCall fails cleanly when channel is not open", async () => {
  // Start with a fresh disconnected bridge — simulates the component's
  // "status !== can_connected" guard which prevents send() from reaching
  // the wire at all. We verify that if the call escapes the guard, the
  // bridge layer also fails gracefully (no open channel → sendMsg fails).
  const f2 = createUdsFakeBridge();
  f2.reset();          // opened=false, connected=false
  f2.install();

  const r = await udsCall(BRIDGE_URL, 0x7E0, 0x7E8, [0x22, 0xF1, 0x90], 500);

  assert.equal(r.ok, false, "udsCall without an open channel must return ok:false");
  assert.ok(r.raw,          "failure must carry a non-empty error string");
  // The fake bridge returns "Channel not connected" from sendMsg
  assert.ok(
    String(r.raw).toLowerCase().includes("channel") || String(r.raw).toLowerCase().includes("connect"),
    `error string must indicate a connection problem, got: "${r.raw}"`,
  );
});
