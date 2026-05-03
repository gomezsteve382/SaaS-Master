/* Tests for proxiFieldCatalog.generated.js — the FCA PROXI section
 * field map (DID 0xFD01 / 0xFD20). Covers:
 *   - getProxiFields: section + variant filtering, wildcard handling
 *   - readProxiField: MSB-first bit extraction, out-of-range → null,
 *     multi-bit fields that cross byte boundaries
 *   - decodeProxiSection: end-to-end decode, label rendering, raw=null
 *     for short payloads, integration with parseProxi sections
 *   - Catalog integrity: every row has the required shape, options
 *     values are unique within a row, byte/bit ranges are in spec.
 */
import { describe, it, expect } from "vitest";
import {
  PROXI_FIELD_CATALOG,
  PROXI_VARIANTS,
  PROXI_SECTION_NAMES,
  PROXI_CATALOG_STATS,
  getProxiFields,
  readProxiField,
  decodeProxiSection,
} from "../proxiFieldCatalog.generated.js";
import { parseProxi, buildProxi } from "../fcaProxi.js";

/* MSB-first bit packer that mirrors readProxiField's read order so a
 * round-trip proves both sides agree on the bit ordering. */
function writeField(buf, byte, bit, length, value) {
  for (let i = 0; i < length; i++) {
    const v = (value >> (length - 1 - i)) & 1;
    const abs = byte * 8 + bit + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (byteIdx >= buf.length) return;
    if (v) buf[byteIdx] |= 1 << bitIdx;
    else   buf[byteIdx] &= ~(1 << bitIdx);
  }
}

describe("PROXI field catalog — shape & coverage", () => {
  it("covers Body (0x01) and Powertrain (0x02) — task minimum", () => {
    expect(PROXI_CATALOG_STATS.bySection[0x01]).toBeGreaterThan(0);
    expect(PROXI_CATALOG_STATS.bySection[0x02]).toBeGreaterThan(0);
  });

  it("declares at least GPEC2A as a variant", () => {
    const ids = PROXI_VARIANTS.map((v) => v.id);
    expect(ids).toContain("GPEC2A");
  });

  it("section names match the python source SECTION_NAMES", () => {
    expect(PROXI_SECTION_NAMES[0x01]).toBe("Body");
    expect(PROXI_SECTION_NAMES[0x02]).toBe("Powertrain");
    expect(PROXI_SECTION_NAMES[0x07]).toBe("Infotainment");
  });

  it("every row has the required keys with valid ranges", () => {
    for (const r of PROXI_FIELD_CATALOG) {
      expect(typeof r.section).toBe("number");
      expect(typeof r.variant).toBe("string");
      expect(Number.isInteger(r.byte)).toBe(true);
      expect(r.byte).toBeGreaterThanOrEqual(0);
      expect(r.bit).toBeGreaterThanOrEqual(0);
      expect(r.bit).toBeLessThanOrEqual(7);
      expect(r.length).toBeGreaterThan(0);
      expect(r.length).toBeLessThanOrEqual(16);
      expect(["bool", "enum", "uint"]).toContain(r.type);
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
      expect(Array.isArray(r.options)).toBe(true);
      if (r.type === "enum") expect(r.options.length).toBeGreaterThan(0);
    }
  });

  it("option values are unique within a row", () => {
    for (const r of PROXI_FIELD_CATALOG) {
      const seen = new Set();
      for (const opt of r.options) {
        expect(seen.has(opt.value)).toBe(false);
        seen.add(opt.value);
      }
    }
  });
});

describe("getProxiFields — section + variant filtering", () => {
  it("returns wildcard '*' rows for any variant", () => {
    const a = getProxiFields(0x01, "GPEC2A");
    const b = getProxiFields(0x01, "GPEC2B");
    // Both should include the same wildcard rows (e.g. byte 0 DRL Mode).
    expect(a.some((r) => r.name === "Daytime Running Lights Mode")).toBe(true);
    expect(b.some((r) => r.name === "Daytime Running Lights Mode")).toBe(true);
  });

  it("respects variant-specific overrides (Remote Start Runtime byte 5)", () => {
    const a = getProxiFields(0x01, "GPEC2A").filter((r) => r.byte === 5 && r.bit === 0);
    const b = getProxiFields(0x01, "GPEC2B").filter((r) => r.byte === 5 && r.bit === 0);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].type).toBe("uint");
    expect(b[0].type).toBe("enum");
  });

  it("is case-insensitive in the variant arg", () => {
    const upper = getProxiFields(0x02, "GPEC2A");
    const lower = getProxiFields(0x02, "gpec2a");
    expect(upper.length).toBe(lower.length);
    expect(upper.length).toBeGreaterThan(0);
  });

  it("returns [] for an unknown section", () => {
    expect(getProxiFields(0xEE, "GPEC2A")).toEqual([]);
  });
});

describe("readProxiField — MSB-first bit extraction", () => {
  it("reads a single bit", () => {
    const buf = new Uint8Array([0b10000000, 0b00000001]);
    expect(readProxiField(buf, 0, 0, 1)).toBe(1);
    expect(readProxiField(buf, 0, 1, 1)).toBe(0);
    expect(readProxiField(buf, 1, 7, 1)).toBe(1);
  });

  it("reads a multi-bit value within one byte", () => {
    // byte 0 = 0b1011 0000 → top 4 bits = 0xB
    const buf = new Uint8Array([0xB0, 0x00]);
    expect(readProxiField(buf, 0, 0, 4)).toBe(0xB);
  });

  it("reads a value that crosses a byte boundary", () => {
    // byte 0..1 = 0b00000011 0b11000000 → 4-bit field at bit 6 = 0b1111 = 0xF
    const buf = new Uint8Array([0x03, 0xC0]);
    expect(readProxiField(buf, 0, 6, 4)).toBe(0xF);
  });

  it("returns null when the field falls past the buffer", () => {
    const buf = new Uint8Array([0xFF]);
    expect(readProxiField(buf, 5, 0, 8)).toBeNull();
    // Bit-level overrun on the last byte:
    expect(readProxiField(buf, 0, 4, 8)).toBeNull();
  });

  it("round-trips through writeField for every catalog row", () => {
    // Pick the largest field offset to size the buffer.
    const maxByte = Math.max(...PROXI_FIELD_CATALOG.map((r) => r.byte));
    const buf = new Uint8Array(maxByte + 4);
    for (const r of PROXI_FIELD_CATALOG.slice(0, 12)) {
      const v = (1 << r.length) - 1; // all-ones value of correct width
      buf.fill(0);
      writeField(buf, r.byte, r.bit, r.length, v);
      expect(readProxiField(buf, r.byte, r.bit, r.length)).toBe(v);
    }
  });
});

describe("decodeProxiSection — end-to-end labelling", () => {
  it("labels enum fields by option text", () => {
    const buf = new Uint8Array(16);
    // Set byte 0 DRL Mode (bit 0, len 3) to 3 → "LED DRL"
    writeField(buf, 0, 0, 3, 3);
    const rows = decodeProxiSection(0x01, "GPEC2A", buf);
    const drl = rows.find((r) => r.name === "Daytime Running Lights Mode");
    expect(drl).toBeDefined();
    expect(drl.raw).toBe(3);
    expect(drl.label).toBe("3: LED DRL");
  });

  it("labels uint fields with decimal + hex", () => {
    const buf = new Uint8Array(16);
    // PCM Calibration ID — Major lives at byte 8, full byte
    writeField(buf, 8, 0, 8, 0x42);
    const rows = decodeProxiSection(0x02, "GPEC2A", buf);
    const calMaj = rows.find((r) => r.name === "PCM Calibration ID — Major");
    expect(calMaj.raw).toBe(0x42);
    expect(calMaj.label).toBe("66 (0x42)");
  });

  it("renders unknown enum values as a clear placeholder", () => {
    const buf = new Uint8Array(16);
    // DRL Mode = 7 (no matching option)
    writeField(buf, 0, 0, 3, 7);
    const rows = decodeProxiSection(0x01, "GPEC2A", buf);
    const drl = rows.find((r) => r.name === "Daytime Running Lights Mode");
    expect(drl.label).toMatch(/unknown/);
  });

  it("returns raw=null + '(out of range)' label on a short payload", () => {
    const buf = new Uint8Array(2); // only 16 bits
    const rows = decodeProxiSection(0x02, "GPEC2A", buf);
    const calMaj = rows.find((r) => r.name === "PCM Calibration ID — Major");
    expect(calMaj.raw).toBeNull();
    expect(calMaj.label).toBe("(out of range)");
  });

  it("integrates with parseProxi → section payloads", () => {
    // Build a synthetic PROXI record carrying a Body section payload
    // that sets DRL Mode = 1 (Low Beam) and Auto Headlights = on.
    const body = new Uint8Array(16);
    writeField(body, 0, 0, 3, 1); // DRL = Low Beam
    writeField(body, 0, 3, 1, 1); // Auto Headlights = on
    const raw = buildProxi([{ id: 0x01, payload: body }], 1);
    const parsed = parseProxi(raw);
    expect(parsed.ok).toBe(true);
    const sec = parsed.sections.find((s) => s.id === 0x01);
    expect(sec).toBeDefined();
    const rows = decodeProxiSection(sec.id, "GPEC2A", sec.payload);
    expect(rows.find((r) => r.name === "Daytime Running Lights Mode").label)
      .toBe("1: Low Beam");
    expect(rows.find((r) => r.name === "Auto Headlights").label)
      .toMatch(/Enabled/);
  });
});
