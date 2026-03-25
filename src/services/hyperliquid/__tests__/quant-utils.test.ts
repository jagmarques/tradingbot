import { describe, it, expect } from "vitest";
import { calcAtrStopLoss, calcKellySize } from "../quant-utils.js";

describe("calcAtrStopLoss", () => {
  it("returns entry minus 1.5*ATR for long", () => {
    expect(calcAtrStopLoss(100, 2, "long", 1.5)).toBeCloseTo(97);
  });

  it("returns entry plus 1.5*ATR for short", () => {
    expect(calcAtrStopLoss(100, 2, "short", 1.5)).toBeCloseTo(103);
  });

  it("falls back to 3% SL when ATR is null (long)", () => {
    expect(calcAtrStopLoss(100, null, "long")).toBeCloseTo(97);
  });

  it("falls back to 3% SL when ATR is zero (short)", () => {
    expect(calcAtrStopLoss(100, 0, "short")).toBeCloseTo(103);
  });

  it("enforces minimum 0.5% distance for long when ATR stop is too tight", () => {
    // ATR stop = 100 - 1.5*0.1 = 99.85, distance=0.15% < 0.5%, so clamp to 99.5
    expect(calcAtrStopLoss(100, 0.1, "long", 1.5)).toBeCloseTo(99.5);
  });

  it("enforces minimum 0.5% distance for short when ATR stop is too tight", () => {
    // ATR stop = 100 + 1.5*0.1 = 100.15, distance=0.15% < 0.5%, so clamp to 100.5
    expect(calcAtrStopLoss(100, 0.1, "short", 1.5)).toBeCloseTo(100.5);
  });

  it("uses custom multiplier", () => {
    expect(calcAtrStopLoss(100, 2, "long", 2.0)).toBeCloseTo(96);
  });

  it("uses custom fallbackSlPct", () => {
    expect(calcAtrStopLoss(100, null, "long", 1.5, 0.05)).toBeCloseTo(95);
  });

  it("returns absolute price, not percentage", () => {
    const result = calcAtrStopLoss(50000, 500, "long", 1.5);
    // 50000 - 1.5*500 = 49250
    expect(result).toBeCloseTo(49250);
  });

  it("falls back to fixed SL when ATR is negative", () => {
    expect(calcAtrStopLoss(100, -1, "long")).toBeCloseTo(97);
  });
});

describe("calcKellySize", () => {
  it("returns 0 when confidence is exactly 50", () => {
    expect(calcKellySize(50, 1000, 0.03)).toBe(0);
  });

  it("returns 0 when confidence is below 50", () => {
    expect(calcKellySize(40, 1000, 0.03)).toBe(0);
    expect(calcKellySize(0, 1000, 0.03)).toBe(0);
  });

  it("returns 0 when equity is zero", () => {
    expect(calcKellySize(60, 0, 0.03)).toBe(0);
  });

  it("returns 0 when equity is negative", () => {
    expect(calcKellySize(60, -100, 0.03)).toBe(0);
  });

  it("calculates quarter-Kelly correctly for confidence=60", () => {
    // edge=0.1, fraction=0.025, kelly=25; riskCap=666, balCap=200 -> 25
    expect(calcKellySize(60, 1000, 0.03)).toBeCloseTo(25);
  });

  it("respects 20% balance cap", () => {
    // confidence=90: edge=0.4, frac=0.1, kelly=100; riskCap=666, balCap=200 -> 100
    expect(calcKellySize(90, 1000, 0.03)).toBeCloseTo(100);
  });

  it("respects 2% equity risk cap", () => {
    // confidence=70: edge=0.2, frac=0.05, kelly=50; riskCap=(1000*0.02)/0.01=2000, balCap=200 -> 50
    expect(calcKellySize(70, 1000, 0.01)).toBeCloseTo(50);
  });

  it("returns 0 when kelly result is below minSizeUsd", () => {
    // kelly for conf=60, equity=100: 2.5 < 10
    expect(calcKellySize(60, 100, 0.03)).toBe(0);
  });

  it("uses custom minSizeUsd", () => {
    // kelly=25 for conf=60 equity=1000 - above minSizeUsd=20
    expect(calcKellySize(60, 1000, 0.03, 20)).toBeCloseTo(25);
  });

  it("returns 0 when confidence=100 but result still below minSizeUsd", () => {
    // confidence=100: edge=0.5, frac=0.125, kelly=1.25 < 10
    expect(calcKellySize(100, 10, 0.03)).toBe(0);
  });

  it("does not apply riskCap when stopLossPct is zero", () => {
    // stopLossPct=0 -> riskCap skipped, result=min(kelly, balCap)
    // confidence=70: kelly=50, balCap=200 -> 50
    expect(calcKellySize(70, 1000, 0)).toBeCloseTo(50);
  });
});
