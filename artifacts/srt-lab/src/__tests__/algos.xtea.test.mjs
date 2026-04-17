// Smoke tests for the SGW XTEA seed→key transform and module routing.
// Run: node --test artifacts/srt-lab/src/__tests__/algos.xtea.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  SGW_XTEA_KEY, xteaEncryptBlock, xteaDecryptBlock,
  xtea_sgw, xtea_sgw_full, unlockKey, unlockKeyBytes, unlockIdForTx, ALGOS,
} from "../lib/algos.js";
import { MODULE_TARGETS } from "../lib/jailbreakFeatures.js";

const u32 = n => n >>> 0;

test("SGW XTEA key matches the bytes lifted from CDA.swf @ 0x24664A", () => {
  assert.deepEqual(SGW_XTEA_KEY, [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]);
});

test("XTEA encipher/decipher round-trip with the SGW key", () => {
  const cases = [
    [0x00000000, 0x00000000],
    [0x12345678, 0x9ABCDEF0],
    [0xDEADBEEF, 0xCAFEBABE],
    [0xFFFFFFFF, 0xFFFFFFFF],
  ];
  for (const [v0, v1] of cases) {
    const [c0, c1] = xteaEncryptBlock(v0, v1, SGW_XTEA_KEY);
    const [p0, p1] = xteaDecryptBlock(c0, c1, SGW_XTEA_KEY);
    assert.equal(p0, u32(v0), `decipher restores v0 for ${v0.toString(16)}`);
    assert.equal(p1, u32(v1), `decipher restores v1 for ${v0.toString(16)}`);
  }
});

test("XTEA encipher matches a known-good reference implementation", () => {
  // Reference XTEA written from the spec, used purely as an oracle.
  function ref(v0, v1, k) {
    v0 >>>= 0; v1 >>>= 0; let s = 0; const d = 0x9E3779B9;
    for (let i = 0; i < 32; i++) {
      v0 = ((v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (s + k[s & 3]))) >>> 0);
      s = (s + d) >>> 0;
      v1 = ((v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (s + k[(s >>> 11) & 3]))) >>> 0);
    }
    return [v0 >>> 0, v1 >>> 0];
  }
  for (const [v0, v1] of [[0,0],[1,2],[0x12345678,0xEDCBA987],[0xDEADBEEF,~0xDEADBEEF>>>0]]) {
    assert.deepEqual(xteaEncryptBlock(v0, v1, SGW_XTEA_KEY), ref(v0, v1, SGW_XTEA_KEY));
  }
});

// Pinned vectors — these are NOT computed by calling xtea_sgw(); they are
// hard-coded constants produced once from the spec-derived reference XTEA
// (see test below) running with the SGW key. Keep these byte-for-byte in
// sync with public/srt_lab.py (algo_xtea_sgw self-test) and with the
// worked example in docs/SGW_XTEA_ALGORITHM.md. Any change here means the
// JS port, the Python port, and the doc are out of sync.
//   format: [seed, expected high-word u32, expected low-word u32]
//           (high-word u32 == xtea_sgw(seed) == 4-byte UDS 27 02 response)
const SGW_VECTORS = [
  [0x00000000, 0x9D76B2A1, 0x34A91DEE],
  [0x12345678, 0xFCB85437, 0xB3E3C96A],
  [0xA1B2C3D4, 0x3E98C5CE, 0xF921AB09],
  [0xDEADBEEF, 0x85135F8C, 0xDD4A5FF3],
  [0xFFFFFFFF, 0x8DC3151B, 0x23A6E04A],
];

test("xtea_sgw produces the pinned 4-byte UDS responses", () => {
  for (const [seed, expectedKey] of SGW_VECTORS) {
    const got = xtea_sgw(seed);
    assert.equal(
      got, expectedKey,
      `seed=0x${seed.toString(16).padStart(8,"0")}: expected key=0x${expectedKey.toString(16).padStart(8,"0")}, got 0x${got.toString(16).padStart(8,"0")}`
    );
  }
});

test("xteaEncryptBlock produces the pinned full 8-byte ciphertexts", () => {
  for (const [seed, expectedHi, expectedLo] of SGW_VECTORS) {
    const [c0, c1] = xteaEncryptBlock(seed, u32(~seed), SGW_XTEA_KEY);
    assert.equal(c0, expectedHi);
    assert.equal(c1, expectedLo);
  }
});

test("ALGOS table exposes xtea_sgw alongside the legacy entries", () => {
  const ids = ALGOS.map(a => a.id);
  assert.ok(ids.includes("xtea_sgw"), "xtea_sgw missing from ALGOS");
  assert.ok(ids.includes("cda6"));
  const sgw = ALGOS.find(a => a.id === "xtea_sgw");
  assert.equal(sgw.fn(0x12345678), xtea_sgw(0x12345678));
});

test("MODULE_TARGETS contains the SGW (XTEA) entry on 0x74F/0x76F", () => {
  const sgw = MODULE_TARGETS.find(m => m.id === "sgw-xtea");
  assert.ok(sgw, "sgw-xtea entry missing");
  assert.equal(sgw.tx, 0x74F);
  assert.equal(sgw.rx, 0x76F);
  assert.equal(sgw.unlock, "xtea_sgw");
  assert.equal(sgw.needsUnlock, true);
  assert.equal(sgw.demo, true, "SGW XTEA must stay flagged demo until verified on a real 2018+ vehicle");
});

test("unlock dispatch routes 0x74F to xtea_sgw and everything else to cda6", () => {
  assert.equal(unlockIdForTx(0x74F), "xtea_sgw");
  assert.equal(unlockIdForTx(0x750), "cda6");
  assert.equal(unlockIdForTx(0x7E0), "cda6");
  assert.equal(unlockKey("xtea_sgw", 0x12345678), xtea_sgw(0x12345678));
  assert.notEqual(unlockKey("cda6", 0x12345678), xtea_sgw(0x12345678));
});

// ─── 8-byte SGW path ──────────────────────────────────────────────────
// These tests pin the new behavior: when the SGW responds with an 8-byte
// seed, the unlock layer must encrypt the full 64-bit block (v0=high4,
// v1=low4) and return all 8 ciphertext bytes for 27 02. The 4-byte path
// must still produce the truncated XTEA high-word response so legacy
// gateways keep working.
test("unlockKeyBytes returns the 4-byte SGW response for a 4-byte seed", () => {
  for (const [seed, expectedHi] of SGW_VECTORS) {
    const sb = [(seed>>>24)&0xFF,(seed>>>16)&0xFF,(seed>>>8)&0xFF,seed&0xFF];
    const kb = unlockKeyBytes("xtea_sgw", sb);
    assert.equal(kb.length, 4);
    const got = (kb[0]<<24)|(kb[1]<<16)|(kb[2]<<8)|kb[3];
    assert.equal(u32(got), expectedHi);
  }
});

test("unlockKeyBytes returns the full 8-byte XTEA block for an 8-byte seed", () => {
  for (const [seed, expectedHi, expectedLo] of SGW_VECTORS) {
    // SGW 8-byte seed framed as seed||~seed mirrors the 4-byte invocation,
    // so the resulting 8-byte block must equal hi||lo from the pinned vectors.
    const inv = u32(~seed);
    const sb = [(seed>>>24)&0xFF,(seed>>>16)&0xFF,(seed>>>8)&0xFF,seed&0xFF,
                (inv>>>24)&0xFF,(inv>>>16)&0xFF,(inv>>>8)&0xFF,inv&0xFF];
    const kb = unlockKeyBytes("xtea_sgw", sb);
    assert.equal(kb.length, 8);
    const hi = u32((kb[0]<<24)|(kb[1]<<16)|(kb[2]<<8)|kb[3]);
    const lo = u32((kb[4]<<24)|(kb[5]<<16)|(kb[6]<<8)|kb[7]);
    assert.equal(hi, expectedHi);
    assert.equal(lo, expectedLo);
    // And it has to match xtea_sgw_full() byte-for-byte for the same inputs.
    const [c0, c1] = xtea_sgw_full(seed);
    assert.equal(hi, c0);
    assert.equal(lo, c1);
  }
});

test("unlockKeyBytes 8-byte path honours both halves of an arbitrary seed", () => {
  // When SGW chooses v1 independently (not seed-complement), the 8-byte
  // response must reflect that — i.e. we cannot collapse to the 4-byte
  // helper. Compare against the raw XTEA primitive.
  const sb = [0x12,0x34,0x56,0x78, 0x9A,0xBC,0xDE,0xF0];
  const kb = unlockKeyBytes("xtea_sgw", sb);
  const [c0, c1] = xteaEncryptBlock(0x12345678, 0x9ABCDEF0, SGW_XTEA_KEY);
  assert.deepEqual(kb, [
    (c0>>>24)&0xFF,(c0>>>16)&0xFF,(c0>>>8)&0xFF,c0&0xFF,
    (c1>>>24)&0xFF,(c1>>>16)&0xFF,(c1>>>8)&0xFF,c1&0xFF,
  ]);
});

test("unlockKeyBytes for non-SGW algorithms stays 4-byte regardless of seed length", () => {
  // CDA6 is 4-byte in / 4-byte out; even if the caller hands us 8 bytes
  // (extra bytes ignored) we must NOT widen its response.
  const sb8 = [0xA1,0xB2,0xC3,0xD4, 0xDE,0xAD,0xBE,0xEF];
  const kb = unlockKeyBytes("cda6", sb8);
  assert.equal(kb.length, 4);
  const k = unlockKey("cda6", 0xA1B2C3D4);
  assert.deepEqual(kb, [(k>>>24)&0xFF,(k>>>16)&0xFF,(k>>>8)&0xFF,k&0xFF]);
});

test("unlockKeyBytes rejects too-short or unknown inputs", () => {
  assert.equal(unlockKeyBytes("xtea_sgw", [1,2,3]), null);
  assert.equal(unlockKeyBytes("not_a_real_algo", [1,2,3,4]), null);
});
