/**
 * RfhubVinPatcherPanel — offline RFHUB VIN editor.
 *
 * No OBD connection required.  Accepts a loaded RFHUB dump (mod prop),
 * displays all VIN slots with their CRC status, and lets the operator
 * type a new VIN and download a patched image.
 *
 * Supports:
 *   Gen2 (24C32, 4 KB): 4 byte-reversed VIN slots, auto-detected CS magic
 *   Gen1 (24C16, 2 KB): single plain VIN slot, CRC-16/CCITT
 *   XC2268 (internal-flash, ≥32 KB): inspect-only notice
 *
 * Visual style matches ImmoChecksumPanel / Gpec2aImmoPanel.
 */

import React, {useMemo, useState, useCallback} from 'react';
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
 * @param {{ mod: import('../lib/parseModule.js').ParsedModule|null, onPatched?: Function }} props
 *   mod       — the currently-loaded RFHUB dump from the shared workspace
 *   onPatched — optional callback(bytes, filename) to push patched bytes back into the workspace
 */
export default function RfhubVinPatcherPanel({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || 'rfhub.bin').replace(/\.[^.]+$/, '');

  const analysis = useMemo(() => (bytes ? analyzeRfhubVin(bytes) : null), [bytes]);

  const [newVin, setNewVin] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [patched, setPatched] = useState(null);

  // Derive a consensus VIN from the first valid slot for the placeholder
  const consensusVin = useMemo(() => {
    if (!analysis) return '';
    for (const s of analysis.slots) {
      if (s.vin) return s.vin;
    }
    return '';
  }, [analysis]);

  const vinInputValid = useMemo(() => {
    if (!newVin) return null; // neutral — nothing typed yet
    try {validateVin(newVin); return true;} catch {return false;}
  }, [newVin]);

  const onPatch = useCallback(() => {
    setMsg(''); setErr('');
    if (!bytes) {setErr('No RFHUB dump loaded.'); return;}
    if (!newVin.trim()) {setErr('Enter a new VIN before patching.'); return;}
    try {
      const result = patchRfhubVin(bytes, newVin.trim());
      const fname = baseName + '_vinPatch.bin';
      dl(result, fname);
      setPatched({bytes: result, filename: fname});
      setMsg('Patched ' + analysis.slots.filter(s => !s.blank).length + ' VIN slot(s) → ' + newVin.toUpperCase() + ' — downloaded as ' + fname + '.');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, [bytes, newVin, baseName, analysis]);

  const onPushBack = useCallback(() => {
    if (!patched || typeof onPatched !== 'function') return;
    onPatched(patched.bytes, patched.filename);
    setPatched(null);
    setErr('');
    setMsg('Patched dump added to workspace — re-analyzing in place.');
  }, [patched, onPatched]);

  if (!bytes || !analysis) return null;

  const isXc = analysis.xc2268;
  const isUnknown = !analysis.generation;
  const canPatch = !isXc && !isUnknown && bytes;

  // Header badge: generation + MCU label
  const genColor = analysis.generation === 'gen2' ? C.a2 : analysis.generation === 'gen1' ? C.a4 : C.wn;

  return (
    <div data-testid="rfhub-vin-patcher-panel" style={{marginTop: 16}}>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <Card style={{marginBottom: 14, borderTop: '3px solid ' + C.sr}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8}}>
          <div>
            <div style={{fontFamily: "'Righteous'", fontSize: 18, color: C.sr, letterSpacing: 1}}>
              RFHUB OFFLINE VIN PATCHER
            </div>
            <div style={{fontSize: 10, color: C.tm, letterSpacing: 1, fontWeight: 700, marginTop: 2}}>
              OFFLINE DUMP · NO OBD NEEDED · ANALYZE · PATCH · DOWNLOAD
            </div>
          </div>
          <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{
              fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 8,
              background: genColor + '18', color: genColor, fontFamily: mono,
            }}>
              {analysis.mcuLabel}
            </span>
            {isXc && (
              <span style={{
                fontSize: 10, fontWeight: 800, padding: '4px 10px', borderRadius: 8,
                background: C.wn + '18', color: C.wn, fontFamily: mono,
              }}>
                INSPECT ONLY
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ── XC2268 notice ─────────────────────────────────────────────── */}
      {isXc && (
        <Card style={{marginBottom: 14, borderLeft: '3px solid ' + C.wn}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 6, letterSpacing: 2}}>
            XC2268 INTERNAL-FLASH RFHUB — INSPECT ONLY
          </div>
          <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
            XC2268 offline VIN patching uses a dedicated code path (patchXc2268Vin)
            that is not yet surfaced in this panel. Use the live OBD write path above
            to update this module's VIN over UDS.
          </div>
        </Card>
      )}

      {/* ── Error for non-canonical buffer ───────────────────────────── */}
      {isUnknown && analysis.error && (
        <Card style={{marginBottom: 14, borderLeft: '3px solid ' + C.er}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.er, marginBottom: 6, letterSpacing: 2}}>
            UNSUPPORTED IMAGE
          </div>
          <div style={{fontSize: 11, color: C.ts}}>{analysis.error}</div>
        </Card>
      )}

      {/* ── VIN slots table ───────────────────────────────────────────── */}
      {analysis.slots.length > 0 && (
        <Card style={{marginBottom: 14}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>
            VIN SLOTS
          </div>
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
                      {slot.blank ? '—' : slot.csFormat === 'CRC-16 BE'
                        ? '0x' + slot.storedCs.toString(16).toUpperCase().padStart(4, '0')
                        : '0x' + slot.storedCs.toString(16).toUpperCase().padStart(2, '0')}
                    </td>
                    <td style={{padding: '6px 8px', color: C.tm}}>
                      {slot.blank ? '—' : slot.csFormat === 'CRC-16 BE'
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
              CS magic: 0x{analysis.magic.toString(16).toUpperCase().padStart(2, '0')}
              {' '}(auto-detected from first non-blank slot)
            </div>
          )}
        </Card>
      )}

      {/* ── Edit & Download ───────────────────────────────────────────── */}
      {canPatch && (
        <Card style={{marginBottom: 14}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>
            PATCH VIN & DOWNLOAD
          </div>
          <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
            Writes the new VIN into every slot and recomputes all checksums.
            The original file is not modified — a new patched .bin is downloaded.
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
              <div style={{marginTop: 4, fontSize: 10, color: C.gn, fontWeight: 700}}>
                ✓ VIN format valid
              </div>
            )}
          </div>

          <div style={{marginTop: 12}}>
            <Btn
              data-testid="rfhub-vin-patcher-patch-btn"
              color={C.sr}
              full
              onClick={onPatch}
              disabled={!vinInputValid}
            >
              PATCH VIN &amp; DOWNLOAD
            </Btn>
          </div>
        </Card>
      )}

      {/* ── Push-back to workspace ────────────────────────────────────── */}
      {patched && typeof onPatched === 'function' && (
        <Card style={{marginBottom: 14, borderLeft: '3px solid ' + C.gn}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.gn, marginBottom: 4, letterSpacing: 2}}>
            SAVE BACK TO WORKSPACE
          </div>
          <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
            Add the patched bytes into the shared workspace as a new RFHUB dump and
            re-analyze it here in place — no manual reload. The download above is still saved to disk.
          </div>
          <Btn
            color={C.gn}
            full
            onClick={onPushBack}
            data-testid="rfhub-vin-patcher-pushback-btn"
          >
            ADD PATCHED DUMP TO WORKSPACE &amp; RE-ANALYZE
          </Btn>
        </Card>
      )}

      {/* ── Status bar ───────────────────────────────────────────────── */}
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
  );
}
