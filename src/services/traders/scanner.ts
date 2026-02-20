import type { EvmChain, ScanChain, PumpedToken, InsiderScanResult } from "./types.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { INSIDER_CONFIG, WATCHER_CONFIG } from "./types.js";
import { loadEnv } from "../../config/env.js";
import { upsertInsiderWallet, deleteInsiderWalletsBelow } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES, KNOWN_DEX_ROUTERS } from "./types.js";

// GeckoTerminal API
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_IDS: Record<ScanChain, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
  avalanche: "avax",
};

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Routescan API for Avalanche (Snowtrace)
const ROUTESCAN_AVAX_URL = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";

// Chain IDs for Etherscan V2
const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
};

// Chains with working free explorer APIs (ethereum=Etherscan, avalanche=Routescan)
export const EXPLORER_SUPPORTED_CHAINS = new Set<string>(["ethereum", "avalanche"]);

// Build explorer URL based on chain (Routescan for Avalanche, Etherscan V2 for others)
export function buildExplorerUrl(chain: EvmChain, params: string): string {
  const env = loadEnv();
  if (chain === "avalanche") {
    const apiKey = env.SNOWTRACE_API_KEY ?? "";
    return `${ROUTESCAN_AVAX_URL}?${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
  }
  const chainId = ETHERSCAN_CHAIN_IDS[chain];
  const apiKey = env.ETHERSCAN_API_KEY ?? "";
  return `${ETHERSCAN_V2_URL}?chainid=${chainId}&${params}${apiKey ? `&apikey=${apiKey}` : ""}`;
}

// Zero address
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// GeckoTerminal: ~12 calls/cycle, actual limit ~6/min (stricter than documented)
let geckoQueue: Promise<void> = Promise.resolve();

async function geckoRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = geckoQueue.then(() => new Promise<void>((r) => setTimeout(r, 10_000)));
  geckoQueue = myTurn;
  await myTurn;
  const response = await fetchWithTimeout(url);
  if (response.status !== 429) return response;
  const delays = [15_000, 30_000, 60_000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = delays[attempt - 1];
    const endpoint = url.replace("https://api.geckoterminal.com/api/v2", "").slice(0, 60);
    console.log(`[InsiderScanner] GeckoTerminal 429 on ${endpoint}, retry ${attempt}/3 in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    const retry = await fetchWithTimeout(url);
    if (retry.status !== 429) return retry;
  }
  const exhaustedEndpoint = url.replace("https://api.geckoterminal.com/api/v2", "").slice(0, 60);
  console.log(`[InsiderScanner] GeckoTerminal 429 exhausted retries for ${exhaustedEndpoint}`);
  return response;
}

// Rate limiting for Etherscan (220ms between requests, per chain)
const ETHERSCAN_INTERVAL_MS = 220;
const etherscanQueueByChain = new Map<string, Promise<void>>();

export async function etherscanRateLimitedFetch(url: string, chain: string): Promise<Response> {
  const currentQueue = etherscanQueueByChain.get(chain) || Promise.resolve();
  const interval = chain === "avalanche" ? 550 : ETHERSCAN_INTERVAL_MS;
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, interval));
  });
  etherscanQueueByChain.set(chain, myTurn);
  await myTurn;
  return fetchWithTimeout(url);
}

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string;
    price_change_percentage: { h1: string; h24: string };
    transactions: { h24: { buys: number; sells: number } };
    volume_usd: { h24: string };
    reserve_in_usd: string;
  };
  relationships: {
    base_token: { data: { id: string; type: string } };
  };
}

// Find tokens that pumped 3x+ in 24h on a given chain
export async function findPumpedTokens(chain: ScanChain): Promise<PumpedToken[]> {
  const networkId = GECKO_NETWORK_IDS[chain];
  const seen = new Set<string>();
  const pumped: PumpedToken[] = [];

  try {
    const url = `${GECKO_BASE}/networks/${networkId}/trending_pools`;
    const response = await geckoRateLimitedFetch(url);

    if (!response.ok) {
      console.error(`[InsiderScanner] GeckoTerminal API returned ${response.status} for ${chain}`);
      return [];
    }

    const data = (await response.json()) as { data: GeckoPool[] };
    const pools = data.data || [];

    for (const pool of pools) {
      if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

      const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
      const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
      const liquidity = parseFloat(pool.attributes.reserve_in_usd);

      // Filter by thresholds
      if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

      // Extract token address from relationships.base_token.data.id (format: "network_address")
      const baseTokenId = pool.relationships.base_token.data.id;
      const parts = baseTokenId.split("_");
      if (parts.length < 2) continue;
      const tokenAddress = parts.slice(1).join("_").toLowerCase();

      // Skip duplicates
      if (seen.has(tokenAddress)) continue;
      seen.add(tokenAddress);

      // Extract symbol from pool name (format: "SYMBOL / QUOTE")
      const nameParts = pool.attributes.name.split(" / ");
      const symbol = nameParts[0] || "UNKNOWN";

      pumped.push({
        tokenAddress,
        chain,
        symbol,
        pairAddress: pool.attributes.address,
        priceChangeH24: h24Change,
        volumeH24,
        liquidity,
        discoveredAt: Date.now(),
      });
    }

    console.log(
      `[InsiderScanner] ${chain}: ${pumped.length} trending tokens passed filters (>=100% change, >=$5k vol, >=$2k liq)`
    );
  } catch (err) {
    console.error(`[InsiderScanner] GeckoTerminal error for ${chain}:`, err);
  }

  // Also check new_pools endpoint
  try {
    if (pumped.length < INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) {
      const newPoolsUrl = `${GECKO_BASE}/networks/${networkId}/new_pools`;
      const newPoolsResponse = await geckoRateLimitedFetch(newPoolsUrl);

      if (newPoolsResponse.ok) {
        const newPoolsData = (await newPoolsResponse.json()) as { data: GeckoPool[] };
        const newPools = newPoolsData.data || [];
        let newCount = 0;

        for (const pool of newPools) {
          if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

          const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
          const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
          const liquidity = parseFloat(pool.attributes.reserve_in_usd);

          if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

          const baseTokenId = pool.relationships.base_token.data.id;
          const parts = baseTokenId.split("_");
          if (parts.length < 2) continue;
          const tokenAddress = parts.slice(1).join("_").toLowerCase();

          if (seen.has(tokenAddress)) continue;
          seen.add(tokenAddress);

          const nameParts = pool.attributes.name.split(" / ");
          const symbol = nameParts[0] || "UNKNOWN";

          pumped.push({
            tokenAddress,
            chain,
            symbol,
            pairAddress: pool.attributes.address,
            priceChangeH24: h24Change,
            volumeH24,
            liquidity,
            discoveredAt: Date.now(),
          });
          newCount++;
        }

        console.log(`[InsiderScanner] ${chain}: ${newCount} additional tokens from new_pools`);
      }
    }
  } catch (err) {
    console.error(`[InsiderScanner] new_pools error for ${chain}:`, err);
  }

  // Also check top_pools endpoint (by volume)
  try {
    if (pumped.length < INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) {
      const topPoolsUrl = `${GECKO_BASE}/networks/${networkId}/pools?sort=h24_volume_usd_desc&page=1`;
      const topPoolsResponse = await geckoRateLimitedFetch(topPoolsUrl);

      if (topPoolsResponse.ok) {
        const topPoolsData = (await topPoolsResponse.json()) as { data: GeckoPool[] };
        const topPools = topPoolsData.data || [];
        let topCount = 0;

        for (const pool of topPools) {
          if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

          const h24Change = parseFloat(pool.attributes.price_change_percentage.h24);
          const volumeH24 = parseFloat(pool.attributes.volume_usd.h24);
          const liquidity = parseFloat(pool.attributes.reserve_in_usd);

          if (h24Change < 100 || volumeH24 < 5000 || liquidity < 2000) continue;

          const baseTokenId = pool.relationships.base_token.data.id;
          const parts = baseTokenId.split("_");
          if (parts.length < 2) continue;
          const tokenAddress = parts.slice(1).join("_").toLowerCase();

          if (seen.has(tokenAddress)) continue;
          seen.add(tokenAddress);

          const nameParts = pool.attributes.name.split(" / ");
          const symbol = nameParts[0] || "UNKNOWN";

          pumped.push({
            tokenAddress,
            chain,
            symbol,
            pairAddress: pool.attributes.address,
            priceChangeH24: h24Change,
            volumeH24,
            liquidity,
            discoveredAt: Date.now(),
          });
          topCount++;
        }

        console.log(`[InsiderScanner] ${chain}: ${topCount} additional tokens from top_pools`);
      }
    }
  } catch (err) {
    console.error(`[InsiderScanner] top_pools error for ${chain}:`, err);
  }

  return pumped;
}

// Find wallets that bought a token early (within first 50-100 transfers)
export async function findEarlyBuyers(token: PumpedToken): Promise<string[]> {
  if (!EXPLORER_SUPPORTED_CHAINS.has(token.chain)) return [];

  const url = buildExplorerUrl(token.chain as EvmChain, `module=account&action=tokentx&contractaddress=${token.tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  try {
    const response = await etherscanRateLimitedFetch(url, token.chain);
    if (!response.ok) {
      console.log(`[InsiderScanner] findEarlyBuyers HTTP ${response.status} for ${token.tokenAddress.slice(0, 10)}`);
      return [];
    }
    const data = (await response.json()) as {
      status: string;
      result: Array<{
        hash: string;
        from: string;
        to: string;
        blockNumber: string;
        timeStamp: string;
      }>;
    };

    if (data.status !== "1" || !Array.isArray(data.result)) {
      return [];
    }

    // Take the first 100 transfers (earliest buyers)
    const earlyTransfers = data.result.slice(0, 100);

    // Count how many transfers each address appears in (to filter routers/pools)
    const totalTransfers = data.result.length;
    const addressCounts = new Map<string, number>();
    for (const tx of data.result) {
      const to = tx.to.toLowerCase();
      addressCounts.set(to, (addressCounts.get(to) || 0) + 1);
    }

    // Get known exchange addresses for this chain
    const chainKey = token.chain as keyof typeof KNOWN_EXCHANGES;
    const exchanges = new Set(
      (KNOWN_EXCHANGES[chainKey] || []).map((a) => a.toLowerCase())
    );

    // Extract unique buyer addresses from early transfers
    const buyers = new Set<string>();
    for (const tx of earlyTransfers) {
      const to = tx.to.toLowerCase();

      // Skip zero address
      if (to === ZERO_ADDRESS) continue;

      // Skip the token contract itself
      if (to === token.tokenAddress) continue;

      // Skip known exchanges
      if (exchanges.has(to)) continue;

      // Skip addresses appearing in >50% of all transfers (likely router/pool)
      const count = addressCounts.get(to) || 0;
      if (totalTransfers > 10 && count / totalTransfers > 0.5) continue;

      buyers.add(to);
    }

    console.log(`[InsiderScanner] Found ${buyers.size} early buyers for ${token.symbol} on ${token.chain}`);
    return Array.from(buyers);
  } catch (err) {
    console.error(`[InsiderScanner] Etherscan error for ${token.symbol} on ${token.chain}:`, err);
    return [];
  }
}

// Query Etherscan for wallet+token transfer history to determine buy/sell status
interface WalletTokenPnl {
  buyTokens: number;
  sellTokens: number;
  status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  buyDate: number;
  sellDate: number;
}

export async function getWalletTokenPnl(
  walletAddress: string, tokenAddress: string, chain: ScanChain
): Promise<WalletTokenPnl> {
  if (!EXPLORER_SUPPORTED_CHAINS.has(chain)) {
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }

  const url = buildExplorerUrl(chain as EvmChain, `module=account&action=tokentx&address=${walletAddress}&contractaddress=${tokenAddress}&startblock=0&endblock=99999999&sort=asc`);

  const response = await etherscanRateLimitedFetch(url, chain);
  if (!response.ok) {
    console.error(`[Scanner] Etherscan HTTP ${response.status} for wallet token PnL: ${walletAddress}`);
    return { buyTokens: 0, sellTokens: 0, status: "unknown", buyDate: 0, sellDate: 0 };
  }
  const data = (await response.json()) as {
    status: string;
    result: Array<{
      from: string;
      to: string;
      value: string;
      tokenDecimal: string;
      timeStamp: string;
    }>;
  };

  // Build set of known sell destinations (DEX routers + exchanges)
  const sellDestinations = new Set<string>();
  const routers = KNOWN_DEX_ROUTERS[chain] || [];
  for (const addr of routers) sellDestinations.add(addr.toLowerCase());
  const chainKey = chain as keyof typeof KNOWN_EXCHANGES;
  const exchanges = KNOWN_EXCHANGES[chainKey] || [];
  for (const addr of exchanges) sellDestinations.add(addr.toLowerCase());

  let buyTokens = 0;
  let soldTokens = 0;
  let transferredTokens = 0;
  let buyDate = 0;
  let sellDate = 0;

  if (data.status === "1" && Array.isArray(data.result)) {
    for (const tx of data.result) {
      const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal));
      const ts = parseInt(tx.timeStamp) * 1000;
      if (tx.to.toLowerCase() === walletAddress.toLowerCase()) {
        buyTokens += amount;
        if (!buyDate) buyDate = ts;
      } else if (tx.from.toLowerCase() === walletAddress.toLowerCase()) {
        const dest = tx.to.toLowerCase();
        if (sellDestinations.has(dest) || dest === ZERO_ADDRESS) {
          soldTokens += amount;
        } else {
          transferredTokens += amount;
        }
        sellDate = ts;
      }
    }
  }

  const sellTokens = soldTokens + transferredTokens;
  const totalOut = sellTokens;

  let status: "holding" | "sold" | "partial" | "transferred" | "unknown";
  if (buyTokens === 0 && totalOut === 0) {
    status = "unknown";
  } else if (totalOut > 0.9 * buyTokens && transferredTokens > soldTokens) {
    status = "transferred";
  } else if (totalOut > 0.9 * buyTokens) {
    status = "sold";
  } else if (totalOut < 0.1 * buyTokens) {
    status = "holding";
  } else {
    status = "partial";
  }

  return { buyTokens, sellTokens, status, buyDate, sellDate };
}

// Chain rotation state (rotates 3 chains per cycle through all 6)
let lastChainIndex = 0;

// Main scan orchestrator
export async function runInsiderScan(): Promise<InsiderScanResult> {
  const result: InsiderScanResult = {
    pumpedTokensFound: 0,
    walletsAnalyzed: 0,
    insidersFound: 0,
    errors: [],
  };

  const allChains = INSIDER_CONFIG.SCAN_CHAINS;
  const perCycle = INSIDER_CONFIG.CHAINS_PER_CYCLE;
  const cycleChains: ScanChain[] = [];
  for (let i = 0; i < perCycle; i++) {
    cycleChains.push(allChains[(lastChainIndex + i) % allChains.length]);
  }
  lastChainIndex = (lastChainIndex + perCycle) % allChains.length;

  console.log(`[InsiderScanner] Scanning ${cycleChains.length}/${allChains.length} chains: ${cycleChains.join(", ")}`);

  for (const chain of cycleChains) {
    try {
      // Find pumped tokens
      const pumpedTokens = await findPumpedTokens(chain);
      result.pumpedTokensFound += pumpedTokens.length;

      // For each pumped token, find early buyers
      for (const token of pumpedTokens) {
        try {
          const earlyBuyers = await findEarlyBuyers(token);
          result.walletsAnalyzed += earlyBuyers.length;

          // 500ms delay between tokens
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          const msg = `Error processing ${token.symbol} on ${chain}: ${err}`;
          console.error(`[InsiderScanner] ${msg}`);
          result.errors.push(msg);
          continue;
        }
      }
    } catch (err) {
      const msg = `Error scanning ${chain}: ${err}`;
      console.error(`[InsiderScanner] ${msg}`);
      result.errors.push(msg);
    }
    // Delay between chains to spread GeckoTerminal load
    await new Promise((r) => setTimeout(r, INSIDER_CONFIG.INTER_CHAIN_DELAY_MS));
  }

  // Multi-factor wallet scoring (0-100) - now based on copy trades
  function computeWalletScore(wallet: {
    gem_count: number;
    avg_pump: number;
    holding_count: number;
    unique_tokens: number;
    first_seen: number;
    last_seen: number;
  }): number {
    // 1. Gem count (30 points max)
    const gemCountScore = Math.min(30, Math.round(30 * Math.log2(Math.max(1, wallet.gem_count)) / Math.log2(100)));

    // 2. Average pump multiple (30 points max)
    const avgPumpScore = Math.min(30, Math.round(30 * Math.sqrt(Math.min(wallet.avg_pump, 50)) / Math.sqrt(50)));

    // 3. Hold rate (20 points max)
    const holdRate = wallet.gem_count > 0 ? wallet.holding_count / wallet.gem_count : 0;
    const holdRateScore = Math.round(20 * holdRate);

    // 4. Recency (20 points max) - decays over 90 days
    const daysSinceLastSeen = (Date.now() - wallet.last_seen) / (24 * 60 * 60 * 1000);
    const recencyScore = Math.max(0, Math.round(20 * Math.max(0, 1 - daysSinceLastSeen / 90)));

    const total = gemCountScore + avgPumpScore + holdRateScore + recencyScore;
    return Math.min(100, total);
  }

  // Recalculate insider wallets from copy_trades
  try {
    const db = getDb();

    // Score wallets based on copy trade performance
    const walletGroups = db.prepare(`
      SELECT wallet_address, chain,
             COUNT(*) as gem_count,
             GROUP_CONCAT(DISTINCT token_symbol) as token_symbols,
             MIN(buy_timestamp) as first_seen,
             MAX(buy_timestamp) as last_seen,
             AVG(CASE WHEN pnl_pct > 0 THEN pnl_pct / 100 + 1 ELSE 1 END) as avg_pump,
             SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as holding_count,
             COUNT(DISTINCT token_address) as unique_tokens
      FROM insider_copy_trades
      WHERE status IN ('open', 'closed')
      GROUP BY wallet_address, chain
      HAVING gem_count >= ?
    `).all(INSIDER_CONFIG.MIN_GEM_HITS) as Array<{
      wallet_address: string;
      chain: EvmChain;
      gem_count: number;
      token_symbols: string;
      first_seen: number;
      last_seen: number;
      avg_pump: number;
      holding_count: number;
      unique_tokens: number;
    }>;

    const scores: number[] = [];
    let qualifiedCount = 0;

    for (const group of walletGroups) {
      const gems = group.token_symbols ? group.token_symbols.split(",").filter(Boolean) : [];
      const score = computeWalletScore(group);
      scores.push(score);

      if (score >= WATCHER_CONFIG.MIN_WALLET_SCORE) {
        upsertInsiderWallet({
          address: group.wallet_address,
          chain: group.chain,
          gemHitCount: group.gem_count,
          gems,
          score,
          firstSeenAt: group.first_seen,
          lastSeenAt: group.last_seen,
        });
        qualifiedCount++;
      }
    }

    const deleted = deleteInsiderWalletsBelow(WATCHER_CONFIG.MIN_WALLET_SCORE);
    if (deleted > 0) {
      console.log(`[InsiderScanner] Removed ${deleted} wallets below score ${WATCHER_CONFIG.MIN_WALLET_SCORE}`);
    }

    if (scores.length > 0) {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      console.log(`[InsiderScanner] Wallet scores: min=${min}, max=${max}, avg=${avg}, count=${scores.length}`);
    }

    result.insidersFound = qualifiedCount;
  } catch (err) {
    const msg = `Error recalculating insiders: ${err}`;
    console.error(`[InsiderScanner] ${msg}`);
    result.errors.push(msg);
  }

  console.log(
    `[InsiderScanner] Scan complete: ${result.pumpedTokensFound} pumped tokens, ${result.walletsAnalyzed} wallets, ${result.insidersFound} insiders`
  );

  return result;
}


