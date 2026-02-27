import { BollingerBands } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  BB_SQUEEZE_DAILY_SMA_PERIOD,
  BB_SQUEEZE_DAILY_ADX_MIN,
  BB_SQUEEZE_BB_PERIOD,
  BB_SQUEEZE_BB_STDDEV,
  BB_SQUEEZE_WINDOW,
  BB_SQUEEZE_THRESH,
  BB_SQUEEZE_STOP_ATR_MULT,
  BB_SQUEEZE_REWARD_RISK,
  BB_SQUEEZE_BASE_CONFIDENCE,
  BB_SQUEEZE_DAILY_LOOKBACK_DAYS,
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
  const startTime = endTime - BB_SQUEEZE_DAILY_LOOKBACK_DAYS * 86400_000;
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
    console.error(`[BbSqueezeEngine] Failed to fetch daily candles for ${pair}: ${msg}`);
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

export async function evaluateBbSqueezePair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < BB_SQUEEZE_BB_PERIOD + BB_SQUEEZE_WINDOW + 5) return null;

  const closes4h = candles4h.map((c) => c.close);

  const bbResults = BollingerBands.calculate({ values: closes4h, period: BB_SQUEEZE_BB_PERIOD, stdDev: BB_SQUEEZE_BB_STDDEV });
  if (bbResults.length < BB_SQUEEZE_WINDOW + 2) return null;

  const recentBbs = bbResults.slice(-(BB_SQUEEZE_WINDOW + 1));
  const widths = recentBbs.map((b) => (b.middle > 0 ? (b.upper - b.lower) / b.middle : 0));

  const prevWidth = widths[widths.length - 2];
  const currBb = recentBbs[recentBbs.length - 1];

  // Percentile squeeze threshold from last WINDOW bars (excluding current)
  const histWidths = [...widths.slice(0, -1)].sort((a, b) => a - b);
  const threshIdx = Math.floor(histWidths.length * BB_SQUEEZE_THRESH);
  const squeezeThreshold = histWidths[threshIdx] ?? 0;

  if (prevWidth > squeezeThreshold) return null;

  const currClose = candles4h[candles4h.length - 1].close;
  let direction: "long" | "short" | null = null;
  const dailyCandles = await fetchDailyCandles(pair);
  if (dailyCandles.length < BB_SQUEEZE_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, BB_SQUEEZE_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < BB_SQUEEZE_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  if (dailyUptrend && currClose > currBb.upper) direction = "long";
  if (dailyDowntrend && currClose < currBb.lower) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * BB_SQUEEZE_STOP_ATR_MULT;
  const tpDistance = stopDistance * BB_SQUEEZE_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = BB_SQUEEZE_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true);
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const squeezeWidthPct = (prevWidth * 100).toFixed(2);
  const reasoning = `BBSqueeze: volatility squeeze (width ${squeezeWidthPct}% < ${(squeezeThreshold * 100).toFixed(2)}%), price breaks ${direction === "long" ? "above" : "below"} band, daily ${direction === "long" ? "uptrend" : "downtrend"} (${smaDev}% vs SMA${BB_SQUEEZE_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runBbSqueezeDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateBbSqueezePair(analysis);
      if (decision) {
        console.log(
          `[BbSqueezeEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BbSqueezeEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[BbSqueezeEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
