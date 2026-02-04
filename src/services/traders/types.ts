export type Chain = "solana" | "ethereum" | "polygon" | "base" | "arbitrum" | "bsc" | "optimism" | "avalanche" | "sonic";

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

export interface TraderAlert {
  id: string;
  walletAddress: string;
  trade: TraderTrade;
  walletScore: number;
  walletWinRate: number;
  sentAt: number;
}

export interface WalletTransfer {
  id: string;
  fromAddress: string;
  toAddress: string;
  chain: Chain;
  amountUsd: number;
  txHash: string;
  timestamp: number;
}

export interface WalletCluster {
  id: string;
  primaryWallet: string;
  linkedWallets: string[];
  chain: Chain;
  totalTransferred: number;
  discoveredAt: number;
  updatedAt: number;
}

export const TRANSFER_THRESHOLDS = {
  MIN_TRANSFER_USD: 500,
  MIN_TRANSFERS_TO_LINK: 2,
  MAX_TIME_BETWEEN_TRANSFERS: 7 * 24 * 60 * 60 * 1000,
};

export const SCORING_WEIGHTS = {
  WIN_RATE: 30,
  PROFIT_FACTOR: 25,
  CONSISTENCY: 25,
  VOLUME: 20,
};

export const TRADER_THRESHOLDS = {
  MIN_TRADES: 20,
  MIN_WIN_RATE: 0.80,
  MIN_PROFIT_FACTOR: 1.5,
  MAX_SINGLE_TRADE_PCT: 0.5,
  MIN_SCORE: 60,
};

export const BIG_HITTER_THRESHOLDS = {
  MIN_TRADES: 3,
  MAX_TRADES: 19,
  MIN_TOTAL_PNL_USD: 5000,
  MAX_LOSS_RATIO: 0.3,
  MIN_AVG_WIN_USD: 1000,
  MIN_WIN_RATE: 0.80,
};

export const KNOWN_EXCHANGES: Record<Chain, string[]> = {
  solana: [
    "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
    "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
  ],
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
  bsc: [
    "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3",
    "0x3c783c21a0383057D128bae431894a5C19F9Cf06",
  ],
  optimism: [
    "0x82E0b8cDD80Af5930c4452c684E71c861148Ec8A",
    "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b",
  ],
  avalanche: [
    "0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9",
    "0x4483f0b6e2f5486d06958c20f8c39a7abe87bf8f",
  ],
  sonic: [
    "0xF491e7B69E4244ad4002BC14e878a34207E38c29",
    "0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52",
  ],
};
