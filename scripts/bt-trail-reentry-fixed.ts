/**
 * Trail + Re-entry Backtest (FIXED ENGINE LOGIC)
 * All engine logic ported from bt-trail-full-ensemble.ts (6 bugs fixed).
 * Adds re-entry: when trail fires, if signal still active on next engine check,
 * re-enter with fresh SL, paying full spread + fees.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-reentry-fixed.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

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
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Proper half-spreads from live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// All 23 pairs with 5m data (verified against /tmp/bt-pair-cache-1m)
const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET"
];

// Engine check intervals for re-entry timing
const ENGINE_INTERVALS: Record<string, number> = {
  A: D,   // Donchian: next calendar day
  B: H4,  // Supertrend: next 4h bar
  C: H,   // GARCH v2: next 1h bar
  D: H4,  // Momentum Confirm: next 4h bar
};

// Engine margin sizes (Kelly sizing)
const ENGINE_MARGIN: Record<string, number> = {
  A: 2,  // Donchian SMA(20/50) $2
  B: 3,  // Supertrend(14,1.75) $3
  C: 9,  // GARCH v2 $9 (7% TP, 3% SL, 96h hold)
  D: 3,  // Momentum Confirm $3
};

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
    result.push({ t: ts, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c });
  }
  return result.sort((a, b) => a.t - b.t);
}

// FIX: SMA of last N TRs (not Wilder's smoothing) to match live indicators.ts
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
    if (!init) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j]; ema[i] = s / period; init = true; }
    else { ema[i] = values[i] * k + ema[i-1] * (1 - k); }
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

// FIX: Use i-volWin to i (21 returns) to match live garch-v2-engine.ts
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
function calcPnl(dir: "long"|"short", ep: number, xp: number, not: number): number {
  return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2;
}

// Load data
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); }
}
console.log(`  1m data: ${raw1m.size} pairs`);

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC daily EMA filter
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
// FIX: strict < excludes incomplete current daily bar (matches live slice(0,-1))
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

// BTC 1h EMA(9/21) trend for GARCH filter
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

console.log("Loaded.\n");

// Signal type - stores raw engine signal (before position-pool filtering)
interface Signal {
  pair: string;
  dir: "long"|"short";
  engine: string;
  size: number;        // margin $
  entryTime: number;
  entryPrice: number;  // raw price (no spread applied yet)
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  // For re-entry: the bar index and data needed to re-check signal
  signalBarTs: number; // timestamp of the bar that generated the signal
}

// ─── Engine A: Donchian SMA(20/50) ────────────────────────────────────────────
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
          if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "ch"; } }
          else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } }
        }
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END) {
            sigs.push({ pair, dir: pos.dir, engine: "A", size: ENGINE_MARGIN.A, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason, signalBarTs: pos.signalBarTs });
          }
          pos = null;
        }
      }
      if (!pos) {
        // FIX: Use completed bars only — i-1 and i-2 (not i and i-1)
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, signalBarTs: cs[p].t };
      }
    }
  }
  return sigs;
}

// ─── Engine B: Supertrend(14, 1.75) ───────────────────────────────────────────
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
            sigs.push({ pair, dir: pos.dir, engine: "B", size: ENGINE_MARGIN.B, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason, signalBarTs: pos.signalBarTs });
          }
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, signalBarTs: cs[i-1].t };
      }
    }
  }
  return sigs;
}

// ─── Engine C: GARCH v2 (7% TP, 3% SL, 96h hold) ─────────────────────────────
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
            sigs.push({ pair, dir: pos.dir, engine: "C", size: ENGINE_MARGIN.C, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason, signalBarTs: pos.signalBarTs });
          }
          pos = null;
        }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1; if (prev < 23) continue;
        const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) continue;
        const goLong = z1 > 4.5; const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= 3.0) continue;
        if (goShort && z4 >= -3.0) continue;
        const off9 = h1.length - ema9.length;
        const off21 = h1.length - ema21.length;
        const i9 = prev - off9; const i21 = prev - off21;
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
        pos = { dir, ep: bar.o, et: bar.t, sl, signalBarTs: h1[prev].t };
      }
    }
  }
  return sigs;
}

// ─── Engine D: Momentum Confirm (volume z + funding proxy z + price z on 4h) ──
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
            sigs.push({ pair, dir: pos.dir, engine: "D", size: ENGINE_MARGIN.D, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason, signalBarTs: pos.signalBarTs });
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
        pos = { dir, ep: bar.o, et: bar.t, sl, signalBarTs: cs[prev].t };
      }
    }
  }
  return sigs;
}

// ─── Re-entry signal check ────────────────────────────────────────────────────
// Returns the first re-entry opportunity AFTER minEntryTime for a given original signal.
// "Still active" means the same condition that generated the original signal is still true.
// Re-entry enters at the open of the first bar >= minEntryTime.

interface ReEntryResult {
  found: boolean;
  entryTime: number;
  entryPrice: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
}

function findReEntry(origSig: Signal, minEntryTime: number): ReEntryResult {
  const { pair, dir, engine } = origSig;
  const interval = ENGINE_INTERVALS[engine];

  // Align minEntryTime to next bar boundary
  const nextBarTs = Math.ceil(minEntryTime / interval) * interval;

  if (engine === "A") {
    // Donchian: check if SMA(20) still > SMA(50) for longs (or < for shorts)
    const cs = dailyData.get(pair); if (!cs) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, 20);
    const slow = calcSMA(closes, 50);
    const atr = calcATR(cs, 14);
    // Find bar at or after nextBarTs
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < nextBarTs) continue;
      if (bar.t >= FULL_END) break;
      // Check signal still active using bar i-1 completed
      const p = i - 1;
      if (fast[p] === 0 || slow[p] === 0) continue;
      const stillActive = dir === "long" ? fast[p] > slow[p] : fast[p] < slow[p];
      if (!stillActive) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (dir === "long" && !btcDailyBullish(bar.t)) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
      let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
      if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
      else sl = Math.min(sl, bar.o * 1.035);
      // Find exit
      const exitSig = findEngineAExit(cs, i, dir, sl, bar.o, bar.t);
      return { found: true, entryTime: bar.t, entryPrice: bar.o, sl, exitTime: exitSig.exitTime, exitPrice: exitSig.exitPrice, exitReason: exitSig.exitReason };
    }
    return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
  }

  if (engine === "B") {
    const cs = h4Data.get(pair); if (!cs) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75);
    const atr = calcATR(cs, 14);
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < nextBarTs) continue;
      if (bar.t >= FULL_END) break;
      // Signal still active = supertrend still in same direction (no flip since original)
      const curDir: "long"|"short" = stDir[i] === 1 ? "long" : "short";
      if (curDir !== dir) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (dir === "long" && !btcDailyBullish(bar.t)) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
      let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
      if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
      else sl = Math.min(sl, bar.o * 1.035);
      const exitSig = findEngineBExit(cs, stDir, i, dir, sl, bar.o, bar.t);
      return { found: true, entryTime: bar.t, entryPrice: bar.o, sl, exitTime: exitSig.exitTime, exitPrice: exitSig.exitPrice, exitReason: exitSig.exitReason };
    }
    return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
  }

  if (engine === "C") {
    const h1 = h1Data.get(pair); const h4 = h4Data.get(pair);
    if (!h1 || !h4) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
    const z1h = computeZScores(h1, 3, 20);
    const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c);
    const ema9 = calcEMA(h1Closes, 9);
    const ema21 = calcEMA(h1Closes, 21);
    const h4TsMap = new Map<number, number>();
    h4.forEach((c, ii) => h4TsMap.set(c.t, ii));
    for (let i = 24; i < h1.length; i++) {
      const bar = h1[i];
      if (bar.t < nextBarTs) continue;
      if (bar.t >= FULL_END) break;
      const prev = i - 1; if (prev < 23) continue;
      const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) continue;
      const goLong = dir === "long" && z1 > 4.5;
      const goShort = dir === "short" && z1 < -3.0;
      if (!goLong && !goShort) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const ts4h = Math.floor(h1[prev].t / H4) * H4;
      const idx4h = h4TsMap.get(ts4h);
      if (idx4h === undefined || idx4h < 23) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const z4 = z4h[idx4h];
      if (goLong && z4 <= 3.0) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (goShort && z4 >= -3.0) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const off9 = h1.length - ema9.length; const off21 = h1.length - ema21.length;
      const i9 = prev - off9; const i21 = prev - off21;
      if (i9 < 0 || i21 < 0) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (goLong && ema9[i9] <= ema21[i21]) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (goShort && ema9[i9] >= ema21[i21]) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      const btcT = btcH1Trend(h1[prev].t);
      if (goLong && btcT !== "long") return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      if (goShort && btcT !== "short") return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
      if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
      else sl = Math.min(sl, bar.o * 1.035);
      const exitSig = findEngineCExit(h1, i, dir, sl, bar.o, bar.t);
      return { found: true, entryTime: bar.t, entryPrice: bar.o, sl, exitTime: exitSig.exitTime, exitPrice: exitSig.exitPrice, exitReason: exitSig.exitReason };
    }
    return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
  }

  if (engine === "D") {
    const cs = h4Data.get(pair); if (!cs) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
    for (let i = 52; i < cs.length; i++) {
      const bar = cs[i];
      if (bar.t < nextBarTs) continue;
      if (bar.t >= FULL_END) break;
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
      let curDir: "long"|"short"|null = null;
      if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcDailyBullish(bar.t)) curDir = "long"; }
      else if (volZ > 2 && fundZ < -2 && priceZ < -1) { curDir = "short"; }
      if (curDir !== dir) return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
      let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
      if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
      else sl = Math.min(sl, bar.o * 1.035);
      const exitSig = findEngineDExit(cs, i, dir, sl, bar.o, bar.t);
      return { found: true, entryTime: bar.t, entryPrice: bar.o, sl, exitTime: exitSig.exitTime, exitPrice: exitSig.exitPrice, exitReason: exitSig.exitReason };
    }
    return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
  }

  return { found: false, entryTime: 0, entryPrice: 0, sl: 0, exitTime: 0, exitPrice: 0, exitReason: "" };
}

// Engine exit finders (simulate forward from re-entry bar)
function findEngineAExit(cs: C[], startI: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    const hd = Math.round((bar.t - et) / D);
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (i >= startI + 1 && i >= 16) {
      if (dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
      else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
    }
    if (hd >= 60) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

function findEngineBExit(cs: C[], stDir: number[], startI: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (stDir[i] !== stDir[i - 1]) return { exitTime: bar.t, exitPrice: bar.o, exitReason: "flip" };
    if ((bar.t - et) / H >= 60 * 24) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

function findEngineCExit(h1: C[], startI: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  const tp = dir === "long" ? ep * 1.07 : ep * 0.93;
  for (let i = startI + 1; i < h1.length; i++) {
    const bar = h1[i];
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "long" && bar.h >= tp) return { exitTime: bar.t, exitPrice: tp, exitReason: "tp" };
    if (dir === "short" && bar.l <= tp) return { exitTime: bar.t, exitPrice: tp, exitReason: "tp" };
    if ((bar.t - et) / H >= 96) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = h1[h1.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

function findEngineDExit(cs: C[], startI: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if ((bar.t - et) / H >= 48) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

// ─── 1m trail simulation ──────────────────────────────────────────────────────
function simTrade(
  sig: Signal,
  act: number,
  dist: number,
  allowReEntry: boolean
): {
  pnl: number;
  reason: string;
  exitTime: number;
  peakPct: number;
  reEntryPnl: number;   // P&L from re-entry (0 if none)
  reEntryCount: number; // number of re-entries (0 or 1)
} {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  // No 1m data: use engine-level exit directly
  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: 0, reEntryPnl: 0, reEntryCount: 0 };
  }

  // Binary search for start index
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakPnlPct = 0;
  let trailFiredAt: number | null = null;
  let trailExitPnl = 0;
  let trailExitTime = 0;

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    // SL check
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
    }

    // GARCH v2 TP check (7%)
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
      }
    }

    // Peak tracking
    const bestPct = sig.dir === "long"
      ? (b.h / sig.entryPrice - 1) * LEV * 100
      : (sig.entryPrice / b.l - 1) * LEV * 100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    // Trail check
    if (act > 0 && peakPnlPct >= act) {
      const currPct = sig.dir === "long"
        ? (b.c / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.c - 1) * LEV * 100;
      if (currPct <= peakPnlPct - dist) {
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        trailExitPnl = calcPnl(sig.dir, ep, xp, NOT);
        trailFiredAt = b.t;
        trailExitTime = b.t;
        break;
      }
    }
  }

  // Trail fired — attempt re-entry
  if (trailFiredAt !== null) {
    if (allowReEntry) {
      const reEntry = findReEntry(sig, trailFiredAt);
      if (reEntry.found && reEntry.entryTime < FULL_END) {
        // Simulate re-entry trade with 1m precision (no trail on re-entry, simple exit)
        const reNOT = sig.size * LEV;
        const reEp = entryPx(sig.pair, sig.dir, reEntry.entryPrice);
        const reSig: Signal = {
          ...sig,
          entryTime: reEntry.entryTime,
          entryPrice: reEntry.entryPrice,
          sl: reEntry.sl,
          exitTime: reEntry.exitTime,
          exitPrice: reEntry.exitPrice,
          exitReason: reEntry.exitReason,
        };
        // Simulate re-entry with no trail (just engine exit)
        const reResult = simTrade(reSig, 0, 0, false);
        return {
          pnl: trailExitPnl,
          reason: "trail",
          exitTime: trailExitTime,
          peakPct: peakPnlPct,
          reEntryPnl: reResult.pnl,
          reEntryCount: 1,
        };
      }
    }
    return { pnl: trailExitPnl, reason: "trail", exitTime: trailExitTime, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
  }

  // Engine exit
  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: peakPnlPct, reEntryPnl: 0, reEntryCount: 0 };
}

// ─── Position-pool fair comparison ────────────────────────────────────────────
// Build no-trail accepted set ONCE, then apply different trail configs to same trades.
// Re-entry trades bypass position pool (they are logical continuations of accepted trades).

const noTrailAcceptedCache = new Map<string, Signal[]>();

function buildNoTrailAccepted(allSignals: Signal[], startTs: number, endTs: number): Signal[] {
  const key = `${startTs}-${endTs}`;
  if (noTrailAcceptedCache.has(key)) return noTrailAcceptedCache.get(key)!;

  // Simulate all signals with no trail to get actual exit times
  const processed = allSignals.map(sig => {
    const result = simTrade(sig, 0, 0, false);
    return { ...sig, adjExitTime: result.exitTime };
  });

  interface Event { t: number; type: "entry"|"exit"; idx: number; engine: string; pair: string }
  const events: Event[] = [];
  for (let idx = 0; idx < processed.length; idx++) {
    const s = processed[idx];
    if (s.entryTime < startTs || s.entryTime >= endTs) continue;
    events.push({ t: s.entryTime, type: "entry", idx, engine: s.engine, pair: s.pair });
    events.push({ t: s.adjExitTime, type: "exit", idx, engine: s.engine, pair: s.pair });
  }
  events.sort((a, b) => a.t - b.t || (a.type === "exit" ? -1 : 1));

  const openPos = new Map<string, number>();
  const accepted: Signal[] = [];
  for (const evt of events) {
    const k = `${evt.engine}:${evt.pair}`;
    if (evt.type === "exit") { openPos.delete(k); }
    else {
      if (openPos.has(k)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(k, evt.idx);
      accepted.push(allSignals[evt.idx]);
    }
  }
  noTrailAcceptedCache.set(key, accepted);
  return accepted;
}

// Trade record including optional re-entry
interface TradeRecord {
  pnl: number;
  totalPnl: number; // pnl + reEntryPnl
  reason: string;
  exitTime: number;
  entryTime: number;
  engine: string;
  pair: string;
  reEntryPnl: number;
  reEntryCount: number;
}

function runEnsemble(
  allSignals: Signal[],
  act: number,
  dist: number,
  allowReEntry: boolean,
  startTs: number,
  endTs: number
): { trades: TradeRecord[]; blocked: number } {
  const accepted = buildNoTrailAccepted(allSignals, startTs, endTs);

  const trades: TradeRecord[] = accepted.map(sig => {
    const result = simTrade(sig, act, dist, allowReEntry);
    return {
      pnl: result.pnl,
      totalPnl: result.pnl + result.reEntryPnl,
      reason: result.reason,
      exitTime: result.exitTime,
      entryTime: sig.entryTime,
      engine: sig.engine,
      pair: sig.pair,
      reEntryPnl: result.reEntryPnl,
      reEntryCount: result.reEntryCount,
    };
  });

  const totalInPeriod = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length };
}

// ─── Generate all signals ─────────────────────────────────────────────────────
console.log("Generating signals from all engines...");
const donchSigs = genDonchian();
const stSigs = genSupertrend();
const garchSigs = genGarchV2();
const momSigs = genMomentumConfirm();
const allSigs = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];
console.log(`  A (Donchian): ${donchSigs.length}`);
console.log(`  B (Supertrend): ${stSigs.length}`);
console.log(`  C (GARCH v2): ${garchSigs.length}`);
console.log(`  D (Momentum): ${momSigs.length}`);
console.log(`  Total: ${allSigs.length} signals\n`);

// ─── Test configs ─────────────────────────────────────────────────────────────
interface ConfigSpec {
  label: string;
  act: number;
  dist: number;
  reEntry: boolean;
}

const CONFIGS: ConfigSpec[] = [
  { label: "Baseline (no trail)",           act: 0,  dist: 0,  reEntry: false },
  { label: "Trail 30/7 + re-entry",         act: 30, dist: 7,  reEntry: true  },
  { label: "Trail 40/10 + re-entry",        act: 40, dist: 10, reEntry: true  },
  { label: "Trail 20/5 + re-entry",         act: 20, dist: 5,  reEntry: true  },
  { label: "Trail 30/7 no re-entry",        act: 30, dist: 7,  reEntry: false },
];

interface Result {
  label: string;
  trades: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  blocked: number;
  trailExits: number;
  reEntries: number;
  avgReEntryPnl: number;
  oosTotal: number;
  oosPerDay: number;
  oosPf: number;
}

const results: Result[] = [];
const days = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log("Running configs...\n");

for (const cfg of CONFIGS) {
  process.stdout.write(`  ${cfg.label}...`);

  const full = runEnsemble(allSigs, cfg.act, cfg.dist, cfg.reEntry, FULL_START, FULL_END);
  const oos  = runEnsemble(allSigs, cfg.act, cfg.dist, cfg.reEntry, OOS_START,  FULL_END);

  const trades = full.trades;
  const wins   = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const gp     = wins.reduce((s, t) => s + t.totalPnl, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.totalPnl, 0));
  const total  = trades.reduce((s, t) => s + t.totalPnl, 0);

  // MaxDD on cumulative totalPnl sorted by exit time
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.totalPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Daily Sharpe (on totalPnl)
  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.totalPnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // OOS
  const oosT   = oos.trades;
  const oosWins = oosT.filter(t => t.totalPnl > 0);
  const oosLoss = oosT.filter(t => t.totalPnl <= 0);
  const oosTotal = oosT.reduce((s, t) => s + t.totalPnl, 0);
  const oosGP = oosWins.reduce((s, t) => s + t.totalPnl, 0);
  const oosGL = Math.abs(oosLoss.reduce((s, t) => s + t.totalPnl, 0));

  const trailExits = trades.filter(t => t.reason === "trail").length;
  const reEntries  = trades.reduce((s, t) => s + t.reEntryCount, 0);
  const reEntryTrades = trades.filter(t => t.reEntryCount > 0);
  const avgReEntryPnl = reEntryTrades.length > 0
    ? reEntryTrades.reduce((s, t) => s + t.reEntryPnl, 0) / reEntryTrades.length
    : 0;

  results.push({
    label: cfg.label,
    trades: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total, perDay: total / days,
    maxDD, sharpe,
    blocked: full.blocked,
    trailExits,
    reEntries, avgReEntryPnl,
    oosTotal, oosPerDay: oosTotal / oosDays,
    oosPf: oosGL > 0 ? oosGP / oosGL : 99,
  });

  console.log(` done. $${(total / days).toFixed(2)}/day, DD $${maxDD.toFixed(0)}, re-entries: ${reEntries}`);
}

// ─── Output ───────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(160));
console.log("TRAIL + RE-ENTRY BACKTEST | All bugs fixed from bt-trail-full-ensemble.ts");
console.log("Engines: Donchian $2 + Supertrend $3 + GARCH v2 $9 + Momentum $3 | 23 pairs | 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("Position pool: max 20 | 1m bars for trail precision | Re-entry waits for next engine bar, checks signal still active");
console.log("=".repeat(160));

const W = {
  label: 28,
  trades: 7, wr: 7, total: 12, perDay: 10, pf: 7, sharpe: 8, maxDD: 10,
  trails: 7, reEnt: 8, avgRe: 10, oosDay: 10, oosPf: 8,
};

const header =
  "Config".padEnd(W.label) +
  "Trades".padStart(W.trades) +
  "WR%".padStart(W.wr) +
  "Total".padStart(W.total) +
  "$/day".padStart(W.perDay) +
  "PF".padStart(W.pf) +
  "Sharpe".padStart(W.sharpe) +
  "MaxDD".padStart(W.maxDD) +
  "Trails".padStart(W.trails) +
  "ReEnts".padStart(W.reEnt) +
  "AvgRePnl".padStart(W.avgRe) +
  "OOS$/day".padStart(W.oosDay) +
  "OOS PF".padStart(W.oosPf);
console.log("\n" + header);
console.log("-".repeat(160));

for (const r of results) {
  const mark = r.label.startsWith("Baseline") ? " <<<" : "";
  console.log(
    r.label.padEnd(W.label) +
    String(r.trades).padStart(W.trades) +
    (r.wr.toFixed(1) + "%").padStart(W.wr) +
    ("$" + r.total.toFixed(0)).padStart(W.total) +
    ("$" + r.perDay.toFixed(2)).padStart(W.perDay) +
    r.pf.toFixed(2).padStart(W.pf) +
    r.sharpe.toFixed(2).padStart(W.sharpe) +
    ("$" + r.maxDD.toFixed(0)).padStart(W.maxDD) +
    String(r.trailExits).padStart(W.trails) +
    String(r.reEntries).padStart(W.reEnt) +
    ("$" + r.avgReEntryPnl.toFixed(2)).padStart(W.avgRe) +
    ("$" + r.oosPerDay.toFixed(2)).padStart(W.oosDay) +
    r.oosPf.toFixed(2).padStart(W.oosPf) +
    mark
  );
}

console.log("\n" + "=".repeat(160));
const baseline = results.find(r => r.label.startsWith("Baseline"))!;
const trailWithRE = results.filter(r => r.reEntries > 0);
const trailNoRE = results.find(r => r.label.includes("no re-entry"));

console.log(`\nBaseline:           $${baseline.perDay.toFixed(2)}/day  MaxDD $${baseline.maxDD.toFixed(0)}  Sharpe ${baseline.sharpe.toFixed(2)}  OOS $${baseline.oosPerDay.toFixed(2)}/day`);
if (trailNoRE) {
  console.log(`Trail 30/7 no RE:   $${trailNoRE.perDay.toFixed(2)}/day  MaxDD $${trailNoRE.maxDD.toFixed(0)}  Sharpe ${trailNoRE.sharpe.toFixed(2)}  OOS $${trailNoRE.oosPerDay.toFixed(2)}/day  (trail cost: ${(baseline.perDay - trailNoRE.perDay).toFixed(2)}/day)`);
}
for (const r of trailWithRE) {
  const reRecovery = r.perDay - (trailNoRE?.perDay ?? 0);
  console.log(`${r.label.padEnd(30)}: $${r.perDay.toFixed(2)}/day  MaxDD $${r.maxDD.toFixed(0)}  Sharpe ${r.sharpe.toFixed(2)}  OOS $${r.oosPerDay.toFixed(2)}/day  re-entry recovery: $${reRecovery.toFixed(2)}/day`);
}

console.log("\nDone.");
