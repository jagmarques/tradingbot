/**
 * Cross-Pair Correlation Filters on Supertrend(14, 1.75)
 *
 * Tests whether filtering entries based on cross-pair correlation
 * can improve portfolio-level results.
 *
 * Hypothesis: when all altcoins move together (high correlation),
 * a single BTC move whips all positions = higher risk.
 * When correlation is low, positions are more independent = lower risk.
 *
 * Filters:
 * 0. Baseline: Supertrend(14,1.75) + volume filter (no correlation)
 * 1. High-Correlation Guard: dynamic max positions based on avg pairwise corr
 * 2. BTC Correlation Filter: skip pairs with >0.8 BTC correlation
 * 3. Dispersion Entry: only enter when cross-sectional dispersion > 50th pct
 * 4. Pair Diversification: skip if new pair too correlated with open book
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h.
 * Full: 2023-01 to 2026-03 | OOS: 2025-09-01
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────
const CANDLE_DIR = "/tmp/bt-pair-cache-5m";
const LEV = 10;
const SIZE = 3; // $3 margin
const NOT = SIZE * LEV; // $30 notional
const FEE_TAKER = 0.00035;
const DAY = 86400000;
const HOUR = 3600000;

const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();
const FULL_START = new Date("2023-01-01").getTime();

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

const CORR_LOOKBACK = 20; // 20 bars rolling correlation window

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CANDLE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t ?? +b[0], o: +b.o ?? +b[1], h: +b.h ?? +b[2],
    l: +b.l ?? +b[3], c: +b.c ?? +b[4], v: +(b.v ?? b[5] ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const barsPerGroup = 48; // 48 x 5m = 4h
  const result: C[] = [];
  for (let i = 0; i < candles.length; i += barsPerGroup) {
    const group = candles.slice(i, i + barsPerGroup);
    if (group.length < barsPerGroup * 0.8) continue;
    result.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map(g => g.h)),
      l: Math.min(...group.map(g => g.l)),
      c: group[group.length - 1].c,
      v: group.reduce((s, g) => s + g.v, 0),
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j].h - cs[j].l,
          Math.abs(cs[j].h - cs[j - 1].c),
          Math.abs(cs[j].l - cs[j - 1].c),
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      const prevUpper = (cs[i - 1].h + cs[i - 1].l) / 2 + mult * atr[i - 1];
      const prevLower = (cs[i - 1].h + cs[i - 1].l) / 2 - mult * atr[i - 1];
      const prevFinalUpper = st[i - 1] > 0 && dirs[i - 1] === -1 ? st[i - 1] : prevUpper;
      const prevFinalLower = st[i - 1] > 0 && dirs[i - 1] === 1 ? st[i - 1] : prevLower;

      if (!(lowerBand > prevFinalLower || cs[i - 1].c < prevFinalLower)) {
        lowerBand = prevFinalLower;
      }
      if (!(upperBand < prevFinalUpper || cs[i - 1].c > prevFinalUpper)) {
        upperBand = prevFinalUpper;
      }
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }
    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

// ─── Correlation Utilities ──────────────────────────────────────────

/** Compute Pearson correlation between two arrays of equal length */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]; sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  return den > 0 ? num / den : 0;
}

/**
 * Build a time-aligned returns matrix for all pairs.
 * Returns: { timestamps: number[], returns: Map<pair, number[]> }
 * where returns[pair][i] = (close[i] - close[i-1]) / close[i-1]
 */
function buildReturnsMatrix(
  pairData: Map<string, { cs4h: C[] }>,
): { timestamps: number[]; returns: Map<string, number[]> } {
  const allPairKeys = [...pairData.keys()]; // includes BTC

  // Find common timestamps across all pairs
  const tsSets = new Map<string, Set<number>>();
  for (const [pair, pd] of pairData) {
    tsSets.set(pair, new Set(pd.cs4h.map(c => c.t)));
  }

  // Collect all timestamps that exist in at least half the pairs
  const allTs = new Set<number>();
  for (const [, ts] of tsSets) {
    for (const t of ts) allTs.add(t);
  }

  const sortedTs = [...allTs].sort((a, b) => a - b);
  const minPairs = Math.floor(PAIRS.length * 0.5);

  const validTs: number[] = [];
  for (const t of sortedTs) {
    let count = 0;
    for (const [, ts] of tsSets) {
      if (ts.has(t)) count++;
    }
    if (count >= minPairs) validTs.push(t);
  }

  // Build close price maps for quick lookup
  const closeMaps = new Map<string, Map<number, number>>();
  for (const [pair, pd] of pairData) {
    const cm = new Map<number, number>();
    for (const c of pd.cs4h) cm.set(c.t, c.c);
    closeMaps.set(pair, cm);
  }

  // Compute returns for each pair at each valid timestamp
  const returns = new Map<string, number[]>();
  const retTimestamps: number[] = [];

  for (let i = 1; i < validTs.length; i++) {
    const t = validTs[i];
    const tPrev = validTs[i - 1];
    let validCount = 0;

    const barReturns = new Map<string, number>();
    for (const pair of allPairKeys) {
      const cm = closeMaps.get(pair);
      if (!cm) continue;
      const c = cm.get(t);
      const cPrev = cm.get(tPrev);
      if (c !== undefined && cPrev !== undefined && cPrev > 0) {
        barReturns.set(pair, (c - cPrev) / cPrev);
        if (pair !== "BTC") validCount++;
      }
    }

    if (validCount >= minPairs) {
      retTimestamps.push(t);
      for (const pair of allPairKeys) {
        if (!returns.has(pair)) returns.set(pair, []);
        returns.get(pair)!.push(barReturns.get(pair) ?? NaN);
      }
    }
  }

  return { timestamps: retTimestamps, returns };
}

/**
 * For each timestamp, compute the average pairwise correlation over trailing CORR_LOOKBACK bars.
 */
function buildAvgPairwiseCorrelation(
  timestamps: number[],
  returns: Map<string, number[]>,
): Map<number, number> {
  const result = new Map<number, number>();
  const pairList = PAIRS.filter(p => returns.has(p));

  for (let i = CORR_LOOKBACK; i < timestamps.length; i++) {
    let totalCorr = 0;
    let pairCount = 0;

    for (let a = 0; a < pairList.length; a++) {
      for (let b = a + 1; b < pairList.length; b++) {
        const retsA = returns.get(pairList[a])!;
        const retsB = returns.get(pairList[b])!;

        // Get trailing window
        const windowA: number[] = [];
        const windowB: number[] = [];
        for (let j = i - CORR_LOOKBACK; j < i; j++) {
          const vA = retsA[j];
          const vB = retsB[j];
          if (!isNaN(vA) && !isNaN(vB)) {
            windowA.push(vA);
            windowB.push(vB);
          }
        }

        if (windowA.length >= 10) {
          totalCorr += pearson(windowA, windowB);
          pairCount++;
        }
      }
    }

    result.set(timestamps[i], pairCount > 0 ? totalCorr / pairCount : 0);
  }

  return result;
}

/**
 * For each pair+timestamp, compute rolling correlation with BTC returns.
 */
function buildBTCCorrelation(
  timestamps: number[],
  returns: Map<string, number[]>,
  btcReturns: number[],
): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();

  for (const pair of PAIRS) {
    const pairRets = returns.get(pair);
    if (!pairRets) continue;
    const corrMap = new Map<number, number>();

    for (let i = CORR_LOOKBACK; i < timestamps.length; i++) {
      const windowP: number[] = [];
      const windowB: number[] = [];
      for (let j = i - CORR_LOOKBACK; j < i; j++) {
        const vP = pairRets[j];
        const vB = btcReturns[j];
        if (!isNaN(vP) && !isNaN(vB)) {
          windowP.push(vP);
          windowB.push(vB);
        }
      }
      corrMap.set(timestamps[i], windowP.length >= 10 ? pearson(windowP, windowB) : 0);
    }

    result.set(pair, corrMap);
  }

  return result;
}

/**
 * Cross-sectional dispersion: std of all pair returns at each bar.
 * Also compute the rolling 50th percentile.
 */
function buildDispersion(
  timestamps: number[],
  returns: Map<string, number[]>,
): { dispersion: Map<number, number>; threshold50: Map<number, number> } {
  const dispersion = new Map<number, number>();
  const threshold50 = new Map<number, number>();
  const histDisp: number[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const rets: number[] = [];
    for (const pair of PAIRS) {
      const r = returns.get(pair)?.[i];
      if (r !== undefined && !isNaN(r)) rets.push(r);
    }

    if (rets.length < 5) {
      dispersion.set(timestamps[i], 0);
      threshold50.set(timestamps[i], 0);
      continue;
    }

    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    dispersion.set(timestamps[i], std);
    histDisp.push(std);

    // Rolling 50th percentile from all historical dispersion values
    const sorted = [...histDisp].sort((a, b) => a - b);
    const idx50 = Math.floor(sorted.length * 0.5);
    threshold50.set(timestamps[i], sorted[idx50]);
  }

  return { dispersion, threshold50 };
}

/**
 * For two pairs at a given return index, compute trailing correlation.
 */
function pairCorrelationAtBar(
  returns: Map<string, number[]>,
  pairA: string,
  pairB: string,
  barIdx: number,
): number {
  const retsA = returns.get(pairA);
  const retsB = returns.get(pairB);
  if (!retsA || !retsB) return 0;

  const windowA: number[] = [];
  const windowB: number[] = [];
  const start = Math.max(0, barIdx - CORR_LOOKBACK);
  for (let j = start; j < barIdx; j++) {
    const vA = retsA[j];
    const vB = retsB[j];
    if (!isNaN(vA) && !isNaN(vB)) {
      windowA.push(vA);
      windowB.push(vB);
    }
  }

  return windowA.length >= 10 ? pearson(windowA, windowB) : 0;
}

// ─── Cost / PnL ─────────────────────────────────────────────────────
function tradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SPREAD[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? 1.5 : 1);
  const fees = NOT * FEE_TAKER * 2;
  const rawPnl = dir === "long"
    ? (xp / ep - 1) * NOT
    : (ep / xp - 1) * NOT;
  return rawPnl - entrySlip * (NOT / ep) - exitSlip * (NOT / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / DAY);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const days = (endTs - startTs) / DAY;
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
  };
}

function fmtMetrics(m: Metrics): string {
  return `N=${m.n}  WR=${m.wr.toFixed(1)}%  PF=${m.pf.toFixed(2)}  Sharpe=${m.sharpe.toFixed(2)}  $/day=${m.perDay.toFixed(2)}  Total=$${m.total.toFixed(2)}  MaxDD=$${m.dd.toFixed(2)}`;
}

// ─── Filter Helpers ─────────────────────────────────────────────────

/** Find the closest timestamp in the returns array that is <= t */
function findRetIdx(timestamps: number[], t: number): number {
  let lo = 0, hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timestamps[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return timestamps[lo] <= t ? lo : -1;
}

function getMapVal(m: Map<number, number>, timestamps: number[], t: number): number {
  const exact = m.get(t);
  if (exact !== undefined) return exact;
  const idx = findRetIdx(timestamps, t);
  if (idx < 0) return 0;
  return m.get(timestamps[idx]) ?? 0;
}

// ─── Strategy Runner ────────────────────────────────────────────────
type FilterType = "baseline" | "corr-guard" | "btc-corr" | "dispersion" | "pair-diversify";

interface FilterConfig {
  name: string;
  type: FilterType;
}

interface CorrelationData {
  timestamps: number[];
  returns: Map<string, number[]>;
  btcReturns: number[];
  avgPairCorr: Map<number, number>;
  btcCorr: Map<string, Map<number, number>>;
  dispersion: Map<number, number>;
  dispThresh50: Map<number, number>;
}

function runStrategy(
  pairData: Map<string, { cs4h: C[]; stDir: number[]; atr: number[]; vol20: number[] }>,
  corrData: CorrelationData,
  filter: FilterConfig,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  // For "corr-guard" and "pair-diversify": need portfolio-level simulation
  // All entries across all pairs must be time-ordered
  if (filter.type === "corr-guard" || filter.type === "pair-diversify") {
    return runPortfolioStrategy(pairData, corrData, filter, startTs, endTs);
  }

  // Per-pair strategies (baseline, btc-corr, dispersion)
  for (const pair of PAIRS) {
    const pd = pairData.get(pair);
    if (!pd) continue;
    const { cs4h, stDir, atr, vol20 } = pd;

    let pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; peak: number;
    } | null = null;

    for (let i = 15; i < cs4h.length; i++) {
      if (cs4h[i].t > endTs && !pos) continue;

      const prevDir = stDir[i - 1];
      const prevPrevDir = i >= 2 ? stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Manage open position
      if (pos) {
        const bar = cs4h[i];

        if (pos.dir === "long") pos.peak = Math.max(pos.peak, bar.h);
        else pos.peak = Math.min(pos.peak, bar.l);

        let xp = 0, reason = "";

        if (pos.dir === "long" && bar.l <= pos.sl) {
          xp = pos.sl; reason = "sl";
        } else if (pos.dir === "short" && bar.h >= pos.sl) {
          xp = pos.sl; reason = "sl";
        }

        if (!xp && flipped) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) > 48 * HOUR) { xp = bar.c; reason = "stagnation"; }

        if (xp > 0) {
          const isSL = reason === "sl";
          const pnl = tradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason });
          }
          pos = null;
        }
      }

      // Entry
      if (!pos && flipped && cs4h[i].t >= startTs && cs4h[i].t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume filter
        const curVol = cs4h[i - 1]?.v ?? 0;
        const avgVol = vol20[i - 1] || 0;
        if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

        // BTC Correlation Filter: skip when pair-BTC corr > 0.8
        if (filter.type === "btc-corr") {
          const btcCorrMap = corrData.btcCorr.get(pair);
          if (btcCorrMap) {
            const corr = getMapVal(btcCorrMap, corrData.timestamps, cs4h[i].t);
            if (corr > 0.8) continue;
          }
        }

        // Dispersion Filter: only enter when dispersion > 50th pct
        if (filter.type === "dispersion") {
          const disp = getMapVal(corrData.dispersion, corrData.timestamps, cs4h[i].t);
          const thresh = getMapVal(corrData.dispThresh50, corrData.timestamps, cs4h[i].t);
          if (disp <= thresh) continue;
        }

        const ep = cs4h[i].o;
        const curATR = atr[i - 1] || atr[i - 2] || 0;
        const slDist = Math.min(3 * curATR, ep * 0.035);
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        pos = { dir: newDir, ep, et: cs4h[i].t, sl, peak: ep };
      }
    }

    // Close open position at end
    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs4h[cs4h.length - 1];
      const pnl = tradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

/**
 * Portfolio-level strategy: processes all pairs in time order to enforce
 * position limits (corr-guard) or book correlation checks (pair-diversify).
 */
function runPortfolioStrategy(
  pairData: Map<string, { cs4h: C[]; stDir: number[]; atr: number[]; vol20: number[] }>,
  corrData: CorrelationData,
  filter: FilterConfig,
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];

  // Build per-pair state
  interface PairState {
    pair: string;
    cs4h: C[];
    stDir: number[];
    atr: number[];
    vol20: number[];
    pos: {
      dir: "long" | "short"; ep: number; et: number;
      sl: number; peak: number;
    } | null;
  }

  const pairStates: PairState[] = [];
  for (const pair of PAIRS) {
    const pd = pairData.get(pair);
    if (!pd) continue;
    pairStates.push({
      pair, cs4h: pd.cs4h, stDir: pd.stDir, atr: pd.atr, vol20: pd.vol20, pos: null,
    });
  }

  // Collect all unique 4h timestamps and process in order
  const allTs = new Set<number>();
  for (const ps of pairStates) {
    for (const c of ps.cs4h) allTs.add(c.t);
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  // Index maps for quick bar lookup
  const barIdxMaps = new Map<string, Map<number, number>>();
  for (const ps of pairStates) {
    const m = new Map<number, number>();
    for (let i = 0; i < ps.cs4h.length; i++) m.set(ps.cs4h[i].t, i);
    barIdxMaps.set(ps.pair, m);
  }

  for (const t of sortedTs) {
    // Count open positions
    const openPairs = pairStates.filter(ps => ps.pos !== null).map(ps => ps.pair);

    for (const ps of pairStates) {
      const idxMap = barIdxMaps.get(ps.pair)!;
      const i = idxMap.get(t);
      if (i === undefined || i < 15) continue;

      const prevDir = ps.stDir[i - 1];
      const prevPrevDir = i >= 2 ? ps.stDir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // Manage open position
      if (ps.pos) {
        const bar = ps.cs4h[i];
        if (ps.pos.dir === "long") ps.pos.peak = Math.max(ps.pos.peak, bar.h);
        else ps.pos.peak = Math.min(ps.pos.peak, bar.l);

        let xp = 0, reason = "";

        if (ps.pos.dir === "long" && bar.l <= ps.pos.sl) {
          xp = ps.pos.sl; reason = "sl";
        } else if (ps.pos.dir === "short" && bar.h >= ps.pos.sl) {
          xp = ps.pos.sl; reason = "sl";
        }

        if (!xp && flipped) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - ps.pos.et) > 48 * HOUR) { xp = bar.c; reason = "stagnation"; }

        if (xp > 0) {
          const isSL = reason === "sl";
          const pnl = tradePnl(ps.pair, ps.pos.ep, xp, ps.pos.dir, isSL);
          if (ps.pos.et >= startTs && ps.pos.et < endTs) {
            trades.push({ pair: ps.pair, dir: ps.pos.dir, ep: ps.pos.ep, xp, et: ps.pos.et, xt: bar.t, pnl, reason });
          }
          ps.pos = null;
        }
      }

      // Entry
      if (!ps.pos && flipped && t >= startTs && t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume filter
        const curVol = ps.cs4h[i - 1]?.v ?? 0;
        const avgVol = ps.vol20[i - 1] || 0;
        if (avgVol <= 0 || curVol < 1.5 * avgVol) continue;

        // High-Correlation Guard: dynamic position limit
        if (filter.type === "corr-guard") {
          const avgCorr = getMapVal(corrData.avgPairCorr, corrData.timestamps, t);
          let maxPos = 10; // default
          if (avgCorr > 0.7) maxPos = 5;
          else if (avgCorr < 0.3) maxPos = 15;

          const currentOpen = pairStates.filter(s => s.pos !== null).length;
          if (currentOpen >= maxPos) continue;
        }

        // Pair Diversification: check correlation with open book
        if (filter.type === "pair-diversify") {
          const currentOpenPairs = pairStates.filter(s => s.pos !== null).map(s => s.pair);
          if (currentOpenPairs.length > 0) {
            const retIdx = findRetIdx(corrData.timestamps, t);
            if (retIdx >= CORR_LOOKBACK) {
              let totalCorr = 0;
              let corrCount = 0;
              for (const openPair of currentOpenPairs) {
                const c = pairCorrelationAtBar(corrData.returns, ps.pair, openPair, retIdx);
                totalCorr += c;
                corrCount++;
              }
              const avgCorr = corrCount > 0 ? totalCorr / corrCount : 0;
              if (avgCorr > 0.6) continue; // too correlated with existing book
            }
          }
        }

        const ep = ps.cs4h[i].o;
        const curATR = ps.atr[i - 1] || ps.atr[i - 2] || 0;
        const slDist = Math.min(3 * curATR, ep * 0.035);
        const sl = newDir === "long" ? ep - slDist : ep + slDist;

        ps.pos = { dir: newDir, ep, et: t, sl, peak: ep };
      }
    }
  }

  // Close open positions at end
  for (const ps of pairStates) {
    if (ps.pos && ps.pos.et >= startTs && ps.pos.et < endTs) {
      const lastBar = ps.cs4h[ps.cs4h.length - 1];
      const pnl = tradePnl(ps.pair, ps.pos.ep, lastBar.c, ps.pos.dir, false);
      trades.push({ pair: ps.pair, dir: ps.pos.dir, ep: ps.pos.ep, xp: lastBar.c, et: ps.pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=== Cross-Pair Correlation Filters on Supertrend(14, 1.75) ===");
console.log(`Pairs: ${PAIRS.join(", ")}`);
console.log(`Full: 2023-01 to 2026-03 | OOS: 2025-09-01`);
console.log(`Notional: $${NOT} (${LEV}x, $${SIZE} margin)`);
console.log(`Correlation lookback: ${CORR_LOOKBACK} bars (4h)`);
console.log();

// Load and aggregate data
console.log("Loading 5m data and aggregating to 4h...");

const pairData = new Map<string, { cs4h: C[]; stDir: number[]; atr: number[]; vol20: number[] }>();

for (const pair of PAIRS) {
  const raw5m = load5m(pair);
  if (raw5m.length < 1000) { console.log(`  SKIP ${pair}: only ${raw5m.length} 5m bars`); continue; }
  const cs4h = aggregateTo4h(raw5m);
  if (cs4h.length < 100) { console.log(`  SKIP ${pair}: only ${cs4h.length} 4h bars`); continue; }

  const { dir } = calcSupertrend(cs4h, 14, 1.75);
  const atr = calcATR(cs4h, 14);

  const vol20 = new Array(cs4h.length).fill(0);
  for (let i = 20; i < cs4h.length; i++) {
    let s = 0;
    for (let j = i - 20; j < i; j++) s += (cs4h[j].v ?? 0);
    vol20[i] = s / 20;
  }

  pairData.set(pair, { cs4h, stDir: dir, atr, vol20 });
  console.log(`  ${pair}: ${cs4h.length} 4h bars`);
}

// Load BTC for correlation
console.log("\nLoading BTC data for correlation...");
const btcRaw = load5m("BTC");
const btc4h = aggregateTo4h(btcRaw);
console.log(`  BTC: ${btc4h.length} 4h bars`);

// Add BTC to pairData temporarily for returns matrix (not traded)
const btcCloseMap = new Map<number, number>();
for (const c of btc4h) btcCloseMap.set(c.t, c.c);

// Build returns matrix
console.log("\nBuilding returns matrix...");
const pairDataForReturns = new Map<string, { cs4h: C[] }>();
for (const [pair, pd] of pairData) pairDataForReturns.set(pair, { cs4h: pd.cs4h });
pairDataForReturns.set("BTC", { cs4h: btc4h });

const { timestamps: retTs, returns: retMatrix } = buildReturnsMatrix(pairDataForReturns);
console.log(`  ${retTs.length} aligned return bars across pairs`);

// BTC returns vector (aligned)
const btcRetsVec = retMatrix.get("BTC") ?? [];

// Build correlation data
console.log("\nComputing average pairwise correlation...");
const avgPairCorr = buildAvgPairwiseCorrelation(retTs, retMatrix);
{
  const vals = [...avgPairCorr.values()];
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  console.log(`  Avg pairwise corr: mean=${mean.toFixed(3)}, min=${min.toFixed(3)}, max=${max.toFixed(3)}`);

  // Count bars above/below thresholds
  let above07 = 0, below03 = 0;
  for (const v of vals) {
    if (v > 0.7) above07++;
    if (v < 0.3) below03++;
  }
  console.log(`  Bars with avgCorr > 0.7: ${above07} (${(above07 / vals.length * 100).toFixed(1)}%)`);
  console.log(`  Bars with avgCorr < 0.3: ${below03} (${(below03 / vals.length * 100).toFixed(1)}%)`);
}

console.log("\nComputing BTC correlation per pair...");
const btcCorr = buildBTCCorrelation(retTs, retMatrix, btcRetsVec);
for (const pair of PAIRS) {
  const cm = btcCorr.get(pair);
  if (!cm) continue;
  const vals = [...cm.values()];
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const above08 = vals.filter(v => v > 0.8).length;
  console.log(`  ${pair.padEnd(6)}: avgBTCcorr=${mean.toFixed(3)}, bars>0.8: ${above08} (${(above08 / vals.length * 100).toFixed(1)}%)`);
}

console.log("\nComputing cross-sectional dispersion...");
const { dispersion, threshold50: dispThresh50 } = buildDispersion(retTs, retMatrix);
{
  const vals = [...dispersion.values()];
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  console.log(`  Avg dispersion: ${(mean * 100).toFixed(3)}%`);
}

const corrData: CorrelationData = {
  timestamps: retTs,
  returns: retMatrix,
  btcReturns: btcRetsVec,
  avgPairCorr,
  btcCorr,
  dispersion,
  dispThresh50: dispThresh50,
};

// Define filter configs
const FILTERS: FilterConfig[] = [
  { name: "0. Baseline (ST + Vol)", type: "baseline" },
  { name: "1. High-Corr Guard (dyn pos)", type: "corr-guard" },
  { name: "2. BTC Corr Filter (<0.8)", type: "btc-corr" },
  { name: "3. Dispersion Entry (>p50)", type: "dispersion" },
  { name: "4. Pair Diversification", type: "pair-diversify" },
];

// Run all strategies
console.log("\n" + "=".repeat(90));
console.log("RESULTS");
console.log("=".repeat(90));

const allResults: { name: string; oos: Metrics; full: Metrics; oosTrades: Tr[] }[] = [];

for (const f of FILTERS) {
  console.log(`\nRunning ${f.name}...`);
  const t0 = Date.now();
  const trades = runStrategy(pairData, corrData, f, FULL_START, OOS_END);
  const oosTrades = trades.filter(t => t.et >= OOS_START);
  const fullTrades = trades;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const oosM = calcMetrics(oosTrades, OOS_START, OOS_END);
  const fullM = calcMetrics(fullTrades, FULL_START, OOS_END);

  allResults.push({ name: f.name, oos: oosM, full: fullM, oosTrades });
  console.log(`  Done in ${elapsed}s: OOS=${oosTrades.length} trades, Full=${fullTrades.length} trades`);
}

// Print OOS results table
console.log("\n--- OOS Results (2025-09-01 to 2026-03-26) ---\n");
console.log(
  "Strategy".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "Total$".padStart(9) +
  "MaxDD$".padStart(9),
);
console.log("-".repeat(88));

for (const r of allResults) {
  const m = r.oos;
  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    m.wr.toFixed(1).padStart(8) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    m.perDay.toFixed(2).padStart(8) +
    m.total.toFixed(2).padStart(9) +
    m.dd.toFixed(2).padStart(9),
  );
}

// Print Full results table
console.log("\n--- Full Period Results (2023-01 to 2026-03) ---\n");
console.log(
  "Strategy".padEnd(32) +
  "Trades".padStart(7) +
  "WR%".padStart(8) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "$/day".padStart(8) +
  "Total$".padStart(9) +
  "MaxDD$".padStart(9),
);
console.log("-".repeat(88));

for (const r of allResults) {
  const m = r.full;
  console.log(
    r.name.padEnd(32) +
    String(m.n).padStart(7) +
    m.wr.toFixed(1).padStart(8) +
    m.pf.toFixed(2).padStart(7) +
    m.sharpe.toFixed(2).padStart(8) +
    m.perDay.toFixed(2).padStart(8) +
    m.total.toFixed(2).padStart(9) +
    m.dd.toFixed(2).padStart(9),
  );
}

// Delta analysis
const baseline = allResults[0];
console.log("\n--- OOS Delta vs Baseline ---\n");
console.log(
  "Strategy".padEnd(32) +
  "dTrades".padStart(8) +
  "dWR%".padStart(8) +
  "dPF".padStart(8) +
  "dSharpe".padStart(9) +
  "d$/day".padStart(9) +
  "dMaxDD$".padStart(9),
);
console.log("-".repeat(83));

for (let i = 1; i < allResults.length; i++) {
  const r = allResults[i];
  const bm = baseline.oos;
  const m = r.oos;
  const dN = m.n - bm.n;
  const dWR = m.wr - bm.wr;
  const dPF = m.pf - bm.pf;
  const dSharpe = m.sharpe - bm.sharpe;
  const dPerDay = m.perDay - bm.perDay;
  const dDD = m.dd - bm.dd;

  const sign = (v: number) => v >= 0 ? "+" : "";
  console.log(
    r.name.padEnd(32) +
    (sign(dN) + dN).padStart(8) +
    (sign(dWR) + dWR.toFixed(1)).padStart(8) +
    (sign(dPF) + dPF.toFixed(2)).padStart(8) +
    (sign(dSharpe) + dSharpe.toFixed(2)).padStart(9) +
    (sign(dPerDay) + dPerDay.toFixed(2)).padStart(9) +
    (sign(dDD) + dDD.toFixed(2)).padStart(9),
  );
}

// Long/Short breakdown
console.log("\n--- OOS Long/Short Split ---\n");
for (const r of allResults) {
  const longs = r.oosTrades.filter(t => t.dir === "long");
  const shorts = r.oosTrades.filter(t => t.dir === "short");
  const lm = calcMetrics(longs, OOS_START, OOS_END);
  const sm = calcMetrics(shorts, OOS_START, OOS_END);
  console.log(`${r.name}:`);
  console.log(`  Longs:  ${fmtMetrics(lm)}`);
  console.log(`  Shorts: ${fmtMetrics(sm)}`);
}

// Correlation regime breakdown for baseline
console.log("\n--- OOS Baseline Trades by Correlation Regime ---\n");
{
  const baselineTrades = allResults[0].oosTrades;
  const highCorr: Tr[] = [];
  const medCorr: Tr[] = [];
  const lowCorr: Tr[] = [];

  for (const t of baselineTrades) {
    const avgC = getMapVal(avgPairCorr, retTs, t.et);
    if (avgC > 0.7) highCorr.push(t);
    else if (avgC < 0.3) lowCorr.push(t);
    else medCorr.push(t);
  }

  console.log(`  HIGH corr (>0.7): ${fmtMetrics(calcMetrics(highCorr, OOS_START, OOS_END))}`);
  console.log(`  MED  corr (0.3-0.7): ${fmtMetrics(calcMetrics(medCorr, OOS_START, OOS_END))}`);
  console.log(`  LOW  corr (<0.3): ${fmtMetrics(calcMetrics(lowCorr, OOS_START, OOS_END))}`);
}

// BTC correlation breakdown
console.log("\n--- OOS Baseline Trades by BTC Correlation at Entry ---\n");
{
  const baselineTrades = allResults[0].oosTrades;
  const highBTC: Tr[] = [];
  const lowBTC: Tr[] = [];

  for (const t of baselineTrades) {
    const btcCorrMap = btcCorr.get(t.pair);
    if (!btcCorrMap) { lowBTC.push(t); continue; }
    const c = getMapVal(btcCorrMap, retTs, t.et);
    if (c > 0.8) highBTC.push(t);
    else lowBTC.push(t);
  }

  console.log(`  BTC corr > 0.8 (would skip): ${fmtMetrics(calcMetrics(highBTC, OOS_START, OOS_END))}`);
  console.log(`  BTC corr <= 0.8 (allowed):    ${fmtMetrics(calcMetrics(lowBTC, OOS_START, OOS_END))}`);
}

// Dispersion breakdown
console.log("\n--- OOS Baseline Trades by Dispersion at Entry ---\n");
{
  const baselineTrades = allResults[0].oosTrades;
  const highDisp: Tr[] = [];
  const lowDisp: Tr[] = [];

  for (const t of baselineTrades) {
    const d = getMapVal(dispersion, retTs, t.et);
    const thresh = getMapVal(dispThresh50, retTs, t.et);
    if (d > thresh) highDisp.push(t);
    else lowDisp.push(t);
  }

  console.log(`  High dispersion (>p50, allowed): ${fmtMetrics(calcMetrics(highDisp, OOS_START, OOS_END))}`);
  console.log(`  Low dispersion (<=p50, skipped):  ${fmtMetrics(calcMetrics(lowDisp, OOS_START, OOS_END))}`);
}

// Per-pair OOS for best filter
console.log("\n--- Per-Pair OOS (Best Filter vs Baseline) ---\n");
{
  let bestIdx = 0;
  for (let i = 1; i < allResults.length; i++) {
    if (allResults[i].oos.perDay > allResults[bestIdx].oos.perDay) bestIdx = i;
  }
  const best = allResults[bestIdx];
  const base = allResults[0];

  console.log(`Best filter: ${best.name}`);
  console.log();
  console.log(
    "Pair".padEnd(8) +
    "Base N".padStart(7) +
    "Base $/d".padStart(9) +
    "Filt N".padStart(7) +
    "Filt $/d".padStart(9) +
    "Delta".padStart(8),
  );
  console.log("-".repeat(48));

  for (const pair of PAIRS) {
    const baseTr = base.oosTrades.filter(t => t.pair === pair);
    const filtTr = best.oosTrades.filter(t => t.pair === pair);
    const days = (OOS_END - OOS_START) / DAY;
    const basePerDay = baseTr.reduce((s, t) => s + t.pnl, 0) / days;
    const filtPerDay = filtTr.reduce((s, t) => s + t.pnl, 0) / days;
    const delta = filtPerDay - basePerDay;
    console.log(
      pair.padEnd(8) +
      String(baseTr.length).padStart(7) +
      basePerDay.toFixed(3).padStart(9) +
      String(filtTr.length).padStart(7) +
      filtPerDay.toFixed(3).padStart(9) +
      (delta >= 0 ? "+" : "") + delta.toFixed(3).padStart(7),
    );
  }
}

console.log("\nDone.");
