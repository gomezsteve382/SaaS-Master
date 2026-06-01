/* ============================================================================
 * KeyDumpPanel.jsx — Task #985
 *
 * Standalone "Key Dump" capture surface. Lives inside the Key Writer tab but
 * works with NO RFHUB dump loaded: an operator types/pastes a transponder read
 * from their external tool (chip family, UID, SK, flags), can copy a record to
 * a new editable key, and exports a labelled JSON manifest + compact .bin.
 *
 * SK (the transponder secret key) is kept explicitly separate from the RFHUB
 * 16-byte SEC16 master secret. The exports are clearly marked as a portable
 * intermediate for the operator's own tool, never a verified vendor import.
 *
 * Optional convenience: when the parent passes a loaded RFHUB slot + SEC16,
 * the operator can prefill the UID field from that slot (SEC16 is surfaced for
 * reference only — it is NOT the SK).
 * ========================================================================== */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { CHIP_FAMILIES } from '../lib/keyWriter/chipFamilies.js';
import {
  makeKeyRecord,
  cloneKeyRecord,
  validateKeyRecord,
  buildKeyDumpManifest,
  buildKeyDumpBin,
  parseKeyDumpBin,
  parseKeyDumpManifest,
  keyDumpBaseName,
  KEY_DUMP_MAGIC,
  CODING_SCHEMES,
} from '../lib/keyDump.js';
import { triggerDownload } from '../lib/keyWriter/autelExport.js';

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexCompact = (bs) => [...bs].map(hex).join('');

let RID = 0;
function freshForm(init) {
  return { _id: ++RID, label: '', chipId: 'pcf7953', uidHex: '', skHex: '', locked: false, encryption: false, cloneable: false, coding: CODING_SCHEMES[0], ...init };
}

/* Convert a parsed keyDump record (from parseKeyDumpBin / parseKeyDumpManifest)
 * into a fresh editable form. */
function recordToForm(rec) {
  return freshForm({
    label: rec.label || '',
    chipId: rec.chipId,
    uidHex: hexCompact(rec.uid || []),
    skHex: hexCompact(rec.sk || []),
    locked: !!rec.locked,
    encryption: !!rec.encryption,
    cloneable: !!rec.cloneable,
    coding: rec.coding || CODING_SCHEMES[0],
  });
}

/* Convert the panel's editable form into the keyDump record shape. */
function formToRecord(form) {
  return makeKeyRecord({
    chipId: form.chipId,
    label: form.label,
    uid: form.uidHex,
    sk: form.skHex,
    locked: form.locked,
    encryption: form.encryption,
    cloneable: form.cloneable,
    coding: form.coding,
  });
}

export default function KeyDumpPanel({ prefillSlot = null, prefillSec16 = null, prefillChipId = null } = {}) {
  const [forms, setForms] = useState(() => [freshForm()]);
  const [activeId, setActiveId] = useState(() => forms[0]._id);

  const activeIdx = useMemo(() => forms.findIndex((f) => f._id === activeId), [forms, activeId]);
  const form = forms[activeIdx] || forms[0];

  const patch = useCallback((p) => {
    setForms((fs) => fs.map((f) => (f._id === activeId ? { ...f, ...p } : f)));
  }, [activeId]);

  const record = useMemo(() => formToRecord(form), [form]);
  const validation = useMemo(() => validateKeyRecord(record), [record]);

  const addNew = useCallback(() => {
    const nf = freshForm();
    setForms((fs) => [...fs, nf]);
    setActiveId(nf._id);
  }, []);

  const fileRef = useRef(null);
  const [importError, setImportError] = useState(null);

  const onPickImport = useCallback(() => {
    setImportError(null);
    fileRef.current?.click();
  }, []);

  const onImportFile = useCallback((e) => {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file re-fires onChange.
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onerror = () => setImportError(`Could not read "${file.name}".`);
    reader.onload = (ev) => {
      const bytes = new Uint8Array(ev.target.result || []);
      // KDMP magic at the head → treat as a raw .bin; otherwise try the JSON
      // manifest. Refuse-on-doubt: a parse failure surfaces and adds no record.
      const isKdmp =
        bytes.length >= KEY_DUMP_MAGIC.length &&
        KEY_DUMP_MAGIC.every((m, i) => bytes[i] === m);
      let res;
      if (isKdmp) {
        res = parseKeyDumpBin(bytes);
      } else {
        let text = '';
        try {
          text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch {
          text = '';
        }
        res = parseKeyDumpManifest(text);
      }
      if (!res.ok) {
        setImportError(`"${file.name}" is not a valid key dump: ${res.error}`);
        return;
      }
      const nf = recordToForm(res.record);
      setForms((fs) => [...fs, nf]);
      setActiveId(nf._id);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const copyToNew = useCallback(() => {
    const cloned = cloneKeyRecord(formToRecord(form));
    const nf = freshForm({
      label: cloned.label,
      chipId: cloned.chipId,
      uidHex: hexCompact(cloned.uid),
      skHex: hexCompact(cloned.sk),
      locked: cloned.locked,
      encryption: cloned.encryption,
      cloneable: cloned.cloneable,
      coding: cloned.coding,
    });
    setForms((fs) => [...fs, nf]);
    setActiveId(nf._id);
  }, [form]);

  const removeActive = useCallback(() => {
    setForms((fs) => {
      if (fs.length <= 1) return [freshForm()];
      const next = fs.filter((f) => f._id !== activeId);
      setActiveId(next[0]._id);
      return next;
    });
  }, [activeId]);

  const onExportJson = useCallback(() => {
    if (!validation.ok) return;
    const json = buildKeyDumpManifest(record);
    triggerDownload(new Blob([json], { type: 'application/json' }), `${keyDumpBaseName(record)}.json`);
  }, [record, validation.ok]);

  const onExportBin = useCallback(() => {
    if (!validation.ok) return;
    const r = buildKeyDumpBin(record);
    if (!r.ok) return;
    triggerDownload(new Blob([r.bin], { type: 'application/octet-stream' }), `${keyDumpBaseName(record)}.bin`);
  }, [record, validation.ok]);

  const onPrefillUid = useCallback(() => {
    if (!prefillSlot?.idBytes) return;
    const chip = CHIP_FAMILIES.find((c) => c.id === (prefillChipId || form.chipId));
    const uidLen = chip?.uidBytes ?? 4;
    const uid = prefillSlot.idBytes.slice(0, uidLen);
    patch({ uidHex: hexCompact(uid), chipId: prefillChipId || form.chipId });
  }, [prefillSlot, prefillChipId, form.chipId, patch]);

  const inputStyle = { width: '100%', padding: 6, fontSize: 12, fontFamily: 'JetBrains Mono', boxSizing: 'border-box' };
  const labelStyle = { fontSize: 10, color: C.tm, letterSpacing: 1.4, marginBottom: 2 };

  return (
    <Card style={{ marginBottom: 16 }} data-testid="key-dump-panel">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ fontSize: 20 }}>🧾</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 900, fontSize: 13, color: C.tx, letterSpacing: 0.5 }}>
            KEY DUMP — CAPTURE &amp; EXPORT (STANDALONE)
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginTop: 2, lineHeight: 1.6 }}>
            Type or paste a transponder read from your external tool (Autel / VVDI). No RFHUB
            dump required. <strong>SK is the chip secret key</strong> the tool calculated — it is
            NOT the RFHUB 16-byte SEC16 master secret. Export is a portable intermediate for
            re-entry into your own programmer, not a verified vendor import format.
          </div>
        </div>
      </div>

      {/* Captured records selector */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {forms.map((f, i) => {
          const sel = f._id === activeId;
          return (
            <button
              key={f._id}
              type="button"
              onClick={() => setActiveId(f._id)}
              data-testid={`keydump-record-${i}`}
              style={{
                padding: '4px 10px',
                border: `2px solid ${sel ? C.a3 : C.bd}`,
                borderRadius: 6,
                background: sel ? C.a3 + '14' : C.bg,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: sel ? 800 : 500,
                color: C.tx,
              }}
            >
              {f.label?.trim() || `Key ${i + 1}`}
            </button>
          );
        })}
        <Btn onClick={addNew} color={C.tm} outline style={{ fontSize: 10, padding: '2px 8px' }} data-testid="keydump-add">
          + New key
        </Btn>
        <Btn onClick={onPickImport} color={C.a3} outline style={{ fontSize: 10, padding: '2px 8px' }} data-testid="keydump-import">
          ↥ Import saved dump
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept=".bin,.json,application/json,application/octet-stream"
          onChange={onImportFile}
          data-testid="keydump-import-input"
          style={{ display: 'none' }}
        />
      </div>

      {importError && (
        <div style={{ fontSize: 12, color: C.er, marginBottom: 10, fontWeight: 700 }} data-testid="keydump-import-error">
          ✗ {importError}
        </div>
      )}

      {/* Form */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <label style={{ gridColumn: '1 / -1' }}>
          <div style={labelStyle}>LABEL (optional)</div>
          <input
            type="text"
            value={form.label}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="e.g. 2019 Charger key #2"
            data-testid="keydump-label"
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          />
        </label>

        <label>
          <div style={labelStyle}>CHIP FAMILY</div>
          <select
            value={form.chipId}
            onChange={(e) => patch({ chipId: e.target.value })}
            data-testid="keydump-chip"
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          >
            {CHIP_FAMILIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>

        <label>
          <div style={labelStyle}>CODING SCHEME</div>
          <select
            value={form.coding}
            onChange={(e) => patch({ coding: e.target.value })}
            data-testid="keydump-coding"
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          >
            {CODING_SCHEMES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label>
          <div style={labelStyle}>UID (hex)</div>
          <input
            type="text"
            value={form.uidHex}
            onChange={(e) => patch({ uidHex: e.target.value })}
            placeholder="437C2C9F"
            data-testid="keydump-uid"
            style={inputStyle}
          />
        </label>

        <label>
          <div style={labelStyle}>SK — transponder secret key (hex)</div>
          <input
            type="text"
            value={form.skHex}
            onChange={(e) => patch({ skHex: e.target.value })}
            placeholder="4F4E4D494B52"
            data-testid="keydump-sk"
            style={inputStyle}
          />
        </label>
      </div>

      {/* Flags */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10, fontSize: 12, color: C.tx }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.locked} onChange={(e) => patch({ locked: e.target.checked })} data-testid="keydump-locked" />
          Locked
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.encryption} onChange={(e) => patch({ encryption: e.target.checked })} data-testid="keydump-encryption" />
          Encryption mode
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.cloneable} onChange={(e) => patch({ cloneable: e.target.checked })} data-testid="keydump-cloneable" />
          Cloneable
        </label>
      </div>

      {/* Optional RFHUB prefill */}
      {prefillSlot?.idBytes && (
        <div style={{ padding: 10, border: `1px dashed ${C.bd}`, borderRadius: 8, marginBottom: 10, fontSize: 11, color: C.ts }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={onPrefillUid} color={C.tm} outline style={{ fontSize: 11 }} data-testid="keydump-prefill">
              Prefill UID from RFHUB slot {prefillSlot.idx + 1}
            </Btn>
            <span>Fills the UID from the selected slot. SK still comes from your tool read.</span>
          </div>
          {prefillSec16 && prefillSec16.length === 16 && (
            <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono', color: C.tm }}>
              RFHUB SEC16 (reference only — NOT the SK): {hexCompact(prefillSec16)}
            </div>
          )}
        </div>
      )}

      {/* Validation + actions */}
      {validation.ok ? (
        <div style={{ fontSize: 12, color: C.gn, marginBottom: 10 }} data-testid="keydump-valid">
          ✓ Valid {validation.chip.label} key — UID {validation.uid.length} B, SK {validation.sk.length} B.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.er, marginBottom: 10, fontWeight: 700 }} data-testid="keydump-error">
          ✗ {validation.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn onClick={copyToNew} color={C.tm} outline data-testid="keydump-copy">
          ⧉ Copy to new key
        </Btn>
        <Btn onClick={onExportJson} color={C.gn} disabled={!validation.ok} data-testid="keydump-export-json">
          ↓ Export JSON manifest
        </Btn>
        <Btn onClick={onExportBin} color={C.tm} outline disabled={!validation.ok} data-testid="keydump-export-bin">
          ↓ Export raw .bin
        </Btn>
        {forms.length > 1 && (
          <Btn onClick={removeActive} color={C.er} outline data-testid="keydump-remove">
            ✕ Remove this key
          </Btn>
        )}
      </div>
    </Card>
  );
}
