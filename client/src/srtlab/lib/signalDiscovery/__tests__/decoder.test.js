import { describe, it, expect } from "vitest";
import {
  decodeBytes,
  hexToBytes,
  bytesToHex,
  pearson,
  linearRegression,
  bestCandidate,
  CANDIDATE_DECODERS,
} from "../decoder.js";

const dec = (name) => CANDIDATE_DECODERS.find((d) => d.name === name);

describe("decodeBytes", () => {
  it("u8 reads single bytes at offset", () => {
    expect(decodeBytes(hexToBytes("DEADBEEF"), dec("u8"), 0)).toBe(0xde);
    expect(decodeBytes(hexToBytes("DEADBEEF"), dec("u8"), 3)).toBe(0xef);
  });

  it("i8 sign-extends", () => {
    expect(decodeBytes(new Uint8Array([0xff]), dec("i8"), 0)).toBe(-1);
    expect(decodeBytes(new Uint8Array([0x80]), dec("i8"), 0)).toBe(-128);
    expect(decodeBytes(new Uint8Array([0x7f]), dec("i8"), 0)).toBe(127);
  });

  it("u16BE vs u16LE byte-order", () => {
    const b = new Uint8Array([0x12, 0x34]);
    expect(decodeBytes(b, dec("u16BE"), 0)).toBe(0x1234);
    expect(decodeBytes(b, dec("u16LE"), 0)).toBe(0x3412);
  });

  it("i16BE/LE sign-extend correctly", () => {
    const b = new Uint8Array([0xff, 0xfe]);
    expect(decodeBytes(b, dec("i16BE"), 0)).toBe(-2);
    expect(decodeBytes(b, dec("i16LE"), 0)).toBe(-257);
  });

  it("u32BE wraps the full uint32 range", () => {
    const b = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(decodeBytes(b, dec("u32BE"), 0)).toBe(0xffffffff);
  });

  it("i32BE sign-extends negative full-range values", () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]), dec("i32BE"), 0)).toBe(-1);
    expect(decodeBytes(new Uint8Array([0x80, 0x00, 0x00, 0x00]), dec("i32BE"), 0)).toBe(-2147483648);
    expect(decodeBytes(new Uint8Array([0x7f, 0xff, 0xff, 0xff]), dec("i32BE"), 0)).toBe(2147483647);
  });

  it("i32LE sign-extends with reversed byte-order", () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]), dec("i32LE"), 0)).toBe(-1);
    expect(decodeBytes(new Uint8Array([0x00, 0x00, 0x00, 0x80]), dec("i32LE"), 0)).toBe(-2147483648);
    expect(decodeBytes(new Uint8Array([0xfe, 0xff, 0xff, 0xff]), dec("i32LE"), 0)).toBe(-2);
  });

  it("returns NaN on out-of-range offset", () => {
    expect(decodeBytes(new Uint8Array([1, 2]), dec("u32BE"), 0)).toBeNaN();
    expect(decodeBytes(new Uint8Array([1, 2, 3, 4]), dec("u8"), 5)).toBeNaN();
  });
});

describe("hex helpers", () => {
  it("hexToBytes round-trips bytesToHex", () => {
    const b = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(b)).toBe("DE AD BE EF");
    expect(Array.from(hexToBytes("DE AD BE EF"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("hexToBytes ignores non-hex separators", () => {
    expect(Array.from(hexToBytes("DE-AD,BE EF"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("pearson", () => {
  it("returns 1 for a perfect linear relationship", () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });
  it("returns -1 for inverse linear relationship", () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });
  it("returns NaN for zero-variance input", () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBeNaN();
  });
});

describe("linearRegression", () => {
  it("recovers slope and intercept of y = 2x + 3", () => {
    const xs = [0, 1, 2, 3, 4, 5];
    const ys = xs.map((x) => 2 * x + 3);
    const r = linearRegression(xs, ys);
    expect(r.slope).toBeCloseTo(2, 10);
    expect(r.intercept).toBeCloseTo(3, 10);
  });
});

describe("bestCandidate", () => {
  it("picks u8 at offset 0 when raw bytes equal ground truth", () => {
    const samples = [
      new Uint8Array([10, 0, 0]),
      new Uint8Array([20, 0, 0]),
      new Uint8Array([30, 0, 0]),
      new Uint8Array([40, 0, 0]),
    ];
    const truth = [10, 20, 30, 40];
    const best = bestCandidate(samples, truth);
    expect(best).not.toBeNull();
    expect(best.byteOffset).toBe(0);
    expect(best.rSquared).toBeCloseTo(1, 8);
    expect(best.slope).toBeCloseTo(1, 8);
    expect(best.intercept).toBeCloseTo(0, 8);
  });

  it("recovers a scaled u16BE at a non-zero offset", () => {
    // raw = (truth - 40) / 0.05  → ground truth = 0.05 * raw + 40.
    // This is the classic OBD-II coolant-temp / load-percent shape.
    const truth = [80, 90, 100, 110, 120, 130];
    const samples = truth.map((t) => {
      const raw = Math.round((t - 40) / 0.05);
      const buf = new Uint8Array([0xaa, (raw >> 8) & 0xff, raw & 0xff, 0x00]);
      return buf;
    });
    const best = bestCandidate(samples, truth);
    expect(best).not.toBeNull();
    expect(best.decoder).toBe("u16BE");
    expect(best.byteOffset).toBe(1);
    expect(best.rSquared).toBeCloseTo(1, 6);
    expect(best.slope).toBeCloseTo(0.05, 6);
    expect(best.intercept).toBeCloseTo(40, 4);
  });

  it("returns null when there are fewer than 3 samples", () => {
    expect(bestCandidate([new Uint8Array([1])], [1])).toBeNull();
  });
});
