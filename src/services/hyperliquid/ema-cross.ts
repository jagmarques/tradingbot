// EMA cross engine: 1h EMA(25)/EMA(40), signal exit on reverse cross, max hold 150 bars
import { EMA } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";

const TRADE_TYPE = "ema-cross" as const;
const LEVERAGE = 10;
const FAST_PERIOD = 25;
const SLOW_PERIOD = 40;
const MAX_HOLD_MS = 150 * 60 * 60 * 1000; // 150 1h bars = 6.25 days

interface EmaCrossSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  fastEma: number;
  slowEma: number;
}

async function analyzeSignal(pair: string): Promise<EmaCrossSignal | null> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < SLOW_PERIOD + 3) return null;

  const closes = candles.map(c => c.close);
  const fastVals = EMA.calculate({ period: FAST_PERIOD, values: closes });
  const slowVals = EMA.calculate({ period: SLOW_PERIOD, values: closes });
  if (fastVals.length < 3 || slowVals.length < 3) return null;

  const fOff = closes.length - fastVals.length;
  const sOff = closes.length - slowVals.length;
  const last = closes.length - 1;

  // Cross on bar last-1 vs last-2 (confirmed), enter at current bar open
  const fPrev = fastVals[last - 1 - fOff];
  const sPrev = slowVals[last - 1 - sOff];
  const fPrev2 = fastVals[last - 2 - fOff];
  const sPrev2 = slowVals[last - 2 - sOff];
  if (fPrev === undefined || sPrev === undefined || fPrev2 === undefined || sPrev2 === undefined) return null;

  const crossUp = fPrev > sPrev && fPrev2 <= sPrev2;
  const crossDn = fPrev < sPrev && fPrev2 >= sPrev2;
  const currentOpen = candles[last].open;

  if (crossUp) return { pair, direction: "long", entryPrice: currentOpen, fastEma: fPrev, slowEma: sPrev };
  if (crossDn) return { pair, direction: "short", entryPrice: currentOpen, fastEma: fPrev, slowEma: sPrev };
  return null;
}

async function checkSignalExit(pair: string, direction: "long" | "short"): Promise<boolean> {
  const candles = await fetchCandles(pair, "1h", 80);
  if (candles.length < SLOW_PERIOD + 3) return false;

  const closes = candles.map(c => c.close);
  const fastVals = EMA.calculate({ period: FAST_PERIOD, values: closes });
  const slowVals = EMA.calculate({ period: SLOW_PERIOD, values: closes });
  if (fastVals.length < 3 || slowVals.length < 3) return false;

  const fOff = closes.length - fastVals.length;
  const sOff = closes.length - slowVals.length;
  const last = closes.length - 1;

  const fPrev = fastVals[last - 1 - fOff]!;
  const sPrev = slowVals[last - 1 - sOff]!;
  const fPrev2 = fastVals[last - 2 - fOff]!;
  const sPrev2 = slowVals[last - 2 - sOff]!;

  const flipUp = fPrev > sPrev && fPrev2 <= sPrev2;
  const flipDn = fPrev < sPrev && fPrev2 >= sPrev2;

  return (direction === "long" && flipDn) || (direction === "short" && flipUp);
}

export async function runEmaCrossCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const emaPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Time + signal exits
  for (const pos of emaPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[EmaCross] Max hold exit: ${pos.pair} ${pos.direction} held ${(holdMs / 3600_000).toFixed(1)}h`);
      await closePosition(pos.id, `max-hold (${(holdMs / 3600_000).toFixed(1)}h)`);
      continue;
    }
    try {
      const shouldExit = await checkSignalExit(pos.pair, pos.direction);
      if (shouldExit) {
        console.log(`[EmaCross] Signal exit: ${pos.pair} ${pos.direction} (reverse cross)`);
        await closePosition(pos.id, "ema-cross-flip");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[EmaCross] Exit check error ${pos.pair}: ${msg}`);
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

      // Dummy SL at 10% — actual exit is signal-based
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
        console.log(`[EmaCross] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} F=${signal.fastEma.toFixed(2)} S=${signal.slowEma.toFixed(2)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[EmaCross] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
