import { isPaperMode } from "../../config/env.js";
import {
  paperOpenPosition,
  paperClosePosition,
  getPaperBalance,
  getPaperPositions,
} from "./paper.js";
import { validateRiskGates, recordDailyLoss } from "./risk-manager.js";
import type { QuantPosition, MarketRegime } from "./types.js";

export async function openPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  regime: MarketRegime,
  aiConfidence?: number,
  aiReasoning?: string,
  tradeType: "directional" | "funding" = "directional",
  indicatorsAtEntry?: string,
): Promise<QuantPosition | null> {
  // Funding positions bypass volatile regime check (they're regime-agnostic)
  const effectiveRegime = tradeType === "funding" ? "ranging" : regime;
  const riskCheck = validateRiskGates({ leverage, stopLoss, regime: effectiveRegime });
  if (!riskCheck.allowed) {
    console.log(`[Quant Executor] Position blocked by risk gate: ${riskCheck.reason}`);
    return null;
  }

  if (isPaperMode()) {
    return paperOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, aiConfidence, aiReasoning, indicatorsAtEntry);
  }

  // Live mode: not yet implemented (Phase 26+)
  console.warn(`[Quant Executor] Live trading not yet implemented. Use paper mode.`);
  return null;
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  if (isPaperMode()) {
    const result = await paperClosePosition(positionId, reason);
    if (result.success && result.pnl < 0) {
      recordDailyLoss(Math.abs(result.pnl));
    }
    return result;
  }

  // Live mode: not yet implemented (Phase 26+)
  console.warn(`[Quant Executor] Live trading not yet implemented. Use paper mode.`);
  return { success: false, pnl: 0 };
}

export function getOpenQuantPositions(): QuantPosition[] {
  if (isPaperMode()) {
    return getPaperPositions();
  }
  // Live positions returned from paper engine until live executor is built
  return getPaperPositions();
}

export function getVirtualBalance(): number {
  return getPaperBalance();
}
