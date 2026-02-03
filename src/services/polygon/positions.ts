import {
  TARGET_ARBITRAGE_PROFIT_PCT,
  ARBITRAGE_PAIR_TIMEOUT_MS,
  STAGNATION_TIMEOUT_MS,
  ESTIMATED_GAS_FEE_MATIC,
  ESTIMATED_SLIPPAGE_POLYMARKET,
  SPOT_HEDGE_FEE_BPS,
} from "../../config/constants.js";
import {
  savePosition as savePositionToDb,
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

// Generate unique position ID
function generatePositionId(): string {
  return `pos_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Calculate fees for the position
function calculateFees(sizeUsd: number = 10, hasSpotHedge: boolean = false): number {
  // Polymarket fees: gas (MATIC converted to USD) + slippage
  // Entry: gas + slippage, Exit: gas + slippage
  const gasFeeUsd = ESTIMATED_GAS_FEE_MATIC * 1.065; // ~$0.000107 per MATIC gas, 2 transactions
  const slippageFeeUsd = sizeUsd * ESTIMATED_SLIPPAGE_POLYMARKET * 2; // Entry and exit
  let totalFees = gasFeeUsd + slippageFeeUsd;

  // Add spot hedge fees if present (entry + exit)
  if (hasSpotHedge) {
    const spotFeeUsd = sizeUsd * 2 * (SPOT_HEDGE_FEE_BPS / 10000);
    totalFees += spotFeeUsd;
  }

  return totalFees;
}

// Create a new position
export function createPosition(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  sizeUsd: number,
  spotSymbol?: string,
  spotEntryPrice?: number
): Position {
  const id = generatePositionId();

  // Determine spot hedge details
  let spotSide: "LONG" | "SHORT" | null = null;
  let spotSize: number | null = null;

  if (spotSymbol && spotEntryPrice !== undefined) {
    // Spot hedge is opposite of Polymarket side
    spotSide = side === "BUY" ? "SHORT" : "LONG";
    spotSize = sizeUsd; // Dollar-neutral hedge
  }

  // Calculate estimated fees (including spot if hedged)
  const hasSpotHedge = spotSymbol !== undefined;
  const estimatedFees = calculateFees(sizeUsd, hasSpotHedge);

  // Calculate target profit in USD
  const targetProfit = sizeUsd * (TARGET_ARBITRAGE_PROFIT_PCT / 100);

  const position: Position = {
    id,
    polymarketTokenId: tokenId,
    side,
    entryPrice: price,
    size: sizeUsd,
    entryTimestamp: Date.now(),
    status: "pending",
    targetProfit,
    estimatedFees,
    spotSymbol: spotSymbol || null,
    spotSide,
    spotEntryPrice: spotEntryPrice !== undefined ? spotEntryPrice : null,
    spotSize,
  };

  activePositions.set(id, position);

  // Persist to database
  savePositionToDb(position);

  return position;
}

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
  if (position.side === "BUY") {
    // Bought at entry, selling at exit
    polymarketPnl = (exitPrice - position.entryPrice) * (position.size / position.entryPrice);
  } else {
    // Sold at entry, buying back at exit
    polymarketPnl = (position.entryPrice - exitPrice) * (position.size / position.entryPrice);
  }

  // Calculate spot hedge P&L if present
  let spotPnl = 0;
  if (position.spotSymbol && position.spotEntryPrice && currentSpotPrice !== undefined) {
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

// Get all active positions
export function getActivePositions(): Position[] {
  return Array.from(activePositions.values()).filter((p) => p.status !== "closed");
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
  if (position.side === "BUY") {
    polymarketPnl = (currentPrice - position.entryPrice) * (position.size / position.entryPrice);
  } else {
    polymarketPnl = (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
  }

  // Calculate spot hedge P&L if present
  let spotPnl = 0;
  if (position.spotSymbol && position.spotEntryPrice && currentSpotPrice !== undefined) {
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

// Get count of active positions
export function getActivePositionCount(): number {
  return getActivePositions().length;
}

// Update position status
export function updatePositionStatus(positionId: string, status: PositionStatus): void {
  const position = activePositions.get(positionId);
  if (position) {
    position.status = status;
    // Persist status update to database
    savePositionToDb(position);
  }
}

// Set position order ID
export function setPositionOrderId(positionId: string, orderId: string): void {
  const position = activePositions.get(positionId);
  if (position) {
    position.orderId = orderId;
    // Persist order ID to database
    savePositionToDb(position);
  }
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
