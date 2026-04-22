// Shared fake J2534 bridge — speaks the same HTTP wire protocol as
// public/j2534_bridge.py. Used by both the node:test smoke suite
// (j2534Scanner.smoke.test.mjs) and the React UI test
// (J2534Scanner.ui.test.jsx) so a regression in one path is caught by both.

export const FAKE_VIN = "1C4RJFBG5KC123456";
export const VENDOR = "Autel MaxiFlash";
export const DLL_PATH = "C:\\Program Files (x86)\\Autel\\MaxiPC\\MaxiFlashJ2534.dll";

// Modules "alive" on the simulated bus, keyed by tx CAN id.
// Anything not in this map silently times out, like a missing module on a
// real vehicle. 0x742 is present-but-NRCs to prove negative-response handling.
export const LIVE_MODULES = new Map([
  [0x7E0, { rx: 0x7E8, vin: FAKE_VIN, code: "ECM" }],
  [0x7E1, { rx: 0x7E9, vin: FAKE_VIN, code: "TCM" }],
  [0x750, { rx: 0x758, vin: FAKE_VIN, code: "BCM" }],
  [0x740, { rx: 0x748, vin: FAKE_VIN, code: "IPC" }],
  [0x760, { rx: 0x768, vin: FAKE_VIN, code: "ABS" }],
  [0x75F, { rx: 0x767, vin: FAKE_VIN, code: "RFHUB" }],
  [0x751, { rx: 0x759, vin: FAKE_VIN, code: "HVAC" }],
  [0x742, { rx: 0x762, nrc: 0x31, code: "BCM_ALT" }],
]);

export const EXPECTED_VIN_HITS = ["ECM", "TCM", "BCM", "IPC", "ABS", "RFHUB", "HVAC"];
export const EXPECTED_TOTAL_HITS = EXPECTED_VIN_HITS.length + 1;

export function bytesToHex(arr) {
  return Array.from(arr, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}
export function hexToBytes(hex) {
  const out = [];
  const s = String(hex || "").replace(/\s+/g, "");
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

export function createFakeBridge() {
  const state = {
    opened: false,
    connected: false,
    filter: null,
    rxQueue: [],
    // Edge-case knobs — left at defaults for the original smoke flow so its
    // behaviour is unchanged. Tests covering messy real-world bus quirks flip
    // these to simulate response-pending stalls, ERR_BUFFER_EMPTY hiccups, etc.
    scripted: false,
    // bufferEmptyMode defaults to TRUE so silent addresses (no queued reply)
    // short-circuit the legacy in-test udsExchange — which treats ok:false as
    // fatal — instead of polling to deadline. That keeps the SCAN ALL sub-test
    // off the old ~16s silent-timeout floor while live modules are unaffected
    // (their reply is queued synchronously by handleSendMsg and is therefore
    // returned on the very first readMsg).
    bufferEmptyMode: true,
    emptyHiccups: 0,
  };

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
    // Scripted mode: tests pre-populated state.rxQueue and just want sendMsg
    // to succeed without any auto-generated reply on top of their script.
    if (state.scripted) return { status: 200, json: { ok: true } };
    const tx = Number(body.txId ?? body.tx_id ?? 0);
    const data = hexToBytes(body.data || "");
    const target = LIVE_MODULES.get(tx);
    if (!target) return { status: 200, json: { ok: true } };
    if (!state.filter || state.filter.tx !== tx || state.filter.rx !== target.rx) {
      return { status: 200, json: { ok: true } };
    }
    if (data.length >= 3 && data[0] === 0x22 && data[1] === 0xF1 && data[2] === 0x90) {
      if (target.nrc) {
        state.rxQueue.push({ canId: target.rx, data: bytesToHex([0x7F, 0x22, target.nrc]) });
      } else {
        const vinBytes = Array.from(target.vin, (c) => c.charCodeAt(0));
        state.rxQueue.push({ canId: target.rx, data: bytesToHex([0x62, 0xF1, 0x90, ...vinBytes]) });
      }
    }
    return { status: 200, json: { ok: true } };
  }

  function emptyReadMsgJson() {
    // Some real J2534 daemons surface "no message in buffer" as ok:false +
    // ERR_BUFFER_EMPTY rather than ok:true with msg:null. The real scanner
    // tolerates both — this knob lets us cover that branch.
    if (state.bufferEmptyMode) return { ok: false, error: "ERR_BUFFER_EMPTY" };
    return { ok: true, msg: null };
  }

  function handleReadMsg() {
    if (!state.connected) return { status: 200, json: { ok: false, error: "Channel not connected" } };
    // Forced hiccups burn down BEFORE we look at rxQueue, so a test can
    // simulate "N empty polls then the real frame arrives" deterministically
    // without relying on setTimeout scheduling.
    if (state.emptyHiccups > 0) {
      state.emptyHiccups -= 1;
      return { status: 200, json: emptyReadMsgJson() };
    }
    const m = state.rxQueue.shift();
    if (!m) return { status: 200, json: emptyReadMsgJson() };
    return { status: 200, json: { ok: true, msg: { canId: m.canId, data: m.data, rxStatus: 0, timestamp: 0 } } };
  }

  async function fakeFetch(url, init = {}) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = (init.method || "GET").toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    let res;
    if (method === "GET" && path === "/status") res = { status: 200, json: statusJson() };
    else if (method === "POST" && path === "/open") {
      state.opened = true;
      res = {
        status: 200,
        json: { ok: true, ...statusJson(), versions: { firmware: "V2.30 SN:FAKE", dll: "1.5", api: "04.04" } },
      };
    } else if (method === "POST" && path === "/connect") {
      if (!state.opened) res = { status: 200, json: { ok: false, error: "Device not open" } };
      else { state.connected = true; res = { status: 200, json: { ok: true, ...statusJson() } }; }
    } else if (method === "POST" && path === "/disconnect") {
      state.connected = false; state.filter = null;
      res = { status: 200, json: { ok: true, ...statusJson() } };
    } else if (method === "POST" && path === "/close") {
      state.connected = false; state.opened = false; state.filter = null;
      res = { status: 200, json: { ok: true, ...statusJson() } };
    } else if (method === "POST" && path === "/setfilter") {
      const tx = Number(body?.txId ?? 0);
      const rx = Number(body?.rxId ?? 0);
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
      json: async () => res.json,
    };
  }

  function reset() {
    state.opened = false;
    state.connected = false;
    state.filter = null;
    state.rxQueue = [];
    state.scripted = false;
    state.bufferEmptyMode = true;
    state.emptyHiccups = 0;
  }

  function install() {
    const prev = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    return () => { globalThis.fetch = prev; };
  }

  return { state, fakeFetch, install, reset, statusJson };
}
