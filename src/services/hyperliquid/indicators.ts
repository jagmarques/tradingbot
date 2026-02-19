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
  const atr = atrResult.length > 0 ? (atrResult[atrResult.length - 1] ?? null) : null;

  // VWAP
  const vwapResult = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
  const vwap = vwapResult.length > 0 ? (vwapResult[vwapResult.length - 1] ?? null) : null;

  // ADX
  const adxResult = ADX.calculate({ period: ADX_PERIOD, high: highs, low: lows, close: closes });
  const lastAdx = adxResult.length > 0 ? adxResult[adxResult.length - 1] : undefined;
  const adx = lastAdx !== undefined ? lastAdx.adx : null;

  return { rsi, macd, bollingerBands, atr, vwap, adx };
}
