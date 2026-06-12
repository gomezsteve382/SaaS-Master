# AlfaOBD `w7` seed-key family — advanced extraction

**Goal:** close the last open gap in the AlfaOBD mine — the `w7` cipher family
that covers **360 ECUs**. (The `w6` family / 380 ECUs and the 3 top ciphers
`ht`/`f`/`ao` were already fully translated and cross-verified Python↔JS.)

## What was blocking it
The prior pass mapped `w7`'s call graph but stopped:
> *"Full algebraic translation requires C# decompilation of 20+ helper methods."*
No decompiler (dnSpy/ILSpy/mono) was available, so the helper bodies were never
recovered.

## What this pass did (deterministic — from the real binary)
Built a pure-Python IL disassembler on top of `dnfile` (no .NET runtime needed)
and ran it against the **actual managed assembly** (`AlfaOBD_managed.exe`, the
26 MB .NET 4.0 blob unpacked from the Delphi stub).

Delivered here:
- **`il_disassembler.py`** — reusable IL disassembler + helper-chain tracer
  (resolves call/field tokens to names + row indices).
- **`w7_full_il.txt`** — full IL of the **`w7` core (row 199, 193 bytes) and all
  28 methods in its call chain** — every helper the prior pass couldn't reach.
- **`w7_static_constants.json`** — the FieldRVA-backed cipher constants
  (incl. the `n`/`o`/`p` arrays the core loads, and limb constant `d`).

## What the IL proves (fact, not inference)
- The `w7` core (`ad::w7`) reads the 4-byte seed, byte-permutes it
  (`m`=limb-shift-right, `o`=limb-shift-left, `j`=carry-add reassembly into a
  rotated word), then combines it with static arrays `n,o,p` through the
  big-integer helpers.
- Every helper does `ldlen` on its argument ⇒ operands are **limb arrays**, so
  `w7` is a genuine **multi-precision integer cipher**, confirming the
  PROVENANCE "big-integer cipher" claim directly from bytecode:
  - `j` (row 1086) — sizes result `max(len)+1`, calls `i` ⇒ **carry-propagating ADD**
  - `h`/`l` (rows 1088/1084) — size `max(len)`, call `g`/`k` ⇒ **per-limb XOR/AND-and-carry mix**
  - `o`/`m` (rows 1076/1082) — size `len - k*d`, call `g`/`l` ⇒ **limb shift / divmod-reduce**
  - second-layer primitives: `g`(row 1100) = **DIV/MOD**, multiply + buffer-alloc
    helpers, string→bignum and hex→bytes converters.

## To FINISH + TRUST w7 (two concrete steps)
1. **Translate the 28 limb helpers to JS/Python.** Now fully scoped — every IL
   body is in `w7_full_il.txt`; no further binary access needed. (This is
   careful work, not research: schoolbook bignum add/mul/divmod on `d`-sized
   limbs.)
2. **Verify against ONE real `(seed, key)` pair** from any w7 ECU on the bench.
   ⚠️ Per the tool's trust rules (algoProvenance: never present a guess as a
   fact), `w7` **must stay tagged `unverified`** until this pair confirms it.
   Without a bench capture, a translation can be structurally complete and still
   be one endianness/limb-order bug away from wrong keys — exactly what this tool
   must never ship as "working".

## Status line
`w7`: **disassembled in full (was: pending decompilation). Translation scoped,
not yet written. Verification: blocked on one bench seed/key pair.**
Everything else in AlfaOBD (DB XOR-cracked, strings de-Dotfuscated, w6/ht/f/ao
translated, UDS+routine catalogs) is done.
