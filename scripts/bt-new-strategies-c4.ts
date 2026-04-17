/**
 * Cycle 4 New Strategies Backtest
 * Tests 8 brand-new strategies vs GARCH baseline ($2.31/day, MaxDD $60, 2.55 trades/day)
 *
 * S1: Keltner Channel Breakout (4h)
 * S2: Ichimoku Cloud (4h)
 * S3: Williams %R + ADX (1h)
 * S4: Stochastic RSI Divergence (4h)
 * S5: Hurst Filter on GARCH
 * S6: Dual-Speed GARCH
 * S7: NR7 Daily Breakout
 * S8: GARCH on 15m Bars
 *
 * $9 margin, 10x leverage, max 7 positions, BTC 4h EMA(12/21) filter for longs
 * 0.015% maker on entries, 0.035% taker on SL exits
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-new-strategies-c4.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const MIN5 = 5 * 60_000;
const MIN15 = 15 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE_MAKER = 0.000_15;
const FEE_TAKER = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MARGIN = 9;
const NOT = MARGIN * LEV; // $90 notional
const MAX_POS = 7;
const SL_MAX_PCT = 0.035;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-06-01").getTime();
// IS is FULL_START to OOS_START

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

// ─── Data Loading ─────────────────────────────────────────────────────────────
function loadJson(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
    )
    .sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minFill: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < minFill) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i]!.h - cs[i]!.l,
      Math.abs(cs[i]!.h - cs[i - 1]!.c),
      Math.abs(cs[i]!.l - cs[i - 1]!.c),
    );
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++) s += trs[j]!;
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1]! * (period - 1) + trs[i]!) / period;
    }
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let seeded = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!seeded) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j]!;
      ema[i] = s / period;
      seeded = true;
    } else {
      ema[i] = values[i]! * k + ema[i - 1]! * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j]!;
    sma[i] = s / period;
  }
  return sma;
}

// Williams %R
function calcWilliamsR(cs: C[], period: number): number[] {
  const wr = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (cs[j]!.h > hh) hh = cs[j]!.h;
      if (cs[j]!.l < ll) ll = cs[j]!.l;
    }
    wr[i] = hh === ll ? -50 : ((hh - cs[i]!.c) / (hh - ll)) * -100;
  }
  return wr;
}

// ADX (using Wilder smoothing)
function calcADX(cs: C[], period: number): number[] {
  const plusDM = new Array(cs.length).fill(0);
  const minusDM = new Array(cs.length).fill(0);
  const tr = new Array(cs.length).fill(0);

  for (let i = 1; i < cs.length; i++) {
    const up = cs[i]!.h - cs[i - 1]!.h;
    const down = cs[i - 1]!.l - cs[i]!.l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      cs[i]!.h - cs[i]!.l,
      Math.abs(cs[i]!.h - cs[i - 1]!.c),
      Math.abs(cs[i]!.l - cs[i - 1]!.c),
    );
  }

  const smoothTR = new Array(cs.length).fill(0);
  const smoothPlus = new Array(cs.length).fill(0);
  const smoothMinus = new Array(cs.length).fill(0);

  // Seed
  if (cs.length > period) {
    let sTR = 0, sP = 0, sM = 0;
    for (let j = 1; j <= period; j++) {
      sTR += tr[j]!;
      sP += plusDM[j]!;
      sM += minusDM[j]!;
    }
    smoothTR[period] = sTR;
    smoothPlus[period] = sP;
    smoothMinus[period] = sM;
    for (let i = period + 1; i < cs.length; i++) {
      smoothTR[i] = smoothTR[i - 1]! - smoothTR[i - 1]! / period + tr[i]!;
      smoothPlus[i] = smoothPlus[i - 1]! - smoothPlus[i - 1]! / period + plusDM[i]!;
      smoothMinus[i] = smoothMinus[i - 1]! - smoothMinus[i - 1]! / period + minusDM[i]!;
    }
  }

  const diPlus = new Array(cs.length).fill(0);
  const diMinus = new Array(cs.length).fill(0);
  const dx = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    if (smoothTR[i]! > 0) {
      diPlus[i] = (smoothPlus[i]! / smoothTR[i]!) * 100;
      diMinus[i] = (smoothMinus[i]! / smoothTR[i]!) * 100;
    }
    const sum = diPlus[i]! + diMinus[i]!;
    dx[i] = sum > 0 ? (Math.abs(diPlus[i]! - diMinus[i]!) / sum) * 100 : 0;
  }

  const adx = new Array(cs.length).fill(0);
  // Seed ADX from DX
  if (cs.length > 2 * period) {
    let s = 0;
    for (let j = period; j < 2 * period; j++) s += dx[j]!;
    adx[2 * period - 1] = s / period;
    for (let i = 2 * period; i < cs.length; i++) {
      adx[i] = (adx[i - 1]! * (period - 1) + dx[i]!) / period;
    }
  }
  return adx;
}

// Stochastic RSI
function calcStochRSI(cs: C[], rsiPeriod: number, stochPeriod: number, smoothK: number, smoothD: number): { k: number[]; d: number[] } {
  // Step 1: RSI
  const rsi = new Array(cs.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= rsiPeriod && i < cs.length; i++) {
    const diff = cs[i]!.c - cs[i - 1]!.c;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= rsiPeriod;
  avgLoss /= rsiPeriod;

  if (rsiPeriod < cs.length) {
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[rsiPeriod] = 100 - 100 / (1 + rs);
    for (let i = rsiPeriod + 1; i < cs.length; i++) {
      const diff = cs[i]!.c - cs[i - 1]!.c;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
      avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
      const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs2);
    }
  }

  // Step 2: Stochastic of RSI
  const rawK = new Array(cs.length).fill(50);
  for (let i = stochPeriod - 1; i < cs.length; i++) {
    let minRsi = Infinity, maxRsi = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsi[j]! < minRsi) minRsi = rsi[j]!;
      if (rsi[j]! > maxRsi) maxRsi = rsi[j]!;
    }
    rawK[i] = maxRsi === minRsi ? 50 : ((rsi[i]! - minRsi) / (maxRsi - minRsi)) * 100;
  }

  // Step 3: Smooth K and D
  const smoothedK = calcSMA(rawK, smoothK);
  const smoothedD = calcSMA(smoothedK, smoothD);

  return { k: smoothedK, d: smoothedD };
}

// Hurst Exponent via R/S method (on array of returns)
function calcHurst(returns: number[]): number {
  if (returns.length < 20) return 0.5;
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const deviations = returns.map(r => r - mean);
  let cumDev = 0;
  let maxCum = -Infinity;
  let minCum = Infinity;
  for (const d of deviations) {
    cumDev += d;
    if (cumDev > maxCum) maxCum = cumDev;
    if (cumDev < minCum) minCum = cumDev;
  }
  const R = maxCum - minCum;
  const S = Math.sqrt(returns.reduce((a, b) => a + b * b, 0) / n - mean * mean);
  if (S === 0) return 0.5;
  const rs = R / S;
  return Math.log(rs) / Math.log(n);
}

// Z-Score computation (momentum-based)
function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - momLb]!.c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

// Donchian channel
function calcDonchian(cs: C[], period: number): { upper: number[]; lower: number[] } {
  const upper = new Array(cs.length).fill(0);
  const lower = new Array(cs.length).fill(0);
  for (let i = period - 1; i < cs.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (cs[j]!.h > hi) hi = cs[j]!.h;
      if (cs[j]!.l < lo) lo = cs[j]!.l;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

// ─── BTC Filter ───────────────────────────────────────────────────────────────
function buildBtcH4Filter(btc4h: C[]): (t: number) => boolean {
  const closes = btc4h.map(c => c.c);
  const ema12 = calcEMA(closes, 12);
  const ema21 = calcEMA(closes, 21);
  // Build sorted timestamp array for binary search
  const times = btc4h.map(c => c.t);
  return (t: number) => {
    // Find latest 4h bar before t
    let lo = 0, hi = btc4h.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 21) return false;
    return ema12[idx]! > ema21[idx]!;
  };
}

// ─── Cost Helpers ─────────────────────────────────────────────────────────────
function getSpread(pair: string): number { return SP[pair] ?? 6e-4; }

function applyEntryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}

function applyExitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}

function calcPnl(dir: "long" | "short", ep: number, xp: number, isSL: boolean): number {
  const rawPnl = dir === "long" ? (xp / ep - 1) * NOT : (ep / xp - 1) * NOT;
  const entryFee = NOT * FEE_MAKER;
  const exitFee = NOT * (isSL ? FEE_TAKER : FEE_MAKER);
  return rawPnl - entryFee - exitFee;
}

function capSL(ep: number, sl: number, dir: "long" | "short"): number {
  if (dir === "long") return Math.max(sl, ep * (1 - SL_MAX_PCT));
  return Math.min(sl, ep * (1 + SL_MAX_PCT));
}

// ─── Trade & Metrics Types ────────────────────────────────────────────────────
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  maxDD: number; total: number; perDay: number; tpd: number;
}

function calcMetrics(trades: Trade[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) {
    return { n: 0, wr: 0, pf: 0, sharpe: 0, maxDD: 0, total: 0, perDay: 0, tpd: 0 };
  }
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl <= 0);
  const grossP = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = sorted.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily PnL for Sharpe
  const dailyMap = new Map<number, number>();
  for (const t of sorted) {
    const day = Math.floor(t.xt / D) * D;
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.pnl);
  }
  const dailyPnls = [...dailyMap.values()];
  let sharpe = 0;
  if (dailyPnls.length > 5) {
    const avg = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
    const variance = dailyPnls.reduce((a, b) => a + (b - avg) ** 2, 0) / dailyPnls.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (avg / std) * Math.sqrt(365) : 0;
  }

  const days = (endTs - startTs) / D;
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossL > 0 ? grossP / grossL : (grossP > 0 ? 99 : 0),
    sharpe,
    maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    tpd: days > 0 ? trades.length / days : 0,
  };
}

// ─── Position Manager (enforces MAX_POS) ──────────────────────────────────────
interface Position {
  pair: string; dir: "long" | "short"; ep: number; sl: number;
  et: number; entryIdx: number; tp?: number; maxHoldMs: number;
}

function positionKey(pair: string, dir: "long" | "short"): string { return `${pair}_${dir}`; }

// ─── Load all data upfront ────────────────────────────────────────────────────
console.log("Loading 5m candles...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(p);
  if (d.length > 0) raw5m.set(p, d);
  else console.log(`  WARN: no data for ${p}`);
}

// Aggregations
const data1h = new Map<string, C[]>();
const data4h = new Map<string, C[]>();
const dataD  = new Map<string, C[]>();
const data15m = new Map<string, C[]>();

for (const [p, bars] of raw5m) {
  data1h.set(p, aggregate(bars, H, 10));      // min 10 of 12 5m bars
  data4h.set(p, aggregate(bars, H4, 40));     // min 40 of 48 5m bars
  dataD.set(p,  aggregate(bars, D, 200));     // min 200 of 288 5m bars
  data15m.set(p, aggregate(bars, MIN15, 2));  // min 2 of 3 5m bars
}

const btc4h = data4h.get("BTC")!;
const btcFilter = buildBtcH4Filter(btc4h);

// BTC h1 EMA for GARCH BTC filter
const btcH1 = data1h.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9  = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
function btcH1Bullish(t: number): boolean {
  let lo = 0, hi = btcH1.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH1[mid]!.t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 21) return false;
  return btcH1Ema9[idx]! > btcH1Ema21[idx]!;
}
function btcH1Bearish(t: number): boolean {
  let lo = 0, hi = btcH1.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH1[mid]!.t <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 21) return false;
  return btcH1Ema9[idx]! < btcH1Ema21[idx]!;
}

console.log(`BTC: ${btcH1.length} 1h, ${btc4h.length} 4h bars\nData loaded.\n`);

// ─── S1: KELTNER CHANNEL BREAKOUT (4h) ───────────────────────────────────────
function runS1_Keltner(
  pair: string, cs4h: C[], btcBull: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs4h.length < 50) return trades;

  const closes = cs4h.map(c => c.c);
  const ema20 = calcEMA(closes, 20);
  const atr10 = calcATR(cs4h, 10);

  let pos: Position | null = null;

  for (let i = 22; i < cs4h.length; i++) {
    const bar = cs4h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    const upper = ema20[i - 1]! + 2 * atr10[i - 1]!;
    const lower = ema20[i - 1]! - 2 * atr10[i - 1]!;
    const curEma = ema20[i]!;
    const curATR = atr10[i]!;

    // EXIT
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }

      if (!xRaw) {
        // Price crosses back inside channel
        const curUpper = curEma + 2 * curATR;
        const curLower = curEma - 2 * curATR;
        if (pos.dir === "long" && bar.c < curUpper) { xRaw = bar.c; reason = "channel"; }
        else if (pos.dir === "short" && bar.c > curLower) { xRaw = bar.c; reason = "channel"; }
      }

      if (!xRaw && (bar.t - pos.et) >= 72 * H) { xRaw = bar.c; reason = "time"; }

      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: close breaks above upper / below lower on prev bar
    if (!pos) {
      const prevBar = cs4h[i - 1]!;
      const prevClose = prevBar.c;

      let dir: "long" | "short" | null = null;
      if (prevClose > upper) dir = "long";
      else if (prevClose < lower) dir = "short";

      if (dir === "long" && !btcBull(bar.t)) dir = null;

      if (dir) {
        const ep = applyEntryPx(pair, dir, bar.o);
        let sl = dir === "long" ? ep - 2 * atr10[i]! : ep + 2 * atr10[i]!;
        sl = capSL(ep, sl, dir);
        pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 72 * H };
      }
    }
  }
  return trades;
}

// ─── S2: ICHIMOKU CLOUD (4h) ──────────────────────────────────────────────────
function calcIchimoku(cs: C[]): { tenkan: number[]; kijun: number[]; senkouA: number[]; senkouB: number[] } {
  const n = cs.length;
  const tenkan = new Array(n).fill(0);
  const kijun  = new Array(n).fill(0);
  const senkouA = new Array(n).fill(0);
  const senkouB = new Array(n).fill(0);

  for (let i = 8; i < n; i++) {
    let hi9 = -Infinity, lo9 = Infinity;
    for (let j = i - 8; j <= i; j++) { if (cs[j]!.h > hi9) hi9 = cs[j]!.h; if (cs[j]!.l < lo9) lo9 = cs[j]!.l; }
    tenkan[i] = (hi9 + lo9) / 2;
  }
  for (let i = 25; i < n; i++) {
    let hi26 = -Infinity, lo26 = Infinity;
    for (let j = i - 25; j <= i; j++) { if (cs[j]!.h > hi26) hi26 = cs[j]!.h; if (cs[j]!.l < lo26) lo26 = cs[j]!.l; }
    kijun[i] = (hi26 + lo26) / 2;
  }
  for (let i = 25; i < n; i++) {
    senkouA[i] = (tenkan[i]! + kijun[i]!) / 2;
  }
  for (let i = 51; i < n; i++) {
    let hi52 = -Infinity, lo52 = Infinity;
    for (let j = i - 51; j <= i; j++) { if (cs[j]!.h > hi52) hi52 = cs[j]!.h; if (cs[j]!.l < lo52) lo52 = cs[j]!.l; }
    senkouB[i] = (hi52 + lo52) / 2;
  }
  return { tenkan, kijun, senkouA, senkouB };
}

function runS2_Ichimoku(
  pair: string, cs4h: C[], btcBull: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs4h.length < 80) return trades;

  const { tenkan, kijun, senkouA, senkouB } = calcIchimoku(cs4h);
  const atr14 = calcATR(cs4h, 14);
  let pos: Position | null = null;

  for (let i = 55; i < cs4h.length; i++) {
    const bar = cs4h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    const tk = tenkan[i]!;
    const kj = kijun[i]!;
    const tkPrev = tenkan[i - 1]!;
    const kjPrev = kijun[i - 1]!;
    // Cloud at current bar
    const cloudTop = Math.max(senkouA[i]!, senkouB[i]!);
    const cloudBot = Math.min(senkouA[i]!, senkouB[i]!);

    // EXIT
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }

      if (!xRaw) {
        // Tenkan crosses back below Kijun for longs, above for shorts
        if (pos.dir === "long" && tk < kj && tkPrev >= kjPrev) { xRaw = bar.c; reason = "cross"; }
        else if (pos.dir === "short" && tk > kj && tkPrev <= kjPrev) { xRaw = bar.c; reason = "cross"; }
      }
      if (!xRaw && (bar.t - pos.et) >= 72 * H) { xRaw = bar.c; reason = "time"; }

      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: Tenkan crosses above/below Kijun AND price above/below cloud
    if (!pos) {
      const crossUp = tkPrev < kjPrev && tk >= kj;
      const crossDn = tkPrev > kjPrev && tk <= kj;

      let dir: "long" | "short" | null = null;
      if (crossUp && bar.c > cloudTop) dir = "long";
      else if (crossDn && bar.c < cloudBot) dir = "short";

      if (dir === "long" && !btcBull(bar.t)) dir = null;

      if (dir) {
        const ep = applyEntryPx(pair, dir, bar.o);
        let sl = dir === "long" ? ep - 3 * atr14[i]! : ep + 3 * atr14[i]!;
        sl = capSL(ep, sl, dir);
        pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 72 * H };
      }
    }
  }
  return trades;
}

// ─── S3: WILLIAMS %R + ADX (1h) ───────────────────────────────────────────────
function runS3_WilliamsADX(
  pair: string, cs1h: C[], btcBull: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs1h.length < 60) return trades;

  const wr = calcWilliamsR(cs1h, 14);
  const adx = calcADX(cs1h, 14);
  const atr14 = calcATR(cs1h, 14);
  let pos: Position | null = null;

  for (let i = 40; i < cs1h.length; i++) {
    const bar = cs1h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    const wrCur  = wr[i]!;
    const wrPrev = wr[i - 1]!;

    // EXIT: %R crosses -50
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }

      if (!xRaw) {
        if (pos.dir === "long" && wrPrev >= -50 && wrCur < -50) { xRaw = bar.c; reason = "wr50"; }
        else if (pos.dir === "short" && wrPrev <= -50 && wrCur > -50) { xRaw = bar.c; reason = "wr50"; }
      }
      if (!xRaw && (bar.t - pos.et) >= 24 * H) { xRaw = bar.c; reason = "time"; }

      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY
    if (!pos && adx[i]! > 25) {
      let dir: "long" | "short" | null = null;
      if (wrPrev > -80 && wrCur <= -80) dir = "long";
      else if (wrPrev < -20 && wrCur >= -20) dir = "short";

      if (dir === "long" && !btcBull(bar.t)) dir = null;

      if (dir) {
        const ep = applyEntryPx(pair, dir, bar.c);
        let sl = dir === "long" ? ep * (1 - 0.02) : ep * (1 + 0.02);
        sl = capSL(ep, sl, dir);
        pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 24 * H };
      }
    }
  }
  return trades;
}

// ─── S4: STOCHASTIC RSI DIVERGENCE (4h) ──────────────────────────────────────
function runS4_StochRSI(
  pair: string, cs4h: C[], btcBull: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs4h.length < 80) return trades;

  const { k, d } = calcStochRSI(cs4h, 14, 14, 3, 3);
  const atr14 = calcATR(cs4h, 14);
  let pos: Position | null = null;

  for (let i = 35; i < cs4h.length; i++) {
    const bar = cs4h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    const kCur = k[i]!, dCur = d[i]!;
    const kPrev = k[i - 1]!, dPrev = d[i - 1]!;

    // EXIT: opposite cross signal
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }

      if (!xRaw && pos.tp && pos.dir === "long" && bar.h >= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && pos.tp && pos.dir === "short" && bar.l <= pos.tp) { xRaw = pos.tp; reason = "tp"; }

      if (!xRaw) {
        // Opposite StochRSI cross
        if (pos.dir === "long" && kPrev >= dPrev && kCur < dCur && kPrev > 80) { xRaw = bar.c; reason = "srsi"; }
        else if (pos.dir === "short" && kPrev <= dPrev && kCur > dCur && kPrev < 20) { xRaw = bar.c; reason = "srsi"; }
      }
      if (!xRaw && (bar.t - pos.et) >= 72 * H) { xRaw = bar.c; reason = "time"; }

      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: K crosses above D from below 20 = long; K crosses below D from above 80 = short
    if (!pos) {
      let dir: "long" | "short" | null = null;
      if (kPrev < dPrev && kCur >= dCur && kPrev < 20) dir = "long";
      else if (kPrev > dPrev && kCur <= dCur && kPrev > 80) dir = "short";

      if (dir === "long" && !btcBull(bar.t)) dir = null;

      if (dir) {
        const ep = applyEntryPx(pair, dir, bar.o);
        let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
        sl = capSL(ep, sl, dir);
        const tp = dir === "long" ? ep * (1 + 0.07) : ep * (1 - 0.07);
        pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 72 * H, tp };
      }
    }
  }
  return trades;
}

// ─── S5: HURST FILTER ON GARCH ────────────────────────────────────────────────
function runS5_HurstGarch(
  pair: string, cs1h: C[], cs4h: C[],
  btcBullH1: (t: number) => boolean, btcBearH1: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs1h.length < 200 || cs4h.length < 50) return trades;

  const h1Z = computeZScores(cs1h, 3, 20);
  const h1Closes = cs1h.map(c => c.c);
  const h1Ema9  = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h4Z = computeZScores(cs4h, 3, 20);
  const h4TsMap = new Map<number, number>();
  cs4h.forEach((c, i) => h4TsMap.set(c.t, i));

  let pos: Position | null = null;

  for (let i = 110; i < cs1h.length; i++) {
    const bar = cs1h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    // EXIT
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      if (!xRaw && pos.tp && pos.dir === "long" && bar.h >= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && pos.tp && pos.dir === "short" && bar.l <= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && (bar.t - pos.et) >= 96 * H) { xRaw = bar.c; reason = "time"; }
      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: standard GARCH z=4.5/3.0 with Hurst filter
    if (!pos) {
      const prev = i - 1;
      const z1 = h1Z[prev]!;
      if (!z1 || z1 === 0) continue;

      const goLong = z1 > 4.5;
      const goShort = z1 < -3.0;
      if (!goLong && !goShort) continue;

      const ts4h = Math.floor(cs1h[prev]!.t / H4) * H4;
      const idx4h = h4TsMap.get(ts4h);
      if (idx4h === undefined || idx4h < 23) continue;
      const z4 = h4Z[idx4h]!;
      if (goLong && z4 <= 3.0) continue;
      if (goShort && z4 >= -3.0) continue;

      if (goLong && h1Ema9[prev]! <= h1Ema21[prev]!) continue;
      if (goShort && h1Ema9[prev]! >= h1Ema21[prev]!) continue;

      if (goLong && !btcBullH1(cs1h[prev]!.t)) continue;
      if (goShort && !btcBearH1(cs1h[prev]!.t)) continue;

      // Hurst filter: compute on last 100 4h returns
      if (idx4h >= 100) {
        const returns: number[] = [];
        for (let j = idx4h - 99; j <= idx4h; j++) {
          returns.push(cs4h[j]!.c / cs4h[j - 1]!.c - 1);
        }
        const H_exp = calcHurst(returns);
        if (H_exp > 0.55) continue; // Skip: trending market, z-score fades fail
      }

      const dir: "long" | "short" = goLong ? "long" : "short";
      const ep = applyEntryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
      sl = capSL(ep, sl, dir);
      const tp = dir === "long" ? ep * (1 + 0.07) : ep * (1 - 0.07);
      pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 96 * H, tp };
    }
  }
  return trades;
}

// ─── S6: DUAL-SPEED GARCH ─────────────────────────────────────────────────────
function runS6_DualGarch(
  pair: string, cs1h: C[], cs4h: C[],
  btcBullH1: (t: number) => boolean, btcBearH1: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs1h.length < 200 || cs4h.length < 60) return trades;

  const h1Z20 = computeZScores(cs1h, 3, 20);
  const h1Z50 = computeZScores(cs1h, 3, 50);
  const h1Closes = cs1h.map(c => c.c);
  const h1Ema9  = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h4TsMap = new Map<number, number>();
  cs4h.forEach((c, i) => h4TsMap.set(c.t, i));

  let pos: Position | null = null;

  for (let i = 60; i < cs1h.length; i++) {
    const bar = cs1h[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    // EXIT
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      if (!xRaw && pos.tp && pos.dir === "long" && bar.h >= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && pos.tp && pos.dir === "short" && bar.l <= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && (bar.t - pos.et) >= 72 * H) { xRaw = bar.c; reason = "time"; }
      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: z_20 > 4.0 AND z_50 > 3.0 both agree
    if (!pos) {
      const prev = i - 1;
      const z20 = h1Z20[prev]!;
      const z50 = h1Z50[prev]!;
      if (!z20 || !z50) continue;

      const goLong  = z20 > 4.0 && z50 > 3.0;
      const goShort = z20 < -3.0 && z50 < -3.0;
      if (!goLong && !goShort) continue;

      if (goLong && h1Ema9[prev]! <= h1Ema21[prev]!) continue;
      if (goShort && h1Ema9[prev]! >= h1Ema21[prev]!) continue;

      if (goLong && !btcBullH1(cs1h[prev]!.t)) continue;
      if (goShort && !btcBearH1(cs1h[prev]!.t)) continue;

      const dir: "long" | "short" = goLong ? "long" : "short";
      const ep = applyEntryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep * (1 - 0.03) : ep * (1 + 0.03);
      sl = capSL(ep, sl, dir);
      const tp = dir === "long" ? ep * (1 + 0.07) : ep * (1 - 0.07);
      pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 72 * H, tp };
    }
  }
  return trades;
}

// ─── S7: NR7 DAILY BREAKOUT ───────────────────────────────────────────────────
function runS7_NR7(
  pair: string, csD: C[], cs4h: C[], btcBull: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (csD.length < 30) return trades;

  const atr14D = calcATR(csD, 14);
  const donch10 = calcDonchian(csD, 10);

  let pos: Position | null = null;
  let nr7Day: { high: number; low: number } | null = null;

  for (let i = 7; i < csD.length; i++) {
    const bar = csD[i]!;
    if (bar.t >= endTs && pos) {
      const xp = applyExitPx(pair, pos.dir, bar.c, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
      pos = null;
      break;
    }
    if (bar.t >= endTs) break;

    // Check exits first
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }

      if (!xRaw) {
        // Donchian(10) exit
        if (pos.dir === "long" && bar.c < donch10.lower[i]!) { xRaw = bar.c; reason = "donch"; }
        else if (pos.dir === "short" && bar.c > donch10.upper[i]!) { xRaw = bar.c; reason = "donch"; }
      }
      if (!xRaw && (bar.t - pos.et) >= 20 * D) { xRaw = bar.c; reason = "time"; }

      if (xRaw > 0) {
        if (bar.t >= startTs) {
          const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        }
        pos = null;
        nr7Day = null;
      }
    }

    // Check if previous bar was NR7
    const prevBar = csD[i - 1]!;
    const prevRange = prevBar.h - prevBar.l;
    let isNR7 = true;
    for (let j = i - 7; j < i - 1; j++) {
      if (csD[j]!.h - csD[j]!.l <= prevRange) { isNR7 = false; break; }
    }

    if (isNR7) {
      nr7Day = { high: prevBar.h, low: prevBar.l };
    }

    // Enter on breakout of NR7
    if (!pos && nr7Day && bar.t >= startTs) {
      let dir: "long" | "short" | null = null;
      if (bar.o > nr7Day.high) dir = "long";
      else if (bar.o < nr7Day.low) dir = "short";

      if (dir === "long" && !btcBull(bar.t)) dir = null;

      if (dir) {
        const ep = applyEntryPx(pair, dir, bar.o);
        let sl = dir === "long" ? ep - 2 * atr14D[i]! : ep + 2 * atr14D[i]!;
        sl = capSL(ep, sl, dir);
        pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 20 * D };
        nr7Day = null;
      }
    }
  }
  return trades;
}

// ─── S8: GARCH ON 15m BARS ───────────────────────────────────────────────────
function runS8_Garch15m(
  pair: string, cs15m: C[], cs4h: C[],
  btcBullH1: (t: number) => boolean, btcBearH1: (t: number) => boolean,
  startTs: number, endTs: number,
): Trade[] {
  const trades: Trade[] = [];
  if (cs15m.length < 500 || cs4h.length < 50) return trades;

  const z15m = computeZScores(cs15m, 3, 20);
  const closes15m = cs15m.map(c => c.c);
  const ema9_15m  = calcEMA(closes15m, 9);
  const ema21_15m = calcEMA(closes15m, 21);

  const h4Z = computeZScores(cs4h, 3, 20);
  const h4TsMap = new Map<number, number>();
  cs4h.forEach((c, i) => h4TsMap.set(c.t, i));

  let pos: Position | null = null;

  for (let i = 25; i < cs15m.length; i++) {
    const bar = cs15m[i]!;
    if (bar.t < startTs || bar.t >= endTs) {
      if (pos && bar.t >= endTs) {
        const xp = applyExitPx(pair, pos.dir, bar.c, false);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, false), reason: "end" });
        pos = null;
      }
      continue;
    }

    // EXIT
    if (pos) {
      let xRaw = 0, reason = "", isSL = false;
      if (pos.dir === "long" && bar.l <= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      else if (pos.dir === "short" && bar.h >= pos.sl) { xRaw = pos.sl; reason = "sl"; isSL = true; }
      if (!xRaw && pos.tp && pos.dir === "long" && bar.h >= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && pos.tp && pos.dir === "short" && bar.l <= pos.tp) { xRaw = pos.tp; reason = "tp"; }
      if (!xRaw && (bar.t - pos.et) >= 48 * H) { xRaw = bar.c; reason = "time"; }
      if (xRaw > 0) {
        const xp = applyExitPx(pair, pos.dir, xRaw, isSL);
        trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl: calcPnl(pos.dir, pos.ep, xp, isSL), reason });
        pos = null;
      }
    }

    // ENTRY: z_15m > 4.5 AND z_4h > 3.0
    if (!pos) {
      const prev = i - 1;
      const z15 = z15m[prev]!;
      if (!z15 || z15 === 0) continue;

      const goLong  = z15 > 4.5;
      const goShort = z15 < -4.5;
      if (!goLong && !goShort) continue;

      // 4h z-score confirmation
      const ts4h = Math.floor(cs15m[prev]!.t / H4) * H4;
      const idx4h = h4TsMap.get(ts4h);
      if (idx4h === undefined || idx4h < 23) continue;
      const z4 = h4Z[idx4h]!;
      if (goLong && z4 <= 3.0) continue;
      if (goShort && z4 >= -3.0) continue;

      // EMA trend on 15m
      if (goLong && ema9_15m[prev]! <= ema21_15m[prev]!) continue;
      if (goShort && ema9_15m[prev]! >= ema21_15m[prev]!) continue;

      if (goLong && !btcBullH1(cs15m[prev]!.t)) continue;
      if (goShort && !btcBearH1(cs15m[prev]!.t)) continue;

      const dir: "long" | "short" = goLong ? "long" : "short";
      const ep = applyEntryPx(pair, dir, bar.o);
      let sl = dir === "long" ? ep * (1 - 0.02) : ep * (1 + 0.02);
      sl = capSL(ep, sl, dir);
      const tp = dir === "long" ? ep * (1 + 0.05) : ep * (1 - 0.05);
      pos = { pair, dir, ep, sl, et: bar.t, entryIdx: i, maxHoldMs: 48 * H, tp };
    }
  }
  return trades;
}

// ─── Portfolio Simulation (enforces MAX_POS) ─────────────────────────────────
interface RawSignal {
  pair: string; dir: "long" | "short"; ep: number; sl: number;
  et: number; tp?: number; maxHoldMs: number;
  pnl?: number; xt?: number; reason?: string;
}

// Simple per-pair sequential simulation with position cap
// We run per-pair sequentially (one position per pair at a time), then
// apply global MAX_POS cap by sorting entries by time and rejecting when full.
function applyMaxPos(allTrades: Trade[], maxPos: number): Trade[] {
  // Sort all trades by entry time
  const sorted = [...allTrades].sort((a, b) => a.et - b.et);
  const accepted: Trade[] = [];
  // Track active slots: set of (pair+dir) with their exit time
  const active: { pair: string; dir: string; xt: number }[] = [];

  for (const t of sorted) {
    // Remove expired positions
    const now = t.et;
    for (let j = active.length - 1; j >= 0; j--) {
      if (active[j]!.xt <= now) active.splice(j, 1);
    }
    if (active.length >= maxPos) continue;
    // Check no duplicate pair+dir
    const dup = active.find(a => a.pair === t.pair && a.dir === t.dir);
    if (dup) continue;
    active.push({ pair: t.pair, dir: t.dir, xt: t.xt });
    accepted.push(t);
  }
  return accepted;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function printResult(name: string, is: Metrics, oos: Metrics): void {
  const f = (v: number) => v.toFixed(2);
  const s = (v: number) => (v >= 0 ? "+" : "") + f(v);
  console.log(`\n  ${name}`);
  console.log(`    IS  (${new Date(FULL_START).toISOString().slice(0,7)} - ${new Date(OOS_START).toISOString().slice(0,7)})`);
  console.log(`      N=${is.n}  $/day=${s(is.perDay)}  PF=${f(is.pf)}  WR=${f(is.wr)}%  Sharpe=${f(is.sharpe)}  MaxDD=$${f(is.maxDD)}  TPD=${f(is.tpd)}`);
  console.log(`    OOS (${new Date(OOS_START).toISOString().slice(0,7)} - ${new Date(FULL_END).toISOString().slice(0,7)})`);
  console.log(`      N=${oos.n}  $/day=${s(oos.perDay)}  PF=${f(oos.pf)}  WR=${f(oos.wr)}%  Sharpe=${f(oos.sharpe)}  MaxDD=$${f(oos.maxDD)}  TPD=${f(oos.tpd)}`);
}

async function main() {
  console.log("=".repeat(90));
  console.log("  CYCLE 4 NEW STRATEGIES BACKTEST");
  console.log("  Baseline: GARCH $9, z=4.5/3.0, SL 3%, TP 7%, 72h => $2.31/day, MaxDD $60, 2.55 TPD");
  console.log("  $9 margin, 10x lev, max 7 positions, BTC 4h EMA(12/21) for longs");
  console.log("  IS: 2023-01 to 2025-06 | OOS: 2025-06 to 2026-03");
  console.log("=".repeat(90));

  // Collect all per-strategy trades per period
  const results: Record<string, { is: Trade[]; oos: Trade[] }> = {
    S1_Keltner: { is: [], oos: [] },
    S2_Ichimoku: { is: [], oos: [] },
    S3_WilliamsADX: { is: [], oos: [] },
    S4_StochRSI: { is: [], oos: [] },
    S5_HurstGarch: { is: [], oos: [] },
    S6_DualGarch: { is: [], oos: [] },
    S7_NR7: { is: [], oos: [] },
    S8_Garch15m: { is: [], oos: [] },
  };

  const btcBullFn = btcFilter;
  const btcBullH1Fn = btcH1Bullish;
  const btcBearH1Fn = btcH1Bearish;

  let pairsProcessed = 0;

  for (const pair of PAIRS) {
    const cs1h  = data1h.get(pair);
    const cs4h  = data4h.get(pair);
    const csD   = dataD.get(pair);
    const cs15m = data15m.get(pair);

    if (!cs1h || !cs4h || !csD || !cs15m) {
      console.log(`  SKIP ${pair}: missing data`);
      continue;
    }
    pairsProcessed++;

    // S1
    const s1IS  = runS1_Keltner(pair, cs4h, btcBullFn, FULL_START, OOS_START);
    const s1OOS = runS1_Keltner(pair, cs4h, btcBullFn, OOS_START, FULL_END);
    results.S1_Keltner!.is.push(...s1IS);
    results.S1_Keltner!.oos.push(...s1OOS);

    // S2
    const s2IS  = runS2_Ichimoku(pair, cs4h, btcBullFn, FULL_START, OOS_START);
    const s2OOS = runS2_Ichimoku(pair, cs4h, btcBullFn, OOS_START, FULL_END);
    results.S2_Ichimoku!.is.push(...s2IS);
    results.S2_Ichimoku!.oos.push(...s2OOS);

    // S3
    const s3IS  = runS3_WilliamsADX(pair, cs1h, btcBullFn, FULL_START, OOS_START);
    const s3OOS = runS3_WilliamsADX(pair, cs1h, btcBullFn, OOS_START, FULL_END);
    results.S3_WilliamsADX!.is.push(...s3IS);
    results.S3_WilliamsADX!.oos.push(...s3OOS);

    // S4
    const s4IS  = runS4_StochRSI(pair, cs4h, btcBullFn, FULL_START, OOS_START);
    const s4OOS = runS4_StochRSI(pair, cs4h, btcBullFn, OOS_START, FULL_END);
    results.S4_StochRSI!.is.push(...s4IS);
    results.S4_StochRSI!.oos.push(...s4OOS);

    // S5
    const s5IS  = runS5_HurstGarch(pair, cs1h, cs4h, btcBullH1Fn, btcBearH1Fn, FULL_START, OOS_START);
    const s5OOS = runS5_HurstGarch(pair, cs1h, cs4h, btcBullH1Fn, btcBearH1Fn, OOS_START, FULL_END);
    results.S5_HurstGarch!.is.push(...s5IS);
    results.S5_HurstGarch!.oos.push(...s5OOS);

    // S6
    const s6IS  = runS6_DualGarch(pair, cs1h, cs4h, btcBullH1Fn, btcBearH1Fn, FULL_START, OOS_START);
    const s6OOS = runS6_DualGarch(pair, cs1h, cs4h, btcBullH1Fn, btcBearH1Fn, OOS_START, FULL_END);
    results.S6_DualGarch!.is.push(...s6IS);
    results.S6_DualGarch!.oos.push(...s6OOS);

    // S7
    const s7IS  = runS7_NR7(pair, csD, cs4h, btcBullFn, FULL_START, OOS_START);
    const s7OOS = runS7_NR7(pair, csD, cs4h, btcBullFn, OOS_START, FULL_END);
    results.S7_NR7!.is.push(...s7IS);
    results.S7_NR7!.oos.push(...s7OOS);

    // S8
    const s8IS  = runS8_Garch15m(pair, cs15m, cs4h, btcBullH1Fn, btcBearH1Fn, FULL_START, OOS_START);
    const s8OOS = runS8_Garch15m(pair, cs15m, cs4h, btcBullH1Fn, btcBearH1Fn, OOS_START, FULL_END);
    results.S8_Garch15m!.is.push(...s8IS);
    results.S8_Garch15m!.oos.push(...s8OOS);

    process.stdout.write(`\r  Processed ${pairsProcessed}/${PAIRS.length} pairs...`);
  }

  console.log(`\n  Done: ${pairsProcessed} pairs processed.\n`);

  // Apply MAX_POS cap and compute metrics
  console.log("=".repeat(90));
  console.log("  RESULTS (IS = In-Sample, OOS = Out-of-Sample, all after MAX_POS=7 cap)");
  console.log("=".repeat(90));

  const summaryRows: string[] = [];

  for (const [strat, data] of Object.entries(results)) {
    const isCapped  = applyMaxPos(data.is, MAX_POS);
    const oosCapped = applyMaxPos(data.oos, MAX_POS);

    const isMetrics  = calcMetrics(isCapped, FULL_START, OOS_START);
    const oosMetrics = calcMetrics(oosCapped, OOS_START, FULL_END);

    printResult(strat, isMetrics, oosMetrics);

    summaryRows.push(
      `  ${strat.padEnd(20)} | OOS $/day=${((oosMetrics.perDay >= 0 ? "+" : "") + oosMetrics.perDay.toFixed(2)).padStart(7)}`
      + `  PF=${oosMetrics.pf.toFixed(2).padStart(5)}`
      + `  WR=${oosMetrics.wr.toFixed(1).padStart(5)}%`
      + `  Sharpe=${oosMetrics.sharpe.toFixed(2).padStart(6)}`
      + `  MaxDD=$${oosMetrics.maxDD.toFixed(0).padStart(5)}`
      + `  TPD=${oosMetrics.tpd.toFixed(2).padStart(5)}`
      + `  N=${oosMetrics.n}`,
    );
  }

  // Per-pair breakdown for top strategies
  console.log("\n" + "=".repeat(90));
  console.log("  OOS SUMMARY (ranked by $/day)");
  console.log("  Baseline: $+2.31/day | MaxDD $60 | PF ~1.8 | 2.55 TPD");
  console.log("=".repeat(90));
  summaryRows.sort((a, b) => {
    const va = parseFloat(a.split("$/day=")[1]!.trim().split(" ")[0]!);
    const vb = parseFloat(b.split("$/day=")[1]!.trim().split(" ")[0]!);
    return vb - va;
  });
  for (const row of summaryRows) console.log(row);

  // Per-pair OOS breakdown for each strategy
  console.log("\n" + "=".repeat(90));
  console.log("  PER-PAIR OOS BREAKDOWN");
  console.log("=".repeat(90));

  for (const [strat, data] of Object.entries(results)) {
    const oosCapped = applyMaxPos(data.oos, MAX_POS);
    if (oosCapped.length === 0) continue;

    // Group by pair
    const byPair = new Map<string, Trade[]>();
    for (const t of oosCapped) {
      const arr = byPair.get(t.pair) ?? [];
      arr.push(t);
      byPair.set(t.pair, arr);
    }

    console.log(`\n  ${strat}:`);
    const pairRows: { pair: string; m: Metrics }[] = [];
    for (const [p, ts] of byPair) {
      pairRows.push({ pair: p, m: calcMetrics(ts, OOS_START, FULL_END) });
    }
    pairRows.sort((a, b) => b.m.perDay - a.m.perDay);
    for (const { pair, m } of pairRows) {
      const tag = m.perDay > 0 ? "+" : " ";
      console.log(
        `    ${pair.padEnd(8)} N=${String(m.n).padStart(3)}  WR=${m.wr.toFixed(1).padStart(5)}%`
        + `  PF=${m.pf.toFixed(2).padStart(5)}  $/day=${tag}${Math.abs(m.perDay).toFixed(3).padStart(6)}`
        + `  MaxDD=$${m.maxDD.toFixed(1).padStart(6)}`,
      );
    }
  }

  console.log("\n" + "=".repeat(90));
  console.log("  VERDICT");
  console.log("=".repeat(90));

  // Auto-classify
  for (const [strat, data] of Object.entries(results)) {
    const oosCapped = applyMaxPos(data.oos, MAX_POS);
    const isCapped  = applyMaxPos(data.is, MAX_POS);
    const isM  = calcMetrics(isCapped, FULL_START, OOS_START);
    const oosM = calcMetrics(oosCapped, OOS_START, FULL_END);

    let verdict = "FAIL";
    if (oosM.perDay > 2.31 && oosM.maxDD < 60 && oosM.pf > 1.5) verdict = "BEAT BASELINE";
    else if (oosM.perDay > 0 && oosM.pf > 1.2) verdict = "VIABLE";
    else if (oosM.perDay > 0) verdict = "MARGINAL";
    else verdict = "NEGATIVE";

    const degradation = isM.perDay > 0 ? ((isM.perDay - oosM.perDay) / isM.perDay * 100) : 0;

    console.log(
      `  ${strat.padEnd(20)} => ${verdict.padEnd(15)}`
      + `  OOS $/day=${((oosM.perDay >= 0 ? "+" : "") + oosM.perDay.toFixed(2)).padStart(7)}`
      + `  OvfFit=${degradation.toFixed(0).padStart(4)}%`,
    );
  }

  console.log("\n" + "=".repeat(90));
  console.log("  DONE");
  console.log("=".repeat(90));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
