// ZLEMA(3) cross entry + Chandelier m6 exit
import { EMA, ATR } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { saveQuantPosition } from "../database/quant.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "zlema-chan" as const;
const LEVERAGE = 10;
const ZLEMA_PERIOD = 3;
const ATR_PERIOD = 14;
const CHAN_MULT = 6;
const MAX_HOLD_MS = 80 * 60 * 60 * 1000;

function computeAtr(candles: OhlcvCandle[]): number[] {
  return ATR.calculate({
    period: ATR_PERIOD,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
}

// ZLEMA = 2*EMA(closes, p) - EMA(EMA(closes, p), p)
function computeZlema(candles: OhlcvCandle[]): number[] {
  const closes = candles.map(c => c.close);
  const e1 = EMA.calculate({ period: ZLEMA_PERIOD, values: closes });
  const e2 = EMA.calculate({ period: ZLEMA_PERIOD, values: e1 });
  const offset = e1.length - e2.length;
  return e2.map((v, i) => 2 * e1[i + offset] - v);
}

interface ZlemaSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

async function analyzeSignal(pair: string): Promise<ZlemaSignal | null> {
  const cs = await fetchCandles(pair, "1h", 80);
  if (cs.length < 20) return null;

  const zlema = computeZlema(cs);
  const atrVals = computeAtr(cs);
  if (zlema.length < 3 || atrVals.length < 2) return null;

  const last = cs.length - 1;
  const zOff = cs.length - zlema.length;
  const atrOff = cs.length - atrVals.length;
  const atr = atrVals[last - 1 - atrOff];
  if (atr === undefined) return null;

  const prevClose = cs[last - 1].close;
  const prev2Close = cs[last - 2].close;
  const zLast = zlema[last - 1 - zOff];
  const zPrev = zlema[last - 2 - zOff];
  if (zLast === undefined || zPrev === undefined) return null;

  const crossUp = prevClose > zLast && prev2Close <= zPrev;
  const crossDn = prevClose < zLast && prev2Close >= zPrev;

  if (!crossUp && !crossDn) return null;

  const entryPrice = cs[last].open;

  if (crossUp) {
    const hh = Math.max(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.high));
    const sl = hh - CHAN_MULT * atr;
    if (sl >= entryPrice) return null;
    return { pair, direction: "long", entryPrice, stopLoss: sl };
  }

  if (crossDn) {
    const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low));
    const sl = ll + CHAN_MULT * atr;
    if (sl <= entryPrice) return null;
    return { pair, direction: "short", entryPrice, stopLoss: sl };
  }

  return null;
}

async function updateChanStops(): Promise<void> {
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
        if (pos.stopLoss && newStop > pos.stopLoss) { pos.stopLoss = newStop; saveQuantPosition(pos); }
      } else {
        const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low));
        const newStop = ll + CHAN_MULT * atr;
        if (pos.stopLoss && newStop < pos.stopLoss) { pos.stopLoss = newStop; saveQuantPosition(pos); }
      }
    } catch (err) {
      console.error(`[ZLEMA] Stop update error ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function runZlemaChanCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  for (const pos of myPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[ZLEMA] Max hold exit: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "max-hold");
    }
  }

  await updateChanStops();

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
        console.log(`[ZLEMA] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      console.error(`[ZLEMA] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return executed;
}
