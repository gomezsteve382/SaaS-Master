import React, {useState, useCallback, useRef} from "react";
import {C} from "../lib/constants.js";
import {Card, Tag, Btn} from "../lib/ui.jsx";
import {crc16, rfhGen2VinCs, rfhGen2DetectMagic} from "../lib/crc.js";
import {ASSET_IDS, trackDownload} from "../lib/downloadAssets.js";
import {DownloadCounter} from "../lib/useDownloadCount.jsx";
import {buildOnePagerPDF} from "../lib/buildOnePagerPDF.js";
import {IMMO_VIN_REF} from "../lib/tabReferences.js";
import {Tip} from "../lib/plainEnglish.jsx";
import SamplePicker from "../lib/SamplePicker.jsx";
import {
  PCM_VIN_OFFSETS_GPEC2A,
  BCM_FULL_VIN_BASES_PARSED,
  resolveBcmSec16,
} from "../lib/parseModule.js";
import {
  BCM_FULL_VIN_BASES_ALT,
  BCM_PARTIAL_VIN_OFFSETS,
  BCM_PARTIAL_VIN_LEN,
  findBcmPartialVinSlots,
} from "../lib/donorLeakScan.js";
import {writeBcmSec16Gen2} from "../lib/securityBytes.js";
import {logSec16Sync} from "../lib/sec16SyncLog.js";
import {classifyPlatform} from "../lib/sec16Platforms.js";
import {fmtOff} from "./ModuleSync.jsx";
import VinChargerSubtitle from "../lib/VinChargerSubtitle.jsx";

/* Task #463 — alt zone bases live at indices 1..n of BCM_FULL_VIN_BASES_ALT
 * (the 0x1300 entry holds a record header, not a VIN base). The PARSED
 * mirror in parseModule.js trims index 0; we mirror that trim here so the
 * auto-detect zone scan only iterates real VIN bases. */
const BCM_FULL_VIN_BASES_ALT_PARSED = BCM_FULL_VIN_BASES_ALT.slice(1);

/* Task #470 — local `fO` helper retired in favour of the shared `fmtOff`
 * exported from ModuleSync, so the Immo/VIN tab renders offsets in the
 * SINCRO-style "0xHHHH (D)" form used by Module Sync, RFH/PCM, Twin,
 * Backups, and the Mismatch Wizard. */
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

function FileDropZone({label, onFile, fileName, inputTestId}) {
  const inputRef = useRef();
  return (
    <div onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)onFile(f);}} onDragOver={e=>e.preventDefault()} onClick={()=>inputRef.current.click()} style={{border:"2px dashed "+C.sr+"30",borderRadius:10,padding:"14px 16px",cursor:"pointer",textAlign:"center",background:C.c2}}>
      <input ref={inputRef} type="file" accept=".bin,.BIN" data-testid={inputTestId} style={{display:"none"}} onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}/>
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

/* Auto-detect the Gen2 VIN-CS magic byte from the first populated slot.
 * Mirrors the helper used by scripts/anonymize-real-dump.mjs and
 * lib/parseModule.js — different RFHUB Gen2 firmware revisions stamp a
 * different XOR magic into the CS byte (0xDB on 2020+ Redeye, 0x87 on
 * earlier Gen2, etc.). Returns 0xDB as the default when no slot is
 * populated yet (a virgin EEPROM image). */
function detectRfhMagic(data) {
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > data.length) continue;
    const slice = data.slice(off, off + 17);
    const cs = data[off + 17];
    if (slice.every(b => b === 0xFF || b === 0x00)) continue;
    if (cs === 0xFF || cs === 0x00) continue;
    return rfhGen2DetectMagic(slice, cs);
  }
  return 0xDB;
}

export function parseRfhub(data) {
  const sz = data.length;
  const validSz = sz === 4096 || sz === 2048;
  /* Gen1 (≤2KB) doesn't carry the 0x0EA5+ Gen2 slot table — return an
   * empty slot list so the UI surfaces "no Gen2 slots" rather than
   * confusing CRC mismatches against random EEPROM bytes. */
  const isGen2 = sz >= 0x0EE1 + 18;
  const magic = isGen2 ? detectRfhMagic(data) : null;
  const slots = !isGen2 ? [] : RFH_VIN_OFFSETS.map((off, idx) => {
    if (off + 18 > sz) return {idx:idx+1, offset:off, vin:null, csStored:null, csCalc:null, crcOk:false};
    const rawStored = data.slice(off, off+17);
    const vin = decodeRfhVin(data, off);
    const csStored = data[off + 17];
    const csCalc = rfhGen2VinCs(rawStored, magic);
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

export function applyRfhub(data, newVin) {
  const out = new Uint8Array(data);
  const enc = new TextEncoder().encode(newVin.toUpperCase());
  const rev = new Uint8Array(17);
  for (let i = 0; i < 17; i++) rev[i] = enc[16 - i];
  /* Use the magic byte detected from the existing slot data so we don't
   * silently regress to a different Gen2 dialect when re-stamping. Falls
   * back to 0xDB (2020+ Redeye) on a virgin image. Same algorithm
   * parseModule.js and the anonymizer use. */
  const magic = detectRfhMagic(out);
  const cs = rfhGen2VinCs(rev, magic);
  for (const off of RFH_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    for (let i = 0; i < 17; i++) out[off + i] = rev[i];
    out[off + 17] = cs;
  }
  return out;
}

/* ─── BCM (MPC560XB / MPC5606B_05B DFLASH, 64KB) helpers ─────────────── */

/* Per-slot record layout (verified against attached real-bench dumps,
 * Tasks #449 / #463 / #491):
 *   base  +0..+7  : 8-byte FEE record header (00 02 SS QQ 00 46 II 00 etc.)
 *         +8..+24 : 17-byte plaintext VIN (ASCII)
 *         +25/+26 : BE16 CRC-16/CCITT-FALSE over the 17 VIN bytes
 *         +27..+31: 5-byte trailer (slot id + footer)
 * Bases live in two zones: canonical 0x5320..0x5380 (most LX BCMs) and
 * alternate 0x1320..0x1380 (FCA SINCRO output for some Charger BCMs).
 * Real captures populate exactly one zone — the auto-detect picks
 * canonical first, falls back to alt if canonical is all 0xFF. */
const BCM_VIN_HEADER_LEN = 8;

/* Auto-detect the live VIN zone by scanning canonical first then alt.
 * Returns { bases, vinOffsets, label } where vinOffsets is the per-slot
 * VIN payload offset (base + 8). Falls back to the canonical zone when
 * neither is populated so a virgin BCM still gets writes to a sensible
 * default location. */
export function detectBcmVinZone(data) {
  const sz = data.length;
  for (const [bases, label] of [
    [BCM_FULL_VIN_BASES_PARSED, 'canonical-0x5328'],
    [BCM_FULL_VIN_BASES_ALT_PARSED, 'alt-0x1328'],
  ]) {
    let populated = 0;
    for (const base of bases) {
      const vinOff = base + BCM_VIN_HEADER_LEN;
      if (vinOff + 17 > sz) continue;
      let allBlank = true;
      for (let i = 0; i < 17; i++) {
        const b = data[vinOff + i];
        if (b !== 0xFF && b !== 0x00) { allBlank = false; break; }
      }
      if (!allBlank) populated++;
    }
    if (populated > 0) {
      return {
        bases: bases.slice(),
        vinOffsets: bases.map(b => b + BCM_VIN_HEADER_LEN),
        label,
      };
    }
  }
  // Virgin / blank — default to canonical so writes target the
  // standard zone any production tool will look at first.
  return {
    bases: BCM_FULL_VIN_BASES_PARSED.slice(),
    vinOffsets: BCM_FULL_VIN_BASES_PARSED.map(b => b + BCM_VIN_HEADER_LEN),
    label: 'canonical-0x5328 (virgin)',
  };
}

/* Decode a 17-byte VIN at `off`. Returns a string for the plain ASCII
 * case (BCM full-VIN slot) or null when the bytes are not a well-formed
 * VIN (lets the UI render an "(empty / invalid)" placeholder). */
function decodeBcmVin(data, off) {
  if (off + 17 > data.length) return null;
  let s = '';
  for (let i = 0; i < 17; i++) {
    const b = data[off + i];
    if (b < 0x30 || b > 0x5A) return null;
    if (b > 0x39 && b < 0x41) return null;
    if (b === 0x49 || b === 0x4F || b === 0x51) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

/* Auto-detect every BCM partial-VIN-shaped slot in the buffer (the
 * always-known offsets in BCM_PARTIAL_VIN_OFFSETS plus any additional
 * 8-VIN-byte+CRC16 records the helper finds — Task #436 / #452 / #491
 * fixtures carry partial slots at 0x0098 / 0x00B0 in addition to the
 * registered 0x4098 / 0x40B0 mirrors). Returns the union sorted by
 * offset so the apply pass writes them all. */
function detectBcmPartialOffsets(data) {
  const out = new Set();
  for (const po of BCM_PARTIAL_VIN_OFFSETS) {
    if (po + BCM_PARTIAL_VIN_LEN + 2 <= data.length) out.add(po);
  }
  for (const d of findBcmPartialVinSlots(data)) out.add(d.offset);
  return [...out].sort((a, b) => a - b);
}

export function parseBcmDflash(data) {
  const sz = data.length;
  const validSz = sz === 65536;
  const zone = detectBcmVinZone(data);
  const slots = zone.vinOffsets.map((vinOff, idx) => {
    const base = zone.bases[idx];
    if (vinOff + 19 > sz) {
      return {idx:idx+1, base, vinOffset:vinOff, vin:null, csStored:null, csCalc:null, crcOk:false};
    }
    const vin = decodeBcmVin(data, vinOff);
    const csStored = (data[vinOff + 17] << 8) | data[vinOff + 18];
    const csCalc = crc16(data.slice(vinOff, vinOff + 17));
    return {idx:idx+1, base, vinOffset:vinOff, vin, csStored, csCalc, crcOk: csStored === csCalc};
  });

  const partialOffs = detectBcmPartialOffsets(data);
  const partials = partialOffs.map((off, idx) => {
    if (off + BCM_PARTIAL_VIN_LEN + 2 > sz) {
      return {idx:idx+1, offset:off, tail:null, csStored:null, csCalc:null, crcOk:false};
    }
    let tail = '', ok = true;
    for (let j = 0; j < BCM_PARTIAL_VIN_LEN; j++) {
      const b = data[off + j];
      if (b < 0x20 || b > 0x7E) { ok = false; break; }
      tail += String.fromCharCode(b);
    }
    if (!ok) tail = null;
    const csStored = (data[off + BCM_PARTIAL_VIN_LEN] << 8) | data[off + BCM_PARTIAL_VIN_LEN + 1];
    const csCalc = crc16(data.slice(off, off + BCM_PARTIAL_VIN_LEN));
    return {idx:idx+1, offset:off, tail, csStored, csCalc, crcOk: csStored === csCalc};
  });

  /* SEC16 status lifted straight from the canonical resolver so this
   * tab agrees byte-for-byte with the rest of the app on whether the
   * BCM is paired or virgin (split records / mirror records / flat
   * fallback all live in one place — lib/parseModule.js). */
  const sec16 = sz >= 0x9000 ? resolveBcmSec16(data) : null;

  const distinctVins = Array.from(new Set(slots.map(s => s.vin).filter(Boolean)));
  const consistent = distinctVins.length === 1 && slots.every(s => s.vin === distinctVins[0]);
  const mainVin = consistent ? distinctVins[0] : (slots.find(s => s.vin)?.vin || null);

  return {sz, validSz, zone, slots, partials, sec16, consistent, mainVin};
}

/* applyBcmVin(data, newVin)
 *
 * Rewrites every full-VIN slot in the detected zone (4 records) AND every
 * detected partial-VIN slot (last-8 tail + CRC16). Re-stamps every CRC16
 * the parser validates. Returns a fresh Uint8Array — does not mutate the
 * input. The new VIN's last 8 chars are written to the partials, matching
 * the "rewrite all VIN copies + CRCs" promise the multi-target Immo/VIN
 * spec makes (Task #491). This is intentionally MORE thorough than the
 * real-bench SINCRO-EDIT swap (which left partial slots carrying the
 * donor's tail and is the same partial-VIN donor-tail leak Task #436
 * pinned in the anonymizer). */
export function applyBcmVin(data, newVin) {
  if (!newVin || newVin.length !== 17 || !VIN_RE.test(newVin)) {
    throw new Error('newVin must be a valid 17-character VIN');
  }
  const out = new Uint8Array(data);
  const enc = new TextEncoder().encode(newVin.toUpperCase());
  const tail = enc.slice(9); // last 8 chars
  const fullCrc = crc16(enc);
  const tailCrc = crc16(tail);
  const zone = detectBcmVinZone(out);
  for (const vinOff of zone.vinOffsets) {
    if (vinOff + 19 > out.length) continue;
    for (let i = 0; i < 17; i++) out[vinOff + i] = enc[i];
    out[vinOff + 17] = (fullCrc >> 8) & 0xFF;
    out[vinOff + 18] = fullCrc & 0xFF;
  }
  for (const off of detectBcmPartialOffsets(out)) {
    if (off + BCM_PARTIAL_VIN_LEN + 2 > out.length) continue;
    for (let i = 0; i < BCM_PARTIAL_VIN_LEN; i++) out[off + i] = tail[i];
    out[off + BCM_PARTIAL_VIN_LEN]     = (tailCrc >> 8) & 0xFF;
    out[off + BCM_PARTIAL_VIN_LEN + 1] =  tailCrc       & 0xFF;
  }
  return out;
}

function RFHSection({samplePair, onSamplePairLoaded}) {
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
      <SamplePicker kinds={['RFH_EEE']} acceptSizes={[4096,2048]} onFile={handleIFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample RFHUB EEE"/>
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
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fmtOff(row.offset)}</td>
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
                  <span style={{fontSize:11,fontWeight:800,color:C.a4}}>SEC16 Slot {s.slot} @ {fmtOff(s.offset)}</span>
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
        <FileDropZone label="Re-upload the same RFHUB .bin to patch (must be 4096B Gen2)" onFile={handleAFile} fileName={aFile?.name} inputTestId="rfh-apply-input"/>
        <SamplePicker kinds={['RFH_EEE']} acceptSizes={[4096]} onFile={handleAFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample RFHUB EEE"/>
        <div style={{marginTop:10}}>
          <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN (17 chars)</div>
          <input value={newVin} maxLength={17} placeholder="Enter 17-character VIN" data-testid="rfh-apply-vin"
            onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
            style={{width:"100%",padding:"10px 14px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:15,fontWeight:700,letterSpacing:3,textAlign:"center",outline:"none",color:C.tx}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm}}>{newVin.length}/17</span>
            {newVin.length===17&&!vinValid&&<span style={{fontSize:11,color:C.er}}>Invalid VIN characters</span>}
          </div>
          {/* Task #488 — Charger LD trim/HP subtitle for the entered VIN. */}
          {vinValid&&<VinChargerSubtitle vin={newVin} dataTestId="immo-vin-decode" style={{marginTop:6}}/>}
        </div>
        <div style={{marginTop:10}}>
          <Btn onClick={doApply} disabled={!aFile||!vinValid||newVin.length!==17} full color={C.a2} data-testid="rfh-apply-btn">⚡ APPLY — Write VIN to 4 slots + Download</Btn>
          <div style={{marginTop:6,textAlign:"center"}}><DownloadCounter assetId={ASSET_IDS.immoRfhPatched}/></div>
        </div>
        {aMsg&&<div data-testid="rfh-apply-msg" style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:aMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(aMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:aMsg.startsWith("✓")?C.gn:C.er}}>{aMsg}</div>}
      </div>
    </Card>
  );
}

/* ─── GPEC2A (95320 SPI) helpers ─────────────────────────────────────── */

// Canonical four GPEC2A VIN slots — single source of truth in
// lib/parseModule.js (Task #443). Pre-#443 this file inlined a
// 3-slot list (0x0000/0x01F0/0x0224) which silently dropped the
// 0x0CE0 slot that #439 pinned as canonical, matching the
// "Write VIN to 4 slots" UI label.
const GPEC_VIN_OFFSETS = PCM_VIN_OFFSETS_GPEC2A;

export function extractGpecVin(data, off) {
  if (off + 17 > data.length) return null;
  let s = "";
  for (let i = 0; i < 17; i++) {
    const ch = String.fromCharCode(data[off + i]);
    if (!/[A-HJ-NPR-Z0-9]/.test(ch)) return null;
    s += ch;
  }
  return s;
}

export function parseGpec2a(data) {
  const sz = data.length;
  const validSz = sz === 4096;
  const slots = GPEC_VIN_OFFSETS.map((off, idx) => ({
    idx: idx+1, offset: off, vin: extractGpecVin(data, off)
  }));
  const consistent = slots.length === GPEC_VIN_OFFSETS.length && slots.every(s => s.vin) && slots.every(s => s.vin === slots[0].vin);
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

export function applyGpec2a(data, newVin, newKeyHex) {
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

function GPECSection({samplePair, onSamplePairLoaded}) {
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
      <SamplePicker kinds={['GPEC_EXT']} acceptSizes={[4096]} onFile={handleIFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample GPEC2A EXT"/>
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
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fmtOff(row.offset)}</td>
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
        <FileDropZone label="Re-upload the same 4KB GPEC2A .bin to patch" onFile={handleAFile} fileName={aFile?.name} inputTestId="gpec-apply-input"/>
        <SamplePicker kinds={['GPEC_EXT']} acceptSizes={[4096]} onFile={handleAFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample GPEC2A EXT"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN — optional</div>
            <input value={newVin} maxLength={17} placeholder="Leave blank to skip" data-testid="gpec-apply-vin"
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
          <Btn onClick={doApply} disabled={!aFile||(newVin.length>0&&!vinValid)||(newKey.length>0&&!keyValid)} full color={C.a2} data-testid="gpec-apply-btn">⚡ APPLY — Patch non-empty fields + Download</Btn>
          <div style={{fontSize:10,color:C.ts,marginTop:4,textAlign:"center"}}>Blank fields are not modified in the output file.</div>
          <div style={{marginTop:6,textAlign:"center"}}><DownloadCounter assetId={ASSET_IDS.immoGpecPatched}/></div>
        </div>
        {aMsg&&<div data-testid="gpec-apply-msg" style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:aMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(aMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:aMsg.startsWith("✓")?C.gn:C.er}}>{aMsg}</div>}
      </div>
    </Card>
  );
}

function BCMSection({samplePair, onSamplePairLoaded}) {
  const [iFile, setIFile] = useState(null);
  const [iData, setIData] = useState(null);
  const [iResult, setIResult] = useState(null);
  const [iErr, setIErr] = useState("");
  const [aFile, setAFile] = useState(null);
  const [aData, setAData] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [newSec16, setNewSec16] = useState("");
  const [aMsg, setAMsg] = useState("");

  const handleIFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      if (d.length !== 65536) {
        setIErr("Wrong size: " + d.length + " bytes (need exactly 65536 / 64KB DFLASH)");
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
      if (d.length !== 65536) { setAMsg("Wrong size: " + d.length + " bytes (need 65536)"); setAFile(null); setAData(null); return; }
      setAFile(f); setAData(d); setAMsg("");
    };
    r.readAsArrayBuffer(f);
  }, []);

  const sec16Valid = newSec16.length === 0 || (newSec16.length === 32 && /^[0-9A-Fa-f]{32}$/.test(newSec16));
  const vinValid = newVin.length === 0 || VIN_RE.test(newVin);

  const doApply = () => {
    if (!aData) return;
    if (newVin.length !== 17 || !VIN_RE.test(newVin)) { setAMsg("Enter a valid 17-character VIN before applying."); return; }
    let patched = applyBcmVin(aData, newVin);
    let sec16Note = "";
    if (newSec16.length === 32 && /^[0-9A-Fa-f]{32}$/.test(newSec16)) {
      const sec16Bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) sec16Bytes[i] = parseInt(newSec16.slice(i*2, i*2+2), 16);
      // writeBcmSec16Gen2 returns {bytes, splitPatched, ...} — keep just the
      // patched buffer so the subsequent dl() call hands a real Uint8Array
      // to the Blob constructor instead of stringifying the result object
      // (which would produce "[object Object]" — caught by the Task #493
      // auto-detect UI test).
      patched = writeBcmSec16Gen2(patched, sec16Bytes).bytes;
      sec16Note = " + SEC16";
      void logSec16Sync({
        vin: newVin || null,
        platform: newVin ? classifyPlatform({ vin: newVin }).platform : null,
        actionId: 'rfh-bcm-sec16-sync',
        target: 'BCM',
        verified: 'offline',
        notes: 'offline ImmoVINTab BCM patch (Gen2 split records)',
        detail: { sec16Hex: Array.from(sec16Bytes).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase() },
      });
    }
    const fn = aFile.name.replace(/(\.[^.]+)?$/, "_BCM_"+newVin+".bin");
    dl(patched, fn, ASSET_IDS.immoBcmPatched);
    setAMsg("✓ Patched & downloaded: " + fn + " (VIN" + sec16Note + ")");
  };

  const res = iResult;

  return (
    <Card>
      <SectionHeader icon="🚗" title={<><Tip word="BCM">BCM</Tip> — <Tip word="MPC560XB">MPC560XB</Tip> / MPC5606B_05B <Tip word="DFLASH">DFLASH</Tip> (64KB)</>} subtitle={<>4 full <Tip word="VIN">VIN</Tip> slots + <Tip word="CRC">CRC-16/CCITT-FALSE</Tip> · 4 partial-VIN slots (last 8 + CRC) · optional 16B <Tip word="SEC16">SEC16</Tip></>}/>

      <div style={{fontSize:11,fontWeight:900,color:C.sr,letterSpacing:2,marginBottom:8}}>PHASE 1 — INSPECT</div>
      <FileDropZone label="Drop 64KB BCM .bin file (MPC560XB DFLASH)" onFile={handleIFile} fileName={iFile?.name}/>
      <SamplePicker kinds={['BCM']} acceptSizes={[65536]} onFile={handleIFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample BCM"/>
      {iErr && <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:C.er+"10",color:C.er,fontSize:12,fontWeight:700}}>✗ {iErr}</div>}
      {iFile && !iErr && <div style={{marginTop:10}}><Btn onClick={()=>setIResult(parseBcmDflash(iData))} full color={C.sr}>🔍 Analyze File</Btn></div>}

      {res && (
        <div style={{marginTop:14}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            <Tag color={res.validSz?C.gn:C.wn}>{res.sz} bytes — {res.validSz?"64KB ✓":"SIZE WARN"}</Tag>
            <Tag color={C.sr}>Zone: {res.zone.label}</Tag>
            {res.mainVin && <Tag color={res.consistent?C.gn:C.wn}>{res.mainVin}</Tag>}
            {res.consistent
              ? <Tag color={C.gn}>VINs CONSISTENT ✓</Tag>
              : <Tag color={C.er}>VIN MISMATCH ✗</Tag>}
          </div>

          {/* Full VIN slots */}
          <div style={{overflowX:"auto",marginBottom:14}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["Slot","Offset","VIN (17B ASCII)","Stored CRC","Calc CRC","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
              <tbody>
                {res.slots.map(row=>(
                  <tr key={row.idx} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                    <td style={{padding:"7px 10px",fontWeight:800,color:C.sr}}>VIN {row.idx}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fmtOff(row.vinOffset)}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.vin?C.gn:C.er}}>{row.vin||"(empty / invalid)"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tm}}>{row.csStored!==null?"0x"+row.csStored.toString(16).toUpperCase().padStart(4,"0"):"—"}</td>
                    <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tm}}>{row.csCalc!==null?"0x"+row.csCalc.toString(16).toUpperCase().padStart(4,"0"):"—"}</td>
                    <td style={{padding:"7px 10px"}}><Badge ok={row.crcOk} label={row.crcOk?"CRC OK":"CRC FAIL"}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Partial VIN slots */}
          {res.partials.length>0 && (
            <div style={{overflowX:"auto",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:800,color:C.a4,marginBottom:6}}>Partial-VIN slots ({res.partials.length}) — last 8 chars + CRC16</div>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr>{["#","Offset","Tail (8B)","Stored","Calc","Status"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:"1.5px solid "+C.bd,fontSize:10,fontWeight:800,color:C.tm,textTransform:"uppercase",letterSpacing:.5}}>{h}</th>)}</tr></thead>
                <tbody>
                  {res.partials.map(row=>(
                    <tr key={row.idx} style={{borderBottom:"1px solid "+C.bd+"60"}}>
                      <td style={{padding:"7px 10px",fontWeight:800,color:C.a4}}>P{row.idx}</td>
                      <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.a3}}>{fmtOff(row.offset)}</td>
                      <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:12,color:row.tail?C.gn:C.er}}>{row.tail||"(invalid)"}</td>
                      <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tm}}>0x{row.csStored.toString(16).toUpperCase().padStart(4,"0")}</td>
                      <td style={{padding:"7px 10px",fontFamily:"'JetBrains Mono'",fontSize:11,color:C.tm}}>0x{row.csCalc.toString(16).toUpperCase().padStart(4,"0")}</td>
                      <td style={{padding:"7px 10px"}}><Badge ok={row.crcOk} label={row.crcOk?"CRC OK":"CRC FAIL"}/></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* SEC16 status */}
          {res.sec16 && (
            <div style={{padding:"10px 14px",borderRadius:10,background:C.c2,border:"1px solid "+C.bd}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <span style={{fontSize:11,fontWeight:800,color:C.a4}}>SEC16 (16B) — source: {res.sec16.source||"none"}</span>
                {res.sec16.bytes
                  ? <Badge ok={!res.sec16.blank} label={res.sec16.blank?"BLANK":"PRESENT ✓"}/>
                  : <Tag color={C.er}>NOT FOUND</Tag>}
              </div>
              {res.sec16.bytes && <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:res.sec16.blank?C.tm:C.a4}}>{hxb(res.sec16.bytes)}</div>}
            </div>
          )}
        </div>
      )}

      <div style={{marginTop:20,borderTop:"1.5px solid "+C.bd,paddingTop:16}}>
        <div style={{fontSize:11,fontWeight:900,color:C.a2,letterSpacing:2,marginBottom:8}}>PHASE 2 — APPLY</div>
        <div style={{fontSize:11,color:C.ts,marginBottom:8}}>VIN written to all 4 full slots + every detected partial slot · CRC-16/CCITT-FALSE re-stamped on each · optional SEC16 writes split (0x81A0/C0/E0) + mirror records</div>
        <FileDropZone label="Re-upload the same 64KB BCM .bin to patch" onFile={handleAFile} fileName={aFile?.name} inputTestId="bcm-apply-input"/>
        <SamplePicker kinds={['BCM']} acceptSizes={[65536]} onFile={handleAFile} onLoaded={onSamplePairLoaded} suggestedPair={samplePair} label="📦 Sample BCM"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:10}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW VIN (required)</div>
            <input value={newVin} maxLength={17} placeholder="17-char VIN" data-testid="bcm-apply-vin"
              onChange={e=>setNewVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newVin.length===17&&vinValid?C.gn:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:700,letterSpacing:2,textAlign:"center",outline:"none",color:C.tx}}/>
            <div style={{fontSize:11,fontWeight:800,color:newVin.length===17?C.gn:C.tm,marginTop:2}}>{newVin.length}/17</div>
          </div>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,marginBottom:4,letterSpacing:1}}>NEW SEC16 (32 hex digits = 16 bytes) — optional</div>
            <input value={newSec16} maxLength={32} placeholder="Leave blank to skip" data-testid="bcm-apply-sec16"
              onChange={e=>setNewSec16(e.target.value.toUpperCase().replace(/[^0-9A-F]/g,""))}
              style={{width:"100%",padding:"10px 12px",borderRadius:10,boxSizing:"border-box",border:"2px solid "+(newSec16.length===32&&sec16Valid?C.gn:newSec16.length>0&&!sec16Valid?C.er:C.bd),background:C.c2,fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:700,letterSpacing:1,outline:"none",color:C.tx}}/>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
              <span style={{fontSize:11,fontWeight:800,color:newSec16.length===32?C.gn:C.tm}}>{newSec16.length}/32</span>
              <span style={{fontSize:10,color:C.ts}}>Split (0x81A0/C0/E0) + mirror</span>
            </div>
          </div>
        </div>
        <div style={{marginTop:12}}>
          <Btn onClick={doApply} disabled={!aFile||newVin.length!==17||!vinValid||(newSec16.length>0&&!sec16Valid)} full color={C.a2} data-testid="bcm-apply-btn">⚡ APPLY — Rewrite all VIN copies + CRCs (+ SEC16)</Btn>
          <div style={{marginTop:6,textAlign:"center"}}><DownloadCounter assetId={ASSET_IDS.immoBcmPatched}/></div>
        </div>
        {aMsg&&<div data-testid="bcm-apply-msg" style={{marginTop:8,padding:"9px 12px",borderRadius:10,background:aMsg.startsWith("✓")?C.gn+"10":C.er+"10",border:"1px solid "+(aMsg.startsWith("✓")?C.gn+"25":C.er+"25"),fontSize:11,fontWeight:700,color:aMsg.startsWith("✓")?C.gn:C.er}}>{aMsg}</div>}
      </div>
    </Card>
  );
}

/* Auto-detect routing: classify a file by size + signature so the user can
 * drop ANY supported binary into the top-level zone and the tab points
 * them at the right inspect/apply panel. Returns one of:
 *   { kind:'BCM',   label:'BCM (MPC560XB / MPC5606B_05B DFLASH, 64KB)' }
 *   { kind:'GPEC',  label:'GPEC2A (PCM 95320 SPI EEPROM, 4KB)' }
 *   { kind:'RFH2',  label:'RFHUB Gen2 (4KB EEPROM)' }
 *   { kind:'RFH1',  label:'RFHUB Gen1 (2KB EEPROM)' }
 *   { kind:null,    label:'Unknown size (… bytes) — supported: 2KB / 4KB / 64KB' }
 *
 * The 4KB GPEC vs 4KB RFH-Gen2 disambiguation reads the GPEC SKIM byte
 * @ 0x0011 (a tightly-bounded 0x80 / 0x00 / unprogrammed value) and the
 * RFH-Gen2 VIN slot population @ 0x0EA5; either signature wins, falling
 * back to GPEC when neither pattern is convincing (the more common 4KB
 * upload). 64KB always routes to BCM, 2KB always routes to RFH Gen1. */
export function detectImmoFileKind(data) {
  const sz = data.length;
  if (sz === 65536) return { kind:'BCM', label:'BCM (MPC560XB / MPC5606B_05B DFLASH, 64KB)' };
  if (sz === 2048)  return { kind:'RFH1', label:'RFHUB Gen1 (2KB EEPROM)' };
  if (sz === 4096) {
    /* RFH-Gen2 signature: at least one 0x0EA5+ slot carries a populated
     * (non-0xFF/0x00) tail byte that decodes as a printable VIN char.
     * The four slot offsets all sit > 0x0EA0, so a GPEC2A 4KB image
     * (which has no records past ~0x03CE) leaves them all blank. */
    let rfhPopulated = 0;
    for (const off of RFH_VIN_OFFSETS) {
      if (off + 17 > sz) continue;
      let allBlank = true;
      for (let i = 0; i < 17; i++) {
        const b = data[off + i];
        if (b !== 0xFF && b !== 0x00) { allBlank = false; break; }
      }
      if (!allBlank) rfhPopulated++;
    }
    if (rfhPopulated > 0) return { kind:'RFH2', label:'RFHUB Gen2 (4KB EEPROM)' };
    /* GPEC2A signature: SKIM @ 0x0011 is 0x80 / 0x00, OR the 4 canonical
     * VIN slots carry plausible ASCII. */
    const skim = data[0x0011];
    if (skim === 0x80 || skim === 0x00) return { kind:'GPEC', label:'GPEC2A (PCM 95320 SPI EEPROM, 4KB)' };
    for (const off of PCM_VIN_OFFSETS_GPEC2A) {
      if (off + 17 > sz) continue;
      const b = data[off];
      if (b >= 0x30 && b <= 0x5A) return { kind:'GPEC', label:'GPEC2A (PCM 95320 SPI EEPROM, 4KB)' };
    }
    /* Indeterminate 4KB image — default to GPEC2A (the more common case)
     * and let the per-section validators surface any mismatch. */
    return { kind:'GPEC', label:'GPEC2A (PCM 95320 SPI EEPROM, 4KB)' };
  }
  return { kind:null, label:'Unknown size (' + sz + ' bytes) — supported: 2KB RFH Gen1 / 4KB GPEC2A or RFH Gen2 / 64KB BCM' };
}

function AutoDetectZone({onDetect}) {
  const [hit, setHit] = useState(null);
  const onFile = useCallback(f => {
    const r = new FileReader();
    r.onload = ev => {
      const d = new Uint8Array(ev.target.result);
      const det = detectImmoFileKind(d);
      setHit({ name: f.name, sz: d.length, ...det });
      if (onDetect) onDetect(det.kind);
    };
    r.readAsArrayBuffer(f);
  }, [onDetect]);
  const onClear = useCallback(() => {
    setHit(null);
    if (onDetect) onDetect(null);
  }, [onDetect]);
  return (
    <Card>
      <SectionHeader icon="🧭" title="Auto-Detect" subtitle={<>Drop any supported FCA <Tip word="EEPROM">EEPROM</Tip> dump (RFHUB Gen1/Gen2, GPEC2A PCM, or BCM <Tip word="DFLASH">DFLASH</Tip>) — this routes you to the matching inspect/apply panel below.</>}/>
      <FileDropZone label="Drop any supported .bin (2KB / 4KB / 64KB) — auto-classified by size + signature" onFile={onFile} fileName={hit?.name} inputTestId="auto-detect-input"/>
      {hit && (
        <div data-testid="auto-detect-result" style={{marginTop:10,padding:"10px 14px",borderRadius:10,background:hit.kind?C.gn+"10":C.er+"10",border:"1px solid "+(hit.kind?C.gn+"25":C.er+"25"),fontSize:12,fontWeight:700,color:hit.kind?C.gn:C.er,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div>
            {hit.kind
              ? <>✓ <span style={{fontWeight:900}}>{hit.label}</span> — routed to the <span style={{fontFamily:"'JetBrains Mono'"}}>{hit.kind === 'BCM' ? 'BCM' : hit.kind === 'GPEC' ? 'GPEC2A' : 'RFHUB'}</span> section below.</>
              : <>✗ {hit.label}</>}
          </div>
          <button data-testid="auto-detect-clear" onClick={onClear} style={{background:"transparent",border:"1px solid "+(hit.kind?C.gn:C.er)+"55",color:hit.kind?C.gn:C.er,borderRadius:8,padding:"4px 10px",fontSize:10,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>SHOW ALL</button>
        </div>
      )}
    </Card>
  );
}

/* Map the auto-detect kind to the section keys that should remain mounted.
 * When the AutoDetectZone has not been used yet (kind === null) all three
 * sections render so the tab still works as a manual three-section browser.
 * Once a file is classified, only the matching section is mounted — both
 * a workflow win (the user lands on the right panel) and a routing
 * regression guard (Task #493 UI test asserts the other section testids
 * disappear). The "SHOW ALL" button in the AutoDetectZone resets the kind
 * back to null so the user can switch sections without re-uploading. */
function visibleSectionsForKind(kind) {
  if (kind === 'BCM') return { rfh: false, gpec: false, bcm: true };
  if (kind === 'GPEC') return { rfh: false, gpec: true, bcm: false };
  if (kind === 'RFH1' || kind === 'RFH2') return { rfh: true, gpec: false, bcm: false };
  return { rfh: true, gpec: true, bcm: true };
}

export default function ImmoVINTab() {
  const [pdfBusy, setPdfBusy] = useState(false);
  // Lifted to the tab root so that loading a paired sample in the RFH section
  // surfaces a "Load matching pair" hint in the GPEC section, and vice versa.
  const [samplePair, setSamplePair] = useState(null);
  const [detectedKind, setDetectedKind] = useState(null);
  const onSamplePairLoaded = useCallback(f => setSamplePair(f?.pair || null), []);
  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try { await buildOnePagerPDF(IMMO_VIN_REF); }
    catch (e) { console.error(e); alert('PDF build failed: ' + e.message); }
    finally { setPdfBusy(false); }
  };
  const visible = visibleSectionsForKind(detectedKind);
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
      <AutoDetectZone onDetect={setDetectedKind}/>
      {visible.rfh && (
        <div data-testid="rfh-section">
          <RFHSection samplePair={samplePair} onSamplePairLoaded={onSamplePairLoaded}/>
        </div>
      )}
      {visible.gpec && (
        <div data-testid="gpec-section">
          <GPECSection samplePair={samplePair} onSamplePairLoaded={onSamplePairLoaded}/>
        </div>
      )}
      {visible.bcm && (
        <div data-testid="bcm-section">
          <BCMSection samplePair={samplePair} onSamplePairLoaded={onSamplePairLoaded}/>
        </div>
      )}
    </div>
  );
}
