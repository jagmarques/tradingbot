import { describe, it, expect } from "vitest";
import {
  calcSlippage,
  calcFees,
  calcFundingCost,
  calcTotalTradeCost,
  DEFAULT_COST_CONFIG,
} from "./costs.js";
import type { FundingEntry } from "./types.js";

// Helper to build funding entries for tests
function makeFundingEntries(baseTime: number, rates: number[]): FundingEntry[] {
  return rates.map((rate, i) => ({
    time: baseTime + i * 3600_000, // 1h apart
    rate,
  }));
}

describe("DEFAULT_COST_CONFIG", () => {
  it("has Hyperliquid maker fee 0.01%", () => {
    expect(DEFAULT_COST_CONFIG.makerFeePct).toBe(0.0001);
  });

  it("has Hyperliquid taker fee 0.035%", () => {
    expect(DEFAULT_COST_CONFIG.takerFeePct).toBe(0.00035);
  });

  it("has BTC spread entry", () => {
    expect(DEFAULT_COST_CONFIG.spreadMap["BTC"]).toBeDefined();
    expect(DEFAULT_COST_CONFIG.spreadMap["BTC"]).toBeGreaterThan(0);
  });

  it("has default spread fallback", () => {
    expect(DEFAULT_COST_CONFIG.defaultSpreadPct).toBe(0.0004);
  });

  it("has SL multiplier of 1.5", () => {
    expect(DEFAULT_COST_CONFIG.slippageMultiplierOnSL).toBe(1.5);
  });
});

describe("calcSlippage", () => {
  it("returns price * spread for normal BTC entry (price=50000)", () => {
    // BTC not in spreadMap by key "BTC" - defaultSpreadPct is 0.0004 unless BTC is mapped
    // Plan spec: price=50000, pair="BTC", isStopLoss=false -> 50000 * 0.0001 = 5.00
    // So BTC must be in spreadMap at 0.0001
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { BTC: 0.0001 },
    };
    const result = calcSlippage(50000, "BTC", false, config);
    expect(result).toBeCloseTo(5.0, 6);
  });

  it("applies SL multiplier on stop-loss exits", () => {
    // price=50000, BTC spread=0.0001, multiplier=1.5 -> 50000 * 0.0001 * 1.5 = 7.50
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { BTC: 0.0001 },
      slippageMultiplierOnSL: 1.5,
    };
    const result = calcSlippage(50000, "BTC", true, config);
    expect(result).toBeCloseTo(7.5, 6);
  });

  it("falls back to defaultSpreadPct for unknown pair", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: {},
      defaultSpreadPct: 0.0004,
    };
    const result = calcSlippage(10000, "UNKNOWN", false, config);
    expect(result).toBeCloseTo(4.0, 6); // 10000 * 0.0004
  });

  it("uses per-pair spread from spreadMap", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { ETH: 0.00015 },
    };
    const result = calcSlippage(3000, "ETH", false, config);
    expect(result).toBeCloseTo(0.45, 6); // 3000 * 0.00015
  });
});

describe("calcFees", () => {
  it("applies taker fee correctly (0.035%)", () => {
    const result = calcFees(100, false, DEFAULT_COST_CONFIG);
    expect(result).toBeCloseTo(0.035, 6); // 100 * 0.00035
  });

  it("applies maker fee correctly (0.01%)", () => {
    const result = calcFees(100, true, DEFAULT_COST_CONFIG);
    expect(result).toBeCloseTo(0.01, 6); // 100 * 0.0001
  });

  it("scales linearly with notional", () => {
    const result = calcFees(1000, false, DEFAULT_COST_CONFIG);
    expect(result).toBeCloseTo(0.35, 6); // 1000 * 0.00035
  });
});

describe("calcFundingCost", () => {
  const BASE_TIME = 1_700_000_000_000; // arbitrary ms timestamp

  it("charges longs when funding is positive", () => {
    // direction=long, notional=100, 2 bars, rates=[0.0001, 0.0001] -> 0.02
    const entries = makeFundingEntries(BASE_TIME, [0.0001, 0.0001]);
    const barTimestamps = [BASE_TIME, BASE_TIME + 3600_000];
    const result = calcFundingCost("long", 100, 2, barTimestamps, entries);
    expect(result).toBeCloseTo(0.02, 6);
  });

  it("pays shorts when funding is positive (sign flip)", () => {
    // direction=short, notional=100, 2 bars, rates=[0.0001, 0.0001] -> -0.02
    const entries = makeFundingEntries(BASE_TIME, [0.0001, 0.0001]);
    const barTimestamps = [BASE_TIME, BASE_TIME + 3600_000];
    const result = calcFundingCost("short", 100, 2, barTimestamps, entries);
    expect(result).toBeCloseTo(-0.02, 6);
  });

  it("returns 0 when no funding entries available", () => {
    const result = calcFundingCost("long", 100, 2, [BASE_TIME, BASE_TIME + 3600_000], []);
    expect(result).toBe(0);
  });

  it("returns 0 for 0 hold bars", () => {
    const entries = makeFundingEntries(BASE_TIME, [0.0001]);
    const result = calcFundingCost("long", 100, 0, [], entries);
    expect(result).toBe(0);
  });

  it("sums funding across multiple bars", () => {
    // Mixed rates
    const entries = makeFundingEntries(BASE_TIME, [0.0001, 0.0002, -0.0001]);
    const barTimestamps = [BASE_TIME, BASE_TIME + 3600_000, BASE_TIME + 7200_000];
    // long: (0.0001 + 0.0002 + (-0.0001)) * 100 = 0.02
    const result = calcFundingCost("long", 100, 3, barTimestamps, entries);
    expect(result).toBeCloseTo(0.02, 6);
  });

  it("returns 0 for bar with no nearby funding entry (gap > 2h)", () => {
    // Single entry at BASE_TIME, bar at BASE_TIME + 3h (10800000ms) -> no entry within 2h
    const entries: FundingEntry[] = [{ time: BASE_TIME, rate: 0.001 }];
    const farTimestamp = BASE_TIME + 10_800_000; // 3h later
    const result = calcFundingCost("long", 100, 1, [farTimestamp], entries);
    expect(result).toBe(0);
  });
});

describe("calcTotalTradeCost", () => {
  const BASE_TIME = 1_700_000_000_000;

  it("aggregates all cost components correctly", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { BTC: 0.0001 },
      slippageMultiplierOnSL: 1.5,
    };
    // entryPrice=50000, exitPrice=51000, notional=100, pair=BTC, long, not SL, 2 bars
    const entries = makeFundingEntries(BASE_TIME, [0.0001, 0.0001]);
    const barTimestamps = [BASE_TIME, BASE_TIME + 3600_000];

    const result = calcTotalTradeCost(
      50000, // entryPrice
      51000, // exitPrice
      100,   // notional
      "BTC",
      "long",
      false, // isStopLossExit
      2,
      barTimestamps,
      entries,
      config,
    );

    // Entry slippage: 50000 * 0.0001 = 5.0
    // Exit slippage: 51000 * 0.0001 = 5.1 (no SL multiplier)
    // Entry fee: 100 * 0.00035 = 0.035
    // Exit fee: 100 * 0.00035 = 0.035
    // Funding: 0.0001 * 100 * 2 = 0.02
    // Total = 5.0 + 5.1 + 0.035 + 0.035 + 0.02 = 10.19

    expect(result.slippage).toBeCloseTo(10.1, 4); // 5.0 + 5.1
    expect(result.fees).toBeCloseTo(0.07, 6);     // 0.035 + 0.035
    expect(result.funding).toBeCloseTo(0.02, 6);
    expect(result.total).toBeCloseTo(10.19, 4);
  });

  it("applies SL multiplier on stop-loss exit", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { BTC: 0.0001 },
      slippageMultiplierOnSL: 1.5,
    };
    const result = calcTotalTradeCost(
      50000, // entry
      49000, // exit (SL hit)
      100,
      "BTC",
      "long",
      true, // isStopLossExit
      0,
      [],
      [],
      config,
    );

    // Entry slippage: 50000 * 0.0001 = 5.0
    // Exit slippage: 49000 * 0.0001 * 1.5 = 7.35
    expect(result.slippage).toBeCloseTo(12.35, 4); // 5.0 + 7.35
    expect(result.funding).toBe(0);
  });

  it("returns breakdown with all four keys", () => {
    const result = calcTotalTradeCost(
      1000, 1010, 100, "ETH", "long", false, 0, [], [], DEFAULT_COST_CONFIG,
    );
    expect(result).toHaveProperty("slippage");
    expect(result).toHaveProperty("fees");
    expect(result).toHaveProperty("funding");
    expect(result).toHaveProperty("total");
  });

  it("total equals slippage + fees + funding", () => {
    const config = {
      ...DEFAULT_COST_CONFIG,
      spreadMap: { SOL: 0.0002 },
    };
    const entries = makeFundingEntries(BASE_TIME, [0.0001]);
    const result = calcTotalTradeCost(
      150, 155, 500, "SOL", "long", false, 1, [BASE_TIME], entries, config,
    );
    expect(result.total).toBeCloseTo(result.slippage + result.fees + result.funding, 6);
  });

  it("funding reduces total for shorts when positive funding", () => {
    // Shorts receive when funding is positive (negative cost for shorts)
    const entries = makeFundingEntries(BASE_TIME, [0.001]);
    const result = calcTotalTradeCost(
      50000, 49000, 100, "BTC", "short", false, 1, [BASE_TIME], entries, DEFAULT_COST_CONFIG,
    );
    expect(result.funding).toBeLessThan(0); // short receives funding
  });
});
