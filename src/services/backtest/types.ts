// Shared types for the backtest engine

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export interface Signal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  barIndex: number;
}

export interface Position {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  entryTime: number;
  size: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  trailActivation?: number;
  trailDistance?: number;
  maxHoldBars?: number;
}

export interface Trade {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  fees: number;
  slippage: number;
  fundingCost: number;
}

export interface FundingEntry {
  time: number;
  rate: number;
}

export interface CostConfig {
  makerFeePct: number;
  takerFeePct: number;
  spreadMap: Record<string, number>;
  defaultSpreadPct: number;
  slippageMultiplierOnSL: number;
}

export interface BacktestConfig {
  pairs: string[];
  startTime: number;
  endTime: number;
  capitalUsd: number;
  leverage: number;
  costConfig: CostConfig;
  candleDir: string;
  fundingDir: string;
  maxHoldBars?: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  avgTradePnl: number;
  totalPnl: number;
  sampleSizeOk: boolean;
}

export interface BacktestResult {
  trades: Trade[];
  metrics: BacktestMetrics;
  config: BacktestConfig;
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  validateStart: number;
  validateEnd: number;
  testStart?: number;
  testEnd?: number;
}

// Anti-look-ahead contract: receives barIndex, must use candles[0..barIndex-1] for signal,
// entry fills at candles[barIndex].o
export type SignalGenerator = (
  candles: Candle[],
  barIndex: number,
  pair: string,
) => Signal | null;

export interface WalkForwardWindowResult {
  windowIndex: number;
  bestParams: Record<string, number>;
  trainSharpe: number;
  validateSharpe: number;
  validateTrades: Trade[];
}

export interface WalkForwardResult {
  windows: WalkForwardWindowResult[];
  aggregateOOSMetrics: BacktestMetrics;
  oosIsRatio: number;
}
