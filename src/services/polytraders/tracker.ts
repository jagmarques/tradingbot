// Polymarket Top Trader Tracker
// Monitors top profitable traders and copies their bets

import { notifyTopTraderBet, notifyTopTraderCopy, notifyTopTraderCopyClose } from "../telegram/notifications.js";
import { placeFokOrder } from "../polygon/polymarket.js";
import { isPaperMode } from "../../config/env.js";
import { getDb } from "../database/db.js";
import { ESTIMATED_GAS_FEE_MATIC, ESTIMATED_SLIPPAGE_POLYMARKET } from "../../config/constants.js";
import { getSettings } from "../settings/settings.js";
import { getChatId } from "../telegram/bot.js";

const DATA_API_URL = "https://data-api.polymarket.com/v1";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// Default copy size if no user settings
const DEFAULT_COPY_SIZE_USD = 5;
const MIN_TRADER_PNL = 50000; // Only copy traders with $50k+ monthly PnL

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
  size: number;
  usdcSize: number;
  price: number;
  title?: string;
  slug?: string;
}

// Track top traders and their last seen activity
const trackedTraders = new Map<string, { name: string; lastSeen: number; pnl: number }>();
let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;

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
  `);
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

async function getMarketTokenId(conditionId: string, side: "YES" | "NO"): Promise<string | null> {
  try {
    const response = await fetch(`${GAMMA_API_URL}/markets?conditionId=${conditionId}`);
    if (!response.ok) return null;

    const markets = await response.json() as Array<{
      outcomes: string;
      clobTokenIds: string;
    }>;

    if (markets.length === 0) return null;

    const market = markets[0];
    const outcomes = JSON.parse(market.outcomes) as string[];
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];

    const idx = outcomes.findIndex(o => o.toLowerCase() === side.toLowerCase());
    return idx >= 0 ? tokenIds[idx] : null;
  } catch {
    return null;
  }
}

async function copyTrade(
  trade: TraderActivity,
  traderInfo: { name: string; pnl: number }
): Promise<CopiedPosition | null> {
  // Determine side from price (price > 0.5 likely means YES)
  const side: "YES" | "NO" = trade.price > 0.5 ? "YES" : "NO";

  // Get token ID for this market
  const tokenId = await getMarketTokenId(trade.conditionId, side);
  if (!tokenId) {
    console.log(`[PolyTraders] Could not get token ID for ${trade.conditionId}`);
    return null;
  }

  const positionId = `copy_${trade.conditionId}_${Date.now()}`;

  const copySizeUsd = getCopySizeUsd();

  // In paper mode, just record the trade
  if (isPaperMode()) {
    console.log(`[PolyTraders] PAPER COPY: ${side} ${trade.title} @ ${(trade.price * 100).toFixed(0)}c ($${copySizeUsd})`);
  } else {
    // Live mode - place actual order
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
      console.log(`[PolyTraders] LIVE COPY: ${side} ${trade.title} @ ${(trade.price * 100).toFixed(0)}c - Order ${order.id}`);
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
  if (trackedTraders.size === 0) {
    // First run - populate tracked traders
    const topTraders = await fetchTopTraders("OVERALL", "MONTH", 10);
    for (const trader of topTraders) {
      trackedTraders.set(trader.proxyWallet.toLowerCase(), {
        name: trader.userName || trader.proxyWallet.substring(0, 10),
        lastSeen: Date.now(),
        pnl: trader.pnl,
      });
    }
    console.log(`[PolyTraders] Tracking ${trackedTraders.size} top traders`);
    return;
  }

  // Check each tracked trader for new activity
  for (const [wallet, info] of trackedTraders) {
    try {
      const activity = await fetchTraderActivity(wallet, 5);

      for (const trade of activity) {
        const tradeTime = trade.timestamp * 1000;

        // Skip old trades
        if (tradeTime <= info.lastSeen) continue;

        // New trade found - must be BUY and $100+
        if (trade.type === "TRADE" && trade.usdcSize >= 100 && trade.size > 0) {
          console.log(`[PolyTraders] New trade by ${info.name}: $${trade.usdcSize.toFixed(0)} on ${trade.title || trade.conditionId}`);

          // Send Telegram alert
          await notifyTopTraderBet({
            traderName: info.name,
            traderPnl: info.pnl,
            marketTitle: trade.title || "Unknown Market",
            size: trade.usdcSize,
            price: trade.price,
          });

          // Copy trade if trader has enough PnL
          if (info.pnl >= MIN_TRADER_PNL) {
            const copied = await copyTrade(trade, info);
            if (copied) {
              await notifyTopTraderCopy({
                traderName: info.name,
                marketTitle: copied.marketTitle,
                side: trade.price > 0.5 ? "YES" : "NO",
                size: copied.size,
                entryPrice: copied.entryPrice,
                isPaper: isPaperMode(),
              });
            }
          }
        }

        // Update last seen
        info.lastSeen = Math.max(info.lastSeen, tradeTime);
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      console.error(`[PolyTraders] Error checking ${info.name}:`, error);
    }
  }
}

async function refreshTopTraders(): Promise<void> {
  const topTraders = await fetchTopTraders("OVERALL", "MONTH", 10);

  // Add any new top traders
  for (const trader of topTraders) {
    const wallet = trader.proxyWallet.toLowerCase();
    if (!trackedTraders.has(wallet)) {
      trackedTraders.set(wallet, {
        name: trader.userName || trader.proxyWallet.substring(0, 10),
        lastSeen: Date.now(),
        pnl: trader.pnl,
      });
      console.log(`[PolyTraders] Now tracking: ${trader.userName || wallet}`);
    } else {
      // Update PnL
      const info = trackedTraders.get(wallet);
      if (info) {
        info.pnl = trader.pnl;
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

export function getTrackedTraders(): Array<{ wallet: string; name: string; pnl: number }> {
  return Array.from(trackedTraders.entries()).map(([wallet, info]) => ({
    wallet,
    name: info.name,
    pnl: info.pnl,
  }));
}

export function getOpenCopiedPositions(): CopiedPosition[] {
  return Array.from(copiedPositions.values()).filter(p => p.status === "open");
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

// Check if any copied positions should be closed (trader sold)
async function checkCopiedPositionExits(): Promise<void> {
  const openPositions = getOpenCopiedPositions();

  for (const pos of openPositions) {
    try {
      // Check trader's recent activity for sells on this market
      const activity = await fetchTraderActivity(pos.traderWallet, 10);

      for (const trade of activity) {
        if (trade.conditionId !== pos.conditionId) continue;

        // If trader sold (negative size), close our position
        if (trade.size < 0 && trade.timestamp * 1000 > pos.entryTimestamp) {
          const exitPrice = trade.price;
          let pnl = (exitPrice - pos.entryPrice) * pos.size;

          // Deduct estimated fees in paper mode (gas + slippage on entry and exit)
          if (isPaperMode()) {
            const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10 * 2; // ~$0.001 MATIC at $1.10 * 2 tx
            const slippageFeeUsd = pos.size * ESTIMATED_SLIPPAGE_POLYMARKET * 2; // Entry + exit
            pnl -= (gasFeeUsd + slippageFeeUsd);
          }

          const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

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
