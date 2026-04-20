// Smoke tests for bridgeEngine — verifies SGW write routing fails fast when
// the J2534 daemon is unreachable, and successfully wraps the bridge HTTP API
// into a {ok,d,raw} UDS interface when the daemon is up.
//
// Run: node --test artifacts/srt-lab/src/__tests__/bridgeEngine.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage shim so bridgeClient.js can import.
globalThis.localStorage = {
  _s: {},
  getItem(k){return this._s[k]??null;},
  setItem(k,v){this._s[k]=String(v);},
  removeItem(k){delete this._s[k];},
};

const {createBridgeEngine} = await import("../lib/bridgeEngine.js");

function mockFetch(handler){
  globalThis.fetch = async (url, init={}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/,'');
    let body=null;
    try{body=init.body?JSON.parse(init.body):null;}catch{body=null;}
    const res = await handler(path, init.method||'GET', body);
    const status = res.status||200;
    const json = res.json||{};
    return {
      ok: status>=200 && status<300,
      status,
      text: async () => JSON.stringify(json),
    };
  };
}

test("createBridgeEngine returns ok:false when /status is unreachable", async () => {
  mockFetch(async () => ({status: 500, json: {ok: false, error: "ECONNREFUSED"}}));
  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, false);
  assert.match(r.error, /not reachable/i);
});

test("createBridgeEngine opens + connects when daemon is up but idle", async () => {
  const calls = [];
  mockFetch(async (path) => {
    calls.push(path);
    if (path === '/status') return {json: {ok: true, opened: false, connected: false, vendor: 'Autel'}};
    if (path === '/open')   return {json: {ok: true, opened: true, vendor: 'Autel'}};
    if (path === '/connect')return {json: {ok: true, opened: true, connected: true}};
    return {status: 404, json: {ok: false}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, true);
  assert.ok(r.engine && typeof r.engine.uds === 'function');
  assert.equal(r.engine.isBridge, true);
  assert.deepEqual(calls, ['/status','/open','/connect']);
});

test("createBridgeEngine accepts daemon-canonical deviceOpen/channelConnected status keys", async () => {
  const calls = [];
  mockFetch(async (path) => {
    calls.push(path);
    if (path === '/status') return {json: {ok: true, deviceOpen: true, channelConnected: true, vendor: 'Autel'}};
    return {status: 404, json: {ok: false}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, true);
  // already open + connected → must NOT call /open or /connect
  assert.deepEqual(calls, ['/status']);
});

test("engine.uds sets a filter on first call, sends the request, returns response bytes", async () => {
  const calls = [];
  mockFetch(async (path, _m, body) => {
    calls.push({path, body});
    if (path === '/status') return {json: {ok: true, opened: true, connected: true, vendor: 'Autel'}};
    if (path === '/setfilter') return {json: {ok: true, filterId: 1}};
    if (path === '/sendmsg')   return {json: {ok: true}};
    if (path === '/readmsg')   return {json: {ok: true, msg: {canId: 0x758, data: '62F1903243334344'}}};
    return {status: 404, json: {ok: false}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, true);
  const u = await r.engine.uds(0x750, 0x758, [0x22, 0xF1, 0x90]);
  assert.equal(u.ok, true);
  assert.equal(u.d[0], 0x62);
  // setFilter must have used the right tx/rx
  const sf = calls.find(c => c.path === '/setfilter');
  assert.equal(sf.body.txId, 0x750);
  assert.equal(sf.body.rxId, 0x758);
  // sendMsg payload must be uppercase hex of the request bytes
  const sm = calls.find(c => c.path === '/sendmsg');
  assert.equal(sm.body.data, '22F190');
});

test("engine.uds drops messages from other CAN ids and 0x7F xx 78 keeps waiting", async () => {
  let readCount = 0;
  mockFetch(async (path) => {
    if (path === '/status') return {json: {ok: true, opened: true, connected: true}};
    if (path === '/setfilter') return {json: {ok: true, filterId: 1}};
    if (path === '/sendmsg')   return {json: {ok: true}};
    if (path === '/readmsg') {
      readCount++;
      if (readCount === 1) return {json: {ok: true, msg: {canId: 0x7E8, data: '6200'}}}; // wrong canId
      if (readCount === 2) return {json: {ok: true, msg: {canId: 0x758, data: '7F2E78'}}}; // pending
      return {json: {ok: true, msg: {canId: 0x758, data: '6EF190'}}};
    }
    return {status: 404, json: {ok: false}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  const u = await r.engine.uds(0x750, 0x758, [0x2E, 0xF1, 0x90, 0x41, 0x42], 6000);
  assert.equal(u.ok, true);
  assert.equal(u.d[0], 0x6E);
  assert.ok(readCount >= 3, 'must have skipped the pending + wrong-canId frames');
});

test("engine.uds returns ok:false on bridge sendMsg failure", async () => {
  mockFetch(async (path) => {
    if (path === '/status') return {json: {ok: true, opened: true, connected: true}};
    if (path === '/setfilter') return {json: {ok: true, filterId: 1}};
    if (path === '/sendmsg')   return {status: 500, json: {ok: false, error: 'ERR_TIMEOUT'}};
    return {json: {ok: true}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  const u = await r.engine.uds(0x750, 0x758, [0x22, 0xF1, 0x90]);
  assert.equal(u.ok, false);
  assert.match(u.raw, /sendMsg/);
});
