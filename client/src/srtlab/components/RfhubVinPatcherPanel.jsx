/**
 * RfhubVinPatcherPanel — offline RFHUB VIN editor.
 *
 * Self-contained: ships its own file picker and collapsible toggle.
 * No live OBD connection required.
 *
 * Supports:
 *   Gen2 (24C32, 4 KB): 4 byte-reversed VIN slots, auto-detected CS magic
 *   Gen1 (24C16, 2 KB): single plain VIN slot, CRC-16/CCITT
 *   XC2268 (internal-flash, ≥32 KB): inspect-only (VIN slots shown, patch blocked)
 *
 * Visual style matches ImmoChecksumPanel / Gpec2aImmoPanel.
 */

import React, {useMemo, useState, useCallback, useEffect, useRef} from 'react';
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {analyzeRfhubVin, patchRfhubVin, validateVin} from '../lib/rfhubVinPatcher.js';
import {dl} from './ImmoChecksumPanel.jsx';

const mono = "'JetBrains Mono'";

const labelStyle = {
  fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6,
  textTransform: 'uppercase', marginBottom: 4,
};
const inputStyle = {
  padding: '8px 10px', borderRadius: 8, border: '1.5px solid ' + C.bd,
  background: C.cd, fontFamily: mono, fontSize: 12, color: C.tx,
  width: '100%', boxSizing: 'border-box',
};

function StatBadge({value, good}) {
  const col = good ? C.gn : C.er;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6,
      background: col + '18', color: col, fontFamily: mono, letterSpacing: 0.4,
    }}>
      {value}
    </span>
  );
}

function NeutralBadge({value}) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6,
      background: C.tm + '18', color: C.tm, fontFamily: mono, letterSpacing: 0.4,
    }}>
      {value}
    </span>
  );
}

/**
 * @param {Object}  props
 * @param {import('../lib/parseModule.js').ParsedModule|null} props.initialMod
 *   Optional: a pre-loaded RFHUB dump from the shared workspace inspector.
 *   The panel can also load its own dump independently via the built-in file picker.
 * @param {Function} [props.onPatched]  optional callback(bytes, filename) for workspace push-back
 */
export default function RfhubVinPatcherPanel({initialMod = null, onPatched = null}) {
  // ── Panel open/collapse ──────────────────────────────────────────────────
  const [open, setOpen] = useState(false);

  // ── Internal bytes — loaded via own file picker OR seeded from initialMod ─
  const [bytes, setBytes] = useState(null);
  const [filename, setFilename] = useState('');
  const fileInputRef = useRef(null);

  // When the parent inspector loads a dump, seed into the panel automatically
  // but only if we haven't loaded our own file yet.
  useEffect(() => {
    if (initialMod && initialMod.data && !bytes) {
      setBytes(initialMod.data);
      setFilename(initialMod.filename || 'rfhub.bin');
      setOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMod]);

  const onFileChange = useCallback(e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
      setBytes(new Uint8Array(ev.target.result));
      setFilename(file.name);
      setMsg(''); setErr(''); setPatched(null);
    };
    r.readAsArrayBuffer(file);
    // Reset so the same file can be re-loaded
    e.target.value = '';
  }, []);

  const onClearFile = useCallback(() => {
    setBytes(null); setFilename('');
    setMsg(''); setErr(''); setPatched(null);
  }, []);

  // ── Analysis ─────────────────────────────────────────────────────────────
  const analysis = useMemo(() => (bytes ? analyzeRfhubVin(bytes) : null), [bytes]);

  // ── Editing state ─────────────────────────────────────────────────────────
  const [newVin, setNewVin] = useState('');
  const [contentOverride, setContentOverride] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [patched, setPatched] = useState(null);

  const baseName = filename.replace(/\.[^.]+$/, '') || 'rfhub';

  // Derive a consensus VIN from the first valid slot for the placeholder
  const consensusVin = useMemo(() => {
    if (!analysis) return '';
    for (const s of analysis.slots) {if (s.vin) return s.vin;}
    return '';
  }, [analysis]);

  const vinInputValid = useMemo(() => {
    if (!newVin) return null;
    try {validateVin(newVin); return true;} catch {return false;}
  }, [newVin]);

  const isXc = analysis?.xc2268;
  const isUnknown = analysis && !analysis.generation;
  const hasContentWarn = !!(analysis?.contentWarn);
  const patchBlocked = isXc || isUnknown || !bytes || (hasContentWarn && !contentOverride);
  const canPatch = !patchBlocked && vinInputValid === true;

  const onPatch = useCallback(() => {
    setMsg(''); setErr('');
    if (!bytes) {setErr('No RFHUB dump loaded.'); return;}
    if (!newVin.trim()) {setErr('Enter a new VIN before patching.'); return;}
    try {
      const result = patchRfhubVin(bytes, newVin.trim());
      const fname = baseName + '_vinPatch.bin';
      dl(result, fname);
      setPatched({bytes: result, filename: fname});
      const activeSlots = analysis?.slots.filter(s => !s.blank).length ?? 0;
      setMsg('Patched ' + activeSlots + ' VIN slot(s) → ' + newVin.toUpperCase() + ' — downloaded as ' + fname + '.');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, [bytes, newVin, baseName, analysis]);

  const onPushBack = useCallback(() => {
    if (!patched || typeof onPatched !== 'function') return;
    onPatched(patched.bytes, patched.filename);
    setPatched(null); setErr('');
    setMsg('Patched dump added to workspace — re-analyzing in place.');
  }, [patched, onPatched]);

  // ── Derived display ───────────────────────────────────────────────────────
  const genColor = !analysis ? C.tm
    : analysis.generation === 'gen2' ? C.a2
    : analysis.generation === 'gen1' ? C.a4
    : C.wn;

  const headerSummary = analysis
    ? analysis.mcuLabel + (analysis.slots.length > 0 ? ' · ' + analysis.slots.length + ' slot(s)' : '')
    : bytes ? 'Loading…' : 'No file loaded';

  return (
    <div data-testid="rfhub-vin-patcher-panel">
      {/* ── Collapsible header ────────────────────────────────────────── */}
      <Card
        style={{marginBottom: open ? 0 : 14, borderRadius: open ? '10px 10px 0 0' : 10, cursor: 'pointer'}}
        onClick={() => setOpen(o => !o)}
        data-testid="rfhub-vin-patcher-toggle"
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15, color: C.sr, letterSpacing: 1, whiteSpace: 'nowrap'}}>
              OFFLINE VIN PATCHER
            </div>
            {analysis && (
              <span style={{
                fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6,
                background: genColor + '18', color: genColor, fontFamily: mono, whiteSpace: 'nowrap',
              }}>
                {headerSummary}
              </span>
            )}
            {!analysis && filename && (
              <span style={{fontSize: 10, color: C.tm, fontFamily: mono}}>{filename}</span>
            )}
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0}}>
            <span style={{fontSize: 10, color: C.tm, fontWeight: 700}}>NO OBD NEEDED</span>
            <span style={{fontSize: 14, color: C.ts, transition: 'transform .2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)'}}>▶</span>
          </div>
        </div>
      </Card>

      {/* ── Expanded body ─────────────────────────────────────────────── */}
      {open && (
        <div style={{border: '1px solid ' + C.bd, borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 14, background: C.bg, marginBottom: 14}}>

          {/* File picker */}
          <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14}}>
            <label
              style={{
                padding: '8px 14px', borderRadius: 8, border: '2px dashed ' + C.sr + '50',
                background: C.c2, cursor: 'pointer', fontSize: 11, fontWeight: 800, color: C.sr,
              }}
            >
              Load RFHUB .bin
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin,.BIN,.eep,.EEP"
                hidden
                data-testid="rfhub-vin-patcher-file-input"
                onChange={onFileChange}
              />
            </label>
            {bytes && (
              <>
                <span style={{fontFamily: mono, fontSize: 10, color: C.ts}}>
                  {filename} · {(bytes.length / 1024).toFixed(1)} KB
                </span>
                <button
                  onClick={e => {e.stopPropagation(); onClearFile();}}
                  style={{border: 'none', background: 'transparent', color: C.tm, cursor: 'pointer', fontSize: 12}}
                  title="Clear loaded file"
                >
                  ✕
                </button>
              </>
            )}
          </div>

          {/* Nothing loaded yet */}
          {!bytes && (
            <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic', paddingBottom: 6}}>
              Load a Gen1 (2 KB), Gen2 (4 KB), or XC2268 RFHUB .bin / .eep dump to inspect and patch its VIN slots.
            </div>
          )}

          {/* Error for non-canonical buffer */}
          {isUnknown && analysis.error && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.er}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.er, marginBottom: 4, letterSpacing: 2}}>UNSUPPORTED IMAGE</div>
              <div style={{fontSize: 11, color: C.ts}}>{analysis.error}</div>
            </Card>
          )}

          {/* XC2268 notice */}
          {isXc && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.wn}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 4, letterSpacing: 2}}>
                XC2268 INTERNAL-FLASH — INSPECT ONLY
              </div>
              <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
                XC2268 offline VIN patching requires recomputing the whole-image trailing checksum and is not yet supported here.
                VIN slots are shown below for inspection. Use the live OBD write above to update the VIN over UDS.
              </div>
            </Card>
          )}

          {/* Content warning for unrecognised Gen2 content */}
          {hasContentWarn && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.wn}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 6, letterSpacing: 2}}>
                CONTENT WARNING — MAY NOT BE AN RFHUB DUMP
              </div>
              <div style={{fontSize: 11, color: C.ts, marginBottom: 8, lineHeight: 1.6}}>
                {analysis.contentWarn.message}
              </div>
              <ul style={{margin: '0 0 10px 16px', padding: 0, fontSize: 10, color: C.tm, lineHeight: 1.8}}>
                {analysis.contentWarn.causes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
              <label style={{display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: C.er, fontWeight: 700, cursor: 'pointer'}}>
                <input
                  type="checkbox"
                  checked={contentOverride}
                  onChange={e => setContentOverride(e.target.checked)}
                  data-testid="rfhub-vin-patcher-content-override"
                />
                I confirm this is an RFHUB dump and want to proceed anyway (e.g. blank/virgin module)
              </label>
            </Card>
          )}

          {/* VIN slots table */}
          {analysis && analysis.slots.length > 0 && (
            <Card style={{marginBottom: 12}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>VIN SLOTS</div>
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11}}>
                  <thead>
                    <tr style={{textAlign: 'left', color: C.ts, borderBottom: '1px solid ' + C.bd}}>
                      <th style={{padding: '6px 8px'}}>Slot</th>
                      <th style={{padding: '6px 8px'}}>Offset</th>
                      <th style={{padding: '6px 8px'}}>VIN</th>
                      <th style={{padding: '6px 8px'}}>CS Stored</th>
                      <th style={{padding: '6px 8px'}}>CS Expected</th>
                      <th style={{padding: '6px 8px'}}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.slots.map((slot, i) => (
                      <tr key={i} data-testid={'rfhub-vin-slot-' + i} style={{borderBottom: '1px solid ' + C.bd, fontFamily: mono}}>
                        <td style={{padding: '6px 8px', color: C.ts}}>{slot.slotNum}</td>
                        <td style={{padding: '6px 8px'}}>{slot.offsetHex}</td>
                        <td style={{padding: '6px 8px', fontWeight: 700}}>
                          {slot.blank
                            ? <span style={{color: C.tm, fontStyle: 'italic'}}>blank</span>
                            : slot.vin
                              ? <span style={{color: C.tx}}>{slot.vin}</span>
                              : <span style={{color: C.er}}>invalid</span>}
                        </td>
                        <td style={{padding: '6px 8px', color: C.tm}}>
                          {slot.blank ? '—' : slot.csFormat === 'CRC-16 BE' || slot.csFormat === 'CRC-16/CCITT BE'
                            ? '0x' + (slot.storedCs ?? 0).toString(16).toUpperCase().padStart(4, '0')
                            : '0x' + (slot.storedCs ?? 0).toString(16).toUpperCase().padStart(2, '0')}
                        </td>
                        <td style={{padding: '6px 8px', color: C.tm}}>
                          {slot.blank || slot.computedCs === null ? '—'
                            : slot.csFormat === 'CRC-16 BE' || slot.csFormat === 'CRC-16/CCITT BE'
                              ? '0x' + slot.computedCs.toString(16).toUpperCase().padStart(4, '0')
                              : '0x' + slot.computedCs.toString(16).toUpperCase().padStart(2, '0')}
                        </td>
                        <td style={{padding: '6px 8px'}}>
                          {slot.blank
                            ? <NeutralBadge value="BLANK" />
                            : slot.crcOk === null
                              ? <NeutralBadge value="N/A" />
                              : <StatBadge value={slot.crcOk ? 'OK' : 'BROKEN'} good={slot.crcOk} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {analysis.generation === 'gen2' && analysis.magic != null && (
                <div style={{marginTop: 8, fontSize: 10, color: C.tm, fontFamily: mono}}>
                  CS magic: 0x{analysis.magic.toString(16).toUpperCase().padStart(2, '0')} (auto-detected)
                </div>
              )}
            </Card>
          )}

          {/* Edit & Download — disabled for XC2268 and unrecognised images */}
          {analysis && !isUnknown && !isXc && (
            <Card style={{marginBottom: 12}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>PATCH VIN &amp; DOWNLOAD</div>
              <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
                Writes the new VIN into every slot and recomputes all checksums.
                The original file is not modified — a new patched .bin is downloaded.
                {analysis.slots.filter(s => !s.blank).length > 0
                  ? ' ' + analysis.slots.filter(s => !s.blank).length + ' occupied slot(s) will be rewritten.'
                  : ' All slots are blank — new VIN will be written to all ' + analysis.slots.length + ' slot(s).'}
              </div>

              <div>
                <div style={labelStyle}>New VIN (17 chars · no I/O/Q)</div>
                <input
                  data-testid="rfhub-vin-patcher-input"
                  value={newVin}
                  onChange={e => setNewVin(e.target.value.toUpperCase())}
                  placeholder={consensusVin || 'enter new 17-char VIN'}
                  maxLength={17}
                  style={{
                    ...inputStyle,
                    borderColor: vinInputValid === false ? C.er : vinInputValid === true ? C.gn : C.bd,
                  }}
                />
                {vinInputValid === false && (
                  <div style={{marginTop: 4, fontSize: 10, color: C.er, fontWeight: 700}}>
                    Invalid VIN — must be 17 alphanumeric characters with no I, O, or Q.
                  </div>
                )}
                {vinInputValid === true && (
                  <div style={{marginTop: 4, fontSize: 10, color: C.gn, fontWeight: 700}}>✓ VIN format valid</div>
                )}
              </div>

              <div style={{marginTop: 12}}>
                <Btn
                  data-testid="rfhub-vin-patcher-patch-btn"
                  color={C.sr}
                  full
                  onClick={onPatch}
                  disabled={!canPatch}
                >
                  PATCH VIN &amp; DOWNLOAD
                </Btn>
              </div>
            </Card>
          )}

          {/* Push-back to workspace */}
          {patched && typeof onPatched === 'function' && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.gn}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.gn, marginBottom: 4, letterSpacing: 2}}>SAVE BACK TO WORKSPACE</div>
              <div style={{fontSize: 10, color: C.tm, marginBottom: 10}}>
                Add the patched bytes into the shared workspace as a new RFHUB dump and re-analyze in place.
                The download above is still saved to disk.
              </div>
              <Btn color={C.gn} full onClick={onPushBack} data-testid="rfhub-vin-patcher-pushback-btn">
                ADD PATCHED DUMP TO WORKSPACE &amp; RE-ANALYZE
              </Btn>
            </Card>
          )}

          {/* Status bar */}
          {(msg || err) && (
            <div
              data-testid="rfhub-vin-patcher-status"
              style={{
                padding: '10px 14px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                whiteSpace: 'pre-wrap',
                background: err ? C.er + '12' : C.gn + '12',
                border: '1px solid ' + (err ? C.er + '40' : C.gn + '40'),
                color: err ? C.er : C.gn,
              }}
            >
              {err || msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
