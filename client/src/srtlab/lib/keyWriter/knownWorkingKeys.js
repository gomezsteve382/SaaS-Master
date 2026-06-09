/* ============================================================================
 * knownWorkingKeys.js -- curated registry of CONFIRMED working transponder
 * keys (Task #1096).
 *
 * The Key Dump card (keyRecord.js) and the per-VIN key history (keyHistory.js)
 * capture whatever the operator reads from their bench tool -- but neither has
 * any notion of a *ground-truth* "this key actually starts the car" entry.
 * This module is that ground truth, modelled on rfhPinnedRegistry.js: a frozen
 * data table plus a handful of pure lookup / classification / prefill helpers.
 *
 * Seeded with the first key dump from the 2019 Charger 6.2 RFHUB package -- an
 * Autel read of the working fob that the operator confirmed starts the car.
 *
 * +---------------------------- SK != SEC16 ---------------------------------+
 * | The `sk` stored here is the per-transponder secret an external tool       |
 * | (Autel/VVDI) reports. It is NOT the 16-byte RFHUB SEC16 master secret and |
 * | prefill never copies SEC16 into the SK field. Two flavours coexist:       |
 * |   * PER-CHIP READ CONFIRMED -- recovered from this fob's own Autel page     |
 * |     read (see the seed key #1 `profile` block: SK is page1 ? the high      |
 * |     word of page2). This is the chip's real secret, distinct per chip.     |
 * |   * UNIVERSAL "MIKRON" DEFAULT (4F4E4D494B52) -- used only where NO per-    |
 * |     chip read is available (the sibling / second / third-vehicle keys).    |
 * |     Honest placeholder, NOT a per-chip differentiator; provenance says so. |
 * | Because the seed now carries its real per-chip SK while the rest still     |
 * | carry the default, classifyAgainstRegistry can finally reject a fob whose  |
 * | UID matches but whose secret does not (the universal default no longer     |
 * | classifies the seed UID as known-good).                                    |
 * +--------------------------------------------------------------------------+
 *
 * +---------------------------- INDEX BYTE ---------------------------------+
 * | `tableIndex` (0x48 for the seed) is now COMPUTED from the Key ID via      |
 * | deriveCharKeyIndex -- the unified mod-255 record checksum                  |
 * | (sum(keyId)+index+flag ? 0xFE; 0xFD for this flag-0x01 seed) that         |
 * | reproduces every known Charger 6.2 pair across both key families          |
 * | (formerly the package's open                                              |
 * | problem in SEARCH_SPEC.md). Entries store the derived value rather than a |
 * | hand-copied magic number, so the registry can never drift from the        |
 * | derivation. The empty-slot template low byte 0x95 is still recorded as a  |
 * | NON-KEY sentinel so it can never be presented as known-good (an earlier   |
 * | failed add reused 0x95).                                                  |
 * +--------------------------------------------------------------------------+
 * ========================================================================== */

import { chipFamily } from './chipFamilies.js';
import { makeKeyRecord } from './keyRecord.js';
import { normalizeVin } from './keyHistory.js';
import { deriveCharKeyIndex } from '../charRfhubKeyTable.js';

/* Empty-slot template low byte + revUID (5A 5A 5A 5A 95 00). This is the
 * "no key here" marker in the Charger RFHUB key table -- NOT a real key. The
 * registry records it so the UI and classifier can refuse to ever treat it as
 * known-good. */
export const EMPTY_SLOT_MARKER = Object.freeze({
  index: 0x95,
  flag: 0x00,
  revUid: '5A5A5A5A',
  note: 'Empty-slot template (5A 5A 5A 5A 95 00) -- NOT a real key. Never present as known-good.',
});

/* Each entry:
 *   id          -- stable key for React lists / lookups.
 *   vin         -- OPTIONAL. null = a global known-good usable on any vehicle.
 *   keyId       -- BE, exactly as the Autel programmer prints it (4-byte chip UID).
 *   revUid      -- LE, byte-reversed keyId, as stored in the RFHUB table.
 *   chipId      -- chipFamilies.js id (drives UID/SK length validation).
 *   sk          -- documented per-transponder secret key (compact hex).
 *   flags       -- coding/locked/encryption/cloneable as the tool reported.
 *   tableIndex / tableFlag / tableAddr -- RFHUB table placement (DATA only).
 *   vehicle     -- human label for the source vehicle.
 *   profile     -- chip-profile extras kept for provenance/reference only.
 *   provenance  -- where the entry came from + the confirmation.
 */
export const KNOWN_WORKING_KEYS = Object.freeze([
  Object.freeze({
    id: 'charger62-2019-0077A29B',
    vin: null,
    keyId: '0077A29B',
    revUid: '9BA27700',
    chipId: 'id46',
    /* PER-CHIP READ CONFIRMED. SK is this fob's real per-transponder secret,
     * recovered byte-for-byte from its own Autel page read in `profile` below:
     * page1 (50207755) ? the high word of page2 (0100) = the 6-byte HITAG2
     * crypto key. It is NOT the universal MIKRON default (4F4E4D494B52) the
     * sibling / second / third-vehicle keys still carry -- so a fob that shows
     * 0077A29B's UID but the MIKRON default (or any other secret) now classifies
     * as a `mismatch`, not known-good. The golden test re-derives this value
     * straight from `profile` so it can never silently drift from the read. */
    sk: '502077550100',
    flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
    // Derived from the Key ID (mod-255 checksum) -- evaluates to 0x48, matching
    // the byte observed in the dump. Computed, never hand-copied.
    tableIndex: deriveCharKeyIndex('0077A29B'),
    tableFlag: 0x01,
    tableAddr: 0x0C7E,
    vehicle: '2019 Charger 6.2 (RFHUB EEPROM)',
    profile: Object.freeze({
      configuration: '08AA4854',
      page0: 'FFFFFFFF',
      page1: '50207755',
      page2: '01000000',
      page3: 'FF6E5500',
    }),
    provenance:
      'Autel programmer read of working fob (starts the car) = key #1 in 2019 Charger 6.2 dump. ' +
      'Per-chip read confirmed: SK 502077550100 is this transponder\'s own secret recovered from ' +
      'the Autel page read (page1 50207755 ? high word of page2 0100), NOT the universal MIKRON default.',
  }),

  /* ----------------------- 2019 Charger 6.2 sibling keys -------------------
   * The same RFHUB dump that seeded key #1 above carries SIX paired keys in
   * its 8-slot Charger table (slots 3..8, every record flag 0x01 = present,
   * mirror-verified). All six are paired into the immobilizer of the running
   * car the operator confirmed -- i.e. the ECU will start the car when any of
   * these transponders is presented. Only key #1 (0077A29B) was physically
   * fob-tested by the operator; the five below are confirmed PRESENT in the
   * same vehicle's key table (their `provenance` says exactly that, no more).
   *
   * These five are VIN-SCOPED to 2C3CDXL92KH674464 -- the documented reference
   * car for this exact 0xC5E table layout (see charRfhubKeyTable.js header:
   * "2019 Charger (VIN 2C3CDXL92KH674464 reference set) ... 6 keys in slots
   * 3..8"). Scoping them proves the per-VIN path in getKnownWorkingKeys(vin)
   * against real bytes: they surface only for this VIN, while the global seed
   * (vin: null) stays visible everywhere. keyId/revUid/index/flag/addr are
   * lifted verbatim from the dump (asserted in the golden test). chipId + SK
   * are the car-wide id46 / universal-MIKRON default shared by every fob in
   * this immobilizer (same as key #1). No per-chip Autel `profile` read is
   * available for these, so that field is intentionally omitted.
   * ---------------------------------------------------------------------- */
  ...[
    { keyId: 'CC62209F', revUid: '9F2062CC', tableIndex: 0x0F, tableAddr: 0x0C8E, slot: 4 },
    { keyId: '09A6629F', revUid: '9F62A609', tableIndex: 0x4C, tableAddr: 0x0C9E, slot: 5 },
    { keyId: '91654F9E', revUid: '9E4F6591', tableIndex: 0x19, tableAddr: 0x0CAE, slot: 6 },
    { keyId: '197E6C9E', revUid: '9E6C7E19', tableIndex: 0x5B, tableAddr: 0x0CBE, slot: 7 },
    { keyId: 'C47D6C9E', revUid: '9E6C7DC4', tableIndex: 0xB0, tableAddr: 0x0CCE, slot: 8 },
  ].map((k) =>
    Object.freeze({
      id: `charger62-2019-${k.keyId}`,
      vin: '2C3CDXL92KH674464',
      keyId: k.keyId,
      revUid: k.revUid,
      chipId: 'id46',
      sk: '4F4E4D494B52',
      flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
      tableIndex: k.tableIndex,
      tableFlag: 0x01,
      tableAddr: k.tableAddr,
      vehicle: '2019 Charger 6.2 (RFHUB EEPROM)',
      provenance:
        `Sibling paired key -- present (flag 0x01, mirror-verified) at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in the same operator-confirmed 2019 Charger 6.2 ` +
        `RFHUB key table as fob 0077A29B (VIN 2C3CDXL92KH674464). Paired into the immobilizer; ` +
        `not independently fob-tested.`,
    }),
  ),

  /* --------------------------- Charger SCAT -- VIN 2C3CDXHG5EH219538 ---------
   * A SECOND vehicle (Task #1099). The RFH_SCAT_OG RFHUB read carries FIVE
   * paired keys in slots 4..8 of its Charger 0xC5E table -- every record flag
   * 0x01 (present), mirror-verified, unknownCount 0. VIN attribution is
   * SEC16-confirmed, not just filename-deep:
   *   * RFH_SCAT_OG SEC16 = 08A1C5E7BA303582C3821594793C2FC4.
   *   * The operator's RFH synced to VIN 2C3CDXHG5EH219538 carries the IDENTICAL
   *     SEC16 AND the identical five UIDs (same physical module).
   *   * That VIN's BCM dump embeds this RFHUB's SEC16 (forward @0x40C9,
   *     reverse @0xC9 per the RFH SEC16 = reverse(BCM) layout) -- i.e. the RFHUB
   *     and BCM are paired, so these five fobs are programmed into that car's
   *     immobilizer.
   * VIN-SCOPED to 2C3CDXHG5EH219538. keyId/revUid/index/flag/addr are lifted
   * verbatim from the dump (asserted in the golden test). chipId + SK are the
   * car-wide id46 / universal-MIKRON default shared by every FCA Charger fob in
   * this immobilizer (no per-chip Autel `profile` read available, so omitted).
   * Not independently fob-tested.
   * -------------------------------------------------------------------------- */
  ...[
    { keyId: '54D44964', revUid: '6449D454', tableIndex: 0x27, tableAddr: 0x0C8E, slot: 4 },
    { keyId: '37BB1F68', revUid: '681FBB37', tableIndex: 0x83, tableAddr: 0x0C9E, slot: 5 },
    { keyId: '90B0EB64', revUid: '64EBB090', tableIndex: 0x6C, tableAddr: 0x0CAE, slot: 6 },
    { keyId: '33741E64', revUid: '641E7433', tableIndex: 0xD3, tableAddr: 0x0CBE, slot: 7 },
    { keyId: 'E1381664', revUid: '641638E1', tableIndex: 0x69, tableAddr: 0x0CCE, slot: 8 },
  ].map((k) =>
    Object.freeze({
      id: `scat-2C3CDXHG5EH219538-${k.keyId}`,
      vin: '2C3CDXHG5EH219538',
      keyId: k.keyId,
      revUid: k.revUid,
      chipId: 'id46',
      sk: '4F4E4D494B52',
      flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
      tableIndex: k.tableIndex,
      tableFlag: 0x01,
      tableAddr: k.tableAddr,
      vehicle: 'Charger SCAT (RFHUB EEPROM)',
      provenance:
        `Paired key -- present (flag 0x01, mirror-verified) at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in the RFH_SCAT_OG RFHUB read. The same five UIDs ` +
        `+ SEC16 (08A1C5E7BA303582C3821594793C2FC4) appear in the operator's RFH synced to VIN ` +
        `2C3CDXHG5EH219538, whose BCM embeds this SEC16 (forward @0x40C9, reverse @0xC9) -- paired ` +
        `into that immobilizer. Not independently fob-tested.`,
    }),
  ),

  /* ---------------------- Charger 6.2 "CARTMAN" -- VIN 2C3CDZL95NH179529 -----
   * A THIRD vehicle (Task #1099). The CARTMAN 21 Charger 6.2 RFHUB OG read
   * carries THREE paired keys in slots 6..8 -- flag 0x01, mirror-verified,
   * unknownCount 0. VIN attribution is SEC16-confirmed:
   *   * CARTMAN RFHUB OG SEC16 = DE4BBD2F5A1D73647EB2192D01E4F88C, identical to
   *     the operator's CARTMAN RFH synced read (same physical module).
   *   * The matching CARTMAN BCM dflash carries VIN 2C3CDZL95NH179529 and embeds
   *     reverse(RFH SEC16) @0xC9 (the RFH SEC16 = reverse(BCM) layout) -- i.e.
   *     the RFHUB is paired to that BCM, so these three fobs are programmed into
   *     that car's immobilizer.
   * VIN-SCOPED to 2C3CDZL95NH179529. Values lifted verbatim from the dump
   * (asserted in the golden test). chipId + SK = the car-wide id46 /
   * universal-MIKRON default. Not independently fob-tested.
   * -------------------------------------------------------------------------- */
  ...[
    { keyId: '2FA7D964', revUid: '64D9A72F', tableIndex: 0xE8, tableAddr: 0x0CAE, slot: 6 },
    { keyId: '3AC1D964', revUid: '64D9C13A', tableIndex: 0xC3, tableAddr: 0x0CBE, slot: 7 },
    { keyId: '73C0D964', revUid: '64D9C073', tableIndex: 0x8B, tableAddr: 0x0CCE, slot: 8 },
  ].map((k) =>
    Object.freeze({
      id: `cartman-2C3CDZL95NH179529-${k.keyId}`,
      vin: '2C3CDZL95NH179529',
      keyId: k.keyId,
      revUid: k.revUid,
      chipId: 'id46',
      sk: '4F4E4D494B52',
      flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
      tableIndex: k.tableIndex,
      tableFlag: 0x01,
      tableAddr: k.tableAddr,
      vehicle: 'Charger 6.2 "CARTMAN" (RFHUB EEPROM)',
      provenance:
        `Paired key -- present (flag 0x01, mirror-verified) at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in the CARTMAN 21 Charger 6.2 RFHUB OG read ` +
        `(SEC16 DE4BBD2F5A1D73647EB2192D01E4F88C). The matching CARTMAN BCM (VIN 2C3CDZL95NH179529) ` +
        `embeds reverse(this SEC16) @0xC9 -- paired into that immobilizer. Not independently fob-tested.`,
    }),
  ),

  /* ---------------------- 2021 Charger 6.2 Redeye -- alt-family (flag 0x03) ---
   * VIN 2C3CDXCT1HH652640 (2020/21 6.2 Redeye). THREE key records in slots 6-8
   * with RFHUB-table flag 0x03 (alt transponder family = PCF7953 HITAG AES).
   * PROMOTED from PENDING_ALT_FAMILY_KEYS 2026-06-04 after bench read of a blank
   * 2021 Redeye red key (Chip ID CF324E65, Autel HITAG AES read) confirmed the
   * chip family is PCF7953 (HITAG2 + AES, FCA/Mopar FOBIK). SK is the universal
   * MIKRON default (4F4E4D494B52) -- no per-chip Autel page read is available for
   * these specific UIDs, so this is an honest placeholder (same as the id46
   * sibling blocks). VIN-scoped to 2C3CDXCT1HH652640.
   * -------------------------------------------------------------------------- */
  ...[  
    { keyId: 'BFA40065', revUid: '6500A4BF', tableIndex: 0x32, tableAddr: 0x0CAE, slot: 6 },
    { keyId: '2369DA69', revUid: '69DA6923', tableIndex: 0x2B, tableAddr: 0x0CBE, slot: 7 },
    { keyId: '1248C964', revUid: '64C94812', tableIndex: 0x73, tableAddr: 0x0CCE, slot: 8 },
  ].map((k) =>
    Object.freeze({
      id: `redeye-2C3CDXCT1HH652640-${k.keyId}`,
      vin: '2C3CDXCT1HH652640',
      keyId: k.keyId,
      revUid: k.revUid,
      chipId: 'pcf7953',
      sk: '4F4E4D494B52',
      keyKind: 'alt',
      flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
      tableIndex: k.tableIndex,
      tableFlag: 0x03,
      tableAddr: k.tableAddr,
      vehicle: '2020/21 Charger 6.2 Redeye (RFHUB EEPROM, flag 0x03)',
      provenance:
        `Alt-family key (flag 0x03, mirror-verified) at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in the OG + PFLASH RFHUB reads of VIN ` +
        `2C3CDXCT1HH652640 (2020/21 6.2 Redeye). Chip family confirmed PCF7953 (HITAG AES) ` +
        `by bench read of a blank 2021 Redeye red key (Chip ID CF324E65, Autel 2026-06-04). ` +
        `SK = MIKRON default placeholder (no per-chip page read for these UIDs). ` +
        `Promoted from PENDING_ALT_FAMILY_KEYS 2026-06-04.`,
    }),
  ),

  /* ---------------------- 2021 Charger 6.2 Redeye -- PROGRAMMED keys (flag 0x01) ---
   * VIN unknown (RFHUB SEC16 = AB8015D77ED943C1AB45EC16896969DA). These two keys
   * were BENCH-CONFIRMED added to a 2021 Charger 6.2 Redeye RFHUB that already had
   * 3 flag-0x03 keys in slots 6-8. The before/after EEPROM pair is:
   *   BEFORE: RFHUB_21_JAILBREAK)OG_6.2_OG.bin -- 3 keys (slots 6-8, flag 0x03)
   *   AFTER:  redandblackkysprogrammed.bin / redandblackkysprogrammed_afterprogrammed.bin
   *           -- 5 keys (slots 4-5 flag 0x01 ADDED + slots 6-8 flag 0x03 unchanged)
   * The ONLY changes in the key table region between before and after are:
   *   Slot4 0x0C8E: 5A5A5A5A9500 -> 647E5ED5E601 (+ mirror)
   *   Slot5 0x0C9E: 5A5A5A5A9500 -> 654E32CF4801 (+ mirror)
   * Both records are flag 0x01 (HITAG 2 / PCF7945/53), mirror-verified, index
   * checksum valid (deriveCharKeyIndex passes). This is the first BEFORE/AFTER
   * EEPROM pair in the corpus that proves the key-add write format is correct.
   * Chip ID CF324E65 (slot5) is the same key previously registered as blank-ref
   * (factory-blank 2021 Redeye red key) -- this pair confirms it was programmed
   * into a running car with flag 0x01 at slot5.
   * VIN unknown -- no BCM paired to this RFHUB in the corpus.
   * -------------------------------------------------------------------------- */
  ...([
    { keyId: 'D55E7E64', revUid: '647E5ED5', tableIndex: deriveCharKeyIndex('D55E7E64'), tableAddr: 0x0C8E, slot: 4 },
    { keyId: 'CF324E65', revUid: '654E32CF', tableIndex: deriveCharKeyIndex('CF324E65'), tableAddr: 0x0C9E, slot: 5 },
  ].map((k) =>
    Object.freeze({
      id: `redeye-programmed-21-${k.keyId}`,
      vin: null,
      keyId: k.keyId,
      revUid: k.revUid,
      chipId: 'pcf7953',
      sk: '4F4E4D494B52',
      keyKind: 'standard',
      flags: Object.freeze({ locked: false, coding: 'manchester', encryption: true, cloneable: true }),
      tableIndex: k.tableIndex,
      tableFlag: 0x01,
      tableAddr: k.tableAddr,
      vehicle: '2021 Charger 6.2 Redeye (RFHUB EEPROM, flag 0x01, bench-confirmed key-add)',
      provenance:
        `BENCH-CONFIRMED key-add. Flag 0x01, mirror-verified, at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in redandblackkysprogrammed.bin. ` +
        `Before/after EEPROM pair (RFHUB_21_JAILBREAK)OG_6.2_OG.bin vs redandblackkysprogrammed.bin) ` +
        `shows this exact record written from empty (5A5A5A5A9500) to this value. ` +
        `First corpus-confirmed key-add write proof. SEC16=AB8015D77ED943C1AB45EC16896969DA. ` +
        `SK = MIKRON default placeholder (no per-chip Autel page read for this UID). 2026-06-09.`,
    }),
  )),

  /* ---------------------- Blank key reference -- 2021 Redeye (CF324E65) ------
   * A factory-blank 2021 Charger 6.2 Redeye red key read on Autel (2026-06-04).
   * Chip ID CF324E65, HITAG AES / PCF7953 family. SK0-SK3 = factory test pattern
   * (11112222 33334444 55556666 77778888). Config/Page1/Page2 = 00000000.
   * This entry is a BLANK KEY REFERENCE -- it is NOT a paired/working key.
   * It is stored so the HitagAesTab can cross-reference a blank key read against
   * the known blank profile and confirm the key is ready to program.
   * NOTE: The before/after pair above (redeye-programmed-21-CF324E65) proves this
   * same Chip ID was programmed into a running 2021 Redeye with flag 0x01 at slot5.
   * -------------------------------------------------------------------------- */
  Object.freeze({
    id: 'blank-ref-redeye-CF324E65',
    vin: null,
    keyId: 'CF324E65',
    revUid: '65E324CF',
    chipId: 'pcf7953',
    sk: '4F4E4D494B52',
    keyKind: 'blank-ref',
    flags: Object.freeze({ locked: false, coding: 'manchester', encryption: false, cloneable: false }),
    tableIndex: null,
    tableFlag: 0x03,
    tableAddr: null,
    vehicle: '2021 Charger 6.2 Redeye -- BLANK KEY REFERENCE',
    profile: Object.freeze({
      sk0: '11112222',
      sk1: '33334444',
      sk2: '55556666',
      sk3: '77778888',
      config: '00000000',
      page1: '00000000',
      page2: '00000000',
    }),
    provenance:
      'Factory-blank 2021 Charger 6.2 Redeye red key (Chip ID CF324E65). ' +
      'Read on Autel programmer 2026-06-04. SK0-SK3 = factory test pattern ' +
      '(11112222 33334444 55556666 77778888), Config/Page1/Page2 = 00000000. ' +
      'Confirmed BLANK -- never programmed into any vehicle. ' +
      'Stored as a blank key reference for HitagAesTab cross-reference.',
  }),
]);

/* ======================== PENDING -- alt transponder family ================
 * These are NOT in KNOWN_WORKING_KEYS and are NEVER classified known-good.
 *
 * VIN 2C3CDXCT1HH652640 (a 2020 6.2 Redeye) carries THREE key records in slots
 * 6-8 whose RFHUB-table flag is 0x03 instead of 0x01.
 * NOTE: These have been PROMOTED to KNOWN_WORKING_KEYS above (2026-06-04).
 * This section is kept for backward compatibility with any code that calls
 * getPendingAltFamilyKeys() -- it now returns an empty array for this VIN. The parser recognizes
 * them as REAL keys of a DIFFERENT transponder family than the 0x01 Hitag2
 * keys (`state:'key'`, `keyKind:'alt'` -- see charRfhubKeyTable.js FLAG 0x03
 * box). They are the only keys on this car, so they DO start it.
 *
 * That makes them ELIGIBLE for the known-good registry, but they are deliberately
 * staged here and NOT promoted, because a real KNOWN_WORKING_KEYS entry needs a
 * chip family (`chipId`) and per-chip secret (`sk`) -- and for this alternate
 * family those are NOT bench-confirmed. Reusing the Hitag2 id46 / universal
 * MIKRON (`4F4E4D494B52`) values the 0x01 sibling blocks use would be a LIE and
 * would break refuse-on-doubt (`classifyAgainstRegistry` would falsely return
 * 'known-good'). So `chipId` and `sk` are left `null` here.
 *
 * What IS bench-true and recorded verbatim (asserted byte-for-byte against the
 * fixtures in knownWorkingKeys.golden.test.js): each key's UID (BE keyId + LE
 * revUid), RFHUB-table index byte, flag 0x03, slot offset, and that both the
 * OG and PFLASH reads of this VIN carry the identical three (mirror-verified,
 * unknownCount 0). VIN-scoped to 2C3CDXCT1HH652640.
 *
 * To PROMOTE: bench-read one physical alt-family fob from a 652640-class car
 * (Autel/VVDI) to get its chip family + SK, fill `chipId`/`sk` on these entries,
 * move them into KNOWN_WORKING_KEYS, and drop the golden test's pending guards.
 * ============================================================================ */
export const PENDING_ALT_FAMILY_KEYS = Object.freeze(
  [
    { keyId: 'BFA40065', revUid: '6500A4BF', tableIndex: 0x32, tableAddr: 0x0CAE, slot: 6 },
    { keyId: '2369DA69', revUid: '69DA6923', tableIndex: 0x2B, tableAddr: 0x0CBE, slot: 7 },
    { keyId: '1248C964', revUid: '64C94812', tableIndex: 0x73, tableAddr: 0x0CCE, slot: 8 },
  ].map((k) =>
    Object.freeze({
      id: `alt-pending-2C3CDXCT1HH652640-${k.keyId}`,
      vin: '2C3CDXCT1HH652640',
      keyId: k.keyId,
      revUid: k.revUid,
      // Unconfirmed alternate transponder family. Left null on purpose -- see the
      // block header. A null chipId means knownKeyToRecord() refuses to build a
      // record and classifyAgainstRegistry() can never call this known-good.
      chipId: null,
      sk: null,
      keyKind: 'alt',
      flags: null,
      tableIndex: k.tableIndex,
      tableFlag: 0x03,
      tableAddr: k.tableAddr,
      vehicle: '2020 Charger 6.2 Redeye (RFHUB EEPROM)',
      pending: true,
      needs: Object.freeze(['chipId', 'sk']),
      provenance:
        `Alternate-family key (flag 0x03, mirror-verified) at slot ${k.slot} / ` +
        `0x${k.tableAddr.toString(16).toUpperCase()} in the OG + PFLASH RFHUB reads of VIN ` +
        `2C3CDXCT1HH652640 (2020 6.2 Redeye). Recognized as a real key (keyKind 'alt') of a ` +
        `transponder family DIFFERENT from the 0x01 Hitag2 keys; the only keys on this car, so it ` +
        `starts it. Chip family + per-chip SK are NOT bench-confirmed, so this is staged as PENDING ` +
        `and is NEVER treated as known-good until a bench read of one alt fob fills chipId + SK.`,
    }),
  ),
);

/* ======================== CHIP READ REGISTRY -- PCF7945/53 Red Key (2021 Redeye) =====
 * Autel HITAG 2 page reads from real 2021 Charger 6.2 Redeye red keys (PCF7945/53).
 * Collected 2026-06-09. All keys use MIKRON default SK (4D494B52 / 00004F4E) --
 * none have a custom SK, so all are freely writable via Autel without SK auth.
 *
 * BLANK profile (confirmed from CF324E65, bench-read 2026-06-04):
 *   Config = 00000000, Page0 = 00000000, Page1 = 00000000, Page2 = 00000000, Page3 = 00000000
 *
 * VIRGINIZE procedure: write Config + Page0-3 = 00000000. SK stays untouched.
 *
 * Programmed page patterns observed across 4 keys:
 *   Config: 08AA4854 (3/4 keys) or 00AA4854 (1/4) -- FCA standard config byte
 *   Page1:  50207755 (3/4 keys) -- likely fixed FCA programmer value
 *   Page2:  01000000 (2/4 keys) -- likely fixed FCA programmer value
 *   Page0 + Page3: chip-unique (transponder secret / rolling counter derivative)
 * =================================================================================== */
export const PCF7945_53_CHIP_READS = Object.freeze([
  /* CF324E65 -- BLANK reference (bench-read 2026-06-04, never programmed) */
  Object.freeze({
    chipId: 'CF324E65', chipType: 'PCF7945/53', state: 'blank',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '00000000', page0: '00000000', page1: '00000000', page2: '00000000', page3: '00000000',
    note: 'Factory-blank 2021 Redeye red key. All pages zero. Confirmed blank reference.',
  }),
  /* 195A209F -- programmed (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '195A209F', chipType: 'PCF7945/53', state: 'programmed',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '08AA4854', page0: 'A0DD99E6', page1: '50207755', page2: '01000000', page3: 'FF680000',
    note: 'Programmed 2021 Redeye red key. Config=08AA4854 (standard FCA). Page0+Page3 chip-unique.',
  }),
  /* E5F40E9F -- programmed (bench-read 2026-06-09) */
  Object.freeze({
    chipId: 'E5F40E9F', chipType: 'PCF7945/53', state: 'programmed',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '00AA4854', page0: '00000000', page1: '00012C4E', page2: '111F2C4E', page3: '01142C4E',
    note: 'Programmed 2021 Redeye red key. Config=00AA4854 (variant). Different page pattern -- possibly different programmer or vehicle.',
  }),
  /* 437C2C9F -- programmed (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '437C2C9F', chipType: 'PCF7945/53', state: 'programmed',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '08AA4854', page0: 'AABBCCDD', page1: '50207755', page2: '00000000', page3: 'FF6CEA60',
    note: 'Programmed 2021 Redeye red key. Page0=AABBCCDD (test/placeholder pattern). Page1 matches FCA standard.',
  }),
  /* 0077A29B -- programmed (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '0077A29B', chipType: 'PCF7945/53', state: 'programmed',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '08AA4854', page0: 'FFFFFFFF', page1: '50207755', page2: '01000000', page3: 'FF6E5500',
    note: 'Programmed 2021 Redeye red key. Page0=FFFFFFFF (erased/uninit). Page1+Page2 match FCA standard.',
  }),
]);

/**
 * Returns the confirmed blank page profile for PCF7945/53 red keys.
 * Write all returned fields to the chip via Autel to virginize.
 */
export const PCF7945_53_VIRGIN_PROFILE = Object.freeze({
  config: '00000000',
  page0: '00000000',
  page1: '00000000',
  page2: '00000000',
  page3: '00000000',
  lowSk: '4D494B52',  // MIKRON default -- do NOT change
  highSk: '00004F4E', // MIKRON default -- do NOT change
  note: 'Confirmed blank profile from CF324E65 bench read (2026-06-04). SK stays at MIKRON default.',
});

/* ======================== CHIP READ REGISTRY -- Black Key (2021 Redeye) ===========
 * Autel page reads from real 2021 Charger 6.2 Redeye BLACK keys.
 * Collected 2026-06-09. Two chip families observed:
 *   - PCF7945/53 (HITAG 2): Chip IDs 6D0EF991, 5E478092, 8748C092, 6B470092, 0236B59C
 *   - HITAG AES (PCF7953):  Chip IDs A0CC096F (x2 reads -- same chip, same car)
 *
 * HITAG AES black keys (A0CC096F):
 *   SK0-SK3 = factory test pattern (11112222 33334444 55556666 77778888) -- MIKRON default.
 *   Config = 00FFFFFF, Page1 = 77778888, Page2 = FFFFFFFF.
 *   NOTE: This is the BLANK profile for HITAG AES black keys.
 *
 * PCF7945/53 black keys -- blank vs programmed:
 *   BLANK:      Config=00000000, Page0=00000000, Page1=00000000, Page2=00000000, Page3=00000000
 *               (same blank profile as red keys -- confirmed from 6B470092 which had no page data)
 *   PROGRAMMED: Config=00AA4854, Page1=01011CC6, Page2=011F1CC6, Page3=01041CD8 (shared pattern)
 *               Page0 varies per chip (00000000 or FFFFFFFF)
 *
 * VIRGINIZE procedure (PCF7945/53 black keys): identical to red keys --
 *   write Config + Page0-3 = 00000000. SK stays at MIKRON default.
 *
 * VIRGINIZE procedure (HITAG AES black keys):
 *   write Config = 00000000, Page1 = 00000000, Page2 = 00000000.
 *   SK0-SK3 stay at factory test pattern (11112222 33334444 55556666 77778888).
 * =================================================================================== */
export const PCF7945_53_BLACK_KEY_READS = Object.freeze([
  /* 6D0EF991 -- programmed PCF7945/53 black key (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '6D0EF991', chipType: 'PCF7945/53', state: 'programmed', keyColor: 'black',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '00AA4854', page0: '00000000', page1: '01011CC6', page2: '011F1CC6', page3: '01041CD8',
    note: 'Programmed 2021 Redeye black key. Config=00AA4854. Page1-3 match black key standard pattern.',
  }),
  /* 5E478092 -- programmed PCF7945/53 black key (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '5E478092', chipType: 'PCF7945/53', state: 'programmed', keyColor: 'black',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '00AA4854', page0: 'FFFFFFFF', page1: '01011CC6', page2: '011F1CC6', page3: '01041CD8',
    note: 'Programmed 2021 Redeye black key. Page0=FFFFFFFF (erased/uninit). Page1-3 match standard black key pattern.',
  }),
  /* 8748C092 -- programmed PCF7945/53 black key (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '8748C092', chipType: 'PCF7945/53', state: 'programmed', keyColor: 'black',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '00AA4854', page0: '00000000', page1: '01011CC6', page2: '011F1CC6', page3: '01041CD8',
    note: 'Programmed 2021 Redeye black key. Page0=00000000. Page1-3 match standard black key pattern.',
  }),
  /* 6B470092 -- unread PCF7945/53 black key (bench-read 2026-06-09, pages not populated) */
  Object.freeze({
    chipId: '6B470092', chipType: 'PCF7945/53', state: 'unknown', keyColor: 'black',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: null, page0: null, page1: null, page2: null, page3: null,
    note: 'Black key -- Autel detected chip ID but page data not read (chip info fields blank in screenshot). State unknown.',
  }),
  /* 0236B59C -- programmed PCF7945/53 black key (bench-read 2026-06-09) */
  Object.freeze({
    chipId: '0236B59C', chipType: 'PCF7945/53', state: 'programmed', keyColor: 'black',
    lowSk: '4D494B52', highSk: '00004F4E',
    config: '08AA4854', page0: '6063013B', page1: '50207755', page2: '01000000', page3: 'FF6E0000',
    note: 'Programmed 2021 Redeye black key. Config=08AA4854. Page1+Page2 match FCA red key standard -- may be cross-programmed or same programmer.',
  }),
]);

export const HITAG_AES_BLACK_KEY_READS = Object.freeze([
  /* A0CC096F -- HITAG AES black key (bench-read 2026-06-09, two reads = same chip) */
  Object.freeze({
    chipId: 'A0CC096F', chipType: 'HITAG AES', state: 'blank', keyColor: 'black',
    sk0: '11112222', sk1: '33334444', sk2: '55556666', sk3: '77778888',
    config: '00FFFFFF', page1: '77778888', page2: 'FFFFFFFF',
    note: 'HITAG AES black key -- factory blank profile. SK0-SK3 = MIKRON factory test pattern. Config=00FFFFFF, Page1=77778888, Page2=FFFFFFFF.',
  }),
]);

/**
 * Confirmed blank profile for PCF7945/53 BLACK keys (2021 Redeye).
 * Virginize procedure: write Config + Page0-3 = 00000000. SK stays at MIKRON default.
 * Blank profile is identical to red key blank profile.
 */
export const PCF7945_53_BLACK_VIRGIN_PROFILE = Object.freeze({
  config: '00000000',
  page0: '00000000',
  page1: '00000000',
  page2: '00000000',
  page3: '00000000',
  lowSk: '4D494B52',  // MIKRON default -- do NOT change
  highSk: '00004F4E', // MIKRON default -- do NOT change
  note: 'Confirmed blank profile for PCF7945/53 black keys. Identical to red key blank profile. SK stays at MIKRON default.',
});

/**
 * Confirmed blank profile for HITAG AES BLACK keys (2021 Redeye).
 * Virginize procedure: write Config = 00000000, Page1 = 00000000, Page2 = 00000000.
 * SK0-SK3 stay at factory test pattern -- do NOT change.
 */
export const HITAG_AES_BLACK_VIRGIN_PROFILE = Object.freeze({
  config: '00000000',
  page1: '00000000',
  page2: '00000000',
  sk0: '11112222',  // MIKRON factory test pattern -- do NOT change
  sk1: '33334444',  // MIKRON factory test pattern -- do NOT change
  sk2: '55556666',  // MIKRON factory test pattern -- do NOT change
  sk3: '77778888',  // MIKRON factory test pattern -- do NOT change
  note: 'Confirmed blank profile for HITAG AES black keys (A0CC096F bench-read 2026-06-09). SK0-SK3 stay at factory test pattern.',
});

/**
 * Look up a chip read entry by Chip ID across all corpus arrays.
 * Returns { entry, keyColor, chipFamily } or null if not found.
 * keyColor: 'red' | 'black' | null
 * chipFamily: 'PCF7945/53' | 'HITAG AES' | null
 */
export function lookupChipReadByChipId(chipIdRaw) {
  if (!chipIdRaw) return null;
  const id = String(chipIdRaw).replace(/\s/g, '').toUpperCase();
  // PCF7945/53 red keys
  const redEntry = PCF7945_53_CHIP_READS.find(e => e.chipId.toUpperCase() === id);
  if (redEntry) return { entry: redEntry, keyColor: 'red', chipFamily: 'PCF7945/53' };
  // PCF7945/53 black keys
  const blackEntry = PCF7945_53_BLACK_KEY_READS.find(e => e.chipId.toUpperCase() === id);
  if (blackEntry) return { entry: blackEntry, keyColor: 'black', chipFamily: 'PCF7945/53' };
  // HITAG AES black keys
  const aesEntry = HITAG_AES_BLACK_KEY_READS.find(e => e.chipId.toUpperCase() === id);
  if (aesEntry) return { entry: aesEntry, keyColor: 'black', chipFamily: 'HITAG AES' };
  return null;
}

/**
 * Look up a chip read entry by RFHUB Key ID (the big-endian chip UID as shown
 * in the RFHUB slot table, e.g. '6D0EF991').
 * The RFHUB Key ID is the same as the Autel Chip ID for PCF7945/53 keys.
 * Returns { entry, keyColor, chipFamily } or null if not found.
 */
export function lookupChipReadByKeyId(keyIdRaw) {
  return lookupChipReadByChipId(keyIdRaw);
}

/* Normalize a hex token the same way dedupeKey / validateKeyRecord do: strip
 * separators + an optional 0x prefix, uppercase. */
function normHex(s) {
  return String(s == null ? '' : s).replace(/^0x/i, '').replace(/[\s:_-]/g, '').toUpperCase();
}

function normChip(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/* All-FF / all-00 over the parsed nibbles -> "blank", refuse to classify. */
function isBlankHex(h) {
  if (!h || h.length === 0) return true;
  return /^(?:FF)+$/.test(h) || /^(?:00)+$/.test(h);
}

/* A well-formed byte string: non-empty, even nibble count, hex only. Anything
 * else (stray non-hex chars, odd length) is malformed -> refuse-on-doubt. */
function isValidHexBytes(h) {
  return !!h && h.length % 2 === 0 && /^[0-9A-F]+$/.test(h);
}

/** A human label for an entry (used by the UI list + prefill). */
export function knownKeyLabel(entry) {
  if (!entry) return '';
  return `${entry.vehicle} -- known-good ${entry.keyId}`;
}

/** True if the supplied {index|revUid|keyId} is the empty-slot sentinel. */
export function isEmptySlotMarker({ index, revUid, keyId } = {}) {
  if (Number.isInteger(index) && index === EMPTY_SLOT_MARKER.index) return true;
  const r = normHex(revUid != null ? revUid : keyId);
  return r === EMPTY_SLOT_MARKER.revUid;
}

/* Look up a single entry by id. Returns null when absent. */
export function getKnownWorkingKeyById(id) {
  if (!id) return null;
  return KNOWN_WORKING_KEYS.find((e) => e.id === id) || null;
}

/**
 * Return the known-good keys applicable to `vin`: every global entry (vin ==
 * null) plus any entry whose VIN matches the normalized argument. With no /
 * invalid VIN, only the globals are returned. Result is a fresh array.
 */
export function getKnownWorkingKeys(vin) {
  const norm = normalizeVin(vin);
  return KNOWN_WORKING_KEYS.filter((e) => !e.vin || (norm && e.vin === norm));
}

/**
 * Return the PENDING alternate-family keys applicable to `vin` (a fresh array).
 * These are recognized real keys whose chip family + SK are NOT bench-confirmed,
 * so they are recorded for provenance but are NEVER known-good (chipId/sk null).
 * They live OUTSIDE KNOWN_WORKING_KEYS, so getKnownWorkingKeys /
 * classifyAgainstRegistry never see them -- call this explicitly to surface them.
 */
export function getPendingAltFamilyKeys(vin) {
  const norm = normalizeVin(vin);
  return PENDING_ALT_FAMILY_KEYS.filter((e) => norm && e.vin === norm);
}

/**
 * Classify a captured/typed key record against the registry.
 *
 * Returns { status, entry, mismatchedFields }:
 *   'known-good' -- chipId + UID + SK all match a registry entry.
 *   'mismatch'   -- UID matches a registry entry but chipId and/or SK differ
 *                  (mismatchedFields lists which: 'chipId' / 'sk').
 *   'unknown'    -- no registry entry shares this UID, OR the input is blank /
 *                  unparseable / the empty-slot sentinel (refuse-on-doubt).
 *
 * UID comparison uses the BE keyId form the operator types into the Key Dump
 * card (matching the placeholder "00 77 A2 9B"). `vin` scopes the candidate
 * set the same way getKnownWorkingKeys does.
 */
export function classifyAgainstRegistry(record, vin) {
  const uid = normHex(record?.uidHex);
  const sk = normHex(record?.skHex);
  const chip = normChip(record?.chipId);

  // Refuse-on-doubt: need a well-formed, non-blank UID + SK + chip to say
  // anything. Malformed hex (stray chars, odd length) is treated as unknown,
  // never allowed to fall through to a UID-only 'mismatch'.
  if (
    !chip ||
    !isValidHexBytes(uid) ||
    !isValidHexBytes(sk) ||
    isBlankHex(uid) ||
    isBlankHex(sk)
  ) {
    return { status: 'unknown', entry: null, mismatchedFields: [] };
  }
  // The empty-slot sentinel is never a real key.
  if (isEmptySlotMarker({ keyId: uid })) {
    return { status: 'unknown', entry: null, mismatchedFields: [] };
  }

  const candidates = getKnownWorkingKeys(vin);
  const entry = candidates.find((e) => normHex(e.keyId) === uid) || null;
  if (!entry) return { status: 'unknown', entry: null, mismatchedFields: [] };

  const mismatchedFields = [];
  if (normChip(entry.chipId) !== chip) mismatchedFields.push('chipId');
  if (normHex(entry.sk) !== sk) mismatchedFields.push('sk');

  if (mismatchedFields.length === 0) {
    return { status: 'known-good', entry, mismatchedFields: [] };
  }
  return { status: 'mismatch', entry, mismatchedFields };
}

/**
 * Build a fresh, editable makeKeyRecord from a registry entry, for prefilling
 * the Key Dump card. UID = the BE keyId; SK = the documented per-transponder
 * secret (NEVER SEC16). Returns null when the entry's chip family is unknown
 * (refuse-on-doubt -- a record we couldn't validate is useless for prefill).
 */
export function knownKeyToRecord(entry) {
  if (!entry || !chipFamily(entry.chipId)) return null;
  return makeKeyRecord({
    chipId: entry.chipId,
    uidHex: entry.keyId,
    skHex: entry.sk,
    flags: entry.flags,
    label: knownKeyLabel(entry),
  });
}
