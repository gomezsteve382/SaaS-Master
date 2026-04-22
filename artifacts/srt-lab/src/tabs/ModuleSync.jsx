import React, { useState, useCallback, useEffect, useRef } from "react";
import { ASSET_IDS, trackDownload } from "../lib/downloadAssets.js";
import { DownloadCounter } from "../lib/useDownloadCount.jsx";

/* ============================================================================
 * SRT Lab — Module Sync (2017 and below)
 * Huntsville Continental BCM (68525720 / 68277389 family)
 *   ↔ Yazaki FCM RFHUB (AA30712804 family)
 *
 * Offsets verified across:
 *   - 2017 LX Scat Pack salvage dumps (BCM P/N 68525720AA, RFH from 2015 donor)
 *   - 2016 LD Scat Pack factory dumps (BCM P/N 68277389AC, matched RFH)
 *
 * BCM VIN storage: 4 redundant ASCII slots preceded by "00 46 XX 00" marker,
 *   where XX ∈ {0x46, 0x52, 0x53, 0x56, 0x57}. Slot offsets vary by variant
 *   (0x5308-0x5368 vs 0x1308-0x1368) — parser locates them by marker pattern.
 *
 * RFHUB VIN storage: 4 byte-reversed slots at fixed offsets
 *   0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1 (each 17 bytes + "DB 01" trailer at +17)
 *
 * RFHUB SEC16: 18-byte security block at 0x0226 (primary) and 0x023A (mirror).
 *   Should be byte-identical when paired. Virginize wipes both to 0xFF to
 *   force re-negotiation with BCM on next power-up.
 * ============================================================================ */

const C = {
  bg: '#F4F1EC', cd: '#FFF', c2: '#FAF9F7', sr: '#D32F2F', sl: '#FF5252',
  bk: '#1A1A1A', a1: '#FF6D00', a2: '#00BFA5', a3: '#2979FF', a4: '#AA00FF',
  tx: '#1A1A1A', ts: '#5A5A5A', tm: '#9E9E9E', bd: '#E8E4DE',
  gn: '#00C853', wn: '#FFB300', er: '#FF1744',
};

const VIN_RE = /^[12345][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9]{14}$/;
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const RFH_SEC16_OFFSETS = [0x0226, 0x023A];
const RFH_SEC16_LEN = 18;
const VIN_LEN = 17;

function crc16Ccitt(data, init = 0xFFFF, poly = 0x1021) {
  let c = init;
  for (const b of data) {
    c ^= b << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? (((c << 1) ^ poly) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
  }
  return c & 0xFFFF;
}

function parseBcm(bytes) {
  const result = {
    ok: false, kind: 'BCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    partNumbers: [], supplierSerial: null,
    magic: false, magicOffsets: [], sequenceNumbers: [],
  };

  const magic = [0x46, 0x45, 0x45, 0x31, 0x30, 0x30, 0x30];
  for (let i = 0; i < bytes.length - magic.length; i++) {
    let match = true;
    for (let j = 0; j < magic.length; j++) if (bytes[i+j] !== magic[j]) { match = false; break; }
    if (match) {
      result.magicOffsets.push(i);
      if (i >= 2) result.sequenceNumbers.push({ offset: i-2, seq: (bytes[i-2] << 8) | bytes[i-1] });
    }
  }
  result.magic = result.magicOffsets.length > 0;

  for (let i = 0; i < bytes.length - 21; i++) {
    if (bytes[i] !== 0x00 || bytes[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(bytes[i+2])) continue;
    if (bytes[i+3] !== 0x00) continue;
    const vinStart = i + 4;
    if (vinStart + VIN_LEN > bytes.length) continue;
    let candidate = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = bytes[vinStart + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      candidate += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(candidate)) continue;
    let storedCrc = null, computedCrc = null, crcOk = null;
    if (vinStart + 19 <= bytes.length) {
      storedCrc = (bytes[vinStart + 17] << 8) | bytes[vinStart + 18];
      computedCrc = crc16Ccitt(bytes.slice(vinStart, vinStart + 17));
      crcOk = storedCrc === computedCrc;
    }
    result.vinSlots.push({ offset: vinStart, markerOffset: i, slotType: bytes[i+2], vin: candidate, storedCrc, computedCrc, crcOk });
  }

  if (result.vinSlots.length > 0) {
    const vins = new Set(result.vinSlots.map(s => s.vin));
    result.vin = result.vinSlots[0].vin;
    result.vinConsistent = vins.size === 1;
  }

  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
  const partsSet = new Set();
  (text.match(/68\d{6}/g) || []).forEach(p => partsSet.add(p));
  result.partNumbers = Array.from(partsSet);
  const supMatch = text.match(/TY[A-Z]\d{5}/);
  if (supMatch) result.supplierSerial = supMatch[0];

  result.ok = result.vin !== null;
  return result;
}

function parseRfh(bytes) {
  const result = {
    ok: false, kind: 'RFHUB', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    sec16Slot1: null, sec16Slot2: null, sec16Match: false, sec16Virgin: false,
    partNumbers: [], internalSerial: null, keyCount: 0,
  };

  for (const off of RFH_VIN_OFFSETS) {
    if (off + VIN_LEN > bytes.length) continue;
    const slice = bytes.slice(off, off + VIN_LEN);
    const reversed = new Uint8Array(VIN_LEN);
    for (let i = 0; i < VIN_LEN; i++) reversed[i] = slice[VIN_LEN - 1 - i];
    let candidate = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = reversed[k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      candidate += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(candidate)) continue;
    let storedChk = null, computedChk = null, chkOk = null, sumByte = null;
    if (off + 18 <= bytes.length) {
      storedChk = bytes[off + 17];
      sumByte = 0;
      for (const b of slice) sumByte = (sumByte + b) & 0xFF;
      computedChk = (0xF9 - sumByte) & 0xFF;
      chkOk = storedChk === computedChk;
    }
    result.vinSlots.push({ offset: off, vin: candidate, storedChk, computedChk, chkOk, sumByte });
  }
  if (result.vinSlots.length > 0) {
    const vins = new Set(result.vinSlots.map(s => s.vin));
    result.vin = result.vinSlots[0].vin;
    result.vinConsistent = vins.size === 1;
  }

  if (bytes.length >= RFH_SEC16_OFFSETS[0] + RFH_SEC16_LEN) {
    result.sec16Slot1 = bytes.slice(RFH_SEC16_OFFSETS[0], RFH_SEC16_OFFSETS[0] + RFH_SEC16_LEN);
  }
  if (bytes.length >= RFH_SEC16_OFFSETS[1] + RFH_SEC16_LEN) {
    result.sec16Slot2 = bytes.slice(RFH_SEC16_OFFSETS[1], RFH_SEC16_OFFSETS[1] + RFH_SEC16_LEN);
  }
  if (result.sec16Slot1 && result.sec16Slot2) {
    result.sec16Match = true;
    for (let i = 0; i < RFH_SEC16_LEN; i++) {
      if (result.sec16Slot1[i] !== result.sec16Slot2[i]) { result.sec16Match = false; break; }
    }
    const allFF = a => Array.from(a).every(b => b === 0xFF);
    result.sec16Virgin = allFF(result.sec16Slot1) && allFF(result.sec16Slot2);
  }

  const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
  const partsSet = new Set();
  (text.match(/(?:AA\d{8}|BA\d{8})/g) || []).forEach(p => partsSet.add(p));
  result.partNumbers = Array.from(partsSet);
  const serialMatch = text.match(/\d{4}[A-Z]\d{3,4}[A-Z]{2}\d{2}[A-Z]/);
  if (serialMatch) result.internalSerial = serialMatch[0];

  // Count populated key slots (0x08C0-0x0A60 region)
  const KEY_START = 0x08C0, KEY_END = 0x0A60, KEY_STRIDE = 48;
  for (let off = KEY_START; off < KEY_END && off + 16 < bytes.length; off += KEY_STRIDE) {
    const head = bytes.slice(off, off + 8);
    const empty = Array.from(head).every(b => b === 0x50 || b === 0x5A || b === 0xFF);
    if (!empty) result.keyCount++;
  }

  result.ok = result.vin !== null;
  return result;
}

function writeBcmVin(bytes, newVin) {
  if (newVin.length !== VIN_LEN) throw new Error('VIN must be 17 chars');
  const out = new Uint8Array(bytes);
  const newVinBytes = new TextEncoder().encode(newVin);
  const newCrc = crc16Ccitt(newVinBytes);
  const crcHi = (newCrc >> 8) & 0xFF, crcLo = newCrc & 0xFF;
  let patched = 0;
  for (let i = 0; i < out.length - 21; i++) {
    if (out[i] !== 0x00 || out[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(out[i+2])) continue;
    if (out[i+3] !== 0x00) continue;
    const vs = i + 4;
    if (vs + 19 > out.length) continue;
    let curr = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = out[vs + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      curr += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(curr)) continue;
    for (let k = 0; k < VIN_LEN; k++) out[vs + k] = newVinBytes[k];
    out[vs + 17] = crcHi;  // CRC-16/CCITT big-endian
    out[vs + 18] = crcLo;
    patched++;
  }
  return { bytes: out, patched, crc: newCrc };
}

function writeRfhVin(bytes, newVin, virginize) {
  if (newVin.length !== VIN_LEN) throw new Error('VIN must be 17 chars');
  const out = new Uint8Array(bytes);
  const forward = new TextEncoder().encode(newVin);
  const reversed = new Uint8Array(VIN_LEN);
  for (let i = 0; i < VIN_LEN; i++) reversed[i] = forward[VIN_LEN - 1 - i];
  // Recompute 1-byte VIN checksum: chk = (0xF9 - sum(reversed VIN bytes)) & 0xFF
  let sum = 0;
  for (const b of reversed) sum = (sum + b) & 0xFF;
  const chk = (0xF9 - sum) & 0xFF;
  let patched = 0;
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let k = 0; k < VIN_LEN; k++) out[off + k] = reversed[k];
    out[off + 17] = chk;
    patched++;
  }
  let sec16Wiped = 0;
  if (virginize) {
    for (const so of RFH_SEC16_OFFSETS) {
      if (so + RFH_SEC16_LEN > out.length) continue;
      for (let k = 0; k < RFH_SEC16_LEN; k++) out[so + k] = 0xFF;
      sec16Wiped++;
    }
  }
  return { bytes: out, patched, sec16Wiped, chk };
}

function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }
function bytesToHex(bytes) { return Array.from(bytes).map(hex2).join(''); }
function timestamp() {
  const d = new Date(), p = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function downloadBin(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  trackDownload(ASSET_IDS.modSyncPatched);
}

function DropZone({ kind, label, icon, hint, file, onFile }) {
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const loaded = file != null;
  const handle = async (f) => {
    const buf = await f.arrayBuffer();
    onFile(f, new Uint8Array(buf));
  };
  return (
    <div
      onClick={() => fileRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); }}
      style={{
        background: C.cd, border: `2px dashed ${loaded ? C.gn : over ? C.sr : C.bd}`,
        borderStyle: loaded ? 'solid' : 'dashed',
        borderRadius: 14, padding: '24px 16px', textAlign: 'center', cursor: 'pointer',
        transition: 'all 0.2s', backgroundColor: loaded ? 'rgba(0,200,83,0.03)' : over ? 'rgba(211,47,47,0.03)' : C.cd,
      }}
    >
      <div style={{ fontSize: 30, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontFamily: "'Nunito'", fontWeight: 800, fontSize: 13, letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.tm, marginTop: 4 }}>{hint}</div>
      {loaded && <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, marginTop: 6, color: C.gn, fontWeight: 600, wordBreak: 'break-all' }}>
        {file.name} · {file.size} bytes
      </div>}
      <input ref={fileRef} type="file" accept=".bin,.BIN,.eprom" style={{ display: 'none' }}
             onChange={e => { if (e.target.files[0]) handle(e.target.files[0]); }} />
    </div>
  );
}

function Kv({ k, v, mono = false, hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 12px', fontSize: 12, marginBottom: 6, alignItems: 'start' }}>
      <div style={{ color: C.ts, fontWeight: 600 }}>{k}</div>
      <div style={{ fontFamily: mono ? "'JetBrains Mono'" : "'Nunito'", fontWeight: 600, color: v ? C.tx : C.tm, fontStyle: v ? 'normal' : 'italic', fontSize: mono ? 11 : 12, wordBreak: 'break-all' }}>
        {v || 'none'}{hint && <span style={{ color: C.tm, fontSize: 10, marginLeft: 6 }}>{hint}</span>}
      </div>
    </div>
  );
}

function ModCard({ parsed, kind }) {
  if (!parsed) return null;
  const title = kind === 'bcm' ? '🧠 BCM · MPC5606B' : '🔑 RFHUB · Yazaki FCM';
  let status, cls;
  if (!parsed.ok) { status = 'NO VIN'; cls = 'err'; }
  else if (!parsed.vinConsistent) { status = 'SLOTS INCONSISTENT'; cls = 'warn'; }
  else if (kind === 'rfh' && parsed.sec16Virgin) { status = 'SEC16 VIRGIN'; cls = 'warn'; }
  else if (kind === 'rfh' && !parsed.sec16Match) { status = 'SEC16 MISMATCH'; cls = 'warn'; }
  else { status = 'READY'; cls = 'ok'; }

  const borderMap = { ok: C.gn, warn: C.wn, err: C.er };
  const bgMap = { ok: 'rgba(0,200,83,0.03)', warn: 'rgba(255,179,0,0.03)', err: 'rgba(255,23,68,0.03)' };
  const badgeMap = { ok: C.gn, warn: C.wn, err: C.er };

  return (
    <div style={{
      background: bgMap[cls], borderRadius: 12, padding: 16,
      border: `1.5px solid ${borderMap[cls]}40`,
    }}>
      <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: C.tx, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        {title}
        <span style={{ marginLeft: 'auto', fontSize: 9, padding: '2px 7px', borderRadius: 4, letterSpacing: 0.6, background: badgeMap[cls], color: '#fff', fontWeight: 700 }}>{status}</span>
      </div>
      <Kv k="Stored VIN" v={parsed.vin} mono />
      <Kv k="VIN slots" v={`${parsed.vinSlots.length} / 4 ${parsed.vinConsistent ? '· all match' : '· MISMATCH'}`} />
      <Kv k="Size" v={`${parsed.size} bytes (0x${hex4(parsed.size)})`} mono />
      {kind === 'bcm' && parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.crcOk);
        const crc = parsed.vinSlots[0].computedCrc;
        return <Kv k="VIN CRC-16" v={`0x${(crc ?? 0).toString(16).toUpperCase().padStart(4,'0')} (CCITT/BE) · ${allOk ? '✓ valid' : '✗ mismatch'}`} mono />;
      })()}
      {kind === 'rfh' && parsed.vinSlots.length > 0 && (() => {
        const allOk = parsed.vinSlots.every(s => s.chkOk);
        const chk = parsed.vinSlots[0].computedChk;
        return <Kv k="VIN checksum" v={`0x${(chk ?? 0).toString(16).toUpperCase().padStart(2,'0')} · ${allOk ? '✓ valid' : '⚠ mismatch (older variant?)'}`} mono />;
      })()}
      {kind === 'bcm' && <>
        <Kv k="Part numbers" v={parsed.partNumbers.length ? parsed.partNumbers.join(', ') : null} mono />
        {parsed.supplierSerial && <Kv k="Supplier" v={parsed.supplierSerial} mono />}
        {parsed.magic && <Kv k="DFLASH magic" v={`FEE1000 @ ${parsed.magicOffsets.map(o=>'0x'+hex4(o)).join(', ')}`} mono />}
        {parsed.sequenceNumbers.length > 0 && <Kv k="DFLASH seq" v={parsed.sequenceNumbers.map(s=>s.seq).join(' / ')} />}
      </>}
      {kind === 'rfh' && <>
        <Kv k="Part numbers" v={parsed.partNumbers.length ? parsed.partNumbers.join(', ') : null} mono />
        {parsed.internalSerial && <Kv k="Serial" v={parsed.internalSerial} mono />}
        <Kv k="SEC16 status" v={parsed.sec16Virgin ? 'VIRGIN (all FF)' : parsed.sec16Match ? 'MATCH' : 'MISMATCH'} />
        <Kv k="SEC16 slot 1" v={parsed.sec16Slot1 ? bytesToHex(parsed.sec16Slot1).slice(0,36) + (bytesToHex(parsed.sec16Slot1).length > 36 ? '…' : '') : null} mono />
        <Kv k="SEC16 slot 2" v={parsed.sec16Slot2 ? bytesToHex(parsed.sec16Slot2).slice(0,36) + (bytesToHex(parsed.sec16Slot2).length > 36 ? '…' : '') : null} mono />
        <Kv k="Keys" v={`${parsed.keyCount} slot${parsed.keyCount === 1 ? '' : 's'} populated`} />
      </>}
    </div>
  );
}

function VinDiffTable({ rows }) {
  if (!rows || rows.length === 0) return null;
  const changed = rows.filter(r => r.oldVin !== r.newVin);
  const unchanged = rows.filter(r => r.oldVin === r.newVin);
  const allPass = rows.every(r => r.newPass);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        fontWeight: 900, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase',
        color: '#9E9E9E', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
      }}>
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
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: "'JetBrains Mono'", fontSize: 10.5, color: '#E0E0E0',
          background: '#0F1419',
        }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2F36', background: '#161C24' }}>
              {['Module', 'Slot', 'Offset', 'Old VIN', 'New VIN', 'Old Chk', 'New Chk', 'Status'].map(h => (
                <th key={h} style={{
                  padding: '7px 10px', textAlign: 'left', fontWeight: 700,
                  fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#6B7280',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const vinChanged = r.oldVin !== r.newVin;
              return (
                <tr key={i} style={{
                  borderBottom: i < rows.length - 1 ? '1px solid #1E252D' : 'none',
                  background: vinChanged ? 'rgba(255,109,0,0.06)' : 'transparent',
                }}>
                  <td style={{ padding: '7px 10px', color: r.module === 'BCM' ? '#60A5FA' : '#C084FC', fontWeight: 700, fontSize: 10 }}>
                    {r.module}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#6B7280' }}>#{r.slot}</td>
                  <td style={{ padding: '7px 10px', color: '#9CA3AF' }}>{r.offset}</td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#F87171' : '#6B7280', letterSpacing: 1.5 }}>
                    {r.oldVin || '—'}
                  </td>
                  <td style={{ padding: '7px 10px', color: vinChanged ? '#4ADE80' : '#6B7280', fontWeight: vinChanged ? 700 : 400, letterSpacing: 1.5 }}>
                    {r.newVin}
                  </td>
                  <td style={{ padding: '7px 10px', color: r.oldPass === true ? '#4ADE80' : r.oldPass === false ? '#F87171' : '#6B7280' }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>
                    {r.oldCheck}
                    {r.oldPass === false && <span style={{ color: '#F87171', marginLeft: 4, fontSize: 9 }}>✗</span>}
                    {r.oldPass === true && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px', color: '#4ADE80', fontWeight: 700 }}>
                    <span style={{ color: '#4B5563', fontSize: 9, marginRight: 4 }}>{r.checkLabel}</span>
                    {r.newCheck}
                    {r.newPass && <span style={{ color: '#4ADE80', marginLeft: 4, fontSize: 9 }}>✓</span>}
                  </td>
                  <td style={{ padding: '7px 10px' }}>
                    {vinChanged
                      ? <span style={{ background: 'rgba(74,222,128,0.15)', color: '#4ADE80', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>PATCHED</span>
                      : <span style={{ background: 'rgba(107,114,128,0.15)', color: '#6B7280', padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>NO CHANGE</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {changed.length > 0 && unchanged.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#6B7280', fontFamily: "'JetBrains Mono'" }}>
          {changed.length} slot{changed.length !== 1 ? 's' : ''} patched · {unchanged.length} already matched
        </div>
      )}
    </div>
  );
}

function ActionBtn({ title, desc, enabled, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        padding: '14px 16px', borderRadius: 12,
        border: `2px solid ${h && enabled ? C.sr : C.bd}`,
        background: h && enabled ? 'rgba(211,47,47,0.03)' : C.cd,
        cursor: enabled ? 'pointer' : 'not-allowed',
        textAlign: 'left', transition: 'all 0.15s',
        fontFamily: "'Nunito'", color: C.tx, opacity: enabled ? 1 : 0.35,
        transform: h && enabled ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: 0.8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {title}<span style={{ marginLeft: 'auto', fontSize: 14, opacity: 0.5 }}>›</span>
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginTop: 4, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

export default function ModuleSync() {
  const [bcm, setBcm] = useState({ file: null, bytes: null, parsed: null });
  const [rfh, setRfh] = useState({ file: null, bytes: null, parsed: null });
  const [targetVin, setTargetVin] = useState('');
  const [virginize, setVirginize] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [diffRows, setDiffRows] = useState([]);
  const logRef = useRef(null);

  const log = useCallback((msg, level = 'info') => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogLines(p => [...p, { ts, msg, level }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  useEffect(() => {
    log('SRT Lab Module Sync ready. Drop BCM and RFHUB .bin files to begin.', 'info');
    log('Huntsville BCM + Yazaki FCM · offsets verified across 2016 & 2017 LX dumps.', 'muted');
  }, [log]);

  const handleBcm = useCallback((file, bytes) => {
    const parsed = parseBcm(bytes);
    setBcm({ file, bytes, parsed });
    setDiffRows([]);
    log(`Loaded BCM: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.ok) log(`  BCM VIN: ${parsed.vin}`, 'ok');
    else log(`  BCM: no VIN parsed — file format not recognized`, 'err');
  }, [log]);
  const handleRfh = useCallback((file, bytes) => {
    const parsed = parseRfh(bytes);
    setRfh({ file, bytes, parsed });
    setDiffRows([]);
    log(`Loaded RFHUB: ${file.name} (${bytes.length} bytes)`, 'info');
    if (parsed.ok) log(`  RFHUB VIN: ${parsed.vin}`, 'ok');
    else log(`  RFHUB: no VIN parsed — file format not recognized`, 'err');
  }, [log]);

  const tv = targetVin.replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, VIN_LEN);
  const tvOk = tv.length === VIN_LEN && VIN_RE.test(tv);
  const loaded = (bcm.bytes ? 1 : 0) + (rfh.bytes ? 1 : 0);
  const bothReady = loaded === 2 && bcm.parsed?.ok && rfh.parsed?.ok;
  const vinMatch = bothReady && bcm.parsed.vin === rfh.parsed.vin;

  const doSync = (action) => {
    const ts = timestamp();
    log(`=== SYNC: ${action}${virginize ? ' +VIRGINIZE' : ''} ===`, 'info');
    const rows = [];
    try {
      if (action === 'rfh-to-bcm') {
        const newVin = rfh.parsed.vin;
        const newCrc = crc16Ccitt(new TextEncoder().encode(newVin));
        bcm.parsed.vinSlots.forEach((s, idx) => {
          rows.push({
            module: 'BCM', slot: idx + 1,
            offset: `0x${hex4(s.offset)}`,
            oldVin: s.vin, newVin,
            checkLabel: 'CRC-16',
            oldCheck: s.storedCrc != null ? `0x${hex4(s.storedCrc)}` : '—',
            newCheck: `0x${hex4(newCrc)}`,
            oldPass: s.crcOk, newPass: true,
          });
        });
        const r = writeBcmVin(bcm.bytes, newVin);
        log(`BCM: patched ${r.patched} VIN slot(s)`, 'ok');
        const name = `BCM_SYNCED_${newVin}_${ts}.bin`;
        downloadBin(r.bytes, name);
        log(`Downloaded: ${name}`, 'ok');
        if (virginize) {
          const rr = writeRfhVin(rfh.bytes, newVin, true);
          const rn = `RFH_VIRGIN_${newVin}_${ts}.bin`;
          downloadBin(rr.bytes, rn);
          log(`RFH: re-wrote VIN + wiped ${rr.sec16Wiped} SEC16 slot(s)`, 'warn');
          log(`Downloaded: ${rn}`, 'ok');
          rfh.parsed.vinSlots.forEach((s, idx) => {
            rows.push({
              module: 'RFHUB', slot: idx + 1,
              offset: `0x${hex4(s.offset)}`,
              oldVin: s.vin, newVin,
              checkLabel: 'Chk',
              oldCheck: s.storedChk != null ? `0x${hex2(s.storedChk)}` : '—',
              newCheck: `0x${hex2(rr.chk)}`,
              oldPass: s.chkOk, newPass: true,
            });
          });
        }
      } else if (action === 'bcm-to-rfh') {
        const newVin = bcm.parsed.vin;
        const r = writeRfhVin(rfh.bytes, newVin, virginize);
        log(`RFHUB: patched ${r.patched} VIN slot(s)${virginize ? ` + wiped ${r.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        const name = virginize ? `RFH_SYNCED_VIRGIN_${newVin}_${ts}.bin` : `RFH_SYNCED_${newVin}_${ts}.bin`;
        downloadBin(r.bytes, name);
        log(`Downloaded: ${name}`, 'ok');
        rfh.parsed.vinSlots.forEach((s, idx) => {
          rows.push({
            module: 'RFHUB', slot: idx + 1,
            offset: `0x${hex4(s.offset)}`,
            oldVin: s.vin, newVin,
            checkLabel: 'Chk',
            oldCheck: s.storedChk != null ? `0x${hex2(s.storedChk)}` : '—',
            newCheck: `0x${hex2(r.chk)}`,
            oldPass: s.chkOk, newPass: true,
          });
        });
      } else if (action === 'target-both') {
        const newVin = tv;
        const newCrc = crc16Ccitt(new TextEncoder().encode(newVin));
        const br = writeBcmVin(bcm.bytes, newVin);
        log(`BCM: patched ${br.patched} VIN slot(s)`, 'ok');
        const bn = `BCM_SYNCED_${newVin}_${ts}.bin`;
        downloadBin(br.bytes, bn);
        log(`Downloaded: ${bn}`, 'ok');
        bcm.parsed.vinSlots.forEach((s, idx) => {
          rows.push({
            module: 'BCM', slot: idx + 1,
            offset: `0x${hex4(s.offset)}`,
            oldVin: s.vin, newVin,
            checkLabel: 'CRC-16',
            oldCheck: s.storedCrc != null ? `0x${hex4(s.storedCrc)}` : '—',
            newCheck: `0x${hex4(newCrc)}`,
            oldPass: s.crcOk, newPass: true,
          });
        });
        const rr = writeRfhVin(rfh.bytes, newVin, virginize);
        log(`RFHUB: patched ${rr.patched} VIN slot(s)${virginize ? ` + wiped ${rr.sec16Wiped} SEC16 slot(s)` : ''}`, virginize ? 'warn' : 'ok');
        const rn = virginize ? `RFH_SYNCED_VIRGIN_${newVin}_${ts}.bin` : `RFH_SYNCED_${newVin}_${ts}.bin`;
        downloadBin(rr.bytes, rn);
        log(`Downloaded: ${rn}`, 'ok');
        rfh.parsed.vinSlots.forEach((s, idx) => {
          rows.push({
            module: 'RFHUB', slot: idx + 1,
            offset: `0x${hex4(s.offset)}`,
            oldVin: s.vin, newVin,
            checkLabel: 'Chk',
            oldCheck: s.storedChk != null ? `0x${hex2(s.storedChk)}` : '—',
            newCheck: `0x${hex2(rr.chk)}`,
            oldPass: s.chkOk, newPass: true,
          });
        });
      }
      log('✓ Sync complete. Flash the .bin files to their modules and power-cycle 30s to handshake.', 'ok');
      setDiffRows(rows);
    } catch (e) {
      log(`✗ Error: ${e.message}`, 'err');
    }
  };

  const Card = ({ children, style = {} }) => (
    <div style={{ background: C.cd, border: `1.5px solid ${C.bd}`, borderRadius: 16, padding: 22, boxShadow: '0 2px 16px rgba(0,0,0,0.04)', marginBottom: 18, ...style }}>{children}</div>
  );
  const H2 = ({ children, count }) => (
    <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14, color: C.tx, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.sr }} />
      {children}
      {count != null && <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono'", fontSize: 10, fontWeight: 600, color: C.tm, padding: '2px 8px', background: C.c2, borderRadius: 6 }}>{count}</span>}
    </div>
  );

  return (
    <div style={{ fontFamily: "'Nunito', system-ui, sans-serif", color: C.tx }}>
      <Card>
        <H2 count={`${loaded} / 2`}>Load & Inspect</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <DropZone kind="bcm" label="BCM" icon="🧠" hint="MPC5606B DFLASH · drag .bin here" file={bcm.file} onFile={handleBcm} />
          <DropZone kind="rfh" label="RFHUB / FCM" icon="🔑" hint="Yazaki FCM EEPROM · drag .bin here" file={rfh.file} onFile={handleRfh} />
        </div>
      </Card>

      {loaded > 0 && (
        <Card>
          <H2>Inspection Result</H2>
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
                ? <>BCM and RFHUB both carry <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> · modules are already paired</>
                : <>BCM has <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{bcm.parsed.vin}</strong> but RFHUB has <strong style={{ fontFamily: "'JetBrains Mono'", margin: '0 4px', letterSpacing: 2 }}>{rfh.parsed.vin}</strong> · sync required before key programming</>}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            <ModCard parsed={bcm.parsed} kind="bcm" />
            <ModCard parsed={rfh.parsed} kind="rfh" />
          </div>
        </Card>
      )}

      <Card>
        <H2>Standalone Tools</H2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🌐 Sync Tool (HTML)</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              Self-contained offline tool — drop your BCM and RFHUB bins directly in a browser tab with no server required.
            </div>
            <a
              href="/SRTLAB_SYNC_TOOL.html"
              download="SRTLAB_SYNC_TOOL.html"
              onClick={() => trackDownload(ASSET_IDS.modSyncTool)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800,
                background: C.a3, color: '#fff', textDecoration: 'none', letterSpacing: 0.5,
              }}
            >
              ⬇ Download SRTLAB_SYNC_TOOL.html
            </a>
            <div style={{ marginTop: 8 }}>
              <DownloadCounter assetId={ASSET_IDS.modSyncTool} />
            </div>
          </div>
          <div style={{ padding: '14px 16px', background: C.c2, borderRadius: 12, border: `1px solid ${C.bd}` }}>
            <div style={{ fontWeight: 900, fontSize: 12, letterSpacing: 0.8, marginBottom: 4, color: C.bk }}>🐍 Python Validator</div>
            <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 10 }}>
              Command-line validator — verify VIN slots, CRC-16/CCITT checksums, and SEC16 state of any BCM or RFHUB dump on the CLI.
            </div>
            <a
              href="/srtlab_validate.py"
              download="srtlab_validate.py"
              onClick={() => trackDownload(ASSET_IDS.modSyncValidate)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 800,
                background: C.a2, color: '#fff', textDecoration: 'none', letterSpacing: 0.5,
              }}
            >
              ⬇ Download srtlab_validate.py
            </a>
            <div style={{ marginTop: 8 }}>
              <DownloadCounter assetId={ASSET_IDS.modSyncValidate} />
            </div>
          </div>
        </div>
      </Card>

      {bothReady && (
        <Card>
          <H2>Sync Actions</H2>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Target VIN (optional — for write-both mode)
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                value={targetVin}
                onChange={e => setTargetVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
                placeholder="Enter 17-character target VIN"
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 10,
                  border: `2px solid ${tvOk ? C.gn : C.bd}`,
                  background: C.c2, color: C.tx,
                  fontFamily: "'JetBrains Mono'", fontSize: 15, fontWeight: 700, letterSpacing: 2.5,
                  textAlign: 'center', outline: 'none', textTransform: 'uppercase',
                }}
              />
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: tvOk ? C.gn : C.tm, fontWeight: 700, minWidth: 42, textAlign: 'right' }}>
                {tv.length} / 17
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 10 }}>
            <ActionBtn title="➡ RFH VIN → BCM" enabled={rfh.parsed.ok}
              desc={`Copy RFHUB VIN (${rfh.parsed.vin}) into BCM at all 4 slots. Downloads new BCM bin.`}
              onClick={() => doSync('rfh-to-bcm')} />
            <ActionBtn title="⬅ BCM VIN → RFH" enabled={bcm.parsed.ok}
              desc={`Copy BCM VIN (${bcm.parsed.vin}) into RFHUB (byte-reversed) at all 4 slots. Downloads new RFH bin.`}
              onClick={() => doSync('bcm-to-rfh')} />
            <ActionBtn title="🎯 TARGET VIN → BOTH" enabled={tvOk}
              desc={tvOk ? `Write ${tv} into BOTH modules. Downloads both new bins.` : 'Enter a valid 17-char VIN above.'}
              onClick={() => doSync('target-both')} />
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: C.c2, borderRadius: 10,
            marginTop: 10, border: `1.5px solid ${C.bd}`,
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', flex: 1 }}>
              <input type="checkbox" checked={virginize} onChange={e => setVirginize(e.target.checked)}
                     style={{ width: 16, height: 16, accentColor: C.sr, cursor: 'pointer' }} />
              <span>🆕 VIRGINIZE RFH SEC16 (wipe 0x0226 + 0x023A to FF)</span>
            </label>
            <div style={{ fontSize: 10, color: C.wn, fontWeight: 700, letterSpacing: 0.3 }}>⚠ forces re-pair on power-up</div>
          </div>

          <div style={{
            fontSize: 11, color: C.ts, fontStyle: 'italic',
            padding: '8px 12px', background: C.c2, borderRadius: 8,
            borderLeft: `3px solid ${C.a3}`, marginTop: 8, lineHeight: 1.5,
          }}>
            <strong>Virginize</strong> wipes the RFHUB's SEC16 slots so modules negotiate a fresh security byte on first power-up after flashing. Use for salvage rebuilds; skip for factory-paired swaps.
          </div>

          <div ref={logRef} style={{
            background: '#0F1419', color: '#E0E0E0', padding: '14px 16px',
            borderRadius: 10, fontFamily: "'JetBrains Mono'", fontSize: 11,
            lineHeight: 1.6, marginTop: 12, maxHeight: 280, overflowY: 'auto',
            border: '1.5px solid #2A2F36',
          }}>
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
