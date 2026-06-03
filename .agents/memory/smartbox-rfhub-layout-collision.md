---
name: SmartBox vs RFHUB Gen2 layout collision
description: Why the Journey SmartBox analyzer is a standalone tab and is NOT auto-detected in parseModule.
---

# SmartBox (Dodge Journey, MC9S12XEG384) immobilizer dump analysis

The 4096-byte Journey SmartBox EEPROM (24C32) is **content-indistinguishable**
from an RFHUB Gen2 image: both carry the same part block (`AA40712804…` @0x808)
and the same reversed-VIN slots @0xEA5 (stride 0x14). VIN is stored byte-reversed.

**Decision:** the SmartBox analyzer was kept as its own read-only tab with its
own file uploader and was deliberately NOT wired into `parseModule`'s
auto-detection.

**Why:** wiring a SmartBox detector into `parseModule` would steal/mis-route
genuine RFHUB Gen2 dumps (and vice-versa) because no byte signature separates
them. A standalone tab lets the operator declare intent.

**How to apply:** if asked to auto-detect SmartBox in the shared module pipeline,
push back — you need an out-of-band signal (filename, operator selection, or a
genuinely distinguishing byte field confirmed on a bench dump) first.

## Record / field notes (bench-UNCONFIRMED beyond VIN)
- VIN slots: 0xEA5, 0xEB9, 0xECD, 0xEE1 (4 copies), 17 reversed ASCII bytes each.
- Per-record: optional marker @-1 is INCONSISTENT across dumps (0xFE vs 0x00) —
  do NOT require it for detection. 2-byte trailer @+17 algo unconfirmed → surfaced raw.
- `isSmartBoxImage` = size 4096 AND ≥1 valid 17-char reversed VIN at canonical
  slots. Virgin/blank dumps return false (honest, no false-positive).
- Corpus when built: 18 staged files (16 programmed, 2 virgin "JUVENTINO").
  All 16 programmed contain part-number core "0712804". OGFILE1 VIN = 2C3CCAGG0GH167935.
- Test fixtures resolve attached_assets and split PROGRAMMED vs virgin via
  validVinCount===4.
