import React, { useCallback, useContext, useEffect, useState } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { MasterVinContext } from '../lib/masterVinContext.jsx';

/* ============================================================================
 * Sec16SyncHistoryCard — Task #685
 *
 * Surfaces the audit trail recorded by `POST /api/sec16-sync-events`
 * (Task #678). Techs working a job can now see "last sync 12m ago by JD"
 * directly inside SRT Lab instead of squinting at the api-server log.
 *
 * Two view modes — toggled by the "All VINs / This VIN" switch at the
 * top of the card — share the same render path. When `vinValid` is true
 * the default is "This VIN" (filtered server-side via ?vin=…); otherwise
 * the card falls back to "All VINs". A manual refresh button re-fetches.
 *
 * Strictly read-only: no buttons that touch a real ECU.
 * ========================================================================== */

const VERIFIED_META = {
  match:        { color: C.gn, label: 'MATCH' },
  mismatch:     { color: C.er, label: 'MISMATCH' },
  unverified:   { color: C.wn, label: 'UNVERIFIED' },
  offline:      { color: C.tm, label: 'OFFLINE' },
  'read-error': { color: C.er, label: 'READ ERROR' },
};

/* Pure, deterministic relative-time formatter — exported so the unit
   test can lock the wording without mocking `Date.now()`. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 5)         return 'just now';
  if (diffSec < 60)        return diffSec + 's ago';
  const m = Math.floor(diffSec / 60);
  if (m < 60)              return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)              return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30)              return d + 'd ago';
  const mo = Math.floor(d / 30);
  if (mo < 12)             return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}

function absTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

export default function Sec16SyncHistoryCard() {
  const { vin, vinValid } = useContext(MasterVinContext);
  const [filterToVin, setFilterToVin] = useState(true);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(0);

  const effectiveFilter = vinValid && filterToVin;

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (typeof fetch !== 'function') throw new Error('fetch unavailable');
      const url = effectiveFilter
        ? '/api/sec16-sync-events?vin=' + encodeURIComponent(vin)
        : '/api/sec16-sync-events';
      const res = await fetch(url, { method: 'GET' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'null'));
      const json = await res.json();
      setEvents(Array.isArray(json?.events) ? json.events : []);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(String((e && e.message) || e));
      setEvents([]);
    } finally {
      setBusy(false);
    }
  }, [effectiveFilter, vin]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <Card data-testid="sec16-sync-history-card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: C.a2, fontWeight: 800, letterSpacing: 2 }}>
          🛡️ SEC16 SYNC HISTORY
        </div>
        <span style={{ fontSize: 10, color: C.tm, border: `1px solid ${C.bd}`,
                       borderRadius: 6, padding: '2px 8px' }}>
          {events.length} event{events.length === 1 ? '' : 's'}
          {effectiveFilter ? ` · VIN ${vin}` : ' · all VINs'}
        </span>
        <div style={{ flex: 1 }} />
        {vinValid && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                          color: C.ts, cursor: 'pointer' }}
                 data-testid="sec16-history-filter-label">
            <input type="checkbox" checked={filterToVin}
                   onChange={e => setFilterToVin(e.target.checked)}
                   data-testid="sec16-history-filter-toggle" />
            Filter to current VIN
          </label>
        )}
        <Btn color={C.a3} outline onClick={refresh} disabled={busy}
             data-testid="sec16-history-refresh">
          {busy ? '…' : '↻ REFRESH'}
        </Btn>
      </div>

      {error && (
        <div data-testid="sec16-history-error"
             style={{ marginBottom: 10, padding: '8px 12px', background: C.er + '12',
                      border: `1px solid ${C.er}33`, borderRadius: 8, color: C.er, fontSize: 12 }}>
          Couldn't load sync history: {error}
        </div>
      )}

      {!error && events.length === 0 && (
        <div data-testid="sec16-history-empty" style={{ fontSize: 12, color: C.tm }}>
          {busy
            ? 'Loading sync history…'
            : effectiveFilter
              ? `No SEC16 sync events recorded for ${vin} yet.`
              : 'No SEC16 sync events recorded yet. They appear here the moment the writer posts one.'}
        </div>
      )}

      {events.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {events.map(ev => {
            const meta = VERIFIED_META[ev.verified] || { color: C.tm, label: String(ev.verified || '?').toUpperCase() };
            return (
              <div key={ev.id} data-testid="sec16-history-row"
                   style={{ display: 'grid',
                            gridTemplateColumns: '90px 90px 1fr 1fr 110px 110px',
                            gap: 10, alignItems: 'center', padding: '8px 12px',
                            border: `1px solid ${meta.color}33`, borderRadius: 10,
                            background: meta.color + '08' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#fff',
                               background: meta.color, padding: '3px 8px',
                               borderRadius: 6, letterSpacing: .5, textAlign: 'center' }}
                      data-testid="sec16-history-verified">
                  {meta.label}
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: C.tx, letterSpacing: .5 }}
                      data-testid="sec16-history-target">
                  {ev.target}
                </span>
                <span style={{ fontSize: 11, color: C.tx, fontFamily: "'JetBrains Mono'" }}
                      data-testid="sec16-history-action">
                  {ev.actionId}
                </span>
                <span style={{ fontSize: 11, color: C.ts }}
                      data-testid="sec16-history-operator">
                  {ev.operator || <em style={{ color: C.tm }}>no operator</em>}
                </span>
                <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'" }}
                      data-testid="sec16-history-vin">
                  {ev.vin || '—'}
                </span>
                <span title={absTime(ev.createdAt)} data-testid="sec16-history-time"
                      style={{ fontSize: 11, color: C.ts, textAlign: 'right' }}>
                  {relativeTime(ev.createdAt, loadedAt || Date.now())}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
