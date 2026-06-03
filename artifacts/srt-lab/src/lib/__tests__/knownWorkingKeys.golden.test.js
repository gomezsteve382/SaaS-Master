/* ============================================================================
 * knownWorkingKeys.golden.test.js — ties the registry seed to the real bytes
 * it was lifted from (Task #1096).
 *
 * Loads the 4 KB 2019 Charger 6.2 RFHUB dump from the key-index package, parses
 * its 8-slot Charger key table, and asserts that the working key 0077A29B sits
 * where the registry says it does (slot 3 @ 0xC7E, index 0x48, flag 0x01).
 * This is the bench ground truth the registry entry encodes.
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCharKeyTable,
  keyIdToRevUid,
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
} from '../charRfhubKeyTable.js';
import { KNOWN_WORKING_KEYS, classifyAgainstRegistry, knownKeyToRecord } from '../keyWriter/knownWorkingKeys.js';

const FIXTURE = resolve(
  __dirname,
  '../../__tests__/fixtures/SAMPLE_RFHUB_EEE_19CHARGER62_KEYINDEX_0077A29B.bin',
);

const SEED = KNOWN_WORKING_KEYS.find((e) => e.keyId === '0077A29B');

function loadDump() {
  return new Uint8Array(readFileSync(FIXTURE));
}

describe('knownWorkingKeys golden — 2019 Charger 6.2 RFHUB dump', () => {
  it('fixture is a canonical 4 KB RFHUB image', () => {
    expect(loadDump().length).toBe(4096);
  });

  it('parses the Charger 8-slot key table', () => {
    const p = parseCharKeyTable(loadDump());
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(6);
  });

  it('working key 0077A29B sits at slot 3 / 0xC7E with index 0x48, flag 0x01', () => {
    const p = parseCharKeyTable(loadDump());
    const slot3 = p.slots.find((s) => s.slot === 3);
    expect(slot3).toBeTruthy();
    expect(slot3.offset).toBe(0x0C7E);
    expect(slot3.offset).toBe(SEED.tableAddr);
    expect(slot3.keyId).toBe('0077A29B');
    expect(slot3.indexLow).toBe(0x48);
    expect(slot3.indexLow).toBe(SEED.tableIndex);
    expect(slot3.flag).toBe(0x01);
  });

  it('the slot offset matches base 0xC5E + 2·stride (slot 3 is the first real key)', () => {
    const expected = CHAR_KEYTABLE_BASE + 2 * CHAR_KEYTABLE_STRIDE;
    expect(expected).toBe(0x0C7E);
  });

  it('registry revUid matches the byte-reversed keyId stored in the dump', () => {
    const rev = Array.from(keyIdToRevUid(SEED.keyId))
      .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    expect(rev).toBe(SEED.revUid);

    const p = parseCharKeyTable(loadDump());
    const slot3 = p.slots.find((s) => s.slot === 3);
    const rawRev = Array.from(slot3.raw.slice(0, 4))
      .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    expect(rawRev).toBe(SEED.revUid);
  });

  it('a record built from the dump slot classifies as known-good', () => {
    const rec = knownKeyToRecord(SEED);
    expect(classifyAgainstRegistry(rec).status).toBe('known-good');
  });
});
