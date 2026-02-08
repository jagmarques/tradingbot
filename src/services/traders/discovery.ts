import { Chain, TRADER_THRESHOLDS, BIG_HITTER_THRESHOLDS } from "./types.js";
import { upsertTrader, getTrader } from "./storage.js";
import { initProfitabilityCache, cleanupCache } from "./etherscan.js";
import { getAllActiveTokens } from "./dexscreener.js";
import {
  isHeliusConfigured,
  analyzeWalletPnl,
  getRecentSolanaTokens,
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

let isRunning = false;
let isDiscovering = false;
let cycleCount = 0;

export function startDiscovery(): void {
  const hasHelius = isHeliusConfigured();
  const hasBirdeye = !!process.env.BIRDEYE_API_KEY;

  if (!hasHelius || !hasBirdeye) {
    console.log(`[Discovery] Disabled (Helius=${hasHelius}, Birdeye=${hasBirdeye}) - both required`);
    return;
  }

  if (isRunning) {
    console.log("[Discovery] Already running");
    return;
  }

  // Initialize SQLite cache tables
  initProfitabilityCache();

  isRunning = true;
  console.log("[Discovery] Starting continuous discovery (Solana only)");

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

    // EVM discovery disabled - Etherscan transfer analysis can't reliably detect
    // round-trip trades through DEX aggregators (0 traders found in 40+ cycles)

    // Solana via Helius - token launches and all DEXes
    if (isHeliusConfigured()) {
      // Token launch discovery (via Pump.fun program)
      tasks.push(
        discoverTradersOnSolanaTokenLaunches()
          .then((discovered) => ({ chain: "solana-launches", discovered }))
          .catch((err) => {
            console.error("[Discovery] Error on Solana token launches:", err);
            return { chain: "solana-launches", discovered: 0 };
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

async function discoverTradersOnSolanaTokenLaunches(): Promise<number> {
  cleanupSolanaCache();
  console.log("[Discovery] Scanning Solana token launch traders...");

  const recentTokens = await getRecentSolanaTokens(30);
  console.log(`[Discovery] Found ${recentTokens.length} recent Solana token launches`);

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

      const isStandardTrader =
        analysis.totalTrades >= TRADER_THRESHOLDS.MIN_TRADES &&
        analysis.winRate >= TRADER_THRESHOLDS.MIN_WIN_RATE * 100 &&
        totalPnlUsd > 0;

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

// ===== BIRDEYE-BASED TRADER DISCOVERY (Phase 21) =====

export const DISCOVERY_CONFIG = {
  // Birdeye API (Solana) - free tier
  BIRDEYE_TOP_TRADERS_URL: "https://public-api.birdeye.so/defi/v2/tokens/top_traders",
  // How often to run discovery (24 hours)
  DISCOVERY_INTERVAL_MS: 24 * 60 * 60 * 1000,
  // Max new traders to add per discovery run
  MAX_NEW_TRADERS_PER_RUN: 10,
  // Minimum requirements for discovered traders
  MIN_TOTAL_TRADES: 10,
  MIN_WIN_RATE: 0.50,
  MIN_PNL_USD: 200,
  // Popular tokens to scan for top traders (Solana)
  SOLANA_SCAN_TOKENS: [
    "So11111111111111111111111111111111111111112", // SOL (wrapped)
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  ],
};

export interface DiscoveryResult {
  chain: Chain;
  discovered: number;
  qualified: number;
  added: number;
  skipped: number;
  errors: string[];
}

const BIRDEYE_FETCH_TIMEOUT_MS = 10_000;
const BIRDEYE_RATE_LIMIT_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverSolanaTraders(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    chain: "solana",
    discovered: 0,
    qualified: 0,
    added: 0,
    skipped: 0,
    errors: [],
  };

  const apiKey = process.env.BIRDEYE_API_KEY || "";
  const allWallets: Array<{
    address: string;
    trades: number;
    pnlUsd: number;
    volume: number;
    winRate?: number;
  }> = [];

  for (const tokenAddress of DISCOVERY_CONFIG.SOLANA_SCAN_TOKENS) {
    try {
      const url = `${DISCOVERY_CONFIG.BIRDEYE_TOP_TRADERS_URL}?address=${tokenAddress}&time_frame=7d&sort_type=PnL&sort_by=desc&limit=20`;
      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            "x-chain": "solana",
            "X-API-KEY": apiKey,
          },
        },
        BIRDEYE_FETCH_TIMEOUT_MS,
      );

      if (!response.ok) {
        result.errors.push(`Birdeye API error for ${tokenAddress.slice(0, 8)}...: ${response.status}`);
        console.error(`[Discovery] Birdeye API returned ${response.status} for ${tokenAddress.slice(0, 8)}...`);
        await delay(BIRDEYE_RATE_LIMIT_MS);
        continue;
      }

      const data = (await response.json()) as {
        success?: boolean;
        data?: {
          items?: Array<{
            owner?: string;
            address?: string;
            trade_count?: number;
            total_pnl?: number;
            volume?: number;
            win_rate?: number;
          }>;
        };
      };

      const items = data?.data?.items;
      if (!items || !Array.isArray(items)) {
        await delay(BIRDEYE_RATE_LIMIT_MS);
        continue;
      }

      for (const item of items) {
        const walletAddress = item.owner || item.address;
        if (!walletAddress) continue;

        result.discovered++;
        allWallets.push({
          address: walletAddress,
          trades: item.trade_count || 0,
          pnlUsd: item.total_pnl || 0,
          volume: item.volume || 0,
          winRate: item.win_rate,
        });
      }

      await delay(BIRDEYE_RATE_LIMIT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("abort")) {
        result.errors.push(`Birdeye API timeout for ${tokenAddress.slice(0, 8)}...`);
        console.error(`[Discovery] Birdeye API timeout for ${tokenAddress.slice(0, 8)}...`);
      } else {
        result.errors.push(`Birdeye API error for ${tokenAddress.slice(0, 8)}...: ${message}`);
        console.error(`[Discovery] Birdeye API error for ${tokenAddress.slice(0, 8)}...:`, message);
      }
    }
  }

  // Deduplicate wallets by address (may appear for multiple tokens)
  const uniqueWallets = new Map<string, (typeof allWallets)[number]>();
  for (const wallet of allWallets) {
    const existing = uniqueWallets.get(wallet.address);
    if (!existing || wallet.pnlUsd > existing.pnlUsd) {
      uniqueWallets.set(wallet.address, wallet);
    }
  }

  let addedCount = 0;

  for (const wallet of uniqueWallets.values()) {
    // Validate against thresholds
    if (wallet.trades < DISCOVERY_CONFIG.MIN_TOTAL_TRADES) continue;
    if (wallet.winRate !== undefined && wallet.winRate < DISCOVERY_CONFIG.MIN_WIN_RATE) continue;
    if (wallet.pnlUsd < DISCOVERY_CONFIG.MIN_PNL_USD) continue;

    result.qualified++;

    // Check if already tracked
    const existing = getTrader(wallet.address, "solana");
    if (existing) {
      result.skipped++;
      continue;
    }

    // Respect max new traders per run
    if (addedCount >= DISCOVERY_CONFIG.MAX_NEW_TRADERS_PER_RUN) continue;

    // Calculate initial score from available data
    const winRateScore = wallet.winRate !== undefined ? wallet.winRate * 100 * 0.4 : 50 * 0.4;
    const pnlScore = Math.min(100, wallet.pnlUsd / 100) * 0.4;
    const activityScore = Math.min(100, wallet.trades * 2) * 0.2;
    const score = Math.min(100, Math.round(winRateScore + pnlScore + activityScore));

    const winRate = wallet.winRate !== undefined ? wallet.winRate * 100 : 0;
    const estimatedWins = wallet.winRate !== undefined
      ? Math.round(wallet.trades * wallet.winRate)
      : 0;

    upsertTrader({
      address: wallet.address,
      chain: "solana",
      score,
      winRate,
      profitFactor: 0,
      consistency: 0,
      totalTrades: wallet.trades,
      winningTrades: estimatedWins,
      losingTrades: wallet.trades - estimatedWins,
      totalPnlUsd: wallet.pnlUsd,
      avgHoldTimeMs: 0,
      largestWinPct: 0,
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
    });

    addedCount++;
    result.added++;
    console.log(
      `[Discovery] +Birdeye ${wallet.address.slice(0, 8)}... (${wallet.trades} trades, $${wallet.pnlUsd.toFixed(0)} PnL)`,
    );
  }

  return result;
}

export async function discoverTraders(chain: Chain): Promise<DiscoveryResult> {
  if (chain === "solana") {
    return discoverSolanaTraders();
  }
  return { chain, discovered: 0, qualified: 0, added: 0, skipped: 0, errors: ["EVM discovery disabled"] };
}

export async function runDiscoveryAll(): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];

  // Run Solana discovery (only chain with good free API)
  const solanaResult = await discoverSolanaTraders();
  results.push(solanaResult);

  const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
  console.log(`[Discovery] Discovered ${totalAdded} new traders across ${results.length} chains`);

  return results;
}
