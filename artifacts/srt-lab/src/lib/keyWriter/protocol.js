/* ============================================================================
 * protocol.js — pure framing/parsing for the transponder writer bridge.
 *
 * Frame layout (Xhorse VVDI-Mini style — see docs/key-writer-bridge.md
 * for the publicly-documented reverse-engineering notes this matches):
 *
 *   +----+----+-------+-----+----------+-----+
 *   | 5A | A5 |  LEN  | CMD | PAYLOAD  | CK  |
 *   +----+----+-------+-----+----------+-----+
 *     header   u16 BE   u8     N bytes   u8
 *
 *   LEN = 1 (CMD) + N (PAYLOAD), big-endian.
 *   CK  = XOR over [LEN_HI, LEN_LO, CMD, ...PAYLOAD].
 *
 * Honesty note: this framing matches the most widely-referenced public
 * captures of Xhorse VVDI Mini USB-CDC traffic. It has NOT been verified
 * against a tethered writer in this codebase. Treat it as the scaffolding
 * a bench operator can confirm or correct without rewriting the whole
 * pipeline — the chip-family table, slot serializer, and UI never read
 * the raw frame bytes directly.
 * ========================================================================== */

export const FRAME_HDR = Object.freeze([0x5A, 0xA5]);

export const CMD = Object.freeze({
  PING:           0x01,
  DETECT_CHIP:    0x10,
  READ_UID:       0x11,
  READ_PAGE:      0x12,
  WRITE_PAGE:     0x20,
  BURN_KEY:       0x30,
  VERIFY:         0x31,
  RESET:          0xF0,
  ACK:            0x80,
  NACK:           0x81,
});

export function xorChecksum(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c ^= bytes[i] & 0xFF;
  return c & 0xFF;
}

/** Build a frame for `cmd` carrying `payload` (Uint8Array | number[]). */
export function buildFrame(cmd, payload = new Uint8Array(0)) {
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 0xFF) {
    throw new Error(`buildFrame: cmd out of range: ${cmd}`);
  }
  const pl = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const len = 1 + pl.length;
  if (len > 0xFFFF) throw new Error(`buildFrame: payload too large (${pl.length} B)`);
  const out = new Uint8Array(2 + 2 + 1 + pl.length + 1);
  out[0] = FRAME_HDR[0];
  out[1] = FRAME_HDR[1];
  out[2] = (len >> 8) & 0xFF;
  out[3] = len & 0xFF;
  out[4] = cmd & 0xFF;
  out.set(pl, 5);
  out[out.length - 1] = xorChecksum(out.slice(2, out.length - 1));
  return out;
}

/** Parse a single frame at the start of `bytes`.
 *  Returns { ok:true, frame:{cmd,payload}, consumed } on success,
 *  { ok:false, need:number } when more bytes are required,
 *  or { ok:false, error:string, consumed } when the framing is corrupt. */
export function parseFrame(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 6) return { ok: false, need: 6 - b.length };
  // Resync to header — chew bytes until we find 5A A5 or run out.
  let s = 0;
  while (s + 1 < b.length && !(b[s] === FRAME_HDR[0] && b[s + 1] === FRAME_HDR[1])) s++;
  if (s + 1 >= b.length) {
    return { ok: false, error: 'header not found', consumed: b.length };
  }
  const remaining = b.length - s;
  if (remaining < 6) return { ok: false, need: 6 - remaining };
  const len = (b[s + 2] << 8) | b[s + 3];
  if (len < 1) return { ok: false, error: `invalid len ${len}`, consumed: s + 4 };
  const total = 2 + 2 + len + 1;
  if (remaining < total) return { ok: false, need: total - remaining };
  const cmd = b[s + 4];
  const payload = b.slice(s + 5, s + 5 + (len - 1));
  const ck = b[s + 4 + len];
  const calc = xorChecksum(b.slice(s + 2, s + 4 + len));
  if (ck !== calc) {
    return { ok: false, error: `checksum mismatch (got 0x${ck.toString(16)} calc 0x${calc.toString(16)})`, consumed: s + total };
  }
  return { ok: true, frame: { cmd, payload }, consumed: s + total };
}

/** Stateful chunk reassembler — pushes bytes, yields complete frames. */
export class FrameReader {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), this.buf.length);
    this.buf = merged;
    const out = [];
    // Cap iterations defensively to avoid pathological loops on garbage input.
    for (let i = 0; i < 4096; i++) {
      const r = parseFrame(this.buf);
      if (r.ok) {
        out.push(r.frame);
        this.buf = this.buf.slice(r.consumed);
        if (this.buf.length === 0) break;
      } else if (r.need != null) {
        break; // wait for more bytes
      } else {
        // framing error — drop the consumed bytes and try to resync
        this.buf = this.buf.slice(r.consumed || 1);
        if (this.buf.length === 0) break;
      }
    }
    return out;
  }
  reset() { this.buf = new Uint8Array(0); }
}
