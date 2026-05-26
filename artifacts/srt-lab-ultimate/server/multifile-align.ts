import { Buffer } from "buffer";
import { nanoid } from "nanoid";
import { SECURITY_REGIONS, detectModule } from "./compare.js";
import { recalculateAllCrcs, formatCrcReport } from "./crc-engine.js";

interface FileData {
  buffer: Buffer;
  filename: string;
  module: string;
  fileSize: number;
}

interface SecurityByteStatus {
  regionName: string;
  offset: number;
  length: number;
  file1Value: string;
  file2Value: string;
  file3Value: string;
  masterValue: string;
  allMatch: boolean;
  needsPatching: boolean[];
  beforeAfter: {
    fileIndex: number;
    before: string;
    after: string;
  }[];
}

interface MultiFileAlignment {
  id: string;
  timestamp: number;
  files: { filename: string; module: string; size: number }[];
  masterIndex: number;
  masterModule: string;
  totalRegionsScanned: number;
  matchingRegions: number;
  mismatchingRegions: number;
  securityByteStatus: SecurityByteStatus[];
  patchPlans: {
    fileIndex: number;
    filename: string;
    module: string;
    patchCount: number;
    bytesToChange: number;
  }[];
}

function scoreSecurityBytes(buffer: Buffer, module: string): number {
  let score = 0;
  
  // Check for valid VIN (non-0xFF, non-0x00 bytes)
  const vin = buffer.subarray(0x160, 0x160 + 17);
  if (vin.some(b => b !== 0xFF && b !== 0x00)) score += 100;
  
  // Check for valid SKIM bytes
  const skim = buffer.subarray(0x01A0, 0x01A0 + 9);
  if (skim.some(b => b !== 0xFF && b !== 0x00)) score += 80;
  
  // Check for valid PIN (if BCM)
  if (module === "BCM") {
    const pin = buffer.subarray(0x838, 0x838 + 4);
    if (pin.some(b => b !== 0xFF && b !== 0x00)) score += 60;
  }
  
  // Check for valid Secret Key
  const secretKey = buffer.subarray(0xF1A0, 0xF1A0 + 16);
  if (secretKey.some(b => b !== 0xFF && b !== 0x00)) score += 70;
  
  return score;
}

export function analyzeMultiFileAlignment(files: FileData[]): MultiFileAlignment {
  if (files.length !== 3) {
    throw new Error("Exactly 3 files required for multi-file alignment");
  }

  // Detect master module (highest security byte score)
  const scores = files.map((f, idx) => ({
    idx,
    score: scoreSecurityBytes(f.buffer, f.module),
  }));
  const masterIndex = scores.reduce((a, b) => (a.score > b.score ? a : b)).idx;
  const masterFile = files[masterIndex];

  const alignment: MultiFileAlignment = {
    id: nanoid(12),
    timestamp: Date.now(),
    files: files.map(f => ({
      filename: f.filename,
      module: f.module,
      size: f.fileSize,
    })),
    masterIndex,
    masterModule: masterFile.module,
    totalRegionsScanned: 0,
    matchingRegions: 0,
    mismatchingRegions: 0,
    securityByteStatus: [],
    patchPlans: [],
  };

  // Scan all security regions
  for (const region of SECURITY_REGIONS) {
    // Skip regions outside file bounds
    if (region.offset + region.length > Math.min(...files.map(f => f.buffer.length))) {
      continue;
    }

    alignment.totalRegionsScanned++;

    const values = files.map(f => {
      const data = f.buffer.subarray(region.offset, region.offset + region.length);
      return Array.from(data)
        .map(b => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
    });

    const masterValue = values[masterIndex];
    const beforeAfter = [];
    for (let i = 0; i < files.length; i++) {
      if (i !== masterIndex && values[i] !== masterValue) {
        beforeAfter.push({
          fileIndex: i,
          before: values[i],
          after: masterValue,
        });
      }
    }
    
    const status: SecurityByteStatus = {
      regionName: region.name,
      offset: region.offset,
      length: region.length,
      file1Value: values[0],
      file2Value: values[1],
      file3Value: values[2],
      masterValue,
      allMatch: values.every(v => v === masterValue),
      needsPatching: values.map((v, idx) => idx !== masterIndex && v !== masterValue),
      beforeAfter,
    };

    alignment.securityByteStatus.push(status);

    if (status.allMatch) {
      alignment.matchingRegions++;
    } else {
      alignment.mismatchingRegions++;
    }
  }

  // Generate patch plans for non-master files
  for (let i = 0; i < files.length; i++) {
    if (i === masterIndex) continue;

    let patchCount = 0;
    let bytesToChange = 0;

    for (const status of alignment.securityByteStatus) {
      if (status.needsPatching[i]) {
        patchCount++;
        bytesToChange += status.length;
      }
    }

    alignment.patchPlans.push({
      fileIndex: i,
      filename: files[i].filename,
      module: files[i].module,
      patchCount,
      bytesToChange,
    });
  }

  return alignment;
}

export function generatePatchedFiles(
  alignment: MultiFileAlignment,
  files: FileData[]
): Buffer[] {
  const patchedFiles: Buffer[] = [];

  for (let i = 0; i < files.length; i++) {
    const patchedBuffer = Buffer.from(files[i].buffer);

    if (i === alignment.masterIndex) {
      // Master file stays unchanged
      patchedFiles.push(patchedBuffer);
      continue;
    }

    const masterBuffer = files[alignment.masterIndex].buffer;

    // Apply all patches
    for (const status of alignment.securityByteStatus) {
      if (status.needsPatching[i]) {
        const masterData = masterBuffer.subarray(
          status.offset,
          status.offset + status.length
        );

        // Apply pairing rule
        const region = SECURITY_REGIONS.find(r => r.name === status.regionName);
        if (!region) continue;

        let patchData = Buffer.from(masterData);

        if (region.pairingRule === "reversed") {
          patchData = Buffer.from(masterData).reverse();
        } else if (region.pairingRule === "mirror_16") {
          // Mirror each 16-bit word
          for (let j = 0; j < patchData.length; j += 2) {
            if (j + 1 < patchData.length) {
              const temp = patchData[j];
              patchData[j] = patchData[j + 1];
              patchData[j + 1] = temp;
            }
          }
        }

        patchData.copy(patchedBuffer, status.offset);
      }
    }

    // Recalculate ALL CRCs using the module-aware CRC engine
    // This handles: polynomial auto-detection, dual-slot CRCs, all protected regions
    const anyPatched = alignment.securityByteStatus.some(s => s.needsPatching[i]);
    if (anyPatched) {
      const targetModule = files[i].module;
      const crcResults = recalculateAllCrcs(patchedBuffer, targetModule, files[i].buffer);
      const crcReport = formatCrcReport(crcResults);
      console.log(`[multifile-align] CRC recalculation for ${files[i].filename} (${targetModule}):\n${crcReport}`);
    }

    patchedFiles.push(patchedBuffer);
  }

  return patchedFiles;
}

export function generateManifest(alignment: MultiFileAlignment, files: FileData[]): string {
  const manifest = {
    alignmentId: alignment.id,
    timestamp: new Date(alignment.timestamp).toISOString(),
    masterModule: {
      index: alignment.masterIndex,
      module: alignment.masterModule,
      filename: alignment.files[alignment.masterIndex].filename,
    },
    files: alignment.files.map((f, idx) => ({
      index: idx,
      filename: f.filename,
      module: f.module,
      size: f.size,
      status: idx === alignment.masterIndex ? "master" : "patched",
    })),
    summary: {
      totalRegionsScanned: alignment.totalRegionsScanned,
      matchingRegions: alignment.matchingRegions,
      mismatchingRegions: alignment.mismatchingRegions,
    },
    patchesApplied: alignment.patchPlans.map(plan => ({
      targetFile: plan.filename,
      targetModule: plan.module,
      patchCount: plan.patchCount,
      bytesChanged: plan.bytesToChange,
    })),
    securityByteDetails: alignment.securityByteStatus
      .filter(s => !s.allMatch)
      .map(s => ({
        region: s.regionName,
        offset: `0x${s.offset.toString(16).toUpperCase()}`,
        length: s.length,
        patches: s.beforeAfter.map(ba => ({
          file: alignment.files[ba.fileIndex].filename,
          before: ba.before,
          after: ba.after,
        })),
      })),
  };

  return JSON.stringify(manifest, null, 2);
}
