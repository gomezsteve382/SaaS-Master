# asset-sweep

Reproducible Node-only pipeline that walks `attached_assets/` (294 files including
46 nested zips), unpacks every archive recursively into `tools/asset-sweep/.cache/`,
classifies every file, then emits five append-only outputs:

| Output | Path | Purpose |
| --- | --- | --- |
| Inventory | `tools/asset-sweep/inventory.json` | Every file (incl. nested zip entries) with size + sha256 + classification. |
| Report | `tools/asset-sweep/REPORT.md` | Human-readable rollup: counts by category, new vs already-known algorithms / CRCs / UDS data, DLL coverage delta. |
| Extended algorithms | `artifacts/srt-lab/src/lib/extendedAlgorithms.generated.js` | Seed→key algorithms found in `attached_assets/` that are NOT already in `algos.js` / `canflashAlgos.js` / `alfaobdAlgorithms.generated.js`. |
| Extended CRC | `artifacts/srt-lab/src/lib/extendedCrc.generated.js` | CRC / checksum primitives found in `attached_assets/` that are NOT already in `crc.js`. |
| Extended unlock catalog | `artifacts/srt-lab/public/unlock_catalog_extended.json` | Per-DLL records from sweeps that are NOT already in `public/unlock_catalog.json`, plus UDS service / NRC / DID dictionaries lifted from the asset-side Python ports. |

Run from the repo root:

```sh
pnpm sweep:assets        # write outputs
pnpm sweep:assets:check  # parity check (CI mode — fails if outputs would change)
```

## Determinism

* All outputs are sorted (object keys, array entries) so byte-identical re-runs
  produce byte-identical files.
* The walker only reads under `attached_assets/`. It never deletes / renames
  source files. The unpack cache lives under `tools/asset-sweep/.cache/` and
  is recreated on every run.
* Ground-truth comparators are loaded from the live source files in
  `artifacts/srt-lab/src/lib/` so adding a new algorithm to the in-app catalog
  automatically removes it from the generated "extended" catalog on the next
  sweep.

## What it does NOT do

* Does NOT decompile DLLs or EXEs. DLL-only coverage entries are tagged
  `status: "dll_only"` with a reason and the DLL's sha256 / size.
* Does NOT modify the existing `unlock_catalog.json`, `algos.js`,
  `canflashAlgos.js`, `crc.js`, or any unlock chain. The three generated
  catalogs are strictly **append-only** — they live in their own files and the
  consumer tabs merge them at runtime.
* Does NOT redesign any UI. SeedTab gains an "extended" picker section behind
  the existing ALL chip; UnlockCoverageTab simply concatenates the extended
  entries into the table with an "asset sweep" provenance tag.
