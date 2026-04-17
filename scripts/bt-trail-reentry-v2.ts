/**
 * Trail + Re-entry Backtest v2 (5 bugs fixed from bt-trail-reentry-fixed.ts)
 *
 * BUG 1: Re-entries now go through position pool (live simulation, no pre-compute)
 * BUG 2: BTC filter for Donchian/Supertrend uses 4h EMA(12/21) (was daily EMA(20/50))
 * BUG 3: Supertrend re-entry signal uses stDir[i-1] (was stDir[i] look-ahead)
 * BUG 4: GARCH re-entry has minimum 1-bar gap after trail fires
 * BUG 5: Z-score window uses i-volWin+1 to i (exactly volWin returns)
 *
 * KEPT: A=$2/B=$3/C=$9/D=$3, 23 pairs, max 20, half-spreads, SMA ATR,
 *       SMA(20/50), ST(14,1.75), SMA look-ahead fix
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-reentry-v2.ts
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

// All 23 pairs
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

// SMA of last N TRs (not Wilder's smoothing) to match live indicators.ts
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

// BUG 5 FIX: Use i-volWin+1 to i (exactly volWin returns)
function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
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

// BUG 2 FIX: BTC 4h EMA(12/21) for Donchian + Supertrend + Momentum long filter
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);
// strict < on timestamp to exclude incomplete bar
function btcH4Bullish(t: number): boolean {
  let idx = -1;
  for (let i = btcH4.length - 1; i >= 0; i--) {
    if (btcH4[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > 0 && btcH4Ema21[idx] > 0 && btcH4Ema12[idx] > btcH4Ema21[idx];
}

// BTC 1h EMA(9/21) trend for GARCH filter (unchanged)
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

console.log("Loaded.\n");

// ─── Signal: stores raw engine signal ──────────────────────────────────────
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
  signalBarTs: number;
}

// ─── Engine A: Donchian SMA(20/50) ─────────────────────────────────────────
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
        // SMA look-ahead fix: use completed bars only -- i-1 and i-2
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        // BUG 2 FIX: BTC 4h EMA(12/21)
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;
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

// ─── Engine B: Supertrend(14, 1.75) ────────────────────────────────────────
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
        // BUG 2 FIX: BTC 4h EMA(12/21)
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;
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

// ─── Engine C: GARCH v2 (7% TP, 3% SL, 96h hold) ──────────────────────────
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
        if (ema9[prev] === 0 || ema21[prev] === 0) continue;
        if (goLong && ema9[prev] <= ema21[prev]) continue;
        if (goShort && ema9[prev] >= ema21[prev]) continue;
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

// ─── Engine D: Momentum Confirm ─────────────────────────────────────────────
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
        // BUG 2 FIX: BTC 4h EMA(12/21) for momentum too
        if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcH4Bullish(bar.t)) dir = "long"; }
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

// ─── Pre-compute indicators for re-entry checks ────────────────────────────

interface PairIndA { cs: C[]; fast: number[]; slow: number[]; atr: number[]; }
interface PairIndB { cs: C[]; stDir: number[]; atr: number[]; }
interface PairIndC { h1: C[]; h4: C[]; z1h: number[]; z4h: number[]; ema9: number[]; ema21: number[]; h4TsMap: Map<number, number>; }
interface PairIndD { cs: C[]; }

const indA = new Map<string, PairIndA>();
const indB = new Map<string, PairIndB>();
const indC = new Map<string, PairIndC>();
const indD = new Map<string, PairIndD>();

function precomputeIndicators(): void {
  for (const pair of PAIRS) {
    const csD = dailyData.get(pair);
    if (csD && csD.length >= 65) {
      const closes = csD.map(c => c.c);
      indA.set(pair, { cs: csD, fast: calcSMA(closes, 20), slow: calcSMA(closes, 50), atr: calcATR(csD, 14) });
    }
    const csH4 = h4Data.get(pair);
    if (csH4 && csH4.length >= 50) {
      const { dir: stDir } = calcSupertrend(csH4, 14, 1.75);
      indB.set(pair, { cs: csH4, stDir, atr: calcATR(csH4, 14) });
    }
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (h1 && h1.length >= 200 && h4 && h4.length >= 200) {
      const z1h = computeZScores(h1, 3, 20);
      const z4h = computeZScores(h4, 3, 20);
      const h1Closes = h1.map(c => c.c);
      const ema9 = calcEMA(h1Closes, 9);
      const ema21 = calcEMA(h1Closes, 21);
      const h4TsMap = new Map<number, number>();
      h4.forEach((c, ii) => h4TsMap.set(c.t, ii));
      indC.set(pair, { h1, h4, z1h, z4h, ema9, ema21, h4TsMap });
    }
    if (csH4 && csH4.length >= 55) {
      indD.set(pair, { cs: csH4 });
    }
  }
}

// ─── Re-entry signal checkers ──────────────────────────────────────────────
// BUG 3 FIX: Supertrend uses stDir[i-1] (last completed), not stDir[i]
// BUG 4 FIX: GARCH enforces minEntryTime = trailFireTime + interval (caller passes this)

function checkReEntryA(pair: string, dir: "long"|"short", checkTime: number): { entryPrice: number; sl: number; barIdx: number } | null {
  const ind = indA.get(pair);
  if (!ind) return null;
  const { cs, fast, slow, atr } = ind;
  for (let i = 51; i < cs.length; i++) {
    if (cs[i].t < checkTime) continue;
    if (cs[i].t >= FULL_END) break;
    const p = i - 1;
    if (fast[p] === 0 || slow[p] === 0) return null;
    const stillActive = dir === "long" ? fast[p] > slow[p] : fast[p] < slow[p];
    if (!stillActive) return null;
    if (dir === "long" && !btcH4Bullish(cs[i].t)) return null;
    const prevATR = atr[i - 1]; if (prevATR <= 0) return null;
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { entryPrice: cs[i].o, sl, barIdx: i };
  }
  return null;
}

// BUG 3 FIX: use stDir[i-1] (last completed bar), not stDir[i]
function checkReEntryB(pair: string, dir: "long"|"short", checkTime: number): { entryPrice: number; sl: number; barIdx: number } | null {
  const ind = indB.get(pair);
  if (!ind) return null;
  const { cs, stDir, atr } = ind;
  for (let i = 17; i < cs.length; i++) {
    if (cs[i].t < checkTime) continue;
    if (cs[i].t >= FULL_END) break;
    const curDir: "long"|"short" = stDir[i - 1] === 1 ? "long" : "short";
    if (curDir !== dir) return null;
    if (dir === "long" && !btcH4Bullish(cs[i].t)) return null;
    const prevATR = atr[i - 1]; if (prevATR <= 0) return null;
    let sl = dir === "long" ? cs[i].o - 3 * prevATR : cs[i].o + 3 * prevATR;
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { entryPrice: cs[i].o, sl, barIdx: i };
  }
  return null;
}

function checkReEntryC(pair: string, dir: "long"|"short", checkTime: number): { entryPrice: number; sl: number; barIdx: number } | null {
  const ind = indC.get(pair);
  if (!ind) return null;
  const { h1, z1h, z4h, ema9, ema21, h4TsMap } = ind;
  for (let i = 24; i < h1.length; i++) {
    if (h1[i].t < checkTime) continue;
    if (h1[i].t >= FULL_END) break;
    const prev = i - 1; if (prev < 23) continue;
    const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) return null;
    const goLong = dir === "long" && z1 > 4.5;
    const goShort = dir === "short" && z1 < -3.0;
    if (!goLong && !goShort) return null;
    const ts4h = Math.floor(h1[prev].t / H4) * H4;
    const idx4h = h4TsMap.get(ts4h);
    if (idx4h === undefined || idx4h < 23) return null;
    const z4 = z4h[idx4h];
    if (goLong && z4 <= 3.0) return null;
    if (goShort && z4 >= -3.0) return null;
    if (ema9[prev] === 0 || ema21[prev] === 0) return null;
    if (goLong && ema9[prev] <= ema21[prev]) return null;
    if (goShort && ema9[prev] >= ema21[prev]) return null;
    const btcT = btcH1Trend(h1[prev].t);
    if (goLong && btcT !== "long") return null;
    if (goShort && btcT !== "short") return null;
    let sl = dir === "long" ? h1[i].o * (1 - 0.03) : h1[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, h1[i].o * 0.965);
    else sl = Math.min(sl, h1[i].o * 1.035);
    return { entryPrice: h1[i].o, sl, barIdx: i };
  }
  return null;
}

function checkReEntryD(pair: string, dir: "long"|"short", checkTime: number): { entryPrice: number; sl: number; barIdx: number } | null {
  const ind = indD.get(pair);
  if (!ind) return null;
  const { cs } = ind;
  for (let i = 52; i < cs.length; i++) {
    if (cs[i].t < checkTime) continue;
    if (cs[i].t >= FULL_END) break;
    const prev = i - 1;
    const ranges: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
    if (ranges.length < 20) return null;
    const rMean = ranges.reduce((s, v) => s + v, 0) / ranges.length;
    const rStd = Math.sqrt(ranges.reduce((s, v) => s + (v - rMean) ** 2, 0) / ranges.length);
    const volZ = rStd > 0 ? (ranges[ranges.length - 1] - rMean) / rStd : 0;
    const fp: number[] = [];
    for (let j = Math.max(0, prev - 50); j <= prev; j++) fp.push((cs[j].c - cs[j].o) / cs[j].c);
    if (fp.length < 20) return null;
    const fpMean = fp.reduce((s, v) => s + v, 0) / fp.length;
    const fpStd = Math.sqrt(fp.reduce((s, v) => s + (v - fpMean) ** 2, 0) / fp.length);
    const fundZ = fpStd > 0 ? (fp[fp.length - 1] - fpMean) / fpStd : 0;
    const closes: number[] = [];
    for (let j = prev - 20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
    if (closes.length < 20) return null;
    const cMean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const cStd = Math.sqrt(closes.reduce((s, v) => s + (v - cMean) ** 2, 0) / closes.length);
    const priceZ = cStd > 0 ? (closes[closes.length - 1] - cMean) / cStd : 0;
    let curDir: "long"|"short"|null = null;
    if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcH4Bullish(cs[i].t)) curDir = "long"; }
    else if (volZ > 2 && fundZ < -2 && priceZ < -1) { curDir = "short"; }
    if (curDir !== dir) return null;
    let sl = dir === "long" ? cs[i].o * (1 - 0.03) : cs[i].o * (1 + 0.03);
    if (dir === "long") sl = Math.max(sl, cs[i].o * 0.965);
    else sl = Math.min(sl, cs[i].o * 1.035);
    return { entryPrice: cs[i].o, sl, barIdx: i };
  }
  return null;
}

// ─── Engine exit finders ────────────────────────────────────────────────────

function findEngineAExit(cs: C[], startI: number, dir: "long"|"short", sl: number, _ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
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

function findEngineBExit(cs: C[], stDir: number[], startI: number, dir: "long"|"short", sl: number, _ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
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

function findEngineDExit(cs: C[], startI: number, dir: "long"|"short", sl: number, _ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  for (let i = startI + 1; i < cs.length; i++) {
    const bar = cs[i];
    if (dir === "long" && bar.l <= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if (dir === "short" && bar.h >= sl) return { exitTime: bar.t, exitPrice: sl, exitReason: "sl" };
    if ((bar.t - et) / H >= 48) return { exitTime: bar.t, exitPrice: bar.c, exitReason: "mh" };
  }
  const last = cs[cs.length - 1];
  return { exitTime: last.t, exitPrice: last.c, exitReason: "mh" };
}

// Find raw engine exit for a re-entry
function findRawExit(engine: string, pair: string, dir: "long"|"short", barIdx: number, sl: number, ep: number, et: number): { exitTime: number; exitPrice: number; exitReason: string } {
  if (engine === "A") {
    const ind = indA.get(pair)!;
    return findEngineAExit(ind.cs, barIdx, dir, sl, ep, et);
  }
  if (engine === "B") {
    const ind = indB.get(pair)!;
    return findEngineBExit(ind.cs, ind.stDir, barIdx, dir, sl, ep, et);
  }
  if (engine === "C") {
    const ind = indC.get(pair)!;
    return findEngineCExit(ind.h1, barIdx, dir, sl, ep, et);
  }
  if (engine === "D") {
    const ind = indD.get(pair)!;
    return findEngineDExit(ind.cs, barIdx, dir, sl, ep, et);
  }
  return { exitTime: et + D, exitPrice: ep, exitReason: "err" };
}

// ─── 1m trail simulation ───────────────────────────────────────────────────
interface TrailResult {
  pnl: number;
  reason: string;
  exitTime: number;
  peakPct: number;
  trailFired: boolean;
  trailFireTime: number;
}

function simTrail(sig: Signal, act: number, dist: number): TrailResult {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: 0, trailFired: false, trailFireTime: 0 };
  }

  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakPnlPct = 0;

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, trailFireTime: 0 };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, trailFireTime: 0 };
    }

    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, trailFireTime: 0 };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct, trailFired: false, trailFireTime: 0 };
      }
    }

    const bestPct = sig.dir === "long"
      ? (b.h / sig.entryPrice - 1) * LEV * 100
      : (sig.entryPrice / b.l - 1) * LEV * 100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    if (act > 0 && peakPnlPct >= act) {
      const currPct = sig.dir === "long"
        ? (b.c / sig.entryPrice - 1) * LEV * 100
        : (sig.entryPrice / b.c - 1) * LEV * 100;
      if (currPct <= peakPnlPct - dist) {
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        return {
          pnl: calcPnl(sig.dir, ep, xp, NOT),
          reason: "trail",
          exitTime: b.t,
          peakPct: peakPnlPct,
          trailFired: true,
          trailFireTime: b.t,
        };
      }
    }
  }

  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: peakPnlPct, trailFired: false, trailFireTime: 0 };
}

// ─── BUG 1 FIX: Live simulation with position pool ─────────────────────────
// Walk through time chronologically. Track open positions in pool.
// When trail fires, close position (free slot). At next engine check interval,
// check if signal still active AND pool has room. If yes, open re-entry.

interface TradeRecord {
  pnl: number;
  reason: string;
  exitTime: number;
  entryTime: number;
  engine: string;
  pair: string;
  isReEntry: boolean;
}

function runEnsemble(
  allSignals: Signal[],
  act: number,
  dist: number,
  allowReEntry: boolean,
  startTs: number,
  endTs: number
): { trades: TradeRecord[]; blocked: number; reEntries: number; trailExits: number } {
  const windowSigs = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs);

  // Pre-compute trail results for all signals
  const trailResults = windowSigs.map(sig => simTrail(sig, act, dist));

  // Timeline event types
  interface TLEvent {
    t: number;
    kind: "exit" | "entry" | "re-exit" | "re-check";
    sigIdx?: number;       // index into windowSigs
    reKey?: string;        // engine:pair key for re-entry position
    rePnl?: number;        // PnL for re-entry exit
    reReason?: string;
    reEntryTime?: number;
    reEngine?: string;
    rePair?: string;
    // re-check data
    origSig?: Signal;
    trailFireTime?: number;
  }

  // Build initial timeline from main signals
  const timeline: TLEvent[] = [];
  for (let idx = 0; idx < windowSigs.length; idx++) {
    timeline.push({ t: windowSigs[idx].entryTime, kind: "entry", sigIdx: idx });
    timeline.push({ t: trailResults[idx].exitTime, kind: "exit", sigIdx: idx });
  }

  // Sort: exits before entries at same time, re-exits before re-checks
  const kindOrder: Record<string, number> = { "exit": 0, "re-exit": 1, "re-check": 2, "entry": 3 };
  timeline.sort((a, b) => a.t - b.t || kindOrder[a.kind] - kindOrder[b.kind]);

  // Pool state
  const openMain = new Map<string, number>();    // engine:pair -> sigIdx
  const openReEntry = new Map<string, number>(); // engine:pair -> exitTime
  const acceptedIdxs = new Set<number>();
  const trades: TradeRecord[] = [];
  let blocked = 0;
  let reEntryCount = 0;
  let trailExitCount = 0;

  // Dynamic event insertion buffer (re-entry checks and re-entry exits)
  const dynamicEvents: TLEvent[] = [];

  function insertDynamic(evt: TLEvent): void {
    dynamicEvents.push(evt);
  }

  // Merge main timeline with dynamic events and process
  let mainPtr = 0;

  function getNextEvent(): TLEvent | null {
    // Sort dynamic events
    dynamicEvents.sort((a, b) => a.t - b.t || kindOrder[a.kind] - kindOrder[b.kind]);

    const mainEvt = mainPtr < timeline.length ? timeline[mainPtr] : null;
    const dynEvt = dynamicEvents.length > 0 ? dynamicEvents[0] : null;

    if (!mainEvt && !dynEvt) return null;
    if (!mainEvt) { dynamicEvents.shift(); return dynEvt; }
    if (!dynEvt) { mainPtr++; return mainEvt; }

    // Compare: process whichever is earlier (exits before entries at same time)
    const cmp = mainEvt.t - dynEvt.t || kindOrder[mainEvt.kind] - kindOrder[dynEvt.kind];
    if (cmp <= 0) { mainPtr++; return mainEvt; }
    else { dynamicEvents.shift(); return dynEvt; }
  }

  let evt: TLEvent | null;
  while ((evt = getNextEvent()) !== null) {
    const k = evt.sigIdx !== undefined ? `${windowSigs[evt.sigIdx].engine}:${windowSigs[evt.sigIdx].pair}` : (evt.reKey ?? "");

    if (evt.kind === "exit") {
      if (!acceptedIdxs.has(evt.sigIdx!)) continue;
      openMain.delete(k);

      // If trail fired, schedule re-entry check
      if (allowReEntry) {
        const tr = trailResults[evt.sigIdx!];
        if (tr.trailFired) {
          trailExitCount++;
          const sig = windowSigs[evt.sigIdx!];
          const interval = ENGINE_INTERVALS[sig.engine];
          // BUG 4 FIX: minimum 1-bar gap for all engines
          const minReEntryTime = tr.trailFireTime + interval;
          const nextBarTs = Math.ceil(minReEntryTime / interval) * interval;
          insertDynamic({
            t: nextBarTs,
            kind: "re-check",
            reKey: k,
            origSig: sig,
            trailFireTime: tr.trailFireTime,
          });
        }
      }
    } else if (evt.kind === "re-exit") {
      openReEntry.delete(evt.reKey!);
      trades.push({
        pnl: evt.rePnl!,
        reason: evt.reReason!,
        exitTime: evt.t,
        entryTime: evt.reEntryTime!,
        engine: evt.reEngine!,
        pair: evt.rePair!,
        isReEntry: true,
      });
    } else if (evt.kind === "re-check") {
      const rk = evt.reKey!;
      // Check pool has room
      const totalOpen = openMain.size + openReEntry.size;
      if (totalOpen >= MAX_POS) continue;
      if (openMain.has(rk) || openReEntry.has(rk)) continue;

      const origSig = evt.origSig!;
      let check: { entryPrice: number; sl: number; barIdx: number } | null = null;
      if (origSig.engine === "A") check = checkReEntryA(origSig.pair, origSig.dir, evt.t);
      else if (origSig.engine === "B") check = checkReEntryB(origSig.pair, origSig.dir, evt.t);
      else if (origSig.engine === "C") check = checkReEntryC(origSig.pair, origSig.dir, evt.t);
      else if (origSig.engine === "D") check = checkReEntryD(origSig.pair, origSig.dir, evt.t);

      if (!check || check.entryPrice <= 0) continue;

      // Find raw exit
      const rawExit = findRawExit(origSig.engine, origSig.pair, origSig.dir, check.barIdx, check.sl, check.entryPrice, evt.t);

      // Build re-entry signal and simulate (no trail on re-entry)
      const reSig: Signal = {
        ...origSig,
        entryTime: evt.t,
        entryPrice: check.entryPrice,
        sl: check.sl,
        exitTime: rawExit.exitTime,
        exitPrice: rawExit.exitPrice,
        exitReason: rawExit.exitReason,
      };
      const reResult = simTrail(reSig, 0, 0);

      // Add to pool
      openReEntry.set(rk, reResult.exitTime);
      reEntryCount++;

      // Schedule re-entry exit event (PnL recorded at exit time)
      insertDynamic({
        t: reResult.exitTime,
        kind: "re-exit",
        reKey: rk,
        rePnl: reResult.pnl,
        reReason: reResult.reason,
        reEntryTime: evt.t,
        reEngine: origSig.engine,
        rePair: origSig.pair,
      });
    } else if (evt.kind === "entry") {
      const totalOpen = openMain.size + openReEntry.size;
      if (openMain.has(k) || openReEntry.has(k)) { blocked++; continue; }
      if (totalOpen >= MAX_POS) { blocked++; continue; }

      openMain.set(k, evt.sigIdx!);
      acceptedIdxs.add(evt.sigIdx!);

      const tr = trailResults[evt.sigIdx!];
      if (!allowReEntry && tr.trailFired) trailExitCount++;

      trades.push({
        pnl: tr.pnl,
        reason: tr.reason,
        exitTime: tr.exitTime,
        entryTime: windowSigs[evt.sigIdx!].entryTime,
        engine: windowSigs[evt.sigIdx!].engine,
        pair: windowSigs[evt.sigIdx!].pair,
        isReEntry: false,
      });
    }
  }

  return { trades, blocked, reEntries: reEntryCount, trailExits: trailExitCount };
}

// ─── Generate all signals ──────────────────────────────────────────────────
console.log("Pre-computing indicators...");
precomputeIndicators();

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

// ─── Test configs ──────────────────────────────────────────────────────────
interface ConfigSpec {
  label: string;
  act: number;
  dist: number;
  reEntry: boolean;
}

const CONFIGS: ConfigSpec[] = [
  { label: "Baseline (no trail)",           act: 0,  dist: 0,  reEntry: false },
  { label: "Trail 20/5 + re-entry",         act: 20, dist: 5,  reEntry: true  },
  { label: "Trail 30/7 + re-entry",         act: 30, dist: 7,  reEntry: true  },
  { label: "Trail 40/10 + re-entry",        act: 40, dist: 10, reEntry: true  },
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
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp     = wins.reduce((s, t) => s + t.pnl, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total  = trades.reduce((s, t) => s + t.pnl, 0);

  // MaxDD on cumulative pnl sorted by exit time
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
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
  const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // OOS
  const oosT   = oos.trades;
  const oosWins = oosT.filter(t => t.pnl > 0);
  const oosLoss = oosT.filter(t => t.pnl <= 0);
  const oosTotal = oosT.reduce((s, t) => s + t.pnl, 0);
  const oosGP = oosWins.reduce((s, t) => s + t.pnl, 0);
  const oosGL = Math.abs(oosLoss.reduce((s, t) => s + t.pnl, 0));

  results.push({
    label: cfg.label,
    trades: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total, perDay: total / days,
    maxDD, sharpe,
    blocked: full.blocked,
    trailExits: full.trailExits,
    reEntries: full.reEntries,
    oosTotal, oosPerDay: oosTotal / oosDays,
    oosPf: oosGL > 0 ? oosGP / oosGL : 99,
  });

  console.log(` done. $${(total / days).toFixed(2)}/day, DD $${maxDD.toFixed(0)}, trails: ${full.trailExits}, re-entries: ${full.reEntries}`);
}

// ─── Output ────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(160));
console.log("TRAIL + RE-ENTRY BACKTEST v2 | 5 bugs fixed from bt-trail-reentry-fixed.ts");
console.log("BUG1: re-entries through pool | BUG2: BTC 4h EMA(12/21) | BUG3: ST re-entry i-1 | BUG4: GARCH 1-bar gap | BUG5: z-score window");
console.log("Engines: Donchian $2 + Supertrend $3 + GARCH v2 $9 + Momentum $3 | 23 pairs | 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("Position pool: max 20 | 1m bars for trail precision | Re-entry at next engine bar if signal active AND pool has room");
console.log("=".repeat(160));

const W = {
  label: 28,
  trades: 7, wr: 7, total: 12, perDay: 10, pf: 7, sharpe: 8, maxDD: 10,
  trails: 7, reEnt: 8, oosDay: 10, oosPf: 8,
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
