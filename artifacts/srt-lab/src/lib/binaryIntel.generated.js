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
];

export const BINARY_INTEL_GENERATED_AT = "2026-05-18T00:00:00.000Z";
