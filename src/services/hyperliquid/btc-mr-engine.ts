import { fetchCandles } from "./candles.js";
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS } from "../../config/constants.js";
import type { OhlcvCandle } from "./types.js";

const TRADE_TYPE = "btc-mr" as const;
const LOOKBACK = 20;
const ENTRY_Z = 2.0;
const EXIT_Z = 0.0;
const STOP_Z = 3.5;
const POSITION_SIZE_USD = 10;
const LEVERAGE = 10;
const MAX_HOLD_MS = 24 * 60 * 60 * 1000;

// In-memory map: alt positionId -> btc hedge positionId
const altToBtcHedge = new Map<string, string>();

function computeReturns(candles: OhlcvCandle[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    returns.push(candles[i].close / candles[i - 1].close - 1);
  }
  return returns;
}

function olsBeta(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - meanX) * (y[i] - meanY);
    varX += (x[i] - meanX) ** 2;
  }
  cov /= n;
  varX /= n;
  return varX === 0 ? 0 : cov / varX;
}

function zScore(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return std === 0 ? 0 : (values[values.length - 1] - mean) / std;
}

interface ResidualAnalysis {
  pair: string;
  beta: number;
  z: number;
  lastPrice: number;
}

async function analyzeResidual(pair: string, btcCandles: OhlcvCandle[]): Promise<ResidualAnalysis | null> {
  const altCandles = await fetchCandles(pair, "1h", 22);
  if (altCandles.length < 16) return null;

  const altReturns = computeReturns(altCandles).slice(-LOOKBACK);
  const btcReturns = computeReturns(btcCandles).slice(-LOOKBACK);

  if (altReturns.length !== btcReturns.length || altReturns.length < 15) return null;

  const beta = olsBeta(btcReturns, altReturns);
  const alpha = (altReturns.reduce((a, b) => a + b, 0) / altReturns.length) - beta * (btcReturns.reduce((a, b) => a + b, 0) / btcReturns.length);
  const residuals = altReturns.map((r, i) => r - alpha - beta * btcReturns[i]);
  const z = zScore(residuals);
  const lastPrice = altCandles[altCandles.length - 1].close;

  return { pair, beta, z, lastPrice };
}

export async function runBtcMrCycle(): Promise<void> {
  const btcCandles = await fetchCandles("BTC", "1h", 22);
  if (btcCandles.length < 16) {
    console.log("[BTC-MR] Insufficient BTC candles, skipping cycle");
    return;
  }

  const allPositions = getOpenQuantPositions();
  const btcMrPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  const altPositions = btcMrPositions.filter(p => p.pair !== "BTC");
  const btcHedgePositions = btcMrPositions.filter(p => p.pair === "BTC");

  const openPairs = new Set(altPositions.map(p => p.pair));

  // Exit logic first
  for (const pos of altPositions) {
    const holdMs = Date.now() - new Date(pos.openedAt).getTime();
    const maxHold = holdMs >= MAX_HOLD_MS;

    let shouldExit = maxHold;
    let exitReason = "max-hold";

    if (!shouldExit) {
      const analysis = await analyzeResidual(pos.pair, btcCandles);
      if (analysis) {
        const z = analysis.z;
        const reverted = (pos.direction === "long" && z >= EXIT_Z) || (pos.direction === "short" && z <= EXIT_Z);
        const stopped = Math.abs(z) > STOP_Z;
        if (stopped) { shouldExit = true; exitReason = "stop-z"; }
        else if (reverted) { shouldExit = true; exitReason = "mean-reverted"; }
        console.log(`[BTC-MR] ${pos.pair} z=${z.toFixed(2)} ${pos.direction} hold=${Math.round(holdMs / 60000)}m`);
      }
    }

    if (shouldExit) {
      await closePosition(pos.id, exitReason);
      // Close paired BTC hedge
      const hedgeId = altToBtcHedge.get(pos.id);
      if (hedgeId) {
        const hedge = btcHedgePositions.find(h => h.id === hedgeId);
        if (hedge) await closePosition(hedge.id, `${exitReason}-hedge`);
        altToBtcHedge.delete(pos.id);
      } else {
        // Fallback: close BTC hedge matching opposite direction
        const altDir = pos.direction;
        const hedgeDir: "long" | "short" = altDir === "long" ? "short" : "long";
        const orphan = btcHedgePositions.find(h => h.direction === hedgeDir);
        if (orphan) await closePosition(orphan.id, `${exitReason}-hedge-fallback`);
      }
      openPairs.delete(pos.pair);
    }
  }

  // Clean up stale in-memory entries
  const currentAltIds = new Set(altPositions.map(p => p.id));
  for (const id of altToBtcHedge.keys()) {
    if (!currentAltIds.has(id)) altToBtcHedge.delete(id);
  }

  // Entry logic
  for (const pair of QUANT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;

    const analysis = await analyzeResidual(pair, btcCandles);
    if (!analysis) continue;

    const { beta, z } = analysis;
    const absBeta = Math.abs(beta);
    const hedgeSizeUsd = Math.min(absBeta * POSITION_SIZE_USD, 50);

    if (z < -ENTRY_Z) {
      // Alt undervalued vs BTC - go long alt, short BTC hedge
      const altPos = await openPosition("BTC" === pair ? null! : pair, "long", POSITION_SIZE_USD, LEVERAGE, 0.01, 999999, "ranging", TRADE_TYPE, undefined, undefined, true);
      if (altPos) {
        const btcPos = await openPosition("BTC", "short", hedgeSizeUsd, LEVERAGE, 0.01, 999999, "ranging", TRADE_TYPE, undefined, undefined, true);
        if (btcPos) altToBtcHedge.set(altPos.id, btcPos.id);
        console.log(`[BTC-MR] ${pair} z=${z.toFixed(2)} beta=${beta.toFixed(3)} -> long`);
      }
    } else if (z > ENTRY_Z) {
      // Alt overvalued vs BTC - go short alt, long BTC hedge
      const altPos = await openPosition(pair, "short", POSITION_SIZE_USD, LEVERAGE, 0.01, 999999, "ranging", TRADE_TYPE, undefined, undefined, true);
      if (altPos) {
        const btcPos = await openPosition("BTC", "long", hedgeSizeUsd, LEVERAGE, 0.01, 999999, "ranging", TRADE_TYPE, undefined, undefined, true);
        if (btcPos) altToBtcHedge.set(altPos.id, btcPos.id);
        console.log(`[BTC-MR] ${pair} z=${z.toFixed(2)} beta=${beta.toFixed(3)} -> short`);
      }
    } else {
      console.log(`[BTC-MR] ${pair} z=${z.toFixed(2)} beta=${beta.toFixed(3)} -> skip`);
    }
  }
}

export const BTC_MR_MAX_HOLD_MS = MAX_HOLD_MS;
