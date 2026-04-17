/**
 * GARCH v2 optimization backtest
 * Tests SL%, TP%, max-hold, z-score combos, and per-pair contribution.
 * GARCH-only ($9 margin, max 7 positions, trail 40/3, BTC 4h EMA(12/21)).
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-garch-optimize.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const CD_1M  = "/tmp/bt-pair-cache-1m";
const H      = 3_600_000;
const H4     = 4 * H;
const D      = 86_400_000;
const MIN_1  = 60_000;
const FEE    = 0.000_35;
const SL_SLIP = 1.5;
const LEV    = 10;
const MARGIN = 9;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();
const FULL_DAYS  = (FULL_END - FULL_START) / D;
const OOS_DAYS   = (FULL_END - OOS_START) / D;

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX",
  "NEAR","SUI","FET",
];

// --------------- data loading ---------------
function loadJson(dir: string, pair: string): C[] {
  const fp = path.join(dir, `${pair}USDT.json`);
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

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
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

// --------------- load all data once ---------------
console.log("Loading data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...ALL_PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const raw1m = new Map<string, C[]>();
for (const p of ["BTC", ...ALL_PAIRS]) {
  const d = loadJson(CD_1M, p);
  if (d.length > 0) { raw1m.set(p, d); }
}

// Pre-aggregate timeframes
const h4DataAll = new Map<string, C[]>();
const h1DataAll = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4DataAll.set(p, aggregate(bars, H4, 40));
  h1DataAll.set(p, aggregate(bars, H, 10));
}

// BTC 4h EMA(12/21) filter
const btcH4 = h4DataAll.get("BTC")!;
const btcH4Closes = btcH4.map(c => c.c);
const btcH4Ema12 = calcEMA(btcH4Closes, 12);
const btcH4Ema21 = calcEMA(btcH4Closes, 21);

function btcBullish(t: number): boolean {
  let lo = 0, hi = btcH4.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcH4[mid].t < t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return false;
  return btcH4Ema12[idx] > btcH4Ema21[idx];
}

// BTC h1 trend (for GARCH h1 EMA filter baseline)
// (GARCH uses per-pair h1 EMA(9/21) not BTC h1, but we keep BTC h1 trend as secondary)
// Note: existing engine uses btcH1Trend for BTC trend confirmation at 1h level
const btcH1All = h1DataAll.get("BTC")!;
const btcH1Closes = btcH1All.map(c => c.c);
const btcH1Ema9  = calcEMA(btcH1Closes, 9);
const btcH1Ema21h = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1All.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long" | "short" | null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21h[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21h[prev]) return "short";
  return null;
}

// Per-pair indicator cache
interface PairInd {
  h4: C[];
  h4TsMap: Map<number, number>;
  h4Z: number[];
  h1: C[];
  h1TsMap: Map<number, number>;
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  bars1m: C[];
}

const pairIndAll = new Map<string, PairInd>();
for (const pair of ALL_PAIRS) {
  const h4 = h4DataAll.get(pair) ?? [];
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h4Z = computeZScores(h4, 3, 20);

  const h1 = h1DataAll.get(pair) ?? [];
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);

  const bars1m = raw1m.get(pair) ?? [];

  pairIndAll.set(pair, { h4, h4TsMap, h4Z, h1, h1TsMap, h1Z, h1Ema9, h1Ema21, bars1m });
}

console.log("Data loaded.\n");

// --------------- binary search helpers ---------------
function bsearch1m(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// --------------- GARCH signal check ---------------
function checkGarch(
  pair: string,
  t: number,
  z1Long: number,  // 1h z threshold for longs (positive)
  z1Short: number, // 1h z threshold for shorts (negative, absolute)
  z4Long: number,  // 4h z threshold for longs (positive)
  z4Short: number, // 4h z threshold for shorts (negative, absolute)
  slPct: number,
): { dir: "long" | "short"; entryPrice: number; sl: number } | null {
  const ind = pairIndAll.get(pair);
  if (!ind) return null;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;
  const prev = barIdx - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong  = z1 > z1Long;
  const goShort = z1 < -z1Short;
  if (!goLong && !goShort) return null;

  // 4h z check
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= z4Long) return null;
  if (goShort && z4 >= -z4Short) return null;

  // Per-pair EMA(9/21) on 1h
  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong  && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  // BTC h1 trend
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[barIdx].o;
  const rawSl = dir === "long" ? ep * (1 - slPct) : ep * (1 + slPct);
  const sl = dir === "long"
    ? Math.max(rawSl, ep * 0.965)   // cap at 3.5%
    : Math.min(rawSl, ep * 1.035);

  return { dir, entryPrice: ep, sl };
}

// --------------- position type ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  entryPrice: number;
  effectiveEP: number;
  sl: number;
  entryTime: number;
  peakPnlPct: number;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
}

// --------------- single run ---------------
function runSim(cfg: {
  pairs: string[];
  slPct: number;
  tpPct: number;       // 0 = disabled
  maxHoldH: number;
  z1Long: number;
  z1Short: number;
  z4Long: number;
  z4Short: number;
  trailAct: number;    // 40
  trailDist: number;   // 3
  maxPos: number;      // 7
}): ClosedTrade[] {
  const { pairs, slPct, tpPct, maxHoldH, z1Long, z1Short, z4Long, z4Short, trailAct, trailDist, maxPos } = cfg;
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const notional = MARGIN * LEV;

  function get1mBar(pair: string, t: number): C | null {
    const ind = pairIndAll.get(pair);
    if (!ind || ind.bars1m.length === 0) return null;
    const idx = bsearch1m(ind.bars1m, t);
    if (idx < 0) return null;
    return ind.bars1m[idx];
  }

  function hasOpenPos(pair: string): boolean {
    return openPositions.some(p => p.pair === pair);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, entryTime: pos.entryTime, exitTime, pnl, reason });
    openPositions.splice(idx, 1);
  }

  let lastPct = -1;
  for (let t = FULL_START; t < FULL_END; t += MIN_1) {
    const pct = Math.floor(((t - FULL_START) / (FULL_END - FULL_START)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    const isH1 = t % H === 0;

    // --- 1) check SL / TP / trail for all open positions ---
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get1mBar(pos.pair, t);
      if (!bar) continue;

      // SL
      if (pos.dir === "long"  && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true);  continue; }
      if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true);  continue; }

      // TP (skip if disabled)
      if (tpPct > 0) {
        const tp = pos.dir === "long" ? pos.entryPrice * (1 + tpPct) : pos.entryPrice * (1 - tpPct);
        if (pos.dir === "long"  && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
        if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }
      }

      // Peak tracking
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // Trail
      if (trailAct > 0 && pos.peakPnlPct >= trailAct) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - trailDist) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // --- 2) max-hold check at 1h boundaries ---
    if (isH1) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const ind = pairIndAll.get(pos.pair);
        if (!ind) continue;
        const h1Bucket = Math.floor(t / H) * H;
        const barIdx = ind.h1TsMap.get(h1Bucket);
        if (barIdx === undefined) continue;
        const bar = ind.h1[barIdx];
        if ((bar.t - pos.entryTime) / H >= maxHoldH) {
          closePos(pi, t, bar.c, "mh", false);
        }
      }
    }

    // --- 3) new entries at 1h boundaries ---
    if (isH1) {
      for (const pair of pairs) {
        if (openPositions.length >= maxPos) break;
        if (hasOpenPos(pair)) continue;
        const sig = checkGarch(pair, t, z1Long, z1Short, z4Long, z4Short, slPct);
        if (!sig) continue;
        const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
        openPositions.push({
          pair, dir: sig.dir,
          entryPrice: sig.entryPrice, effectiveEP: ep,
          sl: sig.sl, entryTime: t, peakPnlPct: 0,
        });
      }
    }
  }

  // Close any open at end
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairIndAll.get(pos.pair);
    if (!ind || ind.bars1m.length === 0) continue;
    const lastBar = ind.bars1m[ind.bars1m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return closedTrades;
}

// --------------- metrics ---------------
interface Metrics {
  trades: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
}

function metrics(trades: ClosedTrade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / D;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
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
  return {
    trades: trades.length,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total, perDay: total / days, maxDD, sharpe,
  };
}

// --------------- print helpers ---------------
function row(label: string, m: Metrics, oos: Metrics, extra = ""): void {
  const tag = extra ? ` ${extra}` : "";
  console.log([
    label.padEnd(28),
    String(m.trades).padStart(6),
    (m.wr.toFixed(1) + "%").padStart(7),
    ("$" + m.total.toFixed(0)).padStart(10),
    ("$" + m.perDay.toFixed(3)).padStart(10),
    m.pf.toFixed(2).padStart(6),
    m.sharpe.toFixed(2).padStart(7),
    ("$" + m.maxDD.toFixed(0)).padStart(8),
    ("$" + oos.perDay.toFixed(3)).padStart(10),
    oos.pf.toFixed(2).padStart(7),
  ].join(" ") + tag);
}

const HDR = [
  "Label".padEnd(28),
  "Trades".padStart(6),
  "WR%".padStart(7),
  "Total".padStart(10),
  "$/day".padStart(10),
  "PF".padStart(6),
  "Sharpe".padStart(7),
  "MaxDD".padStart(8),
  "OOS$/d".padStart(10),
  "OOS PF".padStart(7),
].join(" ");

function oosTrades(all: ClosedTrade[]): ClosedTrade[] {
  return all.filter(t => t.entryTime >= OOS_START);
}

// =============================================================================
// SWEEP 1: SL% sweep (TP=7%, hold=96h, z=4.5/3.0/4h=3.0)
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log("SWEEP 1: SL% (TP=7%, 96h, z=4.5/3.0, 40/3 trail, max7, all 23 pairs)");
console.log("=".repeat(110));
console.log(HDR);
console.log("-".repeat(110));

const SL_SWEEP = [0.02, 0.025, 0.03, 0.035, 0.04];
const sl1Results: { slPct: number; m: Metrics; oos: Metrics }[] = [];

for (const slPct of SL_SWEEP) {
  process.stdout.write(`SL ${(slPct * 100).toFixed(1)}%...`);
  const trades = runSim({
    pairs: ALL_PAIRS, slPct, tpPct: 0.07, maxHoldH: 96,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const m   = metrics(trades, FULL_START, FULL_END);
  const oos = metrics(oosTrades(trades), OOS_START, FULL_END);
  sl1Results.push({ slPct, m, oos });
  row(`SL ${(slPct * 100).toFixed(1)}%`, m, oos);
}

const bestSl = sl1Results.sort((a, b) => b.m.perDay - a.m.perDay)[0];
console.log(`\nBest SL: ${(bestSl.slPct * 100).toFixed(1)}% ($${bestSl.m.perDay.toFixed(3)}/day, DD $${bestSl.m.maxDD.toFixed(0)})`);

// =============================================================================
// SWEEP 2: TP% sweep (best SL, hold=96h, z=4.5/3.0)
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log(`SWEEP 2: TP% (SL=${(bestSl.slPct * 100).toFixed(1)}%, 96h, z=4.5/3.0, 40/3 trail, max7, all 23 pairs)`);
console.log("=".repeat(110));
console.log(HDR);
console.log("-".repeat(110));

const TP_SWEEP = [0.05, 0.07, 0.10, 0.15, 0];
const tp2Results: { tpPct: number; m: Metrics; oos: Metrics }[] = [];

for (const tpPct of TP_SWEEP) {
  const label = tpPct === 0 ? "TP disabled" : `TP ${(tpPct * 100).toFixed(0)}%`;
  process.stdout.write(`${label}...`);
  const trades = runSim({
    pairs: ALL_PAIRS, slPct: bestSl.slPct, tpPct, maxHoldH: 96,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const m   = metrics(trades, FULL_START, FULL_END);
  const oos = metrics(oosTrades(trades), OOS_START, FULL_END);
  tp2Results.push({ tpPct, m, oos });
  row(label, m, oos);
}

const bestTp = tp2Results.sort((a, b) => b.m.perDay - a.m.perDay)[0];
console.log(`\nBest TP: ${bestTp.tpPct === 0 ? "disabled" : (bestTp.tpPct * 100).toFixed(0) + "%"} ($${bestTp.m.perDay.toFixed(3)}/day, DD $${bestTp.m.maxDD.toFixed(0)})`);

// =============================================================================
// SWEEP 3: Max-hold sweep (best SL+TP, z=4.5/3.0)
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log(`SWEEP 3: Max-hold (SL=${(bestSl.slPct * 100).toFixed(1)}%, TP=${bestTp.tpPct === 0 ? "off" : (bestTp.tpPct * 100).toFixed(0) + "%"}, z=4.5/3.0, 40/3 trail, max7)`);
console.log("=".repeat(110));
console.log(HDR);
console.log("-".repeat(110));

const HOLD_SWEEP = [48, 72, 96, 120, 168];
const hold3Results: { holdH: number; m: Metrics; oos: Metrics }[] = [];

for (const holdH of HOLD_SWEEP) {
  process.stdout.write(`Hold ${holdH}h...`);
  const trades = runSim({
    pairs: ALL_PAIRS, slPct: bestSl.slPct, tpPct: bestTp.tpPct, maxHoldH: holdH,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const m   = metrics(trades, FULL_START, FULL_END);
  const oos = metrics(oosTrades(trades), OOS_START, FULL_END);
  hold3Results.push({ holdH, m, oos });
  row(`Hold ${holdH}h`, m, oos);
}

const bestHold = hold3Results.sort((a, b) => b.m.perDay - a.m.perDay)[0];
console.log(`\nBest hold: ${bestHold.holdH}h ($${bestHold.m.perDay.toFixed(3)}/day, DD $${bestHold.m.maxDD.toFixed(0)})`);

// =============================================================================
// SWEEP 4: Z-score combos (best SL+TP+hold)
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log(`SWEEP 4: Z-score combos (SL=${(bestSl.slPct * 100).toFixed(1)}%, TP=${bestTp.tpPct === 0 ? "off" : (bestTp.tpPct * 100).toFixed(0) + "%"}, ${bestHold.holdH}h, 40/3 trail, max7)`);
console.log("=".repeat(110));
console.log(HDR);
console.log("-".repeat(110));

// Format: [z1Long, z1Short, z4Long, z4Short]
// z1Short / z4Short = absolute value thresholds for short side
const Z_COMBOS: [number, number, number, number, string][] = [
  [4.5, 3.0, 3.0, 3.0, "4.5/3.0 (baseline)"],
  [4.0, 2.8, 3.0, 2.8, "4.0/2.8"],
  [4.0, 3.0, 3.0, 3.0, "4.0/3.0"],
  [3.5, 3.0, 3.0, 3.0, "3.5/3.0"],
];

interface ZResult { label: string; m: Metrics; oos: Metrics; z1Long: number; z1Short: number; z4Long: number; z4Short: number; }
const z4Results: ZResult[] = [];

for (const [z1Long, z1Short, z4Long, z4Short, label] of Z_COMBOS) {
  process.stdout.write(`Z ${label}...`);
  const trades = runSim({
    pairs: ALL_PAIRS, slPct: bestSl.slPct, tpPct: bestTp.tpPct, maxHoldH: bestHold.holdH,
    z1Long, z1Short, z4Long, z4Short,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const m   = metrics(trades, FULL_START, FULL_END);
  const oos = metrics(oosTrades(trades), OOS_START, FULL_END);
  z4Results.push({ label, m, oos, z1Long, z1Short, z4Long, z4Short });
  row(`Z ${label}`, m, oos);
}

const bestZ = z4Results
  .filter(r => r.m.maxDD <= 60)
  .sort((a, b) => b.m.perDay - a.m.perDay)[0]
  ?? z4Results.sort((a, b) => b.m.perDay - a.m.perDay)[0];
console.log(`\nBest Z (MaxDD<$60): ${bestZ.label} ($${bestZ.m.perDay.toFixed(3)}/day, ${bestZ.m.trades} trades, DD $${bestZ.m.maxDD.toFixed(0)})`);

// =============================================================================
// SWEEP 5: Per-pair contribution (baseline config: SL=3%, TP=7%, 96h, z=4.5/3.0)
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log("SWEEP 5: Per-pair contribution (SL=3%, TP=7%, 96h, z=4.5/3.0, 40/3 trail, max7)");
console.log("=".repeat(110));
console.log([
  "Pair".padEnd(8),
  "Trades".padStart(6),
  "WR%".padStart(7),
  "Total".padStart(10),
  "$/day".padStart(10),
  "PF".padStart(6),
  "MaxDD".padStart(8),
  "OOS$/d".padStart(10),
].join(" "));
console.log("-".repeat(70));

const pairContrib: { pair: string; m: Metrics; oos: Metrics }[] = [];

for (const pair of ALL_PAIRS) {
  process.stdout.write(`${pair}...`);
  const trades = runSim({
    pairs: [pair], slPct: 0.03, tpPct: 0.07, maxHoldH: 96,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const m   = metrics(trades, FULL_START, FULL_END);
  const oos = metrics(oosTrades(trades), OOS_START, FULL_END);
  pairContrib.push({ pair, m, oos });
}

// Sort by PF desc
pairContrib.sort((a, b) => b.m.pf - a.m.pf);

for (const { pair, m, oos } of pairContrib) {
  console.log([
    pair.padEnd(8),
    String(m.trades).padStart(6),
    (m.wr.toFixed(1) + "%").padStart(7),
    ("$" + m.total.toFixed(1)).padStart(10),
    ("$" + m.perDay.toFixed(3)).padStart(10),
    m.pf.toFixed(2).padStart(6),
    ("$" + m.maxDD.toFixed(0)).padStart(8),
    ("$" + oos.perDay.toFixed(3)).padStart(10),
  ].join(" "));
}

// Identify best subset (drop pairs with negative total or PF < 1)
const goodPairs = pairContrib.filter(p => p.m.total > 0 && p.m.pf >= 1.0).map(p => p.pair);
const badPairs  = pairContrib.filter(p => p.m.total <= 0 || p.m.pf < 1.0).map(p => p.pair);
console.log(`\nPairs with PF>=1 and positive total (${goodPairs.length}): ${goodPairs.join(", ")}`);
console.log(`Pairs dragging performance (${badPairs.length}): ${badPairs.join(", ")}`);

// =============================================================================
// SWEEP 6: Best subset vs all pairs (baseline + best-params)
// =============================================================================
if (goodPairs.length > 0 && goodPairs.length < ALL_PAIRS.length) {
  console.log("\n" + "=".repeat(110));
  console.log("SWEEP 6: Best-subset vs all-pairs comparison");
  console.log("=".repeat(110));
  console.log(HDR);
  console.log("-".repeat(110));

  // Baseline: all 23 pairs, SL=3%, TP=7%, 96h
  process.stdout.write("All pairs (SL=3%, TP=7%, 96h)...");
  const allBaseline = runSim({
    pairs: ALL_PAIRS, slPct: 0.03, tpPct: 0.07, maxHoldH: 96,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const mAll   = metrics(allBaseline, FULL_START, FULL_END);
  const oosAll = metrics(oosTrades(allBaseline), OOS_START, FULL_END);
  row(`All ${ALL_PAIRS.length} pairs (baseline)`, mAll, oosAll);

  // Good pairs subset, baseline params
  process.stdout.write(`Good ${goodPairs.length} pairs (baseline)...`);
  const subBaseline = runSim({
    pairs: goodPairs, slPct: 0.03, tpPct: 0.07, maxHoldH: 96,
    z1Long: 4.5, z1Short: 3.0, z4Long: 3.0, z4Short: 3.0,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const mSub   = metrics(subBaseline, FULL_START, FULL_END);
  const oosSub = metrics(oosTrades(subBaseline), OOS_START, FULL_END);
  row(`Good ${goodPairs.length} pairs (baseline)`, mSub, oosSub);

  // Best optimized params + good subset
  process.stdout.write(`Good ${goodPairs.length} pairs (best params)...`);
  const subBest = runSim({
    pairs: goodPairs, slPct: bestSl.slPct, tpPct: bestTp.tpPct, maxHoldH: bestHold.holdH,
    z1Long: bestZ.z1Long, z1Short: bestZ.z1Short, z4Long: bestZ.z4Long, z4Short: bestZ.z4Short,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const mSubBest   = metrics(subBest, FULL_START, FULL_END);
  const oosSubBest = metrics(oosTrades(subBest), OOS_START, FULL_END);
  row(`Good ${goodPairs.length} pairs (best params)`, mSubBest, oosSubBest);

  // Best params + all pairs
  process.stdout.write("All pairs (best params)...");
  const allBest = runSim({
    pairs: ALL_PAIRS, slPct: bestSl.slPct, tpPct: bestTp.tpPct, maxHoldH: bestHold.holdH,
    z1Long: bestZ.z1Long, z1Short: bestZ.z1Short, z4Long: bestZ.z4Long, z4Short: bestZ.z4Short,
    trailAct: 40, trailDist: 3, maxPos: 7,
  });
  process.stdout.write("\r");
  const mAllBest   = metrics(allBest, FULL_START, FULL_END);
  const oosAllBest = metrics(oosTrades(allBest), OOS_START, FULL_END);
  row("All pairs (best params)", mAllBest, oosAllBest);
}

// =============================================================================
// FINAL SUMMARY
// =============================================================================
console.log("\n" + "=".repeat(110));
console.log("FINAL SUMMARY");
console.log("=".repeat(110));
console.log(`Baseline (SL=3%, TP=7%, hold=96h, z=4.5/3.0, 40/3 trail, max7, all 23 pairs)`);
console.log(`Best SL:   ${(bestSl.slPct * 100).toFixed(1)}%  ->  $${bestSl.m.perDay.toFixed(3)}/day  DD $${bestSl.m.maxDD.toFixed(0)}`);
console.log(`Best TP:   ${bestTp.tpPct === 0 ? "disabled" : (bestTp.tpPct * 100).toFixed(0) + "%"}  ->  $${bestTp.m.perDay.toFixed(3)}/day  DD $${bestTp.m.maxDD.toFixed(0)}`);
console.log(`Best hold: ${bestHold.holdH}h  ->  $${bestHold.m.perDay.toFixed(3)}/day  DD $${bestHold.m.maxDD.toFixed(0)}`);
console.log(`Best Z (DD<$60): ${bestZ.label}  ->  $${bestZ.m.perDay.toFixed(3)}/day  ${bestZ.m.trades} trades  DD $${bestZ.m.maxDD.toFixed(0)}`);
console.log(`\nTop 5 pairs by PF:`);
pairContrib.slice(0, 5).forEach((p, i) =>
  console.log(`  ${i + 1}. ${p.pair}: PF ${p.m.pf.toFixed(2)}, $${p.m.perDay.toFixed(3)}/day, ${p.m.trades} trades`),
);
console.log(`\nBottom 5 pairs by PF:`);
[...pairContrib].reverse().slice(0, 5).forEach((p, i) =>
  console.log(`  ${i + 1}. ${p.pair}: PF ${p.m.pf.toFixed(2)}, $${p.m.perDay.toFixed(3)}/day, ${p.m.trades} trades`),
);
console.log("\nDone.");
