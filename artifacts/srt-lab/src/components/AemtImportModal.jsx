/* ============================================================================
 * AemtImportModal.jsx — post-import summary modal and VIN-prompt dialog for
 * the AEMT bundle importer. Two modes:
 *
 *   mode="summary"  — shown after a successful import. Displays: VIN,
 *                     files mapped to BCM/RFH/PCM, check results, backups
 *                     registered, and any warnings.
 *
 *   mode="error"    — shown on failure. Lists the primary error message and
 *                     the per-issue `details` array from AemtImportError.
 *
 *   mode="vin"      — a lightweight inline VIN prompt used when the bundle
 *                     did not contain a readable VIN. The parent calls
 *                     onConfirmVin(vin) or onCancel() based on the user's
 *                     input.
 * ============================================================================ */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { C } from '../lib/constants.js';
import { Card } from '../lib/ui.jsx';

const VIN_RE = /^[1-9A-HJ-NPR-Z][0-9A-HJ-NPR-Z]{16}$/;

function Overlay({ children, onClose }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div style={{
        maxWidth: 560, width: '100%', maxHeight: '90vh',
        overflowY: 'auto', borderRadius: 18,
        background: C.cd, boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
      }}>
        {children}
      </div>
    </div>
  );
}

/* ── Summary modal ── */
function SummaryModal({ result, onClose }) {
  const { vin, roles, warnings = [], checksPassed, checksTotal, checksAllGreen, backupStubs = [] } = result;

  const roleInfo = [
    { label: 'BCM', file: roles?.BCM },
    { label: 'RFH', file: roles?.RFH },
    { label: 'PCM', file: roles?.PCM },
  ];

  const badgeColor = checksAllGreen ? C.gn : checksTotal === 0 ? C.tm : C.wn;
  const badgeIcon = checksAllGreen ? '✓' : checksTotal === 0 ? '—' : '⚠';

  return (
    <Overlay onClose={onClose}>
      <div style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 28 }}>📦</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: C.gn }}>AEMT Import Complete</div>
            <div style={{ fontSize: 11, color: C.tm, marginTop: 2 }}>
              A new Key Prog preset has been created
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', background: 'none', border: '1px solid ' + C.bd,
              color: C.tm, padding: '4px 12px', borderRadius: 6, fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* VIN */}
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: C.c2, border: '1px solid ' + C.bd, marginBottom: 14,
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1.5, marginBottom: 4 }}>VIN</div>
          <div style={{ fontSize: 15, fontWeight: 900, fontFamily: "'JetBrains Mono'", color: C.tx, letterSpacing: 3 }}>
            {vin}
          </div>
        </div>

        {/* Module files */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1.5, marginBottom: 8 }}>
            MODULE FILES MAPPED
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {roleInfo.map(({ label, file }) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                borderRadius: 8, border: '1px solid ' + (file ? C.gn + '40' : C.er + '40'),
                background: file ? C.gn + '08' : C.er + '08',
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: 1,
                  color: file ? C.gn : C.er, minWidth: 36,
                }}>
                  {label}
                </span>
                <span style={{ fontSize: 11, color: C.tx, flex: 1, wordBreak: 'break-all' }}>
                  {file ? file.name : <em style={{ color: C.er }}>not found in bundle</em>}
                </span>
                {file && (
                  <span style={{ fontSize: 10, color: C.tm, whiteSpace: 'nowrap' }}>
                    {(file.data?.length / 1024).toFixed(1)} KB
                  </span>
                )}
                <span style={{ fontSize: 14 }}>{file ? '✓' : '✗'}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Checks */}
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          border: '1px solid ' + badgeColor + '40',
          background: badgeColor + '08',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>{badgeIcon}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: badgeColor }}>
                Wizard checks: {checksTotal === 0 ? 'not run (missing modules)' : checksPassed + '/' + checksTotal + ' passed'}
              </div>
              {!checksAllGreen && checksTotal > 0 && (
                <div style={{ fontSize: 10, color: C.tm, marginTop: 2 }}>
                  The preset was created with partial checks. Open Key Prog to review
                  and fix the failing checks before using this preset.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Backups registered */}
        {backupStubs.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            border: '1px solid ' + C.a3 + '40', background: C.a3 + '08',
            marginBottom: 14,
          }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.a3, letterSpacing: 1.5, marginBottom: 6 }}>
              PRE-WRITE BACKUPS REGISTERED
            </div>
            <div style={{ fontSize: 11, color: C.ts }}>
              {backupStubs.length} module backup stub{backupStubs.length !== 1 ? 's' : ''} added to the
              Backups tab. These hold the imported dump files as source-of-record for One-Click Restore.
            </div>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            border: '1px solid ' + C.wn + '40', background: C.wn + '08',
            marginBottom: 14,
          }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.wn, letterSpacing: 1.5, marginBottom: 6 }}>
              WARNINGS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 11, color: C.ts }}>⚠ {w}</div>
              ))}
            </div>
          </div>
        )}

        <div style={{ textAlign: 'center' }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 32px', borderRadius: 10, fontWeight: 800, fontSize: 12,
              border: 'none', cursor: 'pointer', background: C.gn, color: '#fff',
            }}
          >
            Done — open Key Prog to review
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ── Error modal ── */
function ErrorModal({ error, onClose }) {
  const details = error?.details || [];
  return (
    <Overlay onClose={onClose}>
      <div style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 28 }}>❌</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: C.er }}>AEMT Import Failed</div>
            <div style={{ fontSize: 12, color: C.tx, marginTop: 4, fontWeight: 700 }}>
              {error?.message || 'An unexpected error occurred.'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid ' + C.bd,
              color: C.tm, padding: '4px 12px', borderRadius: 6, fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {details.length > 0 && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            border: '1px solid ' + C.er + '30', background: C.er + '06',
            marginBottom: 18,
          }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.er, letterSpacing: 1.5, marginBottom: 8 }}>
              WHAT WENT WRONG
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {details.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, color: C.ts }}>
                  <span style={{ color: C.er, fontWeight: 800, minWidth: 16 }}>✗</span>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: C.tm, marginBottom: 18, lineHeight: 1.6 }}>
          Expected bundle structure: a <strong>.zip</strong> or loose files containing{' '}
          <code>BCM.bin</code>, <code>RFHUB.bin</code>, <code>PCM.bin</code> + an optional{' '}
          <code>job.json</code> with a <code>"vin"</code> field.
        </div>

        <div style={{ textAlign: 'center' }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 32px', borderRadius: 10, fontWeight: 800, fontSize: 12,
              border: '2px solid ' + C.er + '40', cursor: 'pointer',
              background: 'transparent', color: C.er,
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ── VIN prompt modal ── */
function VinPromptModal({ onConfirm, onCancel, warnings = [] }) {
  const [vin, setVin] = useState('');
  const inputRef = useRef(null);
  const valid = VIN_RE.test(vin);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && valid) onConfirm(vin);
    if (e.key === 'Escape') onCancel();
  }, [vin, valid, onConfirm, onCancel]);

  return (
    <Overlay onClose={onCancel}>
      <div style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 28 }}>🔍</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: C.sr }}>VIN Not Found in Bundle</div>
            <div style={{ fontSize: 11, color: C.tm, marginTop: 2 }}>
              Enter the VIN manually to continue the AEMT import
            </div>
          </div>
        </div>

        {warnings.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            border: '1px solid ' + C.wn + '40', background: C.wn + '08',
            marginBottom: 14, fontSize: 11, color: C.ts,
          }}>
            {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}

        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          The bundle metadata did not include a readable VIN, and one could not be
          extracted from the module dump headers. Enter the 17-character VIN for
          this job to create the preset.
        </div>

        <input
          ref={inputRef}
          value={vin}
          maxLength={17}
          placeholder="17-character VIN"
          onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''))}
          onKeyDown={handleKeyDown}
          data-testid="aemt-vin-prompt-input"
          style={{
            width: '100%', padding: '12px 16px', borderRadius: 10, boxSizing: 'border-box',
            border: '2px solid ' + (vin.length === 0 ? C.bd : valid ? C.gn : C.er),
            background: C.c2, fontFamily: "'JetBrains Mono'", fontSize: 16, fontWeight: 700,
            letterSpacing: 4, textAlign: 'center', outline: 'none', color: C.tx,
            marginBottom: 8,
          }}
        />
        <div style={{ fontSize: 10, color: valid ? C.gn : C.tm, textAlign: 'center', marginBottom: 20 }}>
          {vin.length}/17 characters{valid ? ' — valid VIN' : ''}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 24px', borderRadius: 10, fontWeight: 800, fontSize: 12,
              border: '1px solid ' + C.bd, cursor: 'pointer',
              background: 'transparent', color: C.tm,
            }}
          >
            Cancel import
          </button>
          <button
            onClick={() => valid && onConfirm(vin)}
            disabled={!valid}
            data-testid="aemt-vin-prompt-confirm"
            style={{
              padding: '10px 28px', borderRadius: 10, fontWeight: 800, fontSize: 12,
              border: 'none', cursor: valid ? 'pointer' : 'not-allowed',
              background: valid ? C.sr : '#E8E4DE', color: valid ? '#fff' : C.tm,
            }}
          >
            Continue import
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ── Main export ── */

/**
 * AemtImportModal — unified modal controller.
 *
 * Props:
 *   mode: 'summary' | 'error' | 'vin' | null
 *   result: object (for summary mode)
 *   error: Error (for error mode)
 *   warnings: string[] (for vin mode)
 *   onClose: () => void
 *   onConfirmVin: (vin: string) => void (for vin mode)
 *   onCancelVin: () => void (for vin mode)
 */
export default function AemtImportModal({
  mode, result, error, warnings, onClose, onConfirmVin, onCancelVin,
}) {
  if (!mode) return null;
  if (mode === 'summary') return <SummaryModal result={result} onClose={onClose} />;
  if (mode === 'error') return <ErrorModal error={error} onClose={onClose} />;
  if (mode === 'vin') {
    return (
      <VinPromptModal
        warnings={warnings}
        onConfirm={onConfirmVin}
        onCancel={onCancelVin}
      />
    );
  }
  return null;
}
