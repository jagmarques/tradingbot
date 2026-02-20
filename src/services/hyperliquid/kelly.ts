import { getVirtualBalance } from "./executor.js";
import {
  QUANT_AI_KELLY_FRACTION,
  QUANT_AI_STOP_LOSS_MAX_PCT,
  HYPERLIQUID_MAX_LEVERAGE,
} from "../../config/constants.js";

const MIN_POSITION_USD = 1; // $1 minimum position size

export function calculateQuantPositionSize(
  confidence: number, // 0-100
  entryPrice: number,
  stopLoss: number,
  leverage: number,
): number {
  const balance = getVirtualBalance();
  if (balance <= 0) return 0;

  // Convert confidence to win probability (0-1)
  const winProb = confidence / 100;

  // Calculate risk per unit (stop distance as fraction of entry)
  const stopDistance = Math.abs(entryPrice - stopLoss) / entryPrice;

  // Cap stop distance at max allowed
  const maxStopFraction = QUANT_AI_STOP_LOSS_MAX_PCT / 100;
  const effectiveStop = Math.min(stopDistance, maxStopFraction);

  if (effectiveStop <= 0) return 0;

  // Edge over coin-flip
  const edge = winProb - 0.5;
  if (edge <= 0) return 0;

  // Kelly fraction: edge / odds (simplified to edge * 2 for even odds baseline)
  const kellyFull = edge * 2;
  const kellyFractional = kellyFull * QUANT_AI_KELLY_FRACTION;

  // Position size = balance * kelly fraction (margin, not notional)
  const cappedLeverage = Math.min(leverage, HYPERLIQUID_MAX_LEVERAGE);
  void cappedLeverage; // Leverage validation handled in executor/risk layer (Phase 28)

  const rawSize = balance * kellyFractional;

  // Hard cap: no more than 20% of balance on any single trade
  const maxSize = balance * 0.2;
  const size = Math.min(rawSize, maxSize);

  if (size < MIN_POSITION_USD) {
    console.log(`[Kelly] Size $${size.toFixed(2)} below $${MIN_POSITION_USD} min (balance=$${balance.toFixed(2)}, kelly=${(kellyFractional * 100).toFixed(1)}%)`);
    return 0;
  }

  // Round down to 2 decimal places
  return Math.floor(size * 100) / 100;
}
