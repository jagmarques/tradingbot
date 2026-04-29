// Range Expansion Engine
// Cycle 7 discovery: 1h bars where range > 2.0 × ATR(14) AND close in extreme 25% of range
// → continuation in the close direction. Works best with vol regime filter.
// OOS-validated: $1.24/day MDD $12 PF 2.46 at m$15 (IS/OOS correlation with GARCH = 0.09, true diversifier)
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "range-expansion" as const;
// Core signal parameters
const ATR_PERIOD = 14;
const RANGE_ATR_MULT = 2.0;       // range > 2.0 × ATR(14)
const CLOSE_EXTREME_PCT = 0.25;   // close must be in upper/lower 25% of bar range
// Exit
const SL_PCT = 0.0015;            // 0.15% price, exchange SL
const POSITION_SIZE_USD = 15;
// Vol regime filter: ATR-based (same as GARCH)
// ATR14_1h_current / ATR14_1h_30d_median > 1.6
const ATR_MEDIAN_WINDOW_BARS = 720;
const VOL_REGIME_THRESHOLD = 1.6;
// Hours
const BLOCKED_HOURS_UTC = new Set([22, 23]);

// ATR(14) using Wilder smoothing ending at `endIdx` (inclusive)
function computeATRAt(candles: OhlcvCandle[], endIdx: number, period: number): number {
  if (endIdx < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i <= endIdx; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Back-compat wrapper for existing caller (computeATR on full series ending at last bar)
function computeATR(candles: OhlcvCandle[], period: number): number {
  return computeATRAt(candles, candles.length - 1, period);
}

// Vol regime: ATR14_1h_current / ATR14_1h_30d_median > threshold
function computeVolRegime(candles: OhlcvCandle[]): { current: number; median: number } {
  const current = computeATRAt(candles, candles.length - 1, ATR_PERIOD);
  if (candles.length < ATR_MEDIAN_WINDOW_BARS + ATR_PERIOD + 1) return { current, median: 0 };
  // Sample ATR at stride-6 points in the last 30d window (~120 samples for speed)
  const atrs: number[] = [];
  const start = candles.length - ATR_MEDIAN_WINDOW_BARS;
  for (let endIdx = start; endIdx < candles.length; endIdx += 6) {
    if (endIdx <= ATR_PERIOD) continue;
    const atr = computeATRAt(candles, endIdx, ATR_PERIOD);
    if (atr > 0) atrs.push(atr);
  }
  if (atrs.length === 0) return { current, median: 0 };
  atrs.sort((a, b) => a - b);
  return { current, median: atrs[Math.floor(atrs.length / 2)] };
}

export async function runRangeExpansionCycle(): Promise<void> {
  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  const openPairs = new Set(myPositions.map(p => p.pair));

  const ensembleCount = allPositions.filter(
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
  ).length;

  const currentHourUTC = new Date().getUTCHours();
  if (BLOCKED_HOURS_UTC.has(currentHourUTC)) {
    console.log(`[RangeExpansion] Skipping cycle: hour ${currentHourUTC} UTC is blocked`);
    return;
  }

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      // Need enough history for ATR + vol regime median
      const candles1h = await fetchCandles(pair, "1h", 800);
      if (candles1h.length < 100) continue;

      const completed1h = candles1h.slice(0, -1);
      if (completed1h.length < 30) continue;

      // Last completed bar is the "signal bar"
      const signalBar = completed1h[completed1h.length - 1];
      const barRange = signalBar.high - signalBar.low;
      if (barRange <= 0) continue;

      const atr = computeATR(completed1h.slice(0, -1), ATR_PERIOD); // ATR computed BEFORE signal bar
      if (atr <= 0) continue;

      // Range expansion check: bar range > mult × ATR
      if (barRange < RANGE_ATR_MULT * atr) continue;

      // Close position in bar: upper/lower 25%
      const closePositionInBar = (signalBar.close - signalBar.low) / barRange; // 0 = low, 1 = high
      let direction: "long" | "short" | null = null;
      if (closePositionInBar >= 1 - CLOSE_EXTREME_PCT) {
        direction = "long"; // close in upper 25%, bullish expansion
      } else if (closePositionInBar <= CLOSE_EXTREME_PCT) {
        direction = "short"; // close in lower 25%, bearish expansion
      }
      if (!direction) continue;

      // Vol regime filter: ATR14_current / ATR14_30d_median > 1.6 (same as GARCH)
      const { current: atrNow, median: atrMed } = computeVolRegime(completed1h);
      if (atrMed === 0 || atrNow / atrMed < VOL_REGIME_THRESHOLD) continue;
      const volRatio = atrNow / atrMed;

      // Entry at current price
      const entryPrice = signalBar.close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = 0;

      const rangeToAtr = (barRange / atr).toFixed(2);
      const indicators = `rng/atr:${rangeToAtr}|closePos:${closePositionInBar.toFixed(2)}|volR:${volRatio.toFixed(2)}`;

      const pairLeverage = Math.min(await getMaxLeverageForPair(pair), 10);
      console.log(`[RangeExpansion] ${pair} range/atr=${rangeToAtr} closePos=${closePositionInBar.toFixed(2)} volR=${volRatio.toFixed(2)} -> ${direction} ${pairLeverage}x exchSL=${stopLoss.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, POSITION_SIZE_USD, pairLeverage,
        stopLoss, takeProfit, "trending", TRADE_TYPE, indicators, entryPrice, false,
      );
      if (pos) {
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[RangeExpansion] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
