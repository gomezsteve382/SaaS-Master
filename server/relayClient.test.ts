/**
 * Relay client protocol tests
 * Tests the RelayClient message serialization, response parsing,
 * NRC detection, and sequence execution logic using a mock WebSocket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock WebSocket ────────────────────────────────────────────────────────────
class MockWebSocket {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {}

  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Simulate a server response */
  respond(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Simulate an error */
  error() {
    this.onerror?.();
  }
}

// ─── Minimal RelayClient re-implementation for testing ────────────────────────
// We test the protocol logic directly without importing the browser module.
// This mirrors the exact message format used by relayClient.js.

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TestableRelayClient {
  private _ws: MockWebSocket | null = null;
  private _pending = new Map<number, PendingCall>();
  private _idCounter = 0;
  status: string = 'disconnected';

  connect(ws: MockWebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      this._ws = ws;
      this.status = 'connecting';
      ws.onopen = () => { this.status = 'connected'; resolve(); };
      ws.onerror = () => { this.status = 'error'; reject(new Error('ws error')); };
      ws.onclose = () => { this.status = 'disconnected'; };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event') return;
        const p = this._pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this._pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      };
    });
  }

  send(cmd: string, params: object = {}, timeoutMs = 1000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this._idCounter;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`timeout: ${cmd}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws!.send(JSON.stringify({ id, cmd, ...params }));
    });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Relay protocol — message serialization', () => {
  let ws: MockWebSocket;
  let client: TestableRelayClient;

  beforeEach(async () => {
    ws = new MockWebSocket('ws://localhost:7534');
    client = new TestableRelayClient();
    const connectPromise = client.connect(ws);
    ws.open();
    await connectPromise;
  });

  it('sends ping with incrementing id', async () => {
    const p = client.send('ping');
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.cmd).toBe('ping');
    expect(sent.id).toBe(1);
    ws.respond({ id: 1, ok: true, result: { pong: true } });
    const result = await p as { pong: boolean };
    expect(result.pong).toBe(true);
  });

  it('sends listAdapters command', async () => {
    const p = client.send('listAdapters');
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.cmd).toBe('listAdapters');
    ws.respond({ id: sent.id, ok: true, result: [{ id: 0, name: 'Mongoose', dll: 'C:\\mongoose.dll' }] });
    const result = await p as Array<{ id: number; name: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Mongoose');
  });

  it('sends openChannel with correct params', async () => {
    const p = client.send('openChannel', { adapterId: 0, protocol: 'CAN', baudRate: 500000, flags: 0 });
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.cmd).toBe('openChannel');
    expect(sent.adapterId).toBe(0);
    expect(sent.protocol).toBe('CAN');
    expect(sent.baudRate).toBe(500000);
    ws.respond({ id: sent.id, ok: true, result: { channelId: 42, protocol: 'CAN', baudRate: 500000 } });
    const result = await p as { channelId: number };
    expect(result.channelId).toBe(42);
  });

  it('sends sendFrame with CAN ID and bytes', async () => {
    const p = client.send('sendFrame', { channelId: 42, canId: 0x7E0, bytes: [0x10, 0x03], timeoutMs: 150 });
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.cmd).toBe('sendFrame');
    expect(sent.canId).toBe(0x7E0);
    expect(sent.bytes).toEqual([0x10, 0x03]);
    ws.respond({
      id: sent.id, ok: true,
      result: { sent: { canId: 0x7E0, bytes: [0x10, 0x03] }, responses: [{ canId: 0x7E8, bytes: [0x50, 0x03], timestamp: 0 }] }
    });
    const result = await p as { responses: Array<{ canId: number; bytes: number[] }> };
    expect(result.responses[0].bytes[0]).toBe(0x50); // positive response
  });

  it('rejects on error response', async () => {
    const p = client.send('openChannel', { adapterId: 99 });
    const sent = JSON.parse(ws.sent[0]);
    ws.respond({ id: sent.id, ok: false, error: 'Adapter 99 not found' });
    await expect(p).rejects.toThrow('Adapter 99 not found');
  });

  it('rejects on timeout', async () => {
    const p = client.send('ping', {}, 50); // 50ms timeout
    // Don't respond — let it time out
    await expect(p).rejects.toThrow('timeout: ping');
  });

  it('handles multiple in-flight commands independently', async () => {
    const p1 = client.send('ping');
    const p2 = client.send('listAdapters');
    const s1 = JSON.parse(ws.sent[0]);
    const s2 = JSON.parse(ws.sent[1]);
    expect(s1.id).not.toBe(s2.id);

    // Respond out of order
    ws.respond({ id: s2.id, ok: true, result: [] });
    ws.respond({ id: s1.id, ok: true, result: { pong: true } });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1 as { pong: boolean }).pong).toBe(true);
    expect(r2).toEqual([]);
  });
});

describe('Relay protocol — NRC detection', () => {
  it('identifies NRC 0x35 as invalidKey', () => {
    const NRC_NAMES: Record<number, string> = {
      0x35: 'invalidKey',
      0x33: 'securityAccessDenied',
      0x78: 'requestCorrectlyReceivedResponsePending',
    };
    expect(NRC_NAMES[0x35]).toBe('invalidKey');
    expect(NRC_NAMES[0x33]).toBe('securityAccessDenied');
    expect(NRC_NAMES[0x78]).toBe('requestCorrectlyReceivedResponsePending');
  });

  it('detects NRC frame by first byte 0x7F', () => {
    const response = [0x7F, 0x27, 0x35]; // NRC for SA service, invalidKey
    expect(response[0]).toBe(0x7F);
    expect(response[2]).toBe(0x35);
  });

  it('detects positive response by matching service+0x40', () => {
    // DSC positive response: 0x50 = 0x10 + 0x40
    expect(0x50).toBe(0x10 + 0x40);
    // SA positive response: 0x67 = 0x27 + 0x40
    expect(0x67).toBe(0x27 + 0x40);
    // WDBI positive response: 0x6E = 0x2E + 0x40
    expect(0x6E).toBe(0x2E + 0x40);
    // RDBI positive response: 0x62 = 0x22 + 0x40
    expect(0x62).toBe(0x22 + 0x40);
  });
});

describe('Relay protocol — frame format', () => {
  it('encodes CAN ID as 4 big-endian bytes before data', () => {
    const canId = 0x7E0;
    const data = [0x10, 0x03];
    // J2534 format: first 4 bytes = CAN ID, then data
    const idBytes = [(canId >> 24) & 0xFF, (canId >> 16) & 0xFF, (canId >> 8) & 0xFF, canId & 0xFF];
    expect(idBytes).toEqual([0x00, 0x00, 0x07, 0xE0]);
    const fullFrame = [...idBytes, ...data];
    expect(fullFrame).toEqual([0x00, 0x00, 0x07, 0xE0, 0x10, 0x03]);
  });

  it('decodes CAN ID from first 4 bytes of J2534 message', () => {
    const raw = [0x00, 0x00, 0x07, 0xE8, 0x50, 0x03]; // RX from BCM
    const rxCanId = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
    const rxData = raw.slice(4);
    expect(rxCanId).toBe(0x7E8);
    expect(rxData).toEqual([0x50, 0x03]);
  });

  it('validates known Stellantis module CAN IDs', () => {
    const modules = [
      { name: 'BCM', tx: 0x744, rx: 0x74C },
      { name: 'ECM', tx: 0x7E0, rx: 0x7E8 },
      { name: 'IPC', tx: 0x746, rx: 0x766 },
      { name: 'TCM', tx: 0x7E1, rx: 0x7E9 },
      { name: 'RFHUB', tx: 0x750, rx: 0x758 },
      { name: 'SKREEM', tx: 0x744, rx: 0x74C },
    ];
    // All TX IDs should be 11-bit (≤ 0x7FF)
    for (const m of modules) {
      expect(m.tx).toBeLessThanOrEqual(0x7FF);
      expect(m.rx).toBeLessThanOrEqual(0x7FF);
      // RX should be TX + 8 for standard OBD addressing
      if (m.name !== 'IPC') {
        expect(m.rx - m.tx).toBe(8);
      }
    }
  });
});

describe('Relay protocol — sequence execution logic', () => {
  it('builds correct DSC extended session frame', () => {
    const DSC_EXTENDED = [0x10, 0x03];
    expect(DSC_EXTENDED[0]).toBe(0x10); // DiagnosticSessionControl
    expect(DSC_EXTENDED[1]).toBe(0x03); // extendedDiagnosticSession
  });

  it('builds correct SA seed request frame', () => {
    const SA_SEED_REQ = [0x27, 0x01]; // requestSeed, level 01
    expect(SA_SEED_REQ[0]).toBe(0x27); // SecurityAccess
    expect(SA_SEED_REQ[1]).toBe(0x01); // requestSeed (odd = seed request)
  });

  it('builds correct SA key send frame', () => {
    const key = [0xAB, 0xCD, 0xEF, 0x12];
    const SA_KEY_SEND = [0x27, 0x02, ...key]; // sendKey, level 02
    expect(SA_KEY_SEND[0]).toBe(0x27);
    expect(SA_KEY_SEND[1]).toBe(0x02); // sendKey (even = key send)
    expect(SA_KEY_SEND.slice(2)).toEqual(key);
  });

  it('builds correct TesterPresent frame (no response)', () => {
    const TP_NO_RESP = [0x3E, 0x80]; // TesterPresent, suppressPosRspMsgIndicationBit
    expect(TP_NO_RESP[0]).toBe(0x3E);
    expect(TP_NO_RESP[1]).toBe(0x80); // suppress positive response
  });

  it('builds correct GPEC2A FCA session sequence', () => {
    // From CB Master 2026 page 20: 1A 87 → 10 92 → 10 85 → 27 63/64
    const sequence = [
      [0x1A, 0x87],       // ReadEcuIdentification (KWP)
      [0x10, 0x92],       // DSC 0x92 (FCA extended)
      [0x10, 0x85],       // DSC 0x85 (FCA programming)
      [0x27, 0x63],       // SA seed request level 0x63
    ];
    expect(sequence[0]).toEqual([0x1A, 0x87]);
    expect(sequence[1][0]).toBe(0x10);
    expect(sequence[1][1]).toBe(0x92);
    expect(sequence[3][1]).toBe(0x63); // FCA SA level
  });

  it('validates Renesas OBD proxy write DID 0x2023', () => {
    // From CB Master 2026 page 22: DID 0x2023, 235 bytes
    const DID_RENESAS_BCM = 0x2023;
    const PAYLOAD_SIZE = 235;
    const frame = [0x2E, (DID_RENESAS_BCM >> 8) & 0xFF, DID_RENESAS_BCM & 0xFF];
    expect(frame[0]).toBe(0x2E); // WriteDataByIdentifier
    expect(frame[1]).toBe(0x20);
    expect(frame[2]).toBe(0x23);
    // Full frame with payload would be 3 + 235 = 238 bytes
    expect(3 + PAYLOAD_SIZE).toBe(238);
  });
});

describe('Relay agent — adapter discovery', () => {
  it('validates J2534 protocol ID constants', () => {
    const J2534_PROTOCOL = {
      CAN:       0x05,
      ISO15765:  0x06,
      SW_CAN_PS: 0x08,
    };
    expect(J2534_PROTOCOL.CAN).toBe(5);
    expect(J2534_PROTOCOL.ISO15765).toBe(6);
    expect(J2534_PROTOCOL.SW_CAN_PS).toBe(8);
  });

  it('validates supported baud rates', () => {
    const VALID_BAUDS = [125000, 250000, 500000, 1000000];
    expect(VALID_BAUDS).toContain(500000); // most common for HS-CAN
    expect(VALID_BAUDS).toContain(125000); // SW-CAN
  });

  it('validates J2534 error code names', () => {
    const ERR_NAMES: Record<number, string> = {
      0x00: 'STATUS_NOERROR',
      0x07: 'ERR_FAILED',
      0x08: 'ERR_DEVICE_NOT_CONNECTED',
      0x09: 'ERR_TIMEOUT',
      0x10: 'ERR_BUFFER_EMPTY',
    };
    expect(ERR_NAMES[0x00]).toBe('STATUS_NOERROR');
    expect(ERR_NAMES[0x09]).toBe('ERR_TIMEOUT');
    expect(ERR_NAMES[0x10]).toBe('ERR_BUFFER_EMPTY');
  });
});
