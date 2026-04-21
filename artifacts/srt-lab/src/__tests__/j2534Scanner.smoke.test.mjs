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

// ─── Fake bridge ───────────────────────────────────────────────────────────
// State + UDS responder. Mirrors the j2534_bridge.py JSON shapes exactly.

const FAKE_VIN = "1C4RJFBG5KC123456"; // 17-char VIN, ECM + BCM agree
const VENDOR = "Autel MaxiFlash";
const DLL_PATH = "C:\\Program Files (x86)\\Autel\\MaxiPC\\MaxiFlashJ2534.dll";

// Modules that are "alive" on the simulated bus. Keyed by tx CAN id.
// Any address NOT in this map will silently time out, just like a missing
// module on a real vehicle would.
const LIVE_MODULES = new Map([
  [0x7E0, { rx: 0x7E8, vin: FAKE_VIN, code: "ECM" }],   // ECM (GPEC)
  [0x7E1, { rx: 0x7E9, vin: FAKE_VIN, code: "TCM" }],   // TCM
  [0x750, { rx: 0x758, vin: FAKE_VIN, code: "BCM" }],   // BCM (CDA6)
  [0x740, { rx: 0x748, vin: FAKE_VIN, code: "IPC" }],   // IPC
  [0x760, { rx: 0x768, vin: FAKE_VIN, code: "ABS" }],   // ABS
  [0x75F, { rx: 0x767, vin: FAKE_VIN, code: "RFHUB" }], // RF Hub
  [0x751, { rx: 0x759, vin: FAKE_VIN, code: "HVAC" }],  // HVAC
  // BCM_ALT (0x742) intentionally responds with NRC 0x31 — a present module
  // that doesn't own a F190 DID. The scanner should still count this as
  // "found" but report no VIN.
  [0x742, { rx: 0x762, nrc: 0x31, code: "BCM_ALT" }],
]);

const EXPECTED_VIN_HITS = ["ECM", "TCM", "BCM", "IPC", "ABS", "RFHUB", "HVAC"];
const EXPECTED_TOTAL_HITS = EXPECTED_VIN_HITS.length + 1; // + BCM_ALT (NRC)

const state = {
  opened: false,
  connected: false,
  filter: null, // {tx, rx}
  rxQueue: [], // [{canId, data: hexString}]
};

function reset() {
  state.opened = false;
  state.connected = false;
  state.filter = null;
  state.rxQueue = [];
}

function bytesToHex(arr) {
  return Array.from(arr, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = [];
  const s = String(hex || "").replace(/\s+/g, "");
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

function statusJson() {
  return {
    ok: true,
    bridgeVersion: "1.0.0-fake",
    platform: "Linux",
    pythonVersion: "3.11.0",
    dllPath: DLL_PATH,
    dllLoaded: true,
    vendor: VENDOR,
    sgwCapable: true,
    deviceOpen: state.opened,
    channelConnected: state.connected,
    deviceId: state.opened ? 1 : null,
    deviceSerial: state.opened ? "FAKE-SN-0001" : null,
    channelId: state.connected ? 1 : null,
    filterCount: state.filter ? 1 : 0,
  };
}

function handleSendMsg(body) {
  if (!state.connected) return { status: 200, json: { ok: false, error: "Channel not connected" } };
  const tx = Number(body.txId ?? body.tx_id ?? 0);
  const data = hexToBytes(body.data || "");
  const target = LIVE_MODULES.get(tx);
  // Only respond if we have a flow-control filter targeting this module (the
  // scanner always sets one before sendMsg). Mirrors real ISO15765 behaviour:
  // without a filter, the cable wouldn't accept the multi-frame reply.
  if (!target) return { status: 200, json: { ok: true } }; // silence
  if (!state.filter || state.filter.tx !== tx || state.filter.rx !== target.rx) {
    return { status: 200, json: { ok: true } };
  }
  // 22 F1 90 → Read VIN by DID
  if (data.length >= 3 && data[0] === 0x22 && data[1] === 0xF1 && data[2] === 0x90) {
    if (target.nrc) {
      // Negative response: 7F 22 <nrc>
      state.rxQueue.push({
        canId: target.rx,
        data: bytesToHex([0x7F, 0x22, target.nrc]),
      });
    } else {
      // Positive: 62 F1 90 + VIN ASCII
      const vinBytes = Array.from(target.vin, (c) => c.charCodeAt(0));
      state.rxQueue.push({
        canId: target.rx,
        data: bytesToHex([0x62, 0xF1, 0x90, ...vinBytes]),
      });
    }
  }
  return { status: 200, json: { ok: true } };
}

function handleReadMsg() {
  if (!state.connected) return { status: 200, json: { ok: false, error: "Channel not connected" } };
  const m = state.rxQueue.shift();
  if (!m) return { status: 200, json: { ok: true, msg: null } };
  return { status: 200, json: { ok: true, msg: { canId: m.canId, data: m.data, rxStatus: 0, timestamp: 0 } } };
}

function installFakeFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = (init.method || "GET").toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    let res;
    if (method === "GET" && path === "/status") res = { status: 200, json: statusJson() };
    else if (method === "POST" && path === "/open") {
      state.opened = true; res = { status: 200, json: { ok: true, ...statusJson(), versions: { firmware: "V2.30 SN:FAKE", dll: "1.5", api: "04.04" } } };
    } else if (method === "POST" && path === "/connect") {
      if (!state.opened) res = { status: 200, json: { ok: false, error: "Device not open" } };
      else { state.connected = true; res = { status: 200, json: { ok: true, ...statusJson() } }; }
    } else if (method === "POST" && path === "/disconnect") {
      state.connected = false; state.filter = null; res = { status: 200, json: { ok: true, ...statusJson() } };
    } else if (method === "POST" && path === "/close") {
      state.connected = false; state.opened = false; state.filter = null;
      res = { status: 200, json: { ok: true, ...statusJson() } };
    } else if (method === "POST" && path === "/setfilter") {
      const tx = Number(body?.txId ?? 0); const rx = Number(body?.rxId ?? 0);
      state.filter = { tx, rx };
      res = { status: 200, json: { ok: true, filterId: 1, filter_id: 1 } };
    } else if (method === "POST" && path === "/sendmsg") {
      res = handleSendMsg(body || {});
    } else if (method === "POST" && path === "/readmsg") {
      res = handleReadMsg();
    } else {
      res = { status: 404, json: { ok: false, error: "not found" } };
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => JSON.stringify(res.json),
    };
  };
}

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
