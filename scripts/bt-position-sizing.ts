/**
 * POSITION SIZING ANALYSIS
 * Full ensemble (Donchian + Supertrend + GARCH v2 + Momentum) with variable sizing.
 * All known bugs fixed: SMA ATR, half-spreads, SMA look-ahead, BTC 4h EMA 12/21, GARCH 7% TP.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-position-sizing.ts
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

// FIX: Use proper half-spreads (not doubled) to match live costs.ts
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = ["OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX", "NEAR", "SUI", "FET"];

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

// FIX: Use SMA of last N TRs to match live indicators.ts (not Wilder's smoothing)
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) { trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)); }
  const atr = new Array(cs.length).fill(0);
  for (let i = period; i < cs.length; i++) { let s = 0; for (let j = i - period + 1; j <= i; j++) s += trs[j]; atr[i] = s / period; }
  return atr;
}
function calcEMA(values: number[], period: number): number[] { const ema = new Array(values.length).fill(0); const k = 2/(period+1); let init = false; for (let i = 0; i < values.length; i++) { if (i < period-1) continue; if (!init) { let s = 0; for (let j = i-period+1; j <= i; j++) s += values[j]; ema[i] = s/period; init = true; } else { ema[i] = values[i]*k + ema[i-1]*(1-k); } } return ema; }
function calcSMA(values: number[], period: number): number[] { const out = new Array(values.length).fill(0); for (let i = period-1; i < values.length; i++) { let s = 0; for (let j = i-period+1; j <= i; j++) s += values[j]; out[i] = s/period; } return out; }
function donchCloseLow(cs: C[], idx: number, lb: number): number { let mn = Infinity; for (let i = Math.max(0, idx-lb); i < idx; i++) mn = Math.min(mn, cs[i].c); return mn; }
function donchCloseHigh(cs: C[], idx: number, lb: number): number { let mx = -Infinity; for (let i = Math.max(0, idx-lb); i < idx; i++) mx = Math.max(mx, cs[i].c); return mx; }
function calcSupertrend(cs: C[], p: number, m: number): { dir: number[] } { const atr = calcATR(cs, p); const dirs = new Array(cs.length).fill(1); const ub = new Array(cs.length).fill(0); const lb = new Array(cs.length).fill(0); for (let i = p; i < cs.length; i++) { const hl2 = (cs[i].h+cs[i].l)/2; let u = hl2+m*atr[i]; let l = hl2-m*atr[i]; if (i > p) { if (!(l > lb[i-1] || cs[i-1].c < lb[i-1])) l = lb[i-1]; if (!(u < ub[i-1] || cs[i-1].c > ub[i-1])) u = ub[i-1]; } ub[i] = u; lb[i] = l; if (i === p) dirs[i] = cs[i].c > u ? 1 : -1; else dirs[i] = dirs[i-1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1); } return { dir: dirs }; }
// FIX: Use i-volWin to i (21 returns) to match live garch-v2-engine.ts
function computeZScores(cs: C[], momLb: number, volWin: number): number[] { const z = new Array(cs.length).fill(0); for (let i = Math.max(momLb+1, volWin+1); i < cs.length; i++) { const mom = cs[i].c/cs[i-momLb].c - 1; let sumSq = 0, count = 0; for (let j = Math.max(1, i-volWin); j <= i; j++) { const r = cs[j].c/cs[j-1].c - 1; sumSq += r*r; count++; } if (count < 10) continue; const vol = Math.sqrt(sumSq/count); if (vol === 0) continue; z[i] = mom/vol; } return z; }

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function entryPx(pair: string, dir: "long"|"short", raw: number): number { const sp = getSpread(pair); return dir === "long" ? raw*(1+sp) : raw*(1-sp); }
function exitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number { const sp = getSpread(pair); const slip = isSL ? sp*SL_SLIP : sp; return dir === "long" ? raw*(1-slip) : raw*(1+slip); }
function calcPnl(dir: "long"|"short", ep: number, xp: number, not: number): number { return (dir === "long" ? (xp/ep-1)*not : (ep/xp-1)*not) - not*FEE*2; }

// Load data
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) { const d = loadJson(CD_5M, p); if (d.length > 0) raw5m.set(p, d); }

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); console.log(`  ${p}: ${d.length} 1m bars`); }
}

const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) { dailyData.set(p, aggregate(bars, D, 200)); h4Data.set(p, aggregate(bars, H4, 40)); h1Data.set(p, aggregate(bars, H, 10)); }

// FIX: BTC 4h EMA 12/21 to match live engines (not daily EMA 20/50)
const btcH4 = h4Data.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

// FIX: Use strict less-than to exclude incomplete current bar (matches live slice(0,-1))
function btcH4Bullish(t: number): boolean {
  let idx = -1;
  for (let i = btcH4.length - 1; i >= 0; i--) {
    if (btcH4[i].t < t) { idx = i; break; }
  }
  if (idx < 0) return false;
  const off12 = btcH4.length - btcH4Ema12.length;
  const off21 = btcH4.length - btcH4Ema21.length;
  const i12 = idx - off12;
  const i21 = idx - off21;
  return i12 >= 0 && i21 >= 0 && btcH4Ema12[i12] > btcH4Ema21[i21];
}

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long"|"short"|null { const bucket = Math.floor(t/H)*H; let idx = btcH1TsMap.get(bucket); if (idx === undefined) { for (let i = btcH1.length-1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } } } if (idx === undefined || idx < 1) return null; const prev = idx-1; const off9 = btcH1.length-btcH1Ema9.length; const off21 = btcH1.length-btcH1Ema21.length; const i9 = prev-off9; const i21 = prev-off21; if (i9 < 0 || i21 < 0) return null; if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long"; if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short"; return null; }

console.log("Loaded.\n");

// Signal with variable size
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
}

// Engine A: Donchian — live uses SMA(20/50), BTC 4h EMA(12/21)
function genDonchian(sz: number): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = dailyData.get(pair); if (!cs || cs.length < 65) continue;
    const closes = cs.map(c => c.c);
    // FIX: Match live SMA_FAST=20, SMA_SLOW=50
    const fast = calcSMA(closes, 20); const slow = calcSMA(closes, 50); const atr = calcATR(cs, 14);
    let pos: any = null;
    for (let i = 51; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = ""; const hd = Math.round((bar.t-pos.et)/D);
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && i >= 16) { if (pos.dir === "long") { const lo = donchCloseLow(cs, i, 15); if (bar.c < lo) { xp = bar.c; reason = "ch"; } } else { const hi = donchCloseHigh(cs, i, 15); if (bar.c > hi) { xp = bar.c; reason = "ch"; } } }
        if (!xp && hd >= 60) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "A", size: sz, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos) {
        // FIX: Use completed bars only (i-1 vs i-2), enter at bar[i] open
        const p = i-1; const pp = i-2;
        if (pp < 0 || fast[p] === 0 || slow[p] === 0 || fast[pp] === 0 || slow[pp] === 0) continue;
        let dir: "long"|"short"|null = null;
        if (fast[pp] <= slow[pp] && fast[p] > slow[p]) dir = "long"; else if (fast[pp] >= slow[pp] && fast[p] < slow[p]) dir = "short";
        if (!dir) continue;
        // FIX: BTC 4h EMA(12/21) to match live donchian-trend-engine.ts
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// Engine B: Supertrend — live uses BTC 4h EMA(12/21)
function genSupertrend(sz: number): Signal[] {
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
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "B", size: sz, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos && flip && bar.t >= FULL_START) {
        const dir: "long"|"short" = stDir[i-1] === 1 ? "long" : "short";
        // FIX: BTC 4h EMA(12/21) to match live supertrend-4h-engine.ts
        if (dir === "long" && !btcH4Bullish(bar.t)) continue;
        const prevATR = atr[i-1]; if (prevATR <= 0) continue;
        let sl = dir === "long" ? bar.o - 3*prevATR : bar.o + 3*prevATR;
        if (dir === "long") sl = Math.max(sl, bar.o*0.965); else sl = Math.min(sl, bar.o*1.035);
        pos = { dir, ep: bar.o, et: bar.t, sl };
      }
    }
  }
  return sigs;
}

// Engine C: GARCH v2 — 7% TP, 96h max hold, 3% SL
function genGarchV2(sz: number): Signal[] {
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
        // FIX: GARCH 7% TP check
        if (!xp) {
          const tp = pos.dir === "long" ? pos.ep * 1.07 : pos.ep * 0.93;
          if (pos.dir === "long" && bar.h >= tp) { xp = tp; reason = "tp"; }
          else if (pos.dir === "short" && bar.l <= tp) { xp = tp; reason = "tp"; }
        }
        if (!xp && (bar.t-pos.et)/H >= 96) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "C", size: sz, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
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

// Engine D: Momentum Confirm — 48h max hold, 3% SL, BTC 4h EMA(12/21)
function genMomentumConfirm(sz: number): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 55) continue;
    let pos: any = null;
    for (let i = 52; i < cs.length; i++) {
      const bar = cs[i];
      if (pos) {
        let xp = 0, reason = "";
        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; }
        if (!xp && (bar.t-pos.et)/H >= 48) { xp = bar.c; reason = "mh"; }
        if (xp > 0) { if (pos.et >= FULL_START && pos.et < FULL_END) sigs.push({ pair, dir: pos.dir, engine: "D", size: sz, entryTime: pos.et, entryPrice: pos.ep, sl: pos.sl, exitTime: bar.t, exitPrice: xp, exitReason: reason }); pos = null; }
      }
      if (!pos && bar.t >= FULL_START && bar.t < FULL_END) {
        const prev = i - 1;
        const ranges: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) ranges.push(cs[j].h - cs[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s,v)=>s+v,0)/ranges.length;
        const rStd = Math.sqrt(ranges.reduce((s,v)=>s+(v-rMean)**2,0)/ranges.length);
        const volZ = rStd > 0 ? (ranges[ranges.length-1] - rMean)/rStd : 0;

        const fp: number[] = []; for (let j = Math.max(0, prev-50); j <= prev; j++) fp.push((cs[j].c - cs[j].o)/cs[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s,v)=>s+v,0)/fp.length;
        const fpStd = Math.sqrt(fp.reduce((s,v)=>s+(v-fpMean)**2,0)/fp.length);
        const fundZ = fpStd > 0 ? (fp[fp.length-1] - fpMean)/fpStd : 0;

        const closes: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) closes.push(cs[j].c); }
        if (closes.length < 20) continue;
        const cMean = closes.reduce((s,v)=>s+v,0)/closes.length;
        const cStd = Math.sqrt(closes.reduce((s,v)=>s+(v-cMean)**2,0)/closes.length);
        const priceZ = cStd > 0 ? (closes[closes.length-1] - cMean)/cStd : 0;

        let dir: "long"|"short"|null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) {
          // FIX: BTC 4h EMA(12/21) to match live momentum-confirm-engine.ts
          if (btcH4Bullish(bar.t)) dir = "long";
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
  return sigs;
}

// Simulate single trade with 1m precision (no trail for sizing analysis)
function simTrade(sig: Signal): { pnl: number; reason: string; exitTime: number } {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime };
  }

  // Binary search for start index
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; } }

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    // SL check
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t };
    }

    // GARCH v2 TP check (7%)
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

// Run ensemble with position pool
function runEnsemble(allSignals: Signal[], startTs: number, endTs: number): { trades: { pnl: number; reason: string; exitTime: number; entryTime: number; engine: string; pair: string; size: number }[]; blocked: number } {
  // Build accepted set with position pool limits
  const processed = allSignals.map(sig => {
    const result = simTrade(sig);
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
    const key = `${evt.engine}:${evt.pair}`;
    if (evt.type === "exit") { openPos.delete(key); }
    else {
      if (openPos.has(key)) continue;
      if (openPos.size >= MAX_POS) continue;
      openPos.set(key, evt.idx);
      accepted.push(allSignals[evt.idx]);
    }
  }

  // Simulate accepted trades
  const trades = accepted.map(sig => {
    const result = simTrade(sig);
    return { pnl: result.pnl, reason: result.reason, exitTime: result.exitTime, entryTime: sig.entryTime, engine: sig.engine, pair: sig.pair, size: sig.size };
  });

  const totalInPeriod = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length };
}

// Stats computation
interface Stats {
  trades: number; wr: number; pf: number; total: number;
  perDay: number; maxDD: number; sharpe: number; blocked: number;
  oosTotal: number; oosPerDay: number; oosPf: number;
  avgMargin: number; peakMargin: number;
}

function computeStats(allSigs: Signal[], startTs: number, endTs: number, oosStart: number, totalDays: number, oosDays: number): Stats {
  const full = runEnsemble(allSigs, startTs, endTs);
  const oos = runEnsemble(allSigs, oosStart, endTs);

  const trades = full.trades;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak-cum > maxDD) maxDD = peak-cum; }

  const dayPnl = new Map<number, number>();
  for (const t of trades) { const d = Math.floor(t.exitTime/D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0)/rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r-mean)**2, 0)/(rets.length-1)) : 0;
  const sharpe = std > 0 ? (mean/std)*Math.sqrt(252) : 0;

  const oosT = oos.trades;
  const oosWins = oosT.filter(t => t.pnl > 0);
  const oosLosses = oosT.filter(t => t.pnl <= 0);
  const oosTotal = oosT.reduce((s, t) => s + t.pnl, 0);
  const oosGP = oosWins.reduce((s, t) => s + t.pnl, 0);
  const oosGL = Math.abs(oosLosses.reduce((s, t) => s + t.pnl, 0));

  // Compute margin utilization (how much margin is open at any point)
  interface MEvent { t: number; type: "open"|"close"; margin: number }
  const mEvents: MEvent[] = [];
  for (const t of trades) {
    mEvents.push({ t: t.entryTime, type: "open", margin: t.size });
    mEvents.push({ t: t.exitTime, type: "close", margin: t.size });
  }
  mEvents.sort((a, b) => a.t - b.t || (a.type === "close" ? -1 : 1));
  let curMargin = 0, totalMarginTime = 0, peakMargin = 0;
  let lastT = startTs;
  for (const e of mEvents) {
    if (e.t > lastT) { totalMarginTime += curMargin * (e.t - lastT); lastT = e.t; }
    if (e.type === "open") curMargin += e.margin;
    else curMargin -= e.margin;
    if (curMargin > peakMargin) peakMargin = curMargin;
  }
  const avgMargin = totalMarginTime / (endTs - startTs);

  return {
    trades: trades.length, wr: trades.length > 0 ? wins.length/trades.length*100 : 0,
    pf: gl > 0 ? gp/gl : 99, total, perDay: total/totalDays, maxDD, sharpe, blocked: full.blocked,
    oosTotal, oosPerDay: oosTotal/oosDays, oosPf: oosGL > 0 ? oosGP/oosGL : 99,
    avgMargin, peakMargin,
  };
}

// --- Step 1: Run per-engine baselines to compute Kelly and Sharpe ---
console.log("=== STEP 1: Per-engine baseline stats (for Kelly + Sharpe computation) ===\n");

const days = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

// Generate signals at $1 size for each engine to get per-unit stats
const engA = genDonchian(1);
const engB = genSupertrend(1);
const engC = genGarchV2(1);
const engD = genMomentumConfirm(1);

console.log(`Engine A (Donchian):  ${engA.length} signals`);
console.log(`Engine B (Supertrend): ${engB.length} signals`);
console.log(`Engine C (GARCH v2):   ${engC.length} signals`);
console.log(`Engine D (Momentum):   ${engD.length} signals`);

function engineStats(sigs: Signal[], label: string): { wr: number; avgWin: number; avgLoss: number; pf: number; perDay: number; sharpe: number; kelly: number; maxDD: number } {
  const results = sigs
    .filter(s => s.entryTime >= FULL_START && s.entryTime < FULL_END)
    .map(s => simTrade(s));
  const wins = results.filter(r => r.pnl > 0);
  const losses = results.filter(r => r.pnl <= 0);
  const wr = results.length > 0 ? wins.length / results.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r.pnl, 0) / losses.length) : 1;
  const gp = wins.reduce((s, r) => s + r.pnl, 0);
  const gl = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  const pf = gl > 0 ? gp / gl : 99;
  const total = results.reduce((s, r) => s + r.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...results].sort((a, b) => a.exitTime - b.exitTime);
  for (const r of sorted) { cum += r.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }

  const dayPnl = new Map<number, number>();
  for (const r of results) { const d = Math.floor(r.exitTime/D); dayPnl.set(d, (dayPnl.get(d) ?? 0) + r.pnl); }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0)/rets.length : 0;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r-mean)**2, 0)/(rets.length-1)) : 0;
  const sharpe = std > 0 ? (mean/std)*Math.sqrt(252) : 0;

  // Kelly = W - (1-W)/(avgWin/avgLoss) = W - L/R
  const R = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly = Math.max(0, wr - (1 - wr) / R);

  console.log(`  ${label}: ${results.length} trades, WR ${(wr*100).toFixed(1)}%, PF ${pf.toFixed(2)}, $${(total/days).toFixed(2)}/day, Sharpe ${sharpe.toFixed(2)}, Kelly ${(kelly*100).toFixed(1)}%, MaxDD $${maxDD.toFixed(2)} (per $1 size)`);
  return { wr, avgWin, avgLoss, pf, perDay: total / days, sharpe, kelly, maxDD };
}

console.log("\nPer-engine stats (per $1 margin, 10x leverage):");
const statsA = engineStats(engA, "A Donchian ");
const statsB = engineStats(engB, "B Supertrend");
const statsC = engineStats(engC, "C GARCH v2  ");
const statsD = engineStats(engD, "D Momentum  ");

// --- Step 2: Compute sizing configs ---
console.log("\n=== STEP 2: Computing sizing configs ===\n");

// Kelly-weighted: normalize Kelly fractions, scale to $25 total margin (like current total $7+$5+$3+$3=$18, round up)
const kellyTotal = statsA.kelly + statsB.kelly + statsC.kelly + statsD.kelly;
const kellyBudget = 18; // Match current total margin
const kellyA = kellyTotal > 0 ? Math.round(statsA.kelly / kellyTotal * kellyBudget) : 5;
const kellyB = kellyTotal > 0 ? Math.round(statsB.kelly / kellyTotal * kellyBudget) : 5;
const kellyC = kellyTotal > 0 ? Math.round(statsC.kelly / kellyTotal * kellyBudget) : 5;
const kellyD = kellyTotal > 0 ? Math.round(statsD.kelly / kellyTotal * kellyBudget) : 5;

// Sharpe-weighted: proportional to per-engine Sharpe ratio
const sharpeArr = [Math.max(0, statsA.sharpe), Math.max(0, statsB.sharpe), Math.max(0, statsC.sharpe), Math.max(0, statsD.sharpe)];
const sharpeTotal = sharpeArr.reduce((s, v) => s + v, 0);
const sharpeBudget = 18;
const sharpeA = sharpeTotal > 0 ? Math.round(sharpeArr[0] / sharpeTotal * sharpeBudget) : 5;
const sharpeB = sharpeTotal > 0 ? Math.round(sharpeArr[1] / sharpeTotal * sharpeBudget) : 5;
const sharpeC = sharpeTotal > 0 ? Math.round(sharpeArr[2] / sharpeTotal * sharpeBudget) : 5;
const sharpeD = sharpeTotal > 0 ? Math.round(sharpeArr[3] / sharpeTotal * sharpeBudget) : 5;

interface SizingConfig {
  label: string;
  sA: number; sB: number; sC: number; sD: number;
  capital: number; // For DD% calculation
}

const configs: SizingConfig[] = [
  { label: "Current", sA: 7, sB: 5, sC: 3, sD: 3, capital: 100 },
  { label: "Doubled", sA: 14, sB: 10, sC: 6, sD: 6, capital: 200 },
  { label: "Kelly", sA: kellyA, sB: kellyB, sC: kellyC, sD: kellyD, capital: 100 },
  { label: "Sharpe", sA: sharpeA, sB: sharpeB, sC: sharpeC, sD: sharpeD, capital: 100 },
  { label: "Equal $5", sA: 5, sB: 5, sC: 5, sD: 5, capital: 100 },
  { label: "Top-heavy", sA: 10, sB: 10, sC: 2, sD: 2, capital: 100 },
];

console.log("Sizing configs:");
for (const c of configs) {
  console.log(`  ${c.label.padEnd(12)}: A=$${c.sA}, B=$${c.sB}, C=$${c.sC}, D=$${c.sD} (total margin: $${c.sA+c.sB+c.sC+c.sD})`);
}

// --- Step 3: Run all configs ---
console.log("\n=== STEP 3: Running ensemble for each config ===\n");

interface ConfigResult {
  label: string;
  totalMargin: number;
  capital: number;
  stats: Stats;
}

const configResults: ConfigResult[] = [];

for (const cfg of configs) {
  process.stdout.write(`  ${cfg.label}...`);
  const sigA = genDonchian(cfg.sA);
  const sigB = genSupertrend(cfg.sB);
  const sigC = genGarchV2(cfg.sC);
  const sigD = genMomentumConfirm(cfg.sD);
  const allSigs = [...sigA, ...sigB, ...sigC, ...sigD];
  const stats = computeStats(allSigs, FULL_START, FULL_END, OOS_START, days, oosDays);
  configResults.push({ label: cfg.label, totalMargin: cfg.sA + cfg.sB + cfg.sC + cfg.sD, capital: cfg.capital, stats });
  console.log(` $${stats.perDay.toFixed(2)}/day, DD $${stats.maxDD.toFixed(0)}, Sharpe ${stats.sharpe.toFixed(2)}`);
}

// --- Step 4: Capital deployment analysis ---
console.log("\n=== STEP 4: Capital deployment analysis (current sizing scaled) ===\n");

const capitalLevels = [100, 200, 500];
const capitalResults: ConfigResult[] = [];

for (const cap of capitalLevels) {
  const scale = cap / 100;
  const sA = Math.round(7 * scale);
  const sB = Math.round(5 * scale);
  const sC = Math.round(3 * scale);
  const sD = Math.round(3 * scale);
  process.stdout.write(`  $${cap} capital (A=$${sA}, B=$${sB}, C=$${sC}, D=$${sD})...`);
  const sigA = genDonchian(sA);
  const sigB = genSupertrend(sB);
  const sigC = genGarchV2(sC);
  const sigD = genMomentumConfirm(sD);
  const allSigs = [...sigA, ...sigB, ...sigC, ...sigD];
  const stats = computeStats(allSigs, FULL_START, FULL_END, OOS_START, days, oosDays);
  capitalResults.push({ label: `$${cap}`, totalMargin: sA + sB + sC + sD, capital: cap, stats });
  console.log(` $${stats.perDay.toFixed(2)}/day, DD $${stats.maxDD.toFixed(0)}, Sharpe ${stats.sharpe.toFixed(2)}`);
}

// --- Print results ---
console.log("\n" + "=".repeat(160));
console.log("POSITION SIZING ANALYSIS - Full Ensemble (Donchian + Supertrend + GARCH v2 + Momentum)");
console.log("Fixes: BTC 4h EMA(12/21), SMA ATR, half-spreads, SMA look-ahead, GARCH 7% TP");
console.log("23 pairs | Full: 2023-01 to 2026-03 | OOS: 2025-09+ | Max 20 positions | 10x leverage");
console.log("=".repeat(160));

console.log(`\n${"Config".padEnd(14)} ${"A/B/C/D".padEnd(16)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(12)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"DD%cap".padStart(8)} ${"AvgMgn".padStart(8)} ${"PkMgn".padStart(8)} ${"OOS$/d".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(160));

for (const r of configResults) {
  const s = r.stats;
  const ddPct = r.capital > 0 ? (s.maxDD / r.capital * 100) : 0;
  console.log(
    `${r.label.padEnd(14)} ${`$${configs.find(c => c.label === r.label)!.sA}/$${configs.find(c => c.label === r.label)!.sB}/$${configs.find(c => c.label === r.label)!.sC}/$${configs.find(c => c.label === r.label)!.sD}`.padEnd(16)} ${String(s.trades).padStart(7)} ${s.wr.toFixed(1).padStart(6)}% ${("$"+s.total.toFixed(2)).padStart(12)} ${("$"+s.perDay.toFixed(2)).padStart(10)} ${s.pf.toFixed(2).padStart(7)} ${s.sharpe.toFixed(2).padStart(8)} ${("$"+s.maxDD.toFixed(0)).padStart(10)} ${ddPct.toFixed(1).padStart(6)}% ${("$"+s.avgMargin.toFixed(1)).padStart(8)} ${("$"+s.peakMargin.toFixed(0)).padStart(8)} ${("$"+s.oosPerDay.toFixed(2)).padStart(10)} ${s.oosPf.toFixed(2).padStart(8)}`
  );
}

console.log("\n--- Capital Deployment ---");
console.log(`${"Capital".padEnd(14)} ${"A/B/C/D".padEnd(16)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(12)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"DD%cap".padStart(8)} ${"AvgMgn".padStart(8)} ${"PkMgn".padStart(8)} ${"OOS$/d".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(160));

for (const r of capitalResults) {
  const s = r.stats;
  const ddPct = r.capital > 0 ? (s.maxDD / r.capital * 100) : 0;
  const cap = capitalLevels[capitalResults.indexOf(r)];
  const scale = cap / 100;
  const sizes = `$${Math.round(7*scale)}/$${Math.round(5*scale)}/$${Math.round(3*scale)}/$${Math.round(3*scale)}`;
  console.log(
    `${r.label.padEnd(14)} ${sizes.padEnd(16)} ${String(s.trades).padStart(7)} ${s.wr.toFixed(1).padStart(6)}% ${("$"+s.total.toFixed(2)).padStart(12)} ${("$"+s.perDay.toFixed(2)).padStart(10)} ${s.pf.toFixed(2).padStart(7)} ${s.sharpe.toFixed(2).padStart(8)} ${("$"+s.maxDD.toFixed(0)).padStart(10)} ${ddPct.toFixed(1).padStart(6)}% ${("$"+s.avgMargin.toFixed(1)).padStart(8)} ${("$"+s.peakMargin.toFixed(0)).padStart(8)} ${("$"+s.oosPerDay.toFixed(2)).padStart(10)} ${s.oosPf.toFixed(2).padStart(8)}`
  );
}

// --- Kelly analysis printout ---
console.log("\n--- Kelly Criterion Per Engine ---");
console.log(`  A (Donchian):   WR=${(statsA.wr*100).toFixed(1)}%, AvgW/AvgL=${(statsA.avgWin/statsA.avgLoss).toFixed(2)}, Kelly=${(statsA.kelly*100).toFixed(1)}%`);
console.log(`  B (Supertrend): WR=${(statsB.wr*100).toFixed(1)}%, AvgW/AvgL=${(statsB.avgWin/statsB.avgLoss).toFixed(2)}, Kelly=${(statsB.kelly*100).toFixed(1)}%`);
console.log(`  C (GARCH v2):   WR=${(statsC.wr*100).toFixed(1)}%, AvgW/AvgL=${(statsC.avgWin/statsC.avgLoss).toFixed(2)}, Kelly=${(statsC.kelly*100).toFixed(1)}%`);
console.log(`  D (Momentum):   WR=${(statsD.wr*100).toFixed(1)}%, AvgW/AvgL=${(statsD.avgWin/statsD.avgLoss).toFixed(2)}, Kelly=${(statsD.kelly*100).toFixed(1)}%`);
console.log(`  Kelly allocations ($${kellyBudget} budget): A=$${kellyA}, B=$${kellyB}, C=$${kellyC}, D=$${kellyD}`);

console.log("\n--- Sharpe-weighted Per Engine ---");
console.log(`  A (Donchian):   Sharpe=${statsA.sharpe.toFixed(2)}, weight=${sharpeTotal > 0 ? (sharpeArr[0]/sharpeTotal*100).toFixed(1) : 0}%`);
console.log(`  B (Supertrend): Sharpe=${statsB.sharpe.toFixed(2)}, weight=${sharpeTotal > 0 ? (sharpeArr[1]/sharpeTotal*100).toFixed(1) : 0}%`);
console.log(`  C (GARCH v2):   Sharpe=${statsC.sharpe.toFixed(2)}, weight=${sharpeTotal > 0 ? (sharpeArr[2]/sharpeTotal*100).toFixed(1) : 0}%`);
console.log(`  D (Momentum):   Sharpe=${statsD.sharpe.toFixed(2)}, weight=${sharpeTotal > 0 ? (sharpeArr[3]/sharpeTotal*100).toFixed(1) : 0}%`);
console.log(`  Sharpe allocations ($${sharpeBudget} budget): A=$${sharpeA}, B=$${sharpeB}, C=$${sharpeC}, D=$${sharpeD}`);

console.log("\n--- Key Findings ---");
const best = configResults.reduce((a, b) => a.stats.sharpe > b.stats.sharpe ? a : b);
const cheapest = configResults.reduce((a, b) => (a.stats.maxDD / a.capital) < (b.stats.maxDD / b.capital) ? a : b);
console.log(`  Best Sharpe:    ${best.label} (${best.stats.sharpe.toFixed(2)})`);
console.log(`  Lowest DD%:     ${cheapest.label} (${(cheapest.stats.maxDD/cheapest.capital*100).toFixed(1)}%)`);
console.log(`  Doubled impact: profit scales ${configResults[1].stats.perDay > 0 && configResults[0].stats.perDay > 0 ? (configResults[1].stats.perDay / configResults[0].stats.perDay).toFixed(2) : "N/A"}x, DD scales ${configResults[0].stats.maxDD > 0 ? (configResults[1].stats.maxDD / configResults[0].stats.maxDD).toFixed(2) : "N/A"}x`);

console.log("\nDone.");
