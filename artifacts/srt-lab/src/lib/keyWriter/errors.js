/* ============================================================================
 * errors.js — error-code → human label for the key writer bridge.
 *
 * The codes mirror the publicly-documented Xhorse VVDI Mini error byte
 * surface (chip-not-detected / lock-bit-set / verify-mismatch / …). On
 * receive, the framing layer surfaces the raw byte; this table gives
 * the UI a stable string to render.
 * ========================================================================== */

export const WRITER_ERRORS = {
  0x00: { label: 'OK', detail: 'Operation completed.' },
  0x01: { label: 'NO_CHIP',           detail: 'No transponder detected on the writer coil. Place chip and retry.' },
  0x02: { label: 'WRONG_CHIP',        detail: 'Detected chip family does not match the requested family.' },
  0x03: { label: 'LOCKED',            detail: 'Chip is locked (lock bit set). VVDI Mini cannot rewrite a locked HITAG2 page.' },
  0x04: { label: 'VERIFY_FAIL',       detail: 'Read-back after write did not match the requested bytes.' },
  0x05: { label: 'AUTH_FAIL',         detail: 'Crypto authentication against the chip failed (wrong password / key).' },
  0x06: { label: 'BAD_PAYLOAD',       detail: 'Payload length or shape does not match the chip family.' },
  0x07: { label: 'UNSUPPORTED',       detail: 'Writer firmware does not implement the requested command.' },
  0x08: { label: 'TIMEOUT',           detail: 'Writer did not respond inside the expected window.' },
  0x09: { label: 'COIL_OVERCURRENT',  detail: 'Writer coil tripped overcurrent — usually a chip seated wrong.' },
  0xFE: { label: 'SIM_FAULT',         detail: 'Simulator injected fault (dry-run only).' },
  0xFF: { label: 'UNKNOWN',           detail: 'Writer returned an unknown error code.' },
};

export function describeError(code) {
  return WRITER_ERRORS[code] || { label: `ERR_0x${code.toString(16).toUpperCase().padStart(2,'0')}`, detail: 'Undocumented writer error.' };
}
