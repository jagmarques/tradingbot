import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  CCI_DAILY_SMA_PERIOD,
  CCI_DAILY_ADX_MIN,
  CCI_PERIOD,
  CCI_THRESHOLD,
  CCI_STOP_ATR_MULT,
  CCI_REWARD_RISK,
  CCI_BASE_CONFIDENCE,
  CCI_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

interface Candle4h {
  high: number;
  low: number;
  close: number;
}

// CCI = (TP - SMA(TP)) / (0.015 * MeanDev(TP))
function computeCCI(candles: Candle4h[], period: number, endIdx: number): number | null {
  if (endIdx < period - 1) return null;
  const slice = candles.slice(endIdx - period + 1, endIdx + 1);
  const tps = slice.map((c) => (c.high + c.low + c.close) / 3);
  const smaTp = tps.reduce((s, v) => s + v, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - smaTp), 0) / period;
  return meanDev === 0 ? 0 : (tps[tps.length - 1] - smaTp) / (0.015 * meanDev);
}

export async function evaluateCCIPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < CCI_PERIOD + 5) return null;

  const n = candles4h.length;
  const prevCCI = computeCCI(candles4h, CCI_PERIOD, n - 2);
  const currCCI = computeCCI(candles4h, CCI_PERIOD, n - 1);
  if (prevCCI === null || currCCI === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, CCI_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < CCI_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, CCI_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < CCI_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevCCI <= CCI_THRESHOLD && currCCI > CCI_THRESHOLD) direction = "long";
  if (dailyDowntrend && prevCCI >= -CCI_THRESHOLD && currCCI < -CCI_THRESHOLD) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * CCI_STOP_ATR_MULT;
  const tpDistance = stopDistance * CCI_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = CCI_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "cci-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? `above +${CCI_THRESHOLD}` : `below -${CCI_THRESHOLD}`;
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `CCI: CCI(${CCI_PERIOD}) ${crossDir}, daily ${trend} (${smaDev}% vs SMA${CCI_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runCCIDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateCCIPair(analysis);
      if (decision) {
        console.log(
          `[CCIEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CCIEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[CCIEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
