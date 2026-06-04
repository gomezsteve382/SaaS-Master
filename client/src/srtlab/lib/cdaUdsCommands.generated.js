// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: CDA.swf (Chrysler Diagnostic Application v6, wiTECH 2 client).
// Re-extract: scripts/extract-cda-uds-commands.mjs.
//
// These are the UDS commands found as plaintext byte sequences inside
// CDA.swf's ActionScript bytecode (frame2.abc, 7.2 MB). Each is paired
// with explicit context strings from the SWF that document its meaning.
//
// IMPORTANT: CDA.swf is the UI shell — the bulk of UDS dispatch is
// constructed by the wiTECH server-side ODX/CBF databases, NOT inlined
// in CDA. These 4 commands are the exceptions: they're hardcoded in CDA
// because CDA itself issues them directly (PROXI read/write are
// CDA-driven workflows).

/** Verified UDS commands extracted as plaintext strings from CDA.swf v6. */
export const CDA_UDS_COMMANDS = [
  {
    udsRequest: [0x22, 0x20, 0x23],
    udsHex: "22 20 23",
    service: 0x22,
    serviceName: "ReadDataByIdentifier",
    did: 0x2023,
    didName: "PROXI String",
    targetEcu: "BCM",
    description: "Read the BCM's PROXI (vehicle configuration) string.",
    sourceContext:
      "scanreports.proxi.explanation: 'The Proxi String is read from the BCM using command 222023.'",
    confidence: "confirmed_plaintext_in_swf",
  },
  {
    udsRequest: [0x2e, 0x20, 0x23],
    udsHex: "2E 20 23",
    service: 0x2e,
    serviceName: "WriteDataByIdentifier",
    did: 0x2023,
    didName: "PROXI String",
    targetEcu: "BCM",
    description:
      "Write the BCM's PROXI string. Used by ProxiAlignmentImpl to import a new vehicle configuration.",
    sourceContext: "ldstr literal '2E2023' in ProxiAlignmentImpl ABC class",
    prerequisitesLikely: [
      "DiagnosticSessionControl 0x10 0x03 (extendedDiagnosticSession)",
      "SecurityAccess 0x27 (level TBD, BCM-specific)",
      "On 2018+ FCA vehicles: Stellantis SGW unlock (CDA AuthenticatedDiagnostics flow)",
    ],
    confidence: "confirmed_plaintext_in_swf",
  },
  {
    udsRequest: [0x22, 0x10, 0x2a],
    udsHex: "22 10 2A",
    service: 0x22,
    serviceName: "ReadDataByIdentifier",
    did: 0x102a,
    didName: "EOL (End-of-Line) data",
    targetEcu: "BCM (likely; possibly other modules)",
    description: "Read the BCM's End-of-Line (factory programming) data block — 2023+ platforms.",
    sourceContext: "ldstr literal '[{0}] EOL (22102A)' in CDA scan-report formatting",
    confidence: "confirmed_plaintext_in_swf",
  },
  {
    udsRequest: [0x22, 0x40, 0xa2],
    udsHex: "22 40 A2",
    service: 0x22,
    serviceName: "ReadDataByIdentifier",
    did: 0x40a2,
    didName: "EOL (End-of-Line) data — legacy DID",
    targetEcu: "BCM (likely; possibly other modules)",
    description: "Older-platform alternative to 0x102A for reading EOL data.",
    sourceContext: "ldstr literal 'EOL (2240A2)' in CDA scan-report formatting",
    confidence: "confirmed_plaintext_in_swf",
  },
];

/** SGW (Security Gateway) authentication flow — extracted from CDA class names. */
export const CDA_SGW_FLOW = {
  description:
    "On 2018+ FCA vehicles with a Security Gateway Module (SGW), all sensitive UDS routines must be unlocked via Stellantis Authenticated Diagnostics (AD) before being accepted by the SGW.",
  classes: [
    "AuthenticatedDiagnosticsLoginPopupEvent",
    "DongleSecurityGatewayMessage",
    "FlashSecurityGatewayMessage",
    "SecurityGatewayOfflineDongleSer*",
    "EcuParityDataGridImpl",
  ],
  events: ["onSecurityGatewayUnlockComplete"],
  dongleAuth: {
    description: "Physical dongle hardware with PIN entry for offline/bench unlock.",
    formField: "authenticatedDiagnosticsLoginPopup.formlabel.PIN.dongle",
    note: "Online flow requires Stellantis TID login + backend issues unlock token.",
  },
  userVisibleStrings: [
    "Authenticated Diagnostics is required for any vehicle equipped with a Security Gateway (SGW)",
    "Login to Stellantis US and unlock the SGW",
    "If this vehicle is equipped with an SGW and you skip the authentication step, the flash may fail",
    "Unlocking an ADA requires authentication. Click the button below to authenticate...",
  ],
};

export const CDA_UDS_META = {
  source: "CDA.swf (Chrysler Diagnostic Application v6, 4.15 MB compressed, 8.5 MB body)",
  abcBytecodeSize: 7228987,
  totalServiceClasses: 1204,
  uiFramework: "Adobe Flex 4.x + Parsley DI",
  diagnosticEngine: "com.dcctools.witech.diagnostic.engine.*",
  catalogLocation: "wiTECH server (ODX/CBF databases) — NOT in this SWF",
};
