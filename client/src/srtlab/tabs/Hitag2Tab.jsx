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

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import VehicleYearGuard from '../components/VehicleYearGuard.jsx';
import { PCF7945_53_VIRGIN_PROFILE, PCF7945_53_BLACK_VIRGIN_PROFILE, lookupChipReadByChipId } from '../lib/keyWriter/knownWorkingKeys.js';
import { addVirginizeLogEntry } from '../lib/virginizeLog.js';
import VirginizeLogPanel from '../components/VirginizeLogPanel.jsx';

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

/* ─── VirginizePanel component ─── */
function VirginizePanel({ copied, copy, chipId: liveChipId, onLogEntry }) {
  const [keyColor, setKeyColor] = useState('red');
  const [manualOverride, setManualOverride] = useState(false);

  // Auto-detect key color from live chip ID
  const detected = useMemo(() => lookupChipReadByChipId(liveChipId), [liveChipId]);
  const effectiveColor = (!manualOverride && detected) ? detected.keyColor : keyColor;

  // Verify checker state
  const [verifyConfig, setVerifyConfig]   = useState('');
  const [verifyPage0,  setVerifyPage0]    = useState('');
  const [verifyPage1,  setVerifyPage1]    = useState('');
  const [verifyPage2,  setVerifyPage2]    = useState('');
  const [verifyPage3,  setVerifyPage3]    = useState('');
  const profile = effectiveColor === 'red' ? PCF7945_53_VIRGIN_PROFILE : PCF7945_53_BLACK_VIRGIN_PROFILE;

  // Verify checker logic
  const verifyFields = [
    ['Config', verifyConfig, setVerifyConfig],
    ['Page 0', verifyPage0,  setVerifyPage0],
    ['Page 1', verifyPage1,  setVerifyPage1],
    ['Page 2', verifyPage2,  setVerifyPage2],
    ['Page 3', verifyPage3,  setVerifyPage3],
  ];
  const verifyResults = verifyFields.map(([label, val]) => {
    const norm = val.replace(/\s/g, '').toUpperCase();
    if (!norm) return { label, status: 'empty' };
    return { label, status: norm === '00000000' ? 'pass' : 'fail', val: norm };
  });
  const anyEntered = verifyFields.some(([, v]) => v.trim() !== '');
  const allPass = anyEntered && verifyResults.every(r => r.status === 'pass' || r.status === 'empty') && verifyResults.filter(r => r.status !== 'empty').length > 0;
  const anyFail = verifyResults.some(r => r.status === 'fail');
  const fields = [
    ['CONFIG PAGE', profile.config, '#F59E0B'],
    ['PAGE 0',      profile.page0,  '#60A5FA'],
    ['PAGE 1',      profile.page1,  '#60A5FA'],
    ['PAGE 2',      profile.page2,  '#60A5FA'],
    ['PAGE 3',      profile.page3,  '#60A5FA'],
  ];
  return (
    <Card style={{ marginTop: 16, background: '#0d1117', border: '1px solid #2d3748' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <div style={{ fontWeight: 700, color: '#F59E0B', fontSize: 13, letterSpacing: 1, flex: 1 }}>
          🔓 VIRGINIZE KEY — Restore to Factory Blank
        </div>
        {/* Key color selector */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {detected && !manualOverride && (
            <span style={{ fontSize: 10, color: '#34D399', background: '#0a2a1a', border: '1px solid #1a4a2a', borderRadius: 12, padding: '2px 8px' }}>
              ✓ Auto-detected: {detected.keyColor === 'red' ? 'Red' : 'Black'} key
            </span>
          )}
          <button
            onClick={() => { setKeyColor('red'); setManualOverride(true); }}
            style={{
              padding: '4px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
              background: effectiveColor === 'red' ? '#DC2626' : '#1a1a1a',
              color: effectiveColor === 'red' ? '#fff' : '#888',
              transition: 'all 160ms',
            }}
          >🔴 RED KEY</button>
          <button
            onClick={() => { setKeyColor('black'); setManualOverride(true); }}
            style={{
              padding: '4px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700,
              background: effectiveColor === 'black' ? '#374151' : '#1a1a1a',
              color: effectiveColor === 'black' ? '#fff' : '#888',
              border: effectiveColor === 'black' ? '1px solid #6B7280' : '1px solid #2a2a2a',
              transition: 'all 160ms',
            }}
          >⚫ BLACK KEY</button>
          {manualOverride && detected && (
            <button onClick={() => setManualOverride(false)} style={{ fontSize: 10, color: '#60A5FA', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Auto</button>
          )}
        </div>
      </div>

      <div style={{ color: '#888', fontSize: 11, marginBottom: 14, lineHeight: 1.6 }}>
        {effectiveColor === 'red'
          ? <>Confirmed blank profile for 2021 Charger 6.2 Redeye <strong style={{ color: '#DC2626' }}>red keys</strong> (PCF7945/53, HITAG 2). 5 keys bench-read 2026-06-09.</>
          : <>Confirmed blank profile for 2021 Charger 6.2 Redeye <strong style={{ color: '#9CA3AF' }}>black keys</strong> (PCF7945/53, HITAG 2). 5 keys bench-read 2026-06-09.</>}
        {' '}<strong style={{ color: '#F59E0B' }}>SK stays at MIKRON default — do not change it.</strong>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        {fields.map(([label, val, col]) => (
          <div key={label} style={{ background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 15, color: col, fontWeight: 700, flex: 1 }}>{val}</span>
              <Btn onClick={() => copy(val, 'vg-' + label)} style={{ fontSize: 10, padding: '3px 8px', flexShrink: 0 }}>
                {copied === 'vg-' + label ? '✓' : 'Copy'}
              </Btn>
            </div>
          </div>
        ))}
        <div style={{ background: '#0a0a0a', border: '1px solid #1a3a1a', borderRadius: 6, padding: '8px 12px' }}>
          <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>LOW SK — DO NOT CHANGE</div>
          <div style={{ fontFamily: 'monospace', fontSize: 15, color: '#34D399', fontWeight: 700 }}>{profile.lowSk}</div>
          <div style={{ color: '#444', fontSize: 10, marginTop: 2 }}>MIKRON default — leave as-is</div>
        </div>
        <div style={{ background: '#0a0a0a', border: '1px solid #1a3a1a', borderRadius: 6, padding: '8px 12px' }}>
          <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>HIGH SK — DO NOT CHANGE</div>
          <div style={{ fontFamily: 'monospace', fontSize: 15, color: '#34D399', fontWeight: 700 }}>{profile.highSk}</div>
          <div style={{ color: '#444', fontSize: 10, marginTop: 2 }}>MIKRON default — leave as-is</div>
        </div>
      </div>

      {/* ─── Post-Virginize Verify Checker ─── */}
      <div style={{ background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 6, padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ color: '#A78BFA', fontWeight: 700, marginBottom: 8, fontSize: 12 }}>✅ POST-VIRGINIZE VERIFY — Paste read-back values to confirm all zeros</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 8 }}>
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
                onClick={() => { addVirginizeLogEntry({ chipId: liveChipId, chipFamily: 'PCF7945/53', keyColor: effectiveColor, result: allPass ? 'pass' : 'fail' }); onLogEntry && onLogEntry(); }}
                style={{ fontSize: 10, padding: '3px 10px', borderRadius: 4, background: allPass ? '#166534' : '#7f1d1d', color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0, fontWeight: 700 }}
              >
                📋 Log Result
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ background: '#0a0f1a', border: '1px solid #1e3a5f', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#aaa', lineHeight: 1.8 }}>
        <div style={{ color: '#60A5FA', fontWeight: 700, marginBottom: 6, fontSize: 12 }}>Autel Virginize Procedure — {effectiveColor === 'red' ? 'Red Key (PCF7945/53)' : 'Black Key (PCF7945/53)'}</div>
        <div>1. Open Autel → HITAG 2 → Chip info</div>
        <div>2. Verify Low SK = <span style={{ fontFamily: 'monospace', color: '#34D399' }}>4D494B52</span> and High SK = <span style={{ fontFamily: 'monospace', color: '#34D399' }}>4F4E</span> (MIKRON default). If different, key has custom SK — cannot freely write.</div>
        <div>3. Write Config page → <span style={{ fontFamily: 'monospace', color: '#F59E0B' }}>00000000</span></div>
        <div>4. Write Page 0 → <span style={{ fontFamily: 'monospace', color: '#60A5FA' }}>00000000</span></div>
        <div>5. Write Page 1 → <span style={{ fontFamily: 'monospace', color: '#60A5FA' }}>00000000</span></div>
        <div>6. Write Page 2 → <span style={{ fontFamily: 'monospace', color: '#60A5FA' }}>00000000</span></div>
        <div>7. Write Page 3 → <span style={{ fontFamily: 'monospace', color: '#60A5FA' }}>00000000</span></div>
        <div>8. Read back all pages to confirm all zeros. Key is now virgin and ready to program to a new vehicle.</div>
        {effectiveColor === 'black' && (
          <div style={{ marginTop: 6, color: '#F59E0B' }}>
            ⚠️ Note: Black key <strong>0236B59C</strong> showed Config=08AA4854 and Page1/Page2 matching the red key FCA pattern — may have been cross-programmed. Virginize procedure is the same regardless.
          </div>
        )}
        <div style={{ marginTop: 8, color: '#666' }}>
          {effectiveColor === 'red'
            ? 'Sources: CF324E65 blank bench-read 2026-06-04. 4 programmed red keys cross-referenced 2026-06-09.'
            : 'Sources: 5 black key bench-reads 2026-06-09 (6D0EF991, 5E478092, 8748C092, 6B470092, 0236B59C).'}
        </div>
      </div>
    </Card>
  );
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

/* ─── Tooltip component ─── */
function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef(null);

  const show = useCallback((e) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      setPos({ x: rect.left, y: rect.bottom + 6 });
    }
    setVisible(true);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'contents' }}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && text && (
        <div style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          zIndex: 9999,
          background: '#1a1f35',
          border: '1px solid #3a4060',
          borderRadius: 6,
          padding: '7px 11px',
          fontSize: 11,
          color: '#c8cfe8',
          maxWidth: 280,
          lineHeight: 1.55,
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          pointerEvents: 'none',
          whiteSpace: 'pre-line',
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

/* ─── TooltipField — label + tooltip icon + input ─── */
function TooltipField({ label, tooltip, children, style }) {
  return (
    <div style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
        <span style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
        <Tooltip text={tooltip}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, borderRadius: '50%',
            background: '#2a3050', border: '1px solid #3a4060',
            color: '#7080b0', fontSize: 9, fontWeight: 700,
            cursor: 'help', userSelect: 'none', flexShrink: 0,
          }}>?</span>
        </Tooltip>
      </div>
      {children}
    </div>
  );
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

/* ─── field tooltip content ─── */
const FIELD_TIPS = {
  chipId:     'Chip UID — 8 hex digits (4 bytes).\nRead from VVDI Prog: HITAG 2 → Chip info → Chip ID.\nExample: 437C2C9F\nUnique per physical chip — used to identify the transponder.',
  configPage: 'Config / Password page — 8 hex digits.\nRead from VVDI Prog: HITAG 2 → Chip info → Config page.\nFactory default: 08AA4854\nBit 0 of byte 0 = lock bit. If set, chip cannot be rewritten.',
  lowSk:      'Low SK — first 4 bytes (8 hex digits) of the 6-byte secret key.\nRead from VVDI Prog: HITAG 2 → Chip info → Low SK.\nMikron default: 4D494B52 (not vehicle-specific).\nThis is the lower half of the 48-bit crypto key.',
  highSk:     'High SK — last 2 bytes (4 hex digits) of the 6-byte secret key.\nRead from VVDI Prog: HITAG 2 → Chip info → High SK.\nMikron default: 4F4E\nCombined with Low SK: Low(4B) + High(2B) = 6-byte SK.',
  page0:      'Page 0 — 8 hex digits (4 bytes).\nFactory blank pattern: AABBCCDD\nContains manufacturer data. Rarely changes after personalization.\nIf this still reads AABBCCDD the chip has never been programmed.',
  page1:      'Page 1 — 8 hex digits (4 bytes).\nThis is the PRIMARY SK SOURCE used for 6-byte SK derivation.\nFactory blank: 00000000\nAfter programming: contains the vehicle-specific secret (first 4 bytes of 6-byte SK).',
  page2:      'Page 2 — 8 hex digits (4 bytes).\nThe HIGH WORD (first 2 bytes) of Page 2 is the 5th and 6th bytes of the 6-byte SK.\n6-byte SK = Page1 (4B) + Page2[0:2] (2B)\nFactory blank: 00000000',
  page3:      'Page 3 — 8 hex digits (4 bytes).\nContains additional transponder data (counter, flags).\nNot used in SK derivation but required for a complete chip read.\nExample: FF6CEA60',
};

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

  /* ── virginize log refresh trigger ── */
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const handleLogEntry = useCallback(() => setLogRefreshKey(k => k + 1), []);

  /* ── virginize prefill banner (from RFHUB slot-table shortcut) ── */
  const [prefillBanner, setPrefillBanner] = useState(null);

  useEffect(() => {
    function consumePrefill() {
      try {
        const raw = sessionStorage.getItem('srtlab:virginize:prefill');
        if (!raw) return;
        sessionStorage.removeItem('srtlab:virginize:prefill');
        const payload = JSON.parse(raw);
        // Only consume if the payload is fresh (within 30 seconds)
        if (!payload || !payload.chipId || Date.now() - (payload.ts || 0) > 30000) return;
        const { entry, keyColor, chipFamily } = payload;
        // Pre-fill the chip ID field
        if (payload.chipId) setChipId(payload.chipId);
        // Pre-fill the page data from the corpus entry if available
        if (entry) {
          if (entry.lowSk)  setLowSk(entry.lowSk);
          if (entry.highSk) setHighSk(entry.highSk.replace(/^00004F4E$/i, '4F4E').slice(0, 4) || entry.highSk);
          if (entry.config) setConfigPage(entry.config);
          if (entry.page0)  setPage0(entry.page0);
          if (entry.page1)  setPage1(entry.page1);
          if (entry.page2)  setPage2(entry.page2);
          if (entry.page3)  setPage3(entry.page3);
        }
        setPrefillBanner({
          chipId: payload.chipId,
          keyColor: keyColor || 'unknown',
          chipFamily: chipFamily || 'PCF7945/53',
          fromSlot: payload.fromSlot,
          state: entry?.state || 'unknown',
        });
      } catch { /* ignore */ }
    }
    // Consume on mount (tab was just opened)
    consumePrefill();
    // Also consume when the tab becomes visible (user switches to it)
    const onVisible = () => { if (document.visibilityState === 'visible') consumePrefill(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

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
      const dataUrl = ev.target.result;
      setPhotoPreview(dataUrl);
      try {
        const res = await fetch('/api/anthropic/key-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: dataUrl, mediaType: file.type || 'image/png' }),
        });
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

      {/* Virginize prefill banner */}
      {prefillBanner && (
        <div style={{
          marginBottom: 16, padding: '10px 14px', borderRadius: 8,
          background: '#FF6B0015', border: '1.5px solid #FF6B0060',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ fontSize: 12, color: '#FF6B00', fontFamily: 'monospace' }}>
            <span style={{ fontWeight: 800, marginRight: 8 }}>⚡ VIRGINIZE PREFILL</span>
            Chip <strong>{prefillBanner.chipId}</strong>
            {' '}—{' '}
            {prefillBanner.keyColor === 'red' ? '🔴 RED KEY' : '⚫ BLACK KEY'}
            {' '}—{' '}
            {prefillBanner.state === 'programmed' ? 'Programmed (corpus-confirmed)' : 'State: ' + prefillBanner.state}
            {prefillBanner.fromSlot != null && ` — from RFHUB slot ${prefillBanner.fromSlot}`}
            <span style={{ marginLeft: 10, color: '#aaa', fontWeight: 400 }}>
              Fields pre-filled from corpus. Scroll down to Virginize panel to verify.
            </span>
          </div>
          <button
            onClick={() => setPrefillBanner(null)}
            style={{ background: 'none', border: 'none', color: '#FF6B00', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

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
              <TooltipField label="Chip ID" tooltip={FIELD_TIPS.chipId} style={fieldRow}>
                <input style={inputStyle} value={chipId} onChange={e => setChipId(e.target.value.toUpperCase())} maxLength={8} placeholder="437C2C9F" />
              </TooltipField>
              <TooltipField label="Config Page" tooltip={FIELD_TIPS.configPage} style={fieldRow}>
                <input style={inputStyle} value={configPage} onChange={e => setConfigPage(e.target.value.toUpperCase())} maxLength={8} placeholder="08AA4854" />
              </TooltipField>
              <TooltipField label="Low SK (4 bytes)" tooltip={FIELD_TIPS.lowSk} style={fieldRow}>
                <input style={inputStyle} value={lowSk} onChange={e => setLowSk(e.target.value.toUpperCase())} maxLength={8} placeholder="4D494B52" />
              </TooltipField>
              <TooltipField label="High SK (2 bytes)" tooltip={FIELD_TIPS.highSk} style={fieldRow}>
                <input style={inputStyle} value={highSk} onChange={e => setHighSk(e.target.value.toUpperCase())} maxLength={4} placeholder="4F4E" />
              </TooltipField>
            </div>

            <div style={{ fontWeight: 700, color: '#555', fontSize: 10, margin: '8px 0 8px', letterSpacing: 1 }}>CHIP DATA PAGES</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
              {[
                ['Page 0', page0, setPage0, FIELD_TIPS.page0],
                ['Page 1', page1, setPage1, FIELD_TIPS.page1],
                ['Page 2', page2, setPage2, FIELD_TIPS.page2],
                ['Page 3', page3, setPage3, FIELD_TIPS.page3],
              ].map(([label, val, setter, tip]) => (
                <TooltipField key={label} label={label} tooltip={tip} style={fieldRow}>
                  <input style={inputStyle} value={val} onChange={e => setter(e.target.value.toUpperCase())} maxLength={8} placeholder="00000000" />
                </TooltipField>
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

      {/* ─── Virginize Key Panel ─── */}
      <VirginizePanel copied={copied} copy={copy} chipId={chipId} onLogEntry={handleLogEntry} />

      {/* ─── Virginize Session Log ─── */}
      <VirginizeLogPanel refreshKey={logRefreshKey} />

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
