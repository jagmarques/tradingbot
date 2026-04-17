/**
 * Grid search for optimal $90 equity config.
 * GARCH + ST engine combos, multiple sizes, z-scores, trail modes, max positions.
 * Hard constraint: MaxDD <= $60.
 * Uses 5m bars for SL/TP/trail simulation — no 1m data needed, memory-efficient.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-optimal-90.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_5 = 5 * 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_DD_LIMIT = 60;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();
const FULL_DAYS  = (FULL_END - FULL_START) / D;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

// --------------- data loading ---------------
function loadJson5m(pair: string): C[] {
  const fp = path.join(CD_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw
    .map((b: any) =>
      Array.isArray(b)
        ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
        : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c },
    )
    .sort((a: C, b: C) => a.t - b.t);
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
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// --------------- indicators ---------------
function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
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

function calcSupertrend(cs: C[], p: number, m: number): { dir: Int8Array; atr: number[] } {
  const atr = calcATR(cs, p);
  const dirs = new Int8Array(cs.length).fill(1);
  const ub = new Float64Array(cs.length);
  const lb = new Float64Array(cs.length);
  for (let i = p; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let u = hl2 + m * atr[i];
    let l = hl2 - m * atr[i];
    if (i > p) {
      if (!(l > lb[i - 1] || cs[i - 1].c < lb[i - 1])) l = lb[i - 1];
      if (!(u < ub[i - 1] || cs[i - 1].c > ub[i - 1])) u = ub[i - 1];
    }
    ub[i] = u;
    lb[i] = l;
    if (i === p) dirs[i] = cs[i].c > u ? 1 : -1;
    else dirs[i] = dirs[i - 1] === 1 ? (cs[i].c < l ? -1 : 1) : (cs[i].c > u ? 1 : -1);
  }
  return { dir: dirs, atr };
}

function computeZScores(cs: C[], momLb: number, volWin: number): Float64Array {
  const z = new Float64Array(cs.length);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i].c / cs[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j].c / cs[j - 1].c - 1;
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

// --------------- cost helpers ---------------
function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function applyEntryPx(pair: string, dir: "long" | "short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function applyExitPx(pair: string, dir: "long" | "short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long" | "short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// --------------- load all data ---------------
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson5m(p);
  if (d.length > 0) raw5m.set(p, d);
  else process.stdout.write(`  [WARN] missing 5m: ${p}\n`);
}

// Aggregate from 5m
const h4DataMap = new Map<string, C[]>();
const h1DataMap = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4DataMap.set(p, aggregate(bars, H4, 40));
  h1DataMap.set(p, aggregate(bars, H, 10));
}

// BTC 4h EMA(12/21) filter
const btcH4 = h4DataMap.get("BTC");
if (!btcH4 || btcH4.length === 0) throw new Error("BTC 5m data missing — run download-5m-candles.ts first");
const btcH4Ema12 = calcEMA(btcH4.map(c => c.c), 12);
const btcH4Ema21 = calcEMA(btcH4.map(c => c.c), 21);
function btcBullish4h(t: number): boolean {
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

// BTC h1 EMA(9/21) for GARCH trend filter
const btcH1 = h1DataMap.get("BTC")!;
const btcH1Ema9  = calcEMA(btcH1.map(c => c.c), 9);
const btcH1Ema21 = calcEMA(btcH1.map(c => c.c), 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));
function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21[prev]) return "short";
  return null;
}

console.log("Building per-pair indicators...");

interface PairData {
  // 4h indicators
  h4: C[];
  h4StDir: Int8Array;
  h4ATR: number[];
  h4TsMap: Map<number, number>;
  h4Z: Float64Array;
  // 1h indicators
  h1: C[];
  h1Z: Float64Array;
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  // 5m bars for SL/TP/trail simulation
  bars5m: C[];
  bars5mTsMap: Map<number, number>;
}

const pairData = new Map<string, PairData>();

for (const pair of PAIRS) {
  const h4 = h4DataMap.get(pair) ?? [];
  const { dir: h4StDir, atr: h4ATRarr } = calcSupertrend(h4, 14, 1.75);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h4Z = computeZScores(h4, 3, 20);

  const h1 = h1DataMap.get(pair) ?? [];
  const h1Closes = h1.map(c => c.c);
  const h1Z = computeZScores(h1, 3, 20);
  const h1Ema9  = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const bars5m = raw5m.get(pair) ?? [];
  const bars5mTsMap = new Map<number, number>();
  bars5m.forEach((c, i) => bars5mTsMap.set(c.t, i));

  pairData.set(pair, {
    h4, h4StDir, h4ATR: h4ATRarr, h4TsMap, h4Z,
    h1, h1Z, h1Ema9, h1Ema21, h1TsMap,
    bars5m, bars5mTsMap,
  });
}

// Free memory: no longer need raw aggregated h4/h1 maps (pairData holds references)
h4DataMap.clear();
h1DataMap.clear();
// raw5m is still needed for bars5m (shared reference, no dup)

console.log("Data ready.\n");

// --------------- binary search 5m ---------------
function get5mBar(pd: PairData, t: number): C | null {
  // 5m buckets: find the bar whose timestamp <= t (last completed 5m bar at time t)
  const bucket = Math.floor(t / MIN_5) * MIN_5;
  const idx = pd.bars5mTsMap.get(bucket);
  if (idx === undefined) return null;
  return pd.bars5m[idx];
}

// --------------- signal types ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
  engine: "G" | "S";
  size: number;
}

// GARCH check at 1h boundary
function checkGarch(
  pair: string, t: number,
  z1Long: number, z1Short: number,
  z4Long: number, z4Short: number,
  size: number,
): SignalResult | null {
  const pd = pairData.get(pair)!;
  const h1 = pd.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = pd.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;

  const prev = barIdx - 1;
  if (prev < 23) return null;

  const z1 = pd.h1Z[prev];
  if (!z1) return null;
  const goLong  = z1 > z1Long;
  const goShort = z1 < -z1Short;
  if (!goLong && !goShort) return null;

  // 4h z check
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = pd.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = pd.h4Z[idx4h];
  if (goLong  && z4 <= z4Long)  return null;
  if (goShort && z4 >= -z4Short) return null;

  // EMA filter
  if (!pd.h1Ema9[prev] || !pd.h1Ema21[prev]) return null;
  if (goLong  && pd.h1Ema9[prev] <= pd.h1Ema21[prev]) return null;
  if (goShort && pd.h1Ema9[prev] >= pd.h1Ema21[prev]) return null;

  // BTC h1 trend
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[barIdx].o;
  let sl = dir === "long" ? ep * 0.97 : ep * 1.03;
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else                sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "G", size };
}

function checkGarchReentry(
  pair: string, t: number, wantDir: "long" | "short",
  z1Long: number, z1Short: number,
  z4Long: number, z4Short: number,
  size: number,
): SignalResult | null {
  const sig = checkGarch(pair, t, z1Long, z1Short, z4Long, z4Short, size);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// Supertrend check at 4h boundary
function checkST(pair: string, t: number, size: number): SignalResult | null {
  const pd = pairData.get(pair)!;
  const cs = pd.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = pd.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;

  const i = barIdx;
  const flip = pd.h4StDir[i - 1] !== pd.h4StDir[i - 2];
  if (!flip) return null;

  const dir: "long" | "short" = pd.h4StDir[i - 1] === 1 ? "long" : "short";
  if (dir === "long" && !btcBullish4h(cs[i].t)) return null;

  const prevATR = pd.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = dir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else                sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl, engine: "S", size };
}

function checkSTReentry(pair: string, t: number, wantDir: "long" | "short", size: number): SignalResult | null {
  const pd = pairData.get(pair)!;
  const cs = pd.h4;
  if (cs.length < 50) return null;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = pd.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;

  const i = barIdx;
  const stActive = pd.h4StDir[i - 1] === (wantDir === "long" ? 1 : -1);
  if (!stActive) return null;
  if (wantDir === "long" && !btcBullish4h(cs[i].t)) return null;

  const prevATR = pd.h4ATR[i - 1];
  if (prevATR <= 0) return null;
  const ep = cs[i].o;
  let sl = wantDir === "long" ? ep - 3 * prevATR : ep + 3 * prevATR;
  if (wantDir === "long") sl = Math.max(sl, ep * 0.965);
  else                    sl = Math.min(sl, ep * 1.035);

  return { dir: wantDir, entryPrice: ep, sl, engine: "S", size };
}

// GARCH exit: max hold 96h, TP 7%  (checked at 1h boundary using h1 bar)
function checkGarchExit(
  pair: string, t: number,
  dir: "long" | "short",
  entryTime: number, entryPrice: number,
): { exit: boolean; price: number; reason: string } | null {
  const pd = pairData.get(pair)!;
  const h1 = pd.h1;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = pd.h1TsMap.get(h1Bucket);
  if (barIdx === undefined) return null;
  const bar = h1[barIdx];

  if ((bar.t - entryTime) / H >= 96) return { exit: true, price: bar.c, reason: "mh" };

  const tp = dir === "long" ? entryPrice * 1.07 : entryPrice * 0.93;
  if (dir === "long"  && bar.h >= tp) return { exit: true, price: tp, reason: "tp" };
  if (dir === "short" && bar.l <= tp) return { exit: true, price: tp, reason: "tp" };

  return null;
}

// ST exit: flip on 4h or max hold 60d
function checkSTExit(
  pair: string, t: number,
  dir: "long" | "short",
  entryTime: number,
): { exit: boolean; price: number; reason: string } | null {
  const pd = pairData.get(pair)!;
  const cs = pd.h4;
  const h4Bucket = Math.floor(t / H4) * H4;
  const barIdx = pd.h4TsMap.get(h4Bucket);
  if (barIdx === undefined || barIdx < 17) return null;
  const bar = cs[barIdx];

  if ((bar.t - entryTime) / H >= 60 * 24) return { exit: true, price: bar.c, reason: "mh" };

  const flip = pd.h4StDir[barIdx - 1] !== pd.h4StDir[barIdx - 2];
  if (flip) return { exit: true, price: bar.o, reason: "flip" };

  return null;
}

// --------------- position types ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  engine: "G" | "S";
  size: number;
  entryPrice: number;
  effectiveEP: number;
  sl: number;
  entryTime: number;
  peakPnlPct: number;
  isReentry: boolean;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  engine: "G" | "S";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReentry: boolean;
}

interface PendingReentry {
  pair: string;
  dir: "long" | "short";
  engine: "G" | "S";
  checkTime: number;
}

// --------------- simulation config ---------------
interface SimConfig {
  garchSize: number;
  stSize: number;
  maxPos: number;
  z1Long: number;
  z1Short: number;
  z4Long: number;
  z4Short: number;
  trailMode: "none" | "all" | "garch-only";
  trailAct: number;
  trailDist: number;
  reentry: boolean;
}

interface SimResult {
  label: string;
  cfg: SimConfig;
  trades: number;
  reentries: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  trailExits: number;
  oosTotal: number;
  oosPerDay: number;
  oosPf: number;
  tradesPerDay: number;
  blocked: number;
}

function runSim(cfg: SimConfig): { trades: ClosedTrade[]; reentries: number; blocked: number } {
  const { garchSize, stSize, maxPos, z1Long, z1Short, z4Long, z4Short,
          trailMode, trailAct, trailDist, reentry } = cfg;

  const useGarch = garchSize > 0;
  const useST    = stSize > 0;

  const openPositions: Position[]       = [];
  const closedTrades: ClosedTrade[]     = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;
  let blockedCount = 0;

  function hasOpenPos(engine: "G" | "S", pair: string): boolean {
    return openPositions.some(p => p.engine === engine && p.pair === pair);
  }
  function is4hBoundary(t: number): boolean { return t % H4 === 0; }
  function is1hBoundary(t: number): boolean { return t % H === 0; }
  function is5mBoundary(t: number): boolean { return t % MIN_5 === 0; }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = pos.size * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir, engine: pos.engine,
      entryTime: pos.entryTime, exitTime, pnl, reason,
      isReentry: pos.isReentry,
    });

    if (reason === "trail" && reentry) {
      const checkTime = pos.engine === "G"
        ? (Math.floor(exitTime / H) + 1) * H
        : (Math.floor(exitTime / H4) + 1) * H4;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, engine: pos.engine, checkTime });
    }

    openPositions.splice(idx, 1);
  }

  function tryOpen(sig: SignalResult, pair: string, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= maxPos) { blockedCount++; return false; }
    if (hasOpenPos(sig.engine, pair))    { blockedCount++; return false; }
    const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
    openPositions.push({
      pair, dir: sig.dir, engine: sig.engine, size: sig.size,
      entryPrice: sig.entryPrice, effectiveEP: ep, sl: sig.sl,
      entryTime: t, peakPnlPct: 0, isReentry,
    });
    if (isReentry) reentryCount++;
    return true;
  }

  // Main simulation loop stepping at 5m resolution
  for (let t = FULL_START; t < FULL_END; t += MIN_5) {
    // --- 1) SL, TP, trail on each 5m bar ---
    if (is5mBoundary(t) && openPositions.length > 0) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const pd  = pairData.get(pos.pair)!;
        const bar = get5mBar(pd, t);
        if (!bar) continue;

        // SL check
        if (pos.dir === "long"  && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }
        if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }

        // GARCH TP 7%
        if (pos.engine === "G") {
          const tp = pos.dir === "long" ? pos.entryPrice * 1.07 : pos.entryPrice * 0.93;
          if (pos.dir === "long"  && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
          if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }
        }

        // Peak PnL tracking (leveraged %)
        const bestPct = pos.dir === "long"
          ? (bar.h / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.l - 1) * LEV * 100;
        if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

        // Trail
        const doTrail = trailMode === "all" || (trailMode === "garch-only" && pos.engine === "G");
        if (doTrail && trailAct > 0 && pos.peakPnlPct >= trailAct) {
          const currPct = pos.dir === "long"
            ? (bar.c / pos.entryPrice - 1) * LEV * 100
            : (pos.entryPrice / bar.c - 1) * LEV * 100;
          if (currPct <= pos.peakPnlPct - trailDist) { closePos(pi, t, bar.c, "trail", false); continue; }
        }
      }
    }

    // --- 2) Engine-specific exits at interval boundaries ---
    if (is1hBoundary(t) && useGarch) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine !== "G") continue;
        const ex = checkGarchExit(pos.pair, t, pos.dir, pos.entryTime, pos.entryPrice);
        if (ex?.exit) closePos(pi, t, ex.price, ex.reason, false);
      }
    }

    if (is4hBoundary(t) && useST) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        if (pos.engine !== "S") continue;
        const ex = checkSTExit(pos.pair, t, pos.dir, pos.entryTime);
        if (ex?.exit) closePos(pi, t, ex.price, ex.reason, false);
      }
    }

    // --- 3) New entries at engine boundaries ---
    if (is1hBoundary(t) && useGarch) {
      for (const pair of PAIRS) {
        const sig = checkGarch(pair, t, z1Long, z1Short, z4Long, z4Short, garchSize);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    if (is4hBoundary(t) && useST) {
      for (const pair of PAIRS) {
        const sig = checkST(pair, t, stSize);
        if (sig) tryOpen(sig, pair, t, false);
      }
    }

    // --- 4) Pending re-entries ---
    if (reentry && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;

        const isBoundary = (re.engine === "G" && is1hBoundary(t)) || (re.engine === "S" && is4hBoundary(t));
        if (!isBoundary) continue;

        pendingReentries.splice(ri, 1);

        let sig: SignalResult | null = null;
        if (re.engine === "G") sig = checkGarchReentry(re.pair, t, re.dir, z1Long, z1Short, z4Long, z4Short, garchSize);
        else if (re.engine === "S") sig = checkSTReentry(re.pair, t, re.dir, stSize);

        if (sig) tryOpen(sig, re.pair, t, true);
      }
    }
  }

  // Close remaining positions at end of period using last known 5m close
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const pd = pairData.get(pos.pair);
    if (!pd || pd.bars5m.length === 0) continue;
    const lastBar = pd.bars5m[pd.bars5m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return { trades: closedTrades, reentries: reentryCount, blocked: blockedCount };
}

// --------------- metrics ---------------
function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number) {
  const days = (endTs - startTs) / D;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp  = wins.reduce((s, t) => s + t.pnl, 0);
  const gl  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std  = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const trailExits = trades.filter(t => t.reason === "trail").length;

  return {
    wr:  trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf:  gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits,
  };
}

// --------------- build grid ---------------
const GARCH_SIZES  = [3, 5, 7, 9];
const ST_SIZES     = [0, 3, 5];
const MAX_POSITIONS = [5, 6, 7, 8, 10];
const Z_MODES: Array<"strict" | "moderate"> = ["strict", "moderate"];
const TRAIL_MODES: Array<"none" | "all" | "garch-only"> = ["none", "all", "garch-only"];

const configs: SimConfig[] = [];

for (const garchSize of GARCH_SIZES) {
  for (const stSize of ST_SIZES) {
    for (const maxPos of MAX_POSITIONS) {
      for (const zMode of Z_MODES) {
        for (const trailMode of TRAIL_MODES) {
          // Deduplicate: stSize=0 + trail-all is identical to stSize=0 + trail-G
          if (stSize === 0 && trailMode === "all") continue;

          const z1Long  = zMode === "strict" ? 4.5 : 3.5;
          const z1Short = zMode === "strict" ? 3.0 : 2.5;
          const z4Long  = zMode === "strict" ? 3.0 : 2.5;
          const z4Short = zMode === "strict" ? 3.0 : 2.5;
          const reentry = trailMode !== "none";

          configs.push({
            garchSize, stSize, maxPos,
            z1Long, z1Short, z4Long, z4Short,
            trailMode,
            trailAct:  reentry ? 40 : 0,
            trailDist: reentry ? 3  : 0,
            reentry,
          });
        }
      }
    }
  }
}

console.log(`Grid: ${configs.length} configurations to test\n`);

// --------------- run all configs ---------------
const allResults: SimResult[] = [];
let doneCount = 0;
let rejectedDD = 0;
let rejectedNeg = 0;

for (const cfg of configs) {
  const label = [
    `G$${cfg.garchSize}`,
    cfg.stSize > 0 ? `S$${cfg.stSize}` : "ST-off",
    `p${cfg.maxPos}`,
    cfg.z1Long === 4.5 ? "Z-strict" : "Z-mod",
    cfg.trailMode === "none"      ? "no-trail"
      : cfg.trailMode === "all"   ? "trail-all"
      : "trail-G",
  ].join(" ");

  process.stdout.write(`[${++doneCount}/${configs.length}] ${label}... `);

  const { trades: allTrades, reentries, blocked } = runSim(cfg);

  const fullMetrics = computeMetrics(allTrades, FULL_START, FULL_END);
  const oosTrades   = allTrades.filter(t => t.entryTime >= OOS_START);
  const oosMetrics  = computeMetrics(oosTrades, OOS_START, FULL_END);

  if (fullMetrics.maxDD > MAX_DD_LIMIT) {
    console.log(`REJECTED MaxDD=$${fullMetrics.maxDD.toFixed(0)}`);
    rejectedDD++;
    continue;
  }
  if (fullMetrics.perDay <= 0) {
    console.log(`REJECTED $/day=$${fullMetrics.perDay.toFixed(3)}`);
    rejectedNeg++;
    continue;
  }

  allResults.push({
    label, cfg,
    trades: allTrades.length,
    reentries, blocked,
    wr: fullMetrics.wr,
    pf: fullMetrics.pf,
    total: fullMetrics.total,
    perDay: fullMetrics.perDay,
    maxDD: fullMetrics.maxDD,
    sharpe: fullMetrics.sharpe,
    trailExits: fullMetrics.trailExits,
    oosTotal: oosMetrics.total,
    oosPerDay: oosMetrics.perDay,
    oosPf: oosMetrics.pf,
    tradesPerDay: allTrades.length / FULL_DAYS,
  });

  console.log(`ok  $/d=$${fullMetrics.perDay.toFixed(3)}  DD=$${fullMetrics.maxDD.toFixed(0)}  Sh=${fullMetrics.sharpe.toFixed(2)}  OOS=$${oosMetrics.perDay.toFixed(3)}`);
}

// --------------- print results ---------------
const SEP    = "=".repeat(175);
const DASHES = "-".repeat(175);

function printTable(rows: SimResult[], title: string): void {
  console.log(`\n${SEP}`);
  console.log(title);
  console.log(SEP);
  const hdr = [
    "Config".padEnd(44),
    "Trades".padStart(7),
    "T/day".padStart(6),
    "WR%".padStart(7),
    "Total".padStart(10),
    "$/day".padStart(9),
    "PF".padStart(7),
    "Sharpe".padStart(8),
    "MaxDD".padStart(9),
    "Trail".padStart(7),
    "OOS$/d".padStart(9),
    "OOSPF".padStart(7),
  ].join(" ");
  console.log(hdr);
  console.log(DASHES);
  for (const r of rows) {
    console.log([
      r.label.padEnd(44),
      String(r.trades).padStart(7),
      r.tradesPerDay.toFixed(2).padStart(6),
      r.wr.toFixed(1).padStart(6) + "%",
      ("$" + r.total.toFixed(1)).padStart(10),
      ("$" + r.perDay.toFixed(3)).padStart(9),
      r.pf.toFixed(2).padStart(7),
      r.sharpe.toFixed(2).padStart(8),
      ("$" + r.maxDD.toFixed(0)).padStart(9),
      String(r.trailExits).padStart(7),
      ("$" + r.oosPerDay.toFixed(3)).padStart(9),
      r.oosPf.toFixed(2).padStart(7),
    ].join(" "));
  }
}

console.log(`\n\n${SEP}`);
console.log(`GRID SEARCH COMPLETE`);
console.log(`Tested: ${configs.length}  |  Passed: ${allResults.length}  |  Rejected DD: ${rejectedDD}  |  Rejected negative: ${rejectedNeg}`);

const top15ByPerDay = [...allResults].sort((a, b) => b.perDay   - a.perDay).slice(0, 15);
const top5BySharpe  = [...allResults].sort((a, b) => b.sharpe   - a.sharpe).slice(0, 5);
const top5ByOOS     = [...allResults].sort((a, b) => b.oosPerDay - a.oosPerDay).slice(0, 5);

printTable(top15ByPerDay, "TOP 15 BY $/DAY  (MaxDD <= $60, positive $/day)");
printTable(top5BySharpe,  "TOP 5 BY SHARPE");
printTable(top5ByOOS,     "TOP 5 BY OOS $/DAY");

// Detailed breakdown for #1 overall
const best = top15ByPerDay[0];
if (best) {
  console.log(`\n${SEP}`);
  console.log(`BEST CONFIG DETAIL: ${best.label}`);
  console.log(SEP);
  console.log(`  GARCH size:    $${best.cfg.garchSize}  (notional $${best.cfg.garchSize * LEV})`);
  console.log(`  ST size:       $${best.cfg.stSize}${best.cfg.stSize > 0 ? `  (notional $${best.cfg.stSize * LEV})` : " (disabled)"}`);
  console.log(`  Max positions: ${best.cfg.maxPos}`);
  console.log(`  Z-scores:      1h long>${best.cfg.z1Long} short<-${best.cfg.z1Short}  |  4h long>${best.cfg.z4Long} short<-${best.cfg.z4Short}`);
  console.log(`  Trail mode:    ${best.cfg.trailMode}  activate=${best.cfg.trailAct}% leveraged  trail-back=${best.cfg.trailDist}%  re-entry=${best.cfg.reentry}`);
  console.log(`  Trades:        ${best.trades}  (${best.tradesPerDay.toFixed(2)}/day)`);
  console.log(`  Win rate:      ${best.wr.toFixed(1)}%`);
  console.log(`  Profit factor: ${best.pf.toFixed(2)}`);
  console.log(`  Total PnL:     $${best.total.toFixed(2)}`);
  console.log(`  $/day:         $${best.perDay.toFixed(3)}`);
  console.log(`  MaxDD:         $${best.maxDD.toFixed(2)}`);
  console.log(`  Sharpe:        ${best.sharpe.toFixed(2)}`);
  console.log(`  OOS $/day:     $${best.oosPerDay.toFixed(3)}`);
  console.log(`  OOS PF:        ${best.oosPf.toFixed(2)}`);
  console.log(`  Trail exits:   ${best.trailExits}`);
  console.log(`  Reentries:     ${best.reentries}`);
  console.log(`  Blocked:       ${best.blocked}`);
}

// Cross-engine analysis
function groupStats(group: SimResult[], name: string): void {
  if (group.length === 0) { console.log(`  ${name.padEnd(22)}: no passing configs`); return; }
  const sorted = [...group].sort((a, b) => b.perDay - a.perDay);
  const b = sorted[0];
  const avgDD = group.reduce((s, r) => s + r.maxDD, 0) / group.length;
  const avgPD = group.reduce((s, r) => s + r.perDay, 0) / group.length;
  console.log(`  ${name.padEnd(22)}: ${String(group.length).padStart(3)} configs  best $${b.perDay.toFixed(3)}/d  avg $${avgPD.toFixed(3)}/d  avg DD $${avgDD.toFixed(0)}  best="${b.label}"`);
}

console.log(`\n${SEP}`);
console.log("CONFIG ANALYSIS BY ENGINE COMBO");
console.log(SEP);
groupStats(allResults.filter(r => r.cfg.stSize === 0), "GARCH-only");
groupStats(allResults.filter(r => r.cfg.stSize === 3), "GARCH+ST$3");
groupStats(allResults.filter(r => r.cfg.stSize === 5), "GARCH+ST$5");

console.log(`\n${SEP}`);
console.log("CONFIG ANALYSIS BY Z-SCORE MODE");
console.log(SEP);
groupStats(allResults.filter(r => r.cfg.z1Long === 4.5), "Strict [4.5/3.0]");
groupStats(allResults.filter(r => r.cfg.z1Long === 3.5), "Moderate [3.5/2.5]");

console.log(`\n${SEP}`);
console.log("CONFIG ANALYSIS BY TRAIL MODE");
console.log(SEP);
groupStats(allResults.filter(r => r.cfg.trailMode === "none"),        "No trail");
groupStats(allResults.filter(r => r.cfg.trailMode === "all"),         "Trail all engines");
groupStats(allResults.filter(r => r.cfg.trailMode === "garch-only"),  "Trail GARCH-only");

console.log(`\n${SEP}`);
console.log("CONFIG ANALYSIS BY GARCH SIZE");
console.log(SEP);
for (const gs of GARCH_SIZES) {
  groupStats(allResults.filter(r => r.cfg.garchSize === gs), `GARCH $${gs}`);
}

console.log(`\nDone. ${allResults.length}/${configs.length} configs passed MaxDD<=$${MAX_DD_LIMIT}.`);
