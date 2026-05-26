/**
 * UDS Session Analyzer — trace parser
 *
 * Parses raw trace text into a flat array of line objects with direction,
 * bytes, optional timestamp, and CAN ID.
 *
 * Supported shapes:
 *   5. canraw:   18DA40F1 03 22 F1 90  (raw CAN id-first, no # separator, optional leading
 *                                       timestamp like 12.345 18DA40F1 03 22 F1 90)
 *      (id then raw 8-byte CAN frame, no TX/RX keyword, no # separator;
 *       direction inferred from SID like bare hex)
 *
 * ISO-TP single-frame PCI stripping: applied to candump and TX/RX shapes
 * (which carry raw 8-byte CAN frames). Req/Resp and bare-hex shapes are
 * assumed to carry already-assembled UDS payloads without a PCI byte.
 *
 * Multi-frame (FF + CF) sequences in candump and TX/RX shapes are
 * reassembled per (shape, dir, canId) stream via @workspace/uds
 * IsoTpReceiver. When a stream completes, a single line containing the
 * full UDS payload is emitted at the position of the last frame.
 * Flow-control (FC) frames are dropped silently. Incomplete sequences
 * (FF without enough CFs, orphan CFs, out-of-order CFs) fall back to the
 * existing isFF/isCF warning surface in analyzeSession.
 */

import { serviceForPosRsp, frameType, IsoTpReceiver } from '@workspace/uds';

const RE_CANDUMP = /^\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]{2,})/;
const RE_TX_RX   = /^(?:\[?([\d.]+)\]?\s+)?(TX|RX)\s+(?:0x)?([0-9A-Fa-f]+)\s+((?:[0-9A-Fa-f]{2}\s*)+)/i;
const RE_REQRESP = /^(?:\[?([\d.]+)\]?\s+)?\[(Req|Resp)\]\s+((?:[0-9A-Fa-f]{2}\s*)+)/i;
const RE_BARE    = /^(?:[0-9A-Fa-f]{2}\s+)*[0-9A-Fa-f]{2}\s*$/;
// canraw: optional timestamp, then a 3–8 hex-char CAN id, then one or more
// hex byte pairs. The 3–8 char first token is the discriminator that keeps
// this regex from swallowing bare-hex lines (whose tokens are all 2 chars).
const RE_CANRAW  = /^(?:\[?([\d.]+)\]?\s+)?([0-9A-Fa-f]{3,8})\s+((?:[0-9A-Fa-f]{2}\s+)*[0-9A-Fa-f]{2})\s*$/;

function parseHex(str) {
  const clean = str.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function stripIsoTpPci(bytes) {
  if (!bytes.length) return { bytes, isFF: false, isCF: false };
  const hi = (bytes[0] >> 4) & 0x0F;
  if (hi === 0) {
    const len = bytes[0] & 0x0F;
    if (len > 0 && len <= 7 && bytes.length >= 1 + len) {
      return { bytes: bytes.slice(1, 1 + len), isFF: false, isCF: false };
    }
  } else if (hi === 1) {
    return { bytes: bytes.slice(2), isFF: true, isCF: false };
  } else if (hi === 2) {
    return { bytes: bytes.slice(1), isFF: false, isCF: true };
  }
  return { bytes, isFF: false, isCF: false };
}

function inferDirection(bytes) {
  if (!bytes.length) return 'unknown';
  const first = bytes[0];
  if (first === 0x7F) return 'resp';
  if (first >= 0x50 && serviceForPosRsp(first)) return 'resp';
  return 'req';
}

function streamKey(shape, dir, canId) {
  return `${shape}|${dir ?? 'auto'}|${canId ?? '?'}`;
}

/**
 * Handle a raw 8-byte CAN frame from candump or TX/RX shapes, applying
 * ISO-TP reassembly via per-stream IsoTpReceiver state.
 *
 * Emits lines into `lines` (and increments formatCounts[ctx.shape]) when:
 *   - a Single Frame arrives          → emits PCI-stripped line immediately
 *   - a Consecutive Frame completes a buffered FF → emits one reassembled line
 *   - an orphan CF arrives (no FF)    → emits an isCF=true warning line
 *   - a malformed FF or out-of-order CF is encountered → emits warning line
 *
 * Buffers FF + in-progress CFs silently; flushIncompleteStreams() emits
 * a single isFF=true warning line per stream still open at end of trace.
 */
function processRawFrame(rawBytes, ctx, lines, formatCounts, rxStreams) {
  if (!rawBytes.length) return;
  const ft = frameType(rawBytes[0]);

  if (ft === 'FC') {
    // Flow-control frames carry no UDS payload; ignored for analysis.
    return;
  }

  if (ft === 'FF') {
    const key = streamKey(ctx.shape, ctx.dir, ctx.canId);
    const existing = rxStreams.get(key);
    if (existing) {
      // Previous FF on this stream never completed — surface it now.
      flushIncompleteStream(existing, lines, formatCounts);
      rxStreams.delete(key);
    }
    const receiver = new IsoTpReceiver();
    try {
      const result = receiver.push(rawBytes);
      if (result.done && result.payload) {
        // Shouldn't normally happen for an FF, but tolerate it.
        emitReassembled(result.payload, ctx, lines, formatCounts);
        return;
      }
    } catch {
      // Malformed FF — emit as isFF=true warning line via existing path.
      emitWithStrip(rawBytes, ctx, lines, formatCounts);
      return;
    }
    rxStreams.set(key, { receiver, ctx, rawBytes });
    return;
  }

  if (ft === 'CF') {
    const key = streamKey(ctx.shape, ctx.dir, ctx.canId);
    const stream = rxStreams.get(key);
    if (!stream) {
      // Orphan CF — preserve the isCF=true warning behaviour.
      emitWithStrip(rawBytes, ctx, lines, formatCounts);
      return;
    }
    try {
      const result = stream.receiver.push(rawBytes);
      if (result.done && result.payload) {
        emitReassembled(result.payload, stream.ctx, lines, formatCounts);
        rxStreams.delete(key);
      }
    } catch {
      // Out-of-order CF or other error — surface the buffered FF as a
      // warning placeholder and drop the stream.
      flushIncompleteStream(stream, lines, formatCounts);
      rxStreams.delete(key);
    }
    return;
  }

  // SF or 'unknown' → existing pass-through behaviour.
  emitWithStrip(rawBytes, ctx, lines, formatCounts);
}

function emitWithStrip(rawBytes, ctx, lines, formatCounts) {
  const { bytes, isFF, isCF } = stripIsoTpPci(rawBytes);
  if (!bytes.length) return;
  const dir = ctx.dir ?? inferDirection(bytes);
  lines.push({
    dir, bytes,
    ts: ctx.ts, canId: ctx.canId,
    isFF, isCF,
    shape: ctx.shape, raw: ctx.raw,
  });
  formatCounts[ctx.shape]++;
}

function emitReassembled(payload, ctx, lines, formatCounts) {
  const bytes = Array.from(payload);
  if (!bytes.length) return;
  const dir = ctx.dir ?? inferDirection(bytes);
  lines.push({
    dir, bytes,
    ts: ctx.ts, canId: ctx.canId,
    isFF: false, isCF: false,
    shape: ctx.shape, raw: ctx.raw,
  });
  formatCounts[ctx.shape]++;
}

function flushIncompleteStream(stream, lines, formatCounts) {
  // The buffered FF never received enough CFs to complete. Surface it as
  // an isFF=true line so analyzeSession's existing multi-frame warning
  // fires for the (now-known-incomplete) sequence.
  const { bytes } = stripIsoTpPci(stream.rawBytes);
  if (!bytes.length) return;
  const dir = stream.ctx.dir ?? inferDirection(bytes);
  lines.push({
    dir, bytes,
    ts: stream.ctx.ts, canId: stream.ctx.canId,
    isFF: true, isCF: false,
    shape: stream.ctx.shape, raw: stream.ctx.raw,
  });
  formatCounts[stream.ctx.shape]++;
}

/**
 * Parse a raw trace string into an array of line objects.
 *
 * @param {string} text  Raw paste or file content.
 * @returns {{
 *   lines: Array<{
 *     dir: 'req'|'resp'|'unknown',
 *     bytes: number[],
 *     ts?: number,
 *     canId?: number,
 *     isFF: boolean,
 *     isCF: boolean,
 *     shape: 'candump'|'txrx'|'reqresp'|'bare'|'canraw',
 *     raw: string,
 *   }>,
 *   messageCount: number,
 *   formatDetected: string,
 *   formatCounts: Record<string,number>,
 * }}
 */
export function parseTrace(text) {
  if (!text || !text.trim()) {
    return { lines: [], messageCount: 0, formatDetected: 'none', formatCounts: {} };
  }

  const rawLines = text.split(/\r?\n/);
  const lines = [];
  const formatCounts = { candump: 0, txrx: 0, reqresp: 0, bare: 0, canraw: 0 };
  const rxStreams = new Map();

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;

    let m;

    m = RE_CANDUMP.exec(line);
    if (m) {
      const ts = parseFloat(m[1]);
      const canId = parseInt(m[2], 16);
      const rawBytes = parseHex(m[3]);
      processRawFrame(
        rawBytes,
        { shape: 'candump', ts, canId, dir: null, raw: line },
        lines, formatCounts, rxStreams,
      );
      continue;
    }

    m = RE_TX_RX.exec(line);
    if (m) {
      const ts = m[1] ? parseFloat(m[1]) : undefined;
      const dir = m[2].toUpperCase() === 'TX' ? 'req' : 'resp';
      const canId = parseInt(m[3], 16);
      const rawBytes = parseHex(m[4]);
      processRawFrame(
        rawBytes,
        { shape: 'txrx', ts, canId, dir, raw: line },
        lines, formatCounts, rxStreams,
      );
      continue;
    }

    m = RE_REQRESP.exec(line);
    if (m) {
      const ts = m[1] ? parseFloat(m[1]) : undefined;
      const dir = m[2].toLowerCase() === 'req' ? 'req' : 'resp';
      const bytes = parseHex(m[3]);
      if (!bytes.length) continue;
      lines.push({ dir, bytes, ts, isFF: false, isCF: false, shape: 'reqresp', raw: line });
      formatCounts.reqresp++;
      continue;
    }

    m = RE_CANRAW.exec(line);
    if (m) {
      const ts = m[1] ? parseFloat(m[1]) : undefined;
      const canId = parseInt(m[2], 16);
      const rawBytes = parseHex(m[3]);
      processRawFrame(
        rawBytes,
        { shape: 'canraw', ts, canId, dir: null, raw: line },
        lines, formatCounts, rxStreams,
      );
      continue;
    }

    if (RE_BARE.test(line)) {
      const bytes = parseHex(line);
      if (!bytes.length) continue;
      const dir = inferDirection(bytes);
      lines.push({ dir, bytes, ts: undefined, isFF: false, isCF: false, shape: 'bare', raw: line });
      formatCounts.bare++;
      continue;
    }
  }

  // Any streams still open at end of trace are incomplete; surface each
  // as a single isFF=true warning placeholder.
  for (const stream of rxStreams.values()) {
    flushIncompleteStream(stream, lines, formatCounts);
  }
  rxStreams.clear();

  const dominant = Object.entries(formatCounts)
    .sort((a, b) => b[1] - a[1])[0];
  const formatDetected = dominant && dominant[1] > 0 ? dominant[0] : 'unknown';

  return { lines, messageCount: lines.length, formatDetected, formatCounts };
}

// Internal helper exported for testing only.
export const __testing = { processRawFrame, streamKey };
