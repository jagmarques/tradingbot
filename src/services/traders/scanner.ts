import type { EvmChain, PumpedToken, GemHit, InsiderScanResult } from "./types.js";
import { INSIDER_CONFIG } from "./types.js";
import { upsertGemHit, upsertInsiderWallet } from "./storage.js";
import { getDb } from "../database/db.js";
import { KNOWN_EXCHANGES } from "./types.js";

// DexScreener API
const DEXSCREENER_BASE = "https://api.dexscreener.com";

// Etherscan V2 API
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

// Chain IDs for Etherscan V2
const ETHERSCAN_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
};

// DexScreener chain IDs
const DEXSCREENER_CHAIN_IDS: Record<EvmChain, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
};

// Search terms per chain
const CHAIN_SEARCH_TERMS: Record<EvmChain, string[]> = {
  ethereum: ["pepe", "shib", "mog", "wojak", "turbo", "floki"],
  base: ["brett", "degen", "toshi", "normie", "mfer", "higher"],
  arbitrum: ["arb", "gmx", "pendle", "magic", "grail", "jones"],
};

// Zero address
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Rate limiting for DexScreener (250ms between requests)
const DEXSCREENER_INTERVAL_MS = 250;
let dexFetchQueue: Promise<void> = Promise.resolve();

async function dexRateLimitedFetch(url: string): Promise<Response> {
  const myTurn = dexFetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, DEXSCREENER_INTERVAL_MS));
  });
  dexFetchQueue = myTurn;
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

interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  priceUsd: string;
  volume: { h24: number };
  priceChange: { h24: number };
  liquidity: { usd: number };
}

// Find tokens that pumped 3x+ in 24h on a given chain
export async function findPumpedTokens(chain: EvmChain): Promise<PumpedToken[]> {
  const chainId = DEXSCREENER_CHAIN_IDS[chain];
  const terms = CHAIN_SEARCH_TERMS[chain];
  const seen = new Set<string>();
  const pumped: PumpedToken[] = [];

  console.log(`[InsiderScanner] Searching ${chain} with ${terms.length} terms...`);

  for (const term of terms) {
    if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;

    try {
      const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(term)}`;
      const response = await dexRateLimitedFetch(url);
      if (!response.ok) continue;

      const data = (await response.json()) as { pairs?: DexScreenerPair[] };
      const totalPairs = data.pairs?.length || 0;
      const pairs = (data.pairs || []).filter(
        (p) =>
          p.chainId === chainId &&
          (p.priceChange?.h24 || 0) >= 200 && // 3x = 200% increase
          (p.volume?.h24 || 0) >= 5000 &&
          (p.liquidity?.usd || 0) >= 2000
      );
      const filteredPairs = pairs.length;

      console.log(
        `[InsiderScanner] ${chain}/${term}: ${totalPairs} pairs returned, ${filteredPairs} passed filters (>=200% change, >=$5k vol, >=$2k liq)`
      );

      for (const pair of pairs) {
        const addr = pair.baseToken.address.toLowerCase();
        if (seen.has(addr)) continue;
        seen.add(addr);

        pumped.push({
          tokenAddress: addr,
          chain,
          symbol: pair.baseToken.symbol,
          pairAddress: pair.pairAddress,
          priceChangeH24: pair.priceChange.h24,
          volumeH24: pair.volume.h24,
          liquidity: pair.liquidity.usd,
          discoveredAt: Date.now(),
        });

        if (pumped.length >= INSIDER_CONFIG.MAX_TOKENS_PER_SCAN) break;
      }
    } catch (err) {
      console.error(`[InsiderScanner] DexScreener search error for "${term}" on ${chain}:`, err);
      continue;
    }
  }

  console.log(`[InsiderScanner] ${chain}: ${pumped.length} pumped tokens found from ${terms.length} search terms`);
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
