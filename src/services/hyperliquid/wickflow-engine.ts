// WickFlow: wick-to-body pressure scoring over 6 bars (1h), fixed 16h hold
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "wickflow" as const;
const LEVERAGE = 10;
const SCORE_BARS = 6;
const SCORE_THRESHOLD = 1.5;
const HOLD_BARS = 16; // 16 × 1h = 16h
const HOLD_MS = HOLD_BARS * 60 * 60 * 1000;

function wickScore(candles: OhlcvCandle[]): number {
  let score = 0;
  for (const c of candles) {
    const body = Math.abs(c.close - c.open);
    if (body <= 0) continue;
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const buyPressure = lowerWick / body;
    const sellPressure = upperWick / body;
    score += buyPressure - sellPressure;
  }
  return score;
}

interface WickSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  score: number;
}

async function analyzeSignal(pair: string): Promise<WickSignal | null> {
  const candles = await fetchCandles(pair, "1h", 20);
  if (candles.length < SCORE_BARS + 2) return null;

  const last = candles.length - 1;
  // Confirmed bars: last N bars before current
  const scoreBars = candles.slice(last - SCORE_BARS, last);
  const score = wickScore(scoreBars);
  const currentOpen = candles[last].open;

  if (score > SCORE_THRESHOLD) return { pair, direction: "long", entryPrice: currentOpen, score };
  if (score < -SCORE_THRESHOLD) return { pair, direction: "short", entryPrice: currentOpen, score };
  return null;
}

export async function runWickflowCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const wfPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Time-based exits
  for (const pos of wfPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= HOLD_MS) {
      console.log(`[WickFlow] Hold exit: ${pos.pair} ${pos.direction} held ${(holdMs / 3600_000).toFixed(1)}h`);
      await closePosition(pos.id, `hold-exit (${(holdMs / 3600_000).toFixed(1)}h)`);
    }
  }

  // New entries
  const currentPositions = getOpenQuantPositions();
  const openPairs = new Set(currentPositions.filter(p => p.tradeType === TRADE_TYPE).map(p => p.pair));
  let executed = 0;

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    try {
      const signal = await analyzeSignal(pair);
      if (!signal) continue;

      // Dummy SL at 10% for risk gate
      const dummySL = signal.direction === "long"
        ? signal.entryPrice * 0.98
        : signal.entryPrice * 1.02;

      const position = await openPosition(
        pair, signal.direction, QUANT_FIXED_POSITION_SIZE_USD, LEVERAGE,
        dummySL, 0, "trending", TRADE_TYPE, undefined, signal.entryPrice,
      );

      if (position) {
        executed++;
        openPairs.add(pair);
        console.log(`[WickFlow] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} score=${signal.score.toFixed(2)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WickFlow] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
