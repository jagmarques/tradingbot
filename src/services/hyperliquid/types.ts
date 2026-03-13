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
  exchange?: "hyperliquid" | "lighter";
  openedAt: string; // ISO date
  closedAt: string | undefined;
  exitPrice: number | undefined;
  realizedPnl: number | undefined;
  exitReason: string | undefined;
  status: "open" | "closed";
  tradeType?: TradeType;
  spotHedgePrice?: number; // Virtual spot long entry price for delta-neutral positions
  maxUnrealizedPnlPct?: number; // High-water mark for trailing stop
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
  exchange?: "hyperliquid" | "lighter";
  status: "open" | "closed" | "failed";
  exitReason?: string;
  indicatorsAtEntry?: string; // JSON-stringified TechnicalIndicators snapshot at entry time
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
  tradeType?: TradeType;
}

export interface QuantAccountState {
  balance: number;
  equity: number;
  unrealizedPnl: number;
  positions: QuantPosition[];
}

export type CandleInterval = "15m" | "1h" | "4h" | "1d";

export interface OhlcvCandle {
  timestamp: number; // open time in ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface FundingInfo {
  pair: string;
  currentRate: number;
  annualizedRate: number;
  nextFundingTime: number;
}

export type TradeType = "directional" | "funding" | "ai-directional" | "psar-directional" | "zlema-directional" | "vortex-directional" | "schaff-directional" | "dema-directional" | "cci-directional" | "aroon-directional" | "macd-directional" | "zlemav2-directional" | "schaffv2-directional" | "inv-psar-directional" | "inv-zlema-directional" | "inv-vortex-directional" | "inv-schaff-directional" | "inv-dema-directional" | "inv-cci-directional" | "inv-aroon-directional" | "inv-macd-directional" | "inv-zlemav2-directional" | "inv-schaffv2-directional" | "hft-fade" | "hft-t8-tp40-sl3" | "hft-t10-tp35-sl4" | "hft-t8-tp35-sl4" | "hft-t8-tp25-sl5" | "hft-t8-tp30-sl5" | "hft-t12-tp40-sl3" | "hft-t10-tp40-sl3" | "hft-t8-tp30-sl3" | "hft-t8-tp35-sl3" | "hft-t8-tp25-sl3" | "hft-regime" | "hft-smart" | "hft-ai";

export type MarketRegime = "trending" | "ranging" | "volatile";

export interface TechnicalIndicators {
  rsi: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null } | null;
  bollingerBands: { upper: number | null; middle: number | null; lower: number | null; width: number | null } | null;
  atr: number | null;
  vwap: number | null;
  adx: number | null;
}

export interface OrderbookImbalance {
  bidDepthUsd: number; // Total bid size in USD within 2% of mid
  askDepthUsd: number; // Total ask size in USD within 2% of mid
  imbalanceRatio: number; // bidDepth / (bidDepth + askDepth), 0.5 = balanced, >0.5 = bid heavy
  spreadBps: number; // Spread in basis points
}

export interface MicrostructureData {
  orderbookImbalance: OrderbookImbalance | null;
  oiDelta: number | null;
  oiDeltaPct: number | null;
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
  microstructure?: MicrostructureData;
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

