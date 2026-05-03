/* PcmRepairWizard.jsx — Task #574
 *
 * Guided "Repair PCM" modal. Shown when the user clicks the Repair PCM
 * CTA on a PCM card whose damage signals (virgin/missing SEC6 marker,
 * IMMO_DAMAGED IMMO byte, or VIN slots that don't match the BCM VIN)
 * are present AND when BCM+RFHUB agree on VIN+pairing secret (computed
 * upstream in ModuleSync.jsx).
 *
 * The modal:
 *   1. Shows the trusted source summary (BCM/RFHUB VIN + RFH SEC16 head)
 *   2. Calls planPcmRepair() to compute the patched buffer + edit list
 *   3. Renders a per-offset before/after diff
 *   4. Offers two downloads: the repaired .bin and a plain-text report
 *
 * If planPcmRepair() refuses (preconditions fail) we render a refusal
 * banner with the plain-English reason instead of a download button.
 */

import { useMemo, useState } from 'react';
import { planPcmRepair } from '../lib/rfhPcmPair.js';

const W = {
  bg:   '#0F1419',
  surf: '#161C24',
  s2:   '#1B232C',
  s3:   '#212A35',
  bd:   '#2A2F36',
  tx:   '#E0E0E0',
  ts:   '#A8B0BA',
  tm:   '#6B7280',
  a2:   '#60A5FA',
  a3:   '#FB923C',
  gn:   '#4ADE80',
  er:   '#F87171',
  wn:   '#FBBF24',
  mono: "'JetBrains Mono', 'Consolas', monospace",
  sans: "'Nunito', system-ui, sans-serif",
};

function timestamp() {
  const d = new Date(), p = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(data, filename, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildReport({ targetVin, secret6Hex, sourceFilename, sourceSize, edits, refusal }) {
  const lines = [];
  lines.push('SRT LAB — PCM REPAIR REPORT');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Source PCM file: ' + (sourceFilename || '(unnamed)'));
  lines.push('Source PCM size: ' + sourceSize + ' B');
  lines.push('Target VIN (from BCM, confirmed match RFHUB): ' + targetVin);
  lines.push('Pairing secret (first 6 B of RFHUB SEC16): ' + secret6Hex);
  lines.push('');
  if (refusal) {
    lines.push('REPAIR REFUSED');
    lines.push('Reason: ' + refusal);
    return lines.join('\n');
  }
  lines.push('EDITS (' + edits.length + ')');
  if (edits.length === 0) {
    lines.push('  (no offsets needed changing — PCM was already in repaired state)');
  }
  for (const e of edits) {
    lines.push('  ' + e.label);
    lines.push('    offset: 0x' + e.offset.toString(16).toUpperCase().padStart(4, '0')
      + '  length: ' + e.length + ' B');
    lines.push('    before: ' + e.before + (e.beforeAscii ? '  "' + e.beforeAscii + '"' : ''));
    lines.push('    after:  ' + e.after  + (e.afterAscii  ? '  "' + e.afterAscii  + '"' : ''));
  }
  lines.push('');
  lines.push('All other offsets in the output file are byte-identical to the input.');
  return lines.join('\n');
}

export default function PcmRepairWizard({
  pcmBytes,
  pcmFilename,
  targetVin,
  secret6,
  bcmVin,
  rfhVin,
  rfhSec16Hex,
  damageReasons,
  onClose,
  onLog,
}) {
  const [confirmed, setConfirmed] = useState(false);

  const plan = useMemo(() => {
    return planPcmRepair({ pcmBytes, targetVin, secret6 });
  }, [pcmBytes, targetVin, secret6]);

  const sec6Hex = useMemo(() => {
    if (!secret6) return '';
    return Array.from(secret6).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }, [secret6]);

  const handleDownloadBin = () => {
    if (!plan.ok) return;
    const ts = timestamp();
    const fname = `PCM_REPAIRED_${targetVin}_${ts}.bin`;
    downloadBlob(plan.patchedBytes, fname, 'application/octet-stream');
    if (onLog) onLog(`PCM repair: downloaded ${fname} (${plan.edits.length} offset${plan.edits.length === 1 ? '' : 's'} changed)`, 'ok');
  };

  const handleDownloadReport = () => {
    const ts = timestamp();
    const fname = `PCM_REPAIR_REPORT_${targetVin || 'NO-VIN'}_${ts}.txt`;
    const text = buildReport({
      targetVin,
      secret6Hex: sec6Hex,
      sourceFilename: pcmFilename,
      sourceSize: pcmBytes ? pcmBytes.length : 0,
      edits: plan.ok ? plan.edits : [],
      refusal: plan.ok ? null : plan.reason,
    });
    downloadBlob(text, fname, 'text/plain');
    if (onLog) onLog(`PCM repair: downloaded ${fname}`, 'info');
  };

  return (
    <div
      data-testid="pcm-repair-wizard"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16, fontFamily: W.sans,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: W.surf, border: `1.5px solid ${W.a3}`, borderRadius: 14,
        width: '100%', maxWidth: 760, maxHeight: '92vh',
        boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(135deg, ${W.a3}22 0%, ${W.a3}0A 100%)`,
          borderBottom: `1px solid ${W.bd}`,
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <div style={{ fontSize: 22 }}>🩹</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 14, color: W.tx, letterSpacing: 0.5 }}>
              REPAIR PCM (GPEC2A)
            </div>
            <div style={{ fontSize: 11, color: W.ts, marginTop: 2 }}>
              Stamp the trusted BCM VIN + RFHUB pairing secret into a damaged PCM dump
            </div>
          </div>
          <button
            data-testid="pcm-repair-close"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: W.tm, fontSize: 20,
              cursor: 'pointer', padding: '0 4px',
            }}>×</button>
        </div>

        {/* Body (scrollable) */}
        <div style={{ overflowY: 'auto', padding: '16px 18px', flex: 1 }}>
          {/* Damage signals */}
          <div style={{
            padding: '10px 12px', borderRadius: 10, marginBottom: 14,
            background: W.er + '14', border: `1px solid ${W.er}55`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: W.er, letterSpacing: 1, marginBottom: 6 }}>
              WHY THIS PCM NEEDS REPAIR
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: W.tx, fontSize: 12, lineHeight: 1.6 }}>
              {(damageReasons && damageReasons.length > 0
                ? damageReasons
                : ['PCM is flagged as damaged by the parser.']).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>

          {/* Trusted source summary */}
          <div style={{
            padding: '10px 12px', borderRadius: 10, marginBottom: 14,
            background: W.gn + '0E', border: `1px solid ${W.gn}40`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: W.gn, letterSpacing: 1, marginBottom: 6 }}>
              ✓ TRUSTED SOURCE — BCM AND RFHUB AGREE
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 4, columnGap: 12, fontSize: 12 }}>
              <div style={{ color: W.ts }}>BCM VIN</div>
              <div data-testid="pcm-repair-bcm-vin" style={{ color: W.tx, fontFamily: W.mono, letterSpacing: 1 }}>{bcmVin || '—'}</div>
              <div style={{ color: W.ts }}>RFHUB VIN</div>
              <div data-testid="pcm-repair-rfh-vin" style={{ color: W.tx, fontFamily: W.mono, letterSpacing: 1 }}>{rfhVin || '—'}</div>
              <div style={{ color: W.ts }}>RFH SEC16</div>
              <div style={{ color: W.tx, fontFamily: W.mono, fontSize: 11 }}>{rfhSec16Hex || '—'}</div>
              <div style={{ color: W.ts }}>SEC6 to write</div>
              <div data-testid="pcm-repair-secret6" style={{ color: W.a3, fontFamily: W.mono, fontWeight: 700 }}>{sec6Hex || '—'}</div>
              <div style={{ color: W.ts }}>Source file</div>
              <div style={{ color: W.tx, fontFamily: W.mono, fontSize: 11 }}>{pcmFilename || '—'} · {pcmBytes ? pcmBytes.length + ' B' : ''}</div>
            </div>
          </div>

          {/* Refusal or edit table */}
          {!plan.ok ? (
            <div
              data-testid="pcm-repair-refusal"
              style={{
                padding: '14px 16px', borderRadius: 10,
                background: W.er + '14', border: `1.5px solid ${W.er}`,
                color: W.tx, fontSize: 13, lineHeight: 1.6,
              }}>
              <div style={{ fontWeight: 900, color: W.er, marginBottom: 6 }}>⛔ Cannot repair this PCM</div>
              <div>{plan.reason}</div>
              <div style={{ marginTop: 10, fontSize: 11, color: W.ts }}>
                Repair is intentionally refused so a bad input never produces a bench file. Fix the
                preconditions above and reopen this dialog, or download just the report below for
                an audit trail.
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, color: W.ts, letterSpacing: 1, marginBottom: 8 }}>
                PLANNED EDITS — {plan.edits.length} OFFSET{plan.edits.length === 1 ? '' : 'S'} WILL CHANGE
              </div>
              {plan.edits.length === 0 ? (
                <div data-testid="pcm-repair-noop" style={{
                  padding: '12px 14px', borderRadius: 10,
                  background: W.wn + '14', border: `1px solid ${W.wn}55`,
                  color: W.tx, fontSize: 12, lineHeight: 1.5,
                }}>
                  ✓ No edits needed — every offset already matches the trusted source. Output
                  file would be byte-identical to the input. Repair download disabled.
                </div>
              ) : (
                <div data-testid="pcm-repair-edits"
                  style={{ borderRadius: 10, border: `1px solid ${W.bd}`, overflow: 'hidden' }}>
                  {plan.edits.map((e, i) => (
                    <div key={i} style={{
                      padding: '10px 12px',
                      borderTop: i === 0 ? 'none' : `1px solid ${W.bd}`,
                      background: i % 2 === 0 ? W.bg : W.s2,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: W.a3, marginBottom: 4 }}>
                        {e.label}
                      </div>
                      <div style={{ fontFamily: W.mono, fontSize: 11, lineHeight: 1.7 }}>
                        <div><span style={{ color: W.er, fontWeight: 800 }}>− before</span> <span style={{ color: W.er }}>{e.before}</span>{e.beforeAscii ? <span style={{ color: W.tm, marginLeft: 8 }}>"{e.beforeAscii}"</span> : null}</div>
                        <div><span style={{ color: W.gn, fontWeight: 800 }}>+ after </span> <span style={{ color: W.gn }}>{e.after}</span>{e.afterAscii ? <span style={{ color: W.tm, marginLeft: 8 }}>"{e.afterAscii}"</span> : null}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {plan.edits.length > 0 && !confirmed && (
                <div style={{ marginTop: 14 }}>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12, color: W.ts, cursor: 'pointer', userSelect: 'none',
                  }}>
                    <input
                      type="checkbox"
                      data-testid="pcm-repair-confirm"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      style={{ accentColor: W.a3, cursor: 'pointer' }}
                    />
                    I understand this only changes the offsets listed above. Every other byte
                    of the PCM dump is preserved.
                  </label>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${W.bd}`,
          background: W.s2, display: 'flex', justifyContent: 'flex-end',
          gap: 10, flexShrink: 0, flexWrap: 'wrap',
        }}>
          <button
            onClick={onClose}
            data-testid="pcm-repair-cancel"
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: `1px solid ${W.bd}`, background: W.surf,
              color: W.tx, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            Cancel
          </button>
          <button
            onClick={handleDownloadReport}
            data-testid="pcm-repair-download-report"
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: `1px solid ${W.a2}`, background: W.a2 + '22',
              color: W.a2, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}>
            ⤓ Report (.txt)
          </button>
          <button
            onClick={handleDownloadBin}
            disabled={!plan.ok || plan.edits.length === 0 || !confirmed}
            data-testid="pcm-repair-download-bin"
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              background: (!plan.ok || plan.edits.length === 0 || !confirmed) ? W.bd : W.a3,
              color: (!plan.ok || plan.edits.length === 0 || !confirmed) ? W.tm : '#1A1A1A',
              fontSize: 13, fontWeight: 800,
              cursor: (!plan.ok || plan.edits.length === 0 || !confirmed) ? 'not-allowed' : 'pointer',
              opacity: (!plan.ok || plan.edits.length === 0 || !confirmed) ? 0.6 : 1,
            }}>
            ⤓ Download Repaired PCM .bin
          </button>
        </div>
      </div>
    </div>
  );
}
