/**
 * CLOB (Central Limit Order Book) integration for Polymarket.
 *
 * Fetches real-time order book data to compute:
 *   - Effective spread (bid-ask)
 *   - Liquidity score (depth at various price levels)
 *   - Slippage cost for a given trade size
 *   - Friction cost (spread + fees + slippage)
 *
 * All read endpoints are unauthenticated.
 */

import { CLOB_API_URL, POLYMARKET_TAKER_FEE_PCT } from "../../config/constants.js";
import { fetchWithTimeout } from "../../utils/fetch.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBookResponse {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  hash: string;
  timestamp: string;
}

export interface CLOBMetrics {
  tokenId: string;
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  spread: number;         // Absolute spread
  spreadPct: number;      // Spread as % of midpoint
  bidDepth: number;       // Total $ on bid side (top 10 levels)
  askDepth: number;       // Total $ on ask side (top 10 levels)
  liquidityScore: number; // 0-100 composite score
  slippageCost: number;   // Estimated slippage for $10 trade
  frictionCost: number;   // Total cost: spread/2 + fees + slippage
}

// ─── API Fetchers ─────────────────────────────────────────────────────────

async function fetchOrderBook(tokenId: string): Promise<OrderBookResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${CLOB_API_URL}/book?token_id=${tokenId}`,
      { timeoutMs: 5000 }
    );
    if (!response.ok) return null;
    return await response.json() as OrderBookResponse;
  } catch {
    return null;
  }
}


// ─── Metrics Computation ──────────────────────────────────────────────────

/**
 * Walk the order book to compute average execution price, return slippage as fraction.
 * tradeSize is in dollars. levels have size in shares, price in 0-1.
 */
function computeSlippage(
  levels: OrderBookLevel[],
  tradeSize: number,
  midpoint: number
): number {
  if (levels.length === 0 || midpoint === 0) return 0.01;

  let remainingDollars = tradeSize;
  let totalShares = 0;
  let totalSpent = 0;

  for (const level of levels) {
    if (remainingDollars <= 0) break;

    const price = parseFloat(level.price);
    const shares = parseFloat(level.size);
    if (isNaN(price) || isNaN(shares) || price <= 0) continue;

    const levelDollars = price * shares;
    const fillDollars = Math.min(remainingDollars, levelDollars);
    const fillShares = fillDollars / price;

    totalShares += fillShares;
    totalSpent += fillDollars;
    remainingDollars -= fillDollars;
  }

  if (remainingDollars > 0) {
    return 0.02; // 2 cents penalty if book can't fill
  }

  if (totalShares === 0) return 0.005;

  // Absolute price impact (prediction markets are 0-1, not % based)
  const avgPrice = totalSpent / totalShares;
  return Math.abs(avgPrice - midpoint);
}

/**
 * Compute depth (total $) on one side of the book (top N levels).
 */
function computeDepth(levels: OrderBookLevel[], maxLevels: number = 10): number {
  let total = 0;
  for (let i = 0; i < Math.min(levels.length, maxLevels); i++) {
    const price = parseFloat(levels[i].price);
    const size = parseFloat(levels[i].size);
    total += price * size;
  }
  return total;
}

/**
 * Composite liquidity score (0-100) based on spread, depth, and book balance.
 *
 * Scoring:
 *   - Tight spread: 0-40 points (< 2% = 40pts, > 10% = 0pts)
 *   - Deep book: 0-40 points (> $5K each side = 40pts)
 *   - Book balance: 0-20 points (balanced bid/ask = 20pts)
 */
function computeLiquidityScore(
  spreadPct: number,
  bidDepth: number,
  askDepth: number
): number {
  // Spread score: tighter is better
  const spreadScore = Math.max(0, 40 * (1 - spreadPct / 0.10));

  // Depth score: deeper is better (cap at $5K per side)
  const avgDepth = (bidDepth + askDepth) / 2;
  const depthScore = Math.min(40, (avgDepth / 5000) * 40);

  // Balance score: more balanced is better
  const totalDepth = bidDepth + askDepth;
  const balance = totalDepth > 0 ? Math.min(bidDepth, askDepth) / Math.max(bidDepth, askDepth) : 0;
  const balanceScore = balance * 20;

  return Math.round(spreadScore + depthScore + balanceScore);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch comprehensive CLOB metrics for a token.
 * Makes 1 API call (order book includes all data we need).
 */
export async function getCLOBMetrics(
  tokenId: string,
  tradeSize: number = 10
): Promise<CLOBMetrics | null> {
  const book = await fetchOrderBook(tokenId);
  if (!book) return null;

  // Reject if either side is empty (unreliable data)
  if (book.bids.length === 0 || book.asks.length === 0) return null;

  const bestBid = parseFloat(book.bids[0].price);
  const bestAsk = parseFloat(book.asks[0].price);
  if (isNaN(bestBid) || isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;

  const midpoint = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPct = midpoint > 0 ? spread / midpoint : 1;

  const bidDepth = computeDepth(book.bids);
  const askDepth = computeDepth(book.asks);

  const slippageCost = computeSlippage(book.asks, tradeSize, midpoint);

  const liquidityScore = computeLiquidityScore(spreadPct, bidDepth, askDepth);

  // Total friction in absolute terms (same units as edge = probability difference)
  // halfSpread in absolute price + taker fee (small) + slippage in absolute price
  const frictionCost = spread / 2 + POLYMARKET_TAKER_FEE_PCT + slippageCost;

  return {
    tokenId,
    midpoint,
    bestBid,
    bestAsk,
    spread,
    spreadPct,
    bidDepth,
    askDepth,
    liquidityScore,
    slippageCost,
    frictionCost,
  };
}

/**
 * Batch fetch CLOB metrics for multiple tokens.
 * Adds small delay between requests to respect rate limits.
 */
export async function batchGetCLOBMetrics(
  tokenIds: string[],
  tradeSize: number = 10,
  delayMs: number = 200
): Promise<Map<string, CLOBMetrics>> {
  const results = new Map<string, CLOBMetrics>();

  for (const tokenId of tokenIds) {
    const metrics = await getCLOBMetrics(tokenId, tradeSize);
    if (metrics) {
      results.set(tokenId, metrics);
    }
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

/**
 * Quick check: is a market liquid enough to trade?
 * Returns true if liquidityScore >= threshold.
 */
export function isLiquidEnough(
  metrics: CLOBMetrics | null,
  minScore: number = 20
): boolean {
  if (!metrics) return true; // Don't block if CLOB data unavailable
  return metrics.liquidityScore >= minScore;
}
