/* Unit tests for the CGW / BodyPN config decoder (Task #144).
 *
 * NB on fixture choice: the task spec mentions sourcing test bytes
 * from real BCM dumps in attached_assets/. After inspecting those
 * files we found they are flash images (64KB / 128KB EEPROM dumps),
 * NOT captured CAN response payloads, so they are not directly
 * decodable by this catalog — the catalog rows are indexed by
 * UDS-response bit offsets, not by flash file offsets.
 *
 * To still pin the bit-extraction + label-lookup behavior to a known
 * answer, we synthesize a byte vector that intentionally sets a small
 * set of catalog rows to known values, decode it, and assert the
 * labels resolve correctly. Once Task T1 is rerun against a clean .db
 * AND a real CAN response capture is available, swap the synthetic
 * vector for the real bytes — the assertions will hold unchanged
 * because they reference the catalog by setting name, not by index.
 */
import { describe, it, expect } from "vitest";
import {
  CGW_CONFIG,
} from "../alfaobdData.generated.js";
import {
  readBits,
  labelForValue,
  decodeConfigRows,
  decodeBcmConfig,
  decodeTipmCgwConfig,
  decodeFcmCgwConfig,
  decodeMarelliConfig,
  decodeDelphiRamConfig,
  decodeDelphi500Config,
  groupByRequest,
  REQUEST_RANGES,
} from "../cgwConfig.js";

describe("readBits — MSB-first bit extraction", () => {
  it("reads single bits", () => {
    /* 0b10110001 = 0xB1 — bits at positions 0..7 are 1,0,1,1,0,0,0,1 */
    const buf = new Uint8Array([0xb1]);
    expect(readBits(buf, 0, 1)).toBe(1);
    expect(readBits(buf, 1, 1)).toBe(0);
    expect(readBits(buf, 2, 1)).toBe(1);
    expect(readBits(buf, 3, 1)).toBe(1);
    expect(readBits(buf, 7, 1)).toBe(1);
  });

  it("reads multi-bit fields across a byte boundary", () => {
    /* 0xAB 0xCD = 0b10101011 0b11001101 — bits 6..9 = 1,1,1,1 = 0xF */
    const buf = new Uint8Array([0xab, 0xcd]);
    expect(readBits(buf, 6, 4)).toBe(0xf);
    /* bits 4..11 = 0b10111100 = 0xBC */
    expect(readBits(buf, 4, 8)).toBe(0xbc);
  });

  it("returns null when the field runs off the end", () => {
    const buf = new Uint8Array([0xff]);
    expect(readBits(buf, 4, 8)).toBeNull();
    expect(readBits(buf, 8, 1)).toBeNull();
  });

  it("returns null on empty/missing input", () => {
    expect(readBits(null, 0, 1)).toBeNull();
    expect(readBits(new Uint8Array(0), 0, 1)).toBeNull();
    expect(readBits(new Uint8Array([0xff]), 0, 0)).toBeNull();
  });
});

describe("labelForValue — option lookup with safe fallback", () => {
  const row = { name: "x", options: ["0: No", "1: Yes"] };
  it("strips the K: prefix from matching options", () => {
    expect(labelForValue(row, 0)).toBe("No");
    expect(labelForValue(row, 1)).toBe("Yes");
  });
  it("falls back to (unknown value 0xNN) for out-of-range values", () => {
    expect(labelForValue(row, 2)).toBe("(unknown value 0x02)");
    expect(labelForValue(row, 0xff)).toBe("(unknown value 0xFF)");
  });
  it("returns (out of range) when raw is null/undefined", () => {
    expect(labelForValue(row, null)).toBe("(out of range)");
    expect(labelForValue(row, undefined)).toBe("(out of range)");
  });
});

/* ----------------------------------------------------------------------
 * Per-table wrappers — pin the request-prefix routing.
 * -------------------------------------------------------------------- */
describe("per-CGW wrappers route the catalog by request prefix", () => {
  it("REQUEST_RANGES covers every distinct request prefix in the catalog", () => {
    const allPrefixes = new Set(CGW_CONFIG.map((r) => r.byte.slice(0, 2).toUpperCase()));
    const covered = new Set(Object.values(REQUEST_RANGES).flat());
    for (const p of allPrefixes) expect(covered.has(p)).toBe(true);
  });

  it("decodeBcmConfig only returns rows with 0x01.. or 0x02.. requests", () => {
    const rows = decodeBcmConfig(new Uint8Array(64));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(["01", "02"]).toContain(r.request.slice(0, 2));
  });

  it("decodeTipmCgwConfig only returns 0x3B.. requests", () => {
    const rows = decodeTipmCgwConfig(new Uint8Array(64));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.request.slice(0, 2)).toBe("3B");
  });

  it("decodeFcmCgwConfig only returns 0xF0.. requests", () => {
    const rows = decodeFcmCgwConfig(new Uint8Array(64));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.request.slice(0, 2)).toBe("F0");
  });

  it("decodeMarelliConfig / decodeDelphiRamConfig / decodeDelphi500Config share the 0xA0.. range", () => {
    const empty = new Uint8Array(64);
    const m = decodeMarelliConfig(empty);
    const dr = decodeDelphiRamConfig(empty);
    const d5 = decodeDelphi500Config(empty);
    expect(m.length).toBeGreaterThan(0);
    expect(m).toEqual(dr);
    expect(m).toEqual(d5);
    for (const r of m) expect(r.request.slice(0, 2)).toBe("A0");
  });
});

/* ----------------------------------------------------------------------
 * End-to-end decode against a synthetic byte vector.
 * -------------------------------------------------------------------- */
describe("decodeConfigRows — synthetic byte vector with hand-picked rows", () => {
  /* Pick a handful of BCM rows with `options.length > 0` and known bit
   * positions, build a buffer big enough to cover their highest bit,
   * set each chosen field to a specific raw value, then assert the
   * decoder recovers (raw, label) for each. */

  /* Find the "Air Conditioning Present" row (BCM, byte 0123 bit 35
   * length 1, options ["0: No", "1: Yes"]) — we'll set it to 1=Yes. */
  const acRow = CGW_CONFIG.find(
    (r) => r.byte === "0123" && r.name === "Air Conditioning Present",
  );
  /* "SKIM System Present" — same request, bit 34, length 1 → set to 1. */
  const skimRow = CGW_CONFIG.find(
    (r) => r.byte === "0123" && r.name === "SKIM System Present",
  );
  /* "Run Flat Tires Present" — bit 29 length 1 → set to 0=No. */
  const rftRow = CGW_CONFIG.find(
    (r) => r.byte === "0123" && r.name === "Run Flat Tires Present",
  );
  /* A multi-bit field: "Maserati Vehicle Mode" bit 30 length 2,
   * options index 2 = "RACE" → set raw=2. */
  const vmRow = CGW_CONFIG.find(
    (r) => r.byte === "0123" && r.name === "Maserati Vehicle Mode",
  );

  it("the chosen rows survived codegen (catalog precondition)", () => {
    expect(acRow).toBeDefined();
    expect(skimRow).toBeDefined();
    expect(rftRow).toBeDefined();
    expect(vmRow).toBeDefined();
    expect(vmRow.options[2]).toMatch(/RACE/i);
  });

  /* Build the buffer. Highest bit we touch is acRow.bit + acRow.length
   * - 1 = 35. Round up to a 32-byte buffer so we have headroom. */
  const buf = new Uint8Array(32);

  /* Helper: set `bitLength` bits at `bitOffset` (MSB-first) to `raw`. */
  function writeBits(b, bitOffset, bitLength, raw) {
    for (let i = 0; i < bitLength; i++) {
      const bit = (raw >> (bitLength - 1 - i)) & 1;
      const abs = bitOffset + i;
      const byteIdx = abs >> 3;
      const bitIdx = 7 - (abs & 7);
      if (bit) b[byteIdx] |= 1 << bitIdx;
      else     b[byteIdx] &= ~(1 << bitIdx);
    }
  }

  writeBits(buf, acRow.bit,   acRow.length,   1);   /* AC = Yes */
  writeBits(buf, skimRow.bit, skimRow.length, 1);   /* SKIM = Yes */
  writeBits(buf, rftRow.bit,  rftRow.length,  0);   /* Run Flat = No */
  writeBits(buf, vmRow.bit,   vmRow.length,   2);   /* Vehicle Mode = RACE */

  it("decodes the four hand-picked features to the expected labels", () => {
    const decoded = decodeBcmConfig(buf);
    const find = (name) => decoded.find((d) => d.setting === name && d.request === "0123");

    expect(find("Air Conditioning Present").raw).toBe(1);
    expect(find("Air Conditioning Present").label).toBe("Yes");

    expect(find("SKIM System Present").raw).toBe(1);
    expect(find("SKIM System Present").label).toBe("Yes");

    expect(find("Run Flat Tires Present").raw).toBe(0);
    expect(find("Run Flat Tires Present").label).toBe("No");

    expect(find("Maserati Vehicle Mode").raw).toBe(2);
    expect(find("Maserati Vehicle Mode").label).toMatch(/RACE/i);
  });

  it("rows that fall off the end of a short buffer are reported as out-of-range, not dropped", () => {
    /* A 4-byte buffer can only resolve bits 0..31; row at bit 35
     * (acRow) must report raw=null + label "(out of range)". */
    const tiny = new Uint8Array(4);
    const decoded = decodeBcmConfig(tiny);
    const ac = decoded.find((d) => d.setting === "Air Conditioning Present" && d.request === "0123");
    expect(ac.raw).toBeNull();
    expect(ac.label).toBe("(out of range)");
    /* And we must not lose the row entirely: */
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.every((d) => typeof d.setting === "string")).toBe(true);
  });

  it("(unknown value 0xNN) fallback fires for raw values outside the option list", () => {
    /* Pick a row with options length 2, jam in raw=2. The rftRow above
     * has bit 29 length 1, so we can't get raw=2 from it. Use vmRow's
     * length=2 field but corrupt the option list at decode time. */
    const synthRow = { ...vmRow, options: ["0: A", "1: B"] };
    const result = decodeConfigRows([synthRow], buf);
    /* buf has vmRow set to raw=2 → label must be "(unknown value 0x02)". */
    expect(result[0].raw).toBe(2);
    expect(result[0].label).toBe("(unknown value 0x02)");
  });
});

/* ----------------------------------------------------------------------
 * Per-decoder hand-picked label assertions (one known-good vector per
 * non-BCM wrapper). Hardens against silent regressions if the wrapper
 * routing or the underlying catalog rows ever drift.
 * -------------------------------------------------------------------- */
function writeBitsTo(b, bitOffset, bitLength, raw) {
  for (let i = 0; i < bitLength; i++) {
    const bit = (raw >> (bitLength - 1 - i)) & 1;
    const abs = bitOffset + i;
    const byteIdx = abs >> 3;
    const bitIdx = 7 - (abs & 7);
    if (bit) b[byteIdx] |= 1 << bitIdx;
    else     b[byteIdx] &= ~(1 << bitIdx);
  }
}

describe("decodeTipmCgwConfig — semantic label assertion", () => {
  /* "Configurable Inputs: Wheel Speed Sensor" lives at request 3B01,
   * bit 19 length 1, options ["0: Not Set","1: Set"]. Set raw=1 and
   * the decoder must report label="Set". */
  const buf = new Uint8Array(32);
  const row = CGW_CONFIG.find(
    (r) => r.byte === "3B01" && r.name === "Configurable Inputs: Wheel Speed Sensor",
  );
  it("the source row survived codegen", () => {
    expect(row).toBeDefined();
    expect(row.options).toEqual(["0: Not Set", "1: Set"]);
  });
  writeBitsTo(buf, row.bit, row.length, 1);
  it("decodes the row to the expected label", () => {
    const decoded = decodeTipmCgwConfig(buf);
    const hit = decoded.find((d) => d.setting === row.name && d.request === "3B01");
    expect(hit).toBeDefined();
    expect(hit.raw).toBe(1);
    expect(hit.label).toBe("Set");
  });
});

describe("decodeFcmCgwConfig — semantic label assertion", () => {
  /* "MSM Memory Seat Module" at F010 bit 35 length 1,
   * options ["0: Not enabled","1: Enabled"]. */
  const buf = new Uint8Array(32);
  const row = CGW_CONFIG.find(
    (r) => r.byte === "F010" && r.name === "MSM Memory Seat Module",
  );
  it("the source row survived codegen", () => {
    expect(row).toBeDefined();
    expect(row.options[1]).toMatch(/Enabled/i);
  });
  writeBitsTo(buf, row.bit, row.length, 1);
  it("decodes the row to the expected label", () => {
    const decoded = decodeFcmCgwConfig(buf);
    const hit = decoded.find((d) => d.setting === row.name && d.request === "F010");
    expect(hit).toBeDefined();
    expect(hit.raw).toBe(1);
    expect(hit.label).toBe("Enabled");
  });
});

describe("decodeMarelliConfig / decodeDelphiRamConfig — semantic label assertion (A0 family)", () => {
  /* "Sound Horn on Lock" at A050 bit 24 length 1,
   * options ["0: Not enabled","1: Enabled"]. */
  const buf = new Uint8Array(32);
  const row = CGW_CONFIG.find(
    (r) => r.byte === "A050" && r.name === "Sound Horn on Lock",
  );
  it("the source row survived codegen", () => {
    expect(row).toBeDefined();
  });
  writeBitsTo(buf, row.bit, row.length, 1);
  it("decodeMarelliConfig resolves the row to Enabled", () => {
    const decoded = decodeMarelliConfig(buf);
    const hit = decoded.find((d) => d.setting === row.name && d.request === "A050");
    expect(hit).toBeDefined();
    expect(hit.raw).toBe(1);
    expect(hit.label).toBe("Enabled");
  });
  it("decodeDelphiRamConfig resolves the row to Enabled (shared A0 range)", () => {
    const decoded = decodeDelphiRamConfig(buf);
    const hit = decoded.find((d) => d.setting === row.name && d.request === "A050");
    expect(hit).toBeDefined();
    expect(hit.label).toBe("Enabled");
  });
  it("decodeDelphi500Config resolves the row to Enabled (shared A0 range)", () => {
    const decoded = decodeDelphi500Config(buf);
    const hit = decoded.find((d) => d.setting === row.name && d.request === "A050");
    expect(hit).toBeDefined();
    expect(hit.label).toBe("Enabled");
  });
});

/* ----------------------------------------------------------------------
 * groupByRequest — used by the BCM Feature Matrix panel.
 * -------------------------------------------------------------------- */
describe("groupByRequest", () => {
  it("groups decoded rows by their request hex, preserving first-seen order", () => {
    const decoded = decodeBcmConfig(new Uint8Array(64));
    const grouped = groupByRequest(decoded);
    expect(grouped.size).toBeGreaterThan(0);
    /* Every key is a 4-char hex string. */
    for (const k of grouped.keys()) {
      expect(k).toMatch(/^[0-9A-F]{4}$/);
    }
    /* The first key matches the first decoded row's request (preserves
       insertion order — Map semantics). */
    expect(grouped.keys().next().value).toBe(decoded[0].request);
  });
});
