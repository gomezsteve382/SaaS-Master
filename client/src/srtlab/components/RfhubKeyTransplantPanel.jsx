/**
 * RfhubKeyTransplantPanel.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Offline key transplant: extract key ring-buffer entries from a donor RFHUB
 * and inject them into a target RFHUB — no OBD connection required.
 *
 * Bench-verified format (Gen2 / XC2268 / 95640):
 *   Ring buffer base 0x0C80, 8-byte slots, empty = 5A 5A 5A 5A 95 00 FF FF
 *   Each key stored twice consecutively.
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
  KEY_SLOT_COUNT,
} from '../lib/rfhubKeyTransplant.js';

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

// Human-readable flag labels (bench-verified against real RFHUB dumps)
const FLAG_INFO = {
  0xE6: { label: 'Black Key',    sub: 'Hitag AES',    color: '#607D8B' },
  0x48: { label: 'Red Key',     sub: 'Hitag AES',    color: '#E53935' },
  0x01: { label: 'Standard',    sub: 'Hitag2',       color: '#42A5F5' },
  0x03: { label: 'Alt Family',  sub: 'Hitag2',       color: '#AB47BC' },
};

function FlagBadge({ flag, showSub = false }) {
  const info  = FLAG_INFO[flag];
  const label = info ? info.label : `Flag 0x${flag.toString(16).toUpperCase().padStart(2,'0')}`;
  const sub   = info ? info.sub   : 'Unknown';
  const color = info ? info.color : '#9E9E9E';
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <span style={{
        display: 'inline-block', padding: '1px 7px', borderRadius: 4,
        background: color + '22', color, border: `1px solid ${color}55`,
        fontSize: 9, fontWeight: 800, letterSpacing: 0.5, fontFamily: "'JetBrains Mono'",
        whiteSpace: 'nowrap',
      }}>{label}</span>
      {showSub && (
        <span style={{ fontSize: 8, color: color + 'AA', marginTop: 1, paddingLeft: 2 }}>{sub}</span>
      )}
    </span>
  );
}

function KeyRow({ entry, selected, onToggle, disabled }) {
  return (
    <div
      onClick={() => !disabled && onToggle(entry.chipId)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
        borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
        background: selected ? C.ac + '18' : 'transparent',
        border: `1px solid ${selected ? C.ac + '55' : 'transparent'}`,
        transition: 'background 150ms',
      }}
    >
      <input
        type="checkbox" checked={selected} readOnly
        style={{ accentColor: C.ac, cursor: disabled ? 'default' : 'pointer' }}
      />
      <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, letterSpacing: 1 }}>
        {entry.chipId}
      </span>
      <FlagBadge flag={entry.flag} showSub />
      <span style={{ fontSize: 9, color: C.ts, marginLeft: 'auto' }}>
        cnt={entry.count}
      </span>
    </div>
  );
}

/* ─── main component ───────────────────────────────────────────────────────── */
export default function RfhubKeyTransplantPanel() {
  const [donor,   setDonor]   = useState(null);   // { buf, name, keys, writePtr, freeSlots }
  const [target,  setTarget]  = useState(null);   // same shape
  const [selected, setSelected] = useState(new Set()); // chip IDs to inject
  const [result,  setResult]  = useState(null);   // transplantKeys() result
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
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

      const keys     = parseKeyRingBuffer(buf);
      const writePtr = findWritePointer(buf);
      const freeSlots = writePtr !== null ? countFreeSlots(buf, writePtr) : 0;

      const info = { buf, name: file.name, keys, writePtr, freeSlots };
      if (role === 'donor') {
        setDonor(info);
        // Default: select all donor keys
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

  const onDonorDrop  = useCallback(e => { e.preventDefault(); const f = e.dataTransfer?.files[0] || e.target.files?.[0]; if (f) loadFile(f, 'donor');  }, [loadFile]);
  const onTargetDrop = useCallback(e => { e.preventDefault(); const f = e.dataTransfer?.files[0] || e.target.files?.[0]; if (f) loadFile(f, 'target'); }, [loadFile]);

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
      });
      setResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [donor, target, selected]);

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
            <div style={{ fontSize: 9, color: C.ts }}>
              {info.keys.length} key{info.keys.length !== 1 ? 's' : ''} · {info.freeSlots} free slot{info.freeSlots !== 1 ? 's' : ''}
            </div>
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

  /* ── target key list (for duplicate awareness) ───────────────────────────── */
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
            Copy key ring-buffer entries from donor RFHUB → target RFHUB (offline, no OBD)
          </div>
        </div>
      </div>

      {/* drop zones */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <DropZone
          label="DONOR RFHUB"
          info={donor}
          inputRef={donorRef}
          onDrop={onDonorDrop}
          accent={C.gn}
        />
        <DropZone
          label="TARGET RFHUB"
          info={target}
          inputRef={targetRef}
          onDrop={onTargetDrop}
          accent={C.ac}
        />
      </div>

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
                  />
                  {alreadyInTarget && (
                    <span style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      fontSize: 9, color: C.ts, fontStyle: 'italic',
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

      {/* target key list (read-only info) */}
      {target && target.keys.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.ts, marginBottom: 4, letterSpacing: 1 }}>
            TARGET CURRENT KEYS ({target.keys.length})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {target.keys.map(k => (
              <span key={k.chipId} style={{
                fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.ts,
                background: C.cd, border: `1px solid ${C.bd}`, borderRadius: 4, padding: '2px 6px',
              }}>{k.chipId}</span>
            ))}
          </div>
        </div>
      )}

      {/* capacity warning */}
      {target && donor && selected.size > 0 && (
        (() => {
          const slotsNeeded = selected.size * 2;
          const freeSlots   = target.freeSlots;
          if (slotsNeeded > freeSlots) {
            return (
              <div style={{
                background: '#FF525222', border: `1px solid #FF5252`, borderRadius: 6,
                padding: '6px 10px', fontSize: 10, color: '#FF5252', marginBottom: 10,
              }}>
                ⚠️ Need {slotsNeeded} slots for {selected.size} key{selected.size !== 1 ? 's' : ''} (×2 each), but only {freeSlots} free in target.
              </div>
            );
          }
          return null;
        })()
      )}

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
          <div style={{ fontSize: 10, color: C.tx, marginBottom: 4 }}>
            Injected {result.injected.length} key{result.injected.length !== 1 ? 's' : ''}:
          </div>
          {result.injected.map(k => (
            <div key={k.chipId} style={{
              fontFamily: "'JetBrains Mono'", fontSize: 10, color: '#00E676',
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
            }}>
              <span>↳ {k.chipId}</span>
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
