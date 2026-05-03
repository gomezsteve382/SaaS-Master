/**
 * ISO 14229-1 named constants — numeric value + human label pairs for
 * every common parameter category. Each constant set is exported as a
 * typed record so callers get autocomplete on both key names and values.
 */

// ── Diagnostic Sessions ───────────────────────────────────────────────

export const sessions = {
  defaultSession:             0x01,
  programmingSession:         0x02,
  extendedDiagnosticSession:  0x03,
  safetySystemDiagnosticSession: 0x04,
} as const;
export type SessionName = keyof typeof sessions;
export type SessionValue = (typeof sessions)[SessionName];

export const sessionLabels: Record<SessionValue, string> = {
  0x01: 'Default Session',
  0x02: 'Programming Session',
  0x03: 'Extended Diagnostic Session',
  0x04: 'Safety System Diagnostic Session',
};

// ── ECU Reset Types ───────────────────────────────────────────────────

export const resetTypes = {
  hardReset:               0x01,
  keyOffOnReset:           0x02,
  softReset:               0x03,
  enableRapidPowerShutDown:  0x04,
  disableRapidPowerShutDown: 0x05,
} as const;
export type ResetTypeName = keyof typeof resetTypes;
export type ResetTypeValue = (typeof resetTypes)[ResetTypeName];

export const resetTypeLabels: Record<ResetTypeValue, string> = {
  0x01: 'Hard Reset',
  0x02: 'Key-Off/On Reset',
  0x03: 'Soft Reset',
  0x04: 'Enable Rapid Power Shutdown',
  0x05: 'Disable Rapid Power Shutdown',
};

// ── Security Access Levels ────────────────────────────────────────────
// Odd sub-function bytes request a seed; even bytes send the key.
// Standard levels: 0x01/0x02 = level 1, 0x03/0x04 = level 2, …

export const securityLevels = {
  level1_requestSeed: 0x01,
  level1_sendKey:     0x02,
  level2_requestSeed: 0x03,
  level2_sendKey:     0x04,
  level3_requestSeed: 0x05,
  level3_sendKey:     0x06,
  level5_requestSeed: 0x09,
  level5_sendKey:     0x0A,
  levelTA_requestSeed: 0x11,
  levelTA_sendKey:     0x12,
} as const;
export type SecurityLevelName = keyof typeof securityLevels;
export type SecurityLevelValue = (typeof securityLevels)[SecurityLevelName];

/** True when the sub-function byte requests a seed (odd). */
export function isSeedRequest(subFunc: number): boolean { return (subFunc & 1) === 1; }
/** True when the sub-function byte sends a key (even, non-zero). */
export function isKeyResponse(subFunc: number): boolean { return subFunc > 0 && (subFunc & 1) === 0; }
/** Return the corresponding seed sub-function for a key sub-function and vice-versa. */
export function peerSecuritySubFunc(subFunc: number): number {
  return isSeedRequest(subFunc) ? subFunc + 1 : subFunc - 1;
}

// ── Routine Control Types ─────────────────────────────────────────────

export const routineControlTypes = {
  startRoutine:          0x01,
  stopRoutine:           0x02,
  requestRoutineResults: 0x03,
} as const;
export type RoutineControlTypeName = keyof typeof routineControlTypes;
export type RoutineControlTypeValue = (typeof routineControlTypes)[RoutineControlTypeName];

export const routineControlTypeLabels: Record<RoutineControlTypeValue, string> = {
  0x01: 'Start Routine',
  0x02: 'Stop Routine',
  0x03: 'Request Routine Results',
};

// ── DTC Status Mask bits (ISO 14229-1 §B.1) ──────────────────────────

export const dtcStatusMask = {
  testFailed:                  0x01,
  testFailedThisMonitoringCycle: 0x02,
  pendingDTC:                  0x04,
  confirmedDTC:                0x08,
  testNotCompletedSinceLastClear: 0x10,
  testFailedSinceLastClear:    0x20,
  testNotCompletedThisMonitoringCycle: 0x40,
  warningIndicatorRequested:   0x80,
  all:                         0xFF,
} as const;

// ── DTC Report Types (0x19 sub-functions already captured in SERVICES)
// Convenience alias for the most common pair.
export const dtcReportTypes = {
  reportDTCByStatusMask:        0x02,
  reportNumberOfDTCByStatusMask: 0x01,
  reportSupportedDTC:           0x0A,
  reportDTCWithPermanentStatus: 0x15,
} as const;

// ── Communication Control types ───────────────────────────────────────

export const commCtrlTypes = {
  enableRxAndTx:             0x00,
  enableRxAndDisableTx:      0x01,
  disableRxAndEnableTx:      0x02,
  disableRxAndTx:            0x03,
} as const;
export type CommCtrlTypeName = keyof typeof commCtrlTypes;
export type CommCtrlTypeValue = (typeof commCtrlTypes)[CommCtrlTypeName];

export const commCtrlSubnets = {
  normalCommunicationMessages:        0x01,
  nmCommunicationMessages:            0x02,
  networkManagementCommunication:     0x03,
  allNetworkMessages:                 0x04,
} as const;

// ── IO Control Parameter (returnControlToECU, etc.) ──────────────────

export const ioControlParams = {
  returnControlToECU:     0x00,
  resetToDefault:         0x01,
  freezeCurrentState:     0x02,
  shortTermAdjustment:    0x03,
} as const;
export type IoControlParamName = keyof typeof ioControlParams;
export type IoControlParamValue = (typeof ioControlParams)[IoControlParamName];

export const ioControlParamLabels: Record<IoControlParamValue, string> = {
  0x00: 'Return Control to ECU',
  0x01: 'Reset to Default',
  0x02: 'Freeze Current State',
  0x03: 'Short-Term Adjustment',
};

// ── Control DTC Setting sub-functions ────────────────────────────────

export const dtcSettingTypes = {
  on:  0x01,
  off: 0x02,
} as const;

// ── Link Control baudrate identifiers ────────────────────────────────

export const linkControlBaudrates = {
  baud9600:   0x01,
  baud19200:  0x02,
  baud38400:  0x03,
  baud57600:  0x04,
  baud115200: 0x05,
  baud250000: 0x10,
  baud500000: 0x11,
  baud1000000: 0x12,
} as const;
