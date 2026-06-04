/**
 * rfhubVinPatcher.js — offline RFHUB VIN analysis + patching.
 *
 * Supported targets:
 *   Gen2  (MC9S12X, 24C32, 4096 B): 4 VIN slots at RFH_GEN2_VIN_OFFSETS, byte-reversed,
 *         CS = rfhGen2VinCs(storedBytes, magic) at slot+17. Magic auto-detected.
 *   Gen1  (MC9S12X, 24C16, 2048 B): single VIN at 0x92, plain (not reversed),
 *         CS = CRC-16/CCITT at +17..18 (big-endian).
 *   XC2268 (internal-flash, ≥32 KB): inspect-only — VIN slots readable, patch blocked.
 *
 * No live OBD dependency — both helpers are pure (bytes in, bytes out).
 */

import {RFH_GEN2_VIN_OFFSETS, RFH_GEN1_VIN_OFFSET, buildRfhubContentWarn} from './parseModule.js';
import {crc16, rfhGen2VinCs, rfhGen2DetectMagic, RFH_GEN2_VIN_MAGIC_FORWARD, RFH_GEN2_VIN_MAGIC_REVERSED} from './crc.js';
import {isXc2268Rfhub, parseXc2268Image} from './xc2268Rfhub.js';

// ---------------------------------------------------------------------------
// Constants & validation
// ---------------------------------------------------------------------------

const VIN_RE = /^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/;

/**
 * Validate a 17-char VIN string. Throws a descriptive Error on failure.
 * Accepts upper and lower-case — normalises internally.
 */
export function validateVin(vin) {
  if (!vin || typeof vin !== 'string') throw new Error('VIN must be a non-empty string.');
  const v = vin.toUpperCase();
  if (v.length !== 17) throw new Error(`VIN must be exactly 17 characters (got ${v.length}).`);
  if (/[IOQ]/.test(v)) throw new Error('VIN must not contain the letters I, O, or Q.');
  if (!VIN_RE.test(v)) throw new Error('VIN format invalid — first character must be 1–9 or A–H/J–N/P–R/S–Z; remaining chars alphanumeric (no I/O/Q).');
}

// ---------------------------------------------------------------------------
// analyzeRfhubVin
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RfhVinSlot
 * @property {number}  slotNum     1-based slot index
 * @property {number}  offset      byte offset inside the image
 * @property {string}  offsetHex   e.g. "0x0EA5"
 * @property {string|null} vin     decoded VIN string, or null if slot is blank/invalid
 * @property {boolean} blank       true when the entire slot is all-FF or all-00
 * @property {number|null} storedCs  checksum stored in the image (null if blank)
 * @property {number|null} computedCs  re-computed expected checksum (null if blank)
 * @property {boolean|null} crcOk   true = passes, false = broken, null = blank (not checked)
 * @property {string} [csFormat]  human-readable description of the CS algorithm used
 */

/**
 * @typedef {Object} RfhVinAnalysis
 * @property {'gen1'|'gen2'|'xc2268'|null} generation
 * @property {string} mcuLabel    short human label shown in the panel header
 * @property {RfhVinSlot[]} slots  one entry per VIN slot (including blank ones)
 * @property {number} [magic]     Gen2 auto-detected magic byte
 * @property {boolean} [xc2268]  true when the image is an XC2268 internal-flash dump
 * @property {Object} [contentWarn]  non-null when content doesn't look like a Gen2 RFHUB dump;
 *                                   shape: {message, causes[]}. Patch is UI-gated on override.
 * @property {string} [error]    set when the buffer is non-canonical / unrecognised
 */

/**
 * Analyse the VIN slots of a raw RFHUB image.
 * Returns a normalised descriptor that the panel component can render without
 * needing to understand the format internally.
 *
 * @param {Uint8Array} bytes  raw RFHUB image bytes
 * @returns {RfhVinAnalysis}
 */
export function analyzeRfhubVin(bytes) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {generation: null, mcuLabel: 'No data', slots: [], error: 'Empty or missing buffer.'};
  }

  // ── XC2268: internal-flash — inspect VIN slots, patch blocked ────────────
  if (isXc2268Rfhub(bytes)) {
    const parsed = parseXc2268Image(bytes);
    if (!parsed.ok) {
      return {generation: 'xc2268', mcuLabel: 'XC2268 internal-flash', slots: [], xc2268: true, error: parsed.reason};
    }
    const slots = parsed.vinSlots.map((vs, idx) => {
      const blank = vs.present && !vs.vin && (!vs.raw || vs.raw.every(b => b === 0xFF || b === 0x00));
      return {
        slotNum: idx + 1,
        offset: vs.offset,
        offsetHex: hex4(vs.offset),
        vin: vs.vin,
        blank,
        storedCs: vs.csStored,
        computedCs: vs.csCalc,
        crcOk: vs.csOk ? true : (vs.csCalc !== null && vs.csStored !== null) ? false : null,
        csFormat: 'CRC-16/CCITT BE',
      };
    });
    return {generation: 'xc2268', mcuLabel: 'XC2268 internal-flash', slots, xc2268: true};
  }

  const sz = bytes.length;

  // ── Gen2: 24C32, exactly 4096 bytes ───────────────────────────────────────
  if (sz === 4096) {
    // Content validation — warn when none of the RFHUB structural markers are
    // present.  A blank/virgin RFHUB also fails this check, so it is a warning
    // not a hard refusal; the UI gates patch behind an explicit override.
    const contentWarn = buildRfhubContentWarn(bytes) || null;

    // Auto-detect magic from the first non-blank slot
    let magic = 0xDB;
    for (const o of RFH_GEN2_VIN_OFFSETS) {
      if (o + 17 >= sz) continue;
      const st = bytes.slice(o, o + 17);
      if (st.every(b => b === 0xFF || b === 0x00)) continue;
      const sc = bytes[o + 17];
      if (sc !== 0x00 && sc !== 0xFF) {magic = rfhGen2DetectMagic(st, sc); break;}
    }

    const slots = RFH_GEN2_VIN_OFFSETS.map((offset, idx) => {
      const st = bytes.slice(offset, offset + 17);
      const blank = st.every(b => b === 0xFF || b === 0x00);

      if (blank) {
        return {slotNum: idx + 1, offset, offsetHex: hex4(offset), vin: null, blank: true, storedCs: null, computedCs: null, crcOk: null, csFormat: 'Gen2 XOR'};
      }

      // Stored bytes are byte-reversed compared to the ASCII VIN
      const rev = new Uint8Array(17);
      for (let j = 0; j < 17; j++) rev[j] = st[16 - j];
      let vin = '';
      for (let j = 0; j < 17; j++) vin += String.fromCharCode(rev[j]);
      const vinValid = VIN_RE.test(vin);

      const storedCs = offset + 17 < sz ? bytes[offset + 17] : 0;
      const computedCs = rfhGen2VinCs(st, magic);

      return {
        slotNum: idx + 1,
        offset,
        offsetHex: hex4(offset),
        vin: vinValid ? vin : null,
        blank: false,
        storedCs,
        computedCs,
        crcOk: storedCs === computedCs,
        csFormat: 'Gen2 XOR',
      };
    });

    return {generation: 'gen2', mcuLabel: 'Gen2 MC9S12X (24C32 · 4 KB)', slots, magic, contentWarn};
  }

  // ── Gen1: 24C16, exactly 2048 bytes ───────────────────────────────────────
  if (sz === 2048) {
    const offset = RFH_GEN1_VIN_OFFSET;

    if (sz < offset + 19) {
      return {generation: 'gen1', mcuLabel: 'Gen1 MC9S12X (24C16 · 2 KB)', slots: [], error: 'Buffer too small for VIN slot.'};
    }

    const raw17 = bytes.slice(offset, offset + 17);
    const blank = raw17.every(b => b === 0xFF || b === 0x00);

    if (blank) {
      return {
        generation: 'gen1',
        mcuLabel: 'Gen1 MC9S12X (24C16 · 2 KB)',
        slots: [{slotNum: 1, offset, offsetHex: hex4(offset), vin: null, blank: true, storedCs: null, computedCs: null, crcOk: null, csFormat: 'CRC-16 BE'}],
      };
    }

    let vin = '';
    for (let j = 0; j < 17; j++) vin += String.fromCharCode(raw17[j]);
    const vinValid = VIN_RE.test(vin);
    const storedCs = (bytes[offset + 17] << 8) | bytes[offset + 18];
    const computedCs = crc16(raw17);

    return {
      generation: 'gen1',
      mcuLabel: 'Gen1 MC9S12X (24C16 · 2 KB)',
      slots: [{
        slotNum: 1,
        offset,
        offsetHex: hex4(offset),
        vin: vinValid ? vin : null,
        blank: false,
        storedCs,
        computedCs,
        crcOk: storedCs === computedCs,
        csFormat: 'CRC-16 BE',
      }],
    };
  }

  // Unknown / non-canonical size
  return {
    generation: null,
    mcuLabel: 'Unknown',
    slots: [],
    error: `Non-canonical RFHUB size: ${sz.toLocaleString()} bytes (expected 2048 or 4096).`,
  };
}

// ---------------------------------------------------------------------------
// patchRfhubVin
// ---------------------------------------------------------------------------

/**
 * Patch a raw RFHUB image with a new VIN, updating all VIN slots and their
 * checksums.  Returns a new Uint8Array — the input is never mutated.
 *
 * Throws on invalid input (wrong VIN format, non-canonical buffer, XC2268).
 * Does NOT throw on content-warn (blank/virgin Gen2) — that gate lives in the
 * UI layer so technicians who know what they're doing can override.
 *
 * @param {Uint8Array} bytes   raw RFHUB image
 * @param {string}     newVin  17-char VIN string (upper or lower case, no I/O/Q)
 * @returns {Uint8Array}       patched image
 */
export function patchRfhubVin(bytes, newVin) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('bytes must be a non-empty Uint8Array.');
  }

  validateVin(newVin);
  const vin = newVin.toUpperCase();

  if (isXc2268Rfhub(bytes)) {
    throw new Error('XC2268 internal-flash RFHUB offline VIN patching is not supported here — use the XC2268-specific patchXc2268Vin path.');
  }

  const sz = bytes.length;

  if (sz !== 4096 && sz !== 2048) {
    throw new Error(`Non-canonical RFHUB buffer size: ${sz.toLocaleString()} bytes (expected 2048 or 4096).`);
  }

  const out = new Uint8Array(bytes);

  // ── Gen2 ──────────────────────────────────────────────────────────────────
  if (sz === 4096) {
    // Re-detect magic from the first non-blank slot so we preserve the
    // variant's original magic; fall back to 0xDB (2020+ Redeye default).
    let detectedMagic = RFH_GEN2_VIN_MAGIC_FORWARD; // 0xDB
    for (const o of RFH_GEN2_VIN_OFFSETS) {
      if (o + 17 >= sz) continue;
      const st = bytes.slice(o, o + 17);
      if (st.every(b => b === 0xFF || b === 0x00)) continue;
      const sc = bytes[o + 17];
      if (sc !== 0x00 && sc !== 0xFF) {detectedMagic = rfhGen2DetectMagic(st, sc); break;}
    }

    // Magic 0xDB means the OG file stores VIN FORWARD (old tool format from alpha/6).
    // When writing, we always store REVERSED (standard format), so we must switch to
    // the reversed-storage magic 0xAD. All other magics (0x87, 0xAD) already indicate
    // reversed storage — carry them through unchanged.
    const writeMagic = detectedMagic === RFH_GEN2_VIN_MAGIC_FORWARD
      ? RFH_GEN2_VIN_MAGIC_REVERSED  // 0xDB -> 0xAD
      : detectedMagic;

    // Build the reversed storage bytes for the new VIN (standard format)
    const raw17 = new Uint8Array(17);
    for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(16 - j);
    const cs = rfhGen2VinCs(raw17, writeMagic);

    for (const o of RFH_GEN2_VIN_OFFSETS) {
      if (o + 18 > sz) continue;
      out.set(raw17, o);
      out[o + 17] = cs;
    }

    return out;
  }

  // ── Gen1 ──────────────────────────────────────────────────────────────────
  const offset = RFH_GEN1_VIN_OFFSET;
  if (sz < offset + 19) throw new Error('Gen1 RFHUB buffer too small for VIN write.');

  const raw17 = new Uint8Array(17);
  for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(j);
  const cs = crc16(raw17);

  out.set(raw17, offset);
  out[offset + 17] = (cs >> 8) & 0xFF;
  out[offset + 18] = cs & 0xFF;

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hex4(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}
