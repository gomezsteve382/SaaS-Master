/* ============================================================================
 * KeyWriterTab.jsx — Task #862
 *
 * Hand RFHUB slot bytes to a commercial transponder writer (Xhorse VVDI
 * Mini / Tango) so a locksmith can burn a fresh chip without leaving
 * SRT Lab. The actual burn happens on the writer; this tab is the
 * bridge — slot picker, chip family picker, transport (Web Serial /
 * simulator), then ping → detect → burn → verify with refuse-on-doubt
 * gating and a step-by-step audit log.
 *
 * After a successful burn the operator hands the freshly-burned chip
 * back to the existing RoutineControl 0x0401 pairing flow on the
 * RfhubTab — see docs/key-writer-bridge.md for the full handoff.
 * ========================================================================== */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { parseKeySlots, KEY_ID_BLOCK_LEN } from '../lib/rfhubKeySlots.js';
import { CHIP_FAMILIES, chipForRfhubGen } from '../lib/keyWriter/chipFamilies.js';
import { SimulatorTransport, FAULT_HANDLERS } from '../lib/keyWriter/simulator.js';
import { connectWebSerial, isWebSerialAvailable } from '../lib/keyWriter/webSerialTransport.js';
import { burnSlot } from '../lib/keyWriter/index.js';

const WRITERS = [
  { id: 'vvdi-mini', label: 'Xhorse VVDI Mini Key Tool' },
  { id: 'tango',     label: 'Tango Key Programmer (experimental)' },
];

const SIM_PROFILES = [
  { id: 'happy',      label: 'All steps succeed',     handler: null },
  { id: 'noChip',     label: 'No chip on coil',       handler: FAULT_HANDLERS.noChip },
  { id: 'wrongChip',  label: 'Wrong chip family',     handler: FAULT_HANDLERS.wrongChip },
  { id: 'locked',     label: 'Locked chip',           handler: FAULT_HANDLERS.locked },
  { id: 'verifyFail', label: 'Verify mismatch',       handler: FAULT_HANDLERS.verifyFail },
];

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexJoin = (bs) => [...bs].map(hex).join(' ');

function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsArrayBuffer(file);
  });
}

export default function KeyWriterTab() {
  const [rfhFile, setRfhFile] = useState(null);
  const [rfhBytes, setRfhBytes] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [slotIdx, setSlotIdx] = useState(null);

  const [chipId, setChipId] = useState('pcf7953');
  const [writerId, setWriterId] = useState('vvdi-mini');

  const [mode, setMode] = useState('sim'); // 'sim' | 'webserial'
  const [simProfile, setSimProfile] = useState('happy');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [log, setLog] = useState([]);
  const [serialError, setSerialError] = useState(null);
  const transportRef = useRef(null);

  const onLoadRfh = useCallback(async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRfhFile(f);
    setParseError(null);
    setParsed(null);
    setSlotIdx(null);
    setResult(null);
    setLog([]);
    try {
      const bytes = await readFileBytes(f);
      setRfhBytes(bytes);
      const p = parseKeySlots(bytes);
      if (!p.ok) { setParseError(p.error || 'parseKeySlots failed'); return; }
      setParsed(p);
      const def = chipForRfhubGen(p.gen);
      if (def) setChipId(def);
      // Auto-select first occupied + mapped slot.
      const firstOcc = p.slots.find((s) => s.occupied && s.idMapped);
      if (firstOcc) setSlotIdx(firstOcc.idx);
    } catch (e2) {
      setParseError(e2.message || String(e2));
    }
  }, []);

  const slot = useMemo(() => {
    if (!parsed || slotIdx == null) return null;
    return parsed.slots.find((s) => s.idx === slotIdx) || null;
  }, [parsed, slotIdx]);

  // SEC16 slot 1 is canonical (the "master" — both slots are mirrored on
  // a healthy RFHUB; parser already exposes match=true/false).
  const secret16 = useMemo(() => parsed?.sec16?.slots?.[0]?.raw || null, [parsed]);
  const secretBlank = useMemo(() => {
    if (!secret16) return true;
    let allFF = true, all00 = true;
    for (let i = 0; i < secret16.length; i++) {
      if (secret16[i] !== 0xFF) allFF = false;
      if (secret16[i] !== 0x00) all00 = false;
    }
    return allFF || all00;
  }, [secret16]);

  // Mirror the serializer's refuse-on-doubt gates so the button never
  // enables for a combination buildBurnRequest() would reject.
  const chipDef = useMemo(() => CHIP_FAMILIES.find((c) => c.id === chipId) || null, [chipId]);
  const idShapeMatch = !!(slot?.idBytes && chipDef && slot.idBytes.length === chipDef.uidBytes + chipDef.payloadBytes);
  const writerSupported = !!(chipDef && chipDef.writers.includes(writerId));
  const canBurn =
    parsed && slot && slot.occupied && slot.idMapped &&
    secret16 && !secretBlank &&
    chipDef && idShapeMatch && writerSupported &&
    !busy;

  const connectSerial = useCallback(async () => {
    setSerialError(null);
    try {
      const t = await connectWebSerial({});
      transportRef.current = t;
      setMode('webserial');
    } catch (e) {
      setSerialError(e.message || String(e));
    }
  }, []);

  const disconnectSerial = useCallback(async () => {
    try { await transportRef.current?.close(); } catch { /* ignore */ }
    transportRef.current = null;
    setMode('sim');
  }, []);

  const runBurn = useCallback(async () => {
    if (!slot || !secret16) return;
    setBusy(true);
    setResult(null);
    setLog([{ at: Date.now(), level: 'info', msg: `Starting ${mode === 'sim' ? 'simulated' : 'live'} burn — slot ${slot.idx}, chip ${chipId}, writer ${writerId}` }]);
    let transport = transportRef.current;
    let createdSim = false;
    if (mode === 'sim') {
      const prof = SIM_PROFILES.find((p) => p.id === simProfile);
      transport = new SimulatorTransport({ latencyMs: 60, handler: prof?.handler || undefined });
      createdSim = true;
    }
    if (!transport) {
      setLog((L) => [...L, { at: Date.now(), level: 'err', msg: 'No transport connected. Connect Web Serial or use Simulator mode.' }]);
      setBusy(false);
      return;
    }
    try {
      const res = await burnSlot({
        transport, slot, chipId, writer: writerId, secret16,
      });
      const entries = res.steps.map((s) => ({
        at: Date.now(),
        level: s.ok ? 'ok' : 'err',
        msg: `[${s.label.toUpperCase()}] ${s.ok ? 'OK' : (s.error || 'FAILED')} — ${s.detail || ''}`,
      }));
      setLog((L) => [
        ...L,
        ...entries,
        { at: Date.now(), level: res.ok ? 'ok' : 'err',
          msg: res.ok
            ? `KEYMOD WRITTEN — slot ${slot.idx} burned and verified. Hand chip to RFHUB tab for RoutineControl 0x0401 pairing.`
            : `KEYMOD REFUSED — failed at step "${res.failedAt}".` },
      ]);
      setResult(res);
    } catch (e) {
      setLog((L) => [...L, { at: Date.now(), level: 'err', msg: `KEYMOD REFUSED — transport error: ${e.message || e}` }]);
      setResult({ ok: false, failedAt: 'transport', steps: [] });
    } finally {
      if (createdSim) transport.close?.();
      setBusy(false);
    }
  }, [slot, secret16, mode, simProfile, chipId, writerId]);

  return (
    <div data-testid="key-writer-tab">
      {/* Header / disclaimer */}
      <Card style={{ marginBottom: 16, background: '#FFF3E0', borderColor: '#FF8F00' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 24 }}>🗝️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: '#7A3800', letterSpacing: 0.5 }}>
              TRANSPONDER WRITER BRIDGE — BENCH USE ONLY
            </div>
            <div style={{ fontSize: 12, color: '#7A3800', marginTop: 4, lineHeight: 1.6 }}>
              Hands a single RFHUB slot's chip bytes to an attached writer
              (Xhorse VVDI Mini, Tango). The writer burns the physical
              transponder; pairing on the car still goes through the
              RFHUB tab's RoutineControl 0x0401 flow. SEC16 master secret
              never leaves the browser; nothing is uploaded.
            </div>
            <div style={{ fontSize: 11, color: '#7A3800', marginTop: 6, fontStyle: 'italic' }}>
              Protocol framing matches public Xhorse VVDI Mini USB-CDC captures and has NOT been bench-verified in this codebase. Use the Simulator first; treat live burns as field-verification of the framing.
            </div>
          </div>
        </div>
      </Card>

      {/* RFHUB loader */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>1. Load RFHUB dump</span>
          <input
            type="file"
            accept=".bin,.dat,.hex"
            onChange={onLoadRfh}
            data-testid="kwriter-load-rfh"
            style={{ fontSize: 12 }}
          />
          {rfhFile && <Tag color={C.tm}>{rfhFile.name} · {rfhBytes?.length ?? 0} B</Tag>}
          {parsed && <Tag color={C.gn}>gen {parsed.gen}</Tag>}
          {parsed?.sec16?.match && <Tag color={C.gn}>SEC16 slots match</Tag>}
          {parsed && !parsed.sec16?.match && <Tag color={C.wn}>SEC16 slots differ</Tag>}
        </div>
        {parseError && (
          <div style={{ color: C.er, fontSize: 12, marginTop: 4 }}>✗ {parseError}</div>
        )}
        {secretBlank && parsed && (
          <div style={{ color: C.er, fontSize: 12, marginTop: 4, fontWeight: 700 }}>
            ✗ RFHUB SEC16 is blank (all 0xFF / 0x00) — refusing to burn. Load a paired RFHUB.
          </div>
        )}
        {!parsed && !parseError && (
          <div style={{ color: C.ts, fontSize: 12, marginTop: 4 }}>
            Drop a 2 KB Gen1, 4 KB Gen2, or 8 KB Gen2 RFHUB dump. The tab will pick the first occupied slot for you.
          </div>
        )}
      </Card>

      {/* Slot picker */}
      {parsed && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, marginBottom: 8 }}>2. Pick slot</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
            {parsed.slots.map((s) => {
              const sel = slotIdx === s.idx;
              const idHex = s.idBytes ? hexJoin(s.idBytes) : '—';
              const disabled = !s.occupied || !s.idMapped;
              return (
                <div
                  key={s.idx}
                  onClick={() => !disabled && setSlotIdx(s.idx)}
                  data-testid={`kwriter-slot-${s.idx}`}
                  style={{
                    padding: 10,
                    border: `2px solid ${sel ? C.a3 : C.bd}`,
                    borderRadius: 8,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    background: sel ? C.a3 + '14' : C.bg,
                    opacity: disabled ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 900, fontSize: 12 }}>Slot {s.idx + 1}</span>
                    <Tag color={s.occupied ? C.gn : C.tm}>{s.occupied ? 'AA-50' : 'empty'}</Tag>
                    {s.idMapped ? null : <Tag color={C.wn}>id unmapped</Tag>}
                  </div>
                  <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: C.ts }}>
                    ID @ 0x{(s.idOffset ?? 0).toString(16).toUpperCase()}
                  </div>
                  <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: C.tx, marginTop: 4, wordBreak: 'break-all' }}>
                    {idHex}
                  </div>
                </div>
              );
            })}
          </div>
          {slot && (
            <div style={{ marginTop: 12, fontSize: 11, color: C.ts }}>
              Picked slot {slot.idx + 1}. {KEY_ID_BLOCK_LEN} bytes of chip ID will be sent to the writer along with the resolved RFHUB SEC16.
            </div>
          )}
        </Card>
      )}

      {/* Chip + writer + transport */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, marginBottom: 8 }}>3. Pick chip, writer, transport</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>CHIP FAMILY</div>
            <select
              value={chipId}
              onChange={(e) => setChipId(e.target.value)}
              data-testid="kwriter-chip"
              style={{ width: '100%', padding: 6, fontSize: 12 }}
            >
              {CHIP_FAMILIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>WRITER</div>
            <select
              value={writerId}
              onChange={(e) => setWriterId(e.target.value)}
              data-testid="kwriter-writer"
              style={{ width: '100%', padding: 6, fontSize: 12 }}
            >
              {WRITERS.map((w) => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 12, padding: 10, border: `1px solid ${C.bd}`, borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn
              onClick={() => { disconnectSerial(); setMode('sim'); }}
              color={mode === 'sim' ? C.a3 : C.tm}
              outline={mode !== 'sim'}
              data-testid="kwriter-mode-sim"
            >
              Simulator
            </Btn>
            <Btn
              onClick={connectSerial}
              color={mode === 'webserial' ? C.gn : C.tm}
              outline={mode !== 'webserial'}
              disabled={!isWebSerialAvailable()}
              data-testid="kwriter-mode-serial"
            >
              {mode === 'webserial' ? '✓ Web Serial connected' : 'Connect Web Serial'}
            </Btn>
            {mode === 'webserial' && (
              <Btn onClick={disconnectSerial} color={C.tm} outline>Disconnect</Btn>
            )}
            {!isWebSerialAvailable() && (
              <span style={{ fontSize: 11, color: C.ts }}>
                Web Serial unavailable in this browser — Simulator only.
              </span>
            )}
          </div>
          {mode === 'sim' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4, marginBottom: 4 }}>SIMULATOR FAULT PROFILE</div>
              <select
                value={simProfile}
                onChange={(e) => setSimProfile(e.target.value)}
                data-testid="kwriter-sim-profile"
                style={{ padding: 6, fontSize: 12 }}
              >
                {SIM_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
          )}
          {serialError && (
            <div style={{ color: C.er, fontSize: 12, marginTop: 6 }}>✗ {serialError}</div>
          )}
        </div>
      </Card>

      {/* Burn button + audit */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, flex: 1 }}>4. Burn + verify</div>
          <Btn
            onClick={runBurn}
            color={canBurn ? C.er : C.tm}
            disabled={!canBurn}
            data-testid="kwriter-burn"
          >
            {busy ? '⏳ Burning…' : '▶ Burn slot'}
          </Btn>
        </div>
        {!canBurn && !busy && (
          <div style={{ fontSize: 11, color: C.ts }}>
            Burn enables once every gate is green:
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              <li>RFHUB loaded {parsed ? '✓' : '✗'}</li>
              <li>Slot picked with AA-50 + ID block {slot && slot.occupied && slot.idMapped ? '✓' : '✗'}</li>
              <li>SEC16 master secret non-blank {secret16 && !secretBlank ? '✓' : '✗'}</li>
              <li>Chip family known {chipDef ? '✓' : '✗'}</li>
              <li>Slot id length matches chip ({chipDef ? `${chipDef.uidBytes + chipDef.payloadBytes} B` : '—'}) {idShapeMatch ? '✓' : '✗'}</li>
              <li>Writer supported by chip family {writerSupported ? '✓' : '✗'}</li>
            </ul>
          </div>
        )}
        {result && (
          <div style={{ marginTop: 8 }}>
            <Tag color={result.ok ? C.gn : C.er}>
              {result.ok ? 'KEYMOD WRITTEN' : `KEYMOD REFUSED @ ${result.failedAt || 'unknown'}`}
            </Tag>
          </div>
        )}
        {log.length > 0 && (
          <div
            data-testid="kwriter-log"
            style={{
              marginTop: 12,
              padding: 10,
              background: '#111',
              color: '#eee',
              fontFamily: 'JetBrains Mono',
              fontSize: 11,
              borderRadius: 6,
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {log.map((e, i) => (
              <div
                key={i}
                style={{
                  color: e.level === 'ok' ? '#7CFC9F' : e.level === 'err' ? '#FF6B6B' : '#9AD',
                }}
              >
                {e.msg}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Handoff hint */}
      {result?.ok && (
        <Card style={{ marginBottom: 16, background: '#E8F5E9', borderColor: C.gn }}>
          <div style={{ fontSize: 12, color: '#1B5E20', lineHeight: 1.6 }}>
            ✓ Chip burn verified. Next step: leave the chip in the FOBIK, switch to the <strong>RFHUB</strong> tab, and run the RoutineControl 0x0401 pairing with the same VIN — the receiver will accept the freshly-burned ID because its UID + payload already match the SEC16 master secret you just sent the writer.
          </div>
        </Card>
      )}
    </div>
  );
}
