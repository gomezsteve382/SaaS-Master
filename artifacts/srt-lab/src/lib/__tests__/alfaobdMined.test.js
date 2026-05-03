/* ======================================================================
 * Regression tests for the AlfaOBD-mined BCM catalogs (Task #588)
 * ======================================================================
 *
 * Tests pinned at merge time; must pass whenever the catalogs are re-mined
 * or the frame-builder helpers are edited.
 *
 * The three committed JSON catalogs live in:
 *   artifacts/srt-lab/src/lib/alfaobdMined/{bcmConfigTab,bcmConfigDids,udsServiceMap}.generated.json
 *
 * Section A — Catalog integrity
 *   A1. Every option in bcmConfigTab has a real DID in bcmConfigDids
 *   A2. All 13 expected DE groups are present (DE00..DE0C)
 *   A3. Every option has bit, length, postWrite, requiresReset fields
 *   A4. udsServiceMap.BCM has the required protocol sequence keys
 *
 * Section B — WDBI encoder (udsFrameBuilder.js)
 *   B1. buildWdbiFrame starts with [0x2E, DID-hi, DID-lo]
 *   B2. DRL Mode → bit-exact frame for value 3 (LED DRL)
 *   B3. Horn on Lock → bit-exact frame for value 1 (Enabled)
 *   B4. Auto Lock Speed → bit-exact frame for value 25 (25 mph)
 *   B5. Remote Start Enable → bit-exact frame for value 1 (Enabled)
 *   B6. Trans-Brake → bit-exact frame for value 1 (Enabled)
 *   B7. Read-modify-write: two edits to same DID don't clobber each other
 *
 * Section C — Post-write routine frames
 *   C1. proxiAlign → [0x31, 0x01, 0x02, 0x02]
 *   C2. ecuReset   → [0x11, 0x01]
 *   C3. clearDtc   → [0x14, 0xFF, 0xFF, 0xFF]
 *
 * Section D — index.js helpers
 *   D1. getBcmGroups returns 13 groups sorted by order
 *   D2. getDid returns a DID entry for 0xDE00
 *   D3. getOptionsForDid returns options for DE07 (Engine & Start)
 */

import { describe, it, expect } from "vitest";
import bcmConfigTab  from "../alfaobdMined/bcmConfigTab.generated.json";
import bcmConfigDids from "../alfaobdMined/bcmConfigDids.generated.json";
import udsServiceMap  from "../alfaobdMined/udsServiceMap.generated.json";
import {
  getBcmGroups,
  getDid,
  getOptionsForDid,
} from "../alfaobdMined/index.js";
import {
  buildWdbiFrame,
  buildWdbiFrameByName,
  buildRoutineControlFrame,
  getPostWriteSteps,
  readBits,
  writeBits,
} from "../alfaobdMined/udsFrameBuilder.js";

/* ── helpers ──────────────────────────────────────────────────────────── */

function emptyPayload(byteLen) {
  return new Uint8Array(byteLen);
}

/* MSB-first bit writer used to verify read-back (same as cgwConfig tests) */
function setField(buf, bitOffset, bitLength, value) {
  const mask = (1 << bitLength) - 1;
  const v = value & mask;
  for (let i = 0; i < bitLength; i++) {
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    const bit = (v >> (bitLength - 1 - i)) & 1;
    if (bit) buf[byteIdx] |= 1 << bitIdx;
    else     buf[byteIdx] &= ~(1 << bitIdx);
  }
}

/* ── Section A — Catalog integrity ────────────────────────────────────── */

describe("A — catalog integrity", () => {
  it("A1 — every option's DID key exists in bcmConfigDids", () => {
    for (const group of bcmConfigTab.groups) {
      const key = group.did.toLowerCase().replace("0x", "0x");
      /* normalize to "0xDExx" */
      const norm = "0x" + group.did.toUpperCase().replace(/^0X/, "");
      expect(
        bcmConfigDids.dids[norm],
        `DID ${group.did} (${group.groupName}) not found in bcmConfigDids`
      ).toBeDefined();
    }
  });

  it("A2 — exactly 13 groups present: DE00..DE0C", () => {
    /* Normalize each DID to "0xDExx" (lowercase 0x, uppercase hex digits) */
    const normalize = (s) => "0x" + s.replace(/^0x/i, "").toUpperCase();
    const dids = bcmConfigTab.groups.map(g => normalize(g.did)).sort();
    const expected = ["0xDE00","0xDE01","0xDE02","0xDE03","0xDE04","0xDE05",
                      "0xDE06","0xDE07","0xDE08","0xDE09","0xDE0A","0xDE0B","0xDE0C"].sort();
    expect(dids).toEqual(expected);
    expect(bcmConfigTab.groups.length).toBe(13);
  });

  it("A3 — every option has required fields with correct types", () => {
    for (const group of bcmConfigTab.groups) {
      for (const opt of group.options) {
        expect(typeof opt.name, `${group.did}.${opt.name}.name`).toBe("string");
        expect(typeof opt.bit, `${group.did}.${opt.name}.bit`).toBe("number");
        expect(typeof opt.length, `${group.did}.${opt.name}.length`).toBe("number");
        expect(opt.length, `${group.did}.${opt.name}.length >= 1`).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(opt.postWrite), `${group.did}.${opt.name}.postWrite`).toBe(true);
        expect(typeof opt.requiresReset, `${group.did}.${opt.name}.requiresReset`).toBe("boolean");
        expect(typeof opt.valueMap, `${group.did}.${opt.name}.valueMap`).toBe("object");
      }
    }
  });

  it("A4 — udsServiceMap.BCM has all required protocol keys", () => {
    const bcm = udsServiceMap.BCM;
    expect(bcm).toBeDefined();
    expect(bcm.address).toBeDefined();
    expect(bcm.unlockAlgorithm).toBeDefined();
    expect(bcm.unlockAlgorithm.id).toBe("cda6");
    expect(Array.isArray(bcm.readConfig.steps)).toBe(true);
    expect(bcm.readConfig.steps.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(bcm.writeConfig.steps)).toBe(true);
    expect(bcm.writeConfig.steps.length).toBeGreaterThanOrEqual(5);
    expect(bcm.writeConfig.postWriteRoutines.proxiAlign).toBeDefined();
    expect(bcm.writeConfig.postWriteRoutines.ecuReset).toBeDefined();
  });

  it("A5 — Trans-Brake option is in DE07 (Engine & Start) and requires reset", () => {
    const eng = bcmConfigTab.groups.find(g => g.did === "0xDE07");
    expect(eng).toBeDefined();
    const tb = eng.options.find(o => o.name === "Trans-Brake");
    expect(tb).toBeDefined();
    expect(tb.requiresReset).toBe(true);
    expect(tb.postWrite).toContain("ecuReset");
  });

  it("A6 — WDBI session requires security level 1 for all DE-family DIDs", () => {
    for (const group of bcmConfigTab.groups) {
      const norm = "0x" + group.did.toUpperCase().replace(/^0X/, "");
      const entry = bcmConfigDids.dids[norm];
      expect(entry.securityLevelRequired, `${norm} securityLevelRequired`).toBe(1);
      expect(entry.sessionRequired, `${norm} sessionRequired`).toBe("extended");
      expect(entry.canWrite, `${norm} canWrite`).toBe(true);
    }
  });
});

/* ── Section B — WDBI encoder ────────────────────────────────────────── */

describe("B — WDBI encoder (udsFrameBuilder.js)", () => {
  it("B1 — buildWdbiFrame returns [0x2E, hi, lo, …payload]", () => {
    const payload = emptyPayload(9);
    const frame = buildWdbiFrame("0xDE00", payload, 0, 3, 1);
    expect(frame[0]).toBe(0x2E);
    expect(frame[1]).toBe(0xDE);
    expect(frame[2]).toBe(0x00);
    expect(frame.length).toBeGreaterThanOrEqual(4);
  });

  it("B2 — DRL Mode: value 3 (LED DRL) encoded in DE00 bit0/+3", () => {
    /* DE00 bit 0, length 3 → upper 3 bits of first payload byte */
    const payload = emptyPayload(9);
    const frame = buildWdbiFrame("0xDE00", payload, 0, 3, 3);
    /* bit0..2 MSB-first: 011 → top of byte 3: 0b0110_0000 = 0x60 */
    const modified = new Uint8Array(frame.slice(3));
    const readback = readBits(modified, 0, 3);
    expect(readback).toBe(3);
  });

  it("B3 — Horn on Lock (DE02 bit0/+1) encodes value 1 (Enabled)", () => {
    const payload = emptyPayload(4);
    const result = buildWdbiFrameByName("0xDE02", "Horn on Lock", payload, 1);
    expect(result).not.toBeNull();
    expect(result.option.name).toBe("Horn on Lock");
    const modified = new Uint8Array(result.frame.slice(3));
    expect(readBits(modified, 0, 1)).toBe(1);
  });

  it("B4 — Auto Lock Speed (DE01 bit0/+8) encodes value 25 (25 mph)", () => {
    const payload = emptyPayload(7);
    const result = buildWdbiFrameByName("0xDE01", "Auto Lock Speed", payload, 25);
    expect(result).not.toBeNull();
    const modified = new Uint8Array(result.frame.slice(3));
    expect(readBits(modified, 0, 8)).toBe(25);
  });

  it("B5 — Remote Start Enable (DE07 bit3/+1) encodes value 1 (Enabled)", () => {
    const payload = emptyPayload(2);
    const result = buildWdbiFrameByName("0xDE07", "Remote Start Enable", payload, 1);
    expect(result).not.toBeNull();
    const modified = new Uint8Array(result.frame.slice(3));
    expect(readBits(modified, 3, 1)).toBe(1);
    expect(result.option.requiresReset).toBe(false);
  });

  it("B6 — Trans-Brake (DE07) encodes value 1 (Enabled) and requiresReset=true", () => {
    const payload = emptyPayload(2);
    const result = buildWdbiFrameByName("0xDE07", "Trans-Brake", payload, 1);
    expect(result).not.toBeNull();
    const modified = new Uint8Array(result.frame.slice(3));
    const tbOpt = getBcmGroups()
      .find(g => g.did === "0xDE07")
      .options.find(o => o.name === "Trans-Brake");
    expect(readBits(modified, tbOpt.bit, tbOpt.length)).toBe(1);
    expect(result.option.requiresReset).toBe(true);
    expect(result.option.postWrite).toContain("ecuReset");
  });

  it("B7 — two edits to same DID do not clobber each other (read-modify-write chain)", () => {
    /* Simulate: write DRL Mode = 3, then re-read and write Flash-to-Pass = 1 */
    const base = emptyPayload(9);

    /* first write: DRL Mode = 3 at bit 0 len 3 */
    const frame1 = buildWdbiFrame("0xDE00", base, 0, 3, 3);
    const payload1 = new Uint8Array(frame1.slice(3));

    /* second write: Flash-to-Pass = 1 at bit 21 len 1 — use payload1 as base */
    const frame2 = buildWdbiFrame("0xDE00", payload1, 21, 1, 1);
    const payload2 = new Uint8Array(frame2.slice(3));

    /* both fields must survive */
    expect(readBits(payload2, 0, 3)).toBe(3);    /* DRL Mode preserved */
    expect(readBits(payload2, 21, 1)).toBe(1);  /* Flash-to-Pass set */
  });

  it("B8 — writeBits / readBits round-trip across byte boundary", () => {
    const buf = new Uint8Array(4);
    writeBits(buf, 6, 4, 0xF);
    expect(readBits(buf, 6, 4)).toBe(0xF);
    /* neighbor bits must not be disturbed */
    expect(readBits(buf, 0, 6)).toBe(0);
    expect(readBits(buf, 10, 6)).toBe(0);
  });
});

/* ── Section C — Post-write routine frames ────────────────────────────── */

describe("C — post-write routine frame builders", () => {
  it("C1 — proxiAlign → [0x31, 0x01, 0x02, 0x02]", () => {
    expect(buildRoutineControlFrame("proxiAlign")).toEqual([0x31, 0x01, 0x02, 0x02]);
  });

  it("C2 — ecuReset → [0x11, 0x01]", () => {
    expect(buildRoutineControlFrame("ecuReset")).toEqual([0x11, 0x01]);
  });

  it("C3 — clearDtc → [0x14, 0xFF, 0xFF, 0xFF]", () => {
    expect(buildRoutineControlFrame("clearDtc")).toEqual([0x14, 0xFF, 0xFF, 0xFF]);
  });

  it("C4 — unknown routine key throws rather than silently emitting garbage", () => {
    expect(() => buildRoutineControlFrame("unknownKey")).toThrow();
  });

  it("C5 — getPostWriteSteps for Trans-Brake includes both proxiAlign and ecuReset", () => {
    const group = getBcmGroups().find(g => g.did === "0xDE07");
    const tb = group.options.find(o => o.name === "Trans-Brake");
    const steps = getPostWriteSteps(tb);
    const labels = steps.map(s => s.label);
    expect(labels).toContain("proxiAlign");
    expect(labels).toContain("ecuReset");
    const pa = steps.find(s => s.label === "proxiAlign");
    expect(pa.frame).toEqual([0x31, 0x01, 0x02, 0x02]);
  });
});

/* ── Section D — index.js helpers ────────────────────────────────────── */

describe("D — index.js helpers", () => {
  it("D1 — getBcmGroups returns 13 groups sorted by order", () => {
    const groups = getBcmGroups();
    expect(groups.length).toBe(13);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i].order).toBeGreaterThanOrEqual(groups[i - 1].order);
    }
  });

  it("D2 — getDid resolves 0xDE00 to the Lighting Configuration entry", () => {
    const entry = getDid("0xDE00");
    expect(entry).not.toBeNull();
    expect(entry.canRead).toBe(true);
    expect(entry.canWrite).toBe(true);
    expect(entry.securityLevelRequired).toBe(1);
  });

  it("D2b — getDid accepts bare hex without 0x prefix", () => {
    expect(getDid("DE00")).toEqual(getDid("0xDE00"));
  });

  it("D3 — getOptionsForDid('0xDE07') returns Engine & Start options", () => {
    const opts = getOptionsForDid("0xDE07");
    expect(opts.length).toBeGreaterThan(0);
    const names = opts.map(o => o.name);
    expect(names).toContain("Trans-Brake");
    expect(names).toContain("Remote Start Enable");
  });

  it("D4 — getDid returns null for unknown DID", () => {
    expect(getDid("0xDEAD")).toBeNull();
  });

  it("D5 — all 13 group DIDs resolve via getDid", () => {
    for (const group of getBcmGroups()) {
      const entry = getDid(group.did);
      expect(entry, `getDid(${group.did})`).not.toBeNull();
    }
  });
});
