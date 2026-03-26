import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT } from "../../config/constants.js";
import { calcAtrStopLoss, capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "supertrend-4h" as const;
const ST_PERIOD = 14;
const ST_MULTIPLIER = 1.75;
const ATR_SL_MULTIPLIER = 3;
const BTC_EMA_FAST = 20;
const BTC_EMA_SLOW = 50;
const BAR_MS = 4 * 60 * 60 * 1000;
const ST_POSITION_SIZE_USD = 3; // Reduced from $5 - high frequency engine, smaller per-trade

let lastProcessedBarOpen = 0;

interface SupertrendResult {
  trend: "bull" | "bear";
  upperBand: number;
  lowerBand: number;
  atr: number;
}

function ema(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period) return NaN;
  const mult = 2 / (period + 1);
  // Seed with SMA of first `period` candles (proper initialization)
  let val = 0;
  for (let i = 0; i < period; i++) val += candles[i].close;
  val /= period;
  for (let i = period; i < candles.length; i++) {
    val = candles[i].close * mult + val * (1 - mult);
  }
  return val;
}

function atrValue(candles: OhlcvCandle[], endIdx: number, period: number): number {
  if (endIdx < period) return 0;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sum / period;
}

function computeSupertrend(
  candles: OhlcvCandle[],
  period: number,
  multiplier: number,
): { current: SupertrendResult; prev: SupertrendResult } | null {
  if (candles.length < period + 2) return null;

  let prevTrend: "bull" | "bear" = "bull";
  let prevFinalUpper = Infinity;
  let prevFinalLower = -Infinity;

  // Track last two bars for flip detection
  let prevResult: SupertrendResult | null = null;
  let currentResult: SupertrendResult | null = null;

  for (let i = period; i < candles.length; i++) {
    const atv = atrValue(candles, i, period);
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * atv;
    const basicLower = hl2 - multiplier * atv;

    const prevClose = candles[i - 1].close;
    const finalUpper = (basicUpper < prevFinalUpper || prevClose > prevFinalUpper) ? basicUpper : prevFinalUpper;
    const finalLower = (basicLower > prevFinalLower || prevClose < prevFinalLower) ? basicLower : prevFinalLower;

    let trend: "bull" | "bear";
    const close = candles[i].close;
    if (prevTrend === "bull" && close < finalLower) {
      trend = "bear";
    } else if (prevTrend === "bear" && close > finalUpper) {
      trend = "bull";
    } else {
      trend = prevTrend;
    }

    prevResult = currentResult;
    currentResult = { trend, upperBand: finalUpper, lowerBand: finalLower, atr: atv };

    prevTrend = trend;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
  }

  if (!prevResult || !currentResult) return null;
  return { current: currentResult, prev: prevResult };
}

function isBtcBullish(btcCandles: OhlcvCandle[]): boolean {
  const emaFast = ema(btcCandles, BTC_EMA_FAST);
  const emaSlow = ema(btcCandles, BTC_EMA_SLOW);
  if (isNaN(emaFast) || isNaN(emaSlow)) return false;
  return emaFast > emaSlow;
}

export async function runSupertrend4hCycle(): Promise<void> {
  const now = Date.now();
  // Align to 4h bar boundaries to prevent drift
  const currentBarOpen = Math.floor(now / BAR_MS) * BAR_MS;
  if (currentBarOpen <= lastProcessedBarOpen) return;

  const btcCandles = await fetchCandles("BTC", "1d", 200);
  if (btcCandles.length < BTC_EMA_SLOW + 1) {
    console.log("[Supertrend4h] Insufficient BTC candles, skipping cycle");
    return;
  }

  // Set timer AFTER successful BTC fetch
  lastProcessedBarOpen = currentBarOpen;

  // Exclude incomplete current bar for BTC filter
  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted);

  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  // EXIT LOGIC
  for (const pos of myPositions) {
    try {
      const pairCandles = await fetchCandles(pos.pair, "4h", 60);
      if (pairCandles.length < ST_PERIOD + 3) continue;

      // Use completed bars only (exclude last incomplete bar)
      const completed = pairCandles.slice(0, -1);
      const st = computeSupertrend(completed, ST_PERIOD, ST_MULTIPLIER);
      if (!st) continue;

      const shouldExit =
        (pos.direction === "long" && st.current.trend === "bear") ||
        (pos.direction === "short" && st.current.trend === "bull");

      if (shouldExit) {
        console.log(`[Supertrend4h] ${pos.pair} ${pos.direction} supertrend-flip -> exit (trend=${st.current.trend})`);
        await closePosition(pos.id, "supertrend-flip");
      }
    } catch (err) {
      console.error(`[Supertrend4h] Exit check failed for ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Refresh positions after exits
  const openPairs = new Set(
    getOpenQuantPositions()
      .filter(p => p.tradeType === TRADE_TYPE)
      .map(p => p.pair),
  );
  let currentEnsembleCount = getOpenQuantPositions().filter(
    p => p.tradeType === "donchian-trend" || p.tradeType === "supertrend-4h" || p.tradeType === "garch-v2",
  ).length;

  // ENTRY LOGIC
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (currentEnsembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      const pairCandles = await fetchCandles(pair, "4h", 60);
      if (pairCandles.length < ST_PERIOD + 3) continue;

      // Use completed bars only
      const completed = pairCandles.slice(0, -1);
      const st = computeSupertrend(completed, ST_PERIOD, ST_MULTIPLIER);
      if (!st) continue;

      // Detect flip: prev bar trend !== current bar trend
      if (st.prev.trend === st.current.trend) continue;

      let direction: "long" | "short" | null = null;
      if (st.current.trend === "bull") {
        if (btcBullish) {
          direction = "long";
        } else {
          console.log(`[Supertrend4h] ${pair} bull flip blocked by BTC filter`);
        }
      } else {
        direction = "short";
      }

      if (!direction) continue;
      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      const entryPrice = completed[completed.length - 1].close;
      const rawStop = calcAtrStopLoss(entryPrice, st.current.atr, direction, ATR_SL_MULTIPLIER);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const indicators = `atr:${st.current.atr.toFixed(6)}`;

      console.log(`[Supertrend4h] ${pair} flip -> ${direction} SL=${stopLoss.toFixed(4)}`);

      // TP=0 disables TP check in monitor; entryPrice enables SL rebase to actual fill
      const pos = await openPosition(
        pair, direction, ST_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE,
        stopLoss, 0, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      if (pos) {
        openPairs.add(pair);
        currentEnsembleCount++;
      }
    } catch (err) {
      console.error(`[Supertrend4h] Entry check failed for ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
