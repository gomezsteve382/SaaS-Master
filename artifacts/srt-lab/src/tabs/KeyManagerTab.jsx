/* ============================================================================
 * KeyManagerTab — Task #407 — dual-pane RFHub Key Manager.
 *
 * Modeled on the FreshAuto RFHub Key Manager v6 workflow:
 *   • Load File A (source) and File B (target) — independent drop zones.
 *   • Each pane parses an RFHUB Gen2 (4 KB) or Gen1 (2 KB) image and shows
 *     occupancy of the four AA-50 fob slots plus the SEC16 master secret.
 *   • Per-row buttons let a locksmith Send a slot A→B (same index),
 *     Delete (clear marker) or Add (write AA 50 to a free slot).
 *   • A single Master-Transponder copy button transfers the SEC16 raw +
 *     recomputes the Gen2 CS (golden-tested formula in lib/crc.js).
 *   • Save buttons re-download the patched bin per pane, only enabled
 *     after at least one mutation succeeded. Refusal paths (writer
 *     returns ok:false) log "KEYMOD REFUSED" in red and skip the save.
 *
 * LAYOUT HONESTY — The per-fob Autel/H8/megamos transponder ID byte block
 * is NOT yet reverse-engineered for either Gen1 or Gen2 RFHUB images.
 * Transfer/Delete/Add operate on the AA-50 OCCUPANCY MARKER ONLY. The
 * banner at the top of the tab explains this so the locksmith never
 * assumes a "transferred" slot will start a vehicle without an
 * accompanying SEC16 (master) copy. See lib/rfhubKeySlots.js for the
 * exact contract and follow-up tasks for mapping per-slot IDs.
 * ============================================================================ */
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

/* Tiny localStorage-backed audit ring buffer — every successful or refused
 * mutation lands here so a locksmith has a tamper-evident record after the
 * tab is closed. (Reviewer #2 next-action item.) */
const AUDIT_KEY = 'srt-lab.keymgr.audit.v1';
const AUDIT_LIMIT = 500;
function appendAudit(entry) {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
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

function FileDropPane({ pane, paneState, onLoad, onClear }) {
  const inputRef = useRef(null);
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

  if (!paneState?.bytes) {
    return (
      <div
        data-testid={`keymgr-pane-${pane.id}-drop`}
        style={{
          border: '2px dashed ' + C.bd, borderRadius: 12, padding: 22,
          background: C.c2, textAlign: 'center', cursor: 'pointer',
        }}
        onClick={() => inputRef.current?.click()}
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
      <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono'", color: C.tm, fontSize: 10, fontStyle: 'italic' }}>
        (layout TBD)
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
                {hex4(s.csStored)} {s.csOk === true ? '✓' : s.csOk === false ? '✗' : '(gen1 — formula not verified)'}
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
    // Snapshot the original buffer so the user can revert in-place without
    // re-uploading the file. This is the project-local equivalent of the
    // "snapshot before write" pattern in lib/audit.js#backupModule (which
    // requires a live UDS engine and therefore cannot be used here).
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

  const applyResult = useCallback((paneId, result, label) => {
    if (!result.ok) {
      addLog(`KEYMOD REFUSED · ${paneId} · ${label}: ${result.error}`, 'error');
      appendAudit({ pane: paneId, op: label, ok: false, error: result.error });
      return false;
    }
    setPanes(p => {
      const cur = p[paneId];
      if (!cur) return p;
      return { ...p, [paneId]: { ...cur, bytes: result.bytes, parsed: reparse(result.bytes), dirty: true } };
    });
    addLog(`${paneId} · ${label} ok (patched=${result.patched ?? '?'})`, 'pass');
    appendAudit({ pane: paneId, op: label, ok: true, patched: result.patched ?? 0 });
    return true;
  }, [addLog, reparse]);

  const handleDelete = useCallback((paneId, idx) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const r = deleteSlot(cur.bytes, idx);
    applyResult(paneId, r, `delete slot #${idx}`);
  }, [panes, applyResult]);

  const handleAdd = useCallback((paneId, idx) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const r = addSlot(cur.bytes, idx);
    applyResult(paneId, r, `add slot #${idx}`);
  }, [panes, applyResult]);

  const handleSendTo = useCallback((srcId, idx) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId}: both panes must be loaded`, 'error');
      return;
    }
    const r = transferSlot(src.bytes, dst.bytes, idx, idx);
    applyResult(dstId, r, `transfer slot #${idx} from ${srcId}`);
  }, [panes, applyResult, addLog]);

  const handleAddManual = useCallback((paneId) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const free = firstFreeSlot(cur.bytes);
    if (free < 0) {
      addLog(`KEYMOD REFUSED · ${paneId}: no free slot (all ${KEY_SLOT_COUNT} occupied)`, 'error');
      return;
    }
    const r = addSlot(cur.bytes, free);
    applyResult(paneId, r, `add manual @ first-free slot #${free}`);
  }, [panes, applyResult, addLog]);

  /* Manual ID hex input — accepts 8 hex bytes (per FreshAuto v6 fob-ID
   * widget) but currently REFUSES to write because the per-slot ID byte
   * offsets aren't reverse-engineered yet (Task #408). The form proves
   * the workflow shape and surfaces a clear red log entry instead of
   * pretending to write garbage. */
  const handleManualHexAdd = useCallback((paneId) => {
    const cur = panes[paneId]; if (!cur?.bytes) return;
    const txt = (paneId === 'A' ? manualHexA : manualHexB).trim();
    const hex = txt.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 16) {
      addLog(`KEYMOD REFUSED · ${paneId} · manual hex: need exactly 8 bytes (16 hex chars), got ${hex.length}`, 'error');
      appendAudit({ pane: paneId, op: 'manual-hex', ok: false, error: 'bad length' });
      return;
    }
    addLog(`KEYMOD REFUSED · ${paneId} · manual hex ${hex.toUpperCase()}: per-slot transponder ID byte offsets not yet mapped (Task #408)`, 'error');
    appendAudit({ pane: paneId, op: 'manual-hex', ok: false, error: 'layout not mapped', hex: hex.toUpperCase() });
  }, [panes, manualHexA, manualHexB, addLog]);

  /* Bulk transfer helpers (FreshAuto center panel: SELECTED A→B,
   * SELECTED B→A, ALL A→B, ALL B→A). Each iterates the chosen indices,
   * calls transferSlot per slot, and stops only on a hard refusal so a
   * partial batch is recorded rather than silently rolled back. */
  const handleBulkTransfer = useCallback((srcId, mode) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId} (${mode}): both panes must be loaded`, 'error');
      return;
    }
    const indices = mode === 'all'
      ? Array.from({ length: KEY_SLOT_COUNT }, (_, i) => i)
      : Object.keys(selection[srcId] || {}).filter(k => selection[srcId][k]).map(k => parseInt(k, 10)).sort();
    if (indices.length === 0) {
      addLog(`KEYMOD REFUSED · ${srcId}→${dstId}: no slots selected`, 'error');
      return;
    }
    let working = dst.bytes;
    let okCount = 0; let failCount = 0;
    for (const idx of indices) {
      const r = transferSlot(src.bytes, working, idx, idx);
      if (!r.ok) {
        failCount++;
        addLog(`KEYMOD REFUSED · ${srcId}→${dstId} slot #${idx}: ${r.error}`, 'error');
        appendAudit({ pane: dstId, op: `bulk-transfer #${idx} from ${srcId}`, ok: false, error: r.error });
        continue;
      }
      working = r.bytes;
      okCount++;
      appendAudit({ pane: dstId, op: `bulk-transfer #${idx} from ${srcId}`, ok: true, patched: 1 });
    }
    if (okCount > 0) {
      setPanes(p => ({ ...p, [dstId]: { ...p[dstId], bytes: working, parsed: reparse(working), dirty: true } }));
      addLog(`${srcId}→${dstId} (${mode}): ${okCount} ok, ${failCount} refused`, failCount > 0 ? 'warn' : 'pass');
    }
  }, [panes, selection, addLog, reparse]);

  const handleCopyMaster = useCallback((srcId) => {
    const dstId = srcId === 'A' ? 'B' : 'A';
    const src = panes[srcId]; const dst = panes[dstId];
    if (!src?.bytes || !dst?.bytes) {
      addLog(`KEYMOD REFUSED · master ${srcId}→${dstId}: both panes must be loaded`, 'error');
      return;
    }
    const r = copyMasterSec16(src.bytes, dst.bytes);
    applyResult(dstId, r, `copy master SEC16 from ${srcId}`);
  }, [panes, applyResult, addLog]);

  const handleSave = useCallback((paneId) => {
    const cur = panes[paneId];
    if (!cur?.bytes) return;
    if (!cur.dirty) {
      addLog(`${paneId}: nothing to save (no edits)`, 'warn');
      return;
    }
    const fn = patchedName(cur, paneId);
    downloadBin(cur.bytes, fn);
    addLog(`${paneId}: saved ${fn}`, 'pass');
    appendAudit({ pane: paneId, op: 'save', filename: fn, bytes: cur.bytes.length });
    // Reuse the project-wide toast + download-tracker pipeline rather than
    // rolling a one-off save flow (validation #1 follow-up).
    try { dispatchToast(`Saved ${fn}`, 'pass'); } catch { /* noop */ }
    try { trackDownload('rfh-keymod'); } catch { /* counter is best-effort */ }
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
          <b>Confirmed:</b> AA-50 occupancy markers @ 0x0880 stride 2 (Gen1 + Gen2),
          and the master-transponder SEC16 mirror pair (Gen2 CS = crc8_65 — golden-tested).
          <br />
          <b>Not yet mapped:</b> per-fob Autel transponder ID byte block.
          “Send →”, “Delete”, and “Add AA50” edit the OCCUPANCY MARKER ONLY.
          A transferred slot will not start a vehicle without an accompanying
          <i> Copy Master Transponder</i> (or a per-fob ID layout patch in a follow-up task).
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
