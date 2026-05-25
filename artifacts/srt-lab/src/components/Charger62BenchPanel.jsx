/* ============================================================================
 * Charger62BenchPanel.jsx — 6.2 Charger bench-set cross-check report
 * (Task #769). Rendered inside KeyProgTab; not a new tab.
 *
 * Displays:
 *   1. VIN matrix — all slots across all 4 modules
 *   2. Security-byte matrix — BCM↔RFHUB SEC16, SEC6, GPEC2A pairing
 *   3. Key material — SKIM secret, PIN, FOBIK counts
 *   4. Cross-check verdict (PASS or BLOCKED)
 *   5. "Stage virgin-key payload" button → runKeyProgPatch → ZIP download
 * ============================================================================ */
import React, { useState, useCallback } from 'react';
import { zipSync } from 'fflate';
import { C } from '../lib/constants.js';
import { Card, Tag } from '../lib/ui.jsx';
import { parseModule } from '../lib/parseModule.js';
import { runKeyProgPatch, sha256Hex } from '../lib/keyProgWizard.js';
import {
  CHARGER62_BENCH_FILES,
  loadCharger62BenchSet,
  buildCharger62Report,
} from '../lib/charger62BenchReport.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────────*/
const VERDICT_COLOR = {
  PASS: C.gn, REVIN: C.a3, DONOR: C.wn, MISMATCH: C.er, BLANK: C.tm,
  MISSING: C.tm, BLOCKED: C.er, DERIVED: C.a2, READ: C.ts,
  'CS ERR': C.er, 'LIVE_ONLY': C.a4,
  'BOTH BLANK': C.tm, 'ONE BLANK': C.wn, 'BCM SEC16 BLANK': C.wn,
  'RFHUB SEC16 BLANK': C.wn, 'PCM SEC6 MISSING/BLANK': C.wn,
};

function VTag({ v, children }) {
  const color = VERDICT_COLOR[v] || C.tm;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 6,
      background: color + '18', border: '1px solid ' + color + '60',
      color, fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
    }}>
      {children || v}
    </span>
  );
}

function Mono({ children, dim }) {
  return (
    <span style={{
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
      color: dim ? C.tm : C.tx, wordBreak: 'break-all',
    }}>
      {children}
    </span>
  );
}

function SectionHead({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 900, letterSpacing: 2, color: C.ts,
      textTransform: 'uppercase', marginTop: 18, marginBottom: 6,
      borderBottom: '1px solid ' + C.bd, paddingBottom: 4,
    }}>
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * VIN Matrix Table
 * ────────────────────────────────────────────────────────────────────────────*/
function VinMatrixTable({ rows }) {
  if (!rows || rows.length === 0) return <div style={{ fontSize: 11, color: C.tm }}>No VIN rows</div>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: C.c2 }}>
            {['Module', 'Offset', 'VIN', 'CRC', 'Verdict'].map((h) => (
              <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              style={{ borderBottom: '1px solid ' + C.bd, background: i % 2 === 0 ? 'transparent' : C.c2 + '50' }}>
              <td style={{ padding: '4px 10px', fontWeight: 700, color: C.tx }}>{r.module}</td>
              <td style={{ padding: '4px 10px' }}><Mono dim>{r.offsetHex}</Mono></td>
              <td style={{ padding: '4px 10px' }}>
                <Mono>{r.vin || '—'}</Mono>
                {r.note && <span style={{ fontSize: 9, color: C.ts, marginLeft: 6 }}>({r.note})</span>}
              </td>
              <td style={{ padding: '4px 10px' }}>
                {r.crcOk === true ? <VTag v="PASS">CRC ✓</VTag>
                  : r.crcOk === false ? <VTag v="MISMATCH">CRC ✗</VTag>
                  : <span style={{ color: C.tm, fontSize: 10 }}>—</span>}
              </td>
              <td style={{ padding: '4px 10px' }}>
                <VTag v={r.verdict}>{r.verdict}</VTag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Security Matrix Table
 * ────────────────────────────────────────────────────────────────────────────*/
function SecMatrixTable({ rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: C.c2 }}>
            {['Field', 'Source', 'Offset', 'Value / Hex', 'Verdict'].map((h) => (
              <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid ' + C.bd, background: i % 2 === 0 ? 'transparent' : C.c2 + '50' }}>
              <td style={{ padding: '4px 10px', fontWeight: 700, color: C.tx, minWidth: 180 }}>{r.label}</td>
              <td style={{ padding: '4px 10px', color: C.ts, fontSize: 10 }}>{r.source}</td>
              <td style={{ padding: '4px 10px' }}><Mono dim>{r.offset || '—'}</Mono></td>
              <td style={{ padding: '4px 10px', maxWidth: 360 }}>
                <Mono>{r.value}</Mono>
                {r.note && (
                  <div style={{ fontSize: 9, color: C.ts, marginTop: 2 }}>{r.note}</div>
                )}
              </td>
              <td style={{ padding: '4px 10px' }}><VTag v={r.verdict}>{r.verdict}</VTag></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Key Material Block
 * ────────────────────────────────────────────────────────────────────────────*/
function KeyMaterialBlock({ km }) {
  if (!km) return null;
  const rows = [
    { label: 'SKIM Secret (SEC16)', value: km.skimSecret || '—', src: km.skimSecretSource, mono: true },
    { label: 'SEC6 (pairing)', value: km.sec6Hex || '—', src: km.sec6Source, mono: true },
    { label: 'PIN (5-digit)', value: km.pin || '—', src: km.pinSource, mono: true },
    { label: 'FOBIK slots (BCM)', value: km.fobikSlotsBcm !== null ? String(km.fobikSlotsBcm) : '—', src: km.fobikSlotsBcmSource, mono: false },
    { label: 'FOBIK slots (RFHUB EEE)', value: km.fobikSlotsRfh !== null ? String(km.fobikSlotsRfh) : '—', src: km.fobikSlotsRfhSource, mono: false },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ background: C.c2, borderRadius: 10, padding: '10px 14px', border: '1px solid ' + C.bd }}>
          <div style={{ fontSize: 9, fontWeight: 900, color: C.ts, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
            {r.label}
          </div>
          {r.mono
            ? <Mono>{r.value}</Mono>
            : <div style={{ fontSize: 13, fontWeight: 800, color: C.tx }}>{r.value}</div>}
          <div style={{ fontSize: 9, color: C.tm, marginTop: 4 }}>{r.src}</div>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Payload result card
 * ────────────────────────────────────────────────────────────────────────────*/
function PayloadResultCard({ payResult }) {
  if (!payResult) return null;
  return (
    <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 12, border: '1px solid ' + (payResult.ok ? C.gn + '60' : C.wn + '60'), background: (payResult.ok ? C.gn : C.wn) + '08' }}>
      <div style={{ fontWeight: 900, fontSize: 12, color: payResult.ok ? C.gn : C.wn, marginBottom: 6 }}>
        {payResult.ok ? '✓ Payload staged — all checks green' : '⚠ Payload staged with warnings'}
      </div>
      {payResult.checks && payResult.checks.map((ch, i) => (
        <div key={i} style={{ fontSize: 10, color: ch.pass ? C.gn : C.wn, marginBottom: 2, display: 'flex', gap: 8 }}>
          <span>{ch.pass ? '✓' : '⚠'}</span>
          <span style={{ fontWeight: 700 }}>{ch.label}</span>
          {ch.detail && <span style={{ color: C.tm }}>— {ch.detail}</span>}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main component
 * ────────────────────────────────────────────────────────────────────────────*/
export default function Charger62BenchPanel() {
  const [loadState, setLoadState] = useState('idle'); // idle | loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [report, setReport] = useState(null);
  const [modules, setModules] = useState(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payResult, setPayResult] = useState(null);
  const [expanded, setExpanded] = useState(false);

  /* ── Load bench set ── */
  const handleLoad = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    setReport(null);
    setPayResult(null);
    try {
      const files = await loadCharger62BenchSet();
      const bcmInfo = parseModule(files.bcmFile.data, files.bcmFile.name);
      const rfhEeeInfo = parseModule(files.rfhEeeFile.data, files.rfhEeeFile.name);
      const rfhPflashInfo = parseModule(files.rfhPflashFile.data, files.rfhPflashFile.name);
      const pcmInfo = parseModule(files.pcmFile.data, files.pcmFile.name);
      const r = buildCharger62Report({ bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo });
      setModules({ ...files, bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo });
      setReport(r);
      setLoadState('ready');
      setExpanded(true);
    } catch (err) {
      setLoadError(String(err?.message || err));
      setLoadState('error');
    }
  }, []);

  /* ── Stage virgin-key payload ── */
  const handleStagePayload = useCallback(async () => {
    if (!report || !modules) return;
    const vin = report.targetVin || report.donorVin;
    if (!vin || vin.length !== 17) return;
    setPayBusy(true);
    setPayResult(null);
    try {
      const patchResult = runKeyProgPatch({
        bcm: modules.bcmFile,
        rfh: modules.rfhEeeFile,
        pcm: modules.pcmFile,
        vin,
      });
      setPayResult(patchResult);

      if (patchResult.files && patchResult.files.length > 0) {
        const entries = {};
        const summaryLines = [`6.2 Charger Bench Set Payload — VIN ${vin}`, `Generated: ${new Date().toISOString()}`, ''];
        for (const f of patchResult.files) {
          const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
          entries[f.name] = bytes;
          // eslint-disable-next-line no-await-in-loop
          const hash = await sha256Hex(bytes);
          summaryLines.push(`${f.role}: ${f.name} (${bytes.length} B, SHA-256: ${hash})`);
        }
        if (patchResult.verifyText) {
          entries[`VERIFY_KEYPROG_${vin}.txt`] = new TextEncoder().encode(patchResult.verifyText);
        }
        summaryLines.push('', `Wizard checks: ${patchResult.checks?.filter((c) => c.pass).length || 0}/${patchResult.checks?.length || 0} passed`);
        entries[`SUMMARY_62CHARGER_${vin}.txt`] = new TextEncoder().encode(summaryLines.join('\n'));
        const zipped = zipSync(entries, { level: 6 });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
        a.download = `KEYPROG_62CHARGER_${vin}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
    } catch (err) {
      setPayResult({ ok: false, checks: [{ label: 'Patch threw error', pass: false, detail: String(err?.message || err) }], files: [] });
    } finally {
      setPayBusy(false);
    }
  }, [report, modules]);

  const canStage = report && report.blockingErrors.length === 0
    && (report.targetVin || report.donorVin)?.length === 17;

  /* ── Render ── */
  return (
    <Card style={{ marginBottom: 14 }}>
      {/* Header row */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '14px 18px' }}
        onClick={() => loadState === 'ready' && setExpanded((x) => !x)}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: C.sr, letterSpacing: 0.5 }}>
            6.2 Charger Bench Set Cross-Check
          </div>
          <div style={{ fontSize: 10, color: C.ts, marginTop: 2 }}>
            VIN matrix · SEC16 / SEC6 / GPEC2A · PIN derivation · virgin-key payload
          </div>
        </div>
        {loadState === 'idle' && (
          <button
            onClick={(e) => { e.stopPropagation(); handleLoad(); }}
            style={{
              padding: '8px 18px', borderRadius: 10, fontWeight: 800, fontSize: 11,
              background: C.sr, color: '#fff', border: 'none', cursor: 'pointer',
            }}>
            Load bench set
          </button>
        )}
        {loadState === 'loading' && (
          <Tag color={C.a3}>Loading…</Tag>
        )}
        {loadState === 'ready' && (
          <>
            {report.blockingErrors.length === 0
              ? <Tag color={C.gn}>CROSS-CHECK PASS</Tag>
              : <Tag color={C.er}>CROSS-CHECK BLOCKED</Tag>}
            <span style={{ fontSize: 12, color: C.ts }}>{expanded ? '▲' : '▼'}</span>
          </>
        )}
        {loadState === 'error' && (
          <>
            <Tag color={C.er}>Load Error</Tag>
            <button
              onClick={(e) => { e.stopPropagation(); handleLoad(); }}
              style={{ padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: 10, background: 'none', border: '1px solid ' + C.er, color: C.er, cursor: 'pointer' }}>
              Retry
            </button>
          </>
        )}
      </div>

      {loadState === 'error' && loadError && (
        <div style={{ padding: '0 18px 14px', fontSize: 11, color: C.er }}>{loadError}</div>
      )}

      {/* File descriptors (always show when loaded) */}
      {loadState === 'ready' && (
        <div style={{ padding: '0 18px', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          {CHARGER62_BENCH_FILES.map((f) => {
            const info = f.role === 'BCM' ? modules?.bcmInfo
              : f.role === 'RFHUB_EEE' ? modules?.rfhEeeInfo
              : f.role === 'RFHUB_PFLASH' ? modules?.rfhPflashInfo
              : modules?.pcmInfo;
            return (
              <div key={f.role} style={{ fontSize: 9, background: C.c2, borderRadius: 8, padding: '4px 10px', border: '1px solid ' + C.bd }}>
                <span style={{ fontWeight: 800, color: C.ts }}>{f.role}</span>
                <span style={{ color: C.tm, marginLeft: 6 }}>{f.expectedSize.toLocaleString()} B</span>
                {info && <span style={{ color: C.a3, marginLeft: 6 }}>{info.type}</span>}
              </div>
            );
          })}
        </div>
      )}

      {loadState === 'ready' && expanded && report && (
        <div style={{ padding: '0 18px 18px' }}>

          {/* VIN divergence callout */}
          {report.vinDivergent && (
            <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 10, background: C.a3 + '12', border: '1px solid ' + C.a3 + '50' }}>
              <span style={{ fontWeight: 800, fontSize: 11, color: C.a3 }}>
                BCM re-VIN notice
              </span>
              <span style={{ fontSize: 11, color: C.tx, marginLeft: 8 }}>
                BCM carries <strong>{report.targetVin}</strong> (new target VIN);
                other modules still on donor VIN <strong>{report.donorVin}</strong>.
              </span>
            </div>
          )}

          {/* Blocking errors */}
          {report.blockingErrors.length > 0 && (
            <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 10, background: C.er + '10', border: '1px solid ' + C.er + '50' }}>
              <div style={{ fontWeight: 900, fontSize: 11, color: C.er, marginBottom: 6 }}>
                CROSS-CHECK BLOCKED — payload step disabled
              </div>
              {report.blockingErrors.map((e, i) => (
                <div key={i} style={{ fontSize: 11, color: C.er, marginBottom: 2 }}>✗ {e}</div>
              ))}
            </div>
          )}

          {/* VIN Matrix */}
          <SectionHead>VIN Matrix — all modules</SectionHead>
          <VinMatrixTable rows={report.vinMatrix} />

          {/* Security Matrix */}
          <SectionHead>Security-Byte Matrix</SectionHead>
          <SecMatrixTable rows={report.securityMatrix} />

          {/* Key Material */}
          <SectionHead>Key Material</SectionHead>
          <KeyMaterialBlock km={report.keyMaterial} />

          {/* Module details */}
          <SectionHead>Module Parse Summary</SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {[
              { label: 'PCM (GPEC2A)', info: modules?.pcmInfo },
              { label: 'BCM D-Flash', info: modules?.bcmInfo },
              { label: 'RFHUB EEE', info: modules?.rfhEeeInfo },
              { label: 'RFHUB P-Flash', info: modules?.rfhPflashInfo },
            ].map(({ label, info }) => (
              <div key={label} style={{ background: C.c2, borderRadius: 10, padding: '10px 14px', border: '1px solid ' + C.bd, fontSize: 10 }}>
                <div style={{ fontWeight: 900, color: C.ts, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
                <div style={{ color: C.tx }}>Type: <strong>{info?.type || '—'}</strong></div>
                <div style={{ color: C.ts }}>Size: {info?.size?.toLocaleString() || '—'} B</div>
                <div style={{ color: C.ts }}>VINs found: {info?.vins?.length ?? '—'}</div>
                {info?.contentWarn && (
                  <div style={{ color: C.wn, marginTop: 4 }}>⚠ {info.contentWarn.kind}</div>
                )}
                {info?.type === 'XC2268_RFHUB' && info?.xc2268 && (
                  <div style={{ color: C.a4, marginTop: 2 }}>
                    {info.xc2268.ok ? `XC2268 variant: ${info.xc2268.variantLabel || info.xc2268.variantByte}` : `XC2268: ${info.xc2268.reason}`}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Stage payload button */}
          <SectionHead>Virgin-Key Payload</SectionHead>
          <div style={{ marginTop: 8 }}>
            {!canStage ? (
              <div style={{ fontSize: 11, color: C.er, padding: '8px 12px', background: C.er + '0A', borderRadius: 8, border: '1px solid ' + C.er + '40' }}>
                Payload staging blocked — resolve all cross-check errors above first.
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
                  Target VIN: <Mono>{report.targetVin || report.donorVin}</Mono> ·
                  Inputs: BCM (64 KB) + RFHUB EEE (4 KB) + PCM (4 KB)
                </div>
                <button
                  onClick={handleStagePayload}
                  disabled={payBusy}
                  style={{
                    padding: '10px 22px', borderRadius: 10, fontWeight: 800, fontSize: 12,
                    background: payBusy ? C.tm : C.sr, color: '#fff', border: 'none',
                    cursor: payBusy ? 'not-allowed' : 'pointer',
                  }}>
                  {payBusy ? 'Staging…' : `Stage payload → KEYPROG_62CHARGER_${report.targetVin || report.donorVin}.zip`}
                </button>
              </div>
            )}
            <PayloadResultCard payResult={payResult} />
          </div>

        </div>
      )}
    </Card>
  );
}
