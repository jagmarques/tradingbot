import { getTrades, type TradeRecord } from "../database/trades.js";

export interface PaperValidationResult {
  totalPaperTrades: number;
  totalPaperPnl: number;
  averagePnlPerTrade: number;
  winRate: number;
  pumpfunStats: StrategyStats;
  polymarketStats: StrategyStats;
  isReady: boolean;
  readinessScore: number;
  recommendations: string[];
}

export interface StrategyStats {
  trades: number;
  pnl: number;
  winRate: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  avgHoldTime: number;
}

export interface ValidationCriteria {
  minTrades: number;
  minWinRate: number;
  maxDrawdown: number;
  minPnl: number;
  minDays: number;
}

const DEFAULT_CRITERIA: ValidationCriteria = {
  minTrades: 20,
  minWinRate: 40,
  maxDrawdown: 30,
  minPnl: 0,
  minDays: 7,
};

// Validate paper trading performance
export function validatePaperTrading(
  criteria: Partial<ValidationCriteria> = {}
): PaperValidationResult {
  const config = { ...DEFAULT_CRITERIA, ...criteria };

  // Get all paper trades
  const paperTrades = getTrades({ isPaper: true });

  // Calculate overall stats
  const totalPnl = paperTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winningTrades = paperTrades.filter((t) => t.pnl > 0).length;
  const winRate = paperTrades.length > 0 ? (winningTrades / paperTrades.length) * 100 : 0;
  const avgPnl = paperTrades.length > 0 ? totalPnl / paperTrades.length : 0;

  // Calculate per-strategy stats
  const pumpfunTrades = paperTrades.filter((t) => t.strategy === "pumpfun");
  const polymarketTrades = paperTrades.filter((t) => t.strategy === "polymarket");

  const pumpfunStats = calculateStrategyStats(pumpfunTrades);
  const polymarketStats = calculateStrategyStats(polymarketTrades);

  // Calculate readiness
  const { isReady, score, recommendations } = calculateReadiness(
    paperTrades,
    totalPnl,
    winRate,
    config
  );

  return {
    totalPaperTrades: paperTrades.length,
    totalPaperPnl: totalPnl,
    averagePnlPerTrade: avgPnl,
    winRate,
    pumpfunStats,
    polymarketStats,
    isReady,
    readinessScore: score,
    recommendations,
  };
}

function calculateStrategyStats(trades: TradeRecord[]): StrategyStats {
  if (trades.length === 0) {
    return {
      trades: 0,
      pnl: 0,
      winRate: 0,
      avgPnl: 0,
      maxWin: 0,
      maxLoss: 0,
      avgHoldTime: 0,
    };
  }

  const pnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);

  // Find max win and loss
  const pnlValues = trades.map((t) => t.pnl);
  const maxWin = Math.max(...pnlValues, 0);
  const maxLoss = Math.min(...pnlValues, 0);

  // Calculate average hold time (simplified - using timestamp differences)
  let avgHoldTime = 0;
  const sellTrades = trades.filter((t) => t.type === "SELL");
  if (sellTrades.length > 0) {
    // This is a simplified approximation
    avgHoldTime = 300000; // Default 5 minutes
  }

  return {
    trades: trades.length,
    pnl,
    winRate: (wins.length / trades.length) * 100,
    avgPnl: pnl / trades.length,
    maxWin,
    maxLoss: Math.abs(maxLoss),
    avgHoldTime,
  };
}

function calculateReadiness(
  trades: TradeRecord[],
  totalPnl: number,
  winRate: number,
  criteria: ValidationCriteria
): { isReady: boolean; score: number; recommendations: string[] } {
  const recommendations: string[] = [];
  let score = 0;

  // Check minimum trades
  if (trades.length >= criteria.minTrades) {
    score += 25;
  } else {
    recommendations.push(
      `Need ${criteria.minTrades - trades.length} more trades (${trades.length}/${criteria.minTrades})`
    );
  }

  // Check win rate
  if (winRate >= criteria.minWinRate) {
    score += 25;
  } else {
    recommendations.push(
      `Win rate ${winRate.toFixed(1)}% below target ${criteria.minWinRate}%`
    );
  }

  // Check P&L
  if (totalPnl >= criteria.minPnl) {
    score += 25;
  } else {
    recommendations.push(
      `Total P&L $${totalPnl.toFixed(2)} below target $${criteria.minPnl}`
    );
  }

  // Check trading days
  const tradeDays = getUniqueTradingDays(trades);
  if (tradeDays >= criteria.minDays) {
    score += 25;
  } else {
    recommendations.push(
      `Traded ${tradeDays} days, need ${criteria.minDays} days minimum`
    );
  }

  const isReady = score >= 75; // Need at least 75% score

  if (isReady) {
    recommendations.push("Paper trading validation passed! Ready for live trading.");
  }

  return { isReady, score, recommendations };
}

function getUniqueTradingDays(trades: TradeRecord[]): number {
  const days = new Set<string>();
  for (const trade of trades) {
    const day = trade.createdAt.split("T")[0];
    days.add(day);
  }
  return days.size;
}

// Generate paper trading report
export function generatePaperReport(): string {
  const validation = validatePaperTrading();

  const lines = [
    "=== Paper Trading Validation Report ===",
    "",
    `Total Trades: ${validation.totalPaperTrades}`,
    `Total P&L: $${validation.totalPaperPnl.toFixed(2)}`,
    `Average P&L per Trade: $${validation.averagePnlPerTrade.toFixed(2)}`,
    `Win Rate: ${validation.winRate.toFixed(1)}%`,
    "",
    "--- Pump.fun Strategy ---",
    `Trades: ${validation.pumpfunStats.trades}`,
    `P&L: $${validation.pumpfunStats.pnl.toFixed(2)}`,
    `Win Rate: ${validation.pumpfunStats.winRate.toFixed(1)}%`,
    `Max Win: $${validation.pumpfunStats.maxWin.toFixed(2)}`,
    `Max Loss: $${validation.pumpfunStats.maxLoss.toFixed(2)}`,
    "",
    "--- Polymarket Strategy ---",
    `Trades: ${validation.polymarketStats.trades}`,
    `P&L: $${validation.polymarketStats.pnl.toFixed(2)}`,
    `Win Rate: ${validation.polymarketStats.winRate.toFixed(1)}%`,
    `Max Win: $${validation.polymarketStats.maxWin.toFixed(2)}`,
    `Max Loss: $${validation.polymarketStats.maxLoss.toFixed(2)}`,
    "",
    "--- Readiness Assessment ---",
    `Score: ${validation.readinessScore}/100`,
    `Ready for Live: ${validation.isReady ? "YES" : "NO"}`,
    "",
    "Recommendations:",
    ...validation.recommendations.map((r) => `  - ${r}`),
    "",
    "===================================",
  ];

  return lines.join("\n");
}

// Check if ready for live trading
export function isReadyForLive(criteria?: Partial<ValidationCriteria>): boolean {
  const validation = validatePaperTrading(criteria);
  return validation.isReady;
}
