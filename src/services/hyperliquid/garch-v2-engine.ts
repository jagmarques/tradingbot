// GARCH v2 winner C2 (cycle 7): mc7 z3.0/1.5 (LONG) z3.0/1.5 (SHORT, symm) SL3.0/3.5 T15/4 no-BE cd4h mh120h cap10x
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { isInStopLossCooldown, isInH1EntryWindow } from "./scheduler.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 1;
const GARCH_VOL_WINDOW_1H = 15;
const GARCH_VOL_WINDOW_4H = 20;
const Z_LONG_1H = 3.0;
const Z_LONG_4H = 1.5;
// Symmetric shorts at z=3.0 with wider SL (cycle 7 reconciliation):
// 648-config sweep + bt-add-shorts.ts engine validation: Calmar 0.029 vs deployed 0.017 (+76%),
// $0.55/d vs $0.36/d, MDD $18.7 vs $21.7. Engine parity confirmed across both backtest scripts.
const Z_SHORT_1H = 3.0;
const Z_SHORT_4H = 1.5;
const SL_PCT_LOW_LEV = 0.030;
const SL_PCT_HIGH_LEV = 0.035;
const POSITION_SIZE_USD = 20; // 7 concurrent × $20 = $140 max margin used
const BLOCKED_HOURS_UTC = new Set([22, 23]);

function computeZScore(candles: OhlcvCandle[], volWindow: number): number {
  if (candles.length < volWindow + GARCH_LOOKBACK + 1) return 0;
  const last = candles.length - 1;
  const mom = candles[last].close / candles[last - GARCH_LOOKBACK].close - 1;
  const returns: number[] = [];
  for (let i = last - volWindow; i <= last; i++) {
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

  // Entries only near 1h boundary (bt parity).
  if (!isInH1EntryWindow()) return;

  let pairIdx = 0;
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    if (pairIdx++ > 0) await new Promise(r => setTimeout(r, 150)); // HL rate limit

    try {
      const candles1h = await fetchCandles(pair, "1h", 100);
      if (candles1h.length < 50) continue;
      const candles4h = await fetchCandles(pair, "4h", 60);
      if (candles4h.length < 30) continue;

      const completed1h = candles1h.slice(0, -1);
      const completed4h = candles4h.slice(0, -1);

      const z1h = computeZScore(completed1h, GARCH_VOL_WINDOW_1H);
      const z4h = computeZScore(completed4h, GARCH_VOL_WINDOW_4H);

      let direction: "long" | "short" | null = null;
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H) direction = "long";
      else if (z1h < -Z_SHORT_1H && z4h < -Z_SHORT_4H) direction = "short";
      if (!direction) continue;
      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      const pairLeverage = Math.min(await getMaxLeverageForPair(pair), 10);

      const slPct = pairLeverage >= 10 ? SL_PCT_HIGH_LEV : SL_PCT_LOW_LEV;
      const takeProfit = 0;
      const indicators = `z1h:${z1h.toFixed(2)}|z4h:${z4h.toFixed(2)}|slPct:${slPct}`;

      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} -> ${direction} ${pairLeverage}x $${POSITION_SIZE_USD}mrg slPct=${(slPct * 100).toFixed(2)}%`);

      const pos = await openPosition(
        pair, direction, POSITION_SIZE_USD, pairLeverage,
        0, takeProfit, "trending", TRADE_TYPE, indicators, 0, false,
      );
      if (pos) {
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[GarchV2] ${pair} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
