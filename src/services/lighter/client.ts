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
let marketMaxLeverage: Map<string, number> | null = null;
let marketIndexFetchedAt = 0;
const MARKET_INDEX_TTL_MS = 60 * 60 * 1000;

// Nonce tracking (SDK auto-nonce broken)
let currentNonce = -1;
let nonceInitPromise: Promise<void> | null = null;
let nonceGeneration = 0;

// Serializes writes to prevent nonce reordering
let writeQueue: Promise<unknown> = Promise.resolve();

export function withNonce<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
  const p = writeQueue.then(async () => {
    const nonce = await getNextNonce();
    return fn(nonce);
  }, async () => {
    const nonce = await getNextNonce();
    return fn(nonce);
  });
  writeQueue = p.then(() => {}, () => {});
  return p;
}

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

export function getAccountIndex(): number {
  return storedAccountIndex;
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

interface LighterApiKey { api_key_index: number; nonce: number }
interface LighterPosition { market_id: number; symbol: string; position: string; sign: number; avg_entry_price: string; allocated_margin: string; unrealized_pnl: string }
interface LighterAccount { available_balance: string; positions: LighterPosition[] }

// Fetch nonce from server
async function fetchAndSetNonce(): Promise<void> {
  const gen = nonceGeneration;
  const api = getAccountApi();
  const resp = await withTimeout(api.apikeys(storedAccountIndex, 255), API_PRICE_TIMEOUT_MS, "Lighter nonce fetch");
  if (gen !== nonceGeneration) return; // stale fetch, discard
  const keys = (resp.data as { api_keys: LighterApiKey[] }).api_keys;
  const ourKey = keys?.find((k: LighterApiKey) => k.api_key_index === storedApiKeyIndex);
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
    marketIndexPromise = (async (): Promise<void> => {
      try {
        const api = getOrderApi();
        const resp = await withTimeout(api.orderBooks(undefined, OrderBooksFilterEnum.Perp), API_PRICE_TIMEOUT_MS, "Lighter orderBooks");
        const books: OrderBook[] = resp.data.order_books;

        const newIndexMap = new Map<string, number>();
        const newSizeDecimals = new Map<number, number>();
        const newPriceDecimals = new Map<number, number>();
        const newMaxLeverage = new Map<string, number>();

        for (const book of books) {
          const base = book.symbol.split("_")[0];
          if (base) {
            newIndexMap.set(base, book.market_id);
            newSizeDecimals.set(book.market_id, book.supported_size_decimals);
            newPriceDecimals.set(book.market_id, book.supported_price_decimals);
          }
        }

        // Fetch max leverage from orderBookDetails
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const detailResp = await withTimeout(api.orderBookDetails(undefined, "perp" as any), API_PRICE_TIMEOUT_MS, "Lighter orderBookDetails");
          for (const d of detailResp.data.order_book_details ?? []) {
            const base = d.symbol.split("_")[0];
            if (base && d.min_initial_margin_fraction > 0) {
              newMaxLeverage.set(base, Math.floor(10000 / d.min_initial_margin_fraction));
            }
          }
        } catch { /* non-fatal, leverage will use requested value */ }

        // Atomic swap
        marketIndexMap = newIndexMap;
        marketSizeDecimals = newSizeDecimals;
        marketPriceDecimals = newPriceDecimals;
        marketMaxLeverage = newMaxLeverage;
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

export async function getLighterMaxLeverage(pair: string): Promise<number> {
  await refreshMarketIndex();
  return marketMaxLeverage?.get(pair) ?? 100;
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

const midPriceCache = new Map<string, { price: number; at: number }>();
const midPricePending = new Map<string, Promise<number | null>>();
const MID_PRICE_CACHE_MS = 10_000;

// On error, returns stale cached price (never null if cache exists)
export function getLighterMidPrice(pair: string, maxAgeMs = MID_PRICE_CACHE_MS): Promise<number | null> {
  const cached = midPriceCache.get(pair);
  if (cached && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.price);

  let pending = midPricePending.get(pair);
  if (!pending) {
    pending = (async (): Promise<number | null> => {
      try {
        const marketId = await getMarketIndex(pair);
        if (marketId === null) {
          console.warn(`[Lighter] No market index for ${pair}`);
          return cached?.price ?? null;
        }
        const api = getOrderApi();
        const resp = await withTimeout(api.orderBookOrders(marketId, 1), API_PRICE_TIMEOUT_MS, "Lighter orderBookOrders");
        const data = resp.data;
        if (!data.bids?.length || !data.asks?.length) {
          console.warn(`[Lighter] Empty orderbook for ${pair}`);
          return cached?.price ?? null;
        }
        const bestBid = parseFloat(data.bids[0].price);
        const bestAsk = parseFloat(data.asks[0].price);
        if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return cached?.price ?? null;
        const mid = (bestBid + bestAsk) / 2;
        midPriceCache.set(pair, { price: mid, at: Date.now() });
        return mid;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("429")) console.error(`[Lighter] Failed to fetch mid price for ${pair}: ${msg}`);
        return cached?.price ?? null;
      } finally {
        midPricePending.delete(pair);
      }
    })();
    midPricePending.set(pair, pending);
  }
  return pending;
}

// Fetch all mids with aggressive caching to avoid 429
let allMidsCache: { mids: Record<string, string>; at: number } | null = null;
const ALL_MIDS_CACHE_MS = 15_000; // 15s cache

export async function getLighterAllMids(pairs: string[]): Promise<Record<string, string>> {
  if (allMidsCache && Date.now() - allMidsCache.at < ALL_MIDS_CACHE_MS) return allMidsCache.mids;
  // Fetch sequentially with delays to avoid rate limits
  const mids: Record<string, string> = {};
  for (const pair of pairs) {
    try {
      const price = await getLighterMidPrice(pair);
      if (price !== null) mids[pair] = price.toString();
    } catch { /* skip pair */ }
    await new Promise(r => setTimeout(r, 100)); // 100ms between calls
  }
  allMidsCache = { mids, at: Date.now() };
  return mids;
}

export async function getLighterOpenPositions(): Promise<{ marketId: number; symbol: string; size: number; side: "long" | "short"; entryPrice: number; unrealizedPnlPct: number }[]> {
  const api = getAccountApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await withTimeout(api.account("index" as any, storedAccountIndex.toString()), API_PRICE_TIMEOUT_MS, "Lighter account positions");
  const account = (resp.data as { accounts: LighterAccount[] }).accounts?.[0];
  if (!account?.positions) return [];
  return account.positions
    .filter((p: LighterPosition) => parseFloat(p.position) !== 0)
    .map((p: LighterPosition) => {
      const allocMargin = parseFloat(p.allocated_margin ?? "0");
      const unrealPnl = parseFloat(p.unrealized_pnl ?? "0");
      return {
        marketId: p.market_id,
        symbol: p.symbol?.split("_")[0] ?? "",
        size: Math.abs(parseFloat(p.position)),
        side: (p.sign === 1 ? "long" : "short") as "long" | "short",
        entryPrice: parseFloat(p.avg_entry_price ?? "0"),
        unrealizedPnlPct: allocMargin > 0 ? (unrealPnl / allocMargin) * 100 : 0,
      };
    });
}

// Account equity and margin used
export async function getLighterAccountInfo(): Promise<{ equity: number; marginUsed: number }> {
  const api = getAccountApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await withTimeout(api.account("index" as any, storedAccountIndex.toString()), API_PRICE_TIMEOUT_MS, "Lighter account info");
  const account = (resp.data as { accounts: LighterAccount[] }).accounts?.[0];
  if (!account) return { equity: 0, marginUsed: 0 };
  const free = parseFloat(account.available_balance ?? "0") || 0;
  let marginUsed = 0;
  let unrealizedPnl = 0;
  for (const p of account.positions ?? []) {
    if (parseFloat(p.position) === 0) continue;
    marginUsed += parseFloat(p.allocated_margin ?? "0");
    unrealizedPnl += parseFloat(p.unrealized_pnl ?? "0");
  }
  const equity = free + marginUsed + unrealizedPnl;
  return { equity, marginUsed };
}

// Unrealized P&L per pair
export async function getLighterUnrealizedPnl(): Promise<Record<string, number>> {
  const api = getAccountApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await withTimeout(api.account("index" as any, storedAccountIndex.toString()), API_PRICE_TIMEOUT_MS, "Lighter unrealized PnL");
  const account = (resp.data as { accounts: LighterAccount[] }).accounts?.[0];
  if (!account?.positions) return {};
  const result: Record<string, number> = {};
  for (const p of account.positions) {
    if (parseFloat(p.position) === 0) continue;
    const symbol = p.symbol?.split("_")[0] ?? "";
    if (!symbol) continue;
    result[symbol] = parseFloat(p.unrealized_pnl ?? "0");
  }
  console.log(`[Lighter] Unrealized P&L for ${Object.keys(result).length}/${account.positions.length} positions: ${Object.entries(result).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ")}`);
  return result;
}
