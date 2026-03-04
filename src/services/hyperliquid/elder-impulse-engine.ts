import { EMA, MACD } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  ELDER_EMA_PERIOD,
  ELDER_MACD_FAST,
  ELDER_MACD_SLOW,
  ELDER_MACD_SIGNAL,
  ELDER_DAILY_SMA_PERIOD,
  ELDER_DAILY_ADX_MIN,
  ELDER_STOP_ATR_MULT,
  ELDER_REWARD_RISK,
  ELDER_BASE_CONFIDENCE,
  ELDER_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

export async function evaluateElderImpulsePair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < ELDER_MACD_SLOW + ELDER_MACD_SIGNAL + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  // EMA(21) mapped to original index space
  const emaRaw = EMA.calculate({ values: closes4h, period: ELDER_EMA_PERIOD });
  const emaStartIdx = n - emaRaw.length;
  const ema: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < emaRaw.length; i++) ema[emaStartIdx + i] = emaRaw[i];

  // MACD(12,26,9) mapped to original index space
  const macdRaw = MACD.calculate({
    values: closes4h,
    fastPeriod: ELDER_MACD_FAST,
    slowPeriod: ELDER_MACD_SLOW,
    signalPeriod: ELDER_MACD_SIGNAL,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdStartIdx = n - macdRaw.length;
  const histogram: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < macdRaw.length; i++) {
    const h = macdRaw[i].histogram;
    histogram[macdStartIdx + i] = h ?? null;
  }

  const cI = n - 1, pI = n - 2;
  const currEma = ema[cI], prevEma = ema[pI];
  const currHist = histogram[cI], prevHist = histogram[pI];
  if (currEma == null || prevEma == null) return null;
  if (currHist == null || prevHist == null) return null;

  // Green bar: EMA rising AND histogram rising
  const isGreen = (eNow: number, ePrev: number, hNow: number, hPrev: number): boolean =>
    eNow > ePrev && hNow > hPrev;
  // Red bar: EMA falling AND histogram falling
  const isRed = (eNow: number, ePrev: number, hNow: number, hPrev: number): boolean =>
    eNow < ePrev && hNow < hPrev;

  const currBarGreen = isGreen(currEma, prevEma, currHist, prevHist);
  const currBarRed = isRed(currEma, prevEma, currHist, prevHist);

  const dailyCandles = await fetchDailyCandles(pair, ELDER_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < ELDER_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, ELDER_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < ELDER_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  // Signal: green bar with uptrend, or red bar with downtrend
  let direction: "long" | "short" | null = null;
  if (dailyUptrend && currBarGreen) direction = "long";
  if (dailyDowntrend && currBarRed) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * ELDER_STOP_ATR_MULT;
  const tpDistance = stopDistance * ELDER_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = ELDER_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "elder-impulse-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const barColor = direction === "long" ? "green" : "red";
  const emaDir = direction === "long" ? "rising" : "falling";
  const histDir = direction === "long" ? "rising" : "falling";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `ElderImpulse: ${barColor} bar (EMA ${emaDir} + histogram ${histDir}), daily ${trend} (${smaDev}% vs SMA${ELDER_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runElderImpulseDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateElderImpulsePair(analysis);
      if (decision) {
        console.log(
          `[ElderImpulseEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ElderImpulseEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[ElderImpulseEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
