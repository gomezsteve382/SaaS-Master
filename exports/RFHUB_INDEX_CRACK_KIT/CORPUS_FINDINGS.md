# CORPUS FINDINGS — no genuine single-key-add pair exists in the bundled dumps

Status: **NEGATIVE / CONCLUSIVE.** This documents an exhaustive search for a real
before/after RFHUB EEPROM pair that differs by exactly ONE added transponder key
(the ground-truth deliverable the `BEFORE_AFTER_PROTOCOL.md` capture is meant to
produce). No such pair is present in `dumps/`, so the placement rule used by
`addCharKey` / `diffCharKeyTables` **cannot be bench-verified from this corpus**.

## What was searched

The search has been **re-run against the full current corpus** using the
in-app `diffCharKeyTables` harness directly (not just the frozen `dumps/`
snapshot). Every 4 KB MPC-class RFHUB image in `attached_assets/` that parses as
a valid Charger 8-slot key table was compared pairwise in both directions:

- **57 valid key-table images / 11 distinct master secrets** (up from the
  original 51 files / 5 masters as more bench dumps were added). 2,582 ordered
  pairs carried a key-set delta.
- Key set per image = the 6-byte key records (mirror-matched, flag `0x01`/`0x03`)
  carved from the 8-slot key table at `0xC5E` (stride 16).
- Master secret per image = 16 bytes at `0x226`.

## Result

- **Genuine single-key-add pairs found: 0** (added = 1, removed = 0, master
  unchanged). The negative result holds on the larger corpus.
- **Every pair that shares the same master secret is byte-identical in its key
  set.** Same vehicle → no key delta. (0 same-master key-delta pairs.)
- **Every pair whose key set differs also has a DIFFERENT master secret**
  (all 2,582 deltas). A changed master @`0x226` is the signature of a full
  re-key / cross-vehicle pairing, not an offline add of one key to an existing
  vehicle.

There is therefore no `(before, after)` where the only change is one new key
record with the master held constant. The single-key-add delta this kit was
built to capture is simply not in the data we have.

## Harness readiness (self-consistency check)

`diffCharKeyTables` was confirmed ready to validate the first real capture: a
synthetic single-add (`addCharKey` applied to a real before-image) is reported
exactly as required — `isSingleKeyAdd: true`, `masterChanged: false`,
`addedSlotMatchesRule: true` (highest free slot), and **`companionRegions: []`**.
The 6 assertions in `charRfhubKeyDiff.test.js` all pass. So the moment a real
before/after pair is supplied, the harness answers the two open questions (slot
placement + companion table) with no further code changes.

## Consequence for the tool

- `addCharKey` places a new key in the **highest free slot** and computes the
  index byte as `(0xFE - flag - sum(keyId)) mod 255` (the unified record
  checksum that folds in the family flag). Both are **corpus-aligned**
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
