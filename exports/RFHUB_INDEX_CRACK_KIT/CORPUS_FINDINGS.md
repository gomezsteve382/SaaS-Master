# CORPUS FINDINGS — no genuine single-key-add pair exists in the bundled dumps

Status: **NEGATIVE / CONCLUSIVE.** This documents an exhaustive search for a real
before/after RFHUB EEPROM pair that differs by exactly ONE added transponder key
(the ground-truth deliverable the `BEFORE_AFTER_PROTOCOL.md` capture is meant to
produce). No such pair is present in `dumps/`, so the placement rule used by
`addCharKey` / `diffCharKeyTables` **cannot be bench-verified from this corpus**.

## What was searched

Every dump in `dumps/` (~51 files, 4 KB MPC-class images) was compared pairwise:

- Key set per image = the 6-byte key records (mirror-matched, flag `0x01`/`0x03`)
  carved from the 8-slot key table at `0xC5E` (stride 16).
- Master secret per image = 16 bytes at `0x226`.

## Result

- **Every pair that shares the same master secret is byte-identical in its key
  set.** Same vehicle → no key delta.
- **Every pair whose key set differs also has a DIFFERENT master secret.** A
  changed master @`0x226` is the signature of a full re-key / cross-vehicle
  pairing, not an offline add of one key to an existing vehicle.

There is therefore no `(before, after)` where the only change is one new key
record with the master held constant. The single-key-add delta this kit was
built to capture is simply not in the data we have.

## Consequence for the tool

- `addCharKey` places a new key in the **highest free slot** and computes the
  index byte as `(0xFD - sum(keyId)) mod 255`. Both are **corpus-aligned**
  (consistent with the contiguous, ending-at-slot-8 layout seen across the
  surveyed dumps and the six known keys) but remain **NOT bench-verified** —
  no live before/after start confirms the firmware reads a key written this way.
- A **companion table** elsewhere in the EEPROM may also need a matching entry.
  Because no single-add pair exists, we cannot confirm or rule this out from the
  corpus. `diff_dumps.mjs` (and the in-app `diffCharKeyTables`) now report any
  changed run **outside** the key table and master window as a companion-table
  candidate precisely so the first real capture answers this immediately.

## How to close this out (when a real pair is captured)

1. Capture `before.bin` / `after.bin` per `BEFORE_AFTER_PROTOCOL.md` (one key,
   master unchanged, no virginize between reads).
2. `node diff_dumps.mjs before.bin after.bin` — confirm:
   - exactly one NEW key record, no REMOVED records, master UNCHANGED;
   - the added slot matches the **highest-free-slot rule** (`MATCH ✓`);
   - **companion-table candidates: NONE** (or capture the run that appears).
3. The same assertions are encoded in
   `artifacts/srt-lab/src/lib/__tests__/charRfhubKeyDiff.test.js` against
   `diffCharKeyTables`; drop the real pair into
   `artifacts/srt-lab/src/lib/__fixtures__/realDumps/` and the harness validates
   it directly.
4. Only then upgrade the EXPERIMENTAL banner in `CharRfhubKeyAdderPanel.jsx` to
   bench-verified.

**Do not fabricate a pair to make any of the above pass.** A synthesized "real"
dump defeats the entire purpose of the verification.
