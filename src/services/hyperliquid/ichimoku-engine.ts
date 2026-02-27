import { calculateQuantPositionSize } from "./kelly.js";
import type { OhlcvCandle, PairAnalysis, QuantAIDecision } from "./types.js";
import {
  ICHIMOKU_DAILY_SMA_PERIOD,
  ICHIMOKU_DAILY_ADX_MIN,
  ICHIMOKU_TENKAN_PERIOD,
  ICHIMOKU_KIJUN_PERIOD,
  ICHIMOKU_STOP_ATR_MULT,
  ICHIMOKU_REWARD_RISK,
  ICHIMOKU_BASE_CONFIDENCE,
  ICHIMOKU_DAILY_LOOKBACK_DAYS,
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
  const startTime = endTime - ICHIMOKU_DAILY_LOOKBACK_DAYS * 86400_000;
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
    console.error(`[IchimokuEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
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

// Tenkan-sen / Kijun-sen: (highest high + lowest low) / 2 over N periods
function hlMid(candles: OhlcvCandle[], endIdx: number, period: number): number | null {
  if (endIdx < period - 1) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  return (hi + lo) / 2;
}

export async function evaluateIchimokuPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < ICHIMOKU_KIJUN_PERIOD + 2) return null;

  const n = candles4h.length;

  const currTenkan = hlMid(candles4h, n - 1, ICHIMOKU_TENKAN_PERIOD);
  const prevTenkan = hlMid(candles4h, n - 2, ICHIMOKU_TENKAN_PERIOD);
  const currKijun = hlMid(candles4h, n - 1, ICHIMOKU_KIJUN_PERIOD);
  const prevKijun = hlMid(candles4h, n - 2, ICHIMOKU_KIJUN_PERIOD);

  if (currTenkan === null || prevTenkan === null || currKijun === null || prevKijun === null) return null;

  let direction: "long" | "short" | null = null;
  const tkBullCross = prevTenkan < prevKijun && currTenkan >= currKijun;
  const tkBearCross = prevTenkan > prevKijun && currTenkan <= currKijun;

  if (!tkBullCross && !tkBearCross) return null;

  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < ICHIMOKU_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, ICHIMOKU_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < ICHIMOKU_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  if (tkBullCross && dailyUptrend) direction = "long";
  if (tkBearCross && dailyDowntrend) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * ICHIMOKU_STOP_ATR_MULT;
  const tpDistance = stopDistance * ICHIMOKU_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = ICHIMOKU_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  const tkSpread = Math.abs(currTenkan - currKijun) / currKijun * 100;
  if (tkSpread > 0.5) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const reasoning = `Ichimoku: TK ${direction === "long" ? "bullish" : "bearish"} cross (T=${currTenkan.toFixed(2)} vs K=${currKijun.toFixed(2)}), daily ${direction === "long" ? "uptrend" : "downtrend"} (${smaDev}% vs SMA${ICHIMOKU_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runIchimokuDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateIchimokuPair(analysis);
      if (decision) {
        console.log(
          `[IchimokuEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IchimokuEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[IchimokuEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
