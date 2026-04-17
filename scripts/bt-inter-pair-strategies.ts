/**
 * Inter-Pair Relationship Strategies Backtest
 *
 * Tests 5 strategies that exploit relationships between crypto pairs:
 *   S1: Beta-weighted mean reversion (fade excess moves vs BTC beta)
 *   S2: Relative strength rotation (weekly rank, long top-3, short bottom-3)
 *   S3: Correlation breakdown (trade decoupling when rolling corr < 0.5)
 *   S4: Lead-lag exploitation (SOL leads others by lag hours)
 *   S5: Volatility dispersion (trade alt vol convergence to BTC vol)
 *
 * All run on 4h bars derived from 5m cache.
 * $3 margin, 10x leverage, BTC 4h EMA(12/21) filter for longs.
 * ATR(14)*3 stop, capped 3.5%, 60d max hold.
 * Correlation vs existing Supertrend reported at end.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-inter-pair-strategies.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ─────────────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 3;                   // $3 margin per position
const NOT = MARGIN * LEV;           // $30 notional
const ATR_PERIOD = 14;
const ATR_SL_MULT = 3.0;
const SL_MAX_PCT = 0.035;
const STAG_BARS = 360;              // 60 days at 4h bars
const BTC_EMA_FAST = 12;
const BTC_EMA_SLOW = 21;

// Full period (in-sample + OOS)
const FULL_START = new Date("2023-01-01").getTime();
const OOS_START = new Date("2025-06-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// Production pairs (18 alts, matches CLAUDE.md trading set + SOL/ETH as extra signal sources)
const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI",
  "SOL", "ETH",
];

// Spread map (half-spread per side, taker fill)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 0.8e-4, SOL: 1.2e-4,
  ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4,
  TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4,
  LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};
const DEFAULT_SP = 5e-4;

// ─── Types ─────────────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number }
interface Trade {
  pair: string; dir: "long" | "short";
  ep: number; xp: number;
  et: number; xt: number;
  pnl: number; reason: string;
}
interface Metrics {
  n: number; wr: number; pf: number;
  dd: number; total: number; perDay: number;
  longs: number; shorts: number;
  dailyPnl: Map<number, number>;
}

// ─── Data Loading ───────────────────────────────────────────────────────────
function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, sym + "USDT.json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as any[]).map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c }
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregateTo4h(candles: C[]): C[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / H4) * H4;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const result: C[] = [];
  for (const [ts, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < 36) continue;
    result.push({
      t: ts,
      o: bars[0]!.o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1]!.c,
    });
  }
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(
      cs[i]!.h - cs[i]!.l,
      Math.abs(cs[i]!.h - cs[i - 1]!.c),
      Math.abs(cs[i]!.l - cs[i - 1]!.c)
    );
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) {
        s += Math.max(
          cs[j]!.h - cs[j]!.l,
          Math.abs(cs[j]!.h - cs[j - 1]!.c),
          Math.abs(cs[j]!.l - cs[j - 1]!.c)
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1]! * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) sum += values[i]!;
  if (values.length >= period) {
    ema[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      ema[i] = values[i]! * k + ema[i - 1]! * (1 - k);
    }
  }
  return ema;
}

// Pearson correlation between two number arrays
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]!; sumB += b[i]!; }
  const mA = sumA / n, mB = sumB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - mA, db = b[i]! - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const den = Math.sqrt(dA * dB);
  return den > 0 ? num / den : 0;
}

// Compute rolling OLS beta of altcoin returns vs BTC returns
// Returns array of beta values (NaN where not enough data)
function calcRollingBeta(altReturns: number[], btcReturns: number[], window: number): number[] {
  const beta = new Array(altReturns.length).fill(NaN);
  for (let i = window; i < altReturns.length; i++) {
    const aSlice = altReturns.slice(i - window, i);
    const bSlice = btcReturns.slice(i - window, i);
    const n = window;
    let sumB = 0, sumA = 0;
    for (let j = 0; j < n; j++) { sumB += bSlice[j]!; sumA += aSlice[j]!; }
    const mB = sumB / n, mA = sumA / n;
    let cov = 0, varB = 0;
    for (let j = 0; j < n; j++) {
      cov += (bSlice[j]! - mB) * (aSlice[j]! - mA);
      varB += (bSlice[j]! - mB) ** 2;
    }
    beta[i] = varB > 1e-12 ? cov / varB : 1;
  }
  return beta;
}

// Rolling correlation between two return series
function calcRollingCorr(a: number[], b: number[], window: number): number[] {
  const corr = new Array(a.length).fill(NaN);
  for (let i = window; i < a.length; i++) {
    corr[i] = pearson(a.slice(i - window, i), b.slice(i - window, i));
  }
  return corr;
}

// Rolling standard deviation of returns
function calcRollingStd(returns: number[], window: number): number[] {
  const std = new Array(returns.length).fill(NaN);
  for (let i = window; i < returns.length; i++) {
    const slice = returns.slice(i - window, i);
    const mean = slice.reduce((s, v) => s + v, 0) / window;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / window;
    std[i] = Math.sqrt(variance);
  }
  return std;
}

// ─── BTC filter ─────────────────────────────────────────────────────────────
function buildBtcEmaFilter(btc4h: C[]): Map<number, "long" | "short"> {
  const closes = btc4h.map(c => c.c);
  const emaFast = calcEMA(closes, BTC_EMA_FAST);
  const emaSlow = calcEMA(closes, BTC_EMA_SLOW);
  const m = new Map<number, "long" | "short">();
  for (let i = BTC_EMA_SLOW; i < btc4h.length; i++) {
    m.set(btc4h[i]!.t, emaFast[i]! > emaSlow[i]! ? "long" : "short");
  }
  return m;
}

// ─── Supertrend (reference engine for correlation) ─────────────────────────
function calcSupertrend(cs: C[], atrPeriod: number, mult: number): number[] {
  const atr = calcATR(cs, atrPeriod);
  const dirs = new Array(cs.length).fill(1);
  const st = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i]!.h + cs[i]!.l) / 2;
    let upper = hl2 + mult * atr[i]!;
    let lower = hl2 - mult * atr[i]!;

    if (i > atrPeriod) {
      const pHL2 = (cs[i - 1]!.h + cs[i - 1]!.l) / 2;
      const pUpper = pHL2 + mult * atr[i - 1]!;
      const pLower = pHL2 - mult * atr[i - 1]!;
      const prevFinalUpper = (dirs[i - 1] === -1) ? st[i - 1]! : pUpper;
      const prevFinalLower = (dirs[i - 1] === 1) ? st[i - 1]! : pLower;

      if (!(lower > prevFinalLower || cs[i - 1]!.c < prevFinalLower)) lower = prevFinalLower;
      if (!(upper < prevFinalUpper || cs[i - 1]!.c > prevFinalUpper)) upper = prevFinalUpper;
    }

    if (i === atrPeriod) {
      dirs[i] = cs[i]!.c > upper ? 1 : -1;
    } else {
      dirs[i] = dirs[i - 1] === 1 ? (cs[i]!.c < lower ? -1 : 1) : (cs[i]!.c > upper ? 1 : -1);
    }
    st[i] = dirs[i] === 1 ? lower : upper;
  }
  return dirs;
}

// Build reference Supertrend equity curve per pair (for correlation calc)
function buildSupertrendDailyPnl(
  pairData: Map<string, C[]>,
  btcFilter: Map<number, "long" | "short">
): Map<number, number> {
  const dailyPnl = new Map<number, number>();

  for (const [pair, cs] of pairData) {
    if (pair === "BTC") continue;
    const dirs = calcSupertrend(cs, 14, 2.0);
    const atr = calcATR(cs, 14);
    const sp = SP[pair] ?? DEFAULT_SP;
    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; idx: number } | null = null;

    for (let i = 15; i < cs.length; i++) {
      const bar = cs[i]!;
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      // Exit
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (dirs[i - 1] !== dirs[i - 2]) { xp = bar.o; reason = "flip"; }
        else if (i - pos.idx >= STAG_BARS) { xp = bar.c; reason = "stag"; }

        if (xp > 0) {
          const pnl = pos.dir === "long"
            ? (xp / pos.ep - 1) * NOT - NOT * (FEE + sp) * 2
            : (pos.ep / xp - 1) * NOT - NOT * (FEE + sp) * 2;
          const dayKey = Math.floor(bar.t / DAY) * DAY;
          dailyPnl.set(dayKey, (dailyPnl.get(dayKey) ?? 0) + pnl);
          pos = null;
        }
      }

      // Entry on flip
      if (!pos && i >= 2 && dirs[i - 1] !== dirs[i - 2]) {
        const newDir: "long" | "short" = dirs[i - 1] === 1 ? "long" : "short";
        if (newDir === "long") {
          const btcDir = btcFilter.get(bar.t);
          if (btcDir !== "long") continue;
        }
        const curATR = atr[i] || atr[i - 1] || 0;
        let slDist = curATR * ATR_SL_MULT;
        if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
        const sl = newDir === "long" ? bar.o - slDist : bar.o + slDist;
        pos = { dir: newDir, ep: bar.o, et: bar.t, sl, idx: i };
      }
    }
  }
  return dailyPnl;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────
function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  const inWindow = trades.filter(t => t.et >= startTs && t.et < endTs);
  if (inWindow.length === 0) {
    return { n: 0, wr: 0, pf: 0, dd: 0, total: 0, perDay: 0, longs: 0, shorts: 0, dailyPnl: new Map() };
  }
  const wins = inWindow.filter(t => t.pnl > 0);
  const losses = inWindow.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = inWindow.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const dailyPnl = new Map<number, number>();
  const sorted = [...inWindow].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    const dk = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(dk, (dailyPnl.get(dk) ?? 0) + t.pnl);
  }

  const days = (endTs - startTs) / DAY;
  return {
    n: inWindow.length,
    wr: wins.length / inWindow.length * 100,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    longs: inWindow.filter(t => t.dir === "long").length,
    shorts: inWindow.filter(t => t.dir === "short").length,
    dailyPnl,
  };
}

// Correlation of two daily-pnl maps over aligned trading days
function dailyCorr(
  a: Map<number, number>,
  b: Map<number, number>,
  startTs: number,
  endTs: number
): number {
  const aKeys = new Set([...a.keys()].filter(k => k >= startTs && k < endTs));
  const bKeys = new Set([...b.keys()].filter(k => k >= startTs && k < endTs));
  const allKeys = [...new Set([...aKeys, ...bKeys])].sort();
  const aVals = allKeys.map(k => a.get(k) ?? 0);
  const bVals = allKeys.map(k => b.get(k) ?? 0);
  return pearson(aVals, bVals);
}

function fmt(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

function printMetrics(label: string, m: Metrics): void {
  if (m.n === 0) {
    console.log(`  ${label}: no trades`);
    return;
  }
  const pfStr = m.pf === Infinity ? "INF" : m.pf.toFixed(2);
  console.log(
    `  ${label}: N=${m.n} WR=${m.wr.toFixed(1)}% PF=${pfStr} ` +
    `total=${fmt(m.total)} $/d=${fmt(m.perDay)} MaxDD=$${m.dd.toFixed(2)} L/S=${m.longs}/${m.shorts}`
  );
}

// ────────────────────────────────────────────────────────────────────────────
//  STRATEGY 1: Beta-weighted mean reversion
//  When altcoin move > 2x expected (beta * BTC move), fade the excess.
//  Enter at bar open of the following 4h bar, exit after reversion or SL.
// ────────────────────────────────────────────────────────────────────────────
function runS1BetaMeanReversion(
  pairData: Map<string, C[]>,
  btc4h: C[],
  btcFilter: Map<number, "long" | "short">
): Trade[] {
  const trades: Trade[] = [];

  // Build aligned timestamp map from BTC
  const btcByTs = new Map<number, number>(); // ts -> index in btc4h
  btc4h.forEach((c, i) => btcByTs.set(c.t, i));

  // Compute BTC bar returns once
  const btcRet = btc4h.map((c, i) => i === 0 ? 0 : c.c / btc4h[i - 1]!.c - 1);
  const BETA_WINDOW = 30 * 6; // 30 days in 4h bars

  for (const [pair, cs] of pairData) {
    if (pair === "BTC") continue;
    const sp = SP[pair] ?? DEFAULT_SP;
    const atr = calcATR(cs, ATR_PERIOD);

    // Align alt returns to BTC timeline via a shared ts index
    const altByTs = new Map<number, number>();
    cs.forEach((c, i) => altByTs.set(c.t, i));

    // Build parallel BTC return array indexed by alt bar index
    const altRet: number[] = cs.map((c, i) => i === 0 ? 0 : c.c / cs[i - 1]!.c - 1);

    // Rolling beta: we need alt returns and BTC returns aligned by timestamp
    const btcRetAligned: number[] = cs.map(c => {
      const bIdx = btcByTs.get(c.t);
      return bIdx !== undefined && bIdx > 0 ? btcRet[bIdx]! : 0;
    });

    const rollingBeta = calcRollingBeta(altRet, btcRetAligned, BETA_WINDOW);

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; idx: number } | null = null;

    for (let i = BETA_WINDOW + 1; i < cs.length; i++) {
      const bar = cs[i]!;
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      const prevBar = cs[i - 1]!;
      const bIdx = btcByTs.get(prevBar.t);
      if (bIdx === undefined) continue;

      // Exit existing position
      if (pos) {
        let xp = 0;
        const isSL =
          (pos.dir === "long" && bar.l <= pos.sl) ||
          (pos.dir === "short" && bar.h >= pos.sl);
        if (isSL) {
          xp = pos.sl;
        } else if (i - pos.idx >= 6) {
          // Max hold: 6 bars (24h) for mean reversion
          xp = bar.c;
        }
        if (xp > 0) {
          const slipMult = isSL ? 1.5 : 1;
          const effectiveXp = pos.dir === "long"
            ? xp * (1 - sp * slipMult)
            : xp * (1 + sp * slipMult);
          const rawPnl = pos.dir === "long"
            ? (effectiveXp / pos.ep - 1) * NOT
            : (pos.ep / effectiveXp - 1) * NOT;
          const pnl = rawPnl - NOT * FEE * 2;
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: effectiveXp, et: pos.et, xt: bar.t, pnl, reason: isSL ? "sl" : "time" });
          pos = null;
        }
      }

      // Entry: check if previous bar had excess move vs BTC
      if (!pos) {
        const beta = rollingBeta[i - 1];
        if (isNaN(beta!) || beta === undefined) continue;

        const prevAltRet = altRet[i - 1]!;
        const prevBtcRet = btcRetAligned[i - 1]!;
        const expectedMove = beta * prevBtcRet;
        const excessMove = prevAltRet - expectedMove;

        // Trigger: excess move > 2x absolute expected move in either direction
        // Only trigger if BTC moved at all (avoid noise when BTC is flat)
        const absBtcRet = Math.abs(prevBtcRet);
        if (absBtcRet < 0.005) continue; // BTC moved < 0.5%, too noisy

        const threshold = 2.0 * Math.abs(expectedMove);
        if (Math.abs(excessMove) < threshold) continue;
        if (Math.abs(excessMove) < 0.01) continue; // min 1% excess absolute

        // Fade the excess: if alt overshot up -> short; if alt overshot down -> long
        const dir: "long" | "short" = excessMove > 0 ? "short" : "long";

        // BTC EMA filter for longs
        if (dir === "long") {
          const btcDir = btcFilter.get(bar.t);
          if (btcDir !== "long") continue;
        }

        const curATR = atr[i] || atr[i - 1] || 0;
        let slDist = curATR * ATR_SL_MULT;
        if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
        const sl = dir === "long" ? bar.o - slDist : bar.o + slDist;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);

        pos = { dir, ep, et: bar.t, sl, idx: i };
      }
    }

    // Close open at end
    if (pos) {
      const lastBar = cs[cs.length - 1]!;
      const rawPnl = pos.dir === "long"
        ? (lastBar.c / pos.ep - 1) * NOT
        : (pos.ep / lastBar.c - 1) * NOT;
      const pnl = rawPnl - NOT * FEE * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────────────
//  STRATEGY 2: Relative Strength Rotation
//  Weekly rebalance: long top-3 pairs by 7d return, short bottom-3.
//  Uses 4h bars. BTC EMA filter for longs. ATR stop.
// ────────────────────────────────────────────────────────────────────────────
function runS2RSRotation(
  pairData: Map<string, C[]>,
  btcFilter: Map<number, "long" | "short">
): Trade[] {
  const trades: Trade[] = [];

  // Build a sorted set of all 4h timestamps
  const allTs = new Set<number>();
  for (const cs of pairData.values()) {
    for (const c of cs) {
      if (c.t >= FULL_START && c.t <= FULL_END) allTs.add(c.t);
    }
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);

  // Build per-pair index map
  const pairIdx = new Map<string, Map<number, number>>();
  for (const [pair, cs] of pairData) {
    const m = new Map<number, number>();
    cs.forEach((c, i) => m.set(c.t, i));
    pairIdx.set(pair, m);
  }

  // Track open positions
  type OpenPos = { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number; idx: number };
  let openPositions: OpenPos[] = [];

  // Weekly rebalance: every 42 bars (7 days * 6 bars/day)
  const REBALANCE_BARS = 42;
  const LOOKBACK_BARS = 42; // 7-day return lookback
  const TOP_N = 3;
  const BOTTOM_N = 3;

  // Find rebalance timestamps (every ~7 days from start)
  let lastRebalance = -Infinity;
  const rebalanceTimes: number[] = [];
  for (const ts of sortedTs) {
    if (ts - lastRebalance >= REBALANCE_BARS * H4) {
      rebalanceTimes.push(ts);
      lastRebalance = ts;
    }
  }

  const pairAtrMap = new Map<string, number[]>();
  for (const [pair, cs] of pairData) {
    pairAtrMap.set(pair, calcATR(cs, ATR_PERIOD));
  }

  for (let ri = 0; ri < rebalanceTimes.length; ri++) {
    const rebalTs = rebalanceTimes[ri]!;
    const nextRebalTs = ri + 1 < rebalanceTimes.length ? rebalanceTimes[ri + 1]! : FULL_END;

    // Close all open positions at rebalance bar open
    for (const p of openPositions) {
      const cs = pairData.get(p.pair);
      if (!cs) continue;
      const idx = pairIdx.get(p.pair)?.get(rebalTs);
      if (idx === undefined) continue;
      const bar = cs[idx]!;
      const sp = SP[p.pair] ?? DEFAULT_SP;
      const xp = p.dir === "long" ? bar.o * (1 - sp) : bar.o * (1 + sp);
      const rawPnl = p.dir === "long"
        ? (xp / p.ep - 1) * NOT
        : (p.ep / xp - 1) * NOT;
      const pnl = rawPnl - NOT * FEE * 2;
      trades.push({ pair: p.pair, dir: p.dir, ep: p.ep, xp, et: p.et, xt: rebalTs, pnl, reason: "rebal" });
    }
    openPositions = [];

    // Rank pairs by 7d (LOOKBACK_BARS) return
    const ranked: { pair: string; ret: number }[] = [];
    for (const [pair, cs] of pairData) {
      if (pair === "BTC") continue;
      const idx = pairIdx.get(pair)?.get(rebalTs);
      if (idx === undefined || idx < LOOKBACK_BARS) continue;
      const startC = cs[idx - LOOKBACK_BARS]!.c;
      const endC = cs[idx]!.c;
      if (startC <= 0) continue;
      ranked.push({ pair, ret: endC / startC - 1 });
    }

    if (ranked.length < TOP_N + BOTTOM_N) continue;
    ranked.sort((a, b) => b.ret - a.ret);

    const topPairs = ranked.slice(0, TOP_N);
    const bottomPairs = ranked.slice(-BOTTOM_N);

    const btcDir = btcFilter.get(rebalTs);

    // Open long positions
    for (const { pair } of topPairs) {
      if (btcDir !== "long") continue; // BTC EMA filter
      const cs = pairData.get(pair)!;
      const idx = pairIdx.get(pair)?.get(rebalTs);
      if (idx === undefined) continue;
      const bar = cs[idx]!;
      const sp = SP[pair] ?? DEFAULT_SP;
      const ep = bar.o * (1 + sp);
      const atr = pairAtrMap.get(pair)!;
      const curATR = atr[idx] || atr[idx - 1] || 0;
      let slDist = curATR * ATR_SL_MULT;
      if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
      const sl = ep - slDist;
      openPositions.push({ pair, dir: "long", ep, et: rebalTs, sl, idx });
    }

    // Open short positions (shorts always allowed)
    for (const { pair } of bottomPairs) {
      const cs = pairData.get(pair)!;
      const idx = pairIdx.get(pair)?.get(rebalTs);
      if (idx === undefined) continue;
      const bar = cs[idx]!;
      const sp = SP[pair] ?? DEFAULT_SP;
      const ep = bar.o * (1 - sp);
      const atr = pairAtrMap.get(pair)!;
      const curATR = atr[idx] || atr[idx - 1] || 0;
      let slDist = curATR * ATR_SL_MULT;
      if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
      const sl = ep + slDist;
      openPositions.push({ pair, dir: "short", ep, et: rebalTs, sl, idx });
    }

    // Check SL during holding period
    const tsInPeriod = sortedTs.filter(ts => ts > rebalTs && ts <= nextRebalTs);
    for (const ts of tsInPeriod) {
      const stillOpen: OpenPos[] = [];
      for (const p of openPositions) {
        const cs = pairData.get(p.pair);
        if (!cs) { stillOpen.push(p); continue; }
        const idx = pairIdx.get(p.pair)?.get(ts);
        if (idx === undefined) { stillOpen.push(p); continue; }
        const bar = cs[idx]!;
        const sp = SP[p.pair] ?? DEFAULT_SP;

        if (
          (p.dir === "long" && bar.l <= p.sl) ||
          (p.dir === "short" && bar.h >= p.sl)
        ) {
          const xp = p.dir === "long"
            ? p.sl * (1 - sp * 1.5)
            : p.sl * (1 + sp * 1.5);
          const rawPnl = p.dir === "long"
            ? (xp / p.ep - 1) * NOT
            : (p.ep / xp - 1) * NOT;
          const pnl = rawPnl - NOT * FEE * 2;
          trades.push({ pair: p.pair, dir: p.dir, ep: p.ep, xp, et: p.et, xt: ts, pnl, reason: "sl" });
        } else {
          stillOpen.push(p);
        }
      }
      openPositions = stillOpen;
    }
  }

  // Close remaining at end
  for (const p of openPositions) {
    const cs = pairData.get(p.pair);
    if (!cs) continue;
    const lastBar = cs[cs.length - 1]!;
    const sp = SP[p.pair] ?? DEFAULT_SP;
    const xp = p.dir === "long" ? lastBar.c * (1 - sp) : lastBar.c * (1 + sp);
    const rawPnl = p.dir === "long"
      ? (xp / p.ep - 1) * NOT
      : (p.ep / xp - 1) * NOT;
    const pnl = rawPnl - NOT * FEE * 2;
    trades.push({ pair: p.pair, dir: p.dir, ep: p.ep, xp, et: p.et, xt: lastBar.t, pnl, reason: "end" });
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────────────
//  STRATEGY 3: Correlation Breakdown
//  When rolling 30d corr of alt vs BTC drops below 0.5 (normally >0.8),
//  trade in the direction of the decoupling vs BTC.
// ────────────────────────────────────────────────────────────────────────────
function runS3CorrBreakdown(
  pairData: Map<string, C[]>,
  btc4h: C[],
  btcFilter: Map<number, "long" | "short">
): Trade[] {
  const trades: Trade[] = [];

  const CORR_WINDOW = 30 * 6;        // 30 days in 4h bars
  const CORR_THRESHOLD_LOW = 0.5;    // below this = breakdown
  const CORR_THRESHOLD_NORMAL = 0.7; // re-enter only when corr has been normal before

  const btcByTs = new Map<number, number>();
  btc4h.forEach((c, i) => btcByTs.set(c.t, i));
  const btcRet = btc4h.map((c, i) => i === 0 ? 0 : c.c / btc4h[i - 1]!.c - 1);

  for (const [pair, cs] of pairData) {
    if (pair === "BTC") continue;
    const sp = SP[pair] ?? DEFAULT_SP;
    const atr = calcATR(cs, ATR_PERIOD);
    const altRet = cs.map((c, i) => i === 0 ? 0 : c.c / cs[i - 1]!.c - 1);

    // Align BTC returns to alt timestamps
    const btcRetAligned = cs.map(c => {
      const bIdx = btcByTs.get(c.t);
      return bIdx !== undefined && bIdx > 0 ? btcRet[bIdx]! : 0;
    });

    const rollingCorr = calcRollingCorr(altRet, btcRetAligned, CORR_WINDOW);

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; idx: number } | null = null;
    let prevCorrNormal = false; // track if correlation was last in normal territory

    for (let i = CORR_WINDOW + 1; i < cs.length; i++) {
      const bar = cs[i]!;
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      const corr = rollingCorr[i - 1];
      if (corr === undefined || isNaN(corr)) continue;

      // Track whether correlation was recently normal
      if (corr > CORR_THRESHOLD_NORMAL) prevCorrNormal = true;

      // Exit
      if (pos) {
        let xp = 0;
        const isSL =
          (pos.dir === "long" && bar.l <= pos.sl) ||
          (pos.dir === "short" && bar.h >= pos.sl);

        if (isSL) {
          xp = pos.sl;
        } else if (corr > CORR_THRESHOLD_NORMAL) {
          // Correlation recovered -> exit
          xp = bar.o;
        } else if (i - pos.idx >= STAG_BARS) {
          xp = bar.c;
        }

        if (xp > 0) {
          const slipMult = isSL ? 1.5 : 1;
          const effectiveXp = pos.dir === "long"
            ? xp * (1 - sp * slipMult)
            : xp * (1 + sp * slipMult);
          const rawPnl = pos.dir === "long"
            ? (effectiveXp / pos.ep - 1) * NOT
            : (pos.ep / effectiveXp - 1) * NOT;
          const pnl = rawPnl - NOT * FEE * 2;
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: effectiveXp, et: pos.et, xt: bar.t, pnl, reason: isSL ? "sl" : "corr-recover" });
          pos = null;
        }
      }

      // Entry: correlation broke down (was normal, now below threshold)
      if (!pos && corr < CORR_THRESHOLD_LOW && prevCorrNormal) {
        // Direction: is the alt moving independent of BTC (up or down)?
        // Use the last bar's alt vs BTC return direction: alt moved opposite to what BTC correlation would predict
        const prevBtcRet = btcRetAligned[i - 1]!;
        const prevAltRet = altRet[i - 1]!;
        // If alt is rising while BTC is falling (or vice versa), that's the decoupling direction
        let dir: "long" | "short" | null = null;
        if (prevAltRet > 0.005 && prevBtcRet < -0.005) {
          dir = "long"; // alt decoupling upward
        } else if (prevAltRet < -0.005 && prevBtcRet > 0.005) {
          dir = "short"; // alt decoupling downward
        } else if (Math.abs(prevAltRet) > 0.01) {
          // Flat BTC but alt moving strongly -> trade in alt direction
          dir = prevAltRet > 0 ? "long" : "short";
        }
        if (dir === null) continue;

        if (dir === "long") {
          const btcDir = btcFilter.get(bar.t);
          if (btcDir !== "long") continue;
        }

        const curATR = atr[i] || atr[i - 1] || 0;
        let slDist = curATR * ATR_SL_MULT;
        if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
        const sl = dir === "long" ? bar.o - slDist : bar.o + slDist;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);

        pos = { dir, ep, et: bar.t, sl, idx: i };
        prevCorrNormal = false; // reset after entry
      }
    }

    // Close open at end
    if (pos) {
      const lastBar = cs[cs.length - 1]!;
      const rawPnl = pos.dir === "long"
        ? (lastBar.c / pos.ep - 1) * NOT
        : (pos.ep / lastBar.c - 1) * NOT;
      const pnl = rawPnl - NOT * FEE * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────────────
//  STRATEGY 4: Lead-Lag Exploitation
//  Test if SOL leads other pairs by 1-4 bars (4h-16h).
//  When SOL moves >2%, enter lagging pairs in SOL's direction.
// ────────────────────────────────────────────────────────────────────────────
function runS4LeadLag(
  pairData: Map<string, C[]>,
  btcFilter: Map<number, "long" | "short">
): Trade[] {
  const trades: Trade[] = [];

  const SOL_MOVE_THRESHOLD = 0.02; // SOL must move > 2%
  const LAG_BARS = 2; // enter lagging pairs 2 bars (8h) after SOL signal

  const solCs = pairData.get("SOL");
  if (!solCs) return trades;

  const solRet = solCs.map((c, i) => i === 0 ? 0 : c.c / solCs[i - 1]!.c - 1);
  const solByTs = new Map<number, number>();
  solCs.forEach((c, i) => solByTs.set(c.t, i));

  for (const [pair, cs] of pairData) {
    if (pair === "BTC" || pair === "SOL") continue; // SOL can't lead itself
    const sp = SP[pair] ?? DEFAULT_SP;
    const atr = calcATR(cs, ATR_PERIOD);
    const altByTs = new Map<number, number>();
    cs.forEach((c, i) => altByTs.set(c.t, i));

    // Compute cross-lagged correlation to confirm SOL leads this pair
    // Align returns
    const minLen = Math.min(solCs.length, cs.length);
    const alignedSolRet: number[] = [];
    const alignedAltRet: number[] = [];
    for (let i = 0; i < cs.length && i < minLen; i++) {
      const solIdx = solByTs.get(cs[i]!.t);
      if (solIdx !== undefined) {
        alignedSolRet.push(solRet[solIdx]!);
        alignedAltRet.push(i === 0 ? 0 : cs[i]!.c / cs[i - 1]!.c - 1);
      }
    }

    // Compute lagged correlation (SOL at t vs alt at t+LAG_BARS)
    let laggedCorr = 0;
    if (alignedSolRet.length > LAG_BARS + 20) {
      const aHead = alignedSolRet.slice(0, alignedSolRet.length - LAG_BARS);
      const bLag = alignedAltRet.slice(LAG_BARS);
      laggedCorr = pearson(aHead, bLag);
    }

    // Only trade pairs where SOL leads with positive correlation
    // Empirically: lagged corr is ~0.001-0.035 for all pairs (no real lead-lag exists at 8h)
    if (laggedCorr < 0.05) {
      // Uncomment to debug: console.log(`  S4 SKIP ${pair}: lagged corr=${laggedCorr.toFixed(3)}`);
      continue;
    }

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; idx: number } | null = null;
    let pendingSignal: { dir: "long" | "short"; signalBar: number } | null = null;

    for (let i = ATR_PERIOD + LAG_BARS + 1; i < cs.length; i++) {
      const bar = cs[i]!;
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      // Exit
      if (pos) {
        const isSL =
          (pos.dir === "long" && bar.l <= pos.sl) ||
          (pos.dir === "short" && bar.h >= pos.sl);

        let xp = 0;
        if (isSL) {
          xp = pos.sl;
        } else if (i - pos.idx >= 12) {
          // Max hold: 12 bars (48h) for lead-lag trades
          xp = bar.c;
        }

        if (xp > 0) {
          const slipMult = isSL ? 1.5 : 1;
          const effectiveXp = pos.dir === "long"
            ? xp * (1 - sp * slipMult)
            : xp * (1 + sp * slipMult);
          const rawPnl = pos.dir === "long"
            ? (effectiveXp / pos.ep - 1) * NOT
            : (pos.ep / effectiveXp - 1) * NOT;
          const pnl = rawPnl - NOT * FEE * 2;
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: effectiveXp, et: pos.et, xt: bar.t, pnl, reason: isSL ? "sl" : "time" });
          pos = null;
          pendingSignal = null;
        }
      }

      // Execute pending signal (enter LAG_BARS after signal)
      if (!pos && pendingSignal && i - pendingSignal.signalBar >= LAG_BARS) {
        const dir = pendingSignal.dir;
        if (dir === "long") {
          const btcDir = btcFilter.get(bar.t);
          if (btcDir !== "long") { pendingSignal = null; continue; }
        }
        const curATR = atr[i] || atr[i - 1] || 0;
        let slDist = curATR * ATR_SL_MULT;
        if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
        const sl = dir === "long" ? bar.o - slDist : bar.o + slDist;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        pos = { dir, ep, et: bar.t, sl, idx: i };
        pendingSignal = null;
      }

      // Check for SOL signal at bar i - LAG_BARS
      if (!pos && !pendingSignal) {
        const signalBarIdx = i - LAG_BARS;
        if (signalBarIdx >= 0) {
          const signalBar = cs[signalBarIdx]!;
          const solIdx = solByTs.get(signalBar.t);
          if (solIdx !== undefined && solIdx > 0) {
            const solMove = solRet[solIdx]!;
            if (Math.abs(solMove) >= SOL_MOVE_THRESHOLD) {
              const dir: "long" | "short" = solMove > 0 ? "long" : "short";
              pendingSignal = { dir, signalBar: signalBarIdx };
            }
          }
        }
      }
    }

    // Close open at end
    if (pos) {
      const lastBar = cs[cs.length - 1]!;
      const rawPnl = pos.dir === "long"
        ? (lastBar.c / pos.ep - 1) * NOT
        : (pos.ep / lastBar.c - 1) * NOT;
      const pnl = rawPnl - NOT * FEE * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────────────
//  STRATEGY 5: Volatility Dispersion
//  When alt vol diverges significantly from BTC vol (z-score > 2),
//  trade convergence: if alt vol >> BTC vol -> expect alt to calm -> fade direction.
//  If alt vol << BTC vol -> breakout coming -> trade in BTC trend direction.
// ────────────────────────────────────────────────────────────────────────────
function runS5VolDispersion(
  pairData: Map<string, C[]>,
  btc4h: C[],
  btcFilter: Map<number, "long" | "short">
): Trade[] {
  const trades: Trade[] = [];

  const VOL_WINDOW = 30 * 6;    // 30 days in 4h bars for vol estimate
  const VOL_Z_WINDOW = 60 * 6;  // 60 days for z-score normalization
  const DISP_THRESHOLD = 2.0;   // z-score threshold

  const btcRet = btc4h.map((c, i) => i === 0 ? 0 : c.c / btc4h[i - 1]!.c - 1);
  const btcByTs = new Map<number, number>();
  btc4h.forEach((c, i) => btcByTs.set(c.t, i));
  const btcVolSeries = calcRollingStd(btcRet, VOL_WINDOW);

  for (const [pair, cs] of pairData) {
    if (pair === "BTC") continue;
    const sp = SP[pair] ?? DEFAULT_SP;
    const atr = calcATR(cs, ATR_PERIOD);
    const altRet = cs.map((c, i) => i === 0 ? 0 : c.c / cs[i - 1]!.c - 1);
    const altVolSeries = calcRollingStd(altRet, VOL_WINDOW);

    // Compute vol dispersion ratio time series: alt_vol / btc_vol
    const dispRatio: number[] = cs.map((c, i) => {
      const altVol = altVolSeries[i];
      const bIdx = btcByTs.get(c.t);
      if (altVol === undefined || isNaN(altVol) || bIdx === undefined) return NaN;
      const btcVol = btcVolSeries[bIdx];
      if (btcVol === undefined || isNaN(btcVol) || btcVol < 1e-8) return NaN;
      return altVol / btcVol;
    });

    // Z-score of dispersion ratio over VOL_Z_WINDOW bars
    const dispZScore: number[] = dispRatio.map((v, i) => {
      if (isNaN(v) || i < VOL_Z_WINDOW) return NaN;
      const slice = dispRatio.slice(i - VOL_Z_WINDOW, i).filter(x => !isNaN(x));
      if (slice.length < 20) return NaN;
      const mean = slice.reduce((s, x) => s + x, 0) / slice.length;
      const std = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / slice.length);
      return std > 0 ? (v - mean) / std : 0;
    });

    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; idx: number } | null = null;

    for (let i = VOL_Z_WINDOW + VOL_WINDOW + 1; i < cs.length; i++) {
      const bar = cs[i]!;
      if (bar.t < FULL_START || bar.t > FULL_END) continue;

      const z = dispZScore[i - 1];
      if (z === undefined || isNaN(z)) continue;

      // Exit
      if (pos) {
        const isSL =
          (pos.dir === "long" && bar.l <= pos.sl) ||
          (pos.dir === "short" && bar.h >= pos.sl);

        let xp = 0;
        if (isSL) {
          xp = pos.sl;
        } else if (Math.abs(z) < 0.5) {
          // Dispersion normalized -> exit
          xp = bar.o;
        } else if (i - pos.idx >= STAG_BARS) {
          xp = bar.c;
        }

        if (xp > 0) {
          const slipMult = isSL ? 1.5 : 1;
          const effectiveXp = pos.dir === "long"
            ? xp * (1 - sp * slipMult)
            : xp * (1 + sp * slipMult);
          const rawPnl = pos.dir === "long"
            ? (effectiveXp / pos.ep - 1) * NOT
            : (pos.ep / effectiveXp - 1) * NOT;
          const pnl = rawPnl - NOT * FEE * 2;
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: effectiveXp, et: pos.et, xt: bar.t, pnl, reason: isSL ? "sl" : (i - pos.idx >= STAG_BARS ? "stag" : "z-norm") });
          pos = null;
        }
      }

      // Entry on high dispersion
      if (!pos && Math.abs(z) > DISP_THRESHOLD) {
        let dir: "long" | "short" | null = null;

        if (z > DISP_THRESHOLD) {
          // Alt vol >> BTC vol -> alt is overheating -> fade current direction
          // Determine alt direction using recent returns
          const recentRet = altRet[i - 1]!;
          if (recentRet > 0.005) dir = "short"; // alt surging in high vol -> fade
          else if (recentRet < -0.005) dir = "long"; // alt crashing in high vol -> fade
        } else if (z < -DISP_THRESHOLD) {
          // Alt vol << BTC vol -> alt compressed -> breakout likely in BTC direction
          const bIdx = btcByTs.get(bar.t);
          if (bIdx !== undefined && bIdx > 0) {
            const btcRecentRet = btcRet[bIdx]!;
            if (btcRecentRet > 0.005) dir = "long";
            else if (btcRecentRet < -0.005) dir = "short";
          }
        }

        if (dir === null) continue;
        if (dir === "long") {
          const btcDir = btcFilter.get(bar.t);
          if (btcDir !== "long") continue;
        }

        const curATR = atr[i] || atr[i - 1] || 0;
        let slDist = curATR * ATR_SL_MULT;
        if (slDist > bar.o * SL_MAX_PCT) slDist = bar.o * SL_MAX_PCT;
        const sl = dir === "long" ? bar.o - slDist : bar.o + slDist;
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);

        pos = { dir, ep, et: bar.t, sl, idx: i };
      }
    }

    // Close open at end
    if (pos) {
      const lastBar = cs[cs.length - 1]!;
      const rawPnl = pos.dir === "long"
        ? (lastBar.c / pos.ep - 1) * NOT
        : (pos.ep / lastBar.c - 1) * NOT;
      const pnl = rawPnl - NOT * FEE * 2;
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }
  }

  return trades;
}

// ────────────────────────────────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────────────────────────────────
function main() {
  console.log("=".repeat(90));
  console.log("  INTER-PAIR RELATIONSHIP STRATEGIES BACKTEST");
  console.log("  5m -> 4h | $3 margin, 10x lev | BTC EMA(12/21) filter longs | ATR*3 SL (cap 3.5%)");
  console.log("  Full: 2023-01 to 2026-03 | OOS: 2025-06-01 to 2026-03-26");
  console.log("=".repeat(90));

  // Load all data
  console.log("\nLoading 5m candle data...");
  const btc5m = load5m("BTC");
  const btc4h = aggregateTo4h(btc5m);
  console.log(`  BTC: ${btc5m.length} 5m -> ${btc4h.length} 4h bars`);

  const btcFilter = buildBtcEmaFilter(btc4h);

  const pairData = new Map<string, C[]>();
  pairData.set("BTC", btc4h);

  for (const pair of PAIRS) {
    const raw = load5m(pair);
    if (raw.length < 5000) {
      console.log(`  SKIP ${pair}: ${raw.length} 5m bars`);
      continue;
    }
    const h4 = aggregateTo4h(raw);
    if (h4.length < 100) {
      console.log(`  SKIP ${pair}: ${h4.length} 4h bars`);
      continue;
    }
    pairData.set(pair, h4);
    console.log(`  ${pair}: ${raw.length} 5m -> ${h4.length} 4h bars`);
  }

  const tradingPairs = [...pairData.keys()].filter(p => p !== "BTC");
  console.log(`\nRunning strategies on ${tradingPairs.length} pairs: ${tradingPairs.join(", ")}\n`);

  // Build reference Supertrend daily PnL for correlation
  console.log("Building Supertrend(14,2) reference equity curve...");
  const stDailyPnl = buildSupertrendDailyPnl(pairData, btcFilter);
  console.log(`  Supertrend reference: ${stDailyPnl.size} trading days\n`);

  const STRATEGIES = [
    {
      name: "S1: Beta-Weighted Mean Reversion",
      desc: "Fade excess altcoin move vs BTC beta (>2x expected), 24h max hold",
      run: () => runS1BetaMeanReversion(pairData, btc4h, btcFilter),
    },
    {
      name: "S2: Relative Strength Rotation",
      desc: "Weekly rebalance: long top-3 by 7d return, short bottom-3",
      run: () => runS2RSRotation(pairData, btcFilter),
    },
    {
      name: "S3: Correlation Breakdown",
      desc: "When rolling 30d corr vs BTC drops < 0.5, trade the decoupling",
      run: () => runS3CorrBreakdown(pairData, btc4h, btcFilter),
    },
    {
      name: "S4: Lead-Lag (SOL leads alts)",
      desc: "Enter lagging pairs 8h after SOL moves >2% (only if lagged corr > 0.05), 48h hold",
      run: () => runS4LeadLag(pairData, btcFilter),
    },
    {
      name: "S5: Volatility Dispersion",
      desc: "Fade alt when vol z-score > 2 vs BTC; breakout when vol z-score < -2",
      run: () => runS5VolDispersion(pairData, btc4h, btcFilter),
    },
  ];

  // Per-strategy top pair analysis storage
  const strategyResults: Array<{
    name: string;
    fullM: Metrics;
    oosM: Metrics;
    corrFull: number;
    corrOos: number;
    trades: Trade[];
  }> = [];

  for (const { name, desc, run } of STRATEGIES) {
    console.log("─".repeat(90));
    console.log(`\n${name}`);
    console.log(`  ${desc}\n`);

    const trades = run();
    const fullM = calcMetrics(trades, FULL_START, FULL_END);
    const oosM = calcMetrics(trades, OOS_START, FULL_END);
    const isM = calcMetrics(trades, FULL_START, OOS_START);

    printMetrics("FULL   (2023-2026)", fullM);
    printMetrics("IS     (2023-2025)", isM);
    printMetrics("OOS    (2025-2026)", oosM);

    // Correlation vs Supertrend
    const corrFull = dailyCorr(fullM.dailyPnl, stDailyPnl, FULL_START, FULL_END);
    const corrOos = dailyCorr(oosM.dailyPnl, stDailyPnl, OOS_START, FULL_END);
    console.log(`  Corr vs Supertrend: full=${corrFull.toFixed(3)}  OOS=${corrOos.toFixed(3)}`);

    // Top 5 pairs by OOS PnL
    const pairPnl = new Map<string, number>();
    const oosTrades = trades.filter(t => t.et >= OOS_START && t.et < FULL_END);
    for (const t of oosTrades) {
      pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.pnl);
    }
    const sortedPairs = [...pairPnl.entries()].sort((a, b) => b[1] - a[1]);
    if (sortedPairs.length > 0) {
      const top5 = sortedPairs.slice(0, 5).map(([p, v]) => `${p}:${fmt(v)}`).join("  ");
      const bot3 = sortedPairs.slice(-3).map(([p, v]) => `${p}:${fmt(v)}`).join("  ");
      console.log(`  OOS top pairs:    ${top5}`);
      console.log(`  OOS worst pairs:  ${bot3}`);
    }

    // Exit reason breakdown (OOS)
    if (oosTrades.length > 0) {
      const exitCounts = new Map<string, number>();
      for (const t of oosTrades) exitCounts.set(t.reason, (exitCounts.get(t.reason) ?? 0) + 1);
      const exitStr = [...exitCounts.entries()].map(([k, v]) => `${k}:${v}`).join("  ");
      console.log(`  OOS exit reasons: ${exitStr}`);
    }

    strategyResults.push({ name, fullM, oosM, corrFull, corrOos, trades });
    console.log();
  }

  // ─── Summary Table ─────────────────────────────────────────────────────────
  console.log("=".repeat(90));
  console.log("  SUMMARY TABLE");
  console.log("=".repeat(90));
  console.log(
    "\n  " +
    "Strategy".padEnd(36) +
    "N".padStart(5) + " WR%".padStart(6) + "  PF".padStart(6) +
    " $/day".padStart(7) + " MaxDD".padStart(7) + " | OOS:" +
    "N".padStart(5) + " WR%".padStart(6) + "  PF".padStart(6) +
    " $/day".padStart(7) + " MaxDD".padStart(7) +
    " Corr-ST"
  );
  console.log("  " + "-".repeat(115));

  for (const { name, fullM: f, oosM: o, corrOos } of strategyResults) {
    const shortName = name.replace("S", "").slice(0, 35);
    const fpf = f.pf === Infinity ? " INF" : f.pf.toFixed(2);
    const opf = o.pf === Infinity ? " INF" : o.pf.toFixed(2);
    console.log(
      "  " + shortName.padEnd(36) +
      String(f.n).padStart(5) + ("  " + f.wr.toFixed(1) + "%").padStart(6) + ("  " + fpf).padStart(6) +
      ("  " + f.perDay.toFixed(3)).padStart(7) + ("  $" + f.dd.toFixed(0)).padStart(7) +
      " | " +
      String(o.n).padStart(5) + ("  " + o.wr.toFixed(1) + "%").padStart(6) + ("  " + opf).padStart(6) +
      ("  " + o.perDay.toFixed(3)).padStart(7) + ("  $" + o.dd.toFixed(0)).padStart(7) +
      "  " + corrOos.toFixed(3)
    );
  }

  // ─── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(90));
  console.log("  VERDICTS (OOS performance)");
  console.log("=".repeat(90));

  for (const { name, oosM: o, corrOos } of strategyResults) {
    let verdict = "DEAD";
    let reason = "";

    if (o.n === 0) {
      reason = "no trades (strategy did not generate signals)";
    } else if (o.pf < 1.0) {
      reason = `PF ${o.pf.toFixed(2)} < 1.0 (net losing after fees)`;
    } else if (o.perDay <= 0) {
      reason = `total negative despite PF > 1`;
    } else if (o.n < 15) {
      reason = `only ${o.n} OOS trades, sample too small for confidence`;
    } else {
      verdict = "CANDIDATE";
      reason = `PF ${o.pf.toFixed(2)}  WR ${o.wr.toFixed(1)}%  ${fmt(o.perDay)}/day  N=${o.n}`;
      if (o.pf >= 1.5 && o.perDay >= 0.05 && o.n >= 30) {
        verdict = "STRONG";
      } else if (o.pf >= 1.5 && o.n < 30) {
        verdict = "CANDIDATE"; // good PF but small sample
        reason += "  (small sample, needs more data)";
      }
    }

    const corrNote = corrOos < 0.2 ? " (low corr w/ Supertrend, additive)" :
      corrOos > 0.5 ? " (high corr w/ Supertrend, redundant)" : "";

    console.log(`  ${name}`);
    console.log(`    Verdict: ${verdict} - ${reason}${corrNote}`);
  }

  console.log("\n" + "=".repeat(90));
  console.log("  DONE");
  console.log("=".repeat(90));
}

main();
