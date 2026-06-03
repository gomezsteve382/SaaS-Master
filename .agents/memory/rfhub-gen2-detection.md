---
name: RFHUB Gen2 detection must use size, not the 0x0500 banner
description: Why generation detection by the AA5531 banner alone produces false SEC16 mismatches on real Gen2 EEE dumps
---

# RFHUB Gen2 detection: size is canonical, banner is only a hint

Generation of a Yazaki/FCM RFHUB EEPROM is determined by SIZE:
24C16 = 2 KB = Gen1; 24C32 = 4 KB (and 8 KB double-dumps) = Gen2. The canonical
helper is `detectGen()` in `lib/rfhubKeySlots.js` (size-based). Gen2 SEC16 lives
at `0x050E`/`0x0522`; Gen1 (in engParseRfh's own convention) at `0x0226`/`0x023A`.

**The trap:** real Gen2 **EEE Charger** dumps store a valid SEC16 at `0x050E`
but carry a NON-canonical banner at `0x0500` (e.g. `FF FF 00 00` instead of
`AA 55 31 01`). Any RFHUB parser that gates Gen2 on the banner alone will
mislabel these 4 KB files as Gen1, read garbage from `0x0226`, and surface a
**false SEC16 MISMATCH** (this bit the Security Sync tab — the user's gen2 RFHUB
showed as gen1).

**Why this is easy to reintroduce:** there are MULTIPLE RFHUB parsers in this
codebase — `lib/rfhubKeySlots.js` (size-based, correct), `engParseRfh` in
`tabs/ModuleSync.jsx`, and a separate one in `App.jsx`. They do NOT share gen
detection. A fix in one does not propagate.

**How to apply:** any new/edited RFHUB gen detection must treat 4096/8192-byte
images as Gen2 regardless of the `0x0500` banner (banner is a secondary hint
only), and only treat 2048-byte images as Gen1. Keep the `format` label
`'gen2'` so downstream `startsWith('gen2')` / `=== 'gen2'` checks keep working.
Ground-truth EEE SEC16 offsets/values: `charger62-bench-set.md`.

## EEE+ variant: the WRITER also diverges from real SINCRO output

Detection-by-size fixes the PARSER, but `writeRfhSec16FromBcm` / `runRfhBcmSync`
still do NOT reproduce a real FCA-SINCRO twin on an "EEE+" Charger RFHUB
(filename tag `RFHUB_EEE+`). Ground truth from a real OG→SINCRO-twinned pair
(donor BCM SEC16 `555AAAF03A7824B694C25BC7E31BB6F0`):

1. **SEC16 16-byte payload matches** — SINCRO writes `reverse(BCM SEC16)` =
   `F0B61BE3C75BC294B624783AF0AA5A55` to both slots `0x050E`/`0x0522`. Our secret
   derivation is correct here.
2. **Slot checksum DIFFERS** — SINCRO stores chk byte `0x05` at slot+16; our
   `crc8_65(rfhSec16)` = `0xFD`. `crc8_65` is verified-correct for STANDARD Gen2
   (golden `0123…3210`→`0xE2`, and the committed `rfhub.after.bin` slots both
   match) but NOT for EEE+. A brute sweep with only 2 valid vectors yields 9
   ambiguous CRC8 fits and none is crc8_65 — the EEE+ checksum is unresolved.
   The real SINCRO twin even parses as `csOk=false` under our crc8_65.
3. **Marker gate blocks the write** — EEE+ has `FF FF 00 00` at `0x0500` (no
   `AA 55 31 01`), and SINCRO LEAVES it that way. `writeRfhSec16FromBcm` throws
   on the missing marker; `runRfhBcmSync` works around it by STAMPING `AA 55 31
   01`, which then diverges 4 bytes vs SINCRO.
4. **VIN restamp** — SINCRO rewrites all 4 RFH VIN slots (reverse-stored
   `0x0EA5/0xEB9/0xECD/0xEE1`, +chk) from the BCM VIN; neither writer touches
   VINs, so an OG carrying a different donor VIN stays mismatched.

**Why:** a "pin twinning to SINCRO byte-for-byte" golden test is currently
impossible for EEE+ — the writer differs in checksum + marker + VIN. Do NOT
"fix" the checksum to an ambiguous formula without more real EEE+ dumps to
disambiguate; treat EEE+ as a distinct variant pending bench data.
