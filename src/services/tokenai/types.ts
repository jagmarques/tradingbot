// Supported chains for token analysis
export type SupportedChain =
  | "solana"
  | "base"
  | "bnb"
  | "arbitrum"
  | "avalanche"
  | "ethereum";

// GoPlusLabs chain ID mapping
export const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: "1",
  bnb: "56",
  base: "8453",
  arbitrum: "42161",
  avalanche: "43114",
};

// Security signal from GoPlusLabs or RugCheck
export interface SecuritySignal {
  isHoneypot: boolean;
  hasScamFlags: boolean;
  isOpenSource: boolean;
  hasProxy: boolean;
  hasMintFunction: boolean;
  ownerCanChangeBalance: boolean;
  buyTax: number; // 0.0 to 1.0
  sellTax: number; // 0.0 to 1.0
  riskScore: number; // 0 (safe) to 100 (dangerous)
  auditStatus: "audited" | "unaudited" | "unknown";
  provider: "goplus" | "rugcheck";
  raw: Record<string, unknown>; // Full API response for debugging
}

// On-chain signal from Birdeye or CoinGecko
export interface OnchainSignal {
  holderCount: number;
  whalePercentage: number; // top 10 holders % of supply, 0-100
  liquidityUsd: number;
  volume24hUsd: number;
  priceChangePercent24h: number;
  marketCapUsd: number;
  provider: "birdeye" | "coingecko";
  raw: Record<string, unknown>;
}

// Social/news signal
export interface SocialSignal {
  tweetCount24h: number;
  sentiment: "bullish" | "bearish" | "neutral" | "unknown";
  newsItemCount: number;
  topHeadlines: string[];
  narrativeTags: string[]; // e.g. ["memecoin", "AI", "defi"]
  provider: "twitter" | "google-news";
  raw: Record<string, unknown>;
}

// Combined result from all collectors
export interface TokenSignals {
  tokenAddress: string;
  chain: SupportedChain;
  security: SecuritySignal | null;
  onchain: OnchainSignal | null;
  social: SocialSignal | null;
  collectedAt: string; // ISO timestamp
}

// Result from AI token analysis
export interface TokenAnalysisResult {
  tokenAddress: string;
  chain: SupportedChain;
  successProbability: number; // 0.0 to 1.0 - chance of 2x+ within 24h
  confidence: "low" | "medium" | "high";
  confidenceScore: number; // 0.0 to 1.0 numeric (low=0.3, medium=0.6, high=0.85)
  reasoning: string; // 2-3 sentence summary
  keyFactors: string[]; // Top 3-5 factors
  riskFactors: string[]; // Top 3-5 risks
  evidenceCited: string[]; // Specific facts from signals
  citationAccuracy?: number; // 0.0 to 1.0 after verification
  securityScore?: number; // From security signal if available
  analyzedAt: string; // ISO timestamp
}
