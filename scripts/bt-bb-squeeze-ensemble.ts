/**
 * BB-Squeeze Engine F validation against 4-engine ensemble
 * Configs: baseline (4 engines), +BB-Squeeze $3, +BB-Squeeze $5, BB-Squeeze solo
 * Position pool max 20 per config. Full: 2023-01 to 2026-03, OOS: 2025-09+
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-bb-squeeze-ensemble.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 20;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// 14 alt pairs + BTC filter (BTC loaded separately)
const PAIRS = ["OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI"];

function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] } : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    let arr = groups.get(bucket);
    if (!arr) { arr = []; groups.set(bucket, arr); }
    arr.push(b);
  }
  const result: C[] = [];
  for (const [, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({ t: grp[0].t, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c });
  }
  return result.sort((a, b) => a.t - b.t);
}

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += trs[j]; atr[i] = s / period;
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; ema[i] = s / period; init = true; }
    else { ema[i] = values[i] * k + ema[i-1] * (1 - k); }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; out[i] = s / period;
  }
  return out;
}

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}

function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i-1] || cs[i-1].c < lb[i-1])) l = lb[i-1];
      if (!(u < ub[i-1] || cs[i-1].c > ub[i-1])) u = ub[i-1];
    }
    ub[i] = u; lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i-1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i-momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) { const r = cs[j].c / cs[j-1].c - 1; sumSq += r * r; count++; }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw * (1 + sp) : raw * (1 - sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp * SL_SLIP : sp; return dir === "long" ? raw * (1 - slip) : raw * (1 + slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, not: number): number { return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2; }

// ---- Load data ----
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const dailyData = new Map<string, C[]>();
const h4Data    = new Map<string, C[]>();
const h1Data    = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC daily EMA(20/50) — used by Donchian/Supertrend long filter
const btcDaily   = dailyData.get("BTC")!;
const btcEma20d  = calcEMA(btcDaily.map(c => c.c), 20);
const btcEma50d  = calcEMA(btcDaily.map(c => c.c), 50);
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  return btcEma20d[idx] > btcEma50d[idx];
}

// BTC 4h EMA(12/21) — used by BB-Squeeze long filter
const btcH4       = h4Data.get("BTC")!;
const btcH4Ema12  = calcEMA(btcH4.map(c => c.c), 12);
const btcH4Ema21  = calcEMA(btcH4.map(c => c.c), 21);
const btcH4TsMap  = new Map<number, number>();
btcH4.forEach((c, i) => btcH4TsMap.set(c.t, i));
function btcH4Bullish(t: number): boolean {
  const bucket = Math.floor(t / H4) * H4;
  let idx = btcH4TsMap.get(bucket);
  if (idx === undefined) { for (let i = btcH4.length - 1; i >= 0; i--) { if (btcH4[i].t <= t) { idx = i; break; } } }
  if (idx === undefined || idx < 2) return false;
  const prev = idx - 1; // completed bar before entry bar
  return btcH4Ema12[prev] > btcH4Ema21[prev];
}

// BTC 1h EMA(9/21) — used by GARCH v2 filter
const btcH1      = h1Data.get("BTC")!;
const btcH1Ema9  = calcEMA(btcH1.map(c => c.c), 9);
const btcH1Ema21c = calcEMA(btcH1.map(c => c.c), 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) { for (let i = btcH1.length - 1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } } }
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21c[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21c[prev]) return "short";
  return null;
}

console.log("Data loaded.\n");

// ---- Signal types ----
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
}

// ---- Engine A: Daily Donchian SMA(20/50) ----
function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20); const slow = calcSMA(closes, 50); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        const hd = Math.round((bar.t - pos.et) / D);
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long")  { const lo = donchCloseLow(cs, i, 15);  if (bar.c < lo) { xp = bar.c; reason = "ch"; } }
          else                     { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } }
        }
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "A", size: 7, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos) {
        const p = i - 1, pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---- Engine B: 4h Supertrend(14, 1.75) ----
function genSupertrend(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i]; const flip = stDir[i-1] !== stDir[i-2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "B", size: 5, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---- Engine C: GARCH v2 Multi-TF Z-Score ----
function genGarchV2(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair); const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;
    const z1h = computeZScores(h1, 3, 20); const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c); const ema9 = calcEMA(h1Closes, 9); const ema21 = calcEMA(h1Closes, 21);
    const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));
    let pos: any = null;
    for (let i = 23; i < h1.length; i++) {
      const bar = h1[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t - pos.et) / H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "C", size: 3, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1; if (prev < 23) continue;
        const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) continue;
        const goLong = z1 > 4.5; const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;
        const ts4h = Math.floor(h1[prev].t / H4) * H4; const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= 3.0) continue; if (goShort && z4 >= -3.0) continue;
        const off9 = h1.length - ema9.length; const off21 = h1.length - ema21.length;
        const i9 = prev - off9; const i21 = prev - off21;
        if (i9 < 0 || i21 < 0) continue;
        if (goLong  && ema9[i9] <= ema21[i21]) continue;
        if (goShort && ema9[i9] >= ema21[i21]) continue;
        const btcT = btcH1Trend(h1[prev].t);
        if (goLong  && btcT !== "long")  continue;
        if (goShort && btcT !== "short") continue;
        const dir: "long"|"short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---- Engine D: Momentum Confirm (4h range/funding/price z-scores) ----
function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 55) continue;
    let pos: any = null;
    for (let i = 52; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && (bar.t - pos.et) / H >= 48) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "D", size: 3, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        const ranges: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
        const rStd  = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
        const volZ  = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
        const fp: number[] = [];
        for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
        const fpStd  = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
        const fundZ  = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
        const cls: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) cls.push(cs[j].c); }
        if (cls.length < 20) continue;
        const cMean  = cls.reduce((s, v) => s + v, 0) / cls.length;
        const cStd   = Math.sqrt(cls.reduce((s, v) => s + (v - cMean) ** 2, 0) / cls.length);
        const priceZ = cStd > 0 ? (cls[cls.length - 1] - cMean) / cStd : 0;
        let dir: "long"|"short"|null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcDailyBullish(bar.t)) dir = "long"; }
        else if (volZ > 2 && fundZ < -2 && priceZ < -1) { dir = "short"; }
        if (!dir) continue;
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---- Engine F: BB-Squeeze Breakout on 4h bars ----
// Entry conditions (all must hold on bar i, using bar i-1 for signal):
//   1. BB(20,2) width < 20th percentile of last 100 bars  (squeeze armed)
//   2. Next close breaks above upper band (long) or below lower band (short)
// BTC 4h EMA(12/21) for longs; shorts unfiltered.
// SL: ATR(14)*2, capped at 3.5%.
// Exit: opposite BB band touch OR 48h max hold.
function genBBSqueeze(size: number): Signal[] {
  const sigs: Signal[] = [];
  const BB_PERIOD    = 20;
  const BB_MULT      = 2;
  const PCTILE_WIN   = 100;
  const PCTILE_RANK  = 0.20;
  const MAX_HOLD_H   = 48;

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < BB_PERIOD + PCTILE_WIN + 5) continue;

    const closes = cs.map(c => c.c);
    const atr    = calcATR(cs, 14);

    // Precompute BB bands for all bars
    const bbMid:   number[] = new Array(cs.length).fill(0);
    const bbUpper: number[] = new Array(cs.length).fill(0);
    const bbLower: number[] = new Array(cs.length).fill(0);
    const bbWidth: number[] = new Array(cs.length).fill(0);

    for (let i = BB_PERIOD - 1; i < cs.length; i++) {
      let sum = 0;
      for (let j = i - BB_PERIOD + 1; j <= i; j++) sum += closes[j];
      const mid = sum / BB_PERIOD;
      let varSum = 0;
      for (let j = i - BB_PERIOD + 1; j <= i; j++) varSum += (closes[j] - mid) ** 2;
      const std  = Math.sqrt(varSum / BB_PERIOD);
      bbMid[i]   = mid;
      bbUpper[i] = mid + BB_MULT * std;
      bbLower[i] = mid - BB_MULT * std;
      bbWidth[i] = mid > 0 ? (bbUpper[i] - bbLower[i]) / mid : 0;
    }

    let squeezeArmed = false;
    let pos: any = null;

    // Start from bar where we have full 100-bar percentile window
    const startI = BB_PERIOD - 1 + PCTILE_WIN;

    for (let i = startI; i < cs.length; i++) {
      const bar = cs[i];

      // ---- Exit logic ----
      if (pos) {
        let xp = 0, reason = "";

        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }

        // Opposite band touch
        if (!xp && bbLower[i] > 0 && bbUpper[i] > 0) {
          if (pos.dir === "long"  && bar.l <= bbLower[i]) { xp = bbLower[i]; reason = "bb_exit"; }
          else if (pos.dir === "short" && bar.h >= bbUpper[i]) { xp = bbUpper[i]; reason = "bb_exit"; }
        }

        // Max hold 48h
        if (!xp && (bar.t - pos.et) / H >= MAX_HOLD_H) { xp = bar.c; reason = "mh"; }

        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "F", size, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
          squeezeArmed = false;
        }
      }

      // ---- Entry logic ----
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        // Compute 20th percentile of widths from bars [i-PCTILE_WIN .. i-1]
        const window: number[] = [];
        for (let j = i - PCTILE_WIN; j < i; j++) {
          if (bbWidth[j] > 0) window.push(bbWidth[j]);
        }
        if (window.length < 50) continue;
        window.sort((a, b) => a - b);
        const p20 = window[Math.floor(window.length * PCTILE_RANK)];

        // Previous completed bar for signal
        const prev = i - 1;
        if (bbWidth[prev] <= 0) continue;

        // Arm squeeze if previous bar's width is below 20th percentile
        if (bbWidth[prev] < p20) squeezeArmed = true;

        if (!squeezeArmed) continue;

        // Breakout: prev close crosses outside bands
        let dir: "long"|"short"|null = null;
        if (closes[prev] > bbUpper[prev] && bbUpper[prev] > 0) dir = "long";
        else if (closes[prev] < bbLower[prev] && bbLower[prev] > 0) dir = "short";

        if (!dir) continue;

        // BTC 4h EMA(12/21) filter: longs only
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;

        const prevATR = atr[prev]; if (prevATR <= 0) continue;

        // SL: ATR(14)*2, capped 3.5%
        let sl = dir === "long" ? bar.o - 2 * prevATR : bar.o + 2 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965); else sl = Math.min(sl, bar.o * 1.035);

        pos = { dir, ep: bar.o, et: bar.t, sl };
        squeezeArmed = false;
      }
    }
  }
  return sigs;
}

// ---- PnL sim (signal-level exits, no 1m needed) ----
function simTrade(sig: Signal): number {
  const NOT = sig.size * LEV;
  const ep  = entryPx(sig.pair, sig.dir, sig.entryPrice);
  const xp  = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return calcPnl(sig.dir, ep, xp, NOT);
}

// ---- Pool-based ensemble (shared position pool, max MAX_POS) ----
type Trade = { pnl: number; exitTime: number; entryTime: number; engine: string; pair: string; exitReason: string };

function runEnsemble(allSignals: Signal[], startTs: number, endTs: number): { trades: Trade[]; blocked: number } {
  interface Event { t: number; type: "entry"|"exit"; idx: number }
  const events: Event[] = [];
  for (let idx = 0; idx < allSignals.length; idx++) {
    const s = allSignals[idx];
    if (s.entryTime < startTs || s.entryTime >= endTs) continue;
    events.push({ t: s.entryTime,  type: "entry", idx });
    events.push({ t: s.exitTime,   type: "exit",  idx });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPos = new Map<string, number>(); // engine:pair -> idx
  const accepted: Signal[] = [];
  for (const evt of events) {
    const s = allSignals[evt.idx];
    const key = `${s.engine}:${s.pair}`;
    if (evt.type === "exit") { openPos.delete(key); }
    else {
      if (openPos.has(key)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(key, evt.idx);
      accepted.push(s);
    }
  }

  const trades: Trade[] = accepted.map(sig => ({
    pnl: simTrade(sig), exitTime: sig.exitTime, entryTime: sig.entryTime,
    engine: sig.engine, pair: sig.pair, exitReason: sig.exitReason,
  }));

  const totalInPeriod = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length };
}

// ---- Stats ----
interface Stats { label: string; trades: number; wr: number; total: number; perDay: number; pf: number; sharpe: number; maxDD: number; }

function computeStats(trades: Trade[], days: number, label: string): Stats {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) { const d = Math.floor(t.exitTime / D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    label, trades: trades.length,
    wr:    trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf:    gl > 0 ? gp / gl : (gp > 0 ? 99 : 0),
    total, perDay: total / days, maxDD, sharpe,
  };
}

// ---- Generate all signals ----
console.log("Generating signals...");
const donchSigs = genDonchian();
const stSigs    = genSupertrend();
const garchSigs = genGarchV2();
const momSigs   = genMomentumConfirm();
const bbSigs3   = genBBSqueeze(3);
const bbSigs5   = genBBSqueeze(5);

console.log(`  A (Donchian):   ${donchSigs.length}`);
console.log(`  B (Supertrend): ${stSigs.length}`);
console.log(`  C (GARCH v2):   ${garchSigs.length}`);
console.log(`  D (Momentum):   ${momSigs.length}`);
console.log(`  F (BB-Squeeze): ${bbSigs3.length} signals`);
console.log();

const days    = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START)  / D;

// ---- Run all 4 configs ----
console.log("Running Config 1: Baseline 4 engines...");
const base4Sigs = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];
const c1f = runEnsemble(base4Sigs, FULL_START, FULL_END);
const c1o = runEnsemble(base4Sigs, OOS_START,  FULL_END);

console.log("Running Config 2: 4 engines + BB-Squeeze $3...");
const c2Sigs = [...base4Sigs, ...bbSigs3];
const c2f = runEnsemble(c2Sigs, FULL_START, FULL_END);
const c2o = runEnsemble(c2Sigs, OOS_START,  FULL_END);

console.log("Running Config 3: 4 engines + BB-Squeeze $5...");
const c3Sigs = [...base4Sigs, ...bbSigs5];
const c3f = runEnsemble(c3Sigs, FULL_START, FULL_END);
const c3o = runEnsemble(c3Sigs, OOS_START,  FULL_END);

console.log("Running Config 4: BB-Squeeze SOLO $3...");
const c4f = runEnsemble(bbSigs3, FULL_START, FULL_END);
const c4o = runEnsemble(bbSigs3, OOS_START,  FULL_END);

// ---- Stats for all configs ----
const s1f = computeStats(c1f.trades, days, "Baseline (4 eng)");
const s1o = computeStats(c1o.trades, oosDays, "");
const s2f = computeStats(c2f.trades, days, "4 eng + BB $3");
const s2o = computeStats(c2o.trades, oosDays, "");
const s3f = computeStats(c3f.trades, days, "4 eng + BB $5");
const s3o = computeStats(c3o.trades, oosDays, "");
const s4f = computeStats(c4f.trades, days, "BB-Squeeze SOLO");
const s4o = computeStats(c4o.trades, oosDays, "");

// ---- Engine F breakdown ----
function fBreakdown(poolTrades: Trade[], allF: Signal[]) {
  const poolSet = new Set(poolTrades.filter(t => t.engine === "F").map(t => `${t.entryTime}:${t.pair}`));
  const inPool = allF.filter(s => poolSet.has(`${s.entryTime}:${s.pair}`));
  const longs = inPool.filter(s => s.dir === "long").length;
  const shorts = inPool.filter(s => s.dir === "short").length;
  const sl = inPool.filter(s => s.exitReason === "sl").length;
  const bb = inPool.filter(s => s.exitReason === "bb_exit").length;
  const mh = inPool.filter(s => s.exitReason === "mh").length;
  return { total: inPool.length, longs, shorts, sl, bb, mh };
}

// ---- Print results ----
const SEP = "=".repeat(132);
console.log("\n" + SEP);
console.log("BB-SQUEEZE ENGINE F VALIDATION vs 4-ENGINE ENSEMBLE");
console.log("Engines A+B+C+D: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3");
console.log("Engine F: BB(20,2) squeeze breakout 4h | BTC 4h EMA(12/21) longs | SL ATR(14)x2 cap 3.5% | Exit: opp band or 48h");
console.log("15 pairs | Full: 2023-01 to 2026-03 | OOS: 2025-09+ | Pool max 20 (independent per config)");
console.log(SEP);

const H1 = `${"Config".padEnd(22)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total $".padStart(11)} ${"$/day".padStart(9)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(9)} ${"OOS$/day".padStart(10)} ${"OOS PF".padStart(8)} ${"Blocked".padStart(8)}`;
console.log("\n" + H1);
console.log("-".repeat(132));

function printRow(sf: Stats, so: Stats, blocked: number) {
  console.log(
    sf.label.padEnd(22) +
    String(sf.trades).padStart(8) +
    (sf.wr.toFixed(1) + "%").padStart(8) +
    ("$" + sf.total.toFixed(2)).padStart(12) +
    ("$" + sf.perDay.toFixed(3)).padStart(10) +
    sf.pf.toFixed(2).padStart(8) +
    sf.sharpe.toFixed(2).padStart(9) +
    ("$" + sf.maxDD.toFixed(0)).padStart(10) +
    ("$" + so.perDay.toFixed(3)).padStart(11) +
    so.pf.toFixed(2).padStart(9) +
    String(blocked).padStart(9)
  );
}

printRow(s1f, s1o, c1f.blocked);
printRow(s2f, s2o, c2f.blocked);
printRow(s3f, s3o, c3f.blocked);
printRow(s4f, s4o, c4f.blocked);

console.log("\n--- Engine F breakdown within pool ---");
const b2 = fBreakdown(c2f.trades, bbSigs3);
const b3 = fBreakdown(c3f.trades, bbSigs5);
const b4 = fBreakdown(c4f.trades, bbSigs3);
console.log(`  Config 2 (F $3 in ensemble): ${b2.total} trades | L:${b2.longs} S:${b2.shorts} | SL:${b2.sl} BB-exit:${b2.bb} MaxHold:${b2.mh}`);
console.log(`  Config 3 (F $5 in ensemble): ${b3.total} trades | L:${b3.longs} S:${b3.shorts} | SL:${b3.sl} BB-exit:${b3.bb} MaxHold:${b3.mh}`);
console.log(`  Config 4 (F SOLO $3):        ${b4.total} trades | L:${b4.longs} S:${b4.shorts} | SL:${b4.sl} BB-exit:${b4.bb} MaxHold:${b4.mh}`);

console.log("\n--- Delta vs Baseline ---");
const d2 = s2f.perDay - s1f.perDay;
const d3 = s3f.perDay - s1f.perDay;
const dd2 = s2f.maxDD - s1f.maxDD;
const dd3 = s3f.maxDD - s1f.maxDD;
console.log(`  +BB $3: ${d2 >= 0 ? "+" : ""}$${d2.toFixed(3)}/day   MaxDD delta: ${dd2 >= 0 ? "+" : ""}$${dd2.toFixed(0)}`);
console.log(`  +BB $5: ${d3 >= 0 ? "+" : ""}$${d3.toFixed(3)}/day   MaxDD delta: ${dd3 >= 0 ? "+" : ""}$${dd3.toFixed(0)}`);

console.log("\n" + SEP);
console.log("Done.");
