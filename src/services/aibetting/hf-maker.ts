/**
 * HF Maker: Late-entry strategy on Polymarket 15-min crypto up/down markets.
 * Waits until last 45s of window when direction is ~85%+ determined,
 * places maker order at high confidence price. Zero maker fees + rebates.
 */

import WebSocket from "ws";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";
import { isPolymarketPaperMode } from "../../config/env.js";
import { placeOrder, cancelOrder, getOrderbook } from "../polygon/polymarket.js";

// ---- Constants ---------------------------------------------------------------

const HF_MAKER_POSITION_SIZE = 5;
const HEARTBEAT_INTERVAL_MS = 5000;
const WINDOW_SCAN_INTERVAL_MS = 60_000;
const MAX_TRADES = 500;
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m/ethusdt@kline_1m/solusdt@kline_1m";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const INITIAL_BALANCE = 100;

// Late-entry strategy params
const ENTRY_WINDOW_SECS = 60; // enter in last 60s of window
const MIN_MOVE_PCT = 0.003; // 0.3% min move from window start
const STRONG_MOVE_PCT = 0.008; // 0.8%+ = strong confidence
const ONE_TRADE_PER_WINDOW = true; // max 1 trade per coin per window

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
  windowStartPrice: number;
  binancePriceAtEntry: number;
  binancePriceAtClose?: number;
  momentumMagnitude: number;
  orderId?: string;
  status: "pending" | "open" | "won" | "lost" | "cancelled";
  pnl: number;
}

interface ActiveWindow {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  endTime: number;
  coin: string;
  startPrice?: number;
}

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomePrices: string;
  outcomes: string;
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

const latestPrices = new Map<string, number>();
const activeWindows = new Map<string, ActiveWindow>();
const windowTraded = new Set<string>(); // track which windows we already traded
const trades: HFMakerTrade[] = [];
let balance = INITIAL_BALANCE;

const activeOrders = new Map<string, string>();
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
      const raw = JSON.parse(data.toString());
      // Combined stream wraps in {stream, data}
      const msg = raw.data && raw.stream ? raw.data : raw;
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
  const SYMBOL_MAP: Record<string, string> = {
    BTCUSDT: "BTC", ETHUSDT: "ETH", SOLUSDT: "SOL",
  };
  const coin = SYMBOL_MAP[symbol];
  if (!coin) return;

  const price = parseFloat(kline.c);
  if (isNaN(price)) return;

  // Update latest price on every tick (not just kline close)
  latestPrices.set(coin, price);

  // Capture window start price if not set
  for (const [key, w] of activeWindows) {
    if (w.coin === coin && !w.startPrice) {
      w.startPrice = price;
      console.log(`[HFMaker] Window ${key} start price: $${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
    }
  }
}

// ---- Window Discovery --------------------------------------------------------

async function scanWindows(): Promise<void> {
  try {
    const coins = ["btc", "eth", "sol"];
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = Math.floor(nowSec / 900) * 900;

    // Only clear windows that have expired
    for (const [key, w] of activeWindows) {
      if (w.endTime <= Date.now()) {
        activeWindows.delete(key);
        windowTraded.delete(key);
      }
    }

    for (const coin of coins) {
      try {
        const slug = `${coin}-updown-15m-${windowTs}`;
        const key = `${coin.toUpperCase()}-${windowTs}`;

        // Skip if we already have this window
        if (activeWindows.has(key)) continue;

        const response = await fetchWithTimeout(
          `${GAMMA_API_URL}/events?slug=${slug}`,
          { timeoutMs: 5000, retries: 0 }
        );
        if (!response.ok) continue;

        const events = (await response.json()) as Array<{
          markets: GammaMarketResponse[];
        }>;
        if (!events?.length || !events[0]?.markets?.length) continue;

        for (const m of events[0].markets) {
          try {
            const tokenIds = JSON.parse(m.clobTokenIds) as string[];
            if (tokenIds.length < 2) continue;

            const outcomes = JSON.parse(m.outcomes) as string[];
            const upIdx = outcomes.findIndex(o => o.toLowerCase() === "up");
            const downIdx = outcomes.findIndex(o => o.toLowerCase() === "down");
            if (upIdx === -1 || downIdx === -1) continue;

            const endTime = (windowTs + 900) * 1000;
            const currentPrice = latestPrices.get(coin.toUpperCase());

            activeWindows.set(key, {
              marketId: m.conditionId,
              yesTokenId: tokenIds[upIdx],
              noTokenId: tokenIds[downIdx],
              endTime,
              coin: coin.toUpperCase(),
              startPrice: currentPrice,
            });
          } catch { /* skip */ }
        }
      } catch { /* skip coin */ }
    }

    if (activeWindows.size > 0) {
      console.log(`[HFMaker] ${activeWindows.size} active 15m windows: ${[...activeWindows.keys()].join(", ")}`);
    }
  } catch (err) {
    console.error("[HFMaker] Window scan error:", err);
  }
}

// ---- Late-Entry Check (runs every heartbeat) ---------------------------------

function checkLateEntry(): void {
  const now = Date.now();

  for (const [key, window] of activeWindows) {
    if (!window.startPrice) continue;
    if (windowTraded.has(key) && ONE_TRADE_PER_WINDOW) continue;

    const secsLeft = (window.endTime - now) / 1000;

    // Only enter in the last ENTRY_WINDOW_SECS
    if (secsLeft > ENTRY_WINDOW_SECS || secsLeft <= 5) continue;

    const currentPrice = latestPrices.get(window.coin);
    if (!currentPrice) continue;

    const movePct = (currentPrice - window.startPrice) / window.startPrice;
    const absMove = Math.abs(movePct);

    // Skip if move is too small (noise)
    if (absMove < MIN_MOVE_PCT) continue;

    // Direction is determined by price movement from window start
    const direction: "up" | "down" = movePct > 0 ? "up" : "down";

    // Entry price scales with move magnitude
    // Break-even: 70c=70%, 75c=75%, 80c=80%
    let entryPrice: number;
    if (absMove >= STRONG_MOVE_PCT) {
      entryPrice = 0.80; // 0.8%+ move, ~88% win rate, needs 80%
    } else if (absMove >= 0.005) {
      entryPrice = 0.75; // 0.5% move, ~83% win rate, needs 75%
    } else {
      entryPrice = 0.70; // 0.3% move (minimum), ~78% win rate, needs 70%
    }

    if (balance < HF_MAKER_POSITION_SIZE) continue;

    // Place the trade
    void placeLateEntryTrade(window, key, direction, entryPrice, currentPrice, absMove);
  }
}

async function placeLateEntryTrade(
  window: ActiveWindow,
  windowKey: string,
  direction: "up" | "down",
  entryPrice: number,
  currentBinancePrice: number,
  moveMagnitude: number,
): Promise<void> {
  windowTraded.add(windowKey);

  const tokenId = direction === "up" ? window.yesTokenId : window.noTokenId;
  const shares = HF_MAKER_POSITION_SIZE / entryPrice;
  const tradeId = `hfm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const secsLeft = ((window.endTime - Date.now()) / 1000).toFixed(0);

  console.log(
    `[HFMaker] LATE-ENTRY ${window.coin} ${direction.toUpperCase()} ` +
    `@${(entryPrice * 100).toFixed(0)}c $${HF_MAKER_POSITION_SIZE} ` +
    `move=${(moveMagnitude * 100).toFixed(2)}% ${secsLeft}s left`
  );

  const trade: HFMakerTrade = {
    id: tradeId,
    coin: window.coin,
    side: direction,
    entryPrice,
    shares,
    size: HF_MAKER_POSITION_SIZE,
    entryTime: Date.now(),
    windowEnd: window.endTime,
    windowStartPrice: window.startPrice!,
    binancePriceAtEntry: currentBinancePrice,
    momentumMagnitude: moveMagnitude,
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
    // Paper: instant fill (we're entering late, high prob of fill)
    trade.status = "open";
    console.log(`[HFMaker] FILL (paper) ${trade.coin} ${trade.side} @${(trade.entryPrice * 100).toFixed(0)}c`);
  } else {
    // Live: place order on CLOB
    try {
      const book = await getOrderbook(tokenId);
      const livePrice = book && book.bids.length > 0
        ? Math.min(parseFloat(book.bids[0][0]) + 0.01, 0.95)
        : entryPrice;

      const order = await placeOrder({
        tokenId,
        side: "BUY",
        price: livePrice.toFixed(2),
        size: shares.toFixed(2),
        feeRateBps: 0,
        expiration: Math.floor(window.endTime / 1000),
      });
      if (order) {
        trade.orderId = order.id;
        trade.entryPrice = livePrice;
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

  // Check late-entry opportunities
  checkLateEntry();

  for (const trade of trades) {
    if (trade.status === "pending" && !isPolymarketPaperMode() && trade.orderId) {
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
  const currentBinancePrice = latestPrices.get(trade.coin) ?? 0;
  trade.binancePriceAtClose = currentBinancePrice;

  // Skip resolution if we don't have a valid price
  if (currentBinancePrice <= 0 || trade.windowStartPrice <= 0) {
    trade.status = "cancelled";
    balance += trade.size;
    console.log(`[HFMaker] CANCEL ${trade.coin} ${trade.side} (missing price data)`);
    return;
  }

  // Resolution: compare current price to WINDOW START price
  // Polymarket: "Up" wins if close > start, "Down" wins if close < start
  // If flat (close == start), "Down" wins on Polymarket (price didn't go up)
  const priceDiff = currentBinancePrice - trade.windowStartPrice;
  const priceUp = priceDiff > 0;
  const priceDown = priceDiff < 0;
  const directionMatched =
    (trade.side === "up" && priceUp) || (trade.side === "down" && (priceDown || priceDiff === 0));

  if (directionMatched) {
    const payout = trade.shares * 1.0;
    trade.pnl = payout - trade.size;
    trade.status = "won";
    balance += payout;
  } else {
    trade.pnl = -trade.size;
    trade.status = "lost";
  }

  const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
  const movePct = trade.windowStartPrice > 0
    ? (((currentBinancePrice - trade.windowStartPrice) / trade.windowStartPrice) * 100).toFixed(2)
    : "?";
  console.log(
    `[HFMaker] ${trade.status.toUpperCase()} ${trade.coin} ${trade.side} ${pnlStr} ` +
    `(start=$${trade.windowStartPrice.toFixed(0)} close=$${currentBinancePrice.toFixed(0)} move=${movePct}%)`
  );
}

// ---- Public API --------------------------------------------------------------

export function startHFMaker(): void {
  if (running) return;
  running = true;

  connectBinance();

  void scanWindows();
  windowScanInterval = setInterval(() => void scanWindows(), WINDOW_SCAN_INTERVAL_MS);

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
  windowTraded.clear();
  for (const timer of paperFillTimers.values()) clearTimeout(timer);
  paperFillTimers.clear();
  console.log("[HFMaker] Data reset");
}
