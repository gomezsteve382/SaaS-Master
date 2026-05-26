---
name: AlfaOBD .db recovery technique
description: How to extract routine ID→label mapping from the partially-decrypted AlfaOBD SQLite database when the schema page is corrupt
---

## Setup
AlfaOBD ships an XOR-encrypted SQLite database. A 1024-byte repeating XOR key has been recovered to ~90-95% accuracy; applying it produces a `decrypted.db` whose magic is valid (`SQLite format 3\0`) but whose `sqlite_schema` page is mangled. `sqlite3 .tables` returns "database disk image is malformed" and refuses to do anything.

## The key insight
`sqlite3 decrypted.db ".recover"` succeeds anyway. It walks B-tree pages directly and reconstructs cell data without needing the schema. Output: 54,218 rows of SQL with 0 errors, all dumped into a single `lost_and_found(rootpgno, pgno, nfield, id, c0..c121)` table because `.recover` cannot reattach rows to original table names.

Loading that SQL into a fresh db gives a fully-queryable corpus. Group rows by `(rootpgno, nfield)` to reassociate fragments of the same original table — each original table's pages share a rootpgno, and most table fragments hold consistent column counts.

## What is recoverable
- Routine description table: **3,806 distinct routine IDs** with multilingual labels (EN/DE/CZ/ES/IT/FR/HU/PL/RU/TR). All 8 Tier-1 IDs confirmed:
  - 1126 BCM secret-key transfer, 1367 LF TPMS sensor program, 1520 O2 heater test (and BCM-replace context), 1750/1751 likely paired
  - 2504 RF-HUB Reset/Replace, 2505 key-status, 2507 FOBIK program highline, 2508 transfer secret key
- Pattern to find this table: `WHERE nfield=14 AND typeof(c0)='integer' AND c0 BETWEEN 1 AND 9999`. c0 is the routine ID, c1=English, c2=German, c3=Czech, etc.

## What is NOT recoverable from this corpus
- The routine **dispatch payload** table (routine_id → UDS bytes / RoutineControl frame template). Searching by routine ID as int hits only the descriptions table. Dispatch is presumably in a different rootpgno fragment with a different column shape, but no candidate has been identified yet.
- The other Claude's other quantitative claims do NOT survive the actual data:
  - "20,043 P/B/C/U DTC codes" → 0 found in this format
  - "285 wiTECH endpoints (getKeyCodes, getPROXI, ...)" → only 1 matches the camelCase pattern (getRAG)
  - "538 VINs" → 2 found

## How to apply
- Trust `.recover` over `.tables`/`PRAGMA integrity_check`. The schema layer is the most XOR-sensitive part of a SQLite file; cell data tolerates partial corruption fine.
- Reassociate fragments by `(rootpgno, nfield)` grouping before searching for content.
- Decode column bytes with `conn.text_factory = bytes` to avoid the non-UTF8 columns aborting the whole scan.
- The "5-10% byte corruption" claim from the other Claude is real but localized; descriptions read cleanly, only some neighboring columns (where obfuscated Dotfuscator strings live) show the residual mangling.

**Why:** the AlfaOBD mining handoff was advertised as "fgaipcroutines physically unrecoverable, only text extraction possible." That's wrong. The recoverable layer is much richer than they claimed, and several headline numbers ("20k DTCs", "285 endpoints") don't survive a direct check — useful warning before trusting any AlfaOBD-derived catalog without spot-checking.
