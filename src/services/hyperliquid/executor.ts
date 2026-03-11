import { getTradingMode } from "../../config/env.js";
import { getEngineExchange, QUANT_HYBRID_LIVE_ENGINES, QUANT_MAX_SL_PCT } from "../../config/constants.js";
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
    (mode === "hybrid" && QUANT_HYBRID_LIVE_ENGINES.has(tradeType)) ||
    (mode === "hybrid" && tradeType === "ai-directional"));

  const posMode: "live" | "paper" = useLive ? "live" : "paper";
  const strategy = strategyFromTradeType(tradeType);
  const riskCheck = validateRiskGates({ leverage, stopLoss, regime: effectiveRegime, strategy, mode: posMode });
  if (!riskCheck.allowed) {
    console.log(`[Quant Executor] Position blocked by risk gate: ${riskCheck.reason}`);
    return null;
  }

  // Cap SL; skip for inverted (their SL = normal's TP)
  const isInverted = (tradeType as string).startsWith("inv-");
  if (aiEntryPrice && aiEntryPrice > 0 && !isInverted) {
    const maxSlFrac = QUANT_MAX_SL_PCT / 100;
    if (direction === "long") {
      const floor = aiEntryPrice * (1 - maxSlFrac);
      if (stopLoss < floor) {
        console.log(`[Quant Executor] Capped ${pair} SL ${stopLoss.toFixed(4)}->${floor.toFixed(4)} (${QUANT_MAX_SL_PCT}%)`);
        stopLoss = floor;
      }
    } else {
      const ceil = aiEntryPrice * (1 + maxSlFrac);
      if (stopLoss > ceil) {
        console.log(`[Quant Executor] Capped ${pair} SL ${stopLoss.toFixed(4)}->${ceil.toFixed(4)} (${QUANT_MAX_SL_PCT}%)`);
        stopLoss = ceil;
      }
    }
  }

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
