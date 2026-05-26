/**
 * SRT Lab CRC Engine — FCA/Stellantis Module Checksum Authority
 *
 * Extracted from CDA6, AlphaOBD, and wiTECH reverse-engineering intelligence.
 * Covers all known CRC regions for BCM, RFHUB, GPEC, PCM, TCM, IPC, ADCM, EPS.
 *
 * Key capabilities:
 *   1. Module-aware CRC region table (which bytes are covered, where the CRC lives)
 *   2. Polynomial auto-detection from original data (try all known FCA polys)
 *   3. Dual-slot CRC handling (GPEC/RFHUB write CRC at both 0x1F0 and 0x1F2)
 *   4. recalculateAllCrcs() — call after ANY patch to keep the file valid
 */

// ─── CRC-16 Core ─────────────────────────────────────────────────────────────

/**
 * Standard CRC-16 with configurable polynomial, init value, and reflection.
 * Supports both MSB-first (normal) and LSB-first (reflected) modes.
 */
export function crc16(
  data: Buffer,
  polynomial: number = 0x8005,
  init: number = 0xFFFF,
  reflectInput: boolean = false,
  reflectOutput: boolean = false,
): number {
  let crc = init & 0xFFFF;

  for (let i = 0; i < data.length; i++) {
    let byte = data[i];
    if (reflectInput) {
      byte = reflectByte(byte);
    }
    crc ^= byte << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ polynomial) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }

  if (reflectOutput) {
    crc = reflect16(crc);
  }
  return crc & 0xFFFF;
}

function reflectByte(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & (1 << i)) r |= 1 << (7 - i);
  }
  return r;
}

function reflect16(v: number): number {
  let r = 0;
  for (let i = 0; i < 16; i++) {
    if (v & (1 << i)) r |= 1 << (15 - i);
  }
  return r;
}

// ─── Known FCA/Stellantis CRC Variants ───────────────────────────────────────
// Extracted from CDA6 / AlphaOBD / wiTECH bytecode analysis.
// Each entry is tried in order during polynomial auto-detection.

export interface CrcVariant {
  name: string;
  polynomial: number;
  init: number;
  reflectInput: boolean;
  reflectOutput: boolean;
  xorOut: number;
}

export const FCA_CRC_VARIANTS: CrcVariant[] = [
  // Primary FCA/Stellantis variants (highest confidence first)
  { name: "FCA-Chrysler",    polynomial: 0x589B, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "FCA-Dodge",       polynomial: 0x8C5B, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "FCA-Jeep",        polynomial: 0xA097, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "FCA-Ferrari",     polynomial: 0x71DE, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  // Standard variants
  { name: "CRC-16/IBM",      polynomial: 0x8005, init: 0x0000, reflectInput: true,  reflectOutput: true,  xorOut: 0x0000 },
  { name: "CRC-16/MAXIM",    polynomial: 0x8005, init: 0x0000, reflectInput: true,  reflectOutput: true,  xorOut: 0xFFFF },
  { name: "CRC-16/USB",      polynomial: 0x8005, init: 0xFFFF, reflectInput: true,  reflectOutput: true,  xorOut: 0xFFFF },
  { name: "CRC-16/BUYPASS",  polynomial: 0x8005, init: 0x0000, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-16/ANSI",     polynomial: 0x8005, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-CCITT",       polynomial: 0x1021, init: 0xFFFF, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-CCITT/KERMIT",polynomial: 0x1021, init: 0x0000, reflectInput: true,  reflectOutput: true,  xorOut: 0x0000 },
  { name: "CRC-CCITT/XMODEM",polynomial: 0x1021, init: 0x0000, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-CCITT/AUG",   polynomial: 0x1021, init: 0x1D0F, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-16/DNP",      polynomial: 0x3D65, init: 0x0000, reflectInput: true,  reflectOutput: true,  xorOut: 0xFFFF },
  { name: "CRC-16/T10-DIF",  polynomial: 0x8BB7, init: 0x0000, reflectInput: false, reflectOutput: false, xorOut: 0x0000 },
  { name: "CRC-16/DECT-R",   polynomial: 0x0589, init: 0x0000, reflectInput: false, reflectOutput: false, xorOut: 0x0001 },
  { name: "CRC-16/EN-13757", polynomial: 0x3D65, init: 0x0000, reflectInput: false, reflectOutput: false, xorOut: 0xFFFF },
];

/** Compute CRC using a CrcVariant descriptor */
export function crcWithVariant(data: Buffer, v: CrcVariant): number {
  return (crc16(data, v.polynomial, v.init, v.reflectInput, v.reflectOutput) ^ v.xorOut) & 0xFFFF;
}

// ─── Module CRC Region Table ──────────────────────────────────────────────────
// Each entry describes one CRC-protected block in a module's EEPROM.
// dataOffset/dataLength: the bytes that the CRC covers
// crcOffset: where the 2-byte CRC is stored
// crcOffset2: optional second slot (dual-CRC modules like GPEC, RFHUB)
// readBE: true = CRC stored big-endian (most FCA modules), false = little-endian

export interface ModuleCrcRegion {
  module: string;           // "BCM" | "RFHUB" | "GPEC" | "PCM" | "TCM" | "IPC" | "ADCM" | "EPS" | "*"
  name: string;             // Human-readable name
  dataOffset: number;       // Start of data covered by CRC
  dataLength: number;       // Length of data covered by CRC
  crcOffset: number;        // Where the 2-byte CRC is stored
  crcOffset2?: number;      // Second CRC slot (dual-CRC)
  readBE: boolean;          // Big-endian (true) or little-endian (false)
  notes?: string;
}

export const MODULE_CRC_REGIONS: ModuleCrcRegion[] = [
  // ── BCM (95640 8KB EEPROM) ────────────────────────────────────────────────
  {
    module: "BCM",
    name: "BCM VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    crcOffset2: 0x1F2,
    readBE: true,
    notes: "Covers 17-byte VIN at 0x160. CRC written at 0x1F0 and mirrored at 0x1F2.",
  },
  {
    module: "BCM",
    name: "BCM Security Block CRC",
    dataOffset: 0x01A0,
    dataLength: 9,
    crcOffset: 0x1B0,
    readBE: true,
    notes: "Covers SKIM verification bytes at 0x1A0.",
  },

  // ── RFHUB (256Kbit EEPROM) ────────────────────────────────────────────────
  {
    module: "RFHUB",
    name: "RFHUB VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    crcOffset2: 0x1F2,
    readBE: true,
    notes: "VIN stored reversed. CRC covers the reversed VIN bytes. Dual-slot at 0x1F0/0x1F2.",
  },
  {
    module: "RFHUB",
    name: "RFHUB SKIM Block CRC",
    dataOffset: 0x01A0,
    dataLength: 9,
    crcOffset: 0x1B0,
    readBE: true,
    notes: "Covers SKIM pairing bytes at 0x1A0.",
  },

  // ── GPEC / GPEC2A ─────────────────────────────────────────────────────────
  {
    module: "GPEC",
    name: "GPEC VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    crcOffset2: 0x1F2,
    readBE: true,
    notes: "Dual-slot CRC. Both slots must match or module rejects the block.",
  },

  // ── PCM ───────────────────────────────────────────────────────────────────
  {
    module: "PCM",
    name: "PCM VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    readBE: true,
    notes: "Single CRC slot. PCM does not use dual-slot.",
  },

  // ── TCM ───────────────────────────────────────────────────────────────────
  {
    module: "TCM",
    name: "TCM VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    readBE: true,
  },

  // ── IPC (Instrument Cluster) ──────────────────────────────────────────────
  {
    module: "IPC",
    name: "IPC VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    readBE: true,
  },

  // ── ADCM ─────────────────────────────────────────────────────────────────
  {
    module: "ADCM",
    name: "ADCM VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    crcOffset2: 0x1F2,
    readBE: true,
    notes: "ADCM uses dual-slot like GPEC.",
  },

  // ── EPS (Electric Power Steering) ─────────────────────────────────────────
  {
    module: "EPS",
    name: "EPS VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    readBE: true,
  },

  // ── Wildcard: applies to any module with this layout ─────────────────────
  {
    module: "*",
    name: "Generic VIN Block CRC",
    dataOffset: 0x160,
    dataLength: 17,
    crcOffset: 0x1F0,
    readBE: true,
    notes: "Fallback for unrecognized modules that follow the standard layout.",
  },
];

// ─── Polynomial Auto-Detection ───────────────────────────────────────────────

export interface DetectedCrc {
  variant: CrcVariant;
  computedCrc: number;
  storedCrc: number;
  matched: boolean;
}

/**
 * Sniff which CRC variant was used for a given data block.
 * Reads the stored CRC from the buffer, then tries all known FCA variants.
 * Returns the first match, or the best guess (standard 0x8005) if none match.
 */
export function detectCrcVariant(
  buffer: Buffer,
  region: ModuleCrcRegion,
): DetectedCrc {
  if (region.crcOffset + 2 > buffer.length) {
    // CRC slot out of range — return default
    return {
      variant: FCA_CRC_VARIANTS[0],
      computedCrc: 0,
      storedCrc: 0,
      matched: false,
    };
  }

  const dataEnd = region.dataOffset + region.dataLength;
  if (dataEnd > buffer.length) {
    return {
      variant: FCA_CRC_VARIANTS[0],
      computedCrc: 0,
      storedCrc: 0,
      matched: false,
    };
  }

  const data = buffer.subarray(region.dataOffset, dataEnd);
  const storedCrc = region.readBE
    ? buffer.readUInt16BE(region.crcOffset)
    : buffer.readUInt16LE(region.crcOffset);

  // Try all known variants
  for (const variant of FCA_CRC_VARIANTS) {
    const computed = crcWithVariant(data, variant);
    if (computed === storedCrc) {
      return { variant, computedCrc: computed, storedCrc, matched: true };
    }
  }

  // No match — return the standard FCA-Chrysler variant as best guess
  const fallback = FCA_CRC_VARIANTS.find(v => v.name === "FCA-Chrysler") || FCA_CRC_VARIANTS[0];
  const computed = crcWithVariant(data, fallback);
  return { variant: fallback, computedCrc: computed, storedCrc, matched: false };
}

// ─── Main Recalculation Function ──────────────────────────────────────────────

export interface CrcFixResult {
  regionName: string;
  module: string;
  dataOffset: number;
  dataLength: number;
  crcOffset: number;
  crcOffset2?: number;
  oldCrc: number;
  newCrc: number;
  variantUsed: string;
  polyMatched: boolean;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Recalculate and write ALL CRC checksums for the given module.
 * Call this after ANY patch operation to ensure the file is valid.
 *
 * @param buffer  Mutable buffer (will be modified in-place)
 * @param module  Module type string (BCM, RFHUB, GPEC, PCM, etc.)
 * @param originalBuffer  Original unpatched buffer (used for polynomial detection)
 * @returns       Array of CrcFixResult describing what was done
 */
export function recalculateAllCrcs(
  buffer: Buffer,
  module: string,
  originalBuffer: Buffer,
): CrcFixResult[] {
  const results: CrcFixResult[] = [];

  // Get all regions for this module (module-specific + wildcard)
  const regions = MODULE_CRC_REGIONS.filter(
    r => r.module === module || r.module === "*"
  );

  // De-duplicate: prefer module-specific over wildcard
  const seen = new Set<string>();
  const dedupedRegions: ModuleCrcRegion[] = [];
  for (const r of regions) {
    const key = `${r.dataOffset}:${r.crcOffset}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRegions.push(r);
    }
  }

  for (const region of dedupedRegions) {
    const dataEnd = region.dataOffset + region.dataLength;

    // Skip if region is out of file bounds
    if (dataEnd > buffer.length || region.crcOffset + 2 > buffer.length) {
      results.push({
        regionName: region.name,
        module: region.module,
        dataOffset: region.dataOffset,
        dataLength: region.dataLength,
        crcOffset: region.crcOffset,
        crcOffset2: region.crcOffset2,
        oldCrc: 0,
        newCrc: 0,
        variantUsed: "N/A",
        polyMatched: false,
        skipped: true,
        skipReason: `Region out of file bounds (file=${buffer.length}, need=${Math.max(dataEnd, region.crcOffset + 2)})`,
      });
      continue;
    }

    // Read old CRC
    const oldCrc = region.readBE
      ? buffer.readUInt16BE(region.crcOffset)
      : buffer.readUInt16LE(region.crcOffset);

    // Detect polynomial from original buffer
    const detected = detectCrcVariant(originalBuffer, region);

    // Compute new CRC on the (possibly patched) data
    const newData = buffer.subarray(region.dataOffset, dataEnd);
    const newCrc = crcWithVariant(newData, detected.variant);

    // Write CRC to primary slot
    if (region.readBE) {
      buffer.writeUInt16BE(newCrc, region.crcOffset);
    } else {
      buffer.writeUInt16LE(newCrc, region.crcOffset);
    }

    // Write CRC to secondary slot (dual-CRC modules)
    if (region.crcOffset2 !== undefined && region.crcOffset2 + 2 <= buffer.length) {
      if (region.readBE) {
        buffer.writeUInt16BE(newCrc, region.crcOffset2);
      } else {
        buffer.writeUInt16LE(newCrc, region.crcOffset2);
      }
    }

    results.push({
      regionName: region.name,
      module: region.module,
      dataOffset: region.dataOffset,
      dataLength: region.dataLength,
      crcOffset: region.crcOffset,
      crcOffset2: region.crcOffset2,
      oldCrc,
      newCrc,
      variantUsed: detected.variant.name,
      polyMatched: detected.matched,
      skipped: false,
    });
  }

  return results;
}

/**
 * Verify all CRC checksums for a module without modifying the buffer.
 * Returns a report of which regions pass/fail and what the correct values should be.
 */
export function verifyCrcs(
  buffer: Buffer,
  module: string,
): Array<{
  regionName: string;
  crcOffset: number;
  storedCrc: number;
  expectedCrc: number;
  variantUsed: string;
  polyMatched: boolean;
  valid: boolean;
  skipped: boolean;
  skipReason?: string;
}> {
  const results = [];

  const regions = MODULE_CRC_REGIONS.filter(
    r => r.module === module || r.module === "*"
  );

  const seen = new Set<string>();
  const dedupedRegions: ModuleCrcRegion[] = [];
  for (const r of regions) {
    const key = `${r.dataOffset}:${r.crcOffset}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRegions.push(r);
    }
  }

  for (const region of dedupedRegions) {
    const dataEnd = region.dataOffset + region.dataLength;

    if (dataEnd > buffer.length || region.crcOffset + 2 > buffer.length) {
      results.push({
        regionName: region.name,
        crcOffset: region.crcOffset,
        storedCrc: 0,
        expectedCrc: 0,
        variantUsed: "N/A",
        polyMatched: false,
        valid: false,
        skipped: true,
        skipReason: `Out of bounds (file=${buffer.length})`,
      });
      continue;
    }

    const detected = detectCrcVariant(buffer, region);
    const data = buffer.subarray(region.dataOffset, dataEnd);
    const expectedCrc = crcWithVariant(data, detected.variant);
    const storedCrc = region.readBE
      ? buffer.readUInt16BE(region.crcOffset)
      : buffer.readUInt16LE(region.crcOffset);

    results.push({
      regionName: region.name,
      crcOffset: region.crcOffset,
      storedCrc,
      expectedCrc,
      variantUsed: detected.variant.name,
      polyMatched: detected.matched,
      valid: storedCrc === expectedCrc,
      skipped: false,
    });
  }

  return results;
}

/**
 * Format a CrcFixResult array as a human-readable report string.
 */
export function formatCrcReport(results: CrcFixResult[]): string {
  const lines: string[] = ["═══ CRC RECALCULATION REPORT ═══"];
  for (const r of results) {
    if (r.skipped) {
      lines.push(`  [SKIP] ${r.regionName}: ${r.skipReason}`);
    } else if (r.oldCrc === r.newCrc) {
      lines.push(`  [OK]   ${r.regionName} @ 0x${r.crcOffset.toString(16).toUpperCase()}: CRC unchanged 0x${r.newCrc.toString(16).toUpperCase().padStart(4, "0")} (${r.variantUsed})`);
    } else {
      const dualSlot = r.crcOffset2 !== undefined ? ` + 0x${r.crcOffset2.toString(16).toUpperCase()}` : "";
      const polyNote = r.polyMatched ? "" : " [poly auto-detected, no exact match]";
      lines.push(`  [FIX]  ${r.regionName} @ 0x${r.crcOffset.toString(16).toUpperCase()}${dualSlot}: 0x${r.oldCrc.toString(16).toUpperCase().padStart(4, "0")} → 0x${r.newCrc.toString(16).toUpperCase().padStart(4, "0")} (${r.variantUsed})${polyNote}`);
    }
  }
  return lines.join("\n");
}
