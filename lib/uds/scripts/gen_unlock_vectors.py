#!/usr/bin/env python3
"""Generate golden (seed -> key) vectors from the byte-verified Python
seed-key dispatcher, so the TypeScript port in src/seedkey.ts can be proven
byte-identical in CI.

Source of truth: tools/python-bridge/tools/canflash_seedkey.py
  - `_DLL_ALIASES`        : dll-basename -> verified unlock fn (the dispatcher
                            path that the python bridge actually calls)
  - `VERIFIED_ALGORITHMS` : logical module name -> same fn objects

We iterate `_DLL_ALIASES` (1:1 with functions), run each over a fixed seed
set, and emit src/__tests__/unlock_vectors.generated.json. The TS test asserts
every ported algorithm reproduces these exact outputs.

Re-run after changing canflash_seedkey.py:  python lib/uds/scripts/gen_unlock_vectors.py
"""
import inspect
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "tools", "python-bridge", "tools")
)
OUT = os.path.normpath(
    os.path.join(HERE, "..", "src", "__tests__", "unlock_vectors.generated.json")
)
sys.path.insert(0, TOOLS)

import canflash_seedkey as ck  # noqa: E402

# Fixed seed set: 16-bit-range values first (real seeds are 16-bit for most
# modules), then 32-bit values to exercise the wider algorithms (gpec, edc16,
# sas, cvt, hidt, lcg-pair...). Every function masks its own input, so feeding
# the same value to a 16-bit algo is harmless — what matters is TS==Python on
# the identical input.
SEEDS_1 = [
    0x0000, 0x0001, 0x8000, 0xFFFF, 0x1234, 0xABCD, 0x5A5A, 0xCAFE,
    0xBEEF, 0xDEAD, 0x0F0F, 0x7F80,
    0x12345678, 0xDEADBEEF, 0xCAFEBABE, 0xFFFFFFFF, 0xA5A5A5A5, 0x5A5A5A5A,
]
SEEDS_2 = [
    (0, 0), (1, 0), (0, 1),
    (0x12345678, 0xDEADBEEF), (0xFFFFFFFF, 0xFFFFFFFF),
    (0xCAFEBABE, 0xA5A5A5A5), (0x11223344, 0x55667788),
    (0x80000000, 0x00000001), (0xF5377B24, 0xF5377B4B),
]


def _run(fn, two):
    if two:
        return [[[a, b], int(fn(a, b)) & 0xFFFFFFFF] for a, b in SEEDS_2]
    return [[s, int(fn(s)) & 0xFFFFFFFF] for s in SEEDS_1]


def main():
    algorithms = {}
    errors = {}
    # The dispatcher dict (`_DLL_ALIASES`) captured the *early* function objects,
    # so for several modules it points at a stale/broken definition (the
    # LCG-pair family even raises TypeError). The authoritative, most-recently
    # verified algorithm is the module-global `unlock_<name>`. Prefer that, and
    # record where the live dispatcher disagrees so the Python side can be fixed.
    dispatcher_mismatches = {}
    for name, alias_fn in sorted(ck._DLL_ALIASES.items()):
        fn = getattr(ck, "unlock_" + name, alias_fn)
        try:
            argc = fn.__code__.co_argcount
        except Exception:
            argc = 1
        two = argc >= 2
        try:
            vectors = _run(fn, two)
        except Exception as exc:  # pragma: no cover - diagnostic only
            errors[name] = repr(exc)
            continue
        algorithms[name] = {"argc": 2 if two else 1, "vectors": vectors}

        # Diagnostic: does the live dispatcher (alias) match the verified global?
        if alias_fn is not fn:
            try:
                alias_argc = alias_fn.__code__.co_argcount
                alias_vecs = _run(alias_fn, alias_argc >= 2)
                if alias_vecs != vectors:
                    dispatcher_mismatches[name] = "alias output differs from verified global"
            except Exception as exc:
                dispatcher_mismatches[name] = f"dispatcher path raises: {exc!r}"

    # logical module name -> dll-basename key (so the TS dispatcher can map
    # 'BCM' -> huntsville_bcm, 'PCM_GPEC' -> gpec, etc.)
    logical = {}
    for lname, fn in sorted(ck.VERIFIED_ALGORITHMS.items()):
        match = next((n for n, f in ck._DLL_ALIASES.items() if f is fn), None)
        if match:
            logical[lname] = match

    result = {
        "_meta": {
            "source": "tools/python-bridge/tools/canflash_seedkey.py (_DLL_ALIASES dispatcher)",
            "note": "GENERATED — do not edit by hand. Regenerate via lib/uds/scripts/gen_unlock_vectors.py",
            "algorithmCount": len(algorithms),
            "seedsPerAlgo1Arg": len(SEEDS_1),
            "seedsPerAlgo2Arg": len(SEEDS_2),
        },
        "logicalNames": logical,
        "algorithms": algorithms,
    }
    if errors:
        result["_meta"]["errors"] = errors
    if dispatcher_mismatches:
        result["_meta"]["dispatcherMismatches"] = dispatcher_mismatches

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
        f.write("\n")

    # Sanity: the canonical huntsville_bcm DLL vector must hold.
    assert ck.unlock_huntsville_bcm(0x1234) == 0x526C, "huntsville_bcm anchor broke"
    print(f"Wrote {OUT}")
    print(f"  algorithms: {len(algorithms)}   logical names: {len(logical)}")
    if errors:
        print(f"  errors: {errors}")


if __name__ == "__main__":
    main()
