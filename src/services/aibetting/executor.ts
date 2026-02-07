import type {
  PolymarketEvent,
  BetDecision,
  AIBettingPosition,
} from "./types.js";
import { placeFokOrder, getOrderbook } from "../polygon/polymarket.js";
import { isPaperMode } from "../../config/env.js";
import { savePosition, loadOpenPositions } from "../database/aibetting.js";
import { notifyAIBetPlaced, notifyAIBetClosed } from "../telegram/notifications.js";
import { ESTIMATED_GAS_FEE_MATIC, ESTIMATED_SLIPPAGE_POLYMARKET } from "../../config/constants.js";

const CLOB_API_URL = "https://clob.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// In-memory position storage
const positions = new Map<string, AIBettingPosition>();

// Load positions from DB on module init
export function initPositions(): number {
  const saved = loadOpenPositions();
  for (const pos of saved) {
    positions.set(pos.id, pos);
  }
  return saved.length;
}

function generatePositionId(): string {
  return `aib_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Get midpoint price from CLOB API (public, no auth needed)
async function fetchMidpointPrice(tokenId: string): Promise<number | null> {
  try {
    const response = await fetch(`${CLOB_API_URL}/midpoint?token_id=${tokenId}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { mid?: string };
    if (data.mid) {
      const price = parseFloat(data.mid);
      if (!isNaN(price) && price > 0) return price;
    }
    return null;
  } catch {
    return null;
  }
}

export async function enterPosition(
  decision: BetDecision,
  market: PolymarketEvent
): Promise<AIBettingPosition | null> {
  console.log(
    `[Executor] Entering ${decision.side} position on: ${market.title}`
  );

  // Check if we already have a position in this market
  for (const pos of positions.values()) {
    if (pos.marketId === market.conditionId && pos.status === "open") {
      console.log(`[Executor] Already have position in ${market.title}`);
      return null;
    }
  }

  let price: number;
  let orderId: string;

  if (isPaperMode()) {
    // Paper mode: use midpoint price, fall back to scanner price
    const midpoint = await fetchMidpointPrice(decision.tokenId);
    if (midpoint) {
      price = midpoint;
    } else {
      price = decision.side === "YES" ? decision.marketPrice : 1 - decision.marketPrice;
    }
    orderId = `paper_${Date.now()}`;
    const shares = decision.recommendedSize / price;
    console.log(
      `[Executor] PAPER: ${decision.side} ${shares.toFixed(2)} shares @ ${price.toFixed(3)}`
    );
  } else {
    // Live mode: get real orderbook price and place order
    const book = await getOrderbook(decision.tokenId);
    if (!book) {
      console.error("[Executor] Failed to get orderbook");
      return null;
    }

    const priceStr =
      decision.side === "YES"
        ? book.asks[0]?.[0]
        : book.bids[0]?.[0];

    if (!priceStr) {
      console.error("[Executor] No liquidity in orderbook");
      return null;
    }

    price = parseFloat(priceStr);
    const shares = decision.recommendedSize / price;
    const sharesStr = shares.toFixed(2);

    const order = await placeFokOrder(
      decision.tokenId,
      "BUY",
      priceStr,
      sharesStr
    );

    if (!order) {
      console.error("[Executor] Order failed");
      return null;
    }

    orderId = order.id;
    console.log(`[Executor] Order filled: ${orderId}`);
  }

  // Create position record
  const position: AIBettingPosition = {
    id: generatePositionId(),
    marketId: market.conditionId,
    marketTitle: market.title,
    marketEndDate: market.endDate,
    tokenId: decision.tokenId,
    side: decision.side,
    entryPrice: price,
    size: decision.recommendedSize,
    aiProbability: decision.aiProbability,
    confidence: decision.confidence,
    expectedValue: decision.expectedValue,
    status: "open",
    entryTimestamp: Date.now(),
  };

  positions.set(position.id, position);
  savePosition(position); // Persist to DB
  console.log(`[Executor] Position created: ${position.id}`);

  // Send Telegram notification
  const marketPrice = decision.side === "YES" ? price : 1 - price;
  const edge = decision.aiProbability - marketPrice;
  await notifyAIBetPlaced({
    marketTitle: market.title,
    side: decision.side,
    size: decision.recommendedSize,
    entryPrice: price,
    aiProbability: decision.aiProbability,
    edge,
    reasoning: decision.reason || "AI identified edge",
  });

  return position;
}

export async function exitPosition(
  position: AIBettingPosition,
  currentPrice: number,
  reason: string
): Promise<{ success: boolean; pnl: number }> {
  console.log(`[Executor] Exiting position: ${position.marketTitle} - ${reason}`);

  // Calculate P&L
  const priceDiff =
    position.side === "YES"
      ? currentPrice - position.entryPrice
      : position.entryPrice - currentPrice;

  const shares = position.size / position.entryPrice;
  let pnl = shares * priceDiff;

  // Deduct estimated fees in paper mode (gas + slippage on entry and exit)
  if (isPaperMode()) {
    const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10 * 2; // ~$0.001 MATIC at $1.10 * 2 transactions
    const slippageFeeUsd = position.size * ESTIMATED_SLIPPAGE_POLYMARKET * 2; // Entry + exit
    pnl -= (gasFeeUsd + slippageFeeUsd);
    console.log(`[Executor] PAPER: Exit @ ${currentPrice}, P&L: $${pnl.toFixed(2)} (after $${(gasFeeUsd + slippageFeeUsd).toFixed(4)} fees)`);
  } else {
    // Live trading - place sell order
    const book = await getOrderbook(position.tokenId);
    if (!book) {
      console.error("[Executor] Failed to get orderbook for exit");
      return { success: false, pnl: 0 };
    }

    const exitPriceStr = book.bids[0]?.[0];
    if (!exitPriceStr) {
      console.error("[Executor] No bids for exit");
      return { success: false, pnl: 0 };
    }

    const sharesStr = shares.toFixed(2);
    const order = await placeFokOrder(
      position.tokenId,
      "SELL",
      exitPriceStr,
      sharesStr
    );

    if (!order) {
      console.error("[Executor] Exit order failed");
      return { success: false, pnl: 0 };
    }

    console.log(`[Executor] Exit order filled: ${order.id}`);
  }

  // Update position
  position.status = "closed";
  position.exitTimestamp = Date.now();
  position.exitPrice = currentPrice;
  position.pnl = pnl;
  position.exitReason = reason;
  savePosition(position); // Persist to DB

  // Send Telegram notification
  const pnlPercentage = (pnl / position.size) * 100;
  await notifyAIBetClosed({
    marketTitle: position.marketTitle,
    side: position.side,
    pnl,
    pnlPercentage,
    exitReason: reason,
  });

  return { success: true, pnl };
}

// Check if market resolved via GAMMA API
export async function checkMarketResolution(tokenId: string): Promise<{ resolved: boolean; finalPrice: number | null }> {
  try {
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
      return { resolved: true, finalPrice: isNaN(price) ? null : price };
    }

    return { resolved: false, finalPrice: null };
  } catch {
    return { resolved: false, finalPrice: null };
  }
}

// Close position on market resolution (shares settle on-chain)
export async function resolvePosition(
  position: AIBettingPosition,
  finalPrice: number
): Promise<{ success: boolean; pnl: number }> {
  const shares = position.size / position.entryPrice;
  let pnl = (shares * finalPrice) - position.size;

  // Deduct estimated fees in paper mode
  if (isPaperMode()) {
    const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10;
    const slippageFeeUsd = position.size * ESTIMATED_SLIPPAGE_POLYMARKET;
    pnl -= (gasFeeUsd + slippageFeeUsd);
  }

  const outcome = finalPrice > 0.5 ? "WON" : "LOST";
  const reason = `Market resolved: ${outcome}`;

  // Update position
  position.status = "closed";
  position.exitTimestamp = Date.now();
  position.exitPrice = finalPrice;
  position.pnl = pnl;
  position.exitReason = reason;
  savePosition(position);

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  console.log(`[Executor] RESOLVED: ${position.marketTitle} ${outcome} ${pnlStr}`);

  // Send Telegram notification
  const pnlPercentage = (pnl / position.size) * 100;
  await notifyAIBetClosed({
    marketTitle: position.marketTitle,
    side: position.side,
    pnl,
    pnlPercentage,
    exitReason: reason,
  });

  return { success: true, pnl };
}

export function getOpenPositions(): AIBettingPosition[] {
  return Array.from(positions.values()).filter((p) => p.status === "open");
}

export function getAllPositions(): AIBettingPosition[] {
  return Array.from(positions.values());
}

export function getPositionByMarket(marketId: string): AIBettingPosition | null {
  for (const pos of positions.values()) {
    if (pos.marketId === marketId && pos.status === "open") {
      return pos;
    }
  }
  return null;
}

export function getTotalExposure(): number {
  return getOpenPositions().reduce((sum, p) => sum + p.size, 0);
}

export function loadPosition(position: AIBettingPosition): void {
  positions.set(position.id, position);
}

export function clearClosedPositions(): void {
  for (const [id, pos] of positions.entries()) {
    if (pos.status === "closed") {
      positions.delete(id);
    }
  }
}

export async function getCurrentPrice(tokenId: string): Promise<number | null> {
  // Use midpoint endpoint (public, works for both paper and live)
  const midpoint = await fetchMidpointPrice(tokenId);
  if (midpoint !== null) return midpoint;

  // Fall back to orderbook if midpoint unavailable
  const book = await getOrderbook(tokenId);
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(book.bids[0][0]);
  const bestAsk = parseFloat(book.asks[0][0]);
  return (bestBid + bestAsk) / 2;
}

export function clearAllPositions(): void {
  positions.clear();
  console.log("[Executor] Cleared all in-memory positions");
}
