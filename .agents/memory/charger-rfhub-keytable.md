---
name: Charger RFHUB EEPROM key-table layout
description: Where transponder keys actually live in the 2019 Charger (MPC-based) RFHUB 4KB EEPROM, why the built-in parser misses them, and why offline key-add is hard
---

# Charger RFHUB key table (4 KB EEPROM, immovin/EEE+ dumps)

Observed on VIN 2C3CDXL92KH674464 dumps (19CHARGER_RFHUB_EEE+ and immovin..._VIN_APPLIED, both 4096 B, key region byte-identical).

## Layout
- The authoritative transponder-key list is a run of **6-byte records at ~0xC7E**, each written **twice (mirror)** with `FF FF` separators: `[4-byte UID, byte-reversed][index low][0x01]`.
  - Stored UID = byte-reverse of the Autel "Key ID" (e.g. Key ID 0077A29B -> `9B A2 77 00`; BCD2EB9B -> `9B EB D2 BC`). FCA Hitag2 key IDs end in 9B/9F/9E, so stored records start with 0x9X.
  - The known-good keys on this car: 0077A29B(idx48), CC62209F(idx0F), 09A6629F(idx4C), 91654F9E(idx19), 197E6C9E(idx5B), C47D6C9E(idxB0).
- The EEPROM is **multi-section**: before the keys are other mirrored records (`xx xx xx 00 xx xx` shape, plus `5A5A5A5A 9500` filler entries); after the keys is another table with **longer (10-byte) records ending in 01** (likely RKE/remote or a second key type). Record lengths differ per section.

## Why the built-in parser misses it
- `rfhubKeySlots.js` (parseKeySlots) reads Gen2 keys at base **0x888** (AA50 markers) with KEY_SLOT_COUNT=4. On this dump 0x888 is garbage/empty — the real working keys are at 0xC7E. So this Charger RFHUB variant uses a layout the current parser does **not** model; addSlot/writeKeyRecordToSlot/firstFreeSlot target the wrong region.

## Why offline key-add is hard (index byte is the blocker)
- The per-key **index low byte is NOT derivable from the UID**: exhaustive sweep of sum, xor, and full CRC8 (all 256 polys x init 0/FF x refin/refout, over fwd/rev/+01) matched **none** of the 6 samples.
- **Not a pointer** either: treating the 2-byte field as LE addr 0x01xx lands in an unrelated repeating region, not per-key data.
- Conclusion: the index is **firmware-assigned at learn time** (handle/sequence or checksum over per-key data not in this table). A 7th key also isn't a free-slot overwrite — keys are contiguous and the next bytes belong to another table.

## How to actually crack/do it
- **Best:** a before/after EEPROM pair around a single key-add -> diff reveals insertion point, the index value & how chosen, and any checksum/shift. One example fully specifies the format.
- **If no before/after:** read all existing keys on the Autel (Key ID + 4 pages + Config + SK) to test whether index is computed from page/config data rather than UID.
- **Safe path regardless:** live RoutineControl 0x0401 key-learn (blank MIKRON-default keys are ideal); RFHUB assigns the index itself. Needs the PIN (3-strike brick risk) and an EEPROM backup first.
