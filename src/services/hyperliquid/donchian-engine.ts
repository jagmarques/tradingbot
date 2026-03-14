import { calculateQuantPositionSize } from "./kelly.js";
import type { PairAnalysis, QuantAIDecision } from "./types.js";
import { DON_ATR_MULT, DON_CANDLES_NEEDED } from "../../config/constants.js";

interface DonVariant {
  tradeType: string;
  lb: number;
  ex: number;
  ep: number;
}

const VARIANTS: DonVariant[] = [
  { tradeType: "don-4h-a", lb: 12, ex: 10, ep: 10 },
  { tradeType: "don-4h-b", lb: 12, ex: 10, ep: 15 },
  { tradeType: "don-4h-c", lb: 10, ex: 8, ep: 10 },
  { tradeType: "don-4h-d", lb: 10, ex: 8, ep: 15 },
];

function computeEma(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
  return out;
}

function computeAtr(candles: Array<{ high: number; low: number; close: number }>, period = 14): number {
  let atr = 0;
  let prev = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev));
    prev = candles[i].close;
    atr = i < period ? tr : (atr * (period - 1) + tr) / period;
  }
  return atr || candles[candles.length - 1].close * 0.03;
}

// Returns entry signal for a single variant on a single pair.
// Signal bar = candles[n-1] (last completed bar). EMA filter uses candles[n-2].
// Entry at markPrice (scheduled 0–15min after signal bar closed).
function evalVariant(
  pair: string,
  markPrice: number,
  regime: string,
  candles4h: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number; trades: number }>,
  variant: DonVariant,
): QuantAIDecision | null {
  const n = candles4h.length;
  if (n < variant.lb + 3) return null;

  const closes = candles4h.map((c) => c.close);
  const em = computeEma(closes, variant.ep);
  const atr = computeAtr(candles4h);

  // Signal bar = last completed bar (index n-1)
  // EMA filter uses bar[n-2] (previous bar) to avoid look-ahead
  const sigBar = candles4h[n - 1];
  const prevClose = closes[n - 2];
  const prevEma = em[n - 2];
  const abv = prevClose > prevEma;

  // Breakout: sigBar.high > max high of the lb bars BEFORE sigBar
  let prevHigh = -Infinity;
  let prevLow = Infinity;
  for (let j = n - 1 - variant.lb; j < n - 1; j++) {
    if (candles4h[j].high > prevHigh) prevHigh = candles4h[j].high;
    if (candles4h[j].low < prevLow) prevLow = candles4h[j].low;
  }

  let direction: "long" | "short" | null = null;
  if (sigBar.high > prevHigh && abv) direction = "long";
  else if (sigBar.low < prevLow && !abv) direction = "short";
  if (!direction) return null;

  const stopLoss = direction === "long" ? markPrice - atr * DON_ATR_MULT : markPrice + atr * DON_ATR_MULT;
  const sizeUsd = calculateQuantPositionSize(70, markPrice, stopLoss, variant.tradeType as never);

  console.log(`[DonchianEngine] ${variant.tradeType} ${pair}: ${direction} — entry=${markPrice.toFixed(4)} SL=${stopLoss.toFixed(4)} ATR=${atr.toFixed(4)}`);

  return {
    pair,
    direction,
    entryPrice: markPrice,
    stopLoss,
    takeProfit: 0,
    confidence: 70,
    reasoning: `Don4h lb=${variant.lb} ex=${variant.ex} ema=${variant.ep}: ${direction} breakout. ATR=${atr.toFixed(4)}`,
    regime: regime as never,
    suggestedSizeUsd: sizeUsd,
    analyzedAt: new Date().toISOString(),
  };
}

export interface DonchianEngineOutput {
  tradeType: string;
  decisions: QuantAIDecision[];
  exitPairs: Map<string, number>; // pair -> last completed 4h bar timestamp
}

export function runDonchianEngine(
  analyses: PairAnalysis[],
): DonchianEngineOutput[] {
  return VARIANTS.map((variant) => {
    const decisions: QuantAIDecision[] = [];
    const exitPairs = new Map<string, number>();

    for (const analysis of analyses) {
      const candles4h = analysis.candles?.["4h"];
      if (!candles4h || candles4h.length < DON_CANDLES_NEEDED) continue;

      const n = candles4h.length;

      const lastBarClose = candles4h[n - 1].close; // bar close, not mark price — matches backtest
      const lastBarTime = candles4h[n - 1].timestamp;
      const exLow = Math.min(...candles4h.slice(n - variant.ex - 1, n - 1).map((c) => c.low));
      const exHigh = Math.max(...candles4h.slice(n - variant.ex - 1, n - 1).map((c) => c.high));
      if (lastBarClose <= exLow || lastBarClose >= exHigh) {
        exitPairs.set(analysis.pair, lastBarTime);
      }

      const decision = evalVariant(analysis.pair, analysis.markPrice, analysis.regime, candles4h, variant);
      if (decision) decisions.push(decision);
    }

    return { tradeType: variant.tradeType, decisions, exitPairs };
  });
}
