// Smoke test: picking an ECU row from the AlfaOBD-derived reverse index and
// feeding its (requestId, responseId) straight into a live bridge engine
// produces the expected /setfilter call. Ties the pure picker helper to the
// existing bridgeEngine HTTP contract — the same path the UDS tab takes when
// the operator clicks a picker row.
//
// Run: node --test artifacts/srt-lab/src/__tests__/ecuPickerToBridge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  _s: {},
  getItem(k){return this._s[k]??null;},
  setItem(k,v){this._s[k]=String(v);},
  removeItem(k){delete this._s[k];},
};

const {createBridgeEngine} = await import("../lib/bridgeEngine.js");
const {ECU_PICKER_ROWS, findEcuPickerRow} = await import("../lib/ecuToCanIndex.js");

function mockFetch(handler){
  globalThis.fetch = async (url, init={}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/,'');
    let body=null;
    try{body=init.body?JSON.parse(init.body):null;}catch{body=null;}
    const res = await handler(path, init.method||'GET', body);
    const status = res.status||200;
    return {
      ok: status>=200 && status<300,
      status,
      text: async () => JSON.stringify(res.json||{}),
    };
  };
}

test("picker row → engine.uds applies the picked TX/RX as the /setfilter pair", async () => {
  const row = findEcuPickerRow("AHBM");
  assert.ok(row, "expected AHBM in the generated picker rows");
  assert.equal(row.requestId, 0x500);
  assert.equal(row.responseId, 0x508);
  assert.equal(row.source, "alfaobd-il");

  const calls = [];
  mockFetch(async (path, _m, body) => {
    calls.push({path, body});
    if (path === '/status')    return {json: {ok:true, opened:true, connected:true, vendor:'Autel'}};
    if (path === '/setfilter') return {json: {ok:true, filterId: 1}};
    if (path === '/sendmsg')   return {json: {ok:true}};
    if (path === '/readmsg')   return {json: {ok:true, msg: {canId: row.responseId, data: '62F19012345678'}}};
    return {status: 404, json: {ok:false}};
  });

  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, true);
  const resp = await r.engine.uds(row.requestId, row.responseId, [0x22, 0xF1, 0x90]);
  assert.equal(resp.ok, true);

  const setfilter = calls.find(c => c.path === '/setfilter');
  assert.ok(setfilter, "expected /setfilter call");
  assert.equal(setfilter.body.txId, 0x500);
  assert.equal(setfilter.body.rxId, 0x508);
});

test("legacy multi-bus expansion routes Radio Frequency HUB to either listed bus", async () => {
  const buses = ECU_PICKER_ROWS.filter(r =>
    r.label.startsWith("Radio Frequency HUB (legacy bus"));
  assert.equal(buses.length, 2);
  const reqs = buses.map(b => b.requestId).sort((a,b)=>a-b);
  assert.deepEqual(reqs, [0x600, 0x620]);
  assert.ok(buses.every(b => b.isLegacyMultiBus));
  assert.ok(buses.every(b => b.responseId === b.requestId + 0x8));

  // Operator picks the second bus (0x620) — engine must use it, not 0x600.
  const pick = buses.find(b => b.requestId === 0x620);
  const calls = [];
  mockFetch(async (path, _m, body) => {
    calls.push({path, body});
    if (path === '/status')    return {json: {ok:true, opened:true, connected:true}};
    if (path === '/setfilter') return {json: {ok:true, filterId: 7}};
    if (path === '/sendmsg')   return {json: {ok:true}};
    if (path === '/readmsg')   return {json: {ok:true, msg: {canId: pick.responseId, data: '50031234'}}};
    return {status: 404, json: {ok:false}};
  });
  const r = await createBridgeEngine({addLog: ()=>{}});
  assert.equal(r.ok, true);
  const resp = await r.engine.uds(pick.requestId, pick.responseId, [0x10, 0x03]);
  assert.equal(resp.ok, true);
  const setfilter = calls.find(c => c.path === '/setfilter');
  assert.equal(setfilter.body.txId, 0x620);
  assert.equal(setfilter.body.rxId, 0x628);
});
