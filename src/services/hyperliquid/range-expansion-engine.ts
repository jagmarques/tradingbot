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
// Vol regime filter (same as GARCH)
const RV_WINDOW_BARS = 24;
const RV_MEDIAN_WINDOW_BARS = 720;
const VOL_REGIME_THRESHOLD = 1.5;
// Hours
const BLOCKED_HOURS_UTC = new Set([22, 23]);

// Compute ATR(14) on 1h closes
function computeATR(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Realized vol: std of 1h returns over last N bars
function computeRV(candles: OhlcvCandle[], window: number): number {
  if (candles.length < window + 1) return 0;
  const last = candles.length - 1;
  let ss = 0, c = 0;
  for (let i = last - window + 1; i <= last; i++) {
    if (i < 1) continue;
    const r = candles[i].close / candles[i - 1].close - 1;
    ss += r * r; c++;
  }
  if (c < 10) return 0;
  return Math.sqrt(ss / c);
}

// Vol regime: rolling RV median over last N bars
function computeVolRegime(candles: OhlcvCandle[]): { current: number; median: number } {
  const current = computeRV(candles, RV_WINDOW_BARS);
  if (candles.length < RV_MEDIAN_WINDOW_BARS + RV_WINDOW_BARS) return { current, median: 0 };
  const rvs: number[] = [];
  for (let endIdx = candles.length - RV_MEDIAN_WINDOW_BARS; endIdx < candles.length; endIdx++) {
    if (endIdx < RV_WINDOW_BARS) continue;
    let ss = 0, c = 0;
    for (let i = endIdx - RV_WINDOW_BARS + 1; i <= endIdx; i++) {
      if (i < 1) continue;
      const r = candles[i].close / candles[i - 1].close - 1;
      ss += r * r; c++;
    }
    if (c >= 10) rvs.push(Math.sqrt(ss / c));
  }
  if (rvs.length === 0) return { current, median: 0 };
  rvs.sort((a, b) => a - b);
  return { current, median: rvs[Math.floor(rvs.length / 2)] };
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

      // Vol regime filter (same as GARCH)
      const { current: rvNow, median: rvMed } = computeVolRegime(completed1h);
      if (rvMed === 0 || rvNow / rvMed < VOL_REGIME_THRESHOLD) continue;
      const volRatio = rvNow / rvMed;

      // Entry at current price
      const entryPrice = signalBar.close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = 0;

      const rangeToAtr = (barRange / atr).toFixed(2);
      const indicators = `rng/atr:${rangeToAtr}|closePos:${closePositionInBar.toFixed(2)}|volR:${volRatio.toFixed(2)}`;

      const pairLeverage = Math.min(getMaxLeverageForPair(pair), 10);
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
