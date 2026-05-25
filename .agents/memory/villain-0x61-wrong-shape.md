---
name: VILLAIN 0x27/0x61 algorithm shape is wrong
description: The original third-party report describing 0x27/0x61 as CRC16+S-box was refuted by a later VILLAIN memory-dump extraction — level 0x61 actually dispatches to _gpec_calculator (GPEC2 base, 32-bit, no S-box). The dead CRC16+S-box code has been removed.
---

UDS security level `0x27/0x61` on FCA modules dispatches to `_gpec_calculator` (GPEC2 base) — the same 32-bit sxor algorithm already wired in `src/lib/algos.js` as the `gpec2` / `gpec2_q2` entries (constants `q1=0xE72E3799 / q2=0x1B64DB03`). The CRC16 + 4-round mixer + 256-byte S-box shape described by the original third-party report (formerly in `docs/villain-binary-intel.md §7.2`) is structurally wrong and has been removed from the codebase.

**Why:** The `VILLAIN_GPEC_COMPLETE_EXTRACTION.zip` upload proved level 0x61 lives in the binary's Group-4 dispatch and calls `_gpec_calculator`, and that no 256-byte S-box exists anywhere in the binary (grep over the extraction strings + the 77 MB `wiTECH_wde.DMP` returns zero hits for `FCA_SBox`, `sbox`, `CalculateSecurityKey`, or `security_key_0x61`). The dead `villain27_61.js` scaffold, its `ENABLE_VILLAIN_0x61` feature flag, its `villain_0x61` `ALGOS` entry, the `_unverified/villain27_61.candidate.js` companion, and the bench-pair harness were all deleted in a cleanup task.

**How to apply:**
- If a future task asks to "complete the 0x27/0x61 algorithm" or "find the missing FCA_SBox," the premise is wrong. The correct ask is: extract the body of `_gpec_calculator` from an unpacked `VILLAIN.exe` (not from a memory dump — the upload contained string-table names + constants but no function body), and collect ≥3 live `(seed → key)` bench captures to verify the existing `sxor` implementation matches.
- The corrected intel is mirrored in `docs/villain-binary-intel.md §7.3` and in the `securityLevels[0]` + `notes` entries of the VILLAIN report in `src/lib/binaryIntel.generated.js`. `binaryIntelCoverage.classifySecurityLevel(0x61)` now returns `covered` (was `gap`).
