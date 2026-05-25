import React, { useCallback, useState } from 'react';
import { Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { findVinsInText, scrubVinsFromText } from '../lib/udsSessionAnalyzer/shareLink.js';

/**
 * Shared "real VIN detected" confirm dialog for any trace-text export path
 * (share link, file download, clipboard copy, recorder handoff).
 *
 * Renders nothing when `state` is null. Three terminal actions:
 *   - Cancel: dismiss without exporting.
 *   - Proceed with real VIN: call `onProceed(text)` verbatim.
 *   - Scrub VINs first: call `onProceed(scrubVinsFromText(text))`.
 *
 * The "proceed" button label is customizable per export path so the user
 * sees the actual action they're confirming (e.g. "Share", "Download",
 * "Copy", "Send to Analyzer").
 */
export function VinScrubDialog({ state, onCancel, onProceed }) {
  if (!state) return null;
  const { vins, text, actionLabel = 'Continue' } = state;

  const handleProceedReal = () => onProceed(text);
  const handleProceedScrubbed = () => onProceed(scrubVinsFromText(text));

  return (
    <div
      data-testid="vin-scrub-dialog"
      style={{
        position: 'fixed', inset: 0, background: '#0008', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, padding: 20, maxWidth: 480,
          border: `2px solid ${C.sr}`, boxShadow: '0 10px 40px #0006',
        }}
      >
        <div style={{ fontFamily: "'Righteous'", fontSize: 18, color: C.sr, letterSpacing: 1, marginBottom: 8 }}>
          ⚠ REAL VIN DETECTED
        </div>
        <div style={{ fontSize: 12, color: C.tx, marginBottom: 10, lineHeight: 1.5 }}>
          This trace contains {vins.length === 1 ? 'a check-digit-valid VIN' : `${vins.length} check-digit-valid VINs`} that will be included in the export. Anyone with the file or link can read {vins.length === 1 ? 'it' : 'them'}.
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.ts,
          background: C.c2, border: `1px solid ${C.bd}`, borderRadius: 6,
          padding: '6px 10px', marginBottom: 12, maxHeight: 90, overflowY: 'auto',
        }}>
          {vins.map(v => <div key={v}>{v}</div>)}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Btn onClick={onCancel} color={C.tm} outline data-testid="vin-scrub-cancel">
            Cancel
          </Btn>
          <Btn onClick={handleProceedReal} color={C.sr} outline data-testid="vin-scrub-proceed-real">
            {actionLabel} with real VIN
          </Btn>
          <Btn onClick={handleProceedScrubbed} color={C.gn} data-testid="vin-scrub-proceed-scrubbed">
            Scrub VIN first
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook that gates a text-export action behind the shared VIN warning dialog.
 *
 * Usage:
 *   const vinGate = useVinScrubGate();
 *   <Btn onClick={() => vinGate.run(text, doExport, { actionLabel: 'Download' })}>...
 *   {vinGate.dialog}
 *
 * `run(text, onProceed, opts?)` scans `text` with `findVinsInText`. If any
 * check-digit-valid VIN is found, opens the dialog; the chosen action
 * (proceed-real or scrub-first) calls `onProceed(finalText)`. If no VINs
 * are found, `onProceed(text)` runs immediately with no UI shown.
 *
 * `onProceed` is captured per-invocation so multiple export paths in the
 * same tab can share one gate instance.
 */
export function useVinScrubGate() {
  const [state, setState] = useState(null);

  const run = useCallback((text, onProceed, opts = {}) => {
    const src = typeof text === 'string' ? text : '';
    const vins = findVinsInText(src);
    if (vins.length === 0) {
      onProceed(src);
      return;
    }
    setState({ vins, text: src, actionLabel: opts.actionLabel || 'Continue', onProceed });
  }, []);

  const cancel = useCallback(() => setState(null), []);

  const proceed = useCallback((finalText) => {
    const cb = state?.onProceed;
    setState(null);
    if (cb) cb(finalText);
  }, [state]);

  const dialog = (
    <VinScrubDialog state={state} onCancel={cancel} onProceed={proceed} />
  );

  return { run, cancel, dialog, pending: state };
}
