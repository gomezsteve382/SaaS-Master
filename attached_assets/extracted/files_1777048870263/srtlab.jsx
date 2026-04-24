import React, { useState, useCallback, useMemo, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
 *  SRT LAB — LIVE MODULE PAIRING ANALYZER
 *  Drop BCM + RFHUB + GPEC2A bins from any vehicle(s)
 *  Instant cross-module SEC16 chain verification
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── CRC engines (verified against SINCRO/ArmandoQS) ── */
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

/* ── Hex helpers ── */
const hx = (d) => Array.from(d).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const hxs = (d) => Array.from(d).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const isBlank = (d) => d.every(b => b === 0xFF);
const isZero = (d) => d.every(b => b === 0x00);

/* ── Seed-Key engines ── */
const u32 = n => n >>> 0;
function sxor(s, c) { let k = u32(s); for (let i = 0; i < 5; i++) k = k & 0x80000000 ? u32((k << 1) ^ u32(c)) : u32(k << 1); return k; }
function cda6(s) { let k = u32(s); k = u32(k ^ 0x4B129F); k = u32((k << 3) | (k >>> 29)); k = u32(k + 0x1234); k = u32(k ^ 0xABCD); return u32((k >>> 5) | (k << 27)); }
const NT = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];
const NS = [0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s) { let k = 0; for (let i = 0; i < 4; i++) { let b = (u32(s) >> (i * 8)) & 0xFF; k = u32(k ^ u32(((NT[b & 0xF] ^ NT[(b >> 4) & 0xF]) * NS[i % 8]) & 0xFFFFFFFF)); } return k; }
function cfGPEC(s) { const KB = [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x33]; function sk(b) { let x = KB[b+3]<<3; x ^= KB[b+2]; x <<= 2; x ^= KB[b+1]; x <<= 3; x ^= KB[b+0]; return x & 0xFFFF; } const K = [sk(0),sk(4),sk(8),sk(12)]; function sw(x) { return (((x&0xFF)<<8)|((x>>>8)&0xFF))&0xFFFF; } let v0 = sw((s>>>16)&0xFFFF), v1 = sw(s&0xFFFF), sum = 0; for (let i = 0; i < 16; i++) { sum = (sum + 0xFFFF9E37) & 0xFFFF; v0 = (v0 + ((((v1<<4)+K[0])^((v1>>>5)+K[1]))^(sum+v1))) & 0xFFFF; v1 = (v1 + ((((v0<<4)+K[2])^((v0>>>5)+K[3]))^(sum+v0))) & 0xFFFF; } return ((sw(v0) << 16) | sw(v1)) >>> 0; }

const ALGOS = [
  { id: 'cda6', n: 'CDA6', h: 'BCM / ABS / IPC', fn: s => cda6(s) },
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
 *  FILE ANALYSIS ENGINE
 *  Auto-detects module type and extracts all security data
 * ══════════════════════════════════════════════════════════════════════ */
function analyzeFile(buf, name) {
  const d = new Uint8Array(buf);
  const sz = d.length;
  const result = { name, size: sz, data: d, type: 'unknown', vins: [], sec16: null, bcmFrag: null, sec6: null, security: {} };

  // ── Type detection ──
  if (sz === 65536 || sz === 131072) {
    result.type = 'BCM';
  } else if (sz === 4096) {
    let asciiCount = 0;
    for (let i = 0; i < Math.min(17, sz); i++) {
      if (d[i] >= 0x30 && d[i] <= 0x5A) asciiCount++;
    }
    result.type = asciiCount >= 10 ? 'GPEC2A' : 'RFHUB';
  } else if (sz === 8192) {
    let asciiCount = 0;
    for (let i = 0; i < Math.min(17, sz); i++) {
      if (d[i] >= 0x30 && d[i] <= 0x5A) asciiCount++;
    }
    result.type = asciiCount >= 10 ? 'GPEC2A' : 'RFHUB';
  } else if (sz > 131072) {
    result.type = 'FW';
  }

  // ── RFHUB analysis ──
  if (result.type === 'RFHUB') {
    // SEC16 extraction — try gen2 first, then gen1
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

    // VIN — reversed at standard offsets
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
      if (valid) {
        result.vins.push({ vin, offset: off, algo: 'reversed' });
        break;
      }
    }
  }

  // ── BCM analysis ──
  if (result.type === 'BCM') {
    // VIN with CRC-16 CCITT
    const seen = new Set();
    for (let i = 0; i <= sz - 19; i++) {
      let ok = true;
      for (let j = 0; j < 17; j++) {
        if (d[i + j] < 0x20 || d[i + j] > 0x7E) { ok = false; break; }
      }
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

    // SEC16 split records at 0x81A0/C0/E0
    // Structure: FF FF [6 zeros] [idx] [8 bytes SEC16 fragment] [trailer bytes]
    // The 8 bytes at 0x81A9-0x81B0 are the reversed tail of the RFH SEC16
    if (0x81B1 <= sz) {
      const frag = d.slice(0x81A9, 0x81B1);
      if (!isBlank(frag)) {
        result.bcmFrag = { value: hx(frag), raw: frag, offset: 0x81A9 };
        // Also grab all 3 records for display
        result.security.splitRecords = [];
        for (const base of [0x81A0, 0x81C0, 0x81E0]) {
          if (base + 20 <= sz) {
            const rec = d.slice(base, base + 20);
            if (!isBlank(rec)) {
              result.security.splitRecords.push({ offset: base, data: hx(rec) });
            }
          }
        }
      } else {
        result.bcmFrag = null; // blank = no SEC16 (Trackhawk / gen1)
      }
    }

    // Immo region
    if (0x40E0 <= sz) {
      result.security.immoBlank = isBlank(d.slice(0x40C0, 0x40E0));
    }
  }

  // ── GPEC2A analysis ──
  if (result.type === 'GPEC2A') {
    // VIN at offset 0
    let vin = '', valid = true;
    for (let j = 0; j < 17 && j < sz; j++) {
      const c = String.fromCharCode(d[j]);
      if (!'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'.includes(c)) { valid = false; break; }
      vin += c;
    }
    if (valid && vin.length === 17) {
      result.vins.push({ vin, offset: 0, algo: 'plain' });
    }

    // SKIM
    if (sz > 0x11) {
      result.security.skim = d[0x11];
      result.security.skimEnabled = d[0x11] === 0x80;
    }

    // SEC6 at 0x203 (8 bytes) + mirror at 0x361
    if (sz > 0x20B) {
      const sec6 = d.slice(0x203, 0x20B);
      result.sec6 = { value: hx(sec6), raw: sec6, offset: 0x203 };
      if (sz > 0x369) {
        const mir = d.slice(0x361, 0x369);
        let match = true;
        for (let j = 0; j < 8; j++) { if (sec6[j] !== mir[j]) { match = false; break; } }
        result.sec6.mirror = hx(mir);
        result.sec6.mirrorMatch = match;
      }
    }

    // Tamper
    if (sz > 0xC8C) {
      result.security.tamperByte = d[0xC8C];
      result.security.tamperOk = d[0xC8C] === 0x5A;
    }
  }

  // ── Firmware analysis ──
  if (result.type === 'FW') {
    const sbox = [0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5];
    for (let i = 0; i <= sz - 8; i++) {
      let found = true;
      for (let j = 0; j < 8; j++) { if (d[i + j] !== sbox[j]) { found = false; break; } }
      if (found) { result.security.aesSbox = i; break; }
    }
    if (sz > 0x2FFFC) {
      result.security.unlockByte = d[0x2FFFC];
      result.security.unlocked = d[0x2FFFC] === 0x96;
    }
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════════════
 *  CROSS-MODULE PAIRING ENGINE
 *  The core: compares SEC16 chains across all loaded files
 * ══════════════════════════════════════════════════════════════════════ */
function crossMatch(files) {
  const results = { vinMap: {}, sec16Chains: [], pairings: [], issues: [] };

  // VIN cross-reference
  files.forEach(f => {
    f.vins.forEach(v => {
      if (v.vin === '00000000000000000') return;
      if (!results.vinMap[v.vin]) results.vinMap[v.vin] = [];
      results.vinMap[v.vin].push({ file: f.name, type: f.type });
    });
  });

  // Collect all SEC16 values from RFHUBs
  const rfhSec16Map = {};
  files.filter(f => f.type === 'RFHUB' && f.sec16).forEach(f => {
    const v = f.sec16.value;
    if (!rfhSec16Map[v]) rfhSec16Map[v] = [];
    rfhSec16Map[v].push(f);
  });

  // Collect all BCM fragments
  const bcmFragMap = {};
  files.filter(f => f.type === 'BCM' && f.bcmFrag).forEach(f => {
    const v = f.bcmFrag.value;
    if (!bcmFragMap[v]) bcmFragMap[v] = [];
    bcmFragMap[v].push(f);
  });

  // Collect SEC6 from GPECs
  const gpecSec6Map = {};
  files.filter(f => f.type === 'GPEC2A' && f.sec6).forEach(f => {
    const v = f.sec6.value;
    if (!gpecSec6Map[v]) gpecSec6Map[v] = [];
    gpecSec6Map[v].push(f);
  });

  // ── Match BCM fragments to RFH SEC16 ──
  // BCM stores 8 bytes at 0x81A9 = first 7 bytes of reversed(RFH_SEC16) + trailing byte
  for (const [fragHex, bcmFiles] of Object.entries(bcmFragMap)) {
    let matched = false;
    for (const [sec16Hex, rfhFiles] of Object.entries(rfhSec16Map)) {
      // Reverse the full SEC16
      const sec16Bytes = [];
      for (let i = 0; i < sec16Hex.length; i += 2) sec16Bytes.push(parseInt(sec16Hex.substr(i, 2), 16));
      const reversed = sec16Bytes.reverse();
      const revHex = reversed.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');

      // BCM fragment (8 bytes) should match first 7 bytes of reversed SEC16 + 0x04 trailer
      const fragCore = fragHex.substring(0, 14); // first 7 bytes = 14 hex chars
      const revCore = revHex.substring(0, 14);

      if (fragCore === revCore) {
        // Find matching GPEC SEC6 — should be first 6 bytes of the RFH SEC16
        const expectedSec6Prefix = sec16Hex.substring(0, 12); // first 6 bytes = 12 chars
        const matchedGpec = [];
        for (const [s6Hex, gpecFiles] of Object.entries(gpecSec6Map)) {
          if (s6Hex.substring(0, 12) === expectedSec6Prefix) {
            matchedGpec.push(...gpecFiles);
          }
        }

        results.pairings.push({
          status: 'paired',
          sec16: sec16Hex,
          bcmFrag: fragHex,
          reversed: revHex,
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
      // BCM has a fragment but no matching RFH was found
      const allFF = fragHex.replace(/F/g, '') === '04' || fragHex === 'FFFFFFFFFFFFFF04';
      results.pairings.push({
        status: allFF ? 'blank' : 'orphan',
        bcmFrag: fragHex,
        bcmFiles: bcmFiles.map(f => f.name),
        bcmVins: [...new Set(bcmFiles.flatMap(f => f.vins.map(v => v.vin)))],
        rfhFiles: [],
        gpecFiles: [],
        issue: allFF ? 'Gen1 family — no SEC16 in flash' : 'No matching RFHUB found for this BCM fragment',
      });
    }
  }

  // Check for unmatched RFHUBs
  const matchedSec16s = new Set(results.pairings.filter(p => p.status === 'paired').map(p => p.sec16));
  for (const [sec16Hex, rfhFiles] of Object.entries(rfhSec16Map)) {
    if (!matchedSec16s.has(sec16Hex)) {
      results.pairings.push({
        status: 'unmatched_rfh',
        sec16: sec16Hex,
        rfhFiles: rfhFiles.map(f => f.name),
        rfhVins: [...new Set(rfhFiles.flatMap(f => f.vins.map(v => v.vin)).filter(v => v !== '00000000000000000'))],
        bcmFiles: [],
        gpecFiles: [],
        issue: 'RFHUB has SEC16 but no BCM with matching fragment was loaded',
      });
    }
  }

  // VIN mismatches within pairings
  results.pairings.forEach(p => {
    if (p.status === 'paired') {
      const allVins = [...(p.rfhVins || []), ...(p.bcmVins || [])];
      const unique = [...new Set(allVins)];
      if (unique.length > 1) {
        p.vinMismatch = true;
        results.issues.push(`VIN mismatch in pairing: ${unique.join(' vs ')}`);
      }
    }
  });

  // BCMs with no fragment at all
  files.filter(f => f.type === 'BCM' && !f.bcmFrag).forEach(f => {
    const inPairing = results.pairings.some(p => p.bcmFiles?.includes(f.name));
    if (!inPairing) {
      results.issues.push(`${f.name}: BCM has no SEC16 split records (Trackhawk/gen1)`);
    }
  });

  return results;
}


/* ══════════════════════════════════════════════════════════════════════
 *  UI COMPONENTS
 * ══════════════════════════════════════════════════════════════════════ */

const P = {
  bg: '#060609', card: '#0E0E14', card2: '#151520', card3: '#1C1C28',
  red: '#EF4444', redDim: '#7F1D1D', orange: '#F97316', blue: '#3B82F6',
  cyan: '#06B6D4', green: '#22C55E', purple: '#A855F7', yellow: '#EAB308',
  text: '#E2E0DD', sub: '#6B6B78', muted: '#3A3A48', border: '#222233',
  greenBg: 'rgba(34,197,94,0.08)', redBg: 'rgba(239,68,68,0.08)',
  orangeBg: 'rgba(249,115,22,0.08)', blueBg: 'rgba(59,130,246,0.08)',
};

const TC = { BCM: P.orange, RFHUB: P.blue, GPEC2A: P.cyan, FW: '#6B7280' };
const TL = { BCM: 'BCM D-FLASH', RFHUB: 'RFHUB EEE', GPEC2A: 'GPEC2A', FW: 'Firmware' };

function Tag({ children, color = P.red, size = 'sm' }) {
  const s = size === 'lg' ? { fontSize: 11, padding: '3px 10px' } : { fontSize: 9, padding: '2px 7px' };
  return (
    <span style={{ ...s, fontWeight: 800, borderRadius: 5, background: color + '1A', color, letterSpacing: 0.3, display: 'inline-block', lineHeight: 1.4 }}>
      {children}
    </span>
  );
}

function StatusDot({ status }) {
  const colors = { paired: P.green, orphan: P.red, blank: P.yellow, unmatched_rfh: P.orange };
  const c = colors[status] || P.muted;
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 6px ${c}`, flexShrink: 0 }} />;
}

/* ══════════════════════════════════════════════════════════════════════ */

export default function App() {
  const [files, setFiles] = useState([]);
  const [tab, setTab] = useState('match');
  const [selFile, setSelFile] = useState(null);
  const [seedHex, setSeedHex] = useState('');
  const [seedAlgo, setSeedAlgo] = useState('all');
  const [dragOver, setDragOver] = useState(false);

  const loadFiles = useCallback((fileList) => {
    Promise.all(
      Array.from(fileList)
        .filter(f => f.name.toLowerCase().endsWith('.bin'))
        .map(f => new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = e => resolve(analyzeFile(e.target.result, f.name));
          reader.readAsArrayBuffer(f);
        }))
    ).then(results => {
      const valid = results.filter(r => r.type !== 'unknown');
      if (valid.length) setFiles(prev => [...prev, ...valid]);
    });
  }, []);

  const matchResult = useMemo(() => files.length > 0 ? crossMatch(files) : null, [files]);

  const counts = useMemo(() => {
    const c = { BCM: 0, RFHUB: 0, GPEC2A: 0, FW: 0, total: files.length };
    files.forEach(f => { if (c[f.type] !== undefined) c[f.type]++; });
    return c;
  }, [files]);

  const clearAll = () => { setFiles([]); setSelFile(null); };

  const openFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.bin,.BIN';
    input.onchange = e => loadFiles(e.target.files);
    input.click();
  };

  // ── Drop zone or main UI ──
  if (files.length === 0) {
    return (
      <div style={{ minHeight: '100vh', background: P.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');
          @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
          @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
          * { box-sizing: border-box; }
        `}</style>
        <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse 70% 40% at 50% 30%, rgba(239,68,68,0.07), transparent)' }} />
        <div style={{ position: 'relative', zIndex: 2, textAlign: 'center', maxWidth: 600, padding: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 40 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg, #EF4444, #991B1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 900, color: '#fff', boxShadow: '0 8px 32px rgba(239,68,68,0.3)' }}>S</div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 4, color: '#fff' }}>SRT LAB</div>
              <div style={{ fontSize: 9, letterSpacing: 5, color: P.sub, fontWeight: 700 }}>MODULE PAIRING ANALYZER</div>
            </div>
          </div>

          <div
            onClick={openFilePicker}
            onDrop={e => { e.preventDefault(); setDragOver(false); loadFiles(e.dataTransfer.files); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            style={{
              padding: '56px 40px', borderRadius: 20,
              border: `2px dashed ${dragOver ? P.red : P.border}`,
              background: dragOver ? P.redBg : P.card,
              cursor: 'pointer', transition: 'all 0.25s',
              boxShadow: dragOver ? `0 0 40px ${P.red}15` : 'none',
            }}
          >
            <div style={{ fontSize: 56, marginBottom: 16, animation: 'float 3s ease-in-out infinite' }}>🔗</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginBottom: 8 }}>
              Drop module dumps to analyze
            </div>
            <div style={{ fontSize: 12, color: P.sub, lineHeight: 1.6 }}>
              BCM D-FLASH · RFHUB EEE · GPEC2A · Firmware .bin
            </div>
            <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {[['BCM', P.orange], ['RFHUB', P.blue], ['GPEC2A', P.cyan], ['FW', '#6B7280']].map(([l, c]) => (
                <Tag key={l} color={c} size="lg">{l}</Tag>
              ))}
            </div>
            <div style={{ marginTop: 24, fontSize: 10, color: P.muted }}>
              Drop files from different vehicles — instant cross-module SEC16 chain verification
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Main workspace ──
  return (
    <div style={{ minHeight: '100vh', background: P.bg, color: P.text, fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: ${P.border} transparent; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ background: P.card, borderBottom: `1px solid ${P.border}`, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #EF4444, #991B1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 900, color: '#fff' }}>S</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#fff' }}>SRT LAB</div>
          <div style={{ fontSize: 7, color: P.sub, letterSpacing: 3, fontWeight: 700 }}>PAIRING ANALYZER</div>
        </div>
        <div style={{ flex: 1 }} />

        {/* Counts */}
        <div style={{ display: 'flex', gap: 10, marginRight: 12 }}>
          {[['BCM', counts.BCM, P.orange], ['RFH', counts.RFHUB, P.blue], ['GPEC', counts.GPEC2A, P.cyan]].map(([l, v, c]) => (
            <div key={l} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: v > 0 ? c : P.muted }}>{v}</div>
              <div style={{ fontSize: 7, color: P.sub, letterSpacing: 1 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Pairing status dot */}
        {matchResult && (() => {
          const paired = matchResult.pairings.filter(p => p.status === 'paired').length;
          const orphan = matchResult.pairings.filter(p => p.status === 'orphan').length;
          const c = orphan > 0 ? P.red : paired > 0 ? P.green : P.yellow;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 8, background: c + '12', border: `1px solid ${c}30` }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 6px ${c}`, animation: 'pulse 2s infinite', display: 'inline-block' }} />
              <span style={{ fontSize: 9, fontWeight: 700, color: c }}>
                {paired > 0 ? `${paired} PAIRED` : ''}{orphan > 0 ? ` · ${orphan} ORPHAN` : ''}
                {paired === 0 && orphan === 0 ? 'ANALYZING' : ''}
              </span>
            </div>
          );
        })()}

        <button onClick={openFilePicker} style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${P.border}`, background: P.card2, color: P.text, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+ ADD</button>
        <button onClick={clearAll} style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${P.redDim}`, background: 'transparent', color: P.red, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>CLEAR</button>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 2, padding: '8px 20px 0', background: P.card, borderBottom: `1px solid ${P.border}` }}>
        {[
          { id: 'match', label: '🔗 PAIRING', sub: 'Cross-module' },
          { id: 'files', label: '📂 FILES', sub: `${files.length} loaded` },
          { id: 'seed', label: '🔑 SEED→KEY', sub: '11 algos' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 16px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: tab === t.id ? P.bg : 'transparent',
            borderRadius: '8px 8px 0 0',
            color: tab === t.id ? '#fff' : P.sub,
            fontWeight: tab === t.id ? 800 : 600, fontSize: 11,
            transition: 'all 0.15s',
          }}>
            {t.label}
            <div style={{ fontSize: 7, color: P.muted, marginTop: 2 }}>{t.sub}</div>
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 20px 60px' }}>
        {tab === 'match' && <MatchTab files={files} result={matchResult} />}
        {tab === 'files' && <FilesTab files={files} selFile={selFile} setSelFile={setSelFile} />}
        {tab === 'seed' && <SeedTab seedHex={seedHex} setSeedHex={setSeedHex} seedAlgo={seedAlgo} setSeedAlgo={setSeedAlgo} />}
      </div>
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════════
 *  MATCH TAB — the main event
 * ══════════════════════════════════════════════════════════════════════ */
function MatchTab({ files, result }) {
  if (!result) return null;

  const vins = Object.entries(result.vinMap).sort((a, b) => b[1].length - a[1].length);

  return (
    <div>
      {/* VIN Cross-Reference */}
      <Section title="VIN CROSS-REFERENCE" count={vins.length} color={P.orange}>
        {vins.length === 0 && <div style={{ fontSize: 11, color: P.sub, padding: 12 }}>No VINs detected — files may be wiped or non-standard format</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 6 }}>
          {vins.map(([vin, refs]) => {
            const types = {};
            refs.forEach(r => { types[r.type] = (types[r.type] || 0) + 1; });
            const allSameVin = vins.length === 1;
            return (
              <div key={vin} style={{ padding: '10px 12px', borderRadius: 8, background: P.card2, border: `1px solid ${allSameVin ? P.green + '30' : refs.length > 1 ? P.orange + '30' : P.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: P.orange, letterSpacing: 2 }}>{vin}</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {Object.entries(types).map(([t, c]) => <Tag key={t} color={TC[t]}>{t}×{c}</Tag>)}
                  </div>
                </div>
                {refs.length >= 2 && allSameVin && <div style={{ fontSize: 9, color: P.green, marginTop: 4, fontWeight: 700 }}>✓ All modules share this VIN</div>}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Pairing Chains */}
      <Section title="SEC16 PAIRING CHAINS" count={result.pairings.length} color={P.purple}>
        <div style={{ padding: '8px 10px', borderRadius: 8, background: P.card2, border: `1px solid ${P.border}`, marginBottom: 12, fontSize: 10, lineHeight: 1.7, color: P.sub }}>
          <span style={{ color: P.blue }}>RFH SEC16</span> (16B) ←{' '}
          <span style={{ color: P.orange }}>reverse()</span> →{' '}
          <span style={{ color: P.orange }}>BCM split @0x81A9</span>{'   ·   '}
          <span style={{ color: P.blue }}>RFH SEC16[0:6]</span> →{' '}
          <span style={{ color: P.cyan }}>GPEC SEC6 @0x203</span>
        </div>

        {result.pairings.map((p, i) => (
          <PairingCard key={i} p={p} />
        ))}
      </Section>

      {/* Issues */}
      {result.issues.length > 0 && (
        <Section title="ISSUES" count={result.issues.length} color={P.yellow}>
          {result.issues.map((issue, i) => (
            <div key={i} style={{ padding: '8px 10px', borderRadius: 6, background: P.orangeBg, border: `1px solid ${P.yellow}20`, marginBottom: 4, fontSize: 10, color: P.yellow }}>
              ⚠ {issue}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function PairingCard({ p }) {
  const statusColors = { paired: P.green, orphan: P.red, blank: P.yellow, unmatched_rfh: P.orange };
  const statusLabels = { paired: 'PAIRED', orphan: 'ORPHAN', blank: 'BLANK (GEN1)', unmatched_rfh: 'NO BCM LOADED' };
  const c = statusColors[p.status] || P.muted;

  return (
    <div style={{ padding: 14, borderRadius: 10, background: P.card, border: `1.5px solid ${c}25`, marginBottom: 8 }}>
      {/* Status header */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <StatusDot status={p.status} />
        <Tag color={c} size="lg">{statusLabels[p.status]}</Tag>
        {p.vinMismatch && <Tag color={P.red} size="lg">⚠ VIN MISMATCH</Tag>}
      </div>

      {/* SEC16 value */}
      {p.sec16 && (
        <div style={{ padding: '8px 10px', borderRadius: 6, background: P.card2, border: `1px solid ${P.purple}20`, marginBottom: 8 }}>
          <div style={{ fontSize: 8, fontWeight: 800, color: P.purple, letterSpacing: 2, marginBottom: 3 }}>SEC16</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.purple, wordBreak: 'break-all' }}>{p.sec16}</div>
          {p.reversed && <div style={{ fontSize: 9, color: P.sub, marginTop: 3 }}>reversed: <span style={{ color: P.orange }}>{p.reversed.substring(0, 16)}...</span></div>}
        </div>
      )}

      {/* BCM fragment */}
      {p.bcmFrag && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: P.orangeBg, marginBottom: 8 }}>
          <span style={{ fontSize: 8, fontWeight: 800, color: P.orange, letterSpacing: 1 }}>BCM FRAG: </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: P.orange }}>{p.bcmFrag}</span>
        </div>
      )}

      {/* File lists */}
      <div style={{ display: 'grid', gridTemplateColumns: p.gpecFiles?.length > 0 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
        <FileList label="RFHUB" color={P.blue} files={p.rfhFiles || []} vins={p.rfhVins || []} />
        <FileList label="BCM" color={P.orange} files={p.bcmFiles || []} vins={p.bcmVins || []} />
        {p.gpecFiles?.length > 0 && <FileList label="GPEC2A" color={P.cyan} files={p.gpecFiles} vins={[]} />}
      </div>

      {/* Issue text */}
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
      )) : (
        <div style={{ fontSize: 9, color: P.muted, padding: 4 }}>—</div>
      )}
      {vins?.length > 0 && vins.map((v, i) => (
        <div key={i} style={{ fontSize: 8, color: P.orange, marginTop: 2 }}>{v}</div>
      ))}
    </div>
  );
}


/* ══════════════════════════════════════════════════════════════════════
 *  FILES TAB
 * ══════════════════════════════════════════════════════════════════════ */
function FilesTab({ files, selFile, setSelFile }) {
  const [filter, setFilter] = useState('ALL');
  const types = ['ALL', 'BCM', 'RFHUB', 'GPEC2A', 'FW'];
  const filtered = filter === 'ALL' ? files : files.filter(f => f.type === filter);
  const sel = selFile !== null && selFile < filtered.length ? filtered[selFile] : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: sel ? '260px 1fr' : '1fr', gap: 12, alignItems: 'start' }}>
      <div>
        <div style={{ display: 'flex', gap: 3, marginBottom: 10, flexWrap: 'wrap' }}>
          {types.map(t => {
            const ct = t === 'ALL' ? files.length : files.filter(f => f.type === t).length;
            if (ct === 0 && t !== 'ALL') return null;
            return (
              <button key={t} onClick={() => { setFilter(t); setSelFile(null); }} style={{
                padding: '5px 12px', borderRadius: 6, fontFamily: 'inherit',
                border: `1.5px solid ${filter === t ? (TC[t] || P.red) : P.border}`,
                background: filter === t ? (TC[t] || P.red) + '15' : P.card,
                color: filter === t ? (TC[t] || P.red) : P.sub,
                fontSize: 9, fontWeight: 800, cursor: 'pointer',
              }}>{t} ({ct})</button>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: '75vh', overflowY: 'auto' }}>
          {filtered.map((f, i) => (
            <div key={i} onClick={() => setSelFile(i)} style={{
              padding: '8px 10px', borderRadius: 7, cursor: 'pointer', transition: 'all 0.12s',
              background: selFile === i ? P.card2 : P.card,
              border: `1.5px solid ${selFile === i ? (TC[f.type] || P.red) : P.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: selFile === i ? '#fff' : P.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>{f.name}</div>
                <Tag color={TC[f.type] || P.muted}>{f.type}</Tag>
              </div>
              {f.vins[0] && f.vins[0].vin !== '00000000000000000' && (
                <div style={{ fontSize: 9, color: P.orange, fontWeight: 700, marginTop: 2, letterSpacing: 1 }}>{f.vins[0].vin}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      {sel && <FileDetail f={sel} />}
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
        {f.sec16?.bakMatch && <Tag color={P.green} size="lg">PRI=BAK ✓</Tag>}
      </div>

      {f.vins.length > 0 && (
        <DetailBlock label="VIN" color={P.orange}>
          {f.vins.map((v, i) => (
            <div key={i}>
              <span style={{ fontSize: 14, fontWeight: 800, color: v.vin === '00000000000000000' ? P.yellow : P.orange, letterSpacing: 2 }}>{v.vin}</span>
              <span style={{ fontSize: 8, color: P.sub, marginLeft: 8 }}>@0x{v.offset.toString(16).toUpperCase()} · {v.algo}</span>
              {v.storedCrc !== undefined && <span style={{ fontSize: 8, color: P.green, marginLeft: 6 }}>CRC:0x{v.storedCrc.toString(16).toUpperCase()} ✓</span>}
            </div>
          ))}
        </DetailBlock>
      )}

      {f.sec16 && (
        <DetailBlock label={`SEC16 (${f.sec16.gen} @0x${f.sec16.priOff.toString(16).toUpperCase()})`} color={P.purple}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.purple, wordBreak: 'break-all', lineHeight: 1.5 }}>{f.sec16.value}</div>
          <div style={{ fontSize: 9, color: P.sub, marginTop: 4 }}>
            Reversed: <span style={{ color: P.orange }}>{f.sec16.value.match(/.{2}/g).reverse().join('')}</span>
          </div>
          <div style={{ fontSize: 9, color: P.sub, marginTop: 2 }}>
            First 6 bytes (→ GPEC SEC6): <span style={{ color: P.cyan }}>{f.sec16.value.substring(0, 12)}</span>
          </div>
        </DetailBlock>
      )}

      {f.bcmFrag && (
        <DetailBlock label={`BCM SEC16 FRAGMENT (@0x${f.bcmFrag.offset.toString(16).toUpperCase()})`} color={P.orange}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.orange }}>{f.bcmFrag.value}</div>
          {f.security.splitRecords?.map((rec, i) => (
            <div key={i} style={{ fontSize: 8, color: P.sub, marginTop: 2 }}>
              0x{rec.offset.toString(16).toUpperCase()}: {rec.data}
            </div>
          ))}
        </DetailBlock>
      )}

      {f.sec6 && (
        <DetailBlock label={`GPEC SEC6 (@0x${f.sec6.offset.toString(16).toUpperCase()})`} color={P.cyan}>
          <div style={{ fontSize: 12, fontWeight: 700, color: P.cyan }}>{f.sec6.value}</div>
          {f.sec6.mirror && (
            <div style={{ fontSize: 9, color: f.sec6.mirrorMatch ? P.green : P.red, marginTop: 3 }}>
              Mirror @0x361: {f.sec6.mirror} {f.sec6.mirrorMatch ? '✓ match' : '✗ MISMATCH'}
            </div>
          )}
        </DetailBlock>
      )}

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
        {f.security.immoBlank !== undefined && <Tag color={f.security.immoBlank ? P.yellow : P.green} size="lg">IMMO: {f.security.immoBlank ? 'BLANK' : 'SET'}</Tag>}
        {f.security.skimEnabled !== undefined && <Tag color={f.security.skimEnabled ? P.green : P.yellow} size="lg">SKIM: {f.security.skimEnabled ? 'ON' : 'OFF'}</Tag>}
        {f.security.tamperOk !== undefined && <Tag color={f.security.tamperOk ? P.green : P.red} size="lg">TAMPER: {f.security.tamperOk ? 'OK' : 'TRIPPED'}</Tag>}
        {f.security.unlocked !== undefined && <Tag color={f.security.unlocked ? P.green : P.yellow} size="lg">FW: {f.security.unlocked ? 'UNLOCKED' : 'LOCKED'}</Tag>}
        {f.security.aesSbox !== undefined && <Tag color={P.purple} size="lg">AES S-box @0x{f.security.aesSbox.toString(16).toUpperCase()}</Tag>}
        {f.type === 'BCM' && !f.bcmFrag && <Tag color={P.muted} size="lg">NO SEC16 RECORDS</Tag>}
      </div>
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


/* ══════════════════════════════════════════════════════════════════════
 *  SEED→KEY TAB
 * ══════════════════════════════════════════════════════════════════════ */
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
          value={seedHex} placeholder="Enter seed hex (e.g. A1B2C3D4)"
          onChange={e => setSeedHex(e.target.value.toUpperCase().replace(/[^A-F0-9\s]/g, ''))}
          style={{
            width: '100%', padding: 12, borderRadius: 10, border: `2px solid ${P.border}`,
            background: P.card2, color: P.text, fontSize: 20, fontWeight: 700,
            letterSpacing: 4, textAlign: 'center', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
          }}
          onFocus={e => e.target.style.borderColor = P.red}
          onBlur={e => e.target.style.borderColor = P.border}
        />

        {res && !res.multi && (
          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, background: P.card2, border: `1px solid ${P.border}` }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 30px 1fr', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 8, color: P.muted, letterSpacing: 2 }}>SEED</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: P.blue }}>{res.seed}</div>
              </div>
              <div style={{ textAlign: 'center', color: P.muted, fontSize: 16 }}>→</div>
              <div>
                <div style={{ fontSize: 8, color: P.muted, letterSpacing: 2 }}>KEY</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: P.red }}>{res.key}</div>
              </div>
            </div>
            <div style={{ fontSize: 9, color: P.sub, marginTop: 4 }}>{res.n}</div>
          </div>
        )}

        {res?.multi && (
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            {res.results.map((r, i) => (
              <div key={i} style={{
                padding: '8px 10px', borderRadius: 6, background: P.card2,
                border: `1px solid ${P.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
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


/* ── Shared section wrapper ── */
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
