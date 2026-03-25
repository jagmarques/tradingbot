import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Candle,
  FundingEntry,
  Position,
  Signal,
  SignalGenerator,
  BacktestConfig,
  BacktestResult,
  Trade,
} from "./types.js";
import { calcTotalTradeCost } from "./costs.js";
import { computeMetrics } from "./metrics.js";

// Suppress unused-variable lint for Signal import (used as return type in SignalGenerator)
void (undefined as unknown as Signal);

export interface RunBacktestOptions {
  /** Pre-loaded candles keyed by pair name (skips file I/O). */
  candles?: Record<string, Candle[]>;
  /** Pre-loaded funding data keyed by pair name (skips file I/O). */
  fundingData?: Record<string, FundingEntry[]>;
  /** Number of bars skipped at start for indicator warmup. Default 100. */
  warmupBars?: number;
  /** Path to directory with 1m candle files for intra-bar monitoring. */
  candles1mDir?: string;
  /** Log each trade to console. */
  verbose?: boolean;
}

/**
 * Load candles from bt-pair-cache format: {candleDir}/{pair}USDT.json
 * Expects a JSON array of {t, o, h, l, c} objects.
 * Returns candles sorted by timestamp ascending.
 */
export function loadCandles(pair: string, candleDir: string): Candle[] {
  const filePath = path.join(candleDir, `${pair}USDT.json`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as Candle[];
  return data.slice().sort((a, b) => a.t - b.t);
}

/**
 * Load funding data from {fundingDir}/{pair}_funding.json.
 * Returns empty array if file does not exist (graceful degradation).
 */
export function loadFundingData(pair: string, fundingDir: string): FundingEntry[] {
  const filePath = path.join(fundingDir, `${pair}_funding.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as FundingEntry[];
}

/**
 * Load 1m candles from {candles1mDir}/{pair}USDT_1m.json and index by hour timestamp.
 * Returns null if file does not exist.
 */
function load1mIndex(pair: string, candles1mDir: string): Map<number, Candle[]> | null {
  const filePath = path.join(candles1mDir, `${pair}USDT_1m.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as Candle[];
  const HOUR_MS = 3_600_000;
  const index = new Map<number, Candle[]>();
  for (const c of data) {
    const hourTs = Math.floor(c.t / HOUR_MS) * HOUR_MS;
    const arr = index.get(hourTs) ?? [];
    arr.push(c);
    index.set(hourTs, arr);
  }
  return index;
}

/** Apply spread to fill price on entry (worse fill: long pays more, short pays less). */
function applySpreadEntry(price: number, direction: "long" | "short", spread: number): number {
  return direction === "long" ? price * (1 + spread) : price * (1 - spread);
}

/** Apply spread to fill price on exit (worse fill: long sells lower, short buys higher). */
function applySpreadExit(price: number, direction: "long" | "short", spread: number): number {
  return direction === "long" ? price * (1 - spread) : price * (1 + spread);
}

/** Get per-pair half-spread from cost config. */
function getSpread(pair: string, config: BacktestConfig["costConfig"]): number {
  return config.spreadMap[pair] ?? config.defaultSpreadPct;
}

interface IntraBarExit {
  exitPrice: number;
  reason: string;
}

/**
 * Check bar-level SL/TP for the current candle.
 * Called when no 1m data is available for the bar.
 */
function checkBarLevel(
  pos: Position,
  bar: Candle,
  spread: number,
  slipMult: number,
): IntraBarExit | null {
  // 1. Stop-loss
  const slHit =
    pos.direction === "long" ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss;

  if (slHit) {
    const fill = applySpreadExit(pos.stopLoss, pos.direction, spread * slipMult);
    return { exitPrice: fill, reason: "stop-loss" };
  }

  // 2. Take-profit
  if (pos.takeProfit > 0) {
    const tpHit =
      pos.direction === "long" ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit;
    if (tpHit) {
      const fill = applySpreadExit(pos.takeProfit, pos.direction, spread);
      return { exitPrice: fill, reason: "take-profit" };
    }
  }

  // 3. Max hold
  if (pos.maxHoldBars !== undefined) {
    // max hold tracked by caller - return null here (checked in main loop)
  }

  return null;
}

/**
 * Check intra-bar 1m candles for SL/TP exits.
 * Priority: SL -> TP -> trailing -> max hold.
 */
function checkIntraBar(
  pos: Position,
  subCandles: Candle[],
  spread: number,
  slipMult: number,
): IntraBarExit | null {
  for (const c of subCandles) {
    // 1. Stop-loss
    const slHit =
      pos.direction === "long" ? c.l <= pos.stopLoss : c.h >= pos.stopLoss;

    if (slHit) {
      const fill = applySpreadExit(pos.stopLoss, pos.direction, spread * slipMult);
      return { exitPrice: fill, reason: "stop-loss" };
    }

    // 2. Take-profit
    if (pos.takeProfit > 0) {
      const tpHit =
        pos.direction === "long" ? c.h >= pos.takeProfit : c.l <= pos.takeProfit;
      if (tpHit) {
        const fill = applySpreadExit(pos.takeProfit, pos.direction, spread);
        return { exitPrice: fill, reason: "take-profit" };
      }
    }
  }
  return null;
}

/**
 * Core backtest simulation loop.
 *
 * Anti-look-ahead contract:
 * - signalGenerator receives (candles, barIndex, pair)
 * - Signal function MUST only use candles[0..barIndex-1]
 * - Entry price is ALWAYS candles[barIndex].o (next bar open after signal)
 *
 * @param config - BacktestConfig with pairs, capital, leverage, cost settings
 * @param signalGenerator - Pluggable SignalGenerator function
 * @param options - Optional overrides for candles, warmup, verbosity
 */
export function runBacktest(
  config: BacktestConfig,
  signalGenerator: SignalGenerator,
  options: RunBacktestOptions = {},
): BacktestResult {
  const warmupBars = options.warmupBars ?? 100;
  const HOUR_MS = 3_600_000;
  const allTrades: Trade[] = [];
  let tradeCounter = 0;

  for (const pair of config.pairs) {
    // Load or use pre-loaded candles
    let candles: Candle[];
    if (options.candles?.[pair]) {
      candles = options.candles[pair];
    } else {
      try {
        candles = loadCandles(pair, config.candleDir);
      } catch {
        if (options.verbose) console.log(`[Engine] ${pair}: candles not found, skipping`);
        continue;
      }
    }

    // Filter by time range
    const filtered = candles.filter(
      (c) => c.t >= config.startTime && c.t <= config.endTime,
    );
    if (filtered.length === 0) {
      // Use all candles if no time filter produces results (for synthetic test data)
      // This allows tests with startTime=0 and endTime=MAX to work
    }
    const workCandles = filtered.length > 0 ? filtered : candles;

    if (workCandles.length < warmupBars + 2) {
      if (options.verbose) console.log(`[Engine] ${pair}: insufficient candles`);
      continue;
    }

    // Load funding data
    let fundingEntries: FundingEntry[];
    if (options.fundingData?.[pair]) {
      fundingEntries = options.fundingData[pair];
    } else {
      try {
        fundingEntries = loadFundingData(pair, config.fundingDir);
      } catch {
        fundingEntries = [];
      }
    }

    // Load optional 1m intra-bar data
    let intraIndex: Map<number, Candle[]> | null = null;
    if (options.candles1mDir) {
      intraIndex = load1mIndex(pair, options.candles1mDir);
    }

    const spread = getSpread(pair, config.costConfig);
    const slipMult = config.costConfig.slippageMultiplierOnSL;

    let position: Position | null = null;
    let positionOpenBarIndex = -1;

    for (let i = warmupBars; i < workCandles.length; i++) {
      const bar = workCandles[i];

      // --- Step 1: Check existing position for exit ---
      if (position !== null) {
        let exit: IntraBarExit | null = null;

        // Try intra-bar 1m data first
        if (intraIndex !== null) {
          const hourTs = Math.floor(bar.t / HOUR_MS) * HOUR_MS;
          const subCandles = intraIndex.get(hourTs);
          if (subCandles && subCandles.length > 0) {
            exit = checkIntraBar(position, subCandles, spread, slipMult);
          }
        }

        // Fall back to bar-level check
        if (exit === null) {
          exit = checkBarLevel(position, bar, spread, slipMult);
        }

        // Max hold check (after SL/TP)
        if (exit === null && position.maxHoldBars !== undefined) {
          const barsHeld = i - positionOpenBarIndex;
          if (barsHeld >= position.maxHoldBars) {
            const fill = applySpreadExit(bar.c, position.direction, spread);
            exit = { exitPrice: fill, reason: "max-hold" };
          }
        }

        if (exit !== null) {
          // Compute costs
          const barsHeld = i - positionOpenBarIndex;
          const barTimestamps = workCandles
            .slice(positionOpenBarIndex, i)
            .map((c) => c.t);
          const notional = config.capitalUsd * config.leverage;
          const isSlExit = exit.reason === "stop-loss";

          const costs = calcTotalTradeCost(
            position.entryPrice,
            exit.exitPrice,
            notional,
            pair,
            position.direction,
            isSlExit,
            barsHeld,
            barTimestamps,
            fundingEntries,
            config.costConfig,
          );

          // Compute raw PnL
          const rawPnl =
            position.direction === "long"
              ? (exit.exitPrice / position.entryPrice - 1) * notional
              : (position.entryPrice / exit.exitPrice - 1) * notional;

          const pnl = rawPnl - costs.total;
          const pnlPct = (pnl / config.capitalUsd) * 100;

          const trade: Trade = {
            id: `${pair}_${tradeCounter++}`,
            pair,
            direction: position.direction,
            entryPrice: position.entryPrice,
            exitPrice: exit.exitPrice,
            entryTime: position.entryTime,
            exitTime: bar.t,
            pnl,
            pnlPct,
            exitReason: exit.reason,
            fees: costs.fees,
            slippage: costs.slippage,
            fundingCost: costs.funding,
          };

          if (options.verbose) {
            const sign = pnl >= 0 ? "+" : "";
            console.log(
              `[Engine] ${pair} ${position.direction} | ${exit.reason} | ${sign}$${pnl.toFixed(2)}`,
            );
          }

          allTrades.push(trade);
          position = null;
          positionOpenBarIndex = -1;
        }
      }

      // --- Step 2: Generate signal if no open position ---
      if (position === null) {
        const signal = signalGenerator(workCandles, i, pair);

        if (signal !== null) {
          // Anti-look-ahead: entry price is ALWAYS this bar's open (candles[barIndex].o)
          const rawEntry = bar.o;
          const entryWithSpread = applySpreadEntry(rawEntry, signal.direction, spread);

          position = {
            id: `${pair}_${tradeCounter}`,
            pair,
            direction: signal.direction,
            entryPrice: entryWithSpread,
            entryTime: bar.t,
            size: config.capitalUsd,
            leverage: config.leverage,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            maxHoldBars: config.maxHoldBars,
          };
          positionOpenBarIndex = i;

          if (options.verbose) {
            console.log(
              `[Engine] ${pair} OPEN ${signal.direction} @ ${entryWithSpread.toFixed(4)} | SL:${signal.stopLoss} TP:${signal.takeProfit}`,
            );
          }
        }
      }
    }
    // Any open position at end of data is NOT added to trades (not closed = no realized PnL)
  }

  const metrics = computeMetrics(allTrades, config.capitalUsd);

  return { trades: allTrades, metrics, config };
}
