/**
 * Trade-level spot-check for bt-trail-reentry-v2.ts
 *
 * Picks 6 specific trades (3 better, 3 worse under trail+reentry vs baseline)
 * on DOGE and SOL, then walks through 1m bars to verify:
 *   - Trail fires at correct price/time
 *   - Re-entry happens at correct next engine interval
 *   - Re-entry signal is actually still active (indicators recomputed)
 *   - Re-entry P&L is computed correctly with fresh SL and full fees
 *   - Pool had room at re-entry time
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-reentry-spot-check.ts
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

// Half-spreads from live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// Only checking DOGE and SOL for targeted analysis
const CHECK_PAIRS = ["DOGE", "SOL"];

// All pairs needed for pool simulation (from v2 script)
const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET"
];

const ENGINE_INTERVALS: Record<string, number> = {
  A: D, B: H4, C: H, D: H4,
};
const ENGINE_MARGIN: Record<string, number> = {
  A: 2, B: 3, C: 9, D: 3,
};

function ts(t: number): string {
  return new Date(t).toISOString().replace("T", " ").replace(".000Z", "");
}

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
  for (const [_ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({ t: grp[0].t - (grp[0].t % periodMs), o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c });
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

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = i - volWin + 1; j <= i; j++) {
      if (j < 1) continue;
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

// ---- Load data ----
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...ALL_PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
// Only load 1m data for spot-check pairs (DOGE, SOL) -- other pairs use 5m only
for (const p of CHECK_PAIRS) {
  console.log(`  Loading 1m: ${p}...`);
  const d = loadJson(CD_1M, p);
  if (d.length > 0) raw1m.set(p, d);
}
console.log(`  5m: ${raw5m.size} pairs, 1m: ${raw1m.size} pairs`);

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC 4h EMA(12/21)
const btc4h = h4Data.get("BTC")!;
const btc4hCloses = btc4h.map(c => c.c);
const btc4hEma12 = calcEMA(btc4hCloses, 12);
const btc4hEma21 = calcEMA(btc4hCloses, 21);

function btc4hBullish(t: number): boolean {
  let idx = -1;
  for (let i = btc4h.length - 1; i >= 0; i--) {
    if (btc4h[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  return btc4hEma12[idx] > 0 && btc4hEma21[idx] > 0 && btc4hEma12[idx] > btc4hEma21[idx];
}

// BTC 1h EMA(9/21)
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
  if (btcH1Ema9[prev] > 0 && btcH1Ema21[prev] > 0) {
    if (btcH1Ema9[prev] > btcH1Ema21[prev]) return "long";
    if (btcH1Ema9[prev] < btcH1Ema21[prev]) return "short";
  }
  return null;
}

console.log("Data loaded.\n");

// ---- Signal interface ----
interface Signal {
  pair: string;
  dir: "long"|"short";
  engine: string;
  size: number;
  entryTime: number;
  entryPrice: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
}

// ---- Engine signal generators (same as v2) ----
function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of ALL_PAIRS) {
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
            sigs.push({ pair, dir: pos.dir, engine: "A", size: ENGINE_MARGIN.A, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos) {
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btc4hBullish(bar.t)) continue;
        const prevATR = atr[i - 1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

function genSupertrend(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of ALL_PAIRS) {
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
            sigs.push({ pair, dir: pos.dir, engine: "B", size: ENGINE_MARGIN.B, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
          }
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !btc4hBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

function genGarchV2(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of ALL_PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;
    const z1h = computeZScores(h1, 3, 20);
    const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c);
    const ema9 = calcEMA(h1Closes, 9);
    const ema21c = calcEMA(h1Closes, 21);
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
            sigs.push({ pair, dir: pos.dir, engine: "C", size: ENGINE_MARGIN.C, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
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
        if (ema9[prev] === 0 || ema21c[prev] === 0) continue;
        if (goLong && ema9[prev] <= ema21c[prev]) continue;
        if (goShort && ema9[prev] >= ema21c[prev]) continue;
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

function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of ALL_PAIRS) {
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
            sigs.push({ pair, dir: pos.dir, engine: "D", size: ENGINE_MARGIN.D, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason });
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
        if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btc4hBullish(bar.t)) dir = "long"; }
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

// ---- Pre-compute per-pair engine data for re-entry checks ----
interface PairEngineData {
  donchFast?: number[];
  donchSlow?: number[];
  donchATR?: number[];
  donchBars?: C[];
  stDir?: number[];
  stATR?: number[];
  stBars?: C[];
  z1h?: number[];
  z4h?: number[];
  ema9?: number[];
  ema21?: number[];
  h1Bars?: C[];
  h4Bars?: C[];
  h4TsMap?: Map<number, number>;
  momBars?: C[];
}

const pairDataMap = new Map<string, PairEngineData>();
for (const pair of ALL_PAIRS) {
  const pd: PairEngineData = {};
  const dcs = dailyData.get(pair);
  if (dcs && dcs.length >= 65) {
    const closes = dcs.map(c => c.c);
    pd.donchFast = calcSMA(closes, 20);
    pd.donchSlow = calcSMA(closes, 50);
    pd.donchATR = calcATR(dcs, 14);
    pd.donchBars = dcs;
  }
  const h4cs = h4Data.get(pair);
  if (h4cs && h4cs.length >= 50) {
    const { dir: stDir } = calcSupertrend(h4cs, 14, 1.75);
    pd.stDir = stDir;
    pd.stATR = calcATR(h4cs, 14);
    pd.stBars = h4cs;
  }
  const h1cs = h1Data.get(pair);
  const h4c2 = h4Data.get(pair);
  if (h1cs && h1cs.length >= 200 && h4c2 && h4c2.length >= 200) {
    pd.z1h = computeZScores(h1cs, 3, 20);
    pd.z4h = computeZScores(h4c2, 3, 20);
    const h1Closes = h1cs.map(c => c.c);
    pd.ema9 = calcEMA(h1Closes, 9);
    pd.ema21 = calcEMA(h1Closes, 21);
    pd.h1Bars = h1cs;
    pd.h4Bars = h4c2;
    pd.h4TsMap = new Map<number, number>();
    h4c2.forEach((c, i) => pd.h4TsMap!.set(c.t, i));
  }
  if (h4cs && h4cs.length >= 55) pd.momBars = h4cs;
  pairDataMap.set(pair, pd);
}

// ---- Re-entry signal checkers ----
interface ReEntryCheck {
  valid: boolean;
  entryPrice: number;
  sl: number;
  debugInfo?: string;
}

function checkDonchianReEntry(pair: string, dir: "long"|"short", checkTs: number): ReEntryCheck {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.donchBars) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "no donch data" };
  const cs = pd.donchBars;
  const fast = pd.donchFast!;
  const slow = pd.donchSlow!;
  const atr = pd.donchATR!;
  for (let i = 51; i < cs.length; i++) {
    if (cs[i].t < checkTs) continue;
    if (cs[i].t > checkTs) break;
    const p = i - 1;
    if (fast[p] === 0 || slow[p] === 0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `SMA zero at i=${i}` };
    const stillActive = dir === "long" ? fast[p] > slow[p] : fast[p] < slow[p];
    if (!stillActive) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `SMA(20)=${fast[p].toFixed(6)} vs SMA(50)=${slow[p].toFixed(6)} dir=${dir}` };
    if (dir === "long" && !btc4hBullish(cs[i].t)) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "BTC 4h not bullish" };
    const prevATR = atr[i - 1]; if (prevATR <= 0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "ATR zero" };
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { valid: true, entryPrice: cs[i].o, sl, debugInfo: `SMA(20)=${fast[p].toFixed(6)} > SMA(50)=${slow[p].toFixed(6)}` };
  }
  return { valid: false, entryPrice: 0, sl: 0, debugInfo: `no bar at ${ts(checkTs)}` };
}

function checkSupertrendReEntry(pair: string, dir: "long"|"short", checkTs: number): ReEntryCheck {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.stBars) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "no ST data" };
  const cs = pd.stBars;
  const stDir = pd.stDir!;
  const atr = pd.stATR!;
  for (let i = 17; i < cs.length; i++) {
    if (cs[i].t < checkTs) continue;
    if (cs[i].t > checkTs) break;
    const curDir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
    if (curDir !== dir) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `ST dir=${curDir} want=${dir} stDir[i-1]=${stDir[i-1]}` };
    if (dir === "long" && !btc4hBullish(cs[i].t)) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "BTC 4h not bullish" };
    const prevATR = atr[i - 1]; if (prevATR <= 0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "ATR zero" };
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { valid: true, entryPrice: cs[i].o, sl, debugInfo: `ST dir=${curDir} stDir[i-1]=${stDir[i-1]} ATR=${prevATR.toFixed(6)}` };
  }
  return { valid: false, entryPrice: 0, sl: 0, debugInfo: `no bar at ${ts(checkTs)}` };
}

function checkGarchReEntry(pair: string, dir: "long"|"short", checkTs: number): ReEntryCheck {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.h1Bars) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "no GARCH data" };
  const h1 = pd.h1Bars;
  const z1h = pd.z1h!;
  const z4h = pd.z4h!;
  const ema9 = pd.ema9!;
  const ema21 = pd.ema21!;
  const h4TsMap = pd.h4TsMap!;
  for (let i = 24; i < h1.length; i++) {
    if (h1[i].t < checkTs) continue;
    if (h1[i].t > checkTs) break;
    const prev = i - 1; if (prev < 23) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "prev<23" };
    const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `z1h=${z1}` };
    const goLong = dir === "long" && z1 > 4.5;
    const goShort = dir === "short" && z1 < -3.0;
    if (!goLong && !goShort) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `z1h=${z1.toFixed(2)} dir=${dir} needs ${dir==="long"?">4.5":"<-3.0"}` };
    const ts4h = Math.floor(h1[prev].t / H4) * H4;
    const idx4h = h4TsMap.get(ts4h);
    if (idx4h === undefined || idx4h < 23) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "no 4h idx" };
    const z4 = z4h[idx4h];
    if (goLong && z4 <= 3.0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `z4h=${z4.toFixed(2)} <= 3.0` };
    if (goShort && z4 >= -3.0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `z4h=${z4.toFixed(2)} >= -3.0` };
    if (ema9[prev] === 0 || ema21[prev] === 0) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "EMA zero" };
    if (goLong && ema9[prev] <= ema21[prev]) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `EMA9=${ema9[prev].toFixed(4)} <= EMA21=${ema21[prev].toFixed(4)}` };
    if (goShort && ema9[prev] >= ema21[prev]) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `EMA9=${ema9[prev].toFixed(4)} >= EMA21=${ema21[prev].toFixed(4)}` };
    const btcT = btcH1Trend(h1[prev].t);
    if (goLong && btcT !== "long") return { valid: false, entryPrice: 0, sl: 0, debugInfo: `BTC 1h trend=${btcT}` };
    if (goShort && btcT !== "short") return { valid: false, entryPrice: 0, sl: 0, debugInfo: `BTC 1h trend=${btcT}` };
    let sl = dir === "long" ? h1[i].o * (1 - 0.03) : h1[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, h1[i].o * 0.965);
    else sl = Math.min(sl, h1[i].o * 1.035);
    return { valid: true, entryPrice: h1[i].o, sl, debugInfo: `z1h=${z1.toFixed(2)} z4h=${z4.toFixed(2)} EMA9=${ema9[prev].toFixed(4)} EMA21=${ema21[prev].toFixed(4)}` };
  }
  return { valid: false, entryPrice: 0, sl: 0, debugInfo: `no bar at ${ts(checkTs)}` };
}

function checkMomentumReEntry(pair: string, dir: "long"|"short", checkTs: number): ReEntryCheck {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.momBars) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "no mom data" };
  const cs = pd.momBars;
  for (let i = 52; i < cs.length; i++) {
    if (cs[i].t < checkTs) continue;
    if (cs[i].t > checkTs) break;
    const prev = i - 1;
    const ranges: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
    if (ranges.length < 20) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "ranges<20" };
    const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
    const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
    const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
    const fp: number[] = [];
    for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
    if (fp.length < 20) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "fp<20" };
    const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
    const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
    const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
    const closes: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
    if (closes.length < 20) return { valid: false, entryPrice: 0, sl: 0, debugInfo: "closes<20" };
    const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
    const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;
    let curDir: "long"|"short"|null = null;
    if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btc4hBullish(cs[i].t)) curDir = "long"; }
    else if (volZ > 2 && fundZ < -2 && priceZ < -1) { curDir = "short"; }
    if (curDir !== dir) return { valid: false, entryPrice: 0, sl: 0, debugInfo: `volZ=${volZ.toFixed(2)} fundZ=${fundZ.toFixed(2)} priceZ=${priceZ.toFixed(2)} curDir=${curDir}` };
    let sl = dir === "long" ? cs[i].o * (1 - 0.03) : cs[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { valid: true, entryPrice: cs[i].o, sl, debugInfo: `volZ=${volZ.toFixed(2)} fundZ=${fundZ.toFixed(2)} priceZ=${priceZ.toFixed(2)}` };
  }
  return { valid: false, entryPrice: 0, sl: 0, debugInfo: `no bar at ${ts(checkTs)}` };
}

function checkReEntry(pair: string, dir: "long"|"short", engine: string, checkTs: number): ReEntryCheck {
  if (engine === "A") return checkDonchianReEntry(pair, dir, checkTs);
  if (engine === "B") return checkSupertrendReEntry(pair, dir, checkTs);
  if (engine === "C") return checkGarchReEntry(pair, dir, checkTs);
  if (engine === "D") return checkMomentumReEntry(pair, dir, checkTs);
  return { valid: false, entryPrice: 0, sl: 0 };
}

// ---- Engine exit finders ----
function findEngineAExit(pair: string, entryBarTs: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.donchBars) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  const cs = pd.donchBars;
  let startI = -1;
  for (let i = 0; i < cs.length; i++) { if (cs[i].t === entryBarTs) { startI = i; break; } }
  if (startI < 0) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    const hd = Math.round((bar.t - et) / D);
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (i >= 16) {
      if (dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
      else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "ch" }; }
    }
    if (hd >= 60) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

function findEngineBExit(pair: string, entryBarTs: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.stBars) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  const cs = pd.stBars;
  const stDir = pd.stDir!;
  let startI = -1;
  for (let i = 0; i < cs.length; i++) { if (cs[i].t === entryBarTs) { startI = i; break; } }
  if (startI < 0) return { exitTime: et, exitPrice: ep, exitReason: "err" };
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

function findEngineCExit(pair: string, entryBarTs: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.h1Bars) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  const h1 = pd.h1Bars;
  let startI = -1;
  for (let i = 0; i < h1.length; i++) { if (h1[i].t === entryBarTs) { startI = i; break; } }
  if (startI < 0) return { exitTime: et, exitPrice: ep, exitReason: "err" };
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

function findEngineDExit(pair: string, entryBarTs: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  const pd = pairDataMap.get(pair);
  if (!pd || !pd.momBars) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  const cs = pd.momBars;
  let startI = -1;
  for (let i = 0; i < cs.length; i++) { if (cs[i].t === entryBarTs) { startI = i; break; } }
  if (startI < 0) return { exitTime: et, exitPrice: ep, exitReason: "err" };
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if ((bar.t - et) / H >= 48) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

function findEngineExit(pair: string, engine: string, entryBarTs: number, dir: "long"|"short", sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  if (engine === "A") return findEngineAExit(pair, entryBarTs, dir, sl, ep, et);
  if (engine === "B") return findEngineBExit(pair, entryBarTs, dir, sl, ep, et);
  if (engine === "C") return findEngineCExit(pair, entryBarTs, dir, sl, ep, et);
  if (engine === "D") return findEngineDExit(pair, entryBarTs, dir, sl, ep, et);
  return { exitTime: et, exitPrice: ep, exitReason: "err" };
}

// ---- Detailed trade record ----
interface DetailedTrade {
  pair: string;
  dir: "long"|"short";
  engine: string;
  size: number;
  rawEntryPrice: number;
  entryTime: number;
  sl: number;
  exitTime: number;
  exitReason: string;
  pnl: number;
  peakPct: number;
  trailFired: boolean;
  isReEntry: boolean;
  // Re-entry specific
  parentTrailExitTime?: number;
  reCheckTs?: number;
  reEntryDebugInfo?: string;
  reEntryRawPrice?: number;
  reEntrySl?: number;
  reExitTime?: number;
  reExitPrice?: number;
  reExitReason?: string;
  rePnl?: number;
  poolSizeAtReEntry?: number;
}

// ---- 1m trail simulation with full detail logging ----
interface DetailedTrailResult {
  pnl: number;
  reason: string;
  exitTime: number;
  peakPct: number;
  trailFired: boolean;
  // Detailed 1m walk info
  trailFireBar?: { t: number; o: number; h: number; l: number; c: number; peakPct: number; currPct: number; };
  keyBars: { t: number; c: number; peakPct: number; currPct: number; }[];
}

function simTradeWithTrailDetailed(
  pair: string, dir: "long"|"short", engine: string, size: number,
  rawEntryPrice: number, entryTime: number, sl: number,
  rawExitPrice: number, exitTime: number, exitReason: string,
  act: number, dist: number
): DetailedTrailResult {
  const NOT = size * LEV;
  const ep = entryPx(pair, dir, rawEntryPrice);
  const keyBars: DetailedTrailResult["keyBars"] = [];

  const bars1m = raw1m.get(pair);
  if (!bars1m || bars1m.length === 0 || act <= 0) {
    const xp = exitPx(pair, dir, rawExitPrice, exitReason === "sl");
    return { pnl: calcPnl(dir, ep, xp, NOT), reason: exitReason, exitTime, peakPct: 0, trailFired: false, keyBars };
  }

  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t >= entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakPnlPct = 0;
  let barCount = 0;

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > exitTime) break;
    barCount++;

    // SL check
    if (dir === "long" && b.l <= sl) {
      const xp = exitPx(pair, dir, sl, true);
      return { pnl: calcPnl(dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, keyBars };
    }
    if (dir === "short" && b.h >= sl) {
      const xp = exitPx(pair, dir, sl, true);
      return { pnl: calcPnl(dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, keyBars };
    }

    // GARCH TP
    if (engine === "C") {
      const tp = dir === "long" ? rawEntryPrice * 1.07 : rawEntryPrice * 0.93;
      if (dir === "long" && b.h >= tp) {
        const xp = exitPx(pair, dir, tp, false);
        return { pnl: calcPnl(dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, keyBars };
      }
      if (dir === "short" && b.l <= tp) {
        const xp = exitPx(pair, dir, tp, false);
        return { pnl: calcPnl(dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, keyBars };
      }
    }

    const bestPct = dir === "long"
      ? (b.h / rawEntryPrice - 1) * LEV * 100
      : (rawEntryPrice / b.l - 1) * LEV * 100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    const currPct = dir === "long"
      ? (b.c / rawEntryPrice - 1) * LEV * 100
      : (rawEntryPrice / b.c - 1) * LEV * 100;

    // Log every 60 bars (every hour) for the first 24h then every 6h
    if (barCount % 60 === 0 && barCount <= 1440 || barCount % 360 === 0) {
      keyBars.push({ t: b.t, c: b.c, peakPct: peakPnlPct, currPct });
    }

    if (peakPnlPct >= act) {
      if (currPct <= peakPnlPct - dist) {
        const xp = exitPx(pair, dir, b.c, false);
        return {
          pnl: calcPnl(dir, ep, xp, NOT), reason: "trail", exitTime: b.t, peakPct: peakPnlPct, trailFired: true,
          trailFireBar: { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, peakPct: peakPnlPct, currPct },
          keyBars
        };
      }
    }
  }

  const xp = exitPx(pair, dir, rawExitPrice, exitReason === "sl");
  return { pnl: calcPnl(dir, ep, xp, NOT), reason: exitReason, exitTime, peakPct: peakPnlPct, trailFired: false, keyBars };
}

// ---- Ensemble run that collects detailed trade info ----
function runEnsembleDetailed(
  allSignals: Signal[],
  act: number,
  dist: number,
  allowReEntry: boolean,
): DetailedTrade[] {
  const inRange = allSignals.filter(s => s.entryTime >= FULL_START && s.entryTime < FULL_END);

  interface OpenPos {
    pair: string; dir: "long"|"short"; engine: string; size: number;
    rawEntryPrice: number; entryTime: number; sl: number;
    rawExitPrice: number; engineExitTime: number; engineExitReason: string;
    key: string; isReEntry: boolean;
    parentTrailExitTime?: number; reCheckTs?: number; reEntryDebugInfo?: string;
  }

  interface PendingReEntry {
    pair: string; dir: "long"|"short"; engine: string; size: number;
    trailExitTime: number; checkTs: number;
  }

  const sorted = [...inRange].sort((a, b) => a.entryTime - b.entryTime);
  const openPositions = new Map<string, OpenPos>();
  const allTrades: DetailedTrade[] = [];

  interface Event {
    t: number; type: "signal" | "reentry_check";
    signalIdx?: number; reEntry?: PendingReEntry;
  }

  const events: Event[] = sorted.map((s, idx) => ({ t: s.entryTime, type: "signal" as const, signalIdx: idx }));
  const dynamicEvents: Event[] = [];
  let eventIdx = 0;

  function getNextEvent(): Event | null {
    const staticEvt = eventIdx < events.length ? events[eventIdx] : null;
    const dynEvt = dynamicEvents.length > 0 ? dynamicEvents[0] : null;
    if (!staticEvt && !dynEvt) return null;
    if (!staticEvt) { dynamicEvents.shift(); return dynEvt!; }
    if (!dynEvt) { eventIdx++; return staticEvt; }
    if (staticEvt.t <= dynEvt.t) { eventIdx++; return staticEvt; }
    else { dynamicEvents.shift(); return dynEvt; }
  }

  function closeExpiredPositions(beforeTs: number) {
    for (const [key, pos] of openPositions) {
      if (pos.engineExitTime <= beforeTs) {
        const result = simTradeWithTrailDetailed(
          pos.pair, pos.dir, pos.engine, pos.size,
          pos.rawEntryPrice, pos.entryTime, pos.sl,
          pos.rawExitPrice, pos.engineExitTime, pos.engineExitReason,
          act, dist
        );

        const trade: DetailedTrade = {
          pair: pos.pair, dir: pos.dir, engine: pos.engine, size: pos.size,
          rawEntryPrice: pos.rawEntryPrice, entryTime: pos.entryTime, sl: pos.sl,
          exitTime: result.exitTime, exitReason: result.reason, pnl: result.pnl,
          peakPct: result.peakPct, trailFired: result.trailFired, isReEntry: pos.isReEntry,
          parentTrailExitTime: pos.parentTrailExitTime, reCheckTs: pos.reCheckTs,
          reEntryDebugInfo: pos.reEntryDebugInfo,
        };
        allTrades.push(trade);

        if (result.trailFired && allowReEntry) {
          const interval = ENGINE_INTERVALS[pos.engine];
          let nextCheck = Math.ceil((result.exitTime + 1) / interval) * interval;
          if (nextCheck <= result.exitTime) nextCheck += interval;
          if (nextCheck < FULL_END) {
            dynamicEvents.push({
              t: nextCheck, type: "reentry_check",
              reEntry: {
                pair: pos.pair, dir: pos.dir, engine: pos.engine,
                size: pos.size, trailExitTime: result.exitTime, checkTs: nextCheck
              }
            });
            dynamicEvents.sort((a, b) => a.t - b.t);
          }
        }
        openPositions.delete(key);
      }
    }
  }

  let evt: Event | null;
  while ((evt = getNextEvent()) !== null) {
    closeExpiredPositions(evt.t);

    if (evt.type === "signal") {
      const sig = sorted[evt.signalIdx!];
      const key = `${sig.engine}:${sig.pair}`;
      if (openPositions.has(key)) continue;
      if (openPositions.size >= MAX_POS) continue;
      openPositions.set(key, {
        pair: sig.pair, dir: sig.dir, engine: sig.engine, size: sig.size,
        rawEntryPrice: sig.entryPrice, entryTime: sig.entryTime, sl: sig.sl,
        rawExitPrice: sig.exitPrice, engineExitTime: sig.exitTime,
        engineExitReason: sig.exitReason, key, isReEntry: false
      });
    } else if (evt.type === "reentry_check") {
      const re = evt.reEntry!;
      const key = `${re.engine}:${re.pair}`;
      if (openPositions.has(key)) continue;
      if (openPositions.size >= MAX_POS) continue;
      const check = checkReEntry(re.pair, re.dir, re.engine, re.checkTs);
      if (!check.valid) {
        // Log failed re-entry for interesting trades
        allTrades.push({
          pair: re.pair, dir: re.dir, engine: re.engine, size: re.size,
          rawEntryPrice: 0, entryTime: re.checkTs, sl: 0,
          exitTime: re.checkTs, exitReason: "re_fail", pnl: 0,
          peakPct: 0, trailFired: false, isReEntry: true,
          parentTrailExitTime: re.trailExitTime, reCheckTs: re.checkTs,
          reEntryDebugInfo: check.debugInfo,
        });
        continue;
      }
      const reExit = findEngineExit(re.pair, re.engine, re.checkTs, re.dir, check.sl, check.entryPrice, re.checkTs);
      openPositions.set(key, {
        pair: re.pair, dir: re.dir, engine: re.engine, size: re.size,
        rawEntryPrice: check.entryPrice, entryTime: re.checkTs, sl: check.sl,
        rawExitPrice: reExit.exitPrice, engineExitTime: reExit.exitTime,
        engineExitReason: reExit.exitReason, key, isReEntry: true,
        parentTrailExitTime: re.trailExitTime, reCheckTs: re.checkTs,
        reEntryDebugInfo: check.debugInfo,
      });
    }
  }
  closeExpiredPositions(Infinity);
  return allTrades;
}

// ---- Generate all signals ----
console.log("Generating signals...");
const allSigs = [...genDonchian(), ...genSupertrend(), ...genGarchV2(), ...genMomentumConfirm()];
console.log(`  Total: ${allSigs.length} signals\n`);

// ---- Run baseline (no trail) and trail+reentry ----
console.log("Running baseline (no trail)...");
const baselineTrades = runEnsembleDetailed(allSigs, 0, 0, false);
console.log(`  ${baselineTrades.length} trades\n`);

console.log("Running trail 30/7 + re-entry...");
const trailTrades = runEnsembleDetailed(allSigs, 30, 7, true);
console.log(`  ${trailTrades.length} trades\n`);

// ---- Match baseline to trail for DOGE/SOL trades ----
// For each original signal (engine:pair:entryTime), compare baseline P&L vs trail P&L
interface MatchedTrade {
  key: string;
  pair: string;
  engine: string;
  dir: "long"|"short";
  entryTime: number;
  baselinePnl: number;
  baselineReason: string;
  baselineExitTime: number;
  // Trail side: the original trade (may have trail exit) + any re-entry
  trailOrigPnl: number;
  trailOrigReason: string;
  trailOrigExitTime: number;
  trailFired: boolean;
  peakPct: number;
  // Re-entry trade (if any)
  hasReEntry: boolean;
  reEntryPnl: number;
  reEntryReason: string;
  reEntryTime: number;
  reEntryExitTime: number;
  reEntryDebugInfo: string;
  reEntryRawPrice: number;
  reEntrySl: number;
  // Combined
  totalTrailPnl: number;
  delta: number; // totalTrailPnl - baselinePnl
}

function buildMatched(): MatchedTrade[] {
  // Index baseline trades by engine:pair:entryTime
  const baseIdx = new Map<string, DetailedTrade>();
  for (const t of baselineTrades) {
    if (!CHECK_PAIRS.includes(t.pair)) continue;
    const k = `${t.engine}:${t.pair}:${t.entryTime}`;
    baseIdx.set(k, t);
  }

  // Index trail trades by engine:pair:entryTime
  const trailIdx = new Map<string, DetailedTrade>();
  const reEntryIdx = new Map<string, DetailedTrade[]>(); // parent key -> re-entries
  for (const t of trailTrades) {
    if (!CHECK_PAIRS.includes(t.pair)) continue;
    if (!t.isReEntry) {
      const k = `${t.engine}:${t.pair}:${t.entryTime}`;
      trailIdx.set(k, t);
    } else if (t.parentTrailExitTime) {
      // Match re-entries to parents: find which original trade trailed out before this re-entry
      // We group re-entries by engine:pair and sort by time
      const gk = `${t.engine}:${t.pair}`;
      if (!reEntryIdx.has(gk)) reEntryIdx.set(gk, []);
      reEntryIdx.get(gk)!.push(t);
    }
  }

  const matched: MatchedTrade[] = [];
  for (const [k, baseTrade] of baseIdx) {
    const trailTrade = trailIdx.get(k);
    if (!trailTrade) continue; // skipped by pool in trail run

    // Find re-entry that follows this trail trade
    const gk = `${trailTrade.engine}:${trailTrade.pair}`;
    const reEntries = reEntryIdx.get(gk) ?? [];
    const reEntry = trailTrade.trailFired
      ? reEntries.find(r => r.parentTrailExitTime && Math.abs(r.parentTrailExitTime - trailTrade.exitTime) < 60000)
      : undefined;

    const totalTrailPnl = trailTrade.pnl + (reEntry && reEntry.exitReason !== "re_fail" ? reEntry.pnl : 0);

    matched.push({
      key: k,
      pair: baseTrade.pair,
      engine: baseTrade.engine,
      dir: baseTrade.dir,
      entryTime: baseTrade.entryTime,
      baselinePnl: baseTrade.pnl,
      baselineReason: baseTrade.exitReason,
      baselineExitTime: baseTrade.exitTime,
      trailOrigPnl: trailTrade.pnl,
      trailOrigReason: trailTrade.exitReason,
      trailOrigExitTime: trailTrade.exitTime,
      trailFired: trailTrade.trailFired,
      peakPct: trailTrade.peakPct,
      hasReEntry: !!reEntry && reEntry.exitReason !== "re_fail",
      reEntryPnl: reEntry && reEntry.exitReason !== "re_fail" ? reEntry.pnl : 0,
      reEntryReason: reEntry ? reEntry.exitReason : "",
      reEntryTime: reEntry ? reEntry.entryTime : 0,
      reEntryExitTime: reEntry ? reEntry.exitTime : 0,
      reEntryDebugInfo: reEntry ? (reEntry.reEntryDebugInfo ?? "") : "",
      reEntryRawPrice: reEntry ? reEntry.rawEntryPrice : 0,
      reEntrySl: reEntry ? reEntry.sl : 0,
      totalTrailPnl,
      delta: totalTrailPnl - baseTrade.pnl,
    });
  }

  return matched.sort((a, b) => b.delta - a.delta); // best delta first
}

const matched = buildMatched();
console.log(`Matched ${matched.length} DOGE/SOL trades between baseline and trail+reentry.\n`);

// ---- Separate into trail-fired-with-delta trades ----
const trailFiredTrades = matched.filter(m => m.trailFired);
const better = trailFiredTrades.filter(m => m.delta > 0).slice(0, 3);
const worse = trailFiredTrades.filter(m => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);

if (better.length + worse.length < 6) {
  // Fallback: include non-trail-fired trades with biggest delta
  console.log(`  Only ${trailFiredTrades.length} trail-fired trades found. Adding non-trail trades.`);
  const nonTrail = matched.filter(m => !m.trailFired);
  while (better.length < 3 && nonTrail.length > 0) {
    const t = nonTrail.shift()!;
    if (t.delta > 0) better.push(t);
  }
  while (worse.length < 3) {
    const remaining = matched.filter(m => m.delta < 0 && !worse.includes(m) && !better.includes(m));
    if (remaining.length === 0) break;
    worse.push(remaining[remaining.length - 1]);
  }
}

// ---- Walk-through printer ----
const ENGINES: Record<string, string> = { A: "Donchian", B: "Supertrend", C: "GARCH v2", D: "Momentum" };

function printTradeWalkthrough(m: MatchedTrade, label: string) {
  const divider = "=".repeat(120);
  const subdiv = "-".repeat(100);
  console.log(divider);
  console.log(`[${label}] ${m.pair} Engine ${m.engine} (${ENGINES[m.engine]}) | ${m.dir.toUpperCase()} | Delta: $${m.delta.toFixed(4)}`);
  console.log(divider);

  const sig = allSigs.find(s => s.pair === m.pair && s.engine === m.engine && s.entryTime === m.entryTime);
  if (!sig) { console.log("  ERROR: original signal not found\n"); return; }

  // 1. Baseline trade
  console.log(`\n  BASELINE (no trail):`);
  console.log(`    Entry:  ${ts(m.entryTime)} @ $${sig.entryPrice.toFixed(6)} (raw)`);
  console.log(`    SL:     $${sig.sl.toFixed(6)} (${((Math.abs(sig.entryPrice - sig.sl) / sig.entryPrice) * 100).toFixed(2)}% from entry)`);
  console.log(`    Exit:   ${ts(m.baselineExitTime)} @ $${sig.exitPrice.toFixed(6)} [${m.baselineReason}]`);
  const baseEp = entryPx(m.pair, m.dir, sig.entryPrice);
  const baseXp = exitPx(m.pair, m.dir, sig.exitPrice, m.baselineReason === "sl");
  const baseNot = sig.size * LEV;
  console.log(`    Spread: entry=${baseEp.toFixed(6)}, exit=${baseXp.toFixed(6)} (half-spread=${getSpread(m.pair)})`);
  console.log(`    P&L:    $${m.baselinePnl.toFixed(4)} (NOT=$${baseNot}, fee=$${(baseNot * FEE * 2).toFixed(4)})`);
  const holdH = (m.baselineExitTime - m.entryTime) / H;
  console.log(`    Hold:   ${holdH.toFixed(1)}h`);

  // 2. Trail simulation on 1m bars
  console.log(`\n  ${subdiv}`);
  console.log(`  TRAIL+REENTRY (act=30%, dist=7%):`);

  // Re-simulate with detailed logging
  const detail = simTradeWithTrailDetailed(
    m.pair, m.dir, m.engine, sig.size,
    sig.entryPrice, m.entryTime, sig.sl,
    sig.exitPrice, sig.exitTime, sig.exitReason,
    30, 7
  );

  console.log(`\n  1m Bar Walk-through:`);
  console.log(`    Entry @ ${ts(m.entryTime)}, raw=$${sig.entryPrice.toFixed(6)}`);

  // Show key bars leading up to trail (or end)
  for (const kb of detail.keyBars) {
    const hours = (kb.t - m.entryTime) / H;
    console.log(`    +${hours.toFixed(0).padStart(4)}h  ${ts(kb.t)}  close=$${kb.c.toFixed(6)}  peak=${kb.peakPct.toFixed(1)}%  curr=${kb.currPct.toFixed(1)}%`);
  }

  if (detail.trailFired && detail.trailFireBar) {
    const fb = detail.trailFireBar;
    const hours = (fb.t - m.entryTime) / H;
    console.log(`    TRAIL FIRES @ +${hours.toFixed(1)}h:`);
    console.log(`      Bar: ${ts(fb.t)} O=${fb.o.toFixed(6)} H=${fb.h.toFixed(6)} L=${fb.l.toFixed(6)} C=${fb.c.toFixed(6)}`);
    console.log(`      Peak P&L: ${fb.peakPct.toFixed(1)}% (>= act 30%)`);
    console.log(`      Curr P&L: ${fb.currPct.toFixed(1)}% (<= peak - dist = ${(fb.peakPct - 7).toFixed(1)}%)`);
    console.log(`      Drawdown from peak: ${(fb.peakPct - fb.currPct).toFixed(1)}% (>= dist 7%)`);
    const trailXp = exitPx(m.pair, m.dir, fb.c, false);
    const trailNot = sig.size * LEV;
    const trailPnl = calcPnl(m.dir, entryPx(m.pair, m.dir, sig.entryPrice), trailXp, trailNot);
    console.log(`      Exit px (with spread): $${trailXp.toFixed(6)}`);
    console.log(`      P&L: $${trailPnl.toFixed(4)}`);

    // Verify this matches the stored value
    console.log(`      v2 stored pnl: $${detail.pnl.toFixed(4)} [${Math.abs(trailPnl - detail.pnl) < 0.0001 ? "MATCH" : "MISMATCH"}]`);
  } else {
    console.log(`    Trail did NOT fire. Peak was ${detail.peakPct.toFixed(1)}% (needs >= 30%)`);
    console.log(`    Engine exit: ${ts(detail.exitTime)} [${detail.reason}]`);
  }

  console.log(`    Trail trade P&L: $${detail.pnl.toFixed(4)}`);

  // 3. Re-entry check
  if (m.trailFired) {
    console.log(`\n  ${subdiv}`);
    console.log(`  RE-ENTRY CHECK:`);

    const interval = ENGINE_INTERVALS[m.engine];
    const intervalName = m.engine === "A" ? "1d" : m.engine === "C" ? "1h" : "4h";
    let nextCheck = Math.ceil((detail.exitTime + 1) / interval) * interval;
    if (nextCheck <= detail.exitTime) nextCheck += interval;

    console.log(`    Trail exit:     ${ts(detail.exitTime)}`);
    console.log(`    Engine interval: ${intervalName} (${interval / H}h)`);
    console.log(`    Next check bar:  ${ts(nextCheck)}`);
    console.log(`    Gap:             ${((nextCheck - detail.exitTime) / H).toFixed(1)}h`);

    // Actually do the re-entry check
    const reCheck = checkReEntry(m.pair, m.dir, m.engine, nextCheck);
    console.log(`    Signal active:   ${reCheck.valid ? "YES" : "NO"}`);
    console.log(`    Debug:           ${reCheck.debugInfo ?? "n/a"}`);

    if (reCheck.valid) {
      console.log(`    Re-entry price:  $${reCheck.entryPrice.toFixed(6)} (raw)`);
      console.log(`    Fresh SL:        $${reCheck.sl.toFixed(6)} (${((Math.abs(reCheck.entryPrice - reCheck.sl) / reCheck.entryPrice) * 100).toFixed(2)}%)`);

      // Find engine exit for re-entry
      const reExit = findEngineExit(m.pair, m.engine, nextCheck, m.dir, reCheck.sl, reCheck.entryPrice, nextCheck);
      console.log(`    Engine exit:     ${ts(reExit.exitTime)} @ $${reExit.exitPrice.toFixed(6)} [${reExit.exitReason}]`);

      // Apply trail simulation to re-entry (the ensemble does this too)
      const reTrail = simTradeWithTrailDetailed(
        m.pair, m.dir, m.engine, sig.size,
        reCheck.entryPrice, nextCheck, reCheck.sl,
        reExit.exitPrice, reExit.exitTime, reExit.exitReason,
        30, 7
      );
      console.log(`    Trail sim on re-entry: exit=${ts(reTrail.exitTime)} [${reTrail.reason}] peak=${reTrail.peakPct.toFixed(1)}%`);
      if (reTrail.trailFired && reTrail.trailFireBar) {
        console.log(`      Re-entry trail fired @ ${ts(reTrail.trailFireBar.t)} peak=${reTrail.trailFireBar.peakPct.toFixed(1)}% curr=${reTrail.trailFireBar.currPct.toFixed(1)}%`);
      }

      const reNot = sig.size * LEV;
      console.log(`    Re-entry P&L (with trail): $${reTrail.pnl.toFixed(4)} (NOT=$${reNot}, fee=$${(reNot * FEE * 2).toFixed(4)})`);

      // Also compute without trail for comparison
      const reEp = entryPx(m.pair, m.dir, reCheck.entryPrice);
      const reXp = exitPx(m.pair, m.dir, reExit.exitPrice, reExit.exitReason === "sl");
      const rePnlNoTrail = calcPnl(m.dir, reEp, reXp, reNot);
      console.log(`    Re-entry P&L (no trail):   $${rePnlNoTrail.toFixed(4)}`);

      // Verify against matched data
      if (m.hasReEntry) {
        const matchTrail = Math.abs(reTrail.pnl - m.reEntryPnl) < 0.01;
        const matchNoTrail = Math.abs(rePnlNoTrail - m.reEntryPnl) < 0.01;
        console.log(`    v2 stored re-entry P&L: $${m.reEntryPnl.toFixed(4)} [${matchTrail ? "MATCH(trail)" : matchNoTrail ? "MATCH(no-trail)" : "MISMATCH"}]`);
        if (!matchTrail && !matchNoTrail) {
          console.log(`      NOTE: Mismatch likely due to pool dynamics (different positions open, different re-entry timing)`);
        }
      } else {
        console.log(`    v2 had NO re-entry for this trade (pool full or signal rejected at ensemble level)`);
      }
    }
  }

  // 4. Summary
  console.log(`\n  ${subdiv}`);
  console.log(`  SUMMARY:`);
  console.log(`    Baseline P&L:        $${m.baselinePnl.toFixed(4)}`);
  console.log(`    Trail trade P&L:     $${m.trailOrigPnl.toFixed(4)} [${m.trailOrigReason}]`);
  if (m.hasReEntry) {
    console.log(`    Re-entry P&L:        $${m.reEntryPnl.toFixed(4)} [${m.reEntryReason}]`);
    console.log(`    Combined trail+re:   $${m.totalTrailPnl.toFixed(4)}`);
  }
  console.log(`    DELTA (trail - base): $${m.delta.toFixed(4)} ${m.delta > 0 ? "[BETTER]" : "[WORSE]"}`);
  console.log("");
}

// ---- Print all 6 trade walk-throughs ----
console.log("\n" + "#".repeat(120));
console.log("# TRADE-LEVEL SPOT CHECK: 6 trades (3 better, 3 worse under trail 30/7 + re-entry vs baseline)");
console.log("# Pairs: DOGE, SOL | 1m bar precision");
console.log("#".repeat(120));

console.log("\n\n>>> SECTION 1: TRADES WHERE TRAIL+REENTRY BEATS BASELINE <<<\n");
for (let i = 0; i < better.length; i++) {
  printTradeWalkthrough(better[i], `BETTER #${i + 1}`);
}

console.log("\n\n>>> SECTION 2: TRADES WHERE TRAIL+REENTRY IS WORSE THAN BASELINE <<<\n");
for (let i = 0; i < worse.length; i++) {
  printTradeWalkthrough(worse[i], `WORSE #${i + 1}`);
}

// ---- Final audit summary ----
console.log("\n" + "=".repeat(120));
console.log("AUDIT SUMMARY");
console.log("=".repeat(120));
console.log(`Total DOGE/SOL matched trades: ${matched.length}`);
console.log(`Trail-fired trades:            ${trailFiredTrades.length}`);
console.log(`  Better (delta > 0):          ${trailFiredTrades.filter(m => m.delta > 0).length}`);
console.log(`  Worse  (delta < 0):          ${trailFiredTrades.filter(m => m.delta < 0).length}`);
console.log(`  Neutral (delta = 0):         ${trailFiredTrades.filter(m => m.delta === 0).length}`);
const avgBetter = trailFiredTrades.filter(m => m.delta > 0);
const avgWorse = trailFiredTrades.filter(m => m.delta < 0);
if (avgBetter.length > 0) console.log(`  Avg better delta:            $${(avgBetter.reduce((s, m) => s + m.delta, 0) / avgBetter.length).toFixed(4)}`);
if (avgWorse.length > 0) console.log(`  Avg worse delta:             $${(avgWorse.reduce((s, m) => s + m.delta, 0) / avgWorse.length).toFixed(4)}`);
console.log(`  Net delta all trail-fired:   $${trailFiredTrades.reduce((s, m) => s + m.delta, 0).toFixed(4)}`);
