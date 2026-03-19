/**
 * HF Maker: Binance WS momentum -> Polymarket maker orders on 15-min crypto markets.
 * Earns ~2% maker rebate instead of paying taker fees.
 */

import WebSocket from "ws";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";
import { isPolymarketPaperMode } from "../../config/env.js";
import { placeOrder, cancelOrder, getOrderbook } from "../polygon/polymarket.js";

// ---- Constants ---------------------------------------------------------------

const HF_MAKER_POSITION_SIZE = 5;
const MOMENTUM_THRESHOLD = 0.0015;
const MOMENTUM_COOLDOWN_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const WINDOW_SCAN_INTERVAL_MS = 60_000;
const MAX_TRADES = 500;
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m/ethusdt@kline_1m";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PAPER_FILL_MIN_MS = 2000;
const PAPER_FILL_MAX_MS = 10_000;
const INITIAL_BALANCE = 100;

// ---- Types -------------------------------------------------------------------

export interface HFMakerTrade {
  id: string;
  coin: string;
  side: "up" | "down";
  entryPrice: number;
  shares: number;
  size: number;
  entryTime: number;
  windowEnd: number;
  binancePriceAtEntry: number;
  binancePriceAtClose?: number;
  momentumMagnitude: number;
  orderId?: string;
  status: "pending" | "open" | "won" | "lost" | "cancelled";
  pnl: number;
}

interface MomentumSignal {
  symbol: "BTC" | "ETH";
  direction: "up" | "down";
  magnitude: number;
  binancePrice: number;
  timestamp: number;
}

interface ActiveWindow {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  endTime: number;
  coin: string;
}

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomePrices: string;
  endDate: string;
  active: boolean;
  closed: boolean;
}

// ---- State -------------------------------------------------------------------

let running = false;
let binanceConnected = false;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let windowScanInterval: NodeJS.Timeout | null = null;

const priceBuffers = new Map<string, number[]>();
const momentumCooldowns = new Map<string, number>();
const activeWindows = new Map<string, ActiveWindow>();
const trades: HFMakerTrade[] = [];
let balance = INITIAL_BALANCE;

// Active order IDs mapped to trade IDs
const activeOrders = new Map<string, string>();

// Paper fill timers
const paperFillTimers = new Map<string, NodeJS.Timeout>();

// ---- Binance WebSocket -------------------------------------------------------

function connectBinance(): void {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }

  ws = new WebSocket(BINANCE_WS_URL);

  ws.on("open", () => {
    binanceConnected = true;
    reconnectAttempts = 0;
    console.log("[HFMaker] Binance WS connected");
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        e: string;
        s: string;
        k: { c: string; v: string; x: boolean };
      };
      if (msg.e === "kline") handleKline(msg.s, msg.k);
    } catch { /* skip malformed */ }
  });

  ws.on("close", () => {
    binanceConnected = false;
    if (running) scheduleReconnect();
  });

  ws.on("error", () => {
    binanceConnected = false;
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;
  console.log(`[HFMaker] Binance WS reconnecting in ${delay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (running) connectBinance();
  }, delay);
}

// ---- Kline Processing --------------------------------------------------------

function handleKline(symbol: string, kline: { c: string; v: string; x: boolean }): void {
  const coin = symbol === "BTCUSDT" ? "BTC" : symbol === "ETHUSDT" ? "ETH" : null;
  if (!coin) return;

  const close = parseFloat(kline.c);
  if (isNaN(close)) return;

  // Only process on kline close
  if (!kline.x) return;

  const buffer = priceBuffers.get(coin) ?? [];
  buffer.push(close);
  if (buffer.length > 5) buffer.shift();
  priceBuffers.set(coin, buffer);

  if (buffer.length >= 4) {
    checkMomentum(coin as "BTC" | "ETH", buffer, close);
  }
}

// ---- Momentum Detection ------------------------------------------------------

function checkMomentum(coin: "BTC" | "ETH", buffer: number[], currentPrice: number): void {
  const ref = buffer[buffer.length - 4]; // 3 candles ago
  const momentum = (currentPrice - ref) / ref;

  if (Math.abs(momentum) < MOMENTUM_THRESHOLD) return;

  // Cooldown check
  const lastSignal = momentumCooldowns.get(coin) ?? 0;
  if (Date.now() - lastSignal < MOMENTUM_COOLDOWN_MS) return;

  const signal: MomentumSignal = {
    symbol: coin,
    direction: momentum > 0 ? "up" : "down",
    magnitude: Math.abs(momentum),
    binancePrice: currentPrice,
    timestamp: Date.now(),
  };

  momentumCooldowns.set(coin, Date.now());
  const dir = signal.direction.toUpperCase();
  const pct = (signal.magnitude * 100).toFixed(2);
  const priceStr = currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 });
  console.log(`[HFMaker] Momentum ${coin} ${dir} +${pct}% @ $${priceStr}`);

  void handleMomentumSignal(signal);
}

// ---- Window Discovery --------------------------------------------------------

async function scanWindows(): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&tag=15-minute&limit=50`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return;

    const markets = (await response.json()) as GammaMarketResponse[];
    const titleRegex = /Will\s+(BTC|ETH|Bitcoin|Ethereum).*(up|down|rise|fall).*\d+\s*min/i;
    const now = Date.now();

    activeWindows.clear();

    for (const m of markets) {
      try {
        if (m.closed || !m.active) continue;

        const endTime = new Date(m.endDate).getTime();
        if (isNaN(endTime)) continue;
        // Must be an active window (ending in the future, within 15 min)
        if (endTime <= now || endTime - now > 15 * 60 * 1000) continue;

        // Match by title
        const match = titleRegex.exec(m.question);
        if (!match) continue;

        const rawCoin = match[1].toUpperCase();
        const coin = rawCoin === "BITCOIN" ? "BTC" : rawCoin === "ETHEREUM" ? "ETH" : rawCoin;
        if (coin !== "BTC" && coin !== "ETH") continue;

        const tokenIds = JSON.parse(m.clobTokenIds) as string[];
        if (tokenIds.length < 2) continue;

        const key = `${coin}-${endTime}`;
        activeWindows.set(key, {
          marketId: m.conditionId,
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          endTime,
          coin,
        });
      } catch { /* skip */ }
    }

    if (activeWindows.size > 0) {
      console.log(`[HFMaker] ${activeWindows.size} active 15m windows`);
    }
  } catch (err) {
    console.error("[HFMaker] Window scan error:", err);
  }
}

// ---- Order Placement ---------------------------------------------------------

async function handleMomentumSignal(signal: MomentumSignal): Promise<void> {
  // Find matching window for this coin
  const now = Date.now();
  let bestWindow: ActiveWindow | null = null;

  for (const w of activeWindows.values()) {
    if (w.coin !== signal.symbol) continue;
    if (w.endTime <= now) continue;
    // Pick the window closest to expiry (most relevant)
    if (!bestWindow || w.endTime < bestWindow.endTime) {
      bestWindow = w;
    }
  }

  if (!bestWindow) return;

  if (balance < HF_MAKER_POSITION_SIZE) {
    console.log("[HFMaker] Insufficient balance, skipping order");
    return;
  }

  // Determine token: up -> YES, down -> NO
  const tokenId = signal.direction === "up" ? bestWindow.yesTokenId : bestWindow.noTokenId;

  let entryPrice: number;

  if (isPolymarketPaperMode()) {
    // Paper: simulate a reasonable maker price
    entryPrice = signal.direction === "up" ? 0.52 : 0.48;
  } else {
    // Live: read orderbook and place one tick above best bid
    const book = await getOrderbook(tokenId);
    if (!book || book.bids.length === 0) {
      console.log("[HFMaker] No orderbook bids, skipping");
      return;
    }
    const bestBid = parseFloat(book.bids[0][0]);
    entryPrice = Math.min(bestBid + 0.01, 0.99);
  }

  const shares = HF_MAKER_POSITION_SIZE / entryPrice;
  const tradeId = `hfm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const endStr = new Date(bestWindow.endTime).toISOString().slice(11, 16);
  console.log(
    `[HFMaker] ORDER ${signal.symbol} ${signal.direction === "up" ? "YES" : "NO"} ` +
    `@${(entryPrice * 100).toFixed(0)}c $${HF_MAKER_POSITION_SIZE} (maker) end=${endStr}`
  );

  const trade: HFMakerTrade = {
    id: tradeId,
    coin: signal.symbol,
    side: signal.direction,
    entryPrice,
    shares,
    size: HF_MAKER_POSITION_SIZE,
    entryTime: Date.now(),
    windowEnd: bestWindow.endTime,
    binancePriceAtEntry: signal.binancePrice,
    momentumMagnitude: signal.magnitude,
    status: "pending",
    pnl: 0,
  };

  trades.push(trade);
  balance -= HF_MAKER_POSITION_SIZE;

  // Trim old trades
  while (trades.length > MAX_TRADES) {
    const idx = trades.findIndex(t => t.status !== "pending" && t.status !== "open");
    if (idx >= 0) trades.splice(idx, 1);
    else break;
  }

  if (isPolymarketPaperMode()) {
    // Simulate fill after random delay
    const delay = PAPER_FILL_MIN_MS + Math.random() * (PAPER_FILL_MAX_MS - PAPER_FILL_MIN_MS);
    const timer = setTimeout(() => {
      paperFillTimers.delete(tradeId);
      if (trade.status === "pending") {
        trade.status = "open";
        console.log(`[HFMaker] FILL (paper) ${trade.coin} ${trade.side} @${(trade.entryPrice * 100).toFixed(0)}c`);
      }
    }, delay);
    paperFillTimers.set(tradeId, timer);
  } else {
    // Live: place order on CLOB
    try {
      const order = await placeOrder({
        tokenId,
        side: "BUY",
        price: entryPrice.toFixed(2),
        size: shares.toFixed(2),
        feeRateBps: 0,
        expiration: Math.floor(bestWindow.endTime / 1000),
      });
      if (order) {
        trade.orderId = order.id;
        activeOrders.set(order.id, tradeId);
        console.log(`[HFMaker] Order placed: ${order.id}`);
      } else {
        trade.status = "cancelled";
        balance += HF_MAKER_POSITION_SIZE;
        console.log("[HFMaker] Order placement failed");
      }
    } catch (err) {
      trade.status = "cancelled";
      balance += HF_MAKER_POSITION_SIZE;
      console.error("[HFMaker] Order error:", err);
    }
  }
}

// ---- Heartbeat ---------------------------------------------------------------

function runHeartbeat(): void {
  const now = Date.now();

  // Check pending orders in live mode
  for (const trade of trades) {
    if (trade.status === "pending" && !isPolymarketPaperMode() && trade.orderId) {
      // GTC orders persist until expiry. Check if window expired.
      if (now >= trade.windowEnd) {
        trade.status = "cancelled";
        balance += trade.size;
        activeOrders.delete(trade.orderId);
        console.log(`[HFMaker] Order expired: ${trade.coin} ${trade.side}`);
      }
    }

    // Resolve open positions at window end
    if (trade.status === "open" && now >= trade.windowEnd) {
      resolvePosition(trade);
    }

    // Auto-cancel pending if window passed
    if (trade.status === "pending" && now >= trade.windowEnd) {
      trade.status = "cancelled";
      balance += trade.size;
      if (trade.orderId) {
        activeOrders.delete(trade.orderId);
        if (!isPolymarketPaperMode()) void cancelOrder(trade.orderId);
      }
    }
  }

  const openOrders = trades.filter(t => t.status === "pending").length;
  const openPositions = trades.filter(t => t.status === "open").length;
  if (openOrders > 0 || openPositions > 0) {
    console.log(`[HFMaker] Heartbeat: ${openOrders} orders, ${openPositions} positions`);
  }
}

// ---- Position Resolution -----------------------------------------------------

function resolvePosition(trade: HFMakerTrade): void {
  const currentBinancePrice = getLatestPrice(trade.coin);
  trade.binancePriceAtClose = currentBinancePrice;

  if (isPolymarketPaperMode()) {
    // Paper: resolve based on price direction
    const priceUp = currentBinancePrice > trade.binancePriceAtEntry;
    const directionMatched =
      (trade.side === "up" && priceUp) || (trade.side === "down" && !priceUp);

    if (directionMatched) {
      // Win: payout = shares * $1
      const payout = trade.shares * 1.0;
      trade.pnl = payout - trade.size;
      trade.status = "won";
      balance += payout;
    } else {
      // Lose: lose entire size
      trade.pnl = -trade.size;
      trade.status = "lost";
    }
  } else {
    // Live: market auto-resolves on Polymarket; mark as won/lost based on price
    const priceUp = currentBinancePrice > trade.binancePriceAtEntry;
    const directionMatched =
      (trade.side === "up" && priceUp) || (trade.side === "down" && !priceUp);

    if (directionMatched) {
      const payout = trade.shares * 1.0;
      trade.pnl = payout - trade.size;
      trade.status = "won";
      balance += payout;
    } else {
      trade.pnl = -trade.size;
      trade.status = "lost";
    }
  }

  const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
  console.log(`[HFMaker] ${trade.status.toUpperCase()} ${trade.coin} ${trade.side} ${pnlStr}`);
}

function getLatestPrice(coin: string): number {
  const buffer = priceBuffers.get(coin);
  if (!buffer || buffer.length === 0) return 0;
  return buffer[buffer.length - 1];
}

// ---- Public API --------------------------------------------------------------

export function startHFMaker(): void {
  if (running) return;
  running = true;

  connectBinance();

  // Scan windows immediately then every 60s
  void scanWindows();
  windowScanInterval = setInterval(() => void scanWindows(), WINDOW_SCAN_INTERVAL_MS);

  // Heartbeat every 5s
  heartbeatInterval = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

  console.log("[HFMaker] Started (paper=" + String(isPolymarketPaperMode()) + ")");
}

export function stopHFMaker(): void {
  if (!running) return;
  running = false;

  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  binanceConnected = false;

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (windowScanInterval) { clearInterval(windowScanInterval); windowScanInterval = null; }

  for (const timer of paperFillTimers.values()) clearTimeout(timer);
  paperFillTimers.clear();

  console.log("[HFMaker] Stopped");
}

export function getHFMakerStats(): {
  balance: number;
  totalTrades: number;
  openOrders: number;
  openPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: HFMakerTrade[];
} {
  const closed = trades.filter(t => t.status === "won" || t.status === "lost");
  const wins = closed.filter(t => t.status === "won").length;
  const losses = closed.filter(t => t.status === "lost").length;
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);

  return {
    balance,
    totalTrades: trades.length,
    openOrders: trades.filter(t => t.status === "pending").length,
    openPositions: trades.filter(t => t.status === "open").length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    recentTrades: trades.slice(-10).reverse(),
  };
}

export function getHFMakerStatus(): {
  running: boolean;
  binanceConnected: boolean;
  activeWindows: number;
  trackedPairs: string[];
} {
  return {
    running,
    binanceConnected,
    activeWindows: activeWindows.size,
    trackedPairs: [...new Set([...activeWindows.values()].map(w => w.coin))],
  };
}

export function resetHFMakerData(): void {
  trades.length = 0;
  balance = INITIAL_BALANCE;
  activeOrders.clear();
  momentumCooldowns.clear();
  for (const timer of paperFillTimers.values()) clearTimeout(timer);
  paperFillTimers.clear();
  console.log("[HFMaker] Data reset");
}
