import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  SUPERTREND_DAILY_SMA_PERIOD,
  SUPERTREND_DAILY_ADX_MIN,
  SUPERTREND_PERIOD,
  SUPERTREND_MULT,
  SUPERTREND_STOP_ATR_MULT,
  SUPERTREND_REWARD_RISK,
  SUPERTREND_BASE_CONFIDENCE,
  SUPERTREND_DAILY_LOOKBACK_DAYS,
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
  const startTime = endTime - SUPERTREND_DAILY_LOOKBACK_DAYS * 86400_000;
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
    console.error(`[SupertrendEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
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

interface SupertrendResult {
  directions: boolean[]; // true = bullish
}

function computeSupertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
  multiplier: number,
): SupertrendResult | null {
  const n = closes.length;
  if (n < period + 1) return null;

  // Compute ATR using simple rolling average of true range
  const trueRanges: number[] = [0];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trueRanges.push(tr);
  }

  const atr: number[] = new Array(n).fill(0);
  // Initial ATR as simple average for first period
  let sumTr = 0;
  for (let i = 1; i <= period; i++) sumTr += trueRanges[i];
  atr[period] = sumTr / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trueRanges[i]) / period;
  }

  const directions: boolean[] = new Array(n).fill(true);
  let finalUpperBand = 0;
  let finalLowerBand = 0;

  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    if (i === period) {
      finalUpperBand = basicUpper;
      finalLowerBand = basicLower;
      directions[i] = closes[i] >= finalLowerBand;
      continue;
    }

    const prevClose = closes[i - 1];
    const prevFinalUpper = finalUpperBand;
    const prevFinalLower = finalLowerBand;

    finalUpperBand = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
    finalLowerBand = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;

    // Direction: bullish if price above lower band, bearish if price below upper band
    if (directions[i - 1]) {
      // Was bullish: stays bullish unless price falls below lower band
      directions[i] = closes[i] >= finalLowerBand;
    } else {
      // Was bearish: turns bullish only if price rises above upper band
      directions[i] = closes[i] > finalUpperBand;
    }
  }

  return { directions };
}

export async function evaluateSupertrendPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < SUPERTREND_PERIOD + 5) return null;

  const highs4h = candles4h.map((c) => c.high);
  const lows4h = candles4h.map((c) => c.low);
  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const result = computeSupertrend(highs4h, lows4h, closes4h, SUPERTREND_PERIOD, SUPERTREND_MULT);
  if (!result) return null;

  const currIdx = n - 1;
  const prevIdx = n - 2;

  if (currIdx < SUPERTREND_PERIOD || prevIdx < SUPERTREND_PERIOD) return null;

  const currBullish = result.directions[currIdx];
  const prevBullish = result.directions[prevIdx];

  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < SUPERTREND_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, SUPERTREND_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < SUPERTREND_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  // Flip up: prev bearish AND curr bullish, with daily uptrend
  // Flip down: prev bullish AND curr bearish, with daily downtrend
  let direction: "long" | "short" | null = null;
  if (dailyUptrend && !prevBullish && currBullish) direction = "long";
  if (dailyDowntrend && prevBullish && !currBullish) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * SUPERTREND_STOP_ATR_MULT;
  const tpDistance = stopDistance * SUPERTREND_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = SUPERTREND_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const flipDir = direction === "long" ? "bearish->bullish flip" : "bullish->bearish flip";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Supertrend: ${flipDir}, daily ${trend} (${smaDev}% vs SMA${SUPERTREND_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runSupertrendDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateSupertrendPair(analysis);
      if (decision) {
        console.log(
          `[SupertrendEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SupertrendEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[SupertrendEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
