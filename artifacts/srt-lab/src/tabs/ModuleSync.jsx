import React, { useState, useCallback, useEffect, useRef } from "react";
import { ASSET_IDS, trackDownload } from "../lib/downloadAssets.js";
import { DownloadCounter } from "../lib/useDownloadCount.jsx";
import { useMasterVin } from "../lib/masterVinContext.jsx";

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
 * PCM:   Continental GPEC2A (4KB, FF FF FF AA marker) or GPEC5 (8KB)
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
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const VIN_LEN  = 17;

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

function engParseBcm(bytes) {
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

function engParseRfh(bytes) {
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

function engParsePcm(bytes) {
  const r = {
    ok: false, kind: 'PCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    currentVin: null, originalVin: null,
    sec6: null, immoOk: false, immoDamaged: false,
    variant: bytes.length >= 8192 ? 'GPEC5' : 'GPEC2A',
    continentalPn: null, osPn: null, bodyPn: null,
  };

  for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
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

  /* SEC6 — GPEC2A uses FF FF FF AA marker, GPEC5 uses FF FF FF FF + non-all-FF bytes */
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xAA) {
      r.sec6 = { offset: i+4, bytes: bytes.slice(i+4, i+10), marker: 'FF FF FF AA' };
      break;
    }
  }
  if (!r.sec6) {
    for (let i = 0; i < bytes.length - 20; i++) {
      if (bytes[i] === 0xFF && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF && bytes[i+3] === 0xFF) {
        const n6 = bytes.slice(i+4, i+10);
        if (!n6.every(b => b === 0xFF)) {
          r.sec6 = { offset: i+4, bytes: n6, marker: 'FF FF FF FF' };
          break;
        }
      }
    }
    if (!r.sec6) r.immoDamaged = true;
  }
  r.immoOk = !!(r.sec6 && !r.sec6.bytes.every(b => b === 0xFF));

  if (bytes.length > 0x0FB0) {
    const pnB = bytes.slice(0x0FA1, 0x0FAE);
    const pn  = new TextDecoder('latin1').decode(pnB);
    if (/^A2C\d/.test(pn)) r.continentalPn = pn.trim();
  }
  const text = new TextDecoder('latin1').decode(bytes);
  const osM  = text.match(/\b0[0-9]{7}[A-Z]{2}\b/); if (osM) r.osPn = osM[0];
  const bpM  = text.match(/\b68[0-9]{6}[A-Z]{2}\b/); if (bpM) r.bodyPn = bpM[0];

  r.ok = r.vin !== null || r.sec6 !== null;
  return r;
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

/* SINCRO-verified: produces byte-identical output to ArmandoQS on ref dumps.
   Writes SEC16 to: (1) split records at 0x81A0/C0/E0, (2) mirrors (0xEB/0xCA)
   in the inactive bank. BCM SEC16 = reverse(RFH SEC16). */
function engWriteBcmSec16Gen2(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length !== 16) throw new Error('RFH SEC16 must be 16 bytes');
  const bcmSec16 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bcmSec16[i] = rfhSec16[15 - i];
  const prefix7 = bcmSec16.slice(0, 7);
  const suffix9  = bcmSec16.slice(7, 16);
  const out = new Uint8Array(bytes);
  let splitPatched = 0, mirrorPatched = 0;

  /* 1. Split records */
  for (const recOff of [0x81A0, 0x81C0, 0x81E0]) {
    if (recOff + 30 > out.length) continue;
    if (out[recOff] !== 0xFF || out[recOff+1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (out[recOff + j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = out[recOff + 8]; if (idx !== 0x01 && idx !== 0x02) continue;
    if (out[recOff+16] !== 0x04 || out[recOff+17] !== 0x04 || out[recOff+18] !== 0x00 || out[recOff+19] !== 0x14) continue;
    for (let k = 0; k < 7; k++) out[recOff + 9  + k] = prefix7[k];
    for (let k = 0; k < 9; k++) out[recOff + 20 + k] = suffix9[k];
    splitPatched++;
  }

  /* 2. Inactive bank */
  const bank0Seq = (out[0x0002] << 8) | out[0x0003];
  const bank1Seq = (out[0x4002] << 8) | out[0x4003];
  const inactiveBase = bank0Seq >= bank1Seq ? 0x4000 : 0x0000;

  const findRec = (base, slotType, sizeByte) => {
    const end = base + 0x4000;
    for (let i = base; i < end - 8; i++) {
      if (out[i] === 0x00 && out[i+1] === 0x00 && out[i+2] === 0x00 &&
          out[i+3] === sizeByte && out[i+4] === 0x00 && out[i+5] === 0x46 &&
          out[i+6] === slotType && out[i+7] === 0x00) return i;
    }
    return -1;
  };

  const writeMirror = (off) => {
    out[off + 8] = 0x02;
    for (let k = 0; k < 16; k++) out[off + 9 + k] = bcmSec16[k];
    out[off + 25] = 0x8F; out[off + 26] = 0xFF; out[off + 27] = 0xFF;
    const ci = new Uint8Array(20);
    ci[0] = 0x02;
    for (let k = 0; k < 16; k++) ci[1 + k] = bcmSec16[k];
    ci[17] = 0x8F; ci[18] = 0xFF; ci[19] = 0xFF;
    const crc = engCrc16(ci);
    out[off + 28] = (crc >> 8) & 0xFF;
    out[off + 29] = crc & 0xFF;
    out[off + 30] = 0xEB; out[off + 31] = 0x00;
  };

  const m1 = findRec(inactiveBase, 0xEB, 0x18);
  if (m1 >= 0) { writeMirror(m1); mirrorPatched++; }
  const m2 = findRec(inactiveBase, 0xCA, 0x28);
  if (m2 >= 0) { writeMirror(m2); mirrorPatched++; }

  const hx = a => [...a].map(b => b.toString(16).padStart(2,'0')).join('');
  return { bytes: out, splitPatched, mirrorPatched, inactiveBase, bcmSec16Hex: hx(bcmSec16) };
}

function engWritePcmSec6(bytes, rfhSec16) {
  if (!rfhSec16 || rfhSec16.length < 6) throw new Error('Need at least 6 bytes of RFH SEC16');
  const sec6 = rfhSec16.slice(0, 6);
  const out  = new Uint8Array(bytes);
  let patched = 0; let markerUsed = null;

  for (let i = 0; i < out.length - 10; i++) {
    if (out[i] === 0xFF && out[i+1] === 0xFF && out[i+2] === 0xFF && out[i+3] === 0xAA) {
      for (let k = 0; k < 6; k++) out[i + 4 + k] = sec6[k];
      patched++; markerUsed = 'FF FF FF AA';
    }
  }
  if (patched === 0) {
    for (let i = 0; i < out.length - 20; i++) {
      if (out[i] === 0xFF && out[i+1] === 0xFF && out[i+2] === 0xFF && out[i+3] === 0xFF) {
        let hasData = false;
        for (let k = 0; k < 6; k++) if (out[i+4+k] !== 0xFF) { hasData = true; break; }
        if (hasData) {
          for (let k = 0; k < 6; k++) out[i + 4 + k] = sec6[k];
          patched++; markerUsed = 'FF FF FF FF'; break;
        }
      }
    }
  }
  const hx = [...sec6].map(b => b.toString(16).padStart(2,'0')).join('');
  return { bytes: out, patched, markerUsed, sec6Hex: hx };
}

function engWritePcmVin(bytes, newVin) {
  if (!VIN_RE.test(newVin)) throw new Error('Invalid VIN: ' + newVin);
  const out = new Uint8Array(bytes);
  const vb  = new TextEncoder().encode(newVin);
  let patched = 0;
  for (const off of [0x0000, 0x01F0, 0x0224, 0x0CE0]) {
    if (off + 17 > out.length) continue;
    for (let k = 0; k < 17; k++) out[off + k] = vb[k];
    patched++;
  }
  return { bytes: out, patched };
}

/* ==========================================================================
 * VEHICLE CATALOG — part-number awareness
 * ========================================================================== */

const BCM_PN_VEHICLES = {
  '68525720': { name: 'Charger / Challenger / Durango (2011-2014 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68277389': { name: 'Charger / Challenger / Durango (2015-2017 LX/LC/WD)', gen: 'gen1', sec: 'Gen1 18-byte' },
  '68396561': { name: 'Charger / Challenger / Durango (2018-2020 LD/LC/WD)', gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68354769': { name: 'Grand Cherokee Trackhawk (2018-2021 WK2)',             gen: 'gen2', sec: 'Gen2 SEC16 split' },
  '68463847': { name: 'Ram 1500 TRX (2021-2024 DT)',                          gen: 'gen2', sec: 'Gen2 SEC16 split' },
};

/* Vehicle family definitions — used for the mismatch warning selector */
const VEHICLE_FAMILIES = [
  { id: 'charger',    label: 'Dodge Charger (LX/LD · 2011–2023)',         expectedPns: ['68525720','68277389','68396561'] },
  { id: 'challenger', label: 'Dodge Challenger (LC · 2011–2023)',          expectedPns: ['68525720','68277389','68396561'] },
  { id: 'durango',    label: 'Dodge Durango (WD · 2011–2023)',             expectedPns: ['68525720','68277389','68396561'] },
  { id: 'trackhawk',  label: 'Grand Cherokee Trackhawk (WK2 · 2018–2021)', expectedPns: ['68354769'] },
  { id: 'trx',        label: 'Ram 1500 TRX (DT · 2021–2024)',              expectedPns: ['68463847'] },
];

function bcmVehicleMatch(parsedBcm) {
  if (!parsedBcm || !parsedBcm.partNumbers) return null;
  for (const pn of parsedBcm.partNumbers) {
    const trimmed = pn.replace(/[^0-9]/g, '');
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

function BcmCard({ parsed }) {
  if (!parsed) return null;
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
      </div>
      <Kv k="Stored VIN"   v={parsed.vin} mono />
      <Kv k="VIN slots"    v={`${parsed.vinSlots.length} / 4 · ${parsed.vinConsistent ? 'all match' : 'MISMATCH'}`} />
      <Kv k="File size"    v={`${parsed.size} bytes (${(parsed.size/1024).toFixed(1)} KB)`} mono />
      {parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.crcOk);
        const crc   = parsed.vinSlots[0].computedCrc;
        return <Kv k="VIN CRC-16" v={`0x${hex4(crc)} · ${allOk ? '✓ valid' : '✗ mismatch'}`} mono color={allOk ? C.gn : C.er} />;
      })()}
      {match && <Kv k="Vehicle"  v={match.name} />}
      {parsed.partNumbers.length > 0 && <Kv k="Part numbers" v={parsed.partNumbers.join(', ')} mono />}
      {parsed.supplierSerial && <Kv k="Supplier" v={parsed.supplierSerial} mono />}
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
            {parsed.sec16Hex && <Kv k="SEC16 hex" v={parsed.sec16Hex.toUpperCase()} mono />}
          </div>
        </>
      )}
      {parsed.sec16Mirrors.length > 0 && (
        <Kv k="Mirror recs"
            v={`${parsed.mirrorsPopulated || 0} populated · ${parsed.sec16Mirrors.filter(m => m.crcOk).length} CRC OK`}
            color={parsed.mirrorsPopulated > 0 ? C.gn : C.tm} />
      )}
      {!hasSec16 && isGen2 && (
        <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(255,179,0,0.08)', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 700 }}>
          ⚠ Gen2 BCM — no SEC16 records found. May need a different flash layout.
        </div>
      )}
    </div>
  );
}

function RfhCard({ parsed }) {
  if (!parsed) return null;
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
      </div>
      <Kv k="Stored VIN"  v={parsed.vin} mono />
      <Kv k="VIN slots"   v={`${parsed.vinSlots.length} / 4 · ${parsed.vinConsistent ? 'all match' : 'MISMATCH'}`} />
      <Kv k="File size"   v={`${parsed.size} bytes`} mono />
      {parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.chkOk);
        const chk   = parsed.vinSlots[0].computedChk;
        return <Kv k="VIN checksum" v={`0x${hex2(chk)} · ${allOk ? '✓ valid' : '⚠ mismatch'}`} mono color={allOk ? C.gn : C.wn} />;
      })()}
      {parsed.partNumbers.length > 0 && <Kv k="Part numbers" v={parsed.partNumbers.join(', ')} mono />}
      {parsed.internalSerial && <Kv k="Serial" v={parsed.internalSerial} mono />}
      <Kv k="Keys stored"   v={`${parsed.keyCount} slot${parsed.keyCount === 1 ? '' : 's'} populated`} />

      {parsed.sec16 && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${C.bd}`, paddingTop: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: 0.8, color: C.a4, marginBottom: 4 }}>
            SEC16 · {parsed.format === 'gen2' ? `0x${hex4(0x050E)} / 0x${hex4(0x0522)}` : `0x${hex4(0x0226)} / 0x${hex4(0x023A)}`}
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

function PcmCard({ parsed }) {
  if (!parsed) return null;
  let status = 'READY', statusColor = C.gn;
  if (!parsed.ok)         { status = 'UNKNOWN';     statusColor = C.wn; }
  if (!parsed.immoOk)     { status = 'IMMO ✗';      statusColor = C.er; }
  if (parsed.immoDamaged) { status = 'DAMAGED';      statusColor = C.er; }
  if (parsed.ok && parsed.immoOk) { status = 'READY'; statusColor = C.gn; }

  return (
    <div style={{ background: 'rgba(0,200,83,0.02)', borderRadius: 12, padding: 16, border: `1.5px solid ${statusColor}40` }}>
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        ⚙️ PCM · Continental
        <Badge text={status} color={statusColor} />
        <Badge text={parsed.variant} color={C.a1} />
      </div>
      <Kv k="Current VIN"  v={parsed.currentVin || parsed.vin} mono />
      {parsed.originalVin && parsed.originalVin !== parsed.currentVin &&
        <Kv k="Original VIN" v={parsed.originalVin} mono color={C.wn} hint="← donor VIN" />}
      <Kv k="VIN slots"    v={`${parsed.vinSlots.length} found`} />
      <Kv k="File size"    v={`${parsed.size} bytes (${(parsed.size/1024).toFixed(1)} KB)`} mono />
      <Kv k="Immo (SEC6)"  v={parsed.immoDamaged ? 'DAMAGED / MISSING' : parsed.immoOk ? '✓ Populated' : 'Virgin (all FF)'}
          color={parsed.immoDamaged ? C.er : parsed.immoOk ? C.gn : C.wn} />
      {parsed.sec6 && (
        <>
          <Kv k="SEC6 marker" v={parsed.sec6.marker} mono />
          <Kv k="SEC6 bytes"  v={bytesToHex(parsed.sec6.bytes).toUpperCase()} mono />
        </>
      )}
      {parsed.continentalPn && <Kv k="Continental PN" v={parsed.continentalPn} mono />}
      {parsed.osPn   && <Kv k="OS PN"   v={parsed.osPn}   mono />}
      {parsed.bodyPn && <Kv k="Body PN" v={parsed.bodyPn} mono />}
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

export default function ModuleSync() {
  const { vin: masterVin, vinValid: masterVinValid } = useMasterVin();

  const [bcm, setBcm] = useState({ file: null, bytes: null, parsed: null });
  const [rfh, setRfh] = useState({ file: null, bytes: null, parsed: null });
  const [pcm, setPcm] = useState({ file: null, bytes: null, parsed: null });
  const [vehicleFamily, setVehicleFamily] = useState('');

  const [targetVin, setTargetVin] = useState('');
  const [virginize, setVirginize] = useState(false);
  const [logLines,  setLogLines]  = useState([]);
  const [diffRows,  setDiffRows]  = useState([]);
  const [originals, setOriginals] = useState({ bcm: null, rfh: null, pcm: null });
  const logRef = useRef(null);

  const log = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines(p => [...p, { ts, msg, level }]);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logLines]);
  useEffect(() => {
    log('SRT Lab Module Sync v2 (SINCRO-verified engine) ready.', 'info');
    log('Supports: BCM Gen1/Gen2 (SEC16 split records + mirrors) · RFHUB Gen1/Gen2 · PCM GPEC2A/GPEC5', 'muted');
  }, [log]);

  const handleBcm = useCallback((file, bytes) => {
    const parsed = engParseBcm(bytes);
    setBcm({ file, bytes, parsed });
    setDiffRows([]); setOriginals(prev => ({ ...prev, bcm: null }));
    log(`Loaded BCM: ${file.name} (${bytes.length} bytes)`, 'info');
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
  }, [log]);

  const handleRfh = useCallback((file, bytes) => {
    const parsed = engParseRfh(bytes);
    setRfh({ file, bytes, parsed });
    setDiffRows([]); setOriginals(prev => ({ ...prev, rfh: null }));
    log(`Loaded RFHUB: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.ok) {
      log(`  RFHUB VIN: ${parsed.vin} · format: ${parsed.format}`, 'ok');
      if (parsed.sec16) log(`  SEC16: ${parsed.sec16.virgin ? 'VIRGIN' : parsed.sec16.match ? 'matched' : 'MISMATCH'} · ${[...parsed.sec16.slot1].map(hex2).join('').toUpperCase()}`, 'muted');
    } else {
      log('  RFHUB: no VIN parsed — file format not recognized', 'err');
    }
  }, [log]);

  const handlePcm = useCallback((file, bytes) => {
    const parsed = engParsePcm(bytes);
    setPcm({ file, bytes, parsed });
    setDiffRows([]); setOriginals(prev => ({ ...prev, pcm: null }));
    log(`Loaded PCM: ${file.name} (${bytes.length} bytes) · ${parsed.variant}`, 'info');
    if (parsed.vin)  log(`  PCM VIN: ${parsed.currentVin}${parsed.originalVin && parsed.originalVin !== parsed.currentVin ? ` (orig: ${parsed.originalVin})` : ''}`, parsed.ok ? 'ok' : 'warn');
    if (parsed.sec6) log(`  SEC6: ${parsed.sec6.bytes.map(hex2).join('').toUpperCase()} (marker ${parsed.sec6.marker})`, 'muted');
    if (parsed.immoDamaged) log('  ⚠ PCM: no SEC6 marker found — may be damaged or wrong file', 'warn');
  }, [log]);

  const tv      = targetVin.replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, VIN_LEN);
  const tvOk    = tv.length === VIN_LEN && VIN_RE.test(tv);
  const loaded  = (bcm.bytes ? 1 : 0) + (rfh.bytes ? 1 : 0) + (pcm.bytes ? 1 : 0);
  const bothReady = !!(bcm.bytes && rfh.bytes && bcm.parsed?.ok && rfh.parsed?.ok);
  const vinMatch  = bothReady && bcm.parsed.vin === rfh.parsed.vin;

  /* SEC16 sync eligibility */
  const bcmHasSec16   = !!(bcm.parsed?.sec16Records?.length > 0 || bcm.parsed?.mirrorsPopulated > 0);
  const rfhHasSec16   = !!(rfh.parsed?.sec16 && !rfh.parsed.sec16.virgin);
  const sec16SyncOk   = bcmHasSec16 && rfhHasSec16;

  const doSync = (action) => {
    const ts  = timestamp();
    log(`=== SYNC: ${action}${virginize ? ' +VIRGINIZE' : ''} ===`, 'info');
    const rows = [];

    const addBcmRows = (parsedBcm, newVin, newCrc) => {
      parsedBcm.vinSlots.forEach((s, idx) => {
        rows.push({
          module: 'BCM', slot: idx + 1, offset: `0x${hex4(s.offset)}`,
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
          module: 'RFHUB', slot: idx + 1, offset: `0x${hex4(s.offset)}`,
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
          module: 'PCM', slot: idx + 1, offset: `0x${hex4(s.offset)}`,
          oldVin: s.vin, newVin,
          checkLabel: '',
          oldCheck: '—', newCheck: '—',
          oldPass: null, newPass: true,
        });
      });
    };

    try {
      if (action === 'rfh-to-bcm') {
        const newVin = rfh.parsed.vin;
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
        const newVin = bcm.parsed.vin;
        const snap   = new Uint8Array(rfh.bytes);
        setOriginals(prev => ({ ...prev, rfh: { bytes: snap, filename: rfh.file?.name || 'RFH' } }));
        const r  = engWriteRfhVin(rfh.bytes, newVin, virginize);
        addRfhRows(rfh.parsed, newVin, r.chk);
        log(`RFHUB: patched ${r.patched} slot(s)${virginize ? ` + wiped ${r.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        downloadBin(r.bytes, `RFH_SYNCED${virginize ? '_VIRGIN' : ''}_${newVin}_${ts}.bin`);
        log(`Downloaded: RFH_SYNCED_${newVin}_${ts}.bin`, 'ok');

      } else if (action === 'target-both') {
        const newVin = tv;
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
        const newVin = tvOk ? tv : (rfh.parsed?.vin || bcm.parsed?.vin);
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
          if (rfhSec16 && rfhSec16.length >= 6) {
            const sr = engWritePcmSec6(pcmFinal, rfhSec16);
            pcmFinal = sr.bytes;
            log(`PCM SEC6: ${sr.patched} location(s) written · ${sr.sec6Hex.toUpperCase()} (marker ${sr.markerUsed})`, 'ok');
          }
          downloadBin(pcmFinal, `PCM_SYNCED_${newVin}_${ts}.bin`);
          log(`Downloaded: PCM_SYNCED_${newVin}_${ts}.bin`, 'ok');
        }

      } else if (action === 'sec16-only') {
        /* SEC16 sync only — BCM SEC16 ← RFH, PCM SEC6 ← RFH */
        const rfhSec16 = rfh.parsed?.sec16?.slot1;
        if (!rfhSec16) { log('✗ No RFH SEC16 available', 'err'); return; }
        const snapB = new Uint8Array(bcm.bytes);
        setOriginals(prev => ({ ...prev, bcm: { bytes: snapB, filename: bcm.file?.name || 'BCM' } }));
        const sr = engWriteBcmSec16Gen2(bcm.bytes, rfhSec16);
        log(`BCM SEC16 sync: ${sr.splitPatched} split record(s) + ${sr.mirrorPatched} mirror(s) written`, 'ok');
        log(`  Inactive bank: 0x${hex4(sr.inactiveBase)} · BCM SEC16: ${sr.bcmSec16Hex.toUpperCase()}`, 'muted');
        downloadBin(sr.bytes, `BCM_SEC16_SYNCED_${ts}.bin`);
        log(`Downloaded: BCM_SEC16_SYNCED_${ts}.bin`, 'ok');
        if (pcm.bytes && pcm.parsed && rfhSec16.length >= 6) {
          const snapP = new Uint8Array(pcm.bytes);
          setOriginals(prev => ({ ...prev, pcm: { bytes: snapP, filename: pcm.file?.name || 'PCM' } }));
          const pr = engWritePcmSec6(pcm.bytes, rfhSec16);
          log(`PCM SEC6: ${pr.patched} location(s) written · marker ${pr.markerUsed}`, 'ok');
          downloadBin(pr.bytes, `PCM_SEC6_SYNCED_${ts}.bin`);
        }
      }

      log('✓ Sync complete. Flash .bin file(s) to modules and power-cycle 30 s for handshake.', 'ok');
      setDiffRows(rows);
      log('ℹ Use the Restore buttons below to recover pre-patch bytes if needed.', 'muted');
    } catch (e) {
      log(`✗ Error: ${e.message}`, 'err');
    }
  };

  const doRestore = (kind) => {
    const snap = originals[kind]; if (!snap) return;
    const prefix = kind === 'bcm' ? 'BCM' : kind === 'rfh' ? 'RFH' : 'PCM';
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

      {/* ── Load & Inspect ── */}
      <Card>
        <H2 badge={`${loaded} / 3`}>Load &amp; Inspect</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <DropZone label="BCM"      icon="🧠" hint="MPC5606B DFLASH · Gen1 or Gen2 · drag .bin"
                    file={bcm.file} onFile={handleBcm} />
          <DropZone label="RFHUB / FCM" icon="🔑" hint="Yazaki FCM EEPROM · Gen1 or Gen2 · drag .bin"
                    file={rfh.file} onFile={handleRfh} accent={C.a4} />
          <DropZone label="PCM (optional)" icon="⚙️" hint="GPEC2A (4KB) or GPEC5 (8KB) · drag .bin"
                    file={pcm.file} onFile={handlePcm} accent={C.a1} />
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

          {/* VIN match banner */}
          {bothReady && (
            <div style={{
              padding: '14px 18px', borderRadius: 12, marginBottom: 14,
              fontWeight: 800, fontSize: 13, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 10,
              background: vinMatch ? 'rgba(0,200,83,0.1)' : 'rgba(255,23,68,0.08)',
              color: vinMatch ? '#0a7a3b' : '#a00025',
              border: `1.5px solid ${vinMatch ? 'rgba(0,200,83,0.3)' : 'rgba(255,23,68,0.25)'}`,
            }}>
              {vinMatch ? '✓ VIN MATCH' : '✗ VIN MISMATCH'} —{' '}
              {vinMatch
                ? <>BCM and RFHUB both carry <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · modules already paired</>
                : <>BCM: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · RFHUB: <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{rfh.parsed.vin}</strong> · sync required</>}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            <BcmCard parsed={bcm.parsed} />
            <RfhCard parsed={rfh.parsed} />
            {pcm.parsed && <PcmCard parsed={pcm.parsed} />}
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
                <ActionBtn title="⚡ SYNC ALL — BCM + RFH + PCM"  enabled={tvOk || !!(rfh.parsed.vin)}
                  color={C.a1}
                  desc={tvOk
                    ? `Write ${tv} + SEC16 to all loaded modules in one pass. SINCRO-verified output.`
                    : `Write ${rfh.parsed.vin || bcm.parsed.vin} + SEC16 to all modules (no target VIN set).`}
                  onClick={() => doSync('sync-all')} />
              </div>
              {!sec16SyncOk && (
                <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(255,179,0,0.06)', borderRadius: 8, fontSize: 11, color: C.wn, fontWeight: 600, lineHeight: 1.5 }}>
                  ⚠ SEC16 sync requires: BCM with Gen2 split records (0x81A0/C0/E0) AND RFHUB with populated SEC16 (not virgin).
                  {!bcmHasSec16 && ' BCM: no SEC16 records detected.'}
                  {bcmHasSec16 && !rfhHasSec16 && ' RFHUB: SEC16 is virgin or undetected.'}
                </div>
              )}
            </div>
          )}

          {/* Restore originals */}
          {(originals.bcm || originals.rfh || originals.pcm) && (
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
    </div>
  );
}
