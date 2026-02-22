// Shared types for copy trading and telegram consumers
export type EvmChain = "ethereum" | "polygon" | "base" | "arbitrum" | "optimism" | "avalanche";
export type Chain = EvmChain;

export interface Trader {
  address: string;
  chain: Chain;
  score: number;
  winRate: number;
  profitFactor: number;
  consistency: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnlUsd: number;
  avgHoldTimeMs: number;
  largestWinPct: number;
  discoveredAt: number;
  updatedAt: number;
}

export interface TraderTrade {
  id: string;
  walletAddress: string;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol?: string;
  type: "BUY" | "SELL";
  amountUsd: number;
  price: number;
  pnlUsd?: number;
  pnlPct?: number;
  txHash: string;
  timestamp: number;
}

export const KNOWN_EXCHANGES: Record<Chain, string[]> = {
  ethereum: [
    "0x28C6c06298d514Db089934071355E5743bf21d60",
    "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
  ],
  polygon: [
    "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245",
    "0xf89d7b9c864f589bbF53a82105107622B35EaA40",
  ],
  base: [
    "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A",
    "0x9696f59E4d72E237BE84fFd425DCaD154Bf96976",
  ],
  arbitrum: [
    "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D",
    "0x1714400FF23dB4aF24F9fd64e7039e6597f18C2b",
  ],
  optimism: [
    "0x82E0b8cDD80Af5930c4452c684E71c861148Ec8A",
    "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b",
  ],
  avalanche: [
    "0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9",
    "0x4483f0b6e2f5486d06958c20f8c39a7abe87bf8f",
  ],
};

// Known DEX routers and aggregators (for sell vs transfer detection)
export const KNOWN_DEX_ROUTERS: Record<string, string[]> = {
  ethereum: [
    "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", // Uniswap Universal
    "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", // SushiSwap
    "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch V5
    "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // 0x Exchange
  ],
  base: [
    "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", // Uniswap Universal
    "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome
  ],
  arbitrum: [
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3
    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
  ],
  polygon: [
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3
    "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap
  ],
  optimism: [
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3
  ],
  avalanche: [
    "0x60aE616a2155Ee3d9A68541Ba4544862310933d4", // Trader Joe V1
    "0xE3Ffc583dC176575eEA7FD9dF2A7c65F7E23f4C3", // Trader Joe V2.1
    "0x18556DA13313f3532c54CCDb6c4b5A193986d10c", // Pangolin
  ],
};

export type ScanChain = EvmChain;

export interface PumpedToken {
  tokenAddress: string;
  chain: ScanChain;
  symbol: string;
  pairAddress: string;
  priceChangeH24: number; // e.g. 500 for 5x
  volumeH24: number;
  liquidity: number;
  discoveredAt: number;
}

export interface GemHit {
  walletAddress: string;
  chain: ScanChain;
  tokenAddress: string;
  tokenSymbol: string;
  buyTxHash: string;
  buyTimestamp: number;
  pumpMultiple: number;
  maxPumpMultiple?: number;
  buyTokens?: number;
  sellTokens?: number;
  status?: "holding" | "sold" | "partial" | "transferred" | "unknown";
  buyDate?: number;
  sellDate?: number;
  launchPriceUsd?: number;
}

export interface InsiderWallet {
  address: string;
  chain: ScanChain;
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
  MIN_GEM_HITS: 5, // 5+ gems to be considered insider
  MIN_UNIQUE_TOKENS: 3, // 3+ unique tokens across gem hits
  MIN_GEM_SCORE: 70, // min score to paper-buy
  RESCORE_THRESHOLD: 50, // re-analyze gems near buy threshold
  MAX_BUY_PUMP: 20, // skip buying if already pumped this much
  QUALITY_GEM_HITS: 5, // gem hits required for insider quality scoring
  MAX_GEM_AGE_DAYS: 30, // skip tokens older than 30 days
  EARLY_BUYER_BLOCKS: 50, // bought within first 50 blocks of pair creation
  MAX_TOKENS_PER_SCAN: 20,
  SCAN_CHAINS: ["ethereum", "avalanche"] as ScanChain[],
  SCAN_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes between scans (avoids GeckoTerminal 429s)
  INTER_CHAIN_DELAY_MS: 10_000, // 10s delay between chains to spread GeckoTerminal load
  MAX_HISTORY_TOKENS: 10, // max unique tokens to check per wallet history scan
  HISTORY_MIN_FDV_USD: 10000, // min FDV to qualify
  SNIPER_MAX_HOLD_MS: 24 * 60 * 60 * 1000, // max hold time to be considered a sniper flip
};

export const WATCHER_CONFIG = {
  INTERVAL_MS: 2.5 * 60 * 1000,     // 2.5 minutes between watch cycles
  MIN_WALLET_SCORE: 75,              // Only watch wallets with score >= 75
  MAX_WALLETS_PER_CYCLE: 30,         // Rate limit: max wallets per cycle
  MAX_NEW_TOKENS_PER_WALLET: 3,      // Max new tokens to process per wallet per cycle
};

export type CopyExitReason = "insider_sold" | "trailing_stop" | "stop_loss" | "stale_price" | "liquidity_rug" | "max_hold_time" | "stale_insider";

export interface CopyTrade {
  id: string; // format: `${walletAddress}_${tokenAddress}_${chain}`
  walletAddress: string;
  tokenSymbol: string;
  tokenAddress: string;
  chain: string;
  pairAddress: string | null;
  side: "buy" | "sell";
  buyPriceUsd: number;
  currentPriceUsd: number;
  amountUsd: number;
  pnlPct: number;
  status: "open" | "closed" | "skipped";
  liquidityOk: boolean;
  liquidityUsd: number;
  skipReason: string | null;
  buyTimestamp: number;
  closeTimestamp: number | null;
  exitReason: CopyExitReason | null;
  insiderCount: number;
  peakPnlPct: number;
  walletScoreAtBuy: number;
  exitDetail: string | null;
}

export const INSIDER_WS_CONFIG = {
  SYNC_INTERVAL_MS: 30_000,                    // 30s wallet list sync
  DEDUP_TTL_MS: 10 * 60 * 1000,               // 10 min tx hash dedup
  FALLBACK_POLL_INTERVAL_MS: 10 * 60 * 1000,  // 10 min polling when WS active
};

export const COPY_TRADE_CONFIG = {
  MIN_LIQUIDITY_USD: 5000,
  AMOUNT_USD: 10, // base reference amount (see getPositionSize for score-based sizing)
  STOP_LOSS_PCT: -50,
  ESTIMATED_FEE_PCT: 3, // 1% DEX fee/side + slippage on micro-caps (Uniswap 1% tier)
  ESTIMATED_RUG_FEE_PCT: 15, // selling into drained pool = massive slippage
  MAX_EXPOSURE_USD: 200, // max total open exposure, skip new buys if exceeded
  LIQUIDITY_RUG_FLOOR_USD: 5000,
  LIQUIDITY_RUG_DROP_PCT: 70,
  PRICE_REFRESH_INTERVAL_MS: 60 * 1000,
  TIME_PROFIT_TIGHTEN_MS: 4 * 60 * 60 * 1000,   // 4 hours - tighten trailing stop for profitable positions
  TIME_PROFIT_TIGHTEN_STOP_PCT: 0,               // tighten trailing stop to breakeven after 4h if profitable
  STALE_INSIDER_MS: 24 * 60 * 60 * 1000,         // 24 hours - close profitable positions if insider hasn't sold
  MAX_HOLD_TIME_MS: 48 * 60 * 60 * 1000,         // 48 hours - absolute max hold time
};

/** Score-based position sizing: higher score = larger position */
export function getPositionSize(score: number): number {
  if (score >= 95) return 15;
  if (score >= 90) return 13;
  if (score >= 85) return 10;
  return 8;
}
