/**
 * candump log format parser and writer.
 *
 * Supports the canonical Linux candump line formats produced by
 * `candump -L` (logfile mode) and the bracketed pretty form. Cleanly
 * re-implemented (no `reversegear` vendoring) so the GPLv3 obligations
 * of the original tool stay in their own corner.
 *
 * Recognised line shapes:
 *   (1234.567890) can0 7E0#0322F19000000000
 *   (1234.567890) can0 18DAF110#02 1A 90
 *   (1234.567890) can0 7E0#R          (Remote Transmission Request)
 *   (1234.567890) can0 7E0#R8         (RTR with explicit DLC)
 *   (1234.567890) can0 7E0##10DEADBEEF (CAN-FD: ## then flags nibble + data)
 *   (1234.567890) can0 7E0   [8]  03 22 F1 90 00 00 00 00
 *   1234.567890 can0 7E0#03 22 F1 90  (no parentheses, single space ts)
 */

/** A single parsed CAN frame from a candump log. */
export interface CandumpFrame {
  /** Capture timestamp in seconds (may be fractional with µs precision). */
  ts: number;
  /** Interface name as recorded (e.g. `can0`, `vcan1`, `slcan0`). */
  iface: string;
  /** CAN arbitration ID (raw — 11-bit ≤ 0x7FF or 29-bit ≤ 0x1FFFFFFF). */
  id: number;
  /** True when the ID is a 29-bit extended identifier. */
  ext: boolean;
  /** True for CAN-FD frames (## separator). */
  fd: boolean;
  /** True for Remote Transmission Request frames (#R…). */
  rtr: boolean;
  /** Frame data bytes (empty for RTR). */
  data: Uint8Array;
  /** CAN-FD flags nibble (BRS/ESI), null on classic CAN. */
  fdFlags: number | null;
  /** RTR DLC byte when the source line specified one (`#R8`). */
  rtrDlc?: number | null;
  /** Source line number (1-based) when parsed from a multi-line log. */
  line?: number;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

function hexBytes(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  if (!HEX_RE.test(clean) || (clean.length & 1) !== 0) {
    throw new Error(`candump: invalid hex payload "${s}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function parseId(raw: string): { id: number; ext: boolean } {
  if (!HEX_RE.test(raw)) throw new Error(`candump: invalid CAN ID "${raw}"`);
  const id = parseInt(raw, 16);
  // SocketCAN's `candump -L` writes a left-padded 8-digit ID for 29-bit
  // frames, and 3 digits for 11-bit. We treat any > 0x7FF as extended,
  // and also honour an 8-character literal width as an explicit 29-bit
  // marker (covers IDs like 0x00000123 which technically fit in 11 bits
  // but were captured on an extended-only segment).
  const ext = id > 0x7FF || raw.length === 8;
  return { id, ext };
}

/**
 * Parse a single candump log line. Returns null for blank or comment lines
 * (`#` at column 0). Throws on malformed payloads or IDs.
 */
export function parseCandumpLine(line: string, lineNumber?: number): CandumpFrame | null {
  const raw = line.replace(/\r$/, '');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Timestamp: either (1234.567890) or bare 1234.567890 .
  let rest = trimmed;
  let ts = 0;
  const parenMatch = rest.match(/^\((\d+(?:\.\d+)?)\)\s+(.*)$/);
  if (parenMatch) {
    ts = parseFloat(parenMatch[1]);
    rest = parenMatch[2];
  } else {
    const bareMatch = rest.match(/^(\d+\.\d+)\s+(.*)$/);
    if (bareMatch) {
      ts = parseFloat(bareMatch[1]);
      rest = bareMatch[2];
    }
  }

  // Interface token (everything up to the next whitespace).
  const ifMatch = rest.match(/^(\S+)\s+(.*)$/);
  if (!ifMatch) throw new Error(`candump: missing interface in "${raw}"`);
  const iface = ifMatch[1];
  rest = ifMatch[2];

  // Two body shapes:
  //   <ID>#<payload>           — compact log form
  //   <ID>   [<dlc>]  <bytes>  — bracketed pretty form
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    const idPart = rest.slice(0, hashIdx).trim();
    let body = rest.slice(hashIdx + 1);
    let fd = false;
    if (body.startsWith('#')) { fd = true; body = body.slice(1); }
    body = body.trimEnd();

    const { id, ext } = parseId(idPart);

    if (body.startsWith('R')) {
      // RTR (no payload). Optional DLC byte follows (`#R8`); preserve it
      // so write-back round-trips byte-for-byte.
      const dlcStr = body.slice(1).trim();
      let rtrDlc: number | null = null;
      if (dlcStr.length) {
        const n = parseInt(dlcStr, 10);
        if (!Number.isFinite(n) || n < 0 || n > 15) throw new Error(`candump: invalid RTR DLC "${dlcStr}"`);
        rtrDlc = n;
      }
      return { ts, iface, id, ext, fd: false, rtr: true, data: new Uint8Array(0), fdFlags: null, rtrDlc, line: lineNumber };
    }

    let fdFlags: number | null = null;
    if (fd && body.length >= 1) {
      fdFlags = parseInt(body.charAt(0), 16);
      if (Number.isNaN(fdFlags)) throw new Error(`candump: invalid CAN-FD flag nibble in "${raw}"`);
      body = body.slice(1);
    }

    const data = body.length ? hexBytes(body) : new Uint8Array(0);
    return { ts, iface, id, ext, fd, rtr: false, data, fdFlags, line: lineNumber };
  }

  const bracket = rest.match(/^(\S+)\s+\[(\d+)\]\s*(.*)$/);
  if (bracket) {
    const { id, ext } = parseId(bracket[1]);
    const dlc = parseInt(bracket[2], 10);
    const payload = bracket[3].trim();
    let data: Uint8Array;
    if (!payload) data = new Uint8Array(0);
    else {
      const tokens = payload.split(/\s+/);
      data = new Uint8Array(tokens.length);
      for (let i = 0; i < tokens.length; i++) {
        if (!HEX_RE.test(tokens[i]) || tokens[i].length !== 2) {
          throw new Error(`candump: invalid bracket-form byte "${tokens[i]}" in "${raw}"`);
        }
        data[i] = parseInt(tokens[i], 16);
      }
    }
    if (data.length !== dlc) {
      // Some tools ship trailing padding past the declared DLC; honour the
      // DLC field as authoritative so callers see the same byte count the
      // recorder thought it captured.
      const trimmedData = new Uint8Array(dlc);
      trimmedData.set(data.subarray(0, dlc));
      data = trimmedData;
    }
    return { ts, iface, id, ext, fd: false, rtr: false, data, fdFlags: null, line: lineNumber };
  }

  throw new Error(`candump: unrecognised line "${raw}"`);
}

/** Parse an entire candump log (string of lines). Skips blanks/comments. */
export function parseCandumpLog(text: string): CandumpFrame[] {
  const out: CandumpFrame[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const f = parseCandumpLine(lines[i], i + 1);
    if (f) out.push(f);
  }
  return out;
}

function fmtTs(ts: number): string {
  // candump -L prints six fractional digits (microseconds).
  if (!Number.isFinite(ts) || ts < 0) ts = 0;
  const s = ts.toFixed(6);
  return s;
}

function fmtId(id: number, ext: boolean): string {
  const upper = id.toString(16).toUpperCase();
  if (ext) return upper.padStart(8, '0');
  return upper.padStart(3, '0');
}

function fmtData(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i++) s += data[i].toString(16).toUpperCase().padStart(2, '0');
  return s;
}

/** Format a single frame as a canonical compact `(ts) iface ID#PAYLOAD` line. */
export function writeCandumpLine(f: CandumpFrame): string {
  const ts = `(${fmtTs(f.ts)})`;
  const id = fmtId(f.id, f.ext);
  if (f.rtr) return `${ts} ${f.iface} ${id}#R${f.rtrDlc != null ? f.rtrDlc.toString(10) : ''}`;
  if (f.fd) {
    const flags = (f.fdFlags ?? 0).toString(16).toUpperCase();
    return `${ts} ${f.iface} ${id}##${flags}${fmtData(f.data)}`;
  }
  return `${ts} ${f.iface} ${id}#${fmtData(f.data)}`;
}

/** Format an array of frames as a candump log (newline-terminated). */
export function writeCandumpLog(frames: readonly CandumpFrame[]): string {
  return frames.map(writeCandumpLine).join('\n') + (frames.length ? '\n' : '');
}

// ── Per-ID stats ──────────────────────────────────────────────────────

export interface IdStat {
  id: number;
  ext: boolean;
  count: number;
  firstTs: number;
  lastTs: number;
  /** Mean inter-arrival time in seconds (0 if count < 2). */
  meanDt: number;
  /** Length histogram: index = byte length, value = number of frames. */
  lengthHistogram: number[];
  /** The most recent payload observed for this ID (sample for the UI). */
  sample: Uint8Array;
}

/** Compute per-CAN-ID statistics over a frame stream. */
export function idStats(frames: readonly CandumpFrame[]): IdStat[] {
  const map = new Map<string, IdStat>();
  for (const f of frames) {
    const key = `${f.ext ? '1' : '0'}:${f.id.toString(16)}`;
    let s = map.get(key);
    if (!s) {
      s = {
        id: f.id, ext: f.ext, count: 0,
        firstTs: f.ts, lastTs: f.ts, meanDt: 0,
        lengthHistogram: [], sample: f.data,
      };
      map.set(key, s);
    }
    s.count++;
    s.lastTs = f.ts;
    s.sample = f.data;
    const len = f.data.length;
    while (s.lengthHistogram.length <= len) s.lengthHistogram.push(0);
    s.lengthHistogram[len]++;
  }
  for (const s of map.values()) {
    s.meanDt = s.count > 1 ? (s.lastTs - s.firstTs) / (s.count - 1) : 0;
  }
  return Array.from(map.values()).sort((a, b) => a.id - b.id);
}

// ── iddiff ────────────────────────────────────────────────────────────

export interface IddiffEntry {
  id: number;
  ext: boolean;
  countA: number;
  countB: number;
}

export interface IddiffResult {
  onlyInA: IddiffEntry[];
  onlyInB: IddiffEntry[];
  common: IddiffEntry[];
}

/** Compare two frame streams; classify each ID as A-only, B-only, or common. */
export function iddiff(a: readonly CandumpFrame[], b: readonly CandumpFrame[]): IddiffResult {
  const counts = new Map<string, IddiffEntry>();
  const bump = (frames: readonly CandumpFrame[], side: 'A' | 'B') => {
    for (const f of frames) {
      const key = `${f.ext ? '1' : '0'}:${f.id.toString(16)}`;
      let e = counts.get(key);
      if (!e) { e = { id: f.id, ext: f.ext, countA: 0, countB: 0 }; counts.set(key, e); }
      if (side === 'A') e.countA++; else e.countB++;
    }
  };
  bump(a, 'A');
  bump(b, 'B');
  const onlyInA: IddiffEntry[] = [];
  const onlyInB: IddiffEntry[] = [];
  const common: IddiffEntry[] = [];
  for (const e of counts.values()) {
    if (e.countA && !e.countB) onlyInA.push(e);
    else if (e.countB && !e.countA) onlyInB.push(e);
    else common.push(e);
  }
  const cmp = (x: IddiffEntry, y: IddiffEntry) => x.id - y.id;
  return { onlyInA: onlyInA.sort(cmp), onlyInB: onlyInB.sort(cmp), common: common.sort(cmp) };
}
