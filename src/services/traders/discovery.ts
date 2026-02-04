import { Chain, TRADER_THRESHOLDS } from "./types.js";
import { upsertTrader, getTrader } from "./storage.js";
import { isMoralisConfigured, discoverTradersFromTokens, getPopularTokens } from "./moralis.js";
import {
  isHeliusConfigured,
  analyzeWalletPnl,
  getRecentPumpfunTokens,
  findEarlyBuyers,
} from "./helius.js";

const DISCOVERY_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Only Base supported for Moralis profitability (free tier)
// BNB, Arbitrum, Avalanche not supported
const MORALIS_CHAINS: Chain[] = ["base"];

let discoveryTimer: NodeJS.Timeout | null = null;
let isDiscovering = false;

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
  console.log(`[Discovery] Chains: Base=${hasMoralis}, Solana=${hasHelius}`);

  setTimeout(() => {
    runDiscovery();
  }, 30_000);

  discoveryTimer = setInterval(() => {
    runDiscovery();
  }, DISCOVERY_INTERVAL_MS);
}

export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  console.log("[Discovery] Stopped");
}

async function runDiscovery(): Promise<void> {
  if (isDiscovering) {
    console.log("[Discovery] Already in progress");
    return;
  }

  isDiscovering = true;
  console.log("[Discovery] Starting discovery cycle...");

  let totalDiscovered = 0;

  if (isMoralisConfigured()) {
    for (const chain of MORALIS_CHAINS) {
      try {
        const discovered = await discoverTradersOnEvmChain(chain);
        totalDiscovered += discovered;
        console.log(`[Discovery] Found ${discovered} traders on ${chain}`);
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Discovery] Error on ${chain}:`, err);
      }
    }
  }

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

async function discoverTradersOnEvmChain(chain: Chain): Promise<number> {
  const popularTokens = await getPopularTokens(chain);
  if (popularTokens.length === 0) {
    console.log(`[Discovery] No trending tokens found on ${chain}`);
    return 0;
  }

  console.log(`[Discovery] Checking ${popularTokens.length} trending tokens on ${chain}`);

  const profitableTraders = await discoverTradersFromTokens(chain, popularTokens, 30);

  let discovered = 0;

  for (const [address, pnl] of profitableTraders) {
    const existing = getTrader(address, chain);
    if (existing) continue;

    const totalTrades = pnl.total_wins + pnl.total_losses;
    const winRate = pnl.win_rate || (totalTrades > 0 ? (pnl.total_wins / totalTrades) * 100 : 0);

    if (winRate < TRADER_THRESHOLDS.MIN_WIN_RATE * 100 || pnl.total_pnl_usd < 500) {
      continue;
    }

    const profitFactor =
      pnl.total_losses > 0
        ? Math.min(10, pnl.total_wins / pnl.total_losses)
        : pnl.total_wins > 0
          ? 10
          : 0;

    const score = Math.min(
      100,
      winRate * 0.4 + Math.min(100, profitFactor * 10) * 0.3 + Math.min(100, totalTrades * 2) * 0.3
    );

    upsertTrader({
      address,
      chain,
      score: Math.round(score * 10) / 10,
      winRate,
      profitFactor,
      consistency: 50,
      totalTrades,
      winningTrades: pnl.total_wins,
      losingTrades: pnl.total_losses,
      totalPnlUsd: pnl.total_pnl_usd,
      avgHoldTimeMs: 0,
      largestWinPct: 0,
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    });

    discovered++;
  }

  return discovered;
}

async function discoverTradersOnSolana(): Promise<number> {
  console.log("[Discovery] Scanning Solana Pump.fun traders...");

  const recentTokens = await getRecentPumpfunTokens(30);
  console.log(`[Discovery] Found ${recentTokens.length} recent Pump.fun tokens`);

  if (recentTokens.length === 0) return 0;

  const traderFrequency = new Map<string, number>();

  for (const mint of recentTokens.slice(0, 15)) {
    try {
      const earlyBuyers = await findEarlyBuyers(mint, 20);
      for (const buyer of earlyBuyers) {
        traderFrequency.set(buyer, (traderFrequency.get(buyer) || 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[Discovery] Error finding buyers for ${mint.slice(0, 8)}...:`, err);
    }
  }

  const potentialTraders = Array.from(traderFrequency.entries())
    .filter(([_, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([address]) => address);

  console.log(`[Discovery] Found ${potentialTraders.length} potential Solana traders`);

  let discovered = 0;

  for (const address of potentialTraders) {
    const existing = getTrader(address, "solana");
    if (existing) continue;

    try {
      const analysis = await analyzeWalletPnl(address);
      if (!analysis) continue;

      if (
        analysis.winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100 &&
        analysis.totalTrades >= 5 &&
        analysis.totalPnlSol > 0.5
      ) {
        const solPrice = 150;
        const totalPnlUsd = analysis.totalPnlSol * solPrice;

        const profitFactor =
          analysis.losingTrades > 0
            ? Math.min(10, analysis.winningTrades / analysis.losingTrades)
            : analysis.winningTrades > 0
              ? 10
              : 0;

        const score = Math.min(
          100,
          analysis.winRate * 0.4 +
            Math.min(100, profitFactor * 10) * 0.3 +
            Math.min(100, analysis.totalTrades * 3) * 0.3
        );

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

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[Discovery] Error analyzing ${address.slice(0, 8)}...:`, err);
    }
  }

  return discovered;
}

export async function runManualDiscovery(): Promise<number> {
  await runDiscovery();
  return 0;
}

export function isDiscoveryRunning(): boolean {
  return discoveryTimer !== null;
}
