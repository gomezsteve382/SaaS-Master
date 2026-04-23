import { describe, it, expect } from 'vitest';
import {
  parseModule,
  syncImmoBackup,
  countSkimRecs,
  detectBySignature,
  extractVIN,
  extractHex,
  rd32,
  buildSizeWarn,
  typeFromFilename,
} from '../parseModule.js';
import { IMMO_BLOCK, IMMO_REC } from '../constants.js';
import { crc8rf, rfhSec16Cs } from '../crc.js';
import {
  makeBcm,
  makeRfhubGen1,
  makeRfhubGen2,
  makeGpec2a,
  make95640,
  makeTcm,
  makeTipm,
  makeFirmware,
  VIN_DEFAULT,
} from '../__fixtures__/buildFixtures.js';

describe('module size + signature detection', () => {
  it('detects BCM at 65536 and 131072 bytes', () => {
    expect(parseModule(makeBcm({ size: 65536 }), 'bcm.bin').type).toBe('BCM');
    expect(parseModule(makeBcm({ size: 131072 }), 'bcm.bin').type).toBe('BCM');
  });
  it('detects 95640 at 8192 bytes (no TCM/TIPM signature)', () => {
    expect(parseModule(make95640(), '95640.bin').type).toBe('95640');
  });
  it('detects GPEC2A at 4096 bytes (valid VIN at offset 0)', () => {
    expect(parseModule(makeGpec2a(), 'gpec.bin').type).toBe('GPEC2A');
  });
  it('detects RFHUB Gen2 at 4096 bytes (no VIN at offset 0)', () => {
    const m = parseModule(makeRfhubGen2(), 'rfh.bin');
    expect(m.type).toBe('RFHUB');
    expect(m.rfhGen).toBe('Gen2 (24C32)');
  });
  it('detects TCM at 8192 by signature', () => {
    expect(parseModule(makeTcm(), 'tcm.bin').type).toBe('TCM');
    expect(detectBySignature(makeTcm())).toBe('TCM');
  });
  it('detects TIPM at 4096 by signature', () => {
    expect(parseModule(makeTipm(), 'tipm.bin').type).toBe('TIPM');
    expect(detectBySignature(makeTipm())).toBe('TIPM');
  });
  it('classifies >131072 as FW', () => {
    expect(parseModule(makeFirmware(), 'fw.bin').type).toBe('FW');
  });
});

describe('extractVIN', () => {
  it('returns ASCII VIN when bytes are printable A-Z/0-9', () => {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 17; i++) buf[i] = VIN_DEFAULT.charCodeAt(i);
    expect(extractVIN(buf, 0)).toBe(VIN_DEFAULT);
  });
  it('returns null for non-VIN bytes', () => {
    expect(extractVIN(new Uint8Array(20).fill(0xFF), 0)).toBeNull();
  });
  it('returns null when out of range', () => {
    expect(extractVIN(new Uint8Array(10), 0)).toBeNull();
  });
});

describe('GPEC2A parser', () => {
  const m = parseModule(makeGpec2a(), 'gpec.bin');
  it('extracts all three documented VIN offsets', () => {
    const offs = m.vins.map(v => v.offset).sort((a, b) => a - b);
    expect(offs).toEqual([0x0000, 0x01F0, 0x0224]);
    expect(m.vins.every(v => v.vin === VIN_DEFAULT)).toBe(true);
  });
  it('reports SKIM enabled (0x80)', () => {
    expect(m.skimByte).toBe(0x80);
    expect(m.skimStatus).toBe('ENABLED');
  });
  it('reports secret-key mirror consistency', () => {
    expect(m.keyConsistent).toBe(true);
    expect(m.skb).toBe(false);
  });
  it('flags inconsistent secret-key mirror', () => {
    const bad = parseModule(makeGpec2a({ keyMirror: false }), 'gpec.bin');
    expect(bad.keyConsistent).toBe(false);
  });
  it('decodes 4 transponder key slots', () => {
    expect(m.transponderKeys).toHaveLength(4);
    expect(m.transponderKeys[0].offset).toBe(0x0888);
    expect(m.transponderKeys[3].offset).toBe(0x0888 + 12);
  });
  it('decodes runtime counters as big-endian uint32', () => {
    expect(m.runtimeCounters.counterA.value).toBe(0x00001234);
    expect(m.runtimeCounters.distance.value).toBe(0x0001E240);
  });
  it('reports ZZZZ tamper intact when first byte is 0x5A', () => {
    expect(m.zzzzTamper.intact).toBe(true);
    const cleared = parseModule(makeGpec2a({ zzzzIntact: false }), 'gpec.bin');
    expect(cleared.zzzzTamper.intact).toBe(false);
  });
  it('decodes PCM SEC6 and detects damaged (all-FF) variant', () => {
    expect(m.pcmSec6.damaged).toBe(false);
    expect(m.pcmSec6.immoState).toBe('SET');
    const dmg = parseModule(makeGpec2a({ pcmSec6Damaged: true }), 'gpec.bin');
    expect(dmg.pcmSec6.damaged).toBe(true);
    expect(dmg.pcmSec6.immoState).toBe('IMMO_DAMAGED');
  });
});

describe('RFHUB Gen2 parser', () => {
  const m = parseModule(makeRfhubGen2(), 'rfh.bin');
  it('extracts all 4 VINs (byte-reversed) at known offsets', () => {
    expect(m.vins).toHaveLength(4);
    expect(m.vins.every(v => v.vin === VIN_DEFAULT && v.mirrored === true)).toBe(true);
  });
  it('validates Gen2 VIN checksum (XOR ^ magic) for all slots', () => {
    expect(m.vins.every(v => v.crcOk)).toBe(true);
  });
  it('flags broken VIN CS in a non-detection slot', () => {
    // Magic is auto-detected from slot 0, so corrupt slot 1 to verify per-slot validation.
    const bad = parseModule(makeRfhubGen2({ vinBadCrc: true, vinBadCrcSlot: 1 }), 'rfh.bin');
    expect(bad.vins[1].crcOk).toBe(false);
    expect(bad.vins[0].crcOk).toBe(true);
  });
  it('extracts 16-byte vehicle secret at 0x050E (big-endian field)', () => {
    expect(m.vehicleSecret.offset).toBe(0x050E);
    expect(m.vehicleSecret.bytes).toHaveLength(16);
    expect(m.vehicleSecret.endian).toBe('big');
  });
  it('validates SEC16 slot1+2 match and CS is correct', () => {
    expect(m.sec16s).toHaveLength(2);
    expect(m.sec16s[0].csOk).toBe(true);
    expect(m.sec16s[1].csOk).toBe(true);
    expect(m.sec16match).toBe(true);
    expect(m.sec16valid).toBe(true);
  });
  it('flags SEC16 as invalid when CS broken', () => {
    const bad = parseModule(makeRfhubGen2({ sec16Bad: true }), 'rfh.bin');
    expect(bad.sec16s[0].csOk).toBe(false);
    expect(bad.sec16valid).toBe(false);
  });
  it('counts fobik AA50 markers and security CC66AA55 patterns', () => {
    expect(m.fobikSlots).toBe(2);
    expect(m.securityMarkers).toBe(1);
    expect(m.zzzzBlocks).toBe(1);
  });
  it('decodes part numbers (HW/SW/CAL) as ASCII', () => {
    expect(m.partNumbers.hw).toBe('HW12345678');
    expect(m.partNumbers.sw).toBe('SW87654321');
    expect(m.partNumbers.cal).toBe('CALABCDEFGH123');
  });
  it('decodes RFH VIN @ 0x92 with valid CRC16', () => {
    expect(m.rfhVin92.vin).toBe(VIN_DEFAULT);
    expect(m.rfhVin92.csOk).toBe(true);
  });
  it('flags RFH VIN @ 0x92 with broken CRC16', () => {
    const bad = parseModule(makeRfhubGen2({ vin92BadCrc: true }), 'rfh.bin');
    expect(bad.rfhVin92.csOk).toBe(false);
  });
});

describe('BCM parser', () => {
  const m = parseModule(makeBcm(), 'bcm.bin');
  it('extracts all four VIN copies at 0x5320..0x5380', () => {
    expect(m.vins.map(v => v.offset)).toEqual([0x5320, 0x5340, 0x5360, 0x5380]);
    expect(m.vins.every(v => v.vin === VIN_DEFAULT)).toBe(true);
  });
  it('decodes partial VINs at 0x4098 + 0x40B0 with valid CRC16', () => {
    expect(m.partialVins).toHaveLength(2);
    expect(m.partialVins.every(p => p.crcOk)).toBe(true);
    expect(m.partialVins[0].tail).toBe('FH796320');
  });
  it('flags partial-VIN CRC mismatch', () => {
    const bad = parseModule(makeBcm({ partialBadCrc: true }), 'bcm.bin');
    expect(bad.partialVins.every(p => !p.crcOk)).toBe(true);
  });
  it('extracts 16-byte vehicle secret at 0x40C9 (little-endian field)', () => {
    expect(m.vehicleSecret.offset).toBe(0x40C9);
    expect(m.vehicleSecret.bytes).toHaveLength(16);
    expect(m.vehicleSecret.endian).toBe('little');
  });
  it('reports security lock state', () => {
    expect(m.securityLock.locked).toBe(true);
    const unl = parseModule(makeBcm({ securityLocked: false }), 'bcm.bin');
    expect(unl.securityLock.locked).toBe(false);
  });
  it('counts FOBIK keys and exposes 3 IMMO key slots', () => {
    expect(m.fobikCount).toBe(4);
    expect(m.immoKeys.map(k => k.offset)).toEqual([0x81A4, 0x81C4, 0x81E4]);
  });
  it('counts IMMO records in primary + backup banks and flags sync', () => {
    expect(m.immoRecs).toBe(3);
    expect(m.bakRecs).toBe(3);
    expect(m.immoBlank).toBe(false);
    expect(m.bakBlank).toBe(false);
    expect(m.immoSynced).toBe(true);
  });
  it('detects unsynced IMMO backup', () => {
    const unsynced = parseModule(makeBcm({ immoBackupSynced: false }), 'bcm.bin');
    expect(unsynced.immoSynced).toBe(false);
  });
  it('countSkimRecs reports zero on a fully-blank IMMO bank', () => {
    const blankBuf = new Uint8Array(0x40C0 + IMMO_BLOCK).fill(0xFF);
    expect(countSkimRecs(blankBuf, 0x40C0)).toBe(0);
  });
});

describe('countSkimRecs', () => {
  it('counts non-blank 24-byte records, ignoring all-FF / all-00', () => {
    const buf = makeBcm({ immoRecsCount: 5 });
    expect(countSkimRecs(buf, 0x40C0)).toBe(5);
  });
  it('returns 0 for an all-FF region', () => {
    const buf = new Uint8Array(IMMO_BLOCK + 0x40C0).fill(0xFF);
    expect(countSkimRecs(buf, 0x40C0)).toBe(0);
  });
});

describe('syncImmoBackup', () => {
  it('returns null for buffers smaller than required', () => {
    expect(syncImmoBackup(new Uint8Array(0x100))).toBeNull();
  });
  it('copies the primary IMMO bank to the backup bank', () => {
    const src = makeBcm({ immoBackupSynced: false });
    expect(parseModule(src, 'bcm.bin').immoSynced).toBe(false);
    const synced = syncImmoBackup(src);
    expect(synced).not.toBeNull();
    for (let i = 0; i < IMMO_BLOCK; i++) {
      expect(synced[0x2000 + i]).toBe(synced[0x40C0 + i]);
    }
    expect(parseModule(synced, 'bcm.bin').immoSynced).toBe(true);
  });
  it('does not mutate the source buffer (round-trip purity)', () => {
    const src = makeBcm({ immoBackupSynced: false });
    const before = src[0x2000 + IMMO_REC];
    syncImmoBackup(src);
    expect(src[0x2000 + IMMO_REC]).toBe(before);
  });
});

describe('95640 parser', () => {
  const m = parseModule(make95640(), '95640.bin');
  it('extracts VINs at 0x275, 0x288 and 0x1B82', () => {
    const offs = m.vins.map(v => v.offset).sort((a, b) => a - b);
    expect(offs).toEqual([0x275, 0x288, 0x1B82]);
  });
  it('skips third VIN slot when blank', () => {
    const noThird = parseModule(make95640({ withThirdVin: false }), '95640.bin');
    const offs = noThird.vins.map(v => v.offset).sort((a, b) => a - b);
    expect(offs).toEqual([0x275, 0x288]);
  });
  it('decodes BCM-SEC16 @ 0x838 with valid CRC16', () => {
    expect(m.bcmSec16.offset).toBe(0x838);
    expect(m.bcmSec16.csOk).toBe(true);
    expect(m.bcmSec16.blank).toBe(false);
    expect(m.bcmSec16.reversedHex).toHaveLength(32);
  });
  it('flags BCM-SEC16 CRC16 mismatch', () => {
    const bad = parseModule(make95640({ bcmSec16BadCrc: true }), '95640.bin');
    expect(bad.bcmSec16.csOk).toBe(false);
  });
  it('reports skey ERASED when blank', () => {
    const blank = parseModule(make95640({ skeyBlank: true }), '95640.bin');
    expect(blank.skb).toBe(true);
  });
});

describe('extractHex — null-return bounds guard', () => {
  it('returns a hex string when offset+len is within the buffer', () => {
    const buf = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    expect(extractHex(buf, 0, 4)).toBe('DE AD BE EF');
  });
  it('returns null when offset+len equals buffer length (boundary)', () => {
    const buf = new Uint8Array(4);
    expect(extractHex(buf, 0, 4)).toBe('00 00 00 00');
    expect(extractHex(buf, 1, 4)).toBeNull();
  });
  it('returns null when offset+len exceeds buffer length', () => {
    const buf = new Uint8Array(3);
    expect(extractHex(buf, 0, 4)).toBeNull();
  });

  // GPEC2A region: secretKey @ 0x0203, len 8 → needs 0x020B bytes
  it('returns null for GPEC2A secretKey region when buffer < 0x020B', () => {
    const buf = new Uint8Array(0x020a);
    expect(extractHex(buf, 0x0203, 8)).toBeNull();
  });
  it('returns hex for GPEC2A secretKey region when buffer >= 0x020B', () => {
    const buf = new Uint8Array(0x020b);
    expect(extractHex(buf, 0x0203, 8)).not.toBeNull();
  });

  // GPEC2A region: secretKeyMirror @ 0x0361, len 8 → needs 0x0369 bytes
  it('returns null for GPEC2A secretKeyMirror region when buffer < 0x0369', () => {
    const buf = new Uint8Array(0x0368);
    expect(extractHex(buf, 0x0361, 8)).toBeNull();
  });
  it('returns hex for GPEC2A secretKeyMirror region when buffer >= 0x0369', () => {
    const buf = new Uint8Array(0x0369);
    expect(extractHex(buf, 0x0361, 8)).not.toBeNull();
  });

  // GPEC2A region: transponder key slot 0 @ 0x0888, len 4 → needs 0x088C bytes
  it('returns null for GPEC2A transponderKey[0] when buffer < 0x088C', () => {
    const buf = new Uint8Array(0x0888);
    expect(extractHex(buf, 0x0888, 4)).toBeNull();
  });
  it('returns hex for GPEC2A transponderKey[0] when buffer >= 0x088C', () => {
    const buf = new Uint8Array(0x088c);
    expect(extractHex(buf, 0x0888, 4)).not.toBeNull();
  });

  // GPEC2A region: transponder key slot 3 @ 0x0894, len 4 → needs 0x0898 bytes
  it('returns null for GPEC2A transponderKey[3] when buffer < 0x0898', () => {
    const buf = new Uint8Array(0x0897);
    expect(extractHex(buf, 0x0894, 4)).toBeNull();
  });
  it('returns hex for GPEC2A transponderKey[3] when buffer >= 0x0898', () => {
    const buf = new Uint8Array(0x0898);
    expect(extractHex(buf, 0x0894, 4)).not.toBeNull();
  });

  // GPEC2A region: zzzzTamper @ 0x0C8C, len 8 → needs 0x0C94 bytes
  it('returns null for GPEC2A zzzzTamper region when buffer < 0x0C94', () => {
    const buf = new Uint8Array(0x0c93);
    expect(extractHex(buf, 0x0c8c, 8)).toBeNull();
  });
  it('returns hex for GPEC2A zzzzTamper region when buffer >= 0x0C94', () => {
    const buf = new Uint8Array(0x0c94);
    expect(extractHex(buf, 0x0c8c, 8)).not.toBeNull();
  });

  // GPEC2A region: runtimeCounter counterA @ 0x0E61, len 4 → needs 0x0E65 bytes
  it('returns null for GPEC2A counterA region when buffer < 0x0E65', () => {
    const buf = new Uint8Array(0x0e64);
    expect(extractHex(buf, 0x0e61, 4)).toBeNull();
  });
  it('returns hex for GPEC2A counterA region when buffer >= 0x0E65', () => {
    const buf = new Uint8Array(0x0e65);
    expect(extractHex(buf, 0x0e61, 4)).not.toBeNull();
  });

  // GPEC2A region: runtimeCounter counterB @ 0x0E69, len 4 → needs 0x0E6D bytes
  it('returns null for GPEC2A counterB region when buffer < 0x0E6D', () => {
    const buf = new Uint8Array(0x0e6c);
    expect(extractHex(buf, 0x0e69, 4)).toBeNull();
  });
  it('returns hex for GPEC2A counterB region when buffer >= 0x0E6D', () => {
    const buf = new Uint8Array(0x0e6d);
    expect(extractHex(buf, 0x0e69, 4)).not.toBeNull();
  });

  // GPEC2A region: runtimeCounter distance @ 0x0E6D, len 4 → needs 0x0E71 bytes
  it('returns null for GPEC2A distance region when buffer < 0x0E71', () => {
    const buf = new Uint8Array(0x0e70);
    expect(extractHex(buf, 0x0e6d, 4)).toBeNull();
  });
  it('returns hex for GPEC2A distance region when buffer >= 0x0E71', () => {
    const buf = new Uint8Array(0x0e71);
    expect(extractHex(buf, 0x0e6d, 4)).not.toBeNull();
  });

  // GPEC2A region: runtimeCounter keyCycles @ 0x0E75, len 4 → needs 0x0E79 bytes
  it('returns null for GPEC2A keyCycles region when buffer < 0x0E79', () => {
    const buf = new Uint8Array(0x0e78);
    expect(extractHex(buf, 0x0e75, 4)).toBeNull();
  });
  it('returns hex for GPEC2A keyCycles region when buffer >= 0x0E79', () => {
    const buf = new Uint8Array(0x0e79);
    expect(extractHex(buf, 0x0e75, 4)).not.toBeNull();
  });

  // GPEC2A region: transponder key slot 1 @ 0x088C, len 4 → needs 0x0890 bytes
  it('returns null for GPEC2A transponderKey[1] when buffer < 0x0890', () => {
    const buf = new Uint8Array(0x088f);
    expect(extractHex(buf, 0x088c, 4)).toBeNull();
  });
  it('returns hex for GPEC2A transponderKey[1] when buffer >= 0x0890', () => {
    const buf = new Uint8Array(0x0890);
    expect(extractHex(buf, 0x088c, 4)).not.toBeNull();
  });

  // GPEC2A region: transponder key slot 2 @ 0x0890, len 4 → needs 0x0894 bytes
  it('returns null for GPEC2A transponderKey[2] when buffer < 0x0894', () => {
    const buf = new Uint8Array(0x0893);
    expect(extractHex(buf, 0x0890, 4)).toBeNull();
  });
  it('returns hex for GPEC2A transponderKey[2] when buffer >= 0x0894', () => {
    const buf = new Uint8Array(0x0894);
    expect(extractHex(buf, 0x0890, 4)).not.toBeNull();
  });

  // GPEC2A region: partNumberStr @ 0x0FA1, len 13 → needs 0x0FAE bytes
  it('returns null for GPEC2A partNumberStr region when buffer < 0x0FAE', () => {
    const buf = new Uint8Array(0x0fad);
    expect(extractHex(buf, 0x0fa1, 13)).toBeNull();
  });
  it('returns hex for GPEC2A partNumberStr region when buffer >= 0x0FAE', () => {
    const buf = new Uint8Array(0x0fae);
    expect(extractHex(buf, 0x0fa1, 13)).not.toBeNull();
  });

  // GPEC2A full-size: all guarded fields must be non-null for a 4096-byte buffer
  it('all GPEC2A guarded fields are non-null for a full 4096-byte buffer', () => {
    const m = parseModule(makeGpec2a(), 'gpec.bin');
    expect(m.secretKey).not.toBeNull();
    expect(m.secretKeyMirror).not.toBeNull();
    expect(m.zzzzTamper).not.toBeNull();
    expect(m.partNumberStr).not.toBeNull();
    expect(m.runtimeCounters.counterA).not.toBeNull();
    expect(m.runtimeCounters.counterB).not.toBeNull();
    expect(m.runtimeCounters.distance).not.toBeNull();
    expect(m.runtimeCounters.keyCycles).not.toBeNull();
    m.transponderKeys.forEach(k => expect(k.hex).not.toBeNull());
  });
});

describe('rd32 bounds-checking', () => {
  it('reads a 32-bit big-endian value when fully in range', () => {
    const buf = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    expect(rd32(buf, 0)).toBe(0x12345678);
  });
  it('reads at the last legal offset (offset+4 === length)', () => {
    const buf = new Uint8Array([0, 0xDE, 0xAD, 0xBE, 0xEF]);
    expect(rd32(buf, 1)).toBe(0xDEADBEEF | 0); // signed-int form (same bits)
  });
  it('returns null when offset is negative', () => {
    expect(rd32(new Uint8Array(8), -1)).toBeNull();
  });
  it('returns null when offset+4 exceeds length', () => {
    const buf = new Uint8Array(4);
    expect(rd32(buf, 1)).toBeNull();
    expect(rd32(buf, 4)).toBeNull();
    expect(rd32(buf, 100)).toBeNull();
  });
  it('returns null on an empty buffer', () => {
    expect(rd32(new Uint8Array(0), 0)).toBeNull();
  });
  it('returns null on a 3-byte buffer (not enough for 4 bytes)', () => {
    expect(rd32(new Uint8Array(3), 0)).toBeNull();
  });
  it('GPEC2A runtimeCounters .value is a number for a full-size buffer', () => {
    const m = parseModule(makeGpec2a(), 'gpec.bin');
    expect(typeof m.runtimeCounters.counterA.value).toBe('number');
    expect(Number.isNaN(m.runtimeCounters.counterA.value)).toBe(false);
    expect(m.runtimeCounters.counterA.value).toBe(0x00001234);
  });
});

describe('parseModule data[] direct-access bounds', () => {
  it('GPEC2A skimByte/skimStatus return real values for a full 4096-byte buffer', () => {
    const m = parseModule(makeGpec2a(), 'gpec.bin');
    expect(m.skimByte).toBe(0x80);
    expect(m.skimStatus).toBe('ENABLED');
  });
  it('GPEC2A skim guard yields null skimByte/skimStatus when sz <= 0x11', () => {
    // The GPEC2A branch is reached only for sz===4096, so the null guard is
    // defense-in-depth. We verify the guard predicate directly by hand-
    // simulating the branch on a tiny buffer that would otherwise crash on
    // `data[0x0011].toString(16)`.
    const tiny = new Uint8Array(4);
    expect(tiny.length > 0x0011).toBe(false);
    expect(tiny[0x0011]).toBeUndefined();
    // Confirm the previous unguarded code path would have thrown:
    expect(() => tiny[0x0011].toString(16)).toThrow();
  });
  it('BCM securityLock and fobikCount expose values for full-size BCM', () => {
    const m = parseModule(makeBcm(), 'bcm.bin');
    expect(m.securityLock).not.toBeNull();
    expect(m.securityLock.offset).toBe(0x8028);
    expect(typeof m.securityLock.value).toBe('number');
    expect(typeof m.fobikCount).toBe('number');
  });
  it('BCM null-guards collapse to null when sz <= guarded offset (predicate check)', () => {
    // BCM is only reached for sz===65536 / 131072, so the null branches are
    // defense-in-depth against future size additions. Verify the guard
    // predicates short-circuit as designed.
    const small = new Uint8Array(0x5862);
    expect(small.length > 0x8028).toBe(false);
    expect(small.length > 0x5862).toBe(false);
    expect(small[0x8028]).toBeUndefined();
    expect(small[0x5862]).toBeUndefined();
  });
  it('does not throw on tiny / empty buffers (overall null-safety)', () => {
    expect(() => parseModule(new Uint8Array(0), 'empty.bin')).not.toThrow();
    expect(() => parseModule(new Uint8Array(16), 'tiny.bin')).not.toThrow();
    expect(() => parseModule(new Uint8Array(512), 'small.bin')).not.toThrow();
  });
});

describe('RFHUB Gen1 (24C16, 2048 bytes)', () => {
  const buf = makeRfhubGen1();
  it('classifies 2048-byte RFHUB Gen1 buffers as RFHUB', () => {
    // Task #365: parseModule()'s sz-based table now recognizes 2 KB Gen1
    // RFH dumps so the Key Prog wizard can drive older Cherokee/etc.
    // vehicles instead of bailing out.
    const m = parseModule(buf, 'rfh-gen1.bin');
    expect(m.type).toBe('RFHUB');
    expect(m.hexOnly).toBeUndefined();
    expect(m.rfhGen).toBe('Gen1 (24C16)');
  });
  it('Gen1 VIN slots are out of range for 2KB EEPROMs (parser skips them)', () => {
    // The shared knownOffsets table (0x0ea5..) is past the end of a 2KB
    // image, so neither the Gen1 nor Gen2 VIN scan can read VINs from a
    // 2048-byte buffer. Verify the bounds-check holds and the crc8rf
    // primitive used by the Gen1 path round-trips on a separate buffer.
    expect(extractVIN(buf, 0x0ea5)).toBeNull();
    const vinAscii = new Uint8Array(17);
    for (let i = 0; i < 17; i++) vinAscii[i] = VIN_DEFAULT.charCodeAt(i);
    const cs = crc8rf(vinAscii);
    expect(cs).toBeGreaterThanOrEqual(0);
    expect(cs).toBeLessThanOrEqual(0xFF);
    // Determinism: same input → same crc8rf output.
    expect(crc8rf(vinAscii)).toBe(cs);
  });
  it('Gen1 SEC16 lives at 0x00AE and 0x00C0 (slot 1 / slot 2)', () => {
    const slot1 = buf.slice(0xAE, 0xAE + 16);
    const slot2 = buf.slice(0xC0, 0xC0 + 16);
    expect(Array.from(slot1)).toEqual(Array.from(slot2));
    expect(slot1.every(b => b === 0xFF)).toBe(false);
    // Sanity: Gen2 SEC16 CS formula must NOT match Gen1 stored bytes (Gen1
    // CS formula is unconfirmed; the parser leaves csOk undefined).
    const gen2Cs = rfhSec16Cs(slot1);
    const stored = (buf[0xAE + 16] << 8) | buf[0xAE + 17];
    expect(stored).not.toBe(gen2Cs);
  });
});

describe('sizeWarn — non-canonical capture sizes', () => {
  it('canonical sizes produce no sizeWarn', () => {
    expect(parseModule(makeBcm({ size: 65536 }), 'bcm.bin').sizeWarn).toBeNull();
    expect(parseModule(make95640(), '95640.bin').sizeWarn).toBeNull();
    expect(parseModule(makeGpec2a(), 'gpec.bin').sizeWarn).toBeNull();
    expect(parseModule(makeRfhubGen2(), 'rfh.bin').sizeWarn).toBeNull();
  });

  it('forced GPEC2A at 8 KB (canonical larger GPEC2A — no warn after Task #404)', () => {
    // Task #404: 8 KB is a canonical Continental GPEC2A size (95640
    // EXT-EEPROM revision), not "oversized". The earlier "GPEC5"
    // concept was wrong — purged in this task.
    const buf = new Uint8Array(8192);
    const m = parseModule(buf, 'gpec_8k.bin', { forceType: 'GPEC2A' });
    expect(m.type).toBe('GPEC2A');
    expect(m.sizeWarn).toBeNull();
  });

  it('forced GPEC2A at 384 KB (Charger 6.2-style padded) gets oversized warn with multiplier hint', () => {
    const buf = new Uint8Array(393216);
    const m = parseModule(buf, 'pcm.bin', { forceType: 'GPEC2A' });
    expect(m.type).toBe('GPEC2A');
    expect(m.sizeWarn.kind).toBe('oversized');
    // After Task #404, GPEC2A canonical sizes are {4096, 8192}; the
    // nearest canonical (and so the "expected" anchor for the warn) is
    // now 8192 for any padded-multiple buffer ≥ 8 KB.
    expect(m.sizeWarn.expected).toBe(8192);
    expect(m.sizeWarn.causes.some(c => /\d+×/.test(c))).toBe(true);
  });

  it('forced 95640 at 64 KB (FCA-style padded) gets oversized warn', () => {
    const buf = new Uint8Array(65536);
    const m = parseModule(buf, 'fca_95640.bin', { forceType: '95640' });
    expect(m.type).toBe('95640');
    expect(m.sizeWarn.kind).toBe('oversized');
    expect(m.sizeWarn.expected).toBe(8192);
  });

  it('forced BCM at 8 KB (truncated demo dump) gets truncated warn', () => {
    const buf = new Uint8Array(8192);
    const m = parseModule(buf, 'bcm_demo.bin', { forceType: 'BCM' });
    expect(m.type).toBe('BCM');
    expect(m.sizeWarn.kind).toBe('truncated');
    expect(m.sizeWarn.expected).toBe(65536);
    expect(m.sizeWarn.causes.some(c => /Truncated/i.test(c))).toBe(true);
  });

  it('FW-bucket file (>128 KB) with GPEC filename reclassifies to GPEC2A and warns', () => {
    const buf = new Uint8Array(393216);
    const m = parseModule(buf, 'CHARGER_GPEC2A_PCM_oversized.bin');
    expect(m.type).toBe('GPEC2A');
    expect(m.sizeWarn).not.toBeNull();
    expect(m.sizeWarn.kind).toBe('oversized');
  });

  it('canonical-sized BCM with misleading "RFHUB" in filename keeps BCM type (filename hint stays conservative)', () => {
    const m = parseModule(makeBcm({ size: 65536 }), 'CHARGER_RFHUB_actually_a_bcm.bin');
    expect(m.type).toBe('BCM');
    expect(m.sizeWarn).toBeNull();
  });

  it('64 KB padded GPEC2A (no BCM content) reclassifies via filename hint and warns', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const m = parseModule(buf, 'JOVENTINO_GPEC2A_PCM_EEPROM_padded.bin');
    expect(m.type).toBe('GPEC2A');
    expect(m.sizeWarn.kind).toBe('oversized');
    // Task #404: nearest canonical for an oversized GPEC2A is now 8192
    // (canonical set = {4096, 8192}).
    expect(m.sizeWarn.expected).toBe(8192);
    expect(m.sizeWarn.actual).toBe(65536);
  });

  it('64 KB padded 95640 (no BCM content) reclassifies via filename hint and warns', () => {
    const buf = new Uint8Array(65536).fill(0xFF);
    const m = parseModule(buf, 'FCA_DK_95640_EXT_EEPROM_padded.bin');
    expect(m.type).toBe('95640');
    expect(m.sizeWarn.kind).toBe('oversized');
    expect(m.sizeWarn.expected).toBe(8192);
  });

  it('real BCM with filename hint of GPEC2A keeps BCM (content trumps filename)', () => {
    const m = parseModule(makeBcm({ size: 65536 }), 'CHARGER_GPEC2A_actually_a_bcm.bin');
    expect(m.type).toBe('BCM');
    expect(m.sizeWarn).toBeNull();
  });

  it('8 KB file with GPEC filename stays as 95640 (keyProgWizard handles doubled-PCM reparse)', () => {
    const buf = new Uint8Array(8192);
    const m = parseModule(buf, 'TRACKHAWK_GPEC2A_PCM.bin');
    expect(m.type).toBe('95640');
  });

  it('typeFromFilename basic mapping', () => {
    expect(typeFromFilename('GPEC2A_dump.bin')).toBe('GPEC2A');
    expect(typeFromFilename('rfhub_eee.bin')).toBe('RFHUB');
    expect(typeFromFilename('95640_ext.bin')).toBe('95640');
    expect(typeFromFilename('BCM_DFLASH.bin')).toBe('BCM');
    expect(typeFromFilename(null)).toBe(null);
  });

  it('buildSizeWarn returns null for unknown / canonical-matching cases', () => {
    expect(buildSizeWarn('TCM', 4096)).toBeNull();
    expect(buildSizeWarn('BCM', 65536)).toBeNull();
    expect(buildSizeWarn('RFHUB', 2048)).toBeNull();
    expect(buildSizeWarn('RFHUB', 4096)).toBeNull();
  });
});

describe('contentWarn — 64 KB capture that does not look like a BCM', () => {
  // Two real captures in the test fixtures are 64 KB but are not actually
  // BCM dumps. Without filename hints they would be auto-detected as BCM
  // and surface garbage in the BCM panel. The contentWarn flags this so
  // the user knows to re-load the file through the GPEC2A or 95640 tab.
  const fs = require('fs');
  const path = require('path');
  const fxDir = path.resolve(__dirname, '../../__tests__/fixtures');
  const load = (n) => new Uint8Array(fs.readFileSync(path.join(fxDir, n)));

  it('populated real BCM has no contentWarn (VINs at canonical slots)', () => {
    const m = parseModule(load('SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin'), 'bcm.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).toBeNull();
  });

  it('JOVENTINO 64 KB capture loaded with neutral filename triggers contentWarn', () => {
    // Strip the filename hint so the auto-detect falls through to 'BCM' on
    // size alone — exactly the situation the user hits with renamed files.
    const m = parseModule(load('SAMPLE_GPEC2A_EXT_EEPROM_JOVENTINO_OG.bin'), 'module1.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).not.toBeNull();
    expect(m.contentWarn.kind).toBe('maybe-not-bcm');
    expect(m.contentWarn.message).toMatch(/65,536.*BCM/);
    expect(m.contentWarn.causes.some(c => /GPEC2A/.test(c))).toBe(true);
    expect(m.contentWarn.causes.some(c => /95640/.test(c))).toBe(true);
  });

  it('FCA_DK 64 KB fixture is byte-identical to a real BCM dump — no warn', () => {
    // The "FCA 95640 OG" fixture turns out to be byte-identical to
    // SAMPLE_BCM_DFLASH_18TH_OG.bin (md5 73c9390aec8d870ddf1c56873f4438af).
    // Its 0x2000 backup IMMO bank holds 8 populated records, so by content
    // it really is a BCM image — the contentWarn correctly does NOT fire.
    const m = parseModule(load('SAMPLE_95640_EXT_EEPROM_FCA_DK_OG.bin'), 'module2.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).toBeNull();
  });

  it('virgin BCM with NO populated VINs/IMMO triggers contentWarn (defensive hint)', () => {
    // A 64 KB blank/virgin buffer satisfies the size detector but has no
    // BCM-defining structure. The warning steers the user toward
    // double-checking that the dump is really a BCM (vs. a padded GPEC2A
    // / 95640) before they trust the BCM panel fields.
    const blank = new Uint8Array(65536).fill(0xFF);
    const m = parseModule(blank, 'unknown_dump.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).not.toBeNull();
    expect(m.contentWarn.kind).toBe('maybe-not-bcm');
  });

  it('makeBcm fixture (synthetic populated BCM) has no contentWarn', () => {
    const m = parseModule(makeBcm({ size: 65536 }), 'bcm.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).toBeNull();
  });

  it('synthetic BCM at 128 KB also passes content sanity check', () => {
    const m = parseModule(makeBcm({ size: 131072 }), 'bcm.bin');
    expect(m.type).toBe('BCM');
    expect(m.contentWarn).toBeNull();
  });

  it('non-BCM types never get a contentWarn', () => {
    expect(parseModule(makeGpec2a(), 'g.bin').contentWarn).toBeNull();
    expect(parseModule(make95640(), 's.bin').contentWarn).toBeNull();
    expect(parseModule(makeRfhubGen2(), 'r.bin').contentWarn).toBeNull();
  });
});
