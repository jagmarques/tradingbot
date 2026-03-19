/**
 * Cross-platform arbitrage scanner.
 * Matches Polymarket and Kalshi markets by title similarity,
 * detects price discrepancies > 6%, paper trades convergence.
 */

import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL, KALSHI_API_URL } from "../../config/constants.js";

// ---- Types ---------------------------------------------------------------

export interface CrossArbTrade {
  id: string;
  polyMarketId: string;
  kalshiTicker: string;
  title: string;
  polyLeg: { side: "YES" | "NO"; entryPrice: number };
  kalshiLeg: { side: "YES" | "NO"; entryPrice: number };
  size: number;
  entryTime: number;
  spreadAtEntry: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
}

interface KalshiMarket {
  ticker: string;
  title: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  close_time: string;
  volume_24h: number;
  event_ticker: string;
}

interface PolyMarket {
  conditionId: string;
  question: string;
  outcomePrices: string;
  endDate: string;
  volume24hr: number;
  active: boolean;
  closed: boolean;
}

// ---- Config --------------------------------------------------------------

const POSITION_SIZE = 5;
const MAX_OPEN = 10;
const STARTING_BALANCE = 100;
const ARB_THRESHOLD = 0.06;
const TAKE_PROFIT_SPREAD = 0.02;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_CLOSE_TIME_DIFF_MS = 30 * 24 * 60 * 60 * 1000;

// ---- State ---------------------------------------------------------------

const trades: CrossArbTrade[] = [];
let balance = STARTING_BALANCE;

// ---- Helpers -------------------------------------------------------------

function extractWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = extractWords(a);
  const wordsB = extractWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setB = new Set(wordsB);
  const shared = wordsA.filter(w => setB.has(w)).length;
  const minLen = Math.min(wordsA.length, wordsB.length);
  return minLen > 0 ? shared / minLen : 0;
}

function closeTimesMatch(kalshiClose: string, polyEnd: string): boolean {
  try {
    const kTime = new Date(kalshiClose).getTime();
    const pTime = new Date(polyEnd).getTime();
    if (isNaN(kTime) || isNaN(pTime)) return false;
    return Math.abs(kTime - pTime) <= MAX_CLOSE_TIME_DIFF_MS;
  } catch {
    return false;
  }
}

// ---- Scanner -------------------------------------------------------------

async function fetchKalshiMarkets(): Promise<KalshiMarket[]> {
  try {
    const response = await fetchWithTimeout(
      `${KALSHI_API_URL}/markets?limit=200&status=open`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return [];

    const data = await response.json() as { markets: Array<{
      ticker: string;
      title: string;
      yes_bid_dollars: string;
      yes_ask_dollars: string;
      no_bid_dollars: string;
      no_ask_dollars: string;
      close_time: string;
      volume_24h_fp: string;
      event_ticker: string;
    }> };

    return (data.markets || []).map(m => ({
      ticker: m.ticker,
      title: m.title,
      yes_bid: parseFloat(m.yes_bid_dollars || "0"),
      yes_ask: parseFloat(m.yes_ask_dollars || "0"),
      no_bid: parseFloat(m.no_bid_dollars || "0"),
      no_ask: parseFloat(m.no_ask_dollars || "0"),
      close_time: m.close_time,
      volume_24h: parseFloat(m.volume_24h_fp || "0"),
      event_ticker: m.event_ticker,
    }));
  } catch (err) {
    console.error("[CrossArb] Kalshi fetch error:", err);
    return [];
  }
}

async function fetchPolyMarkets(sharedMarkets?: PolyMarket[]): Promise<PolyMarket[]> {
  if (sharedMarkets && sharedMarkets.length > 0) return sharedMarkets;
  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return [];
    return await response.json() as PolyMarket[];
  } catch (err) {
    console.error("[CrossArb] Polymarket fetch error:", err);
    return [];
  }
}

function getPolyYesPrice(market: PolyMarket): number | null {
  try {
    const prices = JSON.parse(market.outcomePrices) as string[];
    if (prices.length < 1) return null;
    const p = parseFloat(prices[0]);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}

export async function runCrossArbScan(sharedPolyMarkets?: PolyMarket[]): Promise<void> {
  try {
    const [kalshiMarkets, polyMarkets] = await Promise.all([
      fetchKalshiMarkets(),
      fetchPolyMarkets(sharedPolyMarkets),
    ]);

    if (kalshiMarkets.length === 0 || polyMarkets.length === 0) return;

    // Match markets by title similarity
    for (const km of kalshiMarkets) {
      if (km.volume_24h <= 0) continue;
      if (km.yes_bid <= 0 && km.yes_ask <= 0) continue;

      for (const pm of polyMarkets) {
        try {
          if (pm.volume24hr <= 0) continue;
          const polyYes = getPolyYesPrice(pm);
          if (polyYes === null) continue;

          if (titleSimilarity(km.title, pm.question) < 0.5) continue;
          if (!closeTimesMatch(km.close_time, pm.endDate)) continue;

          // Already have an open trade on this pair
          if (trades.some(t => t.polyMarketId === pm.conditionId && t.kalshiTicker === km.ticker && t.status === "open")) continue;

          // Detect arb: buy poly YES + sell kalshi YES
          const spreadBuyPoly = km.yes_bid - polyYes;
          // Detect arb: buy kalshi YES + sell poly YES
          const spreadBuyKalshi = polyYes - km.yes_ask;

          if (spreadBuyPoly > ARB_THRESHOLD) {
            enterArbTrade(pm.conditionId, km.ticker, km.title, polyYes, km.yes_bid, "buy_poly", spreadBuyPoly);
          } else if (spreadBuyKalshi > ARB_THRESHOLD) {
            enterArbTrade(pm.conditionId, km.ticker, km.title, polyYes, km.yes_ask, "buy_kalshi", spreadBuyKalshi);
          }
        } catch { /* skip single match */ }
      }
    }

    // Check resolutions
    await checkCrossArbResolutions(kalshiMarkets, polyMarkets);
  } catch (err) {
    console.error("[CrossArb] Scan error:", err);
  }
}

function enterArbTrade(
  polyMarketId: string,
  kalshiTicker: string,
  title: string,
  polyYesPrice: number,
  kalshiPrice: number,
  direction: "buy_poly" | "buy_kalshi",
  spread: number,
): void {
  if (balance < POSITION_SIZE) return;
  const openCount = trades.filter(t => t.status === "open").length;
  if (openCount >= MAX_OPEN) return;

  const trade: CrossArbTrade = {
    id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    polyMarketId,
    kalshiTicker,
    title,
    polyLeg: {
      side: direction === "buy_poly" ? "YES" : "NO",
      entryPrice: polyYesPrice,
    },
    kalshiLeg: {
      side: direction === "buy_poly" ? "NO" : "YES",
      entryPrice: kalshiPrice,
    },
    size: POSITION_SIZE,
    entryTime: Date.now(),
    spreadAtEntry: spread,
    status: "open",
    pnl: 0,
  };

  balance -= POSITION_SIZE;
  trades.push(trade);

  // Trim old closed trades
  if (trades.length > 500) {
    const oldest = trades.findIndex(t => t.status !== "open");
    if (oldest >= 0) trades.splice(oldest, 1);
  }

  console.log(
    `[CrossArb] OPEN: "${title.substring(0, 40)}" ` +
    `spread=${(spread * 100).toFixed(1)}% dir=${direction} ` +
    `poly=${(polyYesPrice * 100).toFixed(0)}c kalshi=${(kalshiPrice * 100).toFixed(0)}c`
  );
}

async function checkCrossArbResolutions(
  kalshiMarkets: KalshiMarket[],
  polyMarkets: PolyMarket[],
): Promise<void> {
  const openTrades = trades.filter(t => t.status === "open");
  if (openTrades.length === 0) return;

  const kalshiMap = new Map<string, KalshiMarket>();
  for (const km of kalshiMarkets) kalshiMap.set(km.ticker, km);

  const polyMap = new Map<string, PolyMarket>();
  for (const pm of polyMarkets) polyMap.set(pm.conditionId, pm);

  for (const trade of openTrades) {
    try {
      const km = kalshiMap.get(trade.kalshiTicker);
      const pm = polyMap.get(trade.polyMarketId);
      const age = Date.now() - trade.entryTime;

      // If either market disappeared, close at entry (no data to price)
      if (!km || !pm) {
        if (age > 5 * 60 * 1000) {
          closeTrade(trade, 0, "market-gone");
        }
        continue;
      }

      const polyYes = getPolyYesPrice(pm);
      if (polyYes === null) continue;

      // Recalculate current spread
      let currentSpread: number;
      if (trade.polyLeg.side === "YES") {
        // We bought poly YES, sold kalshi YES
        currentSpread = km.yes_bid - polyYes;
      } else {
        // We bought kalshi YES, sold poly YES
        currentSpread = polyYes - km.yes_ask;
      }

      let shouldClose = false;
      let reason = "";

      // Take profit: spread narrowed to < 2%
      if (currentSpread < TAKE_PROFIT_SPREAD) {
        shouldClose = true;
        reason = "converged";
      }
      // Time stop: 48h
      if (age > MAX_AGE_MS) {
        shouldClose = true;
        reason = "time-stop";
      }

      if (shouldClose) {
        // PnL approximation: (spread_at_entry - spread_at_exit) * notional per leg
        const sharesEquivalent = trade.size / Math.max(trade.polyLeg.entryPrice, 0.01);
        const pnl = (trade.spreadAtEntry - Math.max(currentSpread, 0)) * sharesEquivalent;
        closeTrade(trade, pnl, reason);
      }
    } catch { /* skip single trade */ }
  }
}

function closeTrade(trade: CrossArbTrade, pnl: number, reason: string): void {
  trade.pnl = pnl;
  trade.status = pnl >= 0 ? "won" : "lost";
  trade.resolvedAt = Date.now();
  balance += trade.size + pnl;

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  console.log(`[CrossArb] ${trade.status.toUpperCase()}: "${trade.title.substring(0, 40)}" ${pnlStr} (${reason})`);
}

// ---- Public API ----------------------------------------------------------

export function getCrossArbStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: CrossArbTrade[];
} {
  const closed = trades.filter(t => t.status !== "open");
  const wins = closed.filter(t => t.status === "won").length;
  const losses = closed.filter(t => t.status === "lost").length;
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const recent = trades.slice(-10).reverse();

  return {
    balance,
    totalTrades: trades.length,
    openTrades: trades.filter(t => t.status === "open").length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    recentTrades: recent,
  };
}

export function resetCrossArbData(): void {
  trades.length = 0;
  balance = STARTING_BALANCE;
  console.log("[CrossArb] Paper data reset");
}
