// GARCH v2 with Multi-Timeframe Z-Score + Vol Regime filter
// SAFE config: wider SL 0.15% (fees not dominant), stricter z (4,-6,2,-2), no cooldown
// Entry: 1h z>4.0 AND 4h z>2.0 for longs, 1h z<-6.0 AND 4h z<-2.0 for shorts (asymmetric, strict)
// Regime: only trade when RV(24h) / rolling_median_30d > 1.5 (high-vol regime)
// OOS-validated SAFE: ~$0.39/day MDD $7 PF 2.24 — wide SL, low DD, rebuilds account slowly
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
// Strict asymmetric z-thresholds: fewer but higher-quality entries (SAFE config)
const Z_LONG_1H = 4.0;
const Z_SHORT_1H = -6.0;
const Z_LONG_4H = 2.0;
const Z_SHORT_4H = -2.0;
// Wider exchange SL at 0.15% price — fees round-trip = 0.07% so SL ≥ 0.15% means fees < 50% of SL cost
// OOS-validated SAFE: SL 0.15% + T12/0.5 + Z(4,-6,2,-2) + R1.5 + BE5 = $0.39/day MDD $6.8 PF 2.24
const SL_PCT = 0.0015;
// Fixed $15 margin
const POSITION_SIZE_USD = 15;
// Vol regime: RV(24h 1h returns) / 30d rolling median must exceed this to enter
const RV_WINDOW_BARS = 24;
const RV_MEDIAN_WINDOW_BARS = 720; // 30 days of 1h bars
const VOL_REGIME_THRESHOLD = 1.5;
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

// Vol regime: compute rolling RV over the full 1h candle history, then take median of last N values
// Returns { current, median } — if current/median > VOL_REGIME_THRESHOLD, we're in high vol
function computeVolRegime(candles: OhlcvCandle[]): { current: number; median: number } {
  const current = computeRV(candles, RV_WINDOW_BARS);
  if (candles.length < RV_MEDIAN_WINDOW_BARS + RV_WINDOW_BARS) return { current, median: 0 };
  // Compute RV at each point over the last RV_MEDIAN_WINDOW_BARS bars
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

      // Vol regime filter: only trade when realized vol is elevated (RV_current / RV_median30d > threshold)
      // This was the OOS-validated breakthrough: 81-122% IS->OOS retention vs 48% for unfiltered
      const { current: rvNow, median: rvMed } = computeVolRegime(completed1h);
      if (rvMed === 0 || rvNow / rvMed < VOL_REGIME_THRESHOLD) {
        continue;
      }
      const volRatio = rvNow / rvMed;

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
