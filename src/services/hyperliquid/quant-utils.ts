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

// Parse metadata from indicatorsAtEntry string (format: "impact:high|src:Trump|btc:87500|eq:150|ets:17743...")
export function parseIndicatorsMeta(indicators?: string): {
  btcPrice?: number;
  equity?: number;
  source?: string;
  eventTs?: string;
} {
  if (!indicators) return {};
  const parts = indicators.split("|");
  const meta: Record<string, string> = {};
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx > 0) {
      const key = part.slice(0, idx);
      const val = part.slice(idx + 1);
      if (key === "src" || key === "btc" || key === "eq" || key === "ets") {
        meta[key] = val;
      }
    }
  }
  return {
    btcPrice: meta.btc ? parseFloat(meta.btc) : undefined,
    equity: meta.eq ? parseFloat(meta.eq) : undefined,
    source: meta.src || undefined,
    eventTs: meta.ets || undefined,
  };
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
