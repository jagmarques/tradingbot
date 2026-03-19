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
  midpoint: number
): number {
  if (levels.length === 0 || midpoint === 0) return 0.005;

  // Only check top 3 levels for realistic slippage
  let totalWeight = 0;
  let weightedPrice = 0;
  const maxLevels = Math.min(levels.length, 3);

  for (let i = 0; i < maxLevels; i++) {
    const price = parseFloat(levels[i].price);
    const shares = parseFloat(levels[i].size);
    if (isNaN(price) || isNaN(shares) || price <= 0) continue;

    const dollars = price * shares;
    weightedPrice += price * dollars;
    totalWeight += dollars;
  }

  if (totalWeight === 0) return 0.005;

  const avgPrice = weightedPrice / totalWeight;
  // Cap slippage at 3 cents max
  return Math.min(0.03, Math.abs(avgPrice - midpoint));
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

  // If spread > 10 cents, book is useless (illiquid or near-certain market)
  if (spread > 0.10) return null;

  const spreadPct = midpoint > 0 ? spread / midpoint : 1;

  const bidDepth = computeDepth(book.bids);
  const askDepth = computeDepth(book.asks);

  const liquidityScore = computeLiquidityScore(spreadPct, bidDepth, askDepth);

  // Friction = half the spread + taker fee
  const frictionCost = spread / 2 + POLYMARKET_TAKER_FEE_PCT;

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
  delayMs: number = 200
): Promise<Map<string, CLOBMetrics>> {
  const results = new Map<string, CLOBMetrics>();

  for (const tokenId of tokenIds) {
    const metrics = await getCLOBMetrics(tokenId);
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
