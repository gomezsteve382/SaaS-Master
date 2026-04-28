import React, {useState, useCallback, useRef, useMemo, useContext} from "react";
import {Card, Btn, SLine} from "../lib/ui.jsx";
import {C, TR, WT} from "../lib/constants.js";
import {analyzeFile, patchFile} from "../lib/fileUtils.js";
import {MasterVinContext} from "../lib/masterVinContext.jsx";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";

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

export default function VinProgrammerTab() {
  const {vin: masterVin, vinValid: masterVinValid, setVin: setMasterVin} = useContext(MasterVinContext);
  const fileInputRef = useRef(null);

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
        {info?.sizeWarn && <div style={{marginTop: 10}}><SLine type="warn" msg={info.sizeWarn}/></div>}
        {info?.contentWarn && <div style={{marginTop: 6}}><SLine type="warn" msg={info.contentWarn}/></div>}
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
  );
}
