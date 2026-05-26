import { describe, it, expect } from "vitest";
import {
  getRoutineIds,
  getDispatchFor,
  groupRecords,
  summarize,
  TIER1_RAW,
} from "../tier1Dispatch.js";

describe("tier1Dispatch", () => {
  it("exposes all 9 Tier-1 routine IDs", () => {
    const ids = getRoutineIds();
    expect(ids).toEqual([1126, 1367, 1520, 1750, 1751, 2504, 2505, 2507, 2508]);
  });

  it("flags the 4 computed-dispatch routines (empty inline metadata)", () => {
    for (const id of [2504, 2505, 2507, 2508]) {
      const d = getDispatchFor(id);
      expect(d.known).toBe(true);
      expect(d.computed).toBe(true);
      expect(d.records).toEqual([]);
    }
  });

  it("returns known=false for an ID not in the table", () => {
    const d = getDispatchFor(9999);
    expect(d.known).toBe(false);
    expect(d.records).toEqual([]);
  });

  it("accepts string and hex routine IDs", () => {
    expect(getDispatchFor("1750").known).toBe(true);
    expect(getDispatchFor("0x6D6").routineId).toBe(0x6d6);
  });

  it("1750 and 1751 differ only at sub-parameter (idx 3): '0' vs '1'", () => {
    const r1750 = getDispatchFor(1750).records[0];
    const r1751 = getDispatchFor(1751).records[0];
    expect(r1750.ecu).toBe("Comfort Steering Wheel Module Continental");
    expect(r1751.ecu).toBe("Comfort Steering Wheel Module Continental");
    expect(r1750.ecuCode).toBe(r1751.ecuCode);
    expect(r1750.subParam).toBe("0");
    expect(r1751.subParam).toBe("1");
    // all other shared fields equal
    for (const k of [2, 4, 5]) {
      expect(r1750.fields[k]).toBe(r1751.fields[k]);
    }
  });

  it("groups 1520 into 2 records (TBM2 + Radio Frequency HUB)", () => {
    const d = getDispatchFor(1520);
    expect(d.records).toHaveLength(2);
    expect(d.records[0].ecu).toBe("TBM2");
    expect(d.records[1].ecuDisplay).toBe("Radio Frequency HUB");
  });

  it("groups 1126 into 2 records (Marelli engine + Pentastar/Hemi)", () => {
    const d = getDispatchFor(1126);
    expect(d.records).toHaveLength(2);
    expect(d.records[0].ecu).toBe("MARELLI6F3_CAN");
    expect(d.records[1].ecuDisplay).toBe("Chrysler Pentastar/Hemi engine");
  });

  it("groups 1367 into 2 records (CCN + Audio Amplifier)", () => {
    const d = getDispatchFor(1367);
    expect(d.records).toHaveLength(2);
    expect(d.records[0].ecu).toBe("CCN");
    expect(d.records[1].ecuDisplay).toBe("Audio Amplifier");
  });

  it("groupRecords handles empty / malformed input", () => {
    expect(groupRecords([])).toEqual([]);
    expect(groupRecords(null)).toEqual([]);
    expect(groupRecords(undefined)).toEqual([]);
  });

  it("summarize produces a one-line description", () => {
    expect(summarize(1750)).toContain("Comfort Steering Wheel");
    expect(summarize(2504)).toContain("computed at runtime");
    expect(summarize(9999)).toContain("not in Tier-1");
  });

  it("raw JSON exposes 9 keys", () => {
    expect(Object.keys(TIER1_RAW)).toHaveLength(9);
  });

  it("groupRecords splits on every idx=0 boundary, not file offset", () => {
    const out = groupRecords([
      { file_off: "0x100", idx: 0, decrypted: "ECU_A" },
      { file_off: "0x110", idx: 1, decrypted: "ECU_A" },
      { file_off: "0x120", idx: 2, decrypted: "111" },
      { file_off: "0x130", idx: 0, decrypted: "ECU_B" },
      { file_off: "0x140", idx: 1, decrypted: "ECU_B" },
      { file_off: "0x150", idx: 2, decrypted: "222" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].ecu).toBe("ECU_A");
    expect(out[1].ecu).toBe("ECU_B");
    expect(out[0].ecuCode).toBe("111");
    expect(out[1].ecuCode).toBe("222");
  });

  it("groupRecords tolerates entries arriving without a leading idx=0", () => {
    // First entry has idx=1 (no boundary marker yet) — should still start a record
    const out = groupRecords([
      { file_off: "0x100", idx: 1, decrypted: "OnlyDisplay" },
      { file_off: "0x110", idx: 2, decrypted: "999" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].ecuDisplay).toBe("OnlyDisplay");
    expect(out[0].ecuCode).toBe("999");
  });
});
