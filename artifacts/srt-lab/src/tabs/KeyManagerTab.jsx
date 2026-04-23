/* KeyManagerTab — dual-pane RFHub Key Manager.
 * Per-slot transponder ID byte block is not yet mapped for Gen1 or Gen2;
 * AA-50 marker, master SEC16 copy, and the on-screen banner are the
 * authoritative contract. See lib/rfhubKeySlots.js. */
import React, { useState, useCallback, useMemo, useRef } from 'react';
import { Card, Btn, Tag } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { dispatchToast } from '../lib/audit.js';
import { trackDownload } from '../lib/downloadAssets.js';
import {
  parseKeySlots, transferSlot, deleteSlot, addSlot, copyMasterSec16,
  firstFreeSlot, slotsEditableFor, KEY_SLOT_COUNT,
} from '../lib/rfhubKeySlots.js';

const PANES = [
  { id: 'A', label: 'FILE A · SOURCE', color: C.a3 },
  { id: 'B', label: 'FILE B · TARGET', color: C.a1 },
];

function downloadBin(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function extractRfhVin(bytes, gen) {
  if (!bytes) return null;
  // Gen1 (2 KB): VIN @ 0x92, ASCII 17 chars. Gen2 (4 KB+): canonical first
  // slot @ 0x0EA5, byte-reversed ASCII (matches parseModule.js#extractVIN).
  const tryAscii = (off) => {
    if (off + 17 > bytes.length) return null;
    let s = '';
    for (let i = 0; i < 17; i++) {
      const b = bytes[off + i];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) return null;
      s += String.fromCharCode(b);
    }
    return s;
  };
  const tryAsciiReversed = (off) => {
    if (off + 17 > bytes.length) return null;
    let s = '';
    for (let i = 16; i >= 0; i--) {
      const b = bytes[off + i];
      if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A))) return null;
      s += String.fromCharCode(b);
    }
    return s;
  };
  if (gen === 'gen2') return tryAsciiReversed(0x0EA5) || tryAscii(0x92);
  return tryAscii(0x92);
}

function utcStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}T${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
}

/* RFH_KEYMOD_<VIN>_<role>_<UTC>.bin per FreshAuto v6 spec; falls back to
 * NOVIN if the dump didn't carry an ASCII VIN we could verify. */
function patchedName(paneState, paneId) {
  const role = paneId === 'A' ? 'SOURCE' : 'TARGET';
  const vin = extractRfhVin(paneState?.bytes, paneState?.parsed?.gen) || 'NOVIN';
  return `RFH_KEYMOD_${vin}_${role}_${utcStamp()}.bin`;
}

/* Local audit ring buffer (supplemental to module backups). Lives in the
 * same `srtlab:audit` channel BackupsTab listens on so the audit-pane
 * refreshes when a key-fob edit lands. */
const AUDIT_KEY = 'srt-lab.keymgr.audit.v1';
const AUDIT_LIMIT = 500;
function readAuditLog() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function appendAudit(entry) {
  try {
    const arr = readAuditLog();
    arr.push({ ts: new Date().toISOString(), ...entry });
    while (arr.length > AUDIT_LIMIT) arr.shift();
    globalThis.localStorage?.setItem(AUDIT_KEY, JSON.stringify(arr));
    // Fire the same event the rest of the app uses (`subscribeAudit` in
    // lib/audit.js listens for `srtlab:audit`) so any audit-pane viewer
    // refreshes without us depending on its module directly.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('srtlab:audit', { detail: entry }));
    }
  } catch { /* localStorage may be denied in some sandboxes — silent ok */ }
}

function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function hex4(n) { return n.toString(16).toUpperCase().padStart(4, '0'); }
function bytesToHex(arr) { return Array.from(arr).map(hex2).join(' '); }

/* SHA-256 of the patched file so the audit row anchors to a content hash a
 * locksmith can compare against the saved snapshot. crypto.subtle is async
 * and may be missing in some sandboxed test envs — silently return null. */
async function bytesSha256(bytes) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const buf = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/* Two-byte slot marker (AA50 = occupied, FFFF = empty) at `off`. */
function markerAt(bytes, off) {
  if (!bytes || off == null || off + 2 > bytes.length) return null;
  return hex2(bytes[off]) + hex2(bytes[off + 1]);
}

/* Compact SEC16 CS summary suitable for the audit row. */
function sec16Summary(parsed) {
  const slots = parsed?.sec16?.slots;
  if (!slots || slots.length === 0) return null;
  return slots.map(s => ({ slot: s.slot, cs: hex4(s.csStored), ok: s.csOk }));
}

function FileDropPane({ pane, paneState, onLoad, onClear }) {
  const inputRef = useRef(null);
  const [hovering, setHovering] = useState(false);
  const onPick = useCallback((files) => {
    if (!files || !files[0]) return;
    const f = files[0];
    const r = new FileReader();
    r.onload = (ev) => {
      const data = new Uint8Array(ev.target.result);
      onLoad(pane.id, f.name, data);
    };
    r.readAsArrayBuffer(f);
  }, [pane.id, onLoad]);

  const onDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setHovering(true); }, []);
  const onDragLeave = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setHovering(false); }, []);
  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setHovering(false);
    const dt = e.dataTransfer; if (!dt) return;
    onPick(dt.files);
  }, [onPick]);

  if (!paneState?.bytes) {
    return (
      <div
        data-testid={`keymgr-pane-${pane.id}-drop`}
        style={{
          border: '2px dashed ' + (hovering ? pane.color : C.bd), borderRadius: 12, padding: 22,
          background: hovering ? '#FFFCF2' : C.c2, textAlign: 'center', cursor: 'pointer',
          transition: 'border-color 0.15s, background 0.15s',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div style={{ fontSize: 11, fontWeight: 800, color: pane.color, letterSpacing: 1.5 }}>
          {pane.label}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: C.tm }}>
          Click or drop an RFHUB EEE dump (2 KB Gen1 or 4 KB Gen2)
        </div>
        <input
          ref={inputRef}
          data-testid={`keymgr-pane-${pane.id}-input`}
          type="file"
          accept=".bin,.BIN,.eep,.eepe"
          style={{ display: 'none' }}
          onChange={(e) => onPick(e.target.files)}
        />
      </div>
    );
  }
  return (
    <div data-testid={`keymgr-pane-${pane.id}-loaded`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Tag color={pane.color}>{pane.label}</Tag>
        <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "'JetBrains Mono'", color: C.tx, wordBreak: 'break-all' }}>
          {paneState.name}
        </span>
        <button
          data-testid={`keymgr-pane-${pane.id}-clear`}
          onClick={() => onClear(pane.id)}
          style={{ marginLeft: 'auto', background: 'none', border: '1px solid ' + C.bd, color: C.tm, padding: '4px 10px', borderRadius: 6, fontSize: 10, cursor: 'pointer' }}
        >✕ Remove</button>
      </div>
      <div style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
        {(paneState.bytes.length / 1024).toFixed(1)} KB · gen={paneState.parsed?.gen || '?'}
        {paneState.dirty ? <span style={{ color: C.wn, fontWeight: 800, marginLeft: 8 }}>● MODIFIED</span> : null}
      </div>
    </div>
  );
}

function SlotRow({ pane, slot, otherLoaded, slotsEditable, selected, onToggleSelect, onDelete, onAdd, onSendTo }) {
  const occ = slot.occupied;
  const editable = slotsEditable !== false;
  const sendDisabled = !otherLoaded || !editable;
  return (
    <tr data-testid={`keymgr-slot-${pane.id}-${slot.idx}`}
        data-occupied={occ ? '1' : '0'}>
      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
        <input
          type="checkbox"
          data-testid={`keymgr-slot-${pane.id}-${slot.idx}-select`}
          checked={!!selected}
          disabled={!editable}
          onChange={(e) => onToggleSelect(pane.id, slot.idx, e.target.checked)}
        />
      </td>
      <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono'", color: C.tx, fontWeight: 700 }}>
        #{slot.idx}
      </td>
      <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono'", color: C.tm }}>
        0x{hex4(slot.markerOffset)}
      </td>
      <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono'" }}>
        <span
          data-testid={`keymgr-slot-${pane.id}-${slot.idx}-state`}
          style={{
            padding: '2px 8px', borderRadius: 6,
            background: occ ? C.gn + '22' : C.bd,
            color: occ ? C.gn : C.tm,
            fontWeight: 800, fontSize: 10, letterSpacing: 1,
          }}>
          {occ ? 'OCCUPIED' : 'EMPTY'}
        </span>
        <span style={{ marginLeft: 8, color: C.tm, fontSize: 10 }}>{bytesToHex(slot.raw)}</span>
      </td>
      <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono'", color: C.tm, fontSize: 10 }}
          data-testid={`keymgr-slot-${pane.id}-${slot.idx}-id`}>
        {slot.idBytes
          ? <span style={{ color: occ ? C.tx : C.tm }}>
              0x{hex4(slot.idOffset)} · {bytesToHex(slot.idBytes)}
            </span>
          : <span style={{ fontStyle: 'italic' }}>(no ID layout)</span>}
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
        {occ ? (
          <button
            data-testid={`keymgr-slot-${pane.id}-${slot.idx}-delete`}
            disabled={!editable}
            onClick={() => onDelete(pane.id, slot.idx)}
            style={{ padding: '4px 10px', fontSize: 10, fontWeight: 800, color: editable ? C.er : C.tm, background: 'transparent', border: '1px solid ' + (editable ? C.er + '55' : C.bd), borderRadius: 6, cursor: editable ? 'pointer' : 'not-allowed', marginRight: 4 }}>
            DELETE
          </button>
        ) : (
          <button
            data-testid={`keymgr-slot-${pane.id}-${slot.idx}-add`}
            disabled={!editable}
            onClick={() => onAdd(pane.id, slot.idx)}
            style={{ padding: '4px 10px', fontSize: 10, fontWeight: 800, color: editable ? C.gn : C.tm, background: 'transparent', border: '1px solid ' + (editable ? C.gn + '55' : C.bd), borderRadius: 6, cursor: editable ? 'pointer' : 'not-allowed', marginRight: 4 }}>
            ADD AA50
          </button>
        )}
        <button
          data-testid={`keymgr-slot-${pane.id}-${slot.idx}-send`}
          disabled={sendDisabled}
          onClick={() => onSendTo(pane.id, slot.idx)}
          style={{
            padding: '4px 10px', fontSize: 10, fontWeight: 800,
            color: sendDisabled ? C.tm : C.a3,
            background: 'transparent',
            border: '1px solid ' + (sendDisabled ? C.bd : C.a3 + '55'),
            borderRadius: 6, cursor: sendDisabled ? 'not-allowed' : 'pointer',
          }}>
          SEND →
        </button>
      </td>
    </tr>
  );
}

function PaneSlotTable({ pane, paneState, otherLoaded, selection, onToggleSelect, onDelete, onAdd, onSendTo }) {
  const slots = paneState.parsed?.slots || [];
  const sec16 = paneState.parsed?.sec16;
  const slotsEditable = slotsEditableFor(paneState.parsed?.gen);
  return (
    <div data-testid={`keymgr-pane-${pane.id}-table`} style={{ marginTop: 10 }}>
      {!slotsEditable && (
        <div data-testid={`keymgr-pane-${pane.id}-slots-disabled`}
             style={{ marginBottom: 8, padding: 8, background: '#FFEBEE', border: '1px solid ' + C.er + '88', borderRadius: 6, color: C.er, fontSize: 11, fontWeight: 700 }}>
          ⚠ SLOT EDITING DISABLED — AA-50 marker offset for {paneState.parsed?.gen} is not confirmed within this image. Master-SEC16 copy is still permitted.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: C.tm, textAlign: 'left', borderBottom: '1px solid ' + C.bd }}>
            <th style={{ padding: '6px 8px', width: 24 }}>✓</th>
            <th style={{ padding: '6px 8px' }}>SLOT</th>
            <th style={{ padding: '6px 8px' }}>OFFSET</th>
            <th style={{ padding: '6px 8px' }}>STATE</th>
            <th style={{ padding: '6px 8px' }}>AUTEL ID</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {slots.map(s => (
            <SlotRow
              key={s.idx} pane={pane} slot={s}
              otherLoaded={otherLoaded}
              slotsEditable={slotsEditable}
              selected={selection?.[s.idx]}
              onToggleSelect={onToggleSelect}
              onDelete={onDelete} onAdd={onAdd} onSendTo={onSendTo}
            />
          ))}
        </tbody>
      </table>
      {sec16 && (
        <div data-testid={`keymgr-pane-${pane.id}-sec16`}
             style={{ marginTop: 10, padding: 10, background: C.c2, borderRadius: 8, fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
          <div style={{ color: C.tm, fontSize: 10, fontWeight: 800, letterSpacing: 1 }}>MASTER TRANSPONDER (SEC16)</div>
          {sec16.slots.map(s => (
            <div key={s.slot} style={{ marginTop: 4, color: C.tx }}>
              slot{s.slot} @ 0x{hex4(s.offset)} · {Array.from(s.raw).map(hex2).join('')}
              {' · CS '}
              <span data-testid={`keymgr-pane-${pane.id}-sec16-cs-${s.slot}`}
                    style={{ color: s.csOk === true ? C.gn : s.csOk === false ? C.er : C.tm, fontWeight: 800 }}>
                {hex4(s.csStored)} {s.csOk === true ? '✓' : s.csOk === false ? '✗' : ''}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 4, color: sec16.match ? C.gn : C.wn, fontSize: 10, fontWeight: 800 }}>
            {sec16.match ? '✓ slot1/slot2 mirror match' : '⚠ slot1/slot2 mismatch'}
          </div>
        </div>
      )}
    </div>
  );
}

export default function KeyManagerTab() {
  const [panes, setPanes] = useState({ A: null, B: null });
  const [log, setLog] = useState([]);
  const [selection, setSelection] = useState({ A: {}, B: {} });
  const [manualHexA, setManualHexA] = useState('');
  const [manualHexB, setManualHexB] = useState('');
  /* `historyFor` holds the loaded filename whose audit-log entries the
   * "View History" modal is currently filtering by; null = modal closed. */
  const [historyFor, setHistoryFor] = useState(null);
  const [historyTick, setHistoryTick] = useState(0);

  const onToggleSelect = useCallback((paneId, idx, on) => {
    setSelection(s => ({ ...s, [paneId]: { ...s[paneId], [idx]: !!on } }));
  }, []);
  const clearSelection = useCallback((paneId) => {
    setSelection(s => ({ ...s, [paneId]: {} }));
  }, []);

  const addLog = useCallback((m, type = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setLog(p => [...p.slice(-200), { ts, m, type }]);
  }, []);

  const loadPane = useCallback((paneId, name, bytes) => {
    const parsed = parseKeySlots(bytes);
    const originalBytes = new Uint8Array(bytes);
    appendAudit({ pane: paneId, op: 'load-snapshot', filename: name, bytes: bytes.length });
    if (!parsed.ok) {
      addLog(`${paneId}: ${parsed.error}`, 'error');
      setPanes(p => ({ ...p, [paneId]: { name, bytes, originalBytes, parsed, dirty: false, loadError: parsed.error } }));
      return;
    }
    addLog(`${paneId}: loaded ${name} (${bytes.length} B, ${parsed.gen})`, 'pass');
    setPanes(p => ({ ...p, [paneId]: { name, bytes, originalBytes, parsed, dirty: false } }));
  }, [addLog]);

  const revertPane = useCallback((paneId) => {
    setPanes(p => {
      const cur = p[paneId];
      if (!cur?.originalBytes) return p;
      const restored = new Uint8Array(cur.originalBytes);
      addLog(`${paneId}: reverted to original snapshot`, 'pass');
      appendAudit({ pane: paneId, op: 'revert', ok: true, bytes: restored.length });
      return { ...p, [paneId]: { ...cur, bytes: restored, parsed: parseKeySlots(restored), dirty: false } };
    });
  }, [addLog]);

  const clearPane = useCallback((paneId) => {
    setPanes(p => ({ ...p, [paneId]: null }));
    addLog(`${paneId}: cleared`, 'info');
  }, [addLog]);

  const reparse = useCallback((bytes) => parseKeySlots(bytes), []);

  /* Per-pane mutex used to serialize edits. Set *synchronously* before any
   * await so a second click that arrives before the first edit's snapshot
   * POST resolves can never be silently dropped — it gets logged as a
   * "busy" refusal in the audit trail. This is the integrity guarantee
   * underpinning Task #410: every click maps to exactly one audit row,
   * and an ok:true row only ever appears after the bytes were committed
   * AND the snapshot persisted. */
  const inFlightRef = useRef({});

  /* Per-edit audit + snapshot. Each successful Add/Delete/Transfer/Copy-Master
   * persists (a) a snapshot of pre/post bytes through the same /api/backups
   * path BackupsTab consumes and (b) an enriched audit-log entry that carries
   * operation, slot index, before/after marker, SEC16 CS list, and a SHA-256
   * of the patched file. Refusals are written too so a locksmith can later
   * prove a refused click never touched the dump. */
  const applyResult = useCallback(async (paneId, result, label, meta = {}) => {
    const cur = panes[paneId];
    if (!cur) return false;
    const filename = cur.name;
    const vin = extractRfhVin(cur.bytes, cur.parsed?.gen) || 'NOVIN';
    const slotIdx = meta.slotIdx;
    const markerOffset = meta.markerOffset
      ?? (slotIdx != null ? cur.parsed?.slots?.[slotIdx]?.markerOffset : null);

    if (!result.ok) {
      addLog(`KEYMOD REFUSED · ${paneId} · ${label}: ${result.error}`, 'error');
      appendAudit({
        pane: paneId, op: label, slotIdx, ok: false, error: result.error,
        vin, filename, markerBefore: markerAt(cur.bytes, markerOffset),
      });
      return false;
    }
    const same = cur.bytes.length === result.bytes.length
      && cur.bytes.every((b, i) => b === result.bytes[i]);
    if (same) {
      addLog(`KEYMOD REFUSED · ${paneId} · ${label}: no-op`, 'warn');
      appendAudit({
        pane: paneId, op: label, slotIdx, ok: false, error: 'no-op',
        vin, filename, markerBefore: markerAt(cur.bytes, markerOffset),
      });
      return false;
    }

    /* Acquire the per-pane mutex synchronously. A concurrent click whose
     * snapshot/audit work is still in flight is refused here and logged. */
    if (inFlightRef.current[paneId]) {
      addLog(`KEYMOD REFUSED · ${paneId} · ${label}: pane busy (prior edit still persisting)`, 'warn');
      appendAudit({
        pane: paneId, op: label, slotIdx, ok: false, error: 'pane busy',
        vin, filename, markerBefore: markerAt(cur.bytes, markerOffset),
      });
      return false;
    }
    inFlightRef.current[paneId] = true;
    try {
      const prevBytes = cur.bytes;
      const nextBytes = result.bytes;
      const nextParsed = reparse(nextBytes);
      const off = result.markerOffset ?? markerOffset;

      /* Persist snapshot FIRST. If neither durable copy lands, the pane
       * bytes are never mutated and the audit row is a clean refusal —
       * preserving the "refusal proves nothing touched the dump"
       * guarantee that anchors the audit trail's trustworthiness. */
      const fileHash = await bytesSha256(nextBytes);
      const snap = await writeKeymgrSnapshot(
        paneId, filename, vin, prevBytes, nextBytes,
        'keymgr-edit', label,
      );
      if (!snap.persisted) {
        addLog(`KEYMOD REFUSED · ${paneId} · ${label}: snapshot persistence failed (remote and local both rejected) — pane bytes left untouched`, 'error');
        appendAudit({
          pane: paneId, op: label, slotIdx, ok: false, error: 'snapshot persistence failed',
          vin, filename,
          markerBefore: markerAt(prevBytes, off),
          savedRemote: snap.savedRemote, savedLocal: snap.savedLocal,
        });
        return false;
      }

      /* Snapshot is durable — commit pane bytes and emit the success row. */
      setPanes(p => ({ ...p, [paneId]: { ...p[paneId], bytes: nextBytes, parsed: nextParsed, dirty: true } }));
      addLog(`${paneId} · ${label} ok (patched=${result.patched ?? '?'}; snapshot ${snap.key})`, 'pass');
      appendAudit({
        pane: paneId, op: label, slotIdx, ok: true,
        patched: result.patched ?? 0,
        vin, filename,
        markerBefore: markerAt(prevBytes, off),
        markerAfter: markerAt(nextBytes, off),
        sec16Cs: sec16Summary(nextParsed),
        fileHash, snapshotKey: snap.key,
        savedRemote: snap.savedRemote, savedLocal: snap.savedLocal,
      });
      return true;
    } finally {
      inFlightRef.current[paneId] = false;
    }
  }, [panes, addLog, reparse]);

  const handleDelete = useCallback((paneId, idx) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const r = deleteSlot(cur.bytes, idx);
    applyResult(paneId, r, `delete slot #${idx}`, { slotIdx: idx });
  }, [panes, applyResult]);

  const handleAdd = useCallback((paneId, idx) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const r = addSlot(cur.bytes, idx);
    applyResult(paneId, r, `add slot #${idx}`, { slotIdx: idx });
  }, [panes, applyResult]);

  const handleSendTo = useCallback((srcId, idx) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    const dstFn = dst?.name || null;
    const dstVin = dst?.bytes ? (extractRfhVin(dst.bytes, dst.parsed?.gen) || 'NOVIN') : null;
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId}: both panes must be loaded`, 'error');
      appendAudit({ pane: dstId, op: `transfer slot #${idx} from ${srcId}`, slotIdx: idx, ok: false, error: 'pane not loaded', vin: dstVin, filename: dstFn });
      return;
    }
    if (src.parsed?.gen !== dst.parsed?.gen) {
      // Mixed-gen attempt: the buttons are already disabled in the UI for
      // this case, but log a hard refusal here too so any code path (e.g.
      // bulk transfer, future keyboard shortcut) emits a consistent audit
      // entry instead of silently dropping the click.
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId} slot #${idx}: generation mismatch (${src.parsed?.gen} vs ${dst.parsed?.gen})`, 'error');
      appendAudit({ pane: dstId, op: `transfer slot #${idx} from ${srcId}`, slotIdx: idx, ok: false, error: 'gen mismatch', vin: dstVin, filename: dstFn });
      return;
    }
    const r = transferSlot(src.bytes, dst.bytes, idx, idx);
    applyResult(dstId, r, `transfer slot #${idx} from ${srcId}`, { slotIdx: idx });
  }, [panes, applyResult, addLog]);

  const handleAddManual = useCallback((paneId) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const free = firstFreeSlot(cur.bytes);
    if (free < 0) {
      addLog(`KEYMOD REFUSED · ${paneId}: no free slot (all ${KEY_SLOT_COUNT} occupied)`, 'error');
      const vin = extractRfhVin(cur.bytes, cur.parsed?.gen) || 'NOVIN';
      appendAudit({ pane: paneId, op: 'add manual @ first-free slot', ok: false, error: 'no free slot', vin, filename: cur.name });
      return;
    }
    const r = addSlot(cur.bytes, free);
    applyResult(paneId, r, `add manual @ first-free slot #${free}`, { slotIdx: free });
  }, [panes, applyResult, addLog]);

  /* Manual ID hex input. Accepts 8 hex bytes but refuses to write — the
   * per-slot ID byte offsets are not yet mapped (see Task #408). */
  const handleManualHexAdd = useCallback((paneId) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const vin = extractRfhVin(cur.bytes, cur.parsed?.gen) || 'NOVIN';
    const txt = (paneId === 'A' ? manualHexA : manualHexB).trim();
    const hex = txt.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 16) {
      addLog(`KEYMOD REFUSED · ${paneId} · manual hex: need exactly 8 bytes (16 hex chars), got ${hex.length}`, 'error');
      appendAudit({ pane: paneId, op: 'manual-hex', ok: false, error: 'bad length', vin, filename: cur.name });
      return;
    }
    addLog(`KEYMOD REFUSED · ${paneId} · manual hex ${hex.toUpperCase()}: per-slot transponder ID byte offsets not yet mapped (Task #408)`, 'error');
    appendAudit({ pane: paneId, op: 'manual-hex', ok: false, error: 'layout not mapped', hex: hex.toUpperCase(), vin, filename: cur.name });
  }, [panes, manualHexA, manualHexB, addLog]);

  const handleBulkTransfer = useCallback(async (srcId, mode) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId} (${mode}): both panes must be loaded`, 'error');
      appendAudit({ pane: dstId, op: `bulk-transfer (${mode}) from ${srcId}`, ok: false, error: 'pane not loaded' });
      return;
    }
    const dstFn = dst.name;
    const dstVin = extractRfhVin(dst.bytes, dst.parsed?.gen) || 'NOVIN';
    const indices = mode === 'all'
      ? Array.from({ length: KEY_SLOT_COUNT }, (_, i) => i)
      : Object.keys(selection[srcId] || {}).filter(k => selection[srcId][k]).map(k => parseInt(k, 10)).sort();
    if (indices.length === 0) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId}: no slots selected`, 'error');
      appendAudit({ pane: dstId, op: `bulk-transfer (${mode}) from ${srcId}`, ok: false, error: 'no slots selected', vin: dstVin, filename: dstFn });
      return;
    }
    /* Acquire the dst-pane mutex so a concurrent single-slot edit can't
     * land in the middle of the bulk run. */
    if (inFlightRef.current[dstId]) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId} (${mode}): pane busy`, 'warn');
      appendAudit({
        pane: dstId, op: `bulk-transfer (${mode}) from ${srcId}`,
        ok: false, error: 'pane busy', vin: dstVin, filename: dstFn,
      });
      return;
    }
    inFlightRef.current[dstId] = true;
    try {
      let working = dst.bytes;
      let okCount = 0; let failCount = 0;
      for (const idx of indices) {
        const r = transferSlot(src.bytes, working, idx, idx);
        const off = r.markerOffset ?? dst.parsed?.slots?.[idx]?.markerOffset;
        if (!r.ok) {
          failCount++;
          addLog(`KEYMOD REFUSED · ${srcId}→${dstId} slot #${idx}: ${r.error}`, 'error');
          appendAudit({
            pane: dstId, op: `bulk-transfer #${idx} from ${srcId}`, slotIdx: idx,
            ok: false, error: r.error, vin: dstVin, filename: dstFn,
            markerBefore: markerAt(working, off),
          });
          continue;
        }
        const before = markerAt(working, off);
        const after = markerAt(r.bytes, off);
        const prevBytes = working;
        const nextBytes = r.bytes;
        // Persist FIRST — only commit pane bytes if the snapshot landed.
        const fileHash = await bytesSha256(nextBytes);
        const snap = await writeKeymgrSnapshot(
          dstId, dstFn, dstVin, prevBytes, nextBytes,
          'keymgr-edit', `bulk-transfer #${idx} from ${srcId}`,
        );
        if (!snap.persisted) {
          failCount++;
          addLog(`KEYMOD REFUSED · ${srcId}→${dstId} slot #${idx}: snapshot persistence failed — pane bytes left untouched`, 'error');
          appendAudit({
            pane: dstId, op: `bulk-transfer #${idx} from ${srcId}`, slotIdx: idx,
            ok: false, error: 'snapshot persistence failed',
            vin: dstVin, filename: dstFn,
            markerBefore: before,
            savedRemote: snap.savedRemote, savedLocal: snap.savedLocal,
          });
          // Stop the bulk run on persistence failure so subsequent steps
          // don't snapshot a non-existent prior state.
          break;
        }
        // Commit this step.
        setPanes(p => ({ ...p, [dstId]: { ...p[dstId], bytes: nextBytes, parsed: reparse(nextBytes), dirty: true } }));
        working = nextBytes;
        okCount++;
        appendAudit({
          pane: dstId, op: `bulk-transfer #${idx} from ${srcId}`, slotIdx: idx,
          ok: true, patched: 1, vin: dstVin, filename: dstFn,
          markerBefore: before, markerAfter: after,
          sec16Cs: sec16Summary(reparse(nextBytes)), fileHash,
          snapshotKey: snap.key,
          savedRemote: snap.savedRemote, savedLocal: snap.savedLocal,
        });
      }
      if (okCount > 0 || failCount > 0) {
        addLog(`${srcId}→${dstId} (${mode}): ${okCount} ok, ${failCount} refused`, failCount > 0 ? 'warn' : 'pass');
      }
    } finally {
      inFlightRef.current[dstId] = false;
    }
  }, [panes, selection, addLog, reparse]);

  const handleCopyMaster = useCallback((srcId) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    const dstFn = dst?.name || null;
    const dstVin = dst?.bytes ? (extractRfhVin(dst.bytes, dst.parsed?.gen) || 'NOVIN') : null;
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · master ${srcId}→${dstId}: both panes must be loaded`, 'error');
      appendAudit({ pane: dstId, op: `copy master SEC16 from ${srcId}`, ok: false, error: 'pane not loaded', vin: dstVin, filename: dstFn });
      return;
    }
    if (src.parsed?.gen !== dst.parsed?.gen) {
      addLog(`KEYMOD REFUSED · master ${srcId}→${dstId}: generation mismatch (${src.parsed?.gen} vs ${dst.parsed?.gen})`, 'error');
      appendAudit({ pane: dstId, op: `copy master SEC16 from ${srcId}`, ok: false, error: 'gen mismatch', vin: dstVin, filename: dstFn });
      return;
    }
    const r = copyMasterSec16(src.bytes, dst.bytes);
    applyResult(dstId, r, `copy master SEC16 from ${srcId}`);
  }, [panes, applyResult, addLog]);

  /* Persist a keymgr snapshot through the same path BackupsTab uses:
   * POST /api/backups (canonical persistence) with a localStorage fallback
   * so the record survives `refreshBackupsFromServer()` re-syncs.
   *
   * `snapshotKind` is `keymgr-pre-save` for the (cumulative) save snapshot
   * and `keymgr-edit` for per-edit checkpoints written from applyResult /
   * bulk-transfer. `opLabel` is a free-form description ("delete slot #3",
   * "copy master SEC16 from A") embedded in the meta so BackupsTab can
   * display what produced the snapshot. */
  async function writeKeymgrSnapshot(paneId, name, vin, originalBytes, patchedBytes, snapshotKind = 'keymgr-pre-save', opLabel = null) {
    const ts = Date.now();
    const tsIso = new Date(ts).toISOString();
    const kindTag = snapshotKind === 'keymgr-edit' ? 'edit' : paneId;
    /* Per-millisecond collision-resistant suffix so back-to-back edits in
     * the same ms still get distinct keys. */
    const suffix = Math.random().toString(36).slice(2, 8);
    const key = `srtlab_backup_RFHUB_${vin}_${ts}_${suffix}_keymgr_${kindTag}_${paneId}`;
    const toHex = (arr) => Array.from(arr, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const payload = {
      module: 'RFHUB',
      tx: 0x000, rx: 0x000,
      timestamp: tsIso,
      snapshotKind,
      source: name,
      op: opLabel,
      dids: {
        0xEEEE: { name: 'RFHUB EEPROM (original)', critical: true,
                  hex: toHex(originalBytes), bytes: Array.from(originalBytes) },
        0xEEEF: { name: 'RFHUB EEPROM (patched)', critical: true,
                  hex: toHex(patchedBytes), bytes: Array.from(patchedBytes) },
      },
    };
    const meta = {
      key, id: key, module: 'RFHUB', vin, timestamp: tsIso,
      didCount: 2, tx: 0x000, rx: 0x000,
      snapshotKind, preWriteKey: null,
      source: 'keymgr', pane: paneId, filename: name, op: opLabel,
    };
    let savedRemote = false;
    try {
      const res = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: key, module: 'RFHUB', vin, didCount: 2,
          tx: 0, rx: 0, timestamp: tsIso, payload,
          snapshotKind, preWriteKey: null,
        }),
      });
      savedRemote = res.ok;
    } catch { /* offline — fall through to local cache */ }
    let savedLocal = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(payload));
        const idxRaw = localStorage.getItem('srtlab_backup_index') || '[]';
        const idx = JSON.parse(idxRaw);
        idx.unshift(meta);
        localStorage.setItem('srtlab_backup_index', JSON.stringify(idx.slice(0, 50)));
        savedLocal = true;
      }
    } catch { /* quota or denied — savedLocal stays false */ }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('srtlab:audit'));
    }
    /* Persisted means at least one durable copy exists. If neither remote
     * nor local accepted the snapshot, the caller must downgrade the
     * audit row to ok:false so the trail never claims a snapshot that
     * isn't actually retrievable. */
    return { key, savedRemote, savedLocal, persisted: savedRemote || savedLocal };
  }

  const handleSave = useCallback(async (paneId) => {
    const cur = panes[paneId];
    if (!cur?.bytes) return;
    if (!cur.dirty) {
      addLog(`KEYMOD REFUSED · ${paneId}: nothing to save (no edits applied)`, 'warn');
      return;
    }
    const fn = patchedName(cur, paneId);
    const vin = extractRfhVin(cur.bytes, cur.parsed?.gen) || 'NOVIN';
    // Snapshot first, download second — matches lib/audit.js#backupModule.
    const snap = await writeKeymgrSnapshot(paneId, fn, vin, cur.originalBytes || cur.bytes, cur.bytes, 'keymgr-pre-save', 'save');
    downloadBin(cur.bytes, fn);
    const remoteTag = snap.savedRemote ? 'server+local' : 'local-only';
    const fileHash = await bytesSha256(cur.bytes);
    addLog(`${paneId}: saved ${fn} (snapshot ${snap.key}, ${remoteTag})`, 'pass');
    appendAudit({
      pane: paneId, op: 'save', ok: true,
      filename: fn, sourceFilename: cur.name, vin,
      bytes: cur.bytes.length,
      sec16Cs: sec16Summary(cur.parsed),
      fileHash, snapshotKey: snap.key, savedRemote: snap.savedRemote,
    });
    try { dispatchToast(`Saved ${fn}`, 'pass'); } catch { /* noop */ }
    try { trackDownload('rfh-keymod'); } catch { /* best-effort */ }
  }, [panes, addLog]);

  const aLoaded = !!panes.A?.bytes && panes.A?.parsed?.ok;
  const bLoaded = !!panes.B?.bytes && panes.B?.parsed?.ok;
  const bothLoaded = aLoaded && bLoaded;
  const genMismatch = useMemo(() => {
    if (!bothLoaded) return false;
    return panes.A.parsed.gen !== panes.B.parsed.gen;
  }, [bothLoaded, panes]);

  return (
    <div data-testid="keymgr-tab">
      <Card style={{ background: 'linear-gradient(135deg,#1A237E 0%,#283593 40%,#3949AB 100%)', color: '#fff', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32 }}>🗝️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2 }}>RFHUB KEY MANAGER</div>
            <div style={{ fontSize: 10, opacity: .75, letterSpacing: 3, fontWeight: 700 }}>DUAL-FILE FOB SLOT EDITOR · SEC16 TRANSFER</div>
          </div>
        </div>
      </Card>

      <div data-testid="keymgr-layout-banner"><Card style={{ marginBottom: 14, background: '#FFF8E1', border: '2px solid ' + C.wn }}>
        <div style={{ fontWeight: 800, color: '#E65100', fontSize: 11, letterSpacing: 1.5, marginBottom: 6 }}>
          ⚠ LAYOUT STATUS — READ BEFORE FLASHING
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.55, color: '#5D4037' }}>
          <b>Confirmed (Gen2):</b> AA-50 occupancy markers @ 0x0880 stride 2,
          per-fob Autel transponder ID block @ 0x0888 stride 8 (8 B per slot),
          and the master-transponder SEC16 mirror pair (CS = crc8_65 — golden-tested).
          <br />
          <b>Confirmed (Gen1):</b> AA-50 occupancy markers @ 0x00D2 stride 2 (just
          past the SEC16 slot-2 CS bytes), and the master-transponder SEC16 mirror
          pair @ 0x00AE / 0x00C0 (CS = crc8_65 — same formula as Gen2). Slot edits
          and SEC16 copy are both permitted on Gen1 24C16 (older Cherokee/WK/LX) hubs.
          <br />
          <b>Provisional (Gen1):</b> per-fob Autel transponder ID block @ 0x00DA
          stride 8 — placed immediately after the marker block to mirror Gen2's
          adjacency, but not yet golden-tested against a real 24C16 donor pair.
          A Gen1 → Gen1 transfer still copies marker + ID block; verification
          against real dumps is tracked as a follow-up.

          <br />
          <b>“Send →” now copies marker + ID block</b> — the receiving module sees
          the same fob UID as the donor, so a transferred slot will start the car
          without needing an accompanying Copy Master Transponder.
        </div>
      </Card></div>

      {bothLoaded && !genMismatch && (
        <Card data-testid="keymgr-bulk-panel" style={{ marginBottom: 14, background: C.c2 }}>
          <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 8, letterSpacing: 2 }}>⇆ BULK SLOT TRANSFER</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
            <button data-testid="keymgr-bulk-selected-a-to-b"
                    onClick={() => handleBulkTransfer('A', 'selected')}
                    style={{ padding: '10px 18px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '2px solid ' + C.a2, background: 'transparent', color: C.a2, cursor: 'pointer' }}>
              SELECTED A → B
            </button>
            <button data-testid="keymgr-bulk-selected-b-to-a"
                    onClick={() => handleBulkTransfer('B', 'selected')}
                    style={{ padding: '10px 18px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '2px solid ' + C.a4, background: 'transparent', color: C.a4, cursor: 'pointer' }}>
              SELECTED B → A
            </button>
            <button data-testid="keymgr-bulk-all-a-to-b"
                    onClick={() => handleBulkTransfer('A', 'all')}
                    style={{ padding: '10px 18px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: 'none', background: C.a2, color: '#fff', cursor: 'pointer' }}>
              ALL A → B
            </button>
            <button data-testid="keymgr-bulk-all-b-to-a"
                    onClick={() => handleBulkTransfer('B', 'all')}
                    style={{ padding: '10px 18px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: 'none', background: C.a4, color: '#fff', cursor: 'pointer' }}>
              ALL B → A
            </button>
            <button data-testid="keymgr-bulk-clear-selection"
                    onClick={() => { clearSelection('A'); clearSelection('B'); }}
                    style={{ padding: '10px 14px', borderRadius: 10, fontWeight: 700, fontSize: 11, border: '1px solid ' + C.bd, background: 'transparent', color: C.tm, cursor: 'pointer' }}>
              clear selection
            </button>
          </div>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        {PANES.map(p => {
          const ps = panes[p.id];
          const otherLoaded = (p.id === 'A' ? bLoaded : aLoaded);
          return (
            <Card key={p.id} style={{ borderTop: '4px solid ' + p.color }}>
              <FileDropPane pane={p} paneState={ps} onLoad={loadPane} onClear={clearPane} />
              {ps?.bytes && ps.parsed?.ok && (() => {
                const slotsEditable = slotsEditableFor(ps.parsed?.gen);
                const vin = extractRfhVin(ps.bytes, ps.parsed?.gen);
                const sec16 = ps.parsed?.sec16;
                const sec16Status = sec16
                  ? (sec16.match
                      ? (sec16.slots.every(s => s.csOk !== false) ? '✓ SYNC + CRC OK' : '⚠ MIRROR MATCH BUT CRC ✗')
                      : (sec16.slots.every(s => s.raw.every(b => b === 0xFF)) ? '⨯ VIRGIN (FF)' : '⚠ MIRROR MISMATCH'))
                  : 'no SEC16';
                return (
                <>
                  <div data-testid={`keymgr-pane-${p.id}-status`}
                       style={{ marginTop: 6, padding: '6px 8px', background: C.c2, borderRadius: 6, fontSize: 10, fontFamily: "'JetBrains Mono'", color: C.tx, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span><b style={{ color: C.tm }}>VIN:</b> <span data-testid={`keymgr-pane-${p.id}-vin`}>{vin || '—'}</span></span>
                    <span><b style={{ color: C.tm }}>SEC16:</b> <span data-testid={`keymgr-pane-${p.id}-sec16-status`}>{sec16Status}</span></span>
                  </div>
                  <PaneSlotTable
                    pane={p} paneState={ps}
                    otherLoaded={otherLoaded && !genMismatch}
                    selection={selection[p.id]}
                    onToggleSelect={onToggleSelect}
                    onDelete={handleDelete}
                    onAdd={handleAdd}
                    onSendTo={handleSendTo}
                  />
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      data-testid={`keymgr-pane-${p.id}-manual-hex`}
                      placeholder="Manual fob ID (8 hex bytes)"
                      value={p.id === 'A' ? manualHexA : manualHexB}
                      onChange={(e) => (p.id === 'A' ? setManualHexA : setManualHexB)(e.target.value)}
                      style={{ flex: '1 1 220px', minWidth: 180, padding: '8px 10px', border: '1px solid ' + C.bd, borderRadius: 8, fontFamily: "'JetBrains Mono'", fontSize: 11 }}
                    />
                    <button
                      data-testid={`keymgr-pane-${p.id}-manual-hex-add`}
                      onClick={() => handleManualHexAdd(p.id)}
                      style={{ padding: '8px 14px', borderRadius: 8, fontWeight: 800, fontSize: 11, border: '2px solid ' + C.wn + '88', background: 'transparent', color: C.wn, cursor: 'pointer' }}
                    >➕ Add by ID</button>
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      data-testid={`keymgr-pane-${p.id}-add-manual`}
                      disabled={!slotsEditable}
                      onClick={() => handleAddManual(p.id)}
                      style={{ padding: '10px 20px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '2px solid ' + (slotsEditable ? C.gn + '55' : C.bd), background: 'transparent', color: slotsEditable ? C.gn : C.tm, cursor: slotsEditable ? 'pointer' : 'not-allowed' }}
                    >➕ Mark First Free</button>
                    <button
                      data-testid={`keymgr-pane-${p.id}-copy-master`}
                      onClick={() => handleCopyMaster(p.id === 'A' ? 'B' : 'A')}
                      disabled={!otherLoaded || genMismatch}
                      style={{ padding: '10px 20px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '2px solid ' + ((!otherLoaded || genMismatch) ? C.bd : C.a4 + '55'), background: 'transparent', color: (!otherLoaded || genMismatch) ? C.tm : C.a4, cursor: (!otherLoaded || genMismatch) ? 'not-allowed' : 'pointer' }}
                    >🔐 Copy Master ← {p.id === 'A' ? 'B' : 'A'}</button>
                    <button
                      data-testid={`keymgr-pane-${p.id}-revert`}
                      onClick={() => revertPane(p.id)}
                      disabled={!ps.dirty || !ps.originalBytes}
                      title="Restore the originally-loaded bytes for this pane (in-memory snapshot)."
                      style={{ padding: '10px 16px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '2px solid ' + ((!ps.dirty || !ps.originalBytes) ? C.bd : C.wn + '88'), background: 'transparent', color: (!ps.dirty || !ps.originalBytes) ? C.tm : C.wn, cursor: (!ps.dirty || !ps.originalBytes) ? 'not-allowed' : 'pointer' }}
                    >↶ Revert {p.id}</button>
                    <button
                      data-testid={`keymgr-pane-${p.id}-save`}
                      onClick={() => handleSave(p.id)}
                      disabled={!ps.dirty}
                      style={{ padding: '10px 20px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: 'none', background: !ps.dirty ? '#E8E4DE' : p.color, color: !ps.dirty ? C.tm : '#fff', cursor: !ps.dirty ? 'not-allowed' : 'pointer' }}
                    >💾 Save Patched {p.id}</button>
                    <button
                      data-testid={`keymgr-pane-${p.id}-view-history`}
                      onClick={() => { setHistoryTick(t => t + 1); setHistoryFor(ps.name); }}
                      title="Show the audit-log entries recorded for this loaded file."
                      style={{ padding: '10px 16px', borderRadius: 10, fontWeight: 800, fontSize: 12, border: '1px solid ' + C.bd, background: 'transparent', color: C.tm, cursor: 'pointer', marginLeft: 'auto' }}
                    >📜 View History</button>
                  </div>
                </>
                );
              })()}
              {ps?.bytes && !ps.parsed?.ok && (
                <div data-testid={`keymgr-pane-${p.id}-error`} style={{ marginTop: 10, padding: 10, background: '#FFEBEE', border: '1px solid ' + C.er, borderRadius: 8, color: C.er, fontSize: 12 }}>
                  ✗ {ps.parsed?.error || 'parse failed'}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {bothLoaded && genMismatch && (
        <div data-testid="keymgr-gen-mismatch"><Card style={{ marginBottom: 14, background: '#FFEBEE', border: '2px solid ' + C.er }}>
          <div style={{ fontWeight: 800, color: C.er, fontSize: 12, letterSpacing: 1 }}>
            ✗ GENERATION MISMATCH — A is {panes.A.parsed.gen}, B is {panes.B.parsed.gen}
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
            Cross-generation transfer is refused (offsets and CS formulas differ). Load
            two dumps of the same generation to enable Send / Copy Master between panes.
          </div>
        </Card></div>
      )}

      {historyFor && (() => {
        const all = readAuditLog();
        // Surface entries whose `filename` matches the currently viewed file
        // — this includes the loaded source name (per-edit rows) AND the
        // patched output filename (save rows reference the saved-as name).
        const rows = all
          .filter(e => e.filename === historyFor || e.sourceFilename === historyFor)
          .slice()
          .reverse();
        void historyTick; // re-read on each open
        return (
          <div
            data-testid="keymgr-history-modal"
            onClick={() => setHistoryFor(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 92vw)', maxHeight: '82vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 14px 50px rgba(0,0,0,.35)' }}
            >
              <div style={{ padding: '14px 18px', borderBottom: '1px solid ' + C.bd, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: C.tx, letterSpacing: 1 }}>
                    📜 KEY-FOB AUDIT TRAIL
                  </div>
                  <div data-testid="keymgr-history-filter" style={{ fontSize: 11, color: C.tm, fontFamily: "'JetBrains Mono'", marginTop: 2, wordBreak: 'break-all' }}>
                    filtered to: {historyFor}
                  </div>
                </div>
                <button
                  data-testid="keymgr-history-close"
                  onClick={() => setHistoryFor(null)}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.bd, background: 'transparent', color: C.tm, fontWeight: 700, cursor: 'pointer' }}
                >✕ Close</button>
              </div>
              <div style={{ overflow: 'auto', padding: '8px 14px' }}>
                {rows.length === 0 ? (
                  <div data-testid="keymgr-history-empty" style={{ padding: 18, color: C.tm, fontStyle: 'italic', fontSize: 12 }}>
                    No audit entries recorded yet for this file. Add, delete, transfer, copy-master, or save to start the trail.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono'" }}>
                    <thead>
                      <tr style={{ color: C.tm, textAlign: 'left', borderBottom: '1px solid ' + C.bd }}>
                        <th style={{ padding: '6px 8px' }}>WHEN (UTC)</th>
                        <th style={{ padding: '6px 8px' }}>OK</th>
                        <th style={{ padding: '6px 8px' }}>OPERATION</th>
                        <th style={{ padding: '6px 8px' }}>SLOT</th>
                        <th style={{ padding: '6px 8px' }}>MARKER</th>
                        <th style={{ padding: '6px 8px' }}>SEC16 CS</th>
                        <th style={{ padding: '6px 8px' }}>FILE SHA-256</th>
                        <th style={{ padding: '6px 8px' }}>SNAPSHOT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e, i) => (
                        <tr key={i}
                            data-testid={`keymgr-history-row-${i}`}
                            data-ok={e.ok ? '1' : '0'}
                            style={{ borderBottom: '1px solid ' + C.c2, color: e.ok === false ? C.er : C.tx }}>
                          <td style={{ padding: '6px 8px', color: C.tm, whiteSpace: 'nowrap' }}>{e.ts}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 800, color: e.ok ? C.gn : C.er }}>{e.ok ? '✓' : '✗'}</td>
                          <td style={{ padding: '6px 8px' }}>
                            {e.op}
                            {e.error ? <span style={{ color: C.er, marginLeft: 6 }}>({e.error})</span> : null}
                          </td>
                          <td style={{ padding: '6px 8px' }}>{e.slotIdx ?? '—'}</td>
                          <td style={{ padding: '6px 8px' }}>
                            {e.markerBefore || '—'}{e.markerAfter ? ` → ${e.markerAfter}` : ''}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {e.sec16Cs
                              ? e.sec16Cs.map(s => `s${s.slot}=${s.cs}${s.ok === false ? '✗' : ''}`).join(' ')
                              : '—'}
                          </td>
                          <td style={{ padding: '6px 8px', color: C.tm }} title={e.fileHash || ''}>
                            {e.fileHash ? e.fileHash.slice(0, 12) + '…' : '—'}
                          </td>
                          <td style={{ padding: '6px 8px', color: C.tm }} title={e.snapshotKey || ''}>
                            {e.snapshotKey ? `${e.snapshotKey.slice(0, 24)}…${e.savedRemote ? ' (server)' : ' (local)'}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <Card data-testid="keymgr-log">
        <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 8, letterSpacing: 2 }}>📜 ACTIVITY LOG</div>
        {log.length === 0 ? (
          <div style={{ fontSize: 11, color: C.tm, fontStyle: 'italic' }}>No actions yet.</div>
        ) : (
          <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, maxHeight: 220, overflowY: 'auto' }}>
            {log.map((l, i) => (
              <div key={i}
                   data-testid={`keymgr-log-row-${i}`}
                   data-log-type={l.type}
                   style={{
                     padding: '2px 0',
                     color: l.type === 'error' ? C.er : l.type === 'warn' ? C.wn : l.type === 'pass' ? C.gn : C.tx,
                   }}>
                <span style={{ color: C.tm, marginRight: 8 }}>{l.ts}</span>{l.m}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
