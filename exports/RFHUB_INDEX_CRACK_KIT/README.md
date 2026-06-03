# RFHUB INDEX CRACK KIT

  Everything needed to derive (or capture) the one unsolved value that blocks adding a
  brand-new key to an FCA/Stellantis RFHUB offline: the per-key **INDEX byte**.

  ## What's here
  - dumps/                         All RFHUB EEPROM dumps on hand (51 files, raw .bin).
  - pairs_all.csv                  Every keyId -> INDEX pair extracted, with master secret + flag + offset.
  - vehicles.txt                   The 4 distinct vehicles (by master secret) and their keys.
  - working_key_0077A29B_chip_profile.json   Autel-read profile of a confirmed working fob.
  - SEARCH_SPEC.md                 Precise definition of F(keyId,master)->INDEX, ruled-out methods, candidate families.
  - BEFORE_AFTER_PROTOCOL.md       The fastest path: capture ground truth from a working add.
  - solve_index.mjs                Runnable harness: loads the pairs, sweeps CRC16, plug in your candidate F.
  - diff_dumps.mjs                 Run on before/after dumps to read the INDEX your tool assigned.

  ## Quick start
      node solve_index.mjs                 # test built-in sweeps + your candidate() against all 4 vehicles
      node diff_dumps.mjs before.bin after.bin   # extract the INDEX a working tool assigned

  ## The ask, in one line
  Find F so that F(keyId, master_secret) reproduces every real pair in pairs_all.csv —
  OR run the before/after capture and send back the two .bin files + the keyId added.

  Layout reference (MPC 4KB RFHUB): key table base 0xC5E, stride 16; record = keyId(4 LE) +
  INDEX(1) + FLAG(1), mirrored, FFFF separated. Master secret: 16 bytes @0x0226 (mirror @0x0238).
  Empty slot = 5A5A5A5A / index 0x95 / flag 00. SK (transponder secret) = universal MIKRON, not the differentiator.
  