// Pinned vectors for the seed-key algorithms promoted from
// tools/asset-sweep/src/ports.mjs into the live unlock chain
// (artifacts/srt-lab/src/lib/algos.js). Each vector table is a verbatim
// lift of the table that previously lived in `ports.mjs` next to the
// JavaScript port — moving the assertion to the live side ensures any
// future drift in algos.js trips a CI failure even if `pnpm sweep:assets`
// is never re-run.
//
// Source-of-truth for each table:
//   aisin_tcm, alpine_radio, cummins_849, dcx_ptcm, egs52,
//   mitsubishi_rar, ptim_lx — `_VECTORS` constants in
//                              `srtlab_canflash_algos.py` (Unicorn-
//                              verified against the original Chrysler
//                              J2534 DLLs).
//   bcm_fca, bcm_standard   — closed-form expression in the docstring
//                              of `srt_lab.py` (no Python `_VECTORS`
//                              table; values pinned here so any drift on
//                              either side is caught immediately).
import test from "node:test";
import assert from "node:assert/strict";
import {ALGOS} from "../lib/algos.js";

const PINNED = [
  {id: "aisin_tcm", vectors: [
    {seed: 0x00000000, key: 0xFFFE2831},
    {seed: 0x12345678, key: 0xEDCB14A9},
    {seed: 0xA1B2C3D4, key: 0x5E4CCCEF},
    {seed: 0xDEADBEEF, key: 0x2152D3BC},
    {seed: 0xFFFFFFFF, key: 0x00008C8C},
    {seed: 0x00000001, key: 0xFFFE9C88},
    {seed: 0xCAFEBABE, key: 0x35016F93},
    {seed: 0x55555555, key: 0xAAAAD2B8},
  ]},
  {id: "alpine_radio", vectors: [
    {seed: 0x00000000, key: 0x000058C2},
    {seed: 0x12345678, key: 0x27EBEA7A},
    {seed: 0xA1B2C3D4, key: 0x723FDF1E},
    {seed: 0xDEADBEEF, key: 0xF4D80A73},
    {seed: 0xFFFFFFFF, key: 0xCD56FD43},
    {seed: 0x00000001, key: 0x32A9A44D},
    {seed: 0xCAFEBABE, key: 0xA42E8B00},
    {seed: 0x55555555, key: 0x99C7D519},
  ]},
  {id: "bcm_fca", vectors: [
    {seed: 0x00000000, key: 0xACF13EE2},
    {seed: 0x12345678, key: 0xF01D1B5A},
    {seed: 0xA1B2C3D4, key: 0x2840CE06},
    {seed: 0xDEADBEEF, key: 0x4DF8FF91},
    {seed: 0xFFFFFFFF, key: 0x530F6DC1},
    {seed: 0x00000001, key: 0xACF13F2F},
    {seed: 0xCAFEBABE, key: 0x3C711B34},
    {seed: 0x55555555, key: 0x93F05DD3},
  ]},
  {id: "bcm_standard", vectors: [
    {seed: 0x00000000, key: 0x00001234},
    {seed: 0x12345678, key: 0x2A1919CC},
    {seed: 0xA1B2C3D4, key: 0x2AA22B38},
    {seed: 0xDEADBEEF, key: 0x908E2AC7},
    {seed: 0xFFFFFFFF, key: 0x00001197},
    {seed: 0x00000001, key: 0x000012D1},
    {seed: 0xCAFEBABE, key: 0x7E3898BA},
    {seed: 0x55555555, key: 0x55556755},
  ]},
  {id: "cummins_849", vectors: [
    {seed: 0x00000000, key: 0x5430F024},
    {seed: 0x12345678, key: 0x77AB5C6E},
    {seed: 0xA1B2C3D4, key: 0x4157F32B},
    {seed: 0xDEADBEEF, key: 0xB133258E},
    {seed: 0xFFFFFFFF, key: 0x3595D857},
    {seed: 0x00000001, key: 0x5430F027},
    {seed: 0xCAFEBABE, key: 0x408B0288},
    {seed: 0x55555555, key: 0x5260AB49},
  ]},
  {id: "dcx_ptcm", vectors: [
    {seed: 0x00000000, key: 0xF3DD1133},
    {seed: 0x12345678, key: 0xF8ACB05B},
    {seed: 0xA1B2C3D4, key: 0x691D0877},
    {seed: 0xDEADBEEF, key: 0xEFDC6CF6},
    {seed: 0xFFFFFFFF, key: 0x4DE4C0C6},
    {seed: 0x00000001, key: 0xB21B5FAC},
    {seed: 0xCAFEBABE, key: 0x4B92B615},
    {seed: 0x55555555, key: 0x19CE4A60},
  ]},
  {id: "egs52", vectors: [
    {seed: 0x00000000, key: 0xF5E01C59},
    {seed: 0x12345678, key: 0xB7B09E71},
    {seed: 0xA1B2C3D4, key: 0xABF0DBD5},
    {seed: 0xDEADBEEF, key: 0xED8248B2},
    {seed: 0xFFFFFFFF, key: 0xAF7A3E02},
    {seed: 0x00000001, key: 0x9B3A76B4},
    {seed: 0xCAFEBABE, key: 0x502E7367},
    {seed: 0x55555555, key: 0x3C45FAB0},
  ]},
  {id: "mitsubishi_rar", vectors: [
    {seed: 0x00000000, key: 0x00008F8E},
    {seed: 0x12345678, key: 0x2468233E},
    {seed: 0xA1B2C3D4, key: 0x436508D6},
    {seed: 0xDEADBEEF, key: 0xBD5BF24C},
    {seed: 0xFFFFFFFF, key: 0xFFFF702C},
    {seed: 0x00000001, key: 0x00008F88},
    {seed: 0xCAFEBABE, key: 0x95FDFAA2},
    {seed: 0x55555555, key: 0xAAAA25D0},
  ]},
  {id: "ptim_lx", vectors: [
    {seed: 0x00000000, key: 0x0000D785},
    {seed: 0x12345678, key: 0x12347373},
    {seed: 0xA1B2C3D4, key: 0xA1B2F675},
    {seed: 0xDEADBEEF, key: 0xDEAD3407},
    {seed: 0xFFFFFFFF, key: 0xFFFF6596},
    {seed: 0x00000001, key: 0x0000D95A},
    {seed: 0xCAFEBABE, key: 0xCAFED5B4},
    {seed: 0x55555555, key: 0x5555DF1A},
  ]},
];

const byId = new Map(ALGOS.map((a) => [a.id, a]));

for (const {id, vectors} of PINNED) {
  test(`${id} — registered in ALGOS with a fn(seedU32) entry`, () => {
    const a = byId.get(id);
    assert.ok(a, `expected ALGOS to contain id=${id}`);
    assert.equal(typeof a.fn, "function", `${id}.fn`);
  });
  test(`${id} — every pinned vector matches the live port`, () => {
    const a = byId.get(id);
    for (const v of vectors) {
      const got = a.fn(v.seed) >>> 0;
      const seedHex =
        "0x" + (v.seed >>> 0).toString(16).toUpperCase().padStart(8, "0");
      const expectedHex =
        "0x" + (v.key >>> 0).toString(16).toUpperCase().padStart(8, "0");
      const gotHex =
        "0x" + got.toString(16).toUpperCase().padStart(8, "0");
      assert.equal(got, v.key >>> 0,
        `${id}.fn(${seedHex}) — expected ${expectedHex}, got ${gotHex}`);
    }
  });
}
