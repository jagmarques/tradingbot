/**
 * HF Scalp: Uses 15-min momentum signal from Binance to trade BTC/ETH/SOL
 * perps on Hyperliquid. Paper only for now.
 *
 * Signal: 0.1%+ move in last 60s of 15-min window
 * Execution: open HL perp in momentum direction
 * Exit: close at window end (~60s hold), safety SL 0.5%
 */

import WebSocket from "ws";
import { openPosition, closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";

// Dead code - engine is unused but file kept for reference
const TRADE_TYPE = "hf-scalp" as unknown as import("../hyperliquid/types.js").TradeType;
const LEVERAGE = 10;
const SIZE_USD = 20;
const SL_PCT = 0.005;   // 0.5% safety SL only (should close at window end first)
const MIN_MOVE_PCT = 0.001; // 0.1% threshold
const ENTRY_WINDOW_SECS = 60;
const HEARTBEAT_MS = 5000;
const WINDOW_SCAN_MS = 60_000;
const ONE_PER_WINDOW = true;

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m/ethusdt@kline_1m/solusdt@kline_1m";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// Binance symbol -> HL pair
const SYMBOL_MAP: Record<string, string> = {
  BTCUSDT: "BTC", ETHUSDT: "ETH", SOLUSDT: "SOL",
};

interface ActiveWindow {
  coin: string;
  endTime: number;
  startPrice?: number;
}

// State
let running = false;
let binanceConnected = false;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let windowScanInterval: NodeJS.Timeout | null = null;

const latestPrices = new Map<string, number>();
const activeWindows = new Map<string, ActiveWindow>();
const windowTraded = new Set<string>();
let totalSignals = 0;
let totalOpened = 0;
const positionWindowEnd = new Map<string, number>(); // positionId -> window end timestamp

// Binance WS
function connectBinance(): void {
  if (ws) { try { ws.close(); } catch {} }
  ws = new WebSocket(BINANCE_WS_URL);

  ws.on("open", () => {
    binanceConnected = true;
    reconnectAttempts = 0;
    console.log("[HFScalp] Binance WS connected");
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const raw = JSON.parse(data.toString());
      const msg = raw.data && raw.stream ? raw.data : raw;
      if (msg.e === "kline") {
        const coin = SYMBOL_MAP[msg.s as string];
        if (!coin) return;
        const price = parseFloat(msg.k.c);
        if (isNaN(price)) return;
        latestPrices.set(coin, price);
        // Capture window start price
        for (const [, w] of activeWindows) {
          if (w.coin === coin && !w.startPrice) {
            w.startPrice = price;
          }
        }
      }
    } catch {}
  });

  ws.on("close", () => { binanceConnected = false; if (running) scheduleReconnect(); });
  ws.on("error", () => { binanceConnected = false; });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (running) connectBinance(); }, delay);
}

// Window tracking (no Gamma API needed - just 15-min time windows)
function scanWindows(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowTs = Math.floor(nowSec / 900) * 900;

  // Clean expired
  for (const [key, w] of activeWindows) {
    if (w.endTime <= Date.now()) {
      activeWindows.delete(key);
      windowTraded.delete(key);
    }
  }

  for (const coin of ["BTC", "ETH", "SOL"]) {
    const key = `${coin}-${windowTs}`;
    if (activeWindows.has(key)) continue;
    activeWindows.set(key, {
      coin,
      endTime: (windowTs + 900) * 1000,
      startPrice: latestPrices.get(coin),
    });
  }
}

// Late-entry check
async function checkLateEntry(): Promise<void> {
  const now = Date.now();

  for (const [key, window] of activeWindows) {
    if (!window.startPrice) continue;
    if (windowTraded.has(key) && ONE_PER_WINDOW) continue;

    const secsLeft = (window.endTime - now) / 1000;
    if (secsLeft > ENTRY_WINDOW_SECS || secsLeft <= 5) continue;

    const currentPrice = latestPrices.get(window.coin);
    if (!currentPrice) continue;

    const movePct = (currentPrice - window.startPrice) / window.startPrice;
    const absMove = Math.abs(movePct);

    if (absMove < MIN_MOVE_PCT) continue;

    // Check no existing position for this pair
    const existing = getOpenQuantPositions().find(
      p => p.pair === window.coin && p.tradeType === TRADE_TYPE
    );
    if (existing) continue;

    windowTraded.add(key);
    totalSignals++;

    const direction: "long" | "short" = movePct > 0 ? "long" : "short";
    const sl = direction === "long"
      ? currentPrice * (1 - SL_PCT)
      : currentPrice * (1 + SL_PCT);

    console.log(
      `[HFScalp] SIGNAL ${window.coin} ${direction.toUpperCase()} ` +
      `move=${(movePct * 100).toFixed(3)}% ${secsLeft.toFixed(0)}s left`
    );

    const pos = await openPosition(
      window.coin, direction, SIZE_USD, LEVERAGE,
      sl, 0, "trending", TRADE_TYPE, undefined, currentPrice, true,
    );

    if (pos) {
      totalOpened++;
      positionWindowEnd.set(pos.id, window.endTime);
      console.log(
        `[HFScalp] OPEN ${window.coin} ${direction} $${SIZE_USD} @${currentPrice.toFixed(2)} ` +
        `closes in ${secsLeft.toFixed(0)}s`
      );
    }
  }
}

// Close at window end (or immediately if stale from redeploy)
async function checkWindowClose(): Promise<void> {
  const now = Date.now();
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    const windowEnd = positionWindowEnd.get(pos.id);
    if (!windowEnd) {
      // Stale from redeploy - close immediately
      console.log(`[HFScalp] Stale close: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "window-close");
      continue;
    }
    if (now >= windowEnd) {
      console.log(`[HFScalp] Window close: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "window-close");
      positionWindowEnd.delete(pos.id);
    }
  }
}

function runHeartbeat(): void {
  void checkLateEntry();
  void checkWindowClose();
}

// Public API
export async function startHFScalp(): Promise<void> {
  if (running) return;
  running = true;

  connectBinance();
  scanWindows();
  windowScanInterval = setInterval(scanWindows, WINDOW_SCAN_MS);
  heartbeatInterval = setInterval(runHeartbeat, HEARTBEAT_MS);

  console.log(
    `[HFScalp] Started (paper, $${SIZE_USD}/trade, ${LEVERAGE}x, ` +
    `SL=${(SL_PCT * 100).toFixed(2)}% threshold=${(MIN_MOVE_PCT * 100).toFixed(1)}% close=window-end)`
  );
}

export function stopHFScalp(): void {
  if (!running) return;
  running = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  binanceConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (windowScanInterval) { clearInterval(windowScanInterval); windowScanInterval = null; }
  console.log("[HFScalp] Stopped");
}

export function getHFScalpStats(): {
  running: boolean;
  binanceConnected: boolean;
  activeWindows: number;
  totalSignals: number;
  totalOpened: number;
  openPositions: number;
} {
  const open = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE).length;
  return { running, binanceConnected, activeWindows: activeWindows.size, totalSignals, totalOpened, openPositions: open };
}
