import { getTradingMode } from "../../config/env.js";
import { getEngineExchange, QUANT_HYBRID_LIVE_ENGINES } from "../../config/constants.js";
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
import {
  lighterOpenPosition,
  lighterClosePosition,
  getLighterLivePositions,
} from "../lighter/executor.js";
import { validateRiskGates, recordDailyLoss, strategyFromTradeType } from "./risk-manager.js";
import type { QuantPosition, MarketRegime, TradeType } from "./types.js";

export async function openPosition(
  pair: string,
  direction: "long" | "short",
  sizeUsd: number,
  leverage: number,
  stopLoss: number,
  takeProfit: number,
  regime: MarketRegime,
  tradeType: TradeType = "directional",
  indicatorsAtEntry?: string,
  aiEntryPrice?: number,
  forcePaper?: boolean,
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
  const exchange = getEngineExchange(tradeType);
  // forcePaper bypasses live routing
  const useLive = !forcePaper && (
    mode === "live" ||
    (mode === "hybrid" && QUANT_HYBRID_LIVE_ENGINES.has(tradeType)) ||
    (mode === "hybrid" && tradeType === "ai-directional"));

  // One live position per pair per exchange
  if (useLive) {
    const allPositions = getOpenQuantPositions();
    const existingLive = allPositions.find(p => p.pair === pair && p.exchange === exchange && p.mode === "live");
    if (existingLive) {
      console.log(`[Quant Executor] ${pair} already open live on ${exchange}, skipping`);
      return null;
    }
  }

  if (exchange === "lighter") {
    if (useLive) {
      return lighterOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, indicatorsAtEntry, aiEntryPrice);
    }
    return paperOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, indicatorsAtEntry, aiEntryPrice, "lighter");
  }

  if (useLive) {
    return liveOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, indicatorsAtEntry, aiEntryPrice);
  }

  return paperOpenPosition(pair, direction, sizeUsd, leverage, stopLoss, takeProfit, tradeType, indicatorsAtEntry, aiEntryPrice);
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<{ success: boolean; pnl: number }> {
  const positions = getOpenQuantPositions();
  const pos = positions.find(p => p.id === positionId);

  // Route close by position exchange and mode
  const isLighterLive = pos?.exchange === "lighter" && pos?.mode === "live";
  const isHLLive = pos?.mode === "live" && pos?.exchange !== "lighter";
  const result = isLighterLive
    ? await lighterClosePosition(positionId, reason)
    : isHLLive
      ? await liveClosePosition(positionId, reason)
      : await paperClosePosition(positionId, reason);

  if (result.success && result.pnl < 0) {
    const strategy = strategyFromTradeType(pos?.tradeType ?? "directional");
    recordDailyLoss(Math.abs(result.pnl), strategy);
  }
  return result;
}

export function getOpenQuantPositions(): QuantPosition[] {
  // Always include live positions so monitor can protect them even after mode switch
  const live = getLivePositions();
  const lighterLive = getLighterLivePositions();
  const paper = getPaperPositions();
  const all = [...live, ...lighterLive, ...paper];
  // Dedup by id (shouldn't happen, but be safe)
  const seen = new Set<string>();
  return all.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export function getVirtualBalance(tradeType?: TradeType): number {
  // Both modes return same notional balance for Kelly gate math.
  // Actual sizing uses QUANT_FIXED_POSITION_SIZE_USD, not this value.
  return getPaperBalance(tradeType);
}
