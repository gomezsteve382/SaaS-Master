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
import { runKeyProgPatch, runRfhBcmSync, sha256Hex } from '../lib/keyProgWizard.js';
import {
  CHARGER62_BENCH_FILES,
  loadCharger62BenchSet,
  buildCharger62Report,
} from '../lib/charger62BenchReport.js';
import { extractRfhPflashIdentity } from '../lib/rfhPflashIdentity.js';
import IdentityCard from './IdentityCard.jsx';

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
                {r.crcOk === true ? <VTag v="PASS">CRC OK</VTag>
                  : r.crcOk === false ? <VTag v="MISMATCH">CRC FAIL</VTag>
                  : <span style={{ color: C.tm, fontSize: 10 }}>—</span>}
                {r.role === 'RFHUB_EEE' && r.magicKnown === false && (
                  <div
                    data-testid="rfh-magic-warning"
                    title={`Derived Gen2 VIN magic 0x${(r.magic ?? 0).toString(16).toUpperCase().padStart(2, '0')} is not a canonical value (0xDB or 0x87). FCA SINCRO will reject this slot.`}
                    style={{ marginTop: 3, fontSize: 9, fontWeight: 700, color: '#B26A00', letterSpacing: 0.3 }}>
                    ⚠ SINCRO: Checksum ERROR (off-spec magic 0x{(r.magic ?? 0).toString(16).toUpperCase().padStart(2, '0')})
                  </div>
                )}
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
  const rfhPatched = payResult.rfhSec16Status && payResult.rfhSec16Status.startsWith('PATCHED');
  const rfhFailed = payResult.rfhSec16Status
    && (payResult.rfhSec16Status.startsWith('WRITE_FAILED') || payResult.rfhSec16Status.startsWith('WRITE_SKIPPED'));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ padding: '12px 16px', borderRadius: 12, border: '1px solid ' + (payResult.ok ? C.gn + '60' : C.wn + '60'), background: (payResult.ok ? C.gn : C.wn) + '08' }}>
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
      {rfhPatched && (
        <div
          data-testid="rfh-sec16-patched-banner"
          style={{
            marginTop: 8, padding: '10px 14px', borderRadius: 10,
            background: '#FF8F0012', border: '1px solid #FF8F0060',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>🔧</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 11, color: '#E65100', marginBottom: 2 }}>
              RFHUB SEC16 auto-corrected
            </div>
            <div style={{ fontSize: 11, color: '#BF360C' }}>
              Old:&nbsp;<span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{payResult.rfhSec16BeforeHex || 'unset'}</span>
              &nbsp;→ New:&nbsp;<span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700 }}>{payResult.rfhSec16AfterHex || '—'}</span>
            </div>
          </div>
        </div>
      )}
      {rfhFailed && (
        <div
          data-testid="rfh-sec16-failed-banner"
          style={{
            marginTop: 8, padding: '10px 14px', borderRadius: 10,
            background: '#D32F2F0A', border: '1px solid #D32F2F50',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>⚠</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 11, color: '#D32F2F', marginBottom: 2 }}>
              RFHUB SEC16 write not completed
            </div>
            <div style={{ fontSize: 11, color: '#C62828' }}>
              {payResult.rfhSec16Status}
            </div>
            <div style={{ fontSize: 11, color: '#C62828', marginTop: 4 }}>
              Use <strong>ModuleSync → BCM→RFH</strong> to sync the RFHUB SEC16 manually.
            </div>
          </div>
        </div>
      )}
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
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
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
      const pflashIdentity = extractRfhPflashIdentity(files.rfhPflashFile.data);
      setModules({ ...files, bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo, pflashIdentity });
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

  /* ── SEC16 sync (RFH ⇄ BCM) ── */
  const canSync = report && report.blockingErrors.length === 0 && !!modules;

  const handleSync = useCallback((direction) => {
    if (!modules) return;
    setSyncBusy(true);
    setSyncResult(null);
    try {
      const result = runRfhBcmSync({
        bcm: modules.bcmFile,
        rfh: modules.rfhEeeFile,
        direction,
      });
      setSyncResult(result);
      if (result.ok && result.files?.[0]) {
        const f = result.files[0];
        const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
    } catch (err) {
      setSyncResult({ ok: false, direction, checks: [{ label: 'sync threw', pass: false, detail: String(err?.message || err) }], files: [] });
    } finally {
      setSyncBusy(false);
    }
  }, [modules]);

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

          {/* P-Flash identity (best pick) — Task #772 */}
          {modules?.pflashIdentity && (
            <>
              <SectionHead>RFHUB P-Flash Identity (best pick)</SectionHead>
              <IdentityCard identity={modules.pflashIdentity} title={null} />
            </>
          )}

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

          {/* SEC16 sync (RFH ⇄ BCM) */}
          <SectionHead>SEC16 Sync — RFH ⇄ BCM</SectionHead>
          {(() => {
            const bcmSec16Hex = modules?.bcmInfo?.bcmSec16?.bytes && !modules.bcmInfo.bcmSec16.blank
              ? Array.from(modules.bcmInfo.bcmSec16.bytes).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
              : null;
            const rfhSlot1 = modules?.rfhEeeInfo?.sec16s?.[0];
            const rfhSec16Hex = rfhSlot1 && !rfhSlot1.blank
              ? Array.from(rfhSlot1.raw).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
              : null;
            const inSync = report.bcmRfhMatch === true;
            const mismatch = report.bcmRfhMatch === false;
            const badgeColor = inSync ? C.gn : mismatch ? C.wn : C.tm;
            const badgeLabel = inSync
              ? '✓ Already paired — RFH and BCM SEC16 already in sync'
              : mismatch
                ? '⚠ Mismatch — RFH and BCM SEC16 differ; pick a direction below'
                : '— Pairing state unknown (one side blank or missing)';
            const btnBg = syncBusy ? C.tm : (inSync ? 'transparent' : C.a3);
            const btnColor = syncBusy ? '#fff' : (inSync ? C.a3 : '#fff');
            const btnBorder = inSync ? '1px solid ' + C.a3 + '80' : 'none';
            return (
              <div style={{ marginTop: 8 }}>
                <div
                  data-testid="sec16-pairing-badge"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px', borderRadius: 8, marginBottom: 10,
                    background: badgeColor + '12',
                    border: '1px solid ' + badgeColor + '60',
                    fontSize: 11, fontWeight: 800, color: badgeColor,
                  }}>
                  {badgeLabel}
                </div>
                {(bcmSec16Hex || rfhSec16Hex) && (
                  <div
                    data-testid="sec16-hex-preview"
                    style={{
                      background: C.c2, borderRadius: 8, padding: '8px 12px',
                      border: '1px solid ' + C.bd, marginBottom: 10,
                      display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4,
                    }}>
                    <span style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1 }}>RFH SEC16</span>
                    <Mono>{rfhSec16Hex || '(blank/missing)'}</Mono>
                    <span style={{ fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1 }}>BCM SEC16 BE</span>
                    <Mono>{bcmSec16Hex || '(blank/missing)'}</Mono>
                  </div>
                )}
                {!canSync ? (
                  <div style={{ fontSize: 11, color: C.er, padding: '8px 12px', background: C.er + '0A', borderRadius: 8, border: '1px solid ' + C.er + '40' }}>
                    SEC16 sync blocked — resolve all cross-check errors above first.
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
                      {inSync
                        ? 'No change needed — running a sync will re-emit an identical-payload binary.'
                        : 'Push one module\u2019s SEC16 into the other and re-emit the patched binary (split records, mirror CRC16/CCITT, flat 0x40C9 LE, RFH slot 1/2 CS — all recomputed). Round-trip parses are asserted before download.'}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        onClick={() => handleSync('RFH_TO_BCM')}
                        disabled={syncBusy}
                        title={inSync ? 'No change needed — already in sync' : undefined}
                        style={{
                          padding: '10px 22px', borderRadius: 10, fontWeight: 800, fontSize: 12,
                          background: btnBg, color: btnColor, border: btnBorder,
                          cursor: syncBusy ? 'not-allowed' : 'pointer',
                        }}>
                        {syncBusy ? 'Syncing…' : 'RFH → BCM'}
                      </button>
                      <button
                        onClick={() => handleSync('BCM_TO_RFH')}
                        disabled={syncBusy}
                        title={inSync ? 'No change needed — already in sync' : undefined}
                        style={{
                          padding: '10px 22px', borderRadius: 10, fontWeight: 800, fontSize: 12,
                          background: btnBg, color: btnColor, border: btnBorder,
                          cursor: syncBusy ? 'not-allowed' : 'pointer',
                        }}>
                        {syncBusy ? 'Syncing…' : 'BCM → RFH'}
                      </button>
                      {inSync && (
                        <span style={{ fontSize: 10, color: C.tm, fontStyle: 'italic' }}>
                          no change needed
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {syncResult && (
                  <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 12, border: '1px solid ' + (syncResult.ok ? C.gn + '60' : C.er + '60'), background: (syncResult.ok ? C.gn : C.er) + '08' }}>
                    <div style={{ fontWeight: 900, fontSize: 12, color: syncResult.ok ? C.gn : C.er, marginBottom: 6 }}>
                      {syncResult.ok
                        ? `✓ ${syncResult.direction === 'RFH_TO_BCM' ? 'BCM' : 'RFH'} patched and downloaded`
                        : '✗ Sync failed'}
                    </div>
                    {syncResult.ok && (syncResult.sec16BcmHex || syncResult.sec16RfhHex) && (
                      <div style={{ fontSize: 10, color: C.tm, marginBottom: 4 }}>
                        {syncResult.sec16BcmHex && <div>BCM SEC16 (BE): <Mono>{syncResult.sec16BcmHex.toUpperCase()}</Mono></div>}
                        {syncResult.sec16RfhHex && <div>RFH SEC16: <Mono>{syncResult.sec16RfhHex.toUpperCase()}</Mono></div>}
                      </div>
                    )}
                    {syncResult.checks && syncResult.checks.map((ch, i) => (
                      <div key={i} style={{ fontSize: 10, color: ch.pass ? C.gn : C.er, marginBottom: 2, display: 'flex', gap: 8 }}>
                        <span>{ch.pass ? '✓' : '✗'}</span>
                        <span style={{ fontWeight: 700 }}>{ch.label}</span>
                        {ch.detail && <span style={{ color: C.tm }}>— {ch.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        </div>
      )}
    </Card>
  );
}
