import { Chain, TRADER_THRESHOLDS } from "./types.js";
import { upsertTrader, getTrader } from "./storage.js";
import { isMoralisConfigured, isMoralisRateLimited, discoverTradersFromTokens, getPopularTokens } from "./moralis.js";
import {
  isHeliusConfigured,
  analyzeWalletPnl,
  getRecentPumpfunTokens,
  findEarlyBuyers,
} from "./helius.js";

// Cache of Solana wallets already analyzed
const checkedSolanaWallets = new Map<string, number>();
const SOLANA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SOLANA_CACHE_SIZE = 10000;

function cleanupSolanaCache(): void {
  if (checkedSolanaWallets.size < MAX_SOLANA_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, timestamp] of checkedSolanaWallets) {
    if (now - timestamp > SOLANA_CACHE_TTL_MS) {
      checkedSolanaWallets.delete(key);
    }
  }
}

// Moralis profitability supports: Ethereum, Polygon, Base
const MORALIS_CHAINS: Chain[] = ["ethereum", "polygon", "base"];

let isRunning = false;
let isDiscovering = false;

export function startDiscovery(): void {
  const hasMoralis = isMoralisConfigured();
  const hasHelius = isHeliusConfigured();

  if (!hasMoralis && !hasHelius) {
    console.log("[Discovery] No APIs configured - skipping");
    return;
  }

  if (isRunning) {
    console.log("[Discovery] Already running");
    return;
  }

  isRunning = true;
  console.log("[Discovery] Starting continuous discovery");
  console.log(`[Discovery] APIs: Moralis=${hasMoralis}, Helius=${hasHelius}`);

  runContinuousDiscovery();
}

export function stopDiscovery(): void {
  isRunning = false;
  console.log("[Discovery] Stopped");
}

async function runContinuousDiscovery(): Promise<void> {
  while (isRunning) {
    await runDiscovery();
  }
}

async function runDiscovery(): Promise<void> {
  if (isDiscovering) {
    console.log("[Discovery] Already in progress");
    return;
  }

  isDiscovering = true;
  console.log("[Discovery] Starting discovery cycle...");

  let totalDiscovered = 0;

  if (isMoralisConfigured() && !isMoralisRateLimited()) {
    for (const chain of MORALIS_CHAINS) {
      try {
        const discovered = await discoverTradersOnEvmChain(chain);
        totalDiscovered += discovered;
        console.log(`[Discovery] Found ${discovered} traders on ${chain}`);
      } catch (err) {
        console.error(`[Discovery] Error on ${chain}:`, err);
      }
    }
  } else if (isMoralisRateLimited()) {
    console.log("[Discovery] Moralis rate limited - skipping EVM chains");
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

  const profitableTraders = await discoverTradersFromTokens(chain, popularTokens);

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
  cleanupSolanaCache();
  console.log("[Discovery] Scanning Solana Pump.fun traders...");

  const recentTokens = await getRecentPumpfunTokens(30);
  console.log(`[Discovery] Found ${recentTokens.length} recent Pump.fun tokens`);

  if (recentTokens.length === 0) return 0;

  const traderFrequency = new Map<string, number>();

  for (const mint of recentTokens) {
    try {
      const earlyBuyers = await findEarlyBuyers(mint, 50);
      for (const buyer of earlyBuyers) {
        traderFrequency.set(buyer, (traderFrequency.get(buyer) || 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      console.error(`[Discovery] Error finding buyers for ${mint.slice(0, 8)}...:`, err);
    }
  }

  const potentialTraders = Array.from(traderFrequency.entries())
    .filter(([_, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([address]) => address);

  console.log(`[Discovery] Found ${potentialTraders.length} potential Solana traders`);

  let discovered = 0;

  let newWalletsChecked = 0;
  for (const address of potentialTraders) {
    const existing = getTrader(address, "solana");
    if (existing) continue;

    // Skip if already checked recently
    const lastChecked = checkedSolanaWallets.get(address);
    if (lastChecked && Date.now() - lastChecked < SOLANA_CACHE_TTL_MS) {
      continue;
    }

    try {
      const analysis = await analyzeWalletPnl(address);
      checkedSolanaWallets.set(address, Date.now());
      newWalletsChecked++;
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

      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      console.error(`[Discovery] Error analyzing ${address.slice(0, 8)}...:`, err);
    }
  }

  if (newWalletsChecked > 0) {
    console.log(`[Discovery] Checked ${newWalletsChecked} new Solana wallets`);
  }

  return discovered;
}

export async function runManualDiscovery(): Promise<number> {
  await runDiscovery();
  return 0;
}

export function isDiscoveryRunning(): boolean {
  return isRunning;
}
