import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  MTF_DAILY_SMA_PERIOD,
  MTF_DAILY_ADX_MIN,
  MTF_RSI_PULLBACK_LOW,
  MTF_RSI_PULLBACK_HIGH,
  MTF_STOP_ATR_MULT,
  MTF_REWARD_RISK_RATIO,
  MTF_BASE_CONFIDENCE,
  MTF_DAILY_LOOKBACK_DAYS,
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

// Cache daily candles per pair, refreshed once per hour (daily bars don't change frequently)
const dailyCandleCache = new Map<string, DailyCache>();

async function fetchDailyCandles(pair: string): Promise<DailyCandle[]> {
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const cached = dailyCandleCache.get(pair);
  if (cached && cached.fetchedAtHour === nowHour) return cached.candles;

  const endTime = Date.now();
  const startTime = endTime - MTF_DAILY_LOOKBACK_DAYS * 86400_000;
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
    console.error(`[MtfEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
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
  // Simple Wilder ADX approximation
  let trSum = 0;
  let plusDmSum = 0;
  let minusDmSum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    if (i <= 0) return null;
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
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

export async function evaluateMtfPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < 20) return null;

  const ind4h = analysis.indicators["4h"];
  const rsi4h = ind4h.rsi;
  const n4h = candles4h.length;

  if (rsi4h === null || n4h < 2) return null;

  // Get previous RSI (from second-to-last 4h bar)
  // We approximate it using the 4h candles' RSI directly - pipeline only gives current RSI
  // We use the trend of RSI via the current bar vs the ATR-based estimate
  // For a simpler approach: we compare current RSI to a slightly lower value using the last candle
  // This is a limitation - we only have current RSI, not previous. Skip rsiTurnDelta filter here
  // and rely on the RSI being in the zone (pullback confirmed) as the entry signal.
  // The direction of the move is confirmed by the daily trend filter.

  // Daily candle fetch
  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < MTF_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);

  // Last completed daily bar
  const lastDailyIdx = dLen - 1;
  const dailySma = computeDailySma(dailyCloses, MTF_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < MTF_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;

  // Long: daily uptrend + 4h RSI in pullback zone [rsiPullbackLow, rsiPullbackHigh]
  if (dailyUptrend && rsi4h >= MTF_RSI_PULLBACK_LOW && rsi4h <= MTF_RSI_PULLBACK_HIGH) {
    direction = "long";
  }

  // Short: daily downtrend + 4h RSI in corresponding zone [100-rsiPullbackHigh, 100-rsiPullbackLow]
  const shortLow = 100 - MTF_RSI_PULLBACK_HIGH;
  const shortHigh = 100 - MTF_RSI_PULLBACK_LOW;
  if (dailyDowntrend && rsi4h >= shortLow && rsi4h <= shortHigh) {
    direction = "short";
  }

  if (direction === null) return null;

  const atr = ind4h.atr ?? markPrice * 0.02;
  const stopDistance = atr * MTF_STOP_ATR_MULT;
  const tpDistance = stopDistance * MTF_REWARD_RISK_RATIO;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = MTF_BASE_CONFIDENCE;
  // Strong daily trend booster
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  // RSI deeply in pullback zone = cleaner entry
  const midPullback = (MTF_RSI_PULLBACK_LOW + MTF_RSI_PULLBACK_HIGH) / 2;
  if (direction === "long" && rsi4h < midPullback) confidence += 5;
  if (direction === "short" && rsi4h > 100 - midPullback) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const reasoning = `MTF: daily ${direction === "long" ? "uptrend" : "downtrend"} (close ${smaDev}% vs SMA${MTF_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)}), 4h RSI ${rsi4h.toFixed(0)} in pullback zone`;

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

export async function runMtfDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateMtfPair(analysis);
      if (decision) {
        console.log(
          `[MtfEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MtfEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[MtfEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
