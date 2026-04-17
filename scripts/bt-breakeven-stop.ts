/**
 * BREAKEVEN STOP Research
 * Tests moving SL to entry (+ buffer) once trade reaches profit threshold.
 * All 4 engines (Donchian $7 + Supertrend $5 + GARCH $3 + Momentum $3)
 * 23 pairs, 1m precision for breakeven check, fair comparison (same trade set).
 *
 * Configs:
 *  1. No breakeven (current baseline)
 *  2. Breakeven at +1x ATR profit (SL -> entry + 0.5% buffer)
 *  3. Breakeven at +2x ATR profit
 *  4. Breakeven at +3x ATR profit
 *  5. Breakeven at +10% unrealized (leveraged)
 *  6. Breakeven at +20% unrealized (leveraged)
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-breakeven-stop.ts
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
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

// Half-spreads matching live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX",
  "NEAR", "SUI", "FET",
];

/* ---------- data loading ---------- */

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
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

/* ---------- indicators (SMA-based ATR, no Wilder's) ---------- */

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(
      cs[i].h - cs[i].l,
      Math.abs(cs[i].h - cs[i - 1].c),
      Math.abs(cs[i].l - cs[i - 1].c),
    );
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
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
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

// FIX: Donchian uses i-lb to i-1 (exclusive of current bar) to avoid look-ahead
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
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u; lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j - 1].c - 1;
      sumSq += r * r; count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

/* ---------- cost model ---------- */

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function exitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, not: number): number {
  return (dir === "long" ? (xp / ep - 1) * not : (ep / xp - 1) * not) - not * FEE * 2;
}

/* ---------- load data ---------- */

console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) raw1m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC daily filter
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20.length);
  const i50 = idx - (btcDaily.length - btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

// BTC 1h filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) {
    for (let i = btcH1.length - 1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } }
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

/* ---------- signal interface ---------- */

interface Signal {
  pair: string; dir: "long" | "short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
  entryATR: number; // ATR at entry for ATR-based breakeven thresholds
}

/* ---------- Engine A: Donchian ---------- */

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
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({
              pair, dir: pos.dir, engine: "A", size: 7,
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason,
              entryATR: pos.atr,
            });
          pos = null;
        }
      }
      if (!pos) {
        const p = i - 1; const pp = i - 2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long" | "short" | null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long";
        else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, atr: prevATR };
      }
    }
  }
  return sigs;
}

/* ---------- Engine B: Supertrend ---------- */

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
      const flip = stDir[i - 1] !== stDir[i - 2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60 * 24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({
              pair, dir: pos.dir, engine: "B", size: 5,
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason,
              entryATR: pos.atr,
            });
          pos = null;
        }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long" | "short" = stDir[i - 1] === 1 ? "long" : "short";
        if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3 * prevATR : bar.o + 3 * prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl, atr: prevATR };
      }
    }
  }
  return sigs;
}

/* ---------- Engine C: GARCH v2 ---------- */

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
    // Get 1h ATR for entryATR
    const h1ATR = calcATR(h1, 14);
    let pos: any = null;
    for (let i = 23; i < h1.length; i++) {
      const bar = h1[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        // TP 7%
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t - pos.et) / H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({
              pair, dir: pos.dir, engine: "C", size: 3,
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason,
              entryATR: pos.atr,
            });
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
        const dir: "long" | "short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        const prevATR = h1ATR[prev];
        pos = { dir, ep: bar.o, et: bar.t, sl, atr: prevATR > 0 ? prevATR : bar.o * 0.01 };
      }
    }
  }
  return sigs;
}

/* ---------- Engine D: Momentum Confirm ---------- */

function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < 55) continue;
    const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 52; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && (bar.t - pos.et) / H >= 48) { xp = bar.c; reason = "mh"; }
        if (xp > 0) {
          if (pos.et >= FULL_START && pos.et < FULL_END)
            sigs.push({
              pair, dir: pos.dir, engine: "D", size: 3,
              entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl,
              exitTime: bar.t, exitPrice: xp, exitReason: reason,
              entryATR: pos.atr,
            });
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

        let dir: "long" | "short" | null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) {
          if (btcDailyBullish(bar.t)) dir = "long";
        } else if (volZ > 2 && fundZ < -2 && priceZ < -1) {
          dir = "short";
        }
        if (!dir) continue;

        let sl = dir === "long" ? bar.o * (1 - 0.03) : bar.o * (1 + 0.03);
        if (dir === "long") sl = Math.max(sl, bar.o * 0.965);
        else sl = Math.min(sl, bar.o * 1.035);
        const prevATR = atr[prev];
        pos = { dir, ep: bar.o, et: bar.t, sl, atr: prevATR > 0 ? prevATR : bar.o * 0.01 };
      }
    }
  }
  return sigs;
}

/* ---------- breakeven config ---------- */

interface BEConfig {
  label: string;
  // Threshold type: "atr" or "pct" (leveraged unrealized %)
  type: "none" | "atr" | "pct";
  // For "atr": number of ATR multiples to reach before moving SL to breakeven
  // For "pct": leveraged unrealized % to reach
  threshold: number;
  buffer: number; // buffer above entry as fraction (0.005 = 0.5%)
}

const CONFIGS: BEConfig[] = [
  { label: "NO BE (baseline)", type: "none", threshold: 0, buffer: 0 },
  { label: "BE @ +1x ATR",     type: "atr",  threshold: 1, buffer: 0.005 },
  { label: "BE @ +2x ATR",     type: "atr",  threshold: 2, buffer: 0.005 },
  { label: "BE @ +3x ATR",     type: "atr",  threshold: 3, buffer: 0.005 },
  { label: "BE @ +10% unreal", type: "pct",  threshold: 10, buffer: 0.005 },
  { label: "BE @ +20% unreal", type: "pct",  threshold: 20, buffer: 0.005 },
];

/* ---------- simulate single trade with breakeven logic ---------- */

interface TradeResult {
  pnl: number;
  reason: string;
  exitTime: number;
  peakPct: number;
  beActivated: boolean;     // did breakeven ever activate?
  hitBEStop: boolean;       // did the trade exit via breakeven stop?
  baselinePnl: number;      // what would the trade have earned without breakeven?
  stolenWinner: boolean;    // was this a winner without BE but got stopped at BE?
}

function simTradeBreakeven(
  sig: Signal,
  cfg: BEConfig,
  baselinePnlMap: Map<string, number>, // pre-computed baseline pnl for each trade key
): TradeResult {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);
  const tradeKey = `${sig.engine}:${sig.pair}:${sig.entryTime}`;
  const basePnl = baselinePnlMap.get(tradeKey) ?? 0;

  // No 1m data -> use engine exit as-is (no breakeven possible)
  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    const pnl = calcPnl(sig.dir, ep, xp, NOT);
    return { pnl, reason: sig.exitReason, exitTime: sig.exitTime, peakPct: 0, beActivated: false, hitBEStop: false, baselinePnl: basePnl, stolenWinner: false };
  }

  // Binary search for start index
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; }
    else { lo = mid + 1; }
  }

  let peakPnlPct = 0;
  let beActive = false;
  let beSL = 0; // the breakeven stop level

  // Compute breakeven threshold in price terms
  let beThresholdPrice = 0;
  if (cfg.type === "atr") {
    // +Nx ATR from entry (raw, not leveraged)
    const atrMove = cfg.threshold * sig.entryATR;
    beThresholdPrice = sig.dir === "long"
      ? sig.entryPrice + atrMove
      : sig.entryPrice - atrMove;
  }
  // For "pct" type, threshold is leveraged %, so we compute in the loop

  // Breakeven SL = entry + buffer (for longs) or entry - buffer (for shorts)
  const beSLPrice = sig.dir === "long"
    ? sig.entryPrice * (1 + cfg.buffer)
    : sig.entryPrice * (1 - cfg.buffer);

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    // Determine which SL to use
    const currentSL = beActive ? beSL : sig.sl;

    // SL check (original or breakeven)
    if (sig.dir === "long" && b.l <= currentSL) {
      const xp = exitPx(sig.pair, sig.dir, currentSL, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOT);
      const hitBE = beActive;
      return {
        pnl, reason: hitBE ? "be" : "sl", exitTime: b.t, peakPct: peakPnlPct,
        beActivated: beActive, hitBEStop: hitBE,
        baselinePnl: basePnl, stolenWinner: hitBE && basePnl > 0,
      };
    }
    if (sig.dir === "short" && b.h >= currentSL) {
      const xp = exitPx(sig.pair, sig.dir, currentSL, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOT);
      const hitBE = beActive;
      return {
        pnl, reason: hitBE ? "be" : "sl", exitTime: b.t, peakPct: peakPnlPct,
        beActivated: beActive, hitBEStop: hitBE,
        baselinePnl: basePnl, stolenWinner: hitBE && basePnl > 0,
      };
    }

    // GARCH v2 TP check (7%)
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return {
          pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct,
          beActivated: beActive, hitBEStop: false, baselinePnl: basePnl, stolenWinner: false,
        };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return {
          pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct,
          beActivated: beActive, hitBEStop: false, baselinePnl: basePnl, stolenWinner: false,
        };
      }
    }

    // Peak tracking
    const bestPct = sig.dir === "long"
      ? (b.h / sig.entryPrice - 1) * LEV * 100
      : (sig.entryPrice / b.l - 1) * LEV * 100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    // Breakeven activation check
    if (!beActive && cfg.type !== "none") {
      let triggered = false;
      if (cfg.type === "atr") {
        if (sig.dir === "long" && b.h >= beThresholdPrice) triggered = true;
        if (sig.dir === "short" && b.l <= beThresholdPrice) triggered = true;
      } else if (cfg.type === "pct") {
        // Leveraged unrealized %
        if (bestPct >= cfg.threshold) triggered = true;
      }
      if (triggered) {
        beActive = true;
        beSL = beSLPrice;
      }
    }
  }

  // Engine exit (no breakeven triggered or price never came back to BE)
  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  const pnl = calcPnl(sig.dir, ep, xp, NOT);
  return {
    pnl, reason: sig.exitReason, exitTime: sig.exitTime, peakPct: peakPnlPct,
    beActivated: beActive, hitBEStop: false, baselinePnl: basePnl, stolenWinner: false,
  };
}

/* ---------- fair comparison: same trade set ---------- */

const noTrailCache = new Map<string, Signal[]>();

function buildAcceptedSet(allSignals: Signal[], startTs: number, endTs: number): Signal[] {
  const periodKey = `${startTs}-${endTs}`;
  if (noTrailCache.has(periodKey)) return noTrailCache.get(periodKey)!;

  // Simulate all with no breakeven to get exit times for pool management
  const processed = allSignals.map(sig => {
    const result = simTradeBreakeven(sig, CONFIGS[0], new Map());
    return { ...sig, adjExitTime: result.exitTime };
  });

  interface Event { t: number; type: "entry" | "exit"; idx: number; engine: string; pair: string }
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
    const key = `${evt.engine}:${evt.pair}`;
    if (evt.type === "exit") { openPos.delete(key); }
    else {
      if (openPos.has(key)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(key, evt.idx);
      accepted.push(allSignals[evt.idx]);
    }
  }
  noTrailCache.set(periodKey, accepted);
  return accepted;
}

/* ---------- run ensemble ---------- */

interface EnsembleResult {
  trades: TradeResult[];
  blocked: number;
  totalSignals: number;
}

function runEnsemble(
  allSignals: Signal[],
  cfg: BEConfig,
  startTs: number,
  endTs: number,
  baselinePnlMap: Map<string, number>,
): EnsembleResult {
  const accepted = buildAcceptedSet(allSignals, startTs, endTs);

  const trades = accepted.map(sig => simTradeBreakeven(sig, cfg, baselinePnlMap));

  const totalInPeriod = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length, totalSignals: totalInPeriod };
}

/* ---------- generate signals ---------- */

console.log("Generating signals from all 4 engines...");
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

/* ---------- run configs ---------- */

const days = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

// First pass: compute baseline PnL for each trade (no breakeven)
console.log("Computing baseline (no breakeven)...");
const baselineAccepted = buildAcceptedSet(allSigs, FULL_START, FULL_END);
const baselinePnlMap = new Map<string, number>();
for (const sig of baselineAccepted) {
  const result = simTradeBreakeven(sig, CONFIGS[0], new Map());
  const key = `${sig.engine}:${sig.pair}:${sig.entryTime}`;
  baselinePnlMap.set(key, result.pnl);
}
// Also for OOS
const baselineAcceptedOOS = buildAcceptedSet(allSigs, OOS_START, FULL_END);
const baselinePnlMapOOS = new Map<string, number>();
for (const sig of baselineAcceptedOOS) {
  const result = simTradeBreakeven(sig, CONFIGS[0], new Map());
  const key = `${sig.engine}:${sig.pair}:${sig.entryTime}`;
  baselinePnlMapOOS.set(key, result.pnl);
}
console.log(`  Baseline trades: ${baselineAccepted.length} (full), ${baselineAcceptedOOS.length} (OOS)\n`);

interface ResultRow {
  label: string;
  trades: number;
  wr: number;
  pf: number;
  total: number;
  avgPnl: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  blocked: number;
  beActivated: number;  // trades where BE threshold was reached
  beExits: number;      // trades that actually exited via breakeven stop
  stolenWinners: number; // trades that were winners without BE but got stopped at BE
  stolenPnl: number;    // total PnL lost from stolen winners
  oosTotal: number;
  oosPerDay: number;
  oosPf: number;
  oosBeExits: number;
}

const results: ResultRow[] = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`  ${cfg.label}...`);

  const full = runEnsemble(allSigs, cfg, FULL_START, FULL_END, baselinePnlMap);
  const oos = runEnsemble(allSigs, cfg, OOS_START, FULL_END, baselinePnlMapOOS);

  const trades = full.trades;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = trades.length > 0 ? total / trades.length : 0;

  // MaxDD
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = trades.map((t, i) => ({ ...t, idx: i })).sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  // Sharpe
  const dayPnl = new Map<number, number>();
  for (const t of trades) { const d = Math.floor(t.exitTime / D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Breakeven stats
  const beActivated = trades.filter(t => t.beActivated).length;
  const beExits = trades.filter(t => t.hitBEStop).length;
  const stolen = trades.filter(t => t.stolenWinner);
  const stolenWinners = stolen.length;
  const stolenPnl = stolen.reduce((s, t) => s + t.baselinePnl, 0);

  // OOS
  const oosT = oos.trades;
  const oosWins = oosT.filter(t => t.pnl > 0);
  const oosLosses = oosT.filter(t => t.pnl <= 0);
  const oosTotal = oosT.reduce((s, t) => s + t.pnl, 0);
  const oosGP = oosWins.reduce((s, t) => s + t.pnl, 0);
  const oosGL = Math.abs(oosLosses.reduce((s, t) => s + t.pnl, 0));
  const oosBeExits = oosT.filter(t => t.hitBEStop).length;

  results.push({
    label: cfg.label, trades: trades.length,
    wr: trades.length > 0 ? wins.length / trades.length * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total, avgPnl, perDay: total / days, maxDD, sharpe, blocked: full.blocked,
    beActivated, beExits, stolenWinners, stolenPnl,
    oosTotal, oosPerDay: oosTotal / oosDays, oosPf: oosGL > 0 ? oosGP / oosGL : 99,
    oosBeExits,
  });

  console.log(` $${(total / days).toFixed(2)}/day, DD $${maxDD.toFixed(0)}, BE exits: ${beExits}, stolen: ${stolenWinners}`);
}

/* ---------- output ---------- */

console.log("\n" + "=".repeat(160));
console.log("BREAKEVEN STOP RESEARCH - FULL 4-ENGINE ENSEMBLE");
console.log("Engines: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3 | 23 pairs | Pool max 20");
console.log("Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("Breakeven = move SL to entry + 0.5% buffer once profit threshold reached");
console.log("=".repeat(160));

// Main results table
console.log(`\n${"Config".padEnd(20)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"AvgPnL".padStart(9)} ${"Total".padStart(10)} ${"$/day".padStart(8)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"MaxDD".padStart(8)} ${"BE act".padStart(7)} ${"BE exit".padStart(8)} ${"Stolen".padStart(7)} ${"StolenPnL".padStart(10)} ${"OOS$/d".padStart(8)} ${"OOS PF".padStart(7)}`);
console.log("-".repeat(160));

for (const r of results) {
  const mark = r.label.includes("baseline") ? " <<<" : "";
  console.log(
    `${r.label.padEnd(20)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)}% ${("$" + r.avgPnl.toFixed(3)).padStart(9)} ${("$" + r.total.toFixed(1)).padStart(10)} ${("$" + r.perDay.toFixed(2)).padStart(8)} ${r.pf.toFixed(2).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)} ${("$" + r.maxDD.toFixed(0)).padStart(8)} ${String(r.beActivated).padStart(7)} ${String(r.beExits).padStart(8)} ${String(r.stolenWinners).padStart(7)} ${("$" + r.stolenPnl.toFixed(1)).padStart(10)} ${("$" + r.oosPerDay.toFixed(2)).padStart(8)} ${r.oosPf.toFixed(2).padStart(7)}${mark}`,
  );
}

// Detailed comparison
console.log("\n" + "=".repeat(120));
console.log("DETAILED COMPARISON vs BASELINE");
console.log("=".repeat(120));

const baseline = results[0];
for (const r of results.slice(1)) {
  const pnlDelta = r.perDay - baseline.perDay;
  const ddDelta = r.maxDD - baseline.maxDD;
  const wrDelta = r.wr - baseline.wr;
  const pctChange = baseline.perDay !== 0 ? (pnlDelta / baseline.perDay) * 100 : 0;
  console.log(`\n${r.label}:`);
  console.log(`  $/day:     $${r.perDay.toFixed(2)} vs $${baseline.perDay.toFixed(2)} (${pnlDelta >= 0 ? "+" : ""}${pnlDelta.toFixed(2)}, ${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%)`);
  console.log(`  MaxDD:     $${r.maxDD.toFixed(0)} vs $${baseline.maxDD.toFixed(0)} (${ddDelta >= 0 ? "+" : ""}$${ddDelta.toFixed(0)})`);
  console.log(`  WR:        ${r.wr.toFixed(1)}% vs ${baseline.wr.toFixed(1)}% (${wrDelta >= 0 ? "+" : ""}${wrDelta.toFixed(1)}pp)`);
  console.log(`  Sharpe:    ${r.sharpe.toFixed(2)} vs ${baseline.sharpe.toFixed(2)}`);
  console.log(`  BE exits:  ${r.beExits} of ${r.trades} trades (${(r.beExits / r.trades * 100).toFixed(1)}%)`);
  console.log(`  Stolen:    ${r.stolenWinners} winners killed ($${r.stolenPnl.toFixed(1)} lost profit)`);
  console.log(`  OOS:       $${r.oosPerDay.toFixed(2)}/day (PF ${r.oosPf.toFixed(2)}) vs $${baseline.oosPerDay.toFixed(2)}/day (PF ${baseline.oosPf.toFixed(2)})`);
}

// Per-engine breakdown for most promising config
console.log("\n" + "=".repeat(120));
console.log("PER-ENGINE BREAKDOWN (baseline vs each config)");
console.log("=".repeat(120));

// Re-run per engine for each config
const engines = ["A", "B", "C", "D"];
const engineNames: Record<string, string> = { A: "Donchian", B: "Supertrend", C: "GARCH v2", D: "Momentum" };

for (const cfg of CONFIGS) {
  console.log(`\n--- ${cfg.label} ---`);
  console.log(`${"Engine".padEnd(14)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(10)} ${"$/day".padStart(8)} ${"PF".padStart(6)} ${"BE exits".padStart(9)} ${"Stolen".padStart(7)}`);

  const accepted = buildAcceptedSet(allSigs, FULL_START, FULL_END);
  for (const eng of engines) {
    const engSigs = accepted.filter(s => s.engine === eng);
    const engResults = engSigs.map(sig => simTradeBreakeven(sig, cfg, baselinePnlMap));

    const wins = engResults.filter(t => t.pnl > 0);
    const losses = engResults.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = engResults.reduce((s, t) => s + t.pnl, 0);
    const wr = engResults.length > 0 ? wins.length / engResults.length * 100 : 0;
    const pf = gl > 0 ? gp / gl : 99;
    const beExits = engResults.filter(t => t.hitBEStop).length;
    const stolen = engResults.filter(t => t.stolenWinner).length;

    console.log(
      `${(engineNames[eng] ?? eng).padEnd(14)} ${String(engResults.length).padStart(7)} ${wr.toFixed(1).padStart(6)}% ${("$" + total.toFixed(1)).padStart(10)} ${("$" + (total / days).toFixed(2)).padStart(8)} ${pf.toFixed(2).padStart(6)} ${String(beExits).padStart(9)} ${String(stolen).padStart(7)}`,
    );
  }
}

// Final verdict
console.log("\n" + "=".repeat(120));
console.log("VERDICT");
console.log("=".repeat(120));

const best = [...results].sort((a, b) => {
  // Score: $/day improvement + DD improvement (weighted)
  const aScore = a.perDay - a.maxDD * 0.01;
  const bScore = b.perDay - b.maxDD * 0.01;
  return bScore - aScore;
})[0];

const bestNonBaseline = [...results.slice(1)].sort((a, b) => {
  const aScore = a.perDay - a.maxDD * 0.01;
  const bScore = b.perDay - b.maxDD * 0.01;
  return bScore - aScore;
})[0];

if (bestNonBaseline && bestNonBaseline.perDay >= baseline.perDay * 0.95 && bestNonBaseline.maxDD < baseline.maxDD) {
  console.log(`RECOMMEND: ${bestNonBaseline.label}`);
  console.log(`  Keeps ${(bestNonBaseline.perDay / baseline.perDay * 100).toFixed(0)}% of profit`);
  console.log(`  MaxDD: $${bestNonBaseline.maxDD.toFixed(0)} vs $${baseline.maxDD.toFixed(0)} (${((1 - bestNonBaseline.maxDD / baseline.maxDD) * 100).toFixed(0)}% reduction)`);
  console.log(`  Stolen winners: ${bestNonBaseline.stolenWinners} (cost $${bestNonBaseline.stolenPnl.toFixed(1)})`);
} else {
  console.log("NO BREAKEVEN CONFIG IMPROVES THE SYSTEM.");
  console.log("The baseline (no breakeven) is already optimal.");
  if (bestNonBaseline) {
    console.log(`  Best BE config: ${bestNonBaseline.label} at $${bestNonBaseline.perDay.toFixed(2)}/day vs $${baseline.perDay.toFixed(2)}/day`);
    console.log(`  Profit lost: ${((1 - bestNonBaseline.perDay / baseline.perDay) * 100).toFixed(1)}%`);
    console.log(`  MaxDD change: $${baseline.maxDD.toFixed(0)} -> $${bestNonBaseline.maxDD.toFixed(0)}`);
  }
}

console.log("\nDone.");
