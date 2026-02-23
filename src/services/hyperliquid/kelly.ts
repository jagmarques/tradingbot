import { getVirtualBalance } from "./executor.js";
import {
  QUANT_AI_KELLY_FRACTION,
  QUANT_AI_STOP_LOSS_MAX_PCT,
  QUANT_MAX_POSITIONS,
} from "../../config/constants.js";

const MIN_POSITION_USD = 1; // $1 minimum position size

export function calculateQuantPositionSize(
  confidence: number,
  entryPrice: number,
  stopLoss: number,
): number {
  const balance = getVirtualBalance();
  if (balance <= 0) return 0;

  const winProb = confidence / 100;

  const stopDistance = Math.abs(entryPrice - stopLoss) / entryPrice;

  const maxStopFraction = QUANT_AI_STOP_LOSS_MAX_PCT / 100;
  const effectiveStop = Math.min(stopDistance, maxStopFraction);

  if (effectiveStop <= 0) return 0;

  // Edge over coin-flip
  const edge = winProb - 0.5;
  if (edge <= 0) return 0;

  // Kelly: edge / stop distance (tighter stops -> larger size, wider stops -> smaller)
  const kellyFull = edge / effectiveStop;
  const kellyFractional = kellyFull * QUANT_AI_KELLY_FRACTION;

  const rawSize = balance * kellyFractional;

  const maxSize = (balance * 0.95) / QUANT_MAX_POSITIONS;
  const size = Math.min(rawSize, maxSize);

  if (size < MIN_POSITION_USD) {
    console.log(`[Kelly] Size $${size.toFixed(2)} below $${MIN_POSITION_USD} min (balance=$${balance.toFixed(2)}, kelly=${(kellyFractional * 100).toFixed(1)}%)`);
    return 0;
  }

  return Math.floor(size * 100) / 100;
}
