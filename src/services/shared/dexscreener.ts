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
    if (!resp.ok) return null;

    const pairs = (await resp.json()) as DexPair[];
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    return pairs[0];
  } catch {
    return null;
  }
}
