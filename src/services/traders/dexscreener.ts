// DexScreener API - fetch trending tokens dynamically (free, no API key)
import { Chain } from "./types.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

// Map our chain names to DexScreener chain IDs
const CHAIN_IDS: Record<Chain, string> = {
  solana: "solana",
  ethereum: "ethereum",
  polygon: "polygon",
  base: "base",
  arbitrum: "arbitrum",
  bsc: "bsc",
  optimism: "optimism",
  avalanche: "avalanche",
  sonic: "sonic",
};

interface BoostedToken {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
}

interface DexScreenerPair {
  chainId: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string;
  volume: { h24: number };
  priceChange: { h24: number };
  liquidity: { usd: number };
  txns: { h24: { buys: number; sells: number } };
}

// Cache for trending tokens (refresh every 2 min)
const tokenCache = new Map<Chain, { tokens: string[]; timestamp: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000;

// Global cache for boosted tokens (same for all chains)
let boostedCache: { tokens: BoostedToken[]; timestamp: number } | null = null;
const BOOSTED_CACHE_TTL_MS = 60 * 1000; // 1 min cache

// Mutex to prevent race condition on boosted tokens fetch
let boostedFetchPromise: Promise<BoostedToken[]> | null = null;

// Rate limiting for DexScreener with proper queue (300 req/min = 5/sec)
const MIN_DEXSCREENER_INTERVAL_MS = 250;
let fetchQueue: Promise<void> = Promise.resolve();

async function rateLimitedFetch(url: string): Promise<Response> {
  // Chain onto the queue to ensure sequential execution
  const myTurn = fetchQueue.then(async () => {
    await new Promise((r) => setTimeout(r, MIN_DEXSCREENER_INTERVAL_MS));
  });
  fetchQueue = myTurn;
  await myTurn;
  return fetch(url);
}

// Fetch boosted/promoted tokens from DexScreener (cached globally with mutex)
async function getBoostedTokens(): Promise<BoostedToken[]> {
  // Return cached if fresh
  if (boostedCache && Date.now() - boostedCache.timestamp < BOOSTED_CACHE_TTL_MS) {
    return boostedCache.tokens;
  }

  // If another fetch is in progress, wait for it
  if (boostedFetchPromise) {
    return boostedFetchPromise;
  }

  // Start fetch with mutex
  boostedFetchPromise = (async () => {
    try {
      const url = `${DEXSCREENER_BASE}/token-boosts/top/v1`;
      const response = await rateLimitedFetch(url);

      if (!response.ok) {
        console.error(`[DexScreener] Boosted API error ${response.status}`);
        return boostedCache?.tokens || [];
      }

      const tokens = (await response.json()) as BoostedToken[];
      boostedCache = { tokens, timestamp: Date.now() };
      return tokens;
    } catch (err) {
      console.error("[DexScreener] Error fetching boosted:", err);
      return boostedCache?.tokens || [];
    } finally {
      boostedFetchPromise = null;
    }
  })();

  return boostedFetchPromise;
}

// Fetch trending tokens for a specific chain
export async function getTrendingTokens(chain: Chain, limit: number = 50): Promise<string[]> {
  // Check cache first
  const cached = tokenCache.get(chain);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.tokens.slice(0, limit);
  }

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return [];

  try {
    const allTokens = new Set<string>();

    // Get boosted tokens and filter by chain
    const boosted = await getBoostedTokens();
    const boostedOnChain = boosted
      .filter((t) => t.chainId === chainId)
      .map((t) => t.tokenAddress);

    for (const token of boostedOnChain) {
      allTokens.add(token);
    }

    if (boostedOnChain.length > 0) {
      console.log(`[DexScreener] Fetched ${boostedOnChain.length} boosted tokens on ${chain}`);
    }

    // Always also search for more active tokens
    const searchedTokens = await getTopPairsOnChain(chain, limit);
    for (const token of searchedTokens) {
      allTokens.add(token);
    }

    const finalTokens = Array.from(allTokens).slice(0, limit);
    if (finalTokens.length > 0) {
      tokenCache.set(chain, { tokens: finalTokens, timestamp: Date.now() });
    }

    console.log(`[DexScreener] Total ${finalTokens.length} tokens on ${chain}`);
    return finalTokens;
  } catch (err) {
    console.error(`[DexScreener] Error fetching ${chain}:`, err);
    return [];
  }
}

// Cache for latest token profiles
let profilesCache: { tokens: BoostedToken[]; timestamp: number } | null = null;
const PROFILES_CACHE_TTL_MS = 60 * 1000;
let profilesFetchPromise: Promise<BoostedToken[]> | null = null;

// Fetch latest token profiles (dynamically trending)
async function getLatestProfiles(): Promise<BoostedToken[]> {
  if (profilesCache && Date.now() - profilesCache.timestamp < PROFILES_CACHE_TTL_MS) {
    return profilesCache.tokens;
  }

  if (profilesFetchPromise) {
    return profilesFetchPromise;
  }

  profilesFetchPromise = (async () => {
    try {
      const url = `${DEXSCREENER_BASE}/token-profiles/latest/v1`;
      const response = await rateLimitedFetch(url);

      if (!response.ok) {
        console.error(`[DexScreener] Profiles API error ${response.status}`);
        return profilesCache?.tokens || [];
      }

      const tokens = (await response.json()) as BoostedToken[];
      profilesCache = { tokens, timestamp: Date.now() };
      return tokens;
    } catch (err) {
      console.error("[DexScreener] Error fetching profiles:", err);
      return profilesCache?.tokens || [];
    } finally {
      profilesFetchPromise = null;
    }
  })();

  return profilesFetchPromise;
}

// Get dynamic trending tokens
async function getTopPairsOnChain(chain: Chain, limit: number): Promise<string[]> {
  const chainId = CHAIN_IDS[chain];
  const tokens = new Set<string>();

  // Get latest token profiles (dynamic trending)
  const profiles = await getLatestProfiles();
  const profilesOnChain = profiles
    .filter((t) => t.chainId === chainId)
    .map((t) => t.tokenAddress);

  for (const token of profilesOnChain) {
    if (tokens.size >= limit) break;
    tokens.add(token);
  }

  // Fallback: search by chain name if no tokens found
  if (tokens.size === 0) {
    try {
      const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${chain}`;
      const response = await rateLimitedFetch(url);
      if (response.ok) {
        const data = (await response.json()) as { pairs?: DexScreenerPair[] };
        const pairs = (data.pairs || [])
          .filter((p) => p.chainId === chainId)
          .filter((p) => (p.volume?.h24 || 0) > 500)
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
        for (const pair of pairs) {
          if (tokens.size >= limit) break;
          tokens.add(pair.baseToken.address);
        }
      }
    } catch {
      // Ignore search errors
    }
  }

  console.log(`[DexScreener] Found ${tokens.size} active tokens on ${chain}`);
  return Array.from(tokens);
}

// Get all tokens worth checking (boosted + search)
export async function getActiveTokens(chain: Chain, limit: number = 50): Promise<string[]> {
  return getTrendingTokens(chain, limit);
}

// Search for a specific token
export async function searchToken(query: string): Promise<DexScreenerPair[]> {
  try {
    const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) return [];

    const data = (await response.json()) as { pairs?: DexScreenerPair[] };
    return data.pairs || [];
  } catch {
    return [];
  }
}

// Get token info by address
export async function getTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
  try {
    const url = `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenAddress}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) return [];

    const data = (await response.json()) as { pairs?: DexScreenerPair[] };
    return data.pairs || [];
  } catch {
    return [];
  }
}
