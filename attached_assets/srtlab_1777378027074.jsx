import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
 *  SRT LAB v3 — Module Analyzer + ECM Flash Toolkit
 *  Pairing · Seed→Key · EFD Inspector · CDA6 Session · Cal Compare
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── CRC engines ── */
function crc16ccitt(data, init = 0xFFFF) {
  let c = init;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i] << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) : (c << 1);
    c &= 0xFFFF;
  }
  return c;
}
function crc8_0x26(data, init = 0) {
  let c = init;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x26) : (c << 1);
    c &= 0xFF;
  }
  return c;
}
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = c & 1 ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ── Helpers ── */
const hx = (d) => Array.from(d).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const hxs = (d) => Array.from(d).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const isBlank = (d) => d.every(b => b === 0xFF);
const isZero = (d) => d.every(b => b === 0x00);
const u32 = n => n >>> 0;

/* Entropy calc */
function entropy(d) {
  if (!d || d.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (let i = 0; i < d.length; i++) counts[d[i]]++;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i]) {
      const p = counts[i] / d.length;
      e -= p * Math.log2(p);
    }
  }
  return e;
}

/* ── Seed-Key engines ── */
function sxor(s, c) { let k = u32(s); for (let i = 0; i < 5; i++) k = k & 0x80000000 ? u32((k << 1) ^ u32(c)) : u32(k << 1); return k; }
function cda6(s) {
  // Verified CDA6 algorithm — used for FCA security access UDS 0x27
  let k = u32(s);
  k = u32(k ^ 0x4B129F);
  k = u32((k << 3) | (k >>> 29));
  k = u32(k + 0x1234);
  k = u32(k ^ 0xABCD);
  return u32((k >>> 5) | (k << 27));
}
const NT = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];
const NS = [0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s) { let k = 0; for (let i = 0; i < 4; i++) { let b = (u32(s) >> (i * 8)) & 0xFF; k = u32(k ^ u32(((NT[b & 0xF] ^ NT[(b >> 4) & 0xF]) * NS[i % 8]) & 0xFFFFFFFF)); } return k; }
function cfGPEC(s) { const KB = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x33]; function sk(b) { let x = KB[b+3]<<3; x ^= KB[b+2]; x <<= 2; x ^= KB[b+1]; x <<= 3; x ^= KB[b+0]; return x & 0xFFFF; } const K = [sk(0),sk(4),sk(8),sk(12)]; function sw(x) { return (((x&0xFF)<<8)|((x>>>8)&0xFF))&0xFFFF; } let v0 = sw((s>>>16)&0xFFFF), v1 = sw(s&0xFFFF), sum = 0; for (let i = 0; i < 16; i++) { sum = (sum + 0xFFFF9E37) & 0xFFFF; v0 = (v0 + ((((v1<<4)+K[0])^((v1>>>5)+K[1]))^(sum+v1))) & 0xFFFF; v1 = (v1 + ((((v0<<4)+K[2])^((v0>>>5)+K[3]))^(sum+v0))) & 0xFFFF; } return ((sw(v0) << 16) | sw(v1)) >>> 0; }

const ALGOS = [
  { id: 'cda6', n: 'CDA6', h: 'BCM/ABS/IPC · ECM SecAccess', fn: s => cda6(s) },
  { id: 'gpec2', n: 'GPEC2', h: 'Continental', fn: s => sxor(s, 0xE72E3799) },
  { id: 'gpec3', n: 'GPEC3', h: '2018+ PCM', fn: s => sxor(s, 0x129D657F) },
  { id: 'gpec2a', n: 'GPEC2A', h: 'GPEC2A variant', fn: s => sxor(s, 0xCE853A6F) },
  { id: 'gpec_tea', n: 'GPEC TEA', h: 'gpec.dll TEA', fn: s => cfGPEC(s) },
  { id: 'ecm', n: 'ECM', h: '0x8A3C71', fn: s => sxor(s, 0x8A3C71) },
  { id: 'tcm', n: 'TCM', h: '0x6E4B92', fn: s => sxor(s, 0x6E4B92) },
  { id: 'rfhub', n: 'RFHUB', h: '0xD5F1', fn: s => sxor(s, 0xD5F1) },
  { id: 'ngc', n: 'NGC', h: 'DAIMLERCHRYSLER', fn: s => ngc(s) },
  { id: 'abs', n: 'ABS', h: '0x4B129F', fn: s => sxor(s, 0x4B129F) },
  { id: 'gpec15', n: 'GPEC 2015', h: '2015-18', fn: s => sxor(s, 0x47EC21F8) },
];

/* ══════════════════════════════════════════════════════════════════════
 *  FILE ANALYSIS — same as v2 + new C-flash detection
 * ══════════════════════════════════════════════════════════════════════ */
function analyzeFile(buf, name) {
  const d = new Uint8Array(buf);
  const sz = d.length;
  const result = { name, size: sz, data: d, type: 'unknown', vins: [], sec16: null, bcmFrag: null, sec6: null, security: {}, partNumbers: [], buildDate: null };

  // ── Type detection ──
  if (sz === 65536 || sz === 131072) result.type = 'BCM';
  else if (sz === 4096) {
    let asciiCount = 0;
    for (let i = 0; i < Math.min(17, sz); i++) if (d[i] >= 0x30 && d[i] <= 0x5A) asciiCount++;
    result.type = asciiCount >= 10 ? 'GPEC2A' : 'RFHUB';
  } else if (sz === 8192) {
    let asciiCount = 0;
    for (let i = 0; i < Math.min(17, sz); i++) if (d[i] >= 0x30 && d[i] <= 0x5A) asciiCount++;
    result.type = asciiCount >= 10 ? 'GPEC2A' : 'RFHUB';
  } else if (sz === 1048576 || sz === 2097152 || sz === 4194304 || sz === 393216 || sz === 262144 || sz === 131072) {
    // Likely C-flash / firmware
    result.type = sz >= 1048576 ? 'CFLASH' : 'FW';
  } else if (sz > 131072) result.type = 'FW';

  // Common analysis: extract Mopar PNs and build dates
  const text = new TextDecoder('latin-1').decode(d);
  const pnRegex = /(0[5-9]|68)\d{6}[A-Z]{2}/g;
  let m;
  const seenPN = new Set();
  while ((m = pnRegex.exec(text)) !== null) {
    if (!seenPN.has(m[0])) {
      result.partNumbers.push({ pn: m[0], offset: m.index });
      seenPN.add(m[0]);
      if (result.partNumbers.length >= 20) break;
    }
  }
  // Build date
  const dateRegex = /\d{2}\/\d{2}\/\d{2}/;
  const dateMatch = text.match(dateRegex);
  if (dateMatch) result.buildDate = { date: dateMatch[0], offset: dateMatch.index };

  // ── RFHUB ──
  if (result.type === 'RFHUB') {
    for (const [gen, pri, bak] of [['gen2', 0x050E, 0x0522], ['gen1', 0x0226, 0x023A]]) {
      if (pri + 16 > sz) continue;
      const sec = d.slice(pri, pri + 16);
      if (isBlank(sec) || isZero(sec)) continue;
      const bakData = bak + 16 <= sz ? d.slice(bak, bak + 16) : null;
      let match = false;
      if (bakData) {
        match = true;
        for (let j = 0; j < 16; j++) { if (sec[j] !== bakData[j]) { match = false; break; } }
      }
      result.sec16 = { value: hx(sec), raw: sec, gen, priOff: pri, bakOff: bak, bakMatch: match };
      break;
    }
    for (const off of [0xEA5, 0xEB9, 0xECD, 0xEE1]) {
      if (off + 17 > sz) continue;
      const raw = d.slice(off, off + 17);
      if (isBlank(raw) || isZero(raw)) continue;
      const rev = new Uint8Array(17);
      for (let j = 0; j < 17; j++) rev[j] = raw[16 - j];
      let vin = '';
      let valid = true;
      for (let j = 0; j < 17; j++) {
        const c = String.fromCharCode(rev[j]);
        if (!'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'.includes(c)) { valid = false; break; }
        vin += c;
      }
      if (valid) { result.vins.push({ vin, offset: off, algo: 'reversed' }); break; }
    }
  }

  // ── BCM ──
  if (result.type === 'BCM') {
    const seen = new Set();
    for (let i = 0; i <= sz - 19; i++) {
      let ok = true;
      for (let j = 0; j < 17; j++) if (d[i + j] < 0x20 || d[i + j] > 0x7E) { ok = false; break; }
      if (!ok) continue;
      let vin = '';
      for (let j = 0; j < 17; j++) vin += String.fromCharCode(d[i + j]);
      if (!/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(vin)) continue;
      if (seen.has(vin)) continue;
      const storedCrc = (d[i + 17] << 8) | d[i + 18];
      const calcCrc = crc16ccitt(d.slice(i, i + 17));
      if (storedCrc === calcCrc) {
        result.vins.push({ vin, offset: i, algo: 'CRC16', storedCrc, calcCrc });
        seen.add(vin);
      }
    }
    if (0x81B1 <= sz) {
      const frag = d.slice(0x81A9, 0x81B1);
      if (!isBlank(frag)) {
        result.bcmFrag = { value: hx(frag), raw: frag, offset: 0x81A9 };
      }
    }
    if (0x40E0 <= sz) result.security.immoBlank = isBlank(d.slice(0x40C0, 0x40E0));
  }

  // ── GPEC2A ──
  if (result.type === 'GPEC2A') {
    let vin = '', valid = true;
    for (let j = 0; j < 17 && j < sz; j++) {
      const c = String.fromCharCode(d[j]);
      if (!'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'.includes(c)) { valid = false; break; }
      vin += c;
    }
    if (valid && vin.length === 17) result.vins.push({ vin, offset: 0, algo: 'plain' });
    if (sz > 0x11) {
      result.security.skim = d[0x11];
      result.security.skimEnabled = d[0x11] === 0x80;
    }
    // Find FFFFFFAA marker + SEC6
    for (let i = 0; i < sz - 10; i++) {
      if (d[i] === 0xFF && d[i+1] === 0xFF && d[i+2] === 0xFF && d[i+3] === 0xAA) {
        result.sec6 = { value: hx(d.slice(i+4, i+10)), raw: d.slice(i+4, i+10), offset: i+4, markerOffset: i };
        break;
      }
    }
  }

  // ── C-FLASH / FW ──
  if (result.type === 'CFLASH' || result.type === 'FW') {
    // PowerPC reset vector check (MPC56xx)
    if (sz >= 4) {
      result.security.bootloaderSig = hx(d.slice(0, 8));
      result.security.isPPC = (d[0] === 0x00 && d[1] === 0x5A && d[2] === 0x00 && d[3] === 0x5A);
    }
    // AES S-box detection
    const sbox = [0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5];
    for (let i = 0; i <= sz - 8; i++) {
      let found = true;
      for (let j = 0; j < 8; j++) if (d[i + j] !== sbox[j]) { found = false; break; }
      if (found) { result.security.aesSbox = i; break; }
    }
    // GPEC unlock byte check
    if (sz > 0x2FFFC) {
      result.security.unlockByte = d[0x2FFFC];
      result.security.unlocked = d[0x2FFFC] === 0x96;
    }
    // Calibration ID — usually 68xxxxxx near start
    // Already extracted to partNumbers above
    if (result.partNumbers.length > 0) {
      result.security.calId = result.partNumbers[0].pn;
    }
    // Tuner signature check
    const tunerMarkers = [
      ['DIABLO', 'DiabloSport'],
      ['HP TUNERS', 'HP Tuners'],
      ['HPT', 'HP Tuners'],
      ['SCT', 'SCT'],
      ['COBB', 'COBB'],
      ['JBA', 'JBA'],
    ];
    result.security.tunerSigs = [];
    for (const [marker, label] of tunerMarkers) {
      const enc = new TextEncoder().encode(marker);
      for (let i = 0; i <= sz - enc.length; i++) {
        let found = true;
        for (let j = 0; j < enc.length; j++) if (d[i + j] !== enc[j]) { found = false; break; }
        if (found) {
          result.security.tunerSigs.push({ marker, label, offset: i });
          break;
        }
      }
    }
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════════════
 *  EFD CONTAINER PARSER
 *  Parses Mopar EFD/.webm encrypted cal files
 * ══════════════════════════════════════════════════════════════════════ */
function parseEFD(buf, name) {
  const d = new Uint8Array(buf);
  const sz = d.length;
  const result = { name, size: sz, valid: false, metadata: {}, sections: [], payload: null, error: null };

  // EBML magic check
  if (sz < 16 || d[0] !== 0x1A || d[1] !== 0x45 || d[2] !== 0xDF || d[3] !== 0xA3) {
    result.error = 'Not an EBML/EFD file (missing 1A45DFA3 magic)';
    return result;
  }

  result.valid = true;

  // Parse top-level EBML elements
  function readId(pos) {
    if (pos >= d.length) return null;
    const first = d[pos];
    if (first === 0) return null;
    let mask = 0x80, length = 1;
    while (!(first & mask)) { mask >>= 1; length++; if (length > 4) return null; }
    let value = 0;
    for (let i = 0; i < length; i++) value = (value * 256) + d[pos + i];
    return { id: value, length, end: pos + length };
  }
  function readVint(pos) {
    if (pos >= d.length) return null;
    const first = d[pos];
    if (first === 0) return null;
    let mask = 0x80, length = 1;
    while (!(first & mask)) { mask >>= 1; length++; if (length > 8) return null; }
    let value = first & (mask - 1);
    for (let i = 1; i < length; i++) value = (value * 256) + d[pos + i];
    return { value, length, end: pos + length };
  }

  let pos = 0;
  let count = 0;
  while (pos < d.length && count < 50) {
    const idResult = readId(pos);
    if (!idResult) break;
    const sizeResult = readVint(idResult.end);
    if (!sizeResult) break;

    const elemStart = sizeResult.end;
    const elemSize = sizeResult.value;
    const idHex = idResult.id.toString(16).toUpperCase();

    result.sections.push({
      offset: pos,
      id: idHex,
      size: elemSize,
      dataStart: elemStart,
    });

    // Known element IDs from Mopar EFD analysis
    if (idResult.id === 0x1A45DFA3) {
      // EBML header — descend
      pos = elemStart;
    } else if (idResult.id === 0x00204653) {
      // FS section (encrypted? metadata)
      pos = elemStart + elemSize;
    } else if (idResult.id === 0x00204453) {
      // DS section — plaintext metadata!
      const dsData = d.slice(elemStart, elemStart + elemSize);
      const dsText = new TextDecoder('latin-1').decode(dsData);
      // Parse "Key = Value" lines
      const lines = dsText.split(/[\r\n\0]+/).filter(l => l.includes('='));
      for (const line of lines) {
        const [k, v] = line.split('=', 2).map(s => s.trim());
        if (k && v) result.metadata[k] = v;
      }
      result.metadata._dsRaw = dsText;
      pos = elemStart + elemSize;
    } else if (idResult.id === 0x0020434F) {
      // CO section
      const coData = d.slice(elemStart, elemStart + elemSize);
      result.metadata._co = new TextDecoder('latin-1').decode(coData);
      pos = elemStart + elemSize;
    } else if (idResult.id === 0x00205550) {
      // UP section — the encrypted payload
      result.payload = {
        offset: elemStart,
        size: elemSize,
        end: elemStart + elemSize,
        entropy: entropy(d.slice(elemStart, Math.min(elemStart + 65536, d.length))),
      };
      pos = elemStart + elemSize;
    } else {
      pos = elemStart + elemSize;
    }
    count++;
    if (pos >= d.length) break;
  }

  // Identify file type from metadata
  if (result.metadata.Engine || result.metadata.Program) {
    result.efdType = 'mopar_powercal';
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════════════
 *  CROSS-MATCH (same as v2)
 * ══════════════════════════════════════════════════════════════════════ */
function crossMatch(files) {
  const results = { vinMap: {}, sec16Chains: [], pairings: [], issues: [] };
  files.forEach(f => {
    f.vins.forEach(v => {
      if (v.vin === '00000000000000000') return;
      if (!results.vinMap[v.vin]) results.vinMap[v.vin] = [];
      results.vinMap[v.vin].push({ file: f.name, type: f.type });
    });
  });

  const rfhSec16Map = {};
  files.filter(f => f.type === 'RFHUB' && f.sec16).forEach(f => {
    const v = f.sec16.value;
    if (!rfhSec16Map[v]) rfhSec16Map[v] = [];
    rfhSec16Map[v].push(f);
  });

  const bcmFragMap = {};
  files.filter(f => f.type === 'BCM' && f.bcmFrag).forEach(f => {
    const v = f.bcmFrag.value;
    if (!bcmFragMap[v]) bcmFragMap[v] = [];
    bcmFragMap[v].push(f);
  });

  const gpecSec6Map = {};
  files.filter(f => f.type === 'GPEC2A' && f.sec6).forEach(f => {
    const v = f.sec6.value;
    if (!gpecSec6Map[v]) gpecSec6Map[v] = [];
    gpecSec6Map[v].push(f);
  });

  for (const [fragHex, bcmFiles] of Object.entries(bcmFragMap)) {
    let matched = false;
    for (const [sec16Hex, rfhFiles] of Object.entries(rfhSec16Map)) {
      const sec16Bytes = [];
      for (let i = 0; i < sec16Hex.length; i += 2) sec16Bytes.push(parseInt(sec16Hex.substr(i, 2), 16));
      const reversed = sec16Bytes.reverse();
      const revHex = reversed.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      const fragCore = fragHex.substring(0, 14);
      const revCore = revHex.substring(0, 14);
      if (fragCore === revCore) {
        const expectedSec6Prefix = sec16Hex.substring(0, 12);
        const matchedGpec = [];
        for (const [s6Hex, gpecFiles] of Object.entries(gpecSec6Map)) {
          if (s6Hex.substring(0, 12) === expectedSec6Prefix) matchedGpec.push(...gpecFiles);
        }
        results.pairings.push({
          status: 'paired', sec16: sec16Hex, bcmFrag: fragHex, reversed: revHex,
          rfhFiles: rfhFiles.map(f => f.name),
          bcmFiles: bcmFiles.map(f => f.name),
          gpecFiles: matchedGpec.map(f => f.name),
          rfhVins: [...new Set(rfhFiles.flatMap(f => f.vins.map(v => v.vin)).filter(v => v !== '00000000000000000'))],
          bcmVins: [...new Set(bcmFiles.flatMap(f => f.vins.map(v => v.vin)))],
        });
        matched = true;
        break;
      }
    }
    if (!matched) {
      const allFF = fragHex.replace(/F/g, '') === '04' || fragHex === 'FFFFFFFFFFFFFF04';
      results.pairings.push({
        status: allFF ? 'blank' : 'orphan',
        bcmFrag: fragHex,
        bcmFiles: bcmFiles.map(f => f.name),
        bcmVins: [...new Set(bcmFiles.flatMap(f => f.vins.map(v => v.vin)))],
        rfhFiles: [], gpecFiles: [],
        issue: allFF ? 'Gen1 family — no SEC16 in flash' : 'No matching RFHUB found',
      });
    }
  }

  const matchedSec16s = new Set(results.pairings.filter(p => p.status === 'paired').map(p => p.sec16));
  for (const [sec16Hex, rfhFiles] of Object.entries(rfhSec16Map)) {
    if (!matchedSec16s.has(sec16Hex)) {
      results.pairings.push({
        status: 'unmatched_rfh', sec16: sec16Hex,
        rfhFiles: rfhFiles.map(f => f.name),
        rfhVins: [...new Set(rfhFiles.flatMap(f => f.vins.map(v => v.vin)).filter(v => v !== '00000000000000000'))],
        bcmFiles: [], gpecFiles: [],
        issue: 'No BCM with matching fragment loaded',
      });
    }
  }
  return results;
}

/* ══════════════════════════════════════════════════════════════════════
 *  VIN DECODER
 * ══════════════════════════════════════════════════════════════════════ */
const VIN_TR = {A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};
for (let d = 0; d <= 9; d++) VIN_TR[String(d)] = d;
const VIN_WT = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const VIN_YR = {A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025,T:2026};
const VIN_PLANT = {H:'Brampton, ON',G:'Belvidere, IL',D:'Detroit, MI',N:'Sterling Heights, MI'};

function decodeVIN(vin) {
  if (!vin || vin.length !== 17) return null;
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return { valid: false, error: 'Invalid characters' };
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (VIN_TR[vin[i]] || 0) * VIN_WT[i];
  const expected = '0123456789X'[sum % 11];
  const valid = vin[8] === expected;

  // FCA-specific decode for 2C3CDX-prefix (Charger SRT)
  let trim = '';
  let hp = '';
  if (vin.startsWith('2C3CDX')) {
    const engine = vin[6];
    const trimByte = vin[7];
    const year = VIN_YR[vin[9]] || 0;
    if (engine === 'L') {
      // 6.2L Supercharged HEMI
      if (trimByte === '9' && year >= 2022) {
        trim = 'SRT Hellcat Redeye Widebody Jailbreak';
        hp = '807 HP / 707 lb-ft';
      } else if (trimByte === '5' && year >= 2018) {
        trim = 'SRT Hellcat Redeye / Widebody';
        hp = year >= 2021 ? '797 HP / 707 lb-ft' : '797 HP / 707 lb-ft';
      } else if (trimByte === '7' || trimByte === '8') {
        trim = 'SRT Hellcat Redeye Widebody';
        hp = '797 HP';
      } else if (trimByte === '6') {
        trim = 'SRT Hellcat Widebody';
        hp = '717 HP';
      } else if (trimByte === '0') {
        trim = year >= 2021 ? 'SRT Hellcat' : 'SRT Hellcat';
        hp = year >= 2021 ? '717 HP' : '707 HP';
      }
    } else if (engine === 'T') {
      trim = 'SRT 392 / Scat Pack';
      hp = '485 HP / 475 lb-ft';
    } else if (engine === 'G') {
      trim = 'R/T 5.7L HEMI';
      hp = '370 HP';
    } else if (engine === 'H') {
      trim = 'Scat Pack 6.4L';
      hp = '485 HP';
    }
  }

  return {
    valid, expectedCheckDigit: expected,
    wmi: vin.slice(0, 3), body: vin[3],
    line: vin[4], series: vin[5],
    engine: vin[6], trimCode: vin[7],
    checkDigit: vin[8],
    year: VIN_YR[vin[9]] || 0, plant: VIN_PLANT[vin[10]] || vin[10],
    serial: vin.slice(11), trim, hp,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 *  UI
 * ══════════════════════════════════════════════════════════════════════ */
const P = {
  bg: '#060609', card: '#0E0E14', card2: '#151520', card3: '#1C1C28',
  red: '#EF4444', redDim: '#7F1D1D', orange: '#F97316', blue: '#3B82F6',
  cyan: '#06B6D4', green: '#22C55E', purple: '#A855F7', yellow: '#EAB308',
  text: '#E2E0DD', sub: '#6B6B78', muted: '#3A3A48', border: '#222233',
  greenBg: 'rgba(34,197,94,0.08)', redBg: 'rgba(239,68,68,0.08)',
  orangeBg: 'rgba(249,115,22,0.08)', blueBg: 'rgba(59,130,246,0.08)',
};

const TC = { BCM: P.orange, RFHUB: P.blue, GPEC2A: P.cyan, FW: '#6B7280', CFLASH: P.purple };
const TL = { BCM: 'BCM D-FLASH', RFHUB: 'RFHUB EEE', GPEC2A: 'GPEC2A', FW: 'Firmware', CFLASH: 'C-FLASH' };

function Tag({ children, color = P.red, size = 'sm' }) {
  const s = size === 'lg' ? { fontSize: 11, padding: '3px 10px' } : { fontSize: 9, padding: '2px 7px' };
  return <span style={{ ...s, fontWeight: 800, borderRadius: 5, background: color + '1A', color, letterSpacing: 0.3, display: 'inline-block', lineHeight: 1.4 }}>{children}</span>;
}

function StatusDot({ status }) {
  const colors = { paired: P.green, orphan: P.red, blank: P.yellow, unmatched_rfh: P.orange };
  const c = colors[status] || P.muted;
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 6px ${c}`, flexShrink: 0 }} />;
}

function Section({ title, count, color, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 2, color: '#fff' }}>{title}</div>
        {count !== undefined && <Tag color={color} size="lg">{count}</Tag>}
        <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${color}40, transparent)` }} />
      </div>
      {children}
    </div>
  );
}

/* ═══ ROOT APP ═══ */
export default function App() {
  const [files, setFiles] = useState([]);
  const [efdFile, setEfdFile] = useState(null);
  const [tab, setTab] = useState('match');
  const [seedHex, setSeedHex] = useState('');
  const [seedAlgo, setSeedAlgo] = useState('all');
  const [vinInput, setVinInput] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const loadFiles = useCallback((fileList) => {
    Promise.all(
      Array.from(fileList).map(f => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => {
          const buf = e.target.result;
          // Detect EFD/.webm
          const view = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
          if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
            // EFD container
            resolve({ kind: 'efd', data: parseEFD(buf, f.name), raw: buf });
          } else {
            resolve({ kind: 'bin', data: analyzeFile(buf, f.name) });
          }
        };
        reader.readAsArrayBuffer(f);
      }))
    ).then(results => {
      results.forEach(r => {
        if (r.kind === 'efd') setEfdFile(r);
        else if (r.kind === 'bin' && r.data.type !== 'unknown') setFiles(prev => [...prev, r.data]);
      });
    });
  }, []);

  const matchResult = useMemo(() => files.length > 0 ? crossMatch(files) : null, [files]);

  const counts = useMemo(() => {
    const c = { BCM: 0, RFHUB: 0, GPEC2A: 0, FW: 0, CFLASH: 0, total: files.length };
    files.forEach(f => { if (c[f.type] !== undefined) c[f.type]++; });
    return c;
  }, [files]);

  const clearAll = () => { setFiles([]); setEfdFile(null); };

  const openFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.bin,.BIN,.webm,.WEBM,.efd,.EFD';
    input.onchange = e => loadFiles(e.target.files);
    input.click();
  };

  if (files.length === 0 && !efdFile) {
    return (
      <div style={{ minHeight: '100vh', background: P.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}*{box-sizing:border-box}`}</style>
        <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse 70% 40% at 50% 30%, rgba(239,68,68,0.07), transparent)' }} />
        <div style={{ position: 'relative', zIndex: 2, textAlign: 'center', maxWidth: 640, padding: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 36 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg, #EF4444, #991B1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 900, color: '#fff', boxShadow: '0 8px 32px rgba(239,68,68,0.3)' }}>S</div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 4, color: '#fff' }}>SRT LAB</div>
              <div style={{ fontSize: 9, letterSpacing: 5, color: P.sub, fontWeight: 700 }}>v3 · ECM TOOLKIT</div>
            </div>
          </div>
          <div onClick={openFilePicker}
            onDrop={e => { e.preventDefault(); setDragOver(false); loadFiles(e.dataTransfer.files); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            style={{ padding: '56px 40px', borderRadius: 20, border: `2px dashed ${dragOver ? P.red : P.border}`, background: dragOver ? P.redBg : P.card, cursor: 'pointer', transition: 'all 0.25s', boxShadow: dragOver ? `0 0 40px ${P.red}15` : 'none' }}>
            <div style={{ fontSize: 56, marginBottom: 16, animation: 'float 3s ease-in-out infinite' }}>🔧</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginBottom: 8 }}>Drop module dumps or cal files</div>
            <div style={{ fontSize: 12, color: P.sub, lineHeight: 1.6 }}>
              BCM · RFHUB · GPEC2A · C-Flash · EFD/.webm cal files
            </div>
            <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {[['BCM', P.orange], ['RFHUB', P.blue], ['GPEC2A', P.cyan], ['C-FLASH', P.purple], ['EFD', P.yellow]].map(([l, c]) => (
                <Tag key={l} color={c} size="lg">{l}</Tag>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: P.bg, color: P.text, fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:${P.border} transparent}`}</style>

      <div style={{ background: P.card, borderBottom: `1px solid ${P.border}`, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #EF4444, #991B1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900, color: '#fff' }}>S</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#fff' }}>SRT LAB</div>
          <div style={{ fontSize: 7, color: P.sub, letterSpacing: 3, fontWeight: 700 }}>v3 · ECM TOOLKIT</div>
        </div>
        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', gap: 10, marginRight: 12 }}>
          {[['BCM', counts.BCM, P.orange], ['RFH', counts.RFHUB, P.blue], ['GPEC', counts.GPEC2A, P.cyan], ['CFL', counts.CFLASH, P.purple]].map(([l, v, c]) => (
            <div key={l} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: v > 0 ? c : P.muted }}>{v}</div>
              <div style={{ fontSize: 7, color: P.sub, letterSpacing: 1 }}>{l}</div>
            </div>
          ))}
          {efdFile && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: P.yellow }}>1</div>
              <div style={{ fontSize: 7, color: P.sub, letterSpacing: 1 }}>EFD</div>
            </div>
          )}
        </div>

        <button onClick={openFilePicker} style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${P.border}`, background: P.card2, color: P.text, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+ ADD</button>
        <button onClick={clearAll} style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${P.redDim}`, background: 'transparent', color: P.red, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>CLEAR</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '8px 20px 0', background: P.card, borderBottom: `1px solid ${P.border}`, overflowX: 'auto' }}>
        {[
          { id: 'match', label: '🔗 PAIRING', sub: 'Cross-module' },
          { id: 'files', label: '📂 FILES', sub: `${files.length} bins` },
          { id: 'efd', label: '📦 EFD INSPECTOR', sub: efdFile ? '1 loaded' : 'cal file' },
          { id: 'cflash', label: '💾 C-FLASH', sub: counts.CFLASH > 0 ? `${counts.CFLASH} loaded` : 'compare/verify' },
          { id: 'session', label: '🔐 CDA6 SESSION', sub: 'UDS helper' },
          { id: 'vin', label: '🪪 VIN DECODE', sub: 'cross-ref' },
          { id: 'seed', label: '🔑 SEED→KEY', sub: '11 algos' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 14px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: tab === t.id ? P.bg : 'transparent',
            borderRadius: '8px 8px 0 0',
            color: tab === t.id ? '#fff' : P.sub,
            fontWeight: tab === t.id ? 800 : 600, fontSize: 10,
            transition: 'all 0.15s', whiteSpace: 'nowrap',
          }}>
            {t.label}
            <div style={{ fontSize: 7, color: P.muted, marginTop: 2 }}>{t.sub}</div>
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 20px 60px' }}>
        {tab === 'match' && <MatchTab files={files} result={matchResult} />}
        {tab === 'files' && <FilesTab files={files} />}
        {tab === 'efd' && <EFDTab efdFile={efdFile} files={files} />}
        {tab === 'cflash' && <CFlashTab files={files.filter(f => f.type === 'CFLASH' || f.type === 'FW')} />}
        {tab === 'session' && <SessionTab seedHex={seedHex} setSeedHex={setSeedHex} />}
        {tab === 'vin' && <VINTab vinInput={vinInput} setVinInput={setVinInput} files={files} efdFile={efdFile} />}
        {tab === 'seed' && <SeedTab seedHex={seedHex} setSeedHex={setSeedHex} seedAlgo={seedAlgo} setSeedAlgo={setSeedAlgo} />}
      </div>
    </div>
  );
}

/* ═══ MATCH TAB (existing) ═══ */
function MatchTab({ files, result }) {
  if (!result) return <div style={{ padding: 20, color: P.sub }}>Load BCM/RFHUB/GPEC2A bins to see pairing analysis</div>;
  const vins = Object.entries(result.vinMap).sort((a, b) => b[1].length - a[1].length);
  return (
    <div>
      <Section title="VIN CROSS-REFERENCE" count={vins.length} color={P.orange}>
        {vins.length === 0 && <div style={{ fontSize: 11, color: P.sub, padding: 12 }}>No VINs detected</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 6 }}>
          {vins.map(([vin, refs]) => {
            const types = {};
            refs.forEach(r => { types[r.type] = (types[r.type] || 0) + 1; });
            return (
              <div key={vin} style={{ padding: '10px 12px', borderRadius: 8, background: P.card2, border: `1px solid ${refs.length > 1 ? P.green + '30' : P.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: P.orange, letterSpacing: 2 }}>{vin}</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {Object.entries(types).map(([t, c]) => <Tag key={t} color={TC[t]}>{t}×{c}</Tag>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="SEC16 PAIRING CHAINS" count={result.pairings.length} color={P.purple}>
        <div style={{ padding: '8px 10px', borderRadius: 8, background: P.card2, border: `1px solid ${P.border}`, marginBottom: 12, fontSize: 10, lineHeight: 1.7, color: P.sub }}>
          <span style={{ color: P.blue }}>RFH SEC16</span> ← <span style={{ color: P.orange }}>reverse()</span> → <span style={{ color: P.orange }}>BCM @0x81A9</span>{'  ·  '}
          <span style={{ color: P.blue }}>RFH[0:6]</span> → <span style={{ color: P.cyan }}>GPEC SEC6 @0x203</span>
        </div>
        {result.pairings.map((p, i) => <PairingCard key={i} p={p} />)}
      </Section>
    </div>
  );
}

function PairingCard({ p }) {
  const statusColors = { paired: P.green, orphan: P.red, blank: P.yellow, unmatched_rfh: P.orange };
  const statusLabels = { paired: 'PAIRED', orphan: 'ORPHAN', blank: 'BLANK', unmatched_rfh: 'NO BCM' };
  const c = statusColors[p.status] || P.muted;
  return (
    <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1.5px solid ${c}25`, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <StatusDot status={p.status} />
        <Tag color={c} size="lg">{statusLabels[p.status]}</Tag>
      </div>
      {p.sec16 && (
        <div style={{ padding: '8px 10px', borderRadius: 6, background: P.card2, border: `1px solid ${P.purple}20`, marginBottom: 8 }}>
          <div style={{ fontSize: 8, fontWeight: 800, color: P.purple, letterSpacing: 2, marginBottom: 3 }}>SEC16</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.purple, wordBreak: 'break-all' }}>{p.sec16}</div>
        </div>
      )}
      {p.bcmFrag && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: P.orangeBg, marginBottom: 8 }}>
          <span style={{ fontSize: 8, fontWeight: 800, color: P.orange, letterSpacing: 1 }}>BCM FRAG: </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: P.orange }}>{p.bcmFrag}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: p.gpecFiles?.length > 0 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
        <FileList label="RFHUB" color={P.blue} files={p.rfhFiles || []} vins={p.rfhVins || []} />
        <FileList label="BCM" color={P.orange} files={p.bcmFiles || []} vins={p.bcmVins || []} />
        {p.gpecFiles?.length > 0 && <FileList label="GPEC2A" color={P.cyan} files={p.gpecFiles} vins={[]} />}
      </div>
      {p.issue && (
        <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: c + '0A', fontSize: 10, color: c }}>
          {p.status === 'orphan' ? '⚠ ' : '○ '}{p.issue}
        </div>
      )}
    </div>
  );
}

function FileList({ label, color, files, vins }) {
  return (
    <div>
      <div style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: 2, marginBottom: 4 }}>{label} ({files.length})</div>
      {files.length > 0 ? files.map((f, i) => (
        <div key={i} style={{ padding: '4px 6px', borderRadius: 4, background: P.card2, marginBottom: 2, fontSize: 8, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</div>
      )) : <div style={{ fontSize: 9, color: P.muted, padding: 4 }}>—</div>}
      {vins?.map((v, i) => <div key={i} style={{ fontSize: 8, color: P.orange, marginTop: 2 }}>{v}</div>)}
    </div>
  );
}

/* ═══ FILES TAB ═══ */
function FilesTab({ files }) {
  const [sel, setSel] = useState(null);
  if (files.length === 0) return <div style={{ padding: 20, color: P.sub }}>No bin files loaded</div>;
  const f = sel !== null ? files[sel] : null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: f ? '280px 1fr' : '1fr', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '78vh', overflowY: 'auto' }}>
        {files.map((file, i) => (
          <div key={i} onClick={() => setSel(i)} style={{
            padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
            background: sel === i ? P.card2 : P.card,
            border: `1.5px solid ${sel === i ? (TC[file.type] || P.red) : P.border}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: P.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{file.name}</div>
              <Tag color={TC[file.type] || P.muted}>{file.type}</Tag>
            </div>
            {file.vins[0] && <div style={{ fontSize: 9, color: P.orange, fontWeight: 700, marginTop: 2 }}>{file.vins[0].vin}</div>}
          </div>
        ))}
      </div>
      {f && <FileDetail f={f} />}
    </div>
  );
}

function FileDetail({ f }) {
  return (
    <div style={{ padding: 16, borderRadius: 12, background: P.card, border: `1px solid ${P.border}`, maxHeight: '80vh', overflowY: 'auto' }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: TC[f.type] || P.text, marginBottom: 10, wordBreak: 'break-all' }}>{f.name}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
        <Tag color={TC[f.type]} size="lg">{TL[f.type] || f.type}</Tag>
        <Tag color={P.sub} size="lg">{(f.size / 1024).toFixed(0)} KB</Tag>
        {f.sec16 && <Tag color={P.blue} size="lg">{f.sec16.gen.toUpperCase()}</Tag>}
        {f.security?.isPPC && <Tag color={P.purple} size="lg">PowerPC</Tag>}
        {f.security?.aesSbox !== undefined && <Tag color={P.purple} size="lg">AES @0x{f.security.aesSbox.toString(16).toUpperCase()}</Tag>}
      </div>
      {f.vins.length > 0 && (
        <DetailBlock label="VIN" color={P.orange}>
          {f.vins.map((v, i) => (
            <div key={i}>
              <span style={{ fontSize: 14, fontWeight: 800, color: P.orange, letterSpacing: 2 }}>{v.vin}</span>
              <span style={{ fontSize: 8, color: P.sub, marginLeft: 8 }}>@0x{v.offset.toString(16).toUpperCase()}</span>
            </div>
          ))}
        </DetailBlock>
      )}
      {f.partNumbers.length > 0 && (
        <DetailBlock label="PART NUMBERS" color={P.yellow}>
          {f.partNumbers.slice(0, 10).map((pn, i) => (
            <div key={i} style={{ fontSize: 11, fontWeight: 700, color: P.yellow }}>
              {pn.pn} <span style={{ color: P.sub, fontSize: 8 }}>@0x{pn.offset.toString(16).toUpperCase()}</span>
            </div>
          ))}
        </DetailBlock>
      )}
      {f.buildDate && (
        <DetailBlock label="BUILD DATE" color={P.cyan}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.cyan }}>{f.buildDate.date}</div>
        </DetailBlock>
      )}
      {f.sec16 && (
        <DetailBlock label={`SEC16`} color={P.purple}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.purple, wordBreak: 'break-all' }}>{f.sec16.value}</div>
        </DetailBlock>
      )}
      {f.bcmFrag && (
        <DetailBlock label="BCM SEC16 FRAGMENT" color={P.orange}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.orange }}>{f.bcmFrag.value}</div>
        </DetailBlock>
      )}
      {f.security?.bootloaderSig && (
        <DetailBlock label="BOOTLOADER SIG (first 8 bytes)" color={P.green}>
          <div style={{ fontSize: 11, fontWeight: 700, color: P.green, fontFamily: 'monospace' }}>{f.security.bootloaderSig}</div>
        </DetailBlock>
      )}
      {f.security?.tunerSigs?.length > 0 && (
        <DetailBlock label="⚠ TUNER SIGNATURES DETECTED" color={P.red}>
          {f.security.tunerSigs.map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: P.red }}>{t.label} @0x{t.offset.toString(16).toUpperCase()}</div>
          ))}
        </DetailBlock>
      )}
    </div>
  );
}

function DetailBlock({ label, color, children }) {
  return (
    <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: P.card2, border: `1px solid ${color}20` }}>
      <div style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: 2, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/* ═══ EFD INSPECTOR TAB ═══ */
function EFDTab({ efdFile, files }) {
  if (!efdFile) {
    return (
      <div style={{ padding: 30, textAlign: 'center', background: P.card, borderRadius: 12, border: `1px solid ${P.border}` }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📦</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: P.text, marginBottom: 8 }}>No EFD/.webm file loaded</div>
        <div style={{ fontSize: 11, color: P.sub, lineHeight: 1.6 }}>
          Drop a Mopar PowerCal .webm or EFD calibration file to inspect metadata,<br/>
          verify VIN/cal compatibility, and prep for flashing via wiTECH/AlfaOBD
        </div>
      </div>
    );
  }
  const efd = efdFile.data;
  const meta = efd.metadata;
  const vinFromBin = files.find(f => f.vins[0])?.vins[0]?.vin;

  // Cross-check: if we have a BCM/PCM with VIN loaded, decode that
  const decoded = vinFromBin ? decodeVIN(vinFromBin) : null;

  return (
    <div>
      <div style={{ padding: 16, borderRadius: 12, background: P.card, border: `1.5px solid ${efd.valid ? P.green : P.red}30`, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Tag color={efd.valid ? P.green : P.red} size="lg">{efd.valid ? '✓ VALID EFD' : '✗ INVALID'}</Tag>
          <Tag color={P.yellow} size="lg">{efd.efdType === 'mopar_powercal' ? 'MOPAR POWERCAL' : 'UNKNOWN EFD'}</Tag>
          <span style={{ fontSize: 11, color: P.text, fontWeight: 700 }}>{efd.name}</span>
          <span style={{ fontSize: 9, color: P.sub }}>{(efd.size / 1024 / 1024).toFixed(2)} MB</span>
        </div>
        {efd.error && <div style={{ fontSize: 11, color: P.red }}>{efd.error}</div>}
      </div>

      {/* Metadata */}
      <Section title="CAL METADATA" color={P.cyan}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {Object.entries(meta).filter(([k]) => !k.startsWith('_')).map(([k, v]) => (
            <div key={k} style={{ padding: '8px 10px', borderRadius: 6, background: P.card2, border: `1px solid ${P.border}` }}>
              <div style={{ fontSize: 8, fontWeight: 800, color: P.sub, letterSpacing: 2 }}>{k.toUpperCase()}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: P.text, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Compatibility check */}
      {decoded && (
        <Section title="VIN ↔ CAL COMPATIBILITY" color={P.green}>
          <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1px solid ${P.border}` }}>
            <div style={{ fontSize: 10, color: P.sub, marginBottom: 8 }}>
              Loaded BCM/PCM VIN: <span style={{ color: P.orange, fontWeight: 800 }}>{vinFromBin}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <CompatCheck label="Year" expected={meta.ModelYear} actual={decoded.year ? String(decoded.year) : '?'} />
              <CompatCheck label="Body" expected={meta.Body} actual="LD" hint={decoded.wmi === '2C3' ? 'Charger LD' : 'Other'} />
              <CompatCheck label="Engine" expected={meta.Engine} actual={decoded.engine === 'L' ? '6.2L' : decoded.engine} />
              <CompatCheck label="Trim" expected="Hellcat-class" actual={decoded.trim || '?'} />
            </div>
            {decoded.hp && (
              <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: P.greenBg, border: `1px solid ${P.green}30` }}>
                <span style={{ fontSize: 8, color: P.green, fontWeight: 800, letterSpacing: 2 }}>VIN-DERIVED HP RATING: </span>
                <span style={{ fontSize: 14, fontWeight: 800, color: P.green }}>{decoded.hp}</span>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* EBML Sections */}
      <Section title="EBML CONTAINER STRUCTURE" count={efd.sections.length} color={P.purple}>
        <div style={{ background: P.card2, borderRadius: 8, padding: 10, border: `1px solid ${P.border}`, fontFamily: 'monospace', fontSize: 10 }}>
          {efd.sections.slice(0, 12).map((s, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: i < 11 ? `1px dashed ${P.border}` : 'none', color: P.text }}>
              <span style={{ color: P.sub }}>@0x{s.offset.toString(16).toUpperCase().padStart(6, '0')}</span>
              {' '}<span style={{ color: P.purple }}>ID=0x{s.id}</span>
              {' '}<span style={{ color: P.cyan }}>size={s.size}</span>
              {' '}<span style={{ color: P.muted }}>data@0x{s.dataStart.toString(16).toUpperCase()}</span>
              {s.id === '204453' && <Tag color={P.green}>DS · plaintext</Tag>}
              {s.id === '204653' && <Tag color={P.yellow}>FS · encrypted</Tag>}
              {s.id === '20434F' && <Tag color={P.cyan}>CO · checksum</Tag>}
              {s.id === '205550' && <Tag color={P.red}>UP · payload</Tag>}
            </div>
          ))}
        </div>
      </Section>

      {/* Payload info */}
      {efd.payload && (
        <Section title="ENCRYPTED PAYLOAD" color={P.red}>
          <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1px solid ${P.red}25` }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Stat label="OFFSET" value={`0x${efd.payload.offset.toString(16).toUpperCase()}`} color={P.cyan} />
              <Stat label="SIZE" value={`${(efd.payload.size / 1024 / 1024).toFixed(2)} MB`} color={P.orange} />
              <Stat label="ENTROPY" value={efd.payload.entropy.toFixed(3)} color={efd.payload.entropy > 7.9 ? P.red : P.yellow} />
            </div>
            <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: P.redBg, fontSize: 10, color: P.text, lineHeight: 1.6 }}>
              <strong style={{ color: P.red }}>Note:</strong> Entropy {efd.payload.entropy.toFixed(2)} indicates AES-grade encryption.
              The payload is decrypted by the ECM bootloader during a UDS programming session — flash this file via{' '}
              <strong>wiTECH 2.0</strong>, <strong>AlfaOBD</strong> with J2534 (CarDAQ-Plus / MongoosePro), or <strong>Mopar Direct Connection Tuner</strong>.
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

function CompatCheck({ label, expected, actual, hint }) {
  const match = expected && actual && (
    expected === actual ||
    (typeof expected === 'string' && expected.includes(actual)) ||
    (typeof actual === 'string' && actual.includes(expected))
  );
  return (
    <div style={{ padding: '8px 10px', borderRadius: 6, background: P.card2, border: `1px solid ${match ? P.green + '30' : P.muted}` }}>
      <div style={{ fontSize: 8, fontWeight: 800, color: P.sub, letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 10, color: P.text, marginTop: 2 }}>EFD: <span style={{ color: P.cyan }}>{expected || '?'}</span></div>
      <div style={{ fontSize: 10, color: P.text }}>VIN: <span style={{ color: P.orange }}>{actual || '?'}</span></div>
      {match && <Tag color={P.green}>✓ MATCH</Tag>}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ padding: 10, borderRadius: 6, background: P.card2, border: `1px solid ${P.border}` }}>
      <div style={{ fontSize: 8, fontWeight: 800, color: P.sub, letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

/* ═══ C-FLASH TAB ═══ */
function CFlashTab({ files }) {
  const [aIdx, setAIdx] = useState(null);
  const [bIdx, setBIdx] = useState(null);
  const [diffResult, setDiffResult] = useState(null);

  const compare = useCallback(() => {
    if (aIdx === null || bIdx === null) return;
    const a = files[aIdx];
    const b = files[bIdx];
    const len = Math.min(a.size, b.size);
    let diffs = 0;
    let firstDiff = -1;
    let lastDiff = -1;
    const diffBlocks = [];
    let inDiff = false;
    let diffStart = 0;
    for (let i = 0; i < len; i++) {
      if (a.data[i] !== b.data[i]) {
        diffs++;
        if (firstDiff < 0) firstDiff = i;
        lastDiff = i;
        if (!inDiff) { inDiff = true; diffStart = i; }
      } else if (inDiff) {
        diffBlocks.push({ start: diffStart, end: i });
        inDiff = false;
      }
    }
    if (inDiff) diffBlocks.push({ start: diffStart, end: len });
    setDiffResult({ totalDiffs: diffs, firstDiff, lastDiff, blocks: diffBlocks, sizeA: a.size, sizeB: b.size, len });
  }, [aIdx, bIdx, files]);

  if (files.length === 0) return (
    <div style={{ padding: 30, textAlign: 'center', background: P.card, borderRadius: 12, border: `1px solid ${P.border}` }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>💾</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: P.text }}>No C-Flash dumps loaded</div>
      <div style={{ fontSize: 11, color: P.sub, marginTop: 8 }}>Drop ECM C-flash bin files (1MB / 4MB) to inspect or compare</div>
    </div>
  );

  return (
    <div>
      <Section title="C-FLASH FILES" count={files.length} color={P.purple}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
          {files.map((f, i) => (
            <div key={i} style={{ padding: 12, borderRadius: 10, background: P.card, border: `1px solid ${P.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: TC[f.type], marginBottom: 6, wordBreak: 'break-all' }}>{f.name}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                <Tag color={TC[f.type]}>{(f.size / 1024 / 1024).toFixed(1)} MB</Tag>
                {f.security?.isPPC && <Tag color={P.purple}>PPC</Tag>}
                {f.security?.aesSbox !== undefined && <Tag color={P.yellow}>AES</Tag>}
                {f.security?.unlocked && <Tag color={P.green}>UNLOCKED</Tag>}
                {f.security?.tunerSigs?.length > 0 && <Tag color={P.red}>TUNED</Tag>}
              </div>
              {f.security?.calId && (
                <div style={{ fontSize: 9, color: P.yellow, fontWeight: 700 }}>Cal ID: {f.security.calId}</div>
              )}
              {f.buildDate && <div style={{ fontSize: 9, color: P.cyan }}>Built: {f.buildDate.date}</div>}
              <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                <button onClick={() => setAIdx(i)} style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: `1px solid ${aIdx === i ? P.green : P.border}`, background: aIdx === i ? P.greenBg : P.card2, color: aIdx === i ? P.green : P.sub, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>SET A</button>
                <button onClick={() => setBIdx(i)} style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: `1px solid ${bIdx === i ? P.orange : P.border}`, background: bIdx === i ? P.orangeBg : P.card2, color: bIdx === i ? P.orange : P.sub, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>SET B</button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {aIdx !== null && bIdx !== null && (
        <Section title="COMPARE A vs B" color={P.yellow}>
          <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1px solid ${P.border}` }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <Tag color={P.green}>A</Tag>
                <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4 }}>{files[aIdx].name}</div>
                <div style={{ fontSize: 9, color: P.sub }}>Cal ID: {files[aIdx].security?.calId || '—'}</div>
              </div>
              <div>
                <Tag color={P.orange}>B</Tag>
                <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4 }}>{files[bIdx].name}</div>
                <div style={{ fontSize: 9, color: P.sub }}>Cal ID: {files[bIdx].security?.calId || '—'}</div>
              </div>
            </div>
            <button onClick={compare} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: P.purple, color: '#fff', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>
              RUN BYTE-LEVEL DIFF
            </button>
            {diffResult && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  <Stat label="TOTAL DIFFS" value={diffResult.totalDiffs.toLocaleString()} color={diffResult.totalDiffs === 0 ? P.green : P.red} />
                  <Stat label="DIFF BLOCKS" value={diffResult.blocks.length} color={P.orange} />
                  <Stat label="FIRST DIFF" value={diffResult.firstDiff >= 0 ? `0x${diffResult.firstDiff.toString(16).toUpperCase()}` : '—'} color={P.cyan} />
                  <Stat label="LAST DIFF" value={diffResult.lastDiff >= 0 ? `0x${diffResult.lastDiff.toString(16).toUpperCase()}` : '—'} color={P.cyan} />
                </div>
                {diffResult.totalDiffs === 0 && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: P.greenBg, fontSize: 10, color: P.green, fontWeight: 700 }}>
                    ✓ Files are byte-identical (perfect copy)
                  </div>
                )}
                {diffResult.blocks.length > 0 && diffResult.blocks.length <= 30 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: P.sub, letterSpacing: 2, marginBottom: 4 }}>DIFFERING REGIONS</div>
                    <div style={{ background: P.card2, borderRadius: 6, padding: 8, fontFamily: 'monospace', fontSize: 9 }}>
                      {diffResult.blocks.slice(0, 30).map((b, i) => (
                        <div key={i} style={{ color: P.text }}>
                          0x{b.start.toString(16).toUpperCase().padStart(6, '0')} - 0x{b.end.toString(16).toUpperCase().padStart(6, '0')} ({b.end - b.start} bytes)
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ═══ CDA6 SESSION TAB ═══ */
function SessionTab({ seedHex, setSeedHex }) {
  const seed = parseInt(seedHex.replace(/\s/g, ''), 16);
  const validSeed = !isNaN(seed) && seedHex.replace(/\s/g, '').length > 0;
  const key = validSeed ? cda6(seed) : null;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ padding: 16, borderRadius: 12, background: P.card, border: `1px solid ${P.border}`, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Tag color={P.cyan} size="lg">UDS SECURITY ACCESS</Tag>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>CDA6 Session Helper</span>
        </div>
        <div style={{ fontSize: 11, color: P.sub, lineHeight: 1.6 }}>
          Walk-through for the standard FCA ECM programming session.<br/>
          Use this to verify J2534 trace logs from wiTECH/AlfaOBD or to plan your flash sequence.
        </div>
      </div>

      <Section title="SESSION SEQUENCE" color={P.cyan}>
        <div style={{ background: P.card, borderRadius: 12, border: `1px solid ${P.border}`, padding: 16 }}>
          {[
            { step: 1, name: 'Diagnostic Session Control', service: '0x10', subfn: '0x02', desc: 'Programming session', tx: '10 02', expected: '50 02 ... ...' },
            { step: 2, name: 'Security Access Seed Request', service: '0x27', subfn: '0x01', desc: 'Request seed from ECM', tx: '27 01', expected: '67 01 [SEED 4B]' },
            { step: 3, name: 'Calculate Key (CDA6)', service: '—', subfn: '—', desc: 'Apply CDA6 to seed', tx: 'host calc', expected: '4-byte key', highlight: true },
            { step: 4, name: 'Send Key', service: '0x27', subfn: '0x02', desc: 'Send computed key', tx: '27 02 [KEY 4B]', expected: '67 02' },
            { step: 5, name: 'Request Download', service: '0x34', subfn: '—', desc: 'Setup block transfer', tx: '34 [fmt][addr][len]', expected: '74 [maxblk]' },
            { step: 6, name: 'Transfer Data', service: '0x36', subfn: '—', desc: 'Stream EFD payload blocks', tx: '36 [seq][block]', expected: '76 [seq]' },
            { step: 7, name: 'Request Transfer Exit', service: '0x37', subfn: '—', desc: 'End block transfer', tx: '37', expected: '77' },
            { step: 8, name: 'Routine Control (Checksum)', service: '0x31', subfn: '0x01', desc: 'Validate flashed image', tx: '31 01 [routine]', expected: '71 01 [status]' },
            { step: 9, name: 'ECU Reset', service: '0x11', subfn: '0x01', desc: 'Hard reset to apply', tx: '11 01', expected: '51 01' },
          ].map(s => (
            <div key={s.step} style={{
              padding: '10px 12px', marginBottom: 6, borderRadius: 8,
              background: s.highlight ? P.redBg : P.card2,
              border: `1px solid ${s.highlight ? P.red + '40' : P.border}`,
              display: 'grid', gridTemplateColumns: '32px 1fr 110px 110px', alignItems: 'center', gap: 10,
            }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: s.highlight ? P.red : P.cyan, textAlign: 'center' }}>{s.step}</div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>{s.name}</div>
                <div style={{ fontSize: 9, color: P.sub, marginTop: 2 }}>{s.desc}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: P.muted, letterSpacing: 1 }}>SVC / SUB</div>
                <div style={{ fontSize: 10, fontFamily: 'monospace', color: P.orange, fontWeight: 700 }}>{s.service} / {s.subfn}</div>
              </div>
              <div>
                <div style={{ fontSize: 7, color: P.muted, letterSpacing: 1 }}>TX → RX</div>
                <div style={{ fontSize: 9, fontFamily: 'monospace', color: P.green }}>{s.tx}</div>
                <div style={{ fontSize: 9, fontFamily: 'monospace', color: P.cyan }}>{s.expected}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="STEP 3 · CDA6 KEY CALCULATOR" color={P.red}>
        <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1px solid ${P.red}25` }}>
          <div style={{ fontSize: 10, color: P.sub, marginBottom: 8 }}>Paste seed from `67 01 [SEED]` ECM response:</div>
          <input
            value={seedHex}
            onChange={e => setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g, ''))}
            placeholder="A1 B2 C3 D4"
            style={{ width: '100%', padding: 12, borderRadius: 8, border: `2px solid ${P.border}`, background: P.card2, color: P.text, fontSize: 18, fontWeight: 700, letterSpacing: 4, textAlign: 'center', outline: 'none', fontFamily: 'inherit' }}
          />
          {validSeed && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: P.card2, border: `1px solid ${P.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 30px 1fr', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 8, color: P.sub, letterSpacing: 2 }}>SEED (from ECM)</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: P.blue, fontFamily: 'monospace' }}>
                    {seed.toString(16).toUpperCase().padStart(8, '0')}
                  </div>
                </div>
                <div style={{ textAlign: 'center', color: P.muted, fontSize: 16 }}>→</div>
                <div>
                  <div style={{ fontSize: 8, color: P.sub, letterSpacing: 2 }}>KEY (CDA6)</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: P.red, fontFamily: 'monospace' }}>
                    {key.toString(16).toUpperCase().padStart(8, '0')}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: P.greenBg, fontSize: 10, color: P.green, fontFamily: 'monospace' }}>
                Send: 27 02 {key.toString(16).toUpperCase().padStart(8, '0').match(/.{2}/g).join(' ')}
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="COMPATIBLE TOOLS" color={P.green}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {[
            { name: 'wiTECH 2.0 + MicroPod', desc: 'OEM Mopar tool. TechAuthority sub required. Best for Mopar .webm cals.', cost: '$$$' },
            { name: 'AlfaOBD + CarDAQ-Plus', desc: 'Independent shop favorite. CDA6 built in, handles GPEC2A flashing.', cost: '$$' },
            { name: 'AlfaOBD + MongoosePro JLR', desc: 'Cheaper J2534 option. Verify Hellcat/Redeye support.', cost: '$' },
            { name: 'HP Tuners VCM Suite', desc: 'Tuner-focused. Different file format but supports Hellcat cals.', cost: '$$' },
          ].map((t, i) => (
            <div key={i} style={{ padding: 12, borderRadius: 8, background: P.card2, border: `1px solid ${P.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#fff' }}>{t.name}</div>
                <Tag color={P.green}>{t.cost}</Tag>
              </div>
              <div style={{ fontSize: 9, color: P.sub, marginTop: 4, lineHeight: 1.5 }}>{t.desc}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ═══ VIN DECODE TAB ═══ */
function VINTab({ vinInput, setVinInput, files, efdFile }) {
  const decoded = useMemo(() => decodeVIN(vinInput.trim().toUpperCase()), [vinInput]);
  const allVins = useMemo(() => {
    const vins = new Set();
    files.forEach(f => f.vins.forEach(v => v.vin !== '00000000000000000' && vins.add(v.vin)));
    return [...vins];
  }, [files]);

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ padding: 16, borderRadius: 12, background: P.card, border: `1px solid ${P.border}`, marginBottom: 14 }}>
        <input
          value={vinInput}
          onChange={e => setVinInput(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
          placeholder="Enter 17-char VIN"
          style={{ width: '100%', padding: 12, borderRadius: 10, border: `2px solid ${P.border}`, background: P.card2, color: P.text, fontSize: 18, fontWeight: 700, letterSpacing: 3, textAlign: 'center', outline: 'none', fontFamily: 'inherit' }}
        />
        {allVins.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: P.sub, alignSelf: 'center' }}>Quick load:</span>
            {allVins.map(v => (
              <button key={v} onClick={() => setVinInput(v)} style={{ padding: '4px 8px', borderRadius: 4, border: `1px solid ${P.border}`, background: P.card2, color: P.orange, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{v}</button>
            ))}
          </div>
        )}
      </div>

      {decoded && decoded.valid !== undefined && (
        <Section title="VIN DECODE" color={decoded.valid ? P.green : P.red}>
          <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1.5px solid ${decoded.valid ? P.green + '30' : P.red + '30'}` }}>
            {decoded.error ? (
              <div style={{ color: P.red, fontSize: 11 }}>✗ {decoded.error}</div>
            ) : (
              <>
                <div style={{ marginBottom: 10 }}>
                  {decoded.valid
                    ? <Tag color={P.green} size="lg">✓ VALID VIN</Tag>
                    : <Tag color={P.red} size="lg">✗ Check digit mismatch (need {decoded.expectedCheckDigit})</Tag>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  <Stat label="WMI" value={decoded.wmi} color={P.cyan} />
                  <Stat label="YEAR" value={decoded.year || '?'} color={P.orange} />
                  <Stat label="ENGINE" value={decoded.engine} color={P.red} />
                  <Stat label="TRIM CODE" value={decoded.trimCode} color={P.yellow} />
                  <Stat label="PLANT" value={decoded.plant} color={P.purple} />
                  <Stat label="SERIAL" value={decoded.serial} color={P.sub} />
                </div>
                {decoded.trim && (
                  <div style={{ marginTop: 12, padding: 14, borderRadius: 8, background: P.greenBg, border: `1px solid ${P.green}30` }}>
                    <div style={{ fontSize: 9, color: P.sub, letterSpacing: 2, marginBottom: 4 }}>IDENTIFIED VEHICLE</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{decoded.year} Dodge Charger</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: P.green }}>{decoded.trim}</div>
                    {decoded.hp && (
                      <div style={{ marginTop: 6, fontSize: 13, fontWeight: 800, color: P.orange }}>
                        ⚡ {decoded.hp}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ═══ SEED→KEY TAB ═══ */
function SeedTab({ seedHex, setSeedHex, seedAlgo, setSeedAlgo }) {
  const res = useMemo(() => {
    const raw = seedHex.replace(/\s/g, '');
    const v = parseInt(raw, 16);
    if (isNaN(v) || !raw) return null;
    const sd = v.toString(16).toUpperCase().padStart(8, '0');
    if (seedAlgo === 'all') {
      return { multi: true, seed: sd, results: ALGOS.map(a => ({ n: a.n, h: a.h, k: a.fn(v).toString(16).toUpperCase().padStart(8, '0') })) };
    }
    const a = ALGOS.find(x => x.id === seedAlgo);
    return a ? { multi: false, seed: sd, n: a.n, key: a.fn(v).toString(16).toUpperCase().padStart(8, '0') } : null;
  }, [seedHex, seedAlgo]);

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={{ padding: 18, borderRadius: 14, background: P.card, border: `1.5px solid ${P.border}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 3, marginBottom: 14 }}>
          {ALGOS.map(a => (
            <div key={a.id} onClick={() => setSeedAlgo(a.id)} style={{
              padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
              background: seedAlgo === a.id ? P.red + '18' : P.card2,
              border: `1.5px solid ${seedAlgo === a.id ? P.red : P.border}`,
            }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: seedAlgo === a.id ? P.red : P.text }}>{a.n}</div>
              <div style={{ fontSize: 7, color: P.muted }}>{a.h}</div>
            </div>
          ))}
          <div onClick={() => setSeedAlgo('all')} style={{
            padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
            background: seedAlgo === 'all' ? P.purple + '18' : P.card2,
            border: `1.5px solid ${seedAlgo === 'all' ? P.purple : P.border}`,
          }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: seedAlgo === 'all' ? P.purple : P.text }}>ALL</div>
            <div style={{ fontSize: 7, color: P.muted }}>Shotgun</div>
          </div>
        </div>
        <input
          value={seedHex} placeholder="Enter seed hex"
          onChange={e => setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g, ''))}
          style={{ width: '100%', padding: 12, borderRadius: 10, border: `2px solid ${P.border}`, background: P.card2, color: P.text, fontSize: 20, fontWeight: 700, letterSpacing: 4, textAlign: 'center', outline: 'none', fontFamily: 'inherit' }}
        />
        {res && !res.multi && (
          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: P.card2, border: `1px solid ${P.border}` }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 30px 1fr', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 8, color: P.sub }}>SEED</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: P.blue }}>{res.seed}</div>
              </div>
              <div style={{ textAlign: 'center', color: P.muted }}>→</div>
              <div>
                <div style={{ fontSize: 8, color: P.sub }}>KEY</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: P.red }}>{res.key}</div>
              </div>
            </div>
          </div>
        )}
        {res?.multi && (
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            {res.results.map((r, i) => (
              <div key={i} style={{ padding: '8px 10px', borderRadius: 6, background: P.card2, border: `1px solid ${P.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 800 }}>{r.n}</div>
                  <div style={{ fontSize: 7, color: P.muted }}>{r.h}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: P.red }}>{r.k}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
