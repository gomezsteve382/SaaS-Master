/* LiveKeyTab.jsx — Alfa-OBD–style live key programming & PIN extraction.
 *
 * Visible when the J2534 bridge is connected.  Three sections:
 *   1. Read PIN       — security access + SEC16 read → 5-digit PIN display
 *   2. Key Slots      — slot occupancy + Program Key wizard
 *   3. Erase All      — wipe all slots with confirmation
 *
 * Dump ↔ live bridge:
 *   • KeyManagerTab dispatches `srtlab:livekey:pinpush` when the user clicks
 *     "Use this PIN for Live Programming" on a loaded dump — this tab listens
 *     and pre-fills the PIN field.
 *   • After a successful live PIN read, this tab dispatches
 *     `srtlab:livekey:pinread` so other tabs can react if needed.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Btn, Tag } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { useBridgeStatus } from '../lib/bridgeClient.js';
import { createBridgeEngine } from '../lib/bridgeEngine.js';
import {
  connectImmoModule, performSecurityAccess, readPin, readKeySlots,
  enterKeyLearn, confirmKeyLearned, exitKeyLearn, eraseAllKeys,
  sbecAlgo, immoNrcMsg, IMMO_ERR, DEFAULT_ADDR, MODULE_ADDRS,
  LIVE_KEY_SLOT_COUNT, pinFromSec16, appendLiveImmoAudit,
} from '../lib/liveImmo.js';

const ADDR_OPTIONS = [
  { label: 'RFHUB / SKREEM  (0x742 → 0x762)', value: 'RFHUB' },
  { label: 'GPEC2A / PCM    (0x7E0 → 0x7E8)', value: 'GPEC2A' },
  { label: 'Custom…', value: 'custom' },
];

function hx(n, w = 3) { return '0x' + n.toString(16).toUpperCase().padStart(w, '0'); }

function LogLine({ entry }) {
  const col = { error: C.er, warn: C.wn, pass: C.gn, info: C.ts, step: C.a3 };
  return (
    <div style={{ fontSize: 11, padding: '2px 0', display: 'flex', gap: 8, color: col[entry.type] || C.ts, fontFamily: "'JetBrains Mono'" }}>
      <span style={{ color: C.tm, flexShrink: 0 }}>{entry.ts}</span>
      <span>{entry.m}</span>
    </div>
  );
}

function SlotGrid({ slots, loading }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, margin: '10px 0' }}>
      {Array.from({ length: LIVE_KEY_SLOT_COUNT }, (_, i) => {
        const s = slots?.[i];
        const occupied = s?.occupied;
        return (
          <div key={i} style={{
            padding: '10px 8px', borderRadius: 10, textAlign: 'center',
            background: loading ? C.c2 : (occupied ? C.gn + '18' : C.c2),
            border: `1.5px solid ${loading ? C.bd : occupied ? C.gn + '55' : C.bd}`,
            transition: 'all 0.25s',
          }}>
            <div style={{ fontSize: 18, marginBottom: 2 }}>{occupied ? '🗝️' : '⬜'}</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: loading ? C.tm : occupied ? C.gn : C.tm }}>
              SLOT {i + 1}
            </div>
            <div style={{ fontSize: 9, color: C.tm, marginTop: 1 }}>
              {loading ? '…' : occupied ? 'OCCUPIED' : 'EMPTY'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PinDisplay({ pin, sec16Hex, onPushToDump }) {
  if (!pin) return null;
  return (
    <div style={{ marginTop: 10, padding: 14, borderRadius: 10, background: C.gn + '12', border: '1.5px solid ' + C.gn + '55' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.tm, marginBottom: 6, letterSpacing: 1.5 }}>
        ✓ PIN EXTRACTED
      </div>
      <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 32, fontWeight: 900, color: C.gn, letterSpacing: 8, marginBottom: 6 }}>
        {pin}
      </div>
      {sec16Hex && (
        <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts, wordBreak: 'break-all', marginBottom: 8 }}>
          <span style={{ color: C.tm }}>SEC16: </span>{sec16Hex}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {onPushToDump && (
          <button
            onClick={onPushToDump}
            style={{ padding: '6px 14px', borderRadius: 8, fontWeight: 800, fontSize: 11, border: '2px solid ' + C.a3 + '88', background: 'transparent', color: C.a3, cursor: 'pointer' }}>
            ← Save to open dump session
          </button>
        )}
      </div>
    </div>
  );
}

export default function LiveKeyTab() {
  const bridge = useBridgeStatus(5000);

  const [addrPreset, setAddrPreset]       = useState('RFHUB');
  const [customTx, setCustomTx]           = useState('0x742');
  const [customRx, setCustomRx]           = useState('0x762');
  const [algoName]                        = useState('SBEC');
  const [log, setLog]                     = useState([]);
  const [busy, setBusy]                   = useState(false);

  const [pin, setPin]                     = useState(null);
  const [sec16Hex, setSec16Hex]           = useState(null);
  const [sec16Raw, setSec16Raw]           = useState(null);

  const [slots, setSlots]                 = useState(null);
  const [slotsLoading, setSlotsLoading]   = useState(false);

  const [learnPhase, setLearnPhase]       = useState('idle');
  const [learnSlot, setLearnSlot]         = useState(null);
  const [eraseConfirm, setEraseConfirm]   = useState(false);
  const [eraseResult, setEraseResult]     = useState(null);

  const [prefillPin, setPrefillPin]       = useState('');
  const [prefillSec16, setPrefillSec16]   = useState('');

  const engineRef = useRef(null);
  const logRef    = useRef([]);

  function addLog(m, type = 'info') {
    const ts = new Date().toLocaleTimeString();
    const entry = { ts, m, type };
    logRef.current = [...logRef.current.slice(-300), entry];
    setLog([...logRef.current]);
  }

  /* Listen for incoming PIN push from Key Manager / ImmoVIN dump tabs */
  useEffect(() => {
    function onPinPush(ev) {
      const { pin: p, sec16Hex: s, sec16Raw: r } = ev.detail || {};
      if (p) { setPrefillPin(p); addLog(`Pin ${p} loaded from dump session`, 'info'); }
      if (s) setPrefillSec16(s);
      if (r) setSec16Raw(r);
      if (p) setPin(p);
      if (s) setSec16Hex(s);
    }
    window.addEventListener('srtlab:livekey:pinpush', onPinPush);
    return () => window.removeEventListener('srtlab:livekey:pinpush', onPinPush);
  }, []);

  function getAddr() {
    if (addrPreset === 'custom') {
      const tx = parseInt(customTx, 16) || DEFAULT_ADDR.tx;
      const rx = parseInt(customRx, 16) || DEFAULT_ADDR.rx;
      return { tx, rx };
    }
    return MODULE_ADDRS[addrPreset] || DEFAULT_ADDR;
  }

  async function getEngine() {
    if (engineRef.current) return engineRef.current;
    addLog('Creating J2534 bridge engine…', 'info');
    const res = await createBridgeEngine({ addLog });
    if (!res.ok) {
      addLog('Bridge engine failed: ' + res.error, 'error');
      return null;
    }
    engineRef.current = res.engine;
    addLog('✓ Bridge engine ready — ' + (res.engine.adapter || 'J2534'), 'pass');
    return res.engine;
  }

  /* Tear down the cached engine when the bridge disconnects */
  useEffect(() => {
    if (!bridge.connected) {
      engineRef.current = null;
    }
  }, [bridge.connected]);

  /* ── Read PIN ── */
  const handleReadPin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setPin(null); setSec16Hex(null); setSec16Raw(null);
    addLog('▶ Read PIN — starting…', 'step');
    try {
      const engine = await getEngine();
      if (!engine) return;
      const addr = getAddr();
      addLog(`Module: ${hx(addr.tx)} → ${hx(addr.rx)} (${addrPreset})`, 'info');
      const r = await readPin(engine, addr, { algoFn: sbecAlgo });
      if (r.ok) {
        setPin(r.pinDec);
        setSec16Hex(r.sec16Hex);
        setSec16Raw(r.sec16Raw);
        addLog(`✓ PIN = ${r.pinDec}`, 'pass');
        addLog(`  SEC16: ${r.sec16Hex}`, 'info');
        appendLiveImmoAudit({ op: 'read-pin', ok: true, pin: r.pinDec, sec16Hex: r.sec16Hex });
        window.dispatchEvent(new CustomEvent('srtlab:livekey:pinread', {
          detail: { pin: r.pinDec, sec16Hex: r.sec16Hex, sec16Raw: r.sec16Raw },
        }));
      } else {
        addLog(`✗ ${r.error}`, 'error');
        if (r.nrc != null) addLog(`  NRC 0x${r.nrc.toString(16).toUpperCase()}: ${immoNrcMsg(r.nrc)}`, 'error');
        appendLiveImmoAudit({ op: 'read-pin', ok: false, error: r.error });
      }
    } catch (e) {
      addLog('✗ Unexpected error: ' + (e?.message || String(e)), 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, addrPreset, customTx, customRx]);

  /* ── Read Slot Status ── */
  const handleReadSlots = useCallback(async () => {
    if (busy) return;
    setBusy(true); setSlotsLoading(true);
    addLog('▶ Reading key slot status…', 'step');
    try {
      const engine = await getEngine();
      if (!engine) { setSlotsLoading(false); return; }
      const addr = getAddr();
      const r = await readKeySlots(engine, addr);
      if (r.ok) {
        setSlots(r.slots);
        addLog(`✓ Slots: ${r.occupiedCount} / ${LIVE_KEY_SLOT_COUNT} occupied`, 'pass');
        r.slots.forEach(s => {
          if (s.occupied) addLog(`  Slot ${s.idx + 1}: OCCUPIED`, 'info');
        });
        appendLiveImmoAudit({ op: 'read-slots', ok: true, occupiedCount: r.occupiedCount });
      } else {
        addLog(`✗ ${r.error}`, 'error');
        appendLiveImmoAudit({ op: 'read-slots', ok: false, error: r.error });
      }
    } catch (e) {
      addLog('✗ Unexpected error: ' + (e?.message || String(e)), 'error');
    } finally {
      setBusy(false); setSlotsLoading(false);
    }
  }, [busy, addrPreset, customTx, customRx]);

  /* ── Program Key flow ── */
  const handleProgramKey = useCallback(async () => {
    if (busy) return;
    if (slots && slots.every(s => s.occupied)) {
      addLog('✗ ' + IMMO_ERR.SLOTS_FULL, 'error');
      return;
    }
    setBusy(true);
    setLearnPhase('entering'); setLearnSlot(null); setEraseResult(null);
    addLog('▶ Program Key — entering key-learn mode…', 'step');
    try {
      const engine = await getEngine();
      if (!engine) { setLearnPhase('idle'); return; }
      const addr = getAddr();

      const enter = await enterKeyLearn(engine, addr, { algoFn: sbecAlgo });
      if (!enter.ok) {
        addLog('✗ ' + enter.error, 'error');
        if (enter.nrc != null) addLog(`  NRC 0x${enter.nrc.toString(16).toUpperCase()}: ${immoNrcMsg(enter.nrc)}`, 'error');
        setLearnPhase('idle');
        appendLiveImmoAudit({ op: 'enter-key-learn', ok: false, error: enter.error });
        return;
      }
      addLog('✓ Key-learn mode active', 'pass');
      addLog('⟳ INSERT NEW KEY and cycle the ignition to ON, then back to OFF. Waiting up to 30 s…', 'step');
      setLearnPhase('waiting');

      const confirm = await confirmKeyLearned(engine, addr, { timeoutMs: 30000 });
      if (!confirm.ok) {
        addLog('✗ ' + confirm.error, 'error');
        setLearnPhase('idle');
        appendLiveImmoAudit({ op: 'confirm-key-learned', ok: false, error: confirm.error });
        await exitKeyLearn(engine, addr).catch(() => {});
        return;
      }
      setLearnSlot(confirm.slotIdx);
      addLog(`✓ Key learned${confirm.slotIdx != null ? ` → slot ${confirm.slotIdx + 1}` : ''}`, 'pass');
      setLearnPhase('done');

      addLog('Exiting key-learn mode…', 'info');
      await exitKeyLearn(engine, addr);
      addLog('✓ Learn mode exited', 'pass');

      appendLiveImmoAudit({ op: 'program-key', ok: true, slotIdx: confirm.slotIdx });

      addLog('Refreshing slot status…', 'info');
      const rs = await readKeySlots(engine, addr);
      if (rs.ok) setSlots(rs.slots);
    } catch (e) {
      addLog('✗ Unexpected error: ' + (e?.message || String(e)), 'error');
      setLearnPhase('idle');
    } finally {
      setBusy(false);
    }
  }, [busy, slots, addrPreset, customTx, customRx]);

  /* ── Erase All ── */
  const handleEraseAll = useCallback(async () => {
    if (busy) return;
    setBusy(true); setEraseResult(null); setEraseConfirm(false);
    addLog('▶ Erase All Keys…', 'step');
    try {
      const engine = await getEngine();
      if (!engine) return;
      const addr = getAddr();
      const r = await eraseAllKeys(engine, addr, { algoFn: sbecAlgo });
      if (r.ok) {
        setEraseResult('ok');
        addLog('✓ All keys erased', 'pass');
        setSlots(Array.from({ length: LIVE_KEY_SLOT_COUNT }, (_, i) => ({ idx: i, occupied: false })));
        appendLiveImmoAudit({ op: 'erase-all', ok: true });
      } else {
        setEraseResult('fail');
        addLog('✗ ' + r.error, 'error');
        if (r.nrc != null) addLog(`  NRC 0x${r.nrc.toString(16).toUpperCase()}: ${immoNrcMsg(r.nrc)}`, 'error');
        appendLiveImmoAudit({ op: 'erase-all', ok: false, error: r.error });
      }
    } catch (e) {
      addLog('✗ Unexpected error: ' + (e?.message || String(e)), 'error');
      setEraseResult('fail');
    } finally {
      setBusy(false);
    }
  }, [busy, addrPreset, customTx, customRx]);

  /* ── Push live PIN back to dump session ── */
  const handlePushToDump = useCallback(() => {
    if (!pin) return;
    window.dispatchEvent(new CustomEvent('srtlab:livekey:pinread', {
      detail: { pin, sec16Hex, sec16Raw },
    }));
    addLog(`PIN ${pin} dispatched to open dump session`, 'info');
  }, [pin, sec16Hex, sec16Raw]);

  const connected = bridge.connected && bridge.status?.channelConnected;
  const isReady   = bridge.connected;

  return (
    <div data-testid="livekey-tab">
      {/* ── Header ── */}
      <Card style={{ background: 'linear-gradient(135deg,#1B5E20 0%,#2E7D32 40%,#388E3C 100%)', color: '#fff', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32 }}>🔑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2 }}>KEYS & PIN — LIVE OBD</div>
            <div style={{ fontSize: 10, opacity: .75, letterSpacing: 3, fontWeight: 700 }}>RFHUB · SKREEM · ALFA-OBD STYLE · J2534 BRIDGE</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 11 }}>
            <Tag color={isReady ? C.gn : C.er}>{isReady ? '● BRIDGE ONLINE' : '○ BRIDGE OFFLINE'}</Tag>
          </div>
        </div>
      </Card>

      {/* ── Bridge offline banner ── */}
      {!isReady && (
        <Card style={{ marginBottom: 14, background: '#FFF3E0', border: '2px solid ' + C.wn }}>
          <div style={{ fontWeight: 800, color: '#E65100', fontSize: 12, marginBottom: 6 }}>
            ⚠ J2534 Bridge Not Connected
          </div>
          <div style={{ fontSize: 12, color: C.ts, lineHeight: 1.6 }}>
            This tab requires the local J2534 bridge daemon (<code>j2534_bridge.py</code>) to be running
            and your cable connected. Start the bridge from the <b>Live OBD</b> tab, then return here.
            <br />
            {bridge.error && <span style={{ color: C.er, fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
              Error: {bridge.error}
            </span>}
          </div>
        </Card>
      )}

      {/* ── Prefill banner (PIN pushed from dump) ── */}
      {prefillPin && (
        <Card style={{ marginBottom: 14, background: C.a3 + '10', border: '1.5px solid ' + C.a3 + '55' }}>
          <div style={{ fontWeight: 800, color: C.a3, fontSize: 11, marginBottom: 4 }}>
            📥 PIN LOADED FROM DUMP SESSION
          </div>
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 20, fontWeight: 900, color: C.a3, letterSpacing: 6 }}>
            {prefillPin}
          </div>
          {prefillSec16 && (
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts, marginTop: 4, wordBreak: 'break-all' }}>
              SEC16: {prefillSec16}
            </div>
          )}
          <div style={{ fontSize: 10, color: C.tm, marginTop: 6 }}>
            Use this PIN to seed the live programming flow below, or click Read PIN to verify against the live module.
          </div>
        </Card>
      )}

      {/* ── Module address selector ── */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 8, letterSpacing: 2 }}>⚙ MODULE ADDRESS</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={addrPreset}
            onChange={e => setAddrPreset(e.target.value)}
            disabled={busy}
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid ' + C.bd, fontFamily: "'Nunito'", fontSize: 12, fontWeight: 700 }}
          >
            {ADDR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {addrPreset === 'custom' && (
            <>
              <input value={customTx} onChange={e => setCustomTx(e.target.value)}
                placeholder="TX e.g. 0x742"
                style={{ width: 110, padding: '7px 10px', borderRadius: 8, border: '1px solid ' + C.bd, fontFamily: "'JetBrains Mono'", fontSize: 12 }} />
              <input value={customRx} onChange={e => setCustomRx(e.target.value)}
                placeholder="RX e.g. 0x762"
                style={{ width: 110, padding: '7px 10px', borderRadius: 8, border: '1px solid ' + C.bd, fontFamily: "'JetBrains Mono'", fontSize: 12 }} />
            </>
          )}
          <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
            Algorithm: {algoName} (seed×4+0x9018)
          </span>
        </div>
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          SECTION 1 — READ PIN
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: C.a1, marginBottom: 4, letterSpacing: 1.5 }}>
          🔓 READ IMMOBILIZER PIN
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 10, lineHeight: 1.55 }}>
          Performs a security-access handshake against the RFHUB/SKREEM module and reads the
          16-byte SEC16 secret block.  The 5-digit PIN is extracted from bytes 14–15, identical
          to the value <code>rfhPcmPair.js</code> reads from a dump of the same car.
        </div>
        <Btn onClick={handleReadPin} disabled={!isReady || busy} color={C.a1}>
          {busy ? '⟳ Working…' : '🔓 Read PIN from Module'}
        </Btn>
        <PinDisplay pin={pin} sec16Hex={sec16Hex} onPushToDump={pin ? handlePushToDump : null} />
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          SECTION 2 — KEY SLOTS & PROGRAM KEY
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: C.a2, marginBottom: 4, letterSpacing: 1.5 }}>
          🗝️ KEY SLOTS & PROGRAM KEY
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 10, lineHeight: 1.55 }}>
          Read the current slot occupancy without pulling a dump, then program a new blank key
          by entering key-learn mode and cycling the ignition with the new transponder present.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Btn onClick={handleReadSlots} disabled={!isReady || busy} color={C.a2}>
            {slotsLoading ? '⟳ Reading…' : '📡 Read Slot Status'}
          </Btn>
          <Btn onClick={handleProgramKey} disabled={!isReady || busy} color={C.gn}>
            {learnPhase === 'waiting' ? '⟳ Waiting for key…' : learnPhase === 'entering' ? '⟳ Entering learn…' : '➕ Program New Key'}
          </Btn>
        </div>

        {slots && <SlotGrid slots={slots} loading={slotsLoading} />}

        {learnPhase === 'waiting' && (
          <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, background: C.wn + '14', border: '1.5px solid ' + C.wn + '66', fontSize: 12, fontWeight: 700, color: '#E65100' }}>
            ⟳ KEY-LEARN ACTIVE — Insert the new key into the ignition and cycle ON → OFF.
            The module is listening for a transponder for up to 30 seconds.
          </div>
        )}

        {learnPhase === 'done' && (
          <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, background: C.gn + '12', border: '1.5px solid ' + C.gn + '55', fontSize: 12, fontWeight: 800, color: C.gn }}>
            ✓ Key programmed{learnSlot != null ? ` → slot ${learnSlot + 1}` : ''}.
            Verify the new key starts the vehicle.
          </div>
        )}
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          SECTION 3 — ERASE ALL KEYS
         ══════════════════════════════════════════════════════════════════ */}
      <Card style={{ marginBottom: 14, borderLeft: '4px solid ' + C.er }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: C.er, marginBottom: 4, letterSpacing: 1.5 }}>
          🗑 ERASE ALL KEYS
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 10, lineHeight: 1.55 }}>
          Wipes every programmed transponder from the module.  <b>This cannot be undone without
          re-programming all keys.</b>  Use this to start a clean slate when re-keying a vehicle.
        </div>

        {!eraseConfirm ? (
          <Btn onClick={() => setEraseConfirm(true)} disabled={!isReady || busy} color={C.er} outline>
            🗑 Erase All Keys…
          </Btn>
        ) : (
          <div style={{ padding: '12px 14px', borderRadius: 10, background: '#FFEBEE', border: '2px solid ' + C.er }}>
            <div style={{ fontWeight: 800, color: C.er, fontSize: 12, marginBottom: 8 }}>
              ⚠ This will erase ALL transponder keys from the module. Are you sure?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={handleEraseAll} disabled={busy} color={C.er}>
                {busy ? '⟳ Erasing…' : 'YES — Erase All'}
              </Btn>
              <Btn onClick={() => setEraseConfirm(false)} disabled={busy} color={C.tm} outline>
                Cancel
              </Btn>
            </div>
          </div>
        )}

        {eraseResult === 'ok' && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: C.gn + '12', color: C.gn, fontSize: 12, fontWeight: 800 }}>
            ✓ All keys erased. Re-program your keys before starting the vehicle.
          </div>
        )}
        {eraseResult === 'fail' && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#FFEBEE', color: C.er, fontSize: 12, fontWeight: 700 }}>
            ✗ Erase failed — see activity log below.
          </div>
        )}
      </Card>

      {/* ── Verification checklist ── */}
      <Card style={{ marginBottom: 14, background: C.c2 }}>
        <div style={{ fontWeight: 800, fontSize: 11, color: C.a3, marginBottom: 8, letterSpacing: 2 }}>
          ✅ VERIFICATION CHECKLIST (vs paired dump)
        </div>
        <div style={{ fontSize: 11, color: C.ts, lineHeight: 2 }}>
          {[
            'PIN from live module matches dump-extracted PIN (rfhPcmPair.js parseSec16 @ 0xAE/0xC0)',
            'SEC16 hex matches both SEC16 slots in the paired RFHUB dump',
            'Slot occupancy count after programming matches a fresh dump key count',
            'New key starts the vehicle within 3 ignition cycles',
            'No DTC P0513 (SKIM) or U0151 (Lost Comm w/ SKREEM) present after programming',
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: C.tm, fontWeight: 700, minWidth: 16 }}>{i + 1}.</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Activity log ── */}
      <Card data-testid="livekey-log">
        <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 8, letterSpacing: 2, display: 'flex', alignItems: 'center', gap: 10 }}>
          📜 ACTIVITY LOG
          <button onClick={() => { logRef.current = []; setLog([]); }}
            style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, border: '1px solid ' + C.bd, background: 'transparent', color: C.tm, cursor: 'pointer', fontWeight: 700 }}>
            clear
          </button>
        </div>
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {log.length === 0
            ? <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>No actions yet.</div>
            : log.map((e, i) => <LogLine key={i} entry={e} />)
          }
        </div>
      </Card>
    </div>
  );
}
