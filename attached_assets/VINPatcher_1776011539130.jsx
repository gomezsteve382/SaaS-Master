import { useState, useCallback, useMemo, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
// CRC ALGORITHMS
// ═══════════════════════════════════════════════════════════════════════
function crc16ccitt(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function crc8poly26(data) {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x26) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

// ═══════════════════════════════════════════════════════════════════════
// VIN VALIDATION
// ═══════════════════════════════════════════════════════════════════════
const VIN_TRANSLITERATION = {
  A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,
  S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  "0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,
};
const VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const VIN_CHECK_MAP = {0:"0",1:"1",2:"2",3:"3",4:"4",5:"5",6:"6",7:"7",8:"8",9:"9",10:"X"};

const WMI_DB = {
  "1C4":"Chrysler · United States","2C3":"Dodge · Canada","3C7":"RAM · Mexico",
  "1C6":"RAM · United States","2C4":"Chrysler · Canada","1J4":"Jeep · United States",
  "1J8":"Jeep · United States","3D7":"RAM · Mexico","2D5":"Dodge · Canada",
  "1B3":"Dodge · United States","2B3":"Dodge · Canada","3C6":"RAM · Mexico",
};

function validateVin(vin) {
  if (vin.length !== 17) return { valid: false, error: "Must be 17 characters" };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return { valid: false, error: "Invalid chars (I, O, Q not allowed)" };
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = VIN_TRANSLITERATION[vin[i].toUpperCase()];
    if (v === undefined) return { valid: false, error: `Bad char at pos ${i+1}` };
    sum += v * VIN_WEIGHTS[i];
  }
  const expectedCheck = VIN_CHECK_MAP[sum % 11];
  const checkDigit = vin[8].toUpperCase();
  const wmi = vin.slice(0,3).toUpperCase();
  const yearCode = vin[9].toUpperCase();
  const yearMap = {A:2010,B:2011,C:2012,D:2013,E:2014,F:2015,G:2016,H:2017,J:2018,K:2019,L:2020,M:2021,N:2022,P:2023,R:2024,S:2025};
  const year = yearMap[yearCode] || (parseInt(yearCode) >= 0 ? 2030 + parseInt(yearCode) : "?");
  return {
    valid: checkDigit === expectedCheck,
    error: checkDigit !== expectedCheck ? `Check digit: expected ${expectedCheck}, got ${checkDigit}` : null,
    checkDigit: expectedCheck,
    wmi, vds: vin.slice(3,9).toUpperCase(), vis: vin.slice(9).toUpperCase(),
    manufacturer: WMI_DB[wmi] || "Unknown",
    year,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FILE ANALYSIS — AUTO-DETECT VIN LOCATIONS + CHECKSUMS
// ═══════════════════════════════════════════════════════════════════════
function analyzeFile(data) {
  const size = data.length;
  let fileType = "unknown";
  if (size === 65536 || size === 131072) fileType = "bcm_dflash";
  else if (size === 1048576) fileType = "bcm_cflash";
  else if (size === 8192 || size === 16384) fileType = "rfhub_95640";
  else if (size === 4096) fileType = "gpec2a";

  const vinPattern = /^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/;
  const fullVins = [];
  const partialVins = [];

  // Scan for full 17-byte ASCII VIN patterns
  for (let i = 0; i < data.length - 18; i++) {
    const chunk = data.slice(i, i + 17);
    let allPrint = true;
    for (let j = 0; j < 17; j++) { if (chunk[j] < 0x20 || chunk[j] > 0x7e) { allPrint = false; break; } }
    if (!allPrint) continue;
    const str = String.fromCharCode(...chunk);
    if (!vinPattern.test(str)) continue;

    // Validate VIN check digit — skip part numbers / false positives
    const validation = validateVin(str);
    if (!validation.valid) continue; // Filter out part numbers like 68XXXXXXXX

    if (fileType === "rfhub_95640") {
      // 95640: checksum is 1 byte BEFORE VIN, CRC8 poly=0x26
      const storedCk = i > 0 ? data[i - 1] : 0;
      const calcCk = crc8poly26(chunk);
      fullVins.push({
        offset: i, vin: str, type: "full",
        crcOffset: i - 1, crcLen: 1, crcAlgo: "crc8",
        storedCrc: storedCk, calcCrc: calcCk,
        valid: storedCk === calcCk, validation,
      });
    } else if (fileType === "gpec2a") {
      // GPEC2A: VIN stored raw — no per-VIN checksum
      fullVins.push({
        offset: i, vin: str, type: "full",
        crcOffset: -1, crcLen: 0, crcAlgo: "none",
        storedCrc: 0, calcCrc: 0,
        valid: true, validation,
      });
    } else {
      // BCM D-FLASH / C-FLASH: CRC16-CCITT at VIN+17 (2 bytes BE)
      const storedCrc = (data[i + 17] << 8) | data[i + 18];
      const calcCrc = crc16ccitt(chunk);
      fullVins.push({
        offset: i, vin: str, type: "full",
        crcOffset: i + 17, crcLen: 2, crcAlgo: "crc16",
        storedCrc, calcCrc,
        valid: storedCrc === calcCrc, validation,
      });
    }
  }

  // For BCM D-FLASH: also find partial VIN records (last 8 chars + CRC16)
  if ((fileType === "bcm_dflash" || fileType === "bcm_cflash") && fullVins.length > 0) {
    // Use the first VIN with valid CRC as the reference, fall back to first VIN
    const refSlot = fullVins.find(v => v.valid) || fullVins[0];
    const refVin = refSlot.vin;
    const tail8 = refVin.slice(9); // last 8 chars (VIS serial section)
    const tail8Bytes = new Uint8Array(tail8.split("").map(c => c.charCodeAt(0)));
    for (let i = 0; i < data.length - 10; i++) {
      let match = true;
      for (let j = 0; j < 8; j++) { if (data[i + j] !== tail8Bytes[j]) { match = false; break; } }
      if (!match) continue;
      // Skip if this is part of a full VIN match
      const isFullVin = fullVins.some(v => i >= v.offset && i < v.offset + 17);
      if (isFullVin) continue;
      const storedCrc = (data[i + 8] << 8) | data[i + 9];
      const calcCrc = crc16ccitt(data.slice(i, i + 8));
      // Only include if CRC actually validates — avoids random byte matches
      if (storedCrc !== calcCrc) continue;
      partialVins.push({
        offset: i, vin: tail8, type: "partial",
        crcOffset: i + 8, crcLen: 2, crcAlgo: "crc16",
        storedCrc, calcCrc,
        valid: true,
      });
    }
  }

  return { fileType, size, fullVins, partialVins };
}

// ═══════════════════════════════════════════════════════════════════════
// PATCH ENGINE
// ═══════════════════════════════════════════════════════════════════════
function patchFile(data, analysis, newVin) {
  const patched = new Uint8Array(data);
  const newVinBytes = new Uint8Array(newVin.split("").map(c => c.charCodeAt(0)));
  const patchLog = [];

  // Patch full VIN locations
  for (const slot of analysis.fullVins) {
    // Write VIN
    for (let i = 0; i < 17; i++) patched[slot.offset + i] = newVinBytes[i];

    if (slot.crcAlgo === "crc16") {
      const newCrc = crc16ccitt(newVinBytes);
      patched[slot.crcOffset] = (newCrc >> 8) & 0xff;
      patched[slot.crcOffset + 1] = newCrc & 0xff;
      patchLog.push({ offset: slot.offset, type: "full", oldVin: slot.vin, crc: newCrc, crcHex: `0x${newCrc.toString(16).toUpperCase().padStart(4, "0")}` });
    } else if (slot.crcAlgo === "crc8") {
      const newCrc = crc8poly26(newVinBytes);
      patched[slot.crcOffset] = newCrc;
      patchLog.push({ offset: slot.offset, type: "full", oldVin: slot.vin, crc: newCrc, crcHex: `0x${newCrc.toString(16).toUpperCase().padStart(2, "0")}` });
    } else {
      // GPEC2A / no-checksum: VIN written, no CRC to update
      patchLog.push({ offset: slot.offset, type: "full", oldVin: slot.vin, crc: null, crcHex: "N/A (no checksum)" });
    }
  }

  // Patch partial VIN locations
  const newTail8 = newVin.slice(9);
  const newTail8Bytes = new Uint8Array(newTail8.split("").map(c => c.charCodeAt(0)));
  for (const slot of analysis.partialVins) {
    for (let i = 0; i < 8; i++) patched[slot.offset + i] = newTail8Bytes[i];
    const newCrc = crc16ccitt(newTail8Bytes);
    patched[slot.crcOffset] = (newCrc >> 8) & 0xff;
    patched[slot.crcOffset + 1] = newCrc & 0xff;
    patchLog.push({ offset: slot.offset, type: "partial", oldVin: slot.vin, crc: newCrc, crcHex: `0x${newCrc.toString(16).toUpperCase().padStart(4, "0")}` });
  }

  return { patched, patchLog };
}

// ═══════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════

const FILE_TYPE_LABELS = {
  bcm_dflash: "BCM D-FLASH",
  bcm_cflash: "BCM C-FLASH",
  rfhub_95640: "RFHUB / FCA 95640",
  gpec2a: "GPEC2A EXT EEPROM",
  unknown: "Unknown",
};

export default function VINPatcher() {
  const [fileName, setFileName] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [newVin, setNewVin] = useState("");
  const [patchResult, setPatchResult] = useState(null);
  const [patchedData, setPatchedData] = useState(null);
  const fileRef = useRef(null);

  const handleFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPatchResult(null);
    setPatchedData(null);
    const reader = new FileReader();
    reader.onload = () => {
      const data = new Uint8Array(reader.result);
      setFileData(data);
      const result = analyzeFile(data);
      setAnalysis(result);
      if (result.fullVins.length > 0) setNewVin(result.fullVins[0].vin);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const vinValidation = useMemo(() => {
    if (!newVin || newVin.length !== 17) return null;
    return validateVin(newVin);
  }, [newVin]);

  const handlePatch = useCallback(() => {
    if (!fileData || !analysis || !newVin || newVin.length !== 17) return;
    const { patched, patchLog } = patchFile(fileData, analysis, newVin.toUpperCase());
    setPatchedData(patched);
    setPatchResult(patchLog);
    // Re-analyze patched data to show updated checksums
    setAnalysis(analyzeFile(patched));
    setFileData(patched);
  }, [fileData, analysis, newVin]);

  const handleDownload = useCallback(() => {
    const data = patchedData || fileData;
    if (!data || !fileName) return;
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(/\.(bin|BIN)$/i, `_VIN_CRC_${newVin}.$1`);
    a.click();
    URL.revokeObjectURL(url);
  }, [patchedData, fileData, fileName, newVin]);

  const srt = "#dc2626";

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#e5e5e5", fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace" }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg, #0f0f0f 0%, #1a0808 100%)`, borderBottom: `2px solid ${srt}`, padding: "32px 24px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, background: srt, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 900 }}>V</div>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 900, letterSpacing: 2, margin: 0, textTransform: "uppercase" }}>VIN Patcher</h1>
              <p style={{ fontSize: 11, color: "#666", margin: "2px 0 0" }}>BCM D-FLASH · RFHUB 95640 · GPEC2A — Auto-detect + CRC recalculation</p>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 24px 64px" }}>
        {/* Upload */}
        <div
          onClick={() => fileRef.current?.click()}
          style={{ border: "2px dashed #333", borderRadius: 12, padding: 32, textAlign: "center", cursor: "pointer", marginBottom: 24, transition: "border-color 0.2s" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = srt}
          onMouseLeave={e => e.currentTarget.style.borderColor = "#333"}
        >
          <input ref={fileRef} type="file" accept=".bin,.BIN,.eee,.EEE" onChange={handleFile} style={{ display: "none" }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: "#999" }}>{fileName || "Upload EEPROM Dump"}</div>
          <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>BCM (64KB / 128KB) · RFHUB (4KB / 8KB) · GPEC2A (4KB)</div>
          {analysis && (
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
              <span style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "4px 12px", fontSize: 11, color: srt, fontWeight: 700 }}>
                {FILE_TYPE_LABELS[analysis.fileType]}
              </span>
              <span style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "4px 12px", fontSize: 11 }}>
                {(analysis.size / 1024).toFixed(0)} KB
              </span>
              <span style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "4px 12px", fontSize: 11 }}>
                {analysis.fullVins.length} full + {analysis.partialVins.length} partial VINs
              </span>
            </div>
          )}
        </div>

        {analysis && analysis.fullVins.length > 0 && (
          <>
            {/* VIN Locations */}
            <div style={{ background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: srt, margin: "0 0 16px", letterSpacing: 1, textTransform: "uppercase" }}>VIN Locations Detected</h2>
              <div style={{ display: "grid", gap: 8 }}>
                {analysis.fullVins.map((v, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, background: "#0d0d0d", borderRadius: 8, padding: "10px 14px", border: `1px solid ${v.valid ? "#1a3a1a" : "#3a1a1a"}` }}>
                    <span style={{ fontSize: 10, color: "#555", minWidth: 70 }}>0x{v.offset.toString(16).toUpperCase().padStart(4, "0")}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.5, flex: 1 }}>{v.vin}</span>
                    <span style={{ fontSize: 10, color: v.crcAlgo === "none" ? "#fbbf24" : v.valid ? "#4ade80" : "#ef4444", fontWeight: 600 }}>
                      {v.crcAlgo === "none" ? "No checksum" :
                       v.crcAlgo === "crc16" ? `CRC16 0x${v.storedCrc.toString(16).toUpperCase().padStart(4, "0")}` :
                       `CRC8 0x${v.storedCrc.toString(16).toUpperCase().padStart(2, "0")}`}
                      {v.crcAlgo !== "none" && (v.valid ? " ✓" : ` ✗ (expected ${v.crcAlgo === "crc16" ? `0x${v.calcCrc.toString(16).toUpperCase().padStart(4, "0")}` : `0x${v.calcCrc.toString(16).toUpperCase().padStart(2, "0")}`})`)}
                    </span>
                    <span style={{ fontSize: 9, background: v.type === "full" ? "#1a1a3a" : "#2a1a2a", color: v.type === "full" ? "#818cf8" : "#c084fc", padding: "2px 8px", borderRadius: 4 }}>
                      {v.type}
                    </span>
                  </div>
                ))}
                {analysis.partialVins.map((v, i) => (
                  <div key={`p${i}`} style={{ display: "flex", alignItems: "center", gap: 12, background: "#0d0d0d", borderRadius: 8, padding: "10px 14px", border: `1px solid ${v.valid ? "#1a3a1a" : "#3a1a1a"}` }}>
                    <span style={{ fontSize: 10, color: "#555", minWidth: 70 }}>0x{v.offset.toString(16).toUpperCase().padStart(4, "0")}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.5, flex: 1, color: "#a78bfa" }}>········{v.vin}</span>
                    <span style={{ fontSize: 10, color: v.valid ? "#4ade80" : "#ef4444", fontWeight: 600 }}>
                      CRC 0x{v.storedCrc.toString(16).toUpperCase().padStart(4, "0")}{v.valid ? " ✓" : ` ✗`}
                    </span>
                    <span style={{ fontSize: 9, background: "#2a1a2a", color: "#c084fc", padding: "2px 8px", borderRadius: 4 }}>partial</span>
                  </div>
                ))}
              </div>
            </div>

            {/* New VIN Input */}
            <div style={{ background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: srt, margin: "0 0 12px", letterSpacing: 1, textTransform: "uppercase" }}>New VIN</h2>
              <input
                value={newVin}
                onChange={e => { setNewVin(e.target.value.toUpperCase()); setPatchResult(null); }}
                maxLength={17}
                placeholder="Enter 17-character VIN"
                style={{
                  width: "100%", background: "#0a0a0a", border: `2px solid ${vinValidation?.valid ? "#22c55e" : newVin.length === 17 ? "#ef4444" : "#333"}`,
                  borderRadius: 8, padding: "14px 16px", color: "#fff", fontSize: 18, fontWeight: 800,
                  letterSpacing: 4, textAlign: "center", fontFamily: "inherit", outline: "none", boxSizing: "border-box",
                }}
              />
              {vinValidation && (
                <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ color: "#999" }}>WMI: <b style={{ color: "#fff" }}>{vinValidation.wmi}</b> — {vinValidation.manufacturer}</span>
                  <span style={{ color: "#999" }}>Check digit: <b style={{ color: vinValidation.valid ? "#4ade80" : "#ef4444" }}>{vinValidation.checkDigit}</b></span>
                  <span style={{ color: "#999" }}>Year: <b style={{ color: "#fff" }}>{vinValidation.year}</b></span>
                  {vinValidation.error && <span style={{ color: "#ef4444" }}>{vinValidation.error}</span>}
                </div>
              )}

              {/* CRC Preview */}
              {newVin.length === 17 && (
                <div style={{ marginTop: 16, background: "#0d0d0d", borderRadius: 8, padding: 14, border: "1px solid #1a1a1a" }}>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Checksum Preview</div>
                  <div style={{ display: "flex", gap: 20, fontSize: 12, flexWrap: "wrap" }}>
                    {analysis.fileType === "rfhub_95640" ? (
                      <span>CRC-8 (poly 0x26): <b style={{ color: "#fbbf24" }}>0x{crc8poly26(new Uint8Array(newVin.split("").map(c => c.charCodeAt(0)))).toString(16).toUpperCase().padStart(2, "0")}</b></span>
                    ) : analysis.fileType === "gpec2a" ? (
                      <span style={{ color: "#fbbf24" }}>No checksum — VIN-only write</span>
                    ) : (
                      <>
                        <span>Full VIN CRC-16: <b style={{ color: "#fbbf24" }}>0x{crc16ccitt(new Uint8Array(newVin.split("").map(c => c.charCodeAt(0)))).toString(16).toUpperCase().padStart(4, "0")}</b></span>
                        {analysis.partialVins.length > 0 && (
                          <span>Partial CRC-16: <b style={{ color: "#a78bfa" }}>0x{crc16ccitt(new Uint8Array(newVin.slice(9).split("").map(c => c.charCodeAt(0)))).toString(16).toUpperCase().padStart(4, "0")}</b></span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <button
                onClick={handlePatch}
                disabled={!newVin || newVin.length !== 17}
                style={{
                  flex: 1, padding: "14px 20px", background: srt, color: "#fff", border: "none", borderRadius: 8,
                  fontSize: 13, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer",
                  opacity: !newVin || newVin.length !== 17 ? 0.4 : 1, fontFamily: "inherit",
                }}
              >
                Patch VIN & Recalculate CRC
              </button>
              {patchedData && (
                <button
                  onClick={handleDownload}
                  style={{
                    padding: "14px 24px", background: "#1a3a1a", color: "#4ade80", border: "1px solid #22c55e44",
                    borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                    letterSpacing: 1, textTransform: "uppercase",
                  }}
                >
                  Download
                </button>
              )}
            </div>

            {/* Patch Results */}
            {patchResult && (
              <div style={{ background: "#0d1a0d", border: "1px solid #22c55e33", borderRadius: 12, padding: 20, marginBottom: 20 }}>
                <h2 style={{ fontSize: 13, fontWeight: 700, color: "#4ade80", margin: "0 0 12px", letterSpacing: 1, textTransform: "uppercase" }}>
                  ✓ Patched {patchResult.length} location{patchResult.length !== 1 ? "s" : ""}
                </h2>
                {patchResult.map((p, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#86efac", marginBottom: 4 }}>
                    0x{p.offset.toString(16).toUpperCase().padStart(4, "0")} — {p.type} VIN — CRC → {p.crcHex}
                  </div>
                ))}
              </div>
            )}

            {/* Algorithm Info */}
            <div style={{ background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20 }}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: "#666", margin: "0 0 12px", letterSpacing: 1, textTransform: "uppercase" }}>Algorithm Details</h2>
              <div style={{ fontSize: 11, color: "#555", lineHeight: 1.8 }}>
                {analysis.fileType === "rfhub_95640" ? (
                  <>
                    <div><b style={{ color: "#999" }}>Algorithm:</b> CRC-8 poly=0x26, init=0x00</div>
                    <div><b style={{ color: "#999" }}>Layout:</b> [1-byte CRC] [17-byte VIN] — checksum BEFORE VIN</div>
                    <div><b style={{ color: "#999" }}>Slots:</b> VIN1 @ 0x275 (cksum @ 0x274), VIN2 @ 0x288 (cksum @ 0x287)</div>
                  </>
                ) : analysis.fileType === "gpec2a" ? (
                  <>
                    <div><b style={{ color: "#999" }}>Algorithm:</b> None — raw VIN storage, no per-VIN checksum</div>
                    <div><b style={{ color: "#999" }}>Layout:</b> [17-byte VIN] at 3 locations (0x0000, 0x01F0, 0x0224)</div>
                    <div><b style={{ color: "#999" }}>Note:</b> GPEC2A Continental EXT EEPROM stores VIN without CRC protection</div>
                  </>
                ) : (
                  <>
                    <div><b style={{ color: "#999" }}>Algorithm:</b> CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflection</div>
                    <div><b style={{ color: "#999" }}>Full VIN layout:</b> [17-byte VIN] [2-byte CRC BE] — 4 slots, 0x20 spacing</div>
                    <div><b style={{ color: "#999" }}>Partial VIN layout:</b> [8-byte tail] [2-byte CRC BE] — 2 slots, 0x18 spacing</div>
                    <div><b style={{ color: "#999" }}>Global checksum:</b> None — bytes 0xFFFE-0xFFFF untouched</div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {analysis && analysis.fullVins.length === 0 && (
          <div style={{ textAlign: "center", padding: 48, color: "#555" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>No VIN locations detected</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>This file may not contain VIN data, or the format is unsupported</div>
          </div>
        )}

        {!analysis && (
          <div style={{ textAlign: "center", padding: 48, color: "#444", fontSize: 12 }}>
            Upload a BCM D-FLASH, RFHUB 95640, or GPEC2A binary to begin
          </div>
        )}
      </div>
    </div>
  );
}
