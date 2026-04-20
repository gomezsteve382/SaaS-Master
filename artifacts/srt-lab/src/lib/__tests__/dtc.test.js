import { describe, it, expect } from "vitest";
import {
  formatDtcCode,
  decodeDtcStatus,
  dtcLookup,
  parseDtcResponse,
  formatDtcLogLine,
  buildDtcDetail,
  DTC_STATUS_BITS,
} from "../dtc.js";

describe("formatDtcCode", () => {
  it("maps the prefix nibble to P/C/B/U with FTB suffix", () => {
    expect(formatDtcCode(0x03, 0x01, 0x00)).toBe("P030100");   /* 00 -> P */
    expect(formatDtcCode(0x43, 0x01, 0x00)).toBe("C030100");   /* 01 -> C */
    expect(formatDtcCode(0x83, 0x01, 0x00)).toBe("B030100");   /* 10 -> B */
    expect(formatDtcCode(0xc1, 0x40, 0x00)).toBe("U014000");   /* 11 -> U */
  });

  it("renders FFs across all nibbles (P3FFF + FF FTB)", () => {
    expect(formatDtcCode(0x3f, 0xff, 0xff)).toBe("P3FFFFF");
  });

  it("renders the FTB byte as a 2-digit suffix", () => {
    expect(formatDtcCode(0x03, 0x01, 0x42)).toBe("P030142");
  });
});

describe("decodeDtcStatus", () => {
  it("decodes 0x00 to no active bits", () => {
    const r = decodeDtcStatus(0x00);
    expect(r.labels).toEqual([]);
    expect(r.summary).toBe("—");
    expect(r.bits.testFailed).toBe(false);
    expect(r.bits.confirmed).toBe(false);
  });

  it("decodes the test-failed bit (0x01)", () => {
    const r = decodeDtcStatus(0x01);
    expect(r.bits.testFailed).toBe(true);
    expect(r.labels).toContain("test failed");
    expect(r.summary).toContain("current");
  });

  it("decodes the pending bit (0x04)", () => {
    const r = decodeDtcStatus(0x04);
    expect(r.bits.pending).toBe(true);
    expect(r.labels).toContain("pending");
    expect(r.summary).toContain("pending");
  });

  it("decodes the confirmed bit (0x08)", () => {
    const r = decodeDtcStatus(0x08);
    expect(r.bits.confirmed).toBe(true);
    expect(r.labels).toContain("confirmed");
    expect(r.summary).toContain("confirmed");
  });

  it("decodes a multi-bit byte (0x09 = test-failed + confirmed)", () => {
    const r = decodeDtcStatus(0x09);
    expect(r.bits.testFailed).toBe(true);
    expect(r.bits.confirmed).toBe(true);
    expect(r.summary).toContain("confirmed");
    /* Suppress the "current" tag once "confirmed" is set —
     * it's redundant noise in the UI. */
    expect(r.summary).not.toContain("current");
  });

  it("decodes the warning indicator bit (0x80)", () => {
    const r = decodeDtcStatus(0x80);
    expect(r.bits.warningIndicatorRequested).toBe(true);
    expect(r.summary).toContain("MIL");
  });

  it("exposes all 8 ISO-14229 bits in DTC_STATUS_BITS", () => {
    expect(DTC_STATUS_BITS).toHaveLength(8);
    /* sanity: masks form a power-of-two set covering every bit */
    const xor = DTC_STATUS_BITS.reduce((a, b) => a ^ b.mask, 0);
    expect(xor).toBe(0xff);
  });
});

describe("dtcLookup", () => {
  const table = {
    P0301: "Cylinder 1 misfire detected",
    "0420": { description: "Catalyst System Efficiency Below Threshold", category: "emissions" },
  };

  it("returns null when the code is unknown", () => {
    expect(dtcLookup("U014000", table)).toBeNull();
  });

  it("returns null when the table is empty (Task T1 stub)", () => {
    expect(dtcLookup("P030100", {})).toBeNull();
  });

  it("finds a code keyed by the OBD-II stem (P0301) when given the full UDS code", () => {
    const r = dtcLookup("P030100", table);
    expect(r).toEqual({
      code: "P030100",
      description: "Cylinder 1 misfire detected",
      category: null,
    });
  });

  it("finds a code keyed by the bare hex stem (0420) when given the full UDS code", () => {
    const r = dtcLookup("P042000", table);
    expect(r?.description).toMatch(/Catalyst/);
    expect(r?.category).toBe("emissions");
  });

  it("is case-insensitive", () => {
    expect(dtcLookup("p030100", table)?.description).toMatch(/misfire/);
  });
});

describe("parseDtcResponse", () => {
  it("returns an empty list for too-short responses", () => {
    expect(parseDtcResponse(null)).toEqual([]);
    expect(parseDtcResponse([])).toEqual([]);
    expect(parseDtcResponse([0x59, 0x02, 0x08])).toEqual([]);
  });

  it("skips zero-padded DTC slots", () => {
    /* SID-echo, sub-fn, avail-mask, then one zero DTC, one real DTC. */
    const bytes = new Uint8Array([
      0x59, 0x02, 0x08,
      0x00, 0x00, 0x00, 0x00,
      0x03, 0x01, 0x00, 0x09,
    ]);
    const out = parseDtcResponse(bytes);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("P030100");
    expect(out[0].statusByte).toBe(0x09);
  });

  it("parses two consecutive DTCs", () => {
    const bytes = [
      0x59, 0x02, 0x08,
      0x03, 0x01, 0x00, 0x09,    /* P0301 + FTB 00, confirmed */
      0xc1, 0x40, 0x00, 0x04,    /* U0140 + FTB 00, pending   */
    ];
    const out = parseDtcResponse(bytes);
    expect(out.map((e) => e.code)).toEqual(["P030100", "U014000"]);
    expect(out[1].statusByte).toBe(0x04);
  });
});

describe("formatDtcLogLine", () => {
  const table = { P0301: "Cylinder 1 misfire detected" };

  it("renders the description inline for a known code", () => {
    const line = formatDtcLogLine({ code: "P030100", statusByte: 0x09 }, table);
    expect(line).toContain("P030100");
    expect(line).toContain("Cylinder 1 misfire detected");
    expect(line).toContain("status=0x09");
    expect(line).toContain("confirmed");
  });

  it("falls back to (unknown) for an unknown code", () => {
    const line = formatDtcLogLine({ code: "U014000", statusByte: 0x04 }, table);
    expect(line).toContain("U014000");
    expect(line).toContain("(unknown)");
    expect(line).toContain("pending");
  });

  it("works against the real (currently empty) FAULTS_BY_HEX export", () => {
    /* FAULTS_BY_HEX is {} until Task T1 lands a clean .db. The
     * graceful-fallback contract means the line still renders. */
    const line = formatDtcLogLine({ code: "P030100", statusByte: 0x09 });
    expect(line).toContain("P030100");
    expect(line).toContain("(unknown)");
  });
});

describe("buildDtcDetail", () => {
  const table = { P0301: { description: "Cylinder 1 misfire detected", category: "powertrain" } };

  it("packages every field needed by the inline detail panel", () => {
    const d = buildDtcDetail(
      { code: "P030100", statusByte: 0x09 },
      { tx: 0x7e0, rx: 0x7e8 },
      table,
    );
    expect(d.code).toBe("P030100");
    expect(d.description).toBe("Cylinder 1 misfire detected");
    expect(d.category).toBe("powertrain");
    expect(d.statusByte).toBe(0x09);
    expect(d.statusHex).toBe("0x09");
    expect(d.statusBits.confirmed).toBe(true);
    expect(d.statusLabels).toContain("confirmed");
    expect(d.moduleAddr).toEqual({ tx: 0x7e0, rx: 0x7e8 });
  });

  it("sets description=null and category=null when the code is unknown", () => {
    const d = buildDtcDetail({ code: "U014000", statusByte: 0x04 }, null);
    expect(d.description).toBeNull();
    expect(d.category).toBeNull();
    expect(d.moduleAddr).toBeNull();
  });
});
