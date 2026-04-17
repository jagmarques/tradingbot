/**
 * DEFINITIVE Trail + Re-entry Backtest
 *
 * Architecture:
 *   Phase 1: Generate all engine signals (validated logic from bt-trail-full-ensemble.ts)
 *   Phase 2: Pre-compute engine exits for each signal using 5m bars
 *   Phase 3: For each trail config, run chronological pool simulation with trail + re-entry
 *
 * Key rules:
 *   - Trail check uses 1m bars (or 5m fallback) between entry and engine exit
 *   - Trail close uses 1m bar close price (spread, NOT SL slippage)
 *   - Re-entry scheduled at NEXT engine interval after trail fires
 *   - Re-entry checks signal still active on COMPLETED bars only (no look-ahead)
 *   - Re-entry must pass pool cap (if pool full, skip)
 *   - Re-entry gets fresh ATR SL, pays full spread+fees
 *   - Re-entry is NOT trailed (runs to engine exit or SL)
 *   - Only 1 re-entry per original trade
 *   - 1m data loaded one pair at a time to avoid OOM
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-reentry-definitive.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface C { t: number; o: number; h: number; l: number; c: number; }

// ─── Constants ─────────────────────────────────────────────────────────────────

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 20;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// Engine check intervals for re-entry timing
const ENGINE_INTERVAL: Record<string, number> = {
  A: D,    // Donchian: next calendar day
  B: H4,   // Supertrend: next 4h bar
  C: H,    // GARCH v2: next 1h bar
  D: H4,   // Momentum Confirm: next 4h bar
};

// Engine margin sizes
const ENGINE_MARGIN: Record<string, number> = {
  A: 2,  // Donchian SMA(20/50) $2
  B: 3,  // Supertrend(14,1.75) $3
  C: 9,  // GARCH v2 $9
  D: 3,  // Momentum Confirm $3
};

// Half-spreads from live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET",
];

// ─── Data loading ──────────────────────────────────────────────────────────────

function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
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
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators (SMA ATR, exact match to bt-trail-full-ensemble.ts) ────────

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
  }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += trs[j];
    atr[i] = s / period;
  }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (!init) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period;
      init = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
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

// z-score: use i-volWin to i (exactly volWin+1 bars => volWin returns)
function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j-1].c - 1;
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

// ─── Price helpers ─────────────────────────────────────────────────────────────

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// ─── Load 5m data + aggregates ─────────────────────────────────────────────────

console.log("Loading 5m data and aggregating...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// ─── BTC filters ───────────────────────────────────────────────────────────────

const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);

// Strict < excludes incomplete current daily bar (matches live slice(0,-1))
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) {
    for (let i = btcH1.length - 1; i >= 0; i--) {
      if (btcH1[i].t <= t) { idx = i; break; }
    }
  }
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  const off9 = btcH1.length - btcH1Ema9.length;
  const off21 = btcH1.length - btcH1Ema21.length;
  const i9 = prev - off9;
  const i21 = prev - off21;
  if (i9 < 0 || i21 < 0) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

console.log(`  Loaded ${raw5m.size} pairs (5m), BTC daily: ${btcDaily.length} bars\n`);

// ─── Signal type ───────────────────────────────────────────────────────────────

interface Signal {
  id: number;
  pair: string;
  dir: "long"|"short";
  engine: string;
  size: number;          // margin $
  entryTime: number;
  entryPrice: number;    // raw price (no spread applied yet)
  sl: number;
  exitTime: number;      // engine-determined exit time
  exitPrice: number;     // engine-determined exit price
  exitReason: string;
}

// ─── Engine A: Donchian SMA(20/50) Daily ───────────────────────────────────────

function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        const hd = Math.round((bar.t - pos.et) / D);
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long") {
            const lo = donchCloseLow(cs, i, 15);
            if (bar.c < lo) { xp = bar.c; reason = "ch"; }
          } else {
            const hi = donchCloseHigh(cs, i, 15);
            if (bar.c > hi) { xp = bar.c; reason = "ch"; }
          }
        }
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({ id: 0, pair, dir: pos.dir, engine: "A", size: ENGINE_MARGIN.A, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos) {
        const p = i - 1;
        const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Engine B: Supertrend(14, 1.75) 4h ────────────────────────────────────────

function genSupertrend(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      const flip = stDir[i-1] !== stDir[i-2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({ id: 0, pair, dir: pos.dir, engine: "B", size: ENGINE_MARGIN.B, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Engine C: GARCH v2 (z1h>4.5 & z4h>3.0, 3%SL, 7%TP, 96h hold) ──────────

function genGarchV2(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;
    const z1h = computeZScores(h1, 3, 20);
    const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c);
    const ema9 = calcEMA(h1Closes, 9);
    const ema21 = calcEMA(h1Closes, 21);
    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));
    let pos: any = null;
    for (let i = 24; i < h1.length; i++) {
      const bar = h1[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t - pos.et) / H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({ id: 0, pair, dir: pos.dir, engine: "C", size: ENGINE_MARGIN.C, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        if (prev < 23) continue;
        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;
        const goLong = z1 > 4.5;
        const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= 3.0) continue;
        if (goShort && z4 >= -3.0) continue;
        const off9 = h1.length - ema9.length;
        const off21 = h1.length - ema21.length;
        const i9 = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0) continue;
        if (goLong && ema9[i9] <= ema21[i21]) continue;
        if (goShort && ema9[i9] >= ema21[i21]) continue;
        const btcT = btcH1Trend(h1[prev].t);
        if (goLong && btcT !== "long") continue;
        if (goShort && btcT !== "short") continue;
        const dir: "long"|"short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Engine D: Momentum Confirm (4h volume/funding/price z-scores) ─────────

function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 55) continue;
    let pos: any = null;
    for (let i = 52; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && (bar.t - pos.et) / H >= 48) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({ id: 0, pair, dir: pos.dir, engine: "D", size: ENGINE_MARGIN.D, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        const ranges: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
        const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
        const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
        const fp: number[] = [];
        for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
        const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
        const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
        const closes: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
        if (closes.length < 20) continue;
        const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
        const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
        const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;
        let dir: "long"|"short"|null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcDailyBullish(bar.t)) dir = "long"; }
        else if (volZ > 2 && fundZ < -2 && priceZ < -1) { dir = "short"; }
        if (!dir) continue;
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Re-entry signal check functions ───────────────────────────────────────────
// Each returns whether the signal is still active at the given time on completed bars.
// Also returns the fresh SL and the engine-determined exit for the re-entry trade.

interface ReEntryCheck {
  active: boolean;
  entryPrice: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
}

const NO_REENTRY: ReEntryCheck = { active: false, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };

function checkReEntryA(pair: string, dir: "long"|"short", reEntryBarTs: number): ReEntryCheck {
  const cs = dailyData.get(pair);
  if (!cs) return NO_REENTRY;
  const closes = cs.map(c => c.c);
  const fast = calcSMA(closes, 20);
  const slow = calcSMA(closes, 50);
  const atr = calcATR(cs, 14);
  for (let i = 51; i < cs.length; i++) {
    if (cs[i].t < reEntryBarTs) continue;
    if (cs[i].t > reEntryBarTs) return NO_REENTRY; // missed the bar
    // Found the exact bar -- check completed bar i-1
    const p = i - 1;
    if (fast[p] === 0 || slow[p] === 0) return NO_REENTRY;
    const stillActive = dir === "long" ? fast[p] > slow[p] : fast[p] < slow[p];
    if (!stillActive) return NO_REENTRY;
    if (dir === "long" && !btcDailyBullish(cs[i].t)) return NO_REENTRY;
    const prevATR = atr[i - 1];
    if (prevATR <= 0) return NO_REENTRY;
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    // Find exit from bar i+1
    for (let j = i + 1; j < cs.length; j++) {
      const bar = cs[j];
      const hd = Math.round((bar.t - cs[i].t) / D);
      if (dir === "long" && bar.l <= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (dir === "short" && bar.h >= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (j >= 16) {
        if (dir === "long") { const lo = donchCloseLow(cs, j, 15); if (bar.c < lo) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
        else { const hi = donchCloseHigh(cs, j, 15); if (bar.c > hi) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
      }
      if (hd >= 60) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
    }
    // No exit found, use last bar
    const last = cs[cs.length - 1];
    return { active: true, entryPrice: cs[i].o, sl, exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
  }
  return NO_REENTRY;
}

function checkReEntryB(pair: string, dir: "long"|"short", reEntryBarTs: number): ReEntryCheck {
  const cs = h4Data.get(pair);
  if (!cs) return NO_REENTRY;
  const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
  const atr = calcATR(cs, 14);
  for (let i = 17; i < cs.length; i++) {
    if (cs[i].t < reEntryBarTs) continue;
    if (cs[i].t > reEntryBarTs) return NO_REENTRY;
    // Check supertrend direction at completed bar i-1
    const curDir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
    if (curDir !== dir) return NO_REENTRY;
    if (dir === "long" && !btcDailyBullish(cs[i].t)) return NO_REENTRY;
    const prevATR = atr[i - 1];
    if (prevATR <= 0) return NO_REENTRY;
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    for (let j = i + 1; j < cs.length; j++) {
      const bar = cs[j];
      if (dir === "long" && bar.l <= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (dir === "short" && bar.h >= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (stDir[j] !== stDir[j - 1]) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.o, exitReason: "flip" };
      if ((bar.t - cs[i].t) / H >= 60 * 24) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
    }
    const last = cs[cs.length - 1];
    return { active: true, entryPrice: cs[i].o, sl, exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
  }
  return NO_REENTRY;
}

function checkReEntryC(pair: string, dir: "long"|"short", reEntryBarTs: number): ReEntryCheck {
  const h1 = h1Data.get(pair);
  const h4 = h4Data.get(pair);
  if (!h1 || !h4) return NO_REENTRY;
  const z1h = computeZScores(h1, 3, 20);
  const z4h = computeZScores(h4, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const ema9 = calcEMA(h1Closes, 9);
  const ema21 = calcEMA(h1Closes, 21);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));

  for (let i = 24; i < h1.length; i++) {
    if (h1[i].t < reEntryBarTs) continue;
    if (h1[i].t > reEntryBarTs) return NO_REENTRY;
    const prev = i - 1;
    if (prev < 23) return NO_REENTRY;
    const z1 = z1h[prev];
    if (isNaN(z1) || z1 === 0) return NO_REENTRY;
    const goLong = dir === "long" && z1 > 4.5;
    const goShort = dir === "short" && z1 < -3.0;
    if (!goLong && !goShort) return NO_REENTRY;
    const ts4h = Math.floor(h1[prev].t / H4) * H4;
    const idx4h = h4TsMap.get(ts4h);
    if (idx4h === undefined || idx4h < 23) return NO_REENTRY;
    const z4 = z4h[idx4h];
    if (goLong && z4 <= 3.0) return NO_REENTRY;
    if (goShort && z4 >= -3.0) return NO_REENTRY;
    const off9 = h1.length - ema9.length;
    const off21 = h1.length - ema21.length;
    const i9 = prev - off9;
    const i21 = prev - off21;
    if (i9 < 0 || i21 < 0) return NO_REENTRY;
    if (goLong && ema9[i9] <= ema21[i21]) return NO_REENTRY;
    if (goShort && ema9[i9] >= ema21[i21]) return NO_REENTRY;
    const btcT = btcH1Trend(h1[prev].t);
    if (goLong && btcT !== "long") return NO_REENTRY;
    if (goShort && btcT !== "short") return NO_REENTRY;
    let sl = dir === "long" ? h1[i].o * (1 - 0.03) : h1[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, h1[i].o * 0.965);
    else sl = Math.min(sl, h1[i].o * 1.035);
    const tp = dir === "long" ? h1[i].o * 1.07 : h1[i].o * 0.93;
    for (let j = i + 1; j < h1.length; j++) {
      const bar = h1[j];
      if (dir === "long" && bar.l <= sl) return { active: true, entryPrice: h1[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (dir === "short" && bar.h >= sl) return { active: true, entryPrice: h1[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (dir === "long" && bar.h >= tp) return { active: true, entryPrice: h1[i].o, sl, exitTime: bar.t, exitPrice: tp, exitReason: "tp" };
      if (dir === "short" && bar.l <= tp) return { active: true, entryPrice: h1[i].o, sl, exitTime: bar.t, exitPrice: tp, exitReason: "tp" };
      if ((bar.t - h1[i].t) / H >= 96) return { active: true, entryPrice: h1[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
    }
    const last = h1[h1.length - 1];
    return { active: true, entryPrice: h1[i].o, sl, exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
  }
  return NO_REENTRY;
}

function checkReEntryD(pair: string, dir: "long"|"short", reEntryBarTs: number): ReEntryCheck {
  const cs = h4Data.get(pair);
  if (!cs) return NO_REENTRY;
  for (let i = 52; i < cs.length; i++) {
    if (cs[i].t < reEntryBarTs) continue;
    if (cs[i].t > reEntryBarTs) return NO_REENTRY;
    const prev = i - 1;
    const ranges: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
    if (ranges.length < 20) return NO_REENTRY;
    const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
    const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
    const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
    const fp: number[] = [];
    for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
    if (fp.length < 20) return NO_REENTRY;
    const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
    const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
    const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
    const closes: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
    if (closes.length < 20) return NO_REENTRY;
    const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
    const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;
    let curDir: "long"|"short"|null = null;
    if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcDailyBullish(cs[i].t)) curDir = "long"; }
    else if (volZ > 2 && fundZ < -2 && priceZ < -1) { curDir = "short"; }
    if (curDir !== dir) return NO_REENTRY;
    let sl = dir === "long" ? cs[i].o * (1 - 0.03) : cs[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    for (let j = i + 1; j < cs.length; j++) {
      const bar = cs[j];
      if (dir === "long" && bar.l <= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if (dir === "short" && bar.h >= sl) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
      if ((bar.t - cs[i].t) / H >= 48) return { active: true, entryPrice: cs[i].o, sl, exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
    }
    const last = cs[cs.length - 1];
    return { active: true, entryPrice: cs[i].o, sl, exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
  }
  return NO_REENTRY;
}

function checkReEntry(engine: string, pair: string, dir: "long"|"short", reEntryBarTs: number): ReEntryCheck {
  if (engine === "A") return checkReEntryA(pair, dir, reEntryBarTs);
  if (engine === "B") return checkReEntryB(pair, dir, reEntryBarTs);
  if (engine === "C") return checkReEntryC(pair, dir, reEntryBarTs);
  if (engine === "D") return checkReEntryD(pair, dir, reEntryBarTs);
  return NO_REENTRY;
}

// ─── Phase 1+2: Generate signals ───────────────────────────────────────────────

console.log("Phase 1: Generating all engine signals...");
const donchSigs = genDonchian();
const stSigs = genSupertrend();
const garchSigs = genGarchV2();
const momSigs = genMomentumConfirm();
const allSignals = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];
// Assign IDs
allSignals.forEach((s, i) => s.id = i);

console.log(`  A (Donchian):   ${donchSigs.length}`);
console.log(`  B (Supertrend): ${stSigs.length}`);
console.log(`  C (GARCH v2):   ${garchSigs.length}`);
console.log(`  D (Momentum):   ${momSigs.length}`);
console.log(`  Total:          ${allSignals.length} signals\n`);

// ─── Phase 3: Pre-compute trail results per-pair using 1m data ─────────────────
// For each signal, walk 1m bars (or 5m fallback) to find the peak P&L % at every bar.
// Store per-signal: array of { time, peakPct, closePct } checkpoints.
// This avoids loading 1m data multiple times per config.

interface TrailCheckpoint {
  t: number;          // bar timestamp
  peakPct: number;    // highest P&L % (leveraged) seen so far
  closePct: number;   // close-based P&L % at this bar
  closePrice: number; // close price of this bar
}

// For each signal, store:
//  - engine exit result (pnl, reason, exitTime) when no trail
//  - checkpoints array for trail simulation
//  - slHitTime/slPnl for SL hits before engine exit
//  - tpHitTime/tpPnl for TP hits (GARCH)

interface PrecomputedTrade {
  sig: Signal;
  // No-trail result
  noTrailPnl: number;
  noTrailReason: string;
  noTrailExitTime: number;
  // Checkpoints (only bars where peak could change or close could trigger trail)
  checkpoints: TrailCheckpoint[];
}

console.log("Phase 2: Pre-computing trade results with 1m precision (per-pair)...");

// Group signals by pair
const sigsByPair = new Map<string, Signal[]>();
for (const sig of allSignals) {
  let arr = sigsByPair.get(sig.pair);
  if (!arr) { arr = []; sigsByPair.set(sig.pair, arr); }
  arr.push(sig);
}

const precomputed = new Map<number, PrecomputedTrade>(); // keyed by signal id

for (const pair of PAIRS) {
  const pairSigs = sigsByPair.get(pair);
  if (!pairSigs || pairSigs.length === 0) continue;

  // Load 1m data for this pair (or null if missing)
  const bars1m = loadJson(CD_1M, pair);
  const has1m = bars1m.length > 0;

  // Fallback: use 5m data
  const barsFallback = raw5m.get(pair) ?? [];

  // Choose which bars to use for trail checks
  const trailBars = has1m ? bars1m : barsFallback;
  const barLabel = has1m ? "1m" : "5m";

  // Build timestamp index for binary search
  // (sorted by construction)

  process.stdout.write(`  ${pair} (${pairSigs.length} sigs, ${barLabel})...`);

  for (const sig of pairSigs) {
    const NOT = sig.size * LEV;
    const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

    if (trailBars.length === 0) {
      // No data at all: use engine exit directly
      const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
      precomputed.set(sig.id, {
        sig,
        noTrailPnl: calcPnl(sig.dir, ep, xp, NOT),
        noTrailReason: sig.exitReason,
        noTrailExitTime: sig.exitTime,
        checkpoints: [],
      });
      continue;
    }

    // Binary search for start index
    let lo = 0, hi = trailBars.length - 1, startIdx = trailBars.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trailBars[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }

    let peakPnlPct = 0;
    const checkpoints: TrailCheckpoint[] = [];
    let noTrailPnl = 0;
    let noTrailReason = sig.exitReason;
    let noTrailExitTime = sig.exitTime;
    let earlyExit = false;

    for (let i = startIdx; i < trailBars.length; i++) {
      const b = trailBars[i];
      if (b.t > sig.exitTime) break;

      // SL check
      if (sig.dir === "long" && b.l <= sig.sl) {
        const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "sl";
        noTrailExitTime = b.t;
        earlyExit = true;
        break;
      }
      if (sig.dir === "short" && b.h >= sig.sl) {
        const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
        noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
        noTrailReason = "sl";
        noTrailExitTime = b.t;
        earlyExit = true;
        break;
      }

      // GARCH v2 TP check (7%)
      if (sig.engine === "C") {
        const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
        if (sig.dir === "long" && b.h >= tp) {
          const xp = exitPx(sig.pair, sig.dir, tp, false);
          noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
          noTrailReason = "tp";
          noTrailExitTime = b.t;
          earlyExit = true;
          break;
        }
        if (sig.dir === "short" && b.l <= tp) {
          const xp = exitPx(sig.pair, sig.dir, tp, false);
          noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
          noTrailReason = "tp";
          noTrailExitTime = b.t;
          earlyExit = true;
          break;
        }
      }

      // Peak tracking (use best intrabar price)
      const bestPct = sig.dir === "long"
        ? (b.h / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.l - 1) * LEV * 100;
      if (bestPct > peakPnlPct) peakPnlPct = bestPct;

      // Close-based P&L %
      const closePct = sig.dir === "long"
        ? (b.c / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.c - 1) * LEV * 100;

      checkpoints.push({ t: b.t, peakPct: peakPnlPct, closePct, closePrice: b.c });
    }

    if (!earlyExit) {
      // Engine exit
      const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
      noTrailPnl = calcPnl(sig.dir, ep, xp, NOT);
    }

    precomputed.set(sig.id, {
      sig,
      noTrailPnl,
      noTrailReason,
      noTrailExitTime,
      checkpoints,
    });
  }

  console.log(" done");

  // 1m data goes out of scope here -- GC can reclaim it
}

console.log(`  Pre-computed ${precomputed.size} trades\n`);

// ─── Phase 4: Chronological pool simulation ────────────────────────────────────

interface TradeResult {
  sigId: number;
  pair: string;
  engine: string;
  dir: "long"|"short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReEntry: boolean;
}

interface ConfigResult {
  label: string;
  trades: number;
  reEntriesAccepted: number;
  reEntriesBlocked: number;
  wr: number;
  perDay: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  oosPerDay: number;
  oosPf: number;
  total: number;
  trailExits: number;
  blocked: number;
}

function runConfig(
  act: number,
  dist: number,
  withReEntry: boolean,
  startTs: number,
  endTs: number,
): { results: TradeResult[]; blocked: number; reEntriesAccepted: number; reEntriesBlocked: number } {

  // Filter signals in time range
  const inRange = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs);

  // For each signal, determine its exit (with trail or without)
  // We need to simulate the trail per-signal to get the exit time, then build events.

  // First pass: determine exit times for all signals under this trail config
  interface SignalOutcome {
    sig: Signal;
    exitTime: number;
    pnl: number;
    reason: string;
    trailFiredAt: number | null; // timestamp when trail fired (null if no trail)
    trailClosePrice: number;     // close price at trail fire
  }

  const outcomes: SignalOutcome[] = [];
  for (const sig of inRange) {
    const pc = precomputed.get(sig.id)!;

    if (act === 0 || pc.checkpoints.length === 0) {
      // No trail or no checkpoint data
      outcomes.push({
        sig,
        exitTime: pc.noTrailExitTime,
        pnl: pc.noTrailPnl,
        reason: pc.noTrailReason,
        trailFiredAt: null,
        trailClosePrice: 0,
      });
      continue;
    }

    // Walk checkpoints to find trail trigger
    let trailFired = false;
    for (const cp of pc.checkpoints) {
      if (cp.peakPct >= act && cp.closePct <= cp.peakPct - dist) {
        // Trail fires: close at bar close price (with spread, NOT SL slippage)
        const NOT = sig.size * LEV;
        const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
        const xp = exitPx(sig.pair, sig.dir, cp.closePrice, false);
        outcomes.push({
          sig,
          exitTime: cp.t,
          pnl: calcPnl(sig.dir, ep, xp, NOT),
          reason: "trail",
          trailFiredAt: cp.t,
          trailClosePrice: cp.closePrice,
        });
        trailFired = true;
        break;
      }
    }

    if (!trailFired) {
      // No trail trigger -- use engine exit
      outcomes.push({
        sig,
        exitTime: pc.noTrailExitTime,
        pnl: pc.noTrailPnl,
        reason: pc.noTrailReason,
        trailFiredAt: null,
        trailClosePrice: 0,
      });
    }
  }

  // Build chronological event list
  interface Evt {
    t: number;
    type: "entry" | "exit";
    outcomeIdx: number;
    key: string; // engine:pair
  }

  const events: Evt[] = [];
  for (let idx = 0; idx < outcomes.length; idx++) {
    const o = outcomes[idx];
    const key = `${o.sig.engine}:${o.sig.pair}`;
    events.push({ t: o.sig.entryTime, type: "entry", outcomeIdx: idx, key });
    events.push({ t: o.exitTime, type: "exit", outcomeIdx: idx, key });
  }
  // Sort: exits before entries at same timestamp (free slot before attempting fill)
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  // Simulate pool
  const openPool = new Map<string, number>(); // key -> outcomeIdx
  const accepted = new Set<number>(); // outcomeIdx
  let blocked = 0;

  for (const evt of events) {
    if (evt.type === "exit") {
      if (openPool.get(evt.key) === evt.outcomeIdx) {
        openPool.delete(evt.key);
      }
    } else {
      // Entry attempt
      if (openPool.has(evt.key)) { blocked++; continue; }
      if (openPool.size >= MAX_POS) { blocked++; continue; }
      openPool.set(evt.key, evt.outcomeIdx);
      accepted.add(evt.outcomeIdx);
    }
  }

  // Collect results for accepted trades
  const tradeResults: TradeResult[] = [];
  let reEntriesAccepted = 0;
  let reEntriesBlocked = 0;

  // Also track pool state for re-entries
  // We need a second chronological pass for re-entries since they are new events
  interface PendingReEntry {
    origOutcomeIdx: number;
    reEntryBarTs: number; // when to attempt re-entry
    engine: string;
    pair: string;
    dir: "long"|"short";
    key: string;
    size: number;
  }

  const pendingReEntries: PendingReEntry[] = [];

  // First: add accepted original trades to results and collect pending re-entries
  for (const idx of accepted) {
    const o = outcomes[idx];
    tradeResults.push({
      sigId: o.sig.id,
      pair: o.sig.pair,
      engine: o.sig.engine,
      dir: o.sig.dir,
      entryTime: o.sig.entryTime,
      exitTime: o.exitTime,
      pnl: o.pnl,
      reason: o.reason,
      isReEntry: false,
    });

    // If trail fired and re-entry allowed, schedule re-entry
    if (withReEntry && o.trailFiredAt !== null) {
      const interval = ENGINE_INTERVAL[o.sig.engine];
      const nextBarTs = Math.ceil((o.trailFiredAt + 1) / interval) * interval;
      if (nextBarTs < endTs) {
        pendingReEntries.push({
          origOutcomeIdx: idx,
          reEntryBarTs: nextBarTs,
          engine: o.sig.engine,
          pair: o.sig.pair,
          dir: o.sig.dir,
          key: `${o.sig.engine}:${o.sig.pair}`,
          size: o.sig.size,
        });
      }
    }
  }

  if (withReEntry && pendingReEntries.length > 0) {
    // Sort pending re-entries by time
    pendingReEntries.sort((a, b) => a.reEntryBarTs - b.reEntryBarTs);

    // Rebuild pool state chronologically to check if slot is available at re-entry time
    // We need all events (original accepted trades + re-entries as they are accepted)
    interface PoolEvent {
      t: number;
      type: "entry" | "exit";
      key: string;
      tradeIdx: number; // index in tradeResults
    }

    const poolEvents: PoolEvent[] = [];
    for (let i = 0; i < tradeResults.length; i++) {
      const tr = tradeResults[i];
      poolEvents.push({ t: tr.entryTime, type: "entry", key: `${tr.engine}:${tr.pair}`, tradeIdx: i });
      poolEvents.push({ t: tr.exitTime, type: "exit", key: `${tr.engine}:${tr.pair}`, tradeIdx: i });
    }

    // Process re-entries one at a time: check signal, check pool, if accepted add events
    for (const pending of pendingReEntries) {
      // Check if signal is still active
      const reCheck = checkReEntry(pending.engine, pending.pair, pending.dir, pending.reEntryBarTs);
      if (!reCheck.active) {
        reEntriesBlocked++;
        continue;
      }

      // Check pool state at re-entry time: replay all poolEvents up to pending.reEntryBarTs
      // Rebuild pool from scratch for correctness (pool events may have changed)
      poolEvents.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));
      const tempPool = new Map<string, number>();
      for (const pe of poolEvents) {
        if (pe.t > pending.reEntryBarTs) break;
        if (pe.type === "entry") {
          tempPool.set(pe.key, pe.tradeIdx);
        } else {
          if (tempPool.get(pe.key) === pe.tradeIdx) {
            tempPool.delete(pe.key);
          }
        }
      }

      // Check slot
      if (tempPool.has(pending.key)) {
        reEntriesBlocked++;
        continue;
      }
      if (tempPool.size >= MAX_POS) {
        reEntriesBlocked++;
        continue;
      }

      // Re-entry accepted -- compute P&L (no trail, runs to engine exit)
      const NOT = pending.size * LEV;
      const ep = entryPx(pending.pair, pending.dir, reCheck.entryPrice);
      const xp = exitPx(pending.pair, pending.dir, reCheck.exitPrice, reCheck.exitReason === "sl");
      const rePnl = calcPnl(pending.dir, ep, xp, NOT);

      const reTradeIdx = tradeResults.length;
      tradeResults.push({
        sigId: -1, // re-entry, not an original signal
        pair: pending.pair,
        engine: pending.engine,
        dir: pending.dir,
        entryTime: pending.reEntryBarTs,
        exitTime: reCheck.exitTime,
        pnl: rePnl,
        reason: reCheck.exitReason,
        isReEntry: true,
      });

      // Add pool events for this re-entry
      poolEvents.push({ t: pending.reEntryBarTs, type: "entry", key: pending.key, tradeIdx: reTradeIdx });
      poolEvents.push({ t: reCheck.exitTime, type: "exit", key: pending.key, tradeIdx: reTradeIdx });

      reEntriesAccepted++;
    }
  }

  return { results: tradeResults, blocked, reEntriesAccepted, reEntriesBlocked };
}

function computeStats(
  trades: TradeResult[],
  totalDays: number,
): { wr: number; pf: number; total: number; perDay: number; sharpe: number; maxDD: number; trailExits: number } {
  if (trades.length === 0) {
    return { wr: 0, pf: 0, total: 0, perDay: 0, sharpe: 0, maxDD: 0, trailExits: 0 };
  }
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  // MaxDD
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const trailExits = trades.filter(t => t.reason === "trail").length;

  return {
    wr: wins.length / trades.length * 100,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / totalDays,
    sharpe,
    maxDD,
    trailExits,
  };
}

// ─── Config grid ───────────────────────────────────────────────────────────────

interface TestConfig {
  act: number;
  dist: number;
  reEntry: boolean;
  label: string;
}

const CONFIGS: TestConfig[] = [
  // Baseline
  { act: 0, dist: 0, reEntry: false, label: "Baseline" },
  // Trail only (no re-entry)
  { act: 30, dist: 5, reEntry: false, label: "T 30/5" },
  { act: 40, dist: 7, reEntry: false, label: "T 40/7" },
  { act: 40, dist: 10, reEntry: false, label: "T 40/10" },
  // Trail + re-entry
  { act: 20, dist: 3, reEntry: true, label: "TR 20/3" },
  { act: 20, dist: 5, reEntry: true, label: "TR 20/5" },
  { act: 25, dist: 5, reEntry: true, label: "TR 25/5" },
  { act: 30, dist: 3, reEntry: true, label: "TR 30/3" },
  { act: 30, dist: 5, reEntry: true, label: "TR 30/5" },
  { act: 30, dist: 7, reEntry: true, label: "TR 30/7" },
  { act: 35, dist: 5, reEntry: true, label: "TR 35/5" },
  { act: 40, dist: 3, reEntry: true, label: "TR 40/3" },
  { act: 40, dist: 5, reEntry: true, label: "TR 40/5" },
  { act: 40, dist: 7, reEntry: true, label: "TR 40/7" },
  { act: 40, dist: 10, reEntry: true, label: "TR 40/10" },
  { act: 45, dist: 10, reEntry: true, label: "TR 45/10" },
];

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log("Phase 3: Running chronological pool simulations...\n");

const results: ConfigResult[] = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`  ${cfg.label.padEnd(12)}...`);

  // Full period
  const full = runConfig(cfg.act, cfg.dist, cfg.reEntry, FULL_START, FULL_END);
  const fullStats = computeStats(full.results, fullDays);

  // OOS period
  const oos = runConfig(cfg.act, cfg.dist, cfg.reEntry, OOS_START, FULL_END);
  const oosStats = computeStats(oos.results, oosDays);

  results.push({
    label: cfg.label,
    trades: full.results.length,
    reEntriesAccepted: full.reEntriesAccepted,
    reEntriesBlocked: full.reEntriesBlocked,
    wr: fullStats.wr,
    perDay: fullStats.perDay,
    pf: fullStats.pf,
    sharpe: fullStats.sharpe,
    maxDD: fullStats.maxDD,
    oosPerDay: oosStats.perDay,
    oosPf: oosStats.pf,
    total: fullStats.total,
    trailExits: fullStats.trailExits,
    blocked: full.blocked,
  });

  console.log(` $${fullStats.perDay.toFixed(2)}/day, DD $${fullStats.maxDD.toFixed(0)}, PF ${fullStats.pf.toFixed(2)}, trails ${fullStats.trailExits}, re-in ${full.reEntriesAccepted}/${full.reEntriesAccepted + full.reEntriesBlocked}`);
}

// ─── Output ────────────────────────────────────────────────────────────────────

// Sort by $/day descending
results.sort((a, b) => b.perDay - a.perDay);

const W = 155;
console.log("\n" + "=".repeat(W));
console.log("DEFINITIVE TRAIL + RE-ENTRY BACKTEST");
console.log("Engines: Donchian $2 + Supertrend $3 + GARCH v2 $9 + Momentum $3 | 23 pairs | Pool max 20");
console.log("1m precision for trail | Re-entry at next engine bar, signal must be active, pool must have slot");
console.log("Re-entry is NOT trailed (runs to engine exit) | Only 1 re-entry per original trade");
console.log(`Full: 2023-01 to 2026-03 (${fullDays.toFixed(0)}d) | OOS: 2025-09+ (${oosDays.toFixed(0)}d)`);
console.log("=".repeat(W));

const hdr =
  "Config".padEnd(13) +
  "Trades".padStart(7) +
  "ReIn".padStart(6) +
  "ReBlk".padStart(6) +
  "WR%".padStart(7) +
  "Total$".padStart(10) +
  "$/day".padStart(8) +
  "PF".padStart(6) +
  "Sharpe".padStart(8) +
  "MaxDD".padStart(8) +
  "Blkd".padStart(6) +
  "Trails".padStart(7) +
  " | " +
  "OOS$/d".padStart(8) +
  "OOS PF".padStart(8);

console.log("\n" + hdr);
console.log("-".repeat(W));

const baselinePerDay = results.find(r => r.label === "Baseline")?.perDay ?? 0;

for (const r of results) {
  const mark = r.label === "Baseline" ? " <<<" : "";
  const delta = r.label !== "Baseline" ? ` (${r.perDay >= baselinePerDay ? "+" : ""}${(r.perDay - baselinePerDay).toFixed(2)})` : "";
  console.log(
    r.label.padEnd(13) +
    String(r.trades).padStart(7) +
    String(r.reEntriesAccepted).padStart(6) +
    String(r.reEntriesBlocked).padStart(6) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.total.toFixed(0)).padStart(10) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    r.sharpe.toFixed(2).padStart(8) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.blocked).padStart(6) +
    String(r.trailExits).padStart(7) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(8) +
    r.oosPf.toFixed(2).padStart(8) +
    mark + delta
  );
}

// Summary
console.log("\n" + "=".repeat(W));
const baseline = results.find(r => r.label === "Baseline")!;
const bestTrail = results.filter(r => r.label !== "Baseline")[0];
const bestReEntry = results.filter(r => r.label.startsWith("TR "))[0];

console.log("SUMMARY");
console.log("-".repeat(W));
console.log(`  Baseline:       $${baseline.perDay.toFixed(2)}/day, MaxDD $${baseline.maxDD.toFixed(0)}, Sharpe ${baseline.sharpe.toFixed(2)}, PF ${baseline.pf.toFixed(2)}, OOS $${baseline.oosPerDay.toFixed(2)}/day`);
if (bestTrail) {
  console.log(`  Best trail:     ${bestTrail.label}: $${bestTrail.perDay.toFixed(2)}/day, MaxDD $${bestTrail.maxDD.toFixed(0)}, Sharpe ${bestTrail.sharpe.toFixed(2)}, PF ${bestTrail.pf.toFixed(2)}, OOS $${bestTrail.oosPerDay.toFixed(2)}/day`);
  const costStr = (baseline.perDay - bestTrail.perDay).toFixed(2);
  const pctStr = baseline.perDay > 0 ? ((1 - bestTrail.perDay / baseline.perDay) * 100).toFixed(1) : "N/A";
  if (bestTrail.perDay >= baseline.perDay) {
    console.log(`  TRAIL WINS:     +$${(bestTrail.perDay - baseline.perDay).toFixed(2)}/day over baseline`);
  } else {
    console.log(`  TRAIL COST:     -$${costStr}/day (${pctStr}% profit lost)`);
  }
}
if (bestReEntry && bestReEntry !== bestTrail) {
  console.log(`  Best re-entry:  ${bestReEntry.label}: $${bestReEntry.perDay.toFixed(2)}/day, MaxDD $${bestReEntry.maxDD.toFixed(0)}, re-entries: ${bestReEntry.reEntriesAccepted}`);
}

// Check if ANY trail+reentry config beats baseline
const anyBeats = results.some(r => r.label !== "Baseline" && r.perDay > baseline.perDay);
console.log(`\n  VERDICT: ${anyBeats ? "YES, trail+reentry CAN beat baseline" : "NO trail+reentry config beats baseline"}`);

console.log("\nDone.");
