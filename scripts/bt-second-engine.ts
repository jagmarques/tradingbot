/**
 * Track 3: Second Engine Candidate Backtest
 * Tests 4 independent engines: RSI MR, BB Squeeze, Volume Spike, Stochastic
 * Same risk params as GARCH v2 deployed config
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const M15 = 15 * 60_000;
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;
const MARGIN = 7;
const NOT = MARGIN * LEV;

const SL_PCT = 0.005;
const SL_CAP = 0.01;
const BE_AT = 2;
const MAX_HOLD_H = 72;
const SL_COOLDOWN_H = 1;
const BLOCK_HOURS = [22, 23];
const MOM_LB = 3;
const VOL_WIN = 20;

const TRAIL_STEPS = [
  { activate: 10, dist: 5 }, { activate: 15, dist: 4 }, { activate: 20, dist: 3 },
  { activate: 25, dist: 2 }, { activate: 35, dist: 1.5 }, { activate: 50, dist: 1 },
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;
const REVERSE_MAP: Record<string, string> = { kPEPE: "1000PEPE", kFLOKI: "1000FLOKI", kBONK: "1000BONK", kSHIB: "1000SHIB" };

const PAIRS_53 = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","HYPE","FET",
  "FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR",
  "PENDLE","PNUT","ATOM","TON","SEI","STX",
];

const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

interface C { t: number; o: number; h: number; l: number; c: number; v?: number; }
interface Tr { pair: string; dir: "long"|"short"; ep: number; xp: number; et: number; xt: number; pnl: number; reason: string; }

function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b) ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: b[5] ? +b[5] : undefined }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
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
      t: ts, o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)), l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
      v: grp.reduce((s, b) => s + (b.v ?? 0), 0),
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - momLb]!.c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1; sumSq += r * r; count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    z[i] = mom / vol;
  }
  return z;
}

function calcPnl(dir: "long"|"short", ep: number, xp: number, sp: number, isSL: boolean): number {
  const slip = isSL ? sp * 1.5 : sp;
  const exitPx = dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
  const raw = dir === "long" ? (exitPx / ep - 1) * NOT : (ep / exitPx - 1) * NOT;
  return raw - NOT * FEE * 2;
}

function fmtPnl(v: number): string { return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2); }

// RSI calculation (Wilder's smoothing)
function calcRSI(closes: number[], period: number): number[] {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Bollinger Bands
function calcBB(closes: number[], period: number, mult: number): { upper: number[]; lower: number[]; mid: number[]; bw: number[] } {
  const n = closes.length;
  const upper = new Array(n).fill(0);
  const lower = new Array(n).fill(0);
  const mid = new Array(n).fill(0);
  const bw = new Array(n).fill(0);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]!;
    const sma = sum / period;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j]! - sma) ** 2;
    const std = Math.sqrt(sumSq / period);
    mid[i] = sma; upper[i] = sma + mult * std; lower[i] = sma - mult * std;
    bw[i] = sma > 0 ? (upper[i]! - lower[i]!) / sma : 0;
  }
  return { upper, lower, mid, bw };
}

// Stochastic K%
function calcStochastic(highs: number[], lows: number[], closes: number[], kPeriod: number, kSmooth: number): { k: number[]; d: number[] } {
  const n = closes.length;
  const rawK = new Array(n).fill(50);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, highs[j]!); ll = Math.min(ll, lows[j]!); }
    rawK[i] = hh === ll ? 50 : ((closes[i]! - ll) / (hh - ll)) * 100;
  }
  // Smooth K
  const k = new Array(n).fill(50);
  for (let i = kPeriod - 1 + kSmooth - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - kSmooth + 1; j <= i; j++) sum += rawK[j]!;
    k[i] = sum / kSmooth;
  }
  // D = SMA of K
  const d = new Array(n).fill(50);
  for (let i = kPeriod - 1 + kSmooth - 1 + 2; i < n; i++) {
    d[i] = (k[i]! + k[i - 1]! + k[i - 2]!) / 3;
  }
  return { k, d };
}

// SMA
function calcSMA(values: number[], period: number): number[] {
  const sma = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    sma[i] = sum / period;
  }
  return sma;
}

interface PairAllData {
  name: string; sp: number;
  m15: C[]; h1: C[]; h4: C[];
  z1h: number[]; z4h: number[];
  h1TsMap: Map<number, number>; m15TsMap: Map<number, number>; h4TsMap: Map<number, number>;
  // Pre-computed indicators
  rsi15m: number[];
  bbH1: { upper: number[]; lower: number[]; mid: number[]; bw: number[] };
  stochK15m: number[]; stochD15m: number[];
  sma50h4: number[];
  h1Ranges: number[]; h1AvgRange20: number[]; h1AvgVol20: number[];
}

function getLatest4hZ(z4h: number[], h4: C[], h4TsMap: Map<number, number>, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  let idx = h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return z4h[idx - 1]!;
  let lo = 0, hi = h4.length - 1, best = -1;
  while (lo <= hi) { const mid2 = (lo + hi) >> 1; if (h4[mid2]!.t < t) { best = mid2; lo = mid2 + 1; } else hi = mid2 - 1; }
  return best >= 0 ? z4h[best]! : 0;
}

// Generic engine runner with signal generator
type SignalFn = (p: PairAllData, ts: number, barIdx: number, timeframe: "15m"|"1h") => "long"|"short"|null;
type ExitFn = (p: PairAllData, pos: { dir: "long"|"short"; et: number }, ts: number, barIdx: number, timeframe: "15m"|"1h") => boolean;

function runEngine(
  allPairs: PairAllData[],
  signalFn: SignalFn,
  exitFn: ExitFn | null,
  timeframe: "15m"|"1h",
  label: string,
  slOverride?: number,
): { n: number; trPerDay: number; wr: number; pf: number; total: number; perDay: number; maxDD: number; entryTimes: number[] } {
  const oosDays = (OOS_END - OOS_START) / D;
  const periodMs = timeframe === "15m" ? M15 : H;

  const allTimestamps = new Set<number>();
  for (const p of allPairs) {
    const bars = timeframe === "15m" ? p.m15 : p.h1;
    for (const bar of bars) { if (bar.t >= OOS_START && bar.t < OOS_END) allTimestamps.add(bar.t); }
  }
  const timePoints = [...allTimestamps].sort((a, b) => a - b);

  interface OpenPos { pair: string; dir: "long"|"short"; ep: number; et: number; sl: number; peakPnlPct: number; sp: number; }
  const openPositions: OpenPos[] = [];
  const closedTrades: Tr[] = [];
  const cooldowns = new Map<string, number>();
  const entryTimes: number[] = [];
  const slPct = slOverride ?? SL_PCT;

  for (const ts of timePoints) {
    const hourOfDay = new Date(ts).getUTCHours();
    const isBlocked = BLOCK_HOURS.includes(hourOfDay);

    // EXIT
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const p = allPairs.find(pd => pd.name === pos.pair);
      if (!p) continue;
      const bars = timeframe === "15m" ? p.m15 : p.h1;
      const tsMap = timeframe === "15m" ? p.m15TsMap : p.h1TsMap;
      const barIdx = tsMap.get(ts);
      if (barIdx === undefined) continue;
      const bar = bars[barIdx]!;

      let xp = 0, reason = "", isSL = false;
      const hoursHeld = (ts - pos.et) / H;
      if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }
      if (!xp && pos.peakPnlPct >= BE_AT) {
        const beHit = pos.dir === "long" ? bar.l <= pos.ep : bar.h >= pos.ep;
        if (beHit) { xp = pos.ep; reason = "be"; }
      }
      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }
      // Signal-based exit
      if (!xp && exitFn) {
        const shouldExit = exitFn(p, { dir: pos.dir, et: pos.et }, ts, barIdx, timeframe);
        if (shouldExit) { xp = bar.c; reason = "signal"; }
      }
      if (!xp) {
        const best = pos.dir === "long" ? (bar.h / pos.ep - 1) * LEV * 100 : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;
        const curr = pos.dir === "long" ? (bar.c / pos.ep - 1) * LEV * 100 : (pos.ep / bar.c - 1) * LEV * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) { if (pos.peakPnlPct >= step.activate) trailDist = step.dist; }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) { xp = bar.c; reason = "trail"; }
      }
      if (xp > 0) {
        const pnl = calcPnl(pos.dir, pos.ep, xp, pos.sp, isSL);
        closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: ts, pnl, reason });
        openPositions.splice(i, 1);
        if (reason === "sl") cooldowns.set(`${pos.pair}:${pos.dir}`, ts + SL_COOLDOWN_H * H);
      }
    }

    if (isBlocked) continue;

    // ENTRY
    for (const p of allPairs) {
      if (openPositions.some(op => op.pair === p.name)) continue;
      const tsMap = timeframe === "15m" ? p.m15TsMap : p.h1TsMap;
      const barIdx = tsMap.get(ts);
      if (barIdx === undefined || barIdx < 50) continue;

      const dir = signalFn(p, ts, barIdx, timeframe);
      if (!dir) continue;

      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && ts < cdUntil) continue;

      const bars = timeframe === "15m" ? p.m15 : p.h1;
      const bar = bars[barIdx]!;
      const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slDist = Math.min(ep * slPct, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      openPositions.push({ pair: p.name, dir, ep, et: ts, sl, peakPnlPct: 0, sp: p.sp });
      entryTimes.push(ts);
    }
  }

  for (const pos of openPositions) {
    const p = allPairs.find(pd => pd.name === pos.pair);
    if (!p) continue;
    const bars = timeframe === "15m" ? p.m15 : p.h1;
    const lastBar = bars[bars.length - 1]!;
    const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, pos.sp, false);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
  }

  const sorted = [...closedTrades].sort((a, b) => a.xt - b.xt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0).length;
  const wr = sorted.length > 0 ? wins / sorted.length * 100 : 0;
  const grossProfit = sorted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(sorted.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const perDay = totalPnl / oosDays;
  const trPerDay = sorted.length / oosDays;

  console.log(
    `  ${label.padEnd(38)} ${String(sorted.length).padStart(5)} ${trPerDay.toFixed(1).padStart(6)} ${(wr.toFixed(1)+"%").padStart(6)} ${pf.toFixed(2).padStart(5)} ${fmtPnl(totalPnl).padStart(9)} ${fmtPnl(perDay).padStart(8)} $${maxDD.toFixed(0).padStart(4)}`
  );

  return { n: sorted.length, trPerDay, wr, pf, total: totalPnl, perDay, maxDD, entryTimes };
}

function main() {
  console.log("=".repeat(100));
  console.log("  TRACK 3: SECOND ENGINE CANDIDATES");
  console.log("  RSI MR | BB Squeeze | Volume Spike | Stochastic");
  console.log("  53 pairs, OOS 2025-06-01 to 2026-03-25, $7 margin");
  console.log("=".repeat(100));

  console.log("\n  Loading 53 pairs with all indicators...");
  const allPairs: PairAllData[] = [];
  for (const name of PAIRS_53) {
    const sym = REVERSE_MAP[name] ?? name;
    let raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) raw5m = load5m(`${name}USDT`);
    if (raw5m.length < 5000) continue;

    const m15 = aggregate(raw5m, M15, 2);
    const h1 = aggregate(raw5m, H, 10);
    const h4 = aggregate(raw5m, H4, 40);
    if (h1.length < 100 || h4.length < 50) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
    const h1TsMap = new Map<number, number>(); h1.forEach((c, i) => h1TsMap.set(c.t, i));
    const m15TsMap = new Map<number, number>(); m15.forEach((c, i) => m15TsMap.set(c.t, i));
    const h4TsMap = new Map<number, number>(); h4.forEach((c, i) => h4TsMap.set(c.t, i));

    const rsi15m = calcRSI(m15.map(c => c.c), 14);
    const bbH1 = calcBB(h1.map(c => c.c), 20, 2);
    const stoch = calcStochastic(m15.map(c => c.h), m15.map(c => c.l), m15.map(c => c.c), 14, 3);
    const sma50h4 = calcSMA(h4.map(c => c.c), 50);

    const h1Ranges = h1.map(c => c.h - c.l);
    const h1AvgRange20 = calcSMA(h1Ranges, 20);
    const h1Vols = h1.map(c => c.v ?? 0);
    const h1AvgVol20 = calcSMA(h1Vols, 20);

    allPairs.push({
      name, sp: SP[name] ?? DEFAULT_SPREAD,
      m15, h1, h4, z1h, z4h, h1TsMap, m15TsMap, h4TsMap,
      rsi15m, bbH1, stochK15m: stoch.k, stochD15m: stoch.d,
      sma50h4, h1Ranges, h1AvgRange20, h1AvgVol20,
    });
  }
  console.log(`  Loaded ${allPairs.length} pairs\n`);

  const hdr = `  ${"Engine".padEnd(38)} ${"Trades".padStart(5)} ${"Tr/d".padStart(6)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"PnL".padStart(9)} ${"$/day".padStart(8)} ${"MaxDD".padStart(5)}`;

  // ─── Engine A: RSI Mean Reversion (15m) ───
  console.log("--- ENGINE A: RSI MEAN REVERSION (15m) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(83));

  const rsiThresholds = [15, 20, 25];
  const rsiZ4hFilters = [0, 0.5, 1.0, 1.5];
  let bestRSI = { perDay: -Infinity, label: "", entryTimes: [] as number[] };

  for (const thresh of rsiThresholds) {
    for (const z4hMin of rsiZ4hFilters) {
      const label = `RSI(14)<${thresh} z4h>${z4hMin}`;
      const result = runEngine(allPairs, (p, ts, barIdx) => {
        const rsi = p.rsi15m[barIdx - 1]!;
        const z4h = getLatest4hZ(p.z4h, p.h4, p.h4TsMap, ts);
        if (rsi < thresh && z4h > z4hMin) return "long";
        if (rsi > (100 - thresh) && z4h < -z4hMin) return "short";
        return null;
      }, (p, pos, ts, barIdx) => {
        const rsi = p.rsi15m[barIdx]!;
        return (pos.dir === "long" && rsi > 50) || (pos.dir === "short" && rsi < 50);
      }, "15m", label);
      if (result.perDay > bestRSI.perDay) bestRSI = { perDay: result.perDay, label, entryTimes: result.entryTimes };
    }
  }

  // ─── Engine B: BB Squeeze Breakout (1h) ───
  console.log("\n--- ENGINE B: BOLLINGER BAND SQUEEZE BREAKOUT (1h) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(83));

  const bwThresholds = [0.02, 0.03, 0.04, 0.05];
  const squeezeLookbacks = [5, 10, 15];
  let bestBB = { perDay: -Infinity, label: "", entryTimes: [] as number[] };

  for (const bwThresh of bwThresholds) {
    for (const sqLb of squeezeLookbacks) {
      const label = `BB bw<${bwThresh} sq${sqLb}`;
      const result = runEngine(allPairs, (p, ts, barIdx) => {
        if (barIdx < sqLb + 2) return null;
        const bb = p.bbH1;
        const prev = barIdx - 1; // use COMPLETED bar for signal (no look-ahead)
        // Check if we were in squeeze for sqLb bars BEFORE the signal bar
        let inSqueeze = true;
        for (let j = prev - sqLb; j < prev; j++) {
          if (bb.bw[j]! > bwThresh) { inSqueeze = false; break; }
        }
        if (!inSqueeze) return null;
        // Previous completed bar broke out
        const prevClose = p.h1[prev]!.c;
        if (prevClose > bb.upper[prev - 1]!) return "long";
        if (prevClose < bb.lower[prev - 1]!) return "short";
        return null;
      }, null, "1h", label);
      if (result.perDay > bestBB.perDay) bestBB = { perDay: result.perDay, label, entryTimes: result.entryTimes };
    }
  }

  // ─── Engine C: Volume Spike Reversal (1h) ───
  console.log("\n--- ENGINE C: VOLUME SPIKE REVERSAL (1h) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(83));

  const volMults = [2, 3, 4];
  const rangeMults = [1.5, 2, 2.5];
  let bestVol = { perDay: -Infinity, label: "", entryTimes: [] as number[] };

  for (const vm of volMults) {
    for (const rm of rangeMults) {
      const label = `VolSpike ${vm}x range${rm}x`;
      const result = runEngine(allPairs, (p, ts, barIdx) => {
        if (barIdx < 24) return null;
        const prev = barIdx - 1; // use COMPLETED bar for signal (no look-ahead)
        const bar = p.h1[prev]!;
        const vol = bar.v ?? 0;
        const avgVol = p.h1AvgVol20[prev - 1]!;
        const range = bar.h - bar.l;
        const avgRange = p.h1AvgRange20[prev - 1]!;
        if (avgVol <= 0 || avgRange <= 0) return null;
        if (vol < vm * avgVol) return null;
        if (range < rm * avgRange) return null;
        // Determine prior 3-bar direction (before the signal bar)
        let priorBullish = 0;
        for (let j = prev - 3; j < prev; j++) {
          if (p.h1[j]!.c > p.h1[j]!.o) priorBullish++;
        }
        // Reversal: signal bar closes opposite to prior direction
        const barBullish = bar.c > bar.o;
        if (priorBullish >= 2 && !barBullish) return "short";
        if (priorBullish <= 1 && barBullish) return "long";
        return null;
      }, null, "1h", label);
      if (result.perDay > bestVol.perDay) bestVol = { perDay: result.perDay, label, entryTimes: result.entryTimes };
    }
  }

  // ─── Engine D: Stochastic Oversold/Overbought (15m) ───
  console.log("\n--- ENGINE D: STOCHASTIC OVERSOLD/OVERBOUGHT (15m) ---\n");
  console.log(hdr);
  console.log("  " + "-".repeat(83));

  const stochThresholds = [10, 15, 20];
  let bestStoch = { perDay: -Infinity, label: "", entryTimes: [] as number[] };

  for (const thresh of stochThresholds) {
    for (const useH4Filter of [true, false]) {
      const label = `Stoch K<${thresh} ${useH4Filter ? "+h4trend" : "nofilter"}`;
      const result = runEngine(allPairs, (p, ts, barIdx) => {
        const k = p.stochK15m[barIdx - 1]!;
        const d = p.stochD15m[barIdx - 1]!;
        if (useH4Filter) {
          // Find h4 bar for trend check
          const h4Bucket = Math.floor(ts / H4) * H4;
          const h4Idx = p.h4TsMap.get(h4Bucket);
          if (h4Idx === undefined || h4Idx < 50) return null;
          const price = p.h4[h4Idx]!.c;
          const sma50 = p.sma50h4[h4Idx]!;
          if (k < thresh && d < thresh + 5 && price > sma50) return "long";
          if (k > (100 - thresh) && d > (100 - thresh - 5) && price < sma50) return "short";
        } else {
          if (k < thresh && d < thresh + 5) return "long";
          if (k > (100 - thresh) && d > (100 - thresh - 5)) return "short";
        }
        return null;
      }, (p, pos, ts, barIdx) => {
        const k = p.stochK15m[barIdx]!;
        return (pos.dir === "long" && k > 50) || (pos.dir === "short" && k < 50);
      }, "15m", label);
      if (result.perDay > bestStoch.perDay) bestStoch = { perDay: result.perDay, label, entryTimes: result.entryTimes };
    }
  }

  // ─── Summary + GARCH baseline for comparison ───
  console.log("\n" + "=".repeat(100));
  console.log("  BEST FROM EACH ENGINE vs GARCH BASELINE");
  console.log("=".repeat(100));
  console.log(`\n${hdr}`);
  console.log("  " + "-".repeat(83));

  // Run GARCH v2 baseline for comparison
  const garchResult = runEngine(allPairs, (p, ts, barIdx) => {
    const z = p.z1h[barIdx - 1]!;
    const z4h = getLatest4hZ(p.z4h, p.h4, p.h4TsMap, ts);
    if (z > 3.0 && z4h > 2.5) return "long";
    if (z < -3.0 && z4h < -2.5) return "short";
    return null;
  }, null, "1h", "GARCH v2 baseline (1h z3.0/2.5)");

  console.log(`\n  Best RSI:   ${bestRSI.label} -> ${fmtPnl(bestRSI.perDay)}/day`);
  console.log(`  Best BB:    ${bestBB.label} -> ${fmtPnl(bestBB.perDay)}/day`);
  console.log(`  Best Vol:   ${bestVol.label} -> ${fmtPnl(bestVol.perDay)}/day`);
  console.log(`  Best Stoch: ${bestStoch.label} -> ${fmtPnl(bestStoch.perDay)}/day`);

  // Correlation check: overlap of best engine entries with GARCH
  const best = [
    { label: "RSI", ...bestRSI },
    { label: "BB", ...bestBB },
    { label: "Vol", ...bestVol },
    { label: "Stoch", ...bestStoch },
  ].sort((a, b) => b.perDay - a.perDay);

  console.log("\n  Entry overlap with GARCH (within 4h window):");
  for (const eng of best) {
    if (eng.entryTimes.length === 0) continue;
    let overlap = 0;
    for (const et of eng.entryTimes) {
      if (garchResult.entryTimes.some(gt => Math.abs(gt - et) < 4 * H)) overlap++;
    }
    const pct = eng.entryTimes.length > 0 ? (overlap / eng.entryTimes.length * 100).toFixed(1) : "0.0";
    console.log(`    ${eng.label.padEnd(8)}: ${overlap}/${eng.entryTimes.length} entries overlap (${pct}%)`);
  }
}

main();
