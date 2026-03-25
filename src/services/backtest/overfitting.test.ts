import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Trade } from "./types.js";
import { monteCarloShuffle, sensitivitySweep, overfittingReport } from "./overfitting.js";

// Helper: create a synthetic trade with a given pnl
function makeTrade(pnl: number, index: number): Trade {
  const DAY_MS = 86_400_000;
  return {
    id: `t${index}`,
    pair: "BTC",
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 101 : 99,
    entryTime: index * DAY_MS,
    exitTime: (index + 1) * DAY_MS,
    pnl,
    pnlPct: (pnl / 10_000) * 100,
    exitReason: "take-profit",
    fees: 0,
    slippage: 0,
    fundingCost: 0,
  };
}

// Strongly trending trades: consistent profits
function trendingTrades(count: number): Trade[] {
  return Array.from({ length: count }, (_, i) => makeTrade(100 + i * 2, i));
}

// Random PnLs: mix of wins and losses with no consistent pattern
function randomTrades(count: number): Trade[] {
  // Use deterministic alternating pattern so test is reliable
  return Array.from({ length: count }, (_, i) =>
    makeTrade(i % 2 === 0 ? 50 : -45, i),
  );
}

describe("monteCarloShuffle", () => {
  it("returns low p-value for clearly trending trades", () => {
    const trades = trendingTrades(50);
    const result = monteCarloShuffle(trades, 10_000, 200);
    expect(result.actualSharpe).toBeGreaterThan(0);
    expect(result.p_value).toBeLessThan(0.3); // trending should beat shuffles more often
    expect(result.runs).toBe(200);
    expect(typeof result.medianShuffledSharpe).toBe("number");
    expect(typeof result.percentile95).toBe("number");
    expect(typeof result.isSignificant).toBe("boolean");
  });

  it("returns high p-value for random PnL trades", () => {
    const trades = randomTrades(50);
    // Run multiple times since it's stochastic - with high run count
    const result = monteCarloShuffle(trades, 10_000, 500);
    // Random trades: actual Sharpe should be close to shuffled distribution
    expect(result.p_value).toBeGreaterThan(0.05);
  });

  it("returns not significant for 0 trades", () => {
    const result = monteCarloShuffle([], 10_000, 100);
    expect(result.isSignificant).toBe(false);
    expect(result.actualSharpe).toBe(0);
    expect(result.p_value).toBe(1);
    expect(result.runs).toBe(100);
  });

  it("uses default 1000 runs when not specified", () => {
    const trades = trendingTrades(10);
    const result = monteCarloShuffle(trades, 10_000);
    expect(result.runs).toBe(1000);
  });

  it("isSignificant is true when p_value < 0.01", () => {
    const trades = trendingTrades(50);
    const result = monteCarloShuffle(trades, 10_000, 200);
    expect(result.isSignificant).toBe(result.p_value < 0.01);
  });

  it("medianShuffledSharpe and percentile95 are computed", () => {
    const trades = trendingTrades(30);
    const result = monteCarloShuffle(trades, 10_000, 100);
    expect(result.medianShuffledSharpe).toBeGreaterThanOrEqual(0);
    expect(result.percentile95).toBeGreaterThanOrEqual(result.medianShuffledSharpe);
  });
});

describe("sensitivitySweep", () => {
  const baseParams = { threshold: 2.0 };
  const capitalUsd = 10_000;

  // Mock-friendly: create a signal generator factory
  function makeSignalGeneratorFactory(profitPerTrade: number) {
    return (params: Record<string, number>) => {
      void params; // use params to avoid lint error
      return () => null; // no signals - we inject trades via runBacktest mock
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("returns isRobust=true when >= 70% of variations are profitable", async () => {
    // 5 variations all profitable (pf > 1.0)
    const { sensitivitySweep: sweep } = await import("./overfitting.js");
    const variations = [
      { threshold: 1.5 },
      { threshold: 2.0 },
      { threshold: 2.5 },
      { threshold: 3.0 },
      { threshold: 3.5 },
    ];

    // Mock runBacktest to return profitable results
    vi.mock("./engine.js", () => ({
      runBacktest: vi.fn().mockReturnValue({
        trades: [makeTrade(100, 0), makeTrade(50, 1)],
        metrics: { sharpe: 1.5, profitFactor: 2.0, totalPnl: 150 },
        config: {},
      }),
    }));

    const result = await sweep(
      baseParams,
      variations,
      makeSignalGeneratorFactory(100),
      [],
      { pairs: ["BTC"], startTime: 0, endTime: 1e13, capitalUsd, leverage: 1, costConfig: { makerFeePct: 0, takerFeePct: 0, spreadMap: {}, defaultSpreadPct: 0, slippageMultiplierOnSL: 1 }, candleDir: "", fundingDir: "" },
    );

    expect(result.pctProfitable).toBe(100);
    expect(result.isRobust).toBe(true);
    expect(result.results).toHaveLength(5);
  });

  it("returns isRobust=false when < 70% of variations are profitable", async () => {
    const { sensitivitySweep: sweep } = await import("./overfitting.js");
    const variations = [
      { threshold: 1.5 },
      { threshold: 2.0 },
      { threshold: 2.5 },
      { threshold: 3.0 },
      { threshold: 3.5 },
    ];

    // Mock runBacktest to return 2 profitable, 3 unprofitable
    let callCount = 0;
    vi.mock("./engine.js", () => ({
      runBacktest: vi.fn().mockImplementation(() => {
        callCount++;
        const profitable = callCount <= 2;
        return {
          trades: [],
          metrics: { sharpe: profitable ? 1.0 : -0.5, profitFactor: profitable ? 1.5 : 0.7, totalPnl: profitable ? 100 : -50 },
          config: {},
        };
      }),
    }));

    const result = await sweep(
      baseParams,
      variations,
      makeSignalGeneratorFactory(-50),
      [],
      { pairs: ["BTC"], startTime: 0, endTime: 1e13, capitalUsd, leverage: 1, costConfig: { makerFeePct: 0, takerFeePct: 0, spreadMap: {}, defaultSpreadPct: 0, slippageMultiplierOnSL: 1 }, candleDir: "", fundingDir: "" },
    );

    expect(result.isRobust).toBe(false);
    expect(result.results).toHaveLength(5);
  });

  it("result entries contain params, sharpe, pf, pnl", async () => {
    const { sensitivitySweep: sweep } = await import("./overfitting.js");
    const variations = [{ threshold: 2.0 }];

    vi.mock("./engine.js", () => ({
      runBacktest: vi.fn().mockReturnValue({
        trades: [],
        metrics: { sharpe: 0.8, profitFactor: 1.2, totalPnl: 200 },
        config: {},
      }),
    }));

    const result = await sweep(
      baseParams,
      variations,
      makeSignalGeneratorFactory(100),
      [],
      { pairs: ["BTC"], startTime: 0, endTime: 1e13, capitalUsd, leverage: 1, costConfig: { makerFeePct: 0, takerFeePct: 0, spreadMap: {}, defaultSpreadPct: 0, slippageMultiplierOnSL: 1 }, candleDir: "", fundingDir: "" },
    );

    expect(result.results[0]).toMatchObject({
      params: { threshold: 2.0 },
      sharpe: expect.any(Number),
      pf: expect.any(Number),
      pnl: expect.any(Number),
    });
  });

  it("pctProfitable is 40 when 2 of 5 are profitable", async () => {
    const { sensitivitySweep: sweep } = await import("./overfitting.js");
    const variations = Array.from({ length: 5 }, (_, i) => ({ threshold: i + 1 }));

    let callIdx = 0;
    vi.mock("./engine.js", () => ({
      runBacktest: vi.fn().mockImplementation(() => {
        const profitable = callIdx++ < 2;
        return {
          trades: [],
          metrics: { sharpe: profitable ? 1.0 : -0.5, profitFactor: profitable ? 1.5 : 0.7, totalPnl: 0 },
          config: {},
        };
      }),
    }));

    const result = await sweep(
      baseParams,
      variations,
      makeSignalGeneratorFactory(0),
      [],
      { pairs: ["BTC"], startTime: 0, endTime: 1e13, capitalUsd, leverage: 1, costConfig: { makerFeePct: 0, takerFeePct: 0, spreadMap: {}, defaultSpreadPct: 0, slippageMultiplierOnSL: 1 }, candleDir: "", fundingDir: "" },
    );

    expect(result.pctProfitable).toBe(40);
    expect(result.isRobust).toBe(false);
  });
});

describe("overfittingReport", () => {
  it("returns oosIsPass=true when oosIsRatio >= 0.5", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.7, 100);
    expect(report.oosIsPass).toBe(true);
    expect(report.oosIsRatio).toBe(0.7);
  });

  it("returns oosIsPass=false when oosIsRatio < 0.5", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.3, 100);
    expect(report.oosIsPass).toBe(false);
  });

  it("overallPass requires both monteCarlo.isSignificant and oosIsPass", () => {
    const trades = trendingTrades(50);

    // Case: both pass
    const report1 = overfittingReport(trades, 10_000, 0.8, 100);
    expect(report1.overallPass).toBe(report1.monteCarlo.isSignificant && report1.oosIsPass);

    // Case: oos fails
    const report2 = overfittingReport(trades, 10_000, 0.2, 100);
    expect(report2.overallPass).toBe(false);
  });

  it("summary is a non-empty string", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.6, 100);
    expect(typeof report.summary).toBe("string");
    expect(report.summary.length).toBeGreaterThan(0);
  });

  it("report contains monteCarlo result", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.5, 100);
    expect(report.monteCarlo).toBeDefined();
    expect(typeof report.monteCarlo.p_value).toBe("number");
    expect(typeof report.monteCarlo.isSignificant).toBe("boolean");
  });

  it("handles 0 trades gracefully", () => {
    const report = overfittingReport([], 10_000, 0.4, 100);
    expect(report.monteCarlo.isSignificant).toBe(false);
    expect(report.oosIsPass).toBe(false);
    expect(report.overallPass).toBe(false);
  });
});
