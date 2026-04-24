# Pre-refactor SRT Lab JSX archive

**Status: reference only — NOT ground truth.**
Extracted from `attached_assets/files_1777048870263.zip` on **April 24, 2026**
during the SEC6 review that followed Task #433 (PCM SEC6 skip-logging
+ 8 KB GPEC2A real-dump pin). The current refactored codebase under
`artifacts/srt-lab/` is the source of truth.

## Files
- `srtlab.jsx` (936 lines) — earliest monolith.
- `srtlab_v2.jsx` (291 lines) — "real data edition" with embedded DB.
- `srtlab_full.jsx` (409 lines) — analysis-data variant with embedded `D` blob.

## Why this README exists — three traps to avoid

If you (or a future agent) read these files looking for SEC6 / pairing
logic, three things in the old code are wrong or misleading. The
refactored codebase already handles all of them; do not "port back"
anything from this archive without checking the current implementation
first.

### 1. The "SEC6 at 0x203 (8 bytes) + mirror at 0x361" claim is the SKIM key, not SEC6
- `srtlab.jsx:194` builds `result.sec6 = { value: hx(d[0x203..0x20B]), … }`
  with a mirror check at `0x361`. **That region is the SKIM key, not the
  PCM SEC6 secret.**
- The real PCM (GPEC2A) SEC6 lives at **`0x3C8` (6 bytes), gated by a
  `FF FF FF AA` marker at `0x3C4`**. Without the marker, external tools
  (CGDI / Autel / AlfaOBD / SINCRO) and the PCM bootloader treat the
  slot as `IMMO_DAMAGED` even if the 6 secret bytes look correct.
- Current code, correctly named:
  - Parse: `artifacts/srt-lab/src/lib/parseModule.js:481` (`pcmSec6`)
  - Write: `artifacts/srt-lab/src/lib/securityBytes.js:231`
    (`writePcmSec6`, stamps marker + 6 bytes together)
  - Inline parser: `artifacts/srt-lab/src/lib/fileUtils.js:65` properly
    splits `sec.key` / `sec.km` (SKIM) from `sec.pcmSec6` (real SEC6).

### 2. `crossMatch()`'s SEC6 ↔ RFH pairing is structurally broken
`srtlab.jsx:235`'s `crossMatch()`:
- Sources `f.sec6.value` from the **SKIM key bytes at 0x203** (see trap
  #1), then tries to match its first 6 bytes to the first 6 bytes of
  the RFH SEC16. SKIM key and RFH SEC16 are unrelated, so this almost
  never matches.
- Even when the byte source were correct, the SEC6 ↔ RFH pairing only
  runs **inside** a successful BCM-fragment match, so an isolated
  GPEC2A + RFHUB pair never gets cross-checked.
- Replacement in current code (per-pair workflows + multi-file audit):
  - `artifacts/srt-lab/src/tabs/TwinTab.jsx`
  - `artifacts/srt-lab/src/tabs/RFHPCMTab.jsx`
  - `artifacts/srt-lab/src/tabs/ModuleSyncTab.jsx`
  - `artifacts/srt-lab/src/tabs/FcaAnalyzerTab.jsx`
    (uses `crossValidate` + `parseModule` with the correct 0x3C8 SEC6).

### 3. The `ALGOS` table is already a strict subset of the current catalog
The 7-entry table in `srtlab_full.jsx:18` and the 12-entry table in
`srtlab_v2.jsx:16` (cda6, gpec2/3/2a, gpec_tea, ecm, tcm, rfhub, ngc,
tipm a/b, gpec15) are all present in the current code, with the same
constants:
- `artifacts/srt-lab/src/lib/algos.js:155-170` — superset including
  jtec, sbec, xtea_sgw, tipm c/d, AlfaOBD ht/f/ao.
- `artifacts/srt-lab/src/lib/canflashAlgos.js` — the byte-verified
  ground-truth catalog (BCM, TIPM_7, ABS TRW/Bosch, ITM, Yazaki FCM,
  NGC engine/trans, Venom PCM, GPEC TEA, Huntsville Radio, WCM,
  Alpine RAK), each validated against the factory Chrysler DLL.

Don't port constants out of the old `ALGOS` — go to `algos.js` /
`canflashAlgos.js` instead.

## Provenance / handling
- Do not edit these `.jsx` files; they are kept as-is for historical
  reference.
- Do not edit `attached_assets/files_1777048870263.zip`.
- New SEC6 / pairing / algorithm work belongs in `artifacts/srt-lab/`,
  not here.
