// GARCH v2 Consistency: mc5 z1.5/1.5 SL2.0/2.5 T15/5 BE5%+BE2(10->5) cd4h mh120h — bt: $4.82/day MDD $18.8 WR 54% 8 trades/day
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { isInStopLossCooldown, isInH1EntryWindow } from "./scheduler.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 1;     // 1-bar momentum
const GARCH_VOL_WINDOW_1H = 15;  // 15-bar vol window for 1h (ultra sweep winner)
const GARCH_VOL_WINDOW_4H = 20;  // 20-bar vol window for 4h
// z1.5/1.5 — 8 trades/day, 54% WR (consistency sweep winner). Balanced volume with quality filter.
const Z_LONG_1H = 1.5;
const Z_LONG_4H = 1.5;
// SL 2.0/2.5 — wider than v-best-calmar to avoid premature exit on normal vol
const SL_PCT_LOW_LEV = 0.020;
const SL_PCT_HIGH_LEV = 0.025;
const POSITION_SIZE_USD = 5; // Scaled down for ~$26 live equity (fits 5 concurrent; scale up as equity grows)
// Blocked hours 22-23 UTC (prior bt). Dropped 5-8 UTC block: verified bt shows it costs $0.74/day
// (hours profitable in 297d bt average, only adverse in last 7 live days — not structural).
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

  // Only enter near 1h boundary to match backtest timing. Scheduler fires every 3min,
  // but backtest only enters at bar close. Out-of-window cycles still run monitoring,
  // but this function is entries-only so we bail.
  if (!isInH1EntryWindow()) {
    return;
  }

  let pairIdx = 0;
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;

    // Rate limit: 150ms between pairs to avoid HL 429s (127 pairs x 2 fetches = 38s/cycle)
    if (pairIdx++ > 0) await new Promise(r => setTimeout(r, 150));

    try {
      const candles1h = await fetchCandles(pair, "1h", 100);
      if (candles1h.length < 50) continue;
      const candles4h = await fetchCandles(pair, "4h", 60);
      if (candles4h.length < 30) continue;

      const completed1h = candles1h.slice(0, -1);
      const completed4h = candles4h.slice(0, -1);

      const z1h = computeZScore(completed1h, GARCH_VOL_WINDOW_1H);
      const z4h = computeZScore(completed4h, GARCH_VOL_WINDOW_4H);

      // Long-only: shorts disabled
      if (!(z1h > Z_LONG_1H && z4h > Z_LONG_4H)) continue;
      const direction = "long" as const;

      // 1h cooldown after SL to prevent repeated re-entry on same losing pair
      if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

      // Leverage cap 5x — forensics found all 10x-leverage pairs are net negative in current book depth.
      const pairLeverage = Math.min(getMaxLeverageForPair(pair), 5);

      // SL percentage: SL_PCT_HIGH_LEV kept for future when leverage cap raises; currently always SL_PCT_LOW_LEV
      const slPct = pairLeverage >= 10 ? SL_PCT_HIGH_LEV : SL_PCT_LOW_LEV;
      // Pass SL=0 and slPct in indicators -- executor calculates SL from actual fill price
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
