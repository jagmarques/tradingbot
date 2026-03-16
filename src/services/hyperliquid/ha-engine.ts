// Heikin Ashi entry + Parabolic SAR exit engine (1h candles)
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { saveQuantPosition } from "../database/quant.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "ha-psar" as const;
const LEVERAGE = 10;
const AF_START = 0.03;
const AF_STEP = 0.02;
const AF_MAX = 0.3;
const MAX_HOLD_MS = 80 * 60 * 60 * 1000; // 80 bars * 1h

interface HaBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

// Compute Heikin Ashi candles from real OHLCV
function computeHA(candles: OhlcvCandle[]): HaBar[] {
  if (candles.length === 0) return [];
  const ha: HaBar[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0
      ? (c.open + c.close) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }
  return ha;
}

// PSAR on REAL candles, parameterized
function computePSAR(
  candles: OhlcvCandle[],
  afStart = AF_START, afStep = AF_STEP, afMax = AF_MAX,
): { dir: number; sar: number } | null {
  if (candles.length < 10) return null;
  let dir = 1;
  let sar = candles[0].low;
  let ep = candles[0].high;
  let af = afStart;

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    sar = sar + af * (ep - sar);

    if (dir === 1) {
      if (i >= 2) sar = Math.min(sar, candles[i - 1].low, candles[i - 2].low);
      if (l <= sar) {
        dir = -1; sar = ep; ep = l; af = afStart;
      } else {
        if (h > ep) { ep = h; af = Math.min(af + afStep, afMax); }
      }
    } else {
      if (i >= 2) sar = Math.max(sar, candles[i - 1].high, candles[i - 2].high);
      if (h >= sar) {
        dir = 1; sar = ep; ep = h; af = afStart;
      } else {
        if (l < ep) { ep = l; af = Math.min(af + afStep, afMax); }
      }
    }
  }
  return { dir, sar };
}

interface HaSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

// HA color flip detection (c1 = enter immediately on flip)
async function analyzeSignal(pair: string): Promise<HaSignal | null> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < 20) return null;

  const ha = computeHA(candles);
  const last = ha.length - 1;

  // HA color flip: bar i-2 vs bar i-1, enter at bar i open
  const sigGreen = ha[last - 1].close >= ha[last - 1].open;
  const sigRed = ha[last - 1].close < ha[last - 1].open;
  const prev2Green = ha[last - 2].close >= ha[last - 2].open;
  const prev2Red = ha[last - 2].close < ha[last - 2].open;

  // Flip: prev2 was opposite color, prev1 is new color
  const flipLong = prev2Red && sigGreen;
  const flipShort = prev2Green && sigRed;

  if (!flipLong && !flipShort) return null;

  // PSAR stop on real candles
  const psar = computePSAR(candles);
  if (!psar) return null;

  const entryPrice = candles[candles.length - 1].open;
  const stopLoss = psar.sar;

  if (flipLong) {
    // Validate stop below entry
    if (stopLoss >= entryPrice) return null;
    return { pair, direction: "long", entryPrice, stopLoss };
  }
  if (flipShort) {
    // Validate stop above entry
    if (stopLoss <= entryPrice) return null;
    return { pair, direction: "short", entryPrice, stopLoss };
  }
  return null;
}

// Update PSAR-based trailing stop for open HA positions
async function updateHaPsarStops(): Promise<void> {
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.pair, "1h", 80);
      if (candles.length < 20) continue;
      const psar = computePSAR(candles);
      if (!psar) continue;

      // Only ratchet toward price (tighten stop)
      if (pos.direction === "long" && psar.sar > (pos.stopLoss ?? 0)) {
        pos.stopLoss = psar.sar;
        saveQuantPosition(pos);
      } else if (pos.direction === "short" && psar.sar < (pos.stopLoss ?? Infinity)) {
        pos.stopLoss = psar.sar;
        saveQuantPosition(pos);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HA] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runHaCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const haPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Max hold exits
  for (const pos of haPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[HA] Max hold exit: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "max-hold");
    }
  }

  // Update PSAR stops
  await updateHaPsarStops();

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
        console.log(`[HA] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SAR=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HA] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
