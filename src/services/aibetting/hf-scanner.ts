/**
 * Fast Scanner for Polymarket - NegRisk arbitrage detection.
 * Scans every 15s for binary markets where Yes+No deviates from 1.0.
 * Paper trades the spread convergence.
 */

import { fetchWithTimeout } from "../../utils/fetch.js";
import { GAMMA_API_URL } from "../../config/constants.js";

// ---- Types ---------------------------------------------------------------

export interface MomentumSignal {
  symbol: string;
  direction: "up" | "down";
  magnitude: number;
  confidence: number;
  timestamp: number;
  binancePrice: number;
}

export interface FastScanResult {
  marketId: string;
  title: string;
  marketPrice: number;
  mathEstimate: number;
  edge: number;
  source: string;
  flagForR1: boolean;
}

export interface HFPaperTrade {
  id: string;
  coin: string;
  side: "up" | "down";
  entryPrice: number;
  shares: number;
  size: number;
  entryTime: number;
  windowStart: number;
  windowEnd: number;
  windowStartPrice: number;
  binancePriceAtEntry: number;
  momentumAtEntry: number;
  edgeAtEntry: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
  type: "momentum" | "negrisk";
}

export interface NegRiskPaperTrade {
  id: string;
  marketId: string;
  title: string;
  side: "YES" | "NO";
  entryPrice: number;
  shares: number;
  size: number;
  entryTime: number;
  entrySum: number;
  edgeAtEntry: number;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: number;
  type: "negrisk";
}

// ---- Config --------------------------------------------------------------

const FAST_SCAN_INTERVAL_MS = 15_000;
const MAX_PAPER_TRADES = 500;
const MAX_FLAGGED_R1 = 50;
const NEGRISK_POSITION_SIZE = 5;
const NEGRISK_MAX_OPEN = 10;
const NEGRISK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---- Fast Scanner --------------------------------------------------------

const flaggedForR1: FastScanResult[] = [];
let fastScanInterval: NodeJS.Timeout | null = null;

async function runFastScan(): Promise<FastScanResult[]> {
  const results: FastScanResult[] = [];

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return results;

    const markets = await response.json() as Array<{
      conditionId: string;
      question: string;
      outcomePrices: string;
      volume24hr: number;
      closed: boolean;
    }>;

    for (const market of markets) {
      try {
        const prices = JSON.parse(market.outcomePrices) as string[];
        if (prices.length !== 2) continue;

        const yesPrice = parseFloat(prices[0]);
        const noPrice = parseFloat(prices[1]);
        if (isNaN(yesPrice) || isNaN(noPrice)) continue;
        if (yesPrice < 0.05 || yesPrice > 0.95) continue;
        if (market.volume24hr < 50) continue;

        const priceSum = yesPrice + noPrice;
        if (Math.abs(priceSum - 1.0) > 0.015) {
          results.push({
            marketId: market.conditionId,
            title: market.question,
            marketPrice: yesPrice,
            mathEstimate: yesPrice,
            edge: Math.abs(priceSum - 1.0) / 2,
            source: `negrisk-sum=${priceSum.toFixed(3)}`,
            flagForR1: false,
          });
        }
      } catch { /* skip */ }
    }

    // Paper trade NegRisk signals
    for (const r of results) {
      if (r.edge >= 0.01) handleNegRiskSignal(r);
    }

    await checkNegRiskResolutions();

    // Flag high-edge for R1
    for (const r of results) {
      if (r.edge > 0.05 && flaggedForR1.length < MAX_FLAGGED_R1) {
        r.flagForR1 = true;
        flaggedForR1.push(r);
      }
    }

    if (results.length > 0) {
      console.log(`[FastScan] ${results.length} negrisk signals (${results.filter(r => r.flagForR1).length} flagged)`);
    }
  } catch (err) {
    console.error("[FastScan] Error:", err);
  }

  return results;
}

// ---- NegRisk Paper Trading -----------------------------------------------

const negRiskTrades: NegRiskPaperTrade[] = [];
let negRiskBalance = 100;

function handleNegRiskSignal(result: FastScanResult): void {
  if (negRiskBalance < NEGRISK_POSITION_SIZE) return;

  const openCount = negRiskTrades.filter(t => t.status === "open").length;
  if (openCount >= NEGRISK_MAX_OPEN) return;
  if (negRiskTrades.some(t => t.marketId === result.marketId && t.status === "open")) return;

  const side: "YES" | "NO" = result.marketPrice <= 0.5 ? "YES" : "NO";
  const entryPrice = side === "YES" ? result.marketPrice : 1 - result.marketPrice;
  if (entryPrice <= 0.01 || entryPrice >= 0.99) return;

  const shares = NEGRISK_POSITION_SIZE / entryPrice;
  negRiskBalance -= NEGRISK_POSITION_SIZE;

  const sumMatch = result.source.match(/sum=([\d.]+)/);
  const entrySum = sumMatch ? parseFloat(sumMatch[1]) : 1.0;

  const trade: NegRiskPaperTrade = {
    id: `nr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    marketId: result.marketId,
    title: result.title,
    side,
    entryPrice,
    shares,
    size: NEGRISK_POSITION_SIZE,
    entryTime: Date.now(),
    entrySum,
    edgeAtEntry: result.edge,
    status: "open",
    pnl: 0,
    type: "negrisk",
  };

  negRiskTrades.push(trade);
  if (negRiskTrades.length > MAX_PAPER_TRADES) {
    const oldest = negRiskTrades.findIndex(t => t.status !== "open");
    if (oldest >= 0) negRiskTrades.splice(oldest, 1);
  }

  console.log(
    `[NRPaper] OPEN: ${side} "${trade.title.substring(0, 40)}" ` +
    `@ ${(entryPrice * 100).toFixed(0)}c ($${NEGRISK_POSITION_SIZE}) ` +
    `sum=${entrySum.toFixed(3)} edge=${(trade.edgeAtEntry * 100).toFixed(1)}%`
  );
}

async function checkNegRiskResolutions(): Promise<void> {
  const openTrades = negRiskTrades.filter(t => t.status === "open");
  if (openTrades.length === 0) return;

  try {
    const response = await fetchWithTimeout(
      `${GAMMA_API_URL}/markets?active=true&closed=false&limit=200`,
      { timeoutMs: 10000 }
    );
    if (!response.ok) return;

    const markets = await response.json() as Array<{
      conditionId: string;
      outcomePrices: string;
      closed: boolean;
    }>;

    const priceMap = new Map<string, { yes: number; no: number; sum: number }>();
    for (const m of markets) {
      try {
        const prices = JSON.parse(m.outcomePrices) as string[];
        if (prices.length !== 2) continue;
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (isNaN(yes) || isNaN(no)) continue;
        priceMap.set(m.conditionId, { yes, no, sum: yes + no });
      } catch { /* skip */ }
    }

    for (const trade of openTrades) {
      const current = priceMap.get(trade.marketId);
      const age = Date.now() - trade.entryTime;

      if (!current) {
        if (age > 5 * 60 * 1000) {
          trade.status = "won";
          const payout = trade.shares * 1.0;
          trade.pnl = payout - trade.size;
          negRiskBalance += payout;
          trade.resolvedAt = Date.now();
          console.log(`[NRPaper] RESOLVED: "${trade.title.substring(0, 40)}" +$${trade.pnl.toFixed(2)}`);
        }
        continue;
      }

      const currentPrice = trade.side === "YES" ? current.yes : current.no;
      const priceChange = (currentPrice - trade.entryPrice) / trade.entryPrice;
      const converged = Math.abs(current.sum - 1.0) < 0.01;

      let shouldClose = false;
      let reason = "";

      if (converged) { shouldClose = true; reason = "converged"; }
      else if (priceChange > 0.05) { shouldClose = true; reason = "take-profit"; }
      else if (priceChange < -0.15) { shouldClose = true; reason = "stop-loss"; }
      else if (age > NEGRISK_MAX_AGE_MS) { shouldClose = true; reason = "max-age"; }

      if (shouldClose) {
        const payout = trade.shares * currentPrice;
        trade.pnl = payout - trade.size;
        trade.status = trade.pnl >= 0 ? "won" : "lost";
        negRiskBalance += payout;
        trade.resolvedAt = Date.now();

        const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
        console.log(`[NRPaper] ${trade.status.toUpperCase()}: "${trade.title.substring(0, 40)}" ${pnlStr} (${reason})`);
      }
    }
  } catch { /* non-critical */ }
}

// ---- Public API ----------------------------------------------------------

let running = false;

export function onMomentumSignal(_cb: (signal: MomentumSignal) => void): void { /* disabled */ }
export function onTradeSignal(_cb: (signal: unknown) => void): void { /* disabled */ }

export function getFlaggedForR1(): FastScanResult[] {
  const copy = [...flaggedForR1];
  flaggedForR1.length = 0;
  return copy;
}

export function getPriceState(_symbol: string): undefined {
  return undefined;
}

export function isBinanceConnected(): boolean {
  return false;
}

export async function startHFScanner(): Promise<void> {
  if (running) return;
  running = true;

  fastScanInterval = setInterval(() => {
    void runFastScan();
  }, FAST_SCAN_INTERVAL_MS);

  console.log("[FastScan] Running: 15s NegRisk scan");
}

export function stopHFScanner(): void {
  if (!running) return;
  running = false;

  if (fastScanInterval) {
    clearInterval(fastScanInterval);
    fastScanInterval = null;
  }

  console.log("[FastScan] Stopped");
}

export function resetHFPaperData(): void {
  negRiskTrades.length = 0;
  negRiskBalance = 100;
  console.log("[FastScan] Paper data reset");
}

export function getHFPaperStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: HFPaperTrade[];
} {
  return {
    balance: 0,
    totalTrades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalPnl: 0,
    recentTrades: [],
  };
}

export function getNegRiskPaperStats(): {
  balance: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  recentTrades: NegRiskPaperTrade[];
} {
  const closed = negRiskTrades.filter(t => t.status !== "open");
  const wins = closed.filter(t => t.status === "won").length;
  const losses = closed.filter(t => t.status === "lost").length;
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const recent = negRiskTrades.slice(-10).reverse();

  return {
    balance: negRiskBalance,
    totalTrades: negRiskTrades.length,
    openTrades: negRiskTrades.filter(t => t.status === "open").length,
    wins,
    losses,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    totalPnl,
    recentTrades: recent,
  };
}

export function getHFScannerStatus(): {
  running: boolean;
  binanceConnected: boolean;
  trackedPairs: number;
  activeUpDownMarkets: number;
  pendingR1Flags: number;
} {
  return {
    running,
    binanceConnected: false,
    trackedPairs: 0,
    activeUpDownMarkets: 0,
    pendingR1Flags: flaggedForR1.length,
  };
}
