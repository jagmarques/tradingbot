import { getTraderTrades, getClusterWallets } from "./storage.js";
import type { TraderTrade, Chain } from "./types.js";

export const WASH_TRADING_THRESHOLDS = {
  OFFSETTING_WINDOW_MS: 5 * 60 * 1000, // 5 minutes between buy and sell = suspicious
  MIN_OFFSETTING_PAIRS: 3, // Need 3+ pairs to flag
  PRICE_TOLERANCE: 0.02, // 2% price difference = "same price" (wash)
  AMOUNT_TOLERANCE: 0.2, // 20% amount difference = "similar size"
  CLUSTER_SYNC_WINDOW_MS: 60 * 1000, // 1 minute between cluster wallet trades = coordinated
  MIN_CLUSTER_SYNCS: 2, // 2+ synchronized trades to flag
  WASH_SCORE_THRESHOLD: 0.5, // Above 0.5 = likely wash trading
  LOOKBACK_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  MIN_TRADES: 10, // Minimum trades needed for analysis
};

export interface WashTradingResult {
  isWashTrader: boolean; // True if washScore >= threshold
  washScore: number; // 0.0 (clean) to 1.0 (definite wash)
  offsettingPairsCount: number; // Number of buy/sell pair matches
  clusterSyncCount: number; // Number of coordinated cluster trades
  totalTradesAnalyzed: number;
  suspiciousPatterns: string[]; // Human-readable pattern descriptions
  scorePenalty: number; // How much to reduce trader score (0-50 points)
}

interface OffsettingPair {
  buy: TraderTrade;
  sell: TraderTrade;
  timeDiffMs: number;
  priceDiffPct: number;
}

interface ClusterSync {
  trade1: TraderTrade;
  trade2: TraderTrade;
  timeDiffMs: number;
}

function cleanResult(totalTrades: number): WashTradingResult {
  return {
    isWashTrader: false,
    washScore: 0,
    offsettingPairsCount: 0,
    clusterSyncCount: 0,
    totalTradesAnalyzed: totalTrades,
    suspiciousPatterns: [],
    scorePenalty: 0,
  };
}

function detectOffsettingPairs(trades: TraderTrade[]): OffsettingPair[] {
  const pairs: OffsettingPair[] = [];

  // Group trades by token
  const byToken = new Map<string, TraderTrade[]>();
  for (const trade of trades) {
    const key = trade.tokenAddress.toLowerCase();
    const existing = byToken.get(key) || [];
    existing.push(trade);
    byToken.set(key, existing);
  }

  for (const tokenTrades of Array.from(byToken.values())) {
    const buys = tokenTrades.filter((t) => t.type === "BUY");
    const sells = tokenTrades.filter((t) => t.type === "SELL");

    // Track which sells have already been paired
    const usedSells = new Set<string>();

    for (const buy of buys) {
      for (const sell of sells) {
        if (usedSells.has(sell.id)) continue;

        const timeDiffMs = Math.abs(sell.timestamp - buy.timestamp);
        if (timeDiffMs > WASH_TRADING_THRESHOLDS.OFFSETTING_WINDOW_MS) continue;

        // Check price similarity
        const priceDiffPct =
          buy.price > 0
            ? Math.abs(sell.price - buy.price) / buy.price
            : 1;
        if (priceDiffPct > WASH_TRADING_THRESHOLDS.PRICE_TOLERANCE) continue;

        // Check amount similarity
        const amountDiffPct =
          buy.amountUsd > 0
            ? Math.abs(sell.amountUsd - buy.amountUsd) / buy.amountUsd
            : 1;
        if (amountDiffPct > WASH_TRADING_THRESHOLDS.AMOUNT_TOLERANCE) continue;

        pairs.push({ buy, sell, timeDiffMs, priceDiffPct });
        usedSells.add(sell.id);
        break; // Move to next buy
      }
    }
  }

  return pairs;
}

function detectClusterSyncs(
  primaryTrades: TraderTrade[],
  linkedWallets: string[],
  chain: Chain
): ClusterSync[] {
  const syncs: ClusterSync[] = [];

  // Get trades for all linked wallets (excluding primary, already loaded)
  const linkedTrades: TraderTrade[] = [];
  const sinceTimestamp = Date.now() - WASH_TRADING_THRESHOLDS.LOOKBACK_MS;

  for (const wallet of linkedWallets) {
    const trades = getTraderTrades(wallet, chain, sinceTimestamp);
    linkedTrades.push(...trades);
  }

  if (linkedTrades.length === 0) return syncs;

  // Find synchronized trades: different wallets, same token, within sync window
  for (const t1 of primaryTrades) {
    for (const t2 of linkedTrades) {
      if (t1.walletAddress === t2.walletAddress) continue;
      if (t1.tokenAddress.toLowerCase() !== t2.tokenAddress.toLowerCase())
        continue;

      const timeDiffMs = Math.abs(t1.timestamp - t2.timestamp);
      if (timeDiffMs > WASH_TRADING_THRESHOLDS.CLUSTER_SYNC_WINDOW_MS)
        continue;

      // Particularly suspicious: opposite directions (one buys, other sells)
      syncs.push({ trade1: t1, trade2: t2, timeDiffMs });
    }
  }

  return syncs;
}

function calculateScorePenalty(washScore: number): number {
  if (washScore >= 0.7) return 50;
  if (washScore >= 0.5) return 25;
  if (washScore >= 0.3) return 10;
  return 0;
}

export function analyzeWashTrading(
  walletAddress: string,
  chain: Chain
): WashTradingResult {
  const sinceTimestamp = Date.now() - WASH_TRADING_THRESHOLDS.LOOKBACK_MS;
  const trades = getTraderTrades(walletAddress, chain, sinceTimestamp);

  // Not enough data to analyze
  if (trades.length < WASH_TRADING_THRESHOLDS.MIN_TRADES) {
    return cleanResult(trades.length);
  }

  // Step 2: Detect offsetting pairs (same wallet)
  const offsettingPairs = detectOffsettingPairs(trades);

  // Step 3: Detect cluster coordination
  const clusterWallets = getClusterWallets(walletAddress, chain);
  const linkedWallets = clusterWallets.filter(
    (w) => w.toLowerCase() !== walletAddress.toLowerCase()
  );

  const clusterSyncs = detectClusterSyncs(trades, linkedWallets, chain);

  // Step 4: Calculate wash score
  // Count total possible trade pairs per token for ratio
  const totalTradePairs = countTradePairs(trades);
  const offsettingRatio =
    totalTradePairs > 0
      ? Math.min(offsettingPairs.length / totalTradePairs, 1.0)
      : 0;

  // Cluster ratio based on total cluster trades possible
  const totalClusterTrades = linkedWallets.length > 0 ? trades.length : 0;
  const clusterRatio =
    totalClusterTrades > 0
      ? Math.min(clusterSyncs.length / totalClusterTrades, 1.0)
      : 0;

  const washScore = offsettingRatio * 0.6 + clusterRatio * 0.4;

  // Step 5: Calculate score penalty
  const scorePenalty = calculateScorePenalty(washScore);

  // Step 6: Build suspicious patterns
  const suspiciousPatterns: string[] = [];

  for (const pair of offsettingPairs) {
    const seconds = Math.round(pair.timeDiffMs / 1000);
    const symbol = pair.buy.tokenSymbol || pair.buy.tokenAddress.slice(0, 8);
    suspiciousPatterns.push(
      `BUY/SELL ${symbol} within ${seconds}s at similar price`
    );
  }

  for (const sync of clusterSyncs) {
    const seconds = Math.round(sync.timeDiffMs / 1000);
    const symbol =
      sync.trade1.tokenSymbol || sync.trade1.tokenAddress.slice(0, 8);
    const linkedAddr = sync.trade2.walletAddress.slice(0, 8);
    suspiciousPatterns.push(
      `Coordinated ${symbol} trade with ${linkedAddr}... within ${seconds}s`
    );
  }

  return {
    isWashTrader: washScore >= WASH_TRADING_THRESHOLDS.WASH_SCORE_THRESHOLD,
    washScore: Math.round(washScore * 1000) / 1000, // 3 decimal places
    offsettingPairsCount: offsettingPairs.length,
    clusterSyncCount: clusterSyncs.length,
    totalTradesAnalyzed: trades.length,
    suspiciousPatterns,
    scorePenalty,
  };
}

/**
 * Count total possible buy/sell pairs per token.
 * For each token, pairs = min(buys, sells).
 */
function countTradePairs(trades: TraderTrade[]): number {
  const byToken = new Map<string, { buys: number; sells: number }>();

  for (const trade of trades) {
    const key = trade.tokenAddress.toLowerCase();
    const counts = byToken.get(key) || { buys: 0, sells: 0 };
    if (trade.type === "BUY") counts.buys++;
    else counts.sells++;
    byToken.set(key, counts);
  }

  let total = 0;
  for (const counts of Array.from(byToken.values())) {
    total += Math.min(counts.buys, counts.sells);
  }

  return total;
}
