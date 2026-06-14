/* KeyWorkflowTab.jsx — Unified key programming workflow for FCA Charger/Challenger/SRT
 *
 * Four guided steps:
 *   Step 1 — Load modules (BCM + RFHUB + PCM) with auto-detect and triage
 *   Step 2 — SKC / PIN derivation from BCM SEC16, with manual override and copy
 *   Step 3 — Transponder pairing: slot status grid + add key to RFHUB + download
 *   Step 4 — Seed key sync verification: BCM→RFHUB→PCM chain check + one-click fix
 *
 * All write logic reuses existing lib primitives. This tab is the workflow
 * coordinator — it never re-implements algorithms.
 */
import React, { useState, useCallback, useMemo, useRef } from 'react';
import { Card, Btn, Tag } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { dl } from '../components/ImmoChecksumPanel.jsx';
import { parseModule, resolveBcmSec16, pcmChipFromSize } from '../lib/parseModule.js';
import { parseKeySlots, KEY_SLOT_COUNT, firstFreeSlot, addSlot } from '../lib/rfhubKeySlots.js';
import { pinFromSec16 } from '../lib/liveImmo.js';
import { deriveAllFromBcm } from '../lib/immoSecret.js';
import { writeRfhSec16FromBcm, writePcmSec6 } from '../lib/securityBytes.js';
import { useMasterVin } from '../lib/masterVinContext.jsx';
import CharRfhubKeyAdderPanel from '../components/CharRfhubKeyAdderPanel.jsx';
import VehicleYearGuard from '../components/VehicleYearGuard.jsx';

const mono = "'JetBrains Mono'";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
function hexBytes(arr) {
  if (!arr) return '—';
  return Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function copyText(s) {
  try { navigator.clipboard.writeText(s); } catch { /* ignore */ }
}

/* ─── Step header ─────────────────────────────────────────────────────────── */
function StepHeader({ num, title, status }) {
  const col = status === 'done' ? C.gn : status === 'active' ? C.a3 : C.tm;
  const icon = status === 'done' ? '✓' : status === 'active' ? num : '○';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: col + '20', border: '2px solid ' + col,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 900, fontSize: 13, color: col,
      }}>{icon}</div>
      <div style={{ fontWeight: 900, fontSize: 14, color: col, letterSpacing: 1 }}>{title}</div>
    </div>
  );
}

/* ─── Module file slot ─────────────────────────────────────────────────────── */
function ModuleSlot({ label, color, parsed, onLoad, onClear }) {
  const inputRef = useRef(null);
  function handleDrop(e) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) onLoad(f);
  }
  function handlePick(e) {
    const f = e.target.files[0];
    if (f) onLoad(f);
  }
  const vin = parsed?.info?.vins?.[0]?.vin || parsed?.info?.vin || null;
  const size = parsed ? `${parsed.data.length} B` : null;
  const chip = parsed ? (pcmChipFromSize?.(parsed.data.length) || parsed.type) : null;
  return (
    <div
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onClick={() => !parsed && inputRef.current?.click()}
      style={{
        flex: 1, minWidth: 180, padding: '12px 14px', borderRadius: 12,
        border: `2px dashed ${parsed ? color + '80' : C.bd}`,
        background: parsed ? color + '08' : C.c2,
        cursor: parsed ? 'default' : 'pointer',
        transition: 'all 0.2s',
        position: 'relative',
      }}
    >
      <input ref={inputRef} type="file" accept=".bin,.hex" style={{ display: 'none' }} onChange={handlePick} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontWeight: 900, fontSize: 11, color, letterSpacing: 1 }}>{label}</span>
        {parsed && <span style={{ fontSize: 10, color: C.ts }}>{chip} · {size}</span>}
        {parsed && (
          <button
            onClick={e => { e.stopPropagation(); onClear(); }}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: C.tm, fontSize: 14, lineHeight: 1 }}
            title="Clear"
          >×</button>
        )}
      </div>
      {parsed ? (
        <div style={{ fontSize: 10, fontFamily: mono, color: C.ts }}>
          {vin ? <span style={{ color: C.tx, fontWeight: 700 }}>{vin}</span> : <span style={{ color: C.wn }}>No VIN</span>}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: C.tm }}>Drop .bin or click to browse</div>
      )}
    </div>
  );
}

/* ─── Slot grid ───────────────────────────────────────────────────────────── */
function SlotGrid({ slots, loading }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, margin: '8px 0' }}>
      {Array.from({ length: KEY_SLOT_COUNT }, (_, i) => {
        const s = slots?.[i];
        const occupied = s?.occupied;
        return (
          <div key={i} style={{
            padding: '10px 8px', borderRadius: 10, textAlign: 'center',
            background: loading ? C.c2 : (occupied ? C.gn + '18' : C.c2),
            border: `1.5px solid ${loading ? C.bd : occupied ? C.gn + '55' : C.bd}`,
          }}>
            <div style={{ fontSize: 20, marginBottom: 2 }}>{occupied ? '🗝️' : '⬜'}</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: occupied ? C.gn : C.tm }}>
              SLOT {i + 1}
            </div>
            <div style={{ fontSize: 9, color: C.tm }}>
              {loading ? '…' : (occupied ? 'OCCUPIED' : 'FREE')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Chain row ───────────────────────────────────────────────────────────── */
function ChainRow({ label, expected, actual, ok }) {
  const col = ok === null ? C.tm : ok ? C.gn : C.er;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px',
      borderRadius: 8, background: col + '0A', border: '1px solid ' + col + '30',
      marginBottom: 6,
    }}>
      <div style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
        {ok === null ? '○' : ok ? '✓' : '✗'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 11, color: col, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 10, fontFamily: mono, color: C.ts, wordBreak: 'break-all' }}>
          {expected ? <span>Expected: <span style={{ color: C.tx }}>{expected}</span></span> : null}
        </div>
        {actual && (
          <div style={{ fontSize: 10, fontFamily: mono, color: C.ts, wordBreak: 'break-all' }}>
            Actual: <span style={{ color: ok ? C.gn : C.er }}>{actual}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Main component
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function KeyWorkflowTab({ vehicle }) {
  const { vin: masterVin } = useMasterVin();

  /* ── Step 1: module files ── */
  const [bcmParsed, setBcmParsed]   = useState(null);
  const [rfhParsed, setRfhParsed]   = useState(null);
  const [pcmParsed, setPcmParsed]   = useState(null);

  /* ── Step 2: SKC/PIN ── */
  const [pinOverride, setPinOverride] = useState('');
  const [pinCopied, setPinCopied]     = useState(false);

  /* ── Step 3: transponder pairing ── */
  const [rfhPatched, setRfhPatched] = useState(null); // patched RFHUB bytes from CharRfhubKeyAdderPanel

  /* ── Step 4: sync fix ── */
  const [fixBusy, setFixBusy]       = useState(false);
  const [fixResult, setFixResult]   = useState(null);

  /* ─── load a module file ─────────────────────────────────────────────── */
  const loadFile = useCallback((file, setter) => {
    const reader = new FileReader();
    reader.onload = e => {
      const bytes = new Uint8Array(e.target.result);
      const parsed = parseModule(bytes, file.name);
      setter(parsed);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  /* ─── BCM SEC16 resolution ───────────────────────────────────────────── */
  const bcmSec16 = useMemo(() => {
    if (!bcmParsed?.data) return null;
    const r = resolveBcmSec16(bcmParsed.data);
    return r?.bytes || null;
  }, [bcmParsed]);

  /* ─── RFHUB SEC16 ────────────────────────────────────────────────────── */
  const rfhSec16 = useMemo(() => {
    if (!rfhParsed?.data) return null;
    const parsed = parseKeySlots(rfhParsed.data);
    if (!parsed.ok) return null;
    const slot = parsed.sec16?.slots?.[0];
    return slot?.raw || null;
  }, [rfhParsed]);

  /* ─── PCM SEC6 ───────────────────────────────────────────────────────── */
  const pcmSec6 = useMemo(() => {
    if (!pcmParsed?.data) return null;
    const d = pcmParsed.data;
    if (d.length < 0x3CE) return null;
    const marker = d.slice(0x3C4, 0x3C8);
    const markerOk = marker[0] === 0xFF && marker[1] === 0xFF && marker[2] === 0xFF && marker[3] === 0xAA;
    if (!markerOk) return null;
    return d.slice(0x3C8, 0x3CE);
  }, [pcmParsed]);

  /* ─── Derived PIN from BCM SEC16 ─────────────────────────────────────── */
  const derivedPin = useMemo(() => {
    if (!bcmSec16) return null;
    // BCM SEC16 is byte-reversed vs RFH SEC16. PIN lives at RFH[14:15].
    // rfhSec16 = reverse(bcmSec16), so rfh[14] = bcm[1], rfh[15] = bcm[0].
    const rfh = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rfh[i] = bcmSec16[15 - i];
    return pinFromSec16(rfh);
  }, [bcmSec16]);

  /* Also derive from RFHUB SEC16 directly if available */
  const rfhPin = useMemo(() => rfhSec16 ? pinFromSec16(rfhSec16) : null, [rfhSec16]);

  const activePin = pinOverride.length === 5 ? pinOverride : (derivedPin || rfhPin || null);

  /* ─── RFHUB key slots ────────────────────────────────────────────────── */
  const rfhSlots = useMemo(() => {
    const src = rfhPatched || rfhParsed?.data;
    if (!src) return null;
    const r = parseKeySlots(src);
    return r.ok ? r.slots : null;
  }, [rfhParsed, rfhPatched]);

  /* ─── Seed key sync chain verification ──────────────────────────────── */
  const chainVerdict = useMemo(() => {
    if (!bcmSec16) return null;
    const derived = deriveAllFromBcm(bcmSec16);
    const rfhExpected = hexBytes(derived.rfhubSec16);
    const pcmExpected = hexBytes(derived.pcmSec6);
    const rfhActual   = rfhSec16 ? hexBytes(rfhSec16) : null;
    const pcmActual   = pcmSec6  ? hexBytes(pcmSec6)  : null;
    const rfhMatch = rfhActual
      ? Array.from(derived.rfhubSec16).every((b, i) => b === rfhSec16[i])
      : null;
    const pcmMatch = pcmActual
      ? Array.from(derived.pcmSec6).every((b, i) => b === pcmSec6[i])
      : null;
    return { derived, rfhExpected, pcmExpected, rfhActual, pcmActual, rfhMatch, pcmMatch };
  }, [bcmSec16, rfhSec16, pcmSec6]);

  const chainOk = chainVerdict
    ? (chainVerdict.rfhMatch !== false && chainVerdict.pcmMatch !== false)
    : null;

  /* ─── Apply sync fix ─────────────────────────────────────────────────── */
  const applyFix = useCallback(async () => {
    if (!bcmSec16) return;
    setFixBusy(true);
    setFixResult(null);
    try {
      const derived = deriveAllFromBcm(bcmSec16);
      const results = [];

      // Fix RFHUB
      if (rfhParsed?.data && chainVerdict?.rfhMatch === false) {
        const r = writeRfhSec16FromBcm(new Uint8Array(rfhParsed.data), bcmSec16);
        if (r?.ok) {
          const name = (rfhParsed.filename || 'RFHUB').replace(/\.bin$/i, '') + '_SEC16_FIXED.bin';
          dl(r.patched, name);
          results.push({ module: 'RFHUB', ok: true, name });
        } else {
          results.push({ module: 'RFHUB', ok: false, error: r?.error || 'Write failed' });
        }
      }

      // Fix PCM
      if (pcmParsed?.data && chainVerdict?.pcmMatch === false) {
        const r = writePcmSec6(new Uint8Array(pcmParsed.data), derived.rfhubSec16);
        if (r?.ok) {
          const name = (pcmParsed.filename || 'PCM').replace(/\.bin$/i, '') + '_SEC6_FIXED.bin';
          dl(r.patched, name);
          results.push({ module: 'PCM', ok: true, name });
        } else {
          results.push({ module: 'PCM', ok: false, error: r?.error || 'Write failed' });
        }
      }

      setFixResult(results);
    } catch (e) {
      setFixResult([{ module: 'ERROR', ok: false, error: e?.message || String(e) }]);
    } finally {
      setFixBusy(false);
    }
  }, [bcmSec16, rfhParsed, pcmParsed, chainVerdict]);

  /* ─── Step statuses ──────────────────────────────────────────────────── */
  const step1Done = !!(bcmParsed || rfhParsed || pcmParsed);
  const step2Done = !!activePin;
  const step3Done = !!rfhPatched;
  const step4Done = chainOk === true;

  /* ─── Render ─────────────────────────────────────────────────────────── */
  return (
    <div data-testid="key-workflow-tab" style={{ maxWidth: 860, margin: '0 auto' }}>
      <VehicleYearGuard vehicle={vehicle || null} />

      {/* ── Header ── */}
      <Card style={{
        background: 'linear-gradient(135deg,#1A237E 0%,#283593 40%,#3949AB 100%)',
        color: '#fff', marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32 }}>🔑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2 }}>
              KEY PROGRAMMING WORKFLOW
            </div>
            <div style={{ fontSize: 10, opacity: 0.75, letterSpacing: 3, fontWeight: 700 }}>
              BCM · RFHUB · PCM · SKC · TRANSPONDER · SEED KEY SYNC
            </div>
          </div>
          {masterVin && (
            <div style={{
              fontFamily: mono, fontSize: 12, fontWeight: 900,
              background: 'rgba(255,255,255,0.15)', padding: '4px 10px', borderRadius: 8,
            }}>{masterVin}</div>
          )}
        </div>
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          STEP 1 — Load Modules
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <StepHeader num="1" title="LOAD MODULE FILES" status={step1Done ? 'done' : 'active'} />
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          Load the BCM (65 KB), RFHUB (4 KB), and PCM/GPEC2A (4 KB or 8 KB) dumps from the vehicle.
          The BCM is the <strong>source of truth</strong> — its SEC16 drives the entire derivation chain.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <ModuleSlot
            label="BCM · SOURCE OF TRUTH"
            color={C.sr}
            parsed={bcmParsed}
            onLoad={f => loadFile(f, setBcmParsed)}
            onClear={() => setBcmParsed(null)}
          />
          <ModuleSlot
            label="RFHUB / SKREEM"
            color={C.a3}
            parsed={rfhParsed}
            onLoad={f => loadFile(f, setRfhParsed)}
            onClear={() => setRfhParsed(null)}
          />
          <ModuleSlot
            label="PCM / GPEC2A"
            color={C.a2}
            parsed={pcmParsed}
            onLoad={f => loadFile(f, setPcmParsed)}
            onClear={() => setPcmParsed(null)}
          />
        </div>

        {/* Per-module triage output */}
        {(bcmParsed || rfhParsed || pcmParsed) && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { label: 'BCM', parsed: bcmParsed, color: C.sr },
              { label: 'RFHUB', parsed: rfhParsed, color: C.a3 },
              { label: 'PCM', parsed: pcmParsed, color: C.a2 },
            ].filter(m => m.parsed).map(({ label, parsed, color }) => {
              const type = parsed.type || 'UNKNOWN';
              const size = parsed.data?.length || 0;
              const ok = parsed.ok !== false;
              const warn = parsed.warn || parsed.error || null;
              const vin = parsed.info?.vins?.[0]?.vin || parsed.info?.vin || null;
              const sec16 = label === 'BCM' ? (bcmSec16 ? 'SEC16 ✓' : 'SEC16 blank') : null;
              const rfhSlotCount = label === 'RFHUB' ? (rfhSlots?.filter(s => s.occupied).length ?? 0) : null;
              return (
                <div key={label} style={{
                  flex: 1, minWidth: 160, padding: '8px 12px', borderRadius: 10,
                  background: ok ? color + '08' : C.er + '08',
                  border: '1px solid ' + (ok ? color + '40' : C.er + '40'),
                }}>
                  <div style={{ fontWeight: 900, fontSize: 10, color, marginBottom: 4, letterSpacing: 1 }}>
                    {label} — {type} · {size.toLocaleString()} B
                  </div>
                  <div style={{ fontSize: 10, color: C.ts }}>
                    {vin && <div>VIN: <span style={{ fontFamily: mono, color: C.tx }}>{vin}</span></div>}
                    {sec16 && <div style={{ color: bcmSec16 ? C.gn : C.wn }}>{sec16}</div>}
                    {rfhSlotCount !== null && (
                      <div style={{ color: rfhSlotCount > 0 ? C.gn : C.tm }}>
                        {rfhSlotCount} / {KEY_SLOT_COUNT} key slots occupied
                      </div>
                    )}
                    {warn && <div style={{ color: C.wn, marginTop: 2 }}>⚠ {String(warn).slice(0, 80)}</div>}
                    {!ok && <div style={{ color: C.er, fontWeight: 700 }}>✗ Parse error</div>}
                    {ok && !warn && <div style={{ color: C.gn }}>✓ Recognized</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* BCM SEC16 preview */}
        {bcmSec16 && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 10,
            background: C.sr + '08', border: '1px solid ' + C.sr + '40',
          }}>
            <div style={{ fontWeight: 800, fontSize: 10, color: C.sr, marginBottom: 4, letterSpacing: 1 }}>
              BCM SEC16 RESOLVED
            </div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.tx, wordBreak: 'break-all' }}>
              {hexBytes(bcmSec16)}
            </div>
          </div>
        )}
        {bcmParsed && !bcmSec16 && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 10,
            background: C.wn + '10', border: '1px solid ' + C.wn + '40',
            fontSize: 11, color: C.wn,
          }}>
            ⚠ BCM SEC16 is blank or could not be resolved. This BCM may be virgin/unpaired.
          </div>
        )}
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          STEP 2 — SKC / PIN
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <StepHeader num="2" title="SKC / 5-DIGIT PIN" status={step2Done ? 'done' : (step1Done ? 'active' : 'idle')} />
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          The 5-digit immobilizer PIN (SKC) is derived from bytes [14:15] of the RFHUB-form SEC16.
          This PIN is required for live key programming via AlfaOBD / wiTECH / J2534.
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Derived PIN */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6, marginBottom: 6 }}>
              DERIVED FROM BCM SEC16
            </div>
            {derivedPin ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  fontFamily: mono, fontSize: 32, fontWeight: 900,
                  color: C.gn, letterSpacing: 8,
                  padding: '8px 16px', background: C.gn + '10',
                  borderRadius: 10, border: '1.5px solid ' + C.gn + '40',
                }}>{derivedPin}</div>
                <button
                  onClick={() => { copyText(derivedPin); setPinCopied(true); setTimeout(() => setPinCopied(false), 2000); }}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: '1px solid ' + C.bd,
                    background: C.c2, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: C.ts,
                  }}
                >{pinCopied ? '✓ Copied' : '📋 Copy'}</button>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>
                {bcmParsed ? 'BCM SEC16 blank — cannot derive PIN' : 'Load BCM to derive PIN'}
              </div>
            )}
            {rfhPin && rfhPin !== derivedPin && (
              <div style={{ fontSize: 10, color: C.ts, marginTop: 6 }}>
                RFHUB-derived PIN: <span style={{ fontFamily: mono, fontWeight: 700, color: C.a3 }}>{rfhPin}</span>
                {derivedPin && rfhPin !== derivedPin && (
                  <span style={{ color: C.wn, marginLeft: 6 }}>⚠ MISMATCH — BCM is source of truth</span>
                )}
              </div>
            )}
          </div>

          {/* Manual override */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6, marginBottom: 6 }}>
              MANUAL OVERRIDE (5 DIGITS)
            </div>
            <input
              type="text"
              maxLength={5}
              value={pinOverride}
              onChange={e => setPinOverride(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="e.g. 12345"
              style={{
                padding: '8px 12px', borderRadius: 8, border: '1.5px solid ' + C.bd,
                fontFamily: mono, fontSize: 16, fontWeight: 900, color: C.tx,
                background: C.cd, width: '100%', boxSizing: 'border-box',
                letterSpacing: 4,
              }}
            />
            {pinOverride.length === 5 && (
              <div style={{ fontSize: 10, color: C.a3, marginTop: 4 }}>
                ✓ Manual PIN active — overrides derived value
              </div>
            )}
          </div>
        </div>

        {/* Active PIN summary */}
        {activePin && (
          <div style={{
            marginTop: 12, padding: '8px 14px', borderRadius: 10,
            background: C.a3 + '10', border: '1.5px solid ' + C.a3 + '40',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: C.a3 }}>ACTIVE SKC/PIN:</span>
            <span style={{ fontFamily: mono, fontSize: 18, fontWeight: 900, color: C.a3, letterSpacing: 6 }}>
              {activePin}
            </span>
            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('srtlab:livekey:pinpush', {
                  detail: {
                    pin: activePin,
                    sec16Hex: bcmSec16 ? hexBytes(bcmSec16) : null,
                    sec16Raw: bcmSec16 ? Array.from(bcmSec16) : null,
                  },
                }));
              }}
              style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: 8,
                border: '1px solid ' + C.a3 + '60', background: C.a3 + '10',
                cursor: 'pointer', fontSize: 10, fontWeight: 800, color: C.a3,
              }}
            >📤 Send to Live Keys tab →</button>
          </div>
        )}
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          STEP 3 — Transponder Pairing
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <StepHeader num="3" title="TRANSPONDER PAIRING" status={step3Done ? 'done' : (step1Done ? 'active' : 'idle')} />
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          Add a new transponder key to the RFHUB key table. The RFHUB must be loaded in Step 1.
          Slot occupancy is shown below. After adding, download the patched RFHUB and flash it.
        </div>

        {/* Slot status grid */}
        {rfhParsed ? (
          <>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>
              KEY SLOT STATUS — {rfhSlots?.filter(s => s.occupied).length ?? 0} / {KEY_SLOT_COUNT} OCCUPIED
            </div>
            <SlotGrid slots={rfhSlots} loading={false} />
          </>
        ) : (
          <div style={{
            padding: '12px 14px', borderRadius: 10, background: C.c2,
            border: '1px dashed ' + C.bd, fontSize: 11, color: C.tm, marginBottom: 8,
          }}>
            Load an RFHUB .bin in Step 1 to see slot occupancy and add a key.
          </div>
        )}

        {/* CharRfhubKeyAdderPanel — self-contained add-key UI */}
        {rfhParsed && (
          <div style={{ marginTop: 12 }}>
            <CharRfhubKeyAdderPanel
              initialMod={rfhParsed.data}
              defaultOpen
              onPatched={(patchedBytes, filename) => {
                setRfhPatched(patchedBytes);
              }}
              onAdded={(result) => {
                if (result?.patched) setRfhPatched(result.patched);
              }}
            />
          </div>
        )}

        {rfhPatched && (
          <div style={{
            marginTop: 10, padding: '10px 14px', borderRadius: 10,
            background: C.gn + '10', border: '1.5px solid ' + C.gn + '40',
            fontSize: 11, color: C.gn, fontWeight: 800,
          }}>
            ✓ Patched RFHUB ready — downloaded automatically. Flash this file to the RFHUB.
          </div>
        )}
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          STEP 4 — Seed Key Sync Verification
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <StepHeader num="4" title="SEED KEY SYNC VERIFICATION" status={step4Done ? 'done' : (step1Done ? 'active' : 'idle')} />
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          Verifies the BCM → RFHUB → PCM secret derivation chain. The BCM SEC16 is the
          authoritative source: <strong>RFHUB SEC16 = reverse(BCM SEC16)</strong> and{' '}
          <strong>PCM SEC6 = RFHUB SEC16[0:6]</strong>. Any mismatch means the module set
          is not paired and the vehicle will not start.
        </div>

        {chainVerdict ? (
          <>
            {/* Derivation chain diagram */}
            <div style={{
              padding: '10px 14px', borderRadius: 10, background: C.c2,
              border: '1px solid ' + C.bd, marginBottom: 12,
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 8 }}>
                DERIVATION CHAIN (BCM is source of truth)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{
                  padding: '6px 10px', borderRadius: 8, background: C.sr + '15',
                  border: '1.5px solid ' + C.sr + '50',
                }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: C.sr, marginBottom: 2 }}>BCM SEC16</div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: C.tx, wordBreak: 'break-all' }}>
                    {hexBytes(bcmSec16)}
                  </div>
                </div>
                <div style={{ fontSize: 16, color: C.tm }}>→ reverse →</div>
                <div style={{
                  padding: '6px 10px', borderRadius: 8,
                  background: (chainVerdict.rfhMatch === false ? C.er : C.a3) + '15',
                  border: '1.5px solid ' + (chainVerdict.rfhMatch === false ? C.er : C.a3) + '50',
                }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: chainVerdict.rfhMatch === false ? C.er : C.a3, marginBottom: 2 }}>
                    RFHUB SEC16 {chainVerdict.rfhMatch === true ? '✓' : chainVerdict.rfhMatch === false ? '✗' : '?'}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: C.tx, wordBreak: 'break-all' }}>
                    {chainVerdict.rfhExpected}
                  </div>
                </div>
                <div style={{ fontSize: 16, color: C.tm }}>→ [0:6] →</div>
                <div style={{
                  padding: '6px 10px', borderRadius: 8,
                  background: (chainVerdict.pcmMatch === false ? C.er : C.a2) + '15',
                  border: '1.5px solid ' + (chainVerdict.pcmMatch === false ? C.er : C.a2) + '50',
                }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: chainVerdict.pcmMatch === false ? C.er : C.a2, marginBottom: 2 }}>
                    PCM SEC6 {chainVerdict.pcmMatch === true ? '✓' : chainVerdict.pcmMatch === false ? '✗' : '?'}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: C.tx, wordBreak: 'break-all' }}>
                    {chainVerdict.pcmExpected}
                  </div>
                </div>
              </div>
            </div>

            {/* Detailed check rows */}
            <ChainRow
              label="RFHUB SEC16 matches BCM-derived value"
              expected={chainVerdict.rfhExpected}
              actual={chainVerdict.rfhActual}
              ok={chainVerdict.rfhMatch}
            />
            <ChainRow
              label="PCM SEC6 matches BCM-derived value"
              expected={chainVerdict.pcmExpected}
              actual={chainVerdict.pcmActual}
              ok={chainVerdict.pcmMatch}
            />

            {/* Overall verdict */}
            <div style={{
              marginTop: 12, padding: '12px 16px', borderRadius: 12,
              background: chainOk ? C.gn + '10' : C.er + '10',
              border: '2px solid ' + (chainOk ? C.gn : C.er) + '60',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ fontSize: 28 }}>{chainOk ? '✅' : '❌'}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 900, fontSize: 14, color: chainOk ? C.gn : C.er }}>
                  {chainOk ? 'CHAIN VERIFIED — MODULE SET IS PAIRED' : 'CHAIN MISMATCH — MODULES NOT PAIRED'}
                </div>
                <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
                  {chainOk
                    ? 'BCM, RFHUB, and PCM share the same immobilizer secret. The vehicle should start with any paired key.'
                    : 'One or more modules have the wrong secret bytes. Use the fix below to patch and download corrected files.'}
                </div>
              </div>
            </div>

            {/* Fix button */}
            {!chainOk && (
              <div style={{ marginTop: 12 }}>
                <Btn
                  onClick={applyFix}
                  disabled={fixBusy}
                  style={{
                    background: C.er, color: '#fff', fontWeight: 900, fontSize: 12,
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    cursor: fixBusy ? 'wait' : 'pointer', letterSpacing: 1,
                  }}
                >
                  {fixBusy ? '⏳ Fixing…' : '🔧 FIX MISMATCHED MODULES + DOWNLOAD'}
                </Btn>
                <div style={{ fontSize: 10, color: C.ts, marginTop: 6 }}>
                  Writes correct SEC16 to RFHUB and/or correct SEC6 to PCM. Downloads patched files immediately.
                </div>
              </div>
            )}

            {/* Fix results */}
            {fixResult && (
              <div style={{ marginTop: 10 }}>
                {fixResult.map((r, i) => (
                  <div key={i} style={{
                    padding: '8px 12px', borderRadius: 8, marginBottom: 6,
                    background: r.ok ? C.gn + '10' : C.er + '10',
                    border: '1px solid ' + (r.ok ? C.gn : C.er) + '40',
                    fontSize: 11, color: r.ok ? C.gn : C.er, fontWeight: 700,
                  }}>
                    {r.ok ? `✓ ${r.module} patched → ${r.name}` : `✗ ${r.module}: ${r.error}`}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{
            padding: '16px', borderRadius: 10, background: C.c2,
            border: '1px dashed ' + C.bd, textAlign: 'center',
            fontSize: 11, color: C.tm,
          }}>
            Load BCM + RFHUB + PCM in Step 1 to verify the seed key sync chain.
          </div>
        )}
      </Card>

      {/* ── Quick reference ── */}
      <Card style={{ marginBottom: 14, background: C.c2 }}>
        <div style={{ fontWeight: 800, fontSize: 10, color: C.ts, letterSpacing: 1, marginBottom: 8 }}>
          QUICK REFERENCE — DERIVATION RULES
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
          {[
            { label: 'BCM SEC16 → RFHUB SEC16', rule: 'byte-reverse the 16-byte block', color: C.sr },
            { label: 'RFHUB SEC16 → PCM SEC6', rule: 'take first 6 bytes of RFHUB form', color: C.a3 },
            { label: 'PIN / SKC derivation', rule: '(rfh[14] << 8 | rfh[15]) as 5-digit decimal', color: C.a2 },
            { label: 'PCM marker @ 0x3C4', rule: 'must be FF FF FF AA for SEC6 to be active', color: C.a4 },
          ].map(({ label, rule, color }) => (
            <div key={label} style={{
              padding: '8px 10px', borderRadius: 8,
              background: color + '08', border: '1px solid ' + color + '30',
            }}>
              <div style={{ fontWeight: 800, fontSize: 10, color, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 10, color: C.ts }}>{rule}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
