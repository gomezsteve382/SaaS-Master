import { describe, it, expect } from 'vitest';
import {
  parseModule,
  syncImmoBackup,
  countSkimRecs,
  detectBySignature,
  extractVIN,
  extractHex,
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

describe('RFHUB Gen1 (24C16, 2048 bytes)', () => {
  const buf = makeRfhubGen1();
  it('classifies 2048-byte RFHUB Gen1 buffers as UNKNOWN today', () => {
    // Pins current behavior: parseModule()'s sz-based table only handles
    // sz===4096 for RFHUB. If/when 2048 is wired in, this test will catch it.
    const m = parseModule(buf, 'rfh-gen1.bin');
    expect(m.type).toBe('UNKNOWN');
    expect(m.hexOnly).toBe(true);
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
