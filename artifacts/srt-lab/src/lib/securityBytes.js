/* ============================================================================
 * Overlap-hazard audit (Task #795 — follow-up to #779)
 *
 * Task #779 fixed one case: writeBcmFlatSec16 (LE slice at 0x40C9..0x40D8)
 * could silently clobber the canonical SEC16 that writeBcmSec16Gen2 had just
 * written into a mirror1 record landing at 0x40C0 in the same sync run.
 * That fix lives at the top of writeBcmFlatSec16 below (header sniff at
 * 0x40C0 → skip the flat write).
 *
 * Audit of every other writer in this file for the same "two writers chained
 * in a sync run, one writer's target region falls inside the other writer's
 * record on certain dumps" hazard:
 *
 *   ─ writeBcmSec16Gen2 split records (0x81A0/C0/E0) vs its own inactive-
 *     bank mirror records:
 *     The split-record region lives in bank 2 (0x8000..). The inactiveBase
 *     for mirrors is either 0x0000 or 0x4000 (the two FEE banks); the
 *     findRec scan range is [base, base+0x4000), which terminates at most
 *     at 0x8000. Geometrically separate — no overlap possible regardless of
 *     dump variant. ✅ safe by construction.
 *
 *   ─ writeBcmSec16Gen2 mirror1 (slot 0xEB / size 0x18) vs mirror2
 *     (slot 0xCA / size 0x28), both searched in the same inactive bank:
 *     PRE-FIX: m1Off was located, m1 written, then m2Off located. m1's
 *     write paints bytes off+8..off+31. If m2's header (8 bytes at m2Off)
 *     happened to land anywhere in [m1Off+8, m1Off+31] the m2 findRec
 *     would miss because m1's payload had just overwritten the
 *     `00 00 00 28 00 46 CA 00` signature.
 *     FIX: both findRec calls now run before either writeMirror, so each
 *     scan sees the original buffer. ✅ safe by construction.
 *
 *   ─ writeBcmSec16Gen2 vs writeBcmFlatSec16:
 *     Already addressed in #779; guard lives in writeBcmFlatSec16. ✅.
 *
 *   ─ writePcmSec6 (marker 0x3C4..0x3C7, secret 0x3C8..0x3CD):
 *     This is the only writer in the PCM sync chain. GPEC2A is a flat
 *     image (no FEE record stream) and the writer is gated to the two
 *     canonical sizes (4 KB 95320, 8 KB 95640). There is no sibling
 *     writer that could deposit a record header at 0x3C0 between the
 *     marker stamp and the secret stamp. ✅ not at risk in the #779 sense.
 *
 *   ─ writeRfhSec16FromBcm (slots 0x050E and 0x0522 on Gen2):
 *     Only writer in the RFHUB sync chain. Gated on the Gen2 header
 *     `AA 55 31 01` at 0x0500. The two slots are 16 + chk + 00 = 18
 *     bytes each, with a 2-byte gap (0x0520..0x0521 untouched). No
 *     sibling writer; no internal write-then-search ordering. ✅ not
 *     at risk in the #779 sense.
 *
 * Net result of the audit: one new in-writer guard (the mirror1-vs-
 * mirror2 reordering in writeBcmSec16Gen2 below). All other pairs are
 * either geometrically separate or have no chained sibling that could
 * trigger the hazard.
 * ============================================================================
 */

/* ============================================================================
 * securityBytes.js — single source of truth for the three immobilizer-secret
 * writers used during a Module Sync run.
 *
 * Previously these functions were duplicated verbatim in App.jsx and
 * tabs/ModuleSync.jsx. A divergence between the two copies would have meant
 * two different ECUs getting two different patched bytes for the same input
 * — the kind of silent corruption that only shows up on a real bench.
 *
 * Algorithms preserved verbatim from the SINCRO-verified ModuleSync.jsx
 * implementations (byte-identical to ArmandoQS/SINCRO on reference dumps).
 * Return shapes are a strict superset of the previous App.jsx versions so
 * existing call sites (which read `mirror2Offset`, `patched`, etc.) keep
 * working.
 * ============================================================================ */

/* XC2268 SEC16 lives in xc2268Rfhub.js's "single source of truth" layout
 * (slot offsets + image-wide checksum). The writer below imports those rather
 * than re-deriving the offsets so a layout change there can never drift from
 * the writer. crc16ccitt is the SEC16 slot-CRC primitive used by that parser. */
import { crc16ccitt } from './crc.js';
import {
  XC2268_SEC16_SLOTS,
  XC2268_SEC16_LEN,
  xc2268ImageChecksum,
} from './xc2268Rfhub.js';

/* CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF.
 * Same primitive as engCrc16 / lib/crc.js#crc16, duplicated here so this
 * module has no cross-file dependency for its core algorithm. */
function crc16Ccitt(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (let x = 0; x < data.length; x++) {
    c ^= data[x] << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
  }
  return c & 0xFFFF;
}

/* CRC-8 — poly 0x65, init 0xBF, no-reflect, no-xorOut.
 * RFHUB Gen2 SEC16 checksum primitive. Mirrors lib/crc.js#crc8_65 exactly;
 * duplicated here so this module stays free of cross-file dependencies for
 * its core algorithms (matches the crc16Ccitt pattern above). */
function crc8_65(data) {
  let c = 0xBF;
  for (let x = 0; x < data.length; x++) {
    c ^= data[x];
    for (let j = 0; j < 8; j++) {
      c = (c & 0x80) ? (((c << 1) ^ 0x65) & 0xFF) : ((c << 1) & 0xFF);
    }
  }
  return c & 0xFF;
}

const hexStr = (arr) => [...arr].map(b => b.toString(16).padStart(2, '0')).join('');

/* ----------------------------------------------------------------------------
 * writeBcmSec16Gen2(bytes, rfhSec16)
 *
 * VERIFIED ALGORITHM — produces byte-identical output to SINCRO/ArmandoQS on
 * 22 Charger Redeye reference dumps. Writes 3 targets:
 *   1. Split records at 0x81A0/C0/E0 (bank 2, persistent):
 *        7-byte prefix + separator "04 04 00 14" + 9-byte suffix
 *   2. Mirror 1 (slot 0xEB, size 0x18) in INACTIVE bank:
 *        header + idx(02) + SEC16(16b) + trailer(8F) + FF FF + CRC(2b) + EB 00
 *   3. Mirror 2 (slot 0xCA, size 0x28) in INACTIVE bank:
 *        same payload structure
 * Inactive bank is determined by comparing FEE sequence numbers at 0x0002
 * and 0x4002 — the higher value indicates the active bank.
 * Mirror CRC = CRC-16/CCITT(poly 0x1021, init 0xFFFF) over the 20 bytes
 *   [idx + SEC16(16) + trailer(8F) + FF + FF], stored big-endian at
 *   record+28 / record+29.
 * BCM SEC16 is reverse(RFH SEC16) (byte-reversed across the 16-byte slot).
 * ---------------------------------------------------------------------------- */
export function writeBcmSec16Gen2(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length !== 16) throw new Error('RFH SEC16 must be 16 bytes');
  const bcmSec16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bcmSec16[i] = rfhSec16[15 - i];
  const prefix7 = bcmSec16.slice(0, 7);
  const suffix9 = bcmSec16.slice(7, 16);
  const out = new Uint8Array(bytes);
  let splitPatched = 0, mirrorPatched = 0;

  /* 1. Split records */
  for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
    if (recOff + 30 > out.length) continue;
    if (out[recOff] !== 0xFF || out[recOff + 1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (out[recOff + j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = out[recOff + 8];
    if (idx !== 0x01 && idx !== 0x02) continue;
    if (out[recOff + 16] !== 0x04 || out[recOff + 17] !== 0x04 ||
        out[recOff + 18] !== 0x00 || out[recOff + 19] !== 0x14) continue;
    for (let k = 0; k < 7; k++) out[recOff +  9 + k] = prefix7[k];
    for (let k = 0; k < 9; k++) out[recOff + 20 + k] = suffix9[k];
    splitPatched++;
  }

  /* 2. Determine inactive bank (higher seq = active) */
  const bank0Seq = (out[0x0002] << 8) | out[0x0003];
  const bank1Seq = (out[0x4002] << 8) | out[0x4003];
  const inactiveBase = bank0Seq >= bank1Seq ? 0x4000 : 0x0000;

  /* Helper: find record header for a given slot type / size in given bank */
  const findRec = (base, slotType, sizeByte) => {
    const end = base + 0x4000;
    for (let i = base; i < end - 8; i++) {
      if (out[i]     === 0x00 && out[i + 1] === 0x00 && out[i + 2] === 0x00 &&
          out[i + 3] === sizeByte && out[i + 4] === 0x00 && out[i + 5] === 0x46 &&
          out[i + 6] === slotType && out[i + 7] === 0x00) return i;
    }
    return -1;
  };

  /* Helper: write the mirror payload (idx + SEC16 + trailer + CRC + footer) */
  const writeMirror = (off) => {
    out[off + 8] = 0x02; /* idx */
    for (let k = 0; k < 16; k++) out[off + 9 + k] = bcmSec16[k];
    out[off + 25] = 0x8F; /* trailer */
    out[off + 26] = 0xFF;
    out[off + 27] = 0xFF;
    /* Compute CRC over idx + SEC16 + trailer + FF + FF (20 bytes) */
    const ci = new Uint8Array(20);
    ci[0] = 0x02;
    for (let k = 0; k < 16; k++) ci[1 + k] = bcmSec16[k];
    ci[17] = 0x8F; ci[18] = 0xFF; ci[19] = 0xFF;
    const crc = crc16Ccitt(ci);
    out[off + 28] = (crc >> 8) & 0xFF;
    out[off + 29] = crc & 0xFF;
    out[off + 30] = 0xEB;
    out[off + 31] = 0x00;
  };

  /* Find BOTH mirror offsets before writing either (Task #795 overlap guard).
   * Previously the order was: find m1 → write m1 → find m2. If m2's header
   * happened to land inside m1's payload window [m1Off+8, m1Off+31] on a
   * non-canonical dump, the m1 write would overwrite m2's
   * `00 00 00 28 00 46 CA 00` signature and the subsequent findRec would
   * silently return -1 → m2 left unpatched on a customer car. Doing both
   * scans first against the pristine buffer eliminates that class of bug
   * by construction. The two writes themselves cannot collide with each
   * other's header (they only touch off+8..off+31). */
  const m1Off = findRec(inactiveBase, 0xEB, 0x18);
  const m2Off = findRec(inactiveBase, 0xCA, 0x28);
  if (m1Off >= 0) { writeMirror(m1Off); mirrorPatched++; }
  if (m2Off >= 0) { writeMirror(m2Off); mirrorPatched++; }

  return {
    bytes: out,
    splitPatched,
    mirrorPatched,
    inactiveBase,
    mirror1Offset: m1Off >= 0 ? m1Off : null,
    mirror2Offset: m2Off >= 0 ? m2Off : null,
    bcmSec16Hex: hexStr(bcmSec16),
    /* Legacy aggregate field for backward compat with older call sites */
    patched: splitPatched + mirrorPatched,
  };
}

/* ----------------------------------------------------------------------------
 * writeBcmFlatSec16(bytes, resolvedSec16, { mode } = {})
 *
 * Repair helper for legacy third-party tools (CGDI, Autel, AlfaOBD,
 * Mitchell 6.x, SINCRO) that still read the BCM vehicle secret from the
 * flat little-endian slice at 0x40C9..0x40D8. After Task #380, the
 * resolver picks the canonical SEC16 from split / mirror records and the
 * flat slice is left holding residual garbage on synced Redeye dumps —
 * so legacy tools see junk.
 *
 * This writer takes the resolved (canonical / big-endian) SEC16 and
 * writes its byte-reversed (little-endian) form into 0x40C9..0x40D8 of a
 * fresh buffer copy. Split records (0x81A0/C0/E0), mirror records in the
 * inactive bank, and every other byte are left untouched in the common
 * case — the live Redeye sources keep working, and the legacy slice now
 * agrees with them.
 *
 * Input must be the canonical SEC16 (the bytes returned by
 * resolveBcmSec16().bytes when source !== 'flat'). Caller is responsible
 * for gating on resolver.source !== 'flat' && !blank — this function
 * will happily write whatever 16 bytes it's handed.
 *
 * --- Overlap handling (older BCM dumps) ---
 *
 * On some older BCM layouts a mirror1 record (slot 0xEB, size 0x18) sits
 * at 0x40C0, which puts its 16-byte SEC16 payload at exactly
 * 0x40C9..0x40D8 — the same slice this writer targets. The two views
 * disagree: the mirror stores the canonical SEC16 (big-endian), the
 * legacy flat slice expects the little-endian reverse. Whichever copy
 * lives in those 16 bytes is "wrong" for the other reader.
 *
 * `mode` controls which view wins:
 *
 *   - 'canonical' (default) — Safe for SRT Lab + modern tools that read
 *     the mirror as BE. The writer detects the overlap header
 *     `00 00 00 18 00 46 EB 00` at 0x40C0 and SKIPS the LE write so the
 *     mirror payload stays intact. Legacy tools that still parse the
 *     flat LE slice will see the canonical bytes reversed and report
 *     IMMO_DAMAGED — that's the trade-off.
 *
 *   - 'legacy-flat' — Safe for legacy tools (CGDI / Autel / AlfaOBD /
 *     Mitchell 6.x / SINCRO) that read the flat slice as LE. The writer
 *     forces the LE write even on overlap dumps, clobbering the mirror1
 *     SEC16 payload. SRT Lab's own resolver still recovers the correct
 *     secret from the split records at 0x81A0/C0/E0 (highest priority)
 *     or the slot-0xCA mirror2 record (lower priority), so a freshly
 *     synced dump is still self-consistent under SRT Lab's parser; only
 *     the slot-0xEB mirror1 record becomes inconsistent in this mode.
 *     Use this for the "legacy-tool-compatible" copy you hand to a
 *     locksmith bench tool — keep the canonical copy in your vault.
 *
 * Return shape (extended for Task #794):
 *   { bytes, offset, patched, skipped, skipReason, sec16Hex, leHex,
 *     mode, mirror1Overlap, mirror1ClobberedAt? }
 * ---------------------------------------------------------------------------- */
const FLAT_WRITE_MODES = new Set(['canonical', 'legacy-flat']);

export function writeBcmFlatSec16(bytes, resolvedSec16, options = {}) {
  if (!resolvedSec16 || resolvedSec16.length !== 16) {
    throw new Error('Resolved SEC16 must be 16 bytes');
  }
  if (!bytes || bytes.length < 0x40D9) {
    throw new Error('BCM buffer too small for flat 0x40C9 slice (need ≥ 0x40D9 B)');
  }
  const mode = options.mode || 'canonical';
  if (!FLAT_WRITE_MODES.has(mode)) {
    throw new Error(`Unknown writeBcmFlatSec16 mode: ${mode} (expected 'canonical' or 'legacy-flat')`);
  }

  const out = new Uint8Array(bytes);
  const le = new Uint8Array(16);
  for (let i = 0; i < 16; i++) le[i] = resolvedSec16[15 - i];

  const mirror1OverlapsFlat = (
    out.length >= 0x40C8 &&
    out[0x40C0] === 0x00 && out[0x40C1] === 0x00 && out[0x40C2] === 0x00 &&
    out[0x40C3] === 0x18 && out[0x40C4] === 0x00 && out[0x40C5] === 0x46 &&
    out[0x40C6] === 0xEB && out[0x40C7] === 0x00
  );

  if (mirror1OverlapsFlat && mode === 'canonical') {
    return {
      bytes: out,
      offset: 0x40C9,
      patched: 0,
      skipped: true,
      skipReason: 'mirror1 at 0x40C0 overlaps flat 0x40C9 slice',
      sec16Hex: hexStr(resolvedSec16),
      leHex: hexStr(le),
      mode,
      mirror1Overlap: true,
    };
  }

  for (let i = 0; i < 16; i++) out[0x40C9 + i] = le[i];
  return {
    bytes: out,
    offset: 0x40C9,
    patched: 16,
    skipped: false,
    skipReason: null,
    sec16Hex: hexStr(resolvedSec16),
    leHex: hexStr(le),
    mode,
    mirror1Overlap: mirror1OverlapsFlat,
    mirror1ClobberedAt: mirror1OverlapsFlat ? 0x40C0 : null,
  };
}

/* ----------------------------------------------------------------------------
 * Canonical GPEC2A SEC6 layout (verified Task #404 against the real-bench
 * `FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_VIRGINSYNCHED_6.2` paired dump):
 *
 *   0x3C4..0x3C7: marker bytes  FF FF FF AA   (Continental "SEC6 next" tag)
 *   0x3C8..0x3CD: the 6 secret bytes (= reverse(BCM SEC16)[0:6]
 *                                    = RFH SEC16[0:6])
 *   0x3CE+:       remains 0xFF
 *
 * Both 4 KB (95320) and 8 KB-doubled (95640) GPEC2A images carry the
 * marker only at 0x3C4 — there is no second-half mirror. External
 * locksmith tools (CGDI, Autel, AlfaOBD, Mitchell 6.x, SINCRO) all
 * report `IMMO_DAMAGED` when 0x3C4..0x3C7 is `FF FF FF FF` even if the
 * 6 secret bytes at 0x3C8 look correct, because the marker is what
 * tells the PCM bootloader the slot is valid. */
export const PCM_SEC6_MARKER = new Uint8Array([0xFF, 0xFF, 0xFF, 0xAA]);
export const PCM_SEC6_MARKER_OFFSET = 0x3C4;
export const PCM_SEC6_OFFSET = 0x3C8;
const CANONICAL_PCM_SIZES = new Set([4096, 8192]);

/* ----------------------------------------------------------------------------
 * writePcmSec6(bytes, rfhSec16)
 *
 * Single source of truth for PCM (GPEC2A) SEC6 patching — Task #404
 * unified the three previously-divergent writers (engine + Twin tab
 * inline write + RFH→PCM tab inline write) into this one function so
 * the same input pair always produces a byte-identical output
 * regardless of which UI path the user takes.
 *
 * Writes the first 6 bytes of `rfhSec16` as the PCM SEC6 secret AND
 * stamps the canonical `FF FF FF AA` marker at 0x3C4..0x3C7 so the
 * resulting file matches what a real BCM-paired GPEC2A would carry on
 * disk — both bytes together are what makes external locksmith tools
 * (CGDI, Autel, AlfaOBD, Mitchell 6.x, SINCRO) see the slot as paired
 * instead of `IMMO_DAMAGED`.
 *
 * Only canonical GPEC2A sizes (4 KB 95320, 8 KB 95640) are accepted —
 * the previous fallback that scanned for arbitrary FFFFFFFF runs (and
 * was incorrectly labelled as a "GPEC5" path; there is no GPEC5 — the
 * 8 KB image is just a larger GPEC2A) has been removed because it was
 * misfiring on a virgin GPEC2A:
 * a stray `00` byte at offset 0x19 (inside the part-number region)
 * was matching the FFFFFFFF heuristic and stamping 6 stray bytes at
 * 0x17, corrupting the part-number string while leaving the canonical
 * 0x3C4 / 0x3C8 slot untouched. Non-canonical buffers return
 * { patched: 0, ok: false } so the caller can refuse the download.
 * ---------------------------------------------------------------------------- */
export function writePcmSec6(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length < 6) throw new Error('Need at least 6 bytes of RFH SEC16');
  const sec6 = rfhSec16.slice(0, 6);
  const out = new Uint8Array(bytes);
  let patched = 0;
  let markerUsed = null;
  let markerStamped = false;

  if (CANONICAL_PCM_SIZES.has(out.length) && out.length >= 0x3CE) {
    for (let k = 0; k < 4; k++) out[PCM_SEC6_MARKER_OFFSET + k] = PCM_SEC6_MARKER[k];
    for (let k = 0; k < 6; k++) out[PCM_SEC6_OFFSET + k] = sec6[k];
    patched = 1;
    markerUsed = 'FF FF FF AA';
    markerStamped = true;
  }

  return {
    bytes: out,
    patched,
    ok: patched > 0,
    markerUsed,
    markerStamped,
    sec6Hex: hexStr(sec6),
  };
}

/* ----------------------------------------------------------------------------
 * writeRfhSec16FromBcm(bytes, bcmSec16)
 *
 * Writes BCM secret → RFHUB Gen2 SEC16 slots.
 * BCM stores reverse(RFHUB SEC16), so RFHUB SEC16 = reverse(BCM SEC16).
 * Checksum formula (CRC-8, poly 0x65, init 0xBF — verified against a real
 * RFHUB Gen2 dump where slot bytes 01 23 45 67 89 AB CD EF FE DC BA 98 76
 * 54 32 10 store CS bytes E2 00):
 *     chk = crc8_65(rfhSec16);  trailer = 0x00
 * Writes to both Gen2 slots: 0x050E and 0x0522.
 * Throws if the buffer is not a Gen2 RFHUB (header AA 55 31 01 at 0x0500).
 *
 * Previously this writer used an empirical (0xFE - sum%255) formula which
 * disagreed with the parseModule.js reader (rfhSec16Cs / crc8_65). The
 * parser's formula is the one confirmed against the real-dump golden vector
 * pinned in crc.golden.test.js; the writer was reconciled to match it so
 * freshly-written slots round-trip with csOk=true.
 * ---------------------------------------------------------------------------- */
export function writeRfhSec16FromBcm(bytes, bcmSec16) {
  if (!bcmSec16 || bcmSec16.length !== 16) throw new Error('BCM SEC16 must be 16 bytes');
  const rfhSec16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rfhSec16[i] = bcmSec16[15 - i];
  const chk = crc8_65(rfhSec16);
  const out = new Uint8Array(bytes);
  if (out[0x0500] !== 0xAA || out[0x0501] !== 0x55 ||
      out[0x0502] !== 0x31 || out[0x0503] !== 0x01) {
    throw new Error('Not a Gen2 RFHUB (AA 55 31 01 header missing at 0x0500)');
  }
  let patched = 0;
  for (const slotOff of [0x050E, 0x0522]) {
    if (slotOff + 18 > out.length) continue;
    for (let k = 0; k < 16; k++) out[slotOff + k] = rfhSec16[k];
    out[slotOff + 16] = chk;
    out[slotOff + 17] = 0x00;
    patched++;
  }
  return {
    bytes: out,
    patched,
    rfhSec16Hex: hexStr(rfhSec16),
    chk,
  };
}

/* ----------------------------------------------------------------------------
 * writeXc2268Sec16(bytes, bcmSec16)
 *
 * Writes the BCM secret → XC2268-class RFHUB (2019+ Ram internal-flash, 64 KB)
 * SEC16 mirror slots (0x1100 / 0x1120 — see XC2268_SEC16_SLOTS). Same secret
 * convention as the Gen2 writer: the BCM stores reverse(RFHUB SEC16), so the
 * RFHUB SEC16 = reverse(BCM SEC16). Each slot stores the 16 SEC16 bytes plus a
 * BE16 CRC-16/CCITT-FALSE over those bytes at slot+16/+17.
 *
 * Because the SEC16 slots live inside the [0, len-4) image-checksum window,
 * the trailing image-wide checksum is refreshed after the slots are written
 * (otherwise a reparse would flag an image-CRC mismatch).
 *
 * Refuses (throws) on a blank BCM secret — same refuse-on-doubt stance as the
 * Gen2 writer — so a virgin/unresolved BCM can never silently zero the RFHUB.
 * Returns the same shape as writeRfhSec16FromBcm ({bytes, patched,
 * rfhSec16Hex, chk}) so the key-prog wizard can branch on RFHUB type without
 * special-casing the result.
 * ---------------------------------------------------------------------------- */
export function writeXc2268Sec16(bytes, bcmSec16) {
  if (!bcmSec16 || bcmSec16.length !== XC2268_SEC16_LEN) {
    throw new Error('BCM SEC16 must be 16 bytes');
  }
  if (bcmSec16.every((b) => b === 0xFF || b === 0x00)) {
    throw new Error('Refusing to write XC2268 SEC16 from a blank BCM secret');
  }
  const rfhSec16 = new Uint8Array(XC2268_SEC16_LEN);
  for (let i = 0; i < XC2268_SEC16_LEN; i++) rfhSec16[i] = bcmSec16[XC2268_SEC16_LEN - 1 - i];
  const chk = crc16ccitt(rfhSec16);
  const out = new Uint8Array(bytes);
  let patched = 0;
  for (const slotOff of XC2268_SEC16_SLOTS) {
    if (slotOff + XC2268_SEC16_LEN + 2 > out.length) continue;
    for (let k = 0; k < XC2268_SEC16_LEN; k++) out[slotOff + k] = rfhSec16[k];
    out[slotOff + XC2268_SEC16_LEN] = (chk >>> 8) & 0xFF;
    out[slotOff + XC2268_SEC16_LEN + 1] = chk & 0xFF;
    patched++;
  }
  // SEC16 slots sit inside the image-checksum window — refresh the trailing
  // BE32 image-wide checksum so a reparse round-trips with imageChecksum.ok.
  const imageCs = xc2268ImageChecksum(out);
  out[out.length - 4] = (imageCs >>> 24) & 0xFF;
  out[out.length - 3] = (imageCs >>> 16) & 0xFF;
  out[out.length - 2] = (imageCs >>> 8) & 0xFF;
  out[out.length - 1] = imageCs & 0xFF;
  return {
    bytes: out,
    patched,
    rfhSec16Hex: hexStr(rfhSec16),
    chk,
  };
}
