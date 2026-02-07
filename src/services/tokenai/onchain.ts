import type { OnchainSignal, SupportedChain } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// CoinGecko platform ID mapping for EVM chains
const COINGECKO_PLATFORM_IDS: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  bnb: "binance-smart-chain",
  arbitrum: "arbitrum-one",
  avalanche: "avalanche",
};

// In-memory cache to avoid hammering free-tier APIs
const onchainCache = new Map<
  string,
  { data: OnchainSignal; expiresAt: number }
>();

/** Clear cache (exposed for testing) */
export function clearOnchainCache(): void {
  onchainCache.clear();
}

/**
 * Collect on-chain signals for a token.
 * Routes Solana tokens to Birdeye, EVM tokens to CoinGecko.
 * Returns null on complete failure (never throws).
 */
export async function collectOnchainSignals(
  tokenAddress: string,
  chain: SupportedChain,
): Promise<OnchainSignal | null> {
  const cacheKey = `${chain}:${tokenAddress}`;
  const cached = onchainCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[TokenOnchain] Cache hit for ${tokenAddress} on ${chain}`,
    );
    return cached.data;
  }

  try {
    let result: OnchainSignal | null = null;

    if (chain === "solana") {
      result = await fetchBirdeyeOnchain(tokenAddress);
    } else {
      result = await fetchCoinGeckoOnchain(tokenAddress, chain);
    }

    if (result) {
      onchainCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    return result;
  } catch (error) {
    console.warn(
      `[TokenOnchain] Unexpected error for ${tokenAddress} on ${chain}:`,
      error,
    );
    return null;
  }
}

/**
 * Fetch on-chain data from Birdeye (Solana tokens).
 * Uses optional BIRDEYE_API_KEY env var, falls back to "public" key.
 */
async function fetchBirdeyeOnchain(
  tokenAddress: string,
): Promise<OnchainSignal | null> {
  try {
    const apiKey = process.env.BIRDEYE_API_KEY || "public";
    const url = `https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "X-API-KEY": apiKey },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenOnchain] Birdeye HTTP ${response.status} for ${tokenAddress}`,
      );
      return null;
    }

    const json = (await response.json()) as {
      data?: {
        holder?: number;
        v24hUSD?: number;
        liquidity?: number;
        mc?: number;
        priceChange24hPercent?: number;
        top10HolderPercent?: number;
        [key: string]: unknown;
      };
    };

    const data = json.data;
    if (!data) {
      console.warn(
        `[TokenOnchain] Birdeye: no data for ${tokenAddress}`,
      );
      return null;
    }

    return {
      holderCount: data.holder ?? 0,
      whalePercentage: data.top10HolderPercent ?? 0,
      liquidityUsd: data.liquidity ?? 0,
      volume24hUsd: data.v24hUSD ?? 0,
      priceChangePercent24h: data.priceChange24hPercent ?? 0,
      marketCapUsd: data.mc ?? 0,
      provider: "birdeye",
      raw: (data as Record<string, unknown>) ?? {},
    };
  } catch (error) {
    console.warn(`[TokenOnchain] Birdeye fetch failed:`, error);
    return null;
  }
}

/**
 * Fetch on-chain data from CoinGecko (EVM tokens).
 * Free tier, no API key needed (10-30 calls/min).
 */
async function fetchCoinGeckoOnchain(
  tokenAddress: string,
  chain: SupportedChain,
): Promise<OnchainSignal | null> {
  try {
    const platformId = COINGECKO_PLATFORM_IDS[chain];
    if (!platformId) {
      console.warn(
        `[TokenOnchain] Unsupported chain for CoinGecko: ${chain}`,
      );
      return null;
    }

    const url = `https://api.coingecko.com/api/v3/coins/${platformId}/contract/${tokenAddress}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(
        `[TokenOnchain] CoinGecko HTTP ${response.status} for ${tokenAddress}`,
      );
      return null;
    }

    const json = (await response.json()) as {
      market_data?: {
        total_volume?: { usd?: number };
        market_cap?: { usd?: number };
        price_change_percentage_24h?: number;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };

    const marketData = json.market_data;
    const volume = marketData?.total_volume?.usd ?? 0;
    const marketCap = marketData?.market_cap?.usd ?? 0;
    const priceChange = marketData?.price_change_percentage_24h ?? 0;

    // CoinGecko does not provide holder count or whale percentage for most tokens
    const holderCount = 0;
    const whalePercentage = 0;

    // CoinGecko does not provide direct liquidity data
    // TODO: Replace with proper DEX liquidity lookup (e.g., Uniswap subgraph)
    const liquidityUsd = volume * 0.1;

    return {
      holderCount,
      whalePercentage,
      liquidityUsd,
      volume24hUsd: volume,
      priceChangePercent24h: priceChange,
      marketCapUsd: marketCap,
      provider: "coingecko",
      raw: (json as Record<string, unknown>) ?? {},
    };
  } catch (error) {
    console.warn(`[TokenOnchain] CoinGecko fetch failed:`, error);
    return null;
  }
}
