// Shared DexScreener rate limiter (60 req/min)
const DEXSCREENER_INTERVAL_MS = 1100; // ~55 req/min with safety margin
let dexFetchQueue: Promise<void> = Promise.resolve();

export const DEXSCREENER_CHAINS: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon",
  optimism: "optimism",
};

// GeckoTerminal network IDs for fallback
const GECKO_NETWORK_IDS: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
};

interface DexPair {
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  baseToken?: { symbol?: string };
}

export async function dexScreenerFetch(chain: string, tokenAddress: string): Promise<DexPair | null> {
  const dexChain = DEXSCREENER_CHAINS[chain];
  if (!dexChain || !tokenAddress) return null;

  // Queue to enforce rate limit across all callers
  const myTurn = dexFetchQueue.then(() =>
    new Promise<void>((r) => setTimeout(r, DEXSCREENER_INTERVAL_MS))
  );
  dexFetchQueue = myTurn;
  await myTurn;

  try {
    const resp = await fetch(`https://api.dexscreener.com/tokens/v1/${dexChain}/${tokenAddress}`);
    if (resp.ok) {
      const pairs = (await resp.json()) as DexPair[];
      if (Array.isArray(pairs) && pairs.length > 0) {
        return pairs[0];
      }
    }
  } catch {
    // DexScreener failed, fall through to GeckoTerminal
  }

  // Fallback to GeckoTerminal when DexScreener returns no data
  const geckoNetwork = GECKO_NETWORK_IDS[chain];
  if (!geckoNetwork) return null;

  try {
    // Small delay to be respectful to GeckoTerminal
    await new Promise<void>((r) => setTimeout(r, 500));

    console.log(`[DexScreener] Fallback to GeckoTerminal for ${chain}/${tokenAddress.slice(0, 10)}...`);
    const geckoResp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/tokens/${tokenAddress}`
    );
    if (!geckoResp.ok) return null;

    const geckoData = (await geckoResp.json()) as {
      data?: {
        attributes?: {
          price_usd?: string;
          fdv_usd?: string;
          symbol?: string;
        };
      };
    };

    const attrs = geckoData.data?.attributes;
    if (!attrs?.price_usd) return null;

    return {
      priceUsd: attrs.price_usd,
      fdv: attrs.fdv_usd ? parseFloat(attrs.fdv_usd) : undefined,
      liquidity: undefined,
      baseToken: attrs.symbol ? { symbol: attrs.symbol } : undefined,
    };
  } catch {
    return null;
  }
}
