import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  TRIX_PERIOD,
  TRIX_SIGNAL,
  TRIX_DAILY_SMA_PERIOD,
  TRIX_DAILY_ADX_MIN,
  TRIX_STOP_ATR_MULT,
  TRIX_REWARD_RISK,
  TRIX_BASE_CONFIDENCE,
  TRIX_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

// TRIX: ROC% of triple-smoothed EMA, mapped back to original index space
function computeTRIX(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1 = EMA.calculate({ values: closes, period });
  const ema2 = EMA.calculate({ values: ema1, period });
  const ema3 = EMA.calculate({ values: ema2, period });

  // ema3 starts at index (period-1)*3 in original closes space
  const ema3StartIdx = (period - 1) * 3;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < ema3.length; i++) {
    const origIdx = ema3StartIdx + i;
    if (origIdx < n && ema3[i - 1] !== 0) {
      result[origIdx] = ((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 100;
    }
  }
  return result;
}

// Simple SMA of non-null TRIX values over a sliding window
function computeTRIXSignal(trixValues: (number | null)[], signalPeriod: number): (number | null)[] {
  const n = trixValues.length;
  const result: (number | null)[] = new Array(n).fill(null);
  for (let i = signalPeriod - 1; i < n; i++) {
    const slice = trixValues.slice(i - signalPeriod + 1, i + 1);
    const valid = slice.filter((v): v is number => v !== null);
    if (valid.length === signalPeriod) {
      result[i] = valid.reduce((s, v) => s + v, 0) / signalPeriod;
    }
  }
  return result;
}

export async function evaluateTrixPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < TRIX_PERIOD * 3 + TRIX_SIGNAL + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;
  const trixArr = computeTRIX(closes4h, TRIX_PERIOD);
  const signalArr = computeTRIXSignal(trixArr, TRIX_SIGNAL);

  const currTrix = trixArr[n - 1], prevTrix = trixArr[n - 2];
  const currSig = signalArr[n - 1], prevSig = signalArr[n - 2];
  if (currTrix === null || prevTrix === null || currSig === null || prevSig === null) return null;

  const dailyCandles = await fetchDailyCandles(pair, TRIX_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < TRIX_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, TRIX_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < TRIX_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevTrix <= prevSig && currTrix > currSig) direction = "long";
  if (dailyDowntrend && prevTrix >= prevSig && currTrix < currSig) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * TRIX_STOP_ATR_MULT;
  const tpDistance = stopDistance * TRIX_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = TRIX_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "trix-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "above" : "below";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Trix: TRIX(${TRIX_PERIOD}) crossed ${crossDir} signal(${TRIX_SIGNAL}), daily ${trend} (${smaDev}% vs SMA${TRIX_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runTrixDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateTrixPair(analysis);
      if (decision) {
        console.log(
          `[TrixEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TrixEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[TrixEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
