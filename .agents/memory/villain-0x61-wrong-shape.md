---
name: VILLAIN 0x27/0x61 algorithm shape is wrong
description: The original third-party report describing 0x27/0x61 as CRC16+S-box was refuted by a later VILLAIN memory-dump extraction — level 0x61 actually dispatches to _gpec_calculator (32-bit, no S-box).
---

The `villain27_61.js` algorithm in srt-lab (CRC16 + 4-round mixer + 256-byte S-box) is structurally wrong for UDS security level 0x61.

**Why:** A later VILLAIN memory-dump extraction (uploaded by the user as VILLAIN_GPEC_COMPLETE_EXTRACTION.zip) shows:
- Level 0x61 lives in the binary's Group-4 dispatch and routes to `_gpec_calculator` (GPEC2 base).
- That function uses 32-bit integer arithmetic with constants `q1=0xE72E3799 / q2=0x1B64DB03`, already wired in `algos.js` as `gpec2_q1` / `gpec2_q2` (sxor family).
- A grep over the full extraction (strings dumps + the 77 MB `wiTECH_wde.DMP`) returns zero hits for `FCA_SBox`, `sbox`, `CalculateSecurityKey`, or `security_key_0x61`. **No S-box exists in the binary.**

**How to apply:**
- Do NOT flip `ENABLE_VILLAIN_0x61 = true` in `algos.js`, even if someone proposes "real S-box bytes." There is no S-box to substitute; the entire surrounding algorithm is the wrong shape, and flipping the flag would silence the Swarm CRYPTO-agent's GAP flag with a false positive while still producing keys the ECU rejects with NRC 0x35.
- If a future task asks to "complete the 0x27/0x61 algorithm," the correct ask is the **body of `_gpec_calculator`** extracted from an unpacked `VILLAIN.exe` (not from a memory dump — the upload contained string-table names + constants but no function body), plus ≥3 `(seed → key)` bench captures from a live ECU.
- The corrected intel is now mirrored in `docs/villain-binary-intel.md` §7.3 and in the `securityLevels[0]` + `notes` entries of the VILLAIN report in `src/lib/binaryIntel.generated.js`.
