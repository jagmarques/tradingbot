export type MarketCategory =
  | "politics"
  | "crypto"
  | "sports"
  | "entertainment"
  | "science"
  | "business"
  | "other";

export interface MarketOutcome {
  tokenId: string;
  name: string; // "Yes", "No", or custom outcome
  price: number; // 0.0 to 1.0 (market probability)
}

export interface PolymarketEvent {
  conditionId: string;
  questionId: string;
  slug: string;
  title: string;
  description: string;
  category: MarketCategory;
  endDate: string;
  volume24h: number;
  liquidity: number;
  outcomes: MarketOutcome[];
}

export interface NewsItem {
  source: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  content?: string; // Full article text (truncated to ~2000 chars)
}

export interface AIAnalysis {
  marketId: string;
  probability: number; // 0.0 to 1.0
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  keyFactors: string[];
  timestamp: number;
  uncertainty?: number; // 0.0 to 1.0, represents range of uncertainty around probability
  evidenceCited?: string[]; // Specific facts from articles that support the probability
  consistencyNote?: string; // Why estimate differs from prior, or "consistent" if unchanged
  citationAccuracy?: number; // 0.0-1.0, fraction of cited evidence verified in article text
  timeline?: string | null; // What needs to happen by when (for date-based markets), or null
  r1RawProbability?: number; // Raw R1 output before Bayesian market price weighting
}


export interface BetDecision {
  shouldBet: boolean;
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  marketPrice: number;
  aiProbability: number;
  confidence: number;
  edge: number;
  expectedValue: number;
  recommendedSize: number;
  reason: string;
}

export type PositionStatus = "open" | "closed";

export interface AIBettingPosition {
  id: string;
  marketId: string;
  marketTitle: string;
  marketEndDate: string;
  tokenId: string;
  side: "YES" | "NO";
  entryPrice: number;
  size: number;
  aiProbability: number;
  confidence: number;
  expectedValue: number;
  status: PositionStatus;
  entryTimestamp: number;
  exitTimestamp?: number;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
}

export interface AIBettingConfig {
  maxBetSize: number;
  maxTotalExposure: number;
  maxPositions: number;
  minEdge: number;
  minConfidence: number;
  scanIntervalMs: number;
  categoriesEnabled: MarketCategory[];
  bayesianWeight: number;      // 0-1, weight given to market price vs R1
  takeProfitThreshold: number;  // 0-1, exit when P&L exceeds this (e.g. 0.40 = +40%)
  stopLossThreshold: number;    // 0-1, exit when P&L below negative of this (e.g. 0.15 = -15%)
  holdResolutionDays: number;   // Days before resolution to hold instead of taking profit
}

export interface AnalysisCycleResult {
  marketsAnalyzed: number;
  opportunitiesFound: number;
  betsPlaced: number;
  errors: string[];
}
