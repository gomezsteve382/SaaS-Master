/* ============================================================================
 * donorLeakScan.js — browser-safe extraction of the anonymizer's whole-buffer
 * leak scanner.
 *
 * Task #447 wires the same scanner the helper script
 * (`scripts/anonymize-real-dump.mjs`) uses for committed fixtures into a
 * one-shot pre-share check on the user-facing module backup/export flow.
 * Both call sites — the Node CLI and the React UI — must stay byte-for-byte
 * in agreement about what counts as a leak, so the scanner lives here as a
 * pure-JS module with zero `node:` imports. The script re-exports these
 * symbols so existing tests (and its CLI) keep working unchanged; importing
 * from `../scripts/anonymize-real-dump.mjs` from a Vite-bundled file would
 * fail at module load (it pulls in `node:fs`, `node:path`, `node:url` for
 * its CLI).
 *
 * Public API:
 *   - getDocumentedSlotWindows(moduleType)
 *       → array of { kind, offset, length } describing the parser-recognised
 *         VIN slot windows the donor-tail mask should ignore. Used by the
 *         second-pass scan so a legitimate in-slot byte that happens to
 *         match the donor tail does not generate a false positive.
 *
 *   - scanBufferForDonorLeak({ buffer, donorVin, moduleType, slotWindows })
 *       → null when no donor leak is detected, or
 *         { kind, offset, donorVin, message, ... } describing the FIRST
 *         leak hit. `kind` is one of:
 *           'donor-vin-forward'    — donor VIN appears verbatim
 *           'donor-vin-reversed'   — donor VIN appears byte-reversed
 *           'donor-tail-forward'   — donor's last-6 serial appears outside
 *                                    documented slot windows
 *           'donor-tail-reversed'  — same, byte-reversed
 *
 * The slot-windows table here is the single source of truth for both the
 * helper script and the UI. Adding a new documented slot to a parser
 * means updating it here in exactly one place.
 * ============================================================================ */

export const VIN_LEN = 17;

// Documented VIN slot offsets per module type. Single source of truth; if a
// new slot is ever added to the parser/writer, mirror it here so the scrub
// helper AND the in-app pre-share scanner continue to cover every documented
// location.
export const BCM_FULL_VIN_BASES      = [0x5300, 0x5320, 0x5340, 0x5360, 0x5380];
export const BCM_PARTIAL_VIN_OFFSETS = [0x4098, 0x40B0];
export const RFH_GEN2_VIN_OFFSETS    = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
export const PCM_VIN_OFFSETS         = [0x0000, 0x01F0, 0x0224, 0x0CE0];

export const SUPPORTED_MODULE_TYPES = ['bcm', 'rfhub', 'pcm'];

// ─────────────────────────────────────────────────────────────────────────────
// Small byte helpers — local, not pulled from parser code, so this module
// has no dependency surface a future parser refactor could break.
// ─────────────────────────────────────────────────────────────────────────────

export function vinAsBytes(vin) {
  const out = new Uint8Array(vin.length);
  for (let i = 0; i < vin.length; i++) out[i] = vin.charCodeAt(i);
  return out;
}

export function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

export function findBytes(buf, needle) {
  if (needle.length === 0 || needle.length > buf.length) return -1;
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function fmtOff(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function getDocumentedSlotWindows(moduleType) {
  const mt = String(moduleType || '').toLowerCase();
  const windows = [];
  if (mt === 'bcm') {
    for (const base of BCM_FULL_VIN_BASES) {
      windows.push({ kind: 'bcm-full-base+0', offset: base,     length: VIN_LEN });
      windows.push({ kind: 'bcm-full-base+8', offset: base + 8, length: VIN_LEN });
    }
    for (const po of BCM_PARTIAL_VIN_OFFSETS) {
      windows.push({ kind: 'bcm-partial', offset: po, length: 8 });
    }
  } else if (mt === 'rfhub') {
    for (const off of RFH_GEN2_VIN_OFFSETS) {
      windows.push({ kind: 'rfh-rev-vin', offset: off, length: VIN_LEN });
    }
  } else if (mt === 'pcm') {
    for (const off of PCM_VIN_OFFSETS) {
      windows.push({ kind: 'pcm-full', offset: off, length: VIN_LEN });
    }
  } else {
    throw new Error(
      `unsupported module type '${moduleType}' (expected one of: ${SUPPORTED_MODULE_TYPES.join(', ')})`
    );
  }
  return windows;
}

export function scanBufferForDonorLeak({ buffer, donorVin, moduleType, slotWindows }) {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error('buffer must be a Uint8Array');
  }
  if (typeof donorVin !== 'string' || donorVin.length !== VIN_LEN) {
    throw new Error(
      `donorVin must be a 17-character string (got ${donorVin == null ? 'null' : `'${donorVin}' (${donorVin.length} chars)`})`
    );
  }
  const donorUpper = donorVin.toUpperCase();
  const windows = Array.isArray(slotWindows)
    ? slotWindows
    : getDocumentedSlotWindows(moduleType);

  // 1. Donor VIN must not appear forward or byte-reversed anywhere.
  const donorFwd = vinAsBytes(donorUpper);
  const donorRev = reverseBytes(donorFwd);
  const fwdAt = findBytes(buffer, donorFwd);
  if (fwdAt !== -1) {
    return {
      kind: 'donor-vin-forward',
      offset: fwdAt,
      donorVin: donorUpper,
      message:
        `donor VIN '${donorUpper}' still appears forward at offset ${fmtOff(fwdAt)}. ` +
        `The scrubber doesn't know about a VIN slot at that location — please scrub manually and ` +
        `consider extending the slot table in this script.`,
    };
  }
  const revAt = findBytes(buffer, donorRev);
  if (revAt !== -1) {
    return {
      kind: 'donor-vin-reversed',
      offset: revAt,
      donorVin: donorUpper,
      message:
        `donor VIN '${donorUpper}' still appears byte-reversed at offset ${fmtOff(revAt)}. ` +
        `The scrubber doesn't know about a reversed-VIN slot at that location — please scrub manually.`,
    };
  }

  // 2. Donor's last-6 serial must not appear outside the documented slot
  //    windows. Mask the windows we know about so legitimate in-slot bytes
  //    (which may contain an anon VIN whose own tail might collide with
  //    the donor's tail in a worst case) cannot generate false positives.
  //    Sentinel 0x00 is safe here: every donor tail is ASCII alphanumeric
  //    (0x30..0x5A), so the masked region cannot spuriously match a tail.
  const masked = new Uint8Array(buffer);
  for (const s of windows) {
    const end = Math.min(s.offset + s.length, masked.length);
    for (let i = s.offset; i < end; i++) masked[i] = 0x00;
  }
  const tail = donorUpper.slice(-6);
  const tailFwd = vinAsBytes(tail);
  const tailRev = reverseBytes(tailFwd);
  const tFwdAt = findBytes(masked, tailFwd);
  if (tFwdAt !== -1) {
    return {
      kind: 'donor-tail-forward',
      offset: tFwdAt,
      donorVin: donorUpper,
      tail,
      message:
        `donor VIN tail '${tail}' (last 6 of '${donorUpper}') survived at offset ` +
        `${fmtOff(tFwdAt)} OUTSIDE the documented VIN slot windows. Common offender on BCM dumps: ` +
        `the partial-VIN records at 0x4098 / 0x40B0 — but if those were scrubbed and this still ` +
        `fires, the donor's serial is leaking from a part-number / audit field this scrubber ` +
        `doesn't yet know about. Hand-scrub that location and re-run.`,
    };
  }
  const tRevAt = findBytes(masked, tailRev);
  if (tRevAt !== -1) {
    return {
      kind: 'donor-tail-reversed',
      offset: tRevAt,
      donorVin: donorUpper,
      tail,
      message:
        `donor VIN tail '${tail}' (byte-reversed) survived at offset ` +
        `${fmtOff(tRevAt)} OUTSIDE the documented VIN slot windows.`,
    };
  }

  return null;
}
