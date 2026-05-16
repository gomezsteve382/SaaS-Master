/**
 * Tests for the candump parser/writer, ISO-TP reassembly over a frame
 * stream, UDS session decode, iddiff, and BCM diff → proposal extractor.
 */

import { describe, it, expect } from 'vitest';

import {
  parseCandumpLine, parseCandumpLog,
  writeCandumpLine, writeCandumpLog,
  idStats, iddiff,
  reassembleIsoTp, decodeUdsSession,
  bcmDiffToProposals, suggestIdPairs,
  COMMON_ID_PAIRS,
} from '../index.js';
import type { CandumpFrame } from '../index.js';

function frame(part: Partial<CandumpFrame> & { id: number; data?: Uint8Array | number[] }): CandumpFrame {
  const data = part.data instanceof Uint8Array ? part.data : new Uint8Array(part.data ?? []);
  return {
    ts: part.ts ?? 0, iface: part.iface ?? 'can0',
    id: part.id, ext: part.ext ?? part.id > 0x7FF,
    fd: part.fd ?? false, rtr: part.rtr ?? false,
    data, fdFlags: part.fdFlags ?? null,
  };
}

// ── 1. Parser line variants ───────────────────────────────────────────

describe('parseCandumpLine', () => {
  it('parses canonical compact form', () => {
    const f = parseCandumpLine('(1234.567890) can0 7E0#0322F19000000000')!;
    expect(f.ts).toBeCloseTo(1234.56789, 5);
    expect(f.iface).toBe('can0');
    expect(f.id).toBe(0x7E0);
    expect(f.ext).toBe(false);
    expect(f.rtr).toBe(false);
    expect(f.fd).toBe(false);
    expect(Array.from(f.data)).toEqual([0x03, 0x22, 0xF1, 0x90, 0, 0, 0, 0]);
  });

  it('parses 29-bit extended IDs', () => {
    const f = parseCandumpLine('(0.000100) vcan0 18DAF110#02 1A 90')!;
    expect(f.id).toBe(0x18DAF110);
    expect(f.ext).toBe(true);
    expect(Array.from(f.data)).toEqual([0x02, 0x1A, 0x90]);
  });

  it('parses RTR frames (no payload)', () => {
    const f = parseCandumpLine('(1.000000) can0 123#R')!;
    expect(f.rtr).toBe(true);
    expect(f.data.length).toBe(0);
  });

  it('parses RTR with explicit DLC', () => {
    const f = parseCandumpLine('(1.000000) can0 123#R8')!;
    expect(f.rtr).toBe(true);
    expect(f.rtrDlc).toBe(8);
  });

  it('round-trips RTR with explicit DLC byte-for-byte', () => {
    const line = '(1.000000) can0 123#R8';
    const f = parseCandumpLine(line)!;
    expect(writeCandumpLine(f)).toBe(line);
  });

  it('round-trips RTR without explicit DLC', () => {
    const line = '(1.000000) can0 123#R';
    const f = parseCandumpLine(line)!;
    expect(writeCandumpLine(f)).toBe(line);
  });

  it('parses CAN-FD double-hash form with flag nibble', () => {
    const f = parseCandumpLine('(1.000000) can0 7E0##1DEADBEEF')!;
    expect(f.fd).toBe(true);
    expect(f.fdFlags).toBe(0x1);
    expect(Array.from(f.data)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('parses bracketed pretty form with [DLC]', () => {
    const f = parseCandumpLine('(1.500000) can0 7E0   [8]  03 22 F1 90 00 00 00 00')!;
    expect(f.id).toBe(0x7E0);
    expect(f.data.length).toBe(8);
    expect(Array.from(f.data).slice(0, 4)).toEqual([0x03, 0x22, 0xF1, 0x90]);
  });

  it('handles microsecond timestamps without losing precision', () => {
    const f = parseCandumpLine('(1700000123.456789) can0 7E0#00')!;
    expect(f.ts).toBeCloseTo(1700000123.456789, 4);
  });

  it('skips blank and comment lines', () => {
    expect(parseCandumpLine('')).toBeNull();
    expect(parseCandumpLine('   ')).toBeNull();
    expect(parseCandumpLine('# this is a comment')).toBeNull();
  });

  it('throws on malformed payload', () => {
    expect(() => parseCandumpLine('(1.0) can0 7E0#XX')).toThrow();
  });

  it('throws on unrecognised line shape', () => {
    expect(() => parseCandumpLine('garbage line nothing valid')).toThrow();
  });

  it('records 1-based source line numbers', () => {
    const f = parseCandumpLine('(0.0) can0 100#00', 42)!;
    expect(f.line).toBe(42);
  });
});

describe('parseCandumpLog', () => {
  it('parses multi-line logs and skips blanks', () => {
    const text = [
      '# capture from a 2018 Trackhawk',
      '(0.000000) can0 7E0#0322F19000000000',
      '',
      '(0.001234) can0 7E8#1014621708334331',
      '(0.001500) can0 7E0#3000000000000000',
    ].join('\n');
    const out = parseCandumpLog(text);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe(0x7E0);
    expect(out[1].id).toBe(0x7E8);
    expect(out[2].data[0]).toBe(0x30);
  });
});

// ── 2. Writer round-trip ──────────────────────────────────────────────

describe('writeCandumpLine / writeCandumpLog', () => {
  it('round-trips the compact form byte-for-byte', () => {
    const samples = [
      '(1234.567890) can0 7E0#0322F19000000000',
      '(0.000100) vcan0 18DAF110#021A90',
      '(1.000000) can0 123#R',
      '(1.000000) can0 7E0##1DEADBEEF',
    ];
    for (const line of samples) {
      const f = parseCandumpLine(line)!;
      expect(writeCandumpLine(f)).toBe(line);
    }
  });

  it('round-trips a log file', () => {
    const text =
      '(0.000000) can0 7E0#0322F19000000000\n' +
      '(0.001234) can0 7E8#1014621708334331\n';
    const frames = parseCandumpLog(text);
    expect(writeCandumpLog(frames)).toBe(text);
  });
});

// ── 3. ID stats + iddiff ──────────────────────────────────────────────

describe('idStats', () => {
  it('computes count, first/last, mean Δt and length histogram', () => {
    const frames = [
      frame({ id: 0x100, ts: 0.0, data: [1, 2, 3] }),
      frame({ id: 0x100, ts: 1.0, data: [1, 2, 3] }),
      frame({ id: 0x100, ts: 3.0, data: [1, 2, 3, 4] }),
      frame({ id: 0x200, ts: 0.5, data: [9] }),
    ];
    const stats = idStats(frames);
    expect(stats).toHaveLength(2);
    const a = stats.find(s => s.id === 0x100)!;
    expect(a.count).toBe(3);
    expect(a.firstTs).toBe(0.0);
    expect(a.lastTs).toBe(3.0);
    expect(a.meanDt).toBeCloseTo(1.5, 5);
    expect(a.lengthHistogram[3]).toBe(2);
    expect(a.lengthHistogram[4]).toBe(1);
  });
});

describe('iddiff', () => {
  it('classifies IDs as A-only, B-only, or common', () => {
    const a = [
      frame({ id: 0x100 }), frame({ id: 0x100 }), frame({ id: 0x200 }),
    ];
    const b = [
      frame({ id: 0x200 }), frame({ id: 0x300 }),
    ];
    const r = iddiff(a, b);
    expect(r.onlyInA.map(e => e.id)).toEqual([0x100]);
    expect(r.onlyInB.map(e => e.id)).toEqual([0x300]);
    expect(r.common.map(e => e.id)).toEqual([0x200]);
    expect(r.onlyInA[0].countA).toBe(2);
    expect(r.common[0].countA).toBe(1);
    expect(r.common[0].countB).toBe(1);
  });

  it('keeps 11-bit and 29-bit IDs distinct', () => {
    const a = [frame({ id: 0x123, ext: false })];
    const b = [frame({ id: 0x123, ext: true })];
    const r = iddiff(a, b);
    expect(r.common).toHaveLength(0);
    expect(r.onlyInA).toHaveLength(1);
    expect(r.onlyInB).toHaveLength(1);
  });
});

// ── 4. ISO-TP reassembly over a frame stream ──────────────────────────

describe('reassembleIsoTp', () => {
  it('reassembles a single-frame request and response pair', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0, data: [0x02, 0x10, 0x03, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x02, 0x50, 0x03, 0, 0, 0, 0, 0] }),
    ];
    const r = reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 });
    expect(r.request).toHaveLength(1);
    expect(r.response).toHaveLength(1);
    expect(Array.from(r.request[0].payload)).toEqual([0x10, 0x03]);
    expect(Array.from(r.response[0].payload)).toEqual([0x50, 0x03]);
    expect(r.response[0].frameCount).toBe(1);
  });

  it('reassembles FF + multiple CFs and ignores FC', () => {
    // Tester reads VIN: 03 22 F1 90; ECU answers 17-byte VIN over FF + 2 CFs.
    // 0x10 0x14 = First Frame, total length 0x014 = 20 bytes (3 SID + 17 VIN payload? — 3+17=20).
    const ff  = [0x10, 0x14, 0x62, 0xF1, 0x90, 0x31, 0x43, 0x34];     // first 6 payload bytes
    const cf1 = [0x21, 0x52, 0x44, 0x4A, 0x4B, 0x39, 0x47, 0x37];     // 7 more
    const cf2 = [0x22, 0x37, 0x32, 0x35, 0x32, 0x32, 0x33, 0xCC];     // last 6 + pad
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0,    data: [0x03, 0x22, 0xF1, 0x90, 0, 0, 0, 0] }),
      frame({ id: 0x7E8, ts: 0.01, data: ff }),
      frame({ id: 0x7E0, ts: 0.02, data: [0x30, 0x00, 0x00, 0, 0, 0, 0, 0] }),  // FC continueToSend
      frame({ id: 0x7E8, ts: 0.03, data: cf1 }),
      frame({ id: 0x7E8, ts: 0.04, data: cf2 }),
    ];
    const r = reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 });
    expect(r.request).toHaveLength(1);
    expect(r.response).toHaveLength(1);
    expect(r.response[0].payload.length).toBe(20);
    expect(r.response[0].payload[0]).toBe(0x62);
    expect(r.response[0].frameCount).toBe(3);
    // Tester FC frame must NOT be counted in the request stream.
    expect(r.request[0].frameCount).toBe(1);
  });

  it('skips frames whose ID is neither tx nor rx', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x100, data: [0x01, 0x02] }),
      frame({ id: 0x7E0, data: [0x02, 0x10, 0x03, 0, 0, 0, 0, 0] }),
    ];
    const r = reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 });
    expect(r.request).toHaveLength(1);
    expect(r.response).toHaveLength(0);
  });

  it('recovers (lenient) from an out-of-order CF then resyncs', () => {
    const frames: CandumpFrame[] = [
      // Bad sequence: FF then CF with SN=2 (skipped 1).
      frame({ id: 0x7E8, data: [0x10, 0x14, 1, 2, 3, 4, 5, 6] }),
      frame({ id: 0x7E8, data: [0x22, 7, 8, 9, 10, 11, 12, 13] }),  // wrong SN
      // New valid SF after resync.
      frame({ id: 0x7E8, data: [0x03, 0x7F, 0x22, 0x33, 0, 0, 0, 0] }),
    ];
    const r = reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 });
    expect(r.response).toHaveLength(1);
    expect(Array.from(r.response[0].payload)).toEqual([0x7F, 0x22, 0x33]);
  });

  it('throws in strict mode on bad sequences', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E8, data: [0x22, 1, 2, 3, 4, 5, 6, 7] }),  // stray CF
    ];
    expect(() =>
      reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8, lenient: false }),
    ).toThrow();
  });
});

// ── 5. UDS session decoder ────────────────────────────────────────────

describe('decodeUdsSession', () => {
  it('decodes RDBI request + positive response (DID echo)', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0,    data: [0x03, 0x22, 0xF1, 0x90, 0, 0, 0, 0] }),
      // Positive 0x62 F1 90 + 17 ASCII chars 'JC4RDJDG7JC123456' over FF+CF
      frame({ id: 0x7E8, ts: 0.01, data: [0x10, 0x14, 0x62, 0xF1, 0x90, 0x4A, 0x43, 0x34] }),
      frame({ id: 0x7E8, ts: 0.02, data: [0x21, 0x52, 0x44, 0x4A, 0x44, 0x47, 0x37, 0x4A] }),
      frame({ id: 0x7E8, ts: 0.03, data: [0x22, 0x43, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36] }),
    ];
    const pairs = reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 });
    const events = decodeUdsSession(pairs);
    expect(events).toHaveLength(2);
    const req = events[0];
    expect(req.kind).toBe('request');
    if (req.kind !== 'request') throw new Error('unreachable');
    expect(req.sid).toBe(0x22);
    expect(req.did).toBe(0xF190);
    expect(req.serviceName).toBe('ReadDataByIdentifier');
    expect(req.human).toContain('VIN');

    const rsp = events[1];
    if (rsp.kind !== 'response') throw new Error('expected response');
    expect(rsp.ok).toBe(true);
    expect(rsp.did).toBe(0xF190);
    expect(rsp.decodedDid).toBe('JC4RDJDG7JC123456');
  });

  it('decodes a negative response with NRC name + description', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0,    data: [0x02, 0x27, 0x01, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x03, 0x7F, 0x27, 0x33, 0xCC, 0xCC, 0xCC, 0xCC] }),
    ];
    const events = decodeUdsSession(reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 }));
    const rsp = events[1];
    if (rsp.kind !== 'response') throw new Error('expected response');
    expect(rsp.ok).toBe(false);
    expect(rsp.nrc).toBe(0x33);
    expect(rsp.nrcName).toBe('SAD');
    expect(rsp.human).toContain('SAD');
  });

  it('decodes SecurityAccess seed exchange', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0, data: [0x02, 0x27, 0x01, 0, 0, 0, 0, 0] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x06, 0x67, 0x01, 0xDE, 0xAD, 0xBE, 0xEF, 0xCC] }),
    ];
    const events = decodeUdsSession(reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 }));
    const req = events[0];
    if (req.kind !== 'request') throw new Error('expected request');
    expect(req.sid).toBe(0x27);
    expect(req.subFunction).toBe(0x01);
    const rsp = events[1];
    if (rsp.kind !== 'response') throw new Error('expected response');
    expect(rsp.ok).toBe(true);
    expect(rsp.subFunction).toBe(0x01);
    expect(Array.from(rsp.payload)).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('decodes RoutineControl start with routine identifier', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0, data: [0x04, 0x31, 0x01, 0x03, 0x12, 0, 0, 0] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x04, 0x71, 0x01, 0x03, 0x12, 0, 0, 0] }),
    ];
    const events = decodeUdsSession(reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 }));
    const req = events[0];
    if (req.kind !== 'request') throw new Error('expected request');
    expect(req.sid).toBe(0x31);
    expect(req.subFunction).toBe(0x01);
    expect(req.routineIdentifier).toBe(0x0312);
  });

  it('decodes WDBI write request', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0, data: [0x05, 0x2E, 0xDE, 0x00, 0xAA, 0xBB, 0, 0] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x03, 0x6E, 0xDE, 0x00, 0, 0, 0, 0] }),
    ];
    const events = decodeUdsSession(reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 }));
    const req = events[0];
    if (req.kind !== 'request') throw new Error('expected request');
    expect(req.sid).toBe(0x2E);
    expect(req.did).toBe(0xDE00);
    expect(req.human).toContain('DE00');
  });

  it('decodes ECUReset sub-function', () => {
    const frames: CandumpFrame[] = [
      frame({ id: 0x7E0, ts: 0, data: [0x02, 0x11, 0x01, 0, 0, 0, 0, 0] }),
      frame({ id: 0x7E8, ts: 0.01, data: [0x02, 0x51, 0x01, 0, 0, 0, 0, 0] }),
    ];
    const events = decodeUdsSession(reassembleIsoTp(frames, { tx: 0x7E0, rx: 0x7E8 }));
    expect(events).toHaveLength(2);
    const req = events[0];
    if (req.kind !== 'request') throw new Error('expected request');
    expect(req.serviceName).toBe('ECUReset');
    expect(req.subFunction).toBe(0x01);
  });
});

// ── 6. Common pair suggestions ────────────────────────────────────────

describe('suggestIdPairs', () => {
  it('suggests 7E0/7E8 when present in the stream', () => {
    const frames = [frame({ id: 0x7E0 }), frame({ id: 0x7E8 })];
    const s = suggestIdPairs(frames);
    expect(s.some(p => p.tx === 0x7E0 && p.rx === 0x7E8)).toBe(true);
  });

  it('returns empty when no known pair appears', () => {
    const s = suggestIdPairs([frame({ id: 0x999 })]);
    expect(s).toHaveLength(0);
  });

  it('exposes the FCA BCM (714/F1A) pair in the catalog', () => {
    expect(COMMON_ID_PAIRS.some(p => p.tx === 0x714 && p.rx === 0xF1A)).toBe(true);
  });
});

// ── 7. BCM diff → proposals ───────────────────────────────────────────

describe('bcmDiffToProposals', () => {
  function captureWdbi(did: number, payload: number[]): CandumpFrame[] {
    const total = 3 + payload.length;
    if (total <= 7) {
      const data = [total, 0x2E, (did >> 8) & 0xFF, did & 0xFF, ...payload];
      while (data.length < 8) data.push(0);
      return [
        frame({ id: 0x714, ts: 0, data }),
        frame({ id: 0xF1A, ts: 0.01, data: [0x03, 0x6E, (did >> 8) & 0xFF, did & 0xFF, 0, 0, 0, 0] }),
      ];
    }
    throw new Error('test helper only handles SF-sized payloads');
  }

  it('emits a proposal row for each WDBI DID whose payload differs', () => {
    const before = decodeUdsSession(reassembleIsoTp(
      [...captureWdbi(0xDE00, [0x01]), ...captureWdbi(0xDE05, [0x10, 0x20])],
      { tx: 0x714, rx: 0xF1A },
    ));
    const after = decodeUdsSession(reassembleIsoTp(
      [...captureWdbi(0xDE00, [0x03]), ...captureWdbi(0xDE05, [0x10, 0x20])],
      { tx: 0x714, rx: 0xF1A },
    ));
    const proposals = bcmDiffToProposals(before, after);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].did).toBe(0xDE00);
    expect(Array.from(proposals[0].beforeBytes)).toEqual([0x01]);
    expect(Array.from(proposals[0].afterBytes)).toEqual([0x03]);
  });

  it('annotates single-bit toggles with BIT suffix', () => {
    const before = decodeUdsSession(reassembleIsoTp(
      captureWdbi(0xDE00, [0x00, 0x00]),
      { tx: 0x714, rx: 0xF1A },
    ));
    const after = decodeUdsSession(reassembleIsoTp(
      captureWdbi(0xDE00, [0x00, 0x04]),
      { tx: 0x714, rx: 0xF1A },
    ));
    const proposals = bcmDiffToProposals(before, after);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].suggestedFieldName).toMatch(/_BYTE_1_BIT_2$/);
    expect(proposals[0].firstDiffOffset).toBe(1);
  });

  it('returns an empty array when nothing changed', () => {
    const before = decodeUdsSession(reassembleIsoTp(captureWdbi(0xDE00, [1, 2]), { tx: 0x714, rx: 0xF1A }));
    const after = decodeUdsSession(reassembleIsoTp(captureWdbi(0xDE00, [1, 2]), { tx: 0x714, rx: 0xF1A }));
    expect(bcmDiffToProposals(before, after)).toHaveLength(0);
  });
});
