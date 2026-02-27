import { ensureConnected, getClient } from "./client.js";
import { computeIndicators } from "./indicators.js";
import { classifyRegime } from "./regime.js";
import { evaluatePair } from "./rule-engine.js";
import { evaluateVwapPair } from "./vwap-engine.js";
import { calculateBacktestPositionSize } from "./kelly.js";
import type { OhlcvCandle, PairAnalysis, CandleInterval, TechnicalIndicators } from "./types.js";
import {
  QUANT_TRADING_PAIRS,
  STAGNATION_TIMEOUT_MS,
  HYPERLIQUID_MAX_LEVERAGE,
} from "../../config/constants.js";

let cachedResults: { ruleResults: BacktestResult[]; vwapResults: BacktestResult[] } | null = null;
let backtestRunning = false;

export function getCachedBacktest(): { ruleResults: BacktestResult[]; vwapResults: BacktestResult[] } | null {
  return cachedResults;
}

export function runBacktestBackground(): void {
  if (backtestRunning || cachedResults !== null) return;
  backtestRunning = true;
  runBacktest()
    .then(() => {
      console.log("[Backtest] Background run complete, results cached");
    })
    .catch((err) => {
      console.error("[Backtest] Background run failed:", err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      backtestRunning = false;
    });
}

interface BacktestTrade {
  pair: string;
  engine: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryIdx: number;
  exitIdx: number;
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
}

export interface BacktestResult {
  engine: string;
  pair: string;
  trades: BacktestTrade[];
  totalPnl: number;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

const INTERVAL_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

async function fetchHistoricalCandles(
  pair: string,
  interval: CandleInterval,
  days: number,
): Promise<OhlcvCandle[]> {
  const sdk = getClient();
  const endTime = Date.now();
  const startTime = endTime - days * 86400 * 1000;
  const intervalMs = INTERVAL_MS[interval];
  const totalCandles = (endTime - startTime) / intervalMs;
  const chunkSize = 5000;

  const allCandles: OhlcvCandle[] = [];

  if (totalCandles <= chunkSize) {
    const raw = await sdk.info.getCandleSnapshot(pair, interval, startTime, endTime);
    for (const c of raw) {
      allCandles.push({
        timestamp: c.t,
        open: parseFloat(String(c.o)),
        high: parseFloat(String(c.h)),
        low: parseFloat(String(c.l)),
        close: parseFloat(String(c.c)),
        volume: parseFloat(String(c.v)),
        trades: c.n,
      });
    }
  } else {
    let chunkStart = startTime;
    while (chunkStart < endTime) {
      const chunkEnd = Math.min(chunkStart + chunkSize * intervalMs, endTime);
      const raw = await sdk.info.getCandleSnapshot(pair, interval, chunkStart, chunkEnd);
      for (const c of raw) {
        allCandles.push({
          timestamp: c.t,
          open: parseFloat(String(c.o)),
          high: parseFloat(String(c.h)),
          low: parseFloat(String(c.l)),
          close: parseFloat(String(c.c)),
          volume: parseFloat(String(c.v)),
          trades: c.n,
        });
      }
      chunkStart = chunkEnd + intervalMs;
    }
  }

  allCandles.sort((a, b) => a.timestamp - b.timestamp);
  return allCandles;
}

const NULL_INDICATORS: TechnicalIndicators = {
  rsi: null,
  macd: null,
  bollingerBands: null,
  atr: null,
  vwap: null,
  adx: null,
};

function buildAnalysisAtIndex(
  candles1h: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  pair: string,
  idx: number,
): PairAnalysis {
  const slice1h = candles1h.slice(Math.max(0, idx - 99), idx + 1);
  const currentTs = candles1h[idx].timestamp;
  const all4hBefore = candles4h.filter((c) => c.timestamp <= currentTs);
  const slice4h = all4hBefore.slice(Math.max(0, all4hBefore.length - 30));

  const indicators1h = computeIndicators(slice1h);
  const indicators4h = computeIndicators(slice4h);
  const regime = classifyRegime(indicators1h);
  const markPrice = candles1h[idx].close;

  const indicators: Record<CandleInterval, TechnicalIndicators> = {
    "15m": NULL_INDICATORS,
    "1h": indicators1h,
    "4h": indicators4h,
  };

  return {
    pair,
    indicators,
    regime,
    markPrice,
    fundingRate: 0,
    openInterest: 0,
    oraclePrice: markPrice,
    dayVolume: 0,
    analyzedAt: new Date(currentTs).toISOString(),
  };
}

function backtestEngine(
  candles1h: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  pair: string,
  engine: string,
  startingBalance: number,
): BacktestResult {
  const feeRate = 0.00045 * 2;
  const stagnationCandles = Math.floor(STAGNATION_TIMEOUT_MS / 3_600_000);

  let balance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];

  type OpenPosition = {
    direction: "long" | "short";
    entryPrice: number;
    entryIdx: number;
    size: number;
    stopLoss: number;
    takeProfit: number;
    peakPnlPct: number;
  };

  let position: OpenPosition | null = null;

  const closePosition = (
    idx: number,
    exitPrice: number,
    exitReason: string,
  ): void => {
    if (!position) return;

    const { direction, entryPrice, entryIdx, size } = position;
    const pnl =
      ((exitPrice - entryPrice) / entryPrice) *
      size *
      HYPERLIQUID_MAX_LEVERAGE *
      (direction === "long" ? 1 : -1);
    const fees = size * HYPERLIQUID_MAX_LEVERAGE * feeRate;
    const netPnl = pnl - fees;
    const pnlPct = (netPnl / size) * 100;

    balance += netPnl;
    peakBalance = Math.max(peakBalance, balance);
    maxDrawdown = Math.max(maxDrawdown, ((peakBalance - balance) / peakBalance) * 100);

    trades.push({
      pair,
      engine,
      direction,
      entryPrice,
      exitPrice,
      entryIdx,
      exitIdx: idx,
      size,
      pnl: netPnl,
      pnlPct,
      exitReason,
    });

    position = null;
  };

  for (let idx = 100; idx < candles1h.length; idx++) {
    const candle = candles1h[idx];

    if (position !== null) {
      const { direction, entryPrice, stopLoss, takeProfit } = position;

      const unrealizedPnlPct =
        ((candle.close - entryPrice) / entryPrice) *
        100 *
        (direction === "long" ? 1 : -1);

      position.peakPnlPct = Math.max(position.peakPnlPct, unrealizedPnlPct);

      // Stop-loss check (priority)
      const slHit =
        direction === "long"
          ? candle.low <= stopLoss
          : candle.high >= stopLoss;

      // Take-profit check
      const tpHit =
        direction === "long"
          ? candle.high >= takeProfit
          : candle.low <= takeProfit;

      // Trailing stop: if peak > 5%, trail at peak - 2%
      const trailTrigger = position.peakPnlPct - 2;
      const trailingHit =
        position.peakPnlPct > 5 && unrealizedPnlPct <= trailTrigger;

      // Stagnation check
      const stagnationHit = idx - position.entryIdx >= stagnationCandles;

      if (slHit) {
        closePosition(idx, stopLoss, "stop_loss");
      } else if (tpHit) {
        closePosition(idx, takeProfit, "take_profit");
      } else if (trailingHit) {
        closePosition(idx, candle.close, "trailing_stop");
      } else if (stagnationHit) {
        closePosition(idx, candle.close, "stagnation");
      }
    } else {
      const analysis = buildAnalysisAtIndex(candles1h, candles4h, pair, idx);

      let decision = null;
      if (engine === "rule") {
        decision = evaluatePair(analysis);
      } else if (engine === "vwap") {
        decision = evaluateVwapPair(analysis);
      }

      if (decision !== null && decision.direction !== "flat") {
        const size = calculateBacktestPositionSize(
          decision.confidence,
          decision.entryPrice,
          decision.stopLoss,
          balance,
          true,
        );

        if (size > 0 && idx + 1 < candles1h.length) {
          const entryCandle = candles1h[idx + 1];
          position = {
            direction: decision.direction,
            entryPrice: entryCandle.open,
            entryIdx: idx + 1,
            size,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
            peakPnlPct: 0,
          };
        }
      }
    }
  }

  // Close any open position at last candle
  if (position !== null) {
    const lastCandle = candles1h[candles1h.length - 1];
    closePosition(candles1h.length - 1, lastCandle.close, "end_of_data");
  }

  const winRate =
    trades.length > 0
      ? (trades.filter((t) => t.pnl > 0).length / trades.length) * 100
      : 0;

  const totalReturn = ((balance - startingBalance) / startingBalance) * 100;

  // Simplified Sharpe ratio
  let sharpeRatio = 0;
  if (trades.length >= 2) {
    const pnlPcts = trades.map((t) => t.pnlPct);
    const mean = pnlPcts.reduce((sum, v) => sum + v, 0) / pnlPcts.length;
    const variance =
      pnlPcts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pnlPcts.length;
    const stddev = Math.sqrt(variance);
    if (stddev > 0) {
      sharpeRatio = (mean / stddev) * Math.sqrt(trades.length);
    }
  }

  return {
    engine,
    pair,
    trades,
    totalPnl: balance - startingBalance,
    winRate,
    totalReturn,
    maxDrawdown,
    sharpeRatio,
  };
}

export async function runBacktest(
  days = 180,
  startingBalance = 100,
): Promise<{ ruleResults: BacktestResult[]; vwapResults: BacktestResult[] }> {
  await ensureConnected();

  const ruleResults: BacktestResult[] = [];
  const vwapResults: BacktestResult[] = [];

  for (const pair of QUANT_TRADING_PAIRS) {
    const [candles1h, candles4h] = await Promise.all([
      fetchHistoricalCandles(pair, "1h", days),
      fetchHistoricalCandles(pair, "4h", days),
    ]);

    const ruleResult = backtestEngine(candles1h, candles4h, pair, "rule", startingBalance);
    const vwapResult = backtestEngine(candles1h, candles4h, pair, "vwap", startingBalance);

    const ruleSign = ruleResult.totalReturn >= 0 ? "+" : "";
    const vwapSign = vwapResult.totalReturn >= 0 ? "+" : "";
    console.log(
      `[Backtest] ${pair} complete: Rule ${ruleResult.trades.length}T/${ruleSign}${ruleResult.totalReturn.toFixed(1)}%, ` +
        `VWAP ${vwapResult.trades.length}T/${vwapSign}${vwapResult.totalReturn.toFixed(1)}%`,
    );

    ruleResults.push(ruleResult);
    vwapResults.push(vwapResult);
  }

  const result = { ruleResults, vwapResults };
  cachedResults = result;
  return result;
}
