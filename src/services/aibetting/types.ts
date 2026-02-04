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
}

export interface AIAnalysis {
  marketId: string;
  probability: number; // 0.0 to 1.0
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  keyFactors: string[];
  timestamp: number;
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
}

export interface ScanResult {
  markets: PolymarketEvent[];
  scannedAt: number;
}

export interface AnalysisCycleResult {
  marketsAnalyzed: number;
  opportunitiesFound: number;
  betsPlaced: number;
  errors: string[];
}
