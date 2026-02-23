import { loadEnv } from "../../config/env.js";

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

// Non-tradeable token addresses to skip (stablecoins, wrapped natives) by chain
export const SKIP_TOKEN_ADDRESSES: Record<string, Set<string>> = {
  ethereum: new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // stETH
  ]),
  base: new Set([
    "0x4200000000000000000000000000000000000006", // WETH
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  ]),
  arbitrum: new Set([
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
  ]),
  polygon: new Set([
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  ]),
  avalanche: new Set([
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDT
    "0xd586e7f844cea2f87f50152665bcbc2c279d8d70", // DAI.e
  ]),
};

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
  MIN_GEM_HITS: 5,
  MIN_UNIQUE_TOKENS: 3, // 3+ unique tokens across gem hits
  MIN_GEM_SCORE: 60, // min score to paper-buy
  RESCORE_THRESHOLD: 45, // re-analyze gems near buy threshold
  MAX_BUY_PUMP: 20,
  QUALITY_GEM_HITS: 5,
  MAX_GEM_AGE_DAYS: 30,
  EARLY_BUYER_BLOCKS: 50, // bought within first 50 blocks of pair creation
  MAX_TOKENS_PER_SCAN: 20,
  SCAN_CHAINS: ["ethereum", "arbitrum", "polygon", "avalanche"] as EvmChain[],
  SCAN_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes between scans (avoids GeckoTerminal 429s)
  INTER_CHAIN_DELAY_MS: 10_000, // 10s delay between chains to spread GeckoTerminal load
  MAX_HISTORY_TOKENS: 10, // max unique tokens to check per wallet history scan
  HISTORY_MIN_FDV_USD: 10000, // min FDV to qualify
  SNIPER_MAX_HOLD_MS: 24 * 60 * 60 * 1000, // max hold time to be considered a sniper flip
};

export const WATCHER_CONFIG = {
  INTERVAL_MS: 2.5 * 60 * 1000,
  MIN_WALLET_SCORE: 81, // Only watch wallets with score > 80
  MAX_WALLETS_PER_CYCLE: 30, // Rate limit: max wallets per cycle
  MAX_NEW_TOKENS_PER_WALLET: 3,
};

export type CopyExitReason =
  | "insider_sold"
  | "trailing_stop"
  | "stop_loss"
  | "stale_price"
  | "liquidity_rug"
  | "honeypot"
  | "max_hold_time"
  | "stale_insider";

export interface CopyTrade {
  id: string; // format: `${walletAddress}_${tokenAddress}_${chain}_${buyTimestamp}`
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
  tokenCreatedAt: number | null;
  closeTimestamp: number | null;
  exitReason: CopyExitReason | null;
  insiderCount: number;
  peakPnlPct: number;
  walletScoreAtBuy: number;
  exitDetail: string | null;
  txHash?: string | null;
  tokensReceived?: string | null;
  sellTxHash?: string | null;
  isLive?: boolean;
  holdPriceUsd?: number | null;
}

export const INSIDER_WS_CONFIG = {
  SYNC_INTERVAL_MS: 30_000,
  DEDUP_TTL_MS: 10 * 60 * 1000,
  FALLBACK_POLL_INTERVAL_MS: 10 * 60 * 1000, // 10 min polling when WS active
};

export const COPY_TRADE_CONFIG = {
  MIN_LIQUIDITY_USD: 5000,
  STOP_LOSS_PCT: -50,
  ESTIMATED_FEE_PCT: 3, // ~1.5% per side (DEX fee + slippage) on micro-caps
  ESTIMATED_RUG_FEE_PCT: 15, // selling into drained pool = massive slippage
  MAX_EXPOSURE_USD: 200,
  LIQUIDITY_RUG_FLOOR_USD: 5000,
  LIQUIDITY_RUG_DROP_PCT: 30,
  PRICE_REFRESH_INTERVAL_MS: 30 * 1000,
  GOPLUS_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  TIME_PROFIT_TIGHTEN_MS: 4 * 60 * 60 * 1000,
  TIME_PROFIT_TIGHTEN_STOP_PCT: 0, // tighten trailing stop to breakeven after 4h if profitable
  STALE_INSIDER_MS: 24 * 60 * 60 * 1000, // 24 hours - close profitable positions if insider hasn't sold
  MAX_HOLD_TIME_MS: 48 * 60 * 60 * 1000,
};

export function getPositionSize(score: number): number {
  if (score >= 95) return 15;
  if (score >= 90) return 13;
  if (score >= 85) return 10;
  return 8;
}

export const ALCHEMY_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arb",
  polygon: "polygon",
  optimism: "opt",
  // avalanche not supported by Alchemy WebSocket - omitted intentionally
};

export function getAlchemyWssUrl(chain: string): string | null {
  const env = loadEnv();
  const alchemyKey = env.ALCHEMY_API_KEY;
  if (!alchemyKey) return null;
  const alchemyChain = ALCHEMY_CHAIN_MAP[chain];
  if (!alchemyChain) return null;
  return `wss://${alchemyChain}-mainnet.g.alchemy.com/v2/${alchemyKey}`;
}

export function stripEmoji(s: string): string {
  return s
    .replace(
      /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\u200d|\ufe0f|\u{E0067}|\u{E0062}|\u{E007F}|\u{1F3F4}/gu,
      "",
    )
    .trim();
}

export function checkCircuitBreaker(stats: {
  totalTrades: number;
  wins: number;
  grossProfit: number;
  grossLoss: number;
  consecutiveLosses: number;
}): { blocked: boolean; reason: string } {
  if (stats.totalTrades >= 10) {
    const winRate = stats.wins / stats.totalTrades;
    const losses = stats.totalTrades - stats.wins;
    const avgWinPct = stats.wins > 0 ? stats.grossProfit / stats.wins : 0;
    const avgLossPct = losses > 0 ? stats.grossLoss / losses : 0;
    const expectancy = winRate * avgWinPct - (1 - winRate) * avgLossPct;
    if (expectancy <= 0) {
      return { blocked: true, reason: `negative expectancy after ${stats.totalTrades} trades` };
    }
  }
  if (stats.consecutiveLosses >= 3) {
    return { blocked: true, reason: `${stats.consecutiveLosses} consecutive losses` };
  }
  return { blocked: false, reason: "" };
}
