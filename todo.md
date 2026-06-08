# SRT Lab Web — Project TODO

- [x] Project scaffold (React 19 + Tailwind 4 + Express + tRPC + Drizzle)
- [x] Clone real SaaS-Master repo and copy SRT Lab source tree
- [x] Install external dependencies (fflate, jspdf, @radix-ui/react-toast)
- [x] Copy @workspace/uds package and configure Vite alias
- [x] Upload vehicle images to S3 and update vehicles.js references
- [x] Replace bcm-cat PNG imports with S3 URL module (bcm-cat-urls.js)
- [x] Database schema: users, sessions, uploads, operations, audit_logs, backups
- [x] Database query helpers (db.ts) for all tables
- [x] tRPC router with sessions, uploads, operations, and audit procedures
- [x] Wire /api/backups REST endpoint (POST, GET list, GET by id, DELETE one, DELETE all)
- [x] Variant-aware RFHUB Gen2 VIN writing with XOR-magic checksum (no crc8rf)
- [x] SEC16 sync (BCM-to-RFH byte-reversal with crc8_65 checksum)
- [x] Byte-level diff reports
- [x] Three-way comparison
- [x] Controlled candidate export with confirmation gate (exportSafetyGate.js)
- [x] Safe-mode write guard with structured machine-readable refusals
- [x] Module inspector panel
- [x] Audit log persistence in database
- [x] TypeScript: 0 errors
- [x] All tests passing (8 tests across 2 test files)
- [x] App renders correctly with vehicle selection screen
- [x] Fix React animation/animationDelay shorthand conflict in VehicleCard
- [x] Add RFHUB SEC16 repair option in Security Sync tab (one-click fix when RFHUB is mismatched/virgin, writes reverse(BCM SEC16) to RFHUB Gen2/Gen1/XC2268 slots)
- [x] Workflow tab: auto-show fix plan immediately when files are loaded (no job creation required); job creation becomes optional for save/sign-off only
- [x] Add HITAG AES key status reader tab (HitagAesTab) — parse SK0-SK3, Chip ID, Config/Page1/Page2, detect blank/programmed/locked state, decode FCA vehicle secret and FOBIK binding
- [x] HitagAesTab: Add "Save as Blank Key Reference" button — persist Chip ID + SK0-SK3 + verdict to database as a named blank reference entry
- [x] Promote 2021 Redeye alt-family keys (CF324E65) to KNOWN_WORKING_KEYS with confirmed blank profile (SK0=11112222, SK1=33334444, SK2=55556666, SK3=77778888, flag=0x03)
- [x] Proactive mismatch banner on Dumps tab: sticky alert when BCM VIN is blank, RFHUB SEC16 mismatches BCM, or VIN cross-mismatch detected — with one-click navigation to the fix tab
- [x] Fix Gen2 RFHUB VIN checksum bug: when OG file stores VIN forward (old format), magic must be recomputed for reversed storage orientation — magic_for_write = og_magic ^ XOR(og_forward) ^ XOR(og_reversed)
- [x] RFHUB key transplant: rfhubKeyTransplant.js — parse key ring buffer (8-byte slots, 0x5A5A9500FFFF empty marker, entries stored twice), find write pointer, extract donor keys, inject into target at write pointer, export patched bin
- [x] RFHUB key transplant: RfhubKeyTransplantPanel.jsx UI — donor file drop, target file drop, key list preview, inject button, download patched bin
- [x] RFHUB key transplant: wire panel into RfhubTab as a new sub-section
- [x] RFHUB key transplant: vitest tests for parse, inject, and duplicate-detection
- [x] RFHUB 4KB EEPROM: Autel ID decoder (ring buffer bytes 0-3 reversed) in key ring buffer parser
- [x] RFHUB 4KB EEPROM: Master Transponder panel (0x0226, 14 bytes, display only)
- [x] RFHUB 4KB EEPROM: Dual-file key transplant (copy auth sector 0x0100-0x027F + ring buffer 0x0C5E-0x0CDD from donor to target)
- [x] Promote RFHUB Key Transplant to its own top-level workspace tab (visible on the workspace page after selecting a vehicle)
- [x] KEY TRANSPLANT: transplant history log (timestamped entries in Dumps workspace after each successful transplant)
- [x] KEY TRANSPLANT: XC2268 RFHUB warning banner (if either file is XC2268, show clear unsupported warning)
- [x] KEY TRANSPLANT: bench simulation diff display (show expected vs actual byte diff in UI after transplant)
- [x] KEY TRANSPLANT gap: detect RFHUB type BEFORE 4KB validation so XC2268 files show the warning banner instead of a generic validation error
- [x] KEY TRANSPLANT gap: persist transplant history to Dumps workspace (tRPC backups table) in addition to localStorage
- [x] KEY TRANSPLANT gap: rename bench diff to 'patched-vs-target byte diff' and clarify it shows what bytes the transplant changed (not a reference comparison)
- [x] KEY TRANSPLANT gap: surface transplant history entries in BackupsTab (Dumps workspace) with dedicated detail view, TRANSPLANT badge, and proper row rendering
- [x] KEY TRANSPLANT bug: tab was invisible because keytransplant was missing from WORKSPACE_CATEGORIES — added to PROGRAM category
- [x] Promote KEY TRANSPLANT tab to primary sidebar (always visible without opening Advanced drawer)
- [x] Check/fix HITAG AES tab category mapping (added to ANALYZE category)
- [x] Push updated build to GCP production VM — SKIPPED (GCP has different app; Manus-hosted version is already live)
- [x] Add HITAG AES to primary sidebar (always visible like KEY TRANSPLANT)
- [x] Reorder primary sidebar for logical workflow (diagnostics → VIN/security → keys → OBD → AI)
- [x] Export project to GitHub repo (pushed to srt-lab-bench branch on mjremetio/goatmez-autoshop-crm)
- [x] Quick Clone wizard: multi-step guided flow combining VIN patch → Security Sync → Key Transplant into one seamless process
- [x] HITAG AES tab: add file upload zone (accepts .bin transponder dumps and photo references) with drag-and-drop support
- [x] Wire up /api/anthropic/key-photo server endpoint using LLM vision for photo OCR extraction of HITAG AES key data
- [x] Add "Compare to Blank" button in HITAG AES tab to highlight SK page differences vs saved blank references
- [x] Add VVDI text paste support (parse P0: XXXXXXXX P1: XXXXXXXX... format) to HITAG AES tab
- [x] Improve HITAG AES photo OCR: rewrite /api/anthropic/key-photo with comprehensive HITAG 2 + HITAG AES layout prompt, extract all fields (Chip ID, Param Low/High SK, Chip Info Low/High SK, Config Page, Page 0-3, AES SK0-SK3), add AI OCR Extract dark panel in UI showing raw extracted values before form autofill
- [x] RFHUB key type detector: analyze loaded RFHUB dump bytes to detect HITAG 2 vs HITAG AES calibration, show banner with required blank key part number and programming instructions
- [x] AUDIT: Verify VIN patching byte offsets and logic for BCM, RFHUB Gen1/Gen2/XC2268, and PCM
- [x] AUDIT: Verify all checksum algorithms (CRC16, XOR, VIN-area CRC) for all module types
- [x] AUDIT: Verify security byte matching — BCM SEC16, RFHUB SEC16 reversal, PCM SEC6 derivation
- [x] Fix RFHUB Gen2 VIN checksum bug in writeModuleVIN and patchFile: use rfhGen2VinCs (XOR^magic) for 4KB Gen2, crc8rf for 8KB doubled variant
- [x] Add regression tests: RFHUB 4KB Gen2 VIN write round-trip (writeModuleVIN + patchFile both produce csOk=true on re-parse)
- [x] Audit XC2268 and PCM VIN patch paths with fixture-backed tests (XC2268 uses dedicated patcher, PCM uses synthetic fixture without CRC)
- [x] Document Gen1 RFHUB SEC16 checksum unverified status (no real 2KB dump exists — FORMULA_UNVERIFIED_ON_REAL_HW note in securityBytes.js, documentation test added)
- [x] BUG FIXED: writeModuleVIN uses v.offset but analyzeFile returns v.off — fixed with v.off??v.offset, VIN writes now correctly target parsed offsets for BCM and RFHUB
- [x] Rename HITAG AES tab to "HITAG KEY READER" in App.jsx nav entry and update description
- [x] Build Hitag2Tab.jsx: photo OCR (HITAG 2 screen), 6-byte SK derivation display, VVDI write helper (Low SK / High SK formatted for VVDI Prog), chip status analysis (BLANK/PROGRAMMED/LOCKED), blank key reference storage
- [x] Register Hitag2Tab in App.jsx nav and route

## UI/UX Overhaul (Professional Audit)
- [x] NAV: PRIMARY_NAV labels updated (Key Program → Transponder Clone, HITAG AES → HITAG Key Reader, added HITAG 2 Bench) — top category header + sub-tabs only for active group
- [x] NAV: Rename keyxfer (KEY PROGRAM) → TRANSPONDER CLONE and keyprog (KEY PROG) → KEY PROG WIZARD
- [x] NAV: Update HITAG KEY READER nav label to show chip part numbers (PCF7945/PCF7939)
- [x] ONBOARDING: Add "What are you trying to do?" landing screen with 5 task-entry buttons routing to correct tabs
- [x] DIFF: Add hex diff panel to Quick Clone download step showing before/after byte changes with offset labels
- [x] GUARD: Add vehicle-year context guard banner to all key-related tabs
- [x] SEED: Add algorithm auto-selector to Seed→Key tab based on loaded module type in context
- [x] WORKFLOW: Make Workflow tab the persistent top-level hub

## EFD→BIN Enhancements
- [x] EFD: Show extracted metadata (Engine, Program, Version, Part Number) from 0x204453 section
- [x] EFD: Show EBML section map (header, metadata, payload offsets and sizes)
- [x] EFD: Add truncation warning when size < declaredSize
- [x] EFD: Add "Send to Flasher" button after successful extraction

## New Features (Jun 5, 2026)
- [x] SEC16 mismatch auto-repair wizard: guided 3-step BCM→RFHUB→PCM flow with single "APPLY ALL FIXES" button in SecuritySyncTab
- [x] Module PN lookup: cross-reference BCM detected P/N against catalog in Diagnose tab ModuleSummary (known P/N check, compatible vehicles, vehicle match, VIN year range check)
- [x] Fix Trackhawk WK2 RFHUB 8 KB rejection: add 8192 to CANONICAL_SIZES_BY_TYPE.RFHUB so wrongModuleForSlot accepts 8 KB RFHUB dumps (double-dump of 24C32)
- [x] Add Trackhawk callout in ModuleSync RFHUB FilePicker subtitle so users know 8 KB is valid for WK2 Trackhawk
- [x] Support virgin RFHUB (factory 0x30-filled VIN slots, blank SEC16) as valid source in Module Sync: engParseRfh ok:true for virgin chips, show VIRGIN badge in RfhCard, enable BCM→RFHUB SEC16 write action for virgin chips
- [x] Add "BCM VIN + SEC16 → RFHUB" combined action for virgin RFHUB chips: writes BCM VIN into all 4 RFHUB slots AND writes reverse(BCM SEC16) into Gen2 slots in one pass, downloads single patched file
- [x] Fix Workflow tab JSON error: add sec16_sync_events table to schema + GET/POST /api/sec16-sync-events routes
- [x] Add TM9 (Panasonic/Harman UConnect 4C NAV) to moparRadioCode.js with formula: PIN = 10099 - last4digits; test vector TM93197 04555 → 5544
- [x] HITAG 2 tab: add hover tooltips to all input fields (Chip ID, Config Page, Low/High SK, Page 0-3) with field-specific guidance
- [x] BCM EFD metadata extraction: parse AL section (CRT timestamp, FGN tool name, FGV version, CAD purpose) from BCM EFDs that lack a DS block; show "BCM MODULE INFO" section in EFD Inspector; add MOPAR BCM efdType; AL section now parsed for all EFD types; AL tag shown in EBML structure map
- [x] EFD zip package converter: parseEfdZipPackage + buildFullFlashImage — extracts decrypted LB18/LB19/LB20 CodeData.bin blocks from PowerCal zip packages for Multi-PROG bench write; per-block download + full flash image assembly; 9 vitest tests passing

## EFD/BIN Tools Expansion (Jun 5, 2026)
- [x] Bench Write Validator tab: drag any .bin, check size against known Multi-PROG region sizes (LB18=3407872, LB19=524288, LB20=5632, full P-Flash=3932160, D-Flash variants), show PASS/FAIL badge with exact expected vs actual size, identify which ECU/region the file matches
- [x] EFD filename parser: auto-detect year/engine/module/program from zip or bin filename patterns (18SCAT, 19LD64, ECM, BCM, TCM, INTFLASH, etc.) and pre-fill vehicle context in EfdToBinTab header
- [x] EFD block diff tab: load two PowerCal zip packages (A vs B), diff each matching LB block byte-by-byte, show changed offset count, hex diff viewer with before/after columns, download diff report

## Security Sync EXTEEPROM Fix (Jun 5, 2026)
- [x] Fix: 8 KB GPEC2A EXT EEPROM files (e.g. FCA_CONTINENTAL_GPEC2A_EXTEEPROM_zo.bin) rejected by Security Sync PCM slot — parseModule.js intentionally blocks filename override for 8 KB files, causing GPEC-named files to be classified as 95640 instead of GPEC2A; SecuritySyncTab.loadPcm needs to pass forceType:'GPEC2A' when filename contains GPEC

## Security Sync UX Improvements (Jun 5, 2026)
- [x] PCM slot chip label badge: show 95640·8KB or 95320·4KB chip label in PCM slot summary after EXTEEPROM file loads
- [x] SEC6 populated/virgin badge: for 8 KB files check bytes at 0x3C8-0x3CE to show SEC6 POPULATED or SEC6 VIRGIN badge in PCM slot without needing to scroll to byte grid
- [x] RFHUB SEC16 VIRGIN wizard explanation: add one-line explanation in wizard step 2 card explaining why RFHUB is virgin (never programmed vs wiped) so user knows what to expect from the fix
- [x] Fix: gen2-hybrid RFHUB write routing — add writeRfhSec16Gen2Slots for 4 KB RFHUBs without AA-55-31-01 banner at 0x0500; wizard now routes gen2-hybrid to new function instead of throwing "Not a Gen2 RFHUB"

## Security Sync + Bench Validator Enhancements (Jun 5, 2026)
- [x] PCM SEC6 donor fill shortcut: "Use Donor" button in PCM slot summary card that applies reverse(BCM SEC16)[0:6] as SEC6 donor value directly without scrolling to GPEC2A immo panel
- [x] Post-fix RFHUB verification row: after wizard patches RFHUB, re-parse the output and show verification row confirming written SEC16 matches reverse(BCM SEC16) — in-app confirmation before flashing
- [x] Multi-PROG write checklist: after Bench Validator PASS, show step-by-step checklist for matched ECU/region (GPEC2A INT FLASH: DB44 interface, DC_PWR 12V/0.5A, LB18 select, write CodeData.bin)

## Flash BIN Analyzer (Jun 5, 2026)
- [x] flashBinAnalyzer.js: ECU type detection (GPEC2A/GPEC3/BCM/TCM/RFHUB by size + magic bytes), flash region map (start/end/size per logical block), VIN scan (all 17-char WMI matches), SEC byte scan (SEC16 at known offsets, SEC6 at 0x3C8), part number extraction (ASCII PN patterns), calibration strings, entropy map per 64 KB block
- [x] FlashBinAnalyzerTab.jsx: drop zone, ECU type badge, region map table, VIN/SEC badges with hex display, part number list, embedded strings panel, entropy heatmap bar, download analysis report (.txt)
- [x] Wire FlashBinAnalyzerTab into App.jsx nav under ANALYZE category
- [x] vitest tests for flashBinAnalyzer ECU detection, VIN scan, SEC scan, PN extraction

## UDS Full Rebuild (Jun 5, 2026)
- [x] Build udsEngine.js — unified module registry (all CAN IDs, session types, security levels, DID catalog, flash block layouts) from RE analysis; SBEC/CDA6/W6/W7 key derivation; session state machine; SGW bypass sequence
- [x] Build IpcClusterReprogramTab.jsx — Durango→Trackhawk guided workflow: SBEC calculator, body code read (22 F1 0F) + write (2E F1 0F 09), VIN/odometer preserve-and-restore, step-by-step UDS sequence display, SGW bypass step
- [x] Fix EcmFlasherTab IPC CAN IDs to RE-verified 0x746/0x766 (was 0x740/0x748)
- [x] Full EcmFlasherTab rebuild: consume udsEngine module registry (live getAllModules), flash block layout panel (buildFlashSequence), pre/post-flash checklist from module notes, algo badge + SGW flag
- [x] Fix UdsTab IPC CAN IDs to RE-verified 0x746/0x766
- [x] Full UdsTab rebuild: live getAllModules() replaces static presets, getModuleDids() DID catalog picker, buildSessionSequence() session preview panel, decodeNrc() NRC decoder panel
- [x] Fix moduleRegistry.js, quickRefData.generated.js, tabReferences.js IPC CAN IDs to 0x746/0x766
- [x] Full VinProgrammerTab rebuild: new UDS VIN WRITE subtab with udsEngine module registry, vinWriteDids DID list, full frame sequence generator (DSC→03→SA→01/02→2E→22→11 reset)
- [x] Full SeedTab rebuild: MODULE_ALGO_HINT built live from udsEngine MODULE_REGISTRY, NRC decoder panel (decodeNrc), Module Registry quick-select panel (getAllModules), Session Sequence Preview (buildSessionSequence)
- [x] Wire IpcClusterReprogramTab into App.jsx nav under PROGRAM category (id: ipccluster)
- [x] vitest tests for udsEngine: SBEC key derivation, session sequence, DID catalog lookup, flash block layout, IPC body code swap sequence (81 tests, all passing)

## UDS Deep Integration (Jun 5, 2026)
- [x] udsEngine MODULE_REGISTRY expanded to 34 modules (was 12) — all FCA/Stellantis modules with RE-verified CAN IDs, algorithms, DID catalogs, and notes
- [x] udsEngine NRC_TABLE expanded to 132 entries (was 22) — full ISO 14229 + FCA-specific NRC codes from workspace-uds/nrc.ts
- [x] Full zip audit: all 25 numbered text files read, all 04_tab_uds_logic tabs compared line-by-line, all 02_generated_data files compared — 3 tabs larger in app (our additions), all catalog files byte-for-byte identical
- [x] VinProgrammerTab UDS VIN WRITE: live seed→key wired — SBEC computeKey auto-fills SA 02 frame bytes as user types seed; placeholder warning badge on SA 02 frame when seed not entered
- [x] IpcClusterReprogramTab LIVE CAPTURE panel: IPC seed input (auto-computes SBEC key, fills Step 6 bytes live), VIN hex input (auto-populates Step 12 restore frame), odometer hex input (auto-populates Step 13 restore frame)
- [x] IpcClusterReprogramTab LIVE CAPTURE panel: SGW seed input (4 bytes from 67 11 response) + optional dongle PIN field — xtea_sgw(seed XOR packPin(pin)) auto-fills Step 3 bytes live; Step 3 status row in SEQUENCE STATUS updates from ⚠ to ✓ when seed is entered
- [x] IpcClusterReprogramTab UdsStepCard: placeholder steps show amber border + "⚠ NEEDS INPUT" badge; filled steps show normal styling
- [x] IpcClusterReprogramTab sequence status summary in LIVE CAPTURE panel showing which steps are ready vs need input

## CB Master Premium 2026 Gap Patches (Jun 6, 2026)
- [x] GAP 1: Fix RFH_DUMP_FIELD_MAP classic offsets — signature 0x020, S/N 0x040, Crypto HIGH 0x166 (2B), Crypto LOW 0x168 (4B), Config 0x1A0, PIN 0x1C6, VIN 0x1EA (verified ISAC/HYHY/CESAR/V1 real dumps)
- [x] GAP 2: Fix 2019+ variant detection — both variants have 5A×4 at 0x020; detect 2019+ by ASCII VIN at 0x040; S/N moves to 0x069 in FW 68363202xx
- [x] GAP 3: Fujitsu dual-cfg checksum +1 rule — cfg=02 blocks get (linear sum + 1); Argo 1A8E/1A8F, Toro 159A/159B verified
- [x] GAP 4: Renegade B1 1.3T BCM sync at 0xE03D (not 0x7C00) — 28B block ×2 at 0xE03D+0xE059, checksum 0x0856 at 0xE676
- [x] GAP 5: GPEC 4LM as distinct PCM variant — pcmVariant=gpec4lm, sync at 0x0230, mandatory checksum 0x0856
- [x] GAP 6: Chrysler 200 CTS block at 0x400 — REQUIRED (CTSAA + 6B sync); without it: DTC P0513
- [x] GAP 7: Argo/Cronos BCM at 0xE085 (64B ×4, 5B header, cfg=01/01/02/02) + Marelli IAW10GF PCM at 0x202 (direct, no inversion)
- [x] GAP 8: RFH sync mirror at 0x0512 (primary 0x04FE) for Argo, Cronos, Toro, Renegade B1
- [x] GAP 9: Toro Diesel PCM EDC17C69 sync at 0x204 (not 0x0080), pcmVariant=edc17c69, rule=edc17_invert_6421531
- [x] GAP 10: Renegade B1 1.3T HITAG AES crypto key stored LE in RFH — transponderCryptoKey note added
- [x] PIN BCD fix: analyzeRfhDump PIN extraction uses BCD hex representation (not decimal integer) — ISAC 0715→1507, HYHY 0828→2808
- [x] 281 vitest tests passing (0 failures) after all 10 gap patches

## J2534 WebSocket Relay — Live UDS Frame Execution

- [x] Build local J2534 relay agent (Node.js + ws server, J2534 PassThru API bindings)
- [x] Relay protocol: JSON messages for open/close channel, send frame, receive frame, list adapters
- [x] SRT Lab relay client: RelayConnectionManager (connect/disconnect/status)
- [x] SRT Lab relay client: sendFrame(canId, bytes, timeout) → response bytes
- [x] Wire relay client into UDS tab: Execute button fires live frames when relay is connected
- [x] Live response display in UDS tab: raw bytes + NRC decode + timing
- [x] Relay status indicator in UDS tab header (Connected / Disconnected / Error)
- [x] Relay agent packaged as standalone Node.js script with setup instructions
- [x] Vitest tests for relay protocol message serialization and frame execution logic

## CDA6 ECU Catalog Integration (Jun 7, 2026)
- [x] Generate ecuCatalogFromCda6.generated.js — 398 ECU name/acronym/architecture entries from ecu_catalog.json
- [x] Extend ecuToCanIndex.js with ECU_CATALOG_CDA6 second source layer — searchable by name/acronym/architecture
- [x] Extend UdsTab EcuPicker to show CDA6 catalog entries with architecture badges
- [x] Integrate cda6DbCodec.js into client/src/srtlab/lib/
- [x] Integrate cda6CryptoTools.js into client/src/srtlab/lib/
- [x] Integrate cda6AutoProgramPlanner.js into client/src/srtlab/lib/
- [x] Integrate Cda6DatabaseToolsTab.jsx into client/src/srtlab/tabs/ and wire into App.jsx
- [x] Add SA algorithms from sa_algorithms.json to udsEngine.js SA_ALGORITHMS_CDA6 table
- [x] Vitest tests for ECU catalog lookup, SA algorithm parsing

## UDS Console Light Theme + New Features (Jun 7)
- [x] Fix J2534UdsConsoleTab.jsx dark theme — convert to light cream theme matching rest of app
- [x] Add UDS command history (up-arrow recall, last 20 commands in localStorage)
- [x] Add CDA6→UDS bridge prefill support in J2534UdsConsoleTab (read sessionStorage keys)
- [x] Add UDS DID library tab/section with full DID catalog from all sources
- [x] Wire Auto-Program Planner LLM mode (invokeLLM for natural-language frame plans)
- [x] Add CDA6 Security → Seed Tab bridge (pre-fill SA level/algo from DB Tools security table)
## UDS Workflow Assistant (Jun 8)
- [x] Build UDS Workflow Assistant panel in J2534UdsConsoleTab — natural language input ("change VIN in the radio")
- [x] Server-side tRPC endpoint that takes intent + selected module and generates full UDS workflow using MODULE_REGISTRY + DID + SA knowledge
- [x] Workflow output: step-by-step numbered sequence with hex commands, expected responses, security prerequisites
- [x] "Execute All" button that queues the generated workflow steps for sequential relay execution
- [x] Each workflow step shows: service name, hex bytes, expected response pattern, and explanation

## Bug Fixes (Jun 8)
- [x] Fixed `selectedModule is not defined` ReferenceError — added state declaration
- [x] Fixed Workflow Assistant 401 auth error — changed planner.workflow and planner.enhance to publicProcedure, added credentials:include to fetch
