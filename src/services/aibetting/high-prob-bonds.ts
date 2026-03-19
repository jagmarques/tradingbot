/**
 * High-probability bonds scanner.
 * Scans Polymarket for markets with YES or NO > $0.95 resolving within 7 days.
 * Calculates annualized yield, auto-buys in paper mode.
 */

import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";

// ---- Types ---------------------------------------------------------------

export interface BondTrade {
  id: string;
  marketId: string;
  title: string;
  side: "YES" | "NO";
  entryPrice: number;
  size: number;
  shares: number;
  entryTime: number;
  daysToResolution: number;
  annualizedYield: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
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

const POSITION_SIZE = 10;
const MAX_OPEN = 15;
const STARTING_BALANCE = 150;
const MIN_PRICE = 0.95;
const MAX_DAYS = 7;
const FEE_PCT = 0.02;
const MIN_ANNUALIZED_YIELD = 20;
const STOP_LOSS_PRICE = 0.90;
const MAX_AGE_DAYS = 7;

// ---- State ---------------------------------------------------------------

const trades: BondTrade[] = [];
let balance = STARTING_BALANCE;

// ---- Helpers -------------------------------------------------------------

function parsePrices(market: PolyMarket): { yes: number; no: number } | null {
  try {
    const prices = JSON.parse(market.outcomePrices) as string[];
    if (prices.length < 2) return null;
    const yes = parseFloat(prices[0]);
    const no = parseFloat(prices[1]);
    if (isNaN(yes) || isNaN(no)) return null;
    return { yes, no };
  } catch {
    return null;
  }
}

// ---- Scanner -------------------------------------------------------------

export async function runBondsScan(sharedMarkets?: PolyMarket[]): Promise<void> {
  try {
    let markets: PolyMarket[];
    if (sharedMarkets && sharedMarkets.length > 0) {
      markets = sharedMarkets;
    } else {
      const response = await fetchWithTimeout(
        `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
        { timeoutMs: 10000 }
      );
      if (!response.ok) return;
      markets = await response.json() as PolyMarket[];
    }

    const now = Date.now();

    for (const market of markets) {
      try {
        const prices = parsePrices(market);
        if (!prices) continue;

        // Skip low-volume markets (stale/illiquid prices)
        if (market.volume24hr < 100) continue;

        const endTime = new Date(market.endDate).getTime();
        if (isNaN(endTime)) continue;

        const daysToResolution = (endTime - now) / (24 * 60 * 60 * 1000);
        if (daysToResolution <= 0 || daysToResolution > MAX_DAYS) continue;

        // Determine side
        let buyPrice: number;
        let side: "YES" | "NO";
        if (prices.yes > MIN_PRICE) {
          buyPrice = prices.yes;
          side = "YES";
        } else if (prices.no > MIN_PRICE) {
          buyPrice = prices.no;
          side = "NO";
        } else {
          continue;
        }

        // Profit calculation
        const profitPerDollar = 1.0 - buyPrice - FEE_PCT;
        if (profitPerDollar <= 0) continue;

        const annualizedYield = (profitPerDollar / buyPrice) * (365 / daysToResolution) * 100;
        if (annualizedYield < MIN_ANNUALIZED_YIELD) continue;

        // Already have open trade on this market
        if (trades.some(t => t.marketId === market.conditionId && t.status === "open")) continue;

        enterBond(market.conditionId, market.question, side, buyPrice, daysToResolution, annualizedYield);
      } catch { /* skip single market */ }
    }

    // Check resolutions
    await checkBondResolutions(markets);
  } catch (err) {
    console.error("[Bonds] Scan error:", err);
  }
}

function enterBond(
  marketId: string,
  title: string,
  side: "YES" | "NO",
  entryPrice: number,
  daysToResolution: number,
  annualizedYield: number,
): void {
  if (balance < POSITION_SIZE) return;
  const openCount = trades.filter(t => t.status === "open").length;
  if (openCount >= MAX_OPEN) return;

  const shares = POSITION_SIZE / entryPrice;

  const trade: BondTrade = {
    id: `bd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    marketId,
    title,
    side,
    entryPrice,
    size: POSITION_SIZE,
    shares,
    entryTime: Date.now(),
    daysToResolution,
    annualizedYield,
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
    `[Bonds] OPEN: ${side} "${title.substring(0, 40)}" ` +
    `@${(entryPrice * 100).toFixed(0)}c ${daysToResolution.toFixed(1)}d ` +
    `yield=${annualizedYield.toFixed(0)}%`
  );
}

async function checkBondResolutions(currentMarkets: PolyMarket[]): Promise<void> {
  const openTrades = trades.filter(t => t.status === "open");
  if (openTrades.length === 0) return;

  const marketMap = new Map<string, PolyMarket>();
  for (const m of currentMarkets) marketMap.set(m.conditionId, m);

  for (const trade of openTrades) {
    try {
      const market = marketMap.get(trade.marketId);
      const ageDays = (Date.now() - trade.entryTime) / (24 * 60 * 60 * 1000);

      // Market disappeared from active list - might be resolved or just not in this page
      // Only count as resolved if it's been > 1 hour since entry (avoid false positives from pagination)
      if (!market) {
        const ageMs = Date.now() - trade.entryTime;
        if (ageMs > 60 * 60 * 1000) {
          // We bought > 95c, so assume resolved in our favor (high prob)
          const payout = trade.shares * 1.0;
          const pnl = payout - trade.size;
          closeBondTrade(trade, pnl, "resolved");
        }
        continue;
      }

      const prices = parsePrices(market);
      if (!prices) continue;

      const currentPrice = trade.side === "YES" ? prices.yes : prices.no;

      // Stop loss: price dropped below 0.90
      if (currentPrice < STOP_LOSS_PRICE) {
        const payout = trade.shares * currentPrice;
        const pnl = payout - trade.size;
        closeBondTrade(trade, pnl, "stop-loss");
        continue;
      }

      // Time stop: > 7 days old with no resolution
      if (ageDays > MAX_AGE_DAYS) {
        const payout = trade.shares * currentPrice;
        const pnl = payout - trade.size;
        closeBondTrade(trade, pnl, "time-stop");
        continue;
      }
    } catch { /* skip single trade */ }
  }
}

function closeBondTrade(trade: BondTrade, pnl: number, reason: string): void {
  trade.pnl = pnl;
  trade.status = pnl >= 0 ? "won" : "lost";
  trade.resolvedAt = Date.now();
  balance += trade.size + pnl;

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  console.log(`[Bonds] ${trade.status.toUpperCase()}: "${trade.title.substring(0, 40)}" ${pnlStr} (${reason})`);
}

// ---- Public API ----------------------------------------------------------

export function getBondsStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: BondTrade[];
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

export function resetBondsData(): void {
  trades.length = 0;
  balance = STARTING_BALANCE;
  console.log("[Bonds] Paper data reset");
}
