import { fetchWithTimeout } from "../../utils/fetch.js";

const RATE_LIMIT_MS = 1100;
let queue: Promise<void> = Promise.resolve();

const CHAINS: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon",
  optimism: "optimism",
  avalanche: "avalanche",
};

const GECKO_NETWORKS: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  optimism: "optimism",
  avalanche: "avax",
};

async function geckoTerminalPrice(chain: string, tokenAddress: string): Promise<{ priceUsd: number; liquidityUsd: number; fdv: number }> {
  const network = GECKO_NETWORKS[chain];
  if (!network || !tokenAddress) return { priceUsd: 0, liquidityUsd: 0, fdv: 0 };
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}`;
    const resp = await fetchWithTimeout(url, { timeoutMs: 10_000 });
    if (!resp.ok) return { priceUsd: 0, liquidityUsd: 0, fdv: 0 };
    const data = await resp.json() as {
      data?: {
        attributes?: {
          price_usd?: string;
          fdv_usd?: string;
          total_reserve_in_usd?: string;
        };
      };
    };
    const attrs = data?.data?.attributes;
    if (!attrs) return { priceUsd: 0, liquidityUsd: 0, fdv: 0 };
    return {
      priceUsd: parseFloat(attrs.price_usd || "0"),
      liquidityUsd: parseFloat(attrs.total_reserve_in_usd || "0"),
      fdv: parseFloat(attrs.fdv_usd || "0"),
    };
  } catch {
    return { priceUsd: 0, liquidityUsd: 0, fdv: 0 };
  }
}

export interface DexPair {
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  baseToken?: { symbol?: string; address?: string };
  chainId?: string;
  pairAddress?: string;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
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
    const resp = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (resp.ok) {
      const data = (await resp.json()) as { pairs?: DexPair[] };
      const pairs = data.pairs;
      if (Array.isArray(pairs) && pairs.length > 0) {
        const dexChain = CHAINS[chain];
        const pair = (dexChain && pairs.find((p) => p.chainId === dexChain)) || pairs[0];
        if (pair && parseFloat(pair.priceUsd || "0") > 0) return pair;
      }
    }
  } catch {
    // DexScreener failed, try fallback
  }

  // GeckoTerminal fallback
  try {
    const gecko = await geckoTerminalPrice(chain, tokenAddress);
    if (gecko.priceUsd > 0) {
      console.log(`[DexScreener] Gecko fallback ${tokenAddress.slice(0, 10)}: $${gecko.priceUsd.toFixed(8)}`);
      return {
        priceUsd: gecko.priceUsd.toString(),
        fdv: gecko.fdv,
        liquidity: { usd: gecko.liquidityUsd },
        chainId: CHAINS[chain],
      };
    }
  } catch {
    // Both sources failed
  }

  return null;
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
        const resp = await fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/${chain}/${batch.join(",")}`);
        if (!resp.ok) continue;

        const pairs = (await resp.json()) as DexPair[];
        if (!Array.isArray(pairs)) continue;

        for (const pair of pairs) {
          const raw = pair.baseToken?.address;
          const addr = raw ? raw.toLowerCase() : undefined;
          if (addr && !result.has(addr)) result.set(addr, pair);
        }
      } catch {
        continue;
      }
    }
  }

  return result;
}
