import WebSocket from "ws";
import { loadEnv } from "../../config/env.js";
import {
  WEBSOCKET_PING_INTERVAL_MS,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
} from "../../config/constants.js";

type PriceCallback = (symbol: string, price: number) => void;

interface CoinbaseTickerMessage {
  type: string;
  product_id: string;
  price: string;
}

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let isConnecting = false;
let shouldReconnect = true;
let subscribedSymbols: string[] = [];

const priceCallbacks: Set<PriceCallback> = new Set();
const prices: Map<string, number> = new Map();

// Convert Binance symbol format to Coinbase (BTCUSDT -> BTC-USD)
function toCoinbaseSymbol(binanceSymbol: string): string {
  // Common conversions
  const symbol = binanceSymbol.toUpperCase();
  if (symbol.endsWith("USDT")) {
    return symbol.replace("USDT", "-USD");
  }
  if (symbol.endsWith("USD")) {
    return symbol.replace("USD", "-USD");
  }
  return symbol;
}

// Convert Coinbase symbol back to Binance format (BTC-USD -> BTCUSDT)
function toBinanceSymbol(coinbaseSymbol: string): string {
  return coinbaseSymbol.replace("-USD", "USDT").replace("-", "");
}

function getReconnectDelay(): number {
  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  return delay;
}

function sendSubscribe(symbols: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const productIds = symbols.map(toCoinbaseSymbol);
  const subscribeMsg = {
    type: "subscribe",
    product_ids: productIds,
    channels: ["ticker"],
  };

  ws.send(JSON.stringify(subscribeMsg));
}

function handleMessage(data: WebSocket.Data): void {
  try {
    const parsed = JSON.parse(data.toString()) as CoinbaseTickerMessage;

    if (parsed.type !== "ticker") return;

    const coinbaseSymbol = parsed.product_id;
    const binanceSymbol = toBinanceSymbol(coinbaseSymbol);
    const price = parseFloat(parsed.price);

    if (isNaN(price)) return;

    prices.set(binanceSymbol, price);

    for (const callback of priceCallbacks) {
      try {
        callback(binanceSymbol, price);
      } catch (err) {
        console.error("[Coinbase] Callback error:", err);
      }
    }
  } catch (err) {
    console.error("[Coinbase] Message parse error:", err);
  }
}

function startPingInterval(): void {
  if (pingInterval) clearInterval(pingInterval);

  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, WEBSOCKET_PING_INTERVAL_MS);
}

function stopPingInterval(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

export function connect(symbols: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isConnecting) {
      reject(new Error("Connection already in progress"));
      return;
    }

    if (ws?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    isConnecting = true;
    shouldReconnect = true;
    subscribedSymbols = symbols;

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      if (isConnecting) {
        isConnecting = false;
        if (ws) ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 10000);

    const env = loadEnv();
    ws = new WebSocket(env.COINBASE_WS_URL);

    ws.on("open", () => {
      clearTimeout(timeout);
      console.log("[Coinbase] WebSocket connected");
      isConnecting = false;
      reconnectAttempts = 0;
      startPingInterval();
      sendSubscribe(symbols);
      resolve();
    });

    ws.on("message", handleMessage);

    ws.on("error", (err) => {
      console.error("[Coinbase] WebSocket error:", err.message);
      clearTimeout(timeout);
      if (isConnecting) {
        isConnecting = false;
        reject(err);
      } else {
        // Error after connection - will reconnect via close handler
      }
    });

    ws.on("close", () => {
      console.log("[Coinbase] WebSocket closed");
      isConnecting = false;
      stopPingInterval();

      if (shouldReconnect) {
        const delay = getReconnectDelay();
        reconnectAttempts++;
        console.log(`[Coinbase] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(() => connect(subscribedSymbols).catch(() => {}), delay);
      }
    });

    ws.on("pong", () => {
      // Connection is alive
    });
  });
}

export function disconnect(): void {
  shouldReconnect = false;
  stopPingInterval();

  if (ws) {
    ws.close();
    ws = null;
  }

  reconnectAttempts = 0;
  console.log("[Coinbase] Disconnected");
}

export function getPrice(symbol: string): number | null {
  return prices.get(symbol) ?? null;
}

export function getAllPrices(): Map<string, number> {
  return new Map(prices);
}

export function onPrice(callback: PriceCallback): () => void {
  priceCallbacks.add(callback);
  return () => priceCallbacks.delete(callback);
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

export function getReconnectAttempts(): number {
  return reconnectAttempts;
}
