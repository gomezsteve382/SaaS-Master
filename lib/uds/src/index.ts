/**
 * @workspace/uds — ISO 14229-1 UDS (Unified Diagnostic Services) library
 *
 * Exports a complete, pure-JavaScript/TypeScript UDS surface covering
 * every standard service (0x10–0x87), all NRCs (0x10–0x93), frame
 * builders, response parsers, standard DID catalog, and ISO-TP framing.
 *
 * All functions are pure (no I/O, no state) and work in any environment:
 * browser, Node.js, Web Worker.
 *
 * Quick start:
 *   import { build, parse, nrc, services, dids, isotp } from '@workspace/uds';
 *
 *   const frame = build.readDataByIdentifier({ dids: [0xF190] });
 *   // → Uint8Array [0x22, 0xF1, 0x90]
 *
 *   const result = parse.response(rawResponse);
 *   // → { ok: true, sid: 0x22, serviceName: 'ReadDataByIdentifier', payload: Uint8Array(...) }
 */

// ── Service table ────────────────────────────────────────────────────
export type { Service, ServiceSubFunction } from './services.js';
export { SERVICES, serviceForSid, serviceForPosRsp } from './services.js';

// ── NRC table ────────────────────────────────────────────────────────
export type { NRCEntry } from './nrc.js';
export { NRC_TABLE, nrcEntry, nrcDescription, nrcIsPending } from './nrc.js';

// ── Constants ────────────────────────────────────────────────────────
export type {
  SessionName, SessionValue,
  ResetTypeName, ResetTypeValue,
  SecurityLevelName, SecurityLevelValue,
  RoutineControlTypeName, RoutineControlTypeValue,
  CommCtrlTypeName, CommCtrlTypeValue,
  IoControlParamName, IoControlParamValue,
} from './constants.js';
export {
  sessions, sessionLabels,
  resetTypes, resetTypeLabels,
  securityLevels, isSeedRequest, isKeyResponse, peerSecuritySubFunc,
  routineControlTypes, routineControlTypeLabels,
  dtcStatusMask,
  dtcReportTypes,
  commCtrlTypes, commCtrlSubnets,
  ioControlParams, ioControlParamLabels,
  dtcSettingTypes,
  linkControlBaudrates,
} from './constants.js';

// ── Frame builders — namespaced as `build.*` ─────────────────────────
export type {
  DiagnosticSessionControlArgs,
  EcuResetArgs,
  SecurityAccessArgs,
  AuthenticationArgs,
  CommunicationControlArgs,
  TesterPresentArgs,
  AccessTimingParameterArgs,
  ControlDtcSettingArgs,
  ResponseOnEventArgs,
  LinkControlArgs,
  ReadDataByIdentifierArgs,
  ReadMemoryByAddressArgs,
  ReadScalingDataByIdentifierArgs,
  ReadDataByPeriodicIdentifierArgs,
  DynamicallyDefineDataIdentifierArgs,
  WriteDataByIdentifierArgs,
  WriteMemoryByAddressArgs,
  ClearDiagnosticInformationArgs,
  ReadDtcInformationArgs,
  InputOutputControlByIdentifierArgs,
  RoutineControlArgs,
  RequestDownloadArgs,
  RequestUploadArgs,
  TransferDataArgs,
  RequestTransferExitArgs,
  RequestFileTransferArgs,
  SecuredDataTransmissionArgs,
} from './build.js';

export {
  diagnosticSessionControl,
  ecuReset,
  securityAccess,
  authentication,
  communicationControl,
  testerPresent,
  accessTimingParameter,
  controlDtcSetting,
  responseOnEvent,
  linkControl,
  readDataByIdentifier,
  readMemoryByAddress,
  readScalingDataByIdentifier,
  readDataByPeriodicIdentifier,
  dynamicallyDefineDataIdentifier,
  writeDataByIdentifier,
  writeMemoryByAddress,
  clearDiagnosticInformation,
  readDtcInformation,
  inputOutputControlByIdentifier,
  routineControl,
  requestDownload,
  requestUpload,
  transferData,
  requestTransferExit,
  requestFileTransfer,
  securedDataTransmission,
} from './build.js';

/** Convenience namespace: `build.readDataByIdentifier(...)` etc. */
export * as build from './build.js';

// ── Response parser — namespaced as `parse.*` ────────────────────────
export type {
  ParsedResponse,
  ReadDbiParsedResult,
  SecurityAccessSeedResult,
  RoutineControlParsedResult,
  RequestDownloadParsedResult,
} from './parse.js';
export {
  parseResponse,
  parseReadDataByIdentifierResponse,
  parseSecurityAccessSeedResponse,
  parseRoutineControlResponse,
  parseRequestDownloadResponse,
} from './parse.js';

/** Convenience namespace: `parse.response(...)` etc. */
export * as parse from './parse.js';

// ── DID catalog ──────────────────────────────────────────────────────
export type { DidEntry, DidEncoding } from './dids.js';
export { DID_CATALOG, didEntry, decodeDid } from './dids.js';

/** Convenience namespace: `dids.didEntry(...)`, `dids.decodeDid(...)`. */
export * as dids from './dids.js';

// ── ISO-TP framing ───────────────────────────────────────────────────
export type {
  AddressingMode, FlowStatus,
  IsoTpOptions, FlowControlArgs,
  DecodedFlowControl, SegmentedFrames, FrameType,
  CanAddressConfig, CanFrame,
} from './isotp.js';
export {
  encodeSingleFrame,
  encodeFirstFrame,
  encodeConsecutiveFrame,
  encodeFlowControl,
  decodeFlowControl,
  segmentPayload,
  frameType,
  extractSingleFramePayload,
  extractFirstFramePayload,
  extractConsecutiveFramePayload,
  reassembleFrames,
  IsoTpReceiver,
  txCanId,
  rxCanId,
  functionalCanId,
  wrapForCan,
} from './isotp.js';

/** Convenience namespace: `isotp.segmentPayload(...)` etc. */
export * as isotp from './isotp.js';

// ── Re-export NRC table as `nrc` namespace ───────────────────────────
export * as nrc from './nrc.js';

// ── Re-export services table as `services` namespace ─────────────────
export * as services from './services.js';
