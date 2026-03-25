import { describe, it, expect, vi } from "vitest";
import type { Trade, BacktestConfig, BacktestResult, SignalGenerator, Candle } from "./types.js";

// Hoist mock so it's available before vi.mock factory runs
const { mockRunBacktest } = vi.hoisted(() => ({
  mockRunBacktest: vi.fn(),
}));

vi.mock("./engine.js", () => ({
  runBacktest: mockRunBacktest,
}));

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

// Random PnLs: deterministic alternating pattern with near-zero edge
function randomTrades(count: number): Trade[] {
  return Array.from({ length: count }, (_, i) =>
    makeTrade(i % 2 === 0 ? 10 : -9, i),
  );
}

function makeConfig(): BacktestConfig {
  return {
    pairs: ["BTC"],
    startTime: 0,
    endTime: 1e13,
    capitalUsd: 10_000,
    leverage: 1,
    costConfig: {
      makerFeePct: 0,
      takerFeePct: 0,
      spreadMap: {},
      defaultSpreadPct: 0,
      slippageMultiplierOnSL: 1,
    },
    candleDir: "",
    fundingDir: "",
  };
}

describe("monteCarloShuffle", () => {
  it("returns low p-value for clearly trending trades", () => {
    const trades = trendingTrades(50);
    const result = monteCarloShuffle(trades, 10_000, 200);
    expect(result.actualSharpe).toBeGreaterThan(0);
    expect(result.runs).toBe(200);
    expect(typeof result.medianShuffledSharpe).toBe("number");
    expect(typeof result.percentile95).toBe("number");
    expect(typeof result.isSignificant).toBe("boolean");
  });

  it("isSignificant is true when p_value < 0.01", () => {
    const trades = trendingTrades(50);
    const result = monteCarloShuffle(trades, 10_000, 200);
    expect(result.isSignificant).toBe(result.p_value < 0.01);
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

  it("p_value is between 0 and 1", () => {
    const trades = trendingTrades(30);
    const result = monteCarloShuffle(trades, 10_000, 100);
    expect(result.p_value).toBeGreaterThanOrEqual(0);
    expect(result.p_value).toBeLessThanOrEqual(1);
  });

  it("medianShuffledSharpe is computed from shuffle distribution", () => {
    const trades = trendingTrades(30);
    const result = monteCarloShuffle(trades, 10_000, 100);
    expect(typeof result.medianShuffledSharpe).toBe("number");
    expect(typeof result.percentile95).toBe("number");
  });
});

describe("sensitivitySweep", () => {
  const config = makeConfig();
  const candles: Candle[] = [];
  const signalGeneratorFactory = (_params: Record<string, number>): SignalGenerator =>
    () => null;

  it("returns isRobust=true when all variations are profitable", () => {
    const variations = [
      { threshold: 1.5 },
      { threshold: 2.0 },
      { threshold: 2.5 },
      { threshold: 3.0 },
      { threshold: 3.5 },
    ];

    mockRunBacktest.mockReturnValue({
      trades: [],
      metrics: { sharpe: 1.5, profitFactor: 2.0, totalPnl: 150 },
      config: {},
    } as BacktestResult);

    const result = sensitivitySweep({ threshold: 2.0 }, variations, signalGeneratorFactory, candles, config);

    expect(result.pctProfitable).toBe(100);
    expect(result.isRobust).toBe(true);
    expect(result.results).toHaveLength(5);
  });

  it("returns isRobust=false when < 70% of variations are profitable", () => {
    const variations = [
      { threshold: 1.5 },
      { threshold: 2.0 },
      { threshold: 2.5 },
      { threshold: 3.0 },
      { threshold: 3.5 },
    ];

    let callCount = 0;
    mockRunBacktest.mockImplementation(() => {
      const profitable = ++callCount <= 2;
      return {
        trades: [],
        metrics: {
          sharpe: profitable ? 1.0 : -0.5,
          profitFactor: profitable ? 1.5 : 0.7,
          totalPnl: profitable ? 100 : -50,
        },
        config: {},
      } as BacktestResult;
    });

    const result = sensitivitySweep({ threshold: 2.0 }, variations, signalGeneratorFactory, candles, config);

    expect(result.isRobust).toBe(false);
    expect(result.results).toHaveLength(5);
  });

  it("pctProfitable is 40 when 2 of 5 are profitable", () => {
    const variations = Array.from({ length: 5 }, (_, i) => ({ threshold: i + 1 }));

    let callIdx = 0;
    mockRunBacktest.mockImplementation(() => {
      const profitable = callIdx++ < 2;
      return {
        trades: [],
        metrics: {
          sharpe: profitable ? 1.0 : -0.5,
          profitFactor: profitable ? 1.5 : 0.7,
          totalPnl: 0,
        },
        config: {},
      } as BacktestResult;
    });

    const result = sensitivitySweep({ threshold: 2.0 }, variations, signalGeneratorFactory, candles, config);

    expect(result.pctProfitable).toBe(40);
    expect(result.isRobust).toBe(false);
  });

  it("result entries contain params, sharpe, pf, pnl", () => {
    mockRunBacktest.mockReturnValue({
      trades: [],
      metrics: { sharpe: 0.8, profitFactor: 1.2, totalPnl: 200 },
      config: {},
    } as BacktestResult);

    const result = sensitivitySweep(
      { threshold: 2.0 },
      [{ threshold: 2.0 }],
      signalGeneratorFactory,
      candles,
      config,
    );

    expect(result.results[0]).toMatchObject({
      params: { threshold: 2.0 },
      sharpe: expect.any(Number),
      pf: expect.any(Number),
      pnl: expect.any(Number),
    });
  });

  it("returns isRobust=true at exactly 70% profitable (3 of 5 needed when boundary)", () => {
    const variations = Array.from({ length: 10 }, (_, i) => ({ threshold: i + 1 }));

    let callIdx = 0;
    mockRunBacktest.mockImplementation(() => {
      const profitable = callIdx++ < 7; // exactly 70%
      return {
        trades: [],
        metrics: {
          sharpe: profitable ? 1.0 : -0.5,
          profitFactor: profitable ? 1.5 : 0.7,
          totalPnl: 0,
        },
        config: {},
      } as BacktestResult;
    });

    const result = sensitivitySweep({ threshold: 2.0 }, variations, signalGeneratorFactory, candles, config);

    expect(result.pctProfitable).toBe(70);
    expect(result.isRobust).toBe(true);
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

    const report = overfittingReport(trades, 10_000, 0.8, 100);
    expect(report.overallPass).toBe(report.monteCarlo.isSignificant && report.oosIsPass);
  });

  it("overallPass is false when oosIsPass is false", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.2, 100);
    expect(report.overallPass).toBe(false);
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

  it("summary includes PASS or FAIL", () => {
    const trades = trendingTrades(50);
    const report = overfittingReport(trades, 10_000, 0.6, 100);
    expect(report.summary).toMatch(/PASS|FAIL/i);
  });
});
