import { QUANT_MAX_SL_PCT } from "../../config/constants.js";

// Cap SL to max % from entry
export function capStopLoss(
  entryPrice: number,
  stopLoss: number,
  direction: "long" | "short",
): number {
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
  if (sl && pos.direction === "long" && exitPrice <= sl + tol) return "SL hit";
  if (sl && pos.direction === "short" && exitPrice >= sl - tol) return "SL hit";
  if (tp && pos.direction === "long" && exitPrice >= tp - tol) return "TP hit";
  if (tp && pos.direction === "short" && exitPrice <= tp + tol) return "TP hit";
  const pct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  return `closed ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
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

// Parse optional metadata embedded in indicatorsAtEntry JSON string
export function parseIndicatorsMeta(raw?: string): {
  btcPrice?: number;
  equity?: number;
  source?: string;
  eventTs?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      btcPrice: typeof parsed.btcPrice === "number" ? parsed.btcPrice : undefined,
      equity: typeof parsed.equity === "number" ? parsed.equity : undefined,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      eventTs: typeof parsed.eventTs === "string" ? parsed.eventTs : undefined,
    };
  } catch {
    return {};
  }
}
