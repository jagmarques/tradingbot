// GARCH v2 Optimized: Z-score momentum with multi-filter confirmation
// Validated: p<0.0001 vs random, bootstrap 5th pct PF=1.16, 13/14 pairs profitable
// Improvements from devil's advocate: SL 4% (was 3%), max hold 168h (was 48h), no ADX filter
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const Z_LONG_THRESHOLD = 4.5;
const Z_SHORT_THRESHOLD = -3.0;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const SL_PCT = 0.04; // 4% (improved from 3%)
// TP handled by position monitor stagnation (168h max hold), no fixed TP
const POSITION_SIZE_USD = 5; // $5 margin (half of ensemble budget)
const MAX_PER_DIRECTION = 6;
const BTC_EMA_FAST = 9;
const BTC_EMA_SLOW = 21;

function ema(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period) return NaN;
  const mult = 2 / (period + 1);
  let val = 0;
  for (let i = 0; i < period; i++) val += candles[i].close;
  val /= period;
  for (let i = period; i < candles.length; i++) {
    val = candles[i].close * mult + val * (1 - mult);
  }
  return val;
}

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

function isBtcBullish(btcCandles: OhlcvCandle[]): boolean {
  const fast = ema(btcCandles, BTC_EMA_FAST);
  const slow = ema(btcCandles, BTC_EMA_SLOW);
  if (isNaN(fast) || isNaN(slow)) return false;
  return fast > slow;
}

export async function runGarchV2Cycle(): Promise<void> {
  const btcCandles = await fetchCandles("BTC", "1h", 80);
  if (btcCandles.length < 30) {
    console.log("[GarchV2] Insufficient BTC candles, skipping");
    return;
  }

  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted);

  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Count directions
  const longCount = myPositions.filter(p => p.direction === "long").length;
  const shortCount = myPositions.filter(p => p.direction === "short").length;
  const openPairs = new Set(myPositions.map(p => p.pair));

  // Ensemble position count (shared with donchian + supertrend)
  const ensembleCount = allPositions.filter(
    p => p.tradeType === "donchian-trend" || p.tradeType === "supertrend-4h" || p.tradeType === TRADE_TYPE,
  ).length;

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      const candles = await fetchCandles(pair, "1h", 80);
      if (candles.length < 30) continue;

      const completed = candles.slice(0, -1);
      const z = computeZScore(completed);

      // EMA filter
      const emaFast = ema(completed, EMA_FAST);
      const emaSlow = ema(completed, EMA_SLOW);
      if (isNaN(emaFast) || isNaN(emaSlow)) continue;

      let direction: "long" | "short" | null = null;

      if (z > Z_LONG_THRESHOLD && emaFast > emaSlow && btcBullish && longCount < MAX_PER_DIRECTION) {
        direction = "long";
      } else if (z < Z_SHORT_THRESHOLD && emaFast < emaSlow && !btcBullish && shortCount < MAX_PER_DIRECTION) {
        direction = "short";
      }

      if (!direction) continue;
      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      const entryPrice = completed[completed.length - 1].close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const indicators = `z:${z.toFixed(2)}|ema9:${emaFast.toFixed(6)}|ema21:${emaSlow.toFixed(6)}`;

      console.log(`[GarchV2] ${pair} z=${z.toFixed(2)} -> ${direction} SL=${stopLoss.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, POSITION_SIZE_USD, ENSEMBLE_LEVERAGE,
        stopLoss, 0, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      if (pos) {
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[GarchV2] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
