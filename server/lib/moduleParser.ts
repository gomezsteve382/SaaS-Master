/**
 * Server-side module parser — wraps the ported SRT Lab binary library
 * for use in tRPC procedures. All heavy binary work stays server-side.
 */
import { createRequire } from "module";
import { createHash } from "crypto";

// The library files are plain ESM JS — we import them directly.
// @ts-ignore — untyped JS modules
import { crc16, crc8_42, crc8rf, crc8_65, rfhGen2VinCs, rfhGen2DetectMagic, RFH_GEN2_VIN_CS_KNOWN_MAGICS, rfhSec16Cs } from "./crc.js";

// Re-export checksum functions for direct use
export { crc16, crc8_42, crc8rf, crc8_65, rfhGen2VinCs, rfhGen2DetectMagic, RFH_GEN2_VIN_CS_KNOWN_MAGICS, rfhSec16Cs };

// ─── Types ───────────────────────────────────────────────────────────────────

export type ModuleType = "BCM" | "RFHUB" | "GPEC2A" | "95640" | "XC2268_RFHUB" | "ZF_8HP_TCU" | "UNKNOWN";
export type SlotType = "RFHUB" | "BCM" | "PCM";

export interface VinSlot {
  offset: number;
  vin: string;
  checksumOk: boolean;
  checksumByte: number;
  expectedChecksum: number;
  mirrored: boolean;
  magic?: number;
}

export interface Sec16Slot {
  offset: number;
  hex: string;
  checksumOk: boolean;
  checksumBytes: [number, number];
  expectedChecksum: number;
}

export interface KeySlotEntry {
  slotIndex: number;
  occupied: boolean;
  idBytes: string;
}

export interface ParseResult {
  type: ModuleType;
  fileSize: number;
  sha256: string;
  vinSlots: VinSlot[];
  primaryVin: string | null;
  sec16Slots: Sec16Slot[];
  primarySec16: string | null;
  keySlots: KeySlotEntry[];
  allChecksumsValid: boolean;
  gen2Detected: boolean;
  gen2Magic: number | null;
  sizeWarning: string | null;
  errors: string[];
  warnings: string[];
}

export interface SafeModeRefusal {
  allowed: false;
  reason: string;
  code: "INSUFFICIENT_GEN2_EVIDENCE" | "NO_VALID_VIN" | "NO_VALID_SEC16" | "FILE_TOO_SMALL" | "UNKNOWN_MODULE";
  details: Record<string, unknown>;
}

export interface SafeModeApproval {
  allowed: true;
}

export type SafeModeResult = SafeModeRefusal | SafeModeApproval;

export interface DiffRegion {
  offsetStart: number;
  offsetEnd: number;
  lengthBytes: number;
  sourceHex: string;
  candidateHex: string;
  label?: string;
}

export interface ByteDiffReport {
  totalBytes: number;
  changedBytes: number;
  changedPercent: number;
  regions: DiffRegion[];
}

// ─── SHA-256 ─────────────────────────────────────────────────────────────────

export function computeSha256(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ─── Module Detection ────────────────────────────────────────────────────────

export function detectModuleType(buffer: Uint8Array, filename: string, slotType?: SlotType): ModuleType {
  // Slot type takes priority
  if (slotType === "BCM") return "BCM";
  if (slotType === "PCM") return "GPEC2A";
  if (slotType === "RFHUB") return "RFHUB";

  // Size-based detection
  const size = buffer.length;
  if (size === 65536 || size === 131072) {
    // Check for XC2268 header
    const header = String.fromCharCode(...Array.from(buffer.slice(0, 4)));
    if (header === "XC22") return "XC2268_RFHUB";
    return "BCM";
  }
  if (size === 4096) return "RFHUB"; // Gen2 RFHUB
  if (size === 2048) return "RFHUB"; // Gen1 RFHUB
  if (size === 8192) return "95640";

  // Filename hints
  const upper = filename.toUpperCase();
  if (/RFH/.test(upper)) return "RFHUB";
  if (/BCM|DFLASH/.test(upper)) return "BCM";
  if (/PCM|GPEC/.test(upper)) return "GPEC2A";
  if (/95640/.test(upper)) return "95640";

  return "UNKNOWN";
}

// ─── VIN Parsing ─────────────────────────────────────────────────────────────

const RFH_GEN2_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
const RFH_GEN1_VIN_OFFSET = 0x92;
const BCM_VIN_BASES = [0x5320, 0x5340, 0x5360, 0x5380];
const PCM_VIN_OFFSETS = [0x0000, 0x01F0, 0x0224, 0x0CE0];

function isValidVinChar(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A && b !== 0x49 && b !== 0x4F && b !== 0x51);
}

function extractVinAt(data: Uint8Array, offset: number, len = 17): string | null {
  if (offset + len > data.length) return null;
  for (let i = 0; i < len; i++) {
    if (!isValidVinChar(data[offset + i])) return null;
  }
  return String.fromCharCode(...Array.from(data.slice(offset, offset + len)));
}

function extractReversedVinAt(data: Uint8Array, offset: number): string | null {
  if (offset + 17 > data.length) return null;
  const reversed = Array.from(data.slice(offset, offset + 17)).reverse();
  for (const b of reversed) {
    if (!isValidVinChar(b)) return null;
  }
  return String.fromCharCode(...reversed);
}

export function parseVinSlots(data: Uint8Array, moduleType: ModuleType): VinSlot[] {
  const slots: VinSlot[] = [];

  if (moduleType === "RFHUB" && data.length === 4096) {
    // Gen2 RFHUB — reversed VIN with XOR-magic checksum
    // First, detect magic from first valid slot
    let detectedMagic = 0xDB; // default
    for (const off of RFH_GEN2_VIN_OFFSETS) {
      if (off + 18 > data.length) continue;
      const raw = data.slice(off, off + 17);
      const storedCs = data[off + 17];
      if (raw.every(b => b === 0xFF || b === 0x00)) continue;
      if (storedCs === 0x00 || storedCs === 0xFF) continue;
      detectedMagic = rfhGen2DetectMagic(raw, storedCs);
      break;
    }

    for (const off of RFH_GEN2_VIN_OFFSETS) {
      if (off + 18 > data.length) continue;
      const raw = data.slice(off, off + 17);
      const storedCs = data[off + 17];
      const vin = extractReversedVinAt(data, off);
      const expectedCs = rfhGen2VinCs(raw, detectedMagic);

      slots.push({
        offset: off,
        vin: vin || "",
        checksumOk: storedCs === expectedCs,
        checksumByte: storedCs,
        expectedChecksum: expectedCs,
        mirrored: true,
        magic: detectedMagic,
      });
    }
  } else if (moduleType === "RFHUB" && data.length === 2048) {
    // Gen1 RFHUB — plain VIN with CRC16
    const off = RFH_GEN1_VIN_OFFSET;
    if (off + 19 <= data.length) {
      const vin = extractVinAt(data, off);
      const storedCrc = (data[off + 17] << 8) | data[off + 18];
      const vinBytes = data.slice(off, off + 17);
      const expectedCrc = crc16(vinBytes);
      slots.push({
        offset: off,
        vin: vin || "",
        checksumOk: storedCrc === expectedCrc,
        checksumByte: storedCrc,
        expectedChecksum: expectedCrc,
        mirrored: false,
      });
    }
  } else if (moduleType === "BCM") {
    // BCM — plain VIN with CRC16 at +17/+18
    for (const base of BCM_VIN_BASES) {
      // Try base+8 (Redeye 2020+ FEE-record header) first, then base+0
      for (const vinOff of [base + 8, base]) {
        if (vinOff + 19 > data.length) continue;
        const vin = extractVinAt(data, vinOff);
        if (!vin) continue;
        const vinBytes = data.slice(vinOff, vinOff + 17);
        const storedCrc = (data[vinOff + 17] << 8) | data[vinOff + 18];
        const expectedCrc = crc16(vinBytes);
        slots.push({
          offset: vinOff,
          vin,
          checksumOk: storedCrc === expectedCrc,
          checksumByte: storedCrc,
          expectedChecksum: expectedCrc,
          mirrored: false,
        });
        break; // found VIN at this base, skip alternate offset
      }
    }
  } else if (moduleType === "GPEC2A") {
    for (const off of PCM_VIN_OFFSETS) {
      if (off + 17 > data.length) continue;
      const vin = extractVinAt(data, off);
      if (!vin) continue;
      slots.push({
        offset: off,
        vin,
        checksumOk: true, // PCM VIN slots don't always have trailing CRC
        checksumByte: 0,
        expectedChecksum: 0,
        mirrored: false,
      });
    }
  }

  return slots;
}

// ─── SEC16 Parsing ───────────────────────────────────────────────────────────

const RFH_GEN2_SEC16_OFFSETS = [0x0EF5, 0x0F07]; // Two SEC16 slots on Gen2 RFHUB

export function parseSec16Slots(data: Uint8Array, moduleType: ModuleType): Sec16Slot[] {
  const slots: Sec16Slot[] = [];

  if (moduleType === "RFHUB" && data.length === 4096) {
    // Gen2 RFHUB: SEC16 at known offsets, 16 data bytes + 2 checksum bytes
    for (const off of RFH_GEN2_SEC16_OFFSETS) {
      if (off + 18 > data.length) continue;
      const raw16 = data.slice(off, off + 16);
      const storedCsByte1 = data[off + 16];
      const storedCsByte2 = data[off + 17];
      const expectedCs = crc8_65(Array.from(raw16));

      const hex = Array.from(raw16).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
      slots.push({
        offset: off,
        hex,
        checksumOk: storedCsByte1 === expectedCs && storedCsByte2 === 0x00,
        checksumBytes: [storedCsByte1, storedCsByte2],
        expectedChecksum: expectedCs,
      });
    }
  } else if (moduleType === "BCM") {
    // BCM SEC16 is in the IMMO block area — multiple mirrors
    const BCM_SEC16_OFFSETS = [0x40C0, 0x40D2, 0x40E4]; // Primary + mirrors
    for (const off of BCM_SEC16_OFFSETS) {
      if (off + 16 > data.length) continue;
      const raw16 = data.slice(off, off + 16);
      if (raw16.every(b => b === 0xFF || b === 0x00)) continue;
      const hex = Array.from(raw16).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
      slots.push({
        offset: off,
        hex,
        checksumOk: true, // BCM SEC16 mirrors don't have individual CRC
        checksumBytes: [0, 0],
        expectedChecksum: 0,
      });
    }
  }

  return slots;
}

// ─── Key Slot Parsing ────────────────────────────────────────────────────────

export function parseKeySlots(data: Uint8Array, moduleType: ModuleType): KeySlotEntry[] {
  const entries: KeySlotEntry[] = [];
  if (moduleType !== "RFHUB" && moduleType !== "BCM") return entries;

  if (moduleType === "RFHUB" && data.length === 4096) {
    // Gen2 RFHUB: AA50 markers at 0x0880 area
    const AA50_BASE = 0x0880;
    const MAX_SLOTS = 8;
    for (let i = 0; i < MAX_SLOTS; i++) {
      const markerOff = AA50_BASE + i * 2;
      if (markerOff + 2 > data.length) break;
      const occupied = data[markerOff] === 0xAA && data[markerOff + 1] === 0x50;
      const idOff = 0x08C0 + i * 16;
      let idBytes = "";
      if (idOff + 16 <= data.length) {
        idBytes = Array.from(data.slice(idOff, idOff + 16))
          .map(b => b.toString(16).padStart(2, "0").toUpperCase())
          .join("");
      }
      entries.push({ slotIndex: i, occupied, idBytes });
    }
  }

  return entries;
}

// ─── Full Module Parse ───────────────────────────────────────────────────────

export function parseModule(buffer: Buffer | Uint8Array, filename: string, slotType?: SlotType): ParseResult {
  const data = new Uint8Array(buffer);
  const sha256 = computeSha256(buffer);
  const moduleType = detectModuleType(data, filename, slotType);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size validation
  let sizeWarning: string | null = null;
  const canonicalSizes: Record<string, number[]> = {
    BCM: [65536, 131072],
    RFHUB: [2048, 4096],
    GPEC2A: [4096, 8192],
  };
  if (canonicalSizes[moduleType] && !canonicalSizes[moduleType].includes(data.length)) {
    sizeWarning = `Non-canonical size ${data.length} bytes for ${moduleType}. Expected: ${canonicalSizes[moduleType].join(" or ")} bytes.`;
    warnings.push(sizeWarning);
  }

  // Parse VIN slots
  const vinSlots = parseVinSlots(data, moduleType);
  const primaryVin = vinSlots.find(s => s.vin && s.vin.length === 17)?.vin || null;

  // Parse SEC16 slots
  const sec16Slots = parseSec16Slots(data, moduleType);
  const primarySec16 = sec16Slots.find(s => s.hex && s.hex.length === 32)?.hex || null;

  // Parse key slots
  const keySlots = parseKeySlots(data, moduleType);

  // Determine Gen2 status
  const gen2Detected = moduleType === "RFHUB" && data.length === 4096;
  const gen2Magic = gen2Detected && vinSlots.length > 0 && vinSlots[0].magic != null
    ? vinSlots[0].magic
    : null;

  // Check all checksums
  const allChecksumsValid = vinSlots.every(s => s.checksumOk) && sec16Slots.every(s => s.checksumOk);

  if (!allChecksumsValid) {
    const badVin = vinSlots.filter(s => !s.checksumOk);
    const badSec = sec16Slots.filter(s => !s.checksumOk);
    if (badVin.length > 0) warnings.push(`${badVin.length} VIN slot(s) have invalid checksums.`);
    if (badSec.length > 0) warnings.push(`${badSec.length} SEC16 slot(s) have invalid checksums.`);
  }

  return {
    type: moduleType,
    fileSize: data.length,
    sha256,
    vinSlots,
    primaryVin,
    sec16Slots,
    primarySec16,
    keySlots,
    allChecksumsValid,
    gen2Detected,
    gen2Magic,
    sizeWarning,
    errors,
    warnings,
  };
}

// ─── Safe Mode Check ─────────────────────────────────────────────────────────

export function checkSafeMode(parseResult: ParseResult): SafeModeResult {
  if (parseResult.type === "UNKNOWN") {
    return {
      allowed: false,
      reason: "Cannot identify module type from the uploaded binary.",
      code: "UNKNOWN_MODULE",
      details: { fileSize: parseResult.fileSize },
    };
  }

  if (parseResult.gen2Detected && parseResult.gen2Magic === null) {
    return {
      allowed: false,
      reason: "Gen2 RFHUB detected but cannot determine XOR-magic checksum constant. All VIN slots appear blank or corrupted — insufficient evidence to safely write.",
      code: "INSUFFICIENT_GEN2_EVIDENCE",
      details: {
        vinSlotCount: parseResult.vinSlots.length,
        allBlank: parseResult.vinSlots.every(s => !s.vin),
      },
    };
  }

  if (!parseResult.primaryVin) {
    return {
      allowed: false,
      reason: "No valid VIN found in any slot. Cannot generate a candidate without a source VIN.",
      code: "NO_VALID_VIN",
      details: { vinSlotCount: parseResult.vinSlots.length },
    };
  }

  return { allowed: true };
}

// ─── SEC16 Synchronization ───────────────────────────────────────────────────

/**
 * Derives RFH SEC16 from BCM SEC16 by reversing the byte order.
 * BCM stores SEC16 in one byte order; RFH stores it reversed.
 */
export function bcmSec16ToRfh(bcmSec16Hex: string): string {
  const bytes = [];
  for (let i = 0; i < bcmSec16Hex.length; i += 2) {
    bytes.push(bcmSec16Hex.substring(i, i + 2));
  }
  return bytes.reverse().join("");
}

/**
 * Derives BCM SEC16 from RFH SEC16 by reversing the byte order.
 */
export function rfhSec16ToBcm(rfhSec16Hex: string): string {
  return bcmSec16ToRfh(rfhSec16Hex); // Same operation — reverse is its own inverse
}

// ─── Candidate Generation ────────────────────────────────────────────────────

export interface CandidateResult {
  data: Uint8Array;
  sha256: string;
  changes: DiffRegion[];
  warnings: string[];
}

/**
 * Generate a corrected RFHUB candidate with minimal changes:
 * - Writes VIN to all 4 Gen2 slots using XOR-magic checksum (NEVER crc8rf)
 * - Writes SEC16 to both slots with crc8_65 checksum
 * - Does NOT touch learned-state/key regions
 */
export function generateRfhCandidate(
  sourceData: Uint8Array,
  targetVin: string,
  targetSec16Hex: string
): CandidateResult {
  const warnings: string[] = [];
  const changes: DiffRegion[] = [];
  const out = new Uint8Array(sourceData);

  if (sourceData.length !== 4096) {
    throw new Error("RFHUB candidate generation requires a 4096-byte Gen2 image.");
  }

  // Detect Gen2 magic from existing slots
  let magic = 0xDB;
  for (const off of RFH_GEN2_VIN_OFFSETS) {
    if (off + 18 > out.length) continue;
    const raw = sourceData.slice(off, off + 17);
    const storedCs = sourceData[off + 17];
    if (raw.every(b => b === 0xFF || b === 0x00)) continue;
    if (storedCs === 0x00 || storedCs === 0xFF) continue;
    magic = rfhGen2DetectMagic(raw, storedCs);
    break;
  }

  // Write VIN to all 4 Gen2 slots (reversed, with XOR-magic checksum)
  if (targetVin && targetVin.length === 17) {
    const vinBytes = new TextEncoder().encode(targetVin);
    const reversed = new Uint8Array(Array.from(vinBytes).reverse());

    for (const off of RFH_GEN2_VIN_OFFSETS) {
      if (off + 18 > out.length) continue;
      const beforeSlot = out.slice(off, off + 18);

      // Write reversed VIN
      for (let i = 0; i < 17; i++) out[off + i] = reversed[i];
      // Write Gen2 XOR-magic checksum — NEVER crc8rf
      out[off + 17] = rfhGen2VinCs(reversed, magic);

      const afterSlot = out.slice(off, off + 18);
      if (!arraysEqual(beforeSlot, afterSlot)) {
        changes.push({
          offsetStart: off,
          offsetEnd: off + 17,
          lengthBytes: 18,
          sourceHex: toHex(beforeSlot),
          candidateHex: toHex(afterSlot),
          label: `VIN slot @ 0x${off.toString(16).toUpperCase()}`,
        });
      }
    }
  }

  // Write SEC16 to both slots with crc8_65 checksum
  if (targetSec16Hex && targetSec16Hex.length === 32) {
    const sec16Bytes = hexToBytes(targetSec16Hex);

    for (const off of RFH_GEN2_SEC16_OFFSETS) {
      if (off + 18 > out.length) continue;
      const beforeSlot = out.slice(off, off + 18);

      // Write 16 SEC16 data bytes
      for (let i = 0; i < 16; i++) out[off + i] = sec16Bytes[i];
      // Write crc8_65 checksum + 0x00 trailer
      out[off + 16] = crc8_65(Array.from(sec16Bytes));
      out[off + 17] = 0x00;

      const afterSlot = out.slice(off, off + 18);
      if (!arraysEqual(beforeSlot, afterSlot)) {
        changes.push({
          offsetStart: off,
          offsetEnd: off + 17,
          lengthBytes: 18,
          sourceHex: toHex(beforeSlot),
          candidateHex: toHex(afterSlot),
          label: `SEC16 slot @ 0x${off.toString(16).toUpperCase()}`,
        });
      }
    }
  }

  const sha256 = computeSha256(out);
  return { data: out, sha256, changes, warnings };
}

// ─── Byte-Level Diff ─────────────────────────────────────────────────────────

export function computeByteDiff(source: Uint8Array, candidate: Uint8Array): ByteDiffReport {
  const totalBytes = Math.max(source.length, candidate.length);
  const regions: DiffRegion[] = [];
  let changedBytes = 0;
  let inRegion = false;
  let regionStart = 0;

  for (let i = 0; i <= totalBytes; i++) {
    const a = i < source.length ? source[i] : 0xFF;
    const b = i < candidate.length ? candidate[i] : 0xFF;
    const different = a !== b;

    if (different && !inRegion) {
      regionStart = i;
      inRegion = true;
    } else if (!different && inRegion) {
      // End of region
      const len = i - regionStart;
      changedBytes += len;
      regions.push({
        offsetStart: regionStart,
        offsetEnd: i - 1,
        lengthBytes: len,
        sourceHex: toHex(source.slice(regionStart, i)),
        candidateHex: toHex(candidate.slice(regionStart, i)),
      });
      inRegion = false;
    } else if (different) {
      // Still inside a region — do NOT increment here;
      // changedBytes is counted when the region closes.
    }
  }

  // Close trailing region
  if (inRegion) {
    const len = totalBytes - regionStart;
    changedBytes += len;
    regions.push({
      offsetStart: regionStart,
      offsetEnd: totalBytes - 1,
      lengthBytes: len,
      sourceHex: toHex(source.slice(regionStart, totalBytes)),
      candidateHex: toHex(candidate.slice(regionStart, totalBytes)),
    });
  }

  return {
    totalBytes,
    changedBytes,
    changedPercent: totalBytes > 0 ? (changedBytes / totalBytes) * 100 : 0,
    regions,
  };
}

// ─── Three-Way Comparison ────────────────────────────────────────────────────

export interface ThreeWayResult {
  correctedVsPre: ByteDiffReport;
  correctedVsPost: ByteDiffReport;
  preVsPost: ByteDiffReport;
  runtimeRewrites: DiffRegion[];
  learnedStateRegions: DiffRegion[];
}

const LEARNED_STATE_RANGES = [
  { start: 0x0880, end: 0x09FF, label: "Key table / AA50 markers" },
  { start: 0x0200, end: 0x023F, label: "Fob learned state" },
];

export function threeWayCompare(
  corrected: Uint8Array,
  preBench: Uint8Array,
  postBench: Uint8Array
): ThreeWayResult {
  const correctedVsPre = computeByteDiff(corrected, preBench);
  const correctedVsPost = computeByteDiff(corrected, postBench);
  const preVsPost = computeByteDiff(preBench, postBench);

  // Identify runtime rewrites: changes between pre and post that were NOT in corrected
  const runtimeRewrites = preVsPost.regions.filter(region => {
    // Check if this region was already different in corrected vs pre
    const wasAlreadyDifferent = correctedVsPre.regions.some(
      r => r.offsetStart <= region.offsetEnd && r.offsetEnd >= region.offsetStart
    );
    return !wasAlreadyDifferent;
  });

  // Flag learned-state regions
  const learnedStateRegions = preVsPost.regions.filter(region =>
    LEARNED_STATE_RANGES.some(
      lr => region.offsetStart >= lr.start && region.offsetEnd <= lr.end
    )
  );

  return {
    correctedVsPre,
    correctedVsPost,
    preVsPost,
    runtimeRewrites,
    learnedStateRegions,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
