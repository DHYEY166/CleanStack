import { describe, expect, it } from "vitest";
import { safeCompare } from "./secrets";

describe("safeCompare", () => {
  it("matches identical secrets", () => expect(safeCompare("s3cret", "s3cret")).toBe(true));
  it("rejects different secrets of equal and unequal length", () => {
    expect(safeCompare("s3creT", "s3cret")).toBe(false);
    expect(safeCompare("s3cret-longer", "s3cret")).toBe(false);
  });
  it("fails closed when the expected secret is not configured", () => {
    expect(safeCompare("", "")).toBe(false);
    expect(safeCompare("anything", "")).toBe(false);
  });
});

describe("safeCompare edge cases", () => {
  it("does not throw on multi-byte input whose JS length matches", () => {
    // The old per-route copies compared string lengths, then called
    // timingSafeEqual on byte buffers of different lengths (RangeError -> 500).
    expect(() => safeCompare("é", "e")).not.toThrow();
    expect(safeCompare("é", "e")).toBe(false);
  });
  it("matches Bearer-prefixed cron secrets exactly", () => {
    expect(safeCompare("Bearer abc", "Bearer abc")).toBe(true);
    expect(safeCompare("Bearer ab", "Bearer abc")).toBe(false);
  });
});
