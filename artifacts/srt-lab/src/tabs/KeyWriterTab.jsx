/* ============================================================================
 * KeyWriterTab.jsx — Task #862
 *
 * Hand RFHUB slot bytes to a commercial transponder writer (Xhorse VVDI
 * Mini / Tango) so a locksmith can burn a fresh chip without leaving
 * SRT Lab. The actual burn happens on the writer; this tab is the
 * bridge — slot picker, chip family picker, transport (Web Serial /
 * simulator), then ping → detect → burn → verify with refuse-on-doubt
 * gating and a step-by-step audit log.
 *
 * After a successful burn the operator hands the freshly-burned chip
 * back to the existing RoutineControl 0x0401 pairing flow on the
 * RfhubTab — see docs/key-writer-bridge.md for the full handoff.
 * ========================================================================== */

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { C } from '../lib/constants.js';
import { MasterVinContext } from '../lib/masterVinContext.jsx';
import { Card, Tag, Btn } from '../lib/ui.jsx';
import { parseKeySlots, KEY_ID_BLOCK_LEN, writeKeyRecordToSlot, firstFreeSlot } from '../lib/rfhubKeySlots.js';
import { CHIP_FAMILIES, chipForRfhubGen, chipFamily } from '../lib/keyWriter/chipFamilies.js';
import {
  CODING_SCHEMES,
  makeKeyRecord,
  cloneKeyRecord,
  validateKeyRecord,
  bytesToHexSpaced,
} from '../lib/keyWriter/keyRecord.js';
import { SimulatorTransport, FAULT_HANDLERS } from '../lib/keyWriter/simulator.js';
import { connectWebSerial, isWebSerialAvailable } from '../lib/keyWriter/webSerialTransport.js';
import { HttpTransport, probeHttpTransport } from '../lib/keyWriter/httpTransport.js';
import { burnSlot } from '../lib/keyWriter/index.js';
import { buildPingRequest } from '../lib/keyWriter/serializer.js';
import { parseFrame, CMD } from '../lib/keyWriter/protocol.js';
import {
  buildAutelExportData,
  buildJsonManifest,
  buildRawBin,
  triggerDownload,
  exportBaseName,
  buildKeyDumpManifest,
  buildKeyDumpBin,
  keyDumpBaseName,
} from '../lib/keyWriter/autelExport.js';
import {
  loadKeyHistory,
  saveKeyToHistory,
  removeKeyFromHistory,
  clearKeyHistory,
  buildKeyHistoryExport,
  importKeyHistory,
  refreshKeyHistoryFromServer,
  readKeyHistoryImportVin,
} from '../lib/keyWriter/keyHistory.js';

const WRITERS = [
  { id: 'vvdi-mini', label: 'Xhorse VVDI Mini Key Tool' },
  { id: 'tango',     label: 'Tango Key Programmer (experimental)' },
];

const SIM_PROFILES = [
  { id: 'happy',      label: 'All steps succeed',     handler: null },
  { id: 'noChip',     label: 'No chip on coil',       handler: FAULT_HANDLERS.noChip },
  { id: 'wrongChip',  label: 'Wrong chip family',     handler: FAULT_HANDLERS.wrongChip },
  { id: 'locked',     label: 'Locked chip',           handler: FAULT_HANDLERS.locked },
  { id: 'verifyFail', label: 'Verify mismatch',       handler: FAULT_HANDLERS.verifyFail },
];

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexJoin = (bs) => [...bs].map(hex).join(' ');
const hexCompact = (bs) => [...bs].map(hex).join('');

/* Shared audit ring buffer — same storage key + event channel KeyManagerTab,
 * RfhubTab and BackupsTab use (see KeyManagerTab.jsx). Mirroring the helper
 * here (rather than importing) keeps this tab a leaf that doesn't pull in
 * KeyManagerTab's React tree just for one persistence call. */
const AUDIT_KEY = 'srt-lab.keymgr.audit.v1';
const AUDIT_LIMIT = 500;
function appendAudit(entry) {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({ ts: new Date().toISOString(), ...entry });
    while (arr.length > AUDIT_LIMIT) arr.shift();
    globalThis.localStorage?.setItem(AUDIT_KEY, JSON.stringify(arr));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('srtlab:audit', { detail: entry }));
    }
  } catch { /* localStorage may be denied in test sandboxes */ }
}

/* VIN extraction mirrors KeyManagerTab.extractRfhVin — kept inline so this
 * tab doesn't take a dep on the other tab's module. */
function extractRfhVin(bytes, gen) {
  if (!bytes) return null;
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
  /* parseKeySlots reports gen as a number (1, 2) — but legacy callers used
   * the string 'gen2'. Accept either. */
  const isGen2 = gen === 'gen2' || gen === 2 || gen >= 2;
  if (isGen2) return tryAsciiReversed(0x0EA5) || tryAscii(0x92);
  return tryAscii(0x92);
}

function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsArrayBuffer(file);
  });
}

export default function KeyWriterTab({ onOpenTab } = {}) {
  const [rfhFile, setRfhFile] = useState(null);
  const [rfhBytes, setRfhBytes] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [slotIdx, setSlotIdx] = useState(null);

  const [chipId, setChipId] = useState('pcf7953');
  const [writerId, setWriterId] = useState('vvdi-mini');

  const [mode, setMode] = useState('sim'); // 'sim' | 'webserial' | 'http'
  const [simProfile, setSimProfile] = useState('happy');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [log, setLog] = useState([]);
  const [serialError, setSerialError] = useState(null);
  const transportRef = useRef(null);
  // Detected writer model + firmware (populated by Detect button).
  const [writerInfo, setWriterInfo] = useState(null); // {model, firmware, source}
  // HTTP fallback probe — null = not probed, false = unavailable, {available,reason,...}.
  const [httpProbe, setHttpProbe] = useState(null);

  /* ── Standalone key-dump capture (Task #985) ──────────────────────────
   * keyRecords is a small in-memory list the operator builds by hand from
   * external bench-tool reads; "Copy to new key" clones the active record. */
  const [keyRecords, setKeyRecords] = useState(() => [makeKeyRecord()]);
  const [activeKeyId, setActiveKeyId] = useState(null);
  const [cloneSlotIdx, setCloneSlotIdx] = useState(null); // target free slot for write-to-RFHUB
  const [cloneResult, setCloneResult] = useState(null);
  const [keyDumpNote, setKeyDumpNote] = useState(null);   // transient prefill/export status

  /* ── Per-vehicle key history (Task #986) ──────────────────────────────────
   * Captured keys persist (localStorage) keyed by the active Master VIN so a
   * locksmith can see every key on file for a car at a glance and re-load any
   * of them back into the Key Dump card for re-export / clone-on-bench. */
  const { vin: masterVin, vinValid } = useContext(MasterVinContext);
  const [keyHistory, setKeyHistory] = useState([]);
  useEffect(() => {
    // Render the localStorage cache synchronously, then hydrate from the server
    // so history saved on another device/browser for this VIN shows up here.
    // The async result is the canonical merged list (server + local-only).
    setKeyHistory(loadKeyHistory(masterVin));
    let cancelled = false;
    refreshKeyHistoryFromServer(masterVin)
      .then((list) => { if (!cancelled) setKeyHistory(list); })
      .catch(() => { /* offline — keep the local cache already shown */ });
    return () => { cancelled = true; };
  }, [masterVin]);

  const onLoadRfh = useCallback(async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRfhFile(f);
    setParseError(null);
    setParsed(null);
    setSlotIdx(null);
    setResult(null);
    setLog([]);
    try {
      const bytes = await readFileBytes(f);
      setRfhBytes(bytes);
      const p = parseKeySlots(bytes);
      if (!p.ok) { setParseError(p.error || 'parseKeySlots failed'); return; }
      setParsed(p);
      const def = chipForRfhubGen(p.gen);
      if (def) setChipId(def);
      // Auto-select first occupied + mapped slot.
      const firstOcc = p.slots.find((s) => s.occupied && s.idMapped);
      if (firstOcc) setSlotIdx(firstOcc.idx);
    } catch (e2) {
      setParseError(e2.message || String(e2));
    }
  }, []);

  const slot = useMemo(() => {
    if (!parsed || slotIdx == null) return null;
    return parsed.slots.find((s) => s.idx === slotIdx) || null;
  }, [parsed, slotIdx]);

  // SEC16 slot 1 is canonical (the "master" — both slots are mirrored on
  // a healthy RFHUB; parser already exposes match=true/false).
  const secret16 = useMemo(() => parsed?.sec16?.slots?.[0]?.raw || null, [parsed]);
  const secretBlank = useMemo(() => {
    if (!secret16) return true;
    let allFF = true, all00 = true;
    for (let i = 0; i < secret16.length; i++) {
      if (secret16[i] !== 0xFF) allFF = false;
      if (secret16[i] !== 0x00) all00 = false;
    }
    return allFF || all00;
  }, [secret16]);

  // Mirror the serializer's refuse-on-doubt gates so the button never
  // enables for a combination buildBurnRequest() would reject.
  const chipDef = useMemo(() => CHIP_FAMILIES.find((c) => c.id === chipId) || null, [chipId]);
  const idShapeMatch = !!(slot?.idBytes && chipDef && slot.idBytes.length === chipDef.uidBytes + chipDef.payloadBytes);
  const writerSupported = !!(chipDef && chipDef.writers.includes(writerId));
  const canBurn =
    parsed && slot && slot.occupied && slot.idMapped &&
    secret16 && !secretBlank &&
    chipDef && idShapeMatch && writerSupported &&
    !busy;

  const connectSerial = useCallback(async () => {
    setSerialError(null);
    try {
      const t = await connectWebSerial({});
      transportRef.current = t;
      setMode('webserial');
    } catch (e) {
      setSerialError(e.message || String(e));
    }
  }, []);

  const disconnectSerial = useCallback(async () => {
    try { await transportRef.current?.close(); } catch { /* ignore */ }
    transportRef.current = null;
    setWriterInfo(null);
    setMode('sim');
  }, []);

  // Probe the api-server fallback. Caches result in component state so the
  // operator can decide to switch into HTTP mode without re-probing.
  const probeHttp = useCallback(async () => {
    setSerialError(null);
    const p = await probeHttpTransport({});
    setHttpProbe(p);
    if (p.available) {
      try { await transportRef.current?.close(); } catch { /* ignore */ }
      transportRef.current = new HttpTransport({});
      setMode('http');
      if (p.model || p.firmware) {
        setWriterInfo({ model: p.model || 'unknown', firmware: p.firmware || 'unknown', source: 'http-status' });
      }
    }
  }, []);

  // PING the live writer (Web Serial or HTTP) and surface model + firmware.
  // The ACK payload for CMD_PING is documented as
  //   [status, modelId, fwMajor, fwMinor]
  // in docs/key-writer-bridge.md. Refuse-on-doubt: if the response is not a
  // CMD_PING ACK we leave writerInfo untouched and surface the error.
  const detectWriter = useCallback(async () => {
    const t = transportRef.current;
    if (!t) {
      setSerialError('Connect Web Serial or enable the HTTP fallback first.');
      return;
    }
    setSerialError(null);
    try {
      const built = buildPingRequest();
      if (!built.ok) throw new Error('failed to build ping request');
      const respBytes = await t.send(built.frame);
      const parsed = parseFrame(respBytes);
      if (!parsed.ok || !parsed.frame || parsed.frame.cmd !== CMD.ACK) {
        throw new Error(`unexpected ping reply (${parsed.error || 'cmd 0x' + (parsed.frame?.cmd ?? 0).toString(16)})`);
      }
      const p = parsed.frame.payload || new Uint8Array();
      if (p.length < 4) throw new Error(`short ping payload (${p.length} bytes)`);
      const modelMap = { 0x01: 'VVDI Mini Key Tool', 0x02: 'Tango' };
      const model = modelMap[p[1]] || `unknown (0x${p[1].toString(16)})`;
      const fw = `v${p[2]}.${p[3]}`;
      setWriterInfo({ model, firmware: fw, source: mode });
    } catch (e) {
      setSerialError(`Detect failed: ${e.message || e}`);
      setWriterInfo(null);
    }
  }, [mode]);

  const openRfhubHandoff = useCallback(() => {
    if (!slot) return;
    try {
      sessionStorage.setItem('srtlab:keywriter:handoff', JSON.stringify({
        slotIdx: slot.idx,
        chipId,
        writerId,
        at: Date.now(),
      }));
    } catch { /* ignore — sessionStorage can be disabled */ }
    onOpenTab?.('rfhub');
  }, [slot, chipId, writerId, onOpenTab]);

  const runBurn = useCallback(async () => {
    if (!slot || !secret16) return;
    setBusy(true);
    setResult(null);
    setLog([{ at: Date.now(), level: 'info', msg: `Starting ${mode === 'sim' ? 'simulated' : 'live'} burn — slot ${slot.idx}, chip ${chipId}, writer ${writerId}` }]);
    let transport = transportRef.current;
    let createdSim = false;
    if (mode === 'sim') {
      const prof = SIM_PROFILES.find((p) => p.id === simProfile);
      transport = new SimulatorTransport({ latencyMs: 60, handler: prof?.handler || undefined });
      createdSim = true;
    }
    if (!transport) {
      setLog((L) => [...L, { at: Date.now(), level: 'err', msg: 'No transport connected. Connect Web Serial or use Simulator mode.' }]);
      setBusy(false);
      return;
    }
    /* VIN + per-burn audit context. The audit payload deliberately omits
     * secret16 (the SEC16 master) — the audit row only carries identifiers
     * the operator needs to reconcile the burn against a job, never the
     * material that would let someone reproduce the chip off-bench. */
    const vin = extractRfhVin(rfhBytes, parsed?.gen) || 'NOVIN';
    const auditBase = {
      source: 'keywriter',
      op: 'chip-burn',
      vin,
      slotIdx: slot.idx,
      chipId,
      writer: writerId,
      transport: mode,
      simProfile: mode === 'sim' ? simProfile : null,
    };
    try {
      const res = await burnSlot({
        transport, slot, chipId, writer: writerId, secret16,
      });
      const entries = res.steps.map((s) => ({
        at: Date.now(),
        level: s.ok ? 'ok' : 'err',
        msg: `[${s.label.toUpperCase()}] ${s.ok ? 'OK' : (s.error || 'FAILED')} — ${s.detail || ''}`,
      }));
      setLog((L) => [
        ...L,
        ...entries,
        { at: Date.now(), level: res.ok ? 'ok' : 'err',
          msg: res.ok
            ? `KEYMOD WRITTEN — slot ${slot.idx} burned and verified. Hand chip to RFHUB tab for RoutineControl 0x0401 pairing.`
            : `KEYMOD REFUSED — failed at step "${res.failedAt}".` },
      ]);
      setResult(res);
      /* Persist to shared audit channel. Step trace carries label/ok/error/
       * detail only — burnSlot's `steps` shape already excludes raw secret
       * material, but we re-pick fields explicitly so a future shape change
       * can't leak SEC16 by accident. */
      appendAudit({
        ...auditBase,
        ok: !!res.ok,
        outcome: res.ok ? 'KEYMOD WRITTEN' : 'KEYMOD REFUSED',
        failedAt: res.failedAt || null,
        steps: (res.steps || []).map((s) => ({
          label: s.label,
          ok: !!s.ok,
          error: s.error || null,
          detail: s.detail || null,
        })),
      });
    } catch (e) {
      const msg = e?.message || String(e);
      setLog((L) => [...L, { at: Date.now(), level: 'err', msg: `KEYMOD REFUSED — transport error: ${msg}` }]);
      setResult({ ok: false, failedAt: 'transport', steps: [] });
      appendAudit({
        ...auditBase,
        ok: false,
        outcome: 'KEYMOD REFUSED',
        failedAt: 'transport',
        error: msg,
        steps: [],
      });
    } finally {
      if (createdSim) transport.close?.();
      setBusy(false);
    }
  }, [slot, secret16, mode, simProfile, chipId, writerId, rfhBytes, parsed]);

  /* ── Standalone key-dump capture / clone / export (Task #985) ──────────── */
  const activeRecord = useMemo(
    () => keyRecords.find((r) => r.id === activeKeyId) || keyRecords[0],
    [keyRecords, activeKeyId],
  );
  const keyValidation = useMemo(() => validateKeyRecord(activeRecord), [activeRecord]);
  const keyChipDef = useMemo(() => chipFamily(activeRecord?.chipId), [activeRecord]);

  const updateActive = useCallback((patch) => {
    setKeyRecords((rs) => rs.map((r) => (r.id === activeRecord?.id ? { ...r, ...patch } : r)));
  }, [activeRecord]);

  const updateActiveFlags = useCallback((flagPatch) => {
    setKeyRecords((rs) => rs.map((r) => (
      r.id === activeRecord?.id ? { ...r, flags: { ...r.flags, ...flagPatch } } : r
    )));
  }, [activeRecord]);

  const onAddBlankKey = useCallback(() => {
    const rec = makeKeyRecord();
    setKeyRecords((rs) => [...rs, rec]);
    setActiveKeyId(rec.id);
    setCloneResult(null);
    setKeyDumpNote(null);
  }, []);

  const onCopyToNewKey = useCallback(() => {
    const cur = keyRecords.find((r) => r.id === activeKeyId) || keyRecords[0];
    if (!cur) return;
    const cloned = cloneKeyRecord(cur);
    setKeyRecords((rs) => [...rs, cloned]);
    setActiveKeyId(cloned.id);
    setCloneResult(null);
    setKeyDumpNote({ ok: true, msg: `Cloned "${cur.label || 'Key'}" → editable copy. SK/UID carried over; edit before export.` });
  }, [keyRecords, activeKeyId]);

  const onExportKeyJson = useCallback(() => {
    const v = validateKeyRecord(activeRecord);
    if (!v.ok) { setKeyDumpNote({ ok: false, msg: v.error }); return; }
    const json = buildKeyDumpManifest(activeRecord, v);
    triggerDownload(new Blob([json], { type: 'application/json' }), `${keyDumpBaseName(activeRecord)}.json`);
    appendAudit({ source: 'keywriter', op: 'key-dump-export-json', chipId: activeRecord.chipId, ok: true });
    setKeyDumpNote({ ok: true, msg: 'Key-dump JSON manifest downloaded (portable intermediate — not a vendor import).' });
  }, [activeRecord]);

  const onExportKeyBin = useCallback(() => {
    const v = validateKeyRecord(activeRecord);
    if (!v.ok) { setKeyDumpNote({ ok: false, msg: v.error }); return; }
    const bin = buildKeyDumpBin({ uid: v.uid, sk: v.sk, flags: activeRecord.flags, chipId: activeRecord.chipId });
    triggerDownload(new Blob([bin], { type: 'application/octet-stream' }), `${keyDumpBaseName(activeRecord)}.bin`);
    appendAudit({ source: 'keywriter', op: 'key-dump-export-bin', chipId: activeRecord.chipId, ok: true });
    setKeyDumpNote({ ok: true, msg: 'Compact KDMP .bin downloaded (portable intermediate — not a vendor import).' });
  }, [activeRecord]);

  /* Prefill the active record from the currently-picked RFHUB slot: copy the
   * slot UID only. SK is left blank (it is the transponder secret, captured
   * from your external tool — never the SEC16 master). SEC16 is surfaced for
   * reference but never written into the SK field. */
  const onPrefillFromSlot = useCallback(() => {
    if (!slot?.idBytes) { setKeyDumpNote({ ok: false, msg: 'Pick an RFHUB slot with an ID block first.' }); return; }
    const uidLen = keyChipDef?.uidBytes || 4;
    const uidBytes = slot.idBytes.slice(0, uidLen);
    updateActive({ uidHex: bytesToHexSpaced(uidBytes) });
    const sec16Hex = secret16 ? bytesToHexSpaced(secret16) : '(none loaded)';
    setKeyDumpNote({
      ok: true,
      msg: `UID copied from slot ${slot.idx + 1}. SK left blank — enter the transponder SK from your tool. This RFHUB's SEC16 master (reference only, NOT the SK): ${sec16Hex}`,
    });
  }, [slot, keyChipDef, secret16, updateActive]);

  /* Clone-on-bench: write the captured UID into a chosen free RFHUB slot and
   * download the patched dump to flash back. Refuses against a blank SEC16. */
  const onWriteToRfhub = useCallback(() => {
    setCloneResult(null);
    const v = validateKeyRecord(activeRecord);
    if (!v.ok) { setCloneResult({ ok: false, error: v.error }); return; }
    if (!rfhBytes || !parsed) { setCloneResult({ ok: false, error: 'Load an RFHUB dump first (section 1).' }); return; }
    if (secretBlank) { setCloneResult({ ok: false, error: 'RFHUB SEC16 is blank — cannot register a key against a virgin master secret.' }); return; }
    const idx = cloneSlotIdx != null ? cloneSlotIdx : firstFreeSlot(rfhBytes);
    if (idx == null || idx < 0) { setCloneResult({ ok: false, error: 'No free slot available — delete a key first or pick a slot.' }); return; }
    const r = writeKeyRecordToSlot(rfhBytes, idx, { uid: v.uid });
    if (!r.ok) { setCloneResult({ ok: false, error: r.error }); return; }
    const base = exportBaseName(rfhFile?.name, idx).replace(/_autel$/, '_cloned');
    triggerDownload(new Blob([r.bytes], { type: 'application/octet-stream' }), `${base}.bin`);
    appendAudit({
      source: 'keywriter',
      op: 'key-clone-to-rfhub',
      vin: extractRfhVin(rfhBytes, parsed?.gen) || 'NOVIN',
      slotIdx: idx,
      chipId: activeRecord.chipId,
      payloadKnown: r.payloadKnown,
      ok: true,
    });
    setCloneResult({ ok: true, slotIdx: idx, payloadKnown: r.payloadKnown });
  }, [activeRecord, rfhBytes, parsed, secretBlank, cloneSlotIdx, rfhFile]);

  const freeSlots = useMemo(
    () => (parsed?.slots || []).filter((s) => !s.occupied).map((s) => s.idx),
    [parsed],
  );

  /* ── Per-vehicle key history actions (Task #986) ──────────────────────── */

  /* Save the active captured key under the Master VIN. Requires a valid VIN
   * and a record that passes the same refuse-on-doubt validation the exports
   * use. The associated RFHUB slot (if one is picked) is recorded so the list
   * can show which slot each key maps to. */
  const onSaveToHistory = useCallback(() => {
    if (!vinValid) {
      setKeyDumpNote({ ok: false, msg: 'Set a valid 17-char Master VIN first (top of the workspace) to save this key to the vehicle history.' });
      return;
    }
    const v = validateKeyRecord(activeRecord);
    if (!v.ok) { setKeyDumpNote({ ok: false, msg: v.error }); return; }
    const res = saveKeyToHistory(masterVin, {
      chipId: activeRecord.chipId,
      uidHex: activeRecord.uidHex,
      skHex: activeRecord.skHex,
      flags: activeRecord.flags,
      label: activeRecord.label,
      slotIdx: slot ? slot.idx : (cloneSlotIdx != null ? cloneSlotIdx : null),
    });
    if (!res.ok) { setKeyDumpNote({ ok: false, msg: res.error }); return; }
    setKeyHistory(res.list);
    appendAudit({
      source: 'keywriter',
      op: 'key-history-save',
      vin: masterVin,
      chipId: activeRecord.chipId,
      slotIdx: res.entry.slotIdx,
      ok: true,
    });
    setKeyDumpNote({ ok: true, msg: `Saved to vehicle history for ${masterVin}. ${res.list.length} key${res.list.length === 1 ? '' : 's'} on file.` });
  }, [vinValid, activeRecord, masterVin, slot, cloneSlotIdx]);

  /* Re-load a saved key back into the Key Dump card as a fresh, editable
   * record so the operator can re-export it or send it to clone-on-bench. */
  const onLoadFromHistory = useCallback((entry) => {
    if (!entry) return;
    const rec = makeKeyRecord({
      chipId: entry.chipId,
      uidHex: entry.uidHex,
      skHex: entry.skHex,
      flags: entry.flags,
      label: entry.label,
    });
    setKeyRecords((rs) => [...rs, rec]);
    setActiveKeyId(rec.id);
    setCloneResult(null);
    setKeyDumpNote({ ok: true, msg: `Loaded "${entry.label || 'saved key'}" from history into the Key Dump card. Edit, re-export, or clone on bench.` });
  }, []);

  const onRemoveFromHistory = useCallback((id) => {
    const res = removeKeyFromHistory(masterVin, id);
    setKeyHistory(res.list);
  }, [masterVin]);

  const onClearHistory = useCallback(() => {
    const res = clearKeyHistory(masterVin);
    setKeyHistory(res.list);
    setKeyDumpNote({ ok: true, msg: `Cleared all saved keys for ${masterVin}.` });
  }, [masterVin]);

  /* Export the whole key set on file for this VIN as one portable wrapper file
   * (Task #992). Mirrors the J2534 "EXPORT ALL" baseline pattern. */
  const keyHistoryImportRef = useRef(null);

  const onExportAllKeys = useCallback(() => {
    if (!vinValid) {
      setKeyDumpNote({ ok: false, msg: 'Set a valid 17-char Master VIN first to export this vehicle\u2019s key set.' });
      return;
    }
    if (keyHistory.length === 0) {
      setKeyDumpNote({ ok: false, msg: 'No keys on file to export for this vehicle yet.' });
      return;
    }
    const payload = buildKeyHistoryExport(masterVin, keyHistory);
    const json = JSON.stringify(payload, null, 2);
    triggerDownload(new Blob([json], { type: 'application/json' }), `srtlab_keyset_${masterVin}.json`);
    appendAudit({ source: 'keywriter', op: 'key-history-export-all', vin: masterVin, count: keyHistory.length, ok: true });
    setKeyDumpNote({ ok: true, msg: `Exported all ${keyHistory.length} key${keyHistory.length === 1 ? '' : 's'} on file for ${masterVin} as one wrapper file.` });
  }, [vinValid, masterVin, keyHistory]);

  const onImportKeysFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    if (!vinValid) {
      setKeyDumpNote({ ok: false, msg: 'Set a valid 17-char Master VIN first to import a key set onto this vehicle.' });
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch {
      setKeyDumpNote({ ok: false, msg: 'Could not read the selected file.' });
      return;
    }
    const wrapperVin = readKeyHistoryImportVin(text);
    if (wrapperVin && wrapperVin !== masterVin) {
      const proceed = typeof window === 'undefined' || typeof window.confirm !== 'function'
        || window.confirm(
          `This key set was exported from ${wrapperVin}, but the active Master VIN is ${masterVin}.\n\n` +
          'Importing will fold these keys into the current vehicle. Continue anyway?'
        );
      if (!proceed) {
        setKeyDumpNote({ ok: false, msg: `Import cancelled — key set belongs to ${wrapperVin}, not ${masterVin}.` });
        return;
      }
    }
    const res = importKeyHistory(masterVin, text);
    if (!res.ok) { setKeyDumpNote({ ok: false, msg: res.error }); return; }
    setKeyHistory(res.list);
    appendAudit({ source: 'keywriter', op: 'key-history-import', vin: masterVin, imported: res.imported, ok: true });
    setKeyDumpNote({ ok: true, msg: `Imported ${res.imported} key${res.imported === 1 ? '' : 's'} into ${masterVin}. ${res.list.length} now on file.` });
  }, [vinValid, masterVin]);

  return (
    <div data-testid="key-writer-tab">
      {/* Header / disclaimer */}
      <Card style={{ marginBottom: 16, background: '#FFF3E0', borderColor: '#FF8F00' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 24 }}>🗝️</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: '#7A3800', letterSpacing: 0.5 }}>
              TRANSPONDER WRITER BRIDGE — BENCH USE ONLY
            </div>
            <div style={{ fontSize: 12, color: '#7A3800', marginTop: 4, lineHeight: 1.6 }}>
              Hands a single RFHUB slot's chip bytes to an attached writer
              (Xhorse VVDI Mini, Tango). The writer burns the physical
              transponder; pairing on the car still goes through the
              RFHUB tab's RoutineControl 0x0401 flow. SEC16 master secret
              never leaves the browser; nothing is uploaded.
            </div>
            <div style={{ fontSize: 11, color: '#7A3800', marginTop: 6, fontStyle: 'italic' }}>
              Protocol framing matches public Xhorse VVDI Mini USB-CDC captures and has NOT been bench-verified in this codebase. Use the Simulator first; treat live burns as field-verification of the framing.
            </div>
          </div>
        </div>
      </Card>

      {/* ── Standalone Key Dump: capture, clone & export (Task #985) ── */}
      <Card style={{ marginBottom: 16 }} data-testid="key-dump-card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>Key Dump — capture, clone &amp; export</span>
          <Tag color={C.a3}>standalone</Tag>
          <span style={{ flex: 1 }} />
          <Btn onClick={onAddBlankKey} color={C.tm} outline data-testid="key-dump-add" style={{ fontSize: 11, padding: '3px 10px' }}>
            + New blank key
          </Btn>
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          Type or paste a transponder read from your external tool (Autel / VVDI). Works with no RFHUB loaded.{' '}
          <strong>SK is the transponder secret your tool calculated — NOT the 16-byte RFHUB SEC16 master.</strong>
        </div>

        {/* record tabs */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }} data-testid="key-dump-tabs">
          {keyRecords.map((r, i) => {
            const on = r.id === activeRecord?.id;
            return (
              <button
                key={r.id}
                onClick={() => { setActiveKeyId(r.id); setCloneResult(null); setKeyDumpNote(null); }}
                data-testid={`key-dump-tab-${i}`}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  border: `2px solid ${on ? C.a3 : C.bd}`, background: on ? C.a3 + '14' : C.bg, color: C.tx,
                }}
              >
                {r.label?.trim() ? r.label : `Key ${i + 1}`}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>CHIP FAMILY</div>
            <select
              value={activeRecord?.chipId || ''}
              onChange={(e) => updateActive({ chipId: e.target.value })}
              data-testid="key-dump-chip"
              style={{ width: '100%', padding: 6, fontSize: 12 }}
            >
              {CHIP_FAMILIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>LABEL</div>
            <input
              type="text"
              value={activeRecord?.label || ''}
              onChange={(e) => updateActive({ label: e.target.value })}
              placeholder="e.g. spare fob #2"
              data-testid="key-dump-label"
              style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>
              UID HEX{keyChipDef?.uidBytes ? ` (expect ${keyChipDef.uidBytes} B)` : ''}
            </div>
            <input
              type="text"
              value={activeRecord?.uidHex || ''}
              onChange={(e) => updateActive({ uidHex: e.target.value })}
              placeholder="00 77 A2 9B"
              data-testid="key-dump-uid"
              style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'JetBrains Mono', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>
              SK HEX — transponder secret{keyChipDef?.skBytes ? ` (expect ${keyChipDef.skBytes} B)` : ''}
            </div>
            <input
              type="text"
              value={activeRecord?.skHex || ''}
              onChange={(e) => updateActive({ skHex: e.target.value })}
              placeholder="4F 4E 4D 49 4B 52"
              data-testid="key-dump-sk"
              style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'JetBrains Mono', boxSizing: 'border-box' }}
            />
          </label>
        </div>

        {/* flags */}
        <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }} data-testid="key-dump-flags">
          <label style={{ fontSize: 12, color: C.tx, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!!activeRecord?.flags?.locked} onChange={(e) => updateActiveFlags({ locked: e.target.checked })} data-testid="key-dump-flag-locked" />
            Locked
          </label>
          <label style={{ fontSize: 12, color: C.tx, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!!activeRecord?.flags?.encryption} onChange={(e) => updateActiveFlags({ encryption: e.target.checked })} data-testid="key-dump-flag-encryption" />
            Encryption
          </label>
          <label style={{ fontSize: 12, color: C.tx, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!!activeRecord?.flags?.cloneable} onChange={(e) => updateActiveFlags({ cloneable: e.target.checked })} data-testid="key-dump-flag-cloneable" />
            Cloneable
          </label>
          <label style={{ fontSize: 12, color: C.tx, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2 }}>CODING</span>
            <select
              value={activeRecord?.flags?.coding || ''}
              onChange={(e) => updateActiveFlags({ coding: e.target.value })}
              data-testid="key-dump-flag-coding"
              style={{ padding: 4, fontSize: 12 }}
            >
              {CODING_SCHEMES.map((cs) => (
                <option key={cs.id} value={cs.id}>{cs.label}</option>
              ))}
            </select>
          </label>
        </div>

        {/* validation line */}
        <div style={{ marginTop: 10, fontSize: 12 }} data-testid="key-dump-validation">
          {keyValidation.ok
            ? <span style={{ color: C.gn, fontWeight: 700 }}>✓ Valid — UID {keyValidation.uid.length} B, SK {keyValidation.sk.length} B</span>
            : <span style={{ color: C.er, fontWeight: 700 }}>✗ {keyValidation.error}</span>}
        </div>

        {/* action buttons */}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn onClick={onCopyToNewKey} color={C.tm} outline data-testid="key-dump-copy">
            ⧉ Copy to new key
          </Btn>
          <Btn onClick={onExportKeyJson} color={C.gn} disabled={!keyValidation.ok} data-testid="key-dump-export-json">
            ↓ Export key dump (JSON)
          </Btn>
          <Btn onClick={onExportKeyBin} color={C.tm} outline disabled={!keyValidation.ok} data-testid="key-dump-export-bin">
            ↓ Export raw .bin
          </Btn>
          <Btn onClick={onPrefillFromSlot} color={C.tm} outline disabled={!slot?.idBytes} data-testid="key-dump-prefill">
            ⇇ Prefill UID from picked slot
          </Btn>
          <Btn onClick={onSaveToHistory} color={C.a3} disabled={!keyValidation.ok} data-testid="key-dump-save-history">
            💾 Save to vehicle history
          </Btn>
        </div>

        {keyDumpNote && (
          <div
            data-testid="key-dump-note"
            style={{ marginTop: 10, fontSize: 11, color: keyDumpNote.ok ? '#2E7D32' : C.er, lineHeight: 1.6, wordBreak: 'break-all' }}
          >
            {keyDumpNote.ok ? 'ℹ ' : '✗ '}{keyDumpNote.msg}
          </div>
        )}

        {/* clone-on-bench: write into a loaded RFHUB slot */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.bd}` }} data-testid="key-dump-clone">
          <div style={{ fontWeight: 900, fontSize: 12, color: C.tx, marginBottom: 6 }}>
            Clone on bench → write into a loaded RFHUB slot
          </div>
          <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.6, marginBottom: 8 }}>
            Stamps the captured UID into a free slot of the RFHUB loaded below and downloads a patched dump to flash back.{' '}
            <strong>Only the UID is written</strong> — the per-fob payload and chip crypto are still generated by the receiver during RoutineControl 0x0401 pairing on the car. Requires a non-blank SEC16.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: C.tm, display: 'flex', gap: 6, alignItems: 'center' }}>
              TARGET SLOT
              <select
                value={cloneSlotIdx == null ? '' : String(cloneSlotIdx)}
                onChange={(e) => setCloneSlotIdx(e.target.value === '' ? null : Number(e.target.value))}
                data-testid="key-dump-clone-slot"
                style={{ padding: 4, fontSize: 12 }}
                disabled={!parsed}
              >
                <option value="">{freeSlots.length ? 'first free' : 'no free slot'}</option>
                {freeSlots.map((i) => (
                  <option key={i} value={i}>Slot {i + 1}</option>
                ))}
              </select>
            </label>
            <Btn
              onClick={onWriteToRfhub}
              color={C.sr}
              disabled={!keyValidation.ok || !parsed || secretBlank}
              data-testid="key-dump-write-rfhub"
            >
              ▶ Write UID into RFHUB &amp; download
            </Btn>
          </div>
          {!parsed && (
            <div style={{ fontSize: 11, color: C.ts, marginTop: 6 }}>Load an RFHUB dump (section 1 below) to enable.</div>
          )}
          {parsed && secretBlank && (
            <div style={{ fontSize: 11, color: C.er, marginTop: 6 }}>✗ Loaded RFHUB SEC16 is blank — can't register a key against a virgin master secret.</div>
          )}
          {cloneResult && (
            <div
              data-testid="key-dump-clone-result"
              style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6, color: cloneResult.ok ? '#2E7D32' : C.er }}
            >
              {cloneResult.ok
                ? `✓ UID written into slot ${cloneResult.slotIdx + 1}; patched RFHUB downloaded.${cloneResult.payloadKnown ? '' : ' Payload not derivable from a standalone read — finish pairing on the car (RFHUB tab → RoutineControl 0x0401) so the receiver writes the matching crypto.'}`
                : `✗ ${cloneResult.error}`}
            </div>
          )}
        </div>
      </Card>

      {/* ── Keys on file for this VIN (Task #986) ── */}
      <Card style={{ marginBottom: 16 }} data-testid="key-history-card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>Keys on file for this vehicle</span>
          {vinValid
            ? <Tag color={C.a3}>{masterVin}</Tag>
            : <Tag color={C.wn}>no Master VIN</Tag>}
          <span data-testid="key-history-count"><Tag color={C.tm}>{keyHistory.length} saved</Tag></span>
          <span style={{ flex: 1 }} />
          {keyHistory.length > 0 && (
            <Btn onClick={onExportAllKeys} color={C.gn} data-testid="key-history-export-all" style={{ fontSize: 11, padding: '3px 10px' }}>
              ↓ Export all keys
            </Btn>
          )}
          <Btn
            onClick={() => keyHistoryImportRef.current?.click()}
            color={C.tm}
            outline
            disabled={!vinValid}
            data-testid="key-history-import"
            style={{ fontSize: 11, padding: '3px 10px' }}
          >
            ↑ Import key set
          </Btn>
          <input
            ref={keyHistoryImportRef}
            type="file"
            accept=".json,application/json"
            onChange={onImportKeysFile}
            data-testid="key-history-import-input"
            style={{ display: 'none' }}
          />
          {keyHistory.length > 0 && (
            <Btn onClick={onClearHistory} color={C.er} outline data-testid="key-history-clear" style={{ fontSize: 11, padding: '3px 10px' }}>
              Clear all
            </Btn>
          )}
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginBottom: 12, lineHeight: 1.6 }}>
          Every key you save from the Key Dump card above is retained here, keyed by the active Master VIN, so you can
          confirm how many keys exist for this car and which RFHUB slot each maps to before cloning a spare. Re-load any
          row back into the Key Dump card to re-export or clone on bench. Use <strong>Export all keys</strong> to hand off
          the whole set as one file, and <strong>Import key set</strong> to fold a wrapper back in (fresh ids, no collisions).
        </div>

        {!vinValid && (
          <div style={{ fontSize: 12, color: C.wn, fontWeight: 700 }} data-testid="key-history-novin">
            Set a valid 17-char Master VIN at the top of the workspace to view and save this vehicle's key history.
          </div>
        )}

        {vinValid && keyHistory.length === 0 && (
          <div style={{ fontSize: 12, color: C.ts }} data-testid="key-history-empty">
            No keys saved yet for {masterVin}. Capture a read above and press “💾 Save to vehicle history”.
          </div>
        )}

        {vinValid && keyHistory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="key-history-list">
            {keyHistory.map((entry) => {
              const def = chipFamily(entry.chipId);
              const uidShow = (entry.uidHex || '').trim() || '—';
              return (
                <div
                  key={entry.id}
                  data-testid="key-history-row"
                  style={{
                    display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                    padding: '8px 10px', border: `1px solid ${C.bd}`, borderRadius: 8, background: C.bg,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 800, fontSize: 12, color: C.tx }}>
                      {entry.label?.trim() ? entry.label : '(unlabeled key)'}
                    </div>
                    <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
                      <span style={{ color: C.tm, fontWeight: 700 }}>{def?.label || entry.chipId}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.ts, marginTop: 2, fontFamily: 'JetBrains Mono', wordBreak: 'break-all' }}>
                      UID {uidShow}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: C.ts, textAlign: 'right', minWidth: 120 }}>
                    <div>Slot {entry.slotIdx != null ? entry.slotIdx + 1 : '—'}</div>
                    <div style={{ marginTop: 2 }} title={new Date(entry.capturedAt).toLocaleString()}>
                      {new Date(entry.capturedAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn onClick={() => onLoadFromHistory(entry)} color={C.tm} outline data-testid="key-history-load" style={{ fontSize: 11, padding: '3px 10px' }}>
                      ⤓ Load
                    </Btn>
                    <Btn onClick={() => onRemoveFromHistory(entry.id)} color={C.er} outline data-testid="key-history-remove" style={{ fontSize: 11, padding: '3px 10px' }}>
                      ✕
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* RFHUB loader */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: C.tx }}>1. Load RFHUB dump</span>
          <input
            type="file"
            accept=".bin,.dat,.hex"
            onChange={onLoadRfh}
            data-testid="kwriter-load-rfh"
            style={{ fontSize: 12 }}
          />
          {rfhFile && <Tag color={C.tm}>{rfhFile.name} · {rfhBytes?.length ?? 0} B</Tag>}
          {parsed && <Tag color={C.gn}>gen {parsed.gen}</Tag>}
          {parsed?.sec16?.match && <Tag color={C.gn}>SEC16 slots match</Tag>}
          {parsed && !parsed.sec16?.match && <Tag color={C.wn}>SEC16 slots differ</Tag>}
        </div>
        {parseError && (
          <div style={{ color: C.er, fontSize: 12, marginTop: 4 }}>✗ {parseError}</div>
        )}
        {secretBlank && parsed && (
          <div style={{ color: C.er, fontSize: 12, marginTop: 4, fontWeight: 700 }}>
            ✗ RFHUB SEC16 is blank (all 0xFF / 0x00) — refusing to burn. Load a paired RFHUB.
          </div>
        )}
        {!parsed && !parseError && (
          <div style={{ color: C.ts, fontSize: 12, marginTop: 4 }}>
            Drop a 2 KB Gen1, 4 KB Gen2, or 8 KB Gen2 RFHUB dump. The tab will pick the first occupied slot for you.
          </div>
        )}
      </Card>

      {/* Slot picker */}
      {parsed && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, marginBottom: 8 }}>2. Pick slot</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
            {parsed.slots.map((s) => {
              const sel = slotIdx === s.idx;
              const idHex = s.idBytes ? hexJoin(s.idBytes) : '—';
              const disabled = !s.occupied || !s.idMapped;
              return (
                <div
                  key={s.idx}
                  onClick={() => !disabled && setSlotIdx(s.idx)}
                  data-testid={`kwriter-slot-${s.idx}`}
                  style={{
                    padding: 10,
                    border: `2px solid ${sel ? C.a3 : C.bd}`,
                    borderRadius: 8,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    background: sel ? C.a3 + '14' : C.bg,
                    opacity: disabled ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 900, fontSize: 12 }}>Slot {s.idx + 1}</span>
                    <Tag color={s.occupied ? C.gn : C.tm}>{s.occupied ? 'AA-50' : 'empty'}</Tag>
                    {s.idMapped ? null : <Tag color={C.wn}>id unmapped</Tag>}
                  </div>
                  <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: C.ts }}>
                    ID @ 0x{(s.idOffset ?? 0).toString(16).toUpperCase()}
                  </div>
                  <div style={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: C.tx, marginTop: 4, wordBreak: 'break-all' }}>
                    {idHex}
                  </div>
                </div>
              );
            })}
          </div>
          {slot && (
            <div style={{ marginTop: 12, fontSize: 11, color: C.ts }}>
              Picked slot {slot.idx + 1}. {KEY_ID_BLOCK_LEN} bytes of chip ID will be sent to the writer along with the resolved RFHUB SEC16.
            </div>
          )}
        </Card>
      )}

      {/* Autel IM608 export — shown whenever RFHUB + slot + non-blank SEC16 are ready */}
      {parsed && slot && slot.occupied && slot.idMapped && secret16 && !secretBlank && (() => {
        const exportData = buildAutelExportData({ slot, secret16, chipId, chipDef, gen: parsed.gen });
        const baseName = exportBaseName(rfhFile?.name, slot.idx);

        const onDownloadJson = () => {
          if (!exportData.ok) return;
          const json = buildJsonManifest({
            uid: exportData.uid,
            payload: exportData.payload,
            sec16: exportData.sec16,
            chipId,
            chipDef,
            gen: parsed.gen,
            slotIdx: slot.idx,
            fileName: rfhFile?.name,
          });
          triggerDownload(new Blob([json], { type: 'application/json' }), `${baseName}.json`);
        };

        const onDownloadBin = () => {
          if (!exportData.ok) return;
          const bin = buildRawBin({ uid: exportData.uid, payload: exportData.payload, sec16: exportData.sec16, chipId });
          triggerDownload(new Blob([bin], { type: 'application/octet-stream' }), `${baseName}.bin`);
        };

        const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => {});

        return (
          <Card style={{ marginBottom: 16, background: '#E8F5E9', borderColor: C.gn }} data-testid="autel-export-card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontSize: 20 }}>🔑</div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 13, color: '#1B5E20', letterSpacing: 0.5 }}>
                  AUTEL IM608 EXPORT — Slot {slot.idx + 1}
                </div>
                <div style={{ fontSize: 11, color: '#2E7D32', marginTop: 2 }}>
                  All values extracted from the RFHUB dump. Enter them into your Autel's transponder programmer or download the JSON manifest for reference.
                </div>
              </div>
            </div>

            {exportData.ok ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  {/* UID */}
                  <div style={{ padding: 10, background: '#fff', borderRadius: 6, border: `1px solid ${C.bd}` }}>
                    <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, marginBottom: 4 }}>TRANSPONDER UID ({exportData.uid.length} bytes)</div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: C.tx, wordBreak: 'break-all' }}>
                      {hexJoin(exportData.uid)}
                    </div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 10, color: C.ts, marginTop: 2 }}>
                      compact: {hexCompact(exportData.uid)}
                    </div>
                    <Btn onClick={() => copyText(hexCompact(exportData.uid))} color={C.tm} outline style={{ marginTop: 6, fontSize: 10, padding: '2px 8px' }}>
                      Copy
                    </Btn>
                  </div>

                  {/* Payload */}
                  <div style={{ padding: 10, background: '#fff', borderRadius: 6, border: `1px solid ${C.bd}` }}>
                    <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, marginBottom: 4 }}>CRYPTO PAYLOAD ({exportData.payload.length} bytes)</div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: C.tx, wordBreak: 'break-all' }}>
                      {hexJoin(exportData.payload)}
                    </div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 10, color: C.ts, marginTop: 2 }}>
                      compact: {hexCompact(exportData.payload)}
                    </div>
                    <Btn onClick={() => copyText(hexCompact(exportData.payload))} color={C.tm} outline style={{ marginTop: 6, fontSize: 10, padding: '2px 8px' }}>
                      Copy
                    </Btn>
                  </div>

                  {/* SEC16 */}
                  <div style={{ padding: 10, background: '#fff', borderRadius: 6, border: `1px solid ${C.bd}`, gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.2, marginBottom: 4 }}>SEC16 MASTER SECRET (16 bytes) — handle with care</div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: C.tx, wordBreak: 'break-all' }}>
                      {hexJoin(exportData.sec16)}
                    </div>
                    <div style={{ fontFamily: 'JetBrains Mono', fontSize: 10, color: C.ts, marginTop: 2 }}>
                      compact: {hexCompact(exportData.sec16)}
                    </div>
                    <Btn onClick={() => copyText(hexCompact(exportData.sec16))} color={C.tm} outline style={{ marginTop: 6, fontSize: 10, padding: '2px 8px' }}>
                      Copy
                    </Btn>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  <Btn onClick={onDownloadJson} color={C.gn} data-testid="autel-download-json">
                    ↓ Download JSON manifest
                  </Btn>
                  <Btn onClick={onDownloadBin} color={C.tm} outline data-testid="autel-download-bin">
                    ↓ Download raw .bin
                  </Btn>
                </div>

                <div style={{ fontSize: 11, color: '#2E7D32', lineHeight: 1.7, borderTop: `1px solid ${C.bd}`, paddingTop: 8 }}>
                  <strong>Autel IM608 workflow:</strong>
                  <ol style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    <li>MaxiIM → FCA/Chrysler → your model/year → Program Key → Expert/Manual mode</li>
                    <li>Enter the <strong>Transponder UID</strong> when prompted (4 hex bytes above)</li>
                    <li>Enter the <strong>Crypto Payload</strong> for the data pages (4 hex bytes above)</li>
                    <li>Enter the <strong>SEC16 master secret</strong> as the encryption/master key (16 bytes)</li>
                    <li>After the chip is written, pair the key via OBD using the RFHUB tab's existing flow</li>
                  </ol>
                  <div style={{ marginTop: 6, fontStyle: 'italic', color: '#388E3C' }}>
                    Exact menu path varies by firmware version — the JSON download includes all values in a copy-paste-friendly format.
                  </div>
                </div>
              </>
            ) : (
              <div style={{ color: C.er, fontSize: 12 }}>✗ {exportData.error}</div>
            )}
          </Card>
        );
      })()}

      {/* Chip + writer + transport */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, marginBottom: 8 }}>3. Pick chip, writer, transport (Xhorse VVDI / Tango only)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>CHIP FAMILY</div>
            <select
              value={chipId}
              onChange={(e) => setChipId(e.target.value)}
              data-testid="kwriter-chip"
              style={{ width: '100%', padding: 6, fontSize: 12 }}
            >
              {CHIP_FAMILIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4 }}>WRITER</div>
            <select
              value={writerId}
              onChange={(e) => setWriterId(e.target.value)}
              data-testid="kwriter-writer"
              style={{ width: '100%', padding: 6, fontSize: 12 }}
            >
              {WRITERS.map((w) => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 12, padding: 10, border: `1px solid ${C.bd}`, borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn
              onClick={() => { disconnectSerial(); setMode('sim'); }}
              color={mode === 'sim' ? C.a3 : C.tm}
              outline={mode !== 'sim'}
              data-testid="kwriter-mode-sim"
            >
              Simulator
            </Btn>
            <Btn
              onClick={connectSerial}
              color={mode === 'webserial' ? C.gn : C.tm}
              outline={mode !== 'webserial'}
              disabled={!isWebSerialAvailable()}
              data-testid="kwriter-mode-serial"
            >
              {mode === 'webserial' ? '✓ Web Serial connected' : 'Connect Web Serial'}
            </Btn>
            {mode === 'webserial' && (
              <Btn onClick={disconnectSerial} color={C.tm} outline>Disconnect</Btn>
            )}
            <Btn
              onClick={probeHttp}
              color={mode === 'http' ? C.gn : C.tm}
              outline={mode !== 'http'}
              data-testid="kwriter-mode-http"
            >
              {mode === 'http' ? '✓ HTTP fallback active' : 'Probe HTTP fallback'}
            </Btn>
            <Btn
              onClick={detectWriter}
              color={C.tm}
              outline
              disabled={mode === 'sim'}
              data-testid="kwriter-detect"
            >
              Detect writer
            </Btn>
            {!isWebSerialAvailable() && (
              <span style={{ fontSize: 11, color: C.ts }}>
                Web Serial unavailable in this browser — use HTTP fallback or Simulator.
              </span>
            )}
          </div>
          {writerInfo && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }} data-testid="kwriter-writer-info">
              <Tag color={C.gn}>Writer: {writerInfo.model}</Tag>
              <Tag color={C.tm}>Firmware: {writerInfo.firmware}</Tag>
              <Tag color={C.tm}>via {writerInfo.source}</Tag>
            </div>
          )}
          {httpProbe && !httpProbe.available && (
            <div style={{ fontSize: 11, color: C.ts, marginTop: 6 }} data-testid="kwriter-http-probe">
              HTTP fallback unavailable: {httpProbe.reason}
            </div>
          )}
          {mode === 'sim' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: C.tm, letterSpacing: 1.4, marginBottom: 4 }}>SIMULATOR FAULT PROFILE</div>
              <select
                value={simProfile}
                onChange={(e) => setSimProfile(e.target.value)}
                data-testid="kwriter-sim-profile"
                style={{ padding: 6, fontSize: 12 }}
              >
                {SIM_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
          )}
          {serialError && (
            <div style={{ color: C.er, fontSize: 12, marginTop: 6 }}>✗ {serialError}</div>
          )}
        </div>
      </Card>

      {/* Burn button + audit */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 14, color: C.tx, flex: 1 }}>4. Burn + verify</div>
          <Btn
            onClick={runBurn}
            color={canBurn ? C.er : C.tm}
            disabled={!canBurn}
            data-testid="kwriter-burn"
          >
            {busy ? '⏳ Burning…' : '▶ Burn slot'}
          </Btn>
        </div>
        {!canBurn && !busy && (
          <div style={{ fontSize: 11, color: C.ts }}>
            Burn enables once every gate is green:
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              <li>RFHUB loaded {parsed ? '✓' : '✗'}</li>
              <li>Slot picked with AA-50 + ID block {slot && slot.occupied && slot.idMapped ? '✓' : '✗'}</li>
              <li>SEC16 master secret non-blank {secret16 && !secretBlank ? '✓' : '✗'}</li>
              <li>Chip family known {chipDef ? '✓' : '✗'}</li>
              <li>Slot id length matches chip ({chipDef ? `${chipDef.uidBytes + chipDef.payloadBytes} B` : '—'}) {idShapeMatch ? '✓' : '✗'}</li>
              <li>Writer supported by chip family {writerSupported ? '✓' : '✗'}</li>
            </ul>
          </div>
        )}
        {result && (
          <div style={{ marginTop: 8 }}>
            <Tag color={result.ok ? C.gn : C.er}>
              {result.ok ? 'KEYMOD WRITTEN' : `KEYMOD REFUSED @ ${result.failedAt || 'unknown'}`}
            </Tag>
          </div>
        )}
        {log.length > 0 && (
          <div
            data-testid="kwriter-log"
            style={{
              marginTop: 12,
              padding: 10,
              background: '#111',
              color: '#eee',
              fontFamily: 'JetBrains Mono',
              fontSize: 11,
              borderRadius: 6,
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {log.map((e, i) => (
              <div
                key={i}
                style={{
                  color: e.level === 'ok' ? '#7CFC9F' : e.level === 'err' ? '#FF6B6B' : '#9AD',
                }}
              >
                {e.msg}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Handoff hint */}
      {result?.ok && (
        <Card style={{ marginBottom: 16, background: '#E8F5E9', borderColor: C.gn }}>
          <div style={{ fontSize: 12, color: '#1B5E20', lineHeight: 1.6 }}>
            ✓ Chip burn verified. Next step: leave the chip in the FOBIK, switch to the <strong>RFHUB</strong> tab, and run the RoutineControl 0x0401 pairing with the same VIN — the receiver will accept the freshly-burned ID because its UID + payload already match the SEC16 master secret you just sent the writer.
          </div>
          <div style={{ marginTop: 8 }}>
            <Btn onClick={openRfhubHandoff} color={C.gn} data-testid="kwriter-open-rfhub">
              ▶ Open RFHUB tab (slot {slot ? slot.idx + 1 : '—'} preloaded)
            </Btn>
          </div>
        </Card>
      )}
    </div>
  );
}
