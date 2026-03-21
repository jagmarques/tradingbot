/**
 * HF Scalp: Uses 15-min momentum signal from Binance to trade BTC/ETH/SOL
 * perps on Hyperliquid. Paper only for now.
 *
 * Signal: same as HF Maker (0.1%+ move in last 60s of 15-min window)
 * Execution: open HL perp in momentum direction, hold ~15 min
 * Exit: TP 0.3%, SL 0.15%, max hold 20 min
 */

import WebSocket from "ws";
import { openPosition, closePosition, getOpenQuantPositions } from "../hyperliquid/executor.js";

const TRADE_TYPE = "hf-scalp" as const;
const LEVERAGE = 10;
const SIZE_USD = 20;
const TP_PCT = 0.003;   // 0.3% price move = 3% P&L
const SL_PCT = 0.0015;  // 0.15% price move = 1.5% P&L
const MAX_HOLD_MS = 20 * 60 * 1000; // 20 min
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
    const tp = direction === "long"
      ? currentPrice * (1 + TP_PCT)
      : currentPrice * (1 - TP_PCT);

    console.log(
      `[HFScalp] SIGNAL ${window.coin} ${direction.toUpperCase()} ` +
      `move=${(movePct * 100).toFixed(3)}% ${secsLeft.toFixed(0)}s left`
    );

    const pos = await openPosition(
      window.coin, direction, SIZE_USD, LEVERAGE,
      sl, tp, "trending", TRADE_TYPE, undefined, currentPrice, true, // forcePaper=true
    );

    if (pos) {
      totalOpened++;
      console.log(
        `[HFScalp] OPEN ${window.coin} ${direction} $${SIZE_USD} @${currentPrice.toFixed(2)} ` +
        `SL=${sl.toFixed(2)} TP=${tp.toFixed(2)}`
      );
    }
  }
}

// Max hold exit
async function checkMaxHold(): Promise<void> {
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[HFScalp] Max hold exit: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "max-hold");
    }
  }
}

function runHeartbeat(): void {
  void checkLateEntry();
  void checkMaxHold();
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
    `TP=${(TP_PCT * 100).toFixed(1)}% SL=${(SL_PCT * 100).toFixed(2)}% threshold=${(MIN_MOVE_PCT * 100).toFixed(1)}%)`
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
