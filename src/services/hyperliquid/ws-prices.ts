import WebSocket from "ws";

const WSS_URL = "wss://api.hyperliquid.xyz/ws";
const SUBSCRIBE_MSG = JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } });
const PING_INTERVAL_MS = 50_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface MidEntry { price: number; ts: number; }
const midsCache = new Map<string, MidEntry>();
const MID_MAX_AGE_MS = 30_000; // filter entries older than this from getWsMids
let ws: WebSocket | null = null;
let started = false;
let connected = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempts = 0;
let stopped = false;

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  setTimeout(connect, delay);
}

function clearPing(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function connect(): void {
  if (stopped) return;

  ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    console.log("[HlPriceWs] Connected");
    ws?.send(SUBSCRIBE_MSG);
    clearPing();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "ping" }));
      }
    }, PING_INTERVAL_MS);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.channel === "allMids" && msg.data && typeof msg.data === "object") {
        const payload = msg.data as { mids?: Record<string, string> };
        if (payload.mids) {
          for (const [coin, priceStr] of Object.entries(payload.mids)) {
            const price = parseFloat(priceStr);
            if (isFinite(price) && price > 0) {
              midsCache.set(coin, { price, ts: Date.now() });
            }
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("error", (err: Error) => {
    console.error(`[HlPriceWs] Error: ${err.message}`);
  });

  ws.on("close", () => {
    connected = false;
    clearPing();
    ws = null;
    if (!stopped) {
      console.log("[HlPriceWs] Disconnected, reconnecting...");
      scheduleReconnect();
    }
  });
}

export function startHlPriceWs(): void {
  if (started) return;
  started = true;
  stopped = false;
  console.log("[HlPriceWs] Starting...");
  connect();
}

export function stopHlPriceWs(): void {
  stopped = true;
  started = false;
  connected = false;
  clearPing();
  if (ws) {
    ws.close();
    ws = null;
  }
  midsCache.clear();
  console.log("[HlPriceWs] Stopped");
}

export function getWsMids(): Record<string, string> {
  const result: Record<string, string> = {};
  const cutoff = Date.now() - MID_MAX_AGE_MS;
  for (const [coin, entry] of midsCache.entries()) {
    if (entry.ts >= cutoff) result[coin] = String(entry.price);
  }
  return result;
}

export function isWsConnected(): boolean {
  return connected && midsCache.size > 0;
}
