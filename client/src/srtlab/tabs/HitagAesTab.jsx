/**
 * HitagAesTab.jsx — HITAG AES / PCF7953 Key Status Reader
 *
 * Paste or type the raw Autel/VVDI page read output (SK0–SK3, Config,
 * Page 1, Page 2, Chip ID) and get an instant FCA-specific verdict:
 *   • BLANK  — factory default test pattern, never programmed
 *   • PROGRAMMED — vehicle secret written, key is paired
 *   • LOCKED — lock bit set, cannot be rewritten
 *   • MIKRON_DEFAULT — universal default SK
 *   • KNOWN_GOOD — matches a bench-verified working key
 *   • UNKNOWN — unrecognized pattern
 *
 * Also decodes:
 *   • Vehicle secret (SK0–SK3 → 16-byte AES root key)
 *   • FOBIK UID (Chip ID)
 *   • Lock bits from Config word
 *   • Page 1/2/3 SK derivation (HITAG2 6-byte SK = page1 ∥ high(page2))
 *   • Cross-reference against known working keys
 *
 * "Save as Blank Key Reference" — stores the current chip read as a
 * confirmed-blank reference in localStorage (srt-lab.hitag.blank-refs.v1)
 * so you can compare future reads against known-blank profiles.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Card, Btn, Tag } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { KNOWN_WORKING_KEYS, HITAG_AES_BLACK_VIRGIN_PROFILE, lookupChipReadByChipId } from '../lib/keyWriter/knownWorkingKeys.js';
import { addVirginizeLogEntry } from '../lib/virginizeLog.js';
import VirginizeLogPanel from '../components/VirginizeLogPanel.jsx';
import VehicleYearGuard from '../components/VehicleYearGuard.jsx';

/* ─── blank reference storage ─── */
const BLANK_REFS_KEY = 'srt-lab.hitag.blank-refs.v1';

function loadBlankRefs() {
  try {
    const raw = localStorage.getItem(BLANK_REFS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBlankRef(entry) {
  const refs = loadBlankRefs();
  // Deduplicate by chipId — keep the newest
  const filtered = refs.filter(r => r.chipId !== entry.chipId);
  filtered.unshift(entry);
  // Keep at most 50 entries
  localStorage.setItem(BLANK_REFS_KEY, JSON.stringify(filtered.slice(0, 50)));
  return filtered.slice(0, 50);
}

function removeBlankRef(chipId) {
  const refs = loadBlankRefs().filter(r => r.chipId !== chipId);
  localStorage.setItem(BLANK_REFS_KEY, JSON.stringify(refs));
  return refs;
}

/* ─── helpers ─── */
function normHex(s) {
  return String(s == null ? '' : s).replace(/^0x/i, '').replace(/[\s:_\-]/g, '').toUpperCase();
}
function isAllZero(h) { return /^0+$/.test(h); }
function isAllFF(h)   { return /^F+$/.test(h); }
function hexToBytes(h) {
  const n = normHex(h);
  const out = [];
  for (let i = 0; i < n.length; i += 2) out.push(parseInt(n.slice(i, i + 2), 16));
  return out;
}
function bytesToHex(arr) {
  return arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/* Factory blank test pattern — Autel shows this on a never-programmed FCA key */
function isBlankPattern(sk0, sk1, sk2, sk3) {
  return normHex(sk0) === '11112222' &&
         normHex(sk1) === '33334444' &&
         normHex(sk2) === '55556666' &&
         normHex(sk3) === '77778888';
}

/* Config word bit decode */
function decodeConfig(configHex) {
  const h = normHex(configHex);
  if (h.length < 8) return null;
  const word = parseInt(h, 16);
  return {
    lockBit:   !!(word & 0x80000000),
    aesEnable: !!(word & 0x00000008),
    raw: h,
    word,
  };
}

/* Derive HITAG2 6-byte SK from page1 ∥ high word of page2 */
function deriveHitag2SK(page1Hex, page2Hex) {
  const p1 = normHex(page1Hex);
  const p2 = normHex(page2Hex);
  if (p1.length < 8 || p2.length < 8) return null;
  return (p1 + p2.slice(0, 4)).toUpperCase();
}

/* Build 16-byte AES vehicle secret from SK0–SK3 */
function buildAesSecret(sk0, sk1, sk2, sk3) {
  const parts = [sk0, sk1, sk2, sk3].map(normHex);
  if (parts.some(p => p.length !== 8)) return null;
  return parts.join('');
}

/* Check if SK0–SK3 match a known working key's AES secret */
function crossRefKnownKeys(aesSecret) {
  if (!aesSecret) return null;
  for (const k of KNOWN_WORKING_KEYS) {
    if (!k.profile) continue;
    const kSecret = buildAesSecret(
      k.profile.page0 || '00000000',
      k.profile.page1 || '00000000',
      k.profile.page2 || '00000000',
      k.profile.page3 || '00000000',
    );
    if (kSecret && kSecret === aesSecret) return k;
  }
  return null;
}

/* ─── status verdict ─── */
function analyzeKey({ chipId, sk0, sk1, sk2, sk3, config, page1, page2 }) {
  const cfg = decodeConfig(config);
  const locked = cfg?.lockBit || false;

  if (locked) {
    return { status: 'LOCKED', color: C.er, emoji: '🔒', label: 'LOCKED', bg: '#FFEBEE',
      detail: 'Lock bit is set. This chip cannot be rewritten by VVDI Mini or Tango. Use a blank key.' };
  }

  if (isBlankPattern(sk0, sk1, sk2, sk3)) {
    return { status: 'BLANK', color: C.gn, emoji: '✅', label: 'BLANK — READY TO PROGRAM', bg: '#E8F5E9',
      detail: 'Factory default test pattern confirmed. This key has never been programmed. Safe to use for key-learn.' };
  }

  const aesSecret = buildAesSecret(sk0, sk1, sk2, sk3);
  const allZero = aesSecret && isAllZero(aesSecret);
  const allFF   = aesSecret && isAllFF(aesSecret);

  if (allZero || allFF) {
    return { status: 'ERASED', color: C.wn, emoji: '⚠️', label: 'ERASED / VIRGIN', bg: '#FFF8E1',
      detail: 'All SK pages are zero/FF — key was erased or never written. Treat as blank.' };
  }

  /* MIKRON universal default */
  const hitag2SK = deriveHitag2SK(sk0, sk1);
  if (hitag2SK === '4F4E4D494B52') {
    return { status: 'MIKRON_DEFAULT', color: C.wn, emoji: '⚠️', label: 'MIKRON DEFAULT SK', bg: '#FFF8E1',
      detail: 'Key carries the universal MIKRON default SK (4F4E4D494B52). Generic unpaired state — not paired to a specific vehicle.' };
  }

  const knownMatch = crossRefKnownKeys(aesSecret);
  if (knownMatch) {
    return { status: 'KNOWN_GOOD', color: C.gn, emoji: '🏆', label: 'KNOWN WORKING KEY', bg: '#E8F5E9',
      detail: `Matches confirmed working key: ${knownMatch.vehicle} (UID ${knownMatch.keyId}). This key is paired and starts the car.`,
      knownKey: knownMatch };
  }

  return { status: 'PROGRAMMED', color: C.a2, emoji: '🔑', label: 'PROGRAMMED — VEHICLE PAIRED', bg: '#E3F2FD',
    detail: "SK pages contain a vehicle-specific secret. This key is paired to a vehicle. If it doesn't work, the RFHUB/BCM SEC16 may not match." };
}

/* ─── field input ─── */
function HexField({ label, value, onChange, placeholder, mono = true }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 3 }}>
        {label}
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '00000000'}
        style={{
          width: '100%', padding: '8px 10px', borderRadius: 8, border: `1.5px solid ${C.bd}`,
          background: '#FAFAF8', fontFamily: mono ? "'JetBrains Mono', monospace" : undefined,
          fontSize: 12, color: C.t, outline: 'none', boxSizing: 'border-box',
        }}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}

/* ─── decoded row ─── */
function DecodedRow({ label, value, mono, color, highlight, note }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 0', borderBottom: `1px solid ${C.bd}22` }}>
      <div style={{ fontSize: 10, color: C.ts, fontWeight: 700, minWidth: 160, flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: 11, color: color || highlight || C.t, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined, textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
        {note && <div style={{ fontSize: 10, color: C.wn, marginTop: 2 }}>{note}</div>}
      </div>
    </div>
  );
}

/* ─── blank reference card ─── */
function BlankRefCard({ ref: entry, onLoad, onDelete }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${C.gn}44`,
      background: '#F1FBF4', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.t, fontFamily: "'JetBrains Mono', monospace" }}>
          {entry.chipId}
        </div>
        <div style={{ fontSize: 10, color: C.ts, marginTop: 2 }}>
          {entry.label || 'Blank Key Reference'} · {entry.vehicle || 'Unknown vehicle'} · {entry.savedAt ? new Date(entry.savedAt).toLocaleDateString() : ''}
        </div>
        <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
          SK: {entry.sk0} {entry.sk1} {entry.sk2} {entry.sk3}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Btn onClick={() => onLoad(entry)} color={C.a2} outline style={{ fontSize: 10, padding: '4px 8px' }}>
          LOAD
        </Btn>
        <Btn onClick={() => onDelete(entry.chipId)} color={C.er} outline style={{ fontSize: 10, padding: '4px 8px' }}>
          ✕
        </Btn>
      </div>
    </div>
  );
}

/* ─── bin file parser: extract SK0–SK3, chipId, config from raw PCF7953 dump ─── */
function parsePcf7953Bin(data) {
  // PCF7953 EEPROM is typically 256 bytes (pages 0–63, 4 bytes each)
  // or 512 bytes (extended). Autel/VVDI dump formats vary but common layout:
  //   Page 0 (bytes 0–3): Config word
  //   Page 1 (bytes 4–7): SK0 (or UID depending on dump format)
  //   Page 2 (bytes 8–11): SK1
  //   Page 3 (bytes 12–15): SK2
  //   Page 4 (bytes 16–19): SK3
  //   Page 24–27 (bytes 96–99): Chip ID / UID
  // Alternative Autel format (32-byte key data block):
  //   Bytes 0–3: Chip ID, 4–7: SK0, 8–11: SK1, 12–15: SK2, 16–19: SK3, 20–23: Config
  const hex = b => b.toString(16).toUpperCase().padStart(2, '0');
  const word = (arr, off) => hex(arr[off]) + hex(arr[off+1]) + hex(arr[off+2]) + hex(arr[off+3]);

  if (data.length >= 32 && data.length <= 64) {
    // Compact Autel key-data export: 32 bytes
    // [ChipID(4)] [SK0(4)] [SK1(4)] [SK2(4)] [SK3(4)] [Config(4)] [Page1(4)] [Page2(4)]
    return {
      chipId: word(data, 0),
      sk0: word(data, 4),
      sk1: word(data, 8),
      sk2: word(data, 12),
      sk3: word(data, 16),
      config: data.length >= 24 ? word(data, 20) : '00000000',
      page1: data.length >= 28 ? word(data, 24) : '00000000',
      page2: data.length >= 32 ? word(data, 28) : '00000000',
    };
  }

  if (data.length >= 256) {
    // Full EEPROM dump (256+ bytes, page-based)
    // Standard PCF7953 page layout:
    //   Page 0 (off 0): Config
    //   Pages 4–7 (off 16–31): SK0–SK3
    //   Page 24 (off 96): Chip ID
    return {
      chipId: word(data, 96),
      sk0: word(data, 16),
      sk1: word(data, 20),
      sk2: word(data, 24),
      sk3: word(data, 28),
      config: word(data, 0),
      page1: word(data, 4),
      page2: word(data, 8),
    };
  }

  return null; // Unrecognized format
}

/* ─── main component ─── */
export default function HitagAesTab({ vehicle: selectedVehicle }) {
  const [chipId, setChipId] = useState('CF324E65');
  const [sk0,    setSk0]    = useState('11112222');
  const [sk1,    setSk1]    = useState('33334444');
  const [sk2,    setSk2]    = useState('55556666');
  const [sk3,    setSk3]    = useState('77778888');
  const [config, setConfig] = useState('00000000');
  const [page1,  setPage1]  = useState('00000000');
  const [page2,  setPage2]  = useState('00000000');
  const [vehicle, setVehicle] = useState('2021 Charger 6.2 Redeye');
  const [label,   setLabel]   = useState('');

  const [blankRefs, setBlankRefs] = useState(() => loadBlankRefs());
  const [saveMsg,   setSaveMsg]   = useState('');
  const [showRefs,  setShowRefs]  = useState(false);

  /* ── virginize log refresh trigger ── */
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const handleLogEntry = useCallback(() => setLogRefreshKey(k => k + 1), []);

  /* ── File/Photo upload state ── */
  const [uploadMsg, setUploadMsg] = useState('');
  const [uploadErr, setUploadErr] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [ocrRaw, setOcrRaw] = useState(null); // raw OCR extract for display
  const binInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  /* Drag-and-drop handler for the upload zone */
  const handleDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (/^image\//.test(file.type || '')) {
      // Treat as photo
      handlePhotoFile(file);
    } else {
      // Treat as bin
      handleBinFile(file);
    }
  }, []);

  const handleBinFile = useCallback((file) => {
    setUploadErr(''); setUploadMsg('');
    const reader = new FileReader();
    reader.onerror = () => setUploadErr('Could not read that file.');
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target.result);
      const parsed = parsePcf7953Bin(data);
      if (!parsed) {
        setUploadErr(`Could not parse "${file.name}" (${data.length} bytes). Expected a 32–64 byte Autel key export or a 256+ byte full EEPROM dump.`);
        return;
      }
      setChipId(parsed.chipId);
      setSk0(parsed.sk0); setSk1(parsed.sk1); setSk2(parsed.sk2); setSk3(parsed.sk3);
      setConfig(parsed.config); setPage1(parsed.page1); setPage2(parsed.page2);
      setUploadMsg(`✅ Loaded "${file.name}" (${data.length} bytes) — fields auto-filled from binary.`);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handlePhotoFile = useCallback((file) => {
    if (!/^image\//.test(file.type || '')) { setUploadErr('Please choose an image file (PNG, JPG, WEBP).'); return; }
    setUploadErr(''); setUploadMsg(''); setOcrRaw(null); setPhotoBusy(true);
    const reader = new FileReader();
    reader.onerror = () => { setPhotoBusy(false); setUploadErr('Could not read that image.'); };
    reader.onload = async (ev) => {
      try {
        const dataUrl = String(ev.target.result || '');
        setPhotoPreview(dataUrl);
        // AI-powered OCR extraction
        try {
          const apiRes = await fetch('/api/anthropic/key-photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: dataUrl, mediaType: file.type || 'image/png' }),
          });
          if (apiRes.ok) {
            const data = await apiRes.json();
            // Store raw OCR for display
            setOcrRaw(data);
            // Populate all fields — server already maps HITAG2 page data → sk0-sk3
            if (data.chipId)  setChipId(data.chipId);
            if (data.sk0)     setSk0(data.sk0);
            if (data.sk1)     setSk1(data.sk1);
            if (data.sk2)     setSk2(data.sk2);
            if (data.sk3)     setSk3(data.sk3);
            if (data.config)  setConfig(data.config);
            if (data.page1)   setPage1(data.page1);
            if (data.page2)   setPage2(data.page2);
            // Count how many fields were populated
            const filled = [data.chipId, data.sk0, data.sk1, data.sk2, data.sk3, data.config].filter(Boolean).length;
            const chipLabel = data.chipType ? ` (${data.chipType})` : '';
            setUploadMsg(`✅ OCR complete${chipLabel} — ${filled}/6 fields extracted. Verify values below.`);
          } else {
            const errData = await apiRes.json().catch(() => ({}));
            setUploadMsg(`⚠️ OCR failed: ${errData.error || apiRes.status}. Enter values manually.`);
          }
        } catch (fetchErr) {
          setUploadMsg('📷 Photo saved. AI extraction unavailable — enter hex values manually.');
        }
      } catch (err) {
        setUploadErr(err?.message || 'Photo read failed.');
      } finally {
        setPhotoBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handleBinUpload = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    handleBinFile(file);
  }, [handleBinFile]);

  const handlePhotoUpload = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    handlePhotoFile(file);
  }, [handlePhotoFile]);



  const verdict = useMemo(
    () => analyzeKey({ chipId, sk0, sk1, sk2, sk3, config, page1, page2 }),
    [chipId, sk0, sk1, sk2, sk3, config, page1, page2],
  );

  const cfg       = useMemo(() => decodeConfig(config), [config]);
  const aesSecret = useMemo(() => buildAesSecret(sk0, sk1, sk2, sk3), [sk0, sk1, sk2, sk3]);
  const hitag2SK  = useMemo(() => deriveHitag2SK(page1, page2), [page1, page2]);

  const fillBlank = useCallback(() => {
    setSk0('11112222'); setSk1('33334444'); setSk2('55556666'); setSk3('77778888');
    setConfig('00000000'); setPage1('00000000'); setPage2('00000000');
  }, []);

  const clearAll = useCallback(() => {
    setChipId(''); setSk0(''); setSk1(''); setSk2(''); setSk3('');
    setConfig(''); setPage1(''); setPage2(''); setVehicle(''); setLabel('');
  }, []);

  const handleSaveBlankRef = useCallback(() => {
    const cid = normHex(chipId);
    if (!cid) { setSaveMsg('⚠ Enter a Chip ID first.'); return; }
    const entry = {
      chipId: cid,
      sk0: normHex(sk0), sk1: normHex(sk1), sk2: normHex(sk2), sk3: normHex(sk3),
      config: normHex(config), page1: normHex(page1), page2: normHex(page2),
      vehicle: vehicle || 'Unknown vehicle',
      label: label || 'Blank Key Reference',
      verdict: verdict.status,
      savedAt: Date.now(),
    };
    const updated = saveBlankRef(entry);
    setBlankRefs(updated);
    setSaveMsg(`✅ Saved blank reference for Chip ID ${cid}`);
    setShowRefs(true);
    setTimeout(() => setSaveMsg(''), 3000);
  }, [chipId, sk0, sk1, sk2, sk3, config, page1, page2, vehicle, label, verdict.status]);

  const handleLoadRef = useCallback((entry) => {
    setChipId(entry.chipId);
    setSk0(entry.sk0); setSk1(entry.sk1); setSk2(entry.sk2); setSk3(entry.sk3);
    setConfig(entry.config || '00000000');
    setPage1(entry.page1 || '00000000');
    setPage2(entry.page2 || '00000000');
    setVehicle(entry.vehicle || '');
    setLabel(entry.label || '');
  }, []);

  const handleDeleteRef = useCallback((cid) => {
    setBlankRefs(removeBlankRef(cid));
  }, []);

  /* ── Compare to Blank ── */
  const [compareResult, setCompareResult] = useState(null);

  const handleCompareToBlank = useCallback(() => {
    const refs = loadBlankRefs();
    if (refs.length === 0) {
      setCompareResult({ error: 'No blank references saved yet. Save a blank key first.' });
      return;
    }
    const currentChip = normHex(chipId);
    // Try to find a matching chipId first, otherwise compare against the first saved blank
    const matchRef = refs.find(r => r.chipId === currentChip) || refs[0];
    const fields = ['sk0', 'sk1', 'sk2', 'sk3', 'config', 'page1', 'page2'];
    const current = { sk0: normHex(sk0), sk1: normHex(sk1), sk2: normHex(sk2), sk3: normHex(sk3), config: normHex(config), page1: normHex(page1), page2: normHex(page2) };
    const diffs = [];
    for (const f of fields) {
      const refVal = normHex(matchRef[f] || '00000000');
      const curVal = current[f] || '00000000';
      if (refVal !== curVal) {
        diffs.push({ field: f.toUpperCase(), blank: refVal, current: curVal });
      }
    }
    setCompareResult({
      refChipId: matchRef.chipId,
      refLabel: matchRef.label || matchRef.vehicle || 'Blank Reference',
      diffs,
      identical: diffs.length === 0,
    });
  }, [chipId, sk0, sk1, sk2, sk3, config, page1, page2]);

  /* ── VVDI Text Paste ── */
  const [showVvdiPaste, setShowVvdiPaste] = useState(false);
  const [vvdiText, setVvdiText] = useState('');

  const handleVvdiParse = useCallback(() => {
    if (!vvdiText.trim()) return;
    // Parse formats like:
    //   P0: 11112222 P1: 33334444 P2: 55556666 P3: 77778888
    //   Page 0: 11112222\nPage 1: 33334444\n...
    //   P0=11112222 P1=33334444
    //   0: 11112222  1: 33334444  2: 55556666  3: 77778888
    const lines = vvdiText.replace(/[\r\n]+/g, ' ').trim();
    const pageMap = {};
    // Match patterns like "P0: XXXXXXXX" or "Page 0: XXXXXXXX" or "0: XXXXXXXX" or "P0=XXXXXXXX"
    const regex = /(?:page\s*|p)?([0-9]+)\s*[:=]\s*([0-9A-Fa-f]{8})/gi;
    let m;
    while ((m = regex.exec(lines)) !== null) {
      pageMap[parseInt(m[1], 10)] = m[2].toUpperCase();
    }
    // If no matches, try space-separated hex words (just 8-char hex blocks in order)
    if (Object.keys(pageMap).length === 0) {
      const hexBlocks = vvdiText.match(/[0-9A-Fa-f]{8}/g);
      if (hexBlocks && hexBlocks.length >= 4) {
        hexBlocks.forEach((h, i) => { pageMap[i] = h.toUpperCase(); });
      }
    }
    if (Object.keys(pageMap).length === 0) {
      setUploadErr('Could not parse VVDI text. Expected format: P0: XXXXXXXX P1: XXXXXXXX ...');
      return;
    }
    // Map pages to fields based on common VVDI layout:
    // P0=Config, P1=SK0 (or ChipID), P2=SK1, P3=SK2, P4=SK3
    // Or if 4+ pages: first 4 are SK0-SK3
    const keys = Object.keys(pageMap).map(Number).sort((a, b) => a - b);
    if (keys.length >= 5 && pageMap[0]) {
      // Full page dump: P0=Config, P1-P4=SK0-SK3, P24=ChipID
      setConfig(pageMap[0] || config);
      setSk0(pageMap[1] || sk0); setSk1(pageMap[2] || sk1);
      setSk2(pageMap[3] || sk2); setSk3(pageMap[4] || sk3);
      if (pageMap[5]) setPage1(pageMap[5]);
      if (pageMap[6]) setPage2(pageMap[6]);
      if (pageMap[24]) setChipId(pageMap[24]);
    } else if (keys.length >= 4) {
      // Just SK pages: first 4 hex blocks
      const vals = keys.map(k => pageMap[k]);
      setSk0(vals[0]); setSk1(vals[1]); setSk2(vals[2]); setSk3(vals[3]);
      if (vals[4]) setConfig(vals[4]);
      if (vals[5]) setPage1(vals[5]);
      if (vals[6]) setPage2(vals[6]);
    }
    setUploadMsg(`✅ Parsed ${Object.keys(pageMap).length} pages from VVDI text.`);
    setUploadErr('');
    setShowVvdiPaste(false);
    setVvdiText('');
  }, [vvdiText, config, sk0, sk1, sk2, sk3]);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px' }}>
      <VehicleYearGuard vehicle={selectedVehicle || null} />
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: C.t, letterSpacing: 1 }}>
          🔑 HITAG AES KEY STATUS READER
        </div>
        <div style={{ fontSize: 12, color: C.ts, marginTop: 4 }}>
          PCF7953 / HITAG AES · FCA / Mopar FOBIK · 2011+ SRT / Redeye / Hellcat
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Left — input */}
        <div>
          {/* FILE / PHOTO UPLOAD */}
          <Card
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
            onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
            onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); }}
            onDrop={handleDrop}
            style={{ marginBottom: 14, border: `2px ${dragOver ? 'solid' : 'solid'} ${dragOver ? C.a2 : C.a2 + '44'}`, background: dragOver ? '#E0E7FF' : '#F8FAFF', transition: 'border-color 0.2s, background 0.2s' }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2, marginBottom: 10 }}>
              📤 UPLOAD KEY DATA
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.5 }}>
              Drop a <b>.bin transponder dump</b> (Autel/VVDI export) to auto-fill all fields, or upload a <b>photo</b> of the key/programmer screen for reference.
            </div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              {/* BIN upload */}
              <input ref={binInputRef} type="file" accept=".bin,.BIN,.eep,.EEP" style={{ display: 'none' }} onChange={handleBinUpload} />
              <button
                onClick={() => binInputRef.current?.click()}
                style={{
                  flex: 1, padding: '14px 12px', borderRadius: 10, cursor: 'pointer',
                  border: `2px dashed ${C.a2}66`, background: '#EEF2FF',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.a2; e.currentTarget.style.background = '#E0E7FF'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.a2 + '66'; e.currentTarget.style.background = '#EEF2FF'; }}
              >
                <div style={{ fontSize: 18 }}>📂</div>
                <div style={{ fontSize: 10, fontWeight: 800, color: C.a2, letterSpacing: 1 }}>BIN / EEP FILE</div>
                <div style={{ fontSize: 9, color: C.ts }}>PCF7953 dump</div>
              </button>

              {/* PHOTO upload */}
              <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoUpload} />
              <button
                onClick={() => photoInputRef.current?.click()}
                style={{
                  flex: 1, padding: '14px 12px', borderRadius: 10, cursor: 'pointer',
                  border: `2px dashed #7C3AED66`, background: '#F5F3FF',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#7C3AED'; e.currentTarget.style.background = '#EDE9FE'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#7C3AED66'; e.currentTarget.style.background = '#F5F3FF'; }}
              >
                <div style={{ fontSize: 18 }}>📷</div>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#7C3AED', letterSpacing: 1 }}>PHOTO</div>
                <div style={{ fontSize: 9, color: C.ts }}>Key or screen</div>
              </button>
            </div>

            {photoBusy && (
              <div style={{ fontSize: 11, color: C.a2, fontWeight: 700, padding: '6px 0' }}>
                ⏳ Analyzing photo...
              </div>
            )}
            {uploadMsg && (
              <div style={{ fontSize: 11, color: C.gn, fontWeight: 700, padding: '4px 0', lineHeight: 1.5 }}>
                {uploadMsg}
              </div>
            )}
            {uploadErr && (
              <div style={{ fontSize: 11, color: C.er, fontWeight: 700, padding: '4px 0', lineHeight: 1.5 }}>
                ⚠ {uploadErr}
              </div>
            )}
            {photoPreview && (
              <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.bd}` }}>
                <img src={photoPreview} alt="Key photo" style={{ width: '100%', maxHeight: 200, objectFit: 'contain', background: '#000' }} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 4 }}>
                  <button onClick={() => { setPhotoPreview(null); setOcrRaw(null); }} style={{ fontSize: 10, color: C.ts, cursor: 'pointer', background: 'none', border: 'none' }}>✕ Remove</button>
                </div>
              </div>
            )}

            {/* OCR Raw Extract Panel */}
            {ocrRaw && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#0F0F1A', border: '1.5px solid #7C3AED55' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#A78BFA', letterSpacing: 2, marginBottom: 8 }}>
                  🧠 AI OCR EXTRACT — {ocrRaw.chipType || 'UNKNOWN CHIP TYPE'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px' }}>
                  {[
                    ['Chip ID',        ocrRaw.chipId],
                    ['Chip Type',      ocrRaw.chipType],
                    ['Param Low SK',   ocrRaw.paramLowSK],
                    ['Param High SK',  ocrRaw.paramHighSK],
                    ['Info Low SK',    ocrRaw.chipInfoLowSK],
                    ['Info High SK',   ocrRaw.chipInfoHighSK],
                    ['Config Page',    ocrRaw.configPage],
                    ['Page 0',         ocrRaw.page0],
                    ['Page 1',         ocrRaw.page1],
                    ['Page 2',         ocrRaw.page2],
                    ['Page 3',         ocrRaw.page3],
                    ['HITAG2 Full SK', ocrRaw.hitag2FullSK],
                    ['AES SK0',        ocrRaw.sk0],
                    ['AES SK1',        ocrRaw.sk1],
                    ['AES SK2',        ocrRaw.sk2],
                    ['AES SK3',        ocrRaw.sk3],
                  ].filter(([, v]) => v != null).map(([label, val]) => (
                    <div key={label} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 9, color: '#6B7280', fontWeight: 700, minWidth: 90, flexShrink: 0 }}>{label}</span>
                      <span style={{ fontSize: 11, color: '#E2E8F0', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{val}</span>
                    </div>
                  ))}
                </div>
                {ocrRaw.notes && (
                  <div style={{ marginTop: 8, fontSize: 10, color: '#9CA3AF', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {ocrRaw.notes}
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 9, color: '#4B5563' }}>
                  Fields above are what the AI read. The form fields below have been auto-filled from this extract.
                </div>
              </div>
            )}
          </Card>

          {/* INSTRUCTIONS */}
          <Card style={{ marginBottom: 14, background: '#FFFBEB', border: `1.5px solid ${C.wn}33` }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.wn, letterSpacing: 2, marginBottom: 8 }}>
              📖 INSTRUCTIONS
            </div>
            <div style={{ fontSize: 11, color: C.t, lineHeight: 1.7 }}>
              <b>Option A — Upload .bin:</b> Use your Autel IM608 or VVDI to read the transponder, export as .bin, and upload above. All fields auto-fill instantly.<br /><br />
              <b>Option B — Upload photo:</b> Take a photo of your programmer screen showing the SK pages. The AI will attempt to extract hex values (verify manually).<br /><br />
              <b>Option C — Manual entry:</b> Type the values directly from your programmer screen into the fields below. Each field is 8 hex characters (4 bytes).
            </div>
          </Card>

          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2, marginBottom: 12 }}>
              📋 AUTEL / VVDI PAGE READ INPUT
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.5 }}>
              Enter values exactly as shown on your programmer screen. Each field is 8 hex characters (4 bytes).
            </div>

            <HexField label="CHIP ID (UID)" value={chipId} onChange={setChipId} placeholder="CF324E65" />

            <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
              SK PAGES (Reading/writing page)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <HexField label="SK0" value={sk0} onChange={setSk0} placeholder="11112222" />
              <HexField label="SK1" value={sk1} onChange={setSk1} placeholder="33334444" />
              <HexField label="SK2" value={sk2} onChange={setSk2} placeholder="55556666" />
              <HexField label="SK3" value={sk3} onChange={setSk3} placeholder="77778888" />
            </div>

            <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
              CONFIG / PAGES
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <HexField label="Config" value={config} onChange={setConfig} placeholder="00000000" />
              <HexField label="Page 1" value={page1} onChange={setPage1} placeholder="00000000" />
              <HexField label="Page 2" value={page2} onChange={setPage2} placeholder="00000000" />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn onClick={fillBlank} color={C.gn} outline style={{ flex: 1, fontSize: 11 }}>
                FILL BLANK
              </Btn>
              <Btn onClick={clearAll} color={C.tm} outline style={{ flex: 1, fontSize: 11 }}>
                CLEAR
              </Btn>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn onClick={() => setShowVvdiPaste(v => !v)} color={C.a2} outline style={{ flex: 1, fontSize: 11 }}>
                📋 PASTE FROM VVDI
              </Btn>
              <Btn onClick={handleCompareToBlank} color='#7C3AED' outline style={{ flex: 1, fontSize: 11 }}>
                🔍 COMPARE TO BLANK
              </Btn>
            </div>

            {/* VVDI Text Paste Area */}
            {showVvdiPaste && (
              <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#F0F4FF', border: `1.5px solid ${C.a2}44` }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: C.a2, letterSpacing: 1, marginBottom: 6 }}>
                  PASTE VVDI / TANGO PAGE DUMP
                </div>
                <div style={{ fontSize: 10, color: C.ts, marginBottom: 8, lineHeight: 1.5 }}>
                  Accepts formats: <code>P0: XXXXXXXX P1: XXXXXXXX ...</code> or <code>Page 0: XXXXXXXX</code> (one per line) or just space-separated 8-char hex blocks.
                </div>
                <textarea
                  value={vvdiText}
                  onChange={e => setVvdiText(e.target.value)}
                  placeholder={'P0: 00000000\nP1: 11112222\nP2: 33334444\nP3: 55556666\nP4: 77778888'}
                  style={{
                    width: '100%', minHeight: 80, padding: 10, borderRadius: 8,
                    border: `1.5px solid ${C.bd}`, background: '#fff',
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                    color: C.t, resize: 'vertical', boxSizing: 'border-box',
                  }}
                  spellCheck={false}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Btn onClick={handleVvdiParse} color={C.a2} style={{ flex: 1, fontSize: 11 }}>
                    PARSE & FILL
                  </Btn>
                  <Btn onClick={() => { setShowVvdiPaste(false); setVvdiText(''); }} color={C.tm} outline style={{ fontSize: 11 }}>
                    CANCEL
                  </Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Save as Blank Key Reference */}
          <Card style={{ marginBottom: 14, border: `1.5px solid ${C.gn}55`, background: '#F1FBF4' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.gn, letterSpacing: 2, marginBottom: 10 }}>
              💾 SAVE AS BLANK KEY REFERENCE
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 10, lineHeight: 1.5 }}>
              Save this chip read as a confirmed-blank reference so you can compare future reads against known-blank profiles.
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 3 }}>
                VEHICLE (optional)
              </div>
              <input
                value={vehicle}
                onChange={e => setVehicle(e.target.value)}
                placeholder="2021 Charger 6.2 Redeye"
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${C.bd}`,
                  background: '#FAFAF8', fontSize: 12, color: C.t, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 3 }}>
                LABEL (optional)
              </div>
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Red key blank — bench stock"
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${C.bd}`,
                  background: '#FAFAF8', fontSize: 12, color: C.t, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>

            <Btn
              onClick={handleSaveBlankRef}
              color={C.gn}
              style={{ width: '100%', fontWeight: 800, fontSize: 12 }}
            >
              💾 SAVE BLANK REFERENCE
            </Btn>

            {saveMsg && (
              <div style={{ marginTop: 8, fontSize: 11, color: saveMsg.startsWith('✅') ? C.gn : C.er, fontWeight: 700 }}>
                {saveMsg}
              </div>
            )}
          </Card>

          {/* Alt-family note */}
          <Card style={{ background: '#FFF8E1', border: `1.5px solid ${C.wn}33` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.wn, letterSpacing: 1, marginBottom: 6 }}>
              ⚡ 2020–2021 REDEYE / HELLCAT NOTE
            </div>
            <div style={{ fontSize: 11, color: C.t, lineHeight: 1.6 }}>
              The 2020+ Charger/Challenger 6.2 Redeye uses an <b>alternate transponder family (flag 0x03)</b> — different from the standard HITAG2 id46 (flag 0x01) used on 2019 and earlier models.
              <br /><br />
              A blank Redeye key shows the same factory test pattern (<code>11112222 / 33334444 / 55556666 / 77778888</code>). After programming, the vehicle-specific AES secret is written into SK0–SK3.
              <br /><br />
              <b>Chip ID CF324E65</b> is a confirmed blank Redeye FOBIK UID from your Autel screenshot. It is saved as a blank reference in the registry.
            </div>
          </Card>
        </div>

        {/* Right — verdict + decoded fields + saved refs */}
        <div>
          {/* Status verdict */}
          <Card style={{ marginBottom: 14, border: `2px solid ${verdict.color}`, background: verdict.bg }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2 }}>
                🛡️ KEY STATUS
              </div>
              <div style={{
                fontSize: 11, fontWeight: 800, padding: '4px 12px',
                background: verdict.color, color: '#fff', borderRadius: 6, letterSpacing: 1,
              }}>
                {verdict.emoji} {verdict.label}
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.t, lineHeight: 1.6 }}>
              {verdict.detail}
            </div>
            {verdict.knownKey && (
              <div style={{ marginTop: 10, padding: 8, background: '#fff', borderRadius: 8, border: `1px solid ${C.gn}44` }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: C.gn, letterSpacing: 1 }}>KNOWN WORKING KEY MATCH</div>
                <div style={{ fontSize: 11, color: C.t, marginTop: 4 }}>
                  <b>Vehicle:</b> {verdict.knownKey.vehicle}<br />
                  <b>Key ID:</b> {verdict.knownKey.keyId}<br />
                  <b>Chip:</b> {verdict.knownKey.chipId}<br />
                  <b>SK:</b> <code style={{ fontFamily: "'JetBrains Mono'" }}>{verdict.knownKey.sk}</code>
                </div>
              </div>
            )}
          </Card>

          {/* Decoded fields */}
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2, marginBottom: 12 }}>
              🔬 DECODED FIELDS
            </div>

            <DecodedRow label="Chip UID (BE)" value={normHex(chipId) || '—'} mono />
            <DecodedRow label="Chip UID (LE / revUid)"
              value={normHex(chipId) ? normHex(chipId).match(/.{2}/g)?.reverse().join('') : '—'}
              mono note="Stored in RFHUB slot table"
            />

            <div style={{ borderTop: `1px solid ${C.bd}`, margin: '10px 0' }} />

            <DecodedRow label="AES Root Key (SK0–SK3)"
              value={aesSecret ? bytesToHex(hexToBytes(aesSecret)) : '—'}
              mono
              highlight={verdict.status === 'BLANK' ? C.gn : verdict.status === 'PROGRAMMED' ? C.a2 : undefined}
            />
            <DecodedRow label="HITAG2 SK (page1 ∥ high(page2))"
              value={hitag2SK || '—'}
              mono
              note={hitag2SK === '4F4E4D494B52' ? '⚠ MIKRON universal default' : hitag2SK === '502077550100' ? '✓ Known working (2019 Charger 6.2 key #1)' : undefined}
            />

            <div style={{ borderTop: `1px solid ${C.bd}`, margin: '10px 0' }} />

            <DecodedRow label="Config word" value={normHex(config) || '—'} mono />
            {cfg && (
              <>
                <DecodedRow label="Lock bit" value={cfg.lockBit ? '🔒 SET — chip is locked' : '✓ CLEAR — writable'} color={cfg.lockBit ? C.er : C.gn} />
                <DecodedRow label="AES enable" value={cfg.aesEnable ? '✓ AES mode active' : 'HITAG2 mode'} />
              </>
            )}

            <div style={{ borderTop: `1px solid ${C.bd}`, margin: '10px 0' }} />

            <DecodedRow label="Key family guess"
              value={
                verdict.status === 'BLANK' ? 'Blank — family TBD after programming' :
                hitag2SK === '4F4E4D494B52' ? 'id46 / HITAG2 (MIKRON default)' :
                verdict.knownKey ? `id46 / HITAG2 (${verdict.knownKey.chipId})` :
                'PCF7953 / HITAG AES (FCA Mopar FOBIK)'
              }
            />
            <DecodedRow label="Platform" value="FCA / Mopar · 2011+ SRT / Redeye / Hellcat" />

            <div style={{ borderTop: `1px solid ${C.bd}`, margin: '10px 0' }} />
            <div style={{ fontSize: 10, fontWeight: 800, color: C.a2, letterSpacing: 1, marginBottom: 6 }}>FOBIK BINDING</div>
            <DecodedRow label="Transponder UID (BE)" value={normHex(chipId) || '—'} mono />
            <DecodedRow label="Transponder UID (LE / revUid)"
              value={normHex(chipId) ? normHex(chipId).match(/.{2}/g)?.reverse().join('') : '—'}
              mono note="keyId stored in RFHUB slot table"
            />
            <DecodedRow label="Expected RFHUB slot flag"
              value={
                verdict.status === 'BLANK' ? '0x01 (standard) or 0x03 (Redeye alt-family)' :
                verdict.knownKey?.tableFlag != null ? `0x${verdict.knownKey.tableFlag.toString(16).toUpperCase().padStart(2,'0')}` :
                '0x01 (standard HITAG2) or 0x03 (alt-family)'
              }
            />
            <DecodedRow label="RFHUB table index (if known)"
              value={
                verdict.knownKey?.tableIndex != null
                  ? `0x${verdict.knownKey.tableIndex.toString(16).toUpperCase().padStart(2,'0')}`
                  : 'Unknown — derive from UID mod-255 checksum'
              }
            />
            <DecodedRow label="RFHUB table address (if known)"
              value={
                verdict.knownKey?.tableAddr != null
                  ? `0x${verdict.knownKey.tableAddr.toString(16).toUpperCase().padStart(4,'0')}`
                  : 'Unknown'
              }
            />
            <DecodedRow label="Vehicle (if known)" value={verdict.knownKey?.vehicle || '—'} />
          </Card>

          {/* What to do next */}
          <Card style={{ background: '#F8F6F2', border: `1.5px solid ${C.bd}`, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2, marginBottom: 8 }}>
              📋 NEXT STEPS
            </div>
            {verdict.status === 'BLANK' && (
              <div style={{ fontSize: 11, color: C.t, lineHeight: 1.7 }}>
                ✅ <b>Key is ready to program.</b><br />
                1. Verify BCM VIN is correct (not blank/zeros) — use J2534 UDS console to read DID F190.<br />
                2. Verify RFHUB SEC16 matches BCM (use Security Sync tab).<br />
                3. Run key-learn via Autel: <b>Chrysler → Dodge → Charger → 2021 → Add Key</b>.<br />
                4. After learn, re-read this key — SK0–SK3 should show the vehicle secret.
              </div>
            )}
            {verdict.status === 'PROGRAMMED' && (
              <div style={{ fontSize: 11, color: C.t, lineHeight: 1.7 }}>
                🔑 <b>Key is paired to a vehicle.</b><br />
                If it doesn't start the car, the RFHUB/BCM SEC16 may not match this key's vehicle.<br />
                Use the Security Sync tab to verify BCM ↔ RFHUB pairing.
              </div>
            )}
            {verdict.status === 'LOCKED' && (
              <div style={{ fontSize: 11, color: C.er, lineHeight: 1.7 }}>
                🔒 <b>This key cannot be rewritten.</b><br />
                The lock bit is set. Use a different blank key.<br />
                VVDI Mini and Tango cannot unlock a locked HITAG AES chip.
              </div>
            )}
            {verdict.status === 'KNOWN_GOOD' && (
              <div style={{ fontSize: 11, color: C.gn, lineHeight: 1.7 }}>
                🏆 <b>Confirmed working key.</b><br />
                This key matches a bench-verified working fob in the SRT Lab database.<br />
                If it doesn't start the car, the RFHUB SEC16 may have changed since this key was programmed.
              </div>
            )}
            {verdict.status === 'MIKRON_DEFAULT' && (
              <div style={{ fontSize: 11, color: C.wn, lineHeight: 1.7 }}>
                ⚠️ <b>MIKRON universal default SK.</b><br />
                This key was written with the generic default, not a vehicle-specific secret.<br />
                It will not start a vehicle unless the RFHUB was also programmed with the MIKRON default.
              </div>
            )}
          </Card>

          {/* Compare to Blank Result */}
          {compareResult && (
            <Card style={{ marginBottom: 14, border: `2px solid ${compareResult.error ? C.er : compareResult.identical ? C.gn : '#7C3AED'}`, background: compareResult.error ? '#FFF0F0' : compareResult.identical ? '#F0FFF4' : '#F5F0FF' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#7C3AED', letterSpacing: 2 }}>
                  🔍 COMPARE TO BLANK
                </div>
                <button onClick={() => setCompareResult(null)} style={{ fontSize: 11, color: C.ts, cursor: 'pointer', background: 'none', border: 'none' }}>✕ Close</button>
              </div>
              {compareResult.error ? (
                <div style={{ fontSize: 11, color: C.er, fontWeight: 700 }}>⚠️ {compareResult.error}</div>
              ) : compareResult.identical ? (
                <div style={{ fontSize: 11, color: C.gn, fontWeight: 700, lineHeight: 1.6 }}>
                  ✅ <b>Identical to blank reference</b> ({compareResult.refLabel} — Chip {compareResult.refChipId})<br />
                  All SK pages and config match the saved blank. This key has NOT been programmed since the reference was saved.
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: C.t, marginBottom: 10, lineHeight: 1.5 }}>
                    Compared against: <b>{compareResult.refLabel}</b> (Chip {compareResult.refChipId})<br />
                    <span style={{ color: '#7C3AED', fontWeight: 800 }}>{compareResult.diffs.length} field{compareResult.diffs.length > 1 ? 's' : ''} changed</span> since blank reference was saved.
                  </div>
                  <div style={{ borderRadius: 8, overflow: 'hidden', border: `1px solid #7C3AED33` }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', fontSize: 10, fontWeight: 800, color: '#7C3AED', padding: '6px 10px', background: '#EDE9FE', letterSpacing: 1 }}>
                      <div>FIELD</div><div>BLANK</div><div>CURRENT</div>
                    </div>
                    {compareResult.diffs.map(d => (
                      <div key={d.field} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', fontSize: 11, padding: '5px 10px', borderTop: '1px solid #7C3AED22', fontFamily: "'JetBrains Mono', monospace" }}>
                        <div style={{ fontWeight: 800, color: C.t }}>{d.field}</div>
                        <div style={{ color: C.ts }}>{d.blank}</div>
                        <div style={{ color: '#7C3AED', fontWeight: 700 }}>{d.current}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: C.ts, marginTop: 8, lineHeight: 1.5 }}>
                    💡 Changed SK pages indicate the key has been programmed with a vehicle-specific secret. If all 4 SK pages changed, the key is fully paired.
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Saved blank references */}
          <Card>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: showRefs ? 12 : 0 }}
              onClick={() => setShowRefs(v => !v)}
            >
              <div style={{ fontSize: 11, fontWeight: 800, color: C.a2, letterSpacing: 2 }}>
                📚 SAVED BLANK REFERENCES ({blankRefs.length})
              </div>
              <div style={{ fontSize: 12, color: C.ts }}>{showRefs ? '▲' : '▼'}</div>
            </div>
            {showRefs && (
              blankRefs.length === 0
                ? <div style={{ fontSize: 11, color: C.ts, padding: '8px 0' }}>No blank references saved yet. Use the "Save Blank Reference" button on the left.</div>
                : blankRefs.map(r => (
                    <BlankRefCard key={r.chipId} ref={r} onLoad={handleLoadRef} onDelete={handleDeleteRef} />
                  ))
            )}
          </Card>
        </div>
      </div>

      {/* ─── HITAG AES Virginize Panel ─── */}
      <AesVirginizePanel chipId={chipId} onLogEntry={handleLogEntry} />

      {/* ─── Virginize Session Log ─── */}
      <div style={{ padding: '0 16px 16px' }}>
        <VirginizeLogPanel refreshKey={logRefreshKey} />
      </div>
    </div>
  );
}

/* ─── AesVirginizePanel component ─── */
function AesVirginizePanel({ chipId: liveChipId, onLogEntry }) {
  const profile = HITAG_AES_BLACK_VIRGIN_PROFILE;
  const [copied, setCopied] = useState('');
  const copy = useCallback((text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    });
  }, []);

  const detected = useMemo(() => lookupChipReadByChipId(liveChipId), [liveChipId]);
  const isAes = detected?.chipFamily === 'HITAG AES';

  const [vConfig, setVConfig] = useState('');
  const [vPage1,  setVPage1]  = useState('');
  const [vPage2,  setVPage2]  = useState('');
  const verifyFields = [
    ['Config', vConfig, setVConfig],
    ['Page 1', vPage1,  setVPage1],
    ['Page 2', vPage2,  setVPage2],
  ];
  const verifyResults = verifyFields.map(([label, val]) => {
    const norm = val.replace(/\s/g, '').toUpperCase();
    if (!norm) return { label, status: 'empty' };
    return { label, status: norm === '00000000' ? 'pass' : 'fail' };
  });
  const anyEntered = verifyFields.some(([, v]) => v.trim() !== '');
  const allPass = anyEntered && verifyResults.every(r => r.status === 'pass' || r.status === 'empty') && verifyResults.some(r => r.status === 'pass');
  const anyFail = verifyResults.some(r => r.status === 'fail');

  const writeFields = [
    ['CONFIG', profile.config, '#F59E0B'],
    ['PAGE 1', profile.page1,  '#60A5FA'],
    ['PAGE 2', profile.page2,  '#60A5FA'],
  ];
  const skFields = [
    ['SK0', profile.sk0], ['SK1', profile.sk1], ['SK2', profile.sk2], ['SK3', profile.sk3],
  ];

  return (
    <div style={{ marginTop: 16, padding: 16, borderRadius: 10, background: '#0d1117', border: '1px solid #2d3748' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontWeight: 700, color: '#A78BFA', fontSize: 13, letterSpacing: 1, flex: 1 }}>
          🔓 VIRGINIZE KEY — HITAG AES Black Key (PCF7953)
        </div>
        {isAes && (
          <span style={{ fontSize: 10, color: '#34D399', background: '#0a2a1a', border: '1px solid #1a4a2a', borderRadius: 12, padding: '2px 8px' }}>
            ✓ Auto-detected: HITAG AES black key
          </span>
        )}
      </div>

      <div style={{ color: '#888', fontSize: 11, marginBottom: 14, lineHeight: 1.6 }}>
        Confirmed blank profile for 2021 Charger 6.2 Redeye <strong style={{ color: '#9CA3AF' }}>black keys</strong> (PCF7953, HITAG AES).
        Bench-read from chip <code>A0CC096F</code> (2026-06-09).
        {' '}<strong style={{ color: '#F59E0B' }}>SK0–SK3 stay at factory test pattern — do not change them.</strong>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        {writeFields.map(([label, val, color]) => (
          <div key={label} style={{ background: '#0a0a0a', border: `1px solid ${color}33`, borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <code style={{ color, fontFamily: 'monospace', fontSize: 14, flex: 1 }}>{val}</code>
              <button onClick={() => copy(val, label)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: copied === label ? '#166534' : '#1a2a1a', color: copied === label ? '#4ade80' : '#555', border: '1px solid #2a3a2a', cursor: 'pointer' }}>
                {copied === label ? '✓' : 'Copy'}
              </button>
            </div>
            <div style={{ color: '#444', fontSize: 10, marginTop: 2 }}>Write this value via Autel</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
        {skFields.map(([label, val]) => (
          <div key={label} style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 6, padding: '6px 10px' }}>
            <div style={{ color: '#444', fontSize: 10, letterSpacing: 1, marginBottom: 3 }}>{label} <span style={{ color: '#333' }}>(do not change)</span></div>
            <code style={{ color: '#555', fontFamily: 'monospace', fontSize: 12 }}>{val}</code>
          </div>
        ))}
      </div>

      <div style={{ background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ color: '#A78BFA', fontWeight: 700, marginBottom: 8, fontSize: 12 }}>✅ POST-VIRGINIZE VERIFY — Paste read-back values to confirm all zeros</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
          {verifyFields.map(([label, val, setter]) => {
            const norm = val.replace(/\s/g, '').toUpperCase();
            const res = !norm ? 'empty' : norm === '00000000' ? 'pass' : 'fail';
            const borderColor = res === 'pass' ? '#22c55e' : res === 'fail' ? '#ef4444' : '#2a2a2a';
            return (
              <div key={label}>
                <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                <input
                  value={val}
                  onChange={e => setter(e.target.value)}
                  placeholder="00000000"
                  maxLength={8}
                  style={{ width: '100%', boxSizing: 'border-box', background: '#0d1117', border: `1px solid ${borderColor}`, color: res === 'pass' ? '#22c55e' : res === 'fail' ? '#ef4444' : '#aaa', fontFamily: 'monospace', fontSize: 13, padding: '4px 6px', borderRadius: 4, textTransform: 'uppercase' }}
                />
                {res !== 'empty' && (
                  <div style={{ fontSize: 10, marginTop: 2, color: res === 'pass' ? '#22c55e' : '#ef4444' }}>
                    {res === 'pass' ? '✓ ZERO' : '✗ NOT ZERO'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {anyEntered && (
          <div style={{ padding: '6px 12px', borderRadius: 6, background: allPass ? '#0a2a0a' : anyFail ? '#2a0a0a' : '#1a1a1a', border: `1px solid ${allPass ? '#22c55e' : anyFail ? '#ef4444' : '#333'}`, color: allPass ? '#22c55e' : anyFail ? '#ef4444' : '#aaa', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>{allPass ? '✅ KEY IS VIRGIN — All pages confirmed zero. Ready to program.' : anyFail ? '❌ NOT VIRGIN — One or more pages still have data. Retry the write.' : '⏳ Enter all read-back values to verify...'}</span>
            {(allPass || anyFail) && (
              <button
                onClick={() => { addVirginizeLogEntry({ chipId: liveChipId, chipFamily: 'HITAG AES', keyColor: 'black', result: allPass ? 'pass' : 'fail' }); onLogEntry && onLogEntry(); }}
                style={{ fontSize: 10, padding: '3px 10px', borderRadius: 4, background: allPass ? '#166534' : '#7f1d1d', color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0, fontWeight: 700 }}
              >
                📋 Log Result
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ background: '#0a0f1a', border: '1px solid #1e3a5f', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#aaa', lineHeight: 1.8 }}>
        <div style={{ color: '#A78BFA', fontWeight: 700, marginBottom: 6, fontSize: 12 }}>Autel Virginize Procedure — HITAG AES Black Key (PCF7953)</div>
        <div>1. Connect key to Autel → select <strong>HITAG AES → Fiat</strong></div>
        <div>2. Read chip — confirm Chip ID and SK0–SK3 are visible</div>
        <div>3. Write <strong>Config</strong> → <code style={{ color: '#F59E0B' }}>00000000</code></div>
        <div>4. Write <strong>Page 1</strong> → <code style={{ color: '#60A5FA' }}>00000000</code></div>
        <div>5. Write <strong>Page 2</strong> → <code style={{ color: '#60A5FA' }}>00000000</code></div>
        <div>6. <strong>Do NOT change SK0–SK3</strong> — leave at factory test pattern</div>
        <div>7. Re-read chip and paste values into the Verify checker above</div>
        <div style={{ marginTop: 8, color: '#555', fontSize: 10 }}>Source: A0CC096F bench-read 2026-06-09 (2021 Charger 6.2 Redeye black key, HITAG AES / PCF7953).</div>
      </div>
    </div>
  );
}
