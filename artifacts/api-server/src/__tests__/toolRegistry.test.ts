/**
 * Unit tests for the AI module assistant tool registry.
 *
 * Every tool is tested against synthetic fixture bytes so the suite runs
 * without any real ECU dumps and without hitting the network.
 */

import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, MAX_TOOL_RESULT_BYTES } from "../routes/anthropic/toolRegistry";

/* ─── Fixture helpers ─── */

/** 8 KB buffer, mostly 0xFF padding with a few planted bytes */
function makeFixture(size = 8192): Buffer {
  const buf = Buffer.alloc(size, 0xff);
  // Plant a VIN at offset 0x275
  const vin = "1C4HJXEG2MW512345";
  Buffer.from(vin, "ascii").copy(buf, 0x275);
  // Plant a second VIN (reversed for RFHUB Gen1 style)
  const rev = Buffer.from("1C4HJXEG2MW567890".split("").reverse().join(""), "ascii");
  rev.copy(buf, 0x92);
  // Plant a 16-byte key at offset 0x300
  const key = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]);
  key.copy(buf, 0x300);
  // Plant some 0xAA 0x50 markers
  buf[0x500] = 0xaa; buf[0x501] = 0x50;
  buf[0x520] = 0xaa; buf[0x521] = 0x50;
  // Plant a short ASCII string
  Buffer.from("TEST_STRING_HERE", "ascii").copy(buf, 0x200);
  return buf;
}

/** BCM-sized fixture (64 KB) with immo block */
function makeBcmFixture(): Buffer {
  const buf = Buffer.alloc(65536, 0xff);
  const vin = "1C4HJXEG2MW512345";
  Buffer.from(vin, "ascii").copy(buf, 0x5328);
  // immo block
  buf[0x40c0] = 0x01; buf[0x40c1] = 0x23;
  return buf;
}

const EMPTY_BINARIES: Record<string, Buffer> = {};

/* ─── read_hex ─── */

describe("read_hex", () => {
  const handler = TOOL_REGISTRY.read_hex.handler;

  it("returns a formatted hex dump at the given offset", async () => {
    const buf = makeFixture();
    buf[0x10] = 0xab; buf[0x11] = 0xcd;
    const result = await handler(buf, EMPTY_BINARIES, { offset: 0x10, length: 2 });
    expect(result).toContain("AB");
    expect(result).toContain("CD");
    expect(result).toContain("0x10");
  });

  it("clamps to file end when offset + length exceeds size", async () => {
    const buf = makeFixture(256);
    const result = await handler(buf, EMPTY_BINARIES, { offset: 250, length: 64 });
    expect(result).toContain("6 bytes"); // only 6 remain
  });

  it("returns an error when offset is past end of file", async () => {
    const buf = makeFixture(256);
    const result = await handler(buf, EMPTY_BINARIES, { offset: 9999, length: 16 });
    expect(result).toMatch(/past end/i);
  });

  it("result length stays within MAX_TOOL_RESULT_BYTES", async () => {
    const buf = makeFixture(65536);
    const result = await handler(buf, EMPTY_BINARIES, { offset: 0, length: 4096 });
    expect(result.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 100);
  });
});

/* ─── extract_strings ─── */

describe("extract_strings", () => {
  const handler = TOOL_REGISTRY.extract_strings.handler;

  it("finds planted ASCII strings", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { minLen: 6 });
    expect(result).toContain("TEST_STRING_HERE");
  });

  it("finds the planted VIN string", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { minLen: 10 });
    expect(result).toContain("1C4HJXEG2MW512345");
  });

  it("reports no strings when buffer is all 0xFF", async () => {
    const buf = Buffer.alloc(256, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, { minLen: 6 });
    expect(result).toMatch(/no strings/i);
  });

  it("respects minLen parameter", async () => {
    const buf = Buffer.alloc(32, 0xff);
    Buffer.from("HI", "ascii").copy(buf, 0); // 2 chars — below default 6
    const result = await handler(buf, EMPTY_BINARIES, { minLen: 6 });
    expect(result).toMatch(/no strings/i);
  });
});

/* ─── search_patterns ─── */

describe("search_patterns", () => {
  const handler = TOOL_REGISTRY.search_patterns.handler;

  it("finds a hex pattern (AA 50)", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "AA 50", kind: "hex" });
    expect(result).toContain("0x000500");
    expect(result).toContain("0x000520");
  });

  it("finds an ASCII pattern", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "TEST_STRING", kind: "ascii" });
    expect(result).toContain("0x000200");
  });

  it("returns no-matches message when pattern is absent", async () => {
    const buf = Buffer.alloc(256, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "AA BB CC", kind: "hex" });
    expect(result).toMatch(/no matches/i);
  });

  it("returns an error for unknown kind", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "x", kind: "unknown" });
    expect(result).toMatch(/unknown kind/i);
  });

  it("returns error when pattern is empty for hex/ascii", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "", kind: "ascii" });
    expect(result).toMatch(/pattern is required/i);
  });

  it("crypto kind finds the planted high-entropy 16-byte key", async () => {
    /* The fixture plants 01 02 03 ... 10 at 0x300 — 16 unique bytes, no FF/00 runs */
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "", kind: "crypto" });
    expect(result).toMatch(/01 02 03 04 05 06 07 08/);
  });

  it("crypto kind with no pattern works (empty pattern allowed)", async () => {
    const buf = Buffer.alloc(256, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, { pattern: "", kind: "crypto" });
    expect(result).toMatch(/no matches/i);
  });
});

/* ─── eeprom_layout_scan ─── */

describe("eeprom_layout_scan", () => {
  const handler = TOOL_REGISTRY.eeprom_layout_scan.handler;

  it("identifies a BCM-sized buffer", async () => {
    const buf = makeBcmFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toMatch(/BCM/i);
    expect(result).toContain("65536");
  });

  it("reports the planted VIN slot", async () => {
    const buf = makeBcmFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("1C4HJXEG2MW512345");
  });

  it("reports large 0xFF regions", async () => {
    const buf = Buffer.alloc(4096, 0xff);
    Buffer.from("HELLO", "ascii").copy(buf, 100);
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toMatch(/0xFF region/i);
  });

  it("result stays within cap", async () => {
    const buf = makeBcmFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES + 100);
  });
});

/* ─── key_secrets_scan ─── */

describe("key_secrets_scan", () => {
  const handler = TOOL_REGISTRY.key_secrets_scan.handler;

  it("finds the planted 16-byte key", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    // The planted key sequence (01 02 03 ... 0E 0F 10) should appear in SEC16
    // candidates regardless of whether the scan starts at 0x2FE (with leading
    // 0xFF padding bytes) or 0x300 — the bytes themselves are the signal.
    expect(result).toMatch(/01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E/);
  });

  it("finds the planted AA 50 markers", async () => {
    const buf = makeFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("0x000500");
  });

  it("reports no SEC16 candidates on all-FF buffer", async () => {
    const buf = Buffer.alloc(256, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("(none found matching criteria)");
  });
});

/* ─── parse_module ─── */

describe("parse_module", () => {
  const handler = TOOL_REGISTRY.parse_module.handler;

  it("identifies RFHUB Gen1 by size", async () => {
    const buf = Buffer.alloc(2048, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("RFHUB_GEN1");
  });

  it("identifies BCM by size", async () => {
    const buf = makeBcmFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("BCM_OR_XC2268");
  });

  it("reports planted VIN", async () => {
    const buf = makeBcmFixture();
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toContain("1C4HJXEG2MW512345");
  });

  it("reports byte statistics", async () => {
    const buf = Buffer.alloc(4096, 0xff);
    const result = await handler(buf, EMPTY_BINARIES, {});
    expect(result).toMatch(/0xFF bytes/);
    expect(result).toMatch(/100\.0%/);
  });
});

/* ─── hex_diff ─── */

describe("hex_diff", () => {
  const handler = TOOL_REGISTRY.hex_diff.handler;

  it("reports byte differences between two buffers", async () => {
    const primary = Buffer.alloc(256, 0xaa);
    const other = Buffer.alloc(256, 0xaa);
    other[10] = 0xbb;
    other[20] = 0xcc;
    const binaries = { rfhub: other };
    const result = await handler(primary, binaries, { otherId: "rfhub", offset: 0, length: 256 });
    expect(result).toContain("0x00000A"); // offset 10
    expect(result).toContain("0x000014"); // offset 20
    expect(result).toContain("AA");
    expect(result).toContain("BB");
  });

  it("reports no differences when buffers are identical", async () => {
    const primary = Buffer.alloc(64, 0x55);
    const binaries = { bcm: Buffer.alloc(64, 0x55) };
    const result = await handler(primary, binaries, { otherId: "bcm", offset: 0, length: 64 });
    expect(result).toMatch(/no differences/i);
  });

  it("returns an error when otherId is not in binaries", async () => {
    const primary = Buffer.alloc(64, 0x00);
    const result = await handler(primary, {}, { otherId: "missing", offset: 0, length: 64 });
    expect(result).toMatch(/not found/i);
    expect(result).toContain("missing");
  });

  it("lists available binary ids in the error message", async () => {
    const primary = Buffer.alloc(64, 0x00);
    const binaries = { bcm: Buffer.alloc(64), rfhub: Buffer.alloc(64) };
    const result = await handler(primary, binaries, { otherId: "wrong", offset: 0, length: 64 });
    expect(result).toContain("bcm");
    expect(result).toContain("rfhub");
  });
});
