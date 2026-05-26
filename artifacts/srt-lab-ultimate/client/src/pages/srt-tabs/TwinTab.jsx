import React, { useState, useCallback, useRef } from "react";
const chargerImg = "";
import { C } from "@/lib/srt/constants.js";
import { Card, Tag, Btn } from "@/lib/srt/ui.jsx";
import { crc16, rfhSec16Cs, rfhGen2DetectMagic, rfhGen2VinCs, RFH_GEN2_VIN_CS_KNOWN_MAGICS } from "@/lib/srt/crc.js";
import { ASSET_IDS, trackDownload } from "@/lib/srt/downloadAssets.js";
import { DownloadCounter } from "@/lib/srt/useDownloadCount.jsx";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const hxb = arr => Array.from(arr).map(b => b.toString(16).toUpperCase().padStart(2,"0")).join(" ");
const fO  = n => "0x" + n.toString(16).toUpperCase().padStart(4,"0");
const dl  = (data, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], {type:"application/octet-stream"}));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
  trackDownload(ASSET_IDS.twinPaired);
};

/* ─── BCM (MPC5606B_05B, 65536 bytes) ────────────────────────────────────── */
const BCM_VIN_PRIMARY    = [0x5328, 0x5348, 0x5368, 0x5388];
const BCM_VIN_SECONDARY  = [0x0698, 0x06B8, 0x06D8, 0x06F8, 0x0718, 0x0738];
const BCM_VIN_PARTIAL    = [0x4098, 0x40B0];   // 8-byte tail + CRC16
const BCM_SEC16_OFFSETS  = [0x40C9, 0x40F1];
// BCM 0x81xx split copies (bytes 0-6 at copy+0..6, gap copy+7..10 untouched, bytes 7-15 at copy+11..19)
const BCM_SEC16_SPLIT_COPIES = [0x81A9, 0x81C9, 0x81E9];

function parseBcm(data, filename) {
  if (data.length !== 65536) return null;

  const vins = BCM_VIN_PRIMARY.map((off, i) => {
    const raw = data.slice(off, off + 17);
    const vin = Array.from(raw).map(b => String.fromCharCode(b)).join("");
    const csStored = (data[off + 17] << 8) | data[off + 18];
    const csCalc   = crc16(raw);
    return { slot: i + 1, offset: off, vin, csStored, csCalc, csOk: csStored === csCalc };
  });

  // Partial VINs: 8-byte tail (chars 10–17 of VIN) + 2-byte CRC16
  const partialVins = BCM_VIN_PARTIAL.map((off, i) => {
    const raw = data.slice(off, off + 8);
    let tail = "", ok = true;
    for (let j = 0; j < 8; j++) {
      const b = raw[j];
      if (b < 0x20 || b > 0x7E) { ok = false; break; }
      tail += String.fromCharCode(b);
    }
    const csStored = (data[off + 8] << 8) | data[off + 9];
    const csCalc   = crc16(raw);
    return { slot: i + 1, offset: off, tail: ok ? tail : "(invalid)", raw: Array.from(raw), csStored, csCalc, csOk: ok && csStored === csCalc };
  });

  const sec16Copies = BCM_SEC16_OFFSETS.map((off, i) => {
    const raw = data.slice(off, off + 16);
    const hex = hxb(raw);
    // CRC stored at off+19/off+20 (bytes off+16..+18 are fixed gap 8F FF FF)
    const csStored = (data[off + 19] << 8) | data[off + 20];
    // CRC16 CCITT over 20 bytes: [data[off-1], data[off..off+15], data[off+16], data[off+17], data[off+18]]
    const crcInput = Array.from(data.slice(off - 1, off + 19));
    const csCalc   = crc16(crcInput);
    const csOk     = csStored === csCalc;
    return { label: `Mirror ${i + 1}`, offset: off, raw: Array.from(raw), hex, csStored, csCalc, csOk };
  });

  const secMatch    = sec16Copies.length > 1 && sec16Copies[0].hex === sec16Copies[1].hex;
  const secAllCsOk  = sec16Copies.every(m => m.csOk);

  const sec16Raw    = sec16Copies[0].raw;
  const sec16Hex    = hxb(sec16Raw);
  const sec16RfhRaw = [...sec16Raw].reverse();
  const sec16RfhHex = hxb(sec16RfhRaw);
  const pcmSec6Hex  = hxb(sec16RfhRaw.slice(0, 6));

  return {
    type: "MPC5606B_05B", filename, size: data.length,
    vins, partialVins, sec16Copies, secMatch, secAllCsOk,
    sec16Hex, sec16RfhHex, pcmSec6Hex,
  };
}

function applyBcmFromRfh(bcmData, rfhInfo) {
  const out = new Uint8Array(bcmData);
  const vin = rfhInfo.vins[0].vin;
  const enc = Array.from(vin).map(c => c.charCodeAt(0));

  // compute CRC16 of VIN bytes
  const cs = crc16(enc);
  const csHi = (cs >> 8) & 0xFF;
  const csLo = cs & 0xFF;

  // Write to primary slots
  for (const off of BCM_VIN_PRIMARY) {
    for (let i = 0; i < 17; i++) out[off + i] = enc[i];
    out[off + 17] = csHi;
    out[off + 18] = csLo;
  }
  // Write to secondary slots (only overwrite bytes 0..18, preserve 19..31)
  for (const off of BCM_VIN_SECONDARY) {
    for (let i = 0; i < 17; i++) out[off + i] = enc[i];
    out[off + 17] = csHi;
    out[off + 18] = csLo;
  }
  // Write to partial VIN slots (8-byte tail + CRC16)
  const tail8 = enc.slice(9); // last 8 chars of 17-char VIN
  const tailCs = crc16(tail8);
  for (const off of BCM_VIN_PARTIAL) {
    for (let i = 0; i < 8; i++) out[off + i] = tail8[i];
    out[off + 8] = (tailCs >> 8) & 0xFF;
    out[off + 9] = tailCs & 0xFF;
  }

  // SEC16: reverse RFH_SEC16 → BCM_SEC16
  // Structure: off+0..+15 = 16 data bytes; off+16..+18 = fixed gap (8F FF FF, do NOT overwrite);
  //            off+19/+20 = CRC16 CCITT of 20 bytes starting at off-1
  const rfhSec16 = rfhInfo.sec16Slots[0].raw;
  const bcmSec16 = [...rfhSec16].reverse();
  for (const off of BCM_SEC16_OFFSETS) {
    for (let i = 0; i < 16; i++) out[off + i] = bcmSec16[i];
    // keep gap bytes at off+16..+18 as-is (read from existing file)
    const crcInput = Array.from(out.slice(off - 1, off + 19));
    const bcmSec16Crc = crc16(crcInput);
    out[off + 19] = (bcmSec16Crc >> 8) & 0xFF;
    out[off + 20] = bcmSec16Crc & 0xFF;
  }

  // Write 3 additional 0x81xx split copies (no CRC bytes):
  //   bytes 0-6 → copy_off + 0..6
  //   bytes 7-15 → copy_off + 11..19
  //   copy_off + 7..10 (fixed gap 04 04 00 14) is NOT touched
  for (const copyOff of BCM_SEC16_SPLIT_COPIES) {
    for (let i = 0; i <= 6; i++) out[copyOff + i] = bcmSec16[i];
    for (let i = 7; i <= 15; i++) out[copyOff + 4 + i] = bcmSec16[i]; // +4 = offset past the 4-byte gap
  }

  return out;
}

/* ─── RFH Gen2 (MC9S12X Type 1, 4096 bytes) ──────────────────────────────── */
const RFH_VIN_OFFSETS  = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const RFH_SEC16_OFFSETS = [0x050E, 0x0522];
function parseRfhGen2(data, filename) {
  if (data.length !== 4096) return null;
  let magic = 0xDB; // default; auto-detected below if a valid slot is found

  const vins = RFH_VIN_OFFSETS.map((off, i) => {
    const rawStored = data.slice(off, off + 17);
    // VIN stored reversed
    const vinBytes = Array.from(rawStored).reverse();
    const vin = vinBytes.map(b => String.fromCharCode(b)).join("");
    const csStored = data[off + 17];
    const csCalc   = rfhGen2VinCs(rawStored, magic);
    return { slot: i + 1, offset: off, vin, rawStored: Array.from(rawStored), csStored, csCalc, csOk: csStored === csCalc };
  });

  // Auto-detect VIN CS magic from first slot with a non-trivial stored checksum
  const validSlot = vins.find(v => v.csStored !== 0x00 && v.csStored !== 0xFF);
  if (validSlot) {
    magic = rfhGen2DetectMagic(validSlot.rawStored, validSlot.csStored);
    for (const v of vins) {
      v.csCalc = rfhGen2VinCs(v.rawStored, magic);
      v.csOk   = v.csStored === v.csCalc;
    }
  }

  const sec16Slots = RFH_SEC16_OFFSETS.map((off, i) => {
    const raw = Array.from(data.slice(off, off + 16));
    const hex = hxb(raw);
    const csStored0 = data[off + 16];
    const csStored1 = data[off + 17];
    const csVal = rfhSec16Cs(raw);
    const csCalc0 = (csVal >> 8) & 0xFF; const csCalc1 = csVal & 0xFF;
    const csOk = csStored0 === csCalc0 && csStored1 === csCalc1;
    return { slot: i + 1, offset: off, raw, hex, csStored0, csStored1, csCalc0, csCalc1, csOk };
  });

  const slotsMatch = sec16Slots.length === 2 && sec16Slots[0].hex === sec16Slots[1].hex;
  const sec16Hex    = sec16Slots[0].hex;
  const sec16BcmRaw = [...sec16Slots[0].raw].reverse();
  const sec16BcmHex = hxb(sec16BcmRaw);

  return {
    type: "MC9S12X", filename, size: data.length,
    vins, sec16Slots, slotsMatch, sec16Hex, sec16BcmHex,
    vinMagic: magic,
  };
}

function applyRfhFromBcm(rfhData, bcmInfo, magic = 0xDB) {
  const out = new Uint8Array(rfhData);
  const vin = bcmInfo.vins[0].vin;
  const enc = Array.from(vin).map(c => c.charCodeAt(0));
  const rev = [...enc].reverse();

  const cs = rfhGen2VinCs(rev, magic);
  for (const off of RFH_VIN_OFFSETS) {
    for (let i = 0; i < 17; i++) out[off + i] = rev[i];
    out[off + 17] = cs;
  }

  // SEC16: reverse BCM_SEC16 → RFH_SEC16
  const bcmSec16 = bcmInfo.sec16Copies[0].raw;
  const rfhSec16 = [...bcmSec16].reverse();
  const csVal = rfhSec16Cs(rfhSec16);
  for (const off of RFH_SEC16_OFFSETS) {
    for (let i = 0; i < 16; i++) out[off + i] = rfhSec16[i];
    out[off + 16] = (csVal >> 8) & 0xFF;
    out[off + 17] = csVal & 0xFF;
  }

  return out;
}

/* ─── PCM / GPEC2A (4096 / 8192 / 16384 bytes) ───────────────────────────── */
const PCM_VALID_SIZES = new Set([4096, 8192, 16384]);
function parsePcm(data, filename) {
  if (!PCM_VALID_SIZES.has(data.length)) return null;
  const vinRaw = data.slice(0, 17);
  const vin = Array.from(vinRaw).map(b => String.fromCharCode(b)).join("");
  const vinOk = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  const sec6 = Array.from(data.slice(0x3C8, 0x3C8 + 6));
  const sec6Hex = hxb(sec6);
  return { type: "GPEC2A", filename, size: data.length, vin: vinOk ? vin : null, sec6, sec6Hex };
}

function applyPcmFromBcm(pcmData, bcmInfo) {
  const out = new Uint8Array(pcmData);
  const sec16Rev = [...bcmInfo.sec16Copies[0].raw].reverse();
  const sec6 = sec16Rev.slice(0, 6);
  for (let i = 0; i < 6; i++) out[0x3C8 + i] = sec6[i];
  return out;
}

/* ─── UI sub-components ───────────────────────────────────────────────────── */
function CsBadge({ ok, small }) {
  const style = {
    display: "inline-block", padding: small ? "1px 6px" : "2px 8px",
    borderRadius: 6, fontSize: small ? 9 : 10, fontWeight: 800, letterSpacing: .5,
    background: ok ? C.gn + "20" : C.er + "20",
    color: ok ? C.gn : C.er, marginLeft: 4,
  };
  return <span style={style}>{ok ? "CS OK" : "CS FAIL"}</span>;
}

function MatchBadge({ ok }) {
  const style = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 10px", borderRadius: 8, fontSize: 11, fontWeight: 800,
    background: ok ? C.gn + "15" : C.wn + "20",
    color: ok ? C.gn : C.wn, border: `1px solid ${ok ? C.gn + "30" : C.wn + "40"}`,
  };
  return <span style={style}>{ok ? "✓ MATCH" : "⚠ MISMATCH"}</span>;
}

function FileDropZone({ label, hint, onFile, fileName, accept = ".bin,.BIN" }) {
  const inputRef = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onClick={() => inputRef.current.click()}
      style={{
        border: `2px dashed ${drag ? C.sr : C.sr + "40"}`, borderRadius: 12,
        padding: "18px 20px", cursor: "pointer", textAlign: "center",
        background: drag ? C.sr + "08" : C.c2, transition: "all .2s",
      }}
    >
      <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 24, marginBottom: 4 }}>📂</div>
      {fileName
        ? <div style={{ fontSize: 12, fontWeight: 800, color: C.sr }}>{fileName}</div>
        : <div style={{ fontSize: 12, color: C.ts }}>{label}</div>}
      {hint && <div style={{ fontSize: 10, color: C.tm, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function MonoHex({ hex, color = C.a3 }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color, letterSpacing: .3 }}>
      {hex}
    </span>
  );
}

function SectionTitle({ icon, text, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        background: "linear-gradient(135deg,#D32F2F1A,#D32F2F33)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 18, border: "1.5px solid #D32F2F25",
      }}>{icon}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 900, color: C.tx }}>{text}</div>
        {sub && <div style={{ fontSize: 10, color: C.ts }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ─── BCM Card ───────────────────────────────────────────────────────────── */
function BcmCard({ info }) {
  const allCsOk = info.vins.every(v => v.csOk);
  return (
    <Card style={{ marginBottom: 14 }}>
      <SectionTitle icon="🧠" text="BCM — MPC5606B_05B" sub={`${info.filename}  ·  65536 bytes`} />

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, textTransform: "uppercase", letterSpacing: .6 }}>VIN — 4 Primary Copies</div>
        {info.vins.map(v => (
          <div key={v.slot} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", minWidth: 58 }}>{fO(v.offset)}</span>
            <MonoHex hex={v.vin} color={C.a1} />
            <CsBadge ok={v.csOk} small />
            <span style={{ fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
              stored={v.csStored.toString(16).toUpperCase().padStart(4,"0")} calc={v.csCalc.toString(16).toUpperCase().padStart(4,"0")}
            </span>
          </div>
        ))}
        <Tag color={allCsOk ? C.gn : C.er}>{allCsOk ? "All CS OK" : "CS Errors Found"}</Tag>
      </div>

      {/* Partial VINs (tail-only slots at 0x4098 / 0x40B0) */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, textTransform: "uppercase", letterSpacing: .6 }}>Partial VINs — Tail ×2</div>
        {info.partialVins.map(p => (
          <div key={p.slot} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", minWidth: 58 }}>{fO(p.offset)}</span>
            <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a2, letterSpacing: .3 }}>…{p.tail}</span>
            <CsBadge ok={p.csOk} small />
            <span style={{ fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
              stored={p.csStored.toString(16).toUpperCase().padStart(4,"0")} calc={p.csCalc.toString(16).toUpperCase().padStart(4,"0")}
            </span>
          </div>
        ))}
        <Tag color={C.tm}>8-char tail · CRC16</Tag>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, textTransform: "uppercase", letterSpacing: .6 }}>SEC16 — {info.sec16Copies.length} Mirror Copies</div>
        {info.sec16Copies.map(m => (
          <div key={m.offset} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", minWidth: 58 }}>{fO(m.offset)}</span>
              <span style={{ fontSize: 10, color: C.tm }}>{m.label}</span>
              <CsBadge ok={m.csOk} small />
              <span style={{ fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
                stored={m.csStored.toString(16).toUpperCase().padStart(4,"0")} calc={m.csCalc.toString(16).toUpperCase().padStart(4,"0")}
              </span>
            </div>
            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a4, paddingLeft: 66 }}>
              {m.hex}
            </div>
          </div>
        ))}
        <Tag color={info.secMatch ? C.gn : C.er}>{info.secMatch ? "Mirrors Match ✓" : "Mirror Mismatch!"}</Tag>
        {" "}<Tag color={info.secAllCsOk ? C.gn : C.er}>{info.secAllCsOk ? "All CRC OK ✓" : "CRC Errors!"}</Tag>

        <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}` }}>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700 }}>BCM format (main)</div>
          <MonoHex hex={info.sec16Hex} color={C.a4} />
          <div style={{ fontSize: 10, color: C.ts, marginTop: 8, marginBottom: 4, fontWeight: 700 }}>RFH view (reversed)</div>
          <MonoHex hex={info.sec16RfhHex} color={C.a3} />
          <div style={{ fontSize: 10, color: C.ts, marginTop: 8, marginBottom: 4, fontWeight: 700 }}>PCM SEC6 (first 6 bytes of RFH view)</div>
          <MonoHex hex={info.pcmSec6Hex} color={C.a2} />
        </div>
      </div>
    </Card>
  );
}

/* ─── RFH VIN Variant Badge ──────────────────────────────────────────────── */
const RFH_MAGIC_LABELS = { 0xDB: "Redeye (0xDB)", 0x87: "Legacy (0x87)" };
function VinVariantBadge({ magic }) {
  const known  = RFH_GEN2_VIN_CS_KNOWN_MAGICS.includes(magic);
  const label  = known
    ? RFH_MAGIC_LABELS[magic] || `0x${magic.toString(16).toUpperCase().padStart(2,"0")}`
    : `0x${magic.toString(16).toUpperCase().padStart(2,"0")}`;
  const bg     = known ? C.a3 + "18" : C.wn + "20";
  const border = known ? C.a3 + "35" : C.wn + "50";
  const color  = known ? C.a3 : C.wn;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 9px", borderRadius: 20, fontSize: 10, fontWeight: 800,
      background: bg, color, border: `1px solid ${border}`, marginLeft: 8,
    }}>
      {!known && <span style={{ fontSize: 11 }}>⚠</span>}
      {known ? "✓" : ""} {label}
      {!known && <span style={{ fontSize: 9, fontWeight: 600, opacity: .85 }}> — unknown variant</span>}
    </span>
  );
}

/* ─── RFH Card ───────────────────────────────────────────────────────────── */
function RfhCard({ info }) {
  const allVinOk = info.vins.every(v => v.csOk);
  return (
    <Card style={{ marginBottom: 14 }}>
      <SectionTitle icon="📡" text="RFHUB — MC9S12X Type 1 Gen2" sub={`${info.filename}  ·  4096 bytes`} />

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.ts, textTransform: "uppercase", letterSpacing: .6 }}>VIN — 4 Slots (byte-reversed)</span>
          {info.vinMagic != null && <VinVariantBadge magic={info.vinMagic} />}
        </div>
        {info.vins.map(v => (
          <div key={v.slot} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", minWidth: 58 }}>{fO(v.offset)}</span>
            <MonoHex hex={v.vin} color={C.a1} />
            <CsBadge ok={v.csOk} small />
            <span style={{ fontSize: 9, color: C.tm, fontFamily: "'JetBrains Mono'" }}>
              stored={v.csStored.toString(16).toUpperCase().padStart(2,"0")} calc={v.csCalc.toString(16).toUpperCase().padStart(2,"0")}
            </span>
          </div>
        ))}
        <Tag color={allVinOk ? C.gn : C.er}>{allVinOk ? "All CS OK" : "CS Errors Found"}</Tag>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 8, textTransform: "uppercase", letterSpacing: .6 }}>
          SEC16 — 2 Slots
          {info.slotsMatch ? <Tag color={C.gn}>Slots Match ✓</Tag> : <Tag color={C.er}>Slots Differ!</Tag>}
        </div>
        {info.sec16Slots.map(s => (
          <div key={s.slot} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ fontSize: 10, color: C.tm, fontFamily: "'JetBrains Mono'", minWidth: 58 }}>{fO(s.offset)}</span>
              <span style={{ fontSize: 10, color: C.tm }}>Slot {s.slot}</span>
              <CsBadge ok={s.csOk} small />
            </div>
            <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, fontWeight: 700, color: C.a3, paddingLeft: 66 }}>
              {s.hex}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}` }}>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4, fontWeight: 700 }}>RFH format</div>
          <MonoHex hex={info.sec16Hex} color={C.a3} />
          <div style={{ fontSize: 10, color: C.ts, marginTop: 8, marginBottom: 4, fontWeight: 700 }}>BCM view (reversed)</div>
          <MonoHex hex={info.sec16BcmHex} color={C.a4} />
          <div style={{ fontSize: 10, color: C.tm, marginTop: 6, fontStyle: "italic" }}>
            Rule: reverse bytes of the entire block.
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ─── PCM Card ───────────────────────────────────────────────────────────── */
function PcmCard({ info }) {
  return (
    <Card style={{ marginBottom: 14 }}>
      <SectionTitle icon="⚙️" text="PCM — GPEC2A" sub={`${info.filename}  ·  ${info.size} bytes`} />
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .6 }}>Current VIN</div>
        <MonoHex hex={info.vin || "(none)"} color={C.a1} />
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .6 }}>SEC6 @ 0x03C8</div>
        <MonoHex hex={info.sec6Hex} color={C.a2} />
      </div>
    </Card>
  );
}

/* ─── Status Banners ─────────────────────────────────────────────────────── */
function PairedBanner() {
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      background: "linear-gradient(135deg, #001a0a 0%, #003318 50%, #001a0a 100%)",
      borderRadius: 16, padding: "20px 24px", marginBottom: 14,
      minHeight: 160,
      border: "2px solid #00C85350",
      boxShadow: "0 0 30px #00C85320, inset 0 0 60px #00C85308",
      display: "flex", alignItems: "center",
    }}>
      {/* Road lines animation */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 3,
        background: "repeating-linear-gradient(90deg, #FFB30080 0px, #FFB30080 30px, transparent 30px, transparent 60px)",
        animation: "roadScroll 0.8s linear infinite",
      }} />
      {/* Speed lines */}
      {[15, 35, 55, 70].map((top, i) => (
        <div key={i} style={{
          position: "absolute", top: `${top}%`, right: 0,
          width: 60 + i * 20, height: 1,
          background: `linear-gradient(90deg, transparent, #00C853${30 + i * 10})`,
          animation: `speedLine ${0.4 + i * 0.15}s linear infinite`,
          opacity: 0.6,
        }} />
      ))}
      {/* Charger photo */}
      <div style={{
        position: "absolute", right: 0, top: "50%",
        width: "min(400px, 45%)", height: 170,
        overflow: "hidden",
        animation: "chargerBounce 0.6s ease-in-out infinite alternate",
        filter: "drop-shadow(0 0 18px #00C85370)",
        borderRadius: "0 14px 14px 0",
        maskImage: "linear-gradient(to right, transparent 0%, black 20%)",
        WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 20%)",
      }}>
        <img
          src={chargerImg}
          alt="Dodge Charger Hellcat"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 45%",
          }}
        />
      </div>
      {/* Text */}
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 28, filter: "drop-shadow(0 0 8px #00C85380)" }}>🔗</span>
          <span style={{
            fontSize: 22, fontWeight: 900, color: "#00C853",
            textShadow: "0 0 20px #00C85340",
            letterSpacing: 2, textTransform: "uppercase",
          }}>PAIRED</span>
        </div>
        <div style={{ fontSize: 12, color: "#00C85390", fontWeight: 600 }}>
          VIN and SEC16 match across all modules — ready to flash
        </div>
      </div>
      <style>{`
        @keyframes roadScroll {
          from { background-position-x: 0; }
          to { background-position-x: -60px; }
        }
        @keyframes speedLine {
          from { transform: translateX(0); opacity: 0.6; }
          to { transform: translateX(-200px); opacity: 0; }
        }
        @keyframes chargerBounce {
          from { transform: translateY(-50%) translateX(0); }
          to { transform: translateY(-52%) translateX(-3px); }
        }
        @keyframes smoke {
          from { transform: translateX(0) scale(1); opacity: 0.15; }
          to { transform: translateX(-20px) scale(2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function MismatchBanner() {
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      background: "linear-gradient(135deg, #1a0005 0%, #330011 50%, #1a0005 100%)",
      borderRadius: 16, padding: "20px 24px", marginBottom: 14,
      border: "2px solid #FF174450",
      boxShadow: "0 0 30px #FF174420",
      animation: "mismatchPulse 2s ease-in-out infinite",
    }}>
      {/* Warning stripes */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 4,
        background: "repeating-linear-gradient(90deg, #FF1744 0px, #FF1744 20px, #FFB300 20px, #FFB300 40px)",
      }} />
      {/* Broken chain icon */}
      <div style={{
        position: "absolute", right: 30, top: "50%", transform: "translateY(-50%)",
        fontSize: 48, opacity: 0.3, filter: "drop-shadow(0 0 10px #FF174440)",
      }}>🔓</div>
      {/* Text */}
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 28 }}>⛓️‍💥</span>
          <span style={{
            fontSize: 22, fontWeight: 900, color: "#FF1744",
            textShadow: "0 0 20px #FF174440",
            letterSpacing: 2, textTransform: "uppercase",
          }}>MISMATCH</span>
        </div>
        <div style={{ fontSize: 12, color: "#FF8A80", fontWeight: 600 }}>
          Modules are NOT paired — VIN, SEC16, or SEC6 differ between loaded modules
        </div>
        <div style={{ fontSize: 11, color: "#FF174480", fontWeight: 500, marginTop: 4 }}>
          Apply sync to fix, or load matching files
        </div>
      </div>
      <style>{`
        @keyframes mismatchPulse {
          0%, 100% { box-shadow: 0 0 30px #FF174420; }
          50% { box-shadow: 0 0 50px #FF174435; }
        }
      `}</style>
    </div>
  );
}

/* ─── Comparison Table ───────────────────────────────────────────────────── */
function CompareTable({ bcm, rfh, pcm, previewPaired }) {
  const vinMatch   = bcm.vins[0].vin === rfh.vins[0].vin;
  const sec16Match = bcm.sec16Hex === rfh.sec16BcmHex;
  const sec6Match  = pcm ? bcm.pcmSec6Hex === pcm.sec6Hex : null;

  const allOk = vinMatch && sec16Match && (pcm ? sec6Match : true);

  const rowStyle = { display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.bd}` };
  const labelStyle = { fontSize: 11, fontWeight: 800, color: C.ts, minWidth: 80 };
  const valStyle = { fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx, flex: 1, wordBreak: "break-all" };

  return (
    <Card style={{ marginBottom: 14 }}>
      {(previewPaired || allOk) ? <PairedBanner /> : <MismatchBanner />}
      <div style={{ marginBottom: 16 }}>
        <SectionTitle icon="🔀" text="Cross-Module Comparison" sub="VIN · SEC16 · SEC6" />
      </div>

      <div style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${C.bd}` }}>
        <div style={{ background: C.c2, padding: "8px 14px", display: "grid", gridTemplateColumns: "90px 1fr 1fr 80px", gap: 8, fontSize: 10, fontWeight: 800, color: C.tm, textTransform: "uppercase", letterSpacing: .5 }}>
          <span>Check</span><span>BCM</span><span>RFH / PCM</span><span>Status</span>
        </div>

        {/* VIN row */}
        <div style={{ padding: "10px 14px", display: "grid", gridTemplateColumns: "90px 1fr 1fr 80px", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.ts }}>VIN</span>
          <MonoHex hex={bcm.vins[0].vin} />
          <MonoHex hex={rfh.vins[0].vin} />
          <MatchBadge ok={vinMatch} />
        </div>

        {/* SEC16 row */}
        <div style={{ padding: "10px 14px", display: "grid", gridTemplateColumns: "90px 1fr 1fr 80px", gap: 8, alignItems: "start", borderTop: `1px solid ${C.bd}` }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.ts, paddingTop: 2 }}>SEC16</span>
          <div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>BCM format</div>
            <MonoHex hex={bcm.sec16Hex} color={C.a4} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>RFH BCM-view (reversed)</div>
            <MonoHex hex={rfh.sec16BcmHex} color={C.a4} />
          </div>
          <MatchBadge ok={sec16Match} />
        </div>

        {/* SEC6 row (if PCM loaded) */}
        {pcm && (
          <div style={{ padding: "10px 14px", display: "grid", gridTemplateColumns: "90px 1fr 1fr 80px", gap: 8, alignItems: "center", borderTop: `1px solid ${C.bd}` }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: C.ts }}>PCM SEC6</span>
            <div>
              <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>Derived (BCM→PCM)</div>
              <MonoHex hex={bcm.pcmSec6Hex} color={C.a2} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: C.tm, marginBottom: 2 }}>PCM stored @ 0x03C8</div>
              <MonoHex hex={pcm.sec6Hex} color={C.a2} />
            </div>
            <MatchBadge ok={sec6Match} />
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── Apply Panel ─────────────────────────────────────────────────────────── */
function ApplyPanel({ bcm, rfh, pcm, bcmData, rfhData, pcmData }) {
  const [applied, setApplied] = useState(null);

  function doRfhToBcm() {
    const out = applyBcmFromRfh(bcmData, rfh);
    const name = "BCM_SYCNED_" + bcm.filename;
    dl(out, name);
    setApplied("rfh→bcm");
  }

  function doBcmToRfh() {
    const out = applyRfhFromBcm(rfhData, bcm, rfh.vinMagic);
    const name = "RFH_SYCNED_" + rfh.filename;
    dl(out, name);
    setApplied("bcm→rfh");
  }

  function doBcmToPcm() {
    if (!pcm) return;
    const out = applyPcmFromBcm(pcmData, bcm);
    const name = "PCM_SYCNED_" + pcm.filename;
    dl(out, name);
    setApplied("bcm→pcm");
  }

  const btnRow = { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 };

  return (
    <Card style={{ marginBottom: 14 }}>
      <SectionTitle icon="⚡" text="Apply — Bidirectional Sync" sub="Files stay in memory — no re-upload needed" />
      <div style={btnRow}>
        <Btn onClick={doRfhToBcm} color={C.a3}>
          📥 Import RFH → BCM (download twinned BCM)
        </Btn>
        <Btn onClick={doBcmToRfh} color={C.a4}>
          📤 Import BCM → RFH (download twinned RFH)
        </Btn>
        {pcm && (
          <Btn onClick={doBcmToPcm} color={C.a2}>
            🔑 Import BCM → PCM SEC6 (download twinned PCM)
          </Btn>
        )}
      </div>
      <div style={{ marginTop: 8 }}><DownloadCounter assetId={ASSET_IDS.twinPaired}/></div>
      {applied && (
        <div style={{ marginTop: 12, padding: "8px 14px", borderRadius: 8, background: C.gn + "10", fontSize: 12, fontWeight: 700, color: C.gn, border: `1px solid ${C.gn}30` }}>
          ✓ Twinned file downloaded —{" "}
          {{
            "rfh→bcm": "BCM updated from RFH data",
            "bcm→rfh": "RFH updated from BCM data",
            "bcm→pcm": "PCM SEC6 updated from BCM",
          }[applied]}
        </div>
      )}
      <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}` }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .5 }}>Derivation Rules</div>
        <div style={{ fontSize: 11, color: C.tm, lineHeight: 1.7, fontFamily: "'JetBrains Mono'" }}>
          RFH_SEC16 = reverse(BCM_SEC16)<br />
          PCM_SEC6 = RFH_SEC16[0:6] = reverse(BCM_SEC16)[0:6]
        </div>
      </div>
    </Card>
  );
}

/* ─── Main Tab ─────────────────────────────────────────────────────────────── */
export default function TwinTab() {
  const [bcmFile, setBcmFile] = useState(null);
  const [bcmData, setBcmData] = useState(null);
  const [rfhFile, setRfhFile] = useState(null);
  const [rfhData, setRfhData] = useState(null);
  const [pcmFile, setPcmFile] = useState(null);
  const [pcmData, setPcmData] = useState(null);

  const [bcmInfo, setBcmInfo] = useState(null);
  const [rfhInfo, setRfhInfo] = useState(null);
  const [pcmInfo, setPcmInfo] = useState(null);

  const [err, setErr] = useState("");
  const [inspected, setInspected] = useState(false);
  const [previewPaired, setPreviewPaired] = useState(false);

  const loadFile = useCallback((f, setter, dataSetter) => {
    const r = new FileReader();
    r.onload = ev => {
      dataSetter(new Uint8Array(ev.target.result));
      setter(f);
      setInspected(false);
    };
    r.readAsArrayBuffer(f);
  }, []);

  function handleInspect() {
    setErr(""); setInspected(false);
    const errors = [];

    if (!bcmData || bcmData.length !== 65536)
      errors.push("BCM must be a 65536-byte MPC5606B full flash dump.");
    if (!rfhData || rfhData.length !== 4096)
      errors.push("RFH must be a 4096-byte MC9S12X Gen2 EEPROM dump.");
    if (pcmData && !PCM_VALID_SIZES.has(pcmData.length))
      errors.push("PCM must be a GPEC2A EEPROM dump (4096, 8192, or 16384 bytes).");

    if (errors.length) { setErr(errors.join(" ")); return; }

    const bcm = parseBcm(bcmData, bcmFile.name);
    const rfh = parseRfhGen2(rfhData, rfhFile.name);
    const pcm = pcmData ? parsePcm(pcmData, pcmFile.name) : null;

    if (!bcm) { setErr("BCM parse failed — unexpected file format."); return; }
    if (!rfh) { setErr("RFH parse failed — unexpected file format."); return; }

    setBcmInfo(bcm);
    setRfhInfo(rfh);
    setPcmInfo(pcm);
    setInspected(true);
  }

  function handleReset() {
    setBcmFile(null); setBcmData(null);
    setRfhFile(null); setRfhData(null);
    setPcmFile(null); setPcmData(null);
    setBcmInfo(null); setRfhInfo(null); setPcmInfo(null);
    setErr(""); setInspected(false); setPreviewPaired(false);
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* header */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: "linear-gradient(135deg,#D32F2F,#FF5252)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, boxShadow: "0 4px 16px rgba(211,47,47,0.3)",
            }}>🔗</div>
            <div>
              <div style={{ fontFamily: "'Righteous'", fontSize: 22, color: C.tx, letterSpacing: 1 }}>Security Byte Matcher</div>
              <div style={{ fontSize: 10, color: C.ts, letterSpacing: .5 }}>BCM ↔ RFHUB ↔ PCM — 2017 Dodge Charger / Challenger</div>
            </div>
          </div>
          <button
            onClick={() => setPreviewPaired(p => !p)}
            title={previewPaired ? "Exit preview — return to file-based status" : "Preview the PAIRED banner without loading files"}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px", borderRadius: 8, cursor: "pointer",
              fontSize: 11, fontWeight: 700, letterSpacing: .4,
              border: `1.5px solid ${previewPaired ? "#00C853" : C.bd}`,
              background: previewPaired ? "#00C85318" : "transparent",
              color: previewPaired ? "#00C853" : C.ts,
              transition: "all 0.2s",
            }}
          >
            {previewPaired ? "✕ Exit Preview" : "👁 Preview PAIRED"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: C.ts, maxWidth: 700, lineHeight: 1.6 }}>
          Synchronise VIN and SEC16 across BCM (MPC5606B_05B), RFHUB (MC9S12X Type 1 Gen2), and PCM (GPEC2A).
          All operations are fully client-side. No re-upload needed after Inspect.
        </div>
      </div>

      {/* Preview banner — shown even without files when toggle is on */}
      {previewPaired && !inspected && <PairedBanner />}

      {/* Phase 1: load files */}
      <Card style={{ marginBottom: 14 }}>
        <SectionTitle icon="📂" text="1 — Load Files" sub="BCM required · RFH required · PCM optional" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .6 }}>BCM file (.bin)</div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 6 }}>Full flash dump — 65536 bytes</div>
            <FileDropZone
              label="Drop BCM .bin here"
              onFile={f => loadFile(f, setBcmFile, setBcmData)}
              fileName={bcmFile?.name}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .6 }}>RFH file (.bin/.eprom)</div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 6 }}>MC9S12X Gen2 — 4096 bytes</div>
            <FileDropZone
              label="Drop RFH .bin here"
              accept=".bin,.BIN,.eprom"
              onFile={f => loadFile(f, setRfhFile, setRfhData)}
              fileName={rfhFile?.name}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, textTransform: "uppercase", letterSpacing: .6 }}>PCM file — optional (.bin)</div>
            <div style={{ fontSize: 9, color: C.tm, marginBottom: 6 }}>GPEC2A EEPROM — 8192 bytes</div>
            <FileDropZone
              label="Drop GPEC2A .bin here (optional)"
              onFile={f => loadFile(f, setPcmFile, setPcmData)}
              fileName={pcmFile?.name}
            />
          </div>
        </div>

        {err && (
          <div style={{ padding: "8px 14px", borderRadius: 8, background: C.er + "10", fontSize: 12, fontWeight: 700, color: C.er, marginBottom: 10 }}>
            ⚠ {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={handleInspect} disabled={!bcmData || !rfhData}>
            🔍 Inspect BCM / RFH
          </Btn>
          <Btn onClick={handleReset} outline>
            Clean / Reset
          </Btn>
        </div>

        {!inspected && (
          <div style={{ fontSize: 10, color: C.tm, marginTop: 10 }}>
            Tip: If you refresh the page the state will be lost. Run Inspect again.
          </div>
        )}
      </Card>

      {/* Phase 2: inspection results */}
      {inspected && bcmInfo && rfhInfo && (
        <>
          {/* overall status — gated on actual comparison results */}
          {(() => {
            const vinMatch   = bcmInfo.vins[0].vin === rfhInfo.vins[0].vin;
            const sec16Match = bcmInfo.sec16Hex === rfhInfo.sec16BcmHex;
            const sec6Match  = pcmInfo ? bcmInfo.pcmSec6Hex === pcmInfo.sec6Hex : true;
            const allOk = vinMatch && sec16Match && sec6Match;
            return (previewPaired || allOk) ? <PairedBanner /> : <MismatchBanner />;
          })()}

          {/* BCM + RFH cards side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 0 }}>
            <BcmCard info={bcmInfo} />
            <RfhCard info={rfhInfo} />
          </div>

          {/* PCM card (full width if present) */}
          {pcmInfo && <PcmCard info={pcmInfo} />}

          {/* Comparison table */}
          <CompareTable bcm={bcmInfo} rfh={rfhInfo} pcm={pcmInfo} previewPaired={previewPaired} />

          {/* Apply buttons */}
          <ApplyPanel
            bcm={bcmInfo} rfh={rfhInfo} pcm={pcmInfo}
            bcmData={bcmData} rfhData={rfhData} pcmData={pcmData}
          />
        </>
      )}

      {!inspected && !bcmData && !rfhData && (
        <div style={{ textAlign: "center", padding: 48, color: C.tm, fontSize: 13 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔗</div>
          Load a BCM (65 KB) and RFH (4 KB) file above, then click <strong>Inspect</strong>.
        </div>
      )}
    </div>
  );
}
