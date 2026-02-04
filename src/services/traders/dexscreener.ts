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
  boostedFetchPromise = (async (): Promise<BoostedToken[]> => {
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

  profilesFetchPromise = (async (): Promise<BoostedToken[]> => {
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

// Search terms for each chain (DexScreener APIs mostly return Solana)
const CHAIN_TERMS: Record<string, string[]> = {
  ethereum: ["pepe", "shib", "uni", "link", "aave"],
  polygon: ["matic", "quick", "aave"],
  arbitrum: ["arb", "gmx", "magic"],
  sonic: ["sonic"],
  base: ["brett", "degen"],
  bsc: ["cake", "bnb"],
};

// Get trending tokens via search (boosted/profiles APIs don't cover EVM chains)
async function getTopPairsOnChain(chain: Chain, limit: number): Promise<string[]> {
  const chainId = CHAIN_IDS[chain];
  const tokens = new Set<string>();

  // Get from profiles first (works for Solana mostly)
  const profiles = await getLatestProfiles();
  for (const t of profiles.filter((p) => p.chainId === chainId)) {
    if (tokens.size >= limit) break;
    tokens.add(t.tokenAddress);
  }

  // Search for popular tokens on this chain
  const terms = CHAIN_TERMS[chain] || [chain];
  for (const term of terms) {
    if (tokens.size >= limit) break;
    try {
      const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${term}`;
      const response = await rateLimitedFetch(url);
      if (!response.ok) continue;
      const data = (await response.json()) as { pairs?: DexScreenerPair[] };
      const pairs = (data.pairs || [])
        .filter((p) => p.chainId === chainId && (p.volume?.h24 || 0) > 500)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
      for (const pair of pairs) {
        if (tokens.size >= limit) break;
        tokens.add(pair.baseToken.address);
      }
    } catch {
      continue;
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

// Cache for new pairs per chain
const newPairsCache = new Map<Chain, { tokens: string[]; timestamp: number }>();
const NEW_PAIRS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

// Get newly created pairs (recent token launches) using search as fallback
// Note: DexScreener doesn't have a direct "new pairs by chain" endpoint
export async function getNewPairs(chain: Chain, limit: number = 30): Promise<string[]> {
  const cached = newPairsCache.get(chain);
  if (cached && Date.now() - cached.timestamp < NEW_PAIRS_CACHE_TTL_MS) {
    return cached.tokens.slice(0, limit);
  }

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return [];

  try {
    // Use token-profiles/latest which has newly listed tokens
    const url = `${DEXSCREENER_BASE}/token-profiles/latest/v1`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      // Silently return cached/empty - this endpoint may not always work
      return cached?.tokens || [];
    }

    const data = (await response.json()) as Array<{ chainId: string; tokenAddress: string }>;

    // Filter for our chain
    const tokens = data
      .filter((t) => t.chainId === chainId)
      .map((t) => t.tokenAddress)
      .slice(0, limit);

    if (tokens.length > 0) {
      newPairsCache.set(chain, { tokens, timestamp: Date.now() });
      console.log(`[DexScreener] Found ${tokens.length} new tokens on ${chain}`);
    }

    return tokens;
  } catch {
    // Silently fail - this is a nice-to-have feature
    return cached?.tokens || [];
  }
}

// Cache for high-volume tokens
const volumeCache = new Map<Chain, { tokens: string[]; timestamp: number }>();
const VOLUME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min cache

// Get high-volume tokens (not necessarily trending)
export async function getHighVolumeTokens(chain: Chain, minVolumeUsd: number = 50000, limit: number = 30): Promise<string[]> {
  const cached = volumeCache.get(chain);
  if (cached && Date.now() - cached.timestamp < VOLUME_CACHE_TTL_MS) {
    return cached.tokens.slice(0, limit);
  }

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return [];

  try {
    // Search broadly to find high-volume pairs
    const searchTerms = ["", "a", "e", "i", "o", "u"]; // Common letters to get variety
    const allPairs: DexScreenerPair[] = [];

    for (const term of searchTerms.slice(0, 3)) { // Limit API calls
      const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${term || "token"}`;
      const response = await rateLimitedFetch(url);
      if (!response.ok) continue;

      const data = (await response.json()) as { pairs?: DexScreenerPair[] };
      const chainPairs = (data.pairs || []).filter((p) => p.chainId === chainId);
      allPairs.push(...chainPairs);
    }

    // Dedupe and filter by volume
    const tokenVolumes = new Map<string, number>();
    for (const pair of allPairs) {
      const addr = pair.baseToken.address;
      const vol = pair.volume?.h24 || 0;
      if (vol >= minVolumeUsd) {
        tokenVolumes.set(addr, Math.max(tokenVolumes.get(addr) || 0, vol));
      }
    }

    // Sort by volume and return top
    const tokens = Array.from(tokenVolumes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([addr]) => addr);

    if (tokens.length > 0) {
      volumeCache.set(chain, { tokens, timestamp: Date.now() });
      console.log(`[DexScreener] Found ${tokens.length} high-volume tokens on ${chain} (>$${minVolumeUsd})`);
    }

    return tokens;
  } catch (err) {
    console.error(`[DexScreener] Error fetching high-volume on ${chain}:`, err);
    return cached?.tokens || [];
  }
}

// Get ALL tokens worth checking (trending + new launches + high volume)
export async function getAllActiveTokens(chain: Chain, limit: number = 100): Promise<string[]> {
  const allTokens = new Set<string>();

  // 1. Trending/boosted tokens
  const trending = await getTrendingTokens(chain, 30);
  for (const t of trending) allTokens.add(t);

  // 2. New token launches (hidden gems)
  const newPairs = await getNewPairs(chain, 30);
  for (const t of newPairs) allTokens.add(t);

  // 3. High-volume non-trending
  const highVolume = await getHighVolumeTokens(chain, 50000, 30);
  for (const t of highVolume) allTokens.add(t);

  const result = Array.from(allTokens).slice(0, limit);
  console.log(`[DexScreener] Total ${result.length} unique tokens on ${chain} (trending + new + high-vol)`);
  return result;
}
