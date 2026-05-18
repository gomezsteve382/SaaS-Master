/* Hand-curated binary intelligence catalog used by BinaryIntelTab (Task #649).
 *
 * Schema per report:
 *   id          — unique stable identifier
 *   source      — human-readable source label
 *   file        — analysed binary filename
 *   sizeBytes   — reported file size in bytes
 *   verified    — false = unverified third-party report; true = bench-confirmed
 *   summary     — one-paragraph plain-English description
 *   findings    — structured finding groups (see below)
 *
 * Finding groups:
 *   canIds          — { module, txId, rxId, notes }
 *   udsServices     — { sid, name, usageNote }
 *   dids            — { did, name, category, notes }
 *   routineControls — { routineId, name, targetModule, notes }
 *   securityLevels  — { requestSeed, sendKey, seedLen, algorithm }
 *
 * Coverage tags are NOT stored here — they are computed at runtime by
 * binaryIntelCoverage.js so the mapping logic can be unit-tested independently.
 *
 * DO NOT auto-regenerate from tools — this is intentionally hand-authored intel.
 */

export const BINARY_INTEL_REPORTS = [
  {
    id: "villain-protected-exe",
    source: "External AI-assisted static/dynamic analysis",
    file: "VILLAIN_protected.exe",
    sizeBytes: 13_111_296,
    verified: false,
    summary:
      "Third-party analysis of a packed Windows PE32 binary reported to implement advanced " +
      "FCA automotive diagnostics, ECU programming, and configuration. The binary employs " +
      "three-stage obfuscation (XOR decrypt → LZ decompress → block-cipher relocate) plus " +
      "control-flow flattening, dynamic API resolution, and anti-debugging checks. Findings " +
      "include CAN TX IDs for four FCA modules, a UDS service map, FCA-proprietary DIDs, " +
      "RoutineControl IDs, and a claimed 0x27/0x61 seed-to-key algorithm. None of these " +
      "have been bench-confirmed — treat all entries as planning intel only.",
    referenceDoc: "artifacts/srt-lab/docs/villain-binary-intel.md",

    findings: {
      canIds: [
        {
          module: "PCM (Powertrain Control Module)",
          txId: 0x7E0,
          rxId: 0x7E8,
          notes: "Standard FCA CAN 11-bit; RX = TX+8 (unconfirmed)",
        },
        {
          module: "BCM (Body Control Module)",
          txId: 0x640,
          rxId: 0x648,
          notes: "Standard FCA CAN 11-bit; RX = TX+8 (unconfirmed)",
        },
        {
          module: "SKIM (Sentry Key Immobilizer Module)",
          txId: 0x6B0,
          rxId: 0x6B8,
          notes: "Anti-theft / key programming; RX unconfirmed",
        },
        {
          module: "RFHUB (Radio Frequency Hub)",
          txId: 0x740,
          rxId: 0x748,
          notes: "Key fobs, remote start, TPMS; RX unconfirmed",
        },
      ],

      udsServices: [
        { sid: 0x10, name: "DiagnosticSessionControl", usageNote: "Session transitions (Default / Programming / Extended)" },
        { sid: 0x14, name: "ClearDiagnosticInformation", usageNote: "Clear DTCs" },
        { sid: 0x22, name: "ReadDataByIdentifier", usageNote: "Read ECU data (VIN, part numbers, calibration, etc.)" },
        { sid: 0x2E, name: "WriteDataByIdentifier", usageNote: "Write ECU configuration data" },
        { sid: 0x31, name: "RoutineControl", usageNote: "Start/stop/query factory ECU routines" },
        { sid: 0x34, name: "RequestDownload", usageNote: "Initiate firmware download" },
        { sid: 0x36, name: "TransferData", usageNote: "Transfer firmware blocks" },
        { sid: 0x37, name: "RequestTransferExit", usageNote: "Close transfer session" },
        { sid: 0x3D, name: "WriteMemoryByAddress", usageNote: "Arbitrary ECU memory writes (post security access)" },
        { sid: 0x85, name: "ControlDTCSetting", usageNote: "Enable/disable DTC reporting" },
      ],

      dids: [
        // ISO 14229 0xF1xx identification block
        { did: 0xF180, name: "Boot Software Block Version Number", category: "identification", notes: "Report label: 'Vehicle Identification Number (VIN)' — differs from ISO 14229 standard name; cross-check needed" },
        { did: 0xF18A, name: "ECU Assembly Number", category: "identification", notes: "Report label: 'ECU Part Number' — ISO 14229 §F1xx naming inconsistency noted in source" },
        { did: 0xF190, name: "VIN (Vehicle Identification Number)", category: "identification", notes: "Report label: 'Calibration ID' — ISO 14229 standard name used here" },
        { did: 0xF191, name: "Vehicle Manufacturer ECU Hardware Number", category: "identification", notes: "Report label: 'Calibration Verification Number (CVN)' — ISO label differs" },
        // FCA SKIM / immobilizer (0xDExx)
        { did: 0xDE01, name: "Immobilizer Status (SKIM)", category: "skim", notes: "Not in current dids.ts catalog (only generic 0xDE01 BCM block)" },
        { did: 0xDE02, name: "Key Count (SKIM)", category: "skim", notes: "Not in current dids.ts catalog" },
        { did: 0xDE03, name: "Key Learning Status (SKIM)", category: "skim", notes: "Not in current dids.ts catalog" },
        // RFHUB proprietary (0xABxx)
        { did: 0xAB01, name: "Remote Start Enable/Disable", category: "rfhub", notes: "Not in dids.ts catalog" },
        { did: 0xAB02, name: "Key Fob Configuration Data", category: "rfhub", notes: "Not in dids.ts catalog" },
        // PCM proprietary (0xCDxx)
        { did: 0xCD01, name: "Injector Flow Rates", category: "pcm", notes: "Not in dids.ts catalog" },
        { did: 0xCD02, name: "Transmission Adaptives", category: "pcm", notes: "Not in dids.ts catalog" },
      ],

      routineControls: [
        {
          routineId: 0x0100,
          name: "Reset Transmission Adaptives",
          targetModule: "PCM (0x7E0)",
          notes: "Sub-type 0x01 (startRoutine). No dedicated wrapper in codebase.",
        },
        {
          routineId: 0x0101,
          name: "Perform Crankshaft Relearn",
          targetModule: "PCM (0x7E0)",
          notes: "Sub-type 0x01 (startRoutine). No dedicated wrapper in codebase.",
        },
        {
          routineId: 0x0200,
          name: "Key Learning Procedure",
          targetModule: "SKIM (0x6B0)",
          notes: "Sub-type 0x01 (startRoutine). High-priority immobilizer path — no wrapper yet.",
        },
        {
          routineId: 0x0300,
          name: "RFHUB Component Replacement",
          targetModule: "RFHUB (0x740)",
          notes: "Sub-type 0x01 (startRoutine). Partially covered by DealerLockoutBypassCard flow (0xFF00).",
        },
      ],

      securityLevels: [
        {
          requestSeed: 0x61,
          sendKey: 0x62,
          seedLen: 8,
          notes: "8-byte seed returned in 67 61 response. S-box NOT extracted — algorithm is incomplete without it.",
          algorithm: {
            name: "CalculateSecurityKey_0x61",
            status: "incomplete",
            missingPiece: "256-byte FCA_SBox (not in source report — must be extracted from unpacked binary)",
            steps: [
              {
                step: 1,
                label: "Initialize key buffer",
                pseudocode: "Key[0]=0x5A; Key[1]=0xA5; Key[2..7]=0x00",
              },
              {
                step: 2,
                label: "TempSeed permutation (byte reorder + XOR)",
                pseudocode:
                  "TempSeed[0]=Seed[2]^Seed[5]; TempSeed[1]=Seed[0]^Seed[7]; " +
                  "TempSeed[2]=Seed[4]^Seed[1]; TempSeed[3]=Seed[6]^Seed[3]; " +
                  "TempSeed[4]=Seed[1]^Seed[6]; TempSeed[5]=Seed[3]^Seed[0]; " +
                  "TempSeed[6]=Seed[5]^Seed[2]; TempSeed[7]=Seed[7]^Seed[4]",
              },
              {
                step: 3,
                label: "4-round mixer",
                pseudocode:
                  "for i in [0,1,2,3]: " +
                  "Key[2]=(Key[2]+TempSeed[i*2])&0xFF; " +
                  "Key[3]=(Key[3]^TempSeed[i*2+1])&0xFF; " +
                  "Key[4]=(Key[4]+Key[2])&0xFF; " +
                  "Key[5]=(Key[5]^Key[3])&0xFF; " +
                  "Key[6]=(Key[6]+(Key[4]>>4))&0xFF; " +
                  "Key[7]=(Key[7]^(Key[5]<<4))&0xFF; " +
                  "Key[0]=(Key[0]+Key[6])&0xFF; " +
                  "Key[1]=(Key[1]^Key[7])&0xFF",
              },
              {
                step: 4,
                label: "CRC-16/CCITT-FALSE over first 4 seed bytes",
                pseudocode:
                  "CRC=crc16ccitt(Seed[0..3]); " +
                  "Key[0]=(Key[0]^(CRC&0xFF))&0xFF; " +
                  "Key[1]=(Key[1]^((CRC>>8)&0xFF))&0xFF",
              },
              {
                step: 5,
                label: "S-box substitution (BLOCKED — S-box not available)",
                pseudocode:
                  "for j in 0..7: Key[j]=FCA_SBox[Key[j]]   // FCA_SBox[256] not extracted",
              },
            ],
          },
        },
      ],

      notes: [
        "CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) is already implemented in src/lib/crc.js as crc16ccitt().",
        "RX CAN IDs (TX+8) follow the standard FCA convention but are not bench-confirmed from this source.",
        "Label inconsistencies in 0xF1xx DIDs: the report uses FCA-internal names that diverge from ISO 14229 standard names.",
        "The 256-byte FCA_SBox is the critical missing piece for the 0x27/0x61 algorithm — without it Steps 1–4 alone produce an invalid key.",
      ],
    },
  },

  {
    id: "fca-proxi-tool-v1201",
    source: "Internal bench reverse-engineering (decompiled PyInstaller bundle + bench UDS traces)",
    file: "FCA_PROXI_Tool.exe (v1.2.0.1)",
    sizeBytes: 18_452_736,
    verified: true,
    summary:
      "In-house RE notes for Stellantis' official FCA PROXI Tool v1.2.0.1, the dealer " +
      "utility used to read and write the 128-byte PROXI configuration record on the BCM. " +
      "Findings come from the decompiled Python sources under tools/fca-proxi-extract/src/ " +
      "and from bench-captured UDS traces against real 2017–2024 BCMs — they are NOT " +
      "third-party intel. Covers the BCM PROXI CAN addressing (pre-SGW 0x790/0x798), " +
      "the UDS sequence the tool issues for a read/write cycle, the PROXI DIDs for both " +
      "pre-SGW (0xFD01) and SGW (0xFD20) platforms, and the standard-level seed/key " +
      "handshake the tool uses before any 0x2E. The native JS counterpart already lives " +
      "in src/lib/fcaProxi.js (parse/serialize/build/round-trip).",
    referenceDoc: "artifacts/srt-lab/docs/fca-proxi-reference.md",

    findings: {
      canIds: [
        {
          module: "BCM (PROXI read/write — pre-SGW)",
          txId: 0x790,
          rxId: 0x798,
          notes: "Chrysler BCM PROXI CAN pair used by FCA PROXI Tool for 0x22/0x2E FD01. Distinct from the 0x640/0x648 diagnostic pair used elsewhere in SRT Lab.",
        },
        {
          module: "SGW (Secure Gateway — request)",
          txId: 0x74F,
          rxId: 0x76F,
          notes: "Required on 2019+ SGW-protected vehicles before any 0x2E FD20 PROXI write is accepted. Handled by AutelSgwTab + sgwAuth.js.",
        },
      ],

      udsServices: [
        { sid: 0x10, name: "DiagnosticSessionControl", usageNote: "Enter Extended (0x03) before SecurityAccess + PROXI read/write" },
        { sid: 0x27, name: "SecurityAccess",          usageNote: "RequestSeed 0x01 → SendKey 0x02 (standard BCM level) before any 0x2E" },
        { sid: 0x22, name: "ReadDataByIdentifier",    usageNote: "Read PROXI record (DID 0xFD01 pre-SGW / 0xFD20 SGW)" },
        { sid: 0x2E, name: "WriteDataByIdentifier",   usageNote: "Write modified PROXI record back to BCM after edits" },
        { sid: 0x11, name: "ECUReset",                usageNote: "Hard reset (0x01) issued after PROXI write to commit configuration" },
        { sid: 0x3E, name: "TesterPresent",           usageNote: "Keepalive during PROXI editing — session times out in ~5 s without it" },
      ],

      dids: [
        {
          did: 0xFD01,
          name: "PROXI Configuration Record (pre-SGW BCM)",
          category: "bcm_proxi",
          notes: "128-byte vehicle-specific config blob. SRT Lab parses/serialises this via src/lib/fcaProxi.js with full CRC-16/CCITT-FALSE round-trip.",
        },
        {
          did: 0xFD20,
          name: "PROXI Configuration Record (SGW platforms, 2019+)",
          category: "bcm_proxi",
          notes: "Same 128-byte format as 0xFD01 but gated behind the Secure Gateway. Not catalogued in lib/uds/src/dids.ts.",
        },
        {
          did: 0xF190,
          name: "VIN (Vehicle Identification Number)",
          category: "identification",
          notes: "Read by the tool during PROXI session to confirm it is talking to the correct vehicle.",
        },
        {
          did: 0xF187,
          name: "Vehicle Manufacturer Spare Part Number (BCM)",
          category: "identification",
          notes: "Displayed in the tool's status bar; standard ISO 14229 0xF1xx identification block.",
        },
      ],

      routineControls: [
        {
          routineId: 0x0203,
          name: "Commit PROXI Section (BCM)",
          targetModule: "BCM (0x790)",
          notes: "Optional per-section commit routine some BCM firmwares require after a 0x2E FD01 write. No dedicated wrapper — operator must invoke build.routineControl() manually.",
        },
      ],

      securityLevels: [
        {
          requestSeed: 0x01,
          sendKey: 0x02,
          seedLen: 4,
          notes: "Standard BCM unlock used by FCA PROXI Tool — covered by sxor / cda6 / xtea_sgw families in algos.js depending on platform. No FCA-proprietary level required for the pre-SGW PROXI path.",
        },
      ],

      notes: [
        "The PROXI record itself is parsed and round-trip-verified by src/lib/fcaProxi.js (covered by 22 Vitest cases in src/tabs/__tests__/fcaProxi.test.js).",
        "On SGW vehicles the tool uses DID 0xFD20 and requires the AutelSgwTab handshake (CAN 0x74F/0x76F) before the 0x2E is accepted.",
        "The tool's Windows license check is bypassed by a Safengine-Shielden shfolder.dll sideload (see docs/fca-proxi-reference.md §2) — irrelevant to ECU-side coverage but documented for completeness.",
        "BCM CAN pair 0x790/0x798 is distinct from the 0x640/0x648 pair used by BcmTab — both pairs are referenced in unlock_catalog_extended.json and both are now classified as COVERED by binaryIntelCoverage.classifyCanId.",
      ],
    },
  },
];

export const BINARY_INTEL_GENERATED_AT = "2026-05-18T00:00:00.000Z";
