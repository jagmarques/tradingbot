export type EvmChain = "ethereum" | "base" | "arbitrum";

export interface PumpedToken {
  tokenAddress: string;
  chain: EvmChain;
  symbol: string;
  pairAddress: string;
  priceChangeH24: number; // e.g. 500 for 5x
  volumeH24: number;
  liquidity: number;
  discoveredAt: number;
}

export interface GemHit {
  walletAddress: string;
  chain: EvmChain;
  tokenAddress: string;
  tokenSymbol: string;
  buyTxHash: string;
  buyTimestamp: number;
  buyBlockNumber: number;
  pumpMultiple: number;
}

export interface InsiderWallet {
  address: string;
  chain: EvmChain;
  gemHitCount: number;
  gems: string[]; // token symbols
  firstSeenAt: number;
  lastSeenAt: number;
  score: number; // higher = more gems
}

export interface InsiderScanResult {
  pumpedTokensFound: number;
  walletsAnalyzed: number;
  insidersFound: number;
  errors: string[];
}

export const INSIDER_CONFIG = {
  MIN_PUMP_MULTIPLE: 5, // 5x pump
  MIN_GEM_HITS: 3, // 3+ gems to be considered insider
  EARLY_BUYER_BLOCKS: 50, // bought within first 50 blocks of pair creation
  MAX_TOKENS_PER_SCAN: 20,
  SCAN_CHAINS: ["ethereum", "base", "arbitrum"] as EvmChain[],
};
