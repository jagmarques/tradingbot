// Trader wallet tracking types

export type Chain = "solana" | "base" | "bnb" | "arbitrum" | "avalanche";

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
  largestWinPct: number; // Largest single win as % of total profit
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

export interface TraderAlert {
  id: string;
  walletAddress: string;
  trade: TraderTrade;
  walletScore: number;
  walletWinRate: number;
  sentAt: number;
}

// Wallet transfer tracking - detect when traders move to new wallets
export interface WalletTransfer {
  id: string;
  fromAddress: string;
  toAddress: string;
  chain: Chain;
  amountUsd: number;
  txHash: string;
  timestamp: number;
}

// Wallet cluster - group of wallets controlled by same entity
export interface WalletCluster {
  id: string;
  primaryWallet: string; // The original/main trader wallet
  linkedWallets: string[]; // All wallets connected via transfers
  chain: Chain;
  totalTransferred: number; // Total USD moved between wallets
  discoveredAt: number;
  updatedAt: number;
}

// Transfer thresholds for detecting new trader wallets
export const TRANSFER_THRESHOLDS = {
  MIN_TRANSFER_USD: 500, // Minimum transfer to consider significant
  MIN_TRANSFERS_TO_LINK: 2, // At least 2 transfers to same wallet to link
  MAX_TIME_BETWEEN_TRANSFERS: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Scoring weights
export const SCORING_WEIGHTS = {
  WIN_RATE: 30,
  PROFIT_FACTOR: 25,
  CONSISTENCY: 25,
  VOLUME: 20,
};

// Minimum thresholds for trader qualification (consistent traders)
export const TRADER_THRESHOLDS = {
  MIN_TRADES: 20,
  MIN_WIN_RATE: 0.55,
  MIN_PROFIT_FACTOR: 1.5,
  MAX_SINGLE_TRADE_PCT: 0.5, // No single trade > 50% of total profit (only for few wins)
  MIN_SCORE: 60,
};

// "Big hitter" thresholds - few trades but big wins, low losses
// These traders may only trade occasionally but hit big when they do
export const BIG_HITTER_THRESHOLDS = {
  MIN_TRADES: 3, // At least 3 trades (not just luck)
  MAX_TRADES: 19, // Less than normal trader threshold
  MIN_TOTAL_PNL_USD: 5000, // At least $5k total profit
  MAX_LOSS_RATIO: 0.3, // Losses <= 30% of wins (they don't lose much)
  MIN_AVG_WIN_USD: 1000, // Average win at least $1k
  MIN_WIN_RATE: 0.6, // Higher win rate requirement (60%)
};

// Periods for analysis
export const ANALYSIS_PERIODS = {
  PRIMARY: 90 * 24 * 60 * 60 * 1000, // 3 months in ms
  VALIDATION: 365 * 24 * 60 * 60 * 1000, // 1 year in ms
};

// Known exchange addresses to exclude from tracking (they're not traders)
export const KNOWN_EXCHANGES: Record<Chain, string[]> = {
  solana: [
    "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", // Binance
    "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", // FTX (historical)
  ],
  base: [
    "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A", // Coinbase
    "0x9696f59E4d72E237BE84fFd425DCaD154Bf96976", // Coinbase 2
  ],
  bnb: [
    "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance Hot
    "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 8
    "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance 14
  ],
  arbitrum: [
    "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D", // Binance
    "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit
  ],
  avalanche: [
    "0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9", // Binance
  ],
};
