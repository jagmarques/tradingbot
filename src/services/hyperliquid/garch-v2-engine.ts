// GARCH v2 lb1/vw30 LONG-ONLY, $10 margin, mc5, no ATR filter, no cooldown
// Entry: 1h z>2.0 AND 4h z>1.5 (longs only)
// Key change: MOM_LB=1 VOL_WIN=30 (was 3/20) = 3x better Calmar ratio
// Verified: $1.04/day, MTM MDD $14.54, PF 1.84, Calmar 0.071 (297 days, 125 pairs)
// On $60 equity: worst DD to $45.46, recovery 14 days, monthly profit $31 (52%)
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 1;     // 1-bar momentum (was 3)
const GARCH_VOL_WINDOW = 30;  // 30-bar vol window (was 20)
// Long-only thresholds
const Z_LONG_1H = 2.0;
const Z_LONG_4H = 1.5;
// Exchange SL at 0.15% price
const SL_PCT = 0.0015;
// Fixed $10 margin — meets HL minimum $10 notional on all pairs (even 1x)
const POSITION_SIZE_USD = 10;
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

export async function runGarchV2Cycle(): Promise<void> {
  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
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
      // Fetch 1h candles — need VOL_WIN+MOM_LB+2 completed bars minimum (34 bars)
      const candles1h = await fetchCandles(pair, "1h", 100);
      if (candles1h.length < 50) continue;
      const candles4h = await fetchCandles(pair, "4h", 60);
      if (candles4h.length < 30) continue;

      const completed1h = candles1h.slice(0, -1);
      const completed4h = candles4h.slice(0, -1);

      const z1h = computeZScore(completed1h);
      const z4h = computeZScore(completed4h);

      // Long-only: shorts disabled
      if (!(z1h > Z_LONG_1H && z4h > Z_LONG_4H)) continue;
      const direction = "long" as const;

      // No ATR regime filter — lb1/vw30 z-score is self-filtering (verified: no-ATR has best Calmar)
      // No cooldown — re-entry after SL is profitable (verified: cooldown hurts Calmar)

      const entryPrice = completed1h[completed1h.length - 1].close;
      const rawStop = entryPrice * (1 - SL_PCT);
      const stopLoss = capStopLoss(entryPrice, rawStop, direction);
      const takeProfit = 0;
      const indicators = `z1h:${z1h.toFixed(2)}|z4h:${z4h.toFixed(2)}|sl:${stopLoss.toFixed(6)}`;

      const pairLeverage = Math.min(getMaxLeverageForPair(pair), 10);

      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} -> ${direction} ${pairLeverage}x $${POSITION_SIZE_USD}mrg exchSL=${stopLoss.toFixed(4)}`);

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
