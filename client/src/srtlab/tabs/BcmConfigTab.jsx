/* BcmConfigTab — live BCM Configuration editor with hero category
 * banners and a dark SRT-style layout.
 *
 * 61 DIDs (13 DE00..DE0C + 48 BCM body extras) are bucketed by
 * `bcmConfigCategories.js` into ten themed sections. Each section
 * shows a Pixar-style 16:9 hero image, the category accent colour,
 * and a row of DID cards — every card collapses to a header and
 * expands into a table of pill toggles, dropdowns, and integer inputs.
 *
 * Read / unlock / write flow is unchanged from the original tab:
 *   1. "READ ALL" → 10 03 then 22 DEnn for each DID.
 *   2. tech edits per-field controls; encoded payload diffs the read.
 *   3. "WRITE" on a card → cfBCM unlock → 2E DEnn [bytes], optional
 *      11 01 reset.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { C } from '../lib/constants.js';
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
import { bucketDids, categoryForDid, PERF_SUBGROUPS, bucketPerfRows } from '../lib/bcmConfigCategories.js';

/* ───────── helpers ───────── */

function hxDid(did) {
  return '0x' + did.toString(16).toUpperCase().padStart(4, '0');
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function syntheticPayload(did) {
  const len = didPayloadByteLength(did);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 37 + (did & 0xFF) * 13) & 0xFF;
  return out;
}

/* ───────── theme ─────────
 * Dark SRT palette overrides — the rest of the app uses the light C
 * theme but this tab is intentionally a dark hero surface.
 */
const T = {
  bg: '#0A0A0A',
  card: 'rgba(20,20,22,0.92)',
  cardLow: 'rgba(28,28,32,0.92)',
  border: 'rgba(255,255,255,0.08)',
  borderHi: 'rgba(255,255,255,0.18)',
  text: '#F5F5F5',
  textMid: 'rgba(255,255,255,0.62)',
  textLow: 'rgba(255,255,255,0.42)',
  red: '#FF1744',
  green: '#00E676',
  amber: '#FFB300',
};

/* ───────── tiny styled primitives (local to this tab) ───────── */

function Pill({ on, label, sub, onToggle, disabled, accent = T.red }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle(!on)}
      disabled={disabled}
      aria-pressed={on}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '6px 12px 6px 6px', borderRadius: 999,
        background: on ? accent + '22' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${on ? accent : T.border}`,
        color: on ? accent : T.textMid,
        fontFamily: "'Nunito', system-ui, sans-serif",
        fontSize: 12, fontWeight: 800, letterSpacing: 0.4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, transition: 'all 0.18s',
        minWidth: 110,
      }}
      title={sub || ''}
    >
      <span style={{
        width: 22, height: 22, borderRadius: '50%',
        background: on ? accent : 'rgba(255,255,255,0.08)',
        boxShadow: on ? `0 0 10px ${accent}` : 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: on ? '#0A0A0A' : T.textLow, fontSize: 12, fontWeight: 900,
        transition: 'all 0.18s',
      }}>{on ? '✓' : '○'}</span>
      <span style={{ textAlign: 'left' }}>
        {label}
        {sub && <div style={{ fontSize: 9, color: T.textLow, marginTop: 1, fontWeight: 600, letterSpacing: 0.6 }}>{sub}</div>}
      </span>
    </button>
  );
}

function Btn({ onClick, disabled, children, accent = T.red, ghost, full, size = 'md' }) {
  const pad = size === 'sm' ? '6px 12px' : '10px 18px';
  const fsz = size === 'sm' ? 11 : 12;
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        padding: pad, borderRadius: 10,
        border: ghost ? `1px solid ${accent}55` : `1px solid ${accent}`,
        background: ghost ? 'transparent' : accent,
        color: ghost ? accent : '#0A0A0A',
        fontFamily: "'Nunito', system-ui, sans-serif",
        fontSize: fsz, fontWeight: 900, letterSpacing: 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        width: full ? '100%' : undefined,
        transition: 'all 0.15s',
        textTransform: 'uppercase',
      }}
    >{children}</button>
  );
}

function HexInput({ label, value, onChange, disabled }) {
  return (
    <label style={{ fontSize: 10, color: T.textLow, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, letterSpacing: 1 }}>
      {label}
      <input
        value={'0x' + value.toString(16).toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.replace(/^0x/i, '');
          const n = parseInt(v, 16);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        style={{
          width: 84, padding: '6px 8px', borderRadius: 7,
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${T.border}`, color: T.text,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
        }}
      />
    </label>
  );
}

/* ───────── main ───────── */

export default function BcmConfigTab({ vehicle }) {
  const grouped = useMemo(() => groupCatalogByDid(), []);
  const buckets = useMemo(() => bucketDids(BCM_CONFIG_DIDS), []);
  const [tx, setTx] = useState(BCM_TX_DEFAULT);
  const [rx, setRx] = useState(BCM_RX_DEFAULT);
  const [resetAfterWrite, setResetAfterWrite] = useState(true);
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState('perf');

  const [payloads, setPayloads] = useState({});
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const engineRef = useRef(null);
  const sectionRefs = useRef({});

  const log = useCallback((m, t = 'info') => {
    setLogLines((arr) => {
      const next = arr.concat({ t, m, ts: Date.now() });
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const onReadAll = useCallback(async () => {
    setBusy('reading');
    setStatus({ kind: 'info', msg: `Reading all ${BCM_CONFIG_DIDS.length} BCM Configuration DIDs…` });
    log(`Read All BCM config (${BCM_CONFIG_DIDS.length} DIDs)`);
    const r = await readAllBcmConfigDids({ addLog: log, tx, rx, engine: engineRef.current });
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
    const r = await readBcmConfigDid({ addLog: log, tx, rx, did, engine: engineRef.current });
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
    setStatus({ kind: 'info', msg: `Loaded synthetic dump (offline demo) — all ${BCM_CONFIG_DIDS.length} DIDs populated` });
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
      log(`Write ${hxDid(did)} cancelled by user`, 'warn');
      return;
    }
    setBusy('writing');
    setStatus({ kind: 'info', msg: 'Unlocking BCM (cfBCM seed→key)…' });
    const u = await unlockBcmForConfig(engineRef.current, { addLog: log, tx, rx });
    if (!u.ok) {
      setStatus({ kind: 'err', msg: 'Unlock failed: ' + (u.error || 'unknown') });
      setBusy('');
      return;
    }
    setStatus({ kind: 'info', msg: `Writing ${hxDid(did)}…` });
    const w = await writeBcmConfigDid(engineRef.current, did, encoded, { addLog: log, tx, rx, reset: resetAfterWrite });
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

  /* derived counts per category */
  const counts = useMemo(() => {
    const m = {};
    for (const { category, dids } of buckets) {
      let fields = 0, pending = 0, read = 0;
      for (const did of dids) {
        fields += (grouped.get(did) || []).length;
        if (payloads[did]?.ok) read += 1;
        pending += Object.keys(edits[did] || {}).length;
      }
      m[category.id] = { fields, dids: dids.length, pending, read };
    }
    return m;
  }, [buckets, grouped, payloads, edits]);

  const totalFields = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b.fields, 0),
    [counts],
  );
  const totalPending = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b.pending, 0),
    [counts],
  );

  const scrollTo = useCallback((catId) => {
    setActiveCat(catId);
    const el = sectionRefs.current[catId];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const lcSearch = search.trim().toLowerCase();

  return (
    <div style={{
      borderRadius: 16, overflow: 'hidden',
      background: T.bg, color: T.text,
      fontFamily: "'Nunito', system-ui, sans-serif",
    }}>
      {/* HERO HEADER */}
      <div style={{
        position: 'relative', padding: '28px 28px 22px',
        background: `
          radial-gradient(ellipse 80% 60% at 0% 0%, ${T.red}22, transparent 60%),
          radial-gradient(ellipse 60% 50% at 100% 100%, ${T.amber}18, transparent 60%),
          linear-gradient(180deg, #15080A 0%, #0A0A0A 100%)
        `,
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 4 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 11,
            background: `linear-gradient(135deg, ${T.red}, #B71C1C)`,
            boxShadow: `0 6px 24px ${T.red}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 900, color: '#0A0A0A',
          }}>⚙</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: T.red, fontWeight: 900, letterSpacing: 3 }}>
              SRT LAB · BCM CONFIGURATION
            </div>
            <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1, marginTop: 4, letterSpacing: -0.5 }}>
              {BCM_CONFIG_DIDS.length} DIDs · {totalFields} TOGGLES
              <span style={{ color: T.red, marginLeft: 6 }}>.</span>
            </div>
            <div style={{ fontSize: 11, color: T.textMid, marginTop: 8, maxWidth: 720, lineHeight: 1.55 }}>
              Live BCM body parameters across DE00..DE0C and 0x04C0..0x05DF, bucketed into ten themed
              categories. Read · edit · cfBCM unlock · WriteDataByIdentifier · optional ECU reset.
              {vehicle?.name ? <> Vehicle: <strong style={{ color: T.text }}>{vehicle.name}</strong>.</> : null}
            </div>
          </div>
        </div>
      </div>

      {/* STICKY TOOLBAR */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5,
        padding: '14px 22px',
        background: 'rgba(10,10,10,0.95)',
        borderBottom: `1px solid ${T.border}`,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn onClick={onReadAll} disabled={busy !== ''}>
            {busy === 'reading' ? 'READING…' : `📖 READ ALL`}
          </Btn>
          <Btn onClick={onLoadSynthetic} disabled={busy !== ''} ghost accent={T.amber}>
            🧪 SYNTHETIC DUMP
          </Btn>
          <div style={{ flex: 1, minWidth: 180 }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍  Search field, DID or category…"
              style={{
                width: '100%', padding: '9px 14px', borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${T.border}`, color: T.text,
                fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                outline: 'none',
              }}
            />
          </div>
          <HexInput label="TX" value={tx} onChange={setTx} disabled={busy !== ''} />
          <HexInput label="RX" value={rx} onChange={setRx} disabled={busy !== ''} />
          <label style={{ fontSize: 10, color: T.textLow, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, letterSpacing: 1 }}>
            <input type="checkbox" checked={resetAfterWrite} onChange={(e) => setResetAfterWrite(e.target.checked)} disabled={busy !== ''} />
            RESET AFTER WRITE
          </label>
        </div>

        {/* category chips */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {buckets.map(({ category }) => {
            const k = counts[category.id] || { dids: 0, fields: 0, pending: 0 };
            const active = activeCat === category.id;
            return (
              <button
                key={category.id} type="button" onClick={() => scrollTo(category.id)}
                style={{
                  padding: '6px 12px', borderRadius: 999,
                  border: `1px solid ${active ? category.accent : T.border}`,
                  background: active ? category.accent + '22' : 'rgba(255,255,255,0.03)',
                  color: active ? category.accent : T.textMid,
                  fontSize: 10, fontWeight: 900, letterSpacing: 1,
                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                <span style={{ fontSize: 12 }}>{category.glyph}</span>
                {category.label}
                <span style={{
                  marginLeft: 4, padding: '1px 6px', borderRadius: 6,
                  background: category.accent + '33', color: category.accent,
                  fontSize: 9, fontWeight: 900,
                }}>{k.dids}</span>
                {k.pending > 0 && (
                  <span style={{
                    marginLeft: 2, padding: '1px 6px', borderRadius: 6,
                    background: T.amber + '33', color: T.amber,
                    fontSize: 9, fontWeight: 900,
                  }}>{k.pending}●</span>
                )}
              </button>
            );
          })}
        </div>

        {status && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 8,
            fontSize: 12, fontWeight: 800, letterSpacing: 0.4,
            background:
              status.kind === 'ok' ? T.green + '14' :
              status.kind === 'err' ? T.red + '14' :
              'rgba(41,121,255,0.14)',
            color:
              status.kind === 'ok' ? T.green :
              status.kind === 'err' ? T.red :
              '#82B1FF',
            border: `1px solid ${
              status.kind === 'ok' ? T.green :
              status.kind === 'err' ? T.red :
              '#82B1FF'
            }44`,
          }}>
            {status.kind === 'ok' ? '✓ ' : status.kind === 'err' ? '✗ ' : 'ℹ '}{status.msg}
          </div>
        )}

        {totalPending > 0 && (
          <div style={{
            marginTop: 8, padding: '6px 12px', borderRadius: 8,
            fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
            background: T.amber + '18', color: T.amber,
            border: `1px solid ${T.amber}44`,
          }}>
            ⚡ {totalPending} pending field edit{totalPending === 1 ? '' : 's'} across the body
          </div>
        )}
      </div>

      {/* SECTIONS */}
      <div style={{ padding: '18px 22px 22px' }}>
        {buckets.map(({ category, dids }) => (
          category.id === 'perf' ? (
            <PerfShowcase
              key={category.id}
              ref={(el) => { sectionRefs.current[category.id] = el; }}
              category={category}
              dids={dids}
              counts={counts[category.id]}
              grouped={grouped}
              payloads={payloads}
              edits={edits}
              busy={busy !== ''}
              search={lcSearch}
              vehicle={vehicle}
              onReadOne={onReadOne}
              onWriteOne={onWriteOne}
              onResetEdits={onResetEdits}
              onEdit={onEdit}
            />
          ) : (
            <CategorySection
              key={category.id}
              ref={(el) => { sectionRefs.current[category.id] = el; }}
              category={category}
              dids={dids}
              counts={counts[category.id]}
              grouped={grouped}
              payloads={payloads}
              edits={edits}
              busy={busy !== ''}
              search={lcSearch}
              onReadOne={onReadOne}
              onWriteOne={onWriteOne}
              onResetEdits={onResetEdits}
              onEdit={onEdit}
            />
          )
        ))}
      </div>

      {logLines.length > 0 && (
        <div style={{ padding: '0 22px 22px' }}>
          <div style={{
            background: T.cardLow, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: 14,
          }}>
            <div style={{ fontSize: 10, color: T.textLow, fontWeight: 900, marginBottom: 8, letterSpacing: 1.5 }}>
              BRIDGE LOG · LAST {logLines.length}
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>
              {logLines.slice().reverse().map((l, i) => (
                <div key={i} style={{
                  color: l.t === 'err' ? T.red : l.t === 'warn' ? T.amber : l.t === 'rx' ? T.green : T.textMid,
                  padding: '1px 0',
                }}>
                  <span style={{ color: T.textLow }}>{new Date(l.ts).toISOString().slice(11, 19)}</span> {l.m}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── category section ───────── */

const CategorySection = React.forwardRef(function CategorySection({
  category, dids, counts, grouped, payloads, edits, busy, search,
  onReadOne, onWriteOne, onResetEdits, onEdit,
}, ref) {
  const [collapsed, setCollapsed] = useState(false);

  // search filter — keep DIDs whose category, DID hex, name or any field
  // name matches.
  const visibleDids = useMemo(() => {
    if (!search) return dids;
    return dids.filter((did) => {
      if (category.label.toLowerCase().includes(search)) return true;
      if (hxDid(did).toLowerCase().includes(search)) return true;
      if ((bcmDidName(did) || '').toLowerCase().includes(search)) return true;
      const fields = grouped.get(did) || [];
      return fields.some((f) => (f.name || '').toLowerCase().includes(search));
    });
  }, [dids, search, grouped, category.label]);

  if (visibleDids.length === 0) return <div ref={ref} />;

  return (
    <section ref={ref} style={{ marginBottom: 24, scrollMarginTop: 220 }}>
      {/* hero banner */}
      <div
        role="button" tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`${category.label} category — ${collapsed ? 'expand' : 'collapse'}`}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((v) => !v); } }}
        style={{
          position: 'relative', height: 150, borderRadius: 14, overflow: 'hidden',
          cursor: 'pointer', marginBottom: 12,
          border: `1px solid ${T.border}`,
          background: category.image
            ? `url(${category.image}) center/cover no-repeat`
            : `linear-gradient(135deg, ${category.accent}33, transparent 60%)`,
          boxShadow: `0 8px 32px rgba(0,0,0,0.4)`,
        }}
      >
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(90deg, rgba(10,10,10,0.92) 0%, rgba(10,10,10,0.55) 50%, rgba(10,10,10,0.2) 100%)`,
        }} />
        <div style={{
          position: 'absolute', inset: 0, padding: '18px 22px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              padding: '4px 10px', borderRadius: 6,
              background: category.accent, color: '#0A0A0A',
              fontSize: 10, fontWeight: 900, letterSpacing: 1.5,
            }}>{category.glyph} {category.label}</span>
            <span style={{ fontSize: 10, color: T.textMid, fontWeight: 800, letterSpacing: 1 }}>
              {category.tag}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: T.textMid, fontWeight: 800, letterSpacing: 0.5 }}>
              {collapsed ? '▾ EXPAND' : '▴ COLLAPSE'}
            </span>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#fff', letterSpacing: -0.3, lineHeight: 1.1 }}>
              {counts.dids} DIDs · {counts.fields} fields
              {counts.read > 0 && <span style={{ color: T.green, marginLeft: 8, fontSize: 13 }}>✓ {counts.read} read</span>}
              {counts.pending > 0 && <span style={{ color: T.amber, marginLeft: 8, fontSize: 13 }}>● {counts.pending} pending</span>}
            </div>
            <div style={{ fontSize: 11, color: T.textMid, marginTop: 4, maxWidth: 760, lineHeight: 1.45 }}>
              {category.blurb}
            </div>
          </div>
        </div>
      </div>

      {!collapsed && (
        <div style={{ display: 'grid', gap: 10 }}>
          {visibleDids.map((did) => (
            <DidCard
              key={did} did={did} category={category}
              fields={grouped.get(did) || []}
              slot={payloads[did]}
              edits={edits[did] || {}}
              busy={busy} search={search}
              onReadOne={() => onReadOne(did)}
              onWriteOne={() => onWriteOne(did)}
              onResetEdits={() => onResetEdits(did)}
              onEdit={(name, v) => onEdit(did, name, v)}
            />
          ))}
        </div>
      )}
    </section>
  );
});

/* ───────── PERFORMANCE SHOWCASE (special render for category 'perf') ───────── */

const DE0A = 0xDE0A;

const PerfShowcase = React.forwardRef(function PerfShowcase({
  category, dids, counts, grouped, payloads, edits, busy, search, vehicle,
  onReadOne, onWriteOne, onResetEdits, onEdit,
}, ref) {
  const [collapsed, setCollapsed] = useState(false);

  // The DE0A "Performance & SRT Configuration" payload powers the
  // showcase sub-panels. Everything else in this category (0x0503,
  // 0x04F4, 0x04F8) renders below as standard DidCards.
  const de0aSlot = payloads[DE0A];
  const de0aRows = useMemo(() => {
    if (!de0aSlot || !de0aSlot.ok) return null;
    try { return decodeBcmDid(DE0A, de0aSlot.payload); } catch { return null; }
  }, [de0aSlot]);
  const de0aEdits = edits[DE0A] || {};
  const de0aPending = Object.keys(de0aEdits).length;

  const subPanels = useMemo(() => bucketPerfRows(de0aRows || []), [de0aRows]);

  // Filter sub-panels by search — keep the panel if its label matches
  // OR any of its rows' field names match.
  const visibleSubPanels = useMemo(() => {
    if (!search) return subPanels;
    return subPanels
      .map(({ group, rows }) => ({
        group,
        rows: rows.filter((r) => (r.field?.name || '').toLowerCase().includes(search)),
      }))
      .filter(({ group, rows }) => group.label.toLowerCase().includes(search) || rows.length > 0);
  }, [subPanels, search]);

  const extraDids = dids.filter((d) => d !== DE0A);

  // Live "POWER MODES" preview from decoded rows (for the hero strip).
  const liveModeChips = useMemo(() => {
    if (!de0aRows) return null;
    const want = [
      'Track Mode', 'Drag Mode', 'Custom Mode', 'ESC Sport Mode',
      'Race Options Menu', 'Performance Data Recorder', 'Widebody Enabled',
    ];
    return want
      .map((n) => de0aRows.find((r) => r.field?.name === n))
      .filter(Boolean)
      .map((r) => ({
        name: r.field.name,
        on: !!(de0aEdits[r.field.name] != null ? de0aEdits[r.field.name] : r.raw),
        pending: Object.prototype.hasOwnProperty.call(de0aEdits, r.field.name),
      }));
  }, [de0aRows, de0aEdits]);

  // Hide the section entirely if the search hides everything.
  const anyExtraVisible = extraDids.some((did) => {
    if (!search) return true;
    if (hxDid(did).toLowerCase().includes(search)) return true;
    if ((bcmDidName(did) || '').toLowerCase().includes(search)) return true;
    const fields = grouped.get(did) || [];
    return fields.some((f) => (f.name || '').toLowerCase().includes(search));
  });
  const anyDe0aVisible = visibleSubPanels.length > 0 || (!de0aRows && (!search ||
    'performance & srt'.includes(search) || hxDid(DE0A).toLowerCase().includes(search)));
  if (search && !anyExtraVisible && !anyDe0aVisible) return <div ref={ref} />;

  return (
    <section ref={ref} style={{ marginBottom: 28, scrollMarginTop: 220 }}>
      {/* TALL CINEMATIC HERO */}
      <div
        role="button" tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`Performance showcase — ${collapsed ? 'expand' : 'collapse'}`}
        onClick={() => setCollapsed((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((v) => !v); } }}
        style={{
          position: 'relative', height: 280, borderRadius: 18, overflow: 'hidden',
          cursor: 'pointer', marginBottom: 14,
          border: `1px solid ${T.red}66`,
          background: `url(${category.image}) center/cover no-repeat`,
          boxShadow: `0 16px 48px rgba(255,23,68,0.22), 0 8px 32px rgba(0,0,0,0.6)`,
        }}
      >
        {/* heavy left-to-right cinematic gradient */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse 70% 80% at 0% 50%, rgba(10,10,10,0.95) 0%, rgba(10,10,10,0.55) 45%, rgba(10,10,10,0.05) 75%),
            linear-gradient(180deg, rgba(10,10,10,0.45) 0%, rgba(10,10,10,0.2) 40%, rgba(10,10,10,0.85) 100%)
          `,
        }} />
        {/* red scanline glow at top */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: `linear-gradient(90deg, transparent, ${T.red}, transparent)`,
          boxShadow: `0 0 12px ${T.red}AA`,
        }} />
        <div style={{
          position: 'absolute', inset: 0, padding: '22px 26px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          {/* TOP ROW: badges + collapse */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{
              padding: '5px 11px', borderRadius: 6,
              background: T.red, color: '#0A0A0A',
              fontSize: 10, fontWeight: 900, letterSpacing: 1.6,
              boxShadow: `0 4px 14px ${T.red}66`,
            }}>{category.glyph} {category.label}</span>
            <span style={{
              padding: '4px 9px', borderRadius: 6,
              border: `1px solid ${T.red}66`, color: T.red,
              fontSize: 9, fontWeight: 900, letterSpacing: 1.4,
            }}>SHOWCASE</span>
            <span style={{ fontSize: 10, color: T.textMid, fontWeight: 800, letterSpacing: 1 }}>
              {category.tag}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: T.textMid, fontWeight: 800, letterSpacing: 0.5 }}>
              {collapsed ? '▾ EXPAND' : '▴ COLLAPSE'}
            </span>
          </div>

          {/* MIDDLE: huge headline */}
          <div>
            <div style={{
              fontSize: 44, fontWeight: 900, color: '#fff',
              letterSpacing: -1.2, lineHeight: 0.95,
              textShadow: `0 4px 24px rgba(0,0,0,0.8), 0 0 24px ${T.red}33`,
            }}>
              UNLOCK THE BEAST.
            </div>
            <div style={{ fontSize: 13, color: T.textMid, marginTop: 8, maxWidth: 620, lineHeight: 1.5 }}>
              {category.blurb}
              {vehicle?.name ? <> · <strong style={{ color: '#fff' }}>{vehicle.name}</strong></> : null}
            </div>
          </div>

          {/* BOTTOM: stat strip + live mode chips */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
            <PerfStat value={counts.dids} label="DIDs" accent={T.red} />
            <PerfStat value={counts.fields} label="TOGGLES" accent={T.amber} />
            <PerfStat value={counts.read} label="READ" accent={counts.read > 0 ? T.green : T.textLow} />
            <PerfStat value={counts.pending} label="PENDING" accent={counts.pending > 0 ? T.amber : T.textLow} />
            {liveModeChips && liveModeChips.length > 0 && (
              <div style={{
                marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap',
                maxWidth: '60%', justifyContent: 'flex-end',
              }} onClick={(e) => e.stopPropagation()}>
                {liveModeChips.map((chip) => (
                  <span key={chip.name} style={{
                    padding: '3px 8px', borderRadius: 999, fontSize: 9, fontWeight: 900,
                    letterSpacing: 0.8, whiteSpace: 'nowrap',
                    background: chip.on ? T.red + '33' : 'rgba(255,255,255,0.05)',
                    color: chip.on ? '#fff' : T.textLow,
                    border: `1px solid ${chip.on ? T.red : T.border}`,
                    boxShadow: chip.on ? `0 0 8px ${T.red}44` : 'none',
                  }}>
                    {chip.on ? '●' : '○'} {chip.name.toUpperCase()}
                    {chip.pending && <span style={{ color: T.amber, marginLeft: 4 }}>⚡</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* DE0A SUB-PANELS */}
          {!de0aSlot && (
            <div style={{
              padding: '24px 22px', borderRadius: 14,
              background: T.cardLow, border: `1px dashed ${T.red}66`,
              color: T.textMid, fontSize: 13, marginBottom: 14,
              textAlign: 'center', fontWeight: 700,
            }}>
              📡 Click <strong style={{ color: T.red }}>READ ALL</strong> in the toolbar (or{' '}
              <strong style={{ color: T.amber }}>SYNTHETIC DUMP</strong> for an offline preview) to populate the Performance & SRT Showcase.
              <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                <Btn onClick={() => onReadOne(DE0A)} disabled={busy} accent={T.red} size="sm">
                  📖 READ DE0A ONLY
                </Btn>
              </div>
            </div>
          )}
          {de0aSlot && !de0aSlot.ok && (
            <div style={{
              padding: '14px 18px', borderRadius: 12, marginBottom: 14,
              background: T.red + '14', border: `1px solid ${T.red}66`,
              color: T.red, fontSize: 12, fontWeight: 800,
            }}>
              ✗ DE0A read failed: {de0aSlot.error || 'unknown'}
            </div>
          )}
          {de0aRows && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
              gap: 12, marginBottom: 14,
            }}>
              {visibleSubPanels.map(({ group, rows }) => (
                <PerfSubPanel
                  key={group.id} group={group} rows={rows} edits={de0aEdits}
                  busy={busy}
                  onEdit={(name, v) => onEdit(DE0A, name, v)}
                />
              ))}
            </div>
          )}

          {/* DE0A WRITE/REVERT BAR */}
          {de0aRows && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 10, marginBottom: 18,
              background: de0aPending > 0 ? T.amber + '14' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${de0aPending > 0 ? T.amber + '88' : T.border}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 1.5, color: T.text }}>
                <span style={{ color: T.red, fontFamily: 'JetBrains Mono, monospace' }}>{hxDid(DE0A)}</span>{' '}
                · {(grouped.get(DE0A) || []).length} FIELDS
                {de0aPending > 0 && (
                  <span style={{ color: T.amber, marginLeft: 10 }}>● {de0aPending} PENDING</span>
                )}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Btn onClick={() => onReadOne(DE0A)} disabled={busy} ghost accent={T.red} size="sm">📖 RE-READ</Btn>
                {de0aPending > 0 && (
                  <Btn onClick={() => onResetEdits(DE0A)} disabled={busy} ghost accent={T.textMid} size="sm">✕ REVERT</Btn>
                )}
                <Btn onClick={() => onWriteOne(DE0A)} disabled={busy || de0aPending === 0 || !de0aSlot?.ok} accent={T.red} size="sm">
                  💾 WRITE DE0A
                </Btn>
              </div>
            </div>
          )}

          {/* EXTRAS DIDs (0x0503, 0x04F4, 0x04F8) — standard DidCards */}
          {extraDids.length > 0 && (
            <>
              <div style={{
                fontSize: 10, fontWeight: 900, letterSpacing: 2, color: T.textLow,
                margin: '18px 0 8px', paddingLeft: 4,
              }}>
                ▸ ADDITIONAL PERFORMANCE-RELATED BODY DIDs
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {extraDids
                  .filter((did) => {
                    if (!search) return true;
                    if (hxDid(did).toLowerCase().includes(search)) return true;
                    if ((bcmDidName(did) || '').toLowerCase().includes(search)) return true;
                    const fields = grouped.get(did) || [];
                    return fields.some((f) => (f.name || '').toLowerCase().includes(search));
                  })
                  .map((did) => (
                    <DidCard
                      key={did} did={did} category={category}
                      fields={grouped.get(did) || []}
                      slot={payloads[did]}
                      edits={edits[did] || {}}
                      busy={busy} search={search}
                      onReadOne={() => onReadOne(did)}
                      onWriteOne={() => onWriteOne(did)}
                      onResetEdits={() => onResetEdits(did)}
                      onEdit={(name, v) => onEdit(did, name, v)}
                    />
                  ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
});

function PerfStat({ value, label, accent }) {
  return (
    <div style={{ lineHeight: 1 }}>
      <div style={{
        fontSize: 32, fontWeight: 900, color: accent, letterSpacing: -1,
        fontFamily: 'JetBrains Mono, monospace',
        textShadow: `0 0 12px ${accent}55`,
      }}>{value}</div>
      <div style={{ fontSize: 9, fontWeight: 900, letterSpacing: 2, color: T.textLow, marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

function PerfSubPanel({ group, rows, edits, busy, onEdit }) {
  const [open, setOpen] = useState(true);
  const pendingInPanel = rows.filter((r) =>
    Object.prototype.hasOwnProperty.call(edits, r.field?.name)
  ).length;

  return (
    <div style={{
      borderRadius: 14, overflow: 'hidden',
      background: T.card,
      border: `1px solid ${pendingInPanel > 0 ? group.accent + 'AA' : T.border}`,
      boxShadow: `0 6px 22px rgba(0,0,0,0.35)`,
    }}>
      {/* mini hero */}
      <div
        role="button" tabIndex={0}
        aria-expanded={open}
        aria-label={`${group.label} sub-panel — ${open ? 'collapse' : 'expand'}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        style={{
          position: 'relative', height: 110, cursor: 'pointer',
          background: group.image
            ? `url(${group.image}) center/cover no-repeat`
            : `linear-gradient(135deg, ${group.accent}33, transparent)`,
        }}
      >
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(90deg, rgba(10,10,10,0.92) 0%, rgba(10,10,10,0.55) 60%, rgba(10,10,10,0.15) 100%)`,
        }} />
        <div style={{
          position: 'absolute', top: 0, left: 0, height: 2, right: 0,
          background: `linear-gradient(90deg, ${group.accent}, transparent)`,
          boxShadow: `0 0 8px ${group.accent}88`,
        }} />
        <div style={{
          position: 'absolute', inset: 0, padding: '12px 16px',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              padding: '3px 8px', borderRadius: 5,
              background: group.accent, color: '#0A0A0A',
              fontSize: 9, fontWeight: 900, letterSpacing: 1.3,
            }}>{group.glyph} {group.label}</span>
            {pendingInPanel > 0 && (
              <span style={{
                padding: '2px 7px', borderRadius: 5,
                background: T.amber + '33', color: T.amber,
                fontSize: 9, fontWeight: 900, letterSpacing: 1,
              }}>● {pendingInPanel}</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: T.textMid, fontWeight: 800 }}>
              {open ? '▴' : '▾'} {rows.length}
            </span>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, color: group.accent, letterSpacing: 1.2 }}>
              {group.tag}
            </div>
            <div style={{ fontSize: 11, color: T.textMid, marginTop: 4, lineHeight: 1.4, maxWidth: 460 }}>
              {group.blurb}
            </div>
          </div>
        </div>
      </div>

      {open && (
        <div style={{
          padding: 12, display: 'grid', gap: 8,
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        }}>
          {rows.length === 0 && (
            <div style={{ color: T.textLow, fontSize: 11, fontStyle: 'italic', padding: 6 }}>
              No fields match the current search.
            </div>
          )}
          {rows.map((row, i) => {
            const f = row.field;
            const editVal = Object.prototype.hasOwnProperty.call(edits, f.name) ? edits[f.name] : null;
            const effective = editVal != null ? editVal : (row.raw ?? 0);
            const changed = editVal != null && editVal !== row.raw;
            return (
              <FieldRow
                key={i}
                field={f} value={effective}
                raw={row.raw} label={row.label}
                changed={changed}
                accent={group.accent}
                onChange={(v) => onEdit(f.name, v)}
                disabled={busy}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────── DID card ───────── */

function DidCard({ did, category, fields, slot, edits, busy, search, onReadOne, onWriteOne, onResetEdits, onEdit }) {
  const [open, setOpen] = useState(false);
  const decoded = useMemo(() => {
    if (!slot || !slot.ok) return null;
    try { return decodeBcmDid(did, slot.payload); } catch { return null; }
  }, [slot, did]);
  const pendingCount = Object.keys(edits).length;
  const visibleRows = useMemo(() => {
    if (!decoded) return null;
    if (!search) return decoded;
    return decoded.filter((row) => (row.field?.name || '').toLowerCase().includes(search));
  }, [decoded, search]);

  return (
    <div style={{
      background: T.card, borderRadius: 12,
      border: `1px solid ${pendingCount > 0 ? T.amber + 'AA' : T.border}`,
      overflow: 'hidden', transition: 'all 0.18s',
    }}>
      <div
        role="button" tabIndex={0}
        aria-expanded={open}
        aria-label={`${hxDid(did)} ${bcmDidName(did)} — ${open ? 'collapse' : 'expand'}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', cursor: 'pointer',
        }}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <div style={{
          width: 40, height: 40, borderRadius: 8,
          background: category.accent + '22', color: category.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 900, flexShrink: 0,
        }}>{open ? '▾' : '▸'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: T.text, letterSpacing: 0.3 }}>
            <span style={{ color: category.accent, fontFamily: 'JetBrains Mono, monospace', marginRight: 8 }}>
              {hxDid(did)}
            </span>
            {bcmDidName(did)}
          </div>
          <div style={{ fontSize: 10, color: T.textLow, marginTop: 2, fontWeight: 700, letterSpacing: 0.6 }}>
            {fields.length} FIELDS · {didPayloadByteLength(did)} B
            {slot?.ok ? <span style={{ color: T.green }}> · ✓ READ</span> :
              slot ? <span style={{ color: T.red }}> · {slot.error || 'NOT READ'}</span> :
              <span> · NOT READ</span>}
            {pendingCount > 0 && (
              <span style={{ color: T.amber, marginLeft: 8 }}>
                ● {pendingCount} PENDING
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <Btn onClick={onReadOne} disabled={busy} ghost accent={category.accent} size="sm">📖 READ</Btn>
          <Btn onClick={onWriteOne} disabled={busy || pendingCount === 0 || !slot?.ok} accent={category.accent} size="sm">💾 WRITE</Btn>
          {pendingCount > 0 && (
            <Btn onClick={onResetEdits} disabled={busy} ghost accent={T.textMid} size="sm">✕ REVERT</Btn>
          )}
        </div>
      </div>

      {open && (
        <div style={{
          padding: '0 14px 14px',
          borderTop: `1px solid ${T.border}`,
        }}>
          {slot?.ok && (
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: T.textLow, padding: '10px 0', wordBreak: 'break-all',
            }}>
              <span style={{ color: T.textMid, fontWeight: 700, letterSpacing: 1 }}>PAYLOAD:</span>{' '}
              {bytesToHex(slot.payload)}
            </div>
          )}
          {!slot && (
            <div style={{ padding: '14px 0', color: T.textMid, fontSize: 12, fontStyle: 'italic' }}>
              Click READ to pull this DID, or use READ ALL / SYNTHETIC DUMP in the toolbar.
            </div>
          )}
          {slot && !slot.ok && (
            <div style={{ padding: '10px 0', color: T.red, fontSize: 12, fontWeight: 800 }}>
              ✗ {slot.error}
            </div>
          )}
          {visibleRows && visibleRows.length === 0 && (
            <div style={{ padding: '10px 0', color: T.textLow, fontSize: 11, fontStyle: 'italic' }}>
              No fields match the current search.
            </div>
          )}
          {visibleRows && visibleRows.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 8 }}>
              {visibleRows.map((row, i) => {
                const f = row.field;
                const editVal = Object.prototype.hasOwnProperty.call(edits, f.name) ? edits[f.name] : null;
                const effective = editVal != null ? editVal : (row.raw ?? 0);
                const changed = editVal != null && editVal !== row.raw;
                return (
                  <FieldRow
                    key={i}
                    field={f} value={effective}
                    raw={row.raw} label={row.label}
                    changed={changed}
                    accent={category.accent}
                    onChange={(v) => onEdit(f.name, v)}
                    disabled={busy}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── field row ───────── */

function FieldRow({ field, value, raw, label, changed, accent, onChange, disabled }) {
  const hasOptions = field.options && field.options.length > 0;
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 10,
      background: changed ? '#FFB30015' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${changed ? T.amber + '88' : T.border}`,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 8, gap: 8,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: T.text, lineHeight: 1.3 }}>
          {field.name}
        </div>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
          color: T.textLow, whiteSpace: 'nowrap', fontWeight: 700,
        }}>
          bit {field.bit}/{field.length}
        </div>
      </div>
      <FieldControl
        field={field} value={value} accent={accent}
        onChange={onChange} disabled={disabled}
      />
      {changed && (
        <div style={{ fontSize: 10, color: T.amber, fontWeight: 800, marginTop: 6, letterSpacing: 0.5 }}>
          ● PENDING — was {label} ({raw})
        </div>
      )}
    </div>
  );
}

function FieldControl({ field, value, accent, onChange, disabled }) {
  const hasOptions = field.options && field.options.length > 0;

  if (field.length === 1 && !hasOptions) {
    return (
      <Pill
        on={!!value} label={value ? 'Enabled' : 'Disabled'}
        onToggle={(v) => onChange(v ? 1 : 0)} disabled={disabled} accent={accent}
      />
    );
  }

  // 1-bit boolean with explicit options — show two pills
  if (field.length === 1 && hasOptions && field.options.length === 2) {
    const off = field.options.find((o) => o.value === 0) || field.options[0];
    const on = field.options.find((o) => o.value === 1) || field.options[1];
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Pill on={value === off.value} label={off.label} onToggle={() => onChange(off.value)} disabled={disabled} accent="#9E9E9E" />
        <Pill on={value === on.value} label={on.label} onToggle={() => onChange(on.value)} disabled={disabled} accent={accent} />
      </div>
    );
  }

  if (hasOptions) {
    const present = field.options.some((o) => o.value === value);
    return (
      <select
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        disabled={disabled}
        style={{
          width: '100%', padding: '8px 10px', borderRadius: 8,
          background: 'rgba(255,255,255,0.05)', color: T.text,
          border: `1px solid ${T.border}`,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700,
        }}
      >
        {!present && <option value={value} style={{ background: T.bg, color: T.amber }}>{`${value} — raw, not in catalog`}</option>}
        {field.options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: T.bg, color: T.text }}>
            {o.value} — {o.label}
          </option>
        ))}
      </select>
    );
  }

  // free integer
  const max = field.length >= 31 ? 0xFFFFFFFF : ((1 << field.length) - 1);
  return (
    <input
      type="number" min={0} max={max} value={value}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= 0 && n <= max) onChange(n);
      }}
      disabled={disabled}
      style={{
        width: '100%', padding: '8px 10px', borderRadius: 8,
        background: 'rgba(255,255,255,0.05)', color: T.text,
        border: `1px solid ${T.border}`,
        fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700,
      }}
    />
  );
}
