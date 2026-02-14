const RATE_LIMIT_MS = 1100;
let queue: Promise<void> = Promise.resolve();

const CHAINS: Record<string, string> = {
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

function enqueue(): Promise<void> {
  const myTurn = queue.then(() => new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MS)));
  queue = myTurn;
  return myTurn;
}

export async function dexScreenerFetch(chain: string, tokenAddress: string): Promise<DexPair | null> {
  if (!tokenAddress) return null;
  await enqueue();

  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as { pairs?: DexPair[] };
    const pairs = data.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    const dexChain = CHAINS[chain];
    return (dexChain && pairs.find((p) => p.chainId === dexChain)) || pairs[0];
  } catch {
    return null;
  }
}

const BATCH_SIZE = 30;

export async function dexScreenerFetchBatch(
  tokens: Array<{ chain: string; tokenAddress: string }>
): Promise<Map<string, DexPair>> {
  const result = new Map<string, DexPair>();
  if (tokens.length === 0) return result;

  const byChain = new Map<string, string[]>();
  for (const t of tokens) {
    const dexChain = CHAINS[t.chain];
    if (!dexChain) continue;
    const list = byChain.get(dexChain) || [];
    list.push(t.tokenAddress);
    byChain.set(dexChain, list);
  }

  let calls = 0;
  for (const [, addrs] of byChain) calls += Math.ceil(addrs.length / BATCH_SIZE);
  console.log(`[DexScreener] Batch: ${tokens.length} tokens, ${calls} calls`);

  for (const [chain, addresses] of byChain) {
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const batch = addresses.slice(i, i + BATCH_SIZE);
      await enqueue();

      try {
        const resp = await fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${batch.join(",")}`);
        if (!resp.ok) continue;

        const pairs = (await resp.json()) as DexPair[];
        if (!Array.isArray(pairs)) continue;

        for (const pair of pairs) {
          const addr = pair.baseToken?.address?.toLowerCase();
          if (addr && !result.has(addr)) result.set(addr, pair);
        }
      } catch {
        continue;
      }
    }
  }

  return result;
}
