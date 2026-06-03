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
- The EEPROM is **multi-section**: before the keys are other mirrored records (`xx xx xx 00 xx xx` shape, plus `5A5A5A5A 9500` filler entries); after the keys is the **aux table** (see next section). Record lengths differ per section.

## Aux table after the keys is NOT RKE fobs (resolved)
- Directly after the key table's last mirror (0xCDB) there is a **4-byte mirrored trailer** at 0xCDC (`[4B][4B mirror][FF FF]`, e.g. `00 6C 26 6C` / `4F C7 6F C7` — value differs per dump, fixes the start boundary). Then a **fixed table of 17 ten-byte mirrored records** begins at **0xCE6**: record 10B, stride 24 (`[10B] FF FF [10B mirror] FF FF`), ending at **0xE7E** (next section starts `00 00 00 00 FE 00 …`).
- **These are NOT per-car RKE/remote-fob entries** despite the position the original task assumed. Proof from the 4-vehicle corpus: the count is **fixed at 17 on every dump regardless of transponder-key count** (cars with 3/5/6 keys all give 17), and several records are **byte-identical across distinct VINs/masters** (rec4 `55 55 59 59 22 82 A9 01 51 01`, rec7 `00 00 00 00 00 20 00 81 5C 01`, rec11 `00 00 00 00 00 00 00 71 8C 01`). Most consistent with a fixed RFHUB **parameter/calibration block**.
- **byte 8 = ones'-complement checksum — SOLVED & VERIFIED.** It is an end-around-carry (ones'-complement) 8-bit checksum over the other nine bytes; equivalently the carry-folded sum of ALL ten bytes === **0xFE**. `s=sum(0..9); while(s>0xFF) s=(s&0xFF)+(s>>8); s===0xFE`. Verified byte-exact on all 68 records (17 × 4 distinct VINs). The old "no simple sum/xor reproduces it" was because a plain mod-256 sum **drops** the high-byte carries, so the apparent target drifted 0xFA–0xFE (drift == per-record carry count 1–4); folding the carries back makes it the single constant 0xFE. This also confirms **byte 9 is checksummed payload, NOT a free-standing flag** (mostly 0x01, rarely 0x02/0x07/0x08). Helpers `auxRecordChecksum`/`auxRecordChecksumOk`/`expectedAuxChecksumByte` + consts `CHAR_AUX_CHECKSUM_INDEX=8`/`CHAR_AUX_CHECKSUM_TARGET=0xFE` in `charRfhubAuxTable.js`; parsed records carry `checksum`/`checksumOk`; UI shows a CS column.
- Field meaning of the OTHER bytes (0..7, 9) remains **unverified**. Read-only structure-only parser (sibling to the key-table parser, no writer) — knowing the checksum does NOT make an edit safe. **Do not relabel fields or add a writer without a bench capture proving semantics** — the "fobs" interpretation is already disproven, so any future relabel needs evidence, not a position-based guess.

## Why the built-in parser misses it
- `rfhubKeySlots.js` (parseKeySlots) reads Gen2 keys at base **0x888** (AA50 markers) with KEY_SLOT_COUNT=4. On this dump 0x888 is garbage/empty — the real working keys are at 0xC7E. So this Charger RFHUB variant uses a layout the current parser does **not** model; addSlot/writeKeyRecordToSlot/firstFreeSlot target the wrong region.

## Index byte — SOLVED (mod-255 checksum complement)
- **`index = (0xFD - sum(keyId bytes)) mod 255`**, equivalently `(sum(keyId) + index) ≡ 0xFD (mod 255)`. A mod-255 checksum complement: range 0x00–0xFE, never 0xFF (the record separator). Byte-sum is order-independent, so Key ID and reversed UID give the same result.
- Verified against all 6 known vectors: 0077A29B→0x48, CC62209F→0x0F, 09A6629F→0x4C, 91654F9E→0x19, 197E6C9E→0x5B, C47D6C9E→0xB0.
- **Why the earlier sweep missed it:** the first pass only tried sum/xor/CRC8 of the UID *as the index directly*; the answer is an affine function over int-mod-255 (0xFD minus the sum), not a CRC. An exhaustive affine-over-mod-255 search found this as the unique match (false-positive prob ~1e-9). Also ruled out: hashes/HMAC, all CRC16, DES/3DES/AES (all positions/dirs), AES-CMAC, Hitag2 keystream.
- **In code:** `deriveCharKeyIndex(key)` in `charRfhubKeyTable.js` (accepts 8-hex Key ID or 4-byte array) + `CHAR_KEY_INDEX_CHECK = 0xFD`. `addCharKey` now auto-derives the index when none is passed (explicit `indexLow` still overrides for bench experiments); result carries `indexDerived: boolean`. `CHAR_KEY_DEFAULT_INDEX = 0x95` is retained ONLY as the empty-slot sentinel, not a key-add default.
- **Still unproven on a real car:** slot placement (real cars fill slots 3-8) and whether a companion table elsewhere needs a matching entry. A 7th key isn't a free-slot overwrite — keys are contiguous and the next bytes belong to another table.

## Slot placement — CORPUS-ALIGNED, still not before/after-verified
- Surveyed every distinct 4 KB key table (4 vehicles, attached_assets + fixtures): keys are ALWAYS a contiguous block ENDING at slot 8 with empties at the LOW end. Patterns seen (`.`=empty,`K`=key): `..KKKKKK`(s3-8), `...KKKKK`(s4-8), `.....KKK`(s6-8, ×2 incl. the 0x03 Redeye). Never a gap below a key, never an empty slot 8.
- **Fix:** `addCharKey` now defaults to `lastFreeCharSlot` (HIGHEST empty slot = hole directly below the block), not `firstFreeCharSlot` (slot 1). The old first-free default produced a low key with a gap above it — a layout NEVER seen on a real car and the most likely reason an offline-added key would be ignored. `firstFreeCharSlot` kept only for the corpus-pattern tests; the writer no longer uses it.
- **Why this is corpus-aligned, not bench-proven:** it fixes the structural placement (where keys SIT) but does NOT prove firmware reads the key on a live start, nor that a companion table needs a matching entry. Both still require a real before/after key-add EEPROM pair — **none exists in the repo**: the `realDumps/rfhub.before/after` pair is a SEC16 sync (diff only at 0x050E-0x0533; key table at 0xC5E byte-identical), not a key-add.

## Slot-8 boundary trap (detection gate)
- The key table's LAST slot has NO trailing `FF FF` separator on real dumps: the next table (10-byte RKE records) abuts it with no gap (reference car: `00 6C` at 0xCDC-0xCDD). A detection gate that requires trailing `FF FF` on all 8 slots rejects **every** real 4 KB dump (0/30 accepted incl. the reference car).
- **Why it hid for so long:** the synthetic test fixture padded slot 8 with `FF FF`, which never occurs on a real car, so the gate passed in tests while failing on every real file. Any fixture for this table MUST reproduce the non-FF slot-8 boundary or it masks the bug.
- **How to apply:** enforce the inner `FF FF` separator + mirror match on all 8 slots, but the trailing `FF FF` separator on slots 1-7 only. The mirror check still runs on the last slot, so the gate stays fail-closed.

## Flag byte is a presence/family bitfield (0x03 resolved)
- The record flag is NOT just 0/1. Observed values across every valid 4 KB key table in attached_assets: **0x00** (no key / empty template), **0x01** (present, FCA id46 Hitag2 — Key IDs end in 9B/9F/9E so stored records start 0x9X), **0x03** (present, ALTERNATE family, bit1 set). No other flag value occurs.
- **0x03 records ARE real working keys**, not garbage: the ONLY 0x03 vehicle (master f7b1, VIN 2C3CDXCT1HH652640, a 2020 6.2 Redeye) has ZERO 0x01 keys and THREE 0x03 keys (slots 6-8). A running car must have a working immobilizer key and those three are its only keys → they work. **No car mixes 0x01 and 0x03** — each immobilizer is single-family.
- 0x03 stored UIDs (65 00 a4 bf / 69 da 69 23 / 64 c9 48 12) do NOT start with 0x9X → NOT id46 Hitag2. Most consistent with FCA proximity / Hitag-AES (PEPS) keys on the Redeye, but **chip family + per-chip SK are NOT bench-verified**.
- `classifySlot`/`parseCharKeyTable` now classify 0x03 as `state:'key'` + `keyKind:'alt'` (0x01 → `keyKind:'hitag2'`). Any other flag stays `'unknown'` (gate not widened). `keyKindForFlag` is the single source of truth. `addCharKey` still WRITES only 0x01 (it byte-reverses an Autel Key ID; it cannot synthesize an alt record). **Not yet in knownWorkingKeys.js** — registering needs chip family + SK confirmed (id46/MIKRON would be a lie for the alt family).

## Multi-vehicle corpus result (4 distinct masters)
- attached_assets holds 4 DISTINCT vehicles by master secret (16 B @0x0226, mirror @0x0238): V1 5902.. (8 keys, the subject), V2 F7B1.. (Mitchell VIN ...65264, flag 0x03 keys), V3 4F80.. (CARTMAN), V4 D0D8.. (rfhubzo). Many filenames are duplicate dumps of the same car.
- 21 real keyId->index pairs across the 4 masters. `FFFFFF02 -> index 0xFB` appears under TWO different masters (V2,V3): a factory **sentinel**, not a derived key — do NOT treat it as proof the index is master-independent.
- **Ruled out across ALL 4 vehicles** (not just one car): CRC8 (every poly/init/refin/refout/xorout), CRC16 sweep (CCITT/IBM/3D65/A001/etc x hi/lo/hi^lo over keyBE, keyLE, key||master, master||key), single-byte linear, sum/xor folds. Index is a real keyed/crypto value or an allocation counter.
- Kit assembled at exports/RFHUB_INDEX_CRACK_KIT(.tar.gz): all dumps + pairs_all.csv + vehicles.txt + SEARCH_SPEC.md + BEFORE_AFTER_PROTOCOL.md + solve_index.mjs (plug-in candidate harness) + diff_dumps.mjs (before/after differ).

## How to actually crack/do it
- **Best:** a before/after EEPROM pair around a single key-add -> diff reveals insertion point, the index value & how chosen, and any checksum/shift. One example fully specifies the format.
- **If no before/after:** read all existing keys on the Autel (Key ID + 4 pages + Config + SK) to test whether index is computed from page/config data rather than UID.
- **Safe path regardless:** live RoutineControl 0x0401 key-learn (blank MIKRON-default keys are ideal); RFHUB assigns the index itself. Needs the PIN (3-strike brick risk) and an EEPROM backup first.
