import type {
  PolymarketEvent,
  BetDecision,
  AIBettingPosition,
} from "./types.js";
import { placeGtcMakerOrder, cancelOrder, getOrderStatus, getOrderbook } from "../polygon/polymarket.js";
import { isPolymarketPaperMode as isPaperMode } from "../../config/env.js";
import { savePosition, loadOpenPositions, recordOutcome } from "../database/aibetting.js";
import { notifyAIBetPlaced, notifyAIBetClosed } from "../telegram/notifications.js";
import { ESTIMATED_GAS_FEE_MATIC, ESTIMATED_SLIPPAGE_POLYMARKET, CLOB_API_URL, POLYMARKET_TAKER_FEE_PCT } from "../../config/constants.js";
import { fetchWithTimeout } from "../../utils/fetch.js";

// In-memory position storage
const positions = new Map<string, AIBettingPosition>();

// Track pending GTC orders for AI betting
interface PendingOrder {
  orderId: string;
  positionId: string;
  tokenId: string;
  placedAt: number;
}
const pendingOrders = new Map<string, PendingOrder>(); // orderId -> PendingOrder
const ORDER_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

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

// Get public orderbook from CLOB API (no auth headers required)
async function fetchPublicOrderbook(
  tokenId: string
): Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]> } | null> {
  try {
    const response = await fetchWithTimeout(
      `${CLOB_API_URL}/book?token_id=${tokenId}`
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      bids?: Array<[string, string]>;
      asks?: Array<[string, string]>;
    };
    if (data.bids && data.asks) return { bids: data.bids, asks: data.asks };
    return null;
  } catch {
    return null;
  }
}

// Get midpoint price from CLOB API (public, no auth needed)
async function fetchMidpointPrice(tokenId: string): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(`${CLOB_API_URL}/midpoint?token_id=${tokenId}`);
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
    // Paper mode: use public orderbook best ask first, fall back to midpoint, then scanner price
    const book = await fetchPublicOrderbook(decision.tokenId);
    const bookPrice = book && book.asks.length > 0 ? parseFloat(book.asks[0][0]) : NaN;
    if (isFinite(bookPrice) && bookPrice > 0) {
      price = bookPrice;
      console.log(`[Executor] PAPER: using public book ask ${price.toFixed(3)}`);
    } else {
      const midpoint = await fetchMidpointPrice(decision.tokenId);
      if (midpoint !== null) {
        price = midpoint;
        console.log(`[Executor] PAPER: book invalid, using midpoint ${price.toFixed(3)}`);
      } else {
        price = decision.side === "YES" ? decision.marketPrice : 1 - decision.marketPrice;
        console.log(`[Executor] PAPER: midpoint also unavailable, using scanner price ${price.toFixed(3)}`);
      }
    }
    if (!isFinite(price) || price <= 0) {
      console.error(`[Executor] No valid price for ${market.title}, skipping`);
      return null;
    }
    orderId = `paper_${Date.now()}`;
    const shares = decision.recommendedSize / price;
    console.log(`[Executor] PAPER: ${decision.side} ${shares.toFixed(2)} shares @ ${price.toFixed(3)}`);
  } else {
    // Live mode: GTC limit order at AI's fair price (maker = 0% fees)
    const fairPrice = decision.aiProbability;
    // For YES, limit buy at our fair value. For NO, the token price is 1-aiProb.
    const limitPrice = decision.side === "YES" ? fairPrice : 1 - fairPrice;

    // Clamp to valid Polymarket price range (0.01-0.99, 2 decimal precision)
    const clampedPrice = Math.max(0.01, Math.min(0.99, Math.round(limitPrice * 100) / 100));
    const shares = decision.recommendedSize / clampedPrice;
    const sharesStr = shares.toFixed(2);
    const priceStr = clampedPrice.toFixed(2);

    const order = await placeGtcMakerOrder(
      decision.tokenId,
      "BUY",
      priceStr,
      sharesStr
    );

    if (!order) {
      console.error("[Executor] GTC order failed");
      return null;
    }

    orderId = order.id;

    if (order.status === "MATCHED") {
      // Filled immediately
      price = order.fillPrice ?? clampedPrice;
      console.log(`[Executor] GTC FILLED immediately: ${orderId}`);
    } else {
      // Resting on book as maker - track for periodic fill check
      price = clampedPrice;
      const positionId = generatePositionId();
      pendingOrders.set(orderId, {
        orderId,
        positionId,
        tokenId: decision.tokenId,
        placedAt: Date.now(),
      });
      console.log(`[Executor] GTC RESTING: ${orderId} @ ${priceStr} (expires in 1h)`);

      // Create position in "open" state - will be updated when filled
      const pendingPosition: AIBettingPosition = {
        id: positionId,
        marketId: market.conditionId,
        marketTitle: market.title,
        marketEndDate: market.endDate,
        tokenId: decision.tokenId,
        side: decision.side,
        entryPrice: clampedPrice,
        size: decision.recommendedSize,
        aiProbability: decision.aiProbability,
        confidence: decision.confidence,
        expectedValue: decision.expectedValue,
        status: "open",
        entryTimestamp: Date.now(),
      };

      savePosition(pendingPosition);
      positions.set(pendingPosition.id, pendingPosition);

      const marketPrice = decision.side === "YES" ? clampedPrice : 1 - clampedPrice;
      const edge = decision.aiProbability - marketPrice;
      await notifyAIBetPlaced({
        marketTitle: market.title,
        side: decision.side,
        size: decision.recommendedSize,
        entryPrice: clampedPrice,
        aiProbability: decision.aiProbability,
        edge,
        reasoning: `GTC limit @ ${priceStr} (${decision.reason})`,
      }).catch(err => console.error("[Executor] Failed to notify:", err));

      return pendingPosition;
    }
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

  savePosition(position);
  positions.set(position.id, position);
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
  }).catch(err => console.error("[Executor] Failed to notify bet placed:", err));

  return position;
}

export async function exitPosition(
  position: AIBettingPosition,
  currentPrice: number,
  reason: string
): Promise<{ success: boolean; pnl: number }> {
  console.log(`[Executor] Exiting position: ${position.marketTitle} - ${reason}`);

  // Calculate P&L (token price: current vs entry, same for YES and NO)
  const shares = position.size / position.entryPrice;
  let pnl = shares * (currentPrice - position.entryPrice);

  if (isPaperMode()) {
    // Use public orderbook best bid first for exit, fall back to midpoint, then currentPrice
    const exitBook = await fetchPublicOrderbook(position.tokenId);
    let exitPrice = currentPrice;
    const bidPrice = exitBook && exitBook.bids.length > 0 ? parseFloat(exitBook.bids[0][0]) : NaN;
    if (isFinite(bidPrice) && bidPrice > 0) {
      exitPrice = bidPrice;
      console.log(`[Executor] PAPER: using public book bid ${exitPrice.toFixed(3)}`);
    } else {
      const midpoint = await fetchMidpointPrice(position.tokenId);
      if (midpoint !== null) {
        exitPrice = midpoint;
        console.log(`[Executor] PAPER: book invalid, using midpoint ${exitPrice.toFixed(3)}`);
      }
    }
    pnl = shares * (exitPrice - position.entryPrice);

    // Deduct CLOB taker fee (0.15% per side): entry on position.size, exit on shares * exitPrice
    const entryFee = position.size * POLYMARKET_TAKER_FEE_PCT;
    const exitFee = shares * exitPrice * POLYMARKET_TAKER_FEE_PCT;
    const clobFee = entryFee + exitFee;
    const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10 * 2;
    const slippageFeeUsd = position.size * ESTIMATED_SLIPPAGE_POLYMARKET * 2;
    pnl -= (clobFee + gasFeeUsd + slippageFeeUsd);
    // Update currentPrice to exitPrice for position record
    currentPrice = exitPrice;
    console.log(`[Executor] PAPER: Exit @ ${exitPrice.toFixed(3)}, P&L: $${pnl.toFixed(2)} (after $${(clobFee + gasFeeUsd + slippageFeeUsd).toFixed(4)} fees)`);
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
    const order = await placeGtcMakerOrder(
      position.tokenId,
      "SELL",
      exitPriceStr,
      sharesStr
    );

    if (!order) {
      console.error("[Executor] Exit order failed");
      return { success: false, pnl: 0 };
    }

    console.log(`[Executor] Exit order placed: ${order.id}`);
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
  }).catch(err => console.error("[Executor] Failed to notify bet closed:", err));

  return { success: true, pnl };
}

export async function checkPendingOrders(): Promise<void> {
  const now = Date.now();

  for (const [orderId, pending] of pendingOrders.entries()) {
    try {
      // Cancel expired orders (> 1 hour)
      if (now - pending.placedAt > ORDER_EXPIRY_MS) {
        await cancelOrder(orderId);
        pendingOrders.delete(orderId);

        // Remove the position if it was never filled
        const pos = positions.get(pending.positionId);
        if (pos && pos.status === "open") {
          pos.status = "closed";
          pos.exitReason = "GTC order expired (1h)";
          pos.exitTimestamp = now;
          pos.pnl = 0;
          savePosition(pos);
          console.log(`[Executor] GTC expired: ${orderId} for ${pos.marketTitle}`);
        }
        continue;
      }

      // Check fill status
      const status = await getOrderStatus(orderId);
      if (!status) continue;

      const matched = parseFloat(status.sizeMatched);
      if (matched > 0) {
        pendingOrders.delete(orderId);
        const pos = positions.get(pending.positionId);
        if (pos) {
          pos.size = matched * pos.entryPrice;
          savePosition(pos);
          console.log(`[Executor] GTC FILLED: ${orderId} ${matched.toFixed(1)} shares`);
        }
        // Cancel any remainder
        await cancelOrder(orderId);
      }
    } catch {
      // Non-critical, retry next check
    }
  }
}

// Re-export for backward compat
export { checkMarketResolution } from "../shared/polymarket.js";

// Close position on market resolution (shares settle on-chain)
export async function resolvePosition(
  position: AIBettingPosition,
  finalPrice: number
): Promise<{ success: boolean; pnl: number }> {
  const shares = position.size / position.entryPrice;
  let pnl = (shares * finalPrice) - position.size;

  // Deduct estimated fees in paper mode
  if (isPaperMode()) {
    const clobFee = position.size * POLYMARKET_TAKER_FEE_PCT; // entry only (no exit order on resolution)
    const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.10;
    const slippageFeeUsd = position.size * ESTIMATED_SLIPPAGE_POLYMARKET;
    pnl -= (clobFee + gasFeeUsd + slippageFeeUsd);
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

  // Record calibration outcome: 1 if price resolved to 1.0, 0 if to 0.0
  const actualOutcome = finalPrice > 0.5 ? 1 : 0;
  recordOutcome(position.marketId, position.tokenId, actualOutcome as 0 | 1);

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
  }).catch(err => console.error("[Executor] Failed to notify bet closed:", err));

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

  // Fall back to public orderbook if midpoint unavailable
  const book = await fetchPublicOrderbook(tokenId);
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(book.bids[0][0]);
  const bestAsk = parseFloat(book.asks[0][0]);
  if (!isFinite(bestBid) || !isFinite(bestAsk)) return null;
  return (bestBid + bestAsk) / 2;
}

export function clearAllPositions(): void {
  positions.clear();
  console.log("[Executor] Cleared all in-memory positions");
}
