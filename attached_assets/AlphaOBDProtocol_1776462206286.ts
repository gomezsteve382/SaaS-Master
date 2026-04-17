/**
 * AlphaOBD-Style ELM327/STN Protocol Handler
 * ============================================
 * 
 * Replaces J2534 bridge with direct serial USB communication.
 * Matches AlphaOBD's exact initialization sequence for OBDLink EX.
 * 
 * How AlphaOBD communicates (captured from real traffic):
 *   1. Opens serial port at 115200 baud (or 2000000 for STN2120)
 *   2. Sends AT@1 → gets device description
 *   3. Sends STDI → gets "OBD SOLUTIONS LLC" (STN device ID)
 *   4. Sends ATPP2CSV81 → enables MFG extended mode on OBDLink EX
 *   5. Sends ATPP2CON → activates PP 2C
 *   6. Sends ATPP2DSV01 → sets CAN protocol options
 *   7. Sends ATPP2DON → activates PP 2D  
 *   8. Sends ATZ → resets with new parameters
 *   9. Then uses standard ISO-TP over CAN for UDS
 * 
 * Supports: OBDLink EX, OBDLink MX+, OBDLink SX, generic ELM327 v1.5+
 * 
 * Drop-in replacement for the existing ELM327Protocol class in obd2-protocol.ts
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AdapterInfo {
  chipset: 'STN' | 'ELM327' | 'unknown';
  name: string;
  firmware: string;
  manufacturer: string;
  voltage: string;
  supportsSTN: boolean;
  supportsCAN: boolean;
  supportsISO15765: boolean;
  supportsMSCAN: boolean;
}

export interface UDSResponse {
  success: boolean;
  data: Uint8Array;
  rawHex: string;
  canId: number;
  serviceId: number;
  error?: string;
  isNegativeResponse: boolean;
  nrcCode?: number;
  nrcDescription?: string;
}

export interface UDSLog {
  timestamp: number;
  direction: 'TX' | 'RX' | 'INFO' | 'ERROR';
  message: string;
  raw?: string;
}

// NRC (Negative Response Code) descriptions
const NRC_DESCRIPTIONS: Record<number, string> = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent',
  0x26: 'failurePreventsExecutionOfRequestedAction',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceededNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted',
  0x71: 'transferDataSuspended',
  0x72: 'generalProgrammingFailure',
  0x73: 'wrongBlockSequenceCounter',
  0x78: 'requestCorrectlyReceivedResponsePending',
  0x7E: 'subFunctionNotSupportedInActiveSession',
  0x7F: 'serviceNotSupportedInActiveSession',
};

// ═══════════════════════════════════════════════════════════════
// Main Protocol Class
// ═══════════════════════════════════════════════════════════════

export class AlphaOBDProtocol {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private adapterInfo: AdapterInfo | null = null;
  private currentTxId: number = 0;
  private currentRxId: number = 0;
  private connected: boolean = false;
  private log: UDSLog[] = [];
  private logCallback: ((entry: UDSLog) => void) | null = null;
  private responseBuffer: string = '';

  // ── Logging ──
  setLogCallback(cb: (entry: UDSLog) => void) { this.logCallback = cb; }
  getLog() { return this.log; }
  clearLog() { this.log = []; }

  private addLog(direction: UDSLog['direction'], message: string, raw?: string) {
    const entry: UDSLog = { timestamp: Date.now(), direction, message, raw };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.logCallback?.(entry);
  }

  // ── Connection ──
  isConnected() { return this.connected; }
  getAdapterInfo() { return this.adapterInfo; }

  static isSupported(): boolean {
    return 'serial' in navigator;
  }

  /**
   * Connect to adapter via WebSerial browser API
   * Opens serial port picker dialog
   */
  async connect(): Promise<boolean> {
    if (!AlphaOBDProtocol.isSupported()) {
      this.addLog('ERROR', 'WebSerial not supported — use Chrome/Edge');
      return false;
    }

    try {
      await this.disconnect();
      this.port = await navigator.serial.requestPort();
      return await this.openAndInit();
    } catch (e: any) {
      if (e.name === 'NotFoundError') {
        this.addLog('ERROR', 'Port selection cancelled');
      } else {
        this.addLog('ERROR', `Connection failed: ${e.message}`);
      }
      return false;
    }
  }

  /**
   * Connect to a specific port (bypasses browser picker)
   */
  async connectToPort(port: SerialPort): Promise<boolean> {
    await this.disconnect();
    this.port = port;
    return await this.openAndInit();
  }

  private async openAndInit(): Promise<boolean> {
    if (!this.port) return false;

    // Try baud rates: STN chips support 2000000, most ELM327 use 115200 or 38400
    const baudRates = [115200, 38400, 9600, 2000000];

    for (const baud of baudRates) {
      try {
        await this.safeOpenPort(baud);
        if (!this.port!.readable || !this.port!.writable) continue;

        this.reader = this.port!.readable.getReader();
        this.writer = this.port!.writable.getWriter();

        // Try to talk to the adapter
        const atzResponse = await this.sendAT('ATZ', 2000);
        if (atzResponse.includes('ELM') || atzResponse.includes('STN') || atzResponse.includes('OBD')) {
          this.addLog('INFO', `Connected at ${baud} baud`);
          await this.initAlphaOBDStyle();
          this.connected = true;
          return true;
        }

        // No valid response at this baud rate, try next
        await this.releaseStreams();
        await this.port!.close().catch(() => {});
        await this.delay(100);
      } catch {
        await this.releaseStreams();
        try { await this.port!.close(); } catch {}
        await this.delay(100);
      }
    }

    this.addLog('ERROR', 'No ELM327/STN adapter detected on any baud rate');
    return false;
  }

  /**
   * AlphaOBD-style initialization sequence
   * Matches the exact AT command sequence captured from AlphaOBD traffic
   */
  private async initAlphaOBDStyle(): Promise<void> {
    this.addLog('INFO', '── AlphaOBD-style initialization ──');

    // Phase 1: Reset and identify
    await this.sendAT('ATZ', 2000);          // Full reset
    await this.delay(500);
    await this.sendAT('ATE0');               // Echo off
    
    const atiResponse = await this.sendAT('ATI');  // Get firmware version
    this.addLog('INFO', `Firmware: ${atiResponse}`);

    // Phase 2: Detect STN chipset (OBDLink devices)
    const stdiResponse = await this.sendAT('STDI');  // STN Device Identification
    const isSTN = !stdiResponse.includes('?') && !stdiResponse.includes('ERROR');
    
    const at1Response = await this.sendAT('AT@1');   // Device description
    
    // Read voltage for diagnostics
    const voltageResponse = await this.sendAT('ATRV');

    this.adapterInfo = {
      chipset: isSTN ? 'STN' : 'ELM327',
      name: at1Response.replace(/[^a-zA-Z0-9 .]/g, '').trim() || 'Unknown',
      firmware: atiResponse.trim(),
      manufacturer: isSTN ? stdiResponse.trim() : 'Generic',
      voltage: voltageResponse.replace(/[^0-9.V]/g, '').trim(),
      supportsSTN: isSTN,
      supportsCAN: true,
      supportsISO15765: true,
      supportsMSCAN: isSTN, // Only STN adapters reliably support MS-CAN pin switching
    };

    this.addLog('INFO', `Adapter: ${this.adapterInfo.chipset} | ${this.adapterInfo.name} | ${this.adapterInfo.manufacturer}`);
    this.addLog('INFO', `Voltage: ${this.adapterInfo.voltage}`);

    // Phase 3: STN-specific programmable parameters (AlphaOBD's secret sauce)
    if (isSTN) {
      this.addLog('INFO', 'Configuring STN programmable parameters...');
      
      // PP 2C = 0x81: Enable MFG extended mode
      // This unlocks OBDLink EX's advanced features: multi-channel CAN,
      // enhanced flow control, extended timeouts, and faster response times
      await this.sendAT('ATPP2CSV81');
      await this.sendAT('ATPP2CON');
      
      // PP 2D = 0x01: CAN protocol options  
      // Enables ISO-TP padding, automatic flow control handling,
      // and proper multi-frame segmentation
      await this.sendAT('ATPP2DSV01');
      await this.sendAT('ATPP2DON');
      
      // Reset to apply programmable parameters
      await this.sendAT('ATZ', 1500);
      await this.delay(500);
      await this.sendAT('ATE0');  // Echo off again after reset
      
      this.addLog('INFO', 'STN programmable parameters applied (PP2C=81, PP2D=01)');
    }

    // Phase 4: Configure CAN protocol
    await this.sendAT('ATL0');     // Linefeeds off
    await this.sendAT('ATS1');     // Spaces ON (required for response parsing)
    await this.sendAT('ATH1');     // Headers ON (show CAN IDs in response)
    await this.sendAT('ATSP6');    // Protocol 6 = ISO 15765-4 CAN (11-bit, 500 kbps)
    await this.sendAT('ATAT2');    // Adaptive timing aggressive (faster responses)
    await this.sendAT('ATST96');   // Timeout = 150 * 4ms = 600ms (longer for slow ECUs)
    
    // Phase 5: ISO-TP configuration
    if (isSTN) {
      // STN: Use CAN Auto Formatting ON — the STN chip handles ISO-TP natively
      // This is WAY more reliable than manual ISO-TP framing
      await this.sendAT('ATCAF1');   // CAN Auto Formatting ON
      await this.sendAT('STCSWM1'); // STN: Enable CAN Silent Wakeup Mode (no bus interference)
      // Set flow control parameters for multi-frame
      await this.sendAT('ATFCSH7E0');  // Flow control header (will be overridden per-module)
      await this.sendAT('ATFCSD300000'); // FC: ContinueToSend, BS=0 (no limit), STmin=0
      await this.sendAT('ATFCSM1');     // Flow control mode 1 (auto respond to FC)
      this.addLog('INFO', 'STN: CAN Auto Formatting ON, auto flow control enabled');
    } else {
      // Generic ELM327: Use CAF ON with manual flow control
      await this.sendAT('ATCAF1');   // CAN Auto Formatting ON
      await this.sendAT('ATFCSM1'); // Flow control mode 1
      this.addLog('INFO', 'ELM327: CAN Auto Formatting ON');
    }

    this.addLog('INFO', '── Initialization complete ──');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.releaseStreams();
    if (this.port) {
      try { await this.port.close(); } catch {}
      this.port = null;
    }
    this.adapterInfo = null;
    this.addLog('INFO', 'Disconnected');
  }

  async ping(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const r = await this.sendAT('ATI', 1000);
      return r.includes('ELM') || r.includes('STN') || r.length > 0;
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════════════
  // UDS Communication (matches AlphaOBD's approach)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send UDS command and receive response
   * This is the main API — handles all ISO-TP framing automatically
   */
  async sendUDS(txId: number, rxId: number, data: number[], timeoutMs: number = 5000): Promise<UDSResponse> {
    if (!this.connected || !this.writer || !this.reader) {
      return { success: false, data: new Uint8Array(), rawHex: '', canId: 0, serviceId: 0, error: 'Not connected', isNegativeResponse: false };
    }

    // Set target module addressing
    if (txId !== this.currentTxId) {
      await this.sendAT(`ATSH${txId.toString(16).toUpperCase().padStart(3, '0')}`);
      // Set flow control header to match TX
      if (this.adapterInfo?.supportsSTN) {
        await this.sendAT(`ATFCSH${txId.toString(16).toUpperCase().padStart(3, '0')}`);
      }
      this.currentTxId = txId;
    }
    if (rxId !== this.currentRxId) {
      await this.sendAT(`ATCRA${rxId.toString(16).toUpperCase().padStart(3, '0')}`);
      this.currentRxId = rxId;
    }

    // Build hex command string
    // With ATCAF1 (auto formatting), we just send the raw UDS bytes
    // The adapter handles ISO-TP framing automatically
    const hexCmd = data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    
    this.addLog('TX', `[${txId.toString(16).toUpperCase()}] ${hexCmd}`, hexCmd);

    // Send and wait for response
    const rawResponse = await this.sendAT(hexCmd, timeoutMs);

    // Handle errors
    if (rawResponse.includes('NO DATA') || rawResponse.includes('UNABLE TO CONNECT')) {
      this.addLog('ERROR', `No response from 0x${txId.toString(16).toUpperCase()}`);
      return { success: false, data: new Uint8Array(), rawHex: rawResponse, canId: rxId, serviceId: data[0], error: 'No response (check connection, IGN, module power)', isNegativeResponse: false };
    }
    if (rawResponse.includes('CAN ERROR') || rawResponse.includes('BUS ERROR')) {
      this.addLog('ERROR', `CAN bus error: ${rawResponse}`);
      return { success: false, data: new Uint8Array(), rawHex: rawResponse, canId: rxId, serviceId: data[0], error: 'CAN bus error (check wiring, termination)', isNegativeResponse: false };
    }
    if (rawResponse.includes('?') || rawResponse.includes('ERROR')) {
      this.addLog('ERROR', `Adapter error: ${rawResponse}`);
      return { success: false, data: new Uint8Array(), rawHex: rawResponse, canId: rxId, serviceId: data[0], error: `Adapter error: ${rawResponse}`, isNegativeResponse: false };
    }

    // Parse response bytes (with ATCAF1 + ATH1, response format is: "7E8 XX XX XX ...")
    const responseBytes = this.parseResponseBytes(rawResponse, rxId);
    if (responseBytes.length === 0) {
      this.addLog('ERROR', `Empty response: "${rawResponse}"`);
      return { success: false, data: new Uint8Array(), rawHex: rawResponse, canId: rxId, serviceId: data[0], error: 'Could not parse response', isNegativeResponse: false };
    }

    // Check for negative response (0x7F)
    if (responseBytes[0] === 0x7F) {
      const nrcCode = responseBytes.length >= 3 ? responseBytes[2] : 0;
      
      // Handle "response pending" — keep reading
      if (nrcCode === 0x78) {
        this.addLog('INFO', 'ECU: responsePending (0x78), waiting...');
        return await this.waitForPendingResponse(txId, rxId, data[0], timeoutMs);
      }
      
      const nrcDesc = NRC_DESCRIPTIONS[nrcCode] || `unknown (0x${nrcCode.toString(16)})`;
      this.addLog('RX', `[${rxId.toString(16).toUpperCase()}] NEGATIVE: ${nrcDesc}`, rawResponse);
      
      return {
        success: false,
        data: new Uint8Array(responseBytes),
        rawHex: rawResponse,
        canId: rxId,
        serviceId: data[0],
        error: nrcDesc,
        isNegativeResponse: true,
        nrcCode,
        nrcDescription: nrcDesc,
      };
    }

    // Positive response: first byte should be serviceId + 0x40
    const expectedResponseId = data[0] + 0x40;
    if (responseBytes[0] !== expectedResponseId) {
      this.addLog('ERROR', `Unexpected response SID: 0x${responseBytes[0].toString(16)} (expected 0x${expectedResponseId.toString(16)})`);
    }

    const respHex = responseBytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    this.addLog('RX', `[${rxId.toString(16).toUpperCase()}] ${respHex}`, rawResponse);

    return {
      success: true,
      data: new Uint8Array(responseBytes),
      rawHex: rawResponse,
      canId: rxId,
      serviceId: data[0],
      isNegativeResponse: false,
    };
  }

  /**
   * Wait for ECU to finish processing (after 0x78 responsePending)
   */
  private async waitForPendingResponse(txId: number, rxId: number, serviceId: number, timeoutMs: number): Promise<UDSResponse> {
    const deadline = Date.now() + timeoutMs;
    
    while (Date.now() < deadline) {
      const rawResponse = await this.readUntilPrompt(3000);
      if (!rawResponse) continue;
      
      const bytes = this.parseResponseBytes(rawResponse, rxId);
      if (bytes.length === 0) continue;
      
      // Still pending?
      if (bytes[0] === 0x7F && bytes.length >= 3 && bytes[2] === 0x78) {
        this.addLog('INFO', 'ECU: still pending...');
        continue;
      }
      
      // Got final response
      if (bytes[0] === 0x7F) {
        const nrc = bytes[2] || 0;
        const desc = NRC_DESCRIPTIONS[nrc] || `unknown (0x${nrc.toString(16)})`;
        return { success: false, data: new Uint8Array(bytes), rawHex: rawResponse, canId: rxId, serviceId, error: desc, isNegativeResponse: true, nrcCode: nrc, nrcDescription: desc };
      }
      
      const respHex = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      this.addLog('RX', `[${rxId.toString(16).toUpperCase()}] ${respHex}`, rawResponse);
      return { success: true, data: new Uint8Array(bytes), rawHex: rawResponse, canId: rxId, serviceId, isNegativeResponse: false };
    }
    
    return { success: false, data: new Uint8Array(), rawHex: '', canId: rxId, serviceId, error: 'Timeout waiting for ECU response after pending', isNegativeResponse: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // High-Level UDS Services
  // ═══════════════════════════════════════════════════════════════

  /** Service 0x10: Diagnostic Session Control */
  async diagnosticSession(txId: number, rxId: number, session: number): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x10, session]);
  }

  /** Service 0x11: ECU Reset */
  async ecuReset(txId: number, rxId: number, resetType: number = 0x01): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x11, resetType]);
  }

  /** Service 0x27: Security Access - Request Seed */
  async requestSeed(txId: number, rxId: number, level: number = 0x01): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x27, level]);
  }

  /** Service 0x27: Security Access - Send Key */
  async sendKey(txId: number, rxId: number, level: number, keyBytes: number[]): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x27, level, ...keyBytes]);
  }

  /** Service 0x22: Read Data By Identifier */
  async readDID(txId: number, rxId: number, did: number): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x22, (did >> 8) & 0xFF, did & 0xFF]);
  }

  /** Service 0x2E: Write Data By Identifier */
  async writeDID(txId: number, rxId: number, did: number, data: number[]): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x2E, (did >> 8) & 0xFF, did & 0xFF, ...data]);
  }

  /** Service 0x31: Routine Control */
  async routineControl(txId: number, rxId: number, subFn: number, routineId: number, data: number[] = []): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x31, subFn, (routineId >> 8) & 0xFF, routineId & 0xFF, ...data]);
  }

  /** Service 0x19: Read DTC Information */
  async readDTCs(txId: number, rxId: number, subFn: number = 0x02, statusMask: number = 0xFF): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x19, subFn, statusMask]);
  }

  /** Service 0x14: Clear DTCs */
  async clearDTCs(txId: number, rxId: number): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x14, 0xFF, 0xFF, 0xFF]);
  }

  /** Service 0x3E: Tester Present (keep session alive) */
  async testerPresent(txId: number, rxId: number): Promise<UDSResponse> {
    return this.sendUDS(txId, rxId, [0x3E, 0x00]);
  }

  /** Read VIN (DID 0xF190) */
  async readVIN(txId: number, rxId: number): Promise<string | null> {
    const resp = await this.readDID(txId, rxId, 0xF190);
    if (!resp.success || resp.data.length < 20) return null; // 3 bytes header + 17 VIN
    const vinBytes = resp.data.slice(3); // Skip 62 F1 90
    return String.fromCharCode(...vinBytes.filter(b => b >= 0x20 && b <= 0x7E)).slice(0, 17);
  }

  /** Write VIN (DID 0xF190) */
  async writeVIN(txId: number, rxId: number, vin: string): Promise<UDSResponse> {
    if (vin.length !== 17) return { success: false, data: new Uint8Array(), rawHex: '', canId: rxId, serviceId: 0x2E, error: 'VIN must be 17 characters', isNegativeResponse: false };
    const vinBytes = Array.from(vin).map(c => c.charCodeAt(0));
    return this.writeDID(txId, rxId, 0xF190, vinBytes);
  }

  /** Quick module scan: send TesterPresent to see if module responds */
  async probeModule(txId: number, rxId: number): Promise<boolean> {
    const resp = await this.testerPresent(txId, rxId);
    return resp.success;
  }

  // ═══════════════════════════════════════════════════════════════
  // Bus Configuration
  // ═══════════════════════════════════════════════════════════════

  /** Switch to MS-CAN (pins 3 & 11) — STN adapters only */
  async switchToMSCAN(): Promise<boolean> {
    if (!this.adapterInfo?.supportsSTN) {
      this.addLog('ERROR', 'MS-CAN pin switching requires STN/OBDLink adapter');
      return false;
    }
    await this.sendAT('STPX H:030B');  // STN: Set pins to 3/11
    this.addLog('INFO', 'Switched to MS-CAN (pins 3/11)');
    return true;
  }

  /** Switch to HS-CAN (pins 6 & 14) — default */
  async switchToHSCAN(): Promise<boolean> {
    if (this.adapterInfo?.supportsSTN) {
      await this.sendAT('STPX H:0E06');
    }
    await this.sendAT('ATSP6');  // ISO 15765-4 CAN 500k
    this.addLog('INFO', 'Switched to HS-CAN (pins 6/14)');
    return true;
  }

  /** Set custom baud rate (for special modules) */
  async setBaudRate(baud: number): Promise<boolean> {
    if (this.adapterInfo?.supportsSTN) {
      await this.sendAT(`STPBR${baud}`);
      this.addLog('INFO', `Baud rate set to ${baud}`);
      return true;
    }
    this.addLog('ERROR', 'Custom baud rates require STN adapter');
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // Low-Level Communication
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send AT command and read response
   */
  async sendAT(cmd: string, timeoutMs: number = 3000): Promise<string> {
    if (!this.writer) throw new Error('Not connected');
    
    // Drain any leftover data in buffer
    this.responseBuffer = '';
    
    const encoder = new TextEncoder();
    await this.writer.write(encoder.encode(cmd + '\r'));
    
    return this.readUntilPrompt(timeoutMs);
  }

  /**
   * Read from serial until we get the '>' prompt or timeout
   */
  private async readUntilPrompt(timeoutMs: number): Promise<string> {
    if (!this.reader) throw new Error('No reader');
    
    const decoder = new TextDecoder();
    let response = this.responseBuffer;
    this.responseBuffer = '';
    const deadline = Date.now() + timeoutMs;
    
    while (Date.now() < deadline) {
      try {
        // Use a race between read and timeout
        const readPromise = this.reader.read();
        const timeoutPromise = new Promise<{value: undefined, done: true}>(resolve => 
          setTimeout(() => resolve({value: undefined, done: true}), Math.min(500, deadline - Date.now()))
        );
        
        const result = await Promise.race([readPromise, timeoutPromise]);
        
        if (result.done || !result.value) {
          if (Date.now() >= deadline) break;
          continue;
        }
        
        response += decoder.decode(result.value);
        
        // Check for prompt
        const promptIdx = response.indexOf('>');
        if (promptIdx !== -1) {
          // Save anything after the prompt for next read
          this.responseBuffer = response.substring(promptIdx + 1);
          // Return everything before the prompt
          return this.cleanResponse(response.substring(0, promptIdx));
        }
      } catch (e) {
        break;
      }
    }
    
    return this.cleanResponse(response);
  }

  /**
   * Parse response bytes from adapter output
   * With ATH1 + ATCAF1, format is: "7E8 62 F1 90 32 43 33 ..." (one or more lines)
   */
  private parseResponseBytes(raw: string, expectedRxId: number): number[] {
    const lines = raw.split(/[\r\n]+/).filter(l => l.trim().length > 0);
    const allBytes: number[] = [];
    const rxIdHex = expectedRxId.toString(16).toUpperCase().padStart(3, '0');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip non-data lines
      if (trimmed.includes('SEARCHING') || trimmed.includes('OK') || trimmed === '') continue;
      
      // With headers ON, first token is the CAN ID
      const tokens = trimmed.split(/\s+/);
      if (tokens.length < 2) continue;
      
      // Check if first token is a CAN ID (3 hex chars for 11-bit)
      const firstToken = tokens[0].toUpperCase();
      if (/^[0-9A-F]{3}$/.test(firstToken)) {
        // CAN ID present — check if it matches expected RX
        if (firstToken === rxIdHex || firstToken === expectedRxId.toString(16).toUpperCase()) {
          // Data bytes start at token[1]
          for (let i = 1; i < tokens.length; i++) {
            if (/^[0-9A-Fa-f]{2}$/.test(tokens[i])) {
              allBytes.push(parseInt(tokens[i], 16));
            }
          }
        }
      } else {
        // No CAN ID header — parse all hex bytes
        for (const token of tokens) {
          if (/^[0-9A-Fa-f]{2}$/.test(token)) {
            allBytes.push(parseInt(token, 16));
          }
        }
      }
    }
    
    return allBytes;
  }

  private cleanResponse(raw: string): string {
    return raw
      .replace(/\r/g, '\n')
      .replace(/\n+/g, '\n')
      .replace(/>/g, '')
      .trim();
  }

  // ── Port management ──
  private async safeOpenPort(baudRate: number): Promise<void> {
    if (!this.port) throw new Error('No port');
    
    if (this.port.readable !== null || this.port.writable !== null) {
      await this.releaseStreams();
      try { await this.port.close(); } catch {}
      await this.delay(150);
    }
    
    await this.port.open({ baudRate });
  }

  private async releaseStreams(): Promise<void> {
    if (this.reader) {
      try { await this.reader.cancel(); this.reader.releaseLock(); } catch {}
      this.reader = null;
    }
    if (this.writer) {
      try { await this.writer.close(); } catch {}
      this.writer = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
