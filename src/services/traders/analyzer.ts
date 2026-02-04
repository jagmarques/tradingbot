import {
  Trader,
  TraderTrade,
  SCORING_WEIGHTS,
  TRADER_THRESHOLDS,
  BIG_HITTER_THRESHOLDS,
  Chain,
} from "./types.js";

export interface TradeStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  grossProfit: number;
  grossLoss: number;
  totalPnl: number;
  returns: number[]; // Individual trade returns for consistency calc
  largestWinAmount: number;
  avgHoldTimeMs: number;
}

// Calculate trading stats from a list of trades
export function calculateTradeStats(trades: TraderTrade[]): TradeStats {
  const completedTrades = trades.filter((t) => t.pnlUsd !== undefined);

  let grossProfit = 0;
  let grossLoss = 0;
  let largestWinAmount = 0;
  const returns: number[] = [];
  let totalHoldTime = 0;
  let holdTimeCount = 0;

  // Group buys and sells by token to calculate hold times
  const tokenBuys: Map<string, TraderTrade[]> = new Map();
  const tokenSells: Map<string, TraderTrade[]> = new Map();

  for (const trade of trades) {
    if (trade.type === "BUY") {
      const buys = tokenBuys.get(trade.tokenAddress) || [];
      buys.push(trade);
      tokenBuys.set(trade.tokenAddress, buys);
    } else {
      const sells = tokenSells.get(trade.tokenAddress) || [];
      sells.push(trade);
      tokenSells.set(trade.tokenAddress, sells);
    }
  }

  // Calculate hold times
  for (const [token, buys] of tokenBuys) {
    const sells = tokenSells.get(token) || [];
    for (const buy of buys) {
      const matchingSell = sells.find((s) => s.timestamp > buy.timestamp);
      if (matchingSell) {
        totalHoldTime += matchingSell.timestamp - buy.timestamp;
        holdTimeCount++;
      }
    }
  }

  for (const trade of completedTrades) {
    const pnl = trade.pnlUsd || 0;

    if (pnl > 0) {
      grossProfit += pnl;
      if (pnl > largestWinAmount) {
        largestWinAmount = pnl;
      }
    } else {
      grossLoss += Math.abs(pnl);
    }

    // Calculate return percentage
    if (trade.amountUsd > 0 && trade.pnlPct !== undefined) {
      returns.push(trade.pnlPct);
    }
  }

  const winningTrades = completedTrades.filter((t) => (t.pnlUsd || 0) > 0).length;
  const losingTrades = completedTrades.filter((t) => (t.pnlUsd || 0) < 0).length;

  return {
    totalTrades: completedTrades.length,
    winningTrades,
    losingTrades,
    grossProfit,
    grossLoss,
    totalPnl: grossProfit - grossLoss,
    returns,
    largestWinAmount,
    avgHoldTimeMs: holdTimeCount > 0 ? totalHoldTime / holdTimeCount : 0,
  };
}

// Calculate win rate (0-100)
export function calculateWinRate(stats: TradeStats): number {
  if (stats.totalTrades === 0) return 0;
  return (stats.winningTrades / stats.totalTrades) * 100;
}

// Calculate profit factor (gross profit / gross loss)
export function calculateProfitFactor(stats: TradeStats): number {
  if (stats.grossLoss === 0) return stats.grossProfit > 0 ? 10 : 0; // Cap at 10
  return Math.min(10, stats.grossProfit / stats.grossLoss);
}

// Calculate consistency score (100 - volatility penalty)
export function calculateConsistency(stats: TradeStats): number {
  if (stats.returns.length < 2) return 50; // Default for insufficient data

  const mean = stats.returns.reduce((a, b) => a + b, 0) / stats.returns.length;
  const squaredDiffs = stats.returns.map((r) => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / stats.returns.length;
  const stdDev = Math.sqrt(variance);

  // Penalize high volatility
  const volatilityPenalty = Math.min(50, stdDev * 10);
  return Math.max(0, 100 - volatilityPenalty);
}

// Calculate volume score (more trades = higher score, capped at 100)
export function calculateVolumeScore(stats: TradeStats): number {
  return Math.min(100, stats.totalTrades * 5); // 20 trades = 100 score
}

// Calculate largest win as percentage of total profit
export function calculateLargestWinPct(stats: TradeStats): number {
  if (stats.grossProfit === 0) return 0;
  return stats.largestWinAmount / stats.grossProfit;
}

// Calculate composite trader score (0-100)
export function calculateTraderScore(stats: TradeStats): number {
  const winRateScore = calculateWinRate(stats);
  const profitFactorScore = calculateProfitFactor(stats) * 10; // Scale 0-10 to 0-100
  const consistencyScore = calculateConsistency(stats);
  const volumeScore = calculateVolumeScore(stats);

  const score =
    (winRateScore * SCORING_WEIGHTS.WIN_RATE +
      profitFactorScore * SCORING_WEIGHTS.PROFIT_FACTOR +
      consistencyScore * SCORING_WEIGHTS.CONSISTENCY +
      volumeScore * SCORING_WEIGHTS.VOLUME) /
    100;

  return Math.round(score * 10) / 10; // Round to 1 decimal
}

// Check if wallet qualifies as regular trader (consistent trader, 20+ trades)
export function qualifiesAsTrader(stats: TradeStats): { qualifies: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (stats.totalTrades < TRADER_THRESHOLDS.MIN_TRADES) {
    reasons.push(`Too few trades: ${stats.totalTrades} < ${TRADER_THRESHOLDS.MIN_TRADES}`);
  }

  const winRate = calculateWinRate(stats) / 100;
  if (winRate < TRADER_THRESHOLDS.MIN_WIN_RATE) {
    reasons.push(
      `Win rate too low: ${(winRate * 100).toFixed(1)}% < ${TRADER_THRESHOLDS.MIN_WIN_RATE * 100}%`
    );
  }

  const profitFactor = calculateProfitFactor(stats);
  if (profitFactor < TRADER_THRESHOLDS.MIN_PROFIT_FACTOR) {
    reasons.push(
      `Profit factor too low: ${profitFactor.toFixed(2)} < ${TRADER_THRESHOLDS.MIN_PROFIT_FACTOR}`
    );
  }

  // Only apply single-trade filter to traders with FEW winning trades
  // A trader with 50 wins but one big 10x is still good - not lucky
  // Only filter traders with <5 wins where one trade dominates (truly lucky)
  const largestWinPct = calculateLargestWinPct(stats);
  const MIN_WINS_FOR_BIG_TRADE = 5;
  if (
    stats.winningTrades < MIN_WINS_FOR_BIG_TRADE &&
    largestWinPct > TRADER_THRESHOLDS.MAX_SINGLE_TRADE_PCT
  ) {
    reasons.push(
      `Too reliant on single trade with few wins: ${(largestWinPct * 100).toFixed(1)}% of profit from 1 trade (only ${stats.winningTrades} wins)`
    );
  }

  const score = calculateTraderScore(stats);
  if (score < TRADER_THRESHOLDS.MIN_SCORE) {
    reasons.push(`Score too low: ${score} < ${TRADER_THRESHOLDS.MIN_SCORE}`);
  }

  return {
    qualifies: reasons.length === 0,
    reasons,
  };
}

// Check if wallet qualifies as "big hitter" (few trades but big wins, low losses)
export function qualifiesAsBigHitter(stats: TradeStats): { qualifies: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Must have between MIN and MAX trades
  if (stats.totalTrades < BIG_HITTER_THRESHOLDS.MIN_TRADES) {
    reasons.push(`Too few trades: ${stats.totalTrades} < ${BIG_HITTER_THRESHOLDS.MIN_TRADES}`);
  }
  if (stats.totalTrades > BIG_HITTER_THRESHOLDS.MAX_TRADES) {
    // Too many trades - should qualify as regular trader instead
    reasons.push(
      `Too many trades for big hitter: ${stats.totalTrades} > ${BIG_HITTER_THRESHOLDS.MAX_TRADES}`
    );
  }

  // Must have significant total profit
  if (stats.totalPnl < BIG_HITTER_THRESHOLDS.MIN_TOTAL_PNL_USD) {
    reasons.push(
      `Total PnL too low: $${stats.totalPnl.toFixed(0)} < $${BIG_HITTER_THRESHOLDS.MIN_TOTAL_PNL_USD}`
    );
  }

  // Losses must be low relative to wins (they don't lose much when they trade)
  const lossRatio = stats.grossProfit > 0 ? stats.grossLoss / stats.grossProfit : 1;
  if (lossRatio > BIG_HITTER_THRESHOLDS.MAX_LOSS_RATIO) {
    reasons.push(
      `Loss ratio too high: ${(lossRatio * 100).toFixed(0)}% > ${BIG_HITTER_THRESHOLDS.MAX_LOSS_RATIO * 100}%`
    );
  }

  // Average win must be significant
  const avgWin = stats.winningTrades > 0 ? stats.grossProfit / stats.winningTrades : 0;
  if (avgWin < BIG_HITTER_THRESHOLDS.MIN_AVG_WIN_USD) {
    reasons.push(
      `Average win too low: $${avgWin.toFixed(0)} < $${BIG_HITTER_THRESHOLDS.MIN_AVG_WIN_USD}`
    );
  }

  // Must have high win rate
  const winRate = calculateWinRate(stats) / 100;
  if (winRate < BIG_HITTER_THRESHOLDS.MIN_WIN_RATE) {
    reasons.push(
      `Win rate too low: ${(winRate * 100).toFixed(1)}% < ${BIG_HITTER_THRESHOLDS.MIN_WIN_RATE * 100}%`
    );
  }

  return {
    qualifies: reasons.length === 0,
    reasons,
  };
}

// Calculate big hitter score (different weighting for infrequent but profitable traders)
export function calculateBigHitterScore(stats: TradeStats): number {
  const winRate = calculateWinRate(stats);
  const avgWin = stats.winningTrades > 0 ? stats.grossProfit / stats.winningTrades : 0;
  const lossRatio = stats.grossProfit > 0 ? stats.grossLoss / stats.grossProfit : 1;

  // Score components (0-100 each):
  // - Win rate: direct percentage
  // - Avg win size: scaled by MIN_AVG_WIN_USD threshold
  // - Low loss ratio: inverted (lower is better)
  // - Total PnL: scaled by MIN_TOTAL_PNL_USD threshold

  const winRateScore = winRate;
  const avgWinScore = Math.min(100, (avgWin / BIG_HITTER_THRESHOLDS.MIN_AVG_WIN_USD) * 50);
  const lossRatioScore = Math.max(0, 100 - lossRatio * 100);
  const totalPnlScore = Math.min(
    100,
    (stats.totalPnl / BIG_HITTER_THRESHOLDS.MIN_TOTAL_PNL_USD) * 50
  );

  // Weight: win rate 25%, avg win 30%, loss ratio 25%, total pnl 20%
  const score =
    (winRateScore * 25 + avgWinScore * 30 + lossRatioScore * 25 + totalPnlScore * 20) / 100;

  return Math.round(score * 10) / 10;
}

// Build trader wallet object from trades (checks both trader and big hitter criteria)
export function buildTrader(
  address: string,
  chain: Chain,
  trades: TraderTrade[]
): Trader | null {
  const stats = calculateTradeStats(trades);

  // Try regular trader qualification first
  const traderQual = qualifiesAsTrader(stats);
  if (traderQual.qualifies) {
    console.log(
      `[Traders] ${address.slice(0, 8)}... qualifies as TRADER (${stats.totalTrades} trades)`
    );
    return {
      address,
      chain,
      score: calculateTraderScore(stats),
      winRate: calculateWinRate(stats),
      profitFactor: calculateProfitFactor(stats),
      consistency: calculateConsistency(stats),
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      losingTrades: stats.losingTrades,
      totalPnlUsd: stats.totalPnl,
      avgHoldTimeMs: stats.avgHoldTimeMs,
      largestWinPct: calculateLargestWinPct(stats),
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Try big hitter qualification (few trades but big wins)
  const bigHitterQual = qualifiesAsBigHitter(stats);
  if (bigHitterQual.qualifies) {
    console.log(
      `[Traders] ${address.slice(0, 8)}... qualifies as BIG HITTER (${stats.totalTrades} trades, $${stats.totalPnl.toFixed(0)} profit)`
    );
    return {
      address,
      chain,
      score: calculateBigHitterScore(stats),
      winRate: calculateWinRate(stats),
      profitFactor: calculateProfitFactor(stats),
      consistency: calculateConsistency(stats),
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      losingTrades: stats.losingTrades,
      totalPnlUsd: stats.totalPnl,
      avgHoldTimeMs: stats.avgHoldTimeMs,
      largestWinPct: calculateLargestWinPct(stats),
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Doesn't qualify as either
  console.log(`[Traders] ${address.slice(0, 8)}... disqualified:`);
  console.log(`  Trader: ${traderQual.reasons.join(", ")}`);
  console.log(`  Big Hitter: ${bigHitterQual.reasons.join(", ")}`);
  return null;
}
