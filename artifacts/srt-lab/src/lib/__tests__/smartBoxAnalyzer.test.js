import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSmartBox,
  isSmartBoxImage,
  extractAsciiStrings,
  SMARTBOX_SIZE,
  SMARTBOX_VIN_OFFSETS,
  SMARTBOX_VIN_STRIDE,
} from "../smartBoxAnalyzer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo-root/attached_assets — same hop count the GPEC2A analyzer test uses.
const ASSETS = resolve(__dirname, "../../../../..", "attached_assets");

function smartBoxFiles() {
  let names = [];
  try {
    names = readdirSync(ASSETS);
  } catch {
    return [];
  }
  return names
    .filter((n) => /SmartBox/i.test(n) && /MC9S12XEG384/i.test(n) && n.endsWith(".bin"))
    .map((n) => ({ name: n, bytes: new Uint8Array(readFileSync(resolve(ASSETS, n))) }))
    .filter((f) => f.bytes.length === SMARTBOX_SIZE);
}

const CORPUS = smartBoxFiles();
// A "programmed" dump is one whose 4 mirror slots all decode to a valid VIN.
// The corpus also contains a couple of virgin/uninitialized captures.
const PROGRAMMED = CORPUS.map((f) => ({ ...f, r: analyzeSmartBox(f.bytes) })).filter(
  (f) => f.r.validVinCount === 4
);

describe("smartBoxAnalyzer — corpus", () => {
  it("staged Journey SmartBox dumps are present (programmed + virgin)", () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    expect(PROGRAMMED.length).toBeGreaterThan(0);
  });

  it("every programmed dump is recognized as a SmartBox/RFHUB-Gen2 EEE image", () => {
    for (const { name, bytes } of PROGRAMMED) {
      expect(isSmartBoxImage(bytes), name).toBe(true);
    }
  });

  it("every programmed dump yields a consistent consensus VIN across all 4 mirrors", () => {
    for (const { name, r } of PROGRAMMED) {
      expect(r.ok, name).toBe(true);
      expect(r.sizeOk, name).toBe(true);
      expect(r.vinConsistent, name).toBe(true);
      expect(r.consensusVin, name).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
      expect(r.state, name).toBe("PROGRAMMED");
      expect(r.confidence, name).toBeGreaterThanOrEqual(80);
    }
  });

  it("every record exposes a 2-byte trailer at VIN+17", () => {
    for (const { name, r } of PROGRAMMED) {
      expect(r.vinRecords).toHaveLength(4);
      for (const rec of r.vinRecords) {
        expect(rec.trailerOffset, `${name} @${rec.offsetHex}`).toBe(rec.offset + 17);
        expect(rec.trailerHex, `${name} @${rec.offsetHex}`).toMatch(/^[0-9A-F]{2} [0-9A-F]{2}$/);
      }
    }
  });

  it("surfaces the FCA part-number block (shared 0712804 family core)", () => {
    for (const { name, r } of PROGRAMMED) {
      const hasPart = r.identifiers.some((s) => s.text.includes("0712804"));
      expect(hasPart, name).toBe(true);
    }
  });
});

describe("smartBoxAnalyzer — known sample", () => {
  const SAMPLE = CORPUS.find((f) => /OGFILE1_/i.test(f.name));

  it("decodes the byte-reversed VIN for the OGFILE1 sample", () => {
    if (!SAMPLE) return; // corpus optional in minimal checkouts
    const r = analyzeSmartBox(SAMPLE.bytes);
    // stored "539761HG0GGACC3C2" reversed → "2C3CCAGG0GH167935"
    expect(r.consensusVin).toBe("2C3CCAGG0GH167935");
  });
});

describe("smartBoxAnalyzer — guards", () => {
  it("rejects non-buffers", () => {
    expect(analyzeSmartBox(null).ok).toBe(false);
    expect(analyzeSmartBox("nope").ok).toBe(false);
  });

  it("isSmartBoxImage is false for the wrong size or a blank buffer", () => {
    expect(isSmartBoxImage(new Uint8Array(2048))).toBe(false);
    expect(isSmartBoxImage(new Uint8Array(SMARTBOX_SIZE))).toBe(false); // all-zero, no VIN
  });

  it("a virgin (all-FF) image analyzes as VIRGIN / NO VIN without throwing", () => {
    const blank = new Uint8Array(SMARTBOX_SIZE).fill(0xff);
    const r = analyzeSmartBox(blank);
    expect(r.ok).toBe(true);
    expect(r.validVinCount).toBe(0);
    expect(r.state).toBe("VIRGIN / NO VIN");
    expect(r.isSmartBoxLike).toBe(false);
  });

  it("VIN offsets are the canonical Gen2 set, stride 0x14", () => {
    expect(SMARTBOX_VIN_OFFSETS).toEqual([0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1]);
    for (let i = 1; i < SMARTBOX_VIN_OFFSETS.length; i++) {
      expect(SMARTBOX_VIN_OFFSETS[i] - SMARTBOX_VIN_OFFSETS[i - 1]).toBe(SMARTBOX_VIN_STRIDE);
    }
  });

  it("extractAsciiStrings finds tagged runs", () => {
    const buf = new Uint8Array(64).fill(0x00);
    const s = "HELLO123";
    for (let i = 0; i < s.length; i++) buf[10 + i] = s.charCodeAt(i);
    const runs = extractAsciiStrings(buf, { minLen: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ offset: 10, text: "HELLO123" });
  });
});
