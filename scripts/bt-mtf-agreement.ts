/**
 * Multi-Timeframe Agreement Backtest
 * Tests whether requiring multiple timeframes to agree improves Supertrend entries.
 *
 * Strategies:
 *   1. Baseline: Supertrend(14,1.75) on 4h + volume filter. No MTF.
 *   2. 4h + Daily SMA agreement: daily SMA(20)>SMA(50) for longs, < for shorts.
 *   3. 4h + 1h agreement: 1h Supertrend(10,1.5) must agree.
 *   4. Triple: 4h ST + daily SMA + 1h ST all agree.
 *   5. 4h ST + daily RSI(14) confirmation (>50 long, <50 short).
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-mtf-agreement.ts
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
const MARGIN = 5;
const LEV = 10;
const MAX_POSITIONS = 20;
const MAX_HOLD = 60 * DAY;

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
const FULL_END   = new Date("2026-03-27").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }
type Dir = "long" | "short";

interface Position {
  pair: string; dir: Dir;
  ep: number; et: number; sl: number;
  margin: number; lev: number;
  atr: number; bestPnlAtr: number;
}

interface Trade {
  pair: string; dir: Dir;
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

function rsi(closes: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return r;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  r[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return r;
}

// ─── Data Prep ──────────────────────────────────────────────────────
interface PairData {
  m5: C[]; h1: Bar[]; h4: Bar[]; daily: Bar[];
  h1Map: Map<number, number>; h4Map: Map<number, number>; dailyMap: Map<number, number>;
}

interface PairIndicators {
  // 4h
  st4h: (1 | -1 | null)[];
  atr4h: (number | null)[];
  // 1h
  st1h: (1 | -1 | null)[];
  // daily
  dailySma20: (number | null)[];
  dailySma50: (number | null)[];
  dailyRsi14: (number | null)[];
}

function prepPair(m5: C[]): PairData {
  const h1 = aggregate(m5, H1);
  const h4 = aggregate(m5, H4);
  const daily = aggregate(m5, DAY);
  return {
    m5, h1, h4, daily,
    h1Map: new Map(h1.map((b, i) => [b.t, i])),
    h4Map: new Map(h4.map((b, i) => [b.t, i])),
    dailyMap: new Map(daily.map((b, i) => [b.t, i])),
  };
}

function computeIndicators(pd: PairData): PairIndicators {
  const dc = pd.daily.map(b => b.c);
  return {
    st4h: supertrend(pd.h4, 14, 1.75).trend,
    atr4h: atrFn(pd.h4, 14),
    st1h: supertrend(pd.h1, 10, 1.5).trend,
    dailySma20: sma(dc, 20),
    dailySma50: sma(dc, 50),
    dailyRsi14: rsi(dc, 14),
  };
}

function getBarAtOrBefore(barMap: Map<number, number>, t: number, period: number): number {
  const aligned = Math.floor(t / period) * period;
  const idx = barMap.get(aligned);
  if (idx !== undefined) return idx;
  for (let dt = period; dt <= 10 * period; dt += period) {
    const idx2 = barMap.get(aligned - dt);
    if (idx2 !== undefined) return idx2;
  }
  return -1;
}

function sp(pair: string): number { return SPREAD[pair] ?? DFLT_SPREAD; }

// ─── Strategy Type ──────────────────────────────────────────────────
type StrategyFilter = (
  pair: string, dir: Dir, h4T: number,
  pd: PairData, ind: PairIndicators, h4i: number
) => boolean;

interface StrategyConfig {
  label: string;
  filter: StrategyFilter;
}

// ─── Strategy Filters ───────────────────────────────────────────────
// 1. Baseline: no additional filter (volume already checked in core)
const baseline: StrategyFilter = () => true;

// 2. 4h + Daily SMA agreement
const dailySmaFilter: StrategyFilter = (_pair, dir, h4T, pd, ind) => {
  const di = getBarAtOrBefore(pd.dailyMap, h4T - DAY, DAY);
  if (di < 0) return false;
  const s20 = ind.dailySma20[di];
  const s50 = ind.dailySma50[di];
  if (s20 === null || s50 === null) return false;
  if (dir === "long") return s20 > s50;
  return s20 < s50;
};

// 3. 4h + 1h Supertrend agreement
const h1StFilter: StrategyFilter = (_pair, dir, h4T, pd, ind) => {
  const h1i = getBarAtOrBefore(pd.h1Map, h4T - H1, H1);
  if (h1i < 0) return false;
  const st1h = ind.st1h[h1i];
  if (st1h === null) return false;
  if (dir === "long") return st1h === 1;
  return st1h === -1;
};

// 4. Triple agreement: 4h ST + daily SMA + 1h ST
const tripleFilter: StrategyFilter = (pair, dir, h4T, pd, ind, h4i) => {
  return dailySmaFilter(pair, dir, h4T, pd, ind, h4i) &&
         h1StFilter(pair, dir, h4T, pd, ind, h4i);
};

// 5. 4h ST + daily RSI(14) > 50 for longs, < 50 for shorts
const dailyRsiFilter: StrategyFilter = (_pair, dir, h4T, pd, ind) => {
  const di = getBarAtOrBefore(pd.dailyMap, h4T - DAY, DAY);
  if (di < 0) return false;
  const r = ind.dailyRsi14[di];
  if (r === null) return false;
  if (dir === "long") return r > 50;
  return r < 50;
};

const STRATEGIES: StrategyConfig[] = [
  { label: "1. Baseline (4h ST only)", filter: baseline },
  { label: "2. 4h + Daily SMA", filter: dailySmaFilter },
  { label: "3. 4h + 1h ST agree", filter: h1StFilter },
  { label: "4. Triple (4h+D+1h)", filter: tripleFilter },
  { label: "5. 4h + Daily RSI>50", filter: dailyRsiFilter },
];

// ─── Backtest Engine ────────────────────────────────────────────────
function runBacktest(
  stratFilter: StrategyFilter,
  allPairs: string[],
  pairDataMap: Map<string, PairData>,
  indMap: Map<string, PairIndicators>,
  spreadMult: number,
): Trade[] {
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];

  // Build timeline of all 4h timestamps across all pairs
  const h4Timestamps = new Set<number>();
  for (const p of allPairs) {
    const pd = pairDataMap.get(p)!;
    for (const bar of pd.h4) {
      if (bar.t >= FULL_START && bar.t < FULL_END) h4Timestamps.add(bar.t);
    }
  }
  const sortedH4 = [...h4Timestamps].sort((a, b) => a - b);

  function closePosition(key: string, exitPrice: number, exitTime: number, slippageMult: number = 1) {
    const pos = positions.get(key);
    if (!pos) return;
    const sp_ = sp(pos.pair) * spreadMult;
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
      pair: pos.pair, dir: pos.dir,
      ep: pos.ep, xp, et: pos.et, xt: exitTime, pnl, margin: pos.margin,
    });
    positions.delete(key);
  }

  for (const h4T of sortedH4) {
    // ─── Check existing positions ─────────────────────────────────
    for (const [key, pos] of [...positions.entries()]) {
      const pd = pairDataMap.get(pos.pair);
      if (!pd) continue;

      const h4i = pd.h4Map.get(h4T);
      if (h4i === undefined) continue;
      const bar = pd.h4[h4i];

      // Stop-loss
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePosition(key, pos.sl, h4T, SL_SLIPPAGE); continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePosition(key, pos.sl, h4T, SL_SLIPPAGE); continue;
      }

      // Max hold
      if (h4T - pos.et >= MAX_HOLD) {
        closePosition(key, bar.c, h4T); continue;
      }

      // Breakeven + ATR trailing ladder (same as reference)
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

      // Signal-flip exit: if supertrend flips against us, close
      const ind = indMap.get(pos.pair)!;
      const stNow = ind.st4h[h4i];
      if (stNow !== null) {
        if (pos.dir === "long" && stNow === -1) { closePosition(key, bar.c, h4T); continue; }
        if (pos.dir === "short" && stNow === 1) { closePosition(key, bar.c, h4T); continue; }
      }
    }

    // ─── New entries ──────────────────────────────────────────────
    for (const p of allPairs) {
      if (positions.size >= MAX_POSITIONS) break;
      const key = `ST:${p}`;
      if (positions.has(key)) continue;

      const pd = pairDataMap.get(p)!;
      const ind = indMap.get(p)!;
      const h4i = pd.h4Map.get(h4T);
      if (h4i === undefined || h4i < 21) continue;

      // Supertrend flip detection (previous bar)
      const stNow = ind.st4h[h4i - 1];
      const stPrev = ind.st4h[h4i - 2];
      if (stNow === null || stPrev === null || stNow === stPrev) continue;

      const dir: Dir = stNow === 1 ? "long" : "short";

      // Volume filter: signal bar volume > 1.5x 20-bar avg
      const h4Bar = pd.h4[h4i - 1];
      let volSum = 0;
      for (let j = h4i - 21; j < h4i - 1; j++) {
        if (j >= 0) volSum += pd.h4[j].v;
      }
      const avgVol = volSum / 20;
      if (avgVol <= 0 || h4Bar.v < 1.5 * avgVol) continue;

      // Apply strategy-specific MTF filter
      if (!stratFilter(p, dir, h4T, pd, ind, h4i)) continue;

      // ATR stop
      const atrVal = ind.atr4h[h4i - 1];
      if (atrVal === null) continue;

      const sp_ = sp(p) * spreadMult;
      const ep = dir === "long"
        ? pd.h4[h4i].o * (1 + sp_)
        : pd.h4[h4i].o * (1 - sp_);
      let slDist = atrVal * 3;
      if (slDist / ep > 0.035) slDist = ep * 0.035;
      const sl = dir === "long" ? ep - slDist : ep + slDist;

      positions.set(key, {
        pair: p, dir, ep, et: h4T, sl,
        margin: MARGIN, lev: LEV, atr: atrVal, bestPnlAtr: 0,
      });
    }
  }

  // Close remaining
  for (const [key, pos] of [...positions.entries()]) {
    const pd = pairDataMap.get(pos.pair);
    if (!pd || pd.h4.length === 0) continue;
    const lastBar = pd.h4[pd.h4.length - 1];
    closePosition(key, lastBar.c, lastBar.t);
  }

  return trades;
}

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
    `${"Period".padEnd(22)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
    `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ` +
    `${pad("DDdur", 6)} ${pad("Recov", 6)} ${pad("Total PnL", 11)}`
  );
  console.log("-".repeat(100));
}

function printStatsLine(label: string, s: Stats) {
  console.log(
    `${label.padEnd(22)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ` +
    `${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ${pad(fmtPnl(s.totalPnl), 11)}`
  );
}

// ─── Main ───────────────────────────────────────────────────────────
console.log("=".repeat(110));
console.log("  MULTI-TIMEFRAME AGREEMENT BACKTEST");
console.log("  Does requiring 4h + higher/lower TF agreement improve Supertrend entries?");
console.log("  18 pairs, 2023-01 to 2026-03, 5m candles -> 1h/4h/daily");
console.log("  Cost: Taker 0.035%, standard spreads, 1.5x SL slippage, 10x leverage, $5 margin");
console.log("  No trailing stop. Max 20 positions. ATR-based SL (3x, capped 3.5%).");
console.log("=".repeat(110));

// Load data
console.log("\nLoading data...");
const pairDataMap = new Map<string, PairData>();
const indMap = new Map<string, PairIndicators>();
const available: string[] = [];

for (const p of WANTED_PAIRS) {
  const m5 = load5m(p);
  if (m5.length < 500) { console.log(`  Skipping ${p} (only ${m5.length} candles)`); continue; }
  available.push(p);
  const pd = prepPair(m5);
  pairDataMap.set(p, pd);
  indMap.set(p, computeIndicators(pd));
}
console.log(`Loaded ${available.length} pairs: ${available.join(", ")}`);
console.log("Indicators computed.\n");

// Run all strategies
interface StratResult {
  label: string;
  fullStats: Stats;
  yearStats: Map<number, Stats>;
  conservative: Stats;
  trades: Trade[];
  longStats: Stats;
  shortStats: Stats;
}

const results: StratResult[] = [];

for (const strat of STRATEGIES) {
  console.log("\n" + "#".repeat(110));
  console.log(`  ${strat.label}`);
  console.log("#".repeat(110));

  const trades = runBacktest(strat.filter, available, pairDataMap, indMap, 1.0);
  const fullStats = computeStats(trades, FULL_START, FULL_END);

  // Full period
  console.log("\n--- Full Period ---");
  printHeader();
  printStatsLine("Full 2023-2026", fullStats);

  // Per-year
  console.log("\n--- Per-Year ---");
  printHeader();
  const yearStats = new Map<number, Stats>();
  for (const year of [2023, 2024, 2025, 2026]) {
    const ys = new Date(`${year}-01-01`).getTime();
    const ye = new Date(`${year + 1}-01-01`).getTime();
    const s = computeStats(trades, ys, Math.min(ye, FULL_END));
    yearStats.set(year, s);
    printStatsLine(String(year), s);
  }

  // Long vs Short
  const longTrades = trades.filter(t => t.dir === "long");
  const shortTrades = trades.filter(t => t.dir === "short");
  const longStats = computeStats(longTrades, FULL_START, FULL_END);
  const shortStats = computeStats(shortTrades, FULL_START, FULL_END);
  console.log("\n--- Long vs Short ---");
  printHeader();
  printStatsLine("Longs", longStats);
  printStatsLine("Shorts", shortStats);

  // Conservative (2x spread)
  const trades2x = runBacktest(strat.filter, available, pairDataMap, indMap, 2.0);
  const conservative = computeStats(trades2x, FULL_START, FULL_END);
  console.log("\n--- Conservative (2x Spread) ---");
  printHeader();
  printStatsLine("2x Spread Full", conservative);

  // Top pairs
  console.log("\n--- Top 5 Pairs by PnL ---");
  const pairPnl: { pair: string; pnl: number; count: number }[] = [];
  for (const p of available) {
    const pt = trades.filter(t => t.pair === p);
    pairPnl.push({ pair: p, pnl: pt.reduce((s, t) => s + t.pnl, 0), count: pt.length });
  }
  pairPnl.sort((a, b) => b.pnl - a.pnl);
  for (const pp of pairPnl.slice(0, 5)) {
    console.log(`  ${pp.pair.padEnd(8)} ${fmtPnl(pp.pnl).padStart(10)}  (${pp.count} trades)`);
  }
  console.log("--- Worst 3 Pairs ---");
  for (const pp of pairPnl.slice(-3)) {
    console.log(`  ${pp.pair.padEnd(8)} ${fmtPnl(pp.pnl).padStart(10)}  (${pp.count} trades)`);
  }

  results.push({ label: strat.label, fullStats, yearStats, conservative, trades, longStats, shortStats });
}

// ─── RANKED TABLE ───────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(140));
console.log("  RANKED TABLE - All MTF Strategies (sorted by $/day)");
console.log("=".repeat(140));

const sorted = [...results].sort((a, b) => b.fullStats.perDay - a.fullStats.perDay);

console.log(
  `${"#".padEnd(3)} ${"Strategy".padEnd(26)} ${pad("Trades", 6)} ${pad("PF", 6)} ${pad("Sharpe", 7)} ` +
  `${pad("$/day", 9)} ${pad("WR", 7)} ${pad("MaxDD", 7)} ${pad("DDdur", 6)} ${pad("Recov", 6)} ` +
  `${pad("Total", 10)} ${pad("2x$/d", 8)} ` +
  `${pad("'23", 7)} ${pad("'24", 7)} ${pad("'25", 7)} ${pad("'26", 7)} ` +
  `${pad("Long$", 8)} ${pad("Short$", 8)}`
);
console.log("-".repeat(140));

for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const s = r.fullStats;
  const c = r.conservative;
  const y23 = r.yearStats.get(2023)!;
  const y24 = r.yearStats.get(2024)!;
  const y25 = r.yearStats.get(2025)!;
  const y26 = r.yearStats.get(2026)!;

  console.log(
    `${String(i + 1).padEnd(3)} ${r.label.padEnd(26)} ${pad(String(s.trades), 6)} ${pad(String(s.pf), 6)} ${pad(String(s.sharpe), 7)} ` +
    `${pad(fmtPnl(s.perDay), 9)} ${pad(fmtPct(s.wr), 7)} ${pad("$" + s.maxDd.toFixed(0), 7)} ${pad(s.maxDdDuration, 6)} ${pad(String(s.recoveryDays) + "d", 6)} ` +
    `${pad(fmtPnl(s.totalPnl), 10)} ${pad(fmtPnl(c.perDay), 8)} ` +
    `${pad(fmtPnl(y23.perDay), 7)} ${pad(fmtPnl(y24.perDay), 7)} ${pad(fmtPnl(y25.perDay), 7)} ${pad(fmtPnl(y26.perDay), 7)} ` +
    `${pad(fmtPnl(r.longStats.totalPnl), 8)} ${pad(fmtPnl(r.shortStats.totalPnl), 8)}`
  );
}

// ─── IMPROVEMENT TABLE ──────────────────────────────────────────────
console.log("\n\n" + "=".repeat(120));
console.log("  IMPROVEMENT vs BASELINE");
console.log("=".repeat(120));

const baseResult = results[0]; // strategy 1 = baseline
const bs = baseResult.fullStats;

console.log(
  `${"Strategy".padEnd(26)} ${pad("dTrades", 8)} ${pad("dPF", 8)} ${pad("dSharpe", 8)} ` +
  `${pad("d$/day", 9)} ${pad("dWR", 8)} ${pad("dMaxDD", 8)} ${pad("d2x$/d", 9)}`
);
console.log("-".repeat(120));

for (const r of results) {
  const s = r.fullStats;
  const dT = s.trades - bs.trades;
  const dPF = s.pf - bs.pf;
  const dSh = s.sharpe - bs.sharpe;
  const dPD = s.perDay - bs.perDay;
  const dWR = s.wr - bs.wr;
  const dDD = s.maxDd - bs.maxDd;
  const d2x = r.conservative.perDay - baseResult.conservative.perDay;

  console.log(
    `${r.label.padEnd(26)} ${pad((dT >= 0 ? "+" : "") + dT, 8)} ${pad((dPF >= 0 ? "+" : "") + dPF.toFixed(2), 8)} ` +
    `${pad((dSh >= 0 ? "+" : "") + dSh.toFixed(2), 8)} ${pad(fmtPnl(dPD), 9)} ` +
    `${pad((dWR >= 0 ? "+" : "") + dWR.toFixed(1) + "%", 8)} ` +
    `${pad((dDD <= 0 ? "" : "+") + "$" + dDD.toFixed(0), 8)} ${pad(fmtPnl(d2x), 9)}`
  );
}

// ─── VERDICT ────────────────────────────────────────────────────────
console.log("\n\n" + "=".repeat(110));
console.log("  VERDICT");
console.log("=".repeat(110));

const best = sorted[0];
const bestCons = [...results].sort((a, b) => b.conservative.perDay - a.conservative.perDay)[0];
const bestSharpe = [...results].sort((a, b) => b.fullStats.sharpe - a.fullStats.sharpe)[0];

console.log(`
Best by $/day (standard):      ${best.label}  ->  ${fmtPnl(best.fullStats.perDay)}/day, PF ${best.fullStats.pf}, Sharpe ${best.fullStats.sharpe}
Best by $/day (2x spread):     ${bestCons.label}  ->  ${fmtPnl(bestCons.conservative.perDay)}/day
Best by Sharpe:                ${bestSharpe.label}  ->  Sharpe ${bestSharpe.fullStats.sharpe}, ${fmtPnl(bestSharpe.fullStats.perDay)}/day

Baseline:                      ${baseResult.label}  ->  ${fmtPnl(bs.perDay)}/day, PF ${bs.pf}, Sharpe ${bs.sharpe}

Delta best vs baseline:
  $/day:   ${fmtPnl(best.fullStats.perDay - bs.perDay)} (${bs.perDay !== 0 ? ((best.fullStats.perDay / bs.perDay - 1) * 100).toFixed(1) : "N/A"}%)
  PF:      ${(best.fullStats.pf - bs.pf >= 0 ? "+" : "") + (best.fullStats.pf - bs.pf).toFixed(2)}
  Sharpe:  ${(best.fullStats.sharpe - bs.sharpe >= 0 ? "+" : "") + (best.fullStats.sharpe - bs.sharpe).toFixed(2)}
  WR:      ${(best.fullStats.wr - bs.wr >= 0 ? "+" : "") + (best.fullStats.wr - bs.wr).toFixed(1)}%
  MaxDD:   ${(best.fullStats.maxDd - bs.maxDd <= 0 ? "" : "+")}$${(best.fullStats.maxDd - bs.maxDd).toFixed(0)}

Year consistency (best):
  2023: ${fmtPnl(best.yearStats.get(2023)!.perDay)}/day
  2024: ${fmtPnl(best.yearStats.get(2024)!.perDay)}/day
  2025: ${fmtPnl(best.yearStats.get(2025)!.perDay)}/day
  2026: ${fmtPnl(best.yearStats.get(2026)!.perDay)}/day
`);

// Trade count impact
console.log("Trade count impact (fewer = more selective, need higher quality):");
for (const r of results) {
  const reduction = ((1 - r.fullStats.trades / bs.trades) * 100).toFixed(1);
  const avgPnl = r.fullStats.trades > 0 ? r.fullStats.totalPnl / r.fullStats.trades : 0;
  console.log(`  ${r.label.padEnd(26)} ${String(r.fullStats.trades).padStart(5)} trades (${reduction}% reduction)  avg: ${fmtPnl(avgPnl)}`);
}

// Final recommendation
console.log("\n--- Recommendation ---");
if (best.fullStats.perDay > bs.perDay && best.fullStats.sharpe >= bs.sharpe) {
  console.log(`MTF agreement HELPS. ${best.label} outperforms baseline on both $/day and Sharpe.`);
  if (best.conservative.perDay > 0) {
    console.log("Survives 2x spread stress test. Consider adopting.");
  } else {
    console.log("WARNING: Does not survive 2x spread. Edge may be fragile.");
  }
} else if (best.fullStats.perDay > bs.perDay) {
  console.log(`MTF improves $/day but not risk-adjusted. ${best.label} earns more but Sharpe is lower.`);
} else {
  console.log("MTF agreement does NOT improve Supertrend baseline. Simpler is better.");
}
