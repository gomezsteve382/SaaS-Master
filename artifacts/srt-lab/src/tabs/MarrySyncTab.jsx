import React, {useState, useMemo, useRef} from "react";
import {zipSync} from "fflate";
import {Card, Btn, Tag} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {parseModule} from "../lib/parseModule.js";
import {marryModule, marryAll} from "../lib/marryModule.js";

/* ────────────────────────────────────────────────────────────────────────────
 * MarrySyncTab — the engine-backed home for marrying modules into a set.
 * Two modes, both on the verified marryModule() engine (derive → write →
 * re-parse-verify, refuse-on-doubt, trust-ledger confidence):
 *   • Marry one   — SOURCE (married) → TARGET (unmarried), single output.
 *   • Marry all 3 — BCM (source of truth) → RFHUB + PCM, both derived from the
 *                   same BCM root so they are guaranteed in sync, cross-checked,
 *                   downloaded together as a .zip.
 * Relationships (immoSecret.js): RFH SEC16 = reverse(BCM), PCM SEC6 = reverse(BCM)[0:6].
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
    <Card style={{borderTop: "3px solid " + accent, padding: 14}}>
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8}}>
        <div style={{fontFamily: "'Righteous'", fontSize: 13, color: accent, letterSpacing: 1}}>{label}</div>
        {mod && <button onClick={onClear} style={{border: "none", background: C.er + "14", color: C.er, fontWeight: 800, fontSize: 10, padding: "3px 9px", borderRadius: 6, cursor: "pointer"}}>CLEAR</button>}
      </div>
      {mod ? (
        <div style={{fontSize: 12}}>
          <div><b>{mod.info?.type || "?"}</b> · {mod.file?.name}</div>
          <div style={{color: C.tm, fontSize: 11, fontFamily: mono}}>{mod.bytes.length} B{mod.info?.vins?.length ? ` · VIN ${mod.info.vins[0].vin}` : ""}</div>
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

function ConfidenceBadge({grounding}) {
  const tone = grounding ? (TONE[grounding.level] || TONE.unverified) : null;
  if (!tone) return null;
  return <span title={grounding.caveat || ""} style={{fontSize: 10, fontWeight: 800, letterSpacing: 0.5, padding: "2px 8px", borderRadius: 10, background: tone.c + "18", color: tone.c}}>{tone.t}</span>;
}

function ChecksList({checks}) {
  return (checks || []).map((ch, i) => (
    <div key={i} style={{fontSize: 12, color: ch.pass ? C.gn : C.er, marginBottom: 3, fontFamily: mono}}>
      {ch.pass ? "✓" : "✗"} {ch.label}{ch.detail ? ` — ${ch.detail}` : ""}
    </div>
  ));
}

function useModule(setAck) {
  const [mod, setMod] = useState(null);
  const load = (file, bytes) => {
    let info = null;
    try { info = parseModule(bytes, file.name); } catch (e) { /* engine reports */ }
    setMod({file, bytes, info});
    if (setAck) setAck(false);
  };
  return [mod, load, () => setMod(null)];
}

export default function MarrySyncTab() {
  const [mode, setMode] = useState("one");
  const [vin, setVin] = useState("");
  const [ack, setAck] = useState(false);

  // mode "one"
  const [src, loadSrc, clearSrc] = useModule(setAck);
  const [tgt, loadTgt, clearTgt] = useModule(setAck);
  // mode "all3"
  const [bcm, loadBcm, clearBcm] = useModule(setAck);
  const [rfh, loadRfh, clearRfh] = useModule(setAck);
  const [pcm, loadPcm, clearPcm] = useModule(setAck);

  const one = useMemo(() => {
    if (mode !== "one" || !src || !tgt) return null;
    try { return marryModule({source: {bytes: src.bytes, info: src.info}, target: {bytes: tgt.bytes, info: tgt.info}, vin: vin.trim() || undefined, allowUnverifiedTarget: ack}); }
    catch (e) { return {ok: false, reason: String(e?.message || e), checks: []}; }
  }, [mode, src, tgt, vin, ack]);

  const all3 = useMemo(() => {
    if (mode !== "all3" || !bcm || (!rfh && !pcm)) return null;
    try {
      return marryAll({
        bcm: {bytes: bcm.bytes, info: bcm.info},
        rfhub: rfh ? {bytes: rfh.bytes, info: rfh.info} : undefined,
        pcm: pcm ? {bytes: pcm.bytes, info: pcm.info} : undefined,
        vin: vin.trim() || undefined, allowUnverifiedTarget: ack,
      });
    } catch (e) { return {ok: false, results: {}, checks: [{label: "engine error", pass: false, detail: String(e?.message || e)}], files: []}; }
  }, [mode, bcm, rfh, pcm, vin, ack]);

  const dlBin = (bytes, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"}));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };
  const dlZip = () => {
    if (!all3?.files?.length) return;
    const entries = {};
    for (const f of all3.files) entries[f.name] = f.bytes;
    const zipped = zipSync(entries, {level: 6});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zipped], {type: "application/zip"}));
    a.download = `MARRIED_ALL${vin.trim() ? "_" + vin.trim() : ""}.zip`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const needsAckOne = !!one && !one.ok && /allowUnverifiedTarget/i.test(one.reason || "");
  const needsAckAll = !!all3 && Object.values(all3.results || {}).some((r) => r && !r.ok && /allowUnverifiedTarget/i.test(r.reason || ""));
  const needsAck = needsAckOne || needsAckAll;

  const tab = (id, label) => (
    <button onClick={() => setMode(id)} style={{
      padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontWeight: 800, fontSize: 12,
      border: `1.5px solid ${mode === id ? C.sr : C.bd}`, background: mode === id ? C.sr + "12" : C.c2, color: mode === id ? C.sr : C.tx,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{fontFamily: "'Righteous'", fontSize: 20, letterSpacing: 1, marginBottom: 6}}>MARRY / SYNC</div>
      <div style={{color: C.ts, fontSize: 12, marginBottom: 12, maxWidth: 780}}>
        Derive a module's immobilizer secret from a married source, write it with the verified writer, and confirm
        by re-parse. BCM is the source of truth. Refuse-on-doubt: nothing downloads unless it verifies.
      </div>

      <div style={{display: "flex", gap: 8, marginBottom: 14}}>
        {tab("one", "Marry one (source → target)")}
        {tab("all3", "Marry all 3 (BCM + RFHUB + PCM)")}
      </div>

      {mode === "one" && (
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12}}>
          <FileSlot label="SOURCE · married" accent={C.sr} mod={src} onLoad={loadSrc} onClear={clearSrc} />
          <FileSlot label="TARGET · unmarried" accent={C.a1} mod={tgt} onLoad={loadTgt} onClear={clearTgt} />
        </div>
      )}
      {mode === "all3" && (
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12}}>
          <FileSlot label="BCM · source of truth" accent={C.sr} mod={bcm} onLoad={loadBcm} onClear={clearBcm} />
          <FileSlot label="RFHUB · target" accent={C.a3} mod={rfh} onLoad={loadRfh} onClear={clearRfh} />
          <FileSlot label="PCM · target" accent={C.a2} mod={pcm} onLoad={loadPcm} onClear={clearPcm} />
        </div>
      )}

      <div style={{marginBottom: 14}}>
        <label style={{fontSize: 11, color: C.tm, marginRight: 8}}>Optional VIN to stamp into target(s)</label>
        <input value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} maxLength={17} placeholder="17-char VIN"
          style={{fontFamily: mono, fontSize: 12, padding: "6px 8px", border: `1px solid ${C.bd}`, borderRadius: 6, width: 210}} />
      </div>

      {needsAck && (
        <Card style={{padding: 12, marginBottom: 12, borderLeft: `3px solid ${C.er}`}}>
          <label style={{fontSize: 12, color: C.er, fontWeight: 600}}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{marginRight: 6}} />
            A target's writer formula is UNVERIFIED (RFHUB Gen1 / XC2268) and could brick the module — proceed anyway.
          </label>
        </Card>
      )}

      {/* ── mode: one ── */}
      {mode === "one" && !one && <Card style={{padding: 16, color: C.tm}}>Load a source and a target module to begin.</Card>}
      {mode === "one" && one && (
        <Card style={{padding: 16}}>
          <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap"}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15}}>{one.sourceType || "?"} → {one.targetType || "?"}</div>
            {one.op && <Tag>{one.op}</Tag>}
            <ConfidenceBadge grounding={one.grounding} />
            {one.ok && one.verified && <Tag>✓ VERIFIED</Tag>}
          </div>
          <ChecksList checks={one.checks} />
          {one.reason && <div style={{marginTop: 8, color: C.er, fontSize: 12, fontWeight: 700}}>{one.reason}</div>}
          {one.ok && one.verified && (
            <div style={{marginTop: 12}}><Btn onClick={() => dlBin(one.bytes, `${one.targetType || "TARGET"}_MARRIED${vin.trim() ? "_" + vin.trim() : ""}.bin`)}>⬇ Download verified {one.targetType}</Btn></div>
          )}
        </Card>
      )}

      {/* ── mode: all3 ── */}
      {mode === "all3" && !all3 && <Card style={{padding: 16, color: C.tm}}>Load the BCM (source of truth) and at least one of RFHUB / PCM.</Card>}
      {mode === "all3" && all3 && (
        <Card style={{padding: 16}}>
          <div style={{display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap"}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15}}>BCM → {all3.results.rfhub ? "RFHUB" : ""}{all3.results.rfhub && all3.results.pcm ? " + " : ""}{all3.results.pcm ? "PCM" : ""}</div>
            {all3.ok && all3.crossSync && <Tag>✓ ALL IN SYNC</Tag>}
          </div>
          {["rfhub", "pcm"].map((k) => {
            const r = all3.results[k];
            if (!r) return null;
            return (
              <div key={k} style={{marginBottom: 10, paddingLeft: 8, borderLeft: `2px solid ${C.bd}`}}>
                <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 3}}>
                  <b style={{fontSize: 12, textTransform: "uppercase"}}>{k}</b>
                  {r.op && <Tag>{r.op}</Tag>}
                  <ConfidenceBadge grounding={r.grounding} />
                  {r.ok && r.verified && <span style={{color: C.gn, fontSize: 11, fontWeight: 800}}>✓ verified</span>}
                  {!r.ok && <span style={{color: C.er, fontSize: 11, fontWeight: 800}}>✗ {r.reason || "failed"}</span>}
                </div>
              </div>
            );
          })}
          <ChecksList checks={all3.checks} />
          {all3.ok && (
            <div style={{marginTop: 12}}><Btn onClick={dlZip}>⬇ Download all {all3.files.length} married files (.zip)</Btn></div>
          )}
        </Card>
      )}
    </div>
  );
}
