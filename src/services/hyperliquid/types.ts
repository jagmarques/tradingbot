export interface QuantPosition {
  id: string;
  pair: string; // e.g. "BTC"
  direction: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
  stopLoss?: number; // Risk-enforced stop-loss price
  takeProfit?: number; // AI-suggested take-profit price
  unrealizedPnl: number;
  mode: "paper" | "live";
  openedAt: string; // ISO date
  closedAt: string | undefined;
  exitPrice: number | undefined;
  realizedPnl: number | undefined;
  exitReason: string | undefined;
  status: "open" | "closed";
}

export interface QuantTrade {
  id: string;
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number | undefined;
  size: number;
  leverage: number;
  pnl: number;
  fees: number;
  mode: "paper" | "live";
  status: "open" | "closed" | "failed";
  aiConfidence: number | undefined;
  aiReasoning: string | undefined;
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
}

export interface QuantAccountState {
  balance: number;
  equity: number;
  unrealizedPnl: number;
  positions: QuantPosition[];
}

export interface QuantHyperliquidConfig {
  walletAddress: string;
  enableWs: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId: string | undefined;
  error: string | undefined;
}

export type CandleInterval = "15m" | "1h" | "4h";

export interface OhlcvCandle {
  timestamp: number; // open time in ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface MarketDataSnapshot {
  pair: string;
  candles: Record<CandleInterval, OhlcvCandle[]>;
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  dayVolume: number;
  fetchedAt: string;
}

export interface FundingInfo {
  pair: string;
  currentRate: number;
  annualizedRate: number;
  nextFundingTime: number;
}

export type TradeType = "directional" | "funding";

export interface FundingOpportunity {
  pair: string;
  currentRate: number; // per-period rate (8h)
  annualizedRate: number; // annualized APR (rate * 3 * 365)
  direction: "long" | "short"; // short if positive rate (shorts collect), long if negative
  nextFundingTime: number; // unix ms
  markPrice: number; // current mid price from getAllMids, used for stop-loss/take-profit calc
}

export type MarketRegime = "trending" | "ranging" | "volatile";

export interface TechnicalIndicators {
  rsi: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null } | null;
  bollingerBands: { upper: number | null; middle: number | null; lower: number | null; width: number | null } | null;
  atr: number | null;
  vwap: number | null;
  adx: number | null;
}

export interface PairAnalysis {
  pair: string;
  indicators: Record<CandleInterval, TechnicalIndicators>;
  candles?: Record<CandleInterval, OhlcvCandle[]>;
  regime: MarketRegime;
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  dayVolume: number;
  analyzedAt: string;
}

export interface QuantAIDecision {
  pair: string;
  direction: "long" | "short" | "flat";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number; // 0-100
  reasoning: string;
  regime: MarketRegime;
  suggestedSizeUsd: number; // Kelly-derived, filled by sizer in Plan 02
  analyzedAt: string; // ISO timestamp
}

export interface QuantAIPromptData extends PairAnalysis {
  candles: Record<CandleInterval, OhlcvCandle[]>;
}
