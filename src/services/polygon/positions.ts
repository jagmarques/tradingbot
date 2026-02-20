import {
  ARBITRAGE_PAIR_TIMEOUT_MS,
  STAGNATION_TIMEOUT_MS,
} from "../../config/constants.js";
import {
  markPositionClosed as markPositionClosedInDb,
  loadOpenPositions as loadOpenPositionsFromDb,
} from "../database/arbitrage-positions.js";

export type PositionStatus = "pending" | "active" | "exiting" | "closed";

export interface Position {
  id: string;
  polymarketTokenId: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  orderId?: string;
  entryTimestamp: number;
  status: PositionStatus;
  targetProfit: number;
  estimatedFees: number;
  spotSymbol: string | null;
  spotSide: "LONG" | "SHORT" | null;
  spotEntryPrice: number | null;
  spotSize: number | null;
}

export interface PositionResult {
  pnl: number;
  pnlPercentage: number;
  fees: number;
  holdTimeMs: number;
}

// Active positions storage
const activePositions = new Map<string, Position>();

// Calculate P&L for closing a position
export function closePosition(
  positionId: string,
  exitPrice: number,
  currentSpotPrice?: number
): PositionResult | null {
  const position = activePositions.get(positionId);
  if (!position) {
    return null;
  }

  // Calculate Polymarket P&L
  let polymarketPnl = 0;
  if (position.entryPrice > 0) {
    if (position.side === "BUY") {
      // Bought at entry, selling at exit
      polymarketPnl = (exitPrice - position.entryPrice) * (position.size / position.entryPrice);
    } else {
      // Sold at entry, buying back at exit
      polymarketPnl = (position.entryPrice - exitPrice) * (position.size / position.entryPrice);
    }
  }

  // Calculate spot hedge P&L if present
  let spotPnl = 0;
  if (position.spotSymbol && position.spotEntryPrice && position.spotEntryPrice > 0 && currentSpotPrice !== undefined) {
    if (position.spotSide === "SHORT") {
      // SHORT spot: profit when price falls
      spotPnl = (position.spotEntryPrice - currentSpotPrice) * (position.size / position.spotEntryPrice);
    } else if (position.spotSide === "LONG") {
      // LONG spot: profit when price rises
      spotPnl = (currentSpotPrice - position.spotEntryPrice) * (position.size / position.spotEntryPrice);
    }
  }

  // Total P&L minus fees
  const netPnl = polymarketPnl + spotPnl - position.estimatedFees;
  const pnlPercentage = (netPnl / position.size) * 100;
  const holdTimeMs = Date.now() - position.entryTimestamp;

  // Mark position as closed and remove from active positions
  position.status = "closed";
  activePositions.delete(positionId);

  // Update database
  markPositionClosedInDb(positionId);

  return {
    pnl: netPnl,
    pnlPercentage,
    fees: position.estimatedFees,
    holdTimeMs,
  };
}

// Get a specific position
export function getPosition(positionId: string): Position | null {
  return activePositions.get(positionId) || null;
}

// Determine if a position should be exited
export function shouldExitPosition(
  position: Position,
  currentPrice: number,
  currentSpotPrice?: number
): { shouldExit: boolean; reason: string } {
  // Calculate current P&L
  const now = Date.now();
  const holdTimeMs = now - position.entryTimestamp;

  // Check for stale position (>24h)
  if (holdTimeMs >= STAGNATION_TIMEOUT_MS) {
    return {
      shouldExit: true,
      reason: `Stale position (>24h)`,
    };
  }

  // Calculate potential P&L at current price
  let polymarketPnl = 0;
  if (position.entryPrice > 0) {
    if (position.side === "BUY") {
      polymarketPnl = (currentPrice - position.entryPrice) * (position.size / position.entryPrice);
    } else {
      polymarketPnl = (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
    }
  }

  // Calculate spot hedge P&L if present
  let spotPnl = 0;
  if (position.spotSymbol && position.spotEntryPrice && position.spotEntryPrice > 0 && currentSpotPrice !== undefined) {
    if (position.spotSide === "SHORT") {
      spotPnl = (position.spotEntryPrice - currentSpotPrice) * (position.size / position.spotEntryPrice);
    } else if (position.spotSide === "LONG") {
      spotPnl = (currentSpotPrice - position.spotEntryPrice) * (position.size / position.spotEntryPrice);
    }
  }

  const currentNetPnl = polymarketPnl + spotPnl - position.estimatedFees;

  // Exit if profit target reached
  if (currentNetPnl >= position.targetProfit) {
    return {
      shouldExit: true,
      reason: `Profit target reached: $${currentNetPnl.toFixed(2)} >= $${position.targetProfit.toFixed(2)}`,
    };
  }

  // Exit if timeout reached (even at break-even or small loss)
  if (holdTimeMs >= ARBITRAGE_PAIR_TIMEOUT_MS) {
    return {
      shouldExit: true,
      reason: `Timeout reached: ${(holdTimeMs / 1000).toFixed(0)}s >= ${(ARBITRAGE_PAIR_TIMEOUT_MS / 1000).toFixed(0)}s`,
    };
  }

  // Exit if stop loss hit (losing more than 2x the target profit)
  const stopLossThreshold = -position.targetProfit * 2;
  if (currentNetPnl <= stopLossThreshold) {
    return {
      shouldExit: true,
      reason: `Stop loss hit: $${currentNetPnl.toFixed(2)} <= $${stopLossThreshold.toFixed(2)}`,
    };
  }

  return {
    shouldExit: false,
    reason: "",
  };
}

// Load positions from DB into memory (for startup recovery)
export function loadPositionsFromDb(): number {
  const positions = loadOpenPositionsFromDb();

  // Clear existing positions in memory
  activePositions.clear();

  // Load positions into memory
  for (const position of positions) {
    activePositions.set(position.id, position);
  }

  console.log(`[Positions] Loaded ${positions.length} open positions from database`);
  return positions.length;
}
