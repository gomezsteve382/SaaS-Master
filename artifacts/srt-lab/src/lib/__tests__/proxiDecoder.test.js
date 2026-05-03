import { describe, it, expect } from "vitest";
import {
  decodeProxi2023,
  decodeDeDid,
  deCatalogRows,
  categorizeField,
  countByCategory,
  groupByRequest,
  CATEGORY_DEFS,
  DE_DIDS,
} from "../proxiDecoder.js";
import { DE_FEATURE_CATALOG } from "../bcmFeatureCatalog.generated.js";
import { readBits } from "../cgwConfig.js";

/* Helper: pack `value` into `buf` at MSB-first `bitOffset` for `bitLength`
 * bits. Mirrors `readBits` exactly so a round-trip proves the decoder is
 * looking at the same bit slot the encoder put data into. */
function writeBits(buf, bitOffset, bitLength, value) {
  for (let i = 0; i < bitLength; i++) {
    const bit = (value >> (bitLength - 1 - i)) & 1;
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx >= buf.length) return;
    if (bit) buf[byteIdx] |= 1 << bitIdx;
    else     buf[byteIdx] &= ~(1 << bitIdx);
  }
}

describe("proxiDecoder — 0x2023 BCM proxi blob", () => {
  it("returns rows for the canonical 16-byte response", () => {
    const bytes = new Uint8Array(16); // all zeros
    const rows = decodeProxi2023(bytes);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source).toBe("0x2023");
      expect(r.request).toBe("2023");
      expect(r.groupName).toMatch(/Proxi/);
      expect(r.category).toBeTruthy();
      expect(typeof r.name).toBe("string");
    }
  });

  it("accepts plain arrays as well as Uint8Array", () => {
    const a = decodeProxi2023(new Uint8Array(16));
    const b = decodeProxi2023(new Array(16).fill(0));
    expect(a.length).toBe(b.length);
  });

  it("returns null raw / out-of-range label on empty input", () => {
    const rows = decodeProxi2023(new Uint8Array(0));
    expect(rows.every((r) => r.raw === null)).toBe(true);
  });
});

describe("proxiDecoder — DEnn DID family", () => {
  it("DE_DIDS covers all 13 DE00..DE0C groups", () => {
    expect(DE_DIDS.length).toBe(13);
    const dids = DE_DIDS.map((d) => d.did).sort();
    expect(dids[0]).toBe("DE00");
    expect(dids[dids.length - 1]).toBe("DE0C");
    for (const d of DE_DIDS) {
      expect(d.didNumber & 0xff00).toBe(0xde00);
      expect(d.count).toBeGreaterThan(0);
    }
  });

  it("decodes every DE catalog row for an all-ones 32-byte response", () => {
    const buf = new Uint8Array(32).fill(0xff);
    for (const did of DE_DIDS) {
      const rows = decodeDeDid(did.did, buf);
      expect(rows.length).toBe(did.count);
      for (const r of rows) {
        expect(r.request).toBe(did.did);
        expect(r.groupName).toBe(did.groupName);
        if (r.bit + r.length <= 32 * 8) {
          expect(r.raw).not.toBeNull();
          expect(typeof r.label).toBe("string");
        }
      }
    }
  });

  it("decoder reads back exactly what writeBits encoded — round-trip on every catalog row", () => {
    // 64 bytes is wider than any catalog row's bit range
    for (const r of DE_FEATURE_CATALOG) {
      const buf = new Uint8Array(64);
      const max = (1 << r.length) - 1;
      // pick a deterministic value that exercises every bit of the field
      const v = r.length >= 32 ? 0xdeadbeef >>> 0 : (max ^ (r.bit & max));
      writeBits(buf, r.bit, r.length, v);
      const decoded = decodeDeDid(r.request, buf);
      const hit = decoded.find((d) => d.name === r.name && d.bit === r.bit);
      expect(hit, `missing decode for ${r.request} ${r.name}`).toBeTruthy();
      expect(hit.raw, `${r.request} ${r.name} round-trip`).toBe(v);
    }
  });

  it("returns empty array for an unknown DID", () => {
    expect(decodeDeDid("DEFF", new Uint8Array(8))).toEqual([]);
  });

  it("is case-insensitive on the request hex", () => {
    const a = decodeDeDid("de00", new Uint8Array(16));
    const b = decodeDeDid("DE00", new Uint8Array(16));
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
  });

  it("labels enum-table fields with the option text", () => {
    // DE08 Speed Units, bit 0 length 1: 0=MPH, 1=KM/H
    const buf = new Uint8Array(8);
    writeBits(buf, 0, 1, 1);
    const rows = decodeDeDid("DE08", buf);
    const row = rows.find((r) => r.name === "Speed Units");
    expect(row).toBeTruthy();
    expect(row.raw).toBe(1);
    expect(row.label).toMatch(/KM\/H/);
  });

  it("labels free-integer fields with raw + hex when no options table", () => {
    // DE00 DRL Intensity is bits=3 len=7, no options
    const buf = new Uint8Array(8);
    writeBits(buf, 3, 7, 42);
    const rows = decodeDeDid("DE00", buf);
    const row = rows.find((r) => r.name === "DRL Intensity");
    expect(row).toBeTruthy();
    expect(row.raw).toBe(42);
    expect(row.label).toMatch(/42.*0x2A/);
  });

  it("marks unknown enum values explicitly rather than silently dropping", () => {
    // DE0B Vehicle Trim Level: 0..9 defined; pick 15 which is undefined
    const buf = new Uint8Array(8);
    writeBits(buf, 0, 4, 15);
    const rows = decodeDeDid("DE0B", buf);
    const row = rows.find((r) => r.name === "Vehicle Trim Level");
    expect(row.raw).toBe(15);
    expect(row.label).toMatch(/unknown value/);
  });

  it("flags bit ranges that fall off the end of the payload", () => {
    const rows = decodeDeDid("DE00", new Uint8Array(1)); // way too short
    const offEnd = rows.find((r) => r.bit + r.length > 8);
    expect(offEnd.raw).toBeNull();
    expect(offEnd.label).toBe("(out of range)");
  });
});

describe("proxiDecoder — categorization", () => {
  it("buckets feature names into the 15 known categories", () => {
    expect(categorizeField("Daytime Running Lights Mode")).toBe("lighting");
    expect(categorizeField("Auto Lock Speed")).toBe("locks");
    expect(categorizeField("Key Fob Range")).toBe("remote");
    expect(categorizeField("Heated Seat Memory")).toBe("comfort");
    expect(categorizeField("Horn Volume")).toBe("horn");
    expect(categorizeField("Rain Wiper Sensitivity")).toBe("wipers");
    expect(categorizeField("Sunroof Auto-Close")).toBe("windows");
    expect(categorizeField("Mirror Auto-Fold")).toBe("mirrors");
    // Note: "Stop-Start Memory" hits comfort's `memory` keyword first by
    // design — we mirror the TSX's regex order exactly so labels match
    // what AlphaOBD's source UI does. Use a name that doesn't collide.
    expect(categorizeField("Engine Run in Accessory")).toBe("engine");
    expect(categorizeField("Speed Units")).toBe("display");
    expect(categorizeField("Launch Control")).toBe("performance");
    expect(categorizeField("Vehicle Trim Level")).toBe("vehicle");
    expect(categorizeField("Sentry Mode")).toBe("security");
    expect(categorizeField("Tire Pressure Display Units", "TPMS")).toBe("tpms");
  });

  it("falls through to 'other' when nothing matches", () => {
    expect(categorizeField("xyz nonsense field")).toBe("other");
  });

  it("countByCategory totals to the row count and only uses defined ids", () => {
    const rows = deCatalogRows();
    const counts = countByCategory(rows);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(rows.length);
    const validIds = new Set(CATEGORY_DEFS.map((c) => c.id));
    for (const k of Object.keys(counts)) expect(validIds.has(k)).toBe(true);
  });
});

describe("proxiDecoder — grouping & catalog browse mode", () => {
  it("groupByRequest preserves first-seen order and round-trips row counts", () => {
    const rows = decodeDeDid("DE00", new Uint8Array(16));
    const grouped = groupByRequest(rows);
    expect(grouped.size).toBe(1);
    expect(grouped.get("DE00").length).toBe(rows.length);
  });

  it("deCatalogRows returns the full 155-row catalog with raw=null when no bytes are loaded", () => {
    const rows = deCatalogRows();
    expect(rows.length).toBe(DE_FEATURE_CATALOG.length);
    expect(rows.length).toBe(155);
    expect(rows.every((r) => r.raw === null && r.label === "—")).toBe(true);
  });
});
