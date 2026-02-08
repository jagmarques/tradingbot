// Polymarket Top Trader Tracker
// Monitors top profitable traders and copies their bets

import { notifyTopTraderCopy, notifyTopTraderCopyClose } from "../telegram/notifications.js";
import { placeFokOrder } from "../polygon/polymarket.js";
import { isPaperMode } from "../../config/env.js";
import { getDb } from "../database/db.js";
import { ESTIMATED_GAS_FEE_MATIC, ESTIMATED_SLIPPAGE_POLYMARKET } from "../../config/constants.js";
import { getSettings } from "../settings/settings.js";
import { getChatId } from "../telegram/bot.js";
import { parseDate, minutesUntil, hoursUntil } from "../../utils/dates.js";
import { filterPolyCopy } from "../copy/filter.js";
import { canTrade } from "../risk/manager.js";

const DATA_API_URL = "https://data-api.polymarket.com/v1";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// Categories with long-dated markets (weeks/months, not hours like sports)
const COPY_CATEGORIES = ["POLITICS", "CRYPTO", "ECONOMICS", "CULTURE"];
const TRADERS_PER_CATEGORY = 10;

// Default copy size if no user settings
const DEFAULT_COPY_SIZE_USD = 5;

// Get copy size from user settings
function getCopySizeUsd(): number {
  const chatId = getChatId();
  if (!chatId) return DEFAULT_COPY_SIZE_USD;
  const settings = getSettings(chatId);
  return settings.polymarketCopyUsd;
}

interface LeaderboardEntry {
  rank: number;
  proxyWallet: string;
  userName: string | null;
  vol: number;
  pnl: number;
  profileImage: string | null;
}

interface TraderActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  side: string;           // "BUY" or "SELL"
  outcome: string;        // e.g. "Predators", "Yes", "No"
  outcomeIndex: number;   // 0 or 1 - which token they bought
  size: number;
  usdcSize: number;
  price: number;
  title?: string;
  slug?: string;
}

// Track top traders and their last seen activity
const trackedTraders = new Map<string, { name: string; lastSeen: number; pnl: number; vol: number }>();
let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;
let isCheckingTrades = false;

const resolvedMarketCache = new Set<string>();
const gammaNotFoundCache = new Set<string>();

const LEARNING_THRESHOLD = 30;

// Copied position tracking
interface CopiedPosition {
  id: string;
  traderWallet: string;
  traderName: string;
  conditionId: string;
  marketTitle: string;
  tokenId: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  traderSize: number;
  status: "open" | "closed";
  entryTimestamp: number;
  exitTimestamp?: number;
  exitPrice?: number;
  pnl?: number;
}

// In-memory positions (also persisted to DB)
const copiedPositions = new Map<string, CopiedPosition>();

function initCopyTradesTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS polytrader_copies (
      id TEXT PRIMARY KEY,
      trader_wallet TEXT NOT NULL,
      trader_name TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      trader_size REAL NOT NULL,
      status TEXT NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      exit_timestamp INTEGER,
      exit_price REAL,
      pnl REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_polytrader_copies_status ON polytrader_copies(status);
    CREATE INDEX IF NOT EXISTS idx_polytrader_copies_trader ON polytrader_copies(trader_wallet);
    CREATE TABLE IF NOT EXISTS copy_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trader_name TEXT NOT NULL,
      market_title TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      pnl REAL NOT NULL,
      won INTEGER NOT NULL,
      resolution_ms INTEGER NOT NULL,
      trader_roi REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_copy_outcomes_trader ON copy_outcomes(trader_name);
  `);
}

function saveCopyOutcome(pos: CopiedPosition, pnl: number): void {
  const db = getDb();
  const won = pnl > 0 ? 1 : 0;
  const resolutionMs = (pos.exitTimestamp ?? Date.now()) - pos.entryTimestamp;
  const traderInfo = Array.from(trackedTraders.values()).find(t => t.name === pos.traderName);
  const traderRoi = traderInfo && traderInfo.vol > 0 ? traderInfo.pnl / traderInfo.vol : null;

  db.prepare(`
    INSERT INTO copy_outcomes (trader_name, market_title, entry_price, size, pnl, won, resolution_ms, trader_roi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pos.traderName, pos.marketTitle, pos.entryPrice, pos.size, pnl, won, resolutionMs, traderRoi);
}

interface CopyLearningStats {
  totalTrades: number;
  wins: number;
  netPnl: number;
  traderStats: Map<string, { wins: number; total: number; pnl: number }>;
}

function getCopyLearningStats(): CopyLearningStats {
  const db = getDb();
  const rows = db.prepare(`SELECT trader_name, won, pnl FROM copy_outcomes`).all() as Array<{
    trader_name: string; won: number; pnl: number;
  }>;

  const stats: CopyLearningStats = {
    totalTrades: rows.length,
    wins: rows.filter(r => r.won).length,
    netPnl: rows.reduce((sum, r) => sum + r.pnl, 0),
    traderStats: new Map(),
  };

  for (const row of rows) {
    const existing = stats.traderStats.get(row.trader_name) ?? { wins: 0, total: 0, pnl: 0 };
    existing.total++;
    if (row.won) existing.wins++;
    existing.pnl += row.pnl;
    stats.traderStats.set(row.trader_name, existing);
  }

  return stats;
}

function getTraderMultiplierFromHistory(traderName: string): number | null {
  const stats = getCopyLearningStats();
  if (stats.totalTrades < LEARNING_THRESHOLD) return null;

  const traderData = stats.traderStats.get(traderName);
  if (!traderData || traderData.total < 3) return null;

  const winRate = traderData.wins / traderData.total;
  if (winRate >= 0.60) return 1.5;
  if (winRate >= 0.45) return 1.0;
  if (winRate >= 0.30) return 0.5;
  return 0;
}

function saveCopiedPosition(pos: CopiedPosition): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO polytrader_copies (
      id, trader_wallet, trader_name, condition_id, market_title, token_id, side,
      entry_price, size, trader_size, status, entry_timestamp, exit_timestamp, exit_price, pnl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pos.id, pos.traderWallet, pos.traderName, pos.conditionId, pos.marketTitle,
    pos.tokenId, pos.side, pos.entryPrice, pos.size, pos.traderSize, pos.status,
    pos.entryTimestamp, pos.exitTimestamp || null, pos.exitPrice || null, pos.pnl || null
  );
}

function loadOpenCopiedPositions(): CopiedPosition[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM polytrader_copies WHERE status = 'open'`).all() as Array<{
    id: string;
    trader_wallet: string;
    trader_name: string;
    condition_id: string;
    market_title: string;
    token_id: string;
    side: string;
    entry_price: number;
    size: number;
    trader_size: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    traderWallet: r.trader_wallet,
    traderName: r.trader_name,
    conditionId: r.condition_id,
    marketTitle: r.market_title,
    tokenId: r.token_id,
    side: r.side as "BUY" | "SELL",
    entryPrice: r.entry_price,
    size: r.size,
    traderSize: r.trader_size,
    status: r.status as "open" | "closed",
    entryTimestamp: r.entry_timestamp,
    exitTimestamp: r.exit_timestamp || undefined,
    exitPrice: r.exit_price || undefined,
    pnl: r.pnl || undefined,
  }));
}

export function clearAllCopiedPositions(): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM polytrader_copies`).run();
  copiedPositions.clear();
  console.log(`[PolyTraders] Cleared ${result.changes} copied positions`);
  return result.changes;
}

// Close all open positions - only count P&L for resolved markets (manual closes don't count)
export async function closeAllOpenPositions(): Promise<{ closed: number; totalPnl: number; results: Array<{ title: string; pnl: number; resolved: boolean }> }> {
  const openPositions = getOpenCopiedPositions();
  const results: Array<{ title: string; pnl: number; resolved: boolean }> = [];
  let totalPnl = 0;

  for (const pos of openPositions) {
    // Check if market resolved first
    const resolution = await checkMarketResolution(pos.tokenId);
    let exitPrice: number;
    let pnl: number;
    let resolved = false;

    if (resolution.resolved && resolution.finalPrice !== null) {
      // Market resolved - count real P&L
      exitPrice = resolution.finalPrice;
      const shares = pos.size / pos.entryPrice;
      pnl = (shares * exitPrice) - pos.size;
      resolved = true;
      totalPnl += pnl;
      console.log(`[PolyTraders] Resolved: ${pos.marketTitle} @ ${(exitPrice * 100).toFixed(0)}c, PnL: $${pnl.toFixed(2)}`);
    } else {
      // Manual close - don't count P&L (set to 0)
      const currentPrice = await getCurrentPrice(pos.tokenId);
      exitPrice = currentPrice ?? pos.entryPrice;
      pnl = 0; // Manual close doesn't count
      console.log(`[PolyTraders] Manual close: ${pos.marketTitle} (P&L not counted)`);
    }

    // Update position
    pos.status = "closed";
    pos.exitTimestamp = Date.now();
    pos.exitPrice = exitPrice;
    pos.pnl = pnl;

    saveCopiedPosition(pos);
    copiedPositions.delete(pos.id);

    results.push({ title: pos.marketTitle, pnl, resolved });

    await new Promise(r => setTimeout(r, 200));
  }

  return { closed: results.length, totalPnl, results };
}

interface MarketInfo {
  tokenId: string;
  closed: boolean;
  endDate: string | null;
}

const MIN_MINUTES_BEFORE_END = 30;

// Maximum age of trades to process (ignore trades older than this)
const MAX_TRADE_AGE_MS = 5 * 60 * 1000;

type GammaMarketResult = {
  conditionId: string;
  clobTokenIds: string;
  closed: boolean;
  active: boolean;
  acceptingOrders: boolean;
  endDate: string;
};

function extractMarketInfo(market: GammaMarketResult, outcomeIndex: number): MarketInfo | null {
  const tokenIds = JSON.parse(market.clobTokenIds) as string[];
  if (outcomeIndex < 0 || outcomeIndex >= tokenIds.length) return null;
  return {
    tokenId: tokenIds[outcomeIndex],
    closed: market.acceptingOrders === false,
    endDate: market.endDate || null,
  };
}

async function getMarketInfo(conditionId: string, outcomeIndex: number, slug?: string): Promise<MarketInfo | null> {
  if (gammaNotFoundCache.has(conditionId)) return null;

  try {
    // Try conditionId lookup first
    const response = await fetch(`${GAMMA_API_URL}/markets?conditionId=${conditionId}`);
    if (response.ok) {
      const markets = await response.json() as GammaMarketResult[];
      const cid = conditionId.toLowerCase();
      const market = markets.find(m => m.conditionId?.toLowerCase() === cid);
      if (market) return extractMarketInfo(market, outcomeIndex);
    }

    // Fallback: try slug lookup
    if (slug) {
      const slugResponse = await fetch(`${GAMMA_API_URL}/markets?slug=${encodeURIComponent(slug)}`);
      if (slugResponse.ok) {
        const slugMarkets = await slugResponse.json() as GammaMarketResult[];
        if (slugMarkets.length > 0) return extractMarketInfo(slugMarkets[0], outcomeIndex);
      }
    }

    // Neither worked - cache to avoid repeated lookups
    gammaNotFoundCache.add(conditionId);
    return null;
  } catch {
    return null;
  }
}

async function copyTrade(
  trade: TraderActivity,
  traderInfo: { name: string; pnl: number },
  preValidatedMarket: MarketInfo,
  overrideSizeUsd?: number,
): Promise<CopiedPosition | null> {
  // Skip markets ending very soon
  if (preValidatedMarket.endDate) {
    const mins = minutesUntil(preValidatedMarket.endDate);
    if (mins !== null && mins < MIN_MINUTES_BEFORE_END) {
      console.log(`[PolyTraders] Skipping market ${mins < 0 ? "ended" : `ending in ${mins.toFixed(0)}min`}: ${trade.title}`);
      return null;
    }
  }

  const tokenId = preValidatedMarket.tokenId;

  const positionId = `copy_${trade.conditionId}_${Date.now()}`;

  const copySizeUsd = overrideSizeUsd ?? getCopySizeUsd();

  if (isPaperMode()) {
    console.log(`[PolyTraders] PAPER COPY: ${trade.outcome} ${trade.title} @ ${(trade.price * 100).toFixed(0)}c ($${copySizeUsd})`);
  } else {
      try {
      const order = await placeFokOrder(
        tokenId,
        "BUY",
        trade.price.toFixed(4),
        copySizeUsd.toFixed(2)
      );
      if (!order) {
        console.error(`[PolyTraders] Copy order failed for ${trade.title}`);
        return null;
      }
      console.log(`[PolyTraders] LIVE COPY: ${trade.outcome} ${trade.title} @ ${(trade.price * 100).toFixed(0)}c - Order ${order.id}`);
    } catch (error) {
      console.error(`[PolyTraders] Copy order error:`, error);
      return null;
    }
  }

  const position: CopiedPosition = {
    id: positionId,
    traderWallet: trade.proxyWallet,
    traderName: traderInfo.name,
    conditionId: trade.conditionId,
    marketTitle: trade.title || "Unknown",
    tokenId,
    side: "BUY",
    entryPrice: trade.price,
    size: copySizeUsd,
    traderSize: trade.usdcSize,
    status: "open",
    entryTimestamp: Date.now(),
  };

  copiedPositions.set(positionId, position);
  saveCopiedPosition(position);

  return position;
}

export async function fetchTopTraders(
  category: string = "OVERALL",
  timePeriod: string = "MONTH",
  limit: number = 20
): Promise<LeaderboardEntry[]> {
  try {
    const url = `${DATA_API_URL}/leaderboard?category=${category}&timePeriod=${timePeriod}&orderBy=PNL&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Leaderboard API error: ${response.status}`);
    }

    return (await response.json()) as LeaderboardEntry[];
  } catch (error) {
    console.error("[PolyTraders] Failed to fetch leaderboard:", error);
    return [];
  }
}

export async function fetchTraderActivity(
  wallet: string,
  limit: number = 10
): Promise<TraderActivity[]> {
  try {
    const url = `${DATA_API_URL}/activity?user=${wallet}&limit=${limit}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Activity API error: ${response.status}`);
    }

    return (await response.json()) as TraderActivity[];
  } catch (error) {
    console.error(`[PolyTraders] Failed to fetch activity for ${wallet}:`, error);
    return [];
  }
}

async function checkForNewTrades(): Promise<void> {
  if (isCheckingTrades) return;
  isCheckingTrades = true;

  try {
    if (!canTrade()) {
      console.log("[PolyTraders] Kill switch active, skipping cycle");
      return;
    }

    if (trackedTraders.size === 0) {
      await refreshTopTraders();
      console.log(`[PolyTraders] Tracking ${trackedTraders.size} top traders`);
      return;
    }

    let newTrades = 0;
    let filtered = 0;
    let copied = 0;
    const skipReasons: Record<string, number> = {};

    function skip(reason: string): void {
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      filtered++;
    }

    for (const [wallet, info] of trackedTraders) {
      try {
        const activity = await fetchTraderActivity(wallet, 5);

        for (const trade of activity) {
          const tradeTime = trade.timestamp * 1000;
          const tradeAge = Date.now() - tradeTime;

          if (tradeAge > MAX_TRADE_AGE_MS) continue;
          if (tradeTime <= info.lastSeen) continue;

          info.lastSeen = Math.max(info.lastSeen, tradeTime);

          if (trade.type !== "TRADE" || trade.side !== "BUY" || trade.usdcSize < 25 || trade.size <= 0) {
            if (trade.type === "TRADE" && trade.side === "BUY" && trade.usdcSize < 25) {
              skip("too_small");
            }
            continue;
          }

          newTrades++;

          if (resolvedMarketCache.has(trade.conditionId)) {
            skip("resolved");
            continue;
          }

          const alreadyCopied = Array.from(copiedPositions.values()).some(
            p => p.conditionId === trade.conditionId,
          );
          if (alreadyCopied) {
            skip("dedup");
            continue;
          }

          const marketInfo = await getMarketInfo(trade.conditionId, trade.outcomeIndex, trade.slug);
          if (!marketInfo) {
            skip("market_not_found");
            continue;
          }
          if (marketInfo.closed) {
            resolvedMarketCache.add(trade.conditionId);
            skip("market_closed");
            console.log(`[PolyTraders] ${info.name} traded closed market: ${trade.title}`);
            continue;
          }

          const traderRoi = info.vol > 0 ? info.pnl / info.vol : 0;

          const hoursToRes = hoursUntil(marketInfo.endDate);
          const ttrLabel = hoursToRes !== null ? `${hoursToRes.toFixed(1)}h to res` : "no endDate";

          console.log(`[PolyTraders] New trade by ${info.name} (ROI: ${(traderRoi * 100).toFixed(1)}%): ${trade.outcome} $${trade.usdcSize.toFixed(0)} @ ${(trade.price * 100).toFixed(0)}c on ${trade.title || trade.conditionId} [${ttrLabel}]`);

          const filterResult = filterPolyCopy(traderRoi, trade.usdcSize, trade.price);

          if (!filterResult.shouldCopy) {
            skip("filter");
            console.log(`[PolyTraders] Filter rejected: ${filterResult.reason}`);
          } else {
            const learnedMultiplier = getTraderMultiplierFromHistory(info.name);
            let finalSize = filterResult.recommendedSizeUsd;
            if (learnedMultiplier !== null) {
              if (learnedMultiplier === 0) {
                skip("learning");
                console.log(`[PolyTraders] Learning rejected: ${info.name} has poor copy history`);
                continue;
              }
              finalSize = Math.min(10, filterResult.recommendedSizeUsd * learnedMultiplier);
              console.log(`[PolyTraders] Copying (learned ${learnedMultiplier}x): $${finalSize.toFixed(2)}`);
            } else {
              console.log(`[PolyTraders] Copying ($${trade.usdcSize.toFixed(0)} conviction, ${filterResult.traderQualityMultiplier.toFixed(1)}x quality): $${finalSize.toFixed(2)}`);
            }
            const copiedPos = await copyTrade(trade, info, marketInfo, finalSize);
            if (copiedPos) {
              copied++;
              await notifyTopTraderCopy({
                traderName: info.name,
                marketTitle: copiedPos.marketTitle,
                side: trade.outcome.toUpperCase() === "YES" ? "YES" : "NO",
                size: copiedPos.size,
                entryPrice: copiedPos.entryPrice,
                isPaper: isPaperMode(),
              });
            }
          }
        }

        await new Promise((r) => setTimeout(r, 500));
      } catch (error) {
        console.error(`[PolyTraders] Error checking ${info.name}:`, error);
      }
    }

    if (newTrades > 0 || copied > 0) {
      const reasons = Object.entries(skipReasons).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`[PolyTraders] Cycle: ${newTrades} new trades, ${copied} copied, ${filtered} filtered [${reasons}]`);
    }
  } finally {
    isCheckingTrades = false;
  }
}

async function refreshTopTraders(): Promise<void> {
  // Fetch from each long-dated category in parallel
  const results = await Promise.all(
    COPY_CATEGORIES.map((cat) => fetchTopTraders(cat, "MONTH", TRADERS_PER_CATEGORY))
  );

  // Dedup by wallet, keep best ROI entry
  const best = new Map<string, LeaderboardEntry>();
  for (const traders of results) {
    for (const trader of traders) {
      const wallet = trader.proxyWallet.toLowerCase();
      const roi = trader.vol > 0 ? trader.pnl / trader.vol : 0;
      const existing = best.get(wallet);
      const existingRoi = existing && existing.vol > 0 ? existing.pnl / existing.vol : 0;
      if (!existing || roi > existingRoi) {
        best.set(wallet, trader);
      }
    }
  }

  // Sort by ROI descending, take top 20
  const sorted = [...best.values()]
    .filter((t) => t.vol > 0 && t.pnl / t.vol > 0.05)
    .sort((a, b) => b.pnl / b.vol - a.pnl / a.vol)
    .slice(0, 20);

  // Filter penny-collectors and day-traders by sampling recent trades
  const qualified: typeof sorted = [];
  for (const trader of sorted) {
    const wallet = trader.proxyWallet.toLowerCase();
    const recentTrades = await fetchTraderActivity(wallet, 5);
    const buyTrades = recentTrades.filter(t => t.side === "BUY" && t.price > 0);

    if (buyTrades.length === 0) {
      qualified.push(trader);
      continue;
    }

    const sortedPrices = buyTrades.map(t => t.price).sort((a, b) => a - b);
    const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];

    if (medianPrice > 0.95 || medianPrice < 0.05) {
      console.log(`[PolyTraders] Filtered penny-collector: ${trader.userName || wallet} (median entry: ${(medianPrice * 100).toFixed(0)}c)`);
      continue;
    }

    // Check time-to-expiry: skip traders where >50% of trades are within 2h of resolution
    const uniqueConditions = [...new Set(buyTrades.map(t => t.conditionId))];
    let settlementTrades = 0;
    let expiryChecked = 0;

    for (const conditionId of uniqueConditions.slice(0, 4)) {
      const trade = buyTrades.find(t => t.conditionId === conditionId)!;
      const marketInfo = await getMarketInfo(conditionId, trade.outcomeIndex);
      if (marketInfo?.endDate) {
        const tradeTime = trade.timestamp * 1000;
        const endTime = parseDate(marketInfo.endDate);
        if (endTime === null) continue;
        const hoursToExpiry = (endTime - tradeTime) / (1000 * 60 * 60);
        expiryChecked++;
        if (hoursToExpiry > 0 && hoursToExpiry < 2) settlementTrades++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (expiryChecked >= 2 && settlementTrades / expiryChecked > 0.5) {
      console.log(`[PolyTraders] Filtered settlement-trader: ${trader.userName || wallet} (${settlementTrades}/${expiryChecked} trades <2h to resolution)`);
      continue;
    }

    qualified.push(trader);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[PolyTraders] Refreshed: ${qualified.length} traders from ${COPY_CATEGORIES.join(",")} (ROI-ranked)`);

  for (const trader of qualified) {
    const wallet = trader.proxyWallet.toLowerCase();
    const roi = trader.vol > 0 ? (trader.pnl / trader.vol * 100).toFixed(1) : "0";
    if (!trackedTraders.has(wallet)) {
      trackedTraders.set(wallet, {
        name: trader.userName || trader.proxyWallet.substring(0, 10),
        lastSeen: Date.now() - MAX_TRADE_AGE_MS,
        pnl: trader.pnl,
        vol: trader.vol,
      });
      console.log(`[PolyTraders] Now tracking: ${trader.userName || wallet} (ROI: ${roi}%)`);
    } else {
      const info = trackedTraders.get(wallet);
      if (info) {
        info.pnl = trader.pnl;
        info.vol = trader.vol;
      }
    }
  }
}

export function startPolyTraderTracking(checkIntervalMs: number = 60000): void {
  if (isRunning) return;
  isRunning = true;

  console.log("[PolyTraders] Starting top trader tracking + copy trading...");

  // Initialize DB table
  initCopyTradesTable();

  // Load existing open positions
  const savedPositions = loadOpenCopiedPositions();
  for (const pos of savedPositions) {
    copiedPositions.set(pos.id, pos);
  }
  console.log(`[PolyTraders] Loaded ${savedPositions.length} open copied positions`);

  // Initial check
  checkForNewTrades();

  // Periodic checks
  intervalHandle = setInterval(async () => {
    if (!isRunning) return;
    await checkForNewTrades();
    await checkCopiedPositionExits();
  }, checkIntervalMs);

  // Refresh top traders every hour
  setInterval(async () => {
    if (!isRunning) return;
    await refreshTopTraders();
  }, 60 * 60 * 1000);
}

export function stopPolyTraderTracking(): void {
  if (!isRunning) return;
  isRunning = false;

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  console.log("[PolyTraders] Stopped");
}

export function getTrackedTraders(): Array<{ wallet: string; name: string; pnl: number; vol: number; roi: number }> {
  return Array.from(trackedTraders.entries()).map(([wallet, info]) => ({
    wallet,
    name: info.name,
    pnl: info.pnl,
    vol: info.vol,
    roi: info.vol > 0 ? info.pnl / info.vol : 0,
  }));
}

export function getOpenCopiedPositions(): CopiedPosition[] {
  return Array.from(copiedPositions.values()).filter(p => p.status === "open");
}

export function getClosedCopiedPositions(limit = 10): CopiedPosition[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM polytrader_copies WHERE status = 'closed' ORDER BY exit_timestamp DESC LIMIT ?`
  ).all(limit) as Array<{
    id: string;
    trader_wallet: string;
    trader_name: string;
    condition_id: string;
    market_title: string;
    token_id: string;
    side: string;
    entry_price: number;
    size: number;
    trader_size: number;
    status: string;
    entry_timestamp: number;
    exit_timestamp: number | null;
    exit_price: number | null;
    pnl: number | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    traderWallet: r.trader_wallet,
    traderName: r.trader_name,
    conditionId: r.condition_id,
    marketTitle: r.market_title,
    tokenId: r.token_id,
    side: r.side as "BUY" | "SELL",
    entryPrice: r.entry_price,
    size: r.size,
    traderSize: r.trader_size,
    status: r.status as "open" | "closed",
    entryTimestamp: r.entry_timestamp,
    exitTimestamp: r.exit_timestamp || undefined,
    exitPrice: r.exit_price || undefined,
    pnl: r.pnl || undefined,
  }));
}

export function getCopyStats(): {
  totalCopies: number;
  openPositions: number;
  closedPositions: number;
  totalPnl: number;
  winRate: number;
} {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
      SUM(CASE WHEN status = 'closed' THEN pnl ELSE 0 END) as total_pnl,
      SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM polytrader_copies
  `).get() as {
    total: number;
    open_count: number;
    closed_count: number;
    total_pnl: number;
    wins: number;
  };

  return {
    totalCopies: stats.total || 0,
    openPositions: stats.open_count || 0,
    closedPositions: stats.closed_count || 0,
    totalPnl: stats.total_pnl || 0,
    winRate: stats.closed_count > 0 ? (stats.wins / stats.closed_count) * 100 : 0,
  };
}

// Check if market is resolved and get the final outcome price
async function checkMarketResolution(tokenId: string): Promise<{ resolved: boolean; finalPrice: number | null }> {
  try {
    // Use clob_token_ids (snake_case) to look up market by token ID
    const response = await fetch(`${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`);
    if (!response.ok) return { resolved: false, finalPrice: null };

    const markets = await response.json() as Array<{
      closed: boolean;
      clobTokenIds: string;
      outcomePrices: string;
    }>;

    if (markets.length === 0) return { resolved: false, finalPrice: null };

    const market = markets[0];
    if (!market.closed) return { resolved: false, finalPrice: null };

    // Market is closed - get the final price for our token
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    const idx = tokenIds.indexOf(tokenId);

    if (idx >= 0) {
      const price = parseFloat(prices[idx]);
      // Resolved prices are ~0.00 (lost) or ~1.00 (won)
      return { resolved: true, finalPrice: isNaN(price) ? null : price };
    }

    return { resolved: false, finalPrice: null };
  } catch {
    return { resolved: false, finalPrice: null };
  }
}

// Check if any copied positions should be closed (trader sold OR market resolved)
async function checkCopiedPositionExits(): Promise<void> {
  const openPositions = getOpenCopiedPositions();

  for (const pos of openPositions) {
    // Skip if position was deleted while we were processing
    if (!copiedPositions.has(pos.id)) continue;

    try {
      // First check if market resolved
      const resolution = await checkMarketResolution(pos.tokenId);

      if (resolution.resolved && resolution.finalPrice !== null) {
        // Check again - position might have been deleted
        if (!copiedPositions.has(pos.id)) continue;
        // Market resolved - calculate final P&L
        const exitPrice = resolution.finalPrice;
        const shares = pos.size / pos.entryPrice;
        let pnl = (shares * exitPrice) - pos.size;

        if (isPaperMode()) {
          const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10 * 2;
          const slippageFeeUsd = pos.size * ESTIMATED_SLIPPAGE_POLYMARKET * 2;
          pnl -= (gasFeeUsd + slippageFeeUsd);
        }

        const pnlPct = (pnl / pos.size) * 100;
        const outcome = exitPrice > 0.5 ? "WON" : "LOST";

        pos.status = "closed";
        pos.exitTimestamp = Date.now();
        pos.exitPrice = exitPrice;
        pos.pnl = pnl;

        saveCopiedPosition(pos);
        copiedPositions.delete(pos.id);

        saveCopyOutcome(pos, pnl);
        const stats = getCopyLearningStats();
        console.log(`[PolyTraders] Market resolved ${outcome}: ${pos.marketTitle} PnL: $${pnl.toFixed(2)} (${stats.totalTrades} trades, net: $${stats.netPnl.toFixed(2)})`);

        await notifyTopTraderCopyClose({
          traderName: pos.traderName,
          marketTitle: pos.marketTitle,
          pnl,
          pnlPct,
          isPaper: isPaperMode(),
        });

        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // Check trader's recent activity for sells on this market
      const activity = await fetchTraderActivity(pos.traderWallet, 10);

      for (const trade of activity) {
        if (trade.conditionId !== pos.conditionId) continue;

        // If trader sold (negative size), close our position
        if (trade.size < 0 && trade.timestamp * 1000 > pos.entryTimestamp) {
          // Check if position still exists (might have been deleted)
          if (!copiedPositions.has(pos.id)) break;

          const exitPrice = trade.price;
          const shares = pos.size / pos.entryPrice;
          let pnl = (shares * exitPrice) - pos.size;

          if (isPaperMode()) {
            const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10 * 2;
            const slippageFeeUsd = pos.size * ESTIMATED_SLIPPAGE_POLYMARKET * 2;
            pnl -= (gasFeeUsd + slippageFeeUsd);
          }

          const pnlPct = (pnl / pos.size) * 100;

          pos.status = "closed";
          pos.exitTimestamp = Date.now();
          pos.exitPrice = exitPrice;
          pos.pnl = pnl;

          saveCopiedPosition(pos);
          copiedPositions.delete(pos.id);

          console.log(`[PolyTraders] Closed copy: ${pos.marketTitle} PnL: $${pnl.toFixed(2)}`);

          await notifyTopTraderCopyClose({
            traderName: pos.traderName,
            marketTitle: pos.marketTitle,
            pnl,
            pnlPct,
            isPaper: isPaperMode(),
          });

          break;
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (error) {
      console.error(`[PolyTraders] Error checking exit for ${pos.marketTitle}:`, error);
    }
  }
}

// Fetch current price for a token from Polymarket
const CLOB_API_URL = "https://clob.polymarket.com";

async function getCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    // Try CLOB API first (real-time prices for active markets)
    const clobResponse = await fetch(`${CLOB_API_URL}/midpoint?token_id=${tokenId}`);
    if (clobResponse.ok) {
      const clobData = await clobResponse.json() as { mid?: string; error?: string };
      if (clobData.mid) {
        const price = parseFloat(clobData.mid);
        if (!isNaN(price)) return price;
      }
    }

    // Fall back to GAMMA API for resolved markets (use clob_token_ids snake_case)
    const gammaResponse = await fetch(`${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`);
    if (!gammaResponse.ok) return null;

    const markets = await gammaResponse.json() as Array<{
      clobTokenIds: string;
      outcomePrices: string;
    }>;

    if (markets.length === 0) return null;

    const market = markets[0];
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    const idx = tokenIds.indexOf(tokenId);

    if (idx >= 0) {
      const price = parseFloat(prices[idx]);
      return isNaN(price) ? null : price;
    }

    return null;
  } catch {
    return null;
  }
}

// Position with current value info
export interface PositionWithValue {
  id: string;
  marketTitle: string;
  side: string;
  size: number;           // Original investment
  entryPrice: number;
  currentPrice: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
}

// Get open positions with current values (async - fetches prices)
export async function getOpenPositionsWithValues(): Promise<PositionWithValue[]> {
  const positions = getOpenCopiedPositions();
  const results: PositionWithValue[] = [];

  for (const pos of positions) {
    const currentPrice = await getCurrentPrice(pos.tokenId);

    let currentValue: number | null = null;
    let unrealizedPnl: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (currentPrice !== null) {
      // Calculate shares from entry: shares = size / entryPrice
      const shares = pos.size / pos.entryPrice;
      currentValue = shares * currentPrice;
      unrealizedPnl = currentValue - pos.size;
      unrealizedPnlPct = (unrealizedPnl / pos.size) * 100;
    }

    results.push({
      id: pos.id,
      marketTitle: pos.marketTitle,
      side: pos.side,
      size: pos.size,
      entryPrice: pos.entryPrice,
      currentPrice,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPct,
    });

    // Rate limit API calls
    await new Promise(r => setTimeout(r, 100));
  }

  return results;
}
