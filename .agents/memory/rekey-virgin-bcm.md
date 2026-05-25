---
name: Re-key virgin BCM from RFHUB
description: writeBcmSec16Gen2 only updates existing split records; virgin BCMs need from-scratch creation. parseModule vs engParseRfh have different sec16 field shapes.
---

## Key rules

**writeBcmSec16Gen2 is update-only, not create.**
It requires the split record header format (FF FF | 00×6 | idx | … | 04 04 00 14 | …) to already exist. A virgin BCM has all-0xFF at 0x81A0/0x81C0/0x81E0 — the function finds nothing and returns splitPatched=0. Must write records from scratch before calling writeBcmSec16Gen2 (or for any feature that needs to initialize records on a virgin BCM).

**Mirror records don't exist on virgin BCMs.**
The ECU FEE allocator creates inactive-bank mirror records (slot 0xEB/0xCA) on first boot after flashing. mirrorPatched=0 after a virgin re-key is correct; don't assert mirrorPatched>0 in tests.

**parseModule vs engParseRfh: different RFHUB sec16 field shapes.**
- `parseModule()` RFHUB result: `sec16s[0].raw` (Uint8Array, 16 bytes)
- `engParseRfh()` (ModuleSync.jsx internal): `sec16.slot1` (Uint8Array, 16 bytes)
Both refer to the same data (RFHUB Gen2 slot 1 @ 0x050E) but through different parser structures. Tests using parseModule must use `sec16s[0].raw`; the UI executeSync handler uses `rfh.parsed?.sec16?.slot1`.

**Why:**
Real NEWVIN BCM (196.2charger_BCMDFLASH_NEWVIN) has phantom mirror1 at 0x40C0 (header bytes match but CRC invalid) and stale data at 0x40C9. Neither blocks re-key because the guard uses CRC-validated mirror detection (resolveMpc5606bSec16), not raw byte presence.
