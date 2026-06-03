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
import {
  KNOWN_WORKING_KEYS,
  classifyAgainstRegistry,
  knownKeyToRecord,
  getKnownWorkingKeys,
} from '../keyWriter/knownWorkingKeys.js';

/* Reference VIN for the 2019 Charger 6.2 dump (see charRfhubKeyTable.js header
 * + knownWorkingKeys.js sibling-key block). The five sibling keys are scoped to
 * this VIN; the seed key #1 is global. */
const REF_VIN = '2C3CDXL92KH674464';

/* The five sibling keys lifted from slots 4..8 of the same dump. Each tuple is
 * [keyId, slot, offset, indexLow] — every value is asserted against the real
 * bytes below, so a registry typo or a re-extracted dump will fail this test. */
const SIBLINGS = [
  ['CC62209F', 4, 0x0C8E, 0x0F],
  ['09A6629F', 5, 0x0C9E, 0x4C],
  ['91654F9E', 6, 0x0CAE, 0x19],
  ['197E6C9E', 7, 0x0CBE, 0x5B],
  ['C47D6C9E', 8, 0x0CCE, 0xB0],
];

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

  it.each(SIBLINGS)(
    'sibling key %s sits at the registry-recorded slot/offset/index/flag in the dump',
    (keyId, slot, offset, indexLow) => {
      const entry = KNOWN_WORKING_KEYS.find((e) => e.keyId === keyId);
      expect(entry).toBeTruthy();
      expect(entry.tableAddr).toBe(offset);
      expect(entry.tableIndex).toBe(indexLow);
      expect(entry.tableFlag).toBe(0x01);

      const p = parseCharKeyTable(loadDump());
      const s = p.slots.find((x) => x.slot === slot);
      expect(s).toBeTruthy();
      expect(s.state).toBe('key');
      expect(s.flag).toBe(0x01);
      expect(s.offset).toBe(offset);
      expect(s.offset).toBe(entry.tableAddr);
      expect(s.keyId).toBe(keyId);
      expect(s.indexLow).toBe(indexLow);
      expect(s.indexLow).toBe(entry.tableIndex);

      // registry revUid == byte-reversed keyId == the bytes stored in the dump.
      const calcRev = Array.from(keyIdToRevUid(keyId))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      const rawRev = Array.from(s.raw.slice(0, 4))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      expect(calcRev).toBe(entry.revUid);
      expect(rawRev).toBe(entry.revUid);
    },
  );

  it('all six paired keys from the dump are represented in the registry', () => {
    const p = parseCharKeyTable(loadDump());
    const dumpKeyIds = p.slots.filter((s) => s.state === 'key').map((s) => s.keyId).sort();
    const registryKeyIds = KNOWN_WORKING_KEYS.filter((e) => e.vehicle.startsWith('2019 Charger 6.2'))
      .map((e) => e.keyId)
      .sort();
    expect(registryKeyIds).toEqual(dumpKeyIds);
  });

  it('sibling records built from the registry classify as known-good for the reference VIN', () => {
    for (const [keyId] of SIBLINGS) {
      const entry = KNOWN_WORKING_KEYS.find((e) => e.keyId === keyId);
      const rec = knownKeyToRecord(entry);
      expect(classifyAgainstRegistry(rec, REF_VIN).status).toBe('known-good');
    }
  });

  it('per-VIN filtering: siblings surface ONLY for the reference VIN, seed is global', () => {
    const refKeys = getKnownWorkingKeys(REF_VIN).map((e) => e.keyId);
    // The reference VIN sees the global seed + all five siblings.
    expect(refKeys).toContain('0077A29B');
    for (const [keyId] of SIBLINGS) expect(refKeys).toContain(keyId);

    // A different (valid) VIN sees the global seed but none of the siblings.
    const otherKeys = getKnownWorkingKeys('1C4RJFN9XJC309165').map((e) => e.keyId);
    expect(otherKeys).toContain('0077A29B');
    for (const [keyId] of SIBLINGS) expect(otherKeys).not.toContain(keyId);

    // No VIN → globals only.
    const noVin = getKnownWorkingKeys().map((e) => e.keyId);
    expect(noVin).toEqual(['0077A29B']);
  });

  it('a sibling record does NOT classify as known-good without its VIN scope', () => {
    const entry = KNOWN_WORKING_KEYS.find((e) => e.keyId === SIBLINGS[0][0]);
    const rec = knownKeyToRecord(entry);
    // VIN-scoped: absent the VIN it is not in the candidate set → unknown.
    expect(classifyAgainstRegistry(rec).status).toBe('unknown');
  });
});

/* ============================================================================
 * Second + third vehicles (Task #1099): keys sourced from two MORE real RFHUB
 * dumps that parse cleanly (flag 0x01, mirror-verified). Each block mirrors the
 * 2019 Charger 6.2 golden above: load the fixture, parse its Charger table, and
 * assert that every registered key sits exactly where the registry says it does.
 * ========================================================================== */

/* Each tuple: [keyId, slot, offset, indexLow, revUid] — all asserted vs bytes. */
const VEHICLES = [
  {
    name: 'Charger SCAT — VIN 2C3CDXHG5EH219538',
    vin: '2C3CDXHG5EH219538',
    vehicle: 'Charger SCAT (RFHUB EEPROM)',
    fixture: 'SAMPLE_RFHUB_EEE_SCATPACK_KEYS_2C3CDXHG5EH219538.bin',
    keyCount: 5,
    keys: [
      ['54D44964', 4, 0x0C8E, 0x27, '6449D454'],
      ['37BB1F68', 5, 0x0C9E, 0x83, '681FBB37'],
      ['90B0EB64', 6, 0x0CAE, 0x6C, '64EBB090'],
      ['33741E64', 7, 0x0CBE, 0xD3, '641E7433'],
      ['E1381664', 8, 0x0CCE, 0x69, '641638E1'],
    ],
  },
  {
    name: 'Charger 6.2 "CARTMAN" — VIN 2C3CDZL95NH179529',
    vin: '2C3CDZL95NH179529',
    vehicle: 'Charger 6.2 "CARTMAN" (RFHUB EEPROM)',
    fixture: 'SAMPLE_RFHUB_EEE_21CHARGER62_KEYS_2C3CDZL95NH179529.bin',
    keyCount: 3,
    keys: [
      ['2FA7D964', 6, 0x0CAE, 0xE8, '64D9A72F'],
      ['3AC1D964', 7, 0x0CBE, 0xC3, '64D9C13A'],
      ['73C0D964', 8, 0x0CCE, 0x8B, '64D9C073'],
    ],
  },
];

describe.each(VEHICLES)('knownWorkingKeys golden — $name', (V) => {
  const loadV = () =>
    new Uint8Array(readFileSync(resolve(__dirname, '../../__tests__/fixtures/', V.fixture)));

  it('fixture is a canonical 4 KB RFHUB image with the expected key count', () => {
    expect(loadV().length).toBe(4096);
    const p = parseCharKeyTable(loadV());
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(V.keyCount);
    expect(p.unknownCount).toBe(0);
  });

  it.each(V.keys)(
    'key %s sits at the registry-recorded slot/offset/index/flag in the dump',
    (keyId, slot, offset, indexLow, revUid) => {
      const entry = KNOWN_WORKING_KEYS.find((e) => e.keyId === keyId);
      expect(entry).toBeTruthy();
      expect(entry.vin).toBe(V.vin);
      expect(entry.vehicle).toBe(V.vehicle);
      expect(entry.tableAddr).toBe(offset);
      expect(entry.tableIndex).toBe(indexLow);
      expect(entry.tableFlag).toBe(0x01);
      expect(entry.revUid).toBe(revUid);

      const p = parseCharKeyTable(loadV());
      const s = p.slots.find((x) => x.slot === slot);
      expect(s).toBeTruthy();
      expect(s.state).toBe('key');
      expect(s.flag).toBe(0x01);
      expect(s.offset).toBe(offset);
      expect(s.offset).toBe(entry.tableAddr);
      expect(s.keyId).toBe(keyId);
      expect(s.indexLow).toBe(indexLow);
      expect(s.indexLow).toBe(entry.tableIndex);

      // registry revUid == byte-reversed keyId == the bytes stored in the dump.
      const calcRev = Array.from(keyIdToRevUid(keyId))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      const rawRev = Array.from(s.raw.slice(0, 4))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      expect(calcRev).toBe(entry.revUid);
      expect(rawRev).toBe(entry.revUid);
    },
  );

  it('every paired key from the dump is represented in the registry for this VIN', () => {
    const p = parseCharKeyTable(loadV());
    const dumpKeyIds = p.slots.filter((s) => s.state === 'key').map((s) => s.keyId).sort();
    const registryKeyIds = KNOWN_WORKING_KEYS.filter((e) => e.vin === V.vin)
      .map((e) => e.keyId)
      .sort();
    expect(registryKeyIds).toEqual(dumpKeyIds);
  });

  it('records built from the registry classify as known-good only for this VIN', () => {
    for (const [keyId] of V.keys) {
      const entry = KNOWN_WORKING_KEYS.find((e) => e.keyId === keyId);
      const rec = knownKeyToRecord(entry);
      expect(classifyAgainstRegistry(rec, V.vin).status).toBe('known-good');
      // VIN-scoped: without the VIN it is not in the candidate set → unknown.
      expect(classifyAgainstRegistry(rec).status).toBe('unknown');
    }
  });

  it('per-VIN filtering: this vehicle sees the global seed + its own keys, not others', () => {
    const keys = getKnownWorkingKeys(V.vin).map((e) => e.keyId);
    expect(keys).toContain('0077A29B'); // global seed always visible
    for (const [keyId] of V.keys) expect(keys).toContain(keyId);
    // The other vehicles' VIN-scoped keys must NOT leak in.
    const otherKeys = VEHICLES.filter((o) => o.vin !== V.vin).flatMap((o) => o.keys.map((k) => k[0]));
    for (const k of otherKeys) expect(keys).not.toContain(k);
  });
});
