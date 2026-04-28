// Vitest coverage for the C-Flash analyzer (Task #488).
import { describe, test, expect } from 'vitest';
import {
  analyzeCflash,
  diffBuffers,
  scanTunerSigs,
  TUNER_SIGS,
  runDiffInWorker,
  DIFF_WORKER_SOURCE,
} from '../lib/cflashAnalyzer.js';

function buildBuf(size, fill = 0x00) {
  const b = new Uint8Array(size);
  if (fill) b.fill(fill);
  return b;
}

function writeStr(buf, off, str) {
  for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
}

describe('analyzeCflash', () => {
  test('clean 1 MB image flags no tuner sigs and no AES sbox', () => {
    const buf = buildBuf(0x100000, 0xFF);
    const r = analyzeCflash(buf);
    expect(r.tunerSigs.length).toBe(0);
    expect(r.aesSbox).toBeUndefined();
    expect(r.calId).toBeNull();
    expect(r.buildDate).toBeNull();
    expect(typeof r.bootloaderSig).toBe('string');
  });

  test('detects PowerPC reset preamble', () => {
    const buf = buildBuf(0x100000, 0x00);
    buf[0] = 0x00; buf[1] = 0x5A; buf[2] = 0x00; buf[3] = 0x5A;
    const r = analyzeCflash(buf);
    expect(r.isPPC).toBe(true);
  });

  test('detects AES forward S-box header', () => {
    const buf = buildBuf(0x100000, 0xAA);
    const sbox = [0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5];
    for (let i = 0; i < sbox.length; i++) buf[0x40000 + i] = sbox[i];
    const r = analyzeCflash(buf);
    expect(r.aesSbox).toBe(0x40000);
  });

  test('recognizes GPEC2A unlock byte 0x96 at 0x2FFFC', () => {
    const buf = buildBuf(0x300000, 0xFF);
    buf[0x2FFFC] = 0x96;
    expect(analyzeCflash(buf).unlocked).toBe(true);
    buf[0x2FFFC] = 0xFF;
    expect(analyzeCflash(buf).unlocked).toBe(false);
  });

  test('extracts a Mopar 68-style cal ID', () => {
    const buf = buildBuf(0x100000, 0xFF);
    writeStr(buf, 0x10000, '68543210');
    const r = analyzeCflash(buf);
    expect(r.calId).toBe('68543210');
    expect(r.calIdOffset).toBe(0x10000);
  });

  test('extracts an MM/DD/YY build date', () => {
    const buf = buildBuf(0x100000, 0xFF);
    writeStr(buf, 0x20000, '07/04/24');
    const r = analyzeCflash(buf);
    expect(r.buildDate).toEqual({ date: '07/04/24', offset: 0x20000 });
  });
});

describe('scanTunerSigs', () => {
  test('hits each tuner brand needle', () => {
    for (const sig of TUNER_SIGS.slice(0, 4)) {
      const buf = buildBuf(0x40000, 0x00);
      for (let i = 0; i < sig.needle.length; i++) buf[0x1000 + i] = sig.needle[i];
      const hits = scanTunerSigs(buf);
      expect(hits.find(h => h.label === sig.label)).toBeTruthy();
    }
  });
});

describe('diffBuffers', () => {
  test('identifies coalesced differing blocks', () => {
    const a = buildBuf(64, 0x00);
    const b = buildBuf(64, 0x00);
    for (let i = 10; i < 14; i++) b[i] = 0xAA;
    for (let i = 30; i < 32; i++) b[i] = 0xBB;
    const r = diffBuffers(a, b);
    expect(r.totalDiffs).toBe(6);
    expect(r.firstDiff).toBe(10);
    expect(r.lastDiff).toBe(31);
    expect(r.blocks).toEqual([{ start: 10, end: 14 }, { start: 30, end: 32 }]);
  });

  test('on identical buffers returns zero diffs', () => {
    const a = buildBuf(1024, 0x77);
    const b = buildBuf(1024, 0x77);
    const r = diffBuffers(a, b);
    expect(r.totalDiffs).toBe(0);
    expect(r.firstDiff).toBe(-1);
    expect(r.blocks.length).toBe(0);
  });
});

describe('worker plumbing', () => {
  test('runDiffInWorker falls back to in-thread diff under node (no Worker)', async () => {
    const a = buildBuf(32, 0x00);
    const b = buildBuf(32, 0x00);
    b[5] = 0x01;
    const r = await runDiffInWorker(a, b);
    expect(r.totalDiffs).toBe(1);
    expect(r.firstDiff).toBe(5);
  });

  test('DIFF_WORKER_SOURCE is a non-empty self.onmessage handler', () => {
    expect(typeof DIFF_WORKER_SOURCE).toBe('string');
    expect(DIFF_WORKER_SOURCE).toMatch(/self\.onmessage/);
    expect(DIFF_WORKER_SOURCE).toMatch(/postMessage/);
  });
});
