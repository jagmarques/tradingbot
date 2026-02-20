import { describe, it, expect } from "vitest";
import {
  CAPITAL_PER_STRATEGY_USD,
} from "./constants.js";

describe("constants", () => {
  it("capital per strategy is $50", () => {
    expect(CAPITAL_PER_STRATEGY_USD).toBe(50);
  });
});
