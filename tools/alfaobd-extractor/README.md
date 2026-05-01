# `@workspace/alfaobd-extractor`

A repeatable, deterministic pipeline that turns a user-supplied
`AlfaOBD.exe` (32-bit .NET 4 GUI build) into structured JSON the SRT
Lab can browse. Designed so the binary itself never lands in the repo.

## What it produces

Default output dir: `artifacts/srt-lab/public/alfaobd-tables/`.

```text
alfaobd-tables/
├── manifest.json          — schema version, AlfaOBD identity, hashes,
│                            shfolder fingerprint, decompiler info,
│                            list of every emitted file with sha256
├── ecutypes/
│   ├── ECUTYPE_KWP2000.json
│   ├── ECUTYPE_BCAN.json
│   ├── ECUTYPE_BOOT_DR_MARELLI.json
│   └── …  (one file per ECUTYPE_* family)
├── handlers.json          — Process*Data inventory (calls, UDS services touched)
├── transports.json        — J2534 / SAE.J2534 / J2534-Sharp / SerialPort /
│                            Stn.Ftdi / BluetoothClient / Socket
├── resources.json         — managed resource bundle names + media index
└── media/                 — carved PNG/GIF/JPEG, original logical names preserved
```

Every JSON file is validated against `src/schema.mjs` before it is
written. If the decompiled output deviates from the schema the pipeline
fails loudly instead of producing a half-broken contract.

## What it does not do

* It does NOT scrape the historic `Pasted-ChatGPT-…AlfaOBD-exe-…` chat
  transcript in `attached_assets/`. Without the binary present there is
  literally nothing to extract.
* It does NOT attempt to bypass, unpack, or otherwise defeat
  Safengine Shielden v2.3.9.0 on `shfolder(1).dll`. The DLL is parsed
  purely as a PE: imports, exports (including the tell-tale
  `chichitoworkshop`), section entropy, and protector signature. The
  manifest records the result with `protected_skip: true`.
* It does NOT execute the AlfaOBD app. Everything is static analysis of
  decompiled C# and PE structures.

## Prerequisites

1. **The AlfaOBD binary.** Drop it at `attached_assets/AlfaOBD.exe`.
   Optionally drop `attached_assets/shfolder(1).dll` so the manifest
   captures its identity.
2. **A .NET decompiler — pinned version.** Default is `ilspycmd` (a
   `dotnet` global tool). The pipeline pins to **`ilspycmd 9.0.0.7833`**
   so re-runs against the same `AlfaOBD.exe` produce byte-identical
   JSON and `manifest.json` sha256s. Install exactly that version:
   ```bash
   dotnet tool install -g ilspycmd --version 9.0.0.7833
   ```
   If you already have a different version installed:
   ```bash
   dotnet tool uninstall -g ilspycmd
   dotnet tool install   -g ilspycmd --version 9.0.0.7833
   ```
   The pipeline calls `ilspycmd <exe> -p -o <out_dir>` to produce a C#
   project. To plug in a different decompiler, set
   `EXTRACTOR_DECOMPILE_CMD` (e.g. `"--out {{OUT}} --in {{INPUT}}"`)
   and pass the binary name with `--decompiler`. With a custom decompiler
   the pin is skipped unless you explicitly pass `--decompiler-version`.

## Run it

```bash
node tools/alfaobd-extractor/extract.mjs
```

Useful flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--binary <path>`             | `attached_assets/AlfaOBD.exe`             | source PE |
| `--shfolder <path>`           | `attached_assets/shfolder(1).dll`         | optional DLL to fingerprint |
| `--out <dir>`                 | `artifacts/srt-lab/public/alfaobd-tables` | output root |
| `--decompiler <cmd>`          | `ilspycmd`                                | overrides decompiler binary |
| `--decompiler-version <ver>`  | `9.0.0.7833` (the pin)                    | require an exact decompiler version |
| `--allow-decompiler-version-mismatch` | (off)                             | skip the pin check (NOT recommended for committed output) |

Equivalent env vars: `EXTRACTOR_DECOMPILER_VERSION`,
`EXTRACTOR_ALLOW_DECOMPILER_VERSION_MISMATCH=1`,
`EXTRACTOR_DECOMPILE_CMD` (custom decompiler invocation template).

Failure modes you will actually see:

| Exit | Reason | Fix |
| --- | --- | --- |
| `missing_binary`               | `AlfaOBD.exe` not at the configured path        | drop the file in `attached_assets/` |
| `missing_decompiler`           | `ilspycmd` not on `$PATH`                       | `dotnet tool install -g ilspycmd --version 9.0.0.7833` |
| `decompiler_version_mismatch`  | Resolved decompiler version ≠ pinned version    | install the pinned version (see error message), or pass `--decompiler-version <X.Y.Z>` to bump the pin for this run |
| `not_dotnet`                   | The PE has no COR20 directory                   | wrong file — must be the managed `.exe`, not a packed wrapper |
| `decompile_failed`             | Decompiler exited non-zero                      | check `stderr` from the decompiler output |
| `schema_failed`                | Output didn't match `src/schema.mjs`            | indicates a parser regression — see the failing field path |

## Upgrading the pinned decompiler

The pin is intentional: bumping it can change whitespace, member
ordering, or even structural choices in the generated C#, which then
changes the parsed JSON and every downstream sha256 in
`manifest.json`. Treat an upgrade like a contract change:

1. Decide on the new version (e.g. `9.1.0.7984`).
2. Edit `PINNED_DECOMPILER_VERSION` in
   [`src/extract.mjs`](./src/extract.mjs).
3. Update the install command + version reference in this README
   (search for the old version string).
4. Reinstall locally:
   ```bash
   dotnet tool uninstall -g ilspycmd
   dotnet tool install   -g ilspycmd --version <new-version>
   ```
5. Re-run the pipeline against the same `AlfaOBD.exe`. Diff
   `manifest.json` and the per-family ECUTYPE files vs. the previous
   pin so the impact of the bump is documented.
6. Commit the pin change *and* the freshly regenerated outputs in the
   same commit so consumers stay in sync.

For a one-off run against a non-pinned version (e.g. you are evaluating
a candidate upgrade), use `--decompiler-version <X.Y.Z>` instead of
editing the source. The manifest will record `version_pin_enforced: true`
with that one-off version — which is *not* what you want to commit as
the canonical output.

## Test it

```bash
node --test tools/alfaobd-extractor/tests
```

The schema-validation test runs against any extracted output present
under `artifacts/srt-lab/public/alfaobd-tables/`. When that directory
is empty (fresh checkout, no binary supplied yet) the test is skipped
cleanly so CI does not falsely fail.

## SRT Lab integration

The SRT Lab "AlfaOBD Tables" tab fetches `manifest.json` from this
output directory at runtime. When `manifest.json` is missing the tab
shows an explicit empty state pointing the user back at the command
above — no silent placeholder data.
