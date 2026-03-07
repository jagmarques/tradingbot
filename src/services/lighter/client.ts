import {
  Configuration,
  OrderApi,
  AccountApi,
  OrderBooksFilterEnum,
  SignerClient,
  type OrderBook,
} from "zklighter-sdk";
import { withTimeout } from "../../utils/timeout.js";
import { API_PRICE_TIMEOUT_MS } from "../../config/constants.js";

const LIGHTER_BASE_PATH = "https://mainnet.zklighter.elliot.ai";

let config: Configuration | null = null;
let signerClient: SignerClient | null = null;
let orderApi: OrderApi | null = null;
let accountApi: AccountApi | null = null;
let storedApiKeyIndex = 3;
let storedAccountIndex = 0;

let marketIndexMap: Map<string, number> | null = null;
let marketSizeDecimals: Map<number, number> | null = null;
let marketPriceDecimals: Map<number, number> | null = null;
let marketIndexFetchedAt = 0;
const MARKET_INDEX_TTL_MS = 60 * 60 * 1000;

// Nonce tracking (SDK auto-nonce broken)
let currentNonce = -1;
let nonceInitPromise: Promise<void> | null = null;
let nonceGeneration = 0;

export function initLighter(
  apiKeyIndex: number,
  privateKey: string,
  accountIndex: number,
): void {
  config = new Configuration({ basePath: LIGHTER_BASE_PATH });
  orderApi = new OrderApi(config);
  accountApi = new AccountApi(config);
  storedApiKeyIndex = apiKeyIndex;
  storedAccountIndex = accountIndex;

  signerClient = new SignerClient(
    LIGHTER_BASE_PATH,
    privateKey,
    apiKeyIndex,
    accountIndex,
  );

  console.log("[Lighter] SDK initialized");
}

export function isLighterInitialized(): boolean {
  return config !== null;
}

export function getSignerClient(): SignerClient {
  if (!signerClient) throw new Error("[Lighter] SDK not initialized");
  return signerClient;
}

export function getOrderApi(): OrderApi {
  if (!orderApi) throw new Error("[Lighter] SDK not initialized");
  return orderApi;
}

export function getAccountApi(): AccountApi {
  if (!accountApi) throw new Error("[Lighter] SDK not initialized");
  return accountApi;
}

// Fetch nonce from server
async function fetchAndSetNonce(): Promise<void> {
  const gen = nonceGeneration;
  const api = getAccountApi();
  const resp = await withTimeout(api.apikeys(storedAccountIndex, 255), API_PRICE_TIMEOUT_MS, "Lighter nonce fetch");
  if (gen !== nonceGeneration) return; // stale fetch, discard
  const keys = (resp.data as any).api_keys;
  const ourKey = keys?.find((k: any) => k.api_key_index === storedApiKeyIndex);
  if (ourKey) {
    currentNonce = ourKey.nonce + 1;
    console.log(`[Lighter] Nonce synced: next=${currentNonce}`);
  } else {
    throw new Error(`API key ${storedApiKeyIndex} not found in account ${storedAccountIndex}`);
  }
}

export function resetNonce(): void {
  currentNonce = -1;
  nonceInitPromise = null;
  nonceGeneration++;
}

// Get next nonce, fetch on first call
export async function getNextNonce(): Promise<number> {
  if (currentNonce < 0) {
    if (!nonceInitPromise) {
      nonceInitPromise = fetchAndSetNonce().catch((err) => {
        nonceInitPromise = null; // allow retry on next call
        throw err;
      });
    }
    await nonceInitPromise;
  }
  if (currentNonce < 0) {
    throw new Error("[Lighter] Nonce not initialized");
  }
  const nonce = currentNonce;
  currentNonce++;
  return nonce;
}

let marketIndexPromise: Promise<void> | null = null;

async function refreshMarketIndex(): Promise<void> {
  if (marketIndexMap && Date.now() - marketIndexFetchedAt < MARKET_INDEX_TTL_MS) {
    return;
  }

  if (!marketIndexPromise) {
    marketIndexPromise = (async () => {
      try {
        const api = getOrderApi();
        const resp = await withTimeout(api.orderBooks(undefined, OrderBooksFilterEnum.Perp), API_PRICE_TIMEOUT_MS, "Lighter orderBooks");
        const books: OrderBook[] = resp.data.order_books;

        const newIndexMap = new Map<string, number>();
        const newSizeDecimals = new Map<number, number>();
        const newPriceDecimals = new Map<number, number>();

        for (const book of books) {
          const base = book.symbol.split("_")[0];
          if (base) {
            newIndexMap.set(base, book.market_id);
            newSizeDecimals.set(book.market_id, book.supported_size_decimals);
            newPriceDecimals.set(book.market_id, book.supported_price_decimals);
          }
        }

        // Atomic swap — never leave maps empty on failure
        marketIndexMap = newIndexMap;
        marketSizeDecimals = newSizeDecimals;
        marketPriceDecimals = newPriceDecimals;
        marketIndexFetchedAt = Date.now();
        console.log(`[Lighter] Discovered ${marketIndexMap.size} perp markets`);
      } finally {
        marketIndexPromise = null;
      }
    })();
  }

  await marketIndexPromise;
}

export async function getMarketIndex(pair: string): Promise<number | null> {
  await refreshMarketIndex();
  return marketIndexMap?.get(pair) ?? null;
}

export async function getMarketSizeDecimals(marketId: number): Promise<number> {
  await refreshMarketIndex();
  return marketSizeDecimals?.get(marketId) ?? 4;
}

export async function getMarketPriceDecimals(marketId: number): Promise<number> {
  await refreshMarketIndex();
  return marketPriceDecimals?.get(marketId) ?? 2;
}

// Convert coin amount to integer base units
export function toBaseUnits(amount: number, decimals: number): number {
  return Math.round(amount * (10 ** decimals));
}

// Convert price to integer base units
export function toPriceUnits(price: number, decimals: number): number {
  return Math.round(price * (10 ** decimals));
}

export async function getLighterMidPrice(pair: string): Promise<number | null> {
  try {
    const marketId = await getMarketIndex(pair);
    if (marketId === null) {
      console.warn(`[Lighter] No market index for ${pair}`);
      return null;
    }

    const api = getOrderApi();
    const resp = await withTimeout(api.orderBookOrders(marketId, 1), API_PRICE_TIMEOUT_MS, "Lighter orderBookOrders");
    const data = resp.data;

    if (!data.bids || data.bids.length === 0 || !data.asks || data.asks.length === 0) {
      console.warn(`[Lighter] Empty orderbook for ${pair}`);
      return null;
    }

    const bestBid = parseFloat(data.bids[0].price);
    const bestAsk = parseFloat(data.asks[0].price);

    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      return null;
    }

    return (bestBid + bestAsk) / 2;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Lighter] Failed to fetch mid price for ${pair}: ${msg}`);
    return null;
  }
}

export async function getLighterAllMids(pairs: string[]): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  const settled = await Promise.allSettled(
    pairs.map(async (pair) => {
      const price = await getLighterMidPrice(pair);
      if (price !== null) {
        results[pair] = price.toString();
      }
    }),
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      console.error(`[Lighter] Mid price fetch rejected: ${result.reason}`);
    }
  }

  return results;
}

export async function getLighterOpenPositions(): Promise<{ marketId: number; symbol: string; size: number; side: "long" | "short" }[]> {
  const api = getAccountApi();
  const resp = await withTimeout(
    api.account("index" as any, storedAccountIndex.toString()),
    API_PRICE_TIMEOUT_MS, "Lighter account positions",
  );
  const account = (resp.data as any).accounts?.[0];
  if (!account?.positions) return [];
  return account.positions
    .filter((p: any) => parseFloat(p.position) !== 0)
    .map((p: any) => ({
      marketId: p.market_id,
      symbol: p.symbol?.split("_")[0] ?? "",
      size: Math.abs(parseFloat(p.position)),
      side: (p.sign === 1 ? "long" : "short") as "long" | "short",
    }));
}

// Account equity and margin used
export async function getLighterAccountInfo(): Promise<{ equity: number; marginUsed: number }> {
  const api = getAccountApi();
  const resp = await withTimeout(
    api.account("index" as any, storedAccountIndex.toString()),
    API_PRICE_TIMEOUT_MS, "Lighter account info",
  );
  const account = (resp.data as any).accounts?.[0];
  if (!account) return { equity: 0, marginUsed: 0 };
  const equity = parseFloat(account.total_asset_value ?? "0");
  const free = parseFloat(account.available_balance ?? "0");
  return { equity, marginUsed: equity - free };
}

// Unrealized P&L per pair
export async function getLighterUnrealizedPnl(): Promise<Record<string, number>> {
  const api = getAccountApi();
  const resp = await withTimeout(
    api.account("index" as any, storedAccountIndex.toString()),
    API_PRICE_TIMEOUT_MS, "Lighter unrealized PnL",
  );
  const account = (resp.data as any).accounts?.[0];
  if (!account?.positions) return {};
  const result: Record<string, number> = {};
  for (const p of account.positions) {
    if (parseFloat(p.position) === 0) continue;
    const symbol = p.symbol?.split("_")[0] ?? "";
    result[symbol] = parseFloat(p.unrealized_pnl ?? "0");
  }
  return result;
}
