import React, {useState, useMemo, useCallback, useRef} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C, TR, WT} from "../lib/constants.js";
import {resolveBcmSec16, classifyPcmSec6, corruptFillError, parseModule, pcmChipFromSize} from "../lib/parseModule.js";
import {engParseBcm, engParseRfh, engParsePcm, engWriteBcmVin, engWriteRfhVin} from "./ModuleSync.jsx";
import {analyzeFile, patchFile} from "../lib/fileUtils.js";
import Gpec2aImmoPanel from "../components/Gpec2aImmoPanel.jsx";
import {StatBadge, dl} from "../components/ImmoChecksumPanel.jsx";
import {writeRfhSec16FromBcm, writeRfhSec16Gen1, writeRfhSec16Gen2Slots, writeXc2268Sec16, writePcmSec6, PCM_SEC6_MARKER_OFFSET, PCM_SEC6_OFFSET} from "../lib/securityBytes.js";
import {isXc2268Rfhub} from "../lib/xc2268Rfhub.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {RfhubKeyTypeBanner} from "../components/RfhubKeyTypeBanner.jsx";
import {useMasterVin} from "../lib/masterVinContext.jsx";

const mono = "'JetBrains Mono'";

const VIN_RE = /^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/;
const checkVinDigit = (vin) => {
  if (!VIN_RE.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = TR[c] !== undefined ? TR[c] : parseInt(c, 10);
    sum += v * WT[i];
  }
  const rem = sum % 11;
  const check = rem === 10 ? 'X' : String(rem);
  return vin[8] === check;
};

const hex2 = (b) => (b == null ? "?" : (b & 0xff).toString(16).toUpperCase().padStart(2, "0"));
const bytesHex = (arr) => (arr ? Array.from(arr).map(hex2).join(" ") : "—");
const reverseBytes = (arr) => {
  if (!arr) return null;
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i];
  return out;
};
const arrEq = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/* ────────────────────────────────────────────────────────────────────────────
 * SecuritySyncTab — a lean, security-ONLY workbench. It does ONE job: load a
 * BCM, an RFHUB and a PCM (GPEC2A) dump and show, byte-by-byte, whether their
 * immobiliser secrets are in sync, plus the one-click GPEC2A immo fix.
 *
 * No VIN / CRC / patching tools live here — those stay in the VIN Programmer
 * and per-module tabs. The single source of truth for every relationship is
 * the verified library:
 *   RFHUB SEC16  == reverse(BCM SEC16)            (Gen2 pairing)
 *   PCM  SEC6    == reverse(BCM SEC16)[0:6]       (GPEC2A SEC6)
 * The GPEC2A "Just FIX IT" write delegates to the shared Gpec2aImmoPanel which
 * itself delegates to the verified securityBytes.writePcmSec6 writer.
 * ────────────────────────────────────────────────────────────────────────── */

function FileSlot({label, accent, role, mod, onLoad, onClear, summary}) {
  const inputRef = useRef(null);
  const pick = () => inputRef.current && inputRef.current.click();
  const onChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onLoad(file, new Uint8Array(reader.result));
      if (inputRef.current) inputRef.current.value = "";
    };
    reader.readAsArrayBuffer(file);
  };
  return (
    <Card style={{borderTop: "3px solid " + accent, padding: 16}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8}}>
        <div style={{fontFamily: "'Righteous'", fontSize: 15, color: accent, letterSpacing: 1}}>{label}</div>
        {mod && (
          <button
            onClick={onClear}
            style={{border: "none", background: C.er + "14", color: C.er, fontWeight: 800, fontSize: 10, padding: "3px 9px", borderRadius: 6, cursor: "pointer"}}
          >
            clear
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" onChange={onChange} style={{display: "none"}} data-testid={"secsync-input-" + role} />
      {!mod ? (
        <Btn color={accent} full outline onClick={pick} data-testid={"secsync-load-" + role}>
          📂 LOAD {label}
        </Btn>
      ) : (
        <div>
          <div style={{fontSize: 11, fontWeight: 800, color: C.tx, wordBreak: "break-all", marginBottom: 4}}>{mod.file.name}</div>
          <div style={{fontSize: 10, color: C.tm, fontFamily: mono}}>{mod.bytes.length.toLocaleString()} bytes</div>
          {summary}
          <div style={{marginTop: 8}}>
            <Btn color={accent} full outline onClick={pick}>↻ REPLACE</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

/* One byte-by-byte comparison row. When `expected` is supplied every cell is
 * coloured green (match) or red (mismatch) against it, so the user can see
 * exactly which bytes are out of sync. */
function ByteRow({label, sub, bytes, expected, accent = C.tx, testid}) {
  return (
    <div style={{marginBottom: 12}} data-testid={testid}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5}}>
        <span style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6, textTransform: "uppercase"}}>{label}</span>
        {sub && <span style={{fontSize: 10, color: C.tm}}>{sub}</span>}
      </div>
      {bytes && bytes.length > 0 ? (
        <div style={{display: "flex", flexWrap: "wrap", gap: 4}}>
          {Array.from(bytes).map((b, i) => {
            const match = expected ? b === expected[i] : null;
            const bg = match === null ? C.c2 : match ? C.gn + "22" : C.er + "22";
            const col = match === null ? accent : match ? C.gn : C.er;
            const bd = match === null ? C.bd : match ? C.gn + "55" : C.er + "66";
            return (
              <span
                key={i}
                title={"byte " + i + (expected ? " · expected " + hex2(expected[i]) : "")}
                style={{
                  fontFamily: mono, fontSize: 12, fontWeight: 800, color: col,
                  background: bg, border: "1px solid " + bd, borderRadius: 5,
                  padding: "4px 6px", minWidth: 22, textAlign: "center",
                }}
              >
                {hex2(b)}
              </span>
            );
          })}
        </div>
      ) : (
        <div style={{fontSize: 11, color: C.tm, fontStyle: "italic"}}>— not loaded —</div>
      )}
    </div>
  );
}

export default function SecuritySyncTab() {
  const { vin: masterVin, setVin: setMasterVin, vinValid: masterVinValid } = useMasterVin();
  const [bcm, setBcm] = useState(null);
  const [rfh, setRfh] = useState(null);
  const [pcm, setPcm] = useState(null);
  const [err, setErr] = useState("");
  const [showFixAnyway, setShowFixAnyway] = useState(false);
  // ── VIN + Security combined workflow state ──
  const [comboVin, setComboVin] = useState('');
  const [comboBusy, setComboBusy] = useState(false);
  const [comboResult, setComboResult] = useState(null); // {ok, steps, errors}

  // ── Originals for rollback/undo ──
  // Store the original file bytes as loaded from disk so the user can revert
  // after a bad repair without needing to re-upload.
  const [origBcm, setOrigBcm] = useState(null); // {file, bytes}
  const [origRfh, setOrigRfh] = useState(null);
  const [origPcm, setOrigPcm] = useState(null);

  // Refuse-on-doubt: every slot validates the parsed module type before it is
  // accepted. A wrong-type (but non-corrupt) file would otherwise skew the
  // byte comparison and — worse — feed a misclassified donor into the embedded
  // GPEC2A immo fix, so each loader rejects mismatches with a clear message.
  const loadBcm = useCallback((file, bytes) => {
    const pm = parseModule(bytes, file.name);
    const cf = corruptFillError(pm);
    if (cf) { setErr(cf); return; }
    if (pm.type !== "BCM") { setErr(`Selected file detected as ${pm.type || "UNKNOWN"} — load a BCM dump in this slot.`); return; }
    setErr("");
    // Save original for rollback (only on fresh load from disk, not re-parse after repair)
    if (!file._fromRepair) setOrigBcm({file, bytes: new Uint8Array(bytes)});
    setBcm({file, bytes, parsed: engParseBcm(bytes, file.name)});
  }, []);
  const loadRfh = useCallback((file, bytes) => {
    const pm = parseModule(bytes, file.name);
    const cf = corruptFillError(pm);
    if (cf) { setErr(cf); return; }
    if (pm.type !== "RFHUB" && pm.type !== "XC2268_RFHUB") { setErr(`Selected file detected as ${pm.type || "UNKNOWN"} — load an RFHUB dump in this slot.`); return; }
    setErr("");
    if (!file._fromRepair) setOrigRfh({file, bytes: new Uint8Array(bytes)});
    setRfh({file, bytes, parsed: engParseRfh(bytes, file.name)});
  }, []);
  const loadPcm = useCallback((file, bytes) => {
    // 8 KB files named with 'GPEC', 'PCM', or 'IMMO' are GPEC2A EXT EEPROM captures.
    // parseModule.js blocks filename override for 8 KB files, so we must pass
    // forceType:'GPEC2A' here. Also force for any 4-8 KB file in this PCM slot
    // (the slot only accepts GPEC2A, so user intent is clear).
    const nameUpper = (file.name || '').toUpperCase();
    const sz = bytes.length;
    const nameHint = /GPEC|PCM|IMMO/.test(nameUpper);
    const sizeHint = sz >= 4096 && sz <= 8192;
    const forceOpts = (nameHint || sizeHint) ? {forceType: 'GPEC2A'} : undefined;
    const pm = parseModule(bytes, file.name, forceOpts);
    const cf = corruptFillError(pm);
    if (cf) { setErr(cf); return; }
    if (pm.type !== "GPEC2A") { setErr(`Selected file detected as ${pm.type || "UNKNOWN"} — load a PCM (GPEC2A) dump in this slot.`); return; }
    setErr("");
    setShowFixAnyway(false);
    if (!file._fromRepair) setOrigPcm({file, bytes: new Uint8Array(bytes)});
    setPcm({file, bytes, parsed: engParsePcm(bytes, file.name)});
  }, []);

  // ── Canonical secret extraction (verified-lib only) ──
  const bcmRes = useMemo(() => (bcm && !bcm.parsed.tooSmall ? resolveBcmSec16(bcm.bytes) : null), [bcm]);
  const bcmSec16 = bcmRes && !bcmRes.blank ? bcmRes.bytes : null;
  const expectedRfh = useMemo(() => reverseBytes(bcmSec16), [bcmSec16]);
  const expectedSec6 = useMemo(() => (expectedRfh ? expectedRfh.slice(0, 6) : null), [expectedRfh]);

  const rfhSec16 = rfh && rfh.parsed.sec16 && !rfh.parsed.sec16.virgin ? rfh.parsed.sec16.slot1 : null;

  const pcmSec6Info = useMemo(() => {
    if (!pcm || pcm.parsed.tooSmall || pcm.bytes.length < 0x3CE) return null;
    const raw = pcm.bytes.slice(0x3C8, 0x3CE);
    const marker = pcm.bytes.slice(0x3C4, 0x3C8);
    const markerOk = marker[0] === 0xFF && marker[1] === 0xFF && marker[2] === 0xFF && marker[3] === 0xAA;
    const cls = classifyPcmSec6(raw);
    return {raw, marker, markerOk, cls};
  }, [pcm]);
  const pcmSec6 = pcmSec6Info && pcmSec6Info.cls.populated ? pcmSec6Info.raw : null;

  // ── Verdicts ──
  const rfhVerdict = useMemo(() => {
    if (!bcmSec16) return {label: "NO BCM", good: false, color: C.tm};
    if (!rfhSec16) return {label: rfh ? "RFH BLANK/VIRGIN" : "NO RFHUB", good: false, color: C.tm};
    return arrEq(rfhSec16, expectedRfh)
      ? {label: "✓ IN SYNC", good: true, color: C.gn}
      : {label: "✗ MISMATCH", good: false, color: C.er};
  }, [bcmSec16, rfhSec16, expectedRfh, rfh]);

  const sec6Verdict = useMemo(() => {
    if (!bcmSec16) return {label: "NO BCM", good: false, color: C.tm};
    if (!pcmSec6) return {label: pcm ? (pcmSec6Info && pcmSec6Info.cls.populated === false ? "PCM VIRGIN/BLANK" : "NO PCM SEC6") : "NO PCM", good: false, color: C.tm};
    const matchBytes = arrEq(pcmSec6, expectedSec6);
    if (matchBytes && pcmSec6Info.markerOk) return {label: "✓ IN SYNC", good: true, color: C.gn};
    if (matchBytes && !pcmSec6Info.markerOk) return {label: "⚠ SEC6 OK · IMMO MARKER MISSING", good: false, color: C.wn};
    return {label: "✗ MISMATCH", good: false, color: C.er};
  }, [bcmSec16, pcmSec6, expectedSec6, pcm, pcmSec6Info]);

  // donor mods for the embedded GPEC2A immo-fix panel
  const donorMods = useMemo(() => {
    const list = [];
    if (bcm && !bcm.parsed.tooSmall) list.push({type: "BCM", data: bcm.bytes, filename: bcm.file.name});
    if (rfh && rfhSec16) list.push({type: "RFHUB", data: rfh.bytes, filename: rfh.file.name, vehicleSecret: {bytes: rfhSec16}});
    return list;
  }, [bcm, rfh, rfhSec16]);

  const anyLoaded = bcm || rfh || pcm;

  // ── Wizard state ──
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardResults, setWizardResults] = useState(null); // {rfh, pcm, rfhVerify}

  // ── PCM donor fill shortcut ──
  // Derives the expected SEC6 from the BCM and injects it into the GPEC2A immo
  // panel by updating the PCM bytes in-place via writePcmSec6, then re-parses.
  // This mirrors the "Use Donor" button in Gpec2aImmoPanel but lives directly
  // in the PCM slot card so the user never has to scroll down.
  const applyPcmDonorFill = useCallback(() => {
    if (!pcm || !expectedSec6) return;
    // Pre-repair validation gate
    if (bcmSec16 && bcmSec16.length < 16) {
      setErr(`⛔ PCM DONOR FILL BLOCKED: BCM SEC16 source is only ${bcmSec16.length} bytes (from "${bcmRes?.source}"). Need a full 16-byte source for safe SEC6 derivation.`);
      return;
    }
    try {
      const res = writePcmSec6(pcm.bytes, expectedRfh);
      if (!res.ok) { setErr('PCM donor fill: writePcmSec6 returned 0 patches — PCM size not supported'); return; }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fname = `PCM_IMMO_DONOR_${ts}.bin`;
      const blob = new Blob([res.bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setPcm({ file: { name: fname }, bytes: res.bytes, parsed: engParsePcm(res.bytes, fname) });
    } catch (e) { setErr('PCM donor fill failed: ' + e.message); }
  }, [pcm, expectedSec6, expectedRfh, bcmSec16, bcmRes]);

  // ── Pre-repair validation gate ──
  // Block any repair if the BCM SEC16 source is under 16 bytes.
  // mirror1 (slot 0xEB) stores only 15 bytes (missing byte 16) — insufficient.
  // split (16B), mirror2 (16B), and flat (16B) are all safe full-length sources.
  const bcmSourceSafe = bcmRes && bcmSec16 && bcmSec16.length === 16;
  const bcmSourceWarn = bcmRes && bcmSec16 && bcmSec16.length < 16;
  // mirror1 is the only source that returns < 16 bytes (15B)
  const bcmSourceUnsafe = bcmRes && bcmSec16 && bcmRes.source === 'mirror1' && bcmSec16.length < 16;

  // ── PCM SEC6 Clear (zero) tool ──
  // For virgin BCM cases where no SEC6 should exist: writes 6 zero bytes at 0x3C8
  // and clears the IMMO marker at 0x3C4 (sets to 00 00 00 00).
  const clearPcmSec6 = useCallback(() => {
    if (!pcm) return;
    try {
      const out = new Uint8Array(pcm.bytes);
      // Clear IMMO marker at 0x3C4
      for (let k = 0; k < 4; k++) out[PCM_SEC6_MARKER_OFFSET + k] = 0x00;
      // Clear SEC6 at 0x3C8
      for (let k = 0; k < 6; k++) out[PCM_SEC6_OFFSET + k] = 0x00;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fname = `PCM_SEC6_CLEARED_${ts}.bin`;
      const blob = new Blob([out], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setPcm({ file: { name: fname, _fromRepair: true }, bytes: out, parsed: engParsePcm(out, fname) });
    } catch (e) { setErr('Clear SEC6 failed: ' + e.message); }
  }, [pcm]);

  // ── Rollback/Undo — revert to original loaded file ──
  const revertBcm = useCallback(() => {
    if (!origBcm) return;
    setBcm({ file: origBcm.file, bytes: new Uint8Array(origBcm.bytes), parsed: engParseBcm(origBcm.bytes, origBcm.file.name) });
    setWizardResults(null);
  }, [origBcm]);
  const revertRfh = useCallback(() => {
    if (!origRfh) return;
    setRfh({ file: origRfh.file, bytes: new Uint8Array(origRfh.bytes), parsed: engParseRfh(origRfh.bytes, origRfh.file.name) });
    setWizardResults(null);
  }, [origRfh]);
  const revertPcm = useCallback(() => {
    if (!origPcm) return;
    setPcm({ file: origPcm.file, bytes: new Uint8Array(origPcm.bytes), parsed: engParsePcm(origPcm.bytes, origPcm.file.name) });
    setShowFixAnyway(false);
    setWizardResults(null);
  }, [origPcm]);

  const rfhNeedsFix = !!(bcmSec16 && rfh && !rfh.parsed.tooSmall && !rfhVerdict.good);
  const pcmNeedsFix = !!(bcmSec16 && pcm && !pcm.parsed.tooSmall && !sec6Verdict.good);
  const wizardCanRun = rfhNeedsFix || pcmNeedsFix;

  // ── VIN match status across modules ──
  const bcmVin = bcm && !bcm.parsed.tooSmall ? (bcm.parsed.vin || null) : null;
  const rfhVin = rfh && !rfh.parsed.tooSmall ? (rfh.parsed.vin || null) : null;
  const pcmVin = pcm && !pcm.parsed.tooSmall ? (pcm.parsed.vin || null) : null;
  const vinConsensus = useMemo(() => {
    const vins = [bcmVin, rfhVin, pcmVin].filter(Boolean);
    if (!vins.length) return null;
    const first = vins[0];
    return vins.every(v => v === first) ? first : null;
  }, [bcmVin, rfhVin, pcmVin]);
  const vinAllMatch = !!(vinConsensus && [bcmVin, rfhVin, pcmVin].filter(Boolean).length >= 2);
  const vinHasMismatch = useMemo(() => {
    const vins = [bcmVin, rfhVin, pcmVin].filter(Boolean);
    if (vins.length < 2) return false;
    return !vins.every(v => v === vins[0]);
  }, [bcmVin, rfhVin, pcmVin]);

  // ── Combo VIN + Security fix ──
  // Derives the effective target VIN: typed input > master VIN > consensus from loaded modules
  const effectiveVin = useMemo(() => {
    const v = comboVin.trim().toUpperCase();
    if (VIN_RE.test(v)) return v;
    if (masterVinValid) return masterVin;
    if (vinConsensus && VIN_RE.test(vinConsensus)) return vinConsensus;
    return null;
  }, [comboVin, masterVin, masterVinValid, vinConsensus]);

  const applyComboFix = useCallback(async () => {
    const targetVin = effectiveVin;
    if (!targetVin) return;
    if (!bcm && !rfh && !pcm) return;
    if (comboBusy) return;
    setComboBusy(true);
    setComboResult(null);
    const steps = [];
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Track live patched bytes locally (React state updates are async)
    let liveBcmBytes = bcm ? new Uint8Array(bcm.bytes) : null;
    let liveRfhBytes = rfh ? new Uint8Array(rfh.bytes) : null;
    let livePcmBytes = pcm ? new Uint8Array(pcm.bytes) : null;
    let liveRfhFormat = rfh ? rfh.parsed.format : null;

    // ── Step 1: Write VIN + checksum to BCM ──
    if (bcm && !bcm.parsed.tooSmall) {
      try {
        const af = analyzeFile(liveBcmBytes, bcm.file.name);
        const pf = patchFile(af, targetVin);
        const fname = `BCM_VIN_${targetVin}_${ts}.bin`;
        dl(pf.data, fname);
        liveBcmBytes = pf.data;
        setBcm({ file: { name: fname }, bytes: pf.data, parsed: engParseBcm(pf.data, fname) });
        steps.push({ mod: 'BCM', ok: true, fname, log: pf.log });
      } catch (e) {
        steps.push({ mod: 'BCM', ok: false, error: e.message });
      }
    }

    // ── Step 2: Write VIN + checksum to RFHUB ──
    if (rfh && !rfh.parsed.tooSmall) {
      try {
        const af = analyzeFile(liveRfhBytes, rfh.file.name);
        const pf = patchFile(af, targetVin);
        const fname = `RFHUB_VIN_${targetVin}_${ts}.bin`;
        dl(pf.data, fname);
        liveRfhBytes = pf.data;
        const newRfhParsed = engParseRfh(pf.data, fname);
        liveRfhFormat = newRfhParsed.format;
        setRfh({ file: { name: fname }, bytes: pf.data, parsed: newRfhParsed });
        steps.push({ mod: 'RFHUB', ok: true, fname, log: pf.log });
      } catch (e) {
        steps.push({ mod: 'RFHUB', ok: false, error: e.message });
      }
    }

    // ── Step 3: Write VIN + checksum to PCM (GPEC2A) ──
    if (pcm && !pcm.parsed.tooSmall) {
      try {
        const af = analyzeFile(livePcmBytes, pcm.file.name);
        const pf = patchFile(af, targetVin);
        const fname = `PCM_VIN_${targetVin}_${ts}.bin`;
        dl(pf.data, fname);
        livePcmBytes = pf.data;
        setPcm({ file: { name: fname }, bytes: pf.data, parsed: engParsePcm(pf.data, fname) });
        steps.push({ mod: 'PCM', ok: true, fname, log: pf.log });
      } catch (e) {
        steps.push({ mod: 'PCM', ok: false, error: e.message });
      }
    }

    // ── Step 4: Sync security bytes (RFHUB SEC16 + PCM SEC6) from BCM ──
    // Use the live (freshly-patched) BCM bytes — not the async React state
    if (liveBcmBytes) {
      const freshBcmRes = resolveBcmSec16(liveBcmBytes);
      const freshSec16 = freshBcmRes && !freshBcmRes.blank ? freshBcmRes.bytes : null;
      if (freshSec16 && freshSec16.length === 16) {
        const freshExpectedRfh = reverseBytes(freshSec16);
        // Fix RFHUB SEC16
        if (rfh && !rfh.parsed.tooSmall && liveRfhBytes) {
          try {
            let res;
            if (isXc2268Rfhub(liveRfhBytes)) {
              res = writeXc2268Sec16(liveRfhBytes, freshSec16);
            } else if (liveRfhFormat === 'gen1') {
              res = writeRfhSec16Gen1(liveRfhBytes, freshSec16);
            } else if (liveRfhFormat === 'gen2-hybrid') {
              res = writeRfhSec16Gen2Slots(liveRfhBytes, freshSec16);
            } else {
              res = writeRfhSec16FromBcm(liveRfhBytes, freshSec16);
            }
            const fname = `RFHUB_VIN_SEC16_${targetVin}_${ts}.bin`;
            dl(res.bytes, fname);
            liveRfhBytes = res.bytes;
            setRfh({ file: { name: fname }, bytes: res.bytes, parsed: engParseRfh(res.bytes, fname) });
            steps.push({ mod: 'RFHUB SEC16', ok: true, fname });
          } catch (e) {
            steps.push({ mod: 'RFHUB SEC16', ok: false, error: e.message });
          }
        }
        // Fix PCM SEC6
        if (pcm && !pcm.parsed.tooSmall && livePcmBytes) {
          try {
            const res = writePcmSec6(livePcmBytes, freshExpectedRfh);
            if (!res.ok) throw new Error('writePcmSec6 returned 0 patches');
            const fname = `PCM_VIN_SEC6_${targetVin}_${ts}.bin`;
            dl(res.bytes, fname);
            livePcmBytes = res.bytes;
            setPcm({ file: { name: fname }, bytes: res.bytes, parsed: engParsePcm(res.bytes, fname) });
            steps.push({ mod: 'PCM SEC6', ok: true, fname });
          } catch (e) {
            steps.push({ mod: 'PCM SEC6', ok: false, error: e.message });
          }
        }
      } else if (bcm) {
        steps.push({ mod: 'SECURITY BYTES', ok: false, error: 'BCM SEC16 not available or insufficient — security bytes not synced (VIN was still written)' });
      }
    }

    // Publish VIN to master context
    setMasterVin(targetVin);
    const allOk = steps.every(s => s.ok);
    setComboResult({ ok: allOk, steps });
    setComboBusy(false);
  }, [effectiveVin, bcm, rfh, pcm, comboBusy, setMasterVin]);

  const applyAllFixes = useCallback(async () => {
    if (!wizardCanRun || wizardBusy) return;
    // Pre-repair validation gate: block if BCM SEC16 source is insufficient
    if (bcmSourceUnsafe || bcmSourceWarn) {
      setErr(`⛔ REPAIR BLOCKED: BCM SEC16 source is "${bcmRes.source}" (${bcmSec16.length} bytes). Only split or mirror2 sources provide a full 16-byte secret safe for repair. This ${bcmSec16.length}-byte value may contain partial or unreliable data. Load a BCM with a split or mirror2 SEC16 source, or use the "Clear SEC6" tool if the BCM is truly virgin.`);
      return;
    }
    setWizardBusy(true);
    setWizardResults(null);
    const results = { rfh: null, pcm: null };
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Step 1 — RFHUB
    if (rfhNeedsFix) {
      try {
        let res;
        if (isXc2268Rfhub(rfh.bytes)) {
          res = writeXc2268Sec16(rfh.bytes, bcmSec16);
        } else if (rfh.parsed.format === 'gen1') {
          res = writeRfhSec16Gen1(rfh.bytes, bcmSec16);
        } else if (rfh.parsed.format === 'gen2-hybrid') {
          // gen2-hybrid: 4 KB file with empty Gen2 slots and no AA-55-31-01 banner.
          // Write to the Gen2 slot offsets (0x050E / 0x0522) without the header guard.
          res = writeRfhSec16Gen2Slots(rfh.bytes, bcmSec16);
        } else {
          res = writeRfhSec16FromBcm(rfh.bytes, bcmSec16);
        }
        const fname = `RFHUB_SEC16_FIXED_${ts}.bin`;
        const blob = new Blob([res.bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setRfh({ file: { name: fname }, bytes: res.bytes, parsed: engParseRfh(res.bytes, fname) });
        // Post-fix verification: re-parse the patched RFHUB and confirm SEC16 matches expected
        const verifyParsed = engParseRfh(res.bytes, fname);
        const verifySlot = verifyParsed.sec16 && !verifyParsed.sec16.virgin ? verifyParsed.sec16.slot1 : null;
        const verifyMatch = verifySlot && expectedRfh && arrEq(verifySlot, expectedRfh);
        results.rfh = { ok: true, fname, hex: res.rfhSec16Hex, patched: res.patched, verify: { match: verifyMatch, hex: verifySlot ? bytesHex(verifySlot) : null } };
      } catch (e) {
        results.rfh = { ok: false, error: e.message };
      }
    }

    // Step 2 — PCM (uses the freshly-patched RFHUB sec16 if available)
    if (pcmNeedsFix) {
      try {
        // Use the rfhSec16 derived from BCM (canonical source)
        const rfhBytes = expectedRfh;
        if (!rfhBytes) throw new Error('Cannot derive PCM SEC6 — BCM SEC16 not available');
        const res = writePcmSec6(pcm.bytes, rfhBytes);
        if (!res.ok) throw new Error('writePcmSec6 returned 0 patches — PCM size not supported');
        const fname = `PCM_IMMO_FIXED_${ts}.bin`;
        const blob = new Blob([res.bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setPcm({ file: { name: fname }, bytes: res.bytes, parsed: engParsePcm(res.bytes, fname) });
        results.pcm = { ok: true, fname, hex: res.sec6Hex };
      } catch (e) {
        results.pcm = { ok: false, error: e.message };
      }
    }

    setWizardResults(results);
    setWizardBusy(false);
  }, [wizardCanRun, wizardBusy, rfhNeedsFix, pcmNeedsFix, bcmSec16, rfh, pcm, expectedRfh, bcmSourceUnsafe, bcmSourceWarn, bcmRes]);

  // ── Overall GO / NO-GO on the security bytes ──
  // A single, prominent verdict so the user does not have to read the byte grid
  // to know whether the set is paired. NO-GO (red) only fires on a real
  // mismatch (or a missing IMMO marker); a blank/virgin or not-yet-loaded
  // module is PARTIAL (amber), never a false alarm.
  const overall = useMemo(() => {
    if (!anyLoaded) return {label: "LOAD MODULES", color: C.tm, detail: "Load a BCM, RFHUB and PCM to evaluate the immobiliser pairing."};
    if (!bcmSec16) return {label: "NEED BCM", color: C.wn, detail: "The BCM is the canonical secret source — load a BCM with a populated SEC16."};
    const rfhMismatch = rfh && rfhVerdict.color === C.er;
    const pcmMismatch = pcm && (sec6Verdict.color === C.er || sec6Verdict.color === C.wn);
    if (rfhMismatch || pcmMismatch) {
      return {label: "⛔ NO-GO", color: C.er, detail: "One or more modules are NOT paired with the BCM — see the red bytes below."};
    }
    const pending = [];
    if (!rfh || !rfhVerdict.good) pending.push(rfh ? "RFHUB (blank/virgin)" : "RFHUB");
    if (!pcm || !sec6Verdict.good) pending.push(pcm ? "PCM (blank/virgin)" : "PCM");
    if (pending.length) {
      return {label: "● PARTIAL", color: C.wn, detail: "Loaded secrets are in sync. Still pending: " + pending.join(", ") + "."};
    }
    return {label: "✅ GO", color: C.gn, detail: "BCM ⇄ RFHUB ⇄ PCM secrets are all in sync — this set is paired."};
  }, [anyLoaded, bcmSec16, rfh, pcm, rfhVerdict, sec6Verdict]);

  return (
    <div data-testid="security-sync-tab">
      <Card style={{marginBottom: 16, borderTop: "3px solid " + C.sr}}>
        <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.sr, letterSpacing: 1}}>🔐 SECURITY SYNC</div>
        <div style={{fontSize: 11, color: C.tm, marginTop: 4, lineHeight: 1.5}}>
          Load a <strong>BCM</strong>, <strong>RFHUB</strong> and <strong>PCM (GPEC2A)</strong> dump. This workbench checks and fixes:
          (1) <strong>VIN match</strong> across all three modules, (2) <strong>VIN + checksum write</strong> to all modules in one click, and
          (3) <strong>Security byte pairing</strong> — <span style={{fontFamily: mono, color: C.ts}}>RFHUB SEC16 = reverse(BCM SEC16)</span> ·{" "}
          <span style={{fontFamily: mono, color: C.ts}}>PCM SEC6 = reverse(BCM SEC16)[0:6]</span>. All writes are verified against the canonical algorithms.
        </div>
      </Card>

      {/* ── AUTO-REPAIR WIZARD ── */}
      {anyLoaded && (
        <Card style={{marginBottom: 16, borderLeft: `5px solid ${wizardCanRun ? C.wn : (wizardResults ? C.gn : C.tm)}`}} data-testid="secsync-wizard">
          <div style={{fontFamily: "'Righteous'", fontSize: 16, color: wizardCanRun ? C.wn : (wizardResults ? C.gn : C.tm), letterSpacing: 1, marginBottom: 10}}>⚡ AUTO-REPAIR WIZARD</div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 12}}>
            {/* Step 1 — BCM (source, no fix needed) */}
            <div style={{padding: '10px 12px', borderRadius: 8, background: C.c2, border: `1px solid ${bcmSec16 ? C.gn + '55' : C.bd}`}}>
              <div style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>STEP 1 · BCM</div>
              <div style={{fontSize: 11, color: bcmSec16 ? C.gn : C.tm, fontWeight: 700}}>{bcmSec16 ? '✓ SEC16 loaded — canonical source' : bcm ? '⚠ SEC16 blank/virgin' : '— not loaded'}</div>
            </div>
            {/* Step 2 — RFHUB */}
            <div style={{padding: '10px 12px', borderRadius: 8, background: C.c2, border: `1px solid ${rfhVerdict.good ? C.gn + '55' : rfhNeedsFix ? C.er + '55' : C.bd}`}}>
              <div style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>STEP 2 · RFHUB SEC16</div>
                <div style={{fontSize: 11, fontWeight: 700, color: rfhVerdict.good ? C.gn : rfhNeedsFix ? C.er : C.tm}}>
                {rfhVerdict.good ? '✓ In sync — no fix needed'
                  : rfhNeedsFix ? '✗ Mismatch — will fix'
                  : rfh ? '— blank/virgin'
                  : '— not loaded'}
              </div>
              {rfh && !rfhSec16 && !rfhVerdict.good && (
                <div style={{fontSize: 10, color: C.tm, marginTop: 4, lineHeight: 1.4}} data-testid="secsync-rfh-virgin-explain">
                  RFHUB SEC16 is virgin — this module was never programmed with a vehicle secret (factory default) or was wiped. The fix will write the correct reverse(BCM SEC16) value.
                </div>
              )}
              {wizardResults && wizardResults.rfh && (
                <div style={{fontSize: 10, marginTop: 4, color: wizardResults.rfh.ok ? C.gn : C.er}}>
                  {wizardResults.rfh.ok
                    ? `✓ Fixed · ${wizardResults.rfh.patched} slot(s) · ${wizardResults.rfh.fname}`
                    : `✗ ${wizardResults.rfh.error}`}
                </div>
              )}
              {wizardResults && wizardResults.rfh && wizardResults.rfh.ok && wizardResults.rfh.verify && (
                <div
                  data-testid="secsync-rfh-postfix-verify"
                  style={{fontSize: 10, marginTop: 3, color: wizardResults.rfh.verify.match ? C.gn : C.er, fontWeight: 700}}
                >
                  {wizardResults.rfh.verify.match
                    ? `✓ Post-fix verify PASSED — written SEC16 matches reverse(BCM SEC16)`
                    : `⚠ Post-fix verify FAILED — written SEC16 does not match expected`}
                </div>
              )}
            </div>
            {/* Step 3 — PCM */}
            <div style={{padding: '10px 12px', borderRadius: 8, background: C.c2, border: `1px solid ${sec6Verdict.good ? C.gn + '55' : pcmNeedsFix ? C.er + '55' : C.bd}`}}>
              <div style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>STEP 3 · PCM SEC6</div>
              <div style={{fontSize: 11, fontWeight: 700, color: sec6Verdict.good ? C.gn : pcmNeedsFix ? C.er : C.tm}}>
                {sec6Verdict.good ? '✓ In sync — no fix needed'
                  : pcmNeedsFix ? '✗ Mismatch — will fix'
                  : pcm ? '— blank/virgin'
                  : '— not loaded'}
              </div>
              {wizardResults && wizardResults.pcm && (
                <div style={{fontSize: 10, marginTop: 4, color: wizardResults.pcm.ok ? C.gn : C.er}}>
                  {wizardResults.pcm.ok ? `✓ Fixed · ${wizardResults.pcm.fname}` : `✗ ${wizardResults.pcm.error}`}
                </div>
              )}
            </div>
          </div>
          {/* Pre-repair validation gate warning */}
          {bcmSourceWarn && wizardCanRun && (
            <div data-testid="secsync-validation-gate-warn" style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 10,
              background: '#FFF3CD', border: '1px solid #FFCA28', color: '#5D4037',
            }}>
              <div style={{fontWeight: 800, fontSize: 11, marginBottom: 4}}>⛔ REPAIR BLOCKED — INSUFFICIENT SEC16 SOURCE</div>
              <div style={{fontSize: 10, lineHeight: 1.5}}>
                BCM SEC16 source is <strong style={{fontFamily: mono}}>{bcmRes?.source}</strong> ({bcmSec16?.length} bytes).
                Only <strong>split</strong> or <strong>mirror2</strong> sources provide a full 16-byte secret safe for repair.
                An 8-byte source may contain partial or FEE counter data that would produce incorrect security bytes.
                <br/><br/>
                <strong>Options:</strong> Load a BCM with a split/mirror2 SEC16, or use the "⚠️ Clear SEC6" tool below if the BCM is truly virgin and no SEC6 should exist.
              </div>
            </div>
          )}
          {wizardCanRun ? (
            <button
              onClick={applyAllFixes}
              disabled={wizardBusy || bcmSourceWarn}
              data-testid="secsync-wizard-apply-btn"
              style={{
                width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', cursor: (wizardBusy || bcmSourceWarn) ? 'not-allowed' : 'pointer',
                background: (wizardBusy || bcmSourceWarn) ? C.bd : C.wn, color: '#000', fontFamily: "'Righteous'", fontSize: 15, fontWeight: 800, letterSpacing: 1,
                opacity: (wizardBusy || bcmSourceWarn) ? 0.6 : 1, transition: 'opacity 0.15s',
              }}
            >
              {wizardBusy ? '⏳ APPLYING FIXES…' : bcmSourceWarn ? '⛔ BLOCKED — SEC16 SOURCE INSUFFICIENT' : `⚡ APPLY ALL FIXES (${[rfhNeedsFix && 'RFHUB', pcmNeedsFix && 'PCM'].filter(Boolean).join(' + ')}) & DOWNLOAD`}
            </button>
          ) : wizardResults ? (
            <div style={{fontSize: 12, color: C.gn, fontWeight: 800, textAlign: 'center', padding: '8px 0'}}>✅ All repairs applied — patched files downloaded above.</div>
          ) : (
            <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic', textAlign: 'center', padding: '8px 0'}}>
              {!bcmSec16 ? 'Load a BCM with a populated SEC16 to enable the wizard.' : 'All loaded modules are already in sync — nothing to repair.'}
            </div>
          )}
        </Card>
      )}

      {err && (
        <Card style={{marginBottom: 16, borderLeft: "3px solid " + C.er, background: C.er + "0C"}}>
          <div style={{fontSize: 11, color: C.er, fontWeight: 700, whiteSpace: "pre-wrap"}} data-testid="secsync-error">{err}</div>
        </Card>
      )}

      <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 16}}>
        <FileSlot
          label="BCM" accent={C.sr} role="bcm" mod={bcm}
          onLoad={loadBcm} onClear={() => setBcm(null)}
          summary={bcm && (
            <div style={{marginTop: 6, fontSize: 10}}>
              {bcm.parsed.tooSmall ? <StatBadge value="TOO SMALL" good={false} />
                : <>
                    <div style={{color: C.ts}}>VIN: <span style={{fontFamily: mono, color: C.tx}}>{bcm.parsed.vin || "—"}</span></div>
                    <div style={{marginTop: 3}}>{bcmSec16 ? <StatBadge value={"SEC16 · " + (bcmRes.source || "set")} good /> : <StatBadge value="SEC16 BLANK" good={false} />}</div>
                    {/* Source length warning */}
                    {bcmSec16 && bcmSec16.length < 16 && (
                      <div style={{marginTop: 3, fontSize: 9, color: '#E65100', fontWeight: 700}}>
                        ⚠️ {bcmSec16.length}B source ({bcmRes.source}) — insufficient for repair
                      </div>
                    )}
                  </>}
              {/* Rollback button */}
              {origBcm && bcm.file.name !== origBcm.file.name && (
                <button
                  onClick={revertBcm}
                  data-testid="secsync-bcm-revert-btn"
                  style={{
                    marginTop: 6, width: '100%', padding: '4px 0', borderRadius: 5,
                    border: `1px solid ${C.wn}66`, background: C.wn + '14', color: C.wn,
                    fontFamily: "'Righteous'", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, cursor: 'pointer',
                  }}
                >
                  ↩ REVERT TO ORIGINAL
                </button>
              )}
            </div>
          )}
        />
        <FileSlot
          label="RFHUB" accent={C.a2} role="rfh" mod={rfh}
          onLoad={loadRfh} onClear={() => setRfh(null)}
          summary={rfh && (
            <div style={{marginTop: 6, fontSize: 10}}>
              {rfh.parsed.tooSmall ? <StatBadge value="TOO SMALL" good={false} />
                : <>
                    <div style={{color: C.ts}}>VIN: <span style={{fontFamily: mono, color: C.tx}}>{rfh.parsed.vin || "—"}</span> · {rfh.parsed.format}</div>
                    <div style={{marginTop: 3}}>{rfhSec16 ? <StatBadge value="SEC16 SET" good /> : <StatBadge value="SEC16 VIRGIN" good={false} />}</div>
                  </>}
              {/* Rollback button */}
              {origRfh && rfh.file.name !== origRfh.file.name && (
                <button
                  onClick={revertRfh}
                  data-testid="secsync-rfh-revert-btn"
                  style={{
                    marginTop: 6, width: '100%', padding: '4px 0', borderRadius: 5,
                    border: `1px solid ${C.wn}66`, background: C.wn + '14', color: C.wn,
                    fontFamily: "'Righteous'", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, cursor: 'pointer',
                  }}
                >
                  ↩ REVERT TO ORIGINAL
                </button>
              )}
            </div>
          )}
        />
        <FileSlot
          label="PCM" accent={C.a4 || C.wn} role="pcm" mod={pcm}
          onLoad={loadPcm} onClear={() => { setPcm(null); setShowFixAnyway(false); }}
          summary={pcm && (() => {
            const chip = pcmChipFromSize(pcm.bytes.length);
            const sec6Label = pcmSec6Info ? classifyPcmSec6(pcmSec6Info.raw).label : null;
            const sec6Populated = pcmSec6Info && pcmSec6Info.cls.populated;
            return (
              <div style={{marginTop: 6, fontSize: 10}}>
                {pcm.parsed.tooSmall ? <StatBadge value="TOO SMALL" good={false} /> : (
                  <>
                    {/* Chip label badge */}
                    <div style={{marginBottom: 3}}>
                      <span
                        data-testid="secsync-pcm-chip-badge"
                        style={{
                          display: 'inline-block', fontFamily: mono, fontSize: 10, fontWeight: 800,
                          background: chip ? C.a4 + '22' : C.wn + '22',
                          color: chip ? (C.a4 || C.wn) : C.wn,
                          border: '1px solid ' + (chip ? (C.a4 || C.wn) + '55' : C.wn + '55'),
                          borderRadius: 5, padding: '2px 7px', letterSpacing: 0.5,
                        }}
                      >
                        {chip ? chip.label : pcm.bytes.length.toLocaleString() + ' B · UNKNOWN CHIP'}
                      </span>
                    </div>
                    <div style={{color: C.ts}}>VIN: <span style={{fontFamily: mono, color: C.tx}}>{pcm.parsed.vin || '—'}</span></div>
                    {/* SEC6 populated/virgin badge */}
                    <div style={{marginTop: 3}} data-testid="secsync-pcm-sec6-badge">
                      {sec6Populated
                        ? <StatBadge value="SEC6 POPULATED" good />
                        : sec6Label
                          ? <StatBadge value={'SEC6 ' + sec6Label.toUpperCase().replace('✓ ', '')} good={false} />
                          : <StatBadge value="NO SEC6" good={false} />}
                    </div>
                    {/* Use Donor shortcut — only show when BCM SEC16 is available and PCM SEC6 is mismatched */}
                    {expectedSec6 && !sec6Verdict.good && bcmSourceSafe && (
                      <div style={{marginTop: 6}}>
                        <button
                          data-testid="secsync-pcm-donor-fill-btn"
                          onClick={applyPcmDonorFill}
                          style={{
                            width: '100%', padding: '5px 0', borderRadius: 6, border: `1px solid ${C.gn}66`,
                            background: C.gn + '18', color: C.gn, fontFamily: "'Righteous'", fontSize: 10,
                            fontWeight: 800, letterSpacing: 0.8, cursor: 'pointer',
                          }}
                        >
                          ⚡ USE DONOR · WRITE SEC6 & DOWNLOAD
                        </button>
                        <div style={{fontSize: 9, color: C.tm, marginTop: 3, lineHeight: 1.4}}>
                          Writes reverse(BCM SEC16)[0:6] as SEC6 and downloads the patched PCM file.
                        </div>
                      </div>
                    )}
                    {/* Clear SEC6 tool — for virgin BCM cases */}
                    {sec6Populated && (
                      <div style={{marginTop: 6}}>
                        <button
                          data-testid="secsync-pcm-clear-sec6-btn"
                          onClick={clearPcmSec6}
                          style={{
                            width: '100%', padding: '5px 0', borderRadius: 6, border: '1px solid #E6515166',
                            background: '#E6515118', color: '#E65151', fontFamily: "'Righteous'", fontSize: 10,
                            fontWeight: 800, letterSpacing: 0.8, cursor: 'pointer',
                          }}
                        >
                          ⚠️ CLEAR SEC6 · ZERO OUT & DOWNLOAD
                        </button>
                        <div style={{fontSize: 9, color: C.tm, marginTop: 3, lineHeight: 1.4}}>
                          Writes 6 zero bytes at 0x3C8 and clears the IMMO marker. Use when BCM is virgin and no SEC6 should exist.
                        </div>
                      </div>
                    )}
                  </>
                )}
                {/* Rollback button */}
                {origPcm && pcm.file.name !== origPcm.file.name && (
                  <button
                    onClick={revertPcm}
                    data-testid="secsync-pcm-revert-btn"
                    style={{
                      marginTop: 6, width: '100%', padding: '4px 0', borderRadius: 5,
                      border: `1px solid ${C.wn}66`, background: C.wn + '14', color: C.wn,
                      fontFamily: "'Righteous'", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, cursor: 'pointer',
                    }}
                  >
                    ↩ REVERT TO ORIGINAL
                  </button>
                )}
              </div>
            );
          })()}
        />
      </div>

      {/* ── VIN MATCH STATUS CARD ── */}
      {anyLoaded && (
        <Card style={{marginBottom: 16, borderLeft: `5px solid ${vinHasMismatch ? C.er : vinAllMatch ? C.gn : C.wn}`}} data-testid="secsync-vin-match">
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15, color: vinHasMismatch ? C.er : vinAllMatch ? C.gn : C.wn, letterSpacing: 1}}>
              {vinHasMismatch ? '⛔ VIN MISMATCH' : vinAllMatch ? '✅ VIN MATCH' : '⚠ VIN STATUS'}
            </div>
            {vinConsensus && <span style={{fontFamily: mono, fontSize: 13, color: C.tx, fontWeight: 800}}>{vinConsensus}</span>}
          </div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8}}>
            {[
              {label: 'BCM', vin: bcmVin, accent: C.sr},
              {label: 'RFHUB', vin: rfhVin, accent: C.a2},
              {label: 'PCM', vin: pcmVin, accent: C.a4 || C.wn},
            ].map(({label, vin, accent}) => {
              const match = vin && vinConsensus ? vin === vinConsensus : null;
              const col = vin ? (match === false ? C.er : match === true ? C.gn : C.ts) : C.tm;
              return (
                <div key={label} style={{padding: '8px 10px', borderRadius: 7, background: C.c2, border: `1px solid ${accent}44`}}>
                  <div style={{fontSize: 9, fontWeight: 800, color: accent, letterSpacing: 1, marginBottom: 4}}>{label}</div>
                  <div style={{fontFamily: mono, fontSize: 11, color: col, fontWeight: 700, wordBreak: 'break-all'}}>
                    {vin || <span style={{color: C.tm, fontStyle: 'italic'}}>not loaded</span>}
                  </div>
                  {vin && vinConsensus && (
                    <div style={{fontSize: 9, marginTop: 3, color: col, fontWeight: 800}}>
                      {vin === vinConsensus ? '✓ MATCH' : '✗ MISMATCH'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {vinHasMismatch && (
            <div style={{marginTop: 8, fontSize: 10, color: C.er, fontWeight: 700}}>
              ⚠ VINs do not match across modules — use the WRITE VIN + FIX SECURITY card below to align all three.
            </div>
          )}
        </Card>
      )}

      {/* ── WRITE VIN + FIX SECURITY (combined workflow) ── */}
      {anyLoaded && (
        <Card style={{marginBottom: 16, borderLeft: `5px solid ${C.sr}`, background: C.sr + '06'}} data-testid="secsync-combo-fix">
          <div style={{fontFamily: "'Righteous'", fontSize: 16, color: C.sr, letterSpacing: 1, marginBottom: 6}}>🔑 WRITE VIN + FIX SECURITY — ALL MODULES</div>
          <div style={{fontSize: 10, color: C.tm, marginBottom: 12, lineHeight: 1.5}}>
            One-click: writes the target VIN + checksums to every loaded module, then syncs RFHUB SEC16 and PCM SEC6 from the BCM.
            All three patched files are downloaded automatically. The BCM must be loaded and have a valid SEC16 for security byte sync.
          </div>
          {/* VIN input */}
          <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10}}>
            <div style={{flex: 1, minWidth: 200}}>
              <input
                type="text"
                value={comboVin}
                onChange={e => setComboVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17))}
                placeholder={effectiveVin || 'Enter 17-char VIN (or use Master VIN)'}
                maxLength={17}
                data-testid="secsync-combo-vin-input"
                style={{
                  width: '100%', padding: '9px 12px', borderRadius: 7,
                  border: `1px solid ${effectiveVin ? (checkVinDigit(effectiveVin) ? C.gn + '88' : C.wn + '88') : C.bd}`,
                  background: C.c2, color: C.tx, fontFamily: mono, fontSize: 13, fontWeight: 800,
                  letterSpacing: 1, outline: 'none',
                }}
              />
            </div>
            {effectiveVin && (
              <div style={{fontSize: 10, color: checkVinDigit(effectiveVin) ? C.gn : C.wn, fontWeight: 700}}>
                {checkVinDigit(effectiveVin) ? '✓ check digit OK' : '⚠ check digit FAIL'}
              </div>
            )}
          </div>
          {/* Source hint */}
          {!comboVin && masterVinValid && (
            <div style={{fontSize: 10, color: C.ts, marginBottom: 8}}>
              Using Master VIN: <span style={{fontFamily: mono, color: C.tx}}>{masterVin}</span>
            </div>
          )}
          {!comboVin && !masterVinValid && vinConsensus && (
            <div style={{fontSize: 10, color: C.ts, marginBottom: 8}}>
              Using consensus VIN from loaded modules: <span style={{fontFamily: mono, color: C.tx}}>{vinConsensus}</span>
            </div>
          )}
          {/* Modules that will be patched */}
          <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12}}>
            {[
              {label: 'BCM', loaded: !!(bcm && !bcm.parsed.tooSmall), accent: C.sr},
              {label: 'RFHUB', loaded: !!(rfh && !rfh.parsed.tooSmall), accent: C.a2},
              {label: 'PCM', loaded: !!(pcm && !pcm.parsed.tooSmall), accent: C.a4 || C.wn},
            ].map(({label, loaded, accent}) => (
              <span key={label} style={{
                fontFamily: mono, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 5,
                background: loaded ? accent + '22' : C.c2,
                color: loaded ? accent : C.tm,
                border: `1px solid ${loaded ? accent + '55' : C.bd}`,
                opacity: loaded ? 1 : 0.5,
              }}>{label} {loaded ? '✓' : '—'}</span>
            ))}
            {bcmSec16 && <span style={{fontFamily: mono, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 5, background: C.gn + '22', color: C.gn, border: `1px solid ${C.gn}55`}}>SEC16 ✓</span>}
            {!bcmSec16 && bcm && <span style={{fontFamily: mono, fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 5, background: C.wn + '22', color: C.wn, border: `1px solid ${C.wn}55`}}>NO SEC16 ⚠</span>}
          </div>
          {/* Apply button */}
          <button
            onClick={applyComboFix}
            disabled={comboBusy || !effectiveVin}
            data-testid="secsync-combo-apply-btn"
            style={{
              width: '100%', padding: '13px 0', borderRadius: 8, border: 'none',
              cursor: (comboBusy || !effectiveVin) ? 'not-allowed' : 'pointer',
              background: (comboBusy || !effectiveVin) ? C.bd : C.sr,
              color: '#fff', fontFamily: "'Righteous'", fontSize: 15, fontWeight: 800, letterSpacing: 1,
              opacity: (comboBusy || !effectiveVin) ? 0.6 : 1, transition: 'opacity 0.15s',
            }}
          >
            {comboBusy ? '⏳ WRITING ALL MODULES…' : effectiveVin ? `⚡ WRITE VIN ${effectiveVin} + FIX SECURITY → DOWNLOAD ALL` : '⚠ ENTER OR SET A VIN FIRST'}
          </button>
          {/* Results */}
          {comboResult && (
            <div style={{marginTop: 12}}>
              {comboResult.steps.map((s, i) => (
                <div key={i} style={{display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', fontSize: 10}}>
                  <span style={{color: s.ok ? C.gn : C.er, fontWeight: 800, minWidth: 16}}>{s.ok ? '✓' : '✗'}</span>
                  <span style={{fontWeight: 800, color: C.ts, minWidth: 80}}>{s.mod}</span>
                  <span style={{color: s.ok ? C.ts : C.er, flex: 1}}>{s.ok ? s.fname : s.error}</span>
                </div>
              ))}
              <div style={{marginTop: 8, fontSize: 11, fontWeight: 800, color: comboResult.ok ? C.gn : C.wn}}>
                {comboResult.ok ? '✅ All modules patched and downloaded.' : '⚠ Some steps had errors — check above.'}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── Overall GO / NO-GO banner ── */}
      {/* ── RFHUB key type detector banner ── */}
      {rfh && rfh.bytes && (
        <RfhubKeyTypeBanner bytes={rfh.bytes} style={{marginBottom: 16}} />
      )}

      {anyLoaded && (
        <Card style={{marginBottom: 16, borderLeft: "5px solid " + overall.color, background: overall.color + "0C"}} data-testid="secsync-overall">
          <div style={{display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap"}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 26, color: overall.color, letterSpacing: 1}} data-testid="secsync-overall-label">{overall.label}</div>
            <div style={{fontSize: 12, color: C.ts, flex: 1, minWidth: 220}}>{overall.detail}</div>
          </div>
        </Card>
      )}

      {/* ── Side-by-side byte-by-byte comparison ── */}
      <Card style={{marginBottom: 16}} data-testid="secsync-comparison">
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 14}}>
          <div style={{fontWeight: 800, fontSize: 12, color: C.sr, letterSpacing: 2}}>📊 SECURITY BYTES · SIDE BY SIDE</div>
          <div style={{display: "flex", gap: 8, flexWrap: "wrap"}}>
            <span style={{fontSize: 10, fontWeight: 800, color: C.ts}}>RFH ↔ BCM:</span>
            <span data-testid="secsync-verdict-rfh"><StatBadge value={rfhVerdict.label} good={rfhVerdict.good} /></span>
            <span style={{fontSize: 10, fontWeight: 800, color: C.ts}}>PCM ↔ BCM:</span>
            <span data-testid="secsync-verdict-sec6"><StatBadge value={sec6Verdict.label} good={sec6Verdict.good} /></span>
          </div>
        </div>

        {!anyLoaded ? (
          <div style={{fontSize: 12, color: C.tm, fontStyle: "italic", padding: "16px 0", textAlign: "center"}}>
            Load at least a BCM (the canonical source) to compare. RFHUB and PCM are checked against it.
          </div>
        ) : (
          <>
            <div style={{marginBottom: 10, fontSize: 10, color: C.tm}}>
              Green = byte matches what it should be for a paired set · Red = out of sync. The BCM is the canonical source; everything is compared against it.
            </div>

            <div style={{display: "grid", gridTemplateColumns: "1fr", gap: 0}}>
              <ByteRow label="BCM SEC16 (canonical)" sub={bcmRes ? (bcmSec16 ? "source: " + (bcmRes.source || "—") : "blank / virgin") : "no BCM"} bytes={bcmSec16} accent={C.sr} testid="secsync-row-bcm" />
              <ByteRow label="↳ reverse(BCM) → expected RFHUB SEC16" bytes={expectedRfh} accent={C.tm} testid="secsync-row-expected-rfh" />
              <ByteRow label="RFHUB SEC16 (actual)" sub={rfh && rfh.parsed.format ? rfh.parsed.format : null} bytes={rfhSec16} expected={expectedRfh} accent={C.a2} testid="secsync-row-rfh" />

              <div style={{height: 1, background: C.bd, margin: "10px 0"}} />

              <ByteRow label="↳ reverse(BCM)[0:6] → expected PCM SEC6" bytes={expectedSec6} accent={C.tm} testid="secsync-row-expected-sec6" />
              <ByteRow
                label="PCM SEC6 (actual @ 0x3C8)"
                sub={pcmSec6Info ? (pcmSec6Info.markerOk ? "IMMO marker FF FF FF AA OK" : "⚠ IMMO marker @0x3C4 NOT set") : null}
                bytes={pcmSec6Info ? pcmSec6Info.raw : null}
                expected={expectedSec6}
                accent={C.a4 || C.wn}
                testid="secsync-row-sec6"
              />
            </div>

            <div style={{marginTop: 14, padding: "10px 12px", borderRadius: 8, background: C.c2, border: "1px solid " + C.bd}}>
              <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 6}}>SHOW IT ALL · RAW HEX</div>
              {[
                ["BCM SEC16", bcmSec16],
                ["reverse(BCM SEC16)", expectedRfh],
                ["RFHUB SEC16", rfhSec16],
                ["RFHUB SEC16 slot2", rfh && rfh.parsed.sec16 ? rfh.parsed.sec16.slot2 : null],
                ["PCM SEC6", pcmSec6Info ? pcmSec6Info.raw : null],
                ["expected SEC6 = reverse(BCM)[0:6]", expectedSec6],
              ].map(([k, v], i) => (
                <div key={i} style={{display: "flex", gap: 8, fontSize: 10, padding: "2px 0"}}>
                  <span style={{color: C.tm, minWidth: 240}}>{k}</span>
                  <span style={{fontFamily: mono, color: v ? C.tx : C.tm}}>{bytesHex(v)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* ── RFHUB SEC16 one-click fix (writes reverse(BCM SEC16) to RFHUB) ── */}
      {(() => {
        const rfhReady = rfh && !rfh.parsed.tooSmall;
        const rfhInSync = rfhReady && rfhVerdict.good;
        const canFix = rfhReady && bcmSec16 && !rfhInSync;
        const [rfhFixBusy, setRfhFixBusy] = useState(false);
        const [rfhFixResult, setRfhFixResult] = useState(null);

        const doRfhFix = () => {
          if (!canFix) return;
          // Pre-repair validation gate
          if (bcmSourceWarn) {
            setErr(`⛔ RFHUB FIX BLOCKED: BCM SEC16 source is "${bcmRes?.source}" (${bcmSec16?.length} bytes). Need a full 16-byte source (split or mirror2) for safe repair.`);
            return;
          }
          setRfhFixBusy(true);
          setRfhFixResult(null);
          try {
            let result;
            if (isXc2268Rfhub(rfh.bytes)) {
              result = writeXc2268Sec16(rfh.bytes, bcmSec16);
            } else if (rfh.parsed.format === 'gen1') {
              result = writeRfhSec16Gen1(rfh.bytes, bcmSec16);
            } else if (rfh.parsed.format === 'gen2-hybrid') {
              // gen2-hybrid: 4 KB file with empty Gen2 slots and no AA-55-31-01 banner.
              result = writeRfhSec16Gen2Slots(rfh.bytes, bcmSec16);
            } else {
              result = writeRfhSec16FromBcm(rfh.bytes, bcmSec16);
            }
            // Download the repaired file
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fname = `RFHUB_SEC16_FIXED_${ts}.bin`;
            const blob = new Blob([result.bytes], {type: 'application/octet-stream'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            trackDownload(ASSET_IDS.securityKeySync);
            // Reload the RFHUB slot with the patched bytes so the comparison updates
            setRfh({file: {name: fname}, bytes: result.bytes, parsed: engParseRfh(result.bytes, fname)});
            setRfhFixResult({ok: true, patched: result.patched, hex: result.rfhSec16Hex, fname});
          } catch (e) {
            setRfhFixResult({ok: false, error: e.message});
          } finally {
            setRfhFixBusy(false);
          }
        };

        const rfhType = rfhReady
          ? isXc2268Rfhub(rfh.bytes) ? 'XC2268' : rfh.parsed.format === 'gen1' ? 'Gen1' : 'Gen2'
          : null;

        return (
          <>
            <Card style={{marginBottom: 16, borderLeft: "3px solid " + (rfhInSync ? C.gn : C.a2)}}>
              <div style={{fontWeight: 800, fontSize: 12, color: rfhInSync ? C.gn : C.a2, letterSpacing: 2, marginBottom: 4}}>🛠️ RFHUB SEC16 FIX</div>
              {rfhInSync ? (
                <div style={{fontSize: 11, color: C.ts}} data-testid="secsync-rfh-already-paired">
                  <strong style={{color: C.gn}}>RFHUB already paired — no fix needed.</strong>{" "}
                  The loaded RFHUB SEC16 already matches reverse(BCM SEC16). Nothing here needs repairing.
                </div>
              ) : !rfhReady ? (
                <div style={{fontSize: 11, color: C.tm}}>
                  Load an RFHUB dump above to enable the SEC16 repair.
                </div>
              ) : !bcmSec16 ? (
                <div style={{fontSize: 11, color: C.tm}}>
                  Load a BCM with a populated SEC16 to derive the correct RFHUB secret.
                </div>
              ) : (
                <div style={{fontSize: 10, color: C.tm, marginBottom: 10}}>
                  One-click SEC16 repair for the loaded RFHUB ({rfhType}): writes <span style={{fontFamily: mono}}>reverse(BCM SEC16)</span> into
                  the RFHUB SEC16 slots and downloads the repaired file. The BCM is the canonical source.
                </div>
              )}
              {canFix && (
                <div style={{marginTop: 8}}>
                  <Btn
                    color={C.a2}
                    full
                    onClick={doRfhFix}
                    disabled={rfhFixBusy}
                    data-testid="secsync-rfh-fix-btn"
                  >
                    {rfhFixBusy ? '⏳ WRITING…' : `⚡ FIX RFHUB SEC16 (${rfhType}) — WRITE reverse(BCM) & DOWNLOAD`}
                  </Btn>
                </div>
              )}
              {rfhFixResult && (
                <div style={{marginTop: 10, padding: "8px 12px", borderRadius: 8, background: rfhFixResult.ok ? C.gn + "12" : C.er + "12", border: "1px solid " + (rfhFixResult.ok ? C.gn + "44" : C.er + "44")}}>
                  {rfhFixResult.ok ? (
                    <div style={{fontSize: 11, color: C.gn, fontWeight: 700}} data-testid="secsync-rfh-fix-ok">
                      ✓ RFHUB SEC16 repaired — {rfhFixResult.patched} slot(s) written.<br/>
                      <span style={{fontFamily: mono, fontSize: 10, color: C.ts}}>New SEC16: {rfhFixResult.hex.toUpperCase()}</span><br/>
                      <span style={{fontSize: 10, color: C.ts}}>Downloaded: {rfhFixResult.fname}</span>
                    </div>
                  ) : (
                    <div style={{fontSize: 11, color: C.er, fontWeight: 700}} data-testid="secsync-rfh-fix-err">
                      ✗ RFHUB SEC16 fix failed: {rfhFixResult.error}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </>
        );
      })()}

      {/* ── ECM / GPEC2A one-click immo fix (delegates to verified writer) ──
       * When the PCM SEC6 already matches the BCM and the IMMO marker is set,
       * the loaded PCM is paired — there is nothing to repair. We surface that
       * clearly and keep the full immo-fix workbench collapsed behind an
       * explicit opt-in so a paired PCM never *looks* like it needs fixing. */}
      {(() => {
        const pcmReady = pcm && !pcm.parsed.tooSmall;
        const pcmInSync = pcmReady && sec6Verdict.good;
        return (
          <>
            <Card style={{marginBottom: 16, borderLeft: "3px solid " + (pcmInSync ? C.gn : (C.a4 || C.wn))}}>
              <div style={{fontWeight: 800, fontSize: 12, color: pcmInSync ? C.gn : (C.a4 || C.wn), letterSpacing: 2, marginBottom: 4}}>🛠️ ECM / GPEC2A IMMO FIX</div>
              {pcmInSync ? (
                <div style={{fontSize: 11, color: C.ts}} data-testid="secsync-pcm-already-paired">
                  <strong style={{color: C.gn}}>PCM already paired — no fix needed.</strong>{" "}
                  The loaded PCM's SEC6 already matches the BCM and the IMMO marker is set. Nothing here needs repairing.
                </div>
              ) : (
                <div style={{fontSize: 10, color: C.tm}}>
                  One-click immo repair for the loaded PCM: stamps the GPEC2A marker and writes the SEC6 secret derived from the BCM / RFHUB donor above. Refuses on doubt.
                </div>
              )}
              {pcmInSync && (
                <div style={{marginTop: 10}}>
                  <Btn color={C.tm} outline onClick={() => setShowFixAnyway((v) => !v)} data-testid="secsync-show-fix-anyway">
                    {showFixAnyway ? "Hide manual immo tools" : "Show manual immo tools anyway"}
                  </Btn>
                </div>
              )}
            </Card>
            {pcmReady ? (
              (!pcmInSync || showFixAnyway) ? (
                <Gpec2aImmoPanel mod={{data: pcm.bytes, filename: pcm.file.name}} donorMods={donorMods} onPatched={(bytes, fname) => loadPcm({name: fname}, bytes)} />
              ) : null
            ) : (
              <Card style={{marginBottom: 16}}>
                <div style={{fontSize: 12, color: C.tm, fontStyle: "italic", textAlign: "center", padding: "8px 0"}}>
                  Load a PCM (GPEC2A) dump above to enable the immo analyzer and one-click fix.
                </div>
              </Card>
            )}
          </>
        );
      })()}
    </div>
  );
}
