// DexScreener API - fetch trending tokens dynamically (free, no API key)
import { Chain } from "./types.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

// Map our chain names to DexScreener chain IDs
const CHAIN_IDS: Record<Chain, string> = {
  solana: "solana",
  ethereum: "ethereum",
  polygon: "polygon",
  base: "base",
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

// Cache for trending tokens (refresh every 30 min)
const tokenCache = new Map<Chain, { tokens: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

// Fetch boosted/promoted tokens from DexScreener
async function getBoostedTokens(): Promise<BoostedToken[]> {
  try {
    const url = `${DEXSCREENER_BASE}/token-boosts/top/v1`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[DexScreener] Boosted API error ${response.status}`);
      return [];
    }

    return (await response.json()) as BoostedToken[];
  } catch (err) {
    console.error("[DexScreener] Error fetching boosted:", err);
    return [];
  }
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
    // Get boosted tokens and filter by chain
    const boosted = await getBoostedTokens();
    const chainTokens = boosted
      .filter((t) => t.chainId === chainId)
      .map((t) => t.tokenAddress)
      .slice(0, limit);

    if (chainTokens.length > 0) {
      tokenCache.set(chain, { tokens: chainTokens, timestamp: Date.now() });
      console.log(`[DexScreener] Fetched ${chainTokens.length} boosted tokens on ${chain}`);
      return chainTokens;
    }

    // Fallback: get top pairs on chain
    const fallbackTokens = await getTopPairsOnChain(chain, limit);
    if (fallbackTokens.length > 0) {
      tokenCache.set(chain, { tokens: fallbackTokens, timestamp: Date.now() });
    }
    return fallbackTokens;
  } catch (err) {
    console.error(`[DexScreener] Error fetching ${chain}:`, err);
    return [];
  }
}

// Get top pairs on a chain by volume
async function getTopPairsOnChain(chain: Chain, limit: number): Promise<string[]> {
  const chainId = CHAIN_IDS[chain];
  const tokens = new Set<string>();

  try {
    // Use pairs endpoint to get active pairs on chain
    const url = `${DEXSCREENER_BASE}/latest/dex/pairs/${chainId}`;
    const response = await fetch(url);

    if (response.ok) {
      const data = (await response.json()) as { pairs?: DexScreenerPair[] };
      const pairs = data.pairs || [];

      // Sort by volume and filter by activity
      const activePairs = pairs
        .filter((p) => (p.volume?.h24 || 0) > 1000 && (p.liquidity?.usd || 0) > 1000)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));

      for (const pair of activePairs) {
        if (tokens.size >= limit) break;
        tokens.add(pair.baseToken.address);
      }
    }
  } catch {
    // Fallback: try search with generic term
    try {
      const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${chainId}`;
      const response = await fetch(url);

      if (response.ok) {
        const data = (await response.json()) as { pairs?: DexScreenerPair[] };
        const pairs = (data.pairs || []).filter((p) => p.chainId === chainId);

        for (const pair of pairs) {
          if (tokens.size >= limit) break;
          if ((pair.volume?.h24 || 0) > 1000) {
            tokens.add(pair.baseToken.address);
          }
        }
      }
    } catch {
      // Silent fail
    }
  }

  console.log(`[DexScreener] Found ${tokens.size} active tokens on ${chain}`);
  return Array.from(tokens);
}

// Get all tokens worth checking (boosted + search)
export async function getActiveTokens(chain: Chain, limit: number = 25): Promise<string[]> {
  return getTrendingTokens(chain, limit);
}

// Search for a specific token
export async function searchToken(query: string): Promise<DexScreenerPair[]> {
  try {
    const url = `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);

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
    const response = await fetch(url);

    if (!response.ok) return [];

    const data = (await response.json()) as { pairs?: DexScreenerPair[] };
    return data.pairs || [];
  } catch {
    return [];
  }
}
