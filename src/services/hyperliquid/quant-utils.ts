import { QUANT_MAX_SL_PCT } from "../../config/constants.js";

/**
 * Cap a stop-loss price to QUANT_MAX_SL_PCT from entry.
 * Inverted engines skip capping (their SL = normal engine's TP).
 */
export function capStopLoss(
  entryPrice: number,
  stopLoss: number,
  direction: "long" | "short",
  isInverted: boolean,
): number {
  if (isInverted) return stopLoss;
  const maxSlFrac = QUANT_MAX_SL_PCT / 100;
  if (direction === "long") {
    const floor = entryPrice * (1 - maxSlFrac);
    return stopLoss < floor ? floor : stopLoss;
  } else {
    const ceil = entryPrice * (1 + maxSlFrac);
    return stopLoss > ceil ? ceil : stopLoss;
  }
}

/**
 * Calculate realized PnL for a closed position.
 * notional = size * leverage
 */
export function calcPnl(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  size: number,
  leverage: number,
  fees: number,
): number {
  const notional = size * leverage;
  const rawPnl =
    direction === "long"
      ? ((exitPrice - entryPrice) / entryPrice) * notional
      : ((entryPrice - exitPrice) / entryPrice) * notional;
  return rawPnl - fees;
}

/**
 * Infer why an exchange-triggered close happened.
 * Uses 0.5% tolerance for slippage.
 */
export function inferExitReason(
  pos: { direction: "long" | "short"; entryPrice: number; stopLoss?: number; takeProfit?: number },
  exitPrice: number,
): string {
  const sl = pos.stopLoss;
  const tp = pos.takeProfit;
  const tol = pos.entryPrice * 0.005;
  if (sl && pos.direction === "long" && exitPrice <= sl + tol) return "exchange-sl";
  if (sl && pos.direction === "short" && exitPrice >= sl - tol) return "exchange-sl";
  if (tp && pos.direction === "long" && exitPrice >= tp - tol) return "exchange-tp";
  if (tp && pos.direction === "short" && exitPrice <= tp + tol) return "exchange-tp";
  return "exchange-close";
}

/**
 * Returns true if a stop-loss close should record a SL cooldown for the engine.
 * Inverted engines and hft-fade never record cooldowns.
 */
export function shouldRecordSlCooldown(tradeType: string): boolean {
  return !tradeType.startsWith("inv-") && tradeType !== "hft-fade";
}
