/**
 * SRT Lab — J2534 Relay Client
 * ==============================
 * Browser-side WebSocket client that connects to the local srt-relay.js
 * agent and provides a Promise-based API for sending UDS frames.
 *
 * Usage:
 *   import { RelayClient } from './relayClient';
 *   const relay = new RelayClient('ws://localhost:7534');
 *   await relay.connect();
 *   const adapters = await relay.listAdapters();
 *   const { channelId } = await relay.openChannel({ adapterId: 0, protocol: 'CAN', baudRate: 500000 });
 *   const result = await relay.sendFrame({ channelId, canId: 0x7E0, bytes: [0x10, 0x03] });
 *   await relay.closeChannel({ channelId });
 */

'use strict';

export const RELAY_DEFAULT_URL = 'ws://localhost:7534';
export const RELAY_DEFAULT_TIMEOUT_MS = 5000;

export class RelayClient {
  constructor(url = RELAY_DEFAULT_URL) {
    this.url = url;
    this._ws = null;
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._idCounter = 0;
    this._status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    this._statusListeners = [];
    this._eventListeners = [];
  }

  // ─── Status ──────────────────────────────────────────────────────────────────
  get status() { return this._status; }
  get isConnected() { return this._status === 'connected'; }

  onStatusChange(fn) { this._statusListeners.push(fn); return () => { this._statusListeners = this._statusListeners.filter(f => f !== fn); }; }
  onEvent(fn) { this._eventListeners.push(fn); return () => { this._eventListeners = this._eventListeners.filter(f => f !== fn); }; }

  _setStatus(s) {
    this._status = s;
    this._statusListeners.forEach(fn => fn(s));
  }

  // ─── Connection ───────────────────────────────────────────────────────────────
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (this._status === 'connected') { resolve(); return; }
      this._setStatus('connecting');

      const ws = new WebSocket(this.url);
      this._ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        this._setStatus('error');
        reject(new Error(`Connection timeout after ${timeoutMs}ms — is srt-relay.js running?`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        this._setStatus('connected');
        resolve();
      };

      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        // Relay events (no id)
        if (msg.type === 'event') {
          this._eventListeners.forEach(fn => fn(msg));
          return;
        }

        // Command responses
        const pending = this._pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pending.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || 'Unknown relay error'));
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        this._setStatus('error');
        this._rejectAllPending('WebSocket error');
        reject(new Error('WebSocket error — check that srt-relay.js is running on localhost:7534'));
      };

      ws.onclose = () => {
        this._setStatus('disconnected');
        this._rejectAllPending('WebSocket closed');
      };
    });
  }

  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setStatus('disconnected');
  }

  _rejectAllPending(reason) {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }

  // ─── Command dispatch ─────────────────────────────────────────────────────────
  _send(cmd, params = {}, timeoutMs = RELAY_DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Relay not connected'));
        return;
      }
      const id = ++this._idCounter;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Command "${cmd}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ id, cmd, ...params }));
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  ping() {
    return this._send('ping');
  }

  listAdapters() {
    return this._send('listAdapters');
  }

  /**
   * @param {{ adapterId: number, protocol?: string, baudRate?: number, flags?: number }} opts
   * @returns {Promise<{ channelId: number, protocol: string, baudRate: number }>}
   */
  openChannel(opts) {
    return this._send('openChannel', opts, 10000);
  }

  /**
   * Send a CAN frame and wait for a response.
   * @param {{ channelId: number, canId: number, bytes: number[], timeoutMs?: number }} opts
   * @returns {Promise<{ sent: { canId, bytes }, responses: Array<{ canId, bytes, timestamp }> }>}
   */
  sendFrame(opts) {
    return this._send('sendFrame', opts, (opts.timeoutMs || 150) + 1000);
  }

  /**
   * Send a CAN frame without waiting for a response (TesterPresent, etc.)
   * @param {{ channelId: number, canId: number, bytes: number[] }} opts
   */
  sendFrameNoResp(opts) {
    return this._send('sendFrameNoResp', opts);
  }

  closeChannel(opts) {
    return this._send('closeChannel', opts);
  }

  closeDevice() {
    return this._send('closeDevice');
  }

  // ─── High-level helpers ───────────────────────────────────────────────────────

  /**
   * Execute a full UDS session sequence step by step.
   * Each step is { label, canId, bytes, timeoutMs?, noResp? }
   * Returns an array of step results with timing.
   *
   * @param {number} channelId
   * @param {Array<{ label: string, canId: number, bytes: number[], timeoutMs?: number, noResp?: boolean }>} steps
   * @param {{ onStep?: (step, result) => void, abortOnNrc?: boolean }} opts
   */
  async executeSequence(channelId, steps, opts = {}) {
    const { onStep, abortOnNrc = true } = opts;
    const results = [];

    for (const step of steps) {
      const t0 = performance.now();
      let result;
      try {
        if (step.noResp) {
          result = await this.sendFrameNoResp({ channelId, canId: step.canId, bytes: step.bytes });
          result = { sent: { canId: step.canId, bytes: step.bytes }, responses: [] };
        } else {
          result = await this.sendFrame({
            channelId,
            canId: step.canId,
            bytes: step.bytes,
            timeoutMs: step.timeoutMs || 150,
          });
        }
        result.label = step.label;
        result.durationMs = Math.round(performance.now() - t0);
        result.ok = true;

        // Check for NRC in first response
        if (abortOnNrc && result.responses.length > 0) {
          const resp = result.responses[0].bytes;
          if (resp[0] === 0x7F) {
            result.ok = false;
            result.nrc = resp[2];
            result.nrcName = NRC_NAMES[resp[2]] || `NRC_0x${resp[2].toString(16).toUpperCase()}`;
            results.push(result);
            if (onStep) onStep(step, result);
            throw new RelayNrcError(step.label, resp[2], result.nrcName, results);
          }
        }
      } catch (e) {
        if (e instanceof RelayNrcError) throw e;
        result = {
          label: step.label,
          ok: false,
          error: e.message,
          durationMs: Math.round(performance.now() - t0),
          responses: [],
        };
        results.push(result);
        if (onStep) onStep(step, result);
        throw new RelaySequenceError(step.label, e.message, results);
      }

      results.push(result);
      if (onStep) onStep(step, result);
    }

    return results;
  }
}

// ─── Error types ──────────────────────────────────────────────────────────────
export class RelayNrcError extends Error {
  constructor(stepLabel, nrcCode, nrcName, completedSteps) {
    super(`NRC ${nrcName} (0x${nrcCode.toString(16).toUpperCase()}) at step: ${stepLabel}`);
    this.name = 'RelayNrcError';
    this.stepLabel = stepLabel;
    this.nrcCode = nrcCode;
    this.nrcName = nrcName;
    this.completedSteps = completedSteps;
  }
}

export class RelaySequenceError extends Error {
  constructor(stepLabel, reason, completedSteps) {
    super(`Sequence failed at step "${stepLabel}": ${reason}`);
    this.name = 'RelaySequenceError';
    this.stepLabel = stepLabel;
    this.completedSteps = completedSteps;
  }
}

// ─── NRC quick lookup ─────────────────────────────────────────────────────────
const NRC_NAMES = {
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
  0x81: 'rpmTooHigh',
  0x82: 'rpmTooLow',
  0x83: 'engineIsRunning',
  0x84: 'engineIsNotRunning',
  0x85: 'engineRunTimeTooLow',
  0x86: 'temperatureTooHigh',
  0x87: 'temperatureTooLow',
  0x88: 'vehicleSpeedTooHigh',
  0x89: 'vehicleSpeedTooLow',
  0x8A: 'throttlePedalTooHigh',
  0x8B: 'throttlePedalTooLow',
  0x8C: 'transmissionRangeNotInNeutral',
  0x8D: 'transmissionRangeNotInGear',
  0x8F: 'brakeSwitchNotClosed',
  0x90: 'shifterLeverNotInPark',
  0x91: 'torqueConverterClutchLocked',
  0x92: 'voltageTooHigh',
  0x93: 'voltageTooLow',
  // FCA-specific
  0xA0: 'fcaImmoNotProgrammed',
  0xA1: 'fcaImmoLocked',
  0xA2: 'fcaVinMismatch',
  0xA3: 'fcaSec16Mismatch',
};

export { NRC_NAMES };
