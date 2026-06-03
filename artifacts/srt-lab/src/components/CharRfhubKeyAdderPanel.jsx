/**
 * CharRfhubKeyAdderPanel — offline transponder-key adder for MPC-based
 * Charger/Challenger RFHUB 4 KB dumps (8-slot key table @0xC5E).
 *
 * Self-contained: own file picker + collapsible toggle. No live OBD needed.
 * Writes a new key record (UID byte-reversed + index + flag) into a free slot
 * and downloads a patched .bin. The original file is never modified.
 *
 * EXPERIMENTAL: the per-key index byte is firmware-assigned and unverified —
 * see charRfhubKeyTable.js header. Worst case is the car ignores the new key
 * (other keys keep working; reflash the original). It cannot brick the
 * immobilizer: SEC16 and checksums are untouched.
 *
 * Visual style matches RfhubVinPatcherPanel / ImmoChecksumPanel.
 */

import React, {useMemo, useState, useCallback, useEffect, useRef} from 'react';
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {
  parseCharKeyTable,
  isCharRfhubKeyTable,
  addCharKey,
  deriveCharKeyIndex,
  CHAR_KEY_DEFAULT_INDEX,
} from '../lib/charRfhubKeyTable.js';
import {parseCharAuxTable, CHAR_AUX_BASE, CHAR_AUX_END, CHAR_AUX_CHECKSUM_TARGET} from '../lib/charRfhubAuxTable.js';
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

const hex2 = n => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
const hexOff = n => '0x' + (n ?? 0).toString(16).toUpperCase();

export default function CharRfhubKeyAdderPanel({initialMod = null, onPatched = null}) {
  const [open, setOpen] = useState(false);
  const [bytes, setBytes] = useState(null);
  const [filename, setFilename] = useState('');
  const fileInputRef = useRef(null);

  const [keyId, setKeyId] = useState('');
  const [indexHex, setIndexHex] = useState('');
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [patched, setPatched] = useState(null);

  // Seed from the inspector above, only if it's a Charger key-table dump and
  // we haven't loaded our own file yet.
  useEffect(() => {
    if (initialMod && initialMod.data && !bytes && isCharRfhubKeyTable(initialMod.data)) {
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
    e.target.value = '';
  }, []);

  const onClearFile = useCallback(() => {
    setBytes(null); setFilename('');
    setMsg(''); setErr(''); setPatched(null);
  }, []);

  const analysis = useMemo(() => (bytes ? parseCharKeyTable(bytes) : null), [bytes]);
  const auxAnalysis = useMemo(() => (bytes ? parseCharAuxTable(bytes) : null), [bytes]);
  const baseName = filename.replace(/\.[^.]+$/, '') || 'rfhub';

  const keyIdValid = /^[0-9a-fA-F]{8}$/.test(keyId.trim());
  const indexVal = useMemo(() => {
    const v = parseInt(indexHex, 16);
    return Number.isInteger(v) && v >= 0 && v <= 0xFF ? v : null;
  }, [indexHex]);

  // The correct index is derived from the Key ID (mod-255 checksum). Auto-fill
  // the field whenever a valid Key ID is entered; the operator may still type
  // over it for a bench override.
  const derivedIndex = useMemo(
    () => (keyIdValid ? deriveCharKeyIndex(keyId.trim()) : null),
    [keyIdValid, keyId],
  );
  useEffect(() => {
    if (derivedIndex != null) {
      setIndexHex(derivedIndex.toString(16).toUpperCase().padStart(2, '0'));
    }
  }, [derivedIndex]);
  const indexOverridden = derivedIndex != null && indexVal != null && indexVal !== derivedIndex;

  const freeSlots = analysis?.ok ? analysis.slots.filter(s => s.empty).length : 0;
  const tableOk = !!analysis?.ok;
  const canAdd = tableOk && keyIdValid && indexVal != null && ack && freeSlots > 0;

  const onAdd = useCallback(() => {
    setMsg(''); setErr('');
    if (!bytes) { setErr('No RFHUB dump loaded.'); return; }
    // Only pass indexLow when the operator overrode the auto-filled value;
    // otherwise let addCharKey derive it so indexDerived is reported truthfully.
    const r = addCharKey(bytes, {
      keyId: keyId.trim(),
      ...(indexOverridden ? { indexLow: indexVal } : {}),
    });
    if (!r.ok) { setErr(r.error); return; }
    const fname = baseName + '_KEY_' + r.keyId + '_ADDED.bin';
    dl(r.bytes, fname);
    setPatched({bytes: r.bytes, filename: fname});
    setMsg(
      'Added key ' + r.keyId + ' to slot ' + r.slot + ' (index ' + hex2(r.indexLow) + ') at '
      + hexOff(r.offset) + ' + mirror ' + hexOff(r.mirrorOffset) + '. '
      + r.keyCountAfter + ' keys now present. Downloaded as ' + fname + '.'
    );
  }, [bytes, keyId, indexVal, indexOverridden, baseName]);

  const onPushBack = useCallback(() => {
    if (!patched || typeof onPatched !== 'function') return;
    onPatched(patched.bytes, patched.filename);
    setPatched(null); setErr('');
    setMsg('Patched dump added to workspace — re-analyzing in place.');
  }, [patched, onPatched]);

  const headerSummary = !analysis ? (bytes ? 'Loading…' : 'No file loaded')
    : analysis.ok ? (analysis.keyCount + ' key(s) · ' + freeSlots + ' free slot(s)')
    : 'Not a Charger key table';
  const headColor = !analysis ? C.tm : analysis.ok ? C.a2 : C.wn;

  return (
    <div data-testid="char-rfhub-key-adder-panel">
      <Card
        style={{marginBottom: open ? 0 : 14, borderRadius: open ? '10px 10px 0 0' : 10, cursor: 'pointer'}}
        onClick={() => setOpen(o => !o)}
        data-testid="char-rfhub-key-adder-toggle"
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15, color: C.sr, letterSpacing: 1, whiteSpace: 'nowrap'}}>
              OFFLINE KEY ADDER (CHARGER RFHUB)
            </div>
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6,
              background: headColor + '18', color: headColor, fontFamily: mono, whiteSpace: 'nowrap',
            }}>
              {headerSummary}
            </span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0}}>
            <span style={{fontSize: 10, color: C.tm, fontWeight: 700}}>NO OBD NEEDED</span>
            <span style={{fontSize: 14, color: C.ts, transition: 'transform .2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)'}}>▶</span>
          </div>
        </div>
      </Card>

      {open && (
        <div style={{border: '1px solid ' + C.bd, borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 14, background: C.bg, marginBottom: 14}}>

          {/* Experimental banner */}
          <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.wn}}>
            <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 6, letterSpacing: 2}}>
              EXPERIMENTAL — NOT BENCH-VERIFIED ON A REAL CAR
            </div>
            <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
              Adds a transponder key by editing the 8-slot key table at 0xC5E. The byte layout (UID, mirror, flag) is
              confirmed against real dumps, and no checksum covers this region, so the edit <strong>cannot brick the
              module</strong> — SEC16 and checksums are untouched and your original file is never modified. The per-key
              <strong> index byte is now computed</strong> from the Key ID (mod-255 checksum, verified against all six
              known keys), replacing the old {hex2(CHAR_KEY_DEFAULT_INDEX)} placeholder. Two things are still
              <strong> not proven</strong>, so a written key <strong>may not yet be read by the car</strong>:
            </div>
            <ul style={{fontSize: 11, color: C.ts, lineHeight: 1.6, margin: '6px 0 0', paddingLeft: 18}}>
              <li><strong>Slot placement</strong> is unproven — real cars fill slots 3-8 and leave 1-2 empty, so a key written into an early free slot may be ignored.</li>
              <li>A <strong>companion table</strong> elsewhere in the EEPROM may also need a matching entry that this tool does not write.</li>
            </ul>
            <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6, marginTop: 6}}>
              Worst case is fully reversible: reflash the original and your existing keys keep working.
              <strong> Keep your original dump as the restore file.</strong>
            </div>
          </Card>

          {/* File picker */}
          <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14}}>
            <label style={{padding: '8px 14px', borderRadius: 8, border: '2px dashed ' + C.sr + '50', background: C.c2, cursor: 'pointer', fontSize: 11, fontWeight: 800, color: C.sr}}>
              Load RFHUB .bin
              <input ref={fileInputRef} type="file" accept=".bin,.BIN,.eep,.EEP" hidden data-testid="char-rfhub-key-adder-file-input" onChange={onFileChange} />
            </label>
            {bytes && (
              <>
                <span style={{fontFamily: mono, fontSize: 10, color: C.ts}}>{filename} · {(bytes.length / 1024).toFixed(1)} KB</span>
                <button onClick={e => {e.stopPropagation(); onClearFile();}} style={{border: 'none', background: 'transparent', color: C.tm, cursor: 'pointer', fontSize: 12}} title="Clear loaded file">✕</button>
              </>
            )}
          </div>

          {!bytes && (
            <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic', paddingBottom: 6}}>
              Load a 4 KB MPC-Charger RFHUB .bin to inspect its 8-slot key table and add a transponder key offline.
            </div>
          )}

          {/* Unsupported image */}
          {analysis && !analysis.ok && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.er}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.er, marginBottom: 4, letterSpacing: 2}}>KEY TABLE NOT FOUND</div>
              <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
                {analysis.error}. This tool only supports the MPC Charger/Challenger 8-slot table at 0xC5E. For
                FreshAuto Gen1/Gen2 RFHUBs use the Key Manager flow instead.
              </div>
            </Card>
          )}

          {/* Key table */}
          {analysis && analysis.ok && (
            <Card style={{marginBottom: 12}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>KEY TABLE — 8 SLOTS @0xC5E</div>
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11}}>
                  <thead>
                    <tr style={{textAlign: 'left', color: C.ts, borderBottom: '1px solid ' + C.bd}}>
                      <th style={{padding: '6px 8px'}}>Slot</th>
                      <th style={{padding: '6px 8px'}}>Offset</th>
                      <th style={{padding: '6px 8px'}}>Key ID</th>
                      <th style={{padding: '6px 8px'}}>Index</th>
                      <th style={{padding: '6px 8px'}}>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.slots.map(s => {
                      const badge = s.state === 'empty' ? {t: 'FREE', c: C.tm}
                        : s.state === 'unknown' ? {t: 'UNKNOWN', c: C.wn}
                        : s.keyKind === 'alt' ? {t: 'KEY · ALT', c: C.wn}
                        : {t: 'KEY', c: C.gn};
                      return (
                      <tr key={s.slot} data-testid={'char-key-slot-' + s.slot} style={{borderBottom: '1px solid ' + C.bd, fontFamily: mono}}>
                        <td style={{padding: '6px 8px', color: C.ts}}>{s.slot}</td>
                        <td style={{padding: '6px 8px', color: C.tm}}>{hexOff(s.offset)}</td>
                        <td style={{padding: '6px 8px', fontWeight: 700, color: s.empty ? C.tm : C.tx}}>
                          {s.empty ? <span style={{fontStyle: 'italic'}}>empty</span> : s.keyId}
                        </td>
                        <td style={{padding: '6px 8px', color: C.tm}}>{s.empty ? '—' : hex2(s.indexLow)}</td>
                        <td style={{padding: '6px 8px'}}>
                          <span style={{fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: badge.c + '18', color: badge.c, fontFamily: mono}}>
                            {badge.t}
                          </span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Second mirrored-record table (read-only). NOT RKE fobs — fixed
            * 17-record parameter/calibration block; meaning unverified. See
            * charRfhubAuxTable.js header. */}
          {auxAnalysis && auxAnalysis.ok && (
            <Card style={{marginBottom: 12}} data-testid="char-aux-table-card">
              <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 4, letterSpacing: 2}}>
                SECOND TABLE — {auxAnalysis.count} MIRRORED RECORDS @{hexOff(CHAR_AUX_BASE)}…{hexOff(CHAR_AUX_END)}
              </div>
              <div style={{fontSize: 10, color: C.ts, lineHeight: 1.6, marginBottom: 10}}>
                A fixed run of {auxAnalysis.count} ten-byte mirrored records that sits right after the key table.
                Read-only and shown raw on purpose: the record <strong>count is fixed at {auxAnalysis.count} regardless
                of how many keys the car has</strong>, and several records are byte-identical across different vehicles —
                so despite its position this is <strong>not</strong> the RKE/remote-fob list, but a parameter/calibration
                block whose field meanings are <strong>not bench-verified</strong>. SRT Lab refuses to label or edit it.
              </div>
              <div style={{fontSize: 10, color: C.tm, lineHeight: 1.6, marginBottom: 10}}>
                One field <strong>is</strong> now cracked: <strong>byte 8 is a ones'-complement checksum</strong> over
                the other nine bytes (the end-around-carry sum of all ten bytes folds to {hex2(CHAR_AUX_CHECKSUM_TARGET)}).
                Verified byte-exact across the 4-vehicle corpus, so the <strong>CS</strong> column below shows whether
                each record's checksum is intact. This is the only labelled field — everything else stays raw and
                read-only until a bench capture proves its meaning.
              </div>
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11}}>
                  <thead>
                    <tr style={{textAlign: 'left', color: C.ts, borderBottom: '1px solid ' + C.bd}}>
                      <th style={{padding: '6px 8px'}}>#</th>
                      <th style={{padding: '6px 8px'}}>Offset</th>
                      <th style={{padding: '6px 8px'}}>Record (10 bytes)</th>
                      <th style={{padding: '6px 8px'}} title="byte 8 ones'-complement checksum (folds all ten bytes to 0xFE)">CS</th>
                      <th style={{padding: '6px 8px'}}>Mirror</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auxAnalysis.records.map(r => (
                      <tr key={r.index} data-testid={'char-aux-rec-' + r.index} style={{borderBottom: '1px solid ' + C.bd, fontFamily: mono}}>
                        <td style={{padding: '6px 8px', color: C.ts}}>{r.index}</td>
                        <td style={{padding: '6px 8px', color: C.tm}}>{hexOff(r.offset)}</td>
                        <td style={{padding: '6px 8px', color: C.tx, whiteSpace: 'nowrap'}}>{r.hex}</td>
                        <td style={{padding: '6px 8px'}} data-testid={'char-aux-cs-' + r.index}>
                          <span style={{fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: (r.checksumOk ? C.gn : C.er) + '18', color: r.checksumOk ? C.gn : C.er, fontFamily: mono}}>
                            {r.checksumOk ? 'OK' : 'BAD'}
                          </span>
                        </td>
                        <td style={{padding: '6px 8px'}}>
                          <span style={{fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: (r.mirrorOk ? C.gn : C.er) + '18', color: r.mirrorOk ? C.gn : C.er, fontFamily: mono}}>
                            {r.mirrorOk ? 'OK' : 'BAD'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Add key form */}
          {analysis && analysis.ok && (
            <Card style={{marginBottom: 12}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>ADD KEY &amp; DOWNLOAD</div>
              {freeSlots === 0 && (
                <div style={{fontSize: 11, color: C.er, fontWeight: 700, marginBottom: 10}}>
                  Key table is full (8/8). Delete an existing key on the bench before adding a new one.
                </div>
              )}
              <div style={{display: 'flex', gap: 12, flexWrap: 'wrap'}}>
                <div style={{flex: '1 1 200px'}}>
                  <div style={labelStyle}>Autel Key ID (8 hex / 4 bytes)</div>
                  <input
                    data-testid="char-key-id-input"
                    value={keyId}
                    onChange={e => setKeyId(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8))}
                    placeholder="e.g. BCD2EB9B"
                    style={{...inputStyle, borderColor: keyId ? (keyIdValid ? C.gn : C.er) : C.bd}}
                  />
                  <div style={{marginTop: 4, fontSize: 10, color: C.tm, fontFamily: mono}}>
                    {keyIdValid ? 'stored as ' + Array.from(keyId.match(/../g)).reverse().join(' ') : 'as shown on the Autel key read'}
                  </div>
                </div>
                <div style={{flex: '0 0 120px'}}>
                  <div style={labelStyle}>Index byte (hex)</div>
                  <input
                    data-testid="char-key-index-input"
                    value={indexHex}
                    onChange={e => setIndexHex(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2))}
                    placeholder={derivedIndex != null ? hex2(derivedIndex).slice(2) : ''}
                    style={{...inputStyle, borderColor: indexVal != null ? C.bd : C.er}}
                  />
                  <div style={{marginTop: 4, fontSize: 10, color: indexOverridden ? C.er : C.tm}}>
                    {derivedIndex != null
                      ? (indexOverridden ? 'override (derived ' + hex2(derivedIndex) + ')' : 'derived ' + hex2(derivedIndex))
                      : 'auto-derived from Key ID'}
                  </div>
                </div>
              </div>

              <label style={{display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: C.er, fontWeight: 700, cursor: 'pointer', marginTop: 12}}>
                <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="char-key-ack" style={{marginTop: 2}} />
                I have a backup of the original RFHUB dump and understand this key-add is unverified on a real car.
              </label>

              <div style={{marginTop: 12}}>
                <Btn data-testid="char-key-add-btn" color={C.sr} full onClick={onAdd} disabled={!canAdd}>
                  ADD KEY &amp; DOWNLOAD
                </Btn>
              </div>
            </Card>
          )}

          {/* Push-back */}
          {patched && typeof onPatched === 'function' && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.gn}}>
              <div style={{fontWeight: 800, fontSize: 11, color: C.gn, marginBottom: 4, letterSpacing: 2}}>SAVE BACK TO WORKSPACE</div>
              <div style={{fontSize: 10, color: C.tm, marginBottom: 10}}>
                Add the patched bytes into the shared workspace as a new RFHUB dump and re-analyze in place. The download above is still saved to disk.
              </div>
              <Btn color={C.gn} full onClick={onPushBack} data-testid="char-key-pushback-btn">
                ADD PATCHED DUMP TO WORKSPACE &amp; RE-ANALYZE
              </Btn>
            </Card>
          )}

          {(msg || err) && (
            <div
              data-testid="char-rfhub-key-adder-status"
              style={{
                padding: '10px 14px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-wrap',
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
