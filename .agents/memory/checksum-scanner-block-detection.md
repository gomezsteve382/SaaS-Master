---
name: Checksum scanner block/partial-range detection
description: Durable decisions for the per-block / partial-range checksum scan shared by the Python scanner and its JS mirror.
---

# Checksum scanner: per-block / partial-range detection

The firmware checksum scanner exists twice and must stay mirrored: a Python
scanner and a JS module of the same name in srt-lab. Both scan for stored
checksums as a whole-file/prefix probe AND a per-block probe, and report which
byte range each checksum covers so mid-file (non-prefix) checksums are
distinguishable from byte-0 prefixes. Canonical real case: ZF-8HP TCU = 8×64KB
blocks, each sealed with a big-endian CRC32 at the block end.

## Two hard-won rules (don't relearn these the hard way)

1. **Per-block scan must be CRC-only.**
   **Why:** sum/xor algorithms trivially "validate" over uniform padding (e.g.
   xor of an odd run of 0xFF equals the stored 0xFF bytes). That floods the
   capped result list and evicts the genuine checksum — it once broke the BCM
   sum8 detection. CRCs don't match a uniform region unless the author actually
   wrote the CRC there, so they stay trustworthy per-block.
   **How to apply:** if you add a new algorithm, only add it to the per-block
   set if it's a real CRC; sum/xor stay prefix-only.

2. **Do NOT add a "skip uniform windows" guard to the block scan.**
   **Why:** it looks like robustness but it discards *real* padding-block CRCs.
   ZF-8HP blocks 3-7 are all-0xFF padding that legitimately carry a matching
   CRC32 trailer; skipping them drops 5 of 8 detections. Rule 1 plus the
   existing "stored bytes must be non-zero" match check already prevent
   false positives, so the skip is pure loss.

## Block-scheme acceptance gate
A (blockSize, algo) scheme is only accepted when at least two blocks validate AND
at least half of the probed blocks validate. This rejects coincidental
single-block matches without needing the uniform-window skip.

## Consumer gap (still open)
The api-server route that fronts the scanner is a passthrough that does not yet
forward the coverage-start field or the partial-range repair parameter, and no UI
imports the JS module. Wiring partial-range coverage/repair end-to-end is a
tracked follow-up.

## Env gotcha
The asset-sweep `--check` can crash on cache cleanup (overlayfs ENOTEMPTY, shell
rm fallback also fails). It's not real drift — clear `tools/asset-sweep/.cache`
and re-run.
