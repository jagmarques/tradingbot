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

  // Get best price from orderbook
  const book = await getOrderbook(decision.tokenId);
  if (!book) {
    console.error("[Executor] Failed to get orderbook");
    return null;
  }

  // For BUY, use best ask; for SELL, use best bid
  const priceStr =
    decision.side === "YES"
      ? book.asks[0]?.[0]
      : book.bids[0]?.[0];

  if (!priceStr) {
    console.error("[Executor] No liquidity in orderbook");
    return null;
  }

  const price = parseFloat(priceStr);

  // Calculate size in shares (size in USD / price)
  const shares = decision.recommendedSize / price;
  const sharesStr = shares.toFixed(2);

  let orderId: string | undefined;

  if (isPaperMode()) {
    // Paper trading - simulate order
    orderId = `paper_${Date.now()}`;
    console.log(
      `[Executor] PAPER: ${decision.side} ${sharesStr} shares @ ${price}`
    );
  } else {
    // Live trading - place real order
    const order = await placeFokOrder(
      decision.tokenId,
      "BUY", // Always BUY the token (YES or NO token)
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
  const book = await getOrderbook(tokenId);
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(book.bids[0][0]);
  const bestAsk = parseFloat(book.asks[0][0]);
  return (bestBid + bestAsk) / 2;
}
