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
 *         match the donor tail does not generate a false positive. The
 *         BCM partial-VIN entry stays at the always-known registered
 *         offsets (`BCM_PARTIAL_VIN_OFFSETS`) — the helper auto-detects
 *         additional partial-VIN slots in the buffer it just scrubbed and
 *         passes that combined list as an explicit `slotWindows` to the
 *         post-scrub leak scan; the default mask deliberately stays narrow
 *         so the pre-share UI can still flag a donor-tail leak at a
 *         non-registered partial-VIN slot in a not-yet-scrubbed buffer.
 *
 *   - findBcmPartialVinSlots(buffer)
 *       → array of { offset, tail, storedCrc, calcCrc, crcOk: true, length: 8 }
 *         for every position in `buffer` where 8 VIN-character bytes are
 *         followed by a big-endian CRC16 that matches the bytes. The CRC16
 *         + tight VIN-character filter make false positives essentially
 *         impossible (~1/65536 × (33/256)^8 per random position, ≈ 0
 *         expected hits in a virgin 64 KB BCM). The single source of truth
 *         for "what looks like a partial-VIN slot" — used by the helper
 *         (to scrub every detected slot, not just the hard-coded two), the
 *         parser (to surface variant slots in `info.partialVins`), and the
 *         leak scanner (to extend the slot-window mask).
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
 * means updating it here in exactly one place — for partial-VIN slots,
 * auto-detection from the buffer means a NEW variant offset doesn't even
 * need a code change (Task #452).
 * ============================================================================ */

import { crc16 } from './crc.js';

export const VIN_LEN = 17;

// Documented VIN slot offsets per module type. Single source of truth; if a
// new slot is ever added to the parser/writer, mirror it here so the scrub
// helper AND the in-app pre-share scanner continue to cover every documented
// location. Note: `BCM_PARTIAL_VIN_OFFSETS` is the always-known fallback list
// used when a buffer is unavailable (e.g. fixture-builder code) or virgin
// (so partial slots don't yet carry a valid CRC). Real captures get the
// auto-detected union via `findBcmPartialVinSlots(buffer)` — adding a brand-
// new variant offset that already carries a valid CRC needs no edits.
export const BCM_FULL_VIN_BASES      = [0x5300, 0x5320, 0x5340, 0x5360, 0x5380];
export const BCM_PARTIAL_VIN_OFFSETS = [0x4098, 0x40B0];
export const BCM_PARTIAL_VIN_LEN     = 8;
export const RFH_GEN2_VIN_OFFSETS    = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
export const PCM_VIN_OFFSETS         = [0x0000, 0x01F0, 0x0224, 0x0CE0];
// Task #441 — additional families wired through the helper script's
// `SCRUBBERS_BY_TYPE` dispatch map. Mirrored here so the UI pre-share
// scanner and the script's `scanBufferForDonorLeak` share the same
// documented-slot table for masking.
//   - RFH_GEN1_VIN_OFFSET: single plain-VIN slot at 0x92 on Gen1
//     RFHUB (24C16, 2 KB Yazaki FCM EEPROM); BE16 CRC at +17/+18.
//   - EEP95640_VIN_OFFSETS: 3 plaintext VIN slots in a 95640 BCM-backup
//     EEPROM dump (8 KB), no CRC.
export const RFH_GEN1_VIN_OFFSET     = 0x92;
export const EEP95640_VIN_OFFSETS    = [0x275, 0x288, 0x1B82];

// Task #457 — SGW (Secure Gateway, CAN id 0x74F req / 0x76F resp on
// 2018+ FCA) carries an EMPTY slot table BY DESIGN, not as a placeholder.
// **No VIN slot — confirmed by bench trace on dump X = the cracked OEM
// Chrysler diagnostic SWF (`attached_assets/CDA_1776448059516.swf`).**
// The bench trace is automated in
// `src/lib/__tests__/cdaSwfSgwBenchTrace.test.js`: it asserts the SGW
// authentication / status / timeout API surface IS present in the
// 8.7 MB inflated AS3 body (proves we're inspecting the SGW-aware OEM
// tool, not some unrelated SWF) and asserts the SGW VIN read/write API
// surface is ABSENT across 17 naming-convention variants plus the F190
// UDS DID. The full rationale, evidence, and revisit procedure live in
// `docs/SGW_VIN_STORAGE.md` §0; corroborating angles below:
//
//   - SGW is an authentication module, not a content module. Its only
//     documented responsibility is the XTEA(32) seed/key handshake
//     (`docs/SGW_XTEA_ALGORITHM.md`), a stateless block transform with
//     no VIN-keyed material. `AutelSgwTab.jsx` (live-bus 27 01/02
//     dance) and `sgwAuth.js` (in-memory TTL auth cache) together
//     touch zero EEPROM bytes — there is no parser path to grow.
//   - `moduleRegistry.js` records SGW as kind:'unsupported' with the
//     note "SGW authenticates other writes; it does not store a VIN
//     slot. Excluded from Program-All." That is the single source of
//     truth every Program-All / module-batch flow already honors.
//   - The repo's 30+ committed ECU captures under `attached_assets/`
//     contain zero SGW dumps (the SGW firmware is signed and not
//     exposed via UDS reads on the tooling SRT Lab targets).
//
// The CLI alias `--module sgw` is still accepted by
// `scripts/anonymize-real-dump.mjs` so a maintainer who somehow
// acquires an SGW dump can hand it to the helper. With an empty slot
// table the scrubber is a no-op AND the post-scrub leak guard runs
// WITHOUT MASKING (because `getDocumentedSlotWindows('sgw')` returns
// []). The result is fail-loud: any donor-VIN occurrence anywhere in
// the buffer — forward, byte-reversed, or as the trailing 6-character
// serial — trips the guard at the exact offset. That is the only safe
// way to revisit this design decision: if a real SGW dump ever
// surfaces with a stored VIN at some undocumented offset (audit log,
// config table, future firmware revision that began caching VINs)
// the helper refuses to write the output and tells the maintainer
// where to dig. Once a slot is documented, populate this array AND
// the mirror in `parseModule.js` and the parser / helper / in-app
// pre-share scanner all pick it up in lock-step.
export const SGW_VIN_OFFSETS         = [];

export const SUPPORTED_MODULE_TYPES = ['bcm', 'rfhub', 'rfhubg1', 'pcm', '95640', 'sgw'];

// VIN-character set used by the partial-VIN auto-detector: ASCII letters
// (A-Z) and digits (0-9), with the VIN-illegal letters I, O, Q rejected.
// Matches the same letter set that `parseModule.extractVIN` accepts and
// that the `looksLikeVin`/`isValidVinAt` helpers in the anonymizer use.
function isVinChar(b) {
  if (b < 0x30 || b > 0x5A) return false;
  if (b > 0x39 && b < 0x41) return false; // skip 0x3A..0x40 punctuation
  if (b === 0x49 || b === 0x4F || b === 0x51) return false;
  return true;
}

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

// Auto-detect every partial-VIN-shaped record in `buffer`: 8 VIN-character
// bytes followed by a big-endian CRC16 that matches `crc16(buf[i..i+8])`.
// The CRC16 + tight VIN-character filter make false positives essentially
// impossible (the partial-VIN tail is always the last 8 chars of a VIN, all
// of which are A-Z|0-9 minus I/O/Q). Order is ascending offset.
//
// Returns []  if `buffer` is not a Uint8Array or is shorter than the 10-byte
// slot footprint. Each entry shape mirrors what `parseModule` currently
// surfaces in `info.partialVins` so the parser can adopt this directly.
export function findBcmPartialVinSlots(buffer) {
  const out = [];
  if (!(buffer instanceof Uint8Array)) return out;
  const sz = buffer.length;
  if (sz < BCM_PARTIAL_VIN_LEN + 2) return out;

  let i = 0;
  while (i + BCM_PARTIAL_VIN_LEN + 2 <= sz) {
    let ok = true;
    for (let j = 0; j < BCM_PARTIAL_VIN_LEN; j++) {
      if (!isVinChar(buffer[i + j])) { ok = false; break; }
    }
    if (!ok) { i++; continue; }
    const stored = (buffer[i + BCM_PARTIAL_VIN_LEN] << 8) | buffer[i + BCM_PARTIAL_VIN_LEN + 1];
    const calc   = crc16(buffer.slice(i, i + BCM_PARTIAL_VIN_LEN));
    if (stored !== calc) { i++; continue; }
    let tail = '';
    for (let j = 0; j < BCM_PARTIAL_VIN_LEN; j++) tail += String.fromCharCode(buffer[i + j]);
    out.push({
      offset:    i,
      tail,
      storedCrc: stored,
      calcCrc:   calc,
      crcOk:     true,
      length:    BCM_PARTIAL_VIN_LEN,
    });
    // Advance past this slot's payload so we don't re-detect overlapping
    // shifted matches inside the same record (8 ASCII tail bytes can't
    // double as both the start of one slot and 1..7 bytes into another
    // legitimate slot — they are 24 B apart in the documented layout).
    i += BCM_PARTIAL_VIN_LEN + 2;
  }
  return out;
}

export function getDocumentedSlotWindows(moduleType /* , buffer */) {
  // NOTE on the unused `buffer` parameter (Task #452): the helper's anonymizer
  // also auto-detects partial-VIN slots (8 VIN-char bytes + valid CRC16) and
  // scrubs every one it finds — but it passes its own `result.slots` list as
  // the explicit `slotWindows` to the post-scrub `scanBufferForDonorLeak`,
  // so the auto-detected slots are masked there. This default-mask path here
  // intentionally stays at the always-known registered offsets so the
  // pre-share UI scanner can still flag a donor-tail leak at a non-registered
  // partial-VIN slot in a NOT-YET-SCRUBBED user buffer (auto-masking those
  // would silently hide a real leak the user is asking us to find).
  const mt = String(moduleType || '').toLowerCase();
  const windows = [];
  if (mt === 'bcm') {
    for (const base of BCM_FULL_VIN_BASES) {
      windows.push({ kind: 'bcm-full-base+0', offset: base,     length: VIN_LEN });
      windows.push({ kind: 'bcm-full-base+8', offset: base + 8, length: VIN_LEN });
    }
    for (const po of BCM_PARTIAL_VIN_OFFSETS) {
      windows.push({ kind: 'bcm-partial', offset: po, length: BCM_PARTIAL_VIN_LEN });
    }
  } else if (mt === 'rfhub') {
    for (const off of RFH_GEN2_VIN_OFFSETS) {
      windows.push({ kind: 'rfh-rev-vin', offset: off, length: VIN_LEN });
    }
  } else if (mt === 'rfhubg1') {
    // Single plain-VIN slot at 0x92 (24C16, 2 KB Yazaki FCM EEPROM).
    windows.push({ kind: 'rfh-gen1-vin', offset: RFH_GEN1_VIN_OFFSET, length: VIN_LEN });
  } else if (mt === 'pcm') {
    for (const off of PCM_VIN_OFFSETS) {
      windows.push({ kind: 'pcm-full', offset: off, length: VIN_LEN });
    }
  } else if (mt === '95640') {
    // 3 plaintext VIN slots, no CRC (BCM-backup EEPROM, 8 KB).
    for (const off of EEP95640_VIN_OFFSETS) {
      windows.push({ kind: '95640-full', offset: off, length: VIN_LEN });
    }
  } else if (mt === 'sgw') {
    // Task #450 — SGW has no documented VIN slots yet (see SGW_VIN_OFFSETS
    // above). Returns an empty window list, which means the donor-leak
    // scanner runs with NO masking — any donor-VIN occurrence (even a
    // tail-only one) anywhere in the buffer is reported as a leak. That's
    // the right default for a family whose slot table is the empty set:
    // we'd rather fail loudly on a real dump that turns out to contain
    // the donor VIN than silently pass it through.
    for (const off of SGW_VIN_OFFSETS) {
      windows.push({ kind: 'sgw-full', offset: off, length: VIN_LEN });
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
