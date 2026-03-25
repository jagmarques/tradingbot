import type { Trade, BacktestMetrics } from "./types.js";

// Compute all standard backtest performance metrics from a list of closed trades
export function computeMetrics(trades: Trade[], capitalUsd: number): BacktestMetrics {
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      avgTradePnl: 0,
      totalPnl: 0,
      sampleSizeOk: false,
    };
  }

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const avgTradePnl = totalPnl / totalTrades;
  const sampleSizeOk = totalTrades >= 100;

  // Win rate
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = (wins / totalTrades) * 100;

  // Profit factor: gross profit / gross loss
  const grossProfit = trades.reduce((sum, t) => (t.pnl > 0 ? sum + t.pnl : sum), 0);
  const grossLoss = trades.reduce((sum, t) => (t.pnl < 0 ? sum + Math.abs(t.pnl) : sum), 0);
  let profitFactor: number;
  if (grossLoss === 0) {
    profitFactor = grossProfit > 0 ? Infinity : 0;
  } else {
    profitFactor = grossProfit / grossLoss;
  }

  // Sharpe: daily equity returns, annualized with sqrt(252)
  const sharpe = computeDailySharpe(trades, capitalUsd);

  // Max drawdown: track equity curve from chronologically sorted trades
  const maxDrawdownPct = computeMaxDrawdown(trades, capitalUsd);

  return {
    totalTrades,
    winRate,
    profitFactor,
    sharpe,
    maxDrawdownPct,
    avgTradePnl,
    totalPnl,
    sampleSizeOk,
  };
}

function computeDailySharpe(trades: Trade[], capitalUsd: number): number {
  // Bucket trades by day: Math.floor(exitTime / 86400000)
  const dayMap = new Map<number, number>();
  for (const trade of trades) {
    const day = Math.floor(trade.exitTime / 86400000);
    dayMap.set(day, (dayMap.get(day) ?? 0) + trade.pnl);
  }

  const dailyReturns = Array.from(dayMap.values()).map((pnl) => pnl / capitalUsd);

  if (dailyReturns.length <= 1) return 0;

  const avg = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((s, r) => s + (r - avg) ** 2, 0) / (dailyReturns.length - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  return (avg / std) * Math.sqrt(252);
}

function computeMaxDrawdown(trades: Trade[], capitalUsd: number): number {
  // Sort by exitTime ascending
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  for (const trade of sorted) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / capitalUsd) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD;
}

// Format metrics as a printable dashboard string for CLI output
export function formatMetricsDashboard(metrics: BacktestMetrics, label?: string): string {
  const title = label ?? "Backtest";
  const sampleLabel = metrics.sampleSizeOk ? "OK" : "LOW SAMPLE";
  const pf =
    metrics.profitFactor === Infinity ? "inf" : metrics.profitFactor.toFixed(2);

  return [
    `=== Backtest Results: ${title} ===`,
    `Trades:    ${metrics.totalTrades} (${sampleLabel})`,
    `Win Rate:  ${metrics.winRate.toFixed(2)}%`,
    `PF:        ${pf}`,
    `Sharpe:    ${metrics.sharpe.toFixed(3)}`,
    `Max DD:    ${metrics.maxDrawdownPct.toFixed(2)}%`,
    `Avg Trade: $${metrics.avgTradePnl.toFixed(2)}`,
    `Total PnL: $${metrics.totalPnl.toFixed(2)}`,
  ].join("\n");
}
