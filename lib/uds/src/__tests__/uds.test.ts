/**
 * @workspace/uds unit tests
 *
 * Validates:
 *   1. Frame builders produce the correct byte sequences per ISO 14229-1
 *   2. Every NRC round-trips through parse.response
 *   3. ISO-TP framing splits a 100-byte payload into FF + CFs correctly
 *   4. parse.response correctly identifies positive and negative responses
 */

import { describe, it, expect } from 'vitest';

import {
  build,
  parse,
  nrc,
  isotp,
  sessions,
  resetTypes,
  routineControlTypes,
  NRC_TABLE,
  nrcDescription,
  nrcIsPending,
  segmentPayload,
  encodeFlowControl,
  decodeFlowControl,
  frameType,
} from '../index.js';

// ── 1. Frame Builders ─────────────────────────────────────────────────

describe('build.diagnosticSessionControl', () => {
  it('encodes default session (0x10 0x01)', () => {
    const f = build.diagnosticSessionControl({ session: 'defaultSession' });
    expect(f[0]).toBe(0x10);
    expect(f[1]).toBe(0x01);
  });

  it('encodes extended session (0x10 0x03)', () => {
    const f = build.diagnosticSessionControl({ session: 'extendedDiagnosticSession' });
    expect(Array.from(f)).toEqual([0x10, 0x03]);
  });

  it('encodes programming session by number (0x10 0x02)', () => {
    const f = build.diagnosticSessionControl({ session: 0x02 });
    expect(Array.from(f)).toEqual([0x10, 0x02]);
  });
});

describe('build.ecuReset', () => {
  it('hard reset → 0x11 0x01', () => {
    expect(Array.from(build.ecuReset({ resetType: 'hardReset' }))).toEqual([0x11, 0x01]);
  });

  it('soft reset → 0x11 0x03', () => {
    expect(Array.from(build.ecuReset({ resetType: 'softReset' }))).toEqual([0x11, 0x03]);
  });
});

describe('build.testerPresent', () => {
  it('default (respond) → 0x3E 0x00', () => {
    expect(Array.from(build.testerPresent())).toEqual([0x3E, 0x00]);
  });

  it('suppress → 0x3E 0x80', () => {
    expect(Array.from(build.testerPresent({ subFunction: 0x80 }))).toEqual([0x3E, 0x80]);
  });
});

describe('build.securityAccess', () => {
  it('requestSeed level 1 → 0x27 0x01', () => {
    expect(Array.from(build.securityAccess({ subFunction: 0x01 }))).toEqual([0x27, 0x01]);
  });

  it('sendKey level 1 → 0x27 0x02 <key bytes>', () => {
    const f = build.securityAccess({ subFunction: 0x02, data: [0xDE, 0xAD, 0xBE, 0xEF] });
    expect(Array.from(f)).toEqual([0x27, 0x02, 0xDE, 0xAD, 0xBE, 0xEF]);
  });
});

describe('build.readDataByIdentifier', () => {
  it('single DID F190 (VIN) → 0x22 0xF1 0x90', () => {
    expect(Array.from(build.readDataByIdentifier({ dids: [0xF190] }))).toEqual([0x22, 0xF1, 0x90]);
  });

  it('multi-DID → 0x22 followed by DID hi/lo pairs', () => {
    const f = build.readDataByIdentifier({ dids: [0xF190, 0xF1A0] });
    expect(Array.from(f)).toEqual([0x22, 0xF1, 0x90, 0xF1, 0xA0]);
  });

  it('rejects empty DID array', () => {
    expect(() => build.readDataByIdentifier({ dids: [] })).toThrow();
  });
});

describe('build.writeDataByIdentifier', () => {
  it('builds 0x2E + DID + data', () => {
    const vin = Array.from('1C3CDFBB7FD205999', c => c.charCodeAt(0));
    const f = build.writeDataByIdentifier({ did: 0xF190, data: vin });
    expect(f[0]).toBe(0x2E);
    expect(f[1]).toBe(0xF1);
    expect(f[2]).toBe(0x90);
    expect(Array.from(f).slice(3)).toEqual(vin);
  });

  it('rejects out-of-range DID', () => {
    expect(() => build.writeDataByIdentifier({ did: 0x10000, data: [1] })).toThrow();
  });
});

describe('build.routineControl', () => {
  it('start routine 0x0202 → 0x31 0x01 0x02 0x02', () => {
    expect(Array.from(build.routineControl({ type: 'startRoutine', routineIdentifier: 0x0202 })))
      .toEqual([0x31, 0x01, 0x02, 0x02]);
  });

  it('stop routine 0x0312 → 0x31 0x02 0x03 0x12', () => {
    expect(Array.from(build.routineControl({ type: 'stopRoutine', routineIdentifier: 0x0312 })))
      .toEqual([0x31, 0x02, 0x03, 0x12]);
  });

  it('request results 0x0312 → 0x31 0x03 0x03 0x12', () => {
    expect(Array.from(build.routineControl({ type: 'requestRoutineResults', routineIdentifier: 0x0312 })))
      .toEqual([0x31, 0x03, 0x03, 0x12]);
  });
});

describe('build.clearDiagnosticInformation', () => {
  it('all DTCs → 0x14 0xFF 0xFF 0xFF', () => {
    expect(Array.from(build.clearDiagnosticInformation())).toEqual([0x14, 0xFF, 0xFF, 0xFF]);
  });

  it('custom group → 0x14 0x00 0x02 0x00', () => {
    expect(Array.from(build.clearDiagnosticInformation({ groupOfDtc: 0x0200 }))).toEqual([0x14, 0x00, 0x02, 0x00]);
  });
});

describe('build.readMemoryByAddress', () => {
  it('encodes ALFID + 4-byte address + 4-byte length', () => {
    const f = build.readMemoryByAddress({ address: 0x00000100, length: 8 });
    expect(f[0]).toBe(0x23);
    expect(f[1]).toBe(0x44); // alfid
    expect(Array.from(f.slice(2, 6))).toEqual([0x00, 0x00, 0x01, 0x00]);
    expect(Array.from(f.slice(6, 10))).toEqual([0x00, 0x00, 0x00, 0x08]);
  });
});

describe('build.writeMemoryByAddress', () => {
  it('encodes ALFID + 4-byte address + 4-byte length + data', () => {
    const data = [0xDE, 0xAD, 0xBE, 0xEF];
    const f = build.writeMemoryByAddress({ address: 0x100, data });
    expect(f[0]).toBe(0x3D);
    expect(f[1]).toBe(0x44);
    expect(Array.from(f.slice(2, 6))).toEqual([0x00, 0x00, 0x01, 0x00]);
    expect(Array.from(f.slice(6, 10))).toEqual([0x00, 0x00, 0x00, 0x04]);
    expect(Array.from(f.slice(10))).toEqual(data);
  });
});

describe('build.requestDownload', () => {
  it('builds 0x34 + dataFormat + alfid + addr + length', () => {
    const f = build.requestDownload({ address: 0x08000000, length: 0x20000 });
    expect(f[0]).toBe(0x34);
    expect(f[1]).toBe(0x00); // dataFormatIdentifier
    expect(f[2]).toBe(0x44); // alfid
  });
});

describe('build.transferData', () => {
  it('builds 0x36 + BSC + data', () => {
    const f = build.transferData({ blockSequenceCounter: 1, data: [0xAA, 0xBB] });
    expect(Array.from(f)).toEqual([0x36, 0x01, 0xAA, 0xBB]);
  });

  it('block sequence counter wraps to 0x00', () => {
    const f = build.transferData({ blockSequenceCounter: 0x100, data: [0x00] });
    expect(f[1]).toBe(0x00);
  });
});

describe('build.requestTransferExit', () => {
  it('minimal → 0x37', () => {
    expect(Array.from(build.requestTransferExit())).toEqual([0x37]);
  });
});

describe('build.communicationControl', () => {
  it('disable Rx and Tx → 0x28 0x03 0x01', () => {
    expect(Array.from(build.communicationControl({ controlType: 0x03 }))).toEqual([0x28, 0x03, 0x01]);
  });
});

describe('build.controlDtcSetting', () => {
  it('off → 0x85 0x02', () => {
    expect(Array.from(build.controlDtcSetting({ dtcSettingType: 0x02 }))).toEqual([0x85, 0x02]);
  });
});

// ── 2. NRC round-trip ─────────────────────────────────────────────────

describe('NRC round-trip through parseResponse', () => {
  it('every NRC code produces a negative response with correct code', () => {
    for (const entry of NRC_TABLE) {
      const frame = new Uint8Array([0x7F, 0x22, entry.code]);
      const result = parse.parseResponse(frame);
      expect(result.ok).toBe(false);
      expect(result.nrc).toBe(entry.code);
      expect(result.nrcName).toBe(entry.shortName);
      expect(result.nrcIsPending).toBe(entry.isPending);
    }
  });

  it('0x78 RCRRP is marked as pending', () => {
    const frame = new Uint8Array([0x7F, 0x22, 0x78]);
    const result = parse.parseResponse(frame);
    expect(result.nrcIsPending).toBe(true);
  });

  it('0x35 IK is not pending', () => {
    const frame = new Uint8Array([0x7F, 0x27, 0x35]);
    const result = parse.parseResponse(frame);
    expect(result.nrcIsPending).toBe(false);
    expect(result.nrcName).toBe('IK');
  });

  it('0x7F service is recoverable from nrcDescription', () => {
    const desc = nrcDescription(0x7F);
    expect(desc).toContain('0x7F');
    expect(desc).toContain('SNSIAS');
  });
});

// ── 3. parseResponse — positive responses ────────────────────────────

describe('parseResponse positive', () => {
  it('0x50 0x03 → ok, session extended', () => {
    const r = parse.parseResponse(new Uint8Array([0x50, 0x03]));
    expect(r.ok).toBe(true);
    expect(r.sid).toBe(0x10);
    expect(r.posRsp).toBe(0x50);
    expect(r.serviceName).toBe('DiagnosticSessionControl');
    expect(r.subFunction).toBe(0x03);
  });

  it('0x51 0x01 → ECUReset hard reset', () => {
    const r = parse.parseResponse(new Uint8Array([0x51, 0x01]));
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('ECUReset');
    expect(r.subFunction).toBe(0x01);
  });

  it('0x62 F1 90 <17 vin bytes> → RDBI positive', () => {
    const vin = Array.from('1C3CDFBB7FD205999', c => c.charCodeAt(0));
    const frame = new Uint8Array([0x62, 0xF1, 0x90, ...vin]);
    const r = parse.parseResponse(frame);
    expect(r.ok).toBe(true);
    expect(r.sid).toBe(0x22);
    expect(r.serviceName).toBe('ReadDataByIdentifier');
    // payload = everything after the PRS SID byte (RDBI has no sub-function echo)
    // = [0xF1, 0x90, ...17 VIN bytes] = 19 bytes
    expect(r.payload.length).toBe(19);
  });

  it('0x6E hi lo → WDBI positive response', () => {
    const r = parse.parseResponse(new Uint8Array([0x6E, 0xF1, 0x90]));
    expect(r.ok).toBe(true);
    expect(r.sid).toBe(0x2E);
    expect(r.serviceName).toBe('WriteDataByIdentifier');
  });

  it('0x71 0x01 0x02 0x02 → RoutineControl start response', () => {
    const r = parse.parseResponse(new Uint8Array([0x71, 0x01, 0x02, 0x02]));
    expect(r.ok).toBe(true);
    expect(r.subFunction).toBe(0x01);
  });

  it('0x59 0x02 ... → ReadDTCInformation echoes sub-function', () => {
    const r = parse.parseResponse(new Uint8Array([0x59, 0x02, 0x08, 0xC0, 0x40, 0x08]));
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('ReadDTCInformation');
    expect(r.subFunction).toBe(0x02);
    expect(r.payload.length).toBe(4);
  });

  it('0x69 0x01 ... → Authentication echoes sub-function', () => {
    const r = parse.parseResponse(new Uint8Array([0x69, 0x01, 0xAA, 0xBB]));
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('Authentication');
    expect(r.subFunction).toBe(0x01);
  });

  it('0x6C 0x01 ... → DynamicallyDefineDataIdentifier echoes sub-function', () => {
    const r = parse.parseResponse(new Uint8Array([0x6C, 0x01, 0xF3, 0x00]));
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('DynamicallyDefineDataIdentifier');
    expect(r.subFunction).toBe(0x01);
  });

  it('0xC6 0x05 ... → ResponseOnEvent echoes sub-function', () => {
    const r = parse.parseResponse(new Uint8Array([0xC6, 0x05, 0x02]));
    expect(r.ok).toBe(true);
    expect(r.serviceName).toBe('ResponseOnEvent');
    expect(r.subFunction).toBe(0x05);
  });

  it('empty frame → ok:false', () => {
    expect(parse.parseResponse(new Uint8Array(0)).ok).toBe(false);
  });
});

// ── 3a. DynamicallyDefineDataIdentifier conformance ───────────────────

describe('build.dynamicallyDefineDataIdentifier (0x2C)', () => {
  it('0x01 defineByIdentifier: includes target DDDID before source records', () => {
    const f = build.dynamicallyDefineDataIdentifier({
      subFunction: 0x01,
      dynamicallyDefinedDataIdentifier: 0xF300,
      defineByIdentifier: [{ sourceDataIdentifier: 0xF190, positionInSource: 0x00, memorySize: 0x11 }],
    });
    // Expected: 0x2C 0x01 0xF3 0x00 0xF1 0x90 0x00 0x11
    expect(Array.from(f)).toEqual([0x2C, 0x01, 0xF3, 0x00, 0xF1, 0x90, 0x00, 0x11]);
  });

  it('0x01 defineByIdentifier: throws when target DDDID is missing', () => {
    expect(() => build.dynamicallyDefineDataIdentifier({
      subFunction: 0x01,
      defineByIdentifier: [{ sourceDataIdentifier: 0xF190, positionInSource: 0, memorySize: 17 }],
    })).toThrow();
  });

  it('0x02 defineByMemoryAddress: includes target DDDID before ALFID+addr+len', () => {
    const f = build.dynamicallyDefineDataIdentifier({
      subFunction: 0x02,
      dynamicallyDefinedDataIdentifier: 0xF301,
      defineByMemoryAddress: { alfid: 0x22, address: 0x1000, length: 4 },
    });
    // Expected: 0x2C 0x02 0xF3 0x01 0x22 0x10 0x00 0x00 0x04
    expect(f[0]).toBe(0x2C);
    expect(f[1]).toBe(0x02);
    expect(f[2]).toBe(0xF3);  // target DDDID hi
    expect(f[3]).toBe(0x01);  // target DDDID lo
    expect(f[4]).toBe(0x22);  // alfid
  });

  it('0x02 defineByMemoryAddress: throws when target DDDID is missing', () => {
    expect(() => build.dynamicallyDefineDataIdentifier({
      subFunction: 0x02,
      defineByMemoryAddress: { address: 0x1000, length: 4 },
    })).toThrow();
  });

  it('0x03 clearDynamicallyDefinedDataIdentifier: specific DID → 0x2C 0x03 hi lo', () => {
    expect(Array.from(build.dynamicallyDefineDataIdentifier({
      subFunction: 0x03,
      dynamicallyDefinedDataIdentifier: 0xF300,
    }))).toEqual([0x2C, 0x03, 0xF3, 0x00]);
  });

  it('0x03 clearDynamicallyDefinedDataIdentifier: no DID → 0x2C 0x03 (clear all)', () => {
    expect(Array.from(build.dynamicallyDefineDataIdentifier({ subFunction: 0x03 })))
      .toEqual([0x2C, 0x03]);
  });
});

// ── 3b. New builders ──────────────────────────────────────────────────

describe('build.authentication', () => {
  it('deAuthenticate (0x00) → 0x29 0x00', () => {
    expect(Array.from(build.authentication({ subFunction: 0x00 }))).toEqual([0x29, 0x00]);
  });

  it('verifyCertificateUnidirectional with cert bytes', () => {
    const f = build.authentication({ subFunction: 0x01, data: [0xAA, 0xBB, 0xCC] });
    expect(Array.from(f)).toEqual([0x29, 0x01, 0xAA, 0xBB, 0xCC]);
  });
});

describe('build.readDataByPeriodicIdentifier', () => {
  it('slow rate, one PDID → 0x2A 0x01 0xF5', () => {
    expect(Array.from(build.readDataByPeriodicIdentifier({ transmissionMode: 0x01, periodicIdentifiers: [0xF5] })))
      .toEqual([0x2A, 0x01, 0xF5]);
  });

  it('fast rate, two PDIDs', () => {
    expect(Array.from(build.readDataByPeriodicIdentifier({ transmissionMode: 0x03, periodicIdentifiers: [0x01, 0x02] })))
      .toEqual([0x2A, 0x03, 0x01, 0x02]);
  });

  it('rejects empty periodicIdentifiers', () => {
    expect(() => build.readDataByPeriodicIdentifier({ transmissionMode: 0x01, periodicIdentifiers: [] })).toThrow();
  });
});

describe('build.securedDataTransmission', () => {
  it('wraps payload in 0x84 frame', () => {
    const f = build.securedDataTransmission({ securityDataRequestRecord: [0xDE, 0xAD] });
    expect(Array.from(f)).toEqual([0x84, 0xDE, 0xAD]);
  });

  it('rejects empty payload', () => {
    expect(() => build.securedDataTransmission({ securityDataRequestRecord: [] })).toThrow();
  });
});

// ── 3c. parse.response alias and safety ───────────────────────────────

describe('parse.response alias', () => {
  it('parse.response is callable and matches parse.parseResponse', () => {
    const frame = new Uint8Array([0x50, 0x03]);
    const via_alias = parse.response(frame);
    const via_named = parse.parseResponse(frame);
    expect(via_alias.ok).toBe(true);
    expect(via_alias.ok).toBe(via_named.ok);
    expect(via_alias.sid).toBe(via_named.sid);
    expect(via_alias.serviceName).toBe(via_named.serviceName);
  });
});

describe('parseResponse safety — request frames and invalid bytes rejected', () => {
  it('request frame [0x22, 0xF1, 0x90] → ok:false (not treated as positive response)', () => {
    const r = parse.parseResponse(new Uint8Array([0x22, 0xF1, 0x90]));
    expect(r.ok).toBe(false);
    expect(r.sid).toBeNull();
  });

  it('byte 0x00 → ok:false', () => {
    expect(parse.parseResponse(new Uint8Array([0x00])).ok).toBe(false);
  });

  it('byte 0x3F (below 0x50) → ok:false', () => {
    expect(parse.parseResponse(new Uint8Array([0x3F, 0x01])).ok).toBe(false);
  });

  it('byte 0x40 (below 0x50, impossible posRsp) → ok:false', () => {
    expect(parse.parseResponse(new Uint8Array([0x40])).ok).toBe(false);
  });

  it('byte 0x4F (below 0x50) → ok:false', () => {
    expect(parse.parseResponse(new Uint8Array([0x4F])).ok).toBe(false);
  });

  it('byte 0x50 (DiagnosticSessionControl posRsp) → ok:true', () => {
    const r = parse.parseResponse(new Uint8Array([0x50, 0x01]));
    expect(r.ok).toBe(true);
    expect(r.sid).toBe(0x10);
  });
});

// ── 4. ISO-TP segmentation ────────────────────────────────────────────

describe('ISO-TP segmentPayload', () => {
  it('7-byte payload → single frame', () => {
    const payload = new Uint8Array(7).fill(0xAA);
    const { frames, consecutiveCount } = segmentPayload(payload);
    expect(frames.length).toBe(1);
    expect(consecutiveCount).toBe(0);
    // First nibble = 0 (SF), second nibble = length
    expect((frames[0][0] >> 4) & 0xF).toBe(0); // SF PCI
    expect(frames[0][0] & 0x0F).toBe(7);
  });

  it('100-byte payload → 1 FF + correct number of CFs', () => {
    const payload = new Uint8Array(100).fill(0xBB);
    const { frames, consecutiveCount } = segmentPayload(payload);
    // FF carries 6 bytes, each CF carries 7 bytes.
    // Remaining after FF: 100 - 6 = 94 bytes
    // CFs needed: ceil(94 / 7) = 14
    expect(frames.length).toBe(15); // 1 FF + 14 CFs
    expect(consecutiveCount).toBe(14);
    // FF PCI: high nibble = 1, low nibble + next byte = total length 100
    expect((frames[0][0] >> 4) & 0xF).toBe(1); // FF PCI
    expect(((frames[0][0] & 0x0F) << 8) | frames[0][1]).toBe(100);
    // First CF: PCI high nibble = 2, sequence = 1
    expect((frames[1][0] >> 4) & 0xF).toBe(2); // CF PCI
    expect(frames[1][0] & 0x0F).toBe(1); // SN = 1
  });

  it('sequence numbers wrap from 0x0F to 0x00', () => {
    // 6 + 15*7 = 111 bytes to get 15 CFs → SN wraps from 0x0F to 0x00 at frame 16
    const payload = new Uint8Array(6 + 16 * 7).fill(0xCC);
    const { frames } = segmentPayload(payload);
    // Frame at index 16 (CF #16, SN should be 0)
    expect(frames[16][0] & 0x0F).toBe(0);
  });

  it('all frames are padded to 8 bytes', () => {
    const payload = new Uint8Array(3).fill(0x11);
    const { frames } = segmentPayload(payload, { padding: 0xCC });
    expect(frames[0].length).toBe(8);
    expect(frames[0][7]).toBe(0xCC);
  });

  it('throws on empty payload', () => {
    expect(() => segmentPayload(new Uint8Array(0))).toThrow();
  });

  it('throws if payload exceeds 4095 bytes', () => {
    expect(() => segmentPayload(new Uint8Array(4096))).toThrow();
  });
});

describe('encodeFlowControl / decodeFlowControl', () => {
  it('encodes ContinueToSend FC frame', () => {
    const fc = encodeFlowControl({ flowStatus: 'continueToSend', blockSize: 0, stMin: 0 });
    expect(fc[0]).toBe(0x30);
    expect(fc[1]).toBe(0x00);
    expect(fc[2]).toBe(0x00);
  });

  it('round-trips FC frame through decodeFlowControl', () => {
    const fc = encodeFlowControl({ flowStatus: 'continueToSend', blockSize: 16, stMin: 25 });
    const decoded = decodeFlowControl(fc);
    expect(decoded.ok).toBe(true);
    expect(decoded.flowStatus).toBe('continueToSend');
    expect(decoded.blockSize).toBe(16);
    expect(decoded.stMinMs).toBe(25);
  });

  it('wait FC', () => {
    const fc = encodeFlowControl({ flowStatus: 'wait', blockSize: 0, stMin: 0 });
    expect(fc[0]).toBe(0x31);
  });
});

describe('frameType detection', () => {
  it('0x0x → SF', () => { expect(frameType(0x07)).toBe('SF'); });
  it('0x1x → FF', () => { expect(frameType(0x10)).toBe('FF'); });
  it('0x2x → CF', () => { expect(frameType(0x21)).toBe('CF'); });
  it('0x3x → FC', () => { expect(frameType(0x30)).toBe('FC'); });
  it('0x4x → unknown', () => { expect(frameType(0x40)).toBe('unknown'); });
});

// ── 4b. CAN ID addressing helpers ────────────────────────────────────

describe('isotp.txCanId / rxCanId — 11-bit addressing', () => {
  it('default txCanId → 0x7E0', () => {
    expect(isotp.txCanId()).toBe(0x7E0);
  });

  it('default rxCanId → 0x7E8', () => {
    expect(isotp.rxCanId()).toBe(0x7E8);
  });

  it('ecuOffset 1 → txCanId 0x7E1, rxCanId 0x7E9', () => {
    expect(isotp.txCanId({ ecuOffset: 1 })).toBe(0x7E1);
    expect(isotp.rxCanId({ ecuOffset: 1 })).toBe(0x7E9);
  });

  it('functionalCanId 11-bit → 0x7DF', () => {
    expect(isotp.functionalCanId()).toBe(0x7DF);
  });
});

describe('isotp.txCanId / rxCanId — 29-bit addressing', () => {
  it('tester 0xF1 → ECU 0x00: txCanId → 0x18DA00F1', () => {
    expect(isotp.txCanId({ addressingMode: '29bit', sourceAddress: 0xF1, targetAddress: 0x00 }))
      .toBe(0x18DA00F1);
  });

  it('ECU 0x00 → tester 0xF1: rxCanId → 0x18DAF100', () => {
    expect(isotp.rxCanId({ addressingMode: '29bit', sourceAddress: 0xF1, targetAddress: 0x00 }))
      .toBe(0x18DAF100);
  });

  it('functionalCanId 29-bit → 0x18DB33F1', () => {
    expect(isotp.functionalCanId({ addressingMode: '29bit' })).toBe(0x18DB33F1);
  });
});

describe('isotp.wrapForCan', () => {
  it('wraps a single SF frame with 11-bit CAN ID', () => {
    const { frames } = segmentPayload([0x22, 0xF1, 0x90]);
    const canFrames = isotp.wrapForCan(frames);
    expect(canFrames.length).toBe(1);
    expect(canFrames[0].id).toBe(0x7E0);
    expect(canFrames[0].extendedId).toBe(false);
    expect(canFrames[0].data[0] & 0xF0).toBe(0x00); // SF PCI
  });

  it('wraps frames with 29-bit CAN ID and extendedId flag', () => {
    const { frames } = segmentPayload([0x22, 0xF1, 0x90]);
    const canFrames = isotp.wrapForCan(frames, {
      addressingMode: '29bit',
      sourceAddress: 0xF1,
      targetAddress: 0x00,
    });
    expect(canFrames[0].id).toBe(0x18DA00F1);
    expect(canFrames[0].extendedId).toBe(true);
  });

  it('wraps a multi-frame message with consistent CAN ID', () => {
    const { frames } = segmentPayload(new Uint8Array(100).fill(0xAA));
    const canFrames = isotp.wrapForCan(frames);
    expect(canFrames.length).toBe(15);
    for (const f of canFrames) {
      expect(f.id).toBe(0x7E0);
      expect(f.extendedId).toBe(false);
    }
  });
});

// ── 5. parse.parseRoutineControlResponse ─────────────────────────────

describe('parse.parseRoutineControlResponse', () => {
  it('decodes a positive RoutineControl response', () => {
    const r = parse.parseRoutineControlResponse(new Uint8Array([0x71, 0x01, 0x02, 0x02, 0x00]));
    expect(r.ok).toBe(true);
    expect(r.controlType).toBe(0x01);
    expect(r.routineIdentifier).toBe(0x0202);
    expect(r.statusRecord).toEqual(new Uint8Array([0x00]));
  });

  it('NRC → ok false with code', () => {
    const r = parse.parseRoutineControlResponse(new Uint8Array([0x7F, 0x31, 0x22]));
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x22);
  });
});

// ── 6. parse.parseRequestDownloadResponse ────────────────────────────

describe('parse.parseRequestDownloadResponse', () => {
  it('extracts maxBlockLength from 0x74 response', () => {
    // 0x74 LFI=0x20 (2-byte maxBlockLen) 0x04 0x00 = 1024 bytes
    const r = parse.parseRequestDownloadResponse(new Uint8Array([0x74, 0x20, 0x04, 0x00]));
    expect(r.ok).toBe(true);
    expect(r.maxBlockLength).toBe(0x0400); // 1024
  });
});
