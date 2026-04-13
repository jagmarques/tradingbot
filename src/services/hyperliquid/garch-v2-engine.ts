// GARCH v2 lb1/vw30 LONG-ONLY, auto-compounding, mc7, no ATR filter, no cooldown
// Entry: 1h z>2.0 AND 4h z>1.5 (longs only)
// Key change: MOM_LB=1 VOL_WIN=30 (was 3/20) = 3x better Calmar ratio
// Auto-compounding: margin = 5% of equity, clamped $3-$50
// Verified at $20 margin mc7: $2.40/day, MTM MDD $32.39, PF 1.88, Calmar 0.074
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getMaxLeverageForPair } from "./live-executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { getAccountBalance } from "./account.js";
import { loadEnv } from "../../config/env.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-v2" as const;
const GARCH_LOOKBACK = 1;     // 1-bar momentum (was 3)
const GARCH_VOL_WINDOW = 30;  // 30-bar vol window (was 20)
// Long-only thresholds
const Z_LONG_1H = 2.0;
const Z_LONG_4H = 1.5;
// Exchange SL at 0.15% price
const SL_PCT = 0.0015;
// Auto-compounding: margin = EQUITY_PCT of equity, clamped [MIN_MARGIN, MAX_MARGIN]
const EQUITY_PCT = 0.05;      // 5% of equity per position
const MIN_MARGIN = 3;         // $3 minimum (tiny account protection)
const MAX_MARGIN = 50;        // $50 maximum (risk cap)
const FALLBACK_MARGIN = 20;   // fallback if equity fetch fails
const BLOCKED_HOURS_UTC = new Set([22, 23]);

// Cache equity for 5 minutes to avoid hammering the API every pair loop iteration
let cachedMargin = FALLBACK_MARGIN;
let cacheExpiry = 0;

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

async function getCompoundedMargin(): Promise<number> {
  const now = Date.now();
  if (now < cacheExpiry) return cachedMargin;

  try {
    const env = loadEnv();
    const wallet = env.HYPERLIQUID_WALLET_ADDRESS;
    if (!wallet) return FALLBACK_MARGIN;

    const { equity } = await getAccountBalance(wallet);
    if (equity <= 0) return FALLBACK_MARGIN;

    const raw = Math.floor(equity * EQUITY_PCT);
    const margin = Math.max(MIN_MARGIN, Math.min(MAX_MARGIN, raw));
    cachedMargin = margin;
    cacheExpiry = now + 5 * 60_000; // cache 5 min
    console.log(`[GarchV2] Auto-compound: equity=$${equity.toFixed(2)} -> margin=$${margin} (${(EQUITY_PCT * 100).toFixed(0)}%)`);
    return margin;
  } catch {
    return cachedMargin || FALLBACK_MARGIN;
  }
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

  // Auto-compounding: margin scales with equity
  const positionSize = await getCompoundedMargin();

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

      // HL requires minimum $10 notional per order
      const notional = positionSize * pairLeverage;
      if (notional < 10) {
        continue; // skip pairs where margin * leverage < $10
      }

      console.log(`[GarchV2] ${pair} z1h=${z1h.toFixed(2)} z4h=${z4h.toFixed(2)} -> ${direction} ${pairLeverage}x $${positionSize}mrg exchSL=${stopLoss.toFixed(4)}`);

      const pos = await openPosition(
        pair, direction, positionSize, pairLeverage,
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
