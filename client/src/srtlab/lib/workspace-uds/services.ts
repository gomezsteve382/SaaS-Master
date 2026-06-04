/**
 * ISO 14229-1 Service table — every standardised UDS service from
 * DiagnosticSessionControl (0x10) through LinkControl (0x87).
 *
 * Each entry exposes:
 *   sid      — request service identifier byte
 *   posRsp   — positive-response SID (sid | 0x40)
 *   name     — human-readable service name (ISO 14229 §11 naming)
 *   subFunctions — optional sub-function byte constants for this service
 */

export interface ServiceSubFunction {
  readonly value: number;
  readonly name: string;
  readonly description: string;
}

export interface Service {
  readonly sid: number;
  readonly posRsp: number;
  readonly name: string;
  readonly subFunctions?: readonly ServiceSubFunction[];
}

export const SERVICES: readonly Service[] = [
  // ── Diagnostic and Communication Management ──────────────────────────
  {
    sid: 0x10,
    posRsp: 0x50,
    name: 'DiagnosticSessionControl',
    subFunctions: [
      { value: 0x01, name: 'defaultSession',              description: 'Default diagnostic session' },
      { value: 0x02, name: 'programmingSession',          description: 'Programming session (flash download)' },
      { value: 0x03, name: 'extendedDiagnosticSession',  description: 'Extended diagnostic session (config R/W)' },
      { value: 0x04, name: 'safetySystemDiagnosticSession', description: 'Safety-system diagnostic session' },
    ],
  },
  {
    sid: 0x11,
    posRsp: 0x51,
    name: 'ECUReset',
    subFunctions: [
      { value: 0x01, name: 'hardReset',               description: 'Hard power-cycle reset' },
      { value: 0x02, name: 'keyOffOnReset',            description: 'Key-off / key-on cycle' },
      { value: 0x03, name: 'softReset',               description: 'Software reset without power loss' },
      { value: 0x04, name: 'enableRapidPowerShutDown', description: 'Enable rapid power shutdown mode' },
      { value: 0x05, name: 'disableRapidPowerShutDown', description: 'Disable rapid power shutdown mode' },
    ],
  },
  {
    sid: 0x27,
    posRsp: 0x67,
    name: 'SecurityAccess',
  },
  {
    sid: 0x28,
    posRsp: 0x68,
    name: 'CommunicationControl',
    subFunctions: [
      { value: 0x00, name: 'enableRxAndTx',               description: 'Enable reception and transmission' },
      { value: 0x01, name: 'enableRxAndDisableTx',        description: 'Enable Rx, disable Tx' },
      { value: 0x02, name: 'disableRxAndEnableTx',        description: 'Disable Rx, enable Tx' },
      { value: 0x03, name: 'disableRxAndTx',              description: 'Disable reception and transmission' },
      { value: 0x04, name: 'enableRxAndDisableTxWithEnhancedAddressInformation', description: 'Enable Rx, disable Tx with enhanced address info' },
      { value: 0x05, name: 'enableRxAndTxWithEnhancedAddressInformation',        description: 'Enable Rx and Tx with enhanced address info' },
    ],
  },
  {
    sid: 0x29,
    posRsp: 0x69,
    name: 'Authentication',
    subFunctions: [
      { value: 0x00, name: 'deAuthenticate',                    description: 'Terminate authenticated session' },
      { value: 0x01, name: 'verifyCertificateUnidirectional',   description: 'Unidirectional certificate verification' },
      { value: 0x02, name: 'verifyCertificateBidirectional',    description: 'Bidirectional certificate verification' },
      { value: 0x03, name: 'proofOfOwnership',                  description: 'Proof of ownership' },
      { value: 0x04, name: 'transmitCertificate',               description: 'Transmit certificate' },
      { value: 0x05, name: 'requestChallengeForAuthentication', description: 'Request challenge for authentication' },
      { value: 0x06, name: 'verifyProofOfOwnershipUnidirectional',  description: 'Verify proof of ownership unidirectional' },
      { value: 0x07, name: 'verifyProofOfOwnershipBidirectional',   description: 'Verify proof of ownership bidirectional' },
      { value: 0x08, name: 'authenticationConfiguration',       description: 'Read/configure authentication settings' },
    ],
  },
  {
    sid: 0x3E,
    posRsp: 0x7E,
    name: 'TesterPresent',
    subFunctions: [
      { value: 0x00, name: 'zeroSubFunction',         description: 'Request positive response' },
      { value: 0x80, name: 'suppressPosRspMsgIndicationBit', description: 'Suppress positive response (0x80 flag)' },
    ],
  },
  {
    sid: 0x83,
    posRsp: 0xC3,
    name: 'AccessTimingParameter',
    subFunctions: [
      { value: 0x01, name: 'readExtendedTimingParameterSet', description: 'Read the extended timing set' },
      { value: 0x02, name: 'setTimingParametersToDefaultValues', description: 'Reset timing to defaults' },
      { value: 0x03, name: 'readCurrentlyActiveTimingParameters', description: 'Read currently active parameters' },
      { value: 0x04, name: 'setTimingParametersToGivenValues', description: 'Set P2/P2* timing explicitly' },
    ],
  },
  {
    sid: 0x84,
    posRsp: 0xC4,
    name: 'SecuredDataTransmission',
  },
  {
    sid: 0x85,
    posRsp: 0xC5,
    name: 'ControlDTCSetting',
    subFunctions: [
      { value: 0x01, name: 'on',  description: 'Re-enable DTC setting' },
      { value: 0x02, name: 'off', description: 'Disable DTC setting' },
    ],
  },
  {
    sid: 0x86,
    posRsp: 0xC6,
    name: 'ResponseOnEvent',
    subFunctions: [
      { value: 0x00, name: 'stopResponseOnEvent',   description: 'Stop responding on event' },
      { value: 0x01, name: 'onDTCStatusChange',     description: 'Respond on DTC status change' },
      { value: 0x02, name: 'onTimerInterrupt',      description: 'Respond on timer interrupt' },
      { value: 0x03, name: 'onChangeOfDataIdentifier', description: 'Respond on DID value change' },
      { value: 0x04, name: 'reportActivatedEvents', description: 'Report currently activated events' },
      { value: 0x05, name: 'startResponseOnEvent',  description: 'Start responding on event' },
      { value: 0x06, name: 'clearResponseOnEvent',  description: 'Clear event records' },
      { value: 0x07, name: 'onComparisonOfValues',  description: 'Respond on comparison-of-values trigger' },
    ],
  },
  {
    sid: 0x87,
    posRsp: 0xC7,
    name: 'LinkControl',
    subFunctions: [
      { value: 0x01, name: 'verifyBaudrateTransitionWithFixedBaudrate',     description: 'Verify fixed baud-rate transition' },
      { value: 0x02, name: 'verifyBaudrateTransitionWithSpecificBaudrate',  description: 'Verify specific baud-rate transition' },
      { value: 0x03, name: 'transitionBaudrate',                             description: 'Transition to new baud rate' },
    ],
  },

  // ── Data Transmission ─────────────────────────────────────────────────
  {
    sid: 0x22,
    posRsp: 0x62,
    name: 'ReadDataByIdentifier',
  },
  {
    sid: 0x23,
    posRsp: 0x63,
    name: 'ReadMemoryByAddress',
  },
  {
    sid: 0x24,
    posRsp: 0x64,
    name: 'ReadScalingDataByIdentifier',
  },
  {
    sid: 0x2A,
    posRsp: 0x6A,
    name: 'ReadDataByPeriodicIdentifier',
    subFunctions: [
      { value: 0x01, name: 'sendAtSlowRate',   description: 'Transmit periodic data at slow rate' },
      { value: 0x02, name: 'sendAtMediumRate', description: 'Transmit periodic data at medium rate' },
      { value: 0x03, name: 'sendAtFastRate',   description: 'Transmit periodic data at fast rate' },
      { value: 0x04, name: 'stopSending',      description: 'Stop periodic data transmission' },
    ],
  },
  {
    sid: 0x2C,
    posRsp: 0x6C,
    name: 'DynamicallyDefineDataIdentifier',
    subFunctions: [
      { value: 0x01, name: 'defineByIdentifier',      description: 'Define DDDID by existing DID(s)' },
      { value: 0x02, name: 'defineByMemoryAddress',   description: 'Define DDDID by memory address/length' },
      { value: 0x03, name: 'clearDynamicallyDefinedDataIdentifier', description: 'Clear a previously defined DDDID' },
    ],
  },
  {
    sid: 0x2E,
    posRsp: 0x6E,
    name: 'WriteDataByIdentifier',
  },
  {
    sid: 0x3D,
    posRsp: 0x7D,
    name: 'WriteMemoryByAddress',
  },

  // ── Stored Data Transmission ──────────────────────────────────────────
  {
    sid: 0x14,
    posRsp: 0x54,
    name: 'ClearDiagnosticInformation',
  },
  {
    sid: 0x19,
    posRsp: 0x59,
    name: 'ReadDTCInformation',
    subFunctions: [
      { value: 0x01, name: 'reportNumberOfDTCByStatusMask',              description: 'Count DTCs matching status mask' },
      { value: 0x02, name: 'reportDTCByStatusMask',                      description: 'List DTCs matching status mask' },
      { value: 0x03, name: 'reportDTCSnapshotIdentification',            description: 'List available freeze-frame identifiers' },
      { value: 0x04, name: 'reportDTCSnapshotRecordByDTCNumber',         description: 'Read freeze-frame by DTC number' },
      { value: 0x05, name: 'reportDTCStoredDataByRecordNumber',          description: 'Read stored data by record number' },
      { value: 0x06, name: 'reportDTCExtDataRecordByDTCNumber',          description: 'Read extended data by DTC number' },
      { value: 0x07, name: 'reportNumberOfDTCBySeverityMaskRecord',      description: 'Count DTCs by severity mask' },
      { value: 0x08, name: 'reportDTCBySeverityMaskRecord',              description: 'List DTCs by severity mask' },
      { value: 0x09, name: 'reportSeverityInformationOfDTC',             description: 'Report severity of a specific DTC' },
      { value: 0x0A, name: 'reportSupportedDTC',                         description: 'List all supported DTCs' },
      { value: 0x0B, name: 'reportFirstTestFailedDTC',                   description: 'Report first failed DTC this cycle' },
      { value: 0x0C, name: 'reportFirstConfirmedDTC',                    description: 'Report first confirmed DTC' },
      { value: 0x0D, name: 'reportMostRecentTestFailedDTC',              description: 'Report most recent failed DTC' },
      { value: 0x0E, name: 'reportMostRecentConfirmedDTC',               description: 'Report most recent confirmed DTC' },
      { value: 0x0F, name: 'reportMirrorMemoryDTCByStatusMask',          description: 'List mirror-memory DTCs by status mask' },
      { value: 0x10, name: 'reportMirrorMemoryDTCExtDataRecordByDTCNumber', description: 'Mirror-memory extended data by DTC' },
      { value: 0x11, name: 'reportNumberOfMirrorMemoryDTCByStatusMask', description: 'Count mirror-memory DTCs' },
      { value: 0x12, name: 'reportNumberOfEmissionsOBDDTCByStatusMask', description: 'Count OBD emission DTCs' },
      { value: 0x13, name: 'reportEmissionsOBDDTCByStatusMask',         description: 'List OBD emission DTCs' },
      { value: 0x14, name: 'reportDTCFaultDetectionCounter',            description: 'Report fault-detection counters' },
      { value: 0x15, name: 'reportDTCWithPermanentStatus',              description: 'List permanently stored DTCs' },
      { value: 0x16, name: 'reportDTCExtDataRecordByRecordNumber',      description: 'Extended data by record number' },
      { value: 0x17, name: 'reportUserDefMemoryDTCByStatusMask',        description: 'User-defined memory DTC by status mask' },
      { value: 0x18, name: 'reportUserDefMemoryDTCSnapshotRecordByDTCNumber', description: 'User-defined memory snapshot by DTC' },
      { value: 0x19, name: 'reportUserDefMemoryDTCExtDataRecordByDTCNumber',  description: 'User-defined memory ext data by DTC' },
      { value: 0x42, name: 'reportWWHOBDDTCByMaskRecord',               description: 'WWH-OBD DTC by mask record' },
      { value: 0x55, name: 'reportWWHOBDDTCWithPermanentStatus',        description: 'WWH-OBD permanently stored DTCs' },
    ],
  },

  // ── InputOutput Control ───────────────────────────────────────────────
  {
    sid: 0x2F,
    posRsp: 0x6F,
    name: 'InputOutputControlByIdentifier',
  },

  // ── Remote Activation of Routine ─────────────────────────────────────
  {
    sid: 0x31,
    posRsp: 0x71,
    name: 'RoutineControl',
    subFunctions: [
      { value: 0x01, name: 'startRoutine',           description: 'Start a routine' },
      { value: 0x02, name: 'stopRoutine',            description: 'Stop a routine' },
      { value: 0x03, name: 'requestRoutineResults',  description: 'Request routine result record' },
    ],
  },

  // ── Upload / Download ─────────────────────────────────────────────────
  {
    sid: 0x34,
    posRsp: 0x74,
    name: 'RequestDownload',
  },
  {
    sid: 0x35,
    posRsp: 0x75,
    name: 'RequestUpload',
  },
  {
    sid: 0x36,
    posRsp: 0x76,
    name: 'TransferData',
  },
  {
    sid: 0x37,
    posRsp: 0x77,
    name: 'RequestTransferExit',
  },
  {
    sid: 0x38,
    posRsp: 0x78,
    name: 'RequestFileTransfer',
    subFunctions: [
      { value: 0x01, name: 'addFile',     description: 'Add a new file' },
      { value: 0x02, name: 'deleteFile',  description: 'Delete a file' },
      { value: 0x03, name: 'replaceFile', description: 'Replace an existing file' },
      { value: 0x04, name: 'readFile',    description: 'Read a file' },
      { value: 0x05, name: 'readDir',     description: 'Read directory' },
      { value: 0x06, name: 'resumeFile',  description: 'Resume a file transfer' },
    ],
  },
] as const;

/** Look up a service by SID. Returns undefined if not a known UDS service. */
export function serviceForSid(sid: number): Service | undefined {
  return SERVICES.find(s => s.sid === sid);
}

/** Look up a service by positive-response SID (sid | 0x40). */
export function serviceForPosRsp(posRsp: number): Service | undefined {
  return SERVICES.find(s => s.posRsp === posRsp);
}
