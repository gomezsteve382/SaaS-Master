import React, {useState, useMemo, useCallback, useRef} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {resolveBcmSec16, classifyPcmSec6, corruptFillError, parseModule} from "../lib/parseModule.js";
import {engParseBcm, engParseRfh, engParsePcm} from "./ModuleSync.jsx";
import Gpec2aImmoPanel from "../components/Gpec2aImmoPanel.jsx";
import {StatBadge} from "../components/ImmoChecksumPanel.jsx";

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
    const pm = parseModule(bytes, file.name);
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
          summary={pcm && (
            <div style={{marginTop: 6, fontSize: 10}}>
              {pcm.parsed.tooSmall ? <StatBadge value="TOO SMALL" good={false} />
                : <>
                    <div style={{color: C.ts}}>VIN: <span style={{fontFamily: mono, color: C.tx}}>{pcm.parsed.vin || "—"}</span></div>
                    <div style={{marginTop: 3}}>{pcmSec6 ? <StatBadge value="SEC6 SET" good /> : <StatBadge value={pcmSec6Info ? "SEC6 VIRGIN" : "NO SEC6"} good={false} />}</div>
                  </>}
            </div>
          )}
        />
      </div>

      {/* ── Overall GO / NO-GO banner ── */}
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
