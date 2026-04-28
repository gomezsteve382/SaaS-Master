import React, {useState, useCallback, useMemo, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card, Tag, Btn} from "../lib/ui.jsx";
import {parseRFH24C32, parsePCMGPEC, computeCompatibility, applyRfhToPcm} from "../lib/rfhPcmPair.js";
import SamplePicker from "../lib/SamplePicker.jsx";
import ProgrammerSizeHelp from "../components/ProgrammerSizeHelp.jsx";
import {fmtOff, moduleSizeBadge} from "./ModuleSync.jsx";

/* Task #466 — adopt the SINCRO-style `0xHHHH (D)` offset render exported
 * from ModuleSync so RFH/PCM offsets read identically to the rest of the
 * SRT Lab. The previous local `fO` helper only printed the hex form. */

function Badge({ok, label}) {
  return <span style={{display:"inline-block",padding:"2px 8px",borderRadius:6,fontSize:10,fontWeight:800,letterSpacing:.5,background:ok?C.gn+"18":C.er+"18",color:ok?C.gn:C.er}}>{label||(ok?"OK":"FAIL")}</span>;
}

function FileDropZone({label, onFile, fileName, hint}) {
  const inputRef = useRef();
  return (
    <div onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)onFile(f);}}
         onDragOver={e=>e.preventDefault()}
         onClick={()=>inputRef.current.click()}
         style={{border:"2px dashed "+C.sr+"30",borderRadius:10,padding:"14px 16px",cursor:"pointer",textAlign:"center",background:C.c2}}>
      <input ref={inputRef} type="file" accept=".bin,.BIN,.eprom,.EPROM" style={{display:"none"}}
             onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}/>
      <div style={{fontSize:22,marginBottom:4}}>📂</div>
      {fileName
        ? <div style={{fontSize:12,fontWeight:800,color:C.sr}}>{fileName}</div>
        : <div style={{fontSize:12,color:C.ts,fontWeight:700}}>{label}</div>}
      {hint && <div style={{fontSize:10,color:C.tm,marginTop:4}}>{hint}</div>}
    </div>
  );
}

function Row({off, label, value, mono, color}) {
  return <tr style={{borderBottom:"1px solid "+C.bd+"60"}}>
    <td style={{padding:"6px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3,width:70}}>{off||"—"}</td>
    <td style={{padding:"6px 10px",fontSize:11,fontWeight:700,color:C.tm,width:140}}>{label}</td>
    <td style={{padding:"6px 10px",fontFamily:mono?"'JetBrains Mono'":"inherit",fontSize:12,fontWeight:700,color:color||C.tx,wordBreak:"break-all"}}>{value}</td>
  </tr>;
}

function VerdictBadge({verdict}) {
  const colors = {COMPATIBLE: C.gn, WARNING: C.wn, LOCKED: C.er};
  const labels = {COMPATIBLE: "✓ COMPATIBLE", WARNING: "⚠ WARNING", LOCKED: "✗ LOCKED"};
  const c = colors[verdict] || C.tm;
  return <span style={{padding:"6px 14px",borderRadius:10,fontSize:13,fontWeight:900,letterSpacing:1,background:c+"18",color:c,border:"1.5px solid "+c+"55"}}>{labels[verdict]||verdict}</span>;
}

export default function RFHPCMTab() {
  const [rfhFile, setRfhFile] = useState(null);
  const [rfhBuf, setRfhBuf] = useState(null);
  const [rfh, setRfh] = useState(null);
  const [rfhErr, setRfhErr] = useState("");

  const [pcmFile, setPcmFile] = useState(null);
  const [pcmBuf, setPcmBuf] = useState(null);
  const [pcm, setPcm] = useState(null);
  const [pcmErr, setPcmErr] = useState("");

  const [patched, setPatched] = useState(null);
  const [applyLog, setApplyLog] = useState([]);
  const [msg, setMsg] = useState("");
  const [repairImmo, setRepairImmo] = useState(false);

  const [samplePair, setSamplePair] = useState(null);
  const onSamplePairLoaded = useCallback(f => setSamplePair(f?.pair || null), []);

  const handleRfh = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      try {
        const d = new Uint8Array(ev.target.result);
        const parsed = parseRFH24C32(d);
        setRfhFile(f); setRfhBuf(d); setRfh(parsed); setRfhErr("");
        setPatched(null); setApplyLog([]); setMsg("");
      } catch (e) {
        setRfhErr("Parse error: " + e.message);
        setRfh(null); setRfhBuf(null);
      }
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handlePcm = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      try {
        const d = new Uint8Array(ev.target.result);
        const parsed = parsePCMGPEC(d);
        setPcmFile(f); setPcmBuf(d); setPcm(parsed); setPcmErr("");
        setPatched(null); setApplyLog([]); setMsg("");
      } catch (e) {
        setPcmErr("Parse error: " + e.message);
        setPcm(null); setPcmBuf(null);
      }
    };
    r.readAsArrayBuffer(f);
  }, []);

  const compat = useMemo(() => computeCompatibility(rfh, pcm), [rfh, pcm]);

  /* Task #478 — mirror the Module Sync (Task #475) PCM file-size guard
   * inside the OBD flashing wizard (this RFH→PCM tab is the second
   * entry point that loads a PCM .bin and emits a patched image). The
   * shared `moduleSizeBadge('pcm', N)` helper returns the same chip-
   * variant badge (95320 / 95640 / amber 'N B · UNKNOWN CHIP', the
   * unified Task #486 wording) the Module Sync workspace shows; when
   * the loaded PCM isn't 4 KB / 8 KB we surface the same
   * red "Programmer says 'File different size'?" banner here AND block
   * APPLY / DOWNLOAD so a tech can't ship a wrong-sized file that the
   * CGDI / Xprog / Orange5 flasher will reject on the bench. */
  const pcmSizeBadge = useMemo(
    () => (pcmBuf ? moduleSizeBadge('pcm', pcmBuf.length) : null),
    [pcmBuf]
  );
  const pcmSizeNonCanonical = !!(pcmSizeBadge && pcmSizeBadge.canonical === false);

  const doApply = () => {
    if (!compat.canApply || pcmSizeNonCanonical) return;
    const result = applyRfhToPcm(rfh, pcm, pcmBuf, {repairImmo});
    if (!result) { setMsg("Apply failed — invalid inputs"); return; }
    if (result.error) {
      setPatched(null); setApplyLog([]);
      setMsg("✗ " + result.errorMessage);
      return;
    }
    setPatched(result.data);
    setApplyLog(result.log);
    setMsg("✓ Patched in memory — click DOWNLOAD to save");
  };

  const doDownload = () => {
    if (!patched || pcmSizeNonCanonical) return;
    const vin = rfh?.vin?.value || "NOVIN";
    const base = (pcmFile?.name || "pcm.bin").replace(/(\.[^.]+)?$/, "");
    const fn = base + "_RFH-PCM_" + vin + ".bin";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([patched], {type: "application/octet-stream"}));
    a.download = fn; a.click(); URL.revokeObjectURL(a.href);
    setMsg("✓ Downloaded: " + fn);
  };

  return <div>
    <Card glow style={{marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
        <span style={{fontSize:30}}>🔗</span>
        <div>
          <div style={{fontSize:18,fontWeight:900,letterSpacing:1}}>RFH → PCM PAIRING</div>
          <div style={{fontSize:11,color:C.ts,fontWeight:700,letterSpacing:1}}>Herokee-style workflow · derive SEC6 from RFH SEC16 · write to PCM</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div>
          <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:6}}>RFH 24C32 (.bin)</div>
          <FileDropZone label="Drop RFH 24C32 EEPROM (4096 B)" hint={`Gen2 4KB · VIN @ ${fmtOff(0x92)} · SEC16 @ ${fmtOff(0xAE)} / ${fmtOff(0xC0)}`}
                        onFile={handleRfh} fileName={rfhFile?.name}/>
          <SamplePicker kinds={['RFH_EEE']} acceptSizes={[4096]} onFile={handleRfh} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample RFH (paired with PCM below)"/>
          {rfhErr && <div style={{marginTop:6,padding:"6px 10px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:11,fontWeight:700}}>✗ {rfhErr}</div>}
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:900,color:C.a4,letterSpacing:2,marginBottom:6}}>PCM GPEC (.bin / .eprom)</div>
          <FileDropZone label="Drop PCM GPEC2/GPEC2A/GPEC3 dump (4096 B)" hint={`VIN @ ${fmtOff(0x0000)} / ${fmtOff(0x01F0)} / ${fmtOff(0x0224)} / ${fmtOff(0x0CE0)} · SEC6 @ ${fmtOff(0x03C8)}`}
                        onFile={handlePcm} fileName={pcmFile?.name}/>
          <SamplePicker kinds={['GPEC_EXT']} onFile={handlePcm} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample PCM (Mitchell 6.2 pairs with RFH)"/>
          {pcmErr && <div style={{marginTop:6,padding:"6px 10px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:11,fontWeight:700}}>✗ {pcmErr}</div>}
        </div>
      </div>
      {/* Task #478 — Same "Programmer says 'File different size'?" help
          blurb the Module Sync workspace renders below its uploaders.
          Sits directly under the PCM drop zone so a tech who already
          loaded a wrong-sized PCM has the explanation in their sight-
          line without leaving the OBD wizard. Wording centralised in
          <ProgrammerSizeHelp/> (Task #482); the OBD-specific tail
          points at the APPLY/DOWNLOAD gating below. */}
      <ProgrammerSizeHelp
        testId="obdwiz-programmer-size-help"
        variant="accent"
        style={{marginTop:14, padding:"10px 12px"}}
        tail={<>APPLY and DOWNLOAD stay disabled until the loaded file matches a canonical GPEC2A chip size.</>}
      />
    </Card>

    {(rfh || pcm) && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
      {/* RFH PANEL */}
      <Card style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <span style={{fontSize:14,fontWeight:900,color:C.sr}}>RFH (24C32 EEPROM)</span>
          {rfh && <Tag color={rfh.gen === 'gen2' ? C.gn : C.wn}>{rfh.gen.toUpperCase()}</Tag>}
          {rfh && rfh.hw && rfh.hw.hwVersion !== 'unknown' && rfh.hw.hwVersion !== 'gen1' && <Tag color={C.a3}>HW {rfh.hw.hwVersion}</Tag>}
          {rfh && <Tag color={C.tm}>{rfh.size} B</Tag>}
        </div>
        {!rfh && <div style={{fontSize:12,color:C.tm,padding:20,textAlign:"center"}}>Load an RFH file</div>}
        {rfh && <>
          {rfh.sizeWarn && <div style={{padding:"6px 10px",borderRadius:8,background:C.wn+"15",color:C.wn,fontSize:11,fontWeight:700,marginBottom:8}}>⚠ {rfh.sizeWarn}</div>}
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:10}}>
            <tbody>
              <Row off={fmtOff(0x92)} label="VIN"
                   value={<>{rfh.vin?.value || "(invalid)"} {rfh.vin && <Badge ok={rfh.vin.isValid && rfh.vin.csOk} label={rfh.vin.isValid ? (rfh.vin.csOk ? "VIN+CS ✓" : "CS ✗") : "INVALID"}/>}</>}
                   color={rfh.vin?.value ? C.gn : C.er} mono/>
              <Row off={fmtOff(0x808)} label="Part Number" value={rfh.partNumber || "—"} mono color={C.a3}/>
              <Row off={fmtOff(0x812)} label="Serial" value={rfh.serial || "—"} mono color={C.a3}/>
            </tbody>
          </table>

          {/* SEC16 slots */}
          <div style={{fontSize:11,fontWeight:900,color:C.a4,letterSpacing:1.5,marginBottom:6}}>SEC16 SLOTS</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,marginBottom:10}}>
            <thead><tr>{["#","Off","Hex (raw)","BCM-rev","CS stored","CS calc (XOR)","PIN","Status"].map(h=>
              <th key={h} style={{textAlign:"left",padding:"4px 6px",borderBottom:"1.5px solid "+C.bd,fontSize:9,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
            <tbody>
              {[rfh.sec16Slot1, rfh.sec16Slot2].map((s,i)=>(
                <tr key={i} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                  <td style={{padding:"5px 6px",fontWeight:800,color:C.sr}}>S{i+1}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:10,color:C.a3}}>{s.present?fmtOff(s.offset):"—"}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:9,color:s.blank?C.tm:C.tx,wordBreak:"break-all"}}>{s.present?(s.blank?"(blank)":s.hex):"—"}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:9,color:s.blank?C.tm:C.a4,wordBreak:"break-all"}}>{s.present&&!s.blank?s.bcmHex:"—"}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts}}>{s.present?"0x"+s.csStored.toString(16).toUpperCase().padStart(4,"0"):"—"}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:10,color:s.csOk?C.gn:C.er}}>{s.present?("0x"+s.csCalcXor.toString(16).toUpperCase().padStart(2,"0")+" / 0x"+s.csCalcWord.toString(16).toUpperCase().padStart(4,"0")):"—"}</td>
                  <td style={{padding:"5px 6px",fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:C.a1}}>{s.present?s.pinDec:"—"}</td>
                  <td style={{padding:"5px 6px"}}>{s.present?(s.blank?<Tag color={C.tm}>BLANK</Tag>:<Badge ok={!!s.csOk}/>):"—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Check badges */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            <Badge ok={rfh.sec16Match} label={"SEC16 match: "+(rfh.sec16Match?"YES":"NO")}/>
            <Badge ok={rfh.csMatchBoth} label={"CS match: "+(rfh.csMatchBoth?"BOTH OK":"FAIL")}/>
            <Badge ok={rfh.pinMatch} label={"PIN match: "+(rfh.pinMatch?"YES":"NO")}/>
          </div>

          {/* SEC6 derived */}
          <div style={{padding:"10px 12px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
            <div style={{fontSize:10,fontWeight:900,color:C.a2,letterSpacing:1.5,marginBottom:4}}>SEC6 DERIVED (first 6 bytes of valid SEC16)</div>
            {rfh.sec6
              ? <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a2}}>
                  {rfh.sec6.hex} <Tag color={C.gn}>from Slot {rfh.sec6.sourceSlot}</Tag>
                </div>
              : <div style={{fontSize:11,color:C.er,fontWeight:700}}>✗ {rfh.sec6Error}</div>}
          </div>
        </>}
      </Card>

      {/* PCM PANEL */}
      <Card style={{padding:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
          <span style={{fontSize:14,fontWeight:900,color:C.a4}}>PCM (GPEC2/GPEC3)</span>
          {pcm && <Tag color={C.tm}>{pcm.size} B</Tag>}
          {pcm && <Tag color={pcm.writeCheck.ok ? C.gn : C.er}>{pcm.writeCheck.ok ? "writable ✓" : (pcm.writeCheck.canonical===false && pcm.size>=0x3CE ? "non-canonical size" : "too small")}</Tag>}
          {/* Task #478 — chip-variant badge mirroring the Module Sync
              upload zone (`modsync-pcm-size-badge`). Same dataKey /
              canonical attributes so future tooling can grep the badge
              from either entry point. */}
          {pcmSizeBadge && (
            <span data-testid="obdwiz-pcm-size-badge"
                  data-size-key={pcmSizeBadge.dataKey}
                  data-size-canonical={pcmSizeBadge.canonical ? '1' : '0'}
                  style={{
                    fontSize:9, padding:"3px 8px", borderRadius:6, letterSpacing:.6,
                    background:pcmSizeBadge.color, color:'#fff', fontWeight:800,
                  }}>{pcm.size.toLocaleString()} B · {pcmSizeBadge.label}</span>
          )}
        </div>
        {!pcm && <div style={{fontSize:12,color:C.tm,padding:20,textAlign:"center"}}>Load a PCM file</div>}
        {pcm && <>
          {pcm.sizeWarn && <div style={{padding:"6px 10px",borderRadius:8,background:C.wn+"15",color:C.wn,fontSize:11,fontWeight:700,marginBottom:8}}>⚠ {pcm.sizeWarn}</div>}
          {/* Task #478 — red block banner. Mirrors the Module Sync
              guard: when the loaded PCM isn't a canonical GPEC2A chip
              size (4 KB / 8 KB) the bench programmer will refuse the
              image with "File different size". APPLY + DOWNLOAD are
              already wired to refuse the same way; this banner makes
              the refusal visible so the tech doesn't hunt for a greyed-
              out button. */}
          {pcmSizeNonCanonical && (
            <div data-testid="obdwiz-programmer-size-block" style={{
              padding:"10px 12px", borderRadius:10, marginBottom:10,
              background:C.er+"12", border:`1.5px solid ${C.er}66`,
              color:C.er, fontSize:11, fontWeight:700, lineHeight:1.5,
            }}>
              <div style={{fontWeight:900,fontSize:12,letterSpacing:.5,marginBottom:4}}>
                ⛔ Programmer says &quot;File different size&quot;?
              </div>
              <span style={{color:C.tx,fontWeight:600}}>
                Loaded PCM is <strong>{pcm.size.toLocaleString()} B</strong> — not
                a canonical GPEC2A chip (must be exactly 4 KB / 95320 or
                8 KB / 95640). APPLY and DOWNLOAD are blocked until the
                file matches the bench chip. Re-read the EXT EEPROM and
                drop the new dump above.
              </span>
            </div>
          )}
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:10}}>
            <tbody>
              <Row off={fmtOff(0x0000)} label="VIN current" value={pcm.vinCurrent || "(invalid)"} mono color={pcm.vinCurrent?C.gn:C.er}/>
              <Row off={fmtOff(0x01F0)} label="VIN original" value={pcm.vinOriginal || "(invalid)"} mono color={pcm.vinOriginal?C.gn:C.er}/>
              <Row off={fmtOff(0x0012)} label="Part Number" value={pcm.partNumber || "—"} mono color={C.a3}/>
              <Row off={fmtOff(0x001C)} label="Serial" value={pcm.serial || "—"} mono color={C.a3}/>
              <Row off={fmtOff(0x0011)} label="IMMO state"
                   value={<><span style={{fontFamily:"'JetBrains Mono'",marginRight:8}}>{pcm.immo.hex}</span>
                     <Tag color={pcm.immo.state==='ENABLED'?C.gn:pcm.immo.state==='IMMO_DAMAGED'?C.er:C.wn}>{pcm.immo.label}</Tag></>}/>
              <Row off={fmtOff(0x03C8)} label="SEC6 raw"
                   value={pcm.sec6
                     ? <><span style={{fontFamily:"'JetBrains Mono'"}}>{pcm.sec6.hex}</span>
                         {pcm.sec6.damaged && <Tag color={C.er}>DAMAGED</Tag>}
                         {pcm.sec6.blank && !pcm.sec6.damaged && <Tag color={C.wn}>BLANK</Tag>}</>
                     : "—"} color={pcm.sec6?.damaged?C.er:C.a4}/>
            </tbody>
          </table>
          <div style={{padding:"8px 12px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd,fontSize:11,color:C.ts}}>
            <b>Write-check:</b> canonical GPEC2A 4096 / 8192 B · buf {pcm.writeCheck.buf} bytes · {pcm.writeCheck.ok ? <span style={{color:C.gn}}>OK ✓</span> : <span style={{color:C.er}}>{pcm.writeCheck.reason || 'not writable'}</span>}
          </div>
        </>}
      </Card>
    </div>}

    {/* COMPATIBILITY STATUS */}
    {rfh && pcm && <Card style={{marginBottom:14,padding:18}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
        <span style={{fontSize:13,fontWeight:900,letterSpacing:1.5}}>COMPATIBILITY</span>
        <VerdictBadge verdict={compat.verdict}/>
        <span style={{fontSize:11,color:C.ts,fontWeight:700}}>{compat.reason}</span>
      </div>

      {compat.issues.length > 0 && <div style={{marginBottom:8}}>
        {compat.issues.map((m,i)=><div key={i} style={{fontSize:12,color:C.er,padding:"3px 0"}}>✗ {m}</div>)}
      </div>}
      {compat.info.length > 0 && <div style={{marginBottom:10}}>
        {compat.info.map((m,i)=><div key={i} style={{fontSize:12,color:C.ts,padding:"3px 0"}}>ℹ {m}</div>)}
      </div>}

      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:12}}>
        <thead><tr>{["Comparison","Value"].map(h=>
          <th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
        <tbody>
          <Row label="VIN equal before" value={<Badge ok={compat.vinEqualBefore} label={compat.vinEqualBefore?"YES":"NO"}/>}/>
          <Row label="SEC6 equal before" value={<Badge ok={compat.sec6EqualBefore} label={compat.sec6EqualBefore?"YES":"NO"}/>}/>
          <Row label="SEC6 RFH→PCM" value={compat.sec6FromRfh || "—"} mono color={C.a2}/>
          <Row label="SEC6 PCM current" value={compat.sec6PcmCurrent || "—"} mono color={C.a4}/>
        </tbody>
      </table>

      <div style={{padding:"10px 12px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd,marginBottom:10}}>
        <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer"}}>
          <input type="checkbox" checked={repairImmo} onChange={e=>setRepairImmo(e.target.checked)}
                 style={{marginTop:3,width:16,height:16,accentColor:C.a2,cursor:"pointer"}}/>
          <div>
            <div style={{fontSize:12,fontWeight:900,color:repairImmo?C.a2:C.tx,letterSpacing:.5}}>
              Repair PCM IMMO byte @ {fmtOff(0x0011)} → ENABLED (80 00 00 00)
            </div>
            <div style={{fontSize:10,color:C.tm,fontWeight:600,marginTop:2,lineHeight:1.4}}>
              Only writes when the PCM IMMO state is IMMO_DAMAGED (all-FF). Other states (ENABLED/DISABLED/UNKNOWN) are left untouched.
              {pcm?.immo && <> Current state: <span style={{color:pcm.immo.state==='IMMO_DAMAGED'?C.er:pcm.immo.state==='ENABLED'?C.gn:C.wn,fontWeight:800}}>{pcm.immo.label}</span></>}
            </div>
          </div>
        </label>
      </div>

      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        <Btn onClick={doApply} disabled={!compat.canApply || pcmSizeNonCanonical} color={C.a2}>⚡ APPLY — Patch PCM in memory</Btn>
        <Btn onClick={doDownload} disabled={!patched || pcmSizeNonCanonical} color={C.sr}>💾 DOWNLOAD patched PCM</Btn>
      </div>

      {applyLog.length > 0 && <div style={{marginTop:12,padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
        <div style={{fontSize:10,fontWeight:900,color:C.a2,letterSpacing:1.5,marginBottom:6}}>APPLY LOG</div>
        {applyLog.map((m,i)=><div key={i} style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.ts,padding:"2px 0"}}>• {m}</div>)}
      </div>}

      {msg && <div style={{marginTop:10,padding:"8px 12px",borderRadius:8,background:msg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(msg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:msg.startsWith("✓")?C.gn:C.er}}>{msg}</div>}
    </Card>}
  </div>;
}
