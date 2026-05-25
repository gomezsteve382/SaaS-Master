import { describe, it, expect } from "vitest";
import {
  parsePatternLookupOffsets,
  parseKgQueryBcmFeatures,
  parseKgQueryUnlocks,
} from "../swarmToolResultParse.js";

describe("parsePatternLookupOffsets", () => {
  it("extracts hex offsets from pattern_lookup result lines", () => {
    const text = [
      `3 match(es) for "AA 50" in primary (65536 bytes):`,
      ``,
      `0x000880  00 11 22 AA 50 33 44 55 66 77 88 99`,
      `0x002023  AA BB CC AA 50 DD EE FF`,
      `0x00F100  10 20 AA 50 30 40`,
    ].join("\n");
    expect(parsePatternLookupOffsets(text)).toEqual([0x0880, 0x2023, 0xF100]);
  });

  it("returns empty list for the no-match message", () => {
    expect(parsePatternLookupOffsets("No matches for hex pattern \"DE AD\" in primary.")).toEqual([]);
  });

  it("ignores non-offset lines and dedupes", () => {
    const text = `header line\n0x000010 aa\nrandom\n0x000010 bb\n0x000020 cc`;
    expect(parsePatternLookupOffsets(text)).toEqual([0x10, 0x20]);
  });

  it("handles bad input safely", () => {
    expect(parsePatternLookupOffsets(null)).toEqual([]);
    expect(parsePatternLookupOffsets("")).toEqual([]);
    expect(parsePatternLookupOffsets(42)).toEqual([]);
  });
});

describe("parseKgQueryBcmFeatures", () => {
  it("extracts DEnn DID + group + field from describeBcmFeature lines", () => {
    const text = [
      `Knowledge query "auto lock": 0 unlock entry/entries, 2 BCM feature row(s)`,
      ``,
      `── BCM feature catalog (2) ──`,
      `[bcm-feature] DE03  DoorLock / AutoLockEnable  bit=4 len=1  opts=[0=disabled, 1=enabled]`,
      `[bcm-feature] DE0A  Lighting / DRLEnable  bit=0 len=1  opts=[0=off, 1=on]`,
    ].join("\n");
    expect(parseKgQueryBcmFeatures(text)).toEqual([
      { did: "DE03", group: "DoorLock", field: "AutoLockEnable" },
      { did: "DE0A", group: "Lighting", field: "DRLEnable" },
    ]);
  });

  it("dedupes identical rows", () => {
    const text =
      `[bcm-feature] DE00  Misc / Foo  bit=0 len=1\n` +
      `[bcm-feature] DE00  Misc / Foo  bit=0 len=1\n`;
    expect(parseKgQueryBcmFeatures(text)).toHaveLength(1);
  });

  it("returns empty list when nothing matches", () => {
    expect(parseKgQueryBcmFeatures("no features here")).toEqual([]);
    expect(parseKgQueryBcmFeatures(null)).toEqual([]);
  });
});

describe("parseKgQueryUnlocks", () => {
  it("extracts name + family + algorithm + status from describeUnlock lines", () => {
    const text = [
      `── Unlock catalog (2) ──`,
      `[unlock] cfABS  family=abs  algorithm=t8_xor  status=verified`,
      `  CAN tx=0x7E0 rx=0x7E8  ecu=ABS_MK60`,
      `  bridge fn: unlock_abs_mk60`,
      `[unlock] cfRFH  family=rfhub  algorithm=lcg_pair  status=unverified`,
    ].join("\n");
    expect(parseKgQueryUnlocks(text)).toEqual([
      { name: "cfABS", family: "abs", algorithm: "t8_xor", status: "verified" },
      { name: "cfRFH", family: "rfhub", algorithm: "lcg_pair", status: "unverified" },
    ]);
  });

  it("dedupes and ignores non-unlock lines", () => {
    const text =
      `[unlock] cfA  family=x  algorithm=y  status=z\n` +
      `noise\n` +
      `[unlock] cfA  family=x  algorithm=y  status=z\n`;
    expect(parseKgQueryUnlocks(text)).toHaveLength(1);
  });

  it("handles bad input safely", () => {
    expect(parseKgQueryUnlocks(null)).toEqual([]);
    expect(parseKgQueryUnlocks("")).toEqual([]);
  });
});
