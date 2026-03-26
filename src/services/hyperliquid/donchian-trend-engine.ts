import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { calcAtrStopLoss, capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { sma, atr, isBtcBullish, donchianExitChannel } from "./indicators.js";
import { getRegimeBias } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";

const TRADE_TYPE = "donchian-trend" as const;
const SMA_FAST = 20;
const SMA_SLOW = 50;
const DONCHIAN_EXIT_PERIOD = 15;
const ATR_PERIOD = 14;
const ATR_SL_MULTIPLIER = 3;
const BTC_EMA_FAST = 20;
const BTC_EMA_SLOW = 50;

let lastDailyCheckTs = 0;

export async function runDonchianTrendCycle(): Promise<void> {
  const now = Date.now();
  // Align to calendar day boundaries (UTC) to prevent drift
  const todayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  if (todayStart <= lastDailyCheckTs) return;

  const btcCandles = await fetchCandles("BTC", "1d", 200);
  if (btcCandles.length < 62) {
    console.log("[DonchianTrend] Insufficient BTC candles, skipping cycle");
    return;
  }

  // Set timer AFTER successful BTC fetch (not before, to allow retry on failure)
  lastDailyCheckTs = todayStart;

  // Exclude incomplete current bar for BTC filter
  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted, BTC_EMA_FAST, BTC_EMA_SLOW);

  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  // EXIT LOGIC
  for (const pos of myPositions) {
    try {
      const pairCandles = await fetchCandles(pos.pair, "1d", 70);
      if (pairCandles.length < DONCHIAN_EXIT_PERIOD + 2) continue;

      // Use completed bars only (exclude last incomplete bar)
      const completed = pairCandles.slice(0, -1);
      const channel = donchianExitChannel(completed, DONCHIAN_EXIT_PERIOD);
      const lastClose = completed[completed.length - 1].close;

      const shouldExit =
        (pos.direction === "long" && lastClose < channel.low) ||
        (pos.direction === "short" && lastClose > channel.high);

      if (shouldExit) {
        console.log(`[DonchianTrend] ${pos.pair} ${pos.direction} donchian-exit close=${lastClose.toFixed(4)} channel=${channel.low.toFixed(4)}-${channel.high.toFixed(4)}`);
        await closePosition(pos.id, "donchian-exit");
      }
    } catch (err) {
      console.error(`[DonchianTrend] Exit check failed for ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Refresh positions after exits
  const openPairs = new Set(
    getOpenQuantPositions()
      .filter(p => p.tradeType === TRADE_TYPE)
      .map(p => p.pair),
  );
  let currentEnsembleCount = getOpenQuantPositions().filter(
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
  ).length;

  // ENTRY LOGIC
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (currentEnsembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      const pairCandles = await fetchCandles(pair, "1d", 70);
      if (pairCandles.length < 62) continue;

      // Use completed bars only
      const completed = pairCandles.slice(0, -1);
      if (completed.length < SMA_SLOW + 1) continue;

      // Current = last completed bar, Previous = second-to-last completed bar
      const currentBars = completed;
      const prevBars = completed.slice(0, -1);

      const smaFastCurrent = sma(currentBars, SMA_FAST);
      const smaSlowCurrent = sma(currentBars, SMA_SLOW);
      const smaFastPrev = sma(prevBars, SMA_FAST);
      const smaSlowPrev = sma(prevBars, SMA_SLOW);

      if (isNaN(smaFastCurrent) || isNaN(smaSlowCurrent) || isNaN(smaFastPrev) || isNaN(smaSlowPrev)) continue;

      const goldenCross = smaFastCurrent > smaSlowCurrent && smaFastPrev <= smaSlowPrev;
      const deathCross = smaFastCurrent < smaSlowCurrent && smaFastPrev >= smaSlowPrev;

      let direction: "long" | "short" | null = null;
      if (goldenCross && btcBullish) {
        direction = "long";
      } else if (deathCross) {
        direction = "short";
      }

      if (!direction) continue;

      const regimeBias = await getRegimeBias();
      if (regimeBias === "short" && direction === "long") {
        console.log(`[DonchianTrend] ${pair} long blocked by Fear regime`);
        continue;
      }
      if (regimeBias === "long" && direction === "short") {
        console.log(`[DonchianTrend] ${pair} short blocked by Greed regime`);
        continue;
      }

      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      // ATR for stop-loss (capped to QUANT_MAX_SL_PCT)
      const atr14 = atr(completed, ATR_PERIOD);
      const entryPrice = completed[completed.length - 1].close;
      const rawStop = calcAtrStopLoss(entryPrice, atr14, direction, ATR_SL_MULTIPLIER);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const indicators = `atr:${atr14.toFixed(6)}`;

      const crossType = direction === "long" ? "golden cross" : "death cross";
      console.log(`[DonchianTrend] ${pair} SMA20/50 ${crossType} -> ${direction} SL=${stopLoss.toFixed(4)}`);

      // TP=0 disables TP check in monitor; entryPrice enables SL rebase to actual fill
      const pos = await openPosition(
        pair, direction, ENSEMBLE_POSITION_SIZE_USD * getEventSizeMultiplier(), ENSEMBLE_LEVERAGE,
        stopLoss, 0, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      if (pos) {
        openPairs.add(pair);
        currentEnsembleCount++;
      }
    } catch (err) {
      console.error(`[DonchianTrend] Entry check failed for ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
