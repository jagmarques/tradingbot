import { getTradingMode } from "../../config/env.js";
import { getEngineExchange, QUANT_HYBRID_LIVE_ENGINES, ENSEMBLE_MAX_CONCURRENT } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
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
  // Funding bypasses volatile regime check
  const effectiveRegime = tradeType === "funding" ? "ranging" : regime;
  const mode = getTradingMode();
  const exchange = getEngineExchange(tradeType);

  // forcePaper bypasses live routing
  const useLive = !forcePaper && (
    mode === "live" ||
    (mode === "hybrid" && QUANT_HYBRID_LIVE_ENGINES.has(tradeType)));

  const posMode: "live" | "paper" = useLive ? "live" : "paper";
  const strategy = strategyFromTradeType(tradeType);
  const allPositions = getOpenQuantPositions();
  const ensembleTypes = new Set(["donchian-trend", "supertrend-4h", "garch-v2", "carry-momentum"]);
  const openCountForEngine = ensembleTypes.has(tradeType)
    ? allPositions.filter(p => p.mode === posMode && ensembleTypes.has(p.tradeType ?? "")).length
    : allPositions.filter(p => p.mode === posMode && p.tradeType === tradeType).length;
  const maxPos = ensembleTypes.has(tradeType) ? ENSEMBLE_MAX_CONCURRENT : 5;
  const riskCheck = validateRiskGates({ leverage, stopLoss, regime: effectiveRegime, strategy, mode: posMode, openPositionCount: openCountForEngine, maxConcurrentPositions: maxPos });
  if (!riskCheck.allowed) {
    console.log(`[Quant Executor] Position blocked by risk gate: ${riskCheck.reason}`);
    return null;
  }

  if (aiEntryPrice && aiEntryPrice > 0) {
    const capped = capStopLoss(aiEntryPrice, stopLoss, direction);
    if (capped !== stopLoss) {
      console.log(`[Quant Executor] Capped ${pair} SL ${stopLoss.toFixed(4)}->${capped.toFixed(4)}`);
      stopLoss = capped;
    }
  }

  // One live position per pair per engine
  if (useLive) {
    const existingLive = allPositions.find(p => p.pair === pair && p.exchange === exchange && p.mode === "live" && p.tradeType === tradeType);
    if (existingLive) {
      console.log(`[Quant Executor] ${pair} already open live for ${tradeType}, skipping`);
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
  skipCancelReplace = false,
): Promise<{ success: boolean; pnl: number }> {
  const positions = getOpenQuantPositions();
  const pos = positions.find(p => p.id === positionId);

  // Route close by position exchange and mode
  const isLighterLive = pos?.exchange === "lighter" && pos?.mode === "live";
  const isHLLive = pos?.mode === "live" && pos?.exchange !== "lighter";
  const result = isLighterLive
    ? await lighterClosePosition(positionId, reason, skipCancelReplace)
    : isHLLive
      ? await liveClosePosition(positionId, reason)
      : await paperClosePosition(positionId, reason);

  if (result.success && result.pnl < 0) {
    const strategy = strategyFromTradeType(pos?.tradeType ?? "directional");
    const posMode: "live" | "paper" = pos?.mode === "live" ? "live" : "paper";
    recordDailyLoss(Math.abs(result.pnl), strategy, posMode);
  }
  return result;
}

export function getOpenQuantPositions(): QuantPosition[] {
  // Include live positions even after mode switch
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
  // Same balance for Kelly math; actual sizing is fixed USD.
  return getPaperBalance(tradeType);
}
