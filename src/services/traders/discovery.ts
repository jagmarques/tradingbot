// Auto-discovery of profitable traders across all chains
import { Chain, TRADER_THRESHOLDS } from "./types.js";
import { upsertTrader, getTrader } from "./storage.js";
import {
  isMoralisConfigured,
  getTopTradersForToken,
  getWalletPnlSummary,
  getPopularTokens,
} from "./moralis.js";
import {
  isHeliusConfigured,
  analyzeWalletPnl,
  getRecentPumpfunTokens,
  findEarlyBuyers,
} from "./helius.js";

// Discovery interval: 4 hours (more aggressive)
const DISCOVERY_INTERVAL_MS = 4 * 60 * 60 * 1000;

// All EVM chains to discover traders on
const EVM_CHAINS: Chain[] = ["base", "bnb", "arbitrum", "avalanche"];

let discoveryTimer: NodeJS.Timeout | null = null;
let isDiscovering = false;

// Start periodic trader discovery
export function startDiscovery(): void {
  const hasMoralis = isMoralisConfigured();
  const hasHelius = isHeliusConfigured();

  if (!hasMoralis && !hasHelius) {
    console.log("[Discovery] No APIs configured - skipping auto-discovery");
    return;
  }

  if (discoveryTimer) {
    console.log("[Discovery] Already running");
    return;
  }

  console.log("[Discovery] Starting auto-discovery (every 4 hours)");
  console.log(`[Discovery] APIs: Moralis=${hasMoralis}, Helius=${hasHelius}`);

  // Run initial discovery after 30 seconds (let bot stabilize first)
  setTimeout(() => {
    runDiscovery();
  }, 30_000);

  // Schedule periodic discovery
  discoveryTimer = setInterval(() => {
    runDiscovery();
  }, DISCOVERY_INTERVAL_MS);
}

// Stop discovery
export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  console.log("[Discovery] Stopped");
}

// Run a discovery cycle
async function runDiscovery(): Promise<void> {
  if (isDiscovering) {
    console.log("[Discovery] Already in progress");
    return;
  }

  isDiscovering = true;
  console.log("[Discovery] Starting discovery cycle...");

  let totalDiscovered = 0;

  // Discover on EVM chains via Moralis
  if (isMoralisConfigured()) {
    for (const chain of EVM_CHAINS) {
      try {
        const discovered = await discoverTradersOnEvmChain(chain);
        totalDiscovered += discovered;
        console.log(`[Discovery] Found ${discovered} traders on ${chain}`);

        // Rate limiting between chains
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Discovery] Error on ${chain}:`, err);
      }
    }
  }

  // Discover on Solana via Helius
  if (isHeliusConfigured()) {
    try {
      const discovered = await discoverTradersOnSolana();
      totalDiscovered += discovered;
      console.log(`[Discovery] Found ${discovered} traders on Solana`);
    } catch (err) {
      console.error("[Discovery] Error on Solana:", err);
    }
  }

  console.log(`[Discovery] Cycle complete - ${totalDiscovered} total traders discovered`);
  isDiscovering = false;
}

// Discover traders on EVM chain via Moralis
async function discoverTradersOnEvmChain(chain: Chain): Promise<number> {
  // Fetch trending tokens dynamically from DexScreener
  const popularTokens = await getPopularTokens(chain);
  if (popularTokens.length === 0) {
    console.log(`[Discovery] No trending tokens found on ${chain}`);
    return 0;
  }

  console.log(`[Discovery] Checking ${popularTokens.length} trending tokens on ${chain}`);

  // Collect all trader addresses and their aggregate stats
  const traderStats = new Map<
    string,
    {
      totalProfit: number;
      tradeCount: number;
      tokens: number;
    }
  >();

  // Get top traders for each popular token
  for (const token of popularTokens) {
    try {
      const topTraders = await getTopTradersForToken(token, chain, 50);

      for (const trader of topTraders) {
        if (trader.count_of_trades < 3) continue; // Skip low activity

        const existing = traderStats.get(trader.owner_address) || {
          totalProfit: 0,
          tradeCount: 0,
          tokens: 0,
        };

        existing.totalProfit += trader.realized_profit_usd;
        existing.tradeCount += trader.count_of_trades;
        existing.tokens += 1;

        traderStats.set(trader.owner_address, existing);
      }

      // Rate limiting: 150ms between requests
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      console.error(`[Discovery] Error fetching token ${token.slice(0, 10)}...:`, err);
    }
  }

  // Filter to qualified traders
  let discovered = 0;

  for (const [address, stats] of traderStats) {
    // Basic qualification: profitable across multiple tokens
    if (stats.totalProfit <= 0 || stats.tokens < 2 || stats.tradeCount < 10) {
      continue;
    }

    // Check if already tracked
    const existing = getTrader(address, chain);
    if (existing) {
      continue;
    }

    // Get detailed PnL summary from Moralis
    try {
      const pnlSummary = await getWalletPnlSummary(address, chain);

      if (pnlSummary) {
        // Calculate win rate
        const totalTrades = pnlSummary.total_wins + pnlSummary.total_losses;
        const winRate = totalTrades > 0 ? (pnlSummary.total_wins / totalTrades) * 100 : 0;

        // Check if meets minimum criteria
        if (
          winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100 &&
          pnlSummary.total_pnl_usd > 1000 // At least $1k profit
        ) {
          // Calculate profit factor (estimate)
          const profitFactor =
            pnlSummary.total_losses > 0
              ? Math.min(10, pnlSummary.total_wins / pnlSummary.total_losses)
              : pnlSummary.total_wins > 0
                ? 10
                : 0;

          // Calculate score
          const score = Math.min(
            100,
            winRate * 0.4 + Math.min(100, profitFactor * 10) * 0.3 + Math.min(100, totalTrades * 2) * 0.3
          );

          // Save trader
          upsertTrader({
            address,
            chain,
            score: Math.round(score * 10) / 10,
            winRate,
            profitFactor,
            consistency: 50,
            totalTrades,
            winningTrades: pnlSummary.total_wins,
            losingTrades: pnlSummary.total_losses,
            totalPnlUsd: pnlSummary.total_pnl_usd,
            avgHoldTimeMs: 0,
            largestWinPct: 0,
            discoveredAt: Date.now(),
            updatedAt: Date.now(),
          });

          discovered++;
          console.log(
            `[Discovery] +${chain.toUpperCase()} ${address.slice(0, 8)}... (${winRate.toFixed(0)}% win, $${pnlSummary.total_pnl_usd.toFixed(0)})`
          );
        }
      }

      // Rate limiting
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      console.error(`[Discovery] Error getting PnL for ${address.slice(0, 8)}...:`, err);
    }
  }

  return discovered;
}

// Discover traders on Solana via Helius
async function discoverTradersOnSolana(): Promise<number> {
  console.log("[Discovery] Scanning Solana Pump.fun traders...");

  // Get recent Pump.fun tokens
  const recentTokens = await getRecentPumpfunTokens(30);
  console.log(`[Discovery] Found ${recentTokens.length} recent Pump.fun tokens`);

  if (recentTokens.length === 0) {
    return 0;
  }

  // Find early buyers for each token
  const traderFrequency = new Map<string, number>();

  for (const mint of recentTokens.slice(0, 15)) {
    // Check first 15 tokens
    try {
      const earlyBuyers = await findEarlyBuyers(mint, 20);

      for (const buyer of earlyBuyers) {
        traderFrequency.set(buyer, (traderFrequency.get(buyer) || 0) + 1);
      }

      await new Promise((r) => setTimeout(r, 200)); // Rate limit
    } catch (err) {
      console.error(`[Discovery] Error finding buyers for ${mint.slice(0, 8)}...:`, err);
    }
  }

  // Wallets that appear in multiple early buyer lists are likely good traders
  const potentialTraders = Array.from(traderFrequency.entries())
    .filter(([_, count]) => count >= 2) // Present in at least 2 token launches
    .map(([address]) => address);

  console.log(`[Discovery] Found ${potentialTraders.length} potential Solana traders`);

  let discovered = 0;

  for (const address of potentialTraders.slice(0, 50)) {
    // Analyze top 50
    // Check if already tracked
    const existing = getTrader(address, "solana");
    if (existing) {
      continue;
    }

    try {
      const analysis = await analyzeWalletPnl(address);

      if (!analysis) continue;

      // Check if meets criteria
      if (
        analysis.winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100 &&
        analysis.totalTrades >= 5 &&
        analysis.totalPnlSol > 0.5 // At least 0.5 SOL profit
      ) {
        // Estimate USD PnL (rough SOL price)
        const solPrice = 150;
        const totalPnlUsd = analysis.totalPnlSol * solPrice;

        // Calculate profit factor
        const profitFactor =
          analysis.losingTrades > 0
            ? Math.min(10, analysis.winningTrades / analysis.losingTrades)
            : analysis.winningTrades > 0
              ? 10
              : 0;

        // Calculate score
        const score = Math.min(
          100,
          analysis.winRate * 0.4 +
            Math.min(100, profitFactor * 10) * 0.3 +
            Math.min(100, analysis.totalTrades * 3) * 0.3
        );

        // Save trader
        upsertTrader({
          address,
          chain: "solana",
          score: Math.round(score * 10) / 10,
          winRate: analysis.winRate,
          profitFactor,
          consistency: 50,
          totalTrades: analysis.totalTrades,
          winningTrades: analysis.winningTrades,
          losingTrades: analysis.losingTrades,
          totalPnlUsd,
          avgHoldTimeMs: 0,
          largestWinPct: 0,
          discoveredAt: Date.now(),
          updatedAt: Date.now(),
        });

        discovered++;
        console.log(
          `[Discovery] +SOL ${address.slice(0, 8)}... (${analysis.winRate.toFixed(0)}% win, ${analysis.totalPnlSol.toFixed(2)} SOL)`
        );
      }

      await new Promise((r) => setTimeout(r, 200)); // Rate limit
    } catch (err) {
      console.error(`[Discovery] Error analyzing ${address.slice(0, 8)}...:`, err);
    }
  }

  return discovered;
}

// Manual discovery trigger
export async function runManualDiscovery(): Promise<number> {
  await runDiscovery();
  return 0;
}

// Check if discovery is active
export function isDiscoveryRunning(): boolean {
  return discoveryTimer !== null;
}
