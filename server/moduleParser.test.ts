import { describe, expect, it } from "vitest";
import {
  computeSha256,
  bcmSec16ToRfh,
  rfhSec16ToBcm,
  checkSafeMode,
  generateRfhCandidate,
  computeByteDiff,
  threeWayCompare,
  detectModuleType,
  parseModule,
  rfhGen2VinCs,
} from "./lib/moduleParser";
import type { ParseResult, SafeModeRefusal } from "./lib/moduleParser";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRfhGen2Buffer(vin?: string, sec16Hex?: string): Uint8Array {
  const buf = new Uint8Array(4096).fill(0xFF);

  // VIN offsets for Gen2 Type1
  const VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
  const SEC16_OFFSETS = [0x0EF5, 0x0F07];

  if (vin && vin.length === 17) {
    const vinBytes = new TextEncoder().encode(vin);
    const reversed = new Uint8Array(Array.from(vinBytes).reverse());
    const magic = 0xDB;
    const checksum = rfhGen2VinCs(reversed, magic);

    for (const off of VIN_OFFSETS) {
      for (let i = 0; i < 17; i++) buf[off + i] = reversed[i];
      buf[off + 17] = checksum;
    }
  }

  if (sec16Hex && sec16Hex.length === 32) {
    const sec16Bytes = new Uint8Array(16);
    for (let i = 0; i < 32; i += 2) {
      sec16Bytes[i / 2] = parseInt(sec16Hex.substring(i, i + 2), 16);
    }
    for (const off of SEC16_OFFSETS) {
      for (let i = 0; i < 16; i++) buf[off + i] = sec16Bytes[i];
      buf[off + 16] = 0xFD; // placeholder checksum
      buf[off + 17] = 0x00;
    }
  }

  return buf;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("computeSha256", () => {
  it("computes correct SHA-256 for known input", () => {
    const buf = Buffer.from("hello");
    const hash = computeSha256(buf);
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("handles Uint8Array input", () => {
    const buf = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const hash = computeSha256(buf);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SEC16 Synchronization", () => {
  const BCM_SEC16 = "555AAAF03A7824B694C25BC7E31BB6F0";
  const RFH_SEC16 = "F0B61BE3C75BC294B624783AF0AA5A55";

  it("bcmSec16ToRfh reverses byte order correctly", () => {
    const result = bcmSec16ToRfh(BCM_SEC16);
    expect(result).toBe(RFH_SEC16);
  });

  it("rfhSec16ToBcm reverses byte order back", () => {
    const result = rfhSec16ToBcm(RFH_SEC16);
    expect(result).toBe(BCM_SEC16);
  });

  it("round-trip preserves the original value", () => {
    const roundTrip = rfhSec16ToBcm(bcmSec16ToRfh(BCM_SEC16));
    expect(roundTrip).toBe(BCM_SEC16);
  });
});

describe("checkSafeMode", () => {
  it("blocks UNKNOWN module type", () => {
    const result = checkSafeMode({
      type: "UNKNOWN",
      fileSize: 1024,
      sha256: "abc",
      vinSlots: [],
      primaryVin: null,
      sec16Slots: [],
      primarySec16: null,
      keySlots: [],
      allChecksumsValid: false,
      gen2Detected: false,
      gen2Magic: null,
      sizeWarning: null,
      errors: [],
      warnings: [],
    });
    expect(result.allowed).toBe(false);
    expect((result as SafeModeRefusal).code).toBe("UNKNOWN_MODULE");
    expect((result as SafeModeRefusal).reason).toContain("Cannot identify module type");
  });

  it("blocks Gen2 without magic constant", () => {
    const result = checkSafeMode({
      type: "RFHUB",
      fileSize: 4096,
      sha256: "abc",
      vinSlots: [],
      primaryVin: null,
      sec16Slots: [],
      primarySec16: null,
      keySlots: [],
      allChecksumsValid: false,
      gen2Detected: true,
      gen2Magic: null,
      sizeWarning: null,
      errors: [],
      warnings: [],
    });
    expect(result.allowed).toBe(false);
    expect((result as SafeModeRefusal).code).toBe("INSUFFICIENT_GEN2_EVIDENCE");
  });

  it("blocks when no valid VIN found", () => {
    const result = checkSafeMode({
      type: "RFHUB",
      fileSize: 4096,
      sha256: "abc",
      vinSlots: [],
      primaryVin: null,
      sec16Slots: [],
      primarySec16: null,
      keySlots: [],
      allChecksumsValid: false,
      gen2Detected: true,
      gen2Magic: 0xDB,
      sizeWarning: null,
      errors: [],
      warnings: [],
    });
    expect(result.allowed).toBe(false);
    expect((result as SafeModeRefusal).code).toBe("NO_VALID_VIN");
  });

  it("allows valid Gen2 RFHUB with VIN and magic", () => {
    const result = checkSafeMode({
      type: "RFHUB",
      fileSize: 4096,
      sha256: "abc",
      vinSlots: [{ offset: 0, vin: "2C3CDXL92KH674464", checksumOk: true, checksumByte: 0xE9, expectedChecksum: 0xE9, mirrored: false, magic: 0xDB }],
      primaryVin: "2C3CDXL92KH674464",
      sec16Slots: [],
      primarySec16: null,
      keySlots: [],
      allChecksumsValid: true,
      gen2Detected: true,
      gen2Magic: 0xDB,
      sizeWarning: null,
      errors: [],
      warnings: [],
    });
    expect(result.allowed).toBe(true);
  });
});

describe("detectModuleType", () => {
  it("detects RFHUB from 4096-byte file", () => {
    const buf = new Uint8Array(4096);
    expect(detectModuleType(buf, "test.bin")).toBe("RFHUB");
  });

  it("detects BCM from 65536-byte file", () => {
    const buf = new Uint8Array(65536);
    expect(detectModuleType(buf, "test.bin")).toBe("BCM");
  });

  it("respects slotType override", () => {
    const buf = new Uint8Array(4096);
    expect(detectModuleType(buf, "test.bin", "PCM")).toBe("GPEC2A");
  });
});

describe("generateRfhCandidate", () => {
  const TEST_VIN = "2C3CDXL92KH674464";
  const TEST_SEC16 = "F0B61BE3C75BC294B624783AF0AA5A55";

  it("throws for non-4096 byte input", () => {
    const buf = new Uint8Array(1024);
    expect(() => generateRfhCandidate(buf, TEST_VIN, TEST_SEC16)).toThrow("4096-byte");
  });

  it("generates candidate with VIN and SEC16 changes", () => {
    const source = makeRfhGen2Buffer("AAAAAAAAAAAAAAAAA", "00000000000000000000000000000000");
    const result = generateRfhCandidate(source, TEST_VIN, TEST_SEC16);

    expect(result.data.length).toBe(4096);
    expect(result.sha256).toHaveLength(64);
    expect(result.changes.length).toBeGreaterThan(0);
    // Should have VIN slot changes + SEC16 slot changes
    const vinChanges = result.changes.filter(c => c.label?.includes("VIN"));
    const sec16Changes = result.changes.filter(c => c.label?.includes("SEC16"));
    expect(vinChanges.length).toBe(4); // 4 VIN slots
    expect(sec16Changes.length).toBe(2); // 2 SEC16 slots
  });

  it("uses XOR-magic checksum, never crc8rf", () => {
    const source = makeRfhGen2Buffer(TEST_VIN, TEST_SEC16);
    const newVin = "1C4RJFBG0LC100001";
    const result = generateRfhCandidate(source, newVin, TEST_SEC16);

    // Check that the VIN checksum byte at offset+17 matches rfhGen2VinCs
    const vinBytes = new TextEncoder().encode(newVin);
    const reversed = new Uint8Array(Array.from(vinBytes).reverse());
    const expectedCs = rfhGen2VinCs(reversed, 0xDB);

    // Read the checksum byte from the first VIN slot
    const firstVinOffset = 0x0EA5;
    expect(result.data[firstVinOffset + 17]).toBe(expectedCs);
  });

  it("reports no changes when VIN and SEC16 already match", () => {
    const source = makeRfhGen2Buffer(TEST_VIN, TEST_SEC16);
    // Re-generate with same VIN — VIN slots should match since we built them with same magic
    const result = generateRfhCandidate(source, TEST_VIN, TEST_SEC16);
    // VIN changes should be 0 since we wrote with same magic and VIN
    const vinChanges = result.changes.filter(c => c.label?.includes("VIN"));
    expect(vinChanges.length).toBe(0);
  });
});

describe("computeByteDiff", () => {
  it("reports no changes for identical buffers", () => {
    const buf = new Uint8Array(100).fill(0xAA);
    const report = computeByteDiff(buf, buf);
    expect(report.changedBytes).toBe(0);
    expect(report.regions).toHaveLength(0);
  });

  it("detects single-byte change", () => {
    const a = new Uint8Array(100).fill(0x00);
    const b = new Uint8Array(100).fill(0x00);
    b[50] = 0xFF;
    const report = computeByteDiff(a, b);
    expect(report.changedBytes).toBe(1);
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0].offsetStart).toBe(50);
    expect(report.regions[0].lengthBytes).toBe(1);
  });

  it("groups contiguous changes into regions", () => {
    const a = new Uint8Array(100).fill(0x00);
    const b = new Uint8Array(100).fill(0x00);
    // Two separate regions
    b[10] = 0x01; b[11] = 0x02; b[12] = 0x03;
    b[50] = 0xAA; b[51] = 0xBB;
    const report = computeByteDiff(a, b);
    expect(report.regions).toHaveLength(2);
    expect(report.regions[0].lengthBytes).toBe(3);
    expect(report.regions[1].lengthBytes).toBe(2);
    expect(report.changedBytes).toBe(5);
  });

  it("calculates percentage correctly", () => {
    const a = new Uint8Array(1000).fill(0x00);
    const b = new Uint8Array(1000).fill(0x00);
    for (let i = 0; i < 100; i++) b[i] = 0xFF;
    const report = computeByteDiff(a, b);
    expect(report.changedPercent).toBeCloseTo(10, 1);
  });
});

describe("threeWayCompare", () => {
  it("identifies runtime rewrites correctly", () => {
    const corrected = new Uint8Array(4096).fill(0x00);
    const preBench = new Uint8Array(4096).fill(0x00);
    const postBench = new Uint8Array(4096).fill(0x00);

    // Corrected changed offset 0x0100 (this is an intentional write)
    corrected[0x0100] = 0xAA;

    // Runtime rewrite: post-bench changed offset 0x0500 (not in corrected changes)
    postBench[0x0500] = 0xBB;

    const result = threeWayCompare(corrected, preBench, postBench);

    // corrected vs pre should show the 0x0100 change
    expect(result.correctedVsPre.changedBytes).toBeGreaterThan(0);

    // pre vs post should show the 0x0500 change
    expect(result.preVsPost.changedBytes).toBeGreaterThan(0);

    // Runtime rewrites should include the 0x0500 change
    expect(result.runtimeRewrites.length).toBeGreaterThan(0);
    expect(result.runtimeRewrites.some(r => r.offsetStart === 0x0500)).toBe(true);
  });

  it("flags learned-state region changes", () => {
    const corrected = new Uint8Array(4096).fill(0x00);
    const preBench = new Uint8Array(4096).fill(0x00);
    const postBench = new Uint8Array(4096).fill(0x00);

    // Change in learned-state region (0x0880–0x09FF)
    postBench[0x0900] = 0xCC;
    postBench[0x0901] = 0xDD;

    const result = threeWayCompare(corrected, preBench, postBench);
    expect(result.learnedStateRegions.length).toBeGreaterThan(0);
    expect(result.learnedStateRegions.some(r => r.offsetStart >= 0x0880 && r.offsetEnd <= 0x09FF)).toBe(true);
  });
});
