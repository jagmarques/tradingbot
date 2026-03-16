import { EMA, ATR } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { saveQuantPosition } from "../database/quant.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "dtf-mr" as const;
const LEVERAGE = 10;

// Chandelier 1h: EMA(8) cross, trail = HH - 4×ATR(14)
const EMA_PERIOD = 8;
const ATR_PERIOD = 14;
const CHAN_MULT = 4;
const HARD_SL_PCT = 0.04;
const MAX_HOLD_MS = 80 * 45 * 60 * 1000;

function computeEma(candles: OhlcvCandle[]): number[] {
  const closes = candles.map(c => c.close);
  return EMA.calculate({ period: EMA_PERIOD, values: closes });
}

function computeAtr(candles: OhlcvCandle[]): number[] {
  return ATR.calculate({
    period: ATR_PERIOD,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
}

interface ChanSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  emaValue: number;
}

async function analyzeSignal(pair: string): Promise<ChanSignal | null> {
  // Use 1h candles directly (best backtest: $19.48/d with trail3/2)
  const cs = await fetchCandles(pair, "1h", 80);
  if (cs.length < EMA_PERIOD + ATR_PERIOD + 3) return null;

  const emaVals = computeEma(cs);
  const atrVals = computeAtr(cs);
  if (emaVals.length < 3 || atrVals.length < 2) return null;

  const emaOff = cs.length - emaVals.length;
  const atrOff = cs.length - atrVals.length;

  const last = cs.length - 1;
  const prevClose = cs[last - 1].close;
  const prev2Close = cs[last - 2].close;
  const emaLast = emaVals[last - 1 - emaOff];
  const emaPrev = emaVals[last - 2 - emaOff];
  const atrLast = atrVals[last - 1 - atrOff];

  if (emaLast === undefined || emaPrev === undefined || atrLast === undefined) return null;

  const crossUp = prevClose > emaLast && prev2Close <= emaPrev;
  const crossDn = prevClose < emaLast && prev2Close >= emaPrev;
  const currentOpen = cs[last].open;

  if (crossUp) {
    const recentHighs = cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.high);
    const hh = Math.max(...recentHighs);
    const chanStop = hh - CHAN_MULT * atrLast;
    const hardStop = currentOpen * (1 - HARD_SL_PCT);
    const sl = Math.max(chanStop, hardStop);
    // Don't open if current price already below stop
    if (cs[last].close < sl) return null;
    return { pair, direction: "long", entryPrice: currentOpen, stopLoss: sl, emaValue: emaLast };
  }

  if (crossDn) {
    const recentLows = cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low);
    const ll = Math.min(...recentLows);
    const chanStop = ll + CHAN_MULT * atrLast;
    const hardStop = currentOpen * (1 + HARD_SL_PCT);
    const sl = Math.min(chanStop, hardStop);
    if (cs[last].close > sl) return null;
    return { pair, direction: "short", entryPrice: currentOpen, stopLoss: sl, emaValue: emaLast };
  }

  return null;
}

export async function updateChandelierStops(): Promise<void> {
  const positions = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
  for (const pos of positions) {
    try {
      const cs = await fetchCandles(pos.pair, "1h", 80);
      if (cs.length < 30) continue;
      const atrVals = computeAtr(cs);
      if (atrVals.length < 1) continue;

      const last = cs.length - 1;
      const atrOff = cs.length - atrVals.length;
      const atr = atrVals[last - 1 - atrOff];
      if (atr === undefined) continue;

      if (pos.direction === "long") {
        const hh = Math.max(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.high));
        const newStop = hh - CHAN_MULT * atr;
        if (pos.stopLoss && newStop > pos.stopLoss) {
          console.log(`[Chandelier] Trail up ${pos.pair} SL ${pos.stopLoss.toFixed(2)} -> ${newStop.toFixed(2)}`);
          pos.stopLoss = newStop;
          saveQuantPosition(pos);
        }
      } else {
        const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low));
        const newStop = ll + CHAN_MULT * atr;
        if (pos.stopLoss && newStop < pos.stopLoss) {
          console.log(`[Chandelier] Trail dn ${pos.pair} SL ${pos.stopLoss.toFixed(2)} -> ${newStop.toFixed(2)}`);
          pos.stopLoss = newStop;
          saveQuantPosition(pos);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Chandelier] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runDtfMrCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const chanPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  for (const pos of chanPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[Chandelier] Max hold exit: ${pos.pair} ${pos.direction} held ${(holdMs / 3600_000).toFixed(1)}h`);
      await closePosition(pos.id, `max-hold (${(holdMs / 3600_000).toFixed(1)}h)`);
    }
  }

  await updateChandelierStops();

  const currentPositions = getOpenQuantPositions();
  const openPairs = new Set(
    currentPositions.filter(p => p.tradeType === TRADE_TYPE).map(p => p.pair),
  );

  let executed = 0;

  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;

    try {
      const signal = await analyzeSignal(pair);
      if (!signal) continue;

      const position = await openPosition(
        pair,
        signal.direction,
        QUANT_FIXED_POSITION_SIZE_USD,
        LEVERAGE,
        signal.stopLoss,
        0,
        "trending",
        TRADE_TYPE,
        undefined,
        signal.entryPrice,
      );

      if (position) {
        executed++;
        openPairs.add(pair);
        console.log(
          `[Chandelier] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(2)} EMA=${signal.emaValue.toFixed(2)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Chandelier] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}

// No-op: stops handled by position monitor
export async function checkDtfMrSignalExit(_positionId: string, _pair: string, _direction: "long" | "short"): Promise<boolean> {
  return false;
}
