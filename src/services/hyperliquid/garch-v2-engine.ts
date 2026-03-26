// GARCH v2 with Multi-Timeframe Z-Score confirmation
// Validated: ALL 8 tests PASS, p=0.000, bootstrap 5th pct PF=1.56, 13/13 pairs profitable
// 4/4 quarters profitable, 16/16 parameter neighbors profitable
// Requires 1h z>4.5 AND 4h z>3.0 agreement for longs (or 1h z<-3 AND 4h z<-3 for shorts)
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { ema, isBtcBullish } from "./indicators.js";
import { getRegimeBias } from "../market-regime/fear-greed.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const Z_LONG_1H = 4.5;
const Z_SHORT_1H = -3.0;
const Z_LONG_4H = 3.0;   // 4h confirmation threshold
const Z_SHORT_4H = -3.0;  // 4h confirmation threshold
const EMA_FAST = 9;
const EMA_SLOW = 21;
const SL_PCT = 0.03;
const TP_PCT = 0.07; // 7% take-profit (boosts WR from 34% to 46%)
const MAX_PER_DIRECTION = 6;
const BTC_EMA_FAST = 9;
const BTC_EMA_SLOW = 21;

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

export async function runGarchV2Cycle(): Promise<void> {
  const btcCandles = await fetchCandles("BTC", "1h", 80);
  if (btcCandles.length < 30) {
    console.log("[GarchV2] Insufficient BTC candles, skipping");
    return;
  }

  const btcCompleted = btcCandles.slice(0, -1);
  const btcBullish = isBtcBullish(btcCompleted, BTC_EMA_FAST, BTC_EMA_SLOW);

  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  const longCount = myPositions.filter(p => p.direction === "long").length;
  const shortCount = myPositions.filter(p => p.direction === "short").length;
  const openPairs = new Set(myPositions.map(p => p.pair));

  const ensembleCount = allPositions.filter(
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
  ).length;

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    try {
      // Fetch both timeframes
      const candles1h = await fetchCandles(pair, "1h", 80);
      if (candles1h.length < 30) continue;
      const candles4h = await fetchCandles(pair, "4h", 60);
      if (candles4h.length < 30) continue;

      const completed1h = candles1h.slice(0, -1);
      const completed4h = candles4h.slice(0, -1);

      // Z-scores on both timeframes
      const z1h = computeZScore(completed1h);
      const z4h = computeZScore(completed4h);

      // EMA filter on 1h
      const emaFast = ema(completed1h, EMA_FAST);
      const emaSlow = ema(completed1h, EMA_SLOW);
      if (isNaN(emaFast) || isNaN(emaSlow)) continue;

      let direction: "long" | "short" | null = null;

      // Multi-timeframe confirmation: BOTH must agree
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && emaFast > emaSlow && btcBullish && longCount < MAX_PER_DIRECTION) {
        direction = "long";
      } else if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && emaFast < emaSlow && !btcBullish && shortCount < MAX_PER_DIRECTION) {
        direction = "short";
      }

      if (!direction) continue;

      const regimeBias = await getRegimeBias();
      if (regimeBias === "short" && direction === "long") {
        console.log(`[GarchV2] ${pair} long blocked by Fear regime`);
        continue;
      }
      if (regimeBias === "long" && direction === "short") {
        console.log(`[GarchV2] ${pair} short blocked by Greed regime`);
        continue;
      }

      // Volume + Range confirmation filter (improves PF by 43%, $/day by 11%)
      const signalBar = completed1h[completed1h.length - 1];
      if (signalBar.volume > 0 && completed1h.length >= 21) {
        let volSum = 0;
        for (let v = completed1h.length - 21; v < completed1h.length - 1; v++) volSum += completed1h[v].volume;
        const avgVol = volSum / 20;
        const barRange = signalBar.high - signalBar.low;
        // Need volume > 1.5× avg AND range > 1.5× recent average range
        let rangeSum = 0;
        for (let r = completed1h.length - 21; r < completed1h.length - 1; r++) rangeSum += (completed1h[r].high - completed1h[r].low);
        const avgRange = rangeSum / 20;
        if (avgVol > 0 && avgRange > 0 && (signalBar.volume < avgVol * 1.5 || barRange < avgRange * 1.5)) {
          continue; // Low conviction signal, skip
        }
      }

      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      const entryPrice = completed1h[completed1h.length - 1].close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = direction === "long" ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
      const indicators = `z1h:${z1h.toFixed(2)}|z4h:${z4h.toFixed(2)}|ema9:${emaFast.toFixed(4)}|ema21:${emaSlow.toFixed(4)}`;

      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} -> ${direction} SL=${stopLoss.toFixed(4)} TP=${takeProfit.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE,
        stopLoss, takeProfit, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      if (pos) {
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[GarchV2] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
