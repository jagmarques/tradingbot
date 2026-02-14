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
  chainId?: string;
}

export async function dexScreenerFetch(chain: string, tokenAddress: string): Promise<DexPair | null> {
  if (!tokenAddress) return null;

  // Queue to enforce rate limit across all callers
  const myTurn = dexFetchQueue.then(() =>
    new Promise<void>((r) => setTimeout(r, DEXSCREENER_INTERVAL_MS))
  );
  dexFetchQueue = myTurn;
  await myTurn;

  try {
    // Use chain-agnostic endpoint - works for any token address across all chains
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as { pairs?: DexPair[] };
    const pairs = data.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // Prefer pair matching the expected chain, otherwise take highest liquidity
    const dexChain = DEXSCREENER_CHAINS[chain];
    const chainMatch = dexChain ? pairs.find((p) => p.chainId === dexChain) : null;
    return chainMatch || pairs[0];
  } catch {
    return null;
  }
}
