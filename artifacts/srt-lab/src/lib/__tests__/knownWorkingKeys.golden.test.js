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
  PENDING_ALT_FAMILY_KEYS,
  classifyAgainstRegistry,
  knownKeyToRecord,
  getKnownWorkingKeys,
  getPendingAltFamilyKeys,
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

  /* ─── Per-chip secret capture (Task #1103) ──────────────────────────────────
   * The seed fob is the one registered key with a real Autel page read attached
   * (`profile`), so it carries its OWN per-transponder secret rather than the
   * universal MIKRON default the other entries share. These cases prove the
   * captured secret is (a) re-derivable straight from the real read bytes — no
   * invented constant — and (b) actually verifiable: it round-trips as
   * known-good, while the universal default it replaced now fails as a `sk`
   * mismatch (a check the old all-identical-SK registry could never make).
   * ─────────────────────────────────────────────────────────────────────────── */
  it('the seed SK is re-derivable from its real Autel profile page read', () => {
    // page1 (KEYLOW) ∥ the high word of page2 (KEYHIGH) = the 6-byte secret.
    const derived = (SEED.profile.page1 + SEED.profile.page2.slice(0, 4)).toUpperCase();
    expect(SEED.sk).toBe(derived);
    expect(SEED.sk).toBe('502077550100');
    expect(SEED.sk).toHaveLength(12); // 6 bytes, an id46 HITAG2 crypto key
    // Provenance reflects the per-chip read, not an assumed default.
    expect(SEED.provenance).toMatch(/per-chip read confirmed/i);
  });

  it('the captured per-chip secret round-trips knownKeyToRecord → classify as known-good', () => {
    const rec = knownKeyToRecord(SEED);
    expect(rec.skHex.replace(/\s/g, '').toUpperCase()).toBe('502077550100');
    expect(classifyAgainstRegistry(rec).status).toBe('known-good');
  });

  it('a WRONG sk against the seed UID now yields mismatch (impossible pre-capture)', () => {
    // The exact secret the seed used to carry before per-chip capture — every
    // entry shared it, so it could never be told apart from the real one.
    const withOldDefault = classifyAgainstRegistry({
      chipId: SEED.chipId, uidHex: SEED.keyId, skHex: '4F4E4D494B52',
    });
    expect(withOldDefault.status).toBe('mismatch');
    expect(withOldDefault.entry.keyId).toBe('0077A29B');
    expect(withOldDefault.mismatchedFields).toContain('sk');

    // Any other wrong secret is a mismatch too (e.g. a cloned chip's secret).
    const withClone = classifyAgainstRegistry({
      chipId: SEED.chipId, uidHex: SEED.keyId, skHex: 'DEADBEEFCAFE',
    });
    expect(withClone.status).toBe('mismatch');
    expect(withClone.mismatchedFields).toContain('sk');
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

/* ============================================================================
 * PENDING alternate-family keys (flag 0x03) — VIN 2C3CDXCT1HH652640.
 *
 * These three keys are RECOGNIZED real keys of a different transponder family
 * than the 0x01 Hitag2 keys (the only keys on this 2020 6.2 Redeye, so they
 * start it), but their chip family + per-chip SK are NOT bench-confirmed. They
 * are staged in PENDING_ALT_FAMILY_KEYS — never in KNOWN_WORKING_KEYS — so this
 * golden block proves two things at once:
 *   1. The recorded bytes (UID / revUid / index / flag 0x03 / offset) match the
 *      real fixtures, exactly like the known-good blocks above.
 *   2. The honesty contract holds: chipId/sk are null, the keys never classify
 *      as known-good, and they never leak into the known-good candidate set.
 * Both the OG and PFLASH reads of this VIN must carry the identical three keys.
 * ========================================================================== */
const ALT_VIN = '2C3CDXCT1HH652640';
const ALT_FIXTURES = [
  'SAMPLE_RFHUB_EEE_OG_2C3CDXCT1HH652640.bin',
  'SAMPLE_RFHUB_PFLASH_OG_2C3CDXCT1HH652640.bin',
];
/* [keyId, slot, offset, indexLow, revUid] — all asserted vs the dump bytes. */
const ALT_KEYS = [
  ['BFA40065', 6, 0x0CAE, 0x32, '6500A4BF'],
  ['2369DA69', 7, 0x0CBE, 0x2B, '69DA6923'],
  ['1248C964', 8, 0x0CCE, 0x73, '64C94812'],
];

describe.each(ALT_FIXTURES)('knownWorkingKeys golden — PENDING alt family (%s)', (fixture) => {
  const loadAlt = () =>
    new Uint8Array(readFileSync(resolve(__dirname, '../../__tests__/fixtures/', fixture)));

  it('fixture is a canonical 4 KB RFHUB image with exactly 3 keys, all alt-family', () => {
    expect(loadAlt().length).toBe(4096);
    const p = parseCharKeyTable(loadAlt());
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(3);
    expect(p.unknownCount).toBe(0);
    // Every present key on this car is the 0x03 alternate family — no Hitag2.
    const present = p.slots.filter((s) => s.state === 'key');
    expect(present).toHaveLength(3);
    for (const s of present) {
      expect(s.keyKind).toBe('alt');
      expect(s.flag).toBe(0x03);
    }
  });

  it.each(ALT_KEYS)(
    'pending key %s sits at the recorded slot/offset/index/flag 0x03 in the dump',
    (keyId, slot, offset, indexLow, revUid) => {
      const entry = PENDING_ALT_FAMILY_KEYS.find((e) => e.keyId === keyId);
      expect(entry).toBeTruthy();
      expect(entry.vin).toBe(ALT_VIN);
      expect(entry.tableAddr).toBe(offset);
      expect(entry.tableIndex).toBe(indexLow);
      expect(entry.tableFlag).toBe(0x03);
      expect(entry.revUid).toBe(revUid);
      expect(entry.keyKind).toBe('alt');

      const p = parseCharKeyTable(loadAlt());
      const s = p.slots.find((x) => x.slot === slot);
      expect(s).toBeTruthy();
      expect(s.state).toBe('key');
      expect(s.keyKind).toBe('alt');
      expect(s.flag).toBe(0x03);
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

  it('every present key in the dump is represented in the pending table for this VIN', () => {
    const p = parseCharKeyTable(loadAlt());
    const dumpKeyIds = p.slots.filter((s) => s.state === 'key').map((s) => s.keyId).sort();
    const pendingKeyIds = PENDING_ALT_FAMILY_KEYS.filter((e) => e.vin === ALT_VIN)
      .map((e) => e.keyId)
      .sort();
    expect(pendingKeyIds).toEqual(dumpKeyIds);
  });
});

describe('knownWorkingKeys — PENDING alt family honesty contract', () => {
  it('pending entries are frozen, chip+SK unconfirmed (null), and flagged pending', () => {
    expect(Object.isFrozen(PENDING_ALT_FAMILY_KEYS)).toBe(true);
    expect(PENDING_ALT_FAMILY_KEYS).toHaveLength(3);
    for (const e of PENDING_ALT_FAMILY_KEYS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(e.chipId).toBeNull();
      expect(e.sk).toBeNull();
      expect(e.pending).toBe(true);
      expect(e.needs).toEqual(['chipId', 'sk']);
      expect(typeof e.provenance).toBe('string');
      expect(e.provenance.length).toBeGreaterThan(0);
    }
  });

  it('pending keys are NOT in KNOWN_WORKING_KEYS and do not leak into the known-good set', () => {
    const knownIds = new Set(KNOWN_WORKING_KEYS.map((e) => e.keyId));
    for (const e of PENDING_ALT_FAMILY_KEYS) expect(knownIds.has(e.keyId)).toBe(false);
    // Even scoped to the alt VIN, getKnownWorkingKeys returns only the global seed.
    const known = getKnownWorkingKeys(ALT_VIN).map((e) => e.keyId);
    for (const [keyId] of ALT_KEYS) expect(known).not.toContain(keyId);
    expect(known).toContain('0077A29B');
  });

  it('getPendingAltFamilyKeys surfaces them only for the alt VIN', () => {
    const pending = getPendingAltFamilyKeys(ALT_VIN).map((e) => e.keyId);
    for (const [keyId] of ALT_KEYS) expect(pending).toContain(keyId);
    // A different VIN / no VIN sees none (pending keys are strictly VIN-scoped).
    expect(getPendingAltFamilyKeys('2C3CDXL92KH674464')).toEqual([]);
    expect(getPendingAltFamilyKeys()).toEqual([]);
  });

  it('a pending key can never be built into a record or classified known-good', () => {
    for (const entry of PENDING_ALT_FAMILY_KEYS) {
      // null chipId → knownKeyToRecord refuses to build a record (refuse-on-doubt).
      expect(knownKeyToRecord(entry)).toBeNull();
      // Even if an operator types the real UID with the Hitag2 id46/MIKRON guess,
      // it must NOT classify as known-good — the alt UID is not a registered key.
      const guess = classifyAgainstRegistry(
        { chipId: 'id46', uidHex: entry.keyId, skHex: '4F4E4D494B52' },
        ALT_VIN,
      );
      expect(guess.status).toBe('unknown');
      expect(guess.entry).toBeNull();
    }
  });
});
