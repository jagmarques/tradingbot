/**
 * HF Maker: Late-entry strategy on Polymarket 15-min crypto up/down markets.
 * Waits until last 45s of window when direction is ~85%+ determined,
 * places maker order at high confidence price. Zero maker fees + rebates.
 * Runs 3 simultaneous instances: live 0.3%, paper 0.2%, paper 0.1%.
 */

import WebSocket from "ws";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";
import { isPolymarketPaperMode } from "../../config/env.js";
import { placeGtcMakerOrder, cancelOrder, getOrderStatus } from "../polygon/polymarket.js";
import { saveHFMakerTrade, loadOpenHFMakerTrades, saveHFMakerBalance, loadHFMakerBalance, getHFMakerDbStats, loadAllHFMakerTrades } from "../database/hf-maker.js";
import { ethers } from "ethers";
import { loadEnv } from "../../config/env.js";
import { notifyHFMakerEntry, notifyHFMakerResult } from "../telegram/notifications.js";

// USDC.e on Polygon (what Polymarket CLOB uses)
const USDC_E_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

async function fetchOnChainUsdcE(): Promise<number> {
  const env = loadEnv();
  const provider = new ethers.JsonRpcProvider(env.RPC_URL_POLYGON);
  const wallet = new ethers.Wallet(env.POLYGON_PRIVATE_KEY, provider);
  const usdc = new ethers.Contract(USDC_E_CONTRACT, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await usdc.balanceOf(wallet.address);
  return Number(bal) / 1e6;
}

function isHFMakerPaper(): boolean {
  if (process.env.HF_MAKER_LIVE === "true") return false;
  return isPolymarketPaperMode();
}

// ---- Constants ---------------------------------------------------------------

const POSITION_PCT = 0.30; // 30% of balance per trade
const MAX_CONCURRENT_TRADES = 3;
const MIN_TRADE_SIZE = 5; // Polymarket CLOB minimum is 5 shares
const HEARTBEAT_INTERVAL_MS = 5000;
const WINDOW_SCAN_INTERVAL_MS = 60_000;
const MAX_TRADES = 500;
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m/ethusdt@kline_1m/solusdt@kline_1m";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// Late-entry strategy params
const ENTRY_WINDOW_SECS = 60; // enter in last 60s of window
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

interface HFMakerInstance {
  id: string;          // 'live-0.1', 'paper-0.2', 'paper-0.3'
  label: string;       // 'LIVE 0.3%', 'Paper 0.2%', 'Paper 0.1%'
  paper: boolean;
  minMovePct: number;  // 0.003, 0.002, 0.001
  trades: HFMakerTrade[];
  balance: number;
  windowTraded: Set<string>;
  paperFillTimers: Map<string, NodeJS.Timeout>;
  activeOrders: Map<string, string>;
}

// ---- Shared State (one Binance WS, one window scan) -------------------------

let running = false;
let binanceConnected = false;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let windowScanInterval: NodeJS.Timeout | null = null;

const latestPrices = new Map<string, number>();
const activeWindows = new Map<string, ActiveWindow>();

// ---- Per-Instance State ------------------------------------------------------

const instances = new Map<string, HFMakerInstance>();

function createInstances(): void {
  instances.set('live-0.1', {
    id: 'live-0.1', label: 'LIVE 0.1%', paper: isHFMakerPaper(),
    minMovePct: 0.001, trades: [], balance: 0,
    windowTraded: new Set(), paperFillTimers: new Map(), activeOrders: new Map(),
  });
  instances.set('paper-0.2', {
    id: 'paper-0.2', label: 'Paper 0.2%', paper: true,
    minMovePct: 0.002, trades: [], balance: 0,
    windowTraded: new Set(), paperFillTimers: new Map(), activeOrders: new Map(),
  });
  instances.set('paper-0.3', {
    id: 'paper-0.3', label: 'Paper 0.3%', paper: true,
    minMovePct: 0.003, trades: [], balance: 0,
    windowTraded: new Set(), paperFillTimers: new Map(), activeOrders: new Map(),
  });
}

// ---- Per-Instance Helpers ----------------------------------------------------

function getOpenTradeCount(inst: HFMakerInstance): number {
  return inst.trades.filter(t => t.status === "pending" || t.status === "open").length;
}

function getAvailableBalance(inst: HFMakerInstance): number {
  if (!inst.paper) {
    // Live: balance = on-chain USDC.e (already reflects open positions)
    return inst.balance;
  }
  // Paper: balance tracks resolved cash, open trades are reserved
  const reservedSize = inst.trades
    .filter(t => t.status === "pending" || t.status === "open")
    .reduce((s, t) => s + t.size, 0);
  return inst.balance - reservedSize;
}

function calcPositionSize(inst: HFMakerInstance): number {
  const available = getAvailableBalance(inst);
  const size = Math.floor(available * POSITION_PCT * 100) / 100;
  return size >= MIN_TRADE_SIZE ? size : 0;
}

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

  latestPrices.set(coin, price);

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

    // Clear expired windows from shared map and per-instance windowTraded
    for (const [key, w] of activeWindows) {
      if (w.endTime <= Date.now()) {
        activeWindows.delete(key);
        for (const inst of instances.values()) {
          inst.windowTraded.delete(key);
        }
      }
    }

    for (const coin of coins) {
      try {
        const slug = `${coin}-updown-15m-${windowTs}`;
        const key = `${coin.toUpperCase()}-${windowTs}`;

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

// ---- Late-Entry Check (per instance, runs every heartbeat) -------------------

async function checkLateEntry(inst: HFMakerInstance): Promise<void> {
  const now = Date.now();

  for (const [key, window] of activeWindows) {
    if (!window.startPrice) continue;
    if (inst.windowTraded.has(key) && ONE_TRADE_PER_WINDOW) continue;

    const secsLeft = (window.endTime - now) / 1000;

    if (secsLeft > ENTRY_WINDOW_SECS || secsLeft <= 5) continue;

    const currentPrice = latestPrices.get(window.coin);
    if (!currentPrice) continue;

    const movePct = (currentPrice - window.startPrice) / window.startPrice;
    const absMove = Math.abs(movePct);

    // Only log moves from live instance to avoid 3x log spam
    if (!inst.paper) {
      console.log(`[HFMaker] ${window.coin} move=${(movePct * 100).toFixed(3)}% (need ${(inst.minMovePct * 100).toFixed(1)}%) ${secsLeft.toFixed(0)}s left`);
    }

    if (absMove < inst.minMovePct) continue;

    const direction: "up" | "down" = movePct > 0 ? "up" : "down";

    let entryPrice: number;
    if (absMove >= STRONG_MOVE_PCT) {
      entryPrice = 0.80;
    } else if (absMove >= 0.005) {
      entryPrice = 0.75;
    } else {
      entryPrice = 0.70;
    }

    if (getOpenTradeCount(inst) >= MAX_CONCURRENT_TRADES) continue;

    // Refresh on-chain balance before sizing (live mode only)
    if (!inst.paper) {
      try { inst.balance = await fetchOnChainUsdcE(); } catch { /* use cached */ }
    }
    const posSize = calcPositionSize(inst);
    if (posSize <= 0) continue;

    void placeLateEntryTrade(inst, window, key, direction, entryPrice, currentPrice, absMove, posSize);
  }
}

async function placeLateEntryTrade(
  inst: HFMakerInstance,
  window: ActiveWindow,
  windowKey: string,
  direction: "up" | "down",
  entryPrice: number,
  currentBinancePrice: number,
  moveMagnitude: number,
  positionSize: number,
): Promise<void> {
  inst.windowTraded.add(windowKey);

  const tokenId = direction === "up" ? window.yesTokenId : window.noTokenId;
  const shares = positionSize / entryPrice;
  const tradeId = `hfm_${inst.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const secsLeft = ((window.endTime - Date.now()) / 1000).toFixed(0);

  console.log(
    `[HFMaker:${inst.id}] LATE-ENTRY ${window.coin} ${direction.toUpperCase()} ` +
    `@${(entryPrice * 100).toFixed(0)}c $${positionSize.toFixed(2)} ` +
    `(${(POSITION_PCT * 100).toFixed(0)}% of $${inst.balance.toFixed(2)}) ` +
    `move=${(moveMagnitude * 100).toFixed(2)}% ${secsLeft}s left`
  );

  const trade: HFMakerTrade = {
    id: tradeId,
    coin: window.coin,
    side: direction,
    entryPrice,
    shares,
    size: positionSize,
    entryTime: Date.now(),
    windowEnd: window.endTime,
    windowStartPrice: window.startPrice!,
    binancePriceAtEntry: currentBinancePrice,
    momentumMagnitude: moveMagnitude,
    status: "pending",
    pnl: 0,
  };

  inst.trades.push(trade);
  saveHFMakerBalance(inst.balance, inst.id);

  while (inst.trades.length > MAX_TRADES) {
    const idx = inst.trades.findIndex(t => t.status !== "pending" && t.status !== "open");
    if (idx >= 0) inst.trades.splice(idx, 1);
    else break;
  }

  if (inst.paper) {
    trade.status = "open";
    saveHFMakerTrade(trade, inst.id);
    console.log(`[HFMaker:${inst.id}] FILL (paper) ${trade.coin} ${trade.side} @${(trade.entryPrice * 100).toFixed(0)}c`);
  } else {
    // Live: GTC maker order (zero fees, fills via MINT matching)
    // These markets have no CLOB depth - FOK fails. GTC rests on book
    // and gets filled when someone buys the opposite side (MINT match).
    try {
      const shares = (positionSize / entryPrice).toFixed(2);
      const order = await placeGtcMakerOrder(tokenId, "BUY", entryPrice.toFixed(2), shares);
      if (order) {
        trade.orderId = order.id;
        if (order.status === "MATCHED") {
          // Filled immediately (crossed existing liquidity)
          trade.status = "open";
          if (order.fillPrice) trade.entryPrice = order.fillPrice;
          if (order.actualShares) trade.shares = order.actualShares;
          if (order.actualCost) trade.size = order.actualCost;
        } else {
          // Resting on book as maker, waiting for MINT match
          trade.status = "pending";
        }
        inst.activeOrders.set(order.id, tradeId);
        saveHFMakerTrade(trade, inst.id);
        console.log(`[HFMaker:${inst.id}] GTC ${order.status}: ${order.id} ${shares} shares @ ${(entryPrice * 100).toFixed(0)}c`);
        if (trade.status === "open") {
          void notifyHFMakerEntry({
            coin: trade.coin, side: trade.side, size: trade.size,
            entryPrice: trade.entryPrice, movePct: trade.momentumMagnitude,
            balance: inst.balance, orderId: order.id,
          });
        }
      } else {
        trade.status = "cancelled";
        saveHFMakerTrade(trade, inst.id);
        console.log(`[HFMaker:${inst.id}] GTC order rejected`);
      }
    } catch (err) {
      trade.status = "cancelled";
      saveHFMakerTrade(trade, inst.id);
      console.error(`[HFMaker:${inst.id}] Order error:`, err);
    }
  }
}

// ---- Pending Order Fill Check ------------------------------------------------

async function checkPendingFill(inst: HFMakerInstance, trade: HFMakerTrade): Promise<void> {
  if (!trade.orderId) return;
  try {
    const status = await getOrderStatus(trade.orderId);
    if (!status) return;
    const matched = parseFloat(status.sizeMatched);
    if (matched > 0) {
      trade.status = "open";
      trade.shares = matched;
      trade.size = matched * trade.entryPrice;
      saveHFMakerTrade(trade, inst.id);
      // Cancel remainder if partially filled
      void cancelOrder(trade.orderId);
      console.log(`[HFMaker:${inst.id}] GTC FILLED: ${trade.coin} ${trade.side} ${matched.toFixed(1)} shares @ ${(trade.entryPrice * 100).toFixed(0)}c`);
      void notifyHFMakerEntry({
        coin: trade.coin, side: trade.side, size: trade.size,
        entryPrice: trade.entryPrice, movePct: trade.momentumMagnitude,
        balance: inst.balance, orderId: trade.orderId!,
      });
    }
  } catch { /* non-critical, retry next heartbeat */ }
}

// ---- Heartbeat ---------------------------------------------------------------

function runHeartbeat(): void {
  const now = Date.now();

  for (const inst of instances.values()) {
    void checkLateEntry(inst);

    for (const trade of inst.trades) {
      if (trade.status === "open" && now >= trade.windowEnd) {
        void resolvePosition(inst, trade);
        continue;
      }

      // Check if pending GTC order got filled (MINT match)
      if (trade.status === "pending" && trade.orderId && !inst.paper) {
        if (now >= trade.windowEnd) {
          // Window ended, cancel unfilled order
          trade.status = "cancelled";
          saveHFMakerTrade(trade, inst.id);
          inst.activeOrders.delete(trade.orderId);
          void cancelOrder(trade.orderId);
          console.log(`[HFMaker:${inst.id}] Order expired: ${trade.coin} ${trade.side}`);
        } else {
          // Check fill status every heartbeat
          void checkPendingFill(inst, trade);
        }
        continue;
      }

      // Paper pending -> cancel at window end
      if (trade.status === "pending" && now >= trade.windowEnd) {
        trade.status = "cancelled";
        saveHFMakerTrade(trade, inst.id);
        console.log(`[HFMaker:${inst.id}] Order expired: ${trade.coin} ${trade.side}`);
      }
    }

    const openOrders = inst.trades.filter(t => t.status === "pending").length;
    const openPositions = inst.trades.filter(t => t.status === "open").length;
    if (openOrders > 0 || openPositions > 0) {
      console.log(`[HFMaker:${inst.id}] Heartbeat: ${openOrders} orders, ${openPositions} positions`);
    }
  }
}

// ---- Position Resolution -----------------------------------------------------

async function resolvePosition(inst: HFMakerInstance, trade: HFMakerTrade): Promise<void> {
  const currentBinancePrice = latestPrices.get(trade.coin) ?? 0;
  trade.binancePriceAtClose = currentBinancePrice;

  if (currentBinancePrice <= 0 || trade.windowStartPrice <= 0) {
    trade.status = "cancelled";
    saveHFMakerTrade(trade, inst.id);
    console.log(`[HFMaker:${inst.id}] CANCEL ${trade.coin} ${trade.side} (missing price data)`);
    return;
  }

  const priceDiff = currentBinancePrice - trade.windowStartPrice;
  const priceUp = priceDiff > 0;
  const priceDown = priceDiff < 0;
  const directionMatched =
    (trade.side === "up" && priceUp) || (trade.side === "down" && (priceDown || priceDiff === 0));

  if (directionMatched) {
    const payout = trade.shares * 1.0;
    trade.pnl = payout - trade.size;
    trade.status = "won";
  } else {
    trade.pnl = -trade.size;
    trade.status = "lost";
  }

  if (inst.paper) {
    if (directionMatched) {
      inst.balance += trade.pnl;
    } else {
      inst.balance -= trade.size;
    }
  } else {
    try { inst.balance = await fetchOnChainUsdcE(); } catch { /* use cached */ }
  }

  saveHFMakerTrade(trade, inst.id);
  saveHFMakerBalance(inst.balance, inst.id);

  const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
  const movePct = trade.windowStartPrice > 0
    ? (((currentBinancePrice - trade.windowStartPrice) / trade.windowStartPrice) * 100).toFixed(2)
    : "?";
  console.log(
    `[HFMaker:${inst.id}] ${trade.status.toUpperCase()} ${trade.coin} ${trade.side} ${pnlStr} ` +
    `(start=$${trade.windowStartPrice.toFixed(0)} close=$${currentBinancePrice.toFixed(0)} move=${movePct}%)`
  );

  // Only send Telegram notifications for live instance
  if (!inst.paper) {
    void notifyHFMakerResult({
      coin: trade.coin, side: trade.side, status: trade.status as "won" | "lost" | "cancelled",
      size: trade.size, pnl: trade.pnl, balance: inst.balance,
      startPrice: trade.windowStartPrice, closePrice: currentBinancePrice,
    });
  }
}

// ---- Public API --------------------------------------------------------------

export async function startHFMaker(): Promise<void> {
  if (running) return;
  running = true;

  createInstances();

  for (const inst of instances.values()) {
    if (!inst.paper) {
      // Live: fetch on-chain balance
      try {
        inst.balance = await fetchOnChainUsdcE();
        console.log(`[HFMaker:${inst.id}] On-chain USDC.e balance: $${inst.balance.toFixed(2)}`);
      } catch (err) {
        const savedBalance = loadHFMakerBalance(inst.id);
        inst.balance = savedBalance ?? 0;
        console.log(`[HFMaker:${inst.id}] DB balance (chain fetch failed): $${inst.balance.toFixed(2)}`);
      }
    } else {
      // Paper: load from DB, fallback to $100 virtual bankroll
      const savedBalance = loadHFMakerBalance(inst.id);
      inst.balance = savedBalance ?? parseFloat(process.env.HF_MAKER_INITIAL_BALANCE || "100");
      console.log(`[HFMaker:${inst.id}] Paper balance: $${inst.balance.toFixed(2)}`);
    }
    saveHFMakerBalance(inst.balance, inst.id);

    const openTrades = loadOpenHFMakerTrades(inst.id);
    if (openTrades.length > 0) {
      inst.trades.push(...openTrades);
      console.log(`[HFMaker:${inst.id}] Restored ${openTrades.length} open trades from DB`);
    }
  }

  // One shared Binance WS
  connectBinance();

  // One shared window scan
  void scanWindows();
  windowScanInterval = setInterval(() => void scanWindows(), WINDOW_SCAN_INTERVAL_MS);

  // One shared heartbeat (iterates all instances internally)
  heartbeatInterval = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

  const liveInst = instances.get('live-0.1')!;
  console.log(`[HFMaker] Started (${instances.size} instances, paper=${liveInst.paper}, balance=$${liveInst.balance.toFixed(2)}, ${POSITION_PCT * 100}%/trade, max ${MAX_CONCURRENT_TRADES} concurrent)`);
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

  for (const inst of instances.values()) {
    for (const timer of inst.paperFillTimers.values()) clearTimeout(timer);
    inst.paperFillTimers.clear();
  }
  instances.clear();

  console.log("[HFMaker] Stopped");
}

export function getHFMakerStats(instanceId?: string): {
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
  const instId = instanceId ?? 'live-0.1';
  const inst = instances.get(instId);
  if (!inst) {
    return { balance: 0, totalTrades: 0, openOrders: 0, openPositions: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, recentTrades: [] };
  }

  // Use DB for historical stats (survives redeploys)
  const dbStats = getHFMakerDbStats(instId);

  // Use in-memory for live open state
  const openOrders = inst.trades.filter(t => t.status === "pending").length;
  const openPositions = inst.trades.filter(t => t.status === "open").length;

  // Recent trades: merge in-memory open + DB closed (last 10)
  const dbRecent = loadAllHFMakerTrades(instId).slice(0, 10);
  const openTrades = inst.trades.filter(t => t.status === "pending" || t.status === "open");
  const seen = new Set(openTrades.map(t => t.id));
  const merged = [...openTrades, ...dbRecent.filter(t => !seen.has(t.id))].slice(0, 10);

  return {
    balance: inst.balance,
    totalTrades: dbStats.totalTrades + openOrders + openPositions,
    openOrders,
    openPositions,
    wins: dbStats.wins,
    losses: dbStats.losses,
    winRate: dbStats.winRate,
    totalPnl: dbStats.totalPnl,
    recentTrades: merged,
  };
}

export function getAllHFMakerStats(): Array<{
  instanceId: string;
  label: string;
  paper: boolean;
  stats: ReturnType<typeof getHFMakerStats>;
}> {
  return [...instances.values()].map(inst => ({
    instanceId: inst.id,
    label: inst.label,
    paper: inst.paper,
    stats: getHFMakerStats(inst.id),
  }));
}

export function getHFMakerStatus(): {
  running: boolean;
  binanceConnected: boolean;
  activeWindows: number;
  trackedPairs: string[];
  instances: number;
} {
  return {
    running,
    binanceConnected,
    activeWindows: activeWindows.size,
    trackedPairs: [...new Set([...activeWindows.values()].map(w => w.coin))],
    instances: instances.size,
  };
}

export function resetHFMakerData(): void {
  for (const inst of instances.values()) {
    inst.trades.length = 0;
    inst.balance = 0;
    inst.activeOrders.clear();
    inst.windowTraded.clear();
    for (const timer of inst.paperFillTimers.values()) clearTimeout(timer);
    inst.paperFillTimers.clear();
  }
  console.log("[HFMaker] Data reset");
}
