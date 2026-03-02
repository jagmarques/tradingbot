import { PSAR } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  PSAR_DAILY_SMA_PERIOD,
  PSAR_DAILY_ADX_MIN,
  PSAR_STEP,
  PSAR_MAX,
  PSAR_STOP_ATR_MULT,
  PSAR_REWARD_RISK,
  PSAR_BASE_CONFIDENCE,
  PSAR_DAILY_LOOKBACK_DAYS,
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
  const startTime = endTime - PSAR_DAILY_LOOKBACK_DAYS * 86400_000;
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
    console.error(`[PsarEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
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

export async function evaluatePsarPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < 30) return null;

  const highs4h = candles4h.map((c) => c.high);
  const lows4h = candles4h.map((c) => c.low);
  const closes4h = candles4h.map((c) => c.close);
  const n = closes4h.length;

  const psarValues = PSAR.calculate({ high: highs4h, low: lows4h, step: PSAR_STEP, max: PSAR_MAX });
  const psarStartIdx = n - psarValues.length;

  const currIdx = n - 1;
  const prevIdx = n - 2;
  if (currIdx - psarStartIdx < 1 || prevIdx - psarStartIdx < 0) return null;

  const currSar = psarValues[currIdx - psarStartIdx];
  const prevSar = psarValues[prevIdx - psarStartIdx];
  const currClose = closes4h[currIdx];
  const prevClose = closes4h[prevIdx];

  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < PSAR_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, PSAR_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < PSAR_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  // SAR flip: prev bar SAR above prev close AND curr bar SAR below curr close -> long
  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevSar > prevClose && currSar < currClose) direction = "long";
  if (dailyDowntrend && prevSar < prevClose && currSar > currClose) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * PSAR_STOP_ATR_MULT;
  const tpDistance = stopDistance * PSAR_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = PSAR_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "psar-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const sarPos = direction === "long" ? "below" : "above";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `Psar: SAR flipped ${sarPos} close, daily ${trend} (${smaDev}% vs SMA${PSAR_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runPsarDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluatePsarPair(analysis);
      if (decision) {
        console.log(
          `[PsarEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PsarEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[PsarEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
