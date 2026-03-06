import { getTradingMode } from "../../config/env.js";
import {
  paperOpenPosition,
  paperClosePosition,
  getPaperBalance,
  getPaperPositions,
} from "./paper.js";
import {
  liveOpenPosition,
  liveClosePosition,
  getLivePositions,
} from "./live-executor.js";
import { validateRiskGates, recordDailyLoss, strategyFromTradeType } from "./risk-manager.js";
import { clearAICacheForPair } from "./ai-analyzer.js";
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
  aiAgreed?: boolean | null,
): Promise<QuantPosition | null> {
  // Funding positions bypass volatile regime check (they're regime-agnostic)
  const effectiveRegime = tradeType === "funding" ? "ranging" : regime;
  const strategy = strategyFromTradeType(tradeType);
  const riskCheck = validateRiskGates({ leverage, stopLoss, regime: effectiveRegime, strategy });
  if (!riskCheck.allowed) {
    console.log(`[Quant Executor] Position blocked by risk gate: ${riskCheck.reason}`);
    return null;
  }

  const mode = getTradingMode();
  // hybrid: only AI goes live. live: everything goes live.
  const useLive =
    mode === "live" ||
    (mode === "hybrid" && tradeType === "ai-directional");

  if (useLive) {
    return liveOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, aiConfidence, aiReasoning, indicatorsAtEntry, aiEntryPrice, aiAgreed);
  }

  return paperOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, aiConfidence, aiReasoning, indicatorsAtEntry, aiEntryPrice, aiAgreed);
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  // Invalidate AI cache so next cycle gets fresh analysis
  const positions = getOpenQuantPositions();
  const pos = positions.find(p => p.id === positionId);
  if (pos) clearAICacheForPair(pos.pair);

  // Route close by position mode, not global mode
  const isLivePosition = pos?.mode === "live";
  const result = isLivePosition
    ? await liveClosePosition(positionId, reason)
    : await paperClosePosition(positionId, reason);

  if (result.success && result.pnl < 0) {
    const strategy = strategyFromTradeType(pos?.tradeType ?? "ai-directional");
    recordDailyLoss(Math.abs(result.pnl), strategy);
  }
  return result;
}

export function getOpenQuantPositions(): QuantPosition[] {
  // Always include live positions so monitor can protect them even after mode switch
  const live = getLivePositions();
  const paper = getPaperPositions();
  return live.length > 0 ? [...live, ...paper] : paper;
}

export function getVirtualBalance(tradeType?: TradeType): number {
  // Both modes return same notional balance for Kelly gate math.
  // Actual sizing uses QUANT_FIXED_POSITION_SIZE_USD, not this value.
  return getPaperBalance(tradeType);
}
