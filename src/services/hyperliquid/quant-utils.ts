import { QUANT_MAX_SL_PCT } from "../../config/constants.js";

// Cap SL to max %; inverted skip (their SL = normal's TP)
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

// Realized PnL: (exit-entry)/entry * notional - fees
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

// Classify exchange close: SL, TP, or generic (0.5% tolerance)
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
  const pctFromEntry = ((exitPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(3);
  const slStr = sl ? `sl=${sl.toPrecision(6)}` : "sl=none";
  const tpStr = tp ? `tp=${tp.toPrecision(6)}` : "tp=none";
  return `exchange-close (${parseFloat(pctFromEntry) >= 0 ? "+" : ""}${pctFromEntry}% from entry, ${slStr}, ${tpStr})`;
}

// True if SL close should record cooldown; inv-* and hft-fade exempt
export function shouldRecordSlCooldown(tradeType: string): boolean {
  return !tradeType.startsWith("inv-") && tradeType !== "hft-fade";
}

// Rebase SL/TP from expected entry to actual fill (preserves % offset)
export function rebaseStops(
  stopLoss: number,
  takeProfit: number,
  aiEntryPrice: number,
  fillPrice: number,
): { stopLoss: number; takeProfit: number } {
  const stopPct = (stopLoss - aiEntryPrice) / aiEntryPrice;
  const tpPct = (takeProfit - aiEntryPrice) / aiEntryPrice;
  return {
    stopLoss: fillPrice * (1 + stopPct),
    takeProfit: fillPrice * (1 + tpPct),
  };
}
