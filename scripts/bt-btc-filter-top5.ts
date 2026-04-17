/**
 * Top-5 BTC 4h EMA filter comparison on full 4-engine ensemble.
 * 6 configs: baseline Daily EMA(20/50) + 5 x 4h EMA combos.
 * Independent position pool per config (max 20).
 * Full period 2023-01 to 2026-03, OOS 2025-09+.
 * SMA ATR, proper half-spreads, fix SMA look-ahead, BTC filter < not <=.
 * 1m data for SL/TP precision.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-btc-filter-top5.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M = "/tmp/bt-pair-cache-1m";
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 20;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-28").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Half-spreads matching live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// Only pairs that have BOTH 5m and 1m data
const ALL_PAIRS = ["OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET"];

// ---- Data loading ----
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
  for (const b of bars) { const bucket = Math.floor(b.t / periodMs) * periodMs; let arr = groups.get(bucket); if (!arr) { arr = []; groups.set(bucket, arr); } arr.push(b); }
  const result: C[] = [];
  for (const [ts, grp] of groups) { if (grp.length < minBars) continue; grp.sort((a, b) => a.t - b.t); result.push({ t: ts, o: grp[0].o, h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)), c: grp[grp.length - 1].c }); }
  return result.sort((a, b) => a.t - b.t);
}

// ---- Indicators (SMA ATR, not Wilder's) ----
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) { trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)); }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += trs[j]; atr[i] = s / period; }
  return atr;
}
function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2/(period+1); let init = false;
  for (let i = 0; i < values.length; i++) {
    if (i < period-1) continue;
    if (!init) { let s = 0; for (let j = i-period+1; j <= i; j++) s += values[j]; ema[i] = s/period; init = true; }
    else { ema[i] = values[i]*k + ema[i-1]*(1-k); }
  }
  return ema;
}
function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period-1; i < values.length; i++) { let s = 0; for (let j = i-period+1; j <= i; j++) s += values[j]; out[i] = s/period; }
  return out;
}
function donchCloseLow(cs: C[], idx: number, lb: number): number { let mn = Infinity; for (let i = Math.max(0, idx-lb); i < idx; i++) mn = Math.min(mn, cs[i].c); return mn; }
function donchCloseHigh(cs: C[], idx: number, lb: number): number { let mx = -Infinity; for (let i = Math.max(0, idx-lb); i < idx; i++) mx = Math.max(mx, cs[i].c); return mx; }
function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } {
  const atr = calcATR(cs, p); const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0); const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h+cs[i].l)/2; let u = hl2+m*atr[i]; let l = hl2-m*atr[i];
    if (i > p) { if (!(l > lb[i-1] || cs[i-1].c < lb[i-1])) l = lb[i-1]; if (!(u < ub[i-1] || cs[i-1].c > ub[i-1])) u = ub[i-1]; }
    ub[i] = u; lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i-1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs };
}
function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb+1, volWin+1); i < cs.length; i++) {
    const mom = cs[i].c/cs[i-momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i-volWin); j <= i; j++) { const r = cs[j].c/cs[j-1].c - 1; sumSq += r*r; count++; }
    if (count < 10) continue; const vol = Math.sqrt(sumSq/count); if (vol === 0) continue; z[i] = mom/vol;
  }
  return z;
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw*(1+sp) : raw*(1-sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp*SL_SLIP : sp; return dir === "long" ? raw*(1-slip) : raw*(1+slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number { return (dir === "long" ? (xp/ep-1)*notional : (ep/xp-1)*notional) - notional*FEE*2; }

// ---- Load all data ----
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...ALL_PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...ALL_PAIRS]) { const d = loadJson(CD_1M, p); if (d.length > 0) raw1m.set(p, d); }

// Filter to only pairs with BOTH 5m and 1m data
const PAIRS = ALL_PAIRS.filter(p => raw5m.has(p) && raw1m.has(p));
console.log(`Pairs with both 5m+1m: ${PAIRS.length} -> ${PAIRS.join(", ")}`);

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, DAY, 200)); h4Data.set(p, aggregate(bars, H4, 40)); h1Data.set(p, aggregate(bars, H, 10)); }

const btcDaily = dailyData.get("BTC")!;
const btcH4 = h4Data.get("BTC")!;
const btcH1 = h1Data.get("BTC")!;

// ---- BTC EMA arrays ----
const btcDailyCloses = btcDaily.map(c => c.c);
const btcH4Closes = btcH4.map(c => c.c);

// Pre-compute all needed EMAs for BTC
const btcEma20d = calcEMA(btcDailyCloses, 20);
const btcEma50d = calcEMA(btcDailyCloses, 50);

// 4h EMAs
const btcEma5h4  = calcEMA(btcH4Closes, 5);
const btcEma9h4  = calcEMA(btcH4Closes, 9);
const btcEma12h4 = calcEMA(btcH4Closes, 12);
const btcEma15h4 = calcEMA(btcH4Closes, 15);
const btcEma21h4 = calcEMA(btcH4Closes, 21);
const btcEma30h4 = calcEMA(btcH4Closes, 30);

// ---- BTC filter functions (strict < to exclude incomplete bar) ----
type BtcLongFilter = (t: number) => boolean;

function makeDailyFilter(fast: number[], slow: number[]): BtcLongFilter {
  return (t: number) => {
    let idx = -1;
    for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
    if (idx < 0) return false;
    const iF = idx - (btcDaily.length - fast.length);
    const iS = idx - (btcDaily.length - slow.length);
    return iF >= 0 && iS >= 0 && fast[iF] > slow[iS];
  };
}

function make4hFilter(fast: number[], slow: number[]): BtcLongFilter {
  return (t: number) => {
    let idx = -1;
    for (let i = btcH4.length - 1; i >= 0; i--) { if (btcH4[i].t < t) { idx = i; break; } }
    if (idx < 0) return false;
    const iF = idx - (btcH4.length - fast.length);
    const iS = idx - (btcH4.length - slow.length);
    return iF >= 0 && iS >= 0 && fast[iF] > slow[iS];
  };
}

// BTC H1 trend for GARCH (unchanged between configs)
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t/H)*H;
  let idx = btcH1TsMap.get(bucket);
  if (idx === undefined) { for (let i = btcH1.length-1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } } }
  if (idx === undefined || idx < 1) return null;
  const prev = idx-1;
  const off9 = btcH1.length - btcH1Ema9.length;
  const off21 = btcH1.length - btcH1Ema21.length;
  const i9 = prev - off9; const i21 = prev - off21;
  if (i9 < 0 || i21 < 0) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

// ---- Signal types ----
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
}

// ---- Engine A: Donchian Daily SMA(20/50) ----
function genDonchian(longFilter: BtcLongFilter): { signals: Signal[]; blocked: number } {
  const sigs: Signal[] = [];
  let blocked = 0;
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c); const fast = calcSMA(closes, 20); const slow = calcSMA(closes, 50); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) {
          if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "ch"; } }
          else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } }
        }
        if (!xp && Math.round((bar.t - pos.et) / DAY) >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "A", size: 7, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos) {
        const p = i-1; const pp = i-2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long"; else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        if (dir === "long" && !longFilter(bar.t)) { blocked++; continue; }
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return { signals: sigs, blocked };
}

// ---- Engine B: Supertrend 4h(14, 1.75) ----
function genSupertrend(longFilter: BtcLongFilter): { signals: Signal[]; blocked: number } {
  const sigs: Signal[] = [];
  let blocked = 0;
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 50) continue;
    const { dir: stDir } = calcSupertrend(cs, 14, 1.75); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 17; i < cs.length; i++) {
      const bar = cs[i]; const flip = stDir[i-1] !== stDir[i-2];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t - pos.et) / H >= 60*24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "B", size: 5, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        if (dir === "long" && !longFilter(bar.t)) { blocked++; continue; }
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return { signals: sigs, blocked };
}

// ---- Engine C: GARCH v2 (7% TP, 3% SL, 96h hold) ----
function genGarchV2(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair); const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;
    const z1h = computeZScores(h1, 3, 20); const z4h = computeZScores(h4, 3, 20);
    const h1Closes = h1.map(c => c.c); const ema9 = calcEMA(h1Closes, 9); const ema21 = calcEMA(h1Closes, 21);
    const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));
    let pos: any = null;
    for (let i = Math.max(23, 22); i < h1.length; i++) {
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
        if (!xp && (bar.t - pos.et)/H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "C", size: 3, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i-1; if (prev < 23) continue;
        const z1 = z1h[prev]; if (isNaN(z1) || z1 === 0) continue;
        const goLong = z1 > 4.5; const goShort = z1 < -3.0;
        if (!goLong && !goShort) continue;
        const ts4h = Math.floor(h1[prev].t/H4)*H4; const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < 23) continue;
        const z4 = z4h[idx4h]; if (goLong && z4 <= 3.0) continue; if (goShort && z4 >= -3.0) continue;
        const off9 = h1.length - ema9.length; const off21 = h1.length - ema21.length;
        const i9 = prev - off9; const i21 = prev - off21;
        if (i9 < 0 || i21 < 0) continue;
        if (goLong && ema9[i9] <= ema21[i21]) continue; if (goShort && ema9[i9] >= ema21[i21]) continue;
        const btcT = btcH1Trend(h1[prev].t); if (goLong && btcT !== "long") continue; if (goShort && btcT !== "short") continue;
        const dir: "long"|"short" = goLong ? "long" : "short";
        let sl = dir === "long" ? bar.o*(1-0.03) : bar.o*(1+0.03);
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ---- Engine D: Momentum Confirm ----
function genMomentumConfirm(longFilter: BtcLongFilter): { signals: Signal[]; blocked: number } {
  const sigs: Signal[] = [];
  let blocked = 0;
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 55) continue;
    const completed = cs;
    let pos: any = null;
    for (let i = 52; i < completed.length; i++) {
      const bar = completed[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && (bar.t - pos.et)/H >= 48) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "D", size: 3, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        const ranges: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) ranges.push(completed[j].h - completed[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s,v)=>s+v,0)/ranges.length;
        const rStd = Math.sqrt(ranges.reduce((s,v)=>s+(v-rMean)**2,0)/ranges.length);
        const volZ = rStd > 0 ? (ranges[ranges.length-1] - rMean)/rStd : 0;

        const fp: number[] = []; for (let j = Math.max(0, prev-50); j <= prev; j++) fp.push((completed[j].c - completed[j].o)/completed[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s,v)=>s+v,0)/fp.length;
        const fpStd = Math.sqrt(fp.reduce((s,v)=>s+(v-fpMean)**2,0)/fp.length);
        const fundZ = fpStd > 0 ? (fp[fp.length-1] - fpMean)/fpStd : 0;

        const closes: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) closes.push(completed[j].c); }
        if (closes.length < 20) continue;
        const cMean = closes.reduce((s,v)=>s+v,0)/closes.length;
        const cStd = Math.sqrt(closes.reduce((s,v)=>s+(v-cMean)**2,0)/closes.length);
        const priceZ = cStd > 0 ? (closes[closes.length-1] - cMean)/cStd : 0;

        let dir: "long"|"short"|null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) {
          if (longFilter(bar.t)) dir = "long"; else blocked++;
        } else if (volZ > 2 && fundZ < -2 && priceZ < -1) {
          dir = "short";
        }
        if (!dir) continue;

        let sl = dir === "long" ? bar.o*(1-0.03) : bar.o*(1+0.03);
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return { signals: sigs, blocked };
}

// ---- 1m precision trade simulation ----
function simTrade(sig: Signal): { pnl: number; reason: string; exitTime: number } {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime };
  }

  // Binary search for start
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; } }

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    // SL
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }

    // GARCH TP 7%
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t };
      }
    }
  }

  // Engine exit
  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime };
}

// ---- Ensemble pool simulation ----
interface Trade { pnl: number; reason: string; exitTime: number; entryTime: number; engine: string; pair: string; dir: "long"|"short" }

function runEnsemble(allSignals: Signal[], startTs: number, endTs: number): Trade[] {
  // Step 1: Simulate all trades to get accurate exit times
  const processed = allSignals.map(sig => {
    const result = simTrade(sig);
    return { ...sig, adjExitTime: result.exitTime };
  });

  // Step 2: Pool scheduling (max 20)
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
  const accepted = new Set<number>();
  for (const evt of events) {
    const key = `${evt.engine}:${evt.pair}`;
    if (evt.type === "exit") { openPos.delete(key); }
    else {
      if (openPos.has(key)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(key, evt.idx);
      accepted.add(evt.idx);
    }
  }

  // Step 3: Build trade results
  const trades: Trade[] = [];
  for (const idx of accepted) {
    const sig = allSignals[idx];
    const result = simTrade(sig);
    trades.push({ pnl: result.pnl, reason: result.reason, exitTime: result.exitTime, entryTime: sig.entryTime, engine: sig.engine, pair: sig.pair, dir: sig.dir });
  }
  return trades;
}

// ---- Stats helpers ----
function computeStats(trades: Trade[], totalDays: number) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const dayPnl = new Map<number, number>();
  for (const t of trades) { const d = Math.floor(t.exitTime / DAY); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return { trades: trades.length, wr: trades.length > 0 ? wins.length / trades.length * 100 : 0, pf: gl > 0 ? gp / gl : 99, total, perDay: total / totalDays, maxDD, sharpe, longs: trades.filter(t => t.dir === "long").length, shorts: trades.filter(t => t.dir === "short").length };
}

// ---- Bootstrap ----
function bootstrap(trades: Trade[], nResamples: number, totalDays: number): { pd5: number; pd50: number } {
  const pds: number[] = [];
  for (let r = 0; r < nResamples; r++) {
    const sample: Trade[] = [];
    for (let i = 0; i < trades.length; i++) { sample.push(trades[Math.floor(Math.random() * trades.length)]); }
    pds.push(sample.reduce((s, t) => s + t.pnl, 0) / totalDays);
  }
  pds.sort((a, b) => a - b);
  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct / 100)] ?? 0;
  return { pd5: p(pds, 5), pd50: p(pds, 50) };
}

// ====================
//  CONFIGS
// ====================
interface FilterConfig {
  label: string;
  longFilter: BtcLongFilter;
}

const CONFIGS: FilterConfig[] = [
  { label: "Daily EMA(20/50) [BASELINE]", longFilter: makeDailyFilter(btcEma20d, btcEma50d) },
  { label: "4h EMA(5/21)",               longFilter: make4hFilter(btcEma5h4, btcEma21h4) },
  { label: "4h EMA(5/30)",               longFilter: make4hFilter(btcEma5h4, btcEma30h4) },
  { label: "4h EMA(9/21)",               longFilter: make4hFilter(btcEma9h4, btcEma21h4) },
  { label: "4h EMA(12/21)",              longFilter: make4hFilter(btcEma12h4, btcEma21h4) },
  { label: "4h EMA(15/30)",              longFilter: make4hFilter(btcEma15h4, btcEma30h4) },
];

// ====================
//  MAIN
// ====================
console.log(`BTC daily bars: ${btcDaily.length}, BTC 4h bars: ${btcH4.length}, BTC 1h bars: ${btcH1.length}`);
console.log(`Pairs: ${PAIRS.length}, 1m data: ${raw1m.size} pairs, 5m data: ${raw5m.size} pairs`);

const days = (FULL_END - FULL_START) / DAY;
const oosDays = (FULL_END - OOS_START) / DAY;

// GARCH signals are independent of BTC long filter -- generate once
console.log("\nGenerating GARCH v2 signals (shared across configs)...");
const garchSigs = genGarchV2();
console.log(`  GARCH v2: ${garchSigs.length} signals`);

interface ConfigResult {
  label: string;
  fullTrades: Trade[];
  oosTrades: Trade[];
  fullStats: ReturnType<typeof computeStats>;
  oosStats: ReturnType<typeof computeStats>;
  bs: { pd5: number; pd50: number };
  blockedTotal: number;
  sigCount: number;
}

const results: ConfigResult[] = [];

for (const cfg of CONFIGS) {
  console.log(`\nConfig: ${cfg.label}`);

  const donch = genDonchian(cfg.longFilter);
  const st = genSupertrend(cfg.longFilter);
  const mom = genMomentumConfirm(cfg.longFilter);

  const allSignals = [...donch.signals, ...st.signals, ...garchSigs, ...mom.signals];
  const blockedTotal = donch.blocked + st.blocked + mom.blocked;
  console.log(`  A:${donch.signals.length}(${donch.blocked}blk) B:${st.signals.length}(${st.blocked}blk) C:${garchSigs.length} D:${mom.signals.length}(${mom.blocked}blk) | Total:${allSignals.length} | Blocked:${blockedTotal}`);

  console.log("  Running ensemble (full + OOS)...");
  const fullTrades = runEnsemble(allSignals, FULL_START, FULL_END);
  const oosTrades = runEnsemble(allSignals, OOS_START, FULL_END);

  const fullStats = computeStats(fullTrades, days);
  const oosStats = computeStats(oosTrades, oosDays);

  console.log("  Bootstrap 200...");
  const bs = bootstrap(fullTrades, 200, days);

  results.push({ label: cfg.label, fullTrades, oosTrades, fullStats, oosStats, bs, blockedTotal, sigCount: allSignals.length });
}

// ====================
//  COMPARISON TABLE
// ====================
console.log("\n" + "=".repeat(160));
console.log("BTC LONG FILTER COMPARISON: 6 configs on full 4-engine ensemble");
console.log("Engines: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3 | Pool max 20 | 1m SL/TP precision");
console.log(`Full: 2023-01-01 to 2026-03-28 (${days.toFixed(0)}d) | OOS: 2025-09-01+ (${oosDays.toFixed(0)}d) | Pairs: ${PAIRS.length}`);
console.log("=".repeat(160));

// Sort by full $/day descending
const sorted = [...results].sort((a, b) => b.fullStats.perDay - a.fullStats.perDay);

console.log("\n--- MAIN COMPARISON (sorted by $/day) ---\n");
const col = {
  label: 30, trades: 7, wr: 7, pnl: 11, pd: 9, pf: 7, sharpe: 8, dd: 9, oospd: 10, oospf: 8, bs5: 10,
};
const hdr = [
  "Config".padEnd(col.label),
  "Trades".padStart(col.trades),
  "WR%".padStart(col.wr),
  "Total P&L".padStart(col.pnl),
  "$/day".padStart(col.pd),
  "PF".padStart(col.pf),
  "Sharpe".padStart(col.sharpe),
  "MaxDD".padStart(col.dd),
  "OOS $/d".padStart(col.oospd),
  "OOS PF".padStart(col.oospf),
  "BS5 $/d".padStart(col.bs5),
].join("  ");
console.log(hdr);
console.log("-".repeat(hdr.length));

for (let rank = 0; rank < sorted.length; rank++) {
  const r = sorted[rank];
  const s = r.fullStats;
  const o = r.oosStats;
  const isWinner = rank === 0;
  const prefix = isWinner ? ">>> " : "    ";
  const suffix = isWinner ? " <<<" : "";
  const line = [
    (prefix + r.label + suffix).padEnd(col.label),
    String(s.trades).padStart(col.trades),
    (s.wr.toFixed(1)+"%").padStart(col.wr),
    ("$"+s.total.toFixed(2)).padStart(col.pnl),
    ("$"+s.perDay.toFixed(2)).padStart(col.pd),
    s.pf.toFixed(2).padStart(col.pf),
    s.sharpe.toFixed(2).padStart(col.sharpe),
    ("$"+s.maxDD.toFixed(2)).padStart(col.dd),
    ("$"+o.perDay.toFixed(2)).padStart(col.oospd),
    o.pf.toFixed(2).padStart(col.oospf),
    ("$"+r.bs.pd5.toFixed(2)).padStart(col.bs5),
  ].join("  ");
  console.log(line);
}

// ---- Per-engine breakdown for top 3 ----
console.log("\n--- PER-ENGINE BREAKDOWN (top 3 configs, full period) ---\n");
for (let rank = 0; rank < Math.min(3, sorted.length); rank++) {
  const r = sorted[rank];
  console.log(`#${rank+1} ${r.label}:`);
  for (const eng of ["A", "B", "C", "D"]) {
    const name = eng === "A" ? "Donchian" : eng === "B" ? "Supertrend" : eng === "C" ? "GARCH v2" : "Momentum";
    const t = r.fullTrades.filter(tr => tr.engine === eng);
    const es = computeStats(t, days);
    const oosT = r.oosTrades.filter(tr => tr.engine === eng);
    const oosEs = computeStats(oosT, oosDays);
    console.log(`  ${(eng+" "+name).padEnd(16)} ${String(es.trades).padStart(4)} trades  WR ${es.wr.toFixed(1)}%  $${es.total.toFixed(2).padStart(8)}  $${es.perDay.toFixed(2)}/d  PF ${es.pf.toFixed(2)}  DD $${es.maxDD.toFixed(2)}  | OOS $${oosEs.perDay.toFixed(2)}/d PF ${oosEs.pf.toFixed(2)}`);
  }
  console.log();
}

// ---- OOS detail for all configs ----
console.log("--- OOS BREAKDOWN (2025-09+) ---\n");
const oosHdr = [
  "Config".padEnd(col.label),
  "Trades".padStart(col.trades),
  "WR%".padStart(col.wr),
  "$/day".padStart(col.pd),
  "PF".padStart(col.pf),
  "Sharpe".padStart(col.sharpe),
  "MaxDD".padStart(col.dd),
].join("  ");
console.log(oosHdr);
console.log("-".repeat(oosHdr.length));
for (const r of sorted) {
  const o = r.oosStats;
  console.log([
    r.label.padEnd(col.label),
    String(o.trades).padStart(col.trades),
    (o.wr.toFixed(1)+"%").padStart(col.wr),
    ("$"+o.perDay.toFixed(2)).padStart(col.pd),
    o.pf.toFixed(2).padStart(col.pf),
    o.sharpe.toFixed(2).padStart(col.sharpe),
    ("$"+o.maxDD.toFixed(2)).padStart(col.dd),
  ].join("  "));
}

// ---- Bootstrap detail ----
console.log("\n--- BOOTSTRAP 200 (5th / 50th percentile $/day) ---\n");
for (const r of sorted) {
  console.log(`  ${r.label.padEnd(30)}  5th: $${r.bs.pd5.toFixed(2).padStart(6)}  50th: $${r.bs.pd50.toFixed(2).padStart(6)}`);
}

// ---- VERDICT ----
console.log("\n" + "=".repeat(160));
console.log("VERDICT");
console.log("=".repeat(160));

const winner = sorted[0];
const baseline = results[0]; // Daily EMA(20/50) is always index 0

console.log(`\nWINNER: ${winner.label}`);
console.log(`  $/day: $${winner.fullStats.perDay.toFixed(2)} (baseline $${baseline.fullStats.perDay.toFixed(2)})`);
console.log(`  PF: ${winner.fullStats.pf.toFixed(2)} (baseline ${baseline.fullStats.pf.toFixed(2)})`);
console.log(`  MaxDD: $${winner.fullStats.maxDD.toFixed(2)} (baseline $${baseline.fullStats.maxDD.toFixed(2)})`);
console.log(`  OOS $/day: $${winner.oosStats.perDay.toFixed(2)} (baseline $${baseline.oosStats.perDay.toFixed(2)})`);
console.log(`  OOS PF: ${winner.oosStats.pf.toFixed(2)} (baseline ${baseline.oosStats.pf.toFixed(2)})`);
console.log(`  Bootstrap 5th $/day: $${winner.bs.pd5.toFixed(2)} (baseline $${baseline.bs.pd5.toFixed(2)})`);

if (winner.label !== baseline.label) {
  const pctPnl = baseline.fullStats.total > 0 ? ((winner.fullStats.total - baseline.fullStats.total) / baseline.fullStats.total * 100).toFixed(1) : "N/A";
  const pctDD = baseline.fullStats.maxDD > 0 ? ((winner.fullStats.maxDD - baseline.fullStats.maxDD) / baseline.fullStats.maxDD * 100).toFixed(1) : "N/A";
  console.log(`\n  vs Baseline: ${pctPnl}% P&L change, ${pctDD}% MaxDD change`);
}

console.log("\nDone.");
