// ISO-TP (ISO 15765-2) — Transport Protocol over CAN
//
// Required for any UDS message > 7 bytes (read PROXI, write EOL, flash data
// transfer, etc.). Implements:
//   - Single Frame (SF, PCI = 0x0X)
//   - First Frame (FF, PCI = 0x1XYY where 0xYY = length high byte)
//   - Consecutive Frame (CF, PCI = 0x2X where X = sequence 0-15)
//   - Flow Control (FC, PCI = 0x3X)
//
// References:
//   - ISO 15765-2:2016
//   - SAE J2178
//   - FCA-specific: STmin and BlockSize are negotiated per-ECU
//
// CAN-FD support included via 64-byte payload mode (CAN-FD flag).

/**
 * Build outgoing ISO-TP frames for a UDS payload.
 * @param {Uint8Array} payload  UDS request (e.g., '22 20 23' for PROXI read)
 * @param {object}     options
 * @param {number}     options.padByte  Padding byte (typically 0xAA or 0x00)
 * @param {boolean}    options.canFD     Use CAN-FD 64-byte frames
 * @returns {object}   { frames: [Uint8Array], requiresFlowControl: boolean }
 */
export function buildIsoTpFrames(payload, { padByte = 0x00, canFD = false } = {}) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const dlc = canFD ? 64 : 8;
  const maxSF = canFD ? 62 : 7; // single-frame max payload bytes

  // Single Frame: PCI = 0x0L where L = length (1-7 classic, 1-62 CAN-FD)
  if (data.length <= maxSF) {
    const frame = new Uint8Array(dlc).fill(padByte);
    if (canFD && data.length > 7) {
      // CAN-FD extended SF: PCI = 0x00 LL (2 bytes)
      frame[0] = 0x00;
      frame[1] = data.length;
      frame.set(data, 2);
    } else {
      frame[0] = 0x00 | (data.length & 0x0f);
      frame.set(data, 1);
    }
    return { frames: [frame], requiresFlowControl: false };
  }

  // Multi-frame: First Frame + Consecutive Frames
  const frames = [];
  const total = data.length;
  // First Frame: PCI = 0x1L LL (12-bit length)
  const ff = new Uint8Array(dlc).fill(padByte);
  if (total <= 0xfff) {
    ff[0] = 0x10 | ((total >> 8) & 0x0f);
    ff[1] = total & 0xff;
    ff.set(data.subarray(0, dlc - 2), 2);
    frames.push(ff);
  } else {
    // Extended FF for payloads >4095 bytes (FCA flash): PCI 0x10 00 + 4-byte length
    ff[0] = 0x10;
    ff[1] = 0x00;
    ff[2] = (total >> 24) & 0xff;
    ff[3] = (total >> 16) & 0xff;
    ff[4] = (total >> 8) & 0xff;
    ff[5] = total & 0xff;
    ff.set(data.subarray(0, dlc - 6), 6);
    frames.push(ff);
  }

  // Consecutive Frames: PCI = 0x2N where N = sequence (1-15, wraps)
  let offset = dlc - 2; // after FF
  if (total > 0xfff) offset = dlc - 6;
  let seq = 1;
  while (offset < total) {
    const cf = new Uint8Array(dlc).fill(padByte);
    cf[0] = 0x20 | (seq & 0x0f);
    const chunk = data.subarray(offset, offset + dlc - 1);
    cf.set(chunk, 1);
    frames.push(cf);
    offset += dlc - 1;
    seq = (seq + 1) & 0x0f;
  }

  return { frames, requiresFlowControl: true };
}

/**
 * Parse Flow Control frame from ECU response.
 * @param {Uint8Array} frame  8-byte (or 64-byte CAN-FD) CAN frame from ECU
 * @returns {object|null}     { status, blockSize, stMin } or null if not FC
 */
export function parseFlowControl(frame) {
  if (!frame || frame.length < 3) return null;
  const pci = frame[0];
  if ((pci & 0xf0) !== 0x30) return null;
  const flowStatus = pci & 0x0f;
  const blockSize = frame[1];
  const stMin = frame[2];
  return {
    status: flowStatus, // 0 = continue, 1 = wait, 2 = overflow
    statusName: { 0: "CTS", 1: "WAIT", 2: "OVFLW" }[flowStatus] || "RESERVED",
    blockSize, // 0 = send all without further FC
    stMin, // separation time (0x00-0x7F = ms; 0xF1-0xF9 = 100-900 us)
    stMinMs: stMin <= 0x7f ? stMin : stMin >= 0xf1 && stMin <= 0xf9 ? (stMin - 0xf0) / 10 : null,
  };
}

/**
 * Reassemble multi-frame ISO-TP response from ECU.
 * Caller feeds frames one at a time; returns the complete payload when done.
 *
 * Usage:
 *   const reasm = new IsoTpReassembler();
 *   for await (const frame of canRx) {
 *     const result = reasm.feed(frame);
 *     if (result.complete) return result.payload;
 *     if (result.sendFlowControl) tx(result.sendFlowControl);
 *   }
 */
export class IsoTpReassembler {
  constructor() {
    this.buffer = null;
    this.expected = 0;
    this.received = 0;
    this.lastSeq = 0;
  }

  /**
   * Feed a CAN frame from the ECU into the reassembler.
   * @param {Uint8Array} frame
   * @returns {object} { complete, payload, sendFlowControl, error }
   */
  feed(frame) {
    if (!frame || frame.length < 1) return { error: "empty frame" };
    const pci = frame[0];
    const type = (pci >> 4) & 0x0f;

    if (type === 0x0) {
      // Single Frame
      const len = pci & 0x0f;
      return { complete: true, payload: frame.subarray(1, 1 + len) };
    }

    if (type === 0x1) {
      // First Frame
      let len, headerSize;
      if ((pci & 0x0f) === 0 && frame[1] === 0) {
        // Extended (4-byte length)
        len = (frame[2] << 24) | (frame[3] << 16) | (frame[4] << 8) | frame[5];
        headerSize = 6;
      } else {
        len = ((pci & 0x0f) << 8) | frame[1];
        headerSize = 2;
      }
      this.buffer = new Uint8Array(len);
      this.expected = len;
      this.received = Math.min(frame.length - headerSize, len);
      this.buffer.set(frame.subarray(headerSize, headerSize + this.received), 0);
      this.lastSeq = 0;
      return {
        complete: false,
        sendFlowControl: this.buildFlowControl(0, 0, 0), // CTS, BS=0 (no further FC), STmin=0
      };
    }

    if (type === 0x2) {
      // Consecutive Frame
      const seq = pci & 0x0f;
      const expectedSeq = (this.lastSeq + 1) & 0x0f;
      if (seq !== expectedSeq) return { error: `sequence mismatch: expected ${expectedSeq}, got ${seq}` };
      const remaining = this.expected - this.received;
      const chunk = Math.min(frame.length - 1, remaining);
      this.buffer.set(frame.subarray(1, 1 + chunk), this.received);
      this.received += chunk;
      this.lastSeq = seq;
      if (this.received >= this.expected) {
        return { complete: true, payload: this.buffer };
      }
      return { complete: false };
    }

    if (type === 0x3) {
      // Flow Control — shouldn't see this on RX during reassembly
      return { error: "unexpected FC frame during reassembly" };
    }

    return { error: `unknown PCI type 0x${pci.toString(16)}` };
  }

  /**
   * Build a Flow Control frame to send back to the ECU.
   * @param {number} status      0=CTS, 1=WAIT, 2=OVFLW
   * @param {number} blockSize   0 = no further FC; 1+ = send N CFs then wait
   * @param {number} stMin       0x00-0x7F ms; 0xF1-0xF9 = 100-900 us
   * @param {number} dlc         CAN DLC (8 for classic, 64 for CAN-FD)
   * @param {number} padByte
   */
  buildFlowControl(status = 0, blockSize = 0, stMin = 0, dlc = 8, padByte = 0x00) {
    const fc = new Uint8Array(dlc).fill(padByte);
    fc[0] = 0x30 | (status & 0x0f);
    fc[1] = blockSize & 0xff;
    fc[2] = stMin & 0xff;
    return fc;
  }
}

/**
 * FCA-specific addressing conventions:
 *
 * Tester→ECU CAN IDs (request):
 *   0x744  BCM (Body Control Module)
 *   0x74F  SGW (Secure Gateway, 2018+)
 *   0x75F  RFH (X2 platform)
 *   0x760  ABS
 *   0x7C0  CGW (Central Gateway)
 *   0x7E0  PCM/ECM (engine)
 *   0x7E2  TCM (transmission)
 *   0x149  UCONNECT (radio)
 *   0x14E  RADIO_FGA
 *   0x500  SBEC2/SCI legacy (Durango/Grand Cherokee)
 *   0x504  RAM 1500 DT (newer)
 *   0x600  PCM legacy
 *   0x620  TCM legacy
 *
 * ECU→Tester CAN IDs (response): typically request_ID + 8
 *   0x74C  BCM response
 *   0x76C  RFH response
 *   0x76F  SGW response
 *   0x7E8  PCM response
 *   0x7EA  TCM response
 */
export const FCA_DIAGNOSTIC_CAN_IDS = {
  request: {
    BCM: 0x744,
    SGW: 0x74f,
    RFH_X2: 0x75f,
    ABS: 0x760,
    CGW: 0x7c0,
    PCM_ECM: 0x7e0,
    TCM: 0x7e2,
    UCONNECT: 0x149,
    RADIO_FGA: 0x14e,
    SBEC2_LEGACY: 0x500,
    RAM_1500_DT: 0x504,
    PCM_LEGACY: 0x600,
    TCM_LEGACY: 0x620,
  },
  response: {
    BCM: 0x74c,
    SGW: 0x76f,
    RFH_X2: 0x76c,
    PCM_ECM: 0x7e8,
    TCM: 0x7ea,
  },
};
