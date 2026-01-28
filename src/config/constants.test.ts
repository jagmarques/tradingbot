import { describe, it, expect } from "vitest";
import {
  PUMPFUN_PROGRAM_ID,
  SELL_TARGETS,
  SPLIT_BUY,
  MIN_CONFIDENCE_PERCENTAGE,
  CAPITAL_PER_STRATEGY_USD,
} from "./constants.js";

describe("constants", () => {
  it("has valid pump.fun program ID", () => {
    expect(PUMPFUN_PROGRAM_ID).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  });

  it("sell targets are ascending", () => {
    expect(SELL_TARGETS.FIRST).toBeLessThan(SELL_TARGETS.SECOND);
    expect(SELL_TARGETS.SECOND).toBeLessThan(SELL_TARGETS.THIRD);
  });

  it("split buy percentages sum to 1", () => {
    const total = SPLIT_BUY.INITIAL + SPLIT_BUY.SECOND + SPLIT_BUY.THIRD;
    expect(total).toBeCloseTo(1.0);
  });

  it("confidence threshold is between 0 and 100", () => {
    expect(MIN_CONFIDENCE_PERCENTAGE).toBeGreaterThan(0);
    expect(MIN_CONFIDENCE_PERCENTAGE).toBeLessThanOrEqual(100);
  });

  it("capital per strategy is $50", () => {
    expect(CAPITAL_PER_STRATEGY_USD).toBe(50);
  });
});
