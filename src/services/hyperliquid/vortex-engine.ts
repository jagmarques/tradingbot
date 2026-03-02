import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  VORTEX_DAILY_SMA_PERIOD,
  VORTEX_DAILY_ADX_MIN,
  VORTEX_VORTEX_PERIOD,
  VORTEX_STOP_ATR_MULT,
  VORTEX_REWARD_RISK,
  VORTEX_BASE_CONFIDENCE,
  VORTEX_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

interface VortexValues {
  vPlus: number;
  vMinus: number;
}

function computeVortex(
  highs: number[],
  lows: number[],
  closes: number[],
  endIdx: number,
  period: number,
): VortexValues | null {
  if (endIdx < period) return null;

  let vmPlus = 0;
  let vmMinus = 0;
  let trSum = 0;

  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (i <= 0) return null;
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];
    vmPlus += Math.abs(highs[i] - prevLow);
    vmMinus += Math.abs(lows[i] - prevHigh);
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose));
    trSum += tr;
  }

  if (trSum === 0) return null;
  return { vPlus: vmPlus / trSum, vMinus: vmMinus / trSum };
}

export async function evaluateVortexPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < VORTEX_VORTEX_PERIOD + 5) return null;

  const highs4h = candles4h.map((c) => c.high);
  const lows4h = candles4h.map((c) => c.low);
  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const currIdx = n - 1;
  const prevIdx = n - 2;

  const currVortex = computeVortex(highs4h, lows4h, closes4h, currIdx, VORTEX_VORTEX_PERIOD);
  const prevVortex = computeVortex(highs4h, lows4h, closes4h, prevIdx, VORTEX_VORTEX_PERIOD);

  if (!currVortex || !prevVortex) return null;

  const dailyCandles = await fetchDailyCandles(pair, VORTEX_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < VORTEX_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, VORTEX_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < VORTEX_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevVortex.vPlus <= prevVortex.vMinus && currVortex.vPlus > currVortex.vMinus) direction = "long";
  if (dailyDowntrend && prevVortex.vMinus <= prevVortex.vPlus && currVortex.vMinus > currVortex.vPlus) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * VORTEX_STOP_ATR_MULT;
  const tpDistance = stopDistance * VORTEX_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = VORTEX_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "vortex-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "V+ crossed above V-" : "V- crossed above V+";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Vortex: ${crossDir}, daily ${trend} (${smaDev}% vs SMA${VORTEX_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

  return {
    pair,
    direction,
    entryPrice: markPrice,
    stopLoss,
    takeProfit,
    confidence,
    reasoning,
    regime: analysis.regime,
    suggestedSizeUsd,
    analyzedAt: new Date().toISOString(),
  };
}

export async function runVortexDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateVortexPair(analysis);
      if (decision) {
        console.log(
          `[VortexEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VortexEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[VortexEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
