/* analysisDiff.test.js — Vitest coverage for the analysis comparator. */

import { describe, it, expect } from "vitest";
import {
  compareAnalyses,
  compareRawBytes,
  buildProgrammerBlock,
  computeByteDiff,
  diffParseResult,
  WELL_KNOWN_DIDS,
  FIELD_CATEGORIES,
} from "../analysisDiff.js";

/* ── Fixture helpers ─────────────────────────────────────────────────── */

function makeBackup(overrides = {}) {
  return {
    module: "BCM",
    vin: "1C4RJFLG5JC200001",
    timestamp: "2024-01-01T00:00:00Z",
    dids: {},
    ...overrides,
  };
}

function makeDid(hex, ascii = null, name = null, critical = false) {
  return { hex, ascii, name, critical, missing: false };
}

/* DID numbers (decimal) matching how the dids map stores them. */
const VIN_DID    = 61840;   // 0xF190
const SEC16_DID  = 20360;   // 0x4F88
const SKIM_DID   = 16896;   // 0x4200
const CAL_DID    = 61836;   // 0xF18C — Calibration / Tune ID
const SW_DID     = 61832;   // 0xF188 — Software Version

/* ── Fixture: matching pair ──────────────────────────────────────────── */

const MATCHING_A = makeBackup({
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 30 30 30 30 31", "1C4RJFLG5JC200001", "VIN", true),
    [SEC16_DID]: makeDid("AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99", null, "SEC16"),
    [SKIM_DID]:  makeDid("01 02 03", null, "SKIM"),
  },
});

const MATCHING_B = makeBackup({
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 30 30 30 30 31", "1C4RJFLG5JC200001", "VIN", true),
    [SEC16_DID]: makeDid("AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99", null, "SEC16"),
    [SKIM_DID]:  makeDid("01 02 03", null, "SKIM"),
  },
});

/* ── Fixture: all-different pair ─────────────────────────────────────── */

const ALL_DIFF_A = makeBackup({
  vin: "1C4RJFLG5JC111111",
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 31 31 31 31 31 31", "1C4RJFLG5JC111111", "VIN", true),
    [SEC16_DID]: makeDid("AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99", null, "SEC16"),
  },
});

const ALL_DIFF_B = makeBackup({
  vin: "1C4RJFLG5JC222222",
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 32 32 32 32 32", "1C4RJFLG5JC222222", "VIN", true),
    [SEC16_DID]: makeDid("11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00", null, "SEC16"),
  },
});

/* ── Fixture: partial-overlap pair ───────────────────────────────────── */

const PARTIAL_A = makeBackup({
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 30 30 30 30 31", "1C4RJFLG5JC200001", "VIN", true),
    [SEC16_DID]: makeDid("AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99", null, "SEC16"),
  },
});

const PARTIAL_B = makeBackup({
  dids: {
    [VIN_DID]:   makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 30 30 30 30 31", "1C4RJFLG5JC200001", "VIN", true),
    [SKIM_DID]:  makeDid("80", null, "SKIM"),
  },
});

/* ── Fixture: named-field extraction (rich backup with well-known DIDs) ── */

const NAMED_FIELD_A = makeBackup({
  module: "ECM",
  vin: "1C4RJFLG5JC111111",
  dids: {
    [VIN_DID]:  makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 31 31 31 31 31 31", "1C4RJFLG5JC111111", "VIN", true),
    [CAL_DID]:  makeDid("56 31 2E 30 30 00 00 00", null, "Calibration ID"),
    [SW_DID]:   makeDid("30 38 2E 30 30 00 00 00", null, "Software Version"),
    [SEC16_DID]:makeDid("AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99", null, "SEC16"),
  },
});

const NAMED_FIELD_B = makeBackup({
  module: "ECM",
  vin: "1C4RJFLG5JC222222",
  dids: {
    [VIN_DID]:  makeDid("31 43 34 52 4A 46 4C 47 35 4A 43 32 32 32 32 32 32", "1C4RJFLG5JC222222", "VIN", true),
    [CAL_DID]:  makeDid("56 31 2E 31 30 00 00 00", null, "Calibration ID"),  // different tune
    [SW_DID]:   makeDid("30 38 2E 30 30 00 00 00", null, "Software Version"), // same SW
    [SEC16_DID]:makeDid("11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00", null, "SEC16"),
  },
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("compareAnalyses", () => {
  describe("matching pair", () => {
    it("reports all fields as same when blobs are identical", () => {
      const result = compareAnalyses(MATCHING_A, MATCHING_B);
      expect(result.fields.every((f) => f.status === "same")).toBe(true);
    });

    it("summary counts match total with zero diff", () => {
      const { summary } = compareAnalyses(MATCHING_A, MATCHING_B);
      expect(summary.same).toBe(3);
      expect(summary.different).toBe(0);
      expect(summary.aOnly).toBe(0);
      expect(summary.bOnly).toBe(0);
      expect(summary.total).toBe(3);
    });

    it("regions array is empty when blobs match", () => {
      const { regions } = compareAnalyses(MATCHING_A, MATCHING_B);
      expect(regions).toHaveLength(0);
    });

    it("metadata.vin.match is true when both VIN DIDs are identical", () => {
      const { metadata } = compareAnalyses(MATCHING_A, MATCHING_B);
      expect(metadata.vin.match).toBe(true);
    });

    it("metadata.moduleType.match is true when both blobs have the same module", () => {
      const { metadata } = compareAnalyses(MATCHING_A, MATCHING_B);
      expect(metadata.moduleType.match).toBe(true);
      expect(metadata.moduleType.a).toBe("BCM");
    });
  });

  describe("all-different pair", () => {
    it("marks every field as different", () => {
      const { fields } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      expect(fields.every((f) => f.status === "different")).toBe(true);
    });

    it("summary.different equals total", () => {
      const { summary } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      expect(summary.different).toBe(2);
      expect(summary.same).toBe(0);
    });

    it("each differing field has a non-empty regions entry", () => {
      const { regions, fields } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      const diffFields = fields.filter((f) => f.status !== "same");
      expect(regions).toHaveLength(diffFields.length);
    });

    it("regions carry byte-level diff indices", () => {
      const { regions } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      regions.forEach((r) => {
        expect(Array.isArray(r.diffIndices)).toBe(true);
        expect(r.diffIndices.length).toBeGreaterThan(0);
      });
    });

    it("regions include contiguousRanges with start/end/length", () => {
      const { regions } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      regions.forEach((r) => {
        expect(Array.isArray(r.contiguousRanges)).toBe(true);
        r.contiguousRanges.forEach((range) => {
          expect(typeof range.start).toBe("number");
          expect(typeof range.end).toBe("number");
          expect(typeof range.length).toBe("number");
          expect(range.end).toBeGreaterThanOrEqual(range.start);
          expect(range.length).toBe(range.end - range.start + 1);
        });
      });
    });

    it("regions include didHex string like '0xF190'", () => {
      const { regions } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      regions.forEach((r) => {
        expect(typeof r.didHex).toBe("string");
        expect(r.didHex).toMatch(/^0x[0-9A-F]+$/i);
      });
    });
  });

  describe("partial-overlap pair", () => {
    it("VIN is same, SEC16 is a_only, SKIM is b_only", () => {
      const { fields } = compareAnalyses(PARTIAL_A, PARTIAL_B);
      const vinField  = fields.find((f) => f.did === VIN_DID);
      const secField  = fields.find((f) => f.did === SEC16_DID);
      const skimField = fields.find((f) => f.did === SKIM_DID);
      expect(vinField?.status).toBe("same");
      expect(secField?.status).toBe("a_only");
      expect(skimField?.status).toBe("b_only");
    });

    it("summary counts a_only and b_only correctly", () => {
      const { summary } = compareAnalyses(PARTIAL_A, PARTIAL_B);
      expect(summary.same).toBe(1);
      expect(summary.aOnly).toBe(1);
      expect(summary.bOnly).toBe(1);
      expect(summary.different).toBe(0);
      expect(summary.total).toBe(3);
    });

    it("a_only field has aHex populated, bHex is null", () => {
      const { fields } = compareAnalyses(PARTIAL_A, PARTIAL_B);
      const secField = fields.find((f) => f.did === SEC16_DID);
      expect(secField?.aHex).toBeTruthy();
      expect(secField?.bHex).toBeNull();
    });

    it("b_only field has bHex populated, aHex is null", () => {
      const { fields } = compareAnalyses(PARTIAL_A, PARTIAL_B);
      const skimField = fields.find((f) => f.did === SKIM_DID);
      expect(skimField?.bHex).toBeTruthy();
      expect(skimField?.aHex).toBeNull();
    });
  });

  describe("summary metadata", () => {
    it("carries module, VIN, and timestamp from each blob", () => {
      const { summary } = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
      expect(summary.moduleA).toBe("BCM");
      expect(summary.moduleB).toBe("BCM");
      expect(summary.vinA).toBe("1C4RJFLG5JC111111");
      expect(summary.vinB).toBe("1C4RJFLG5JC222222");
    });
  });

  describe("named analysis fields in metadata (parseModule vocabulary)", () => {
    it("extracts VIN from DID 0xF190 as metadata.vin", () => {
      const { metadata } = compareAnalyses(NAMED_FIELD_A, NAMED_FIELD_B);
      expect(metadata.vin).toBeTruthy();
      expect(metadata.vin.match).toBe(false);   // different VINs
      expect(metadata.vin.a).toBeTruthy();       // A-side populated
      expect(metadata.vin.b).toBeTruthy();       // B-side populated
    });

    it("extracts calibrationId from DID 0xF18C as metadata.calibrationId", () => {
      const { metadata } = compareAnalyses(NAMED_FIELD_A, NAMED_FIELD_B);
      expect(metadata.calibrationId).toBeTruthy();
      expect(metadata.calibrationId.match).toBe(false); // different tunes
    });

    it("marks softwareVersion as matching when both sides agree", () => {
      const { metadata } = compareAnalyses(NAMED_FIELD_A, NAMED_FIELD_B);
      expect(metadata.softwareVersion.match).toBe(true);
    });

    it("metadata.securityBytes reports mismatch for different SEC16", () => {
      const { metadata } = compareAnalyses(NAMED_FIELD_A, NAMED_FIELD_B);
      expect(metadata.securityBytes.match).toBe(false);
    });

    it("metadata.moduleType is present and carries module name", () => {
      const { metadata } = compareAnalyses(NAMED_FIELD_A, NAMED_FIELD_B);
      expect(metadata.moduleType.a).toBe("ECM");
      expect(metadata.moduleType.b).toBe("ECM");
      expect(metadata.moduleType.match).toBe(true);
    });
  });

  describe("field category assignment", () => {
    it("VIN DID gets VIN category", () => {
      const a = makeBackup({ dids: { [VIN_DID]: makeDid("31", null, "VIN") } });
      const { fields } = compareAnalyses(a, makeBackup());
      const vinField = fields.find((f) => f.did === VIN_DID);
      expect(vinField?.category).toBe(FIELD_CATEGORIES.VIN);
    });

    it("SEC16 DID gets Security/Pairing category", () => {
      const a = makeBackup({ dids: { [SEC16_DID]: makeDid("AA BB", null, "SEC16") } });
      const { fields } = compareAnalyses(a, makeBackup());
      const sec = fields.find((f) => f.did === SEC16_DID);
      expect(sec?.category).toBe(FIELD_CATEGORIES.SECURITY);
    });

    it("unknown DID falls back to OTHER category", () => {
      const UNKNOWN_DID = 99999;
      const a = makeBackup({ dids: { [UNKNOWN_DID]: makeDid("01", null, "Unknown") } });
      const { fields } = compareAnalyses(a, makeBackup());
      const unknown = fields.find((f) => f.did === UNKNOWN_DID);
      expect(unknown?.category).toBe(FIELD_CATEGORIES.OTHER);
    });
  });

  describe("edge cases", () => {
    it("handles null/undefined blobs without throwing", () => {
      expect(() => compareAnalyses(null, null)).not.toThrow();
      expect(() => compareAnalyses(undefined, makeBackup())).not.toThrow();
    });

    it("handles empty dids objects", () => {
      const { fields, summary } = compareAnalyses(makeBackup(), makeBackup());
      expect(fields).toHaveLength(0);
      expect(summary.total).toBe(0);
    });

    it("fields are sorted by DID number ascending", () => {
      const a = makeBackup({ dids: {
        [SKIM_DID]:  makeDid("01", null, "SKIM"),
        [VIN_DID]:   makeDid("11", null, "VIN"),
        [SEC16_DID]: makeDid("22", null, "SEC16"),
      }});
      const b = makeBackup({ dids: {
        [SKIM_DID]:  makeDid("FF", null, "SKIM"),
        [VIN_DID]:   makeDid("FF", null, "VIN"),
        [SEC16_DID]: makeDid("FF", null, "SEC16"),
      }});
      const { fields } = compareAnalyses(a, b);
      const dids = fields.map((f) => f.did);
      expect(dids).toEqual([...dids].sort((x, y) => x - y));
    });

    it("missing DID (missing flag set) is treated as absent value", () => {
      const missingRec = { hex: null, ascii: null, name: "VIN", missing: true };
      const a = makeBackup({ dids: { [VIN_DID]: missingRec } });
      const b = makeBackup({ dids: { [VIN_DID]: makeDid("31 43 34", null, "VIN") } });
      const { fields } = compareAnalyses(a, b);
      const vin = fields.find((f) => f.did === VIN_DID);
      expect(vin?.status).toBe("different");
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("buildProgrammerBlock", () => {
  it("returns empty array for matching pair", () => {
    const diff = compareAnalyses(MATCHING_A, MATCHING_B);
    expect(buildProgrammerBlock(diff)).toHaveLength(0);
  });

  it("returns one row per differing field", () => {
    const diff = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
    const block = buildProgrammerBlock(diff);
    const diffCount = diff.fields.filter((f) => f.status !== "same").length;
    expect(block).toHaveLength(diffCount);
  });

  it("row carries type: 'uds_did_write' identifying it as a UDS DID write op", () => {
    const diff = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
    const block = buildProgrammerBlock(diff);
    block.forEach((row) => {
      expect(row.type).toBe("uds_did_write");
    });
  });

  it("row shape matches fix plan builder contract {type,offset,current,target,label}", () => {
    const diff = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
    const block = buildProgrammerBlock(diff);
    block.forEach((row) => {
      expect(typeof row.type).toBe("string");
      expect(typeof row.offset).toBe("string");
      expect(row.offset).toMatch(/^0x[0-9A-F]+$/i);
      expect(typeof row.current).toBe("string");
      expect(typeof row.target).toBe("string");
      expect(typeof row.label).toBe("string");
    });
  });

  it("offset encodes the DID as a hex string (0xF190 for VIN_DID)", () => {
    const diff = compareAnalyses(ALL_DIFF_A, ALL_DIFF_B);
    const block = buildProgrammerBlock(diff);
    const vinRow = block.find((r) => r.offset === "0x" + VIN_DID.toString(16).toUpperCase().padStart(4, "0"));
    expect(vinRow).toBeTruthy();
  });

  it("a_only fields use (missing) for target", () => {
    const diff = compareAnalyses(PARTIAL_A, PARTIAL_B);
    const block = buildProgrammerBlock(diff);
    const secRow = block.find((r) => r.offset === "0x" + SEC16_DID.toString(16).toUpperCase().padStart(4, "0"));
    expect(secRow?.target).toBe("(missing)");
  });

  it("handles null diff result without throwing", () => {
    expect(() => buildProgrammerBlock(null)).not.toThrow();
    expect(buildProgrammerBlock(null)).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("computeByteDiff", () => {
  it("returns empty diffIndices for identical hex strings", () => {
    const { diffIndices } = computeByteDiff("AA BB CC", "AA BB CC");
    expect(diffIndices).toHaveLength(0);
  });

  it("identifies differing byte positions", () => {
    const { diffIndices } = computeByteDiff("AA BB CC", "AA 00 CC");
    expect(diffIndices).toEqual([1]);
  });

  it("pads shorter input to align with longer", () => {
    const { aBytes, bBytes } = computeByteDiff("AA", "AA BB");
    expect(aBytes.length).toBe(2);
    expect(bBytes.length).toBe(2);
  });

  it("handles empty hex strings", () => {
    const { diffIndices } = computeByteDiff("", "");
    expect(diffIndices).toHaveLength(0);
  });

  it("treats all bytes as diff when one side is empty", () => {
    const { diffIndices } = computeByteDiff("", "AA BB CC");
    expect(diffIndices).toHaveLength(3);
  });

  it("builds contiguous ranges from adjacent diff indices", () => {
    const { contiguousRanges } = computeByteDiff("AA BB CC DD EE", "AA 00 00 00 EE");
    expect(contiguousRanges).toHaveLength(1);
    expect(contiguousRanges[0]).toMatchObject({ start: 1, end: 3, length: 3 });
  });

  it("builds multiple ranges from non-adjacent diff indices", () => {
    const { contiguousRanges } = computeByteDiff("AA BB CC DD EE", "00 BB 00 DD 00");
    expect(contiguousRanges).toHaveLength(3);
    expect(contiguousRanges[0]).toMatchObject({ start: 0, end: 0, length: 1 });
    expect(contiguousRanges[1]).toMatchObject({ start: 2, end: 2, length: 1 });
    expect(contiguousRanges[2]).toMatchObject({ start: 4, end: 4, length: 1 });
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("compareRawBytes — true file-offset binary diff", () => {
  it("returns no regions when both arrays are identical", () => {
    const a = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const b = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const { rawByteRegions, totalDiffBytes } = compareRawBytes(a, b);
    expect(rawByteRegions).toHaveLength(0);
    expect(totalDiffBytes).toBe(0);
  });

  it("returns no regions when both inputs are null/undefined", () => {
    const { rawByteRegions, totalDiffBytes } = compareRawBytes(null, null);
    expect(rawByteRegions).toHaveLength(0);
    expect(totalDiffBytes).toBe(0);
  });

  it("detects a single differing byte and reports its absolute offset", () => {
    const a = new Uint8Array([0x00, 0x01, 0x02, 0xFF]);
    const b = new Uint8Array([0x00, 0x01, 0xAA, 0xFF]);
    const { rawByteRegions } = compareRawBytes(a, b);
    expect(rawByteRegions).toHaveLength(1);
    expect(rawByteRegions[0].offset).toBe(2);
    expect(rawByteRegions[0].offsetHex).toBe("0x000002");
    expect(rawByteRegions[0].length).toBe(1);
  });

  it("groups adjacent diff bytes into a single contiguous region", () => {
    const a = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const b = new Uint8Array([0x00, 0xAA, 0xBB, 0xCC, 0x04]);
    const { rawByteRegions, totalDiffBytes } = compareRawBytes(a, b);
    expect(rawByteRegions).toHaveLength(1);
    expect(rawByteRegions[0].offset).toBe(1);
    expect(rawByteRegions[0].length).toBe(3);
    expect(totalDiffBytes).toBe(3);
  });

  it("produces two separate regions for non-adjacent diff spans", () => {
    const a = new Uint8Array([0xAA, 0x00, 0xBB, 0x00, 0xCC]);
    const b = new Uint8Array([0x11, 0x00, 0xBB, 0x00, 0x22]);
    const { rawByteRegions } = compareRawBytes(a, b);
    expect(rawByteRegions).toHaveLength(2);
    expect(rawByteRegions[0].offset).toBe(0);
    expect(rawByteRegions[1].offset).toBe(4);
  });

  it("region aHex and bHex are space-separated byte hex strings", () => {
    const a = new Uint8Array([0xDE, 0xAD]);
    const b = new Uint8Array([0xBE, 0xEF]);
    const { rawByteRegions } = compareRawBytes(a, b);
    expect(rawByteRegions[0].aHex).toBe("DE AD");
    expect(rawByteRegions[0].bHex).toBe("BE EF");
  });

  it("pads the shorter array with zeros when lengths differ", () => {
    const a = new Uint8Array([0x01, 0x02]);
    const b = new Uint8Array([0x01, 0x02, 0xFF]);
    const { rawByteRegions } = compareRawBytes(a, b);
    expect(rawByteRegions).toHaveLength(1);
    expect(rawByteRegions[0].offset).toBe(2);
  });

  it("accepts plain number[] arrays", () => {
    const { rawByteRegions } = compareRawBytes([0x01], [0x02]);
    expect(rawByteRegions).toHaveLength(1);
    expect(rawByteRegions[0].offset).toBe(0);
  });

  it("computes diffIndices relative to the start of the region", () => {
    const a = new Uint8Array([0x00, 0xAA, 0xBB]);
    const b = new Uint8Array([0x00, 0xAA, 0x00]);
    const { rawByteRegions } = compareRawBytes(a, b);
    expect(rawByteRegions[0].diffIndices).toEqual([0]);
    expect(rawByteRegions[0].offset).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("compareAnalyses — rawByteRegions integration", () => {
  it("rawByteRegions is null when neither blob has rawBytes", () => {
    const a = makeBackup({ dids: {} });
    const b = makeBackup({ dids: {} });
    expect(compareAnalyses(a, b).rawByteRegions).toBeNull();
  });

  it("rawByteRegions is null when only one blob has rawBytes", () => {
    const a = makeBackup({ dids: {}, rawBytes: new Uint8Array([0xAA]) });
    const b = makeBackup({ dids: {} });
    expect(compareAnalyses(a, b).rawByteRegions).toBeNull();
  });

  it("rawByteRegions is computed when both blobs have rawBytes", () => {
    const a = makeBackup({ dids: {}, rawBytes: new Uint8Array([0x01, 0x02]) });
    const b = makeBackup({ dids: {}, rawBytes: new Uint8Array([0x01, 0xFF]) });
    const result = compareAnalyses(a, b);
    expect(Array.isArray(result.rawByteRegions)).toBe(true);
    expect(result.rawByteRegions).toHaveLength(1);
    expect(result.rawByteRegions[0].offset).toBe(1);
  });

  it("summary.hasRawDiff is true when rawByteRegions are present", () => {
    const a = makeBackup({ dids: {}, rawBytes: new Uint8Array([0x00]) });
    const b = makeBackup({ dids: {}, rawBytes: new Uint8Array([0xFF]) });
    expect(compareAnalyses(a, b).summary.hasRawDiff).toBe(true);
  });

  it("summary.hasRawDiff is false when rawBytes absent", () => {
    const a = makeBackup({ dids: {} });
    const b = makeBackup({ dids: {} });
    expect(compareAnalyses(a, b).summary.hasRawDiff).toBe(false);
  });

  it("summary.totalRawDiffBytes counts differing bytes", () => {
    const a = makeBackup({ dids: {}, rawBytes: new Uint8Array([0xAA, 0xBB, 0xCC]) });
    const b = makeBackup({ dids: {}, rawBytes: new Uint8Array([0x11, 0x22, 0xCC]) });
    expect(compareAnalyses(a, b).summary.totalRawDiffBytes).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("buildProgrammerBlock — raw_patch rows", () => {
  it("emits raw_patch rows for each rawByteRegion", () => {
    const diffResult = {
      fields: [],
      rawByteRegions: [
        { offset: 0x4B20, offsetHex: "0x004B20", length: 4, aHex: "AA BB CC DD", bHex: "11 22 33 44", diffIndices: [0,1,2,3] },
      ],
    };
    const block = buildProgrammerBlock(diffResult);
    expect(block).toHaveLength(1);
    expect(block[0].type).toBe("raw_patch");
    expect(block[0].offset).toBe("0x004B20");
    expect(block[0].current).toBe("AA BB CC DD");
    expect(block[0].target).toBe("11 22 33 44");
  });

  it("raw_patch label includes offset and byte count", () => {
    const diffResult = {
      fields: [],
      rawByteRegions: [
        { offset: 0, offsetHex: "0x000000", length: 16, aHex: "AA", bHex: "BB", diffIndices: [0] },
      ],
    };
    const block = buildProgrammerBlock(diffResult);
    expect(block[0].label).toContain("0x000000");
    expect(block[0].label).toContain("16 bytes");
  });

  it("raw_patch label uses singular 'byte' for length 1", () => {
    const diffResult = {
      fields: [],
      rawByteRegions: [
        { offset: 5, offsetHex: "0x000005", length: 1, aHex: "AA", bHex: "BB", diffIndices: [0] },
      ],
    };
    const block = buildProgrammerBlock(diffResult);
    expect(block[0].label).toMatch(/1 byte(?!s)/);
  });

  it("emits both uds_did_write and raw_patch rows when both sources present", () => {
    const diffResult = {
      fields: [
        { did: 61840, status: "different", label: "VIN", aHex: "AA", bHex: "BB" },
      ],
      rawByteRegions: [
        { offset: 0, offsetHex: "0x000000", length: 2, aHex: "CC DD", bHex: "EE FF", diffIndices: [0,1] },
      ],
    };
    const block = buildProgrammerBlock(diffResult);
    expect(block).toHaveLength(2);
    const types = block.map((r) => r.type);
    expect(types).toContain("uds_did_write");
    expect(types).toContain("raw_patch");
  });

  it("emits no raw_patch rows when rawByteRegions is null", () => {
    const diffResult = {
      fields: [],
      rawByteRegions: null,
    };
    expect(buildProgrammerBlock(diffResult)).toHaveLength(0);
  });

  it("emits no raw_patch rows when rawByteRegions is empty", () => {
    const diffResult = { fields: [], rawByteRegions: [] };
    expect(buildProgrammerBlock(diffResult)).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("WELL_KNOWN_DIDS catalog", () => {
  it("maps 0xF190 (61840) to VIN category", () => {
    expect(WELL_KNOWN_DIDS[61840]?.category).toBe(FIELD_CATEGORIES.VIN);
  });

  it("maps SEC16 DID 20360 to Security/Pairing category", () => {
    expect(WELL_KNOWN_DIDS[20360]?.category).toBe(FIELD_CATEGORIES.SECURITY);
  });

  it("maps calibration DID 61836 to Calibration/Software category", () => {
    expect(WELL_KNOWN_DIDS[61836]?.category).toBe(FIELD_CATEGORIES.CALIBRATION);
  });

  it("every entry has a non-empty label and a valid category", () => {
    for (const [, entry] of Object.entries(WELL_KNOWN_DIDS)) {
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
      expect(Object.values(FIELD_CATEGORIES)).toContain(entry.category);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════ */

describe("diffParseResult — parseModule field comparison", () => {
  /* ── helpers ─────────────────────────────────────────────────────── */
  function makeParseResult(overrides = {}) {
    return {
      type:          "GPEC2A",
      name:          "GPEC2A (PCM/ECM)",
      size:          4096,
      partNumberStr: "68000001AB",
      skimByte:      0x01,
      skimStatus:    "SKIM ACTIVE",
      secretKey:     { hex: "AA BB CC DD EE FF 00 11" },
      secretKeyMirror: { hex: "AA BB CC DD EE FF 00 11" },
      keyConsistent: true,
      vin:           null,
      vins:          [{ offset: 0x10, vin: "1C4RJFLG5JC200001" }],
      transponderKeys: [
        { hex: "01020304" },
        { hex: "05060708" },
        { hex: null },
        { hex: null },
      ],
      runtimeCounters: {
        counterA:  { value: 1000 },
        counterB:  { value:  500 },
        distance:  { value: 9999 },
        keyCycles: { value:  200 },
      },
      zzzzTamper: null,
      ...overrides,
    };
  }

  /* ── null / missing inputs ──────────────────────────────────────── */
  it("returns null when both parseResults are null", () => {
    expect(diffParseResult(null, null)).toBeNull();
  });

  it("returns null when both parseResults are undefined", () => {
    expect(diffParseResult(undefined, undefined)).toBeNull();
  });

  /* ── identical parseResults ─────────────────────────────────────── */
  it("returns all-same rows when both parseResults are identical", () => {
    const p = makeParseResult();
    const rows = diffParseResult(p, p);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => expect(r.status).toBe("same"));
  });

  /* ── single-side-only input ─────────────────────────────────────── */
  it("marks all fields as a_only when B is null", () => {
    const rows = diffParseResult(makeParseResult(), null);
    expect(Array.isArray(rows)).toBe(true);
    const nonSame = rows.filter((r) => r.status !== "same");
    expect(nonSame.length).toBeGreaterThan(0);
    nonSame.forEach((r) => expect(r.status).toBe("a_only"));
  });

  it("marks all fields as b_only when A is null", () => {
    const rows = diffParseResult(null, makeParseResult());
    const nonSame = rows.filter((r) => r.status !== "same");
    expect(nonSame.length).toBeGreaterThan(0);
    nonSame.forEach((r) => expect(r.status).toBe("b_only"));
  });

  /* ── differing scalar fields ────────────────────────────────────── */
  it("detects a changed module type as 'different'", () => {
    const a = makeParseResult({ type: "GPEC2A" });
    const b = makeParseResult({ type: "BCM" });
    const rows = diffParseResult(a, b);
    const typeRow = rows.find((r) => r.label === "Module Type");
    expect(typeRow).toBeDefined();
    expect(typeRow.status).toBe("different");
    expect(typeRow.aVal).toBe("GPEC2A");
    expect(typeRow.bVal).toBe("BCM");
  });

  it("detects a changed SKIM byte as 'different'", () => {
    const a = makeParseResult({ skimByte: 0x01, skimStatus: "SKIM ACTIVE" });
    const b = makeParseResult({ skimByte: 0x00, skimStatus: "SKIM OFF" });
    const rows = diffParseResult(a, b);
    const skimRow = rows.find((r) => r.label === "SKIM Byte");
    expect(skimRow.status).toBe("different");
    expect(skimRow.aVal).toMatch(/0x01/i);
    expect(skimRow.bVal).toMatch(/0x00/i);
  });

  it("detects a changed secret key as 'different'", () => {
    const a = makeParseResult({ secretKey: { hex: "AA BB CC DD EE FF 00 11" } });
    const b = makeParseResult({ secretKey: { hex: "00 00 00 00 00 00 00 00" } });
    const rows = diffParseResult(a, b);
    const keyRow = rows.find((r) => r.label === "Secret Key");
    expect(keyRow.status).toBe("different");
  });

  it("detects a changed part number as 'different'", () => {
    const a = makeParseResult({ partNumberStr: "68000001AB" });
    const b = makeParseResult({ partNumberStr: "68000002XY" });
    const rows = diffParseResult(a, b);
    const pnRow = rows.find((r) => r.label === "Part Number");
    expect(pnRow.status).toBe("different");
    expect(pnRow.aVal).toBe("68000001AB");
    expect(pnRow.bVal).toBe("68000002XY");
  });

  /* ── VIN slot extraction ────────────────────────────────────────── */
  it("surfaces VIN slot 0 under the 'VIN (binary)' label from vins array", () => {
    const a = makeParseResult();
    const b = makeParseResult({ vins: [{ offset: 0x10, vin: "1C4RJFLG5JC999999" }] });
    const rows = diffParseResult(a, b);
    const vinRow = rows.find((r) => r.label === "VIN (binary)");
    expect(vinRow).toBeDefined();
    expect(vinRow.status).toBe("different");
  });

  /* ── transponder key slots ──────────────────────────────────────── */
  it("surfaces transponder keys and detects when slot 0 changes", () => {
    const a = makeParseResult();
    const b = makeParseResult({ transponderKeys: [{ hex: "AABBCCDD" }, { hex: "05060708" }, { hex: null }, { hex: null }] });
    const rows = diffParseResult(a, b);
    const tkRow = rows.find((r) => r.label === "Transponder Key 0");
    expect(tkRow).toBeDefined();
    expect(tkRow.status).toBe("different");
  });

  /* ── runtime counters ───────────────────────────────────────────── */
  it("detects a changed distance counter", () => {
    const a = makeParseResult();
    const b = makeParseResult({ runtimeCounters: { counterA: { value: 1000 }, counterB: { value: 500 }, distance: { value: 50000 }, keyCycles: { value: 200 } } });
    const rows = diffParseResult(a, b);
    const distRow = rows.find((r) => r.label === "Distance Counter");
    expect(distRow.status).toBe("different");
    expect(distRow.aVal).toBe("9999");
    expect(distRow.bVal).toBe("50000");
  });

  /* ── result ordering ────────────────────────────────────────────── */
  it("differing rows appear before same rows in the result", () => {
    const a = makeParseResult({ type: "GPEC2A" });
    const b = makeParseResult({ type: "BCM" });
    const rows = diffParseResult(a, b);
    const firstSameIdx = rows.findIndex((r) => r.status === "same");
    const lastDiffIdx  = rows.map((r, i) => r.status !== "same" ? i : -1).filter((i) => i >= 0).pop();
    if (firstSameIdx >= 0 && lastDiffIdx !== undefined) {
      expect(lastDiffIdx).toBeLessThan(firstSameIdx);
    }
  });

  /* ── compareAnalyses integration ────────────────────────────────── */
  it("compareAnalyses populates parsedFields when both blobs have parseResult", () => {
    const parseA = makeParseResult({ type: "GPEC2A" });
    const parseB = makeParseResult({ type: "BCM" });
    const result = compareAnalyses(
      makeBackup({ parseResult: parseA }),
      makeBackup({ parseResult: parseB }),
    );
    expect(Array.isArray(result.parsedFields)).toBe(true);
    expect(result.parsedFields.length).toBeGreaterThan(0);
  });

  it("compareAnalyses parsedFields is null when neither blob has parseResult", () => {
    const result = compareAnalyses(makeBackup(), makeBackup());
    expect(result.parsedFields).toBeNull();
  });

  it("compareAnalyses summary.parsedDiff counts differing parsed fields", () => {
    const parseA = makeParseResult({ type: "GPEC2A" });
    const parseB = makeParseResult({ type: "BCM" });
    const result = compareAnalyses(
      makeBackup({ parseResult: parseA }),
      makeBackup({ parseResult: parseB }),
    );
    expect(result.summary.parsedDiff).toBeGreaterThanOrEqual(1);
  });

  it("compareAnalyses summary.parsedDiff is 0 when parsed fields are identical", () => {
    const parse = makeParseResult();
    const result = compareAnalyses(
      makeBackup({ parseResult: parse }),
      makeBackup({ parseResult: parse }),
    );
    expect(result.summary.parsedDiff).toBe(0);
  });
});
