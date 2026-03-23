import WebSocket from "ws";

const WSS_URL = "wss://api.hyperliquid.xyz/ws";
const SUBSCRIBE_MSG = JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } });
const PING_INTERVAL_MS = 50_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const midsCache = new Map<string, number>();
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
              midsCache.set(coin, price);
              if (coin === "BTC") checkBtcSpike(price);
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

// BTC spike detection - auto-close shorts on sudden pump
const BTC_PRICE_HISTORY: { t: number; p: number }[] = [];
const SPIKE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SPIKE_THRESHOLD_PCT = 1.5; // 1.5% move in 5 min = spike
let spikeCallbacks: (() => void)[] = [];
let lastSpikeAlert = 0;

function checkBtcSpike(price: number): void {
  const now = Date.now();
  BTC_PRICE_HISTORY.push({ t: now, p: price });
  // Trim old entries
  while (BTC_PRICE_HISTORY.length > 0 && now - BTC_PRICE_HISTORY[0].t > SPIKE_WINDOW_MS) {
    BTC_PRICE_HISTORY.shift();
  }
  if (BTC_PRICE_HISTORY.length < 2) return;
  const oldest = BTC_PRICE_HISTORY[0].p;
  const changePct = (price - oldest) / oldest * 100;
  // Pump detection (positive spike hurts shorts)
  if (changePct > SPIKE_THRESHOLD_PCT && now - lastSpikeAlert > 60_000) {
    lastSpikeAlert = now;
    console.log(`[SPIKE] BTC pumped ${changePct.toFixed(2)}% in ${((now - BTC_PRICE_HISTORY[0].t) / 1000).toFixed(0)}s! Triggering emergency close.`);
    for (const cb of spikeCallbacks) { try { cb(); } catch {} }
  }
}

export function onBtcSpike(callback: () => void): void {
  spikeCallbacks.push(callback);
}

export function getWsMids(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [coin, price] of midsCache.entries()) {
    result[coin] = String(price);
  }
  return result;
}

export function isWsConnected(): boolean {
  return connected && midsCache.size > 0;
}
