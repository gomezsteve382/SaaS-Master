import { describe, it, expect, vi } from 'vitest';
import {
  encodeAddressAndLength,
  buildReadMemoryByAddress, parseReadMemoryResponse,
  buildWriteMemoryByAddress, parseWriteMemoryResponse,
  buildRoutineResult, parseRoutineResponse,
  buildMultiDidRead, splitMultiDidResponse, chunkDidsForRequest,
  multiDidSliceIsAmbiguous, readDidsBatched,
} from '../uds.js';

const u8 = (...b) => new Uint8Array(b);

describe('encodeAddressAndLength (ALFID encoding)', () => {
  it('default 0x44 produces 4-byte address + 4-byte length, big-endian', () => {
    const e = encodeAddressAndLength(0x12345678, 0x100, 0x44);
    expect(e.alfid).toBe(0x44);
    expect(e.addrBytes).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(e.lenBytes).toEqual([0x00, 0x00, 0x01, 0x00]);
  });
  it('honours mixed nibbles (0x22 = 2-byte addr + 2-byte size)', () => {
    const e = encodeAddressAndLength(0x0220, 0x10, 0x22);
    expect(e.addrBytes).toEqual([0x02, 0x20]);
    expect(e.lenBytes).toEqual([0x00, 0x10]);
  });
  it('rejects nibbles outside 1..4', () => {
    expect(() => encodeAddressAndLength(0, 0, 0x05)).toThrow();
    expect(() => encodeAddressAndLength(0, 0, 0x50)).toThrow();
    expect(() => encodeAddressAndLength(0, 0, 0x00)).toThrow();
  });
});

describe('ReadMemoryByAddress 0x23 / 0x63', () => {
  it('builds a request that reads the AEMT 0x100 EEPROM offset', () => {
    expect(buildReadMemoryByAddress(0x100, 0x08, 0x44))
      .toEqual([0x23, 0x44, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x08]);
  });
  it('round-trips an 8-byte read response', () => {
    const req = buildReadMemoryByAddress(0x108, 0x04, 0x44);
    expect(req[0]).toBe(0x23);
    const resp = u8(0x63, 0xDE, 0xAD, 0xBE, 0xEF);
    const r = parseReadMemoryResponse(resp);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
    expect(r.nrc).toBeNull();
  });
  it('surfaces an NRC instead of throwing', () => {
    const r = parseReadMemoryResponse(u8(0x7F, 0x23, 0x31));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x31);
    expect(r.data).toBeNull();
  });
});

describe('WriteMemoryByAddress 0x3D / 0x7D', () => {
  it('builds a write that pushes 4 bytes to 0x220', () => {
    const req = buildWriteMemoryByAddress(0x220, [0x01, 0x02, 0x03, 0x04], 0x44);
    expect(req).toEqual([0x3D, 0x44, 0x00, 0x00, 0x02, 0x20, 0x00, 0x00, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04]);
  });
  it('refuses an empty payload up front', () => {
    expect(() => buildWriteMemoryByAddress(0x220, [], 0x44)).toThrow();
  });
  it('parses a positive 0x7D response and exposes the echo', () => {
    const r = parseWriteMemoryResponse(u8(0x7D, 0x44, 0x00, 0x00, 0x02, 0x20, 0x00, 0x00, 0x00, 0x04));
    expect(r.ok).toBe(true);
    expect(r.echo).toEqual([0x44, 0x00, 0x00, 0x02, 0x20, 0x00, 0x00, 0x00, 0x04]);
  });
  it('parses a 0x7F NRC response', () => {
    const r = parseWriteMemoryResponse(u8(0x7F, 0x3D, 0x33));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x33);
  });
});

describe('RoutineControl 0x31 0x03 (Get Result)', () => {
  it('builds the request for routine 0x0312', () => {
    expect(buildRoutineResult(0x0312)).toEqual([0x31, 0x03, 0x03, 0x12]);
  });
  it('parses the 0x71 response with status record', () => {
    const r = parseRoutineResponse(u8(0x71, 0x03, 0x03, 0x12, 0x00, 0xFF, 0x42));
    expect(r.ok).toBe(true);
    expect(r.control).toBe(0x03);
    expect(r.rid).toBe(0x0312);
    expect(r.statusRecord).toEqual([0x00, 0xFF, 0x42]);
  });
  it('surfaces NRC for routine reject', () => {
    const r = parseRoutineResponse(u8(0x7F, 0x31, 0x24));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x24);
  });
});

describe('Multi-DID 0x22 batching', () => {
  it('builds a request that asks for 4 DIDs in one frame', () => {
    expect(buildMultiDidRead([0xF190, 0xF187, 0xF189, 0xF18C]))
      .toEqual([0x22, 0xF1, 0x90, 0xF1, 0x87, 0xF1, 0x89, 0xF1, 0x8C]);
  });
  it('refuses 24-bit DIDs (those need single-DID requests)', () => {
    expect(() => buildMultiDidRead([0x6E2025])).toThrow();
  });
  it('chunks a long DID list to honour conservative ISO-TP budget', () => {
    const dids = Array.from({ length: 40 }, (_, i) => 0xF000 + i);
    const chunks = chunkDidsForRequest(dids); // defaults
    // Defaults: maxRequestBytes=255 -> 127 by request, maxResponseBytes=512
    // / (2 + 32) -> 15 by response. So perChunk = 15, expecting 3 chunks.
    expect(chunks.length).toBe(Math.ceil(40 / 15));
    expect(chunks[0].length).toBe(15);
    expect(chunks[chunks.length - 1].length).toBe(40 - 15 * (chunks.length - 1));
    // Every DID is preserved, in order, exactly once.
    expect(chunks.flat()).toEqual(dids);
  });
  it('chunk size shrinks when the response budget is tight', () => {
    const dids = Array.from({ length: 20 }, (_, i) => 0xF000 + i);
    const chunks = chunkDidsForRequest(dids, { maxResponseBytes: 64, avgRespBytesPerDid: 16 });
    // 64 / (2 + 16) = 3 → 3 DIDs per chunk.
    expect(chunks[0].length).toBe(3);
  });
  it('splits a well-formed 0x62 response back into per-DID rows', () => {
    // 3 DIDs, distinct payload lengths.
    const resp = u8(
      0x62,
      0xF1, 0x90, 0x31, 0x43, 0x34, // F190 = "1C4"
      0xF1, 0x87, 0x05, 0x05,       // F187 = 05 05
      0xF1, 0x89, 0x99, 0x88, 0x77, 0x66, // F189 = 4 bytes
    );
    const r = splitMultiDidResponse(resp, [0xF190, 0xF187, 0xF189]);
    expect(r.ok).toBe(true);
    expect(r.results.map(x => x.did)).toEqual([0xF190, 0xF187, 0xF189]);
    expect(r.results[0].data).toEqual([0x31, 0x43, 0x34]);
    expect(r.results[1].data).toEqual([0x05, 0x05]);
    expect(r.results[2].data).toEqual([0x99, 0x88, 0x77, 0x66]);
  });
  it('marks unreturned DIDs as not found and preserves caller order', () => {
    // Module skipped F187 — F189 still gets parsed.
    const resp = u8(
      0x62,
      0xF1, 0x90, 0xAA, 0xBB,
      0xF1, 0x89, 0x11, 0x22, 0x33,
    );
    const r = splitMultiDidResponse(resp, [0xF190, 0xF187, 0xF189]);
    expect(r.ok).toBe(true);
    expect(r.results[0].found).toBe(true);
    expect(r.results[1].found).toBe(false);
    expect(r.results[1].data).toBeNull();
    expect(r.results[2].found).toBe(true);
    expect(r.results[2].data).toEqual([0x11, 0x22, 0x33]);
  });
  it('surfaces NRC on the multi-DID request without losing the expected list', () => {
    const r = splitMultiDidResponse(u8(0x7F, 0x22, 0x13), [0xF190, 0xF187]);
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x13);
    expect(r.results.length).toBe(2);
    expect(r.results.every(x => !x.found)).toBe(true);
  });
  it('is forward-greedy on the next-DID marker (low-level primitive contract)', () => {
    // splitMultiDidResponse on its own has no per-DID length and
    // can't tell payload bytes from DID markers — by contract it
    // scans forward, first match wins. The integration-level
    // safety net lives in readDidsBatched (next describe block),
    // which detects ambiguous slices and re-reads them via
    // single-DID 0x22 so backups never persist a misaligned cut.
    const resp = u8(
      0x62,
      0xF1, 0x90,
      0xF1, 0x87, 0xCA, 0xFE,
    );
    const r = splitMultiDidResponse(resp, [0xF190, 0xF187]);
    expect(r.ok).toBe(true);
    expect(r.results[0].found).toBe(true);
    expect(r.results[0].data).toEqual([]);
    expect(r.results[1].found).toBe(true);
    expect(r.results[1].data).toEqual([0xCA, 0xFE]);
  });
});

describe('multiDidSliceIsAmbiguous (corruption guard)', () => {
  it('flags a slice whose payload contains another requested DID marker', () => {
    expect(multiDidSliceIsAmbiguous([0x12, 0xF1, 0x87, 0xAA], [0xF190, 0xF187])).toBe(true);
  });
  it("flags a slice that contains the DID's OWN marker (splitter could have mis-cut)", () => {
    expect(multiDidSliceIsAmbiguous([0xCA, 0xFE, 0xF1, 0x87, 0x42], [0xF187])).toBe(true);
  });
  it('flags an empty slice (real critical-DID payloads are never zero-length)', () => {
    expect(multiDidSliceIsAmbiguous([], [0xF190])).toBe(true);
  });
  it('passes a clean slice that has no requested-DID marker bytes inside it', () => {
    expect(multiDidSliceIsAmbiguous([0x12, 0x34, 0x56], [0xF190, 0xF187])).toBe(false);
  });
});

describe('readDidsBatched (engine-driven)', () => {
  function makeEngine(scriptByReq){
    const calls = [];
    return {
      calls,
      uds: vi.fn(async (_tx, _rx, data) => {
        calls.push(Array.from(data));
        const key = Array.from(data).map(b => b.toString(16).padStart(2,'0')).join(' ');
        if (!(key in scriptByReq)) throw new Error('no script for: ' + key);
        return scriptByReq[key];
      }),
    };
  }

  it('collapses many DIDs into a single multi-DID round trip when they fit', async () => {
    const dids = [0xF190, 0xF187, 0xF189];
    const eng = makeEngine({
      '22 f1 90 f1 87 f1 89': { ok: true, d: u8(0x62, 0xF1, 0x90, 0x41, 0x42, 0xF1, 0x87, 0x05, 0xF1, 0x89, 0x09) },
    });
    const r = await readDidsBatched(eng.uds, 0x750, 0x758, dids);
    expect(eng.calls.length).toBe(1);
    expect(r.get(0xF190)).toEqual({ ok: true, data: [0x41, 0x42], nrc: null });
    expect(r.get(0xF187)).toEqual({ ok: true, data: [0x05], nrc: null });
    expect(r.get(0xF189)).toEqual({ ok: true, data: [0x09], nrc: null });
  });

  it('falls back to single-DID reads when the chunk gets NRC 0x13', async () => {
    // Some early BCMs reject multi-DID with "incorrect message length".
    const dids = [0xF190, 0xF187];
    const eng = makeEngine({
      '22 f1 90 f1 87':       { ok: true, d: u8(0x7F, 0x22, 0x13) },
      '22 f1 90':             { ok: true, d: u8(0x62, 0xF1, 0x90, 0x41) },
      '22 f1 87':             { ok: true, d: u8(0x62, 0xF1, 0x87, 0x05) },
    });
    const r = await readDidsBatched(eng.uds, 0x750, 0x758, dids);
    expect(eng.calls.length).toBe(3); // 1 batch + 2 fallbacks
    expect(r.get(0xF190).ok).toBe(true);
    expect(r.get(0xF187).ok).toBe(true);
  });

  it('marks individual DIDs missing-then-NRC after both batch and per-DID fail', async () => {
    const dids = [0xF190, 0xF187];
    const eng = makeEngine({
      '22 f1 90 f1 87':       { ok: true, d: u8(0x62, 0xF1, 0x90, 0x41) }, // F187 missing
      '22 f1 87':             { ok: true, d: u8(0x7F, 0x22, 0x31) },        // single-DID also rejects
    });
    const r = await readDidsBatched(eng.uds, 0x750, 0x758, dids);
    expect(eng.calls.length).toBe(2);
    expect(r.get(0xF190).ok).toBe(true);
    expect(r.get(0xF187)).toEqual({ ok: false, data: null, nrc: 0x31 });
  });

  it('CORRUPTION GUARD: re-reads single-DID when an adversarial payload contains another DID marker', async () => {
    // F190's payload happens to contain 0xF1 0x87 (the next requested
    // DID's marker) somewhere in the middle. The forward-greedy
    // splitter would mis-cut F190's slice and shove the trailing
    // bytes into F187 — silently corrupting both. readDidsBatched
    // must spot the ambiguity and re-read BOTH DIDs single-DID so
    // the persisted bytes are exactly what the module returned.
    const dids = [0xF190, 0xF187];
    // Multi-DID response intentionally crafted so a naive splitter
    // would assign F190 = [] and F187 = [0xCA, 0xFE]. The TRUE
    // intent (proven by the single-DID re-reads below) is
    // F190 = [0xF1, 0x87, 0xCA, 0xFE, 0x99] and F187 = [0x42].
    const eng = makeEngine({
      '22 f1 90 f1 87': { ok: true, d: u8(
        0x62,
        0xF1, 0x90, 0xF1, 0x87, 0xCA, 0xFE, 0x99, // F190's REAL payload contains the F1 87 byte pair
        0xF1, 0x87, 0x42,                          // F187's actual record
      ) },
      '22 f1 90': { ok: true, d: u8(0x62, 0xF1, 0x90, 0xF1, 0x87, 0xCA, 0xFE, 0x99) },
      '22 f1 87': { ok: true, d: u8(0x62, 0xF1, 0x87, 0x42) },
    });
    const r = await readDidsBatched(eng.uds, 0x750, 0x758, dids);
    // Both DIDs were re-read on their own (1 batch + 2 single-DID).
    expect(eng.calls.length).toBe(3);
    expect(r.get(0xF190)).toEqual({ ok: true, data: [0xF1, 0x87, 0xCA, 0xFE, 0x99], nrc: null });
    expect(r.get(0xF187)).toEqual({ ok: true, data: [0x42], nrc: null });
  });

  it('CORRUPTION GUARD: keeps clean slices and only re-reads ambiguous ones (partial re-read)', async () => {
    // 3-DID chunk where the splitter cleanly carves all three slices
    // and none contains marker bytes for any requested DID. Expect
    // ZERO re-reads — just the one batch call.
    const dids = [0xF190, 0xF187, 0xF189];
    const eng = makeEngine({
      '22 f1 90 f1 87 f1 89': { ok: true, d: u8(
        0x62,
        0xF1, 0x90, 0x01, 0x02,
        0xF1, 0x87, 0x03, 0x04,
        0xF1, 0x89, 0x05, 0x06,
      ) },
    });
    const r = await readDidsBatched(eng.uds, 0x750, 0x758, dids);
    expect(eng.calls.length).toBe(1);
    expect(r.get(0xF190)).toEqual({ ok: true, data: [0x01, 0x02], nrc: null });
    expect(r.get(0xF187)).toEqual({ ok: true, data: [0x03, 0x04], nrc: null });
    expect(r.get(0xF189)).toEqual({ ok: true, data: [0x05, 0x06], nrc: null });
  });
});
