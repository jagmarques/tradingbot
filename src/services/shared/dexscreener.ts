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

export interface DexPair {
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  baseToken?: { symbol?: string; address?: string };
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

const BATCH_SIZE = 30; // DexScreener limit per multi-token request

export async function dexScreenerFetchBatch(
  tokens: Array<{ chain: string; tokenAddress: string }>
): Promise<Map<string, DexPair>> {
  const result = new Map<string, DexPair>();
  if (tokens.length === 0) return result;

  // Build lookup: lowercase address -> expected chain
  const chainByAddress = new Map<string, string>();
  for (const t of tokens) {
    chainByAddress.set(t.tokenAddress.toLowerCase(), t.chain);
  }

  // Chunk into batches of 30
  const batches: Array<Array<{ chain: string; tokenAddress: string }>> = [];
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    batches.push(tokens.slice(i, i + BATCH_SIZE));
  }

  console.log(`[DexScreener] Batch fetching ${tokens.length} tokens in ${batches.length} calls`);

  for (const batch of batches) {
    // Queue to enforce rate limit (same pattern as single fetch)
    const myTurn = dexFetchQueue.then(() =>
      new Promise<void>((r) => setTimeout(r, DEXSCREENER_INTERVAL_MS))
    );
    dexFetchQueue = myTurn;
    await myTurn;

    try {
      const addresses = batch.map((t) => t.tokenAddress).join(",");
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
      if (!resp.ok) continue;

      const data = (await resp.json()) as { pairs?: DexPair[] };
      const pairs = data.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) continue;

      // Group pairs by base token address
      const pairsByToken = new Map<string, DexPair[]>();
      for (const pair of pairs) {
        const addr = pair.baseToken?.address?.toLowerCase();
        if (!addr) continue;
        const existing = pairsByToken.get(addr) || [];
        existing.push(pair);
        pairsByToken.set(addr, existing);
      }

      // For each token, prefer chain-matched pair (same logic as single fetch)
      for (const [addr, tokenPairs] of pairsByToken) {
        if (result.has(addr)) continue; // already found in earlier batch
        const expectedChain = chainByAddress.get(addr);
        const dexChain = expectedChain ? DEXSCREENER_CHAINS[expectedChain] : null;
        const chainMatch = dexChain ? tokenPairs.find((p) => p.chainId === dexChain) : null;
        result.set(addr, chainMatch || tokenPairs[0]);
      }
    } catch (err) {
      console.error(`[DexScreener] Batch fetch error:`, err);
      continue;
    }
  }

  return result;
}
