/**
 * FULL ENSEMBLE Trailing Stop Test
 * All 3 core engines (Donchian + Supertrend + GARCH v2)
 * Shared position pool (max 20)
 * 1m data for trail precision, 5m/daily/4h for engine signals
 * Full period: 2023-01 to 2026-03
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-trail-full-ensemble.ts
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

// BTC filters
const btcDaily = dailyData.get("BTC")!;
const btcCloses = btcDaily.map(c => c.c);
const btcEma20 = calcEMA(btcCloses, 20);
const btcEma50 = calcEMA(btcCloses, 50);
// FIX: Use strict less-than to exclude incomplete current daily bar (matches live slice(0,-1))
function btcDailyBullish(t: number): boolean { let idx = -1; for (let i = btcDaily.length-1; i >= 0; i--) { if (btcDaily[i].t < t) { idx = i; break; } } if (idx < 0) return false; const i20 = idx-(btcDaily.length-btcEma20.length); const i50 = idx-(btcDaily.length-btcEma50.length); return i20 >= 0 && i50 >= 0 && btcEma20[i20] > btcEma50[i50]; }

const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long"|"short"|null { const bucket = Math.floor(t/H)*H; let idx = btcH1TsMap.get(bucket); if (idx === undefined) { for (let i = btcH1.length-1; i >= 0; i--) { if (btcH1[i].t <= t) { idx = i; break; } } } if (idx === undefined || idx < 1) return null; const prev = idx-1; const off9 = btcH1.length-btcH1Ema9.length; const off21 = btcH1.length-btcH1Ema21.length; const i9 = prev-off9; const i21 = prev-off21; if (i9 < 0 || i21 < 0) return null; if (btcH1Ema9[i9] > btcH1Ema21[i21]) return "long"; if (btcH1Ema9[i9] < btcH1Ema21[i21]) return "short"; return null; }

console.log("Loaded.\n");

// Signal: entry + engine-determined exit
interface Signal {
  pair: string; dir: "long"|"short"; engine: string; size: number;
  entryTime: number; entryPrice: number; sl: number;
  exitTime: number; exitPrice: number; exitReason: string;
}

// Engine A: Donchian
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
        // FIX: Use completed bars only (i-1 vs i-2), enter at bar[i] open
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

// Engine B: Supertrend
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

// Engine C: GARCH v2
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
        // TP 7% check
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

// Engine D: Momentum Confirm (volume z + funding proxy z + price z on 4h)
function genMomentumConfirm(): Signal[] {
  const sigs: Signal[] = [];
  for (const pair of PAIRS) {
    const cs = h4Data.get(pair); if (!cs || cs.length < 55) continue;
    const completed = cs; const last = completed.length - 1;
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
        // Volume z-score (20-bar lookback)
        const vols: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) vols.push(completed[j].c * 1); /* proxy */ }
        // Use actual OHLC range as volume proxy since we don't have volume in aggregated data
        const ranges: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) ranges.push(completed[j].h - completed[j].l); }
        if (ranges.length < 20) continue;
        const rMean = ranges.reduce((s,v)=>s+v,0)/ranges.length;
        const rStd = Math.sqrt(ranges.reduce((s,v)=>s+(v-rMean)**2,0)/ranges.length);
        const volZ = rStd > 0 ? (ranges[ranges.length-1] - rMean)/rStd : 0;

        // Funding proxy z-score: (close-open)/close over 50 bars
        const fp: number[] = []; for (let j = Math.max(0, prev-50); j <= prev; j++) fp.push((completed[j].c - completed[j].o)/completed[j].c);
        if (fp.length < 20) continue;
        const fpMean = fp.reduce((s,v)=>s+v,0)/fp.length;
        const fpStd = Math.sqrt(fp.reduce((s,v)=>s+(v-fpMean)**2,0)/fp.length);
        const fundZ = fpStd > 0 ? (fp[fp.length-1] - fpMean)/fpStd : 0;

        // Price extension z-score
        const closes: number[] = []; for (let j = prev-20; j <= prev; j++) { if (j >= 0) closes.push(completed[j].c); }
        if (closes.length < 20) continue;
        const cMean = closes.reduce((s,v)=>s+v,0)/closes.length;
        const cStd = Math.sqrt(closes.reduce((s,v)=>s+(v-cMean)**2,0)/closes.length);
        const priceZ = cStd > 0 ? (closes[closes.length-1] - cMean)/cStd : 0;

        let dir: "long"|"short"|null = null;
        if (volZ > 2 && fundZ > 2 && priceZ > 1) {
          if (btcDailyBullish(bar.t)) dir = "long";
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

// Simulate single trade with trailing using 1m bars
function simTrade(sig: Signal, act: number, dist: number): { pnl: number; reason: string; exitTime: number; peakPct: number } {
  const bars1m = raw1m.get(sig.pair);
  const NOT = sig.size * LEV;
  const ep = entryPx(sig.pair, sig.dir, sig.entryPrice);

  if (!bars1m || bars1m.length === 0) {
    const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
    return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: 0 };
  }

  // Binary search for start index
  let lo = 0, hi = bars1m.length - 1, startIdx = bars1m.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars1m[mid].t >= sig.entryTime) { startIdx = mid; hi = mid - 1; } else { lo = mid + 1; } }

  let peakPnlPct = 0;

  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t > sig.exitTime) break;

    // SL check
    if (sig.dir === "long" && b.l <= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct };
    }
    if (sig.dir === "short" && b.h >= sig.sl) {
      const xp = exitPx(sig.pair, sig.dir, sig.sl, true);
      return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "sl", exitTime: b.t, peakPct: peakPnlPct };
    }

    // GARCH v2 TP check (7%) before trail
    if (sig.engine === "C") {
      const tp = sig.dir === "long" ? sig.entryPrice * 1.07 : sig.entryPrice * 0.93;
      if (sig.dir === "long" && b.h >= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct };
      }
      if (sig.dir === "short" && b.l <= tp) {
        const xp = exitPx(sig.pair, sig.dir, tp, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "tp", exitTime: b.t, peakPct: peakPnlPct };
      }
    }

    // Peak tracking (use best intrabar price)
    const bestPct = sig.dir === "long" ? (b.h/sig.entryPrice - 1)*LEV*100 : (sig.entryPrice/b.l - 1)*LEV*100;
    if (bestPct > peakPnlPct) peakPnlPct = bestPct;

    // Trail check
    if (act > 0 && peakPnlPct >= act) {
      const currPct = sig.dir === "long" ? (b.c/sig.entryPrice - 1)*LEV*100 : (sig.entryPrice/b.c - 1)*LEV*100;
      if (currPct <= peakPnlPct - dist) {
        const xp = exitPx(sig.pair, sig.dir, b.c, false);
        return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: "trail", exitTime: b.t, peakPct: peakPnlPct };
      }
    }
  }

  // Engine exit
  const xp = exitPx(sig.pair, sig.dir, sig.exitPrice, sig.exitReason === "sl");
  return { pnl: calcPnl(sig.dir, ep, xp, NOT), reason: sig.exitReason, exitTime: sig.exitTime, peakPct: peakPnlPct };
}

// FAIR COMPARISON: Use no-trail pool to select trades, then apply trail to the SAME trades
// Keyed by period to avoid OOS overwriting full-period cache
const noTrailCache = new Map<string, Signal[]>();

function runEnsemble(allSignals: Signal[], act: number, dist: number, startTs: number, endTs: number): { trades: { pnl: number; reason: string; exitTime: number; entryTime: number; engine: string; pair: string }[]; blocked: number } {
  const periodKey = `${startTs}-${endTs}`;

  // STEP 1: Build no-trail accepted set for this period (cached)
  if (!noTrailCache.has(periodKey)) {
    const noTrailProcessed = allSignals.map(sig => {
      const result = simTrade(sig, 0, 0);
      return { ...sig, adjExitTime: result.exitTime };
    });

    interface Event { t: number; type: "entry"|"exit"; idx: number; engine: string; pair: string }
    const events: Event[] = [];
    for (let idx = 0; idx < noTrailProcessed.length; idx++) {
      const s = noTrailProcessed[idx];
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
  }

  const accepted = noTrailCache.get(periodKey)!;

  // STEP 2: Apply trail (or no trail) to the accepted trades
  const trades = accepted.map(sig => {
    const result = simTrade(sig, act, dist);
    return { pnl: result.pnl, reason: result.reason, exitTime: result.exitTime, entryTime: sig.entryTime, engine: sig.engine, pair: sig.pair };
  });

  const totalInPeriod = allSignals.filter(s => s.entryTime >= startTs && s.entryTime < endTs).length;
  return { trades, blocked: totalInPeriod - accepted.length };
}

// Generate all signals
console.log("Generating signals from all 3 engines...");
const donchSigs = genDonchian();
const stSigs = genSupertrend();
const garchSigs = genGarchV2();
const momSigs = genMomentumConfirm();
const allSigs = [...donchSigs, ...stSigs, ...garchSigs, ...momSigs];
console.log(`  A (Donchian): ${donchSigs.length}, B (Supertrend): ${stSigs.length}, C (GARCH v2): ${garchSigs.length}`);
console.log(`  D (Momentum): ${momSigs.length}`);
console.log(`  Total: ${allSigs.length} signals\n`);

// Test configs
const configs: [number, number][] = [
  [0, 0],
  [20, 3], [20, 5],
  [25, 3], [25, 5],
  [30, 3], [30, 5], [30, 7], [30, 10],
  [40, 5], [40, 7], [40, 10],
];

interface Result {
  label: string; trades: number; wr: number; pf: number; total: number;
  perDay: number; maxDD: number; sharpe: number; blocked: number;
  trailExits: number;
  oosTotal: number; oosPerDay: number; oosPf: number;
}

const results: Result[] = [];
const days = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

for (const [act, dist] of configs) {
  const label = act === 0 ? "NO TRAIL" : `${act}/${dist}`;
  process.stdout.write(`  ${label}...`);

  const full = runEnsemble(allSigs, act, dist, FULL_START, FULL_END);
  const oos = runEnsemble(allSigs, act, dist, OOS_START, FULL_END);

  const trades = full.trades;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { cum += t.pnl; if (cum > peak) peak = cum; if (peak-cum > maxDD) maxDD = peak-cum; }

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

  const trailExits = trades.filter(t => t.reason === "trail").length;

  results.push({
    label, trades: trades.length, wr: trades.length > 0 ? wins.length/trades.length*100 : 0,
    pf: gl > 0 ? gp/gl : 99, total, perDay: total/days, maxDD, sharpe, blocked: full.blocked,
    trailExits,
    oosTotal, oosPerDay: oosTotal/oosDays, oosPf: oosGL > 0 ? oosGP/oosGL : 99,
  });

  console.log(` $${(total/days).toFixed(2)}/day, DD $${maxDD.toFixed(0)}, PF ${(gl > 0 ? gp/gl : 99).toFixed(2)}, ${trailExits} trails, ${full.blocked} blocked`);
}

// Sort by $/day
results.sort((a, b) => b.perDay - a.perDay);

console.log("\n" + "=".repeat(140));
console.log("FULL 3-ENGINE ENSEMBLE + POSITION POOL (max 20) + 1m TRAIL PRECISION");
console.log("Engines: Donchian $7 + Supertrend $5 + GARCH v2 $3 + Momentum $3 | 23 pairs + BTC filter | Full: 2023-01 to 2026-03 | OOS: 2025-09+");
console.log("=".repeat(140));

console.log(`\n${"Config".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(7)} ${"Total".padStart(12)} ${"$/day".padStart(10)} ${"PF".padStart(7)} ${"Sharpe".padStart(8)} ${"MaxDD".padStart(10)} ${"Blocked".padStart(8)} ${"Trails".padStart(7)} ${"OOS$/day".padStart(10)} ${"OOS PF".padStart(8)}`);
console.log("-".repeat(140));

for (const r of results) {
  const mark = r.label === "NO TRAIL" ? " <<<" : "";
  console.log(
    `${r.label.padEnd(12)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)}% ${("$"+r.total.toFixed(2)).padStart(12)} ${("$"+r.perDay.toFixed(2)).padStart(10)} ${r.pf.toFixed(2).padStart(7)} ${r.sharpe.toFixed(2).padStart(8)} ${("$"+r.maxDD.toFixed(0)).padStart(10)} ${String(r.blocked).padStart(8)} ${String(r.trailExits).padStart(7)} ${("$"+r.oosPerDay.toFixed(2)).padStart(10)} ${r.oosPf.toFixed(2).padStart(8)}${mark}`
  );
}

console.log("\n" + "=".repeat(140));
const noTrail = results.find(r => r.label === "NO TRAIL")!;
const bestTrail = results.filter(r => r.label !== "NO TRAIL")[0];
console.log(`NO TRAIL:    $${noTrail.perDay.toFixed(2)}/day, MaxDD $${noTrail.maxDD.toFixed(0)}, Sharpe ${noTrail.sharpe.toFixed(2)}, OOS $${noTrail.oosPerDay.toFixed(2)}/day`);
console.log(`BEST TRAIL:  ${bestTrail.label}: $${bestTrail.perDay.toFixed(2)}/day, MaxDD $${bestTrail.maxDD.toFixed(0)}, Sharpe ${bestTrail.sharpe.toFixed(2)}, OOS $${bestTrail.oosPerDay.toFixed(2)}/day`);
console.log(`TRAIL COST:  -$${(noTrail.perDay - bestTrail.perDay).toFixed(2)}/day (${((1 - bestTrail.perDay/noTrail.perDay)*100).toFixed(0)}% profit lost)`);

console.log("\nDone.");
