// GARCH v2 with Multi-Timeframe Z-Score confirmation
// 1h z>2.0 AND 4h z>1.5 for longs, 1h z<-2.0 AND 4h z<-1.5 for shorts
// 127 pairs, real leverage (3x/5x/10x), no EMA/BTC/regime/volume filters
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getLiveBalance, getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";

// Auto-scaler: 5% of equity, clamped $10-$15 (HL requires $10 minimum order value)
const SCALE_FACTOR = 0.05;
const MIN_SIZE = 10;
const MAX_SIZE = 15;
async function computeGarchSize(): Promise<number> {
  try {
    const balance = await getLiveBalance();
    const raw = Math.floor(balance * SCALE_FACTOR);
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, raw));
  } catch { return MIN_SIZE; }
}
import { capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const Z_LONG_1H = 2.0;
const Z_SHORT_1H = -2.0;
const Z_LONG_4H = 1.5;
const Z_SHORT_4H = -1.5;
const SL_PCT = 0.003;
const MAX_PER_DIRECTION = 999; // unlimited, DD controlled by small SL + small size
const BLOCKED_HOURS_UTC = new Set([22, 23]); // toxic hours, -$39 at h22, PF improves 1.90->2.03

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
  const garchSizeUsd = await computeGarchSize();

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
      // Fetch both timeframes
      const candles1h = await fetchCandles(pair, "1h", 80);
      if (candles1h.length < 30) continue;
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

      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      const entryPrice = completed1h[completed1h.length - 1].close;
      const rawStop = direction === "long" ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = 0;
      // No exchange SL -- bot monitors at 1h bar boundary (exchange stops fire on ticks, kills strategy)
      const indicators = `z1h:${z1h.toFixed(2)}|z4h:${z4h.toFixed(2)}|sl:${stopLoss.toFixed(6)}`;

      const pairLeverage = Math.min(getMaxLeverageForPair(pair), 10);
      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} -> ${direction} ${pairLeverage}x botSL=${stopLoss.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, garchSizeUsd, pairLeverage,
        0, takeProfit, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      // Store real SL on position for bot-monitored 1h boundary check
      if (pos) {
        pos.stopLoss = stopLoss;
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[GarchV2] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
