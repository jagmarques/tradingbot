/**
 * RIGOROUS pullback exit validation.
 *
 * Uses the EXACT same engine logic as bt-trail-full-ensemble.ts:
 *   4 engines: Donchian SMA(20/50) $7, Supertrend(14,1.75) $5, GARCH v2 $3, Momentum $3
 *   23 pairs (all that have both 5m and 1m data)
 *   SMA ATR (not Wilder's), proper half-spreads, BTC filter < not <=
 *   Position pool max 20
 *
 * FAIR COMPARISON: builds the accepted trade set from the NO-overlay pool,
 * then applies pullback exit to the SAME trades using 1m bars.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && \
 *      NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-pullback-exit-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants (matching bt-trail-full-ensemble.ts exactly) ──────────
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

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// 23 pairs (must have both 5m and 1m data)
const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX",
  "NEAR", "SUI", "FET",
];

// ─── Data helpers (identical to trail script) ────────────────────────
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

// SMA ATR (not Wilder's) - matches live indicators.ts
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) { trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)); }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += trs[j]; atr[i] = s / period; }
  return atr;
}

function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2/(period+1);
  let init = false;
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
  const atr = calcATR(cs, p);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h+cs[i].l)/2;
    let u = hl2+m*atr[i]; let l = hl2-m*atr[i];
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
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq/count);
    if (vol === 0) continue;
    z[i] = mom/vol;
  }
  return z;
}

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw*(1+sp) : raw*(1-sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp*SL_SLIP : sp; return dir === "long" ? raw*(1-slip) : raw*(1+slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, not: number): number { return (dir === "long" ? (xp/ep-1)*not : (ep/xp-1)*not) - not*FEE*2; }

// ─── Load all data ──────────────────────────────────────────────────
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); console.log(`  1m: ${p} ${d.length} bars`); }
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); h4Data.set(p, aggregate(bars, H4, 40)); h1Data.set(p, aggregate(bars, H, 10)); }

// BTC filters (identical to trail script)
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length-1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } }
  if (idx < 0) return false;
  const i20 = idx-(btcDaily.length-btcEma20.length);
  const i50 = idx-(btcDaily.length-btcEma50.length);
  return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50];
}

const btcH1 = h1Data.get("BTC")!;
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
  const off9 = btcH1.length-btcH1Ema9.length;
  const off21 = btcH1.length-btcH1Ema21.length;
  const i9 = prev-off9;
  const i21 = prev-off21;
  if (i9 < 0 || i21 < 0) return null;
  if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long";
  if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short";
  return null;
}

console.log("Loaded.\n");

// ─── Signal type ─────────────────────────────────────────────────────
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
}

// ─── Engine A: Donchian (identical to trail script) ──────────────────
function genDonchian(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c); const fast = calcSMA(closes, 20); const slow = calcSMA(closes, 50); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = ""; const hd = Math.round((bar.t-pos.et)/D);
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) { if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "ch"; } } else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } } }
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "A", size: 7, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos) {
        const p = i-1; const pp = i-2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long"; else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue; if (dir === "long" && !btcDailyBullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Engine B: Supertrend (identical to trail script) ────────────────
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
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && flip) { xp = bar.o; reason = "flip"; }
        if (!xp && (bar.t-pos.et)/H >= 60*24) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "B", size: 5, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
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

// ─── Engine C: GARCH v2 (identical to trail script) ──────────────────
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
        if (!xp && (bar.t-pos.et)/H >= 96) { xp = bar.c; reason = "mh"; }
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
        const off9 = h1.length-ema9.length; const off21 = h1.length-ema21.length;
        const i9 = prev-off9; const i21 = prev-off21;
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

// ─── Engine D: Momentum Confirm (identical to trail script) ──────────
function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
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
        if (!xp && (bar.t-pos.et)/H >= 48) { xp = bar.c; reason = "mh"; }
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
        if (volZ > 2 && fundZ > 2 && priceZ > 1) { if (btcDailyBullish(bar.t)) dir = "long"; }
        else if (volZ > 2 && fundZ < -2 && priceZ < -1) { dir = "short"; }
        if (!dir) continue;
        let sl = dir === "long" ? bar.o*(1-0.03) : bar.o*(1+0.03);
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// ─── Simulate a trade walking 1m bars ────────────────────────────────
// This handles native exits (SL, engine exits) on 1m resolution.
// pullbackDepth = X (exit if leveraged PnL drops X% from peak)
// minPeak = Y (only activate pullback exit after peak >= Y%)
// Returns exact exit info.
interface TradeResult {
  pnl: number;
  reason: string;
  exitTime: number;
  peakLevPct: number;
  exitLevPct: number;
  // For "correct/wrong" analysis: what happened in the 24h after exit?
  postExitMinPct: number; // lowest leveraged % within 24h after exit
  postExitMaxPct: number; // highest leveraged % within 24h after exit
}

function simTradeWithPullback(
  sig: Signal,
  pullbackDepth: number, // X: pullback trigger (0 = disabled)
  minPeak: number,       // Y: minimum peak required before pullback exit activates
): TradeResult {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  // Fallback: no 1m data, use engine exit directly
  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    const pnl = calcPnl(sig.dir, ep, xp, NOT);
    return { pnl, reason: sig.exitReason, exitTime: sig.exitTime, peakLevPct: 0, exitLevPct: pnl/NOT*100, postExitMinPct: 0, postExitMaxPct: 0 };
  }

  // Binary search for start index
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; } }

  let peakLevPct = 0;
  let exitIdx = -1;

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break; // engine exit time reached

    // 1) SL check (highest priority)
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOT);
      exitIdx = i;
      const post = measurePostExit(bars1m, i, sig.dir, sig.entryPrice);
      return { pnl, reason: "sl", exitTime: b.t, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      const pnl = calcPnl(sig.dir, ep, xp, NOT);
      exitIdx = i;
      const post = measurePostExit(bars1m, i, sig.dir, sig.entryPrice);
      return { pnl, reason: "sl", exitTime: b.t, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
    }

    // 2) GARCH v2 TP check (7%)
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        const pnl = calcPnl(sig.dir, ep, xp, NOT);
        exitIdx = i;
        const post = measurePostExit(bars1m, i, sig.dir, sig.entryPrice);
        return { pnl, reason: "tp", exitTime: b.t, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        const pnl = calcPnl(sig.dir, ep, xp, NOT);
        exitIdx = i;
        const post = measurePostExit(bars1m, i, sig.dir, sig.entryPrice);
        return { pnl, reason: "tp", exitTime: b.t, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
      }
    }

    // 3) Track peak using best intrabar price
    const bestPct = sig.dir === "long"
      ? (b.h/sig.entryPrice - 1)*LEV*100
      : (sig.entryPrice/b.l - 1)*LEV*100;
    if (bestPct > peakLevPct) peakLevPct = bestPct;

    // 4) Pullback exit check (on bar close, AFTER peak update on this bar)
    if (pullbackDepth > 0 && peakLevPct >= minPeak) {
      const currPct = sig.dir === "long"
        ? (b.c/sig.entryPrice - 1)*LEV*100
        : (sig.entryPrice/b.c - 1)*LEV*100;
      if (currPct <= peakLevPct - pullbackDepth) {
        // Pullback exit fires: exit at bar close with spread + fee (signal exit, not SL)
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        const pnl = calcPnl(sig.dir, ep, xp, NOT);
        exitIdx = i;
        const post = measurePostExit(bars1m, i, sig.dir, sig.entryPrice);
        return { pnl, reason: "pullback", exitTime: b.t, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
      }
    }
  }

  // Engine exit (no pullback triggered before native exit)
  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  const pnl = calcPnl(sig.dir, ep, xp, NOT);
  // For post-exit analysis of engine exits, find the bar at exit time
  let engExitIdx = startIdx;
  for (let i = startIdx; i < bars1m.length; i++) { if (bars1m[i].t >= sig.exitTime) { engExitIdx = i; break; } }
  const post = measurePostExit(bars1m, engExitIdx, sig.dir, sig.entryPrice);
  return { pnl, reason: sig.exitReason, exitTime: sig.exitTime, peakLevPct, exitLevPct: pnl/NOT*100, ...post };
}

// Measure what happens in the 24h after exit (for correct/wrong analysis)
function measurePostExit(bars1m: C[], exitIdx: number, dir: "long"|"short", entryPrice: number): { postExitMinPct: number; postExitMaxPct: number } {
  let minPct = Infinity, maxPct = -Infinity;
  const endTime = bars1m[exitIdx]?.t ?? 0;
  const limit = endTime + 24 * H;
  for (let i = exitIdx + 1; i < bars1m.length && bars1m[i].t <= limit; i++) {
    const b = bars1m[i];
    const pctHi = dir === "long" ? (b.h/entryPrice - 1)*LEV*100 : (entryPrice/b.l - 1)*LEV*100;
    const pctLo = dir === "long" ? (b.l/entryPrice - 1)*LEV*100 : (entryPrice/b.h - 1)*LEV*100;
    if (pctLo < minPct) minPct = pctLo;
    if (pctHi > maxPct) maxPct = pctHi;
  }
  if (minPct === Infinity) { minPct = 0; maxPct = 0; }
  return { postExitMinPct: minPct, postExitMaxPct: maxPct };
}

// ─── FAIR COMPARISON: Build trade set from NO-PULLBACK pool ──────────
// Step 1: Generate all signals
console.log("Generating signals from all 4 engines...");
const donchSigs = genDonchian();
const stSigs = genSupertrend();
const garchSigs = genGarchV2();
const momSigs = genMomentumConfirm();
const allSigs = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];
console.log(`  A (Donchian): ${donchSigs.length}, B (Supertrend): ${stSigs.length}, C (GARCH v2): ${garchSigs.length}, D (Momentum): ${momSigs.length}`);
console.log(`  Total: ${allSigs.length} signals\n`);

// Step 2: Build the accepted trade set using NO pullback overlay (position pool max 20)
function buildAcceptedSet(signals: Signal[], startTs: number, endTs: number): Signal[] {
  // First sim each trade with NO overlay to get realistic exit times
  const processed = signals.map(sig => {
    const result = simTradeWithPullback(sig, 0, 0);
    return { sig, adjExitTime: result.exitTime };
  });

  interface Event { t: number; type: "entry"|"exit"; idx: number; engine: string; pair: string }
  const events: Event[] = [];
  for (let idx = 0; idx < processed.length; idx++) {
    const s = processed[idx].sig;
    if (s.entryTime < startTs || s.entryTime >= endTs) continue;
    events.push({ t: s.entryTime, type: "entry", idx, engine: s.engine, pair: s.pair });
    events.push({ t: processed[idx].adjExitTime, type: "exit", idx, engine: s.engine, pair: s.pair });
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
      accepted.push(signals[evt.idx]);
    }
  }
  return accepted;
}

console.log("Building accepted trade set (no overlay, position pool max 20)...");
const fullAccepted = buildAcceptedSet(allSigs, FULL_START, FULL_END);
const oosAccepted = buildAcceptedSet(allSigs, OOS_START, FULL_END);
console.log(`  Full period: ${fullAccepted.length} accepted trades`);
console.log(`  OOS period: ${oosAccepted.length} accepted trades\n`);

// ─── Run baseline (no pullback) ──────────────────────────────────────
console.log("Running baseline (no pullback exit)...");
const baselineResults = fullAccepted.map(sig => simTradeWithPullback(sig, 0, 0));
const oosBaselineResults = oosAccepted.map(sig => simTradeWithPullback(sig, 0, 0));

function calcStats(results: TradeResult[], dayCount: number): {
  trades: number; wins: number; wr: number; total: number; perDay: number;
  pf: number; sharpe: number; maxDD: number;
} {
  const trades = results.length;
  const wins = results.filter(r => r.pnl > 0).length;
  const gp = results.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
  const gl = Math.abs(results.filter(r => r.pnl <= 0).reduce((s, r) => s + r.pnl, 0));
  const total = results.reduce((s, r) => s + r.pnl, 0);
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...results].sort((a, b) => a.exitTime - b.exitTime);
  for (const r of sorted) { cum += r.pnl; if (cum > peak) peak = cum; if (peak-cum > maxDD) maxDD = peak-cum; }
  const dayPnl = new Map<number, number>();
  for (const r of sorted) { const d = Math.floor(r.exitTime/D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + r.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0)/rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r-mean)**2, 0)/(rets.length-1)) : 0;
  const sharpe = std > 0 ? (mean/std)*Math.sqrt(252) : 0;
  return { trades, wins, wr: trades > 0 ? wins/trades*100 : 0, total, perDay: total/dayCount, pf: gl > 0 ? gp/gl : 99, sharpe, maxDD };
}

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;
const baseline = calcStats(baselineResults, fullDays);
const oosBaseline = calcStats(oosBaselineResults, oosDays);

console.log(`  Baseline: ${baseline.trades} trades, WR ${baseline.wr.toFixed(1)}%, $${baseline.total.toFixed(2)} total, $${baseline.perDay.toFixed(2)}/day, PF ${baseline.pf.toFixed(2)}, Sharpe ${baseline.sharpe.toFixed(2)}, MaxDD $${baseline.maxDD.toFixed(0)}`);
console.log(`  OOS Baseline: $${oosBaseline.perDay.toFixed(2)}/day, PF ${oosBaseline.pf.toFixed(2)}\n`);

// ─── Sweep pullback configs ──────────────────────────────────────────
const PULLBACK_DEPTHS = [10, 15, 20, 25, 30]; // X
const MIN_PEAKS = [0, 10, 20, 30, 40];         // Y

interface SweepResult {
  depth: number; minPeak: number;
  trades: number; wr: number; total: number; perDay: number; pf: number;
  sharpe: number; maxDD: number; oosPerDay: number; oosPf: number;
  pullbackExits: number; correctExits: number; wrongExits: number;
}

const sweepResults: SweepResult[] = [];

console.log("Sweeping pullback configs (25 combos)...");
console.log("Each combo: walk all 1m bars for all accepted trades.\n");

for (const minPeak of MIN_PEAKS) {
  for (const depth of PULLBACK_DEPTHS) {
    process.stdout.write(`  X=${depth}% Y=${minPeak}%...`);

    // FULL period
    const fullResults = fullAccepted.map(sig => simTradeWithPullback(sig, depth, minPeak));
    const fullStats = calcStats(fullResults, fullDays);
    const pullbackExits = fullResults.filter(r => r.reason === "pullback").length;

    // Correct/wrong analysis: pullback exit was "correct" if price continued falling
    // (post-exit max leveraged% < exit leveraged%)
    let correctExits = 0;
    let wrongExits = 0;
    for (const r of fullResults) {
      if (r.reason !== "pullback") continue;
      // "Correct" = after exit, the position would have gotten worse (price fell further in our direction loss)
      // i.e., the 24h post-exit MIN leveraged PnL% is lower than exit leveraged PnL%
      if (r.postExitMinPct < r.exitLevPct) {
        correctExits++;
      } else {
        wrongExits++;
      }
    }

    // OOS period
    const oosResults = oosAccepted.map(sig => simTradeWithPullback(sig, depth, minPeak));
    const oosStats = calcStats(oosResults, oosDays);

    sweepResults.push({
      depth, minPeak,
      trades: fullStats.trades, wr: fullStats.wr, total: fullStats.total,
      perDay: fullStats.perDay, pf: fullStats.pf, sharpe: fullStats.sharpe, maxDD: fullStats.maxDD,
      oosPerDay: oosStats.perDay, oosPf: oosStats.pf,
      pullbackExits, correctExits, wrongExits,
    });

    console.log(` $${fullStats.perDay.toFixed(2)}/day, PF ${fullStats.pf.toFixed(2)}, DD $${fullStats.maxDD.toFixed(0)}, ${pullbackExits} PB exits (${correctExits} correct, ${wrongExits} wrong), OOS $${oosStats.perDay.toFixed(2)}/day`);
  }
}

// ─── Results table ───────────────────────────────────────────────────
console.log("\n" + "=".repeat(160));
console.log("PULLBACK EXIT VALIDATION - FAIR COMPARISON");
console.log("Engines: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3 | 23 pairs | Pool max 20 | Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("Trade set: built from NO-overlay pool, then pullback exit applied to SAME trades using 1m bar walks");
console.log("=".repeat(160));

console.log(`\nBASELINE (no pullback): ${baseline.trades} trades, WR ${baseline.wr.toFixed(1)}%, $${baseline.total.toFixed(2)}, $${baseline.perDay.toFixed(2)}/day, PF ${baseline.pf.toFixed(2)}, Sharpe ${baseline.sharpe.toFixed(2)}, MaxDD $${baseline.maxDD.toFixed(0)}, OOS $${oosBaseline.perDay.toFixed(2)}/day\n`);

console.log(`${"X(pb%)".padStart(6)} ${"Y(minPk)".padStart(8)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(10)} ${"$/day".padStart(8)} ${"PF".padStart(6)} ${"Sharpe".padStart(7)} ${"MaxDD".padStart(8)} ${"PBexits".padStart(8)} ${"Correct".padStart(8)} ${"Wrong".padStart(6)} ${"Cor%".padStart(6)} ${"OOS$/d".padStart(8)} ${"OosPF".padStart(7)} ${"vs Base".padStart(10)}`);
console.log("-".repeat(160));

// Sort by $/day descending
sweepResults.sort((a, b) => b.perDay - a.perDay);

for (const r of sweepResults) {
  const corPct = r.pullbackExits > 0 ? (r.correctExits / r.pullbackExits * 100).toFixed(0) : "N/A";
  const vs = r.perDay - baseline.perDay;
  const mark = r.perDay > baseline.perDay ? " +" : "";
  console.log(
    `${String(r.depth).padStart(6)} ${String(r.minPeak).padStart(8)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)}% ${("$"+r.total.toFixed(2)).padStart(10)} ${("$"+r.perDay.toFixed(2)).padStart(8)} ${r.pf.toFixed(2).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)} ${("$"+r.maxDD.toFixed(0)).padStart(8)} ${String(r.pullbackExits).padStart(8)} ${String(r.correctExits).padStart(8)} ${String(r.wrongExits).padStart(6)} ${String(corPct).padStart(5)}% ${("$"+r.oosPerDay.toFixed(2)).padStart(8)} ${r.oosPf.toFixed(2).padStart(7)} ${(vs >= 0 ? "+$" : "-$")+Math.abs(vs).toFixed(2).padStart(6)+"/d"}`);
}

// ─── Grouped by minPeak ──────────────────────────────────────────────
console.log("\n" + "=".repeat(120));
console.log("GROUPED BY MIN PEAK REQUIREMENT");
console.log("=".repeat(120));

for (const minPeak of MIN_PEAKS) {
  const group = sweepResults.filter(r => r.minPeak === minPeak).sort((a, b) => b.perDay - a.perDay);
  console.log(`\n  Y = ${minPeak}% (pullback exit only activates after position peaks at ${minPeak}% leveraged profit)`);
  console.log(`  ${"X(pb%)".padStart(6)} ${"$/day".padStart(8)} ${"PF".padStart(6)} ${"MaxDD".padStart(8)} ${"PBexits".padStart(8)} ${"Cor%".padStart(6)} ${"OOS$/d".padStart(8)} ${"vs Base".padStart(10)}`);
  console.log("  " + "-".repeat(80));
  for (const r of group) {
    const vs = r.perDay - baseline.perDay;
    const corPct = r.pullbackExits > 0 ? (r.correctExits / r.pullbackExits * 100).toFixed(0) : "N/A";
    console.log(`  ${String(r.depth).padStart(6)} ${("$"+r.perDay.toFixed(2)).padStart(8)} ${r.pf.toFixed(2).padStart(6)} ${("$"+r.maxDD.toFixed(0)).padStart(8)} ${String(r.pullbackExits).padStart(8)} ${String(corPct).padStart(5)}% ${("$"+r.oosPerDay.toFixed(2)).padStart(8)} ${(vs >= 0 ? "+$" : "-$")+Math.abs(vs).toFixed(2).padStart(6)+"/d"}`);
  }
}

// ─── Diagnosis: Why was the original $28.90/day wrong? ───────────────
console.log("\n" + "=".repeat(120));
console.log("DIAGNOSIS: Why was the original bt-pullback-analysis $28.90/day suspicious?");
console.log("=".repeat(120));
console.log(`
Known bugs in the original script:
  1. APPROXIMATE exit P&L: used (peakPnlPct - threshold)/100 * NOT, not actual 1m bar prices
     - This OVERESTIMATES profit because it assumes you exit EXACTLY at peak-threshold
     - In reality, the 1m bar close where the condition fires can be WORSE than that
  2. NO POSITION POOL: ran each pair/engine independently (no max-20 constraint)
     - Inflates trade count and total P&L
  3. ONLY 14 PAIRS and 2 ENGINES: Donchian + Supertrend only, not the full 4-engine ensemble
     - Different trade set = different results, cannot compare fairly
  4. START DATE 2023-06 not 2023-01: shorter period inflates $/day denominator
  5. USED WILDER'S ATR: the old script uses exponential ATR smoothing, not SMA ATR
     - Different stops = different trades = different results
  6. NO post-exit validation: never checked if the pullback exit was actually beneficial

This script fixes ALL of those issues.
`);

// ─── Final verdict ───────────────────────────────────────────────────
const bestConfig = sweepResults[0];
const worstConfig = sweepResults[sweepResults.length - 1];

console.log("=".repeat(120));
console.log("VERDICT");
console.log("=".repeat(120));
console.log(`Baseline (no pullback exit): $${baseline.perDay.toFixed(2)}/day, PF ${baseline.pf.toFixed(2)}, MaxDD $${baseline.maxDD.toFixed(0)}, OOS $${oosBaseline.perDay.toFixed(2)}/day`);
console.log(`Best pullback config: X=${bestConfig.depth}% Y=${bestConfig.minPeak}% -> $${bestConfig.perDay.toFixed(2)}/day, PF ${bestConfig.pf.toFixed(2)}, MaxDD $${bestConfig.maxDD.toFixed(0)}, OOS $${bestConfig.oosPerDay.toFixed(2)}/day`);
console.log(`Worst pullback config: X=${worstConfig.depth}% Y=${worstConfig.minPeak}% -> $${worstConfig.perDay.toFixed(2)}/day, PF ${worstConfig.pf.toFixed(2)}, MaxDD $${worstConfig.maxDD.toFixed(0)}, OOS $${worstConfig.oosPerDay.toFixed(2)}/day`);

const anyBetter = sweepResults.filter(r => r.perDay > baseline.perDay && r.oosPerDay > oosBaseline.perDay);
if (anyBetter.length > 0) {
  console.log(`\n${anyBetter.length} configs beat baseline on BOTH full-period AND OOS:`);
  for (const r of anyBetter) {
    console.log(`  X=${r.depth}% Y=${r.minPeak}%: $${r.perDay.toFixed(2)}/day (full), $${r.oosPerDay.toFixed(2)}/day (OOS), PF ${r.pf.toFixed(2)}, Correct exits: ${r.correctExits}/${r.pullbackExits} (${(r.correctExits/Math.max(r.pullbackExits,1)*100).toFixed(0)}%)`);
  }
} else {
  console.log("\nNO config beats baseline on both full-period AND OOS. Pullback exit is NOT a real edge.");
}

console.log("\nDone.");
