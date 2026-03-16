// IFT-RSI engine: Inverse Fisher Transform of RSI(7), PSAR trailing stop
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "ift-rsi" as const;
const LEVERAGE = 10;
const RSI_PERIOD = 7;
const IFT_LONG_THRESHOLD = 0.3;
const IFT_SHORT_THRESHOLD = -0.3;
const AF_START = 0.03;
const AF_STEP = 0.02;
const AF_MAX = 0.3;
const MAX_HOLD_MS = 80 * 60 * 60 * 1000;

function computeRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += Math.abs(delta);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeIFT(rsiValues: number[]): number[] {
  return rsiValues.map(r => {
    if (isNaN(r)) return NaN;
    const x = 0.1 * (r - 50);
    const e2x = Math.exp(2 * x);
    return (e2x - 1) / (e2x + 1);
  });
}

function computePSAR(candles: OhlcvCandle[]): { dir: number; sar: number } | null {
  if (candles.length < 10) return null;
  let dir = 1;
  let sar = candles[0].low;
  let ep = candles[0].high;
  let af = AF_START;

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    sar = sar + af * (ep - sar);

    if (dir === 1) {
      if (i >= 2) sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      if (l <= sar) {
        dir = -1; sar = ep; ep = l; af = AF_START;
      } else {
        if (h > ep) { ep = h; af = Math.min(af + AF_STEP, AF_MAX); }
      }
    } else {
      if (i >= 2) sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      if (h >= sar) {
        dir = 1; sar = ep; ep = h; af = AF_START;
      } else {
        if (l < ep) { ep = l; af = Math.min(af + AF_STEP, AF_MAX); }
      }
    }
  }
  return { dir, sar };
}

interface IftRsiSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

async function analyzeSignal(pair: string): Promise<IftRsiSignal | null> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < 20) return null;

  const closes = candles.map(c => c.close);
  const rsi = computeRSI(closes, RSI_PERIOD);
  const ift = computeIFT(rsi);

  const len = ift.length;
  if (len < 3) return null;

  // Bar i-1 cross detection (confirmed bar)
  const prev = ift[len - 3]; // bar i-2
  const curr = ift[len - 2]; // bar i-1
  if (isNaN(prev) || isNaN(curr)) return null;

  const psar = computePSAR(candles);
  if (!psar) return null;

  const entryPrice = candles[len - 1].open; // bar i open

  // Long: IFT crosses above +0.3
  if (prev <= IFT_LONG_THRESHOLD && curr > IFT_LONG_THRESHOLD) {
    return { pair, direction: "long", entryPrice, stopLoss: psar.sar };
  }
  // Short: IFT crosses below -0.3
  if (prev >= IFT_SHORT_THRESHOLD && curr < IFT_SHORT_THRESHOLD) {
    return { pair, direction: "short", entryPrice, stopLoss: psar.sar };
  }

  return null;
}

// Update PSAR stop for open positions (ratchet only)
async function updatePsarStops(): Promise<void> {
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.pair, "1h", 80);
      if (candles.length < 20) continue;
      const psar = computePSAR(candles);
      if (!psar) continue;

      if (pos.direction === "long" && psar.sar > (pos.stopLoss ?? 0)) {
        pos.stopLoss = psar.sar;
        const { saveQuantPosition } = await import("../database/quant.js");
        saveQuantPosition(pos);
      } else if (pos.direction === "short" && psar.sar < (pos.stopLoss ?? Infinity)) {
        pos.stopLoss = psar.sar;
        const { saveQuantPosition } = await import("../database/quant.js");
        saveQuantPosition(pos);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IFT] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runIftRsiCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const iftPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Max hold exits
  for (const pos of iftPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[IFT] Max hold exit: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "max-hold");
    }
  }

  // Update trailing PSAR stops
  await updatePsarStops();

  // New entries
  const currentPositions = getOpenQuantPositions();
  const openPairs = new Set(currentPositions.filter(p => p.tradeType === TRADE_TYPE).map(p => p.pair));
  let executed = 0;

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    try {
      const signal = await analyzeSignal(pair);
      if (!signal) continue;

      const position = await openPosition(
        pair, signal.direction, QUANT_FIXED_POSITION_SIZE_USD, LEVERAGE,
        signal.stopLoss, 0, "trending", TRADE_TYPE, undefined, signal.entryPrice,
      );

      if (position) {
        executed++;
        openPairs.add(pair);
        console.log(`[IFT] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SAR=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IFT] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
