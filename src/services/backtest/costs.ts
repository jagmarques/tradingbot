import type { CostConfig, FundingEntry } from "./types.js";

// Per-pair calibrated half-spreads from scripts/backtest.ts SPREAD_MAP
const SPREAD_MAP: Record<string, number> = {
  // From backtest.ts lines 94-102 (short coin names for Hyperliquid API)
  XRP: 1.05e-4,
  DOGE: 1.35e-4,
  SUI: 1.85e-4,
  AVAX: 2.55e-4,
  ARB: 2.6e-4,
  ENA: 2.55e-4,
  UNI: 2.75e-4,
  APT: 3.2e-4,
  LINK: 3.45e-4,
  TRUMP: 3.65e-4,
  WLD: 4e-4,
  SEI: 4.4e-4,
  TON: 4.6e-4,
  DOT: 4.95e-4,
  WIF: 5.05e-4,
  ADA: 5.55e-4,
  LDO: 5.8e-4,
  OP: 6.2e-4,
  DASH: 7.15e-4,
  // Major pairs commonly referenced
  BTC: 1.0e-4,
  ETH: 1.5e-4,
  SOL: 2.0e-4,
};

export const DEFAULT_COST_CONFIG: CostConfig = {
  makerFeePct: 0.00015,     // 0.015% Hyperliquid maker
  takerFeePct: 0.00045,     // 0.045% Hyperliquid taker base
  spreadMap: SPREAD_MAP,
  defaultSpreadPct: 0.0004, // 0.04% half-spread fallback
  slippageMultiplierOnSL: 1.5, // 1.5x spread on hard stop fills (adverse slippage)
};

/**
 * Calculate one-side slippage cost in price units.
 * Uses per-pair spread from config.spreadMap, falls back to defaultSpreadPct.
 * Applies slippageMultiplierOnSL on stop-loss exits to model adverse fill.
 */
export function calcSlippage(
  price: number,
  pair: string,
  isStopLoss: boolean,
  config: CostConfig,
): number {
  const spread = config.spreadMap[pair] ?? config.defaultSpreadPct;
  const multiplier = isStopLoss ? config.slippageMultiplierOnSL : 1;
  return price * spread * multiplier;
}

/**
 * Calculate exchange fee for a given notional amount.
 * Hyperliquid: maker 0.01%, taker 0.035%.
 */
export function calcFees(
  notional: number,
  isMaker: boolean,
  config: CostConfig,
): number {
  return notional * (isMaker ? config.makerFeePct : config.takerFeePct);
}

/**
 * Find the funding rate for a given bar timestamp.
 * Uses forward-fill: returns the most recent entry at or before the timestamp.
 * Returns 0 if no entry exists within 2 hours of barTimestamp.
 */
export function findFundingForBar(
  entries: FundingEntry[],
  barTimestamp: number,
): number {
  if (entries.length === 0) return 0;

  const TWO_HOURS_MS = 7_200_000;

  // Binary search for the last entry at or before barTimestamp
  let lo = 0;
  let hi = entries.length - 1;

  // If barTimestamp is before all entries, no applicable rate
  if (entries[0].time > barTimestamp + TWO_HOURS_MS) return 0;

  // If barTimestamp is after all entries, use the last entry if within 2h
  if (entries[hi].time <= barTimestamp) {
    const gap = barTimestamp - entries[hi].time;
    return gap <= TWO_HOURS_MS ? entries[hi].rate : 0;
  }

  // Binary search: find largest index where entries[idx].time <= barTimestamp
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].time <= barTimestamp) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // lo is now the last index with entries[lo].time <= barTimestamp
  const gap = barTimestamp - entries[lo].time;
  if (gap > TWO_HOURS_MS) return 0;
  return entries[lo].rate;
}

/**
 * Calculate total funding cost for a held position across all bars.
 * Positive cost = longs pay, negative cost = longs receive.
 * For shorts: sign is inverted (shorts receive when longs pay).
 */
export function calcFundingCost(
  direction: "long" | "short",
  notional: number,
  holdBars: number,
  barTimestamps: number[],
  fundingEntries: FundingEntry[],
): number {
  if (holdBars === 0 || fundingEntries.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < holdBars; i++) {
    const ts = barTimestamps[i];
    if (ts === undefined) break;
    const rate = findFundingForBar(fundingEntries, ts);
    total += rate * notional;
  }

  // Shorts receive when longs pay (invert sign)
  return direction === "short" ? -total : total;
}

/**
 * Calculate total trade cost with full breakdown.
 * Returns { slippage, fees, funding, total }.
 * Entry always assumed taker; exit always assumed taker.
 * funding can be negative (income for shorts or negative rates).
 */
export function calcTotalTradeCost(
  entryPrice: number,
  exitPrice: number,
  notional: number,
  pair: string,
  direction: "long" | "short",
  isStopLossExit: boolean,
  holdBars: number,
  barTimestamps: number[],
  fundingEntries: FundingEntry[],
  config: CostConfig,
): { slippage: number; fees: number; funding: number; total: number } {
  const entrySlippage = calcSlippage(entryPrice, pair, false, config);
  const exitSlippage = calcSlippage(exitPrice, pair, isStopLossExit, config);
  const entryFee = calcFees(notional, false, config); // taker on entry
  const exitFee = calcFees(notional, false, config);  // taker on exit
  const funding = calcFundingCost(direction, notional, holdBars, barTimestamps, fundingEntries);

  const slippage = entrySlippage + exitSlippage;
  const fees = entryFee + exitFee;
  const total = slippage + fees + funding;

  return { slippage, fees, funding, total };
}
