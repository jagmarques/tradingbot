/**
 * OI Composite Backtest - Volume as OI proxy + Funding proxy + Price extension
 *
 * Strategies:
 *   1. Contrarian Fade: crowded + extended -> fade
 *   2. Momentum Confirmation: crowded + extended -> trade with crowd
 *   3. Volume-Only on Supertrend: volume z > 1.5 filter on ST(14,1.75) flips
 *   3b. Supertrend Simple Vol: h4Bar.v > 1.5x avg (existing filter from bt-engine-combos)
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-oi-composite.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const M5 = 300_000;
const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIPPAGE = 1.5;

const SPREAD: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, SUI: 1.85e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, AVAX: 2.55e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4,
  APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4,
  WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
  BTC: 0.5e-4,
};
const DFLT_SPREAD = 4e-4;

const WANTED_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
];

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-27").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; engine: string; dir: Dir;
  ep: number; et: number; sl: number; tp: number;
  margin: number; lev: number; maxHold: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; engine: string; dir: Dir;
  ep: number; xp: number; et: number; xt: number; pnl: number; margin: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_DIR, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) => ({
    t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0),
  })).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(candles: C[], period: number): Bar[] {
  const groups = new Map<number, C[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / period) * period;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(c);
  }
  const bars: Bar[] = [];
  for (const [t, cs] of groups) {
    if (cs.length === 0) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const c of cs) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      vol += c.v;
    }
    bars.push({ t, o: cs[0].o, h: hi, l: lo, c: cs[cs.length - 1].c, v: vol });
  }
  return bars.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function sma(vals: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) r[i] = sum / period;
  }
  return r;
}

function atrFn(bars: Bar[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(bars.length).fill(null);
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0
      ? bars[i].h - bars[i].l
      : Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - bars[i - 1].c),
          Math.abs(bars[i].l - bars[i - 1].c)
        );
    trs.push(tr);
  }
  let val = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      val += trs[i];
      if (i === period - 1) { val /= period; r[i] = val; }
    } else {
      val = (val * (period - 1) + trs[i]) / period;
      r[i] = val;
    }
  }
  return r;
}

function supertrend(bars: Bar[], atrPeriod: number, mult: number): { trend: (1 | -1 | null)[] } {
  const atrVals = atrFn(bars, atrPeriod);
  const trend: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upperBand = 0, lowerBand = 0, prevTrend = 1;

  for (let i = 0; i < bars.length; i++) {
    const a = atrVals[i];
    if (a === null) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    let ub = hl2 + mult * a;
    let lb = hl2 - mult * a;

    if (i > 0 && atrVals[i - 1] !== null) {
      if (lb > lowerBand || bars[i - 1].c < lowerBand) { /* keep lb */ } else lb = lowerBand;
      if (ub < upperBand || bars[i - 1].c > upperBand) { /* keep ub */ } else ub = upperBand;
    }

    let t: 1 | -1;
    if (prevTrend === 1) {
      t = bars[i].c < lowerBand ? -1 : 1;
    } else {
      t = bars[i].c > upperBand ? 1 : -1;
    }

    upperBand = ub;
    lowerBand = lb;
    prevTrend = t;
    trend[i] = t;
  }
  return { trend };
}

// ─── OI Composite Signal ────────────────────────────────────────────
interface OISignal {
  volZ: number;
  fundingZ: number;
  priceZ: number;
  composite: number;
}

function computeOISignals(bars: Bar[]): OISignal[] {
  const signals: OISignal[] = new Array(bars.length).fill(null).map(() => ({
    volZ: 0, fundingZ: 0, priceZ: 0, composite: 0,
  }));

  const vols = bars.map(b => b.v);
  const closes = bars.map(b => b.c);
  const fundingProxy = bars.map(b => b.c !== 0 ? (b.c - b.o) / b.c : 0);

  // Volume z-score (20-bar)
  const volSma = sma(vols, 20);
  for (let i = 20; i < bars.length; i++) {
    const avg = volSma[i];
    if (avg === null || avg <= 0) continue;
    let sum2 = 0;
    for (let j = i - 19; j <= i; j++) sum2 += (vols[j] - avg) ** 2;
    const std = Math.sqrt(sum2 / 20);
    if (std > 0) signals[i].volZ = (vols[i] - avg) / std;
  }

  // Funding proxy z-score (50-bar)
  const fpSma = sma(fundingProxy, 50);
  for (let i = 50; i < bars.length; i++) {
    const avg = fpSma[i];
    if (avg === null) continue;
    let sum2 = 0;
    for (let j = i - 49; j <= i; j++) sum2 += (fundingProxy[j] - avg) ** 2;
    const std = Math.sqrt(sum2 / 50);
    if (std > 0) signals[i].fundingZ = (fundingProxy[i] - avg) / std;
  }

  // Price extension z-score (close vs 20-bar SMA)
  const priceSma = sma(closes, 20);
  for (let i = 20; i < bars.length; i++) {
    const avg = priceSma[i];
    if (avg === null || avg <= 0) continue;
    let sum2 = 0;
    for (let j = i - 19; j <= i; j++) {
      const pSma = priceSma[j];
      if (pSma !== null) sum2 += (closes[j] - pSma) ** 2;
    }
    const std = Math.sqrt(sum2 / 20);
    if (std > 0) signals[i].priceZ = (closes[i] - avg) / std;
  }

  // Composite
  for (let i = 0; i < bars.length; i++) {
    const s = signals[i];
    s.composite = Math.abs(s.volZ) * Math.sign(s.fundingZ) * Math.sign(s.priceZ);
  }

  return signals;
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h4: Bar[];
  h4Map: Map<number, number>;
}

function prepPair(m5: C[]): PairData {
  const h4 = aggregate(m5, H4);
  return {
    m5, h4,
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
  };
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Global data ────────────────────────────────────────────────────
let available: string[] = [];
let pairData: Map<string, PairData>;
let pairSignals: Map<string, OISignal[]>;
let pairST: Map<string, (1 | -1 | null)[]>;
let pairATR: Map<string, (number | null)[]>;

function loadAllData() {
  console.log("Loading data...");
  pairData = new Map();
  pairSignals = new Map();
  pairST = new Map();
  pairATR = new Map();
  available = [];

  for (const p of WANTED_PAIRS) {
    const m5 = load5m(p);
    if (m5.length < 500) continue;
    available.push(p);
    const pd = prepPair(m5);
    pairData.set(p, pd);

    // Compute OI signals on 4h bars
    pairSignals.set(p, computeOISignals(pd.h4));

    // Supertrend for strategy 3
    pairST.set(p, supertrend(pd.h4, 14, 1.75).trend);
    pairATR.set(p, atrFn(pd.h4, 14));
  }
  console.log(`Loaded ${available.length} pairs: ${available.join(", ")}`);
  console.log("OI composite signals + Supertrend computed.\n");
}

// ─── Backtest Runner ────────────────────────────────────────────────
type StrategyFn = (
  pair: string, h4i: number, h4: Bar[], sig: OISignal[], st: (1 | -1 | null)[], atrVals: (number | null)[]
) => { dir: Dir; sl: number; ep: number; maxHold: number; margin: number; atr: number } | null;

function runBacktest(stratName: string, stratFn: StrategyFn): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  // Walk through time: iterate each 4h bar
  // Collect all h4 timestamps across pairs
  const allH4Times = new Set<number>();
  for (const p of available) {
    const pd = pairData.get(p)!;
    for (const bar of pd.h4) {
      if (bar.t >= FULL_START && bar.t < FULL_END) allH4Times.add(bar.t);
    }
  }
  const h4Timestamps = [...allH4Times].sort((a, b) => a - b);

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair);
    const xp = pos.dir === "long"
      ? exitPrice * (1 - sp_ * slippageMult)
      : exitPrice * (1 + sp_ * slippageMult);
    const notional = pos.margin * pos.lev;
    const raw = pos.dir === "long"
      ? (xp / pos.ep - 1) * notional
      : (pos.ep / xp - 1) * notional;
    const cost = notional * FEE * 2;
    const pnl = raw - cost;
    trades.push({
      pair: pos.pair, engine: stratName, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    });
    positions.delete(key);
  }

  for (const h4T of h4Timestamps) {
    // Check existing positions
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairData.get(pos.pair);
      if (!pd) continue;
      const h4i = pd.h4Map.get(h4T);
      if (h4i === undefined) continue;
      const bar = pd.h4[h4i];

      // Stop-loss check using high/low
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, h4T, SL_SLIPPAGE);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, h4T, SL_SLIPPAGE);
        continue;
      }

      // TP check
      if (pos.tp > 0) {
        if (pos.dir === "long" && bar.h >= pos.tp) {
          closePosition(key, pos.tp, h4T); continue;
        }
        if (pos.dir === "short" && bar.l <= pos.tp) {
          closePosition(key, pos.tp, h4T); continue;
        }
      }

      // Max hold
      if (h4T - pos.et >= pos.maxHold) {
        closePosition(key, bar.c, h4T); continue;
      }

      // ATR trailing (breakeven at 1 ATR, trail at 2+ ATR)
      if (pos.atr > 0) {
        const unrealPnl = pos.dir === "long"
          ? (bar.c - pos.ep) / pos.atr
          : (pos.ep - bar.c) / pos.atr;
        if (unrealPnl > pos.bestPnlAtr) pos.bestPnlAtr = unrealPnl;

        let newSl = pos.sl;
        if (pos.bestPnlAtr >= 3) {
          const trailPrice = pos.dir === "long"
            ? pos.ep + (pos.bestPnlAtr - 1.5) * pos.atr
            : pos.ep - (pos.bestPnlAtr - 1.5) * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 2) {
          const trailPrice = pos.dir === "long"
            ? bar.h - 2 * pos.atr
            : bar.l + 2 * pos.atr;
          newSl = pos.dir === "long" ? Math.max(pos.sl, trailPrice) : Math.min(pos.sl, trailPrice);
        } else if (pos.bestPnlAtr >= 1) {
          newSl = pos.dir === "long" ? Math.max(pos.sl, pos.ep) : Math.min(pos.sl, pos.ep);
        }
        pos.sl = newSl;
      }
    }

    // New entries
    for (const p of available) {
      const key = `${stratName}:${p}`;
      if (positions.has(key)) continue;

      const pd = pairData.get(p)!;
      const h4i = pd.h4Map.get(h4T);
      if (h4i === undefined || h4i < 51) continue;

      const sig = pairSignals.get(p)!;
      const st = pairST.get(p)!;
      const atrVals = pairATR.get(p)!;

      const result = stratFn(p, h4i, pd.h4, sig, st, atrVals);
      if (!result) continue;

      positions.set(key, {
        pair: p, engine: stratName, dir: result.dir,
        ep: result.ep, et: h4T, sl: result.sl, tp: 0,
        margin: result.margin, lev: 10, maxHold: result.maxHold,
        atr: result.atr, bestPnlAtr: 0,
      });
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairData.get(pos.pair);
    if (!pd || pd.h4.length === 0) continue;
    const lastBar = pd.h4[pd.h4.length - 1];
    closePosition(key, lastBar.c, lastBar.t);
  }

  return trades;
}

// ─── Strategy Definitions ───────────────────────────────────────────

// 1. Contrarian Fade
const contrarian: StrategyFn = (pair, h4i, h4, sig, _st, atrVals) => {
  // Use signals from completed bar (i-1), enter at open of current bar (i)
  const s = sig[h4i - 1];
  if (!s) return null;

  let dir: Dir | null = null;
  // Crowded longs + overextended up -> SHORT
  if (s.volZ > 2 && s.fundingZ > 2 && s.priceZ > 2) dir = "short";
  // Crowded shorts + oversold -> LONG
  if (s.volZ > 2 && s.fundingZ < -2 && s.priceZ < -2) dir = "long";
  if (!dir) return null;

  const atr = atrVals[h4i - 1];
  if (atr === null) return null;

  const sp_ = sp(pair);
  const ep = dir === "long" ? h4[h4i].o * (1 + sp_) : h4[h4i].o * (1 - sp_);
  let slDist = ep * 0.03;
  if (slDist / ep > 0.035) slDist = ep * 0.035;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, ep, sl, maxHold: 48 * H1, margin: 5, atr };
};

// 2. Momentum Confirmation
const momentum: StrategyFn = (pair, h4i, h4, sig, _st, atrVals) => {
  const s = sig[h4i - 1];
  if (!s) return null;

  let dir: Dir | null = null;
  // Volume + positive funding + price going up -> LONG with momentum
  if (s.volZ > 2 && s.fundingZ > 2 && s.priceZ > 1) dir = "long";
  // Volume + negative funding + price going down -> SHORT with momentum
  if (s.volZ > 2 && s.fundingZ < -2 && s.priceZ < -1) dir = "short";
  if (!dir) return null;

  const atr = atrVals[h4i - 1];
  if (atr === null) return null;

  const sp_ = sp(pair);
  const ep = dir === "long" ? h4[h4i].o * (1 + sp_) : h4[h4i].o * (1 - sp_);
  let slDist = ep * 0.03;
  if (slDist / ep > 0.035) slDist = ep * 0.035;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, ep, sl, maxHold: 48 * H1, margin: 5, atr };
};

// 3. Volume z-score filter on Supertrend flips
const stVolZ: StrategyFn = (pair, h4i, h4, sig, st, atrVals) => {
  // Supertrend flip detection (bar i-1 vs i-2)
  const stNow = st[h4i - 1];
  const stPrev = st[h4i - 2];
  if (stNow === null || stPrev === null || stNow === stPrev) return null;

  // Volume z > 1.5 from OI signal on bar i-1
  const s = sig[h4i - 1];
  if (!s || s.volZ < 1.5) return null;

  const dir: Dir = stNow === 1 ? "long" : "short";

  const atr = atrVals[h4i - 1];
  if (atr === null) return null;

  const sp_ = sp(pair);
  const ep = dir === "long" ? h4[h4i].o * (1 + sp_) : h4[h4i].o * (1 - sp_);
  let slDist = atr * 3;
  if (slDist / ep > 0.035) slDist = ep * 0.035;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, ep, sl, maxHold: 60 * DAY, margin: 5, atr };
};

// 3b. Supertrend with simple volume filter (baseline comparison)
const stSimpleVol: StrategyFn = (pair, h4i, h4, _sig, st, atrVals) => {
  const stNow = st[h4i - 1];
  const stPrev = st[h4i - 2];
  if (stNow === null || stPrev === null || stNow === stPrev) return null;

  // Simple vol filter: bar volume > 1.5x 20-bar avg
  const bar = h4[h4i - 1];
  let volSum = 0;
  for (let j = h4i - 21; j < h4i - 1; j++) {
    if (j >= 0) volSum += h4[j].v;
  }
  const avgVol = volSum / 20;
  if (avgVol <= 0 || bar.v < 1.5 * avgVol) return null;

  const dir: Dir = stNow === 1 ? "long" : "short";

  const atr = atrVals[h4i - 1];
  if (atr === null) return null;

  const sp_ = sp(pair);
  const ep = dir === "long" ? h4[h4i].o * (1 + sp_) : h4[h4i].o * (1 - sp_);
  let slDist = atr * 3;
  if (slDist / ep > 0.035) slDist = ep * 0.035;
  const sl = dir === "long" ? ep - slDist : ep + slDist;

  return { dir, ep, sl, maxHold: 60 * DAY, margin: 5, atr };
};

// ─── Stats ──────────────────────────────────────────────────────────
interface Stats {
  trades: number; pf: number; sharpe: number; perDay: number; wr: number;
  maxDd: number; maxDdDuration: string; recoveryDays: number;
  totalPnl: number; avgPnl: number; winners: number; losers: number;
}

function computeStats(trades: Trade[], startMs: number, endMs: number): Stats {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  if (filtered.length === 0) return {
    trades: 0, pf: 0, sharpe: 0, perDay: 0, wr: 0,
    maxDd: 0, maxDdDuration: "0d", recoveryDays: 0, totalPnl: 0, avgPnl: 0,
    winners: 0, losers: 0,
  };

  const sorted = [...filtered].sort((a, b) => a.xt - b.xt);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const wr = filtered.length > 0 ? wins.length / filtered.length : 0;

  const days = (endMs - startMs) / DAY;
  const perDay = totalPnl / days;

  const dailyPnl = new Map<number, number>();
  for (const t of sorted) {
    const d = Math.floor(t.xt / DAY) * DAY;
    dailyPnl.set(d, (dailyPnl.get(d) ?? 0) + t.pnl);
  }
  const dpVals = [...dailyPnl.values()];
  const mean = dpVals.length > 0 ? dpVals.reduce((a, b) => a + b, 0) / dpVals.length : 0;
  const std = dpVals.length > 1
    ? Math.sqrt(dpVals.reduce((s, v) => s + (v - mean) ** 2, 0) / (dpVals.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let equity = 0, peak = 0, maxDd = 0, maxDdStart = startMs, maxDdEnd = startMs;
  let currentDdStart = startMs;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) { peak = equity; currentDdStart = t.xt; }
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdStart = currentDdStart; maxDdEnd = t.xt; }
  }
  const ddDurationDays = Math.round((maxDdEnd - maxDdStart) / DAY);

  let recoveryDays = 0;
  let foundTrough = false;
  equity = 0; peak = 0; let troughTime = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) {
      if (foundTrough) { recoveryDays = Math.round((t.xt - troughTime) / DAY); foundTrough = false; }
      peak = equity;
    }
    if (peak - equity >= maxDd * 0.99 && !foundTrough) { foundTrough = true; troughTime = t.xt; }
  }

  return {
    trades: filtered.length,
    pf: Math.round(pf * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    perDay: Math.round(perDay * 100) / 100,
    wr: Math.round(wr * 1000) / 10,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdDuration: `${ddDurationDays}d`,
    recoveryDays,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgPnl: Math.round((totalPnl / filtered.length) * 100) / 100,
    winners: wins.length,
    losers: losses.length,
  };
}

// ─── Output Helpers ─────────────────────────────────────────────────
function pad(s: string, n: number): string { return s.padStart(n); }
function fmtPnl(v: number): string { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function fmtPct(v: number): string { return v.toFixed(1) + "%"; }

function printHeader() {
  console.log(
    `${"Period".padEnd(20)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
    `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
  );
  console.log("-".repeat(100));
}

function printStatsLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(20)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ` +
    `${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

// ─── Pair-level breakdown ───────────────────────────────────────────
function printPairBreakdown(trades: Trade[], startMs: number, endMs: number) {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  const byPair = new Map<string, Trade[]>();
  for (const t of filtered) {
    if (!byPair.has(t.pair)) byPair.set(t.pair, []);
    byPair.get(t.pair)!.push(t);
  }

  const rows: { pair: string; n: number; pnl: number; wr: number }[] = [];
  for (const [pair, pts] of byPair) {
    const pnl = pts.reduce((s, t) => s + t.pnl, 0);
    const wins = pts.filter(t => t.pnl > 0).length;
    rows.push({ pair, n: pts.length, pnl, wr: pts.length > 0 ? wins / pts.length * 100 : 0 });
  }
  rows.sort((a, b) => b.pnl - a.pnl);

  console.log(`  ${"Pair".padEnd(8)} ${pad("Trades", 6)} ${pad("WR", 7)} ${pad("PnL", 10)}`);
  for (const r of rows) {
    console.log(
      `  ${r.pair.padEnd(8)} ${pad(String(r.n), 6)} ${pad(r.wr.toFixed(1) + "%", 7)} ${pad(fmtPnl(r.pnl), 10)}`
    );
  }
}

// ─── Direction breakdown ────────────────────────────────────────────
function printDirBreakdown(trades: Trade[], startMs: number, endMs: number) {
  const filtered = trades.filter(t => t.et >= startMs && t.et < endMs);
  for (const dir of ["long", "short"] as Dir[]) {
    const dt = filtered.filter(t => t.dir === dir);
    if (dt.length === 0) continue;
    const pnl = dt.reduce((s, t) => s + t.pnl, 0);
    const wins = dt.filter(t => t.pnl > 0).length;
    console.log(
      `  ${dir.toUpperCase().padEnd(8)} ${pad(String(dt.length), 6)} trades, ` +
      `WR ${(wins / dt.length * 100).toFixed(1)}%, PnL ${fmtPnl(pnl)}`
    );
  }
}

// ─── Signal Distribution Stats ──────────────────────────────────────
function printSignalDistribution() {
  console.log("\n--- OI Composite Signal Distribution (4h bars, all pairs) ---");

  let totalBars = 0;
  let volGt2 = 0, volGt1_5 = 0;
  let fundGt2 = 0, fundLtN2 = 0;
  let priceGt2 = 0, priceLtN2 = 0;
  let allThreeAlign = 0;

  for (const p of available) {
    const sig = pairSignals.get(p)!;
    const pd = pairData.get(p)!;
    for (let i = 51; i < sig.length; i++) {
      if (pd.h4[i].t < FULL_START || pd.h4[i].t >= FULL_END) continue;
      totalBars++;
      const s = sig[i];
      if (s.volZ > 2) volGt2++;
      if (s.volZ > 1.5) volGt1_5++;
      if (s.fundingZ > 2) fundGt2++;
      if (s.fundingZ < -2) fundLtN2++;
      if (s.priceZ > 2) priceGt2++;
      if (s.priceZ < -2) priceLtN2++;
      if (s.volZ > 2 && (Math.abs(s.fundingZ) > 2) && (Math.abs(s.priceZ) > 2)) allThreeAlign++;
    }
  }

  console.log(`  Total 4h bars: ${totalBars}`);
  console.log(`  Volume z > 2: ${volGt2} (${(volGt2/totalBars*100).toFixed(2)}%)`);
  console.log(`  Volume z > 1.5: ${volGt1_5} (${(volGt1_5/totalBars*100).toFixed(2)}%)`);
  console.log(`  Funding z > 2: ${fundGt2} (${(fundGt2/totalBars*100).toFixed(2)}%)`);
  console.log(`  Funding z < -2: ${fundLtN2} (${(fundLtN2/totalBars*100).toFixed(2)}%)`);
  console.log(`  Price z > 2: ${priceGt2} (${(priceGt2/totalBars*100).toFixed(2)}%)`);
  console.log(`  Price z < -2: ${priceLtN2} (${(priceLtN2/totalBars*100).toFixed(2)}%)`);
  console.log(`  All three extreme (|z|>2): ${allThreeAlign} (${(allThreeAlign/totalBars*100).toFixed(3)}%)`);
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  OI COMPOSITE BACKTEST - Volume as OI proxy + Funding proxy + Price extension");
console.log("  18 pairs, 2023-01 to 2026-03, 5m->4h candles");
console.log("  Cost: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x leverage");
console.log("  OOS: 2025-09-01+");
console.log("=".repeat(110));

loadAllData();
printSignalDistribution();

const strategies: { name: string; fn: StrategyFn; desc: string }[] = [
  { name: "Contrarian", fn: contrarian, desc: "Crowded+Extended -> Fade (Vol>2, |Fund|>2, |Price|>2, SL 3%, 48h hold)" },
  { name: "Momentum", fn: momentum, desc: "Crowded+Extended -> With crowd (Vol>2, |Fund|>2, |Price|>1, SL 3%, 48h hold)" },
  { name: "ST+VolZ", fn: stVolZ, desc: "Supertrend(14,1.75) flip + Volume z > 1.5 filter (ATR SL, trend hold)" },
  { name: "ST+SimpleVol", fn: stSimpleVol, desc: "Supertrend(14,1.75) flip + bar.v > 1.5x avg (ATR SL, trend hold)" },
];

for (const strat of strategies) {
  console.log("\n" + "#".repeat(110));
  console.log(`  STRATEGY: ${strat.name}`);
  console.log(`  ${strat.desc}`);
  console.log("#".repeat(110));

  const trades = runBacktest(strat.name, strat.fn);

  // Full period
  console.log("\n--- Full Period ---");
  printHeader();
  printStatsLine("Full 2023-2026", computeStats(trades, FULL_START, FULL_END));

  // OOS
  console.log("\n--- OOS (2025-09-01+) ---");
  printHeader();
  printStatsLine("OOS", computeStats(trades, OOS_START, FULL_END));

  // Per year
  console.log("\n--- Per Year ---");
  printHeader();
  for (const year of [2023, 2024, 2025, 2026]) {
    const ys = new Date(`${year}-01-01`).getTime();
    const ye = new Date(`${year + 1}-01-01`).getTime();
    const s = computeStats(trades, ys, Math.min(ye, FULL_END));
    if (s.trades > 0) printStatsLine(String(year), s);
  }

  // Direction breakdown
  console.log("\n--- Direction Breakdown (Full) ---");
  printDirBreakdown(trades, FULL_START, FULL_END);
  console.log("--- Direction Breakdown (OOS) ---");
  printDirBreakdown(trades, OOS_START, FULL_END);

  // Top/bottom pairs
  console.log("\n--- Pair Breakdown (Full) ---");
  printPairBreakdown(trades, FULL_START, FULL_END);
  console.log("\n--- Pair Breakdown (OOS) ---");
  printPairBreakdown(trades, OOS_START, FULL_END);
}

console.log("\n" + "=".repeat(110));
console.log("  DONE");
console.log("=".repeat(110));
