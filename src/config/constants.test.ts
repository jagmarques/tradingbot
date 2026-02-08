import { describe, it, expect } from "vitest";
import {
  MIN_CONFIDENCE_PERCENTAGE,
  CAPITAL_PER_STRATEGY_USD,
} from "./constants.js";

describe("constants", () => {
  it("confidence threshold is between 0 and 100", () => {
    expect(MIN_CONFIDENCE_PERCENTAGE).toBeGreaterThan(0);
    expect(MIN_CONFIDENCE_PERCENTAGE).toBeLessThanOrEqual(100);
  });

  it("capital per strategy is $50", () => {
    expect(CAPITAL_PER_STRATEGY_USD).toBe(50);
  });
});
