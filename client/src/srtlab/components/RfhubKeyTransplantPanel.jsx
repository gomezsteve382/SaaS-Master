/**
 * RfhubKeyTransplantPanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Gen2 RFHUB key transplant panel.
 *
 * BENCH-VERIFIED algorithm:
 *   1. Copy auth sector 0x0100-0x027F from donor to target (required for keys
 *      to actually start the car — ring buffer alone is not sufficient).
 *   2. Append donor ring buffer entries to target ring buffer.
 *
 * Features:
 *   - Dual file drop zones (donor / target)
 *   - Master Transponder display (0x0226, 16 bytes, platform constant)
 *   - Autel ID display (chip ID bytes reversed = Autel display format)
 *   - Human-readable flag labels (Black Key / Red Key / Standard / Alt Family)
 *   - Auth sector copy toggle (on by default — required for keys to work)
 *   - Key selection (inject all or pick individual keys)
 *   - Capacity check (ring buffer free slots)
 *   - Download patched target
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useCallback, useRef } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import {
  parseKeyRingBuffer,
  findWritePointer,
  countFreeSlots,
  transplantKeys,
  validateRfhubBuffer,
  readMasterTransponder,
  readAuthKeyCount,
  flagInfo,
  KEY_SLOT_COUNT,
} from '../lib/rfhubKeyTransplant.js';
import { identifyModule } from '../lib/keyProgWizard.js';

/* ─── RFHUB type detector ─────────────────────────────────────────────────── */
function detectRfhubType(buf, filename) {
  try {
    const id = identifyModule(buf, filename || 'unknown.bin');
    if (!id || id.role !== 'RFH') return { label: 'UNKNOWN TYPE', color: '#FF5252', detail: 'Not recognized as RFHUB' };
    const t = id.info?.type || '';
    if (t === 'XC2268_RFHUB') return { label: 'XC2268 RFHUB', color: '#FF9800', detail: '64KB internal flash · 2019+ Ram' };
    if (t === 'RFHUB')        return { label: 'MC9S12 RFHUB', color: '#00E676', detail: '4KB EEPROM · Gen2 Charger/Challenger/Durango' };
    return { label: t || 'RFHUB', color: '#00E676', detail: '' };
  } catch {
    // validateRfhubBuffer will catch the real error; just show unknown here
    return { label: 'UNKNOWN TYPE', color: '#FF5252', detail: 'Parse error' };
  }
}

/* ─── tiny helpers ─────────────────────────────────────────────────────────── */
function readFileAsUint8Array(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = e => resolve(new Uint8Array(e.target.result));
    fr.onerror = () => reject(new Error('File read error'));
    fr.readAsArrayBuffer(file);
  });
}

function downloadBin(buf, filename) {
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── FlagBadge ────────────────────────────────────────────────────────────── */
function FlagBadge({ flag, showSub = false }) {
  const info  = flagInfo(flag);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <span style={{
        display: 'inline-block', padding: '1px 7px', borderRadius: 4,
        background: info.color + '22', color: info.color,
        border: `1px solid ${info.color}55`,
        fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
        fontFamily: "'JetBrains Mono'", whiteSpace: 'nowrap',
      }}>{info.label}</span>
      {showSub && (
        <span style={{ fontSize: 8, color: info.color + 'AA', marginTop: 1, paddingLeft: 2 }}>
          {info.sub}
        </span>
      )}
    </span>
  );
}

/* ─── KeyRow ───────────────────────────────────────────────────────────────── */
function KeyRow({ entry, selected, onToggle, disabled, dimmed }) {
  return (
    <div
      onClick={() => !disabled && onToggle(entry.chipId)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
        borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
        background: selected ? C.ac + '18' : 'transparent',
        border: `1px solid ${selected ? C.ac + '55' : 'transparent'}`,
        opacity: dimmed ? 0.45 : 1,
        transition: 'background 150ms, opacity 150ms',
      }}
    >
      <input
        type="checkbox" checked={selected} readOnly
        style={{ accentColor: C.ac, cursor: disabled ? 'default' : 'pointer' }}
      />
      {/* Autel ID column */}
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, letterSpacing: 1, minWidth: 72 }}>
        {entry.autelId}
      </span>
      <FlagBadge flag={entry.flag} showSub />
      <span style={{ fontSize: 9, color: C.ts, marginLeft: 'auto' }}>
        cnt={entry.count}
      </span>
    </div>
  );
}

/* ─── TargetKeyRow (read-only, with FlagBadge) ─────────────────────────────── */
function TargetKeyRow({ entry }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
      borderRadius: 6, background: C.cd, border: `1px solid ${C.bd}`,
    }}>
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts, letterSpacing: 1, minWidth: 72 }}>
        {entry.autelId}
      </span>
      <FlagBadge flag={entry.flag} showSub />
    </div>
  );
}

/* ─── MasterTransponderRow ─────────────────────────────────────────────────── */
function MasterTransponderRow({ mt }) {
  if (!mt) return null;
  return (
    <div style={{
      background: '#1A237E18', border: '1px solid #3949AB55',
      borderRadius: 6, padding: '6px 10px', marginBottom: 10,
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: '#7986CB', letterSpacing: 1, marginBottom: 3 }}>
        MASTER TRANSPONDER @ 0x0226
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono'", fontSize: 10, color: mt.virgin ? '#9E9E9E' : '#7986CB',
        letterSpacing: 0.5, wordBreak: 'break-all',
      }}>
        {mt.virgin ? '(virgin — FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF)' : mt.hex}
      </div>
      {mt.virgin && (
        <div style={{ fontSize: 8, color: '#9E9E9E', marginTop: 2, fontStyle: 'italic' }}>
          Module has never been enrolled — no Master Transponder set
        </div>
      )}
    </div>
  );
}

/* ─── AuthSectorInfo ───────────────────────────────────────────────────────── */
function AuthSectorInfo({ buf, label, color }) {
  if (!buf) return null;
  const count = readAuthKeyCount(buf);
  return (
    <div style={{ fontSize: 9, color, marginTop: 2 }}>
      Auth sector: {count} key{count !== 1 ? 's' : ''} enrolled
    </div>
  );
}

/* ─── main component ───────────────────────────────────────────────────────── */
export default function RfhubKeyTransplantPanel() {
  const [donor,    setDonor]    = useState(null);   // { buf, name, keys, writePtr, freeSlots, mt }
  const [target,   setTarget]   = useState(null);   // same shape
  const [selected, setSelected] = useState(new Set());
  const [copyAuth, setCopyAuth] = useState(true);   // copy auth sector (default: true)
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);
  const donorRef  = useRef();
  const targetRef = useRef();

  /* ── file loader ─────────────────────────────────────────────────────────── */
  const loadFile = useCallback(async (file, role) => {
    setError('');
    setResult(null);
    try {
      const buf = await readFileAsUint8Array(file);
      const v   = validateRfhubBuffer(buf);
      if (!v.ok) throw new Error(v.error);

      const keys      = parseKeyRingBuffer(buf);
      const writePtr  = findWritePointer(buf);
      const freeSlots = writePtr !== null ? countFreeSlots(buf, writePtr) : 0;
      const mt        = readMasterTransponder(buf);
      const rfhType   = detectRfhubType(buf, file.name);

      const info = { buf, name: file.name, keys, writePtr, freeSlots, mt, rfhType };
      if (role === 'donor') {
        setDonor(info);
        setSelected(new Set(keys.map(k => k.chipId)));
        setResult(null);
      } else {
        setTarget(info);
        setResult(null);
      }
    } catch (e) {
      setError(`${role === 'donor' ? 'Donor' : 'Target'} load error: ${e.message}`);
    }
  }, []);

  const onDonorDrop  = useCallback(e => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0] || e.target.files?.[0];
    if (f) loadFile(f, 'donor');
  }, [loadFile]);

  const onTargetDrop = useCallback(e => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0] || e.target.files?.[0];
    if (f) loadFile(f, 'target');
  }, [loadFile]);

  const toggleKey = useCallback(chipId => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(chipId) ? next.delete(chipId) : next.add(chipId);
      return next;
    });
  }, []);

  /* ── inject ──────────────────────────────────────────────────────────────── */
  const inject = useCallback(async () => {
    if (!donor || !target) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = transplantKeys(donor.buf, target.buf, {
        only: selected.size > 0 ? [...selected] : null,
        skipDuplicates: true,
        copyAuthSector: copyAuth,
      });
      setResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [donor, target, selected, copyAuth]);

  /* ── download ────────────────────────────────────────────────────────────── */
  const download = useCallback(() => {
    if (!result) return;
    const base = target.name.replace(/\.bin$/i, '');
    downloadBin(result.patched, `${base}_KEYS_TRANSPLANTED.bin`);
  }, [result, target]);

  /* ── drop zone ───────────────────────────────────────────────────────────── */
  function DropZone({ label, info, inputRef, onDrop, accent }) {
    return (
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          flex: 1, minWidth: 0, border: `2px dashed ${info ? accent : C.bd}`,
          borderRadius: 10, padding: '14px 12px', cursor: 'pointer',
          background: info ? accent + '0A' : C.cd,
          transition: 'border-color 200ms, background 200ms',
          textAlign: 'center',
        }}
      >
        <input ref={inputRef} type="file" accept=".bin" style={{ display: 'none' }} onChange={onDrop} />
        {info ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 800, color: accent, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 10, color: C.tx, fontFamily: "'JetBrains Mono'", marginBottom: 2 }}>{info.name}</div>
            {/* RFHUB type badge */}
            <div style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 4, marginBottom: 4,
              background: info.rfhType.color + '22', border: `1px solid ${info.rfhType.color}55`,
              fontSize: 8, fontWeight: 800, color: info.rfhType.color, letterSpacing: 0.5,
              fontFamily: "'JetBrains Mono'",
            }}>{info.rfhType.label}</div>
            {info.rfhType.detail ? (
              <div style={{ fontSize: 8, color: info.rfhType.color + 'AA', marginBottom: 2 }}>{info.rfhType.detail}</div>
            ) : null}
            <div style={{ fontSize: 9, color: C.ts }}>
              {info.keys.length} key{info.keys.length !== 1 ? 's' : ''} · {info.freeSlots} free slot{info.freeSlots !== 1 ? 's' : ''}
            </div>
            <AuthSectorInfo buf={info.buf} label={label} color={accent + 'AA'} />
          </>
        ) : (
          <>
            <div style={{ fontSize: 18, marginBottom: 4 }}>📂</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.ts }}>{label}</div>
            <div style={{ fontSize: 9, color: C.ts, marginTop: 2 }}>Drop .bin or click</div>
          </>
        )}
      </div>
    );
  }

  const targetChipIds = target ? new Set(target.keys.map(k => k.chipId)) : new Set();

  /* ── render ──────────────────────────────────────────────────────────────── */
  return (
    <Card style={{ marginBottom: 14 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>🔑</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 12, color: C.ac, letterSpacing: 2 }}>
            KEY TRANSPLANT
          </div>
          <div style={{ fontSize: 9, color: C.ts, marginTop: 1 }}>
            Copy keys from donor RFHUB → target RFHUB (offline · no OBD · bench-verified)
          </div>
        </div>
      </div>

      {/* drop zones */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <DropZone label="DONOR RFHUB"  info={donor}  inputRef={donorRef}  onDrop={onDonorDrop}  accent={C.gn} />
        <DropZone label="TARGET RFHUB" info={target} inputRef={targetRef} onDrop={onTargetDrop} accent={C.ac} />
      </div>

      {/* Master Transponder — show for both files if loaded */}
      {(donor || target) && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 4 }}>
          {donor  && <div style={{ flex: 1 }}><MasterTransponderRow mt={donor.mt}  /></div>}
          {target && <div style={{ flex: 1 }}><MasterTransponderRow mt={target.mt} /></div>}
        </div>
      )}

      {/* donor key list */}
      {donor && donor.keys.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.ts, marginBottom: 6, letterSpacing: 1 }}>
            DONOR KEYS — select to inject
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {donor.keys.map(entry => {
              const alreadyInTarget = targetChipIds.has(entry.chipId);
              return (
                <div key={entry.chipId} style={{ position: 'relative' }}>
                  <KeyRow
                    entry={entry}
                    selected={selected.has(entry.chipId)}
                    onToggle={toggleKey}
                    disabled={alreadyInTarget}
                    dimmed={alreadyInTarget}
                  />
                  {alreadyInTarget && (
                    <span style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 9, color: C.ts, fontStyle: 'italic', pointerEvents: 'none',
                    }}>already in target</span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <span
              style={{ fontSize: 9, color: C.ac, cursor: 'pointer', fontWeight: 700 }}
              onClick={() => setSelected(new Set(donor.keys.map(k => k.chipId)))}
            >SELECT ALL</span>
            <span
              style={{ fontSize: 9, color: C.ts, cursor: 'pointer' }}
              onClick={() => setSelected(new Set())}
            >CLEAR</span>
          </div>
        </div>
      )}

      {donor && donor.keys.length === 0 && (
        <div style={{ fontSize: 10, color: C.ts, marginBottom: 12, fontStyle: 'italic' }}>
          No programmed keys found in donor RFHUB.
        </div>
      )}

      {/* target current keys (read-only, with FlagBadge) */}
      {target && target.keys.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
            TARGET CURRENT KEYS ({target.keys.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {target.keys.map(k => <TargetKeyRow key={k.chipId} entry={k} />)}
          </div>
        </div>
      )}

      {/* auth sector copy toggle */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10,
        background: copyAuth ? '#00E67608' : '#FF525208',
        border: `1px solid ${copyAuth ? '#00E67633' : '#FF525233'}`,
        borderRadius: 8, padding: '8px 10px',
      }}>
        <input
          type="checkbox" checked={copyAuth}
          onChange={e => setCopyAuth(e.target.checked)}
          style={{ accentColor: copyAuth ? '#00E676' : '#FF5252', marginTop: 2, cursor: 'pointer' }}
        />
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: copyAuth ? '#00E676' : '#FF5252' }}>
            {copyAuth ? '✓ Copy Hitag AES Auth Sector (RECOMMENDED)' : '⚠ Ring Buffer Only (keys may not start car)'}
          </div>
          <div style={{ fontSize: 9, color: C.ts, marginTop: 2 }}>
            {copyAuth
              ? 'Copies auth sector 0x0100–0x027F from donor to target. Required for keys to authenticate with the BCM. Bench-verified byte-identical to Autel-programmed output.'
              : 'Only appends ring buffer entries. Use only if target already has a compatible auth sector (same vehicle, same key set).'}
          </div>
        </div>
      </div>

      {/* capacity + key count overflow warning */}
      {target && donor && selected.size > 0 && (() => {
        const slotsNeeded   = selected.size * 2;
        const freeSlots     = target.freeSlots;
        const targetKeyCount = target.keys.length;
        const donorSelected  = selected.size;
        const combinedCount  = targetKeyCount + donorSelected;
        const warnings = [];

        if (slotsNeeded > freeSlots) {
          warnings.push(`⚠️ Ring buffer: need ${slotsNeeded} slots for ${donorSelected} key${donorSelected !== 1 ? 's' : ''} (×2 each), but only ${freeSlots} free in target.`);
        }
        if (combinedCount > KEY_SLOT_COUNT / 2) {
          warnings.push(`⚠️ Key count overflow: target has ${targetKeyCount} key${targetKeyCount !== 1 ? 's' : ''}, adding ${donorSelected} more = ${combinedCount} total. Module supports max ${KEY_SLOT_COUNT / 2} keys. Oldest entries may be overwritten.`);
        }

        if (warnings.length === 0) return null;
        return (
          <div style={{
            background: '#FF525222', border: `1px solid #FF5252`, borderRadius: 6,
            padding: '8px 10px', fontSize: 10, color: '#FF5252', marginBottom: 10,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        );
      })()}

      {/* inject button */}
      <Btn
        onClick={inject}
        disabled={!donor || !target || selected.size === 0 || busy}
        color={C.gn}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {busy ? 'INJECTING…' : `INJECT ${selected.size} KEY${selected.size !== 1 ? 'S' : ''} INTO TARGET`}
      </Btn>

      {/* error */}
      {error && (
        <div style={{
          background: '#FF525218', border: `1px solid #FF5252`, borderRadius: 6,
          padding: '6px 10px', fontSize: 10, color: '#FF5252', marginBottom: 8,
        }}>{error}</div>
      )}

      {/* result */}
      {result && (
        <div style={{
          background: '#00E67618', border: `1px solid #00E676`, borderRadius: 8,
          padding: '10px 12px', marginBottom: 8,
        }}>
          <div style={{ fontWeight: 800, fontSize: 11, color: '#00E676', marginBottom: 6 }}>
            ✓ TRANSPLANT COMPLETE
          </div>
          {result.authSectorCopied && (
            <div style={{ fontSize: 9, color: '#69F0AE', marginBottom: 6, fontWeight: 700 }}>
              ✓ Auth sector (0x0100–0x027F) copied from donor — keys will authenticate with BCM
            </div>
          )}
          <div style={{ fontSize: 10, color: '#00E676', marginBottom: 4 }}>
            Injected {result.injected.length} key{result.injected.length !== 1 ? 's' : ''}:
          </div>
          {result.injected.map(k => (
            <div key={k.chipId} style={{
              fontFamily: "'JetBrains Mono'", fontSize: 10, color: '#00E676',
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
            }}>
              <span>↳ {k.autelId}</span>
              <FlagBadge flag={k.flag} showSub />
            </div>
          ))}
          {result.skipped.length > 0 && (
            <div style={{ fontSize: 9, color: C.ts, marginTop: 4 }}>
              Skipped: {result.skipped.map(s => `${s.chipId} (${s.reason})`).join(', ')}
            </div>
          )}
          <Btn onClick={download} color={C.ac} style={{ marginTop: 10, width: '100%' }}>
            ⬇ DOWNLOAD PATCHED TARGET
          </Btn>
        </div>
      )}

      {/* capacity info footer */}
      {target && (
        <div style={{ fontSize: 9, color: C.ts, marginTop: 4, textAlign: 'right' }}>
          Ring buffer: {KEY_SLOT_COUNT} slots total · {target.freeSlots} free · write ptr 0x{(target.writePtr ?? 0).toString(16).toUpperCase().padStart(4,'0')}
        </div>
      )}
    </Card>
  );
}
