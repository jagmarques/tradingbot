/**
 * Kelly-Optimal Position Sizing Test – Full Ensemble
 * Compares 4 sizing configs on the same signal universe.
 * Each config runs its OWN pool (different sizes = different blocking patterns).
 *
 * Configs (~$18 total margin):
 *   1. Baseline:    A=$7 B=$5 C=$3 D=$3
 *   2. Kelly:       A=$2 B=$3 C=$9 D=$4
 *   3. Half-Kelly:  A=$3 B=$4 C=$6 D=$3
 *   4. GARCH-heavy: A=$5 B=$5 C=$7 D=$3
 *
 * All known bugs fixed: SMA ATR, half-spreads, SMA look-ahead (i-1 vs i-2),
 * BTC 4h EMA(12/21) removed (uses daily EMA20/50 + 1h EMA9/21 for GARCH),
 * GARCH 7% TP, z-score 21 returns.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-kelly-sizing-ensemble.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M  = "/tmp/bt-pair-cache-1m";
const H  = 3_600_000;
const H4 = 4 * H;
const D  = 86_400_000;
const FEE     = 0.000_35;
const SL_SLIP = 1.5;
const LEV     = 10;
const MAX_POS = 20;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Half-spreads – match live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4,  ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4,   LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4,    DOT: 4.95e-4,  ADA: 5.55e-4,  LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4,  SOL: 2.0e-4,   ETH: 1.0e-4,   WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4,    AVAX: 3e-4,    NEAR: 4e-4,    SUI: 3e-4,   FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE",
  "APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","SUI","FET",
];

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
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
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// FIX: SMA of last N TRs – matches live indicators.ts (not Wilder's smoothing)
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i-1].c),
      Math.abs(cs[i].l - cs[i-1].c),
    );
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
    if (!init) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
    }
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
  const atr  = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub   = new Array(cs.length).fill(0);
  const lb   = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i]; let l = hl2 - m * atr[i];
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

// FIX: 21 returns in rolling vol window – matches live garch-v2-engine.ts
function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i-momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j-1].c - 1; sumSq += r * r; count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }

function entryPx(pair: string, dir: "long"|"short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}

function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number {
  const sp   = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}

function calcPnl(dir: "long"|"short", ep: number, xp: number, not: number): number {
  return (dir === "long" ? (xp/ep - 1)*not : (ep/xp - 1)*not) - not * FEE * 2;
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
console.log("Loading data...");

const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); console.log(`  ${p}: ${d.length} 1m bars`); }
}

const dailyData = new Map<string, C[]>();
const h4Data    = new Map<string, C[]>();
const h1Data    = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D,   200));
  h4Data.set(p,    aggregate(bars, H4,  40));
  h1Data.set(p,    aggregate(bars, H,   10));
}

// BTC daily EMA(20/50) for long filter
const btcDaily  = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20  = calcEMA(btcCloses, 20);
const btcEma50  = calcEMA(btcCloses, 50);

// FIX: strict less-than excludes incomplete current daily bar (matches live slice(0,-1))
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

// BTC 1h EMA(9/21) for GARCH trend filter
const btcH1       = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9   = calcEMA(btcH1Closes, 9);
const btcH1Ema21  = calcEMA(btcH1Closes, 21);
const btcH1TsMap  = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) {
    for (let i = btcH1.length - 1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } }
  }
  if (idx === undefined || idx < 1) return null;
  const prev  = idx - 1;
  const off9  = btcH1.length - btcH1Ema9.length;
  const off21 = btcH1.length - btcH1Ema21.length;
  const i9    = prev - off9;
  const i21   = prev - off21;
  if (i9 < 0 || i21 < 0) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

console.log("Data loaded.\n");

// ---------------------------------------------------------------------------
// Signal type (engine + entry/exit logic; size resolved at sim time)
// ---------------------------------------------------------------------------
interface Signal {
  pair: string; dir: "long"|"short"; engine: string;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number;  exitPrice: number;  exitReason: string;
}

// ---------------------------------------------------------------------------
// Engine A: Daily Donchian (SMA 30/60, Donchian-15 channel exit)
// FIX: i-1/i-2 look-ahead, SMA-based ATR
// ---------------------------------------------------------------------------
function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    const fast   = calcSMA(closes, 30);   // FIX: 30 (not 20)
    const slow   = calcSMA(closes, 60);   // FIX: 60 (not 50)
    const atr    = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 62; i < cs.length; i++) {
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
            sigs.push({ pair, dir: pos.dir, engine: "A",
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos) {
        // FIX: use completed bars i-1 and i-2; enter at bar[i] open
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Engine B: 4h Supertrend (14, 1.75)
// ---------------------------------------------------------------------------
function genSupertrend(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 17; i < cs.length; i++) {
      const bar  = cs[i];
      const flip = stDir[i-1] !== stDir[i-2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60*24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "B",
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Engine C: GARCH v2 Multi-TF Z-Score
// FIX: 21-return vol window, 7% TP
// ---------------------------------------------------------------------------
function genGarchV2(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair); const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;
    const z1h     = computeZScores(h1, 3, 20);
    const z4h     = computeZScores(h4, 3, 20);
    const h1Cls   = h1.map(c => c.c);
    const ema9    = calcEMA(h1Cls, 9);
    const ema21   = calcEMA(h1Cls, 21);
    const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));
    let pos: any = null;
    for (let i = 23; i < h1.length; i++) {
      const bar = h1[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long"  && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        // FIX: 7% TP
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long"  && bar.h >= tp) { xp = tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t - pos.et) / H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({ pair, dir: pos.dir, engine: "C",
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1; if (prev < 23) continue;
        const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) continue;
        const goLong  = z1 > 4.5;
        const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;
        const ts4h  = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h];
        if (goLong  && z4 <= 3.0)  continue;
        if (goShort && z4 >= -3.0) continue;
        const off9  = h1.length - ema9.length;
        const off21 = h1.length - ema21.length;
        const i9  = prev - off9;
        const i21 = prev - off21;
        if (i9 < 0 || i21 < 0) continue;
        if (goLong  && ema9[i9] <= ema21[i21]) continue;
        if (goShort && ema9[i9] >= ema21[i21]) continue;
        const btcT = btcH1Trend(h1[prev].t);
        if (goLong  && btcT !== "long")  continue;
        if (goShort && btcT !== "short") continue;
        const dir: "long"|"short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Engine D: Momentum Confirm (range-z + funding-proxy-z + price-z on 4h)
// ---------------------------------------------------------------------------
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
            sigs.push({ pair, dir: pos.dir, engine: "D",
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason });
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        const ranges: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s,v) => s+v, 0) / ranges.length;
        const rStd  = Math.sqrt(ranges.reduce((s,v) => s+(v-rMean)**2, 0) / ranges.length);
        const volZ  = rStd > 0 ? (ranges[ranges.length-1] - rMean) / rStd : 0;

        const fp: number[] = [];
        for (let j = Math.max(0, prev-50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s,v) => s+v, 0) / fp.length;
        const fpStd  = Math.sqrt(fp.reduce((s,v) => s+(v-fpMean)**2, 0) / fp.length);
        const fundZ  = fpStd > 0 ? (fp[fp.length-1] - fpMean) / fpStd : 0;

        const cls: number[] = [];
        for (let j = prev - 20; j <= prev; j++) { if (j >= 0) cls.push(cs[j].c); }
        if (cls.length < 20) continue;
        const cMean  = cls.reduce((s,v) => s+v, 0) / cls.length;
        const cStd   = Math.sqrt(cls.reduce((s,v) => s+(v-cMean)**2, 0) / cls.length);
        const priceZ = cStd > 0 ? (cls[cls.length-1] - cMean) / cStd : 0;

        let dir: "long"|"short"|null = null;
        if      (volZ > 2 && fundZ > 2  && priceZ > 1  && btcDailyBullish(bar.t)) dir = "long";
        else if (volZ > 2 && fundZ < -2 && priceZ < -1) dir = "short";
        if (!dir) continue;

        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// Simulate a single trade with 1m precision (no trailing – sizing comparison)
// ---------------------------------------------------------------------------
function simTrade(sig: Signal, size: number): { pnl: number; reason: string; exitTime: number } {
  const bars1m = raw1m.get(sig.pair);
  const NOT    = size * LEV;
  const ep     = entryPx(sig.pair, sig.dir, sig.entryPrice);

  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime };
  }

  // Binary search for entry bar
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; }
  }

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    if (sig.dir === "long"  && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }

    // FIX: GARCH 7% TP checked on 1m bars
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long"  && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t };
      }
    }
  }

  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime };
}

// ---------------------------------------------------------------------------
// Run ensemble with its own pool for a given sizing config
// ---------------------------------------------------------------------------
interface Trade { pnl: number; reason: string; exitTime: number; entryTime: number; engine: string; pair: string; }

function runEnsemble(
  signals: Signal[],
  sizeFor: (engine: string) => number,
  startTs: number,
  endTs:   number,
): { trades: Trade[]; blocked: number } {
  // Pre-compute 1m-adjusted exit times
  const processed = signals.map(sig => {
    const result = simTrade(sig, sizeFor(sig.engine));
    return { sig, adjExitTime: result.exitTime };
  });

  interface Evt { t: number; type: "entry"|"exit"; idx: number; }
  const evts: Evt[] = [];
  for (let idx = 0; idx < processed.length; idx++) {
    const { sig, adjExitTime } = processed[idx];
    if (sig.entryTime < startTs || sig.entryTime >= endTs) continue;
    evts.push({ t: sig.entryTime, type: "entry", idx });
    evts.push({ t: adjExitTime,   type: "exit",  idx });
  }
  evts.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPos = new Map<string, number>();   // key = engine:pair
  const accepted: number[] = [];
  for (const e of evts) {
    const { sig } = processed[e.idx];
    const key = `${sig.engine}:${sig.pair}`;
    if (e.type === "exit") { openPos.delete(key); }
    else {
      if (openPos.has(key)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(key, e.idx);
      accepted.push(e.idx);
    }
  }

  const trades: Trade[] = accepted.map(idx => {
    const { sig } = processed[idx];
    const result  = simTrade(sig, sizeFor(sig.engine));
    return { pnl: result.pnl, reason: result.reason, exitTime: result.exitTime, entryTime: sig.entryTime, engine: sig.engine, pair: sig.pair };
  });

  const totalInPeriod = signals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
interface ResultRow {
  label: string; desc: string;
  n: number; wr: number; total: number; perDay: number;
  pf: number; sharpe: number; maxDD: number;
  blocked: number;
  oosTotal: number; oosPerDay: number; oosPF: number;
  byEng: Record<string, { n: number; pnl: number }>;
}

function calcStats(
  fullTrades: Trade[],
  oosTrades:  Trade[],
  days:    number,
  oosDays: number,
  label:   string,
  desc:    string,
  blocked: number,
): ResultRow {
  const wins   = fullTrades.filter(t => t.pnl > 0);
  const losses = fullTrades.filter(t => t.pnl <= 0);
  const gp     = wins.reduce((s, t) => s + t.pnl, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total  = fullTrades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of [...fullTrades].sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of fullTrades) { const d = Math.floor(t.exitTime / D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets   = [...dayPnl.values()];
  const mean   = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std    = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r-mean)**2, 0) / (rets.length-1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const oosTotal = oosTrades.reduce((s, t) => s + t.pnl, 0);
  const oosWins  = oosTrades.filter(t => t.pnl > 0);
  const oosLoss  = Math.abs(oosTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const oosPF    = oosLoss > 0 ? oosWins.reduce((s, t) => s + t.pnl, 0) / oosLoss : 99;

  const byEng: Record<string, { n: number; pnl: number }> = {};
  for (const t of fullTrades) {
    if (!byEng[t.engine]) byEng[t.engine] = { n: 0, pnl: 0 };
    byEng[t.engine].n++; byEng[t.engine].pnl += t.pnl;
  }

  return {
    label, desc, n: fullTrades.length, wr: fullTrades.length > 0 ? wins.length/fullTrades.length*100 : 0,
    total, perDay: total/days, pf: gl > 0 ? gp/gl : 99, sharpe, maxDD, blocked,
    oosTotal, oosPerDay: oosTotal/oosDays, oosPF, byEng,
  };
}

// ---------------------------------------------------------------------------
// Generate signals once
// ---------------------------------------------------------------------------
console.log("Generating signals...");
const donchSigs = genDonchian();
const stSigs    = genSupertrend();
const garchSigs = genGarchV2();
const momSigs   = genMomentumConfirm();
const allSigs   = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];

console.log(`  A (Donchian):   ${donchSigs.length}`);
console.log(`  B (Supertrend): ${stSigs.length}`);
console.log(`  C (GARCH v2):   ${garchSigs.length}`);
console.log(`  D (Momentum):   ${momSigs.length}`);
console.log(`  Total:          ${allSigs.length}\n`);

const days    = (FULL_END  - FULL_START) / D;
const oosDays = (FULL_END  - OOS_START)  / D;

// ---------------------------------------------------------------------------
// Sizing configs
// ---------------------------------------------------------------------------
interface SizingConfig { label: string; desc: string; sA: number; sB: number; sC: number; sD: number; }

const sizingConfigs: SizingConfig[] = [
  { label: "Baseline",    desc: "A=$7 B=$5 C=$3 D=$3 (~$18)",  sA: 7, sB: 5, sC: 3, sD: 3 },
  { label: "Kelly",       desc: "A=$2 B=$3 C=$9 D=$4 (~$18)",  sA: 2, sB: 3, sC: 9, sD: 4 },
  { label: "Half-Kelly",  desc: "A=$3 B=$4 C=$6 D=$3 (~$16)",  sA: 3, sB: 4, sC: 6, sD: 3 },
  { label: "GARCH-heavy", desc: "A=$5 B=$5 C=$7 D=$3 (~$20)",  sA: 5, sB: 5, sC: 7, sD: 3 },
];

const results: ResultRow[] = [];

for (const cfg of sizingConfigs) {
  process.stdout.write(`Running ${cfg.label} (${cfg.desc})... `);

  const sizeFor = (engine: string): number => {
    if (engine === "A") return cfg.sA;
    if (engine === "B") return cfg.sB;
    if (engine === "C") return cfg.sC;
    return cfg.sD;
  };

  const full = runEnsemble(allSigs, sizeFor, FULL_START, FULL_END);
  const oos  = runEnsemble(allSigs, sizeFor, OOS_START,  FULL_END);

  const oosTotal = oos.trades.reduce((s, t) => s + t.pnl, 0);
  const r = calcStats(full.trades, oos.trades, days, oosDays, cfg.label, cfg.desc, full.blocked);
  results.push(r);

  console.log(`$${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  PF ${r.pf.toFixed(2)}  Sharpe ${r.sharpe.toFixed(2)}  OOS $${(oosTotal/oosDays).toFixed(2)}/day`);
}

// ---------------------------------------------------------------------------
// Print table
// ---------------------------------------------------------------------------
const W = 165;
console.log("\n" + "=".repeat(W));
console.log("KELLY SIZING TEST – FULL ENSEMBLE (4 engines, 23 pairs, max 20 pool, 1m precision, no trailing)");
console.log("Each config runs its OWN pool. Full: 2023-01 – 2026-03 | OOS: 2025-09+");
console.log("=".repeat(W));

console.log(
  `\n${"Config".padEnd(13)} ${"Desc".padEnd(30)} ${"N".padStart(6)} ${"WR%".padStart(7)} ${"Total".padStart(11)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"Blk".padStart(5)} ${"OOS$/d".padStart(8)} ${"OOSPF".padStart(7)}`
);
console.log("-".repeat(W));

for (const r of results) {
  console.log(
    `${r.label.padEnd(13)} ${r.desc.padEnd(30)} ${String(r.n).padStart(6)} ${r.wr.toFixed(1).padStart(6)}% ${("$"+r.total.toFixed(0)).padStart(11)} ${("$"+r.perDay.toFixed(2)).padStart(10)} ${r.pf.toFixed(2).padStart(7)} ${r.sharpe.toFixed(2).padStart(8)} ${("$"+r.maxDD.toFixed(0)).padStart(10)} ${String(r.blocked).padStart(5)} ${("$"+r.oosPerDay.toFixed(2)).padStart(8)} ${r.oosPF.toFixed(2).padStart(7)}`
  );
}

console.log("\n" + "=".repeat(W));
console.log("ENGINE BREAKDOWN (full period):");
console.log("-".repeat(W));
for (const r of results) {
  const parts = ["A","B","C","D"].map(e => {
    const d = r.byEng[e]; if (!d) return `${e}: n/a     `;
    return `${e}(${String(d.n).padStart(4)} $${d.pnl.toFixed(0).padStart(7)})`;
  });
  console.log(`${r.label.padEnd(13)}  ${parts.join("   ")}`);
}

console.log("\n" + "=".repeat(W));

const best       = results.reduce((a, b) => b.perDay    > a.perDay    ? b : a);
const bestOOS    = results.reduce((a, b) => b.oosPerDay > a.oosPerDay ? b : a);
const lowestDD   = results.reduce((a, b) => b.maxDD     < a.maxDD     ? b : a);
const bestSharpe = results.reduce((a, b) => b.sharpe    > a.sharpe    ? b : a);

console.log(`\nBest $/day:     ${best.label.padEnd(14)} $${best.perDay.toFixed(2)}/day`);
console.log(`Best OOS $/day: ${bestOOS.label.padEnd(14)} $${bestOOS.oosPerDay.toFixed(2)}/day`);
console.log(`Lowest MaxDD:   ${lowestDD.label.padEnd(14)} $${lowestDD.maxDD.toFixed(0)}`);
console.log(`Best Sharpe:    ${bestSharpe.label.padEnd(14)} ${bestSharpe.sharpe.toFixed(2)}`);

console.log("\nDone.");
