import { describe, it, expect } from 'vitest';
import {
  parseHexBytes,
  makeKeyRecord,
  validateKeyRecord,
  cloneKeyRecord,
  buildKeyDumpManifest,
  buildKeyDumpBin,
  parseKeyDumpBin,
  keyDumpBaseName,
  KEY_DUMP_MAGIC,
  KEY_DUMP_VERSION,
  KEY_DUMP_CHIP_ORDINAL,
  CODING_SCHEMES,
} from '../keyDump.js';

// Reference values from the Task #985 bench read.
const UID_HEX = '437C2C9F';      // 4 bytes
const SK_HEX = '4F4E4D494B52';   // 6 bytes (HITAG2 secret key)
const UID_BYTES = [0x43, 0x7c, 0x2c, 0x9f];
const SK_BYTES = [0x4f, 0x4e, 0x4d, 0x49, 0x4b, 0x52];

describe('parseHexBytes', () => {
  it('parses a compact hex string', () => {
    const r = parseHexBytes(SK_HEX);
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual(SK_BYTES);
  });

  it('tolerates spaces, 0x prefixes and commas', () => {
    const r = parseHexBytes('0x43, 0x7C 2C9F');
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual(UID_BYTES);
  });

  it('refuses odd digit counts', () => {
    const r = parseHexBytes('ABC');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/odd/i);
  });

  it('refuses empty / non-hex input', () => {
    expect(parseHexBytes('').ok).toBe(false);
    expect(parseHexBytes('zzzz').ok).toBe(false);
  });

  it('refuses (does not silently strip) embedded garbage that would otherwise pass', () => {
    // Old permissive parser stripped the "GG" and accepted this as 4F4E4D49 (4 bytes).
    // Strict refuse-on-doubt must reject the whole input.
    const r = parseHexBytes('4F4E GG 4D49');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid hex token/i);
  });

  it('refuses a token with an x in the middle', () => {
    const r = parseHexBytes('4F0x4E');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid hex token/i);
  });

  it('refuses a lone 0x prefix with no digits', () => {
    expect(parseHexBytes('0x').ok).toBe(false);
    expect(parseHexBytes('0x 4F').ok).toBe(false);
  });

  it('refuses stray punctuation', () => {
    expect(parseHexBytes('4F-4E').ok).toBe(false);
    expect(parseHexBytes('4F4E!').ok).toBe(false);
  });
});

describe('validateKeyRecord', () => {
  const good = () => makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: SK_HEX });

  it('accepts a well-formed pcf7953 key', () => {
    const v = validateKeyRecord(good());
    expect(v.ok).toBe(true);
    expect([...v.uid]).toEqual(UID_BYTES);
    expect([...v.sk]).toEqual(SK_BYTES);
  });

  it('refuses an unknown chip family', () => {
    const v = validateKeyRecord(makeKeyRecord({ chipId: 'nope', uid: UID_HEX, sk: SK_HEX }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unknown chip/i);
  });

  it('refuses a blank UID (all 0xFF)', () => {
    const v = validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: 'FFFFFFFF', sk: SK_HEX }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/blank/i);
  });

  it('refuses a blank SK (all 0x00)', () => {
    const v = validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: '000000000000' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/blank/i);
  });

  it('refuses a wrong-length UID for the chip family', () => {
    const v = validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: '437C2C', sk: SK_HEX }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/UID length/i);
  });

  it('refuses a wrong-length SK for the chip family', () => {
    const v = validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: '4F4E4D49' }));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/SK length/i);
  });

  it('refuses empty UID / SK', () => {
    expect(validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: '', sk: SK_HEX })).ok).toBe(false);
    expect(validateKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: '' })).ok).toBe(false);
  });

  it('validates a megamos-aes key with 7-byte UID + 16-byte SK', () => {
    const v = validateKeyRecord(makeKeyRecord({
      chipId: 'megamos-aes',
      uid: '00112233445566',
      sk: '000102030405060708090A0B0C0D0E0F',
    }));
    expect(v.ok).toBe(true);
  });
});

describe('cloneKeyRecord', () => {
  it('deep-copies bytes and suffixes the label', () => {
    const src = makeKeyRecord({ chipId: 'pcf7953', label: 'Key A', uid: UID_HEX, sk: SK_HEX, locked: true });
    const clone = cloneKeyRecord(src);
    expect(clone.label).toBe('Key A (copy)');
    expect([...clone.uid]).toEqual(UID_BYTES);
    expect(clone.locked).toBe(true);
    // Mutating the clone must not touch the source.
    clone.uid[0] = 0x00;
    expect(src.uid[0]).toBe(0x43);
  });

  it('gives an unlabelled record a sensible default', () => {
    const clone = cloneKeyRecord(makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: SK_HEX }));
    expect(clone.label).toBe('Key (copy)');
  });
});

describe('buildKeyDumpManifest', () => {
  it('produces parseable JSON with SK kept separate and the caveat note', () => {
    const rec = makeKeyRecord({ chipId: 'pcf7953', label: 'bench', uid: UID_HEX, sk: SK_HEX, locked: false, encryption: true, cloneable: true, coding: 'Manchester coding' });
    const json = buildKeyDumpManifest(rec);
    const m = JSON.parse(json);
    expect(m.valid).toBe(true);
    expect(m.chip_family).toBe('pcf7953');
    expect(m.uid_hex_compact).toBe(UID_HEX);
    expect(m.sk_hex_compact).toBe('4F4E4D494B52');
    expect(m.flags.encryption_mode).toBe(true);
    expect(m.flags.cloneable).toBe(true);
    expect(m.flags.locked).toBe(false);
    expect(m.flags.coding).toBe('Manchester coding');
    // SK must be documented as distinct from SEC16.
    expect(m._sk_note).toMatch(/not the rfhub.*sec16/i);
    expect(m._note).toMatch(/not a verified vendor import/i);
  });

  it('marks an invalid record as not valid with the reason', () => {
    const m = JSON.parse(buildKeyDumpManifest(makeKeyRecord({ chipId: 'pcf7953', uid: 'FFFFFFFF', sk: SK_HEX })));
    expect(m.valid).toBe(false);
    expect(m.validation_error).toMatch(/blank/i);
  });
});

describe('buildKeyDumpBin / parseKeyDumpBin round-trip', () => {
  it('refuses to build a bin for an invalid record', () => {
    const r = buildKeyDumpBin(makeKeyRecord({ chipId: 'pcf7953', uid: 'FFFFFFFF', sk: SK_HEX }));
    expect(r.ok).toBe(false);
  });

  it('emits the documented header layout', () => {
    const rec = makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: SK_HEX, locked: true, encryption: true, cloneable: false, coding: 'Manchester coding' });
    const { ok, bin } = buildKeyDumpBin(rec);
    expect(ok).toBe(true);
    expect([...bin.slice(0, 4)]).toEqual(KEY_DUMP_MAGIC);
    expect(bin[4]).toBe(KEY_DUMP_VERSION);
    expect(bin[5]).toBe(KEY_DUMP_CHIP_ORDINAL.pcf7953);
    expect(bin[6]).toBe(4);  // uidLen
    expect(bin[7]).toBe(6);  // skLen
    expect(bin[8]).toBe(0x01 | 0x02); // locked + encryption, not cloneable
    expect(bin[9]).toBe(CODING_SCHEMES.indexOf('Manchester coding'));
    expect(bin.length).toBe(10 + 4 + 6);
  });

  it('round-trips every field through parseKeyDumpBin', () => {
    const rec = makeKeyRecord({ chipId: 'pcf7945', uid: UID_HEX, sk: SK_HEX, locked: false, encryption: true, cloneable: true, coding: 'PSK' });
    const { bin } = buildKeyDumpBin(rec);
    const back = parseKeyDumpBin(bin);
    expect(back.ok).toBe(true);
    expect(back.record.chipId).toBe('pcf7945');
    expect([...back.record.uid]).toEqual(UID_BYTES);
    expect([...back.record.sk]).toEqual(SK_BYTES);
    expect(back.record.locked).toBe(false);
    expect(back.record.encryption).toBe(true);
    expect(back.record.cloneable).toBe(true);
    expect(back.record.coding).toBe('PSK');
    // The parsed record must itself validate.
    expect(validateKeyRecord(back.record).ok).toBe(true);
  });

  it('rejects a bad magic / truncated buffer', () => {
    expect(parseKeyDumpBin(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(parseKeyDumpBin(new Uint8Array(10)).ok).toBe(false); // zero magic
  });
});

describe('keyDumpBaseName', () => {
  it('builds a safe filename from label + UID', () => {
    const rec = makeKeyRecord({ chipId: 'pcf7953', label: 'Charger #2', uid: UID_HEX, sk: SK_HEX });
    expect(keyDumpBaseName(rec)).toBe('keydump_Charger_2_437C2C9F');
  });

  it('falls back to chip id when unlabelled', () => {
    const rec = makeKeyRecord({ chipId: 'pcf7953', uid: UID_HEX, sk: SK_HEX });
    expect(keyDumpBaseName(rec)).toBe('keydump_pcf7953_437C2C9F');
  });
});
