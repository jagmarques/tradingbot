// SkewMR: return skewness mean-reversion on 2h bars (aggregated from 15m), fixed 96h hold
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "skew-mr" as const;
const LEVERAGE = 10;
const SKEW_BARS = 24; // 24 × 2h bars
const SKEW_THRESHOLD = 0.5;
const HOLD_BARS = 48; // 48 × 2h = 96h
const HOLD_MS = HOLD_BARS * 2 * 60 * 60 * 1000;
const AGG_FACTOR = 8; // 8 × 15m = 2h

/** Aggregate 15m candles into 2h bars */
function aggregate2h(candles15m: OhlcvCandle[]): OhlcvCandle[] {
  const bars: OhlcvCandle[] = [];
  for (let i = 0; i + AGG_FACTOR <= candles15m.length; i += AGG_FACTOR) {
    const chunk = candles15m.slice(i, i + AGG_FACTOR);
    bars.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
      trades: chunk.reduce((s, c) => s + c.trades, 0),
    });
  }
  return bars;
}

function computeSkewness(bars: OhlcvCandle[]): number | null {
  if (bars.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close <= 0) continue;
    returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  }
  if (returns.length < 3) return null;

  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std <= 0) return null;

  const m3 = returns.reduce((s, r) => s + ((r - mean) / std) ** 3, 0) / n;
  return m3;
}

interface SkewSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  skewness: number;
}

async function analyzeSignal(pair: string): Promise<SkewSignal | null> {
  const candles15m = await fetchCandles(pair, "15m", 200);
  const bars2h = aggregate2h(candles15m);
  if (bars2h.length < SKEW_BARS + 2) return null;

  const last = bars2h.length - 1;
  // Use confirmed bars (exclude current incomplete bar)
  const window = bars2h.slice(last - SKEW_BARS, last);
  const skew = computeSkewness(window);
  if (skew === null) return null;

  const currentOpen = bars2h[last].open;

  // Positive skew = rally exhaustion -> short; negative skew = bounce -> long
  if (skew > SKEW_THRESHOLD) return { pair, direction: "short", entryPrice: currentOpen, skewness: skew };
  if (skew < -SKEW_THRESHOLD) return { pair, direction: "long", entryPrice: currentOpen, skewness: skew };
  return null;
}

export async function runSkewMrCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const skewPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Time-based exits
  for (const pos of skewPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= HOLD_MS) {
      console.log(`[SkewMR] Hold exit: ${pos.pair} ${pos.direction} held ${(holdMs / 3600_000).toFixed(1)}h`);
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
        console.log(`[SkewMR] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} skew=${signal.skewness.toFixed(3)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SkewMR] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
