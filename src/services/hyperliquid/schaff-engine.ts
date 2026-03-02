import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  SCHAFF_DAILY_SMA_PERIOD,
  SCHAFF_DAILY_ADX_MIN,
  SCHAFF_STC_FAST,
  SCHAFF_STC_SLOW,
  SCHAFF_STC_CYCLE,
  SCHAFF_STC_THRESHOLD,
  SCHAFF_STOP_ATR_MULT,
  SCHAFF_REWARD_RISK,
  SCHAFF_BASE_CONFIDENCE,
  SCHAFF_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

function computeEma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function computeStc(closes: number[], fast: number, slow: number, cycle: number): number[] {
  if (closes.length < slow + cycle * 2) return [];

  const fastEma = computeEma(closes, fast);
  const slowEma = computeEma(closes, slow);

  const offset = fastEma.length - slowEma.length;
  const macdLine = slowEma.map((v, i) => fastEma[offset + i] - v);

  if (macdLine.length < cycle) return [];

  const stoch1: number[] = [];
  for (let i = cycle - 1; i < macdLine.length; i++) {
    const window = macdLine.slice(i - cycle + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    const range = hi - lo;
    stoch1.push(range === 0 ? 50 : ((macdLine[i] - lo) / range) * 100);
  }

  if (stoch1.length === 0) return [];

  const smoothed1 = computeEma(stoch1, cycle);

  if (smoothed1.length < cycle) return [];

  const stoch2: number[] = [];
  for (let i = cycle - 1; i < smoothed1.length; i++) {
    const window = smoothed1.slice(i - cycle + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    const range = hi - lo;
    stoch2.push(range === 0 ? 50 : ((smoothed1[i] - lo) / range) * 100);
  }

  if (stoch2.length === 0) return [];

  const stcRaw = computeEma(stoch2, cycle);
  return stcRaw.map((v) => Math.min(100, Math.max(0, v)));
}

export async function evaluateSchaffPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < SCHAFF_STC_SLOW + SCHAFF_STC_CYCLE * 4 + 5) return null;

  const closes4h = candles4h.map((c) => c.close);

  const stcValues = computeStc(closes4h, SCHAFF_STC_FAST, SCHAFF_STC_SLOW, SCHAFF_STC_CYCLE);
  if (stcValues.length < 2) return null;

  const currSTC = stcValues[stcValues.length - 1];
  const prevSTC = stcValues[stcValues.length - 2];

  const dailyCandles = await fetchDailyCandles(pair, SCHAFF_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < SCHAFF_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, SCHAFF_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < SCHAFF_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevSTC <= SCHAFF_STC_THRESHOLD && currSTC > SCHAFF_STC_THRESHOLD) direction = "long";
  if (dailyDowntrend && prevSTC >= (100 - SCHAFF_STC_THRESHOLD) && currSTC < (100 - SCHAFF_STC_THRESHOLD)) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * SCHAFF_STOP_ATR_MULT;
  const tpDistance = stopDistance * SCHAFF_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = SCHAFF_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "schaff-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? `STC crossed above ${SCHAFF_STC_THRESHOLD}` : `STC crossed below ${100 - SCHAFF_STC_THRESHOLD}`;
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Schaff: ${crossDir} (STC ${currSTC.toFixed(1)}), daily ${trend} (${smaDev}% vs SMA${SCHAFF_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runSchaffDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateSchaffPair(analysis);
      if (decision) {
        console.log(
          `[SchaffEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SchaffEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[SchaffEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
