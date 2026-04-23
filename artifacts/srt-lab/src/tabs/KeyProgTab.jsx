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
import { identifyModule, runKeyProgPatch } from '../lib/keyProgWizard.js';
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
  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState(null);

  useEffect(() => { setPresets(loadPresets()); }, []);

  const trioReady = !!(files.BCM && files.RFH && files.PCM);
  const canSavePreset = trioReady && vin.length === 17 && presetName.trim().length > 0;

  const handleSavePreset = useCallback(() => {
    try {
      savePreset({ name: presetName, vin, files });
      setPresets(loadPresets());
      setPresetName('');
      setPresetMsg({ kind: 'ok', text: 'Preset saved.' });
    } catch (e) {
      setPresetMsg({ kind: 'err', text: String(e.message || e) });
    }
  }, [presetName, vin, files]);

  const handleLoadPreset = useCallback((id) => {
    const p = loadPresets().find((x) => x.id === id);
    if (!p) { setPresetMsg({ kind: 'err', text: 'Preset not found.' }); return; }
    const h = hydratePreset(p);
    if (!h) { setPresetMsg({ kind: 'err', text: 'Preset is corrupted.' }); return; }
    setFiles(h.files);
    setVin(h.vin);
    setUnknownDrops([]);
    setPresetMsg({ kind: 'ok', text: 'Loaded preset "' + p.name + '".' });
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

  const dl = (data, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const downloadAll = () => {
    if (!result?.ok) return;
    const entries = {};
    for (const f of result.files) {
      entries[f.name] = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    }
    const zipped = zipSync(entries, { level: 6 });
    dl(zipped, 'KEYPROG_' + vin + '.zip');
  };

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
            title={canSavePreset ? 'Save current trio + VIN as a preset' : 'Load all three modules and a 17-char VIN, then name the preset'}
            style={{
              padding: '8px 16px', borderRadius: 8, fontWeight: 800, fontSize: 11,
              border: 'none', cursor: canSavePreset ? 'pointer' : 'not-allowed',
              background: canSavePreset ? C.sr : '#E8E4DE',
              color: canSavePreset ? '#fff' : C.tm,
            }}>
            ＋ Save preset
          </button>
        </div>
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

      {!result && (
        <Card style={{ padding: 18, textAlign: 'center', color: C.tm, fontSize: 12 }}>
          Load all three modules and enter a 17-character VIN to preview the patch.
        </Card>
      )}
    </div>
  );
}
