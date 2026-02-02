import WebSocket from "ws";
import {
  WEBSOCKET_PING_INTERVAL_MS,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
} from "../../config/constants.js";

const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  tokenId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

type OrderbookCallback = (orderbook: Orderbook) => void;

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let isConnecting = false;
let shouldReconnect = true;
let subscribedTokens: string[] = [];

const orderbooks: Map<string, Orderbook> = new Map();
const callbacks: Set<OrderbookCallback> = new Set();

function getReconnectDelay(): number {
  return Math.min(
    WEBSOCKET_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    WEBSOCKET_RECONNECT_MAX_MS
  );
}

function parseOrderbookUpdate(data: unknown): void {
  try {
    const msg = data as {
      event_type?: string;
      asset_id?: string;
      market?: string;
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };

    if (msg.event_type !== "book" || !msg.asset_id) return;

    const tokenId = msg.asset_id;
    const bids: OrderbookLevel[] = (msg.bids || []).map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks: OrderbookLevel[] = (msg.asks || []).map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    const orderbook: Orderbook = {
      tokenId,
      bids: bids.sort((a, b) => b.price - a.price), // Highest first
      asks: asks.sort((a, b) => a.price - b.price), // Lowest first
      timestamp: Date.now(),
    };

    orderbooks.set(tokenId, orderbook);
    notifyCallbacks(orderbook);
  } catch (err) {
    console.error("[Orderbook] Parse error:", err);
  }
}

function notifyCallbacks(orderbook: Orderbook): void {
  for (const callback of callbacks) {
    try {
      callback(orderbook);
    } catch (err) {
      console.error("[Orderbook] Callback error:", err);
    }
  }
}

function sendSubscribe(tokens: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  for (const tokenId of tokens) {
    const subscribeMsg = {
      type: "subscribe",
      channel: "book",
      assets_ids: [tokenId],
    };
    ws.send(JSON.stringify(subscribeMsg));
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

export function connect(tokenIds: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isConnecting) {
      reject(new Error("Connection already in progress"));
      return;
    }

    if (ws?.readyState === WebSocket.OPEN) {
      // Already connected, just subscribe to new tokens
      sendSubscribe(tokenIds);
      resolve();
      return;
    }

    isConnecting = true;
    shouldReconnect = true;
    subscribedTokens = tokenIds;

    ws = new WebSocket(CLOB_WS_URL);

    ws.on("open", () => {
      console.log("[Orderbook] WebSocket connected");
      isConnecting = false;
      reconnectAttempts = 0;
      startPingInterval();
      sendSubscribe(tokenIds);
      resolve();
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        parseOrderbookUpdate(parsed);
      } catch (err) {
        // Ignore parse errors for non-JSON messages
      }
    });

    ws.on("error", (err) => {
      console.error("[Orderbook] WebSocket error:", err.message);
      if (isConnecting) {
        isConnecting = false;
        reject(err);
      }
    });

    ws.on("close", () => {
      console.log("[Orderbook] WebSocket closed");
      isConnecting = false;
      stopPingInterval();

      if (shouldReconnect) {
        const delay = getReconnectDelay();
        reconnectAttempts++;
        console.log(`[Orderbook] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(() => connect(subscribedTokens).catch(() => {}), delay);
      }
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
  orderbooks.clear();
  console.log("[Orderbook] Disconnected");
}

export function getOrderbook(tokenId: string): Orderbook | null {
  return orderbooks.get(tokenId) ?? null;
}

export function getBestBid(tokenId: string): OrderbookLevel | null {
  const book = orderbooks.get(tokenId);
  return book?.bids[0] ?? null;
}

export function getBestAsk(tokenId: string): OrderbookLevel | null {
  const book = orderbooks.get(tokenId);
  return book?.asks[0] ?? null;
}

export function getMidPrice(tokenId: string): number | null {
  const bid = getBestBid(tokenId);
  const ask = getBestAsk(tokenId);
  if (!bid || !ask) return null;
  return (bid.price + ask.price) / 2;
}

export function getSpread(tokenId: string): number | null {
  const bid = getBestBid(tokenId);
  const ask = getBestAsk(tokenId);
  if (!bid || !ask) return null;
  return ask.price - bid.price;
}

export function onOrderbookUpdate(callback: OrderbookCallback): () => void {
  callbacks.add(callback);
  return () => callbacks.delete(callback);
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
