// Engine E: Range Expansion - enter after unusually large daily bars
// Validated: 6/7 PASS, bootstrap 5th pct PF=1.82, 99th pctile vs random
// Near-zero correlation with other engines (0.03-0.04)
// Streaky (5/13 quarters negative) so uses smaller position size ($3)
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { calcAtrStopLoss, capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { isBtcBullish } from "./indicators.js";
import { getRegimeBias } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";

const TRADE_TYPE = "range-expansion" as const;
const RANGE_THRESHOLD = 2.0; // today's range must be > 2× 20-day avg
const RANGE_LOOKBACK = 20;
const ATR_PERIOD = 14;
const ATR_SL_MULTIPLIER = 2;
const DONCHIAN_EXIT_PERIOD = 10;
const POSITION_SIZE_USD = 3; // Smaller due to streaky nature
const BTC_EMA_FAST = 20;
const BTC_EMA_SLOW = 50;

let lastDailyCheckTs = 0;

export async function runRangeExpansionCycle(): Promise<void> {
  const now = Date.now();
  const todayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  if (todayStart <= lastDailyCheckTs) return;

  const btcCandles = await fetchCandles("BTC", "1d", 200);
  if (btcCandles.length < 30) {
    console.log("[RangeExpansion] Insufficient BTC candles, skipping");
    return;
  }

  lastDailyCheckTs = todayStart;

  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted, BTC_EMA_FAST, BTC_EMA_SLOW);

  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);

  // EXIT LOGIC: 10-day Donchian exit using closes
  for (const pos of myPositions) {
    try {
      const pairCandles = await fetchCandles(pos.pair, "1d", 30);
      if (pairCandles.length < DONCHIAN_EXIT_PERIOD + 2) continue;

      const completed = pairCandles.slice(0, -1);
      const exitSlice = completed.slice(-DONCHIAN_EXIT_PERIOD);
      let chanHigh = -Infinity, chanLow = Infinity;
      for (const c of exitSlice) {
        if (c.close > chanHigh) chanHigh = c.close;
        if (c.close < chanLow) chanLow = c.close;
      }
      const lastClose = completed[completed.length - 1].close;

      const shouldExit =
        (pos.direction === "long" && lastClose < chanLow) ||
        (pos.direction === "short" && lastClose > chanHigh);

      if (shouldExit) {
        console.log(`[RangeExpansion] ${pos.pair} ${pos.direction} donchian-exit`);
        await closePosition(pos.id, "donchian-exit");
      }
    } catch (err) {
      console.error(`[RangeExpansion] Exit check failed for ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Refresh after exits
  const openPairs = new Set(
    getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE).map(p => p.pair),
  );
  const ensembleCount = getOpenQuantPositions().filter(
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
  ).length;

  // ENTRY LOGIC
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      const pairCandles = await fetchCandles(pair, "1d", 40);
      if (pairCandles.length < RANGE_LOOKBACK + 5) continue;

      const completed = pairCandles.slice(0, -1);
      if (completed.length < RANGE_LOOKBACK + 1) continue;

      const lastBar = completed[completed.length - 1];
      const todayRange = (lastBar.high - lastBar.low) / lastBar.close;

      // Compute 20-day average range
      let rangeSum = 0;
      for (let i = completed.length - RANGE_LOOKBACK - 1; i < completed.length - 1; i++) {
        rangeSum += (completed[i].high - completed[i].low) / completed[i].close;
      }
      const avgRange = rangeSum / RANGE_LOOKBACK;

      if (avgRange <= 0 || todayRange < RANGE_THRESHOLD * avgRange) continue;

      // Expansion detected - direction based on bar color
      const isBullish = lastBar.close > lastBar.open;
      let direction: "long" | "short" | null = null;
      if (isBullish && btcBullish) {
        direction = "long";
      } else if (!isBullish) {
        direction = "short";
      }

      if (!direction) continue;

      const regimeBias = await getRegimeBias();
      if (regimeBias === "short" && direction === "long") {
        console.log(`[RangeExpansion] ${pair} long blocked by Fear regime`);
        continue;
      }
      if (regimeBias === "long" && direction === "short") {
        console.log(`[RangeExpansion] ${pair} short blocked by Greed regime`);
        continue;
      }

      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      // ATR for stop
      const atrSlice = completed.slice(-ATR_PERIOD - 1);
      let atrSum = 0;
      for (let i = 1; i < atrSlice.length; i++) {
        atrSum += Math.max(
          atrSlice[i].high - atrSlice[i].low,
          Math.abs(atrSlice[i].high - atrSlice[i - 1].close),
          Math.abs(atrSlice[i].low - atrSlice[i - 1].close),
        );
      }
      const atr = atrSum / ATR_PERIOD;

      const entryPrice = lastBar.close;
      const rawStop = calcAtrStopLoss(entryPrice, atr, direction, ATR_SL_MULTIPLIER);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);

      console.log(`[RangeExpansion] ${pair} range=${(todayRange / avgRange).toFixed(1)}x avg -> ${direction} SL=${stopLoss.toFixed(4)}`);

      await openPosition(
        pair, direction, POSITION_SIZE_USD * getEventSizeMultiplier(), ENSEMBLE_LEVERAGE,
        stopLoss, 0, "trending", TRADE_TYPE, `range:${(todayRange / avgRange).toFixed(2)}`, entryPrice,
      );
    } catch (err) {
      console.error(`[RangeExpansion] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
