import type { SupportedChain, TokenAnalysisResult } from "./types.js";
import type { TokenPosition } from "../database/tokenai.js";
import type { TokenTradeRecommendation } from "./evaluator.js";
import { analyzeToken } from "./analyzer.js";
import {
  SELL_TARGETS,
  TRAILING_STOP_ACTIVATION,
  TRAILING_STOP_PERCENTAGE,
} from "../../config/constants.js";

// Static exit thresholds
export const TOKEN_STOP_LOSS_THRESHOLD = -0.25;
export const TOKEN_ADVERSE_MOVE_THRESHOLD = -0.15;
export const TOKEN_CONVICTION_FLIP_THRESHOLD = 0.40;
export const TOKEN_SCORE_DROP_THRESHOLD = 0.30;

// Correlation guard
export const MAX_THEME_EXPOSURE_RATIO = 0.30;

// Module-level peak price tracker (positionId -> peak price)
const peakPrices = new Map<string, number>();

export function updatePeakPrice(positionId: string, price: number): void {
  const current = peakPrices.get(positionId);
  if (current === undefined || price > current) {
    peakPrices.set(positionId, price);
  }
}

export function clearPeakPrice(positionId: string): void {
  peakPrices.delete(positionId);
}

// Exported for testing
export function _getPeakPrices(): Map<string, number> {
  return peakPrices;
}

export async function shouldExitTokenPosition(
  position: TokenPosition,
  currentPrice: number,
): Promise<{
  shouldExit: boolean;
  reason: string;
  newAnalysis?: TokenAnalysisResult;
}> {
  const changeRatio =
    (currentPrice - position.entryPrice) / position.entryPrice;
  const multiplier = currentPrice / position.entryPrice;

  // 1. Stop-loss (static, instant)
  if (changeRatio <= TOKEN_STOP_LOSS_THRESHOLD) {
    return {
      shouldExit: true,
      reason: `Stop-loss: ${(changeRatio * 100).toFixed(1)}% loss (threshold ${(TOKEN_STOP_LOSS_THRESHOLD * 100).toFixed(0)}%)`,
    };
  }

  // 2. Take-profit (static, instant) - check highest target first
  if (multiplier >= SELL_TARGETS.THIRD) {
    return {
      shouldExit: true,
      reason: `Take-profit: ${multiplier.toFixed(1)}x reached (${SELL_TARGETS.THIRD}x target)`,
    };
  }
  if (multiplier >= SELL_TARGETS.SECOND) {
    return {
      shouldExit: true,
      reason: `Take-profit: ${multiplier.toFixed(1)}x reached (${SELL_TARGETS.SECOND}x target)`,
    };
  }
  if (multiplier >= SELL_TARGETS.FIRST) {
    return {
      shouldExit: true,
      reason: `Take-profit: ${multiplier.toFixed(1)}x reached (${SELL_TARGETS.FIRST}x target)`,
    };
  }

  // 3. Trailing stop (static, instant)
  if (multiplier >= TRAILING_STOP_ACTIVATION) {
    updatePeakPrice(position.id, currentPrice);
    const peak = peakPrices.get(position.id);
    if (peak !== undefined && peak > 0) {
      const dropFromPeak = (peak - currentPrice) / peak;
      if (dropFromPeak >= TRAILING_STOP_PERCENTAGE) {
        return {
          shouldExit: true,
          reason: `Trailing stop: ${(dropFromPeak * 100).toFixed(1)}% drop from peak $${peak.toFixed(6)} (threshold ${(TRAILING_STOP_PERCENTAGE * 100).toFixed(0)}%)`,
        };
      }
    }
  }

  // 4. AI re-analysis (async) - only on adverse moves > 15%
  if (changeRatio <= TOKEN_ADVERSE_MOVE_THRESHOLD) {
    const analysis = await analyzeToken(
      position.tokenAddress,
      position.chain as SupportedChain,
      position.tokenSymbol,
    );

    if (!analysis) {
      // Hold on analysis failure
      console.warn(
        `[PositionManager] AI re-analysis failed for ${position.tokenAddress}, holding position`,
      );
      return { shouldExit: false, reason: "" };
    }

    // Conviction flip: probability below threshold
    if (analysis.successProbability < TOKEN_CONVICTION_FLIP_THRESHOLD) {
      return {
        shouldExit: true,
        reason: `Conviction flip: AI now ${(analysis.successProbability * 100).toFixed(1)}% (threshold ${(TOKEN_CONVICTION_FLIP_THRESHOLD * 100).toFixed(0)}%)`,
        newAnalysis: analysis,
      };
    }

    // Score drop: probability dropped by more than threshold
    const probabilityDrop = position.aiProbability - analysis.successProbability;
    if (probabilityDrop >= TOKEN_SCORE_DROP_THRESHOLD) {
      return {
        shouldExit: true,
        reason: `Score drop: ${(position.aiProbability * 100).toFixed(1)}% -> ${(analysis.successProbability * 100).toFixed(1)}% (${(probabilityDrop * 100).toFixed(1)}pp drop, threshold ${(TOKEN_SCORE_DROP_THRESHOLD * 100).toFixed(0)}pp)`,
        newAnalysis: analysis,
      };
    }

    // AI says hold
    return { shouldExit: false, reason: "", newAnalysis: analysis };
  }

  // 5. Default: hold
  return { shouldExit: false, reason: "" };
}

export function limitCorrelatedTokenBets(
  recommendations: TokenTradeRecommendation[],
  openPositions: TokenPosition[],
  maxExposureUsd: number,
  positionNarratives: Map<string, string[]>,
): TokenTradeRecommendation[] {
  const themeExposure = new Map<string, number>();
  const maxPerTheme = maxExposureUsd * MAX_THEME_EXPOSURE_RATIO;

  // Build current exposure per narrative theme from open positions
  for (const pos of openPositions) {
    const tags = positionNarratives.get(pos.tokenAddress);
    if (!tags || tags.length === 0) continue;
    for (const tag of tags) {
      const current = themeExposure.get(tag) || 0;
      themeExposure.set(tag, current + pos.sizeUsd);
    }
  }

  const filtered: TokenTradeRecommendation[] = [];

  for (const rec of recommendations) {
    const tags = positionNarratives.get(rec.tokenAddress);

    // No tags = uncorrelated, always allow
    if (!tags || tags.length === 0) {
      filtered.push(rec);
      continue;
    }

    let blocked = false;
    for (const tag of tags) {
      const current = themeExposure.get(tag) || 0;
      if (current + rec.sizeUsd > maxPerTheme) {
        console.log(
          `[PositionManager] Blocked ${rec.tokenAddress.slice(0, 8)} - "${tag}" exposure would be $${(current + rec.sizeUsd).toFixed(2)}/$${maxPerTheme.toFixed(2)}`,
        );
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      filtered.push(rec);
      // Update exposure for subsequent checks
      for (const tag of tags) {
        const current = themeExposure.get(tag) || 0;
        themeExposure.set(tag, current + rec.sizeUsd);
      }
    }
  }

  return filtered;
}
