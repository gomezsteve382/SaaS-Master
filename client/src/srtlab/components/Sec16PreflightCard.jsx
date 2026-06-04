import React, {useContext, useMemo, useState} from 'react';
import {Card} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {MasterVinContext} from '../lib/masterVinContext.jsx';
import {crossValidate} from '../lib/crossValidate.js';
import {evaluateSec16Preflight} from '../lib/sec16Preflight.js';

/* ============================================================================
 * Sec16PreflightCard — Task #678
 *
 * Compact GO / NO-GO / SYNC-REQUIRED / LIVE-ONLY / INSUFFICIENT-DATA card
 * that the RFHUB tab renders above its key-programming controls. Pulls
 * loaded BCM / RFHUB / GPEC2A / 95640 / XC2268 dumps out of the master
 * VIN context, runs crossValidate + sec16Preflight, and exposes a
 * `bench-override` checkbox so an operator can deliberately bypass the
 * gate on a real bench when they know what they are doing.
 *
 * Calls back to the parent with `(verdict, benchOverride)` whenever
 * either changes so the parent can disable Program New Key until either
 * verdict.canProgramKey OR benchOverride is true.
 *
 * Pure UI + the two pure libs — no fetch, no localStorage, no side
 * effects beyond the bench-override toggle.
 * ========================================================================== */

const STATUS_META = {
  GO:                { color: C.gn, label: 'GO',                 emoji: '✓',  bg: '#E8F5E9' },
  SYNC_REQUIRED:     { color: C.wn, label: 'SYNC REQUIRED',      emoji: '!',  bg: '#FFF8E1' },
  NO_GO:             { color: C.er, label: 'NO-GO',              emoji: '✗',  bg: '#FFEBEE' },
  LIVE_ONLY:         { color: C.a2, label: 'LIVE-ONLY PLATFORM', emoji: '⚡', bg: '#E3F2FD' },
  INSUFFICIENT_DATA: { color: C.tm, label: 'INSUFFICIENT DATA',  emoji: '?',  bg: '#F8F6F2' },
};

export default function Sec16PreflightCard({ onChange }) {
  const { vin, loadedDumps } = useContext(MasterVinContext);
  const [benchOverride, setBenchOverride] = useState(false);

  const modules = useMemo(
    () => (loadedDumps || []).map(d => d.mod).filter(Boolean),
    [loadedDumps],
  );

  const verdict = useMemo(() => {
    const xv = crossValidate(modules);
    return evaluateSec16Preflight({ vin, modules, crossValidate: xv });
  }, [vin, modules]);

  /* Push verdict + override up so the parent can gate buttons. */
  React.useEffect(() => {
    if (typeof onChange === 'function') onChange(verdict, benchOverride);
  }, [verdict, benchOverride, onChange]);

  const meta = STATUS_META[verdict.status] || STATUS_META.INSUFFICIENT_DATA;

  return (
    <Card style={{ marginBottom: 14, border: '2px solid ' + meta.color, background: meta.bg }}
          data-testid="sec16-preflight-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, letterSpacing: 2 }}>
          🛡️ SEC16 PRE-FLIGHT
        </div>
        <div style={{
          fontSize: 11, fontWeight: 800, padding: '4px 10px', background: meta.color,
          color: '#fff', borderRadius: 6, letterSpacing: 1,
        }} data-testid="sec16-preflight-status">
          {meta.emoji} {meta.label}
        </div>
      </div>

      <div style={{ fontSize: 12, color: C.t, marginBottom: 10 }}>
        <b>{verdict.classification.label}</b>
        {verdict.classification.vinSeen && (
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tm, marginLeft: 8 }}>
            VIN {verdict.classification.vinSeen}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: C.t, marginBottom: 10, lineHeight: 1.5 }}>
        {verdict.summary}
      </div>

      {verdict.classification.notes && verdict.classification.notes.length > 0 && (
        <ul style={{ margin: '0 0 10px 0', paddingLeft: 18, fontSize: 11, color: C.ts }}>
          {verdict.classification.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}

      {verdict.blockers.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.er, letterSpacing: 1, marginBottom: 4 }}>
            BLOCKERS ({verdict.blockers.length})
          </div>
          {verdict.blockers.map((b, i) => (
            <div key={i} data-testid="sec16-blocker"
                 style={{ fontSize: 11, padding: 6, marginBottom: 4, background: '#fff', borderLeft: '3px solid '+C.er, borderRadius: 4 }}>
              <div>{b.message}</div>
              {b.action && (
                <div style={{ fontSize: 10, color: C.gn, marginTop: 2 }}>
                  ↳ remedy: <b>{b.action.label}</b> (target: {b.action.target})
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {verdict.warnings.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.wn, letterSpacing: 1, marginBottom: 4 }}>
            WARNINGS ({verdict.warnings.length})
          </div>
          {verdict.warnings.map((w, i) => (
            <div key={i} data-testid="sec16-warning"
                 style={{ fontSize: 11, padding: 6, marginBottom: 4, background: '#fff', borderLeft: '3px solid '+C.wn, borderRadius: 4 }}>
              {w.message}
            </div>
          ))}
        </div>
      )}

      {verdict.missingModules.length > 0 && (
        <div style={{ fontSize: 11, color: C.tm, marginBottom: 10 }}>
          Missing dumps: <b>{verdict.missingModules.join(', ')}</b>
        </div>
      )}

      {(verdict.status === 'SYNC_REQUIRED' || verdict.status === 'NO_GO' || verdict.status === 'LIVE_ONLY') && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: '#fff', borderRadius: 6, border: '1px dashed '+C.bd, cursor: 'pointer' }}
               data-testid="sec16-bench-override-label">
          <input type="checkbox" checked={benchOverride}
                 onChange={e => setBenchOverride(e.target.checked)}
                 data-testid="sec16-bench-override" />
          <span style={{ fontSize: 11, color: C.t }}>
            <b>Bench override</b> — I am on a real bench and accept the risk of programming without a clean pre-flight.
          </span>
        </label>
      )}
    </Card>
  );
}
