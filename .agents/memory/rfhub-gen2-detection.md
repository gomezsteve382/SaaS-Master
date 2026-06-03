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
