/* ============================================================================
 * charRfhubKeyTable.redeye797.test.js — golden parse test for the FIFTH distinct
 * vehicle in the corpus: a 2022 Charger Redeye 6.2 "797"
 * (VIN 2C3CDXGJXNH176487, RFHUB master secret 581391E056168F9DD17C1DF1659398A2).
 *
 * Ground truth lifted directly from the real RFHUB EEE dump
 * (SAMPLE_RFHUB_EEE_22REDEYE797_KEYS_2C3CDXGJXNH176487.bin). The dump carries
 * FOUR paired keys in slots 5..8 of its 8-slot 0xC5E Charger key table; slots
 * 1..4 are writable EMPTY templates (5A 5A 5A 5A 95 00). Every record is
 * mirror-verified and its stored index byte matches deriveCharKeyIndex.
 *
 * FLAG/UID NOTE (resolves the "anomaly" in the task):
 *   All four records carry flag 0x01 (present), yet their stored UIDs start
 *   0x62/0x64 (Key IDs end in 0x62/0x64), NOT 0x9X. This is NOT a new family:
 *   the registry already holds flag-0x01 keys with 0x64-prefixed stored UIDs
 *   for the SCAT (2C3CDXHG5EH219538) and CARTMAN (2C3CDZL95NH179529) cars.
 *   The "flag 0x01 ⇒ stored UID starts 0x9X" wording in older notes only ever
 *   described the 2019 seed car. flag 0x01 == present; the UID prefix does not
 *   change the flag. The genuinely distinct ALT family is flag 0x03 (652640).
 *
 * REGISTRY DETERMINATION: PARSE-VERIFIED-ONLY — these four keys are NOT added to
 * knownWorkingKeys.js. Unlike every currently-registered car, this dump set has
 * NO independent module that corroborates the immobilizer secret:
 *   • The file labeled "BCM_DFLASH" in the source bundle is byte-identical
 *     (sha256 deae1510…) to this RFHUB — it is a mislabeled duplicate, not a
 *     real BCM, so there is no BCM SEC16 cross-check (the basis the registered
 *     2019/SCAT/CARTMAN cars relied on).
 *   • The paired GPEC2A PCM shares only the VIN string; its PCM SEC6 does NOT
 *     equal reverse(RFHUB master)[0:6], so it does not attest the secret.
 * The master secret is therefore attested by a single physical module, and the
 * chip family + per-chip secret (SK) are not bench-confirmed. Registering would
 * mean inventing id46/MIKRON values, which breaks refuse-on-doubt. This test
 * locks that determination in: it asserts the keys parse clean AND that none of
 * them leak into the registry.
 * ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCharKeyTable,
  deriveCharKeyIndex,
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
} from '../charRfhubKeyTable.js';
import {
  KNOWN_WORKING_KEYS,
  getKnownWorkingKeys,
} from '../keyWriter/knownWorkingKeys.js';

const REF_VIN = '2C3CDXGJXNH176487';

/* [keyId, slot, offset, indexLow, revUid] — every value asserted against the
 * real bytes, so a re-extracted dump or a registry typo fails this test. */
const KEYS = [
  ['42BBBC64', 5, 0x0C9E, 0xDE, '64BCBB42'],
  ['28E13D62', 6, 0x0CAE, 0x54, '623DE128'],
  ['BF97DE64', 7, 0x0CBE, 0x63, '64DE97BF'],
  ['1783DE64', 8, 0x0CCE, 0x20, '64DE8317'],
];

const FIXTURE = resolve(
  __dirname,
  '../../__tests__/fixtures/SAMPLE_RFHUB_EEE_22REDEYE797_KEYS_2C3CDXGJXNH176487.bin',
);

function loadDump() {
  return new Uint8Array(readFileSync(FIXTURE));
}

describe('charRfhubKeyTable — 2022 Redeye 797 (real dump, parse-verified-only)', () => {
  it('fixture is a canonical 4 KB RFHUB image', () => {
    expect(loadDump().length).toBe(4096);
  });

  it('parses clean: ok, 4 keys, zero unknown', () => {
    const p = parseCharKeyTable(loadDump());
    expect(p.ok).toBe(true);
    expect(p.keyCount).toBe(4);
    expect(p.unknownCount).toBe(0);
  });

  it('slots 1..4 are writable EMPTY templates (5A5A5A5A 95 00)', () => {
    const p = parseCharKeyTable(loadDump());
    const empties = p.slots.filter((s) => s.slot <= 4);
    expect(empties.map((s) => s.state)).toEqual(['empty', 'empty', 'empty', 'empty']);
    for (const s of empties) {
      expect(Array.from(s.raw.slice(0, 6))).toEqual([0x5A, 0x5A, 0x5A, 0x5A, 0x95, 0x00]);
      expect(s.mirrorOk).toBe(true);
    }
  });

  it('the four real keys sit in slots 5..8, flag 0x01, mirror-verified', () => {
    const p = parseCharKeyTable(loadDump());
    for (const [keyId, slot, offset, indexLow] of KEYS) {
      const s = p.slots.find((x) => x.slot === slot);
      expect(s, `slot ${slot}`).toBeTruthy();
      expect(s.state).toBe('key');
      expect(s.offset).toBe(offset);
      expect(s.keyId).toBe(keyId);
      expect(s.indexLow).toBe(indexLow);
      expect(s.flag).toBe(0x01);
      expect(s.mirrorOk).toBe(true);
    }
  });

  it('every stored index byte matches the deriveCharKeyIndex checksum', () => {
    for (const [keyId, , , indexLow] of KEYS) {
      expect(deriveCharKeyIndex(keyId)).toBe(indexLow);
    }
  });

  it('stored UIDs are the byte-reverse of the Key IDs (0x62/0x64 prefix, not 0x9X)', () => {
    const p = parseCharKeyTable(loadDump());
    for (const [keyId, slot, , , revUid] of KEYS) {
      const s = p.slots.find((x) => x.slot === slot);
      const rawRev = Array.from(s.raw.slice(0, 4))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join('');
      expect(rawRev).toBe(revUid);
      // first stored byte is the LAST Key ID byte; here 0x62/0x64, not 0x9X.
      expect([0x62, 0x64]).toContain(s.raw[0]);
    }
  });

  it('slot 5 offset matches base 0xC5E + 4·stride', () => {
    expect(CHAR_KEYTABLE_BASE + 4 * CHAR_KEYTABLE_STRIDE).toBe(0x0C9E);
  });

  /* The whole point of the determination: these keys must NOT be registered. */
  it('none of the four keys are in the known-working registry', () => {
    const ids = new Set(KNOWN_WORKING_KEYS.map((e) => e.keyId));
    for (const [keyId] of KEYS) {
      expect(ids.has(keyId), `${keyId} must stay out of the registry`).toBe(false);
    }
  });

  it('no key is VIN-scoped to the Redeye (only globals resolve; parse-verified-only)', () => {
    // getKnownWorkingKeys(vin) also returns global (vin:null) keys; the
    // determination is that NOTHING is scoped to this VIN.
    const scoped = getKnownWorkingKeys(REF_VIN).filter((e) => e.vin === REF_VIN);
    expect(scoped).toEqual([]);
  });
});
