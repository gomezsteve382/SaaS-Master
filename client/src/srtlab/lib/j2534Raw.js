// J2534 PassThru API — vendor-neutral interface to hardware diagnostic adapters
//
// SAE J2534-1 / J2534-2 defines a DLL ABI for OBD-II / J1850 / ISO 9141 / CAN
// hardware adapters. Major vendors: DrewTech (Cardaq), Tactrix (Openport),
// Kvaser, PCAN, Mongoose, Bosch MTS, Snap-on, etc.
//
// In a browser (Vite / React) we can't load native DLLs directly. The viable
// patterns are:
//   1. WebSerial / WebUSB — talk to ELM327 / STN1170 / OBDLinkMX directly
//   2. WebSocket bridge — local Node service that exposes J2534 via WS
//   3. Hybrid Electron app — load real J2534 DLL in main process
//
// This module provides the JS API SHAPE for J2534. The actual transport
// (serial/USB/WS) is plugged in via the `transport` parameter.
//
// References:
//   - SAE J2534-1 v04.04
//   - Vendor implementations: DrewTech.dll, Tactrix.dll, Kvaser.dll
//   - Common bridge spec: github.com/iozsaygi/J2534Bridge (Electron)
//   - PassThruConnect, PassThruDisconnect, PassThruReadMsgs, PassThruWriteMsgs

// ─── PassThru protocol IDs (SAE J2534-1 Table A.1) ────────────────────────
export const PassThruProtocols = {
  J1850VPW: 1,
  J1850PWM: 2,
  ISO9141: 3,
  ISO14230: 4,  // KWP2000
  CAN: 5,
  ISO15765: 6,  // ISO-TP over CAN
  SCI_A_ENGINE: 7,
  SCI_A_TRANS: 8,
  SCI_B_ENGINE: 9,
  SCI_B_TRANS: 10,
  // J2534-2 extensions
  ISO15765_CH1: 0x40 | 6,
  CAN_CH1: 0x40 | 5,
  CAN_FD: 0x80 | 5,  // common vendor extension
};

// ─── PassThru flags ───────────────────────────────────────────────────────
export const PassThruFlags = {
  CAN_29BIT_ID: 0x100,
  ISO15765_FRAME_PAD: 0x40,
  ISO15765_ADDR_TYPE: 0x80,
  ISO15765_EXT_ADDR: 0x80,  // alias
  TX_NORMAL_TRANSMIT: 0x00,
  TX_DONT_REQUIRE_RESPONSE: 0x4000,
};

// ─── PassThru error codes (J2534 Section 7.6) ────────────────────────────
export const PassThruErrors = {
  STATUS_NOERROR: 0,
  ERR_NOT_SUPPORTED: 1,
  ERR_INVALID_CHANNEL_ID: 2,
  ERR_INVALID_PROTOCOL_ID: 3,
  ERR_NULL_PARAMETER: 4,
  ERR_INVALID_IOCTL_VALUE: 5,
  ERR_INVALID_FLAGS: 6,
  ERR_FAILED: 7,
  ERR_DEVICE_NOT_CONNECTED: 8,
  ERR_TIMEOUT: 9,
  ERR_INVALID_MSG: 10,
  ERR_INVALID_TIME_INTERVAL: 11,
  ERR_EXCEEDED_LIMIT: 12,
  ERR_INVALID_MSG_ID: 13,
  ERR_DEVICE_IN_USE: 14,
  ERR_INVALID_IOCTL_ID: 15,
  ERR_BUFFER_EMPTY: 16,
  ERR_BUFFER_FULL: 17,
  ERR_BUFFER_OVERFLOW: 18,
  ERR_PIN_INVALID: 19,
  ERR_CHANNEL_IN_USE: 20,
  ERR_MSG_PROTOCOL_ID: 21,
  ERR_INVALID_FILTER_ID: 22,
  ERR_NO_FLOW_CONTROL: 23,
  ERR_NOT_UNIQUE: 24,
  ERR_INVALID_BAUDRATE: 25,
  ERR_INVALID_DEVICE_ID: 26,
};

/**
 * J2534 PassThru abstract client. Implementations provide:
 *   - PassThruOpen(name) → deviceId
 *   - PassThruClose(deviceId)
 *   - PassThruConnect(deviceId, protocol, flags, baudrate) → channelId
 *   - PassThruDisconnect(channelId)
 *   - PassThruReadMsgs(channelId, timeout, n) → [PASSTHRU_MSG]
 *   - PassThruWriteMsgs(channelId, msgs, timeout) → bytes written
 *   - PassThruStartMsgFilter(channelId, type, mask, pattern) → filterId
 *   - PassThruStopMsgFilter(channelId, filterId)
 *   - PassThruSetProgrammingVoltage(deviceId, pin, voltage)
 *   - PassThruReadVersion(deviceId) → version info
 *   - PassThruIoctl(channelId, ioctlId, input, output)
 *
 * Transport-specific subclasses (WebSerialJ2534, WebSocketJ2534, ElectronJ2534)
 * implement the underlying message exchange.
 */
export class PassThruClient {
  constructor({ transport, vendor = "Generic" }) {
    if (!transport) throw new Error("PassThruClient requires a transport");
    this.transport = transport;
    this.vendor = vendor;
    this.deviceId = null;
    this.channels = new Map(); // channelId → { protocol, baudrate, filters }
  }

  async open(name = "ANY") {
    const result = await this.transport.request({
      fn: "PassThruOpen",
      args: [name],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR) {
      throw new Error(`PassThruOpen failed: status ${result.status}`);
    }
    this.deviceId = result.deviceId;
    return this.deviceId;
  }

  async close() {
    if (this.deviceId === null) return;
    await this.transport.request({
      fn: "PassThruClose",
      args: [this.deviceId],
    });
    this.deviceId = null;
  }

  async connect(protocol, baudrate, flags = 0) {
    if (this.deviceId === null) throw new Error("Device not opened");
    const result = await this.transport.request({
      fn: "PassThruConnect",
      args: [this.deviceId, protocol, flags, baudrate],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR) {
      throw new Error(`PassThruConnect failed: status ${result.status}`);
    }
    this.channels.set(result.channelId, { protocol, baudrate, flags, filters: new Map() });
    return result.channelId;
  }

  async disconnect(channelId) {
    await this.transport.request({
      fn: "PassThruDisconnect",
      args: [channelId],
    });
    this.channels.delete(channelId);
  }

  async writeMsg(channelId, data, flags = 0, timeout = 1000) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not connected`);
    const result = await this.transport.request({
      fn: "PassThruWriteMsgs",
      args: [
        channelId,
        [
          {
            protocol: channel.protocol,
            flags,
            data: Array.from(data),
            dataSize: data.length,
          },
        ],
        timeout,
      ],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR) {
      throw new Error(`PassThruWriteMsgs failed: status ${result.status}`);
    }
    return result;
  }

  async readMsgs(channelId, count = 1, timeout = 1000) {
    const result = await this.transport.request({
      fn: "PassThruReadMsgs",
      args: [channelId, count, timeout],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR && result.status !== PassThruErrors.ERR_BUFFER_EMPTY) {
      throw new Error(`PassThruReadMsgs failed: status ${result.status}`);
    }
    return result.messages || [];
  }

  async startMsgFilter(channelId, filterType, mask, pattern, flowControl = null) {
    const result = await this.transport.request({
      fn: "PassThruStartMsgFilter",
      args: [channelId, filterType, mask, pattern, flowControl],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR) {
      throw new Error(`PassThruStartMsgFilter failed: status ${result.status}`);
    }
    const channel = this.channels.get(channelId);
    if (channel) channel.filters.set(result.filterId, { mask, pattern });
    return result.filterId;
  }

  async stopMsgFilter(channelId, filterId) {
    await this.transport.request({
      fn: "PassThruStopMsgFilter",
      args: [channelId, filterId],
    });
    const channel = this.channels.get(channelId);
    if (channel) channel.filters.delete(filterId);
  }

  async ioctl(channelId, ioctlId, input = null) {
    const result = await this.transport.request({
      fn: "PassThruIoctl",
      args: [channelId, ioctlId, input],
    });
    if (result.status !== PassThruErrors.STATUS_NOERROR) {
      throw new Error(`PassThruIoctl failed: status ${result.status}`);
    }
    return result.output;
  }

  async setProgrammingVoltage(pin, voltageMv) {
    if (this.deviceId === null) throw new Error("Device not opened");
    await this.transport.request({
      fn: "PassThruSetProgrammingVoltage",
      args: [this.deviceId, pin, voltageMv],
    });
  }
}

/**
 * Convenience: send a UDS request and read back the response over CAN ISO-TP
 * (protocol = ISO15765). Handles single-frame, multi-frame, and flow control.
 */
export async function passthruUdsRequest(client, channelId, txCanId, udsPayload, rxCanId = null, options = {}) {
  const { timeout = 1000, padByte = 0x00 } = options;
  // Build the message: [CAN ID (4 bytes BE)] + [data]
  const idBytes = new Uint8Array(4);
  idBytes[0] = (txCanId >> 24) & 0xff;
  idBytes[1] = (txCanId >> 16) & 0xff;
  idBytes[2] = (txCanId >> 8) & 0xff;
  idBytes[3] = txCanId & 0xff;
  const txData = new Uint8Array(idBytes.length + udsPayload.length);
  txData.set(idBytes, 0);
  txData.set(udsPayload, 4);
  await client.writeMsg(channelId, txData, PassThruFlags.ISO15765_FRAME_PAD, timeout);
  const responses = await client.readMsgs(channelId, 5, timeout);
  // Filter by rxCanId if specified
  return rxCanId !== null
    ? responses.filter((m) => {
        const rid = (m.data[0] << 24) | (m.data[1] << 16) | (m.data[2] << 8) | m.data[3];
        return rid === rxCanId;
      })
    : responses;
}

/**
 * Sample WebSocket transport — for an Electron app or local Node bridge.
 */
export class WebSocketJ2534Transport {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.requestId = 0;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
        }
      };
    });
  }

  async request(req) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, ...req }));
    });
  }

  async close() {
    this.ws?.close();
  }
}

/**
 * Sample WebSerial transport — for browser-direct connection to ELM327 / STN1170 /
 * OBDLink. Implements a SUBSET of J2534 since serial dongles are simpler.
 */
export class WebSerialELM327Transport {
  constructor(port) {
    this.port = port;
    this.writer = null;
    this.reader = null;
  }

  async open(baudRate = 38400) {
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    // Reset
    await this.writeCmd("ATZ");
    await this.delay(1000);
    await this.writeCmd("ATE0"); // echo off
    await this.writeCmd("ATL0"); // linefeeds off
    await this.writeCmd("ATS0"); // spaces off
    await this.writeCmd("ATH1"); // headers on
  }

  async writeCmd(cmd) {
    const encoder = new TextEncoder();
    await this.writer.write(encoder.encode(cmd + "\r"));
    return await this.readUntilPrompt();
  }

  async readUntilPrompt(timeoutMs = 2000) {
    const decoder = new TextDecoder();
    let buffer = "";
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await this.reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes(">")) return buffer.split(">")[0].trim();
    }
    throw new Error("ELM327 readUntilPrompt timeout");
  }

  async delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async setProtocol(protocolName) {
    const map = {
      CAN_11BIT_500K: 6,
      CAN_29BIT_500K: 7,
      CAN_11BIT_250K: 8,
      CAN_29BIT_250K: 9,
      ISO9141: 3,
      ISO14230_KWP_5: 4,
      ISO14230_KWP_FAST: 5,
    };
    const code = map[protocolName];
    if (code === undefined) throw new Error(`Unknown protocol: ${protocolName}`);
    return this.writeCmd(`ATSP${code}`);
  }

  async setCanIds(txId, rxId) {
    if (txId !== undefined) await this.writeCmd(`ATSH${txId.toString(16).padStart(3, "0").toUpperCase()}`);
    if (rxId !== undefined) await this.writeCmd(`ATCRA${rxId.toString(16).padStart(3, "0").toUpperCase()}`);
  }

  async sendUds(payload) {
    const hexStr = Array.from(payload)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join("");
    return this.writeCmd(hexStr);
  }

  async close() {
    await this.writer?.releaseLock();
    await this.reader?.releaseLock();
    await this.port?.close();
  }
}
