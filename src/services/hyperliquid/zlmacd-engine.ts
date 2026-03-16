// Zero Lag MACD engine: DEMA(5)-DEMA(13) with EMA(9) signal, PSAR trailing stop
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "zl-macd" as const;
const LEVERAGE = 10;
const DEMA_FAST = 5;
const DEMA_SLOW = 13;
const SIGNAL_PERIOD = 9;
const AF_START = 0.03;
const AF_STEP = 0.02;
const AF_MAX = 0.3;
const MAX_HOLD_MS = 80 * 60 * 60 * 1000;

function computeEMA(values: number[], period: number): number[] {
  const ema: number[] = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);

  // Find first valid value
  let sum = 0;
  let count = 0;
  let startIdx = -1;
  for (let i = 0; i < values.length && count < period; i++) {
    if (!isNaN(values[i])) {
      sum += values[i];
      count++;
      if (count === period) startIdx = i;
    }
  }
  if (startIdx < 0) return ema;

  ema[startIdx] = sum / period;
  for (let i = startIdx + 1; i < values.length; i++) {
    if (isNaN(values[i])) { ema[i] = ema[i - 1]; continue; }
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function computeDEMA(values: number[], period: number): number[] {
  const ema1 = computeEMA(values, period);
  const ema2 = computeEMA(ema1, period);
  return ema1.map((v, i) => {
    if (isNaN(v) || isNaN(ema2[i])) return NaN;
    return 2 * v - ema2[i];
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

interface ZlMacdSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

async function analyzeSignal(pair: string): Promise<ZlMacdSignal | null> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const demaFast = computeDEMA(closes, DEMA_FAST);
  const demaSlow = computeDEMA(closes, DEMA_SLOW);

  // ZLMACD line
  const zlmacd: number[] = demaFast.map((v, i) => {
    if (isNaN(v) || isNaN(demaSlow[i])) return NaN;
    return v - demaSlow[i];
  });

  // Signal line = EMA(9) of ZLMACD
  const signal = computeEMA(zlmacd, SIGNAL_PERIOD);

  const len = candles.length;
  if (len < 3) return null;

  // Bar i-1 cross detection (confirmed bar)
  const prevMacd = zlmacd[len - 3];
  const currMacd = zlmacd[len - 2];
  const prevSig = signal[len - 3];
  const currSig = signal[len - 2];
  if (isNaN(prevMacd) || isNaN(currMacd) || isNaN(prevSig) || isNaN(currSig)) return null;

  const psar = computePSAR(candles);
  if (!psar) return null;

  const entryPrice = candles[len - 1].open; // bar i open

  // Long: ZLMACD crosses above signal
  if (prevMacd <= prevSig && currMacd > currSig) {
    return { pair, direction: "long", entryPrice, stopLoss: psar.sar };
  }
  // Short: ZLMACD crosses below signal
  if (prevMacd >= prevSig && currMacd < currSig) {
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
      console.error(`[ZL] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runZlMacdCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const zlPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Max hold exits
  for (const pos of zlPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[ZL] Max hold exit: ${pos.pair} ${pos.direction}`);
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
        console.log(`[ZL] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SAR=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ZL] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
