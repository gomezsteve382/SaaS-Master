/* ============================================================================
 * KeyProgTab — Task #343 "Stamp VIN to module set" wizard.
 *
 * Drop a BCM + RFH + PCM trio, type a target VIN, watch the BEFORE/AFTER VIN
 * slot table light up, and download three flash-ready bins + a VERIFY report.
 * Wraps the same algorithm as scripts/patch-cluster-b-vin.mjs so locksmiths
 * never have to touch a shell.
 *
 * The "Download" buttons stay disabled until every check on the right-hand
 * checklist is green. IMMO backup auto-sync is OFF by default — flip the
 * "Promote bank" toggle only if you intentionally want writeModuleVIN to
 * copy 0x40C0 → 0x2000.
 * ========================================================================== */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { zipSync } from 'fflate';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { identifyModule, runKeyProgPatch, sha256Hex, formatBcmSec16Provenance } from '../lib/keyProgWizard.js';
import {
  loadPresets, savePreset, deletePreset, hydratePreset,
} from '../lib/keyProgPresets.js';

const ROLE_LABEL = { BCM: 'BCM (D-FLASH)', RFH: 'RFHUB (EEE)', PCM: 'PCM (GPEC2A)' };
const ROLE_ORDER = ['BCM', 'RFH', 'PCM'];

function FileSlot({ role, file, onPick, onClear }) {
  const filled = !!file;
  return (
    <div
      data-testid={'keyprog-slot-' + role.toLowerCase()}
      style={{
        flex: 1, minWidth: 200,
        border: '2px dashed ' + (filled ? C.gn + '60' : C.bd),
        borderRadius: 12, padding: 14,
        background: filled ? C.gn + '08' : C.c2,
      }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: filled ? C.gn : C.tm, letterSpacing: 1.5 }}>
        {ROLE_LABEL[role]}
      </div>
      {filled ? (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, marginTop: 6, wordBreak: 'break-all', color: C.tx }}>
            {file.name}
          </div>
          <div style={{ fontSize: 10, color: C.tm, marginTop: 4 }}>
            {(file.data.length / 1024).toFixed(1)} KB
          </div>
          <button
            data-testid={'keyprog-slot-' + role.toLowerCase() + '-clear'}
            onClick={onClear}
            style={{
              marginTop: 8, background: 'none', border: '1px solid ' + C.bd,
              color: C.tm, padding: '4px 10px', borderRadius: 6, fontSize: 10,
              cursor: 'pointer',
            }}>
            ✕ Remove
          </button>
        </>
      ) : (
        <label style={{ display: 'block', marginTop: 6, fontSize: 11, color: C.tm, cursor: 'pointer' }}>
          <input
            data-testid={'keyprog-slot-' + role.toLowerCase() + '-input'}
            type="file"
            accept=".bin,.BIN"
            style={{ display: 'none' }}
            onChange={(e) => onPick(e.target.files)}
          />
          Click to choose a {role} file
        </label>
      )}
    </div>
  );
}

export default function KeyProgTab() {
  const [files, setFiles] = useState({ BCM: null, RFH: null, PCM: null });
  const [vin, setVin] = useState('');
  const [promoteBank, setPromoteBank] = useState(false);
  const [unknownDrops, setUnknownDrops] = useState([]);
  const [zipSummary, setZipSummary] = useState(null);
  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState(null);
  const [loadedPreset, setLoadedPreset] = useState(null);
  const [dismissedPresetNote, setDismissedPresetNote] = useState(null);

  useEffect(() => { setPresets(loadPresets()); }, []);

  const trioReady = !!(files.BCM && files.RFH && files.PCM);

  /* Task #381 — surface BCM SEC16 provenance (split / mirror1 / mirror2 /
   * flat) in the wizard so operators can see at a glance whether the
   * shared-secret derivation read the live split records or fell back to
   * the legacy 0x40C9 flat slice. Also detect a virgin / BLANK cluster
   * and explain that *that* is why the download buttons stay disabled,
   * instead of the generic "missing secret" path. Computed only when a
   * BCM file is loaded; no work for the empty state. */
  const bcmSec16Status = useMemo(() => {
    if (!files.BCM) return null;
    const id = identifyModule(files.BCM.data, files.BCM.name);
    if (id.role !== 'BCM') return null;
    // Task #386 — share the badge formatter with the VERIFY report so the
    // archived ZIP and the live wizard never disagree on what the SEC16
    // source / offset / blank flag was.
    return formatBcmSec16Provenance(id.info?.bcmSec16);
  }, [files.BCM]);

  const handleLoadPreset = useCallback((id) => {
    const p = loadPresets().find((x) => x.id === id);
    if (!p) { setPresetMsg({ kind: 'err', text: 'Preset not found.' }); return; }
    const h = hydratePreset(p);
    if (!h) { setPresetMsg({ kind: 'err', text: 'Preset is corrupted.' }); return; }
    setFiles(h.files);
    setVin(h.vin);
    setUnknownDrops([]);
    setPresetMsg(null);
    setLoadedPreset({
      id: p.id,
      name: p.name,
      hadChecksSnapshot: typeof p.checksTotal === 'number',
      savedAllGreen: !!p.checksAllGreen,
      savedPassed: p.checksPassed || 0,
      savedTotal: p.checksTotal || 0,
      status: 'verifying',
      verifiedPassed: 0,
      verifiedTotal: 0,
      failedLabels: [],
    });
  }, []);

  const handleDeletePreset = useCallback((id) => {
    setPresets(deletePreset(id));
    setPresetMsg({ kind: 'ok', text: 'Preset deleted.' });
  }, []);

  const acceptFiles = useCallback((fileList) => {
    Array.from(fileList).forEach((f) => {
      const r = new FileReader();
      r.onload = (ev) => {
        const data = new Uint8Array(ev.target.result);
        const id = identifyModule(data, f.name);
        if (id.role) {
          setFiles((prev) => ({ ...prev, [id.role]: { name: f.name, data } }));
        } else {
          setUnknownDrops((prev) => [...prev, { name: f.name, type: id.info?.type || 'UNKNOWN' }]);
        }
      };
      r.readAsArrayBuffer(f);
    });
  }, []);

  const result = useMemo(() => {
    if (!files.BCM || !files.RFH || !files.PCM) return null;
    if (vin.length !== 17) return null;
    try {
      return runKeyProgPatch({
        bcm: files.BCM, rfh: files.RFH, pcm: files.PCM,
        vin, promoteBank,
      });
    } catch (e) {
      return { ok: false, checks: [{ label: 'Patcher threw error', pass: false, detail: String(e) }], files: [], before: null, after: null };
    }
  }, [files, vin, promoteBank]);

  const checksAllGreen = !!(result && result.ok && Array.isArray(result.checks)
    && result.checks.length > 0 && result.checks.every((c) => c.pass));
  const checksPassed = result?.checks?.filter((c) => c.pass).length || 0;
  const checksTotal = result?.checks?.length || 0;
  const canSavePreset = trioReady && vin.length === 17
    && presetName.trim().length > 0 && checksAllGreen;

  let saveDisabledReason = '';
  if (!trioReady) saveDisabledReason = 'Load all three modules first.';
  else if (vin.length !== 17) saveDisabledReason = 'Enter a 17-character target VIN.';
  else if (!result) saveDisabledReason = 'Waiting for the patcher to finish previewing.';
  else if (!checksAllGreen) {
    saveDisabledReason = 'Wizard checks are not all green ('
      + checksPassed + '/' + checksTotal + ' passed). Fix the failing checks before saving — '
      + 'a preset saved now would reload modules that don\'t match.';
  } else if (presetName.trim().length === 0) {
    saveDisabledReason = 'Name the preset before saving.';
  }

  const handleSavePreset = useCallback(() => {
    if (!checksAllGreen) {
      setPresetMsg({
        kind: 'err',
        text: 'Refusing to save: wizard checks are not all green ('
          + checksPassed + '/' + checksTotal + '). '
          + 'Fix the failing checks first so the preset reloads to a READY state.',
      });
      return;
    }
    try {
      savePreset({ name: presetName, vin, files, checks: result?.checks || [] });
      setPresets(loadPresets());
      setPresetName('');
      setPresetMsg({ kind: 'ok', text: 'Preset saved (all ' + checksTotal + ' checks green).' });
    } catch (e) {
      setPresetMsg({ kind: 'err', text: String(e.message || e) });
    }
  }, [presetName, vin, files, result, checksAllGreen, checksPassed, checksTotal]);

  const dl = (data, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const downloadAll = async () => {
    if (!result?.ok) return;
    const entries = {};
    const summaryEntries = [];
    for (const f of result.files) {
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      entries[f.name] = bytes;
      // SHA-256 over the actual bytes written into the archive
      // eslint-disable-next-line no-await-in-loop
      const hash = await sha256Hex(bytes);
      summaryEntries.push({ name: f.name, size: bytes.length, sha256: hash });
    }
    const zipped = zipSync(entries, { level: 6 });
    const zipName = 'KEYPROG_' + vin + '.zip';
    dl(zipped, zipName);
    setZipSummary({
      zipName,
      zipSize: zipped.length,
      entries: summaryEntries,
      at: new Date().toISOString(),
    });
  };

  // Clear the post-download summary whenever inputs change so it always
  // reflects the most recent ZIP the user actually downloaded.
  useEffect(() => { setZipSummary(null); }, [files, vin, promoteBank]);

  // Once the wizard has re-run after a Load, lock in a verification verdict
  // for the loaded preset so the banner can switch from "verifying…" to a
  // green/stale result. Old presets (no `checks` snapshot) flow through the
  // same path so they get a real READY/STALE verdict instead of silently
  // appearing safe.
  useEffect(() => {
    if (!loadedPreset || loadedPreset.status !== 'verifying') return;
    if (!result) return;
    const passed = result.checks?.filter((c) => c.pass).length || 0;
    const total = result.checks?.length || 0;
    const allGreen = !!(result.ok && total > 0 && result.checks.every((c) => c.pass));
    const failedLabels = (result.checks || [])
      .filter((c) => !c.pass)
      .map((c) => c.label);
    setLoadedPreset((prev) => (prev && prev.status === 'verifying'
      ? {
        ...prev,
        status: allGreen ? 'green' : 'stale',
        verifiedPassed: passed,
        verifiedTotal: total,
        failedLabels,
      }
      : prev));
  }, [result, loadedPreset]);

  // If the user mutates the inputs after we've shown a verdict, dismiss the
  // banner — it would otherwise misrepresent the current trio. Intentionally
  // does nothing while status === 'verifying' (initial load also flips
  // files/vin, but we want to keep the banner through that transition).
  useEffect(() => {
    if (loadedPreset && loadedPreset.status !== 'verifying') {
      setDismissedPresetNote({ name: loadedPreset.name, at: Date.now() });
      setLoadedPreset(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, vin, promoteBank]);

  // Auto-clear the "preset banner dismissed" note after a few seconds so it
  // behaves like a transient toast and doesn't pile up between edits.
  useEffect(() => {
    if (!dismissedPresetNote) return undefined;
    const t = setTimeout(() => setDismissedPresetNote(null), 6000);
    return () => clearTimeout(t);
  }, [dismissedPresetNote]);

  return (
    <div data-testid="keyprog-wizard">
      <Card style={{ marginBottom: 14, padding: 18 }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: C.sr }}>
          🔑 One-click "Stamp VIN to module set"
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginTop: 4, lineHeight: 1.5 }}>
          Drop a matched BCM + RFH + PCM trio, type the target VIN, then download three
          flash-ready bins + a VERIFY report. Same checklist as the Cluster B patcher
          script — no shell required.
        </div>

        <div
          onDrop={(e) => { e.preventDefault(); acceptFiles(e.dataTransfer.files); }}
          onDragOver={(e) => e.preventDefault()}
          data-testid="keyprog-dropzone"
          style={{
            display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap',
          }}>
          {ROLE_ORDER.map((role) => (
            <FileSlot
              key={role}
              role={role}
              file={files[role]}
              onPick={acceptFiles}
              onClear={() => setFiles((prev) => ({ ...prev, [role]: null }))}
            />
          ))}
        </div>
        {bcmSec16Status && (
          <div
            data-testid="keyprog-bcm-sec16-status"
            data-sec16-source={bcmSec16Status.source || 'none'}
            data-sec16-blank={bcmSec16Status.blank ? '1' : '0'}
            style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 10,
              border: '1px solid ' + (bcmSec16Status.blank ? C.wn + '60' : C.gn + '40'),
              background: (bcmSec16Status.blank ? C.wn : C.gn) + '10',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color={bcmSec16Status.blank ? C.wn : C.gn}>
                BCM SEC16 · {bcmSec16Status.label}
              </Tag>
              {bcmSec16Status.blank && (
                <Tag color={C.wn}>BLANK / virgin</Tag>
              )}
              {!bcmSec16Status.blank && bcmSec16Status.hex && (
                <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts }}>
                  {bcmSec16Status.hex}
                </span>
              )}
            </div>
            {bcmSec16Status.blank ? (
              <div
                data-testid="keyprog-bcm-virgin-explainer"
                style={{ fontSize: 11, color: C.tx, marginTop: 8, lineHeight: 1.5 }}>
                This BCM looks <strong>virgin</strong> — every SEC16 candidate (split records
                @0x81A0/C0/E0, mirror1 0xEB, mirror2 0xCA, and the legacy flat slice @0x40C9)
                is all 0xFF / 0x00, so there's no shared secret to derive. The download
                buttons stay disabled until you load a BCM that has actually been paired to
                a vehicle. (A bench-fresh module dump will look like this.)
              </div>
            ) : (
              <div style={{ fontSize: 10, color: C.tm, marginTop: 6, lineHeight: 1.4 }}>
                {bcmSec16Status.source === 'flat'
                  ? 'Falling back to the legacy flat slice — split / mirror records were not present or were all blank.'
                  : 'Live SEC16 source — wizard derives the shared secret directly from this record.'}
              </div>
            )}
          </div>
        )}
        {unknownDrops.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 11, color: C.wn }}>
            ⚠ Skipped {unknownDrops.length} unrecognized file(s):{' '}
            {unknownDrops.map((u) => u.name + ' (' + u.type + ')').join(', ')}
            <button
              onClick={() => setUnknownDrops([])}
              style={{ marginLeft: 8, background: 'none', border: 'none', color: C.tm, cursor: 'pointer' }}>
              dismiss
            </button>
          </div>
        )}
      </Card>

      <Card style={{ marginBottom: 14, padding: 18 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.sr, letterSpacing: 2, marginBottom: 6 }}>
          TARGET VIN
        </div>
        <input
          data-testid="keyprog-vin-input"
          value={vin}
          maxLength={17}
          placeholder="17-char target VIN"
          onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''))}
          style={{
            width: '100%', padding: '10px 14px', borderRadius: 10,
            border: '2px solid ' + C.bd, background: C.c2,
            fontFamily: "'JetBrains Mono'", fontSize: 15, fontWeight: 700,
            letterSpacing: 3, textAlign: 'center', outline: 'none',
            boxSizing: 'border-box', color: C.tx,
          }}
        />
        <label
          data-testid="keyprog-promote-toggle"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
            fontSize: 11, fontWeight: 700, color: promoteBank ? C.wn : C.tm,
            cursor: 'pointer',
          }}>
          <input
            type="checkbox"
            checked={promoteBank}
            onChange={(e) => setPromoteBank(e.target.checked)}
            style={{ accentColor: C.wn }}
          />
          Promote bank — auto-sync IMMO backup (0x40C0 → 0x2000). Off by default; only
          enable if you really intend to promote the staged secret into the active bank.
        </label>
      </Card>

      <Card style={{ marginBottom: 14, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.sr, letterSpacing: 2 }}>
            SAVED PRESETS
          </div>
          <span style={{ fontSize: 10, color: C.tm }}>
            module trio + VIN, stored in this browser
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            data-testid="keyprog-preset-name"
            value={presetName}
            placeholder="Preset name (e.g. '2018 Charger Hellcat')"
            maxLength={60}
            onChange={(e) => setPresetName(e.target.value)}
            style={{
              flex: 1, minWidth: 220, padding: '8px 12px', borderRadius: 8,
              border: '1.5px solid ' + C.bd, background: C.c2, fontSize: 12,
              outline: 'none', color: C.tx, boxSizing: 'border-box',
            }}
          />
          <button
            data-testid="keyprog-preset-save"
            onClick={handleSavePreset}
            disabled={!canSavePreset}
            title={canSavePreset ? 'Save current trio + VIN as a preset' : (saveDisabledReason || 'Load all three modules and a 17-char VIN, then name the preset')}
            style={{
              padding: '8px 16px', borderRadius: 8, fontWeight: 800, fontSize: 11,
              border: 'none', cursor: canSavePreset ? 'pointer' : 'not-allowed',
              background: canSavePreset ? C.sr : '#E8E4DE',
              color: canSavePreset ? '#fff' : C.tm,
            }}>
            ＋ Save preset
          </button>
        </div>
        {trioReady && vin.length === 17 && result && !checksAllGreen && (
          <div
            data-testid="keyprog-preset-warn"
            style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              border: '1px solid ' + C.wn + '60', background: C.wn + '12',
              fontSize: 11, color: C.wn, fontWeight: 700,
            }}>
            ⚠ Wizard checks are not all green ({checksPassed}/{checksTotal} passed).
            Saving is disabled — a preset captured now would reload modules whose BCM
            secret, RFH SEC16, or PCM SEC6 don't agree. Fix the failing checks first.
          </div>
        )}
        {presetMsg && (
          <div
            data-testid="keyprog-preset-msg"
            style={{ marginTop: 8, fontSize: 11, color: presetMsg.kind === 'ok' ? C.gn : C.er }}>
            {presetMsg.text}
          </div>
        )}
        <div data-testid="keyprog-preset-list" style={{ marginTop: 12 }}>
          {presets.length === 0 ? (
            <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>
              No presets saved yet. Load a trio + VIN above and click "Save preset".
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {presets.map((p) => (
                <div
                  key={p.id}
                  data-testid={'keyprog-preset-' + p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '8px 12px', border: '1px solid ' + C.bd, borderRadius: 8,
                    background: C.c2,
                  }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: C.tx }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
                      VIN {p.vin} · BCM {p.files?.BCM?.name} · RFH {p.files?.RFH?.name} · PCM {p.files?.PCM?.name}
                    </div>
                    {typeof p.checksTotal === 'number' && (
                      <div
                        data-testid={'keyprog-preset-checks-' + p.id}
                        style={{
                          fontSize: 10, marginTop: 2, fontWeight: 700,
                          color: p.checksAllGreen ? C.gn : C.wn,
                        }}>
                        {p.checksAllGreen ? '✓' : '⚠'} saved with {p.checksPassed}/{p.checksTotal} checks green
                      </div>
                    )}
                  </div>
                  <button
                    data-testid={'keyprog-preset-load-' + p.id}
                    onClick={() => handleLoadPreset(p.id)}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 800,
                      border: '2px solid ' + C.sr + '33', background: 'transparent',
                      color: C.sr, cursor: 'pointer',
                    }}>
                    ↺ Load
                  </button>
                  <button
                    data-testid={'keyprog-preset-delete-' + p.id}
                    onClick={() => {
                      if (typeof window !== 'undefined' && window.confirm
                          && !window.confirm('Delete preset "' + p.name + '"?')) return;
                      handleDeletePreset(p.id);
                    }}
                    style={{
                      padding: '6px 12px', borderRadius: 6, fontSize: 11,
                      border: '1px solid ' + C.bd, background: 'transparent',
                      color: C.tm, cursor: 'pointer',
                    }}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {dismissedPresetNote && (
        <div
          data-testid="keyprog-preset-dismissed-note"
          style={{
            marginBottom: 14, padding: '10px 14px', borderRadius: 10,
            border: '1px solid ' + C.tm + '40', background: C.c2,
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 11, color: C.ts,
          }}>
          <span style={{ fontSize: 14 }}>ℹ</span>
          <span style={{ flex: 1 }}>
            Cleared the loaded preset banner for <strong style={{ color: C.tx }}>"{dismissedPresetNote.name}"</strong>{' '}
            because you changed the modules, VIN, or promote-bank toggle. The current trio is no longer the saved preset.
          </span>
          <button
            data-testid="keyprog-preset-dismissed-note-dismiss"
            onClick={() => setDismissedPresetNote(null)}
            style={{
              background: 'none', border: '1px solid ' + C.bd, color: C.tm,
              padding: '4px 10px', borderRadius: 6, fontSize: 10, cursor: 'pointer',
            }}>
            ✕
          </button>
        </div>
      )}

      {loadedPreset && (() => {
        const isVerifying = loadedPreset.status === 'verifying';
        const isGreen = loadedPreset.status === 'green';
        const color = isVerifying ? C.tm : (isGreen ? C.gn : C.wn);
        const icon = isVerifying ? '⏳' : (isGreen ? '✓' : '⚠');
        const headline = isVerifying
          ? 'Re-verifying preset "' + loadedPreset.name + '"…'
          : (isGreen
            ? 'Preset "' + loadedPreset.name + '" is still healthy ('
              + loadedPreset.verifiedPassed + '/' + loadedPreset.verifiedTotal + ' checks green)'
            : 'Preset "' + loadedPreset.name + '" is no longer fully healthy ('
              + loadedPreset.verifiedPassed + '/' + loadedPreset.verifiedTotal + ' checks green)');
        return (
          <div
            data-testid="keyprog-preset-verify-banner"
            data-verify-status={loadedPreset.status}>
            <Card
              style={{
                marginBottom: 14, padding: 14,
                border: '2px solid ' + color + '60',
                background: color + '10',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color }}>
                    {headline}
                  </div>
                  <div style={{ fontSize: 10, color: C.tm, marginTop: 3 }}>
                    {isVerifying
                      ? 'Re-running the wizard checks against the loaded trio…'
                      : (loadedPreset.hadChecksSnapshot
                        ? 'Saved with ' + loadedPreset.savedPassed + '/' + loadedPreset.savedTotal
                          + ' green' + (loadedPreset.savedAllGreen ? '' : ' (already partial when saved)')
                          + '.'
                        : 'Older preset — no saved check snapshot, verified on load.')}
                  </div>
                  {!isVerifying && !isGreen && loadedPreset.failedLabels.length > 0 && (
                    <ul
                      data-testid="keyprog-preset-verify-failures"
                      style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 11, color: C.wn }}>
                      {loadedPreset.failedLabels.map((label, i) => (
                        <li key={i} style={{ marginTop: 2 }}>{label}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  data-testid="keyprog-preset-verify-dismiss"
                  onClick={() => setLoadedPreset(null)}
                  style={{
                    background: 'none', border: '1px solid ' + C.bd, color: C.tm,
                    padding: '4px 10px', borderRadius: 6, fontSize: 10, cursor: 'pointer',
                  }}>
                  ✕ Dismiss
                </button>
              </div>
            </Card>
          </div>
        );
      })()}

      {result && (
        <div data-testid="keyprog-result"><Card style={{ marginBottom: 14, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Tag color={result.ok ? C.gn : C.er}>{result.ok ? '✓ READY' : '✗ BLOCKED'}</Tag>
            {result.sharedSecret && (
              <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.ts }}>
                shared secret (BE): <strong style={{ color: C.tx }}>{result.sharedSecret}</strong>
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Checklist */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 6 }}>
                CHECKLIST
              </div>
              <div data-testid="keyprog-checklist" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.checks.map((c, i) => (
                  <div
                    key={i}
                    data-testid={'keyprog-check-' + i}
                    data-check-pass={c.pass ? '1' : '0'}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 6,
                      fontSize: 11, color: c.pass ? C.gn : C.er,
                    }}>
                    <span style={{ fontWeight: 800 }}>{c.pass ? '✓' : '✗'}</span>
                    <span style={{ color: C.tx }}>{c.label}</span>
                    {c.detail && <span style={{ color: C.tm, marginLeft: 4 }}>— {c.detail}</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* BEFORE/AFTER VIN slot table */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.tm, letterSpacing: 1, marginBottom: 6 }}>
                BCM VIN SLOTS — BEFORE → AFTER
              </div>
              <table
                data-testid="keyprog-vin-table"
                style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
                <thead>
                  <tr style={{ color: C.tm, textAlign: 'left' }}>
                    <th style={{ padding: '4px 6px' }}>Off</th>
                    <th style={{ padding: '4px 6px' }}>Before</th>
                    <th style={{ padding: '4px 6px' }}>After</th>
                    <th style={{ padding: '4px 6px' }}>CRC</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.before?.bcmFullVins || []).map((b, i) => {
                    const a = result.after?.bcmFullVins?.[i];
                    return (
                      <tr key={'fv' + i}>
                        <td style={{ padding: '3px 6px', color: C.a3 }}>
                          0x{b.offset.toString(16).toUpperCase().padStart(4, '0')}
                        </td>
                        <td style={{ padding: '3px 6px', color: C.tm }}>{b.vin}</td>
                        <td style={{ padding: '3px 6px', color: a?.vin === vin ? C.gn : C.er, fontWeight: 700 }}>
                          {a?.vin || '—'}
                        </td>
                        <td style={{ padding: '3px 6px', color: a?.crcOk ? C.gn : C.er }}>
                          {a ? (a.crcOk ? 'OK' : 'BAD') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  {(result.before?.bcmPartials || []).map((b, i) => {
                    const a = result.after?.bcmPartials?.[i];
                    return (
                      <tr key={'pv' + i}>
                        <td style={{ padding: '3px 6px', color: C.a3 }}>
                          0x{b.offset.toString(16).toUpperCase().padStart(4, '0')}
                        </td>
                        <td style={{ padding: '3px 6px', color: C.tm }}>…{b.tail}</td>
                        <td style={{ padding: '3px 6px', color: a?.tail === vin.slice(9) ? C.gn : C.er, fontWeight: 700 }}>
                          …{a?.tail || '—'}
                        </td>
                        <td style={{ padding: '3px 6px', color: a?.crcOk ? C.gn : C.er }}>
                          {a ? (a.crcOk ? 'OK' : 'BAD') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              data-testid="keyprog-download-all"
              onClick={downloadAll}
              disabled={!result.ok}
              style={{ padding: '10px 20px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: 'none', cursor: result.ok ? 'pointer' : 'not-allowed', background: result.ok ? C.sr : '#E8E4DE', color: result.ok ? '#fff' : C.tm }}>
              ⬇ Download all {result.ok ? '(ZIP: 3 bins + VERIFY)' : '(blocked)'}
            </button>
            {result.files.map((f) => (
              <button
                key={f.role}
                data-testid={'keyprog-download-' + f.role.toLowerCase()}
                disabled={!result.ok}
                onClick={() => result.ok && dl(f.data, f.name)}
                style={{ padding: '10px 20px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: `2px solid ${C.sr}33`, cursor: result.ok ? 'pointer' : 'not-allowed', background: 'transparent', color: result.ok ? C.sr : C.tm }}>
                {f.role}: {f.name.length > 40 ? f.name.slice(0, 37) + '…' : f.name}
              </button>
            ))}
          </div>
        </Card></div>
      )}

      {zipSummary && (
        <div data-testid="keyprog-zip-summary">
          <Card style={{ marginBottom: 14, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <Tag color={C.gn}>📦 ZIP DOWNLOADED</Tag>
              <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", color: C.tx, fontWeight: 700 }}>
                {zipSummary.zipName}
              </span>
              <span style={{ fontSize: 10, color: C.tm }}>
                ({(zipSummary.zipSize / 1024).toFixed(1)} KB · {zipSummary.entries.length} entries)
              </span>
              <button
                onClick={() => setZipSummary(null)}
                data-testid="keyprog-zip-summary-dismiss"
                style={{ marginLeft: 'auto', background: 'none', border: '1px solid ' + C.bd, color: C.tm, padding: '4px 10px', borderRadius: 6, fontSize: 10, cursor: 'pointer' }}>
                ✕ Dismiss
              </button>
            </div>
            <div style={{ fontSize: 11, color: C.ts, marginBottom: 8, lineHeight: 1.5 }}>
              Verify these SHA-256 hashes against the bench tool after flashing.
            </div>
            <table
              data-testid="keyprog-zip-summary-table"
              style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
              <thead>
                <tr style={{ color: C.tm, textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px' }}>File</th>
                  <th style={{ padding: '4px 6px', textAlign: 'right' }}>Bytes</th>
                  <th style={{ padding: '4px 6px' }}>SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {zipSummary.entries.map((e, i) => (
                  <tr key={e.name} data-testid={'keyprog-zip-summary-row-' + i}>
                    <td style={{ padding: '3px 6px', color: C.tx, wordBreak: 'break-all' }}>{e.name}</td>
                    <td style={{ padding: '3px 6px', color: C.tm, textAlign: 'right' }}>
                      {e.size.toLocaleString()}
                    </td>
                    <td
                      data-testid={'keyprog-zip-summary-sha-' + i}
                      style={{ padding: '3px 6px', color: C.a3, wordBreak: 'break-all' }}>
                      {e.sha256}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {!result && (
        <Card style={{ padding: 18, textAlign: 'center', color: C.tm, fontSize: 12 }}>
          Load all three modules and enter a 17-character VIN to preview the patch.
        </Card>
      )}
    </div>
  );
}
