// HA entry + Chandelier exit engine: HA color flip entry, ATR-based trailing stop
import { ATR } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_FIXED_POSITION_SIZE_USD, QUANT_TRADING_PAIRS } from "../../config/constants.js";
import { saveQuantPosition } from "../database/quant.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "ha-chan" as const;
const LEVERAGE = 10;
const ATR_PERIOD = 14;
const CHAN_MULT = 6;
const MAX_HOLD_MS = 60 * 60 * 60 * 1000;

interface HaBar { open: number; close: number; }

function computeHA(candles: OhlcvCandle[]): HaBar[] {
  const ha: HaBar[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0
      ? (c.open + c.close) / 2
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({ open: haOpen, close: haClose });
  }
  return ha;
}

function computeAtr(candles: OhlcvCandle[]): number[] {
  return ATR.calculate({
    period: ATR_PERIOD,
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
}

interface HaChanSignal {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
}

async function analyzeSignal(pair: string): Promise<HaChanSignal | null> {
  const cs = await fetchCandles(pair, "1h", 80);
  if (cs.length < 20) return null;

  const ha = computeHA(cs);
  const atrVals = computeAtr(cs);
  if (atrVals.length < 2) return null;

  const last = cs.length - 1;
  const atrOff = cs.length - atrVals.length;
  const atr = atrVals[last - 1 - atrOff];
  if (atr === undefined) return null;

  // HA flip: bar i-2 opposite color from bar i-1, enter at bar i open
  const g1 = ha[last - 1].close >= ha[last - 1].open;
  const g2 = ha[last - 2].close >= ha[last - 2].open;
  const flipLong = !g2 && g1;
  const flipShort = g2 && !g1;

  if (!flipLong && !flipShort) return null;

  const entryPrice = cs[last].open;

  if (flipLong) {
    const recentHighs = cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.high);
    const hh = Math.max(...recentHighs);
    const sl = hh - CHAN_MULT * atr;
    if (sl >= entryPrice) return null;
    return { pair, direction: "long", entryPrice, stopLoss: sl };
  }

  if (flipShort) {
    const recentLows = cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low);
    const ll = Math.min(...recentLows);
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
        if (pos.stopLoss && newStop > pos.stopLoss) {
          pos.stopLoss = newStop;
          saveQuantPosition(pos);
        }
      } else {
        const ll = Math.min(...cs.slice(Math.max(0, last - ATR_PERIOD), last).map(c => c.low));
        const newStop = ll + CHAN_MULT * atr;
        if (pos.stopLoss && newStop < pos.stopLoss) {
          pos.stopLoss = newStop;
          saveQuantPosition(pos);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HAChan] Stop update error ${pos.pair}: ${msg}`);
    }
  }
}

export async function runHaChanCycle(): Promise<number> {
  const openPositions = getOpenQuantPositions();
  const hcPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);

  // Max hold exits
  for (const pos of hcPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    if (holdMs >= MAX_HOLD_MS) {
      console.log(`[HAChan] Max hold exit: ${pos.pair} ${pos.direction}`);
      await closePosition(pos.id, "max-hold");
    }
  }

  // Update Chandelier stops
  await updateChanStops();

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
        console.log(`[HAChan] Opened ${pair} ${signal.direction} $${QUANT_FIXED_POSITION_SIZE_USD} @${signal.entryPrice.toFixed(2)} SL=${signal.stopLoss.toFixed(4)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HAChan] Error ${pair}: ${msg}`);
    }
  }

  return executed;
}
