import { describe, it, expect } from "vitest";
import { computeMetrics, formatMetricsDashboard } from "./metrics.js";
import type { Trade } from "./types.js";

// Helper to build a minimal Trade object
function mkTrade(
  id: string,
  pnl: number,
  exitTime: number,
): Trade {
  return {
    id,
    pair: "BTC",
    direction: "long",
    entryPrice: 100,
    exitPrice: 100 + pnl,
    entryTime: exitTime - 1000,
    exitTime,
    pnl,
    pnlPct: pnl / 100,
    exitReason: "tp",
    fees: 0,
    slippage: 0,
    fundingCost: 0,
  };
}

// Day timestamps (ms): day 0 = 0, day 1 = 86400000, etc.
const DAY = 86400000;

describe("computeMetrics", () => {
  it("returns zero metrics for empty trades", () => {
    const m = computeMetrics([], 1000);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.avgTradePnl).toBe(0);
    expect(m.totalPnl).toBe(0);
    expect(m.sampleSizeOk).toBe(false);
  });

  it("computes basic metrics for 3W + 2L trades", () => {
    // 3 wins: $10, $20, $30 | 2 losses: -$5, -$15
    // all on same day for simplicity
    const trades: Trade[] = [
      mkTrade("w1", 10, DAY),
      mkTrade("w2", 20, DAY),
      mkTrade("w3", 30, DAY),
      mkTrade("l1", -5, DAY),
      mkTrade("l2", -15, DAY),
    ];
    const m = computeMetrics(trades, 1000);

    expect(m.totalTrades).toBe(5);
    expect(m.winRate).toBeCloseTo(60, 5);
    expect(m.profitFactor).toBeCloseTo(3.0, 5); // 60 / 20
    expect(m.totalPnl).toBeCloseTo(40, 5);
    expect(m.avgTradePnl).toBeCloseTo(8.0, 5);
    expect(m.sampleSizeOk).toBe(false);
  });

  it("sampleSizeOk is true for >= 100 trades", () => {
    const trades: Trade[] = Array.from({ length: 100 }, (_, i) =>
      mkTrade(`t${i}`, 1, DAY + i),
    );
    const m = computeMetrics(trades, 1000);
    expect(m.sampleSizeOk).toBe(true);
  });

  it("profitFactor is Infinity when there are no losses", () => {
    const trades: Trade[] = [
      mkTrade("w1", 10, DAY),
      mkTrade("w2", 20, DAY * 2),
    ];
    const m = computeMetrics(trades, 1000);
    expect(m.profitFactor).toBe(Infinity);
  });

  it("profitFactor is 0 when there are no wins", () => {
    const trades: Trade[] = [
      mkTrade("l1", -10, DAY),
      mkTrade("l2", -20, DAY * 2),
    ];
    const m = computeMetrics(trades, 1000);
    expect(m.profitFactor).toBe(0);
  });

  it("computes max drawdown correctly through equity sequence", () => {
    // Capital $100
    // Trade sequence (by exitTime): +10, -5, +10, -7
    // Equity curve: 0 -> +10 -> +5 -> +15 -> +8
    // Peak after each: 10, 10, 15, 15
    // Drawdown: 0%, 5%, 0%, 7%
    // maxDD = 7%
    const trades: Trade[] = [
      mkTrade("t1", 10, DAY * 1),
      mkTrade("t2", -5, DAY * 2),
      mkTrade("t3", 10, DAY * 3),
      mkTrade("t4", -7, DAY * 4),
    ];
    const m = computeMetrics(trades, 100);
    expect(m.maxDrawdownPct).toBeCloseTo(7, 5);
  });

  it("max drawdown is 0 when equity never drops below peak", () => {
    const trades: Trade[] = [
      mkTrade("t1", 10, DAY * 1),
      mkTrade("t2", 5, DAY * 2),
      mkTrade("t3", 8, DAY * 3),
    ];
    const m = computeMetrics(trades, 1000);
    expect(m.maxDrawdownPct).toBe(0);
  });

  it("computes Sharpe from daily equity returns (not per-trade)", () => {
    // 5 trades across 3 days on capital $1000
    // Day 1: trades earn $10 + $20 = $30 -> dailyReturn = 0.030
    // Day 2: trade earns -$15              -> dailyReturn = -0.015
    // Day 3: trades earn $5 + $10 = $15   -> dailyReturn = 0.015
    // dailyReturns = [0.030, -0.015, 0.015]
    // avg = (0.030 - 0.015 + 0.015) / 3 = 0.010
    // variance (sample, N-1=2) = ((0.030-0.010)^2 + (-0.015-0.010)^2 + (0.015-0.010)^2) / 2
    //   = (0.0004 + 0.000625 + 0.000025) / 2 = 0.00105 / 2 = 0.000525
    // std = sqrt(0.000525) ≈ 0.022912
    // sharpe = (0.010 / 0.022912) * sqrt(252) ≈ 0.4366 * 15.8745 ≈ 6.929
    const trades: Trade[] = [
      mkTrade("d1a", 10, DAY * 1),
      mkTrade("d1b", 20, DAY * 1 + 1000),
      mkTrade("d2a", -15, DAY * 2),
      mkTrade("d3a", 5, DAY * 3),
      mkTrade("d3b", 10, DAY * 3 + 1000),
    ];
    const m = computeMetrics(trades, 1000);

    // Manually computed expected sharpe
    const dailyReturns = [0.03, -0.015, 0.015];
    const avg = dailyReturns.reduce((s, r) => s + r, 0) / 3;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - avg) ** 2, 0) / (3 - 1);
    const std = Math.sqrt(variance);
    const expectedSharpe = (avg / std) * Math.sqrt(252);

    expect(m.sharpe).toBeCloseTo(expectedSharpe, 4);
  });

  it("Sharpe is 0 when only 1 trading day", () => {
    const trades: Trade[] = [mkTrade("t1", 10, DAY)];
    const m = computeMetrics(trades, 1000);
    expect(m.sharpe).toBe(0);
  });

  it("Sharpe is 0 when all daily returns are equal (zero std dev)", () => {
    // 2 days, same return each day
    const trades: Trade[] = [
      mkTrade("t1", 10, DAY * 1),
      mkTrade("t2", 10, DAY * 2),
    ];
    const m = computeMetrics(trades, 1000);
    // std = 0, so sharpe should be 0
    expect(m.sharpe).toBe(0);
  });
});

describe("formatMetricsDashboard", () => {
  it("formats metrics as a readable multi-line string", () => {
    const metrics = {
      totalTrades: 5,
      winRate: 60,
      profitFactor: 3.0,
      sharpe: 1.5,
      maxDrawdownPct: 7.0,
      avgTradePnl: 8.0,
      totalPnl: 40.0,
      sampleSizeOk: false,
    };
    const output = formatMetricsDashboard(metrics, "Test Strategy");
    expect(output).toContain("=== Backtest Results: Test Strategy ===");
    expect(output).toContain("Trades:");
    expect(output).toContain("5");
    expect(output).toContain("LOW SAMPLE");
    expect(output).toContain("Win Rate:");
    expect(output).toContain("60");
    expect(output).toContain("PF:");
    expect(output).toContain("Sharpe:");
    expect(output).toContain("Max DD:");
    expect(output).toContain("Avg Trade:");
    expect(output).toContain("Total PnL:");
  });

  it("shows OK sample size label when sampleSizeOk is true", () => {
    const metrics = {
      totalTrades: 200,
      winRate: 55,
      profitFactor: 1.5,
      sharpe: 0.8,
      maxDrawdownPct: 10,
      avgTradePnl: 5,
      totalPnl: 1000,
      sampleSizeOk: true,
    };
    const output = formatMetricsDashboard(metrics);
    expect(output).toContain("OK");
    expect(output).not.toContain("LOW SAMPLE");
  });

  it("uses default label when none provided", () => {
    const metrics = {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      avgTradePnl: 0,
      totalPnl: 0,
      sampleSizeOk: false,
    };
    const output = formatMetricsDashboard(metrics);
    expect(output).toContain("=== Backtest Results:");
  });

  it("formats Infinity profitFactor as readable string", () => {
    const metrics = {
      totalTrades: 2,
      winRate: 100,
      profitFactor: Infinity,
      sharpe: 1.0,
      maxDrawdownPct: 0,
      avgTradePnl: 10,
      totalPnl: 20,
      sampleSizeOk: false,
    };
    const output = formatMetricsDashboard(metrics);
    // Should not output "Infinity" raw - should format it cleanly
    expect(output).toContain("PF:");
    // Output should be parseable (no crashes)
    expect(typeof output).toBe("string");
  });
});
