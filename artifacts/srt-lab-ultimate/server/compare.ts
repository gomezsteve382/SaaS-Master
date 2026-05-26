import { nanoid } from "nanoid";
import { recalculateAllCrcs, formatCrcReport } from "./crc-engine.js";

// ─── Known Security Byte Regions ─────────────────────────────────────
// These are the critical pairing/security byte locations extracted from
// CDA6, AlphaOBD, and SRT Lab reverse engineering intelligence.

export interface SecurityRegion {
  name: string;
  module: string;
  offset: number;
  length: number;
  description: string;
  pairingRule: "straight" | "reversed" | "xor" | "mirror_16" | "copy" | "independent";
  pairingPartner?: string; // Which module this pairs with
  partnerOffset?: number;  // Offset in the partner module
  critical: boolean;       // If mismatch = NO BUS / brick
}

export const SECURITY_REGIONS: SecurityRegion[] = [
  // BCM Security Regions
  {
    name: "BCM PIN Storage (SEC16)",
    module: "BCM",
    offset: 0x838,
    length: 4,
    description: "4-digit vehicle PIN stored in BCM 95640 EEPROM. Used for security access level 0x01.",
    pairingRule: "independent",
    critical: true,
  },
  {
    name: "BCM Secret Key (DID 0xF1A0)",
    module: "BCM",
    offset: 0xF1A0,
    length: 16,
    description: "16-byte AES secret key for module-to-module pairing. Must match RFHUB secret key.",
    pairingRule: "straight",
    pairingPartner: "RFHUB",
    partnerOffset: 0xF1A0,
    critical: true,
  },
  {
    name: "BCM SKIM Verification",
    module: "BCM",
    offset: 0x01A0,
    length: 9,
    description: "SKIM pairing verification bytes. REVERSED copy of RFHUB SKIM bytes.",
    pairingRule: "reversed",
    pairingPartner: "RFHUB",
    partnerOffset: 0x01A0,
    critical: true,
  },
  {
    name: "BCM VIN Storage",
    module: "BCM",
    offset: 0x160,
    length: 17,
    description: "Vehicle Identification Number stored in BCM EEPROM.",
    pairingRule: "straight",
    pairingPartner: "RFHUB",
    partnerOffset: 0x160,
    critical: true,
  },
  {
    name: "BCM VIN CRC",
    module: "BCM",
    offset: 0x1F0,
    length: 2,
    description: "CRC-16 checksum for BCM VIN block.",
    pairingRule: "independent",
    critical: true,
  },
  {
    name: "BCM Immobilizer Status",
    module: "BCM",
    offset: 0x840,
    length: 2,
    description: "Immobilizer learn/pair status flags.",
    pairingRule: "independent",
    critical: true,
  },

  // RFHUB Security Regions
  {
    name: "RFHUB SKIM Pairing",
    module: "RFHUB",
    offset: 0x01A0,
    length: 9,
    description: "SKIM verification fields. Must be REVERSE of BCM SKIM bytes for valid pairing.",
    pairingRule: "reversed",
    pairingPartner: "BCM",
    partnerOffset: 0x01A0,
    critical: true,
  },
  {
    name: "RFHUB VIN (Reversed Byte Order)",
    module: "RFHUB",
    offset: 0x160,
    length: 17,
    description: "VIN stored in reversed byte order in RFHUB EEPROM. Must match BCM VIN when reversed.",
    pairingRule: "reversed",
    pairingPartner: "BCM",
    partnerOffset: 0x160,
    critical: true,
  },
  {
    name: "RFHUB Secret Key",
    module: "RFHUB",
    offset: 0xF1A0,
    length: 16,
    description: "16-byte secret key. Must match BCM Secret Key (DID 0xF1A0) exactly.",
    pairingRule: "straight",
    pairingPartner: "BCM",
    partnerOffset: 0xF1A0,
    critical: true,
  },
  {
    name: "RFHUB CRC",
    module: "RFHUB",
    offset: 0x1F0,
    length: 4,
    description: "CRC-16 checksum for RFHUB VIN block. Dual CRC at 0x1F0 and 0x1F2.",
    pairingRule: "independent",
    critical: true,
  },
  {
    name: "RFHUB Key Fob Slots",
    module: "RFHUB",
    offset: 0x200,
    length: 40,
    description: "Key fob transponder pairing data. 5 slots x 8 bytes each.",
    pairingRule: "independent",
    critical: false,
  },

  // PCM Security Regions
  {
    name: "PCM VIN Storage",
    module: "PCM",
    offset: 0x160,
    length: 17,
    description: "PCM VIN location. Must match BCM VIN for immobilizer sync.",
    pairingRule: "straight",
    pairingPartner: "BCM",
    partnerOffset: 0x160,
    critical: true,
  },
  {
    name: "PCM Calibration ID",
    module: "PCM",
    offset: 0x400,
    length: 16,
    description: "PCM calibration/software version identifier.",
    pairingRule: "independent",
    critical: false,
  },

  // SGW Security Regions
  {
    name: "SGW XTEA Key",
    module: "SGW",
    offset: 0x100,
    length: 16,
    description: "128-bit XTEA key for Security Gateway authentication. Blocks all unauthorized writes.",
    pairingRule: "independent",
    critical: true,
  },

  // GPEC Security Regions
  {
    name: "GPEC VIN",
    module: "GPEC",
    offset: 0x160,
    length: 17,
    description: "GPEC2/GPEC2A VIN storage location.",
    pairingRule: "straight",
    pairingPartner: "BCM",
    partnerOffset: 0x160,
    critical: true,
  },
  {
    name: "GPEC CRC Block",
    module: "GPEC",
    offset: 0x1F0,
    length: 4,
    description: "Dual CRC-16 checksums at 0x1F0 and 0x1F2.",
    pairingRule: "independent",
    critical: true,
  },
  {
    name: "GPEC Unlock Flag",
    module: "GPEC",
    offset: 0x2FFFC,
    length: 1,
    description: "Firmware unlock magic byte. Set to 0x96 to enable engineering mode.",
    pairingRule: "independent",
    critical: true,
  },

  // IPC (Instrument Cluster)
  {
    name: "IPC Odometer",
    module: "IPC",
    offset: 0x300,
    length: 4,
    description: "Stored odometer value in IPC EEPROM.",
    pairingRule: "independent",
    critical: false,
  },
  {
    name: "IPC VIN",
    module: "IPC",
    offset: 0x160,
    length: 17,
    description: "IPC VIN storage. Must match BCM VIN.",
    pairingRule: "straight",
    pairingPartner: "BCM",
    partnerOffset: 0x160,
    critical: true,
  },
];

// ─── Mismatch Detection ──────────────────────────────────────────────

export interface ByteMismatch {
  regionName: string;
  module: string;
  offset: number;
  length: number;
  description: string;
  pairingRule: string;
  critical: boolean;
  file1Bytes: string;  // Hex string of bytes from file 1
  file2Bytes: string;  // Hex string of bytes from file 2
  expectedBytes: string; // What file 2 SHOULD have based on pairing rule
  status: "match" | "mismatch" | "fixable" | "out_of_range";
  fixAction?: string;  // Human-readable description of what the fix does
}

export interface CompareResult {
  id: string;
  timestamp: number;
  file1Name: string;
  file1Size: number;
  file2Name: string;
  file2Size: number;
  file1Module: string;  // Detected or user-specified module type
  file2Module: string;
  totalRegionsScanned: number;
  matchCount: number;
  mismatchCount: number;
  fixableCount: number;
  outOfRangeCount: number;
  mismatches: ByteMismatch[];
  patchAvailable: boolean;
  patchedFile2?: Buffer;  // The corrected binary
}

function reverseBuffer(buf: Buffer): Buffer {
  const reversed = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    reversed[i] = buf[buf.length - 1 - i];
  }
  return reversed;
}

function xorBuffers(buf1: Buffer, buf2: Buffer): Buffer {
  const result = Buffer.alloc(Math.max(buf1.length, buf2.length));
  for (let i = 0; i < result.length; i++) {
    result[i] = (buf1[i] || 0) ^ (buf2[i] || 0);
  }
  return result;
}

function bufToHex(buf: Buffer): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function detectModule(buffer: Buffer, filename: string): string {
  const name = filename.toLowerCase();
  
  // Filename-based detection
  if (name.includes("bcm")) return "BCM";
  if (name.includes("rfhub") || name.includes("rf_hub") || name.includes("rf-hub")) return "RFHUB";
  if (name.includes("pcm")) return "PCM";
  if (name.includes("tcm")) return "TCM";
  if (name.includes("sgw") || name.includes("gateway")) return "SGW";
  if (name.includes("gpec")) return "GPEC";
  if (name.includes("ipc") || name.includes("cluster")) return "IPC";
  if (name.includes("skim") || name.includes("wcm")) return "SKIM";
  if (name.includes("adcm")) return "ADCM";
  if (name.includes("eps")) return "EPS";
  
  // Size-based heuristics for common EEPROM sizes
  if (buffer.length === 8192) return "BCM"; // 95640 = 8KB
  if (buffer.length === 32768) return "RFHUB"; // 256Kbit = 32KB
  if (buffer.length === 65536) return "PCM"; // 512Kbit
  if (buffer.length === 2048) return "SKIM"; // 16Kbit
  
  return "UNKNOWN";
}

export function compareFiles(
  file1: { buffer: Buffer; originalname: string },
  file2: { buffer: Buffer; originalname: string },
  sourceModule?: string,
  targetModule?: string,
): CompareResult {
  const id = nanoid(12);
  const mod1 = sourceModule || detectModule(file1.buffer, file1.originalname);
  const mod2 = targetModule || detectModule(file2.buffer, file2.originalname);
  
  const mismatches: ByteMismatch[] = [];
  let matchCount = 0;
  let mismatchCount = 0;
  let fixableCount = 0;
  let outOfRangeCount = 0;
  
  // Create a mutable copy of file2 for patching
  const patchedBuffer = Buffer.from(file2.buffer);
  let anyPatches = false;
  
  // Scan all known security regions
  for (const region of SECURITY_REGIONS) {
    // Check if this region is relevant to either file
    const isFile1Region = region.module === mod1;
    const isFile2Region = region.module === mod2;
    const isPairedRegion = 
      (region.module === mod1 && region.pairingPartner === mod2) ||
      (region.module === mod2 && region.pairingPartner === mod1);
    
    if (!isFile1Region && !isFile2Region && !isPairedRegion) continue;
    
    // For paired regions, we compare across files
    if (isPairedRegion && region.pairingPartner) {
      const sourceRegion = region.module === mod1 ? region : 
        SECURITY_REGIONS.find(r => r.module === mod1 && r.name.includes(region.name.split(" ")[0]));
      
      if (!sourceRegion) continue;
      
      const srcOffset = region.module === mod1 ? region.offset : (region.partnerOffset || region.offset);
      const dstOffset = region.module === mod2 ? region.offset : (region.partnerOffset || region.offset);
      const len = region.length;
      
      // Check if offsets are within file bounds
      if (srcOffset + len > file1.buffer.length || dstOffset + len > file2.buffer.length) {
        mismatches.push({
          regionName: region.name,
          module: region.module,
          offset: dstOffset,
          length: len,
          description: region.description,
          pairingRule: region.pairingRule,
          critical: region.critical,
          file1Bytes: srcOffset + len <= file1.buffer.length 
            ? bufToHex(file1.buffer.subarray(srcOffset, srcOffset + len))
            : "OUT OF RANGE",
          file2Bytes: dstOffset + len <= file2.buffer.length
            ? bufToHex(file2.buffer.subarray(dstOffset, dstOffset + len))
            : "OUT OF RANGE",
          expectedBytes: "N/A",
          status: "out_of_range",
        });
        outOfRangeCount++;
        continue;
      }
      
      const srcBytes = file1.buffer.subarray(srcOffset, srcOffset + len);
      const dstBytes = file2.buffer.subarray(dstOffset, dstOffset + len);
      
      // Calculate expected bytes based on pairing rule
      let expectedBytes: Buffer;
      let fixAction: string;
      
      switch (region.pairingRule) {
        case "straight":
          expectedBytes = Buffer.from(srcBytes);
          fixAction = `Copy ${len} bytes from ${mod1} @ 0x${srcOffset.toString(16).toUpperCase()} → ${mod2} @ 0x${dstOffset.toString(16).toUpperCase()}`;
          break;
        case "reversed":
          expectedBytes = reverseBuffer(srcBytes);
          fixAction = `Reverse ${len} bytes from ${mod1} @ 0x${srcOffset.toString(16).toUpperCase()} → ${mod2} @ 0x${dstOffset.toString(16).toUpperCase()}`;
          break;
        case "xor":
          // XOR with known constant (0xDEADBEEF pattern)
          const xorKey = Buffer.alloc(len);
          const pattern = [0xDE, 0xAD, 0xBE, 0xEF];
          for (let i = 0; i < len; i++) xorKey[i] = pattern[i % 4];
          expectedBytes = xorBuffers(srcBytes, xorKey);
          fixAction = `XOR ${len} bytes from ${mod1} with key pattern → ${mod2} @ 0x${dstOffset.toString(16).toUpperCase()}`;
          break;
        case "mirror_16":
          // 16-bit word mirror (swap every 2 bytes)
          expectedBytes = Buffer.alloc(len);
          for (let i = 0; i < len - 1; i += 2) {
            expectedBytes[i] = srcBytes[i + 1];
            expectedBytes[i + 1] = srcBytes[i];
          }
          if (len % 2 === 1) expectedBytes[len - 1] = srcBytes[len - 1];
          fixAction = `Mirror-16 ${len} bytes from ${mod1} → ${mod2} @ 0x${dstOffset.toString(16).toUpperCase()}`;
          break;
        default:
          expectedBytes = Buffer.from(srcBytes);
          fixAction = `Copy ${len} bytes from ${mod1} → ${mod2}`;
      }
      
      // Compare actual vs expected
      const isMatch = dstBytes.equals(expectedBytes);
      
      if (isMatch) {
        matchCount++;
        mismatches.push({
          regionName: region.name,
          module: region.module,
          offset: dstOffset,
          length: len,
          description: region.description,
          pairingRule: region.pairingRule,
          critical: region.critical,
          file1Bytes: bufToHex(srcBytes),
          file2Bytes: bufToHex(dstBytes),
          expectedBytes: bufToHex(expectedBytes),
          status: "match",
        });
      } else {
        fixableCount++;
        mismatchCount++;
        
        // Apply the fix to the patched buffer
        expectedBytes.copy(patchedBuffer, dstOffset);
        anyPatches = true;
        
        mismatches.push({
          regionName: region.name,
          module: region.module,
          offset: dstOffset,
          length: len,
          description: region.description,
          pairingRule: region.pairingRule,
          critical: region.critical,
          file1Bytes: bufToHex(srcBytes),
          file2Bytes: bufToHex(dstBytes),
          expectedBytes: bufToHex(expectedBytes),
          status: "fixable",
          fixAction,
        });
      }
    }
    
    // For independent regions, check if they exist and report their values
    if (region.pairingRule === "independent" && (isFile1Region || isFile2Region)) {
      const targetFile = isFile1Region ? file1.buffer : file2.buffer;
      const offset = region.offset;
      const len = region.length;
      
      if (offset + len > targetFile.length) {
        outOfRangeCount++;
        continue;
      }
      
      const bytes = targetFile.subarray(offset, offset + len);
      const allZeros = bytes.every(b => b === 0x00);
      const allFFs = bytes.every(b => b === 0xFF);
      
      mismatches.push({
        regionName: region.name,
        module: region.module,
        offset,
        length: len,
        description: region.description,
        pairingRule: "independent",
        critical: region.critical,
        file1Bytes: isFile1Region ? bufToHex(bytes) : "N/A",
        file2Bytes: isFile2Region ? bufToHex(bytes) : "N/A",
        expectedBytes: allZeros ? "WARNING: All zeros (possibly erased)" : 
                       allFFs ? "WARNING: All 0xFF (possibly blank)" : "Present",
        status: allZeros || allFFs ? "mismatch" : "match",
        fixAction: allZeros ? "Region appears erased — may need reprogramming" :
                   allFFs ? "Region appears blank/unprogrammed" : undefined,
      });
      
      if (allZeros || allFFs) {
        mismatchCount++;
      } else {
        matchCount++;
      }
    }
  }
  
  // Recalculate ALL CRCs using the module-aware CRC engine
  // Covers: all protected regions, polynomial auto-detection, dual-slot CRCs (GPEC/RFHUB)
  if (anyPatches && mod2 !== "UNKNOWN") {
    const crcResults = recalculateAllCrcs(patchedBuffer, mod2, file2.buffer);
    console.log(`[compare] CRC recalculation for ${file2.originalname} (${mod2}):\n${formatCrcReport(crcResults)}`);
  }
  
  // Sort: critical mismatches first, then by offset
  mismatches.sort((a, b) => {
    if (a.status === "fixable" && b.status !== "fixable") return -1;
    if (a.status !== "fixable" && b.status === "fixable") return 1;
    if (a.critical && !b.critical) return -1;
    if (!a.critical && b.critical) return 1;
    return a.offset - b.offset;
  });
  
  return {
    id,
    timestamp: Date.now(),
    file1Name: file1.originalname,
    file1Size: file1.buffer.length,
    file2Name: file2.originalname,
    file2Size: file2.buffer.length,
    file1Module: mod1,
    file2Module: mod2,
    totalRegionsScanned: mismatches.length,
    matchCount,
    mismatchCount,
    fixableCount,
    outOfRangeCount,
    mismatches,
    patchAvailable: anyPatches,
    patchedFile2: anyPatches ? patchedBuffer : undefined,
  };
}

// ─── Full Binary Diff ────────────────────────────────────────────────
// For when you want to see EVERY byte difference, not just known regions

export interface BinaryDiffChunk {
  offset: number;
  length: number;
  file1Bytes: string;
  file2Bytes: string;
}

export function fullBinaryDiff(buf1: Buffer, buf2: Buffer, maxChunks: number = 200): BinaryDiffChunk[] {
  const chunks: BinaryDiffChunk[] = [];
  const minLen = Math.min(buf1.length, buf2.length);
  
  let diffStart = -1;
  
  for (let i = 0; i < minLen; i++) {
    if (buf1[i] !== buf2[i]) {
      if (diffStart === -1) diffStart = i;
    } else {
      if (diffStart !== -1) {
        const len = i - diffStart;
        chunks.push({
          offset: diffStart,
          length: len,
          file1Bytes: bufToHex(buf1.subarray(diffStart, i)),
          file2Bytes: bufToHex(buf2.subarray(diffStart, i)),
        });
        diffStart = -1;
        if (chunks.length >= maxChunks) break;
      }
    }
  }
  
  // Handle trailing diff
  if (diffStart !== -1 && chunks.length < maxChunks) {
    chunks.push({
      offset: diffStart,
      length: minLen - diffStart,
      file1Bytes: bufToHex(buf1.subarray(diffStart, minLen)),
      file2Bytes: bufToHex(buf2.subarray(diffStart, minLen)),
    });
  }
  
  return chunks;
}
