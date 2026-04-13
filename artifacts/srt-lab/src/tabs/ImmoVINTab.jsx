import React, {useState, useCallback, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card, Tag, Btn} from "../lib/ui.jsx";
import {crc16} from "../lib/crc.js";

const fO = n => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const dl = (data, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], {type: "application/octet-stream"}));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

function Badge({ok}) {
  return (
    <span style={{display:"inline-block",padding:"2px 8px",borderRadius:6,fontSize:10,fontWeight:800,letterSpacing:.5,background:ok?C.gn+"18":C.er+"18",color:ok?C.gn:C.er}}>{ok?"OK":"FAIL"}</span>
  );
}

function SectionHeader({icon, title, subtitle}) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
      <div style={{width:40,height:40,borderRadius:10,background:"linear-gradient(135deg,#AA00FF22,#AA00FF44)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,border:"1.5px solid #AA00FF33"}}>{icon}</div>
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
      {fileName
        ? <div style={{fontSize:12,fontWeight:800,color:C.sr}}>{fileName}</div>
        : <div style={{fontSize:12,color:C.ts}}>{label}</div>
      }
    </div>
  );
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

function extractIdField(data, offset, maxLen) {
  if (offset + maxLen > data.length) maxLen = data.length - offset;
  let printable = "", hexStr = "";
  for (let i = 0; i < maxLen; i++) {
    const b = data[offset + i];
    if (i > 0) hexStr += " ";
    hexStr += b.toString(16).toUpperCase().padStart(2, "0");
    printable += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : ".";
  }
  const isBlank = Array.from(data.slice(offset, offset + maxLen)).every(b => b === 0xFF || b === 0x00);
  return {printable, hex: hexStr, isBlank};
}

function extractVin95640(data, offset) {
  if (offset + 17 > data.length) return null;
  let s = "";
  for (let i = 0; i < 17; i++) {
    const b = data[offset + i];
    const ch = String.fromCharCode(b);
    if (!/[A-HJ-NPR-Z0-9]/.test(ch)) return null;
    s += ch;
  }
  return s;
}

function byteSum17(data, offset) {
  let s = 0;
  for (let i = 0; i < 17; i++) s += data[offset + i];
  return s & 0xFF;
}

function parse95640(data) {
  const sz = data.length;
  const ok = sz === 8192;
  const id1 = extractIdField(data, 0x0000, 16);
  const pn  = extractIdField(data, 0x0010, 10);
  const id2 = extractIdField(data, 0x001A, 8);
  const vin1 = extractVin95640(data, 0x0275);
  const vin2 = extractVin95640(data, 0x0288);
  const cs1Stored = data[0x0274];
  const cs2Stored = data[0x0287];
  const cs1Calc = vin1 !== null ? byteSum17(data, 0x0275) : null;
  const cs2Calc = vin2 !== null ? byteSum17(data, 0x0288) : null;
  return {ok, sz, id1, pn, id2, mainVin: vin1 || vin2 || null, vin1, vin2, cs1Stored, cs2Stored, cs1Calc, cs2Calc};
}

function apply95640(data, newVin) {
  const out = new Uint8Array(data);
  const enc = new TextEncoder().encode(newVin.toUpperCase());
  const cs = enc.reduce((a, b) => (a + b) & 0xFF, 0);
  out[0x0274] = cs;
  for (let i = 0; i < 17; i++) out[0x0275 + i] = enc[i];
  out[0x0287] = cs;
  for (let i = 0; i < 17; i++) out[0x0288 + i] = enc[i];
  return out;
}

function IdFieldCell({field}) {
  if (field.isBlank) return <span style={{fontFamily:"'JetBrains Mono'",fontSize:10,color:C.tm}}>(blank)</span>;
  const dots = (field.printable.match(/\./g)||[]).length;
  if (dots / field.printable.length < 0.5) {
    return <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.ts}}>{field.printable}</span>;
  }
  return <span style={{fontFamily:"'JetBrains Mono'",fontSize:9,color:C.ts,wordBreak:"break-all"}}>{field.hex}</span>;
}

function RFHSection() {
  const [inspectFile, setInspectFile] = useState(null);
  const [inspectData, setInspectData] = useState(null);
  const [inspectResult, setInspectResult] = useState(null);
  const [inspectError, setInspectError] = useState("");
  const [applyFile, setApplyFile] = useState(null);
  const [applyData, setApplyData] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [applyMsg, setApplyMsg] = useState("");

  const handleInspectFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 8192) {
        setInspectError("Wrong size: " + d.length + " bytes (need exactly 8192)");
        setInspectFile(null); setInspectData(null); setInspectResult(null);
        return;
      }
      setInspectError(""); setInspectFile(f); setInspectData(d); setInspectResult(null);
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handleApplyFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 8192) { setApplyMsg("Wrong size: " + d.length + " bytes (need 8192)"); setApplyFile(null); setApplyData(null); return; }
      setApplyFile(f); setApplyData(d); setApplyMsg("");
    };
    r.readAsArrayBuffer(f);
  }, []);

  const doApply = () => {
    if (!applyData || newVin.length !== 17) return;
    const patched = apply95640(applyData, newVin);
    const fn = applyFile.name.replace(/(\.[^.]+)?$/, "_VIN_" + newVin + ".bin");
    dl(patched, fn);
    setApplyMsg("✓ Patched & downloaded: " + fn);
  };

  const vinValid = VIN_RE.test(newVin);

  return (
    <Card style={{marginBottom:20}}>
      <SectionHeader icon="🔌" title="RFH MC9S12X / ST95640 — 8KB EEPROM" subtitle="FCA Remote Function Hub · ST95640 chip · VIN slots at 0x0275 and 0x0288"/>

      <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:8}}>PHASE 1 — INSPECT</div>
      <FileDropZone label="Drop 8KB ST95640 .bin file to inspect" onFile={handleInspectFile} fileName={inspectFile?.name}/>
      {inspectError && <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:12,fontWeight:700}}>✗ {inspectError}</div>}
      {inspectFile && !inspectError && (
        <div style={{marginTop:10}}>
          <Btn onClick={()=>setInspectResult(parse95640(inspectData))} full color={C.sr}>🔍 Analyze File</Btn>
        </div>
      )}

      {inspectResult && (
        <div style={{marginTop:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            <Tag color={inspectResult.ok?C.gn:C.wn}>{inspectResult.sz} bytes — {inspectResult.ok?"8KB ✓":"SIZE WARN"}</Tag>
            <Tag color="#AA00FF">ST95640 CHIP</Tag>
            {inspectResult.mainVin&&<Tag color={C.a1}>{inspectResult.mainVin}</Tag>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
            {[["ID1","0x0000",inspectResult.id1],["PN","0x0010",inspectResult.pn],["ID2","0x001A",inspectResult.id2]].map(([k,off,field])=>(
              <div key={k} style={{padding:"8px 10px",borderRadius:8,background:C.c2,border:"1px solid "+C.bd}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                  <span style={{fontSize:9,fontWeight:800,color:C.tm,letterSpacing:1}}>{k}</span>
                  <span style={{fontSize:9,color:C.a3,fontFamily:"'JetBrains Mono'"}}>{off}</span>
                </div>
                <IdFieldCell field={field}/>
              </div>
            ))}
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["Slot","Offset","VIN (17 bytes)","Stored CS","Calc CS","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
              <tbody>
                {[
                  {slot:"VIN 1",offset:0x0275,vin:inspectResult.vin1,csS:inspectResult.cs1Stored,csC:inspectResult.cs1Calc},
                  {slot:"VIN 2",offset:0x0288,vin:inspectResult.vin2,csS:inspectResult.cs2Stored,csC:inspectResult.cs2Calc},
                ].map(row=>(
                  <tr key={row.slot} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                    <td style={{padding:"7px 10px",fontWeight:800,color:"#AA00FF"}}>{row.slot}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fO(row.offset)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.vin?C.gn:C.er}}>{row.vin||"(empty / invalid)"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{"0x"+row.csS.toString(16).toUpperCase().padStart(2,"0")}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{row.csC!==null?"0x"+row.csC.toString(16).toUpperCase().padStart(2,"0"):"—"}</td>
                    <td style={{padding:"7px 10px"}}>{row.vin?<Badge ok={row.csS===row.csC}/>:<span style={{fontSize:10,color:C.tm}}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{marginTop:20,borderTop:"1.5px solid "+C.bd,paddingTop:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.a2,letterSpacing:2,marginBottom:8}}>PHASE 2 — APPLY</div>
        <FileDropZone label="Re-upload the same 8KB .bin file to patch" onFile={handleApplyFile} fileName={applyFile?.name}/>
        <div style={{marginTop:10}}>
          <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN (17 chars)</div>
          <input value={newVin} maxLength={17} placeholder="Enter 17-character VIN"
            onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
            style={{width:"100%",padding:"10px 14px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:15,fontWeight:700,letterSpacing:3,textAlign:"center",outline:"none",color:C.tx}}
          />
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm}}>{newVin.length}/17</span>
            {newVin.length===17&&!vinValid&&<span style={{fontSize:11,color:C.er}}>Invalid VIN characters</span>}
          </div>
        </div>
        <div style={{marginTop:10}}>
          <Btn onClick={doApply} disabled={!applyFile||!vinValid} full color={C.a2}>⚡ APPLY — Write VIN to both slots + Download</Btn>
        </div>
        {applyMsg&&<div style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:applyMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(applyMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:applyMsg.startsWith("✓")?C.gn:C.er}}>{applyMsg}</div>}
      </div>
    </Card>
  );
}

const BCM_VIN_OFFSETS = [0x5320, 0x5340, 0x5360, 0x5380];

function extractBcmVin(data, offset) {
  if (offset + 17 > data.length) return null;
  let s = "";
  for (let i = 0; i < 17; i++) {
    const ch = String.fromCharCode(data[offset + i]);
    if (!/[A-HJ-NPR-Z0-9]/.test(ch)) return null;
    s += ch;
  }
  return s;
}

function parseBcm(data) {
  const sz = data.length;
  const ok = sz === 65536;
  const slots = BCM_VIN_OFFSETS.map((off, idx) => {
    const vin = extractBcmVin(data, off);
    const storedCrc = off + 19 <= sz ? ((data[off+17]<<8)|data[off+18]) : null;
    let calcCrc = null;
    if (vin) {
      const vb = new Uint8Array(17);
      for (let i = 0; i < 17; i++) vb[i] = data[off + i];
      calcCrc = crc16(vb);
    }
    return {idx: idx + 1, offset: off, vin, storedCrc, calcCrc, crcOk: vin !== null && storedCrc !== null && storedCrc === calcCrc};
  });
  let mainVin = null, best = -1;
  for (const s of slots) {
    if (!s.vin) continue;
    let sc = 1;
    if (/^[1-9A-HJ-NPR-Z]/.test(s.vin)) sc += 2;
    if (s.crcOk) sc += 4;
    if (sc > best) {best = sc; mainVin = s.vin;}
  }
  let sec16 = null;
  if (sz >= 0x84A) {
    const raw = data.slice(0x0838, 0x0848);
    const storedCrc = (data[0x0848]<<8)|data[0x0849];
    const calcCrc = crc16(raw);
    const blank = Array.from(raw).every(b => b===0xFF||b===0x00);
    const hex = Array.from(raw).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join("");
    sec16 = {hex, storedCrc, calcCrc, csOk: storedCrc===calcCrc, blank};
  }
  return {ok, sz, slots, mainVin, sec16};
}

function applyBcm(data, newVin, newSec16Hex) {
  const out = new Uint8Array(data);
  if (newVin && newVin.length === 17) {
    const enc = new TextEncoder().encode(newVin.toUpperCase());
    const cs = crc16(enc);
    for (const off of BCM_VIN_OFFSETS) {
      for (let i = 0; i < 17; i++) out[off+i] = enc[i];
      out[off+17] = (cs>>8)&0xFF; out[off+18] = cs&0xFF;
    }
  }
  if (newSec16Hex && newSec16Hex.length === 32) {
    const raw = new Uint8Array(16);
    for (let i = 0; i < 16; i++) raw[i] = parseInt(newSec16Hex.slice(i*2, i*2+2), 16);
    const cs = crc16(raw);
    for (let i = 0; i < 16; i++) out[0x0838+i] = raw[i];
    out[0x0848] = (cs>>8)&0xFF; out[0x0849] = cs&0xFF;
  }
  return out;
}

function BCMSection() {
  const [inspectFile, setInspectFile] = useState(null);
  const [inspectData, setInspectData] = useState(null);
  const [inspectResult, setInspectResult] = useState(null);
  const [inspectError, setInspectError] = useState("");
  const [applyFile, setApplyFile] = useState(null);
  const [applyData, setApplyData] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [newSec16, setNewSec16] = useState("");
  const [applyMsg, setApplyMsg] = useState("");

  const handleInspectFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 65536) {
        setInspectError("Wrong size: " + d.length + " bytes (need exactly 65536 / 64KB)");
        setInspectFile(null); setInspectData(null); setInspectResult(null);
        return;
      }
      setInspectError(""); setInspectFile(f); setInspectData(d); setInspectResult(null);
    };
    r.readAsArrayBuffer(f);
  }, []);

  const handleApplyFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 65536) { setApplyMsg("Wrong size: " + d.length + " bytes (need 65536 / 64KB)"); setApplyFile(null); setApplyData(null); return; }
      setApplyFile(f); setApplyData(d); setApplyMsg("");
    };
    r.readAsArrayBuffer(f);
  }, []);

  const doApply = () => {
    if (!applyData) return;
    const vinToWrite = newVin.length === 17 ? newVin : "";
    const sec16ToWrite = newSec16.length === 32 ? newSec16 : "";
    if (!vinToWrite && !sec16ToWrite) { setApplyMsg("Enter at least one field (VIN or SEC16) to apply."); return; }
    const patched = applyBcm(applyData, vinToWrite, sec16ToWrite);
    const suffix = [vinToWrite&&"VIN_"+vinToWrite, sec16ToWrite&&"SEC16"].filter(Boolean).join("_");
    const fn = applyFile.name.replace(/(\.[^.]+)?$/, "_"+suffix+".bin");
    dl(patched, fn);
    setApplyMsg("✓ Patched & downloaded: " + fn);
  };

  const vinValid = newVin.length === 0 || VIN_RE.test(newVin);
  const sec16Valid = newSec16.length === 0 || (newSec16.length === 32 && /^[0-9A-Fa-f]{32}$/.test(newSec16));

  return (
    <Card>
      <SectionHeader icon="🖥️" title="BCM MPC5606B_05B — 64KB D-Flash" subtitle="Body Control Module · MPC5606B chip · VINs at 0x5320–0x5380 · SEC16 at 0x0838"/>

      <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:8}}>PHASE 1 — INSPECT</div>
      <FileDropZone label="Drop 64KB BCM MPC5606B .bin file to inspect" onFile={handleInspectFile} fileName={inspectFile?.name}/>
      {inspectError&&<div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:12,fontWeight:700}}>✗ {inspectError}</div>}
      {inspectFile&&!inspectError&&(
        <div style={{marginTop:10}}>
          <Btn onClick={()=>setInspectResult(parseBcm(inspectData))} full color={C.sr}>🔍 Analyze File</Btn>
        </div>
      )}

      {inspectResult&&(
        <div style={{marginTop:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            <Tag color={inspectResult.ok?C.gn:C.wn}>{inspectResult.sz} bytes — {inspectResult.ok?"64KB ✓":"SIZE WARN"}</Tag>
            <Tag color={C.a1}>BCM MPC5606B_05B</Tag>
            {inspectResult.mainVin&&<Tag color={C.sr}>{inspectResult.mainVin}</Tag>}
          </div>
          <div style={{overflowX:"auto",marginBottom:14}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["Copy","Offset","VIN (17 bytes)","Stored CRC16","Calc CRC16","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
              <tbody>
                {inspectResult.slots.map(row=>(
                  <tr key={row.idx} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                    <td style={{padding:"7px 10px",fontWeight:800,color:C.a1}}>VIN {row.idx}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fO(row.offset)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.vin?C.gn:C.er}}>{row.vin||"(empty / invalid)"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{row.storedCrc!==null?"0x"+row.storedCrc.toString(16).toUpperCase().padStart(4,"0"):"—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.ts}}>{row.calcCrc!==null?"0x"+row.calcCrc.toString(16).toUpperCase().padStart(4,"0"):"—"}</td>
                    <td style={{padding:"7px 10px"}}>{row.vin?<Badge ok={row.crcOk}/>:<span style={{fontSize:10,color:C.tm}}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {inspectResult.sec16&&(
            <div style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{fontSize:11,fontWeight:800,color:C.a4}}>SEC16 @ {fO(0x0838)}</div>
                {inspectResult.sec16.blank?<Tag color={C.tm}>BLANK</Tag>:<Badge ok={inspectResult.sec16.csOk}/>}
              </div>
              {!inspectResult.sec16.blank&&(
                <>
                  <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.a4,letterSpacing:.5,wordBreak:"break-all",marginBottom:4}}>{inspectResult.sec16.hex}</div>
                  <div style={{fontSize:10,color:C.ts}}>CRC16 stored: 0x{inspectResult.sec16.storedCrc.toString(16).toUpperCase().padStart(4,"0")} | calc: 0x{inspectResult.sec16.calcCrc.toString(16).toUpperCase().padStart(4,"0")}</div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{marginTop:20,borderTop:"1.5px solid "+C.bd,paddingTop:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.a2,letterSpacing:2,marginBottom:8}}>PHASE 2 — APPLY</div>
        <FileDropZone label="Re-upload the same 64KB .bin file to patch" onFile={handleApplyFile} fileName={applyFile?.name}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN — optional</div>
            <input value={newVin} maxLength={17} placeholder="Leave blank to skip"
              onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,letterSpacing:2,textAlign:"center",outline:"none",color:C.tx}}
            />
            <div style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm,marginTop:2}}>{newVin.length}/17</div>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW SEC16 (32 hex digits) — optional</div>
            <input value={newSec16} maxLength={32} placeholder="Leave blank to skip"
              onChange={e=>setNewSec16(e.target.value.toUpperCase().replace(/[^0-9A-F]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newSec16.length===32&&sec16Valid?C.gn:newSec16.length>0&&!sec16Valid?C.er:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,letterSpacing:1,outline:"none",color:C.tx}}
            />
            <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
              <span style={{fontSize:11,fontWeight:800,color:newSec16.length===32?C.gn:C.tm}}>{newSec16.length}/32</span>
              {newSec16.length>0&&!sec16Valid&&<span style={{fontSize:10,color:C.er}}>Must be 32 hex digits</span>}
            </div>
          </div>
        </div>
        <div style={{marginTop:12}}>
          <Btn onClick={doApply} disabled={!applyFile||(newVin.length>0&&!vinValid)||(newSec16.length>0&&!sec16Valid)} full color={C.a2}>⚡ APPLY — Patch non-empty fields + Download</Btn>
          <div style={{fontSize:10,color:C.ts,marginTop:4,textAlign:"center"}}>Fields left blank will not be modified in the output file.</div>
        </div>
        {applyMsg&&<div style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:applyMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(applyMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:applyMsg.startsWith("✓")?C.gn:C.er}}>{applyMsg}</div>}
      </div>
    </Card>
  );
}

export default function ImmoVINTab() {
  return (
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:22,fontWeight:900,color:C.tx,marginBottom:4}}>ImmoVIN</div>
        <div style={{fontSize:12,color:C.ts}}>Binary VIN inspection and editing for FCA EEPROM modules — two-phase workflow: INSPECT then APPLY</div>
      </div>
      <RFHSection/>
      <BCMSection/>
    </div>
  );
}
