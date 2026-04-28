// Task #484 — wrong-module guard unit coverage. The slot-aware classifier
// added in #483 only flips the type when the buffer size is canonical for
// the slot's family; a 64 KB BCM dropped into the PCM slot bypasses both
// the slot override AND `moduleTooSmall`. `wrongModuleForSlot` plugs that
// gap by recognising any size that's canonical for some OTHER family.

import { describe, it, expect } from "vitest";
import {
  wrongModuleForSlot,
  CANONICAL_SIZES_BY_TYPE,
  SLOT_TO_FAMILY,
} from "../parseModule.js";

describe("wrongModuleForSlot — Task #484", () => {
  it("flags a 64 KB BCM dropped into the PCM slot as wrong-module (BCM)", () => {
    const buf = new Uint8Array(65536).fill(0x00);
    const r = wrongModuleForSlot(buf, "PCM", "bcm.bin");
    expect(r).toBeTruthy();
    expect(r.wrongModule).toBe(true);
    expect(r.slotType).toBe("PCM");
    expect(r.slotFamily).toBe("GPEC2A");
    expect(r.detectedType).toBe("BCM");
    expect(r.detectedCandidates).toEqual(["BCM"]);
    expect(r.size).toBe(65536);
    expect(r.message).toMatch(/looks like a BCM/);
    expect(r.message).toMatch(/PCM/);
  });

  it("flags a 128 KB BCM dropped into the PCM slot (alternate canonical BCM size)", () => {
    const buf = new Uint8Array(131072).fill(0x00);
    const r = wrongModuleForSlot(buf, "PCM", "bcm_big.bin");
    expect(r).toBeTruthy();
    expect(r.detectedType).toBe("BCM");
    expect(r.size).toBe(131072);
  });

  it("flags a 64 KB BCM dropped into the RFHUB slot as wrong-module (BCM)", () => {
    const buf = new Uint8Array(65536).fill(0x00);
    const r = wrongModuleForSlot(buf, "RFHUB", "bcm.bin");
    expect(r).toBeTruthy();
    expect(r.detectedType).toBe("BCM");
    expect(r.slotType).toBe("RFHUB");
  });

  it("flags an 8 KB 95640/GPEC2A dump dropped into the BCM slot as wrong-module (95640)", () => {
    const buf = new Uint8Array(8192).fill(0xFF);
    const r = wrongModuleForSlot(buf, "BCM", "eep.bin");
    expect(r).toBeTruthy();
    expect(r.slotType).toBe("BCM");
    expect(r.slotFamily).toBe("BCM");
    // 8 KB is canonical for BOTH 95640 and GPEC2A — both should be listed,
    // with 95640 picked as the primary hint (matches the BCM-backup EEPROM
    // chip a tech most often confuses with a real BCM dump).
    expect(r.detectedType).toBe("95640");
    expect(r.detectedCandidates).toEqual(["95640", "GPEC2A"]);
  });

  it("flags a 2 KB Gen1 RFHUB dropped into the PCM slot as wrong-module (RFHUB)", () => {
    const buf = new Uint8Array(2048).fill(0xFF);
    const r = wrongModuleForSlot(buf, "PCM", "rfh_gen1.bin");
    expect(r).toBeTruthy();
    expect(r.slotType).toBe("PCM");
    expect(r.slotFamily).toBe("GPEC2A");
    expect(r.detectedType).toBe("RFHUB");
    expect(r.detectedCandidates).toEqual(["RFHUB"]);
  });

  it("returns null when the buffer size is canonical for the slot's family", () => {
    // 4 KB and 8 KB into the PCM slot — both canonical for GPEC2A.
    expect(wrongModuleForSlot(new Uint8Array(4096), "PCM", "pcm.bin")).toBeNull();
    expect(wrongModuleForSlot(new Uint8Array(8192), "PCM", "pcm.bin")).toBeNull();
    // 64 KB and 128 KB into the BCM slot — both canonical for BCM.
    expect(wrongModuleForSlot(new Uint8Array(65536), "BCM", "bcm.bin")).toBeNull();
    expect(wrongModuleForSlot(new Uint8Array(131072), "BCM", "bcm.bin")).toBeNull();
    // 2 KB and 4 KB into the RFHUB slot — both canonical for RFHUB.
    expect(wrongModuleForSlot(new Uint8Array(2048), "RFHUB", "rfh.bin")).toBeNull();
    expect(wrongModuleForSlot(new Uint8Array(4096), "RFHUB", "rfh.bin")).toBeNull();
  });

  it("returns null for sizes that aren't canonical for ANY family (the size guard's job)", () => {
    // 1 KB into the PCM slot — too small for any family (moduleTooSmall
    // catches this case with the 'too small' card instead).
    expect(wrongModuleForSlot(new Uint8Array(1024), "PCM", "frag.bin")).toBeNull();
    // 32 KB into the PCM slot — odd size, no canonical match.
    expect(wrongModuleForSlot(new Uint8Array(32768), "PCM", "odd.bin")).toBeNull();
  });

  it("returns null when slotType is missing or unrecognised", () => {
    const buf = new Uint8Array(65536);
    expect(wrongModuleForSlot(buf, null, "bcm.bin")).toBeNull();
    expect(wrongModuleForSlot(buf, undefined, "bcm.bin")).toBeNull();
    expect(wrongModuleForSlot(buf, "MYSTERY", "bcm.bin")).toBeNull();
  });

  it("returns null when bytes is missing", () => {
    expect(wrongModuleForSlot(null, "PCM", "x.bin")).toBeNull();
    expect(wrongModuleForSlot(undefined, "PCM", "x.bin")).toBeNull();
  });

  it("populates ext + slot/detected labels for the rejection card", () => {
    const buf = new Uint8Array(65536);
    const r = wrongModuleForSlot(buf, "PCM", "donor.eep");
    expect(r.ext).toBe(".eep");
    expect(r.slotLabel).toMatch(/Continental GPEC2A/);
    expect(r.detectedLabel).toMatch(/MPC5605B/);
  });

  it("SLOT_TO_FAMILY map covers every slot label rendered by DumpsTabV2", () => {
    // Lock down the slot-label vocabulary so future slots get added to
    // the map (otherwise the wrong-module guard silently no-ops on them).
    expect(SLOT_TO_FAMILY).toMatchObject({
      PCM: "GPEC2A",
      GPEC2A: "GPEC2A",
      BCM: "BCM",
      RFHUB: "RFHUB",
      "95640": "95640",
    });
    // And every family value resolves to a CANONICAL_SIZES_BY_TYPE entry.
    for (const family of Object.values(SLOT_TO_FAMILY)) {
      expect(CANONICAL_SIZES_BY_TYPE[family]).toBeTruthy();
    }
  });
});
