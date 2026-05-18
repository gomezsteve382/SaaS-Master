/**
 * Binary Intelligence Coverage Mapper (Task #649)
 *
 * Pure functions that compare a finding from a binary-intel report against
 * what SRT Lab already covers — via @workspace/uds (services, DIDs, constants)
 * and existing tabs. Returns a { status, evidence } pair for each finding.
 *
 * Coverage statuses:
 *   "covered"  — fully supported: frame builder, decoder, or dedicated UI exists
 *   "partial"  — partially supported: related capability exists but the specific
 *                sub-function, DID, or algorithm step is missing or incomplete
 *   "gap"      — not covered: net-new capability not found anywhere in codebase
 *
 * All functions are pure; they do NOT touch the DOM or any React state.
 */

/** Canonical set of UDS SIDs with a frame builder in lib/uds/src/build.ts. */
const COVERED_SIDS = new Set([
  0x10, // DiagnosticSessionControl
  0x11, // ECUReset
  0x14, // ClearDiagnosticInformation
  0x19, // ReadDTCInformation
  0x22, // ReadDataByIdentifier
  0x23, // ReadMemoryByAddress
  0x27, // SecurityAccess
  0x28, // CommunicationControl
  0x29, // Authentication
  0x2C, // DynamicallyDefineDataIdentifier
  0x2E, // WriteDataByIdentifier
  0x2F, // InputOutputControlByIdentifier
  0x31, // RoutineControl
  0x34, // RequestDownload
  0x35, // RequestUpload
  0x36, // TransferData
  0x37, // RequestTransferExit
  0x38, // RequestFileTransfer
  0x3D, // WriteMemoryByAddress
  0x3E, // TesterPresent
  0x85, // ControlDTCSetting
  0x86, // ResponseOnEvent
  0x87, // LinkControl
]);

/** SIDs present in the UDS service table but with no dedicated frame builder. */
const PARTIAL_SIDS = new Set([
  0x24, // ReadScalingDataByIdentifier — catalogued, no builder
  0x2A, // ReadDataByPeriodicIdentifier — catalogued, no builder
  0x83, // AccessTimingParameter — catalogued, no builder
  0x84, // SecuredDataTransmission — catalogued, no builder
]);

/**
 * DIDs that are explicitly catalogued in lib/uds/src/dids.ts.
 * Keep in sync with DID_CATALOG in dids.ts.
 */
const CATALOGUED_DIDS = new Set([
  // 0xF1xx identification block
  0xF180, 0xF181, 0xF182, 0xF183, 0xF184, 0xF185, 0xF186, 0xF187, 0xF188,
  0xF189, 0xF18C, 0xF190, 0xF191, 0xF192, 0xF193, 0xF194, 0xF195, 0xF196,
  0xF197, 0xF198, 0xF199, 0xF19A, 0xF19B, 0xF19C, 0xF19D, 0xF19E, 0xF19F,
  0xF1A0, 0xF1A1, 0xF1A2, 0xF1A3, 0xF1A4, 0xF1A5, 0xF1A6, 0xF1A7, 0xF1A8,
  0xF1A9, 0xF1AA,
  // FCA / Stellantis specific
  0xF1B0, 0xF1B3, 0xF1B6, 0xF1BA, 0xF1BD, 0xF1C0, 0xF1C1,
  // ECM/PCM
  0xF40D,
  // BCM / Key fob / SKIM
  0xF1D0, 0xF1D1,
  // System supplier block (RFHUB)
  0xF1E0, 0xF1E1, 0xF1E2,
  // OBD-II PIDs
  0x0100, 0x0120, 0x012F, 0x0142, 0x0146, 0x014D,
  // ECM 0xFDxx
  0xFD01, 0xFD31, 0xFDFD, 0xF400,
  // BCM configuration 0xDExx
  0xDE00, 0xDE01, 0xDE02, 0xDE03, 0xDE04, 0xDE05, 0xDE06, 0xDE07, 0xDE08,
  0xDE09, 0xDE0A, 0xDE0B, 0xDE0C, 0xDE10, 0xDE11,
  // VILLAIN VIN block
  0x7B88, 0x7B90,
  // FCA scoped 24-bit DIDs
  0x6E2025, 0x6E2027, 0x6E9EB0, 0x6EF190,
  // 32-bit SCI-B flag
  0xF79EB045,
]);

/**
 * DIDs that are in the catalog but whose reported module-specific semantic
 * label differs from the generic BCM block label (partial coverage).
 * Key = DID hex value, value = explanation.
 */
const PARTIAL_DIDS = {
  0xDE01: "Catalogued as generic 'BCM Configuration Block 01' — report assigns SKIM-specific label 'Immobilizer Status'",
  0xDE02: "Catalogued as generic 'BCM Configuration Block 02' — report assigns SKIM-specific label 'Key Count'",
  0xDE03: "Catalogued as generic 'BCM Configuration Block 03' — report assigns SKIM-specific label 'Key Learning Status'",
};

/** RoutineControl IDs with a dedicated implementation in SRT Lab. */
const COVERED_ROUTINE_IDS = new Set([
  0xFF00, // DealerLockoutBypass — src/lib/dealerLockoutBypass.js
]);

/**
 * Classify a UDS service finding.
 *
 * @param {{ sid: number }} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifyUdsService(finding) {
  const sid = finding.sid;
  if (COVERED_SIDS.has(sid)) {
    return {
      status: "covered",
      evidence: `Frame builder in lib/uds/src/build.ts; service defined in services.ts (SID 0x${sid.toString(16).toUpperCase().padStart(2, "0")})`,
    };
  }
  if (PARTIAL_SIDS.has(sid)) {
    return {
      status: "partial",
      evidence: `Service catalogued in lib/uds/src/services.ts (SID 0x${sid.toString(16).toUpperCase().padStart(2, "0")}) but no dedicated frame builder`,
    };
  }
  return {
    status: "gap",
    evidence: `SID 0x${sid.toString(16).toUpperCase().padStart(2, "0")} not found in @workspace/uds services or any existing tab`,
  };
}

/**
 * Classify a DID finding.
 *
 * @param {{ did: number }} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifyDid(finding) {
  const did = finding.did;
  const hex = "0x" + did.toString(16).toUpperCase().padStart(4, "0");

  if (PARTIAL_DIDS[did]) {
    return {
      status: "partial",
      evidence: PARTIAL_DIDS[did],
    };
  }
  if (CATALOGUED_DIDS.has(did)) {
    return {
      status: "covered",
      evidence: `DID ${hex} catalogued with name and decode function in lib/uds/src/dids.ts`,
    };
  }
  return {
    status: "gap",
    evidence: `DID ${hex} not present in lib/uds/src/dids.ts or any tab`,
  };
}

/**
 * Classify a RoutineControl finding.
 *
 * @param {{ routineId: number }} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifyRoutineControl(finding) {
  const rid = finding.routineId;
  const hex = "0x" + rid.toString(16).toUpperCase().padStart(4, "0");
  if (COVERED_ROUTINE_IDS.has(rid)) {
    return {
      status: "covered",
      evidence: `Routine ${hex} implemented in src/lib/dealerLockoutBypass.js (DealerLockoutBypassCard)`,
    };
  }
  // RoutineControl service builder (0x31) exists; individual routines may not
  return {
    status: "partial",
    evidence: `Routine ${hex} has no dedicated wrapper. build.routineControl() in lib/uds/src/build.ts can issue arbitrary routines; operator must supply the routine ID manually.`,
  };
}

/**
 * Classify a security-access level finding.
 *
 * @param {{ requestSeed: number, sendKey: number, algorithm?: object }} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifySecurityLevel(finding) {
  const reqSeed = finding.requestSeed;

  // SecurityAccess frame builder covers any sub-function value
  // but we need an actual algo implementation to compute the key.

  // Levels for which we have a working algo in algos.js:
  //   sxor (0x01/0x02), cda6 (0x01/0x02 fallback), xtea_sgw (0x01/0x02),
  //   ngc (0x03/0x04), tipm variants, etc.
  // The 0x61 level has no working algo (S-box missing).

  if (reqSeed === 0x61) {
    return {
      status: "gap",
      evidence:
        "Level 0x27/0x61 has no algo in src/lib/algos.js. " +
        "The 256-byte FCA_SBox required for Step 5 was not provided in the source report — " +
        "algorithm is incomplete and cannot be wired without it.",
    };
  }

  // Standard levels (0x01, 0x03, 0x05, 0x09, 0x0B, 0x11) are covered by algos.js
  const coveredLevels = new Set([0x01, 0x03, 0x05, 0x09, 0x0B, 0x11]);
  if (coveredLevels.has(reqSeed)) {
    return {
      status: "covered",
      evidence: `Level 0x${reqSeed.toString(16).padStart(2, "0")}/0x${(reqSeed + 1).toString(16).padStart(2, "0")} handled by algos.js (sxor / cda6 / xtea_sgw / ngc families)`,
    };
  }

  return {
    status: "partial",
    evidence: `build.securityAccess() in lib/uds/src/build.ts can frame any sub-function but no matching algo in algos.js for level 0x${reqSeed.toString(16).padStart(2, "0")}`,
  };
}

/**
 * Classify a CAN ID finding.
 * TX IDs for PCM/BCM/SKIM/RFHUB are all referenced in existing tabs
 * and unlock_catalog.json.
 *
 * @param {{ txId: number, module: string }} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifyCanId(finding) {
  const knownTxIds = {
    0x7E0: "PCM — referenced in GPEC2A/ECM tabs, unlock_catalog.json, algos.js",
    0x640: "BCM — referenced in BcmTab.jsx, unlock_catalog.json",
    0x6B0: "SKIM — referenced in SkimTab.jsx, unlock_catalog.json",
    0x740: "RFHUB — referenced in RfhubTab.jsx, unlock_catalog.json",
  };

  const txId = finding.txId;
  if (knownTxIds[txId]) {
    return {
      status: "covered",
      evidence: knownTxIds[txId],
    };
  }
  return {
    status: "gap",
    evidence: `TX ID 0x${txId.toString(16).toUpperCase().padStart(3, "0")} not referenced in any existing tab or catalog`,
  };
}

/**
 * Classify any finding by type.
 * Convenience dispatcher used by the UI.
 *
 * @param {'canId'|'udsService'|'did'|'routineControl'|'securityLevel'} type
 * @param {object} finding
 * @returns {{ status: 'covered'|'partial'|'gap', evidence: string }}
 */
export function classifyFinding(type, finding) {
  switch (type) {
    case "canId":          return classifyCanId(finding);
    case "udsService":     return classifyUdsService(finding);
    case "did":            return classifyDid(finding);
    case "routineControl": return classifyRoutineControl(finding);
    case "securityLevel":  return classifySecurityLevel(finding);
    default:
      return { status: "gap", evidence: `Unknown finding type: ${type}` };
  }
}
