import { describe, it, expect } from "vitest";
import {
  executeTool,
  ForbiddenToolError,
  __test,
} from "../routes/anthropic/investigationSwarm/toolExecutor";

const { handleUdsStaticDecode, handlePatternLookup, handleKgQuery } = __test;

describe("uds_static_decode", () => {
  it("requires the bytes argument", () => {
    expect(handleUdsStaticDecode({})).toMatch(/bytes argument is required/);
  });

  it("decodes a negative response (7F 22 31)", () => {
    const out = handleUdsStaticDecode({ bytes: "7F 22 31" });
    expect(out).toMatch(/NegativeResponse/);
    expect(out).toMatch(/ReadDataByIdentifier/);
    expect(out).toMatch(/requestOutOfRange|ROOR/i);
  });

  it("decodes a positive RDBI response with a known DID (62 F1 90 …)", () => {
    const vinAscii = "1C4SDHCT0FC123456";
    const vinHex = Array.from(vinAscii)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(" ");
    const out = handleUdsStaticDecode({ bytes: `62 F1 90 ${vinHex}` });
    expect(out).toMatch(/ReadDataByIdentifier positive response/);
    expect(out).toMatch(/0xF190/);
    expect(out).toMatch(/VIN/i);
  });

  it("decodes a sub-function service (10 03 = extendedDiagnosticSession)", () => {
    const out = handleUdsStaticDecode({ bytes: "10 03" });
    expect(out).toMatch(/DiagnosticSessionControl request/);
    expect(out).toMatch(/extendedDiagnosticSession/);
  });

  it("accepts contiguous hex without spaces and 0x prefixes", () => {
    const a = handleUdsStaticDecode({ bytes: "7F2231" });
    const b = handleUdsStaticDecode({ bytes: "0x7F 0x22 0x31" });
    expect(a).toMatch(/NegativeResponse/);
    expect(b).toMatch(/NegativeResponse/);
  });
});

describe("pattern_lookup", () => {
  const buf = Buffer.from([
    0x00, 0xaa, 0x50, 0x11, 0x22, 0x33, 0xaa, 0x50, 0xff, 0xff, 0xaa, 0x50, 0x99,
  ]);

  it("requires a pattern argument", () => {
    expect(handlePatternLookup({}, buf, {})).toMatch(/pattern argument is required/);
  });

  it("rejects invalid hex", () => {
    expect(handlePatternLookup({ pattern: "ZZ" }, buf, {})).toMatch(/invalid hex pattern/);
    expect(handlePatternLookup({ pattern: "A" }, buf, {})).toMatch(/invalid hex pattern/);
  });

  it("finds every occurrence of a hex pattern in the primary buffer", () => {
    const out = handlePatternLookup({ pattern: "AA 50" }, buf, {});
    expect(out).toMatch(/3 match\(es\)/);
    expect(out).toMatch(/0x000001/);
    expect(out).toMatch(/0x000006/);
    expect(out).toMatch(/0x00000A/);
  });

  it("returns a clean message when nothing matches", () => {
    const out = handlePatternLookup({ pattern: "DEADBEEF" }, buf, {});
    expect(out).toMatch(/No matches/);
  });

  it("searches a named secondary binary when target is provided", () => {
    const sec = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad]);
    const out = handlePatternLookup(
      { pattern: "DE AD", target: "rfhub" },
      buf,
      { rfhub: sec },
    );
    expect(out).toMatch(/in rfhub/);
    expect(out).toMatch(/2 match\(es\)/);
  });

  it("reports unknown target", () => {
    expect(
      handlePatternLookup({ pattern: "00", target: "nope" }, buf, {}),
    ).toMatch(/target "nope" not loaded/);
  });

  it("refuses to search an empty primary buffer", () => {
    expect(handlePatternLookup({ pattern: "00" }, Buffer.alloc(0), {})).toMatch(
      /no binary loaded/,
    );
  });
});

describe("kg_query", () => {
  it("requires a query argument", async () => {
    expect(await handleKgQuery({})).toMatch(/query argument is required/);
  });

  it("finds unlock_catalog entries by module name (abs)", async () => {
    const out = await handleKgQuery({ query: "abs" });
    expect(out).toMatch(/Unlock catalog/);
    expect(out).toMatch(/\[unlock\]/);
    expect(out).toMatch(/abs/i);
  });

  it("finds unlock_catalog entries by algorithm name", async () => {
    const out = await handleKgQuery({ query: "t8_xor" });
    expect(out).toMatch(/algorithm=t8_xor/);
  });

  it("finds BCM features by DID (DE00)", async () => {
    const out = await handleKgQuery({ query: "DE00" });
    expect(out).toMatch(/BCM feature catalog/);
    expect(out).toMatch(/\[bcm-feature\] DE00/);
  });

  it("finds BCM features by name fragment", async () => {
    const out = await handleKgQuery({ query: "auto lock" });
    expect(out).toMatch(/BCM feature catalog/);
    expect(out.toLowerCase()).toMatch(/auto.?lock/);
  });

  it("reports zero matches without crashing", async () => {
    const out = await handleKgQuery({ query: "definitely-not-a-real-token-xyz123" });
    expect(out).toMatch(/No matches/);
    expect(out).toMatch(/unlock_catalog entries/);
    expect(out).toMatch(/BCM DE-feature rows/);
  });

  it("actually loaded both catalogs (non-empty index counts)", async () => {
    // Guards against silent fallback to empty arrays when path resolution
    // breaks in bundled production builds.
    const out = await handleKgQuery({ query: "definitely-not-a-real-token-xyz123" });
    const m = out.match(/Indexed: (\d+) unlock_catalog entries, (\d+) BCM DE-feature rows/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![2])).toBeGreaterThan(0);
    expect(out).not.toMatch(/WARNING: catalog data/);
  });
});

describe("executeTool dispatch", () => {
  it("routes to the three swarm tools", async () => {
    const buf = Buffer.from([0xaa, 0x50]);
    expect(await executeTool("uds_static_decode", { bytes: "10 03" }, buf, {})).toMatch(
      /extendedDiagnosticSession/,
    );
    expect(await executeTool("pattern_lookup", { pattern: "AA 50" }, buf, {})).toMatch(
      /1 match/,
    );
    expect(await executeTool("kg_query", { query: "DE00" }, buf, {})).toMatch(
      /BCM feature catalog/,
    );
  });

  it("raises ForbiddenToolError for write-side tools", async () => {
    await expect(
      executeTool("write_hex", {}, Buffer.alloc(0), {}),
    ).rejects.toBeInstanceOf(ForbiddenToolError);
  });
});
