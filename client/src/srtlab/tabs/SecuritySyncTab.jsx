import React, {useState, useMemo, useCallback, useRef} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {resolveBcmSec16, classifyPcmSec6, corruptFillError, parseModule, pcmChipFromSize} from "../lib/parseModule.js";
import {engParseBcm, engParseRfh, engParsePcm} from "./ModuleSync.jsx";
import Gpec2aImmoPanel from "../components/Gpec2aImmoPanel.jsx";
import {StatBadge} from "../components/ImmoChecksumPanel.jsx";
import {writeRfhSec16FromBcm, writeRfhSec16Gen1, writeRfhSec16Gen2Slots, writeXc2268Sec16, writePcmSec6} from "../lib/securityBytes.js";
import {isXc2268Rfhub} from "../lib/xc2268Rfhub.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {RfhubKeyTypeBanner} from "../components/RfhubKeyTypeBanner.jsx";

const mono = "'JetBrains Mono'";

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
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
      {bytes ? (
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
  const [bcm, setBcm] = useState(null);
  const [rfh, setRfh] = useState(null);
  const [pcm, setPcm] = useState(null);
  const [err, setErr] = useState("");
  const [showFixAnyway, setShowFixAnyway] = useState(false);

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
    setBcm({file, bytes, parsed: engParseBcm(bytes, file.name)});
  }, []);
  const loadRfh = useCallback((file, bytes) => {
    const pm = parseModule(bytes, file.name);
    const cf = corruptFillError(pm);
    if (cf) { setErr(cf); return; }
    if (pm.type !== "RFHUB" && pm.type !== "XC2268_RFHUB") { setErr(`Selected file detected as ${pm.type || "UNKNOWN"} — load an RFHUB dump in this slot.`); return; }
    setErr("");
    setRfh({file, bytes, parsed: engParseRfh(bytes, file.name)});
  }, []);
  const loadPcm = useCallback((file, bytes) => {
    // 8 KB files named with 'GPEC' (e.g. FCA_CONTINENTAL_GPEC2A_EXTEEPROM_zo.bin) are
    // GPEC2A EXT EEPROM captures. parseModule.js intentionally blocks the filename
    // override for 8 KB files to protect the keyProgWizard doubled-PCM path, so we
    // must pass forceType:'GPEC2A' here when the filename clearly signals GPEC.
    const nameUpper = (file.name || '').toUpperCase();
    const forceOpts = /GPEC/.test(nameUpper) ? {forceType: 'GPEC2A'} : undefined;
    const pm = parseModule(bytes, file.name, forceOpts);
    const cf = corruptFillError(pm);
    if (cf) { setErr(cf); return; }
    if (pm.type !== "GPEC2A") { setErr(`Selected file detected as ${pm.type || "UNKNOWN"} — load a PCM (GPEC2A) dump in this slot.`); return; }
    setErr("");
    setShowFixAnyway(false);
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
  const [wizardResults, setWizardResults] = useState(null); // {rfh, pcm}

  const rfhNeedsFix = !!(bcmSec16 && rfh && !rfh.parsed.tooSmall && !rfhVerdict.good);
  const pcmNeedsFix = !!(bcmSec16 && pcm && !pcm.parsed.tooSmall && !sec6Verdict.good);
  const wizardCanRun = rfhNeedsFix || pcmNeedsFix;

  const applyAllFixes = useCallback(async () => {
    if (!wizardCanRun || wizardBusy) return;
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
        results.rfh = { ok: true, fname, hex: res.rfhSec16Hex, patched: res.patched };
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
  }, [wizardCanRun, wizardBusy, rfhNeedsFix, pcmNeedsFix, bcmSec16, rfh, pcm, expectedRfh]);

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
          Security-only workbench. Load a <strong>BCM</strong>, <strong>RFHUB</strong> and <strong>PCM (GPEC2A)</strong> dump and see, byte-by-byte, whether their immobiliser
          secrets are paired. Relationship rules (verified): <span style={{fontFamily: mono, color: C.ts}}>RFHUB SEC16 = reverse(BCM SEC16)</span> ·{" "}
          <span style={{fontFamily: mono, color: C.ts}}>PCM SEC6 = reverse(BCM SEC16)[0:6]</span>. No VIN / CRC / patch tools live here.
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
                  {wizardResults.rfh.ok ? `✓ Fixed · ${wizardResults.rfh.patched} slot(s) · ${wizardResults.rfh.fname}` : `✗ ${wizardResults.rfh.error}`}
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
          {wizardCanRun ? (
            <button
              onClick={applyAllFixes}
              disabled={wizardBusy}
              data-testid="secsync-wizard-apply-btn"
              style={{
                width: '100%', padding: '12px 0', borderRadius: 8, border: 'none', cursor: wizardBusy ? 'not-allowed' : 'pointer',
                background: wizardBusy ? C.bd : C.wn, color: '#000', fontFamily: "'Righteous'", fontSize: 15, fontWeight: 800, letterSpacing: 1,
                opacity: wizardBusy ? 0.6 : 1, transition: 'opacity 0.15s',
              }}
            >
              {wizardBusy ? '⏳ APPLYING FIXES…' : `⚡ APPLY ALL FIXES (${[rfhNeedsFix && 'RFHUB', pcmNeedsFix && 'PCM'].filter(Boolean).join(' + ')}) & DOWNLOAD`}
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
                  </>}
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
                  </>
                )}
              </div>
            );
          })()}
        />
      </div>

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
          setRfhFixBusy(true);
          setRfhFixResult(null);
          try {
            let result;
            if (isXc2268Rfhub(rfh.bytes)) {
              result = writeXc2268Sec16(rfh.bytes, bcmSec16);
            } else if (rfh.parsed.format === 'gen1') {
              result = writeRfhSec16Gen1(rfh.bytes, bcmSec16);
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
