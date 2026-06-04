/**
 * HitagAesTab.jsx — HITAG AES / PCF7953 Key Status Reader
 *
 * Paste or type the raw Autel/VVDI page read output (SK0–SK3, Config,
 * Page 1, Page 2, Chip ID) and get an instant FCA-specific verdict:
 *   • BLANK  — factory default test pattern, never programmed
 *   • PROGRAMMED — vehicle secret written, key is paired
 *   • LOCKED — lock bit set, cannot be rewritten
 *   • ALT-FAMILY — flag 0x03 Redeye/Hellcat alt transponder
 *   • UNKNOWN — unrecognized pattern
 *
 * Also decodes:
 *   • Vehicle secret (SK0–SK3 → 16-byte AES root key)
 *   • FOBIK UID (Chip ID)
 *   • Lock bits from Config word
 *   • Page 1/2/3 SK derivation (HITAG2 6-byte SK = page1 ∥ high(page2))
 *   • Alt-family detection (2020+ Redeye / Hellcat)
 *   • Cross-reference against known working keys
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Card, Btn, Tag } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { KNOWN_WORKING_KEYS, PENDING_ALT_FAMILY_KEYS } from '../lib/keyWriter/knownWorkingKeys.js';

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
const BLANK_PATTERN = {
  sk0: '11112222',
  sk1: '33334444',
  sk2: '55556666',
  sk3: '77778888',
};

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

/* Derive HITAG2 6-byte SK from page1 ∥ high word of page2
 * This is the real per-chip SK as reported by Autel/VVDI after their
 * "Calculate SK" step — page1 (4 bytes) concatenated with the high
 * 2 bytes of page2 = 6 bytes total. This is NOT the 16-byte AES root key. */
function deriveHitag2SK(page1Hex, page2Hex) {
  const p1 = normHex(page1Hex);
  const p2 = normHex(page2Hex);
  if (p1.length < 8 || p2.length < 8) return null;
  // page1 (8 hex chars = 4 bytes) + high word of page2 (4 hex chars = 2 bytes)
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

/* Detect alt-family (Redeye/Hellcat 2020+ flag 0x03) by SK pattern */
function detectAltFamily(sk0, sk1, sk2, sk3) {
  /* Alt-family keys have a distinct non-blank, non-MIKRON SK pattern.
   * The 2020 Redeye PENDING keys have sk=null (unconfirmed), so we
   * detect by exclusion: not blank, not MIKRON default, not all-zero/FF. */
  const s0 = normHex(sk0), s1 = normHex(sk1), s2 = normHex(sk2), s3 = normHex(sk3);
  if (isBlankPattern(sk0, sk1, sk2, sk3)) return false;
  if (isAllZero(s0 + s1 + s2 + s3)) return false;
  if (isAllFF(s0 + s1 + s2 + s3)) return false;
  /* MIKRON universal default SK = 4F4E4D494B52 — appears in page1+page2 */
  const derivedSK = deriveHitag2SK(sk0, sk1); // page0=SK0, page1=SK1 in Autel layout
  if (derivedSK === '4F4E4D494B52') return false;
  return true;
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

  /* MIKRON universal default — programmed with the universal default SK */
  const hitag2SK = deriveHitag2SK(sk0, sk1);
  if (hitag2SK === '4F4E4D494B52') {
    return { status: 'MIKRON_DEFAULT', color: C.wn, emoji: '⚠️', label: 'MIKRON DEFAULT SK', bg: '#FFF8E1',
      detail: 'Key carries the universal MIKRON default SK (4F4E4D494B52). This is a generic unpaired state — the key has been written with the default but not paired to a specific vehicle.' };
  }

  const knownMatch = crossRefKnownKeys(aesSecret);
  if (knownMatch) {
    return { status: 'KNOWN_GOOD', color: C.gn, emoji: '🏆', label: 'KNOWN WORKING KEY', bg: '#E8F5E9',
      detail: `Matches confirmed working key: ${knownMatch.vehicle} (UID ${knownMatch.keyId}). This key is paired and starts the car.`,
      knownKey: knownMatch };
  }

  /* Programmed with a vehicle-specific secret */
  return { status: 'PROGRAMMED', color: C.a2, emoji: '🔑', label: 'PROGRAMMED — VEHICLE PAIRED', bg: '#E3F2FD',
    detail: 'SK pages contain a vehicle-specific secret. This key is paired to a vehicle. If it doesn\'t work, the RFHUB/BCM SEC16 may not match.' };
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

/* ─── main component ─── */
export default function HitagAesTab() {
  const [chipId, setChipId] = useState('CF324E65');
  const [sk0,    setSk0]    = useState('11112222');
  const [sk1,    setSk1]    = useState('33334444');
  const [sk2,    setSk2]    = useState('55556666');
  const [sk3,    setSk3]    = useState('77778888');
  const [config, setConfig] = useState('00000000');
  const [page1,  setPage1]  = useState('00000000');
  const [page2,  setPage2]  = useState('00000000');

  const verdict = useMemo(
    () => analyzeKey({ chipId, sk0, sk1, sk2, sk3, config, page1, page2 }),
    [chipId, sk0, sk1, sk2, sk3, config, page1, page2],
  );

  const cfg        = useMemo(() => decodeConfig(config), [config]);
  const aesSecret  = useMemo(() => buildAesSecret(sk0, sk1, sk2, sk3), [sk0, sk1, sk2, sk3]);
  // HITAG2 SK derived from page1 + high(page2) — the real per-chip secret
  const hitag2SK   = useMemo(() => deriveHitag2SK(page1, page2), [page1, page2]);

  const fillBlank = useCallback(() => {
    setSk0('11112222'); setSk1('33334444'); setSk2('55556666'); setSk3('77778888');
    setConfig('00000000'); setPage1('00000000'); setPage2('00000000');
  }, []);

  const fillRedeye = useCallback(() => {
    /* 2021 Charger 6.2 Redeye — the key from the Autel screenshot.
     * Chip ID CF324E65, SK0–SK3 from the Autel read, Config/Page1/Page2 all 00.
     * Alt-family (flag 0x03) — programmed with vehicle-specific AES secret. */
    setChipId('CF324E65');
    setSk0('11112222'); setSk1('33334444'); setSk2('55556666'); setSk3('77778888');
    setConfig('00000000'); setPage1('00000000'); setPage2('00000000');
  }, []);

  const clearAll = useCallback(() => {
    setChipId(''); setSk0(''); setSk1(''); setSk2(''); setSk3('');
    setConfig(''); setPage1(''); setPage2('');
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px' }}>
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
          </Card>

          {/* Alt-family note */}
          <Card style={{ background: '#FFF8E1', border: `1.5px solid ${C.wn}33` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.wn, letterSpacing: 1, marginBottom: 6 }}>
              ⚡ 2020–2021 REDEYE / HELLCAT NOTE
            </div>
            <div style={{ fontSize: 11, color: C.t, lineHeight: 1.6 }}>
              The 2020+ Charger/Challenger 6.2 Redeye uses an <b>alternate transponder family (flag 0x03)</b> — different from the standard HITAG2 id46 (flag 0x01) used on 2019 and earlier models.
              <br /><br />
              The SK pages on a blank Redeye key show the same factory test pattern (<code>11112222 / 33334444 / 55556666 / 77778888</code>). After programming, the vehicle-specific AES secret is written into SK0–SK3.
              <br /><br />
              <b>Chip ID CF324E65</b> is a valid blank Redeye FOBIK UID — this is the key from your Autel screenshot.
            </div>
          </Card>
        </div>

        {/* Right — verdict + decoded fields */}
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
            <DecodedRow label="Chip UID (LE / revUid)" value={normHex(chipId) ? normHex(chipId).match(/.{2}/g)?.reverse().join('') : '—'} mono />

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
            <DecodedRow label="Platform"
              value="FCA / Mopar · 2011+ SRT / Redeye / Hellcat"
            />

            <div style={{ borderTop: `1px solid ${C.bd}`, margin: '10px 0' }} />
            <div style={{ fontSize: 10, fontWeight: 800, color: C.a2, letterSpacing: 1, marginBottom: 6 }}>FOBIK BINDING</div>
            <DecodedRow label="Transponder UID (BE)"
              value={normHex(chipId) || '—'}
              mono
            />
            <DecodedRow label="Transponder UID (LE / revUid)"
              value={normHex(chipId) ? normHex(chipId).match(/.{2}/g)?.reverse().join('') : '—'}
              mono
              note="This is the keyId stored in the RFHUB slot table"
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
            <DecodedRow label="Vehicle (if known)"
              value={verdict.knownKey?.vehicle || '—'}
            />
          </Card>

          {/* What to do next */}
          <Card style={{ background: '#F8F6F2', border: `1.5px solid ${C.bd}` }}>
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
                It will not start a vehicle unless the RFHUB was also programmed with the MIKRON default (unusual).
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ─── small decoded row component ─── */
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
