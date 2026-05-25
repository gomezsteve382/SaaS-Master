/**
 * Tests for the pattern extraction pipeline (Task #695).
 *
 * Covers: extractFromAnalysis → dedup, VIN extraction, module signatures,
 * security bytes, calibration IDs, CAN IDs, algo hints, and KG triples.
 */

import { describe, it, expect } from "vitest";
import { extractFromAnalysis } from "../lib/patternExtractor";

const SAMPLE_VIN = "1C4RJFLGXJC123456";
const SAMPLE_VIN_2 = "3C4PDCGG4GT123456";

describe("extractFromAnalysis — VIN encoding", () => {
  it("extracts a root-level VIN", () => {
    const { patterns, nodes } = extractFromAnalysis(
      { vin: SAMPLE_VIN, module: "BCM" },
      "test-analysis-001",
    );
    const vinPat = patterns.find((p) => p.category === "vin_encoding");
    expect(vinPat).toBeDefined();
    expect(vinPat!.label).toContain(SAMPLE_VIN);
    expect(vinPat!.confidence).toBeGreaterThanOrEqual(0.9);

    const vinNode = nodes.find((n) => n.nodeType === "VIN");
    expect(vinNode).toBeDefined();
    expect(vinNode!.label).toBe(SAMPLE_VIN);
  });

  it("extracts nested info.vin", () => {
    const { patterns } = extractFromAnalysis(
      { info: { vin: SAMPLE_VIN, type: "RFHUB" } },
      "test-002",
    );
    expect(patterns.find((p) => p.category === "vin_encoding")).toBeDefined();
  });

  it("ignores invalid VINs", () => {
    const { patterns } = extractFromAnalysis({ vin: "NOT_A_VIN" }, "test-003");
    expect(patterns.filter((p) => p.category === "vin_encoding")).toHaveLength(0);
  });

  it("extracts VINs from XC2268 slots", () => {
    const { patterns } = extractFromAnalysis(
      {
        info: {
          xc2268: {
            slot1: { vin: SAMPLE_VIN },
            slot2: { vin: SAMPLE_VIN_2 },
          },
        },
      },
      "xc-test",
    );
    const vinPats = patterns.filter((p) => p.category === "vin_encoding");
    expect(vinPats).toHaveLength(2);
  });

  it("extracts VINs from ZF8HP slots", () => {
    const { patterns } = extractFromAnalysis(
      {
        info: {
          zf8hp: {
            slot1: { vin: SAMPLE_VIN },
            slot2: { vin: SAMPLE_VIN_2 },
          },
        },
      },
      "zf-test",
    );
    const vinPats = patterns.filter((p) => p.category === "vin_encoding");
    expect(vinPats).toHaveLength(2);
  });

  it("deduplicates the same VIN across slots", () => {
    const { patterns, nodes } = extractFromAnalysis(
      {
        vin: SAMPLE_VIN,
        info: { vin: SAMPLE_VIN, type: "BCM" },
      },
      "dup-test",
    );
    const vinPats = patterns.filter((p) => p.category === "vin_encoding");
    expect(vinPats).toHaveLength(1);
    const vinNodes = nodes.filter((n) => n.nodeType === "VIN");
    expect(vinNodes).toHaveLength(1);
  });
});

describe("extractFromAnalysis — module signature", () => {
  it("produces a module signature pattern", () => {
    const { patterns, nodes } = extractFromAnalysis(
      { module: "GPEC2A", partNumber: "68278900AA", swVersion: "40.09" },
      "gpec-test",
    );
    const modPat = patterns.find((p) => p.category === "module_signature");
    expect(modPat).toBeDefined();
    expect(modPat!.label).toContain("GPEC2A");
    expect(modPat!.label).toContain("68278900AA");

    const modNode = nodes.find((n) => n.nodeType === "MODULE");
    expect(modNode).toBeDefined();
    expect((modNode!.metadata as Record<string, unknown>).partNumber).toBe("68278900AA");
  });

  it("does not produce module pattern for UNKNOWN type", () => {
    const { patterns } = extractFromAnalysis({ module: "UNKNOWN" }, "unk-test");
    expect(patterns.filter((p) => p.category === "module_signature")).toHaveLength(0);
  });

  it("uses moduleType field as fallback", () => {
    const { patterns } = extractFromAnalysis({ moduleType: "RFHUB" }, "mt-test");
    expect(patterns.find((p) => p.category === "module_signature")).toBeDefined();
  });
});

describe("extractFromAnalysis — security bytes", () => {
  it("extracts sec16 pattern", () => {
    const { patterns } = extractFromAnalysis(
      { module: "BCM", sec16: "AABBCCDDEEFF00112233445566778899" },
      "sec-test",
    );
    const secPat = patterns.find((p) => p.category === "security_bytes");
    expect(secPat).toBeDefined();
    expect(secPat!.label).toMatch(/SEC16/);
    expect(secPat!.confidence).toBeLessThan(1);
  });

  it("extracts sec6 pattern", () => {
    const { patterns } = extractFromAnalysis(
      { module: "PCM", sec6: "AABBCCDDEE" },
      "sec6-test",
    );
    const secPats = patterns.filter((p) => p.category === "security_bytes");
    expect(secPats.some((p) => p.label.includes("SEC6"))).toBe(true);
  });

  it("ignores short or non-hex sec16 (less than 4 bytes)", () => {
    const { patterns } = extractFromAnalysis({ sec16: "AB" }, "bad-sec");
    expect(patterns.filter((p) => p.category === "security_bytes")).toHaveLength(0);
  });

  it("links sec bytes to module node via shares_secret_with edge", () => {
    const { edges } = extractFromAnalysis(
      { module: "BCM", sec16: "AABBCCDDEEFF00112233445566778899" },
      "sec-edge-test",
    );
    const secEdge = edges.find((e) => e.edgeType === "shares_secret_with");
    expect(secEdge).toBeDefined();
    expect(secEdge!.fromType).toBe("MODULE");
    expect(secEdge!.toType).toBe("SECBYTES");
  });
});

describe("extractFromAnalysis — calibration IDs", () => {
  it("extracts calibration ID pattern and node", () => {
    const { patterns, nodes, edges } = extractFromAnalysis(
      { module: "RFHUB", calibrationId: "CAL-2024-RFHUB-01" },
      "cal-test",
    );
    const calPat = patterns.find((p) => p.category === "calibration_id");
    expect(calPat).toBeDefined();
    expect(calPat!.label).toContain("CAL-2024-RFHUB-01");

    const calNode = nodes.find((n) => n.nodeType === "CALIBID");
    expect(calNode).toBeDefined();

    const calEdge = edges.find((e) => e.edgeType === "has_calibration");
    expect(calEdge).toBeDefined();
  });

  it("extracts array of calibration IDs", () => {
    const { patterns } = extractFromAnalysis(
      { module: "ECM", calibrationIds: ["CAL-A", "CAL-B"] },
      "cal-arr",
    );
    expect(patterns.filter((p) => p.category === "calibration_id")).toHaveLength(2);
  });

  it("skips empty calibration ID strings", () => {
    const { patterns } = extractFromAnalysis(
      { module: "ECM", calibrationId: "  " },
      "cal-empty",
    );
    expect(patterns.filter((p) => p.category === "calibration_id")).toHaveLength(0);
  });
});

describe("extractFromAnalysis — CAN IDs", () => {
  it("produces CAN ID nodes for tx/rx", () => {
    const { nodes, edges } = extractFromAnalysis(
      { module: "BCM", tx: 0x640, rx: 0x648 },
      "can-test",
    );
    const txNode = nodes.find((n) => n.nodeType === "CANID" && n.label === "0x640");
    expect(txNode).toBeDefined();
    const rxNode = nodes.find((n) => n.nodeType === "CANID" && n.label === "0x648");
    expect(rxNode).toBeDefined();

    const canEdge = edges.find(
      (e) => e.edgeType === "seen_together" && e.toType === "CANID",
    );
    expect(canEdge).toBeDefined();
  });

  it("ignores tx=0 (absent/invalid)", () => {
    const { nodes } = extractFromAnalysis({ module: "BCM", tx: 0 }, "no-can");
    expect(nodes.filter((n) => n.nodeType === "CANID")).toHaveLength(0);
  });

  it("formats CAN ID hex with 3-char padding", () => {
    const { nodes } = extractFromAnalysis({ module: "ECM", tx: 0x7E0 }, "can-fmt");
    const canNode = nodes.find((n) => n.nodeType === "CANID");
    expect(canNode!.label).toBe("0x7E0");
  });
});

describe("extractFromAnalysis — algo hints", () => {
  it("extracts algo hint pattern and node", () => {
    const { patterns, nodes, edges } = extractFromAnalysis(
      { module: "RFHUB", algoHint: "sxor_0x01" },
      "algo-test",
    );
    const algoPat = patterns.find((p) => p.category === "seed_key_constant");
    expect(algoPat).toBeDefined();

    const algoNode = nodes.find((n) => n.nodeType === "ALGO");
    expect(algoNode).toBeDefined();
    expect(algoNode!.label).toBe("sxor_0x01");

    const algoEdge = edges.find((e) => e.edgeType === "uses_algo");
    expect(algoEdge).toBeDefined();
    expect(algoEdge!.fromType).toBe("MODULE");
    expect(algoEdge!.toType).toBe("ALGO");
  });

  it("ignores empty algo hint", () => {
    const { patterns } = extractFromAnalysis({ module: "BCM", algoHint: "" }, "no-algo");
    expect(patterns.filter((p) => p.category === "seed_key_constant")).toHaveLength(0);
  });
});

describe("extractFromAnalysis — knowledge graph edges", () => {
  it("links VIN to MODULE via seen_together", () => {
    const { edges } = extractFromAnalysis(
      { vin: SAMPLE_VIN, module: "BCM", partNumber: "68123456AA" },
      "edge-test",
    );
    const vinModEdge = edges.find(
      (e) =>
        e.fromType === "VIN" &&
        e.toType === "MODULE" &&
        e.edgeType === "seen_together",
    );
    expect(vinModEdge).toBeDefined();
    expect(vinModEdge!.fromLabel).toBe(SAMPLE_VIN);
  });

  it("links two VINs seen together in same blob", () => {
    const { edges } = extractFromAnalysis(
      {
        module: "BCM",
        vin: SAMPLE_VIN,
        info: { xc2268: { slot1: { vin: SAMPLE_VIN_2 } } },
      },
      "multi-vin",
    );
    const vinVinEdge = edges.find(
      (e) => e.fromType === "VIN" && e.toType === "VIN" && e.edgeType === "seen_together",
    );
    expect(vinVinEdge).toBeDefined();
  });

  it("does not create duplicate edges", () => {
    const { edges } = extractFromAnalysis(
      { vin: SAMPLE_VIN, module: "BCM" },
      "dedup-edge",
    );
    const vinModEdges = edges.filter(
      (e) =>
        e.fromLabel === SAMPLE_VIN &&
        e.toType === "MODULE" &&
        e.edgeType === "seen_together",
    );
    expect(vinModEdges).toHaveLength(1);
  });
});

describe("extractFromAnalysis — signature hash dedup", () => {
  it("produces the same signatureHash for the same VIN regardless of source field", () => {
    const r1 = extractFromAnalysis({ vin: SAMPLE_VIN }, "a");
    const r2 = extractFromAnalysis({ info: { vin: SAMPLE_VIN } }, "b");
    const h1 = r1.patterns.find((p) => p.category === "vin_encoding")?.signatureHash;
    const h2 = r2.patterns.find((p) => p.category === "vin_encoding")?.signatureHash;
    expect(h1).toBeDefined();
    expect(h1).toBe(h2);
  });

  it("produces different signatureHash for different VINs", () => {
    const r1 = extractFromAnalysis({ vin: SAMPLE_VIN }, "a");
    const r2 = extractFromAnalysis({ vin: SAMPLE_VIN_2 }, "b");
    const h1 = r1.patterns.find((p) => p.category === "vin_encoding")?.signatureHash;
    const h2 = r2.patterns.find((p) => p.category === "vin_encoding")?.signatureHash;
    expect(h1).not.toBe(h2);
  });

  it("signatureHash is always 32 hex chars", () => {
    const { patterns } = extractFromAnalysis({ vin: SAMPLE_VIN, module: "BCM" }, "hash-len");
    for (const p of patterns) {
      expect(p.signatureHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
