import React, {useState, useCallback, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card, Tag, Btn} from "../lib/ui.jsx";
import {crc8rf} from "../lib/crc.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {DownloadCounter} from "../lib/useDownloadCount.jsx";
import {buildOnePagerPDF} from "../lib/buildOnePagerPDF.js";
import {IMMO_VIN_REF} from "../lib/tabReferences.js";
import {Tip} from "../lib/plainEnglish.jsx";

const fO = n => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const hxb = arr => Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2,"0")).join(" ");
const dl = (data, name, assetId) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], {type:"application/octet-stream"}));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
  if (assetId) trackDownload(assetId);
};

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function Badge({ok, label}) {
  return <span style={{display:"inline-block",padding:"2px 8px",borderRadius:6,fontSize:10,fontWeight:800,letterSpacing:.5,background:ok?C.gn+"18":C.er+"18",color:ok?C.gn:C.er}}>{label||(ok?"OK":"FAIL")}</span>;
}

function SectionHeader({icon, title, subtitle}) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
      <div style={{width:40,height:40,borderRadius:10,background:"linear-gradient(135deg,#D32F2F22,#D32F2F44)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,border:"1.5px solid #D32F2F33"}}>{icon}</div>
      <div>
        <div style={{fontSize:15,fontWeight:900,color:C.tx}}>{title}</div>
        <div style={{fontSize:10,color:C.ts}}>{subtitle}</div>
      </div>
    </div>
  );
}

function FileDropZone({label, onFile, fileName}) {
  const inputRef = useRef();
  return (
    <div onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)onFile(f);}} onDragOver={e=>e.preventDefault()} onClick={()=>inputRef.current.click()} style={{border:"2px dashed "+C.sr+"30",borderRadius:10,padding:"14px 16px",cursor:"pointer",textAlign:"center",background:C.c2}}>
      <input ref={inputRef} type="file" accept=".bin,.BIN" style={{display:"none"}} onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}/>
      <div style={{fontSize:22,marginBottom:4}}>📂</div>
      {fileName ? <div style={{fontSize:12,fontWeight:800,color:C.sr}}>{fileName}</div>
                : <div style={{fontSize:12,color:C.ts}}>{label}</div>}
    </div>
  );
}

/* ─── RFHUB EEE (24C32) helpers ──────────────────────────────────────── */

const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];

function decodeRfhVin(data, off) {
  if (off + 17 > data.length) return null;
  const rev = new Uint8Array(17);
  for (let i = 0; i < 17; i++) rev[i] = data[off + 16 - i];
  let s = "";
  for (let i = 0; i < 17; i++) {
    const ch = String.fromCharCode(rev[i]);
    if (!/[A-HJ-NPR-Z0-9 ]/.test(ch) && rev[i] < 0x20) return null;
    s += ch;
  }
  const vin = s.trim();
  return VIN_RE.test(vin) ? vin : null;
}

function parseRfhub(data) {
  const sz = data.length;
  const validSz = sz === 4096 || sz === 2048;
  const slots = RFH_VIN_OFFSETS.map((off, idx) => {
    if (off + 18 > sz) return {idx:idx+1, offset:off, vin:null, csStored:null, csCalc:null, crcOk:false};
    const rawStored = data.slice(off, off+17);
    const vin = decodeRfhVin(data, off);
    const csStored = data[off + 17];
    const csCalc = crc8rf(rawStored);
    return {idx:idx+1, offset:off, vin, csStored, csCalc, crcOk: csStored === csCalc};
  });

  const sec16s = [[1, 0x00AE, 0x00BE], [2, 0x00C0, 0x00D0]].map(([slot, off, csOff]) => {
    if (csOff + 2 > sz) return {slot, offset:off, hex:"", blank:true, csStored:null, csCalc:null, csOk:false};
    const raw = data.slice(off, off+16);
    const blank = Array.from(raw).every(b => b === 0xFF || b === 0x00);
    const hex = hxb(raw).replace(/ /g,"");
    let xr = 0; for (let i = 0; i < 16; i++) xr ^= raw[i];
    const csCalc = (xr << 8) | xr;
    const csStored = (data[csOff] << 8) | data[csOff+1];
    return {slot, offset:off, raw:Array.from(raw), hex, blank, csStored, csCalc, csOk: csStored === csCalc};
  });
  const sec16valid = sec16s.length === 2 && !sec16s[0].blank &&
    sec16s[0].hex === sec16s[1].hex;

  const skey = data.length >= 0x50 ? data.slice(0x40, 0x50) : null;
  const skeyBlank = skey ? Array.from(skey).every(b => b === 0xFF) : true;

  return {sz, validSz, slots, sec16s, sec16valid, skey, skeyBlank};
}

function applyRfhub(data, newVin) {
  const out = new Uint8Array(data);
  const enc = new TextEncoder().encode(newVin.toUpperCase());
  const rev = new Uint8Array(17);
  for (let i = 0; i < 17; i++) rev[i] = enc[16 - i];
  const cs = crc8rf(rev);
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let i = 0; i < 17; i++) out[off + i] = rev[i];
    out[off + 17] = cs;
  }
  return out;
}

function RFHSection() {
  const [iFile, setIFile] = useState(null);
  const [iData, setIData] = useState(null);
  const [iResult, setIResult] = useState(null);
  const [iErr, setIErr] = useState("");
  const [aFile, setAFile] = useState(null);
  const [aData, setAData] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [aMsg, setAMsg] = useState("");

  const handleIFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 4096 && d.length !== 2048) {
        setIErr("Wrong size: " + d.length + " bytes (need 4096 or 2048)");
        setIFile(null); setIData(null); setIResult(null); return;
      }
      setIErr(""); setIFile(f); setIData(d); setIResult(null);
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handleAFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 4096) {
        setAMsg("APPLY requires a Gen2 4KB (4096-byte) dump — VIN offsets 0x0EA5+ do not exist in a 2KB Gen1 file.");
        setAFile(null); setAData(null); return;
      }
      setAFile(f); setAData(d); setAMsg("");
    };
    r.readAsArrayBuffer(f);
  }, []);

  const doApply = () => {
    if (!aData || newVin.length !== 17) return;
    const patched = applyRfhub(aData, newVin);
    const fn = aFile.name.replace(/(\.[^.]+)?$/, "_RFHVIN_" + newVin + ".bin");
    dl(patched, fn, ASSET_IDS.immoRfhPatched);
    setAMsg("✓ Patched & downloaded: " + fn);
  };

  const vinValid = VIN_RE.test(newVin);
  const res = iResult;

  return (
    <Card style={{marginBottom:20}}>
      <SectionHeader icon="📡" title={<><Tip word="RFHUB">RFHUB</Tip> EEE — <Tip word="24C32">24C32</Tip> (4KB <Tip word="EEPROM">EEPROM</Tip>)</>} subtitle={<><Tip word="FCA">FCA</Tip> Remote Function Hub · 4 mirrored <Tip word="VIN">VIN</Tip> slots · <Tip word="CRC8">CRC8RF</Tip> · <Tip word="SEC16">SEC16</Tip> pairing bytes</>}/>

      <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:8}}>PHASE 1 — INSPECT</div>
      <FileDropZone label="Drop 4KB RFHUB .bin file (24C32)" onFile={handleIFile} fileName={iFile?.name}/>
      {iErr && <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:12,fontWeight:700}}>✗ {iErr}</div>}
      {iFile && !iErr && <div style={{marginTop:10}}><Btn onClick={()=>setIResult(parseRfhub(iData))} full color={C.sr}>🔍 Analyze File</Btn></div>}

      {res && (
        <div style={{marginTop:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            <Tag color={res.validSz?C.gn:C.wn}>{res.sz} bytes — {res.sz===4096?"4KB (Gen2)":res.sz===2048?"2KB (Gen1)":"SIZE WARN"}</Tag>
            <Tag color="#1565C0">24C32 EEE</Tag>
            {res.sec16valid ? <Tag color={C.gn}>SEC16 VALID ✓</Tag> : <Tag color={C.er}>SEC16 MISMATCH ✗</Tag>}
            {res.skeyBlank && <Tag color={C.wn}>SECRET KEY BLANK</Tag>}
          </div>

          {/* VIN slots */}
          <div style={{overflowX:"auto",marginBottom:14}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["Slot","Offset","VIN (decoded)","Stored CRC8RF","Calc CRC8RF","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
              <tbody>
                {res.slots.map(row=>(
                  <tr key={row.idx} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                    <td style={{padding:"7px 10px",fontWeight:800,color:C.sr}}>VIN {row.idx}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fO(row.offset)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.vin?C.gn:C.er}}>{row.vin||"(empty / invalid)"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{row.csStored!==null?"0x"+row.csStored.toString(16).toUpperCase().padStart(2,"0"):"—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{row.csCalc!==null?"0x"+row.csCalc.toString(16).toUpperCase().padStart(2,"0"):"—"}</td>
                    <td style={{padding:"7px 10px"}}>{row.csStored!==null?<Badge ok={row.crcOk}/>:<span style={{fontSize:10,color:C.tm}}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* SEC16 */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {res.sec16s.map(s=>(
              <div key={s.slot} style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <span style={{fontSize:11,fontWeight:800,color:C.a4}}>SEC16 Slot {s.slot} @ {fO(s.offset)}</span>
                  {s.blank?<Tag color={C.tm}>BLANK</Tag>:<Badge ok={s.csOk}/>}
                  {!s.blank&&s.slot===1&&res.sec16valid&&<Tag color={C.gn}>VALID ✓</Tag>}
                </div>
                {!s.blank&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:9,fontWeight:700,color:C.a4,wordBreak:"break-all"}}>{s.hex}</div>}
                {!s.blank&&<div style={{fontSize:9,color:C.ts,marginTop:4}}>CS stored: 0x{s.csStored.toString(16).toUpperCase().padStart(4,"0")} | calc: 0x{s.csCalc.toString(16).toUpperCase().padStart(4,"0")}</div>}
              </div>
            ))}
          </div>

          {/* Secret key */}
          <div style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:11,fontWeight:800,color:C.a4}}>Secret Key @ 0x0040</span>
              <Tag color={res.skeyBlank?C.wn:C.gn}>{res.skeyBlank?"BLANK/ERASED":"SET"}</Tag>
            </div>
            {res.skey&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:res.skeyBlank?C.tm:C.a4}}>{hxb(res.skey)}</div>}
          </div>
        </div>
      )}

      <div style={{marginTop:20,borderTop:"1.5px solid "+C.bd,paddingTop:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.a2,letterSpacing:2,marginBottom:8}}>PHASE 2 — APPLY VIN</div>
        <div style={{fontSize:11,color:C.ts,marginBottom:8}}>Writes byte-reversed VIN to all 4 slots · Recalculates CRC8RF per slot</div>
        <FileDropZone label="Re-upload the same RFHUB .bin to patch (must be 4096B Gen2)" onFile={handleAFile} fileName={aFile?.name}/>
        <div style={{marginTop:10}}>
          <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN (17 chars)</div>
          <input value={newVin} maxLength={17} placeholder="Enter 17-character VIN"
            onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
            style={{width:"100%",padding:"10px 14px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:15,fontWeight:700,letterSpacing:3,textAlign:"center",outline:"none",color:C.tx}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm}}>{newVin.length}/17</span>
            {newVin.length===17&&!vinValid&&<span style={{fontSize:11,color:C.er}}>Invalid VIN characters</span>}
          </div>
        </div>
        <div style={{marginTop:10}}>
          <Btn onClick={doApply} disabled={!aFile||!vinValid||newVin.length!==17} full color={C.a2}>⚡ APPLY — Write VIN to 4 slots + Download</Btn>
          <div style={{marginTop:6,textAlign:"center"}}><DownloadCounter assetId={ASSET_IDS.immoRfhPatched}/></div>
        </div>
        {aMsg&&<div style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:aMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(aMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:aMsg.startsWith("✓")?C.gn:C.er}}>{aMsg}</div>}
      </div>
    </Card>
  );
}

/* ─── GPEC2A (95320 SPI) helpers ─────────────────────────────────────── */

const GPEC_VIN_OFFSETS = [0x0000, 0x01F0, 0x0224];

function extractGpecVin(data, off) {
  if (off + 17 > data.length) return null;
  let s = "";
  for (let i = 0; i < 17; i++) {
    const ch = String.fromCharCode(data[off + i]);
    if (!/[A-HJ-NPR-Z0-9]/.test(ch)) return null;
    s += ch;
  }
  return s;
}

function parseGpec2a(data) {
  const sz = data.length;
  const validSz = sz === 4096;
  const slots = GPEC_VIN_OFFSETS.map((off, idx) => ({
    idx: idx+1, offset: off, vin: extractGpecVin(data, off)
  }));
  const consistent = slots.length === 3 && slots.every(s => s.vin) && slots.every(s => s.vin === slots[0].vin);
  const mainVin = consistent ? slots[0].vin : (slots.find(s => s.vin)?.vin || null);

  const keyPrimary = sz >= 0x020B ? Array.from(data.slice(0x0203, 0x020B)) : null;
  const keyMirror  = sz >= 0x0369 ? Array.from(data.slice(0x0361, 0x0369)) : null;
  const keyConsistent = keyPrimary && keyMirror && keyPrimary.every((b,i) => b === keyMirror[i]);

  const skimByte = sz > 0x0011 ? data[0x0011] : null;
  const skimStatus = skimByte === 0x80 ? "ENABLED" : skimByte === 0x00 ? "DISABLED" : "UNKNOWN";

  let pcmSec6 = null;
  if (sz > 0x03CE) {
    const raw = Array.from(data.slice(0x03C8, 0x03CE));
    const damaged = raw.every(b => b === 0xFF);
    pcmSec6 = {hex: hxb(raw), damaged};
  }

  return {sz, validSz, slots, consistent, mainVin, keyPrimary, keyMirror, keyConsistent, skimByte, skimStatus, pcmSec6};
}

function applyGpec2a(data, newVin, newKeyHex) {
  const out = new Uint8Array(data);
  if (newVin && newVin.length === 17) {
    const enc = new TextEncoder().encode(newVin.toUpperCase());
    for (const off of GPEC_VIN_OFFSETS) {
      if (off + 17 <= out.length) for (let i = 0; i < 17; i++) out[off+i] = enc[i];
    }
  }
  if (newKeyHex && newKeyHex.length === 16) {
    for (let i = 0; i < 8; i++) {
      const b = parseInt(newKeyHex.slice(i*2, i*2+2), 16);
      if (0x0203 + i < out.length) out[0x0203+i] = b;
      if (0x0361 + i < out.length) out[0x0361+i] = b;
    }
  }
  return out;
}

function GPECSection() {
  const [iFile, setIFile] = useState(null);
  const [iData, setIData] = useState(null);
  const [iResult, setIResult] = useState(null);
  const [iErr, setIErr] = useState("");
  const [aFile, setAFile] = useState(null);
  const [aData, setAData] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [newKey, setNewKey] = useState("");
  const [aMsg, setAMsg] = useState("");

  const handleIFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 4096) {
        setIErr("Wrong size: " + d.length + " bytes (need exactly 4096 / 4KB)");
        setIFile(null); setIData(null); setIResult(null); return;
      }
      setIErr(""); setIFile(f); setIData(d); setIResult(null);
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handleAFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 4096) { setAMsg("Wrong size: " + d.length + " bytes (need 4096)"); setAFile(null); setAData(null); return; }
      setAFile(f); setAData(d); setAMsg("");
    };
    r.readAsArrayBuffer(f);
  }, []);

  const doApply = () => {
    if (!aData) return;
    const vinToWrite = newVin.length === 17 && VIN_RE.test(newVin) ? newVin : "";
    const keyToWrite = newKey.length === 16 && /^[0-9A-F]{16}$/i.test(newKey) ? newKey : "";
    if (!vinToWrite && !keyToWrite) { setAMsg("Enter at least one field (VIN or Secret Key) to apply."); return; }
    const patched = applyGpec2a(aData, vinToWrite, keyToWrite);
    const fn = aFile.name.replace(/(\.[^.]+)?$/, "_GPEC_"+(vinToWrite||"NOVIN")+".bin");
    dl(patched, fn, ASSET_IDS.immoGpecPatched);
    setAMsg("✓ Patched & downloaded: " + fn);
  };

  const vinValid = newVin.length === 0 || VIN_RE.test(newVin);
  const keyValid = newKey.length === 0 || (newKey.length === 16 && /^[0-9A-Fa-f]{16}$/.test(newKey));
  const res = iResult;

  return (
    <Card>
      <SectionHeader icon="⚙️" title={<><Tip word="GPEC2A">GPEC2A</Tip> — <Tip word="95320">95320</Tip> SPI <Tip word="EEPROM">EEPROM</Tip> (4KB)</>} subtitle={<><Tip word="PCM">PCM</Tip>/<Tip word="GPEC2A">GPEC2A</Tip> · 3 plain ASCII <Tip word="VIN">VIN</Tip> slots · 8B secret key · <Tip word="SKIM">SKIM</Tip> byte · <Tip word="PCM">PCM</Tip> <Tip word="SEC6">SEC6</Tip></>}/>

      <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:8}}>PHASE 1 — INSPECT</div>
      <FileDropZone label="Drop 4KB GPEC2A .bin file (95320)" onFile={handleIFile} fileName={iFile?.name}/>
      {iErr && <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:12,fontWeight:700}}>✗ {iErr}</div>}
      {iFile && !iErr && <div style={{marginTop:10}}><Btn onClick={()=>setIResult(parseGpec2a(iData))} full color={C.sr}>🔍 Analyze File</Btn></div>}

      {res && (
        <div style={{marginTop:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            <Tag color={res.validSz?C.gn:C.wn}>{res.sz} bytes — {res.validSz?"4KB ✓":"SIZE WARN"}</Tag>
            <Tag color={C.sr}>95320 SPI</Tag>
            {res.mainVin && <Tag color={res.consistent?C.gn:C.wn}>{res.mainVin}</Tag>}
            {res.consistent
              ? <Tag color={C.gn}>VINs CONSISTENT ✓</Tag>
              : <Tag color={C.er}>VIN MISMATCH ✗</Tag>}
          </div>

          {/* VIN slots */}
          <div style={{overflowX:"auto",marginBottom:14}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["Slot","Offset","VIN (17B ASCII)","No CRC","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
              <tbody>
                {res.slots.map(row=>(
                  <tr key={row.idx} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                    <td style={{padding:"7px 10px",fontWeight:800,color:C.sr}}>VIN {row.idx}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fO(row.offset)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.vin?C.gn:C.er}}>{row.vin||"(empty / invalid)"}</td>
                    <td style={{padding:"7px 10px",fontSize:10,color:C.tm}}>—</td>
                    <td style={{padding:"7px 10px"}}>{row.vin?<Badge ok={true} label="READ OK"/>:<span style={{fontSize:10,color:C.er}}>EMPTY</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Secret key */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            {[["PRIMARY","0x0203",res.keyPrimary],["MIRROR","0x0361",res.keyMirror]].map(([lbl,off,key])=>(
              <div key={lbl} style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <span style={{fontSize:11,fontWeight:800,color:C.a4}}>Key {lbl} @ {off}</span>
                  {res.keyConsistent!==null&&lbl==="PRIMARY"&&<Badge ok={res.keyConsistent} label={res.keyConsistent?"MATCH ✓":"MISMATCH ✗"}/>}
                </div>
                <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:key?C.a4:C.tm}}>{key?hxb(key):"—"}</div>
              </div>
            ))}
          </div>

          {/* SKIM byte + PCM SEC6 */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
              <div style={{fontSize:11,fontWeight:800,color:C.sr,marginBottom:4}}>SKIM Byte @ 0x0011</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.tx}}>0x{res.skimByte!==null?res.skimByte.toString(16).toUpperCase().padStart(2,"0"):"?"}</span>
                <Tag color={res.skimByte===0x80?C.gn:res.skimByte===0x00?C.wn:C.er}>{res.skimStatus}</Tag>
              </div>
            </div>
            {res.pcmSec6&&(
              <div style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
                <div style={{fontSize:11,fontWeight:800,color:C.a4,marginBottom:4}}>PCM SEC6 @ 0x03C8</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:res.pcmSec6.damaged?C.er:C.a4}}>{res.pcmSec6.hex}</span>
                  {res.pcmSec6.damaged&&<Tag color={C.er}>IMMO_DAMAGED</Tag>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{marginTop:20,borderTop:"1.5px solid "+C.bd,paddingTop:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.a2,letterSpacing:2,marginBottom:8}}>PHASE 2 — APPLY</div>
        <div style={{fontSize:11,color:C.ts,marginBottom:8}}>VIN written to all 3 slots (no CRC) · Key written to PRIMARY + MIRROR · Blank fields skipped</div>
        <FileDropZone label="Re-upload the same 4KB GPEC2A .bin to patch" onFile={handleAFile} fileName={aFile?.name}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN — optional</div>
            <input value={newVin} maxLength={17} placeholder="Leave blank to skip"
              onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,letterSpacing:2,textAlign:"center",outline:"none",color:C.tx}}/>
            <div style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm,marginTop:2}}>{newVin.length}/17</div>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW SECRET KEY (16 hex digits = 8 bytes) — optional</div>
            <input value={newKey} maxLength={16} placeholder="e.g. A1B2C3D4E5F60718"
              onChange={e=>setNewKey(e.target.value.toUpperCase().replace(/[^0-9A-F]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newKey.length===16&&keyValid?C.gn:newKey.length>0&&!keyValid?C.er:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,letterSpacing:1,outline:"none",color:C.tx}}/>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
              <span style={{fontSize:11,fontWeight:800,color:newKey.length===16?C.gn:C.tm}}>{newKey.length}/16</span>
              <span style={{fontSize:10,color:C.ts}}>Written to 0x0203 + 0x0361</span>
            </div>
          </div>
        </div>
        <div style={{marginTop:12}}>
          <Btn onClick={doApply} disabled={!aFile||(newVin.length>0&&!vinValid)||(newKey.length>0&&!keyValid)} full color={C.a2}>⚡ APPLY — Patch non-empty fields + Download</Btn>
          <div style={{fontSize:10,color:C.ts,marginTop:4,textAlign:"center"}}>Blank fields are not modified in the output file.</div>
          <div style={{marginTop:6,textAlign:"center"}}><DownloadCounter assetId={ASSET_IDS.immoGpecPatched}/></div>
        </div>
        {aMsg&&<div style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:aMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(aMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:aMsg.startsWith("✓")?C.gn:C.er}}>{aMsg}</div>}
      </div>
    </Card>
  );
}

export default function ImmoVINTab() {
  const [pdfBusy, setPdfBusy] = useState(false);
  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try { await buildOnePagerPDF(IMMO_VIN_REF); }
    catch (e) { console.error(e); alert('PDF build failed: ' + e.message); }
    finally { setPdfBusy(false); }
  };
  return (
    <div>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12,marginBottom:20}}>
        <div>
          <div style={{fontSize:22,fontWeight:900,color:C.tx,marginBottom:4}}>ImmoVIN</div>
          <div style={{fontSize:12,color:C.ts}}>Binary <Tip word="VIN">VIN</Tip> inspection and editing for <Tip word="FCA">FCA</Tip> <Tip word="EEPROM">EEPROM</Tip> modules — two-phase workflow: INSPECT then APPLY</div>
        </div>
        <button onClick={onPdf} disabled={pdfBusy} style={{cursor:pdfBusy?'wait':'pointer',border:'2px solid '+C.sr,padding:'8px 14px',borderRadius:10,background:'#fff',color:C.sr,fontWeight:800,fontSize:11,letterSpacing:.5,fontFamily:"'Nunito'",whiteSpace:'nowrap'}}>
          {pdfBusy?'⏳ Building...':'🖨 Print Reference'}
        </button>
      </div>
      <RFHSection/>
      <GPECSection/>
    </div>
  );
}
