import { isPaperMode } from "../../config/env.js";
import {
  paperOpenPosition,
  paperClosePosition,
  getPaperBalance,
  getPaperPositions,
} from "./paper.js";
import { validateRiskGates, recordDailyLoss } from "./risk-manager.js";
import { clearAICacheForPair } from "./ai-analyzer.js";
import { getPaperStartDate } from "../database/quant.js";
import { QUANT_PAPER_VALIDATION_DAYS } from "../../config/constants.js";
import type { QuantPosition, MarketRegime, TradeType } from "./types.js";

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
  tradeType: TradeType = "ai-directional",
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
): Promise<QuantPosition | null> {
  // Funding positions bypass volatile regime check (they're regime-agnostic)
  const effectiveRegime = tradeType === "funding" ? "ranging" : regime;
  const riskCheck = validateRiskGates({ leverage, stopLoss, regime: effectiveRegime });
  if (!riskCheck.allowed) {
    console.log(`[Quant Executor] Position blocked by risk gate: ${riskCheck.reason}`);
    return null;
  }

  if (isPaperMode()) {
    return paperOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, aiConfidence, aiReasoning, indicatorsAtEntry, aiEntryPrice);
  }

  // Live mode: validate paper period complete before allowing real trades
  const startDate = getPaperStartDate();
  if (!startDate) {
    console.warn(`[Quant Executor] Live mode blocked: no paper trading history. Run paper mode first.`);
    return null;
  }
  const daysElapsed = (Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysElapsed < QUANT_PAPER_VALIDATION_DAYS) {
    console.warn(`[Quant Executor] Live mode blocked: paper validation incomplete (${daysElapsed.toFixed(1)}/${QUANT_PAPER_VALIDATION_DAYS} days)`);
    return null;
  }
  // TODO: Wire real Hyperliquid order placement here when ready
  console.warn(`[Quant Executor] Live order placement not yet wired. Paper validation passed but real execution requires SDK order integration.`);
  return null;
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  // Invalidate AI cache so next cycle gets fresh analysis
  const pos = getPaperPositions().find(p => p.id === positionId);
  if (pos) clearAICacheForPair(pos.pair);

  if (isPaperMode()) {
    const result = await paperClosePosition(positionId, reason);
    if (result.success && result.pnl < 0) {
      recordDailyLoss(Math.abs(result.pnl));
    }
    return result;
  }

  // Live mode: position close not yet wired to real exchange
  console.warn(`[Quant Executor] Live position close not yet wired. Position ${positionId} requires manual close on Hyperliquid.`);
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
