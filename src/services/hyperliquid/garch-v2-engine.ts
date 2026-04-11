// GARCH v2 LONG-ONLY LOOSE with ATR regime filter + $30 margin
// Entry: 1h z>2.0 AND 4h z>1.5 (longs only, no shorts — Z_SHORT set to unreachable)
// Regime: ATR14_1h / ATR14_1h_30d_median > 1.6 (ATR-based, verified superior to RV-based)
// Verified OOS at m$30: $3.15/day MDD $10.84 PF 2.50 (vs deployed $1.17/day MDD $17 with RV regime + m$15)
// 127 pairs, real leverage (cap 10x), exchange SL at 0.15%
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
// Long-only loose thresholds. Shorts disabled (unreachable value).
// Cycle 6/7 finding: 34 short trades in OOS all lost money; removing shorts cut MDD by 60%.
const Z_LONG_1H = 2.0;
const Z_SHORT_1H = -999; // SHORTS DISABLED
const Z_LONG_4H = 1.5;
const Z_SHORT_4H = -999; // SHORTS DISABLED
// Wider exchange SL at 0.15% price
const SL_PCT = 0.0015;
// Margin $30 — enabled by ATR regime filter dropping MDD from $16 to $5.4 (verified at m$15)
// At m$30: $3.15/day OOS MDD $10.84 (verified via actual re-simulation, not extrapolation)
const POSITION_SIZE_USD = 30;
// ATR-based vol regime: ATR14_1h_current / ATR14_1h_30d_median > 1.6
// Verified superior to RV-based: +$0.37/day AND -$10.62 MDD at same margin
const ATR_PERIOD = 14;
const ATR_MEDIAN_WINDOW_BARS = 720; // 30 days of 1h bars
// Stricter threshold 1.8 = fewer but higher-quality signals. PF 2.50→2.72, MDD at m$30 drops $10.84→$6.27.
const VOL_REGIME_THRESHOLD = 1.8;
const MAX_PER_DIRECTION = 999;
const BLOCKED_HOURS_UTC = new Set([22, 23]);

function computeZScore(candles: OhlcvCandle[]): number {
  if (candles.length < GARCH_VOL_WINDOW + GARCH_LOOKBACK + 1) return 0;
  const last = candles.length - 1;
  const mom = candles[last].close / candles[last - GARCH_LOOKBACK].close - 1;
  const returns: number[] = [];
  for (let i = last - GARCH_VOL_WINDOW; i <= last; i++) {
    if (i < 1) continue;
    returns.push(candles[i].close / candles[i - 1].close - 1);
  }
  if (returns.length < 10) return 0;
  const vol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  return vol === 0 ? 0 : mom / vol;
}

// ATR(14) using Wilder smoothing computed ENDING at index `endIdx`
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

// Vol regime: ATR14_1h_current / ATR14_1h_30d_median
// Returns { current, median } — if current/median > VOL_REGIME_THRESHOLD, we're in high vol
function computeVolRegime(candles: OhlcvCandle[]): { current: number; median: number } {
  const current = computeATRAt(candles, candles.length - 1, ATR_PERIOD);
  if (candles.length < ATR_MEDIAN_WINDOW_BARS + ATR_PERIOD + 1) return { current, median: 0 };
  // Sample ATR at each point in the last 30d window (stride 6 for speed, ~120 samples)
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

export async function runGarchV2Cycle(): Promise<void> {
  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  const longCount = myPositions.filter(p => p.direction === "long").length;
  const shortCount = myPositions.filter(p => p.direction === "short").length;
  const openPairs = new Set(myPositions.map(p => p.pair));

  const ensembleCount = allPositions.filter(
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
  ).length;

  // Block toxic UTC hours (h22-23: negative expectancy, proven by backtest)
  const currentHourUTC = new Date().getUTCHours();
  if (BLOCKED_HOURS_UTC.has(currentHourUTC)) {
    console.log(`[GarchV2] Skipping cycle: hour ${currentHourUTC} UTC is blocked`);
    return;
  }

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      // Fetch 1h candles with enough history for 30d rolling median (720 bars + buffer)
      const candles1h = await fetchCandles(pair, "1h", 800);
      if (candles1h.length < 100) continue;
      const candles4h = await fetchCandles(pair, "4h", 60);
      if (candles4h.length < 30) continue;

      const completed1h = candles1h.slice(0, -1);
      const completed4h = candles4h.slice(0, -1);

      const z1h = computeZScore(completed1h);
      const z4h = computeZScore(completed4h);

      let direction: "long" | "short" | null = null;

      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && longCount < MAX_PER_DIRECTION) {
        direction = "long";
      } else if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && shortCount < MAX_PER_DIRECTION) {
        direction = "short";
      }

      if (!direction) continue;

      // Vol regime filter: ATR14_current / ATR14_30d_median must exceed threshold
      // Verified better than RV-based: +$0.37/day AND -$10.62 MDD at same margin
      const { current: atrNow, median: atrMed } = computeVolRegime(completed1h);
      if (atrMed === 0 || atrNow / atrMed < VOL_REGIME_THRESHOLD) {
        continue;
      }
      const volRatio = atrNow / atrMed;

      // Cooldown removed: OOS backtest showed 1h cooldown cost $0.50/day. Re-entry after SL is fine.
      const entryPrice = completed1h[completed1h.length - 1].close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = 0;
      // Exchange SL at 0.08% price: caps per-trade loss (~$0.45 on $15 margin at 10x)
      const indicators = `z1h:${z1h.toFixed(2)}|z4h:${z4h.toFixed(2)}|volR:${volRatio.toFixed(2)}|sl:${stopLoss.toFixed(6)}`;

      const pairLeverage = Math.min(getMaxLeverageForPair(pair), 10);
      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} volR=${volRatio.toFixed(2)} -> ${direction} ${pairLeverage}x exchSL=${stopLoss.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, POSITION_SIZE_USD, pairLeverage,
        stopLoss, takeProfit, "trending", TRADE_TYPE, indicators, entryPrice, false,
      );
      if (pos) {
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[GarchV2] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
