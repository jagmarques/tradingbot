import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  TEMA_CROSS_DAILY_SMA_PERIOD,
  TEMA_CROSS_DAILY_ADX_MIN,
  TEMA_CROSS_FAST,
  TEMA_CROSS_SLOW,
  TEMA_CROSS_STOP_ATR_MULT,
  TEMA_CROSS_REWARD_RISK,
  TEMA_CROSS_BASE_CONFIDENCE,
  TEMA_CROSS_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";

interface DailyCandle {
  timestamp: number;
  close: number;
  high: number;
  low: number;
}

interface DailyCache {
  candles: DailyCandle[];
  fetchedAtHour: number;
}

const dailyCandleCache = new Map<string, DailyCache>();

async function fetchDailyCandles(pair: string): Promise<DailyCandle[]> {
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const cached = dailyCandleCache.get(pair);
  if (cached && cached.fetchedAtHour === nowHour) return cached.candles;

  const endTime = Date.now();
  const startTime = endTime - TEMA_CROSS_DAILY_LOOKBACK_DAYS * 86400_000;
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: pair, interval: "1d", startTime, endTime } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Array<{ t: number; c: string; h: string; l: string }>;
    const candles = raw
      .map((c) => ({ timestamp: c.t, close: parseFloat(c.c), high: parseFloat(c.h), low: parseFloat(c.l) }))
      .sort((a, b) => a.timestamp - b.timestamp);
    dailyCandleCache.set(pair, { candles, fetchedAtHour: nowHour });
    return candles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TemaEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
    return cached?.candles ?? [];
  }
}

function computeDailySma(closes: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  const slice = closes.slice(idx - period + 1, idx + 1);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function computeDailyAdx(candles: DailyCandle[], idx: number, period: number): number | null {
  if (idx < period * 2) return null;
  let trSum = 0, plusDmSum = 0, minusDmSum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i <= 0) return null;
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    trSum += tr;
    plusDmSum += highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    minusDmSum += lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
  }
  if (trSum === 0) return null;
  const plusDi = (plusDmSum / trSum) * 100;
  const minusDi = (minusDmSum / trSum) * 100;
  const diSum = plusDi + minusDi;
  if (diSum === 0) return null;
  return (Math.abs(plusDi - minusDi) / diSum) * 100;
}

// TEMA = 3*EMA1 - 3*EMA2 + EMA3 (triple EMA, less lag than DEMA)
function computeTEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const ema1Raw = EMA.calculate({ values: closes, period });
  const ema2Raw = EMA.calculate({ values: ema1Raw, period });
  const ema3Raw = EMA.calculate({ values: ema2Raw, period });
  const result: (number | null)[] = new Array(n).fill(null);
  ema3Raw.forEach((e3, i) => {
    const e2Idx = i + (period - 1);
    const e1Idx = e2Idx + (period - 1);
    const closesIdx = e1Idx + (period - 1);
    if (closesIdx < n) result[closesIdx] = 3 * ema1Raw[e1Idx] - 3 * ema2Raw[e2Idx] + e3;
  });
  return result;
}

export async function evaluateTemaCrossPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < TEMA_CROSS_SLOW * 3 + 2) return null;

  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;
  const fastArr = computeTEMA(closes4h, TEMA_CROSS_FAST);
  const slowArr = computeTEMA(closes4h, TEMA_CROSS_SLOW);

  const currFast = fastArr[n - 1], prevFast = fastArr[n - 2];
  const currSlow = slowArr[n - 1], prevSlow = slowArr[n - 2];
  if (currFast === null || prevFast === null || currSlow === null || prevSlow === null) return null;

  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < TEMA_CROSS_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, TEMA_CROSS_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < TEMA_CROSS_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevFast <= prevSlow && currFast > currSlow) direction = "long";
  if (dailyDowntrend && prevFast >= prevSlow && currFast < currSlow) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * TEMA_CROSS_STOP_ATR_MULT;
  const tpDistance = stopDistance * TEMA_CROSS_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = TEMA_CROSS_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const reasoning = `TemaCross: TEMA(${TEMA_CROSS_FAST}) crossed ${direction === "long" ? "above" : "below"} TEMA(${TEMA_CROSS_SLOW}), daily ${direction === "long" ? "uptrend" : "downtrend"} (${smaDev}% vs SMA${TEMA_CROSS_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runTemaDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateTemaCrossPair(analysis);
      if (decision) {
        console.log(
          `[TemaEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TemaEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[TemaEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
