#!/usr/bin/env node
/**
 * SRT Lab — J2534 WebSocket Relay Agent
 * ======================================
 * Runs on the Windows bench laptop alongside the J2534 adapter.
 * Exposes a WebSocket server on localhost:7534 so the SRT Lab
 * browser app can send live UDS frames to a real ECU.
 *
 * Requirements:
 *   - Node.js 18+ (Windows x64)
 *   - A J2534 PassThru adapter installed (Mongoose, Autel MaxiFlash,
 *     Tactrix OpenPort 2.0, Drew Tech MongoosePro, etc.)
 *   - npm install ws ffi-napi ref-napi ref-array-napi ref-struct-napi
 *
 * Usage:
 *   node srt-relay.js [--port 7534] [--dll "C:\path\to\j2534.dll"]
 *
 * The relay auto-discovers installed J2534 adapters from the Windows
 * registry (HKLM\SOFTWARE\PassThruSupport.04.04) if --dll is omitted.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Relay:
 *     { id, cmd: "listAdapters" }
 *     { id, cmd: "openChannel", adapterId, protocol, baudRate, flags }
 *     { id, cmd: "sendFrame", channelId, canId, bytes, timeoutMs }
 *     { id, cmd: "sendFrameNoResp", channelId, canId, bytes }
 *     { id, cmd: "closeChannel", channelId }
 *     { id, cmd: "closeDevice" }
 *     { id, cmd: "ping" }
 *
 *   Relay → Client:
 *     { id, ok: true, result: <any> }
 *     { id, ok: false, error: <string>, code: <number> }
 *     { type: "event", event: "adapterConnected"|"adapterDisconnected", adapterId }
 *
 * Supported protocols: CAN (0x05), ISO15765 (0x06), SW_CAN_PS (0x08)
 * Supported baud rates: 125000, 250000, 500000, 1000000
 */

'use strict';

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const PORT = parseInt(args[args.indexOf('--port') + 1] || '7534', 10);
const FORCED_DLL = args[args.indexOf('--dll') + 1] || null;
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// ─── J2534 constants ──────────────────────────────────────────────────────────
const J2534_PROTOCOL = {
  CAN:        0x05,
  ISO15765:   0x06,
  SW_CAN_PS:  0x08,
};

const J2534_BAUD = {
  125000:  125000,
  250000:  250000,
  500000:  500000,
  1000000: 1000000,
};

const J2534_FLAGS = {
  CAN_29BIT_ID:    0x00000100,
  ISO15765_ADDR:   0x00000080,
};

const ERR_NAMES = {
  0x00: 'STATUS_NOERROR',
  0x01: 'ERR_NOT_SUPPORTED',
  0x02: 'ERR_INVALID_CHANNEL_ID',
  0x03: 'ERR_INVALID_PROTOCOL_ID',
  0x04: 'ERR_NULL_PARAMETER',
  0x05: 'ERR_INVALID_IOCTL_VALUE',
  0x06: 'ERR_INVALID_FLAGS',
  0x07: 'ERR_FAILED',
  0x08: 'ERR_DEVICE_NOT_CONNECTED',
  0x09: 'ERR_TIMEOUT',
  0x0A: 'ERR_INVALID_MSG',
  0x0B: 'ERR_INVALID_TIME_INTERVAL',
  0x0C: 'ERR_EXCEEDED_LIMIT',
  0x0D: 'ERR_INVALID_MSG_ID',
  0x0E: 'ERR_DEVICE_IN_USE',
  0x0F: 'ERR_INVALID_IOCTL_ID',
  0x10: 'ERR_BUFFER_EMPTY',
  0x11: 'ERR_BUFFER_FULL',
  0x12: 'ERR_BUFFER_OVERFLOW',
  0x13: 'ERR_PIN_INVALID',
  0x14: 'ERR_CHANNEL_IN_USE',
  0x15: 'ERR_MSG_PROTOCOL_ID',
  0x16: 'ERR_INVALID_FILTER_ID',
  0x17: 'ERR_NO_FLOW_CONTROL',
  0x18: 'ERR_NOT_UNIQUE',
  0x19: 'ERR_INVALID_BAUDRATE',
  0x1A: 'ERR_INVALID_DEVICE_ID',
};

function j2534ErrName(code) {
  return ERR_NAMES[code] || `ERR_UNKNOWN_0x${code.toString(16).toUpperCase()}`;
}

// ─── Windows registry adapter discovery ──────────────────────────────────────
function discoverAdaptersFromRegistry() {
  if (os.platform() !== 'win32') return [];
  try {
    // Use reg.exe to enumerate PassThru registry keys
    const { execSync } = require('child_process');
    const key = 'HKLM\\SOFTWARE\\PassThruSupport.04.04';
    const out = execSync(`reg query "${key}" /s`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const adapters = [];
    const lines = out.split('\n');
    let currentName = null;
    let currentDll = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key)) {
        if (currentName && currentDll) {
          adapters.push({ id: adapters.length, name: currentName, dll: currentDll });
        }
        currentName = null;
        currentDll = null;
      } else if (trimmed.startsWith('Name')) {
        currentName = trimmed.split(/\s{2,}/)[2] || trimmed.split('\t').pop();
      } else if (trimmed.startsWith('FunctionLibrary')) {
        currentDll = trimmed.split(/\s{2,}/)[2] || trimmed.split('\t').pop();
      }
    }
    if (currentName && currentDll) {
      adapters.push({ id: adapters.length, name: currentName, dll: currentDll });
    }
    return adapters;
  } catch (e) {
    log('warn', `Registry discovery failed: ${e.message}`);
    return [];
  }
}

// ─── J2534 DLL wrapper ────────────────────────────────────────────────────────
let ffi, ref, ArrayType, StructType;
let j2534 = null;

function loadFfi() {
  try {
    ffi = require('ffi-napi');
    ref = require('ref-napi');
    ArrayType = require('ref-array-napi');
    StructType = require('ref-struct-napi');
    return true;
  } catch (e) {
    log('error', `ffi-napi not available: ${e.message}`);
    log('error', 'Run: npm install ffi-napi ref-napi ref-array-napi ref-struct-napi');
    return false;
  }
}

function buildJ2534Bindings(dllPath) {
  if (!ffi) return null;

  const ByteArray4128 = ArrayType(ref.types.byte, 4128);

  const PASSTHRU_MSG = StructType({
    ProtocolID:     ref.types.ulong,
    RxStatus:       ref.types.ulong,
    TxFlags:        ref.types.ulong,
    Timestamp:      ref.types.ulong,
    DataSize:       ref.types.ulong,
    ExtraDataIndex: ref.types.ulong,
    Data:           ByteArray4128,
  });

  const PASSThRU_MSG_PTR = ref.refType(PASSTHRU_MSG);
  const ULONG_PTR = ref.refType(ref.types.ulong);

  try {
    const lib = ffi.Library(dllPath, {
      'PassThruOpen':          ['long', ['string', ULONG_PTR]],
      'PassThruClose':         ['long', ['ulong']],
      'PassThruConnect':       ['long', ['ulong', 'ulong', 'ulong', 'ulong', ULONG_PTR]],
      'PassThruDisconnect':    ['long', ['ulong']],
      'PassThruReadMsgs':      ['long', ['ulong', PASSThRU_MSG_PTR, ULONG_PTR, 'ulong']],
      'PassThruWriteMsgs':     ['long', ['ulong', PASSThRU_MSG_PTR, ULONG_PTR, 'ulong']],
      'PassThruStartMsgFilter':['long', ['ulong', 'ulong', PASSThRU_MSG_PTR, PASSThRU_MSG_PTR, PASSThRU_MSG_PTR, ULONG_PTR]],
      'PassThruStopMsgFilter': ['long', ['ulong', 'ulong']],
      'PassThruGetLastError':  ['long', ['string']],
      'PassThruIoctl':         ['long', ['ulong', 'ulong', 'pointer', 'pointer']],
    });
    return { lib, PASSTHRU_MSG, ULONG_PTR };
  } catch (e) {
    log('error', `Failed to load DLL ${dllPath}: ${e.message}`);
    return null;
  }
}

// ─── Relay state ──────────────────────────────────────────────────────────────
const state = {
  adapters: [],          // discovered adapters
  deviceId: null,        // open device handle
  channels: new Map(),   // channelId → { id, protocol, baudRate }
  dllPath: null,
  bindings: null,
};

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { info: '✓', warn: '⚠', error: '✗', debug: '·' }[level] || '·';
  if (level === 'debug' && !VERBOSE) return;
  console.log(`[${ts}] ${prefix} ${msg}`);
}

// ─── Command handlers ─────────────────────────────────────────────────────────
function cmdListAdapters() {
  const discovered = discoverAdaptersFromRegistry();
  if (FORCED_DLL) {
    discovered.unshift({ id: 0, name: 'Manual DLL', dll: FORCED_DLL });
  }
  state.adapters = discovered;
  return discovered.map(a => ({ id: a.id, name: a.name, dll: a.dll }));
}

function cmdOpenChannel({ adapterId, protocol = 'CAN', baudRate = 500000, flags = 0 }) {
  if (!ffi) throw new Error('ffi-napi not loaded — run npm install first');

  const adapter = state.adapters[adapterId];
  if (!adapter) throw new Error(`Adapter ${adapterId} not found — call listAdapters first`);

  // Load DLL if not already loaded
  if (state.dllPath !== adapter.dll) {
    state.bindings = buildJ2534Bindings(adapter.dll);
    if (!state.bindings) throw new Error(`Failed to load DLL: ${adapter.dll}`);
    state.dllPath = adapter.dll;
  }

  const { lib, ULONG_PTR } = state.bindings;

  // Open device
  if (state.deviceId === null) {
    const deviceIdBuf = ref.alloc(ref.types.ulong);
    const ret = lib.PassThruOpen(null, deviceIdBuf);
    if (ret !== 0) throw new Error(`PassThruOpen failed: ${j2534ErrName(ret)} (0x${ret.toString(16)})`);
    state.deviceId = deviceIdBuf.deref();
    log('info', `Device opened: handle=${state.deviceId}`);
  }

  // Connect channel
  const protoId = J2534_PROTOCOL[protocol];
  if (!protoId) throw new Error(`Unknown protocol: ${protocol}. Use CAN, ISO15765, or SW_CAN_PS`);

  const channelIdBuf = ref.alloc(ref.types.ulong);
  const ret = lib.PassThruConnect(state.deviceId, protoId, flags, baudRate, channelIdBuf);
  if (ret !== 0) throw new Error(`PassThruConnect failed: ${j2534ErrName(ret)} (0x${ret.toString(16)})`);

  const channelId = channelIdBuf.deref();

  // Set pass-all filter (mask=0, pattern=0, flowControl=null for CAN)
  const { PASSTHRU_MSG } = state.bindings;
  const maskMsg = new PASSTHRU_MSG();
  maskMsg.ProtocolID = protoId;
  maskMsg.DataSize = 4;
  for (let i = 0; i < 4; i++) maskMsg.Data[i] = 0x00;

  const patternMsg = new PASSTHRU_MSG();
  patternMsg.ProtocolID = protoId;
  patternMsg.DataSize = 4;
  for (let i = 0; i < 4; i++) patternMsg.Data[i] = 0x00;

  const filterIdBuf = ref.alloc(ref.types.ulong);
  const filterRet = lib.PassThruStartMsgFilter(
    channelId, 0x01 /* PASS_FILTER */,
    maskMsg.ref(), patternMsg.ref(), ref.NULL,
    filterIdBuf
  );
  if (filterRet !== 0) {
    log('warn', `PassThruStartMsgFilter failed: ${j2534ErrName(filterRet)} — continuing without filter`);
  }

  state.channels.set(channelId, { id: channelId, protocol, baudRate, adapterId });
  log('info', `Channel opened: id=${channelId} proto=${protocol} baud=${baudRate}`);
  return { channelId, protocol, baudRate };
}

function cmdSendFrame({ channelId, canId, bytes, timeoutMs = 150 }) {
  if (!state.bindings) throw new Error('No adapter open — call openChannel first');
  const channel = state.channels.get(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not open`);

  const { lib, PASSTHRU_MSG } = state.bindings;
  const protoId = J2534_PROTOCOL[channel.protocol];

  // Build TX message
  const txMsg = new PASSTHRU_MSG();
  txMsg.ProtocolID = protoId;
  txMsg.TxFlags = 0;
  // CAN ID is the first 4 bytes in ISO 15765 / CAN
  const idBytes = [(canId >> 24) & 0xFF, (canId >> 16) & 0xFF, (canId >> 8) & 0xFF, canId & 0xFF];
  for (let i = 0; i < 4; i++) txMsg.Data[i] = idBytes[i];
  for (let i = 0; i < bytes.length; i++) txMsg.Data[4 + i] = bytes[i];
  txMsg.DataSize = 4 + bytes.length;

  const numMsgsBuf = ref.alloc(ref.types.ulong, 1);
  const writeRet = lib.PassThruWriteMsgs(channelId, txMsg.ref(), numMsgsBuf, timeoutMs);
  if (writeRet !== 0) throw new Error(`PassThruWriteMsgs failed: ${j2534ErrName(writeRet)} (0x${writeRet.toString(16)})`);

  log('debug', `TX [${canId.toString(16).toUpperCase().padStart(3,'0')}] ${bytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);

  // Read response(s)
  const responses = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rxMsg = new PASSTHRU_MSG();
    const rxCountBuf = ref.alloc(ref.types.ulong, 1);
    const readRet = lib.PassThruReadMsgs(channelId, rxMsg.ref(), rxCountBuf, Math.max(1, deadline - Date.now()));
    if (readRet === 0x10) break; // ERR_BUFFER_EMPTY
    if (readRet !== 0) {
      log('warn', `PassThruReadMsgs: ${j2534ErrName(readRet)}`);
      break;
    }
    const count = rxCountBuf.deref();
    if (count === 0) break;

    const rxSize = rxMsg.DataSize;
    const rxBytes = [];
    for (let i = 0; i < rxSize; i++) rxBytes.push(rxMsg.Data[i]);

    // First 4 bytes are the CAN ID in ISO15765/CAN
    const rxCanId = (rxBytes[0] << 24) | (rxBytes[1] << 16) | (rxBytes[2] << 8) | rxBytes[3];
    const rxData = rxBytes.slice(4);

    log('debug', `RX [${rxCanId.toString(16).toUpperCase().padStart(3,'0')}] ${rxData.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);
    responses.push({ canId: rxCanId, bytes: rxData, timestamp: rxMsg.Timestamp });
  }

  return { sent: { canId, bytes }, responses };
}

function cmdSendFrameNoResp({ channelId, canId, bytes }) {
  if (!state.bindings) throw new Error('No adapter open — call openChannel first');
  const channel = state.channels.get(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not open`);

  const { lib, PASSTHRU_MSG } = state.bindings;
  const protoId = J2534_PROTOCOL[channel.protocol];

  const txMsg = new PASSTHRU_MSG();
  txMsg.ProtocolID = protoId;
  txMsg.TxFlags = 0;
  const idBytes = [(canId >> 24) & 0xFF, (canId >> 16) & 0xFF, (canId >> 8) & 0xFF, canId & 0xFF];
  for (let i = 0; i < 4; i++) txMsg.Data[i] = idBytes[i];
  for (let i = 0; i < bytes.length; i++) txMsg.Data[4 + i] = bytes[i];
  txMsg.DataSize = 4 + bytes.length;

  const numMsgsBuf = ref.alloc(ref.types.ulong, 1);
  const writeRet = lib.PassThruWriteMsgs(channelId, txMsg.ref(), numMsgsBuf, 50);
  if (writeRet !== 0) throw new Error(`PassThruWriteMsgs failed: ${j2534ErrName(writeRet)}`);
  log('debug', `TX (no-resp) [${canId.toString(16).toUpperCase().padStart(3,'0')}] ${bytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);
  return { sent: true };
}

function cmdCloseChannel({ channelId }) {
  if (!state.bindings) return { closed: false };
  const { lib } = state.bindings;
  const ret = lib.PassThruDisconnect(channelId);
  state.channels.delete(channelId);
  log('info', `Channel closed: id=${channelId} ret=${j2534ErrName(ret)}`);
  return { closed: ret === 0, code: ret };
}

function cmdCloseDevice() {
  if (!state.bindings || state.deviceId === null) return { closed: false };
  const { lib } = state.bindings;
  for (const [id] of state.channels) {
    lib.PassThruDisconnect(id);
  }
  state.channels.clear();
  const ret = lib.PassThruClose(state.deviceId);
  state.deviceId = null;
  log('info', `Device closed: ret=${j2534ErrName(ret)}`);
  return { closed: ret === 0, code: ret };
}

// ─── WebSocket server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: '1.0.0',
      platform: os.platform(),
      adapters: state.adapters.length,
      channels: state.channels.size,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  log('info', `Client connected: ${clientIp}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' }));
      return;
    }

    const { id, cmd, ...params } = msg;
    log('debug', `CMD ${cmd} id=${id}`);

    try {
      let result;
      switch (cmd) {
        case 'ping':
          result = { pong: true, ts: Date.now() };
          break;
        case 'listAdapters':
          result = cmdListAdapters();
          break;
        case 'openChannel':
          result = cmdOpenChannel(params);
          break;
        case 'sendFrame':
          result = cmdSendFrame(params);
          break;
        case 'sendFrameNoResp':
          result = cmdSendFrameNoResp(params);
          break;
        case 'closeChannel':
          result = cmdCloseChannel(params);
          break;
        case 'closeDevice':
          result = cmdCloseDevice();
          break;
        default:
          throw new Error(`Unknown command: ${cmd}`);
      }
      ws.send(JSON.stringify({ id, ok: true, result }));
    } catch (e) {
      log('warn', `CMD ${cmd} error: ${e.message}`);
      ws.send(JSON.stringify({ id, ok: false, error: e.message }));
    }
  });

  ws.on('close', () => {
    log('info', `Client disconnected: ${clientIp}`);
  });

  ws.on('error', (e) => {
    log('error', `WebSocket error: ${e.message}`);
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
loadFfi();

server.listen(PORT, '127.0.0.1', () => {
  log('info', `SRT Lab J2534 Relay v1.0.0 listening on ws://localhost:${PORT}`);
  log('info', `Health check: http://localhost:${PORT}/health`);
  if (os.platform() !== 'win32') {
    log('warn', 'Running on non-Windows platform — J2534 DLL calls will fail');
    log('warn', 'This is expected for development. Deploy on Windows for real adapter use.');
  }
  const discovered = cmdListAdapters();
  if (discovered.length === 0) {
    log('warn', 'No J2534 adapters found in registry. Use --dll to specify a DLL path.');
  } else {
    log('info', `Found ${discovered.length} adapter(s):`);
    discovered.forEach(a => log('info', `  [${a.id}] ${a.name} → ${a.dll}`));
  }
});

process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  cmdCloseDevice();
  server.close(() => process.exit(0));
});
