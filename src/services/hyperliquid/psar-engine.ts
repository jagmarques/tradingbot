// Parabolic SAR engine: 1h candles, af0.03/0.02/0.3, ATR-based hard stop
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "psar" as const;
const LEVERAGE = 10;
const AF_START = 0.03;
const AF_STEP = 0.02;
const AF_MAX = 0.3;
const MAX_HOLD_MS = 80 * 60 * 60 * 1000;

interface PsarSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

function computePSAR(candles: OhlcvCandle[]): { dir: number; sar: number; prevDir: number; prevSar: number } | null {
  if (candles.length < 10) return null;
  let dir = 1;
  let sar = candles[0].low;
  let ep = candles[0].high;
  let af = AF_START;
  let prevDir = dir;
  let prevSar = sar;

  for (let i = 1; i < candles.length; i++) {
    prevDir = dir;
    prevSar = sar;
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
  return { dir, sar, prevDir, prevSar };
}

async function analyzeSignal(pair: string): Promise<PsarSignal | null> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < 20) return null;

  // Compute PSAR on candles up to last-1 (confirmed), detect flip
  const prev = computePSAR(candles.slice(0, -1));
  const curr = computePSAR(candles);
  if (!prev || !curr) return null;

  // Flip detection: direction changed
  if (curr.dir === prev.dir) return null;

  const currentOpen = candles[candles.length - 1].open;
  const stopLoss = curr.sar;

  if (curr.dir === 1) {
    return { pair, direction: "long", entryPrice: currentOpen, stopLoss };
  } else {
    return { pair, direction: "short", entryPrice: currentOpen, stopLoss };
  }
}

// Update PSAR stop for open positions
async function updatePsarStops(): Promise<void> {
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.pair, "1h", 80);
      if (candles.length < 20) continue;
      const psar = computePSAR(candles);
      if (!psar) continue;

      // Only update if PSAR is tighter (ratchets toward price)
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
      console.error(`[PSAR] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runPsarCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const psarPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Max hold exits
  for (const pos of psarPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[PSAR] Max hold exit: ${pos.pair} ${pos.direction}`);
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
        console.log(`[PSAR] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SAR=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PSAR] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
