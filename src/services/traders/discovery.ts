import { Chain, TRADER_THRESHOLDS, BIG_HITTER_THRESHOLDS } from "./types.js";
import { upsertTrader, getTrader } from "./storage.js";
import {
  isEtherscanConfigured,
  discoverTradersFromTokens,
  initProfitabilityCache,
  cleanupCache,
} from "./etherscan.js";
import { getAllActiveTokens } from "./dexscreener.js";
import {
  isHeliusConfigured,
  analyzeWalletPnl,
  getRecentPumpfunTokens,
  findEarlyBuyers,
} from "./helius.js";

// Memory-efficient Solana cache with strict limits
const checkedSolanaWallets = new Map<string, number>();
const SOLANA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SOLANA_CACHE_SIZE = 5000; // Reduced from 10000

function cleanupSolanaCache(): void {
  const now = Date.now();

  // Always cleanup expired entries
  for (const [key, timestamp] of checkedSolanaWallets) {
    if (now - timestamp > SOLANA_CACHE_TTL_MS) {
      checkedSolanaWallets.delete(key);
    }
  }

  // If still over limit, remove oldest entries
  if (checkedSolanaWallets.size > MAX_SOLANA_CACHE_SIZE) {
    const entries = Array.from(checkedSolanaWallets.entries())
      .sort((a, b) => a[1] - b[1]); // Sort by timestamp (oldest first)

    const toDelete = entries.slice(0, checkedSolanaWallets.size - MAX_SOLANA_CACHE_SIZE);
    for (const [key] of toDelete) {
      checkedSolanaWallets.delete(key);
    }
    console.log(`[Discovery] Pruned ${toDelete.length} old Solana cache entries`);
  }
}

// EVM chains - free tier only (paid: base, bsc, optimism, avalanche)
const EVM_CHAINS: Chain[] = ["ethereum", "polygon", "arbitrum", "sonic"];

let isRunning = false;
let isDiscovering = false;
let cycleCount = 0;

export function startDiscovery(): void {
  const hasEtherscan = isEtherscanConfigured();
  const hasHelius = isHeliusConfigured();

  if (!hasEtherscan && !hasHelius) {
    console.log("[Discovery] No APIs configured - skipping");
    return;
  }

  if (isRunning) {
    console.log("[Discovery] Already running");
    return;
  }

  // Initialize SQLite cache tables
  initProfitabilityCache();

  isRunning = true;
  console.log("[Discovery] Starting continuous discovery");
  console.log(`[Discovery] APIs: Etherscan=${hasEtherscan}, Helius=${hasHelius}`);

  runContinuousDiscovery();
}

export function stopDiscovery(): void {
  isRunning = false;
  console.log("[Discovery] Stopped");
}

async function runContinuousDiscovery(): Promise<void> {
  while (isRunning) {
    try {
      await runDiscovery();

      // Cleanup every 10 cycles
      cycleCount++;
      if (cycleCount % 10 === 0) {
        cleanupSolanaCache();
        cleanupCache(7 * 24 * 60 * 60 * 1000); // Clean SQLite cache older than 7 days
        console.log(`[Discovery] Memory cleanup after ${cycleCount} cycles`);
      }

      // Wait between cycles (Helius free tier = 10 RPS)
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      console.error("[Discovery] Cycle error:", err);
    }
  }
}

async function runDiscovery(): Promise<void> {
  if (isDiscovering) {
    console.log("[Discovery] Already in progress");
    return;
  }

  isDiscovering = true;
  console.log("[Discovery] Starting discovery cycle...");

  try {
    let totalDiscovered = 0;

    // Run ALL chains in PARALLEL (EVM + Solana)
    // Each API has separate rate limits, no reason to wait
    const tasks: Promise<{ chain: string; discovered: number }>[] = [];

    // EVM chains via Etherscan (free tier: ethereum, polygon, arbitrum, sonic)
    if (isEtherscanConfigured()) {
      for (const chain of EVM_CHAINS) {
        tasks.push(
          discoverTradersOnEvmChain(chain)
            .then((discovered) => ({ chain, discovered }))
            .catch((err) => {
              console.error(`[Discovery] Error on ${chain}:`, err);
              return { chain, discovered: 0 };
            })
        );
      }
    }

    // Solana via Helius - both Pump.fun and all DEXes (DexScreener tokens)
    if (isHeliusConfigured()) {
      // Pump.fun specific discovery
      tasks.push(
        discoverTradersOnSolanaPumpfun()
          .then((discovered) => ({ chain: "solana-pumpfun", discovered }))
          .catch((err) => {
            console.error("[Discovery] Error on Solana Pump.fun:", err);
            return { chain: "solana-pumpfun", discovered: 0 };
          })
      );

      // All DEXes via DexScreener tokens + Helius analysis
      tasks.push(
        discoverTradersOnSolanaAllDexes()
          .then((discovered) => ({ chain: "solana-dex", discovered }))
          .catch((err) => {
            console.error("[Discovery] Error on Solana DEXes:", err);
            return { chain: "solana-dex", discovered: 0 };
          })
      );
    }

    // Wait for all to complete
    const results = await Promise.all(tasks);
    for (const { chain, discovered } of results) {
      totalDiscovered += discovered;
      console.log(`[Discovery] Found ${discovered} traders on ${chain}`);
    }

    console.log(`[Discovery] Cycle complete - ${totalDiscovered} total traders discovered`);
  } finally {
    isDiscovering = false;
  }
}

async function discoverTradersOnEvmChain(chain: Chain): Promise<number> {
  // Get ALL active tokens: trending + new launches + high volume
  const activeTokens = await getAllActiveTokens(chain, 50);
  if (activeTokens.length === 0) {
    console.log(`[Discovery] No active tokens found on ${chain}`);
    return 0;
  }

  console.log(`[Discovery] Checking ${activeTokens.length} tokens on ${chain} (trending + new + high-vol)`);

  // Etherscan now saves traders immediately to DB as they're discovered
  const profitableTraders = await discoverTradersFromTokens(chain, activeTokens);

  return profitableTraders.size;
}

async function discoverTradersOnSolanaPumpfun(): Promise<number> {
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

  // Clear traderFrequency to free memory
  traderFrequency.clear();

  console.log(`[Discovery] Found ${potentialTraders.length} potential Solana traders`);

  let discovered = 0;
  let newWalletsChecked = 0;

  for (const address of potentialTraders) {
    const existing = getTrader(address, "solana");
    if (existing) continue;

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

// Discover traders on all Solana DEXes (Raydium, Orca, Jupiter) via DexScreener + Helius
async function discoverTradersOnSolanaAllDexes(): Promise<number> {
  console.log("[Discovery] Scanning Solana DEX traders (Raydium, Orca, Jupiter)...");

  // Get trending/active Solana tokens from DexScreener
  const solanaTokens = await getAllActiveTokens("solana", 30);
  console.log(`[Discovery] Found ${solanaTokens.length} active Solana tokens from DexScreener`);

  if (solanaTokens.length === 0) return 0;

  const traderFrequency = new Map<string, number>();

  // Find early buyers for each token using Helius
  for (const mint of solanaTokens) {
    try {
      const earlyBuyers = await findEarlyBuyers(mint, 30);
      for (const buyer of earlyBuyers) {
        traderFrequency.set(buyer, (traderFrequency.get(buyer) || 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 100)); // Rate limit
    } catch (err) {
      console.error(`[Discovery] Error finding DEX buyers for ${mint.slice(0, 8)}...:`, err);
    }
  }

  // Sort by frequency (traders on multiple tokens = more consistent)
  const potentialTraders = Array.from(traderFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([address]) => address);

  traderFrequency.clear();
  console.log(`[Discovery] Found ${potentialTraders.length} potential Solana DEX traders`);

  let discovered = 0;

  for (const address of potentialTraders) {
    // Skip if already tracked
    const existing = getTrader(address, "solana");
    if (existing) continue;

    // Skip if recently checked
    const lastChecked = checkedSolanaWallets.get(address);
    if (lastChecked && Date.now() - lastChecked < SOLANA_CACHE_TTL_MS) {
      continue;
    }

    try {
      const analysis = await analyzeWalletPnl(address);
      checkedSolanaWallets.set(address, Date.now());
      if (!analysis) continue;

      const solPrice = 150;
      const totalPnlUsd = analysis.totalPnlSol * solPrice;

      // Check standard trader thresholds (20+ trades, 60%+ win rate, positive PnL)
      const isStandardTrader =
        analysis.totalTrades >= TRADER_THRESHOLDS.MIN_TRADES &&
        analysis.winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100 &&
        totalPnlUsd > 0;

      // Check big hitter thresholds (10-19 trades, 60%+ win rate, $5000+ PnL)
      const isBigHitter =
        analysis.totalTrades >= BIG_HITTER_THRESHOLDS.MIN_TRADES &&
        analysis.totalTrades < TRADER_THRESHOLDS.MIN_TRADES &&
        analysis.winRate >= BIG_HITTER_THRESHOLDS.MIN_WIN_RATE * 100 &&
        totalPnlUsd >= BIG_HITTER_THRESHOLDS.MIN_TOTAL_PNL_USD;

      if (isStandardTrader || isBigHitter) {
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
            Math.min(100, analysis.totalTrades * 2) * 0.3
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
        const type = isStandardTrader ? "TRADER" : "BIG_HIT";
        console.log(
          `[Discovery] +SOL [${type}] ${address.slice(0, 8)}... (${analysis.winRate.toFixed(0)}% win, ${analysis.totalTrades} trades, $${totalPnlUsd.toFixed(0)})`
        );
      }

      await new Promise((r) => setTimeout(r, 100)); // Rate limit
    } catch (err) {
      console.error(`[Discovery] Error analyzing DEX trader ${address.slice(0, 8)}...:`, err);
    }
  }

  console.log(`[Discovery] Discovered ${discovered} profitable Solana DEX traders`);
  return discovered;
}

export async function runManualDiscovery(): Promise<number> {
  await runDiscovery();
  return 0;
}

export function isDiscoveryRunning(): boolean {
  return isRunning;
}
