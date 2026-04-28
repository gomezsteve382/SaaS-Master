import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ASSET_IDS, trackDownload } from "../lib/downloadAssets.js";
import { DownloadCounter } from "../lib/useDownloadCount.jsx";
import { useMasterVin } from "../lib/masterVinContext.jsx";
import MismatchWizard from "../components/MismatchWizard.jsx";
import { writeBcmSec16Gen2, writePcmSec6, writeRfhSec16FromBcm, writeBcmFlatSec16 } from "../lib/securityBytes.js";
import { bcmTooSmall, moduleTooSmall, pcmChipFromSize, resolveBcmSec16, classifyPcmSec6, parseModule, PCM_VIN_OFFSETS_GPEC2A } from "../lib/parseModule.js";
import { crossValidate } from "../lib/crossValidate.js";
import { MODULE_CONNECTION_GUIDES, PROGRAMMERS } from "../lib/programmerData.js";
import { scoreCandidate, pickBest, fmtPick, CANONICAL_PATTERNS } from "../lib/bestPick.js";

/* ============================================================================
 * SRT Lab — Module Sync v2 (SINCRO-verified engine)
 *
 * BCM:   MPC5606B DFLASH — VIN slots (00 46 XX 00 marker), SEC16 split records
 *         at 0x81A0/C0/E0 (7+9 byte format), mirror records (0xEB/0xCA),
 *         active/inactive bank detection via FEE sequence numbers.
 *
 * RFHUB: Yazaki FCM EEPROM — 4 byte-reversed VIN slots at 0x0EA5/B9/CD/E1
 *         Gen1 SEC16 at 0x0226/023A (18 bytes), Gen2 at 0x050E/0522 (16 bytes)
 *         Gen2 detected by AA 55 31 01 header at 0x0500.
 *
 * PCM:   Continental GPEC2A (4 KB or 8 KB EEPROM, FF FF FF AA marker @ 0x3C4 + SEC6 @ 0x3C8)
 *         VIN at 0x0000/01F0/0224/0CE0, SEC6 after the marker.
 *
 * SINCRO-verified: engWriteBcmSec16Gen2 produces byte-identical output to
 *   ArmandoQS/SINCRO on 22 Charger Redeye reference dumps.
 * ============================================================================ */

const C = {
  bg: '#F4F1EC', cd: '#FFF', c2: '#FAF9F7', sr: '#D32F2F', sl: '#FF5252',
  bk: '#1A1A1A', a1: '#FF6D00', a2: '#00BFA5', a3: '#2979FF', a4: '#AA00FF',
  tx: '#1A1A1A', ts: '#5A5A5A', tm: '#9E9E9E', bd: '#E8E4DE',
  gn: '#00C853', wn: '#FFB300', er: '#FF1744',
};

const VIN_RE   = /^[12345][A-HJ-NPR-Z0-9]{16}$/;

/* Per-action map of which modules a given Module Sync action actually
 * reads or writes. Used by computeMixedSyncParticipants() so the
 * mixed-override warning only fires when the modules the action
 * touches really mix registry-checked and override files.
 * 95640/EEP is intentionally excluded: the Dumps tab does not expose
 * a P/N override flag for it. */
export const MODSYNC_ACTION_PARTICIPANTS = {
  'rfh-to-bcm':            ['BCM', 'RFHUB'],
  'bcm-to-rfh':            ['BCM', 'RFHUB'],
  'target-both':           ['BCM', 'RFHUB'],
  'bcm-sec16-to-rfh':      ['BCM', 'RFHUB'],
  'bcm-flat-from-resolved':['BCM'],
  'sec16-only':            ['BCM', 'RFHUB', 'PCM'],
  'sync-all':              ['BCM', 'RFHUB', 'PCM'],
  'full-sync':             ['BCM', 'RFHUB', 'PCM'],
  'rekey-95640-from-rfh':  ['RFHUB'],
};

/* Returns the names of currently-loaded participating modules split into
 * `overrideNames` (P/N override active) and `checkedNames` (registry-
 * checked / no override). Caller decides whether to prompt based on
 * whether both lists are non-empty. */
export function computeMixedSyncParticipants(action, slots) {
  const order = MODSYNC_ACTION_PARTICIPANTS[action] || ['BCM', 'RFHUB', 'PCM'];
  const participants = order.filter(name => slots[name]?.loaded);
  return {
    participants,
    overrideNames: participants.filter(n => slots[n].override),
    checkedNames:  participants.filter(n => !slots[n].override),
  };
}
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const VIN_LEN  = 17;

/* ----------------------------------------------------------------------------
 * chainBcmFlatRepairIfStale (Task #385)
 *
 * After any sync that updates the live BCM SEC16 split / mirror records, the
 * legacy flat slice at 0x40C9..0x40D8 is stale by definition — pre-Redeye
 * tools (CGDI, Autel, etc.) that still read the flat field would see the
 * old secret. This helper inspects the post-write BCM buffer and, when the
 * resolver picked a live record-table source (split / mirror1 / mirror2)
 * AND the flat slice does not already contain reverse(resolved SEC16),
 * repairs the flat slice in-place and returns the patched bytes.
 *
 * Returns:
 *   { repaired:false, reason:'unresolved-or-blank' | 'flat-only' | 'already-in-sync',
 *     resolver, bytes:<input>, oldFlatHex? }
 *   { repaired:true,  reason:'stale', resolver, bytes:<patched>,
 *     source, leHex, sec16Hex, oldFlatHex }
 *
 * Pure function — caller decides whether to log, download, or chain a row.
 * ---------------------------------------------------------------------------- */
export function chainBcmFlatRepairIfStale(bcmBytes) {
  if (!bcmBytes || bcmBytes.length < 0x40D9) {
    return { repaired: false, reason: 'buffer-too-small', resolver: null, bytes: bcmBytes };
  }
  const r = resolveBcmSec16(bcmBytes);
  if (!r || !r.bytes || r.blank) {
    return { repaired: false, reason: 'unresolved-or-blank', resolver: r, bytes: bcmBytes };
  }
  if (r.source === 'flat') {
    return { repaired: false, reason: 'flat-only', resolver: r, bytes: bcmBytes };
  }
  const cur = bcmBytes.slice(0x40C9, 0x40D9);
  const expectedLe = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expectedLe[i] = r.bytes[15 - i];
  let same = true;
  for (let i = 0; i < 16; i++) if (cur[i] !== expectedLe[i]) { same = false; break; }
  const oldFlatHex = Array.from(cur).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (same) {
    return { repaired: false, reason: 'already-in-sync', resolver: r, bytes: bcmBytes, oldFlatHex };
  }
  const wr = writeBcmFlatSec16(bcmBytes, r.bytes);
  return {
    repaired: true, reason: 'stale', resolver: r,
    bytes: wr.bytes, source: r.source,
    leHex: wr.leHex.toUpperCase(), sec16Hex: wr.sec16Hex.toUpperCase(),
    oldFlatHex,
  };
}

/* ==========================================================================
 * v2 ENGINE — SINCRO-verified algorithms
 * ========================================================================== */

function engCrc16(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) {
    c ^= b << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c & 0xFFFF;
}

export function engParseBcm(bytes, filename) {
  /* Reject files smaller than a real MPC5605B/06B DFLASH dump. Without this
   * short-circuit the inspector parses partial/EEPROM-slice files and shows
   * misleading "CS ERROR" VIN slots, empty SEC16, and a fake "does not match"
   * verdict — see Task #370. */
  const small = bcmTooSmall(bytes, filename);
  if (small) {
    return {
      ok: false, kind: 'BCM', size: bytes.length,
      tooSmall: true, minSize: small.min, fileExt: small.ext,
      vinSlots: [], vin: null, vinConsistent: false,
      partNumbers: [], supplierSerial: null,
      sec16Records: [], sec16Mirrors: [], sec16Consistent: false, sec16Hex: null, sec16MirrorHex: null,
      banks: null,
    };
  }
  const r = {
    ok: false, kind: 'BCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    partNumbers: [], supplierSerial: null,
    sec16Records: [], sec16Mirrors: [], sec16Consistent: false, sec16Hex: null, sec16MirrorHex: null,
    banks: null,
  };

  const text = new TextDecoder('latin1').decode(bytes);
  r.partNumbers = [...new Set([...text.matchAll(/68\d{6}/g)].map(m => m[0]))];
  const sup = text.match(/TY[A-Z]\d{5}/);
  if (sup) r.supplierSerial = sup[0];

  /* Full VIN slots (00 46 XX 00 + 17 VIN bytes + CRC-16) */
  for (let i = 0; i < bytes.length - 21; i++) {
    if (bytes[i] !== 0x00 || bytes[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(bytes[i+2])) continue;
    if (bytes[i+3] !== 0x00) continue;
    const vs = i + 4;
    if (vs + 19 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = bytes[vs + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    const storedCrc  = (bytes[vs + 17] << 8) | bytes[vs + 18];
    const computedCrc = engCrc16(bytes.slice(vs, vs + 17));
    r.vinSlots.push({ offset: vs, slotType: bytes[i+2], vin, storedCrc, computedCrc, crcOk: storedCrc === computedCrc });
  }

  if (r.vinSlots.length > 0) {
    const c = {}; for (const s of r.vinSlots) c[s.vin] = (c[s.vin] || 0) + 1;
    r.vin = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    r.vinConsistent = Object.keys(c).length === 1;
  }

  /* SEC16 split records (bank 2 at 0x81A0/C0/E0, 7+9 byte format) */
  for (let i = 0; i < bytes.length - 32; i++) {
    if (bytes[i] !== 0xFF || bytes[i+1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (bytes[i+j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = bytes[i+8]; if (idx !== 0x01 && idx !== 0x02) continue;
    if (bytes[i+16] !== 0x04 || bytes[i+17] !== 0x04 || bytes[i+18] !== 0x00 || bytes[i+19] !== 0x14) continue;
    const prefix = bytes.slice(i+9,  i+16);
    const suffix = bytes.slice(i+20, i+29);
    const sec16  = new Uint8Array(16);
    sec16.set(prefix, 0); sec16.set(suffix, 7);
    r.sec16Records.push({ offset: i, format: 'split', idx, sec16, trailer: bytes[i+29] });
  }

  /* Mirror records (slot 0xEB size 0x18, slot 0xCA size 0x28) in either bank */
  const findMirrorsInBank = (bankBase, slotType, sizeByte, kind) => {
    const bankEnd = Math.min(bankBase + 0x4000, bytes.length);
    for (let i = bankBase; i < bankEnd - 32; i++) {
      if (bytes[i]   === 0x00 && bytes[i+1] === 0x00 && bytes[i+2] === 0x00 &&
          bytes[i+3] === sizeByte && bytes[i+4] === 0x00 && bytes[i+5] === 0x46 &&
          bytes[i+6] === slotType && bytes[i+7] === 0x00) {
        const idx   = bytes[i+8];
        const sec16 = bytes.slice(i+9, i+25);
        const allZero = sec16.every(b => b === 0x00);
        const allFf   = sec16.every(b => b === 0xFF);
        const storedCrc = (bytes[i+28] << 8) | bytes[i+29];
        const crcInput  = new Uint8Array(20);
        crcInput[0] = idx;
        for (let k = 0; k < 16; k++) crcInput[1+k] = sec16[k];
        crcInput[17] = bytes[i+25]; crcInput[18] = bytes[i+26]; crcInput[19] = bytes[i+27];
        const computedCrc = engCrc16(crcInput);
        r.sec16Mirrors.push({
          offset: i, kind, slotType, sizeByte, idx, sec16,
          populated: !allZero && !allFf, allZero, allFf,
          storedCrc, computedCrc, crcOk: computedCrc === storedCrc,
          bank: bankBase === 0 ? 'bank0' : 'bank1',
        });
      }
    }
  };
  if (bytes.length >= 0x8000) {
    findMirrorsInBank(0x0000, 0xEB, 0x18, 'mirror1');
    findMirrorsInBank(0x0000, 0xCA, 0x28, 'mirror2');
    findMirrorsInBank(0x4000, 0xEB, 0x18, 'mirror1');
    findMirrorsInBank(0x4000, 0xCA, 0x28, 'mirror2');
  }

  /* Legacy mirror format (older 2014-era BCM family — e.g. 68396563AC on a
   * 2014 LX Charger). These BCMs predate the gen2-split layout and put two
   * SEC16 mirror records at fixed early-flash offsets 0x00C8 and 0x00F0,
   * BEFORE the bank header — none of the bank-scan signatures above will
   * find them. The wizard previously reported "Security token issues
   * detected" on this family because the gen2-split mirror scan came back
   * empty even though both mirrors validate cleanly.
   *
   * Per-record layout (22 bytes, with the next mirror 0x28 bytes later):
   *   +0       idx (1 byte)
   *   +1..+16  SEC16 (16 bytes)
   *   +17      tag 0x8F
   *   +18..+19 padding 0xFF 0xFF
   *   +20..+21 stored CRC-16/CCITT (big-endian) over the first 20 bytes
   *
   * We only push when the 0x8F/0xFF/0xFF tail matches AND the CRC validates,
   * so all-zero or all-0xFF early flash never produces spurious mirrors. */
  const findLegacyMirror = (off) => {
    if (off + 22 > bytes.length) return;
    if (bytes[off + 17] !== 0x8F || bytes[off + 18] !== 0xFF || bytes[off + 19] !== 0xFF) return;
    const idx = bytes[off];
    const sec16 = bytes.slice(off + 1, off + 17);
    const allZero = sec16.every(b => b === 0x00);
    const allFf   = sec16.every(b => b === 0xFF);
    const storedCrc = (bytes[off + 20] << 8) | bytes[off + 21];
    const crcInput = new Uint8Array(20);
    crcInput[0] = idx;
    for (let k = 0; k < 16; k++) crcInput[1 + k] = sec16[k];
    crcInput[17] = 0x8F; crcInput[18] = 0xFF; crcInput[19] = 0xFF;
    const computedCrc = engCrc16(crcInput);
    if (computedCrc !== storedCrc) return;
    r.sec16Mirrors.push({
      offset: off, kind: 'mirror_legacy', slotType: null, sizeByte: null, idx, sec16,
      populated: !allZero && !allFf, allZero, allFf,
      storedCrc, computedCrc, crcOk: true, bank: 'bank0',
    });
  };
  findLegacyMirror(0x00C8);
  findLegacyMirror(0x00F0);

  /* Active / inactive banks */
  if (bytes.length >= 0x8000) {
    const bank0Seq = (bytes[0x0002] << 8) | bytes[0x0003];
    const bank1Seq = (bytes[0x4002] << 8) | bytes[0x4003];
    r.banks = {
      bank0Seq, bank1Seq,
      activeBank:    bank0Seq >= bank1Seq ? 0 : 1,
      inactiveBase:  bank0Seq >= bank1Seq ? 0x4000 : 0x0000,
    };
  }

  /* Summary */
  if (r.sec16Records.length > 0) {
    const hx = r.sec16Records.map(x => [...x.sec16].map(b => b.toString(16).padStart(2,'0')).join(''));
    r.sec16Consistent = hx.every(h => h === hx[0]);
    r.sec16Hex = hx[0];
  }
  const populated = r.sec16Mirrors.filter(m => m.populated && m.crcOk);
  if (populated.length > 0) {
    const mh = [...populated[0].sec16].map(b => b.toString(16).padStart(2,'0')).join('');
    if (!r.sec16Hex) r.sec16Hex = mh;
    r.sec16MirrorHex = mh;
    r.mirrorsPopulated = populated.length;
  }

  r.ok = r.vin !== null;
  return r;
}

export function engParseRfh(bytes, filename) {
  /* Reject files smaller than a real Yazaki FCM EEPROM (Gen1 24C16, 2 KB).
   * Without this short-circuit the inspector parses partial fragments and
   * surfaces misleading "no VIN" / "SEC16 ✗" verdicts — Task #372 (mirror
   * of the BCM guard added in Task #370). */
  const small = moduleTooSmall(bytes, 'RFHUB', filename);
  if (small) {
    return {
      ok: false, kind: 'RFHUB', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      sec16: null, format: 'unknown',
      partNumbers: [], internalSerial: null, keyCount: 0,
    };
  }
  const r = {
    ok: false, kind: 'RFHUB', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    sec16: null, format: 'unknown',
    partNumbers: [], internalSerial: null, keyCount: 0,
  };

  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > bytes.length) continue;
    const raw = bytes.slice(off, off + 17);
    const rev = new Uint8Array(17);
    for (let i = 0; i < 17; i++) rev[i] = raw[16 - i];
    let vin = '', valid = true;
    for (let i = 0; i < 17; i++) {
      const b = rev[i];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    const storedChk = bytes[off + 17];
    let sum = 0; for (const b of raw) sum = (sum + b) & 0xFF;
    const computedChk = (0xF9 - sum) & 0xFF;
    r.vinSlots.push({ offset: off, vin, storedChk, computedChk, chkOk: storedChk === computedChk });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
  }

  /* SEC16 format detection */
  const gen2Hdr = bytes[0x0500] === 0xAA && bytes[0x0501] === 0x55 && bytes[0x0502] === 0x31 && bytes[0x0503] === 0x01;
  const aeq = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  if (gen2Hdr && bytes.length >= 0x0532) {
    const s1 = bytes.slice(0x050E, 0x051E);   /* 16 bytes */
    const s2 = bytes.slice(0x0522, 0x0532);
    const g2Pop = !s1.every(b => b === 0xFF) && !s1.every(b => b === 0x00);
    r.format = 'gen2';
    r.sec16  = { slot1: s1, slot2: s2, match: aeq(s1, s2), virgin: s1.every(b => b === 0xFF), offsets: [0x050E, 0x0522] };
    if (!g2Pop && bytes.length >= 0x024C) {
      /* Gen2 header but Gen2 slots are empty — fall back to reading Gen1 area */
      const g1 = bytes.slice(0x0226, 0x0236);
      if (!g1.every(b => b === 0xFF) && !g1.every(b => b === 0x00)) {
        r.format = 'gen2-hybrid';
      }
    }
  } else if (bytes.length >= 0x024C) {
    const s1 = bytes.slice(0x0226, 0x0236);   /* 16 bytes (skip 2-byte trailer) */
    const s2 = bytes.slice(0x023A, 0x024A);
    r.format = 'gen1';
    r.sec16  = { slot1: s1, slot2: s2, match: aeq(s1, s2), virgin: s1.every(b => b === 0xFF), offsets: [0x0226, 0x023A] };
  }

  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
  const partsSet = new Set();
  (text.match(/(?:AA\d{8}|BA\d{8})/g) || []).forEach(p => partsSet.add(p));
  r.partNumbers = Array.from(partsSet);
  const ser = text.match(/\d{4}[A-Z]\d{3,4}[A-Z]{2}\d{2}[A-Z]/);
  if (ser) r.internalSerial = ser[0];

  const KEY_START = 0x08C0, KEY_END = 0x0A60, KEY_STRIDE = 48;
  for (let off = KEY_START; off < KEY_END && off + 16 < bytes.length; off += KEY_STRIDE) {
    const head = bytes.slice(off, off + 8);
    if (!Array.from(head).every(b => b === 0x50 || b === 0x5A || b === 0xFF)) r.keyCount++;
  }

  r.ok = r.vin !== null;
  return r;
}

export function engParsePcm(bytes, filename) {
  /* Reject files smaller than a real GPEC2A image (4 KB). Partial PCM dumps
   * would otherwise yield empty VIN slot lists and a fake "IMMO ✗" verdict
   * — Task #372. */
  const small = moduleTooSmall(bytes, 'PCM', filename);
  if (small) {
    return {
      ok: false, kind: 'PCM', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      currentVin: null, originalVin: null,
      sec6: null, immoOk: false, immoDamaged: false,
      variant: 'GPEC2A',
      continentalPn: null, osPn: null, bodyPn: null,
      continentalPnCandidates: [], osPnCandidates: [], bodyPnCandidates: [],
    };
  }
  const r = {
    ok: false, kind: 'PCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    currentVin: null, originalVin: null,
    sec6: null, immoOk: false, immoDamaged: false,
    variant: 'GPEC2A',
    continentalPn: null, osPn: null, bodyPn: null,
    /* Task #464 — surface every candidate the regex finds (additive: the
     * chosen value above is still the first match, byte-output unchanged)
     * so the SINCRO-style PICK breakdown can rank a real candidate set
     * instead of scoring a degenerate single-element list. */
    continentalPnCandidates: [], osPnCandidates: [], bodyPnCandidates: [],
  };

  for (const off of PCM_VIN_OFFSETS_GPEC2A) {
    if (off + 17 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < 17; k++) {
      const b = bytes[off + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (valid && VIN_RE.test(vin)) r.vinSlots.push({ offset: off, vin });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
    r.currentVin  = r.vinSlots[0].vin;
    if (r.vinSlots.length > 1) r.originalVin = r.vinSlots[r.vinSlots.length - 1].vin;
  }

  /* SEC6 detection (hardened in Task #396).
   *   1. Canonical 0x3C8 read on 4 KB / 8 KB images — this is the same
   *      offset parseModule.js uses, so a virgin GPEC2A (e.g. the
   *      incident's FF FF 00 FF FF FF) is read from the right slot
   *      instead of being fabricated from FF padding elsewhere.
   *   2. FF FF FF AA marker scan (legacy GPEC2A path).
   *   3. FF FF FF FF marker scan, gated on the populated classifier
   *      so 4 KB virgin padding noise can no longer slip through. */
  if (bytes.length >= 0x3CE) {
    // For any GPEC2A-sized image trust the canonical slot — matches
    // parseModule.js so the wizard, the FCA Analyzer and the AI
    // assistant never disagree about whether SEC6 is populated.
    // Task #404 — also read the FF FF FF AA marker at 0x3C4 so a
    // populated 6-byte secret with a missing marker (the user-reported
    // regression) is correctly flagged as IMMO_DAMAGED.
    const slot = bytes.slice(0x3C8, 0x3CE);
    const markerBytes = bytes.slice(0x3C4, 0x3C8);
    const markerOk = markerBytes[0] === 0xFF && markerBytes[1] === 0xFF
                  && markerBytes[2] === 0xFF && markerBytes[3] === 0xAA;
    r.sec6 = {
      offset: 0x3C8, bytes: slot, marker: 'canonical 0x3C8',
      markerOffset: 0x3C4, markerBytes, markerOk,
    };
  } else {
    // Sub-canonical fragment — fall back to marker scans, gated on
    // the populated classifier so virgin padding noise can no longer
    // slip through (Task #396).
    for (let i = 0; i < bytes.length - 10; i++) {
      if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xAA) {
        const candidate = bytes.slice(i+4, i+10);
        if (classifyPcmSec6(candidate).populated) {
          r.sec6 = { offset: i+4, bytes: candidate, marker: 'FF FF FF AA' };
          break;
        }
      }
    }
    if (!r.sec6) {
      for (let i = 0; i < bytes.length - 20; i++) {
        if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xFF) {
          const n6 = bytes.slice(i+4, i+10);
          if (classifyPcmSec6(n6).populated) {
            r.sec6 = { offset: i+4, bytes: n6, marker: 'FF FF FF FF' };
            break;
          }
        }
      }
    }
  }
  if (r.sec6) {
    r.sec6Class = classifyPcmSec6(r.sec6.bytes);
    // Task #404 — populated 6 bytes alone is not enough; the canonical
    // FF FF FF AA marker at 0x3C4 must also be present for the PCM
    // bootloader (and CGDI/Autel/AlfaOBD/SINCRO) to honor the slot.
    const markerOk = r.sec6.markerOk !== false;
    r.immoOk = r.sec6Class.populated && markerOk;
    r.immoDamaged = !r.immoOk;
    if (r.sec6Class.populated && !markerOk) {
      r.immoLabel = 'SEC6 marker missing (FF FF FF AA expected at 0x3C4)';
    } else {
      r.immoLabel = r.sec6Class.label;
    }
  } else {
    r.sec6Class = classifyPcmSec6(null);
    r.immoOk = false;
    r.immoDamaged = true;
    r.immoLabel = 'DAMAGED / MISSING';
  }

  if (bytes.length > 0x0FB0) {
    const pnB = bytes.slice(0x0FA1, 0x0FAE);
    const pn  = new TextDecoder('latin1').decode(pnB);
    if (/^A2C\d/.test(pn)) r.continentalPn = pn.trim();
  }
  const text = new TextDecoder('latin1').decode(bytes);
  /* Gather every regex hit so the SINCRO-style PICK breakdown can rank
   * the full candidate set (Task #464). The chosen value remains the
   * first hit so the writer's input is unchanged. */
  const osHits   = [...new Set([...text.matchAll(/\b0[0-9]{7}[A-Z]{2}\b/g)].map(m => m[0]))];
  const bpHits   = [...new Set([...text.matchAll(/\b68[0-9]{6}[A-Z]{2}\b/g)].map(m => m[0]))];
  const contHits = [...new Set([...text.matchAll(/\bA2C\d{6,12}\b/g)].map(m => m[0]))];
  r.osPnCandidates   = osHits;
  r.bodyPnCandidates = bpHits;
  /* Prefer the canonical fixed-offset Continental hit when present. */
  r.continentalPnCandidates = r.continentalPn
    ? [r.continentalPn, ...contHits.filter(h => h !== r.continentalPn)]
    : contHits;
  if (osHits.length > 0) r.osPn = osHits[0];
  if (bpHits.length > 0) r.bodyPn = bpHits[0];

  r.ok = r.vin !== null || r.sec6 !== null;
  return r;
}

/* ---------- skip-reason helpers ---------- */

/* Task #433 — single source of truth for "why was PCM SEC6 NOT written?"
 * used by every action that conditionally calls writePcmSec6 (full sync,
 * SEC16-only). Returns null when the SEC6 step is safe to run, or a
 * short human-readable reason string otherwise. Reasons are deliberately
 * the same wording across call sites so users see a consistent line in
 * the sync log: `PCM SEC6 skipped: <reason>`. */
export function pcmSec6SkipReason({ rfh, pcm }) {
  if (!rfh?.bytes)            return 'no RFH file loaded';
  if (!rfh.parsed)            return 'RFH file could not be parsed';
  if (rfh.parsed.format === 'gen1') return 'RFH is Gen1 (need Gen2)';
  const slot1 = rfh.parsed.sec16?.slot1;
  if (!slot1 || slot1.length < 6)   return 'RFH SEC16 not readable';
  if (rfh.parsed.sec16?.virgin)     return 'RFH SEC16 not readable (virgin)';
  if (!pcm?.bytes)            return 'no PCM file loaded';
  if (!pcm.parsed)            return 'PCM file could not be parsed';
  const sz = pcm.bytes.length;
  if (sz !== 4096 && sz !== 8192)
    return `non-canonical PCM size (${sz} B, need 4096 or 8192)`;
  return null;
}

/* ---------- write helpers (SINCRO-verified) ---------- */

function engWriteBcmVin(bytes, newVin) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const vb  = new TextEncoder().encode(newVin);
  const tb  = vb.slice(9, 17);
  const fullCrc = engCrc16(vb);
  const tailCrc = engCrc16(tb);
  let fullPatched = 0, shortPatched = 0;

  for (let i = 0; i < out.length - 21; i++) {
    if (out[i] !== 0x00 || out[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(out[i+2])) continue;
    if (out[i+3] !== 0x00) continue;
    const vs = i + 4; if (vs + 19 > out.length) continue;
    let curr = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = out[vs + k]; if (b < 0x20 || b > 0x7E) { valid = false; break; } curr += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(curr)) continue;
    for (let k = 0; k < 17; k++) out[vs + k] = vb[k];
    out[vs + 17] = (fullCrc >> 8) & 0xFF;
    out[vs + 18] = fullCrc & 0xFF;
    fullPatched++;
  }
  /* Short / tail slots (8-byte VIN tail + 2-byte CRC) */
  for (let i = 0; i < out.length - 14; i++) {
    if (out[i] !== 0x00 || out[i+1] !== 0x46) continue;
    if (out[i+3] !== 0x00) continue;
    const vs = i + 4; if (vs + 10 > out.length) continue;
    let isTail = true, tail = '';
    for (let k = 0; k < 8; k++) {
      const b = out[vs + k];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { isTail = false; break; }
      tail += String.fromCharCode(b);
    }
    if (!isTail) continue;
    let looksFull = vs + 17 <= out.length;
    if (looksFull) {
      for (let k = 8; k < 17; k++) {
        const b = out[vs + k];
        if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) { looksFull = false; break; }
      }
    }
    if (looksFull) continue; /* skip — it's a full slot */
    for (let k = 0; k < 8; k++) out[vs + k] = tb[k];
    out[vs + 8] = (tailCrc >> 8) & 0xFF;
    out[vs + 9] = tailCrc & 0xFF;
    shortPatched++;
  }
  return { bytes: out, fullPatched, shortPatched, crc: fullCrc };
}

function engWriteRfhVin(bytes, newVin, virginize) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const fwd = new TextEncoder().encode(newVin);
  const rev = new Uint8Array(17); for (let i = 0; i < 17; i++) rev[i] = fwd[16 - i];
  let sum = 0; for (const b of rev) sum = (sum + b) & 0xFF;
  const chk = (0xF9 - sum) & 0xFF;
  let patched = 0;
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = rev[k];
    out[off + 17] = chk;
    patched++;
  }
  let sec16Wiped = 0;
  if (virginize) {
    const gen2Hdr = out[0x0500] === 0xAA && out[0x0501] === 0x55;
    const slots = gen2Hdr ? [0x050E, 0x0522] : [0x0226, 0x023A];
    for (const so of slots) {
      if (so + 18 > out.length) continue;
      for (let k = 0; k < 18; k++) out[so + k] = 0xFF;
      sec16Wiped++;
    }
  }
  return { bytes: out, patched, sec16Wiped, chk };
}

/* engWriteBcmSec16Gen2 / engWritePcmSec6 / engWriteRfhSec16FromBcm
 * extracted to lib/securityBytes.js — single source of truth, golden-vector
 * regression test in lib/__tests__/securityBytes.golden.test.js. */
const engWriteBcmSec16Gen2 = writeBcmSec16Gen2;
const engWritePcmSec6      = writePcmSec6;

function engWritePcmVin(bytes, newVin) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const vb  = new TextEncoder().encode(newVin);
  let patched = 0;
  for (const off of PCM_VIN_OFFSETS_GPEC2A) {
    if (off + 17 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = vb[k];
    patched++;
  }
  return { bytes: out, patched };
}

const engWriteRfhSec16FromBcm = writeRfhSec16FromBcm;

/* ==========================================================================
 * VEHICLE CATALOG — part-number awareness
 * ========================================================================== */

/* For 68525720/68525721 the gen is determined by VIN model-year char (see bcmVehicleMatch). */
const BCM_PN_VEHICLES = {
  '68525720':      { name: 'Charger / Challenger / Durango (2011-2014 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68525720_gen2': { name: '2021+ Redeye / Scat Pack · Charger (gen2-split)',      gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68525721':      { name: 'Charger / Challenger / Durango (2011-2014 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68525721_gen2': { name: '2021+ Redeye / Scat Pack · Charger (gen2-split)',      gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68277389': { name: 'Charger / Challenger / Durango (2015-2017 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68396561': { name: 'Charger / Challenger / Durango (2018-2020 LD/LC/WD)', gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68396563': { name: 'Charger / Challenger / Durango (2018-2020 LD/LC/WD)', gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68354769': { name: 'Grand Cherokee Trackhawk (2018-2021 WK2)',             gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68463847': { name: 'Ram 1500 TRX (2021-2024 DT)',                          gen: 'gen2', sec: 'Gen2 SEC16 split' },
};

/* Model-year chars that indicate a 2018+ vehicle (per SAE J681 VIN standard).
 * Used to disambiguate part numbers shared between gen1 and gen2-split Redeye modules. */
const REDEYE_AMBIGUOUS_PNS = ['68525720', '68525721'];
const GEN2_YEAR_CHARS_SYNC = new Set(['J','K','L','M','N','P','R','S','T']);

/* Vehicle family definitions — used for the mismatch warning selector */
const VEHICLE_FAMILIES = [
  { id: 'charger',    label: 'Dodge Charger (LX/LD · 2011–2023)',         expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'challenger', label: 'Dodge Challenger (LC · 2011–2023)',          expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'durango',    label: 'Dodge Durango (WD · 2011–2023)',             expectedPns: ['68525720','68277389','68396561','68396563'] },
  { id: 'trackhawk',  label: 'Grand Cherokee Trackhawk (WK2 · 2018–2021)', expectedPns: ['68354769'] },
  { id: 'trx',        label: 'Ram 1500 TRX (DT · 2021–2024)',              expectedPns: ['68463847'] },
];

function bcmVehicleMatch(parsedBcm) {
  if (!parsedBcm || !parsedBcm.partNumbers) return null;
  /* Extract model-year char from the parsed VIN (10th character, index 9). */
  const vinYearChar = parsedBcm.vin ? parsedBcm.vin[9] : null;
  for (const pn of parsedBcm.partNumbers) {
    const trimmed = pn.replace(/[^0-9]/g, '');
    if (REDEYE_AMBIGUOUS_PNS.includes(trimmed)) {
      const isGen2 = vinYearChar && GEN2_YEAR_CHARS_SYNC.has(vinYearChar.toUpperCase());
      const key = isGen2 ? trimmed + '_gen2' : trimmed;
      if (BCM_PN_VEHICLES[key]) return { pn: trimmed, ...BCM_PN_VEHICLES[key] };
    }
    if (BCM_PN_VEHICLES[trimmed]) return { pn: trimmed, ...BCM_PN_VEHICLES[trimmed] };
  }
  return null;
}

function bcmFamilyMismatch(parsedBcm, familyId) {
  if (!familyId || !parsedBcm?.partNumbers?.length) return null;
  const family = VEHICLE_FAMILIES.find(f => f.id === familyId);
  if (!family) return null;
  const detected = parsedBcm.partNumbers.map(p => p.replace(/[^0-9]/g, ''));
  const match = family.expectedPns.some(ep => detected.includes(ep));
  if (match) return { match: true, family, detected };
  return { match: false, family, detected, expected: family.expectedPns };
}

/* ==========================================================================
 * UTILITIES
 * ========================================================================== */

function hex2(n)  { return n.toString(16).toUpperCase().padStart(2,  '0'); }
function hex4(n)  { return n.toString(16).toUpperCase().padStart(4,  '0'); }
function bytesToHex(b) { return Array.from(b).map(hex2).join(''); }

/* fmtOff (Task #464) — combined hex + decimal offset render. Mirrors the
 * FCA SINCRO reference tool's compact "0x1328 (4904)" notation so a tech
 * reading the screen alongside a hex editor doesn't have to convert in
 * their head. Centralised here so every place ModuleSync renders an
 * offset stays identical, and reused by the offset-formatter unit test. */
export function fmtOff(o) {
  if (o == null || (typeof o === 'number' && !Number.isFinite(o))) return '—';
  const n = Number(o);
  if (Number.isNaN(n)) return '—';
  const hex = n.toString(16).toUpperCase().padStart(4, '0');
  return `0x${hex} (${n})`;
}
function timestamp() {
  const d = new Date(), p = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function downloadBin(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  trackDownload(ASSET_IDS.modSyncPatched);
}

/* ==========================================================================
 * UI COMPONENTS
 * ========================================================================== */

/* ConnectionGuides (Task #464) — compact per-module link row for the bench
 * tools / programmers a tech is most likely to be holding. Surfaces the
 * MODULE_CONNECTION_GUIDES table from programmerData.js so a Charger /
 * Challenger LX workflow shows: BCM (MPC560xB) → MULTIPROG · UPA, PCM
 * (GPEC2A) → GODIAG, RFH (9S12X) → MULTIPROG · UPA · OBDSTAR. The row
 * collapses to a vertical stack on narrow widths and is purely advisory —
 * it never blocks any sync action. */
function ConnectionGuides() {
  return (
    <div data-testid="modsync-connection-guides" style={{
      display: 'flex', flexWrap: 'wrap', gap: 14,
      padding: '10px 14px', marginBottom: 12,
      background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 10,
      fontSize: 11,
    }}>
      <div style={{ fontWeight: 800, color: C.ts, letterSpacing: 0.6, textTransform: 'uppercase', alignSelf: 'center', whiteSpace: 'nowrap' }}>
        🛠 Connection Guides
      </div>
      {MODULE_CONNECTION_GUIDES.map(group => (
        <div key={group.module}
             data-testid={`modsync-guides-${group.module.toLowerCase()}`}
             style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, color: C.tx }}>{group.label}</span>
          <span style={{ color: C.tm }}>→</span>
          {group.guides.map((g, idx) => {
            const prog = PROGRAMMERS[g.programmer];
            const label = prog?.label || g.programmer;
            return (
              <React.Fragment key={g.programmer}>
                {idx > 0 && <span style={{ color: C.tm, fontSize: 10 }}>·</span>}
                <a href={g.url} target="_blank" rel="noopener noreferrer"
                   data-testid={`modsync-guide-link-${group.module.toLowerCase()}-${g.programmer.toLowerCase()}`}
                   title={`${group.label} — ${label} (${prog?.vendor || ''}) connection guide`}
                   style={{
                     color: C.a3, textDecoration: 'none', fontWeight: 700,
                     padding: '2px 6px', borderRadius: 4,
                     border: `1px solid ${C.a3}30`, background: C.cd,
                   }}>
                  {label}
                </a>
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DropZone({ label, icon, hint, file, onFile, accent }) {
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const loaded  = file != null;
  const handle  = async (f) => {
    const buf = await f.arrayBuffer();
    onFile(f, new Uint8Array(buf));
  };
  const border  = loaded ? C.gn : over ? (accent || C.sr) : C.bd;
  return (
    <div
      onClick={() => fileRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); }}
      style={{
        background: loaded ? 'rgba(0,200,83,0.03)' : over ? 'rgba(211,47,47,0.03)' : C.cd,
        border: `2px ${loaded ? 'solid' : 'dashed'} ${border}`,
        borderRadius: 14, padding: '22px 14px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.2s',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 5 }}>{icon}</div>
      <div style={{ fontFamily: "'Nunito'", fontWeight: 800, fontSize: 13, letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.tm, marginTop: 4 }}>{hint}</div>
      {loaded && (
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, marginTop: 6, color: C.gn, fontWeight: 600, wordBreak: 'break-all' }}>
          {file.name} · {(file.size / 1024).toFixed(1)} KB
        </div>
      )}
      <input ref={fileRef} type="file" accept=".bin,.BIN,.eprom" style={{ display: 'none' }}
             onChange={e => { if (e.target.files[0]) handle(e.target.files[0]); }} />
    </div>
  );
}

function Kv({ k, v, mono = false, hint, color }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '3px 10px', fontSize: 12, marginBottom: 5, alignItems: 'start' }}>
      <div style={{ color: C.ts, fontWeight: 600 }}>{k}</div>
      <div style={{
        fontFamily: mono ? "'JetBrains Mono'" : "'Nunito'", fontWeight: 600,
        color: color || (v ? C.tx : C.tm), fontStyle: v ? 'normal' : 'italic',
        fontSize: mono ? 11 : 12, wordBreak: 'break-all',
      }}>
        {v || 'none'}{hint && <span style={{ color: C.tm, fontSize: 10, marginLeft: 6 }}>{hint}</span>}
      </div>
    </div>
  );
}

function Badge({ text, color = C.gn }) {
  return (
    <span style={{
      fontSize: 9, padding: '2px 7px', borderRadius: 4, letterSpacing: 0.6,
      background: color, color: '#fff', fontWeight: 700, marginLeft: 4,
    }}>{text}</span>
  );
}

function PnOverrideBadge() {
  return (
    <span data-testid="modsync-pn-override-pill" style={{
      fontSize: 9, padding: '2px 7px', borderRadius: 999, letterSpacing: 0.6,
      background: C.wn + '22', border: '1px solid ' + C.wn + '66', color: C.wn,
      fontWeight: 800, marginLeft: 4,
    }}>P/N OVERRIDE</span>
  );
}

/* OffsetList (Task #464) — small dimmed mono row that lists each slot's
 * canonical hex+decimal offset under a Kv summary line. Centralises the
 * styling so BCM / RFH / PCM cards stay visually consistent. */
function OffsetList({ offsets, testid }) {
  if (!offsets || offsets.length === 0) return null;
  return (
    <div data-testid={testid} style={{
      fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'",
      marginTop: -2, marginBottom: 6, paddingLeft: 130, lineHeight: 1.5,
      wordBreak: 'break-all',
    }}>
      {offsets.map(o => fmtOff(o)).join(' · ')}
    </div>
  );
}

/* PickBreakdown (Task #464) — dimmed one-liner under each module panel
 * showing the SINCRO-style "PICK score X — useful Y, ratio Z, len N, pr R"
 * scoring breakdown for a single field (PN / Serial / OS). The kind label
 * lets a tech see at a glance which field the score belongs to without
 * pushing the breakdown into a popup. */
function PickBreakdown({ kind, value, breakdown, testid }) {
  if (!value || !breakdown) return null;
  return (
    <div data-testid={testid} style={{
      fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'",
      marginTop: 2, lineHeight: 1.5, paddingLeft: 130,
    }}>
      <span style={{ color: C.ts, fontWeight: 700, marginRight: 6 }}>{kind}</span>
      <span style={{ color: C.tx }}>{value}</span>
      <span style={{ marginLeft: 6, color: C.tm }}>— {fmtPick(breakdown)}</span>
    </div>
  );
}

/* buildCandidateList (Task #464) — turns the raw multi-candidate array
 * the parser already gathered into the shape pickBest() expects, tagging
 * each entry with its precedenceRank (1.0 for the canonical-offset hit
 * sitting at index 0, 0.5 for fallback regex hits further down the list)
 * and a matchesCanonical flag so the SINCRO-style +100 bonus fires for
 * the right entries. The chosen winner the picker returns is what gets
 * rendered in the PickBreakdown line, replacing the previous behaviour
 * of "trust the parser's first hit, then score it after the fact". */
function buildCandidateList(values, canonicalRegex) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values.map((v, idx) => ({
    value: v,
    precedenceRank: idx === 0 ? 1.0 : 0.5,
    matchesCanonical: canonicalRegex ? canonicalRegex.test(String(v)) : false,
  }));
}

function BcmCard({ parsed, pnOverride }) {
  if (!parsed) return null;
  if (parsed.tooSmall) {
    return (
      <div data-testid="bcm-too-small-card" style={{ background: 'rgba(255,23,68,0.05)', borderRadius: 12, padding: 16, border: `2px solid ${C.er}`, gridColumn: '1 / -1' }}>
        <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: C.er, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          ⛔ This isn&apos;t a full BCM dump
          <Badge text="REJECTED" color={C.er} />
        </div>
        <Kv k="File size"   v={`${parsed.size.toLocaleString()} bytes`} mono color={C.er} />
        <Kv k="Required min" v={`${parsed.minSize.toLocaleString()} bytes (64 KB MPC5605B/06B DFLASH)`} mono />
        <Kv k="Detected ext" v={parsed.fileExt || '(none)'} mono />
        <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(255,23,68,0.08)', border: `1px solid ${C.er}55`, borderRadius: 8, fontSize: 12, color: C.tx, lineHeight: 1.5, fontWeight: 600 }}>
          Re-read the BCM in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.
        </div>
      </div>
    );
  }
  const match   = bcmVehicleMatch(parsed);
  const isGen2  = parsed.sec16Records.length > 0 || (match && match.gen === 'gen2');
  const hasSec16 = parsed.sec16Hex || parsed.sec16MirrorHex;

  let status = 'READY', statusColor = C.gn;
  if (!parsed.ok)             { status = 'NO VIN';         statusColor = C.er; }
  else if (!parsed.vinConsistent) { status = 'SLOT MISMATCH';  statusColor = C.wn; }

  return (
    <div style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${statusColor}40` }}>
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        🧠 BCM · MPC5606B
        <Badge text={status} color={statusColor} />
        {isGen2 && <Badge text="GEN2" color={C.a4} />}
        {pnOverride && <PnOverrideBadge />}
      </div>
      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this BCM bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}
      <Kv k="Stored VIN"   v={parsed.vin} mono />
      <Kv k="VIN slots"    v={`${parsed.vinSlots.length} / 4 · ${parsed.vinConsistent ? 'all match' : 'MISMATCH'}`} />
      <OffsetList offsets={parsed.vinSlots.map(s => s.offset)} testid="bcm-vin-slot-offsets" />
      <Kv k="File size"    v={`${parsed.size} bytes (${(parsed.size/1024).toFixed(1)} KB)`} mono />
      {parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.crcOk);
        const crc   = parsed.vinSlots[0].computedCrc;
        return <Kv k="VIN CRC-16" v={`0x${hex4(crc)} · ${allOk ? '✓ valid' : '✗ mismatch'}`} mono color={allOk ? C.gn : C.er} />;
      })()}
      {match && <Kv k="Vehicle"  v={match.name} />}
      {parsed.partNumbers.length > 0 && (
        <>
          <Kv k="Part numbers" v={parsed.partNumbers.join(', ')} mono />
          {(() => {
            /* Real picker flow — rank every candidate the parser gathered, then render
             * the winner with its breakdown so the chosen value is the actual top scorer. */
            const { winner } = pickBest(buildCandidateList(parsed.partNumbers, CANONICAL_PATTERNS.bcmPn));
            return <PickBreakdown kind="PN"  value={winner?.value} breakdown={winner} testid="bcm-pn-pick" />;
          })()}
        </>
      )}
      {parsed.supplierSerial && (
        <>
          <Kv k="Supplier" v={parsed.supplierSerial} mono />
          {(() => {
            const { winner } = pickBest(buildCandidateList([parsed.supplierSerial], CANONICAL_PATTERNS.serial));
            return <PickBreakdown kind="Serial" value={winner?.value} breakdown={winner} testid="bcm-serial-pick" />;
          })()}
        </>
      )}
      {parsed.banks && (
        <Kv k="Active bank" v={`Bank ${parsed.banks.activeBank} (seq 0x${hex4(parsed.banks.activeBank === 0 ? parsed.banks.bank0Seq : parsed.banks.bank1Seq)})`} mono />
      )}
      {parsed.sec16Records.length > 0 && (
        <>
          <div style={{ marginTop: 8, borderTop: `1px solid ${C.bd}`, paddingTop: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: 0.8, color: C.a4, marginBottom: 4 }}>
              SEC16 SPLIT RECORDS
              <Badge text={`${parsed.sec16Records.length} found`} color={parsed.sec16Consistent ? C.gn : C.wn} />
            </div>
            <Kv k="Consistent" v={parsed.sec16Consistent ? '✓ All match' : '✗ MISMATCH'} color={parsed.sec16Consistent ? C.gn : C.er} />
            {/* Task #464 — SINCRO-style hex+decimal offsets for every split record so
                a tech can cross-reference the canonical 0x81A0/C0/E0 trio against the
                raw dump in their hex viewer without reaching for a calculator. */}
            <OffsetList offsets={parsed.sec16Records.map(x => x.offset)} testid="bcm-sec16-split-offsets" />
            {parsed.sec16Hex && <Kv k="SEC16 hex" v={parsed.sec16Hex.toUpperCase()} mono />}
          </div>
        </>
      )}
      {parsed.sec16Mirrors.length > 0 && (
        <>
          <Kv k="Mirror recs"
              v={`${parsed.mirrorsPopulated || 0} populated · ${parsed.sec16Mirrors.filter(m => m.crcOk).length} CRC OK`}
              color={parsed.mirrorsPopulated > 0 ? C.gn : C.tm} />
          {/* Task #464 — mirror record offsets in the same hex+decimal format
              so the bank-0 / bank-4000 mirror search results are visible at a
              glance instead of being summarised behind a count. */}
          <OffsetList offsets={parsed.sec16Mirrors.map(m => m.offset)} testid="bcm-sec16-mirror-offsets" />
        </>
      )}
      {!hasSec16 && isGen2 && (
        <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(255,179,0,0.08)', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ Gen2 BCM — no SEC16 records found. May need a different flash layout.
        </div>
      )}
    </div>
  );
}

function TooSmallCard({ parsed, moduleLabel, testid }) {
  /* Shared rendering for RFHUB / PCM / 95640 undersized dumps — mirrors the
   * BcmCard branch added for Task #370 so techs see the same wording, the
   * same fields (size · required min · detected ext), and the same recovery
   * guidance regardless of which slot the bad file landed in. */
  return (
    <div data-testid={testid} style={{ background: 'rgba(255,23,68,0.05)', borderRadius: 12, padding: 16, border: `2px solid ${C.er}`, gridColumn: '1 / -1' }}>
      <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: C.er, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        ⛔ This isn&apos;t a full {moduleLabel} dump
        <Badge text="REJECTED" color={C.er} />
      </div>
      <Kv k="File size"   v={`${parsed.size.toLocaleString()} bytes`} mono color={C.er} />
      <Kv k="Required min" v={`${parsed.minSize.toLocaleString()} bytes${parsed.minLabel ? ` (${parsed.minLabel})` : ''}`} mono />
      <Kv k="Detected ext" v={parsed.fileExt || '(none)'} mono />
      <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(255,23,68,0.08)', border: `1px solid ${C.er}55`, borderRadius: 8, fontSize: 12, color: C.tx, lineHeight: 1.5, fontWeight: 600 }}>
        Re-read the {moduleLabel} in full or load the correct file — this looks like a fragment, an EEPROM slice, or the wrong module.
      </div>
    </div>
  );
}

function RfhCard({ parsed, pnOverride }) {
  if (!parsed) return null;
  if (parsed.tooSmall) return <TooSmallCard parsed={parsed} moduleLabel="RFHUB" testid="rfh-too-small-card" />;
  const isVirgin = parsed.sec16?.virgin;
  const isMatch  = parsed.sec16?.match;
  let status = 'READY', statusColor = C.gn;
  if (!parsed.ok)                { status = 'NO VIN';    statusColor = C.er; }
  else if (!parsed.vinConsistent){ status = 'MISMATCH';  statusColor = C.wn; }
  else if (isVirgin)             { status = 'SEC16 VIRGIN'; statusColor = C.wn; }
  else if (!isMatch)             { status = 'SEC16 ≠';   statusColor = C.wn; }

  return (
    <div style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${statusColor}40` }}>
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        🔑 RFHUB · Yazaki FCM
        <Badge text={status} color={statusColor} />
        {parsed.format && <Badge text={parsed.format.toUpperCase()} color={parsed.format === 'gen2' ? C.a4 : C.a3} />}
        {pnOverride && <PnOverrideBadge />}
      </div>
      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this RFHUB bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}
      <Kv k="Stored VIN"  v={parsed.vin} mono />
      <Kv k="VIN slots"   v={`${parsed.vinSlots.length} / 4 · ${parsed.vinConsistent ? 'all match' : 'MISMATCH'}`} />
      <OffsetList offsets={parsed.vinSlots.map(s => s.offset)} testid="rfh-vin-slot-offsets" />
      <Kv k="File size"   v={`${parsed.size} bytes`} mono />
      {parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.chkOk);
        const chk   = parsed.vinSlots[0].computedChk;
        return <Kv k="VIN checksum" v={`0x${hex2(chk)} · ${allOk ? '✓ valid' : '⚠ mismatch'}`} mono color={allOk ? C.gn : C.wn} />;
      })()}
      {parsed.partNumbers.length > 0 && (
        <>
          <Kv k="Part numbers" v={parsed.partNumbers.join(', ')} mono />
          {(() => {
            const { winner } = pickBest(buildCandidateList(parsed.partNumbers, CANONICAL_PATTERNS.rfhPn));
            return <PickBreakdown kind="PN"  value={winner?.value} breakdown={winner} testid="rfh-pn-pick" />;
          })()}
        </>
      )}
      {parsed.internalSerial && (
        <>
          <Kv k="Serial" v={parsed.internalSerial} mono />
          {(() => {
            const { winner } = pickBest(buildCandidateList([parsed.internalSerial], CANONICAL_PATTERNS.serial));
            return <PickBreakdown kind="Serial" value={winner?.value} breakdown={winner} testid="rfh-serial-pick" />;
          })()}
        </>
      )}
      <Kv k="Keys stored"   v={`${parsed.keyCount} slot${parsed.keyCount === 1 ? '' : 's'} populated`} />

      {parsed.sec16 && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${C.bd}`, paddingTop: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: 0.8, color: C.a4, marginBottom: 4 }}>
            SEC16 · {parsed.format === 'gen2' ? `${fmtOff(0x050E)} / ${fmtOff(0x0522)}` : `${fmtOff(0x0226)} / ${fmtOff(0x023A)}`}
          </div>
          {/* Task #464 — surface the slot-pair agreement at the top of the
              SEC16 panel so a tech can see at a glance whether the two RFH
              SEC16 slots are byte-for-byte identical. The reference SINCRO
              tool prints "Slots match: yes/no" before the slot bytes; we
              mirror that ordering for parity. */}
          <div data-testid="rfh-sec16-slots-match">
            <Kv k="Slots match"
                v={isVirgin ? 'n/a (virgin)' : (isMatch ? 'yes' : 'no')}
                color={isVirgin ? C.wn : (isMatch ? C.gn : C.er)} />
          </div>
          <Kv k="Status"  v={isVirgin ? 'VIRGIN (all FF)' : isMatch ? '✓ MATCH' : '✗ MISMATCH'}
              color={isVirgin ? C.wn : isMatch ? C.gn : C.er} />
          <Kv k="Slot 1"  v={parsed.sec16.slot1 ? bytesToHex(parsed.sec16.slot1).toUpperCase() : null} mono />
          {!isMatch && <Kv k="Slot 2"  v={parsed.sec16.slot2 ? bytesToHex(parsed.sec16.slot2).toUpperCase() : null} mono />}
        </div>
      )}
    </div>
  );
}

export function PcmCard({ parsed, bytes, pnOverride }) {
  if (!parsed) return null;
  if (parsed.tooSmall) return <TooSmallCard parsed={parsed} moduleLabel="PCM" testid="pcm-too-small-card" />;
  let status = 'READY', statusColor = C.gn;
  if (!parsed.ok)         { status = 'UNKNOWN';     statusColor = C.wn; }
  if (!parsed.immoOk)     { status = 'IMMO ✗';      statusColor = C.er; }
  if (parsed.immoDamaged) { status = 'DAMAGED';      statusColor = C.er; }
  if (parsed.ok && parsed.immoOk) { status = 'READY'; statusColor = C.gn; }

  return (
    <div style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${statusColor}40` }}>
      {(() => {
        // Task #379: surface a structured mismatch-guard card when the loaded
        // PCM is a doubled 8 KB capture whose half-2 is all 0xFF. The CGDI
        // flasher rejects the wrong-sized image with "File different size,"
        // so we tell the user up-front that SYNC will emit a 4 KB output for
        // a 95320 bench (auto-slice happens in executeSync('sync-all')).
        if (parsed.size === 8192) {
          // engParsePcm doesn't carry the raw buffer in its result, so accept
          // the bytes via prop (mirrors how downstream SYNC reads pcm.bytes).
          const half2 = bytes && bytes.slice ? bytes.slice(4096) : null;
          const halfPad = half2 && half2.every ? half2.every((b) => b === 0xFF) : false;
          if (halfPad) {
            return (
              <div data-testid="pcm-doubled-mismatch-card" style={{ marginBottom: 10, padding: '10px 12px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700, lineHeight: 1.5 }}>
                ⚠ Doubled 8 KB capture detected (half-2 is 0xFF padding). On SYNC, only the first 4 KB will be written so it fits a 95320 bench chip and CGDI doesn&apos;t reject with &quot;File different size.&quot;
              </div>
            );
          }
        }
        if (!pcmChipFromSize(parsed.size)) {
          return (
            <div data-testid="pcm-chip-mismatch-card" style={{ marginBottom: 10, padding: '10px 12px', background: C.er + '14', border: '1px solid ' + C.er + '55', borderRadius: 8, fontSize: 11, color: C.er, fontWeight: 700, lineHeight: 1.5 }}>
              ⛔ This PCM is {parsed.size} bytes — neither 4 KB (95320) nor 8 KB (95640). The CGDI flasher will refuse it. Re-read the PCM in full or load the matching virgin before SYNC.
            </div>
          );
        }
        return null;
      })()}
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        ⚙️ PCM · Continental
        <Badge text={status} color={statusColor} />
        <Badge text={parsed.variant} color={C.a1} />
        {(() => {
          const chip = pcmChipFromSize(parsed.size);
          if (chip) return <span data-testid="pcm-chip-badge" data-chip={chip.chip} data-chip-key={chip.chipKey}><Badge text={chip.label} color={C.a4} /></span>;
          return <span data-testid="pcm-chip-badge" data-chip="UNKNOWN"><Badge text={`${parsed.size} B · UNKNOWN CHIP`} color={C.wn} /></span>;
        })()}
        {pnOverride && <PnOverrideBadge />}
      </div>
      {pnOverride && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: C.wn + '14', border: '1px solid ' + C.wn + '55', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ P/N override active — this PCM bypassed the registry compatibility check on the Dumps tab.
        </div>
      )}
      <Kv k="Current VIN"  v={parsed.currentVin || parsed.vin} mono />
      {parsed.originalVin && parsed.originalVin !== parsed.currentVin &&
        <Kv k="Original VIN" v={parsed.originalVin} mono color={C.wn} hint="← donor VIN" />}
      <Kv k="VIN slots"    v={`${parsed.vinSlots.length} found`} />
      <OffsetList offsets={parsed.vinSlots.map(s => s.offset)} testid="pcm-vin-slot-offsets" />
      <Kv k="File size"    v={`${parsed.size} bytes (${(parsed.size/1024).toFixed(1)} KB)`} mono />
      <Kv k="Immo (SEC6)"  v={parsed.immoLabel || (parsed.immoDamaged ? 'DAMAGED / MISSING' : parsed.immoOk ? '✓ Populated' : 'Virgin (all FF)')}
          color={parsed.immoOk ? C.gn : (parsed.sec6Class && parsed.sec6Class.label === 'MISSING') ? C.er : C.wn} />
      {parsed.sec6 && (
        <>
          <Kv k="SEC6 marker" v={parsed.sec6.marker} mono />
          {parsed.sec6.markerBytes && (
            <Kv
              k={`Marker @${fmtOff(parsed.sec6.markerOffset ?? 0x3C4)}`}
              v={(parsed.sec6.markerOk ? '✓ ' : '✗ ') + bytesToHex(parsed.sec6.markerBytes).toUpperCase() + (parsed.sec6.markerOk ? ' (canonical FF FF FF AA)' : ' (expected FF FF FF AA)')}
              mono
              color={parsed.sec6.markerOk ? C.gn : C.er}
            />
          )}
          <Kv k={`SEC6 bytes @${fmtOff(parsed.sec6.offset ?? 0x3C8)}`}
              v={bytesToHex(parsed.sec6.bytes).toUpperCase()} mono />
          {/* Task #464 — explain in plain language how the SEC6 secret bytes
              are derived from the BCM SEC16 so a tech who's never read the
              SINCRO source still understands what BCM→PCM SEC6 sync does:
              it byte-reverses the BCM SEC16 record and writes the first 6
              bytes into the PCM at this offset. */}
          <div data-testid="pcm-sec6-derived-rule" style={{
            marginTop: 4, paddingLeft: 130, fontSize: 10, color: C.tm,
            fontFamily: "'JetBrains Mono'", lineHeight: 1.5,
          }}>
            Derived rule: first 6 bytes of byte-reversed BCM SEC16
          </div>
          {parsed.sec6.markerBytes && !parsed.sec6.markerOk && parsed.sec6Class && parsed.sec6Class.populated && (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: C.er + '14', border: '1px solid ' + C.er + '55', fontSize: 11, color: C.tx, lineHeight: 1.45 }}>
              <span style={{ color: C.er, fontWeight: 800 }}>⚠ Secret bytes present but marker missing</span> — apply BCM→PCM SEC6 sync to restamp the canonical FF FF FF AA marker @ {fmtOff(0x3C4)}.
            </div>
          )}
        </>
      )}
      {parsed.continentalPn && (
        <>
          <Kv k="Continental PN" v={parsed.continentalPn} mono />
          {(() => {
            const list = parsed.continentalPnCandidates && parsed.continentalPnCandidates.length > 0
              ? parsed.continentalPnCandidates : [parsed.continentalPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmContPn));
            return <PickBreakdown kind="Cont" value={winner?.value} breakdown={winner} testid="pcm-cont-pick" />;
          })()}
        </>
      )}
      {parsed.osPn && (
        <>
          <Kv k="OS PN"   v={parsed.osPn}   mono />
          {(() => {
            const list = parsed.osPnCandidates && parsed.osPnCandidates.length > 0
              ? parsed.osPnCandidates : [parsed.osPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmOsPn));
            return <PickBreakdown kind="OS" value={winner?.value} breakdown={winner} testid="pcm-os-pick" />;
          })()}
        </>
      )}
      {parsed.bodyPn && (
        <>
          <Kv k="Body PN" v={parsed.bodyPn} mono />
          {(() => {
            const list = parsed.bodyPnCandidates && parsed.bodyPnCandidates.length > 0
              ? parsed.bodyPnCandidates : [parsed.bodyPn];
            const { winner } = pickBest(buildCandidateList(list, CANONICAL_PATTERNS.pcmBodyPn));
            return <PickBreakdown kind="PN" value={winner?.value} breakdown={winner} testid="pcm-pn-pick" />;
          })()}
        </>
      )}
    </div>
  );
}

function VinDiffTable({ rows }) {
  if (!rows || rows.length === 0) return null;
  const changed  = rows.filter(r => r.oldVin !== r.newVin);
  const allPass  = rows.every(r => r.newPass);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 900, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#9E9E9E', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>VIN Slot Diff</span>
        <span style={{
          marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, fontSize: 10,
          fontWeight: 700, letterSpacing: 0.5,
          background: allPass ? 'rgba(0,200,83,0.15)' : 'rgba(255,23,68,0.15)',
          color: allPass ? '#4ADE80' : '#F87171',
        }}>
          {allPass ? '✓ ALL SLOTS PASS' : '✗ CHECK FAILED'}
        </span>
      </div>
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1.5px solid #2A2F36' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'JetBrains Mono'", fontSize: 10.5, color: '#E0E0E0', background: '#0F1419' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2F36', background: '#161C24' }}>
              {['Module', 'Slot', 'Offset', 'Old VIN', 'New VIN', 'Old Chk', 'New Chk', 'Status'].map(h => (
                <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#6B7280' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const vinChanged = r.oldVin !== r.newVin;
              const modColor = r.module === 'BCM' ? '#60A5FA' : r.module === 'PCM' ? '#FB923C' : '#C084FC';
              return (
                <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid #1E252D' : 'none', background: vinChanged ? 'rgba(255,109,0,0.06)' : 'transparent' }}>
                  <td style={{ padding: '7px 10px', color: modColor, fontWeight: 700, fontSize: 10 }}>{r.module}</td>
                  <td style={{ padding: '7px 10px', color: '#6B7280' }}>#{r.slot}</td>
                  <td style={{ padding: '7px 10px', color: '#9CA3AF' }}>{r.offset}</td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#F87171' : '#6B7280', letterSpacing: 1.5 }}>{r.oldVin || '—'}</td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#4ADE80' : '#6B7280', fontWeight: vinChanged ? 700 : 400, letterSpacing: 1.5 }}>{r.newVin}</td>
                  <td style={{ padding: '7px 10px', color: r.oldPass === true ? '#4ADE80' : r.oldPass === false ? '#F87171' : '#6B7280' }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>{r.oldCheck}
                    {r.oldPass === false && <span style={{ color: '#F87171', marginLeft: 4, fontSize: 9 }}>✗</span>}
                    {r.oldPass === true  && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#4ADE80', fontWeight: 700 }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>{r.newCheck}
                    {r.newPass && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    {vinChanged
                      ? <span style={{ background: 'rgba(74,222,128,0.15)', color: '#4ADE80', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>PATCHED</span>
                      : <span style={{ background: 'rgba(107,114,128,0.15)', color: '#6B7280', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>NO CHANGE</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {changed.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#6B7280', fontFamily: "'JetBrains Mono'" }}>
          {changed.length} slot{changed.length !== 1 ? 's' : ''} patched
          {rows.length - changed.length > 0 ? ` · ${rows.length - changed.length} already matched` : ''}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ title, desc, enabled, onClick, color }) {
  const [h, setH] = useState(false);
  const ac = color || C.sr;
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        padding: '14px 16px', borderRadius: 12, border: `2px solid ${h && enabled ? ac : C.bd}`,
        background: h && enabled ? `${ac}08` : C.cd,
        cursor: enabled ? 'pointer' : 'not-allowed', textAlign: 'left',
        transition: 'all 0.15s', fontFamily: "'Nunito'", color: C.tx,
        opacity: enabled ? 1 : 0.35, transform: h && enabled ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: 0.8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {title}<span style={{ marginLeft: 'auto', fontSize: 14, opacity: 0.5 }}>›</span>
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginTop: 4, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

/* ==========================================================================
 * MAIN COMPONENT
 * ========================================================================== */

/* 95640 BCM-backup EEPROM parser.
 *  · VIN slots at 0x275 / 0x288 with crc8 at off-1 (we don't recompute CRC8 here)
 *  · 16-byte secret key at 0x40-0x4F
 *  · BCM-SEC16 token at 0x838 (16 bytes), big-endian CRC16 at 0x848-0x849
 * The 95640 stores the SEC16 byte-reversed compared to the RFHUB SEC16, which
 * is why "Re-key 95640 from RFHUB" reverses the RFH SEC16 before writing.
 */
export function engParseEep95640(bytes, filename) {
  /* Reject files smaller than a canonical 95640 backup chip (8 KB). A
   * truncated dump would silently miss the SEC16 region (0x838) and the
   * VIN slots, so the inspector should refuse it up front — Task #372. */
  const small = moduleTooSmall(bytes, '95640', filename);
  if (small) {
    return {
      ok: false, kind: '95640', size: bytes ? bytes.length : 0,
      tooSmall: true, minSize: small.min, fileExt: small.ext, minLabel: small.label,
      vinSlots: [], vin: null, vinConsistent: false,
      secretKey: null, secretKeyHex: null, secretKeyBlank: true,
      bcmSec16: null, bcmSec16Hex: null, bcmSec16Blank: true,
      bcmSec16StoredCrc: null, bcmSec16CalcCrc: null, bcmSec16CrcOk: false,
      bcmSec16ReversedHex: null,
    };
  }
  const r = {
    ok: false, kind: '95640', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    secretKey: null, secretKeyHex: null, secretKeyBlank: true,
    bcmSec16: null, bcmSec16Hex: null, bcmSec16Blank: true,
    bcmSec16StoredCrc: null, bcmSec16CalcCrc: null, bcmSec16CrcOk: false,
    bcmSec16ReversedHex: null,
  };
  for (const off of [0x275, 0x288]) {
    if (off + 17 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < 17; k++) {
      const b = bytes[off + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    r.vinSlots.push({ offset: off, vin });
  }
  if (r.vinSlots.length > 0) {
    r.vin = r.vinSlots[0].vin;
    r.vinConsistent = r.vinSlots.every(s => s.vin === r.vin);
  }
  if (bytes.length >= 0x50) {
    const k = bytes.slice(0x40, 0x50);
    r.secretKey = k;
    r.secretKeyHex = bytesToHex(k).toUpperCase();
    r.secretKeyBlank = k.every(b => b === 0xFF) || k.every(b => b === 0x00);
  }
  if (bytes.length >= 0x84A) {
    const s16 = bytes.slice(0x838, 0x848);
    r.bcmSec16 = s16;
    r.bcmSec16Hex = bytesToHex(s16).toUpperCase();
    r.bcmSec16Blank = s16.every(b => b === 0xFF) || s16.every(b => b === 0x00);
    r.bcmSec16StoredCrc = (bytes[0x848] << 8) | bytes[0x849];
    r.bcmSec16CalcCrc   = engCrc16(s16);
    r.bcmSec16CrcOk = !r.bcmSec16Blank && r.bcmSec16StoredCrc === r.bcmSec16CalcCrc;
    const rev = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rev[i] = s16[15 - i];
    r.bcmSec16ReversedHex = bytesToHex(rev).toUpperCase();
  }
  r.ok = r.vin !== null || (r.bcmSec16 && !r.bcmSec16Blank);
  return r;
}

/* Write the byte-reversed RFHUB SEC16 (slot 1, 16 bytes) into a 95640 dump
 * at 0x838, with big-endian CRC16 of the reversed bytes at 0x848-0x849.
 * Mirrors the algorithm used by SecurityTab's `rfhBcmSync` tool. */
function engWriteEep95640FromRfh(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length < 16)
    throw new Error('RFHUB SEC16 slot must be 16 bytes');
  if (bytes.length < 0x84A)
    throw new Error(`95640 file too small (need ≥0x84A bytes, got ${bytes.length})`);
  const out = new Uint8Array(bytes);
  const rev = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rev[i] = rfhSec16[15 - i];
  for (let i = 0; i < 16; i++) out[0x838 + i] = rev[i];
  const cs = engCrc16(rev);
  out[0x848] = (cs >> 8) & 0xFF;
  out[0x849] = cs & 0xFF;
  return { bytes: out, sec16Hex: bytesToHex(rev).toUpperCase(), crc16: cs };
}

/* Look up a P/N-override flag on a Dumps-tab file that matches the just-loaded
 * file by name + size. Lets the override badge propagate from Dumps → Module
 * Sync without a deeper state refactor. Returns false when no match. */
function lookupPnOverride(files, file, bytes) {
  if (!Array.isArray(files) || !file) return false;
  const match = files.find(f =>
    f && f.pnOverride && f.name === file.name &&
    (f.size === bytes.length || f.size === file.size)
  );
  return !!match;
}

function OverrideConfirmModal({ modules, onConfirm, onCancel }) {
  const [dontAsk, setDontAsk] = useState(false);
  const overlayRef = useRef(null);
  const handleOverlay = (e) => { if (e.target === overlayRef.current) onCancel?.(); };
  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      data-testid="pn-override-confirm"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
      <div style={{
        background: C.cd, border: `1.5px solid ${C.wn}`, borderRadius: 14,
        width: '100%', maxWidth: 520, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(135deg, ${C.wn}22 0%, ${C.wn}11 100%)`,
          borderBottom: `1px solid ${C.bd}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 22 }}>⚠️</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, letterSpacing: 0.5 }}>
              REGISTRY CHECK BYPASSED
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
              Confirm before syncing files that skipped P/N validation
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 18px', fontSize: 13, color: C.tx, lineHeight: 1.5 }}>
          <div style={{ marginBottom: 10 }}>
            The following loaded module{modules.length > 1 ? 's are' : ' is'} flagged
            <strong> P/N OVERRIDE</strong> — the part-number registry check was bypassed
            on the Dumps tab when {modules.length > 1 ? 'they were' : 'it was'} loaded:
          </div>
          <ul style={{ margin: '0 0 12px 18px', padding: 0, color: C.tx }}>
            {modules.map(m => (
              <li key={m} style={{ marginBottom: 4 }}>
                <strong style={{ color: C.sr }}>{m}</strong>
                <span style={{ color: C.ts, fontSize: 12 }}> — registry compatibility unverified</span>
              </li>
            ))}
          </ul>
          <div style={{
            background: C.wn + '14', border: `1px solid ${C.wn}55`, borderRadius: 8,
            padding: '8px 10px', fontSize: 12, color: C.tx, marginBottom: 10,
          }}>
            Mixing registry-checked and override files can produce a mismatched sync.
            Acknowledge that this is intentional before continuing.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.ts, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={e => setDontAsk(e.target.checked)}
              data-testid="pn-override-dont-ask"
              style={{ accentColor: C.a3, cursor: 'pointer' }}
            />
            Don&rsquo;t ask again for the rest of this session
          </label>
        </div>
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${C.bd}`,
          display: 'flex', justifyContent: 'flex-end', gap: 10, background: C.c2,
        }}>
          <button
            onClick={onCancel}
            data-testid="pn-override-cancel"
            style={{
              padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.bd}`,
              background: C.cd, color: C.tx, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm?.(dontAsk)}
            data-testid="pn-override-confirm-btn"
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: C.wn, color: '#1A1A1A', fontSize: 13, fontWeight: 800, cursor: 'pointer',
            }}>
            Acknowledge & Sync
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ModuleSync({ vehicleId, files: dumpsFiles } = {}) {
  const { vin: masterVin, vinValid: masterVinValid, clearDumps } = useMasterVin();

  const [bcm, setBcm] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [rfh, setRfh] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [pcm, setPcm] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [eep, setEep] = useState({ file: null, bytes: null, parsed: null, pnOverride: false });
  const [vehicleFamily, setVehicleFamily] = useState('');

  const [targetVin, setTargetVin] = useState('');
  const [virginize, setVirginize] = useState(false);
  const [logLines,  setLogLines]  = useState([]);
  const [diffRows,  setDiffRows]  = useState([]);
  const [originals, setOriginals] = useState({ bcm: null, rfh: null, pcm: null, eep: null });
  const [wizardOpen, setWizardOpen] = useState(false);
  /* Confirm dialog shown before a sync proceeds when one or more loaded
   * modules carry pnOverride (registry compatibility check was bypassed). */
  const [overrideConfirm, setOverrideConfirm] = useState(null); /* { action, overrideVin, modules } */
  const skipOverrideConfirmRef = useRef(false); /* per-session "don't ask again" */
  const logRef = useRef(null);

  const log = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines(p => [...p, { ts, msg, level }]);
  }, []);

  /* handleReset (Task #464) — port of TwinTab's "Clean / Reset" so the
   * Module Sync workspace gets the same fast clean-slate gesture. Clears:
   *   - all four loaded module slots (BCM / RFH / PCM / 95640)
   *   - the diff-rows table and the originals snapshots used for "Undo"
   *   - the pre-filled target VIN field
   *   - the on-screen log
   * It also calls clearDumps() on the master-VIN context so the "Dumps"
   * tab and the global Master VIN ribbon don't keep stale references to
   * the files that just got removed from this tab. The vehicle family
   * stays selected because that's a registry pick rather than per-file
   * state, and a tech who's about to load a second car of the same
   * family shouldn't have to re-pick it. Pure UI state — no engine,
   * parser, or writer code is touched. */
  const handleReset = useCallback(() => {
    setBcm({ file: null, bytes: null, parsed: null, pnOverride: false });
    setRfh({ file: null, bytes: null, parsed: null, pnOverride: false });
    setPcm({ file: null, bytes: null, parsed: null, pnOverride: false });
    setEep({ file: null, bytes: null, parsed: null, pnOverride: false });
    setDiffRows([]);
    setOriginals({ bcm: null, rfh: null, pcm: null, eep: null });
    setTargetVin('');
    setLogLines([]);
    if (typeof clearDumps === 'function') clearDumps();
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines([{ ts, msg: 'Workspace cleared — all modules, diff rows, originals, and target VIN reset.', level: 'info' }]);
  }, [clearDumps]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logLines]);
  useEffect(() => {
    log('SRT Lab Module Sync v2 (SINCRO-verified engine) ready.', 'info');
    log('Supports: BCM Gen1/Gen2 (SEC16 split records + mirrors) · RFHUB Gen1/Gen2 · PCM GPEC2A (4 KB / 8 KB)', 'muted');
  }, [log]);

  const handleBcm = useCallback((file, bytes) => {
    const parsed = engParseBcm(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setBcm({ file, bytes, parsed, pnOverride });
    setDiffRows([]); setOriginals(prev => ({ ...prev, bcm: null }));
    log(`Loaded BCM: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ BCM file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the BCM in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ BCM was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.ok) {
      log(`  BCM VIN: ${parsed.vin} · ${parsed.vinSlots.length} slot(s)`, 'ok');
      if (parsed.sec16Records.length > 0)
        log(`  SEC16 split records: ${parsed.sec16Records.length} found · consistent: ${parsed.sec16Consistent}`, 'ok');
      if (parsed.banks)
        log(`  Active bank: ${parsed.banks.activeBank} (seq 0x${hex4(parsed.banks.activeBank === 0 ? parsed.banks.bank0Seq : parsed.banks.bank1Seq)})`, 'muted');
    } else {
      log('  BCM: no VIN parsed — file format not recognized', 'err');
    }
    const match = bcmVehicleMatch(parsed);
    if (match) {
      log(`  Vehicle: ${match.name} (${match.sec})`, 'muted');
      /* Auto-select vehicle family if the BCM PN is in the catalog */
      for (const fam of VEHICLE_FAMILIES) {
        if (fam.expectedPns.includes(match.pn)) { setVehicleFamily(fam.id); break; }
      }
    }
  }, [log, dumpsFiles]);

  const handleRfh = useCallback((file, bytes) => {
    const parsed = engParseRfh(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setRfh({ file, bytes, parsed, pnOverride });
    setDiffRows([]); setOriginals(prev => ({ ...prev, rfh: null }));
    log(`Loaded RFHUB: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ RFHUB file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the RFHUB in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ RFHUB was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.ok) {
      log(`  RFHUB VIN: ${parsed.vin} · format: ${parsed.format}`, 'ok');
      if (parsed.sec16) log(`  SEC16: ${parsed.sec16.virgin ? 'VIRGIN' : parsed.sec16.match ? 'matched' : 'MISMATCH'} · ${[...parsed.sec16.slot1].map(hex2).join('').toUpperCase()}`, 'muted');
    } else {
      log('  RFHUB: no VIN parsed — file format not recognized', 'err');
    }
  }, [log, dumpsFiles]);

  const handlePcm = useCallback((file, bytes) => {
    const parsed = engParsePcm(bytes, file.name);
    const pnOverride = lookupPnOverride(dumpsFiles, file, bytes);
    setPcm({ file, bytes, parsed, pnOverride });
    setDiffRows([]); setOriginals(prev => ({ ...prev, pcm: null }));
    log(`Loaded PCM: ${file.name} (${bytes.length} bytes) · ${parsed.variant}`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ PCM file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the PCM in full or load the correct file.`, 'err');
      return;
    }
    if (pnOverride) log('  ⚠ PCM was loaded with P/N OVERRIDE on the Dumps tab — bypassed registry check', 'warn');
    if (parsed.vin)  log(`  PCM VIN: ${parsed.currentVin}${parsed.originalVin && parsed.originalVin !== parsed.currentVin ? ` (orig: ${parsed.originalVin})` : ''}`, parsed.ok ? 'ok' : 'warn');
    if (parsed.sec6) log(`  SEC6: ${parsed.sec6.bytes.map(hex2).join('').toUpperCase()} (marker ${parsed.sec6.marker})`, 'muted');
    if (parsed.immoDamaged) log('  ⚠ PCM: no SEC6 marker found — may be damaged or wrong file', 'warn');
  }, [log, dumpsFiles]);

  const handleEep = useCallback((file, bytes) => {
    const parsed = engParseEep95640(bytes, file.name);
    setEep({ file, bytes, parsed });
    setDiffRows([]); setOriginals(prev => ({ ...prev, eep: null }));
    log(`Loaded 95640: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.tooSmall) {
      log(`  ✗ 95640 file too small (${bytes.length} B, need ≥ ${parsed.minSize.toLocaleString()} B). Re-read the 95640 in full or load the correct file.`, 'err');
      return;
    }
    if (parsed.vin) log(`  95640 VIN: ${parsed.vin} · ${parsed.vinSlots.length} slot(s)`, 'ok');
    if (parsed.bcmSec16) {
      if (parsed.bcmSec16Blank) log(`  95640 BCM-SEC16 @0x838: BLANK (virgin)`, 'warn');
      else log(`  95640 BCM-SEC16 @0x838: ${parsed.bcmSec16Hex} · CRC16 ${parsed.bcmSec16CrcOk ? '✓' : '✗ (stored=0x' + hex4(parsed.bcmSec16StoredCrc) + ' calc=0x' + hex4(parsed.bcmSec16CalcCrc) + ')'}`, parsed.bcmSec16CrcOk ? 'ok' : 'warn');
    } else if (bytes.length < 0x84A) {
      log(`  95640: file too small for SEC16 region (need ≥0x84A bytes)`, 'warn');
    }
    if (!parsed.ok && !parsed.vin && (!parsed.bcmSec16 || parsed.bcmSec16Blank)) {
      log('  95640: no VIN and no SEC16 — file may be virgin or unrecognized', 'warn');
    }
  }, [log, dumpsFiles]);

  const tv      = targetVin.replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, VIN_LEN);
  const tvOk    = tv.length === VIN_LEN && VIN_RE.test(tv);
  const loaded  = (bcm.bytes ? 1 : 0) + (rfh.bytes ? 1 : 0) + (pcm.bytes ? 1 : 0) + (eep.bytes ? 1 : 0);
  const bothReady = !!(bcm.bytes && rfh.bytes && bcm.parsed?.ok && rfh.parsed?.ok);
  /* Resolver lookup for the legacy-flat 0x40C9 repair button (Task #382).
   * Only enable the repair when the resolver picked a live record-table
   * source (split / mirror1 / mirror2) AND the SEC16 isn't blank — copying
   * the flat slice onto itself, or copying garbage from a virgin BCM, would
   * not help legacy CGDI/Autel readers and could mask a real problem. */
  const flatRepairResolver = bcm.bytes && bcm.parsed?.ok ? resolveBcmSec16(bcm.bytes) : null;
  const flatRepairOk = !!(flatRepairResolver
    && flatRepairResolver.bytes
    && !flatRepairResolver.blank
    && flatRepairResolver.source
    && flatRepairResolver.source !== 'flat');
  const vinMatch  = bothReady && bcm.parsed.vin === rfh.parsed.vin;

  /* SEC16 sync eligibility */
  const bcmHasSec16      = !!(bcm.parsed?.sec16Records?.length > 0 || bcm.parsed?.mirrorsPopulated > 0);
  const rfhHasSec16      = !!(rfh.parsed?.sec16 && !rfh.parsed.sec16.virgin);
  const sec16SyncOk      = bcmHasSec16 && rfhHasSec16;
  const bcmToRfhSec16Ok  = bcmHasSec16 && rfh.parsed?.format?.startsWith('gen2');

  /* 95640 re-key eligibility — needs RFHUB SEC16 master + 95640 dump ≥0x84A bytes */
  const eep95640Loaded   = !!eep.bytes;
  const rekey95640Ok     = eep95640Loaded && rfhHasSec16 && eep.bytes.length >= 0x84A;

  /* Task #396 — single source of truth: re-parse loaded bytes through
   * parseModule() and run the canonical crossValidate() rules. The
   * returned issues/warnings are merged (deduped) into the wizard's
   * arrays below. Pre-#396 the wizard's rules were entirely hand-rolled
   * which let the BCM↔PCM SEC6 pairing rule drift out of the wizard
   * even though crossValidate already had it. Memoised on the byte
   * references so re-parsing only happens when a file is loaded or
   * replaced. */
  const cvResult = useMemo(() => {
    const mods = [];
    if (bcm.bytes) { try { mods.push(parseModule(bcm.bytes, bcm.name || 'bcm.bin')); } catch { /* ignore parse errors */ } }
    if (rfh.bytes) { try { mods.push(parseModule(rfh.bytes, rfh.name || 'rfh.bin')); } catch { /* ignore */ } }
    if (pcm.bytes) { try { mods.push(parseModule(pcm.bytes, pcm.name || 'pcm.bin')); } catch { /* ignore */ } }
    if (eep.bytes) { try { mods.push(parseModule(eep.bytes, eep.name || '95640.bin')); } catch { /* ignore */ } }
    if (mods.length === 0) return { issues: [], warnings: [], passed: [] };
    try { return crossValidate(mods); } catch { return { issues: [], warnings: [], passed: [] }; }
  }, [bcm.bytes, rfh.bytes, pcm.bytes, eep.bytes, bcm.name, rfh.name, pcm.name, eep.name]);

  /* Wizard issue/warning arrays — start from crossValidate output so the
   * wizard, FCA Analyzer drawer, and AI assistant all share one rule
   * set. Hand-rolled rules below add wizard-specific context that
   * crossValidate does not cover, with dedupe to avoid double-counting. */
  const wizardIssues = [...(cvResult.issues || [])];
  const wizardWarnings = [...(cvResult.warnings || [])];
  const _seenIssues = new Set(wizardIssues);
  const _seenWarnings = new Set(wizardWarnings);
  const _pushIssue = (msg) => { if (!_seenIssues.has(msg)) { _seenIssues.add(msg); wizardIssues.push(msg); } };
  const _pushWarning = (msg) => { if (!_seenWarnings.has(msg)) { _seenWarnings.add(msg); wizardWarnings.push(msg); } };
  /* VIN mismatch, RFHUB↔BCM vehicle secret mismatch, and RFHUB SEC16
   * blank/slot-mismatch warnings now flow exclusively from
   * crossValidate() via cvResult above (Task #396 — single source of
   * truth). Keeping the rules inline here would double-emit. */

  /* 95640 BCM-backup chip — flag mismatch/blank vs RFHUB SEC16 (reversed) */
  if (eep.bytes && rfhHasSec16 && rfh.parsed.sec16.slot1) {
    if (eep.bytes.length < 0x84A) {
      wizardWarnings.push(`95640 file too small (need ≥0x84A bytes for BCM-SEC16 region)`);
    } else if (!eep.parsed?.bcmSec16 || eep.parsed.bcmSec16Blank) {
      wizardIssues.push(`95640 BCM-SEC16 BLANK — backup chip needs re-keying from RFHUB`);
    } else {
      const rfhRevHex = bytesToHex(Array.from(rfh.parsed.sec16.slot1).reverse()).toUpperCase();
      if (eep.parsed.bcmSec16Hex !== rfhRevHex)
        wizardIssues.push(`95640 BCM-SEC16 MISMATCH: 95640 token ≠ reverse(RFHUB SEC16)`);
    }
  }

  /* The BCM SEC16 → SEC6 ↔ PCM SEC6 rule that closed the Task #396
   * incident now lives in crossValidate.js (the canonical validator)
   * and flows into wizardIssues via cvResult above — keeping a single
   * source of truth instead of mirroring the rule inline here. */

  /* PN-family mismatch — informational warning for wizard */
  const pnFamResult = vehicleFamily && bcm.parsed?.ok ? bcmFamilyMismatch(bcm.parsed, vehicleFamily) : null;
  if (pnFamResult && !pnFamResult.match) {
    wizardWarnings.push(
      `BCM PN MISMATCH: vehicle=${pnFamResult.family.label}, expected=${pnFamResult.expected?.join('/') || '—'}, detected=${pnFamResult.detected.join(', ') || 'none'}`
    );
  }

  const wizardModules = [bcm.bytes && 'BCM', rfh.bytes && 'RFHUB', pcm.bytes && 'PCM', eep.bytes && '95640'].filter(Boolean);

  /* Hex snippets with offset annotations for structured Claude context */
  const wizardHexSnippets = [];
  if (rfh.parsed?.sec16?.slot1) {
    const off = rfh.parsed.format?.startsWith('gen2') ? '0x050E' : '0x00AE';
    wizardHexSnippets.push(`RFHUB SEC16 @${off}: ${bytesToHex(rfh.parsed.sec16.slot1).toUpperCase()}`);
  }
  if (bcm.parsed?.sec16Hex) {
    const recOff = bcm.parsed.sec16Records?.[0]?.offset != null
      ? `0x${hex4(bcm.parsed.sec16Records[0].offset)}` : '0x4090';
    wizardHexSnippets.push(`BCM SEC16 @${recOff}: ${bcm.parsed.sec16Hex.toUpperCase()}`);
  }
  if (bcm.parsed?.vin)
    wizardHexSnippets.push(`BCM VIN @0x0000: ${bcm.parsed.vin}`);
  if (rfh.parsed?.vin)
    wizardHexSnippets.push(`RFHUB VIN @0x5320: ${rfh.parsed.vin}`);

  /* Step actions available in wizard matching doSync() actions */
  const wizardStepActions = [
    { id: 'full-sync',        label: '⚡ Full 3-Module Sync',    enabled: bothReady, description: 'VIN + SEC16 + SEC6 across all modules' },
    { id: 'sec16-only',       label: '🔐 SEC16 Sync Only',       enabled: sec16SyncOk, description: 'RFHUB SEC16 → BCM + PCM SEC6' },
    { id: 'bcm-sec16-to-rfh', label: '🔄 BCM SEC16 → RFHUB',    enabled: bcmToRfhSec16Ok, description: 'Use BCM as master, write to RFHUB Gen2 slots' },
    { id: 'rfh-to-bcm',       label: '← RFHUB VIN → BCM',       enabled: bothReady, description: 'Stamp BCM with RFHUB VIN' },
    { id: 'bcm-to-rfh',       label: '→ BCM VIN → RFHUB',       enabled: bothReady, description: 'Stamp RFHUB with BCM VIN' },
    { id: 'rekey-95640-from-rfh', label: '📟 Re-key 95640 from RFHUB', enabled: rekey95640Ok, description: 'Write reverse(RFHUB SEC16) → 95640 @ 0x838 + CRC16 @ 0x848' },
  ];

  const doSync = (action, overrideVin) => {
    /* Gate: if any loaded module bypassed the registry check, ask the tech to
     * acknowledge before the sync proceeds. Per-session opt-out is honoured. */
    const overridden = [
      bcm.pnOverride && 'BCM',
      rfh.pnOverride && 'RFHUB',
      pcm.pnOverride && 'PCM',
    ].filter(Boolean);
    if (overridden.length > 0 && !skipOverrideConfirmRef.current) {
      setOverrideConfirm({ action, overrideVin, modules: overridden });
      return;
    }
    return executeSync(action, overrideVin);
  };

  const executeSync = (action, overrideVin) => {
    const ts  = timestamp();
    /* Optional master-VIN override coming from the wizard's scenario card.
     * When present, it replaces the auto-picked VIN for actions that stamp
     * a VIN: rfh-to-bcm, bcm-to-rfh, sync-all (and target-both). */
    const ov = (typeof overrideVin === 'string' && VIN_RE.test(overrideVin)) ? overrideVin : null;
    /* Surface any P/N overrides on the loaded modules so the result log makes
     * it obvious which files bypassed the registry compatibility check. */
    const overridden = [
      bcm.pnOverride && 'BCM',
      rfh.pnOverride && 'RFHUB',
      pcm.pnOverride && 'PCM',
    ].filter(Boolean);
    /* If the sync mixes registry-checked and override files, prompt the
     * operator before continuing. Only modules that the *current action*
     * actually reads or writes are counted — a loaded-but-unused module
     * shouldn't trigger a false-positive warning. */
    const { overrideNames, checkedNames } = computeMixedSyncParticipants(action, {
      BCM:   { loaded: !!bcm.bytes, override: !!bcm.pnOverride },
      RFHUB: { loaded: !!rfh.bytes, override: !!rfh.pnOverride },
      PCM:   { loaded: !!pcm.bytes, override: !!pcm.pnOverride },
    });
    if (overrideNames.length > 0 && checkedNames.length > 0) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            'Mixed sync warning\n\n'
            + 'P/N OVERRIDE (registry bypass): ' + overrideNames.join(', ') + '\n'
            + 'Registry-checked: ' + checkedNames.join(', ') + '\n\n'
            + 'Mixing override and registry-verified files can produce inconsistent results. Continue anyway?'
          )
        : true;
      if (!ok) {
        log(`=== SYNC CANCELLED (${action}): mixed override/registry uploads ===`, 'warn');
        return;
      }
    }
    log(`=== SYNC: ${action}${virginize ? ' +VIRGINIZE' : ''}${ov ? ` (custom VIN ${ov})` : ''} ===`, 'info');
    if (overridden.length > 0) {
      log(`⚠ P/N OVERRIDE in effect for: ${overridden.join(', ')} — registry check was bypassed on the Dumps tab`, 'warn');
    }
    const rows = [];

    const addBcmRows = (parsedBcm, newVin, newCrc) => {
      parsedBcm.vinSlots.forEach((s, idx) => {
        rows.push({
          /* Task #464 — diff-table offsets render as "0x1328 (4904)" so
           * a tech reading the on-screen status next to a hex editor
           * doesn't have to convert from hex in their head. */
          module: 'BCM', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: 'CRC-16',
          oldCheck: s.storedCrc != null ? `0x${hex4(s.storedCrc)}` : '—',
          newCheck: `0x${hex4(newCrc)}`,
          oldPass: s.crcOk, newPass: true,
        });
      });
    };
    const addRfhRows = (parsedRfh, newVin, newChk) => {
      parsedRfh.vinSlots.forEach((s, idx) => {
        rows.push({
          module: 'RFHUB', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: 'Chk',
          oldCheck: s.storedChk != null ? `0x${hex2(s.storedChk)}` : '—',
          newCheck: `0x${hex2(newChk)}`,
          oldPass: s.chkOk, newPass: true,
        });
      });
    };
    const addPcmRows = (parsedPcm, newVin) => {
      parsedPcm.vinSlots.forEach((s, idx) => {
        rows.push({
          module: 'PCM', slot: idx + 1, offset: fmtOff(s.offset),
          oldVin: s.vin, newVin,
          checkLabel: '',
          oldCheck: '—', newCheck: '—',
          oldPass: null, newPass: true,
        });
      });
    };

    try {
      if (action === 'rfh-to-bcm') {
        const newVin = ov || rfh.parsed.vin;
        const newCrc = engCrc16(new TextEncoder().encode(newVin));
        addBcmRows(bcm.parsed, newVin, newCrc);
        const snap = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snap, filename: bcm.file?.name || 'BCM' } }));
        const r  = engWriteBcmVin(bcm.bytes, newVin);
        log(`BCM: patched ${r.fullPatched} full slot(s)${r.shortPatched > 0 ? ` + ${r.shortPatched} tail slot(s)` : ''}`, 'ok');
        downloadBin(r.bytes, `BCM_SYNCED_${newVin}_${ts}.bin`);
        log(`Downloaded: BCM_SYNCED_${newVin}_${ts}.bin`, 'ok');
        if (virginize) {
          const snapR = new Uint8Array(rfh.bytes);
          setOriginals(prev => ({ ...prev, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
          const rr = engWriteRfhVin(rfh.bytes, newVin, true);
          addRfhRows(rfh.parsed, newVin, rr.chk);
          downloadBin(rr.bytes, `RFH_VIRGIN_${newVin}_${ts}.bin`);
          log(`RFH: re-wrote VIN + wiped ${rr.sec16Wiped} SEC16 slot(s)`, 'warn');
        }

      } else if (action === 'bcm-to-rfh') {
        const newVin = ov || bcm.parsed.vin;
        const snap   = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snap, filename: rfh.file?.name || 'RFH' } }));
        const r  = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, r.chk);
        log(`RFHUB: patched ${r.patched} slot(s)${virginize ? ` + wiped ${r.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        downloadBin(r.bytes, `RFH_SYNCED${virginize ? '_VIRGIN' : ''}_${newVin}_${ts}.bin`);
        log(`Downloaded: RFH_SYNCED_${newVin}_${ts}.bin`, 'ok');

      } else if (action === 'target-both') {
        const newVin = ov || tv;
        const newCrc = engCrc16(new TextEncoder().encode(newVin));
        const snapB  = new Uint8Array(bcm.bytes);
        const snapR  = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' }, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
        const br = engWriteBcmVin(bcm.bytes, newVin);
        addBcmRows(bcm.parsed, newVin, newCrc);
        log(`BCM: patched ${br.fullPatched} full + ${br.shortPatched} tail slot(s)`, 'ok');
        downloadBin(br.bytes, `BCM_SYNCED_${newVin}_${ts}.bin`);
        log(`Downloaded: BCM_SYNCED_${newVin}_${ts}.bin`, 'ok');
        const rr = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, rr.chk);
        log(`RFHUB: patched ${rr.patched} slot(s)${virginize ? ` + wiped ${rr.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        downloadBin(rr.bytes, `RFH_SYNCED_${newVin}_${ts}.bin`);
        log(`Downloaded: RFH_SYNCED_${newVin}_${ts}.bin`, 'ok');

      } else if (action === 'sync-all') {
        /* Full 3-module sync: VIN → BCM + RFH + PCM, SEC16 BCM ← RFH, SEC6 PCM ← RFH */
        const newVin = ov || (tvOk ? tv : (rfh.parsed?.vin || bcm.parsed?.vin));
        if (!newVin) { log('✗ No target VIN available', 'err'); return; }
        const newCrc = engCrc16(new TextEncoder().encode(newVin));

        const snapB = new Uint8Array(bcm.bytes);
        const snapR = new Uint8Array(rfh.bytes);
        const snapP = pcm.bytes ? new Uint8Array(pcm.bytes) : null;
        setOriginals({
          bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' },
          rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' },
          pcm: snapP ? { bytes: snapP, filename: pcm.file?.name || 'PCM' } : null,
        });

        /* BCM VIN */
        const br = engWriteBcmVin(bcm.bytes, newVin);
        addBcmRows(bcm.parsed, newVin, newCrc);
        log(`BCM VIN: ${br.fullPatched} full + ${br.shortPatched} tail slot(s) patched`, 'ok');
        let bcmFinal = br.bytes;

        /* BCM SEC16 (Gen2 only) */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (sec16SyncOk && rfhSec16 && rfhSec16.length === 16) {
          const sr = engWriteBcmSec16Gen2(bcmFinal, rfhSec16);
          bcmFinal = sr.bytes;
          log(`BCM SEC16: ${sr.splitPatched} split record(s) + ${sr.mirrorPatched} mirror(s) written (SINCRO-verified)`, 'ok');
          log(`  BCM SEC16 (reversed): ${sr.bcmSec16Hex.toUpperCase()}`, 'muted');
        } else if (bcmHasSec16) {
          log('BCM SEC16: skipped (RFH not Gen2 or SEC16 virgin)', 'muted');
        }
        /* Task #385: auto-chain the legacy flat 0x40C9 repair when the live
         * SEC16 records were just rewritten — otherwise pre-Redeye CGDI/Autel
         * tools would still see the old secret in the flat slice. */
        if (sec16SyncOk && rfhSec16 && rfhSec16.length === 16) {
          const fr = chainBcmFlatRepairIfStale(bcmFinal);
          if (fr.repaired) {
            bcmFinal = fr.bytes;
            log(`✓ Auto-chained: flat 0x40C9 repaired from resolved SEC16 (source: ${fr.source}) — legacy CGDI/Autel readers will now see the live secret`, 'ok');
            log(`  Old flat (LE): ${fr.oldFlatHex} → New flat (LE): ${fr.leHex}`, 'muted');
            rows.push({
              module: 'BCM', slot: '·', offset: '0x40C9',
              oldVin: fr.oldFlatHex, newVin: fr.leHex,
              checkLabel: 'src',
              oldCheck: 'flat (legacy)', newCheck: `auto · ${fr.source}`,
              oldPass: null, newPass: true,
            });
          } else if (fr.reason === 'already-in-sync') {
            log('  Flat 0x40C9 auto-repair: already in sync with resolved SEC16 — no change needed', 'muted');
          } else if (fr.reason === 'flat-only') {
            log('  Flat 0x40C9 auto-repair skipped: only the legacy flat slice is populated (no live split/mirror records to copy from)', 'muted');
          } else if (fr.reason === 'unresolved-or-blank') {
            log('  Flat 0x40C9 auto-repair skipped: post-write SEC16 is blank or unresolvable', 'muted');
          }
        }
        downloadBin(bcmFinal, `BCM_SYNCED_${newVin}_${ts}.bin`);
        log(`Downloaded: BCM_SYNCED_${newVin}_${ts}.bin`, 'ok');

        /* RFH VIN */
        const rr = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, rr.chk);
        log(`RFHUB VIN: ${rr.patched} slot(s) patched${virginize ? ` + ${rr.sec16Wiped} SEC16 slot(s) wiped` : ''}`, virginize ? 'warn' : 'ok');
        downloadBin(rr.bytes, `RFH_SYNCED_${newVin}_${ts}.bin`);
        log(`Downloaded: RFH_SYNCED_${newVin}_${ts}.bin`, 'ok');

        /* PCM VIN + SEC6 */
        if (pcm.bytes && pcm.parsed) {
          let pcmFinal = engWritePcmVin(pcm.bytes, newVin).bytes;
          const pr = { patched: pcm.parsed.vinSlots.length };
          addPcmRows(pcm.parsed, newVin);
          log(`PCM VIN: ${pr.patched} slot(s) patched`, 'ok');
          let pcmSec6Ok = true;
          /* Task #433 — single shared preflight covering all reasons the
           * SEC6 write can be gated out (no RFH, Gen1 RFH, virgin SEC16,
           * non-canonical PCM size). Mirrors the BCM SEC16 skip line above. */
          const sec6Skip = pcmSec6SkipReason({ rfh, pcm: { bytes: pcmFinal, parsed: pcm.parsed } });
          if (!sec6Skip) {
            const sr = engWritePcmSec6(pcmFinal, rfhSec16);
            if (sr.ok) {
              pcmFinal = sr.bytes;
              log(`PCM SEC6: ${sr.patched} location(s) written · ${sr.sec6Hex.toUpperCase()} (marker ${sr.markerUsed})`, 'ok');
            } else {
              /* Task #399 — preflight passed but writer still couldn't find
               * a writable site (corrupt canonical region). Refuse the
               * download instead of silently shipping the unchanged file. */
              pcmSec6Ok = false;
              log(`✗ PCM SEC6 SYNC FAILED — no writable site found (size=${pcmFinal.length} B, SEC6=${sr.sec6Hex.toUpperCase()}). PCM file NOT downloaded. Re-dump the PCM at the canonical 4 KB / 8 KB size and retry.`, 'err');
            }
          } else {
            log(`PCM SEC6 skipped: ${sec6Skip}`, 'muted');
          }
          // Task #379: if the loaded PCM is a doubled 8 KB capture with a
          // 0xFF-padded half-2, slice the SYNC output down to 4 KB so the
          // CGDI flasher for a 95320 bench chip doesn't reject it with
          // "File different size." The decision matches the bundler's
          // default --pcm-chip 4kb path.
          let pcmChipSuffix = '';
          if (pcmFinal.length === 8192) {
            const half2 = pcmFinal.slice(4096);
            if (half2.every((b) => b === 0xFF)) {
              pcmFinal = pcmFinal.slice(0, 4096);
              pcmChipSuffix = '_4KB';
              log('PCM auto-sliced 8 KB → 4 KB (half-2 was 0xFF padding; matches 95320 bench chip)', 'warn');
            } else {
              pcmChipSuffix = '_8KB';
            }
          } else if (pcmFinal.length === 4096) {
            pcmChipSuffix = '_4KB';
          }
          if (pcmSec6Ok) {
            const pcmName = `PCM_SYNCED${pcmChipSuffix}_${newVin}_${ts}.bin`;
            downloadBin(pcmFinal, pcmName);
            log(`Downloaded: ${pcmName}`, 'ok');
          } else {
            log('PCM file withheld: SEC6 could not be written; flashing this file would leave the car with an unpaired PCM.', 'err');
          }
        }

      } else if (action === 'sec16-only') {
        /* SEC16 sync only — BCM SEC16 ← RFH, PCM SEC6 ← RFH */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) {
          /* Task #433 — also surface the per-writer skip lines so the user
           * sees both gates failing, not just a single generic error. */
          log('✗ No RFH SEC16 available', 'err');
          log(`PCM SEC6 skipped: ${pcmSec6SkipReason({ rfh, pcm }) || 'RFH SEC16 not readable'}`, 'muted');
          return;
        }
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const sr = engWriteBcmSec16Gen2(bcm.bytes, rfhSec16);
        log(`BCM SEC16 sync: ${sr.splitPatched} split record(s) + ${sr.mirrorPatched} mirror(s) written`, 'ok');
        log(`  Inactive bank: 0x${hex4(sr.inactiveBase)} · BCM SEC16: ${sr.bcmSec16Hex.toUpperCase()}`, 'muted');
        /* Task #385: auto-chain the legacy flat 0x40C9 repair so pre-Redeye
         * tools that still read the flat field stop seeing the old secret. */
        let bcmSec16Out = sr.bytes;
        const fr = chainBcmFlatRepairIfStale(bcmSec16Out);
        if (fr.repaired) {
          bcmSec16Out = fr.bytes;
          log(`✓ Auto-chained: flat 0x40C9 repaired from resolved SEC16 (source: ${fr.source}) — legacy CGDI/Autel readers will now see the live secret`, 'ok');
          log(`  Old flat (LE): ${fr.oldFlatHex} → New flat (LE): ${fr.leHex}`, 'muted');
          rows.push({
            module: 'BCM', slot: '·', offset: '0x40C9',
            oldVin: fr.oldFlatHex, newVin: fr.leHex,
            checkLabel: 'src',
            oldCheck: 'flat (legacy)', newCheck: `auto · ${fr.source}`,
            oldPass: null, newPass: true,
          });
        } else if (fr.reason === 'already-in-sync') {
          log('  Flat 0x40C9 auto-repair: already in sync with resolved SEC16 — no change needed', 'muted');
        } else if (fr.reason === 'flat-only') {
          log('  Flat 0x40C9 auto-repair skipped: only the legacy flat slice is populated (no live split/mirror records to copy from)', 'muted');
        } else if (fr.reason === 'unresolved-or-blank') {
          log('  Flat 0x40C9 auto-repair skipped: post-write SEC16 is blank or unresolvable', 'muted');
        }
        downloadBin(bcmSec16Out, `BCM_SEC16_SYNCED_${ts}.bin`);
        log(`Downloaded: BCM_SEC16_SYNCED_${ts}.bin`, 'ok');
        /* Task #433 — single shared preflight, same reason set as full sync. */
        const sec6Skip = pcmSec6SkipReason({ rfh, pcm });
        if (!sec6Skip) {
          const snapP = new Uint8Array(pcm.bytes);
          setOriginals(prev => ({ ...prev, pcm: { bytes: snapP, filename: pcm.file?.name || 'PCM' } }));
          const pr = engWritePcmSec6(pcm.bytes, rfhSec16);
          if (pr.ok) {
            log(`PCM SEC6: ${pr.patched} location(s) written · marker ${pr.markerUsed}`, 'ok');
            downloadBin(pr.bytes, `PCM_SEC6_SYNCED_${ts}.bin`);
            log(`Downloaded: PCM_SEC6_SYNCED_${ts}.bin`, 'ok');
          } else {
            /* Task #399 — preflight passed but writer still refused; refuse
             * to ship an unmodified PCM as "synced". */
            log(`✗ PCM SEC6 SYNC FAILED — no writable site found (size=${pcm.bytes.length} B). PCM file NOT downloaded. Re-dump the PCM at the canonical 4 KB / 8 KB size and retry.`, 'err');
          }
        } else {
          log(`PCM SEC6 skipped: ${sec6Skip}`, 'muted');
        }

      } else if (action === 'rekey-95640-from-rfh') {
        /* Re-key 95640 BCM-backup chip from RFHUB master.
           Reverses RFH SEC16 slot1 → 95640 @ 0x838 + CRC16 @ 0x848. */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) { log('✗ No RFHUB SEC16 available — load a Gen2 RFHUB with populated SEC16', 'err'); return null; }
        if (!eep.bytes) { log('✗ 95640 dump not loaded', 'err'); return null; }
        const snapE = new Uint8Array(eep.bytes);
        setOriginals(prev => ({ ...prev, eep: { bytes: snapE, filename: eep.file?.name || '95640' } }));
        const wr = engWriteEep95640FromRfh(eep.bytes, rfhSec16);
        log(`95640 BCM-SEC16 @0x838 ← reverse(RFHUB SEC16): ${wr.sec16Hex}`, 'ok');
        log(`  CRC16 @0x848: 0x${hex4(wr.crc16)} (big-endian)`, 'muted');
        rows.push({
          module: '95640', slot: 1, offset: '0x0838',
          oldVin: eep.parsed?.bcmSec16Blank ? '— BLANK —' : (eep.parsed?.bcmSec16Hex || '—'),
          newVin: wr.sec16Hex,
          checkLabel: 'CRC-16',
          oldCheck: eep.parsed?.bcmSec16StoredCrc != null ? `0x${hex4(eep.parsed.bcmSec16StoredCrc)}` : '—',
          newCheck: `0x${hex4(wr.crc16)}`,
          oldPass: eep.parsed?.bcmSec16CrcOk ?? null,
          newPass: true,
        });
        downloadBin(wr.bytes, `EEP95640_REKEYED_${ts}.bin`);
        log(`Downloaded: EEP95640_REKEYED_${ts}.bin`, 'ok');

      } else if (action === 'bcm-flat-from-resolved') {
        /* Repair the legacy flat 0x40C9 slice from the resolved (split/mirror)
         * SEC16 so third-party tools (CGDI, Autel, etc.) that still read the
         * pre-Redeye flat field stop seeing residual garbage. Live FEE
         * records (split @0x81A0/C0/E0 + inactive-bank mirrors) are left
         * untouched. Gated on resolver.source !== 'flat' && !blank — the
         * button itself is hidden otherwise, but we re-check defensively. */
        const rs = resolveBcmSec16(bcm.bytes);
        if (!rs || !rs.bytes || rs.blank) {
          log('✗ BCM SEC16 is blank — nothing to copy into the legacy slice', 'err');
          return null;
        }
        if (rs.source === 'flat') {
          log('✗ Resolver picked the flat slice itself — split/mirror records are absent or virgin, refusing to copy garbage onto itself', 'err');
          return null;
        }
        const oldFlat = Array.from(bcm.bytes.slice(0x40C9, 0x40D9))
          .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const wr = writeBcmFlatSec16(bcm.bytes, rs.bytes);
        log(`BCM flat 0x40C9 repaired from resolver source '${rs.source}' @0x${hex4(rs.offset)}`, 'ok');
        log(`  Resolved SEC16 (BE): ${wr.sec16Hex.toUpperCase()}`, 'muted');
        log(`  Written @0x40C9 (LE): ${wr.leHex.toUpperCase()}`, 'muted');
        rows.push({
          module: 'BCM', slot: 1, offset: '0x40C9',
          oldVin: oldFlat, newVin: wr.leHex.toUpperCase(),
          checkLabel: 'src',
          oldCheck: 'flat (legacy)', newCheck: rs.source,
          oldPass: null, newPass: true,
        });
        downloadBin(wr.bytes, `BCM_FLAT40C9_REPAIRED_${ts}.bin`);
        log(`Downloaded: BCM_FLAT40C9_REPAIRED_${ts}.bin`, 'ok');
        log('Legacy CGDI/Autel-style readers will now see the same SEC16 as the live split records.', 'ok');

      } else if (action === 'bcm-sec16-to-rfh') {
        /* BCM SEC16 → RFHUB Gen2 slots — use when RFHUB is from a different vehicle.
           BCM is master: reverse(BCM SEC16) is written to RFHUB 0x050E + 0x0522. */
        const bcmSec16 = bcm.parsed?.sec16Records?.[0]?.sec16
                      ?? bcm.parsed?.sec16Mirrors?.find(m => m.populated && m.crcOk)?.sec16;
        if (!bcmSec16) { log('✗ No BCM SEC16 found in split records or mirrors', 'err'); return; }
        const snapR = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snapR, filename: rfh.file?.name || 'RFH' } }));
        const sr = engWriteRfhSec16FromBcm(rfh.bytes, bcmSec16);
        log(`RFHUB SEC16 sync (BCM → RFH): ${sr.patched} slot(s) written`, 'ok');
        log(`  RFHUB new SEC16: ${sr.rfhSec16Hex.toUpperCase()} · slot chk: 0x${sr.chk.toString(16).padStart(2,'0').toUpperCase()}`, 'muted');
        const rfhFinal = sr.bytes;
        const ts2 = timestamp();
        downloadBin(rfhFinal, `RFHUB_BCM_SEC16_SYNCED_${ts2}.bin`);
        log(`Downloaded: RFHUB_BCM_SEC16_SYNCED_${ts2}.bin`, 'ok');
        log('Flash corrected RFHUB + power-cycle 30 s — BCM, RFHUB and PCM will now share the same secret.', 'ok');
      }

      log('✓ Sync complete. Flash .bin file(s) to modules and power-cycle 30 s for handshake.', 'ok');
      setDiffRows(rows);
      log('ℹ Use the Restore buttons below to recover pre-patch bytes if needed.', 'muted');
      return rows;
    } catch (e) {
      log(`✗ Error: ${e.message}`, 'err');
      return null;
    }
  };

  const doRestore = (kind) => {
    const snap = originals[kind]; if (!snap) return;
    const prefix = kind === 'bcm' ? 'BCM' : kind === 'rfh' ? 'RFH' : kind === 'pcm' ? 'PCM' : 'EEP95640';
    const name   = `${prefix}_ORIGINAL_${timestamp()}.bin`;
    downloadBin(snap.bytes, name);
    log(`⟲ Restored original ${prefix}: downloaded ${name}`, 'ok');
  };

  const Card = ({ children, style = {} }) => (
    <div style={{ background: C.cd, border: `1.5px solid ${C.bd}`, borderRadius: 16, padding: 22, boxShadow: '0 2px 16px rgba(0,0,0,0.04)', marginBottom: 18, ...style }}>{children}</div>
  );
  const H2 = ({ children, badge }) => (
    <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14, color: C.tx, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.sr }} />
      {children}
      {badge != null && (
        <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 600, color: C.tm, padding: '2px 8px', background: C.c2, borderRadius: 6 }}>{badge}</span>
      )}
    </div>
  );

  const rfhForVirginize = rfh.parsed?.format === 'gen2'
    ? 'RFHUB Gen2: wipes 0x050E + 0x0522'
    : 'RFHUB Gen1: wipes 0x0226 + 0x023A';

  return (
    <div style={{ fontFamily: "'Nunito', system-ui, sans-serif", color: C.tx }}>

      {/* Connection Guides — bench-tool quick links per module (Task #464). */}
      <ConnectionGuides />

      {/* ── Always-visible wizard launcher + Clean / Reset ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
        <button
          data-testid="modsync-reset-btn"
          onClick={handleReset}
          title="Clear all loaded modules, the diff table, the originals snapshots, the target VIN field, and the on-screen log. The vehicle family stays selected."
          style={{
            background: C.cd, border: `1px solid ${C.bd}`, borderRadius: 8,
            padding: '8px 14px', color: C.tx, fontWeight: 800, fontSize: 12,
            cursor: 'pointer', letterSpacing: 0.4, fontFamily: "'Nunito'",
          }}>
          🧹 Clean / Reset
        </button>
        <button
          data-testid="open-wizard-btn-toolbar"
          onClick={() => setWizardOpen(true)}
          title="Open the guided Mismatch Wizard + AI assistant (works even with no files loaded)"
          style={{
            background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
            border: 'none', borderRadius: 8, padding: '8px 16px',
            color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
            letterSpacing: 0.5, fontFamily: "'Nunito'",
            boxShadow: '0 2px 8px rgba(211,47,47,0.25)',
          }}>
          🔧 Open Wizard
        </button>
      </div>

      {/* ── Load & Inspect ── */}
      <Card>
        <H2 badge={`${loaded} / 4`}>Load &amp; Inspect</H2>
        {/* Task #464 — surface the SINCRO-style refresh-warning hint above the
            uploaders. SRT Lab is fully client-side (no server-side persisted
            session for module bytes), so a page refresh wipes the loaded
            files. Telling the tech this up-front avoids the "where did my
            files go?" question after a tab reload. */}
        <div data-testid="modsync-refresh-hint" style={{
          marginBottom: 10, padding: '6px 10px', borderRadius: 8,
          background: C.wn + '14', border: `1px solid ${C.wn}55`,
          color: C.wn, fontSize: 11, fontWeight: 700, lineHeight: 1.4,
        }}>
          ⚠ State is lost on page refresh — re-drop the .bin files if you reload the tab.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <DropZone label="BCM"      icon="🧠" hint="MPC5606B DFLASH · Gen1 or Gen2 · drag .bin"
                    file={bcm.file} onFile={handleBcm} />
          <DropZone label="RFHUB / FCM" icon="🔑" hint="Yazaki FCM EEPROM · Gen1 or Gen2 · drag .bin"
                    file={rfh.file} onFile={handleRfh} accent={C.a4} />
          <DropZone label="PCM (optional)" icon="⚙️" hint="GPEC2A (4 KB or 8 KB) · drag .bin"
                    file={pcm.file} onFile={handlePcm} accent={C.a1} />
          <DropZone label="95640 (optional)" icon="📟" hint="BCM-backup EEPROM · 8 / 16 KB · drag .bin"
                    file={eep.file} onFile={handleEep} accent={C.a4} />
        </div>
      </Card>

      {/* ── Inspection Results ── */}
      {loaded > 0 && (
        <Card>
          <H2>Inspection Result</H2>

          {/* Vehicle family selector */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ts, marginBottom: 6 }}>
              Vehicle Family — select to verify BCM part number
            </div>
            <select
              data-testid="vehicle-family-select"
              value={vehicleFamily}
              onChange={e => setVehicleFamily(e.target.value)}
              style={{
                padding: '10px 14px', borderRadius: 10, border: `2px solid ${vehicleFamily ? C.a3 : C.bd}`,
                background: C.c2, color: C.tx, fontFamily: "'Nunito'", fontSize: 13, fontWeight: 700,
                cursor: 'pointer', outline: 'none', width: '100%', maxWidth: 480,
              }}
            >
              <option value="">— select vehicle family to verify BCM PN —</option>
              {VEHICLE_FAMILIES.map(f => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>

          {/* BCM part-number mismatch warning */}
          {(() => {
            if (!bcm.parsed?.ok) return null;
            const r = bcmFamilyMismatch(bcm.parsed, vehicleFamily);
            if (!r) return null;
            if (r.match) return (
              <div data-testid="bcm-family-match" style={{
                padding: '12px 16px', borderRadius: 10, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10,
                background: 'rgba(0,200,83,0.08)', color: '#0a7a3b', border: '1.5px solid rgba(0,200,83,0.3)', fontWeight: 700, fontSize: 13,
              }}>
                ✓ BCM part number matches <strong>{r.family.label}</strong>
              </div>
            );
            return (
              <div data-testid="bcm-family-mismatch" style={{
                padding: '12px 16px', borderRadius: 10, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6,
                background: 'rgba(255,179,0,0.09)', border: '2px solid rgba(255,179,0,0.4)',
              }}>
                <div style={{ fontWeight: 900, fontSize: 13, color: '#7a4a00' }}>
                  ⚠ BCM PART NUMBER MISMATCH
                </div>
                <div style={{ fontSize: 12, color: '#7a4a00', lineHeight: 1.5 }}>
                  Selected vehicle: <strong>{r.family.label}</strong><br />
                  Expected BCM PN: <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{r.expected?.join(', ') || '—'}</span><br />
                  Detected BCM PN: <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{r.detected.join(', ') || '— none recognized'}</span>
                </div>
                <div style={{ fontSize: 11, color: '#9a6000', fontStyle: 'italic' }}>
                  Flash a mismatched BCM into this vehicle at your own risk — key-fob and immobilizer pairing may fail.
                </div>
              </div>
            );
          })()}

          {/* BCM-too-small banner — shown in place of the VIN match / Comparison
              wording so users aren't told the SEC6 doesn't match when the real
              cause is an undersized / fragment / wrong-module BCM file. */}
          {bcm.parsed?.tooSmall && (
            <div data-testid="bcm-too-small-banner" style={{
              padding: '14px 18px', borderRadius: 12, marginBottom: 14,
              fontWeight: 800, fontSize: 13, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: 'rgba(255,23,68,0.08)', color: '#a00025',
              border: `1.5px solid ${C.er}55`,
            }}>
              <span style={{ flex: 1 }}>
                ✗ NOT READY — BCM file is too small ({bcm.parsed.size.toLocaleString()} B, need ≥ {bcm.parsed.minSize.toLocaleString()} B). Load a full BCM dump to enable VIN / SEC16 / SEC6 comparison.
              </span>
            </div>
          )}

          {/* VIN match banner */}
          {bothReady && (
            <div style={{
              padding: '14px 18px', borderRadius: 12, marginBottom: 14,
              fontWeight: 800, fontSize: 13, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: vinMatch ? 'rgba(0,200,83,0.1)' : 'rgba(255,23,68,0.08)',
              color: vinMatch ? '#0a7a3b' : '#a00025',
              border: `1.5px solid ${vinMatch ? 'rgba(0,200,83,0.3)' : 'rgba(255,23,68,0.25)'}`,
            }}>
              <span style={{ flex: 1 }}>
                {vinMatch ? '✓ VIN MATCH' : '✗ VIN MISMATCH'} —{' '}
                {vinMatch
                  ? <>BCM and RFHUB both carry <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · modules already paired</>
                  : <>BCM: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · RFHUB: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{rfh.parsed.vin}</strong> · sync required</>}
              </span>
              {(wizardIssues.length > 0 || wizardWarnings.length > 0) && (
                <button
                  data-testid="open-wizard-btn"
                  onClick={() => setWizardOpen(true)}
                  style={{
                    background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                    border: 'none', borderRadius: 8, padding: '6px 14px',
                    color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
                    letterSpacing: 0.5, fontFamily: "'Nunito'",
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}>
                  🔧 Fix with Wizard →
                </button>
              )}
            </div>
          )}

          {/* Standalone wizard trigger when no VIN mismatch but SEC16 issues */}
          {bothReady && vinMatch && (wizardIssues.length > 0 || wizardWarnings.length > 0) && (
            <div style={{
              padding: '10px 16px', borderRadius: 10, marginBottom: 14,
              background: 'rgba(255,179,0,0.08)', border: '1.5px solid rgba(255,179,0,0.3)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 12, color: '#7a4a00', flex: 1 }}>
                ⚠ Security token issues detected — use the wizard for guided resolution.
              </span>
              <button
                data-testid="open-wizard-btn-sec16"
                onClick={() => setWizardOpen(true)}
                style={{
                  background: 'linear-gradient(135deg,#D32F2F 0%,#FF6D00 100%)',
                  border: 'none', borderRadius: 8, padding: '6px 14px',
                  color: '#fff', fontWeight: 900, fontSize: 12, cursor: 'pointer',
                  letterSpacing: 0.5, fontFamily: "'Nunito'",
                }}>
                🔧 Fix with Wizard →
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            <BcmCard parsed={bcm.parsed} pnOverride={bcm.pnOverride} />
            <RfhCard parsed={rfh.parsed} pnOverride={rfh.pnOverride} />
            {pcm.parsed && <PcmCard parsed={pcm.parsed} bytes={pcm.bytes} pnOverride={pcm.pnOverride} />}
          </div>
        </Card>
      )}

      {/* ── Standalone Tools ── */}
      <Card>
        <H2>Standalone Tools</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🌐 Sync Tool (HTML)</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              Self-contained offline tool — drop BCM and RFHUB bins directly in a browser tab, no server needed.
            </div>
            <a href="/SRTLAB_SYNC_TOOL.html" download="SRTLAB_SYNC_TOOL.html"
               onClick={() => trackDownload(ASSET_IDS.modSyncTool)}
               style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800, background: C.a3, color: '#fff', textDecoration: 'none', letterSpacing: 0.5 }}>
              ⬇ Download SRTLAB_SYNC_TOOL.html
            </a>
            <div style={{ marginTop: 8 }}><DownloadCounter assetId={ASSET_IDS.modSyncTool} /></div>
          </div>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🐍 Python Validator</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              CLI validator — verify VIN slots, CRC-16/CCITT checksums, and SEC16 state of any BCM or RFHUB dump.
            </div>
            <a href="/srtlab_validate.py" download="srtlab_validate.py"
               onClick={() => trackDownload(ASSET_IDS.modSyncValidate)}
               style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800, background: C.a2, color: '#fff', textDecoration: 'none', letterSpacing: 0.5 }}>
              ⬇ Download srtlab_validate.py
            </a>
            <div style={{ marginTop: 8 }}><DownloadCounter assetId={ASSET_IDS.modSyncValidate} /></div>
          </div>
        </div>
      </Card>

      {/* ── 95640 Standalone Tools ── shown when 95640 + RFHUB are loaded but BCM is not,
           so the "Re-key 95640 from RFHUB" 1-click flow is reachable without a BCM dump. */}
      {eep95640Loaded && !bothReady && (
        <Card>
          <H2 badge="1-click">95640 Backup Chip</H2>
          <div style={{ fontSize: 12, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
            The 95640 mirrors the BCM key data. Load the RFHUB master to enable a 1-click
            <strong> Re-key 95640 from RFHUB</strong> — writes reverse(RFH SEC16) into 95640 @ 0x838 with CRC16 @ 0x848.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            <ActionBtn title="📟 Re-key 95640 from RFHUB" enabled={rekey95640Ok}
              color={C.a4}
              desc={rekey95640Ok
                ? 'Reverse the RFHUB SEC16 (16 bytes) and write into 95640 @ 0x838. Big-endian CRC16 stamped @ 0x848. Downloads a new 95640 .bin.'
                : !rfhHasSec16 ? 'Load a Gen2 RFHUB with populated SEC16 to enable.'
                : eep.bytes && eep.bytes.length < 0x84A ? `95640 file too small (${eep.bytes.length} bytes — need ≥0x84A).`
                : 'Load a 95640 dump to enable.'}
              onClick={() => doSync('rekey-95640-from-rfh')} />
          </div>
        </Card>
      )}

      {/* ── Sync Actions disabled — BCM is too small (Task #370) ──
           When the BCM dump is undersized, bothReady is false so the live
           Sync Actions card below is hidden. Surface a parallel disabled-state
           card with the exact wording the task calls for so the operator sees
           why APPLY / Import data from BCM → PCM are unreachable. */}
      {bcm.parsed?.tooSmall && (rfh.bytes || pcm.bytes) && (
        <Card>
          <H2>Sync Actions</H2>
          <div data-testid="bcm-too-small-actions-notice"
               title="BCM file is too small — load a full ≥ 64 KB BCM dump."
               style={{
                 padding: '14px 18px', borderRadius: 10,
                 background: 'rgba(255,23,68,0.07)',
                 border: `2px solid ${C.er}`,
               }}>
            <div style={{ fontWeight: 900, fontSize: 12, color: C.er, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 }}>
              ⛔ APPLY / Import data from BCM → PCM unavailable
            </div>
            <div style={{ fontSize: 12, color: C.tx, fontWeight: 700, lineHeight: 1.6 }}>
              BCM file is too small — load a full ≥ 64 KB BCM dump.
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: C.ts, lineHeight: 1.6 }}>
              Detected size: {bcm.parsed.size.toLocaleString()} B · required min: {bcm.parsed.minSize.toLocaleString()} B (MPC5605B/06B DFLASH).
            </div>
          </div>
        </Card>
      )}

      {/* ── BCM-only: legacy 0x40C9 repair (Task #382) ──
          Available whenever a BCM is loaded with a populated split/mirror
          SEC16 — does not require RFH/PCM, since this only rewrites the
          legacy flat slice from data already inside the BCM. */}
      {bcm.bytes && bcm.parsed?.ok && !bothReady && flatRepairOk && (
        <Card>
          <H2>BCM legacy compatibility</H2>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, color: C.a3, marginBottom: 8, textTransform: 'uppercase' }}>
            🩹 Flat 0x40C9 repair (BCM-only)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <ActionBtn title="🩹 Repair flat 0x40C9 from split records"
              enabled={flatRepairOk}
              color={C.a3}
              desc={`Copy resolved SEC16 (source: ${flatRepairResolver.source} @0x${hex4(flatRepairResolver.offset)}) into legacy flat slice 0x40C9 (LE). Live split/mirror records untouched. For CGDI / Autel and other tools that still read the pre-Redeye flat field.`}
              onClick={() => doSync('bcm-flat-from-resolved')} />
          </div>
        </Card>
      )}

      {/* ── Sync Actions ── */}
      {bothReady && (
        <Card>
          <H2>Sync Actions</H2>

          {/* Target VIN input */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Target VIN — for write-both / sync-all modes
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                value={targetVin}
                onChange={e => setTargetVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
                placeholder="Enter 17-character VIN"
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 10,
                  border: `2px solid ${tvOk ? C.gn : C.bd}`,
                  background: C.c2, color: C.tx,
                  fontFamily: "'JetBrains Mono'", fontSize: 15, fontWeight: 700, letterSpacing: 2.5,
                  textAlign: 'center', outline: 'none', textTransform: 'uppercase',
                }}
              />
              {masterVinValid && (
                <button data-testid="prefill-master-vin"
                  onClick={() => { setTargetVin(masterVin); log(`Pre-filled target VIN from session Master VIN: ${masterVin}`, 'info'); }}
                  title={`Pre-fill from session Master VIN: ${masterVin}`}
                  style={{ padding: '10px 14px', borderRadius: 10, border: `2px solid ${C.a3}`, background: C.a3, color: '#fff', cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 11, letterSpacing: 0.4, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  ↙ Use Master VIN
                </button>
              )}
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: tvOk ? C.gn : C.tm, fontWeight: 700, minWidth: 42, textAlign: 'right' }}>
                {tv.length} / 17
              </div>
            </div>
            {masterVinValid && (
              <div style={{ fontSize: 11, color: C.a3, marginTop: 6, fontWeight: 700, fontFamily: "'JetBrains Mono'", letterSpacing: 0.5 }}>
                Session Master VIN: <span style={{ color: C.tx }}>{masterVin}</span>
              </div>
            )}
          </div>

          {/* VIN sync buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 10 }}>
            <ActionBtn title="➡ RFH VIN → BCM"   enabled={rfh.parsed.ok}
              desc={`Copy RFHUB VIN (${rfh.parsed.vin}) into BCM at all full + tail slots. Downloads new BCM bin.`}
              onClick={() => doSync('rfh-to-bcm')} />
            <ActionBtn title="⬅ BCM VIN → RFH"   enabled={bcm.parsed.ok}
              desc={`Copy BCM VIN (${bcm.parsed.vin}) into RFHUB byte-reversed at all 4 slots. Downloads new RFH bin.`}
              onClick={() => doSync('bcm-to-rfh')} />
            <ActionBtn title="🎯 TARGET VIN → BCM + RFH"  enabled={tvOk}
              desc={tvOk ? `Write ${tv} into BCM and RFHUB. Downloads both bins.` : 'Enter a valid 17-char VIN above.'}
              onClick={() => doSync('target-both')} />
          </div>

          {/* Gen2 SEC16 sync buttons */}
          {(bcmHasSec16 || sec16SyncOk) && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, color: C.a4, marginBottom: 8, textTransform: 'uppercase' }}>
                🔐 SEC16 / IMMO Sync (SINCRO-verified · Gen2)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                <ActionBtn title="🔐 SEC16 RFH → BCM (+ PCM SEC6)"  enabled={sec16SyncOk}
                  color={C.a4}
                  desc={sec16SyncOk
                    ? `Copy RFH SEC16 (reversed) into BCM split records + mirrors. Write first 6 bytes as PCM SEC6${pcm.bytes ? '' : ' (load PCM to also patch PCM)'}.`
                    : bcmHasSec16 ? 'RFHUB SEC16 is virgin or not detected' : 'BCM has no Gen2 SEC16 records'}
                  onClick={() => doSync('sec16-only')} />
                <ActionBtn title="🩹 Repair flat 0x40C9 from split records"
                  enabled={flatRepairOk}
                  color={C.a3}
                  desc={flatRepairOk
                    ? `Copy resolved SEC16 (source: ${flatRepairResolver.source} @0x${hex4(flatRepairResolver.offset)}) into legacy flat slice 0x40C9 (LE). Live split/mirror records untouched. For CGDI / Autel and other tools that still read the pre-Redeye flat field.`
                    : flatRepairResolver?.source === 'flat'
                      ? 'Resolver fell back to the flat slice itself — no live split/mirror records to copy from'
                      : flatRepairResolver?.blank
                        ? 'BCM SEC16 is blank (virgin) — nothing to repair'
                        : 'Requires a BCM with a populated SEC16 in split records or inactive-bank mirrors'}
                  onClick={() => doSync('bcm-flat-from-resolved')} />
                <ActionBtn title="🔄 BCM SEC16 → RFHUB"  enabled={bcmToRfhSec16Ok}
                  color={C.a2}
                  desc={bcmToRfhSec16Ok
                    ? 'BCM is master: writes reverse(BCM SEC16) into RFHUB Gen2 slots (0x050E + 0x0522). Use when RFHUB is from a different vehicle.'
                    : 'Requires BCM with Gen2 split records + Gen2 RFHUB (AA 55 31 01 header at 0x0500)'}
                  onClick={() => doSync('bcm-sec16-to-rfh')} />
                {(() => {
                  // Task #379: hard-block SYNC ALL when the loaded PCM is a
                  // non-canonical size (neither 4 KB nor 8 KB). The CGDI
                  // flasher will refuse the output, so producing it would
                  // give the user a junk file and a wasted bench cycle.
                  const pcmChip = pcm.parsed && !pcm.parsed.tooSmall
                    ? pcmChipFromSize(pcm.parsed.size) : null;
                  const pcmSizeBlocked = pcm.parsed && !pcm.parsed.tooSmall && !pcmChip;
                  const baseEnabled = tvOk || !!(rfh.parsed.vin);
                  const enabled = baseEnabled && !pcmSizeBlocked;
                  const desc = pcmSizeBlocked
                    ? `⛔ Loaded PCM is ${pcm.parsed.size} B — neither 4 KB (95320) nor 8 KB (95640). CGDI will reject. Re-read the PCM or load the matching virgin before SYNC.`
                    : tvOk
                      ? `Write ${tv} + SEC16 to all loaded modules in one pass. SINCRO-verified output.`
                      : `Write ${rfh.parsed.vin || bcm.parsed.vin} + SEC16 to all modules (no target VIN set).`;
                  return (
                    <ActionBtn title="⚡ SYNC ALL — BCM + RFH + PCM"
                      enabled={enabled}
                      color={pcmSizeBlocked ? C.er : C.a1}
                      desc={desc}
                      onClick={() => doSync('sync-all')} />
                  );
                })()}
              </div>
              {!sec16SyncOk && (
                <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(255,179,0,0.06)', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 600, lineHeight: 1.5 }}>
                  {bcmToRfhSec16Ok
                    ? '⚠ RFHUB SEC16 does not match BCM. Use "BCM SEC16 → RFHUB" (above) to re-sync the RFHUB to this BCM\'s secret, then key-program.'
                    : '⚠ SEC16 sync requires: BCM with Gen2 split records (0x81A0/C0/E0) AND RFHUB with populated SEC16 (not virgin).'}
                  {!bcmToRfhSec16Ok && !bcmHasSec16 && ' BCM: no SEC16 records detected.'}
                  {!bcmToRfhSec16Ok && bcmHasSec16 && !rfhHasSec16 && ' RFHUB: SEC16 is virgin or undetected.'}
                </div>
              )}
            </div>
          )}

          {/* Restore originals */}
          {(originals.bcm || originals.rfh || originals.pcm || originals.eep) && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              {originals.bcm && (
                <button onClick={() => doRestore('bcm')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a3}40`, background: `rgba(41,121,255,0.06)`, color: C.a3, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore BCM original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.bcm.filename}</span>
                </button>
              )}
              {originals.rfh && (
                <button onClick={() => doRestore('rfh')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a2}40`, background: `rgba(0,191,165,0.06)`, color: C.a2, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore RFH original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.rfh.filename}</span>
                </button>
              )}
              {originals.pcm && (
                <button onClick={() => doRestore('pcm')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a1}40`, background: `rgba(255,109,0,0.06)`, color: C.a1, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore PCM original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.pcm.filename}</span>
                </button>
              )}
              {originals.eep && (
                <button onClick={() => doRestore('eep')}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: `2px solid ${C.a4}40`, background: `rgba(170,0,255,0.06)`, color: C.a4, cursor: 'pointer', fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, letterSpacing: 0.5 }}>
                  ⟲ Restore 95640 original
                  <span style={{ fontSize: 10, fontWeight: 600, color: C.ts, fontFamily: "'JetBrains Mono'" }}>{originals.eep.filename}</span>
                </button>
              )}
            </div>
          )}

          {/* Virginize checkbox */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.c2, borderRadius: 10, marginTop: 10, border: `1.5px solid ${C.bd}` }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 1 }}>
              <input type="checkbox" checked={virginize} onChange={e => setVirginize(e.target.checked)}
                     style={{ width: 16, height: 16, accentColor: C.sr, cursor: 'pointer' }} />
              <span>🆕 VIRGINIZE RFH SEC16 ({rfhForVirginize})</span>
            </label>
            <div style={{ fontSize: 10, color: C.wn, fontWeight: 700, letterSpacing: 0.3 }}>⚠ forces re-pair on power-up</div>
          </div>
          <div style={{ fontSize: 11, color: C.ts, fontStyle: 'italic', padding: '8px 12px', background: C.c2, borderRadius: 8, borderLeft: `3px solid ${C.a3}`, marginTop: 8, lineHeight: 1.5 }}>
            <strong>Virginize</strong> wipes RFHUB's SEC16 so modules negotiate a fresh security key on first power-up. Use for salvage rebuilds; skip for factory-paired swaps.
            {rfh.parsed?.format === 'gen2' && <span style={{ color: C.a4 }}> Gen2 detected — will wipe 0x050E and 0x0522.</span>}
          </div>

          {/* Log */}
          <div ref={logRef} style={{ background: '#0F1419', color: '#E0E0E0', padding: '14px 16px', borderRadius: 10, fontFamily: "'JetBrains Mono'", fontSize: 11, lineHeight: 1.6, marginTop: 12, maxHeight: 280, overflowY: 'auto', border: '1.5px solid #2A2F36' }}>
            {logLines.map((l, i) => {
              const colors = { ok: '#4ADE80', warn: '#FACC15', err: '#F87171', info: '#60A5FA', muted: '#6B7280' };
              return (
                <div key={i} style={{ marginBottom: 2 }}>
                  <span style={{ color: '#6B7280', marginRight: 8 }}>{l.ts}</span>
                  <span style={{ color: colors[l.level] || '#E0E0E0' }}>{l.msg}</span>
                </div>
              );
            })}
          </div>
          <VinDiffTable rows={diffRows} />
        </Card>
      )}

      {/* ── P/N Override confirm dialog ── */}
      {overrideConfirm && (
        <OverrideConfirmModal
          modules={overrideConfirm.modules}
          onCancel={() => {
            log(`Sync cancelled — P/N override acknowledgement declined (${overrideConfirm.modules.join(', ')})`, 'warn');
            setOverrideConfirm(null);
          }}
          onConfirm={(dontAskAgain) => {
            const { action, overrideVin, modules } = overrideConfirm;
            if (dontAskAgain) {
              skipOverrideConfirmRef.current = true;
              log('P/N override prompt suppressed for the rest of this session.', 'muted');
            }
            log(`Tech acknowledged P/N override on ${modules.join(', ')} — proceeding with ${action}.`, 'warn');
            setOverrideConfirm(null);
            executeSync(action, overrideVin);
          }}
        />
      )}

      {/* ── Mismatch Resolution Wizard modal ── */}
      {wizardOpen && (
        <MismatchWizard
          issues={wizardIssues}
          warnings={wizardWarnings}
          modules={wizardModules}
          hexSnippets={wizardHexSnippets}
          bcmSec16Status={bcm.parsed?.bcmSec16 || null}
          onClose={() => setWizardOpen(false)}
          onAction={(actionId, _stepId, opts) => {
            return doSync(
              actionId === 'full-sync' ? 'sync-all' : actionId,
              opts?.vinOverride,
            );
          }}
          stepActions={wizardStepActions}
          sessionKey={`modsync:${vehicleId || 'global'}`}
        />
      )}
    </div>
  );
}
