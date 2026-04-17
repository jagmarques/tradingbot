/**
 * DEFINITIVE BTC Filter Comparison: Daily EMA(20/50) vs 4h EMA(9/21)
 * Full ensemble: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3
 * Shared position pool (max 20), 1m data for SL/TP precision
 * Full period: 2023-01-01 to 2026-03-26 (3.2 years)
 * OOS from 2025-09-01
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-btc-filter-final.ts
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
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

// Half-spreads matching live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = ["OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
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
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) raw1m.set(p, d);
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, DAY, 200)); h4Data.set(p, aggregate(bars, H4, 40)); h1Data.set(p, aggregate(bars, H, 10)); }

// Also aggregate BTC from 5m to 4h for the 4h filter (in case 5m has more coverage)
// And aggregate BTC from 1m to 4h for highest precision
const btc5m = raw5m.get("BTC")!;
const btcDaily = dailyData.get("BTC")!;
const btcH4 = h4Data.get("BTC")!;
const btcH1 = h1Data.get("BTC")!;

// ---- CONFIG A: BTC Daily EMA(20/50) ----
const btcDailyCloses = btcDaily.map(c => c.c);
const btcEma20d = calcEMA(btcDailyCloses, 20);
const btcEma50d = calcEMA(btcDailyCloses, 50);

// FIX: Use strict less-than to exclude incomplete current daily bar (matches live slice(0,-1))
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx - (btcDaily.length - btcEma20d.length);
  const i50 = idx - (btcDaily.length - btcEma50d.length);
  return i20 >= 0 && i50 >= 0 && btcEma20d[i20] > btcEma50d[i50];
}

// ---- CONFIG B: BTC 4h EMA(9/21) ----
const btcH4Closes = btcH4.map(c => c.c);
const btcEma9h4 = calcEMA(btcH4Closes, 9);
const btcEma21h4 = calcEMA(btcH4Closes, 21);

// FIX: Use strict less-than to exclude incomplete 4h bar
function btcH4Bullish(t: number): boolean {
  let idx = -1;
  for (let i = btcH4.length - 1; i >= 0; i--) { if (btcH4[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i9 = idx - (btcH4.length - btcEma9h4.length);
  const i21 = idx - (btcH4.length - btcEma21h4.length);
  return i9 >= 0 && i21 >= 0 && btcEma9h4[i9] > btcEma21h4[i21];
}

// ---- BTC H1 trend for GARCH (unchanged between configs) ----
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

type BtcLongFilter = (t: number) => boolean;

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
        // FIX: Use completed bars only (i-1 vs i-2), enter at bar[i] open
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

function monthlyPnl(trades: Trade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.exitTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    m.set(key, (m.get(key) ?? 0) + t.pnl);
  }
  return m;
}

function quarterlyPnl(trades: Trade[]): Map<string, number> {
  const q = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.exitTime);
    const qNum = Math.ceil((d.getUTCMonth() + 1) / 3);
    const key = `${d.getUTCFullYear()}-Q${qNum}`;
    q.set(key, (q.get(key) ?? 0) + t.pnl);
  }
  return q;
}

// ---- Bootstrap ----
function bootstrap(trades: Trade[], nResamples: number, totalDays: number): { pf5: number; pf50: number; pf95: number; pd5: number; pd50: number; pd95: number } {
  const pfs: number[] = [];
  const pds: number[] = [];
  for (let r = 0; r < nResamples; r++) {
    const sample: Trade[] = [];
    for (let i = 0; i < trades.length; i++) { sample.push(trades[Math.floor(Math.random() * trades.length)]); }
    const gp = sample.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(sample.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    pfs.push(gl > 0 ? gp / gl : 99);
    pds.push(sample.reduce((s, t) => s + t.pnl, 0) / totalDays);
  }
  pfs.sort((a, b) => a - b);
  pds.sort((a, b) => a - b);
  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct / 100)] ?? 0;
  return { pf5: p(pfs, 5), pf50: p(pfs, 50), pf95: p(pfs, 95), pd5: p(pds, 5), pd50: p(pds, 50), pd95: p(pds, 95) };
}

// ---- Walk-forward ----
function walkForward(allSignals: Signal[], totalDays: number): { windows: { start: string; end: string; pnl: number; pf: number; perDay: number }[] } {
  const windowSize = Math.floor(totalDays / 4);
  const windows: { start: string; end: string; pnl: number; pf: number; perDay: number }[] = [];
  for (let w = 0; w < 4; w++) {
    const wStart = FULL_START + w * windowSize * DAY;
    const wEnd = w < 3 ? FULL_START + (w + 1) * windowSize * DAY : FULL_END;
    const wDays = (wEnd - wStart) / DAY;
    const trades = runEnsemble(allSignals, wStart, wEnd);
    const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    windows.push({ start: new Date(wStart).toISOString().slice(0, 10), end: new Date(wEnd).toISOString().slice(0, 10), pnl: trades.reduce((s, t) => s + t.pnl, 0), pf: gl > 0 ? gp / gl : 99, perDay: trades.reduce((s, t) => s + t.pnl, 0) / wDays });
  }
  return { windows };
}


// ====================
//  MAIN
// ====================
console.log(`BTC daily bars: ${btcDaily.length}, BTC 4h bars: ${btcH4.length}, BTC 1h bars: ${btcH1.length}`);
console.log(`Pairs: ${PAIRS.length}, 1m data: ${raw1m.size} pairs, 5m data: ${raw5m.size} pairs`);

const days = (FULL_END - FULL_START) / DAY;
const oosDays = (FULL_END - OOS_START) / DAY;

interface ConfigResult {
  label: string;
  longFilter: BtcLongFilter;
  allSignals: Signal[];
  blockedA: number; blockedB: number; blockedD: number;
  fullTrades: Trade[];
  oosTrades: Trade[];
}

const results: ConfigResult[] = [];

for (const [label, longFilter] of [
  ["CURRENT: Daily EMA(20/50)", btcDailyBullish],
  ["UPGRADE: 4h EMA(9/21)", btcH4Bullish],
] as [string, BtcLongFilter][]) {
  console.log(`\nGenerating signals for ${label}...`);

  const donch = genDonchian(longFilter);
  const st = genSupertrend(longFilter);
  const garchSigs = genGarchV2(); // GARCH uses its own BTC H1 filter, unchanged
  const mom = genMomentumConfirm(longFilter);

  const allSignals = [...donch.signals, ...st.signals, ...garchSigs, ...mom.signals];
  console.log(`  A: ${donch.signals.length} (${donch.blocked} blocked), B: ${st.signals.length} (${st.blocked} blocked), C: ${garchSigs.length}, D: ${mom.signals.length} (${mom.blocked} blocked)`);
  console.log(`  Total: ${allSignals.length} signals`);

  console.log("  Running full ensemble...");
  const fullTrades = runEnsemble(allSignals, FULL_START, FULL_END);
  console.log("  Running OOS ensemble...");
  const oosTrades = runEnsemble(allSignals, OOS_START, FULL_END);

  results.push({ label, longFilter, allSignals, blockedA: donch.blocked, blockedB: st.blocked, blockedD: mom.blocked, fullTrades, oosTrades });
}

// ---- Print comparison ----
console.log("\n" + "=".repeat(120));
console.log("BTC LONG FILTER COMPARISON: Daily EMA(20/50) vs 4h EMA(9/21)");
console.log("Engines: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3 | Pool max 20 | 1m SL/TP precision");
console.log("Full: 2023-01-01 to 2026-03-26 | OOS: 2025-09-01+");
console.log("=".repeat(120));

// Side-by-side summary
console.log("\n--- SIDE-BY-SIDE SUMMARY ---\n");
const hdr = `${"Metric".padEnd(25)} ${"Daily EMA(20/50)".padStart(22)} ${"4h EMA(9/21)".padStart(22)}`;
console.log(hdr);
console.log("-".repeat(72));

const s0 = computeStats(results[0].fullTrades, days);
const s1 = computeStats(results[1].fullTrades, days);
const o0 = computeStats(results[0].oosTrades, oosDays);
const o1 = computeStats(results[1].oosTrades, oosDays);

function fmtRow(label: string, v0: string, v1: string): string { return `${label.padEnd(25)} ${v0.padStart(22)} ${v1.padStart(22)}`; }

console.log(fmtRow("Total Trades", String(s0.trades), String(s1.trades)));
console.log(fmtRow("Longs / Shorts", `${s0.longs} / ${s0.shorts}`, `${s1.longs} / ${s1.shorts}`));
console.log(fmtRow("Win Rate %", s0.wr.toFixed(1)+"%", s1.wr.toFixed(1)+"%"));
console.log(fmtRow("Total P&L", "$"+s0.total.toFixed(2), "$"+s1.total.toFixed(2)));
console.log(fmtRow("$/day", "$"+s0.perDay.toFixed(2), "$"+s1.perDay.toFixed(2)));
console.log(fmtRow("Profit Factor", s0.pf.toFixed(2), s1.pf.toFixed(2)));
console.log(fmtRow("Sharpe", s0.sharpe.toFixed(2), s1.sharpe.toFixed(2)));
console.log(fmtRow("Max Drawdown", "$"+s0.maxDD.toFixed(2), "$"+s1.maxDD.toFixed(2)));
console.log(fmtRow("Longs Blocked (A)", String(results[0].blockedA), String(results[1].blockedA)));
console.log(fmtRow("Longs Blocked (B)", String(results[0].blockedB), String(results[1].blockedB)));
console.log(fmtRow("Longs Blocked (D)", String(results[0].blockedD), String(results[1].blockedD)));
const totalBlocked0 = results[0].blockedA + results[0].blockedB + results[0].blockedD;
const totalBlocked1 = results[1].blockedA + results[1].blockedB + results[1].blockedD;
console.log(fmtRow("Total Longs Blocked", String(totalBlocked0), String(totalBlocked1)));
console.log("-".repeat(72));
console.log(fmtRow("OOS Trades", String(o0.trades), String(o1.trades)));
console.log(fmtRow("OOS $/day", "$"+o0.perDay.toFixed(2), "$"+o1.perDay.toFixed(2)));
console.log(fmtRow("OOS PF", o0.pf.toFixed(2), o1.pf.toFixed(2)));
console.log(fmtRow("OOS WR%", o0.wr.toFixed(1)+"%", o1.wr.toFixed(1)+"%"));
console.log(fmtRow("OOS Sharpe", o0.sharpe.toFixed(2), o1.sharpe.toFixed(2)));
console.log(fmtRow("OOS MaxDD", "$"+o0.maxDD.toFixed(2), "$"+o1.maxDD.toFixed(2)));

// ---- Per-engine breakdown ----
console.log("\n--- PER-ENGINE BREAKDOWN (FULL PERIOD) ---\n");
for (const eng of ["A", "B", "C", "D"]) {
  const name = eng === "A" ? "Donchian" : eng === "B" ? "Supertrend" : eng === "C" ? "GARCH v2" : "Momentum";
  console.log(`Engine ${eng} (${name}):`);
  const t0 = results[0].fullTrades.filter(t => t.engine === eng);
  const t1 = results[1].fullTrades.filter(t => t.engine === eng);
  const es0 = computeStats(t0, days);
  const es1 = computeStats(t1, days);
  console.log(`  ${"".padEnd(20)} ${"Daily EMA(20/50)".padStart(22)} ${"4h EMA(9/21)".padStart(22)}`);
  console.log(`  ${"Trades".padEnd(20)} ${String(es0.trades).padStart(22)} ${String(es1.trades).padStart(22)}`);
  console.log(`  ${"WR%".padEnd(20)} ${(es0.wr.toFixed(1)+"%").padStart(22)} ${(es1.wr.toFixed(1)+"%").padStart(22)}`);
  console.log(`  ${"P&L".padEnd(20)} ${("$"+es0.total.toFixed(2)).padStart(22)} ${("$"+es1.total.toFixed(2)).padStart(22)}`);
  console.log(`  ${"$/day".padEnd(20)} ${("$"+es0.perDay.toFixed(2)).padStart(22)} ${("$"+es1.perDay.toFixed(2)).padStart(22)}`);
  console.log(`  ${"PF".padEnd(20)} ${es0.pf.toFixed(2).padStart(22)} ${es1.pf.toFixed(2).padStart(22)}`);
  console.log(`  ${"MaxDD".padEnd(20)} ${("$"+es0.maxDD.toFixed(2)).padStart(22)} ${("$"+es1.maxDD.toFixed(2)).padStart(22)}`);
  console.log();
}

// ---- Per-engine OOS breakdown ----
console.log("--- PER-ENGINE BREAKDOWN (OOS 2025-09+) ---\n");
for (const eng of ["A", "B", "C", "D"]) {
  const name = eng === "A" ? "Donchian" : eng === "B" ? "Supertrend" : eng === "C" ? "GARCH v2" : "Momentum";
  const t0 = results[0].oosTrades.filter(t => t.engine === eng);
  const t1 = results[1].oosTrades.filter(t => t.engine === eng);
  const es0 = computeStats(t0, oosDays);
  const es1 = computeStats(t1, oosDays);
  console.log(`  ${(eng + " " + name).padEnd(20)} ${String(es0.trades).padStart(4)} trades  $${es0.perDay.toFixed(2)}/d  PF ${es0.pf.toFixed(2)}  |  ${String(es1.trades).padStart(4)} trades  $${es1.perDay.toFixed(2)}/d  PF ${es1.pf.toFixed(2)}`);
}

// ---- Monthly P&L ----
console.log("\n--- MONTHLY P&L ---\n");
const m0 = monthlyPnl(results[0].fullTrades);
const m1 = monthlyPnl(results[1].fullTrades);
const allMonths = new Set([...m0.keys(), ...m1.keys()]);
const sortedMonths = [...allMonths].sort();
console.log(`${"Month".padEnd(10)} ${"Daily(20/50)".padStart(14)} ${"4h(9/21)".padStart(14)} ${"Delta".padStart(12)}`);
console.log("-".repeat(52));
for (const mo of sortedMonths) {
  const v0 = m0.get(mo) ?? 0;
  const v1 = m1.get(mo) ?? 0;
  const delta = v1 - v0;
  const sign0 = v0 >= 0 ? "+" : ""; const sign1 = v1 >= 0 ? "+" : ""; const signD = delta >= 0 ? "+" : "";
  console.log(`${mo.padEnd(10)} ${(sign0+"$"+v0.toFixed(2)).padStart(14)} ${(sign1+"$"+v1.toFixed(2)).padStart(14)} ${(signD+"$"+delta.toFixed(2)).padStart(12)}`);
}

// Count profitable months
const profMonths0 = sortedMonths.filter(mo => (m0.get(mo) ?? 0) > 0).length;
const profMonths1 = sortedMonths.filter(mo => (m1.get(mo) ?? 0) > 0).length;
console.log(`\nProfitable months: ${profMonths0}/${sortedMonths.length} vs ${profMonths1}/${sortedMonths.length}`);

// ---- Quarterly P&L ----
console.log("\n--- QUARTERLY P&L ---\n");
const q0 = quarterlyPnl(results[0].fullTrades);
const q1 = quarterlyPnl(results[1].fullTrades);
const allQ = new Set([...q0.keys(), ...q1.keys()]);
const sortedQ = [...allQ].sort();
console.log(`${"Quarter".padEnd(10)} ${"Daily(20/50)".padStart(14)} ${"4h(9/21)".padStart(14)} ${"Delta".padStart(12)}`);
console.log("-".repeat(52));
for (const q of sortedQ) {
  const v0 = q0.get(q) ?? 0;
  const v1 = q1.get(q) ?? 0;
  const delta = v1 - v0;
  const sign0 = v0 >= 0 ? "+" : ""; const sign1 = v1 >= 0 ? "+" : ""; const signD = delta >= 0 ? "+" : "";
  console.log(`${q.padEnd(10)} ${(sign0+"$"+v0.toFixed(2)).padStart(14)} ${(sign1+"$"+v1.toFixed(2)).padStart(14)} ${(signD+"$"+delta.toFixed(2)).padStart(12)}`);
}

const profQ0 = sortedQ.filter(q => (q0.get(q) ?? 0) > 0).length;
const profQ1 = sortedQ.filter(q => (q1.get(q) ?? 0) > 0).length;
console.log(`\nProfitable quarters: ${profQ0}/${sortedQ.length} vs ${profQ1}/${sortedQ.length}`);

// ---- Bootstrap ----
console.log("\n--- BOOTSTRAP (200 resamples) ---\n");
console.log("Running bootstrap for Daily EMA(20/50)...");
const bs0 = bootstrap(results[0].fullTrades, 200, days);
console.log("Running bootstrap for 4h EMA(9/21)...");
const bs1 = bootstrap(results[1].fullTrades, 200, days);

console.log(`\n${"Percentile".padEnd(15)} ${"Daily(20/50)".padStart(20)} ${"4h(9/21)".padStart(20)}`);
console.log("-".repeat(58));
console.log(`${"PF 5th".padEnd(15)} ${bs0.pf5.toFixed(2).padStart(20)} ${bs1.pf5.toFixed(2).padStart(20)}`);
console.log(`${"PF 50th".padEnd(15)} ${bs0.pf50.toFixed(2).padStart(20)} ${bs1.pf50.toFixed(2).padStart(20)}`);
console.log(`${"PF 95th".padEnd(15)} ${bs0.pf95.toFixed(2).padStart(20)} ${bs1.pf95.toFixed(2).padStart(20)}`);
console.log(`${"$/day 5th".padEnd(15)} ${("$"+bs0.pd5.toFixed(2)).padStart(20)} ${("$"+bs1.pd5.toFixed(2)).padStart(20)}`);
console.log(`${"$/day 50th".padEnd(15)} ${("$"+bs0.pd50.toFixed(2)).padStart(20)} ${("$"+bs1.pd50.toFixed(2)).padStart(20)}`);
console.log(`${"$/day 95th".padEnd(15)} ${("$"+bs0.pd95.toFixed(2)).padStart(20)} ${("$"+bs1.pd95.toFixed(2)).padStart(20)}`);

// ---- Walk-forward ----
console.log("\n--- WALK-FORWARD (4 windows) ---\n");
console.log("Running walk-forward for Daily EMA(20/50)...");
const wf0 = walkForward(results[0].allSignals, days);
console.log("Running walk-forward for 4h EMA(9/21)...");
const wf1 = walkForward(results[1].allSignals, days);

console.log(`\n${"Window".padEnd(5)} ${"Period".padEnd(25)} ${"Daily(20/50)".padStart(20)} ${"".padStart(8)} ${"4h(9/21)".padStart(20)} ${""}`);
console.log(`${"".padEnd(5)} ${"".padEnd(25)} ${"$/day".padStart(10)} ${"PF".padStart(10)} ${"$/day".padStart(10)} ${"PF".padStart(10)}`);
console.log("-".repeat(75));
for (let i = 0; i < 4; i++) {
  const w0 = wf0.windows[i]; const w1 = wf1.windows[i];
  console.log(`${String(i+1).padEnd(5)} ${(w0.start+" - "+w0.end).padEnd(25)} ${("$"+w0.perDay.toFixed(2)).padStart(10)} ${w0.pf.toFixed(2).padStart(10)} ${("$"+w1.perDay.toFixed(2)).padStart(10)} ${w1.pf.toFixed(2).padStart(10)}`);
}
const allProf0 = wf0.windows.filter(w => w.pnl > 0).length;
const allProf1 = wf1.windows.filter(w => w.pnl > 0).length;
console.log(`\nProfitable windows: ${allProf0}/4 vs ${allProf1}/4`);

// ---- FINAL VERDICT ----
console.log("\n" + "=".repeat(120));
console.log("VERDICT");
console.log("=".repeat(120));

const pctPnl = s0.total > 0 ? ((s1.total - s0.total) / s0.total * 100).toFixed(1) : "N/A";
const pctDD = s0.maxDD > 0 ? ((s1.maxDD - s0.maxDD) / s0.maxDD * 100).toFixed(1) : "N/A";

console.log(`\nDaily EMA(20/50):  $${s0.perDay.toFixed(2)}/day  PF ${s0.pf.toFixed(2)}  Sharpe ${s0.sharpe.toFixed(2)}  MaxDD $${s0.maxDD.toFixed(0)}  OOS $${o0.perDay.toFixed(2)}/d`);
console.log(`4h EMA(9/21):      $${s1.perDay.toFixed(2)}/day  PF ${s1.pf.toFixed(2)}  Sharpe ${s1.sharpe.toFixed(2)}  MaxDD $${s1.maxDD.toFixed(0)}  OOS $${o1.perDay.toFixed(2)}/d`);
console.log(`\nDelta: ${pctPnl}% P&L, ${pctDD}% MaxDD`);
console.log(`Bootstrap 5th $/day: $${bs0.pd5.toFixed(2)} vs $${bs1.pd5.toFixed(2)}`);

if (s1.perDay > s0.perDay && s1.maxDD <= s0.maxDD * 1.1 && o1.perDay > o0.perDay) {
  console.log("\n>> 4h EMA(9/21) WINS: higher $/day, comparable DD, better OOS");
} else if (s0.perDay > s1.perDay && s0.maxDD <= s1.maxDD * 1.1 && o0.perDay > o1.perDay) {
  console.log("\n>> Daily EMA(20/50) WINS: higher $/day, comparable DD, better OOS");
} else {
  console.log("\n>> MIXED RESULT: check the detailed tables above for a nuanced decision");
}

console.log("\nDone.");
