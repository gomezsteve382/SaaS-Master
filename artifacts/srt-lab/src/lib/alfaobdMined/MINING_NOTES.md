# AlfaOBD BCM Configuration — Mining Notes

## Source Executable

| Field | Value |
|---|---|
| Filename | `AlfaOBD.exe` |
| SHA256 | **not available** — exe not present in `attached_assets/`; re-run `scripts/src/mine-alfaobd.mjs` when the exe is dropped there |
| App Version | v2.5.7.0 (from triage document) |
| Timestamp | 2025-08-24 07:53:45 UTC |
| Type | PE32 .NET GUI executable, CLR v4.0.30319 |
| Obfuscation | PreEmptive Dotfuscator (managed names mangled) |

## Decompiler

| Field | Value |
|---|---|
| Tool | `ilspycmd` (ILSpy command-line, v9+) |
| Output location | `.local/cache/alfaobd-src/` (gitignored) |
| Resource extractor | `node scripts/src/mine-alfaobd.mjs --resources` |

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
