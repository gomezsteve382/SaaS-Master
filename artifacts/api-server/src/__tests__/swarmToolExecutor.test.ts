import { describe, it, expect } from "vitest";
import {
  executeTool,
  ForbiddenToolError,
  __test,
} from "../routes/anthropic/investigationSwarm/toolExecutor";

const {
  handleUdsStaticDecode,
  handlePatternLookup,
  handleKgQuery,
  handleDecodeBcmFeature,
} = __test;

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

describe("decode_bcm_feature", () => {
  it("errors when called with no name and no did", async () => {
    const out = await handleDecodeBcmFeature({}, Buffer.alloc(0));
    expect(out).toMatch(/provide either `name` .* or `did`/);
  });

  it("returns NRC when the catalog matches but no BCM dump is loaded (0x2023)", async () => {
    // DID 0x2023 rows live in BODY_PN_CONFIG (BCM proxi blob).
    const out = await handleDecodeBcmFeature({ did: "2023" }, Buffer.alloc(0));
    expect(out).toMatch(/NRC: no BCM dump loaded/);
    expect(out).toMatch(/offset 0x2023/);
  });

  it("returns NRC when the loaded buffer is too small for DID 0x2023", async () => {
    const tiny = Buffer.alloc(0x100); // way smaller than 0x2033
    const out = await handleDecodeBcmFeature({ did: "2023" }, tiny);
    expect(out).toMatch(/NRC: loaded buffer is only/);
    expect(out).toMatch(/too small to contain DID 0x2023/);
  });

  it("returns NRC for a DEnn field when no `bytes` payload is supplied", async () => {
    const out = await handleDecodeBcmFeature(
      { did: "DE00", bit: 3, length: 7 }, // DRL Intensity
      Buffer.alloc(0),
    );
    expect(out).toMatch(/NRC: DID DE00 is not in the BCM flash dump/);
    expect(out).toMatch(/0x22 DE 00/);
  });

  it("decodes an OPTION-valued field by name (DE01 'Auto Lock Speed' = 15 mph)", async () => {
    // bit=0, length=8 → first payload byte is the raw value.
    // 15 == option "15 mph"
    const out = await handleDecodeBcmFeature(
      { name: "Auto Lock Speed", bytes: "0F" },
      Buffer.alloc(0),
    );
    expect(out).toMatch(/DE01/);
    expect(out).toMatch(/Auto Lock Speed/);
    expect(out).toMatch(/value=15/);
    expect(out).toMatch(/15 mph/);
  });

  it("strips a `62 DD DD` UDS positive-response header before decoding", async () => {
    // Same field, but caller pastes the raw UDS response (62 DE 01 0F).
    const out = await handleDecodeBcmFeature(
      { did: "DE01", bit: 0, length: 8, bytes: "62 DE 01 0F" },
      Buffer.alloc(0),
    );
    expect(out).toMatch(/value=15/);
    expect(out).toMatch(/15 mph/);
  });

  it("decodes an INTEGER-valued field by did+bit+length (DE00 'DRL Intensity' = 42)", async () => {
    // bit=3, length=7. Value 42 (0b0101010) packs as byte0=0x0A, byte1=0x80.
    const out = await handleDecodeBcmFeature(
      { did: "DE00", bit: 3, length: 7, bytes: "0A 80" },
      Buffer.alloc(0),
    );
    expect(out).toMatch(/DE00/);
    expect(out).toMatch(/DRL Intensity/);
    expect(out).toMatch(/value=42/);
    expect(out).toMatch(/\(integer\)/);
  });

  it("returns NRC when the supplied payload is too short for the field", async () => {
    // DE00 bit=66 length=1 needs ≥ 9 bytes; supply only 1.
    const out = await handleDecodeBcmFeature(
      { did: "DE00", bit: 66, length: 1, bytes: "00" },
      Buffer.alloc(0),
    );
    expect(out).toMatch(/NRC: 1-byte payload too short/);
  });

  it("lists candidates when a name matches too many rows to decode at once", async () => {
    // "Mode" appears in many DEnn rows across multiple DIDs.
    const out = await handleDecodeBcmFeature({ name: "mode" }, Buffer.alloc(0));
    expect(out).toMatch(/Ambiguous: \d+ catalog rows matched/);
    expect(out).toMatch(/Narrow with `did`/);
  });

  it("returns a no-match NRC for a feature name that doesn't exist", async () => {
    const out = await handleDecodeBcmFeature(
      { name: "definitely-not-a-real-bcm-feature-zzz" },
      Buffer.alloc(0),
    );
    expect(out).toMatch(/NRC: no catalog match/);
    expect(out).toMatch(/DEnn rows/);
    expect(out).toMatch(/BODY_PN \(0x2023\) rows/);
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
