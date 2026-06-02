---
name: GPEC2A PCM offline analyzer + immo fix
description: Where the offline ECM-tab GPEC2A analyzer lives and the immo-secret convention it relies on.
---

# GPEC2A PCM offline analyzer + immo-fix panel

Offline-dump analyzer for Continental GPEC2A PCM external EEPROM, surfaced in the
ECM tab (`EcmTab.jsx` renders `Gpec2aImmoPanel` when `ecmInspectMod.type==='GPEC2A'`).

- Pure logic: `src/lib/gpec2aPcmAnalyzer.js` (`analyzeGpec2aPcm`, `derivePcmSec6FromDonor`,
  `applyGpec2aChanges`, `applyGpec2aImmoFix`, `isCanonicalGpec2a`). No DOM/fetch.
- It does NOT reimplement the secret writer — it delegates to `writePcmSec6` in
  `securityBytes.js` (single source of truth, stamps marker + sec6).

**Immo secret convention (ground-truthed against bench fixtures):**
PCM SEC6 = reverse(BCM split SEC16)[0:6]; marker `FF FF FF AA` @ 0x3C4; SEC6 @ 0x3C8.
**Why:** confirmed independently — synced BCM for VIN 2C3CDXL92KH674464 yields
`F6 F4 25 6B 04 C6`, byte-identical to the synced PCM's 0x3C8 slot and marker.

**Donor caveat:** RFHUB `vehicleSecret` is often blank/garbage on EEE-only dumps, so
the BCM donor path is the reliable one. `derivePcmSec6FromDonor` rejects all-FF/all-00
secrets — never fix immo from a virgin source.

**Verification:** full srt-lab vitest suite OOM-kills in this env; verify with a
targeted file run (`vitest run src/lib/__tests__/gpec2aPcmAnalyzer.test.js`) + typecheck.
The `asset-sweep-check` workflow failing on inventory/REPORT drift is pre-existing and
unrelated to JS-only changes.
