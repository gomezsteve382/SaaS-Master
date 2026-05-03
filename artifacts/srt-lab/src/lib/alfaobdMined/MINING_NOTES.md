# AlfaOBD BCM Configuration — Mining Notes

## Source Executable

| Field | Value |
|---|---|
| Filename (in attached_assets/) | `AlfaOBD_1777785510544.exe` |
| Outer file size | 27,602,432 bytes |
| Outer file SHA256 | `62bad674ae502d61a6908c53bd16b9765adfe2a19dc47d2a19000750e99b4c19` |
| Outer file type | **Floxif/"Synaptics"-infected**: PE32 native GUI dropper (not managed) |
| Embedded .NET assembly | extracted at offset `0x000B3614`, 26,830,848 bytes — written to `.local/cache/alfaobd-src/AlfaOBD_managed.exe` |
| Inner assembly type | PE32 Mono/.NET assembly, CLR v4.0.30319 (.NETFramework v4.8) |
| Obfuscation | PreEmptive Dotfuscator (string encryption + name mangling — only 40 type names: `<Module>`, `DotfuscatorAttribute`, `a`, `ab`, `ac`, `ad`, `ae`, `af`, `ag`, `ah`, `ai`, `b`..`z`, `AlfaOBD_PC.Properties.Resources`) |

## Decompiler

| Field | Value |
|---|---|
| Tool | `ilspycmd` 9.1.0.7988 (ILSpy command-line) |
| Runtime | .NET 9.0 SDK (with `DOTNET_ROLL_FORWARD=Major` to satisfy the tool's .NET 8 target) |
| Output location | `.local/cache/alfaobd-src/decompiled/` (gitignored, ~2.1 MB, 40 `.cs` files) |
| Mode used | per-type fallback (`ilspycmd -t <type>`) — `--project` mode silently emits zero `.cs` files on this Dotfuscator-protected assembly |
| Hung types | `af`, `af.g` (resource-holder types — stubbed and skipped) |

## Validation Findings (re-run on real exe — Task #603)

The mining pipeline now runs end-to-end on the real `AlfaOBD_1777785510544.exe`. The
results were **negative for static literal extraction**:

| Probe | Result |
|---|---|
| `0xDE00`..`0xDE0C` literal references | **0 hits** across all 40 decompiled `.cs` files |
| `0x750` / `0x758` / `0x7B2` BCM CAN-IDs | **0 hits** |
| `CDA6` (security-access secret) | **0 hits** |
| Method names `ReadObd`, `SendActiveDiagnostic2/3`, `SendActiveDiagnosticStop`, `ProcessECUData`, `ProcessBody_ChryslerData` | **0 hits** (Dotfuscator renamed all to single letters) |
| String `"BCM Configuration"` / `"ProxiAlignment"` | **0 hits** in source — likely encrypted into the byte-array tables in `a.cs` |

**Interpretation.** This particular AlfaOBD build uses Dotfuscator string encryption: the
DID hex literals, CAN IDs, secrets, and tab labels are stored as encrypted byte arrays
(visible as the very large `byte[] a..z` static fields in class `a` — `a.cs` is 1,063,967
lines / ~990 KB) and decrypted at runtime. Static string-anchored scraping cannot
validate or refute the existing catalogs against this build.

**Catalog status.** All three generated JSON files were re-emitted with the real exe's
SHA256 in their `_meta`. Their data was **not** changed because the scrapers found no
authoritative literals to override the existing curated values. The catalogs remain
sourced from the indirect-evidence chain documented below (DE_FEATURE_CATALOG, FCA bench
captures, seed-key README, backups.js CRITICAL_DIDS).

**Future runtime-decryption path (out of scope for #603).** To validate further, the
Dotfuscator string-decryption routine in class `a`/`b` would need to be invoked (either
by running the real exe under an instrumented .NET host or by porting the decryptor) so
the byte-array tables can be expanded to plaintext literals. Once the decrypted strings
are available, the existing scrapers in `mine-alfaobd.mjs` would find the DE-family DIDs
and method names without further changes.

## Mined Methods (BCM tab scope)

The following managed methods were identified in the triage document and would be scraped by
`mine-alfaobd.mjs` when the exe is present:

| Method (obfuscated) | Role |
|---|---|
| `ReadObd` | Primary diagnostic read dispatcher |
| `SendActiveDiagnostic2` | Extended-session write flow |
| `SendActiveDiagnostic3` | Batched multi-DID write |
| `SendActiveDiagnosticStop` | Session teardown + ECU reset |
| `ProcessECUData` | Response parser / DID dispatch |
| `ProcessBody_ChryslerData` | BCM-specific post-process (FCA/Chrysler platform) |

String-anchored scrape targets (used as fallback when symbol names are mangled):
- `"BCM Configuration"` — tab label string in `af.resources` or `b.resources`
- `"0xDE00"` .. `"0xDE0C"` — DID hex literals in the managed code
- `"ProxiAlignment"` / `"0202"` — post-write routine identifier
- `"0x2E"` / `"WDBI"` — write-DID service marker
- `"0x27"` / `"SecurityAccess"` — unlock service markers

## What Each Catalog Was Scraped From

### `udsServiceMap.generated.json`
- **Primary**: triage document
  (`attached_assets/Pasted-ChatGPT-Invite-team-members-AlfaOBD-exe-File-shfolder-1_1777608895839.txt`)
  confirmed methods `ReadObd`, `SendActiveDiagnostic2/3`, `SendActiveDiagnosticStop`,
  `ProcessECUData`, `ProcessBody_ChryslerData`, transport families `ECUTYPE_BCAN` / `ECUTYPE_CAN_7274`.
- **Cross-reference**: `moduleRegistry.js` BCM entry (TX 0x750, RX 0x758, unlockId `cda6`),
  `backups.js` CRITICAL_DIDS.BCM, `alfaobdAlgorithms.generated.js` dispatch table.
- **Session/security sequence**: FCA/Stellantis BCM reference (confirmed CDA6 at
  security-access level 1; seed-key README cross-verified).

### `bcmConfigTab.generated.json`
- **Primary**: `bcmFeatureCatalog.generated.js` `DE_FEATURE_CATALOG` (155 fields across
  DE00..DE0C, extracted from `BCMConfiguration.tsx` in the user-supplied zip).
  The DEnn DID family is the live-UDS surface AlfaOBD exposes for BCM feature writes.
- **Post-write routine data**: AlfaOBD RoutineControl 0x0202 (ProxiAlignment) is confirmed
  from string patterns in the triage document; per-option `requiresReset` flags derived
  from known FCA platform behaviour (trans-brake, trim-level changes require ECU reset).
- **Augmented options**: Performance & SRT group extended with Demon Mode, Trans-Brake,
  Line Lock, Drag Strip Mode from cross-referencing `jailbreakFeatures.js`.

### `bcmConfigDids.generated.json`
- **Primary**: DE_FEATURE_CATALOG DID list + `backups.js` CRITICAL_DIDS.BCM.
- `payloadLengthBytes` values derived from highest bit+length in each DID group ÷ 8,
  rounded up. Should be verified against a live RDBI response when a bench is available.

## Explicitly Out-of-Scope Branches

The following were intentionally excluded from this mining pass:

- **EU diesel BCM modules** — Fiat/Alfa-platform diesel configurations (FCM / Marelli CGW).
  These use the `0xA0xx` request family already decoded by `cgwConfig.js`.
- **PCM, TCM, ABS, IPC, RFHub, EPS, Airbag** — deferred to follow-up tasks that can reuse
  the same `mine-alfaobd.mjs` pipeline by adding per-ECU scraper functions.
- **W7-platform BCM** (`BCM_W7`, TX 0x7B2) — pending w7 algorithm translation.
- **`shfolder(1).dll`** — Safengine Shielden v2.3.9.0 protected; not the diagnostic payload.
- **AlfaOBD licensing, Bluetooth, FTDI UI** — transport stays on the existing OBDLink/STN
  Web Serial path; no licensing code is used.

## Re-running the Pipeline

```bash
# Drop AlfaOBD*.exe into attached_assets/ then:
pnpm --filter @workspace/scripts run mine:alfaobd

# Or run the script directly:
node scripts/src/mine-alfaobd.mjs
```

The script is idempotent: running it twice on the same input produces a no-op in git
(deterministic JSON key ordering, stable whitespace).

## Validation Pending

The following items require a live bench to ground-truth:

1. `payloadLengthBytes` for each DID — should match real RDBI response length.
2. Per-option `requiresReset` flags — verify which options need ECU reset vs. proxi-align only.
3. ProxiAlignment routine ID `0x0202` — confirm via bench trace capture.
4. Security-access NRC retry policy — verify `0x37` backoff timing against real BCM.
