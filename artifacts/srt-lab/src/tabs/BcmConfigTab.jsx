/* BcmConfigTab — live BCM Configuration editor for DIDs 0xDE00..0xDE0C.
 *
 * Surfaces the 155-field DE_FEATURE_CATALOG as toggle switches, dropdowns
 * and integer inputs grouped by DID. Drives the same read/unlock/write
 * pattern as ProxiEditor:
 *
 *   1. "Read All" → 10 03 then 22 DEnn for each of 13 DIDs.
 *   2. tech edits per-field controls; encoded payload diffs the read.
 *   3. "Write Selected DID" → cfBCM unlock → 2E DEnn [encoded bytes],
 *      optionally followed by 11 01 ECU reset.
 *
 * Per-field encoding preserves bits the catalog does not name — every
 * write starts from the freshly-read payload and only overlays the
 * fields whose values changed.
 *
 * Includes "Load synthetic" for offline round-trip demos and an
 * SRT-only filter checkbox so the Performance & SRT card jumps to the
 * top of the screen for the user's primary workflow (Red Key /
 * Performance Pages / Track Mode / Drag Mode etc).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import {
  BCM_CONFIG_DIDS,
  groupCatalogByDid,
  didPayloadByteLength,
  decodeBcmDid,
  encodeBcmDid,
  bcmDidName,
} from '../lib/bcmConfigCodec.js';
import {
  readAllBcmConfigDids,
  readBcmConfigDid,
  writeBcmConfigDid,
  unlockBcmForConfig,
  BCM_TX_DEFAULT,
  BCM_RX_DEFAULT,
} from '../lib/bcmConfigBridge.js';

function hxDid(did) {
  return '0x' + did.toString(16).toUpperCase().padStart(4, '0');
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/* Synthetic payload for a DID: deterministic non-zero pattern so every
 * field has a visible value without a live BCM. */
function syntheticPayload(did) {
  const len = didPayloadByteLength(did);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 37 + (did & 0xFF) * 13) & 0xFF;
  return out;
}

export default function BcmConfigTab({ vehicle }) {
  const grouped = useMemo(() => groupCatalogByDid(), []);
  const [tx, setTx] = useState(BCM_TX_DEFAULT);
  const [rx, setRx] = useState(BCM_RX_DEFAULT);
  const [resetAfterWrite, setResetAfterWrite] = useState(true);
  const [srtFirst, setSrtFirst] = useState(true);

  // payloads[did] = { ok, payload?, error? }
  const [payloads, setPayloads] = useState({});
  // edits[did] = { [fieldName]: number }
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(''); // '' | 'reading' | 'writing'
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const engineRef = useRef(null);

  const log = useCallback((m, t = 'info') => {
    setLogLines((arr) => {
      const next = arr.concat({ t, m, ts: Date.now() });
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const onReadAll = useCallback(async () => {
    setBusy('reading');
    setStatus({ kind: 'info', msg: 'Reading all 13 BCM Configuration DIDs…' });
    log('Read All BCM config (13 DIDs)');
    const r = await readAllBcmConfigDids({
      addLog: log, tx, rx, engine: engineRef.current,
    });
    if (r.engine) engineRef.current = r.engine;
    if (!r.ok) {
      setStatus({ kind: 'err', msg: r.error || 'Read failed' });
      setBusy('');
      return;
    }
    setPayloads(r.results);
    setEdits({});
    const okCount = Object.values(r.results).filter((x) => x.ok).length;
    setStatus({
      kind: okCount === BCM_CONFIG_DIDS.length ? 'ok' : 'info',
      msg: `Read ${okCount}/${BCM_CONFIG_DIDS.length} DIDs`,
    });
    setBusy('');
  }, [tx, rx, log]);

  const onReadOne = useCallback(async (did) => {
    setBusy('reading');
    setStatus({ kind: 'info', msg: `Reading ${hxDid(did)}…` });
    const r = await readBcmConfigDid({
      addLog: log, tx, rx, did, engine: engineRef.current,
    });
    if (r.engine) engineRef.current = r.engine;
    setPayloads((p) => ({
      ...p,
      [did]: r.ok ? { ok: true, payload: r.payload } : { ok: false, error: r.error, nrc: r.nrc },
    }));
    setEdits((e) => { const n = { ...e }; delete n[did]; return n; });
    setStatus(r.ok
      ? { kind: 'ok', msg: `${hxDid(did)} ${r.payload.length} B` }
      : { kind: 'err', msg: `${hxDid(did)} ${r.error}` });
    setBusy('');
  }, [tx, rx, log]);

  const onLoadSynthetic = useCallback(() => {
    const next = {};
    for (const did of BCM_CONFIG_DIDS) {
      next[did] = { ok: true, payload: syntheticPayload(did) };
    }
    setPayloads(next);
    setEdits({});
    setStatus({ kind: 'info', msg: 'Loaded synthetic dump (offline demo) — all 13 DIDs populated' });
    log('Loaded synthetic BCM config dump');
  }, [log]);

  const onEdit = useCallback((did, fieldName, value) => {
    setEdits((e) => {
      const dE = { ...(e[did] || {}), [fieldName]: value };
      return { ...e, [did]: dE };
    });
  }, []);

  const onResetEdits = useCallback((did) => {
    setEdits((e) => { const n = { ...e }; delete n[did]; return n; });
  }, []);

  const onWriteOne = useCallback(async (did) => {
    const slot = payloads[did];
    if (!slot || !slot.ok) {
      setStatus({ kind: 'err', msg: `Read ${hxDid(did)} first.` });
      return;
    }
    const dE = edits[did] || {};
    if (Object.keys(dE).length === 0) {
      setStatus({ kind: 'info', msg: `No pending edits for ${hxDid(did)}.` });
      return;
    }
    if (!engineRef.current) {
      setStatus({ kind: 'err', msg: 'No bridge engine — click Read All first to open the channel.' });
      return;
    }
    const encoded = encodeBcmDid(did, dE, slot.payload);
    if (!window.confirm(
      `Write ${hxDid(did)} — ${bcmDidName(did)} (${encoded.length} B) to the live BCM?\n\n` +
      `Pending field changes: ${Object.keys(dE).length}\n` +
      `${resetAfterWrite ? 'ECU reset (11 01) WILL be issued after the write.' : 'No reset will be issued.'}\n\n` +
      `This is a real WriteDataByIdentifier (2E) and will modify the BCM.`,
    )) {
      log(`Write ${hxDid(did)} cancelled by tech`, 'warn');
      return;
    }
    setBusy('writing');
    setStatus({ kind: 'info', msg: `Unlocking BCM (cfBCM seed→key)…` });
    const u = await unlockBcmForConfig(engineRef.current, { addLog: log, tx, rx });
    if (!u.ok) {
      setStatus({ kind: 'err', msg: 'Unlock failed: ' + (u.error || 'unknown') });
      setBusy('');
      return;
    }
    setStatus({ kind: 'info', msg: `Writing ${hxDid(did)}…` });
    const w = await writeBcmConfigDid(engineRef.current, did, encoded, {
      addLog: log, tx, rx, reset: resetAfterWrite,
    });
    if (!w.ok) {
      setStatus({ kind: 'err', msg: 'Write failed: ' + (w.error || 'unknown') });
      setBusy('');
      return;
    }
    setPayloads((p) => ({ ...p, [did]: { ok: true, payload: encoded } }));
    setEdits((e) => { const n = { ...e }; delete n[did]; return n; });
    setStatus({ kind: 'ok', msg: `Wrote ${hxDid(did)} (${encoded.length} B)${resetAfterWrite ? ' · reset issued' : ''}` });
    setBusy('');
  }, [payloads, edits, resetAfterWrite, tx, rx, log]);

  // Order DIDs: Performance & SRT (DE0A) first if user asked, then the rest.
  const orderedDids = useMemo(() => {
    if (!srtFirst) return BCM_CONFIG_DIDS;
    return [0xDE0A, ...BCM_CONFIG_DIDS.filter((d) => d !== 0xDE0A)];
  }, [srtFirst]);

  return (
    <div>
      <Card style={{ marginBottom: 12, border: `1.5px solid ${C.sr}33`, background: '#FFFAF8' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 22 }}>⚙️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: C.sr, letterSpacing: 1.2 }}>
              BCM CONFIGURATION (DIDs 0xDE00..0xDE0C · 155 fields)
            </div>
            <div style={{ fontSize: 11, color: C.tm, marginTop: 2 }}>
              SRT Performance Pages · Launch Control · Line Lock · Trans Brake · Track Mode · Drag Mode ·
              Valet · Lighting · Door Lock · Horn · Comfort · Windows · Mirrors · Wipers · Engine ·
              Display · Security · Vehicle · TPMS — read · edit · cfBCM unlock · write · reset.
              {vehicle?.name ? ` Vehicle: ${vehicle.name}.` : ''}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <Field label="BCM TX" value={tx} onChange={setTx} disabled={busy !== ''} />
          <Field label="BCM RX" value={rx} onChange={setRx} disabled={busy !== ''} />
          <label style={{ fontSize: 11, color: C.tm, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={resetAfterWrite} onChange={(e) => setResetAfterWrite(e.target.checked)} disabled={busy !== ''} />
            ECU reset after write (11 01)
          </label>
          <label style={{ fontSize: 11, color: C.tm, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={srtFirst} onChange={(e) => setSrtFirst(e.target.checked)} />
            Performance & SRT first
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn onClick={onReadAll} disabled={busy !== ''} color={C.a3}>
            {busy === 'reading' ? '⏳ Reading…' : '📖 Read All (13 DIDs)'}
          </Btn>
          <Btn onClick={onLoadSynthetic} color={C.tm} outline disabled={busy !== ''}>
            🧪 Load synthetic dump
          </Btn>
        </div>

        {status && (
          <div style={{
            marginTop: 10,
            padding: '8px 12px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 700,
            background:
              status.kind === 'ok' ? C.gn + '14' :
              status.kind === 'err' ? C.er + '14' :
              C.a3 + '14',
            color:
              status.kind === 'ok' ? C.gn :
              status.kind === 'err' ? C.er :
              C.a3,
            border: `1px solid ${
              status.kind === 'ok' ? C.gn :
              status.kind === 'err' ? C.er :
              C.a3
            }44`,
          }}>
            {status.kind === 'ok' ? '✓ ' : status.kind === 'err' ? '✗ ' : 'ℹ '}{status.msg}
          </div>
        )}
      </Card>

      {orderedDids.map((did) => (
        <DidCard
          key={did}
          did={did}
          fields={grouped.get(did) || []}
          slot={payloads[did]}
          edits={edits[did] || {}}
          busy={busy !== ''}
          onReadOne={() => onReadOne(did)}
          onWriteOne={() => onWriteOne(did)}
          onResetEdits={() => onResetEdits(did)}
          onEdit={(name, v) => onEdit(did, name, v)}
        />
      ))}

      {logLines.length > 0 && (
        <Card style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: C.tm, fontWeight: 700, marginBottom: 6, letterSpacing: 1 }}>
            BRIDGE LOG (last {logLines.length})
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', fontFamily: 'monospace', fontSize: 10, color: C.tx }}>
            {logLines.slice().reverse().map((l, i) => (
              <div key={i} style={{ color: l.t === 'err' ? C.er : l.t === 'warn' ? C.wn : l.t === 'rx' ? C.gn : C.tm }}>
                {new Date(l.ts).toISOString().slice(11, 19)} {l.m}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function DidCard({ did, fields, slot, edits, busy, onReadOne, onWriteOne, onResetEdits, onEdit }) {
  const [open, setOpen] = useState(did === 0xDE0A);
  const isSrt = did === 0xDE0A;
  const decoded = useMemo(() => {
    if (!slot || !slot.ok) return null;
    return decodeBcmDid(did, slot.payload);
  }, [slot, did]);
  const pendingCount = Object.keys(edits).length;

  return (
    <Card style={{
      marginBottom: 10,
      border: `1.5px solid ${isSrt ? C.sr : C.bd}`,
      background: isSrt ? '#FFFAF8' : '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <div style={{ fontSize: 16 }}>{open ? '▾' : '▸'}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 900, fontSize: 13, color: isSrt ? C.sr : C.tx }}>
            {hxDid(did)} · {bcmDidName(did)}
            {isSrt && <span style={{ marginLeft: 8, fontSize: 10, color: C.sr, letterSpacing: 1 }}>★ SRT</span>}
          </div>
          <div style={{ fontSize: 10, color: C.tm, marginTop: 2 }}>
            {fields.length} fields · {didPayloadByteLength(did)} B payload
            {slot?.ok ? ` · read OK` : slot ? ` · ${slot.error || 'not read'}` : ' · not read'}
            {pendingCount > 0 && <span style={{ color: C.wn, marginLeft: 6 }}>· {pendingCount} pending edit{pendingCount === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <Btn onClick={onReadOne} disabled={busy} color={C.a3} outline>📖 Read</Btn>
          <Btn onClick={onWriteOne} disabled={busy || pendingCount === 0 || !slot?.ok} color={C.sr}>💾 Write</Btn>
          {pendingCount > 0 && (
            <Btn onClick={onResetEdits} disabled={busy} color={C.tm} outline>✕ Revert</Btn>
          )}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {slot?.ok && (
            <div style={{ fontFamily: 'monospace', fontSize: 10, color: C.tm, marginBottom: 8, wordBreak: 'break-all' }}>
              <strong>Payload:</strong> {bytesToHex(slot.payload)}
            </div>
          )}
          {!slot && (
            <div style={{ padding: 12, color: C.tm, fontStyle: 'italic', fontSize: 12 }}>
              Click Read to pull this DID, or "Read All" / "Load synthetic" above.
            </div>
          )}
          {slot && !slot.ok && (
            <div style={{ padding: 8, color: C.er, fontSize: 12, fontWeight: 700 }}>
              ✗ {slot.error}
            </div>
          )}
          {decoded && (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: C.tm, fontSize: 10, letterSpacing: 0.8, textAlign: 'left', borderBottom: `1px solid ${C.bd}` }}>
                  <th style={{ padding: '6px 4px' }}>FIELD</th>
                  <th style={{ padding: '6px 4px', width: 70 }}>BIT/LEN</th>
                  <th style={{ padding: '6px 4px', width: 280 }}>VALUE</th>
                </tr>
              </thead>
              <tbody>
                {decoded.map((row, i) => {
                  const f = row.field;
                  const editVal = Object.prototype.hasOwnProperty.call(edits, f.name) ? edits[f.name] : null;
                  const effective = editVal != null ? editVal : (row.raw ?? 0);
                  const changed = editVal != null && editVal !== row.raw;
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${C.bd}55`, background: changed ? C.wn + '11' : 'transparent' }}>
                      <td style={{ padding: '5px 4px' }}>
                        <div style={{ fontWeight: 600 }}>{f.name}</div>
                      </td>
                      <td style={{ padding: '5px 4px', fontFamily: 'monospace', color: C.tm }}>
                        {f.bit}/{f.length}
                      </td>
                      <td style={{ padding: '5px 4px' }}>
                        <FieldControl
                          field={f}
                          value={effective}
                          onChange={(v) => onEdit(f.name, v)}
                          disabled={busy}
                        />
                        {changed && (
                          <span style={{ marginLeft: 8, fontSize: 10, color: C.wn, fontWeight: 700 }}>
                            (was {row.label})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

function FieldControl({ field, value, onChange, disabled }) {
  const hasOptions = field.options && field.options.length > 0;
  if (field.length === 1 && !hasOptions) {
    // bare boolean
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked ? 1 : 0)}
          disabled={disabled}
        />
        <span>{value ? 'Enabled' : 'Disabled'}</span>
      </label>
    );
  }
  if (hasOptions) {
    const present = field.options.some((o) => o.value === value);
    return (
      <select
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        disabled={disabled}
        style={{ padding: '5px 8px', borderRadius: 6, border: `1.5px solid ${C.bd}`, fontSize: 12, fontFamily: 'monospace', minWidth: 200 }}
      >
        {!present && <option value={value}>{`${value} (raw — not in catalog)`}</option>}
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>{o.value} — {o.label}</option>
        ))}
      </select>
    );
  }
  // free integer
  const max = field.length >= 31 ? 0xFFFFFFFF : ((1 << field.length) - 1);
  return (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= 0 && n <= max) onChange(n);
      }}
      disabled={disabled}
      style={{ width: 100, padding: '5px 8px', borderRadius: 6, border: `1.5px solid ${C.bd}`, fontSize: 12, fontFamily: 'monospace' }}
    />
  );
}

function Field({ label, value, onChange, disabled }) {
  return (
    <label style={{ fontSize: 11, color: C.tm, display: 'flex', alignItems: 'center', gap: 6 }}>
      {label}
      <input
        value={'0x' + value.toString(16).toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.replace(/^0x/i, '');
          const n = parseInt(v, 16);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        style={{ width: 80, padding: '6px 8px', borderRadius: 7, border: `1.5px solid ${C.bd}`, fontFamily: 'monospace', fontSize: 12 }}
      />
    </label>
  );
}
