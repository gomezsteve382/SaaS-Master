---
name: 6.2 Charger bench set ground truth
description: Pinned VIN/SEC16 values for the user's 6.2 Charger bench set (PCM/RFH-EEE/RFH-Pflash/BCM) — useful for sanity-checking any future bench-set tooling against the same files.
---

# 6.2 Charger bench set ground truth

The user has a reference 4-file bench set that is the canonical fixture for any
"6.2 Charger" Key-Prog / VIN / SEC16 tooling.  An independent competitor tool
(FCA SINCRO · ArmandoQS — "Charger/Challenguer RFH ⇄ BCM" inspector) agrees on
these values, so they can be used as cross-tool sanity checks.

## Files (in `attached_assets/`)

| Role           | Filename                                            | Size      | Module                   |
| -------------- | --------------------------------------------------- | --------- | ------------------------ |
| PCM            | `6.2CHARGER_NEEDTOUSE_immoFix_*.bin`                | 4 KB      | GPEC2A (95320)           |
| RFH EEE        | `19charger6,2_rfhubeee_*.bin`                       | 4 KB      | RFHUB Gen2 (24C32)       |
| RFH P-flash    | `19charger6.2_rfhubP-flash_*.bin`                   | 384 KB    | MC9S12X Type1 Gen2       |
| BCM D-Flash    | `196.2charger_BCMDFLASH_NEWVIN_*.bin`               | 64 KB     | BCM MPC5606B (05B)       |

## Pinned values

- **Target VIN** (all modules agree): `2C3CCABG1KH539430`
  - BCM has 4 VIN copies, all CRC OK
  - RFH EEE has 4 VIN slots, all carry the VIN but **all 4 VIN-slot CRCs FAIL**
    on FCA SINCRO while our parser reports CRC OK.  Decision: this is a
    self-consistency vs spec-strict disagreement, not a polynomial bug.  Our
    `rfhGen2DetectMagic` derives whatever XOR magic makes slot 1 consistent
    (this fixture derives `0x3E` from stored CS=`0x02`); SINCRO accepts only
    a fixed canonical magic set (modelled here as `RFH_GEN2_VIN_CS_KNOWN_MAGICS
    = [0xDB, 0x87]`) and rejects everything else.  Both verdicts are
    defensible from their own model — surface them side-by-side, do not
    collapse them.  Why we don't tighten our gate: other legitimate fixtures
    (e.g. `SAMPLE_RFH` magic=`0x85`) intentionally rely on the looser self-
    consistency check.  How to apply: when a future panel/report renders a
    Gen2 RFH VIN row, treat `magicKnown=false` as the "SINCRO will reject
    this" signal and show it alongside the OK verdict.
- **RFH EEE SEC16 slot 1** (offset 0x050E): `0000000000000001FC01FFFF00000000` (CRC OK)
- **RFH EEE SEC16 slot 2**:                  `FC011B04F7031B012ECF1B010DF0FFFF` (CRC FAIL)
- **BCM SEC16 (byte-reversed from RFH slot 1)**: `00000000FFFF01FC0100000000000000`
- **PCM SEC6** is blank (`FF FF FF FF FF FF`) with marker `FF FF FF AA` at 0x3C4 present
- **BCM `fobikCount`** raw byte at 0x5862: **66** (0x42) — unusually high; competitor
  flags `ALERT_NO_SECURITY` because the BCM SEC16 was wiped (NEWVIN/virgin SEC)

## Cross-tool sanity rules

1. Any "BCM ↔ RFHUB SEC16 reverse" check **must** produce a PASS verdict on
   this fixture (RFH slot 1 reversed == BCM SEC16 mirror).
2. RFH slot 2 SEC16 should always report **CRC FAIL** — do not "auto-correct"
   it; the file is genuinely damaged on slot 2.
3. VIN must be consistent across all three primary modules (PCM, RFH EEE, BCM).
4. The P-flash file has **no XC22/RFHUB internal banner** — its bytes 0x0000
   and 0x0010 are null.  Filename heuristic promotes it from `FW` to `RFHUB`
   type; do not expect XC2268 VIN slot extraction to work on this fixture.
