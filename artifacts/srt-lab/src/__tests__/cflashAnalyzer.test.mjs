// Pure-lib tests for the C-Flash analyzer (Task #488).
// Run: node --test artifacts/srt-lab/src/__tests__/cflashAnalyzer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCflash,
  diffBuffers,
  scanTunerSigs,
  TUNER_SIGS,
  runDiffInWorker,
  DIFF_WORKER_SOURCE,
} from "../lib/cflashAnalyzer.js";

function buildBuf(size, fill = 0x00) {
  const b = new Uint8Array(size);
  if (fill) b.fill(fill);
  return b;
}

function writeStr(buf, off, str) {
  for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
}

test("analyzeCflash on a clean 1 MB image flags no tuner sigs and no AES sbox", () => {
  const buf = buildBuf(0x100000, 0xFF);
  const r = analyzeCflash(buf);
  assert.equal(r.tunerSigs.length, 0, "clean image must have zero tuner sigs");
  assert.equal(r.aesSbox, undefined, "no AES S-box in a blank image");
  assert.equal(r.calId, null);
  assert.equal(r.buildDate, null);
  assert.equal(typeof r.bootloaderSig, "string");
});

test("analyzeCflash detects PowerPC reset preamble", () => {
  const buf = buildBuf(0x100000, 0x00);
  buf[0] = 0x00; buf[1] = 0x5A; buf[2] = 0x00; buf[3] = 0x5A;
  const r = analyzeCflash(buf);
  assert.equal(r.isPPC, true);
});

test("analyzeCflash detects AES forward S-box header", () => {
  const buf = buildBuf(0x100000, 0xAA);
  const sbox = [0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5];
  for (let i = 0; i < sbox.length; i++) buf[0x40000 + i] = sbox[i];
  const r = analyzeCflash(buf);
  assert.equal(r.aesSbox, 0x40000);
});

test("analyzeCflash recognizes GPEC2A unlock byte 0x96 at 0x2FFFC", () => {
  const buf = buildBuf(0x300000, 0xFF);
  buf[0x2FFFC] = 0x96;
  const r = analyzeCflash(buf);
  assert.equal(r.unlocked, true);
  buf[0x2FFFC] = 0xFF;
  assert.equal(analyzeCflash(buf).unlocked, false);
});

test("analyzeCflash extracts a Mopar 68-style cal ID", () => {
  const buf = buildBuf(0x100000, 0xFF);
  writeStr(buf, 0x10000, "68543210");
  const r = analyzeCflash(buf);
  assert.equal(r.calId, "68543210");
  assert.equal(r.calIdOffset, 0x10000);
});

test("analyzeCflash extracts an MM/DD/YY build date", () => {
  const buf = buildBuf(0x100000, 0xFF);
  writeStr(buf, 0x20000, "07/04/24");
  const r = analyzeCflash(buf);
  assert.deepEqual(r.buildDate, { date: "07/04/24", offset: 0x20000 });
});

test("scanTunerSigs hits each tuner brand needle", () => {
  for (const sig of TUNER_SIGS.slice(0, 4)) {
    const buf = buildBuf(0x40000, 0x00);
    for (let i = 0; i < sig.needle.length; i++) buf[0x1000 + i] = sig.needle[i];
    const hits = scanTunerSigs(buf);
    assert.ok(hits.find(h => h.label === sig.label), `expected hit for ${sig.label}`);
  }
});

test("diffBuffers identifies coalesced differing blocks", () => {
  const a = buildBuf(64, 0x00);
  const b = buildBuf(64, 0x00);
  for (let i = 10; i < 14; i++) b[i] = 0xAA;
  for (let i = 30; i < 32; i++) b[i] = 0xBB;
  const r = diffBuffers(a, b);
  assert.equal(r.totalDiffs, 6);
  assert.equal(r.firstDiff, 10);
  assert.equal(r.lastDiff, 31);
  assert.deepEqual(r.blocks, [{ start: 10, end: 14 }, { start: 30, end: 32 }]);
});

test("diffBuffers on identical buffers returns zero diffs", () => {
  const a = buildBuf(1024, 0x77);
  const b = buildBuf(1024, 0x77);
  const r = diffBuffers(a, b);
  assert.equal(r.totalDiffs, 0);
  assert.equal(r.firstDiff, -1);
  assert.equal(r.blocks.length, 0);
});

test("runDiffInWorker falls back to in-thread diff under node (no Worker)", async () => {
  const a = buildBuf(32, 0x00);
  const b = buildBuf(32, 0x00);
  b[5] = 0x01;
  const r = await runDiffInWorker(a, b);
  assert.equal(r.totalDiffs, 1);
  assert.equal(r.firstDiff, 5);
});

test("DIFF_WORKER_SOURCE is a non-empty self.onmessage handler", () => {
  assert.ok(typeof DIFF_WORKER_SOURCE === "string");
  assert.match(DIFF_WORKER_SOURCE, /self\.onmessage/);
  assert.match(DIFF_WORKER_SOURCE, /postMessage/);
});
