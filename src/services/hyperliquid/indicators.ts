import { RSI, MACD, BollingerBands, ATR, VWAP, ADX } from "technicalindicators";
import type { OhlcvCandle, TechnicalIndicators } from "./types.js";

const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const BB_PERIOD = 20;
const BB_STDDEV = 2;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;

const MIN_CANDLES = MACD_SLOW; // 26 is the longest lookback

export function computeIndicators(candles: OhlcvCandle[]): TechnicalIndicators {
  if (candles.length < MIN_CANDLES) {
    return {
      rsi: null,
      macd: null,
      bollingerBands: null,
      atr: null,
      vwap: null,
      adx: null,
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // RSI
  const rsiResult = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const rsi = rsiResult.length > 0 ? (rsiResult[rsiResult.length - 1] ?? null) : null;

  // MACD
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: MACD_FAST,
    slowPeriod: MACD_SLOW,
    signalPeriod: MACD_SIGNAL,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const lastMacd = macdResult.length > 0 ? macdResult[macdResult.length - 1] : undefined;
  const macd =
    lastMacd !== undefined
      ? {
          macd: lastMacd.MACD ?? null,
          signal: lastMacd.signal ?? null,
          histogram: lastMacd.histogram ?? null,
        }
      : null;

  // Bollinger Bands
  const bbResult = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  const lastBb = bbResult.length > 0 ? bbResult[bbResult.length - 1] : undefined;
  const bollingerBands =
    lastBb !== undefined
      ? {
          upper: lastBb.upper,
          middle: lastBb.middle,
          lower: lastBb.lower,
          width: lastBb.middle > 0 ? (lastBb.upper - lastBb.lower) / lastBb.middle : null,
        }
      : null;

  // ATR
  const atrResult = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
  const atrVal = atrResult.length > 0 ? (atrResult[atrResult.length - 1] ?? null) : null;

  // VWAP
  const vwapResult = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
  const vwap = vwapResult.length > 0 ? (vwapResult[vwapResult.length - 1] ?? null) : null;

  // ADX
  const adxResult = ADX.calculate({ period: ADX_PERIOD, high: highs, low: lows, close: closes });
  const lastAdx = adxResult.length > 0 ? adxResult[adxResult.length - 1] : undefined;
  const adx = lastAdx !== undefined ? lastAdx.adx : null;

  return { rsi, macd, bollingerBands, atr: atrVal, vwap, adx };
}

// --- Shared engine indicators ---

/** Simple Moving Average over closing prices. */
export function sma(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period) return NaN;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

/** Exponential Moving Average, SMA-seeded, over closing prices. */
export function ema(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period) return NaN;
  const mult = 2 / (period + 1);
  // Seed with SMA of first `period` candles (proper initialization)
  let val = 0;
  for (let i = 0; i < period; i++) val += candles[i].close;
  val /= period;
  for (let i = period; i < candles.length; i++) {
    val = candles[i].close * mult + val * (1 - mult);
  }
  return val;
}

/** Average True Range over the last `period` bars (requires period+1 candles). */
export function atr(candles: OhlcvCandle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** BTC regime filter: fast EMA > slow EMA = bullish. */
export function isBtcBullish(btcCandles: OhlcvCandle[], fastPeriod: number, slowPeriod: number): boolean {
  const emaFast = ema(btcCandles, fastPeriod);
  const emaSlow = ema(btcCandles, slowPeriod);
  if (isNaN(emaFast) || isNaN(emaSlow)) return false;
  return emaFast > emaSlow;
}

/** Donchian exit channel using CLOSES (not highs/lows) for trend-following exit. */
export function donchianExitChannel(candles: OhlcvCandle[], period: number): { high: number; low: number } {
  const slice = candles.slice(-period);
  let high = -Infinity;
  let low = Infinity;
  for (const c of slice) {
    if (c.close > high) high = c.close;
    if (c.close < low) low = c.close;
  }
  return { high, low };
}
