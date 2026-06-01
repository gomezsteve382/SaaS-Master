---
name: XC2268 RFHUB SEC16 layout & write
description: Where/how SEC16 lives in the 2019+ XC2268 RFHUB image and the rule for writing it
---

# XC2268-class RFHUB (2019+ Ram/Jeep, 64 KB internal flash) SEC16

The XC2268 RFHUB stores SEC16 in TWO mirror slots, each: 16 SEC16 bytes
followed by a BE16 CRC-16/CCITT-FALSE over those 16 bytes (slot+16/+17).
Layout constants are the single source of truth in `xc2268Rfhub.js`
(`XC2268_SEC16_SLOTS`, `XC2268_SEC16_LEN`) — importers (e.g. the SEC16 writer)
must import them rather than re-deriving offsets.

**Endianness convention (shared with Gen2 RFHUB):** the BCM stores
`reverse(RFHUB SEC16)`. So RFHUB SEC16 = `reverse(BCM SEC16)`. parseModule
surfaces XC2268 SEC16 in the same Gen2-compatible shape (`info.sec16s` with
`hex` = RFH-endian, `bcmHex` = byte-reversed BCM-endian) so the key-prog wizard
and ModuleSync compare/patch paths need no XC2268 special-casing.

**Why the image checksum must be refreshed after any SEC16 write:** the SEC16
slots sit INSIDE the trailing BE32 image-wide checksum window (`[0, len-4)`).
Writing SEC16 without recomputing `xc2268ImageChecksum` and rewriting the last
4 bytes leaves a stale image CRC, so a reparse flags `imageChecksum.ok=false`.
`writeXc2268Sec16` always does this refresh as its last step.

**Refuse-on-doubt:** like the Gen2 writer, refuse (throw) when the BCM secret is
blank (all-FF or all-00) so a virgin/unresolved BCM can never zero the RFHUB.

**How to apply:** in the key-prog wizard, XC2268_RFHUB maps to the `RFH` role
(no longer hard-blocked); the SEC16 write step branches on
`info.type === 'XC2268_RFHUB'` to pick `writeXc2268Sec16` vs
`writeRfhSec16FromBcm`. SEC16 is intentionally excluded from
parseXc2268Image's writeSafe/banners (blank SEC16 = virgin = normal state).
