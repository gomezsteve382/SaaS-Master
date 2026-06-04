/**
 * ISO 15765-2 (ISO-TP) framing helpers — CAN classic, 8-byte frames.
 *
 * Supports:
 *   - Single Frame (SF, PCI 0x0x) for payloads ≤ 7 bytes
 *   - First Frame (FF, PCI 0x1x) for the first 6 bytes of a segmented message
 *   - Consecutive Frame (CF, PCI 0x2x) for subsequent blocks
 *   - Flow Control (FC, PCI 0x3x) — both encode and decode
 *
 * Supports 11-bit (normal addressing) and 29-bit (extended / mixed)
 * CAN IDs via the addressingMode parameter.
 *
 * Padding: per ISO 15765-2 §9.8.3, unused bytes in a CAN frame
 * should be padded with a configurable byte (default 0xCC, the
 * dominant value chosen by FCA/Stellantis tooling).
 */

export type AddressingMode = '11bit' | '29bit';
export type FlowStatus = 'continueToSend' | 'wait' | 'overflow';

export interface IsoTpOptions {
  /** Padding byte for unused CAN frame octets. Default: 0xCC. */
  padding?: number;
  /** Addressing mode for CAN ID conventions. Default: '11bit'. */
  addressingMode?: AddressingMode;
  /** Block size for flow-control frames (0 = send all). Default: 0. */
  blockSize?: number;
  /** Separation time minimum (STmin byte value). Default: 0x00 (no delay). */
  stMin?: number;
}

const DEFAULT_OPTS: Required<IsoTpOptions> = {
  padding: 0xCC,
  addressingMode: '11bit',
  blockSize: 0,
  stMin: 0x00,
};

function pad(frame: number[], padByte: number): Uint8Array {
  const out = new Uint8Array(8).fill(padByte);
  for (let i = 0; i < Math.min(frame.length, 8); i++) out[i] = frame[i];
  return out;
}

// ─── Single Frame ─────────────────────────────────────────────────────

/**
 * Encode a UDS payload into a Single Frame (PCI byte + data, ≤ 7 bytes).
 * Throws if the payload exceeds 7 bytes (use segmentPayload for larger data).
 */
export function encodeSingleFrame(payload: Uint8Array | number[], opts: IsoTpOptions = {}): Uint8Array {
  const o = { ...DEFAULT_OPTS, ...opts };
  const data = Array.from(payload);
  if (data.length === 0) throw new TypeError('encodeSingleFrame: payload is empty');
  if (data.length > 7) throw new RangeError(`encodeSingleFrame: payload length ${data.length} exceeds SF limit of 7`);
  const pci = data.length & 0x0F;
  return pad([pci, ...data], o.padding);
}

// ─── First Frame ──────────────────────────────────────────────────────

/**
 * Encode the First Frame for a segmented UDS payload.
 * @param totalLength — total byte count of the UDS payload (max 4095 for classic CAN).
 */
export function encodeFirstFrame(payload: Uint8Array | number[], totalLength: number, opts: IsoTpOptions = {}): Uint8Array {
  const o = { ...DEFAULT_OPTS, ...opts };
  const data = Array.from(payload);
  if (totalLength > 0xFFF) throw new RangeError(`encodeFirstFrame: totalLength ${totalLength} exceeds 4095 (ISO-TP classic CAN limit)`);
  const pci1 = 0x10 | ((totalLength >> 8) & 0x0F);
  const pci2 = totalLength & 0xFF;
  const body = [pci1, pci2, ...data.slice(0, 6)];
  return pad(body, o.padding);
}

// ─── Consecutive Frame ────────────────────────────────────────────────

/**
 * Encode a Consecutive Frame with the given sequence number (1–15, then wraps to 0).
 */
export function encodeConsecutiveFrame(
  payload: Uint8Array | number[],
  sequenceNumber: number,
  opts: IsoTpOptions = {}
): Uint8Array {
  const o = { ...DEFAULT_OPTS, ...opts };
  const data = Array.from(payload);
  const sn = sequenceNumber & 0x0F;
  const pci = 0x20 | sn;
  return pad([pci, ...data.slice(0, 7)], o.padding);
}

// ─── Flow Control ─────────────────────────────────────────────────────

export interface FlowControlArgs {
  flowStatus?: FlowStatus;
  blockSize?: number;
  stMin?: number;
}

/**
 * Encode a Flow Control frame.
 *   flowStatus: 'continueToSend' (0) | 'wait' (1) | 'overflow' (2)
 *   blockSize: 0 = send remaining frames without waiting
 *   stMin: separation time min byte
 */
export function encodeFlowControl(args: FlowControlArgs = {}, opts: IsoTpOptions = {}): Uint8Array {
  const o = { ...DEFAULT_OPTS, ...opts };
  const fsMap: Record<FlowStatus, number> = { continueToSend: 0, wait: 1, overflow: 2 };
  const fs = args.flowStatus ?? 'continueToSend';
  const fcByte = 0x30 | (fsMap[fs] & 0x0F);
  const bs = (args.blockSize ?? o.blockSize) & 0xFF;
  const st = (args.stMin ?? o.stMin) & 0xFF;
  return pad([fcByte, bs, st], o.padding);
}

// ─── Flow Control Decoder ─────────────────────────────────────────────

export interface DecodedFlowControl {
  ok: boolean;
  flowStatus: FlowStatus | null;
  flowStatusCode: number | null;
  blockSize: number | null;
  stMinMs: number | null;
}

/**
 * Decode a raw CAN 8-byte flow control frame. Returns stMinMs as the
 * minimum separation time in milliseconds (per ISO 15765-2 table 7).
 */
export function decodeFlowControl(frame: Uint8Array | number[]): DecodedFlowControl {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (d.length < 3 || (d[0] & 0xF0) !== 0x30) return { ok: false, flowStatus: null, flowStatusCode: null, blockSize: null, stMinMs: null };
  const fsc = d[0] & 0x0F;
  const fsNames: Record<number, FlowStatus> = { 0: 'continueToSend', 1: 'wait', 2: 'overflow' };
  const flowStatus = fsNames[fsc] ?? null;
  const blockSize = d[1];
  const stRaw = d[2];
  // ISO 15765-2 §6.5.5.3: 0x00–0x7F = 0–127 ms; 0xF1–0xF9 = 100–900 µs (round to 1 ms)
  let stMinMs: number;
  if (stRaw <= 0x7F) stMinMs = stRaw;
  else if (stRaw >= 0xF1 && stRaw <= 0xF9) stMinMs = 1;
  else stMinMs = 127;
  return { ok: true, flowStatus, flowStatusCode: fsc, blockSize, stMinMs };
}

// ─── High-level segmentation ──────────────────────────────────────────

export interface SegmentedFrames {
  /** All CAN frames in send order: [firstFrame, ...consecutiveFrames] */
  frames: Uint8Array[];
  /** Total number of consecutive frames (not counting the first frame). */
  consecutiveCount: number;
}

/**
 * Segment a UDS payload into ISO-TP CAN frames.
 *
 * Returns an array of 8-byte Uint8Arrays ready to send in order.
 * For payloads ≤ 7 bytes, returns a single Single Frame.
 * For larger payloads, returns [FirstFrame, CF1, CF2, …].
 */
export function segmentPayload(payload: Uint8Array | number[], opts: IsoTpOptions = {}): SegmentedFrames {
  const o = { ...DEFAULT_OPTS, ...opts };
  const data = Array.from(payload);
  const total = data.length;

  if (total === 0) throw new TypeError('segmentPayload: payload is empty');

  if (total <= 7) {
    return { frames: [encodeSingleFrame(data, o)], consecutiveCount: 0 };
  }

  if (total > 0xFFF) throw new RangeError(`segmentPayload: payload length ${total} exceeds ISO-TP classic CAN limit of 4095`);

  const frames: Uint8Array[] = [];

  // First Frame carries 6 bytes of payload
  frames.push(encodeFirstFrame(data.slice(0, 6), total, o));

  // Consecutive Frames carry 7 bytes each
  let offset = 6;
  let sn = 1;
  while (offset < total) {
    const chunk = data.slice(offset, offset + 7);
    frames.push(encodeConsecutiveFrame(chunk, sn, o));
    offset += 7;
    sn = sn >= 0x0F ? 0 : sn + 1;
  }

  return { frames, consecutiveCount: frames.length - 1 };
}

// ─── PCI / Frame type detection ───────────────────────────────────────

export type FrameType = 'SF' | 'FF' | 'CF' | 'FC' | 'unknown';

/** Identify the ISO-TP frame type from the first byte of a CAN frame. */
export function frameType(firstByte: number): FrameType {
  const pci = (firstByte >> 4) & 0x0F;
  switch (pci) {
    case 0: return 'SF';
    case 1: return 'FF';
    case 2: return 'CF';
    case 3: return 'FC';
    default: return 'unknown';
  }
}

/** Extract UDS payload bytes from a Single Frame (strips PCI). */
export function extractSingleFramePayload(frame: Uint8Array | number[]): Uint8Array {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const length = d[0] & 0x0F;
  return d.slice(1, 1 + length);
}

/** Extract UDS payload bytes from a First Frame (strips PCI, returns first 6 payload bytes). */
export function extractFirstFramePayload(frame: Uint8Array | number[]): { totalLength: number; data: Uint8Array } {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const totalLength = ((d[0] & 0x0F) << 8) | d[1];
  return { totalLength, data: d.slice(2) };
}

/** Extract UDS payload bytes from a Consecutive Frame (strips PCI). */
export function extractConsecutiveFramePayload(frame: Uint8Array | number[]): { sequenceNumber: number; data: Uint8Array } {
  const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  return { sequenceNumber: d[0] & 0x0F, data: d.slice(1) };
}

// ─── RX-side reassembly ───────────────────────────────────────────────

/**
 * Stateful ISO-TP receiver.  Feed CAN frames one at a time via `push()`.
 * On a Single Frame, the payload is available immediately (`done === true`).
 * On a First Frame + Consecutive Frame sequence, the receiver accumulates
 * payload bytes and reports `done === true` once `totalLength` bytes have
 * been collected.
 *
 * Throws on:
 *   - frames before a SF/FF (stray CF/FC)
 *   - out-of-order CF sequence numbers (expected SN wraps 1→…→0x0F→0x00→…)
 *   - calls to `push()` after the message is already complete
 *
 * Excess padding bytes from the final CF are stripped via `totalLength`.
 */
export class IsoTpReceiver {
  private buf: number[] = [];
  private expectedLength: number | null = null;
  private nextSn = 1;
  private finished = false;

  /** True once a complete payload has been assembled. */
  get done(): boolean {
    return this.finished;
  }

  /**
   * Feed a single 8-byte CAN frame into the receiver.
   * Returns `{ done, payload }`.  When `done` is true, `payload` is the
   * fully-reassembled UDS payload (with padding stripped).
   */
  push(frame: Uint8Array | number[]): { done: boolean; payload: Uint8Array | null } {
    if (this.finished) {
      throw new Error('IsoTpReceiver.push: message already complete; create a new receiver');
    }
    const d = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (d.length === 0) throw new TypeError('IsoTpReceiver.push: frame is empty');
    const type = frameType(d[0]);

    if (this.expectedLength === null) {
      // Awaiting an initial frame (SF or FF).
      if (type === 'SF') {
        const len = d[0] & 0x0F;
        if (len === 0 || len > 7) {
          throw new Error(`IsoTpReceiver: invalid SF length ${len}`);
        }
        const payload = d.slice(1, 1 + len);
        this.finished = true;
        return { done: true, payload };
      }
      if (type === 'FF') {
        const total = ((d[0] & 0x0F) << 8) | d[1];
        if (total <= 7) {
          throw new Error(`IsoTpReceiver: FF totalLength ${total} must be > 7 (use SF)`);
        }
        if (total > 0xFFF) {
          throw new RangeError(`IsoTpReceiver: FF totalLength ${total} exceeds 4095`);
        }
        this.expectedLength = total;
        for (let i = 2; i < d.length && this.buf.length < total; i++) this.buf.push(d[i]);
        return { done: false, payload: null };
      }
      throw new Error(`IsoTpReceiver: expected SF or FF, got ${type}`);
    }

    // We are mid-message; only CFs are valid.
    if (type !== 'CF') {
      throw new Error(`IsoTpReceiver: expected CF, got ${type}`);
    }
    const sn = d[0] & 0x0F;
    if (sn !== this.nextSn) {
      throw new Error(`IsoTpReceiver: out-of-order CF; expected SN ${this.nextSn}, got ${sn}`);
    }
    this.nextSn = (this.nextSn + 1) & 0x0F;
    const remaining = this.expectedLength - this.buf.length;
    const take = Math.min(remaining, d.length - 1);
    for (let i = 0; i < take; i++) this.buf.push(d[1 + i]);

    if (this.buf.length >= this.expectedLength) {
      this.finished = true;
      return { done: true, payload: new Uint8Array(this.buf.slice(0, this.expectedLength)) };
    }
    return { done: false, payload: null };
  }
}

/**
 * Reassemble an ordered array of ISO-TP CAN frames into the original
 * UDS payload.  Accepts either a Single Frame on its own, or a First
 * Frame followed by the matching Consecutive Frames.
 *
 * Throws if frames are out of order, missing, or surplus.
 */
export function reassembleFrames(frames: (Uint8Array | number[])[]): Uint8Array {
  if (!frames || frames.length === 0) {
    throw new TypeError('reassembleFrames: frames array is empty');
  }
  const rx = new IsoTpReceiver();
  let payload: Uint8Array | null = null;
  for (let i = 0; i < frames.length; i++) {
    const result = rx.push(frames[i]);
    if (result.done) {
      if (i !== frames.length - 1) {
        throw new Error(`reassembleFrames: message complete at frame ${i} but ${frames.length - i - 1} extra frame(s) supplied`);
      }
      payload = result.payload;
    }
  }
  if (!payload) {
    throw new Error('reassembleFrames: ran out of frames before message was complete');
  }
  return payload;
}

// ─── CAN ID addressing helpers ────────────────────────────────────────
//
// ISO 15765-4 defines two CAN addressing conventions for UDS:
//
// 11-bit (normal) addressing
//   Tester → ECU physical:     0x7E0 + ecuOffset  (offset 0-7)
//   ECU    → Tester response:  0x7E8 + ecuOffset
//   Tester functional broadcast: 0x7DF
//
// 29-bit (extended) addressing
//   Format: 0x18DA_TTSS  (TT = target address byte, SS = source address byte)
//   Tester (0xF1) → ECU (0xXX) physical:   0x18DA_XX_F1
//   ECU    (0xXX) → Tester (0xF1) response: 0x18DA_F1_XX
//   Functional broadcast:                   0x18DB_33_F1

export interface CanAddressConfig {
  addressingMode?: AddressingMode;
  /**
   * (11-bit) ECU slot offset 0–7.  txId = 0x7E0 + ecuOffset.  Default 0.
   * Ignored when addressingMode is '29bit'.
   */
  ecuOffset?: number;
  /**
   * (29-bit) Source (tester) address byte.  Default 0xF1 (diagnostic tool).
   * Ignored when addressingMode is '11bit'.
   */
  sourceAddress?: number;
  /**
   * (29-bit) Target (ECU) address byte.  Default 0x00.
   * Ignored when addressingMode is '11bit'.
   */
  targetAddress?: number;
}

/**
 * Return the CAN ID the tester uses to send a physical request to a specific ECU.
 *
 * 11-bit: 0x7E0 + ecuOffset (0–7)
 * 29-bit: 0x18DA_<targetAddress>_<sourceAddress>
 */
export function txCanId(config: CanAddressConfig = {}): number {
  const mode = config.addressingMode ?? '11bit';
  if (mode === '29bit') {
    const src = (config.sourceAddress ?? 0xF1) & 0xFF;
    const tgt = (config.targetAddress ?? 0x00) & 0xFF;
    return (0x18DA0000 | (tgt << 8) | src) >>> 0;
  }
  return (0x7E0 + (config.ecuOffset ?? 0)) & 0x7FF;
}

/**
 * Return the CAN ID a specific ECU uses to respond to the tester.
 *
 * 11-bit: 0x7E8 + ecuOffset (0–7)
 * 29-bit: 0x18DA_<sourceAddress>_<targetAddress>  (addresses swapped relative to request)
 */
export function rxCanId(config: CanAddressConfig = {}): number {
  const mode = config.addressingMode ?? '11bit';
  if (mode === '29bit') {
    const src = (config.sourceAddress ?? 0xF1) & 0xFF;
    const tgt = (config.targetAddress ?? 0x00) & 0xFF;
    return (0x18DA0000 | (src << 8) | tgt) >>> 0;
  }
  return (0x7E8 + (config.ecuOffset ?? 0)) & 0x7FF;
}

/**
 * Return the functional-broadcast CAN ID for sending an unaddressed request
 * (e.g. TesterPresent to all ECUs).
 *
 * 11-bit: 0x7DF
 * 29-bit: 0x18DB33F1
 */
export function functionalCanId(config: CanAddressConfig = {}): number {
  const mode = config.addressingMode ?? '11bit';
  return mode === '29bit' ? 0x18DB33F1 : 0x7DF;
}

export interface CanFrame {
  /** CAN arbitration ID (11-bit value ≤ 0x7FF, or 29-bit value ≤ 0x1FFFFFFF). */
  id: number;
  /** true when the ID is a 29-bit extended CAN ID. */
  extendedId: boolean;
  /** 8-byte CAN frame data (padded per ISO-TP convention). */
  data: Uint8Array;
}

/**
 * Wrap ISO-TP frames produced by `segmentPayload` into `CanFrame` objects
 * annotated with the correct CAN ID for the selected addressing mode.
 *
 * Example:
 *   const frames = isotp.wrapForCan(
 *     segmentPayload(build.readDataByIdentifier({ dids: [0xF190] })).frames,
 *     { addressingMode: '29bit', sourceAddress: 0xF1, targetAddress: 0x00 }
 *   );
 *   // frames[0].id === 0x18DA00F1, frames[0].extendedId === true
 */
export function wrapForCan(frames: Uint8Array[], config: CanAddressConfig = {}): CanFrame[] {
  const mode = config.addressingMode ?? '11bit';
  const id = txCanId(config);
  const extendedId = mode === '29bit';
  return frames.map(data => ({ id, extendedId, data }));
}
