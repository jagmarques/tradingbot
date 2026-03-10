import { EMA } from "technicalindicators";
import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import {
  MACD_DAILY_SMA_PERIOD,
  MACD_DAILY_ADX_MIN,
  MACD_FAST,
  MACD_SLOW,
  MACD_SIGNAL_PERIOD,
  MACD_STOP_ATR_MULT,
  MACD_REWARD_RISK,
  MACD_BASE_CONFIDENCE,
  MACD_DAILY_LOOKBACK_DAYS,
} from "../../config/constants.js";
import {
  fetchDailyCandles,
  computeDailySma,
  computeDailyAdx,
} from "./daily-indicators.js";

function computeMACD(closes: number[]): { histogram: number[] } | null {
  if (closes.length < MACD_SLOW + MACD_SIGNAL_PERIOD) return null;

  const fastEma = EMA.calculate({ values: closes, period: MACD_FAST });
  const slowEma = EMA.calculate({ values: closes, period: MACD_SLOW });

  // Align: fastEma starts at index (MACD_FAST-1), slowEma at (MACD_SLOW-1)
  const offset = fastEma.length - slowEma.length;
  const macdLine = slowEma.map((v, i) => fastEma[offset + i] - v);

  if (macdLine.length < MACD_SIGNAL_PERIOD) return null;

  const signalLine = EMA.calculate({ values: macdLine, period: MACD_SIGNAL_PERIOD });
  const sigOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((v, i) => macdLine[sigOffset + i] - v);

  return { histogram };
}

export async function evaluateMACDPair(analysis: PairAnalysis): Promise<QuantAIDecision | null> {
  const { pair, markPrice } = analysis;

  const candles4h = analysis.candles?.["4h"];
  if (!candles4h || candles4h.length < MACD_SLOW + MACD_SIGNAL_PERIOD + 5) return null;

  const closes4h = candles4h.map((c) => c.close);
  const result = computeMACD(closes4h);
  if (result === null || result.histogram.length < 2) return null;

  const currHist = result.histogram[result.histogram.length - 1];
  const prevHist = result.histogram[result.histogram.length - 2];

  const dailyCandles = await fetchDailyCandles(pair, MACD_DAILY_LOOKBACK_DAYS);
  if (dailyCandles.length < MACD_DAILY_SMA_PERIOD + 2) return null;

  const dLen = dailyCandles.length;
  const dailyCloses = dailyCandles.map((c) => c.close);
  const lastDailyIdx = dLen - 1;

  const dailySma = computeDailySma(dailyCloses, MACD_DAILY_SMA_PERIOD, lastDailyIdx);
  if (dailySma === null) return null;

  const dailyAdx = computeDailyAdx(dailyCandles, lastDailyIdx, 14);
  if (dailyAdx === null || dailyAdx < MACD_DAILY_ADX_MIN) return null;

  const dailyClose = dailyCandles[lastDailyIdx].close;
  const dailyUptrend = dailyClose > dailySma;
  const dailyDowntrend = dailyClose < dailySma;

  let direction: "long" | "short" | null = null;
  if (dailyUptrend && prevHist <= 0 && currHist > 0) direction = "long";
  if (dailyDowntrend && prevHist >= 0 && currHist < 0) direction = "short";

  if (direction === null) return null;

  const atr = analysis.indicators["4h"].atr ?? markPrice * 0.02;
  const stopDistance = atr * MACD_STOP_ATR_MULT;
  const tpDistance = stopDistance * MACD_REWARD_RISK;
  const stopLoss = direction === "long" ? markPrice - stopDistance : markPrice + stopDistance;
  const takeProfit = direction === "long" ? markPrice + tpDistance : markPrice - tpDistance;

  let confidence = MACD_BASE_CONFIDENCE;
  if (dailyAdx > 30) confidence += 10;
  else if (dailyAdx > 25) confidence += 5;
  confidence = Math.min(90, Math.max(0, confidence));

  const suggestedSizeUsd = calculateQuantPositionSize(confidence, markPrice, stopLoss, true, "macd-directional");
  if (suggestedSizeUsd <= 0) return null;

  const smaDev = ((dailyClose - dailySma) / dailySma * 100).toFixed(1);
  const crossDir = direction === "long" ? "histogram crosses positive" : "histogram crosses negative";
  const trend = direction === "long" ? "uptrend" : "downtrend";
  const reasoning = `MACD: ${crossDir} (${MACD_FAST}/${MACD_SLOW}/${MACD_SIGNAL_PERIOD}), daily ${trend} (${smaDev}% vs SMA${MACD_DAILY_SMA_PERIOD}, ADX ${dailyAdx.toFixed(0)})`;

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

export async function runMACDDecisionEngine(analyses: PairAnalysis[]): Promise<QuantAIDecision[]> {
  const decisions: QuantAIDecision[] = [];

  for (const analysis of analyses) {
    try {
      const decision = await evaluateMACDPair(analysis);
      if (decision) {
        console.log(
          `[MACDEngine] ${analysis.pair}: direction=${decision.direction} confidence=${decision.confidence}% entry=${decision.entryPrice.toFixed(2)} stop=${decision.stopLoss.toFixed(2)} | ${decision.reasoning}`,
        );
        decisions.push(decision);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MACDEngine] Failed to evaluate ${analysis.pair}: ${msg}`);
    }
  }

  console.log(`[MACDEngine] Engine complete: ${decisions.length} actionable decisions from ${analyses.length} pairs`);
  return decisions;
}
