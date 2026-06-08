import React, {useState, useCallback, useRef, useMemo, useContext} from "react";
import {Card, Btn, SLine} from "../lib/ui.jsx";
import {C, TR, WT} from "../lib/constants.js";
import {analyzeFile, patchFile} from "../lib/fileUtils.js";
import {parseModule} from "../lib/parseModule.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";
import Gpec2aImmoPanel from "../components/Gpec2aImmoPanel.jsx";
import BcmImmoSection from "../components/BcmImmoSection.jsx";
import RfhubImmoSection from "../components/RfhubImmoSection.jsx";
import {
  getAllModules, buildSessionSequence, getModuleDids,
  buildReadDid, buildWriteDid, buildDsc, buildSeedRequest,
  computeKey, ALGO, sbecKey,
} from "../lib/udsEngine.js";
import { vinWriteDids, VIN_WRITE_DIDS } from "../lib/algos.js";

/* VIN PROGRAMMER TAB
 *
 * Single-file VIN patch + checksum fix workflow. Drop one binary in,
 * see every VIN slot the analyzer found (with the current stored
 * checksum vs. the recomputed one), enter a new VIN, get a patched
 * file back with every algorithm-correct checksum recomputed.
 *
 * Uses the same shared primitives the workspace already trusts:
 *   analyzeFile()  — module-aware classifier + VIN/partial slot scan
 *                    with per-slot checksum status. Single source of
 *                    truth for VIN detection.
 *   patchFile()    — writes the new VIN at every detected slot,
 *                    recomputes every CRC variant (Gen2 mirrored
 *                    crc8rf, Gen1 crc16, BCM crc16, 95640 crc8/42),
 *                    syncs the BCM IMMO backup block, and returns a
 *                    structured log of every offset it touched.
 *
 * Two actions:
 *   PATCH VIN      — full path: writes the user-supplied VIN at every
 *                    slot, recomputes checksums, downloads patched bin.
 *   FIX CHECKSUMS  — diagnostic: re-runs patchFile with the CURRENT
 *                    VIN found in the file (no VIN change), so any
 *                    bad/stale checksum bytes get rewritten with the
 *                    correct values. Useful after a manual hex edit.
 *
 * Refuses to act on UNKNOWN-type files (no slot table → nothing to
 * patch). Surfaces the analyzeFile sizeWarn / contentWarn so the user
 * sees the same "this isn't a real BCM" guidance they get on the
 * Dumps tab.
 */

const VIN_RX = /^[A-HJ-NPR-Z0-9]{17}$/;

function checkDigit(vin) {
  if (!vin || vin.length !== 17) return {ok: false, expected: null};
  const u = vin.toUpperCase();
  if (!VIN_RX.test(u)) return {ok: false, expected: null, err: 'Invalid characters'};
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (TR[u[i]] || 0) * WT[i];
  const cd = '0123456789X'[sum % 11];
  return {ok: u[8] === cd, expected: cd, err: u[8] !== cd ? `Check digit: expected ${cd}` : null};
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], {type: 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Suffix the original filename with `_VIN_<vin>` (or `_FIXCS`) before
// the extension so the user can tell the patched file apart from the
// source on disk without losing the original name.
function patchedFilename(originalName, vin, mode) {
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot) : '.bin';
  const tag = mode === 'fix' ? '_FIXCS' : `_VIN_${vin}`;
  return `${stem}${tag}${ext}`;
}

function fmtHex(n, w = 4) {
  return '0x' + n.toString(16).toUpperCase().padStart(w, '0');
}

function SlotRow({slot, kind}) {
  // kind is 'full' (17-char VIN slot) or 'partial' (8-char tail slot).
  const csOk = slot.algo === 'none' ? true : (slot.sc === slot.cc);
  const csLabel = slot.algo === 'none'
    ? 'no checksum'
    : (csOk ? 'CS OK' : `CS BAD (stored ${fmtHex(slot.sc, slot.algo === 'c16' ? 4 : 2)} ≠ calc ${fmtHex(slot.cc, slot.algo === 'c16' ? 4 : 2)})`);
  const algoLabel = {c16: 'CRC16', c8: 'CRC8', none: '—'}[slot.algo] || slot.algo;
  return (
    <div data-testid={`vinprog-slot-${kind}-${slot.off.toString(16)}`} style={{
      display: 'grid',
      gridTemplateColumns: '110px 1fr 90px 200px',
      gap: 12,
      alignItems: 'center',
      padding: '8px 12px',
      background: '#fff',
      borderRadius: 8,
      border: `1px solid ${csOk ? C.bd : C.er + '88'}`,
      marginBottom: 6,
      fontFamily: "'JetBrains Mono'",
      fontSize: 11,
    }}>
      <span style={{fontWeight: 800, color: C.a3}}>{fmtHex(slot.off)}</span>
      <span style={{color: C.tx, letterSpacing: 1}}>
        {slot.vin}
        {slot.mirrored && <span style={{marginLeft: 6, fontSize: 9, color: C.tm, fontStyle: 'italic'}}>(byte-reversed)</span>}
        {kind === 'partial' && <span style={{marginLeft: 6, fontSize: 9, color: C.tm, fontStyle: 'italic'}}>(8-char tail)</span>}
      </span>
      <span style={{fontSize: 10, color: C.tm, textAlign: 'center'}}>{algoLabel}</span>
      <span style={{fontSize: 10, fontWeight: 700, color: csOk ? C.gn : C.er, textAlign: 'right'}}>{csLabel}</span>
    </div>
  );
}

/* The VIN + CHECKSUM tab hosts a sub-tab bar: the original single-file
 * PATCHER plus one ImmoVIN sub-tab per module (ECM / BCM / RFHUB). Each
 * module sub-tab loads + parses its own file and renders the SAME shared
 * panel component used by the per-module main tabs (Gpec2aImmoPanel,
 * BcmImmoSection, RfhubImmoSection) — no duplicated layout or checksum
 * logic. All sub-tabs stay mounted (visibility toggled) so switching
 * between them never loses a loaded dump or in-progress edits. */
const SUBTABS = [
  {id: 'patch', label: 'PATCHER', icon: '🪴'},
  {id: 'ecm', label: 'ECM', icon: '🧠'},
  {id: 'bcm', label: 'BCM', icon: '🔧'},
  {id: 'rfhub', label: 'RFHUB', icon: '📡'},
  {id: 'uds', label: 'UDS VIN WRITE', icon: '🔌'},
];

function SubTabBar({sub, setSub}) {
  return (
    <div data-testid="vinprog-subtab-bar" style={{display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap'}}>
      {SUBTABS.map(t => {
        const active = sub === t.id;
        return (
          <button
            key={t.id}
            data-testid={`vinprog-subtab-${t.id}`}
            onClick={() => setSub(t.id)}
            style={{
              padding: '8px 16px',
              borderRadius: 10,
              border: `2px solid ${active ? C.sr : C.bd}`,
              background: active ? C.sr : '#fff',
              color: active ? '#fff' : C.tx,
              fontFamily: "'Nunito'",
              fontWeight: 800,
              fontSize: 12,
              letterSpacing: 1,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <span style={{marginRight: 6}}>{t.icon}</span>{t.label}
          </button>
        );
      })}
    </div>
  );
}

/* A module sub-tab: load a .bin, parse it with the same parseModule path
 * the per-module main tabs use, refuse a file whose detected type does not
 * match the sub-tab, and hand the parsed `mod` to its render-prop child
 * (which mounts the matching shared ImmoVIN panel). `mod`/`setMod` live in
 * the parent so the loaded dump survives sub-tab switches. */
function ModuleSubTab({testidPrefix, label, blurb, expectedTypes, forceType, mod, setMod, children}) {
  const inputRef = useRef(null);
  const [err, setErr] = useState('');

  const onPick = useCallback(async (f) => {
    setErr('');
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const m = parseModule(bytes, f.name, forceType ? { forceType } : undefined);
      if (expectedTypes && !expectedTypes.includes(m.type)) {
        setErr(`Selected file detected as ${m.name || m.type} — load a ${label} dump for this sub-tab.`);
        return;
      }
      setMod(m);
    } catch (e) {
      setErr(`Could not read file: ${e?.message || e}`);
    }
  }, [expectedTypes, forceType, label, setMod]);

  const onFilePick = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    onPick(f);
    if (e.target) e.target.value = '';
  }, [onPick]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    onPick(f);
  }, [onPick]);

  return (
    <div data-testid={`${testidPrefix}-subtab`}>
      <Card style={{marginBottom: 14}}>
        <div style={{fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.sr, letterSpacing: 1.5, marginBottom: 10}}>LOAD {label} FILE</div>
        <div style={{fontSize: 11, color: C.tm, marginBottom: 10}}>{blurb}</div>
        <div
          data-testid={`${testidPrefix}-dropzone`}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => inputRef.current && inputRef.current.click()}
          style={{
            border: `2px dashed ${mod ? C.gn : C.bd}`,
            borderRadius: 12,
            padding: 20,
            textAlign: 'center',
            cursor: 'pointer',
            background: mod ? '#F0FFF4' : '#FAFAF8',
            transition: 'all 0.2s',
          }}
        >
          <input
            ref={inputRef}
            data-testid={`${testidPrefix}-file-input`}
            type="file"
            accept=".bin,.BIN"
            style={{display: 'none'}}
            onChange={onFilePick}
          />
          {!mod && <>
            <div style={{fontSize: 24, marginBottom: 6}}>📁</div>
            <div style={{fontFamily: "'JetBrains Mono'", fontWeight: 700, fontSize: 12, color: C.tx}}>Drop a {label} .bin or click to pick</div>
          </>}
          {mod && <>
            <div style={{fontFamily: "'JetBrains Mono'", fontWeight: 800, fontSize: 13, color: C.tx, marginBottom: 4}} data-testid={`${testidPrefix}-filename`}>{mod.filename}</div>
            <div style={{fontSize: 11, color: C.tm}}>
              <span data-testid={`${testidPrefix}-detected-type`} style={{color: mod.color || C.tm, fontWeight: 800}}>{mod.name || mod.type}</span>
              {' · '}
              <span>{(mod.size / 1024).toFixed(mod.size % 1024 === 0 ? 0 : 2)} KB</span>
            </div>
          </>}
        </div>
        {mod && (
          <div style={{marginTop: 10}}>
            <Btn outline color={C.tm} onClick={() => {setMod(null); setErr('');}}>CLEAR</Btn>
          </div>
        )}
        {err && <div style={{marginTop: 10}}><SLine type="error" msg={err}/></div>}
      </Card>
      {mod && children(mod)}
    </div>
  );
}

export default function VinProgrammerTab() {
  const {vin: masterVin, vinValid: masterVinValid, setVin: setMasterVin, getDumpsByType} = useContext(MasterVinContext);
  const fileInputRef = useRef(null);

  // Sub-tab selection + per-module loaded dumps (kept here so switching
  // sub-tabs preserves each module's loaded file/state).
  const [sub, setSub] = useState('patch');
  const [ecmMod, setEcmMod] = useState(null);
  const [bcmMod, setBcmMod] = useState(null);
  const [rfhubMod, setRfhubMod] = useState(null);
  // UDS VIN write subtab state
  const [udsVinModule, setUdsVinModule] = useState('IPC');
  const [udsVin, setUdsVin] = useState('');
  const [udsSeedHex, setUdsSeedHex] = useState(''); // live seed from ECU (hex string)
  // Compute the SBEC key from the live seed
  const udsLiveKey = useMemo(() => {
    const raw = udsSeedHex.replace(/\s+/g, '');
    if (!raw || raw.length < 2) return null;
    const seedVal = parseInt(raw, 16);
    if (isNaN(seedVal)) return null;
    const mod = getAllModules().find(m => m.code === udsVinModule);
    const algo = mod?.algo ?? ALGO.SBEC;
    return computeKey(algo, seedVal);
  }, [udsSeedHex, udsVinModule]);
  const [udsSeqExpanded, setUdsSeqExpanded] = useState(false);
  const allModsList = useMemo(() => getAllModules(), []);
  const udsVinCheck = useMemo(() => checkDigit(udsVin), [udsVin]);
  const udsVinDids = useMemo(() => vinWriteDids(udsVinModule), [udsVinModule]);
  const udsSeqSteps = useMemo(() => {
    try { return buildSessionSequence(udsVinModule, 'vin'); } catch { return []; }
  }, [udsVinModule]);
  // Build the full UDS VIN write frame sequence for display
  const udsVinFrames = useMemo(() => {
    if (!udsVin || udsVin.length !== 17 || !udsVinCheck.ok) return [];
    const mod = getAllModules().find(m => m.code === udsVinModule);
    if (!mod) return [];
    const vinBytes = Array.from(udsVin).map(c => c.charCodeAt(0));
    const frames = [];
    // 1. DSC 02 — extended diagnostic session
    frames.push({ label: 'DSC 02 (Extended Diagnostic Session)', bytes: [0x10, 0x02], desc: 'Enter extended diagnostic session' });
    // 2. DSC 03 — programming session
    frames.push({ label: 'DSC 03 (Programming Session)', bytes: [0x10, 0x03], desc: 'Enter programming session' });
    // 3. SA 0x01 — seed request
    frames.push({ label: 'SA 01 (Seed Request)', bytes: [0x27, 0x01], desc: 'Request seed for security access level 0x01' });
    // 4. SA 0x02 — key send (live if seed provided, placeholder otherwise)
    const keyBytes = udsLiveKey?.keyBytes ?? null;
    const saBytes = keyBytes
      ? [0x27, 0x02, ...keyBytes]
      : [0x27, 0x02, 0x00, 0x00]; // placeholder — enter seed above to compute
    const saLabel = keyBytes
      ? `SA 02 (Key Send) — key 0x${keyBytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join('')}`
      : 'SA 02 (Key Send) — ⚠ enter seed above to compute';
    const saDesc = keyBytes
      ? `Computed key from seed 0x${udsSeedHex.replace(/\s+/g,'').toUpperCase()} using ${udsLiveKey?.algo ?? 'SBEC'} algorithm`
      : 'Enter the seed received from the ECU above to auto-compute the key';
    frames.push({ label: saLabel, bytes: saBytes, desc: saDesc, isPlaceholder: !keyBytes });
    // 5. Write each VIN DID
    for (const did of udsVinDids) {
      const dh = did > 0xFFFF ? [(did>>>16)&0xFF,(did>>>8)&0xFF,did&0xFF] : [(did>>>8)&0xFF,did&0xFF];
      const frame = [0x2E, ...dh, ...vinBytes];
      frames.push({ label: `WDBI 0x${did.toString(16).toUpperCase().padStart(4,'0')} — VIN`, bytes: frame, desc: `Write VIN to DID 0x${did.toString(16).toUpperCase().padStart(4,'0')}` });
    }
    // 6. Readback each DID
    for (const did of udsVinDids) {
      const dh = did > 0xFFFF ? [(did>>>16)&0xFF,(did>>>8)&0xFF,did&0xFF] : [(did>>>8)&0xFF,did&0xFF];
      frames.push({ label: `RDBI 0x${did.toString(16).toUpperCase().padStart(4,'0')} — verify`, bytes: [0x22, ...dh], desc: `Read back DID 0x${did.toString(16).toUpperCase().padStart(4,'0')} to verify VIN was written` });
    }
    // 7. ECU reset
    frames.push({ label: 'ECU Reset (11 01)', bytes: [0x11, 0x01], desc: 'Hard reset to apply changes' });
    return frames;
  }, [udsVin, udsVinCheck.ok, udsVinModule, udsVinDids]);

  // Donor SEC16 sources for the GPEC2A immo-fix panel: the BCM / RFHUB
  // dumps loaded in the sibling sub-tabs plus any already in the shared
  // workspace (mirrors EcmTab's donor wiring).
  const donorMods = useMemo(() => {
    const ctx = [
      ...(getDumpsByType ? getDumpsByType('BCM') : []),
      ...(getDumpsByType ? getDumpsByType('RFHUB') : []),
    ].map(d => d.mod).filter(Boolean);
    return [bcmMod, rfhubMod, ...ctx].filter(Boolean);
  }, [bcmMod, rfhubMod, getDumpsByType]);

  // When a panel pushes a patched buffer back, re-parse it in place so the
  // sub-tab re-analyzes the patched result (the download is still saved).
  const onEcmPatched = useCallback((bytes, filename) => {
    try {
      const m = parseModule(bytes, filename || 'gpec2a_patched.bin');
      if (m && m.type === 'GPEC2A') setEcmMod(m);
    } catch { /* ignore — keep the prior dump on a bad re-parse */ }
  }, []);
  const onBcmPatched = useCallback((bytes, filename) => {
    try {
      const m = parseModule(bytes, filename || 'bcm_patched.bin');
      if (m && m.type === 'BCM') setBcmMod(m);
    } catch { /* ignore */ }
  }, []);
  const onRfhubPatched = useCallback((bytes, filename) => {
    try {
      const m = parseModule(bytes, filename || 'rfhub_patched.bin');
      if (m && (m.type === 'RFHUB' || m.type === 'XC2268_RFHUB')) setRfhubMod(m);
    } catch { /* ignore */ }
  }, []);

  const [file, setFile] = useState(null); // {name, bytes, info}
  const [newVin, setNewVin] = useState('');
  const [result, setResult] = useState(null); // {mode, vin, log, bytes, filename}
  const [error, setError] = useState(null);

  const onPick = useCallback(async (f) => {
    setError(null); setResult(null);
    if (!f) { setFile(null); return; }
    try {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const info = analyzeFile(bytes, f.name);
      setFile({name: f.name, bytes, info});
    } catch (e) {
      setError(`Could not read file: ${e?.message || e}`);
    }
  }, []);

  const onFilePick = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    onPick(f);
    if (e.target) e.target.value = '';
  }, [onPick]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    onPick(f);
  }, [onPick]);

  const newVinCheck = useMemo(() => checkDigit(newVin), [newVin]);
  const hasSlots = !!(file && file.info && (file.info.vins.length > 0 || (file.info.partials && file.info.partials.length > 0)));
  const canPatch = !!(file && hasSlots && newVin.length === 17 && newVinCheck.ok);
  const canFixCs = !!(file && hasSlots);

  // Both runs go through patchFile() — the only difference is which VIN
  // we feed it. patchFile rewrites every slot AND recomputes every
  // checksum unconditionally, so passing the current VIN is a clean
  // "rewrite the checksum bytes with what they should be" pass.
  const runPatch = useCallback((mode) => {
    if (!file || !hasSlots) return;
    setError(null);
    let vinToWrite;
    if (mode === 'fix') {
      const cur = file.info.vins[0]?.vin || file.info.partials?.[0]?.vin;
      if (!cur || cur.length !== 17) {
        // Partial slot only — we can't reconstruct a 17-char VIN from
        // the 8-char tail alone. Surface a clear refusal rather than
        // writing an invalid VIN.
        setError('Cannot fix checksums: no full 17-char VIN found in file. Use PATCH VIN with a known VIN instead.');
        return;
      }
      // If the file holds two or more DIFFERENT full VINs (e.g. a
      // module that was partially reprogrammed and got mixed VINs in
      // its slots), FIX CHECKSUMS would silently normalize them all to
      // the first slot's VIN. That's a destructive surprise — refuse
      // and tell the user to pick the source VIN explicitly via PATCH.
      const distinctVins = Array.from(new Set(file.info.vins.map(v => v.vin)));
      if (distinctVins.length > 1) {
        setError(`Cannot fix checksums: file contains ${distinctVins.length} different VINs across slots (${distinctVins.join(' / ')}). FIX CHECKSUMS would overwrite the others with the first one. Use PATCH VIN with the VIN you actually want.`);
        return;
      }
      vinToWrite = cur;
    } else {
      vinToWrite = newVin.toUpperCase();
    }
    try {
      const {data, log} = patchFile(file.info, vinToWrite);
      setResult({
        mode,
        vin: vinToWrite,
        log,
        bytes: data,
        filename: patchedFilename(file.name, vinToWrite, mode),
      });
    } catch (e) {
      setError(`Patch failed: ${e?.message || e}`);
    }
  }, [file, hasSlots, newVin]);

  const onDownload = useCallback(() => {
    if (!result) return;
    downloadBytes(result.bytes, result.filename);
  }, [result]);

  const useMasterVin = useCallback(() => {
    if (masterVinValid) setNewVin(masterVin);
  }, [masterVin, masterVinValid]);

  const sendToMaster = useCallback(() => {
    if (newVinCheck.ok && typeof setMasterVin === 'function') setMasterVin(newVin.toUpperCase());
  }, [newVin, newVinCheck.ok, setMasterVin]);

  const info = file?.info;

  return (
    <div data-testid="vinprog-tab" style={{padding: '16px 20px'}}>
      <Card glow style={{marginBottom: 14}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4}}>
          <span style={{fontSize: 22}}>🪪</span>
          <div>
            <div style={{fontFamily: "'Nunito'", fontWeight: 900, fontSize: 18, color: C.tx, letterSpacing: 1}}>VIN PROGRAMMER</div>
            <div style={{fontSize: 11, color: C.tm, marginTop: 2}}>
              Drop one file · auto-detect module · rewrite VIN at every slot · recompute every checksum
            </div>
          </div>
        </div>
      </Card>

      <SubTabBar sub={sub} setSub={setSub}/>

      <div data-testid="vinprog-subtab-patch-wrap" style={{display: sub === 'patch' ? 'block' : 'none'}}>
      <Card style={{marginBottom: 14}}>
        <div style={{fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.sr, letterSpacing: 1.5, marginBottom: 10}}>1 · LOAD FILE</div>
        <div
          data-testid="vinprog-dropzone"
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          style={{
            border: `2px dashed ${file ? C.gn : C.bd}`,
            borderRadius: 12,
            padding: 24,
            textAlign: 'center',
            cursor: 'pointer',
            background: file ? '#F0FFF4' : '#FAFAF8',
            transition: 'all 0.2s',
          }}
        >
          <input
            ref={fileInputRef}
            data-testid="vinprog-file-input"
            type="file"
            style={{display: 'none'}}
            onChange={onFilePick}
          />
          {!file && <>
            <div style={{fontSize: 28, marginBottom: 6}}>📁</div>
            <div style={{fontFamily: "'JetBrains Mono'", fontWeight: 700, fontSize: 12, color: C.tx}}>Drop a single binary or click to pick</div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 6}}>BCM · RFHUB Gen1/Gen2 · GPEC2A PCM · 95640</div>
          </>}
          {file && <>
            <div style={{fontFamily: "'JetBrains Mono'", fontWeight: 800, fontSize: 13, color: C.tx, marginBottom: 4}} data-testid="vinprog-filename">{file.name}</div>
            <div style={{fontSize: 11, color: C.tm}}>
              <span data-testid="vinprog-detected-type" style={{color: info?.color || C.tm, fontWeight: 800}}>{info?.name || info?.type}</span>
              {' · '}
              <span data-testid="vinprog-detected-size">{(file.bytes.length / 1024).toFixed(file.bytes.length % 1024 === 0 ? 0 : 2)} KB</span>
            </div>
          </>}
        </div>
        {error && <div style={{marginTop: 10}}><SLine type="error" msg={error}/></div>}
        {info?.sizeWarn && <div style={{marginTop: 10}}><SLine type="warn" msg={info.sizeWarn.message}/></div>}
        {info?.contentWarn && <div style={{marginTop: 6}}><SLine type="warn" msg={info.contentWarn.message}/></div>}
        {file && info?.type === 'UNKNOWN' && (
          <div style={{marginTop: 10}}>
            <SLine type="error" msg="Unknown module type — no VIN slot table available. This tab only programs known modules: BCM, RFHUB, PCM (GPEC2A), 95640."/>
          </div>
        )}
        {file && hasSlots === false && info?.type !== 'UNKNOWN' && (
          <div style={{marginTop: 10}}>
            <SLine type="warn" msg={`File detected as ${info.name || info.type} but no VIN slots were found. Nothing to patch.`}/>
          </div>
        )}
      </Card>

      {file && hasSlots && (
        <Card style={{marginBottom: 14}}>
          <div style={{fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.sr, letterSpacing: 1.5, marginBottom: 10}}>
            2 · CURRENT VIN SLOTS
            <span style={{marginLeft: 10, fontSize: 10, fontWeight: 700, color: C.tm}} data-testid="vinprog-slot-counts">
              {info.vins.length} full · {(info.partials || []).length} partial
            </span>
          </div>
          {info.vins.map(s => <SlotRow key={`f-${s.off}`} slot={s} kind="full"/>)}
          {(info.partials || []).map(s => <SlotRow key={`p-${s.off}`} slot={s} kind="partial"/>)}
          {info.vins[0] && info.vins[0].cv && info.vins[0].cv.ok === false && (
            <div style={{marginTop: 8}}>
              <SLine type="warn" msg={`Stored VIN fails the standard check-digit (expected '${info.vins[0].cv.cd}'). Programming will still work but the VIN may be malformed.`}/>
            </div>
          )}
        </Card>
      )}

      {file && hasSlots && (
        <Card style={{marginBottom: 14}}>
          <div style={{fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.sr, letterSpacing: 1.5, marginBottom: 10}}>3 · NEW VIN</div>
          <div style={{display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6}}>
            <input
              data-testid="vinprog-new-vin"
              value={newVin}
              onChange={e => setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
              maxLength={17}
              placeholder="2C3CDXCT1HH652640"
              style={{
                flex: 1,
                padding: '12px 14px',
                border: `2px solid ${newVin.length === 0 ? C.bd : (newVinCheck.ok ? C.gn : C.er)}`,
                borderRadius: 10,
                fontSize: 16,
                fontFamily: "'JetBrains Mono'",
                fontWeight: 700,
                letterSpacing: 2,
                background: '#fff',
                color: C.tx,
              }}
            />
            <Btn outline color={C.a3} onClick={useMasterVin} disabled={!masterVinValid}>USE MASTER VIN</Btn>
          </div>
          <div style={{fontSize: 11, minHeight: 16}}>
            {newVin.length > 0 && newVin.length < 17 && <span style={{color: C.tm}}>{newVin.length}/17 chars</span>}
            {newVin.length === 17 && newVinCheck.ok && <span style={{color: C.gn, fontWeight: 700}}>✓ valid VIN (check digit {newVinCheck.expected})</span>}
            {newVin.length === 17 && !newVinCheck.ok && <span style={{color: C.er, fontWeight: 700}}>✗ {newVinCheck.err}</span>}
          </div>
          {newVin.length === 17 && newVinCheck.ok && <VinChargerSubtitle vin={newVin} dataTestId="vinprog-vin-decode" style={{marginTop: 8}}/>}

          <div style={{display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap'}}>
            <Btn data-testid="vinprog-patch" color={C.sr} onClick={() => runPatch('patch')} disabled={!canPatch}>
              PATCH VIN
            </Btn>
            <Btn data-testid="vinprog-fix-cs" outline color={C.wn} onClick={() => runPatch('fix')} disabled={!canFixCs}>
              FIX CHECKSUMS ONLY
            </Btn>
            {newVinCheck.ok && <Btn outline color={C.a3} onClick={sendToMaster}>SET AS MASTER VIN</Btn>}
          </div>
          <div style={{fontSize: 10, color: C.tm, marginTop: 8, fontStyle: 'italic'}}>
            FIX CHECKSUMS rewrites every CRC slot using the current VIN found in the file — handy after a manual hex edit left bad checksum bytes behind.
          </div>
        </Card>
      )}

      {result && (
        <Card data-testid="vinprog-result-card" style={{background: '#F0FFF4', borderColor: C.gn + '88'}}>
          <div style={{fontFamily: "'Nunito'", fontWeight: 800, fontSize: 12, color: C.gn, letterSpacing: 1.5, marginBottom: 10}}>
            4 · {result.mode === 'fix' ? 'CHECKSUMS REWRITTEN' : 'PATCH COMPLETE'}
          </div>
          <div style={{fontSize: 12, color: C.tx, marginBottom: 10, fontFamily: "'JetBrains Mono'"}}>
            <div>VIN written: <span style={{fontWeight: 800, letterSpacing: 1}} data-testid="vinprog-result-vin">{result.vin}</span></div>
            <div style={{marginTop: 4, fontSize: 10, color: C.tm}}>{result.bytes.length.toLocaleString()} B output → {result.filename}</div>
          </div>
          <div style={{
            background: '#1A1A1A',
            color: '#A0FFA0',
            padding: 12,
            borderRadius: 8,
            fontFamily: "'JetBrains Mono'",
            fontSize: 11,
            maxHeight: 240,
            overflowY: 'auto',
            marginBottom: 12,
          }} data-testid="vinprog-log">
            {result.log.map((line, i) => <div key={i} style={{padding: '1px 0'}}>{line}</div>)}
          </div>
          <Btn data-testid="vinprog-download" color={C.gn} onClick={onDownload} full>
            DOWNLOAD PATCHED FILE
          </Btn>
        </Card>
      )}

      <Card style={{marginTop: 14, background: '#FFF8F0', fontSize: 11, color: C.tm}}>
        <div style={{fontWeight: 800, color: C.sr, letterSpacing: 1, fontSize: 11, marginBottom: 6}}>BENCH WORK ONLY</div>
        Reads the dropped file in the browser and writes the patched copy back to your downloads folder. Nothing is sent over CAN — pair this tab with the per-module write tabs (BCM / RFHUB / KEY PROG) when you're ready to push the patched bin to the actual module.
      </Card>
      </div>

      <div data-testid="vinprog-subtab-ecm-wrap" style={{display: sub === 'ecm' ? 'block' : 'none'}}>
        <ModuleSubTab
          testidPrefix="vinprog-ecm"
          label="ECM (GPEC2A)"
          blurb="Continental GPEC2A PCM dump — VIN copies, SEC6 secret, checksum verdicts and one-click IMMO fix."
          expectedTypes={['GPEC2A']}
          forceType="GPEC2A"
          mod={ecmMod}
          setMod={setEcmMod}
        >
          {(m) => <Gpec2aImmoPanel mod={m} donorMods={donorMods} onPatched={onEcmPatched}/>}
        </ModuleSubTab>
      </div>

      <div data-testid="vinprog-subtab-bcm-wrap" style={{display: sub === 'bcm' ? 'block' : 'none'}}>
        <ModuleSubTab
          testidPrefix="vinprog-bcm"
          label="BCM"
          blurb="MPC5606B-class BCM dump — per-slot VIN + SEC16 edit with safety-gated export."
          expectedTypes={['BCM']}
          mod={bcmMod}
          setMod={setBcmMod}
        >
          {(m) => <BcmImmoSection mod={m} onPatched={onBcmPatched}/>}
        </ModuleSubTab>
      </div>

      <div data-testid="vinprog-subtab-rfhub-wrap" style={{display: sub === 'rfhub' ? 'block' : 'none'}}>
        <ModuleSubTab
          testidPrefix="vinprog-rfhub"
          label="RFHUB"
          blurb="XC2268 internal-flash RFHUB image — per-slot VIN edit with safety-gated export (legacy RFHUB is read-only here)."
          expectedTypes={['RFHUB', 'XC2268_RFHUB']}
          mod={rfhubMod}
          setMod={setRfhubMod}
        >
          {(m) => <RfhubImmoSection mod={m} onPatched={onRfhubPatched}/>}
        </ModuleSubTab>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────────────
           UDS VIN WRITE (udsEngine session sequence + algos.js vinWriteDids)
           Live-over-CAN VIN programming via UDS 2E WriteDataByIdentifier.
           Generates the full byte sequence: DSC→03→SA→01/02→2E F190+mirrors→22 readback→11 reset.
      ──────────────────────────────────────────────────────────────────────────────── */}
      <div data-testid="vinprog-subtab-uds-wrap" style={{display: sub === 'uds' ? 'block' : 'none'}}>
        <Card style={{marginBottom:14,background:'linear-gradient(135deg,#0A0A3D 0%,#1E1E6F 40%,#4A00E0 100%)',color:'#fff'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <span style={{fontSize:22}}>🔌</span>
            <div>
              <div style={{fontFamily:"'Nunito'",fontWeight:900,fontSize:16,letterSpacing:1}}>UDS VIN WRITE</div>
              <div style={{fontSize:10,opacity:.7,letterSpacing:2,fontWeight:700}}>LIVE CAN · 2E WRITEDATABYIDENTIFIER · ALL VIN MIRRORS</div>
            </div>
          </div>
        </Card>

        <Card style={{marginBottom:14}}>
          <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>1 · SELECT MODULE</div>
          <div style={{fontSize:11,color:C.ts,marginBottom:8}}>
            Module selection determines TX/RX CAN IDs, security algorithm, and which VIN DIDs to write.
            Source: udsEngine MODULE_REGISTRY (RE-verified).
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
            <div>
              <div style={{fontSize:10,color:C.ts,marginBottom:4}}>MODULE</div>
              <select value={udsVinModule} onChange={e=>setUdsVinModule(e.target.value)}
                style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:'#fff',fontSize:12,fontWeight:700}}>
                {allModsList.map(m=><option key={m.code} value={m.code}>{m.code} — {m.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:10,color:C.ts,marginBottom:4}}>CAN IDs (RE-VERIFIED)</div>
              {(() => {
                const mod = allModsList.find(m=>m.code===udsVinModule);
                return mod ? (
                  <div style={{padding:'8px 10px',borderRadius:8,border:'1.5px solid '+C.bd,background:C.c2,fontSize:12,fontFamily:"'JetBrains Mono'"}}>
                    TX <span style={{color:C.a3,fontWeight:800}}>0x{mod.tx.toString(16).toUpperCase().padStart(3,'0')}</span>
                    {' · '}
                    RX <span style={{color:C.a3,fontWeight:800}}>0x{mod.rx.toString(16).toUpperCase().padStart(3,'0')}</span>
                    {mod.sgwRequired&&<span style={{marginLeft:8,fontSize:9,color:C.wn,fontWeight:800}}>[SGW]</span>}
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <div style={{fontSize:10,color:C.ts,marginBottom:4}}>VIN DIDs TO WRITE</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {udsVinDids.map(did=>(
              <span key={did} style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:800,padding:'4px 10px',borderRadius:6,background:C.c2,border:'1px solid '+C.bd,color:C.a3}}>
                0x{did.toString(16).toUpperCase().padStart(4,'0')}
              </span>
            ))}
          </div>
        </Card>

        <Card style={{marginBottom:14}}>
          <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>2 · TARGET VIN</div>
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:6}}>
            <input
              data-testid="vinprog-uds-vin"
              value={udsVin}
              onChange={e=>setUdsVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,'').slice(0,17))}
              maxLength={17}
              placeholder="2C3CDXCT1HH652640"
              style={{flex:1,padding:'12px 14px',border:`2px solid ${udsVin.length===0?C.bd:(udsVinCheck.ok?C.gn:C.er)}`,borderRadius:10,fontSize:16,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:2,background:'#fff',color:C.tx}}
            />
            <Btn outline color={C.a3} onClick={()=>masterVinValid&&setUdsVin(masterVin)} disabled={!masterVinValid}>USE MASTER VIN</Btn>
          </div>
          <div style={{fontSize:11,minHeight:16}}>
            {udsVin.length>0&&udsVin.length<17&&<span style={{color:C.tm}}>{udsVin.length}/17 chars</span>}
            {udsVin.length===17&&udsVinCheck.ok&&<span style={{color:C.gn,fontWeight:700}}>✓ valid VIN (check digit {udsVinCheck.expected})</span>}
            {udsVin.length===17&&!udsVinCheck.ok&&<span style={{color:C.er,fontWeight:700}}>✗ {udsVinCheck.err}</span>}
          </div>
          {udsVin.length===17&&udsVinCheck.ok&&<VinChargerSubtitle vin={udsVin} style={{marginTop:8}}/>}
        </Card>

        <Card style={{marginBottom:14}}>
          <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:10,letterSpacing:2}}>3 · LIVE SEED → KEY</div>
          <div style={{fontSize:11,color:C.ts,marginBottom:8}}>
            After sending SA 01 (seed request), paste the 2-byte seed from the ECU response here.
            The key is computed instantly using the {udsLiveKey?.algo ?? 'SBEC'} algorithm and injected into the SA 02 frame below.
          </div>
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:6}}>
            <input
              data-testid="vinprog-uds-seed"
              value={udsSeedHex}
              onChange={e=>setUdsSeedHex(e.target.value.replace(/[^0-9A-Fa-f\s]/g,'').slice(0,9))}
              placeholder="e.g. 3A 2B or 3A2B"
              style={{flex:1,padding:'10px 14px',border:`2px solid ${udsSeedHex?C.a3:C.bd}`,borderRadius:10,fontSize:14,fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:2,background:'#fff',color:C.tx}}
            />
            <Btn outline color={C.ts} onClick={()=>setUdsSeedHex('')} disabled={!udsSeedHex}>CLEAR</Btn>
          </div>
          {udsLiveKey&&udsLiveKey.keyBytes&&(
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginTop:4}}>
              <span style={{fontSize:11,color:C.ts}}>Seed:</span>
              <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.wn}}>0x{udsSeedHex.replace(/\s+/g,'').toUpperCase()}</span>
              <span style={{fontSize:11,color:C.ts}}>→ Key:</span>
              <span style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.gn}}>0x{udsLiveKey.keyBytes.map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join('')}</span>
              {udsLiveKey.formula&&<span style={{fontSize:10,color:C.ts,fontStyle:'italic'}}>{udsLiveKey.formula}</span>}
            </div>
          )}
          {udsLiveKey&&udsLiveKey.needsAlgosJs&&(
            <div style={{fontSize:11,color:C.wn,marginTop:4}}>
              ⚠ {udsLiveKey.algo} key requires algos.js — use the Seed→Key tab to compute the key, then paste SA 02 manually.
            </div>
          )}
          {!udsLiveKey&&udsSeedHex&&(
            <div style={{fontSize:11,color:C.er,marginTop:4}}>✗ Invalid seed hex</div>
          )}
        </Card>

        {udsVinFrames.length>0&&<Card style={{marginBottom:14}} data-testid="vinprog-uds-frames">
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
            <div style={{fontWeight:800,fontSize:11,color:C.a4,letterSpacing:2}}>4 · UDS FRAME SEQUENCE</div>
            <button onClick={()=>setUdsSeqExpanded(e=>!e)} style={{fontSize:10,color:C.ts,background:'transparent',border:'1px solid '+C.bd,padding:'3px 10px',borderRadius:6,cursor:'pointer'}}>
              {udsSeqExpanded?'▲ Collapse':'▼ Expand'}
            </button>
          </div>
          <div style={{fontSize:11,color:C.ts,marginBottom:8}}>
            {udsVinFrames.length} frames · DSC→03 → SA→01/02 → {udsVinDids.length}×WDBI → {udsVinDids.length}×RDBI verify → ECU reset
          </div>
          {udsSeqExpanded&&<div style={{border:'1px solid '+C.bd,borderRadius:8,background:'#0D0D15',padding:12}}>
            {udsVinFrames.map((frame,i)=>(
              <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'6px 0',borderTop:i>0?'1px solid #1A1A2A':'none',background:frame.isPlaceholder?'rgba(255,170,0,0.06)':'transparent',borderRadius:frame.isPlaceholder?6:0}}>
                <span style={{color:'#555',fontSize:10,minWidth:20,textAlign:'right',paddingTop:1}}>{i+1}</span>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:frame.isPlaceholder?'#FFA726':'#40C4FF',letterSpacing:1,marginBottom:2}}>
                    {frame.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')}
                    {frame.isPlaceholder&&<span style={{fontSize:9,color:'#FFA726',marginLeft:8,fontStyle:'italic'}}>⚠ enter seed above to compute key</span>}
                  </div>
                  <div style={{fontSize:10,color:'#888'}}>{frame.desc}</div>
                </div>
                <button
                  onClick={()=>navigator.clipboard&&navigator.clipboard.writeText(frame.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '))}
                  style={{fontSize:9,color:'#666',background:'transparent',border:'1px solid #333',padding:'2px 8px',borderRadius:4,cursor:'pointer',whiteSpace:'nowrap'}}>
                  COPY
                </button>
              </div>
            ))}
          </div>}
          {!udsSeqExpanded&&<div style={{fontSize:10,color:C.ts,fontStyle:'italic'}}>Expand to view all {udsVinFrames.length} frames with copyable hex</div>}
        </Card>}

        {(!udsVin||udsVin.length<17)&&<Card style={{background:'#FFF8F0',fontSize:11,color:C.tm}}>
          <div style={{fontWeight:800,color:C.sr,letterSpacing:1,fontSize:11,marginBottom:4}}>⚠️ LIVE CAN REQUIRED</div>
          This tab generates the UDS byte sequence for live programming via a J2534 adapter.
          Enter a valid 17-char VIN above to see the full frame list.
          For offline binary patching, use the PATCHER sub-tab.
        </Card>}
      </div>
    </div>
  );
}
