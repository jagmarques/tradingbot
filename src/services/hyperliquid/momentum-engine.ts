// 4h Momentum: enter on N-bar return threshold, fixed hold exit
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";

const TRADE_TYPE = "mom-4h" as const;
const LEVERAGE = 10;
const LOOKBACK = 8; // 8 bars of 4h = 32 hours
const HOLD_BARS = 8; // 8 bars of 4h = 32 hours
const THRESHOLD = 0.02; // 2% return threshold
const HOLD_MS = HOLD_BARS * 4 * 60 * 60 * 1000;

interface MomSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  returnPct: number;
}

async function analyzeSignal(pair: string): Promise<MomSignal | null> {
  const candles = await fetchCandles(pair, "4h", 20);
  if (candles.length < LOOKBACK + 3) return null;

  const last = candles.length - 1;
  const prevClose = candles[last - 1].close;
  const lbClose = candles[last - 1 - LOOKBACK].close;
  if (lbClose <= 0) return null;

  const ret = (prevClose - lbClose) / lbClose;
  const currentOpen = candles[last].open;

  if (ret > THRESHOLD) return { pair, direction: "long", entryPrice: currentOpen, returnPct: ret };
  if (ret < -THRESHOLD) return { pair, direction: "short", entryPrice: currentOpen, returnPct: ret };
  return null;
}

export async function runMomentumCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const momPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Time-based exits
  for (const pos of momPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= HOLD_MS) {
      console.log(`[Mom4h] Hold exit: ${pos.pair} ${pos.direction} held ${(holdMs / 3600_000).toFixed(1)}h`);
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

      const dummySL = signal.direction === "long"
        ? signal.entryPrice * 0.90
        : signal.entryPrice * 1.10;

      const position = await openPosition(
        pair, signal.direction, QUANT_FIXED_POSITION_SIZE_USD, LEVERAGE,
        dummySL, 0, "trending", TRADE_TYPE, undefined, signal.entryPrice,
      );

      if (position) {
        executed++;
        openPairs.add(pair);
        console.log(`[Mom4h] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} ret=${(signal.returnPct * 100).toFixed(1)}%`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Mom4h] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
