import { getMidPrice, getSpread, getBestBid, getBestAsk, onOrderbookUpdate } from "./orderbook.js";
import { placeFokOrder } from "./polymarket.js";
import { getPrice as getSpotPrice } from "../pricefeeds/manager.js";
import { isPaperMode, loadEnv } from "../../config/env.js";
import { MIN_CONFIDENCE_PERCENTAGE, MAX_ACTIVE_HEDGED_PAIRS } from "../../config/constants.js";
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

export interface ArbitrageOpportunity {
  tokenId: string;
  marketSymbol: string;
  direction: "BUY" | "SELL";
  polymarketPrice: number;
  spotPrice: number;
  priceDiff: number;
  confidence: number;
  timestamp: number;
}

export interface ArbitrageResult {
  success: boolean;
  opportunity: ArbitrageOpportunity;
  orderId?: string;
  pairId?: string;
  spotHedgePrice?: number;
  error?: string;
  isPaper: boolean;
}

type OpportunityCallback = (opportunity: ArbitrageOpportunity) => void;

// Market mappings: Polymarket token ID -> Binance symbol
const marketMappings: Map<string, { tokenId: string; symbol: string; isYes: boolean }> = new Map();
const opportunityCallbacks: Set<OpportunityCallback> = new Set();

let isRunning = false;
let unsubscribe: (() => void) | null = null;
let monitoringInterval: NodeJS.Timeout | null = null;

// Register a market for arbitrage monitoring
export function registerMarket(
  tokenId: string,
  binanceSymbol: string,
  isYesToken: boolean
): void {
  marketMappings.set(tokenId, {
    tokenId,
    symbol: binanceSymbol,
    isYes: isYesToken,
  });
  console.log(`[Arbitrage] Registered market: ${tokenId} -> ${binanceSymbol}`);
}

// Calculate confidence based on price difference and spread
function calculateConfidence(
  polyPrice: number,
  spotPrice: number,
  spread: number
): number {
  // Confidence is based on:
  // 1. How much the price differs from spot (higher diff = higher confidence)
  // 2. How tight the spread is (tighter = higher confidence)
  // 3. Whether the opportunity makes logical sense

  const priceDiff = Math.abs(polyPrice - spotPrice);
  const diffPercentage = (priceDiff / spotPrice) * 100;

  // Base confidence from price difference (up to 50%)
  const diffConfidence = Math.min(diffPercentage * 10, 50);

  // Spread confidence (tighter spread = higher confidence, up to 30%)
  const spreadPercentage = (spread / polyPrice) * 100;
  const spreadConfidence = Math.max(0, 30 - spreadPercentage * 10);

  // Time factor - fresh data is more confident (up to 20%)
  const timeConfidence = 20;

  return Math.min(100, diffConfidence + spreadConfidence + timeConfidence);
}

// Detect arbitrage opportunity
function detectOpportunity(tokenId: string): ArbitrageOpportunity | null {
  const market = marketMappings.get(tokenId);
  if (!market) return null;

  const polyPrice = getMidPrice(tokenId);
  const spread = getSpread(tokenId);
  const spotPrice = getSpotPrice(market.symbol);

  if (!polyPrice || !spread || !spotPrice) return null;

  // For YES tokens: if poly price < implied probability from spot, it's undervalued
  // For NO tokens: if poly price > (1 - implied probability), it's overvalued
  // This is simplified - real implementation would need event-specific logic

  const impliedProb = market.isYes ? spotPrice : 1 - spotPrice;
  const priceDiff = polyPrice - impliedProb;
  const confidence = calculateConfidence(polyPrice, impliedProb, spread);

  // Only consider if there's meaningful difference
  if (Math.abs(priceDiff) < 0.02) return null; // 2% minimum difference

  const direction: "BUY" | "SELL" = priceDiff < 0 ? "BUY" : "SELL";

  return {
    tokenId,
    marketSymbol: market.symbol,
    direction,
    polymarketPrice: polyPrice,
    spotPrice: impliedProb,
    priceDiff: Math.abs(priceDiff),
    confidence,
    timestamp: Date.now(),
  };
}

// Execute arbitrage trade
export async function executeArbitrage(
  opportunity: ArbitrageOpportunity,
  sizeDollars: number
): Promise<ArbitrageResult> {
  const env = loadEnv();

  // Check confidence threshold
  if (opportunity.confidence < MIN_CONFIDENCE_PERCENTAGE) {
    return {
      success: false,
      opportunity,
      error: `Confidence ${opportunity.confidence}% below threshold ${MIN_CONFIDENCE_PERCENTAGE}%`,
      isPaper: isPaperMode(),
    };
  }

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

  // Get spot price for hedge
  const spotPrice = getSpotPrice(opportunity.marketSymbol);

  // Create position with spot hedge
  const position = createPosition(
    opportunity.tokenId,
    opportunity.direction,
    price,
    sizeDollars,
    spotPrice ? opportunity.marketSymbol : undefined,
    spotPrice || undefined
  );

  // Determine spot side for logging
  const spotSide = opportunity.direction === "BUY" ? "SHORT" : "LONG";

  // Paper mode
  if (isPaperMode()) {
    const hedgeLog = spotPrice
      ? ` + ${spotSide} spot @ ${spotPrice}`
      : "";
    console.log(
      `[Arbitrage] PAPER: Opened position ${position.id}: ${opportunity.direction} @ ${price}${hedgeLog}`
    );
    if (spotPrice) {
      console.log(
        `[Arbitrage] PAPER: Hedge created with spot ${opportunity.marketSymbol} @ ${spotPrice}`
      );
    }
    updatePositionStatus(position.id, "active");
    setPositionOrderId(position.id, `paper_${Date.now()}`);
    return {
      success: true,
      opportunity,
      orderId: `paper_${Date.now()}`,
      pairId: position.id,
      spotHedgePrice: spotPrice || undefined,
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

  const hedgeLog = spotPrice
    ? ` + ${spotSide} spot @ ${spotPrice}`
    : "";
  console.log(
    `[Arbitrage] Opened position ${position.id}: ${opportunity.direction} @ ${price}${hedgeLog}`
  );

  return {
    success: true,
    opportunity,
    orderId: order.id,
    pairId: position.id,
    spotHedgePrice: spotPrice || undefined,
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

    // Get current spot price for hedged positions
    let currentSpotPrice: number | undefined;
    if (position.spotSymbol) {
      currentSpotPrice = getSpotPrice(position.spotSymbol) || undefined;
    }

    // Check if should exit
    const { shouldExit, reason } = shouldExitPosition(position, currentPrice, currentSpotPrice);

    if (shouldExit) {
      console.log(`[Arbitrage] Exiting position ${position.id}: ${reason}`);

      // Mark as exiting
      updatePositionStatus(position.id, "exiting");

      // Calculate final P&L
      const result = closePosition(position.id, currentPrice, currentSpotPrice);

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

        // Log combined P&L if hedged
        if (position.spotSymbol && position.spotEntryPrice && position.spotEntryPrice > 0 && currentSpotPrice) {
          // Calculate individual P&Ls for logging
          let polyPnl = 0;
          if (position.entryPrice > 0) {
            if (position.side === "BUY") {
              polyPnl = (currentPrice - position.entryPrice) * (position.size / position.entryPrice);
            } else {
              polyPnl = (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
            }
          }

          let spotPnl = 0;
          if (position.spotSide === "SHORT") {
            spotPnl = (position.spotEntryPrice - currentSpotPrice) * (position.size / position.spotEntryPrice);
          } else if (position.spotSide === "LONG") {
            spotPnl = (currentSpotPrice - position.spotEntryPrice) * (position.size / position.spotEntryPrice);
          }

          console.log(
            `[Arbitrage] ${mode}Closed hedge: Poly P&L $${polyPnl.toFixed(2)} + Spot P&L $${spotPnl.toFixed(2)} = Net $${result.pnl.toFixed(2)} (${result.pnlPercentage.toFixed(2)}%) after ${holdTimeSeconds}s`
          );
        } else {
          console.log(
            `[Arbitrage] ${mode}Closed position ${position.id}: P&L $${result.pnl.toFixed(2)} (${result.pnlPercentage.toFixed(2)}%) after ${holdTimeSeconds}s`
          );
        }
      }
    }
  }
}

// Start monitoring for opportunities
export function startMonitoring(): void {
  if (isRunning) return;

  isRunning = true;

  unsubscribe = onOrderbookUpdate((orderbook) => {
    const opportunity = detectOpportunity(orderbook.tokenId);
    if (opportunity && opportunity.confidence >= MIN_CONFIDENCE_PERCENTAGE) {
      console.log(
        `[Arbitrage] Opportunity: ${opportunity.direction} ${opportunity.tokenId} ` +
          `(confidence: ${opportunity.confidence.toFixed(1)}%)`
      );

      for (const callback of opportunityCallbacks) {
        try {
          callback(opportunity);
        } catch (err) {
          console.error("[Arbitrage] Callback error:", err);
        }
      }
    }
  });

  // Start monitoring positions every 5 seconds
  monitoringInterval = setInterval(() => {
    monitorPositions();
  }, 5000);

  console.log("[Arbitrage] Monitoring started");
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
      `[Arbitrage] Stopping with ${activePositionsList.length} unclosed positions: ${activePositionsList.map((p) => p.id).join(", ")}`
    );
  }

  isRunning = false;
  console.log("[Arbitrage] Monitoring stopped");
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

// Get all registered markets
export function getRegisteredMarkets(): Map<
  string,
  { tokenId: string; symbol: string; isYes: boolean }
> {
  return new Map(marketMappings);
}
