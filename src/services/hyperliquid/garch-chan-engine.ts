// GARCH-inspired volatility-adjusted momentum entry + Chandelier m6 exit
import { ATR } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { saveQuantPosition } from "../database/quant.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "garch-chan" as const;
const LEVERAGE = parseInt(process.env.LEVERAGE!);
const ATR_PERIOD = 14;
const CHAN_MULT = 6;
const MAX_HOLD_MS = 48 * 60 * 60 * 1000;
const GARCH_LOOKBACK = 3; // momentum lookback
const GARCH_VOL_WINDOW = 20; // rolling stddev window
const GARCH_THRESHOLD = 0.7; // z-score threshold

function computeAtr(candles: OhlcvCandle[]): number[] {
  return ATR.calculate({
    period: ATR_PERIOD,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
}

interface GarchSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

async function analyzeSignal(pair: string): Promise<GarchSignal | null> {
  const cs = await fetchCandles(pair, "1h", 80);
  if (cs.length < 30) return null;

  const atrVals = computeAtr(cs);
  if (atrVals.length < 2) return null;

  const last = cs.length - 1;
  const atrOff = cs.length - atrVals.length;
  const atr = atrVals[last - 1 - atrOff];
  if (atr === undefined) return null;

  // Momentum: return over GARCH_LOOKBACK bars
  const mom = cs[last - 1].close / cs[last - 1 - GARCH_LOOKBACK].close - 1;

  // Rolling volatility: stddev of 1-bar returns over GARCH_VOL_WINDOW
  const returns: number[] = [];
  for (let i = last - GARCH_VOL_WINDOW; i < last; i++) {
    if (i < 1) continue;
    returns.push(cs[i].close / cs[i - 1].close - 1);
  }
  if (returns.length < 10) return null;
  const vol = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  if (vol === 0) return null;

  // Z-score: momentum / volatility
  const z = mom / vol;

  const goLong = z > GARCH_THRESHOLD;
  const goShort = z < -GARCH_THRESHOLD;

  if (!goLong && !goShort) return null;

  const entryPrice = cs[last].open;

  const MIN_SL_DIST_PCT = 0.01; // skip if stop < 1% from entry

  if (goLong) {
    const hh = Math.max(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.high));
    const sl = hh - CHAN_MULT * atr;
    if (sl >= entryPrice) return null;
    if ((entryPrice - sl) / entryPrice < MIN_SL_DIST_PCT) return null;
    return { pair, direction: "long", entryPrice, stopLoss: sl };
  }

  if (goShort) {
    const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low));
    const sl = ll + CHAN_MULT * atr;
    if (sl <= entryPrice) return null;
    if ((sl - entryPrice) / entryPrice < MIN_SL_DIST_PCT) return null;
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
      console.error(`[GARCH] Stop update error ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function runGarchChanCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  for (const pos of myPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[GARCH] Max hold exit: ${pos.pair} ${pos.direction}`);
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
      // TP at 1.8% price move (= 18% P&L at 10x leverage)
      const tpPct = 0.018;
      const tp = signal.direction === "long"
        ? signal.entryPrice * (1 + tpPct)
        : signal.entryPrice * (1 - tpPct);
      const position = await openPosition(
        pair, signal.direction, QUANT_FIXED_POSITION_SIZE_USD, LEVERAGE,
        signal.stopLoss, tp, "trending", TRADE_TYPE, undefined, signal.entryPrice,
      );
      if (position) {
        executed++;
        openPairs.add(pair);
        console.log(`[GARCH] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      console.error(`[GARCH] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return executed;
}
