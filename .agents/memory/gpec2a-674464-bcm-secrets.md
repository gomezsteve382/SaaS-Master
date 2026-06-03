---
name: HERMANADO vs OG BCM secrets (VIN 2C3CDXL92KH674464)
description: Why two BCM dumps for the same charger VIN derive different PCM SEC6 secrets, and which one the car actually uses.
---

# HERMANADO (twinned) vs OG (raw-read) BCM secrets

For the 2019 Charger VIN `2C3CDXL92KH674464` there are TWO families of BCM dumps in
`attached_assets/` that derive DIFFERENT immobilizer secrets:

- `19charger_BCMDFLASH_OG_*` (raw reads off the car) → SEC6 `F0 B6 1B E3 C7 5B`.
  This MATCHES the competitor FCA SINCRO capture for the same VIN.
- `BCM_HERMANADO_..._BCM_SYNCED_*` (twinning OUTPUTS, not raw reads) → SEC6
  `F6 F4 25 6B 04 C6`. The golden test `gpec2aPcmAnalyzer.test.js` uses one of
  these, so its expected value is the twinned secret, NOT the car's.

**The lesson:** a `*_SYNCED` / `HERMANADO` ("twinned") BCM file is the product of a
sync operation — do NOT assume it represents what is physically installed in the
car. The OG raw-read dump is the authoritative "what's in the car" value.

**Why this matters:** the correct GPEC2A PCM is whichever SEC6 matches the BCM
**physically installed** in the vehicle. Picking by competitor screenshot or by the
golden-test fixture leads to flip-flopping (I did, twice). Don't reason about which
PCM file is "right" in the abstract — it depends on the installed BCM.

**How to apply:** `checkSec6MatchesBcm(outBytes, donorMods, manualOverride)` in
`gpec2aPcmAnalyzer.js` is the safety net: it refuses to export a PCM whose SEC6 at
`0x3C8` disagrees with the loaded BCM donor's derived secret, refuses when two
loaded BCMs disagree (conflict), and only passes on a manual SEC6 override or when
no usable BCM donor is loaded. Tell the user to load the BCM that's in the car and
let the guard enforce the match — never hand-pick the PCM for them.
