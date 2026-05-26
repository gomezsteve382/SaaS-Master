import { describe, it, expect } from 'vitest';
import {
  buildAutelExportData,
  buildJsonManifest,
  buildRawBin,
  exportBaseName,
} from '../keyWriter/autelExport.js';
import { CHIP_FAMILIES } from '../keyWriter/chipFamilies.js';

const PCF7953 = CHIP_FAMILIES.find((c) => c.id === 'pcf7953');
const PCF7945 = CHIP_FAMILIES.find((c) => c.id === 'pcf7945');

function makeSlot(idBytes, occupied = true, idMapped = true) {
  return { idx: 0, markerOffset: 0x0880, occupied, idMapped, raw: new Uint8Array([0xAA, 0x50]), idOffset: 0x0888, idBytes: new Uint8Array(idBytes) };
}
const SEC16 = new Uint8Array([0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC]);
const UID4 = [0x11, 0x22, 0x33, 0x44];
const PAY4 = [0x55, 0x66, 0x77, 0x88];
const ID8  = [...UID4, ...PAY4];

describe('buildAutelExportData', () => {
  it('returns ok for valid pcf7953 slot + sec16', () => {
    const slot = makeSlot(ID8);
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(true);
    expect([...r.uid]).toEqual(UID4);
    expect([...r.payload]).toEqual(PAY4);
    expect([...r.sec16]).toEqual([...SEC16]);
  });

  it('returns ok for valid pcf7945 slot (gen1)', () => {
    const slot = makeSlot(ID8);
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'pcf7945', chipDef: PCF7945, gen: 'gen1' });
    expect(r.ok).toBe(true);
    expect([...r.uid]).toEqual(UID4);
  });

  it('refuses empty slot', () => {
    const slot = makeSlot(ID8, false);
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(false);
  });

  it('refuses unmapped slot', () => {
    const slot = makeSlot(ID8, true, false);
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(false);
  });

  it('refuses blank SEC16 (all-FF)', () => {
    const blank = new Uint8Array(16).fill(0xFF);
    const slot = makeSlot(ID8);
    const r = buildAutelExportData({ slot, secret16: blank, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blank/i);
  });

  it('refuses blank SEC16 (all-00)', () => {
    const blank = new Uint8Array(16).fill(0x00);
    const slot = makeSlot(ID8);
    const r = buildAutelExportData({ slot, secret16: blank, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(false);
  });

  it('refuses wrong id block length', () => {
    const slot = makeSlot([0x11, 0x22, 0x33]); // 3 bytes, pcf7953 wants 8
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ID block length/);
  });

  it('refuses unknown chip family', () => {
    const slot = makeSlot(ID8);
    const r = buildAutelExportData({ slot, secret16: SEC16, chipId: 'unknown', chipDef: null, gen: 'gen2' });
    expect(r.ok).toBe(false);
  });
});

describe('buildJsonManifest', () => {
  const uid     = new Uint8Array(UID4);
  const payload = new Uint8Array(PAY4);

  it('produces parseable JSON with all required fields', () => {
    const json = buildJsonManifest({ uid, payload, sec16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2', slotIdx: 0, fileName: 'test.bin' });
    const parsed = JSON.parse(json);
    expect(parsed.transponder_uid_hex_compact).toBe('11223344');
    expect(parsed.payload_hex_compact).toBe('55667788');
    expect(parsed.sec16_master_secret_hex_compact).toBe('DDEEFF00112233445566778899AABBCC');
    expect(parsed.chip_family).toBe('pcf7953');
    expect(parsed.slot_index).toBe(1);
    expect(parsed.rfhub_gen).toBe('gen2');
    expect(Array.isArray(parsed.autel_workflow)).toBe(true);
    expect(parsed.autel_workflow.length).toBeGreaterThan(0);
  });

  it('embeds the UID and SEC16 compact hex in the workflow instructions', () => {
    const json = buildJsonManifest({ uid, payload, sec16: SEC16, chipId: 'pcf7953', chipDef: PCF7953, gen: 'gen2', slotIdx: 1, fileName: 'test.bin' });
    const parsed = JSON.parse(json);
    const stepText = parsed.autel_workflow.join(' ');
    expect(stepText).toContain('11223344');
    expect(stepText).toContain('DDEEFF00112233445566778899AABBCC');
  });
});

describe('buildRawBin', () => {
  const uid     = new Uint8Array(UID4);
  const payload = new Uint8Array(PAY4);

  it('starts with AUTL magic and version 0x01', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7953' });
    expect(bin[0]).toBe(0x41); // 'A'
    expect(bin[1]).toBe(0x55); // 'U'
    expect(bin[2]).toBe(0x54); // 'T'
    expect(bin[3]).toBe(0x4C); // 'L'
    expect(bin[4]).toBe(0x01); // version
  });

  it('encodes PCF7953 as ordinal 0x01', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7953' });
    expect(bin[5]).toBe(0x01);
  });

  it('encodes PCF7945 as ordinal 0x02', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7945' });
    expect(bin[5]).toBe(0x02);
  });

  it('encodes unknown chip as 0xFF', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'unrecognized' });
    expect(bin[5]).toBe(0xFF);
  });

  it('places UID bytes immediately after the header', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7953' });
    // Header: magic(4) + version(1) + ordinal(1) + uidLen(1) + payLen(1) = 8
    expect(bin[6]).toBe(uid.length);   // uidLen
    expect(bin[7]).toBe(payload.length); // payLen
    expect(bin[8]).toBe(0x11);
    expect(bin[9]).toBe(0x22);
    expect(bin[10]).toBe(0x33);
    expect(bin[11]).toBe(0x44);
  });

  it('places payload bytes after UID', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7953' });
    expect(bin[12]).toBe(0x55);
    expect(bin[13]).toBe(0x66);
    expect(bin[14]).toBe(0x77);
    expect(bin[15]).toBe(0x88);
  });

  it('places SEC16 after payload and matches length', () => {
    const bin = buildRawBin({ uid, payload, sec16: SEC16, chipId: 'pcf7953' });
    const sec = bin.slice(16, 32);
    expect([...sec]).toEqual([...SEC16]);
    expect(bin.length).toBe(32);
  });
});

describe('exportBaseName', () => {
  it('strips extension and sanitises the filename', () => {
    expect(exportBaseName('MY RFHUB 2019.bin', 0)).toBe('MY_RFHUB_2019_slot1_autel');
  });

  it('handles missing filename', () => {
    expect(exportBaseName(null, 2)).toBe('rfhub_slot3_autel');
    expect(exportBaseName(undefined, 0)).toBe('rfhub_slot1_autel');
  });

  it('uses 1-indexed slot number', () => {
    expect(exportBaseName('test.bin', 3)).toBe('test_slot4_autel');
  });
});
