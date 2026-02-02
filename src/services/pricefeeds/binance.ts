import WebSocket from "ws";
import { loadEnv } from "../../config/env.js";
import {
  WEBSOCKET_PING_INTERVAL_MS,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
} from "../../config/constants.js";

type PriceCallback = (symbol: string, price: number) => void;

interface BinanceTickerMessage {
  e: string; // Event type
  s: string; // Symbol
  c: string; // Close price
}

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let isConnecting = false;
let shouldReconnect = true;

const priceCallbacks: Set<PriceCallback> = new Set();
const prices: Map<string, number> = new Map();

function getWsUrl(symbols: string[]): string {
  const env = loadEnv();
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/");
  return `${env.BINANCE_WS_URL}/stream?streams=${streams}`;
}

function getReconnectDelay(): number {
  const delay = Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
  return delay;
}

function handleMessage(data: WebSocket.Data): void {
  try {
    const parsed = JSON.parse(data.toString()) as { data?: BinanceTickerMessage };
    const ticker = parsed.data;

    if (!ticker || ticker.e !== "24hrTicker") return;

    const symbol = ticker.s;
    const price = parseFloat(ticker.c);

    if (isNaN(price)) return;

    prices.set(symbol, price);

    for (const callback of priceCallbacks) {
      try {
        callback(symbol, price);
      } catch (err) {
        console.error("[Binance] Callback error:", err);
      }
    }
  } catch (err) {
    console.error("[Binance] Message parse error:", err);
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

    // Timeout after 10 seconds
    const timeout = setTimeout(() => {
      if (isConnecting) {
        isConnecting = false;
        if (ws) ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 10000);

    const url = getWsUrl(symbols);
    ws = new WebSocket(url);

    ws.on("open", () => {
      clearTimeout(timeout);
      console.log("[Binance] WebSocket connected");
      isConnecting = false;
      reconnectAttempts = 0;
      startPingInterval();
      resolve();
    });

    ws.on("message", handleMessage);

    ws.on("error", (err) => {
      console.error("[Binance] WebSocket error:", err.message);
      clearTimeout(timeout);
      if (isConnecting) {
        isConnecting = false;
        reject(err);
      } else {
        // Error after connection - will reconnect via close handler
      }
    });

    ws.on("close", () => {
      console.log("[Binance] WebSocket closed");
      isConnecting = false;
      stopPingInterval();

      if (shouldReconnect) {
        const delay = getReconnectDelay();
        reconnectAttempts++;
        console.log(`[Binance] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(() => connect(symbols).catch(() => {}), delay);
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
  console.log("[Binance] Disconnected");
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
