/**
 * Stepped Trailing Stop Deep Sweep - GARCH v2 only
 * Tests multi-stage trail configs where distance tightens as profit grows.
 * GARCH $9, z=4.5/3.0, SL 3%, TP 7%, 72h hold, max 7, BTC 4h EMA(12/21).
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-stepped-trail-sweep.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const MIN_1 = 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END   = new Date("2026-03-26").getTime();
const OOS_START  = new Date("2025-09-01").getTime();

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

// GARCH params (from spec)
const GARCH_SIZE = 9;
const GARCH_SL_PCT = 0.03;
const GARCH_TP_PCT = 0.07;
const GARCH_MAX_HOLD_H = 72;  // 72h as specified
const MAX_POS = 7;

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
  for (const [, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: grp[0].t,
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

// --------------- load data ---------------
console.log("Loading 5m data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = loadJson(CD_5M, p);
  if (d.length > 0) raw5m.set(p, d);
}

const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}

// BTC 4h EMA(12/21) for longs filter
const btcH4 = h4Data.get("BTC")!;
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

// BTC h1 EMA(9/21) for GARCH filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
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

// --------------- per-pair indicators ---------------
interface PairInd {
  h4: C[];
  h4ATR: number[];
  h4TsMap: Map<number, number>;
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4Z: number[];
  bars5m: C[];
}

const pairInd = new Map<string, PairInd>();
for (const pair of PAIRS) {
  const h4 = h4Data.get(pair) ?? [];
  const h4ATR = calcATR(h4, 14);
  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h4Z = computeZScores(h4, 3, 20);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const bars5m = raw5m.get(pair) ?? [];

  pairInd.set(pair, { h4, h4ATR, h4TsMap, h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h4Z, bars5m });
}

console.log("Data loaded.");

// --------------- GARCH signal check ---------------
interface SignalResult {
  dir: "long" | "short";
  entryPrice: number;
  sl: number;
}

function checkGarchV2(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;

  const i = barIdx;
  const prev = i - 1;
  if (prev < 23) return null;

  const z1 = ind.h1Z[prev];
  if (isNaN(z1) || z1 === 0) return null;
  const goLong = z1 > 4.5;
  const goShort = z1 < -3.0;
  if (!goLong && !goShort) return null;

  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = ind.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = ind.h4Z[idx4h];
  if (goLong && z4 <= 3.0) return null;
  if (goShort && z4 >= -3.0) return null;

  if (ind.h1Ema9[prev] === 0 || ind.h1Ema21[prev] === 0) return null;
  if (goLong && ind.h1Ema9[prev] <= ind.h1Ema21[prev]) return null;
  if (goShort && ind.h1Ema9[prev] >= ind.h1Ema21[prev]) return null;

  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - GARCH_SL_PCT) : ep * (1 + GARCH_SL_PCT);
  // Cap at 3.5%
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl };
}

// --------------- stepped trail config ---------------
interface TrailStage {
  activation: number;   // leveraged PnL% threshold
  distance: number;     // trail distance% from peak
}

interface TrailConfig {
  label: string;
  stages: TrailStage[];  // sorted ascending by activation
}

// Helper: get current trail distance given peak and stages
function getTrailDistance(peakPct: number, stages: TrailStage[]): number {
  let dist = 0;
  for (const s of stages) {
    if (peakPct >= s.activation) dist = s.distance;
  }
  return dist;
}

function isTrailActive(peakPct: number, stages: TrailStage[]): boolean {
  return stages.length > 0 && peakPct >= stages[0].activation;
}

// --------------- position ---------------
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

// 5m bar binary search
function bsearch5m(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t === t) return mid;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// --------------- simulation ---------------
function runSim(trailStages: TrailStage[]): { trades: ClosedTrade[] } {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const NOT = GARCH_SIZE * LEV;

  function is1hBoundary(t: number): boolean { return t % H === 0; }

  function get5mBar(pair: string, t: number): C | null {
    const ind = pairInd.get(pair);
    if (!ind || ind.bars5m.length === 0) return null;
    // find closest bar at or just before t
    const bars = ind.bars5m;
    let lo = 0, hi = bars.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t <= t) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found >= 0 ? bars[found] : null;
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, NOT);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, entryTime: pos.entryTime, exitTime, pnl, reason });
    openPositions.splice(idx, 1);
  }

  function hasOpenPos(pair: string): boolean {
    return openPositions.some(p => p.pair === pair);
  }

  let lastPct = -1;

  for (let t = FULL_START; t < FULL_END; t += MIN_1) {
    const pct = Math.floor(((t - FULL_START) / (FULL_END - FULL_START)) * 20) * 5;
    if (pct > lastPct) { process.stdout.write(`\r  ${pct}%`); lastPct = pct; }

    // 1) Check SL, TP, trail for all open positions
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bar = get5mBar(pos.pair, t);
      if (!bar) continue;

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP 7%
      const tp = pos.dir === "long" ? pos.entryPrice * (1 + GARCH_TP_PCT) : pos.entryPrice * (1 - GARCH_TP_PCT);
      if (pos.dir === "long" && bar.h >= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }
      if (pos.dir === "short" && bar.l <= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }

      // Max hold 72h
      if ((t - pos.entryTime) >= GARCH_MAX_HOLD_H * H) {
        closePos(pi, t, bar.c, "mh", false);
        continue;
      }

      // Peak tracking (using bar high/low for best case in the bar)
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // Stepped trail check
      if (trailStages.length > 0 && isTrailActive(pos.peakPnlPct, trailStages)) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        const dist = getTrailDistance(pos.peakPnlPct, trailStages);
        if (dist > 0 && currPct <= pos.peakPnlPct - dist) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // 2) New GARCH entries at 1h boundaries
    if (is1hBoundary(t)) {
      for (const pair of PAIRS) {
        if (hasOpenPos(pair)) continue;
        if (openPositions.length >= MAX_POS) break;
        const sig = checkGarchV2(pair, t);
        if (!sig) continue;
        const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
        openPositions.push({
          pair, dir: sig.dir, entryPrice: sig.entryPrice, effectiveEP: ep,
          sl: sig.sl, entryTime: t, peakPnlPct: 0,
        });
      }
    }
  }

  // Close remaining at end
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const ind = pairInd.get(pos.pair);
    if (!ind || ind.bars5m.length === 0) continue;
    const lastBar = ind.bars5m[ind.bars5m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return { trades: closedTrades };
}

// --------------- metrics ---------------
interface Metrics {
  trades: number; wr: number; pf: number; total: number; perDay: number;
  maxDD: number; sharpe: number; trailExits: number;
  oosTotal: number; oosPerDay: number; oosPf: number; oosTrades: number;
}

function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / D;
  const wins = trades.filter(t => t.pnl > 0);
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
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const trailExits = trades.filter(t => t.reason === "trail").length;

  const oosTrades = trades.filter(t => t.entryTime >= OOS_START);
  const oosWins = oosTrades.filter(t => t.pnl > 0);
  const oosLosses = oosTrades.filter(t => t.pnl <= 0);
  const oosGp = oosWins.reduce((s, t) => s + t.pnl, 0);
  const oosGl = Math.abs(oosLosses.reduce((s, t) => s + t.pnl, 0));
  const oosTotal = oosTrades.reduce((s, t) => s + t.pnl, 0);
  const oosDays = (FULL_END - OOS_START) / D;

  return {
    trades: trades.length, wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99, total, perDay: total / days, maxDD, sharpe, trailExits,
    oosTotal, oosPerDay: oosTotal / oosDays,
    oosPf: oosGl > 0 ? oosGp / oosGl : 99, oosTrades: oosTrades.length,
  };
}

// --------------- define all configs ---------------
interface Config {
  label: string;
  stages: TrailStage[];
  note: string;
}

const CONFIGS: Config[] = [
  // Baselines
  { label: "NO_TRAIL",      stages: [],                                                         note: "Baseline: no trail" },
  { label: "FLAT_30/3",     stages: [{ activation: 30, distance: 3 }],                         note: "Current live: flat 30/3" },
  { label: "FLAT_40/3",     stages: [{ activation: 40, distance: 3 }],                         note: "Flat 40/3 (live reference)" },

  // Previous best
  { label: "25/5>35/3>45/2",stages: [{ activation: 25, distance: 5 }, { activation: 35, distance: 3 }, { activation: 45, distance: 2 }], note: "Previous best (lowest DD)" },

  // SET 1: vary activation levels, distances 5/3/2
  { label: "15/5>25/3>35/2",stages: [{ activation: 15, distance: 5 }, { activation: 25, distance: 3 }, { activation: 35, distance: 2 }], note: "S1: early tight" },
  { label: "20/5>30/3>40/2",stages: [{ activation: 20, distance: 5 }, { activation: 30, distance: 3 }, { activation: 40, distance: 2 }], note: "S1: mid" },
  { label: "20/5>35/3>50/2",stages: [{ activation: 20, distance: 5 }, { activation: 35, distance: 3 }, { activation: 50, distance: 2 }], note: "S1: wide span" },
  { label: "15/4>25/3>40/2",stages: [{ activation: 15, distance: 4 }, { activation: 25, distance: 3 }, { activation: 40, distance: 2 }], note: "S1: tighter d1" },

  // SET 2: vary distances, activations 20/30/40
  { label: "20/7>30/5>40/3",stages: [{ activation: 20, distance: 7 }, { activation: 30, distance: 5 }, { activation: 40, distance: 3 }], note: "S2: wide distances" },
  { label: "20/5>30/3>40/2",stages: [{ activation: 20, distance: 5 }, { activation: 30, distance: 3 }, { activation: 40, distance: 2 }], note: "S2: mid distances" },
  { label: "20/4>30/2>40/1",stages: [{ activation: 20, distance: 4 }, { activation: 30, distance: 2 }, { activation: 40, distance: 1 }], note: "S2: tight distances" },
  { label: "20/6>30/4>40/2",stages: [{ activation: 20, distance: 6 }, { activation: 30, distance: 4 }, { activation: 40, distance: 2 }], note: "S2: step-down d" },

  // SET 3: 2-stage only
  { label: "20/5>35/2",     stages: [{ activation: 20, distance: 5 }, { activation: 35, distance: 2 }],                                 note: "S3: 2-stage simple" },
  { label: "25/5>40/2",     stages: [{ activation: 25, distance: 5 }, { activation: 40, distance: 2 }],                                 note: "S3: 2-stage late" },
  { label: "20/4>30/2",     stages: [{ activation: 20, distance: 4 }, { activation: 30, distance: 2 }],                                 note: "S3: 2-stage tight" },
  { label: "15/5>30/2",     stages: [{ activation: 15, distance: 5 }, { activation: 30, distance: 2 }],                                 note: "S3: 2-stage early" },

  // SET 4: non-round stages
  { label: "17/5>27/3>37/2",stages: [{ activation: 17, distance: 5 }, { activation: 27, distance: 3 }, { activation: 37, distance: 2 }], note: "S4: non-round A" },
  { label: "22/5>33/3>43/2",stages: [{ activation: 22, distance: 5 }, { activation: 33, distance: 3 }, { activation: 43, distance: 2 }], note: "S4: non-round B" },
  { label: "18/4>28/3>38/2",stages: [{ activation: 18, distance: 4 }, { activation: 28, distance: 3 }, { activation: 38, distance: 2 }], note: "S4: non-round C" },
];

// --------------- run all configs ---------------
interface Result {
  label: string;
  note: string;
  stages: TrailStage[];
  m: Metrics;
}

console.log("\nRunning stepped trail configs...");
console.log(`GARCH only: $${GARCH_SIZE}, z=4.5/3.0, SL ${GARCH_SL_PCT*100}%, TP ${GARCH_TP_PCT*100}%, ${GARCH_MAX_HOLD_H}h hold, max ${MAX_POS} pos`);
console.log(`Pairs: ${PAIRS.length} | Full: 2023-01 to 2026-03 | OOS: 2025-09+\n`);

const results: Result[] = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`${cfg.label.padEnd(20)} `);
  const { trades } = runSim(cfg.stages);
  process.stdout.write("\r" + " ".repeat(30) + "\r");
  const m = computeMetrics(trades, FULL_START, FULL_END);
  results.push({ label: cfg.label, note: cfg.note, stages: cfg.stages, m });
  console.log(
    `${cfg.label.padEnd(20)} $${m.perDay.toFixed(2).padStart(6)}/day  DD $${m.maxDD.toFixed(0).padStart(5)}  PF ${m.pf.toFixed(2).padStart(5)}  Sharpe ${m.sharpe.toFixed(2).padStart(5)}  OOS $${m.oosPerDay.toFixed(2).padStart(6)}/day  trails:${m.trailExits.toString().padStart(4)}  (${cfg.note})`
  );
}

// --------------- summary table ---------------
const SEP = "=".repeat(160);
console.log("\n" + SEP);
console.log("STEPPED TRAILING STOP SWEEP - GARCH v2 ONLY");
console.log(`$${GARCH_SIZE} size | 10x lev | z=4.5/3.0 | SL ${GARCH_SL_PCT*100}% | TP ${GARCH_TP_PCT*100}% | ${GARCH_MAX_HOLD_H}h max hold | max ${MAX_POS} positions | BTC 4h EMA(12/21)`);
console.log("Full: 2023-01-01 to 2026-03-26 | OOS: 2025-09-01+");
console.log(SEP);

const HDR = [
  "Config".padEnd(22),
  "$/day".padStart(8),
  "Total".padStart(10),
  "Trades".padStart(7),
  "WR%".padStart(7),
  "PF".padStart(6),
  "Sharpe".padStart(8),
  "MaxDD".padStart(8),
  "Trails".padStart(7),
  "OOS$/d".padStart(8),
  "OOSPF".padStart(7),
  "Note".padStart(30),
].join(" ");

console.log("\n" + HDR);
console.log("-".repeat(160));

// Sort by $/day
const byPerDay = [...results].sort((a, b) => b.m.perDay - a.m.perDay);
for (const r of byPerDay) {
  console.log([
    r.label.padEnd(22),
    ("$" + r.m.perDay.toFixed(2)).padStart(8),
    ("$" + r.m.total.toFixed(0)).padStart(10),
    r.m.trades.toString().padStart(7),
    (r.m.wr.toFixed(1) + "%").padStart(7),
    r.m.pf.toFixed(2).padStart(6),
    r.m.sharpe.toFixed(2).padStart(8),
    ("$" + r.m.maxDD.toFixed(0)).padStart(8),
    r.m.trailExits.toString().padStart(7),
    ("$" + r.m.oosPerDay.toFixed(2)).padStart(8),
    r.m.oosPf.toFixed(2).padStart(7),
    r.note.padStart(30),
  ].join(" "));
}

// Top 5 $/day
console.log("\n" + SEP);
console.log("TOP 5 BY $/DAY:");
for (let i = 0; i < Math.min(5, byPerDay.length); i++) {
  const r = byPerDay[i];
  console.log(`  ${i + 1}. ${r.label.padEnd(22)} $${r.m.perDay.toFixed(2)}/day  DD $${r.m.maxDD.toFixed(0)}  PF ${r.m.pf.toFixed(2)}  Sharpe ${r.m.sharpe.toFixed(2)}  OOS $${r.m.oosPerDay.toFixed(2)}/day`);
}

// Top 5 lowest MaxDD
const byDD = [...results].sort((a, b) => a.m.maxDD - b.m.maxDD);
console.log("\nTOP 5 LOWEST MAX DD:");
for (let i = 0; i < Math.min(5, byDD.length); i++) {
  const r = byDD[i];
  console.log(`  ${i + 1}. ${r.label.padEnd(22)} DD $${r.m.maxDD.toFixed(0)}  $${r.m.perDay.toFixed(2)}/day  PF ${r.m.pf.toFixed(2)}  Sharpe ${r.m.sharpe.toFixed(2)}`);
}

// Beat FLAT_30/3 on BOTH $/day AND MaxDD
const flat30 = results.find(r => r.label === "FLAT_30/3")!;
console.log("\n" + SEP);
console.log(`CONFIGS THAT BEAT FLAT_30/3 ON BOTH $/DAY ($${flat30.m.perDay.toFixed(2)}) AND MaxDD ($${flat30.m.maxDD.toFixed(0)}):`);
const beats = byPerDay.filter(r =>
  r.label !== "FLAT_30/3" &&
  r.m.perDay > flat30.m.perDay &&
  r.m.maxDD < flat30.m.maxDD
);
if (beats.length === 0) {
  console.log("  None.");
} else {
  for (const r of beats) {
    const pdDiff = ((r.m.perDay - flat30.m.perDay) / flat30.m.perDay * 100).toFixed(1);
    const ddDiff = ((flat30.m.maxDD - r.m.maxDD) / flat30.m.maxDD * 100).toFixed(1);
    console.log(`  ${r.label.padEnd(22)} $${r.m.perDay.toFixed(2)}/day (+${pdDiff}%)  DD $${r.m.maxDD.toFixed(0)} (-${ddDiff}%)  OOS $${r.m.oosPerDay.toFixed(2)}/day  ${r.note}`);
  }
}

// Risk-adjusted ranking ($/day * Sharpe / MaxDD)
const byRiskAdj = [...results].sort((a, b) =>
  (b.m.perDay * b.m.sharpe / Math.max(b.m.maxDD, 1)) -
  (a.m.perDay * a.m.sharpe / Math.max(a.m.maxDD, 1))
);
console.log("\nTOP 5 RISK-ADJUSTED ($/day * Sharpe / MaxDD):");
for (let i = 0; i < Math.min(5, byRiskAdj.length); i++) {
  const r = byRiskAdj[i];
  const score = r.m.perDay * r.m.sharpe / Math.max(r.m.maxDD, 1);
  console.log(`  ${i + 1}. ${r.label.padEnd(22)} score ${score.toFixed(4)}  $${r.m.perDay.toFixed(2)}/day  DD $${r.m.maxDD.toFixed(0)}  Sharpe ${r.m.sharpe.toFixed(2)}  OOS $${r.m.oosPerDay.toFixed(2)}/day`);
}

console.log("\n" + SEP);
console.log("Done.");
