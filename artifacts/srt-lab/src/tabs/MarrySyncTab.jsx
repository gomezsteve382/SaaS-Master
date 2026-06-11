import React, {useState, useMemo, useRef} from "react";
import {Card, Btn, Tag} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {parseModule} from "../lib/parseModule.js";
import {marryModule} from "../lib/marryModule.js";

/* ────────────────────────────────────────────────────────────────────────────
 * MarrySyncTab — the single, engine-backed home for marrying an unmarried
 * module into a married set. Replaces the overlapping SecuritySyncTab /
 * BCM→PCM pairing surfaces: load a SOURCE (a module that already carries the
 * married secret — your BCM source of truth, or an RFHUB/95640) and a TARGET
 * (the donor/unmarried module). One call to marryModule() derives the target's
 * secret, writes it with the verified securityBytes writer, and re-parses the
 * output to prove it reads back correctly before anything can be downloaded.
 *
 * The relationships (single source of truth, immoSecret.js):
 *   RFHUB SEC16 == reverse(BCM SEC16) ; PCM SEC6 == reverse(BCM SEC16)[0:6].
 * Refuse-on-doubt: a blank/virgin source is rejected, and writing an
 * UNVERIFIED-formula target (RFHUB Gen1 / XC2268) requires an explicit ack.
 * ────────────────────────────────────────────────────────────────────────── */

const mono = "'JetBrains Mono'";
const TONE = {
  "bench-verified":     {c: C.gn, t: "BENCH-VERIFIED"},
  "grounded-extracted": {c: C.wn, t: "EXTRACTED · UNCONFIRMED"},
  "unverified":         {c: C.er, t: "UNVERIFIED"},
};

function FileSlot({label, accent, mod, onLoad, onClear}) {
  const inputRef = useRef(null);
  const onChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { onLoad(f, new Uint8Array(r.result)); if (inputRef.current) inputRef.current.value = ""; };
    r.readAsArrayBuffer(f);
  };
  return (
    <Card style={{borderTop: "3px solid " + accent, padding: 16}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8}}>
        <div style={{fontFamily: "'Righteous'", fontSize: 14, color: accent, letterSpacing: 1}}>{label}</div>
        {mod && (
          <button onClick={onClear} style={{border: "none", background: C.er + "14", color: C.er, fontWeight: 800, fontSize: 10, padding: "3px 9px", borderRadius: 6, cursor: "pointer"}}>CLEAR</button>
        )}
      </div>
      {mod ? (
        <div style={{fontSize: 12}}>
          <div><b>{mod.info?.type || "?"}</b> · {mod.file?.name}</div>
          <div style={{color: C.tm, fontSize: 11, fontFamily: mono}}>
            {mod.bytes.length} B{mod.info?.vins?.length ? ` · VIN ${mod.info.vins[0].vin}` : ""}
          </div>
        </div>
      ) : (
        <div>
          <input ref={inputRef} type="file" style={{display: "none"}} onChange={onChange} />
          <Btn onClick={() => inputRef.current && inputRef.current.click()}>Load file…</Btn>
        </div>
      )}
    </Card>
  );
}

export default function MarrySyncTab() {
  const [src, setSrc] = useState(null);
  const [tgt, setTgt] = useState(null);
  const [vin, setVin] = useState("");
  const [ack, setAck] = useState(false);

  const load = (setter) => (file, bytes) => {
    let info = null;
    try { info = parseModule(bytes, file.name); } catch (e) { /* unparseable → engine reports */ }
    setter({file, bytes, info});
    setAck(false);
  };

  const result = useMemo(() => {
    if (!src || !tgt) return null;
    try {
      return marryModule({
        source: {bytes: src.bytes, info: src.info},
        target: {bytes: tgt.bytes, info: tgt.info},
        vin: vin.trim() || undefined,
        allowUnverifiedTarget: ack,
      });
    } catch (e) {
      return {ok: false, reason: String(e?.message || e), checks: []};
    }
  }, [src, tgt, vin, ack]);

  const download = () => {
    if (!result?.bytes) return;
    const fn = `${result.targetType || "TARGET"}_MARRIED${vin.trim() ? "_" + vin.trim() : ""}.bin`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([result.bytes], {type: "application/octet-stream"}));
    a.download = fn; a.click(); URL.revokeObjectURL(a.href);
  };

  const tone = result?.grounding ? (TONE[result.grounding.level] || TONE.unverified) : null;
  const needsAck = !!result && !result.ok && /allowUnverifiedTarget/i.test(result.reason || "");

  return (
    <div>
      <div style={{fontFamily: "'Righteous'", fontSize: 20, letterSpacing: 1, marginBottom: 6}}>MARRY / SYNC</div>
      <div style={{color: C.ts, fontSize: 12, marginBottom: 14, maxWidth: 760}}>
        Derive a target module's immobilizer secret from a married source, write it with the verified
        writer, and confirm by re-parse. BCM is the source of truth — RFH SEC16 = reverse(BCM),
        PCM SEC6 = reverse(BCM)[0:6]. One engine, refuse-on-doubt, nothing downloads unless it verifies.
      </div>

      <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12}}>
        <FileSlot label="SOURCE · married" accent={C.sr} mod={src} onLoad={load(setSrc)} onClear={() => setSrc(null)} />
        <FileSlot label="TARGET · unmarried" accent={C.a1} mod={tgt} onLoad={load(setTgt)} onClear={() => setTgt(null)} />
      </div>

      <div style={{marginBottom: 14}}>
        <label style={{fontSize: 11, color: C.tm, marginRight: 8}}>Optional VIN to stamp into target</label>
        <input
          value={vin}
          onChange={(e) => setVin(e.target.value.toUpperCase())}
          maxLength={17}
          placeholder="17-char VIN"
          style={{fontFamily: mono, fontSize: 12, padding: "6px 8px", border: `1px solid ${C.bd}`, borderRadius: 6, width: 210}}
        />
      </div>

      {!result && (
        <Card style={{padding: 16, color: C.tm}}>Load a source and a target module to begin.</Card>
      )}

      {result && (
        <Card style={{padding: 16}}>
          <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap"}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15}}>{result.sourceType || "?"} → {result.targetType || "?"}</div>
            {result.op && <Tag>{result.op}</Tag>}
            {tone && (
              <span title={result.grounding?.caveat || ""} style={{fontSize: 10, fontWeight: 800, letterSpacing: 0.5, padding: "2px 8px", borderRadius: 10, background: tone.c + "18", color: tone.c}}>
                {tone.t}
              </span>
            )}
            {result.ok && result.verified && <Tag>✓ VERIFIED</Tag>}
          </div>

          {(result.checks || []).map((ch, i) => (
            <div key={i} style={{fontSize: 12, color: ch.pass ? C.gn : C.er, marginBottom: 3, fontFamily: mono}}>
              {ch.pass ? "✓" : "✗"} {ch.label}{ch.detail ? ` — ${ch.detail}` : ""}
            </div>
          ))}

          {result.reason && (
            <div style={{marginTop: 8, color: C.er, fontSize: 12, fontWeight: 700}}>{result.reason}</div>
          )}

          {needsAck && (
            <label style={{display: "block", marginTop: 10, fontSize: 12, color: C.er, fontWeight: 600}}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{marginRight: 6}} />
              I understand this target's writer formula is UNVERIFIED and could brick the module — proceed anyway.
            </label>
          )}

          {result.ok && result.verified && (
            <div style={{marginTop: 12}}>
              <Btn onClick={download}>⬇ Download verified {result.targetType}</Btn>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
