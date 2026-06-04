/**
 * ISO 14229-1 pure frame builders.
 *
 * Every function takes a typed argument object and returns a Uint8Array
 * request frame. No transport, no state — byte-in / byte-out.
 *
 * Naming follows the ISO 14229 service name with the first letter
 * lower-cased, matching UDS convention (e.g. build.ecuReset).
 */

import { sessions, SessionName, resetTypes, ResetTypeName, routineControlTypes, RoutineControlTypeName, ioControlParams, IoControlParamValue, commCtrlTypes, CommCtrlTypeValue, commCtrlSubnets } from './constants.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function u8(n: number): number { return n & 0xFF; }

function u16Bytes(n: number): [number, number] {
  return [(n >> 8) & 0xFF, n & 0xFF];
}

function u32Bytes(n: number): [number, number, number, number] {
  const v = n >>> 0;
  return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

function bytes(arr: number[]): Uint8Array { return new Uint8Array(arr); }

/**
 * Encode a memory address and data/memory length into the ISO 14229
 * addressAndLengthFormatIdentifier byte + address bytes + size bytes.
 *
 * alfid (default 0x44): high nibble = size byte count, low nibble = address byte count.
 */
function encodeAddressAndLength(
  addr: number, length: number, alfid: number = 0x44
): { alfid: number; addrBytes: number[]; lenBytes: number[] } {
  const addrLen = alfid & 0x0F;
  const sizeLen = (alfid >> 4) & 0x0F;
  if (addrLen < 1 || addrLen > 4 || sizeLen < 1 || sizeLen > 4) {
    throw new RangeError(`encodeAddressAndLength: ALFID nibbles must be 1–4, got 0x${alfid.toString(16)}`);
  }
  const a = addr >>> 0;
  const l = length >>> 0;
  const addrBytes: number[] = [];
  for (let i = addrLen - 1; i >= 0; i--) addrBytes.push((a >>> (i * 8)) & 0xFF);
  const lenBytes: number[] = [];
  for (let i = sizeLen - 1; i >= 0; i--) lenBytes.push((l >>> (i * 8)) & 0xFF);
  return { alfid, addrBytes, lenBytes };
}

// ─── Diagnostic and Communication Management ──────────────────────────

export interface DiagnosticSessionControlArgs {
  /** Sub-function byte OR a session name key from the sessions constant map. */
  session: SessionName | number;
}

/** Build a 0x10 DiagnosticSessionControl frame. */
export function diagnosticSessionControl({ session }: DiagnosticSessionControlArgs): Uint8Array {
  const sub: number = typeof session === 'string' ? sessions[session] : u8(session);
  return bytes([0x10, sub]);
}

export interface EcuResetArgs {
  /** Sub-function byte OR a reset type name. */
  resetType: ResetTypeName | number;
}

/** Build a 0x11 ECUReset frame. */
export function ecuReset({ resetType }: EcuResetArgs): Uint8Array {
  const sub: number = typeof resetType === 'string' ? resetTypes[resetType] : u8(resetType);
  return bytes([0x11, sub]);
}

export interface SecurityAccessArgs {
  /** Sub-function byte: odd = requestSeed, even = sendKey. */
  subFunction: number;
  /** For sendKey requests: the key bytes to send. Omit for requestSeed. */
  data?: Uint8Array | number[];
}

/** Build a 0x27 SecurityAccess frame (requestSeed or sendKey). */
export function securityAccess({ subFunction, data }: SecurityAccessArgs): Uint8Array {
  const body: number[] = [0x27, u8(subFunction)];
  if (data && data.length > 0) body.push(...Array.from(data));
  return bytes(body);
}

export interface CommunicationControlArgs {
  controlType: CommCtrlTypeValue | number;
  /** Communication type byte: bit 3–0 = sub-network number, bit 7–4 = communication type. Default 0x01. */
  communicationType?: number;
  /** Optional node identifier for enhanced addressing (bytes). */
  nodeIdentificationNumber?: number;
}

/** Build a 0x28 CommunicationControl frame. */
export function communicationControl({ controlType, communicationType = 0x01, nodeIdentificationNumber }: CommunicationControlArgs): Uint8Array {
  const body: number[] = [0x28, u8(controlType), u8(communicationType)];
  if (nodeIdentificationNumber !== undefined) body.push(...u16Bytes(nodeIdentificationNumber));
  return bytes(body);
}

export interface AuthenticationArgs {
  /** Sub-function from 0x00 (deAuthenticate) through 0x08 (authenticationConfiguration). */
  subFunction: number;
  /**
   * Payload for the sub-function:
   * - 0x01/0x02 verifyCertificate*: certificate bytes
   * - 0x03 proofOfOwnership: proof-of-ownership record bytes
   * - 0x04 transmitCertificate: certificate data bytes
   * - 0x05 requestChallenge: algorithm indicator bytes
   * - 0x06/0x07 verifyProofOfOwnership*: ownership proof bytes
   * - 0x08 authenticationConfiguration: configuration data bytes
   * - 0x00 deAuthenticate: no payload
   */
  data?: Uint8Array | number[];
}

/** Build a 0x29 Authentication frame. */
export function authentication({ subFunction, data }: AuthenticationArgs): Uint8Array {
  const body: number[] = [0x29, u8(subFunction)];
  if (data && data.length > 0) body.push(...Array.from(data));
  return bytes(body);
}

export interface ReadDataByPeriodicIdentifierArgs {
  /** Transmission mode sub-function: 0x01 slow, 0x02 medium, 0x03 fast, 0x04 stop. */
  transmissionMode: 0x01 | 0x02 | 0x03 | 0x04 | number;
  /** One or more 8-bit periodic data identifiers (PDIDs). */
  periodicIdentifiers: number[];
}

/** Build a 0x2A ReadDataByPeriodicIdentifier frame. */
export function readDataByPeriodicIdentifier({ transmissionMode, periodicIdentifiers }: ReadDataByPeriodicIdentifierArgs): Uint8Array {
  if (!periodicIdentifiers.length) throw new TypeError('readDataByPeriodicIdentifier: periodicIdentifiers array is empty');
  const body: number[] = [0x2A, u8(transmissionMode)];
  for (const pid of periodicIdentifiers) body.push(u8(pid));
  return bytes(body);
}

export interface SecuredDataTransmissionArgs {
  /** Encrypted / secured application data bytes to be transmitted inside the 0x84 wrapper. */
  securityDataRequestRecord: Uint8Array | number[];
}

/** Build a 0x84 SecuredDataTransmission frame. */
export function securedDataTransmission({ securityDataRequestRecord }: SecuredDataTransmissionArgs): Uint8Array {
  if (!securityDataRequestRecord || !securityDataRequestRecord.length) {
    throw new TypeError('securedDataTransmission: securityDataRequestRecord is empty');
  }
  return bytes([0x84, ...Array.from(securityDataRequestRecord)]);
}

export interface TesterPresentArgs {
  /** 0x00 = request positive response; 0x80 = suppress positive response (most common). Default 0x00. */
  subFunction?: number;
}

/** Build a 0x3E TesterPresent frame. */
export function testerPresent({ subFunction = 0x00 }: TesterPresentArgs = {}): Uint8Array {
  return bytes([0x3E, u8(subFunction)]);
}

export interface AccessTimingParameterArgs {
  subFunction: number;
  /** For setTimingParametersToGivenValues (0x04): [p2ServerMax_hi, p2ServerMax_lo, p2eServerMax_hi, p2eServerMax_lo]. */
  timingParameterLink?: number[];
}

/** Build a 0x83 AccessTimingParameter frame. */
export function accessTimingParameter({ subFunction, timingParameterLink }: AccessTimingParameterArgs): Uint8Array {
  const body: number[] = [0x83, u8(subFunction)];
  if (timingParameterLink && timingParameterLink.length > 0) body.push(...timingParameterLink);
  return bytes(body);
}

export interface ControlDtcSettingArgs {
  /** 0x01 = on, 0x02 = off. */
  dtcSettingType: 0x01 | 0x02 | number;
  /** Optional DTC setting control option record. */
  dtcSettingControlOptionRecord?: number[];
}

/** Build a 0x85 ControlDTCSetting frame. */
export function controlDtcSetting({ dtcSettingType, dtcSettingControlOptionRecord }: ControlDtcSettingArgs): Uint8Array {
  const body: number[] = [0x85, u8(dtcSettingType)];
  if (dtcSettingControlOptionRecord && dtcSettingControlOptionRecord.length > 0) {
    body.push(...dtcSettingControlOptionRecord);
  }
  return bytes(body);
}

export interface ResponseOnEventArgs {
  subFunction: number;
  /** Window time for event response in ms (encoded as 1-byte per ISO — e.g. 0x02 = 20ms). */
  windowTime?: number;
  /** Event type record bytes. */
  eventTypeRecord?: number[];
  /** Service to respond with (service ID). */
  serviceToRespondToRecord?: number[];
}

/** Build a 0x86 ResponseOnEvent frame. */
export function responseOnEvent({ subFunction, windowTime = 0x02, eventTypeRecord, serviceToRespondToRecord }: ResponseOnEventArgs): Uint8Array {
  const body: number[] = [0x86, u8(subFunction), u8(windowTime)];
  if (eventTypeRecord && eventTypeRecord.length > 0) body.push(...eventTypeRecord);
  if (serviceToRespondToRecord && serviceToRespondToRecord.length > 0) body.push(...serviceToRespondToRecord);
  return bytes(body);
}

export interface LinkControlArgs {
  subFunction: number;
  /** Baud rate identifier (0x01–0x05, 0x10–0x12) or 0x00 for specific baud rate link record. */
  linkBaudrateRecord?: number | number[];
}

/** Build a 0x87 LinkControl frame. */
export function linkControl({ subFunction, linkBaudrateRecord }: LinkControlArgs): Uint8Array {
  const body: number[] = [0x87, u8(subFunction)];
  if (linkBaudrateRecord !== undefined) {
    if (Array.isArray(linkBaudrateRecord)) {
      body.push(...linkBaudrateRecord);
    } else {
      body.push(u8(linkBaudrateRecord));
    }
  }
  return bytes(body);
}

// ─── Data Transmission ────────────────────────────────────────────────

export interface ReadDataByIdentifierArgs {
  /** One or more 16-bit DIDs to read. */
  dids: number[];
}

/** Build a 0x22 ReadDataByIdentifier frame (supports multi-DID). */
export function readDataByIdentifier({ dids }: ReadDataByIdentifierArgs): Uint8Array {
  if (!dids.length) throw new TypeError('readDataByIdentifier: dids array is empty');
  const body: number[] = [0x22];
  for (const did of dids) {
    if (did < 0 || did > 0xFFFF) throw new RangeError(`readDataByIdentifier: DID 0x${did.toString(16)} out of 16-bit range`);
    body.push(...u16Bytes(did));
  }
  return bytes(body);
}

export interface ReadMemoryByAddressArgs {
  address: number;
  length: number;
  /** addressAndLengthFormatIdentifier. Default 0x44 (4-byte addr + 4-byte length). */
  alfid?: number;
}

/** Build a 0x23 ReadMemoryByAddress frame. */
export function readMemoryByAddress({ address, length, alfid = 0x44 }: ReadMemoryByAddressArgs): Uint8Array {
  const { addrBytes, lenBytes } = encodeAddressAndLength(address, length, alfid);
  return bytes([0x23, alfid, ...addrBytes, ...lenBytes]);
}

export interface ReadScalingDataByIdentifierArgs {
  did: number;
}

/** Build a 0x24 ReadScalingDataByIdentifier frame. */
export function readScalingDataByIdentifier({ did }: ReadScalingDataByIdentifierArgs): Uint8Array {
  if (did < 0 || did > 0xFFFF) throw new RangeError(`readScalingDataByIdentifier: DID out of range`);
  return bytes([0x24, ...u16Bytes(did)]);
}

export interface DynamicallyDefineDataIdentifierArgs {
  subFunction: 0x01 | 0x02 | 0x03 | number;
  /**
   * The 16-bit target dynamically-defined data identifier (DDDID) being
   * defined or cleared.
   *
   * - 0x01 defineByIdentifier: REQUIRED — the new DDDID to create
   * - 0x02 defineByMemoryAddress: REQUIRED — the new DDDID to create
   * - 0x03 clearDynamicallyDefinedDataIdentifier: OPTIONAL — omit to clear all DDDIDs
   */
  dynamicallyDefinedDataIdentifier?: number;
  /** For defineByIdentifier (0x01): one or more source DID records. */
  defineByIdentifier?: Array<{ sourceDataIdentifier: number; positionInSource: number; memorySize: number }>;
  /** For defineByMemoryAddress (0x02): memory region to map into the DDDID. */
  defineByMemoryAddress?: { alfid?: number; address: number; length: number };
}

/** Build a 0x2C DynamicallyDefineDataIdentifier frame. */
export function dynamicallyDefineDataIdentifier(args: DynamicallyDefineDataIdentifierArgs): Uint8Array {
  const { subFunction } = args;
  const body: number[] = [0x2C, u8(subFunction)];

  if (subFunction === 0x01) {
    // defineByIdentifier: [0x2C 0x01] targetDDDID(2) [sourceID(2) posInSource(1) memSize(1)]+
    if (args.dynamicallyDefinedDataIdentifier === undefined) {
      throw new TypeError('dynamicallyDefineDataIdentifier 0x01: dynamicallyDefinedDataIdentifier (target DDDID) is required');
    }
    body.push(...u16Bytes(args.dynamicallyDefinedDataIdentifier));
    if (args.defineByIdentifier && args.defineByIdentifier.length > 0) {
      for (const entry of args.defineByIdentifier) {
        body.push(...u16Bytes(entry.sourceDataIdentifier), u8(entry.positionInSource), u8(entry.memorySize));
      }
    }
  } else if (subFunction === 0x02) {
    // defineByMemoryAddress: [0x2C 0x02] targetDDDID(2) ALFID(1) addr(N) len(M)
    if (args.dynamicallyDefinedDataIdentifier === undefined) {
      throw new TypeError('dynamicallyDefineDataIdentifier 0x02: dynamicallyDefinedDataIdentifier (target DDDID) is required');
    }
    body.push(...u16Bytes(args.dynamicallyDefinedDataIdentifier));
    if (args.defineByMemoryAddress) {
      const { alfid = 0x44, address, length } = args.defineByMemoryAddress;
      const { addrBytes, lenBytes } = encodeAddressAndLength(address, length, alfid);
      body.push(alfid, ...addrBytes, ...lenBytes);
    }
  } else if (subFunction === 0x03) {
    // clearDynamicallyDefinedDataIdentifier: [0x2C 0x03] [targetDDDID(2)]  (optional — omit to clear all)
    if (args.dynamicallyDefinedDataIdentifier !== undefined) {
      body.push(...u16Bytes(args.dynamicallyDefinedDataIdentifier));
    }
  }

  return bytes(body);
}

export interface WriteDataByIdentifierArgs {
  did: number;
  data: Uint8Array | number[];
}

/** Build a 0x2E WriteDataByIdentifier frame. */
export function writeDataByIdentifier({ did, data }: WriteDataByIdentifierArgs): Uint8Array {
  if (did < 0 || did > 0xFFFF) throw new RangeError(`writeDataByIdentifier: DID out of range`);
  if (!data || !data.length) throw new TypeError('writeDataByIdentifier: data is empty');
  return bytes([0x2E, ...u16Bytes(did), ...Array.from(data)]);
}

export interface WriteMemoryByAddressArgs {
  address: number;
  data: Uint8Array | number[];
  alfid?: number;
}

/** Build a 0x3D WriteMemoryByAddress frame. */
export function writeMemoryByAddress({ address, data, alfid = 0x44 }: WriteMemoryByAddressArgs): Uint8Array {
  if (!data || !data.length) throw new TypeError('writeMemoryByAddress: data is empty');
  const { addrBytes, lenBytes } = encodeAddressAndLength(address, data.length, alfid);
  return bytes([0x3D, alfid, ...addrBytes, ...lenBytes, ...Array.from(data)]);
}

// ─── Stored Data Transmission ─────────────────────────────────────────

export interface ClearDiagnosticInformationArgs {
  /** 3-byte group of DTC (e.g. 0xFFFFFF = all). Default: 0xFFFFFF. */
  groupOfDtc?: number;
}

/** Build a 0x14 ClearDiagnosticInformation frame. */
export function clearDiagnosticInformation({ groupOfDtc = 0xFFFFFF }: ClearDiagnosticInformationArgs = {}): Uint8Array {
  const g = groupOfDtc >>> 0;
  return bytes([0x14, (g >> 16) & 0xFF, (g >> 8) & 0xFF, g & 0xFF]);
}

export interface ReadDtcInformationArgs {
  subFunction: number;
  /** DTC status mask for sub-functions that need it (0x01, 0x02, etc.). Default 0x08 (confirmedDTC). */
  dtcStatusMask?: number;
  /** 3-byte DTC number for sub-functions that need it (0x04, 0x06, etc.). */
  dtcNumber?: number;
  /** Record number for sub-functions that need it (0x05, 0x16, etc.). */
  dtcSnapshotRecordNumber?: number;
  /** Extended data record number (0x06). */
  dtcExtDataRecordNumber?: number;
  /** Severity mask for 0x07 / 0x08. */
  dtcSeverityMask?: number;
  /** User-defined memory address for 0x17–0x19. */
  memorySelection?: number;
}

/** Build a 0x19 ReadDTCInformation frame. */
export function readDtcInformation({
  subFunction,
  dtcStatusMask = 0x08,
  dtcNumber,
  dtcSnapshotRecordNumber = 0xFF,
  dtcExtDataRecordNumber = 0xFF,
  dtcSeverityMask = 0xFF,
  memorySelection,
}: ReadDtcInformationArgs): Uint8Array {
  const body: number[] = [0x19, u8(subFunction)];
  // Status-mask sub-functions (0x01, 0x02, 0x07, 0x08, 0x0F, 0x11, 0x12, 0x13, 0x15)
  const needsStatusMask = [0x01, 0x02, 0x07, 0x08, 0x0F, 0x11, 0x12, 0x13, 0x15].includes(subFunction);
  const needsDtcNumber = [0x04, 0x06, 0x10, 0x18, 0x19].includes(subFunction);
  const needsSeverity  = [0x07, 0x08].includes(subFunction);

  if (needsStatusMask) {
    if (needsSeverity) body.push(u8(dtcSeverityMask));
    body.push(u8(dtcStatusMask));
  } else if (needsDtcNumber && dtcNumber !== undefined) {
    const d = dtcNumber >>> 0;
    body.push((d >> 16) & 0xFF, (d >> 8) & 0xFF, d & 0xFF);
    if (subFunction === 0x04) body.push(u8(dtcSnapshotRecordNumber));
    if (subFunction === 0x06 || subFunction === 0x10) body.push(u8(dtcExtDataRecordNumber));
  }
  if (memorySelection !== undefined && [0x17, 0x18, 0x19].includes(subFunction)) {
    body.push(u8(memorySelection));
  }
  return bytes(body);
}

// ─── Input/Output Control ─────────────────────────────────────────────

export interface InputOutputControlByIdentifierArgs {
  did: number;
  /** IO control parameter byte (returnControlToECU=0x00, resetToDefault=0x01, freezeCurrentState=0x02, shortTermAdjustment=0x03). */
  controlOptionRecord: IoControlParamValue | number;
  /** For shortTermAdjustment (0x03): the value to set. */
  controlEnableMaskRecord?: number[];
}

/** Build a 0x2F InputOutputControlByIdentifier frame. */
export function inputOutputControlByIdentifier({
  did,
  controlOptionRecord,
  controlEnableMaskRecord,
}: InputOutputControlByIdentifierArgs): Uint8Array {
  const body: number[] = [0x2F, ...u16Bytes(did), u8(controlOptionRecord)];
  if (controlEnableMaskRecord && controlEnableMaskRecord.length > 0) body.push(...controlEnableMaskRecord);
  return bytes(body);
}

// ─── Routine Control ──────────────────────────────────────────────────

export interface RoutineControlArgs {
  type: RoutineControlTypeName | number;
  /** 16-bit routine identifier. */
  routineIdentifier: number;
  /** Optional routine option record bytes. */
  routineOptionRecord?: number[];
}

/** Build a 0x31 RoutineControl frame (start / stop / requestResults). */
export function routineControl({ type, routineIdentifier, routineOptionRecord }: RoutineControlArgs): Uint8Array {
  const sub: number = typeof type === 'string' ? routineControlTypes[type] : u8(type);
  if (routineIdentifier < 0 || routineIdentifier > 0xFFFF) throw new RangeError('routineControl: routineIdentifier out of range');
  const body: number[] = [0x31, sub, ...u16Bytes(routineIdentifier)];
  if (routineOptionRecord && routineOptionRecord.length > 0) body.push(...routineOptionRecord);
  return bytes(body);
}

// ─── Upload / Download ────────────────────────────────────────────────

export interface RequestDownloadArgs {
  /** Data format identifier. 0x00 = no encryption, no compression. */
  dataFormatIdentifier?: number;
  address: number;
  length: number;
  /** addressAndLengthFormatIdentifier. Default 0x44. */
  alfid?: number;
}

/** Build a 0x34 RequestDownload frame. */
export function requestDownload({ dataFormatIdentifier = 0x00, address, length, alfid = 0x44 }: RequestDownloadArgs): Uint8Array {
  const { addrBytes, lenBytes } = encodeAddressAndLength(address, length, alfid);
  return bytes([0x34, u8(dataFormatIdentifier), alfid, ...addrBytes, ...lenBytes]);
}

export interface RequestUploadArgs {
  dataFormatIdentifier?: number;
  address: number;
  length: number;
  alfid?: number;
}

/** Build a 0x35 RequestUpload frame. */
export function requestUpload({ dataFormatIdentifier = 0x00, address, length, alfid = 0x44 }: RequestUploadArgs): Uint8Array {
  const { addrBytes, lenBytes } = encodeAddressAndLength(address, length, alfid);
  return bytes([0x35, u8(dataFormatIdentifier), alfid, ...addrBytes, ...lenBytes]);
}

export interface TransferDataArgs {
  /** Block sequence counter (0x00–0xFF, wraps at 0xFF). */
  blockSequenceCounter: number;
  data: Uint8Array | number[];
}

/** Build a 0x36 TransferData frame. */
export function transferData({ blockSequenceCounter, data }: TransferDataArgs): Uint8Array {
  if (!data || !data.length) throw new TypeError('transferData: data is empty');
  return bytes([0x36, u8(blockSequenceCounter), ...Array.from(data)]);
}

export interface RequestTransferExitArgs {
  /** Optional transfer response parameter record. */
  transferRequestParameterRecord?: number[];
}

/** Build a 0x37 RequestTransferExit frame. */
export function requestTransferExit({ transferRequestParameterRecord }: RequestTransferExitArgs = {}): Uint8Array {
  const body: number[] = [0x37];
  if (transferRequestParameterRecord && transferRequestParameterRecord.length > 0) {
    body.push(...transferRequestParameterRecord);
  }
  return bytes(body);
}

export interface RequestFileTransferArgs {
  modeOfOperation: number;
  fileSizeParameterLength?: number;
  fileSizeUncompressed?: number;
  fileSizeCompressed?: number;
  dataFormatIdentifier?: number;
  /** UTF-8 encoded file path bytes, or a string which will be ASCII-encoded. */
  filePathAndName?: string | number[];
}

/** Build a 0x38 RequestFileTransfer frame. */
export function requestFileTransfer({
  modeOfOperation,
  fileSizeParameterLength = 0,
  fileSizeUncompressed = 0,
  fileSizeCompressed = 0,
  dataFormatIdentifier = 0x00,
  filePathAndName = [],
}: RequestFileTransferArgs): Uint8Array {
  const pathBytes: number[] = typeof filePathAndName === 'string'
    ? Array.from(filePathAndName, c => c.charCodeAt(0) & 0xFF)
    : Array.from(filePathAndName);
  const pathLen = pathBytes.length;
  const body: number[] = [
    0x38, u8(modeOfOperation),
    (pathLen >> 8) & 0xFF, pathLen & 0xFF,
    ...pathBytes,
    u8(dataFormatIdentifier),
    u8(fileSizeParameterLength),
  ];
  if (fileSizeParameterLength > 0) {
    const pl = fileSizeParameterLength;
    for (let i = pl - 1; i >= 0; i--) body.push((fileSizeUncompressed >>> (i * 8)) & 0xFF);
    for (let i = pl - 1; i >= 0; i--) body.push((fileSizeCompressed  >>> (i * 8)) & 0xFF);
  }
  return bytes(body);
}
