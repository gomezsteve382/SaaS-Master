/**
 * Hitag2Tab.jsx — HITAG 2 / PCF7945/53 Key Tool
 *
 * Dedicated tab for HITAG 2 transponder work on FCA/Mopar vehicles (2011–2019
 * Charger, Challenger, Durango, etc. running PCF7945 or PCF7953 chips).
 *
 * Features:
 *   • Photo OCR — upload an Autel/VVDI Prog screen shot; AI extracts all fields
 *   • Manual entry — Chip ID, Low SK (4 bytes), High SK (2 bytes), Config page,
 *     Page 0–3 from the Chip data section
 *   • 6-byte SK derivation — page1 ∥ high word of page2 → displayed as the
 *     48-bit HITAG2 crypto key the VVDI Prog "Calculate SK" step produces
 *   • VVDI Write Helper — formats Low SK and High SK exactly as VVDI Prog expects
 *     with one-click copy buttons
 *   • Chip status analysis — BLANK / MIKRON_DEFAULT / PROGRAMMED / LOCKED
 *   • Blank key reference storage — save a confirmed-blank read to localStorage
 *     and compare future reads against it
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import VehicleYearGuard from '../components/VehicleYearGuard.jsx';

/* ─── blank reference storage (same pattern as HitagAesTab) ─── */
const BLANK_REFS_KEY = 'srt-lab.hitag2.blank-refs.v1';
function loadBlankRefs() {
  try {
    const raw = localStorage.getItem(BLANK_REFS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveBlankRef(entry) {
  const refs = loadBlankRefs().filter(r => r.chipId !== entry.chipId);
  refs.unshift({ ...entry, savedAt: Date.now() });
  localStorage.setItem(BLANK_REFS_KEY, JSON.stringify(refs.slice(0, 20)));
}
function removeBlankRef(chipId) {
  const refs = loadBlankRefs().filter(r => r.chipId !== chipId);
  localStorage.setItem(BLANK_REFS_KEY, JSON.stringify(refs));
}

/* ─── helpers ─── */
function normHex(v, len = 8) {
  if (!v) return '';
  const h = v.replace(/\s/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(h)) return '';
  return h.padStart(len, '0').slice(-len);
}

/** Derive HITAG2 6-byte SK: page1 (4 bytes) ∥ high word of page2 (2 bytes) */
function deriveHitag2SK(page1Hex, page2Hex) {
  const p1 = normHex(page1Hex, 8);
  const p2 = normHex(page2Hex, 8);
  if (!p1 || !p2) return null;
  // High word = first 4 hex chars (bytes 0–1) of page2
  const highWord = p2.slice(0, 4);
  return p1 + highWord; // 12 hex chars = 6 bytes
}

/** Split 6-byte SK into VVDI Prog Low SK (4 bytes) and High SK (2 bytes) */
function splitSkForVvdi(sk12) {
  if (!sk12 || sk12.length < 12) return { lowSk: '', highSk: '' };
  return {
    lowSk: sk12.slice(0, 8),   // 4 bytes
    highSk: sk12.slice(8, 12), // 2 bytes
  };
}

/* ─── known HITAG 2 patterns ─── */
const MIKRON_DEFAULT_SK = '4F4E4D494B52'; // universal default SK
const FACTORY_PAGE0     = 'AABBCCDD';     // factory blank Page 0
const FACTORY_PAGE1     = '00000000';     // factory blank Page 1 (pre-program)
const FACTORY_CONFIG    = '08AA4854';     // typical factory config word

function classifyHitag2({ chipId, lowSk, highSk, configPage, page0, page1, page2, page3 }) {
  const sk6 = deriveHitag2SK(page1, page2);
  const fullSk = (normHex(lowSk, 8) + normHex(highSk, 4)).toUpperCase();

  const isMikronDefault = fullSk === MIKRON_DEFAULT_SK || sk6 === MIKRON_DEFAULT_SK;
  const isFactoryPage0  = normHex(page0, 8) === FACTORY_PAGE0;
  const isFactoryPage1  = normHex(page1, 8) === FACTORY_PAGE1;

  // Lock bit: bit 0 of config byte 0 (first byte of configPage)
  const cfgByte0 = configPage ? parseInt(configPage.slice(0, 2), 16) : 0;
  const isLocked = !isNaN(cfgByte0) && (cfgByte0 & 0x01) !== 0;

  if (isLocked) {
    return { status: 'LOCKED', color: C.er, label: 'LOCKED', detail: 'Lock bit set — chip cannot be rewritten' };
  }
  if (isMikronDefault && isFactoryPage0 && isFactoryPage1) {
    return { status: 'BLANK', color: C.ok, label: 'BLANK', detail: 'Factory default — never programmed (Mikron default SK, factory Page 0/1)' };
  }
  if (isMikronDefault) {
    return { status: 'MIKRON_DEFAULT', color: '#F59E0B', label: 'MIKRON DEFAULT', detail: 'Universal default SK (4F4E4D494B52) — not yet personalized to a vehicle' };
  }
  if (!page1 || normHex(page1, 8) === '00000000') {
    return { status: 'BLANK', color: C.ok, label: 'BLANK', detail: 'Page 1 is zero — chip appears unprogrammed' };
  }
  return { status: 'PROGRAMMED', color: '#6366F1', label: 'PROGRAMMED', detail: 'Vehicle secret written — key is paired to a vehicle' };
}

/* ─── copy to clipboard helper ─── */
function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = useCallback((text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    });
  }, []);
  return { copy, copied };
}

/* ─── blank ref row component ─── */
function BlankRefRow({ entry, onDelete }) {
  const { copy, copied } = useCopy();
  const sk6 = deriveHitag2SK(entry.page1, entry.page2);
  return (
    <div style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', marginBottom: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: C.ok, fontWeight: 700, fontFamily: 'monospace' }}>{entry.chipId}</span>
        <span style={{ color: '#666', fontSize: 10 }}>{new Date(entry.savedAt).toLocaleDateString()}</span>
      </div>
      <div style={{ color: '#aaa', marginTop: 4 }}>
        Low SK: <span style={{ color: '#fff', fontFamily: 'monospace' }}>{entry.lowSk}</span>
        {'  '}High SK: <span style={{ color: '#fff', fontFamily: 'monospace' }}>{entry.highSk}</span>
        {sk6 && <> {'  '}6-byte SK: <span style={{ color: '#60A5FA', fontFamily: 'monospace' }}>{sk6}</span></>}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        {sk6 && (
          <Btn onClick={() => copy(sk6, 'sk6-' + entry.chipId)} style={{ fontSize: 10, padding: '3px 8px' }}>
            {copied === 'sk6-' + entry.chipId ? '✓ Copied' : 'Copy 6-byte SK'}
          </Btn>
        )}
        <Btn onClick={() => onDelete(entry.chipId)} color={C.er} outline style={{ fontSize: 10, padding: '3px 8px' }}>
          Remove
        </Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Main component
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function Hitag2Tab({ vehicle }) {
  /* ── field state ── */
  const [chipId,     setChipId]     = useState('437C2C9F');
  const [lowSk,      setLowSk]      = useState('4D494B52');
  const [highSk,     setHighSk]     = useState('4F4E');
  const [configPage, setConfigPage] = useState('08AA4854');
  const [page0,      setPage0]      = useState('AABBCCDD');
  const [page1,      setPage1]      = useState('50207755');
  const [page2,      setPage2]      = useState('00000000');
  const [page3,      setPage3]      = useState('FF6CEA60');

  /* ── photo upload state ── */
  const [photoBusy,    setPhotoBusy]    = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [uploadMsg,    setUploadMsg]    = useState('');
  const [uploadErr,    setUploadErr]    = useState('');
  const [ocrRaw,       setOcrRaw]       = useState(null);
  const photoInputRef = useRef(null);

  /* ── blank refs state ── */
  const [blankRefs, setBlankRefs] = useState(() => loadBlankRefs());

  /* ── copy helper ── */
  const { copy, copied } = useCopy();

  /* ── derived values ── */
  const sk6 = useMemo(() => deriveHitag2SK(page1, page2), [page1, page2]);
  const vvdiLowSk  = sk6 ? sk6.slice(0, 8) : normHex(lowSk, 8);
  const vvdiHighSk = sk6 ? sk6.slice(8, 12) : normHex(highSk, 4);
  const analysis   = useMemo(() => classifyHitag2({ chipId, lowSk, highSk, configPage, page0, page1, page2, page3 }), [chipId, lowSk, highSk, configPage, page0, page1, page2, page3]);

  /* ── photo upload handler ── */
  const handlePhotoFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setUploadErr('Please upload an image file (PNG, JPG, etc.)');
      return;
    }
    setPhotoBusy(true);
    setUploadMsg('');
    setUploadErr('');
    setOcrRaw(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setPhotoPreview(ev.target.result);
      try {
        const formData = new FormData();
        formData.append('photo', file);
        const res = await fetch('/api/anthropic/key-photo', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Populate fields from OCR result
        if (data.chipId)         setChipId(data.chipId);
        if (data.chipInfoLowSK)  setLowSk(data.chipInfoLowSK);
        if (data.chipInfoHighSK) setHighSk(data.chipInfoHighSK.slice(0, 4)); // keep 2 bytes
        if (data.configPage)     setConfigPage(data.configPage);
        if (data.page0)          setPage0(data.page0);
        if (data.page1)          setPage1(data.page1);
        if (data.page2)          setPage2(data.page2);
        if (data.page3)          setPage3(data.page3);

        // Fallback: use paramLowSK / paramHighSK if chipInfo not available
        if (!data.chipInfoLowSK && data.paramLowSK) setLowSk(data.paramLowSK);
        if (!data.chipInfoHighSK && data.paramHighSK) setHighSk(data.paramHighSK.slice(0, 4));

        setOcrRaw(data);
        const filled = [data.chipId, data.chipInfoLowSK, data.chipInfoHighSK, data.page1, data.page2].filter(Boolean).length;
        setUploadMsg(`✓ OCR complete — ${filled} fields populated`);
      } catch (err) {
        setUploadErr(`OCR failed: ${err.message}`);
      } finally {
        setPhotoBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePhotoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handlePhotoFile(file);
  }, [handlePhotoFile]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handlePhotoFile(file);
  }, [handlePhotoFile]);

  /* ── save blank ref ── */
  const handleSaveBlankRef = useCallback(() => {
    const entry = { chipId: normHex(chipId, 8) || chipId, lowSk: normHex(lowSk, 8), highSk: normHex(highSk, 4), configPage: normHex(configPage, 8), page0: normHex(page0, 8), page1: normHex(page1, 8), page2: normHex(page2, 8), page3: normHex(page3, 8) };
    saveBlankRef(entry);
    setBlankRefs(loadBlankRefs());
  }, [chipId, lowSk, highSk, configPage, page0, page1, page2, page3]);

  const handleDeleteBlankRef = useCallback((id) => {
    removeBlankRef(id);
    setBlankRefs(loadBlankRefs());
  }, []);

  /* ── styles ── */
  const inputStyle = { background: '#1e2230', border: '1px solid #3a4060', color: '#e8eaf6', fontFamily: 'monospace', fontSize: 13, padding: '5px 8px', borderRadius: 4, width: '100%', boxSizing: 'border-box' };
  const labelStyle = { color: '#888', fontSize: 11, marginBottom: 3, display: 'block', textTransform: 'uppercase', letterSpacing: 1 };
  const fieldRow   = { marginBottom: 12 };

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <VehicleYearGuard vehicle={vehicle || null} />
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>
          🔑 HITAG 2 — PCF7945/53 Key Tool
        </div>
        <div style={{ color: '#aaa', fontSize: 12, marginTop: 2 }}>
          FCA/Mopar 2011–2019 · FOBIK transponder · 6-byte SK · VVDI Prog write helper
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* LEFT — Photo OCR + Manual Input */}
        <div>
          {/* Photo Upload */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>
              📷 UPLOAD AUTEL/VVDI SCREEN PHOTO
            </div>
            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => photoInputRef.current?.click()}
              style={{
                border: '2px dashed #444', borderRadius: 8, padding: '20px 12px',
                textAlign: 'center', cursor: 'pointer', background: '#0d0d0d',
                transition: 'border-color 0.2s',
              }}
            >
              {photoBusy ? (
                <div style={{ color: '#60A5FA', fontSize: 13 }}>⏳ AI reading photo…</div>
              ) : photoPreview ? (
                <img src={photoPreview} alt="preview" style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 4, objectFit: 'contain' }} />
              ) : (
                <div style={{ color: '#666', fontSize: 13 }}>
                  Drop Autel/VVDI Prog screenshot here<br />
                  <span style={{ fontSize: 11, color: '#444' }}>or click to browse</span>
                </div>
              )}
            </div>
            <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoUpload} />
            {uploadMsg && <div style={{ color: C.ok, fontSize: 12, marginTop: 8 }}>{uploadMsg}</div>}
            {uploadErr && <div style={{ color: C.er, fontSize: 12, marginTop: 8 }}>{uploadErr}</div>}

            {/* OCR Raw Extract */}
            {ocrRaw && (
              <div style={{ marginTop: 12, background: '#050505', border: '1px solid #222', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>AI OCR EXTRACT</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', fontSize: 11, fontFamily: 'monospace' }}>
                  {[
                    ['Chip Type',   ocrRaw.chipType],
                    ['Chip ID',     ocrRaw.chipId],
                    ['Param Low SK',ocrRaw.paramLowSK],
                    ['Param High SK',ocrRaw.paramHighSK],
                    ['Info Low SK', ocrRaw.chipInfoLowSK],
                    ['Info High SK',ocrRaw.chipInfoHighSK],
                    ['Config Page', ocrRaw.configPage],
                    ['Page 0',      ocrRaw.page0],
                    ['Page 1',      ocrRaw.page1],
                    ['Page 2',      ocrRaw.page2],
                    ['Page 3',      ocrRaw.page3],
                    ['HITAG2 SK',   ocrRaw.hitag2FullSK],
                  ].map(([k, v]) => v ? (
                    <div key={k} style={{ color: '#888' }}>
                      <span style={{ color: '#555' }}>{k}: </span>
                      <span style={{ color: '#60A5FA' }}>{v}</span>
                    </div>
                  ) : null)}
                </div>
                {ocrRaw.notes && <div style={{ color: '#666', fontSize: 10, marginTop: 6, fontStyle: 'italic' }}>{ocrRaw.notes}</div>}
              </div>
            )}
          </Card>

          {/* Manual Input */}
          <Card>
            <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>
              ✏️ CHIP DATA (MANUAL / OCR AUTO-FILLED)
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
              <div style={fieldRow}>
                <label style={labelStyle}>Chip ID</label>
                <input style={inputStyle} value={chipId} onChange={e => setChipId(e.target.value.toUpperCase())} maxLength={8} placeholder="437C2C9F" />
              </div>
              <div style={fieldRow}>
                <label style={labelStyle}>Config Page</label>
                <input style={inputStyle} value={configPage} onChange={e => setConfigPage(e.target.value.toUpperCase())} maxLength={8} placeholder="08AA4854" />
              </div>
              <div style={fieldRow}>
                <label style={labelStyle}>Low SK (4 bytes)</label>
                <input style={inputStyle} value={lowSk} onChange={e => setLowSk(e.target.value.toUpperCase())} maxLength={8} placeholder="4D494B52" />
              </div>
              <div style={fieldRow}>
                <label style={labelStyle}>High SK (2 bytes)</label>
                <input style={inputStyle} value={highSk} onChange={e => setHighSk(e.target.value.toUpperCase())} maxLength={4} placeholder="4F4E" />
              </div>
            </div>

            <div style={{ fontWeight: 700, color: '#555', fontSize: 10, margin: '8px 0 8px', letterSpacing: 1 }}>CHIP DATA PAGES</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
              {[['Page 0', page0, setPage0], ['Page 1', page1, setPage1], ['Page 2', page2, setPage2], ['Page 3', page3, setPage3]].map(([label, val, setter]) => (
                <div key={label} style={fieldRow}>
                  <label style={labelStyle}>{label}</label>
                  <input style={inputStyle} value={val} onChange={e => setter(e.target.value.toUpperCase())} maxLength={8} placeholder="00000000" />
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* RIGHT — Analysis + VVDI Helper */}
        <div>
          {/* Chip Status */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>
              🔍 CHIP STATUS
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{
                background: analysis.color + '22', border: `2px solid ${analysis.color}`,
                borderRadius: 8, padding: '10px 20px', fontSize: 16, fontWeight: 900,
                color: analysis.color, letterSpacing: 2, fontFamily: 'monospace',
              }}>
                {analysis.label}
              </div>
              <div style={{ color: '#888', fontSize: 12, flex: 1 }}>{analysis.detail}</div>
            </div>

            {/* SK Derivation */}
            <div style={{ background: '#0a0a0a', border: '1px solid #222', borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>6-BYTE SK DERIVATION (page1 ∥ high word of page2)</div>
              <div style={{ fontFamily: 'monospace', fontSize: 14 }}>
                <span style={{ color: '#60A5FA' }}>{normHex(page1, 8) || '????????'}</span>
                <span style={{ color: '#555' }}> ∥ </span>
                <span style={{ color: '#A78BFA' }}>{normHex(page2, 8) ? normHex(page2, 8).slice(0, 4) : '????'}</span>
                <span style={{ color: '#555' }}> = </span>
                <span style={{ color: sk6 ? '#34D399' : '#555', fontWeight: 700 }}>{sk6 || '——'}</span>
              </div>
              {sk6 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                  <Btn onClick={() => copy(sk6, 'sk6')} style={{ fontSize: 11, padding: '4px 10px' }}>
                    {copied === 'sk6' ? '✓ Copied' : 'Copy 6-byte SK'}
                  </Btn>
                </div>
              )}
            </div>

            {/* MIKRON default check */}
            {sk6 && (
              <div style={{ fontSize: 12, color: sk6 === MIKRON_DEFAULT_SK ? '#F59E0B' : '#555' }}>
                {sk6 === MIKRON_DEFAULT_SK
                  ? '⚠️ Matches universal Mikron default (4F4E4D494B52) — not yet personalized'
                  : '✓ SK is unique (not Mikron default)'}
              </div>
            )}
          </Card>

          {/* VVDI Write Helper */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>
              🖊️ VVDI PROG WRITE HELPER
            </div>
            <div style={{ color: '#666', fontSize: 11, marginBottom: 10 }}>
              Enter these values in VVDI Prog → HITAG 2 → Chip info → Write
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {/* Low SK */}
              <div style={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>LOW SK (4 bytes)</div>
                <div style={{ fontFamily: 'monospace', fontSize: 16, color: '#60A5FA', fontWeight: 700, marginBottom: 6 }}>
                  {vvdiLowSk || '????????'}
                </div>
                <Btn onClick={() => copy(vvdiLowSk, 'lowsk')} disabled={!vvdiLowSk} style={{ fontSize: 11, padding: '4px 10px', width: '100%' }}>
                  {copied === 'lowsk' ? '✓ Copied' : 'Copy Low SK'}
                </Btn>
              </div>

              {/* High SK */}
              <div style={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>HIGH SK (2 bytes)</div>
                <div style={{ fontFamily: 'monospace', fontSize: 16, color: '#A78BFA', fontWeight: 700, marginBottom: 6 }}>
                  {vvdiHighSk || '????'}
                </div>
                <Btn onClick={() => copy(vvdiHighSk, 'highsk')} disabled={!vvdiHighSk} style={{ fontSize: 11, padding: '4px 10px', width: '100%' }}>
                  {copied === 'highsk' ? '✓ Copied' : 'Copy High SK'}
                </Btn>
              </div>
            </div>

            {/* Full 6-byte SK as single copy */}
            {sk6 && (
              <div style={{ marginTop: 10, background: '#050505', border: '1px solid #222', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>FULL 6-BYTE SK (for Autel / Tango)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 14, color: '#34D399', fontWeight: 700, flex: 1 }}>{sk6}</span>
                  <Btn onClick={() => copy(sk6, 'full6')} style={{ fontSize: 11, padding: '4px 10px' }}>
                    {copied === 'full6' ? '✓ Copied' : 'Copy'}
                  </Btn>
                </div>
              </div>
            )}

            {/* Copy for Autel IM608 — space-separated byte pairs */}
            {sk6 && (() => {
              const autelFmt = sk6.match(/.{2}/g).join(' ');
              return (
                <div style={{ marginTop: 10, background: '#050505', border: '1px solid #1a3a1a', borderRadius: 6, padding: 10 }}>
                  <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>AUTEL IM608 FORMAT (space-separated bytes)</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 14, color: '#4ADE80', fontWeight: 700, flex: 1, letterSpacing: 2 }}>{autelFmt}</span>
                    <Btn onClick={() => copy(autelFmt, 'autel')} style={{ fontSize: 11, padding: '4px 10px', background: '#14532d', borderColor: '#166534' }}>
                      {copied === 'autel' ? '✓ Copied for Autel' : '📋 Copy for Autel'}
                    </Btn>
                  </div>
                  <div style={{ color: '#555', fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
                    Paste into Autel IM608 → HITAG 2 → Write → SK field exactly as shown.
                  </div>
                </div>
              );
            })()}

            {/* Config page copy */}
            {normHex(configPage, 8) && (
              <div style={{ marginTop: 10, background: '#050505', border: '1px solid #222', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>CONFIG PAGE</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 14, color: '#F59E0B', fontWeight: 700, flex: 1 }}>{normHex(configPage, 8)}</span>
                  <Btn onClick={() => copy(normHex(configPage, 8), 'cfg')} style={{ fontSize: 11, padding: '4px 10px' }}>
                    {copied === 'cfg' ? '✓ Copied' : 'Copy'}
                  </Btn>
                </div>
              </div>
            )}

            {/* Chip ID */}
            {normHex(chipId, 8) && (
              <div style={{ marginTop: 10, background: '#050505', border: '1px solid #222', borderRadius: 6, padding: 10 }}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>CHIP ID / UID</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 14, color: '#E879F9', fontWeight: 700, flex: 1 }}>{normHex(chipId, 8)}</span>
                  <Btn onClick={() => copy(normHex(chipId, 8), 'cid')} style={{ fontSize: 11, padding: '4px 10px' }}>
                    {copied === 'cid' ? '✓ Copied' : 'Copy'}
                  </Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Blank Key Reference */}
          <Card>
            <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>
              💾 BLANK KEY REFERENCES
            </div>
            <div style={{ color: '#666', fontSize: 11, marginBottom: 10 }}>
              Save a confirmed-blank chip read as a reference to compare future reads against.
            </div>
            <Btn onClick={handleSaveBlankRef} style={{ marginBottom: 12, fontSize: 12 }}>
              Save Current Read as Blank Reference
            </Btn>
            {blankRefs.length === 0 ? (
              <div style={{ color: '#444', fontSize: 12, fontStyle: 'italic' }}>No blank references saved yet.</div>
            ) : (
              blankRefs.map(ref => (
                <BlankRefRow key={ref.chipId} entry={ref} onDelete={handleDeleteBlankRef} />
              ))
            )}
          </Card>
        </div>
      </div>

      {/* Chip type info banner */}
      <Card style={{ marginTop: 16, background: '#0a0a0a' }}>
        <div style={{ fontWeight: 700, color: '#aaa', fontSize: 11, marginBottom: 8, letterSpacing: 1 }}>
          ℹ️ HITAG 2 CHIP REFERENCE
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 11 }}>
          <div>
            <div style={{ color: '#60A5FA', fontWeight: 700, marginBottom: 4 }}>Chip Family</div>
            <div style={{ color: '#aaa' }}>PCF7945 / PCF7953 (HITAG 2)</div>
            <div style={{ color: '#666' }}>FCA/Mopar FOBIK 2011–2019</div>
          </div>
          <div>
            <div style={{ color: '#60A5FA', fontWeight: 700, marginBottom: 4 }}>SK Format</div>
            <div style={{ color: '#aaa' }}>6 bytes (48-bit)</div>
            <div style={{ color: '#666' }}>page1 (4B) ∥ page2 high word (2B)</div>
          </div>
          <div>
            <div style={{ color: '#60A5FA', fontWeight: 700, marginBottom: 4 }}>Blank Key Part</div>
            <div style={{ color: '#aaa' }}>PCF7945/53 blank</div>
            <div style={{ color: '#666' }}>Autel IKEY CHRYAK01 · VVDI Super Chip</div>
          </div>
          <div>
            <div style={{ color: '#F59E0B', fontWeight: 700, marginBottom: 4 }}>Mikron Default SK</div>
            <div style={{ color: '#aaa', fontFamily: 'monospace' }}>4F4E4D494B52</div>
            <div style={{ color: '#666' }}>Universal factory default — not vehicle-specific</div>
          </div>
          <div>
            <div style={{ color: '#F59E0B', fontWeight: 700, marginBottom: 4 }}>Factory Page 0</div>
            <div style={{ color: '#aaa', fontFamily: 'monospace' }}>AABBCCDD</div>
            <div style={{ color: '#666' }}>Typical blank chip Page 0 pattern</div>
          </div>
          <div>
            <div style={{ color: '#EF4444', fontWeight: 700, marginBottom: 4 }}>⚠️ AES Variant</div>
            <div style={{ color: '#aaa' }}>2020+ Redeye uses PCF7939FA</div>
            <div style={{ color: '#666' }}>Use HITAG KEY READER tab for AES chips</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
