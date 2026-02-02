import * as binance from "./binance.js";
import * as coinbase from "./coinbase.js";

type PriceCallback = (symbol: string, price: number, source: "binance" | "coinbase") => void;

type PriceSource = "binance" | "coinbase";

interface PriceEntry {
  price: number;
  source: PriceSource;
  timestamp: number;
}

const STALE_THRESHOLD_MS = 30_000; // 30 seconds
const FAILOVER_CHECK_INTERVAL_MS = 5_000; // 5 seconds

let primarySource: PriceSource = "binance";
let failoverActive = false;
let failoverCheckInterval: NodeJS.Timeout | null = null;

const prices: Map<string, PriceEntry> = new Map();
const priceCallbacks: Set<PriceCallback> = new Set();

function updatePrice(symbol: string, price: number, source: PriceSource): void {
  const entry: PriceEntry = {
    price,
    source,
    timestamp: Date.now(),
  };

  // Only update if from active source or if current price is stale
  const current = prices.get(symbol);
  const isCurrentStale = current && Date.now() - current.timestamp > STALE_THRESHOLD_MS;

  if (!failoverActive && source === primarySource) {
    prices.set(symbol, entry);
    notifyCallbacks(symbol, price, source);
  } else if (failoverActive && source !== primarySource) {
    prices.set(symbol, entry);
    notifyCallbacks(symbol, price, source);
  } else if (isCurrentStale) {
    prices.set(symbol, entry);
    notifyCallbacks(symbol, price, source);
  }
}

function notifyCallbacks(symbol: string, price: number, source: PriceSource): void {
  for (const callback of priceCallbacks) {
    try {
      callback(symbol, price, source);
    } catch (err) {
      console.error("[PriceManager] Callback error:", err);
    }
  }
}

function checkFailover(): void {
  const binanceConnected = binance.isConnected();
  const coinbaseConnected = coinbase.isConnected();

  if (primarySource === "binance" && !binanceConnected && coinbaseConnected) {
    if (!failoverActive) {
      console.log("[PriceManager] Failing over to Coinbase");
      failoverActive = true;
    }
  } else if (primarySource === "binance" && binanceConnected) {
    if (failoverActive) {
      console.log("[PriceManager] Restored to Binance");
      failoverActive = false;
    }
  }
}

export async function start(symbols: string[]): Promise<void> {
  // Set up price callbacks from both sources
  binance.onPrice((symbol, price) => updatePrice(symbol, price, "binance"));
  coinbase.onPrice((symbol, price) => updatePrice(symbol, price, "coinbase"));

  // Connect to primary source first
  try {
    await binance.connect(symbols);
    console.log("[PriceManager] Primary source (Binance) connected");
  } catch (err) {
    console.error("[PriceManager] Primary source failed, trying fallback");
  }

  // Connect to fallback source
  try {
    await coinbase.connect(symbols);
    console.log("[PriceManager] Fallback source (Coinbase) connected");
  } catch (err) {
    console.error("[PriceManager] Fallback source also failed");
  }

  // Start failover monitoring
  failoverCheckInterval = setInterval(checkFailover, FAILOVER_CHECK_INTERVAL_MS);

  console.log("[PriceManager] Started with failover enabled");
}

export function stop(): void {
  if (failoverCheckInterval) {
    clearInterval(failoverCheckInterval);
    failoverCheckInterval = null;
  }

  binance.disconnect();
  coinbase.disconnect();

  failoverActive = false;
  prices.clear();

  console.log("[PriceManager] Stopped");
}

export function getPrice(symbol: string): number | null {
  const entry = prices.get(symbol);
  if (!entry) return null;

  // Return null if price is stale
  if (Date.now() - entry.timestamp > STALE_THRESHOLD_MS) {
    return null;
  }

  return entry.price;
}

export function getPriceWithMeta(symbol: string): PriceEntry | null {
  return prices.get(symbol) ?? null;
}

export function getAllPrices(): Map<string, PriceEntry> {
  return new Map(prices);
}

export function onPrice(callback: PriceCallback): () => void {
  priceCallbacks.add(callback);
  return () => priceCallbacks.delete(callback);
}

export function isHealthy(): boolean {
  return binance.isConnected() || coinbase.isConnected();
}

export function getStatus(): {
  primary: { source: PriceSource; connected: boolean };
  fallback: { source: PriceSource; connected: boolean };
  failoverActive: boolean;
} {
  return {
    primary: { source: "binance", connected: binance.isConnected() },
    fallback: { source: "coinbase", connected: coinbase.isConnected() },
    failoverActive,
  };
}

export function setPrimarySource(source: PriceSource): void {
  primarySource = source;
  console.log(`[PriceManager] Primary source set to ${source}`);
}
