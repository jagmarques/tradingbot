import type { EvmChain, PumpedToken, GemHit, InsiderScanResult } from "./types.js";
import { INSIDER_CONFIG } from "./types.js";
import { upsertGemHit, upsertInsiderWallet } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES } from "./types.js";

// GeckoTerminal API
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK_IDS: Record<EvmChain, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
};

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Chain IDs for Etherscan V2
const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
};

// Zero address
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// GeckoTerminal free tier: 30 req/min = 2s between requests
const GECKO_INTERVAL_MS = 2000;
let geckoFetchQueue: Promise<void> = Promise.resolve();

async function geckoRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = geckoFetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, GECKO_INTERVAL_MS));
  });
  geckoFetchQueue = myTurn;
  await myTurn;
  return fetch(url);
}

// Rate limiting for Etherscan (220ms between requests, per chain)
const ETHERSCAN_INTERVAL_MS = 220;
const etherscanQueueByChain = new Map<string, Promise<void>>();

async function etherscanRateLimitedFetch(url: string, chain: string): Promise<Response> {
  const currentQueue = etherscanQueueByChain.get(chain) || Promise.resolve();
  const myTurn = currentQueue.then(async () => {
    await new Promise((r) => setTimeout(r, ETHERSCAN_INTERVAL_MS));
  });
  etherscanQueueByChain.set(chain, myTurn);
  await myTurn;
  return fetch(url);
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
export async function findPumpedTokens(chain: EvmChain): Promise<PumpedToken[]> {
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
      if (h24Change < 200 || volumeH24 < 5000 || liquidity < 2000) continue;

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
      `[InsiderScanner] ${chain}: ${pumped.length} trending tokens passed filters (>=200% change, >=$5k vol, >=$2k liq)`
    );
  } catch (err) {
    console.error(`[InsiderScanner] GeckoTerminal error for ${chain}:`, err);
  }

  return pumped;
}

// Find wallets that bought a token early (within first 50-100 transfers)
export async function findEarlyBuyers(token: PumpedToken): Promise<string[]> {
  const chainId = ETHERSCAN_CHAIN_IDS[token.chain];
  const apiKey = process.env.ETHERSCAN_API_KEY || "";

  const url = `${ETHERSCAN_V2_URL}?chainid=${chainId}&module=account&action=tokentx&contractaddress=${token.tokenAddress}&startblock=0&endblock=99999999&sort=asc${apiKey ? `&apikey=${apiKey}` : ""}`;

  try {
    const response = await etherscanRateLimitedFetch(url, token.chain);
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

// Main scan orchestrator
export async function runInsiderScan(): Promise<InsiderScanResult> {
  const result: InsiderScanResult = {
    pumpedTokensFound: 0,
    walletsAnalyzed: 0,
    insidersFound: 0,
    errors: [],
  };

  for (const chain of INSIDER_CONFIG.SCAN_CHAINS) {
    try {
      // Find pumped tokens
      const pumpedTokens = await findPumpedTokens(chain);
      result.pumpedTokensFound += pumpedTokens.length;

      // For each pumped token, find early buyers
      for (const token of pumpedTokens) {
        try {
          const earlyBuyers = await findEarlyBuyers(token);
          result.walletsAnalyzed += earlyBuyers.length;

          // Store each (wallet, token) pair as a GemHit
          for (const buyer of earlyBuyers) {
            const hit: GemHit = {
              walletAddress: buyer,
              chain,
              tokenAddress: token.tokenAddress,
              tokenSymbol: token.symbol,
              buyTxHash: "", // Not tracked individually
              buyTimestamp: token.discoveredAt,
              buyBlockNumber: 0,
              pumpMultiple: token.priceChangeH24 / 100 + 1, // Convert % to multiple
            };
            upsertGemHit(hit);
          }

          // 2s delay between tokens to respect free tier rate limits
          await new Promise((r) => setTimeout(r, 2000));
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
      continue;
    }
  }

  // Recalculate insider wallets from gem_hits
  try {
    const db = getDb();

    const walletGroups = db.prepare(`
      SELECT wallet_address, chain, COUNT(*) as gem_count,
             GROUP_CONCAT(DISTINCT token_symbol) as token_symbols,
             MIN(buy_timestamp) as first_seen,
             MAX(buy_timestamp) as last_seen
      FROM insider_gem_hits
      GROUP BY wallet_address, chain
      HAVING gem_count >= ?
    `).all(INSIDER_CONFIG.MIN_GEM_HITS) as Array<{
      wallet_address: string;
      chain: EvmChain;
      gem_count: number;
      token_symbols: string;
      first_seen: number;
      last_seen: number;
    }>;

    for (const group of walletGroups) {
      const gems = group.token_symbols.split(",").filter(Boolean);
      upsertInsiderWallet({
        address: group.wallet_address,
        chain: group.chain,
        gemHitCount: group.gem_count,
        gems,
        score: group.gem_count * 10, // Simple scoring
        firstSeenAt: group.first_seen,
        lastSeenAt: group.last_seen,
      });
    }

    result.insidersFound = walletGroups.length;
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
