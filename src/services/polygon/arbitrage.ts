import { getMidPrice, getBestBid, getBestAsk, onOrderbookUpdate } from "./orderbook.js";
import { placeFokOrder } from "./polymarket.js";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { MAX_ACTIVE_HEDGED_PAIRS } from "../../config/constants.js";
import {
  createPosition,
  closePosition,
  getActivePositions,
  shouldExitPosition,
  getActivePositionCount,
  updatePositionStatus,
  setPositionOrderId,
} from "./positions.js";
import { insertTrade } from "../database/trades.js";

export interface PolymarketOpportunity {
  tokenId: string;
  direction: "BUY" | "SELL";
  price: number;
  timestamp: number;
}

export interface TradeResult {
  success: boolean;
  opportunity: PolymarketOpportunity;
  orderId?: string;
  positionId?: string;
  error?: string;
  isPaper: boolean;
}

type OpportunityCallback = (opportunity: PolymarketOpportunity) => void;

const opportunityCallbacks: Set<OpportunityCallback> = new Set();

let isRunning = false;
let unsubscribe: (() => void) | null = null;
let monitoringInterval: NodeJS.Timeout | null = null;

// Execute Polymarket trade
export async function executeTrade(
  opportunity: PolymarketOpportunity,
  sizeDollars: number
): Promise<TradeResult> {
  const env = loadEnv();

  // Check if we've hit max active positions
  if (getActivePositionCount() >= MAX_ACTIVE_HEDGED_PAIRS) {
    return {
      success: false,
      opportunity,
      error: `Max active positions reached: ${MAX_ACTIVE_HEDGED_PAIRS}`,
      isPaper: isPaperMode(),
    };
  }

  // Check max bet size
  if (sizeDollars > env.MAX_POLYMARKET_BET_USDC) {
    sizeDollars = env.MAX_POLYMARKET_BET_USDC;
  }

  const price =
    opportunity.direction === "BUY"
      ? getBestAsk(opportunity.tokenId)?.price
      : getBestBid(opportunity.tokenId)?.price;

  if (!price) {
    return {
      success: false,
      opportunity,
      error: "No price available",
      isPaper: isPaperMode(),
    };
  }

  // Create position (no spot hedge)
  const position = createPosition(
    opportunity.tokenId,
    opportunity.direction,
    price,
    sizeDollars
  );

  // Paper mode
  if (isPaperMode()) {
    console.log(
      `[Polymarket] PAPER: Opened position ${position.id}: ${opportunity.direction} @ ${price}`
    );
    updatePositionStatus(position.id, "active");
    setPositionOrderId(position.id, `paper_${Date.now()}`);
    return {
      success: true,
      opportunity,
      orderId: `paper_${Date.now()}`,
      positionId: position.id,
      isPaper: true,
    };
  }

  // Execute FOK order
  const order = await placeFokOrder(
    opportunity.tokenId,
    opportunity.direction,
    price.toString(),
    (sizeDollars / price).toString()
  );

  if (!order) {
    return {
      success: false,
      opportunity,
      error: "FOK order failed",
      isPaper: false,
    };
  }

  // Update position with order ID and mark as active
  setPositionOrderId(position.id, order.id);
  updatePositionStatus(position.id, "active");

  console.log(
    `[Polymarket] Opened position ${position.id}: ${opportunity.direction} @ ${price}`
  );

  return {
    success: true,
    opportunity,
    orderId: order.id,
    positionId: position.id,
    isPaper: false,
  };
}

// Monitor active positions for exit conditions
function monitorPositions(): void {
  const positions = getActivePositions();

  for (const position of positions) {
    // Get current price
    const currentPrice = getMidPrice(position.polymarketTokenId);

    if (!currentPrice) {
      continue;
    }

    // Check if should exit (no spot price)
    const { shouldExit, reason } = shouldExitPosition(position, currentPrice);

    if (shouldExit) {
      console.log(`[Polymarket] Exiting position ${position.id}: ${reason}`);

      // Mark as exiting
      updatePositionStatus(position.id, "exiting");

      // Calculate final P&L
      const result = closePosition(position.id, currentPrice);

      if (result) {
        const holdTimeSeconds = Math.floor(result.holdTimeMs / 1000);

        // Record trade with actual P&L
        insertTrade({
          strategy: "polymarket",
          type: position.side,
          tokenAddress: position.polymarketTokenId,
          amountUsd: position.size,
          price: currentPrice,
          pnl: result.pnl,
          pnlPercentage: result.pnlPercentage,
          fees: result.fees,
          orderId: position.orderId,
          status: "completed",
        });

        const mode = isPaperMode() ? "PAPER: " : "";
        console.log(
          `[Polymarket] ${mode}Closed position ${position.id}: P&L $${result.pnl.toFixed(2)} (${result.pnlPercentage.toFixed(2)}%) after ${holdTimeSeconds}s`
        );
      }
    }
  }
}

// Start monitoring for opportunities
export function startMonitoring(): void {
  if (isRunning) return;

  isRunning = true;

  unsubscribe = onOrderbookUpdate((orderbook) => {
    const midPrice = getMidPrice(orderbook.tokenId);
    if (!midPrice) return;

    const opportunity: PolymarketOpportunity = {
      tokenId: orderbook.tokenId,
      direction: midPrice < 0.5 ? "BUY" : "SELL",
      price: midPrice,
      timestamp: Date.now(),
    };

    for (const callback of opportunityCallbacks) {
      try {
        callback(opportunity);
      } catch (err) {
        console.error("[Polymarket] Callback error:", err);
      }
    }
  });

  // Start monitoring positions every 5 seconds
  monitoringInterval = setInterval(() => {
    monitorPositions();
  }, 5000);

  console.log("[Polymarket] Monitoring started");
}

// Stop monitoring
export function stopMonitoring(): void {
  if (!isRunning) return;

  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }

  // Warn about unclosed positions
  const activePositionsList = getActivePositions();
  if (activePositionsList.length > 0) {
    console.warn(
      `[Polymarket] Stopping with ${activePositionsList.length} unclosed positions: ${activePositionsList.map((p) => p.id).join(", ")}`
    );
  }

  isRunning = false;
  console.log("[Polymarket] Monitoring stopped");
}

// Subscribe to opportunities
export function onOpportunity(callback: OpportunityCallback): () => void {
  opportunityCallbacks.add(callback);
  return () => opportunityCallbacks.delete(callback);
}

// Check if monitoring is active
export function isMonitoring(): boolean {
  return isRunning;
}
