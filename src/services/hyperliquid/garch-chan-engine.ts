// GARCH-inspired volatility-adjusted momentum entry - v2 optimized parameters
import { ATR, ADX, EMA } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getClient, ensureConnected } from "./client.js";
import { loadEnv } from "../../config/env.js";
import { getDailyLossTotal } from "./risk-manager.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { isTrumpCooldownActive } from "../trump-guard/index.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-chan" as const;
const LEVERAGE = 10;
const RISK_PCT = 4; // compound 4% of equity per trade
const MIN_POSITION_USD = 10;
const MAX_PER_DIRECTION = 6;
const DAILY_LOSS_LIMIT = 15;
const SL_PCT = 0.03;
const TP_PCT = 0.10;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const Z_LONG_THRESHOLD = 4.5;
const Z_SHORT_THRESHOLD = -3.0;
const ADX_LONG_MIN = 30;
const ADX_SHORT_MIN = 25;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const ATR_PERIOD = 14;
const VOL_FILTER_LOOKBACK = 5;
const VOL_FILTER_RATIO = 0.9;

const GARCH_TRADING_PAIRS = ["OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "SOL", "BNB", "kSHIB", "TIA", "NEAR", "kBONK", "ONDO", "HYPE"];

interface GarchSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

async function analyzeSignal(pair: string, btcCandles: OhlcvCandle[]): Promise<GarchSignal | null> {
  const cs = await fetchCandles(pair, "1h", 80);
  if (cs.length < 30) return null;

  const last = cs.length - 1;

  // Z-score: momentum / rolling volatility
  const mom = cs[last - 1].close / cs[last - 1 - GARCH_LOOKBACK].close - 1;
  const returns: number[] = [];
  for (let i = last - GARCH_VOL_WINDOW; i < last; i++) {
    if (i < 1) continue;
    returns.push(cs[i].close / cs[i - 1].close - 1);
  }
  if (returns.length < 10) return null;
  const vol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  if (vol === 0) return null;
  const z = mom / vol;

  const goLong = z > Z_LONG_THRESHOLD;
  const goShort = z < Z_SHORT_THRESHOLD;
  if (!goLong && !goShort) return null;

  // ADX filter
  const adxInput = {
    period: 14,
    high: cs.map(c => c.high),
    low: cs.map(c => c.low),
    close: cs.map(c => c.close),
  };
  const adxVals = ADX.calculate(adxInput);
  if (adxVals.length === 0) return null;
  const adxNow = adxVals[adxVals.length - 1].adx;
  if (goLong && adxNow < ADX_LONG_MIN) return null;
  if (goShort && adxNow < ADX_SHORT_MIN) return null;

  // EMA 9/21 pair trend
  const closes = cs.map(c => c.close);
  const emaFastVals = EMA.calculate({ period: EMA_FAST, values: closes });
  const emaSlowVals = EMA.calculate({ period: EMA_SLOW, values: closes });
  if (emaFastVals.length === 0 || emaSlowVals.length === 0) return null;
  const emaFastNow = emaFastVals[emaFastVals.length - 1];
  const emaSlowNow = emaSlowVals[emaSlowVals.length - 1];
  if (goLong && emaFastNow <= emaSlowNow) return null;
  if (goShort && emaFastNow >= emaSlowNow) return null;

  // BTC EMA 9/21 trend confirmation
  const btcCloses = btcCandles.map(c => c.close);
  const btcEmaFast = EMA.calculate({ period: EMA_FAST, values: btcCloses });
  const btcEmaSlow = EMA.calculate({ period: EMA_SLOW, values: btcCloses });
  if (btcEmaFast.length === 0 || btcEmaSlow.length === 0) return null;
  const btcEmaFastNow = btcEmaFast[btcEmaFast.length - 1];
  const btcEmaSlowNow = btcEmaSlow[btcEmaSlow.length - 1];
  const btcTrend = btcEmaFastNow > btcEmaSlowNow ? "long" : "short";
  if (goLong && btcTrend !== "long") return null;
  if (goShort && btcTrend !== "short") return null;

  // Vol filter: skip when current ATR < 90% of ATR 5 bars ago
  const atrVals = ATR.calculate({
    period: ATR_PERIOD,
    high: cs.map(c => c.high),
    low: cs.map(c => c.low),
    close: cs.map(c => c.close),
  });
  if (atrVals.length < VOL_FILTER_LOOKBACK + 1) return null;
  const atrNow = atrVals[atrVals.length - 1];
  const atr5Ago = atrVals[atrVals.length - 1 - VOL_FILTER_LOOKBACK];
  if (atrNow < VOL_FILTER_RATIO * atr5Ago) return null;

  // Use last close as best proxy for current market price (SL/TP must be relative to actual entry)
  const entryPrice = cs[last].close;
  const direction = goLong ? "long" : "short";
  const stopLoss = direction === "long"
    ? entryPrice * (1 - SL_PCT)
    : entryPrice * (1 + SL_PCT);
  const takeProfit = direction === "long"
    ? entryPrice * (1 + TP_PCT)
    : entryPrice * (1 - TP_PCT);

  const emaDir = emaFastNow > emaSlowNow ? "up" : "down";
  console.log(`[GARCH-v2] ${pair} ${direction} z=${z.toFixed(2)} adx=${adxNow.toFixed(0)} ema=${emaDir} btc=${btcTrend}`);

  return { pair, direction, entryPrice, stopLoss, takeProfit };
}

export async function runGarchChanCycle(): Promise<number> {
  // Daily loss limit check
  const dailyLoss = getDailyLossTotal("garch-chan", "live");
  if (dailyLoss >= DAILY_LOSS_LIMIT) {
    console.log(`[GARCH-v2] Daily loss limit hit ($${dailyLoss.toFixed(2)} >= $${DAILY_LOSS_LIMIT}), skipping cycle`);
    return 0;
  }

  // Fetch BTC candles once for trend confirmation
  const btcCandles = await fetchCandles("BTC", "1h", 80);
  if (btcCandles.length < 30) {
    console.log("[GARCH-v2] Insufficient BTC candles, skipping cycle");
    return 0;
  }

  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);
  const openPairs = new Set(myPositions.map(p => p.pair));

  // Fetch live equity ONCE for compound sizing
  let equity = 200; // fallback
  try {
    await ensureConnected();
    const sdk = getClient();
    const env = loadEnv();
    const addr = env.HYPERLIQUID_WALLET_ADDRESS ?? "";
    const spotState = await sdk.info.spot.getSpotClearinghouseState(addr);
    const usdcBal = spotState.balances.find((b: { coin: string; total: string }) => b.coin === "USDC" || b.coin === "USDC-SPOT");
    if (usdcBal) equity = parseFloat(usdcBal.total);
  } catch { /* use fallback */ }
  const compoundSize = Math.max(MIN_POSITION_USD, Math.floor(equity * RISK_PCT / 30));

  let executed = 0;

  for (const pair of GARCH_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (isInStopLossCooldown(pair, "long", TRADE_TYPE) && isInStopLossCooldown(pair, "short", TRADE_TYPE)) continue;

    try {
      const signal = await analyzeSignal(pair, btcCandles);
      if (!signal) continue;

      // News cooldown blocks only the hurt direction
      if (isTrumpCooldownActive(signal.direction)) continue;

      const dirCount = myPositions.filter(p => p.direction === signal.direction).length;
      if (dirCount >= MAX_PER_DIRECTION) continue;

      if (isInStopLossCooldown(pair, signal.direction, TRADE_TYPE)) continue;

      console.log(`[GARCH-v2] Compound size: $${compoundSize} (equity=$${equity.toFixed(0)}, risk=${RISK_PCT}%)`);

      const position = await openPosition(
        pair, signal.direction, compoundSize, LEVERAGE,
        signal.stopLoss, signal.takeProfit, "trending", TRADE_TYPE, undefined, signal.entryPrice,
      );
      if (position) {
        executed++;
        openPairs.add(pair);
        myPositions.push(position);
      }
    } catch (err) {
      console.error(`[GARCH-v2] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return executed;
}
