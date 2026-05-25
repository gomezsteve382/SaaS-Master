/**
 * UDS Session Analyzer — trace parser
 *
 * Parses raw trace text into a flat array of line objects with direction,
 * bytes, optional timestamp, and CAN ID.
 *
 * Supported shapes:
 *   1. candump:  (0.000123) can0 7E0#0322F190CCCCCCCC
 *   2. TX/RX:    [0.050] TX 7E0 22 F1 90   |  0.065 RX 7E8 62F190...
 *   3. Req/Resp: [0.000] [Req] 10 03        |  [Resp] 62 F1 90 xx
 *   4. Bare hex: 22 F1 90  (already-assembled UDS — direction inferred from SID)
 *
 * ISO-TP single-frame PCI stripping: applied to candump and TX/RX shapes
 * (which carry raw 8-byte CAN frames). Req/Resp and bare-hex shapes are
 * assumed to carry already-assembled UDS payloads without a PCI byte.
 *
 * Multi-frame FirstFrame (high nibble 0x1) is flagged as isFF=true and
 * passed through without reassembly — the caller surfaces a warning.
 */

import { serviceForPosRsp } from '@workspace/uds';

const RE_CANDUMP = /^\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]{2,})/;
const RE_TX_RX   = /^(?:\[?([\d.]+)\]?\s+)?(TX|RX)\s+(?:0x)?([0-9A-Fa-f]+)\s+((?:[0-9A-Fa-f]{2}\s*)+)/i;
const RE_REQRESP = /^(?:\[?([\d.]+)\]?\s+)?\[(Req|Resp)\]\s+((?:[0-9A-Fa-f]{2}\s*)+)/i;
const RE_BARE    = /^(?:[0-9A-Fa-f]{2}\s+)*[0-9A-Fa-f]{2}\s*$/;

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
 *     shape: 'candump'|'txrx'|'reqresp'|'bare',
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
  const formatCounts = { candump: 0, txrx: 0, reqresp: 0, bare: 0 };

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;

    let m;

    m = RE_CANDUMP.exec(line);
    if (m) {
      const ts = parseFloat(m[1]);
      const canId = parseInt(m[2], 16);
      const rawBytes = parseHex(m[3]);
      const { bytes, isFF, isCF } = stripIsoTpPci(rawBytes);
      if (!bytes.length) continue;
      const dir = inferDirection(bytes);
      lines.push({ dir, bytes, ts, canId, isFF, isCF, shape: 'candump', raw: line });
      formatCounts.candump++;
      continue;
    }

    m = RE_TX_RX.exec(line);
    if (m) {
      const ts = m[1] ? parseFloat(m[1]) : undefined;
      const dir = m[2].toUpperCase() === 'TX' ? 'req' : 'resp';
      const canId = parseInt(m[3], 16);
      const rawBytes = parseHex(m[4]);
      const { bytes, isFF, isCF } = stripIsoTpPci(rawBytes);
      if (!bytes.length) continue;
      lines.push({ dir, bytes, ts, canId, isFF, isCF, shape: 'txrx', raw: line });
      formatCounts.txrx++;
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

    if (RE_BARE.test(line)) {
      const bytes = parseHex(line);
      if (!bytes.length) continue;
      const dir = inferDirection(bytes);
      lines.push({ dir, bytes, ts: undefined, isFF: false, isCF: false, shape: 'bare', raw: line });
      formatCounts.bare++;
      continue;
    }
  }

  const dominant = Object.entries(formatCounts)
    .sort((a, b) => b[1] - a[1])[0];
  const formatDetected = dominant && dominant[1] > 0 ? dominant[0] : 'unknown';

  return { lines, messageCount: lines.length, formatDetected, formatCounts };
}
